import { describe, expect, test } from 'bun:test';
import { ExecutionFailure, type ModelFailureEvidence } from './failures.ts';
import { classifyInvocationFailure } from './outcomes.ts';

const model = (evidence: ModelFailureEvidence) => new ExecutionFailure('model_request_failed', evidence);
const reasonOf = (error: unknown) => {
  const classified = classifyInvocationFailure(error, 'anthropic');
  return classified.kind === 'failure'
    ? `${classified.failure.category}/${classified.failure.reason}`
    : classified.kind;
};

describe('invocation failure classification', () => {
  test('each boundary outcome maps to its category, from typed evidence only', () => {
    const cases: [unknown, string][] = [
      [
        model({ kind: 'terminal', code: 'admission_refused', reason: 'step_budget_exhausted' }),
        'step_limit/step_budget_exhausted',
      ],
      [model({ kind: 'terminal', code: 'admission_refused', reason: 'ownership_lost' }), 'fail_stop'],
      [model({ kind: 'terminal', code: 'admission_refused', reason: 'not_dispatchable' }), 'superseded'],
      [model({ kind: 'terminal', code: 'cancelled' }), 'superseded'],
      [new ExecutionFailure('dispatch_refused'), 'superseded'],
      [
        model({ kind: 'terminal', code: 'credential_unavailable', reason: 'unconfigured' }),
        'authorization/authorization_missing',
      ],
      [
        model({ kind: 'terminal', code: 'credential_unavailable', reason: 'renewal_failed' }),
        'authorization/authorization_rejected',
      ],
      [
        model({ kind: 'terminal', code: 'credential_unavailable', reason: 'reauthorization_required' }),
        'authorization/authorization_rejected',
      ],
      [model({ kind: 'terminal', code: 'credential_unavailable' }), 'provider_failure/provider_unavailable'],
      [model({ kind: 'terminal', code: 'request_timeout' }), 'provider_failure/request_timeout'],
      [model({ kind: 'terminal', code: 'redirect_refused' }), 'provider_failure/redirect_refused'],
      [model({ kind: 'terminal', code: 'provider_unreachable' }), 'provider_failure/provider_unreachable'],
      [model({ kind: 'terminal', code: 'persistence_failure' }), 'runtime_failure/persistence_failure'],
      [model({ kind: 'terminal', code: 'endpoint_refused' }), 'runtime_failure/invariant_violation'],
      [model({ kind: 'http', status: 401 }), 'authorization/authorization_rejected'],
      [model({ kind: 'http', status: 429 }), 'rate_or_quota_limit/rate_limited'],
      [model({ kind: 'http', status: 503 }), 'provider_failure/provider_unavailable'],
      [model({ kind: 'http', status: 400 }), 'provider_failure/unexpected_provider_response'],
      [model({ kind: 'unknown' }), 'provider_failure/unexpected_provider_response'],
      [new ExecutionFailure('unsafe_model_output'), 'provider_failure/unsupported_response'],
      [new ExecutionFailure('tool_call_unrepresentable'), 'tool_failure/tool_call_unrepresentable'],
      [new ExecutionFailure('tool_handling_failed'), 'tool_failure/tool_handling_failed'],
      [
        Object.assign(new Error('Recursion limit reached'), { name: 'GraphRecursionError' }),
        'runtime_failure/invariant_violation',
      ],
      [new Error('anything else'), 'runtime_failure/invariant_violation'],
    ];
    for (const [error, expected] of cases) expect([String(expected), reasonOf(error)]).toEqual([expected, expected]);
  });

  test('failures inside framework wrappers and aggregates are found', () => {
    const wrapped = Object.assign(new Error('wrapped'), { cause: new ExecutionFailure('tool_handling_failed') });
    expect(reasonOf(wrapped)).toBe('tool_failure/tool_handling_failed');
    expect(reasonOf(new AggregateError([new Error('x'), new ExecutionFailure('unsafe_model_output')]))).toBe(
      'provider_failure/unsupported_response',
    );
  });
});
