// The three graphs under test.
//
// Each is the smallest topology that can prove one claim, and each case gets its
// own thread. They are deliberately NOT merged into one graph: a failure in
// pending-write reuse and a failure in interrupt resume would then be
// indistinguishable, and the fan-out semantics would be coupled to the
// interrupt semantics.
//
// Nothing here counts its own executions into graph state. A counter living in
// a channel is checkpointed and restored, so it reads the pre-kill value after a
// resume and shows no re-execution even when re-execution happened. Execution
// counting belongs to the probe, outside anything the checkpointer can restore.

import { Annotation, END, START, StateGraph, interrupt } from "@langchain/langgraph";
import type { Probe } from "./probe.ts";

export type GraphKind = "sequential" | "parallel" | "interrupt";

const appendStrings = (left: string[], right: string[]) => [...left, ...right];
const lastWins = (_left: string | null, right: string | null) => right;

/**
 * Sequential: proves mid-node crash recovery, completed-node skipping, and
 * reducer atomicity.
 *
 * `pairL` and `pairR` are returned together by the killed node but use
 * different reducer families — a list append and a numeric add. A partially
 * applied update is therefore visible as a shape mismatch, not merely as a
 * wrong count.
 */
const SequentialState = Annotation.Root({
  trace: Annotation<string[]>({ reducer: appendStrings, default: () => [] }),
  pairL: Annotation<string[]>({ reducer: appendStrings, default: () => [] }),
  pairR: Annotation<number>({ reducer: (left: number, right: number) => left + right, default: () => 0 }),
  done: Annotation<string | null>({ reducer: lastWins, default: () => null }),
});

/**
 * Parallel: proves pending-write reuse.
 *
 * Branch completion order is not part of the durability contract, so the trace
 * reducer sorts. That makes the observable the SET of contributions, which is
 * what the engine actually promises. (Sorting here is graph semantics; the
 * evidence canonicaliser never sorts, because there it could hide real drift.)
 */
const ParallelState = Annotation.Root({
  trace: Annotation<string[]>({
    reducer: (left: string[], right: string[]) => [...left, ...right].sort(),
    default: () => [],
  }),
  done: Annotation<string | null>({ reducer: lastWins, default: () => null }),
});

/** Interrupt: proves interrupt persistence, resume, and pre-interrupt replay. */
const InterruptState = Annotation.Root({
  trace: Annotation<string[]>({ reducer: appendStrings, default: () => [] }),
  decision: Annotation<string | null>({ reducer: lastWins, default: () => null }),
  done: Annotation<string | null>({ reducer: lastWins, default: () => null }),
});

export function initialInput(kind: GraphKind): Record<string, unknown> {
  if (kind === "parallel") return { trace: [], done: null };
  if (kind === "interrupt") return { trace: [], decision: null, done: null };
  return { trace: [], pairL: [], pairR: 0, done: null };
}

function buildSequential(probe: Probe) {
  return new StateGraph(SequentialState)
    .addNode("seed", async () => {
      await probe.record("seed", "enter");
      return { trace: ["seed"] };
    })
    .addNode("work", async () => {
      await probe.record("work", "enter");
      // An external effect recorded BEFORE the park. This is the thing that
      // must be seen twice across a crash, and the reason an app-layer
      // idempotency ledger exists.
      await probe.record("work", "effect");
      await probe.waitLatch("work");
      return { trace: ["work"], pairL: ["w"], pairR: 1 };
    })
    .addNode("finish", async () => {
      await probe.record("finish", "enter");
      return { trace: ["finish"], done: "finished" };
    })
    .addEdge(START, "seed")
    .addEdge("seed", "work")
    .addEdge("work", "finish")
    .addEdge("finish", END);
}

function buildParallel(probe: Probe) {
  return new StateGraph(ParallelState)
    .addNode("seed", async () => {
      await probe.record("seed", "enter");
      return { trace: ["seed"] };
    })
    .addNode("fast", async () => {
      await probe.record("fast", "enter");
      await probe.record("fast", "effect");
      return { trace: ["fast"] };
    })
    .addNode("blocked", async () => {
      await probe.record("blocked", "enter");
      await probe.record("blocked", "effect");
      await probe.waitLatch("blocked");
      return { trace: ["blocked"] };
    })
    .addNode("finish", async () => {
      await probe.record("finish", "enter");
      return { trace: ["finish"], done: "finished" };
    })
    .addEdge(START, "seed")
    .addEdge("seed", "fast")
    .addEdge("seed", "blocked")
    .addEdge("fast", "finish")
    .addEdge("blocked", "finish")
    .addEdge("finish", END);
}

function buildInterrupt(probe: Probe) {
  return new StateGraph(InterruptState)
    .addNode("seed", async () => {
      await probe.record("seed", "enter");
      return { trace: ["seed"] };
    })
    .addNode("approval", async () => {
      await probe.record("approval", "enter");
      // A per-execution raise marker. It is persisted inside the interrupt
      // payload, so a resumed process reading the PRIMARY's marker out of
      // Postgres is what proves the interrupt was continued rather than
      // re-raised. Payload equality alone proves nothing: a fresh run reaching
      // this node produces an identical-looking interrupt.
      //
      // Deliberately the probe's stage label rather than a random UUID. A random
      // value would land in a persisted blob and make every repeat's digest
      // differ, destroying reproducibility to prove something the stage label
      // already proves — a re-raise on the resume would carry ":resume".
      const raiseNonce = probe.label;
      await probe.record("approval", "pre-interrupt", { raiseNonce });
      const decision = interrupt({ question: "approve this action?", raiseNonce }) as
        | { decision?: string }
        | boolean
        | string;
      await probe.record("approval", "post-interrupt");
      const resolved =
        typeof decision === "object" && decision !== null && typeof decision.decision === "string"
          ? decision.decision
          : String(decision);
      return { trace: ["approval"], decision: resolved };
    })
    .addNode("finish", async () => {
      await probe.record("finish", "enter");
      return { trace: ["finish"], done: "finished" };
    })
    .addEdge(START, "seed")
    .addEdge("seed", "approval")
    .addEdge("approval", "finish")
    .addEdge("finish", END);
}

export function buildGraph(kind: GraphKind, probe: Probe) {
  if (kind === "sequential") return buildSequential(probe);
  if (kind === "parallel") return buildParallel(probe);
  return buildInterrupt(probe);
}
