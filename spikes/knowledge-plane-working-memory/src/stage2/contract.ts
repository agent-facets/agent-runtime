// The Stage 2 active-context contract.
//
// Separate from `knowledge/1.0.0` on purpose. Stage 1's `ActiveContextRecord` is
// frozen: one fixture writes one of them at tick 78, it travels in the portable
// export, and its membership feeds a 0.05-weight episodic term in the shared
// retrieval fusion. Extending that type in place would change what the frozen
// corpus means and would make retrieval differ per arm, which the locked Stage 2
// handoff forbids.
//
// So Stage 2 gets its own version, its own storage label, and its own revision
// chain, and the Stage 1 type is left exactly as measured.
//
// This module imports no store driver, no filesystem, and no network client, for
// the same reason the knowledge contract does not: a contract that has grown one
// arm's shape cannot referee a comparison between arms.

import type {
  Authority,
  Id,
  Instant,
  Interval,
  OriginKind,
  VersionToken,
} from "../knowledge/contract.ts";

export const ACTIVE_CONTEXT_CONTRACT_VERSION = "active-context/1.0.0";

// ---------------------------------------------------------------------------
// Arms
// ---------------------------------------------------------------------------

/**
 * The five measured conditions.
 *
 * `W1A` is not a fifth treatment. It is W1 under a different label, and the
 * experiment is only interpretable if it stays that way — see `ARM_POLICIES`,
 * where W1 and W1A resolve to the same frozen policy object.
 */
export type ArmId = "W0" | "W1" | "W1A" | "W2" | "W3";

export const ARM_IDS: readonly ArmId[] = ["W0", "W1", "W1A", "W2", "W3"] as const;

// ---------------------------------------------------------------------------
// Tiers
// ---------------------------------------------------------------------------

/**
 * What a context entry is permitted to be relied on for.
 *
 * Derived, never declared by the caller and never parsed out of model text. A
 * self-labelled tier is the same defect as a self-labelled `originKind`, which
 * Stage 1 had to repair once already.
 */
export type ContextTier = "canon" | "reliable" | "provisional" | "attributed";

export const TIER_ORDER: readonly ContextTier[] = [
  "canon",
  "reliable",
  "provisional",
  "attributed",
] as const;

/** Why an item carries the tier it carries. Recorded so the derivation is auditable. */
export type TierDerivation = {
  authority: Authority;
  canon: boolean;
  belief: string;
  evidenceCount: number;
  /** The human decision that established canon, when one applies. */
  canonDecisionId: Id | null;
};

/**
 * What happened to the pinned revision since it was admitted.
 *
 * `world_progressed` and `corrected` stay distinct here for the same reason they
 * stay distinct in the knowledge plane: one says the world moved on and the old
 * revision remains true of its own interval, the other says we were wrong about
 * that interval. Collapsing them would make a temporal update indistinguishable
 * from a correction in exactly the scenario built to tell them apart.
 */
export type HeadState =
  | "current"
  | "world_progressed"
  | "corrected"
  | "summarized"
  | "retracted"
  | "rejected"
  | "decanonized"
  | "merged";

export type ExclusionReason =
  | "budget_items"
  | "budget_tokens"
  | "retracted"
  | "rejected"
  | "purged"
  | "decanonized"
  | "superseded_unresolvable"
  | "peer_unpromoted"
  | "sensitivity"
  | "out_of_world_interval"
  | "below_lifecycle_floor";

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

/**
 * The W3-only lifecycle block.
 *
 * Physically absent in W0, W1, W1A and W2 rather than present-and-zeroed. A
 * zeroed field is still a field: it would appear in stored state, in the
 * evidence, and — one careless render away — in a prompt, which would make the
 * simpler arms carry a trace of the machinery they exist to be compared against.
 */
export type LifecycleBlock = {
  /** Distinct evidence-backed knowledge reinforcements. Never incremented by a mention. */
  reinforcementCount: number;
  /** Selection score. Never rendered: a visible number is a second treatment. */
  score: number;
  lifecycle: "hot" | "warm" | "cold";
  decayedAt: Instant | null;
};

export type KnowledgeContextItem = {
  kind: "knowledge";
  /** Always a pinned revision. A bare id is unreproducible and therefore invalid. */
  ref: { kind: "claim" | "relationship"; id: Id; revision: number };
  /** The version token at pin time, so a later divergence is detectable. */
  pinnedVersionToken: VersionToken;
  /** A render snapshot for reproducibility. The referenced revision remains authoritative. */
  statement: string;
  tier: ContextTier;
  tierDerivation: TierDerivation;
  headState: HeadState;
  originKind: OriginKind;
  evidenceCount: number;
  valid: Interval;
  admittedAtTick: number;
  lifecycle?: LifecycleBlock;
};

/**
 * A verified or unverified observation from the execution plane or a source
 * document. Not knowledge: it has not been through reconciliation.
 */
