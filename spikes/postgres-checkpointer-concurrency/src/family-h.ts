// Family H, effect-key half: is the proposed idempotency key computable, stable,
// and discriminating?
//
// `architecture/09-data-model-and-lifecycle.md` proposes
// `hash(run, ns, parent_checkpoint, task, ordinal, tool, canonical_args)` and
// then says, in the document itself, that the two properties the ledger depends
// on are "assumed, not measured":
//
//   * the key is the SAME across a crash resume, so a redelivered run does not
//     repeat an effect that already happened;
//   * the key is DIFFERENT across a genuine fork, so a deliberate replay does
//     repeat it.
//
// Those are the two cases below that matter (h02, h03). The rest exist to stop
// them being unfalsifiable: h05 and h06 ablate one component at a time and show
// the ablated key COLLIDES where the full key does not, h04 characterises what a
// non-`sync` durability mode does to the key, and h07 asks whether any of it
// survives one namespace down.
//
// Nothing here is a vendor claim. LangGraph publishes no effect key. Every
// component is either supplied by the runtime (`tool`, `canonical_args`,
// `ordinal`) or scavenged from the config the engine hands a node, and where
// that scavenging needs a private key the record says so.

import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";

import { CHECKPOINT_SCHEMA, PROBE_SCHEMA, databaseForCase, threadForCase } from "./contract.ts";
import { appNameFor, describeSqlError, openDb, type Db, type SqlError } from "./db.ts";
import { recordNodePark } from "./gate.ts";
import { createProbe, type Probe } from "./probe.ts";
import { recordEffect } from "./effect-key.ts";
import { stable } from "./canonical.ts";
import { compareManifests, type GraphManifest } from "./graph-manifest.ts";
import { headOf, project } from "./inspect/checkpoints.ts";
import { invokeNested, type AnyGraph, type NestedRun } from "./subgraphs.ts";
import { buildBaseline, buildVariant, type VariantId } from "./variants.ts";
import type { PartyContext } from "./family-a.ts";

const EffectState = Annotation.Root({
  steps: Annotation<string[]>({
    reducer: (left: string[], right: string[]) => left.concat(right),
    default: () => [],
  }),
});

const SEED = { steps: [] };

/** The changed-graph variants carry a `decision` channel too. */
const SEED_STATE = { steps: [], decision: "" };

/**
 * The tool and arguments every effect below declares.
 *
 * Deliberately IDENTICAL across siblings and across ordinals. If each effect
 * carried its own arguments the keys would differ for a reason that has nothing
 * to do with the orchestrator, and the ablation cases would prove nothing: a
 * `task`-less key only demonstrably collides when everything except the task is
 * the same, which is exactly the shape of a fan-out that calls one tool on every
 * branch.
 */
const TOOL = "spike.publish";
const ARGS = { target: "alpha", attempt: 1 };
/** A second, genuinely different call, so "the keys matched" is never vacuous. */
const OTHER_TOOL = "spike.notify";
const OTHER_ARGS = { target: "beta", attempt: 1 };

type ParkFn = (node: string) => Promise<never>;

type EffectNodeOptions = {
  tool?: string;
  args?: unknown;
  /** How many effects this single node execution performs. */
  count?: number;
  park?: ParkFn;
};

/**
 * A node that performs N proposed effects and then optionally parks.
 *
 * The park is AFTER the effects are recorded and BEFORE the node returns, so a
 * kill here lands with the effect durably witnessed and the task's writes not
 * yet stored — the exact state a crashed worker leaves behind, and the only
 * state in which the resume question is meaningful.
 */
function effectNode(witness: Probe, node: string, options: EffectNodeOptions = {}) {
  return async (_state: unknown, config: unknown) => {
    const count = options.count ?? 1;
    for (let ordinal = 0; ordinal < count; ordinal += 1) {
      await recordEffect(witness, config, {
        node,
        ordinal,
        tool: options.tool ?? TOOL,
        args: options.args ?? ARGS,
      });
    }
    if (options.park) await options.park(node);
    return { steps: [node] };
  };
}

