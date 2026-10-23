// Tool-call identity and the operation ledger contract.
//
// A tool call's identity is its logical binding: the run, the model message that issued it and the provider's
// call ID. The ledger records each call before it runs and its outcome after, and is consulted first: a call that
// was already completed is answered from the record instead of running again, while the same arguments under a
// new call ID are new work. A reused provider call ID bound to a different message, tool or arguments is not a
// cache hit but an invalid call.
import type { KeyedSerializer } from '../persistence/keyed-serializer.ts';
import { canonicalJson, digestOf } from '../records/canonical.ts';
import { type RecordedToolOutcome, type RunStore, RunStoreError } from '../records/run-store.ts';
import { operationIdFor } from '../records/schemas.ts';
import { RESULT_TOO_LARGE, type ToolOutcome } from '../workspace/results.ts';

export interface ToolCallIdentity {
  operationId: string;
  modelMessageId: string;
  providerToolCallId: string;
  toolName: string;
  arguments: Record<string, unknown>;
  argumentDigest: string;
}

export type OperationStart =
  /** Run the tool (a new call, or one that started but never completed, such as a question being resumed). */
  | { kind: 'execute' }
  /** The call already completed; its recorded outcome is the result. */
  | { kind: 'reuse'; outcome: ToolOutcome<unknown> }
  /** The run no longer permits new work (for example, cancellation was accepted). */
  | { kind: 'not_dispatchable' };

export class ToolCallConflict extends Error {
  override readonly name = 'ToolCallConflict';
  constructor() {
    super('a provider tool-call ID was reused with a different binding');
  }
}

export interface OperationLedger {
  /** Records the call as started (or finds its record). Throws ToolCallConflict for a conflicting reuse. */
  start(identity: ToolCallIdentity): Promise<OperationStart>;
  /** Records the outcome that is returned to the agent. */
  complete(identity: ToolCallIdentity, outcome: ToolOutcome<unknown>): Promise<void>;
}

/** The identity of a call, or undefined when it cannot be represented (no ID, oversized or non-JSON arguments). */
export function identityFor(
  runId: string,
  modelMessageId: string,
  call: { id?: string; name: string; args: unknown },
): ToolCallIdentity | undefined {
  if (typeof call.id !== 'string') return undefined;
  if (typeof call.args !== 'object' || call.args === null || Array.isArray(call.args)) return undefined;
  try {
    return {
      operationId: operationIdFor(runId, modelMessageId, call.id),
      modelMessageId,
      providerToolCallId: call.id,
      toolName: call.name,
      arguments: call.args as Record<string, unknown>,
      argumentDigest: digestOf(call.args),
    };
  } catch {
    return undefined;
  }
}

/** Recorded results are bounded in PostgreSQL's jsonb text form, which is not the compact JSON form. */
export const RECORDED_OUTCOME_MAX_BYTES = 69_000;

/**
 * An upper estimate of `jsonb::text` length in bytes: compact JSON plus the space PostgreSQL writes after each
 * member and element separator.
 */
export function jsonbTextBytes(value: unknown): number {
  let separators = 0;
  const visit = (item: unknown) => {
    if (Array.isArray(item)) {
      separators += Math.max(item.length - 1, 0);
      item.forEach(visit);
    } else if (item !== null && typeof item === 'object') {
      const entries = Object.values(item);
      separators += entries.length + Math.max(entries.length - 1, 0);
      entries.forEach(visit);
    }
  };
  visit(value);
  return new TextEncoder().encode(JSON.stringify(value)).byteLength + separators;
}

/** The outcome as it will be both recorded and returned: itself, or the fixed size refusal if it cannot be stored. */
export function recordableOutcome<T>(outcome: ToolOutcome<T>): ToolOutcome<T> {
  return jsonbTextBytes(outcome) <= RECORDED_OUTCOME_MAX_BYTES ? outcome : RESULT_TOO_LARGE;
}

/** The ToolMessage content for an outcome: canonical, so a reused record reads exactly like the original. */
export function outcomeContent(outcome: ToolOutcome<unknown>): string {
  return canonicalJson(outcome);
}

/** The durable ledger for one invocation: starts go through the run's short dispatch gate. */
export function runOperationLedger(options: {
  store: Pick<RunStore, 'startToolOperation' | 'completeToolOperation'>;
  gates: KeyedSerializer;
  runId: string;
  invocationId: string;
}): OperationLedger {
  const { store, gates, runId, invocationId } = options;
  return {
    async start(identity) {
      try {
        const start = await gates.run(runId, () => store.startToolOperation(runId, invocationId, identity));
        return start.kind === 'reuse'
          ? { kind: 'reuse', outcome: start.outcome as unknown as ToolOutcome<unknown> }
          : start;
      } catch (error) {
        if (error instanceof RunStoreError && error.code === 'tool_call_conflict') throw new ToolCallConflict();
        throw error;
      }
    },
    complete: (identity, outcome) =>
      store.completeToolOperation(runId, identity, outcome as unknown as RecordedToolOutcome),
  };
}
