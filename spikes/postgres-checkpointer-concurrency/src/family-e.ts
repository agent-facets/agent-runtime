// Family E: subgraph namespaces and lifecycle.
//
// The architecture needs three things from subgraph namespaces, none of which
// the package documents:
//
//   1. A subgraph's checkpoints are addressable SEPARATELY from its parent's, so
//      a nested run can be resumed, inspected and pruned without the parent's
//      lineage being read as one flat chain.
//   2. Two instances of the same subgraph do not share a namespace, or a fan-out
//      over one sub-workflow would silently overwrite itself.
//   3. Nothing the runtime does depends on the namespace STRING format, which is
//      an internal encoding the vendor may change.
//
// Every case here reads lineage from the raw tables, per namespace, and counts
// executions from the independent probe. `e02` is the control the rest of the
// family rests on: the same node bodies arranged without subgraphs. Without it,
// "three namespaces appeared" is a fact about this graph rather than evidence
// about subgraphs.

import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";

import { CHECKPOINT_SCHEMA, databaseForCase, threadForCase } from "./contract.ts";
import { appNameFor, describeSqlError, openDb, type Db, type SqlError } from "./db.ts";
import { arrive, waitForRelease } from "./barrier.ts";
import { recordNodePark } from "./gate.ts";
import { createProbe, type Probe } from "./probe.ts";
import { project } from "./inspect/checkpoints.ts";
import {
  buildDeepGraph,
  buildInlinedGraph,
  buildNestedGraph,
  buildParallelSubgraphGraph,
  buildRootFanoutGraph,
  buildSubgraphFanoutGraph,
  buildSubgraphInterruptGraph,
  invokeNested,
  type AnyGraph,
  type NestedRun,
} from "./subgraphs.ts";
import type { PartyContext } from "./family-a.ts";

const SEED = { steps: [], decision: "" };

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

async function atBarrier(
  probe: Db,
  context: PartyContext,
  witness: Probe,
  name: string,
): Promise<void> {
  await arrive(probe, context.caseId, name, context.party, context.member, witness.nonce);
  await waitForRelease(probe, context.caseId, name);
}

/**
 * Namespace facts read from the rows, computed WITHOUT parsing the vendor's
 * separators.
 *
 * `depth` is derived from containment — how many other namespaces are proper
 * prefixes of this one — rather than by counting `|` characters. That keeps the
 * plan's "no dependency on the namespace string format" rule true of the
 * harness itself, not just of the report, while still measuring the nesting the
 * architecture cares about. The literal strings never leave this function; only
 * their shape does.
 */
function namespaceShape(namespaces: string[]): {
  count: number;
  rootPresent: boolean;
  depths: number[];
  maxDepth: number;
  distinct: boolean;
  /** Namespaces that share a parent, keyed by how many siblings each parent has. */
  siblingGroups: number[];
} {
  const depths = namespaces.map(
    (ns) => namespaces.filter((other) => other !== ns && ns.startsWith(other)).length,
  );
  const parentOf = (ns: string): string => {
    const ancestors = namespaces.filter((other) => other !== ns && ns.startsWith(other));
    return ancestors.reduce((longest, other) => (other.length > longest.length ? other : longest), "");
  };
  const groups = new Map<string, number>();
  for (const ns of namespaces) {
    if (ns === "") continue;
    const parent = parentOf(ns);
    groups.set(parent, (groups.get(parent) ?? 0) + 1);
  }

  return {
    count: namespaces.length,
    rootPresent: namespaces.includes(""),
    depths: depths.slice().sort((left, right) => left - right),
    maxDepth: depths.length > 0 ? Math.max(...depths) : 0,
    distinct: new Set(namespaces).size === namespaces.length,
    siblingGroups: [...groups.values()].sort((left, right) => left - right),
  };
}

type ChainShape = { rows: number; roots: number; leaves: number; danglingParents: number };

export type NamespaceLineage = {
  shape: ReturnType<typeof namespaceShape>;
  chains: ChainShape[];
  crossNamespaceParents: number;
  interruptsInRootNamespace: number;
  interruptsInChildNamespace: number;
};

