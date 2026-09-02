// Family D, first slice: Store setup, lifecycle, CRUD and schema.
//
// Two source readings shape almost everything here, and both are predictions
// this file exists to check rather than facts it assumes:
//
//   * `executePut` is NOT transactional. It acquires one client through
//     `withClient` — which contains no BEGIN anywhere — and then runs the row
//     upsert, a DELETE of the item's vectors, and one INSERT per embedded field
//     as separate AUTOCOMMIT statements. Anything that fails partway through
//     therefore commits a prefix rather than rolling back.
//   * No operation checks `isClosed`. `stop()` sets the flag and ends the pool,
//     but `put`/`get`/`delete` go straight to `core.withClient`, so a call after
//     close reaches an ended pool instead of a guard.
//
// Neither is a documented contract. Both are architecture-relevant: the runtime
// stores agent state here and needs to know whether a rejected write happened
// anyway, and whether a closed Store fails identifiably.

import { PostgresStore } from "@langchain/langgraph-checkpoint-postgres/store";

import { STORE_SCHEMA, databaseForCase, rankingFixture } from "./contract.ts";
import {
  appNameFor,
  connectionString,
  describeSqlError,
  openDb,
  type Db,
  type SqlError,
} from "./db.ts";
import { arrive, waitForRelease } from "./barrier.ts";
import { createProbe } from "./probe.ts";
import { createSink, instrumentPool, statementMultiset, type StatementSink } from "./gate.ts";
import { storePool } from "./reflect.ts";
import { createEmbeddings } from "./store/embeddings.ts";
import { extensionPlacement, projectStore } from "./inspect/store.ts";
import type { PartyContext } from "./family-a.ts";

/** One namespace and key per case; every case already has its own database. */
const NS = ["spike", "items"];
const KEY = "item-1";

/** A second and third schema, for the isolation and search-path cases. */
const SCHEMA_B = "lg_store_b";
const SCHEMA_C = "lg_store_c";

/**
 * Literal operands for the concurrent Store cases.
 *
 * The marker lives in the VALUE and the indexed text lives in `title`, so the
 * surviving row and the surviving vector identify their writer independently.
 * Attributing both from one field would make "the value is party 1's and the
 * vectors are party 0's" inexpressible — and that split is the finding.
 */
const STORE_CONFLICT = {
  markerByOwner: { p0: "party-0-payload", p1: "party-1-payload" },
  vectorTextByOwner: { p0: "alpha", p1: "beta" },
  seedMarker: "seed-payload",
  seedText: "gamma",
} as const;

const DIMS = 8;

function probePool(context: PartyContext): Db {
  return openDb(appNameFor(context.caseId, context.member, "witness"), "probe", {
    database: databaseForCase(context.caseId),
  });
}

function inspectPool(context: PartyContext): Db {
  return openDb(appNameFor(context.caseId, context.member, "inspect"), "inspect", {
    database: databaseForCase(context.caseId),
  });
}

type StoreOptions = {
  schema?: string;
  ensureTables?: boolean;
  index?: Record<string, unknown> | false;
  distanceMetric?: "cosine" | "l2" | "inner_product";
  /** Raw libpq options, for the search-path case. */
  connectionOptions?: string;
  /**
   * The Store builds its own pool, so its ceiling is set here rather than on a
   * `Db`. Deliberately left without a `connectionTimeoutMillis`: pg then waits
   * forever for a connection, which is what makes a nested acquisition through
   * a starved pool present as a genuine hang instead of a tidy timeout.
   */
  poolMax?: number;
  ttl?: { defaultTtl?: number; refreshOnRead?: boolean; sweepIntervalMinutes?: number };
};

function indexConfig(options: StoreOptions) {
  if (options.index === false) return undefined;
  return {
    dims: DIMS,
    embed: createEmbeddings(),
    fields: ["title"],
    ...(options.distanceMetric ? { distanceMetric: options.distanceMetric } : {}),
    ...(options.index ?? {}),
  };
}

function makeStore(context: PartyContext, options: StoreOptions = {}): PostgresStore {
  const index = indexConfig(options);
  return new PostgresStore({
    connectionOptions: {
      connectionString: connectionString(
        appNameFor(context.caseId, context.member, "subject"),
        databaseForCase(context.caseId),
      ),
      max: options.poolMax ?? 4,
      ...(options.connectionOptions ? { options: options.connectionOptions } : {}),
    },
    schema: options.schema ?? STORE_SCHEMA,
    ensureTables: options.ensureTables ?? true,
    ...(index ? { index } : {}),
    ...(options.ttl ? { ttl: options.ttl } : {}),
  } as ConstructorParameters<typeof PostgresStore>[0]);
}

async function ledgerOf(db: Db, schema = STORE_SCHEMA): Promise<number[]> {
  try {
    const { rows } = await db.pool.query<{ v: number }>(
      `SELECT v FROM "${schema}".store_migrations ORDER BY v`,
    );
    return rows.map((row) => row.v);
  } catch (error) {
    if ((error as { code?: string }).code === "42P01") return [];
    throw error;
  }
}

/** Vector-index names present, so a configured-but-unindexed metric is visible. */
async function vectorIndexes(db: Db, schema = STORE_SCHEMA): Promise<string[]> {
  const { rows } = await db.pool.query<{ name: string }>(
    `SELECT indexname AS name FROM pg_indexes
      WHERE schemaname = $1 AND indexname LIKE 'idx_store_vectors_embedding%'
      ORDER BY 1`,
    [schema],
  );
  return rows.map((row) => row.name);
}

async function capture<T>(fn: () => Promise<T>): Promise<{ ok: boolean; error: SqlError | null }> {
  try {
    await fn();
    return { ok: true, error: null };
  } catch (error) {
    return { ok: false, error: describeSqlError(error) };
  }
}

// ---------------------------------------------------------------------------

/**
 * One uncontended CRUD cycle, with the migrations either awaited up front (d01)
 * or left to the first operation (d02).
 *
 * The discriminator is not whether the operations succeeded — both do — but
 * WHERE the migration statements appear. Counting them from the index at which
 * the operation phase began is what separates "setup ran first" from "the first
 * put carried it".
 */
async function lifecycleCycle(
  context: PartyContext,
  options: { explicitStart: boolean },
): Promise<Record<string, unknown>> {
  const sink: StatementSink = createSink();
  const store = makeStore(context);
  const inspect = inspectPool(context);

  try {
    instrumentPool(storePool(store), sink, [], async () => {});

    let startError: SqlError | null = null;
    if (options.explicitStart) {
      const started = await capture(() => store.start());
      startError = started.error;
    }

    const beforeOperations = sink.statements.length;

    const put = await capture(() =>
      store.put(NS, KEY, { title: "alpha", marker: "baseline" }, ["title"]),
    );
    const got = await store.get(NS, KEY).catch(() => null);
    const deleted = await capture(() => store.delete(NS, KEY));
    const afterDelete = await store.get(NS, KEY).catch(() => null);

    const migrationStatements = sink.statements.filter(
      (statement, index) =>
        index >= beforeOperations && statement.label.startsWith("store.migration"),
    ).length;

    return {
      party: context.party,
      error: startError ?? put.error ?? deleted.error,
      explicitStart: options.explicitStart,
      ledger: await ledgerOf(inspect),
      // Present and null on purpose: an absent key must not read like a clean run.
      putError: put.error,
      deleteError: deleted.error,
      valueRoundTripped: got ? JSON.stringify(got.value) : null,
      getAfterDeleteWasNull: afterDelete === null,
      // The discriminator between d01 and d02.
      migrationStatementsDuringOperations: migrationStatements,
      statements: statementMultiset(sink),
    };
  } finally {
    await store.stop().catch(() => {});
    await inspect.close().catch(() => {});
  }
}

/**
 * `stop()` ends the pool and sets `isClosed`, but nothing reads that flag on the
 * operation paths. What a closed Store raises — and whether it names itself with
 * a SQLSTATE or only with a message — is the measurement.
 */
async function useAfterStop(context: PartyContext): Promise<Record<string, unknown>> {
  const store = makeStore(context);
  const inspect = inspectPool(context);

  try {
    await store.start();
    const before = await capture(() =>
      store.put(NS, KEY, { title: "alpha", marker: "before-stop" }, ["title"]),
    );

    await store.stop();

    const attempts: Array<{ op: string; ok: boolean; error: SqlError | null }> = [];
    for (const [op, run] of [
      ["get", () => store.get(NS, KEY)],
      ["put", () => store.put(NS, "item-2", { title: "beta" }, ["title"])],
      ["delete", () => store.delete(NS, KEY)],
      ["getStats", () => store.getStats()],
    ] as const) {
      const outcome = await capture(run as () => Promise<unknown>);
      attempts.push({ op, ...outcome });
    }

    // Documented as idempotent by its own `isClosed` guard, so a second stop
    // must not raise. If it did, a shutdown path could not be made safe.
    const secondStop = await capture(() => store.stop());

    const projection = await projectStore(inspect);
    return {
      party: context.party,
      error: before.error,
      operationsAfterStop: attempts,
      everyOperationAfterStopFailed: attempts.every((attempt) => !attempt.ok),
      // Recorded, not asserted in a direction: whether a closed Store names
      // itself with a SQLSTATE at all IS the finding.
      sqlstatesAfterStop: [...new Set(attempts.map((attempt) => attempt.error?.code ?? null))],
      errorNamesAfterStop: [...new Set(attempts.map((attempt) => attempt.error?.name ?? null))],
      secondStopRaised: !secondStop.ok,
      // The write from before stop() must still be there: it proves the failures
      // are the closed pool rather than a store that never worked.
      itemsSurviving: projection.stats.total,
    };
  } finally {
    await store.stop().catch(() => {});
    await inspect.close().catch(() => {});
  }
}

/**
 * `ensureTables: false` — the configuration every runtime Store uses once a
 * single migrator owns the schema. Against a cold schema it must refuse loudly
 * and create nothing; against a migrated one it must work and migrate nothing.
 */
async function ensureTablesFalse(context: PartyContext): Promise<Record<string, unknown>> {
  const sink: StatementSink = createSink();
  const store = makeStore(context, { ensureTables: false });
  const inspect = inspectPool(context);

  try {
    instrumentPool(storePool(store), sink, [], async () => {});

    const started = await capture(() => store.start());
    const put = await capture(() =>
      store.put(NS, KEY, { title: "alpha", marker: "no-ensure" }, ["title"]),
    );
    const get = await capture(() => store.get(NS, KEY));

    const multiset = statementMultiset(sink);
    const migrationStatements = Object.entries(multiset)
      .filter(([label]) => label.startsWith("store.migration") || label === "store.create-extension")
      .reduce((total, [, count]) => total + count, 0);

    return {
      party: context.party,
      error: started.error,
      putError: put.error,
      getError: get.error,
      operationsSucceeded: put.ok && get.ok,
      // Zero either way: with ensureTables off the Store must never migrate,
      // whether or not the tables happen to be there.
      migrationStatements,
      ledger: await ledgerOf(inspect),
      statements: multiset,
    };
  } finally {
    await store.stop().catch(() => {});
    await inspect.close().catch(() => {});
  }
}

