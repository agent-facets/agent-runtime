// Offline G4: the stock ChatAnthropic inside the stock agent, every request through the real terminal with the
// internal package's request profile, credentials from the real coordinator and store. Only the network is fake: it
// is the independent witness of what was sent. No provider is contacted.
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CLAUDE_CLI_2_1_280 } from '@agent-runtime/anthropic-subscription';
import { MemorySaver } from '@langchain/langgraph';
import { MemoryLedger } from '../../../test-support/memory-ledger.ts';
import { persistedText } from '../../../test-support/scripted-model.ts';
import { createFixture } from '../../../test-support/workspace.ts';
import { CredentialCoordinator } from '../../credentials/coordinator.ts';
import type { CredentialRecord } from '../../credentials/record.ts';
import { CredentialScreen, ScreenScope } from '../../credentials/screening.ts';
import { CredentialStore } from '../../credentials/store.ts';
import { createExecutionAgent, SYSTEM_PROMPT } from '../../execution/agent.ts';
import { executionFailureOf, ModelCallReports } from '../../execution/failures.ts';
import { InvocationExecutor, type InvocationSettlement } from '../../execution/invocation.ts';
import { classifyInvocationFailure } from '../../execution/outcomes.ts';
import { type AdmissionTicket, createTerminal } from '../../execution/terminal.ts';
import { ASK_TOOL, READ_TOOL } from '../../execution/tools.ts';
import { KeyedSerializer } from '../../persistence/keyed-serializer.ts';
import { operationIdFor } from '../../records/schemas.ts';
import { createContentPolicy, REDACTION } from '../../security/content-policy.ts';
import { anthropicIssuer, createAnthropicAuthTransport } from './credentials.ts';
import {
  ANTHROPIC_INFERENCE_POLICY,
  anthropicCredentials,
  anthropicRenewal,
  anthropicTerminalHooks,
  createAnthropicModel,
} from './inference.ts';

const profile = CLAUDE_CLI_2_1_280;
const scratch = mkdtempSync(join(tmpdir(), 'agent-runtime-anthropic-g4-'));
const fixture = createFixture();
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
  fixture.cleanup();
});
fixture.write('notes/plan.md', 'step one\nstep two\n');
const workspace = fixture.policy();

const NOW = Date.now();
const access = (generation: number) => `sk-ant-oat01-offline-access-${generation}-token`;
const refresh = (generation: number) => `sk-ant-ort01-offline-refresh-${generation}-token`;

// --- The fake network: Anthropic's Messages API and its token endpoint -------------------------------------------

const event = (name: string, payload: Record<string, unknown> = {}) =>
  `event: ${name}\ndata: ${JSON.stringify({ type: name, ...payload })}\n\n`;

const start = (id: string) =>
  event('message_start', {
    message: {
      id,
      type: 'message',
      role: 'assistant',
      model: 'claude-opus-5',
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 5, output_tokens: 1 },
    },
  });
const finish = (stop: string) =>
  event('message_delta', { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 3 } }) +
  event('message_stop');

function textEvents(id: string, text: string): string {
  return (
    start(id) +
    event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }) +
    event('content_block_delta', { index: 0, delta: { type: 'text_delta', text: text.slice(0, 3) } }) +
    event('content_block_delta', { index: 0, delta: { type: 'text_delta', text: text.slice(3) } }) +
    event('content_block_stop', { index: 0 }) +
    finish('end_turn')
  );
}

function toolEvents(id: string, toolId: string, name: string, input: unknown, options: { cut?: boolean } = {}) {
  const json = JSON.stringify(input);
  const pieces = [json.slice(0, 5), json.slice(5, 11), json.slice(11)];
  let body =
    start(id) +
    event('content_block_start', { index: 0, content_block: { type: 'tool_use', id: toolId, name, input: {} } });
  for (const piece of options.cut ? pieces.slice(0, 2) : pieces) {
    body += event('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: piece } });
  }
  if (options.cut) return body;
  return body + event('content_block_stop', { index: 0 }) + finish('tool_use');
}

/** An event stream delivered one byte per chunk, so every name and value crosses chunk boundaries. */
function sse(text: string, options: { stall?: boolean } = {}): Response {
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset < bytes.length) {
        controller.enqueue(bytes.slice(offset, offset + 1));
        offset++;
      } else if (!options.stall) controller.close();
      else return new Promise(() => {});
    },
  });
  return new Response(body, { headers: { 'content-type': 'text/event-stream', 'request-id': 'req_offline' } });
}

