// Lane N adapter: the command and query service over the Neo4j canonical graph.
//
// The same shared policy module Lane M uses decides everything: validation,
// authority, guards, and lifecycle semantics. Only persistence and the read
// surface differ, which is what keeps a measured difference a difference about
// storage.
//
// The one thing this adapter declares for itself is atomicity, and it declares
// MORE than Lane M can. That is the point: a multi-object plan commits in a
// single graph transaction, so this lane needs no intent record and no
// roll-forward repair. Levelling that away to make the lanes look alike would
// have deleted the result.

import { createHash } from "node:crypto";

import { compareIds } from "../canonical.ts";
import { tickToInstant } from "../contract.ts";
import type {
  Atomicity,
  CapabilityProfile,
  CommandRequest,
  CommandResponse,
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
import { DEFAULT_CONSTRAINT } from "../lane-m/queries.ts";
import { GraphStore, GraphWriteRejected, tokenFor } from "./graph.ts";
import { query as runQuery } from "./queries.ts";

function contentHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** Map a store-level rejection onto the contract's own error vocabulary. */
function failureFor(error: GraphWriteRejected, request: CommandRequest): CommandResponse {
  const code: ErrorCode =
    error.reason === "duplicate_revision"
      ? "STALE_VERSION"
      : error.reason === "duplicate_key"
        ? "DUPLICATE_NATURAL_KEY"
        : error.reason === "incomplete"
          ? "EVIDENCE_CHAIN_BROKEN"
          : "STORE_UNAVAILABLE";
  return {
    outcome: "failed",
    contractVersion: CONTRACT_VERSION,
    error: {
      code,
      category:
        error.reason === "unavailable"
          ? "transient"
          : error.reason === "incomplete"
            ? "integrity"
            : "conflict",
      retryable: error.reason === "unavailable" ? "yes" : "after_refresh",
      target: request.intent.scope[0] ?? null,
      observed: { reason: error.reason },
      remedy: error.reason === "incomplete" ? "repair_required" : "refresh_and_retry",
    },
    // A transaction that never committed applied nothing. A driver-level abort
    // may have committed and lost the acknowledgement, and saying so is the
    // whole point of the field.
    applied: error.applied,
  };
}

/**
 * The atomicity class Lane N genuinely provides.
 *
 * Every plan commits inside one transaction, so object count is irrelevant: a
 * multi-object plan is `A1` here and `A2` in Lane M, and that difference is a
 * measured property of the two stores. `A3` still applies where an effect leaves
 * the store's reach entirely — erasure that must also reach exports, and
 * publication into the coordination plane — because no store can make those
 * atomic with its own write.
 */
export function atomicityFor(plan: Plan): Atomicity {
  return plan.crossesBoundary ? "A3" : "A1";
}

export type LaneNOptions = {
  store: GraphStore;
  corpus: Corpus;
  vectors: CorpusVectors;
  execution?: ExecutionPlane;
};

export class LaneNAdapter {
  readonly laneId = "lane-n";
  private readonly store: GraphStore;
  private readonly corpus: Corpus;
  private readonly vectors: CorpusVectors;
  private readonly execution: ExecutionPlane | null;
  private state: KnowledgeState;
  private readonly memoryLedger = new Map<string, CommandResponse>();

  private constructor(options: LaneNOptions, state: KnowledgeState) {
    this.store = options.store;
    this.corpus = options.corpus;
    this.vectors = options.vectors;
    this.execution = options.execution ?? null;
    this.state = state;
  }

  /** Async because the canonical snapshot has to be read out of the graph first. */
  static async open(options: LaneNOptions): Promise<LaneNAdapter> {
    const state = await options.store.load();
    return new LaneNAdapter(options, state);
  }

  versionOf(ref: Ref): string | null {
    return tokenFor(this.state, ref);
  }

  snapshot(): KnowledgeState {
    return this.state;
  }

  async reload(): Promise<void> {
    this.state = await this.store.load();
  }

  /**
   * The canonical point: a content digest over the whole graph snapshot.
   *
   * Not a transaction id and not an element id — neither survives a dump and
   * restore, and a canonical point that a recovery invalidates is worse than
   * none.
   */
  canonicalPoint(): string {
    return contentHash(this.neutral());
  }

  async profile(): Promise<CapabilityProfile> {
    const capabilities: Record<string, string> = {};
    for (const key of CAPABILITY_KEYS) capabilities[key] = "native";
    // Community Edition. Each of these is a real limit and each one moves an
    // invariant into the command service, where the report names it.
    capabilities.constraint_existence = "absent";
    capabilities.online_backup = "absent";
    capabilities.tombstone_enforcement = "emulated";
    capabilities.peer_segregation = "emulated";
    // Relationship uniqueness is emulated by a guard NODE, because Community
    // Edition has no relationship constraint. It works, and it is not native.
    capabilities.relationship_uniqueness = "emulated";
    // No vector index exists in this lane. Semantic retrieval is answered by the
    // SHARED in-memory fusion over frozen corpus vectors, exactly as in Lane M,
    // which is what makes the retrieval comparison fair — and what makes
    // claiming it as a native graph capability an overclaim.
    capabilities.vector_search = "emulated";
    return {
      laneId: this.laneId,
      contractVersion: CONTRACT_VERSION,
      capabilities: capabilities as CapabilityProfile["capabilities"],
      limits: { maxPathDepth: 16, maxResult: 500, maxExcerpt: 0 },
      atomicityByCommand: {
        CreateEntity: "A1",
        RegisterSourceRef: "A1",
        CreateClaim: "A1",
        CorrectClaim: "A1",
        SupersedeClaim: "A1",
        SummarizeClaims: "A1",
        MergeEntities: "A1",
        RetractClaim: "A3",
        PublishActivityRecord: "A3",
      },
      derivedStructures: ["graph.fulltext"],
    };
  }

  private documentText(sourceRefId: string, locator: string): string | null {
    const source = this.corpus.sources.find((entry) => entry.id === sourceRefId);
    if (!source) return null;
    const document = source.documents.find((entry) => entry.locator === locator);
    return document ? document.text : null;
  }

  async execute(request: CommandRequest): Promise<CommandResponse> {
    const replay = await this.replayOf(request);
    if (replay) return replay;

    const instant = tickToInstant(request.tick);
    const decision = decide(request, {
      state: this.state,
      instant,
      versionOf: (ref) => this.versionOf(ref),
      nodeId: "node.ada",
      documentText: (sourceRefId, locator) => this.documentText(sourceRefId, locator),
      contentHash,
    });

    if (decision.kind === "refused") {
      if (decision.ops && decision.ops.length > 0) {
        await this.store.apply(decision.ops);
        await this.reload();
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
    const priorTokens = new Map<string, string | null>();
    for (const effect of plan.effects) {
      priorTokens.set(`${effect.ref.kind}:${effect.ref.id}`, this.versionOf(effect.ref));
    }

    // The graph transaction needs no intent record: there is no torn canonical
    // state for one to describe, and that remains this lane's advantage.
    //
    // What DOES need one is the envelope. Publication and the idempotency
    // receipt are written after the transaction commits and in another store, so
    // an interruption between them leaves a committed knowledge effect with no
    // published record and no replay receipt. `A3` is defined as "failure leaves
    // a durable obligation rather than silent loss", and without this the lane
    // declared A3 while providing no carrier for the obligation.
    const intentId = `${request.tick}-${request.idempotency.key.slice(0, 8)}`;
    const needsObligation = plan.crossesBoundary;
    if (needsObligation && this.execution) {
      await this.execution.openIntent(
        intentId,
        request.command,
        plan.effects.map((effect) => `${effect.ref.kind}:${effect.ref.id}`),
        plan.ops,
        request.tick,
      );
    }

    try {
      await this.store.apply(plan.ops);
    } catch (error) {
      // A store rejection is a LANE RESULT, not a harness fault. Left
      // unhandled it escaped `execute` entirely, killed the subcommand before it
      // printed anything, and was then classified as a broken harness.
      if (error instanceof GraphWriteRejected) {
        const response = failureFor(error, request);
        await this.remember(request, response);
        return response;
      }
      throw error;
    }

    // Publication leaves the graph entirely, which is why it is A3 and why it
    // happens after the transaction rather than inside it.
    for (const op of plan.ops) {
      if (op.op === "publish-record") this.store.publishRecord(op.recordId, op.record);
    }

    await this.reload();

    const effects = plan.effects.map((effect) => ({
      ...effect,
      priorVersionToken: priorTokens.get(`${effect.ref.kind}:${effect.ref.id}`) ?? null,
      newVersionToken: this.versionOf(effect.ref),
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
        durabilityPoint: this.canonicalPoint(),
        actorSnapshot: request.actor,
        intentSnapshot: request.intent,
        guardSnapshot: request.guard,
        // Filtered to structures this lane actually has. The shared policy names
        // Lane M's projections, so an unfiltered copy made every Lane N receipt
        // claim an obligation on `projection.claim` — a structure that does not
        // exist here — while never naming the one that does.
        derivedObligations: this.obligationsFor(plan),
      },
      effects,
      warnings: [],
    };
    await this.remember(request, response);
    if (needsObligation && this.execution) await this.execution.completeIntent(intentId);
    return response;
  }

  /**
   * Obligations this lane can actually owe.
   *
   * The graph's fulltext index is maintained inside the same transaction, so it
   * never lags. What can lag is the coordination feed and a portable export,
   * because neither is reachable from a graph transaction.
   */
  private obligationsFor(plan: Plan): string[] {
    return plan.derivedObligations.filter(
      (name) => name === "coordination.publish" || name === "export",
    );
  }

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
    return runQuery(
      { ...request, constraint: { ...DEFAULT_CONSTRAINT, ...request.constraint } },
      {
        store: this.store,
        state: this.state,
        corpus: this.corpus,
        vectors: this.vectors,
        canonicalPoint: this.canonicalPoint(),
      },
    );
  }

  /**
   * Canonical state in neutral form, identical in shape to Lane M's export.
   *
   * Version tokens are omitted deliberately: they are per-lane by construction,
   * so including them would make two semantically identical exports compare
   * unequal and turn a portability check into a storage-format check.
   */
  private neutral(): Record<string, unknown> {
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
      // Peer payloads, candidates, and active contexts are CANONICAL state in
      // both lanes and were previously exported as bare keys or not at all — so
      // a restore silently dropped them and the round-trip comparison could not
      // notice, because it compared only what the importer could rebuild.
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

  async exportState(): Promise<Record<string, unknown>> {
    return this.neutral();
  }

  async close(): Promise<void> {
    await this.store.close();
  }
}
