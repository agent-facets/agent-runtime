import { describe, expect, test } from 'bun:test';
import { FAILURE_REASONS, failureFor } from '../domain/failures.ts';
import { failureCategorySchema, failureSchema } from '../records/schemas.ts';
import { type Classification, classify, type ProviderEvidence, retryAfterSeconds } from './failure-mapping.ts';

const attemptId = '00000000-0000-4000-8000-000000000001';
const operationId = 'b'.repeat(64);
const now = new Date('2026-09-29T12:00:00Z');
const http = (
  status: number,
  code: Extract<ProviderEvidence, { kind: 'http' }>['code'] = 'unknown',
  retryAfter?: string,
) => ({ kind: 'http', status, code, retryAfter }) as const;

const inference = (evidence: ProviderEvidence, renewalAvailable = false) =>
  classify({ kind: 'inference', provider: 'anthropic', attemptId, evidence, renewalAvailable, now });

function failureOf(classification: Classification) {
  if (classification.kind !== 'failure') throw new Error(`expected a failure, got ${classification.kind}`);
  return classification.failure;
}

describe('failure catalogue', () => {
  test('every reason builds a valid, credential-free failure', () => {
    for (const reason of Object.keys(FAILURE_REASONS) as (keyof typeof FAILURE_REASONS)[]) {
      for (const provider of [undefined, 'anthropic', 'openai'] as const) {
        const failure = failureFor(reason, { provider });
        expect(failureSchema.safeParse(failure).success).toBe(true);
        expect(failure.message).not.toContain('{provider}');
        expect(failure.message.charAt(0)).toBe(failure.message.charAt(0).toUpperCase());
      }
    }
  });

  test('every category has at least one reason', () => {
    const used = new Set(Object.values(FAILURE_REASONS).map((entry) => entry.category));
    expect([...used].sort()).toEqual([...failureCategorySchema.options].sort());
  });

  test('authorization and usage-limit guidance differ', () => {
    expect(failureFor('authorization_rejected', { provider: 'openai' }).remediation).toContain('Reauthorize OpenAI');
    const quota = failureFor('quota_exhausted', { provider: 'openai' }).remediation ?? '';
    expect(quota).toContain('Wait');
    expect(quota).not.toContain('Reauthorize');
  });
});