/**
 * A rejected `put()` on an already-indexed item.
 *
 * The row upsert commits, then the vectors are DELETEd, then the embedder is
 * called — and the frozen embedder refuses text absent from the fixture. So the
 * question is whether the caller's failure means nothing happened, or whether
 * the item now holds the new value with no vectors at all.
 *
 * `failing: false` is the control: the identical sequence with text the embedder
 * knows, which must leave the item indexed on the second value.
 */
async function putFailureLeavesRow(
  context: PartyContext,
  options: { failing: boolean },
): Promise<Record<string, unknown>> {
  const store = makeStore(context);
  const inspect = inspectPool(context);
  const secondText = options.failing ? "text-absent-from-the-fixture" : "beta";

  try {
    const first = await capture(() =>
      store.put(NS, KEY, { title: "alpha", marker: "first" }, ["title"]),
    );
    const afterFirst = await projectStore(inspect);

    const second = await capture(() =>
      store.put(NS, KEY, { title: secondText, marker: "second" }, ["title"]),
    );
    const afterSecond = await projectStore(inspect);
    const got = await store.get(NS, KEY).catch(() => null);

    const marker = (got?.value as { marker?: string } | undefined)?.marker ?? null;

    return {
      party: context.party,
      error: first.error,
      failingVariant: options.failing,
      firstPutIndexed: afterFirst.vectors.length,
      secondPutRejected: !second.ok,
      secondPutError: second.error,
      // The three facts the finding rests on: did the value change, did the
      // vectors survive, and is the item still readable.
      markerAfterSecondPut: marker,
      vectorsAfterSecondPut: afterSecond.vectors.length,
      vectorTextsAfterSecondPut: afterSecond.vectors.map((row) => row.text_content),
      itemStillReadable: got !== null,
      unindexedItems: afterSecond.unindexedItems.length,
    };
  } finally {
    await store.stop().catch(() => {});
    await inspect.close().catch(() => {});
  }
}

/** Two writers updating one already-indexed item, released together. */
async function concurrentPut(context: PartyContext): Promise<Record<string, unknown>> {
  const probe = probePool(context);
  const store = makeStore(context);
  const owner = context.party === 0 ? "p0" : "p1";

  try {
    const witness = createProbe(probe, context.caseId, context.party, context.member);
    await arrive(probe, context.caseId, "ready", context.party, context.member, witness.nonce);
    await waitForRelease(probe, context.caseId, "ready");

    const put = await capture(() =>
      store.put(
        NS,
        KEY,
        {
          title: STORE_CONFLICT.vectorTextByOwner[owner],
          marker: STORE_CONFLICT.markerByOwner[owner],
        },
        ["title"],
      ),
    );

    await witness.record("put", put.ok ? "returned" : "raised", { code: put.error?.code ?? null });
    return { party: context.party, error: put.error, role: "writer", owner };
  } finally {
    await store.stop().catch(() => {});
    await probe.close().catch(() => {});
  }
}

/** A put racing a delete on one key, released together. */
async function concurrentPutAndDelete(context: PartyContext): Promise<Record<string, unknown>> {
  const probe = probePool(context);
  const store = makeStore(context);
  const writer = context.party === 0;

  try {
    const witness = createProbe(probe, context.caseId, context.party, context.member);
    await arrive(probe, context.caseId, "ready", context.party, context.member, witness.nonce);
    await waitForRelease(probe, context.caseId, "ready");

    const outcome = writer
      ? await capture(() =>
          store.put(
            NS,
            KEY,
            { title: STORE_CONFLICT.vectorTextByOwner.p0, marker: STORE_CONFLICT.markerByOwner.p0 },
            ["title"],
          ),
        )
      : await capture(() => store.delete(NS, KEY));

    await witness.record(writer ? "put" : "delete", outcome.ok ? "returned" : "raised", {
      code: outcome.error?.code ?? null,
    });
    return {
      party: context.party,
      error: outcome.error,
      role: writer ? "writer" : "deleter",
    };
  } finally {
    await store.stop().catch(() => {});
    await probe.close().catch(() => {});
  }
}

/**
 * What a value loses on the way to JSONB.
 *
 * Every expectation is a hand-authored literal in this table, written from the
 * JSON and JSONB specifications rather than from a previous run. An expectation
 * produced by observing the Store would agree with it by construction and prove
 * nothing.
 *
 * `index: false` on every put keeps the embedder out of the path: this case is
 * about serialization, and an embedder refusal would mask a serialization
 * result.
 */
const SERIALIZATION_CASES: Array<{
  name: string;
  value: Record<string, unknown>;
  /** `null` where the value never reaches PostgreSQL at all. */
  expectedStoredText: string | null;
  expectedRejected: boolean;
  note: string;
}> = [
  {
    name: "undefined-keys-are-dropped",
    value: { b: 1, a: undefined },
    expectedStoredText: '{"b": 1}',
    expectedRejected: false,
    note: "JSON.stringify omits undefined-valued keys, so the key is gone rather than null.",
  },
  {
    name: "date-becomes-a-string",
    value: { d: new Date("2026-01-01T00:00:00.000Z") },
    expectedStoredText: '{"d": "2026-01-01T00:00:00.000Z"}',
    expectedRejected: false,
    note: "toJSON makes it an ISO string; the Date type does not survive the round trip.",
  },
  {
    name: "non-finite-numbers-become-null",
    value: { n: Number.NaN, i: Number.POSITIVE_INFINITY, m: Number.NEGATIVE_INFINITY },
    expectedStoredText: '{"i": null, "m": null, "n": null}',
    expectedRejected: false,
    note: "JSON has no NaN or Infinity, so all three silently become null.",
  },
  {
    name: "jsonb-normalises-key-order",
    value: { b: 1, a: 2, c: 3 },
    expectedStoredText: '{"a": 2, "b": 1, "c": 3}',
    expectedRejected: false,
    note: "JSONB stores a sorted map, so authored key order is not preserved.",
  },
  {
    // Every key above is one character long, so that case cannot tell
    // length-first ordering apart from plain lexicographic ordering. This one
    // can: lexicographically "aa" precedes "z", but JSONB compares LENGTH first
    // and so stores "z" ahead of it.
    name: "jsonb-key-order-is-length-then-bytewise",
    value: { z: 1, aa: 2 },
    expectedStoredText: '{"z": 1, "aa": 2}',
    expectedRejected: false,
    note: "JSONB orders object keys by length before comparing bytes, so key order is neither authored nor alphabetical.",
  },
  {
    // JSONB numbers are `numeric`, which renders positionally rather than in
    // exponential form: the expectation is 1 followed by 308 zeros, written
    // from that rule rather than copied from a run.
    name: "large-finite-float-survives",
    value: { n: 1e308 },
    expectedStoredText: `{"n": 1${"0".repeat(308)}}`,
    expectedRejected: false,
    note: "Within double range, so it survives — but JSONB numeric re-renders it positionally, turning a 6-character literal into a 309-digit one.",
  },
  {
    name: "unicode-and-nesting-survive",
    value: { café: { 深: ["x", "y"] } },
    expectedStoredText: '{"café": {"深": ["x", "y"]}}',
    expectedRejected: false,
    note: "Non-ASCII keys and nested arrays round-trip unchanged.",
  },
  {
    name: "nul-byte-is-rejected",
    value: { s: "a\u0000b" },
    expectedStoredText: null,
    expectedRejected: true,
    note: "PostgreSQL cannot store \\u0000 in JSONB and raises 22P05.",
  },
  {
    name: "bigint-is-rejected-before-sql",
    value: { n: 10n },
    expectedStoredText: null,
    expectedRejected: true,
    note: "JSON.stringify throws a TypeError, so this one never reaches the database.",
  },
];

async function serializationBoundaries(context: PartyContext): Promise<Record<string, unknown>> {
  const store = makeStore(context, { index: false });
  const inspect = inspectPool(context);

  try {
    const rows: Array<Record<string, unknown>> = [];

    for (const [index, spec] of SERIALIZATION_CASES.entries()) {
      const key = `ser-${index}`;
      const put = await capture(() => store.put(NS, key, spec.value, false));

      const stored = await inspect.pool
        .query<{ value_text: string }>(
          `SELECT value::text AS value_text FROM "${STORE_SCHEMA}".store
            WHERE namespace_path = $1 AND key = $2`,
          [NS.join(":"), key],
        )
        .then((result) => result.rows[0]?.value_text ?? null);

      const got = await store.get(NS, key).catch(() => null);

      rows.push({
        name: spec.name,
        note: spec.note,
        rejected: !put.ok,
        error: put.error,
        expectedRejected: spec.expectedRejected,
        expectedStoredText: spec.expectedStoredText,
        storedText: stored,
        // Compared against the hand-authored literal, not against itself.
        matchedExpectation: !put.ok === spec.expectedRejected && stored === spec.expectedStoredText,
        roundTrippedTypes: got
          ? Object.fromEntries(
              Object.entries(got.value as Record<string, unknown>).map(([field, inner]) => [
                field,
                inner === null ? "null" : typeof inner,
              ]),
            )
          : null,
      });
    }

    return {
      party: context.party,
      error: null,
      cases: rows,
      total: rows.length,
      matched: rows.filter((row) => row.matchedExpectation === true).length,
    };
  } finally {
    await store.stop().catch(() => {});
    await inspect.close().catch(() => {});
  }
}

