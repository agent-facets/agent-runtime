// Lane N canonical store: a Neo4j property graph.
//
// Entities, claims, relationships, evidence, temporal history, and decisions are
// native graph objects rather than documents that happen to describe a graph.
// Three decisions carry most of the weight:
//
//   1. Typed relationships are REAL relationship types, not a generic `:RELATES`
//      carrying a `relType` property. A property-predicated traversal would have
//      handicapped this lane on precisely the question it exists to answer, so
//      the type is interpolated into the Cypher after being validated against a
//      strict pattern. The same is true of the depth bound: Cypher cannot
//      parameterise either, and refusing to interpolate would have meant
//      measuring a limitation of the driver rather than of the store.
//
//   2. Revisions are APPEND-ONLY nodes under a composite uniqueness constraint
//      on `(claimId, revision)`, written with CREATE. The naive guard — `MATCH …
//      WHERE c.rev = $expected SET …` — takes no write lock before the read, so
//      two writers both pass the predicate and one silently wins. A uniqueness
//      violation on insert is a real, storage-level rejection.
//
//      MERGE would defeat this completely, and did: MERGE matches the revision
//      another writer already committed and SETs over it, so the constraint can
//      never fire and the backstop degrades to the application check it exists to
//      replace. Community Edition offers node property uniqueness and nothing
//      else, so relationship revisions get the same protection through a guard
//      node — `:RelationshipRevisionKey` — created in the same transaction as the
//      edge. Emulated, and named as emulated, rather than assumed.
//
//   3. Version tokens are content digests over canonical state, never
//      `elementId`. An element id would not survive a dump and restore, so a
//      caller could guard a write against a value that a recovery invalidates.

import { createHash } from "node:crypto";

import neo4j from "neo4j-driver";
import type { Driver, ManagedTransaction, Session } from "neo4j-driver";

import type {
  ClaimRevision,
  ContradictionRecord,
  EntityRecord,
  EvidenceRecord,
  Ref,
  RelationshipRevision,
  ReviewDecisionRecord,
  SourceRefRecord,
} from "../knowledge/contract.ts";
import type { KnowledgeState, PlanOp } from "../knowledge/policy.ts";
import { emptyState } from "../knowledge/policy.ts";
import { publish, readAll } from "../coordination/sink.ts";

/** Cypher cannot parameterise a relationship type. Everything interpolated is validated first. */
const REL_TYPE_PATTERN = /^[a-z][a-z0-9_]{0,62}$/;

export function relTypeToLabel(relType: string): string {
  if (!REL_TYPE_PATTERN.test(relType)) {
    throw new Error(`unsafe relationship type: ${relType}`);
  }
  return relType.toUpperCase();
}

export function labelToRelType(label: string): string {
  return label.toLowerCase();
}

/**
 * Constraints available in Community Edition.
 *
 * Node property uniqueness only. Existence, property type, node key, and
 * relationship constraints are Enterprise, so every invariant they would have
 * enforced moves into the shared command service and is named in the report
 * rather than quietly assumed.
 */
const CONSTRAINTS: string[] = [
  "CREATE CONSTRAINT entity_id IF NOT EXISTS FOR (n:Entity) REQUIRE n.entityId IS UNIQUE",
  "CREATE CONSTRAINT source_id IF NOT EXISTS FOR (n:Source) REQUIRE n.sourceRefId IS UNIQUE",
  "CREATE CONSTRAINT evidence_id IF NOT EXISTS FOR (n:Evidence) REQUIRE n.evidenceId IS UNIQUE",
  "CREATE CONSTRAINT claim_id IF NOT EXISTS FOR (n:Claim) REQUIRE n.claimId IS UNIQUE",
  // The stale-write backstop. A second writer appending the same revision hits
  // this rather than overwriting the first. Only reachable because the revision
  // is written with CREATE.
  "CREATE CONSTRAINT claim_revision IF NOT EXISTS FOR (n:ClaimRevision) REQUIRE (n.claimId, n.revision) IS UNIQUE",
  // Community Edition has no relationship uniqueness constraint, so the same
  // backstop for a relationship revision is emulated by a guard NODE created in
  // the same transaction as the edge. Without it the edge write is the one
  // remaining place two writers could both claim revision N+1.
  "CREATE CONSTRAINT relationship_revision IF NOT EXISTS FOR (n:RelationshipRevisionKey) REQUIRE (n.relationshipId, n.revision) IS UNIQUE",
  "CREATE CONSTRAINT contradiction_id IF NOT EXISTS FOR (n:Contradiction) REQUIRE n.contradictionId IS UNIQUE",
  "CREATE CONSTRAINT decision_id IF NOT EXISTS FOR (n:Decision) REQUIRE n.decisionId IS UNIQUE",
  "CREATE CONSTRAINT peer_record_id IF NOT EXISTS FOR (n:PeerRecord) REQUIRE n.recordId IS UNIQUE",
  "CREATE CONSTRAINT candidate_id IF NOT EXISTS FOR (n:Candidate) REQUIRE n.candidateId IS UNIQUE",
  "CREATE CONSTRAINT context_id IF NOT EXISTS FOR (n:ActiveContext) REQUIRE n.activeContextId IS UNIQUE",
  "CREATE CONSTRAINT rejection_hash IF NOT EXISTS FOR (n:Rejection) REQUIRE n.contentHash IS UNIQUE",
];

