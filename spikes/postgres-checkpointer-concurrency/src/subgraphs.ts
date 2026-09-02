// Subgraph fixtures, and the inlined control that makes them mean something.
//
// The claim these exist to test is that a subgraph gets its own checkpoint
// namespace, that two instances of one subgraph do not collide, and that a
// namespace's lineage is independently well-formed. None of that is worth
// measuring without `buildInlinedGraph`: a run that ends with three namespaces
// only tells you something once the SAME node work, arranged without subgraphs,
// ends with one.
//
// Every node records to the independent probe before doing anything, for the
// reasons in `graph.ts` — terminal graph output cannot distinguish "this node
// ran" from "this channel was restored".
//
// The plan forbids depending on the vendor's namespace STRING format, so nothing
// here parses `|` or `:`. Structure is read from the rows: how many distinct
// namespaces exist, how they relate through `metadata -> 'parents'`, and whether
// each one's chain has a single root and a single leaf.

import { Annotation, Command, END, START, StateGraph, interrupt } from "@langchain/langgraph";
import type { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";

import { RESUME_DECISION } from "./contract.ts";
import { sanitizeProse } from "./canonical.ts";
import type { Probe } from "./probe.ts";

/**
 * Shared by the parent and every subgraph, so state flows through the subgraph
 * boundary without a mapping layer that would become a second thing under test.
 */
export const NestedState = Annotation.Root({
  steps: Annotation<string[]>({
    reducer: (left: string[], right: string[]) => left.concat(right),
    default: () => [],
  }),
  decision: Annotation<string>({
    reducer: (_left: string, right: string) => right,
    default: () => "",
  }),
});

export const SUBGRAPH_INTERRUPT_PROMPT = { ask: "approve-subgraph", spike: "postgres-concurrency" };

type NodeFn = (state: unknown, config: unknown) => Promise<{ steps: string[] }>;

/**
 * Blocks forever after recording a durable marker, so a kill case can anchor on
 * an observed row instead of a sleep. Only ever supplied for the one node a case
 * names.
 */
export type ParkHook = (node: string) => Promise<never>;

export type NestedOptions = {
  /** The node whose body parks. Absent means nothing parks. */
  parkAt?: string;
  park?: ParkHook;
};

/**
 * A plain recording node. `config` is captured even where the case does not need
 * it, so a namespace case and an effect-key case can share one node shape and
 * the recorded namespace always comes from the same place.
 *
 * The park happens AFTER the probe write: a worker killed before it recorded
 * anything would be indistinguishable from one that never started, and the whole
 * point of a crash case is knowing exactly how far the victim got.
 */
function recorder(witness: Probe, node: string, options: NestedOptions = {}): NodeFn {
  return async (_state: unknown, config: unknown) => {
    const configurable = ((config ?? {}) as { configurable?: Record<string, unknown> })
      .configurable ?? {};
    await witness.record(node, "executed", {
      taskNamespace: typeof configurable.checkpoint_ns === "string" ? configurable.checkpoint_ns : null,
    });
    if (options.parkAt === node && options.park) await options.park(node);
    return { steps: [node] };
  };
}

/** `sub_a -> sub_b`, the unit of work every topology below rearranges. */
function innerGraph(witness: Probe, options: NestedOptions = {}) {
  return new StateGraph(NestedState)
    .addNode("sub_a", recorder(witness, "sub_a", options))
    .addNode("sub_b", recorder(witness, "sub_b", options))
    .addEdge(START, "sub_a")
    .addEdge("sub_a", "sub_b")
    .addEdge("sub_b", END)
    .compile();
}

/**
 * `prepare -> inner(subgraph) -> finish`.
 *
 * The subgraph is compiled with NO checkpointer of its own: it inherits the
 * parent's, which is what makes its checkpoints land in the same tables under a
 * different namespace rather than nowhere at all.
 */
export function buildNestedGraph(
  saver: PostgresSaver,
  witness: Probe,
  options: NestedOptions = {},
) {
  return new StateGraph(NestedState)
    .addNode("prepare", recorder(witness, "prepare", options))
    .addNode("inner", innerGraph(witness, options))
    .addNode("finish", recorder(witness, "finish", options))
    .addEdge(START, "prepare")
    .addEdge("prepare", "inner")
    .addEdge("inner", "finish")
    .addEdge("finish", END)
    .compile({ checkpointer: saver });
}

/**
 * The load-bearing control: the same four node bodies, in the same order,
 * arranged WITHOUT a subgraph.
 *
 * If this run also produced extra namespaces then "the subgraph produced them"
 * would be an unfalsifiable claim about a graph that always behaves that way.
 */
export function buildInlinedGraph(saver: PostgresSaver, witness: Probe) {
  return new StateGraph(NestedState)
    .addNode("prepare", recorder(witness, "prepare"))
    .addNode("sub_a", recorder(witness, "sub_a"))
    .addNode("sub_b", recorder(witness, "sub_b"))
    .addNode("finish", recorder(witness, "finish"))
    .addEdge(START, "prepare")
    .addEdge("prepare", "sub_a")
    .addEdge("sub_a", "sub_b")
    .addEdge("sub_b", "finish")
    .addEdge("finish", END)
    .compile({ checkpointer: saver });
}

/**
 * Two nodes wrapping ONE compiled subgraph, triggered in the same superstep.
 *
 * The same compiled object twice is the point: if the namespace were derived
 * from the subgraph's identity rather than from the call site, the two instances
 * would share a namespace and overwrite each other's lineage.
 */
export function buildParallelSubgraphGraph(saver: PostgresSaver, witness: Probe) {
  const shared = innerGraph(witness);
  return new StateGraph(NestedState)
    .addNode("prepare", recorder(witness, "prepare"))
    .addNode("left", shared)
    .addNode("right", shared)
    .addNode("finish", recorder(witness, "finish"))
    .addEdge(START, "prepare")
    .addEdge("prepare", "left")
    .addEdge("prepare", "right")
    .addEdge("left", "finish")
    .addEdge("right", "finish")
    .addEdge("finish", END)
    .compile({ checkpointer: saver });
}

/** A subgraph inside a subgraph, so namespace nesting is measured at depth two. */
export function buildDeepGraph(saver: PostgresSaver, witness: Probe) {
  const leaf = new StateGraph(NestedState)
    .addNode("leaf_a", recorder(witness, "leaf_a"))
    .addEdge(START, "leaf_a")
    .addEdge("leaf_a", END)
    .compile();

  const mid = new StateGraph(NestedState)
    .addNode("sub_a", recorder(witness, "sub_a"))
    .addNode("leaf", leaf)
    .addEdge(START, "sub_a")
    .addEdge("sub_a", "leaf")
    .addEdge("leaf", END)
    .compile();

  return new StateGraph(NestedState)
    .addNode("prepare", recorder(witness, "prepare"))
    .addNode("mid", mid)
    .addNode("finish", recorder(witness, "finish"))
    .addEdge(START, "prepare")
    .addEdge("prepare", "mid")
    .addEdge("mid", "finish")
    .addEdge("finish", END)
    .compile({ checkpointer: saver });
}

/**
 * An interrupt raised INSIDE a subgraph.
 *
 * `sub_gate` records twice for the same reason `gate` does in `graph.ts`: the
 * entry record fires on every pass including the replay, the resumed record only
 * on a pass carrying a resume value. Two counts from one node is what separates
 * "the engine replayed the node" from "two workers both consumed the interrupt".
 */
export function buildSubgraphInterruptGraph(saver: PostgresSaver, witness: Probe) {
  const inner = new StateGraph(NestedState)
    .addNode("sub_a", recorder(witness, "sub_a"))
    .addNode("sub_gate", async (_state: unknown, config: unknown) => {
      const configurable = ((config ?? {}) as { configurable?: Record<string, unknown> })
        .configurable ?? {};
      await witness.record("sub_gate", "entered", {
        taskNamespace: typeof configurable.checkpoint_ns === "string"
          ? configurable.checkpoint_ns
          : null,
      });
      const answer = interrupt(SUBGRAPH_INTERRUPT_PROMPT) as { decision?: string } | undefined;
      await witness.record("sub_gate", "resumed", { decision: answer?.decision ?? null });
      return { steps: ["sub_gate"], decision: answer?.decision ?? "" };
    })
    .addEdge(START, "sub_a")
    .addEdge("sub_a", "sub_gate")
    .addEdge("sub_gate", END)
    .compile();

  return new StateGraph(NestedState)
    .addNode("prepare", recorder(witness, "prepare"))
    .addNode("inner", inner)
    .addNode("finish", recorder(witness, "finish"))
    .addEdge(START, "prepare")
    .addEdge("prepare", "inner")
    .addEdge("inner", "finish")
    .addEdge("finish", END)
    .compile({ checkpointer: saver });
}

/**
 * A fan-out INSIDE a subgraph: two siblings in one superstep, one of which can
 * be made to fail.
 *
 * `failSibling` is what turns pending-write reuse into a measurement. The failing
 * sibling aborts the superstep after its partner's write has already landed, so
 * a resume has one sibling with a pending write and one without — and the probe
 * counts show which of the two re-executed.
 */
export function buildSubgraphFanoutGraph(
  saver: PostgresSaver,
  witness: Probe,
  options: { failSibling: boolean },
) {
  const inner = new StateGraph(NestedState)
    .addNode("sub_fast", recorder(witness, "sub_fast"))
    .addNode("sub_slow", async (_state: unknown, config: unknown) => {
      const configurable = ((config ?? {}) as { configurable?: Record<string, unknown> })
        .configurable ?? {};
      await witness.record("sub_slow", "executed", {
        taskNamespace: typeof configurable.checkpoint_ns === "string"
          ? configurable.checkpoint_ns
          : null,
      });
      if (options.failSibling) throw new Error("spike: deliberate sibling failure");
      return { steps: ["sub_slow"] };
    })
    .addNode("sub_join", recorder(witness, "sub_join"))
    .addEdge(START, "sub_fast")
    .addEdge(START, "sub_slow")
    .addEdge("sub_fast", "sub_join")
    .addEdge("sub_slow", "sub_join")
    .addEdge("sub_join", END)
    .compile();

  return new StateGraph(NestedState)
    .addNode("prepare", recorder(witness, "prepare"))
    .addNode("inner", inner)
    .addNode("finish", recorder(witness, "finish"))
    .addEdge(START, "prepare")
    .addEdge("prepare", "inner")
    .addEdge("inner", "finish")
    .addEdge("finish", END)
    .compile({ checkpointer: saver });
}

/**
 * The identical two-sibling fan-out, at the ROOT.
 *
 * The control that isolates the variable. `buildSubgraphFanoutGraph` changes two
 * things at once against Spike 05's root-level result — the work moved into a
 * subgraph AND the abort became a thrown error rather than a SIGKILL — so a
 * difference in reuse could be blamed on either. This keeps the failure mode and
 * changes only the nesting.
 */
export function buildRootFanoutGraph(
  saver: PostgresSaver,
  witness: Probe,
  options: { failSibling: boolean },
) {
  return new StateGraph(NestedState)
    .addNode("prepare", recorder(witness, "prepare"))
    .addNode("sub_fast", recorder(witness, "sub_fast"))
    .addNode("sub_slow", async (_state: unknown, config: unknown) => {
      const configurable = ((config ?? {}) as { configurable?: Record<string, unknown> })
        .configurable ?? {};
      await witness.record("sub_slow", "executed", {
        taskNamespace: typeof configurable.checkpoint_ns === "string"
          ? configurable.checkpoint_ns
          : null,
      });
      if (options.failSibling) throw new Error("spike: deliberate sibling failure");
      return { steps: ["sub_slow"] };
    })
    .addNode("sub_join", recorder(witness, "sub_join"))
    .addNode("finish", recorder(witness, "finish"))
    .addEdge(START, "prepare")
    .addEdge("prepare", "sub_fast")
    .addEdge("prepare", "sub_slow")
    .addEdge("sub_fast", "sub_join")
    .addEdge("sub_slow", "sub_join")
    .addEdge("sub_join", "finish")
    .addEdge("finish", END)
    .compile({ checkpointer: saver });
}

export type NestedRun = {
  error: { name: string; message: string } | null;
  interrupted: boolean;
  steps: string[];
  decision: string;
};

/**
 * A compiled graph, structurally, so the six topologies above can share one
 * invoke path.
 *
 * `never[]` rather than `unknown[]`: parameters are contravariant, so a graph
 * whose `invoke` demands its own state type is assignable to this while
 * `(input: unknown, ...)` would reject every one of them. The arguments are cast
 * once, at the single call site below, instead of every builder being widened.
 */
export type AnyGraph = { invoke: (...args: never[]) => Promise<unknown> };

function summarise(value: unknown): { interrupted: boolean; steps: string[]; decision: string } {
  const record = (value ?? {}) as Record<string, unknown>;
  return {
    interrupted: Array.isArray(record.__interrupt__) && record.__interrupt__.length > 0,
    steps: Array.isArray(record.steps) ? (record.steps as string[]) : [],
    decision: typeof record.decision === "string" ? record.decision : "",
  };
}

/**
 * One entry point for every pass a subgraph case needs to make.
 *
 * `input: null` is how a crashed run is picked up: the engine resumes from the
 * persisted head rather than restarting from START. `resume: true` sends the
 * decision payload instead. `checkpointId` makes it an explicit fork, which is a
 * different experiment and never combined with a plain resume by accident.
 */
export async function invokeNested(
  graph: AnyGraph,
  threadId: string,
  options: {
    input?: Record<string, unknown> | null;
    resume?: boolean;
    checkpointId?: string;
    durability?: "sync" | "async" | "exit";
  } = {},
): Promise<NestedRun> {
  const input = options.resume
    ? new Command({ resume: RESUME_DECISION })
    : (options.input ?? null);
  // The OBJECT is cast, never the method. Lifting `graph.invoke` into a local
  // detaches it from its receiver, and Pregel's `invoke` reads
  // `this.outputChannels` on its first line — so an unbound call fails with a
  // TypeError that arrives as a graph-level error and looks exactly like a
  // measured failure of the fixture.
  const callable = graph as unknown as {
    invoke: (input: unknown, config: unknown) => Promise<unknown>;
  };
  try {
    const value = await callable.invoke(input, {
      configurable: {
        thread_id: threadId,
        ...(options.checkpointId ? { checkpoint_id: options.checkpointId } : {}),
      },
      durability: options.durability ?? "sync",
    });
    return { error: null, ...summarise(value) };
  } catch (error) {
    const err = error as { name?: string; message?: string } | null;
    return {
      error: {
        name: err?.name ?? "Error",
        // Sanitised, not merely captured. An engine error raised inside a
        // subgraph quotes the failing task's uuid, which would otherwise land in
        // a digested result and change every run for no behavioural reason.
        message: sanitizeProse(err?.message ?? String(error)),
      },
      interrupted: false,
      steps: [],
      decision: "",
    };
  }
}
