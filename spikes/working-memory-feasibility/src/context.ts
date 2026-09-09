// The working-context value type and every pure rule that operates on it.
//
// No store, no driver, no clock, no network. Persistence lives in `store.ts`
// and the turn boundary lives in `memory.ts`, so the rules can be read and
// tested without standing anything up.

export const CONTEXT_SCHEMA = "working-memory-feasibility/context/1";

/** Budgets. Mechanical limits, not calibrated values and not model token counts. */
export const BUDGET = {
  maxObservations: 32,
  maxRenderBytes: 4096,
} as const;

/**
 * A reference to a knowledge record the host decided this work item may see.
 *
 * `text` is a snapshot for rendering; the referenced `(id, revision)` stays
 * authoritative. Pins come from the work item's declaration, never from the
 * model.
 */
export type KnowledgeRef = {
  id: string;
  revision: number;
  text: string;
  pinned: boolean;
};

/** A provisional note the model asked to keep. Never authoritative. */
export type Observation = {
  id: string;
  text: string;
  source: { runId: string; turnId: number };
  /** Knowledge revisions this note was written against. */
  basis: Array<{ knowledgeId: string; revision: number }>;
  updatedAtTurn: number;
};

export type WorkingContext = {
  schema: typeof CONTEXT_SCHEMA;
  workItemId: string;
  revision: number;
  knowledge: KnowledgeRef[];
  observations: Observation[];
};

export function emptyContext(workItemId: string): WorkingContext {
  return {
    schema: CONTEXT_SCHEMA,
    workItemId,
    revision: 0,
    knowledge: [],
    observations: [],
  };
}

// ---------------------------------------------------------------------------
// Memory operations
// ---------------------------------------------------------------------------

/**
 * What the model is allowed to ask for at a turn boundary.
 *
 * There is deliberately no operation that writes, edits, retracts, or pins a
 * knowledge record. Provisional memory cannot reach authoritative knowledge
 * because no verb exists for it, not because a filter remembers to say no.
 */
export type MemoryOp =
  | { op: "remember"; id: string; text: string; basis?: string[] }
  | { op: "forget"; id: string };

export type RejectedOp = { op: unknown; code: string; detail: string };

export type ApplyResult = {
  context: WorkingContext;
  applied: MemoryOp[];
  rejected: RejectedOp[];
};

const ID_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,63}$/i;

/**
 * Apply the turn's operations to a context.
 *
 * Rejections are returned rather than thrown: one bad operation should not
 * discard the rest of the turn, and the caller needs to see what was refused.
 */
export function applyOps(
  context: WorkingContext,
  ops: readonly MemoryOp[],
  at: { runId: string; turnId: number },
): ApplyResult {
  const observations = [...context.observations];
  const applied: MemoryOp[] = [];
  const rejected: RejectedOp[] = [];
  const knownIds = new Set(context.knowledge.map((k) => k.id));

  for (const op of ops) {
    if (op === null || typeof op !== "object" || typeof (op as MemoryOp).op !== "string") {
      rejected.push({ op, code: "OP_MALFORMED", detail: "not a memory operation" });
      continue;
    }

    if (op.op === "forget") {
      if (!ID_PATTERN.test(op.id ?? "")) {
        rejected.push({ op, code: "ID_INVALID", detail: "unusable observation id" });
        continue;
      }
      const index = observations.findIndex((o) => o.id === op.id);
      if (index === -1) {
        rejected.push({ op, code: "OBSERVATION_UNKNOWN", detail: op.id });
        continue;
      }
      observations.splice(index, 1);
      applied.push(op);
      continue;
    }

    if (op.op === "remember") {
      if (!ID_PATTERN.test(op.id ?? "")) {
        rejected.push({ op, code: "ID_INVALID", detail: "unusable observation id" });
        continue;
      }
      const text = typeof op.text === "string" ? op.text.trim() : "";
      if (text.length === 0) {
        rejected.push({ op, code: "TEXT_EMPTY", detail: op.id });
        continue;
      }

      // A note may only cite knowledge this context actually holds. Otherwise a
      // model could invent a citation and the note would look grounded.
      const basisIds = op.basis ?? [];
      const unknown = basisIds.filter((id) => !knownIds.has(id));
      if (unknown.length > 0) {
        rejected.push({ op, code: "BASIS_UNKNOWN", detail: unknown.join(", ") });
        continue;
      }

      const basis = basisIds.map((id) => ({
        knowledgeId: id,
        revision: context.knowledge.find((k) => k.id === id)!.revision,
      }));

      const observation: Observation = {
        id: op.id,
        text,
        source: { runId: at.runId, turnId: at.turnId },
        basis,
        updatedAtTurn: at.turnId,
      };

      const index = observations.findIndex((o) => o.id === op.id);
      if (index === -1) observations.push(observation);
      else observations[index] = observation;
      applied.push(op);
      continue;
    }

    rejected.push({ op, code: "OP_UNKNOWN", detail: String((op as { op: string }).op) });
  }

  return {
    context: { ...context, observations },
    applied,
    rejected,
  };
}

