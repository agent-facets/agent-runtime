// Family C: atomicity, pools, locks, and deletion.
//
// The vendor wraps `put()`, `putWrites()` and `deleteThread()` in BEGIN/COMMIT,
// so the source predicts that killing a worker mid-call leaves nothing behind.
// That prediction is worth almost nothing on its own: "we looked and found no
// partial state" is equally consistent with "the projection cannot see partial
// state". So the family is built as a triple:
//
//   c01/c02  killed INSIDE the transaction        -> expect nothing durable
//   c03      killed AFTER COMMIT was acknowledged -> expect everything durable
//   c05      a deliberately NON-atomic writer,
//            killed between two autocommit
//            statements                           -> MUST leave partial state
//
// c03 proves the kill lands late enough to matter; c05 proves the detector can
// see a torn write at all. Without both, c01 and c02 are unfalsifiable.
//
// The lock lane never infers contention from elapsed time: a blocked -> blocking
// backend edge is captured from pg_locks while the victim is still parked, or
// the case fails.

import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import type { Checkpoint, CheckpointMetadata } from "@langchain/langgraph-checkpoint";

import {
  CHECKPOINT_SCHEMA,
  CONFLICT_FIXTURE,
  databaseForCase,
  threadForCase,
} from "./contract.ts";
import { appNameFor, describeSqlError, openDb, type Db, type SqlError } from "./db.ts";
import { arrive, waitForRelease } from "./barrier.ts";
import { createProbe, type Probe } from "./probe.ts";
import {
  createSink,
  instrumentPool,
  recordPark,
  statementMultiset,
  type GateHook,
  type GateSpec,
} from "./gate.ts";
import type { PartyContext } from "./family-a.ts";

const CONFLICT = CONFLICT_FIXTURE;

/** The role family C constrains, so the harness's own pools stay unaffected. */
export const LIMITED_ROLE = "spike_limited";
export const LIMITED_ROLE_CONNECTIONS = 2;

const C_CHANNEL_A = "spike_channel_a";
const C_CHANNEL_B = "spike_channel_b";

function subjectPool(context: PartyContext, options: { max?: number; user?: string } = {}): Db {
  return openDb(appNameFor(context.caseId, context.member, "subject"), "subject", {
    database: databaseForCase(context.caseId),
    max: options.max ?? 4,
    ...(options.user ? { user: options.user } : {}),
  });
}

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

/** Records the boundary durably, then never returns: the driver kills it here. */
function parkForever(probe: Db, context: PartyContext): GateHook {
  return async (gate, statement) => {
    await recordPark(probe, context.caseId, context.party, gate, statement);
    await new Promise<never>(() => {});
  };
}

function parkAtBarriers(
  probe: Db,
  context: PartyContext,
  witness: Probe,
  arriveAt: string[],
  waitOn: string,
): GateHook {
  return async (gate, statement) => {
    await recordPark(probe, context.caseId, context.party, gate, statement);
    for (const name of arriveAt) {
      await arrive(probe, context.caseId, name, context.party, context.member, witness.nonce);
    }
    await waitForRelease(probe, context.caseId, waitOn);
  };
}

/**
 * `version` is threaded through rather than hardcoded, and must match the
 * `newVersions` handed to `put()`.
 *
 * They are separate arguments in the vendor API — `channel_versions` is what the
 * checkpoint CLAIMS to reference, `newVersions` is what actually gets written —
 * so a mismatch silently manufactures both a stranded reference and an orphan
 * blob. That is indistinguishable from the corruption these cases exist to
 * detect, which is exactly how a harness bug gets reported as a finding.
 */
function checkpointFor(
  id: string,
  channels: Record<string, string>,
  version = "1",
): Checkpoint {
  return {
    v: 4,
    id,
    ts: "2026-01-01T00:00:00.000Z",
    channel_values: { ...channels },
    channel_versions: Object.fromEntries(Object.keys(channels).map((key) => [key, version])),
    versions_seen: {},
  };
}

