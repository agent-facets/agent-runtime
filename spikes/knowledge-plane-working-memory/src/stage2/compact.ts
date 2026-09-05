// Deterministic transcript compaction.
//
// Compaction is identical across every arm: the same turns are dropped, the same
// progress block is produced, and the same witness is emitted. That is what
// makes the compaction scenario a test of the protected block rather than a test
// of who got a better summary — a model-written summary would recover protected
// facts by luck and hand the credit to the wrong mechanism.
//
// The compactor removes conversational text. It does not re-derive facts. If a
// constraint survives compaction it is because something protected it, not
// because the compactor was clever.

import { digest } from "../canonical.ts";
import type { CompactionWitness } from "./contract.ts";
import { ESTIMATOR_ID, neutralTokens } from "./tokens.ts";

export type Turn = {
  turnId: string;
  role: "user" | "assistant";
  text: string;
  /** Digests of execution-plane events this turn produced. */
  eventDigests: string[];
  /** External outputs this turn produced, by reference. */
  outputRefs: string[];
};

/** Turns kept verbatim at the tail. Frozen before any live call. */
export const VERBATIM_TAIL = 2;

export type CompactionResult = {
  progress: string;
  retained: Turn[];
  witness: CompactionWitness | null;
};

export function compact(turns: readonly Turn[], forced: boolean): CompactionResult {
  const before = {
    itemCount: turns.length,
    neutralTokens: totalTokens(turns),
    digest: digest(turns.map((turn) => turn.turnId)),
  };

  if (!forced || turns.length <= VERBATIM_TAIL) {
    return {
      progress: renderProgress([], turns),
      retained: [...turns],
      witness: null,
    };
  }

  const cut = turns.length - VERBATIM_TAIL;
  const dropped = turns.slice(0, cut);
  const retained = turns.slice(cut);

  const witness: CompactionWitness = {
    scope: "transcript",
    triggeredBy: "forced",
    before,
    after: {
      itemCount: retained.length,
      neutralTokens: totalTokens(retained),
      digest: digest(retained.map((turn) => turn.turnId)),
    },
    droppedRefs: [],
    droppedTurnIds: dropped.map((turn) => turn.turnId),
    estimatorId: ESTIMATOR_ID,
  };

  return { progress: renderProgress(dropped, retained), retained, witness };
}

/**
 * What survives a dropped turn.
 *
 * Event digests and output references only — never the prose. A dropped turn's
 * content is gone, which is the point: the scenario asks whether a protected
 * block keeps a constraint salient once the conversation that introduced it has
 * been discarded.
 */
function renderProgress(dropped: readonly Turn[], retained: readonly Turn[]): string {
  const events: string[] = [];
  const outputs: string[] = [];
  for (const turn of [...dropped, ...retained]) {
    for (const event of turn.eventDigests) events.push(event);
    for (const output of turn.outputRefs) outputs.push(output);
  }

  const lines: string[] = ["## TASK PROGRESS"];
  if (dropped.length > 0) {
    lines.push(`${dropped.length} earlier turns were compacted away and are not recoverable.`);
  }
  if (events.length > 0) {
    lines.push("", "Recorded events:");
    for (const event of events) lines.push(`- event ${event}`);
  }
  if (outputs.length > 0) {
    lines.push("", "Outputs produced, available by reference only:");
    for (const output of outputs) lines.push(`- ${output}`);
  }
  if (events.length === 0 && outputs.length === 0 && dropped.length === 0) {
    lines.push("No prior turns.");
  }
  return lines.join("\n");
}

function totalTokens(turns: readonly Turn[]): number {
  let total = 0;
  for (const turn of turns) total += neutralTokens(turn.text);
  return total;
}
