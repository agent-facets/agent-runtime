// Offline G5: stock ChatOpenAI (streaming Responses) inside the stock agent, every request through the real terminal
// with the measured Codex profile and credentials from the real coordinator. The network is fake and is the
// independent witness; the credential issuer is a fake too (OpenAI authorization arrives in its own block).
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemorySaver } from '@langchain/langgraph';
import { MemoryLedger } from '../../../test-support/memory-ledger.ts';
import { persistedText } from '../../../test-support/scripted-model.ts';
import { createFixture } from '../../../test-support/workspace.ts';
import { CredentialCoordinator, type IssuerOutcome, REFRESH_MARGIN_MS } from '../../credentials/coordinator.ts';
import { CredentialScreen, ScreenScope } from '../../credentials/screening.ts';
import { CredentialStore } from '../../credentials/store.ts';
import { createExecutionAgent } from '../../execution/agent.ts';
import { executionFailureOf, ModelCallReports } from '../../execution/failures.ts';
import { InvocationExecutor, type InvocationSettlement } from '../../execution/invocation.ts';
import { classifyInvocationFailure } from '../../execution/outcomes.ts';
import { type AdmissionTicket, createTerminal } from '../../execution/terminal.ts';
import { READ_TOOL } from '../../execution/tools.ts';
import { KeyedSerializer } from '../../persistence/keyed-serializer.ts';
import { createContentPolicy } from '../../security/content-policy.ts';
import {
  createOpenAIModel,
  openaiCredentials,
  openaiInferencePolicy,
  openaiRenewal,
  openaiTerminalHooks,
} from './inference.ts';
import { CODEX_0_151_0 } from './profile.ts';

const profile = CODEX_0_151_0;
const MODEL = 'gpt-5.6-sol';
const scratch = mkdtempSync(join(tmpdir(), 'agent-runtime-openai-g5-'));
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

// --- Responses event streams, `data:` lines only, as the Codex backend was observed to send ----------------------

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

function toolTurn(options: { withoutCompleted?: boolean; failed?: boolean } = {}): string {
  const call = {
    id: 'fc_01',
    type: 'function_call',
    call_id: 'call_01',
    name: READ_TOOL,
    arguments: JSON.stringify({ mode: 'file', path: 'notes/plan.md' }),
    status: 'completed',
  };
  let text =
    data('response.created', { response: response('resp_01', 'in_progress', []) }) +
    data('response.output_item.added', { output_index: 0, item: REASONING }) +
    data('response.output_item.done', { output_index: 0, item: REASONING }) +
    data('response.output_item.added', { output_index: 1, item: { ...call, arguments: '', status: 'in_progress' } }) +
    data('response.function_call_arguments.delta', {
      output_index: 1,
      item_id: 'fc_01',
      delta: call.arguments.slice(0, 9),
    }) +
    data('response.function_call_arguments.delta', {
      output_index: 1,
      item_id: 'fc_01',
      delta: call.arguments.slice(9),
    }) +
    data('response.function_call_arguments.done', { output_index: 1, item_id: 'fc_01', arguments: call.arguments }) +
    data('response.output_item.done', { output_index: 1, item: call });
  if (options.failed) return text + data('response.failed', { response: response('resp_01', 'failed', []) });
  if (!options.withoutCompleted)
    text += data('response.completed', { response: response('resp_01', 'completed', [REASONING, call]) });
  return text;
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

function sse(text: string, options: { stall?: boolean } = {}): Response {
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset < bytes.length) controller.enqueue(bytes.slice(offset, ++offset));
      else if (!options.stall) controller.close();
      else return new Promise(() => {});
    },
  });
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
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

// --- A run wired the way production will wire it ------------------------------------------------------------------

let runs = 0;

