// The reconciliation rules, with no store and no model client in sight.
//
// Everything here is a pure function over host-owned identity and untrusted
// model output. The separation is the point: what a model may say is data that
// has to survive validation, and what becomes durable is decided by an operator
// through a decision record, never by a field in an extraction.
//
// Two words are used precisely throughout:
//
//   attribution   this exact text really does appear in that retained source
//   truth         the claim is actually correct
//
// Everything in this file establishes attribution. None of it establishes
// truth, and no amount of matching quotes can.

import { createHash } from "node:crypto";

export const SCHEMA = "knowledge-reconciliation/1";

/** A rotation policy shorter than a day or longer than a decade is a parse bug. */
export const MIN_DAYS = 1;
export const MAX_DAYS = 3650;

export const MAX_EXTRACTION_BYTES = 4096;
export const MAX_QUOTE_LENGTH = 400;

export class ReconcileError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "ReconcileError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Digests

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
}

export function sha256hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function tagged(kind: string, payload: unknown, prefix: string): string {
  return `${prefix}_${sha256hex(canonicalJson({ kind, payload })).slice(0, 32)}`;
}

// ---------------------------------------------------------------------------
// Host-owned identity

/**
 * The whole matching rule.
 *
 * Project, subject and predicate are supplied by the host. There is no entity
 * resolution here by design: two claims match when the host says they are about
 * the same thing, and never because a model asserted a subject.
 */
export type KnowledgeKey = {
  project: string;
  subject: string;
  predicate: string;
};

export function keyId(key: KnowledgeKey): string {
  return `${key.project}|${key.subject}|${key.predicate}`;
}

export type SourceSnapshot = {
  snapshotId: string;
  project: string;
  sourceId: string;
  sourceRevision: number;
  /** The exact retained bytes, as UTF-8 text. Evidence resolves against these. */
  text: string;
  digest: string;
  /** The interval this document's policy speaks about, decided by the host. */
  policyIntervalStart: string;
};

export function snapshotIdOf(project: string, sourceId: string, sourceRevision: number): string {
  return `${project}|${sourceId}@${sourceRevision}`;
}

export function makeSnapshot(input: {
  project: string;
  sourceId: string;
  sourceRevision: number;
  text: string;
  policyIntervalStart: string;
}): SourceSnapshot {
  if (!input.project || !input.sourceId) {
    throw new ReconcileError("SOURCE_IDENTITY_INVALID", "project and sourceId are required");
  }
  if (!Number.isInteger(input.sourceRevision) || input.sourceRevision < 1) {
    throw new ReconcileError("SOURCE_IDENTITY_INVALID", "sourceRevision must be a positive integer");
  }
  if (input.text.length === 0) {
    throw new ReconcileError("SOURCE_EMPTY", "a source snapshot must retain its bytes");
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.policyIntervalStart)) {
    throw new ReconcileError("INTERVAL_INVALID", "policyIntervalStart must be YYYY-MM-DD");
  }

  return {
    snapshotId: snapshotIdOf(input.project, input.sourceId, input.sourceRevision),
    project: input.project,
    sourceId: input.sourceId,
    sourceRevision: input.sourceRevision,
    text: input.text,
    digest: sha256hex(input.text),
    policyIntervalStart: input.policyIntervalStart,
  };
}

// ---------------------------------------------------------------------------
// Untrusted model output

export type Extraction = {
  rotationDays: number;
  quote: string;
};

/**
 * Parse one extraction. Everything about the input is treated as hostile:
 * oversized, extra fields, wrong types, and out-of-range values are refused
 * rather than coerced, because a coerced value is a fabricated one.
 */
