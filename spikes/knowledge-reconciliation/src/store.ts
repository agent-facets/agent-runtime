// Neo4j persistence and the one write path that may change accepted knowledge.
//
// Five node kinds, kept apart on purpose:
//
//   (:Source)         retained bytes. Independent of any working context.
//   (:Candidate)      what a model proposed, after validation. Never authority.
//   (:Proposal)       a candidate compared against a specific accepted state.
//   (:Decision)       what an operator decided, bound to a proposal digest.
//   (:ClaimRevision)  accepted knowledge, append-only, one node per revision.
//
// `applyDecision` is the only method that creates a ClaimRevision, and it
// refuses to do so without a decision whose target token still matches what the
// reviewer looked at. There is deliberately no "set the value" method: a store
// that can overwrite a claim is a store where the correction history is
// optional, and this whole spike exists to test that it is not.

import neo4j from "neo4j-driver";
import type { Driver, ManagedTransaction, Session } from "neo4j-driver";

import type {
  AcceptedHead,
  Action,
  AppliedOutcome,
  Candidate,
  DecisionInput,
  Disposition,
  EvidenceSpan,
  KnowledgeKey,
  Proposal,
  SourceSnapshot,
} from "./reconcile.ts";
import {
  ReconcileError,
  actionAllowed,
  classify,
  decisionContentDigest,
  keyId as keyIdOf,
  makeCandidate,
  makeProposal,
  nextRevision,
  parseExtraction,
  resolveEvidence,
  sha256hex,
  validateDecisionInput,
  NO_ACCEPTED_CLAIM,
} from "./reconcile.ts";

const SCHEMA = [
  "CREATE CONSTRAINT kr_source_id IF NOT EXISTS FOR (n:Source) REQUIRE n.snapshotId IS UNIQUE",
  "CREATE CONSTRAINT kr_candidate_id IF NOT EXISTS FOR (n:Candidate) REQUIRE n.candidateId IS UNIQUE",
  "CREATE CONSTRAINT kr_evidence_id IF NOT EXISTS FOR (n:Evidence) REQUIRE n.evidenceId IS UNIQUE",
  "CREATE CONSTRAINT kr_proposal_id IF NOT EXISTS FOR (n:Proposal) REQUIRE n.proposalId IS UNIQUE",
  "CREATE CONSTRAINT kr_decision_id IF NOT EXISTS FOR (n:Decision) REQUIRE n.decisionId IS UNIQUE",
  "CREATE CONSTRAINT kr_key_lock IF NOT EXISTS FOR (n:KeyLock) REQUIRE n.keyId IS UNIQUE",
  "CREATE CONSTRAINT kr_revision IF NOT EXISTS FOR (n:ClaimRevision) REQUIRE (n.keyId, n.revision) IS UNIQUE",
];

const OWNED_LABELS = [
  "Source",
  "Candidate",
  "Evidence",
  "Proposal",
  "Decision",
  "ClaimRevision",
  "KeyLock",
];

function toNum(value: unknown): number {
  if (neo4j.isInt(value)) return (value as { toNumber: () => number }).toNumber();
  return Number(value);
}

type Row = { get: (key: string) => unknown };

export type StagedProposal = {
  proposal: Proposal;
  candidate: Candidate;
  evidence: EvidenceSpan;
  disposition: Disposition;
  head: AcceptedHead | null;
  /** True when this exact staging was already recorded; nothing was added. */
  replay: boolean;
  /** Present once the proposal has been decided. */
  decision: AppliedOutcome | null;
};

export type AcceptedView = {
  keyId: string;
  project: string;
  revision: number;
  stateToken: string;
  rotationDays: number;
  policyIntervalStart: string;
  establishingDecisionId: string;
  appliedDecisionId: string;
  evidence: Array<{
    evidenceId: string;
    quote: string;
    start: number;
    end: number;
    snapshotId: string;
    sourceId: string;
    sourceRevision: number;
    sourceDigest: string;
  }>;
  decision: {
    decisionId: string;
    action: Action;
    operator: string;
    origin: string;
    rationale: string;
    decidedAt: string;
    proposalId: string;
  };
};

export class Store {
  readonly #driver: Driver;

  private constructor(driver: Driver) {
    this.#driver = driver;
  }

