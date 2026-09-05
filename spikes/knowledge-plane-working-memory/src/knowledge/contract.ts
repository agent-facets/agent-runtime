// The backend-neutral knowledge contract.
//
// This module imports no store driver, no filesystem, and no network client.
// That is checked mechanically by the self-test family, because a contract that
// has quietly grown one lane's shape cannot referee a comparison between them.
//
// Nothing here names a file, a table, a label, a node, or a query language. The
// only identifiers that cross this boundary are opaque logical ids and opaque
// version tokens, and the only ordering guarantees are the ones a query
// declares for itself.

import { KNOWLEDGE_CONTRACT_VERSION } from "../contract.ts";

export const CONTRACT_VERSION = KNOWLEDGE_CONTRACT_VERSION;

// ---------------------------------------------------------------------------
// Value types
// ---------------------------------------------------------------------------

/** Opaque logical identity. Fixtures use stable symbolic ids; production would not. */
export type Id = string;

/** RFC 3339 UTC, millisecond precision. Derived from the deterministic tick. */
export type Instant = string;

/** Half-open world-time interval. `null` means unbounded on that side. */
export type Interval = { from: Instant | null; to: Instant | null };

/**
 * An opaque, equality-only version token.
 *
 * Derived from canonical state alone, so Lane M may not mint one from its
 * projection and Lane N may not use an internal element id that would not
 * survive a dump and restore. Callers may compare it and echo it back. They may
 * not order it, parse it, or do arithmetic on it.
 */
export type VersionToken = string;

export type SourceAuthority = "primary" | "secondary" | "derived" | "unknown";

export type OriginKind =
  | "human_direct"
  | "human_decision"
  | "agent_extraction"
  | "agent_inference"
  | "system_derivation"
  | "external_document"
  | "peer_report"
  | "import";

/**
 * What an origin is permitted to do, independent of how confident its text is.
 *
 * This is the whole authority model in one field. A peer report is
 * `observational` however certain it sounds; a human decision is `establishing`
 * however thin its excerpt is.
 */
export type Authority = "establishing" | "corroborating" | "proposing" | "observational";

export type BeliefStatus =
  | "proposed"
  | "active"
  | "disputed"
  | "summarized"
  | "superseded"
  | "retracted"
  | "rejected";

/**
 * Why a revision stopped being the believed one.
 *
 * `world_progressed` and `corrected` are the pair that must never collapse into
 * each other: one says the world changed and the old revision remains true of
 * its interval, the other says we were wrong about that same interval.
 */
export type ClosureReason =
  | "world_progressed"
  | "corrected"
  | "summarized"
  | "merged"
  | "retracted"
  | "rejected";

export type Sensitivity = "public" | "internal" | "private" | "restricted";
export type Visibility = "local_only" | "publishable_summary" | "publishable_full";
export type RedactionState = "none" | "partial" | "purged";

export type Origin = {
  originKind: OriginKind;
  authority: Authority;
  actorId: Id;
  /** Set only when `originKind` is `peer_report`. */
  publisherNodeId: Id | null;
  at: Instant;
};

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

export type EntityKind =
  | "person"
  | "project"
  | "component"
  | "library"
  | "organization"
  | "agent"
  | "node"
  | "document"
  | "concept";

export type EntityRecord = {
  entityId: Id;
  kind: EntityKind;
  canonicalName: string;
  aliases: string[];
  /** Set on the absorbed side of a merge. Resolution follows it; nothing is rewritten. */
  mergedInto: Id | null;
  sensitivity: Sensitivity;
  visibility: Visibility;
  versionToken: VersionToken;
};

export type ClaimRevision = {
  claimId: Id;
  revision: number;
  subject: Id;
  predicate: string;
  value: string;
  scope: string;
  /** When the proposition is true of the world. */
  valid: Interval;
  /** When this revision entered belief, and when belief in it ended. */
  assertedAt: Instant;
  assertedUntil: Instant | null;
  closureReason: ClosureReason | null;
  belief: BeliefStatus;
  canon: boolean;
  origin: Origin;
  evidenceIds: Id[];
  derivedFrom: Id[];
  supersedes: { claimId: Id; revision: number } | null;
  supersededBy: { claimId: Id; revision: number } | null;
  sensitivity: Sensitivity;
  visibility: Visibility;
  redactionState: RedactionState;
  versionToken: VersionToken;
};

