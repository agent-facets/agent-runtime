import { afterEach, describe, expect, test } from 'bun:test';
import { SQL } from 'bun';
import { PersistenceError } from '../../packages/runtime/src/persistence/errors.ts';
import {
  LOCK_NAMESPACE,
  OWNERSHIP_LOCK,
  Ownership,
  withOwnerFence,
} from '../../packages/runtime/src/persistence/ownership.ts';
import { openPersistence, type Persistence } from '../../packages/runtime/src/persistence/persistence.ts';
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

async function open(db: ScratchDatabase, faults: PersistenceError[] = [], verifyIntervalMs = 5_000) {
  const persistence = await openPersistence({
    url: db.url,
    onFault: (error) => faults.push(error),
    ownership: { verifyIntervalMs },
  });
  cleanups.push(() => persistence.close());
  return persistence;
}

async function lockHolders(db: ScratchDatabase): Promise<number[]> {
  const rows = await db.admin`
    select pid from pg_locks where locktype = 'advisory' and granted
      and classid = ${LOCK_NAMESPACE}::oid and objid = ${OWNERSHIP_LOCK}::oid`;
  return rows.map((row: { pid: number }) => row.pid);
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return 'ok';
  } catch (error) {
    return error instanceof PersistenceError ? error.code : `unexpected: ${String(error)}`;
  }
}

describe('ownership session', () => {
  test('an idle ownership session keeps its identity and lock; client-side retirement is really disabled', async () => {
    const db = await scratch();
    const persistence = await open(db, [], 200);
    const identity = persistence.ownership.identity;
    expect(await lockHolders(db)).toEqual([identity.pid]);

    // Controls: the same idle period retires a pooled connection with a one-second idle timeout, not with zero.
    const retiring = new SQL(db.url, { max: 1, idleTimeout: 1, connection: { application_name: 'control-idle-1' } });
    const retained = new SQL(db.url, { max: 1, idleTimeout: 0, connection: { application_name: 'control-idle-0' } });
    cleanups.push(
      () => retiring.close({ timeout: 1 }),
      () => retained.close({ timeout: 1 }),
    );
    await Promise.all([retiring`select 1`, retained`select 1`]);

    await Bun.sleep(3_000);
    const [counts] = await db.admin`
      select count(*) filter (where application_name = 'control-idle-1')::int as retiring,
             count(*) filter (where application_name = 'control-idle-0')::int as retained
      from pg_stat_activity where datname = ${db.name}`;
    expect(counts).toEqual({ retiring: 0, retained: 1 });

    await persistence.ownership.verify();
    expect(persistence.ownership.identity).toEqual(identity);
    expect(persistence.ownership.lost).toBeUndefined();
    expect(await lockHolders(db)).toEqual([identity.pid]);
  }, 15_000);

  test('termination of the ownership session is latched permanently and a successor takes over', async () => {
    const db = await scratch();
    const faults: PersistenceError[] = [];
    const first = await open(db, faults);
    expect(await db.terminate({ pid: first.ownership.identity.pid })).toBe(1);

    await eventually(() => first.ownership.lost !== undefined, 5_000, 'ownership loss');
    expect(faults.map((fault) => fault.code)).toContain('ownership_lost');
    expect(() => first.ownership.assertHeld()).toThrow(PersistenceError);
    expect(await codeOf(first.ownership.verify())).toBe('ownership_lost');
    expect(await codeOf(withOwnerFence(first.app, first.ownership, async () => 'mutated'))).toBe('ownership_lost');

    const successor = await open(db);
    expect(successor.ownership.epoch).toBe('2');
    expect(await lockHolders(db)).toEqual([successor.ownership.identity.pid]);
    // The old instance never regains authority, even though the database is healthy again.
    expect(await codeOf(first.ownership.verify())).toBe('ownership_lost');
    expect(first.ownership.lost?.code).toBe('ownership_lost');
  });

  test('periodic verification detects loss even without a connection-close notification', async () => {
    const db = await scratch();
    // A pool without the application close handler isolates the verification monitor.
    const bare = new SQL(db.url, { max: 2, idleTimeout: 0, maxLifetime: 0 });
    cleanups.push(() => bare.close({ timeout: 1 }));
    const ownership = await Ownership.acquire(bare, { verifyIntervalMs: 100, verifyTimeoutMs: 1_000 });
    cleanups.push(() => ownership.release());
    const losses: string[] = [];
    ownership.onLost((error) => losses.push(error.code));

    expect(await db.terminate({ pid: ownership.identity.pid })).toBe(1);
    await eventually(() => losses.length > 0, 3_000, 'monitor detection');
    expect(losses).toEqual(['ownership_lost']);
  });

  test('a second instance cannot acquire ownership while the first session lives', async () => {
    const db = await scratch();
    await open(db);
    const bare = new SQL(db.url, { max: 2 });
    cleanups.push(() => bare.close({ timeout: 1 }));
    expect(await codeOf(Ownership.acquire(bare))).toBe('owned_elsewhere');
  });
});

describe('owner epoch fencing', () => {
  test('a new epoch waits for in-flight fenced work, then refuses the stale owner', async () => {
    const db = await scratch();
    await db.admin`create table public.fence_witness (label text not null)`;
    const stale: Persistence = await open(db);
    // A stale process that has not yet noticed its loss: its local checks still pass.
    const staleView = {
      ownerId: stale.ownership.ownerId,
      epoch: stale.ownership.epoch,
      assertHeld: () => {},
      verify: async () => {},
    };

    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered = () => {};
    const inside = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const inFlight = withOwnerFence(stale.app, staleView, async (tx) => {
      entered();
      await held;
      await tx`insert into public.fence_witness values ('in-flight')`;
    });
    await inside;

    // The stale process loses its session but has not noticed; a successor starts meanwhile.
    await db.terminate({ pid: stale.ownership.identity.pid });
    let successorEpoch: string | undefined;
    const successor = open(db).then((next) => {
      successorEpoch = next.ownership.epoch;
      return next;
    });
    await Bun.sleep(500);
    expect(successorEpoch).toBeUndefined();

    release();
    await inFlight;
    await successor;
    expect(successorEpoch).toBe('2');

    expect(
      await codeOf(
        withOwnerFence(stale.app, staleView, async (tx) => {
          await tx`insert into public.fence_witness values ('stale')`;
        }),
      ),
    ).toBe('stale_owner');
    const rows = await db.admin`select label from public.fence_witness order by label`;
    expect(rows.map((row: { label: string }) => row.label)).toEqual(['in-flight']);
  });
});
