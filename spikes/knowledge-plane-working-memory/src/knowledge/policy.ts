// The command service: validation, authority, guards, and lifecycle semantics.
//
// This module is SHARED by both lanes on purpose. Authority rules, temporal
// semantics, and refusal codes are properties of the contract, not of a store;
// letting each lane re-implement them is how two lanes end up being compared on
// two different sets of rules. What differs between lanes is persistence, and
// persistence alone.
//
// It imports no store driver. It reads a neutral state snapshot the lane
// materialises from its own canonical store, and it emits a plan the lane
// applies. Nothing here knows what a file or a node is.

import { stableValue } from "../canonical.ts";
import type {
  Actor,
  ClaimRevision,
  CommandRequest,
  ContradictionRecord,
  EntityEffect,
  EntityRecord,
  ErrorCode,
  EvidenceRecord,
  Id,
  Instant,
  Interval,
  Origin,
  Ref,
  RelationshipRevision,
  ReviewDecisionRecord,
  Sensitivity,
  SourceRefRecord,
  TypedError,
} from "./contract.ts";

// ---------------------------------------------------------------------------
// The neutral state snapshot a lane materialises from canonical state
// ---------------------------------------------------------------------------

export type KnowledgeState = {
  entities: Map<Id, EntityRecord>;
  /** All revisions, in order, per claim. Append-only. */
  claims: Map<Id, ClaimRevision[]>;
  relationships: Map<Id, RelationshipRevision[]>;
  evidence: Map<Id, EvidenceRecord>;
  sources: Map<Id, SourceRefRecord>;
  contradictions: Map<Id, ContradictionRecord>;
  decisions: Map<Id, ReviewDecisionRecord>;
  /** Peer material, structurally separate. Nothing here can become a claim. */
  peerRecords: Map<string, Record<string, unknown>>;
  candidates: Map<Id, { candidateId: Id; recordId: string; status: "unreviewed" }>;
  activeContexts: Map<Id, Record<string, unknown>>;
  published: Map<string, Record<string, unknown>>;
  /** Contentless records of refused sensitive candidates. */
  rejections: Array<{ reason: string; sourceRefId: Id; decidedAt: Instant; contentHash: string }>;
};

export function emptyState(): KnowledgeState {
  return {
    entities: new Map(),
    claims: new Map(),
    relationships: new Map(),
    evidence: new Map(),
    sources: new Map(),
    contradictions: new Map(),
    decisions: new Map(),
    peerRecords: new Map(),
    candidates: new Map(),
    activeContexts: new Map(),
    published: new Map(),
    rejections: [],
  };
}

export type PlanOp =
  | { op: "put-source"; record: SourceRefRecord }
  | {
      op: "put-entity";
      record: EntityRecord;
      /**
       * The op asserts this entity does not exist yet, and the lane must enforce
       * that with whatever its store actually offers — a uniqueness constraint on
       * insert in Lane N, an exclusive create in Lane M.
       *
       * Without it `expected_absent` was a guard that checked nothing: the
       * policy's in-memory duplicate check reads a snapshot taken before the
       * write, so two writers both pass it and the second silently overwrites.
       */
      mustBeNew?: boolean;
    }
  | { op: "put-evidence"; record: EvidenceRecord }
  /**
   * Create the claim SHELL, with no revision.
   *
   * Only the import path emits this. A claim that derives from another claim
   * needs the target to exist before the derivation edge can be written, and
   * neither store fails loudly when it does not — so without an explicit shell
   * pass the edges survive an import only when the ids happen to sort the right
   * way.
   */
  | { op: "ensure-claim"; claimId: Id; subject: Id }
  | { op: "append-claim-revision"; revision: ClaimRevision }
  | {
      op: "close-claim-revision";
      claimId: Id;
      revision: number;
      until: Instant;
      reason: string;
      /**
       * World progression narrows the prior revision's world interval; a
       * correction leaves it alone. `null` means "do not touch it", which is
       * what keeps the two lifecycles distinguishable at read time.
       */
      narrowValidTo: Instant | null;
    }
  | { op: "append-relationship-revision"; revision: RelationshipRevision }
  | {
      op: "close-relationship-revision";
      relationshipId: Id;
      revision: number;
      until: Instant;
      reason: string;
      validTo: Instant | null;
    }
  | { op: "put-contradiction"; record: ContradictionRecord }
  | { op: "put-decision"; record: ReviewDecisionRecord }
  | { op: "set-canon"; claimId: Id; revision: number; canon: boolean }
  | { op: "purge-claim-content"; claimId: Id }
  | { op: "put-peer-record"; recordId: string; record: Record<string, unknown> }
  | { op: "put-candidate"; candidateId: Id; recordId: string }
  | { op: "put-active-context"; activeContextId: Id; record: Record<string, unknown> }
  | { op: "publish-record"; recordId: string; record: Record<string, unknown> }
  | {
      op: "record-rejection";
      reason: string;
      sourceRefId: Id;
      contentHash: string;
      decidedAt: Instant;
    };

export type Plan = {
  ops: PlanOp[];
  effects: EntityEffect[];
  /**
   * True when an effect leaves the canonical store's reach entirely — erasure
   * that must also reach exports, or a publication into the coordination plane.
   *
   * Atomicity itself is deliberately NOT declared here. This module is shared by
   * both lanes, so any class it named would be a class one of them cannot
   * honestly provide: a file tree has no multi-object transaction and a graph
   * does. Each adapter derives its own class from the plan's shape through its
   * `CapabilityProfile`, which is what keeps Lane N's transactional advantage a
   * measured result rather than something the contract levelled away.
   */
  crossesBoundary: boolean;
  /** Non-empty when a derived structure will lag canonical state after this plan. */
  derivedObligations: string[];
};

/**
 * Distinct canonical objects a plan writes.
 *
 * Counted by target identity rather than by op count, because two ops against
 * one claim are one object: appending a revision and closing its predecessor
 * touch the same file and the same node.
 */
export function objectsTouched(ops: PlanOp[]): number {
  const keys = new Set<string>();
  for (const op of ops) {
    switch (op.op) {
      case "put-source":
        keys.add(`source:${op.record.sourceRefId}`);
        break;
      case "put-entity":
        keys.add(`entity:${op.record.entityId}`);
        break;
      case "put-evidence":
        keys.add(`evidence:${op.record.evidenceId}`);
        break;
      case "append-claim-revision":
        keys.add(`claim:${op.revision.claimId}`);
        break;
      case "ensure-claim":
        keys.add(`claim:${op.claimId}`);
        break;
      case "close-claim-revision":
      case "set-canon":
      case "purge-claim-content":
        keys.add(`claim:${op.claimId}`);
        break;
      case "append-relationship-revision":
        keys.add(`relationship:${op.revision.relationshipId}`);
        break;
      case "close-relationship-revision":
        keys.add(`relationship:${op.relationshipId}`);
        break;
      case "put-contradiction":
        keys.add(`contradiction:${op.record.contradictionId}`);
        break;
      case "put-decision":
        keys.add(`decision:${op.record.decisionId}`);
        break;
      case "put-peer-record":
      case "publish-record":
        keys.add(`activity_record:${op.recordId}`);
        break;
      case "put-candidate":
        keys.add(`candidate:${op.candidateId}`);
        break;
      case "put-active-context":
        keys.add(`active_context:${op.activeContextId}`);
        break;
      case "record-rejection":
        keys.add(`rejection:${op.contentHash}`);
        break;
    }
  }
  return keys.size;
}