const INDEXES: string[] = [
  "CREATE INDEX claim_subject IF NOT EXISTS FOR (n:ClaimRevision) ON (n.subject)",
  "CREATE INDEX claim_predicate IF NOT EXISTS FOR (n:ClaimRevision) ON (n.predicate)",
  "CREATE FULLTEXT INDEX claim_text IF NOT EXISTS FOR (n:ClaimRevision) ON EACH [n.value]",
];

function json(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function parse<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string") return fallback;
  try {
    const parsed = JSON.parse(value) as T;
    // `json()` serialises absent as the STRING "null", which parses back to a
    // successful `null`. Returning it would hand a caller a `null` typed as the
    // record it asked for, and the first property read would throw somewhere far
    // from here.
    return parsed === null ? fallback : parsed;
  } catch {
    return fallback;
  }
}

/**
 * A write the STORE rejected, as opposed to one the policy refused.
 *
 * Without this every constraint violation and every driver-level abort left
 * `execute` as an unhandled rejection, so the lane could emit no `failed`
 * outcome at all and a subcommand died printing nothing — a harness fault where
 * there was really a lane result. `applied` distinguishes "certainly nothing"
 * from "cannot tell", which is the difference the contract's `applied` field
 * exists to carry.
 */
export type GraphRejection = "duplicate_revision" | "duplicate_key" | "unavailable" | "incomplete";

export class GraphWriteRejected extends Error {
  readonly reason: GraphRejection;
  readonly applied: "no" | "unknown";
  readonly detail: string;

  constructor(reason: GraphRejection, applied: "no" | "unknown", detail: string) {
    super(`graph write rejected (${reason}): ${detail}`);
    this.name = "GraphWriteRejected";
    this.reason = reason;
    this.applied = applied;
    this.detail = detail;
  }
}

/** A statement that must change something, and what it means when it does not. */
type StatementGuard = { least: number; what: string };

type Statement = [string, Record<string, unknown>, StatementGuard?];

function neo4jCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : "";
}

function translateGraphError(error: unknown): unknown {
  if (error instanceof GraphWriteRejected) return error;
  const code = neo4jCode(error);
  const message = error instanceof Error ? error.message : String(error);
  if (code === "Neo.ClientError.Schema.ConstraintValidationFailed") {
    // The composite revision constraints are the stale-write backstop; every
    // other uniqueness constraint is a natural key.
    const duplicateRevision =
      /ClaimRevision|RelationshipRevisionKey|claimId.*revision|relationshipId.*revision/i.test(
        message,
      );
    return new GraphWriteRejected(
      duplicateRevision ? "duplicate_revision" : "duplicate_key",
      "no",
      message,
    );
  }
  if (
    code.startsWith("Neo.TransientError") ||
    code === "ServiceUnavailable" ||
    code === "SessionExpired"
  ) {
    return new GraphWriteRejected("unavailable", "unknown", message);
  }
  return error;
}

/**
 * Run one statement and refuse to let it silently write nothing.
 *
 * Cypher has no "fail if no rows": a `MATCH` that finds nothing yields zero rows
 * and every downstream `MERGE` performs zero operations, raising nothing. That
 * turns a missing endpoint, a missing source, or a missing claim into a commit
 * that reports success and changed no state — which is exactly how an erasure
 * can report `retracted` having erased nothing. Statements whose whole purpose
 * is to touch something therefore return a count, and this asserts it.
 */
async function runGuarded(
  tx: ManagedTransaction,
  [cypher, params, guard]: Statement,
  op: PlanOp,
): Promise<void> {
  const result = await tx.run(cypher, params);
  if (!guard) return;
  const affected = Number(result.records[0]?.get("affected") ?? 0);
  if (affected < guard.least) {
    throw new GraphWriteRejected(
      "incomplete",
      "no",
      `${op.op}: ${guard.what} affected ${affected}, expected at least ${guard.least}`,
    );
  }
}

export class GraphStore {
  private readonly driver: Driver;
  /** The vault path that holds SOURCE documents and the coordination feed. */
  readonly sourcesRoot: string;

  constructor(uri: string, sourcesRoot: string) {
    // No auth token at all, matching `NEO4J_AUTH=none` on the server. A
    // password would then have to be kept out of `docker inspect`, the driver's
    // argv, and every evidence file; the gateway-less unpublished network is
    // what makes omitting it defensible, and the evidence keeps saying so.
    this.driver = neo4j.driver(uri, undefined, {
      // Plain numbers rather than Integer objects, so a revision number that
      // reaches an answer is comparable without a conversion nobody remembers.
      disableLosslessIntegers: true,
      maxConnectionPoolSize: 8,
    });
    this.sourcesRoot = sourcesRoot;
  }

  session(): Session {
    return this.driver.session({ database: "neo4j" });
  }

  async close(): Promise<void> {
    await this.driver.close();
  }