/** Two Stores, two schemas, one database, the same namespace and key. */
async function schemaIsolation(context: PartyContext): Promise<Record<string, unknown>> {
  const storeA = makeStore(context);
  const storeB = makeStore(context, { schema: SCHEMA_B });
  const inspect = inspectPool(context);

  try {
    const setupA = await capture(() => storeA.setup());
    const setupB = await capture(() => storeB.setup());

    await storeA.put(NS, KEY, { title: "alpha", marker: "schema-a" }, ["title"]);
    await storeB.put(NS, KEY, { title: "beta", marker: "schema-b" }, ["title"]);

    const gotA = await storeA.get(NS, KEY);
    const gotB = await storeB.get(NS, KEY);

    const projectionA = await projectStore(inspect, null, STORE_SCHEMA);
    const projectionB = await projectStore(inspect, null, SCHEMA_B);

    return {
      party: context.party,
      error: setupA.error ?? setupB.error,
      schemas: [STORE_SCHEMA, SCHEMA_B],
      markerA: (gotA?.value as { marker?: string } | undefined)?.marker ?? null,
      markerB: (gotB?.value as { marker?: string } | undefined)?.marker ?? null,
      itemsA: projectionA.stats.total,
      itemsB: projectionB.stats.total,
      ledgerA: projectionA.migrations,
      ledgerB: projectionB.migrations,
      // Read from the tables, not through either API: an API that ignored the
      // schema would still return the value it just wrote.
      valueDigestsA: projectionA.items.map((row) => row.value_digest),
      valueDigestsB: projectionB.items.map((row) => row.value_digest),
      valuesAreDistinctAcrossSchemas:
        projectionA.items[0]?.value_digest !== projectionB.items[0]?.value_digest,
    };
  } finally {
    await Promise.allSettled([storeA.stop(), storeB.stop()]);
    await inspect.close().catch(() => {});
  }
}

/**
 * Where the pgvector extension actually lives, and what that costs.
 *
 * The migration writes `embedding vector(N)` unqualified, so the column type
 * only resolves while the extension's schema is on the search_path. A second
 * Store migrated on a connection whose search_path holds only its own schema is
 * the discriminator: if it fails, schema isolation is incomplete by
 * construction rather than by configuration.
 */
async function vectorExtensionPlacement(context: PartyContext): Promise<Record<string, unknown>> {
  const store = makeStore(context);
  const inspect = inspectPool(context);

  try {
    const setup = await capture(() => store.setup());
    const placement = await extensionPlacement(inspect);

    const restricted = makeStore(context, {
      schema: SCHEMA_C,
      connectionOptions: `-c search_path=${SCHEMA_C}`,
    });
    const restrictedSetup = await capture(() => restricted.setup());
    await restricted.stop().catch(() => {});

    const vector = placement.extensions.find((row) => row.name === "vector") ?? null;

    return {
      party: context.party,
      error: setup.error,
      extensions: placement.extensions,
      vectorExtensionSchema: vector?.schema ?? null,
      vectorColumnType: placement.vectorColumnType,
      vectorTypeSchema: placement.vectorTypeSchema,
      // The extension is not in the Store's schema; the column type resolves to
      // wherever it landed. Both are recorded rather than assumed.
      extensionIsInStoreSchema: vector?.schema === STORE_SCHEMA,
      restrictedSearchPath: `${SCHEMA_C}`,
      restrictedSetupSucceeded: restrictedSetup.ok,
      restrictedSetupError: restrictedSetup.error,
    };
  } finally {
    await store.stop().catch(() => {});
    await inspect.close().catch(() => {});
  }
}

/**
 * The distance metric changed between runs.
 *
 * a11 established that a DIMENSION change is a silent no-op because the ledger
 * records positions while the migration list's content depends on the
 * configuration. The metric is the same mechanism with a different visible
 * consequence: nothing raises on any path, so the only evidence is which index
 * exists.
 */
async function indexMetricChange(context: PartyContext): Promise<Record<string, unknown>> {
  const inspect = inspectPool(context);

  try {
    const first = makeStore(context, { distanceMetric: "cosine" });
    await first.setup();
    await first.stop().catch(() => {});

    const ledgerBefore = await ledgerOf(inspect);
    const indexesBefore = await vectorIndexes(inspect);

    const sink = createSink();
    const second = makeStore(context, { distanceMetric: "l2" });
    instrumentPool(storePool(second), sink, [], async () => {});
    const setup = await capture(() => second.setup());

    const ledgerAfter = await ledgerOf(inspect);
    const indexesAfter = await vectorIndexes(inspect);

    // The write path does not consult the metric, so an item still indexes
    // cleanly — which is precisely why the mismatch is invisible to a caller.
    const put = await capture(() =>
      second.put(NS, KEY, { title: "alpha", marker: "metric-change" }, ["title"]),
    );
    await second.stop().catch(() => {});

    return {
      party: context.party,
      error: setup.error,
      ledgerBefore,
      ledgerAfter,
      ledgerUnchanged: JSON.stringify(ledgerBefore) === JSON.stringify(ledgerAfter),
      indexesBefore,
      indexesAfter,
      indexesUnchanged: JSON.stringify(indexesBefore) === JSON.stringify(indexesAfter),
      configuredMetricAfterRestart: "l2",
      configuredMetricHasNoIndex: !indexesAfter.some((name) => name.includes("_l2_")),
      migrationsRunOnSecondSetup: statementMultiset(sink)["store.migration-index"] ?? 0,
      putError: put.error,
      putSucceededDespiteMismatch: put.ok,
    };
  } finally {
    await inspect.close().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Slice 2: batch, pool and TTL.

/**
 * A namespace label the vendor validator rejects.
 *
 * `%` is in `LIKE_RESERVED_PATTERN`, so `validateNamespace` throws BEFORE any
 * SQL runs. That matters: the failure has to land inside the batch loop without
 * being a database error, so what survives is decided by the loop's structure
 * rather than by a transaction PostgreSQL might have rolled back on its own.
 */
const INVALID_NAMESPACE = ["spike", "bad%label"];

function itemsUnder(projection: { items?: Array<{ key: string }> }, prefix: string): string[] {
  return (projection.items ?? [])
    .map((row) => row.key)
    .filter((key) => key.startsWith(prefix))
    .sort();
}

/** A batch whose later operations read what its earlier ones wrote. */
async function batchReadYourWrites(context: PartyContext): Promise<Record<string, unknown>> {
  const store = makeStore(context, { index: false });
  const inspect = inspectPool(context);

  try {
    const results = (await store.batch([
      { namespace: NS, key: "b-1", value: { marker: "written-in-batch" } },
      { namespace: NS, key: "b-1" },
      { namespace: NS, key: "b-1", value: { marker: "overwritten-in-batch" } },
      { namespace: NS, key: "b-1" },
    ] as never)) as unknown[];

    const first = results[1] as { value?: { marker?: string } } | null;
    const second = results[3] as { value?: { marker?: string } } | null;
    const projection = await projectStore(inspect);

    return {
      party: context.party,
      error: null,
      operations: 4,
      // Each get must observe the put immediately before it: one client, no
      // transaction, so every statement is already committed when the next runs.
      firstGetSawFirstPut: first?.value?.marker === "written-in-batch",
      secondGetSawSecondPut: second?.value?.marker === "overwritten-in-batch",
      terminalMarker:
        (projection.items.find((row) => row.key === "b-1")?.value_text ?? "").includes(
          "overwritten-in-batch",
        ),
      itemsWritten: itemsUnder(projection, "b-"),
    };
  } finally {
    await store.stop().catch(() => {});
    await inspect.close().catch(() => {});
  }
}

/**
 * Three puts, the middle one invalid.
 *
 * The loop is `for (const op of operations) results.push(await ...)`, so the
 * throw abandons the rest. Nothing wraps it, so the first put stays committed.
 */
async function batchPartialCommit(context: PartyContext): Promise<Record<string, unknown>> {
  const store = makeStore(context, { index: false });
  const inspect = inspectPool(context);

  try {
    const attempt = await capture(() =>
      store.batch([
        { namespace: NS, key: "p-before", value: { marker: "before-the-failure" } },
        { namespace: INVALID_NAMESPACE, key: "p-invalid", value: { marker: "invalid" } },
        { namespace: NS, key: "p-after", value: { marker: "after-the-failure" } },
      ] as never),
    );

    const projection = await projectStore(inspect);
    const keys = itemsUnder(projection, "p-");

    return {
      party: context.party,
      error: null,
      batchRejected: !attempt.ok,
      batchError: attempt.error,
      survivingKeys: keys,
      // The finding, in three facts: the prefix committed, the suffix did not
      // run, and the caller was told the whole batch failed.
      operationBeforeTheFailureCommitted: keys.includes("p-before"),
      operationAfterTheFailureDidNotRun: !keys.includes("p-after"),
    };
  } finally {
    await store.stop().catch(() => {});
    await inspect.close().catch(() => {});
  }
}

/** The same three writes, one call each, so failures cannot cascade. */
async function conveniencePathIsolation(context: PartyContext): Promise<Record<string, unknown>> {
  const store = makeStore(context, { index: false });
  const inspect = inspectPool(context);

  try {
    const outcomes: Array<{ key: string; ok: boolean }> = [];
    for (const [namespace, key, marker] of [
      [NS, "p-before", "before-the-failure"],
      [INVALID_NAMESPACE, "p-invalid", "invalid"],
      [NS, "p-after", "after-the-failure"],
    ] as const) {
      const outcome = await capture(() => store.put(namespace as string[], key, { marker }));
      outcomes.push({ key, ok: outcome.ok });
    }

    const projection = await projectStore(inspect);
    const keys = itemsUnder(projection, "p-");

    return {
      party: context.party,
      error: null,
      outcomes,
      survivingKeys: keys,
      // The discriminator against d15: the call after the failure still ran,
      // because each convenience call owns its own error.
      operationAfterTheFailureRan: keys.includes("p-after"),
      failureWasIsolatedToItsOwnCall:
        outcomes.filter((outcome) => !outcome.ok).length === 1 &&
        outcomes.find((outcome) => !outcome.ok)?.key === "p-invalid",
    };
  } finally {
    await store.stop().catch(() => {});
    await inspect.close().catch(() => {});
  }
}

/**
 * Four independent callers enqueued in one tick, one of them invalid.
 *
 * `processBatchQueue` catches once and rejects EVERY queued promise with the
 * same error, so the question is not whether the invalid caller fails — it is
 * how many of the other three are told they failed, and whether any of them
 * committed anyway.
 */
async function asyncBatchedFanout(context: PartyContext): Promise<Record<string, unknown>> {
  const { AsyncBatchedStore } = await import("@langchain/langgraph-checkpoint");
  const store = makeStore(context, { index: false });
  const inspect = inspectPool(context);
  const batched = new AsyncBatchedStore(store as never);

  try {
    // The wrapped store must be migrated before the queue starts, or the
    // migration would land inside the first batch and confuse the attribution.
    await store.start();
    batched.start();

    // Enqueued without awaiting, so all four land in the same tick and are
    // coalesced into one batch.
    const calls = [
      { name: "a-valid", promise: batched.put(NS, "fan-a", { marker: "a" }) },
      { name: "b-valid", promise: batched.put(NS, "fan-b", { marker: "b" }) },
      { name: "c-invalid", promise: batched.put(INVALID_NAMESPACE, "fan-c", { marker: "c" }) },
      { name: "d-valid", promise: batched.put(NS, "fan-d", { marker: "d" }) },
    ];
    const settled = await Promise.allSettled(calls.map((call) => call.promise));
    await batched.stop();

    const outcomes = calls.map((call, index) => ({
      name: call.name,
      rejected: settled[index]!.status === "rejected",
    }));
    const projection = await projectStore(inspect);
    const committed = itemsUnder(projection, "fan-");

    const rejectedButCommitted = outcomes
      .filter((outcome) => outcome.rejected)
      .map((outcome) => outcome.name.split("-")[0]!)
      .filter((letter) => committed.includes(`fan-${letter}`));

    return {
      party: context.party,
      error: null,
      outcomes,
      committedKeys: committed,
      rejectedCount: outcomes.filter((outcome) => outcome.rejected).length,
      // The two facts the architecture turns on: an invalid operation rejects
      // unrelated callers, and at least one of them may have committed while
      // being told it did not.
      validCallersRejected: outcomes.filter(
        (outcome) => outcome.rejected && outcome.name.endsWith("valid"),
      ).length,
      callersToldItFailedButCommitted: rejectedButCommitted,
    };
  } finally {
    await batched.stop().catch(() => {});
    await store.stop().catch(() => {});
    await inspect.close().catch(() => {});
  }
}

/**
 * A batch carrying a search, through a pool of one.
 *
 * The worker bounds ITSELF. Letting the container timeout fire would report a
 * hang as a harness fault, which is the opposite of the truth: not settling is
 * the measurement, so it has to come back as JSON.
 */
async function batchSearchNesting(
  context: PartyContext,
  options: { max: number; indexed: boolean },
): Promise<Record<string, unknown>> {
  const store = makeStore(context, {
    index: options.indexed ? undefined : false,
    poolMax: options.max,
  });
  const waitMs = 15_000;

  try {
    const batchCall = store
      .batch([{ namespacePrefix: NS, query: "alpha", limit: 5 }] as never)
      .then((results) => ({ settled: true, error: null as SqlError | null, results }))
      .catch((error: unknown) => ({
        settled: true,
        error: describeSqlError(error),
        results: null,
      }));

    const timer = new Promise<{ settled: false }>((resolve) => {
      setTimeout(() => resolve({ settled: false }), waitMs).unref();
    });

    const outcome = await Promise.race([batchCall, timer]);
    const settled = outcome.settled === true;

    return {
      party: context.party,
      error: null,
      poolMax: options.max,
      indexConfigured: options.indexed,
      // `false` means the call was still outstanding after the bound — a hang,
      // not a failure. That distinction is the whole point of the case.
      settledWithinBound: settled,
      boundMs: waitMs,
      batchError: settled ? ((outcome as { error: SqlError | null }).error ?? null) : null,
      resultCount:
        settled && Array.isArray((outcome as { results?: unknown[] }).results)
          ? ((outcome as { results: unknown[] }).results[0] as unknown[] | undefined)?.length ?? null
          : null,
    };
  } finally {
    // A deadlocked batch still holds its client, so the pool cannot drain and
    // `stop()` would block forever. The container exits and the driver's drain
    // step is what proves the backends went away.
    void store.stop().catch(() => {});
  }
}

/** Six concurrent convenience puts through a pool of one: serialize, never hang. */
async function storePoolSerialization(context: PartyContext): Promise<Record<string, unknown>> {
  const store = makeStore(context, { index: false, poolMax: 1 });
  const inspect = inspectPool(context);

  try {
    await store.start();
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, (_, index) =>
        store.put(NS, `pool-${index}`, { marker: `value-${index}` }),
      ),
    );

    const { rows } = await inspect.pool.query<{ backends: number }>(
      `SELECT count(DISTINCT pid)::int AS backends
         FROM pg_stat_activity WHERE application_name = $1`,
      [appNameFor(context.caseId, context.member, "subject")],
    );
    const projection = await projectStore(inspect);

    return {
      party: context.party,
      error: null,
      operations: results.length,
      fulfilled: results.filter((result) => result.status === "fulfilled").length,
      rejections: results
        .filter((result): result is PromiseRejectedResult => result.status === "rejected")
        .map((result) => describeSqlError(result.reason)),
      poolMax: 1,
      backendsObserved: rows[0]?.backends ?? -1,
      itemsWritten: itemsUnder(projection, "pool-").length,
    };
  } finally {
    await store.stop().catch(() => {});
    await inspect.close().catch(() => {});
  }
}