export type Decision =
  | { kind: "plan"; plan: Plan }
  | {
      kind: "refused";
      error: TypedError;
      /**
       * Persistence a REFUSAL still requires.
       *
       * A refused sensitive candidate must leave a contentless record that it
       * was refused, or the admission policy is unauditable. This is the only
       * legitimate reason a refusal writes anything, and what it may write is
       * constrained by the op it emits.
       */
      ops?: PlanOp[];
    };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function refuse(
  code: ErrorCode,
  category: TypedError["category"],
  target: Ref | null,
  observed: Record<string, unknown> | null = null,
  remedy: TypedError["remedy"] = "none",
  retryable: TypedError["retryable"] = "no",
): Decision {
  return { kind: "refused", error: { code, category, retryable, target, observed, remedy } };
}

export function headRevision(state: KnowledgeState, claimId: Id): ClaimRevision | null {
  const revisions = state.claims.get(claimId);
  if (!revisions || revisions.length === 0) return null;
  return revisions[revisions.length - 1] ?? null;
}

export function relationshipHead(
  state: KnowledgeState,
  relationshipId: Id,
): RelationshipRevision | null {
  const revisions = state.relationships.get(relationshipId);
  if (!revisions || revisions.length === 0) return null;
  return revisions[revisions.length - 1] ?? null;
}

/** Follow merge redirects. The absorbed id stays resolvable forever. */
export function resolveEntity(state: KnowledgeState, entityId: Id): EntityRecord | null {
  let current = state.entities.get(entityId) ?? null;
  const seen = new Set<Id>();
  while (current && current.mergedInto !== null) {
    if (seen.has(current.entityId)) return null;
    seen.add(current.entityId);
    current = state.entities.get(current.mergedInto) ?? null;
  }
  return current;
}

function authorityFor(actor: Actor): Origin["authority"] {
  switch (actor.actorClass) {
    case "human":
      return "establishing";
    case "peer_publisher":
      return "observational";
    case "system":
      return "corroborating";
    default:
      return "proposing";
  }
}

/**
 * Origin kinds a given actor class is permitted to DECLARE for itself.
 *
 * `originKind` is the field the non-promotion and provenance controls read, so
 * an unchecked caller-supplied value let an agent label its own output
 * `human_direct` and satisfy every one of them while its `authority` stayed
 * `proposing`. Authority was always derived from the actor; this makes the
 * companion field just as underivable from the request.
 */
const DECLARABLE_ORIGIN_KINDS: Record<string, Origin["originKind"][]> = {
  human: ["human_direct", "human_decision"],
  agent: ["agent_extraction", "agent_inference"],
  system: ["system_derivation", "external_document"],
  importer: ["import"],
  peer_publisher: ["peer_report"],
};

export function originKindIsDeclarable(actor: Actor, declared: string): boolean {
  return (DECLARABLE_ORIGIN_KINDS[actor.actorClass] ?? []).includes(
    declared as Origin["originKind"],
  );
}

function originKindFor(actor: Actor, declared: string | undefined): Origin["originKind"] {
  if (declared) return declared as Origin["originKind"];
  switch (actor.actorClass) {
    case "human":
      return "human_direct";
    case "peer_publisher":
      return "peer_report";
    case "importer":
      return "import";
    case "system":
      return "system_derivation";
    default:
      return "agent_extraction";
  }
}

export function originFor(actor: Actor, at: Instant, declared?: string): Origin {
  return {
    originKind: originKindFor(actor, declared),
    authority: authorityFor(actor),
    actorId: actor.actorId,
    publisherNodeId: actor.actorClass === "peer_publisher" ? actor.nodeId : null,
    at,
  };
}

const EFFECT_CLASS_BY_COMMAND: Record<string, string> = {
  RegisterSourceRef: "additive",
  CreateEntity: "additive",
  CreateClaim: "additive",
  AssertRelationship: "additive",
  LinkEvidence: "additive",
  ReinforceClaim: "additive",
  RecordContradiction: "additive",
  SummarizeClaims: "additive",
  CreateWorkItem: "additive",
  PutActiveContext: "additive",
  IngestPeerActivity: "additive",
  OpenCandidateFromPeerReport: "additive",
  CorrectEntity: "corrective",
  CorrectClaim: "corrective",
  SupersedeClaim: "corrective",
  ReviseRelationship: "corrective",
  InvalidateRelationship: "corrective",
  ResolveConflict: "corrective",
  UpdateWorkItem: "corrective",
  MergeEntities: "destructive",
  RetractClaim: "destructive",
  CanonizeClaim: "authority",
  DecanonizeClaim: "authority",
  PublishActivityRecord: "publish",
};

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

export type PolicyContext = {
  state: KnowledgeState;
  instant: Instant;
  /** Version token for a ref, computed by the LANE from canonical state alone. */
  versionOf: (ref: Ref) => string | null;
  /** The publishing node's own identity, for namespace ownership. */
  nodeId: Id;
  /** Source documents, so evidence can be required to terminate in real text. */
  documentText: (sourceRefId: Id, locator: string) => string | null;
  contentHash: (value: unknown) => string;
};

function guardTarget(request: CommandRequest): Ref | null {
  const guard = request.guard;
  if (guard.mode !== "expected_version") return null;
  return guard.targets[0]?.ref ?? null;
}

/** Evaluate the declared stale guard against canonical state. */
function checkGuard(request: CommandRequest, context: PolicyContext): Decision | null {
  const guard = request.guard;
  if (guard.mode === "unguarded") {
    if (!guard.reason) {
      return refuse("INTENT_MISMATCH", "authorization", null, null, "reduce_scope");
    }
    return null;
  }
  if (guard.mode === "expected_absent") return null;

  for (const target of guard.targets) {
    const actual = context.versionOf(target.ref);
    if (actual === null) {
      return refuse("SUBJECT_NOT_FOUND", "precondition", target.ref, null, "refresh_and_retry");
    }
    if (actual !== target.expected) {
      return refuse(
        "STALE_VERSION",
        "conflict",
        target.ref,
        { currentVersionToken: actual },
        "refresh_and_retry",
        "after_refresh",
      );
    }
  }
  return null;
}

