// The production provider assembly, end to end on the official saver: operator configuration → registry →
// stored binding → per-invocation wiring (terminal with durable admission, the internal subscription package's
// profile, the credential coordinator and store) → stock ChatAnthropic → run controller. The network below the
// terminal and the token endpoint are fakes and are the independent witnesses; no provider is contacted.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type OperatorConfig, parseOperatorConfig } from '../../packages/runtime/src/config/operator.ts';
import { CredentialStore } from '../../packages/runtime/src/credentials/store.ts';
import { runAdmission } from '../../packages/runtime/src/execution/admission.ts';
import { createExecutionAgent, executionAgentParams } from '../../packages/runtime/src/execution/agent.ts';
import { submitAnswer } from '../../packages/runtime/src/execution/answers.ts';
import { ActiveInvocations, cancelRun } from '../../packages/runtime/src/execution/cancellation.ts';
import { currentCodeManifest } from '../../packages/runtime/src/execution/code-manifest.ts';
import { verifyContinuation } from '../../packages/runtime/src/execution/continuation.ts';
import { type ControllerDeps, RunController } from '../../packages/runtime/src/execution/controller.ts';
import { executionDefinition } from '../../packages/runtime/src/execution/definition.ts';
import { InFlight, trackedSaver } from '../../packages/runtime/src/execution/in-flight.ts';
import { InvocationExecutor } from '../../packages/runtime/src/execution/invocation.ts';
import { runOperationLedger } from '../../packages/runtime/src/execution/operations.ts';
import { AdmissionRefused, type RequestAdmission } from '../../packages/runtime/src/execution/terminal.ts';
import { KeyedSerializer } from '../../packages/runtime/src/persistence/keyed-serializer.ts';
import { openPersistence, type Persistence } from '../../packages/runtime/src/persistence/persistence.ts';
import { createProviderAssembly } from '../../packages/runtime/src/providers/assembly.ts';
import { RunStore } from '../../packages/runtime/src/records/run-store.ts';
import type { ProviderBinding } from '../../packages/runtime/src/records/schemas.ts';
import { createFixture } from '../../packages/runtime/test-support/workspace.ts';
import { createScratchDatabase, type ScratchDatabase } from '../support/scratch-database.ts';

let db: ScratchDatabase;
let persistence: Persistence;
const fixture = createFixture();
fixture.write('notes/plan.md', 'alpha\nbeta\n');
const scratch = mkdtempSync(join(tmpdir(), 'agent-runtime-provider-assembly-'));
beforeAll(async () => {
  db = await createScratchDatabase();
  persistence = await openPersistence({ url: db.url, onFault: () => {} });
});
afterAll(async () => {
  await persistence.close();
  await db.drop();
  fixture.cleanup();
  rmSync(scratch, { recursive: true, force: true });
});

const NOW = Date.now();
const access = (generation: number) => `sk-ant-oat01-assembly-access-${generation}-token`;
const refresh = (generation: number) => `sk-ant-ort01-assembly-refresh-${generation}-token`;

// --- Fake Anthropic network ----------------------------------------------------------------------------------------

const event = (name: string, payload: Record<string, unknown> = {}) =>
  `event: ${name}\ndata: ${JSON.stringify({ type: name, ...payload })}\n\n`;
const opening = (id: string) =>
  event('message_start', {
    message: {
      id,
      type: 'message',
      role: 'assistant',
      model: 'claude-opus-5',
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 3, output_tokens: 1 },
    },
  });
const closing = (stop: string) =>
  event('message_delta', { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 2 } }) +
  event('message_stop');
const text = (id: string, value: string) =>
  opening(id) +
  event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }) +
  event('content_block_delta', { index: 0, delta: { type: 'text_delta', text: value } }) +
  event('content_block_stop', { index: 0 }) +
  closing('end_turn');
const toolUse = (id: string, toolId: string, name: string, input: unknown) =>
  opening(id) +
  event('content_block_start', { index: 0, content_block: { type: 'tool_use', id: toolId, name, input: {} } }) +
  event('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } }) +
  event('content_block_stop', { index: 0 }) +
  closing('tool_use');

const sse = (body: string, stall = false) =>
  new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(body));
        if (!stall) controller.close();
      },
    }),
    { headers: { 'content-type': 'text/event-stream', 'request-id': `req_${crypto.randomUUID().slice(0, 8)}` } },
  );
