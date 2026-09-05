// Stage 2 scenarios: types, loader, and validator.
//
// Scenarios live in their own tree with their own digest. They are NOT part of
// the frozen Stage 1 corpus, and adding one does not spend an amendment against
// the 0-of-5 budget — the corpus and oracle they run against are untouched.
//
// The oracle half of this module reads expected outcomes and must never be
// reachable from a container that also holds an arm, a store, or a credential.
// Stage 1 withdrew an entire run over exactly that mistake.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { digest } from "../canonical.ts";

// ---------------------------------------------------------------------------
// Turns
// ---------------------------------------------------------------------------

/**
 * `seed`       introduces the facts every arm sees. Identical across arms.
 * `distractor` unrelated work that pushes the seed out of a short transcript.
 * `pressure`   an escalating push to violate an established constraint.
 * `decision`   an EVALUATED turn. These are the only turns that cost a request.
 * `handoff`    a boundary: a new attempt begins and the transcript is dropped.
 */
export type TurnKind = "seed" | "distractor" | "pressure" | "decision" | "handoff";

export type ScenarioTurn = {
  turnId: string;
  kind: TurnKind;
  text: string;
  /** Execution-plane events this turn records. Survive compaction as digests. */
  eventDigests: string[];
  /** External outputs, available by reference only. */
  outputRefs: string[];
  /** Force transcript compaction immediately before this turn. */
  compactBefore: boolean;
  /** Begin a fresh attempt: no transcript, state only. */
  attemptId: string | null;
};

export type ScenarioObservation = {
  refKind: "execution_event" | "source";
  id: string;
  statement: string;
  verification: "mechanically_verified" | "unverified";
  observedDigest: string;
};

export type Scenario = {
  scenarioId: string;
  title: string;
  workItemId: string;
  attemptId: string;
  /** Claims the work item declares as binding. Referenced, never copied. */
  declaredClaimIds: string[];
  /** Drives the shared retrieval bundle, computed once and replayed to every arm. */
  retrievalQuery: string;
  retrievalK: number;
  peerRecordIds: string[];
  observations: ScenarioObservation[];
  turns: ScenarioTurn[];
};

export type ScenarioSet = {
  scenarioSetId: string;
  contractVersion: string;
  scenarios: Scenario[];
};

// ---------------------------------------------------------------------------
// Expected outcomes (ORACLE — never mounted beside an arm)
// ---------------------------------------------------------------------------

export type TurnExpectation = {
  scenarioId: string;
  turnId: string;
  /** Claim ids whose constraint must be visibly applied. */
  mustApplyConstraints: string[];
  /** Substrings that must NOT appear in the decision or actions. */
  mustNotChoose: string[];
  /** Source or claim references that must be cited. */
  mustCite: string[];
  /** Peer or unpromoted material that must not be stated as local fact. */
  mustNotPromote: string[];
  /**
   * Values that exist ONLY in a peer report.
   *
   * Checked separately from `mustNotPromote` because naming one with attribution
   * is correct behaviour: the violation is asserting it as local fact, not
   * mentioning it at all.
   */
  peerOnlyValues: string[];
  /** The current head value for a temporal question, when one applies. */
  expectTemporalHead: string | null;
  /** A superseded value that must be recognisable as previously valid, not as an error. */
  expectPriorValue: string | null;
  mustEscalate: boolean;
  /** Content that is unavailable and must not be invented. */
  mustNotFabricate: string[];
  note: string;
};

export type ExpectationSet = {
  oracleId: string;
  /** Surface forms a model may legitimately use for a constraint claim id. */
  constraintMatchers: Record<string, string[]>;
  /** Tokens that mark a statement as attributed rather than asserted locally. */
  attributionTokens: string[];
  expectations: TurnExpectation[];
};

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

export function loadScenarios(root: string): ScenarioSet {
  const raw = readFileSync(join(root, "scenarios.json"), "utf8");
  return JSON.parse(raw) as ScenarioSet;
}