export type RelationshipRevision = {
  relationshipId: Id;
  revision: number;
  from: Id;
  relType: string;
  to: Id;
  directed: boolean;
  valid: Interval;
  assertedAt: Instant;
  assertedUntil: Instant | null;
  closureReason: ClosureReason | null;
  belief: BeliefStatus;
  origin: Origin;
  evidenceIds: Id[];
  sensitivity: Sensitivity;
  versionToken: VersionToken;
};

export type EvidenceRecord = {
  evidenceId: Id;
  sourceRefId: Id;
  /** Absent once redacted; the hash survives so the link stays checkable. */
  excerpt: string | null;
  excerptHash: string;
  locator: string;
  observedBy: Origin;
  strength: "direct" | "indirect" | "inferred";
  sensitivity: Sensitivity;
  redactionState: RedactionState;
};

export type SourceRefRecord = {
  sourceRefId: Id;
  system: string;
  externalId: string;
  uri: string | null;
  contentHash: string | null;
  sourceAuthority: SourceAuthority;
  publisherNodeId: Id | null;
  sensitivity: Sensitivity;
  visibility: Visibility;
};

export type ContradictionRecord = {
  contradictionId: Id;
  /** Unordered. No member is privileged before a decision exists. */
  members: Array<{ claimId: Id; revision: number }>;
  /**
   * Peer reports that take a position in this contradiction.
   *
   * A separate field rather than an entry in `members`, because a peer report is
   * a position WITHOUT being a claim. Merging the two collections is exactly the
   * promotion the architecture forbids, and a type is a stronger guarantee than
   * a filter every reader has to remember to apply.
   */
  peerMembers: Id[];
  detectedAt: Instant;
  detectedBy: Origin;
  basis: "logical" | "temporal" | "source_conflict" | "human_reported";
  resolution: { decisionId: Id; at: Instant } | null;
};

export type ReviewOutcome =
  | "affirm"
  | "correct"
  | "supersede"
  | "reject"
  | "retract"
  | "merge"
  | "canonize"
  | "decanonize"
  | "defer";

export type ReviewDecisionRecord = {
  decisionId: Id;
  outcome: ReviewOutcome;
  targets: Array<{ kind: RefKind; id: Id; revision: number | null }>;
  rationale: string;
  decidedBy: Id;
  /**
   * The CLASS of the actor this decision is recorded under.
   *
   * Without it a reader cannot tell a decision a human actually made from one an
   * agent asserted by citing an identifier, because both land in the same store
   * with the same shape. Canonization and publication may only rest on `human`.
   */
  decidedByClass: ActorClass;
  decidedAt: Instant;
  /** What the decider was looking at. A decision against stale state is refused. */
  observedStateHash: string;
  applicationResult: "applied" | "stale_rejected" | "superseded_before_apply" | null;
};

export type RefKind =
  | "entity"
  | "claim"
  | "relationship"
  | "evidence"
  | "source"
  | "contradiction"
  | "work_item"
  | "active_context"
  | "activity_record"
  /** A recorded human review decision, so a refusal can name the one it collided with. */
  | "decision";

export type Ref = { kind: RefKind; id: Id };

export type WorkItemRecord = {
  workItemId: Id;
  title: string;
  intent: string;
  status: "open" | "active" | "blocked" | "done" | "abandoned";
  /** Claims that must hold. Referenced, never copied. */
  constraintClaimIds: Id[];
  decisionClaimIds: Id[];
  outputSourceRefIds: Id[];
  attemptRefs: string[];
  versionToken: VersionToken;
};

export type ContextTier = "canon" | "reliable" | "provisional" | "attributed";

