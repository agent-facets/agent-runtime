// Context assembly: one function, five arms.
//
// This is the only code path in Stage 2 that reads an `ArmPolicy`. Everything
// downstream — rendering, the session loop, persistence, the evaluator, the
// judge — receives an `ActiveContextRevision` and cannot tell which arm produced
// it.
//
// Assembly happens at a turn or attempt boundary and never mid-generation, for
// the same reason extraction is a distinct step from generation: a context that
// can change while a response is being produced is not a bounded view of
// anything.

import { CLOCK_TICK_MS, tickToInstant } from "../contract.ts";
import { digest } from "../canonical.ts";
import type {
  ClaimRevision,
  Id,
  Instant,
  RelationshipRevision,
  ReviewDecisionRecord,
  VersionToken,
} from "../knowledge/contract.ts";
import type { KnowledgeState } from "../knowledge/policy.ts";
import type { ArmPolicy } from "./policy.ts";
import { blockFor, reinforcementCountFor } from "./lifecycle.ts";
import { ESTIMATOR_ID, neutralTokens } from "./tokens.ts";
import { deriveTier, evictsOnTransition, headStateOf, isEligible } from "./tier.ts";
import type {
  ActiveContextRevision,
  ArmId,
  AssemblyBasis,
  CompactionWitness,
  ContextExclusion,
  ContextTier,
  KnowledgeContextItem,
  ObservationContextItem,
  PeerContextItem,
} from "./contract.ts";
import { ACTIVE_CONTEXT_CONTRACT_VERSION, ContextRejected } from "./contract.ts";

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/**
 * One entry of the shared retrieval bundle.
 *
 * Computed once per scenario turn from a treatment-free snapshot, BEFORE any arm
 * writes anything, and replayed byte-identically to all five arms. `relevance`
 * is therefore treatment-free by construction, which is what lets W3 use it as a
 * scoring input without the score becoming self-referential.
 */
export type RetrievalEntry = { claimId: Id; relevance: number };

export type ObservationInput = {
  refKind: "execution_event" | "source";
  id: Id;
  statement: string;
  verification: "mechanically_verified" | "unverified";
  observedDigest: string;
};

export type PeerInput = {
  recordId: string;
  publisherNodeId: Id;
  summary: string;
  ingestRef: string;
};

export type AssemblyInput = {
  state: KnowledgeState;
  workItemId: Id;
  attemptId: string;
  armId: ArmId;
  policy: ArmPolicy;
  tick: number;
  contextId: Id;
  /** Claims the work item or scenario declares as constraints or decisions. */
  declaredClaimIds: readonly Id[];
  retrieval: readonly RetrievalEntry[];
  observations: readonly ObservationInput[];
  peers: readonly PeerInput[];
  basis: AssemblyBasis;
  /** The previous revision of this context, when one exists. */
  prior: ActiveContextRevision | null;
};

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

export function assemble(input: AssemblyInput): ActiveContextRevision {
  const asOf = tickToInstant(input.tick);
  const revisionNumber = input.prior ? input.prior.revision + 1 : 1;

  const base: Omit<ActiveContextRevision, "renderDigest" | "versionToken"> = {
    contractVersion: ACTIVE_CONTEXT_CONTRACT_VERSION,
    contextId: input.contextId,
    workItemId: input.workItemId,
    attemptId: input.attemptId,
    armId: input.armId,
    revision: revisionNumber,
    supersedes: input.prior
      ? { contextId: input.prior.contextId, revision: input.prior.revision }
      : null,
    asOfTransaction: asOf,
    tick: input.tick,
    budget: input.policy.budget,
    basis: input.basis,
    presentation: {
      heading: input.policy.heading,
      labelTiers: input.policy.labelTiers,
      peerSection: input.policy.peerSection,
    },
    items: [],
    peerItems: [],
    excluded: [],
    compaction: null,
  };

  if (input.policy.presence === "none") {
    return finalize(base);
  }

  // W1 and W1A are STATIC. Pinned once at scenario start and carried forward
  // unchanged: no re-resolution, no eviction on retraction, no supersession.
  // That is the treatment, not an oversight — it is precisely what W2's
  // governance has to beat to justify its complexity.
  if (!input.policy.governance && input.prior !== null) {
    return finalize({
      ...base,
      items: input.prior.items,
      peerItems: input.prior.peerItems,
      excluded: [],
    });
  }

  const excluded: ContextExclusion[] = [];
  const candidates = collectKnowledge(input, excluded);
  const observations = collectObservations(input);
  const peers = input.policy.peerSection ? collectPeers(input) : [];

  if (!input.policy.peerSection) {
    for (const peer of input.peers) {
      excluded.push({
        ref: { kind: "activity_record", id: peer.recordId },
        reason: "peer_unpromoted",
        priorTier: null,
        transition: null,
      });
    }
  }

  const admitted = applyBudget(
    [...candidates, ...observations],
    input.policy,
    excluded,
  );

  const ordered = orderItems(admitted, input);
  const compaction = witnessFor(
    [...candidates, ...observations],
    ordered,
    excluded,
    input.policy,
  );

  return finalize({ ...base, items: ordered, peerItems: peers, excluded, compaction });
}