/** `ttl: 0` and `ttl: -1`, read back from the column rather than from the API. */
async function ttlZeroAndNegative(context: PartyContext): Promise<Record<string, unknown>> {
  const store = makeStore(context, { index: false });
  const inspect = inspectPool(context);

  try {
    await store.put(NS, "ttl-zero", { marker: "zero" }, false, { ttl: 0 });
    await store.put(NS, "ttl-negative", { marker: "negative" }, false, { ttl: -1 });
    await store.put(NS, "ttl-positive", { marker: "positive" }, false, { ttl: 60 });

    const rows = await inspect.pool.query<{
      key: string;
      expires_at: string | null;
      already_expired: boolean | null;
    }>(
      `SELECT key, expires_at::text AS expires_at,
              (expires_at IS NOT NULL AND expires_at <= CURRENT_TIMESTAMP) AS already_expired
         FROM "${STORE_SCHEMA}".store
        WHERE namespace_path = $1 AND key LIKE 'ttl-%'
        ORDER BY key`,
      [NS.join(":")],
    );
    const by = new Map(rows.rows.map((row) => [row.key, row]));

    return {
      party: context.party,
      error: null,
      // The inversion: zero is falsy, so the guard returns null and the item
      // never expires — the opposite of what the caller asked for.
      zeroTtlProducedNoExpiry: by.get("ttl-zero")?.expires_at === null,
      negativeTtlProducedAPastExpiry: by.get("ttl-negative")?.already_expired === true,
      positiveTtlProducedAFutureExpiry: by.get("ttl-positive")?.already_expired === false,
      zeroTtlItemIsReadable: (await store.get(NS, "ttl-zero")) !== null,
      negativeTtlItemIsReadable: (await store.get(NS, "ttl-negative")) !== null,
      observed: rows.rows.map((row) => ({ key: row.key, expired: row.already_expired })),
    };
  } finally {
    await store.stop().catch(() => {});
    await inspect.close().catch(() => {});
  }
}

/**
 * Refresh-on-read, with and without a configured default.
 *
 * The item is written with a long per-item ttl and then read. `refreshTtl`
 * recomputes from `defaultTtl` alone, so with a short default the read moves
 * `expires_at` EARLIER — a read that shortens the thing it read.
 */
async function ttlRefreshOnRead(
  context: PartyContext,
  options: { defaultTtl: number | null },
): Promise<Record<string, unknown>> {
  const sink: StatementSink = createSink();
  const store = makeStore(context, {
    index: false,
    ttl: {
      refreshOnRead: true,
      ...(options.defaultTtl === null ? {} : { defaultTtl: options.defaultTtl }),
    },
  });
  const inspect = inspectPool(context);

  const expiresAt = async (key: string): Promise<string | null> =>
    await inspect.pool
      .query<{ expires_at: string | null }>(
        `SELECT expires_at::text AS expires_at FROM "${STORE_SCHEMA}".store
          WHERE namespace_path = $1 AND key = $2`,
        [NS.join(":"), key],
      )
      .then((result) => result.rows[0]?.expires_at ?? null);

  try {
    // BEFORE any call, never after. `instrumentPool` patches on the pool's
    // `connect` event, so a client that already exists is never patched — and
    // pg reuses idle clients. Instrumenting after `start()` therefore records
    // nothing and makes "no UPDATE was issued" pass vacuously, which is exactly
    // what it did until the d23 criterion caught it.
    instrumentPool(storePool(store), sink, [], async () => {});
    await store.start();

    // A long per-item lifetime, deliberately far longer than any default.
    await store.put(NS, "refresh-me", { marker: "refresh" }, false, { ttl: 600 });
    const before = await expiresAt("refresh-me");

    const got = await store.get(NS, "refresh-me");
    const after = await expiresAt("refresh-me");

    const beforeMs = before === null ? null : Date.parse(before);
    const afterMs = after === null ? null : Date.parse(after);

    return {
      party: context.party,
      error: null,
      defaultTtl: options.defaultTtl,
      itemWasReadable: got !== null,
      expiryBefore: before,
      expiryAfter: after,
      expiryChangedOnRead: before !== after,
      // The direction is the finding: a read that moves the expiry EARLIER has
      // shortened the item's life by reading it.
      expiryMovedEarlier: beforeMs !== null && afterMs !== null && afterMs < beforeMs,
      updateStatementsOnRead: statementMultiset(sink)["store.update-ttl"] ?? 0,
      statements: statementMultiset(sink),
    };
  } finally {
    await store.stop().catch(() => {});
    await inspect.close().catch(() => {});
  }
}

/** Live and expired rows together: what getStats counts, and what a sweep removes. */
async function manualSweep(context: PartyContext): Promise<Record<string, unknown>> {
  const store = makeStore(context, { index: false });
  const inspect = inspectPool(context);

  try {
    for (let index = 0; index < 3; index += 1) {
      await store.put(NS, `live-${index}`, { marker: "live" }, false, { ttl: 60 });
    }
    for (let index = 0; index < 4; index += 1) {
      await store.put(NS, `dead-${index}`, { marker: "dead" }, false, { ttl: -1 });
    }

    const statsBefore = await store.getStats();
    const projectionBefore = await projectStore(inspect);
    const swept = await store.sweepExpiredItems();
    const statsAfter = await store.getStats();
    const projectionAfter = await projectStore(inspect);

    return {
      party: context.party,
      error: null,
      // getStats counts expired rows in its total, because they are still there:
      // get() filters them out without removing them.
      statsBefore: {
        total: statsBefore.totalItems,
        expired: statsBefore.expiredItems,
        namespaces: statsBefore.namespaceCount,
      },
      statsAfter: {
        total: statsAfter.totalItems,
        expired: statsAfter.expiredItems,
        namespaces: statsAfter.namespaceCount,
      },
      swept,
      rowsBefore: projectionBefore.stats.total,
      rowsAfter: projectionAfter.stats.total,
      expiredRowsBefore: projectionBefore.stats.expired,
      // Read straight from the table, so getStats is checked rather than trusted.
      statsAgreedWithTheTableBefore:
        statsBefore.totalItems === projectionBefore.stats.total &&
        statsBefore.expiredItems === projectionBefore.stats.expired,
      sweptExactlyTheExpiredRows: swept === projectionBefore.stats.expired,
      liveRowsSurvived: itemsUnder(projectionAfter, "live-").length,
      deadRowsRemaining: itemsUnder(projectionAfter, "dead-").length,
    };
  } finally {
    await store.stop().catch(() => {});
    await inspect.close().catch(() => {});
  }
}