/**
 * Per-namespace lineage, read straight from `checkpoints`.
 *
 * The raw namespace STRINGS deliberately do not leave this function. They embed
 * an engine-generated task id, so they are as volatile as a timestamp and would
 * make every repeat differ; the projector already carries a canonicalised copy
 * for evidence. What comes back is shape and counts, which is what the criteria
 * ask about and what stays stable across runs.
 *
 * `chains` is ordered by content rather than by namespace, for the same reason:
 * sorting the raw strings would order the array by a volatile value.
 */
async function lineageByNamespace(inspect: Db, threadId: string): Promise<NamespaceLineage> {
  const projection = await project(inspect, threadId);
  const namespaces = [...new Set(projection.checkpoints.map((row) => row.checkpoint_ns))];

  const chains = namespaces
    .map((ns) => {
      const rows = projection.checkpoints.filter((row) => row.checkpoint_ns === ns);
      const ids = new Set(rows.map((row) => row.checkpoint_id));
      const claimed = new Set(
        rows.map((row) => row.parent_checkpoint_id).filter((id): id is string => id !== null),
      );
      return {
        rows: rows.length,
        roots: rows.filter((row) => row.parent_checkpoint_id === null).length,
        leaves: rows.filter((row) => !claimed.has(row.checkpoint_id)).length,
        danglingParents: rows.filter(
          (row) => row.parent_checkpoint_id !== null && !ids.has(row.parent_checkpoint_id),
        ).length,
      };
    })
    .sort((left, right) => {
      const a = JSON.stringify(left);
      const b = JSON.stringify(right);
      return a < b ? -1 : a > b ? 1 : 0;
    });

  // `metadata -> 'parents'` is how a subgraph checkpoint names its ancestors in
  // OTHER namespaces. Counted as an edge tally rather than read as a path, so
  // the criterion is "subgraph checkpoints are linked to their parent run" and
  // not "the vendor spells the link this way".
  const crossNamespaceParents = projection.checkpoints.filter(
    (row) => row.parents !== null && Object.keys(row.parents).length > 0,
  ).length;

  return {
    shape: namespaceShape(namespaces.slice().sort()),
    chains,
    crossNamespaceParents,
    // Where an interrupt raised inside a subgraph actually lands. If it landed
    // in the root namespace the child namespace would be cosmetic, and every
    // per-namespace resume claim below it would be empty.
    interruptsInRootNamespace: projection.interrupts.filter((row) => row.checkpoint_ns === "").length,
    interruptsInChildNamespace: projection.interrupts.filter((row) => row.checkpoint_ns !== "").length,
  };
}

type NamespaceOutcome = {
  party: number;
  error: SqlError | null;
  threadId: string;
  runs: NestedRun[];
} & NamespaceLineage;

/**
 * One process runs a whole topology and then reads its own lineage back from the
 * tables.
 *
 * The read is on an INSPECT pool, not the subject pool: a projection taken
 * through the connection that just wrote it would still be a raw-SQL read, but
 * routing it separately keeps the subject's statement log free of the harness's
 * own queries, which several criteria count.
 */
async function topology(
  context: PartyContext,
  build: (saver: PostgresSaver, witness: Probe) => AnyGraph,
  options: { passes?: Array<{ resume?: boolean; input?: Record<string, unknown> | null }> } = {},
): Promise<Record<string, unknown>> {
  const probe = probePool(context);
  const subject = subjectPool(context);
  const inspect = inspectPool(context);
  const threadId = threadForCase(context.caseId);

  try {
    const witness = createProbe(probe, context.caseId, context.party, context.member);
    const saver = new PostgresSaver(subject.pool, undefined, { schema: CHECKPOINT_SCHEMA });
    const graph = build(saver, witness);

    const passes = options.passes ?? [{ input: SEED }];
    const runs: NestedRun[] = [];
    for (const pass of passes) {
      runs.push(await invokeNested(graph, threadId, pass));
    }

    const lineage = await lineageByNamespace(inspect, threadId);
    const outcome: NamespaceOutcome = {
      party: context.party,
      error: null,
      threadId,
      runs,
      ...lineage,
    };
    return outcome as unknown as Record<string, unknown>;
  } catch (caught) {
    return { party: context.party, error: describeSqlError(caught), threadId };
  } finally {
    await Promise.allSettled([subject.close(), probe.close(), inspect.close()]);
  }
}

