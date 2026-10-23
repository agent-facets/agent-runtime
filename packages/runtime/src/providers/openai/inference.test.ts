// Offline: stock ChatOpenAI (streaming Responses) inside the stock agent, wired exactly as production wires a run
// (wireOpenAIInvocation), every request through the real terminal with credentials from the real coordinator. The
// network is fake and is the independent witness; the credential issuer is a fake too. No provider is contacted.
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AIMessage, ToolMessage } from '@langchain/core/messages';
import { MemorySaver } from '@langchain/langgraph';
import { MemoryLedger } from '../../../test-support/memory-ledger.ts';
import { persistedText } from '../../../test-support/scripted-model.ts';
import { createFixture } from '../../../test-support/workspace.ts';
import { CredentialCoordinator, type IssuerOutcome, REFRESH_MARGIN_MS } from '../../credentials/coordinator.ts';
import { CredentialScreen } from '../../credentials/screening.ts';
import { CredentialStore } from '../../credentials/store.ts';
import { createExecutionAgent } from '../../execution/agent.ts';
import { executionFailureOf } from '../../execution/failures.ts';
import { InvocationExecutor, type InvocationSettlement } from '../../execution/invocation.ts';
import { classifyInvocationFailure } from '../../execution/outcomes.ts';
import type { AdmissionTicket } from '../../execution/terminal.ts';
import { READ_TOOL } from '../../execution/tools.ts';
import { KeyedSerializer } from '../../persistence/keyed-serializer.ts';
import { createContentPolicy } from '../../security/content-policy.ts';
import { wireOpenAIInvocation } from './binding.ts';
import { createOpenAIModel, OPENAI_PROFILE_ID, openaiResponseRefusal } from './inference.ts';

const MODEL = 'gpt-5.6-sol';
const scratch = mkdtempSync(join(tmpdir(), 'agent-runtime-openai-inference-'));
const fixture = createFixture();
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
  fixture.cleanup();
});
fixture.write('notes/plan.md', 'step one\nstep two\n');
const workspace = fixture.policy();

const NOW = Date.now();
const access = (generation: number) => `synthetic-openai-access-${generation}-token`;
const refresh = (generation: number) => `synthetic-openai-refresh-${generation}-token`;
const account = (generation: number) => `acct_generation_${generation}`;

// --- Responses event streams ---------------------------------------------------------------------------------------

const data = (type: string, payload: Record<string, unknown> = {}) =>
  `data: ${JSON.stringify({ type, ...payload })}\n\n`;
const response = (id: string, status: string, output: unknown[]) => ({
  id,
  object: 'response',
  created_at: 1,
  status,
  model: MODEL,
  output,
  usage: { input_tokens: 7, output_tokens: 5, total_tokens: 12 },
});
const REASONING = { id: 'rs_01', type: 'reasoning', summary: [], encrypted_content: 'gAAAA-opaque-reasoning' };
const CALL = {
  id: 'fc_01',
  type: 'function_call',
  call_id: 'call_01',
  name: READ_TOOL,
  arguments: JSON.stringify({ mode: 'file', path: 'notes/plan.md' }),
  status: 'completed',
};

function toolTurn(ending: 'completed' | 'none' | 'failed' | 'incomplete' = 'completed'): string {
  const text =
    data('response.created', { response: response('resp_01', 'in_progress', []) }) +
    data('response.output_item.added', { output_index: 0, item: REASONING }) +
    data('response.output_item.done', { output_index: 0, item: REASONING }) +
    data('response.output_item.added', { output_index: 1, item: { ...CALL, arguments: '', status: 'in_progress' } }) +
    data('response.function_call_arguments.delta', {
      output_index: 1,
      item_id: 'fc_01',
      delta: CALL.arguments.slice(0, 9),
    }) +
    data('response.function_call_arguments.delta', {
      output_index: 1,
      item_id: 'fc_01',
      delta: CALL.arguments.slice(9),
    }) +
    data('response.function_call_arguments.done', { output_index: 1, item_id: 'fc_01', arguments: CALL.arguments }) +
    data('response.output_item.done', { output_index: 1, item: CALL });
  switch (ending) {
    case 'completed':
      return text + data('response.completed', { response: response('resp_01', 'completed', [REASONING, CALL]) });
    case 'failed':
      return text + data('response.failed', { response: response('resp_01', 'failed', []) });
    case 'incomplete':
      return text + data('response.incomplete', { response: response('resp_01', 'incomplete', [REASONING, CALL]) });
    case 'none':
      return text;
  }
}