/** `seed -> act -> tail`. `act` is the node every crash and fork case targets. */
function linearEffectGraph(
  saver: PostgresSaver,
  witness: Probe,
  options: { effects?: number; park?: ParkFn } = {},
) {
  return new StateGraph(EffectState)
    .addNode("seed", async () => {
      await witness.record("seed", "executed");
      return { steps: ["seed"] };
    })
    .addNode("act", effectNode(witness, "act", { count: options.effects ?? 1, park: options.park }))
    .addNode("tail", effectNode(witness, "tail", { tool: OTHER_TOOL, args: OTHER_ARGS }))
    .addEdge(START, "seed")
    .addEdge("seed", "act")
    .addEdge("act", "tail")
    .addEdge("tail", END)
    .compile({ checkpointer: saver });
}

/**
 * Three siblings in ONE superstep, all calling the same tool with the same
 * arguments.
 *
 * Same run, same namespace, same parent checkpoint, same ordinal, same tool,
 * same args — every proposed component except `task` is identical. So the full
 * key must produce three distinct values and the `task`-less key exactly one,
 * and that difference is the measurement that `task` is load-bearing.
 */
function fanoutEffectGraph(saver: PostgresSaver, witness: Probe) {
  return new StateGraph(EffectState)
    .addNode("seed", async () => {
      await witness.record("seed", "executed");
      return { steps: ["seed"] };
    })
    .addNode("fan_a", effectNode(witness, "fan_a"))
    .addNode("fan_b", effectNode(witness, "fan_b"))
    .addNode("fan_c", effectNode(witness, "fan_c"))
    .addNode("join", async () => {
      await witness.record("join", "executed");
      return { steps: ["join"] };
    })
    .addEdge(START, "seed")
    .addEdge("seed", "fan_a")
    .addEdge("seed", "fan_b")
    .addEdge("seed", "fan_c")
    .addEdge("fan_a", "join")
    .addEdge("fan_b", "join")
    .addEdge("fan_c", "join")
    .addEdge("join", END)
    .compile({ checkpointer: saver });
}

/**
 * The same effect performed at the root and inside a subgraph.
 *
 * Both call the same tool with the same arguments, so anything that separates
 * their keys comes from the orchestration context rather than from the call —
 * which is what makes this a test of whether `ns` and `parent_checkpoint` are
 * recoverable one level down rather than a test of hashing.
 */
function subgraphEffectGraph(saver: PostgresSaver, witness: Probe) {
  const inner = new StateGraph(EffectState)
    .addNode("sub_act", effectNode(witness, "sub_act"))
    .addEdge(START, "sub_act")
    .addEdge("sub_act", END)
    .compile();

  return new StateGraph(EffectState)
    .addNode("root_act", effectNode(witness, "root_act"))
    .addNode("inner", inner)
    .addEdge(START, "root_act")
    .addEdge("root_act", "inner")
    .addEdge("inner", END)
    .compile({ checkpointer: saver });
}

// ---------------------------------------------------------------------------

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