  static async connect(uri = process.env.NEO4J_URI ?? "bolt://neo4j:7687"): Promise<Store> {
    const driver = neo4j.driver(uri);
    await driver.getServerInfo();
    return new Store(driver);
  }

  async close(): Promise<void> {
    await this.#driver.close();
  }

  private session(): Session {
    return this.#driver.session();
  }

  async setup(): Promise<void> {
    const session = this.session();
    try {
      for (const statement of SCHEMA) await session.run(statement);
    } finally {
      await session.close();
    }
  }

  /** Wipe everything this spike owns. Tests only; never part of the flow. */
  async reset(): Promise<void> {
    const session = this.session();
    try {
      const match = OWNED_LABELS.map((label) => `n:${label}`).join(" OR ");
      await session.run(`MATCH (n) WHERE ${match} DETACH DELETE n`);
    } finally {
      await session.close();
    }
  }

  // --- sources --------------------------------------------------------------

  /**
   * Retain a source snapshot.
   *
   * Re-storing the same identity with different bytes is refused rather than
   * merged: evidence already points at offsets in the old text, and silently
   * moving the ground under it would invalidate every citation without a trace.
   */
  async putSource(snapshot: SourceSnapshot): Promise<{ created: boolean }> {
    const session = this.session();
    try {
      return await session.executeWrite(async (tx) => {
        const existing = await tx.run(
          "MATCH (s:Source {snapshotId: $snapshotId}) RETURN s.digest AS digest",
          { snapshotId: snapshot.snapshotId },
        );

        const row = existing.records[0];
        if (row) {
          if (String(row.get("digest")) !== snapshot.digest) {
            throw new ReconcileError(
              "SOURCE_IDENTITY_CONFLICT",
              `${snapshot.snapshotId} already exists with different bytes`,
            );
          }
          return { created: false };
        }

        await tx.run(
          `CREATE (s:Source {
             snapshotId: $snapshotId, project: $project, sourceId: $sourceId,
             sourceRevision: $sourceRevision, text: $text, digest: $digest,
             policyIntervalStart: $policyIntervalStart, retainedAt: timestamp()
           })`,
          { ...snapshot, sourceRevision: neo4j.int(snapshot.sourceRevision) },
        );
        return { created: true };
      });
    } finally {
      await session.close();
    }
  }

  async getSource(snapshotId: string): Promise<SourceSnapshot | null> {
    const session = this.session();
    try {
      const result = await session.executeRead((tx) =>
        tx.run("MATCH (s:Source {snapshotId: $snapshotId}) RETURN s", { snapshotId }),
      );
      const row = result.records[0];
      if (!row) return null;
      return readSource(row.get("s") as { properties: Record<string, unknown> });
    } finally {
      await session.close();
    }
  }

  // --- staging --------------------------------------------------------------