/**
 * Party 0 parks inside a SUBGRAPH node and is killed there; party 1 then picks
 * the run up with `input: null`.
 *
 * The park is inside `sub_b`, so the victim dies with the subgraph's namespace
 * already created and that node's writes not yet stored. What the case measures
 * is whether the resume re-enters the same namespace rather than starting a new
 * one, and whether the subgraph's chain is still singly-rooted afterwards.
 */
async function subgraphCrashResume(context: PartyContext): Promise<Record<string, unknown>> {
  const probe = probePool(context);
  const subject = subjectPool(context);
  const inspect = inspectPool(context);
  const threadId = threadForCase(context.caseId);

  try {
    const witness = createProbe(probe, context.caseId, context.party, context.member);
    const saver = new PostgresSaver(subject.pool, undefined, { schema: CHECKPOINT_SCHEMA });

    if (context.party === 0) {
      const graph = buildNestedGraph(saver, witness, {
        parkAt: "sub_b",
        park: async (node) => {
          await recordNodePark(probe, context.caseId, context.party, "inside-subgraph-node", node);
          return await new Promise<never>(() => {});
        },
      });
      const run = await invokeNested(graph, threadId, { input: SEED });
      // Unreachable: the driver kills this container at the park.
      return { party: context.party, error: null, role: "victim", run };
    }

    const graph = buildNestedGraph(saver, witness);
    const run = await invokeNested(graph, threadId, { input: null });
    const lineage = await lineageByNamespace(inspect, threadId);
    return {
      party: context.party,
      error: null,
      role: "resumer",
      threadId,
      runs: [run],
      completed: run.error === null && run.interrupted === false,
      ...lineage,
    };
  } catch (caught) {
    return { party: context.party, error: describeSqlError(caught), threadId };
  } finally {
    await Promise.allSettled([subject.close(), probe.close(), inspect.close()]);
  }
}

/**
 * Pending-write reuse, run at one nesting level or the other.
 *
 * Party 0 runs a two-sibling fan-out with one sibling failing, so the superstep
 * aborts with the OTHER sibling's write already durable. Party 1 runs the same
 * topology without the failure and resumes. The probe then answers which sibling
 * re-executed: a reused pending write shows the fast sibling executing once
 * across both parties, while the failed one shows two.
 *
 * `nested` is the only difference between e07 and its e09 control, so a
 * difference in reuse can be attributed to the subgraph boundary and to nothing
 * else. Spike 05 measured reuse at the root after a SIGKILL; running the root
 * variant here with a THROWN error keeps that second variable pinned too.
 */
async function pendingWriteReuse(
  context: PartyContext,
  options: { nested: boolean },
): Promise<Record<string, unknown>> {
  const probe = probePool(context);
  const subject = subjectPool(context);
  const inspect = inspectPool(context);
  const threadId = threadForCase(context.caseId);

  try {
    const witness = createProbe(probe, context.caseId, context.party, context.member);
    const saver = new PostgresSaver(subject.pool, undefined, { schema: CHECKPOINT_SCHEMA });
    const build = options.nested ? buildSubgraphFanoutGraph : buildRootFanoutGraph;
    const graph = build(saver, witness, { failSibling: context.party === 0 });

    const run = await invokeNested(graph, threadId, {
      input: context.party === 0 ? SEED : null,
    });
    const lineage = await lineageByNamespace(inspect, threadId);

    return {
      party: context.party,
      error: null,
      role: context.party === 0 ? "failing" : "resuming",
      threadId,
      runs: [run],
      failed: run.error !== null,
      completed: run.error === null && run.interrupted === false,
      ...lineage,
    };
  } catch (caught) {
    return { party: context.party, error: describeSqlError(caught), threadId };
  } finally {
    await Promise.allSettled([subject.close(), probe.close(), inspect.close()]);
  }
}

/**
 * Two containers resume the same committed SUBGRAPH interrupt simultaneously.
 *
 * Family B established that two workers can both consume a root-level interrupt.
 * This asks whether the subgraph namespace changes that — it does not
 * automatically, because nothing in the namespace mechanism is a lock, but a
 * fork one level down produces a different shape (two leaves in the CHILD
 * namespace) and that shape is what the pruning and resume algorithms would
 * later have to cope with.
 */