const apiError = (status: number, type: string, message = 'synthetic', extra: Record<string, unknown> = {}) =>
  new Response(JSON.stringify({ type: 'error', error: { type, message, ...extra } }), {
    status,
    headers: { 'content-type': 'application/json', ...(status === 429 ? { 'retry-after': '30' } : {}) },
  });

interface Sent {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown> & { messages: { role: string; content: unknown }[]; system: { text: string }[] };
}

type Reply = Response | (() => Response);

function network(replies: Reply[]) {
  const sent: Sent[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    sent.push({
      url,
      headers: Object.fromEntries(new Headers(init.headers)),
      body: JSON.parse(String(init.body)),
    });
    const reply = replies.shift();
    if (reply === undefined) throw new Error('unscripted inference request');
    const response = typeof reply === 'function' ? reply() : reply;
    const signal = init.signal as AbortSignal;
    // Cancellation reaches a stalled body through the terminal; here it only ends a pending read.
    signal.addEventListener('abort', () => response.body?.cancel().catch(() => {}), { once: true });
    return response;
  }) as unknown as typeof fetch;
  return { sent, fetchImpl };
}

function authNetwork(replies: (Response | { code: string })[]) {
  const sent: Record<string, string>[] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    sent.push(JSON.parse(new TextDecoder().decode(init.body as ArrayBuffer)));
    const reply = replies.shift();
    if (reply === undefined) throw new Error('unscripted auth request');
    if ('code' in reply) throw Object.assign(new Error('synthetic'), { code: reply.code });
    return reply;
  }) as unknown as typeof fetch;
  return { sent, fetchImpl };
}

// --- A run wired as production will wire it -----------------------------------------------------------------------

let runs = 0;

async function harness(options: {
  replies: Reply[];
  auth?: (Response | { code: string })[];
  record?: CredentialRecord;
}) {
  const state = join(scratch, `state-${++runs}`);
  mkdirSync(state, { mode: 0o700 });
  const store = new CredentialStore(join(state, 'credentials'));
  await store.replace(
    options.record ?? {
      version: 1,
      provider: 'anthropic',
      authMode: 'subscription',
      slot: 'default',
      generation: 1,
      updatedAtMs: NOW,
      lifecycle: 'usable',
      accessToken: access(1),
      refreshToken: refresh(1),
      expiresAtMs: NOW + 3_600_000,
      account: {},
    },
  );
  const auth = authNetwork(options.auth ?? []);
  const coordinator = new CredentialCoordinator({
    store,
    provider: 'anthropic',
    slot: 'default',
    issuer: anthropicIssuer({ transport: createAnthropicAuthTransport(auth.fetchImpl) }),
  });
  const net = network(options.replies);
  const screen = new CredentialScreen();
  const scope = new ScreenScope(screen);
  const reports = new ModelCallReports();
  const admitted: string[] = [];
  const hooks = anthropicTerminalHooks(profile);
  const cancel = new AbortController();
  const terminal = createTerminal({
    policy: ANTHROPIC_INFERENCE_POLICY,
    signal: cancel.signal,
    credentials: anthropicCredentials(coordinator, scope),
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
    renewal: anthropicRenewal(coordinator, profile),
  });
  const saver = new MemorySaver();
  const runId = `00000000-0000-4000-8000-${String(runs).padStart(12, '0')}`;
  const agent = createExecutionAgent({
    runId,
    model: createAnthropicModel({ model: 'claude-opus-5', terminal }),
    checkpointer: saver,
    workspace,
    contentPolicy: () => createContentPolicy(screen.matcher()),
    operations: new MemoryLedger(),
    modelCallSettled: () => scope.release(),
    reports,
  });
  const executor = new InvocationExecutor(new KeyedSerializer());
  const run = (input: Parameters<InvocationExecutor['start']>[0]['input']) =>
    executor.start({ runId, agent, input, budgetMax: 10 });
  const messages = async () =>
    (await agent.graph.getState({ configurable: { thread_id: runId } })).values.messages as { content: unknown }[];
  return { run, runId, net, auth, admitted, saver, store, messages, cancel, agent };
}

const failureOf = (settlement: InvocationSettlement) => {
  if (settlement.kind !== 'failed') throw new Error(`expected a failure, got ${settlement.kind}`);
  return {
    evidence: executionFailureOf(settlement.error)?.evidence,
    classified: classifyInvocationFailure(settlement.error, 'anthropic'),
  };
};

const GOAL = 'Summarize notes/plan.md.';

