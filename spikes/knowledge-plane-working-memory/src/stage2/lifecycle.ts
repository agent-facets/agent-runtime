// The W3-only numerical lifecycle.
//
// Nothing here runs for W0, W1, W1A or W2, and nothing here is rendered. Scores
// affect selection and ordering; the model never sees a number, because a
// visible score would be a second treatment and W3 would then be testing two
// things at once.
//
// The weights and thresholds are frozen before any live call. Retrofitting them
// after seeing results is the mistake Stage 1's scorecard made — weights frozen,
// anchors never — and it cost that rubric its computability.

import type { Authority, ClaimRevision, Instant } from "../knowledge/contract.ts";
import type { LifecycleBlock } from "./contract.ts";

export const LIFECYCLE_WEIGHTS = Object.freeze({
  relevance: 0.4,
  authority: 0.25,
  evidence: 0.2,
  recency: 0.15,
  disputedPenalty: 0.5,
});

/** Two half-lives of decay before an item is marked decayed. */
export const RECENCY_HALF_LIFE_TICKS = 4;
export const HOT_THRESHOLD = 0.7;
export const WARM_THRESHOLD = 0.4;
export const EVIDENCE_SATURATION = 3;

const AUTHORITY_WEIGHT: Readonly<Record<Authority, number>> = Object.freeze({
  establishing: 1,
  corroborating: 0.7,
  proposing: 0.4,
  observational: 0.1,
});

/**
 * Distinct evidence-backed reinforcements of the pinned proposition.
 *
 * Counted from distinct evidence ids across the revisions that assert the same
 * value, so it can only move when the knowledge plane gains genuinely new
 * support. A prompt repeating a fact, a model restating it, or an arm injecting
 * it every turn cannot increment this — which is the whole point, since
 * otherwise W3 would reward itself for its own injection.
 */
export function reinforcementCountFor(chain: ClaimRevision[], pinnedRevision: number): number {
  const pinned = chain.find((entry) => entry.revision === pinnedRevision);
  if (!pinned) return 0;
  const supporting = new Set<string>();
  for (const entry of chain) {
    if (entry.value !== pinned.value) continue;
    for (const evidenceId of entry.evidenceIds) supporting.add(evidenceId);
  }
  return Math.max(0, supporting.size - 1);
}

export function recencyFactor(ageTicks: number): number {
  if (ageTicks <= 0) return 1;
  return 0.5 ** (ageTicks / RECENCY_HALF_LIFE_TICKS);
}

export type ScoreInput = {
  /** Treatment-free task relevance, taken from the shared retrieval bundle. */
  relevance: number;
  authority: Authority;
  distinctEvidence: number;
  ageTicks: number;
  disputed: boolean;
};

export function scoreFor(input: ScoreInput): number {
  const evidence = Math.min(input.distinctEvidence, EVIDENCE_SATURATION) / EVIDENCE_SATURATION;
  const raw =
    LIFECYCLE_WEIGHTS.relevance * clamp01(input.relevance) +
    LIFECYCLE_WEIGHTS.authority * AUTHORITY_WEIGHT[input.authority] +
    LIFECYCLE_WEIGHTS.evidence * evidence +
    LIFECYCLE_WEIGHTS.recency * recencyFactor(input.ageTicks) -
    (input.disputed ? LIFECYCLE_WEIGHTS.disputedPenalty : 0);
  return round6(raw);
}

export function lifecycleFor(score: number): "hot" | "warm" | "cold" {
  if (score >= HOT_THRESHOLD) return "hot";
  if (score >= WARM_THRESHOLD) return "warm";
  return "cold";
}

export function blockFor(
  input: ScoreInput,
  reinforcementCount: number,
  at: Instant,
): LifecycleBlock {
  const score = scoreFor(input);
  return {
    reinforcementCount,
    score,
    lifecycle: lifecycleFor(score),
    // Decayed after two half-lives. Recorded rather than inferred so the
    // evidence can show when an item crossed the line.
    decayedAt: recencyFactor(input.ageTicks) < 0.25 ? at : null,
  };
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/** Six decimal places: enough to order stably, few enough to survive a JSON round trip. */
function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}
