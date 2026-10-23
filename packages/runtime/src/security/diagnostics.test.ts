import { describe, expect, test } from 'bun:test';
import { diagnosticLogger, formatDiagnostic } from './diagnostics.ts';

const SECRET = 'sk-ant-oat01-SyntheticSyntheticSynthetic0123456789';
const REJECTED = '{"event":"diagnostic_rejected"}';

describe('safe diagnostics', () => {
  test('accepts flat allowlisted fields with validated values', () => {
    expect(
      formatDiagnostic({
        event: 'provider_request_failed',
        provider: 'anthropic',
        operation: 'inference',
        attemptId: '00000000-0000-4000-8000-000000000001',
        status: 429,
        retryAfterSeconds: 30,
      }),
    ).toBe(
      '{"event":"provider_request_failed","provider":"anthropic","operation":"inference","attemptId":"00000000-0000-4000-8000-000000000001","status":429,"retryAfterSeconds":30}',
    );
  });

  test('a stream summary carries event names only', () => {
    const streamEvents = 'response.created,response.output_text.delta*37,response.completed,codex.response.metadata';
    expect(JSON.parse(formatDiagnostic({ event: 'model_stream_incomplete', streamEvents }))).toEqual({
      event: 'model_stream_incomplete',
      streamEvents,
    });
    expect(formatDiagnostic({ event: 'model_stream_incomplete', streamEvents: '' })).toContain('"streamEvents":""');
    for (const unsafe of [`response.created,${SECRET}`, 'response.created, text with spaces', 'a'.repeat(5000)]) {
      expect(formatDiagnostic({ event: 'model_stream_incomplete', streamEvents: unsafe })).toBe(REJECTED);
    }
  });

  test('rejects raw errors, requests, responses, headers and bodies without echoing them', () => {
    const error = new Error(`request failed: Authorization: Bearer ${SECRET}`);
    const withCause = new Error('outer', { cause: { headers: { authorization: SECRET } } });
    const cases: unknown[] = [
      error,
      withCause,
      { event: 'failed', error },
      { event: 'failed', message: `token ${SECRET}` },
      { event: 'failed', details: { authorization: SECRET } },
      { event: 'failed', headers: new Headers({ authorization: `Bearer ${SECRET}` }) },
      new Request('https://api.invalid/v1', { headers: { authorization: SECRET } }),
      new Response(SECRET),
      { event: 'failed', body: SECRET },
      { event: `failed ${SECRET}` },
      { event: 'failed', reason: SECRET },
      { event: 'failed', sqlState: SECRET },
      { event: 'failed', toJSON: () => ({ event: 'ok' }) },
      Object.create({ event: 'inherited' }),
      Object.defineProperty({ event: 'x' }, 'reason', { get: () => SECRET, enumerable: true }),
      `free text ${SECRET}`,
      null,
    ];
    for (const value of cases) {
      const line = formatDiagnostic(value);
      expect(line).toBe(REJECTED);
      expect(line).not.toContain('Synthetic');
    }
  });

  test('the logger writes one validated line per diagnostic', () => {
    const lines: string[] = [];
    const log = diagnosticLogger((line) => lines.push(line));
    log({ event: 'persistence_fault', reason: 'ownership_lost' });
    log({ event: 'x', message: SECRET } as never);
    expect(lines).toEqual(['{"event":"persistence_fault","reason":"ownership_lost"}', REJECTED]);
  });
});
