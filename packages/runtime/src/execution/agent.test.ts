import { afterAll, describe, expect, test } from 'bun:test';
import { AIMessage, ToolMessage } from '@langchain/core/messages';
import { Command, MemorySaver } from '@langchain/langgraph';
import { MemoryLedger } from '../../test-support/memory-ledger.ts';
import {
  FetchingModel,
  persistedText,
  ScriptedModel,
  type ScriptStep,
  untilAborted,
} from '../../test-support/scripted-model.ts';
import { createFixture } from '../../test-support/workspace.ts';
import { exactSecretMatcher } from '../credentials/matcher.ts';
import { CredentialScreen, SCREEN_CAPACITY, ScreenCapacityError, ScreenScope } from '../credentials/screening.ts';
import { KeyedSerializer } from '../persistence/keyed-serializer.ts';
import { operationIdFor } from '../records/schemas.ts';
import { createContentPolicy, REDACTION } from '../security/content-policy.ts';
import { boundaryMiddleware, createExecutionAgent, executionAgentParams } from './agent.ts';
import { executionFailureOf } from './failures.ts';
import { graphInput, InvocationExecutor, type InvocationSettlement, invocationConfig } from './invocation.ts';
import { identityFor, jsonbTextBytes, RECORDED_OUTCOME_MAX_BYTES, recordableOutcome } from './operations.ts';
import { createTerminal } from './terminal.ts';
import { ASK_TOOL, READ_TOOL, SEARCH_TOOL } from './tools.ts';

const LIVE = 'oauth-live-synthetic-0123456789abcdefABCDEF';
const policy = createContentPolicy(exactSecretMatcher([LIVE]));
const fixture = createFixture();
afterAll(() => fixture.cleanup());
fixture.write('notes/plan.md', `step one\ntoken ${LIVE}\nstep three\n`);
const workspace = fixture.policy();

let runCounter = 0;
function setup(model: ScriptedModel, operations = new MemoryLedger()) {
  const saver = new MemorySaver();
  const runId = `00000000-0000-4000-8000-${String(++runCounter).padStart(12, '0')}`;
  const agent = createExecutionAgent({
    runId,
    model,
    checkpointer: saver,
    workspace,
    contentPolicy: () => policy,
    operations,
  });
  const executor = new InvocationExecutor(new KeyedSerializer());
  const start = (input: Parameters<typeof graphInput>[0]) => executor.start({ runId, agent, input, budgetMax: 10 });
  const messages = async () =>
    (await agent.graph.getState({ configurable: { thread_id: runId } })).values.messages as unknown[];
  return { saver, agent, executor, runId, start, messages, operations };
}

const call = (id: string, name: string, args: Record<string, unknown>) => ({
  id,
  name,
  args,
  type: 'tool_call' as const,
});
const failureCode = (settlement: InvocationSettlement) =>
  settlement.kind === 'failed' ? executionFailureOf(settlement.error)?.code : settlement.kind;

