// The compatibility manifest, and the refusal that compares two of them.
//
// `architecture/09-data-model-and-lifecycle.md:159` requires that, before
// auto-resuming a paused run, the runtime compare a stored node fingerprint
// against current code — "interrupt matching is positional, so a code change
// that adds, removes, or reorders an interrupt makes the stored position wrong"
// — and quarantine rather than resume into the wrong branch. That path is marked
// **not verified** there, because no spike had yet resumed a thread against a
// changed graph.
//
// This is the test-only guard that makes it measurable. It is **architecture**,
// not vendor: LangGraph publishes no compatibility check and will happily resume
// a thread against a graph that no longer matches the one that paused it.
//
// Two halves, deliberately separate, because they detect different things:
//
//   structure     node names and channel names, read from the COMPILED graph
//                 object rather than from anything the fixture declares. Catches
//                 a renamed node or a changed state-channel set.
//   fingerprints  a normalised hash of each node's own source. Catches a change
//                 INSIDE a node body — which is the only way to see an interrupt
//                 that moved, because moving `interrupt()` from one node to
//                 another changes no name and no channel.
//
// Normalisation is what makes "cosmetic" a real category rather than a wish:
// comments are stripped and whitespace runs collapse, so a reformatted or
// re-commented node is compatible, while a renamed local or a moved call is not.
// That rule is narrow and stated rather than generous and vague — a guard that
// forgave more than this would be deciding semantic equivalence, which it cannot
// do.

import { createHash } from "node:crypto";

export type GraphManifest = {
  /** From the compiled graph, so a renamed node cannot hide behind the fixture. */
  nodes: string[];
  /**
   * Also from the compiled graph. Includes the engine's own `branch:to:*`
   * channels, which is deliberate: they encode topology, so an edge change shows
   * up here even when every node name is unchanged.
   */
  channels: string[];
  nodeFingerprints: Record<string, string>;
  digest: string;
};

/**
 * Comments out, whitespace collapsed, nothing else.
 *
 * Node bodies are stripped of their TypeScript annotations before this ever runs
 * — Node's type stripping replaces types with spaces in place — so two variants
 * that differ only in formatting normalise to the same string, and one that
 * differs in a single token does not.
 */
export function normaliseSource(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\n]*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function fingerprintNode(body: (...args: never[]) => unknown): string {
  return createHash("sha256").update(normaliseSource(body.toString())).digest("hex").slice(0, 32);
}

type CompiledLike = { nodes?: Record<string, unknown>; channels?: Record<string, unknown> };

/**
 * The manifest a runtime would record when a run first pauses.
 *
 * `bodies` is the map the fixture registered; `graph` is what the engine
 * compiled from it. Reading names from the compiled object rather than from
 * `bodies` keeps the structural half honest — a fixture that lied about its own
 * node names would still be caught.
 */
export function manifestFor(
  graph: unknown,
  bodies: Record<string, (...args: never[]) => unknown>,
): GraphManifest {
  const compiled = graph as CompiledLike;
  const nodes = Object.keys(compiled.nodes ?? {}).sort();
  const channels = Object.keys(compiled.channels ?? {}).sort();
  const nodeFingerprints = Object.fromEntries(
    Object.entries(bodies)
      .map(([name, body]) => [name, fingerprintNode(body)] as const)
      .sort((left, right) => (left[0] < right[0] ? -1 : 1)),
  );
  const digest = createHash("sha256")
    .update(JSON.stringify({ nodes, channels, nodeFingerprints }))
    .digest("hex");
  return { nodes, channels, nodeFingerprints, digest };
}

export type IncompatibilityKind =
  | "node-added"
  | "node-removed"
  | "channel-added"
  | "channel-removed"
  | "node-body-changed";

export type CompatibilityVerdict = {
  compatible: boolean;
  /** A stable typed code, not a message. The message is for humans only. */
  code: "compatible" | "graph_incompatible" | "no_manifest_recorded";
  /** Sorted, so the refusal is byte-stable across runs. */
  reasons: Array<{ kind: IncompatibilityKind; subject: string }>;
  storedDigest: string | null;
  currentDigest: string;
};

function difference(left: string[], right: string[]): string[] {
  const other = new Set(right);
  return left.filter((value) => !other.has(value));
}

/**
 * The refusal.
 *
 * Every difference is reported, not just the first: a run quarantined for a
 * renamed node that ALSO changed a channel should say so, because an operator
 * deciding whether to discard persisted state needs the whole picture. Reasons
 * are sorted by kind then subject so two runs of the same mismatch produce
 * byte-identical output, which is what "a stable typed refusal" means.
 */
export function compareManifests(
  stored: GraphManifest | null,
  current: GraphManifest,
): CompatibilityVerdict {
  if (stored === null) {
    // Fail CLOSED. No recorded manifest means the guard cannot answer the
    // question, and a guard that resumes when it does not know is not a guard.
    return {
      compatible: false,
      code: "no_manifest_recorded",
      reasons: [],
      storedDigest: null,
      currentDigest: current.digest,
    };
  }

  const reasons: CompatibilityVerdict["reasons"] = [];
  for (const node of difference(current.nodes, stored.nodes)) {
    reasons.push({ kind: "node-added", subject: node });
  }
  for (const node of difference(stored.nodes, current.nodes)) {
    reasons.push({ kind: "node-removed", subject: node });
  }
  for (const channel of difference(current.channels, stored.channels)) {
    reasons.push({ kind: "channel-added", subject: channel });
  }
  for (const channel of difference(stored.channels, current.channels)) {
    reasons.push({ kind: "channel-removed", subject: channel });
  }
  // Only nodes present in BOTH: one that appeared or vanished is already
  // reported structurally, and reporting it twice would make the reason list
  // depend on iteration order rather than on the mismatch.
  for (const [name, fingerprint] of Object.entries(current.nodeFingerprints)) {
    const before = stored.nodeFingerprints[name];
    if (before !== undefined && before !== fingerprint) {
      reasons.push({ kind: "node-body-changed", subject: name });
    }
  }

  reasons.sort((left, right) =>
    left.kind !== right.kind
      ? left.kind < right.kind
        ? -1
        : 1
      : left.subject < right.subject
        ? -1
        : left.subject > right.subject
          ? 1
          : 0,
  );

  return {
    compatible: reasons.length === 0,
    code: reasons.length === 0 ? "compatible" : "graph_incompatible",
    reasons,
    storedDigest: stored.digest,
    currentDigest: current.digest,
  };
}
