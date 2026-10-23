import { describe, expect, test } from 'bun:test';
import {
  adaptOpenAIRequest,
  CODEX_0_151_0,
  classifyOpenAIError,
  type OpenAIAdaptRefusal,
  openaiProfileFor,
  ResponsesCompletion,
} from './profile.ts';

const profile = CODEX_0_151_0;
const URL_OK = 'https://chatgpt.com/backend-api/codex/responses';
const context = {
  profile,
  model: 'gpt-5.6-sol',
  conversationId: '00000000-0000-4000-8000-0000000000aa',
  accessToken: 'synthetic-openai-access-token',
  accountId: 'acct_synthetic',
};
const request = (body: Record<string, unknown>, url = URL_OK, method = 'POST') => ({
  url: new URL(url),
  method,
  headers: new Headers({ authorization: 'Bearer sentinel', 'x-stainless-os': 'Linux', 'openai-organization': 'org' }),
  body: JSON.stringify(body),
});
const BODY = {
  model: 'gpt-5.6-sol',
  stream: true,
  tools: [{ type: 'function', name: 'mcp_Read', parameters: { type: 'object' }, description: 'Read', strict: null }],
  text: {},
  store: false,
  temperature: 0.2,
  max_output_tokens: 100,
  input: [{ type: 'message', role: 'user', content: 'Read a.' }],
};

describe('adaptOpenAIRequest', () => {
  test('completes the measured profile, removes what the reference never sends and rebuilds headers', () => {
    const adapted = adaptOpenAIRequest(request(BODY), context);
    if ('refused' in adapted) throw new Error(adapted.refused);
    expect(adapted.url.href).toBe(URL_OK);
    expect(Object.fromEntries(adapted.headers)).toEqual({
      accept: 'text/event-stream',
      'content-type': 'application/json',
      authorization: 'Bearer synthetic-openai-access-token',
      'chatgpt-account-id': 'acct_synthetic',
      originator: 'codex_exec',
      version: '0.151.0',
      'user-agent': 'codex_exec/0.151.0 (Linux 6.0.0; x86_64) agent-runtime',
      'session-id': context.conversationId,
      'thread-id': context.conversationId,
      'x-client-request-id': context.conversationId,
      'x-codex-routing-hint': 'model=gpt-5.6-sol',
    });
    expect(JSON.parse(adapted.body)).toEqual({
      model: 'gpt-5.6-sol',
      stream: true,
      tools: [
        { type: 'function', name: 'mcp_Read', parameters: { type: 'object' }, description: 'Read', strict: false },
      ],
      text: { verbosity: 'low' },
      store: false,
      input: BODY.input,
      tool_choice: 'auto',
      include: ['reasoning.encrypted_content'],
      parallel_tool_calls: false,
      reasoning: { context: 'all_turns', effort: 'low' },
    });
  });

  test('refuses anything the profile cannot carry', () => {
    const cases: [ReturnType<typeof request>, OpenAIAdaptRefusal][] = [
      [request(BODY, 'https://chatgpt.com/backend-api/codex/responses?x=1'), 'unsupported_endpoint'],
      [request(BODY, 'https://api.openai.com/v1/responses'), 'unsupported_endpoint'],
      [request(BODY, URL_OK, 'GET'), 'unsupported_endpoint'],
      [request({ ...BODY, model: 'other-model' }), 'model_not_bound'],
      [request({ ...BODY, input: [] }), 'invalid_body'],
      [request({ ...BODY, messages: [{}], input: undefined }), 'invalid_body'],
      [request({ ...BODY, tools: [{ type: 'function', function: { name: 'x' } }] }), 'tool_shape_unsupported'],
      [
        request({ ...BODY, tools: [{ type: 'function', name: 'x', parameters: { $defs: {} } }] }),
        'tool_schema_not_authored',
      ],
    ];
    for (const [input, reason] of cases) expect(adaptOpenAIRequest(input, context)).toEqual({ refused: reason });
    expect(adaptOpenAIRequest(request(BODY), { ...context, accountId: '' })).toEqual({
      refused: 'credential_incomplete',
    });
  });

  test('profiles are selected by exact ID', () => {
    expect(openaiProfileFor('codex-0.151.0')).toBe(profile);
    expect(openaiProfileFor('codex')).toBeUndefined();
    expect(Object.isFrozen(profile)).toBe(true);
  });
});

const data = (payload: Record<string, unknown>) => `data: ${JSON.stringify(payload)}\n\n`;
const named = (type: string, payload: Record<string, unknown> = {}) =>
  `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`;
const complete = (render: (type: string, payload?: Record<string, unknown>) => string) =>
  render('response.created', { response: { status: 'in_progress' } }) +
  render('response.output_item.added', { item: { type: 'function_call' } }) +
  render('response.function_call_arguments.done', { arguments: '{"a":1}' }) +
  render('response.completed', { response: { status: 'completed', output: [{ type: 'function_call' }] } });

/** Observes like the terminal: stops at the end the check reports, returning the bytes passed on. */
function observeUntilEnd(text: string, size: number) {
  const completion = new ResponsesCompletion();
  const bytes = new TextEncoder().encode(text);
  const passed: Uint8Array[] = [];
  let endAt: number | undefined;
  for (let offset = 0; offset < bytes.length; offset += size) {
    const chunk = bytes.slice(offset, offset + size);
    completion.observe(chunk);
    endAt = completion.endAt;
    passed.push(endAt === undefined ? chunk : chunk.subarray(0, endAt));
    if (endAt !== undefined) break;
  }
  const read = new Uint8Array(passed.reduce((total, part) => total + part.length, 0));
  let at = 0;
  for (const part of passed) {
    read.set(part, at);
    at += part.length;
  }
  return { completion, endAt, read };
}

