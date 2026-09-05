// Canonicalisation and digests.
//
// Three rules govern everything here, and each exists because the obvious
// alternative destroys a result:
//
//  1. Arrays are never sorted or deduplicated by the canonicaliser. Order is
//     part of the answer for ranked retrieval, path sequences, and revision
//     chains. A collection whose order is genuinely irrelevant declares itself
//     a set at the call site and is sorted THERE, by a declared key.
//
//  2. Only predeclared volatile values are replaced. Version tokens, freshness
//     states, error codes, belief states, and evidence counts are NOT volatile:
//     ranking them away would let a real regression produce an identical digest.
//
//  3. A field discovered to be volatile during a run is a harness defect, not a
//     silent addition to the list. Widening this list after seeing results is
//     how three repeats are made to agree by fiat.

import { createHash } from "node:crypto";

export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

/**
 * Values that differ between two identical runs for reasons that carry no
 * meaning. Declared before measurement, matched by key name at any depth.
 *
 * `drop`      removed entirely
 * `token`     replaced by a stable `<prefix:N>` label in first-seen order
 * `shape`     value replaced by its type, so presence and type still count
 */
export const VOLATILE_FIELDS: Record<string, "drop" | "token" | "shape"> = {
  // Wall clock and elapsed time. The deterministic tick is NOT volatile.
  wallClock: "drop",
  observedAt: "drop",
  startedAt: "drop",
  finishedAt: "drop",
  durationMs: "drop",
  lagMs: "shape",
  // Process, container, and connection identity.
  runId: "token",
  processNonce: "token",
  containerId: "drop",
  backendPid: "token",
  sessionId: "token",
  boltConnectionId: "token",
  // Store-internal identity that must never reach a compared answer.
  elementId: "drop",
  neo4jInternalId: "drop",
  ctid: "drop",
  xmin: "drop",
  inode: "drop",
  mtime: "drop",
  // Canonical-point identity is per-lane and per-run by construction. Its
  // EQUALITY across two reads is asserted relationally instead.
  canonicalPoint: "token",
  projectionWatermark: "token",
  gitCommit: "token",
  receiptId: "token",
  durabilityPoint: "token",
};

export function stableValue(value: unknown): Json {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map(stableValue);
  if (typeof value === "object") {
    const source = value as Record<string, unknown>;
    const out: { [key: string]: Json } = {};
    for (const key of Object.keys(source).sort()) out[key] = stableValue(source[key]);
    return out;
  }
  if (typeof value === "number" && !Number.isFinite(value)) return String(value);
  if (typeof value === "bigint") return value.toString();
  return value as Json;
}

export function stable(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

export function digest(value: unknown): string {
  return createHash("sha256").update(stable(value)).digest("hex");
}

export type Ranker = (value: string) => string;

/**
 * Insertion-ordered labels, scoped to one declared comparison boundary.
 *
 * Scoped rather than global: a single global ranker leaks ordering information
 * between unrelated collections, so two runs that differ only in the order two
 * independent things were first seen would produce different digests.
 */
export function createRanker(prefix: string): Ranker {
  const seen = new Map<string, string>();
  return (value: string): string => {
    const existing = seen.get(value);
    if (existing !== undefined) return existing;
    const label = `<${prefix}:${seen.size}>`;
    seen.set(value, label);
    return label;
  };
}

/**
 * Apply the declared volatility policy.
 *
 * Token rankers are supplied by the caller and scoped per comparison boundary,
 * so a run id seen in two unrelated collections does not couple them.
 */
export function applyVolatility(value: unknown, rankers: Map<string, Ranker>): Json {
  const walk = (node: unknown): Json => {
    if (node === null || node === undefined) return null;
    if (Array.isArray(node)) return node.map(walk);
    if (typeof node === "object") {
      const source = node as Record<string, unknown>;
      const out: { [key: string]: Json } = {};
      for (const key of Object.keys(source).sort()) {
        const policy = VOLATILE_FIELDS[key];
        if (policy === "drop") continue;
        if (policy === "shape") {
          const raw = source[key];
          out[key] = raw === null || raw === undefined ? null : `<${typeof raw}>`;
          continue;
        }
        if (policy === "token") {
          const raw = source[key];
          if (raw === null || raw === undefined) {
            out[key] = null;
            continue;
          }
          let ranker = rankers.get(key);
          if (!ranker) {
            ranker = createRanker(key);
            rankers.set(key, ranker);
          }
          out[key] = ranker(String(raw));
          continue;
        }
        out[key] = walk(source[key]);
      }
      return out;
    }
    return stableValue(node);
  };
  return walk(value);
}

/** Canonical managed form plus its digest, for one declared boundary. */
export function managed(value: unknown): { managed: Json; digest: string } {
  const form = applyVolatility(value, new Map());
  return { managed: form, digest: digest(form) };
}

/**
 * Sort a collection the answer declares unordered.
 *
 * Called explicitly at the site that knows the collection is a set, never by the
 * canonicaliser. Ties break on the element's own digest so the order is total.
 */
export function asSet<T>(items: T[], key: (item: T) => string): T[] {
  return [...items].sort((left, right) => {
    const a = key(left);
    const b = key(right);
    if (a !== b) return a < b ? -1 : 1;
    const da = digest(left);
    const db = digest(right);
    return da < db ? -1 : da > db ? 1 : 0;
  });
}

/**
 * A total order on identifiers, for export sorts.
 *
 * Both adapters used `(a, b) => (a < b ? -1 : 1)`, which returns 1 for equal
 * keys and so is not a valid comparator. It happened to be safe only because
 * every sort key is under a uniqueness constraint — an undocumented invariant
 * holding up a load-bearing digest.
 */
export function compareIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Prose reduction for messages and log excerpts ONLY.
 *
 * It blanks anything that looks like an identifier, which makes it unsafe on
 * structured fields: applying it to a claim id would erase the answer. Two call
 * sites are permitted, both on free text.
 */
export function sanitizeProse(text: string): string {
  return text
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<uuid>")
    .replace(/\b[0-9a-f]{32,}\b/gi, "<hash>")
    .replace(/\/(?:home|Users|vault|var\/lib)\/[^\s"']*/g, "<path>")
    .replace(/\b\d{4}-\d{2}-\d{2}T[0-9:.]+Z\b/g, "<instant>");
}

/**
 * A managed field may not point at findings that are absent.
 *
 * Spike 06's rule, imported unchanged: a digest computed over labels that
 * reference nothing is stable for the wrong reason.
 */
export function referencesResolve(labels: string[], present: Set<string>): boolean {
  if (labels.length === 0) return false;
  return labels.every((label) => present.has(label));
}