function metadataFor(writer: string, step: number): CheckpointMetadata {
  return { source: "update", step, parents: {}, writer } as unknown as CheckpointMetadata;
}

const KILL_CHECKPOINT_ID = "01970000-0000-6000-8000-00000000c001";

/**
 * A `put()` carrying TWO channels, so the transaction contains two blob upserts
 * before the checkpoint row. That is what makes "after the first blob statement
 * but before the checkpoint row" an addressable boundary rather than a wish.
 */
async function killedPut(
  context: PartyContext,
  gates: GateSpec[],
): Promise<Record<string, unknown>> {
  const probe = probePool(context);
  const subject = subjectPool(context);
  const threadId = threadForCase(context.caseId);

  try {
    const witness = createProbe(probe, context.caseId, context.party, context.member);
    const sink = createSink();
    instrumentPool(subject.pool, sink, gates, parkForever(probe, context));
    const saver = new PostgresSaver(subject.pool, undefined, { schema: CHECKPOINT_SCHEMA });

    let error: SqlError | null = null;
    try {
      await saver.put(
        { configurable: { thread_id: threadId, checkpoint_ns: "" } },
        checkpointFor(KILL_CHECKPOINT_ID, {
          [C_CHANNEL_A]: CONFLICT.payloadByParty[0]!,
          [C_CHANNEL_B]: CONFLICT.payloadByParty[1]!,
        }),
        metadataFor("victim", 1),
        { [C_CHANNEL_A]: "1", [C_CHANNEL_B]: "1" },
      );
      await witness.record("put", "returned");
    } catch (caught) {
      error = describeSqlError(caught);
      await witness.record("put", "raised", { code: error.code });
    }

    return { party: context.party, error, statements: statementMultiset(sink) };
  } finally {
    await Promise.allSettled([subject.close(), probe.close()]);
  }
}

/** The same, for a multi-row `putWrites()`. */
async function killedPutWrites(
  context: PartyContext,
  gates: GateSpec[],
): Promise<Record<string, unknown>> {
  const probe = probePool(context);
  const subject = subjectPool(context);
  const threadId = threadForCase(context.caseId);

  try {
    const witness = createProbe(probe, context.caseId, context.party, context.member);
    const sink = createSink();
    instrumentPool(subject.pool, sink, gates, parkForever(probe, context));
    const saver = new PostgresSaver(subject.pool, undefined, { schema: CHECKPOINT_SCHEMA });

    let error: SqlError | null = null;
    try {
      await saver.putWrites(
        {
          configurable: {
            thread_id: threadId,
            checkpoint_ns: "",
            checkpoint_id: CONFLICT.baseCheckpointId,
          },
        },
        [
          [C_CHANNEL_A, "row-one"],
          [C_CHANNEL_B, "row-two"],
          ["spike_channel_c", "row-three"],
        ],
        CONFLICT.taskId,
      );
      await witness.record("putWrites", "returned");
    } catch (caught) {
      error = describeSqlError(caught);
      await witness.record("putWrites", "raised", { code: error.code });
    }

    return { party: context.party, error, statements: statementMultiset(sink) };
  } finally {
    await Promise.allSettled([subject.close(), probe.close()]);
  }
}

/**
 * The load-bearing control: a writer that is deliberately NOT atomic.
 *
 * It writes the checkpoint row in one autocommit statement and would write the
 * blob in a second. Killed between them, it must leave a checkpoint referencing
 * a blob that does not exist — the exact shape `reachability()` calls a stranded
 * reference. If this case comes back clean, the projection cannot see partial
 * state and the vendor's atomicity results say nothing.
 *
 * This is harness SQL. No vendor statement is altered anywhere in the family.
 */