const unauthorized = () =>
  new Response(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'x' } }), {
    status: 401,
  });

function network(replies: (() => Response)[]) {
  const sent: {
    headers: Record<string, string>;
    body: { model: string; messages: { role: string; content: unknown }[] };
  }[] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    sent.push({ headers: Object.fromEntries(new Headers(init.headers)), body: JSON.parse(String(init.body)) });
    const reply = replies.shift();
    if (reply === undefined) throw new Error('unscripted inference request');
    return reply();
  }) as unknown as typeof fetch;
  return { sent, fetchImpl };
}

function tokenEndpoint(replies: Response[]) {
  const sent: Record<string, string>[] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    sent.push(JSON.parse(new TextDecoder().decode(init.body as ArrayBuffer)));
    const reply = replies.shift();
    if (reply === undefined) throw new Error('unscripted token request');
    return reply;
  }) as unknown as typeof fetch;
  return { sent, fetchImpl };
}

// --- The service composition, as the API block will compose it ---------------------------------------------------

let counter = 0;

function operatorConfig(stateDir: string, model = 'claude-opus-5', profileId = 'claude-cli-2.1.280'): OperatorConfig {
  return parseOperatorConfig(
    JSON.stringify({
      version: 1,
      workspace: { id: 'main', label: 'Main workspace', root: fixture.root },
      providers: { anthropic: { authMode: 'subscription', model, profileId } },
      defaultProvider: 'anthropic',
    }),
    { stateDir, configFile: join(stateDir, 'config.json') },
  );
}

