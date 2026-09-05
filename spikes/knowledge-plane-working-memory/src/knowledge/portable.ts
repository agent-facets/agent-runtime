// Portable export and import.
//
// The export is the neutral form both lanes already emit. Import turns it back
// into the same `PlanOp` stream a lane applies for any other write, so a
// restored store is built by the same code path as a live one. An import that
// used a private back door would prove the export could be read, not that it
// could be restored.
//
// The `PlanOp` stream is the same; the POLICY GATE is not. A live write goes
// through `decide()` — schema validation, authority, guards, referential
// integrity, idempotency. An import goes straight to the store. That is a
// deliberate choice, because a restore must reproduce history rather than
// re-authorise it, but it makes the import a privileged path with no validation
// of its own. `validateExport` is that validation.
//
// Version tokens are absent from the export by construction. They are per-lane
// and per-run, so carrying them would make two semantically identical stores
// compare unequal and turn a portability check into a storage-format check.

import type {
  ClaimRevision,
  ContradictionRecord,
  EntityRecord,
  EvidenceRecord,
  Instant,
  RelationshipRevision,
  ReviewDecisionRecord,
  SourceRefRecord,
} from "./contract.ts";
import { CONTRACT_VERSION } from "./contract.ts";
import type { PlanOp } from "./policy.ts";

export type NeutralExport = {
  /**
   * Required, and checked. It was emitted and never read: an export from another
   * contract version imported silently and completely, and the round-trip
   * comparison excluded the field so it could not notice either.
   */
  contractVersion?: string;
  entities?: EntityRecord[];
  claims?: Array<{ claimId: string; revisions: ClaimRevision[] }>;
  relationships?: Array<{ relationshipId: string; revisions: RelationshipRevision[] }>;
  evidence?: EvidenceRecord[];
  sources?: SourceRefRecord[];
  contradictions?: ContradictionRecord[];
  decisions?: ReviewDecisionRecord[];
  peerRecords?: Array<{ recordId: string; record: Record<string, unknown> }>;
  candidates?: Array<{ candidateId: string; recordId: string; status: "unreviewed" }>;
  activeContexts?: Array<{ activeContextId: string; record: Record<string, unknown> }>;
  rejections?: Array<{
    reason: string;
    sourceRefId: string;
    decidedAt: Instant;
    contentHash: string;
  }>;
};

export class ExportRejected extends Error {
  readonly problems: string[];

  constructor(problems: string[]) {
    super(`export rejected: ${problems.join("; ")}`);
    this.name = "ExportRejected";
    this.problems = problems;
  }
}

/**
 * Everything the import path would otherwise discover as a silent no-op.
 *
 * Cypher has no "fail if no rows" and a file write has no foreign key, so a
 * dangling reference in an export does not fail the import — it produces a store
 * that is missing an edge nobody asked about. Checking first turns that into a
 * refusal naming the offending id.
 */
export function validateExport(state: NeutralExport): string[] {
  const problems: string[] = [];
  const version = state.contractVersion;
  if (version === undefined) problems.push("contractVersion is absent");
  else if (version !== CONTRACT_VERSION) {
    problems.push(`contractVersion ${version} != ${CONTRACT_VERSION}`);
  }

  const sources = new Set((state.sources ?? []).map((record) => record.sourceRefId));
  const entities = new Set((state.entities ?? []).map((record) => record.entityId));
  const evidence = new Set((state.evidence ?? []).map((record) => record.evidenceId));
  const claims = new Set((state.claims ?? []).map((entry) => entry.claimId));
  const peers = new Set((state.peerRecords ?? []).map((entry) => entry.recordId));

  for (const record of state.evidence ?? []) {
    if (!sources.has(record.sourceRefId)) {
      problems.push(`evidence ${record.evidenceId} cites absent source ${record.sourceRefId}`);
    }
  }
  for (const record of state.entities ?? []) {
    if (record.mergedInto !== null && !entities.has(record.mergedInto)) {
      problems.push(`entity ${record.entityId} merges into absent ${record.mergedInto}`);
    }
  }
  for (const entry of state.claims ?? []) {
    const numbers = entry.revisions.map((revision) => revision.revision).sort((a, b) => a - b);
    numbers.forEach((value, index) => {
      if (value !== index + 1) {
        problems.push(`claim ${entry.claimId} revision numbering is not contiguous from 1`);
      }
    });
    for (const revision of entry.revisions) {
      if (!entities.has(revision.subject)) {
        problems.push(`claim ${entry.claimId} r${revision.revision} subject ${revision.subject} absent`);
      }
      for (const id of revision.evidenceIds) {
        if (!evidence.has(id)) {
          problems.push(`claim ${entry.claimId} r${revision.revision} cites absent evidence ${id}`);
        }
      }
      for (const id of revision.derivedFrom) {
        if (!claims.has(id)) {
          problems.push(`claim ${entry.claimId} r${revision.revision} derives from absent ${id}`);
        }
      }
    }
  }
  for (const entry of state.relationships ?? []) {
    for (const revision of entry.revisions) {
      if (!entities.has(revision.from) || !entities.has(revision.to)) {
        problems.push(`relationship ${entry.relationshipId} has an absent endpoint`);
      }
    }
  }
  for (const entry of state.candidates ?? []) {
    if (!peers.has(entry.recordId)) {
      problems.push(`candidate ${entry.candidateId} cites absent peer record ${entry.recordId}`);
    }
  }
  return problems;
}