function textTurn(id: string, text: string): string {
  const message = {
    id: `msg_${id}`,
    type: 'message',
    role: 'assistant',
    status: 'completed',
    content: [{ type: 'output_text', text, annotations: [] }],
  };
  return (
    data('response.created', { response: response(id, 'in_progress', []) }) +
    data('response.output_item.added', { output_index: 0, item: { ...message, content: [], status: 'in_progress' } }) +
    data('response.content_part.added', {
      output_index: 0,
      item_id: message.id,
      content_index: 0,
      part: { type: 'output_text', text: '' },
    }) +
    data('response.output_text.delta', { output_index: 0, item_id: message.id, content_index: 0, delta: text }) +
    data('response.output_text.done', { output_index: 0, item_id: message.id, content_index: 0, text }) +
    data('response.output_item.done', { output_index: 0, item: message }) +
    data('response.completed', { response: response(id, 'completed', [message]) })
  );
}

/** An event stream delivered one byte per chunk, so every name and value crosses chunk boundaries. */
function sse(text: string, options: { stall?: boolean; contentType?: string | null } = {}): Response {
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset < bytes.length) controller.enqueue(bytes.slice(offset, ++offset));
      else if (!options.stall) controller.close();
      else return new Promise(() => {});
    },
  });
  const contentType = options.contentType === undefined ? 'text/event-stream' : options.contentType;
  const response = new Response(body, contentType === null ? {} : { headers: { 'content-type': contentType } });
  if (contentType === null) response.headers.delete('content-type');
  return response;
}

const errorResponse = (status: number, code?: string, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(code === undefined ? { detail: 'error' } : { error: { code, message: 'x' } }), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

interface Sent {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown> & { input: Record<string, unknown>[] };
}

function network(replies: (Response | (() => Response))[]) {
  const sent: Sent[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    sent.push({ url, headers: Object.fromEntries(new Headers(init.headers)), body: JSON.parse(String(init.body)) });
    const reply = replies.shift();
    if (reply === undefined) throw new Error('unscripted inference request');
    const result = typeof reply === 'function' ? reply() : reply;
    (init.signal as AbortSignal).addEventListener('abort', () => result.body?.cancel().catch(() => {}), { once: true });
    return result;
  }) as unknown as typeof fetch;
  return { sent, fetchImpl };
}

// --- A run wired the way production wires it ----------------------------------------------------------------------

let runs = 0;

