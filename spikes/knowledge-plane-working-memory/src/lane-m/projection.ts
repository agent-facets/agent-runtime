// Lane M's derived projection.
//
// Rebuildable from canonical Markdown alone and never authoritative. Three
// properties make it honest rather than merely present:
//
//   1. Its watermark is the canonical GENERATION digest — a content-derived
//      value computed from the vault's own bytes. Not a timestamp, not a
//      self-assigned sequence number: a projection that stamps its own freshness
//      cannot detect that canonical state moved underneath it.
//
//   2. Its digest is computed over the projected ROWS, not over the vault. A
//      digest of the input would be equal after a rebuild that produced nothing,
//      which is precisely the failure the rebuild case exists to catch.
//
//   3. It never mints a version token. Tokens are derived from canonical state
//      alone, so a projection that issued one would let a caller guard a write
//      against a derived value that no restore would reproduce.

import { createHash } from "node:crypto";

import { PROJECTION_SCHEMA } from "../contract.ts";
import { digest, stable } from "../canonical.ts";
import type { KnowledgeState } from "../knowledge/policy.ts";
import { resolveEntity } from "../knowledge/policy.ts";
import type { CorpusVectors } from "../corpus.ts";
import type { Db } from "./pg.ts";

export type ProjectionScope = "all";

export type ProjectionResult = {
  scope: ProjectionScope;
  canonicalPoint: string;
  rows: { claim: number; edge: number; evidence: number; chunk: number };
  /** Digest over the projected rows themselves. */
  rowDigest: string;
  builtAtTick: number;
};

function instantOrNull(value: string | null): string | null {
  return value === null || value === "" ? null : value;
}

function vectorLiteral(vector: number[] | undefined): string | null {
  return vector ? `[${vector.join(",")}]` : null;
}

/**
 * Rebuild the projection from a canonical snapshot.
 *
 * Full replacement inside one transaction rather than an incremental update: an
 * incremental projection is only as correct as its change feed, and Lane M has
 * no change feed — it has a content digest. Replacing wholesale means the
 * projection is a pure function of canonical state, which is the property the
 * rebuild case actually asserts.
 */