/** The declared blast radius must contain every ref the plan touches. */
function checkScope(request: CommandRequest, plan: Plan): Decision | null {
  const declared = new Set(request.intent.scope.map((ref) => `${ref.kind}:${ref.id}`));
  if (declared.size === 0) return null;
  for (const effect of plan.effects) {
    const key = `${effect.ref.kind}:${effect.ref.id}`;
    if (!declared.has(key)) {
      return refuse(
        "SCOPE_EXCEEDED",
        "authorization",
        effect.ref,
        { computed: plan.effects.map((entry) => entry.ref) },
        "reduce_scope",
      );
    }
  }
  return null;
}

function checkAuthority(request: CommandRequest): Decision | null {
  const declared = request.intent.effectClass;
  const expected = EFFECT_CLASS_BY_COMMAND[request.command];
  if (expected && declared !== expected) {
    return refuse("INTENT_MISMATCH", "authorization", null, { expected, declared });
  }

  const actor = request.actor;

  // Canonization is human-only and is never delegable. An agent acting on behalf
  // of a human is still an agent here: the point of the gate is that a model
  // cannot promote its own output to protected status.
  if (declared === "authority" && actor.actorClass !== "human") {
    return refuse("CANONIZE_REQUIRES_HUMAN", "authorization", null, null, "obtain_decision");
  }

  // A peer publisher may only publish. It may never author local knowledge.
  if (actor.actorClass === "peer_publisher" && declared !== "publish") {
    return refuse("PEER_PROMOTION_FORBIDDEN", "authorization", null, null, "obtain_decision");
  }

  // Corrective and destructive work by a non-human requires a recorded human
  // decision, so an agent cannot quietly rewrite belief.
  if (
    (declared === "corrective" || declared === "destructive") &&
    actor.actorClass !== "human" &&
    request.intent.decisionRef === null
  ) {
    // Supersession is world progression rather than a judgement about a prior
    // belief, so an agent may perform it on its own evidence.
    if (request.command !== "SupersedeClaim" && request.command !== "InvalidateRelationship") {
      return refuse("DECISION_REF_REQUIRED", "authorization", null, null, "obtain_decision");
    }
  }

  return null;
}

function checkInterval(valid: Interval): Decision | null {
  if (valid.from !== null && valid.to !== null && Date.parse(valid.to) <= Date.parse(valid.from)) {
    return refuse("TEMPORAL_INVALID", "validation", null, { valid });
  }
  return null;
}

/**
 * Evidence must terminate in a source document that actually says something.
 *
 * Enforced at write time rather than audited later: a claim admitted without a
 * usable source is a claim the system can never justify, and auditing for it
 * afterwards means the unjustifiable claim was believed in the meantime.
 */
function checkEvidence(
  links: Array<{ sourceRefId?: string; locator?: string; peerRecordId?: string }>,
  context: PolicyContext,
): Decision | null {
  if (links.length === 0) {
    return refuse("EVIDENCE_REQUIRED", "validation", null, null, "refresh_and_retry");
  }
  for (const link of links) {
    if (link.peerRecordId) continue;
    if (!link.sourceRefId || !context.state.sources.has(link.sourceRefId)) {
      return refuse("EVIDENCE_CHAIN_BROKEN", "integrity", null, { link }, "repair_required");
    }
    const text = context.documentText(link.sourceRefId, link.locator ?? "");
    if (text === null || text.trim() === "") {
      return refuse("EVIDENCE_CHAIN_BROKEN", "integrity", null, { link }, "repair_required");
    }
  }
  return null;
}

const RESTRICTED: Sensitivity = "restricted";

/** A caller may not label its own output with an origin its class cannot hold. */
function checkOrigin(request: CommandRequest): Decision | null {
  const declared = (request.args as { origin?: unknown }).origin;
  if (declared === undefined || declared === null) return null;
  if (typeof declared !== "string" || !originKindIsDeclarable(request.actor, declared)) {
    return refuse("INTENT_MISMATCH", "authorization", null, {
      declaredOrigin: declared,
      actorClass: request.actor.actorClass,
    });
  }
  return null;
}

/**
 * A recorded decision is evidence, and evidence that can be rewritten in place is
 * not evidence.
 *
 * Both stores wrote decisions by id with an unconditional overwrite, so a later
 * command citing an existing `decisionId` silently retargeted a human's recorded
 * decision — replacing its outcome, targets, rationale, and observed-state hash,
 * and clearing exactly the staleness the stale-decision question exists to
 * surface. The coordination feed already refuses a rewritten peer history; this
 * gives the decision store the same rule.
 */
function checkDecisionsImmutable(plan: Plan, context: PolicyContext): Decision | null {
  for (const op of plan.ops) {
    if (op.op !== "put-decision") continue;
    const existing = context.state.decisions.get(op.record.decisionId);
    if (!existing) continue;
    if (context.contentHash(stableValue(existing)) !== context.contentHash(stableValue(op.record))) {
      return refuse(
        "DUPLICATE_NATURAL_KEY",
        "conflict",
        { kind: "decision", id: op.record.decisionId },
        { existingDecidedBy: existing.decidedBy, existingOutcome: existing.outcome },
        "obtain_decision",
      );
    }
  }
  return null;
}

export function decide(request: CommandRequest, context: PolicyContext): Decision {
  const authority = checkAuthority(request);
  if (authority) return authority;

  const origin = checkOrigin(request);
  if (origin) return origin;

  const guard = checkGuard(request, context);
  if (guard) return guard;

  const decision = plan(request, context);
  if (decision.kind === "refused") return decision;

  const immutable = checkDecisionsImmutable(decision.plan, context);
  if (immutable) return immutable;

  const scope = checkScope(request, decision.plan);
  if (scope) return scope;

  return decision;
}

function claimRef(claimId: Id): Ref {
  return { kind: "claim", id: claimId };
}

/**
 * Hash of the state a decider was looking at, with per-lane values removed.
 *
 * A version token is opaque and lane-specific by construction, so including it
 * would make the same human decision hash differently in each lane — and a
 * portable export would compare unequal for a reason that has nothing to do with
 * what the human actually saw.
 */
function observedHash(context: PolicyContext, value: unknown): string {
  // Canonicalised before hashing. Two lanes materialise the same record with
  // different key insertion orders, and an order-sensitive hash would make the
  // same human decision unequal across lanes for a reason that has nothing to do
  // with what the human saw.
  return context.contentHash(
    stableValue(
      JSON.parse(JSON.stringify(value, (key, entry) => (key === "versionToken" ? undefined : entry))),
    ),
  );
}

