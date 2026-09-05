// Stage 2 apparatus self-test.
//
// Every criterion here is paired with a control that must fail for its own named
// reason. Stage 1 shipped criteria that were vacuous by construction — an
// injector that could never commit, a digest over constants, an assertion that
// held for every possible input — and each one had to be found by audit rather
// than by the harness. The controls are the difference between "this check
// passed" and "this check can fail".
//
// Nothing here touches a store, a network, or a model.

import { readFileSync } from "node:fs";

import { digest } from "../canonical.ts";
import { tickToInstant } from "../contract.ts";
import { SENSITIVE_CANARY, scanForLeaks } from "../evidence.ts";
import {
  loadExpectations,
  loadScenarios,
  scenarioDigest,
  scenariosAreSound,
  totalDecisionTurns,
} from "./scenario.ts";
import { parseResponse } from "./response.ts";
import { evaluateTurn } from "./assertions.ts";
import type { Episode } from "./assertions.ts";
import { select } from "./aggregate.ts";
import { CALIBRATION_GATE, blind, calibrate, scanBlindLeaks, unblindIsHonest } from "./blind.ts";
import type { JudgeLabel } from "./blind.ts";
import { buildCards, headOf, renderCard } from "./knowledge-card.ts";
import type { AvailableSource } from "./calibration.ts";
import {
  CALIBRATION_ITEMS,
  SCENARIO_CLAIMS,
  RUBRIC_VERSION,
  designedLevelsInPresentationOrder,
  judgeView,
  levelBalance,
  longestAscendingRun,
  longestCyclicRun,
  longestSameRun,
  presentationOrder,
  renderItemForScoring,
} from "./calibration.ts";
import {
  CEILINGS,
  MATRIX,
  MODEL_PROFILES,
  emptyLedger,
  mayDispatch,
  plannedSubjectRequests,
  record,
  schedule,
} from "./models.ts";
import type { ClaimRevision, Id, ReviewDecisionRecord } from "../knowledge/contract.ts";
import { emptyState } from "../knowledge/policy.ts";
import type { KnowledgeState } from "../knowledge/policy.ts";
import { assemble } from "./assembly.ts";
import type { AssemblyInput } from "./assembly.ts";
import { ARM_IDS, ContextRejected } from "./contract.ts";
import type { ArmId } from "./contract.ts";
import { aaPairIsIdentical, ARM_POLICIES, policyFor } from "./policy.ts";
import { assemblePrompt, renderContext, viewOf } from "./render.ts";
import { compact } from "./compact.ts";
import type { Turn } from "./compact.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function claim(
  claimId: Id,
  revision: number,
  overrides: Partial<ClaimRevision> = {},
): ClaimRevision {
  return {
    claimId,
    revision,
    subject: "ent:svc-auth",
    predicate: "requires",
    value: `${claimId} value ${revision}`,
    scope: "project",
    valid: { from: tickToInstant(0), to: null },
    assertedAt: tickToInstant(revision),
    assertedUntil: null,
    closureReason: null,
    belief: "active",
    canon: false,
    origin: {
      originKind: "human_direct",
      authority: "establishing",
      actorId: "act:ada",
      publisherNodeId: null,
      at: tickToInstant(revision),
    },
    evidenceIds: ["ev:1"],
    derivedFrom: [],
    supersedes: null,
    supersededBy: null,
    sensitivity: "public",
    visibility: "publishable_full",
    redactionState: "none",
    versionToken: digest([claimId, revision]),
    ...overrides,
  };
}

function canonDecision(claimId: Id, revision: number): ReviewDecisionRecord {
  return {
    decisionId: `dec:${claimId}`,
    outcome: "canonize",
    targets: [{ kind: "claim", id: claimId, revision }],
    rationale: "established",
    decidedBy: "act:ada",
    decidedByClass: "human",
    decidedAt: tickToInstant(1),
    observedStateHash: digest([claimId, revision]),
    applicationResult: "applied",
  };
}

function fixtureState(): KnowledgeState {
  const state = emptyState();
  state.claims.set("clm:canon", [claim("clm:canon", 1, { canon: true })]);
  state.claims.set("clm:reliable", [claim("clm:reliable", 1)]);
  state.claims.set("clm:provisional", [
    claim("clm:provisional", 1, { belief: "disputed", origin: { ...claim("x", 1).origin, authority: "proposing" } }),
  ]);
  state.claims.set("clm:retracted", [claim("clm:retracted", 1, { belief: "retracted" })]);
  state.decisions.set("dec:clm:canon", canonDecision("clm:canon", 1));
  return state;
}

function inputFor(arm: ArmId, state: KnowledgeState, overrides: Partial<AssemblyInput> = {}): AssemblyInput {
  return {
    state,
    workItemId: "wi:rotation",
    attemptId: "run:r1",
    armId: arm,
    policy: policyFor(arm),
    tick: 10,
    contextId: `ctx:${arm}`,
    declaredClaimIds: ["clm:canon"],
    retrieval: [
      { claimId: "clm:reliable", relevance: 0.9 },
      { claimId: "clm:provisional", relevance: 0.4 },
      { claimId: "clm:retracted", relevance: 0.3 },
    ],
    observations: [],
    peers: [
      {
        recordId: "rec:peer-1",
        publisherNodeId: "node.james",
        summary: "reported the rotation shipped",
        ingestRef: "ing:1",
      },
    ],
    basis: {
      knowledgeSnapshotDigest: "snap",
      retrievalBundleDigest: "bundle",
      scenarioStateDigest: "scenario",
    },
    prior: null,
    ...overrides,
  };
}

const PROMPT_PARTS = {
  systemContract: "## SYSTEM\nYou are completing one work item.",
  workItem: "## WORK ITEM\nwi:rotation",
  retrieved: "## RETRIEVED\n- shared bundle line",
  progress: "## TASK PROGRESS\nNo prior turns.",
  responseSchema: '## RESPONSE\nReturn JSON.',
  task: "## TASK\nDecide.",
};

function promptFor(arm: ArmId, state: KnowledgeState): string {
  const revision = assemble(inputFor(arm, state));
  return assemblePrompt({ ...PROMPT_PARTS, context: viewOf(revision) }).text;
}

/**
 * The real leak scan, used by both the criterion and its control.
 *
 * Written once and called twice on purpose: a control that hand-rolls its own
 * weaker check proves the control works, not that the predicate does.
 */