  /**
   * Validate an extraction against a retained source and stage a proposal.
   *
   * Nothing here touches accepted knowledge. The result is a pending question
   * for an operator, and staging the same source twice returns the same pending
   * question rather than a second one.
   */
  async stageCandidate(input: {
    snapshotId: string;
    key: KnowledgeKey;
    extractionText: string;
    extractionRef: string;
  }): Promise<StagedProposal> {
    const extraction = parseExtraction(input.extractionText);

    const session = this.session();
    try {
      return await session.executeWrite(async (tx) => {
        await lockKey(tx, keyIdOf(input.key));

        const snapshot = await requireSource(tx, input.snapshotId);
        const evidence = resolveEvidence(snapshot, input.key, extraction.quote);
        const candidate = makeCandidate({
          snapshot,
          key: input.key,
          extraction,
          evidence,
          extractionRef: input.extractionRef,
        });

        const existingCandidate = await tx.run(
          "MATCH (c:Candidate {candidateId: $candidateId}) RETURN c",
          { candidateId: candidate.candidateId },
        );
        const existingRow = existingCandidate.records[0];
        let replay = false;

        if (existingRow) {
          const stored = (existingRow.get("c") as { properties: Record<string, unknown> })
            .properties;
          if (String(stored.contentDigest) !== candidate.contentDigest) {
            // Same source, same key, different answer. One of the two readings
            // is wrong and the store cannot tell which, so it keeps the first
            // and refuses rather than overwriting a cited candidate.
            throw new ReconcileError(
              "CANDIDATE_CONFLICT",
              `${candidate.candidateId} already exists with a different extraction`,
            );
          }
          replay = true;
        } else {
          await tx.run(
            `MATCH (s:Source {snapshotId: $snapshotId})
             CREATE (c:Candidate {
               candidateId: $candidateId, snapshotId: $snapshotId, keyId: $keyId,
               project: $project, subject: $subject, predicate: $predicate,
               rotationDays: $rotationDays, quote: $quote, start: $start, end: $end,
               policyIntervalStart: $policyIntervalStart, extractionRef: $extractionRef,
               contentDigest: $contentDigest, stagedAt: timestamp()
             })
             CREATE (c)-[:FROM_SOURCE]->(s)`,
            {
              ...candidate,
              rotationDays: neo4j.int(candidate.rotationDays),
              start: neo4j.int(candidate.start),
              end: neo4j.int(candidate.end),
            },
          );
        }

        const head = await readHead(tx, candidate.keyId);

        // This source is already part of the accepted claim. Re-reading it is a
        // replay, not fresh corroboration: opening a second question here would
        // let one document appear to support itself twice.
        if (head?.evidenceIds.includes(evidence.evidenceId)) {
          const prior = await readProposalForCandidate(tx, candidate.candidateId);
          if (prior) {
            return {
              proposal: prior,
              candidate,
              evidence,
              disposition: prior.disposition,
              head,
              replay: true,
              decision: await readOutcomeForProposal(tx, prior.proposalId),
            };
          }
        }

        const disposition = classify(candidate, head);
        const proposal = makeProposal({ candidate, evidence, head, disposition });

        const existingProposal = await tx.run(
          "MATCH (p:Proposal {proposalId: $proposalId}) RETURN p.digest AS digest, p.state AS state",
          { proposalId: proposal.proposalId },
        );

        if (existingProposal.records.length === 0) {
          await tx.run(
            `MATCH (c:Candidate {candidateId: $candidateId})
             CREATE (p:Proposal {
               proposalId: $proposalId, candidateId: $candidateId, snapshotId: $snapshotId,
               keyId: $keyId, disposition: $disposition, proposedValue: $proposedValue,
               currentValue: $currentValue, policyIntervalStart: $policyIntervalStart,
               evidenceId: $evidenceId, targetToken: $targetToken, digest: $digest,
               state: 'pending', createdAt: timestamp()
             })
             CREATE (p)-[:FROM_CANDIDATE]->(c)`,
            {
              ...proposal,
              proposedValue: neo4j.int(proposal.proposedValue),
              currentValue:
                proposal.currentValue === null ? null : neo4j.int(proposal.currentValue),
            },
          );
        } else {
          replay = true;
        }

        const decision = await readOutcomeForProposal(tx, proposal.proposalId);

        return { proposal, candidate, evidence, disposition, head, replay, decision };
      });
    } finally {
      await session.close();
    }
  }

  async getProposal(proposalId: string): Promise<(Proposal & { state: string }) | null> {
    const session = this.session();
    try {
      const result = await session.executeRead((tx) =>
        tx.run("MATCH (p:Proposal {proposalId: $proposalId}) RETURN p", { proposalId }),
      );
      const row = result.records[0];
      if (!row) return null;
      return readProposal(row.get("p") as { properties: Record<string, unknown> });
    } finally {
      await session.close();
    }
  }

  async listPending(project: string): Promise<Array<Proposal & { state: string }>> {
    const session = this.session();
    try {
      const result = await session.executeRead((tx) =>
        tx.run(
          `MATCH (p:Proposal {state: 'pending'})
           WHERE p.keyId STARTS WITH $prefix
           RETURN p ORDER BY p.createdAt`,
          { prefix: `${project}|` },
        ),
      );
      return result.records.map((row) =>
        readProposal(row.get("p") as { properties: Record<string, unknown> }),
      );
    } finally {
      await session.close();
    }
  }

  // --- the write path -------------------------------------------------------