async function nonAtomicWriter(context: PartyContext): Promise<Record<string, unknown>> {
  const probe = probePool(context);
  const subject = subjectPool(context);
  const threadId = threadForCase(context.caseId);

  try {
    const sink = createSink();
    instrumentPool(
      subject.pool,
      sink,
      [{ name: "between-statements", label: "ckpt.checkpoint-upsert", ordinal: 1, position: "post" }],
      parkForever(probe, context),
    );

    const checkpoint = checkpointFor(KILL_CHECKPOINT_ID, { [C_CHANNEL_A]: "value" });

    // An explicit client in promise form, exactly as every vendor write path
    // does it. `pool.query()` would be wrong twice over: pg-pool always
    // dispatches it as `client.query(text, values, callback)`, and the gate
    // delegates callback-form queries untouched rather than silently changing
    // their shape — so no gate could ever bind here. The control must differ
    // from `put()` ONLY in the absence of BEGIN/COMMIT, not in the client API.
    const client = await subject.pool.connect();
    try {
      // Autocommit, one statement at a time — no BEGIN anywhere.
      await client.query(
        `INSERT INTO ${CHECKPOINT_SCHEMA}.checkpoints
           (thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id, type, checkpoint, metadata)
         VALUES ($1, '', $2, NULL, 'json', $3::jsonb, $4::jsonb)`,
        [
          threadId,
          KILL_CHECKPOINT_ID,
          JSON.stringify(checkpoint),
          JSON.stringify({ source: "control" }),
        ],
      );

      // Never reached: the gate above parks after the statement settles.
      await client.query(
        `INSERT INTO ${CHECKPOINT_SCHEMA}.checkpoint_blobs
           (thread_id, checkpoint_ns, channel, version, type, blob)
         VALUES ($1, '', $2, '1', 'json', $3::bytea)`,
        [threadId, C_CHANNEL_A, Buffer.from('"value"', "utf8")],
      );
    } finally {
      client.release();
    }

    return { party: context.party, error: null, statements: statementMultiset(sink) };
  } finally {
    await Promise.allSettled([subject.close(), probe.close()]);
  }
}

/**
 * A pool of one, given more concurrent work than it has connections.
 *
 * The architecture question is not throughput — explicitly out of scope — but
 * whether a small pool degrades into a hang. pg-pool queues, so the expected
 * answer is that everything completes on a single backend.
 */
async function poolSerialization(context: PartyContext): Promise<Record<string, unknown>> {
  const probe = probePool(context);
  const subject = subjectPool(context, { max: 1 });
  const threadId = threadForCase(context.caseId);

  try {
    const saver = new PostgresSaver(subject.pool, undefined, { schema: CHECKPOINT_SCHEMA });
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, (_, index) =>
        saver.put(
          { configurable: { thread_id: threadId, checkpoint_ns: "" } },
          checkpointFor(`c06-cp-${index}`, { [C_CHANNEL_A]: `value-${index}` }, String(index + 1)),
          metadataFor("pool", index),
          { [C_CHANNEL_A]: String(index + 1) },
        ),
      ),
    );

    const inspect = inspectPool(context);
    const { rows } = await inspect.pool.query<{ backends: number }>(
      `SELECT count(DISTINCT pid)::int AS backends
         FROM pg_stat_activity WHERE application_name = $1`,
      [subject.appName],
    );
    await inspect.close();

    return {
      party: context.party,
      error: null,
      operations: results.length,
      fulfilled: results.filter((result) => result.status === "fulfilled").length,
      rejections: results
        .filter((result): result is PromiseRejectedResult => result.status === "rejected")
        .map((result) => describeSqlError(result.reason)),
      // The pool never grew past its ceiling, and every operation still finished.
      poolMax: 1,
      backendsObserved: rows[0]?.backends ?? -1,
      idleErrors: subject.idleErrors,
    };
  } finally {
    await Promise.allSettled([subject.close(), probe.close()]);
  }
}

