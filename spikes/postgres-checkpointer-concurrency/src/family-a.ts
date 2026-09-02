// Family A: concurrent setup and migrations.
//
// `PostgresSaver.setup()` and `PostgresStore.runStoreMigrations()` are both a
// read-then-DDL-then-ledger sequence with no transaction and no lock. Whether
// that races, and what it leaves behind when it does, is what this family
// measures. Nothing here asserts the vendor relations exist beforehand: their
// existence after a race IS the result, so the family provisions bare.
//
// Two lanes run against the same situation. The passive lane calls `setup()`
// behind a barrier and observes whatever happens; it proves nothing about what
// each racer read. The gated lane parks every racer immediately after its
// migration-version read has settled, so "all four saw an empty ledger" is a
// recorded fact rather than an assumption — and its sequential control releases
// the same racers one at a time through the same gate, which must then show the
// later ones reading a populated ledger and raising nothing.

import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { PostgresStore } from "@langchain/langgraph-checkpoint-postgres/store";

import {
  ADVISORY_CLASS_MIGRATION,
  CHECKPOINT_SCHEMA,
  STORE_SCHEMA,
  databaseForCase,
  migrationLockKey,
} from "./contract.ts";
import { appNameFor, describeSqlError, openDb, type Db, type SqlError } from "./db.ts";
import { arrive, waitForRelease } from "./barrier.ts";
import { createProbe } from "./probe.ts";
import {
  createSink,
  instrumentPool,
  recordPark,
  statementMultiset,
  type GateHook,
  type GateSpec,
  type StatementSink,
} from "./gate.ts";
import { storePool } from "./reflect.ts";
import { createEmbeddings } from "./store/embeddings.ts";
import { migrationLedger } from "./inspect/checkpoints.ts";

export type PartyContext = {
  caseId: string;
  party: number;
  member: string;
};

const CHECKPOINT_LEDGER = "checkpoint_migrations";

function subjectPool(context: PartyContext, max = 4): Db {
  return openDb(appNameFor(context.caseId, context.member, "subject"), "subject", {
    database: databaseForCase(context.caseId),
    max,
    // Migration DDL takes ACCESS EXCLUSIVE locks that a racer must be allowed to
    // wait on; the default bounded timeout would turn a serialised migration
    // into an anonymous 57014 and lose the finding.
    statementTimeoutMs: 60_000,
  });
}

function probePool(context: PartyContext): Db {
  return openDb(appNameFor(context.caseId, context.member, "witness"), "probe", {
    database: databaseForCase(context.caseId),
  });
}

function parkAtBarrier(
  probe: Db,
  context: PartyContext,
  nonce: string,
  barrierName: string,
): GateHook {
  return async (gate, statement) => {
    await recordPark(probe, context.caseId, context.party, gate, statement);
    await arrive(probe, context.caseId, barrierName, context.party, context.member, nonce);
    await waitForRelease(probe, context.caseId, barrierName);
  };
}

/** Records the boundary durably, then never returns: the driver kills it here. */
function parkForever(probe: Db, context: PartyContext): GateHook {
  return async (gate, statement) => {
    await recordPark(probe, context.caseId, context.party, gate, statement);
    await new Promise<never>(() => {});
  };
}

async function ledgerOf(db: Db, schema: string, table: string): Promise<number[]> {
  try {
    const { rows } = await db.pool.query<{ v: number }>(
      `SELECT v FROM "${schema}".${table} ORDER BY v`,
    );
    return rows.map((row) => row.v);
  } catch (error) {
    if ((error as { code?: string }).code === "42P01") return [];
    throw error;
  }
}

type SetupOutcome = {
  party: number;
  error: SqlError | null;
  statements: Record<string, number>;
  ledgerSeenByParty: number[];
};

async function runSaverSetup(
  context: PartyContext,
  options: { gates?: GateSpec[]; hook?: GateHook; barrier?: string | null } = {},
): Promise<SetupOutcome> {
  const probe = probePool(context);
  const subject = subjectPool(context);
  const sink: StatementSink = createSink();

  try {
    const witness = createProbe(probe, context.caseId, context.party, context.member);
    instrumentPool(subject.pool, sink, options.gates ?? [], options.hook ?? (async () => {}));

    if (options.barrier) {
      await arrive(probe, context.caseId, options.barrier, context.party, context.member, witness.nonce);
      await waitForRelease(probe, context.caseId, options.barrier);
    }

    let error: SqlError | null = null;
    const saver = new PostgresSaver(subject.pool, undefined, { schema: CHECKPOINT_SCHEMA });
    try {
      await saver.setup();
      await witness.record("setup", "returned");
    } catch (caught) {
      error = describeSqlError(caught);
      await witness.record("setup", "raised", { code: error.code });
    }

    return {
      party: context.party,
      error,
      statements: statementMultiset(sink),
      ledgerSeenByParty: await ledgerOf(subject, CHECKPOINT_SCHEMA, CHECKPOINT_LEDGER),
    };
  } finally {
    await Promise.allSettled([subject.close(), probe.close()]);
  }
}

