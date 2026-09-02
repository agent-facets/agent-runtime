// The throwaway retention sweep, and the naive deletions it is measured against.
//
// This is NOT production retention code. It exists to test the architecture's
// stated pruning rule — live set = retained heads ∪ parent lineage ∪ referenced
// channel versions ∪ pending writes ∪ interrupts — against the pinned schema,
// and to make a deliberately incomplete sweep produce *detectable* damage.
//
// One schema fact dominates the whole design, and it is worth stating before any
// of the code makes sense:
//
//     There is no timestamp column anywhere in the checkpointer schema.
//
// `checkpoints` is (thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id,
// type, checkpoint, metadata). `checkpoint_blobs` is (thread_id, checkpoint_ns,
// channel, version, type, blob). `checkpoint_writes` is (thread_id,
// checkpoint_ns, checkpoint_id, task_id, idx, channel, type, blob). Not one
// `created_at`.
//
// So "delete data older than N days" cannot be expressed against these tables at
// all. The only time-like handles are `checkpoint ->> 'ts'` inside the JSONB
// document and the fact that `checkpoint_id` happens to be a time-ordered
// UUIDv6 — an encoding assumption, not a column. And `checkpoint_blobs` has
// neither: its only ordering is `version`, which is a per-channel counter and
// says nothing about when the row was written. Any date-based retention policy
// therefore has to reach the blob table through reachability, or not at all.
//
// Deletion ORDER is load-bearing and deliberately configurable. The sweep is not
// wrapped in a transaction, because a process killed mid-sweep is exactly the
// case the plan asks about, and a transaction would make the answer trivially
// "nothing happened":
//
//   safe    writes -> checkpoints -> blobs. A kill between two statements leaves
//           blobs nobody references: harmless garbage.
//   unsafe  blobs -> checkpoints -> writes. A kill leaves checkpoints that
//           reference blobs which are already gone: stranded live references,
//           and the loader's INNER join means the affected channel silently
//           vanishes rather than raising.
//
// Every statement goes through an explicitly acquired client rather than
// `pool.query`, because a gate can never bind to `pool.query` (harness defect 5)
// and the kill cases have to park between two named deletes.

import { CHECKPOINT_SCHEMA } from "./contract.ts";
import type { Db } from "./db.ts";

/**
 * A rule the sweep is told to get wrong, so that "the sweep was complete" is
 * falsifiable rather than assumed.
 */
export type SweepOmission =
  /**
   * Keep only the newest version of each channel — the plausible-and-wrong rule.
   * A channel that stopped changing keeps an OLD version, and the live head
   * still references it, so this strands the head of a retained thread.
   */
  | "channel-versions"
  /** Keep only the leaves, forgetting that delta replay walks parent lineage. */
  | "ancestors";

export type SweepOptions = {
  /** Threads whose heads define the live set. Everything else is dead. */
  retainThreads: string[];
  omit?: SweepOmission;
  order?: "safe" | "unsafe";
};

export type SweepResult = {
  retainThreads: string[];
  omit: SweepOmission | null;
  order: "safe" | "unsafe";
  live: { checkpoints: number; blobs: number; writes: number };
  deleted: { checkpoints: number; blobs: number; writes: number };
};

/** Live checkpoints: every row of a retained thread, or only its leaves. */
function liveCheckpointsSql(omit: SweepOmission | undefined): string {
  if (omit !== "ancestors") {
    return `SELECT thread_id, checkpoint_ns, checkpoint_id
              FROM ${CHECKPOINT_SCHEMA}.checkpoints
             WHERE thread_id = ANY($1::text[])`;
  }
  return `SELECT c.thread_id, c.checkpoint_ns, c.checkpoint_id
            FROM ${CHECKPOINT_SCHEMA}.checkpoints c
           WHERE c.thread_id = ANY($1::text[])
             AND NOT EXISTS (
                   SELECT 1 FROM ${CHECKPOINT_SCHEMA}.checkpoints child
                    WHERE child.thread_id            = c.thread_id
                      AND child.checkpoint_ns        = c.checkpoint_ns
                      AND child.parent_checkpoint_id = c.checkpoint_id)`;
}

