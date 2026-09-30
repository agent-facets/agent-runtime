// Classifies provider and runtime problems by the operation they occurred in. The same HTTP status means different
// things in different places: a 403 while polling a device login means "keep polling", while a 403 on inference
// is an authorization rejection. Provider adapters normalize their typed error codes into ProviderErrorCode;
// nothing here reads raw bodies, headers or exception text.
import { type FailureReason, failureFor } from '../domain/failures.ts';
import type { Failure, Provider } from '../records/schemas.ts';

/** Provider error codes after adapter normalization. `unknown` falls back to the HTTP status. */
export type ProviderErrorCode =
  | 'auth_expired'
  | 'auth_rejected'
  | 'rate_limited'
  | 'quota_exhausted'
  | 'model_unsupported'
  | 'overloaded'
  | 'server_error'
  | 'bad_request'
  | 'unknown';

export type TransportProblem =
  | 'timeout'
  | 'network'
  | 'truncated_stream'
  | 'missing_terminal_event'
  | 'unsupported_response'
  | 'redirect_refused';

export type ProviderEvidence =
  | { kind: 'http'; status: number; code: ProviderErrorCode; retryAfter?: string }
  | { kind: 'transport'; problem: TransportProblem };

export type Classification =
  /** Device login is still waiting for the owner; not an error. */
  | { kind: 'continue_polling' }
  /** Device login failed; the operator command reports it. Never a run failure. */
  | { kind: 'login_failed'; reason: 'login_denied' | 'login_expired' | 'login_unavailable' }
  /** One explicit credential renewal is permitted; the retry consumes another model step. */
  | { kind: 'renew_credentials' }
  /** Credentials were definitively rejected; stop using them until the owner reauthorizes. */
  | { kind: 'reauthorization_required' }
  /** Nothing definitive was learned; the last committed state stands and nothing is retried automatically. */
  | { kind: 'temporarily_unavailable' }
  /** An expected tool refusal is a tool outcome, not a failure. */
  | { kind: 'tool_refusal' }
  /** Cancellation and graph control flow keep their own semantics. */
  | { kind: 'control'; control: 'cancelled' | 'graph_interrupt' }
  | { kind: 'failure'; failure: Failure };

export type OperationContext =
  | { kind: 'device_poll'; provider: Provider; evidence: ProviderEvidence }
  | { kind: 'credential_refresh'; provider: Provider; evidence: ProviderEvidence }
  | {
      kind: 'inference';
      provider: Provider;
      attemptId: string;
      evidence: ProviderEvidence;
      renewalAvailable: boolean;
      now: Date;
    }
  | { kind: 'step_budget' }
  | {
      kind: 'continuation';
      problem:
        | 'inspection_unavailable'
        | 'saved_state_missing'
        | 'saved_state_unusable'
        | 'definition_changed'
        | 'question_binding_mismatch'
        | 'run_binding_unavailable';
    }
  | { kind: 'tool'; operationId: string; problem: 'expected_refusal' | 'call_unrepresentable' | 'handling_failed' }
  | { kind: 'runtime'; problem: 'no_op_continuation' | 'missing_final_result' | 'persistence' | 'invariant' }
  | { kind: 'control'; control: 'cancelled' | 'graph_interrupt' };

const fail = (reason: FailureReason, details: Parameters<typeof failureFor>[1] = {}): Classification => ({
  kind: 'failure',
  failure: failureFor(reason, details),
});

const MAX_RETRY_AFTER_SECONDS = 604_800;

/** Retry-After as delay seconds or an HTTP date, clamped to a week. Anything malformed is ignored. */
export function retryAfterSeconds(value: string | undefined, now: Date): number | undefined {
  if (value === undefined) return undefined;
  const text = value.trim();
  let seconds: number;
  if (/^\d{1,10}$/.test(text)) seconds = Number(text);
  else if (/^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(text)) {
    const at = Date.parse(text);
    if (Number.isNaN(at)) return undefined;
    seconds = Math.ceil((at - now.getTime()) / 1000);
  } else return undefined;
  return Math.min(Math.max(seconds, 0), MAX_RETRY_AFTER_SECONDS);
}

/** The normalized code, or for `unknown` the conventional meaning of the status. */
function effectiveCode(evidence: Extract<ProviderEvidence, { kind: 'http' }>): ProviderErrorCode {
  if (evidence.code !== 'unknown') return evidence.code;
  if (evidence.status === 401 || evidence.status === 403) return 'auth_rejected';
  if (evidence.status === 429) return 'rate_limited';
  if (evidence.status === 529 || evidence.status === 503) return 'overloaded';
  if (evidence.status >= 500) return 'server_error';
  return 'unknown';
}

