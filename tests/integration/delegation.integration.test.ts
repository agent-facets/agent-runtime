// Bounded named delegation through the production controller (design Decisions 7 and 8): a command run's root
// delegates to retained stock agents on the same thread, saver, invocation, admission and budget; delegated
// questions pause the run and return to their asker; failures and limits are typed; cancellation covers the child.
// Provider-free: a scripted model behind the guarded terminal, whose fake transport counts physical requests.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { DELEGATE_PROMPT } from '../../packages/runtime/src/execution/delegation.ts';
import { openPersistence, type Persistence } from '../../packages/runtime/src/persistence/persistence.ts';
import { commandFixture, createWiring, echo } from '../../packages/runtime/test-support/lifecycle/wiring.ts';
import { AIMessage, type ScriptStep, untilAborted } from '../../packages/runtime/test-support/scripted-model.ts';
import { createFixture } from '../../packages/runtime/test-support/workspace.ts';
import { createScratchDatabase, eventually, type ScratchDatabase } from '../support/scratch-database.ts';

let db: ScratchDatabase;
let persistence: Persistence;
const fixture = createFixture();
fixture.write('notes/plan.md', 'alpha\n');
beforeAll(async () => {
  db = await createScratchDatabase();
  persistence = await openPersistence({ url: db.url, onFault: () => {} });
});
afterAll(async () => {
  await persistence.close();
  await db.drop();
  fixture.cleanup();
});

let requests = 0;
const transport = (async () => {
  requests++;
  return new Response('{"ok":true}');
}) as unknown as typeof fetch;

const calls =
  (id: string, ...list: { name: string; args: Record<string, unknown>; call?: string }[]): ScriptStep =>
  () =>
    new AIMessage({
      id: `m-${id}`,
      content: '',
      tool_calls: list.map((item, index) => ({
        id: item.call ?? `c-${id}-${index}`,
        name: item.name,
        args: item.args,
        type: 'tool_call' as const,
      })),
    });
const delegate = (id: string, agent = 'agent:helper', task = 'Read the plan.') =>
  calls(id, { name: 'mcp_Delegate', args: { agent, task } });
const read = (id: string, call?: string) =>
  calls(id, {
    name: 'mcp_Read',
    args: { mode: 'file', path: 'notes/plan.md' },
    ...(call === undefined ? {} : { call }),
  });
const ask = (id: string, options: { label: string; value: unknown }[] = [{ label: 'No', value: false }]) =>
  calls(id, {
    name: 'mcp_AskUser',
    args: { prompt: `Question ${id}?`, input: { kind: 'choice', multiple: false, options } },
  });
const say =
  (text: string): ScriptStep =>
  () =>
    new AIMessage({ id: `m-${crypto.randomUUID()}`, content: text });

function wiring(scripts: ScriptStep[][] = []) {
  return createWiring(persistence, { root: fixture.root, scripts, transport, failStop: () => {} });
}

async function commandRun(w: ReturnType<typeof wiring>, options: { budgetMax?: number; maxDelegations?: number } = {}) {
  const { snapshot, input } = commandFixture({
    arguments: `owner/repo-${crypto.randomUUID().slice(0, 8)}`,
    ...(options.maxDelegations === undefined ? {} : { maxDelegations: options.maxDelegations }),
  });
  return w.createRun(options.budgetMax ?? 20, { snapshot, input });
}

async function history(runId: string) {
  const w = wiring();
  return (await w.store.readEvents(runId, { after: '0', limit: 500 })).map((stored) => stored.event);
}

async function rows(runId: string) {
  return {
    actors: await db.admin`select actor_key, agent_id, state from runtime.run_actors
      where run_id = ${runId} and kind = 'delegate' order by created_at`,
    operations: await db.admin`select actor_key, tool_name, disposition from runtime.tool_operations
      where run_id = ${runId} order by created_at`,
    attempts: await db.admin`select ordinal, actor_key, state ->> 'kind' as kind from runtime.model_attempts
      where run_id = ${runId} order by ordinal`,
  };
}

