// The entire treatment surface, in one declared record.
//
// This module is the ONLY thing in Stage 2 that knows arms exist. `assemble`
// reads an `ArmPolicy`; `render`, the session loop, the store, the evaluator and
// the judge never see one. If a difference between arms can appear anywhere
// other than through this record, the experiment is measuring something it did
// not declare.
//
// The self-test asserts that `render.ts` does not import this file.

import type { ArmId, ContextBudget, ContextTier } from "./contract.ts";

/**
 * `presence`      whether a protected block exists at all.
 * `tiers`         which derived tiers may be admitted.
 * `governance`    tier labels, re-resolution, protected canon, supersession.
 * `lifecycle`     numerical selection, reinforcement, decay, hot/warm/cold.
 * `peerSection`   whether attributed peer material is rendered separately.
 */
export type ArmPolicy = {
  presence: "none" | "always";
  tiers: readonly ContextTier[];
  governance: boolean;
  lifecycle: boolean;
  peerSection: boolean;
  /** The rendered section heading. `null` renders nothing. */
  heading: string | null;
  labelTiers: boolean;
  budget: ContextBudget;
};

/**
 * The frozen budget, identical for every arm that has a block at all.
 *
 * Neutral tokens rather than provider tokens: two providers tokenise
 * differently, and an arm that got more content on Anthropic than on OpenAI
 * would confound the model-class comparison with the treatment.
 */
export const CONTEXT_BUDGET: ContextBudget = { maxItems: 8, maxNeutralTokens: 800 };

/** W0 has no protected block. Retrieval and the task are unchanged. */
const W0: ArmPolicy = {
  presence: "none",
  tiers: [],
  governance: false,
  lifecycle: false,
  peerSection: false,
  heading: null,
  labelTiers: false,
  budget: CONTEXT_BUDGET,
};

/**
 * W1: a small static established-facts block, pinned at scenario start.
 *
 * No tiers, no authority labels, no re-resolution, no supersession, no ranking.
 * This is the ARC-Mem result stated at its narrowest — re-injecting facts the
 * baseline also saw — and it is the thing W2 has to beat to justify governance.
 */
const W1: ArmPolicy = {
  presence: "always",
  tiers: ["canon", "reliable"],
  governance: false,
  lifecycle: false,
  peerSection: false,
  heading: "ESTABLISHED FACTS",
  labelTiers: false,
  budget: CONTEXT_BUDGET,
};

const W2: ArmPolicy = {
  presence: "always",
  tiers: ["canon", "reliable", "provisional"],
  governance: true,
  lifecycle: false,
  peerSection: true,
  heading: "ACTIVE CONTEXT",
  labelTiers: true,
  budget: CONTEXT_BUDGET,
};

const W3: ArmPolicy = {
  presence: "always",
  tiers: ["canon", "reliable", "provisional"],
  governance: true,
  lifecycle: true,
  peerSection: true,
  heading: "ACTIVE CONTEXT",
  labelTiers: true,
  budget: CONTEXT_BUDGET,
};

/**
 * W1 and W1A resolve to the SAME object, not to two equal objects.
 *
 * Object identity rather than deep equality because equality is a property
 * someone can break with a one-character edit and nothing would fail loudly. The
 * A/A floor only measures noise if the two arms are byte-identical downstream,
 * so the strongest available guarantee belongs here rather than in a test.
 */
export const ARM_POLICIES: Readonly<Record<ArmId, ArmPolicy>> = Object.freeze({
  W0,
  W1,
  W1A: W1,
  W2,
  W3,
});

export function policyFor(arm: ArmId): ArmPolicy {
  return ARM_POLICIES[arm];
}

/** The A/A pair. Anything that breaks this equality invalidates the noise floor. */
export function aaPairIsIdentical(): boolean {
  return ARM_POLICIES.W1 === ARM_POLICIES.W1A;
}

/**
 * The declared incremental structure of the experiment.
 *
 * Each step adds exactly one mechanism, so a delta has one candidate
 * explanation rather than several.
 */
export const ARM_LADDER: ReadonlyArray<{ from: ArmId; to: ArmId; adds: string }> = [
  { from: "W0", to: "W1", adds: "mandatory presence" },
  { from: "W1", to: "W2", adds: "governance: tiers, re-resolution, protected canon, supersession" },
  { from: "W2", to: "W3", adds: "numerical lifecycle: selection, reinforcement, decay, tiering" },
  { from: "W1", to: "W1A", adds: "nothing — noise floor" },
];