const TRANSPORT_REASONS: Record<TransportProblem, FailureReason> = {
  timeout: 'request_timeout',
  network: 'provider_unreachable',
  truncated_stream: 'incomplete_response',
  missing_terminal_event: 'incomplete_response',
  unsupported_response: 'unsupported_response',
  redirect_refused: 'redirect_refused',
};

export function classify(context: OperationContext): Classification {
  switch (context.kind) {
    case 'device_poll': {
      const { evidence } = context;
      if (evidence.kind === 'transport') {
        return evidence.problem === 'timeout' || evidence.problem === 'network'
          ? { kind: 'continue_polling' }
          : { kind: 'login_failed', reason: 'login_unavailable' };
      }
      // The subscription device flow answers 403/404 while the owner has not yet approved the code.
      if (evidence.status === 403 || evidence.status === 404) return { kind: 'continue_polling' };
      if (evidence.status === 429 || evidence.status >= 500) return { kind: 'continue_polling' };
      if (evidence.code === 'auth_rejected') return { kind: 'login_failed', reason: 'login_denied' };
      if (evidence.code === 'auth_expired') return { kind: 'login_failed', reason: 'login_expired' };
      return { kind: 'login_failed', reason: 'login_unavailable' };
    }

    case 'credential_refresh': {
      const { evidence } = context;
      if (evidence.kind === 'transport') return { kind: 'temporarily_unavailable' };
      const code = effectiveCode(evidence);
      // Only an explicit rejection of the refresh grant is definitive. Anything else may have rotated upstream or
      // may succeed later, so the credential is kept and nothing is retried automatically.
      if (code === 'auth_rejected' || code === 'auth_expired') return { kind: 'reauthorization_required' };
      return { kind: 'temporarily_unavailable' };
    }

    case 'inference':
      return classifyInference(context);

    case 'step_budget':
      return fail('step_budget_exhausted');

    case 'continuation':
      // A temporary inspection outage proves nothing about compatibility; the waiting run stays as recorded.
      if (context.problem === 'inspection_unavailable') return { kind: 'temporarily_unavailable' };
      return fail(context.problem);

    case 'tool': {
      if (context.problem === 'expected_refusal') return { kind: 'tool_refusal' };
      const operation = { kind: 'tool_operation', operationId: context.operationId } as const;
      return fail(context.problem === 'call_unrepresentable' ? 'tool_call_unrepresentable' : 'tool_handling_failed', {
        operation,
      });
    }

    case 'runtime': {
      const reasons = {
        no_op_continuation: 'no_op_continuation',
        missing_final_result: 'missing_final_result',
        persistence: 'persistence_failure',
        invariant: 'invariant_violation',
      } as const satisfies Record<typeof context.problem, FailureReason>;
      return fail(reasons[context.problem]);
    }

    case 'control':
      return { kind: 'control', control: context.control };
  }
}

function classifyInference(context: Extract<OperationContext, { kind: 'inference' }>): Classification {
  const { evidence, provider } = context;
  const operation = { kind: 'model_attempt', attemptId: context.attemptId } as const;
  if (evidence.kind === 'transport') return fail(TRANSPORT_REASONS[evidence.problem], { provider, operation });
  const code = effectiveCode(evidence);
  const retryAfter = retryAfterSeconds(evidence.retryAfter, context.now);
  switch (code) {
    case 'auth_expired':
      return context.renewalAvailable
        ? { kind: 'renew_credentials' }
        : fail('authorization_expired', { provider, operation });
    case 'auth_rejected':
      return fail('authorization_rejected', { provider, operation });
    case 'rate_limited':
      return fail('rate_limited', { provider, operation, retryAfterSeconds: retryAfter });
    case 'quota_exhausted':
      return fail('quota_exhausted', { provider, operation, retryAfterSeconds: retryAfter });
    case 'model_unsupported':
      return fail('model_unsupported', { provider, operation });
    case 'overloaded':
    case 'server_error':
      return fail('provider_unavailable', { provider, operation });
    case 'bad_request':
      return fail('request_rejected', { provider, operation });
    case 'unknown':
      return fail('unexpected_provider_response', { provider, operation });
  }
}
