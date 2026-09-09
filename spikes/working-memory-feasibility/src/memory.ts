// The turn boundary.
//
// Two operations, and they are the whole integration surface a runtime would
// need: `prepareTurn` before the model is called, `completeTurn` after it
// answers. Nothing here runs mid-generation — a context that can change while a
// response is being produced is not a bounded view of anything.

import type {
  Assembled,
  Dropped,
  MemoryOp,
  RejectedOp,
  WorkingContext,
} from "./context.ts";
import { applyOps, assemble, emptyContext, refresh } from "./context.ts";
import type { Store } from "./store.ts";

export type TurnAt = { runId: string; turnId: number };

export type Prepared = {
  workItemId: string;
  at: TurnAt;
  /** The revision read from the store; the guard for the write that follows. */
  expected: number;
  context: WorkingContext;
  assembled: Assembled;
  /** Knowledge and observations removed during refresh, with the reason. */
  dropped: Dropped[];
};

/**
 * Load, refresh against current knowledge, and render.
 *
 * A fresh process needs only the work item id: everything else comes back from
 * the store. The transcript is not an input.
 */
export async function prepareTurn(
  store: Store,
  workItemId: string,
  at: TurnAt,
): Promise<Prepared> {
  const loaded = (await store.latestContext(workItemId)) ?? emptyContext(workItemId);
  const declared = await store.readDeclaration(workItemId);
  const current = await store.readKnowledge(declared.map((d) => d.id));

  const { context, dropped } = refresh(loaded, declared, current);
  return {
    workItemId,
    at,
    expected: loaded.revision,
    context,
    assembled: assemble(context),
    dropped,
  };
}

export type Completed = {
  context: WorkingContext;
  applied: MemoryOp[];
  rejected: RejectedOp[];
};

/**
 * Apply the turn's memory operations and persist one new revision.
 *
 * A revision is written even when every operation was rejected, because the
 * refresh that happened during `prepareTurn` is itself a change worth keeping.
 */
export async function completeTurn(
  store: Store,
  prepared: Prepared,
  ops: readonly MemoryOp[],
): Promise<Completed> {
  const result = applyOps(prepared.context, ops, prepared.at);
  const context = await store.appendContext(result.context, prepared.expected);
  return { context, applied: result.applied, rejected: result.rejected };
}

// ---------------------------------------------------------------------------
// The client boundary
// ---------------------------------------------------------------------------

/**
 * What a model client has to provide.
 *
 * Scripted turns and a live model implement the same interface, so the live
 * smoke test exercises the same path the deterministic tests do.
 */
export type TurnClient = (input: {
  context: string;
  prompt: string;
  at: TurnAt;
}) => Promise<{ reply: string; ops: MemoryOp[] }>;

export type TurnRecord = {
  at: TurnAt;
  contextText: string;
  reply: string;
  applied: MemoryOp[];
  rejected: RejectedOp[];
  dropped: Dropped[];
  revision: number;
};

/** One full turn: prepare, call the client, apply what it asked for. */
export async function runTurn(
  store: Store,
  workItemId: string,
  at: TurnAt,
  prompt: string,
  client: TurnClient,
): Promise<TurnRecord> {
  const prepared = await prepareTurn(store, workItemId, at);
  const answer = await client({ context: prepared.assembled.text, prompt, at });
  const completed = await completeTurn(store, prepared, answer.ops);
  return {
    at,
    contextText: prepared.assembled.text,
    reply: answer.reply,
    applied: completed.applied,
    rejected: completed.rejected,
    dropped: prepared.dropped,
    revision: completed.context.revision,
  };
}