async function service(options: { replies: (() => Response)[]; tokens?: Response[]; credential?: boolean }) {
  const stateDir = join(scratch, `state-${++counter}`);
  mkdirSync(stateDir, { mode: 0o700 });
  if (options.credential !== false) {
    await CredentialStore.forStateDir(stateDir).replace({
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
    });
  }
  const net = network(options.replies);
  const tokens = tokenEndpoint(options.tokens ?? []);
  const config = operatorConfig(stateDir);
  const assembly = createProviderAssembly({
    config,
    stateDir,
    inferenceTransport: net.fetchImpl,
    authTransport: tokens.fetchImpl,
  });
  const store = new RunStore(persistence.app, persistence.ownership);
  const gates = new KeyedSerializer();
  const active = new ActiveInvocations();
  const saver = persistence.checkpoints.saver;
  const workspace = fixture.policy();

  const agentOptions = (runId: string, invocationId: string, wired: ReturnType<typeof wire>, inflight: InFlight) => ({
    runId,
    model: wired.model,
    checkpointer: trackedSaver(saver, inflight),
    workspace,
    contentPolicy: assembly.contentPolicy,
    operations: runOperationLedger({ store, gates, runId, invocationId }),
    track: (work: Promise<unknown>) => inflight.track(work),
    modelCallSettled: wired.modelCallSettled,
    reports: wired.reports,
  });
  const wire = (
    binding: ProviderBinding,
    admission: RequestAdmission,
    signal: () => AbortSignal,
    inflight: InFlight,
  ) => {
    const wired = assembly.wire({ binding, admission, signal, track: (work) => inflight.track(work) });
    if ('unavailable' in wired) throw new Error(wired.unavailable);
    return wired;
  };
  const refuseAll: RequestAdmission = {
    admit: async () => {
      throw new AdmissionRefused('inspection_only');
    },
  };
  const inspection = (runId: string, binding: ProviderBinding) => {
    const options = agentOptions(
      runId,
      crypto.randomUUID(),
      wire(binding, refuseAll, () => new AbortController().signal, new InFlight()),
      new InFlight(),
    );
    return { agent: createExecutionAgent(options), params: executionAgentParams(options) };
  };

  const controllerWire: ControllerDeps['wire'] = (wiring) =>
    createExecutionAgent(
      agentOptions(
        wiring.runId,
        wiring.invocationId,
        wire(
          wiring.binding,
          runAdmission({
            store,
            gates,
            owner: persistence.ownership,
            runId: wiring.runId,
            invocationId: wiring.invocationId,
          }),
          wiring.signal,
          wiring.inflight,
        ),
        wiring.inflight,
      ),
    );
  const controller = new RunController({
    store,
    gates,
    executor: new InvocationExecutor(new KeyedSerializer()),
    active,
    saver,
    wire: controllerWire,
    failStop: () => persistence.ownership.shutdown(),
  });

  async function createRun(binding?: ProviderBinding, budgetMax = 10) {
    const resolved =
      binding ??
      (() => {
        const result = assembly.registry.resolve('anthropic');
        if (!result.ok) throw new Error(result.code);
        return result.binding;
      })();
    const { agent, params } = inspection(crypto.randomUUID(), resolved);
    const definition = await executionDefinition({
      code: await currentCodeManifest(resolved.provider),
      agent,
      params,
      binding: resolved,
      workspacePolicyDigest: workspace.digest,
    });
    const { snapshot } = await store.createRun({
      requestId: crypto.randomUUID(),
      goal: 'Summarize the plan.',
      provider: 'anthropic',
      workspace: { id: 'main', label: 'Main workspace', root: fixture.root, policyDigest: workspace.digest },
      binding: resolved as Parameters<RunStore['createRun']>[0]['binding'],
      definition,
      budgetMax,
    });
    if (snapshot.state.kind !== 'working') throw new Error('expected a working run');
    return { runId: snapshot.runId, invocationId: snapshot.state.invocationId };
  }

  const answer = (runId: string, questionId: string, value: unknown) =>
    submitAnswer(
      {
        store,
        gates,
        verify: (question) =>
          verifyContinuation(
            {
              reconstruct: (binding) =>
                assembly.registry.reconstruct(binding) as { ok: true; binding: ProviderBinding } | { ok: false },
              workspacePolicyDigest: () => workspace.digest,
              agentFor: inspection,
              saver,
              code: currentCodeManifest,
            },
            question,
          ),
      },
      { runId, questionId, submission: { answer: value } },
    );

  const budget = async (runId: string) => {
    const [row] = await db.admin`select consumed, unconfirmed from runtime.runs where run_id = ${runId}`;
    return { consumed: Number(row.consumed), unconfirmed: Number(row.unconfirmed) };
  };
  const credentialFile = () =>
    JSON.parse(readFileSync(CredentialStore.forStateDir(stateDir).pathFor('anthropic', 'default'), 'utf8'));
  return {
    assembly,
    controller,
    store,
    gates,
    active,
    net,
    tokens,
    createRun,
    answer,
    budget,
    credentialFile,
    stateDir,
    config,
  };
}

async function storedText(threadId: string): Promise<string> {
  const rows = await db.admin`
    select coalesce(string_agg(convert_from(blob, 'UTF8'), ''), '') as text from checkpoints.checkpoint_blobs
      where thread_id = ${threadId} and blob is not null
    union all
    select coalesce(string_agg(checkpoint::text || metadata::text, ''), '') from checkpoints.checkpoints where thread_id = ${threadId}
    union all
    select coalesce(string_agg(convert_from(blob, 'UTF8'), ''), '') from checkpoints.checkpoint_writes where thread_id = ${threadId}`;
  return rows.map((row: { text: string }) => row.text).join('\n');
}