  /**
   * Apply an operator decision.
   *
   * The order inside the transaction is deliberate. The decision and evidence
   * are written BEFORE the accepted state is re-checked, so a stale approval
   * aborts with the decision record already created — and the rollback has to
   * remove it. That is the atomicity claim being tested, rather than asserted.
   */
  async applyDecision(decision: DecisionInput): Promise<AppliedOutcome> {
    validateDecisionInput(decision);
    const contentDigest = decisionContentDigest(decision);

    const session = this.session();
    try {
      return await session.executeWrite(async (tx) => {
        const proposalRow = await tx.run(
          "MATCH (p:Proposal {proposalId: $proposalId}) RETURN p",
          { proposalId: decision.proposalId },
        );
        const found = proposalRow.records[0];
        if (!found) {
          throw new ReconcileError("PROPOSAL_UNKNOWN", `no proposal ${decision.proposalId}`);
        }
        const proposal = readProposal(found.get("p") as { properties: Record<string, unknown> });

        await lockKey(tx, proposal.keyId);

        // Idempotent replay: same id, same content, already applied.
        const priorRow = await tx.run(
          "MATCH (d:Decision {decisionId: $decisionId}) RETURN d.contentDigest AS digest, d.outcome AS outcome",
          { decisionId: decision.decisionId },
        );
        const prior = priorRow.records[0];
        if (prior) {
          if (String(prior.get("digest")) !== contentDigest) {
            throw new ReconcileError(
              "DECISION_ID_REUSED",
              `${decision.decisionId} already records a different decision`,
            );
          }
          return JSON.parse(String(prior.get("outcome"))) as AppliedOutcome;
        }

        if (proposal.digest !== decision.proposalDigest) {
          throw new ReconcileError(
            "PROPOSAL_DIGEST_MISMATCH",
            "the approved proposal is not the stored one",
          );
        }
        if (proposal.state !== "pending") {
          throw new ReconcileError(
            "PROPOSAL_ALREADY_DECIDED",
            `proposal ${proposal.proposalId} is ${proposal.state}`,
          );
        }
        if (proposal.targetToken !== decision.targetToken) {
          throw new ReconcileError(
            "APPROVAL_TARGET_MISMATCH",
            "the decision names a different target than the proposal",
          );
        }
        if (!actionAllowed(proposal.disposition, decision.action)) {
          throw new ReconcileError(
            "ACTION_NOT_ALLOWED",
            `${decision.action} is not available for a ${proposal.disposition} proposal`,
          );
        }

        const candidate = await requireCandidate(tx, proposal.candidateId);
        const snapshot = await requireSource(tx, proposal.snapshotId);

        if (sha256hex(snapshot.text) !== snapshot.digest) {
          throw new ReconcileError("SOURCE_DIGEST_MISMATCH", "retained source failed its digest");
        }
        if (snapshot.text.slice(candidate.start, candidate.end) !== candidate.quote) {
          throw new ReconcileError(
            "EVIDENCE_UNRESOLVED",
            "the cited span no longer matches the retained source",
          );
        }

        await tx.run(
          `MATCH (p:Proposal {proposalId: $proposalId})
           CREATE (d:Decision {
             decisionId: $decisionId, proposalId: $proposalId, proposalDigest: $proposalDigest,
             targetToken: $targetToken, action: $action, rationale: $rationale,
             operator: $operator, origin: $origin, decidedAt: $decidedAt,
             contentDigest: $contentDigest, recordedAt: timestamp()
           })
           CREATE (d)-[:DECIDES]->(p)
           SET p.state = $state`,
          {
            ...decision,
            contentDigest,
            state: decision.action === "reject" ? "rejected" : "accepted",
          },
        );

        // Re-read the head AFTER writing, so the refusal below has something to
        // roll back and the test can prove nothing partial survives.
        const head = await readHead(tx, proposal.keyId);
        const currentToken = head?.stateToken ?? NO_ACCEPTED_CLAIM;
        if (currentToken !== decision.targetToken) {
          throw new ReconcileError(
            "STALE_TARGET",
            `accepted state moved to ${currentToken} since review`,
          );
        }

        let outcome: AppliedOutcome = {
          decisionId: decision.decisionId,
          action: decision.action,
          applied: false,
          keyId: proposal.keyId,
          revision: head?.revision ?? null,
          stateToken: head?.stateToken ?? null,
        };

        if (decision.action !== "reject") {
          await tx.run(
            `MATCH (s:Source {snapshotId: $snapshotId})
             MERGE (e:Evidence {evidenceId: $evidenceId})
               ON CREATE SET e.snapshotId = $snapshotId, e.keyId = $keyId, e.quote = $quote,
                             e.start = $start, e.end = $end
             MERGE (e)-[:FROM]->(s)`,
            {
              evidenceId: proposal.evidenceId,
              snapshotId: proposal.snapshotId,
              keyId: proposal.keyId,
              quote: candidate.quote,
              start: neo4j.int(candidate.start),
              end: neo4j.int(candidate.end),
            },
          );

          const next = nextRevision({
            head,
            action: decision.action,
            candidate,
            evidenceId: proposal.evidenceId,
            decisionId: decision.decisionId,
          });

          await tx.run(
            `MATCH (d:Decision {decisionId: $decisionId})
             CREATE (r:ClaimRevision {
               keyId: $keyId, revision: $revision, stateToken: $stateToken,
               rotationDays: $rotationDays, policyIntervalStart: $policyIntervalStart,
               establishingDecisionId: $establishingDecisionId,
               appliedDecisionId: $appliedDecisionId, evidenceIds: $evidenceIds,
               previousRevision: $previousRevision, acceptedAt: timestamp()
             })
             CREATE (r)-[:APPLIED_BY]->(d)
             WITH r
             MATCH (e:Evidence) WHERE e.evidenceId IN $evidenceIds
             CREATE (r)-[:SUPPORTED_BY]->(e)`,
            {
              decisionId: decision.decisionId,
              keyId: next.keyId,
              revision: neo4j.int(next.revision),
              stateToken: next.stateToken,
              rotationDays: neo4j.int(next.rotationDays),
              policyIntervalStart: next.policyIntervalStart,
              establishingDecisionId: next.establishingDecisionId,
              appliedDecisionId: next.appliedDecisionId,
              evidenceIds: next.evidenceIds,
              previousRevision:
                next.previousRevision === null ? null : neo4j.int(next.previousRevision),
            },
          );

          if (next.previousRevision !== null) {
            await tx.run(
              `MATCH (r:ClaimRevision {keyId: $keyId, revision: $revision})
               MATCH (prev:ClaimRevision {keyId: $keyId, revision: $previousRevision})
               CREATE (r)-[:PREVIOUS]->(prev)`,
              {
                keyId: next.keyId,
                revision: neo4j.int(next.revision),
                previousRevision: neo4j.int(next.previousRevision),
              },
            );
          }

          outcome = {
            decisionId: decision.decisionId,
            action: decision.action,
            applied: true,
            keyId: next.keyId,
            revision: next.revision,
            stateToken: next.stateToken,
          };
        }

        await tx.run("MATCH (d:Decision {decisionId: $decisionId}) SET d.outcome = $outcome", {
          decisionId: decision.decisionId,
          outcome: JSON.stringify(outcome),
        });

        return outcome;
      });
    } catch (error) {
      const code = String((error as { code?: string })?.code ?? "");
      if (code.includes("ConstraintValidationFailed")) {
        throw new ReconcileError("STALE_TARGET", "a concurrent writer created this revision first");
      }
      throw error;
    } finally {
      await session.close();
    }
  }

