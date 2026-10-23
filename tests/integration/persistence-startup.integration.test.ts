import { afterEach, describe, expect, test } from 'bun:test';
import { PersistenceError } from '../../packages/runtime/src/persistence/errors.ts';
import {
  openPersistence,
  type Persistence,
  type StartupStage,
} from '../../packages/runtime/src/persistence/persistence.ts';
import { RUNTIME_MIGRATIONS } from '../../packages/runtime/src/persistence/runtime-migrations.ts';
import { pauseOnQuestion, seedWorkingRun } from '../support/run-records.ts';
import { createScratchDatabase, type ScratchDatabase } from '../support/scratch-database.ts';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function scratch(): Promise<ScratchDatabase> {
  const db = await createScratchDatabase();
  cleanups.push(() => db.drop());
  return db;
}

async function open(db: ScratchDatabase, stages: StartupStage[] = []): Promise<Persistence> {
  const persistence = await openPersistence({ url: db.url, onFault: () => {}, onStage: (stage) => stages.push(stage) });
  cleanups.push(() => persistence.close());
  return persistence;
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return 'opened';
  } catch (error) {
    return error instanceof PersistenceError ? error.code : 'unexpected';
  }
}

async function schemaSnapshot(db: ScratchDatabase) {
  const tables = await db.admin`
    select table_schema || '.' || table_name as name from information_schema.tables
    where table_schema not in ('pg_catalog', 'information_schema') order by 1`;
  const journal = await db.admin`
    select version, name, checksum, applied_at::text as applied_at from runtime.schema_migrations order by version`;
  const saver = await db.admin`select v from checkpoints.checkpoint_migrations order by v`;
  const [owner] = await db.admin`select epoch::text as epoch from runtime.runtime_owner`;
  return {
    tables: tables.map((row: { name: string }) => row.name),
    journal: [...journal],
    saver: saver.map((row: { v: number }) => row.v),
    epoch: owner?.epoch as string | undefined,
  };
}

describe('serialized schema setup', () => {
  test('a fresh database is migrated once, in order, with runtime and saver schemas separated', async () => {
    const db = await scratch();
    const stages: StartupStage[] = [];
    const persistence = await open(db, stages);
    expect(stages).toEqual(['owned', 'migrating', 'migrated', 'epoch_claimed']);
    expect(persistence.ownership.epoch).toBe('1');

    const snapshot = await schemaSnapshot(db);
    expect(snapshot.tables).toEqual([
      'checkpoints.checkpoint_blobs',
      'checkpoints.checkpoint_migrations',
      'checkpoints.checkpoint_writes',
      'checkpoints.checkpoints',
      'runtime.events',
      'runtime.execution_definitions',
      'runtime.invocations',
      'runtime.model_attempts',
      'runtime.questions',
      'runtime.runs',
      'runtime.runtime_owner',
      'runtime.schema_migrations',
      'runtime.tool_operations',
    ]);
    expect(snapshot.journal.map((row) => row.name)).toEqual(RUNTIME_MIGRATIONS.map((migration) => migration.name));
    expect(snapshot.saver).toEqual([0, 1, 2, 3, 4]);
  });

  test('setup is idempotent across restarts and only the owner epoch advances', async () => {
    const db = await scratch();
    await (await open(db)).close();
    const before = await schemaSnapshot(db);
    const again = await open(db);
    const after = await schemaSnapshot(db);
    expect(after.journal).toEqual(before.journal);
    expect(after.saver).toEqual(before.saver);
    expect(after.tables).toEqual(before.tables);
    expect(again.ownership.epoch).toBe('2');
  });

  test('concurrent starters produce one owner; the others change nothing and never migrate', async () => {
    const db = await scratch();
    const stagesByStarter: StartupStage[][] = [[], [], [], []];
    const attempts = await Promise.allSettled(
      stagesByStarter.map((stages) =>
        openPersistence({ url: db.url, onFault: () => {}, onStage: (stage) => stages.push(stage) }),
      ),
    );
    const winners = attempts.flatMap((attempt) => (attempt.status === 'fulfilled' ? [attempt.value] : []));
    for (const winner of winners) cleanups.push(() => winner.close());
    expect(winners).toHaveLength(1);

    const losers = attempts.flatMap((attempt, index) => (attempt.status === 'rejected' ? [index] : []));
    expect(losers).toHaveLength(3);
    for (const index of losers) {
      const attempt = attempts[index] as PromiseRejectedResult;
      expect((attempt.reason as PersistenceError).code).toBe('owned_elsewhere');
      expect(stagesByStarter[index]).toEqual([]);
    }
    expect((await schemaSnapshot(db)).epoch).toBe('1');

    await winners[0]?.close();
    const next = await open(db);
    expect(next.ownership.epoch).toBe('2');
  });
});