describe('offline G4: the wire profile through the stock model', () => {
  test('a tool round trip over one-byte chunks keeps native names, the profile and the leading user text', async () => {
    const h = await harness({
      replies: [
        () => sse(toolEvents('msg_01', 'toolu_01', READ_TOOL, { mode: 'file', path: 'notes/plan.md' })),
        () => sse(textEvents('msg_02', 'The plan has two steps.')),
      ],
    });
    expect(await h.run({ kind: 'initial', goal: GOAL }).settled).toEqual({ kind: 'finished' });
    expect(h.net.sent).toHaveLength(2);
    expect(h.admitted).toHaveLength(2);

    for (const sent of h.net.sent) {
      expect(sent.url).toBe('https://api.anthropic.com/v1/messages?beta=true');
      expect(sent.headers.authorization).toBe(`Bearer ${access(1)}`);
      expect(sent.headers['anthropic-beta']).toBe('oauth-2025-04-20,interleaved-thinking-2025-05-14');
      expect(sent.headers['user-agent']).toBe('claude-cli/2.1.280 (external, cli)');
      expect(sent.headers['x-api-key']).toBeUndefined();
      expect(sent.headers['anthropic-dangerous-direct-browser-access']).toBeUndefined();
      expect(sent.body.stream).toBe(true);
      expect((sent.body.tools as { name: string }[]).map((tool) => tool.name)).toEqual([
        'mcp_Read',
        'mcp_Search',
        'mcp_AskUser',
      ]);
      expect(sent.body.system.map((block) => block.text).slice(1)).toEqual([profile.identity, SYSTEM_PROMPT]);
      expect(sent.body.system).toHaveLength(3);
      expect(sent.body.messages[0]).toEqual({ role: 'user', content: GOAL });
    }
    // The billing block derives from the leading user text, so it is identical on every turn.
    const billing = h.net.sent.map((sent) => sent.body.system[0]?.text);
    expect(billing[0]).toMatch(
      /^x-anthropic-billing-header: cc_version=2\.1\.280\.[0-9a-f]{3}; cc_entrypoint=sdk-cli; cch=[0-9a-f]{5};$/,
    );
    expect(billing[1]).toBe(billing[0]);

    // The streamed tool call arrived whole and native, ran, and its result was replayed with the matching ID.
    const second = h.net.sent[1]?.body.messages ?? [];
    expect(second[1]).toEqual({
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'toolu_01', name: 'mcp_Read', input: { mode: 'file', path: 'notes/plan.md' } }],
    });
    const result = (second[2]?.content as { type: string; tool_use_id: string; content: string }[])[0];
    expect(result?.type).toBe('tool_result');
    expect(result?.tool_use_id).toBe('toolu_01');
    expect(JSON.parse(String(result?.content)).outcome).toBe('ok');

    const persisted = persistedText(h.saver);
    expect(persisted).not.toContain(access(1));
    expect(persisted).not.toContain(refresh(1));
  });

  test('a question and its false answer are replayed through the stock model', async () => {
    const question = {
      prompt: 'Proceed?',
      input: {
        kind: 'choice',
        multiple: false,
        options: [
          { label: 'No', value: false },
          { label: 'Yes', value: true },
        ],
      },
    };
    const h = await harness({
      replies: [
        () => sse(toolEvents('msg_ask', 'toolu_ask', ASK_TOOL, question)),
        () => sse(textEvents('msg_done', 'Stopping as asked.')),
      ],
    });
    const paused = await h.run({ kind: 'initial', goal: GOAL }).settled;
    if (paused.kind !== 'interrupted') throw new Error(`expected a question, got ${paused.kind}`);
    const questionId = operationIdFor(h.runId, 'msg_ask', 'toolu_ask');
    expect(paused.interrupts[0]?.value).toMatchObject({ questionId, prompt: 'Proceed?' });
    expect(h.net.sent).toHaveLength(1);

    const resumed = await h.run({
      kind: 'resume',
      interruptId: paused.interrupts[0]?.id as string,
      envelope: { questionId, answer: false },
    }).settled;
    expect(resumed).toEqual({ kind: 'finished' });
    expect(h.net.sent).toHaveLength(2);
    const replay = h.net.sent[1]?.body.messages ?? [];
    expect(replay[0]).toEqual({ role: 'user', content: GOAL });
    expect(replay[1]?.content).toEqual([{ type: 'tool_use', id: 'toolu_ask', name: 'mcp_AskUser', input: question }]);
    const answered = (replay[2]?.content as { tool_use_id: string; content: string }[])[0];
    expect(answered?.tool_use_id).toBe('toolu_ask');
    expect(JSON.parse(String(answered?.content))).toEqual({ outcome: 'ok', result: { answer: false } });
  });

  test('credential material echoed by the model is redacted before the checkpoint', async () => {
    const h = await harness({ replies: [() => sse(textEvents('msg_echo', `leak ${access(1)} and ${refresh(1)}`))] });
    expect(await h.run({ kind: 'initial', goal: GOAL }).settled).toEqual({ kind: 'finished' });
    const persisted = persistedText(h.saver);
    expect(persisted).not.toContain(access(1));
    expect(persisted).not.toContain(refresh(1));
    expect(persisted).toContain(REDACTION);
  });
});

