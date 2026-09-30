// The closed catalogue of run-failure reasons. Every recorded failure is built from an entry here, so its message
// and remediation are application-owned text rather than copied provider, SDK or driver output.
import type { Failure, FailureCategory, Provider } from '../records/schemas.ts';

interface ReasonEntry {
  category: FailureCategory;
  message: string;
  remediation?: string;
}

const REAUTHORIZE = 'Reauthorize {provider} with the documented login command, then start a new run.';
const WAIT =
  'Wait for the usage limit to reset or reduce usage, then start a new run. No other provider or billed access is used.';
const NEW_RUN = 'The recorded history is preserved. Start a new run to continue the work.';

export const FAILURE_REASONS = {
  authorization_missing: {
    category: 'authorization',
    message: '{provider} has no saved authorization.',
    remediation: REAUTHORIZE,
  },
  authorization_rejected: {
    category: 'authorization',
    message: '{provider} rejected the saved authorization and it cannot be renewed.',
    remediation: REAUTHORIZE,
  },
  authorization_expired: {
    category: 'authorization',
    message: '{provider} authorization expired and could not be renewed.',
    remediation: REAUTHORIZE,
  },
  rate_limited: {
    category: 'rate_or_quota_limit',
    message: '{provider} is rate limiting requests.',
    remediation: WAIT,
  },
  quota_exhausted: {
    category: 'rate_or_quota_limit',
    message: 'The subscription usage limit for {provider} is exhausted.',
    remediation: WAIT,
  },
  request_timeout: {
    category: 'provider_failure',
    message: 'The request to {provider} did not complete before its deadline.',
  },
  provider_unreachable: { category: 'provider_failure', message: '{provider} could not be reached.' },
  provider_unavailable: {
    category: 'provider_failure',
    message: '{provider} reported that the service is unavailable or overloaded.',
  },
  model_unsupported: {
    category: 'provider_failure',
    message: '{provider} does not accept the configured model or request profile.',
  },
  request_rejected: { category: 'provider_failure', message: '{provider} rejected the request as invalid.' },
  incomplete_response: {
    category: 'provider_failure',
    message: 'The response from {provider} ended before it was complete; partial output was not used as a result.',
  },
  unsupported_response: {
    category: 'provider_failure',
    message: '{provider} returned a response this runtime does not support.',
  },
  redirect_refused: {
    category: 'provider_failure',
    message: 'A response from {provider} redirected to an unapproved location and was refused.',
  },
  unexpected_provider_response: { category: 'provider_failure', message: '{provider} returned an unexpected error.' },
  step_budget_exhausted: {
    category: 'step_limit',
    message: 'Another model request would exceed this run\u2019s step budget.',
    remediation: 'Start a new run, with a larger budget if appropriate.',
  },
  saved_state_missing: {
    category: 'continuation_unavailable',
    message: 'The saved state needed to continue this run is missing.',
    remediation: NEW_RUN,
  },
  saved_state_unusable: {
    category: 'continuation_unavailable',
    message: 'The saved state needed to continue this run cannot be used.',
    remediation: NEW_RUN,
  },
  definition_changed: {
    category: 'continuation_unavailable',
    message: 'The runtime changed in a way that prevents safely continuing this run.',
    remediation: NEW_RUN,
  },
  question_binding_mismatch: {
    category: 'continuation_unavailable',
    message: 'The saved question does not match the pending question on record.',
    remediation: NEW_RUN,
  },
  run_binding_unavailable: {
    category: 'continuation_unavailable',
    message: 'The workspace or provider configuration this run was started with is no longer available.',
    remediation: NEW_RUN,
  },
  tool_call_unrepresentable: {
    category: 'tool_failure',
    message: 'The agent issued a tool call that could not be identified safely; it was not executed.',
  },
  tool_handling_failed: {
    category: 'tool_failure',
    message: 'A tool call could not be handled safely; the requested action was not performed.',
  },
  no_op_continuation: {
    category: 'runtime_failure',
    message: 'The continuation finished without new agent work, a result or a question.',
  },
  missing_final_result: { category: 'runtime_failure', message: 'The agent finished without a recorded final result.' },
  persistence_failure: { category: 'runtime_failure', message: 'The runtime could not record required run state.' },
  invariant_violation: {
    category: 'runtime_failure',
    message: 'The runtime detected an internal inconsistency and stopped the run.',
  },
} as const satisfies Record<string, ReasonEntry>;

export type FailureReason = keyof typeof FAILURE_REASONS;

const PROVIDER_NAMES: Record<Provider, string> = { anthropic: 'Anthropic', openai: 'OpenAI' };

export interface FailureDetails {
  provider?: Provider;
  operation?: Failure['operation'];
  retryAfterSeconds?: number;
}

/** Builds a recorded failure from the catalogue. Provider-specific wording requires the provider. */
export function failureFor(reason: FailureReason, details: FailureDetails = {}): Failure {
  const entry: ReasonEntry = FAILURE_REASONS[reason];
  const name = details.provider === undefined ? 'the provider' : PROVIDER_NAMES[details.provider];
  const fill = (text: string) => {
    const filled = text.replaceAll('{provider}', name);
    return filled.charAt(0).toUpperCase() + filled.slice(1);
  };
  return {
    category: entry.category,
    reason,
    message: fill(entry.message),
    operation: details.operation ?? { kind: 'runtime' },
    ...(entry.remediation === undefined ? {} : { remediation: fill(entry.remediation) }),
    ...(details.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: details.retryAfterSeconds }),
  };
}