/**
 * Live blobs: every (channel, version) any live checkpoint names.
 *
 * The correct rule reads `channel_versions` with the same `jsonb_each_text`
 * expansion the loader uses, so "referenced" here means exactly "readable"
 * there. The omission keeps the newest version per channel instead, which is
 * what a sweep written from intuition rather than from the join would do.
 */
function liveBlobsSql(omit: SweepOmission | undefined): string {
  if (omit === "channel-versions") {
    return `SELECT b.thread_id, b.checkpoint_ns, b.channel, b.version
              FROM ${CHECKPOINT_SCHEMA}.checkpoint_blobs b
             WHERE b.thread_id = ANY($1::text[])
               AND b.version = (
                     SELECT max(CASE WHEN b2.version ~ '^[0-9]+$'
                                     THEN b2.version::numeric END)::text
                       FROM ${CHECKPOINT_SCHEMA}.checkpoint_blobs b2
                      WHERE b2.thread_id     = b.thread_id
                        AND b2.checkpoint_ns = b.checkpoint_ns
                        AND b2.channel       = b.channel)`;
  }
  return `SELECT DISTINCT c.thread_id, c.checkpoint_ns, v.key AS channel, v.value AS version
            FROM (${liveCheckpointsSql(omit)}) live
            JOIN ${CHECKPOINT_SCHEMA}.checkpoints c
              ON c.thread_id     = live.thread_id
             AND c.checkpoint_ns = live.checkpoint_ns
             AND c.checkpoint_id = live.checkpoint_id
            CROSS JOIN LATERAL jsonb_each_text(c.checkpoint -> 'channel_versions') v`;
}

/**
 * Live writes: pending writes and interrupts attached to a live checkpoint.
 *
 * Both matter and neither is optional. A pending write is what lets a resumed
 * fan-out reuse a completed sibling; an interrupt write IS the outstanding
 * approval. Deleting either turns a paused run into a run that silently redoes
 * work or loses its decision point.
 */
function liveWritesSql(omit: SweepOmission | undefined): string {
  return `SELECT w.thread_id, w.checkpoint_ns, w.checkpoint_id, w.task_id, w.idx
            FROM ${CHECKPOINT_SCHEMA}.checkpoint_writes w
            JOIN (${liveCheckpointsSql(omit)}) live
              ON live.thread_id     = w.thread_id
             AND live.checkpoint_ns = w.checkpoint_ns
             AND live.checkpoint_id = w.checkpoint_id`;
}