/**
 * Ops that rebuild a store from a neutral export.
 *
 * Order is load-bearing rather than cosmetic. Evidence references a source, a
 * claim revision references its subject entity and its evidence, a claim may
 * derive from another claim, a candidate references a peer record, and a typed
 * relationship needs both endpoint entities to exist before it can be created at
 * all in a graph.
 *
 * A missing target does NOT fail loudly in either lane — Cypher yields zero rows
 * and merges nothing, and a file write has no referential integrity — so getting
 * the order wrong produces a quietly incomplete store rather than an error. The
 * claim-to-claim derivation ordering used to be satisfied only by alphabetical
 * accident in the fixture: a summary claim sorting before its sources would have
 * dropped every derivation edge with the export digest still comparing equal.
 * Claim SHELLS are therefore emitted before any revision.
 */
export function opsFromExport(state: NeutralExport): PlanOp[] {
  const problems = validateExport(state);
  if (problems.length > 0) throw new ExportRejected(problems);

  const ops: PlanOp[] = [];

  for (const record of state.sources ?? []) ops.push({ op: "put-source", record });
  // Entities are written twice: once without the merge redirect so both
  // endpoints exist, and once with it. A tombstone whose survivor has not been
  // created yet cannot be linked.
  for (const record of state.entities ?? []) {
    ops.push({ op: "put-entity", record: { ...record, mergedInto: null } });
  }
  for (const record of state.evidence ?? []) ops.push({ op: "put-evidence", record });

  // Every claim SHELL first, so a derivation can never reference a claim that
  // has not been created yet regardless of id ordering.
  for (const entry of state.claims ?? []) {
    const first = entry.revisions[0];
    if (first) ops.push({ op: "ensure-claim", claimId: entry.claimId, subject: first.subject });
  }
  for (const entry of state.claims ?? []) {
    for (const revision of entry.revisions) ops.push({ op: "append-claim-revision", revision });
  }
  for (const entry of state.relationships ?? []) {
    for (const revision of entry.revisions) {
      ops.push({ op: "append-relationship-revision", revision });
    }
  }
  for (const record of state.entities ?? []) {
    if (record.mergedInto !== null) ops.push({ op: "put-entity", record });
  }
  for (const record of state.contradictions ?? []) ops.push({ op: "put-contradiction", record });
  for (const record of state.decisions ?? []) ops.push({ op: "put-decision", record });

  // Peer material before the candidates that reference it.
  for (const entry of state.peerRecords ?? []) {
    ops.push({ op: "put-peer-record", recordId: entry.recordId, record: entry.record });
  }
  for (const entry of state.candidates ?? []) {
    ops.push({ op: "put-candidate", candidateId: entry.candidateId, recordId: entry.recordId });
  }
  for (const entry of state.activeContexts ?? []) {
    ops.push({
      op: "put-active-context",
      activeContextId: entry.activeContextId,
      record: entry.record,
    });
  }
  for (const entry of state.rejections ?? []) {
    ops.push({
      op: "record-rejection",
      reason: entry.reason,
      sourceRefId: entry.sourceRefId,
      contentHash: entry.contentHash,
      decidedAt: entry.decidedAt,
    });
  }

  return ops;
}

/**
 * Remove one evidence link, for the import comparison's negative control.
 *
 * Without it, "the import matched" is satisfied by a comparison that cannot
 * detect anything, including one that compared nothing at all.
 */
export function withOneEvidenceLinkRemoved(state: NeutralExport): NeutralExport {
  const claims = (state.claims ?? []).map((entry) => ({ ...entry }));
  for (const entry of claims) {
    const index = entry.revisions.findIndex((revision) => revision.evidenceIds.length > 0);
    if (index === -1) continue;
    const revisions = [...entry.revisions];
    const target = revisions[index];
    if (!target) continue;
    revisions[index] = { ...target, evidenceIds: target.evidenceIds.slice(1) };
    entry.revisions = revisions;
    return { ...state, claims };
  }
  return { ...state, claims };
}

/**
 * Point an evidence link at an id that does not exist, for the validation
 * control.
 *
 * Distinct from `withOneEvidenceLinkRemoved`, which produces a SMALLER but still
 * internally consistent export. This one produces a DANGLING reference, which is
 * the case the import path used to accept silently.
 */
export function withDanglingEvidenceReference(state: NeutralExport): NeutralExport {
  const claims = (state.claims ?? []).map((entry) => ({ ...entry }));
  for (const entry of claims) {
    const index = entry.revisions.findIndex((revision) => revision.evidenceIds.length > 0);
    if (index === -1) continue;
    const revisions = [...entry.revisions];
    const target = revisions[index];
    if (!target) continue;
    revisions[index] = { ...target, evidenceIds: [...target.evidenceIds, "ev:does-not-exist"] };
    entry.revisions = revisions;
    return { ...state, claims };
  }
  return { ...state, claims };
}