  async waitForReady(timeoutMs: number, pollMs = 250): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let last: unknown = null;
    while (Date.now() < deadline) {
      const session = this.session();
      try {
        await session.run("RETURN 1");
        await session.close();
        return;
      } catch (error) {
        last = error;
        await session.close().catch(() => {});
        await new Promise((resolve) => setTimeout(resolve, pollMs));
      }
    }
    throw new Error(`neo4j not reachable within ${timeoutMs}ms: ${String(last)}`);
  }

  /**
   * Schema setup, run once by an elected migrator.
   *
   * Neo4j has no advisory-lock primitive, so Lane N borrows the same Postgres
   * election Lane M uses rather than inventing a weaker one. The unguarded form
   * stays measurable as its own paired case.
   */
  async setup(): Promise<{ constraints: number; indexes: number }> {
    const session = this.session();
    try {
      for (const statement of [...CONSTRAINTS, ...INDEXES]) {
        await session.run(statement);
      }
      await session.run("CALL db.awaitIndexes(30000)");
      return { constraints: CONSTRAINTS.length, indexes: INDEXES.length };
    } finally {
      await session.close();
    }
  }

  async constraintNames(): Promise<string[]> {
    const session = this.session();
    try {
      const result = await session.run("SHOW CONSTRAINTS YIELD name RETURN name ORDER BY name");
      return result.records.map((record) => String(record.get("name")));
    } finally {
      await session.close();
    }
  }

  // -------------------------------------------------------------------------
  // Applying a plan
  // -------------------------------------------------------------------------

  /**
   * Apply every op in ONE transaction.
   *
   * This is Lane N's structural advantage and it is reported as a measured
   * result, not normalised away: a multi-object plan either commits whole or
   * leaves nothing behind, so this lane needs no intent record and no
   * roll-forward repair.
   */
  /**
   * FAULT INJECTOR, the graph's counterpart to Lane M's.
   *
   * An abort raised INSIDE the transaction at the same point in the same plan,
   * so the rollback that follows is Neo4j's own rather than something this
   * harness arranged. It is deliberately NOT the same physical fault as Lane M's
   * — that one leaves durable bytes on disk, this one never leaves the
   * transaction — and the evidence says so rather than calling them equivalent.
   * What it measures is rollback on abort. It does not measure a killed process
   * and it does not measure power loss.
   *
   * `afterOps >= ops.length` is the PAIRED CONTROL and must commit. An injector
   * that can only ever abort cannot be its own control, and the criterion built
   * on it would pass without exercising this code at all.
   */
  async applyWithCrash(
    ops: PlanOp[],
    afterOps: number,
  ): Promise<{ applied: number; committed: boolean }> {
    const session = this.session();
    // Assigned inside the callback: a managed transaction may retry, and a count
    // that survived a retry would describe two attempts as one.
    let applied = 0;
    let committed = false;
    try {
      await session.executeWrite(async (tx) => {
        applied = 0;
        for (const op of ops) {
          if (applied >= afterOps) throw new Error("injected-crash");
          for (const statement of statementsFor(op, this.sourcesRoot)) {
            await runGuarded(tx, statement, op);
          }
          applied += 1;
        }
      });
      committed = true;
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("injected-crash")) {
        throw translateGraphError(error);
      }
    } finally {
      await session.close();
    }
    return { applied, committed };
  }

  /**
   * Apply every op in ONE transaction.
   *
   * This is Lane N's structural advantage and it is reported as a measured
   * result, not normalised away: a multi-object plan either commits whole or
   * leaves nothing behind, so this lane needs no intent record and no
   * roll-forward repair for canonical graph state.
   *
   * The boundary is the GRAPH. Publication and the idempotency receipt sit
   * outside it, which is why the commands that reach them are A3 and why the
   * adapter opens a durable obligation before it starts.
   */
  async apply(ops: PlanOp[]): Promise<void> {
    const session = this.session();
    try {
      await session.executeWrite(async (tx) => {
        for (const op of ops) {
          for (const statement of statementsFor(op, this.sourcesRoot)) {
            await runGuarded(tx, statement, op);
          }
        }
      });
    } catch (error) {
      throw translateGraphError(error);
    } finally {
      await session.close();
    }
  }

  // -------------------------------------------------------------------------
  // Materialising the neutral state snapshot
  // -------------------------------------------------------------------------

  /**
   * Materialise the neutral snapshot inside ONE read transaction.
   *
   * Eleven auto-commit reads are eleven independent snapshots: under any
   * concurrent writer this could observe sources from before a commit and claims
   * from after it. Every guard token, every policy decision, and the canonical
   * point are all computed from this state, and a guard evaluated against a torn
   * read guards a state that never existed.
   */
  async load(): Promise<KnowledgeState> {
    const state = emptyState();
    const session = this.session();
    try {
      await session.executeRead(async (tx) => {
      const sources = await tx.run("MATCH (n:Source) RETURN n ORDER BY n.sourceRefId");
      for (const record of sources.records) {
        const node = record.get("n").properties as Record<string, unknown>;
        state.sources.set(String(node.sourceRefId), {
          sourceRefId: String(node.sourceRefId),
          system: String(node.system),
          externalId: String(node.externalId),
          uri: (node.uri as string | null) ?? null,
          contentHash: (node.contentHash as string | null) ?? null,
          sourceAuthority: node.sourceAuthority as SourceRefRecord["sourceAuthority"],
          publisherNodeId: (node.publisherNodeId as string | null) ?? null,
          sensitivity: node.sensitivity as SourceRefRecord["sensitivity"],
          visibility: node.visibility as SourceRefRecord["visibility"],
        });
      }

      const entities = await tx.run("MATCH (n:Entity) RETURN n ORDER BY n.entityId");
      for (const record of entities.records) {
        const node = record.get("n").properties as Record<string, unknown>;
        state.entities.set(String(node.entityId), {
          entityId: String(node.entityId),
          kind: node.kind as EntityRecord["kind"],
          canonicalName: String(node.canonicalName),
          aliases: parse<string[]>(node.aliases, []),
          mergedInto: (node.mergedInto as string | null) ?? null,
          sensitivity: node.sensitivity as EntityRecord["sensitivity"],
          visibility: node.visibility as EntityRecord["visibility"],
          versionToken: "",
        });
      }

      const evidence = await tx.run("MATCH (n:Evidence) RETURN n ORDER BY n.evidenceId");
      for (const record of evidence.records) {
        const node = record.get("n").properties as Record<string, unknown>;
        state.evidence.set(String(node.evidenceId), {
          evidenceId: String(node.evidenceId),
          sourceRefId: String(node.sourceRefId),
          excerpt: null,
          excerptHash: String(node.excerptHash),
          locator: String(node.locator),
          observedBy: parse<EvidenceRecord["observedBy"]>(node.observedBy, {
            originKind: "system_derivation",
            authority: "corroborating",
            actorId: "",
            publisherNodeId: null,
            at: "",
          }),
          strength: node.strength as EvidenceRecord["strength"],
          sensitivity: node.sensitivity as EvidenceRecord["sensitivity"],
          redactionState: node.redactionState as EvidenceRecord["redactionState"],
        });
      }

      const claims = await tx.run(
        "MATCH (n:ClaimRevision) RETURN n ORDER BY n.claimId, n.revision",
      );
      for (const record of claims.records) {
        const node = record.get("n").properties as Record<string, unknown>;
        const claimId = String(node.claimId);
        const revision: ClaimRevision = {
          claimId,
          revision: Number(node.revision),
          subject: String(node.subject),
          predicate: String(node.predicate),
          value: String(node.value ?? ""),
          scope: String(node.scope),
          valid: {
            from: (node.validFrom as string | null) ?? null,
            to: (node.validTo as string | null) ?? null,
          },
          assertedAt: String(node.assertedAt),
          assertedUntil: (node.assertedUntil as string | null) ?? null,
          closureReason: (node.closureReason as ClaimRevision["closureReason"]) ?? null,
          belief: node.belief as ClaimRevision["belief"],
          canon: Boolean(node.canon),
          origin: parse<ClaimRevision["origin"]>(node.origin, {
            originKind: "system_derivation",
            authority: "corroborating",
            actorId: "",
            publisherNodeId: null,
            at: "",
          }),
          evidenceIds: parse<string[]>(node.evidenceIds, []),
          derivedFrom: parse<string[]>(node.derivedFrom, []),
          supersedes: parse<ClaimRevision["supersedes"]>(node.supersedes, null),
          supersededBy: null,
          sensitivity: node.sensitivity as ClaimRevision["sensitivity"],
          visibility: node.visibility as ClaimRevision["visibility"],
          redactionState: node.redactionState as ClaimRevision["redactionState"],
          versionToken: "",
        };
        const existing = state.claims.get(claimId) ?? [];
        existing.push(revision);
        state.claims.set(claimId, existing);
      }

      // Domain relationships carry a `relationshipId`; structural ones do not.
      // The merge redirect `:MERGED_INTO` also connects two entities, so a
      // label-blind Entity-to-Entity match would load it as a seventh typed
      // relationship the contract never asserted.
      const relationships = await tx.run(
        `MATCH (a:Entity)-[r]->(b:Entity)
         WHERE r.relationshipId IS NOT NULL
         RETURN a, r, b, type(r) AS t ORDER BY r.relationshipId, r.revision`,
      );
      for (const record of relationships.records) {
        const edge = record.get("r").properties as Record<string, unknown>;
        const relationshipId = String(edge.relationshipId);
        const revision: RelationshipRevision = {
          relationshipId,
          revision: Number(edge.revision),
          from: String(edge.fromId),
          relType: labelToRelType(String(record.get("t"))),
          to: String(edge.toId),
          directed: true,
          valid: {
            from: (edge.validFrom as string | null) ?? null,
            to: (edge.validTo as string | null) ?? null,
          },
          assertedAt: String(edge.assertedAt),
          assertedUntil: (edge.assertedUntil as string | null) ?? null,
          closureReason: (edge.closureReason as RelationshipRevision["closureReason"]) ?? null,
          belief: edge.belief as RelationshipRevision["belief"],
          origin: parse<RelationshipRevision["origin"]>(edge.origin, {
            originKind: "system_derivation",
            authority: "corroborating",
            actorId: "",
            publisherNodeId: null,
            at: "",
          }),
          evidenceIds: parse<string[]>(edge.evidenceIds, []),
          sensitivity: edge.sensitivity as RelationshipRevision["sensitivity"],
          versionToken: "",
        };
        const existing = state.relationships.get(relationshipId) ?? [];
        existing.push(revision);
        state.relationships.set(relationshipId, existing);
      }

      const contradictions = await tx.run(
        "MATCH (n:Contradiction) RETURN n ORDER BY n.contradictionId",
      );
      for (const record of contradictions.records) {
        const node = record.get("n").properties as Record<string, unknown>;
        state.contradictions.set(String(node.contradictionId), {
          contradictionId: String(node.contradictionId),
          members: parse<ContradictionRecord["members"]>(node.members, []),
          peerMembers: parse<string[]>(node.peerMembers, []),
          detectedAt: String(node.detectedAt),
          detectedBy: parse<ContradictionRecord["detectedBy"]>(node.detectedBy, {
            originKind: "system_derivation",
            authority: "corroborating",
            actorId: "",
            publisherNodeId: null,
            at: "",
          }),
          basis: node.basis as ContradictionRecord["basis"],
          resolution: parse<ContradictionRecord["resolution"]>(node.resolution, null),
        });
      }

      const decisions = await tx.run("MATCH (n:Decision) RETURN n ORDER BY n.decisionId");
      for (const record of decisions.records) {
        const node = record.get("n").properties as Record<string, unknown>;
        state.decisions.set(String(node.decisionId), {
          decisionId: String(node.decisionId),
          outcome: node.outcome as ReviewDecisionRecord["outcome"],
          targets: parse<ReviewDecisionRecord["targets"]>(node.targets, []),
          rationale: String(node.rationale ?? ""),
          decidedBy: String(node.decidedBy),
          decidedByClass: node.decidedByClass as ReviewDecisionRecord["decidedByClass"],
          decidedAt: String(node.decidedAt),
          observedStateHash: String(node.observedStateHash),
          applicationResult: (node.applicationResult as ReviewDecisionRecord["applicationResult"]) ?? null,
        });
      }

      const peers = await tx.run("MATCH (n:PeerRecord) RETURN n ORDER BY n.recordId");
      for (const record of peers.records) {
        const node = record.get("n").properties as Record<string, unknown>;
        state.peerRecords.set(String(node.recordId), parse<Record<string, unknown>>(node.payload, {}));
      }

      const candidates = await tx.run("MATCH (n:Candidate) RETURN n ORDER BY n.candidateId");
      for (const record of candidates.records) {
        const node = record.get("n").properties as Record<string, unknown>;
        state.candidates.set(String(node.candidateId), {
          candidateId: String(node.candidateId),
          recordId: String(node.recordId),
          status: "unreviewed",
        });
      }

      const contexts = await tx.run(
        "MATCH (n:ActiveContext) RETURN n ORDER BY n.activeContextId",
      );
      for (const record of contexts.records) {
        const node = record.get("n").properties as Record<string, unknown>;
        state.activeContexts.set(
          String(node.activeContextId),
          parse<Record<string, unknown>>(node.payload, {}),
        );
      }

      const rejections = await tx.run(
        "MATCH (n:Rejection) RETURN n ORDER BY n.contentHash",
      );
      for (const record of rejections.records) {
        const node = record.get("n").properties as Record<string, unknown>;
        state.rejections.push({
          reason: String(node.reason),
          sourceRefId: String(node.sourceRefId),
          decidedAt: String(node.decidedAt ?? ""),
          contentHash: String(node.contentHash),
        });
      }
      });
    } finally {
      await session.close();
    }

    // The coordination feed lives on the filesystem in BOTH lanes. It is not
    // graph truth, and putting it in the graph would have made a peer report
    // one traversal away from a claim.
    for (const [key, record] of readAll(this.sourcesRoot)) state.published.set(key, record);

    return state;
  }

  publishRecord(recordId: string, record: Record<string, unknown>): void {
    publish(this.sourcesRoot, recordId, record);
  }

  /**
   * The graph's STRUCTURE, which the neutral export cannot see.
   *
   * `load()` reads node and relationship PROPERTIES and rebuilds lineage from
   * JSON strings, so every structural edge is invisible to the export digest:
   * delete every `:EVIDENCED_BY` and the export still compares byte-identical
   * while provenance and path answers break. A restore that reproduces the
   * properties and none of the edges therefore passed the round-trip check.
   * These counts are what make that detectable.
   */
  async edgeCounts(): Promise<Record<string, number>> {
    const session = this.session();
    try {
      return await session.executeRead(async (tx) => {
        const result = await tx.run(
          `RETURN
             COUNT { MATCH (:Claim)-[:HAS_REVISION]->(:ClaimRevision) }        AS hasRevision,
             COUNT { MATCH (:ClaimRevision)-[:ABOUT]->(:Entity) }              AS about,
             COUNT { MATCH (:ClaimRevision)-[:EVIDENCED_BY]->(:Evidence) }     AS evidencedBy,
             COUNT { MATCH (:ClaimRevision)-[:DERIVED_FROM]->(:Claim) }        AS derivedFrom,
             COUNT { MATCH (:Evidence)-[:FROM_SOURCE]->(:Source) }             AS fromSource,
             COUNT { MATCH (:Entity)-[:MERGED_INTO]->(:Entity) }               AS mergedInto,
             COUNT { MATCH (:Candidate)-[:FROM_REPORT]->(:PeerRecord) }        AS fromReport`,
        );
        const row = result.records[0];
        if (!row) throw new Error("edge-count query returned no row");
        const out: Record<string, number> = {};
        for (const key of row.keys) out[String(key)] = Number(row.get(key));
        return out;
      });
    } finally {
      await session.close();
    }
  }

  /** Delete one structural edge, for the structural comparison's negative control. */
  async dropOneEvidenceEdge(): Promise<number> {
    const session = this.session();
    try {
      return await session.executeWrite(async (tx) => {
        const result = await tx.run(
          `MATCH (:ClaimRevision)-[r:EVIDENCED_BY]->(:Evidence)
           WITH r LIMIT 1 DELETE r RETURN count(*) AS dropped`,
        );
        return Number(result.records[0]?.get("dropped") ?? 0);
      });
    } finally {
      await session.close();
    }
  }
}