describe('failure mapping by operation context', () => {
  test('device-login polling 403/404 means keep polling, while the same inference statuses are failures', () => {
    for (const status of [403, 404]) {
      expect(classify({ kind: 'device_poll', provider: 'openai', evidence: http(status) })).toEqual({
        kind: 'continue_polling',
      });
    }
    expect(failureOf(inference(http(403))).category).toBe('authorization');
    expect(failureOf(inference(http(404, 'model_unsupported'))).reason).toBe('model_unsupported');
    expect(failureOf(inference(http(404))).category).toBe('provider_failure');
  });

  test('device-login outcomes are never run failures', () => {
    expect(classify({ kind: 'device_poll', provider: 'openai', evidence: http(400, 'auth_rejected') })).toEqual({
      kind: 'login_failed',
      reason: 'login_denied',
    });
    expect(classify({ kind: 'device_poll', provider: 'openai', evidence: http(400, 'auth_expired') })).toEqual({
      kind: 'login_failed',
      reason: 'login_expired',
    });
    expect(
      classify({ kind: 'device_poll', provider: 'openai', evidence: { kind: 'transport', problem: 'network' } }),
    ).toEqual({ kind: 'continue_polling' });
  });

  test('only an explicit refresh-grant rejection requires reauthorization', () => {
    const refresh = (evidence: ProviderEvidence) =>
      classify({ kind: 'credential_refresh', provider: 'anthropic', evidence });
    expect(refresh(http(400, 'auth_rejected'))).toEqual({ kind: 'reauthorization_required' });
    expect(refresh(http(401))).toEqual({ kind: 'reauthorization_required' });
    for (const evidence of [
      http(500),
      http(429),
      http(400, 'bad_request'),
      { kind: 'transport', problem: 'timeout' } as const,
    ]) {
      expect(refresh(evidence)).toEqual({ kind: 'temporarily_unavailable' });
    }
  });

  test('an expired credential takes the single renewal path only while it remains available', () => {
    expect(inference(http(401, 'auth_expired'), true)).toEqual({ kind: 'renew_credentials' });
    expect(failureOf(inference(http(401, 'auth_expired'), false)).reason).toBe('authorization_expired');
    expect(failureOf(inference(http(401, 'auth_rejected'), true)).reason).toBe('authorization_rejected');
  });

  test('typed provider codes take precedence over the HTTP status', () => {
    expect(failureOf(inference(http(429, 'quota_exhausted'))).reason).toBe('quota_exhausted');
    expect(failureOf(inference(http(429, 'rate_limited'))).reason).toBe('rate_limited');
    expect(failureOf(inference(http(403, 'quota_exhausted'))).category).toBe('rate_or_quota_limit');
    expect(failureOf(inference(http(400, 'bad_request'))).reason).toBe('request_rejected');
    expect(failureOf(inference(http(400))).reason).toBe('unexpected_provider_response');
    expect(failureOf(inference(http(529))).reason).toBe('provider_unavailable');
  });

  test('transport problems are provider failures, never authorization', () => {
    const cases = {
      timeout: 'request_timeout',
      network: 'provider_unreachable',
      truncated_stream: 'incomplete_response',
      missing_terminal_event: 'incomplete_response',
      unsupported_response: 'unsupported_response',
      redirect_refused: 'redirect_refused',
    } as const;
    for (const [problem, reason] of Object.entries(cases)) {
      const failure = failureOf(inference({ kind: 'transport', problem: problem as keyof typeof cases }));
      expect(failure).toMatchObject({
        category: 'provider_failure',
        reason,
        operation: { kind: 'model_attempt', attemptId },
      });
    }
  });

  test('rate limits carry a clamped retry-after', () => {
    expect(failureOf(inference(http(429, 'rate_limited', '30'))).retryAfterSeconds).toBe(30);
    expect(failureOf(inference(http(429, 'rate_limited', 'soon'))).retryAfterSeconds).toBeUndefined();
  });

  test('non-provider contexts', () => {
    expect(failureOf(classify({ kind: 'step_budget' }))).toMatchObject({ category: 'step_limit' });
    expect(classify({ kind: 'continuation', problem: 'inspection_unavailable' })).toEqual({
      kind: 'temporarily_unavailable',
    });
    for (const problem of [
      'saved_state_missing',
      'saved_state_unusable',
      'definition_changed',
      'question_binding_mismatch',
      'run_binding_unavailable',
    ] as const) {
      expect(failureOf(classify({ kind: 'continuation', problem })).category).toBe('continuation_unavailable');
    }
    expect(classify({ kind: 'tool', operationId, problem: 'expected_refusal' })).toEqual({ kind: 'tool_refusal' });
    expect(failureOf(classify({ kind: 'tool', operationId, problem: 'call_unrepresentable' }))).toMatchObject({
      category: 'tool_failure',
      operation: { kind: 'tool_operation', operationId },
    });
    expect(failureOf(classify({ kind: 'tool', operationId, problem: 'handling_failed' })).category).toBe(
      'tool_failure',
    );
    for (const problem of ['no_op_continuation', 'missing_final_result', 'persistence', 'invariant'] as const) {
      expect(failureOf(classify({ kind: 'runtime', problem })).category).toBe('runtime_failure');
    }
    expect(classify({ kind: 'control', control: 'cancelled' })).toEqual({ kind: 'control', control: 'cancelled' });
    expect(classify({ kind: 'control', control: 'graph_interrupt' })).toEqual({
      kind: 'control',
      control: 'graph_interrupt',
    });
  });
});

describe('retry-after parsing', () => {
  test('accepts delay seconds and HTTP dates, clamping to a week', () => {
    expect(retryAfterSeconds('0', now)).toBe(0);
    expect(retryAfterSeconds('120', now)).toBe(120);
    expect(retryAfterSeconds('99999999', now)).toBe(604_800);
    expect(retryAfterSeconds('Tue, 29 Sep 2026 12:01:00 GMT', now)).toBe(60);
    expect(retryAfterSeconds('Tue, 29 Sep 2026 11:00:00 GMT', now)).toBe(0);
  });

  test('ignores malformed, negative and fractional values', () => {
    for (const value of ['-5', '1.5', '', 'soon', '12 seconds', '2026-09-29T12:01:00Z', '1e3']) {
      expect(retryAfterSeconds(value, now)).toBeUndefined();
    }
    expect(retryAfterSeconds(undefined, now)).toBeUndefined();
  });
});