/** One process, one pass. The reconstruction is done by the projector, not here. */
async function singlePass(
  context: PartyContext,
  build: (saver: PostgresSaver, witness: Probe) => AnyGraph,
  options: { durability?: "sync" | "async" | "exit" } = {},
): Promise<Record<string, unknown>> {
  const probe = probePool(context);
  const subject = subjectPool(context);
  const threadId = threadForCase(context.caseId);

  try {
    const witness = createProbe(probe, context.caseId, context.party, context.member);
    const saver = new PostgresSaver(subject.pool, undefined, { schema: CHECKPOINT_SCHEMA });
    const run = await invokeNested(build(saver, witness), threadId, {
      input: SEED,
      durability: options.durability,
    });
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

/**
 * Party 0 records its effect, parks inside the node, and is killed there. Party
 * 1 picks the run up with `input: null`, which resumes from the persisted head
 * rather than restarting from START.
 *
 * `durability` is the variable: under `sync` the superstep that scheduled `act`
 * is on disk before `act` runs, so the resume computes the key against the same
 * parent checkpoint. Under `async` the checkpoint write is not awaited, so the
 * superstep may be lost — and a lost superstep means a different parent
 * checkpoint, a different task id, and a key that no longer matches the effect
 * that already happened.
 */
async function crashResume(
  context: PartyContext,
  options: { durability: "sync" | "async" },
): Promise<Record<string, unknown>> {
  const probe = probePool(context);
  const subject = subjectPool(context);
  const threadId = threadForCase(context.caseId);

  try {
    const witness = createProbe(probe, context.caseId, context.party, context.member);
    const saver = new PostgresSaver(subject.pool, undefined, { schema: CHECKPOINT_SCHEMA });

    if (context.party === 0) {
      const graph = linearEffectGraph(saver, witness, {
        park: async (node) => {
          await recordNodePark(probe, context.caseId, context.party, "after-effect", node);
          return await new Promise<never>(() => {});
        },
      });
      const run = await invokeNested(graph, threadId, {
        input: SEED,
        durability: options.durability,
      });
      // Unreachable: the driver kills this container at the park.
      return { party: context.party, error: null, role: "victim", runs: [run] };
    }

    const graph = linearEffectGraph(saver, witness);
    const run = await invokeNested(graph, threadId, {
      input: null,
      durability: options.durability,
    });
    return {
      party: context.party,
      error: null,
      role: "resumer",
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

/**
 * A genuine fork: party 1 re-invokes the thread with an EXPLICIT
 * `checkpoint_id`, which is what a deliberate replay of an earlier decision
 * looks like.
 *
 * It forks from the checkpoint party 0's `act` actually ran against, taken from
 * party 0's OWN effect record in the probe rather than from a row lookup. That
 * makes the fork target the config-derived `parent_checkpoint`, so a fork that
 * lands at all is independent evidence that the value scavenged out of
 * `checkpoint_map` is a real checkpoint id and not a plausible-looking string.
 */
async function explicitFork(context: PartyContext): Promise<Record<string, unknown>> {
  const probe = probePool(context);
  const subject = subjectPool(context);
  const inspect = inspectPool(context);
  const threadId = threadForCase(context.caseId);

  try {
    const witness = createProbe(probe, context.caseId, context.party, context.member);
    const saver = new PostgresSaver(subject.pool, undefined, { schema: CHECKPOINT_SCHEMA });
    const graph = linearEffectGraph(saver, witness);

    if (context.party === 0) {
      const run = await invokeNested(graph, threadId, { input: SEED });
      return {
        party: context.party,
        error: null,
        role: "original",
        threadId,
        runs: [run],
        completed: run.error === null && run.interrupted === false,
      };
    }

    const { rows } = await inspect.pool.query<{ parent: string | null }>(
      `SELECT detail ->> 'parentCheckpoint' AS parent
         FROM ${PROBE_SCHEMA}.event
        WHERE case_id = $1 AND phase = 'effect' AND party = 0 AND node = 'act'
        ORDER BY id
        LIMIT 1`,
      [context.caseId],
    );
    const forkFrom = rows[0]?.parent ?? null;
    if (forkFrom === null) {
      return {
        party: context.party,
        error: null,
        role: "fork",
        threadId,
        forkFrom: null,
        forkTargetResolved: false,
        runs: [],
      };
    }

    const run: NestedRun = await invokeNested(graph, threadId, {
      input: null,
      checkpointId: forkFrom,
    });
    return {
      party: context.party,
      error: null,
      role: "fork",
      threadId,
      // Whether the id resolved is the digested fact; the id itself is a
      // per-run UUIDv6 and stays out of any comparison.
      forkTargetResolved: true,
      runs: [run],
      completed: run.error === null && run.interrupted === false,
    };
  } catch (caught) {
    return { party: context.party, error: describeSqlError(caught), threadId };
  } finally {
    await Promise.allSettled([subject.close(), probe.close(), inspect.close()]);
  }
}

// ---------------------------------------------------------------------------
// Changed-graph variants and the compatibility guard
// ---------------------------------------------------------------------------

/**
 * The paused state, as an outside observer sees it.
 *
 * The head id itself never leaves this function — it is a per-run UUIDv6. What
 * leaves is whether the head MOVED, which is the property "the guard left the
 * checkpoint head untouched" actually asserts.
 */
async function pausedState(
  inspect: Db,
  threadId: string,
): Promise<{ checkpoints: number; interruptRows: number; headId: string | null }> {
  const projection = await project(inspect, threadId);
  return {
    checkpoints: projection.checkpoints.length,
    interruptRows: projection.interrupts.length,
    headId: headOf(projection, "")?.checkpoint_id ?? null,
  };
}

/**
 * The manifest is stored on the independent probe, not in vendor metadata.
 *
 * That is what a runtime would do — LangGraph offers nowhere to put it — and it
 * keeps the guard's input on a connection the checkpointer does not own, so a
 * failed resume cannot roll back the record of what the graph looked like when
 * it paused. It reuses `spike_probe.event` rather than adding a table, so no
 * case outside family H gains a relation and no sealed projection changes shape.
 */
async function recordManifest(probe: Db, caseId: string, manifest: GraphManifest): Promise<void> {
  await probe.pool.query(
    `INSERT INTO ${PROBE_SCHEMA}.event (case_id, party, role, process_nonce, node, phase, detail)
     VALUES ($1, -1, 'prepare', gen_random_uuid(), 'graph', 'manifest', $2::jsonb)`,
    [caseId, JSON.stringify(manifest)],
  );
}

async function readManifest(inspect: Db, caseId: string): Promise<GraphManifest | null> {
  const { rows } = await inspect.pool.query<{ detail: GraphManifest }>(
    `SELECT detail FROM ${PROBE_SCHEMA}.event
      WHERE case_id = $1 AND node = 'graph' AND phase = 'manifest'
      ORDER BY id DESC LIMIT 1`,
    [caseId],
  );
  return rows[0]?.detail ?? null;
}

/**
 * Resume a paused thread against a changed graph, with the guard on or off.
 *
 * With the guard OFF this is the stock lane: whatever the engine does is the
 * measurement, including completing on a graph that no longer matches. With the
 * guard ON the comparison happens BEFORE `invoke` is reached at all — which is
 * the requirement, not an implementation detail. A guard that refused after
 * invoking would already have consumed the interrupt it was protecting.
 */
async function changedGraphResume(
  context: PartyContext,
  options: { variant: VariantId; guard: boolean },
): Promise<Record<string, unknown>> {
  const probe = probePool(context);
  const subject = subjectPool(context);
  const inspect = inspectPool(context);
  const threadId = threadForCase(context.caseId);

  try {
    const witness = createProbe(probe, context.caseId, context.party, context.member);
    const saver = new PostgresSaver(subject.pool, undefined, { schema: CHECKPOINT_SCHEMA });
    const built = buildVariant(options.variant, saver, witness);

    const before = await pausedState(inspect, threadId);
    const stored = await readManifest(inspect, context.caseId);
    const verdict = compareManifests(stored, built.manifest);

    let run: NestedRun | null = null;
    let invoked = false;
    if (!options.guard || verdict.compatible) {
      invoked = true;
      run = await invokeNested(built.graph, threadId, { resume: true });
    }
    const after = await pausedState(inspect, threadId);

    return {
      party: context.party,
      error: null,
      threadId,
      variant: options.variant,
      guardEnabled: options.guard,
      verdict,
      // Whether the guard's structural half alone would have caught this. For
      // the moved-interrupt variant it must not — that is the case that shows a
      // name-and-channel manifest is insufficient on its own.
      //
      // `stable()`, not `JSON.stringify`. The stored manifest comes back out of
      // a jsonb column, and jsonb reorders object keys by length then bytes —
      // the same behaviour d10 measured. A plain stringify therefore reported
      // two identical fingerprint maps as different purely because PostgreSQL
      // had rewritten their key order. The arrays were never affected, which is
      // exactly why the bug hid: only the object-valued half was wrong.
      structureDiffers:
        stored !== null &&
        (stable(stored.nodes) !== stable(built.manifest.nodes) ||
          stable(stored.channels) !== stable(built.manifest.channels)),
      fingerprintsDiffer:
        stored !== null &&
        stable(stored.nodeFingerprints) !== stable(built.manifest.nodeFingerprints),
      invoked,
      runs: run ? [run] : [],
      completed: run !== null && run.error === null && run.interrupted === false,
      // The three facts that make "the persisted state was left untouched" a
      // measurement rather than an assurance. Only the booleans are digested;
      // the head id is a per-run uuid and never leaves `pausedState`.
      checkpointsUnchanged: before.checkpoints === after.checkpoints,
      interruptRowsUnchanged: before.interruptRows === after.interruptRows,
      headUnchanged: before.headId === after.headId,
      pausedCheckpoints: before.checkpoints,
      pausedInterruptRows: before.interruptRows,
    };
  } catch (caught) {
    return { party: context.party, error: describeSqlError(caught), threadId };
  } finally {
    await Promise.allSettled([subject.close(), probe.close(), inspect.close()]);
  }
}

const CHANGED_GRAPH_CASES: Record<string, { variant: VariantId; guard: boolean }> = {
  "h08-changed-graph-identical-control": { variant: "identical", guard: false },
  "h09-changed-graph-cosmetic": { variant: "cosmetic", guard: false },
  "h10-changed-graph-renamed-node": { variant: "renamed-node", guard: false },
  "h11-changed-graph-added-channel": { variant: "added-channel", guard: false },
  "h12-changed-graph-moved-interrupt": { variant: "moved-interrupt", guard: false },
  "h13-compat-guard-identical": { variant: "identical", guard: true },
  "h14-compat-guard-cosmetic": { variant: "cosmetic", guard: true },
  "h15-compat-guard-renamed-node": { variant: "renamed-node", guard: true },
  "h16-compat-guard-added-channel": { variant: "added-channel", guard: true },
  "h17-compat-guard-moved-interrupt": { variant: "moved-interrupt", guard: true },
};

// ---------------------------------------------------------------------------

export async function runFamilyHParty(context: PartyContext): Promise<Record<string, unknown>> {
  const changed = CHANGED_GRAPH_CASES[context.caseId];
  if (changed) return await changedGraphResume(context, changed);

  switch (context.caseId) {
    case "h01-effect-key-components-baseline":
      return await singlePass(context, (saver, witness) => linearEffectGraph(saver, witness));

    case "h02-effect-key-across-crash-resume":
      return await crashResume(context, { durability: "sync" });

    case "h03-effect-key-across-explicit-fork":
      return await explicitFork(context);

    case "h04-effect-key-async-durability":
      return await crashResume(context, { durability: "async" });

    case "h05-effect-key-fanout-siblings":
      return await singlePass(context, (saver, witness) => fanoutEffectGraph(saver, witness));

    case "h06-effect-key-multiple-ordinals":
      return await singlePass(context, (saver, witness) =>
        linearEffectGraph(saver, witness, { effects: 3 }),
      );

    case "h07-effect-key-inside-subgraph":
      return await singlePass(context, (saver, witness) => subgraphEffectGraph(saver, witness));

    default:
      throw new Error(`family H has no participant for case ${context.caseId}`);
  }
}

/**
 * Every changed-graph case needs a run that PAUSED on the baseline graph, plus
 * the manifest recorded at the moment it paused.
 *
 * Both are built here rather than inside the party, because a party that created
 * its own fixture with the variant graph would be comparing the variant against
 * itself — the guard would always agree and the case would prove nothing.
 */
export async function prepareFamilyH(caseId: string): Promise<Record<string, unknown>> {
  if (!(caseId in CHANGED_GRAPH_CASES)) return { caseId, prepared: false };

  const context: PartyContext = { caseId, party: -1, member: "prepare" };
  const probe = probePool(context);
  const subject = subjectPool(context);
  const inspect = inspectPool(context);
  const threadId = threadForCase(caseId);

  try {
    const witness = createProbe(probe, caseId, -1, "prepare");
    const saver = new PostgresSaver(subject.pool, undefined, { schema: CHECKPOINT_SCHEMA });
    const baseline = buildBaseline(saver, witness);

    const first = await invokeNested(baseline.graph, threadId, { input: SEED_STATE });
    await recordManifest(probe, caseId, baseline.manifest);
    const paused = await pausedState(inspect, threadId);

    return {
      caseId,
      prepared: true,
      threadId,
      reachedInterrupt: first.interrupted,
      interruptRows: paused.interruptRows,
      checkpoints: paused.checkpoints,
      // Deterministic: a hash over node names, channel names and normalised node
      // sources, all of which are harness constants.
      manifestDigest: baseline.manifest.digest,
      manifestNodes: baseline.manifest.nodes,
      error: first.error,
    };
  } finally {
    await Promise.allSettled([subject.close(), probe.close(), inspect.close()]);
  }
}