function storeConfig(context: PartyContext, overrides: Record<string, unknown> = {}) {
  const embeddings = createEmbeddings();
  return {
    embeddings,
    config: {
      connectionOptions: {
        connectionString: `postgresql://${process.env.PGUSER ?? "spike"}@${process.env.PGHOST ?? "postgres"}:${process.env.PGPORT ?? "5432"}/${databaseForCase(context.caseId)}?application_name=${appNameFor(context.caseId, context.member, "subject")}`,
        max: 4,
      },
      schema: STORE_SCHEMA,
      ...overrides,
    } as ConstructorParameters<typeof PostgresStore>[0],
  };
}

function withIndex(dims: number, extra: Record<string, unknown> = {}) {
  const embeddings = createEmbeddings();
  return {
    embeddings,
    index: { dims, embed: embeddings, fields: ["title"], ...extra },
  };
}

async function runStoreSetup(
  context: PartyContext,
  options: {
    gates?: GateSpec[];
    hook?: GateHook;
    barrier?: string | null;
    index?: Record<string, unknown> | null;
  } = {},
): Promise<SetupOutcome> {
  const probe = probePool(context);
  const sink: StatementSink = createSink();
  const { config } = storeConfig(context, options.index ? { index: options.index } : {});
  const store = new PostgresStore(config);

  try {
    const witness = createProbe(probe, context.caseId, context.party, context.member);
    // PostgresStore builds its own pool and accepts no injection point, so the
    // instrumentation is attached by reflection immediately after construction —
    // before any method call, because setup is lazy and no connection exists yet.
    instrumentPool(storePool(store), sink, options.gates ?? [], options.hook ?? (async () => {}));

    if (options.barrier) {
      await arrive(probe, context.caseId, options.barrier, context.party, context.member, witness.nonce);
      await waitForRelease(probe, context.caseId, options.barrier);
    }

    let error: SqlError | null = null;
    try {
      await store.setup();
      await witness.record("store-setup", "returned");
    } catch (caught) {
      error = describeSqlError(caught);
      await witness.record("store-setup", "raised", { code: error.code });
    }

    const inspect = openDb(appNameFor(context.caseId, context.member, "inspect"), "inspect", {
      database: databaseForCase(context.caseId),
    });
    const ledger = await ledgerOf(inspect, STORE_SCHEMA, "store_migrations");
    await inspect.close();

    return { party: context.party, error, statements: statementMultiset(sink), ledgerSeenByParty: ledger };
  } finally {
    await store.stop().catch(() => {});
    await probe.close().catch(() => {});
  }
}