describe('invocation contract', () => {
  test('the stock agent gets the v2 tools, the saver and explicit, generation-free JSON schemas', () => {
    const saver = new MemorySaver();
    const model = new ScriptedModel([]);
    const params = executionAgentParams({
      runId: 'run-1',
      model,
      checkpointer: saver,
      workspace,
      contentPolicy: () => policy,
      operations: new MemoryLedger(),
    });
    expect(params.version).toBe('v2');
    expect(params.model).toBe(model);
    expect(params.checkpointer).toBe(saver);
    expect(params.tools.map((tool) => tool.name)).toEqual([READ_TOOL, SEARCH_TOOL, ASK_TOOL]);
    for (const tool of params.tools) {
      // Plain JSON Schema literals: they survive JSON unchanged and carry no generator metadata.
      expect(JSON.parse(JSON.stringify(tool.schema))).toEqual(tool.schema);
      expect(JSON.stringify(tool.schema)).not.toMatch(/\$schema|~standard|_def/);
    }
    expect(params.middleware).toHaveLength(1);
  });

  test('every invocation uses the run as thread, sync durability, a service signal and no checkpoint_id key', () => {
    const signal = new AbortController().signal;
    const config = invocationConfig('run-1', signal, 50);
    expect(config.configurable).toEqual({ thread_id: 'run-1' });
    expect('checkpoint_id' in config.configurable).toBe(false);
    expect(config.durability).toBe('sync');
    expect(config.signal).toBe(signal);
    expect(config.streamMode).toEqual(['updates', 'custom']);
    expect(config.recursionLimit).toBe(216);
  });

  test('the model boundary turns off framework retries for every call, whatever settings arrive', async () => {
    const middleware = boundaryMiddleware({
      runId: 'run-1',
      contentPolicy: () => policy,
      newMessageId: () => 'm-assigned',
      operations: new MemoryLedger(),
    });
    let seen: unknown;
    await middleware.wrapModelCall?.({ modelSettings: { maxRetries: 3, temperature: 0 } } as never, async (request) => {
      seen = request.modelSettings;
      return new AIMessage({ id: 'm1', content: 'ok' });
    });
    expect(seen).toEqual({ maxRetries: 0, temperature: 0 });
  });

  test('a resume is addressed to one interrupt and carries a truthy envelope even for a false answer', () => {
    const input = graphInput({ kind: 'resume', interruptId: 'abc', envelope: { questionId: 'q', answer: false } });
    expect(input).toBeInstanceOf(Command);
    expect((input as Command).resume).toEqual({ abc: { questionId: 'q', answer: false } });
  });
});

describe('the framework runs the loop', () => {
  test('a tool round trip: the model asks, the tool reads through the workspace policy, the model finishes', async () => {
    const model = new ScriptedModel([
      () =>
        new AIMessage({
          id: 'm1',
          content: '',
          tool_calls: [call('c1', READ_TOOL, { mode: 'file', path: 'notes/plan.md' })],
        }),
      () => new AIMessage({ id: 'm2', content: 'Done.' }),
    ]);
    const { start, messages } = setup(model);
    expect(await start({ kind: 'initial', goal: 'Read the plan.' }).settled).toEqual({ kind: 'finished' });
    expect(model.calls).toHaveLength(2);
    const result = model.calls[1]?.messages.at(-1);
    expect(ToolMessage.isInstance(result)).toBe(true);
    const outcome = JSON.parse(String((result as ToolMessage).content));
    expect(outcome.outcome).toBe('ok');
    expect(outcome.result.lines[1]).toEqual({ line: 2, text: `token ${REDACTION}` });
    expect((await messages()).length).toBe(4);
  });

  test('arguments that break a tool schema are a correctable refusal, not a run failure', async () => {
    const model = new ScriptedModel([
      () => new AIMessage({ id: 'm1', content: '', tool_calls: [call('c1', SEARCH_TOOL, { query: 5 })] }),
      () => new AIMessage({ id: 'm2', content: 'Understood.' }),
    ]);
    const { start } = setup(model);
    expect(await start({ kind: 'initial', goal: 'Search.' }).settled).toEqual({ kind: 'finished' });
    const result = model.calls[1]?.messages.at(-1) as ToolMessage;
    expect(JSON.parse(String(result.content))).toMatchObject({ outcome: 'refused', code: 'invalid_argument' });
  });
});

