import { afterEach, describe, expect, test } from 'bun:test';
import { PersistenceError } from '../../packages/runtime/src/persistence/errors.ts';
import {
  openPersistence,
  type Persistence,
  type StartupStage,
} from '../../packages/runtime/src/persistence/persistence.ts';
import { RUNTIME_MIGRATIONS } from '../../packages/runtime/src/persistence/runtime-migrations.ts';
import { insertOperation, seedCommandRun, startDelegate } from '../support/capabilities.ts';
import { acceptAnswer, pauseOnQuestion, seedWorkingRun } from '../support/run-records.ts';
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
    expect([...snapshot.tables].sort()).toEqual([
      'checkpoints.checkpoint_blobs',
      'checkpoints.checkpoint_migrations',
      'checkpoints.checkpoint_writes',
      'checkpoints.checkpoints',
      'runtime.capability_snapshots',
      'runtime.events',
      'runtime.execution_definitions',
      'runtime.invocations',
      'runtime.loaded_skills',
      'runtime.model_attempts',
      'runtime.questions',
      'runtime.run_actors',
      'runtime.run_capabilities',
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

/** A database set up by an earlier build that shipped only the first `version` runtime migrations. */
async function earlierDatabase(version: number): Promise<ScratchDatabase> {
  const db = await scratch();
  await (
    await openPersistence({ url: db.url, onFault: () => {}, migrations: RUNTIME_MIGRATIONS.slice(0, version) })
  ).close();
  return db;
}

describe('upgrading recorded questions to byte limits (migration 3)', () => {
  /** A database migrated only through version 2, holding one question with the given prompt. */
  async function versionTwoDatabase(prompt: string): Promise<ScratchDatabase> {
    const db = await earlierDatabase(2);
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
    expect(await journal(db)).toEqual(RUNTIME_MIGRATIONS.map((migration) => migration.version));
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

describe('capability records (migration 4)', () => {
  /** Every phase-1 record column, as text, in a stable order. */
  async function recordedHistory(db: ScratchDatabase) {
    return {
      runs: await db.admin`select run_id::text, create_request_id::text, input_digest, goal, workspace::text,
        binding::text, definition_digest, budget_max, consumed, unconfirmed, state::text, revision::text,
        last_seq::text, created_at::text from runtime.runs order by run_id`,
      events: await db.admin`select run_id::text, seq::text, recorded_at::text, kind, payload::text, source_key
        from runtime.events order by run_id, seq`,
      operations: await db.admin`select run_id::text, operation_id, model_message_id, provider_tool_call_id, tool_name,
        arguments::text, argument_digest, disposition::text from runtime.tool_operations order by run_id, operation_id`,
      questions: await db.admin`select run_id::text, question_id, prompt, input::text, binding::text, binding_digest,
        disposition::text from runtime.questions order by run_id, question_id`,
      attempts: await db.admin`select run_id::text, attempt_id::text, ordinal, state::text
        from runtime.model_attempts order by run_id, ordinal`,
      definitions: await db.admin`select digest, manifest::text from runtime.execution_definitions order by digest`,
    };
  }

  test('an upgraded database keeps every recorded byte and gives each existing run a root actor only', async () => {
    const db = await earlierDatabase(3);
    await db.admin.begin(async (tx) => {
      const waiting = await seedWorkingRun(tx);
      await pauseOnQuestion(tx, waiting, 'call-waiting');
      const answered = await pauseOnQuestion(tx, await seedWorkingRun(tx), 'call-answered');
      await acceptAnswer(tx, answered, false);
      const working = await seedWorkingRun(tx, { budgetMax: 3 });
      await tx`insert into runtime.model_attempts (run_id, attempt_id, invocation_id, ordinal, provider, model,
          profile_id, state)
        values (${working.runId}, ${crypto.randomUUID()}, ${working.invocationId}, 1, 'anthropic', 'claude-test',
          'anthropic.subscription.v1', ${JSON.stringify({ kind: 'reserved' })}::text::jsonb)`;
      await tx`update runtime.runs set unconfirmed = 1 where run_id = ${working.runId}`;
    });
    const before = await recordedHistory(db);

    await open(db);
    expect(await recordedHistory(db)).toEqual(before);
    const actors = await db.admin`select run_id::text, actor_key, kind from runtime.run_actors order by run_id`;
    expect(actors).toEqual(
      before.runs.map((run: { run_id: string }) => ({ run_id: run.run_id, actor_key: 'root', kind: 'root' })),
    );
    const [counts] = await db.admin`select
        (select count(*) from runtime.run_capabilities)::int as bindings,
        (select count(*) from runtime.capability_snapshots)::int as snapshots,
        (select count(*) from runtime.tool_operations where identity_version <> 1 or actor_key <> 'root')::int as v2,
        (select count(*) from runtime.model_attempts where actor_key <> 'root')::int as attributed,
        (select count(*) from runtime.questions where actor_key <> 'root')::int as delegated`;
    expect(counts).toEqual({ bindings: 0, snapshots: 0, v2: 0, attributed: 0, delegated: 0 });
  });

  test('a build that knows only version 3 refuses an upgraded database before changing either schema', async () => {
    const db = await scratch();
    await (await open(db)).close();
    const before = await schemaSnapshot(db);
    const refused = openPersistence({ url: db.url, onFault: () => {}, migrations: RUNTIME_MIGRATIONS.slice(0, 3) });
    expect(await codeOf(refused)).toBe('schema_incompatible');
    expect(await schemaSnapshot(db)).toEqual(before);
  });
});

describe('canonical tool names (migration 5)', () => {
  const TABLES = [
    'runs',
    'events',
    'invocations',
    'tool_operations',
    'questions',
    'model_attempts',
    'execution_definitions',
    'capability_snapshots',
    'run_capabilities',
    'run_actors',
    'loaded_skills',
  ];
  /** Every recorded row of every application table, as JSON text, in a stable order. */
  async function everyRecord(db: ScratchDatabase) {
    const records: Record<string, string[]> = {};
    for (const table of TABLES) {
      const rows = await db.admin.unsafe(`select row_to_json(t)::text as row from runtime.${table} t order by 1`);
      records[table] = rows.map((row: { row: string }) => row.row);
    }
    return records;
  }

  test('an upgraded database keeps every recorded byte, including command runs and delegates', async () => {
    const db = await earlierDatabase(4);
    await db.admin.begin(async (tx) => {
      await pauseOnQuestion(tx, await seedWorkingRun(tx), 'call-waiting');
      const command = await seedCommandRun(tx);
      const delegationId = await startDelegate(tx, command, 'call-delegate');
      await insertOperation(tx, command.runId, {
        actorKey: delegationId,
        callId: 'call-longest',
        toolName: 'x'.repeat(128),
      });
    });
    const before = await everyRecord(db);
    expect(before.run_capabilities).toHaveLength(1);
    expect(before.run_actors).toHaveLength(3);

    await open(db);
    expect(await everyRecord(db)).toEqual(before);
  });

  test('a build that knows only version 4 refuses an upgraded database before changing either schema', async () => {
    const db = await scratch();
    await (await open(db)).close();
    const before = await schemaSnapshot(db);
    const refused = openPersistence({ url: db.url, onFault: () => {}, migrations: RUNTIME_MIGRATIONS.slice(0, 4) });
    expect(await codeOf(refused)).toBe('schema_incompatible');
    expect(await schemaSnapshot(db)).toEqual(before);
  });
});