export async function runFamilyAParty(context: PartyContext): Promise<Record<string, unknown>> {
  const gateOnVersionRead = (position: "pre" | "post", label: string): GateSpec[] => [
    { name: "version-read", label, ordinal: 1, position },
  ];

  switch (context.caseId) {
    case "a01-saver-setup-serial":
      return await runSaverSetup(context);

    case "a02-saver-setup-race-passive":
      // A barrier before the CALL only. It proves the four processes started
      // together; it deliberately does NOT claim they all read an empty ledger.
      return await runSaverSetup(context, { barrier: "gathered" });

    case "a03-saver-setup-race-gated": {
      const probe = probePool(context);
      const witness = createProbe(probe, context.caseId, context.party, context.member);
      try {
        return await runSaverSetup(context, {
          gates: gateOnVersionRead("post", "ckpt.migration-read"),
          hook: parkAtBarrier(probe, context, witness.nonce, "read-empty"),
        });
      } finally {
        await probe.close().catch(() => {});
      }
    }

    case "a04-saver-setup-gated-sequential-control": {
      const probe = probePool(context);
      const witness = createProbe(probe, context.caseId, context.party, context.member);
      try {
        // `pre`, not `post`: the racers park BEFORE reading, and are released one
        // at a time, so each later one reads a ledger the previous one populated.
        const outcome = await runSaverSetup(context, {
          gates: gateOnVersionRead("pre", "ckpt.migration-read"),
          hook: parkAtBarrier(probe, context, witness.nonce, `gate-${context.party}`),
        });
        await arrive(probe, context.caseId, `done-${context.party}`, context.party, context.member, witness.nonce);
        await waitForRelease(probe, context.caseId, `done-${context.party}`);
        return outcome;
      } finally {
        await probe.close().catch(() => {});
      }
    }

    case "a05-saver-setup-kill-before-ledger": {
      if (context.party === 0) {
        const probe = probePool(context);
        try {
          return await runSaverSetup(context, {
            // Ordinal 2 is the ledger insert for migration 1, so the kill leaves
            // `checkpoints` created with the ledger still reading 0 — a partial
            // state a retry has to converge from.
            gates: [
              { name: "ledger-pre", label: "ckpt.migration-ledger", ordinal: 2, position: "pre" },
            ],
            hook: parkForever(probe, context),
          });
        } finally {
          await probe.close().catch(() => {});
        }
      }
      return await runSaverSetup(context);
    }

    case "a06-store-setup-serial":
      return await runStoreSetup(context, { index: withIndex(8).index });

    case "a07-store-setup-race-gated": {
      const probe = probePool(context);
      const witness = createProbe(probe, context.caseId, context.party, context.member);
      try {
        return await runStoreSetup(context, {
          index: withIndex(8).index,
          gates: gateOnVersionRead("post", "store.migration-read"),
          hook: parkAtBarrier(probe, context, witness.nonce, "read-empty"),
        });
      } finally {
        await probe.close().catch(() => {});
      }
    }

    case "a08-store-trigger-race": {
      const probe = probePool(context);
      const witness = createProbe(probe, context.caseId, context.party, context.member);
      try {
        // The ledger was rewound to 2 and the trigger dropped by `prepare`, so
        // both racers replay migration 3 — the one migration containing a bare
        // `CREATE TRIGGER` with no IF NOT EXISTS.
        return await runStoreSetup(context, {
          gates: gateOnVersionRead("post", "store.migration-read"),
          hook: parkAtBarrier(probe, context, witness.nonce, "read-v2"),
        });
      } finally {
        await probe.close().catch(() => {});
      }
    }

    case "a09-store-lazy-same-process":
      return await lazyStore(context, { awaitSetupFirst: false });

    case "a10-store-lazy-awaited-control":
      return await lazyStore(context, { awaitSetupFirst: true });

    case "a11-store-index-config-change":
      return await indexConfigChange(context);

    case "a12-colocated-schemas":
      return await colocatedSchemas(context);

    case "a13-saver-setup-advisory-lock":
      return await advisoryLockedSetup(context);

    default:
      throw new Error(`family A has no participant for case ${context.caseId}`);
  }
}

/**
 * The lazy-setup guard is `if (!this.isSetup && this.ensureTables) await setup()`
 * and `isSetup` is assigned only after the awaited migrations finish, so
 * concurrent first operations in ONE process can all enter the migration loop.
 */
async function lazyStore(
  context: PartyContext,
  options: { awaitSetupFirst: boolean },
): Promise<Record<string, unknown>> {
  const sink = createSink();
  const { config } = storeConfig(context, { index: withIndex(8).index });
  const store = new PostgresStore(config);

  try {
    instrumentPool(storePool(store), sink, [], async () => {});

    if (options.awaitSetupFirst) await store.setup();

    const beforeOperations = sink.statements.length;
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, (_, index) =>
        store.put(["case", context.caseId], `k${index}`, { title: "alpha", n: index }),
      ),
    );

    const rejections = results
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => describeSqlError(result.reason));

    const migrationReads = sink.statements.filter(
      (statement, index) =>
        statement.label === "store.migration-read" && index >= beforeOperations,
    ).length;

    const inspect = openDb(appNameFor(context.caseId, context.member, "inspect"), "inspect", {
      database: databaseForCase(context.caseId),
    });
    const ledger = await ledgerOf(inspect, STORE_SCHEMA, "store_migrations");
    await inspect.close();

    return {
      party: context.party,
      // Present and null on purpose: the operation-level failures live in
      // `rejections`, and an absent key must not read the same as a clean run.
      error: null,
      awaitSetupFirst: options.awaitSetupFirst,
      operations: results.length,
      fulfilled: results.filter((result) => result.status === "fulfilled").length,
      rejections,
      // The discriminator: a single process that entered the migration loop more
      // than once during the operation phase did so because `isSetup` is a plain
      // boolean rather than an in-flight promise.
      migrationReadsDuringOperations: migrationReads,
      ledger,
      statements: statementMultiset(sink),
    };
  } finally {
    await store.stop().catch(() => {});
  }
}