async function subgraphConcurrentResume(context: PartyContext): Promise<Record<string, unknown>> {
  const probe = probePool(context);
  const subject = subjectPool(context);
  const threadId = threadForCase(context.caseId);

  try {
    const witness = createProbe(probe, context.caseId, context.party, context.member);
    const saver = new PostgresSaver(subject.pool, undefined, { schema: CHECKPOINT_SCHEMA });
    const graph = buildSubgraphInterruptGraph(saver, witness);

    // Constructed before the barrier so pool setup and graph compilation are not
    // part of what the parties race on.
    await atBarrier(probe, context, witness, "resume-ready");

    const run = await invokeNested(graph, threadId, { resume: true });
    return {
      party: context.party,
      error: null,
      threadId,
      runs: [run],
      completed: run.error === null && run.interrupted === false,
    };
  } catch (caught) {
    return { party: context.party, error: describeSqlError(caught), threadId };
  } finally {
    await Promise.allSettled([subject.close(), probe.close()]);
  }
}

// ---------------------------------------------------------------------------

export async function runFamilyEParty(context: PartyContext): Promise<Record<string, unknown>> {
  switch (context.caseId) {
    case "e01-nested-subgraph-baseline":
      return await topology(context, (saver, witness) => buildNestedGraph(saver, witness));

    case "e02-inlined-graph-control":
      return await topology(context, (saver, witness) => buildInlinedGraph(saver, witness));

    case "e03-parallel-subgraph-instances":
      return await topology(context, (saver, witness) => buildParallelSubgraphGraph(saver, witness));

    case "e04-subgraph-interrupt-and-resume":
      return await topology(context, (saver, witness) => buildSubgraphInterruptGraph(saver, witness), {
        passes: [{ input: SEED }, { resume: true }],
      });

    case "e05-subgraph-crash-resume":
      return await subgraphCrashResume(context);

    case "e06-nested-depth-two":
      return await topology(context, (saver, witness) => buildDeepGraph(saver, witness));

    case "e07-subgraph-pending-write-reuse":
      return await pendingWriteReuse(context, { nested: true });

    case "e09-root-fanout-pending-write-reuse-control":
      return await pendingWriteReuse(context, { nested: false });

    case "e08-subgraph-concurrent-resume":
      return await subgraphConcurrentResume(context);

    default:
      throw new Error(`family E has no participant for case ${context.caseId}`);
  }
}

/**
 * The concurrent-resume case needs a COMMITTED subgraph interrupt before either
 * party starts. Building it inside a party would make the winner of the race
 * also the author of the fixture it raced for.
 */
export async function prepareFamilyE(caseId: string): Promise<Record<string, unknown>> {
  if (caseId !== "e08-subgraph-concurrent-resume") return { caseId, prepared: false };

  const context: PartyContext = { caseId, party: -1, member: "prepare" };
  const probe = probePool(context);
  const subject = subjectPool(context);
  const inspect = inspectPool(context);
  const threadId = threadForCase(caseId);

  try {
    const witness = createProbe(probe, caseId, -1, "prepare");
    const saver = new PostgresSaver(subject.pool, undefined, { schema: CHECKPOINT_SCHEMA });
    const graph = buildSubgraphInterruptGraph(saver, witness);

    const first = await invokeNested(graph, threadId, { input: SEED });
    const projection = await project(inspect, threadId);

    return {
      caseId,
      prepared: true,
      threadId,
      reachedInterrupt: first.interrupted,
      interruptRows: projection.interrupts.length,
      // Where the interrupt is stored matters: an interrupt raised inside a
      // subgraph that landed in the ROOT namespace would mean the namespace is
      // cosmetic, and every per-namespace claim below it would be empty. Counted
      // rather than named, because the namespace string is volatile.
      interruptsInChildNamespace: projection.interrupts.filter((row) => row.checkpoint_ns !== "")
        .length,
      namespaceCount: new Set(projection.checkpoints.map((row) => row.checkpoint_ns)).size,
      error: first.error,
    };
  } finally {
    await Promise.allSettled([subject.close(), probe.close(), inspect.close()]);
  }
}