describe('before anything is checkpointed', () => {
  test('displayable model text is redacted while replay metadata survives exactly', async () => {
    const reasoning = { type: 'reasoning', reasoning: 'thinking', signature: 'sig-synthetic', id: 'rs_1' };
    const model = new ScriptedModel([
      () =>
        new AIMessage({
          id: 'm1',
          content: [{ type: 'text', text: `The token is ${LIVE}.` }, reasoning],
          additional_kwargs: { replay: { encrypted: 'synthetic-encrypted-state' } },
          response_metadata: { model_provider: 'test', id: 'resp_1' },
          usage_metadata: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
        }),
    ]);
    const { start, saver, messages } = setup(model);
    expect(await start({ kind: 'initial', goal: 'Report.' }).settled).toEqual({ kind: 'finished' });
    const stored = (await messages()).at(-1) as AIMessage;
    expect(stored.content).toEqual([{ type: 'text', text: `The token is ${REDACTION}.` }, reasoning]);
    expect(stored.additional_kwargs).toEqual({ replay: { encrypted: 'synthetic-encrypted-state' } });
    expect(stored.response_metadata).toMatchObject({ model_provider: 'test', id: 'resp_1' });
    expect(stored.usage_metadata).toEqual({ input_tokens: 1, output_tokens: 2, total_tokens: 3 });
    expect(stored.id).toBe('m1');
    expect(persistedText(saver)).not.toContain(LIVE);
  });

  test('a message without an ID gets one before it is stored', async () => {
    const model = new ScriptedModel([() => new AIMessage({ content: 'no id' })]);
    const { start, messages } = setup(model);
    await start({ kind: 'initial', goal: 'Hi.' }).settled;
    expect((await messages()).at(-1)).toMatchObject({ id: expect.stringMatching(/^msg_[0-9a-f-]{36}$/) });
  });

  test('a credential in tool-call arguments withholds the response; the tool never runs', async () => {
    const model = new ScriptedModel([
      () => new AIMessage({ id: 'm1', content: '', tool_calls: [call('c1', SEARCH_TOOL, { query: LIVE })] }),
    ]);
    const { start, saver, messages } = setup(model);
    const settled = await start({ kind: 'initial', goal: 'Search.' }).settled;
    expect(failureCode(settled)).toBe('unsafe_model_output');
    expect((await messages()).some((message) => ToolMessage.isInstance(message))).toBe(false);
    expect(model.calls).toHaveLength(1);
    const persisted = persistedText(saver);
    expect(persisted).not.toContain(LIVE);
    expect(persisted).toContain('ExecutionFailure');
  });

  test('a failing model call is recorded with fixed text; only its status is kept for classification', async () => {
    const model = new ScriptedModel([
      () => {
        throw Object.assign(new Error(`429 from provider, key ${LIVE}`), {
          status: 429,
          headers: { authorization: LIVE },
        });
      },
    ]);
    const { start, saver } = setup(model);
    const settled = await start({ kind: 'initial', goal: 'Go.' }).settled;
    const failure = settled.kind === 'failed' ? executionFailureOf(settled.error) : undefined;
    expect(failure?.code).toBe('model_request_failed');
    expect(failure?.evidence).toEqual({ kind: 'http', status: 429 });
    expect(persistedText(saver)).not.toContain(LIVE);
  });
});