/**
 * More connections than the server role is allowed.
 *
 * The requirement is that exhaustion is LOUD and BOUNDED — a named SQLSTATE
 * rather than an indefinite wait. PostgreSQL refuses the connection outright
 * with 53300, which is exactly the shape the architecture needs.
 */
async function connectionLimit(context: PartyContext): Promise<Record<string, unknown>> {
  const probe = probePool(context);
  const clients: Array<{ release: () => void }> = [];
  const subject = subjectPool(context, {
    max: LIMITED_ROLE_CONNECTIONS + 2,
    user: LIMITED_ROLE,
  });

  try {
    const attempts: Array<{ index: number; ok: boolean; code: string | null }> = [];
    for (let index = 0; index < LIMITED_ROLE_CONNECTIONS + 2; index += 1) {
      try {
        const client = await subject.pool.connect();
        clients.push(client);
        attempts.push({ index, ok: true, code: null });
      } catch (error) {
        attempts.push({ index, ok: false, code: describeSqlError(error).code });
      }
    }

    return {
      party: context.party,
      error: null,
      limit: LIMITED_ROLE_CONNECTIONS,
      attempts,
      accepted: attempts.filter((attempt) => attempt.ok).length,
      refused: attempts.filter((attempt) => !attempt.ok).length,
      // Every refusal names itself. An empty or null-coded refusal set would mean
      // the pool hung or failed anonymously, which is the failure mode this case
      // exists to rule out.
      refusalCodes: [...new Set(attempts.filter((a) => !a.ok).map((a) => a.code))].sort(),
    };
  } finally {
    for (const client of clients) client.release();
    await Promise.allSettled([subject.close(), probe.close()]);
  }
}

/**
 * Two `put()` calls for the SAME checkpoint id, with the first parked after its
 * upsert but before COMMIT, so the second is genuinely blocked on a row lock
 * while pg_locks is sampled.
 */
async function lockWait(context: PartyContext): Promise<Record<string, unknown>> {
  const probe = probePool(context);
  const subject = subjectPool(context);
  const threadId = threadForCase(context.caseId);

  try {
    const witness = createProbe(probe, context.caseId, context.party, context.member);
    const sink = createSink();
    const saver = new PostgresSaver(subject.pool, undefined, { schema: CHECKPOINT_SCHEMA });

    if (context.party === 0) {
      // Arrives at BOTH stages from inside the transaction: `locked` tells the
      // coordinator the row lock is held, `hold` is what it releases after the
      // lock edge has been captured.
      instrumentPool(
        subject.pool,
        sink,
        [{ name: "holding", label: "txn.commit", ordinal: 1, position: "pre" }],
        parkAtBarriers(probe, context, witness, ["locked", "hold"], "hold"),
      );
    } else {
      await arrive(probe, context.caseId, "locked", context.party, context.member, witness.nonce);
      await waitForRelease(probe, context.caseId, "locked");
      instrumentPool(subject.pool, sink, [], async () => {});
    }

    let error: SqlError | null = null;
    try {
      await saver.put(
        { configurable: { thread_id: threadId, checkpoint_ns: "" } },
        checkpointFor(KILL_CHECKPOINT_ID, { [C_CHANNEL_A]: `party-${context.party}` }),
        metadataFor(`p${context.party}`, 1),
        { [C_CHANNEL_A]: "1" },
      );
    } catch (caught) {
      error = describeSqlError(caught);
    }

    return { party: context.party, error, statements: statementMultiset(sink) };
  } finally {
    await Promise.allSettled([subject.close(), probe.close()]);
  }
}

/**
 * `deleteThread()` against a `put()` whose transaction is already open.
 *
 * Ordered rather than raced, so the result is a fact rather than a coin flip:
 * the writer parks after its blobs but before its checkpoint row, the deleter
 * runs to completion, and only then does the writer commit. Both calls are
 * individually atomic, so the question is what their COMBINATION leaves — in
 * particular whether a surviving checkpoint can point at a parent the delete
 * removed.
 */
