import { afterEach, describe, expect, test } from 'bun:test';
import {
  APP_APPLICATION_NAME,
  APP_POOL_MAX,
  createAppDatabase,
} from '../../packages/runtime/src/persistence/app-database.ts';
import type { PersistenceError } from '../../packages/runtime/src/persistence/errors.ts';
import { jsonText, parseJsonText } from '../../packages/runtime/src/persistence/json.ts';
import { createCheckpointStore } from '../../packages/runtime/src/persistence/saver/checkpoint-saver.ts';
import { SAVER_APPLICATION_NAME, SAVER_POOL_MAX } from '../../packages/runtime/src/persistence/saver/constants.ts';
import { putSyntheticCheckpoint, readCheckpoint } from '../../packages/runtime/test-support/checkpoints.ts';
import { createScratchDatabase, eventually, type ScratchDatabase } from '../support/scratch-database.ts';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function scratch(): Promise<ScratchDatabase> {
  const db = await createScratchDatabase();
  cleanups.push(() => db.drop());
  return db;
}

async function connectionsNamed(db: ScratchDatabase, applicationName: string): Promise<number> {
  const [row] = await db.admin`
    select count(*)::int as n from pg_stat_activity where datname = ${db.name} and application_name = ${applicationName}`;
  return row.n;
}

/** Samples a connection count while `work` runs and returns the maximum observed. */
async function peakConnections(db: ScratchDatabase, applicationName: string, work: Promise<unknown>): Promise<number> {
  let peak = 0;
  let done = false;
  const settled = work.finally(() => {
    done = true;
  });
  while (!done) {
    peak = Math.max(peak, await connectionsNamed(db, applicationName));
    await Bun.sleep(20);
  }
  await settled;
  return peak;
}

describe('application database adapter', () => {
  test('round-trips JSON false, null and empty values distinctly from SQL NULL', async () => {
    const db = await scratch();
    const app = createAppDatabase({ url: db.url, onFault: () => {} });
    cleanups.push(() => app.close());
    const values = [false, null, 0, '', { answer: false, nested: null }, [false, null]];
    const rows = await app.transaction(async (tx) => {
      await tx`create temporary table sample (id int primary key, body jsonb) on commit drop`;
      for (const [id, value] of values.entries())
        await tx`insert into sample values (${id}, ${jsonText(value)}::text::jsonb)`;
      await tx`insert into sample values (${values.length}, null)`;
      return tx`select id, body::text as body from sample order by id`;
    });
    expect(rows.slice(0, values.length).map((row: { body: string }) => parseJsonText(row.body))).toEqual(values);
    expect(rows[values.length].body).toBeNull();
    expect(() => jsonText({ missing: undefined })).toThrow();
    expect(() => jsonText(Number.NaN)).toThrow();
  });

  test(`never opens more than ${APP_POOL_MAX} application connections`, async () => {
    const db = await scratch();
    const app = createAppDatabase({ url: db.url, onFault: () => {} });
    cleanups.push(() => app.close());
    const work = Promise.all(Array.from({ length: 12 }, () => app.readOnly((tx) => tx`select pg_sleep(0.3)`)));
    expect(await peakConnections(db, APP_APPLICATION_NAME, work)).toBe(APP_POOL_MAX);
  });

  test('reports an unexpected connection close exactly once and not during shutdown', async () => {
    const db = await scratch();
    const faults: PersistenceError[] = [];
    const app = createAppDatabase({ url: db.url, onFault: (error) => faults.push(error) });
    await Promise.all([app.readOnly((tx) => tx`select 1`), app.readOnly((tx) => tx`select 1`)]);
    expect(await db.terminate({ applicationName: APP_APPLICATION_NAME })).toBeGreaterThan(0);
    await eventually(() => faults.length > 0, 5_000, 'close fault');
    expect(faults.map((fault) => fault.code)).toEqual(['database_connection_closed']);
    expect(faults[0]?.message).not.toContain(db.name);
    await app.close();
    expect(faults).toHaveLength(1);
  });
});