/**
 * The migration ledger records POSITIONS, but the migration list's CONTENT
 * depends on `indexConfig`. Changing `dims` after the first setup therefore
 * changes nothing: the loop `for (v = version + 1; v < migrations.length; v++)`
 * has an empty range, and the column keeps its original dimension.
 */
async function indexConfigChange(context: PartyContext): Promise<Record<string, unknown>> {
  const first = new PostgresStore(storeConfig(context, { index: withIndex(8).index }).config);
  await first.setup();
  await first.stop();

  const inspect = openDb(appNameFor(context.caseId, context.member, "inspect"), "inspect", {
    database: databaseForCase(context.caseId),
  });
  const ledgerBefore = await ledgerOf(inspect, STORE_SCHEMA, "store_migrations");
  const columnBefore = await vectorColumnType(inspect);

  const sink = createSink();
  const second = new PostgresStore(storeConfig(context, { index: withIndex(9).index }).config);
  instrumentPool(storePool(second), sink, [], async () => {});
  await second.setup();

  const ledgerAfter = await ledgerOf(inspect, STORE_SCHEMA, "store_migrations");
  const columnAfter = await vectorColumnType(inspect);

  let putError: SqlError | null = null;
  try {
    // The write-path guard compares the embedding length to indexConfig.dims, so
    // a 9-dimensional vector passes it and reaches a vector(8) column.
    await second.put(["case", context.caseId], "mismatch", { title: "wrongdim" }, ["title"]);
  } catch (error) {
    putError = describeSqlError(error);
  }

  await second.stop().catch(() => {});
  const vectorRows = await inspect.pool
    .query<{ count: string }>(`SELECT count(*)::text AS count FROM "${STORE_SCHEMA}".store_vectors`)
    .then((result) => Number(result.rows[0]?.count ?? "0"))
    .catch(() => -1);
  await inspect.close();

  return {
    error: null,
    ledgerBefore,
    ledgerAfter,
    ledgerUnchanged: JSON.stringify(ledgerBefore) === JSON.stringify(ledgerAfter),
    columnBefore,
    columnAfter,
    columnUnchanged: columnBefore === columnAfter,
    migrationsRunOnSecondSetup: statementMultiset(sink)["store.migration-ddl"] ?? 0,
    putError,
    vectorRows,
  };
}

async function vectorColumnType(db: Db): Promise<string | null> {
  const { rows } = await db.pool.query<{ type: string }>(
    `SELECT format_type(a.atttypid, a.atttypmod) AS type
       FROM pg_attribute a
       JOIN pg_class c     ON c.oid = a.attrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relname = 'store_vectors' AND a.attname = 'embedding'`,
    [STORE_SCHEMA],
  );
  return rows[0]?.type ?? null;
}

/** Both components migrated into ONE schema, to see whether their names collide. */
async function colocatedSchemas(context: PartyContext): Promise<Record<string, unknown>> {
  const shared = "lg_shared";
  const subject = subjectPool(context);
  const saver = new PostgresSaver(subject.pool, undefined, { schema: shared });
  await saver.setup();

  const store = new PostgresStore({
    ...storeConfig(context, { index: withIndex(8).index }).config,
    schema: shared,
  });
  await store.setup();
  await store.stop().catch(() => {});

  const { rows } = await subject.pool.query<{ relation: string }>(
    `SELECT c.relname AS relation
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relkind IN ('r', 'p')
      ORDER BY 1`,
    [shared],
  );
  const relations = rows.map((row) => row.relation);
  await subject.close();

  return {
    error: null,
    schema: shared,
    relations,
    checkpointerLedgerPresent: relations.includes("checkpoint_migrations"),
    storeLedgerPresent: relations.includes("store_migrations"),
    ledgersAreDistinctRelations:
      relations.includes("checkpoint_migrations") && relations.includes("store_migrations"),
    duplicateRelationNames: relations.length !== new Set(relations).size,
  };
}

