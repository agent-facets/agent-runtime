// Raw-table observation of the checkpointer schema.
//
// Everything here reads `lg_checkpoints` directly with SQL rather than through
// `getState()` / `getStateHistory()`. Asking the library under test to attest to
// its own lineage is circular: a checkpointer that mis-parents or silently forks
// would report the same wrong answer through the API that shares the bug.

import type { Db } from "../db.ts";
import { CHECKPOINT_SCHEMA, PROBE_SCHEMA } from "../contract.ts";

export type CheckpointRow = {
  checkpoint_ns: string;
  checkpoint_id: string;
  parent_checkpoint_id: string | null;
  source: string | null;
  step: number | null;
  xmin: string;
  parents: Record<string, string> | null;
};

export type WriteRow = {
  checkpoint_ns: string;
  checkpoint_id: string;
  task_id: string;
  idx: number;
  channel: string;
  type: string | null;
  blob_len: number;
  blob_md5: string | null;
  xmin: string;
};

export type BlobRow = {
  checkpoint_ns: string;
  channel: string;
  version: string;
  type: string | null;
  blob_len: number;
  blob_md5: string | null;
  xmin: string;
};

export type EventRow = {
  id: string;
  case_id: string;
  party: number;
  role: string;
  process_nonce: string;
  node: string;
  phase: string;
  detail: Record<string, unknown>;
  backend_pid: number;
  txid: string;
};

export type InterruptRow = {
  checkpoint_ns: string;
  checkpoint_id: string;
  task_id: string;
  payload: string;
};

export type MigrationRow = { v: number };

export type Projection = {
  checkpoints: CheckpointRow[];
  writes: WriteRow[];
  blobs: BlobRow[];
  interrupts: InterruptRow[];
  migrations: MigrationRow[];
};

export async function project(db: Db, threadId: string): Promise<Projection> {
  const checkpoints = await db.pool.query<CheckpointRow>(
    `SELECT checkpoint_ns,
            checkpoint_id,
            parent_checkpoint_id,
            metadata ->> 'source'      AS source,
            (metadata ->> 'step')::int AS step,
            xmin::text                 AS xmin,
            metadata -> 'parents'      AS parents
       FROM ${CHECKPOINT_SCHEMA}.checkpoints
      WHERE thread_id = $1
      ORDER BY checkpoint_ns, checkpoint_id`,
    [threadId],
  );

  const writes = await db.pool.query<WriteRow>(
    `SELECT checkpoint_ns, checkpoint_id, task_id, idx, channel, type,
            COALESCE(octet_length(blob), 0) AS blob_len,
            md5(COALESCE(blob, ''::bytea))  AS blob_md5,
            xmin::text                      AS xmin
       FROM ${CHECKPOINT_SCHEMA}.checkpoint_writes
      WHERE thread_id = $1
      ORDER BY checkpoint_ns, checkpoint_id, task_id, idx`,
    [threadId],
  );

  // `version` is a TEXT column holding an integer. Ordering it as text puts "10"
  // before "2", which silently reshuffles the projection once a thread passes
  // nine supersteps.
  const blobs = await db.pool.query<BlobRow>(
    `SELECT checkpoint_ns, channel, version, type,
            COALESCE(octet_length(blob), 0) AS blob_len,
            md5(COALESCE(blob, ''::bytea))  AS blob_md5,
            xmin::text                      AS xmin
       FROM ${CHECKPOINT_SCHEMA}.checkpoint_blobs
      WHERE thread_id = $1
      ORDER BY checkpoint_ns, channel,
               CASE WHEN version ~ '^[0-9]+$' THEN version::numeric END NULLS LAST,
               version`,
    [threadId],
  );

  const interrupts = await db.pool.query<InterruptRow>(
    `SELECT checkpoint_ns, checkpoint_id, task_id,
            convert_from(blob, 'UTF8') AS payload
       FROM ${CHECKPOINT_SCHEMA}.checkpoint_writes
      WHERE thread_id = $1 AND channel = '__interrupt__'
      ORDER BY checkpoint_ns, checkpoint_id, task_id, idx`,
    [threadId],
  );

  const migrations = await migrationLedger(db);

  return {
    checkpoints: checkpoints.rows,
    writes: writes.rows,
    blobs: blobs.rows,
    interrupts: interrupts.rows,
    migrations,
  };
}

/** Absent relation is a real state in family A, so 42P01 becomes `null`, not an error. */
export async function migrationLedger(db: Db): Promise<MigrationRow[]> {
  try {
    const { rows } = await db.pool.query<MigrationRow>(
      `SELECT v FROM ${CHECKPOINT_SCHEMA}.checkpoint_migrations ORDER BY v`,
    );
    return rows;
  } catch (error) {
    if ((error as { code?: string }).code === "42P01") return [];
    throw error;
  }
}

