// Lane M's read surface.
//
// Deliberately NOT shared with Lane N. The policy module is shared because the
// RULES must be identical; the query implementation must not be, because how
// well each store answers a graph-shaped, temporal, provenance-carrying question
// is the thing being measured. A shared traversal would hand Lane N a file-tree
// answer and prove nothing about the graph.
//
// Every golden query is answered from CANONICAL state. The contract says a
// `maxStalenessMs` of `null` requires a canonical read and all twenty-four
// golden queries declare it, so serving them from the projection would answer a
// question nobody asked. The projection is exercised where it genuinely is the
// subject: freshness, rebuild, stale marking, and the retrieval index — and by
// the equality check that a fresh projection reproduces the canonical answer.

import { asSet } from "../canonical.ts";
import { SENSITIVE_CANARY } from "../evidence.ts";
import { tickToInstant } from "../contract.ts";
import type {
  ClaimRevision,
  FreshnessBlock,
  Id,
  PathHop,
  QueryRequest,
  QueryResponse,
  ReadConstraint,
  RelationshipRevision,
} from "../knowledge/contract.ts";
import { CONTRACT_VERSION } from "../knowledge/contract.ts";
import type { KnowledgeState } from "../knowledge/policy.ts";
import { resolveEntity } from "../knowledge/policy.ts";
import { cosine } from "../corpus.ts";
import type { Corpus, CorpusVectors } from "../corpus.ts";
import type { FreshnessRow } from "./projection.ts";

export type ReadContext = {
  state: KnowledgeState;
  corpus: Corpus;
  vectors: CorpusVectors;
  /** The canonical generation digest, computed from the vault's own bytes. */
  canonicalPoint: string;
  /** Absent when no projection exists, which is a legitimate offline posture. */
  freshness: FreshnessRow | null;
};

export const DEFAULT_CONSTRAINT: ReadConstraint = {
  maxStalenessMs: null,
  onStale: "fail",
  asOfValid: null,
  asOfTransaction: null,
  limit: 50,
  maxDepth: 4,
  includeDisputed: false,
  includeSummarized: false,
};

/**
 * `tick:N` is a fixture convenience; everything downstream works in instants.
 *
 * Resolved here rather than in the oracle so the deterministic clock stays the
 * single definition of what a tick means.
 */
export function resolveInstant(value: string | null): string | null {
  if (value === null) return null;
  if (value.startsWith("tick:")) return tickToInstant(Number(value.slice(5)));
  return value;
}

function ms(value: string | null): number | null {
  return value === null ? null : Date.parse(value);
}

/** Half-open: `[from, to)`. An unbounded side never excludes. */
function intervalContains(
  interval: { from: string | null; to: string | null },
  at: number,
): boolean {
  const from = ms(interval.from);
  const to = ms(interval.to);
  if (from !== null && at < from) return false;
  if (to !== null && at >= to) return false;
  return true;
}

function head<T extends { revision: number }>(revisions: T[]): T | null {
  return revisions.length === 0 ? null : (revisions[revisions.length - 1] ?? null);
}

/**
 * Belief the caller is asking about, at the head of the chain.
 *
 * `is head` rather than `assertedUntil IS NULL`: retraction, summarisation, and
 * reinforcement all APPEND without closing their predecessor, so an
 * openness test returns two live rows for one claim and quietly doubles an
 * answer that should have been empty.
 */
function isReadable(revision: ClaimRevision, constraint: ReadConstraint): boolean {
  if (revision.belief === "retracted" || revision.belief === "rejected") return false;
  if (revision.redactionState === "purged") return false;
  if (revision.belief === "summarized" && !constraint.includeSummarized) return false;
  if (revision.belief === "disputed" && !constraint.includeDisputed) return false;
  return true;
}

function subjectMatches(state: KnowledgeState, revision: ClaimRevision, subject: Id): boolean {
  const wanted = resolveEntity(state, subject)?.entityId ?? subject;
  const actual = resolveEntity(state, revision.subject)?.entityId ?? revision.subject;
  return wanted === actual;
}