export type ContextItem = {
  /** Always a pinned revision. A bare id is unreproducible and invalid. */
  ref: { kind: "claim" | "relationship"; id: Id; revision: number };
  statement: string;
  tier: ContextTier;
  originKind: OriginKind;
  publisherNodeId: Id | null;
  evidenceCount: number;
  valid: Interval;
};

export type ActiveContextRecord = {
  activeContextId: Id;
  workItemId: Id;
  asOfTransaction: Instant;
  budget: { maxItems: number; maxTokens: number };
  items: ContextItem[];
  excluded: Array<{ ref: Ref; reason: string }>;
  versionToken: VersionToken;
};

// ---------------------------------------------------------------------------
// Coordination
// ---------------------------------------------------------------------------

export type ActivityKind = "started" | "progress" | "blocked" | "completed" | "learned";

export type CoordinationRecord = {
  schemaVersion: string;
  recordId: string;
  publisherNodeId: Id;
  namespaceSeq: number;
  prevContentHash: string | null;
  actorId: Id;
  workItemId: string;
  kind: ActivityKind;
  occurredAt: Instant;
  publishedAt: Instant;
  summary: string;
  status: string;
  outputs: Array<{ type: string; uri: string; digest: string | null }>;
  /** Opaque to every reader but the publisher. Never resolvable into a claim. */
  knowledgeRefs: string[];
  sourceRefs: string[];
  supersedesRecordId: string | null;
  contentHash: string;
};

/**
 * A peer report, structurally distinct from a claim.
 *
 * There is deliberately no call in this contract that returns claims and reports
 * in one homogeneous collection, and none may be added. Non-promotion is a type,
 * not a policy that a filter might forget to apply.
 */
export type AttributedReport = {
  record: CoordinationRecord;
  ingestRef: string;
  ingestedAt: Instant;
  withdrawn: boolean;
  warnings: string[];
};

// ---------------------------------------------------------------------------
// Request envelope
// ---------------------------------------------------------------------------

export type ActorClass = "human" | "agent" | "system" | "importer" | "peer_publisher";

export type Actor = {
  actorId: Id;
  actorClass: ActorClass;
  nodeId: Id;
  onBehalfOf: Id | null;
};

export type EffectClass = "additive" | "corrective" | "destructive" | "authority" | "publish";

export type AuthorizationIntent = {
  effectClass: EffectClass;
  /** The blast radius the caller believes it is touching. Exceeding it is refused. */
  scope: Ref[];
  decisionRef: Id | null;
  justification: string;
};

export type StaleGuard =
  | { mode: "expected_version"; targets: Array<{ ref: Ref; expected: VersionToken }> }
  | { mode: "expected_absent"; naturalKeys: string[] }
  | { mode: "unguarded"; reason: string };

export type IdempotencyDirective = {
  key: string;
  keyScope: "actor" | "work_item" | "global";
};

export type CommandName =
  | "CreateEntity"
  | "CorrectEntity"
  | "MergeEntities"
  | "CreateClaim"
  | "CorrectClaim"
  | "ReinforceClaim"
  | "SupersedeClaim"
  | "SummarizeClaims"
  | "RecordContradiction"
  | "RetractClaim"
  | "AssertRelationship"
  | "ReviseRelationship"
  | "InvalidateRelationship"
  | "RegisterSourceRef"
  | "LinkEvidence"
  | "ResolveConflict"
  | "CanonizeClaim"
  | "DecanonizeClaim"
  | "CreateWorkItem"
  | "UpdateWorkItem"
  | "PutActiveContext"
  | "PublishActivityRecord"
  | "IngestPeerActivity"
  | "OpenCandidateFromPeerReport";

export type CommandRequest = {
  contractVersion: string;
  command: CommandName;
  actor: Actor;
  intent: AuthorizationIntent;
  idempotency: IdempotencyDirective;
  guard: StaleGuard;
  /** The deterministic clock. Never `Date.now()`. */
  tick: number;
  args: Record<string, unknown>;
};

// ---------------------------------------------------------------------------
// Response envelope
// ---------------------------------------------------------------------------

