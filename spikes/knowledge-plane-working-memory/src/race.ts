// The two-writer races.
//
// These need REAL processes. Two adapters inside one single-threaded runtime is
// not concurrency: the interleaving that makes the race a race cannot occur, and
// reporting one would be inventing a result. Each party is its own container,
// and they meet at a barrier whose release fires from committed rows.
//
// Both cases share the same shape and differ only in what the parties attempt:
//
//   x03  two writers create the same entity from the same absent-state read
//   x04  two writers correct one claim from the same observed version
//
// x04 is the discriminating one. Both parties read head revision N and plan
// revision N+1. A store that enforces revision uniqueness rejects the second; a
// store that does not silently keeps whichever wrote last, and the first
// writer's committed change is gone with no error anywhere.

import { KNOWLEDGE_CONTRACT_VERSION } from "./contract.ts";
import type { CommandRequest, CommandResponse } from "./knowledge/contract.ts";

export type RaceCase = "x03" | "x04";

export const RACE_ENTITY = "ent:race-dup";

/**
 * What each party attempts, built identically for both lanes.
 *
 * The observed version token is passed in by the caller, which read it BEFORE
 * arriving at the barrier. Refreshing it here would quietly repair the staleness
 * the case exists to create.
 */
export function raceRequest(
  raceCase: RaceCase,
  member: string,
  observedToken: string | null,
): CommandRequest {
  const actor = {
    actorId: `agent.${member}@node.ada`,
    actorClass: "agent" as const,
    nodeId: "node.ada",
    onBehalfOf: null,
  };

  if (raceCase === "x03") {
    return {
      contractVersion: KNOWLEDGE_CONTRACT_VERSION,
      command: "CreateEntity",
      actor,
      intent: {
        effectClass: "additive",
        scope: [{ kind: "entity", id: RACE_ENTITY }],
        decisionRef: null,
        justification: `duplicate-create race, ${member}`,
      },
      // Distinct keys: a shared key would make the ledger serialise the race
      // away and the second party would replay rather than execute.
      idempotency: { key: `x03-${member}`, keyScope: "global" },
      guard: { mode: "expected_absent", naturalKeys: [RACE_ENTITY] },
      tick: 3000,
      args: {
        entityId: RACE_ENTITY,
        record: {
          entityId: RACE_ENTITY,
          kind: "component",
          canonicalName: "race duplicate",
          aliases: [],
          mergedInto: null,
          sensitivity: "public",
          visibility: "publishable_full",
          versionToken: "",
        },
      },
    };
  }

  return {
    contractVersion: KNOWLEDGE_CONTRACT_VERSION,
    command: "CorrectClaim",
    actor,
    intent: {
      effectClass: "corrective",
      scope: [{ kind: "claim", id: "clm:auth-ttl" }],
      decisionRef: `dec:x04-${member}`,
      justification: `stale-update race, ${member}`,
    },
    idempotency: { key: `x04-${member}`, keyScope: "global" },
    guard: {
      mode: "expected_version",
      targets: [
        { ref: { kind: "claim", id: "clm:auth-ttl" }, expected: observedToken ?? "<unobserved>" },
      ],
    },
    tick: 3001,
    args: {
      claimId: "clm:auth-ttl",
      // Distinct values, so a lost update is identifiable by CONTENT rather than
      // only by a revision count.
      value: `${member} minutes`,
      reason: `stale-update race, ${member}`,
      evidence: [{ sourceRefId: "src:gh-c-c3", locator: "message" }],
    },
  };
}

export type RaceOutcome = {
  member: string;
  outcome: CommandResponse["outcome"];
  code: string | null;
  revision: number | null;
  /** Only a `failed` response carries this; it is what makes a loss recoverable. */
  applied: "yes" | "no" | "unknown" | null;
};

export function raceOutcome(member: string, response: CommandResponse): RaceOutcome {
  if (response.outcome === "committed") {
    return {
      member,
      outcome: "committed",
      code: null,
      revision: response.effects[0]?.revision ?? null,
      applied: "yes",
    };
  }
  // A store-level rejection arrives as `failed`, not `refused`: the policy
  // permitted the write and the STORE stopped it. Collapsing the two would hide
  // exactly the distinction these cases exist to measure.
  return {
    member,
    outcome: response.outcome,
    code: response.error.code,
    revision: null,
    applied: response.outcome === "failed" ? response.applied : "no",
  };
}