// ---------------------------------------------------------------------------
// Knowledge candidates
// ---------------------------------------------------------------------------

function collectKnowledge(
  input: AssemblyInput,
  excluded: ContextExclusion[],
): KnowledgeContextItem[] {
  const { state, policy } = input;
  const asOf = tickToInstant(input.tick);
  const allowed = new Set<ContextTier>(policy.tiers);
  const relevanceOf = new Map<Id, number>();
  for (const entry of input.retrieval) relevanceOf.set(entry.claimId, entry.relevance);

  // Declared constraints first, then retrieved material. Declared ids are not
  // ranked: a constraint the work item names is in scope whether or not a
  // similarity function happened to surface it.
  const claimIds: Id[] = [];
  const seen = new Set<Id>();
  for (const id of [...input.declaredClaimIds, ...input.retrieval.map((e) => e.claimId)]) {
    if (seen.has(id)) continue;
    seen.add(id);
    claimIds.push(id);
  }

  const canonDecision = canonDecisionLookup(state);
  const items: KnowledgeContextItem[] = [];

  for (const claimId of claimIds) {
    const chain = state.claims.get(claimId) ?? [];
    const head = chain[chain.length - 1];
    if (!head) continue;

    const priorPin = pinnedRevisionOf(input.prior, claimId);
    const headState = priorPin === null ? "current" : headStateOf(priorPin, chain);

    if (evictsOnTransition(headState) || !isEligible(head)) {
      excluded.push({
        ref: { kind: "claim", id: claimId, revision: priorPin ?? head.revision },
        reason: head.belief === "rejected" ? "rejected" : "retracted",
        priorTier: priorTierOf(input.prior, claimId),
        transition: headState,
      });
      continue;
    }

    // Re-resolution pins the CURRENT head. A world-time update therefore carries
    // the successor, and the prior revision stays visible in the exclusion trail
    // rather than silently vanishing.
    const { tier, derivation } = deriveTier(head, claimId, head.revision, canonDecision);

    if (!allowed.has(tier)) {
      excluded.push({
        ref: { kind: "claim", id: claimId, revision: head.revision },
        reason: tier === "provisional" ? "below_lifecycle_floor" : "sensitivity",
        priorTier: priorTierOf(input.prior, claimId),
        transition: headState === "current" ? null : headState,
      });
      continue;
    }

    if (headState === "decanonized") {
      excluded.push({
        ref: { kind: "claim", id: claimId, revision: priorPin ?? head.revision },
        reason: "decanonized",
        priorTier: priorTierOf(input.prior, claimId),
        transition: "decanonized",
      });
    }

    const item: KnowledgeContextItem = {
      kind: "knowledge",
      ref: { kind: "claim", id: claimId, revision: head.revision },
      pinnedVersionToken: head.versionToken,
      statement: statementOf(head),
      tier,
      tierDerivation: derivation,
      headState,
      originKind: head.origin.originKind,
      evidenceCount: head.evidenceIds.length,
      valid: head.valid,
      admittedAtTick: input.tick,
    };

    if (policy.lifecycle) {
      item.lifecycle = blockFor(
        {
          relevance: relevanceOf.get(claimId) ?? 0,
          authority: head.origin.authority,
          distinctEvidence: new Set(head.evidenceIds).size,
          ageTicks: ageTicksOf(head.assertedAt, asOf),
          disputed: head.belief === "disputed",
        },
        reinforcementCountFor(chain, head.revision),
        asOf,
      );
    }

    items.push(item);
  }

  return items;
}

