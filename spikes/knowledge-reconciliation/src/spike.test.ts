// Reconciliation mechanics, against a real Neo4j.
//
// Every decision in this file is `origin: "synthetic"` and every operator is
// "test-suite". None of it is an owner review, and none of it may be cited as
// one. What these tests demonstrate is that the machinery behaves as described
// — not that any extracted claim is true.

import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import type { Action, DecisionOrigin, KnowledgeKey, SourceSnapshot } from "./reconcile.ts";
import { ReconcileError, makeSnapshot } from "./reconcile.ts";
import type { StagedProposal } from "./store.ts";
import { Store } from "./store.ts";

const HARBOR: KnowledgeKey = {
  project: "synthetic:harbor",
  subject: "production-service-credentials",
  predicate: "rotation-days",
};

const CEDAR: KnowledgeKey = { ...HARBOR, project: "synthetic:cedar" };

let store: Store;

before(async () => {
  store = await Store.connect();
  await store.setup();
});

after(async () => {
  await store.close();
});

beforeEach(async () => {
  await store.reset();
});

// --- helpers ---------------------------------------------------------------

function doc(marker: string, days: number): string {
  return [
    `Synthetic ${marker} policy. Test data, not a real organisation.`,
    "",
    `Effective 2026-01-01, production service credentials must be rotated every ${days} days.`,
    "",
  ].join("\n");
}

function snapshot(input: {
  key: KnowledgeKey;
  sourceId: string;
  revision?: number;
  days: number;
  intervalStart?: string;
  text?: string;
}): SourceSnapshot {
  return makeSnapshot({
    project: input.key.project,
    sourceId: input.sourceId,
    sourceRevision: input.revision ?? 1,
    text: input.text ?? doc(input.sourceId, input.days),
    policyIntervalStart: input.intervalStart ?? "2026-01-01",
  });
}

function quoteFor(days: number): string {
  return `rotated every ${days} days`;
}

async function stage(input: {
  source: SourceSnapshot;
  key: KnowledgeKey;
  days: number;
  quote?: string;
}): Promise<StagedProposal> {
  await store.putSource(input.source);
  return store.stageCandidate({
    snapshotId: input.source.snapshotId,
    key: input.key,
    extractionText: JSON.stringify({
      rotationDays: input.days,
      quote: input.quote ?? quoteFor(input.days),
    }),
    extractionRef: "synthetic:test-suite",
  });
}

async function decide(input: {
  staged: StagedProposal;
  action: Action;
  decisionId: string;
  rationale?: string;
  origin?: DecisionOrigin;
  targetToken?: string;
}) {
  return store.applyDecision({
    decisionId: input.decisionId,
    proposalId: input.staged.proposal.proposalId,
    proposalDigest: input.staged.proposal.digest,
    targetToken: input.targetToken ?? input.staged.proposal.targetToken,
    action: input.action,
    rationale: input.rationale ?? "synthetic test decision",
    operator: "test-suite",
    origin: input.origin ?? "synthetic",
    decidedAt: "2026-01-02T00:00:00.000Z",
  });
}

async function codeOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    return error instanceof ReconcileError ? error.code : `UNEXPECTED:${String(error)}`;
  }
  return "NO_ERROR";
}

/** Accept a starting value the way the demo does: through the real write path. */
async function baseline(key: KnowledgeKey, sourceId: string, days: number) {
  const staged = await stage({ source: snapshot({ key, sourceId, days }), key, days });
  await decide({ staged, action: "accept_new", decisionId: `dec-baseline-${sourceId}` });
  return staged;
}

// --- tests -----------------------------------------------------------------

test("new information is pending, not accepted", async () => {
  const staged = await stage({
    source: snapshot({ key: HARBOR, sourceId: "harbor-policy", days: 45 }),
    key: HARBOR,
    days: 45,
  });

  assert.equal(staged.disposition, "new");
  assert.equal(staged.proposal.targetToken, "none");
  assert.equal(staged.decision, null);
  assert.equal(await store.readAccepted(HARBOR), null);

  const pending = await store.listPending(HARBOR.project);
  assert.equal(pending.length, 1);
  assert.equal(pending[0]?.state, "pending");
});