  // --- reading --------------------------------------------------------------

  /**
   * What a later task sees. Scope and key only; no transcript, no candidates.
   *
   * Pending and rejected proposals are simply not reachable from here — the
   * query starts at accepted revisions, so excluding them is structural rather
   * than a filter somebody has to remember to write.
   */
  async readAccepted(key: KnowledgeKey): Promise<AcceptedView | null> {
    const session = this.session();
    try {
      const result = await session.executeRead((tx) =>
        tx.run(
          `MATCH (r:ClaimRevision {keyId: $keyId})
           WITH r ORDER BY r.revision DESC LIMIT 1
           MATCH (r)-[:APPLIED_BY]->(d:Decision)
           OPTIONAL MATCH (r)-[:SUPPORTED_BY]->(e:Evidence)-[:FROM]->(s:Source)
           RETURN r, d, collect({evidence: e, source: s}) AS support`,
          { keyId: keyIdOf(key) },
        ),
      );

      const row = result.records[0];
      if (!row) return null;
      return readAcceptedView(key, row);
    } finally {
      await session.close();
    }
  }

  async listRevisions(key: KnowledgeKey): Promise<
    Array<{
      revision: number;
      rotationDays: number;
      stateToken: string;
      establishingDecisionId: string;
      appliedDecisionId: string;
      evidenceIds: string[];
      previousRevision: number | null;
      action: Action;
      rationale: string;
      operator: string;
      origin: string;
      decidedAt: string;
    }>
  > {
    const session = this.session();
    try {
      const result = await session.executeRead((tx) =>
        tx.run(
          `MATCH (r:ClaimRevision {keyId: $keyId})-[:APPLIED_BY]->(d:Decision)
           RETURN r, d ORDER BY r.revision`,
          { keyId: keyIdOf(key) },
        ),
      );

      return result.records.map((row) => {
        const revision = (row.get("r") as { properties: Record<string, unknown> }).properties;
        const decision = (row.get("d") as { properties: Record<string, unknown> }).properties;
        return {
          revision: toNum(revision.revision),
          rotationDays: toNum(revision.rotationDays),
          stateToken: String(revision.stateToken),
          establishingDecisionId: String(revision.establishingDecisionId),
          appliedDecisionId: String(revision.appliedDecisionId),
          evidenceIds: (revision.evidenceIds ?? []) as string[],
          previousRevision:
            revision.previousRevision === null || revision.previousRevision === undefined
              ? null
              : toNum(revision.previousRevision),
          action: String(decision.action) as Action,
          rationale: String(decision.rationale),
          operator: String(decision.operator),
          origin: String(decision.origin),
          decidedAt: String(decision.decidedAt),
        };
      });
    } finally {
      await session.close();
    }
  }