function plan(request: CommandRequest, context: PolicyContext): Decision {
  const args = request.args as Record<string, never>;
  const at = context.instant;
  const origin = originFor(request.actor, at, (args as { origin?: string }).origin);
  const state = context.state;

  switch (request.command) {
    case "RegisterSourceRef": {
      const sourceRefId = String(args.sourceRefId);
      const existing = state.sources.get(sourceRefId);
      if (existing) {
        return refuse("DUPLICATE_NATURAL_KEY", "conflict", { kind: "source", id: sourceRefId });
      }
      const record = (args as unknown as { record: SourceRefRecord }).record;
      return {
        kind: "plan",
        plan: {
          ops: [{ op: "put-source", record }],
          effects: [
            {
              ref: { kind: "source", id: sourceRefId },
              change: "created",
              priorVersionToken: null,
              newVersionToken: null,
              revision: null,
            },
          ],
          crossesBoundary: false,
          derivedObligations: [],
        },
      };
    }

    case "CreateEntity": {
      const record = (args as unknown as { record: EntityRecord }).record;
      if (state.entities.has(record.entityId)) {
        return refuse("DUPLICATE_NATURAL_KEY", "conflict", { kind: "entity", id: record.entityId });
      }
      return {
        kind: "plan",
        plan: {
          // `mustBeNew` moves the duplicate check from this in-memory snapshot,
          // which two concurrent writers both pass, down to the store where an
          // insert can actually be rejected.
          ops: [{ op: "put-entity", record, mustBeNew: true }],
          effects: [
            {
              ref: { kind: "entity", id: record.entityId },
              change: "created",
              priorVersionToken: null,
              newVersionToken: null,
              revision: null,
            },
          ],
          crossesBoundary: false,
          derivedObligations: [],
        },
      };
    }

    case "CreateClaim": {
      const claimId = String(args.claimId);
      const subject = String(args.subject);
      const sensitivity = (args.sensitivity as Sensitivity | undefined) ?? "public";
      const links = (args.evidence as Array<Record<string, string>>) ?? [];

      // Restricted material is refused BEFORE persistence. Only a contentless
      // rejection record survives: no subject link, no text, no evidence row.
      if (sensitivity === RESTRICTED) {
        const sourceRefId = String(links[0]?.sourceRefId ?? "");
        return {
          kind: "refused",
          error: {
            code: "SENSITIVE_ADMISSION_REFUSED",
            category: "authorization",
            retryable: "no",
            target: claimRef(claimId),
            observed: null,
            remedy: "none",
          },
          ops: [
            {
              op: "record-rejection",
              reason: "sensitive_policy",
              sourceRefId,
              contentHash: context.contentHash({ claimId, subject, value: args.value }),
              // A contentless audit record with no time is barely an audit
              // record. Both stores previously dropped this on the floor and read
              // it back as the empty string.
              decidedAt: at,
            },
          ],
        };
      }

      if (!resolveEntity(state, subject)) {
        return refuse("SUBJECT_NOT_FOUND", "precondition", { kind: "entity", id: subject });
      }
      const valid: Interval = {
        from: (args.validFrom as string | null) ?? null,
        to: (args.validTo as string | null) ?? null,
      };
      const interval = checkInterval(valid);
      if (interval) return interval;

      // A peer report can never author a claim, whatever it cites.
      if (links.some((link) => link.peerRecordId)) {
        return refuse("PEER_PROMOTION_FORBIDDEN", "authorization", claimRef(claimId));
      }
      const evidence = checkEvidence(links, context);
      if (evidence) return evidence;

      if (headRevision(state, claimId)) {
        return refuse("DUPLICATE_NATURAL_KEY", "conflict", claimRef(claimId));
      }

      const evidenceRecords = links.map((link, index) =>
        evidenceRecordFor(claimId, 1, index, link, origin, context),
      );
      const revision: ClaimRevision = {
        claimId,
        revision: 1,
        subject,
        predicate: String(args.predicate),
        value: String(args.value),
        scope: String(args.scope ?? "global"),
        valid,
        assertedAt: at,
        assertedUntil: null,
        closureReason: null,
        belief: request.actor.actorClass === "human" ? "active" : "active",
        canon: false,
        origin,
        evidenceIds: evidenceRecords.map((record) => record.evidenceId),
        derivedFrom: [],
        supersedes: null,
        supersededBy: null,
        sensitivity,
        visibility: sensitivity === "public" ? "publishable_full" : "local_only",
        redactionState: "none",
        versionToken: "",
      };

      return {
        kind: "plan",
        plan: {
          ops: [
            ...evidenceRecords.map((record) => ({ op: "put-evidence" as const, record })),
            { op: "append-claim-revision", revision },
          ],
          effects: [
            {
              ref: claimRef(claimId),
              change: "created",
              priorVersionToken: null,
              newVersionToken: null,
              revision: 1,
            },
          ],
          crossesBoundary: false,
          derivedObligations: ["projection.claim", "projection.chunk"],
        },
      };
    }

    case "SupersedeClaim":
    case "CorrectClaim": {
      const claimId = String(args.claimId);
      const head = headRevision(state, claimId);
      if (!head) return refuse("SUBJECT_NOT_FOUND", "precondition", claimRef(claimId));
      if (head.belief === "retracted") {
        return refuse("CLAIM_RETRACTED", "precondition", claimRef(claimId));
      }
      const links = (args.evidence as Array<Record<string, string>>) ?? [];
      const evidence = checkEvidence(links, context);
      if (evidence) return evidence;

      const correcting = request.command === "CorrectClaim";
      // Correction replaces belief for the SAME world interval. Progression
      // closes the old interval and opens a new one. Collapsing these two is
      // what makes "we were wrong" indistinguishable from "the world changed".
      const worldChangeAt = correcting ? null : String(args.worldChangeAt);
      const nextValid: Interval = correcting
        ? { from: head.valid.from, to: head.valid.to }
        : { from: worldChangeAt, to: null };
      const interval = checkInterval(nextValid);
      if (interval) return interval;

      const evidenceRecords = links.map((link, index) =>
        evidenceRecordFor(claimId, head.revision + 1, index, link, origin, context),
      );
      const next: ClaimRevision = {
        ...head,
        revision: head.revision + 1,
        value: String(args.value),
        valid: nextValid,
        assertedAt: at,
        assertedUntil: null,
        closureReason: null,
        belief: "active",
        // Canonization does NOT survive a content change. Spreading `...head`
        // carried `canon: true` onto a value the human who canonized never saw,
        // and the publication gate keys on exactly that flag — so an agent's text
        // could cross the peer boundary wearing a human's authority. Re-approval
        // is a human act; it is not inherited.
        canon: false,
        origin,
        evidenceIds: evidenceRecords.map((record) => record.evidenceId),
        supersedes: { claimId, revision: head.revision },
        supersededBy: null,
        versionToken: "",
      };

      // A human decision that authorised this change has to survive as a record,
      // or `StaleDecisions` has nothing to report and the human-correction path
      // is unauditable. The decision names the revision it produced.
      const decisionOps: PlanOp[] = decisionRecordFor(
        request,
        { kind: "claim", id: claimId, revision: next.revision },
        correcting ? "correct" : "supersede",
        String(args.reason ?? ""),
        head,
        context,
      );

      const ops: PlanOp[] = [
        ...decisionOps,
        ...evidenceRecords.map((record) => ({ op: "put-evidence" as const, record })),
        {
          op: "close-claim-revision",
          claimId,
          revision: head.revision,
          until: at,
          reason: correcting ? "corrected" : "world_progressed",
          // The whole distinction in one field: progression narrows the prior
          // world interval so the old value stays true of its own stretch of
          // time; correction leaves it untouched so the new value answers for
          // the same stretch and the old belief survives only in history.
          narrowValidTo: correcting ? null : worldChangeAt,
        },
        { op: "append-claim-revision", revision: next },
      ];

      return {
        kind: "plan",
        plan: {
          ops,
          effects: [
            {
              ref: claimRef(claimId),
              change: correcting ? "updated" : "superseded",
              priorVersionToken: head.versionToken,
              newVersionToken: null,
              revision: next.revision,
            },
          ],
          // Two objects change together. Lane N gets one transaction; Lane M
          // gets an intent record and a roll-forward repair. The difference is
          // measured, not levelled.
          crossesBoundary: false,
          derivedObligations: ["projection.claim", "projection.chunk"],
        },
      };
    }

    case "SummarizeClaims": {
      const claimId = String(args.claimId);
      const summarized = (args.summarizes as string[]) ?? [];
      if (summarized.length === 0) {
        return refuse("CONTRADICTION_REQUIRES_TWO_DISTINCT", "validation", claimRef(claimId));
      }
      for (const target of summarized) {
        if (!headRevision(state, target)) {
          return refuse("SUBJECT_NOT_FOUND", "precondition", claimRef(target));
        }
      }
      const links = (args.evidence as Array<Record<string, string>>) ?? [];
      const evidence = checkEvidence(links, context);
      if (evidence) return evidence;

      const evidenceRecords = links.map((link, index) =>
        evidenceRecordFor(claimId, 1, index, link, origin, context),
      );
      const valid: Interval = {
        from: (args.validFrom as string | null) ?? null,
        to: (args.validTo as string | null) ?? null,
      };
      const revision: ClaimRevision = {
        claimId,
        revision: 1,
        subject: String(args.subject),
        predicate: String(args.predicate),
        value: String(args.value),
        scope: "global",
        valid,
        assertedAt: at,
        assertedUntil: null,
        closureReason: null,
        belief: "active",
        canon: false,
        origin,
        evidenceIds: evidenceRecords.map((record) => record.evidenceId),
        derivedFrom: summarized,
        supersedes: null,
        supersededBy: null,
        sensitivity: "public",
        visibility: "publishable_full",
        redactionState: "none",
        versionToken: "",
      };

      // The originals stay TRUE. Summarised is not superseded and is not
      // invalidated: their world intervals are untouched and their evidence
      // stays reachable.
      const ops: PlanOp[] = [
        ...evidenceRecords.map((record) => ({ op: "put-evidence" as const, record })),
        { op: "append-claim-revision", revision },
      ];
      const effects: EntityEffect[] = [
        {
          ref: claimRef(claimId),
          change: "created",
          priorVersionToken: null,
          newVersionToken: null,
          revision: 1,
        },
      ];
      for (const target of summarized) {
        const head = headRevision(state, target);
        if (!head) continue;
        ops.push({
          op: "append-claim-revision",
          revision: { ...head, revision: head.revision + 1, belief: "summarized", assertedAt: at },
        });
        effects.push({
          ref: claimRef(target),
          change: "summarized",
          priorVersionToken: head.versionToken,
          newVersionToken: null,
          revision: head.revision + 1,
        });
      }

      return {
        kind: "plan",
        plan: { ops, effects, crossesBoundary: false, derivedObligations: ["projection.claim"] },
      };
    }

    case "ReinforceClaim": {
      const claimId = String(args.claimId);
      const head = headRevision(state, claimId);
      if (!head) return refuse("SUBJECT_NOT_FOUND", "precondition", claimRef(claimId));
      const links = (args.evidence as Array<Record<string, string>>) ?? [];
      const evidence = checkEvidence(links, context);
      if (evidence) return evidence;

      const evidenceRecords = links.map((link, index) =>
        evidenceRecordFor(claimId, head.revision + 1, index, link, origin, context),
      );
      // Reinforcement adds evidence. It does NOT touch authority, canon, or
      // belief: laundering authority through repetition is the failure mode this
      // command exists to make impossible.
      return {
        kind: "plan",
        plan: {
          ops: [
            ...evidenceRecords.map((record) => ({ op: "put-evidence" as const, record })),
            {
              op: "append-claim-revision",
              revision: {
                ...head,
                revision: head.revision + 1,
                evidenceIds: [...head.evidenceIds, ...evidenceRecords.map((r) => r.evidenceId)],
                assertedAt: at,
                // Reinforcement adds evidence and nothing else. The VALUE is
                // unchanged, so canon legitimately carries over — this is the one
                // successor where it does, and it is stated rather than inherited
                // by accident from the spread above.
                canon: head.canon,
              },
            },
          ],
          effects: [
            {
              ref: claimRef(claimId),
              change: "linked",
              priorVersionToken: head.versionToken,
              newVersionToken: null,
              revision: head.revision + 1,
            },
          ],
          crossesBoundary: false,
          derivedObligations: ["projection.evidence"],
        },
      };
    }

    case "AssertRelationship": {
      const relationshipId = String(args.relationshipId);
      const from = String(args.from);
      const to = String(args.to);
      if (!resolveEntity(state, from) || !resolveEntity(state, to)) {
        return refuse("SUBJECT_NOT_FOUND", "precondition", { kind: "entity", id: from });
      }
      const valid: Interval = {
        from: (args.validFrom as string | null) ?? null,
        to: (args.validTo as string | null) ?? null,
      };
      const interval = checkInterval(valid);
      if (interval) return interval;
      const links = (args.evidence as Array<Record<string, string>>) ?? [];
      const evidence = checkEvidence(links, context);
      if (evidence) return evidence;

      const evidenceRecords = links.map((link, index) =>
        evidenceRecordFor(relationshipId, 1, index, link, origin, context),
      );
      const revision: RelationshipRevision = {
        relationshipId,
        revision: 1,
        from,
        relType: String(args.relType),
        to,
        directed: true,
        valid,
        assertedAt: at,
        assertedUntil: null,
        closureReason: null,
        belief: "active",
        origin,
        evidenceIds: evidenceRecords.map((record) => record.evidenceId),
        sensitivity: "public",
        versionToken: "",
      };
      return {
        kind: "plan",
        plan: {
          ops: [
            ...evidenceRecords.map((record) => ({ op: "put-evidence" as const, record })),
            { op: "append-relationship-revision", revision },
          ],
          effects: [
            {
              ref: { kind: "relationship", id: relationshipId },
              change: "created",
              priorVersionToken: null,
              newVersionToken: null,
              revision: 1,
            },
          ],
          crossesBoundary: false,
          derivedObligations: ["projection.edge"],
        },
      };
    }

    case "InvalidateRelationship": {
      const relationshipId = String(args.relationshipId);
      const head = relationshipHead(state, relationshipId);
      if (!head) {
        return refuse("SUBJECT_NOT_FOUND", "precondition", {
          kind: "relationship",
          id: relationshipId,
        });
      }
      const invalidFrom = String(args.invalidFrom);
      return {
        kind: "plan",
        plan: {
          ops: [
            {
              op: "close-relationship-revision",
              relationshipId,
              revision: head.revision,
              until: at,
              reason: "world_progressed",
              validTo: invalidFrom,
            },
          ],
          effects: [
            {
              ref: { kind: "relationship", id: relationshipId },
              change: "invalidated",
              priorVersionToken: head.versionToken,
              newVersionToken: null,
              revision: head.revision,
            },
          ],
          crossesBoundary: false,
          derivedObligations: ["projection.edge"],
        },
      };
    }

    case "MergeEntities": {
      const survivorId = String(args.survivorId);
      const mergedId = String(args.mergedId);
      if (survivorId === mergedId) {
        return refuse("MERGE_CYCLE", "validation", { kind: "entity", id: mergedId });
      }
      const survivor = state.entities.get(survivorId);
      const merged = state.entities.get(mergedId);
      if (!survivor || !merged) {
        return refuse("SUBJECT_NOT_FOUND", "precondition", { kind: "entity", id: mergedId });
      }
      if (survivor.mergedInto !== null) {
        return refuse("MERGE_SURVIVOR_IS_TOMBSTONE", "precondition", {
          kind: "entity",
          id: survivorId,
        });
      }
      // Redirection, never rewriting. Inbound relationships are untouched and
      // resolve through the redirect at read time, which is the only merge
      // semantics a file tree and a graph can both implement identically.
      return {
        kind: "plan",
        plan: {
          ops: [
            ...decisionRecordFor(
              request,
              { kind: "entity", id: mergedId, revision: null },
              "merge",
              String(args.reason ?? ""),
              merged,
              context,
            ),
            {
              op: "put-entity",
              record: {
                ...merged,
                mergedInto: survivorId,
              },
            },
            {
              op: "put-entity",
              record: {
                ...survivor,
                aliases: [...new Set([...survivor.aliases, merged.canonicalName, ...merged.aliases])],
              },
            },
          ],
          effects: [
            {
              ref: { kind: "entity", id: mergedId },
              change: "merged_into",
              priorVersionToken: merged.versionToken,
              newVersionToken: null,
              revision: null,
            },
          ],
          crossesBoundary: false,
          derivedObligations: ["projection.claim", "projection.edge"],
        },
      };
    }

    case "ResolveConflict": {
      // Resolution is a HUMAN act recorded against a specific revision. It
      // upholds one member; it does not delete the other, because a
      // contradiction that vanished on resolution could never be revisited when
      // the decision itself turns out to be wrong.
      const contradictionId = String(args.contradictionId);
      const existing = state.contradictions.get(contradictionId);
      if (!existing) {
        return refuse("SUBJECT_NOT_FOUND", "precondition", {
          kind: "contradiction",
          id: contradictionId,
        });
      }
      if (existing.resolution !== null) {
        return refuse("CONFLICT_ALREADY_RESOLVED", "precondition", {
          kind: "contradiction",
          id: contradictionId,
        });
      }
      const decisionId = String(request.intent.decisionRef ?? args.decisionId ?? "");
      if (decisionId === "") {
        return refuse(
          "DECISION_REF_REQUIRED",
          "authorization",
          { kind: "contradiction", id: contradictionId },
          null,
          "obtain_decision",
        );
      }
      const upheld = String(args.upheldClaimId ?? "");
      if (upheld !== "" && !headRevision(state, upheld)) {
        return refuse("SUBJECT_NOT_FOUND", "precondition", claimRef(upheld));
      }
      const record: ContradictionRecord = {
        ...existing,
        resolution: { decisionId, at },
      };
      const decision: ReviewDecisionRecord = decisionRecord(
        request,
        decisionId,
        "affirm",
        upheld === ""
          ? [{ kind: "contradiction", id: contradictionId, revision: null }]
          : [{ kind: "claim", id: upheld, revision: headRevision(state, upheld)?.revision ?? null }],
        String(args.rationale ?? ""),
        existing,
        context,
      );
      return {
        kind: "plan",
        plan: {
          ops: [
            { op: "put-decision", record: decision },
            { op: "put-contradiction", record },
          ],
          effects: [
            {
              ref: { kind: "contradiction", id: contradictionId },
              change: "updated",
              priorVersionToken: null,
              newVersionToken: null,
              revision: null,
            },
          ],
          crossesBoundary: false,
          derivedObligations: [],
        },
      };
    }

    case "ReviseRelationship": {
      // A typed edge whose world interval was wrong. The prior revision closes
      // as `corrected` and keeps its own interval, so the belief history stays
      // legible; the new revision carries the corrected interval.
      const relationshipId = String(args.relationshipId);
      const head = relationshipHead(state, relationshipId);
      if (!head) {
        return refuse("SUBJECT_NOT_FOUND", "precondition", {
          kind: "relationship",
          id: relationshipId,
        });
      }
      const links = (args.evidence as Array<Record<string, string>>) ?? [];
      const evidence = checkEvidence(links, context);
      if (evidence) return evidence;

      const valid: Interval = {
        from: (args.validFrom as string | null) ?? head.valid.from,
        to: (args.validTo as string | null) ?? null,
      };
      const interval = checkInterval(valid);
      if (interval) return interval;

      const evidenceRecords = links.map((link, index) =>
        evidenceRecordFor(relationshipId, head.revision + 1, index, link, origin, context),
      );
      const next: RelationshipRevision = {
        ...head,
        revision: head.revision + 1,
        valid,
        assertedAt: at,
        assertedUntil: null,
        closureReason: null,
        belief: "active",
        origin,
        evidenceIds: evidenceRecords.map((record) => record.evidenceId),
        versionToken: "",
      };
      return {
        kind: "plan",
        plan: {
          ops: [
            // A human-authorised temporal revision leaves the same durable
            // decision a claim correction does. Relationships are not a lesser
            // class of belief, and a corrected edge with no recorded reason is
            // exactly as unauditable as a corrected claim would be.
            ...decisionRecordFor(
              request,
              { kind: "relationship", id: relationshipId, revision: next.revision },
              "correct",
              String(args.reason ?? request.intent.justification ?? ""),
              head,
              context,
            ),
            ...evidenceRecords.map((record) => ({ op: "put-evidence" as const, record })),
            {
              op: "close-relationship-revision",
              relationshipId,
              revision: head.revision,
              until: at,
              reason: "corrected",
              validTo: head.valid.to,
            },
            { op: "append-relationship-revision", revision: next },
          ],
          effects: [
            {
              ref: { kind: "relationship", id: relationshipId },
              change: "updated",
              priorVersionToken: head.versionToken,
              newVersionToken: null,
              revision: next.revision,
            },
          ],
          crossesBoundary: false,
          derivedObligations: ["projection.edge"],
        },
      };
    }

    case "RecordContradiction": {
      const contradictionId = String(args.contradictionId);
      const members = ((args.members as string[]) ?? []).map((claimId) => {
        const head = headRevision(state, claimId);
        return { claimId, revision: head?.revision ?? 0 };
      });
      const peerRecordId = args.peerRecordId as string | undefined;
      // Two distinct positions are required. A peer report counts as a position
      // WITHOUT becoming a claim: that is exactly the shape of the case.
      if (members.length + (peerRecordId ? 1 : 0) < 2) {
        return refuse("CONTRADICTION_REQUIRES_TWO_DISTINCT", "validation", null);
      }
      const record: ContradictionRecord = {
        contradictionId,
        members,
        // Kept as a peer position, not converted into a member. The report is
        // half of this contradiction and still never becomes a claim.
        peerMembers: peerRecordId ? [peerRecordId] : [],
        detectedAt: at,
        detectedBy: origin,
        basis: (args.basis as ContradictionRecord["basis"]) ?? "logical",
        resolution: null,
      };
      return {
        kind: "plan",
        plan: {
          ops: [{ op: "put-contradiction", record }],
          effects: [
            {
              ref: { kind: "contradiction", id: contradictionId },
              change: "created",
              priorVersionToken: null,
              newVersionToken: null,
              revision: null,
            },
          ],
          crossesBoundary: false,
          derivedObligations: [],
        },
      };
    }

    case "CanonizeClaim": {
      const claimId = String(args.claimId);
      const head = headRevision(state, claimId);
      if (!head) return refuse("SUBJECT_NOT_FOUND", "precondition", claimRef(claimId));
      // The authorising decision is read from ONE place. It previously came from
      // `args` here and from `intent.decisionRef` everywhere else, so a caller
      // that supplied it correctly in the envelope was refused for not having
      // supplied it — an inconsistency that would have been scored as a missing
      // human-correction path rather than as the contract defect it was.
      const decisionId = String(request.intent.decisionRef ?? args.decisionId ?? "");
      if (decisionId === "") {
        return refuse("DECISION_REF_REQUIRED", "authorization", claimRef(claimId));
      }
      const record: ReviewDecisionRecord = decisionRecord(
        request,
        decisionId,
        "canonize",
        [{ kind: "claim", id: claimId, revision: head.revision }],
        String(args.rationale ?? ""),
        head,
        context,
      );
      return {
        kind: "plan",
        plan: {
          ops: [
            { op: "put-decision", record },
            { op: "set-canon", claimId, revision: head.revision, canon: true },
          ],
          effects: [
            {
              ref: claimRef(claimId),
              change: "canonized",
              priorVersionToken: head.versionToken,
              newVersionToken: null,
              revision: head.revision,
            },
          ],
          crossesBoundary: false,
          derivedObligations: [],
        },
      };
    }

    case "DecanonizeClaim": {
      // Declared in the contract and classified `authority`, but with no case in
      // this switch it fell through to `CAPABILITY_NOT_NEGOTIATED` — so canon
      // was a one-way flag with no inverse, and a human who canonized the wrong
      // revision had no way back. `checkAuthority` already restricts the
      // `authority` class to humans.
      const claimId = String(args.claimId);
      const head = headRevision(state, claimId);
      if (!head) return refuse("SUBJECT_NOT_FOUND", "precondition", claimRef(claimId));
      const decisionId = String(request.intent.decisionRef ?? args.decisionId ?? "");
      if (decisionId === "") {
        return refuse("DECISION_REF_REQUIRED", "authorization", claimRef(claimId));
      }
      if (!head.canon) {
        return refuse("INTENT_MISMATCH", "precondition", claimRef(claimId), {
          canon: false,
        });
      }
      const record: ReviewDecisionRecord = decisionRecord(
        request,
        decisionId,
        "decanonize",
        [{ kind: "claim", id: claimId, revision: head.revision }],
        String(args.rationale ?? ""),
        head,
        context,
      );
      return {
        kind: "plan",
        plan: {
          ops: [
            { op: "put-decision", record },
            { op: "set-canon", claimId, revision: head.revision, canon: false },
          ],
          effects: [
            {
              ref: claimRef(claimId),
              change: "decanonized",
              priorVersionToken: head.versionToken,
              newVersionToken: null,
              revision: head.revision,
            },
          ],
          crossesBoundary: false,
          derivedObligations: [],
        },
      };
    }

    case "RetractClaim": {
      const claimId = String(args.claimId);
      const head = headRevision(state, claimId);
      if (!head) return refuse("SUBJECT_NOT_FOUND", "precondition", claimRef(claimId));
      const decisionId = String(request.intent.decisionRef ?? args.decisionId ?? "");
      if (decisionId === "") {
        return refuse("DECISION_REF_REQUIRED", "authorization", claimRef(claimId));
      }
      const sensitive = String(args.retractionClass) === "sensitive";
      const record: ReviewDecisionRecord = decisionRecord(
        request,
        decisionId,
        "retract",
        // The revision the decision PRODUCED, not the one it was read against.
        // Targeting the prior revision would make every applied decision stale
        // the instant it committed, which would make staleness meaningless.
        [{ kind: "claim", id: claimId, revision: head.revision + 1 }],
        String(args.reason ?? ""),
        head,
        context,
      );
      const ops: PlanOp[] = [
        { op: "put-decision", record },
        {
          op: "append-claim-revision",
          revision: {
            ...head,
            revision: head.revision + 1,
            belief: "retracted",
            assertedAt: at,
            closureReason: "retracted",
            redactionState: sensitive ? "purged" : "none",
            value: sensitive ? "" : head.value,
            // A retracted claim is not canon. Leaving the flag set would let a
            // withdrawn statement keep passing the publication gate.
            canon: false,
          },
        },
      ];
      // A sensitive retraction purges the statement from every prior revision as
      // well. The tombstone, the ids, and the lineage survive; the text does not.
      if (sensitive) ops.push({ op: "purge-claim-content", claimId });

      return {
        kind: "plan",
        plan: {
          ops,
          effects: [
            {
              ref: claimRef(claimId),
              change: "retracted",
              priorVersionToken: head.versionToken,
              newVersionToken: null,
              revision: head.revision + 1,
            },
          ],
          // Erasure crosses into derived structures and exports, which no lane
          // can make atomic with the canonical write.
          crossesBoundary: true,
          derivedObligations: ["projection.claim", "projection.chunk", "export"],
        },
      };
    }

    case "IngestPeerActivity": {
      const recordId = String(args.recordId);
      const record = (args as unknown as { record: Record<string, unknown> }).record;

      // Ingesting the same id twice is fine when the content is the same, and is
      // a rewritten history when it is not. Overwriting would let a peer
      // silently change what it is on record as having said, which is the one
      // thing an attributed feed has to make impossible.
      const existing = state.peerRecords.get(recordId);
      if (existing) {
        const before = context.contentHash(stableValue(existing));
        const after = context.contentHash(stableValue(record));
        if (before !== after) {
          return refuse(
            "PEER_HISTORY_REWRITTEN",
            "integrity",
            { kind: "activity_record", id: recordId },
            { observedContentHash: before },
            "none",
          );
        }
      }

      return {
        kind: "plan",
        plan: {
          ops: [{ op: "put-peer-record", recordId, record }],
          effects: [
            {
              ref: { kind: "activity_record", id: recordId },
              change: "quarantined",
              priorVersionToken: null,
              newVersionToken: null,
              revision: null,
            },
          ],
          crossesBoundary: false,
          derivedObligations: [],
        },
      };
    }

    case "OpenCandidateFromPeerReport": {
      const candidateId = String(args.candidateId);
      const recordId = String(args.recordId);
      if (!state.peerRecords.has(recordId)) {
        return refuse("SUBJECT_NOT_FOUND", "precondition", {
          kind: "activity_record",
          id: recordId,
        });
      }
      // The only bridge from a peer report to local knowledge, and it stops at
      // `unreviewed`. There is deliberately no command that completes the
      // journey without a human decision.
      return {
        kind: "plan",
        plan: {
          ops: [{ op: "put-candidate", candidateId, recordId }],
          effects: [
            {
              ref: { kind: "claim", id: candidateId },
              change: "candidate_opened",
              priorVersionToken: null,
              newVersionToken: null,
              revision: null,
            },
          ],
          crossesBoundary: false,
          derivedObligations: [],
        },
      };
    }

    case "PublishActivityRecord": {
      const recordId = String(args.recordId);
      const publisher = recordId.split("/")[0] ?? "";
      if (publisher !== context.nodeId) {
        return refuse("NAMESPACE_VIOLATION", "authorization", {
          kind: "activity_record",
          id: recordId,
        });
      }
      const record = (args as unknown as { record: Record<string, unknown> }).record;
      return {
        kind: "plan",
        plan: {
          ops: [{ op: "publish-record", recordId, record }],
          effects: [
            {
              ref: { kind: "activity_record", id: recordId },
              change: "published",
              priorVersionToken: null,
              newVersionToken: null,
              revision: null,
            },
          ],
          // Publication is deliberately not atomic with any knowledge commit, so
          // "published after committing" is an observable, recoverable outcome.
          crossesBoundary: true,
          derivedObligations: ["coordination.publish"],
        },
      };
    }

    case "PutActiveContext": {
      const activeContextId = String(args.activeContextId);
      const record = (args as unknown as { record: Record<string, unknown> }).record;
      return {
        kind: "plan",
        plan: {
          ops: [{ op: "put-active-context", activeContextId, record }],
          effects: [
            {
              ref: { kind: "active_context", id: activeContextId },
              change: "created",
              priorVersionToken: null,
              newVersionToken: null,
              revision: null,
            },
          ],
          crossesBoundary: false,
          derivedObligations: [],
        },
      };
    }

    case "CreateWorkItem":
    case "UpdateWorkItem":
      // Work items live in the execution plane in BOTH lanes, so the knowledge
      // adapter records nothing and the comparison stays about knowledge.
      return {
        kind: "plan",
        plan: { ops: [], effects: [], crossesBoundary: false, derivedObligations: [] },
      };

    default:
      return refuse("CAPABILITY_NOT_NEGOTIATED", "capability", null, {
        command: request.command,
      });
  }
}