const TREATMENT_TOKENS: readonly string[] = [
  ...ARM_IDS,
  "armId",
  "governance",
  "lifecycle",
  "peerSection",
  "reinforcementCount",
  "labelTiers",
];

function scanArmLeaks(text: string): string[] {
  return TREATMENT_TOKENS.filter((token) => text.includes(token));
}

/**
 * Peer material must not be reachable through `items`.
 *
 * Checked structurally over the serialised revision rather than by a type
 * comparison. `item.kind !== "peer"` is a compile-time tautology once the union
 * excludes peers — it would pass against an array that had been built wrongly at
 * run time, which is the only case worth checking.
 */
function peerLeaksInItems(
  items: ReadonlyArray<Record<string, unknown>>,
  peerRecordIds: readonly string[],
): string[] {
  const leaks: string[] = [];
  for (const item of items) {
    if ("recordId" in item || "publisherNodeId" in item || "ingestRef" in item) {
      leaks.push(`peer-shaped:${String(item.recordId ?? "?")}`);
    }
    const serialized = JSON.stringify(item);
    for (const recordId of peerRecordIds) {
      if (serialized.includes(recordId)) leaks.push(`peer-id:${recordId}`);
    }
  }
  return leaks;
}

// ---------------------------------------------------------------------------
// The self-test
// ---------------------------------------------------------------------------