function claimSummary(revision: ClaimRevision): Record<string, unknown> {
  return {
    claimId: revision.claimId,
    revision: revision.revision,
    value: revision.value,
    predicate: revision.predicate,
    subject: revision.subject,
    belief: revision.belief,
    canon: revision.canon,
    valid: revision.valid,
    closureReason: revision.closureReason,
    // Carried so a caller can check that no answer was authored by a peer
    // report, rather than having to trust that some filter removed them.
    originKind: revision.origin.originKind,
  };
}

function ok(data: unknown, freshness: FreshnessBlock, truncated = false): QueryResponse {
  return { outcome: "ok", contractVersion: CONTRACT_VERSION, freshness, data, truncated };
}

/**
 * The freshness block that accompanies every answer.
 *
 * `degradedFields` is what makes hard gate 10 mechanical rather than a
 * judgement: a lane either names what is stale or it does not.
 */
export function freshnessFor(context: ReadContext, servedFrom: FreshnessBlock["servedFrom"]): FreshnessBlock {
  const row = context.freshness;
  if (row === null) {
    return {
      servedFrom,
      canonicalPoint: context.canonicalPoint,
      projectionWatermark: null,
      lagMs: null,
      // No projection is not the same as a fresh one, and must never read as one.
      staleness: servedFrom === "canonical" ? "fresh" : "unknown",
      degradedFields: [],
      rebuildPending: false,
    };
  }
  const behind = row.projectionWatermark !== context.canonicalPoint;
  const degraded = row.degradedFields.length > 0 ? row.degradedFields : behind ? ["projection"] : [];
  return {
    servedFrom,
    canonicalPoint: context.canonicalPoint,
    projectionWatermark: row.projectionWatermark,
    lagMs: null,
    staleness: servedFrom === "canonical" ? "fresh" : behind || row.rebuildPending ? "stale" : "fresh",
    degradedFields: servedFrom === "canonical" ? [] : degraded,
    rebuildPending: row.rebuildPending || behind,
  };
}