describe('questions', () => {
  const ask = () =>
    new AIMessage({
      id: 'm-ask',
      content: '',
      tool_calls: [
        call('c-ask', ASK_TOOL, {
          prompt: 'Proceed?',
          input: {
            kind: 'choice',
            multiple: false,
            options: [
              { label: 'Yes', value: true },
              { label: 'No', value: false },
            ],
          },
        }),
      ],
    });

  test('one deterministic interrupt; a false answer is delivered through the ID-addressed resume', async () => {
    const model = new ScriptedModel([
      ask,
      (messages) => new AIMessage({ id: 'm-final', content: String(messages.at(-1)?.content) }),
    ]);
    const { start, runId } = setup(model);
    const paused = await start({ kind: 'initial', goal: 'Ask me.' }).settled;
    if (paused.kind !== 'interrupted') throw new Error(`expected an interrupt, got ${paused.kind}`);
    expect(paused.interrupts).toHaveLength(1);
    const [raised] = paused.interrupts;
    const questionId = operationIdFor(runId, 'm-ask', 'c-ask');
    expect(raised?.value).toEqual({
      protocolVersion: 1,
      questionId,
      prompt: 'Proceed?',
      input: {
        kind: 'choice',
        multiple: false,
        options: [
          { label: 'Yes', value: true },
          { label: 'No', value: false },
        ],
      },
    });
    const resumed = await start({
      kind: 'resume',
      interruptId: raised?.id as string,
      envelope: { questionId, answer: false },
    }).settled;
    expect(resumed).toEqual({ kind: 'finished' });
    expect(model.calls).toHaveLength(2);
    expect(JSON.parse(String(model.calls[1]?.messages.at(-1)?.content))).toEqual({
      outcome: 'ok',
      result: { answer: false },
    });
  });

  test('an envelope for another question, or with an answer outside the definition, is never delivered', async () => {
    for (const envelope of [
      { questionId: 'f'.repeat(64), answer: false },
      { questionId: 'SAME', answer: 'maybe' },
    ]) {
      const model = new ScriptedModel([ask, () => new AIMessage({ id: 'm-final', content: 'unexpected' })]);
      const { start, runId } = setup(model);
      const paused = await start({ kind: 'initial', goal: 'Ask me.' }).settled;
      if (paused.kind !== 'interrupted') throw new Error('expected an interrupt');
      const questionId = operationIdFor(runId, 'm-ask', 'c-ask');
      const settled = await start({
        kind: 'resume',
        interruptId: paused.interrupts[0]?.id as string,
        envelope: { ...envelope, questionId: envelope.questionId === 'SAME' ? questionId : envelope.questionId },
      }).settled;
      expect(failureCode(settled)).toBe('invariant_violation');
      expect(model.calls).toHaveLength(1);
    }
  });
});