export async function project(
  db: Db,
  state: KnowledgeState,
  canonicalPoint: string,
  vectors: CorpusVectors,
  builtAtTick: number,
): Promise<ProjectionResult> {
  const client = await db.pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`TRUNCATE ${PROJECTION_SCHEMA}.claim,
                                 ${PROJECTION_SCHEMA}.edge,
                                 ${PROJECTION_SCHEMA}.evidence,
                                 ${PROJECTION_SCHEMA}.chunk`);

    const claimRows: unknown[][] = [];
    for (const [claimId, revisions] of [...state.claims.entries()].sort(([a], [b]) =>
      a < b ? -1 : 1,
    )) {
      const head = revisions[revisions.length - 1];
      for (const revision of revisions) {
        const resolved = resolveEntity(state, revision.subject);
        claimRows.push([
          claimId,
          revision.revision,
          revision.subject,
          resolved?.entityId ?? revision.subject,
          revision.predicate,
          revision.value,
          revision.scope,
          instantOrNull(revision.valid.from),
          instantOrNull(revision.valid.to),
          revision.assertedAt,
          instantOrNull(revision.assertedUntil),
          revision.closureReason,
          revision.belief,
          revision.canon,
          revision.origin.originKind,
          revision.origin.authority,
          revision.sensitivity,
          revision.visibility,
          revision.redactionState,
          revision.revision === head?.revision,
        ]);
      }
    }
    for (const row of claimRows) {
      await client.query(
        `INSERT INTO ${PROJECTION_SCHEMA}.claim
           (claim_id, revision, subject, subject_resolved, predicate, value, scope,
            valid_from, valid_to, asserted_at, asserted_until, closure_reason,
            belief, canon, origin_kind, authority, sensitivity, visibility,
            redaction_state, is_head)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
        row,
      );
    }

    const edgeRows: unknown[][] = [];
    for (const [relationshipId, revisions] of [...state.relationships.entries()].sort(([a], [b]) =>
      a < b ? -1 : 1,
    )) {
      const head = revisions[revisions.length - 1];
      for (const revision of revisions) {
        edgeRows.push([
          relationshipId,
          revision.revision,
          revision.from,
          resolveEntity(state, revision.from)?.entityId ?? revision.from,
          revision.relType,
          revision.to,
          resolveEntity(state, revision.to)?.entityId ?? revision.to,
          instantOrNull(revision.valid.from),
          instantOrNull(revision.valid.to),
          revision.assertedAt,
          instantOrNull(revision.assertedUntil),
          revision.closureReason,
          revision.belief,
          revision.revision === head?.revision,
        ]);
      }
    }
    for (const row of edgeRows) {
      await client.query(
        `INSERT INTO ${PROJECTION_SCHEMA}.edge
           (relationship_id, revision, from_id, from_resolved, rel_type, to_id, to_resolved,
            valid_from, valid_to, asserted_at, asserted_until, closure_reason, belief, is_head)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        row,
      );
    }

    const evidenceRows: unknown[][] = [];
    for (const [evidenceId, record] of [...state.evidence.entries()].sort(([a], [b]) =>
      a < b ? -1 : 1,
    )) {
      evidenceRows.push([
        evidenceId,
        record.sourceRefId,
        record.locator,
        record.excerptHash,
        record.strength,
        record.sensitivity,
        record.redactionState,
        state.sources.has(record.sourceRefId),
      ]);
    }
    for (const row of evidenceRows) {
      await client.query(
        `INSERT INTO ${PROJECTION_SCHEMA}.evidence
           (evidence_id, source_ref_id, locator, excerpt_hash, strength, sensitivity,
            redaction_state, source_resolves)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        row,
      );
    }

    // Chunks carry the retrieval surface. Retracted and purged material is
    // projected with EMPTY text rather than skipped: the row's absence would be
    // indistinguishable from a projection that never ran, while an empty row
    // proves the erasure reached the derived structure.
    const chunkRows: unknown[][] = [];
    for (const [claimId, revisions] of [...state.claims.entries()].sort(([a], [b]) =>
      a < b ? -1 : 1,
    )) {
      const head = revisions[revisions.length - 1];
      if (!head) continue;
      const erased = head.belief === "retracted" || head.redactionState === "purged";
      const text = erased ? "" : head.value;
      chunkRows.push([
        `chunk:${claimId}`,
        "claim",
        claimId,
        head.revision,
        text,
        text,
        erased ? null : vectorLiteral(vectors.vectors[claimId]),
      ]);
    }
    for (const row of chunkRows) {
      await client.query(
        `INSERT INTO ${PROJECTION_SCHEMA}.chunk
           (chunk_id, ref_kind, ref_id, revision, text, tsv, embedding)
         VALUES ($1,$2,$3,$4,$5, to_tsvector('simple', $6), $7)`,
        row,
      );
    }

    await client.query("COMMIT");

    const rowDigest = digest({ claimRows, edgeRows, evidenceRows, chunkRows });
    const result: ProjectionResult = {
      scope: "all",
      canonicalPoint,
      rows: {
        claim: claimRows.length,
        edge: edgeRows.length,
        evidence: evidenceRows.length,
        chunk: chunkRows.length,
      },
      rowDigest,
      builtAtTick,
    };

    await setFreshness(db, result, false, []);
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function setFreshness(
  db: Db,
  result: ProjectionResult,
  rebuildPending: boolean,
  degradedFields: string[],
): Promise<void> {
  await db.pool.query(
    `INSERT INTO ${PROJECTION_SCHEMA}.freshness
       (scope, canonical_point, projection_watermark, built_at_tick, rebuild_pending, degraded_fields)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (scope) DO UPDATE SET
       canonical_point = EXCLUDED.canonical_point,
       projection_watermark = EXCLUDED.projection_watermark,
       built_at_tick = EXCLUDED.built_at_tick,
       rebuild_pending = EXCLUDED.rebuild_pending,
       degraded_fields = EXCLUDED.degraded_fields`,
    [
      result.scope,
      result.canonicalPoint,
      result.canonicalPoint,
      result.builtAtTick,
      rebuildPending,
      degradedFields,
    ],
  );
}

export type FreshnessRow = {
  scope: string;
  projectionWatermark: string;
  builtAtTick: number;
  rebuildPending: boolean;
  degradedFields: string[];
};

export async function readFreshness(db: Db, scope = "all"): Promise<FreshnessRow | null> {
  const { rows } = await db.pool.query<{
    scope: string;
    projection_watermark: string;
    built_at_tick: number;
    rebuild_pending: boolean;
    degraded_fields: string[];
  }>(
    `SELECT scope, projection_watermark, built_at_tick, rebuild_pending, degraded_fields
       FROM ${PROJECTION_SCHEMA}.freshness WHERE scope = $1`,
    [scope],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    scope: row.scope,
    projectionWatermark: row.projection_watermark,
    builtAtTick: row.built_at_tick,
    rebuildPending: row.rebuild_pending,
    degradedFields: row.degraded_fields,
  };
}

/**
 * Mark the projection as lagging canonical state without rebuilding it.
 *
 * Used by the projection-failure case: canonical state committed, the derived
 * write did not, and every subsequent read has to say so.
 */
export async function markStale(db: Db, degradedFields: string[]): Promise<void> {
  await db.pool.query(
    `UPDATE ${PROJECTION_SCHEMA}.freshness
        SET rebuild_pending = true, degraded_fields = $1
      WHERE scope = 'all'`,
    [degradedFields],
  );
}

/** Digest the projection back out of Postgres, independently of what was written. */
export async function readBackDigest(db: Db): Promise<string> {
  const claim = await db.pool.query(
    `SELECT * FROM ${PROJECTION_SCHEMA}.claim ORDER BY claim_id, revision`,
  );
  const edge = await db.pool.query(
    `SELECT * FROM ${PROJECTION_SCHEMA}.edge ORDER BY relationship_id, revision`,
  );
  const evidence = await db.pool.query(
    `SELECT * FROM ${PROJECTION_SCHEMA}.evidence ORDER BY evidence_id`,
  );
  const chunk = await db.pool.query(
    `SELECT chunk_id, ref_kind, ref_id, revision, text, embedding
       FROM ${PROJECTION_SCHEMA}.chunk ORDER BY chunk_id`,
  );
  return createHash("sha256")
    .update(stable([claim.rows, edge.rows, evidence.rows, chunk.rows]))
    .digest("hex");
}
