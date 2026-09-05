// The query matrix: a reporting lens over the golden questions, and the
// id-permutation fairness control.
//
// The capability grouping lives HERE and not in the oracle, deliberately. It
// changes no expected answer and adds no expectation; it only decides how
// results are read. Putting it in the oracle would have moved a frozen digest
// and spent an amendment on a presentation choice.

export type Capability =
  | "structured"
  | "temporal"
  | "provenance"
  | "path"
  | "conflict"
  | "work"
  | "attribution"
  | "hybrid"
  | "freshness";

/**
 * Which capability each golden question exercises.
 *
 * Declared once, covering all twenty-four. A question that belonged to no group,
 * or to two, would make a per-capability rate uninterpretable.
 */
export const CAPABILITY_OF: Record<string, Capability> = {
  Q01: "structured",
  Q13: "structured",
  Q15: "structured",
  Q24: "structured",
  Q02: "temporal",
  Q03: "temporal",
  Q04: "temporal",
  Q05: "temporal",
  Q07: "temporal",
  Q06: "provenance",
  Q16: "provenance",
  Q19: "provenance",
  Q20: "provenance",
  Q08: "path",
  Q09: "path",
  Q14: "path",
  Q10: "conflict",
  Q11: "conflict",
  Q17: "work",
  Q18: "work",
  Q22: "work",
  Q12: "attribution",
  Q21: "hybrid",
  Q23: "freshness",
};

export function capabilityBreakdown(
  results: Array<{ id: string; passed: boolean }>,
): Record<string, { passed: number; total: number }> {
  const out: Record<string, { passed: number; total: number }> = {};
  for (const result of results) {
    const capability = CAPABILITY_OF[result.id] ?? "structured";
    const bucket = (out[capability] ??= { passed: 0, total: 0 });
    bucket.total += 1;
    if (result.passed) bucket.passed += 1;
  }
  return out;
}

/** Every question is classified exactly once, or a per-capability rate lies. */
export function groupingIsTotal(questionIds: string[]): boolean {
  return (
    questionIds.every((id) => CAPABILITY_OF[id] !== undefined) &&
    Object.keys(CAPABILITY_OF).length === questionIds.length
  );
}

// ---------------------------------------------------------------------------
// The id-permutation control
// ---------------------------------------------------------------------------

const PREFIXES = ["ent", "src", "clm", "rel"] as const;

/**
 * A deterministic bijection over fixture ids, within each kind.
 *
 * Rotation by one over the sorted ids: total, reversible, and it changes the
 * lexical ORDER of every id without changing the structure they describe. That
 * is the point — several places in this harness sort sets by id, and a lane
 * whose answer depended on that ordering would produce a different result under
 * a permutation while claiming the same semantics.
 */
export function buildPermutation(text: string): Record<string, string> {
  const mapping: Record<string, string> = {};
  for (const prefix of PREFIXES) {
    const found = [...new Set(text.match(new RegExp(`"${prefix}:[A-Za-z0-9._-]+"`, "g")) ?? [])]
      .map((quoted) => quoted.slice(1, -1))
      .sort();
    found.forEach((id, index) => {
      mapping[id] = found[(index + 1) % found.length] ?? id;
    });
  }
  return mapping;
}

/**
 * Apply a permutation to a JSON document.
 *
 * Two-phase through placeholders, because a direct sequential rewrite of a
 * rotation would chase its own output: mapping `a -> b` and then `b -> c` would
 * turn the original `a` into `c`.
 *
 * Replacement is on the bare id rather than the quoted token, because the
 * contract DERIVES identifiers that embed one: an evidence id is `ev:<owner>#n`.
 * Matching only whole quoted tokens would rename the claim and leave its
 * evidence ids pointing at the old name, which then looks like an answer that
 * changed under permutation when it is really a restore that did not finish.
 *
 * Longest-first, because ids legitimately prefix one another — `ent:halyard` is
 * a prefix of `ent:halyard-api`. Placeholdering the longer id first is what
 * stops the shorter one from corrupting it.
 */
export function applyPermutation(value: unknown, mapping: Record<string, string>): unknown {
  let text = JSON.stringify(value);
  const keys = Object.keys(mapping).sort(
    (left, right) => right.length - left.length || (left < right ? -1 : 1),
  );
  keys.forEach((from, index) => {
    text = text.split(from).join(`\u0000P${index}\u0000`);
  });
  keys.forEach((from, index) => {
    text = text.split(`\u0000P${index}\u0000`).join(mapping[from] ?? from);
  });
  return JSON.parse(text);
}

/**
 * The answer a question carries, separated from its diagnostics.
 *
 * The audits report what they found AND how much they examined. The second
 * legitimately tracks how much state exists — and even how long the ids are — so
 * comparing it reports a variant as answer-changing when only its evidence of
 * having done the work moved.
 */
export function answerOnly(questionId: string, data: unknown): unknown {
  if (data === null || typeof data !== "object") return data;
  const record = data as Record<string, unknown>;
  if (questionId === "Q19") return { offenders: record.offenders };
  if (questionId === "Q20") return { occurrences: record.occurrences };
  return data;
}

/**
 * Arrays whose ORDER is part of the answer, and which must never be re-sorted.
 *
 * Everything else the read surface returns is a declared set, sorted at the call
 * site by a key made of ids. Under a permutation that sort runs in permuted
 * space, so mapping the answer back leaves a set correctly ordered for ids it no
 * longer has. Re-normalising is therefore comparing the answer rather than
 * comparing the harness's own sort — and the paired control that unmapped
 * answers must still differ is what stops this normalisation from erasing the
 * very difference it is meant to tolerate.
 */
const ORDER_IS_THE_ANSWER = new Set(["revisions", "attempts", "ranked"]);

export function normalizeForPermutation(value: unknown, key = ""): unknown {
  if (Array.isArray(value)) {
    const items = value.map((entry) => normalizeForPermutation(entry, key));
    if (ORDER_IS_THE_ANSWER.has(key)) return items;
    return [...items].sort((left, right) =>
      JSON.stringify(left) < JSON.stringify(right) ? -1 : 1,
    );
  }
  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const name of Object.keys(source).sort()) {
      out[name] = normalizeForPermutation(source[name], name);
    }
    return out;
  }
  return value;
}

export function invert(mapping: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [from, to] of Object.entries(mapping)) out[to] = from;
  return out;
}