test("replaying the same source adds no second claim or evidence", async () => {
  const source = snapshot({ key: HARBOR, sourceId: "harbor-policy", days: 45 });
  const first = await stage({ source, key: HARBOR, days: 45 });
  await decide({ staged: first, action: "accept_new", decisionId: "dec-1" });

  const replay = await stage({ source, key: HARBOR, days: 45 });

  assert.equal(replay.replay, true);
  assert.equal(replay.proposal.proposalId, first.proposal.proposalId);
  assert.equal(replay.decision?.decisionId, "dec-1");
  assert.equal(await store.countNodes("Candidate"), 1);
  assert.equal(await store.countNodes("Evidence"), 1);
  assert.equal(await store.countNodes("ClaimRevision"), 1);

  // No second question was opened: a document cannot corroborate itself.
  assert.equal(await store.countNodes("Proposal"), 1);
  assert.equal((await store.listPending(HARBOR.project)).length, 0);
  assert.equal((await store.readAccepted(HARBOR))?.evidence.length, 1);
});

test("a second reading of one source cannot overwrite the first", async () => {
  const source = snapshot({ key: HARBOR, sourceId: "harbor-policy", days: 45 });
  await stage({ source, key: HARBOR, days: 45 });

  const code = await codeOf(() =>
    store.stageCandidate({
      snapshotId: source.snapshotId,
      key: HARBOR,
      extractionText: JSON.stringify({ rotationDays: 45, quote: "Effective 2026-01-01" }),
      extractionRef: "synthetic:test-suite",
    }),
  );

  assert.equal(code, "CANDIDATE_CONFLICT");
});

test("corroboration adds evidence and moves no authority", async () => {
  const first = await baseline(HARBOR, "harbor-policy", 45);

  const second = await stage({
    source: snapshot({ key: HARBOR, sourceId: "harbor-handbook", days: 45 }),
    key: HARBOR,
    days: 45,
  });
  assert.equal(second.disposition, "corroboration");

  await decide({ staged: second, action: "reinforce", decisionId: "dec-reinforce" });

  const accepted = await store.readAccepted(HARBOR);
  assert.equal(accepted?.rotationDays, 45);
  assert.equal(accepted?.revision, 2);
  assert.equal(accepted?.evidence.length, 2);
  // The claim is still established by the original decision. Repetition did not
  // promote it, and the reinforcing decision is recorded separately.
  assert.equal(accepted?.establishingDecisionId, `dec-baseline-harbor-policy`);
  assert.equal(accepted?.appliedDecisionId, "dec-reinforce");
  assert.notEqual(first.proposal.proposalId, second.proposal.proposalId);
});

test("a conflicting value stays pending and does not overwrite", async () => {
  await baseline(CEDAR, "cedar-policy", 90);

  const conflict = await stage({
    source: snapshot({ key: CEDAR, sourceId: "cedar-policy", revision: 2, days: 30 }),
    key: CEDAR,
    days: 30,
  });

  assert.equal(conflict.disposition, "conflict");
  assert.equal(conflict.proposal.currentValue, 90);

  const accepted = await store.readAccepted(CEDAR);
  assert.equal(accepted?.rotationDays, 90);
  assert.equal(accepted?.revision, 1);
});

test("rejection leaves accepted knowledge untouched", async () => {
  await baseline(CEDAR, "cedar-policy", 90);

  const conflict = await stage({
    source: snapshot({ key: CEDAR, sourceId: "cedar-policy", revision: 2, days: 30 }),
    key: CEDAR,
    days: 30,
  });
  const outcome = await decide({
    staged: conflict,
    action: "reject",
    decisionId: "dec-reject",
    rationale: "synthetic: not accepting this reading",
  });

  assert.equal(outcome.applied, false);
  const accepted = await store.readAccepted(CEDAR);
  assert.equal(accepted?.rotationDays, 90);
  assert.equal(accepted?.revision, 1);
  assert.equal((await store.getProposal(conflict.proposal.proposalId))?.state, "rejected");
});

test("an approved correction preserves the previous claim and its rationale", async () => {
  await baseline(CEDAR, "cedar-policy", 90);

  const conflict = await stage({
    source: snapshot({ key: CEDAR, sourceId: "cedar-policy", revision: 2, days: 30 }),
    key: CEDAR,
    days: 30,
  });
  await decide({
    staged: conflict,
    action: "correct",
    decisionId: "dec-correct",
    rationale: "synthetic: the 90 was a transcription error",
  });

  const accepted = await store.readAccepted(CEDAR);
  assert.equal(accepted?.rotationDays, 30);
  assert.equal(accepted?.revision, 2);
  // Evidence for the wrong value is not support for the right one.
  assert.equal(accepted?.evidence.length, 1);
  assert.equal(accepted?.evidence[0]?.sourceRevision, 2);

  const history = await store.listRevisions(CEDAR);
  assert.equal(history.length, 2);
  assert.equal(history[0]?.rotationDays, 90);
  assert.equal(history[0]?.rationale, "synthetic test decision");
  assert.equal(history[1]?.rotationDays, 30);
  assert.equal(history[1]?.rationale, "synthetic: the 90 was a transcription error");
  assert.equal(history[1]?.previousRevision, 1);
});