/** Two sweepers released together against one set of expired rows. */
async function concurrentSweeper(context: PartyContext): Promise<Record<string, unknown>> {
  const probe = probePool(context);
  const store = makeStore(context, { index: false });

  try {
    const witness = createProbe(probe, context.caseId, context.party, context.member);
    await arrive(probe, context.caseId, "ready", context.party, context.member, witness.nonce);
    await waitForRelease(probe, context.caseId, "ready");

    let swept = -1;
    const outcome = await capture(async () => {
      swept = await store.sweepExpiredItems();
    });

    await witness.record("sweep", outcome.ok ? "returned" : "raised", { swept });
    return { party: context.party, error: outcome.error, role: "sweeper", swept };
  } finally {
    await store.stop().catch(() => {});
    await probe.close().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Slice 3: namespaces, pagination, statistics and filters.

/**
 * The namespace validation table.
 *
 * Each row is a hand-authored expectation taken from `validateNamespace`'s
 * stated rules, not from a run. Two are the point of the case: `_` is rejected
 * even though it is an ordinary naming character, and `:` — the delimiter the
 * Store itself joins with — is NOT rejected.
 */
const NAMESPACE_CASES: Array<{ name: string; labels: string[]; expectedRejected: boolean }> = [
  { name: "ordinary-labels-accepted", labels: ["spike", "ok"], expectedRejected: false },
  { name: "empty-namespace-rejected", labels: [], expectedRejected: true },
  { name: "empty-label-rejected", labels: ["spike", ""], expectedRejected: true },
  { name: "period-rejected", labels: ["spike", "a.b"], expectedRejected: true },
  { name: "percent-rejected", labels: ["spike", "a%b"], expectedRejected: true },
  { name: "underscore-rejected", labels: ["spike", "a_b"], expectedRejected: true },
  { name: "backslash-rejected", labels: ["spike", "a\\b"], expectedRejected: true },
  { name: "root-langgraph-rejected", labels: ["langgraph", "x"], expectedRejected: true },
  // Only the ROOT label is checked, so the reserved word is fine deeper down.
  { name: "non-root-langgraph-accepted", labels: ["spike", "langgraph"], expectedRejected: false },
  // The delimiter the Store joins labels with is not rejected. d28 measures the
  // consequence.
  { name: "colon-accepted", labels: ["spike", "a:b"], expectedRejected: false },
];

async function namespaceValidation(context: PartyContext): Promise<Record<string, unknown>> {
  const store = makeStore(context, { index: false });

  try {
    await store.start();
    const rows: Array<Record<string, unknown>> = [];

    for (const spec of NAMESPACE_CASES) {
      const outcome = await capture(() => store.put(spec.labels, "k", { marker: spec.name }, false));
      rows.push({
        name: spec.name,
        labels: spec.labels,
        rejected: !outcome.ok,
        expectedRejected: spec.expectedRejected,
        matchedExpectation: !outcome.ok === spec.expectedRejected,
        message: outcome.error?.message ?? null,
      });
    }

    return {
      party: context.party,
      error: null,
      cases: rows,
      total: rows.length,
      matched: rows.filter((row) => row.matchedExpectation === true).length,
      colonAccepted: rows.find((row) => row.name === "colon-accepted")?.rejected === false,
      underscoreRejected:
        rows.find((row) => row.name === "underscore-rejected")?.rejected === true,
    };
  } finally {
    await store.stop().catch(() => {});
  }
}

/**
 * `["a:b"]` and `["a","b"]` both join to the namespace path `a:b`.
 *
 * The path is half the primary key, so they are the same row — the second write
 * overwrites the first, and a read through either namespace returns whatever was
 * written last. Round-trip identity does not hold.
 */
async function namespaceDelimiterCollision(
  context: PartyContext,
): Promise<Record<string, unknown>> {
  const store = makeStore(context, { index: false });
  const inspect = inspectPool(context);
  const joined = ["spike", "a:b"];
  const split = ["spike", "a", "b"];

  try {
    await store.start();
    await store.put(joined, "k", { marker: "written-as-one-label" }, false);
    await store.put(split, "k", { marker: "written-as-two-labels" }, false);

    const viaJoined = await store.get(joined, "k");
    const viaSplit = await store.get(split, "k");

    const { rows } = await inspect.pool.query<{ namespace_path: string; value_text: string }>(
      `SELECT namespace_path, value::text AS value_text
         FROM "${STORE_SCHEMA}".store WHERE key = 'k' ORDER BY namespace_path`,
    );

    return {
      party: context.party,
      error: null,
      storedRows: rows.length,
      storedPaths: rows.map((row) => row.namespace_path),
      markerViaJoinedNamespace: (viaJoined?.value as { marker?: string } | undefined)?.marker ?? null,
      markerViaSplitNamespace: (viaSplit?.value as { marker?: string } | undefined)?.marker ?? null,
      // Both reads return the same row because both namespaces ARE the same row.
      bothNamespacesResolvedToOneRow: rows.length === 1,
      // Written under one namespace, readable under a different one.
      readingTheOtherNamespaceReturnedTheOverwrite:
        (viaJoined?.value as { marker?: string } | undefined)?.marker === "written-as-two-labels",
    };
  } finally {
    await store.stop().catch(() => {});
    await inspect.close().catch(() => {});
  }
}

/** Namespaces whose names deliberately overlap as string prefixes. */
async function seedNamespaces(
  store: PostgresStore,
  namespaces: string[][],
): Promise<void> {
  for (const [index, namespace] of namespaces.entries()) {
    await store.put(namespace, `k${index}`, { marker: namespace.join("/") }, false);
  }
}

function sortedPaths(namespaces: string[][]): string[] {
  return namespaces.map((parts) => parts.join(":")).sort();
}

/**
 * The prefix match is `namespace_path LIKE 'prefix%'`, not a path-boundary
 * match, so `["alpha"]` also matches the unrelated namespace `alphabet`.
 */
async function namespacePrefixBoundary(context: PartyContext): Promise<Record<string, unknown>> {
  const store = makeStore(context, { index: false });

  try {
    await store.start();
    await seedNamespaces(store, [["alpha"], ["alphabet"], ["alpha", "one"]]);

    const underAlpha = await store.listNamespaces({ prefix: ["alpha"], limit: 100 });
    const underAlphaOne = await store.listNamespaces({ prefix: ["alpha", "one"], limit: 100 });
    const searched = await store.search(["alpha"], { limit: 100 });

    return {
      party: context.party,
      error: null,
      namespacesUnderAlpha: sortedPaths(underAlpha),
      namespacesUnderAlphaOne: sortedPaths(underAlphaOne),
      searchedKeys: searched.map((item) => item.key).sort(),
      // `alphabet` is not under the `alpha` namespace by any path reading, but
      // it matches the LIKE pattern.
      unrelatedSiblingMatchedThePrefix: sortedPaths(underAlpha).includes("alphabet"),
      // The same string-prefix rule is used by search(), so the leak is not
      // confined to namespace listing.
      searchAlsoCrossedTheBoundary: searched.some((item) => item.namespace.join(":") === "alphabet"),
      // The deeper prefix is exact, which is what stops this being "prefixes
      // never work".
      deeperPrefixWasExact: sortedPaths(underAlphaOne).join(",") === "alpha:one",
    };
  } finally {
    await store.stop().catch(() => {});
  }
}

/**
 * `maxDepth` is applied in JavaScript AFTER `LIMIT`/`OFFSET` has already been
 * applied in SQL, so the limit counts rows that the depth filter is about to
 * discard. A page can come back empty while matching namespaces exist.
 */
async function namespaceMaxDepthAfterLimit(
  context: PartyContext,
): Promise<Record<string, unknown>> {
  const store = makeStore(context, { index: false });

  try {
    await store.start();
    // Ordered by namespace_path, the three depth-2 namespaces sort BEFORE the
    // single depth-1 one, so a small limit consumes only rows the depth filter
    // then removes.
    await seedNamespaces(store, [["z1", "a"], ["z2", "b"], ["z3", "c"], ["zz"]]);

    const limited = await store.listNamespaces({ maxDepth: 1, limit: 2 });
    const unlimited = await store.listNamespaces({ maxDepth: 1, limit: 100 });
    const noDepthFilter = await store.listNamespaces({ limit: 2 });

    return {
      party: context.party,
      error: null,
      withMaxDepthAndSmallLimit: sortedPaths(limited),
      withMaxDepthAndLargeLimit: sortedPaths(unlimited),
      withoutMaxDepth: sortedPaths(noDepthFilter),
      // The finding: a page that returns nothing while a matching namespace
      // exists, because the limit was spent on rows that were then filtered out.
      smallLimitReturnedNothing: limited.length === 0,
      largeLimitFoundTheDepthOneNamespace: sortedPaths(unlimited).join(",") === "zz",
      // Anti-vacuity: the same limit without maxDepth returns a full page, so
      // the empty page is the interaction rather than a broken limit.
      sameLimitWithoutMaxDepthReturnedAFullPage: noDepthFilter.length === 2,
    };
  } finally {
    await store.stop().catch(() => {});
  }
}

/**
 * `listNamespaces` never calls `validateNamespace`; `search` always does.
 *
 * So the wildcard that `put`/`get`/`search` reject as a cross-tenant hazard is
 * accepted by the listing path and behaves as a LIKE wildcard.
 */
async function namespaceValidationAsymmetry(
  context: PartyContext,
): Promise<Record<string, unknown>> {
  const store = makeStore(context, { index: false });

  try {
    await store.start();
    await seedNamespaces(store, [["tenant-a", "x"], ["tenant-b", "y"]]);

    const listed = await capture(async () => {
      const result = await store.listNamespaces({ prefix: ["%"], limit: 100 });
      return result;
    });
    const wildcardNamespaces = listed.ok
      ? sortedPaths(await store.listNamespaces({ prefix: ["%"], limit: 100 }))
      : [];
    const searched = await capture(() => store.search(["%"], { limit: 100 }));
    const put = await capture(() => store.put(["%"], "k", { marker: "wildcard" }, false));

    return {
      party: context.party,
      error: null,
      listNamespacesAcceptedTheWildcard: listed.ok,
      namespacesReturnedForTheWildcard: wildcardNamespaces,
      // Both tenants come back through a prefix that the write and search paths
      // refuse as unsafe.
      wildcardCrossedTenants:
        wildcardNamespaces.includes("tenant-a:x") && wildcardNamespaces.includes("tenant-b:y"),
      searchRejectedTheWildcard: !searched.ok,
      putRejectedTheWildcard: !put.ok,
      searchRejectionMessage: searched.error?.message ?? null,
    };
  } finally {
    await store.stop().catch(() => {});
  }
}

/** Pagination with no depth filter: ordered, disjoint pages covering the set. */
async function namespacePagination(context: PartyContext): Promise<Record<string, unknown>> {
  const store = makeStore(context, { index: false });

  try {
    await store.start();
    await seedNamespaces(store, [["p1"], ["p2"], ["p3"], ["p4"]]);

    const all = await store.listNamespaces({ limit: 100 });
    const page1 = await store.listNamespaces({ limit: 2, offset: 0 });
    const page2 = await store.listNamespaces({ limit: 2, offset: 2 });

    const p1 = sortedPaths(page1);
    const p2 = sortedPaths(page2);

    return {
      party: context.party,
      error: null,
      total: sortedPaths(all),
      page1: p1,
      page2: p2,
      pagesAreFull: page1.length === 2 && page2.length === 2,
      pagesAreDisjoint: p1.every((path) => !p2.includes(path)),
      pagesCoverTheSet: [...p1, ...p2].sort().join(",") === sortedPaths(all).join(","),
    };
  } finally {
    await store.stop().catch(() => {});
  }
}

/**
 * The filter corpus.
 *
 * Deliberately includes a row whose `n` is JSON null and a row with no `n` at
 * all, because SQL's three-valued logic is what decides whether `$ne` and `$nin`
 * include them — and that decision is the finding rather than an accident.
 */
const FILTER_NS = ["spike", "filter"];

const FILTER_CORPUS: Array<{ key: string; value: Record<string, unknown> }> = [
  { key: "f1", value: { n: 1, s: "aaa", flag: true, opt: "present", nested: { a: 1, b: 2 } } },
  { key: "f2", value: { n: 2, s: "bbb", flag: false, opt: "present", nested: { a: 1 } } },
  { key: "f3", value: { n: 3, s: "ccc", flag: true, nested: { a: 2 } } },
  { key: "f4", value: { n: 10, s: "ddd", flag: false, opt: "other", nested: { a: 3 } } },
  { key: "f5", value: { n: null, s: "eee" } },
  { key: "f6", value: { s: "fff", opt: "present" } },
];

/**
 * Hand-authored expected key sets, derived from the generated SQL and from
 * PostgreSQL's semantics — never from a previous run.
 *
 * Results are compared as SORTED SETS rather than in order: without a query the
 * generated `ORDER BY updated_at DESC` is a timestamp comparison between rows
 * written microseconds apart, which is not something this case is measuring.
 */
const FILTER_CASES: Array<{
  name: string;
  filter: Record<string, unknown>;
  expected: string[];
  note: string;
}> = [
  { name: "eq", filter: { n: { $eq: 2 } }, expected: ["f2"], note: "value ->> key = text" },
  {
    name: "ne-excludes-rows-missing-the-key",
    filter: { n: { $ne: 2 } },
    expected: ["f1", "f3", "f4"],
    note: "NULL != '2' is NULL, so the JSON-null row and the row with no `n` are both excluded.",
  },
  { name: "gt", filter: { n: { $gt: 2 } }, expected: ["f3", "f4"], note: "numeric cast" },
  { name: "gte", filter: { n: { $gte: 2 } }, expected: ["f2", "f3", "f4"], note: "numeric cast" },
  { name: "lt", filter: { n: { $lt: 3 } }, expected: ["f1", "f2"], note: "numeric cast" },
  { name: "lte", filter: { n: { $lte: 3 } }, expected: ["f1", "f2", "f3"], note: "numeric cast" },
  {
    name: "in",
    filter: { s: { $in: ["aaa", "ccc"] } },
    expected: ["f1", "f3"],
    note: "= ANY(ARRAY[...])",
  },
  {
    name: "nin",
    filter: { s: { $nin: ["aaa", "ccc"] } },
    expected: ["f2", "f4", "f5", "f6"],
    note: "!= ALL(ARRAY[...]); every row has `s`, so nothing is dropped by NULL here.",
  },
  {
    name: "exists-true",
    filter: { opt: { $exists: true } },
    expected: ["f1", "f2", "f4", "f6"],
    note: "value ? key",
  },
  {
    name: "exists-false",
    filter: { opt: { $exists: false } },
    expected: ["f3", "f5"],
    note: "NOT (value ? key)",
  },
  { name: "plain-string-equality", filter: { s: "aaa" }, expected: ["f1"], note: "->> = text" },
  {
    name: "plain-boolean-equality",
    filter: { flag: true },
    expected: ["f1", "f3"],
    note: "String(true) matches the JSON text 'true'.",
  },
  {
    name: "nested-object-is-containment-not-equality",
    filter: { nested: { a: 1 } },
    expected: ["f1", "f2"],
    note: "value @> jsonb, so f1's {a:1,b:2} matches a filter of {a:1}.",
  },
];

/** Filters that generate NO condition at all, and therefore match everything. */
const FAIL_OPEN_CASES: Array<{ name: string; filter: Record<string, unknown>; note: string }> = [
  {
    name: "unknown-operator",
    filter: { n: { $regex: "a" } },
    note: "buildOperatorCondition falls through to `default: break`, returning no condition.",
  },
  {
    name: "empty-in",
    filter: { s: { $in: [] } },
    note: "The length > 0 guard skips it, so an impossible filter becomes no filter.",
  },
  {
    name: "empty-nin",
    filter: { s: { $nin: [] } },
    note: "Same guard, same result.",
  },
];

async function seedFilterCorpus(store: PostgresStore): Promise<void> {
  for (const entry of FILTER_CORPUS) {
    await store.put(FILTER_NS, entry.key, entry.value, false);
  }
}

async function keysMatching(
  store: PostgresStore,
  filter: Record<string, unknown>,
): Promise<string[]> {
  const items = await store.search(FILTER_NS, {
    filter: filter as never,
    limit: 100,
  });
  return items.map((item) => item.key).sort();
}

async function filterMatrix(context: PartyContext): Promise<Record<string, unknown>> {
  const store = makeStore(context, { index: false });

  try {
    await store.start();
    await seedFilterCorpus(store);

    const rows: Array<Record<string, unknown>> = [];
    for (const spec of FILTER_CASES) {
      const outcome = await capture(async () => await keysMatching(store, spec.filter));
      const actual = outcome.ok ? await keysMatching(store, spec.filter) : [];
      rows.push({
        name: spec.name,
        note: spec.note,
        expected: spec.expected,
        actual,
        error: outcome.error,
        matchedExpectation: outcome.ok && actual.join(",") === spec.expected.join(","),
      });
    }

    return {
      party: context.party,
      error: null,
      corpusSize: FILTER_CORPUS.length,
      cases: rows,
      total: rows.length,
      matched: rows.filter((row) => row.matchedExpectation === true).length,
    };
  } finally {
    await store.stop().catch(() => {});
  }
}

/** Filters that silently degrade to no filter at all. */
async function filterFailOpen(context: PartyContext): Promise<Record<string, unknown>> {
  const store = makeStore(context, { index: false });

  try {
    await store.start();
    await seedFilterCorpus(store);
    const everything = FILTER_CORPUS.map((entry) => entry.key).sort();

    const rows: Array<Record<string, unknown>> = [];
    for (const spec of FAIL_OPEN_CASES) {
      const outcome = await capture(async () => await keysMatching(store, spec.filter));
      const actual = outcome.ok ? await keysMatching(store, spec.filter) : [];
      rows.push({
        name: spec.name,
        note: spec.note,
        actual,
        error: outcome.error,
        // Stated as what it IS: the filter was dropped and every row came back.
        returnedEverything: actual.join(",") === everything.join(","),
        raised: !outcome.ok,
      });
    }

    // The control. Without it, "everything came back" could mean the corpus was
    // the only row set the filter could ever have returned.
    const restrictive = await keysMatching(store, { s: { $in: ["aaa"] } });

    return {
      party: context.party,
      error: null,
      corpusKeys: everything,
      cases: rows,
      allThreeReturnedEverything: rows.every((row) => row.returnedEverything === true),
      noneRaised: rows.every((row) => row.raised === false),
      restrictiveFilterStillRestricts: restrictive.join(",") === "f1",
    };
  } finally {
    await store.stop().catch(() => {});
  }
}

/**
 * Filter values whose JavaScript type the builder does not handle.
 *
 * `null` is `typeof "object"` but fails the `value !== null` guard, so it falls
 * to the string path and compares against the literal text `"null"` — which
 * `->>` never produces for a JSON null. An array falls to the same path and is
 * compared against `String([1,2])`, i.e. `"1,2"`.
 */
async function filterNullAndArrayValues(context: PartyContext): Promise<Record<string, unknown>> {
  const store = makeStore(context, { index: false });
  const ns = ["spike", "shapes"];

  try {
    await store.start();
    await store.put(ns, "has-json-null", { n: null, s: "x" }, false);
    await store.put(ns, "has-array", { tags: [1, 2], s: "y" }, false);
    await store.put(ns, "plain", { n: 5, s: "z" }, false);

    const search = async (filter: Record<string, unknown>): Promise<string[]> =>
      (await store.search(ns, { filter: filter as never, limit: 100 }))
        .map((item) => item.key)
        .sort();

    const byNull = await search({ n: null });
    const byArray = await search({ tags: [1, 2] });
    const nullExists = await search({ n: { $exists: true } });
    const arrayExists = await search({ tags: { $exists: true } });

    return {
      party: context.party,
      error: null,
      matchedByNullFilter: byNull,
      matchedByArrayFilter: byArray,
      // The rows are demonstrably present, so "matched nothing" is the filter's
      // doing rather than an empty corpus.
      rowsWithNullKeyExist: nullExists,
      rowsWithArrayKeyExist: arrayExists,
      nullFilterMatchedNothing: byNull.length === 0,
      arrayFilterMatchedNothing: byArray.length === 0,
    };
  } finally {
    await store.stop().catch(() => {});
  }
}

/**
 * A numeric operator over a key that is not numeric in every row.
 *
 * The generated condition casts `(value ->> key)::numeric` across the whole
 * scanned set, so one non-numeric row does not merely fail to match — it fails
 * the entire query.
 */
async function filterNumericCastOnMixedTypes(
  context: PartyContext,
): Promise<Record<string, unknown>> {
  const store = makeStore(context, { index: false });
  const ns = ["spike", "mixed"];

  try {
    await store.start();
    await store.put(ns, "numeric-1", { n: 1 }, false);
    await store.put(ns, "numeric-2", { n: 2 }, false);
    await store.put(ns, "textual", { n: "not-a-number" }, false);

    const numericFilter = await capture(() =>
      store.search(ns, { filter: { n: { $gt: 0 } } as never, limit: 100 }),
    );
    // The control: an equality filter on the same key does not cast, so it
    // works. That is what makes the failure specific to the numeric operators.
    const equalityFilter = await capture(() =>
      store.search(ns, { filter: { n: 1 } as never, limit: 100 }),
    );

    return {
      party: context.party,
      error: null,
      numericFilterRaised: !numericFilter.ok,
      numericFilterSqlstate: numericFilter.error?.code ?? null,
      equalityFilterSucceeded: equalityFilter.ok,
      // One unrelated row makes the whole query fail rather than being skipped.
      wholeQueryFailedNotJustTheRow: !numericFilter.ok && equalityFilter.ok,
    };
  } finally {
    await store.stop().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Slice 4: text, vector and hybrid search.

const SEARCH_NS = ["spike", "search"];
const SEARCH_CORPUS = ["alpha", "beta", "gamma", "delta"];

type RankingFixture = {
  query: string;
  corpus: string[];
  expected_order: Record<string, string[]>;
  distances: Record<string, Record<string, number>>;
};

function rankings(): RankingFixture {
  return rankingFixture() as unknown as RankingFixture;
}

/** One item per fixture vector, indexed on `title` so the embedder is exercised. */
async function seedSearchCorpus(store: PostgresStore): Promise<void> {
  for (const name of SEARCH_CORPUS) {
    await store.put(SEARCH_NS, name, { title: name }, ["title"]);
  }
}

async function orderedKeys(
  store: PostgresStore,
  options: Record<string, unknown>,
): Promise<string[]> {
  const items = await store.search(SEARCH_NS, options as never);
  return items.map((item) => item.key);
}

/**
 * One distance metric, compared to the hand-authored ordering.
 *
 * `fixtures/rankings.json` states the expected order for all three metrics and
 * says in its own notes that `<#>` returns the NEGATIVE inner product, so its
 * `inner_product` order is by TRUE inner product, highest first. That makes the
 * comparison meaningful rather than circular: the oracle was written from the
 * vectors and from pgvector's documented operators, never from this Store.
 */
async function vectorSearchByMetric(
  context: PartyContext,
  metric: "cosine" | "l2" | "inner_product",
): Promise<Record<string, unknown>> {
  const store = makeStore(context);
  const fixture = rankings();

  try {
    await store.start();
    await seedSearchCorpus(store);

    const actual = await orderedKeys(store, {
      query: fixture.query,
      mode: "vector",
      distanceMetric: metric,
      limit: 10,
    });
    const expected = fixture.expected_order[metric] ?? [];

    return {
      party: context.party,
      error: null,
      metric,
      expectedOrder: expected,
      actualOrder: actual,
      matchedAuthoredOrder: actual.join(",") === expected.join(","),
      // Recorded so an inverted ranking is distinguishable from an arbitrary
      // one: reversal is a sign convention, noise is a broken query.
      isExactlyReversed: actual.join(",") === [...expected].reverse().join(","),
      returnedTheWholeCorpus: actual.length === SEARCH_CORPUS.length,
    };
  } finally {
    await store.stop().catch(() => {});
  }
}

/**
 * The same `similarityThreshold` number through all three metrics.
 *
 * Cosine negates it into a distance bound, L2 uses it as a raw distance bound,
 * and inner product compares it against a value that is always negative. One
 * parameter, three meanings.
 */
async function vectorSearchThresholds(context: PartyContext): Promise<Record<string, unknown>> {
  const store = makeStore(context);
  const fixture = rankings();

  try {
    await store.start();
    await seedSearchCorpus(store);

    const at = async (
      metric: "cosine" | "l2" | "inner_product",
      similarityThreshold: number,
    ): Promise<string[]> =>
      await orderedKeys(store, {
        query: fixture.query,
        mode: "vector",
        distanceMetric: metric,
        similarityThreshold,
        limit: 10,
      });

    const cosine = await at("cosine", 0.9);
    const l2 = await at("l2", 1);
    const innerProduct = await at("inner_product", 0.5);
    const unthresholded = await at("cosine", 0);

    return {
      party: context.party,
      error: null,
      cosineAtNinetyPercent: cosine,
      l2AtOne: l2,
      innerProductAtAHalf: innerProduct,
      unthresholdedCosine: unthresholded,
      // Cosine is the one that behaves as "similarity at least this".
      cosineKeptTheTwoNearestItems: cosine.join(",") === "alpha,beta",
      // L2 treats the same number as a DISTANCE ceiling, so it selects a
      // different pair from the same corpus and query.
      l2SelectedADifferentSet: l2.join(",") !== cosine.join(","),
      // The comparison is against a negative quantity, so nothing can satisfy it.
      innerProductExcludedEverything: innerProduct.length === 0,
      // Anti-vacuity: without a threshold the same query returns the corpus.
      unthresholdedReturnedTheWholeCorpus: unthresholded.length === SEARCH_CORPUS.length,
    };
  } finally {
    await store.stop().catch(() => {});
  }
}

/** An item written with indexing disabled is invisible to vector search. */
async function vectorSearchUnindexed(context: PartyContext): Promise<Record<string, unknown>> {
  const store = makeStore(context);
  const fixture = rankings();

  try {
    await store.start();
    await seedSearchCorpus(store);
    // Same shape, same namespace, indexing suppressed.
    await store.put(SEARCH_NS, "unindexed", { title: "alpha" }, false);

    const vector = await orderedKeys(store, {
      query: fixture.query,
      mode: "vector",
      limit: 10,
    });
    const text = await orderedKeys(store, { query: "alpha", mode: "text", limit: 10 });
    const projection = await projectStore(inspectPoolless());

    return {
      party: context.party,
      error: null,
      vectorKeys: vector.sort(),
      textKeys: text.sort(),
      // The store/store_vectors join is an INNER join, so an item with no vector
      // row cannot appear however well it would have matched.
      unindexedItemMissingFromVectorSearch: !vector.includes("unindexed"),
      // The same item IS reachable by text, so it exists and is readable — the
      // absence above is the index, not the write.
      unindexedItemPresentInTextSearch: text.includes("unindexed"),
      indexedItemsStillFound: vector.length === SEARCH_CORPUS.length,
      projectedUnindexedItems: projection.unindexedItems.map((row) => row.key),
    };
  } finally {
    await store.stop().catch(() => {});
  }

  // A local helper so the projection reads the same database without another
  // long-lived pool being threaded through the signature.
  function inspectPoolless(): Db {
    return inspectPool(context);
  }
}

/** A query whose fixture vector is the wrong width. */
async function vectorSearchDimensionMismatch(
  context: PartyContext,
): Promise<Record<string, unknown>> {
  const store = makeStore(context);

  try {
    await store.start();
    await seedSearchCorpus(store);

    // `wrongdim` is a deliberately 9-dimensional fixture vector against an
    // 8-dimensional column.
    const mismatch = await capture(() =>
      store.search(SEARCH_NS, { query: "wrongdim", mode: "vector", limit: 10 } as never),
    );
    const control = await capture(() =>
      store.search(SEARCH_NS, { query: rankings().query, mode: "vector", limit: 10 } as never),
    );

    return {
      party: context.party,
      error: null,
      mismatchRejected: !mismatch.ok,
      mismatchError: mismatch.error,
      // Guarded in JavaScript before any SQL runs, so it is loud but carries no
      // SQLSTATE — the same shape as the closed-Store failure in d03.
      mismatchSqlstate: mismatch.error?.code ?? null,
      controlSucceeded: control.ok,
    };
  } finally {
    await store.stop().catch(() => {});
  }
}

/**
 * Hybrid weighting.
 *
 * The corpus gains an item whose INDEXED text and whose stored text disagree:
 * it is indexed on `title: "alpha"` but carries `note: "gamma"`, and text search
 * reads the whole serialized value. Querying `gamma` therefore ranks it last by
 * vector and first-or-second by text, so moving `vectorWeight` has to move it.
 */
async function hybridSearchWeights(context: PartyContext): Promise<Record<string, unknown>> {
  const store = makeStore(context);

  try {
    await store.start();
    await seedSearchCorpus(store);
    await store.put(SEARCH_NS, "mixed", { title: "alpha", note: "gamma" }, ["title"]);

    const atWeight = async (vectorWeight: number): Promise<string[]> =>
      await orderedKeys(store, { query: "gamma", mode: "hybrid", vectorWeight, limit: 10 });

    const vectorOnly = await atWeight(1);
    const textOnly = await atWeight(0);
    const balanced = await atWeight(0.7);

    const positionOf = (keys: string[], key: string): number => keys.indexOf(key);

    return {
      party: context.party,
      error: null,
      atVectorWeightOne: vectorOnly,
      atVectorWeightZero: textOnly,
      atDefaultWeight: balanced,
      // By vector alone the mixed item carries alpha's embedding, which is the
      // furthest from the gamma query, so it sinks.
      mixedRanksLastByVector: positionOf(vectorOnly, "mixed") === vectorOnly.length - 1,
      // By text alone it matches the query term, so it rises. Asserted as "top
      // two" because it ties with gamma on ts_rank and the tie order is not
      // something this case is measuring.
      mixedRanksInTheTopTwoByText: positionOf(textOnly, "mixed") >= 0 &&
        positionOf(textOnly, "mixed") <= 1,
      weightChangedTheRanking: vectorOnly.join(",") !== textOnly.join(","),
      vectorOnlyMatchedTheCosineOrder:
        vectorOnly.filter((key) => key !== "mixed").join(",") === "gamma,delta,beta,alpha",
    };
  } finally {
    await store.stop().catch(() => {});
  }
}

/**
 * Text search reads `value::text`, so the serialized JSON — including its KEY
 * names — is what gets indexed, and a wildcard-shaped query reaches an ILIKE
 * fallback rather than being treated as a literal.
 */
async function textSearchSemantics(context: PartyContext): Promise<Record<string, unknown>> {
  const store = makeStore(context, { index: false });

  try {
    await store.start();
    for (const name of SEARCH_CORPUS) {
      await store.put(SEARCH_NS, name, { title: name }, false);
    }

    const byValue = await orderedKeys(store, { query: "alpha", mode: "text", limit: 10 });
    // `title` is a field NAME, never a value.
    const byKeyName = await orderedKeys(store, { query: "title", mode: "text", limit: 10 });
    const byWildcard = await orderedKeys(store, { query: "%", mode: "text", limit: 10 });
    const byAbsentTerm = await orderedKeys(store, { query: "zzzz", mode: "text", limit: 10 });

    return {
      party: context.party,
      error: null,
      byValue: byValue.sort(),
      byKeyName: byKeyName.sort(),
      byWildcard: byWildcard.sort(),
      byAbsentTerm,
      matchedOnValue: byValue.join(",") === "alpha",
      // Every item shares the field name, so a query for it returns everything.
      matchedOnJsonKeyName: byKeyName.length === SEARCH_CORPUS.length,
      // plainto_tsquery('%') is empty, but the OR'd `value::text ILIKE '%%%'`
      // matches every row.
      wildcardQueryMatchedEverything: byWildcard.length === SEARCH_CORPUS.length,
      // Anti-vacuity: a term that appears nowhere returns nothing, so the two
      // "matched everything" results are not simply an unfiltered query.
      absentTermMatchedNothing: byAbsentTerm.length === 0,
    };
  } finally {
    await store.stop().catch(() => {});
  }
}

/**
 * `search()` against `batch()`.
 *
 * A batched SearchOperation carries only namespace, filter, query, limit and
 * offset — there is no mode, no distanceMetric and no threshold — and
 * `executeSearch` routes a query on an indexed Store straight to
 * `executeVectorSearch`, which is cosine and nothing else. So options that
 * change the answer through the convenience path cannot be expressed at all
 * through the batch path.
 */
async function searchConvenienceVersusBatch(
  context: PartyContext,
): Promise<Record<string, unknown>> {
  const store = makeStore(context);
  const fixture = rankings();

  try {
    await store.start();
    await seedSearchCorpus(store);

    const convenienceCosine = await orderedKeys(store, {
      query: fixture.query,
      mode: "vector",
      distanceMetric: "cosine",
      limit: 10,
    });
    const convenienceL2 = await orderedKeys(store, {
      query: fixture.query,
      mode: "vector",
      distanceMetric: "l2",
      limit: 10,
    });

    const batched = (await store.batch([
      { namespacePrefix: SEARCH_NS, query: fixture.query, limit: 10 },
    ] as never)) as unknown[];
    const batchedKeys = ((batched[0] as Array<{ key: string }>) ?? []).map((item) => item.key);

    return {
      party: context.party,
      error: null,
      convenienceCosine,
      convenienceL2,
      batched: batchedKeys,
      // The batch path produces the cosine ordering...
      batchMatchedTheCosineOrder: batchedKeys.join(",") === convenienceCosine.join(","),
      // ...and cannot produce the L2 one, because the option does not exist on
      // a batched search operation.
      batchCannotExpressTheL2Ordering: batchedKeys.join(",") !== convenienceL2.join(","),
      // Anti-vacuity for the line above: the two metrics really do differ here.
      theTwoMetricsOrderDifferently: convenienceCosine.join(",") !== convenienceL2.join(","),
    };
  } finally {
    await store.stop().catch(() => {});
  }
}

// ---------------------------------------------------------------------------

export async function runFamilyDParty(context: PartyContext): Promise<Record<string, unknown>> {
  switch (context.caseId) {
    case "d01-store-explicit-start-baseline":
      return await lifecycleCycle(context, { explicitStart: true });

    case "d02-store-lazy-first-operation":
      return await lifecycleCycle(context, { explicitStart: false });

    case "d03-store-use-after-stop":
      return await useAfterStop(context);

    case "d04-store-ensure-tables-false-cold":
    case "d05-store-ensure-tables-false-migrated":
      return await ensureTablesFalse(context);

    case "d06-put-failure-leaves-committed-row":
      return await putFailureLeavesRow(context, { failing: true });

    case "d07-put-success-indexes-control":
      return await putFailureLeavesRow(context, { failing: false });

    case "d08-concurrent-put-same-key":
      return await concurrentPut(context);

    case "d09-concurrent-put-and-delete":
      return await concurrentPutAndDelete(context);

    case "d10-value-serialization-boundaries":
      return await serializationBoundaries(context);

    case "d11-schema-isolation-two-stores":
      return await schemaIsolation(context);

    case "d12-vector-extension-placement":
      return await vectorExtensionPlacement(context);

    case "d13-index-metric-config-change":
      return await indexMetricChange(context);

    case "d14-batch-read-your-writes":
      return await batchReadYourWrites(context);

    case "d15-batch-partial-commit-on-failure":
      return await batchPartialCommit(context);

    case "d16-convenience-path-error-isolation-control":
      return await conveniencePathIsolation(context);

    case "d17-async-batched-store-rejection-fanout":
      return await asyncBatchedFanout(context);

    case "d18-batch-search-nested-acquisition":
      return await batchSearchNesting(context, { max: 1, indexed: false });

    case "d19-batch-search-nested-acquisition-max2-control":
      return await batchSearchNesting(context, { max: 2, indexed: false });

    case "d20-batch-search-indexed-shares-client-control":
      return await batchSearchNesting(context, { max: 1, indexed: true });

    case "d21-store-pool-max1-serialization":
      return await storePoolSerialization(context);

    case "d22-ttl-zero-and-negative":
      return await ttlZeroAndNegative(context);

    case "d23-ttl-refresh-on-read-uses-the-default":
      return await ttlRefreshOnRead(context, { defaultTtl: 1 });

    case "d24-ttl-refresh-without-a-default-control":
      return await ttlRefreshOnRead(context, { defaultTtl: null });

    case "d25-manual-sweep-and-statistics":
      return await manualSweep(context);

    case "d26-concurrent-sweepers":
      return await concurrentSweeper(context);

    case "d27-namespace-validation-matrix":
      return await namespaceValidation(context);

    case "d28-namespace-delimiter-collision":
      return await namespaceDelimiterCollision(context);

    case "d29-namespace-prefix-boundary":
      return await namespacePrefixBoundary(context);

    case "d30-list-namespaces-maxdepth-after-limit":
      return await namespaceMaxDepthAfterLimit(context);

    case "d31-list-namespaces-skips-validation":
      return await namespaceValidationAsymmetry(context);

    case "d32-list-namespaces-pagination-control":
      return await namespacePagination(context);

    case "d33-filter-matrix":
      return await filterMatrix(context);

    case "d34-filter-fail-open":
      return await filterFailOpen(context);

    case "d35-filter-null-and-array-values":
      return await filterNullAndArrayValues(context);

    case "d36-filter-numeric-cast-on-mixed-types":
      return await filterNumericCastOnMixedTypes(context);

    case "d37-vector-search-cosine":
      return await vectorSearchByMetric(context, "cosine");

    case "d38-vector-search-l2":
      return await vectorSearchByMetric(context, "l2");

    case "d39-vector-search-inner-product":
      return await vectorSearchByMetric(context, "inner_product");

    case "d40-vector-search-thresholds":
      return await vectorSearchThresholds(context);

    case "d41-vector-search-unindexed-item":
      return await vectorSearchUnindexed(context);

    case "d42-vector-search-dimension-mismatch":
      return await vectorSearchDimensionMismatch(context);

    case "d43-hybrid-search-weights":
      return await hybridSearchWeights(context);

    case "d44-text-search-semantics":
      return await textSearchSemantics(context);

    case "d45-search-convenience-versus-batch":
      return await searchConvenienceVersusBatch(context);

    default:
      throw new Error(`family D has no participant for case ${context.caseId}`);
  }
}

/**
 * The seed both concurrent cases act on.
 *
 * It is written INDEXED and with a marker belonging to neither writer, so the
 * racers are updating an existing item rather than creating one — which is what
 * puts the vector DELETE-then-INSERT on the contended path — and so a surviving
 * seed value is distinguishable from either writer having won.
 */
export async function prepareFamilyD(caseId: string): Promise<Record<string, unknown>> {
  const context: PartyContext = { caseId, party: -1, member: "prepare" };
  const inspect = inspectPool(context);

  try {
    if (caseId === "d08-concurrent-put-same-key" || caseId === "d09-concurrent-put-and-delete") {
      const store = makeStore(context);
      try {
        await store.put(
          NS,
          KEY,
          { title: STORE_CONFLICT.seedText, marker: STORE_CONFLICT.seedMarker },
          ["title"],
        );
        const projection = await projectStore(inspect);
        return {
          caseId,
          prepared: true,
          namespace: NS.join(":"),
          key: KEY,
          seededItems: projection.stats.total,
          seededVectors: projection.vectors.length,
        };
      } finally {
        await store.stop().catch(() => {});
      }
    }

    // The nesting cases need something for the search to find, so a zero-row
    // result cannot be mistaken for the query never having run. The indexed
    // variant seeds through a Store WITH an index config, because d20 searches
    // the vector path and needs vectors present.
    if (
      caseId === "d18-batch-search-nested-acquisition" ||
      caseId === "d19-batch-search-nested-acquisition-max2-control" ||
      caseId === "d20-batch-search-indexed-shares-client-control"
    ) {
      const indexed = caseId === "d20-batch-search-indexed-shares-client-control";
      const store = makeStore(context, indexed ? {} : { index: false });
      try {
        await store.put(NS, "search-1", { title: "alpha", marker: "searchable" }, indexed ? ["title"] : false);
        const projection = await projectStore(inspect);
        return {
          caseId,
          prepared: true,
          indexed,
          seededItems: projection.stats.total,
          seededVectors: projection.vectors.length,
        };
      } finally {
        await store.stop().catch(() => {});
      }
    }

    // Two sweepers need a fixed number of already-expired rows to divide, and a
    // live row that must survive both of them.
    if (caseId === "d26-concurrent-sweepers") {
      const store = makeStore(context, { index: false });
      try {
        for (let index = 0; index < 6; index += 1) {
          await store.put(NS, `dead-${index}`, { marker: "dead" }, false, { ttl: -1 });
        }
        await store.put(NS, "live-0", { marker: "live" }, false, { ttl: 60 });
        const projection = await projectStore(inspect);
        return {
          caseId,
          prepared: true,
          seededItems: projection.stats.total,
          seededExpired: projection.stats.expired,
        };
      } finally {
        await store.stop().catch(() => {});
      }
    }

    return { caseId, prepared: false };
  } finally {
    await inspect.close().catch(() => {});
  }
}

export { NS as STORE_NAMESPACE, KEY as STORE_KEY, STORE_CONFLICT, SERIALIZATION_CASES };