export function query(request: QueryRequest, context: ReadContext): QueryResponse {
  const constraint: ReadConstraint = { ...DEFAULT_CONSTRAINT, ...request.constraint };
  const args = request.args;
  const state = context.state;
  const canonical = freshnessFor(context, "canonical");

  switch (request.query) {
    case "CurrentClaims": {
      const subject = String(args.subject);
      const claims: Array<Record<string, unknown>> = [];
      for (const revisions of state.claims.values()) {
        const current = head(revisions);
        if (!current) continue;
        if (!subjectMatches(state, current, subject)) continue;
        if (!isReadable(current, constraint)) continue;
        claims.push(claimSummary(current));
      }
      return ok(
        { claims: asSet(claims, (claim) => String(claim.claimId)) },
        canonical,
      );
    }

    case "ClaimsAsOf": {
      // World time. A revision answers for an instant when its VALID interval
      // contains it and belief in it did not end because we were wrong about
      // that same interval. `corrected` is therefore excluded and
      // `world_progressed` is not: the first says the old value never held, the
      // second says it held then and something else holds now.
      const subject = String(args.subject);
      const predicate = args.predicate === undefined ? null : String(args.predicate);
      const at = ms(resolveInstant(constraint.asOfValid));
      if (at === null) {
        return refusedQuery("TEMPORAL_INVALID", "asOfValid is required for ClaimsAsOf");
      }
      const claims: Array<Record<string, unknown>> = [];
      for (const revisions of state.claims.values()) {
        const current = head(revisions);
        if (!current) continue;
        if (!subjectMatches(state, current, subject)) continue;
        if (predicate !== null && current.predicate !== predicate) continue;
        if (!isReadable(current, constraint)) continue;
        const eligible = revisions.filter(
          (revision) =>
            intervalContains(revision.valid, at) &&
            revision.closureReason !== "corrected" &&
            revision.closureReason !== "retracted" &&
            revision.closureReason !== "rejected",
        );
        const answer = head(eligible);
        if (answer) claims.push(claimSummary(answer));
      }
      return ok({ claims: asSet(claims, (claim) => String(claim.claimId)) }, canonical);
    }

    case "BelievedAt": {
      // Transaction time. The highest revision this system had already asserted
      // at that instant, regardless of what it later concluded.
      const subject = String(args.subject);
      const predicate = args.predicate === undefined ? null : String(args.predicate);
      const at = ms(resolveInstant(constraint.asOfTransaction));
      if (at === null) {
        return refusedQuery("TEMPORAL_INVALID", "asOfTransaction is required for BelievedAt");
      }
      const claims: Array<Record<string, unknown>> = [];
      for (const revisions of state.claims.values()) {
        const anchor = revisions[0];
        if (!anchor) continue;
        if (!subjectMatches(state, anchor, subject)) continue;
        if (predicate !== null && anchor.predicate !== predicate) continue;
        const believed = head(
          revisions.filter((revision) => (ms(revision.assertedAt) ?? Infinity) <= at),
        );
        if (!believed) continue;
        if (believed.belief === "rejected") continue;
        claims.push(claimSummary(believed));
      }
      return ok({ claims: asSet(claims, (claim) => String(claim.claimId)) }, canonical);
    }

    case "History": {
      const ref = args.ref as { kind: string; id: string } | undefined;
      const revisions = state.claims.get(String(ref?.id));
      if (!revisions) return ok({ revisions: [] }, canonical);
      // Order IS the answer here: two closures with different reasons in one
      // chain is what separates progression from correction.
      return ok(
        {
          revisions: revisions.map((revision) => ({
            revision: revision.revision,
            value: revision.value,
            closureReason: revision.closureReason,
            belief: revision.belief,
            valid: revision.valid,
            assertedAt: revision.assertedAt,
            assertedUntil: revision.assertedUntil,
            redactionState: revision.redactionState,
          })),
        },
        canonical,
      );
    }

    case "Provenance": {
      const audit = args.audit === undefined ? null : String(args.audit);
      if (audit === "claims-without-evidence") {
        const offenders: Id[] = [];
        let examined = 0;
        for (const revisions of state.claims.values()) {
          const current = head(revisions);
          if (!current) continue;
          examined += 1;
          if (current.belief === "retracted") continue;
          if (current.evidenceIds.length === 0) offenders.push(current.claimId);
        }
        // The count is reported alongside the answer: an empty offender list
        // over zero examined claims proves nothing at all.
        return ok({ offenders: asSet(offenders, (id) => id), examined }, canonical);
      }
      if (audit === "sensitive-canary-occurrences") {
        const surfaces = JSON.stringify([
          [...state.claims.values()],
          [...state.evidence.values()],
          [...state.entities.values()],
          [...state.peerRecords.values()],
          [...state.published.values()],
          [...state.activeContexts.values()],
          state.rejections,
        ]);
        const occurrences = surfaces.split(SENSITIVE_CANARY).length - 1;
        return ok({ occurrences, scanned: surfaces.length }, canonical);
      }

      const ref = args.ref as { kind: string; id: string } | undefined;
      const revisions = state.claims.get(String(ref?.id)) ?? [];
      const current = head(revisions);
      if (!current) return ok({ sources: [], derivedFrom: [], evidence: [] }, canonical);
      const evidence = current.evidenceIds
        .map((id) => state.evidence.get(id))
        .filter((record): record is NonNullable<typeof record> => record !== undefined);
      const broken = current.evidenceIds.filter((id) => !state.evidence.has(id));
      if (broken.length > 0) {
        return refusedQuery("EVIDENCE_CHAIN_BROKEN", `unresolvable evidence: ${broken.join(",")}`);
      }
      return ok(
        {
          sources: asSet([...new Set(evidence.map((record) => record.sourceRefId))], (id) => id),
          derivedFrom: current.derivedFrom,
          // `excerptHash` and never `excerpt`. The research write-up stays in
          // the system that owns it; a lane that inlined the section body has
          // taken authority the source plane holds.
          evidence: evidence.map((record) => ({
            evidenceId: record.evidenceId,
            sourceRefId: record.sourceRefId,
            locator: record.locator,
            excerptHash: record.excerptHash,
            redactionState: record.redactionState,
          })),
        },
        canonical,
      );
    }

    case "Path": {
      const relTypes = new Set((args.relTypes as string[]) ?? []);
      const direction = String(args.direction ?? "outbound");
      const maxDepth = constraint.maxDepth ?? 4;
      const at = ms(resolveInstant(constraint.asOfValid));
      const origin = String(args.to ?? args.from);
      const start = resolveEntity(state, origin)?.entityId ?? origin;

      // Only head revisions, and only edges whose VALID interval covers the
      // asked-about instant. An edge that was removed from the world is not a
      // path, however alive its record is.
      const edges: RelationshipRevision[] = [];
      for (const revisions of state.relationships.values()) {
        const current = head(revisions);
        if (!current) continue;
        if (current.belief === "retracted" || current.belief === "rejected") continue;
        if (relTypes.size > 0 && !relTypes.has(current.relType)) continue;
        if (at !== null && !intervalContains(current.valid, at)) continue;
        edges.push(current);
      }

      const shortest = new Map<Id, number>();
      const hops: PathHop[] = [];
      let frontier: Id[] = [start];
      const seen = new Set<Id>([start]);

      for (let depth = 1; depth <= maxDepth && frontier.length > 0; depth += 1) {
        const next: Id[] = [];
        for (const node of frontier) {
          for (const edge of edges) {
            const from = resolveEntity(state, edge.from)?.entityId ?? edge.from;
            const to = resolveEntity(state, edge.to)?.entityId ?? edge.to;
            const matches = direction === "inbound" ? to === node : from === node;
            if (!matches) continue;
            const other = direction === "inbound" ? from : to;
            hops.push({
              from: edge.from,
              relType: edge.relType,
              to: edge.to,
              // Every hop carries its own evidence, so a path is explainable
              // edge by edge rather than only as a whole.
              evidenceIds: edge.evidenceIds,
            });
            if (seen.has(other)) continue;
            seen.add(other);
            shortest.set(other, depth);
            next.push(other);
          }
        }
        frontier = next;
      }

      // Merge redirects, exposed so the answer can be checked rather than
      // trusted. A tombstoned id stays resolvable forever.
      const aliasResolution: Record<string, string> = {};
      for (const entity of state.entities.values()) {
        if (entity.mergedInto === null) continue;
        const survivor = resolveEntity(state, entity.entityId);
        if (!survivor) continue;
        aliasResolution[entity.entityId] = survivor.entityId;
        aliasResolution[entity.canonicalName] = survivor.entityId;
        for (const alias of entity.aliases) aliasResolution[alias] = survivor.entityId;
      }

      const reached = [...shortest.keys()];
      return ok(
        {
          reached: asSet(reached, (id) => id),
          shortest: Object.fromEntries([...shortest.entries()].sort(([a], [b]) => (a < b ? -1 : 1))),
          hops: asSet(hops, (hop) => `${hop.from}|${hop.relType}|${hop.to}`),
          aliasResolution,
        },
        canonical,
      );
    }

    case "Conflicts": {
      const status = String(args.status ?? "open");
      const conflicts = [...state.contradictions.values()]
        .filter((record) => (status === "open" ? record.resolution === null : record.resolution !== null))
        .map((record) => ({
          contradictionId: record.contradictionId,
          members: record.members,
          // Reported separately, never folded into `members`: a peer report is a
          // position in the contradiction without ever becoming a claim.
          peerMembers: record.peerMembers,
          basis: record.basis,
          resolution: record.resolution,
        }));
      return ok(
        { conflicts: asSet(conflicts, (entry) => entry.contradictionId) },
        canonical,
      );
    }

    case "StaleDecisions": {
      // A decision is stale when the revision it PRODUCED is no longer the head.
      // It is not invalidated: staleness is a flag for a human, and a system
      // that retracted decisions automatically would be overruling the human it
      // asked in the first place.
      const stale: Array<Record<string, unknown>> = [];
      for (const decision of state.decisions.values()) {
        for (const target of decision.targets) {
          if (target.kind !== "claim" || target.revision === null) continue;
          const current = head(state.claims.get(target.id) ?? []);
          if (!current || current.revision === target.revision) continue;
          stale.push({
            decisionId: decision.decisionId,
            outcome: decision.outcome,
            targetId: target.id,
            decidedAgainstRevision: target.revision,
            headRevision: current.revision,
            stillActive: true,
          });
        }
      }
      return ok({ decisions: asSet(stale, (entry) => String(entry.decisionId)) }, canonical);
    }

    case "Work": {
      const workItemId = String(args.workItemId);
      const item = context.corpus.workItems.find((entry) => entry.id === workItemId);
      if (!item) return ok({ workItemId, attempts: [], outputs: [] }, canonical);

      const constraintsFor = args.constraintsInForceFor;
      if (typeof constraintsFor === "string") {
        // Constraints reach a later attempt through the WORK ITEM, never through
        // the earlier attempt's transcript. If this is empty the handoff carried
        // nothing and Stage 2 has no substrate to measure.
        const carried =
          item.handoff && item.handoff.toRun === constraintsFor
            ? item.handoff.carriedConstraints
            : [];
        return ok({ workItemId, claims: asSet([...carried], (id) => id) }, canonical);
      }

      const publishableTo = args.publishableTo;
      if (typeof publishableTo === "string") {
        const candidates = item.handoff ? item.handoff.carriedConstraints : [];
        const publishable = candidates.filter((claimId) => {
          const current = head(state.claims.get(claimId) ?? []);
          if (!current) return false;
          if (!isReadable(current, constraint)) return false;
          // Four conjuncts, all required. In this corpus `canon` is the
          // discriminating one, but publishing internal or private material
          // would be the more serious failure, so sensitivity and visibility are
          // checked rather than inferred from canon status.
          if (!current.canon) return false;
          if (current.sensitivity !== "public") return false;
          if (current.visibility !== "publishable_full") return false;
          return true;
        });
        return ok({ workItemId, claims: asSet(publishable, (id) => id) }, canonical);
      }

      // Outputs live where the work actually landed. They are recovered from the
      // published activity record's output URIs, matched back to registered
      // source references — never copied into the knowledge plane.
      const outputs = new Set<string>();
      for (const record of state.published.values()) {
        if (String((record as { workItemId?: string }).workItemId) !== workItemId) continue;
        const entries = ((record as { outputs?: Array<{ uri?: string }> }).outputs ?? []);
        for (const output of entries) {
          const source = context.corpus.sources.find((entry) => entry.uri === output.uri);
          if (source) outputs.add(source.id);
        }
      }

      return ok(
        {
          workItemId,
          // Order is the answer: three attempts, one work item, and a finished
          // attempt is not a finished work item.
          attempts: item.attempts.map((attempt) => attempt.id),
          outputs: asSet([...outputs], (id) => id),
        },
        canonical,
      );
    }

    case "HybridRetrieve": {
      const text = String(args.text ?? "");
      const k = Number(args.k ?? constraint.limit);
      const queryId = String(args.queryId ?? "Q21");
      const queryVector = context.vectors.queryVectors[queryId];
      const weights = context.vectors.fusionWeights;
      const queryTerms = context.vectors.vocabulary.filter((term) =>
        text.toLowerCase().includes(term),
      );

      type Scored = {
        id: string;
        score: number;
        components: Record<string, number>;
      };

      const candidates: Array<{ revision: ClaimRevision; vector: number[] | undefined }> = [];
      for (const revisions of state.claims.values()) {
        const current = head(revisions);
        if (!current) continue;
        // Retracted and purged material is structurally ineligible, and a peer
        // report was never a candidate to begin with: it is not a claim, so no
        // filter has to remember to remove it.
        if (current.belief === "retracted" || current.belief === "rejected") continue;
        if (current.redactionState === "purged") continue;
        candidates.push({ revision: current, vector: context.vectors.vectors[current.claimId] });
      }

      const maxDerived = Math.max(
        1,
        ...candidates.map((candidate) => candidate.revision.derivedFrom.length),
      );
      const assertedTimes = candidates.map((candidate) => ms(candidate.revision.assertedAt) ?? 0);
      const minAsserted = Math.min(...assertedTimes, 0);
      const maxAsserted = Math.max(...assertedTimes, 1);
      const episodic = new Set<string>();
      for (const record of state.activeContexts.values()) {
        for (const item of ((record as { items?: Array<{ claimId?: string }> }).items ?? [])) {
          if (item.claimId) episodic.add(item.claimId);
        }
      }

      const scored: Scored[] = candidates.map(({ revision, vector }) => {
        const itemTerms = context.vectors.vocabulary.filter((term) =>
          revision.value.toLowerCase().includes(term),
        );
        const overlap = queryTerms.filter((term) => itemTerms.includes(term)).length;
        const lexical = queryTerms.length === 0 ? 0 : overlap / queryTerms.length;
        const semantic = queryVector && vector ? cosine(queryVector, vector) : 0;
        const graph = revision.derivedFrom.length / maxDerived;
        const asserted = ms(revision.assertedAt) ?? 0;
        const recency =
          maxAsserted === minAsserted ? 0 : (asserted - minAsserted) / (maxAsserted - minAsserted);
        const inContext = episodic.has(revision.claimId) ? 1 : 0;
        const score =
          (weights.lexical ?? 0) * lexical +
          (weights.semantic ?? 0) * semantic +
          (weights.graph ?? 0) * graph +
          (weights.recency ?? 0) * recency +
          (weights.episodic ?? 0) * inContext;
        return {
          id: revision.claimId,
          score,
          components: { lexical, semantic, graph, recency, episodic: inContext },
        };
      });

      // Ranked, so order is the answer and the canonicaliser must not sort it.
      // Ties break on id so the ordering is total and reproducible.
      scored.sort((left, right) => right.score - left.score || (left.id < right.id ? -1 : 1));
      const ranked = scored.slice(0, k);
      return ok({ ranked, queryTerms }, freshnessFor(context, "mixed"), scored.length > k);
    }

    case "Activity": {
      const publisher = String(args.publisherNodeId);
      const reports = [...state.peerRecords.values()]
        .filter((record) => String((record as { publisherNodeId?: string }).publisherNodeId) === publisher)
        .map((record) => ({
          // An AttributedReport, never a Claim. Attribution is part of the
          // payload rather than something the harness supplies afterwards.
          record: {
            recordId: (record as { recordId?: string }).recordId,
            publisherNodeId: (record as { publisherNodeId?: string }).publisherNodeId,
            workItemId: (record as { workItemId?: string }).workItemId,
            kind: (record as { kind?: string }).kind,
            summary: (record as { summary?: string }).summary,
            outputs: (record as { outputs?: unknown }).outputs ?? [],
          },
          attributedTo: (record as { publisherNodeId?: string }).publisherNodeId,
          promoted: false,
          withdrawn: false,
        }));
      return ok(
        { reports, recordIds: reports.map((entry) => String(entry.record.recordId)) },
        canonical,
      );
    }

    case "Freshness":
      return ok({ scope: String(args.scope ?? "all") }, freshnessFor(context, "derived"));

    default:
      return refusedQuery("CAPABILITY_NOT_NEGOTIATED", `unknown query ${String(request.query)}`);
  }
}

function refusedQuery(code: string, detail: string): QueryResponse {
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