export type EffectChange =
  | "created"
  | "updated"
  | "superseded"
  | "summarized"
  | "invalidated"
  | "merged_into"
  | "retracted"
  | "canonized"
  | "decanonized"
  | "linked"
  | "published"
  | "quarantined"
  | "candidate_opened";

export type EntityEffect = {
  ref: Ref;
  change: EffectChange;
  priorVersionToken: VersionToken | null;
  newVersionToken: VersionToken | null;
  revision: number | null;
};

/**
 * Atomicity classes.
 *
 * `A1` all effects commit together or none do.
 * `A2` ordered units behind a durable intent record; an interruption is
 *      detectable and rolls forward, never torn.
 * `A3` an effect across a boundary neither lane can make atomic; failure leaves
 *      a durable obligation rather than silent loss.
 *
 * A command's class is what the lane HONESTLY provides, not the weaker of the
 * two. Lane N's transactional advantage is a measured result, not something to
 * be normalised away.
 */
export type Atomicity = "A1" | "A2" | "A3";

export type CommitReceipt = {
  receiptId: string;
  idempotencyKey: string;
  replayed: boolean;
  committedTick: number;
  atomicity: Atomicity;
  /**
   * Distinct canonical objects this commit touched.
   *
   * Without it, "multi-object plans are atomic" could only be checked as "some
   * committed plan was classed A1" — which every single-object plan and even a
   * zero-op plan satisfies. The claim is about plans that touch MORE THAN ONE
   * object, so the count has to reach the evidence.
   */
  objectsTouched: number;
  durabilityPoint: string;
  actorSnapshot: Actor;
  intentSnapshot: AuthorizationIntent;
  guardSnapshot: StaleGuard;
  /** Non-empty whenever a derived structure now lags canonical state. */
  derivedObligations: string[];
};

export type ErrorCategory =
  | "validation"
  | "authorization"
  | "precondition"
  | "conflict"
  | "capability"
  | "transient"
  | "integrity";

export type ErrorCode =
  | "SCHEMA_UNKNOWN_TYPE"
  | "TEMPORAL_INVALID"
  | "TEMPORAL_OVERLAP"
  | "EVIDENCE_REQUIRED"
  | "CONTRADICTION_REQUIRES_TWO_DISTINCT"
  | "CANONIZE_REQUIRES_HUMAN"
  | "DECISION_REF_REQUIRED"
  | "NAMESPACE_VIOLATION"
  | "SCOPE_EXCEEDED"
  | "INTENT_MISMATCH"
  | "SUBJECT_NOT_FOUND"
  | "CLAIM_RETRACTED"
  | "CONFLICT_ALREADY_RESOLVED"
  | "MERGE_SURVIVOR_IS_TOMBSTONE"
  | "MERGE_CYCLE"
  | "STALE_VERSION"
  | "DUPLICATE_NATURAL_KEY"
  | "IDEMPOTENCY_KEY_REUSE"
  | "IN_FLIGHT"
  | "CAPABILITY_NOT_NEGOTIATED"
  | "CONTRACT_VERSION_UNSUPPORTED"
  | "PEER_SCHEMA_UNSUPPORTED"
  | "PEER_PROMOTION_FORBIDDEN"
  /**
   * A peer re-published a record id it had already published, with different
   * content. The feed is append-only, so this is a rewritten history and the
   * record is quarantined rather than ingested — overwriting would let a peer
   * silently change what it is on record as having said.
   */
  | "PEER_HISTORY_REWRITTEN"
  | "SENSITIVE_ADMISSION_REFUSED"
  | "STORE_UNAVAILABLE"
  | "DEADLINE_EXCEEDED"
  | "LOCK_TIMEOUT"
  | "PARTIAL_MUTATION_PENDING"
  | "DANGLING_REFERENCE"
  | "EVIDENCE_CHAIN_BROKEN"
  | "TOMBSTONE_VIOLATED";

export type TypedError = {
  code: ErrorCode;
  category: ErrorCategory;
  /**
   * Three values, not a boolean. Retrying a `STALE_VERSION` without re-reading
   * is always wrong, and a two-valued flag invites exactly that.
   */
  retryable: "no" | "yes" | "after_refresh";
  target: Ref | null;
  observed: Record<string, unknown> | null;
  remedy:
    | "refresh_and_retry"
    | "obtain_decision"
    | "reduce_scope"
    | "negotiate_capability"
    | "repair_required"
    | "none";
};