describe('production provider assembly on the official saver', () => {
  test('a configured, authorized Anthropic binding completes a tool round, counted and secret-free', async () => {
    const s = await service({
      replies: [
        () => sse(toolUse('msg_a1', 'toolu_a1', 'mcp_Read', { mode: 'file', path: 'notes/plan.md' })),
        () => sse(text('msg_a2', 'The plan has two lines.')),
      ],
    });
    expect(await s.assembly.registry.readiness('anthropic')).toBe('ready');
    expect(await s.assembly.registry.readiness('openai')).toBe('unconfigured');
    const { runId, invocationId } = await s.createRun();
    const state = await s.controller.run(runId, invocationId, { kind: 'initial', goal: 'Summarize the plan.' });
    expect(state.kind).toBe('succeeded');
    expect(s.net.sent).toHaveLength(2);
    expect(await s.budget(runId)).toEqual({ consumed: 2, unconfirmed: 0 });
    for (const sent of s.net.sent) {
      expect(sent.headers.authorization).toBe(`Bearer ${access(1)}`);
      expect(sent.headers['user-agent']).toBe('claude-cli/2.1.280 (external, cli)');
      expect(sent.body.model).toBe('claude-opus-5');
      expect(sent.body.messages[0]).toEqual({ role: 'user', content: 'Summarize the plan.' });
    }
    const stored = await storedText(runId);
    expect(stored).toContain('toolu_a1');
    expect(stored).not.toContain(access(1));
    expect(stored).not.toContain(refresh(1));
  });

  test('a question pauses the run; the answer is verified against the stored binding and replayed', async () => {
    const question = {
      prompt: 'Proceed?',
      input: {
        kind: 'choice',
        multiple: false,
        options: [
          { label: 'Yes', value: true },
          { label: 'No', value: false },
        ],
      },
    };
    const s = await service({
      replies: [
        () => sse(toolUse('msg_q1', 'toolu_q1', 'mcp_AskUser', question)),
        () => sse(text('msg_q2', 'Stopping.')),
      ],
    });
    const { runId, invocationId } = await s.createRun();
    const waiting = await s.controller.run(runId, invocationId, { kind: 'initial', goal: 'Summarize the plan.' });
    if (waiting.kind !== 'waiting') throw new Error(`expected waiting, got ${waiting.kind}`);
    const answered = await s.answer(runId, waiting.questionId, false);
    if (answered.kind !== 'accepted') throw new Error(answered.kind);
    const done = await s.controller.run(runId, answered.acceptance.invocationId, {
      kind: 'resume',
      ...answered.resume,
    });
    expect(done.kind).toBe('succeeded');
    expect(s.net.sent).toHaveLength(2);
    const replay = s.net.sent[1]?.body.messages ?? [];
    expect(replay[0]).toEqual({ role: 'user', content: 'Summarize the plan.' });
    const result = (replay[2]?.content as { tool_use_id: string; content: string }[])[0];
    expect(result?.tool_use_id).toBe('toolu_q1');
    expect(JSON.parse(String(result?.content))).toEqual({ outcome: 'ok', result: { answer: false } });
    expect(await s.budget(runId)).toEqual({ consumed: 2, unconfirmed: 0 });
  });

  test('a stored binding is rebuilt as stored: a changed default model does not change a paused run', async () => {
    const question = {
      prompt: 'Go?',
      input: { kind: 'choice', multiple: false, options: [{ label: 'Yes', value: true }] },
    };
    const s = await service({
      replies: [() => sse(toolUse('msg_b1', 'toolu_b1', 'mcp_AskUser', question)), () => sse(text('msg_b2', 'Done.'))],
    });
    const { runId, invocationId } = await s.createRun();
    const waiting = await s.controller.run(runId, invocationId, { kind: 'initial', goal: 'Summarize the plan.' });
    if (waiting.kind !== 'waiting') throw new Error(waiting.kind);
    // The owner switches new runs to another model; the paused run keeps its own.
    const changed = createProviderAssembly({
      config: operatorConfig(s.stateDir, 'claude-other-model'),
      stateDir: s.stateDir,
    });
    const stored = (await s.store.snapshot(runId)).binding;
    expect(changed.registry.reconstruct(stored)).toEqual({ ok: true, binding: stored });
    expect(changed.registry.resolve('anthropic')).toMatchObject({ ok: true, binding: { model: 'claude-other-model' } });
    const answered = await s.answer(runId, waiting.questionId, true);
    if (answered.kind !== 'accepted') throw new Error(answered.kind);
    await s.controller.run(runId, answered.acceptance.invocationId, { kind: 'resume', ...answered.resume });
    expect(s.net.sent.map((sent) => sent.body.model)).toEqual(['claude-opus-5', 'claude-opus-5']);
    expect(
      s.assembly.wire({
        binding: { ...stored, profileId: 'claude-cli-9.9.9' },
        admission: {
          admit: async () => {
            throw new Error('unused');
          },
        },
        signal: () => new AbortController().signal,
        track: () => {},
      }),
    ).toEqual({ unavailable: 'profile_unsupported' });
    expect(
      s.assembly.wire({
        binding: { ...stored, provider: 'openai' },
        admission: {
          admit: async () => {
            throw new Error('unused');
          },
        },
        signal: () => new AbortController().signal,
        track: () => {},
      }),
    ).toEqual({ unavailable: 'integration_unavailable' });
  });

  test('an authentication rejection renews once; the retry is admitted and counted with the new generation', async () => {
    const s = await service({
      replies: [unauthorized, () => sse(text('msg_r', 'Renewed.'))],
      tokens: [
        new Response(JSON.stringify({ access_token: access(2), refresh_token: refresh(2), expires_in: 3600 }), {
          status: 200,
        }),
      ],
    });
    const { runId, invocationId } = await s.createRun();
    expect((await s.controller.run(runId, invocationId, { kind: 'initial', goal: 'Summarize the plan.' })).kind).toBe(
      'succeeded',
    );
    expect(s.net.sent.map((sent) => sent.headers.authorization)).toEqual([
      `Bearer ${access(1)}`,
      `Bearer ${access(2)}`,
    ]);
    expect(s.tokens.sent).toHaveLength(1);
    expect(await s.budget(runId)).toEqual({ consumed: 2, unconfirmed: 0 });
    expect(s.credentialFile()).toMatchObject({ generation: 2, lifecycle: 'usable' });
    expect(await storedText(runId)).not.toContain(access(2));
  });

  test('a rejection right after renewal is definitive: the run fails, and later runs send nothing', async () => {
    const s = await service({
      replies: [unauthorized, unauthorized],
      tokens: [
        new Response(JSON.stringify({ access_token: access(2), refresh_token: refresh(2), expires_in: 3600 }), {
          status: 200,
        }),
      ],
    });
    const first = await s.createRun();
    const failed = await s.controller.run(first.runId, first.invocationId, {
      kind: 'initial',
      goal: 'Summarize the plan.',
    });
    expect(failed).toMatchObject({
      kind: 'failed',
      failure: { category: 'authorization', reason: 'authorization_rejected' },
    });
    expect(s.net.sent).toHaveLength(2);
    expect(s.credentialFile()).toMatchObject({
      lifecycle: 'reauthorization_required',
      reason: 'authorization_rejected',
    });
    expect(await s.assembly.registry.readiness('anthropic')).toBe('reauthorization_required');

    const second = await s.createRun();
    const refused = await s.controller.run(second.runId, second.invocationId, {
      kind: 'initial',
      goal: 'Summarize the plan.',
    });
    expect(refused).toMatchObject({ kind: 'failed', failure: { category: 'authorization' } });
    expect(s.net.sent).toHaveLength(2);
    expect(await s.budget(second.runId)).toEqual({ consumed: 0, unconfirmed: 0 });
  });

  test('without authorization nothing is admitted or sent, and the failure says how to restore access', async () => {
    const s = await service({ replies: [], credential: false });
    expect(await s.assembly.registry.readiness('anthropic')).toBe('reauthorization_required');
    const { runId, invocationId } = await s.createRun();
    const state = await s.controller.run(runId, invocationId, { kind: 'initial', goal: 'Summarize the plan.' });
    expect(state).toMatchObject({
      kind: 'failed',
      failure: { category: 'authorization', reason: 'authorization_missing' },
    });
    expect(s.net.sent).toEqual([]);
    expect(await s.budget(runId)).toEqual({ consumed: 0, unconfirmed: 0 });
  });

  test('cancellation during a streaming response stops the run with nothing further sent', async () => {
    const s = await service({ replies: [() => sse(opening('msg_c'), true)] });
    const { runId, invocationId } = await s.createRun();
    const running = s.controller.run(runId, invocationId, { kind: 'initial', goal: 'Summarize the plan.' });
    while (s.net.sent.length === 0) await Bun.sleep(5);
    const { settled } = await cancelRun(
      { store: s.store, gates: s.gates, active: s.active },
      runId,
      crypto.randomUUID(),
    );
    expect((await settled).kind).toBe('cancelled');
    await running.catch(() => {});
    expect(s.net.sent).toHaveLength(1);
    expect((await s.store.snapshot(runId)).state.kind).toBe('cancelled');
  });
});