/**
 * The decision record a command's authorising `decisionRef` implies.
 *
 * Empty when no decision was cited. `observedStateHash` is taken over the state
 * the decider was actually looking at, so a decision made against state that has
 * since moved is detectable rather than merely suspected.
 *
 * Two rules keep this from being the system authorising itself:
 *
 *   A cited decision that ALREADY EXISTS is cited, not rewritten. Emitting a
 *   fresh record would let any later command overwrite a human's recorded
 *   decision by naming its id, so the reference resolves to what the human
 *   actually decided rather than to whatever cited it last.
 *
 *   A decision minted here records the CLASS of whoever asserted it. Recording
 *   an agent's assertion as though a human had made it is the difference between
 *   an audit trail and a decoration, and `decidedByClass` is what the
 *   canonization and publication gates read.
 */
function decisionRecordFor(
  request: CommandRequest,
  target: { kind: Ref["kind"]; id: Id; revision: number | null },
  outcome: ReviewDecisionRecord["outcome"],
  rationale: string,
  observed: unknown,
  context: PolicyContext,
): PlanOp[] {
  const decisionId = request.intent.decisionRef;
  if (decisionId === null || decisionId === "") return [];
  if (context.state.decisions.has(decisionId)) return [];
  return [
    {
      op: "put-decision",
      record: decisionRecord(request, decisionId, outcome, [target], rationale, observed, context),
    },
  ];
}

