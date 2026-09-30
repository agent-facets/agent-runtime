import { describe, expect, test } from 'bun:test';
import { CLAUDE_CLI_2_1_280 } from './profile.ts';
import { classifyInferenceError, type InferenceErrorKind, StreamCompletion } from './response.ts';

const profile = CLAUDE_CLI_2_1_280;
const errorBody = (type: string, message = 'x', details?: Record<string, unknown>) =>
  JSON.stringify({ type: 'error', error: { type, message, ...(details === undefined ? {} : { details }) } });
const versionRejection = (rejected: string, required: string) =>
  errorBody(
    'invalid_request_error',
    `Claude Code ${rejected} does not support this model; version ${required} or newer is required.`,
    { error_code: 'claude_code_version_too_old' },
  );

describe('classifyInferenceError', () => {
  test('uses the documented error type, then the status', () => {
    const cases: [number, string | undefined, InferenceErrorKind][] = [
      [401, errorBody('authentication_error'), 'authentication'],
      [403, errorBody('permission_error'), 'permission'],
      [429, errorBody('rate_limit_error'), 'rate_limited'],
      [529, errorBody('overloaded_error'), 'overloaded'],
      [404, errorBody('not_found_error'), 'model_not_found'],
      [413, errorBody('request_too_large'), 'request_too_large'],
      [400, errorBody('invalid_request_error'), 'invalid_request'],
      [500, errorBody('api_error'), 'server_error'],
      [401, undefined, 'authentication'],
      [429, 'Too Many Requests', 'rate_limited'],
      [502, '<html>', 'server_error'],
      [404, undefined, 'unknown'],
      [418, errorBody('teapot_error'), 'unknown'],
    ];
    for (const [status, body, kind] of cases) expect(classifyInferenceError(status, body, profile)).toBe(kind);
  });

  test('recognizes a minimum-version rejection only for the version this profile reports', () => {
    expect(classifyInferenceError(400, versionRejection('2.1.280', '2.1.300'), profile)).toBe(
      'client_version_rejected',
    );
    expect(classifyInferenceError(400, versionRejection('2.1.87', '2.1.251'), profile)).toBe('invalid_request');
    expect(classifyInferenceError(400, versionRejection('2.1.280', '2.1.99'), profile)).toBe('invalid_request');
    expect(classifyInferenceError(400, versionRejection('2.1.280', '02.1.300'), profile)).toBe('invalid_request');
  });

  test('an oversized body is classified by status alone', () => {
    const padded = errorBody('permission_error', 'y'.repeat(16 * 1024));
    expect(classifyInferenceError(401, padded, profile)).toBe('authentication');
  });
});

const event = (name: string, data: unknown = { type: name }) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
const COMPLETE = [
  event('message_start', { type: 'message_start', message: { id: 'm' } }),
  event('ping'),
  event('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
  event('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } }),
  event('content_block_stop'),
  event('message_delta'),
  event('message_stop'),
].join('');

function observe(text: string, chunkSize: number): boolean {
  const completion = new StreamCompletion();
  const bytes = new TextEncoder().encode(text);
  for (let offset = 0; offset < bytes.length; offset += chunkSize)
    completion.observe(bytes.slice(offset, offset + chunkSize));
  return completion.complete;
}

describe('StreamCompletion', () => {
  test('a complete stream is recognized whatever the chunking, with LF or CRLF line ends', () => {
    for (const size of [1, 2, 7, 64, 100_000]) {
      expect(observe(COMPLETE, size)).toBe(true);
      expect(observe(COMPLETE.replaceAll('\n', '\r\n'), size)).toBe(true);
    }
  });

  test('a stream cut anywhere before message_stop is incomplete', () => {
    const cut = COMPLETE.indexOf('event: message_stop');
    for (const end of [
      0,
      10,
      COMPLETE.indexOf('event: content_block_delta') + 30,
      cut,
      cut + 'event: message_st'.length,
    ]) {
      expect(observe(COMPLETE.slice(0, end), 3)).toBe(false);
    }
  });

  test('an error event, or content after message_stop, is not a successful end', () => {
    expect(observe(COMPLETE.replace(event('message_stop'), event('error') + event('message_stop')), 5)).toBe(false);
    expect(observe(COMPLETE + event('content_block_delta'), 5)).toBe(false);
    expect(observe(COMPLETE + event('ping'), 5)).toBe(true);
  });

  test('failure is known as soon as an error event or late content is seen', () => {
    const completion = new StreamCompletion();
    completion.observe(new TextEncoder().encode(event('message_start') + event('ping')));
    expect(completion.failed).toBe(false);
    completion.observe(new TextEncoder().encode('event: error\n'));
    expect(completion.failed).toBe(true);
    const late = new StreamCompletion();
    late.observe(new TextEncoder().encode(COMPLETE));
    expect([late.complete, late.failed]).toEqual([true, false]);
    late.observe(new TextEncoder().encode(event('content_block_delta')));
    expect([late.complete, late.failed]).toEqual([false, true]);
  });

  test('event names inside data never count, and long data lines use bounded memory', () => {
    const smuggled = COMPLETE.replace(
      event('message_stop'),
      event('content_block_delta', { text: 'event: message_stop\\n' }),
    );
    expect(observe(smuggled, 4)).toBe(false);
    const long = COMPLETE.replace('"hi"', `"${'z'.repeat(1_000_000)}"`);
    expect(observe(long, 4096)).toBe(true);
  });
});