export type CommandResponse =
  | {
      outcome: "committed";
      contractVersion: string;
      receipt: CommitReceipt;
      effects: EntityEffect[];
      warnings: string[];
    }
  | {
      outcome: "refused";
      contractVersion: string;
      error: TypedError;
    }
  | {
      outcome: "failed";
      contractVersion: string;
      error: TypedError;
      /**
       * `unknown` is a legitimate value. A lane that can never produce it is
       * hiding an unsafe assumption about a boundary it does not control.
       */
      applied: "yes" | "no" | "unknown";
    };

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export type QueryName =
  | "CurrentClaims"
  | "ClaimsAsOf"
  | "BelievedAt"
  | "Provenance"
  | "History"
  | "Path"
  | "Conflicts"
  | "StaleDecisions"
  | "Work"
  | "HybridRetrieve"
  | "Activity"
  | "Freshness";

export type ReadConstraint = {
  /** `null` requires a canonical read. Golden queries always use `null`. */
  maxStalenessMs: number | null;
  onStale: "fail" | "serve_marked";
  asOfValid: Instant | null;
  asOfTransaction: Instant | null;
  limit: number;
  maxDepth: number | null;
  includeDisputed: boolean;
  includeSummarized: boolean;
};

export type FreshnessBlock = {
  servedFrom: "canonical" | "derived" | "mixed";
  canonicalPoint: string;
  projectionWatermark: string | null;
  lagMs: number | null;
  staleness: "fresh" | "lagging" | "stale" | "unknown";
  /** What makes hard gate 10 mechanically checkable rather than a judgement. */
  degradedFields: string[];
  rebuildPending: boolean;
};

/** A path hop. Logical ids only, so a lane cannot inflate its hop count by reifying. */
export type PathHop = { from: Id; relType: string; to: Id; evidenceIds: Id[] };

export type QueryRequest = {
  contractVersion: string;
  query: QueryName;
  constraint: ReadConstraint;
  args: Record<string, unknown>;
};

export type QueryResponse =
  | {
      outcome: "ok";
      contractVersion: string;
      freshness: FreshnessBlock;
      /** Order is meaningful only where the query declares it. */
      data: unknown;
      truncated: boolean;
    }
  | {
      outcome: "refused";
      contractVersion: string;
      error: TypedError;
    };

// ---------------------------------------------------------------------------
// Capability negotiation
// ---------------------------------------------------------------------------

export type CapabilityState = "native" | "emulated" | "absent";

/**
 * `emulated` is fully acceptable and must be indistinguishable at this surface.
 * What it costs is measured; that it is emulated is not itself a penalty.
 */
export type CapabilityProfile = {
  laneId: string;
  contractVersion: string;
  capabilities: Record<string, CapabilityState>;
  limits: { maxPathDepth: number; maxResult: number; maxExcerpt: number };
  atomicityByCommand: Partial<Record<CommandName, Atomicity>>;
  derivedStructures: string[];
};

export const CAPABILITY_KEYS = [
  "bitemporal_claims",
  "object_version_tokens",
  "multi_object_atomic_write",
  "path_query",
  "vector_search",
  "lexical_search",
  "constraint_uniqueness",
  "constraint_existence",
  "online_backup",
  "portable_export",
  "tombstone_enforcement",
  "peer_segregation",
] as const;

// ---------------------------------------------------------------------------
// The adapter surface both lanes implement
// ---------------------------------------------------------------------------

export type KnowledgeAdapter = {
  laneId: string;
  profile(): Promise<CapabilityProfile>;
  execute(request: CommandRequest): Promise<CommandResponse>;
  query(request: QueryRequest): Promise<QueryResponse>;
  /** Full canonical state in neutral form, for final-state comparison. */
  exportState(): Promise<Record<string, unknown>>;
  close(): Promise<void>;
};