/**
 * Version tokens, derived from canonical state alone.
 *
 * Never `elementId`: an internal id does not survive a dump and restore, so a
 * caller could guard a write against a value a recovery silently invalidates.
 * The token omits itself, or the digest would have to contain its own input.
 */
export function tokenFor(state: KnowledgeState, ref: Ref): string | null {
  const strip = (value: unknown): unknown =>
    JSON.parse(JSON.stringify(value, (key, entry) => (key === "versionToken" ? undefined : entry)));

  switch (ref.kind) {
    case "entity": {
      const record = state.entities.get(ref.id);
      return record ? digestOf(strip(record)) : null;
    }
    case "claim": {
      const revisions = state.claims.get(ref.id);
      return revisions ? digestOf(strip(revisions)) : null;
    }
    case "relationship": {
      const revisions = state.relationships.get(ref.id);
      return revisions ? digestOf(strip(revisions)) : null;
    }
    case "source": {
      const record = state.sources.get(ref.id);
      return record ? digestOf(record) : null;
    }
    case "contradiction": {
      const record = state.contradictions.get(ref.id);
      return record ? digestOf(record) : null;
    }
    default:
      return null;
  }
}

function digestOf(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** Cypher for one plan op. Several ops need more than one statement. */
function statementsFor(op: PlanOp, sourcesRoot: string): Statement[] {
  switch (op.op) {
    case "put-source":
      return [
        [
          `MERGE (n:Source {sourceRefId: $id})
           SET n.system = $system, n.externalId = $externalId, n.uri = $uri,
               n.contentHash = $contentHash, n.sourceAuthority = $sourceAuthority,
               n.publisherNodeId = $publisherNodeId, n.sensitivity = $sensitivity,
               n.visibility = $visibility`,
          {
            id: op.record.sourceRefId,
            system: op.record.system,
            externalId: op.record.externalId,
            uri: op.record.uri,
            contentHash: op.record.contentHash,
            sourceAuthority: op.record.sourceAuthority,
            publisherNodeId: op.record.publisherNodeId,
            sensitivity: op.record.sensitivity,
            visibility: op.record.visibility,
          },
        ],
      ];

    case "put-entity":
      return [
        [
          // CREATE when the plan asserts this entity is new, so the uniqueness
          // constraint — not an in-memory snapshot two writers both read — is
          // what rejects a duplicate.
          op.mustBeNew
            ? `CREATE (n:Entity {entityId: $id})
           SET n.kind = $kind, n.canonicalName = $canonicalName, n.aliases = $aliases,
               n.mergedInto = $mergedInto, n.sensitivity = $sensitivity, n.visibility = $visibility`
            : `MERGE (n:Entity {entityId: $id})
           SET n.kind = $kind, n.canonicalName = $canonicalName, n.aliases = $aliases,
               n.mergedInto = $mergedInto, n.sensitivity = $sensitivity, n.visibility = $visibility`,
          {
            id: op.record.entityId,
            kind: op.record.kind,
            canonicalName: op.record.canonicalName,
            aliases: json(op.record.aliases),
            mergedInto: op.record.mergedInto,
            sensitivity: op.record.sensitivity,
            visibility: op.record.visibility,
          },
        ],
        // Merge as a graph edge as well as a property, so the redirect is
        // traversable rather than only readable.
        ...(op.record.mergedInto
          ? ([
              [
                `MATCH (a:Entity {entityId: $id}), (b:Entity {entityId: $survivor})
                 MERGE (a)-[:MERGED_INTO]->(b)`,
                { id: op.record.entityId, survivor: op.record.mergedInto },
              ],
            ] as Array<[string, Record<string, unknown>]>)
          : []),
      ];

    case "put-evidence":
      return [
        [
          `MERGE (n:Evidence {evidenceId: $id})
           SET n.sourceRefId = $sourceRefId, n.excerptHash = $excerptHash, n.locator = $locator,
               n.observedBy = $observedBy, n.strength = $strength, n.sensitivity = $sensitivity,
               n.redactionState = $redactionState`,
          {
            id: op.record.evidenceId,
            sourceRefId: op.record.sourceRefId,
            excerptHash: op.record.excerptHash,
            locator: op.record.locator,
            observedBy: json(op.record.observedBy),
            strength: op.record.strength,
            sensitivity: op.record.sensitivity,
            redactionState: op.record.redactionState,
          },
        ],
        // Separated and guarded. Chained onto the MERGE above it, a missing
        // source produced zero rows and the evidence node committed with no
        // provenance edge — a claim that reaches nothing, reported as written.
        [
          `MATCH (n:Evidence {evidenceId: $id})
           MATCH (s:Source {sourceRefId: $sourceRefId})
           MERGE (n)-[:FROM_SOURCE]->(s)
           RETURN count(*) AS affected`,
          { id: op.record.evidenceId, sourceRefId: op.record.sourceRefId },
          { least: 1, what: "evidence to source link" },
        ],
      ];

    case "ensure-claim":
      return [
        [`MERGE (c:Claim {claimId: $claimId})`, { claimId: op.claimId }],
      ];

    case "append-claim-revision": {
      const revision = op.revision;
      return [
        [
          // CREATE, not MERGE, on the revision: the composite uniqueness
          // constraint is the stale-write backstop, and MERGE would quietly
          // adopt a revision another writer had already created.
          `MERGE (c:Claim {claimId: $claimId})
           WITH c
           CREATE (r:ClaimRevision {claimId: $claimId, revision: $revision})
           SET r.subject = $subject, r.predicate = $predicate, r.value = $value,
               r.scope = $scope, r.validFrom = $validFrom, r.validTo = $validTo,
               r.assertedAt = $assertedAt,
               r.assertedUntil = $assertedUntil, r.closureReason = $closureReason,
               r.belief = $belief, r.canon = $canon, r.origin = $origin,
               r.evidenceIds = $evidenceIds, r.derivedFrom = $derivedFrom,
               r.supersedes = $supersedes, r.sensitivity = $sensitivity,
               r.visibility = $visibility, r.redactionState = $redactionState
           MERGE (c)-[:HAS_REVISION]->(r)`,
          {
            claimId: revision.claimId,
            revision: revision.revision,
            subject: revision.subject,
            predicate: revision.predicate,
            value: revision.value,
            scope: revision.scope,
            // Stored as two queryable properties rather than one JSON blob, so a
            // temporal predicate is a real graph predicate the planner can use
            // rather than a string this lane would have to parse in memory.
            validFrom: revision.valid.from,
            validTo: revision.valid.to,
            assertedAt: revision.assertedAt,
            assertedUntil: revision.assertedUntil,
            closureReason: revision.closureReason,
            belief: revision.belief,
            canon: revision.canon,
            origin: json(revision.origin),
            evidenceIds: json(revision.evidenceIds),
            derivedFrom: json(revision.derivedFrom),
            supersedes: json(revision.supersedes),
            sensitivity: revision.sensitivity,
            visibility: revision.visibility,
            redactionState: revision.redactionState,
          },
        ],
        // The three edge statements are guarded against their DECLARED counts.
        // These are the graph structure the provenance and path questions
        // traverse, and they are invisible to a property-bag export comparison:
        // drop every `:EVIDENCED_BY` and the neutral digest is unchanged while
        // provenance answers break.
        [
          `MATCH (r:ClaimRevision {claimId: $claimId, revision: $revision})
           MATCH (e:Entity {entityId: $subject})
           MERGE (r)-[:ABOUT]->(e)
           RETURN count(*) AS affected`,
          { claimId: revision.claimId, revision: revision.revision, subject: revision.subject },
          { least: 1, what: "claim revision to subject entity link" },
        ],
        [
          `MATCH (r:ClaimRevision {claimId: $claimId, revision: $revision})
           UNWIND $evidenceIds AS eid
           MATCH (e:Evidence {evidenceId: eid})
           MERGE (r)-[:EVIDENCED_BY]->(e)
           RETURN count(*) AS affected`,
          {
            claimId: revision.claimId,
            revision: revision.revision,
            evidenceIds: revision.evidenceIds,
          },
          { least: revision.evidenceIds.length, what: "claim revision to evidence links" },
        ],
        [
          `MATCH (r:ClaimRevision {claimId: $claimId, revision: $revision})
           UNWIND $derivedFrom AS did
           MATCH (c:Claim {claimId: did})
           MERGE (r)-[:DERIVED_FROM]->(c)
           RETURN count(*) AS affected`,
          {
            claimId: revision.claimId,
            revision: revision.revision,
            derivedFrom: revision.derivedFrom,
          },
          { least: revision.derivedFrom.length, what: "claim revision derivation links" },
        ],
      ];
    }

    case "close-claim-revision":
      return [
        [
          // `coalesce` carries the whole progression/correction distinction:
          // world progression narrows the prior revision's world interval, a
          // correction leaves it untouched so the new value answers for the same
          // stretch of time and the old belief survives only in history.
          `MATCH (r:ClaimRevision {claimId: $claimId, revision: $revision})
           SET r.assertedUntil = $until, r.closureReason = $reason, r.belief = 'superseded',
               r.validTo = coalesce($narrowValidTo, r.validTo)
           RETURN count(*) AS affected`,
          {
            claimId: op.claimId,
            revision: op.revision,
            until: op.until,
            reason: op.reason,
            narrowValidTo: op.narrowValidTo,
          },
          { least: 1, what: "predecessor revision closure" },
        ],
      ];

    case "append-relationship-revision": {
      const revision = op.revision;
      const label = relTypeToLabel(revision.relType);
      return [
        // The guard node FIRST, so the uniqueness constraint decides before any
        // edge is written. Community Edition has no relationship constraint, so
        // without this a second writer claiming the same revision would simply
        // get a second edge and `load()` would report two revisions with one
        // number — a lost update wearing a duplicate's clothes.
        [
          `CREATE (k:RelationshipRevisionKey {relationshipId: $relationshipId, revision: $revision})
           RETURN count(k) AS affected`,
          { relationshipId: revision.relationshipId, revision: revision.revision },
          { least: 1, what: "relationship revision key" },
        ],
        [
          `MATCH (a:Entity {entityId: $from}), (b:Entity {entityId: $to})
           CREATE (a)-[r:${label} {relationshipId: $relationshipId, revision: $revision}]->(b)
           SET r.fromId = $from, r.toId = $to, r.validFrom = $validFrom, r.validTo = $validTo,
               r.assertedAt = $assertedAt,
               r.assertedUntil = $assertedUntil, r.closureReason = $closureReason,
               r.belief = $belief, r.origin = $origin, r.evidenceIds = $evidenceIds,
               r.sensitivity = $sensitivity
           RETURN count(r) AS affected`,
          {
            from: revision.from,
            to: revision.to,
            relationshipId: revision.relationshipId,
            revision: revision.revision,
            validFrom: revision.valid.from,
            validTo: revision.valid.to,
            assertedAt: revision.assertedAt,
            assertedUntil: revision.assertedUntil,
            closureReason: revision.closureReason,
            belief: revision.belief,
            origin: json(revision.origin),
            evidenceIds: json(revision.evidenceIds),
            sensitivity: revision.sensitivity,
          },
          // Both endpoints must exist. Unguarded, a missing endpoint dropped the
          // whole relationship revision and reported a commit.
          { least: 1, what: "relationship revision edge" },
        ],
      ];
    }

    case "close-relationship-revision":
      return [
        [
          // `r.relationshipId IS NOT NULL` keeps this off the structural edges
          // for the same reason the load query carries it: an untyped pattern
          // would also match a `:MERGED_INTO` redirect that happened to carry
          // these properties.
          `MATCH (:Entity)-[r {relationshipId: $relationshipId, revision: $revision}]->(:Entity)
           WHERE r.relationshipId IS NOT NULL
           SET r.assertedUntil = $until, r.closureReason = $reason, r.validTo = $validTo
           RETURN count(*) AS affected`,
          {
            relationshipId: op.relationshipId,
            revision: op.revision,
            until: op.until,
            reason: op.reason,
            validTo: op.validTo,
          },
          { least: 1, what: "relationship revision closure" },
        ],
      ];

    case "put-contradiction":
      return [
        [
          `MERGE (n:Contradiction {contradictionId: $id})
           SET n.members = $members, n.peerMembers = $peerMembers, n.detectedAt = $detectedAt,
               n.detectedBy = $detectedBy, n.basis = $basis, n.resolution = $resolution`,
          {
            id: op.record.contradictionId,
            members: json(op.record.members),
            peerMembers: json(op.record.peerMembers),
            detectedAt: op.record.detectedAt,
            detectedBy: json(op.record.detectedBy),
            basis: op.record.basis,
            // A genuine graph NULL, not the string "null". Serialising the
            // absent case would make `IS NULL` false for every unresolved
            // conflict, and the open-conflicts question would answer empty while
            // the conflict sat there unresolved.
            resolution: op.record.resolution === null ? null : json(op.record.resolution),
          },
        ],
      ];

    case "put-decision":
      return [
        [
          `MERGE (n:Decision {decisionId: $id})
           SET n.outcome = $outcome, n.targets = $targets, n.rationale = $rationale,
               n.decidedBy = $decidedBy, n.decidedByClass = $decidedByClass,
               n.decidedAt = $decidedAt,
               n.observedStateHash = $observedStateHash, n.applicationResult = $applicationResult`,
          {
            id: op.record.decisionId,
            outcome: op.record.outcome,
            targets: json(op.record.targets),
            rationale: op.record.rationale,
            decidedBy: op.record.decidedBy,
            decidedByClass: op.record.decidedByClass,
            decidedAt: op.record.decidedAt,
            observedStateHash: op.record.observedStateHash,
            applicationResult: op.record.applicationResult,
          },
        ],
      ];

    case "set-canon":
      return [
        [
          `MATCH (r:ClaimRevision {claimId: $claimId, revision: $revision}) SET r.canon = $canon
           RETURN count(*) AS affected`,
          { claimId: op.claimId, revision: op.revision, canon: op.canon },
          { least: 1, what: "canon flag" },
        ],
      ];

    case "purge-claim-content":
      // Erasure reaches EVERY prior revision and the evidence excerpts. Ids,
      // lineage, intervals, and hashes survive so the record stays auditable.
      //
      // Guarded hardest of all: an unguarded erasure against an absent claim
      // erased nothing and still reported `retracted` with an export obligation.
      // A retraction that silently erases nothing is the worst possible thing to
      // report as done.
      return [
        [
          `MATCH (r:ClaimRevision {claimId: $claimId})
           SET r.value = '', r.redactionState = 'purged'
           WITH collect(r) AS revisions
           UNWIND revisions AS r
           OPTIONAL MATCH (r)-[:EVIDENCED_BY]->(e:Evidence)
           SET e.redactionState = 'purged'
           RETURN count(DISTINCT r) AS affected`,
          { claimId: op.claimId },
          { least: 1, what: "claim content erasure" },
        ],
      ];

    case "put-peer-record":
      return [
        [
          // Quarantined by label. A `:PeerRecord` is not a `:Claim` and there is
          // no statement anywhere that turns one into the other.
          `MERGE (n:PeerRecord {recordId: $id})
           SET n.publisherNodeId = $publisher, n.payload = $payload`,
          {
            id: op.recordId,
            publisher: (op.record as { publisherNodeId?: string }).publisherNodeId ?? "",
            payload: json(op.record),
          },
        ],
      ];

    case "put-candidate":
      return [
        [
          `MERGE (n:Candidate {candidateId: $id})
           SET n.recordId = $recordId, n.status = 'unreviewed'`,
          { id: op.candidateId, recordId: op.recordId },
        ],
        [
          `MATCH (n:Candidate {candidateId: $id})
           MATCH (p:PeerRecord {recordId: $recordId})
           MERGE (n)-[:FROM_REPORT]->(p)
           RETURN count(*) AS affected`,
          { id: op.candidateId, recordId: op.recordId },
          { least: 1, what: "candidate to peer report link" },
        ],
      ];

    case "put-active-context":
      return [
        [
          `MERGE (n:ActiveContext {activeContextId: $id}) SET n.payload = $payload`,
          { id: op.activeContextId, payload: json(op.record) },
        ],
      ];

    case "publish-record":
      // Handled by the coordination sink, outside the graph entirely.
      return [];

    case "record-rejection":
      return [
        [
          `MERGE (n:Rejection {contentHash: $contentHash})
           SET n.reason = $reason, n.sourceRefId = $sourceRefId, n.decidedAt = $decidedAt`,
          {
            contentHash: op.contentHash,
            reason: op.reason,
            sourceRefId: op.sourceRefId,
            decidedAt: op.decidedAt,
          },
        ],
      ];
  }
}
