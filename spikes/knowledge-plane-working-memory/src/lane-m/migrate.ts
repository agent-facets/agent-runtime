// Schema setup for Lane M's projection and the shared execution plane.
//
// One migrator, elected through a session-level advisory lock held on a
// dedicated connection. Spike 06 measured that unguarded concurrent setup races
// and fails across a bounded set of SQLSTATEs, so the safeguard is applied here
// rather than re-litigated — and the unguarded form stays measurable as its own
// paired case.
//
// The lock is NOT taken through the application pool. `pg_advisory_lock` is
// owned by a session, and a pool may hand the DDL to a different backend than
// the one holding the lock, or close the lock-holding backend on idle timeout.
// Checking a client out and holding it is the difference between a lock and a
// coincidence.
//
// Lazy setup is disabled everywhere: a migration that runs inside the first
// operation makes "the schema existed" and "the operation succeeded" the same
// observation, which is exactly what the first-setup race needs to separate.

import {
  ADVISORY_CLASS_MIGRATION,
  EXECUTION_SCHEMA,
  PROBE_SCHEMA,
  PROJECTION_SCHEMA,
  migrationLockKey,
} from "../contract.ts";
import type { Db } from "./pg.ts";

/** Vector width is the frozen corpus vocabulary, not a tunable. */
export const EMBEDDING_DIMENSIONS = 12;

const DDL: string[] = [
  `CREATE EXTENSION IF NOT EXISTS vector`,

  `CREATE SCHEMA IF NOT EXISTS ${PROJECTION_SCHEMA}`,
  `CREATE SCHEMA IF NOT EXISTS ${EXECUTION_SCHEMA}`,
  `CREATE SCHEMA IF NOT EXISTS ${PROBE_SCHEMA}`,

  // --- Lane M's derived projection ----------------------------------------
  // Rebuildable from canonical Markdown alone. Never authoritative: every
  // column here has a canonical origin, and `is_head` is recomputed rather than
  // maintained, because a maintained flag drifts and a recomputed one cannot.
  `CREATE TABLE IF NOT EXISTS ${PROJECTION_SCHEMA}.claim (
     claim_id        text        NOT NULL,
     revision        integer     NOT NULL,
     subject         text        NOT NULL,
     subject_resolved text       NOT NULL,
     predicate       text        NOT NULL,
     value           text        NOT NULL,
     scope           text        NOT NULL,
     valid_from      timestamptz,
     valid_to        timestamptz,
     asserted_at     timestamptz NOT NULL,
     asserted_until  timestamptz,
     closure_reason  text,
     belief          text        NOT NULL,
     canon           boolean     NOT NULL,
     origin_kind     text        NOT NULL,
     authority       text        NOT NULL,
     sensitivity     text        NOT NULL,
     visibility      text        NOT NULL,
     redaction_state text        NOT NULL,
     is_head         boolean     NOT NULL,
     PRIMARY KEY (claim_id, revision)
   )`,
  `CREATE TABLE IF NOT EXISTS ${PROJECTION_SCHEMA}.edge (
     relationship_id text        NOT NULL,
     revision        integer     NOT NULL,
     from_id         text        NOT NULL,
     from_resolved   text        NOT NULL,
     rel_type        text        NOT NULL,
     to_id           text        NOT NULL,
     to_resolved     text        NOT NULL,
     valid_from      timestamptz,
     valid_to        timestamptz,
     asserted_at     timestamptz NOT NULL,
     asserted_until  timestamptz,
     closure_reason  text,
     belief          text        NOT NULL,
     is_head         boolean     NOT NULL,
     PRIMARY KEY (relationship_id, revision)
   )`,
  // `excerpt_hash` and never `excerpt`: the source plane owns its own text, and
  // a projection that copied it would make this store a second, unowned copy of
  // a document with its own retention and disclosure obligations.
  `CREATE TABLE IF NOT EXISTS ${PROJECTION_SCHEMA}.evidence (
     evidence_id     text PRIMARY KEY,
     source_ref_id   text NOT NULL,
     locator         text NOT NULL,
     excerpt_hash    text NOT NULL,
     strength        text NOT NULL,
     sensitivity     text NOT NULL,
     redaction_state text NOT NULL,
     source_resolves boolean NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS ${PROJECTION_SCHEMA}.chunk (
     chunk_id  text PRIMARY KEY,
     ref_kind  text NOT NULL,
     ref_id    text NOT NULL,
     revision  integer NOT NULL,
     text      text NOT NULL,
     tsv       tsvector,
     embedding vector(${EMBEDDING_DIMENSIONS})
   )`,
  // One row per scope. `projection_watermark` is the canonical generation this
  // projection was built from, so staleness is a comparison against canonical
  // state rather than a self-assigned age.
  `CREATE TABLE IF NOT EXISTS ${PROJECTION_SCHEMA}.freshness (
     scope                text PRIMARY KEY,
     canonical_point      text NOT NULL,
     projection_watermark text NOT NULL,
     built_at_tick        integer NOT NULL,
     rebuild_pending      boolean NOT NULL,
     degraded_fields      text[]  NOT NULL
   )`,

  // --- The execution plane, Postgres in BOTH lanes -------------------------
  `CREATE TABLE IF NOT EXISTS ${EXECUTION_SCHEMA}.work_item (
     work_item_id text PRIMARY KEY,
     title        text NOT NULL,
     intent       text NOT NULL,
     status       text NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS ${EXECUTION_SCHEMA}.run_attempt (
     run_id       text PRIMARY KEY,
     work_item_id text NOT NULL,
     ordinal      integer NOT NULL,
     actor_id     text NOT NULL,
     outcome      text NOT NULL,
     carried_constraints text[] NOT NULL DEFAULT '{}'
   )`,
  // The ledger is canonical for execution and is deliberately NOT rebuildable
  // from knowledge: a replayed command must return its stored receipt verbatim,
  // and a reconstructed receipt would make replay indistinguishable from a
  // second execution.
  `CREATE TABLE IF NOT EXISTS ${EXECUTION_SCHEMA}.idempotency (
     key          text PRIMARY KEY,
     key_scope    text NOT NULL,
     command      text NOT NULL,
     request_hash text NOT NULL,
     response     jsonb NOT NULL,
     committed_tick integer NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS ${EXECUTION_SCHEMA}.mutation_intent (
     intent_id  text PRIMARY KEY,
     command    text NOT NULL,
     files      text[] NOT NULL,
     ops        jsonb NOT NULL,
     state      text NOT NULL,
     opened_tick integer NOT NULL
   )`,

  // --- The probe schema ----------------------------------------------------
  // Separate from both the execution plane and the projection on purpose: an
  // observation the subject could have written is not an independent witness.
  `CREATE TABLE IF NOT EXISTS ${PROBE_SCHEMA}.event (
     id         bigserial PRIMARY KEY,
     case_id    text NOT NULL,
     member     text NOT NULL,
     kind       text NOT NULL,
     detail     jsonb NOT NULL,
     observed_at timestamptz NOT NULL DEFAULT clock_timestamp()
   )`,
  // The barrier. A party's arrival is a COMMITTED ROW, and release fires when
  // the declared number of rows exists — never after an interval. A sleep before
  // a release is the most reliable way to produce a race that cannot be
  // reproduced, and an arrival that is not durable cannot prove overlap
  // afterwards.
  `CREATE TABLE IF NOT EXISTS ${PROBE_SCHEMA}.barrier_arrival (
     case_id     text NOT NULL,
     name        text NOT NULL,
     member      text NOT NULL,
     nonce       text NOT NULL,
     arrived_at  timestamptz NOT NULL DEFAULT clock_timestamp(),
     PRIMARY KEY (case_id, name, member)
   )`,
];