describe('offline G4: incomplete responses never become messages', () => {
  const cases: [string, () => Response][] = [
    [
      'a stream cut inside tool arguments',
      () => sse(toolEvents('m', 't', READ_TOOL, { mode: 'file', path: 'x' }, { cut: true })),
    ],
    [
      'a text stream without message_stop',
      () => sse(textEvents('m', 'partial answer').replace(event('message_stop'), '')),
    ],
    [
      'a stream carrying an error event',
      () =>
        sse(
          textEvents('m', 'partial').replace(
            event('message_stop'),
            event('error', { error: { type: 'overloaded_error', message: 'x' } }),
          ),
        ),
    ],
  ];
  for (const [name, reply] of cases) {
    test(`${name} fails the run and stores no assistant message`, async () => {
      const h = await harness({ replies: [reply] });
      const { evidence, classified } = failureOf(await h.run({ kind: 'initial', goal: GOAL }).settled);
      expect(h.net.sent).toHaveLength(1);
      expect(evidence).toMatchObject({ kind: 'terminal', attemptId: h.admitted[0] });
      expect(classified).toMatchObject({
        kind: 'failure',
        failure: { category: 'provider_failure', operation: { kind: 'model_attempt', attemptId: h.admitted[0] } },
      });
      expect((await h.messages()).map((message) => message.content)).toEqual([GOAL]);
    });
  }
});

describe('offline G4: failures keep their type and their attempt, and nothing is retried silently', () => {
  test('a server error is one request, even when the invocation config asks for retries', async () => {
    const h = await harness({ replies: [apiError(500, 'api_error')] });
    const config = { configurable: { thread_id: h.runId }, maxRetries: 4 } as Parameters<typeof h.agent.invoke>[1];
    await expect(h.agent.invoke({ messages: [{ role: 'user', content: GOAL }] }, config)).rejects.toThrow();
    expect(h.net.sent).toHaveLength(1);
    expect(h.admitted).toHaveLength(1);
  });

  test(
    'control: the stock model alone would retry on a call-level override',
    async () => {
      const net = network(Array.from({ length: 8 }, () => () => apiError(500, 'api_error')));
      const model = createAnthropicModel({ model: 'claude-opus-5', terminal: net.fetchImpl });
      await expect(model.invoke('hi', { maxRetries: 1 })).rejects.toThrow();
      // Nested retry layers multiply: one call-level retry already sends several physical requests.
      expect(net.sent.length).toBeGreaterThan(1);
    },
    { timeout: 20_000 },
  );

  const typed: [string, Response, Record<string, unknown>][] = [
    [
      'a rate limit with retry-after',
      apiError(429, 'rate_limit_error'),
      { category: 'rate_or_quota_limit', reason: 'rate_limited', retryAfterSeconds: 30 },
    ],
    [
      'an overloaded service',
      apiError(529, 'overloaded_error'),
      { category: 'provider_failure', reason: 'provider_unavailable' },
    ],
    [
      'a client-version rejection',
      apiError(
        400,
        'invalid_request_error',
        'Claude Code 2.1.280 does not support this model; version 2.1.300 or newer is required.',
        {
          details: { error_code: 'claude_code_version_too_old' },
        },
      ),
      { category: 'provider_failure', reason: 'model_unsupported' },
    ],
    [
      'a permission refusal',
      apiError(403, 'permission_error'),
      { category: 'authorization', reason: 'authorization_rejected' },
    ],
  ];
  for (const [name, reply, expected] of typed) {
    test(`${name} is classified with its attempt and sent once`, async () => {
      const h = await harness({ replies: [reply] });
      const { evidence, classified } = failureOf(await h.run({ kind: 'initial', goal: GOAL }).settled);
      expect(evidence).toMatchObject({ kind: 'provider', attemptId: h.admitted[0] });
      expect(classified).toMatchObject({
        kind: 'failure',
        failure: { ...expected, operation: { kind: 'model_attempt', attemptId: h.admitted[0] } },
      });
      expect(h.net.sent).toHaveLength(1);
    });
  }
});