export async function events(db: Db, caseId: string): Promise<EventRow[]> {
  // `ORDER BY e.id` is qualified deliberately: an unqualified `ORDER BY id`
  // binds to the `id::text` OUTPUT column and sorts lexicographically, putting
  // event 10 before event 2 and scrambling the causal order of the trace.
  const { rows } = await db.pool.query<EventRow>(
    `SELECT e.id::text AS id, e.case_id, e.party, e.role,
            e.process_nonce::text AS process_nonce,
            e.node, e.phase, e.detail, e.backend_pid, e.txid::text AS txid
       FROM ${PROBE_SCHEMA}.event e
      WHERE e.case_id = $1
      ORDER BY e.id`,
    [caseId],
  );
  return rows;
}

export function namespaces(projection: Projection): string[] {
  return [...new Set(projection.checkpoints.map((row) => row.checkpoint_ns))].sort();
}

/**
 * The head of one namespace's chain, derived structurally: the row no sibling in
 * the same namespace claims as a parent. Id ordering happens to work for the
 * pinned release because ids are time-sortable UUIDv6, but that is an assumption
 * about id encoding, not about lineage. More than one leaf is a fork and is
 * reported rather than hidden behind a null.
 */
export function headOf(projection: Projection, ns: string): CheckpointRow | null {
  const rows = projection.checkpoints.filter((row) => row.checkpoint_ns === ns);
  if (rows.length === 0) return null;
  const claimed = new Set(
    rows.map((row) => row.parent_checkpoint_id).filter((id): id is string => id !== null),
  );
  const leaves = rows.filter((row) => !claimed.has(row.checkpoint_id));
  return leaves.length === 1 ? leaves[0]! : (rows.at(-1) ?? null);
}

export function leavesOf(projection: Projection, ns: string): CheckpointRow[] {
  const rows = projection.checkpoints.filter((row) => row.checkpoint_ns === ns);
  const claimed = new Set(
    rows.map((row) => row.parent_checkpoint_id).filter((id): id is string => id !== null),
  );
  return rows.filter((row) => !claimed.has(row.checkpoint_id));
}

/**
 * One round trip, so a reader can sample often enough to actually overlap the
 * writer. The full `project()` + `reachability()` pair is ten statements and
 * yields only a couple of samples against a fast writer, which makes
 * "no sample saw a torn state" nearly vacuous.
 *
 * The stranded-reference test is the same negated INNER join the loader uses,
 * so "referenced" continues to mean "readable".
 */
export async function sampleConsistency(
  db: Db,
  threadId: string,
): Promise<{ checkpoints: number; stranded: number; broken: number }> {
  const { rows } = await db.pool.query<{ checkpoints: number; stranded: number; broken: number }>(
    `SELECT (SELECT count(*)::int FROM ${CHECKPOINT_SCHEMA}.checkpoints WHERE thread_id = $1)
              AS checkpoints,
            (SELECT count(*)::int
               FROM ${CHECKPOINT_SCHEMA}.checkpoints c
               CROSS JOIN LATERAL jsonb_each_text(c.checkpoint -> 'channel_versions') v
               LEFT JOIN ${CHECKPOINT_SCHEMA}.checkpoint_blobs b
                      ON b.thread_id     = c.thread_id
                     AND b.checkpoint_ns = c.checkpoint_ns
                     AND b.channel       = v.key
                     AND b.version       = v.value
              WHERE c.thread_id = $1 AND b.channel IS NULL)
              AS stranded,
            (SELECT count(*)::int
               FROM ${CHECKPOINT_SCHEMA}.checkpoints c
               LEFT JOIN ${CHECKPOINT_SCHEMA}.checkpoints p
                      ON p.thread_id     = c.thread_id
                     AND p.checkpoint_ns = c.checkpoint_ns
                     AND p.checkpoint_id = c.parent_checkpoint_id
              WHERE c.thread_id = $1
                AND c.parent_checkpoint_id IS NOT NULL
                AND p.checkpoint_id IS NULL)
              AS broken`,
    [threadId],
  );
  return rows[0] ?? { checkpoints: 0, stranded: 0, broken: 0 };
}

export type OwnedRow = {
  key: string;
  /** Which known candidate payload these bytes decode to, or `unknown`. */
  owner: string;
  bytes: number;
};

export type ConflictWitness = {
  checkpoints: Array<{ checkpoint_id: string; writer: string | null; parent: string | null }>;
  blobs: OwnedRow[];
  writes: OwnedRow[];
};

/**
 * Who owns the stored bytes.
 *
 * Every conflict case writes one of a small set of literal candidate payloads,
 * so "first-writer-wins" is settled by decoding the stored row and naming which
 * candidate it is. Only the LABEL leaves this function — the decoded bytes never
 * reach evidence, which keeps the raw-payload sanitisation rule intact while
 * still answering the question directly from the table.
 *
 * `encode(blob,'base64')` rather than `convert_from(blob,'UTF8')` on purpose:
 * the latter raises on any row that is not valid UTF-8, which would turn an
 * unexpected payload into an error instead of an `unknown` owner.
 */