export type MigrationOutcome = {
  lockKey: { classid: number; objid: number };
  /** True when another session already held the lock: the race actually happened. */
  observedContention: boolean;
  performedDdl: boolean;
  statements: number;
  /** `false` means this session did not hold what it thought it held: a fault. */
  unlockReturnedTrue: boolean;
  advisoryLocksStillGrantedToThisBackend: number;
};

/**
 * Elect a single migrator and run the DDL behind its lock.
 *
 * `pg_try_advisory_lock` first, so contention is *observed and reported* rather
 * than silently waited out; only then does it block. A safeguard that hides the
 * contention it prevents cannot be shown to have prevented anything.
 */
export async function migrate(db: Db): Promise<MigrationOutcome> {
  const key = migrationLockKey(PROJECTION_SCHEMA);
  const client = await db.pool.connect();
  try {
    const tried = await client.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_lock($1, $2) AS acquired",
      [ADVISORY_CLASS_MIGRATION, key],
    );
    const observedContention = tried.rows[0]?.acquired !== true;
    if (observedContention) {
      await client.query("SELECT pg_advisory_lock($1, $2)", [ADVISORY_CLASS_MIGRATION, key]);
    }

    const before = await relationCount(client);
    for (const statement of DDL) {
      await client.query(statement);
    }
    const after = await relationCount(client);

    const unlocked = await client.query<{ ok: boolean }>(
      "SELECT pg_advisory_unlock($1, $2) AS ok",
      [ADVISORY_CLASS_MIGRATION, key],
    );
    // Scoped to THIS backend. A count across all sessions is meaningless while
    // other racers are still holding their own locks.
    const held = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM pg_locks
        WHERE locktype = 'advisory' AND classid = $1 AND objid = $2
          AND granted AND pid = pg_backend_pid()`,
      [ADVISORY_CLASS_MIGRATION, key >>> 0],
    );

    return {
      lockKey: { classid: ADVISORY_CLASS_MIGRATION, objid: key },
      observedContention,
      performedDdl: after > before,
      statements: DDL.length,
      unlockReturnedTrue: unlocked.rows[0]?.ok === true,
      advisoryLocksStillGrantedToThisBackend: Number(held.rows[0]?.count ?? "-1"),
    };
  } finally {
    client.release();
  }
}

async function relationCount(client: {
  query: (sql: string, values?: unknown[]) => Promise<{ rows: Array<{ count: string }> }>;
}): Promise<number> {
  const { rows } = await client.query(
    `SELECT count(*)::text AS count FROM information_schema.tables WHERE table_schema = ANY($1)`,
    [[PROJECTION_SCHEMA, EXECUTION_SCHEMA, PROBE_SCHEMA]],
  );
  return Number(rows[0]?.count ?? "0");
}

/** Drop only the DERIVED schema. Canonical state and the ledger are untouched. */
export async function dropProjection(db: Db): Promise<void> {
  await db.pool.query(`DROP SCHEMA IF EXISTS ${PROJECTION_SCHEMA} CASCADE`);
}