function collectObservations(input: AssemblyInput): ObservationContextItem[] {
  const asOf = tickToInstant(input.tick);
  return input.observations.map((observation) => {
    const item: ObservationContextItem = {
      kind: "observation",
      ref: { kind: observation.refKind, id: observation.id },
      statement: observation.statement,
      tier: observation.verification === "mechanically_verified" ? "reliable" : "provisional",
      verification: observation.verification,
      observedDigest: observation.observedDigest,
      admittedAtTick: input.tick,
    };
    if (input.policy.lifecycle) {
      item.lifecycle = blockFor(
        {
          relevance: 0.5,
          authority: item.tier === "reliable" ? "corroborating" : "proposing",
          distinctEvidence: 1,
          ageTicks: 0,
          disputed: false,
        },
        0,
        asOf,
      );
    }
    return item;
  });
}

function collectPeers(input: AssemblyInput): PeerContextItem[] {
  return input.peers.map((peer) => ({
    kind: "peer" as const,
    recordId: peer.recordId,
    publisherNodeId: peer.publisherNodeId,
    summary: peer.summary,
    tier: "attributed" as const,
    ingestRef: peer.ingestRef,
    admittedAtTick: input.tick,
  }));
}

// ---------------------------------------------------------------------------
// Budget
// ---------------------------------------------------------------------------

type Admissible = KnowledgeContextItem | ObservationContextItem;

/**
 * Categorical eviction, canon last and never silently.
 *
 * If canon alone does not fit, assembly fails loudly rather than dropping a
 * protected fact. A protected block that quietly discards the thing it was
 * protecting is worse than no protected block, because the failure is invisible
 * in the transcript and looks like a model error.
 */
function applyBudget(
  items: Admissible[],
  policy: ArmPolicy,
  excluded: ContextExclusion[],
): Admissible[] {
  const canon = items.filter((item) => item.tier === "canon");
  const canonTokens = tokensOf(canon);

  if (canon.length > policy.budget.maxItems || canonTokens > policy.budget.maxNeutralTokens) {
    throw new ContextRejected("CONTEXT_BUDGET_EXCEEDED", {
      canonItems: canon.length,
      canonNeutralTokens: canonTokens,
      budget: policy.budget,
    });
  }

  // Eviction order: attributed material never reaches here, then provisional,
  // then reliable. Within a tier, later-ranked items go first — for W3 that is
  // ascending score, for W2 it is reverse declaration order, and both are
  // deterministic.
  const evictionOrder: ContextTier[] = ["provisional", "reliable"];
  const kept = [...items];

  const overBudget = (): boolean =>
    kept.length > policy.budget.maxItems || tokensOf(kept) > policy.budget.maxNeutralTokens;

  for (const tier of evictionOrder) {
    while (overBudget()) {
      const index = lastIndexOfTier(kept, tier, policy);
      if (index === -1) break;
      const [dropped] = kept.splice(index, 1);
      if (!dropped) break;
      excluded.push({
        ref: refOf(dropped),
        reason: kept.length >= policy.budget.maxItems ? "budget_items" : "budget_tokens",
        priorTier: dropped.tier,
        transition: null,
      });
    }
    if (!overBudget()) break;
  }

  return kept;
}

function lastIndexOfTier(items: Admissible[], tier: ContextTier, policy: ArmPolicy): number {
  let worst = -1;
  let worstScore = Number.POSITIVE_INFINITY;
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (!item || item.tier !== tier) continue;
    if (policy.lifecycle) {
      const score = item.lifecycle?.score ?? 0;
      if (score < worstScore) {
        worstScore = score;
        worst = index;
      }
      continue;
    }
    worst = index;
  }
  return worst;
}

// ---------------------------------------------------------------------------
// Ordering
// ---------------------------------------------------------------------------

/**
 * Canon always first, then the rest.
 *
 * W2 orders the remainder categorically — declared constraints, then reliable,
 * then provisional — and W3 orders it by score. Canon bypasses scoring in both,
 * so a lifecycle change can never demote a protected fact below an unprotected
 * one.
 */