  async countNodes(label: string): Promise<number> {
    if (!OWNED_LABELS.includes(label)) {
      throw new ReconcileError("LABEL_NOT_OWNED", `${label} is not owned by this spike`);
    }
    const session = this.session();
    try {
      const result = await session.executeRead((tx) =>
        tx.run(`MATCH (n:${label}) RETURN count(n) AS n`),
      );
      return toNum(result.records[0]?.get("n"));
    } finally {
      await session.close();
    }
  }
}

// ---------------------------------------------------------------------------
// Transaction helpers

/**
 * Serialize writers on one knowledge key.
 *
 * The SET is load-bearing: MERGE alone may not take a write lock, and a bare
 * read-then-check has no lock at all, which is exactly the race the earlier
 * spike's working record documents.
 */
async function lockKey(tx: ManagedTransaction, keyId: string): Promise<void> {
  await tx.run("MERGE (l:KeyLock {keyId: $keyId}) SET l.updatedAt = timestamp()", { keyId });
}

async function requireSource(tx: ManagedTransaction, snapshotId: string): Promise<SourceSnapshot> {
  const result = await tx.run("MATCH (s:Source {snapshotId: $snapshotId}) RETURN s", {
    snapshotId,
  });
  const row = result.records[0];
  if (!row) {
    throw new ReconcileError("SOURCE_UNKNOWN", `no retained source ${snapshotId}`);
  }
  return readSource(row.get("s") as { properties: Record<string, unknown> });
}

async function requireCandidate(tx: ManagedTransaction, candidateId: string): Promise<Candidate> {
  const result = await tx.run("MATCH (c:Candidate {candidateId: $candidateId}) RETURN c", {
    candidateId,
  });
  const row = result.records[0];
  if (!row) {
    throw new ReconcileError("CANDIDATE_UNKNOWN", `no candidate ${candidateId}`);
  }
  const properties = (row.get("c") as { properties: Record<string, unknown> }).properties;
  return {
    candidateId: String(properties.candidateId),
    snapshotId: String(properties.snapshotId),
    keyId: String(properties.keyId),
    project: String(properties.project),
    subject: String(properties.subject),
    predicate: String(properties.predicate),
    rotationDays: toNum(properties.rotationDays),
    quote: String(properties.quote),
    start: toNum(properties.start),
    end: toNum(properties.end),
    policyIntervalStart: String(properties.policyIntervalStart),
    extractionRef: String(properties.extractionRef),
    contentDigest: String(properties.contentDigest),
  };
}

async function readHead(tx: ManagedTransaction, keyId: string): Promise<AcceptedHead | null> {
  const result = await tx.run(
    `MATCH (r:ClaimRevision {keyId: $keyId})
     RETURN r ORDER BY r.revision DESC LIMIT 1`,
    { keyId },
  );
  const row = result.records[0];
  if (!row) return null;

  const properties = (row.get("r") as { properties: Record<string, unknown> }).properties;
  return {
    keyId: String(properties.keyId),
    revision: toNum(properties.revision),
    stateToken: String(properties.stateToken),
    rotationDays: toNum(properties.rotationDays),
    policyIntervalStart: String(properties.policyIntervalStart),
    establishingDecisionId: String(properties.establishingDecisionId),
    appliedDecisionId: String(properties.appliedDecisionId),
    evidenceIds: (properties.evidenceIds ?? []) as string[],
  };
}

