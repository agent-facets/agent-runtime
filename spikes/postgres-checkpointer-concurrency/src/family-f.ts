// Family F: retention and blob reachability.
//
// The architecture needs a pruning rule it can actually implement, and
// `architecture/09-data-model-and-lifecycle.md` proposes one — live set =
// retained heads ∪ parent lineage ∪ referenced channel versions ∪ pending
// writes ∪ interrupts — without ever having been run against the real schema.
//
// Every case here uses TWO threads in one database:
//
//   retained   the thread the sweep is told to keep. Paused on a committed
//              interrupt, so "the prune preserved a resumable run" is a
//              measurement (resume it) rather than a row count.
//   stale      a completed run, the thing a retention policy exists to remove.
//
// Two threads rather than one because pruning is inherently cross-thread: within
// a single chain every checkpoint is an ancestor of the head, so a correct
// reachability sweep deletes nothing and the case would prove nothing. All the
// danger lives in deleting rows for one thread while another still points at
// them, which is why the witness here is `reachabilityAcross` over both.
//
// The controls are the point. `f05` prunes nothing and `f06` prunes the head, so
// "the sweep kept the run alive" is bracketed on both sides; `f07` runs a
// deliberately incomplete sweep that MUST leave detectable damage, or the
// completeness of the real one is unfalsifiable.

import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";

import { CHECKPOINT_SCHEMA, databaseForCase, threadForCase } from "./contract.ts";
import { appNameFor, describeSqlError, openDb, type Db, type SqlError } from "./db.ts";
import {
  createSink,
  instrumentPool,
  recordPark,
  type GateHook,
  type GateSpec,
} from "./gate.ts";
import { createProbe, type Probe } from "./probe.ts";
import { buildGraph, resume, runToInterrupt } from "./graph.ts";
import { project, reachabilityAcross } from "./inspect/checkpoints.ts";
import {
  naiveDeleteOldCheckpoints,
  naiveDeleteSupersededBlobs,
  reachabilitySweep,
  threadCounts,
  type SweepOmission,
} from "./prune.ts";
import type { PartyContext } from "./family-a.ts";

/** The thread the sweep keeps, and the completed one it is meant to remove. */
export function retainedThread(caseId: string): string {
  return threadForCase(caseId);
}
export function staleThread(caseId: string): string {
  return `${threadForCase(caseId)}-stale`;
}

