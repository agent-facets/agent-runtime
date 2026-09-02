// Family B: checkpointer concurrency and conflicts.
//
// Two questions, deliberately kept apart.
//
// 1. What happens when two fresh containers resume the SAME committed interrupt
//    at the same time, with the same thread_id and no checkpoint_id? The oracle
//    is the independent probe: how many times each node actually executed, and
//    on how many distinct processes. Terminal graph output is not evidence —
//    two workers can both produce a plausible-looking result.
//
// 2. What are the conflict semantics of the raw write paths? Read from source,
//    the pinned release uses THREE different clauses across two methods:
//
//      checkpoint_blobs   ON CONFLICT DO NOTHING    first-writer-wins bytes
//      checkpoints        ON CONFLICT DO UPDATE     last-writer-wins row
//      checkpoint_writes  DO UPDATE only when EVERY channel is in
//                         WRITES_IDX_MAP, otherwise DO NOTHING
//
//    Those are source predictions. The cases below are built so that the stored
//    bytes can be compared against two known literal candidates, which is what
//    turns "first-writer-wins" from a reading into a measurement.
//
// `put()` and `putWrites()` are each wrapped in BEGIN/COMMIT by the vendor, so
// the atomicity question is not "is one call atomic" but "what do two atomic
// calls leave behind when they collide". Killing inside those transactions is
// family C.

import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import type { Checkpoint, CheckpointMetadata } from "@langchain/langgraph-checkpoint";

import {
  CHECKPOINT_SCHEMA,
  CONFLICT_FIXTURE,
  PROBE_SCHEMA,
  TIMEOUTS,
  databaseForCase,
  threadForCase,
} from "./contract.ts";
import { appNameFor, describeSqlError, openDb, type Db, type SqlError } from "./db.ts";
import { arrive, waitForRelease } from "./barrier.ts";
import { createProbe, type Probe } from "./probe.ts";
import { buildGraph, resume, runToInterrupt, type GraphRun } from "./graph.ts";
import { project, sampleConsistency } from "./inspect/checkpoints.ts";
import type { PartyContext } from "./family-a.ts";

const CONFLICT = CONFLICT_FIXTURE;

