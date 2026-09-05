// Lane N's read surface, in Cypher.
//
// Deliberately NOT a reuse of Lane M's traversal. How well a property graph
// answers a graph-shaped, temporal, provenance-carrying question is the thing
// being measured, and answering it by loading the whole store into memory and
// walking it in TypeScript would have measured this harness instead. The
// structural questions — reachability, depth, alias resolution, provenance
// closure — run as real Cypher against real relationships.
//
// The questions that are NOT graph-shaped (audits, work items, coordination,
// hybrid ranking over frozen vectors) are answered the same way in both lanes,
// because a difference there would be a difference in arithmetic rather than in
// storage, and inventing one would be manufacturing a result.

import { asSet } from "../canonical.ts";
import { SENSITIVE_CANARY } from "../evidence.ts";
import type {
  FreshnessBlock,
  Id,
  QueryRequest,
  QueryResponse,
  ReadConstraint,
} from "../knowledge/contract.ts";
import { CONTRACT_VERSION } from "../knowledge/contract.ts";
import type { KnowledgeState } from "../knowledge/policy.ts";
import { resolveEntity } from "../knowledge/policy.ts";
import type { Corpus, CorpusVectors } from "../corpus.ts";
import { DEFAULT_CONSTRAINT, resolveInstant, query as sharedQuery } from "../lane-m/queries.ts";
import type { ReadContext as SharedReadContext } from "../lane-m/queries.ts";
import { relTypeToLabel } from "./graph.ts";
import type { GraphStore } from "./graph.ts";

export type GraphReadContext = {
  store: GraphStore;
  state: KnowledgeState;
  corpus: Corpus;
  vectors: CorpusVectors;
  canonicalPoint: string;
};

/**
 * Lane N is canonical and has no projection behind it, so a canonical read is
 * the only kind it performs. `projectionWatermark: null` is the honest value —
 * this lane has nothing that can lag.
 */
function freshness(context: GraphReadContext): FreshnessBlock {
  return {
    servedFrom: "canonical",
    canonicalPoint: context.canonicalPoint,
    projectionWatermark: null,
    lagMs: null,
    staleness: "fresh",
    degradedFields: [],
    rebuildPending: false,
  };
}

function ok(data: unknown, block: FreshnessBlock, truncated = false): QueryResponse {
  return { outcome: "ok", contractVersion: CONTRACT_VERSION, freshness: block, data, truncated };
}

function shared(context: GraphReadContext): SharedReadContext {
  return {
    state: context.state,
    corpus: context.corpus,
    vectors: context.vectors,
    canonicalPoint: context.canonicalPoint,
    // A canonical store with no derived structure is FRESH, not unknown: there
    // is nothing behind it that could be stale.
    freshness: {
      scope: "all",
      projectionWatermark: context.canonicalPoint,
      builtAtTick: 0,
      rebuildPending: false,
      degradedFields: [],
    },
  };
}