describe('delegating a task', () => {
  test('the delegate gets only its instructions and task, uses the run budget, and its result returns to the root', async () => {
    const seen: string[][] = [];
    const recordingRead: ScriptStep = (messages) => {
      seen.push(messages.map((message) => message.text));
      return read('d1')(messages, undefined);
    };
    const w = wiring([[delegate('r1'), recordingRead, say('The plan says alpha.'), echo]]);
    const run = await commandRun(w);
    const before = requests;
    const state = await w.controller.run(run.runId, run.invocationId, { kind: 'initial', goal: run.goal });
    expect(state.kind).toBe('succeeded');
    expect(requests - before).toBe(4);

    // The delegate saw the fixed delegate prompt, its retained instructions and the task — not the root's goal.
    const [system, task] = seen[0] as [string, string];
    expect(system).toContain(DELEGATE_PROMPT);
    expect(system).toContain('You are the helper agent.');
    expect(task).toBe('Read the plan.');
    expect(seen[0]?.join('\n')).not.toContain(run.goal);

    const { actors, operations, attempts } = await rows(run.runId);
    expect(actors).toHaveLength(1);
    const delegationId = actors[0].actor_key;
    expect(actors[0]).toMatchObject({
      agent_id: 'agent:helper',
      state: { kind: 'completed', outcome: { kind: 'result', text: 'The plan says alpha.' } },
    });
    expect(attempts.map((row: { actor_key: string }) => row.actor_key)).toEqual([
      'root',
      delegationId,
      delegationId,
      'root',
    ]);
    expect(attempts.map((row: { ordinal: number }) => row.ordinal)).toEqual([1, 2, 3, 4]);
    expect(operations.map((row: { actor_key: string; tool_name: string }) => [row.actor_key, row.tool_name])).toEqual([
      ['root', 'mcp_Delegate'],
      [delegationId, 'mcp_Read'],
    ]);
    expect((await w.store.snapshot(run.runId)).budget).toEqual({ maximum: 20, consumed: 4, unconfirmed: 0 });

    const events = await history(run.runId);
    const kinds = events.map((event) =>
      event.kind === 'assistant.message' || event.kind === 'tool.operation'
        ? `${event.kind}:${event.payload.actor?.kind}`
        : event.kind,
    );
    const started = kinds.indexOf('delegation.started');
    const finished = kinds.indexOf('delegation.finished');
    expect(started).toBeGreaterThan(kinds.indexOf('run.command'));
    expect(kinds.slice(started, finished)).toContain('tool.operation:delegate');
    expect(kinds.slice(started, finished)).toContain('assistant.message:delegate');
    expect(kinds.at(-1)).toBe('run.status');
    const result = events.findLast((event) => event.kind === 'assistant.message');
    expect(result?.kind === 'assistant.message' && result.payload.actor).toEqual({ kind: 'root' });
  });

  test('a delegate has the caller’s tools narrowed by its agent, and no delegation tool', async () => {
    const w = wiring([
      [
        delegate('r1', 'agent:narrow', 'Search, then delegate.'),
        calls('d1', { name: 'mcp_Search', args: { query: 'alpha' } }),
        calls('d2', { name: 'mcp_Delegate', args: { agent: 'agent:helper', task: 'Again.' } }),
        say('I could not search.'),
        echo,
      ],
    ]);
    const run = await commandRun(w);
    expect((await w.controller.run(run.runId, run.invocationId, { kind: 'initial', goal: run.goal })).kind).toBe(
      'succeeded',
    );
    const { actors, operations } = await rows(run.runId);
    expect(actors).toHaveLength(1);
    const refused = operations.filter((row: { actor_key: string }) => row.actor_key === actors[0].actor_key);
    expect(
      refused.map((row: { tool_name: string; disposition: { result: { code: string } } }) => [
        row.tool_name,
        row.disposition.result.code,
      ]),
    ).toEqual([
      ['mcp_Search', 'tool_unavailable'],
      ['mcp_Delegate', 'tool_unavailable'],
    ]);
  });

  test('two calls to the same named agent are separate delegations; provider call IDs are scoped per actor', async () => {
    const w = wiring([
      [
        delegate('r1'),
        read('d1', 'c-same'),
        say('first'),
        delegate('r2'),
        read('d2', 'c-same'),
        say('second'),
        read('r3', 'c-same'),
        echo,
      ],
    ]);
    const run = await commandRun(w);
    expect((await w.controller.run(run.runId, run.invocationId, { kind: 'initial', goal: run.goal })).kind).toBe(
      'succeeded',
    );
    const { actors, operations } = await rows(run.runId);
    expect(actors.map((row: { agent_id: string }) => row.agent_id)).toEqual(['agent:helper', 'agent:helper']);
    expect(actors[0].actor_key).not.toBe(actors[1].actor_key);
    expect(actors.map((row: { state: { outcome: { text: string } } }) => row.state.outcome.text)).toEqual([
      'first',
      'second',
    ]);
    const reads = operations.filter((row: { tool_name: string }) => row.tool_name === 'mcp_Read');
    expect(new Set(reads.map((row: { actor_key: string }) => row.actor_key)).size).toBe(3);
  });

  test('a delegation must be alone in its response; unavailable agents and exhausted limits are refused', async () => {
    const w = wiring([
      [
        calls(
          'r1',
          { name: 'mcp_Delegate', args: { agent: 'agent:helper', task: 'Look.' } },
          { name: 'mcp_Read', args: { mode: 'file', path: 'notes/plan.md' } },
        ),
        delegate('r2', 'agent:missing'),
        delegate('r3'),
        say('done'),
        delegate('r4'),
        echo,
      ],
    ]);
    const run = await commandRun(w, { maxDelegations: 1 });
    expect((await w.controller.run(run.runId, run.invocationId, { kind: 'initial', goal: run.goal })).kind).toBe(
      'succeeded',
    );
    const { actors, operations } = await rows(run.runId);
    expect(actors).toHaveLength(1);
    const codes = operations
      .filter((row: { actor_key: string }) => row.actor_key === 'root')
      .map(
        (row: { disposition: { result: { outcome: string; code?: string } } }) =>
          row.disposition.result.code ?? row.disposition.result.outcome,
      );
    expect(codes).toEqual([
      'delegation_not_alone',
      'delegation_not_alone',
      'agent_unavailable',
      'ok',
      'delegation_limit_reached',
    ]);
  });

  test('an unusable delegate result reaches the caller as an identified failure, and the caller continues', async () => {
    const w = wiring([[delegate('r1'), say('x'.repeat(70_000)), echo]]);
    const run = await commandRun(w);
    expect((await w.controller.run(run.runId, run.invocationId, { kind: 'initial', goal: run.goal })).kind).toBe(
      'succeeded',
    );
    const { actors } = await rows(run.runId);
    expect(actors[0].state).toEqual({
      kind: 'completed',
      outcome: { kind: 'failed', reason: 'result_too_large', message: expect.any(String) },
    });
    const finished = (await history(run.runId)).find((event) => event.kind === 'delegation.finished');
    expect(finished?.kind === 'delegation.finished' && finished.payload.outcome).toBe('failed');
    const final = (await history(run.runId)).findLast((event) => event.kind === 'assistant.message');
    expect(final?.kind === 'assistant.message' && final.payload.text).toContain('result_too_large');
  });

  test('a delegate’s renewed request is another physical request on the run’s ordinals, with no fallback', async () => {
    let sent = 0;
    const renewing = createWiring(persistence, {
      root: fixture.root,
      scripts: [[delegate('r1'), say('done'), echo]],
      failStop: () => {},
      // The delegate's first request (the run's second) is rejected once; the renewed resend is admitted anew.
      transport: (async () => {
        sent++;
        return sent === 2 ? new Response('{}', { status: 401 }) : new Response('{"ok":true}');
      }) as unknown as typeof fetch,
      renewal: { recoverable: async (response) => response.status === 401, renew: async () => {} },
    });
    const run = await commandRun(renewing);
    expect((await renewing.controller.run(run.runId, run.invocationId, { kind: 'initial', goal: run.goal })).kind).toBe(
      'succeeded',
    );
    expect(sent).toBe(4);
    const { actors, attempts } = await rows(run.runId);
    const delegationId = actors[0].actor_key;
    expect(attempts.map((row: { ordinal: number; actor_key: string }) => [row.ordinal, row.actor_key])).toEqual([
      [1, 'root'],
      [2, delegationId],
      [3, delegationId],
      [4, 'root'],
    ]);
    expect((await renewing.store.snapshot(run.runId)).budget.consumed).toBe(4);
  });

  test('a delegate cannot obtain a fresh allowance: the shared budget ends the run as a step limit', async () => {
    const w = wiring([[delegate('r1'), read('d1'), say('never')]]);
    const run = await commandRun(w, { budgetMax: 2 });
    const before = requests;
    const state = await w.controller.run(run.runId, run.invocationId, { kind: 'initial', goal: run.goal });
    expect(state.kind === 'failed' && state.failure.category).toBe('step_limit');
    expect(requests - before).toBe(2);
    expect((await rows(run.runId)).actors[0].state).toEqual({ kind: 'abandoned', reason: 'unfinished' });
  });

  test('cancellation stops an active delegate; no caller continuation or further request follows', async () => {
    let reached: () => void = () => {};
    const inChild = new Promise<void>((resolve) => (reached = resolve));
    const w = wiring([
      [
        delegate('r1'),
        (_messages, signal) => {
          reached();
          return untilAborted(signal);
        },
        echo,
      ],
    ]);
    const run = await commandRun(w);
    const work = w.controller.run(run.runId, run.invocationId, { kind: 'initial', goal: run.goal });
    await inChild;
    const before = requests;
    const { settled } = await w.cancel(run.runId);
    expect((await settled).kind).toBe('cancelled');
    await work.catch(() => {});
    expect(requests - before).toBe(0);
    expect((await rows(run.runId)).actors[0].state).toEqual({ kind: 'abandoned', reason: 'cancelled' });
  });
});

