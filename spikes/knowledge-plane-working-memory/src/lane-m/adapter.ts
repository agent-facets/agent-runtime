// Lane M adapter: the command and query service over the Markdown canonical
// store, with a derived Postgres projection behind it.
//
// The adapter owns persistence and atomicity reporting, and nothing else.
// Validation, authority, guards, and lifecycle semantics live in the shared
// policy module, so a difference between the lanes can only ever be a difference
// in storage — which is the thing the experiment is trying to measure.

import { createHash } from "node:crypto";

import { compareIds } from "../canonical.ts";
import { tickToInstant } from "../contract.ts";
import type {
  Atomicity,
  CapabilityProfile,
  CommandRequest,
  CommandResponse,
  EntityEffect,
  ErrorCode,
  QueryRequest,
  QueryResponse,
  Ref,
} from "../knowledge/contract.ts";
import { CAPABILITY_KEYS, CONTRACT_VERSION } from "../knowledge/contract.ts";
import type { KnowledgeState, Plan } from "../knowledge/policy.ts";
import { decide, objectsTouched } from "../knowledge/policy.ts";
import type { Corpus, CorpusVectors } from "../corpus.ts";
import type { ExecutionPlane } from "../execution/plane.ts";
import { MarkdownStore, StoreWriteRejected } from "./store.ts";
import type { FreshnessRow } from "./projection.ts";
import { DEFAULT_CONSTRAINT, query as runQuery } from "./queries.ts";

export type ExecutionRecord = {
  tick: number;
  command: string;
  outcome: "committed" | "refused" | "failed";
  code: string | null;
  category: string | null;
  effects: EntityEffect[];
  atomicity: string | null;
  /** Distinct canonical objects the commit touched; null when nothing committed. */
  objectsTouched: number | null;
  replayed: boolean;
};

function contentHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/**
 * The atomicity class Lane M genuinely provides for a given plan.
 *
 * Derived here rather than declared in the shared policy module, because the
 * shared module cannot honestly name one: a file tree has no multi-object
 * transaction and a graph does. Lane M writes one file atomically through
 * temp-then-rename, so a single-object plan really is A1; anything wider is A2
 * behind a durable intent record, and anything that must also reach an export or
 * the coordination plane is A3. Reporting A1 across the board would inflate this
 * lane on the one dimension the fault matrix exists to measure.
 */
export function atomicityFor(plan: Plan): Atomicity {
  if (plan.crossesBoundary) return "A3";
  return objectsTouched(plan.ops) > 1 ? "A2" : "A1";
}

export type LaneMOptions = {
  root: string;
  corpus: Corpus;
  vectors: CorpusVectors;
  /** Absent in the offline smoke path, which is documented as not evidence. */
  execution?: ExecutionPlane;
  freshness?: () => Promise<FreshnessRow | null>;
  /**
   * The `lane-m-guarded` mitigation: an exclusive per-object lock held across
   * read-decide-write. Off by default, because the stock lane has to be able to
   * show the failure this removes.
   */
  guarded?: boolean;
};

export class LaneMAdapter {
  readonly laneId = "lane-m";
  private readonly store: MarkdownStore;
  private readonly corpus: Corpus;
  private readonly vectors: CorpusVectors;
  private readonly execution: ExecutionPlane | null;
  private readonly freshnessReader: (() => Promise<FreshnessRow | null>) | null;
  private readonly guarded: boolean;
  private state: KnowledgeState;
  /** In-memory only when no execution plane is attached. */
  private readonly memoryLedger = new Map<string, CommandResponse>();

  constructor(options: LaneMOptions) {
    this.store = new MarkdownStore(options.root);
    this.corpus = options.corpus;
    this.vectors = options.vectors;
    this.execution = options.execution ?? null;
    this.freshnessReader = options.freshness ?? null;
    this.guarded = options.guarded === true;
    this.store.setup();
    this.state = this.store.load();
  }

  versionOf(ref: Ref): string | null {
    return this.store.versionOf(ref);
  }