test("a stale approval is refused and leaves nothing behind", async () => {
  await baseline(CEDAR, "cedar-policy", 90);

  const first = await stage({
    source: snapshot({ key: CEDAR, sourceId: "cedar-policy", revision: 2, days: 30 }),
    key: CEDAR,
    days: 30,
  });
  const second = await stage({
    source: snapshot({ key: CEDAR, sourceId: "cedar-memo", days: 60 }),
    key: CEDAR,
    days: 60,
  });

  await decide({ staged: first, action: "correct", decisionId: "dec-first" });

  const decisionsBefore = await store.countNodes("Decision");
  const code = await codeOf(() =>
    decide({ staged: second, action: "correct", decisionId: "dec-stale" }),
  );

  assert.equal(code, "STALE_TARGET");
  // The refused decision was written before the check and must be rolled back.
  assert.equal(await store.countNodes("Decision"), decisionsBefore);
  assert.equal((await store.readAccepted(CEDAR))?.rotationDays, 30);
  assert.equal((await store.getProposal(second.proposal.proposalId))?.state, "pending");
});

test("applying the same decision twice is idempotent", async () => {
  const staged = await stage({
    source: snapshot({ key: HARBOR, sourceId: "harbor-policy", days: 45 }),
    key: HARBOR,
    days: 45,
  });

  const first = await decide({ staged, action: "accept_new", decisionId: "dec-once" });
  const second = await decide({ staged, action: "accept_new", decisionId: "dec-once" });

  assert.deepEqual(first, second);
  assert.equal(await store.countNodes("ClaimRevision"), 1);
  assert.equal(await store.countNodes("Decision"), 1);
});

test("reusing a decision id for different content is refused", async () => {
  const staged = await stage({
    source: snapshot({ key: HARBOR, sourceId: "harbor-policy", days: 45 }),
    key: HARBOR,
    days: 45,
  });
  await decide({ staged, action: "accept_new", decisionId: "dec-once" });

  const code = await codeOf(() =>
    decide({
      staged,
      action: "accept_new",
      decisionId: "dec-once",
      rationale: "synthetic: a different rationale entirely",
    }),
  );

  assert.equal(code, "DECISION_ID_REUSED");
});

test("concurrent approvals of the same target: one wins, one is refused", async () => {
  await baseline(CEDAR, "cedar-policy", 90);

  const first = await stage({
    source: snapshot({ key: CEDAR, sourceId: "cedar-policy", revision: 2, days: 30 }),
    key: CEDAR,
    days: 30,
  });
  const second = await stage({
    source: snapshot({ key: CEDAR, sourceId: "cedar-memo", days: 60 }),
    key: CEDAR,
    days: 60,
  });

  const results = await Promise.allSettled([
    decide({ staged: first, action: "correct", decisionId: "dec-race-a" }),
    decide({ staged: second, action: "correct", decisionId: "dec-race-b" }),
  ]);

  const fulfilled = results.filter((result) => result.status === "fulfilled");
  const rejected = results.filter((result) => result.status === "rejected");

  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.equal(
    (rejected[0] as PromiseRejectedResult).reason instanceof ReconcileError
      ? ((rejected[0] as PromiseRejectedResult).reason as ReconcileError).code
      : "UNEXPECTED",
    "STALE_TARGET",
  );
  assert.equal(await store.countNodes("ClaimRevision"), 2);
  assert.equal(await store.countNodes("Decision"), 2);
});