async function harness(options: {
  replies: (Response | (() => Response))[];
  expiresAtMs?: number;
  issuer?: (generation: number) => IssuerOutcome;
  deadlineMs?: number;
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
  const scope = new ScreenScope(screen);
  const reports = new ModelCallReports();
  const admitted: string[] = [];
  const runId = `00000000-0000-4000-8000-${String(runs).padStart(12, '0')}`;
  const hooks = openaiTerminalHooks({ profile, model: MODEL, conversationId: runId });
  const terminal = createTerminal({
    policy: openaiInferencePolicy(profile),
    signal: new AbortController().signal,
    ...(options.deadlineMs === undefined ? {} : { deadlineMs: options.deadlineMs }),
    credentials: openaiCredentials(coordinator, scope),
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
    transport: net.fetchImpl,
    prepare: hooks.prepare,
    completion: hooks.completion,
    failures: { classify: hooks.classify, report: reports.record },
    renewal: openaiRenewal(coordinator),
  });
  const saver = new MemorySaver();
  const agent = createExecutionAgent({
    runId,
    model: createOpenAIModel({ model: MODEL, terminal, profile }),
    checkpointer: saver,
    workspace,
    contentPolicy: () => createContentPolicy(screen.matcher()),
    operations: new MemoryLedger(),
    modelCallSettled: () => scope.release(),
    reports,
  });
  const executor = new InvocationExecutor(new KeyedSerializer());
  const run = () => executor.start({ runId, agent, input: { kind: 'initial', goal: GOAL }, budgetMax: 10 });
  const messages = async () =>
    (await agent.graph.getState({ configurable: { thread_id: runId } })).values.messages as { content: unknown }[];
  return { run, runId, net, admitted, saver, refreshed, messages };
}

const GOAL = 'Summarize notes/plan.md.';
const failureOf = (settlement: InvocationSettlement) => {
  if (settlement.kind !== 'failed') throw new Error(`expected a failure, got ${settlement.kind}`);
  return {
    evidence: executionFailureOf(settlement.error)?.evidence,
    classified: classifyInvocationFailure(settlement.error, 'openai'),
  };
};

const ALLOWED_HEADERS = [
  'accept',
  'authorization',
  'chatgpt-account-id',
  'content-type',
  'originator',
  'session-id',
  'thread-id',
  'user-agent',
  'version',
  'x-client-request-id',
  'x-codex-routing-hint',
];

describe('offline G5: the Responses wire profile through the stock model', () => {
  test('two turns: reasoning and the function call are replayed statelessly with matching call IDs', async () => {
    const h = await harness({ replies: [() => sse(toolTurn()), () => sse(textTurn('resp_02', 'Two steps.'))] });
    expect(await h.run().settled).toEqual({ kind: 'finished' });
    expect(h.net.sent).toHaveLength(2);
    expect(h.admitted).toHaveLength(2);

    for (const sent of h.net.sent) {
      expect(sent.url).toBe('https://chatgpt.com/backend-api/codex/responses');
      expect(Object.keys(sent.headers).sort()).toEqual(ALLOWED_HEADERS);
      expect(sent.headers).toMatchObject({
        accept: 'text/event-stream',
        authorization: `Bearer ${access(1)}`,
        'chatgpt-account-id': account(1),
        originator: 'codex_exec',
        version: '0.151.0',
        'thread-id': h.runId,
        'x-codex-routing-hint': `model=${MODEL}`,
      });
      expect(sent.body).toMatchObject({
        model: MODEL,
        stream: true,
        store: false,
        tool_choice: 'auto',
        include: ['reasoning.encrypted_content'],
        parallel_tool_calls: false,
        reasoning: { context: 'all_turns', effort: 'low' },
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
    }

    const replay = h.net.sent[1]?.body.input ?? [];
    expect(replay.find((item) => item.type === 'reasoning')).toEqual(REASONING);
    const call = replay.find((item) => item.type === 'function_call');
    expect(call).toMatchObject({ call_id: 'call_01', name: 'mcp_Read' });
    const output = replay.find((item) => item.type === 'function_call_output');
    expect(output?.call_id).toBe('call_01');
    expect(JSON.parse(String(output?.output)).outcome).toBe('ok');
    expect(persistedText(h.saver)).not.toContain(access(1));
  });

  test('ambient API configuration never reaches a subscription request', async () => {
    const saved = { key: process.env.OPENAI_API_KEY, organization: process.env.OPENAI_ORGANIZATION };
    process.env.OPENAI_API_KEY = 'sk-ambient-billed-key-must-not-be-used';
    process.env.OPENAI_ORGANIZATION = 'org-ambient';
    try {
      const h = await harness({ replies: [() => sse(textTurn('resp_x', 'ok'))] });
      expect(await h.run().settled).toEqual({ kind: 'finished' });
      const serialized = JSON.stringify(h.net.sent);
      expect(serialized).not.toContain('sk-ambient');
      expect(serialized).not.toContain('org-ambient');
      expect(h.net.sent[0]?.headers.authorization).toBe(`Bearer ${access(1)}`);
    } finally {
      for (const [name, value] of [
        ['OPENAI_API_KEY', saved.key],
        ['OPENAI_ORGANIZATION', saved.organization],
      ] as const) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });
});

describe('offline G5: only a completed response becomes a message', () => {
  for (const [name, reply] of [
    ['complete tool arguments without response.completed', () => sse(toolTurn({ withoutCompleted: true }))],
    ['a response.failed event', () => sse(toolTurn({ failed: true }))],
  ] as const) {
    test(`${name} fails the run and stores no assistant message`, async () => {
      const h = await harness({ replies: [reply] });
      const { evidence, classified } = failureOf(await h.run().settled);
      expect(evidence).toMatchObject({ kind: 'terminal', code: 'incomplete_response', attemptId: h.admitted[0] });
      expect(classified).toMatchObject({ failure: { reason: 'incomplete_response' } });
      expect((await h.messages()).map((message) => message.content)).toEqual([GOAL]);
      expect(h.net.sent).toHaveLength(1);
    });
  }

  test('a redirect is refused, not followed', async () => {
    const h = await harness({
      replies: [new Response(null, { status: 307, headers: { location: 'https://elsewhere.example/' } })],
    });
    const { evidence, classified } = failureOf(await h.run().settled);
    expect(evidence).toMatchObject({ kind: 'terminal', code: 'redirect_refused', attemptId: h.admitted[0] });
    expect(classified).toMatchObject({ failure: { reason: 'redirect_refused' } });
    expect(h.net.sent).toHaveLength(1);
  });

  test('a body that stalls past the deadline ends the request as a timeout', async () => {
    const h = await harness({
      replies: [() => sse(data('response.created', { response: response('r', 'in_progress', []) }), { stall: true })],
      deadlineMs: 150,
    });
    const { evidence, classified } = failureOf(await h.run().settled);
    expect(evidence).toMatchObject({ kind: 'terminal', code: 'request_timeout', attemptId: h.admitted[0] });
    expect(classified).toMatchObject({ failure: { reason: 'request_timeout' } });
  });
});

describe('offline G5: credentials and failures', () => {
  test('a rotated credential is used as a whole: token and account come from the same generation', async () => {
    const h = await harness({
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
    const h = await harness({
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
    ['a server error', errorResponse(502), { category: 'provider_failure', reason: 'provider_unavailable' }],
  ];
  for (const [name, reply, expected] of typed) {
    test(`${name} is classified with its attempt, sent once and never retried`, async () => {
      const h = await harness({ replies: [reply] });
      const { evidence, classified } = failureOf(await h.run().settled);
      expect(evidence).toMatchObject({ kind: 'provider', attemptId: h.admitted[0] });
      expect(classified).toMatchObject({
        failure: { ...expected, operation: { kind: 'model_attempt', attemptId: h.admitted[0] } },
      });
      expect(h.net.sent).toHaveLength(1);
    });
  }

  test('control: retries living in `configuration` would reach the request path, and the factory sets none', async () => {
    const { ChatOpenAI } = await import('@langchain/openai');
    const net = network(Array.from({ length: 6 }, () => () => errorResponse(500)));
    const hazardous = new ChatOpenAI({
      model: MODEL,
      useResponsesApi: true,
      streaming: true,
      maxRetries: 0,
      apiKey: 'sentinel',
      configuration: { baseURL: profile.baseURL, fetch: net.fetchImpl, maxRetries: 1 },
    });
    await expect(hazardous.invoke('hi')).rejects.toThrow();
    expect(net.sent.length).toBeGreaterThan(1);

    const safe = network([errorResponse(500)]);
    const model = createOpenAIModel({ model: MODEL, terminal: safe.fetchImpl, profile });
    await expect(model.invoke('hi')).rejects.toThrow();
    expect(safe.sent).toHaveLength(1);
  }, 20_000);
});