function subjectPool(context: PartyContext): Db {
  return openDb(appNameFor(context.caseId, context.member, "subject"), "subject", {
    database: databaseForCase(context.caseId),
    max: 4,
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

/**
 * The state of the whole database, reduced to counts and to the four kinds of
 * damage a bad sweep produces.
 *
 * Ids never leave: `strandedReferences` and friends are reported as lengths,
 * because which checkpoint got stranded is a per-run uuid while HOW MANY is the
 * result. The one exception is `sharingMax`, an integer that answers the "do
 * unchanged channel versions share blob rows" question directly.
 */
async function surveyState(
  inspect: Db,
  caseId: string,
): Promise<Record<string, unknown>> {
  const threads = [retainedThread(caseId), staleThread(caseId)];
  const witness = await reachabilityAcross(inspect, threads);
  const counts = await threadCounts(inspect, threads);
  return {
    counts,
    strandedReferences: witness.strandedReferences.length,
    orphanBlobs: witness.orphanBlobs.length,
    brokenLineage: witness.brokenLineage.length,
    deadWrites: witness.deadWrites.length,
    // > 1 means one blob row is referenced by several live checkpoints, which is
    // exactly the sharing that makes version-based blob deletion unsafe.
    sharingMax: witness.sharing.reduce((max, row) => Math.max(max, row.referencedBy), 0),
    sharedVersions: witness.sharing.filter((row) => row.referencedBy > 1).length,
  };
}

type Survey = Record<string, unknown>;

/**
 * The shared shape of every case: look, act, look again, then try to resume the
 * thread the policy claimed to keep.
 *
 * Resuming is not decoration. A retention sweep that leaves a structurally tidy
 * database but an unresumable run has failed at the only thing it was for, and
 * row counts cannot tell the difference.
 */
async function pruneCase(
  context: PartyContext,
  act: (db: Db, inspect: Db) => Promise<Record<string, unknown>>,
  options: { resumeAfter?: boolean } = {},
): Promise<Record<string, unknown>> {
  const probe = probePool(context);
  const subject = subjectPool(context);
  const inspect = inspectPool(context);

  try {
    const witness = createProbe(probe, context.caseId, context.party, context.member);
    const before: Survey = await surveyState(inspect, context.caseId);
    const action = await act(subject, inspect);
    const after: Survey = await surveyState(inspect, context.caseId);

    let resumed: Record<string, unknown> | null = null;
    if (options.resumeAfter !== false) {
      const saver = new PostgresSaver(subject.pool, undefined, { schema: CHECKPOINT_SCHEMA });
      const graph = buildGraph(saver, witness);
      const run = await resume(graph, retainedThread(context.caseId));
      resumed = {
        error: run.error,
        interrupted: run.interrupted,
        completed: run.error === null && run.interrupted === false,
        steps: run.steps,
      };
    }

    return {
      party: context.party,
      error: null,
      before,
      action,
      after,
      resumed,
      // The load-bearing summary. A sweep that damaged nothing has both false.
      introducedStrandedReferences:
        Number(after.strandedReferences ?? 0) > Number(before.strandedReferences ?? 0),
      introducedBrokenLineage:
        Number(after.brokenLineage ?? 0) > Number(before.brokenLineage ?? 0),
    };
  } catch (caught) {
    return { party: context.party, error: describeSqlError(caught) };
  } finally {
    await Promise.allSettled([subject.close(), probe.close(), inspect.close()]);
  }
}

/**
 * The kill cases. Party 0 parks between two named DELETE statements and dies
 * there; party 1 then surveys the wreckage and tries to resume.
 *
 * Which delete it parks BEFORE is the entire experiment, so the gate is named
 * rather than positional: killing before the blob delete (safe order) should
 * leave harmless orphans, and killing before the checkpoint delete in the unsafe
 * order should leave stranded live references.
 */
async function killedPruner(
  context: PartyContext,
  options: { order: "safe" | "unsafe"; gate: GateSpec },
): Promise<Record<string, unknown>> {
  if (context.party !== 0) {
    return await pruneCase(context, async () => ({ role: "observer" }));
  }

  const probe = probePool(context);
  const subject = subjectPool(context);

  try {
    const sink = createSink();
    const park: GateHook = async (gate, statement) => {
      await recordPark(probe, context.caseId, context.party, gate, statement);
      await new Promise<never>(() => {});
    };
    instrumentPool(subject.pool, sink, [options.gate], park);

    await reachabilitySweep(subject, {
      retainThreads: [retainedThread(context.caseId)],
      order: options.order,
    });
    // Unreachable: the driver kills this container at the park.
    return { party: context.party, error: null, role: "pruner", parked: false };
  } catch (caught) {
    return { party: context.party, error: describeSqlError(caught) };
  } finally {
    await Promise.allSettled([subject.close(), probe.close()]);
  }
}

// ---------------------------------------------------------------------------

export async function runFamilyFParty(context: PartyContext): Promise<Record<string, unknown>> {
  const caseId = context.caseId;
  const retain = [retainedThread(caseId)];

  switch (caseId) {
    // Reads only. Establishes that a live checkpoint references a blob version
    // written several supersteps earlier, which is what makes f03 dangerous.
    case "f01-blob-sharing-baseline":
      return await pruneCase(context, async () => ({ role: "observer" }), { resumeAfter: false });

    case "f02-naive-checkpoint-deletion-by-date":
      return await pruneCase(context, async (db) => ({
        policy: "keep the newest 2 checkpoints by checkpoint ts",
        ...(await naiveDeleteOldCheckpoints(db, retainedThread(caseId), 2)),
      }));

    case "f03-naive-superseded-blob-deletion":
      return await pruneCase(context, async (db) => ({
        policy: "delete every blob version superseded by a newer one",
        ...(await naiveDeleteSupersededBlobs(db, retainedThread(caseId))),
      }));

    case "f04-reachability-sweep-retains-a-paused-thread":
      return await pruneCase(context, async (db) =>
        await reachabilitySweep(db, { retainThreads: retain }),
      );

    case "f05-prune-nothing-control":
      return await pruneCase(context, async (db) =>
        await reachabilitySweep(db, {
          retainThreads: [retainedThread(caseId), staleThread(caseId)],
        }),
      );

    case "f06-prune-head-control":
      return await pruneCase(context, async (db) =>
        await reachabilitySweep(db, { retainThreads: [] }),
      );

    case "f07-incomplete-sweep-omits-channel-versions":
      return await pruneCase(context, async (db) =>
        await reachabilitySweep(db, {
          retainThreads: retain,
          omit: "channel-versions" satisfies SweepOmission,
        }),
      );

    case "f08-incomplete-sweep-omits-ancestors":
      return await pruneCase(context, async (db) =>
        await reachabilitySweep(db, {
          retainThreads: retain,
          omit: "ancestors" satisfies SweepOmission,
        }),
      );

    case "f09-kill-pruner-safe-order":
      return await killedPruner(context, {
        order: "safe",
        gate: { name: "before-blob-delete", label: "ckpt.delete-blobs", ordinal: 1, position: "pre" },
      });

    case "f10-kill-pruner-unsafe-order-control":
      return await killedPruner(context, {
        order: "unsafe",
        gate: {
          name: "before-checkpoint-delete",
          label: "ckpt.delete-checkpoints",
          ordinal: 1,
          position: "pre",
        },
      });

    default:
      throw new Error(`family F has no participant for case ${context.caseId}`);
  }
}

/**
 * Both threads, built before any party starts.
 *
 * The retained thread is left PAUSED on a committed interrupt, because the
 * strongest claim a sweep can make is that the run it kept is still resumable —
 * and a completed thread cannot demonstrate that. The stale thread is run to
 * completion, which is what makes it a legitimate candidate for deletion rather
 * than an arbitrary victim.
 */
export async function prepareFamilyF(caseId: string): Promise<Record<string, unknown>> {
  const context: PartyContext = { caseId, party: -1, member: "prepare" };
  const probe = probePool(context);
  const subject = subjectPool(context);
  const inspect = inspectPool(context);

  try {
    const witness = createProbe(probe, caseId, -1, "prepare");
    const saver = new PostgresSaver(subject.pool, undefined, { schema: CHECKPOINT_SCHEMA });
    const graph = buildGraph(saver, witness);

    const paused = await runToInterrupt(graph, retainedThread(caseId));

    const stale = await runToInterrupt(graph, staleThread(caseId));
    const staleDone = await resume(graph, staleThread(caseId));

    const retainedProjection = await project(inspect, retainedThread(caseId));
    const staleProjection = await project(inspect, staleThread(caseId));

    return {
      caseId,
      prepared: true,
      retainedReachedInterrupt: paused.interrupted,
      retainedCheckpoints: retainedProjection.checkpoints.length,
      retainedInterruptRows: retainedProjection.interrupts.length,
      staleReachedInterrupt: stale.interrupted,
      staleCompleted: staleDone.error === null && staleDone.interrupted === false,
      staleCheckpoints: staleProjection.checkpoints.length,
      error: paused.error ?? stale.error ?? staleDone.error,
    };
  } finally {
    await Promise.allSettled([subject.close(), probe.close(), inspect.close()]);
  }
}