// ---------------------------------------------------------------------------
// Refresh against current knowledge
// ---------------------------------------------------------------------------

/** A knowledge record as the store currently holds it. */
export type KnowledgeRecord = {
  id: string;
  revision: number;
  text: string;
  withdrawn: boolean;
};

export type Dropped = { kind: "knowledge" | "observation"; id: string; reason: string };

/**
 * Rebuild the knowledge side of the context from what the store holds now, and
 * drop observations whose basis has moved underneath them.
 *
 * A note written against revision 2 of a record that is now at revision 3 is
 * not silently re-pointed at the new revision: it is removed. Keeping it would
 * present stale reasoning as current, which is the failure this mechanism
 * exists to prevent.
 */
export function refresh(
  context: WorkingContext,
  declared: ReadonlyArray<{ id: string; pinned: boolean }>,
  current: ReadonlyMap<string, KnowledgeRecord>,
): { context: WorkingContext; dropped: Dropped[] } {
  const dropped: Dropped[] = [];
  const knowledge: KnowledgeRef[] = [];

  for (const decl of declared) {
    const record = current.get(decl.id);
    if (!record) {
      dropped.push({ kind: "knowledge", id: decl.id, reason: "MISSING" });
      continue;
    }
    if (record.withdrawn) {
      dropped.push({ kind: "knowledge", id: decl.id, reason: "WITHDRAWN" });
      continue;
    }
    knowledge.push({
      id: record.id,
      revision: record.revision,
      text: record.text,
      pinned: decl.pinned,
    });
  }

  const live = new Map(knowledge.map((k) => [k.id, k.revision]));
  const observations = context.observations.filter((observation) => {
    for (const basis of observation.basis) {
      const revision = live.get(basis.knowledgeId);
      if (revision === undefined) {
        dropped.push({
          kind: "observation",
          id: observation.id,
          reason: `BASIS_GONE:${basis.knowledgeId}`,
        });
        return false;
      }
      if (revision !== basis.revision) {
        dropped.push({
          kind: "observation",
          id: observation.id,
          reason: `BASIS_STALE:${basis.knowledgeId}@${basis.revision}->${revision}`,
        });
        return false;
      }
    }
    return true;
  });

  return { context: { ...context, knowledge, observations }, dropped };
}

// ---------------------------------------------------------------------------
// Bounded assembly
// ---------------------------------------------------------------------------

export class BudgetExceeded extends Error {
  readonly detail: string;

  constructor(detail: string) {
    super(`context budget exceeded: ${detail}`);
    this.name = "BudgetExceeded";
    this.detail = detail;
  }
}

export type Assembled = {
  text: string;
  includedObservations: string[];
  excludedObservations: Array<{ id: string; reason: string }>;
  bytes: number;
};

/**
 * Render the context the model will see.
 *
 * Pinned knowledge is not droppable. If the pins alone do not fit, that is a
 * caller error and it is raised, never absorbed by quietly shipping a context
 * that is missing its constraints.
 */
export function assemble(context: WorkingContext, budget = BUDGET): Assembled {
  const header = `# Working context: ${context.workItemId} (revision ${context.revision})`;
  const knowledgeLines = context.knowledge.map(
    (k) => `- [${k.id}@${k.revision}]${k.pinned ? " (pinned)" : ""} ${k.text}`,
  );

  const required = [header, "", "## Knowledge", ...knowledgeLines, "", "## Observations"];
  const requiredBytes = Buffer.byteLength(required.join("\n"), "utf8");
  if (requiredBytes > budget.maxRenderBytes) {
    throw new BudgetExceeded(
      `knowledge alone is ${requiredBytes} bytes, limit ${budget.maxRenderBytes}`,
    );
  }

  // Most recently touched first, id as a stable tiebreak so the same context
  // always renders the same bytes.
  const ordered = [...context.observations].sort(
    (a, b) => b.updatedAtTurn - a.updatedAtTurn || a.id.localeCompare(b.id),
  );

  const included: string[] = [];
  const excluded: Array<{ id: string; reason: string }> = [];
  const lines = [...required];
  let bytes = requiredBytes;

  for (const observation of ordered) {
    if (included.length >= budget.maxObservations) {
      excluded.push({ id: observation.id, reason: "COUNT" });
      continue;
    }
    const basis =
      observation.basis.length > 0
        ? ` (from ${observation.basis.map((b) => `${b.knowledgeId}@${b.revision}`).join(", ")})`
        : "";
    const line = `- [${observation.id}] ${observation.text}${basis}`;
    const lineBytes = Buffer.byteLength(`\n${line}`, "utf8");
    if (bytes + lineBytes > budget.maxRenderBytes) {
      excluded.push({ id: observation.id, reason: "BYTES" });
      continue;
    }
    lines.push(line);
    bytes += lineBytes;
    included.push(observation.id);
  }

  const text = lines.join("\n");
  return {
    text,
    includedObservations: included,
    excludedObservations: excluded,
    bytes: Buffer.byteLength(text, "utf8"),
  };
}