test("approvals cannot be moved to a different proposal or digest", async () => {
  const staged = await stage({
    source: snapshot({ key: HARBOR, sourceId: "harbor-policy", days: 45 }),
    key: HARBOR,
    days: 45,
  });

  const wrongDigest = await codeOf(() =>
    store.applyDecision({
      decisionId: "dec-bad-digest",
      proposalId: staged.proposal.proposalId,
      proposalDigest: "0".repeat(64),
      targetToken: staged.proposal.targetToken,
      action: "accept_new",
      rationale: "synthetic",
      operator: "test-suite",
      origin: "synthetic",
      decidedAt: "2026-01-02T00:00:00.000Z",
    }),
  );
  assert.equal(wrongDigest, "PROPOSAL_DIGEST_MISMATCH");

  const wrongTarget = await codeOf(() =>
    decide({ staged, action: "accept_new", decisionId: "dec-bad-target", targetToken: "st_made_up" }),
  );
  assert.equal(wrongTarget, "APPROVAL_TARGET_MISMATCH");

  const wrongAction = await codeOf(() =>
    decide({ staged, action: "correct", decisionId: "dec-bad-action" }),
  );
  assert.equal(wrongAction, "ACTION_NOT_ALLOWED");

  assert.equal(await store.countNodes("Decision"), 0);
  assert.equal(await store.readAccepted(HARBOR), null);
});

test("unknown sources, fabricated quotes, and wrong scopes are refused", async () => {
  const source = snapshot({ key: HARBOR, sourceId: "harbor-policy", days: 45 });

  const missing = await codeOf(() =>
    store.stageCandidate({
      snapshotId: "synthetic:harbor|not-a-source@1",
      key: HARBOR,
      extractionText: JSON.stringify({ rotationDays: 45, quote: quoteFor(45) }),
      extractionRef: "synthetic:test-suite",
    }),
  );
  assert.equal(missing, "SOURCE_UNKNOWN");

  await store.putSource(source);

  const fabricated = await codeOf(() =>
    store.stageCandidate({
      snapshotId: source.snapshotId,
      key: HARBOR,
      extractionText: JSON.stringify({ rotationDays: 45, quote: "rotated every 45 days, approved" }),
      extractionRef: "synthetic:test-suite",
    }),
  );
  assert.equal(fabricated, "QUOTE_NOT_FOUND");

  const scope = await codeOf(() =>
    store.stageCandidate({
      snapshotId: source.snapshotId,
      key: CEDAR,
      extractionText: JSON.stringify({ rotationDays: 45, quote: quoteFor(45) }),
      extractionRef: "synthetic:test-suite",
    }),
  );
  assert.equal(scope, "SCOPE_MISMATCH");

  assert.equal(await store.countNodes("Candidate"), 0);
});

test("re-using a source identity for different bytes is refused", async () => {
  const original = snapshot({ key: HARBOR, sourceId: "harbor-policy", days: 45 });
  await store.putSource(original);

  const rewritten = snapshot({ key: HARBOR, sourceId: "harbor-policy", days: 60 });
  assert.equal(await codeOf(() => store.putSource(rewritten)), "SOURCE_IDENTITY_CONFLICT");

  const stored = await store.getSource(original.snapshotId);
  assert.equal(stored?.digest, original.digest);
});

test("a document about a different interval is not treated as a correction", async () => {
  await baseline(CEDAR, "cedar-policy", 90);

  const code = await codeOf(() =>
    stage({
      source: snapshot({
        key: CEDAR,
        sourceId: "cedar-policy",
        revision: 2,
        days: 30,
        intervalStart: "2027-01-01",
      }),
      key: CEDAR,
      days: 30,
    }),
  );

  assert.equal(code, "INTERVAL_CHANGE_UNSUPPORTED");
  assert.equal((await store.readAccepted(CEDAR))?.rotationDays, 90);
});

test("accepted reads are scoped, and expose provenance without candidates", async () => {
  await baseline(HARBOR, "harbor-policy", 45);
  await stage({
    source: snapshot({ key: CEDAR, sourceId: "cedar-policy", days: 90 }),
    key: CEDAR,
    days: 90,
  });

  // Cedar has a pending proposal and no accepted claim. It must read as absent.
  assert.equal(await store.readAccepted(CEDAR), null);

  const accepted = await store.readAccepted(HARBOR);
  assert.equal(accepted?.rotationDays, 45);
  assert.equal(accepted?.decision.origin, "synthetic");
  assert.equal(accepted?.evidence[0]?.sourceId, "harbor-policy");

  const source = await store.getSource(accepted!.evidence[0]!.snapshotId);
  const cited = source!.text.slice(accepted!.evidence[0]!.start, accepted!.evidence[0]!.end);
  assert.equal(cited, accepted!.evidence[0]!.quote);
});