export function parseExtraction(raw: string): Extraction {
  if (Buffer.byteLength(raw, "utf8") > MAX_EXTRACTION_BYTES) {
    throw new ReconcileError("EXTRACTION_TOO_LARGE", `over ${MAX_EXTRACTION_BYTES} bytes`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ReconcileError("EXTRACTION_NOT_JSON", "output did not parse as JSON");
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ReconcileError("EXTRACTION_NOT_OBJECT", "output was not a JSON object");
  }

  const keys = Object.keys(parsed).sort();
  if (keys.length !== 2 || keys[0] !== "quote" || keys[1] !== "rotationDays") {
    throw new ReconcileError(
      "EXTRACTION_FIELDS_UNEXPECTED",
      `expected exactly quote and rotationDays, got ${keys.join(",") || "nothing"}`,
    );
  }

  const record = parsed as { rotationDays: unknown; quote: unknown };

  if (typeof record.rotationDays !== "number" || !Number.isInteger(record.rotationDays)) {
    throw new ReconcileError("VALUE_NOT_INTEGER", "rotationDays must be an integer");
  }
  if (record.rotationDays < MIN_DAYS || record.rotationDays > MAX_DAYS) {
    throw new ReconcileError("VALUE_OUT_OF_RANGE", `rotationDays outside ${MIN_DAYS}..${MAX_DAYS}`);
  }
  if (typeof record.quote !== "string" || record.quote.trim().length === 0) {
    throw new ReconcileError("QUOTE_EMPTY", "quote must be a non-empty string");
  }
  if (record.quote.length > MAX_QUOTE_LENGTH) {
    throw new ReconcileError("QUOTE_TOO_LONG", `quote over ${MAX_QUOTE_LENGTH} characters`);
  }

  return { rotationDays: record.rotationDays, quote: record.quote };
}

export type EvidenceSpan = {
  evidenceId: string;
  snapshotId: string;
  keyId: string;
  quote: string;
  start: number;
  end: number;
};

/**
 * Resolve a quote to a byte range in the retained source.
 *
 * An ambiguous quote is refused rather than resolved to its first occurrence: a
 * citation that points at two places does not identify which one was read, and
 * guessing would put an unreviewable pointer into the evidence record.
 */
export function resolveEvidence(
  snapshot: SourceSnapshot,
  key: KnowledgeKey,
  quote: string,
): EvidenceSpan {
  const start = snapshot.text.indexOf(quote);
  if (start < 0) {
    throw new ReconcileError("QUOTE_NOT_FOUND", "quote does not occur in the retained source");
  }
  if (snapshot.text.indexOf(quote, start + 1) >= 0) {
    throw new ReconcileError("QUOTE_AMBIGUOUS", "quote occurs more than once in the source");
  }

  return {
    evidenceId: tagged("evidence", { snapshotId: snapshot.snapshotId, keyId: keyId(key) }, "ev"),
    snapshotId: snapshot.snapshotId,
    keyId: keyId(key),
    quote,
    start,
    end: start + quote.length,
  };
}

export type Candidate = {
  candidateId: string;
  snapshotId: string;
  keyId: string;
  project: string;
  subject: string;
  predicate: string;
  rotationDays: number;
  quote: string;
  start: number;
  end: number;
  policyIntervalStart: string;
  /** Where the extraction came from: a live artifact, or a labelled synthetic file. */
  extractionRef: string;
  contentDigest: string;
};

export function makeCandidate(input: {
  snapshot: SourceSnapshot;
  key: KnowledgeKey;
  extraction: Extraction;
  evidence: EvidenceSpan;
  extractionRef: string;
}): Candidate {
  if (input.snapshot.project !== input.key.project) {
    throw new ReconcileError(
      "SCOPE_MISMATCH",
      `source is scoped to ${input.snapshot.project}, key to ${input.key.project}`,
    );
  }

  const identity = { snapshotId: input.snapshot.snapshotId, keyId: keyId(input.key) };

  const candidate: Omit<Candidate, "contentDigest"> = {
    candidateId: tagged("candidate", identity, "cand"),
    snapshotId: input.snapshot.snapshotId,
    keyId: keyId(input.key),
    project: input.key.project,
    subject: input.key.subject,
    predicate: input.key.predicate,
    rotationDays: input.extraction.rotationDays,
    quote: input.extraction.quote,
    start: input.evidence.start,
    end: input.evidence.end,
    policyIntervalStart: input.snapshot.policyIntervalStart,
    extractionRef: input.extractionRef,
  };

  return {
    ...candidate,
    // extractionRef is excluded: re-running the same extraction into a new
    // artifact path is a replay, not a different candidate.
    contentDigest: sha256hex(
      canonicalJson({
        candidateId: candidate.candidateId,
        snapshotId: candidate.snapshotId,
        keyId: candidate.keyId,
        rotationDays: candidate.rotationDays,
        quote: candidate.quote,
        start: candidate.start,
        end: candidate.end,
      }),
    ),
  };
}

// ---------------------------------------------------------------------------
// Accepted knowledge

export type AcceptedHead = {
  keyId: string;
  revision: number;
  stateToken: string;
  rotationDays: number;
  policyIntervalStart: string;
  establishingDecisionId: string;
  appliedDecisionId: string;
  evidenceIds: string[];
};

export const NO_ACCEPTED_CLAIM = "none";

/**
 * The token an approval binds to.
 *
 * It covers the value, the interval, and the supporting evidence, so approving
 * "correct 90 to 30" cannot be applied to a claim whose evidence changed under
 * the reviewer after they looked at it.
 */
export function stateTokenOf(input: {
  keyId: string;
  revision: number;
  rotationDays: number;
  policyIntervalStart: string;
  evidenceIds: readonly string[];
  establishingDecisionId: string;
}): string {
  return `st_${sha256hex(
    canonicalJson({
      keyId: input.keyId,
      revision: input.revision,
      rotationDays: input.rotationDays,
      policyIntervalStart: input.policyIntervalStart,
      evidenceIds: [...input.evidenceIds].sort(),
      establishingDecisionId: input.establishingDecisionId,
    }),
  ).slice(0, 32)}`;
}

export type Disposition = "new" | "corroboration" | "conflict";
export type Action = "accept_new" | "reinforce" | "correct" | "reject";

const ALLOWED_ACTIONS: Record<Disposition, Action[]> = {
  new: ["accept_new", "reject"],
  corroboration: ["reinforce", "reject"],
  conflict: ["correct", "reject"],
};

export function actionAllowed(disposition: Disposition, action: Action): boolean {
  return ALLOWED_ACTIONS[disposition].includes(action);
}

export function classify(candidate: Candidate, head: AcceptedHead | null): Disposition {
  if (head === null) return "new";

  // A document about a different interval is a different question. Calling it a
  // correction would relabel the policy actually changing as somebody having
  // been wrong, and this spike deliberately does not implement that case.
  if (head.policyIntervalStart !== candidate.policyIntervalStart) {
    throw new ReconcileError(
      "INTERVAL_CHANGE_UNSUPPORTED",
      `accepted claim covers ${head.policyIntervalStart}, source covers ${candidate.policyIntervalStart}`,
    );
  }

  return head.rotationDays === candidate.rotationDays ? "corroboration" : "conflict";
}

export type Proposal = {
  proposalId: string;
  candidateId: string;
  snapshotId: string;
  keyId: string;
  disposition: Disposition;
  proposedValue: number;
  currentValue: number | null;
  policyIntervalStart: string;
  evidenceId: string;
  /** The reviewed target. An approval is refused if this no longer matches. */
  targetToken: string;
  digest: string;
};

export function makeProposal(input: {
  candidate: Candidate;
  evidence: EvidenceSpan;
  head: AcceptedHead | null;
  disposition: Disposition;
}): Proposal {
  const targetToken = input.head?.stateToken ?? NO_ACCEPTED_CLAIM;

  const body = {
    candidateId: input.candidate.candidateId,
    snapshotId: input.candidate.snapshotId,
    keyId: input.candidate.keyId,
    disposition: input.disposition,
    proposedValue: input.candidate.rotationDays,
    currentValue: input.head?.rotationDays ?? null,
    policyIntervalStart: input.candidate.policyIntervalStart,
    evidenceId: input.evidence.evidenceId,
    targetToken,
  };

  return {
    ...body,
    proposalId: tagged("proposal", body, "prop"),
    digest: sha256hex(canonicalJson(body)),
  };
}

// ---------------------------------------------------------------------------
// Decisions

export type DecisionOrigin = "owner" | "synthetic";

export type DecisionInput = {
  decisionId: string;
  proposalId: string;
  proposalDigest: string;
  targetToken: string;
  action: Action;
  rationale: string;
  operator: string;
  origin: DecisionOrigin;
  decidedAt: string;
};

export function decisionContentDigest(decision: DecisionInput): string {
  return sha256hex(canonicalJson(decision));
}

export function validateDecisionInput(decision: DecisionInput): void {
  if (!decision.decisionId) {
    throw new ReconcileError("DECISION_ID_MISSING", "a decision needs a caller-supplied id");
  }
  if (!decision.operator) {
    throw new ReconcileError("OPERATOR_MISSING", "a decision needs an operator");
  }
  if (decision.rationale.trim().length === 0) {
    throw new ReconcileError("RATIONALE_MISSING", "a decision needs a rationale");
  }
  if (decision.origin !== "owner" && decision.origin !== "synthetic") {
    throw new ReconcileError("ORIGIN_INVALID", "origin must be owner or synthetic");
  }
}

export type AppliedOutcome = {
  decisionId: string;
  action: Action;
  applied: boolean;
  keyId: string;
  revision: number | null;
  stateToken: string | null;
};

/**
 * Compute the revision a decision produces. The caller has already checked the
 * target token; this only decides what the next accepted state looks like.
 *
 * The two distinctions that matter:
 *
 *   reinforce  keeps the value AND the decision that established it. Evidence
 *              accumulates; authority does not move. Repetition cannot promote
 *              a claim.
 *   correct    keeps the interval but replaces the value, and does NOT carry
 *              the old evidence forward: text that supported a wrong number is
 *              not support for the right one. The old revision keeps it.
 */
export function nextRevision(input: {
  head: AcceptedHead | null;
  action: Exclude<Action, "reject">;
  candidate: Candidate;
  evidenceId: string;
  decisionId: string;
}): Omit<AcceptedHead, "stateToken"> & { stateToken: string; previousRevision: number | null } {
  const { head, action, candidate, evidenceId, decisionId } = input;

  const revision = (head?.revision ?? 0) + 1;

  const evidenceIds =
    action === "reinforce" && head
      ? [...new Set([...head.evidenceIds, evidenceId])].sort()
      : [evidenceId];

  const establishingDecisionId =
    action === "reinforce" && head ? head.establishingDecisionId : decisionId;

  const body = {
    keyId: candidate.keyId,
    revision,
    rotationDays: candidate.rotationDays,
    policyIntervalStart: candidate.policyIntervalStart,
    evidenceIds,
    establishingDecisionId,
  };

  return {
    ...body,
    appliedDecisionId: decisionId,
    previousRevision: head?.revision ?? null,
    stateToken: stateTokenOf(body),
  };
}
