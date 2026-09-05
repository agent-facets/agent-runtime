// Tier derivation.
//
// A tier is computed from canonical state — authority, canon status, belief, and
// evidence count — and never accepted from a caller or parsed out of model text.
// Stage 1 had to repair exactly this shape once, when an agent could label its
// own output `human_direct`; a self-declared trust level is the same defect one
// layer up.

import type {
  Authority,
  ClaimRevision,
  Id,
  RelationshipRevision,
  ReviewDecisionRecord,
} from "../knowledge/contract.ts";
import type { ContextTier, HeadState, TierDerivation } from "./contract.ts";

/** A revision whose tier is being derived. Claims and relationships share the shape that matters. */
type Revisable = Pick<ClaimRevision, "belief" | "origin" | "evidenceIds"> & {
  canon?: boolean;
};

export type CanonDecisionLookup = (
  claimId: Id,
  revision: number,
) => ReviewDecisionRecord | null;

/**
 * Material that may not enter a protected block at all.
 *
 * Retracted and rejected material is structurally ineligible for the same reason
 * it is ineligible for retrieval: the point of retraction is that it stops being
 * available, not that it becomes available with a warning.
 */
export function isEligible(revision: Revisable & { redactionState?: string }): boolean {
  if (revision.belief === "retracted" || revision.belief === "rejected") return false;
  if (revision.redactionState === "purged") return false;
  // A peer report is not a claim and never reaches this function through the
  // knowledge path. If one ever does, it is a defect, not a low-tier fact.
  if (revision.origin.originKind === "peer_report") return false;
  return true;
}

/**
 * The derivation.
 *
 * Canon requires the flag AND a human decision that established it. The flag
 * alone would be enough in a correct store — `CanonizeClaim` refuses a
 * non-human actor — but Stage 2 writes the tier into a prompt, and a protected
 * fact should not rest on an invariant holding somewhere else.
 */
export function deriveTier(
  revision: Revisable,
  claimId: Id,
  revisionNumber: number,
  canonDecision: CanonDecisionLookup,
): { tier: ContextTier; derivation: TierDerivation } {
  const authority: Authority = revision.origin.authority;
  const evidenceCount = revision.evidenceIds.length;
  const canonFlag = revision.canon === true;

  const decision = canonFlag ? canonDecision(claimId, revisionNumber) : null;
  const canonEstablished =
    canonFlag &&
    decision !== null &&
    decision.decidedByClass === "human" &&
    decision.outcome === "canonize";

  const derivation: TierDerivation = {
    authority,
    canon: canonFlag,
    belief: revision.belief,
    evidenceCount,
    canonDecisionId: canonEstablished && decision ? decision.decisionId : null,
  };

  if (canonEstablished && revision.belief === "active") {
    return { tier: "canon", derivation };
  }

  // Disputed and proposed material is provisional however well evidenced it is:
  // the question is not how much support it has, it is whether the system has
  // settled on it.
  if (revision.belief === "proposed" || revision.belief === "disputed") {
    return { tier: "provisional", derivation };
  }

  if (authority === "establishing" || authority === "corroborating") {
    return { tier: "reliable", derivation };
  }

  return { tier: "provisional", derivation };
}

/**
 * What happened to a pinned revision since it was admitted.
 *
 * Read from the chain rather than from a flag on the pin, so a context revision
 * written before a correction still reports the correction at the next assembly.
 */
export function headStateOf(
  pinnedRevision: number,
  chain: Array<ClaimRevision | RelationshipRevision>,
): HeadState {
  const head = chain[chain.length - 1];
  if (!head) return "current";
  if (head.revision === pinnedRevision) {
    if (head.belief === "retracted") return "retracted";
    if (head.belief === "rejected") return "rejected";
    return "current";
  }

  const pinned = chain.find((entry) => entry.revision === pinnedRevision);
  if (!pinned) return "current";

  // The pinned revision's own closure reason is the honest answer: it says why
  // belief in THAT revision ended, which is the distinction the temporal
  // scenarios are built to detect.
  switch (pinned.closureReason) {
    case "world_progressed":
      return "world_progressed";
    case "corrected":
      return "corrected";
    case "summarized":
      return "summarized";
    case "retracted":
      return "retracted";
    case "rejected":
      return "rejected";
    case "merged":
      return "merged";
    default:
      break;
  }

  // Canon can be withdrawn without the revision changing, which is how a
  // protected fact quietly stops being protected.
  const pinnedCanon = (pinned as ClaimRevision).canon === true;
  const headCanon = (head as ClaimRevision).canon === true;
  if (pinnedCanon && !headCanon) return "decanonized";

  return "current";
}

/** Transitions that evict immediately rather than re-resolving. */
export function evictsOnTransition(state: HeadState): boolean {
  return state === "retracted" || state === "rejected";
}
