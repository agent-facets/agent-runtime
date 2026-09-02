// The graph fixture, and the independent record of what it executed.
//
// Every node records to `spike_probe.event` on the PROBE pool before it does
// anything else. That is what makes "this node ran twice" a measurement rather
// than an inference from terminal graph output:
//
//   * the probe write is autocommit on a connection the checkpointer does not
//     own, so it survives a superstep whose checkpoint transaction never
//     commits, and cannot be rolled back by one that fails;
//   * nothing it records is a state channel, so it cannot be restored from a
//     checkpoint and mistaken for a fresh execution;
//   * it carries the per-process nonce, so two containers resuming the same
//     thread are distinguishable even when they execute the identical node.
//
// It deduplicates nothing. LangGraph legitimately replays a node on resume, and
// suppressing that here would erase the exact quantity family B measures.

import { Annotation, Command, END, START, StateGraph, interrupt } from "@langchain/langgraph";
import type { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";

import { RESUME_DECISION } from "./contract.ts";
import type { Probe } from "./probe.ts";

export const GraphState = Annotation.Root({
  steps: Annotation<string[]>({
    reducer: (left: string[], right: string[]) => left.concat(right),
    default: () => [],
  }),
  decision: Annotation<string>({
    reducer: (_left: string, right: string) => right,
    default: () => "",
  }),
});

export const INTERRUPT_PROMPT = { ask: "approve", spike: "postgres-concurrency" };

/**
 * `prepare -> gate -> finish`, with a single interrupt in `gate`.
 *
 * `gate` records twice on purpose: once on entry, and once after `interrupt()`
 * returns. The first fires on every pass including the replay; the second only
 * on a pass that actually carried a resume value. Two counts from one node is
 * what distinguishes "the engine replayed the node" — expected — from "two
 * workers both consumed the interrupt" — the finding.
 */
export function buildGraph(saver: PostgresSaver, witness: Probe) {
  return new StateGraph(GraphState)
    .addNode("prepare", async () => {
      await witness.record("prepare", "executed");
      return { steps: ["prepare"] };
    })
    .addNode("gate", async () => {
      await witness.record("gate", "entered");
      const answer = interrupt(INTERRUPT_PROMPT) as { decision?: string } | undefined;
      await witness.record("gate", "resumed", { decision: answer?.decision ?? null });
      return { steps: ["gate"], decision: answer?.decision ?? "" };
    })
    .addNode("finish", async () => {
      await witness.record("finish", "executed");
      return { steps: ["finish"] };
    })
    .addEdge(START, "prepare")
    .addEdge("prepare", "gate")
    .addEdge("gate", "finish")
    .addEdge("finish", END)
    .compile({ checkpointer: saver });
}

export type GraphRun = {
  /** `null` when the run returned normally; a described error otherwise. */
  error: { name: string; message: string; code: string | null } | null;
  interrupted: boolean;
  steps: string[];
  decision: string;
};

function describe(error: unknown): { name: string; message: string; code: string | null } {
  const err = error as { name?: string; message?: string; code?: string } | null;
  return {
    name: err?.name ?? "Error",
    message: err?.message ?? String(error),
    code: err?.code ?? null,
  };
}

function summarise(value: unknown): { interrupted: boolean; steps: string[]; decision: string } {
  const record = (value ?? {}) as Record<string, unknown>;
  return {
    // Read structurally rather than through `isInterrupted`, so the witness does
    // not depend on the same helper the engine uses to decide it interrupted.
    interrupted: Array.isArray(record.__interrupt__) && record.__interrupt__.length > 0,
    steps: Array.isArray(record.steps) ? (record.steps as string[]) : [],
    decision: typeof record.decision === "string" ? record.decision : "",
  };
}

/** First pass: run until the interrupt commits. */
export async function runToInterrupt(
  graph: ReturnType<typeof buildGraph>,
  threadId: string,
): Promise<GraphRun> {
  try {
    const value = await graph.invoke(
      { steps: [], decision: "" },
      { configurable: { thread_id: threadId }, durability: "sync" },
    );
    return { error: null, ...summarise(value) };
  } catch (error) {
    return { error: describe(error), interrupted: false, steps: [], decision: "" };
  }
}

/**
 * Resume with NO `checkpoint_id`.
 *
 * That omission is the whole point: supplying one would be an explicit fork,
 * which is a different experiment (family H). Two workers resuming the same
 * thread with no checkpoint id are both asking for "whatever the head is now",
 * which is precisely what a queue redelivery or a duplicated operator action
 * looks like.
 */
export async function resume(
  graph: ReturnType<typeof buildGraph>,
  threadId: string,
): Promise<GraphRun> {
  try {
    const value = await graph.invoke(new Command({ resume: RESUME_DECISION }), {
      configurable: { thread_id: threadId },
      durability: "sync",
    });
    return { error: null, ...summarise(value) };
  } catch (error) {
    return { error: describe(error), interrupted: false, steps: [], decision: "" };
  }
}