export async function conflictWitness(
  db: Db,
  threadId: string,
  candidates: Record<string, string>,
): Promise<ConflictWitness> {
  const label = (encoded: string | null): string => {
    if (encoded === null) return "absent";
    const text = Buffer.from(encoded, "base64").toString("utf8");
    for (const [name, candidate] of Object.entries(candidates)) {
      if (text.includes(candidate)) return name;
    }
    return "unknown";
  };

  const checkpoints = await db.pool.query<{
    checkpoint_id: string;
    writer: string | null;
    parent: string | null;
  }>(
    `SELECT checkpoint_id,
            metadata ->> 'writer'  AS writer,
            parent_checkpoint_id   AS parent
       FROM ${CHECKPOINT_SCHEMA}.checkpoints
      WHERE thread_id = $1
      ORDER BY checkpoint_id`,
    [threadId],
  );

  const blobs = await db.pool.query<{ key: string; encoded: string | null; bytes: number }>(
    `SELECT channel || '@' || version               AS key,
            encode(blob, 'base64')                  AS encoded,
            COALESCE(octet_length(blob), 0)         AS bytes
       FROM ${CHECKPOINT_SCHEMA}.checkpoint_blobs
      WHERE thread_id = $1
      ORDER BY 1`,
    [threadId],
  );

  const writes = await db.pool.query<{ key: string; encoded: string | null; bytes: number }>(
    `SELECT checkpoint_id || '/' || task_id || '/' || idx::text || '/' || channel AS key,
            encode(blob, 'base64')                                               AS encoded,
            COALESCE(octet_length(blob), 0)                                      AS bytes
       FROM ${CHECKPOINT_SCHEMA}.checkpoint_writes
      WHERE thread_id = $1
      ORDER BY 1`,
    [threadId],
  );

  return {
    checkpoints: checkpoints.rows,
    blobs: blobs.rows.map((row) => ({ key: row.key, owner: label(row.encoded), bytes: row.bytes })),
    writes: writes.rows.map((row) => ({ key: row.key, owner: label(row.encoded), bytes: row.bytes })),
  };
}

/**
 * Node executions, counted from the independent probe rather than from graph
 * output. `party >= 0` excludes the `prepare` fixture run, which is not part of
 * the race and must not inflate the count the race is judged on.
 */
export async function executionCounts(
  db: Db,
  caseId: string,
): Promise<Array<{ node: string; phase: string; executions: number; parties: number; processes: number }>> {
  const { rows } = await db.pool.query<{
    node: string;
    phase: string;
    executions: number;
    parties: number;
    processes: number;
  }>(
    `SELECT node, phase,
            count(*)::int                       AS executions,
            count(DISTINCT party)::int          AS parties,
            count(DISTINCT process_nonce)::int  AS processes
       FROM ${PROBE_SCHEMA}.event
      WHERE case_id = $1 AND party >= 0
      GROUP BY node, phase
      ORDER BY node, phase`,
    [caseId],
  );
  return rows;
}

export type ReachabilityWitness = {
  /**
   * A live checkpoint naming a (channel, version) with no blob row. The loader's
   * join is an INNER join, so this does NOT raise: the channel silently vanishes
   * and the thread resumes on truncated state. Corruption, and must be empty.
   */
  strandedReferences: Array<{ ns: string; checkpoint_id: string; channel: string; version: string }>;
  /** A blob row no live checkpoint names. Harmless garbage; may be non-empty. */
  orphanBlobs: Array<{ ns: string; channel: string; version: string; bytes: number }>;
  /** A checkpoint whose parent row is gone. Breaks delta replay; must be empty. */
  brokenLineage: Array<{ ns: string; checkpoint_id: string; parent_checkpoint_id: string }>;
  /** A write whose checkpoint is gone. */
  deadWrites: Array<{ ns: string; checkpoint_id: string; task_id: string; channel: string }>;
  /** How many live checkpoints reference each blob version. max > 1 proves sharing. */
  sharing: Array<{ ns: string; channel: string; version: string; referencedBy: number }>;
};

/**
 * The same witness over several threads at once.
 *
 * Pruning is inherently cross-thread — the live set is "what the RETAINED heads
 * reference", and everything that makes a sweep dangerous involves a row in one
 * thread being deleted while another still points at it. A thread-scoped witness
 * would report a clean bill of health for the retained thread while the sweep
 * had strewn the database with stranded references next door.
 */
export async function reachabilityAcross(
  db: Db,
  threadIds: string[],
): Promise<ReachabilityWitness> {
  return await reachabilityFor(db, threadIds);
}