/**
 * The migration safeguard: a dedicated session holds a session-level advisory
 * lock across the STOCK `setup()`, which runs unmodified.
 *
 * The lock must not be taken through the subject pool — a pool may hand the DDL
 * to a different connection than the one holding the lock, and `pg_advisory_lock`
 * is owned by the session, not by the pool.
 */
async function advisoryLockedSetup(context: PartyContext): Promise<Record<string, unknown>> {
  const probe = probePool(context);
  const lease = openDb(appNameFor(context.caseId, context.member, "lease"), "lease", {
    database: databaseForCase(context.caseId),
    max: 1,
    statementTimeoutMs: null,
  });

  const key = migrationLockKey(CHECKPOINT_SCHEMA, CHECKPOINT_LEDGER);
  const witness = createProbe(probe, context.caseId, context.party, context.member);
  const client = await lease.pool.connect();

  try {
    await arrive(probe, context.caseId, "gathered", context.party, context.member, witness.nonce);
    await waitForRelease(probe, context.caseId, "gathered");

    const { rows: tried } = await client.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_lock($1, $2) AS acquired",
      [ADVISORY_CLASS_MIGRATION, key],
    );
    const contended = tried[0]?.acquired !== true;
    if (contended) {
      await client.query("SELECT pg_advisory_lock($1, $2)", [ADVISORY_CLASS_MIGRATION, key]);
    }
    const acquiredAt = await serverClock(client);

    const outcome = await runSaverSetup(context);

    const releasedAt = await serverClock(client);
    const { rows: unlocked } = await client.query<{ ok: boolean }>(
      "SELECT pg_advisory_unlock($1, $2) AS ok",
      [ADVISORY_CLASS_MIGRATION, key],
    );

    // Scoped to THIS backend. A count across all sessions is meaningless here:
    // the other racers are still holding their own locks while this one releases.
    const { rows: held } = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM pg_locks
        WHERE locktype = 'advisory' AND classid = $1 AND objid = $2
          AND granted AND pid = pg_backend_pid()`,
      [ADVISORY_CLASS_MIGRATION, key >>> 0],
    );

    return {
      ...outcome,
      lockKey: { classid: ADVISORY_CLASS_MIGRATION, objid: key, derivedFrom: `${CHECKPOINT_SCHEMA}:${CHECKPOINT_LEDGER}` },
      observedContention: contended,
      acquiredAt,
      releasedAt,
      // `false` means this session did not hold what it thought it held: a
      // harness fault, never a pass.
      unlockReturnedTrue: unlocked[0]?.ok === true,
      advisoryLocksStillGranted: Number(held[0]?.count ?? "-1"),
    };
  } finally {
    client.release();
    await Promise.allSettled([lease.close(), probe.close()]);
  }
}

async function serverClock(client: { query: (sql: string) => Promise<{ rows: Array<{ now: string }> }> }): Promise<string> {
  const { rows } = await client.query("SELECT clock_timestamp()::text AS now");
  return rows[0]?.now ?? "";
}

/**
 * Case fixtures that must exist before any party starts.
 *
 * a08 rewinds the Store ledger to 2 and drops the trigger created by migration
 * 3, so both racers replay exactly one migration — the only one whose DDL is not
 * idempotent. Without this the trigger race is unreachable, because a cold race
 * collides on the ledger long before it reaches migration 3.
 */
export async function prepareFamilyA(caseId: string): Promise<Record<string, unknown>> {
  if (caseId !== "a08-store-trigger-race") return { caseId, prepared: false };

  const context: PartyContext = { caseId, party: -1, member: "prepare" };
  const { config } = storeConfig(context);
  const store = new PostgresStore(config);
  await store.setup();
  await store.stop().catch(() => {});

  const db = openDb(appNameFor(caseId, "prepare", "inspect"), "inspect", {
    database: databaseForCase(caseId),
  });
  try {
    const before = await ledgerOf(db, STORE_SCHEMA, "store_migrations");
    await db.pool.query(`DELETE FROM "${STORE_SCHEMA}".store_migrations WHERE v >= 3`);
    await db.pool.query(
      `DROP TRIGGER IF EXISTS update_store_updated_at ON "${STORE_SCHEMA}".store`,
    );
    const after = await ledgerOf(db, STORE_SCHEMA, "store_migrations");
    return { caseId, prepared: true, ledgerBefore: before, ledgerAfter: after };
  } finally {
    await db.close();
  }
}
