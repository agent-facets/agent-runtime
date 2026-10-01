// Classification of a failed invocation into a recorded run failure (Decision 14). Only the typed evidence the
// boundary kept is consulted — never exception text. Some failures are not the run's to record: a request refused
// because cancellation was accepted (or the run otherwise moved on) is `superseded`, and lost ownership is
// `fail_stop`, because nothing may be written or dispatched without it.
import { type FailureReason, failureFor } from '../domain/failures.ts';
import { classify } from '../providers/failure-mapping.ts';
import type { Failure, Provider } from '../records/schemas.ts';
import { type ExecutionFailureCode, executionFailureOf } from './failures.ts';
import type { TerminalErrorCode } from './terminal.ts';

export type FailureClassification =
  | { kind: 'failure'; failure: Failure }
  | { kind: 'superseded' }
  | { kind: 'fail_stop' };

const fail = (reason: FailureReason, provider: Provider, attemptId?: string): FailureClassification => ({
  kind: 'failure',
  failure: failureFor(reason, {
    provider,
    ...(attemptId === undefined ? {} : { operation: { kind: 'model_attempt', attemptId } }),
  }),
});

const TERMINAL_REASONS: Partial<Record<TerminalErrorCode, FailureReason>> = {
  request_timeout: 'request_timeout',
  endpoint_refused: 'invariant_violation',
  // The runtime builds every request; one its provider profile cannot represent is the runtime's fault.
  request_refused: 'invariant_violation',
  redirect_refused: 'redirect_refused',
  provider_unreachable: 'provider_unreachable',
  incomplete_response: 'incomplete_response',
  persistence_failure: 'persistence_failure',
  invariant_violation: 'invariant_violation',
};

const EXECUTION_REASONS: Partial<Record<ExecutionFailureCode, FailureReason>> = {
  unsafe_model_output: 'unsupported_response',
  model_output_too_large: 'unsupported_response',
  model_output_unstorable: 'unsupported_response',
  tool_call_unrepresentable: 'tool_call_unrepresentable',
  tool_handling_failed: 'tool_handling_failed',
  invariant_violation: 'invariant_violation',
};

export function classifyInvocationFailure(error: unknown, provider: Provider): FailureClassification {
  const failure = executionFailureOf(error);
  if (failure === undefined) return fail('invariant_violation', provider);
  if (failure.code === 'dispatch_refused') return { kind: 'superseded' };
  if (failure.code !== 'model_request_failed')
    return fail(EXECUTION_REASONS[failure.code] ?? 'invariant_violation', provider);

  const evidence = failure.evidence ?? { kind: 'unknown' as const };
  if (evidence.kind === 'provider') {
    // Renewal has already been spent or was unavailable by the time a classified failure reaches the run.
    const classified = classify({
      kind: 'inference',
      provider,
      attemptId: evidence.attemptId,
      evidence: {
        kind: 'http',
        status: evidence.status,
        code: evidence.code,
        ...(evidence.retryAfter === undefined ? {} : { retryAfter: evidence.retryAfter }),
      },
      renewalAvailable: false,
      now: new Date(),
    });
    return classified.kind === 'failure'
      ? classified
      : fail('unexpected_provider_response', provider, evidence.attemptId);
  }
  if (evidence.kind === 'http') {
    const classified = classify({
      kind: 'inference',
      provider,
      attemptId: '00000000-0000-4000-8000-000000000000',
      evidence: { kind: 'http', status: evidence.status, code: 'unknown' },
      renewalAvailable: false,
      now: new Date(),
    });
    return classified.kind === 'failure'
      ? { kind: 'failure', failure: { ...classified.failure, operation: { kind: 'runtime' } } }
      : fail('unexpected_provider_response', provider);
  }
  if (evidence.kind === 'unknown') return fail('unexpected_provider_response', provider);

  switch (evidence.code) {
    case 'cancelled':
      return { kind: 'superseded' };
    case 'admission_refused':
      if (evidence.reason === 'step_budget_exhausted') return fail('step_budget_exhausted', provider);
      if (evidence.reason === 'request_ceiling_reached') return fail('request_ceiling_reached', provider);
      if (evidence.reason === 'ownership_lost') return { kind: 'fail_stop' };
      return { kind: 'superseded' };
    case 'credential_unavailable':
      if (evidence.reason === 'unconfigured') return fail('authorization_missing', provider);
      if (evidence.reason === 'reauthorization_required' || evidence.reason === 'renewal_failed') {
        return fail('authorization_rejected', provider);
      }
      return fail('provider_unavailable', provider);
    default:
      return fail(TERMINAL_REASONS[evidence.code] ?? 'invariant_violation', provider, evidence.attemptId);
  }
}