export type ObservationContextItem = {
  kind: "observation";
  ref: { kind: "execution_event" | "source"; id: Id };
  statement: string;
  tier: "reliable" | "provisional";
  verification: "mechanically_verified" | "unverified";
  /** Digest of the observed artifact, so the claim to verification is checkable. */
  observedDigest: string;
  admittedAtTick: number;
  lifecycle?: LifecycleBlock;
};

/**
 * Peer material.
 *
 * A separate type with a single legal tier, mirroring `ContradictionRecord`'s
 * `peerMembers`. Non-promotion is structural: there is no collection here that
 * holds a peer report and a claim together, so no filter has to remember to keep
 * them apart.
 */
export type PeerContextItem = {
  kind: "peer";
  recordId: string;
  publisherNodeId: Id;
  summary: string;
  tier: "attributed";
  ingestRef: string;
  admittedAtTick: number;
};

export type ContextItem = KnowledgeContextItem | ObservationContextItem | PeerContextItem;

export type ContextExclusion = {
  ref: { kind: string; id: Id; revision?: number };
  reason: ExclusionReason;
  priorTier: ContextTier | null;
  /** The head transition that caused the removal, when one did. */
  transition: HeadState | null;
};

// ---------------------------------------------------------------------------
// Compaction
// ---------------------------------------------------------------------------

/**
 * Proof that a compaction actually happened.
 *
 * Stage 2 acceptance requires compaction to occur, not to be asserted. Without a
 * witness carrying both sides of the boundary, "compaction occurred" is a claim
 * with no oracle — the same shape as the Stage 1 criteria that turned out to be
 * vacuous by construction.
 */
export type CompactionWitness = {
  scope: "transcript" | "active_context";
  triggeredBy: "turn_boundary" | "budget_items" | "budget_tokens" | "forced";
  before: { itemCount: number; neutralTokens: number; digest: string };
  after: { itemCount: number; neutralTokens: number; digest: string };
  droppedRefs: Array<{ kind: string; id: string }>;
  droppedTurnIds: string[];
  estimatorId: string;
};

// ---------------------------------------------------------------------------
// The revision
// ---------------------------------------------------------------------------

export type ContextBudget = { maxItems: number; maxNeutralTokens: number };

/**
 * What the assembly read, so a resume can prove it reconstructed the same view.
 *
 * The retrieval digest is the load-bearing one: it is computed from a
 * treatment-free snapshot before any arm writes anything, and every arm must
 * present the same value or retrieval was not held constant.
 */
export type AssemblyBasis = {
  knowledgeSnapshotDigest: string;
  retrievalBundleDigest: string;
  scenarioStateDigest: string;
};

/**
 * How this context is to be rendered.
 *
 * Derived from the arm policy at assembly time and carried on the revision, so
 * the renderer can format a block without importing the policy module or
 * learning that arms exist. It is the difference between "the renderer behaves
 * differently per arm" and "the renderer formats the plan it was handed".
 */
export type ContextPresentation = {
  /** `null` renders no block at all. */
  heading: string | null;
  labelTiers: boolean;
  peerSection: boolean;
};

export type ActiveContextRevision = {
  contractVersion: string;
  contextId: Id;
  workItemId: Id;
  attemptId: string;
  /** Opaque in evidence. Never reaches a rendered prompt. */
  armId: ArmId;
  revision: number;
  supersedes: { contextId: Id; revision: number } | null;
  asOfTransaction: Instant;
  tick: number;
  budget: ContextBudget;
  basis: AssemblyBasis;
  presentation: ContextPresentation;
  items: Array<KnowledgeContextItem | ObservationContextItem>;
  /** Structurally separate from `items`. Never merged, never promoted. */
  peerItems: PeerContextItem[];
  excluded: ContextExclusion[];
  compaction: CompactionWitness | null;
  /** Digest of the exact rendered block, for prompt-equality checking. */
  renderDigest: string;
  versionToken: VersionToken;
};

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type ContextErrorCode =
  /** Canon alone exceeded the budget. Silently dropping a protected fact is not an option. */
  | "CONTEXT_BUDGET_EXCEEDED"
  | "CONTEXT_STALE_VERSION"
  | "CONTEXT_UNPINNED_REF"
  | "CONTEXT_PEER_IN_KNOWLEDGE"
  | "CONTEXT_TIER_NOT_DERIVED"
  | "CONTEXT_BASIS_MISMATCH";

export class ContextRejected extends Error {
  readonly code: ContextErrorCode;
  readonly detail: Record<string, unknown>;

  constructor(code: ContextErrorCode, detail: Record<string, unknown> = {}) {
    super(`${code}: ${JSON.stringify(detail)}`);
    this.name = "ContextRejected";
    this.code = code;
    this.detail = detail;
  }
}