/** One construction site for every decision record, so no field is set two ways. */
function decisionRecord(
  request: CommandRequest,
  decisionId: Id,
  outcome: ReviewDecisionRecord["outcome"],
  targets: ReviewDecisionRecord["targets"],
  rationale: string,
  observed: unknown,
  context: PolicyContext,
): ReviewDecisionRecord {
  return {
    decisionId,
    outcome,
    targets,
    rationale,
    decidedBy: request.actor.actorId,
    decidedByClass: request.actor.actorClass,
    decidedAt: context.instant,
    observedStateHash: observedHash(context, observed),
    applicationResult: "applied",
  };
}

/**
 * `revision` is part of the evidence id, not just `index`.
 *
 * Three call sites minted ids from three different index formulas — 0-based,
 * `head.revision + index + 1`, and `1000 + index` — and they collide: a claim
 * created with three evidence links and later superseded at revision 1 mints
 * `#2` twice. The second write then overwrote the row a historical revision
 * still referenced, silently rewriting the provenance of a revision nobody
 * touched. Scoping the id to the revision that owns it makes that unreachable
 * rather than merely unlikely.
 */
function evidenceRecordFor(
  ownerId: string,
  revision: number,
  index: number,
  link: Record<string, string>,
  origin: Origin,
  context: PolicyContext,
): EvidenceRecord {
  const sourceRefId = String(link.sourceRefId);
  const locator = String(link.locator ?? "");
  const text = context.documentText(sourceRefId, locator) ?? "";
  const source = context.state.sources.get(sourceRefId);
  return {
    evidenceId: `ev:${ownerId}#r${revision}#${index}`,
    sourceRefId,
    // The excerpt is NOT copied into canonical knowledge. The source plane owns
    // its own content; a locator plus a hash keeps the link checkable and the
    // quotation verifiable without this store quietly becoming a second copy of
    // a document it does not own — and without inheriting that document's
    // retention and disclosure obligations.
    excerpt: null,
    excerptHash: context.contentHash(text),
    locator,
    observedBy: origin,
    strength: "direct",
    sensitivity: source?.sensitivity ?? "public",
    redactionState: "none",
  };
}