async function deleteVersusWrite(context: PartyContext): Promise<Record<string, unknown>> {
  const probe = probePool(context);
  const subject = subjectPool(context);
  const threadId = threadForCase(context.caseId);

  try {
    const witness = createProbe(probe, context.caseId, context.party, context.member);
    const sink = createSink();
    const saver = new PostgresSaver(subject.pool, undefined, { schema: CHECKPOINT_SCHEMA });
    let error: SqlError | null = null;

    if (context.party === 0) {
      instrumentPool(
        subject.pool,
        sink,
        [{ name: "before-row", label: "ckpt.checkpoint-upsert", ordinal: 1, position: "pre" }],
        parkAtBarriers(probe, context, witness, ["writer-parked"], "commit-now"),
      );
      try {
        await saver.put(
          {
            configurable: {
              thread_id: threadId,
              checkpoint_ns: "",
              // Names the checkpoint the fixture created, which the deleter is
              // about to remove.
              checkpoint_id: CONFLICT.baseCheckpointId,
            },
          },
          checkpointFor(KILL_CHECKPOINT_ID, { [C_CHANNEL_A]: "written-during-delete" }, "2"),
          metadataFor("writer", 1),
          { [C_CHANNEL_A]: "2" },
        );
        await witness.record("put", "returned");
      } catch (caught) {
        error = describeSqlError(caught);
        await witness.record("put", "raised", { code: error.code });
      }
      return { party: context.party, error, role: "writer", statements: statementMultiset(sink) };
    }

    instrumentPool(subject.pool, sink, [], async () => {});
    await arrive(probe, context.caseId, "writer-parked", context.party, context.member, witness.nonce);
    await waitForRelease(probe, context.caseId, "writer-parked");
    try {
      await saver.deleteThread(threadId);
      await witness.record("deleteThread", "returned");
    } catch (caught) {
      error = describeSqlError(caught);
      await witness.record("deleteThread", "raised", { code: error.code });
    }
    // Tells the coordinator the delete has COMMITTED, so the writer is released
    // strictly afterwards. Without it the release would race the delete and the
    // case would report an interleaving instead of the ordering it declares.
    await arrive(probe, context.caseId, "deleted", context.party, context.member, witness.nonce);
    return { party: context.party, error, role: "deleter", statements: statementMultiset(sink) };
  } finally {
    await Promise.allSettled([subject.close(), probe.close()]);
  }
}

// ---------------------------------------------------------------------------

export async function runFamilyCParty(context: PartyContext): Promise<Record<string, unknown>> {
  const victim = context.party === 0;

  switch (context.caseId) {
    case "c01-kill-inside-put-before-checkpoint-row":
      return victim
        ? await killedPut(context, [
            { name: "before-row", label: "ckpt.checkpoint-upsert", ordinal: 1, position: "pre" },
          ])
        : await observeOnly(context);

    case "c02-kill-inside-put-before-commit":
      return victim
        ? await killedPut(context, [
            { name: "before-commit", label: "txn.commit", ordinal: 1, position: "pre" },
          ])
        : await observeOnly(context);

    case "c03-kill-after-commit-acknowledged":
      return victim
        ? await killedPut(context, [
            { name: "after-commit", label: "txn.commit", ordinal: 1, position: "post" },
          ])
        : await observeOnly(context);

    case "c04-kill-inside-putwrites-before-commit":
      return victim
        ? await killedPutWrites(context, [
            { name: "before-commit", label: "txn.commit", ordinal: 1, position: "pre" },
          ])
        : await observeOnly(context);

    case "c05-nonatomic-writer-control":
      return victim ? await nonAtomicWriter(context) : await observeOnly(context);

    case "c06-pool-max1-serialization":
      return await poolSerialization(context);

    case "c07-role-connection-limit":
      return await connectionLimit(context);

    case "c08-lock-wait-on-conflicting-put":
      return await lockWait(context);

    case "c09-delete-thread-versus-open-write":
      return await deleteVersusWrite(context);

    default:
      throw new Error(`family C has no participant for case ${context.caseId}`);
  }
}

