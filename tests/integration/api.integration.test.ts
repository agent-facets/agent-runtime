// The `/api/v1` commands and reads (task 12.2) through the production run service on the official saver: real
// workspace admission, credential screening, provider assembly, controller and PostgreSQL records. The model
// network and token endpoint are fakes and are the independent witnesses of what was dispatched.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseOperatorConfig } from '../../packages/runtime/src/config/operator.ts';
import { CredentialStore } from '../../packages/runtime/src/credentials/store.ts';
import { openPersistence, type Persistence } from '../../packages/runtime/src/persistence/persistence.ts';
import { createProviderAssembly } from '../../packages/runtime/src/providers/assembly.ts';
import { RunStore } from '../../packages/runtime/src/records/run-store.ts';
import { handleApi } from '../../packages/runtime/src/service/http.ts';
import { RunService, type RunServiceOptions } from '../../packages/runtime/src/service/runs.ts';
import { REAL_TIME } from '../../packages/runtime/src/service/stream.ts';
import { createFixture } from '../../packages/runtime/test-support/workspace.ts';
import {
  inferenceNetwork,
  opening,
  sse,
  textTurn,
  tokenNetwork,
  toolTurn,
  YES_NO_QUESTION,
} from '../support/anthropic-network.ts';
import { createScratchDatabase, type ScratchDatabase } from '../support/scratch-database.ts';

let db: ScratchDatabase;
let persistence: Persistence;
const fixture = createFixture();
fixture.write('notes/plan.md', 'alpha\nbeta\n');
const scratch = mkdtempSync(join(tmpdir(), 'agent-runtime-api-'));
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

// Response bodies are inspected as plain JSON; the server validates them against the contract schemas before sending.
// biome-ignore lint/suspicious/noExplicitAny: JSON response bodies under test
type Body = any;

const NOW = Date.now();
const ACCESS = 'sk-ant-oat01-api-suite-access-token-0001';
const REFRESH = 'sk-ant-ort01-api-suite-refresh-token-0001';
const GOAL = 'Summarize notes/plan.md.';
let counter = 0;

interface Harness {
  service: RunService;
  net: ReturnType<typeof inferenceNetwork>;
  stateDir: string;
  failStops: number;
  call(
    method: string,
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
  ): Promise<{ status: number; body: Body }>;
  start(goal?: string, requestId?: string): Promise<{ status: number; body: Body }>;
  settled(): Promise<void>;
}

async function harness(
  options: {
    replies?: (() => Response)[];
    stepBudget?: number;
    credential?: boolean;
    store?: (base: RunStore) => RunStore;
    admit?: RunServiceOptions['admit'];
  } = {},
): Promise<Harness> {
  const base = join(scratch, `case-${++counter}`);
  const stateDir = join(base, 'state');
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const configFile = join(base, 'config.json');
  const source = JSON.stringify({
    version: 1,
    workspace: { id: 'main', label: 'Main workspace', root: fixture.root },
    providers: { anthropic: { authMode: 'subscription', model: 'claude-opus-5', profileId: 'claude-cli-2.1.280' } },
    defaultProvider: 'anthropic',
    stepBudget: options.stepBudget ?? 10,
  });
  writeFileSync(configFile, source);
  const operator = parseOperatorConfig(source, { stateDir, configFile });
  if (options.credential !== false) {
    await CredentialStore.forStateDir(stateDir).replace({
      version: 1,
      provider: 'anthropic',
      authMode: 'subscription',
      slot: 'default',
      generation: 1,
      updatedAtMs: NOW,
      lifecycle: 'usable',
      accessToken: ACCESS,
      refreshToken: REFRESH,
      expiresAtMs: NOW + 3_600_000,
      account: {},
    });
  }
  const net = inferenceNetwork(options.replies ?? []);
  const assembly = createProviderAssembly({
    config: operator,
    stateDir,
    inferenceTransport: net.fetchImpl,
    authTransport: tokenNetwork().fetchImpl,
  });
  const store = new RunStore(persistence.app, persistence.ownership);
  const h: Harness = {
    net,
    stateDir,
    failStops: 0,
    service: undefined as unknown as RunService,
    async call(method, path, body, headers = {}) {
      const response = await handleApi(
        new Request(`http://127.0.0.1:3000${path}`, {
          method,
          headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
          ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
        }),
        () => h.service,
      );
      return { status: response.status, body: await response.json() };
    },
    start(goal = GOAL, requestId = crypto.randomUUID()) {
      return h.call('POST', '/api/v1/runs', { requestId, goal, provider: 'anthropic' });
    },
    settled: () => h.service.settled(),
  };
  h.service = new RunService({
    operator,
    locations: { stateDir, configFile },
    persistence,
    assembly,
    failStop: () => {
      h.failStops++;
    },
    store: options.store?.(store) ?? store,
    ...(options.admit === undefined ? {} : { admit: options.admit }),
  });
  return h;
}