describe('checkpoint saver adapter', () => {
  test('keeps saver tables in the checkpoints schema and respects its pool budget', async () => {
    const db = await scratch();
    const store = createCheckpointStore({ url: db.url, onFault: () => {} });
    cleanups.push(() => store.close());
    await store.setup();

    const tables = await db.admin`
      select table_schema || '.' || table_name as name from information_schema.tables
      where table_schema not in ('pg_catalog', 'information_schema') order by 1`;
    expect(tables.map((row: { name: string }) => row.name)).toEqual([
      'checkpoints.checkpoint_blobs',
      'checkpoints.checkpoint_migrations',
      'checkpoints.checkpoint_writes',
      'checkpoints.checkpoints',
    ]);

    let peakWaiting = 0;
    const sampler = setInterval(() => {
      peakWaiting = Math.max(peakWaiting, store.poolStats().waiting);
    }, 1);
    const writes = Promise.all(
      Array.from({ length: 12 }, (_, index) => putSyntheticCheckpoint(store, `thread-${index}`)),
    );
    const peak = await peakConnections(db, SAVER_APPLICATION_NAME, writes).finally(() => clearInterval(sampler));
    expect(peak).toBeLessThanOrEqual(SAVER_POOL_MAX);
    expect(store.poolStats().total).toBeLessThanOrEqual(SAVER_POOL_MAX);
    expect(peakWaiting).toBeGreaterThan(0);
    expect(await readCheckpoint(store, 'thread-11')).toBeDefined();
  });

  test('handles an idle client failure and continues with a new connection', async () => {
    const db = await scratch();
    const faults: PersistenceError[] = [];
    const store = createCheckpointStore({ url: db.url, onFault: (error) => faults.push(error) });
    cleanups.push(() => store.close());
    await store.setup();
    await putSyntheticCheckpoint(store, 'before');

    expect(await db.terminate({ applicationName: SAVER_APPLICATION_NAME })).toBeGreaterThan(0);
    await eventually(() => faults.length > 0, 5_000, 'idle client fault');
    expect(faults.map((fault) => fault.code)).toEqual(['checkpoint_pool_error']);

    await putSyntheticCheckpoint(store, 'after');
    expect(await readCheckpoint(store, 'after')).toBeDefined();
  });

  test('handles a checked-out client failure: the write rejects and the process keeps running', async () => {
    const db = await scratch();
    const faults: PersistenceError[] = [];
    const store = createCheckpointStore({ url: db.url, onFault: (error) => faults.push(error) });
    cleanups.push(() => store.close());
    await store.setup();

    let releaseLock = () => {};
    const lockHeld = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    let locked = () => {};
    const lockTaken = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const holder = db.admin.begin(async (tx) => {
      await tx`lock table checkpoints.checkpoints in access exclusive mode`;
      locked();
      await lockHeld;
    });
    await lockTaken;

    const write = putSyntheticCheckpoint(store, 'blocked');
    const outcome = write.then(
      () => 'resolved',
      () => 'rejected',
    );
    let blockedPid = 0;
    await eventually(async () => {
      const [row] = await db.admin`
        select pid from pg_stat_activity
        where datname = ${db.name} and application_name = ${SAVER_APPLICATION_NAME} and wait_event_type = 'Lock'`;
      blockedPid = row?.pid ?? 0;
      return blockedPid > 0;
    });
    expect(await db.terminate({ pid: blockedPid })).toBe(1);
    expect(await outcome).toBe('rejected');
    await eventually(() => faults.length > 0, 5_000, 'checked-out client fault');
    expect(faults.map((fault) => fault.code)).toEqual(['checkpoint_pool_error']);

    releaseLock();
    await holder;
    await putSyntheticCheckpoint(store, 'recovered');
    expect(await readCheckpoint(store, 'recovered')).toBeDefined();
  });
});