async function harness(options: {
  replies: (Response | (() => Response))[];
  expiresAtMs?: number;
  issuer?: (generation: number) => IssuerOutcome;
  deadlineMs?: number;
  profileId?: string;
}) {
  const state = join(scratch, `state-${++runs}`);
  mkdirSync(state, { mode: 0o700 });
  const store = new CredentialStore(join(state, 'credentials'));
  await store.replace({
    version: 1,
    provider: 'openai',
    authMode: 'subscription',
    slot: 'default',
    generation: 1,
    updatedAtMs: NOW,
    lifecycle: 'usable',
    accessToken: access(1),
    refreshToken: refresh(1),
    expiresAtMs: options.expiresAtMs ?? NOW + 3_600_000,
    account: { accountId: account(1) },
  });
  const refreshed: number[] = [];
  const coordinator = new CredentialCoordinator({
    store,
    provider: 'openai',
    slot: 'default',
    issuer: {
      async refresh(current) {
        refreshed.push(current.generation);
        return options.issuer?.(current.generation) ?? { kind: 'unavailable' };
      },
    },
  });
  const net = network(options.replies);
  const screen = new CredentialScreen();
  const admitted: string[] = [];
  const runId = `00000000-0000-4000-8000-${String(runs).padStart(12, '0')}`;
  const cancel = new AbortController();
  const wired = wireOpenAIInvocation({
    binding: {
      provider: 'openai',
      authMode: 'subscription',
      model: MODEL,
      profileId: options.profileId ?? OPENAI_PROFILE_ID,
      credentialSlot: 'default',
    },
    runId,
    coordinator,
    screen,
    admission: {
      async admit(_request, begin): Promise<AdmissionTicket> {
        const attemptId = `00000000-0000-4000-8000-${String(admitted.length + 1).padStart(12, '0')}`;
        admitted.push(attemptId);
        begin();
        return {
          attemptId,
          dispatched: async () => {},
          completed: async () => {},
          abandoned: async () => {},
          unconfirmed: async () => {},
        };
      },
    },
    signal: () => cancel.signal,
    track: () => {},
    deadlineMs: options.deadlineMs ?? 30_000,
    transport: net.fetchImpl,
  });
  if ('unavailable' in wired) return { unavailable: wired.unavailable } as const;
  const saver = new MemorySaver();
  const ledger = new MemoryLedger();
  const agent = createExecutionAgent({
    runId,
    model: wired.model,
    checkpointer: saver,
    workspace,
    contentPolicy: () => createContentPolicy(screen.matcher()),
    operations: ledger,
    modelCallSettled: wired.modelCallSettled,
    reports: wired.reports,
    ...(wired.responseRefusal === undefined ? {} : { responseRefusal: wired.responseRefusal }),
  });
  const executor = new InvocationExecutor(new KeyedSerializer());
  const run = () => executor.start({ runId, agent, input: { kind: 'initial', goal: GOAL }, budgetMax: 10 });
  const messages = async () =>
    (await agent.graph.getState({ configurable: { thread_id: runId } })).values.messages as unknown[];
  return { run, runId, net, admitted, saver, refreshed, messages, cancel };
}

type Harness = Exclude<Awaited<ReturnType<typeof harness>>, { unavailable: string }>;
const wiredHarness = async (options: Parameters<typeof harness>[0]): Promise<Harness> => {
  const h = await harness(options);
  if ('unavailable' in h) throw new Error(`not wired: ${h.unavailable}`);
  return h;
};

const GOAL = 'Summarize notes/plan.md.';
const failureOf = (settlement: InvocationSettlement) => {
  if (settlement.kind !== 'failed') throw new Error(`expected a failure, got ${settlement.kind}`);
  return {
    evidence: executionFailureOf(settlement.error)?.evidence,
    classified: classifyInvocationFailure(settlement.error, 'openai'),
  };
};