export async function reachabilitySweep(db: Db, options: SweepOptions): Promise<SweepResult> {
  const omit = options.omit;
  const order = options.order ?? "safe";
  const retain = options.retainThreads;
  const client = await db.pool.connect();

  const deleteWrites = `DELETE FROM ${CHECKPOINT_SCHEMA}.checkpoint_writes w
     WHERE NOT EXISTS (SELECT 1 FROM (${liveWritesSql(omit)}) live
                        WHERE live.thread_id     = w.thread_id
                          AND live.checkpoint_ns = w.checkpoint_ns
                          AND live.checkpoint_id = w.checkpoint_id
                          AND live.task_id       = w.task_id
                          AND live.idx           = w.idx)`;
  const deleteCheckpoints = `DELETE FROM ${CHECKPOINT_SCHEMA}.checkpoints c
     WHERE NOT EXISTS (SELECT 1 FROM (${liveCheckpointsSql(omit)}) live
                        WHERE live.thread_id     = c.thread_id
                          AND live.checkpoint_ns = c.checkpoint_ns
                          AND live.checkpoint_id = c.checkpoint_id)`;
  const deleteBlobs = `DELETE FROM ${CHECKPOINT_SCHEMA}.checkpoint_blobs b
     WHERE NOT EXISTS (SELECT 1 FROM (${liveBlobsSql(omit)}) live
                        WHERE live.thread_id     = b.thread_id
                          AND live.checkpoint_ns = b.checkpoint_ns
                          AND live.channel       = b.channel
                          AND live.version       = b.version)`;

  try {
    const counted = async (sql: string): Promise<number> => {
      const { rows } = await client.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM (${sql}) t`,
        [retain],
      );
      return Number(rows[0]?.n ?? 0);
    };

    const live = {
      checkpoints: await counted(liveCheckpointsSql(omit)),
      blobs: await counted(liveBlobsSql(omit)),
      writes: await counted(liveWritesSql(omit)),
    };

    const deleted = { checkpoints: 0, blobs: 0, writes: 0 };
    const runDelete = async (sql: string): Promise<number> => {
      const result = await client.query(sql, [retain]);
      return result.rowCount ?? 0;
    };

    if (order === "safe") {
      deleted.writes = await runDelete(deleteWrites);
      deleted.checkpoints = await runDelete(deleteCheckpoints);
      deleted.blobs = await runDelete(deleteBlobs);
    } else {
      deleted.blobs = await runDelete(deleteBlobs);
      deleted.checkpoints = await runDelete(deleteCheckpoints);
      deleted.writes = await runDelete(deleteWrites);
    }

    return { retainThreads: retain, omit: omit ?? null, order, live, deleted };
  } finally {
    client.release();
  }
}

/**
 * "Delete checkpoints older than the newest K", keyed on the only timestamp the
 * schema offers: `checkpoint ->> 'ts'` inside the JSONB document.
 *
 * Nothing else is touched — no blobs, no writes — which is precisely how a
 * date-based policy written against this schema would behave, because there is
 * no date to filter the other two tables by.
 */
export async function naiveDeleteOldCheckpoints(
  db: Db,
  threadId: string,
  keepNewest: number,
): Promise<{ deleted: number }> {
  const client = await db.pool.connect();
  try {
    const result = await client.query(
      `DELETE FROM ${CHECKPOINT_SCHEMA}.checkpoints c
        WHERE c.thread_id = $1
          AND c.checkpoint_id NOT IN (
                SELECT checkpoint_id FROM ${CHECKPOINT_SCHEMA}.checkpoints
                 WHERE thread_id = $1
                 ORDER BY checkpoint ->> 'ts' DESC, checkpoint_id DESC
                 LIMIT $2)`,
      [threadId, keepNewest],
    );
    return { deleted: result.rowCount ?? 0 };
  } finally {
    client.release();
  }
}

/**
 * "Delete superseded blob versions", keyed on the only ordering the blob table
 * has: `version`.
 *
 * The intuition is that an old version of a channel is dead once a newer one
 * exists. It is wrong, and f01 measures why: a channel that stops changing keeps
 * its old version number, and every later checkpoint goes on referencing it.
 */
export async function naiveDeleteSupersededBlobs(
  db: Db,
  threadId: string,
): Promise<{ deleted: number }> {
  const client = await db.pool.connect();
  try {
    const result = await client.query(
      `DELETE FROM ${CHECKPOINT_SCHEMA}.checkpoint_blobs b
        WHERE b.thread_id = $1
          AND b.version <> (
                SELECT max(CASE WHEN b2.version ~ '^[0-9]+$'
                                THEN b2.version::numeric END)::text
                  FROM ${CHECKPOINT_SCHEMA}.checkpoint_blobs b2
                 WHERE b2.thread_id     = b.thread_id
                   AND b2.checkpoint_ns = b.checkpoint_ns
                   AND b2.channel       = b.channel)`,
      [threadId],
    );
    return { deleted: result.rowCount ?? 0 };
  } finally {
    client.release();
  }
}

export type ThreadCounts = {
  thread_id: string;
  checkpoints: number;
  blobs: number;
  writes: number;
};

/** Row counts per thread, so a sweep's effect is visible without naming ids. */
export async function threadCounts(db: Db, threadIds: string[]): Promise<ThreadCounts[]> {
  const { rows } = await db.pool.query<ThreadCounts>(
    `SELECT t.thread_id,
            (SELECT count(*)::int FROM ${CHECKPOINT_SCHEMA}.checkpoints c
              WHERE c.thread_id = t.thread_id)       AS checkpoints,
            (SELECT count(*)::int FROM ${CHECKPOINT_SCHEMA}.checkpoint_blobs b
              WHERE b.thread_id = t.thread_id)       AS blobs,
            (SELECT count(*)::int FROM ${CHECKPOINT_SCHEMA}.checkpoint_writes w
              WHERE w.thread_id = t.thread_id)       AS writes
       FROM unnest($1::text[]) AS t(thread_id)
      ORDER BY t.thread_id`,
    [threadIds],
  );
  return rows;
}
