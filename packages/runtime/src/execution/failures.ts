// Failures raised inside the agent graph. LangGraph records a failed task's exception name and message in its
// checkpoint writes, so anything thrown from a model or tool node must already be safe: a fixed name, a fixed
// message per code, and no text from a provider, SDK, filesystem or credential. Classification evidence travels on
// the object in memory only and is never serialized.
import type { ProviderErrorCode } from '../providers/failure-mapping.ts';
import type { FailedResponse, TerminalErrorCode } from './terminal.ts';

export type ExecutionFailureCode =
  /** A model response contained credential material outside displayable text. */
  | 'unsafe_model_output'
  /** A model response, after sanitation, exceeded the message bound. */
  | 'model_output_too_large'
  /** A model response contained text that cannot be stored. */
  | 'model_output_unstorable'
  /** The model call failed; `evidence` says how. */
  | 'model_request_failed'
  /** A tool call could not be identified safely and was not executed. */
  | 'tool_call_unrepresentable'
  /** A tool call could not be handled safely; the requested action was not performed. */
  | 'tool_handling_failed'
  /** The run no longer permits new work (cancellation or a lost binding); nothing was dispatched. */
  | 'dispatch_refused'
  /** A runtime invariant was violated. */
  | 'invariant_violation';

const MESSAGES: Record<ExecutionFailureCode, string> = {
  unsafe_model_output: 'The model response contained credential material and was withheld.',
  model_output_too_large: 'The model response exceeded the size limit and was withheld.',
  model_output_unstorable: 'The model response contained text that cannot be stored and was withheld.',
  model_request_failed: 'The model request failed.',
  tool_call_unrepresentable: 'A tool call could not be identified safely and was not executed.',
  tool_handling_failed: 'A tool call could not be handled safely; the requested action was not performed.',
  dispatch_refused: 'The run no longer permits new work; nothing was dispatched.',
  invariant_violation: 'The runtime detected an internal inconsistency.',
};

/** What is known about a failed model call, for classification by the controller. Never serialized. */
export type ModelFailureEvidence =
  | { kind: 'terminal'; code: TerminalErrorCode; reason?: string; attemptId?: string }
  /** An unsuccessful response the provider integration classified, with the attempt that received it. */
  | { kind: 'provider'; attemptId: string; status: number; code: ProviderErrorCode; retryAfter?: string }
  /** An HTTP status reported by a model with no provider classification. */
  | { kind: 'http'; status: number }
  | { kind: 'unknown' };

/**
 * The classified unsuccessful responses of one run's model call in progress, passed from the terminal (which
 * classifies them) to the model boundary (which turns the SDK's resulting error into typed evidence). A run makes
 * one model call at a time.
 */
export class ModelCallReports {
  #last: FailedResponse | undefined;

  /** Terminal side: an unsuccessful response was classified. */
  readonly record = (failure: FailedResponse): void => {
    this.#last = failure;
  };

  /** Model boundary side: a new call starts. */
  callStarted(): void {
    this.#last = undefined;
  }

  last(): FailedResponse | undefined {
    return this.#last;
  }
}

export class ExecutionFailure extends Error {
  override readonly name = 'ExecutionFailure';
  constructor(
    readonly code: ExecutionFailureCode,
    readonly evidence?: ModelFailureEvidence,
  ) {
    super(MESSAGES[code]);
  }
}

/**
 * The ExecutionFailure an error carries, looking through framework wrappers' `cause` chains and through the
 * AggregateError the graph throws when several tasks of one step fail (the first failure found wins).
 */
export function executionFailureOf(error: unknown, depth = 0): ExecutionFailure | undefined {
  if (depth > 8 || !(error instanceof Error)) return undefined;
  if (error instanceof ExecutionFailure) return error;
  if (error instanceof AggregateError) {
    for (const inner of error.errors) {
      const found = executionFailureOf(inner, depth + 1);
      if (found !== undefined) return found;
    }
  }
  return executionFailureOf(error.cause, depth + 1);
}