function orderItems(items: Admissible[], input: AssemblyInput): Admissible[] {
  const declared = new Set(input.declaredClaimIds);
  const rank = (item: Admissible): number => {
    if (item.tier === "canon") return 0;
    if (item.kind === "knowledge" && declared.has(item.ref.id)) return 1;
    if (item.tier === "reliable") return 2;
    return 3;
  };

  return [...items].sort((left, right) => {
    const byRank = rank(left) - rank(right);
    if (byRank !== 0) return byRank;
    if (input.policy.lifecycle && left.tier !== "canon" && right.tier !== "canon") {
      const byScore = (right.lifecycle?.score ?? 0) - (left.lifecycle?.score ?? 0);
      if (byScore !== 0) return byScore;
    }
    const a = refKey(left);
    const b = refKey(right);
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

// ---------------------------------------------------------------------------
// Compaction witness
// ---------------------------------------------------------------------------

function witnessFor(
  eligible: Admissible[],
  kept: Admissible[],
  excluded: ContextExclusion[],
  policy: ArmPolicy,
): CompactionWitness | null {
  const budgetDrops = excluded.filter(
    (entry) => entry.reason === "budget_items" || entry.reason === "budget_tokens",
  );
  if (budgetDrops.length === 0) return null;

  const byTokens = budgetDrops.some((entry) => entry.reason === "budget_tokens");
  return {
    scope: "active_context",
    triggeredBy: byTokens ? "budget_tokens" : "budget_items",
    before: {
      itemCount: eligible.length,
      neutralTokens: tokensOf(eligible),
      digest: digest(eligible.map(refKey)),
    },
    after: {
      itemCount: kept.length,
      neutralTokens: tokensOf(kept),
      digest: digest(kept.map(refKey)),
    },
    droppedRefs: budgetDrops.map((entry) => ({ kind: entry.ref.kind, id: entry.ref.id })),
    droppedTurnIds: [],
    estimatorId: ESTIMATOR_ID,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function finalize(
  base: Omit<ActiveContextRevision, "renderDigest" | "versionToken">,
): ActiveContextRevision {
  // The version token is derived from canonical content alone, so it survives a
  // dump and restore and cannot be minted from store-internal identity.
  const token: VersionToken = digest({
    contextId: base.contextId,
    revision: base.revision,
    items: base.items,
    peerItems: base.peerItems,
    excluded: base.excluded,
  });
  return { ...base, renderDigest: "", versionToken: token };
}

function canonDecisionLookup(state: KnowledgeState) {
  return (claimId: Id, revision: number): ReviewDecisionRecord | null => {
    for (const decision of state.decisions.values()) {
      if (decision.outcome !== "canonize") continue;
      const hit = decision.targets.some(
        (target) =>
          target.kind === "claim" &&
          target.id === claimId &&
          (target.revision === null || target.revision === revision),
      );
      if (hit) return decision;
    }
    return null;
  };
}

function statementOf(revision: ClaimRevision | RelationshipRevision): string {
  if ("predicate" in revision) {
    return `${revision.subject} ${revision.predicate} ${revision.value}`;
  }
  return `${revision.from} ${revision.relType} ${revision.to}`;
}

function pinnedRevisionOf(prior: ActiveContextRevision | null, claimId: Id): number | null {
  if (!prior) return null;
  for (const item of prior.items) {
    if (item.kind === "knowledge" && item.ref.id === claimId) return item.ref.revision;
  }
  return null;
}

function priorTierOf(prior: ActiveContextRevision | null, claimId: Id): ContextTier | null {
  if (!prior) return null;
  for (const item of prior.items) {
    if (item.kind === "knowledge" && item.ref.id === claimId) return item.tier;
  }
  return null;
}

function ageTicksOf(assertedAt: Instant, asOf: Instant): number {
  const delta = Date.parse(asOf) - Date.parse(assertedAt);
  if (!Number.isFinite(delta) || delta <= 0) return 0;
  return delta / CLOCK_TICK_MS;
}

function refOf(item: Admissible): ContextExclusion["ref"] {
  return item.kind === "knowledge"
    ? { kind: item.ref.kind, id: item.ref.id, revision: item.ref.revision }
    : { kind: item.ref.kind, id: item.ref.id };
}

function refKey(item: Admissible): string {
  return item.kind === "knowledge"
    ? `${item.ref.kind}:${item.ref.id}#${item.ref.revision}`
    : `${item.ref.kind}:${item.ref.id}`;
}

function tokensOf(items: Admissible[]): number {
  let total = 0;
  for (const item of items) total += neutralTokens(item.statement);
  return total;
}
