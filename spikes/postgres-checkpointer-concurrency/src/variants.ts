// The pinned changed-graph variants.
//
// All five are compiled into the SAME image as the baseline, per the approved
// scope: a variant that lived in a separate build would make "the graph changed"
// indistinguishable from "the runtime changed".
//
// The baseline is `prepare -> gate -> finish` with an interrupt in `gate` — the
// same shape family B uses — and each variant changes exactly one thing:
//
//   identical        nothing. The control that proves a resume works at all.
//   cosmetic         comments and indentation only. Must stay compatible, or the
//                    guard is just a source-hash equality check.
//   renamed-node     `gate` -> `approval`. Changes node names AND the engine's
//                    `branch:to:*` channels.
//   added-channel    one extra state channel. Changes channels, not nodes.
//   moved-interrupt  `interrupt()` moves from `gate` to `finish`. Changes NO node
//                    name and NO channel — the case that decides whether a
//                    structural manifest is sufficient.
//
// Every node body is registered in a `bodies` map alongside the graph, because
// the fingerprint half of the manifest hashes the function's own source. The
// structural half is read back off the compiled object instead, so the two
// halves cannot both be wrong in the same way.

import { Annotation, END, START, StateGraph, interrupt } from "@langchain/langgraph";
import type { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";

import { manifestFor, type GraphManifest } from "./graph-manifest.ts";
import type { Probe } from "./probe.ts";
import type { AnyGraph } from "./subgraphs.ts";

export type VariantId =
  | "identical"
  | "cosmetic"
  | "renamed-node"
  | "added-channel"
  | "moved-interrupt";

export const VARIANT_IDS: VariantId[] = [
  "identical",
  "cosmetic",
  "renamed-node",
  "added-channel",
  "moved-interrupt",
];

/** Variants the guard must ALLOW. Everything else it must refuse. */
export const COMPATIBLE_VARIANTS: VariantId[] = ["identical", "cosmetic"];

const BaseState = Annotation.Root({
  steps: Annotation<string[]>({
    reducer: (left: string[], right: string[]) => left.concat(right),
    default: () => [],
  }),
  decision: Annotation<string>({
    reducer: (_left: string, right: string) => right,
    default: () => "",
  }),
});

/** The added-channel variant differs ONLY by this extra channel. */
const WidenedState = Annotation.Root({
  steps: Annotation<string[]>({
    reducer: (left: string[], right: string[]) => left.concat(right),
    default: () => [],
  }),
  decision: Annotation<string>({
    reducer: (_left: string, right: string) => right,
    default: () => "",
  }),
  notes: Annotation<string>({
    reducer: (_left: string, right: string) => right,
    default: () => "",
  }),
});

export const VARIANT_PROMPT = { ask: "approve", spike: "postgres-concurrency" };

type NodeBody = (...args: never[]) => unknown;

export type BuiltVariant = {
  graph: AnyGraph;
  bodies: Record<string, NodeBody>;
  manifest: GraphManifest;
};

// ---------------------------------------------------------------------------
// Node bodies. Declared as named consts so each variant registers a function
// whose source is exactly what the fingerprint hashes.
// ---------------------------------------------------------------------------

function prepareBody(witness: Probe): NodeBody {
  return (async () => {
    await witness.record("prepare", "executed");
    return { steps: ["prepare"] };
  }) as NodeBody;
}

function gateBody(witness: Probe, node: string): NodeBody {
  return (async () => {
    await witness.record(node, "entered");
    const answer = interrupt(VARIANT_PROMPT) as { decision?: string } | undefined;
    await witness.record(node, "resumed", { decision: answer?.decision ?? null });
    return { steps: [node], decision: answer?.decision ?? "" };
  }) as NodeBody;
}

/**
 * Byte-for-byte different source, token-for-token identical after normalisation.
 * The comments and the reindentation are the whole point of this variant.
 */
function gateBodyCosmetic(witness: Probe, node: string): NodeBody {
  return (async () => {
    // Announce that we have entered the approval gate.
    await witness.record(node, "entered");

    /* Pause here until a decision arrives from outside the process. */
    const answer = interrupt(VARIANT_PROMPT) as { decision?: string } | undefined;

    await witness.record(node, "resumed", { decision: answer?.decision ?? null });
    return { steps: [node], decision: answer?.decision ?? "" };
  }) as NodeBody;
}

function finishBody(witness: Probe): NodeBody {
  return (async () => {
    await witness.record("finish", "executed");
    return { steps: ["finish"] };
  }) as NodeBody;
}

/** `gate` no longer interrupts; `finish` does. Same names, same channels. */
function gateBodyWithoutInterrupt(witness: Probe): NodeBody {
  return (async () => {
    await witness.record("gate", "entered");
    return { steps: ["gate"], decision: "" };
  }) as NodeBody;
}

function finishBodyWithInterrupt(witness: Probe): NodeBody {
  return (async () => {
    await witness.record("finish", "entered");
    const answer = interrupt(VARIANT_PROMPT) as { decision?: string } | undefined;
    await witness.record("finish", "resumed", { decision: answer?.decision ?? null });
    return { steps: ["finish"], decision: answer?.decision ?? "" };
  }) as NodeBody;
}

// ---------------------------------------------------------------------------

function assemble(
  saver: PostgresSaver,
  bodies: Record<string, NodeBody>,
  wire: (builder: never) => never,
  state: typeof BaseState | typeof WidenedState,
): BuiltVariant {
  let builder = new StateGraph(state as typeof BaseState) as unknown as Record<string, unknown>;
  for (const [name, body] of Object.entries(bodies)) {
    builder = (builder as { addNode: (n: string, b: unknown) => unknown }).addNode(
      name,
      body,
    ) as Record<string, unknown>;
  }
  const wired = wire(builder as never) as unknown as {
    compile: (options: unknown) => AnyGraph;
  };
  const graph = wired.compile({ checkpointer: saver });
  return { graph, bodies, manifest: manifestFor(graph, bodies) };
}

type Builder = {
  addEdge: (from: string, to: string) => Builder;
};

/**
 * The baseline topology, shared by every variant that does not deliberately
 * change it. Kept as one function so a variant cannot drift in its wiring by
 * accident — only where it says it does.
 */
function wireLinear(gateNode: string) {
  return ((builder: Builder) =>
    builder
      .addEdge(START, "prepare")
      .addEdge("prepare", gateNode)
      .addEdge(gateNode, "finish")
      .addEdge("finish", END)) as unknown as (builder: never) => never;
}

export function buildVariant(
  id: VariantId,
  saver: PostgresSaver,
  witness: Probe,
): BuiltVariant {
  switch (id) {
    case "identical":
      return assemble(
        saver,
        {
          prepare: prepareBody(witness),
          gate: gateBody(witness, "gate"),
          finish: finishBody(witness),
        },
        wireLinear("gate"),
        BaseState,
      );

    case "cosmetic":
      return assemble(
        saver,
        {
          prepare: prepareBody(witness),
          gate: gateBodyCosmetic(witness, "gate"),
          finish: finishBody(witness),
        },
        wireLinear("gate"),
        BaseState,
      );

    case "renamed-node":
      return assemble(
        saver,
        {
          prepare: prepareBody(witness),
          approval: gateBody(witness, "approval"),
          finish: finishBody(witness),
        },
        wireLinear("approval"),
        BaseState,
      );

    case "added-channel":
      return assemble(
        saver,
        {
          prepare: prepareBody(witness),
          gate: gateBody(witness, "gate"),
          finish: finishBody(witness),
        },
        wireLinear("gate"),
        WidenedState,
      );

    case "moved-interrupt":
      return assemble(
        saver,
        {
          prepare: prepareBody(witness),
          gate: gateBodyWithoutInterrupt(witness),
          finish: finishBodyWithInterrupt(witness),
        },
        wireLinear("gate"),
        BaseState,
      );

    default: {
      const unreachable: never = id;
      throw new Error(`unknown variant ${String(unreachable)}`);
    }
  }
}

/** The graph that PAUSES the run. Every variant is compared against this one. */
export function buildBaseline(saver: PostgresSaver, witness: Probe): BuiltVariant {
  return buildVariant("identical", saver, witness);
}