  generation(): { files: Record<string, string>; digest: string } {
    return this.store.generation();
  }

  snapshot(): KnowledgeState {
    return this.state;
  }

  reload(): void {
    this.state = this.store.load();
  }

  pendingIntents(): ReturnType<MarkdownStore["pendingIntents"]> {
    return this.store.pendingIntents();
  }

  repair(): ReturnType<MarkdownStore["repairPending"]> {
    const repaired = this.store.repairPending();
    this.state = this.store.load();
    return repaired;
  }

  async profile(): Promise<CapabilityProfile> {
    const capabilities: Record<string, string> = {};
    for (const key of CAPABILITY_KEYS) capabilities[key] = "native";
    // Honest declarations, not aspirational ones. Each of these is a genuine
    // property of a file tree, and each is charged to this lane where it costs.
    capabilities.multi_object_atomic_write = "absent";
    capabilities.path_query = "emulated";
    capabilities.vector_search = "emulated";
    capabilities.constraint_uniqueness = "emulated";
    capabilities.constraint_existence = "emulated";
    capabilities.online_backup = "native";
    return {
      laneId: this.laneId,
      contractVersion: CONTRACT_VERSION,
      capabilities: capabilities as CapabilityProfile["capabilities"],
      limits: { maxPathDepth: 8, maxResult: 500, maxExcerpt: 0 },
      atomicityByCommand: {
        CreateEntity: "A1",
        RegisterSourceRef: "A1",
        CreateClaim: "A2",
        CorrectClaim: "A2",
        SupersedeClaim: "A2",
        SummarizeClaims: "A2",
        MergeEntities: "A2",
        RetractClaim: "A3",
        PublishActivityRecord: "A3",
      },
      derivedStructures: ["projection.claim", "projection.edge", "projection.chunk"],
    };
  }

  private documentText(sourceRefId: string, locator: string): string | null {
    const source = this.corpus.sources.find((entry) => entry.id === sourceRefId);
    if (!source) return null;
    const document = source.documents.find((entry) => entry.locator === locator);
    return document ? document.text : null;
  }

  async execute(request: CommandRequest): Promise<CommandResponse> {
    // The lock spans read-decide-write, not just the write. Locking only the
    // write would leave the decision made against a snapshot another process had
    // already invalidated, which is the race itself.
    const locks = this.guarded
      ? request.intent.scope.map((ref) => `${ref.kind}:${ref.id}`).sort()
      : [];
    for (const key of locks) {
      if (!this.store.acquireLock(key, 10_000)) {
        for (const held of locks) this.store.releaseLock(held);
        return {
          outcome: "failed",
          contractVersion: CONTRACT_VERSION,
          error: {
            code: "LOCK_TIMEOUT",
            category: "transient",
            retryable: "after_refresh",
            target: null,
            observed: { key },
            remedy: "refresh_and_retry",
          },
          // The write never started, so this is knowable rather than `unknown`.
          applied: "no",
        };
      }
    }
    try {
      // Re-read canonical state INSIDE the lock. The snapshot taken before the
      // lock was acquired is exactly the stale one the race exploits.
      if (this.guarded) this.state = this.store.load();
      return await this.executeLocked(request);
    } finally {
      for (const key of locks) this.store.releaseLock(key);
    }
  }