/** Waits for a run to reach a state the background dispatch produces. */
async function waitFor(h: Harness, runId: string, kind: string) {
  await h.settled();
  const { body } = await h.call('GET', `/api/v1/runs/${runId}`);
  expect(body.run.state.kind).toBe(kind);
  return body;
}

const askReply = () => sse(toolTurn('msg_ask', 'toolu_ask', 'mcp_AskUser', YES_NO_QUESTION));
const doneReply =
  (text = 'Done.') =>
  () =>
    sse(textTurn(`msg_${crypto.randomUUID().slice(0, 8)}`, text));

async function waitingRun(h: Harness) {
  const started = await h.start();
  expect(started.status).toBe(202);
  const runId = started.body.run.runId as string;
  const detail = await waitFor(h, runId, 'waiting');
  return { runId, questionId: detail.run.pendingQuestion.questionId as string };
}

describe('starting runs', () => {
  test('a start is accepted once, runs in the background, and a retry returns the same run without dispatching', async () => {
    const h = await harness({ replies: [doneReply('The plan has two lines.')] });
    expect((await h.call('GET', '/api/v1/options')).body).toEqual({
      workspace: { label: 'Main workspace', available: true },
      providers: [{ provider: 'anthropic', authMode: 'subscription', model: 'claude-opus-5', readiness: 'ready' }],
      defaultProvider: 'anthropic',
      defaultBudget: 10,
    });
    const requestId = crypto.randomUUID();
    const first = await h.start(GOAL, requestId);
    expect(first.status).toBe(202);
    expect(first.body.run).toMatchObject({
      goal: GOAL,
      provider: 'anthropic',
      authMode: 'subscription',
      model: 'claude-opus-5',
      workspace: { label: 'Main workspace', root: fixture.root },
      budget: { maximum: 10, consumed: 0, unconfirmed: 0 },
    });
    const runId = first.body.run.runId as string;
    const done = await waitFor(h, runId, 'succeeded');
    expect(done.run.budget).toEqual({ maximum: 10, consumed: 1, unconfirmed: 0 });
    expect(h.net.sent).toHaveLength(1);

    const again = await h.start(GOAL, requestId);
    expect(again.status).toBe(200);
    expect(again.body.run.runId).toBe(runId);
    // Even when a prerequisite no longer holds, the retry is acknowledged: it changes nothing.
    rmSync(join(h.stateDir, 'credentials'), { recursive: true, force: true });
    expect((await h.start(GOAL, requestId)).status).toBe(200);
    const conflict = await h.start('Something else.', requestId);
    expect(conflict).toEqual({
      status: 409,
      body: {
        error: expect.objectContaining({ code: 'request_conflict', acceptance: 'not_accepted', retryable: false }),
      },
    });
    await h.settled();
    expect(h.net.sent).toHaveLength(1);

    // The public view keeps server-only identities to itself.
    const serialized = JSON.stringify([first.body, done, (await h.call('GET', `/api/v1/runs/${runId}/events`)).body]);
    for (const hidden of [
      'credentialSlot',
      'profileId',
      'ownerEpoch',
      'invocationId',
      'bindingDigest',
      'revision',
      ACCESS,
    ]) {
      expect(serialized).not.toContain(hidden);
    }
  });

  test('concurrent starts with one request ID create and dispatch one run', async () => {
    const h = await harness({ replies: [doneReply()] });
    const requestId = crypto.randomUUID();
    const results = await Promise.all(Array.from({ length: 5 }, () => h.start(GOAL, requestId)));
    expect(results.map((result) => result.status).sort()).toEqual([200, 200, 200, 200, 202]);
    expect(new Set(results.map((result) => result.body.run.runId)).size).toBe(1);
    await h.settled();
    expect(h.net.sent).toHaveLength(1);
  });

  test('requests that fail validation, screening or prerequisites create nothing', async () => {
    const h = await harness();
    const before = (await h.call('GET', '/api/v1/runs?limit=100')).body.runs.length;
    const cases: [Promise<{ status: number; body: Body }>, number, string][] = [
      [h.start('   '), 400, 'goal_required'],
      [h.start('x'.repeat(8193)), 400, 'goal_too_long'],
      [
        h.call('POST', '/api/v1/runs', {
          requestId: crypto.randomUUID(),
          goal: GOAL,
          provider: 'anthropic',
          model: 'x',
        }),
        400,
        'invalid_request',
      ],
      [h.call('POST', '/api/v1/runs', 'not json'), 400, 'invalid_request'],
      [
        h.call(
          'POST',
          '/api/v1/runs',
          JSON.stringify({ requestId: crypto.randomUUID(), goal: GOAL, provider: 'anthropic' }),
          {
            'content-type': 'text/plain',
          },
        ),
        400,
        'json_required',
      ],
      [h.call('POST', '/api/v1/runs', { goal: 'x'.repeat(70_000) }), 400, 'request_too_large'],
      [h.start(`Use ${ACCESS} to log in`), 400, 'credential_in_input'],
      [h.start('Here is a key sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'), 400, 'credential_in_input'],
      [
        h.call('POST', '/api/v1/runs', { requestId: crypto.randomUUID(), goal: GOAL, provider: 'openai' }),
        409,
        'provider_unavailable',
      ],
    ];
    for (const [pending, status, code] of cases) {
      const result = await pending;
      expect([result.status, result.body.error.code, result.body.error.acceptance]).toEqual([
        status,
        code,
        'not_accepted',
      ]);
    }
    expect(JSON.stringify(cases)).not.toContain(ACCESS);

    const unauthorized = await harness({ credential: false });
    const refused = await unauthorized.start();
    expect([refused.status, refused.body.error.code]).toEqual([409, 'provider_unavailable']);
    expect(refused.body.error.message).toContain('auth');

    const noWorkspace = await harness({ admit: async () => ({ ok: false, code: 'workspace_unavailable' }) });
    const unavailable = await noWorkspace.start();
    expect([unavailable.status, unavailable.body.error.code]).toEqual([409, 'workspace_unavailable']);

    expect((await h.call('GET', '/api/v1/runs?limit=100')).body.runs.length).toBe(before);
    for (const other of [h, unauthorized, noWorkspace]) expect(other.net.sent).toEqual([]);
  });

  test('an unknown commit outcome is resolved by readback: dispatched once if recorded, refused if not', async () => {
    class CommitsThenLosesTheAnswer extends RunStore {
      override async createRun(input: Parameters<RunStore['createRun']>[0]): Promise<never> {
        await super.createRun(input);
        throw new Error('connection reset after commit');
      }
    }
    const recorded = await harness({
      replies: [doneReply()],
      store: () => new CommitsThenLosesTheAnswer(persistence.app, persistence.ownership),
    });
    const accepted = await recorded.start();
    expect(accepted.status).toBe(202);
    await waitFor(recorded, accepted.body.run.runId, 'succeeded');
    expect(recorded.net.sent).toHaveLength(1);

    class LosesTheCommit extends RunStore {
      override async createRun(): Promise<never> {
        throw new Error('connection reset before commit');
      }
    }
    const lost = await harness({ store: () => new LosesTheCommit(persistence.app, persistence.ownership) });
    const requestId = crypto.randomUUID();
    const notRecorded = await lost.start(GOAL, requestId);
    expect([notRecorded.status, notRecorded.body.error.code, notRecorded.body.error.acceptance]).toEqual([
      503,
      'storage_unavailable',
      'not_accepted',
    ]);
    expect(await new RunStore(persistence.app, persistence.ownership).findCreation(requestId)).toBeUndefined();

    let reads = 0;
    class CannotReadBack extends LosesTheCommit {
      override async findCreation(requestId: string) {
        if (++reads > 1) throw new Error('database unreachable');
        return super.findCreation(requestId);
      }
    }
    const unknown = await harness({ store: () => new CannotReadBack(persistence.app, persistence.ownership) });
    const uncertain = await unknown.start();
    expect([
      uncertain.status,
      uncertain.body.error.code,
      uncertain.body.error.acceptance,
      uncertain.body.error.retryable,
    ]).toEqual([503, 'acceptance_unknown', 'unknown', true]);
    for (const other of [lost, unknown]) expect(other.net.sent).toEqual([]);
  });
});