describe('service-owned lifetime', () => {
  test('cancellation reaches the in-flight model call through the service signal', async () => {
    const model = new ScriptedModel([(_, signal) => untilAborted(signal)]);
    const { start } = setup(model);
    const running = start({ kind: 'initial', goal: 'Wait.' });
    for (let index = 0; index < 50 && model.calls.length === 0; index++) await Bun.sleep(10);
    expect(model.calls[0]?.signal?.aborted).toBe(false);
    running.cancel(new Error('cancelled by the owner'));
    expect((await running.settled).kind).toBe('failed');
    expect(model.calls[0]?.signal?.aborted).toBe(true);
  });

  test('an invocation continues when its caller walks away, and a run runs one invocation at a time', async () => {
    const order: string[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const model = new ScriptedModel([
      async () => {
        order.push('first:start');
        await gate;
        order.push('first:end');
        return new AIMessage({ id: 'a', content: 'first' });
      },
      async () => {
        order.push('second:start');
        return new AIMessage({ id: 'b', content: 'second' });
      },
    ]);
    const { start } = setup(model);
    void start({ kind: 'initial', goal: 'One.' });
    const second = start({ kind: 'initial', goal: 'Two.' });
    await Bun.sleep(30);
    expect(order).toEqual(['first:start']);
    release();
    expect(await second.settled).toEqual({ kind: 'finished' });
    expect(order).toEqual(['first:start', 'first:end', 'second:start']);
  });
});

describe('tool identity, batches and replay', () => {
  const read = (id: string, path = 'notes/plan.md') => call(id, READ_TOOL, { mode: 'file', path });
  const question = (id: string) =>
    call(id, ASK_TOOL, { prompt: 'Proceed?', input: { kind: 'text', minLength: 0, maxLength: 10 } });
  const respond = (id: string, calls: ReturnType<typeof call>[]) => () =>
    new AIMessage({ id, content: '', tool_calls: calls });
  const done = () => new AIMessage({ id: 'm-final', content: 'Done.' });
  const results = (model: ScriptedModel, index: number) =>
    (model.calls[index]?.messages ?? [])
      .filter((message) => ToolMessage.isInstance(message))
      .map((message) => JSON.parse(String(message.content)));

  test('read-only batches run; each call is recorded before and after it runs', async () => {
    const model = new ScriptedModel([respond('m1', [read('c1'), read('c2', 'notes')]), done]);
    const { start, operations } = setup(model);
    expect(await start({ kind: 'initial', goal: 'Read.' }).settled).toEqual({ kind: 'finished' });
    expect(results(model, 1).map((outcome) => outcome.outcome)).toEqual(['ok', 'error']);
    expect(operations.log.filter((entry) => entry.startsWith('start:'))).toEqual(['start:mcp_Read', 'start:mcp_Read']);
    expect(operations.log.filter((entry) => entry.startsWith('complete:')).sort()).toEqual([
      'complete:mcp_Read:error:not_a_file',
      'complete:mcp_Read:ok',
    ]);
  });

  test('a question mixed with other calls, or with another question, refuses every call and asks nothing', async () => {
    for (const calls of [
      [read('c1'), question('c2')],
      [question('c1'), question('c2')],
    ]) {
      const model = new ScriptedModel([respond('m1', calls), done]);
      const { start, operations } = setup(model);
      expect(await start({ kind: 'initial', goal: 'Mixed.' }).settled).toEqual({ kind: 'finished' });
      expect(results(model, 1).map((outcome) => outcome.code)).toEqual(['question_not_alone', 'question_not_alone']);
      expect(
        operations.log
          .filter((entry) => entry.startsWith('complete:'))
          .every((entry) => entry.endsWith(':question_not_alone')),
      ).toBe(true);
    }
  });

  test('calls to unavailable writing or command tools are refused and never performed', async () => {
    const target = `${fixture.root}/pwned.txt`;
    const before = await Bun.file(`${fixture.root}/notes/plan.md`).text();
    const model = new ScriptedModel([
      respond('m1', [
        call('c1', 'write_file', { path: 'notes/plan.md', content: 'overwritten' }),
        call('c2', 'run_command', { command: `touch ${target}` }),
      ]),
      done,
    ]);
    const { start, operations } = setup(model);
    expect(await start({ kind: 'initial', goal: 'Change things.' }).settled).toEqual({ kind: 'finished' });
    expect(results(model, 1).map((outcome) => outcome.code)).toEqual(['tool_unavailable', 'tool_unavailable']);
    expect(operations.log.filter((entry) => entry.startsWith('complete:')).sort()).toEqual([
      'complete:run_command:refused:tool_unavailable',
      'complete:write_file:refused:tool_unavailable',
    ]);
    expect(await Bun.file(`${fixture.root}/notes/plan.md`).text()).toBe(before);
    expect(await Bun.file(target).exists()).toBe(false);
  });

  test('if a refusal cannot be recorded, the run fails as a tool failure and still nothing is performed', async () => {
    const target = `${fixture.root}/pwned-fatal.txt`;
    const operations = new MemoryLedger();
    operations.complete = async () => {
      throw new Error('database unavailable');
    };
    const model = new ScriptedModel([respond('m1', [call('c1', 'run_command', { command: `touch ${target}` })]), done]);
    const { start } = setup(model, operations);
    expect(failureCode(await start({ kind: 'initial', goal: 'Run it.' }).settled)).toBe('tool_handling_failed');
    expect(model.calls).toHaveLength(1);
    expect(await Bun.file(target).exists()).toBe(false);
  });

  test('a call without an ID, or with an ID repeated in its response, fails before anything runs', async () => {
    for (const calls of [
      [{ name: READ_TOOL, args: { mode: 'file', path: 'notes/plan.md' }, type: 'tool_call' as const }],
      [read('dup'), read('dup', 'notes')],
    ]) {
      const model = new ScriptedModel([
        () => new AIMessage({ id: 'm1', content: '', tool_calls: calls as never }),
        done,
      ]);
      const { start, operations } = setup(model);
      expect(failureCode(await start({ kind: 'initial', goal: 'Read.' }).settled)).toBe('tool_call_unrepresentable');
      expect(operations.log).toEqual([]);
      expect(model.calls).toHaveLength(1);
    }
  });

  test('a provider call ID reused by a later response is an invalid call, not a cached result', async () => {
    // Both responses are in state, so the call's issuer is ambiguous and it fails before reaching the ledger.
    const model = new ScriptedModel([respond('m1', [read('c1')]), respond('m2', [read('c1', 'notes')]), done]);
    const { start, operations } = setup(model);
    expect(failureCode(await start({ kind: 'initial', goal: 'Read twice.' }).settled)).toBe(
      'tool_call_unrepresentable',
    );
    expect(operations.log).toEqual(['start:mcp_Read', 'complete:mcp_Read:ok']);
  });

  test('the ledger refuses a conflicting reuse it sees, whatever the graph state holds', async () => {
    const operations = new MemoryLedger();
    const model = new ScriptedModel([respond('m1', [read('c1')]), done]);
    const { start, runId } = setup(model, operations);
    const earlier = identityFor(runId, 'm0', read('c1', 'notes'));
    if (earlier === undefined) throw new Error('identity');
    operations.rows.set('c1', { identity: earlier });
    expect(failureCode(await start({ kind: 'initial', goal: 'Read.' }).settled)).toBe('tool_call_unrepresentable');
    expect(operations.log).toEqual(['conflict:c1']);
  });

  test('the same arguments under a new call ID are new work', async () => {
    const model = new ScriptedModel([respond('m1', [read('c1')]), respond('m2', [read('c2')]), done]);
    const { start, operations } = setup(model);
    expect(await start({ kind: 'initial', goal: 'Read twice.' }).settled).toEqual({ kind: 'finished' });
    expect(operations.log.filter((entry) => entry.startsWith('start:'))).toEqual(['start:mcp_Read', 'start:mcp_Read']);
  });

  test('a completed call is answered from its record without running again', async () => {
    const operations = new MemoryLedger();
    const model = new ScriptedModel([respond('m1', [read('c1', 'does/not/exist.md')]), done]);
    const { start, runId } = setup(model, operations);
    const recorded = { outcome: 'ok' as const, result: { recorded: true } };
    const identity = identityFor(runId, 'm1', read('c1', 'does/not/exist.md'));
    if (identity === undefined) throw new Error('identity');
    operations.rows.set('c1', { identity, outcome: recorded });
    expect(await start({ kind: 'initial', goal: 'Read.' }).settled).toEqual({ kind: 'finished' });
    // Run again, the missing file would have been an error; the recorded result was returned instead.
    expect(results(model, 1)).toEqual([recorded]);
    expect(operations.log).toEqual(['reuse:mcp_Read']);
  });

  test('when the run no longer permits work, nothing is dispatched', async () => {
    const operations = new MemoryLedger();
    operations.dispatchable = false;
    const model = new ScriptedModel([respond('m1', [read('c1')]), done]);
    const { start } = setup(model, operations);
    expect(failureCode(await start({ kind: 'initial', goal: 'Read.' }).settled)).toBe('dispatch_refused');
    expect(operations.log).toEqual(['refused:mcp_Read']);
    expect(model.calls).toHaveLength(1);
  });

  test('an outcome too large for its stored form is replaced before the agent sees it', () => {
    // Within the 64-KiB compact bound, but over the stored-form bound once PostgreSQL adds its separator spaces.
    const entries = Array.from({ length: 2_500 }, (_, index) => ({ n: index, k: 'd', s: 1 }));
    const outcome = { outcome: 'ok' as const, result: { entries } };
    expect(new TextEncoder().encode(JSON.stringify(outcome)).byteLength).toBeLessThanOrEqual(65_536);
    expect(jsonbTextBytes(outcome)).toBeGreaterThan(RECORDED_OUTCOME_MAX_BYTES);
    expect(recordableOutcome(outcome)).toMatchObject({ outcome: 'refused', code: 'result_too_large' });
    const small = { outcome: 'ok' as const, result: { entries: entries.slice(0, 10) } };
    expect(recordableOutcome(small)).toBe(small);
  });
});

describe('screening follows credential rotation', () => {
  const credentialFor = (generation: number) => ({
    provider: 'anthropic' as const,
    slot: 'default',
    generation,
    accessToken: `rotating-access-${generation}-0123456789`,
    refreshToken: `rotating-refresh-${generation}-0123456789`,
  });
  type Credential = ReturnType<typeof credentialFor>;

  /** A terminal whose credential resolution runs `resolve` (which pins, or not) before admission and dispatch. */
  function terminalWith(resolve: () => Credential, log: string[] = []) {
    return createTerminal({
      policy: { origin: 'https://api.provider.test', routes: [{ method: 'POST', path: '/v1/messages' }] },
      signal: new AbortController().signal,
      credentials: async () => {
        const credential = resolve();
        log.push(`resolved:${credential.generation}`);
        return { headers: { authorization: `Bearer ${credential.accessToken}` }, generation: credential.generation };
      },
      admission: {
        admit: async (_, begin) => {
          begin();
          return {
            attemptId: '00000000-0000-4000-8000-000000000001',
            dispatched: async () => {},
            completed: async () => {},
            abandoned: async () => {},
            unconfirmed: async () => {},
          };
        },
      },
      transport: (async () => {
        log.push('sent');
        return new Response('{}');
      }) as unknown as typeof fetch,
    });
  }

  function run(model: ScriptedModel, screen: CredentialScreen, scope?: ScreenScope) {
    const saver = new MemorySaver();
    const runId = `00000000-0000-4000-8000-${String(++runCounter).padStart(12, '0')}`;
    const agent = createExecutionAgent({
      runId,
      model,
      checkpointer: saver,
      workspace,
      contentPolicy: () => createContentPolicy(screen.matcher()),
      operations: new MemoryLedger(),
      ...(scope === undefined ? {} : { modelCallSettled: () => scope.release() }),
    });
    const running = new InvocationExecutor(new KeyedSerializer()).start({
      runId,
      agent,
      input: { kind: 'initial', goal: 'Go.' },
      budgetMax: 5,
    });
    return { saver, running };
  }

  test('a response echoing a just-rotated or an earlier credential is redacted before it is stored', async () => {
    const screen = new CredentialScreen();
    const scope = new ScreenScope(screen);
    const tokens: string[] = [];
    let generation = 0;
    const log: string[] = [];
    const terminal = terminalWith(() => {
      // Each request rotates to a new generation, pinned before the request is admitted or sent.
      const credential = credentialFor(++generation);
      tokens.push(credential.accessToken, credential.refreshToken);
      scope.pin(credential);
      return credential;
    }, log);
    const model = new FetchingModel(
      [
        () =>
          new AIMessage({
            id: 'm1',
            content: '',
            tool_calls: [call('c1', READ_TOOL, { mode: 'file', path: 'notes/plan.md' })],
          }),
        () => new AIMessage({ id: 'm2', content: `now ${tokens.join(' and ')}` }),
      ],
      terminal,
    );
    const { saver, running } = run(model, screen, scope);
    expect(await running.settled).toEqual({ kind: 'finished' });
    expect(log).toEqual(['resolved:1', 'sent', 'resolved:2', 'sent']);
    const persisted = persistedText(saver);
    for (const token of tokens) expect(persisted).not.toContain(token);
    expect(persisted).toContain(REDACTION);
  });

  /** One run's response arrives only after the HTTP exchange ended and many other generations were used. */
  async function delayedEchoUnderRotation(pin: (screen: CredentialScreen, scope: ScreenScope) => void) {
    const screen = new CredentialScreen();
    const scope = new ScreenScope(screen);
    const first = credentialFor(1);
    let respond: () => void = () => {};
    const responded = new Promise<void>((resolve) => {
      respond = resolve;
    });
    const model = new FetchingModel(
      [
        async () => {
          await responded;
          return new AIMessage({ id: 'm1', content: `echo ${first.accessToken} ${first.refreshToken}` });
        },
      ],
      terminalWith(() => {
        pin(screen, scope);
        return first;
      }),
    );
    const { saver, running } = run(model, screen, scope);
    while (model.calls.length === 0) await Bun.sleep(1);
    // Other requests rotate through four times the screen's capacity while this response is still pending.
    for (let generation = 2; generation <= SCREEN_CAPACITY * 4 + 1; generation++) {
      screen.lease(credentialFor(generation)).release();
    }
    respond();
    return { settled: await running.settled, persisted: persistedText(saver), screen, first };
  }

  test('a delayed response is still screened against its generation after many rotations', async () => {
    const { settled, persisted, screen, first } = await delayedEchoUnderRotation((_screen, scope) =>
      scope.pin(credentialFor(1)),
    );
    expect(settled).toEqual({ kind: 'finished' });
    expect(persisted).not.toContain(first.accessToken);
    expect(persisted).not.toContain(first.refreshToken);
    expect(persisted).toContain(REDACTION);
    // Once the response was sanitized the call released its lease, so the generation can now make room.
    for (let generation = 10_000; generation < 10_000 + SCREEN_CAPACITY; generation++) {
      screen.lease(credentialFor(generation)).release();
    }
    expect(createContentPolicy(screen.matcher()).detect(first.accessToken)).toBeUndefined();
  });

  test('control: coverage that ended with the HTTP exchange would let the same response through', async () => {
    const { settled, persisted, first } = await delayedEchoUnderRotation((screen) =>
      screen.lease(credentialFor(1)).release(),
    );
    expect(settled).toEqual({ kind: 'finished' });
    expect(persisted).toContain(first.accessToken);
  });

  function pinnedModel(step: ScriptStep) {
    const screen = new CredentialScreen(1);
    const scope = new ScreenScope(screen);
    const model = new FetchingModel(
      [step],
      terminalWith(() => {
        scope.pin(credentialFor(1));
        return credentialFor(1);
      }),
    );
    return { screen, scope, model };
  }

  test('a cancelled model call keeps its lease while pending and releases it when it settles', async () => {
    const { screen, scope, model } = pinnedModel((_, signal) => untilAborted(signal));
    const { running } = run(model, screen, scope);
    while (model.calls.length === 0) await Bun.sleep(1);
    expect(() => screen.lease(credentialFor(2))).toThrow(ScreenCapacityError);
    running.cancel(new Error('cancelled'));
    expect((await running.settled).kind).toBe('failed');
    expect(() => screen.lease(credentialFor(2)).release()).not.toThrow();
  });

  test('a failed model call releases its lease', async () => {
    const { screen, scope, model } = pinnedModel(() => Promise.reject(new Error('model failed')));
    const { running } = run(model, screen, scope);
    expect(failureCode(await running.settled)).toBe('model_request_failed');
    expect(() => screen.lease(credentialFor(2)).release()).not.toThrow();
  });

  test('a full screen refuses the credential, so nothing is sent', async () => {
    const screen = new CredentialScreen(1);
    screen.lease(credentialFor(99));
    const scope = new ScreenScope(screen);
    const log: string[] = [];
    const model = new FetchingModel(
      [() => new AIMessage({ id: 'm1', content: 'never' })],
      terminalWith(() => {
        scope.pin(credentialFor(1));
        return credentialFor(1);
      }, log),
    );
    const { running } = run(model, screen, scope);
    const settled = await running.settled;
    expect(failureCode(settled)).toBe('model_request_failed');
    expect(settled.kind === 'failed' && executionFailureOf(settled.error)?.evidence).toEqual({
      kind: 'terminal',
      code: 'credential_unavailable',
      reason: 'credential_screen_full',
    });
    expect(log).toEqual([]);
  });
});