  private async executeLocked(request: CommandRequest): Promise<CommandResponse> {
    const replay = await this.replayOf(request);
    if (replay) return replay;

    const instant = tickToInstant(request.tick);
    const decision = decide(request, {
      state: this.state,
      instant,
      versionOf: (ref) => this.store.versionOf(ref),
      nodeId: "node.ada",
      documentText: (sourceRefId, locator) => this.documentText(sourceRefId, locator),
      contentHash,
    });

    if (decision.kind === "refused") {
      // A refusal may still owe an audit record. Nothing it writes carries the
      // refused content: the op itself is contentless by construction.
      if (decision.ops && decision.ops.length > 0) {
        this.store.apply(decision.ops);
        this.state = this.store.load();
      }
      const response: CommandResponse = {
        outcome: "refused",
        contractVersion: CONTRACT_VERSION,
        error: decision.error,
      };
      await this.remember(request, response);
      return response;
    }

    const plan = decision.plan;
    const atomicity = atomicityFor(plan);
    const intentId = `${request.tick}-${request.idempotency.key.slice(0, 8)}`;
    const files = plan.effects.map((effect) => `${effect.ref.kind}:${effect.ref.id}`);

    // A plan this lane cannot commit as one unit names every file it will touch,
    // and records the plan itself, BEFORE writing any of them. That is what
    // turns an interruption from "torn" into "unfinished".
    const needsIntent = atomicity !== "A1";
    if (needsIntent) {
      this.store.beginIntent(intentId, request.command, files, plan.ops, contentHash(plan.ops));
      if (this.execution) {
        await this.execution.openIntent(intentId, request.command, files, plan.ops, request.tick);
      }
    }

    try {
      this.store.apply(plan.ops);
    } catch (error) {
      // Symmetric with Lane N: a store rejection is a lane result with a typed
      // code, not an exception that kills the worker and gets read as a broken
      // harness. The pending intent is deliberately LEFT pending — a partially
      // applied plan is exactly what the repair path exists to finish.
      if (error instanceof StoreWriteRejected) {
        const response = failureFor(error, request, needsIntent);
        await this.remember(request, response);
        return response;
      }
      throw error;
    }

    if (needsIntent) {
      this.store.completeIntent(intentId);
      if (this.execution) await this.execution.completeIntent(intentId);
    }

    this.state = this.store.load();

    const effects = plan.effects.map((effect) => ({
      ...effect,
      newVersionToken: this.store.versionOf(effect.ref),
    }));

    const response: CommandResponse = {
      outcome: "committed",
      contractVersion: CONTRACT_VERSION,
      receipt: {
        receiptId: contentHash({ key: request.idempotency.key, tick: request.tick }).slice(0, 24),
        idempotencyKey: request.idempotency.key,
        replayed: false,
        committedTick: request.tick,
        atomicity,
        objectsTouched: objectsTouched(plan.ops),
        durabilityPoint: this.store.generation().digest,
        actorSnapshot: request.actor,
        intentSnapshot: request.intent,
        guardSnapshot: request.guard,
        derivedObligations: plan.derivedObligations,
      },
      effects,
      warnings: [],
    };
    await this.remember(request, response);
    return response;
  }

  /** Byte-identical replay. Re-executing would double-apply. */
  private async replayOf(request: CommandRequest): Promise<CommandResponse | null> {
    const stored = this.execution
      ? (await this.execution.lookup(request.idempotency.key))?.response ?? null
      : this.memoryLedger.get(request.idempotency.key) ?? null;
    if (!stored) return null;
    if (stored.outcome === "committed") {
      return { ...stored, receipt: { ...stored.receipt, replayed: true } };
    }
    return stored;
  }

  private async remember(request: CommandRequest, response: CommandResponse): Promise<void> {
    if (this.execution) {
      await this.execution.record(
        {
          key: request.idempotency.key,
          command: request.command,
          requestHash: contentHash(request),
          response,
          committedTick: request.tick,
        },
        request.idempotency.keyScope,
      );
      return;
    }
    this.memoryLedger.set(request.idempotency.key, response);
  }

  async query(request: QueryRequest): Promise<QueryResponse> {
    const freshness = this.freshnessReader ? await this.freshnessReader() : null;
    return runQuery(
      { ...request, constraint: { ...DEFAULT_CONSTRAINT, ...request.constraint } },
      {
        state: this.state,
        corpus: this.corpus,
        vectors: this.vectors,
        canonicalPoint: this.store.generation().digest,
        freshness,
      },
    );
  }