describe('schema version refusal', () => {
  async function migratedDatabase(): Promise<ScratchDatabase> {
    const db = await scratch();
    await (await open(db)).close();
    return db;
  }

  const refusals: [string, string][] = [
    [
      'a newer runtime migration',
      `insert into runtime.schema_migrations (version, name, checksum)
        values (${RUNTIME_MIGRATIONS.length + 1}, 'future', '${'f'.repeat(64)}')`,
    ],
    ['an altered runtime migration', `update runtime.schema_migrations set checksum = '${'0'.repeat(64)}'`],
    ['a newer checkpoint migration', 'insert into checkpoints.checkpoint_migrations (v) values (5)'],
    ['a gapped checkpoint history', 'delete from checkpoints.checkpoint_migrations where v = 2'],
  ];

  for (const [label, tamper] of refusals) {
    test(`refuses ${label} before changing anything`, async () => {
      const db = await migratedDatabase();
      await db.admin.unsafe(tamper);
      const before = await schemaSnapshot(db);
      expect(await codeOf(openPersistence({ url: db.url, onFault: () => {} }))).toBe('schema_incompatible');
      expect(await schemaSnapshot(db)).toEqual(before);
    });
  }

  test('refuses an unknown runtime history even when checkpoint tables are absent', async () => {
    const db = await scratch();
    await db.admin.unsafe(`create schema runtime;
      create table runtime.schema_migrations (version int primary key, name text not null, checksum text not null,
        applied_at timestamptz not null default now());
      insert into runtime.schema_migrations (version, name, checksum) values (1, 'someone_else', '${'a'.repeat(64)}');`);
    expect(await codeOf(openPersistence({ url: db.url, onFault: () => {} }))).toBe('schema_incompatible');
    const [saver] = await db.admin`select to_regclass('checkpoints.checkpoint_migrations') is not null as present`;
    expect(saver.present).toBe(false);
  });
});

describe('upgrading recorded questions to byte limits (migration 3)', () => {
  /** A database migrated only through version 2, holding one question with the given prompt. */
  async function versionTwoDatabase(prompt: string): Promise<ScratchDatabase> {
    const db = await scratch();
    await (await openPersistence({ url: db.url, onFault: () => {} })).close();
    await db.admin.unsafe(`
      alter table runtime.questions drop constraint questions_prompt_bytes, drop constraint questions_text_bytes;
      alter table runtime.events drop constraint events_question_text_bytes;
      drop function runtime.question_text_bytes(text, jsonb);
      delete from runtime.schema_migrations where version = 3;`);
    await db.admin.begin(async (tx) => {
      const run = await seedWorkingRun(tx);
      await pauseOnQuestion(tx, run, 'call-legacy', { prompt });
    });
    return db;
  }

  const journal = async (db: ScratchDatabase) =>
    (await db.admin`select version from runtime.schema_migrations order by version`).map(
      (row: { version: number }) => row.version,
    );

  test('compliant history upgrades', async () => {
    const db = await versionTwoDatabase('é'.repeat(8192));
    await open(db);
    expect(await journal(db)).toEqual([1, 2, 3]);
  });

  test('a recorded prompt over the byte limit stops startup without rewriting history', async () => {
    const prompt = 'é'.repeat(8193);
    const db = await versionTwoDatabase(prompt);
    expect(await codeOf(openPersistence({ url: db.url, onFault: () => {} }))).toBe('migration_failed');
    expect(await journal(db)).toEqual([1, 2]);
    const [row] = await db.admin`select prompt from runtime.questions`;
    expect(row.prompt).toBe(prompt);
  });
});