describe('answering questions', () => {
  test('an answer is accepted once, by ID, and false is delivered; repeats are acknowledged without dispatch', async () => {
    const h = await harness({ replies: [askReply, doneReply('Stopping.')] });
    const { runId, questionId } = await waitingRun(h);
    const path = `/api/v1/runs/${runId}/questions/${questionId}/answer`;

    expect((await h.call('POST', path, { answer: 'false' })).body.error.code).toBe('answer_invalid');
    expect((await h.call('POST', path, { answer: false, extra: 1 })).body.error.code).toBe('invalid_request');

    const accepted = await h.call('POST', path, { answer: false });
    expect(accepted.status).toBe(202);
    expect(accepted.body.acceptance).toMatchObject({ questionId, answer: false });
    await waitFor(h, runId, 'succeeded');
    expect(h.net.sent).toHaveLength(2);
    const replayed = h.net.sent[1]?.body.messages[2]?.content as { content: string }[];
    expect(JSON.parse(String(replayed[0]?.content))).toEqual({ outcome: 'ok', result: { answer: false } });

    // After the run finished, the same answer is still acknowledged; a different one is a conflict.
    const repeated = await h.call('POST', path, { answer: false });
    expect(repeated.status).toBe(200);
    expect(repeated.body.acceptance.acceptedAt).toBe(accepted.body.acceptance.acceptedAt);
    const conflict = await h.call('POST', path, { answer: true });
    expect([conflict.status, conflict.body.error.code]).toEqual([409, 'answer_conflict']);
    await h.settled();
    expect(h.net.sent).toHaveLength(2);
  });

  test('two tabs answering differently: one answer wins, and the run continues once', async () => {
    const h = await harness({ replies: [askReply, doneReply()] });
    const { runId, questionId } = await waitingRun(h);
    const path = `/api/v1/runs/${runId}/questions/${questionId}/answer`;
    const results = await Promise.all([
      h.call('POST', path, { answer: true }),
      h.call('POST', path, { answer: false }),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([202, 409]);
    await waitFor(h, runId, 'succeeded');
    expect(h.net.sent).toHaveLength(2);
  });

  test('misdirected, closed and credential-bearing answers change nothing', async () => {
    const h = await harness({ replies: [askReply, askReply] });
    const first = await waitingRun(h);
    const second = await waitingRun(h);
    // The first run's question, addressed to the second run.
    const crossed = await h.call('POST', `/api/v1/runs/${second.runId}/questions/${first.questionId}/answer`, {
      answer: true,
    });
    expect([crossed.status, crossed.body.error.code]).toEqual([404, 'not_found']);
    expect(
      (await h.call('POST', `/api/v1/runs/${first.runId}/questions/not-a-digest/answer`, { answer: true })).status,
    ).toBe(404);

    const textQuestion = await harness({
      replies: [
        () =>
          sse(
            toolTurn('msg_t', 'toolu_t', 'mcp_AskUser', {
              prompt: 'Name?',
              input: { kind: 'text', minLength: 0, maxLength: 200 },
            }),
          ),
      ],
    });
    const waiting = await waitingRun(textQuestion);
    const leaked = await textQuestion.call(
      'POST',
      `/api/v1/runs/${waiting.runId}/questions/${waiting.questionId}/answer`,
      {
        answer: `token ${ACCESS}`,
      },
    );
    expect([leaked.status, leaked.body.error.code, leaked.body.error.acceptance]).toEqual([
      400,
      'credential_in_input',
      'not_accepted',
    ]);
    expect((await textQuestion.call('GET', `/api/v1/runs/${waiting.runId}`)).body.run.state.kind).toBe('waiting');

    const cancelled = await h.call('POST', `/api/v1/runs/${first.runId}/cancel`, { requestId: crypto.randomUUID() });
    expect(cancelled.status).toBe(202);
    const closed = await h.call('POST', `/api/v1/runs/${first.runId}/questions/${first.questionId}/answer`, {
      answer: true,
    });
    expect([closed.status, closed.body.error.code]).toEqual([409, 'not_answerable']);
    await h.settled();
    expect(h.net.sent).toHaveLength(2);
    expect(textQuestion.net.sent).toHaveLength(1);
  });

  test('an answer is recorded even with no model requests left; the next request is refused as the step limit', async () => {
    const h = await harness({ stepBudget: 1, replies: [askReply] });
    const { runId, questionId } = await waitingRun(h);
    const accepted = await h.call('POST', `/api/v1/runs/${runId}/questions/${questionId}/answer`, { answer: true });
    expect(accepted.status).toBe(202);
    const failed = await waitFor(h, runId, 'failed');
    expect(failed.run.state.failure).toMatchObject({ category: 'step_limit' });
    expect(failed.run.budget).toEqual({ maximum: 1, consumed: 1, unconfirmed: 0 });
    expect(h.net.sent).toHaveLength(1);
  });

  test('a workspace that cannot be admitted leaves the question pending: continuation cannot be verified now', async () => {
    let available = true;
    const h = await harness({
      replies: [askReply, doneReply()],
      admit: async (workspace, locations) => {
        if (!available) return { ok: false, code: 'workspace_unavailable' };
        const { admitWorkspace } = await import('../../packages/runtime/src/workspace/admission.ts');
        return admitWorkspace(workspace, locations);
      },
    });
    const { runId, questionId } = await waitingRun(h);
    available = false;
    const path = `/api/v1/runs/${runId}/questions/${questionId}/answer`;
    const refused = await h.call('POST', path, { answer: true });
    expect([refused.status, refused.body.error.code, refused.body.error.retryable]).toEqual([
      503,
      'cannot_verify',
      true,
    ]);
    expect((await h.call('GET', `/api/v1/runs/${runId}`)).body.run.state.kind).toBe('waiting');
    available = true;
    expect((await h.call('POST', path, { answer: true })).status).toBe(202);
    await waitFor(h, runId, 'succeeded');
  });

  test('an unknown answer commit is read back and dispatched exactly once', async () => {
    class CommitsThenLosesTheAnswer extends RunStore {
      override async acceptAnswer(input: Parameters<RunStore['acceptAnswer']>[0]): Promise<never> {
        await super.acceptAnswer(input);
        throw new Error('connection reset after commit');
      }
    }
    const h = await harness({
      replies: [askReply, doneReply()],
      store: () => new CommitsThenLosesTheAnswer(persistence.app, persistence.ownership),
    });
    const { runId, questionId } = await waitingRun(h);
    const accepted = await h.call('POST', `/api/v1/runs/${runId}/questions/${questionId}/answer`, { answer: false });
    expect(accepted.status).toBe(202);
    await waitFor(h, runId, 'succeeded');
    expect(h.net.sent).toHaveLength(2);
  });
});

describe('cancelling runs', () => {
  test('cancellation is acknowledged once, repeats are idempotent, and a finished run cannot change', async () => {
    const h = await harness({ replies: [askReply, doneReply()] });
    const { runId } = await waitingRun(h);
    const requestId = crypto.randomUUID();
    const accepted = await h.call('POST', `/api/v1/runs/${runId}/cancel`, { requestId });
    expect(accepted.status).toBe(202);
    expect(accepted.body.run.state.kind).toBe('cancelled');
    const repeated = await h.call('POST', `/api/v1/runs/${runId}/cancel`, { requestId });
    expect(repeated.status).toBe(200);
    expect(repeated.body.cancellation).toEqual(accepted.body.cancellation);
    const other = await h.call('POST', `/api/v1/runs/${runId}/cancel`, { requestId: crypto.randomUUID() });
    expect([other.status, other.body.error.code]).toEqual([409, 'cancellation_conflict']);

    const done = await h.start();
    await waitFor(h, done.body.run.runId, 'succeeded');
    const finished = await h.call('POST', `/api/v1/runs/${done.body.run.runId}/cancel`, {
      requestId: crypto.randomUUID(),
    });
    expect([finished.status, finished.body.error.code]).toEqual([409, 'run_finished']);
    expect((await h.call('POST', `/api/v1/runs/${crypto.randomUUID()}/cancel`, { requestId })).status).toBe(404);
    expect((await h.call('POST', `/api/v1/runs/${runId}/cancel`, { requestId: 'x' })).body.error.code).toBe(
      'invalid_request',
    );
  });

  test('cancelling active work stops it; nothing further is dispatched', async () => {
    const h = await harness({ replies: [() => sse(opening('msg_slow'), true)] });
    const started = await h.start();
    const runId = started.body.run.runId as string;
    while (h.net.sent.length === 0) await Bun.sleep(5);
    const accepted = await h.call('POST', `/api/v1/runs/${runId}/cancel`, { requestId: crypto.randomUUID() });
    expect(accepted.status).toBe(202);
    expect(['cancelling', 'cancelled']).toContain(accepted.body.run.state.kind);
    await waitFor(h, runId, 'cancelled');
    expect(h.net.sent).toHaveLength(1);
  });

  test('an unknown cancellation commit is read back before it is acknowledged', async () => {
    class CommitsThenLosesTheAnswer extends RunStore {
      override async acceptCancellation(runId: string, requestId: string): Promise<never> {
        await super.acceptCancellation(runId, requestId);
        throw new Error('connection reset after commit');
      }
    }
    const h = await harness({
      replies: [askReply],
      store: () => new CommitsThenLosesTheAnswer(persistence.app, persistence.ownership),
    });
    const { runId } = await waitingRun(h);
    const accepted = await h.call('POST', `/api/v1/runs/${runId}/cancel`, { requestId: crypto.randomUUID() });
    expect([accepted.status, accepted.body.run.state.kind]).toEqual([202, 'cancelled']);
  });
});

describe('reading runs and history', () => {
  test('history pages are bounded by a cursor and a fixed upper bound; invalid and future cursors are refused', async () => {
    const h = await harness({ replies: [doneReply()] });
    const started = await h.start();
    const runId = started.body.run.runId as string;
    const done = await waitFor(h, runId, 'succeeded');
    const through = done.throughSeq as string;

    const pages: Body[] = [];
    let after = '0';
    while (true) {
      const page = await h.call('GET', `/api/v1/runs/${runId}/events?after=${after}&through=${through}&limit=2`);
      expect(page.status).toBe(200);
      pages.push(...page.body.events);
      if (page.body.events.length === 0) break;
      after = page.body.nextAfter;
    }
    expect(pages.map((event) => event.seq)).toEqual(
      Array.from({ length: Number(through) }, (_, index) => String(index + 1)),
    );
    expect(pages[0]).toMatchObject({ runId, seq: '1', kind: 'run.created', payload: { provider: 'anthropic' } });
    expect(pages.at(-1)).toMatchObject({ kind: 'run.status', payload: { state: { kind: 'succeeded' } } });

    const ahead = await h.call('GET', `/api/v1/runs/${runId}/events?after=${BigInt(through) + 1n}`);
    expect([ahead.status, ahead.body.error.code]).toEqual([409, 'cursor_ahead']);
    for (const query of ['after=-1', 'after=01', 'after=x', 'after=99999999999999999999', 'limit=0', 'limit=1001']) {
      const refused = await h.call('GET', `/api/v1/runs/${runId}/events?${query}`);
      expect(refused.status).toBe(400);
    }
    expect((await h.call('GET', `/api/v1/runs/${crypto.randomUUID()}/events`)).status).toBe(404);
    expect((await h.call('GET', '/api/v1/runs/not-a-run')).status).toBe(404);
  });

  test('the event stream replays and tails one run through a question and its answer; a reconnect resumes after its last ID', async () => {
    const h = await harness({ replies: [askReply, doneReply('Stopping.')] });
    const started = await h.start();
    const runId = started.body.run.runId as string;
    const timing = { ...REAL_TIME, pollMs: 20 };
    const openStream = async (cursor: { after?: string; lastEventId?: string }) => {
      const response = await handleApi(
        new Request(`http://127.0.0.1:3000/api/v1/runs/${runId}/stream?after=${cursor.after ?? '0'}`, {
          headers: cursor.lastEventId === undefined ? {} : { 'last-event-id': cursor.lastEventId },
        }),
        () => h.service,
        undefined,
        timing,
      );
      expect(response.status).toBe(200);
      const reader = (response.body as ReadableStream<Uint8Array>).getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      return {
        /** Reads events until one satisfies `until`; returns everything read. */
        async until(until: (event: Body) => boolean): Promise<Body[]> {
          const events: Body[] = [];
          while (true) {
            const end = buffer.indexOf('\n\n');
            if (end < 0) {
              const { done, value } = await reader.read();
              if (done) throw new Error('stream ended');
              buffer += decoder.decode(value, { stream: true });
              continue;
            }
            const block = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            const data = block.split('\n').find((line) => line.startsWith('data: '));
            if (data === undefined) continue;
            const event = JSON.parse(data.slice(6));
            const id = block.split('\n').find((line) => line.startsWith('id: '));
            expect(id).toBe(`id: ${event.seq}`);
            events.push(event);
            if (until(event)) return events;
          }
        },
        close: () => reader.cancel(),
      };
    };

    // The initial snapshot's cursor, as the console uses it.
    const stream = await openStream({ after: started.body.throughSeq });
    // The waiting status and its question are one commit; the question event follows the status.
    const first = await stream.until((event) => event.kind === 'question.asked');
    expect(first.some((event) => event.kind === 'run.status' && event.payload.state.kind === 'waiting')).toBe(true);
    const asked = first.at(-1);
    expect(asked.payload).toMatchObject({ prompt: 'Proceed?' });
    const lastSeen = first.at(-1).seq as string;
    await stream.close();

    const answered = await h.call('POST', `/api/v1/runs/${runId}/questions/${asked.payload.questionId}/answer`, {
      answer: false,
    });
    expect(answered.status).toBe(202);
    // The browser reconnects with the last ID it saw; the URL still carries the original cursor.
    const resumed = await openStream({ after: started.body.throughSeq, lastEventId: lastSeen });
    const rest = await resumed.until(
      (event) => event.kind === 'run.status' && event.payload.state.kind === 'succeeded',
    );
    await resumed.close();
    expect(rest.find((event) => event.kind === 'question.answered')?.payload.answer).toBe(false);

    const seqs = [...first, ...rest].map((event) => BigInt(event.seq));
    expect(seqs).toEqual(seqs.map((_, index) => BigInt(started.body.throughSeq) + BigInt(index) + 1n));
    const history = await h.call('GET', `/api/v1/runs/${runId}/events?after=${started.body.throughSeq}`);
    expect([...first, ...rest]).toEqual(history.body.events);
    expect(JSON.stringify(history.body)).not.toContain(ACCESS);
    await h.settled();
  });

  test('the run list pages newest first without repeats', async () => {
    const h = await harness({ replies: [doneReply(), doneReply(), doneReply()] });
    const ids: string[] = [];
    for (let index = 0; index < 3; index++) ids.push((await h.start(`Goal ${index}.`)).body.run.runId);
    await h.settled();
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await h.call('GET', `/api/v1/runs?limit=2${cursor === undefined ? '' : `&cursor=${cursor}`}`);
      expect(page.status).toBe(200);
      seen.push(...page.body.runs.map((run: { runId: string }) => run.runId));
      cursor = page.body.next;
    } while (cursor !== undefined);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.slice(0, 3)).toEqual([...ids].reverse());
    expect((await h.call('GET', '/api/v1/runs?cursor=***')).body.error.code).toBe('invalid_cursor');
  });

  test('routing: unknown resources, wrong methods and an unavailable service', async () => {
    const h = await harness();
    expect((await h.call('GET', '/api/v1/nothing')).status).toBe(404);
    const wrong = await handleApi(
      new Request('http://127.0.0.1:3000/api/v1/options', { method: 'DELETE' }),
      () => h.service,
    );
    expect([wrong.status, wrong.headers.get('allow')]).toEqual([405, 'GET']);
    const unavailable = await handleApi(new Request('http://127.0.0.1:3000/api/v1/options'), () => ({
      unavailable: 'starting',
    }));
    expect(unavailable.status).toBe(503);
    expect(((await unavailable.json()) as Body).error).toMatchObject({ code: 'service_unavailable', retryable: true });
  });
});
