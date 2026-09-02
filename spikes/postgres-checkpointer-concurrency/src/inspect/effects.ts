// The two independent sides of the proposed `effect_key`.
//
// `effectEvents` is what the running code SAW: components scavenged from the
// config the engine handed each node, written to the probe on a connection the
// checkpointer does not own. It survives a superstep that never commits, which
// is the only reason a crash case can compare the key a dead process computed
// against the key its replacement computes.
//
// `effectSites` is what the DATABASE holds: `(checkpoint_ns, checkpoint_id,
// task_id, idx)` read straight from `checkpoint_writes`. Those four columns are
// exactly the four proposed components a later reconciliation could recover
// without trusting any in-process record.
//
// Keeping them apart is the point. If a node's own view of its namespace, parent
// checkpoint and task id could not be rediscovered from the rows, an idempotency
// ledger built on that view would be unauditable — and, as it turns out, the two
// sides do not agree on `ns` at all.

import type { Db } from "../db.ts";
import { CHECKPOINT_SCHEMA, PROBE_SCHEMA } from "../contract.ts";

export type EffectEventRow = {
  party: number;
  node: string;
  processNonce: string;
  key: string | null;
  run: string | null;
  ns: string | null;
  taskNamespace: string | null;
  parentCheckpoint: string | null;
  task: string | null;
  ordinal: number | null;
  tool: string | null;
  canonicalArgs: string | null;
  configCheckpointId: string | null;
  configHasCheckpointIdKey: boolean | null;
  checkpointMapKeys: string[];
  taskIdFromPrivateKey: boolean | null;
  keyWithoutTask: string | null;
  keyWithoutOrdinal: string | null;
  keyWithoutNs: string | null;
  keyWithoutParent: string | null;
};

/**
 * `ORDER BY e.id` is qualified for the same reason it is in `events()`: an
 * unqualified `ORDER BY id` binds to the `id::text` output column and sorts
 * event 10 before event 2, scrambling the causal order.
 *
 * `party >= 0` excludes the `prepare` fixture run. A fixture that built the
 * committed state is not one of the executions under comparison, and counting it
 * would make "the key was computed twice" true before either party started.
 */
export async function effectEvents(db: Db, caseId: string): Promise<EffectEventRow[]> {
  const { rows } = await db.pool.query<EffectEventRow>(
    `SELECT e.party,
            e.node,
            e.process_nonce::text                          AS "processNonce",
            e.detail ->> 'key'                             AS key,
            e.detail ->> 'run'                             AS run,
            e.detail ->> 'ns'                              AS ns,
            e.detail ->> 'taskNamespace'                   AS "taskNamespace",
            e.detail ->> 'parentCheckpoint'                AS "parentCheckpoint",
            e.detail ->> 'task'                            AS task,
            (e.detail ->> 'ordinal')::int                  AS ordinal,
            e.detail ->> 'tool'                            AS tool,
            e.detail ->> 'canonicalArgs'                   AS "canonicalArgs",
            e.detail ->> 'configCheckpointId'              AS "configCheckpointId",
            (e.detail ->> 'configHasCheckpointIdKey')::boolean
                                                           AS "configHasCheckpointIdKey",
            COALESCE(
              ARRAY(SELECT jsonb_array_elements_text(e.detail -> 'checkpointMapKeys')),
              ARRAY[]::text[])                             AS "checkpointMapKeys",
            (e.detail ->> 'taskIdFromPrivateKey')::boolean AS "taskIdFromPrivateKey",
            e.detail ->> 'keyWithoutTask'                  AS "keyWithoutTask",
            e.detail ->> 'keyWithoutOrdinal'               AS "keyWithoutOrdinal",
            e.detail ->> 'keyWithoutNs'                    AS "keyWithoutNs",
            e.detail ->> 'keyWithoutParent'                AS "keyWithoutParent"
       FROM ${PROBE_SCHEMA}.event e
      WHERE e.case_id = $1 AND e.phase = 'effect' AND e.party >= 0
      ORDER BY e.id`,
    [caseId],
  );
  return rows;
}

export type EffectSiteRow = {
  ns: string;
  parentCheckpoint: string;
  task: string;
  idx: number;
  channel: string;
};

/**
 * The row side, from `checkpoint_writes`.
 *
 * `checkpoint_id` on a write row is the checkpoint the task RAN AGAINST — the
 * proposed `parent_checkpoint` — because `PregelLoop.putWrites` stamps the row
 * with `this.checkpoint.id` before the superstep's next checkpoint exists. It is
 * named `parentCheckpoint` here so nothing downstream has to remember that.
 *
 * `idx` is the index of the WRITE within the task, not of the effect within the
 * node. They are unrelated, and a case that treated them as the same thing would
 * be claiming the proposed `ordinal` is recoverable from the database when it is
 * not.
 */
export async function effectSites(db: Db, threadId: string): Promise<EffectSiteRow[]> {
  const { rows } = await db.pool.query<EffectSiteRow>(
    `SELECT checkpoint_ns   AS ns,
            checkpoint_id   AS "parentCheckpoint",
            task_id         AS task,
            idx,
            channel
       FROM ${CHECKPOINT_SCHEMA}.checkpoint_writes
      WHERE thread_id = $1
      ORDER BY checkpoint_ns, checkpoint_id, task_id, idx`,
    [threadId],
  );
  return rows;
}