function observe(text: string, size: number) {
  const completion = new ResponsesCompletion();
  const bytes = new TextEncoder().encode(text);
  for (let offset = 0; offset < bytes.length; offset += size) completion.observe(bytes.slice(offset, offset + size));
  return completion;
}

describe('ResponsesCompletion', () => {
  const dataOnly = (type: string, payload: Record<string, unknown> = {}) => data({ type, ...payload });
  for (const [name, render] of [
    ['data lines', dataOnly],
    ['event lines', named],
  ] as const) {
    test(`recognizes a completed stream with ${name}, whatever the chunking`, () => {
      for (const size of [1, 3, 64, 1 << 20]) expect(observe(complete(render), size).complete).toBe(true);
    });

    test(`complete tool arguments without response.completed are not a complete response (${name})`, () => {
      const text = complete(render);
      expect(observe(text.slice(0, text.lastIndexOf(name === 'data lines' ? 'data:' : 'event:')), 2).complete).toBe(
        false,
      );
    });

    test(`failed, incomplete and error events fail the stream (${name})`, () => {
      for (const type of ['response.failed', 'response.incomplete', 'error']) {
        const failed = observe(render(type) + complete(render), 7);
        expect([failed.complete, failed.failed]).toEqual([false, true]);
      }
    });

    test(`the response ends with the completed event: nothing after it is read (${name})`, () => {
      const head = complete(render);
      for (const trailer of [
        render('response.output_text.delta'),
        render('error'),
        render('codex.response.metadata'),
        'data: [DONE]\n\n',
        'data: not json at all\n\n',
      ]) {
        for (const size of [1, 5, 64, 1 << 20]) {
          const { completion, endAt, read } = observeUntilEnd(head + trailer, size);
          expect([completion.complete, completion.failed]).toEqual([true, false]);
          expect(endAt).toBeDefined();
          // Exactly the completed event is passed on, through its terminating blank line.
          expect(new TextDecoder().decode(read)).toBe(head);
        }
      }
    });
  }

  test('CRLF line endings end the completed event at its blank line', () => {
    const head = complete(dataOnly).replaceAll('\n', '\r\n');
    const text = `${head}data: {"type":"error"}\r\n\r\n`;
    const whole = observeUntilEnd(text, 1 << 20);
    expect(whole.completion.complete).toBe(true);
    expect(new TextDecoder().decode(whole.read)).toBe(head);
    // Split between the CR and LF of the final blank line, the response ends at the CR (itself a line end).
    const split = observeUntilEnd(text, 1);
    expect(split.completion.complete).toBe(true);
    expect(new TextDecoder().decode(split.read)).toBe(head.slice(0, -1));
  });

  test('keeps a bounded summary of event names only, for an incomplete stream', () => {
    const reports: string[] = [];
    const completion = new ResponsesCompletion((summary) => reports.push(summary));
    const text =
      dataOnly('response.created', { response: { instructions: 'secret-looking content' } }) +
      dataOnly('response.output_text.delta', { delta: 'a' }) +
      dataOnly('response.output_text.delta', { delta: 'b' }) +
      dataOnly('Weird Type!') +
      'data: [DONE]\n\n' +
      'data: {"no":"type"}\n\n';
    completion.observe(new TextEncoder().encode(text));
    expect(completion.complete).toBe(false);
    completion.onIncomplete();
    expect(reports).toEqual(['response.created,response.output_text.delta*2,other,done_marker,untyped']);
    const many = new ResponsesCompletion();
    for (let index = 0; index < 100; index++) many.observe(new TextEncoder().encode(dataOnly(`t${index % 2}.x`)));
    expect(many.summary().split(',')).toHaveLength(65);
    expect(many.summary().endsWith(',more')).toBe(true);
  });

  test('a nested type or an oversized leading field is never taken for completion', () => {
    expect(observe(data({ response: { type: 'response.completed' } }), 4).complete).toBe(false);
    expect(observe(`data: {"pad":"${'x'.repeat(2000)}","type":"response.completed"}\n\n`, 64).complete).toBe(false);
  });
});

describe('classifyOpenAIError', () => {
  test('uses allowlisted codes, then the status', () => {
    const body = (code: string) => JSON.stringify({ error: { code, message: 'x' } });
    const cases: [number, string | undefined, string][] = [
      [429, body('usage_limit_reached'), 'quota_exhausted'],
      [429, body('rate_limit_exceeded'), 'rate_limited'],
      [429, undefined, 'rate_limited'],
      [400, body('model_not_found'), 'model_unsupported'],
      [401, '{"detail":"Unauthorized"}', 'auth_rejected'],
      [403, undefined, 'auth_rejected'],
      [503, undefined, 'overloaded'],
      [500, '<html>', 'server_error'],
      [400, undefined, 'bad_request'],
      [418, undefined, 'unknown'],
    ];
    for (const [status, text, code] of cases) expect(classifyOpenAIError(status, text)).toBe(code as never);
  });
});