  /**
   * Canonical state in neutral form.
   *
   * Version tokens are deliberately omitted: they are per-lane by construction,
   * so including them would make two semantically identical exports compare
   * unequal and turn a portability check into a storage-format check.
   */
  async exportState(): Promise<Record<string, unknown>> {
    const state = this.state;
    return {
      contractVersion: CONTRACT_VERSION,
      entities: [...state.entities.values()]
        .map((entity) => ({ ...entity, versionToken: undefined }))
        .sort((left, right) => compareIds(left.entityId, right.entityId)),
      claims: [...state.claims.entries()]
        .sort(([a], [b]) => compareIds(a, b))
        .map(([claimId, revisions]) => ({
          claimId,
          revisions: revisions.map((revision) => ({ ...revision, versionToken: undefined })),
        })),
      relationships: [...state.relationships.entries()]
        .sort(([a], [b]) => compareIds(a, b))
        .map(([relationshipId, revisions]) => ({
          relationshipId,
          revisions: revisions.map((revision) => ({ ...revision, versionToken: undefined })),
        })),
      evidence: [...state.evidence.values()].sort((left, right) =>
        compareIds(left.evidenceId, right.evidenceId),
      ),
      sources: [...state.sources.values()].sort((left, right) =>
        compareIds(left.sourceRefId, right.sourceRefId),
      ),
      contradictions: [...state.contradictions.values()].sort((left, right) =>
        compareIds(left.contradictionId, right.contradictionId),
      ),
      decisions: [...state.decisions.values()].sort((left, right) =>
        compareIds(left.decisionId, right.decisionId),
      ),
      // Same sections as Lane N, in the same order, with the same shape. These
      // are canonical contract state; exporting them as bare keys meant a
      // restore lost them and the round-trip check could not see it.
      peerRecords: [...state.peerRecords.entries()]
        .sort(([a], [b]) => compareIds(a, b))
        .map(([recordId, record]) => ({ recordId, record })),
      candidates: [...state.candidates.values()].sort((left, right) =>
        compareIds(left.candidateId, right.candidateId),
      ),
      activeContexts: [...state.activeContexts.entries()]
        .sort(([a], [b]) => compareIds(a, b))
        .map(([activeContextId, record]) => ({ activeContextId, record })),
      published: [...state.published.keys()].sort(),
      rejections: [...state.rejections].sort((left, right) =>
        compareIds(left.contentHash, right.contentHash),
      ),
    };
  }

  async close(): Promise<void> {
    // The store holds no handle; the pools are owned by the caller that opened
    // them, so closing them here would close a resource this adapter borrowed.
  }
}

/** Map a store-level rejection onto the contract's own error vocabulary. */
function failureFor(
  error: StoreWriteRejected,
  request: CommandRequest,
  intentLeftPending: boolean,
): CommandResponse {
  const code: ErrorCode =
    error.reason === "duplicate_revision"
      ? "STALE_VERSION"
      : error.reason === "duplicate_key"
        ? "DUPLICATE_NATURAL_KEY"
        : "EVIDENCE_CHAIN_BROKEN";
  return {
    outcome: "failed",
    contractVersion: CONTRACT_VERSION,
    error: {
      code,
      category: error.reason === "incomplete" ? "integrity" : "conflict",
      retryable: "after_refresh",
      target: request.intent.scope[0] ?? null,
      observed: { reason: error.reason },
      remedy: error.reason === "incomplete" ? "repair_required" : "refresh_and_retry",
    },
    // Ops before the failing one already landed on disk when the plan was
    // multi-object, and a file tree cannot take them back. `unknown` is the
    // honest answer, and the pending intent is what makes it recoverable.
    applied: intentLeftPending ? "unknown" : "no",
  };
}

export function recordFor(
  tick: number,
  command: string,
  response: CommandResponse,
): ExecutionRecord {
  if (response.outcome === "committed") {
    return {
      tick,
      command,
      outcome: "committed",
      code: null,
      category: null,
      effects: response.effects,
      atomicity: response.receipt.atomicity,
      objectsTouched: response.receipt.objectsTouched,
      replayed: response.receipt.replayed,
    };
  }
  return {
    tick,
    command,
    outcome: response.outcome,
    code: response.error.code,
    category: response.error.category,
    effects: [],
    atomicity: null,
    objectsTouched: null,
    replayed: false,
  };
}