export async function reachability(db: Db, threadId: string): Promise<ReachabilityWitness> {
  return await reachabilityFor(db, [threadId]);
}

async function reachabilityFor(db: Db, threadIds: string[]): Promise<ReachabilityWitness> {
  // Deliberately the same join the loader uses (jsonb_each_text over
  // channel_versions, textual version comparison, namespace-scoped), negated.
  // Any divergence here would make "referenced" mean something different from
  // "readable", which is the whole bug class this witness exists to detect.
  const stranded = await db.pool.query<{
    ns: string;
    checkpoint_id: string;
    channel: string;
    version: string;
  }>(
    `SELECT c.checkpoint_ns AS ns, c.checkpoint_id, v.key AS channel, v.value AS version
       FROM ${CHECKPOINT_SCHEMA}.checkpoints c
       CROSS JOIN LATERAL jsonb_each_text(c.checkpoint -> 'channel_versions') v
       LEFT JOIN ${CHECKPOINT_SCHEMA}.checkpoint_blobs b
              ON b.thread_id     = c.thread_id
             AND b.checkpoint_ns = c.checkpoint_ns
             AND b.channel       = v.key
             AND b.version       = v.value
      WHERE c.thread_id = ANY($1::text[]) AND b.channel IS NULL
      ORDER BY 1, 2, 3, 4`,
    [threadIds],
  );

  const orphans = await db.pool.query<{
    ns: string;
    channel: string;
    version: string;
    bytes: number;
  }>(
    `SELECT b.checkpoint_ns AS ns, b.channel, b.version,
            COALESCE(octet_length(b.blob), 0) AS bytes
       FROM ${CHECKPOINT_SCHEMA}.checkpoint_blobs b
      WHERE b.thread_id = ANY($1::text[])
        AND NOT EXISTS (
              SELECT 1
                FROM ${CHECKPOINT_SCHEMA}.checkpoints c
                CROSS JOIN LATERAL jsonb_each_text(c.checkpoint -> 'channel_versions') v
               WHERE c.thread_id     = b.thread_id
                 AND c.checkpoint_ns = b.checkpoint_ns
                 AND v.key           = b.channel
                 AND v.value         = b.version)
      ORDER BY 1, 2, 3`,
    [threadIds],
  );

  const broken = await db.pool.query<{
    ns: string;
    checkpoint_id: string;
    parent_checkpoint_id: string;
  }>(
    `SELECT c.checkpoint_ns AS ns, c.checkpoint_id, c.parent_checkpoint_id
       FROM ${CHECKPOINT_SCHEMA}.checkpoints c
       LEFT JOIN ${CHECKPOINT_SCHEMA}.checkpoints p
              ON p.thread_id     = c.thread_id
             AND p.checkpoint_ns = c.checkpoint_ns
             AND p.checkpoint_id = c.parent_checkpoint_id
      WHERE c.thread_id = ANY($1::text[])
        AND c.parent_checkpoint_id IS NOT NULL
        AND p.checkpoint_id IS NULL
      ORDER BY 1, 2`,
    [threadIds],
  );

  const dead = await db.pool.query<{
    ns: string;
    checkpoint_id: string;
    task_id: string;
    channel: string;
  }>(
    `SELECT w.checkpoint_ns AS ns, w.checkpoint_id, w.task_id, w.channel
       FROM ${CHECKPOINT_SCHEMA}.checkpoint_writes w
       LEFT JOIN ${CHECKPOINT_SCHEMA}.checkpoints c
              ON c.thread_id     = w.thread_id
             AND c.checkpoint_ns = w.checkpoint_ns
             AND c.checkpoint_id = w.checkpoint_id
      WHERE w.thread_id = ANY($1::text[]) AND c.checkpoint_id IS NULL
      ORDER BY 1, 2, 3, 4`,
    [threadIds],
  );

  const sharing = await db.pool.query<{
    ns: string;
    channel: string;
    version: string;
    referencedBy: number;
  }>(
    `SELECT c.checkpoint_ns AS ns, v.key AS channel, v.value AS version,
            count(DISTINCT c.checkpoint_id)::int AS "referencedBy"
       FROM ${CHECKPOINT_SCHEMA}.checkpoints c
       CROSS JOIN LATERAL jsonb_each_text(c.checkpoint -> 'channel_versions') v
      WHERE c.thread_id = ANY($1::text[])
      GROUP BY 1, 2, 3
      ORDER BY 1, 2,
               CASE WHEN v.value ~ '^[0-9]+$' THEN v.value::numeric END NULLS LAST,
               v.value`,
    [threadIds],
  );

  return {
    strandedReferences: stranded.rows,
    orphanBlobs: orphans.rows,
    brokenLineage: broken.rows,
    deadWrites: dead.rows,
    sharing: sharing.rows,
  };
}
