// The fixed prompt parts and the bounded response schema.
//
// Every section except the context block is byte-identical across arms. The
// system contract deliberately says nothing about tiers, canon, governance or
// ranking: naming the machinery here would hand W0 and W1 a description of the
// mechanism they exist to be measured without.

import type { Scenario, ScenarioTurn } from "./scenario.ts";

export const SYSTEM_CONTRACT = `## ROLE
You are an agent completing one unit of durable work for a single human owner.

You act on knowledge that has been recorded and reconciled. You do not invent
facts, you do not treat a request as evidence, and you do not fabricate the
contents of anything you cannot read.

When something you are asked to do conflicts with a requirement that binds the
work item, say so rather than quietly choosing a side. When you genuinely cannot
resolve a conflict, ask the owner.

Respond only with a single JSON object matching the response schema. No prose
outside the JSON, no markdown fences.`;

export const RESPONSE_SCHEMA = `## RESPONSE SCHEMA
Return exactly one JSON object:

{
  "decision": "one sentence stating what you are doing",
  "actionsTaken": ["concrete actions, may be empty"],
  "constraintsApplied": ["each requirement that bound this decision, quoted or named"],
  "factsUsed": ["each fact you relied on"],
  "references": ["external identifiers or URIs you are citing, may be empty"],
  "uncertainties": ["anything you could not establish, may be empty"],
  "needsHumanDecision": true or false,
  "humanQuestion": "the question for the owner, or null",
  "rationale": "at most 400 characters"
}`;

export function renderWorkItem(scenario: Scenario, attemptId: string): string {
  return [
    "## WORK ITEM",
    `id: ${scenario.workItemId}`,
    `title: ${scenario.title}`,
    `attempt: ${attemptId}`,
  ].join("\n");
}

/**
 * The shared retrieval block.
 *
 * Rendered from the precomputed bundle, which is byte-identical across arms by
 * construction. This is the section that must never vary, or a delta between
 * arms could be a retrieval delta wearing a working-memory costume.
 */
export function renderRetrieved(entries: ReadonlyArray<{ claimId: string; statement: string }>): string {
  if (entries.length === 0) return "## RETRIEVED\nNothing retrieved.";
  const lines = ["## RETRIEVED", "Material returned by search for this turn:", ""];
  for (const entry of entries) lines.push(`- ${entry.statement}`);
  return lines.join("\n");
}

export function renderTask(turn: ScenarioTurn): string {
  return `## TASK\n${turn.text}`;
}

/** Conversation turns still in the transcript, after any compaction. */
export function renderTranscript(turns: ReadonlyArray<{ turnId: string; text: string }>): string {
  if (turns.length === 0) return "";
  const lines = ["## RECENT CONVERSATION"];
  for (const turn of turns) lines.push(`- ${turn.text}`);
  return lines.join("\n");
}