export async function query(
  request: QueryRequest,
  context: GraphReadContext,
): Promise<QueryResponse> {
  const constraint: ReadConstraint = { ...DEFAULT_CONSTRAINT, ...request.constraint };
  const args = request.args;
  const block = freshness(context);

  switch (request.query) {
    case "CurrentClaims": {
      // Head revision by `max(revision)`, not by an open transaction interval:
      // retraction, summarisation, and reinforcement all append without closing
      // their predecessor, so an openness test returns two live rows per claim.
      const subject = String(args.subject);
      const resolved = resolveEntity(context.state, subject)?.entityId ?? subject;
      const session = context.store.session();
      try {
        const result = await session.run(
          `MATCH (e:Entity {entityId: $subject})
           OPTIONAL MATCH (start:Entity)-[:MERGED_INTO*0..]->(e)
           WITH collect(DISTINCT coalesce(start.entityId, e.entityId)) AS ids
           MATCH (c:Claim)-[:HAS_REVISION]->(r:ClaimRevision)
           WHERE r.subject IN ids
           WITH c, max(r.revision) AS headRev, ids
           MATCH (c)-[:HAS_REVISION]->(h:ClaimRevision {revision: headRev})
           WHERE h.belief <> 'retracted' AND h.belief <> 'rejected'
             AND h.redactionState <> 'purged'
             AND ($includeSummarized OR h.belief <> 'summarized')
             AND ($includeDisputed OR h.belief <> 'disputed')
           RETURN h ORDER BY h.claimId`,
          {
            subject: resolved,
            includeSummarized: constraint.includeSummarized,
            includeDisputed: constraint.includeDisputed,
          },
        );
        return ok({ claims: result.records.map((record) => summarise(record.get("h").properties)) }, block);
      } finally {
        await session.close();
      }
    }

    case "ClaimsAsOf": {
      const subject = String(args.subject);
      const resolved = resolveEntity(context.state, subject)?.entityId ?? subject;
      const at = resolveInstant(constraint.asOfValid);
      if (at === null) return refused("TEMPORAL_INVALID", "asOfValid is required");
      const session = context.store.session();
      try {
        // World time. A revision answers for an instant when its valid interval
        // contains it and belief in it did not end because we were WRONG about
        // that same interval — so `corrected` is excluded and `world_progressed`
        // is not.
        const result = await session.run(
          `MATCH (c:Claim)-[:HAS_REVISION]->(r:ClaimRevision)
           WHERE r.subject = $subject
             AND ($predicate IS NULL OR r.predicate = $predicate)
             AND (r.validFrom IS NULL OR r.validFrom <= $at)
             AND (r.validTo IS NULL OR r.validTo > $at)
             AND NOT coalesce(r.closureReason, '') IN ['corrected', 'retracted', 'rejected']
           WITH c, max(r.revision) AS pick
           MATCH (c)-[:HAS_REVISION]->(a:ClaimRevision {revision: pick})
           WITH c, a
           MATCH (c)-[:HAS_REVISION]->(any:ClaimRevision)
           WITH c, a, max(any.revision) AS headRev
           MATCH (c)-[:HAS_REVISION]->(h:ClaimRevision {revision: headRev})
           WHERE h.belief <> 'retracted' AND h.belief <> 'rejected'
             AND h.redactionState <> 'purged'
           RETURN a ORDER BY a.claimId`,
          { subject: resolved, predicate: args.predicate ?? null, at },
        );
        return ok({ claims: result.records.map((record) => summarise(record.get("a").properties)) }, block);
      } finally {
        await session.close();
      }
    }

    case "BelievedAt": {
      const subject = String(args.subject);
      const resolved = resolveEntity(context.state, subject)?.entityId ?? subject;
      const at = resolveInstant(constraint.asOfTransaction);
      if (at === null) return refused("TEMPORAL_INVALID", "asOfTransaction is required");
      const session = context.store.session();
      try {
        // Transaction time: the highest revision already asserted at that
        // instant, whatever this system later concluded.
        const result = await session.run(
          `MATCH (c:Claim)-[:HAS_REVISION]->(r:ClaimRevision)
           WHERE r.subject = $subject
             AND ($predicate IS NULL OR r.predicate = $predicate)
             AND r.assertedAt <= $at
           WITH c, max(r.revision) AS pick
           MATCH (c)-[:HAS_REVISION]->(b:ClaimRevision {revision: pick})
           WHERE b.belief <> 'rejected'
           RETURN b ORDER BY b.claimId`,
          { subject: resolved, predicate: args.predicate ?? null, at },
        );
        return ok({ claims: result.records.map((record) => summarise(record.get("b").properties)) }, block);
      } finally {
        await session.close();
      }
    }

    case "History": {
      const ref = args.ref as { id: string } | undefined;
      const session = context.store.session();
      try {
        const result = await session.run(
          `MATCH (:Claim {claimId: $claimId})-[:HAS_REVISION]->(r:ClaimRevision)
           RETURN r ORDER BY r.revision`,
          { claimId: String(ref?.id) },
        );
        return ok(
          {
            revisions: result.records.map((record) => {
              const node = record.get("r").properties as Record<string, unknown>;
              return {
                revision: Number(node.revision),
                value: String(node.value ?? ""),
                closureReason: (node.closureReason as string | null) ?? null,
                belief: node.belief,
                valid: {
                  from: (node.validFrom as string | null) ?? null,
                  to: (node.validTo as string | null) ?? null,
                },
                assertedAt: node.assertedAt,
                assertedUntil: (node.assertedUntil as string | null) ?? null,
                redactionState: node.redactionState,
              };
            }),
          },
          block,
        );
      } finally {
        await session.close();
      }
    }

    case "Provenance": {
      const audit = args.audit === undefined ? null : String(args.audit);
      if (audit === "claims-without-evidence") {
        const session = context.store.session();
        try {
          // The count of claims EXAMINED is returned with the offenders, because
          // an empty offender list over zero examined claims proves nothing.
          const result = await session.run(
            `MATCH (c:Claim)-[:HAS_REVISION]->(r:ClaimRevision)
             WITH c, max(r.revision) AS headRev
             MATCH (c)-[:HAS_REVISION]->(h:ClaimRevision {revision: headRev})
             WITH collect(h) AS heads
             RETURN size(heads) AS examined,
                    [h IN heads WHERE h.belief <> 'retracted'
                       AND NOT (h)-[:EVIDENCED_BY]->(:Evidence) | h.claimId] AS offenders`,
          );
          const row = result.records[0];
          return ok(
            {
              offenders: asSet((row?.get("offenders") as string[]) ?? [], (id) => id),
              examined: Number(row?.get("examined") ?? 0),
            },
            block,
          );
        } finally {
          await session.close();
        }
      }
      if (audit === "sensitive-canary-occurrences") {
        const session = context.store.session();
        try {
          // Every string property on every node and relationship, plus the
          // coordination feed. A sweep that only looked at claim values would
          // pass while the canary sat in an evidence excerpt.
          // TWO independent queries, deliberately. Chained with `MATCH ()-[r]->()`
          // in one statement, a graph with no relationships yields NO ROW at
          // all — so `nodes` came back undefined and the sweep silently examined
          // zero node properties while still reporting a clean result, because
          // the published feed alone kept the scanned length above zero.
          const nodeRows = await session.run(
            "MATCH (n) RETURN collect(properties(n)) AS nodes",
          );
          const relRows = await session.run(
            "MATCH ()-[r]->() RETURN collect(properties(r)) AS rels",
          );
          const nodeSurface = JSON.stringify(nodeRows.records[0]?.get("nodes") ?? []);
          const relSurface = JSON.stringify(relRows.records[0]?.get("rels") ?? []);
          const feedSurface = JSON.stringify([...context.state.published.values()]);
          const surfaces = nodeSurface + relSurface + feedSurface;
          return ok(
            {
              occurrences: surfaces.split(SENSITIVE_CANARY).length - 1,
              scanned: surfaces.length,
              // Reported separately so an empty node sweep cannot hide behind a
              // non-empty feed.
              nodesScanned: (nodeRows.records[0]?.get("nodes") as unknown[] | undefined)?.length ?? 0,
              relationshipsScanned:
                (relRows.records[0]?.get("rels") as unknown[] | undefined)?.length ?? 0,
            },
            block,
          );
        } finally {
          await session.close();
        }
      }

      const ref = args.ref as { id: string } | undefined;
      const session = context.store.session();
      try {
        // Provenance closure as a real traversal: revision to evidence to
        // source, and the derivation edge to the claims it summarises.
        const result = await session.run(
          `MATCH (c:Claim {claimId: $claimId})-[:HAS_REVISION]->(r:ClaimRevision)
           WITH c, max(r.revision) AS headRev
           MATCH (c)-[:HAS_REVISION]->(h:ClaimRevision {revision: headRev})
           OPTIONAL MATCH (h)-[:EVIDENCED_BY]->(e:Evidence)-[:FROM_SOURCE]->(s:Source)
           OPTIONAL MATCH (h)-[:DERIVED_FROM]->(d:Claim)
           RETURN h,
                  collect(DISTINCT s.sourceRefId) AS sources,
                  collect(DISTINCT d.claimId) AS derivedFrom,
                  collect(DISTINCT {evidenceId: e.evidenceId, sourceRefId: e.sourceRefId,
                                    locator: e.locator, excerptHash: e.excerptHash,
                                    redactionState: e.redactionState}) AS evidence`,
          { claimId: String(ref?.id) },
        );
        const row = result.records[0];
        if (!row) return ok({ sources: [], derivedFrom: [], evidence: [] }, block);
        const head = row.get("h").properties as Record<string, unknown>;
        const declared = JSON.parse(String(head.evidenceIds ?? "[]")) as string[];
        const reached = (row.get("evidence") as Array<{ evidenceId: string | null }>).filter(
          (entry) => entry.evidenceId !== null,
        );
        if (declared.length !== reached.length) {
          return refused("EVIDENCE_CHAIN_BROKEN", `declared ${declared.length}, reached ${reached.length}`);
        }
        // Ordered by the revision's DECLARED arrays, not by traversal order.
        // `collect(DISTINCT …)` returns rows in whatever order the planner
        // reached them, which depends on physical node creation order — so the
        // same graph, restored from its own export, answered this question
        // differently. Three repeats never caught it because they created the
        // nodes in identical order every time; the import round trip did.
        // `derivedFrom` and `evidence` are ordered lists in the contract, and
        // Lane M returns them in declared order, so this is also what makes the
        // two lanes comparable rather than accidentally equal.
        const byId = new Map(reached.map((entry) => [String(entry.evidenceId), entry]));
        const orderedEvidence = declared
          .map((id) => byId.get(id))
          .filter((entry): entry is NonNullable<typeof entry> => entry !== undefined);
        if (orderedEvidence.length !== reached.length) {
          return refused("EVIDENCE_CHAIN_BROKEN", "reached evidence is not the declared set");
        }
        const declaredDerived = JSON.parse(String(head.derivedFrom ?? "[]")) as string[];
        const reachedDerived = new Set((row.get("derivedFrom") as string[]).filter(Boolean));
        if (declaredDerived.length !== reachedDerived.size) {
          return refused(
            "EVIDENCE_CHAIN_BROKEN",
            `declared ${declaredDerived.length} derivations, reached ${reachedDerived.size}`,
          );
        }
        return ok(
          {
            sources: asSet((row.get("sources") as string[]).filter(Boolean), (id) => id),
            derivedFrom: declaredDerived.filter((id) => reachedDerived.has(id)),
            evidence: orderedEvidence,
          },
          block,
        );
      } finally {
        await session.close();
      }
    }

    case "Path": {
      const relTypes = (args.relTypes as string[]) ?? [];
      if (relTypes.length === 0) return refused("SCHEMA_UNKNOWN_TYPE", "relTypes is required");
      const label = relTypes.map(relTypeToLabel).join("|");
      const direction = String(args.direction ?? "outbound");
      const maxDepth = Math.max(1, Math.min(16, constraint.maxDepth ?? 4));
      const at = resolveInstant(constraint.asOfValid);
      const origin = String(args.to ?? args.from);
      const start = resolveEntity(context.state, origin)?.entityId ?? origin;

      // A real variable-length traversal with a per-edge temporal predicate. The
      // relationship type and the depth bound are interpolated because Cypher
      // cannot parameterise either; both are validated first.
      const pattern =
        direction === "inbound"
          ? `(other:Entity)-[rels:${label}*1..${maxDepth}]->(anchor:Entity {entityId: $start})`
          : `(anchor:Entity {entityId: $start})-[rels:${label}*1..${maxDepth}]->(other:Entity)`;

      const session = context.store.session();
      try {
        const result = await session.run(
          `MATCH p = ${pattern}
           WHERE all(e IN rels WHERE
                 ($at IS NULL OR ((e.validFrom IS NULL OR e.validFrom <= $at)
                                  AND (e.validTo IS NULL OR e.validTo > $at))))
           WITH other, min(length(p)) AS depth,
                collect({from: [e IN rels | e.fromId], relType: [e IN rels | e.relationshipId],
                         to: [e IN rels | e.toId], evidence: [e IN rels | e.evidenceIds]}) AS paths
           RETURN other.entityId AS id, depth ORDER BY id`,
          { start, at },
        );

        const shortest: Record<string, number> = {};
        for (const record of result.records) {
          shortest[String(record.get("id"))] = Number(record.get("depth"));
        }

        // Every hop carries its own evidence, so a path is explainable edge by
        // edge rather than only as a whole.
        const hopResult = await session.run(
          `MATCH (a:Entity)-[e:${label}]->(b:Entity)
           WHERE ($at IS NULL OR ((e.validFrom IS NULL OR e.validFrom <= $at)
                                  AND (e.validTo IS NULL OR e.validTo > $at)))
           RETURN e.fromId AS f, type(e) AS t, e.toId AS o, e.evidenceIds AS ev
           ORDER BY f, o`,
          { at },
        );
        const hops = hopResult.records.map((record) => ({
          from: String(record.get("f")),
          relType: String(record.get("t")).toLowerCase(),
          to: String(record.get("o")),
          evidenceIds: JSON.parse(String(record.get("ev") ?? "[]")) as string[],
        }));

        const aliasResult = await session.run(
          `MATCH (a:Entity)-[:MERGED_INTO]->(b:Entity)
           RETURN a.entityId AS alias, a.canonicalName AS name, a.aliases AS aliases,
                  b.entityId AS survivor`,
        );
        const aliasResolution: Record<string, string> = {};
        for (const record of aliasResult.records) {
          const survivor =
            resolveEntity(context.state, String(record.get("alias")))?.entityId ??
            String(record.get("survivor"));
          aliasResolution[String(record.get("alias"))] = survivor;
          aliasResolution[String(record.get("name"))] = survivor;
          for (const alias of JSON.parse(String(record.get("aliases") ?? "[]")) as string[]) {
            aliasResolution[alias] = survivor;
          }
        }

        // A merged entity is reported under its survivor: the tombstoned id
        // stays resolvable forever and must not appear as a separate answer.
        const reached: Record<string, number> = {};
        for (const [id, depth] of Object.entries(shortest)) {
          const survivor = resolveEntity(context.state, id)?.entityId ?? id;
          const existing = reached[survivor];
          reached[survivor] = existing === undefined ? depth : Math.min(existing, depth);
        }

        return ok(
          {
            reached: asSet(Object.keys(reached) as Id[], (id) => id),
            shortest: Object.fromEntries(Object.entries(reached).sort(([a], [b]) => (a < b ? -1 : 1))),
            hops: asSet(hops, (hop) => `${hop.from}|${hop.relType}|${hop.to}`),
            aliasResolution,
          },
          block,
        );
      } finally {
        await session.close();
      }
    }

    case "Conflicts": {
      const status = String(args.status ?? "open");
      const session = context.store.session();
      try {
        const result = await session.run(
          `MATCH (n:Contradiction)
           WHERE ($open AND n.resolution IS NULL) OR (NOT $open AND n.resolution IS NOT NULL)
           RETURN n ORDER BY n.contradictionId`,
          { open: status === "open" },
        );
        return ok(
          {
            conflicts: result.records.map((record) => {
              const node = record.get("n").properties as Record<string, unknown>;
              return {
                contradictionId: String(node.contradictionId),
                members: JSON.parse(String(node.members ?? "[]")),
                // Reported separately, never folded into `members`.
                peerMembers: JSON.parse(String(node.peerMembers ?? "[]")),
                basis: node.basis,
                resolution: JSON.parse(String(node.resolution ?? "null")),
              };
            }),
          },
          block,
        );
      } finally {
        await session.close();
      }
    }

    case "StaleDecisions": {
      const session = context.store.session();
      try {
        // A decision is stale when the revision it PRODUCED is no longer the
        // head. It stays active: staleness is a flag for a human, and a system
        // that invalidated decisions automatically would be overruling the
        // human it asked in the first place.
        //
        // The decisions are read from the graph; the head comparison runs
        // against the neutral snapshot because a decision's targets are a nested
        // structure and Community Edition has no property type constraints to
        // make a nested shape safe to store as anything but an opaque value.
        const decisions = await session.run("MATCH (d:Decision) RETURN d ORDER BY d.decisionId");
        const stale: Array<Record<string, unknown>> = [];
        for (const record of decisions.records) {
          const node = record.get("d").properties as Record<string, unknown>;
          const targets = JSON.parse(String(node.targets ?? "[]")) as Array<{
            kind: string;
            id: string;
            revision: number | null;
          }>;
          for (const target of targets) {
            if (target.kind !== "claim" || target.revision === null) continue;
            const revisions = context.state.claims.get(target.id) ?? [];
            const head = revisions[revisions.length - 1];
            if (!head || head.revision === target.revision) continue;
            stale.push({
              decisionId: String(node.decisionId),
              outcome: node.outcome,
              targetId: target.id,
              decidedAgainstRevision: target.revision,
              headRevision: head.revision,
              stillActive: true,
            });
          }
        }
        return ok({ decisions: asSet(stale, (entry) => String(entry.decisionId)) }, block);
      } finally {
        await session.close();
      }
    }

    // The remaining questions are not graph-shaped. Answering them differently
    // in each lane would manufacture a difference in arithmetic rather than
    // measure one in storage, so both lanes share one implementation over the
    // neutral snapshot.
    case "Work":
    case "HybridRetrieve":
    case "Activity":
    case "Freshness":
      return sharedQuery(request, shared(context));

    default:
      return refused("CAPABILITY_NOT_NEGOTIATED", `unknown query ${String(request.query)}`);
  }
}

function summarise(node: Record<string, unknown>): Record<string, unknown> {
  const origin = JSON.parse(String(node.origin ?? "{}")) as { originKind?: string };
  return {
    claimId: String(node.claimId),
    revision: Number(node.revision),
    value: String(node.value ?? ""),
    predicate: String(node.predicate),
    subject: String(node.subject),
    belief: node.belief,
    canon: Boolean(node.canon),
    valid: {
      from: (node.validFrom as string | null) ?? null,
      to: (node.validTo as string | null) ?? null,
    },
    closureReason: (node.closureReason as string | null) ?? null,
    originKind: origin.originKind ?? null,
  };
}

function refused(code: string, detail: string): QueryResponse {
  return {
    outcome: "refused",
    contractVersion: CONTRACT_VERSION,
    error: {
      code: code as never,
      category: code === "EVIDENCE_CHAIN_BROKEN" ? "integrity" : "validation",
      retryable: "no",
      target: null,
      observed: { detail },
      remedy: "none",
    },
  };
}