async function readProposalForCandidate(
  tx: ManagedTransaction,
  candidateId: string,
): Promise<(Proposal & { state: string }) | null> {
  const result = await tx.run(
    `MATCH (p:Proposal {candidateId: $candidateId})
     RETURN p ORDER BY CASE p.state WHEN 'accepted' THEN 0 ELSE 1 END, p.createdAt
     LIMIT 1`,
    { candidateId },
  );
  const row = result.records[0];
  if (!row) return null;
  return readProposal(row.get("p") as { properties: Record<string, unknown> });
}

async function readOutcomeForProposal(
  tx: ManagedTransaction,
  proposalId: string,
): Promise<AppliedOutcome | null> {
  const result = await tx.run(
    "MATCH (d:Decision {proposalId: $proposalId}) RETURN d.outcome AS outcome LIMIT 1",
    { proposalId },
  );
  const row = result.records[0];
  const outcome = row?.get("outcome");
  if (!row || outcome === null || outcome === undefined) return null;
  return JSON.parse(String(outcome)) as AppliedOutcome;
}

// ---------------------------------------------------------------------------
// Row mapping

function readSource(node: { properties: Record<string, unknown> }): SourceSnapshot {
  const properties = node.properties;
  return {
    snapshotId: String(properties.snapshotId),
    project: String(properties.project),
    sourceId: String(properties.sourceId),
    sourceRevision: toNum(properties.sourceRevision),
    text: String(properties.text),
    digest: String(properties.digest),
    policyIntervalStart: String(properties.policyIntervalStart),
  };
}

function readProposal(node: { properties: Record<string, unknown> }): Proposal & { state: string } {
  const properties = node.properties;
  return {
    proposalId: String(properties.proposalId),
    candidateId: String(properties.candidateId),
    snapshotId: String(properties.snapshotId),
    keyId: String(properties.keyId),
    disposition: String(properties.disposition) as Disposition,
    proposedValue: toNum(properties.proposedValue),
    currentValue:
      properties.currentValue === null || properties.currentValue === undefined
        ? null
        : toNum(properties.currentValue),
    policyIntervalStart: String(properties.policyIntervalStart),
    evidenceId: String(properties.evidenceId),
    targetToken: String(properties.targetToken),
    digest: String(properties.digest),
    state: String(properties.state),
  };
}

function readAcceptedView(key: KnowledgeKey, row: Row): AcceptedView {
  const revision = (row.get("r") as { properties: Record<string, unknown> }).properties;
  const decision = (row.get("d") as { properties: Record<string, unknown> }).properties;
  const support = (row.get("support") ?? []) as Array<{
    evidence: { properties: Record<string, unknown> } | null;
    source: { properties: Record<string, unknown> } | null;
  }>;

  return {
    keyId: String(revision.keyId),
    project: key.project,
    revision: toNum(revision.revision),
    stateToken: String(revision.stateToken),
    rotationDays: toNum(revision.rotationDays),
    policyIntervalStart: String(revision.policyIntervalStart),
    establishingDecisionId: String(revision.establishingDecisionId),
    appliedDecisionId: String(revision.appliedDecisionId),
    evidence: support
      .filter((item) => item.evidence !== null && item.source !== null)
      .map((item) => {
        const evidence = item.evidence!.properties;
        const source = item.source!.properties;
        return {
          evidenceId: String(evidence.evidenceId),
          quote: String(evidence.quote),
          start: toNum(evidence.start),
          end: toNum(evidence.end),
          snapshotId: String(source.snapshotId),
          sourceId: String(source.sourceId),
          sourceRevision: toNum(source.sourceRevision),
          sourceDigest: String(source.digest),
        };
      })
      .sort((a, b) => (a.evidenceId < b.evidenceId ? -1 : 1)),
    decision: {
      decisionId: String(decision.decisionId),
      action: String(decision.action) as Action,
      operator: String(decision.operator),
      origin: String(decision.origin),
      rationale: String(decision.rationale),
      decidedAt: String(decision.decidedAt),
      proposalId: String(decision.proposalId),
    },
  };
}