/**
 * The surviving party of a kill case: an independent read of what the killed
 * transaction left behind, taken on a connection that never touched it.
 */
async function observeOnly(context: PartyContext): Promise<Record<string, unknown>> {
  const inspect = inspectPool(context);
  const threadId = threadForCase(context.caseId);
  try {
    const { rows } = await inspect.pool.query<{
      checkpoints: number;
      blobs: number;
      writes: number;
    }>(
      `SELECT (SELECT count(*)::int FROM ${CHECKPOINT_SCHEMA}.checkpoints      WHERE thread_id = $1) AS checkpoints,
              (SELECT count(*)::int FROM ${CHECKPOINT_SCHEMA}.checkpoint_blobs WHERE thread_id = $1) AS blobs,
              (SELECT count(*)::int FROM ${CHECKPOINT_SCHEMA}.checkpoint_writes WHERE thread_id = $1) AS writes`,
      [threadId],
    );
    return {
      party: context.party,
      error: null,
      role: "observer",
      survivingRows: rows[0] ?? { checkpoints: -1, blobs: -1, writes: -1 },
    };
  } finally {
    await inspect.close().catch(() => {});
  }
}

/**
 * Fixtures that must exist before any party starts.
 *
 * c04 and c09 need the checkpoint their writes and their delete act on. c07
 * needs a role whose CONNECTION LIMIT is low enough to hit without starving the
 * harness's own pools, which keep connecting as the unconstrained role.
 */
export async function prepareFamilyC(caseId: string): Promise<Record<string, unknown>> {
  const context: PartyContext = { caseId, party: -1, member: "prepare" };
  const threadId = threadForCase(caseId);
  const db = inspectPool(context);

  try {
    if (caseId === "c07-role-connection-limit") {
      const { rowCount } = await db.pool.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [
        LIMITED_ROLE,
      ]);
      if (rowCount === 0) {
        await db.pool.query(
          `CREATE ROLE ${LIMITED_ROLE} LOGIN CONNECTION LIMIT ${LIMITED_ROLE_CONNECTIONS}`,
        );
      } else {
        await db.pool.query(
          `ALTER ROLE ${LIMITED_ROLE} CONNECTION LIMIT ${LIMITED_ROLE_CONNECTIONS}`,
        );
      }
      await db.pool.query(
        `GRANT ALL ON ALL TABLES IN SCHEMA ${CHECKPOINT_SCHEMA} TO ${LIMITED_ROLE}`,
      );
      await db.pool.query(`GRANT USAGE ON SCHEMA ${CHECKPOINT_SCHEMA} TO ${LIMITED_ROLE}`);
      return { caseId, prepared: true, role: LIMITED_ROLE, limit: LIMITED_ROLE_CONNECTIONS };
    }

    if (caseId === "c04-kill-inside-putwrites-before-commit" || caseId === "c09-delete-thread-versus-open-write") {
      const subject = subjectPool(context);
      try {
        const saver = new PostgresSaver(subject.pool, undefined, { schema: CHECKPOINT_SCHEMA });
        await saver.put(
          { configurable: { thread_id: threadId, checkpoint_ns: "" } },
          checkpointFor(CONFLICT.baseCheckpointId, { [C_CHANNEL_A]: "base" }),
          metadataFor("prepare", 0),
          { [C_CHANNEL_A]: "1" },
        );
        return { caseId, prepared: true, threadId, baseCheckpointId: CONFLICT.baseCheckpointId };
      } finally {
        await subject.close().catch(() => {});
      }
    }

    return { caseId, prepared: false };
  } finally {
    await db.close().catch(() => {});
  }
}