describe('delegated questions', () => {
  async function waiting(w: ReturnType<typeof wiring>, script: ScriptStep[]) {
    w.script(script);
    const run = await commandRun(w);
    const state = await w.controller.run(run.runId, run.invocationId, { kind: 'initial', goal: run.goal });
    expect(state.kind).toBe('waiting');
    const snapshot = await w.store.snapshot(run.runId);
    return { ...run, questionId: snapshot.pendingQuestion?.questionId as string, snapshot };
  }

  test('a delegate’s question pauses the run, names its asker and resumes the same delegate with an exact answer', async () => {
    const w = wiring();
    const run = await waiting(w, [delegate('r1'), read('d1'), ask('d2')]);
    const { actors, operations } = await rows(run.runId);
    const delegationId = actors[0].actor_key;
    expect(run.snapshot.pendingQuestion?.asker).toEqual({ kind: 'delegate', delegationId, agentId: 'agent:helper' });
    expect(actors[0].state).toEqual({ kind: 'waiting', questionId: run.questionId });
    // The parent delegation stays started; only the delegate's own question call is paused.
    expect(operations.map((row: { disposition: { kind: string } }) => row.disposition.kind)).toEqual([
      'started',
      'completed',
      'paused',
    ]);
    const [question] = await db.admin`select binding from runtime.questions where run_id = ${run.runId}`;
    expect(question.binding).toMatchObject({
      version: 2,
      actor: 'delegate',
      delegationId,
      agentId: 'agent:helper',
      checkpointNs: expect.stringMatching(/./),
      parent: { checkpointNs: '', operationId: delegationId },
    });

    const answered = await w.answer(run.runId, run.questionId, { answer: false });
    if (answered.kind !== 'accepted') throw new Error(answered.kind);
    expect((await rows(run.runId)).actors[0].state).toEqual({ kind: 'active' });
    w.script([echo, echo]);
    const reads = requests;
    const state = await w.controller.run(run.runId, answered.acceptance.invocationId, {
      kind: 'resume',
      ...answered.resume,
    });
    expect(state.kind).toBe('succeeded');
    expect(requests - reads).toBe(2);
    const after = await rows(run.runId);
    expect(after.operations.filter((row: { tool_name: string }) => row.tool_name === 'mcp_Read')).toHaveLength(1);
    expect(after.actors[0].state.outcome.text).toContain('"answer":false');
    expect((await w.answer(run.runId, run.questionId, { answer: false })).kind).toBe('already_accepted');
  });

  test('inspection outages accept nothing; confirmed loss of the delegate’s saved state closes the run', async () => {
    const w = wiring();
    const run = await waiting(w, [delegate('r1'), ask('d1')]);
    const original = w.store.readDelegate.bind(w.store);
    w.store.readDelegate = async () => {
      throw new Error('storage unavailable');
    };
    expect((await w.answer(run.runId, run.questionId, { answer: false })).kind).toBe('cannot_verify');
    w.store.readDelegate = original;
    expect((await w.store.snapshot(run.runId)).state.kind).toBe('waiting');

    const [actor] = (await rows(run.runId)).actors;
    const [ns] = await db.admin`select checkpoint_ns from runtime.run_actors where actor_key = ${actor.actor_key}`;
    await db.admin`delete from checkpoints.checkpoints where thread_id = ${run.runId} and checkpoint_ns = ${ns.checkpoint_ns}`;
    const refused = await w.answer(run.runId, run.questionId, { answer: false });
    expect(refused).toEqual({ kind: 'continuation_unavailable', problem: 'saved_state_missing' });
    const [question] =
      await db.admin`select disposition ->> 'kind' as kind from runtime.questions where run_id = ${run.runId}`;
    expect(question.kind).toBe('closed');
    expect((await rows(run.runId)).actors[0].state).toEqual({ kind: 'abandoned', reason: 'saved_state_missing' });
  });

  test('cancelling while a delegate waits closes its question; a later answer cannot continue', async () => {
    const w = wiring();
    const run = await waiting(w, [delegate('r1'), ask('d1')]);
    const { settled } = await w.cancel(run.runId);
    expect((await settled).kind).toBe('cancelled');
    expect((await w.answer(run.runId, run.questionId, { answer: false })).kind).toBe('not_answerable');
    expect((await rows(run.runId)).actors[0].state).toEqual({ kind: 'abandoned', reason: 'cancelled' });
  });

  test('an old answer retried after the same delegate asks again does not answer the later question', async () => {
    const w = wiring();
    const run = await waiting(w, [delegate('r1'), ask('d1')]);
    const first = await w.answer(run.runId, run.questionId, { answer: false });
    if (first.kind !== 'accepted') throw new Error(first.kind);
    w.script([ask('d2', [{ label: 'Zero', value: 0 }])]);
    expect(
      (await w.controller.run(run.runId, first.acceptance.invocationId, { kind: 'resume', ...first.resume })).kind,
    ).toBe('waiting');
    const later = (await w.store.snapshot(run.runId)).pendingQuestion?.questionId as string;
    expect(later).not.toBe(run.questionId);
    expect((await w.answer(run.runId, run.questionId, { answer: false })).kind).toBe('already_accepted');
    await eventually(async () => (await w.store.snapshot(run.runId)).pendingQuestion?.questionId === later);
    const second = await w.answer(run.runId, later, { answer: 0 });
    if (second.kind !== 'accepted') throw new Error(second.kind);
    w.script([echo, echo]);
    expect(
      (await w.controller.run(run.runId, second.acceptance.invocationId, { kind: 'resume', ...second.resume })).kind,
    ).toBe('succeeded');
    expect((await rows(run.runId)).actors[0].state.outcome.text).toContain('"answer":0');
  });
});