describe('offline G4: authorization', () => {
  const granted = () =>
    new Response(JSON.stringify({ access_token: access(2), refresh_token: refresh(2), expires_in: 3600 }), {
      status: 200,
    });

  test('an authentication rejection renews once and retries as a counted request with the new generation', async () => {
    const h = await harness({
      replies: [apiError(401, 'authentication_error'), () => sse(textEvents('msg_ok', 'Renewed.'))],
      auth: [granted()],
    });
    expect(await h.run({ kind: 'initial', goal: GOAL }).settled).toEqual({ kind: 'finished' });
    expect(h.net.sent.map((sent) => sent.headers.authorization)).toEqual([
      `Bearer ${access(1)}`,
      `Bearer ${access(2)}`,
    ]);
    expect(h.admitted).toHaveLength(2);
    expect(h.auth.sent).toEqual([expect.objectContaining({ grant_type: 'refresh_token', refresh_token: refresh(1) })]);
    const persisted = persistedText(h.saver);
    for (const token of [access(1), access(2), refresh(1), refresh(2)]) expect(persisted).not.toContain(token);
  });

  test('a rejection after renewal is definitive, with no second retry', async () => {
    const h = await harness({
      replies: [apiError(401, 'authentication_error'), apiError(401, 'authentication_error')],
      auth: [granted()],
    });
    const { classified } = failureOf(await h.run({ kind: 'initial', goal: GOAL }).settled);
    expect(h.net.sent).toHaveLength(2);
    expect(h.auth.sent).toHaveLength(1);
    expect(classified).toMatchObject({
      failure: { reason: 'authorization_rejected', operation: { kind: 'model_attempt', attemptId: h.admitted[1] } },
    });
  });

  test('a renewal the issuer refuses is definitive; one that never left is temporary', async () => {
    const refused = await harness({
      replies: [apiError(401, 'authentication_error')],
      auth: [new Response('{"error":"invalid_grant"}', { status: 400 })],
    });
    const definitive = failureOf(await refused.run({ kind: 'initial', goal: GOAL }).settled);
    expect(definitive.evidence).toEqual({
      kind: 'terminal',
      code: 'credential_unavailable',
      reason: 'reauthorization_required',
    });
    expect(definitive.classified).toMatchObject({
      failure: { category: 'authorization', reason: 'authorization_rejected' },
    });

    const unreachable = await harness({
      replies: [apiError(401, 'authentication_error')],
      auth: [{ code: 'ConnectionRefused' }],
    });
    const temporary = failureOf(await unreachable.run({ kind: 'initial', goal: GOAL }).settled);
    expect(temporary.evidence).toEqual({
      kind: 'terminal',
      code: 'credential_unavailable',
      reason: 'temporarily_unavailable',
    });
    expect(temporary.classified).toMatchObject({
      failure: { category: 'provider_failure', reason: 'provider_unavailable' },
    });
    for (const h of [refused, unreachable]) expect(h.net.sent).toHaveLength(1);
  });

  test('without usable authorization, no inference request is admitted or sent', async () => {
    const h = await harness({
      replies: [],
      record: {
        version: 1,
        provider: 'anthropic',
        authMode: 'subscription',
        slot: 'default',
        generation: 3,
        updatedAtMs: NOW,
        lifecycle: 'reauthorization_required',
        reason: 'refresh_outcome_unknown',
      },
    });
    const { classified } = failureOf(await h.run({ kind: 'initial', goal: GOAL }).settled);
    expect(classified).toMatchObject({ failure: { category: 'authorization', reason: 'authorization_rejected' } });
    expect(h.net.sent).toEqual([]);
    expect(h.admitted).toEqual([]);
  });
});

describe('offline G4: cancellation', () => {
  test('cancelling during a stalled stream settles the run and dispatches nothing further', async () => {
    const h = await harness({ replies: [() => sse(start('msg_slow'), { stall: true })] });
    const running = h.run({ kind: 'initial', goal: GOAL });
    while (h.net.sent.length === 0) await Bun.sleep(1);
    running.cancel(new Error('cancelled'));
    // The controller, which accepted the cancellation, records the outcome; here the run only has to stop.
    expect((await running.settled).kind).toBe('failed');
    expect(h.net.sent).toHaveLength(1);
    expect(h.admitted).toHaveLength(1);
    expect((await h.messages()).map((message) => message.content)).toEqual([GOAL]);
  });
});