describe('OpenAI through the stock model', () => {
  test('two turns: endpoint, headers and settings; reasoning and the call are replayed statelessly', async () => {
    const h = await wiredHarness({
      replies: [() => sse(toolTurn()), () => sse(textTurn('resp_02', 'Two steps.'))],
    });
    expect(await h.run().settled).toEqual({ kind: 'finished' });
    expect(h.net.sent).toHaveLength(2);
    expect(h.admitted).toHaveLength(2);

    for (const sent of h.net.sent) {
      expect(sent.url).toBe('https://chatgpt.com/backend-api/codex/responses');
      expect(sent.headers).toMatchObject({
        accept: 'text/event-stream',
        authorization: `Bearer ${access(1)}`,
        'chatgpt-account-id': account(1),
        originator: 'agent_runtime',
        'session-id': h.runId,
        'thread-id': h.runId,
        'x-client-request-id': h.runId,
      });
      // Nothing claims to be a Codex client, and no API-key identity is sent.
      for (const name of ['version', 'x-codex-routing-hint', 'openai-organization', 'openai-project', 'x-api-key']) {
        expect(sent.headers[name]).toBeUndefined();
      }
      expect(sent.body).toMatchObject({
        model: MODEL,
        stream: true,
        store: false,
        tool_choice: 'auto',
        include: ['reasoning.encrypted_content'],
        parallel_tool_calls: false,
        reasoning: { effort: 'low', context: 'all_turns' },
        text: { verbosity: 'low' },
      });
      for (const key of ['temperature', 'max_output_tokens', 'previous_response_id', 'metadata', 'user']) {
        expect(key in sent.body).toBe(false);
      }
      const tools = sent.body.tools as { type: string; name: string; strict: unknown }[];
      expect(tools.map((tool) => [tool.type, tool.name, tool.strict])).toEqual([
        ['function', 'mcp_Read', false],
        ['function', 'mcp_Search', false],
        ['function', 'mcp_AskUser', false],
      ]);
      expect(sent.body.input[0]).toMatchObject({ role: 'developer' });
    }

    const replay = h.net.sent[1]?.body.input ?? [];
    expect(replay.find((item) => item.type === 'reasoning')).toMatchObject({
      type: 'reasoning',
      encrypted_content: REASONING.encrypted_content,
    });
    expect(replay.find((item) => item.type === 'function_call')).toMatchObject({
      call_id: 'call_01',
      name: 'mcp_Read',
      arguments: CALL.arguments,
    });
    const output = replay.find((item) => item.type === 'function_call_output');
    expect(output?.call_id).toBe('call_01');
    expect(JSON.parse(String(output?.output)).outcome).toBe('ok');

    const last = (await h.messages()).at(-1) as AIMessage;
    expect(last.response_metadata.status).toBe('completed');
    expect(JSON.stringify(last.content)).toContain('Two steps.');
    const persisted = persistedText(h.saver);
    expect(persisted).not.toContain(access(1));
    expect(persisted).not.toContain(refresh(1));
  });

  test('ambient API configuration never reaches a subscription request', async () => {
    const names = ['OPENAI_API_KEY', 'OPENAI_ORGANIZATION', 'OPENAI_PROJECT_ID'] as const;
    const saved = names.map((name) => process.env[name]);
    process.env.OPENAI_API_KEY = 'sk-ambient-billed-key-must-not-be-used';
    process.env.OPENAI_ORGANIZATION = 'org-ambient';
    process.env.OPENAI_PROJECT_ID = 'proj-ambient';
    try {
      const h = await wiredHarness({ replies: [() => sse(textTurn('resp_x', 'ok'))] });
      expect(await h.run().settled).toEqual({ kind: 'finished' });
      const serialized = JSON.stringify(h.net.sent);
      for (const ambient of ['sk-ambient', 'org-ambient', 'proj-ambient', 'subscription-access-uses-the-terminal']) {
        expect(serialized).not.toContain(ambient);
      }
      expect(h.net.sent[0]?.headers.authorization).toBe(`Bearer ${access(1)}`);
    } finally {
      names.forEach((name, index) => {
        const value = saved[index];
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      });
    }
  });

  test('a stored binding with another profile is unsupported, never rebound', async () => {
    expect(await harness({ replies: [], profileId: 'codex-0.151.0' })).toEqual({ unavailable: 'profile_unsupported' });
  });
});

