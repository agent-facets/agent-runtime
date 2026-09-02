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
 * The head of a thread's root namespace: the row no sibling claims as a parent.
 *
 * A forked thread has more than one, so the newest is taken — which is exactly
 * the choice a retention policy makes when it keeps "the current state of this
 * run" and lets the abandoned branch go.
 */
async function liveHead(
  inspect: Db,
  threadId: string,
): Promise<{ threadId: string; ns: string; checkpointId: string } | null> {
  const projection = await project(inspect, threadId);
  const rows = projection.checkpoints.filter((row) => row.checkpoint_ns === "");
  const claimed = new Set(
    rows.map((row) => row.parent_checkpoint_id).filter((id): id is string => id !== null),
  );
  const leaves = rows.filter((row) => !claimed.has(row.checkpoint_id));
  const chosen = leaves.at(-1) ?? rows.at(-1);
  return chosen ? { threadId, ns: "", checkpointId: chosen.checkpoint_id } : null;
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
  const retained = retainedThread(caseId);
  const stale = staleThread(caseId);
  const threads = [retained, stale];
  const witness = await reachabilityAcross(inspect, threads);
  const counts = await threadCounts(inspect, threads);

  // Damage is counted PER THREAD, not as one scalar over both.
  //
  // A single total let f10 claim that an unsafe delete order "corrupts the
  // database" when every stranded reference it produced belonged to the stale
  // thread the sweep was halfway through deleting — rows already condemned. The
  // question that matters is whether the thread the policy promised to KEEP was
  // damaged, and that is only visible once the two are separated.
  const onThread = (thread: string) => ({
    strandedReferences: witness.strandedReferences.filter((row) => row.thread_id === thread).length,
    orphanBlobs: witness.orphanBlobs.filter((row) => row.thread_id === thread).length,
    brokenLineage: witness.brokenLineage.filter((row) => row.thread_id === thread).length,
    deadWrites: witness.deadWrites.filter((row) => row.thread_id === thread).length,
  });

  return {
    counts,
    strandedReferences: witness.strandedReferences.length,
    orphanBlobs: witness.orphanBlobs.length,
    brokenLineage: witness.brokenLineage.length,
    deadWrites: witness.deadWrites.length,
    retainedDamage: onThread(retained),
    staleDamage: onThread(stale),
    // Per THREAD. Grouping across threads summed two independent runs of the
    // same graph and inflated this from 2 to 6.
    sharingMax: witness.sharing.reduce((max, row) => Math.max(max, row.referencedBy), 0),
    sharedVersions: witness.sharing.filter((row) => row.referencedBy > 1).length,
    retainedSharingMax: witness.sharing
      .filter((row) => row.thread_id === retained)
      .reduce((max, row) => Math.max(max, row.referencedBy), 0),
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
  options: { order: "safe" | "unsafe"; gate: GateSpec; omit?: SweepOmission },
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
      ...(options.omit ? { omit: options.omit } : {}),
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

    // Head-scoped retention: the live set is walked from an explicit head, so a
    // branch the head does not descend from is prunable even though its thread
    // is retained. This is the rule the architecture proposes; whole-thread
    // retention can never exercise it.
    case "f11-head-scoped-sweep-prunes-an-abandoned-branch":
      return await pruneCase(context, async (db, inspect) => {
        const head = await liveHead(inspect, retainedThread(caseId));
        return {
          policy: "retain the live head and its ancestors",
          head: head !== null,
          ...(await reachabilitySweep(db, {
            retainThreads: retain,
            retainHeads: head ? [head] : [],
          })),
        };
      });

    case "f12-incomplete-sweep-omits-pending-writes":
      return await pruneCase(context, async (db) =>
        await reachabilitySweep(db, {
          retainThreads: retain,
          omit: "pending-writes" satisfies SweepOmission,
        }),
      );

    case "f13-incomplete-sweep-omits-interrupts":
      return await pruneCase(context, async (db) =>
        await reachabilitySweep(db, {
          retainThreads: retain,
          omit: "interrupts" satisfies SweepOmission,
        }),
      );

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

    // Unsafe order AND an incomplete rule. The omission is what puts the damage
    // in the RETAINED thread: without it the unsafe order only ever strands rows
    // the sweep was already halfway through deleting, which is inconsistent
    // garbage rather than corruption of anything the policy promised to keep.
    case "f10-kill-pruner-unsafe-order-control":
      return await killedPruner(context, {
        order: "unsafe",
        omit: "channel-versions",
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

    // An ABANDONED BRANCH on the retained thread.
    //
    // Head-scoped retention is only testable if some row of a kept thread is not
    // an ancestor of its head — otherwise "retained heads ∪ parent lineage"
    // retains everything and the rule is vacuous. Resuming from an explicit
    // `checkpoint_id` forks: the engine writes a new `source: "fork"` checkpoint
    // whose parent is the named one and runs the tasks against it (measured in
    // h03), leaving two leaves where one is stale.
    let forked = false;
    const beforeFork = await project(inspect, retainedThread(caseId));
    const forkFrom = beforeFork.checkpoints
      .filter((row) => row.checkpoint_ns === "" && row.parent_checkpoint_id !== null)
      .at(0);
    if (forkFrom) {
      const branch = await resume(graph, retainedThread(caseId), forkFrom.checkpoint_id);
      forked = branch.error === null;
    }

    const stale = await runToInterrupt(graph, staleThread(caseId));
    const staleDone = await resume(graph, staleThread(caseId));

    const retainedProjection = await project(inspect, retainedThread(caseId));
    const staleProjection = await project(inspect, staleThread(caseId));

    return {
      caseId,
      prepared: true,
      retainedReachedInterrupt: paused.interrupted,
      retainedHasAbandonedBranch: forked,
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