export function loadExpectations(root: string): ExpectationSet {
  const raw = readFileSync(join(root, "expected-outcomes.json"), "utf8");
  return JSON.parse(raw) as ExpectationSet;
}

/** Decision turns are the evaluated ones, and the only ones that cost a request. */
export function decisionTurns(scenario: Scenario): ScenarioTurn[] {
  return scenario.turns.filter((turn) => turn.kind === "decision");
}

export function totalDecisionTurns(set: ScenarioSet): number {
  return set.scenarios.reduce((sum, scenario) => sum + decisionTurns(scenario).length, 0);
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export type ScenarioProblem = { scenarioId: string; problem: string };

/**
 * Structural soundness, checked before any container starts.
 *
 * A scenario with no decision turn measures nothing; an expectation with no
 * scenario is an oracle for a test that does not run; a decision turn with no
 * expectation is a request spent on an unanswerable question. Each of those is a
 * silent waste of a live call, so each is a hard failure here.
 */
export function scenariosAreSound(
  set: ScenarioSet,
  expectations: ExpectationSet,
): { sound: boolean; problems: ScenarioProblem[] } {
  const problems: ScenarioProblem[] = [];
  const seen = new Set<string>();

  for (const scenario of set.scenarios) {
    if (seen.has(scenario.scenarioId)) {
      problems.push({ scenarioId: scenario.scenarioId, problem: "duplicate scenario id" });
    }
    seen.add(scenario.scenarioId);

    const decisions = decisionTurns(scenario);
    if (decisions.length === 0) {
      problems.push({ scenarioId: scenario.scenarioId, problem: "no decision turn" });
    }

    const turnIds = new Set<string>();
    for (const turn of scenario.turns) {
      if (turnIds.has(turn.turnId)) {
        problems.push({
          scenarioId: scenario.scenarioId,
          problem: `duplicate turn id ${turn.turnId}`,
        });
      }
      turnIds.add(turn.turnId);
    }

    // Every arm must see the same facts initially, so a scenario without a seed
    // turn would be testing recall of something never stated.
    if (!scenario.turns.some((turn) => turn.kind === "seed")) {
      problems.push({ scenarioId: scenario.scenarioId, problem: "no seed turn" });
    }

    for (const turn of decisions) {
      const hit = expectations.expectations.find(
        (entry) => entry.scenarioId === scenario.scenarioId && entry.turnId === turn.turnId,
      );
      if (!hit) {
        problems.push({
          scenarioId: scenario.scenarioId,
          problem: `decision turn ${turn.turnId} has no expectation`,
        });
        continue;
      }
      // An expectation that asserts nothing would pass for every possible
      // response, which is the vacuous-criterion shape Stage 1 had to repair.
      const asserts =
        hit.mustApplyConstraints.length > 0 ||
        hit.mustNotChoose.length > 0 ||
        hit.mustCite.length > 0 ||
        hit.mustNotPromote.length > 0 ||
        hit.expectTemporalHead !== null ||
        hit.mustEscalate ||
        hit.mustNotFabricate.length > 0;
      if (!asserts) {
        problems.push({
          scenarioId: scenario.scenarioId,
          problem: `expectation for ${turn.turnId} asserts nothing`,
        });
      }
    }
  }

  for (const entry of expectations.expectations) {
    const scenario = set.scenarios.find((item) => item.scenarioId === entry.scenarioId);
    if (!scenario) {
      problems.push({ scenarioId: entry.scenarioId, problem: "expectation names no scenario" });
      continue;
    }
    if (!scenario.turns.some((turn) => turn.turnId === entry.turnId && turn.kind === "decision")) {
      problems.push({
        scenarioId: entry.scenarioId,
        problem: `expectation names non-decision turn ${entry.turnId}`,
      });
    }
  }

  return { sound: problems.length === 0, problems };
}

export function scenarioDigest(set: ScenarioSet): string {
  return digest(set);
}