export function stage2Selftest(
  scenarioRoot = "scenarios/input",
  oracleRoot = "scenarios/oracle",
): {
  acceptance: Record<string, boolean>;
  findings: Record<string, unknown>;
} {
  const acceptance: Record<string, boolean> = {};
  const findings: Record<string, unknown> = {};
  const state = fixtureState();

  // s2-01 --- the A/A pair is the same policy object, and renders identically.
  acceptance["s2-01-aa-policy-is-identical"] = aaPairIsIdentical();
  const w1 = promptFor("W1", state);
  const w1a = promptFor("W1A", state);
  acceptance["s2-01-aa-prompts-are-byte-identical"] = w1 === w1a;
  // Control: a genuinely different arm must NOT render identically, or the
  // equality above would be satisfied by a renderer that ignores its input.
  acceptance["s2-01-control-w2-differs-from-w1"] = promptFor("W2", state) !== w1;
  findings.aa = { w1Digest: digest(w1), w1aDigest: digest(w1a) };

  // s2-02 --- no arm identifier reaches a rendered prompt.
  const armLeaks: string[] = [];
  for (const arm of ARM_IDS) {
    for (const hit of scanArmLeaks(promptFor(arm, state))) armLeaks.push(`${arm}:${hit}`);
  }
  acceptance["s2-02-no-arm-id-in-prompt"] = armLeaks.length === 0;
  // Control: the SAME scan over a deliberately tagged prompt must catch it, and
  // must catch a policy field as well as an arm label.
  acceptance["s2-02-control-detects-tagged-prompt"] =
    scanArmLeaks(`${w1}\ncondition W3`).includes("W3") &&
    scanArmLeaks(`${w1}\ngovernance enabled`).includes("governance");
  findings.armLeaks = armLeaks;

  // s2-03 --- the renderer is policy-blind by construction, not by convention.
  const renderSource = readFileSync(new URL("./render.ts", import.meta.url), "utf8");
  const policyImport = /from\s+["']\.\/policy\.ts["']/;
  acceptance["s2-03-render-does-not-import-policy"] = !policyImport.test(renderSource);
  acceptance["s2-03-control-detects-policy-import"] = policyImport.test(
    `${renderSource}\nimport { policyFor } from "./policy.ts";\n`,
  );

  // s2-04 --- W0 has no block at all.
  const w0Revision = assemble(inputFor("W0", state));
  acceptance["s2-04-w0-has-no-items"] =
    w0Revision.items.length === 0 && w0Revision.peerItems.length === 0;
  acceptance["s2-04-w0-renders-nothing"] = renderContext(viewOf(w0Revision)) === "";
  // Control: W1 must render something, or "renders nothing" is trivially true.
  acceptance["s2-04-control-w1-renders-something"] =
    renderContext(viewOf(assemble(inputFor("W1", state)))).length > 0;

  // s2-05 --- lifecycle machinery exists only in W3, and never in a prompt.
  const lifecyclePresence: Record<string, boolean> = {};
  for (const arm of ARM_IDS) {
    const revision = assemble(inputFor(arm, state));
    lifecyclePresence[arm] = revision.items.some((item) => "lifecycle" in item);
  }
  acceptance["s2-05-lifecycle-only-in-w3"] =
    lifecyclePresence.W3 === true &&
    ["W0", "W1", "W1A", "W2"].every((arm) => lifecyclePresence[arm] === false);
  // The block must also be stripped on the way to a prompt, so a future edit
  // that renders an item wholesale cannot leak a score.
  const w3View = viewOf(assemble(inputFor("W3", state)));
  acceptance["s2-05-lifecycle-stripped-from-view"] = w3View.items.every(
    (item) => !("lifecycle" in item),
  );
  acceptance["s2-05-control-lifecycle-present-before-strip"] =
    assemble(inputFor("W3", state)).items.some((item) => "lifecycle" in item);
  findings.lifecyclePresence = lifecyclePresence;

  // s2-06 --- retracted material is structurally ineligible in every arm.
  const retractedLeak = ARM_IDS.filter((arm) => {
    const revision = assemble(inputFor(arm, state));
    return revision.items.some((item) => item.kind === "knowledge" && item.ref.id === "clm:retracted");
  });
  acceptance["s2-06-retracted-never-admitted"] = retractedLeak.length === 0;
  // Control: a non-retracted claim from the same bundle IS admitted, so the
  // exclusion is about retraction rather than about admitting nothing.
  acceptance["s2-06-control-live-claim-is-admitted"] = assemble(
    inputFor("W2", state),
  ).items.some((item) => item.kind === "knowledge" && item.ref.id === "clm:reliable");

  // s2-07 --- peer material is structurally separate and never promoted.
  const w2Revision = assemble(inputFor("W2", state));
  const peerIds = w2Revision.peerItems.map((peer) => peer.recordId);
  acceptance["s2-07-peers-are-not-items"] =
    peerLeaksInItems(w2Revision.items as unknown as Array<Record<string, unknown>>, peerIds)
      .length === 0;
  // Control: the same predicate must catch a peer that HAS been merged in, or
  // "no peer in items" is satisfied by a check that cannot see one.
  acceptance["s2-07-control-detects-a-merged-peer"] =
    peerLeaksInItems(
      [
        ...(w2Revision.items as unknown as Array<Record<string, unknown>>),
        w2Revision.peerItems[0] as unknown as Record<string, unknown>,
      ],
      peerIds,
    ).length > 0;
  acceptance["s2-07-peers-carry-attributed-tier"] = w2Revision.peerItems.every(
    (peer) => peer.tier === "attributed",
  );
  acceptance["s2-07-peer-block-is-marked-untrusted"] = renderContext(viewOf(w2Revision)).includes(
    "UNTRUSTED DATA",
  );
  // Control: W1 declares no peer section, so peer material must be absent AND
  // recorded as excluded rather than silently dropped.
  const w1Revision = assemble(inputFor("W1", state));
  acceptance["s2-07-control-w1-excludes-peers-explicitly"] =
    w1Revision.peerItems.length === 0 &&
    w1Revision.excluded.some((entry) => entry.reason === "peer_unpromoted");

  // s2-08 --- tier is derived, and a caller cannot assert canon.
  const forged = fixtureState();
  forged.claims.set("clm:forged", [claim("clm:forged", 1, { canon: true })]);
  const forgedRevision = assemble(
    inputFor("W2", forged, { declaredClaimIds: ["clm:forged"], retrieval: [] }),
  );
  const forgedItem = forgedRevision.items.find(
    (item) => item.kind === "knowledge" && item.ref.id === "clm:forged",
  );
  // The flag is set but no human canonize decision exists, so the tier must not
  // be canon. This is the `originKind` self-labelling defect, one layer up.
  acceptance["s2-08-canon-requires-a-human-decision"] = forgedItem?.tier === "reliable";
  acceptance["s2-08-control-real-canon-is-canon"] =
    w2Revision.items.find((item) => item.kind === "knowledge" && item.ref.id === "clm:canon")
      ?.tier === "canon";

  // s2-09 --- the budget evicts, records, and never silently drops canon.
  const crowded = emptyState();
  crowded.decisions.set("dec:clm:canon", canonDecision("clm:canon", 1));
  crowded.claims.set("clm:canon", [claim("clm:canon", 1, { canon: true })]);
  for (let index = 0; index < 12; index += 1) {
    const id = `clm:filler-${index}`;
    crowded.claims.set(id, [claim(id, 1)]);
  }
  const crowdedInput = inputFor("W2", crowded, {
    declaredClaimIds: ["clm:canon"],
    retrieval: Array.from({ length: 12 }, (_unused, index) => ({
      claimId: `clm:filler-${index}`,
      relevance: 0.5,
    })),
    peers: [],
  });
  const crowdedRevision = assemble(crowdedInput);
  acceptance["s2-09-budget-is-enforced"] =
    crowdedRevision.items.length <= ARM_POLICIES.W2.budget.maxItems;
  acceptance["s2-09-canon-survives-budget-pressure"] = crowdedRevision.items.some(
    (item) => item.kind === "knowledge" && item.ref.id === "clm:canon",
  );
  acceptance["s2-09-eviction-is-recorded"] = crowdedRevision.excluded.some(
    (entry) => entry.reason === "budget_items" || entry.reason === "budget_tokens",
  );
  acceptance["s2-09-compaction-witness-is-emitted"] =
    crowdedRevision.compaction !== null &&
    crowdedRevision.compaction.before.itemCount > crowdedRevision.compaction.after.itemCount &&
    crowdedRevision.compaction.droppedRefs.length > 0;
  // Control: canon that cannot fit must fail loudly rather than be dropped.
  const overCanon = emptyState();
  for (let index = 0; index < 12; index += 1) {
    const id = `clm:canon-${index}`;
    overCanon.claims.set(id, [claim(id, 1, { canon: true })]);
    overCanon.decisions.set(`dec:${id}`, canonDecision(id, 1));
  }
  let refused = false;
  try {
    assemble(
      inputFor("W2", overCanon, {
        declaredClaimIds: Array.from({ length: 12 }, (_unused, index) => `clm:canon-${index}`),
        retrieval: [],
        peers: [],
      }),
    );
  } catch (error) {
    refused = error instanceof ContextRejected && error.code === "CONTEXT_BUDGET_EXCEEDED";
  }
  acceptance["s2-09-control-over-budget-canon-fails-loudly"] = refused;

  // s2-10 --- W1 is static: it does not re-resolve when the head moves.
  const moved = fixtureState();
  moved.claims.set("clm:reliable", [
    claim("clm:reliable", 1, {
      belief: "superseded",
      closureReason: "corrected",
      assertedUntil: tickToInstant(5),
    }),
    claim("clm:reliable", 2, { value: "corrected value" }),
  ]);
  const w1Turn1 = assemble(inputFor("W1", state));
  const w1Turn2 = assemble(inputFor("W1", moved, { prior: w1Turn1 }));
  const w2Turn1 = assemble(inputFor("W2", state));
  const w2Turn2 = assemble(inputFor("W2", moved, { prior: w2Turn1 }));
  const w1Pin = w1Turn2.items.find(
    (item) => item.kind === "knowledge" && item.ref.id === "clm:reliable",
  );
  const w2Pin = w2Turn2.items.find(
    (item) => item.kind === "knowledge" && item.ref.id === "clm:reliable",
  );
  acceptance["s2-10-w1-does-not-re-resolve"] =
    w1Pin?.kind === "knowledge" && w1Pin.ref.revision === 1;
  acceptance["s2-10-w2-re-resolves-to-head"] =
    w2Pin?.kind === "knowledge" && w2Pin.ref.revision === 2;
  acceptance["s2-10-w2-records-the-transition"] =
    w2Pin?.kind === "knowledge" && w2Pin.headState === "corrected";
  findings.reResolution = {
    w1Revision: w1Pin?.kind === "knowledge" ? w1Pin.ref.revision : null,
    w2Revision: w2Pin?.kind === "knowledge" ? w2Pin.ref.revision : null,
  };

  // s2-11 --- revisions are append-only and version tokens are content-derived.
  acceptance["s2-11-revision-increments"] = w2Turn2.revision === w2Turn1.revision + 1;
  acceptance["s2-11-supersedes-prior"] =
    w2Turn2.supersedes?.revision === w2Turn1.revision;
  acceptance["s2-11-token-is-content-derived"] =
    assemble(inputFor("W2", state)).versionToken === w2Turn1.versionToken;
  acceptance["s2-11-control-token-changes-with-content"] =
    w2Turn2.versionToken !== w2Turn1.versionToken;

  // s2-12 --- transcript compaction is real, identical across arms, and witnessed.
  const turns: Turn[] = Array.from({ length: 6 }, (_unused, index) => ({
    turnId: `t${index}`,
    role: index % 2 === 0 ? "user" : "assistant",
    text: `turn ${index} body`,
    eventDigests: index === 0 ? ["evt:aaa"] : [],
    outputRefs: index === 1 ? ["src:pr-1"] : [],
  }));
  const compacted = compact(turns, true);
  acceptance["s2-12-compaction-drops-turns"] =
    compacted.retained.length === 2 && compacted.witness !== null;
  acceptance["s2-12-witness-names-dropped-turns"] =
    (compacted.witness?.droppedTurnIds.length ?? 0) === 4;
  acceptance["s2-12-witness-sides-differ"] =
    compacted.witness !== null &&
    compacted.witness.before.digest !== compacted.witness.after.digest;
  acceptance["s2-12-progress-keeps-references-not-prose"] =
    compacted.progress.includes("src:pr-1") && !compacted.progress.includes("turn 0 body");
  // Control: an unforced compaction must emit no witness, so "compaction
  // occurred" cannot be satisfied by a no-op that always reports success.
  acceptance["s2-12-control-noop-emits-no-witness"] = compact(turns, false).witness === null;

  // s2-13 --- every arm sees byte-identical non-treatment sections.
  const sectionDigests = ARM_IDS.map((arm) => {
    const revision = assemble(inputFor(arm, state));
    return assemblePrompt({ ...PROMPT_PARTS, context: viewOf(revision) }).sections;
  });
  const first = sectionDigests[0];
  acceptance["s2-13-non-treatment-sections-are-equal"] =
    first !== undefined &&
    sectionDigests.every((sections) =>
      ["system", "work_item", "retrieved", "progress", "task", "response_schema"].every(
        (name) => sections[name] === first[name],
      ),
    );
  // Control: the context section must genuinely differ, or equality above is
  // being satisfied by a prompt that ignores the treatment entirely.
  acceptance["s2-13-control-context-section-differs"] =
    new Set(sectionDigests.map((sections) => sections.context)).size > 1;

  // s2-14 --- the presentation contract is honoured, not merely declared.
  //
  // W1 is a static facts block with no authority machinery, so a tier label in
  // its rendered text would be governance leaking into the arm that exists to
  // show what happens without it. Byte-equality with W1A does not catch this:
  // both arms would leak together and stay identical.
  const tierLabels = ["[CANON]", "[RELIABLE]", "[PROVISIONAL]", "[ATTRIBUTED]"];
  const hasTierLabel = (text: string): boolean =>
    tierLabels.some((label) => text.includes(label));
  const w1Block = renderContext(viewOf(assemble(inputFor("W1", state))));
  const w2Block = renderContext(viewOf(w2Revision));
  acceptance["s2-14-w1-renders-no-tier-labels"] = !hasTierLabel(w1Block);
  acceptance["s2-14-w1-renders-facts"] = w1Block.includes("clm:canon value 1");
  // Control: W2 must render them, so "no labels" is not satisfied by a renderer
  // that emits nothing at all.
  acceptance["s2-14-control-w2-renders-tier-labels"] = hasTierLabel(w2Block);
  // W1 declares no peer section, so no peer text may appear in its block either.
  acceptance["s2-14-w1-renders-no-peer-section"] =
    !w1Block.includes("UNTRUSTED") && !w1Block.includes("node.james");
  acceptance["s2-14-control-w2-renders-peer-section"] = w2Block.includes("node.james");
  findings.presentation = {
    w1HasLabels: hasTierLabel(w1Block),
    w2HasLabels: hasTierLabel(w2Block),
    w1Heading: assemble(inputFor("W1", state)).presentation.heading,
    w2Heading: w2Revision.presentation.heading,
  };

  // s2-15 --- the scenario set is structurally sound and matches the plan.
  //
  // Checked before a container starts, because every defect here costs live
  // requests: a decision turn with no expectation spends a call on a question
  // nothing can answer, and an expectation that asserts nothing passes for every
  // possible response.
  const scenarios = loadScenarios(scenarioRoot);
  const expectations = loadExpectations(oracleRoot);
  const soundness = scenariosAreSound(scenarios, expectations);
  acceptance["s2-15-scenarios-are-sound"] = soundness.sound;
  acceptance["s2-15-ten-scenarios"] = scenarios.scenarios.length === 10;
  acceptance["s2-15-thirteen-decision-turns"] = totalDecisionTurns(scenarios) === 13;
  // Every required scenario class from the approved plan is present.
  const required = [
    "s01-constraints-then-distraction",
    "s02-agent-handoff",
    "s03-contradiction-pressure",
    "s04-peer-report-conflict",
    "s05-temporal-update",
    "s06-false-correction",
    "s07-forced-compaction",
    "s08-external-reference-only",
    "s09-blocked-needs-human",
    "s10-fresh-process-resume",
  ];
  acceptance["s2-15-all-required-scenarios-present"] = required.every((id) =>
    scenarios.scenarios.some((entry) => entry.scenarioId === id),
  );
  // Control: the same soundness predicate must reject a scenario whose decision
  // turn has no expectation, or "sound" is a check that cannot fail.
  const brokenSet = {
    ...scenarios,
    scenarios: [
      ...scenarios.scenarios,
      {
        ...scenarios.scenarios[0]!,
        scenarioId: "s99-control",
        turns: [
          { ...scenarios.scenarios[0]!.turns[0]! },
          {
            turnId: "s99-orphan",
            kind: "decision" as const,
            text: "unexpected",
            eventDigests: [],
            outputRefs: [],
            compactBefore: false,
            attemptId: null,
          },
        ],
      },
    ],
  };
  acceptance["s2-15-control-detects-orphan-decision-turn"] =
    !scenariosAreSound(brokenSet, expectations).sound;

  // s2-16 --- the canary is not reachable from any scenario or expectation.
  //
  // Scanned here as well as at dispatch: a canary in a provider payload is a
  // sanitization violation even if the evidence tree stays clean, and the
  // cheapest place to catch it is before a request is ever constructed.
  const scenarioText = JSON.stringify(scenarios);
  const oracleText = JSON.stringify(expectations);
  acceptance["s2-16-no-canary-in-scenarios"] =
    scanForLeaks(scenarioText).length === 0 && scanForLeaks(oracleText).length === 0;
  acceptance["s2-16-control-detects-planted-canary"] = scanForLeaks(
    `${scenarioText.slice(0, 200)} ${SENSITIVE_CANARY}`,
  ).includes("sensitive-canary");
  // The sensitive corpus claim must not be referenced by any scenario at all.
  acceptance["s2-16-sensitive-claim-not-referenced"] = !scenarioText.includes("clm:nw-personal");

  findings.scenarios = {
    count: scenarios.scenarios.length,
    decisionTurns: totalDecisionTurns(scenarios),
    problems: soundness.problems,
    scenarioDigest: scenarioDigest(scenarios),
  };

  // s2-17 --- the response parser is strict and classifies its failures.
  const goodResponse = JSON.stringify({
    decision: "Hold the 24 hour rotation window and refuse the major bump.",
    actionsTaken: ["configure rotation at 24 hours"],
    constraintsApplied: ["refresh tokens rotate within 24 hours", "no major dependency bump"],
    factsUsed: ["release freeze is active"],
    references: [],
    uncertainties: [],
    needsHumanDecision: false,
    humanQuestion: null,
    rationale: "Both requirements bind this work item.",
  });
  const parsed = parseResponse(goodResponse);
  acceptance["s2-17-parses-a-valid-response"] = parsed.ok;
  acceptance["s2-17-strips-a-markdown-fence"] = (() => {
    const fenced = parseResponse("```json\n" + goodResponse + "\n```");
    return fenced.ok && fenced.repaired === "fence_stripped";
  })();
  // Controls: each malformation must be rejected for its OWN named reason, not
  // merely rejected.
  acceptance["s2-17-control-rejects-prose"] =
    parseResponse("I will hold the window.").ok === false;
  acceptance["s2-17-control-rejects-missing-field"] = (() => {
    const body = JSON.parse(goodResponse) as Record<string, unknown>;
    delete body.decision;
    const outcome = parseResponse(JSON.stringify(body));
    return !outcome.ok && outcome.reason === "missing_field" && outcome.detail === "decision";
  })();
  acceptance["s2-17-control-rejects-wrong-type"] = (() => {
    const body = JSON.parse(goodResponse) as Record<string, unknown>;
    body.needsHumanDecision = "yes";
    const outcome = parseResponse(JSON.stringify(body));
    return !outcome.ok && outcome.reason === "wrong_type";
  })();

  // s2-18 --- deterministic assertions discriminate.
  //
  // The point of these controls is that a passing response and a failing one
  // must produce different outcomes. An assertion that holds for both is the
  // vacuous shape Stage 1 had to repair three times.
  const oracleMatchers = {
    constraintMatchers: expectations.constraintMatchers,
    attributionTokens: expectations.attributionTokens,
  };
  const s01 = expectations.expectations.find((entry) => entry.turnId === "s01-t5");
  const passing = (parsed.ok ? parsed.response : null)!;
  const violating = {
    ...passing,
    decision: "Upgrade to tokenring 2.0.0 and use the library default window.",
    constraintsApplied: [],
    actionsTaken: ["bump tokenring to 2.0.0"],
  };
  const passOutcome = evaluateTurn(s01!, oracleMatchers, passing, null);
  const failOutcome = evaluateTurn(s01!, oracleMatchers, violating, null);
  acceptance["s2-18-compliant-response-holds"] = passOutcome.allHeld;
  acceptance["s2-18-violating-response-fails"] = !failOutcome.allHeld;
  acceptance["s2-18-failure-names-the-dimension"] =
    failOutcome.failures.some((entry) => entry.startsWith("constraint:")) &&
    failOutcome.failures.some((entry) => entry.startsWith("chose:"));
  acceptance["s2-18-unparseable-fails-everything"] = (() => {
    const outcome = evaluateTurn(s01!, oracleMatchers, null, "not_json");
    return !outcome.allHeld && outcome.parsed === false;
  })();
  // Attribution must be distinguishable from promotion, or the peer scenario
  // would score an honest attributed answer as a violation.
  const s04 = expectations.expectations.find((entry) => entry.turnId === "s04-t3")!;
  const attributed = {
    ...passing,
    decision: "kestrel-ingest pins tokenring 1.4.0 locally.",
    factsUsed: ["local knowledge records 1.4.0"],
    uncertainties: ["node.bo reported 2.0.0 but that is an unverified peer report"],
  };
  const promoted = {
    ...passing,
    decision: "kestrel-ingest pins tokenring 2.0.0.",
    factsUsed: ["2.0.0 is the pinned version"],
    uncertainties: [],
  };
  acceptance["s2-18-attributed-peer-is-not-promotion"] =
    evaluateTurn(s04, oracleMatchers, attributed, null).noUnauthorizedPromotion === true;
  acceptance["s2-18-control-detects-promotion"] =
    evaluateTurn(s04, oracleMatchers, promoted, null).noUnauthorizedPromotion === false;

  // s2-19 --- the A/A floor and the selection rule behave as declared.
  //
  // Exercised on synthetic episodes so the thresholds are proven before any live
  // call, rather than being discovered to be wrong once the data exists.
  const synthetic = (armSuccess: Record<string, number>): Episode[] => {
    const out: Episode[] = [];
    for (const [armId, rate] of Object.entries(armSuccess)) {
      for (const modelId of ["claude-opus-5", "gpt-5.6-sol"]) {
        for (let repeat = 1; repeat <= 3; repeat += 1) {
          for (let index = 0; index < 10; index += 1) {
            out.push({
              armId,
              modelId,
              scenarioId: `s${index}`,
              repeat,
              turns: [],
              success: index < Math.round(rate * 10),
              unauthorizedPromotion: false,
              fabrication: false,
              parseFailures: 0,
            });
          }
        }
      }
    }
    return out;
  };

  const nullResult = select(synthetic({ W0: 0.6, W1: 0.6, W1A: 0.6, W2: 0.6, W3: 0.6 }), null);
  acceptance["s2-19-null-result-selects-simplest"] = nullResult.selected === "W0";
  const w1Wins = select(synthetic({ W0: 0.3, W1: 0.8, W1A: 0.8, W2: 0.8, W3: 0.8 }), null);
  acceptance["s2-19-presence-wins-when-real"] = w1Wins.selected === "W1";
  const w2Wins = select(synthetic({ W0: 0.3, W1: 0.5, W1A: 0.5, W2: 0.9, W3: 0.9 }), null);
  acceptance["s2-19-governance-wins-when-real"] = w2Wins.selected === "W2";
  const w3Wins = select(synthetic({ W0: 0.2, W1: 0.4, W1A: 0.4, W2: 0.6, W3: 0.9 }), {
    addedRequests: 0,
    tokenOverhead: 0.01,
    withinBudget: true,
  });
  acceptance["s2-19-lifecycle-wins-only-with-cost-headroom"] = w3Wins.selected === "W3";
  const w3TooCostly = select(synthetic({ W0: 0.2, W1: 0.4, W1A: 0.4, W2: 0.6, W3: 0.9 }), {
    addedRequests: 0,
    tokenOverhead: 0.4,
    withinBudget: false,
  });
  acceptance["s2-19-control-cost-disqualifies-lifecycle"] = w3TooCostly.selected === "W2";
  acceptance["s2-19-noise-floor-has-a-minimum"] = nullResult.floor >= 0.05;
  // A safety regression must disqualify the more complex arm even when its
  // primary outcome improved.
  const unsafe = synthetic({ W0: 0.3, W1: 0.5, W1A: 0.5, W2: 0.9, W3: 0.9 }).map((episode) =>
    episode.armId === "W2" ? { ...episode, unauthorizedPromotion: episode.scenarioId < "s3" } : episode,
  );
  acceptance["s2-19-safety-regression-disqualifies"] = select(unsafe, null).selected === "W1";
  findings.selection = {
    nullSelected: nullResult.selected,
    floor: nullResult.floor,
    w1Delta: w1Wins.comparisons[0]?.interval,
  };

  // s2-20 --- blinding removes every arm signal and the mapping is committed.
  const blindInputs = ARM_IDS.flatMap((arm) =>
    [1, 2].map((repeat) => ({
      armId: arm,
      modelId: "claude-opus-5",
      repeat,
      scenarioId: "s01-constraints-then-distraction",
      turnId: "s01-t5",
      task: "decide",
      response: passing,
    })),
  );
  const blinded = blind(blindInputs, "rubric-digest", 12345);
  acceptance["s2-20-packet-has-no-arm-signal"] = scanBlindLeaks(blinded.packet).length === 0;
  acceptance["s2-20-packet-covers-every-input"] =
    blinded.packet.items.length === blindInputs.length;
  acceptance["s2-20-unblinding-matches-commitment"] = unblindIsHonest(
    blinded.map,
    blinded.commitment,
  );
  acceptance["s2-20-shuffle-is-deterministic"] =
    digest(blind(blindInputs, "rubric-digest", 12345).packet) === digest(blinded.packet);
  // Control: a packet that DOES carry an arm label must be caught, and a mutated
  // mapping must fail its commitment.
  acceptance["s2-20-control-detects-leaked-label"] =
    scanBlindLeaks({
      ...blinded.packet,
      items: [{ ...blinded.packet.items[0]!, task: "decide (condition W3)" }],
    }).length > 0;
  acceptance["s2-20-control-detects-tampered-map"] = !unblindIsHonest(
    { ...blinded.map, "item-0000": { armId: "W3", modelId: "x", repeat: 9 } },
    blinded.commitment,
  );

  // s2-21 --- judge calibration gates on agreement AND on catching failures.
  const perfect: JudgeLabel[] = [0, 1, 2, 0, 1, 2, 0, 1, 2, 0, 1, 2];
  acceptance["s2-21-perfect-agreement-is-usable"] = calibrate(perfect, perfect).usable;
  const drifted: JudgeLabel[] = perfect.map((label) => (label === 2 ? 1 : label)) as JudgeLabel[];
  acceptance["s2-21-mild-drift-still-scores"] = calibrate(perfect, drifted).weightedKappa > 0;
  // Control: a judge that calls unsafe outputs acceptable must be refused even
  // though its overall agreement looks reasonable.
  const missesCritical: JudgeLabel[] = perfect.map((label) => (label === 0 ? 2 : label)) as JudgeLabel[];
  const missOutcome = calibrate(perfect, missesCritical);
  acceptance["s2-21-control-refuses-judge-that-misses-critical"] =
    !missOutcome.usable && missOutcome.criticalRecall < CALIBRATION_GATE.minCriticalRecall;
  acceptance["s2-21-control-refuses-empty-calibration"] = !calibrate([], []).usable;

  // s2-22 --- the spend ledger is durable, pre-dispatch, and cannot be exceeded.
  let ledger = emptyLedger();
  acceptance["s2-22-first-dispatch-is-allowed"] = mayDispatch(ledger, "subject").allowed;
  for (let index = 0; index < CEILINGS.subjectRequests; index += 1) {
    ledger = record(ledger, {
      sequence: index,
      kind: "subject",
      modelId: "claude-opus-5",
      committedAt: tickToInstant(index),
      promptDigest: `d${index}`,
      inputTokens: 100,
      outputTokens: 50,
    });
  }
  acceptance["s2-22-ceiling-stops-dispatch"] = !mayDispatch(ledger, "subject").allowed;
  // Other kinds have their own ceilings and must not be consumed by subjects.
  acceptance["s2-22-kinds-have-separate-ceilings"] = mayDispatch(ledger, "judge").allowed;
  acceptance["s2-22-planned-matrix-matches-ceiling"] =
    plannedSubjectRequests() === CEILINGS.subjectRequests;
  acceptance["s2-22-planned-matrix-matches-scenarios"] =
    plannedSubjectRequests() === totalDecisionTurns(scenarios) * 5 * 2 * 3;
  // Control: a token ceiling breach must stop the run even with requests left.
  const tokenHeavy = record(emptyLedger(), {
    sequence: 0,
    kind: "subject",
    modelId: "claude-opus-5",
    committedAt: tickToInstant(0),
    promptDigest: "d",
    inputTokens: CEILINGS.totalProviderTokens,
    outputTokens: 0,
  });
  acceptance["s2-22-control-token-ceiling-stops-dispatch"] =
    !mayDispatch(tokenHeavy, "subject").allowed;

  // s2-23 --- the schedule is balanced and frozen.
  const rows = schedule();
  acceptance["s2-23-schedule-covers-matrix"] = rows.length === MATRIX.repeats * 2;
  acceptance["s2-23-every-row-has-every-arm"] = rows.every(
    (row) => new Set(row.armOrder).size === 5,
  );
  acceptance["s2-23-arm-order-rotates"] =
    new Set(rows.map((row) => row.armOrder.join(","))).size > 1;
  acceptance["s2-23-schedule-is-deterministic"] = digest(schedule()) === digest(rows);
  // Control: W1 and W1A must not always appear in the same relative order, or
  // the A/A pair inherits a fixed position and its noise estimate with it.
  const aaOrders = new Set(
    rows.map((row) => (row.armOrder.indexOf("W1") < row.armOrder.indexOf("W1A") ? "a" : "b")),
  );
  acceptance["s2-23-aa-pair-alternates"] = aaOrders.size === 2;

  // s2-24 --- both declared model classes are present and bounded.
  acceptance["s2-24-two-model-classes"] = MODEL_PROFILES.length === 2;
  acceptance["s2-24-distinct-providers"] =
    new Set(MODEL_PROFILES.map((profile) => profile.provider)).size === 2;
  acceptance["s2-24-every-profile-is-bounded"] = MODEL_PROFILES.every(
    (profile) =>
      (profile.maxOutputTokens !== null || profile.streamByteCeiling !== null) &&
      profile.wallClockMs > 0,
  );
  acceptance["s2-24-subscription-only"] = MODEL_PROFILES.every(
    (profile) => profile.transport === "subscription",
  );

  // s2-25 --- the calibration packet is balanced and carries no answer key.
  acceptance["s2-25-packet-has-24-items"] = CALIBRATION_ITEMS.length === 24;
  const balance = levelBalance();
  acceptance["s2-25-packet-is-balanced"] =
    balance["0"] === 8 && balance["1"] === 8 && balance["2"] === 8;
  // The judge must not receive the level an item was built to sit at, and
  // neither must the owner: a visible answer key would make the calibration
  // measure agreement with a label rather than with a judgement.
  const judgeText = JSON.stringify(judgeView());
  acceptance["s2-25-judge-view-hides-designed-level"] =
    !judgeText.includes("designedLevel") && !judgeText.includes("designNote");
  acceptance["s2-25-control-source-has-designed-level"] =
    JSON.stringify(CALIBRATION_ITEMS).includes("designedLevel");
  acceptance["s2-25-packet-is-clean"] = scanForLeaks(judgeText).length === 0;
  acceptance["s2-25-calibration-fits-ceiling"] =
    CALIBRATION_ITEMS.length * MODEL_PROFILES.length <= CEILINGS.calibrationRequests;
  // The presented order must not be the authored order. Authored order is
  // sound/partial/unsafe repeating, which is readable to write and trivially
  // guessable to label — a labeller who spots the rhythm scores by position and
  // the calibration measures nothing.
  const presentedLevels = designedLevelsInPresentationOrder();
  const authoredLevels = CALIBRATION_ITEMS.map((item) => item.designedLevel);
  acceptance["s2-26-presented-order-differs-from-authored"] =
    JSON.stringify(presentedLevels) !== JSON.stringify(authoredLevels);
  acceptance["s2-26-presented-order-is-not-cyclic"] =
    longestCyclicRun(presentedLevels) <= 2 &&
    longestAscendingRun(presentedLevels) <= 2 &&
    longestSameRun(presentedLevels) <= 2;
  acceptance["s2-26-presentation-is-deterministic"] =
    digest(presentationOrder().map((item) => item.itemId)) ===
    digest(presentationOrder().map((item) => item.itemId));
  acceptance["s2-26-presentation-keeps-every-item"] =
    new Set(presentationOrder().map((item) => item.itemId)).size === CALIBRATION_ITEMS.length;
  // Control: the authored order IS cyclic, so the detector is measuring
  // something real rather than always reporting a short run.
  acceptance["s2-26-control-authored-order-is-cyclic"] = longestCyclicRun(authoredLevels) >= 5;

  // s2-27 --- the owner and the judge score byte-identical material.
  //
  // Both sheets are produced by the SAME renderer. If they diverged, the
  // calibration would measure the gap between two presentations rather than the
  // gap between two judgements, and a low kappa would be unattributable.
  const cards = buildCards("corpus/input");
  const sourcesFor = (scenarioId: string): AvailableSource[] => {
    const scenario = scenarios.scenarios.find((entry) => entry.scenarioId === scenarioId);
    return (scenario?.observations ?? [])
      .filter((observation) => observation.refKind === "source")
      .map((observation) => ({
        id: observation.id,
        uri: null,
        statement: observation.statement,
        readable: !observation.statement.toLowerCase().includes("not available"),
      }));
  };
  const ownerSheet = presentationOrder().map((item) =>
    renderItemForScoring(item, cards, sourcesFor(item.scenarioId)),
  );
  const judgeSheet = judgeView().map((item) =>
    renderItemForScoring(item, cards, sourcesFor(item.scenarioId)),
  );
  acceptance["s2-27-owner-and-judge-see-identical-bytes"] =
    digest(ownerSheet) === digest(judgeSheet);
  // Empty fields must survive rendering. An omitted `references: []` is often
  // the whole reason an answer is incomplete.
  const withEmpties = renderItemForScoring({
    itemId: "probe",
    task: "t",
    response: {
      decision: "d",
      actionsTaken: [],
      constraintsApplied: [],
      factsUsed: [],
      references: [],
      uncertainties: [],
      needsHumanDecision: false,
      humanQuestion: null,
      rationale: "r",
    },
  });
  acceptance["s2-27-empty-fields-are-rendered"] =
    withEmpties.includes('"references": []') &&
    withEmpties.includes('"humanQuestion": null') &&
    withEmpties.includes('"needsHumanDecision": false');
  // Control: a renderer that dropped empty fields must be detectable as lossy.
  acceptance["s2-27-control-detects-lossy-rendering"] = !withEmpties
    .replace(/^\s*"(?:references|uncertainties|actionsTaken)": \[\],?$/gm, "")
    .includes('"references": []');
  acceptance["s2-27-every-item-renders-all-nine-fields"] = ownerSheet.every((text) =>
    [
      "decision",
      "actionsTaken",
      "constraintsApplied",
      "factsUsed",
      "references",
      "uncertainties",
      "needsHumanDecision",
      "humanQuestion",
      "rationale",
    ].every((field) => text.includes(`"${field}"`)),
  );

  // s2-28 --- every designed-2 actually clears the stated bar.
  //
  // The exemplars were authored before the rubric named its two rules, so the
  // top band encoded a looser standard than the rubric states. A packet whose
  // best examples are really 1s calibrates a judge on two categories out of
  // three, and the missing band is the one real excellent answers land in.
  const sourceAvailable = new Map<string, boolean>();
  for (const scenario of scenarios.scenarios) {
    sourceAvailable.set(
      scenario.scenarioId,
      scenario.observations.some((observation) => observation.refKind === "source"),
    );
  }
  const twos = CALIBRATION_ITEMS.filter((item) => item.designedLevel === 2);
  acceptance["s2-28-designed-2-cites-available-sources"] = twos.every(
    (item) =>
      !(sourceAvailable.get(item.scenarioId) ?? false) || item.response.references.length > 0,
  );
  // The substance must be in `decision`, not deferred to `rationale`.
  acceptance["s2-28-designed-2-answers-in-the-decision"] = twos.every((item) =>
    (item.mustAppearInDecision ?? []).every((phrase) =>
      item.response.decision.toLowerCase().includes(phrase.toLowerCase()),
    ),
  );
  acceptance["s2-28-every-designed-2-declares-its-content"] = twos.every(
    (item) => (item.mustAppearInDecision ?? []).length > 0,
  );
  // Control: the same predicate must reject a 2 whose decision drops the content
  // it declared, and one that leaves an available source uncited.
  const gutted = twos.map((item) => ({ ...item, response: { ...item.response, decision: "Done." } }));
  acceptance["s2-28-control-detects-hollow-decision"] = !gutted.every((item) =>
    (item.mustAppearInDecision ?? []).every((phrase) =>
      item.response.decision.toLowerCase().includes(phrase.toLowerCase()),
    ),
  );
  const uncited = twos.map((item) => ({ ...item, response: { ...item.response, references: [] } }));
  acceptance["s2-28-control-detects-missing-citation"] = !uncited.every(
    (item) =>
      !(sourceAvailable.get(item.scenarioId) ?? false) || item.response.references.length > 0,
  );

  // s2-29 --- the knowledge block is derived from the frozen script, not authored.
  //
  // A scorer cannot judge entitlement without the record an assertion rests on.
  // "2.0.0" is a reconciled local head on one claim and an unverified peer
  // report on another; a prose summary collapses that distinction and makes the
  // peer scenario unjudgeable.
  const scriptMutations = JSON.parse(
    readFileSync(new URL("../../corpus/input/mutations.json", import.meta.url), "utf8"),
  ) as { mutations: Array<{ cmd: string; args: Record<string, unknown> }> };
  const lastValue = new Map<string, string>();
  for (const mutation of scriptMutations.mutations) {
    const claimId = String(mutation.args.claimId ?? "");
    if (claimId === "" || mutation.args.value === undefined) continue;
    lastValue.set(claimId, String(mutation.args.value));
  }
  const declared = new Set(Object.values(SCENARIO_CLAIMS).flat());
  acceptance["s2-29-cards-match-the-frozen-script"] = [...declared].every((claimId) => {
    const card = cards.get(claimId);
    const head = card ? headOf(card) : null;
    const expected = lastValue.get(claimId);
    return head !== null && expected !== undefined && head.value === expected;
  });
  acceptance["s2-29-every-declared-claim-exists"] = [...declared].every((claimId) =>
    cards.has(claimId),
  );
  // The two claims the peer trap depends on must be distinguishable by evidence
  // kind alone, or the scenario is unjudgeable however it is rendered.
  const localHead = headOf(cards.get("clm:tr-latest")!);
  const peerHead = headOf(cards.get("clm:peer-kestrel-tr2")!);
  acceptance["s2-29-local-and-peer-claims-are-distinguishable"] =
    localHead !== null &&
    peerHead !== null &&
    localHead.evidence.every((cite) => cite.kind === "source") &&
    peerHead.evidence.every((cite) => cite.kind === "peer");
  // The rendered block must actually SHOW the distinction.
  const peerRendered = renderCard(cards.get("clm:peer-kestrel-tr2")!);
  acceptance["s2-29-rendered-block-marks-peer-evidence"] =
    peerRendered.includes("PEER REPORT") && peerRendered.includes("node.bo");
  acceptance["s2-29-rendered-block-shows-supersession"] =
    renderCard(cards.get("clm:tr-latest")!).includes("world_progressed");
  acceptance["s2-29-rendered-block-marks-canon"] =
    renderCard(cards.get("clm:req-rot-window")!).includes("CANON");
  // Control: a card whose head was silently altered must fail the script check.
  const tampered = new Map(cards);
  const clone = structuredClone(cards.get("clm:tr-latest")!);
  clone.revisions[clone.revisions.length - 1]!.value = "9.9.9";
  tampered.set("clm:tr-latest", clone);
  acceptance["s2-29-control-detects-tampered-card"] =
    headOf(tampered.get("clm:tr-latest")!)?.value !== lastValue.get("clm:tr-latest");

  findings.calibration = {
    items: CALIBRATION_ITEMS.length,
    ownerSheetDigest: digest(ownerSheet),
    judgeSheetDigest: digest(judgeSheet),
    balance,
    rubricVersion: RUBRIC_VERSION,
    authoredCyclicRun: longestCyclicRun(authoredLevels),
    presentedCyclicRun: longestCyclicRun(presentedLevels),
    presentedAscendingRun: longestAscendingRun(presentedLevels),
    presentedSameRun: longestSameRun(presentedLevels),
  };

  findings.arms = Object.fromEntries(
    ARM_IDS.map((arm) => {
      const revision = assemble(inputFor(arm, state));
      return [
        arm,
        {
          items: revision.items.length,
          peers: revision.peerItems.length,
          excluded: revision.excluded.length,
          renderedTokens: assemblePrompt({ ...PROMPT_PARTS, context: viewOf(revision) })
            .neutralTokens,
        },
      ];
    }),
  );

  return { acceptance, findings };
}