describe('only a response the SDK parsed as completed is stored or acted on', () => {
  for (const [name, ending, reason] of [
    ['complete tool arguments without a terminal event', 'none', 'response_status_missing'],
    ['a response.failed event', 'failed', 'response_status_missing'],
    ['a response.incomplete event', 'incomplete', 'response_incomplete'],
  ] as const) {
    test(`${name} fails the run; the tool never runs and nothing is stored`, async () => {
      const h = await wiredHarness({ replies: [() => sse(toolTurn(ending))] });
      const { evidence, classified } = failureOf(await h.run().settled);
      expect(evidence).toEqual({ kind: 'terminal', code: 'incomplete_response', reason });
      expect(classified).toMatchObject({ failure: { reason: 'incomplete_response' } });
      const messages = await h.messages();
      expect(messages).toHaveLength(1);
      expect(messages.some((message) => ToolMessage.isInstance(message))).toBe(false);
      expect(h.net.sent).toHaveLength(1);
      expect(h.admitted).toHaveLength(1);
    });
  }

  for (const contentType of [null, 'application/json', 'text/plain', 'text/event-stream; charset=utf-8']) {
    test(`a complete stream is accepted whatever its content type (${contentType ?? 'none'})`, async () => {
      const h = await wiredHarness({ replies: [() => sse(textTurn('resp_m', 'Done.'), { contentType })] });
      expect(await h.run().settled).toEqual({ kind: 'finished' });
      expect(JSON.stringify((await h.messages()).at(-1))).toContain('Done.');
      expect(h.net.sent).toHaveLength(1);
    });
  }

  test('a later unrecognized event after completion does not undo it', async () => {
    const h = await wiredHarness({
      replies: [() => sse(textTurn('resp_t', 'Done.') + data('codex.response.metadata', { note: 1 }))],
    });
    expect(await h.run().settled).toEqual({ kind: 'finished' });
    expect(h.net.sent).toHaveLength(1);
  });

  test('an unparseable stream fails the run without a message', async () => {
    const h = await wiredHarness({ replies: [() => sse('data: not json\n\n')] });
    expect(failureOf(await h.run().settled).classified).toMatchObject({ failure: { category: 'provider_failure' } });
    expect(await h.messages()).toHaveLength(1);
  });

  test('a redirect is refused, not followed', async () => {
    const h = await wiredHarness({
      replies: [new Response(null, { status: 307, headers: { location: 'https://elsewhere.example/' } })],
    });
    const { evidence, classified } = failureOf(await h.run().settled);
    expect(evidence).toMatchObject({ kind: 'terminal', code: 'redirect_refused', attemptId: h.admitted[0] });
    expect(classified).toMatchObject({ failure: { reason: 'redirect_refused' } });
    expect(h.net.sent).toHaveLength(1);
  });

  test('a body that stalls past the deadline ends the request as a timeout', async () => {
    const h = await wiredHarness({
      replies: [() => sse(data('response.created', { response: response('r', 'in_progress', []) }), { stall: true })],
      deadlineMs: 150,
    });
    const { evidence, classified } = failureOf(await h.run().settled);
    expect(evidence).toMatchObject({ kind: 'terminal', code: 'request_timeout', attemptId: h.admitted[0] });
    expect(classified).toMatchObject({ failure: { reason: 'request_timeout' } });
  });

  test('cancellation during a stream ends the request as cancelled, with nothing stored', async () => {
    const h = await wiredHarness({
      replies: [() => sse(data('response.created', { response: response('r', 'in_progress', []) }), { stall: true })],
    });
    const running = h.run();
    while (h.net.sent.length === 0) await Bun.sleep(5);
    h.cancel.abort();
    const { evidence } = failureOf(await running.settled);
    expect(evidence).toMatchObject({ kind: 'terminal', code: 'cancelled' });
    expect(await h.messages()).toHaveLength(1);
  });

  test('the parsed-response check itself', () => {
    const message = (metadata: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
      new AIMessage({ content: 'x', response_metadata: metadata, ...extra });
    expect(openaiResponseRefusal(message({ status: 'completed' }))).toBeUndefined();
    expect(openaiResponseRefusal(message({}))).toBe('response_status_missing');
    expect(openaiResponseRefusal(message({ status: 'incomplete' }))).toBe('response_incomplete');
    expect(openaiResponseRefusal(message({ status: 'failed' }))).toBe('response_not_completed');
    expect(openaiResponseRefusal(message({ status: 'completed', error: { code: 'x' } }))).toBe('response_error');
    expect(
      openaiResponseRefusal(
        message({ status: 'completed' }, { invalid_tool_calls: [{ name: 'mcp_Read', args: '{', id: 'c' }] }),
      ),
    ).toBe('response_tool_call_invalid');
  });
});

describe('credentials and failures', () => {
  test('a rotated credential is used as a whole: token and account come from the same generation', async () => {
    const h = await wiredHarness({
      expiresAtMs: NOW + REFRESH_MARGIN_MS - 1,
      issuer: (generation) => ({
        kind: 'refreshed',
        credential: {
          accessToken: access(generation + 1),
          refreshToken: refresh(generation + 1),
          expiresAtMs: NOW + 3_600_000,
          account: { accountId: account(generation + 1) },
        },
      }),
      replies: [() => sse(textTurn('resp_r', 'ok'))],
    });
    expect(await h.run().settled).toEqual({ kind: 'finished' });
    expect(h.refreshed).toEqual([1]);
    expect(h.net.sent[0]?.headers.authorization).toBe(`Bearer ${access(2)}`);
    expect(h.net.sent[0]?.headers['chatgpt-account-id']).toBe(account(2));
  });

  test('an authorization rejection renews once and retries with the next generation, counted', async () => {
    const h = await wiredHarness({
      issuer: (generation) => ({
        kind: 'refreshed',
        credential: { accessToken: access(generation + 1), expiresAtMs: NOW + 3_600_000 },
      }),
      replies: [errorResponse(401), () => sse(textTurn('resp_ok', 'ok'))],
    });
    expect(await h.run().settled).toEqual({ kind: 'finished' });
    expect(h.net.sent.map((sent) => [sent.headers.authorization, sent.headers['chatgpt-account-id']])).toEqual([
      [`Bearer ${access(1)}`, account(1)],
      [`Bearer ${access(2)}`, account(1)],
    ]);
    expect(h.admitted).toHaveLength(2);
    expect(h.refreshed).toEqual([1]);
  });

  test('a rejection right after renewal is final: no third request', async () => {
    const h = await wiredHarness({
      issuer: (generation) => ({
        kind: 'refreshed',
        credential: { accessToken: access(generation + 1), expiresAtMs: NOW + 3_600_000 },
      }),
      replies: [errorResponse(401), errorResponse(401)],
    });
    const { classified } = failureOf(await h.run().settled);
    expect(classified).toMatchObject({ failure: { category: 'authorization' } });
    expect(h.net.sent).toHaveLength(2);
    expect(h.admitted).toHaveLength(2);
  });

  const typed: [string, Response, Record<string, unknown>][] = [
    [
      'an exhausted usage limit',
      errorResponse(429, 'usage_limit_reached', { 'retry-after': '120' }),
      { category: 'rate_or_quota_limit', reason: 'quota_exhausted', retryAfterSeconds: 120 },
    ],
    [
      'a rate limit',
      errorResponse(429, 'rate_limit_exceeded'),
      { category: 'rate_or_quota_limit', reason: 'rate_limited' },
    ],
    ['a forbidden account', errorResponse(403), { category: 'authorization', reason: 'authorization_rejected' }],
    ['a rejected request', errorResponse(400), { category: 'provider_failure', reason: 'request_rejected' }],
    ['a server error', errorResponse(502), { category: 'provider_failure', reason: 'provider_unavailable' }],
  ];
  for (const [name, reply, expected] of typed) {
    test(`${name} is classified with its attempt, sent once and never retried`, async () => {
      const h = await wiredHarness({ replies: [reply] });
      const { evidence, classified } = failureOf(await h.run().settled);
      expect(evidence).toMatchObject({ kind: 'provider', attemptId: h.admitted[0] });
      expect(classified).toMatchObject({
        failure: { ...expected, operation: { kind: 'model_attempt', attemptId: h.admitted[0] } },
      });
      expect(h.net.sent).toHaveLength(1);
    });
  }

  test('the model factory makes exactly one request on a server error: no hidden retries', async () => {
    const safe = network([errorResponse(500), errorResponse(500), errorResponse(500)]);
    const model = createOpenAIModel({ model: MODEL, terminal: safe.fetchImpl, conversationId: 'c' });
    await expect(model.invoke('hi')).rejects.toThrow();
    expect(safe.sent).toHaveLength(1);
  }, 20_000);
});