function subjectPool(context: PartyContext, max = 4): Db {
  return openDb(appNameFor(context.caseId, context.member, "subject"), "subject", {
    database: databaseForCase(context.caseId),
    max,
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

async function atBarrier(
  probe: Db,
  context: PartyContext,
  witness: Probe,
  name: string,
): Promise<void> {
  await arrive(probe, context.caseId, name, context.party, context.member, witness.nonce);
  await waitForRelease(probe, context.caseId, name);
}

// ---------------------------------------------------------------------------
// Graph lanes
// ---------------------------------------------------------------------------

/**
 * One process runs the whole thread: to the interrupt, then a resume. The
 * baseline every simultaneous-resume result is scored against — without it,
 * "finish executed twice" cannot be distinguished from "finish always executes
 * twice because the engine replays the superstep".
 */
async function graphSerialBaseline(context: PartyContext): Promise<Record<string, unknown>> {
  const probe = probePool(context);
  const subject = subjectPool(context);
  const threadId = threadForCase(context.caseId);

  try {
    const witness = createProbe(probe, context.caseId, context.party, context.member);
    const saver = new PostgresSaver(subject.pool, undefined, { schema: CHECKPOINT_SCHEMA });
    const graph = buildGraph(saver, witness);

    const first = await runToInterrupt(graph, threadId);
    const second = await resume(graph, threadId);

    return {
      party: context.party,
      error: first.error ?? second.error,
      threadId,
      firstPass: first,
      resumePass: second,
      reachedInterrupt: first.interrupted,
      completed: second.interrupted === false && second.error === null,
    };
  } finally {
    await Promise.allSettled([subject.close(), probe.close()]);
  }
}

/**
 * Both parties resume the same committed interrupt. `barrier` is the parallel
 * lane; `gate`/`done` is the sequential control, which runs the identical code
 * on the identical fixture and differs only in when each party is released.
 */
async function graphResume(
  context: PartyContext,
  options: { barrier: string; after?: string },
): Promise<Record<string, unknown>> {
  const probe = probePool(context);
  const subject = subjectPool(context);
  const threadId = threadForCase(context.caseId);

  try {
    const witness = createProbe(probe, context.caseId, context.party, context.member);
    const saver = new PostgresSaver(subject.pool, undefined, { schema: CHECKPOINT_SCHEMA });
    const graph = buildGraph(saver, witness);

    // Constructed BEFORE the barrier so that pool construction and graph
    // compilation are not part of what the parties are racing on.
    await atBarrier(probe, context, witness, options.barrier);

    const run: GraphRun = await resume(graph, threadId);
    if (options.after) await atBarrier(probe, context, witness, options.after);

    return {
      party: context.party,
      error: run.error,
      threadId,
      run,
      completed: run.error === null && run.interrupted === false,
    };
  } finally {
    await Promise.allSettled([subject.close(), probe.close()]);
  }
}

// ---------------------------------------------------------------------------
// Raw conflict lanes
// ---------------------------------------------------------------------------

/**
 * `version` must match the `newVersions` passed to `put()`. They are separate
 * arguments — one is what the checkpoint claims to reference, the other is what
 * is actually written — and a mismatch fabricates a stranded reference plus an
 * orphan blob that look exactly like the corruption these cases detect.
 */
function checkpointFor(id: string, value: string, version: string = CONFLICT.version): Checkpoint {
  return {
    v: 4,
    id,
    // Fixed: a wall-clock timestamp here would land in a digested blob.
    ts: "2026-01-01T00:00:00.000Z",
    channel_values: { [CONFLICT.channel]: value },
    channel_versions: { [CONFLICT.channel]: version },
    versions_seen: {},
  };
}

function metadataFor(writer: string, step: number): CheckpointMetadata {
  return { source: "update", step, parents: {}, writer } as unknown as CheckpointMetadata;
}

type ConflictOutcome = {
  party: number;
  error: SqlError | null;
  writer: string;
  wrote: Record<string, unknown>;
};

/**
 * Two `put()` calls that collide, with which key collides varying per case.
 *
 * `sameCheckpointId` collides on the `checkpoints` primary key (DO UPDATE);
 * the shared `(channel, version)` always collides on `checkpoint_blobs`
 * (DO NOTHING). Running both together is the case that shows whether the row
 * and the bytes can end up owned by DIFFERENT writers.
 */
async function putConflict(
  context: PartyContext,
  options: { sameCheckpointId: boolean; distinctPayloads: boolean },
): Promise<Record<string, unknown>> {
  const probe = probePool(context);
  const subject = subjectPool(context);
  const threadId = threadForCase(context.caseId);
  const writer = `p${context.party}`;
  const payload = options.distinctPayloads
    ? (CONFLICT.payloadByParty[context.party] ?? `party-${context.party}`)
    : CONFLICT.payloadByParty[0]!;
  const checkpointId = options.sameCheckpointId
    ? CONFLICT.sharedCheckpointId
    : (CONFLICT.checkpointIdByParty[context.party] ?? `cp-${context.party}`);

  try {
    const witness = createProbe(probe, context.caseId, context.party, context.member);
    const saver = new PostgresSaver(subject.pool, undefined, { schema: CHECKPOINT_SCHEMA });

    await atBarrier(probe, context, witness, "ready");

    let error: SqlError | null = null;
    try {
      await saver.put(
        { configurable: { thread_id: threadId, checkpoint_ns: "" } },
        checkpointFor(checkpointId, payload),
        metadataFor(writer, 1),
        { [CONFLICT.channel]: CONFLICT.version },
      );
      await witness.record("put", "returned", { writer });
    } catch (caught) {
      error = describeSqlError(caught);
      await witness.record("put", "raised", { writer, code: error.code });
    }

    const outcome: ConflictOutcome = {
      party: context.party,
      error,
      writer,
      wrote: { checkpointId, payload, channel: CONFLICT.channel, version: CONFLICT.version },
    };
    return outcome as unknown as Record<string, unknown>;
  } finally {
    await Promise.allSettled([subject.close(), probe.close()]);
  }
}

/**
 * Two `putWrites()` calls under ONE task id and one idx, so the
 * `checkpoint_writes` primary key collides.
 *
 * The channel decides the clause, and that is the entire point of the pair: an
 * ordinary channel takes the DO NOTHING branch, while a channel in
 * `WRITES_IDX_MAP` takes DO UPDATE. Same method, same table, opposite outcome.
 */
async function putWritesConflict(
  context: PartyContext,
  options: { channel: string },
): Promise<Record<string, unknown>> {
  const probe = probePool(context);
  const subject = subjectPool(context);
  const threadId = threadForCase(context.caseId);
  const writer = `p${context.party}`;
  const payload = CONFLICT.payloadByParty[context.party] ?? `party-${context.party}`;

  try {
    const witness = createProbe(probe, context.caseId, context.party, context.member);
    const saver = new PostgresSaver(subject.pool, undefined, { schema: CHECKPOINT_SCHEMA });

    await atBarrier(probe, context, witness, "ready");

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
        [[options.channel, payload]],
        CONFLICT.taskId,
      );
      await witness.record("putWrites", "returned", { writer });
    } catch (caught) {
      error = describeSqlError(caught);
      await witness.record("putWrites", "raised", { writer, code: error.code });
    }

    return {
      party: context.party,
      error,
      writer,
      wrote: { channel: options.channel, payload, taskId: CONFLICT.taskId },
    };
  } finally {
    await Promise.allSettled([subject.close(), probe.close()]);
  }
}

const B09_CHECKPOINTS = ["b09-cp-0", "b09-cp-1", "b09-cp-2", "b09-cp-3", "b09-cp-4"];

/** Has the writer recorded that it finished? Read from the independent probe. */
async function writerHasFinished(db: Db, caseId: string): Promise<boolean> {
  const { rows } = await db.pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM ${PROBE_SCHEMA}.event
      WHERE case_id = $1 AND node = 'writer' AND phase = 'done'`,
    [caseId],
  );
  return (rows[0]?.n ?? 0) > 0;
}

/**
 * A reader sampling raw rows while a writer commits a chain of checkpoints.
 *
 * The claim under test is that a reader never observes a checkpoint row whose
 * referenced blobs are absent — meaningful only if the reader actually sampled
 * DURING the writes.
 *
 * The first version left that to chance: both parties were released from one
 * barrier and simply ran. In `verify-v1` repeat 1 the writer committed all five
 * checkpoints before the reader issued its first query, so the reader sampled a
 * settled database, the anti-vacuity witness failed, and the main criteria were
 * vacuous for that repeat. That is the defect class this harness has already
 * recorded twice: a criterion decided by the interleaving rather than by the
 * behaviour — except here it was the guard AGAINST vacuity that was racy.
 *
 * The sampling window is now structural at both ends:
 *
 *   * the reader takes one sample and only THEN releases the writer, so an
 *     empty-chain observation is guaranteed rather than lucky;
 *   * the reader stops on the writer's durable `writer/done` probe row rather
 *     than on "I have seen five checkpoints", so it keeps sampling across the
 *     whole commit sequence and takes a final sample afterwards.
 *
 * `sawEmptyChain` and `sawCompleteChain` are therefore deterministic and are
 * digested; the intermediate counts remain scheduling and stay volatile.
 */
async function readUnderCommits(context: PartyContext): Promise<Record<string, unknown>> {
  const probe = probePool(context);
  const threadId = threadForCase(context.caseId);
  const witness = createProbe(probe, context.caseId, context.party, context.member);

  if (context.party === 0) {
    const subject = subjectPool(context);
    try {
      const saver = new PostgresSaver(subject.pool, undefined, { schema: CHECKPOINT_SCHEMA });
      await atBarrier(probe, context, witness, "ready");
      // Held until the reader has taken its first sample. Without this the
      // writer can finish the whole chain before the reader looks once.
      await waitForRelease(probe, context.caseId, "reader-sampled");

      let error: SqlError | null = null;
      let committed = 0;
      try {
        for (const [index, id] of B09_CHECKPOINTS.entries()) {
          await saver.put(
            {
              configurable: {
                thread_id: threadId,
                checkpoint_ns: "",
                ...(index === 0 ? {} : { checkpoint_id: B09_CHECKPOINTS[index - 1] }),
              },
            },
            checkpointFor(id, `payload-${index}`, String(index + 1)),
            metadataFor("writer", index),
            // A NEW version per step, so each checkpoint references its own blob
            // row. Reusing one version would make a missing blob unobservable.
            { [CONFLICT.channel]: String(index + 1) },
          );
          committed += 1;
        }
      } catch (caught) {
        error = describeSqlError(caught);
      }
      await witness.record("writer", "done", { committed });
      return { party: context.party, error, role: "writer", committed };
    } finally {
      await Promise.allSettled([subject.close(), probe.close()]);
    }
  }

  const inspect = inspectPool(context);
  try {
    await atBarrier(probe, context, witness, "ready");

    const samples: Array<{ checkpoints: number; stranded: number; broken: number }> = [];
    const deadline = Date.now() + TIMEOUTS.conditionWaitMs;
    let error: SqlError | null = null;

    try {
      // One sample BEFORE the writer is allowed to start. This is the half of
      // the window that used to be left to chance.
      samples.push(await sampleConsistency(inspect, threadId));
      await arrive(
        probe,
        context.caseId,
        "reader-sampled",
        context.party,
        context.member,
        witness.nonce,
      );
      await waitForRelease(probe, context.caseId, "reader-sampled");

      let writerDone = false;
      for (;;) {
        samples.push(await sampleConsistency(inspect, threadId));
        // One further sample after the writer's own row appears, so the settled
        // end of the chain is always observed too.
        if (writerDone) break;
        writerDone = await writerHasFinished(probe, context.caseId);
        if (Date.now() > deadline) break;
      }
    } catch (caught) {
      error = describeSqlError(caught);
    }

    const counts = [...new Set(samples.map((sample) => sample.checkpoints))];
    return {
      party: context.party,
      error,
      role: "reader",
      samples: samples.length,
      // Structural now, and digested: the rendezvous guarantees the empty
      // observation and the `writer/done` stop guarantees the complete one.
      sawEmptyChain: counts.includes(0),
      sawCompleteChain: counts.includes(B09_CHECKPOINTS.length),
      // The anti-vacuity witness: more than one distinct count proves the reader
      // was looking while the writer was still committing.
      distinctCheckpointCounts: counts.length,
      samplesWithStrandedReferences: samples.filter((sample) => sample.stranded > 0).length,
      samplesWithBrokenLineage: samples.filter((sample) => sample.broken > 0).length,
      observedCounts: counts.sort((left, right) => left - right),
    };
  } finally {
    await Promise.allSettled([inspect.close(), probe.close()]);
  }
}

// ---------------------------------------------------------------------------

export async function runFamilyBParty(context: PartyContext): Promise<Record<string, unknown>> {
  switch (context.caseId) {
    case "b01-graph-serial-baseline":
      return await graphSerialBaseline(context);

    case "b02-same-thread-parallel-resume":
      return await graphResume(context, { barrier: "resume-ready" });

    case "b03-same-thread-sequential-control":
      return await graphResume(context, {
        barrier: `gate-${context.party}`,
        after: `done-${context.party}`,
      });

    case "b04-put-conflict-metadata":
      return await putConflict(context, { sameCheckpointId: true, distinctPayloads: false });

    case "b05-blob-conflict-bytes":
      return await putConflict(context, { sameCheckpointId: false, distinctPayloads: true });

    case "b06-checkpoint-and-blob-split":
      return await putConflict(context, { sameCheckpointId: true, distinctPayloads: true });

    case "b07-putwrites-ordinary-channel":
      return await putWritesConflict(context, { channel: CONFLICT.ordinaryChannel });

    case "b08-putwrites-special-channel":
      return await putWritesConflict(context, { channel: CONFLICT.specialChannel });

    case "b09-read-under-concurrent-commits":
      return await readUnderCommits(context);

    default:
      throw new Error(`family B has no participant for case ${context.caseId}`);
  }
}

/**
 * Fixtures that must exist before any party starts.
 *
 * The resume cases need a COMMITTED interrupt: two workers cannot race to
 * consume one that does not exist yet, and creating it inside a party would make
 * the winner of the race also the author of the fixture.
 *
 * The putWrites cases need the checkpoint row their writes attach to. There is
 * no foreign key, so the rows would insert regardless — but a write pointing at
 * a checkpoint that never existed is not the situation being measured.
 */
export async function prepareFamilyB(caseId: string): Promise<Record<string, unknown>> {
  const context: PartyContext = { caseId, party: -1, member: "prepare" };
  const threadId = threadForCase(caseId);
  const probe = probePool(context);
  const subject = subjectPool(context);

  try {
    const witness = createProbe(probe, caseId, -1, "prepare");
    const saver = new PostgresSaver(subject.pool, undefined, { schema: CHECKPOINT_SCHEMA });

    if (caseId === "b02-same-thread-parallel-resume" || caseId === "b03-same-thread-sequential-control") {
      const graph = buildGraph(saver, witness);
      const first = await runToInterrupt(graph, threadId);
      const inspect = inspectPool(context);
      try {
        const projection = await project(inspect, threadId);
        return {
          caseId,
          prepared: true,
          threadId,
          reachedInterrupt: first.interrupted,
          interruptRows: projection.interrupts.length,
          checkpointRows: projection.checkpoints.length,
          error: first.error,
        };
      } finally {
        await inspect.close().catch(() => {});
      }
    }

    if (caseId === "b07-putwrites-ordinary-channel" || caseId === "b08-putwrites-special-channel") {
      await saver.put(
        { configurable: { thread_id: threadId, checkpoint_ns: "" } },
        checkpointFor(CONFLICT.baseCheckpointId, "base"),
        metadataFor("prepare", 0),
        { [CONFLICT.channel]: CONFLICT.version },
      );
      return { caseId, prepared: true, threadId, baseCheckpointId: CONFLICT.baseCheckpointId };
    }

    return { caseId, prepared: false };
  } finally {
    await Promise.allSettled([subject.close(), probe.close()]);
  }
}
