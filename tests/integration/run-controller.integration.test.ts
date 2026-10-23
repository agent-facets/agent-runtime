// The run controller's outcomes: success only with a new recorded result, typed failures, publication, no-op
// continuations and fail-stop — through the production wiring, with the transport log and database as witnesses.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { FailStop } from '../../packages/runtime/src/execution/controller.ts';
import { InvocationExecutor } from '../../packages/runtime/src/execution/invocation.ts';
import { KeyedSerializer } from '../../packages/runtime/src/persistence/keyed-serializer.ts';
import { openPersistence, type Persistence } from '../../packages/runtime/src/persistence/persistence.ts';
import { ask, createWiring, echo, final } from '../../packages/runtime/test-support/lifecycle/wiring.ts';
import { AIMessage, type ScriptStep } from '../../packages/runtime/test-support/scripted-model.ts';
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

const read: ScriptStep = () =>
  new AIMessage({
    id: `m-${crypto.randomUUID()}`,
    content: 'Reading the plan.',
    tool_calls: [
      {
        id: `c-${crypto.randomUUID()}`,
        name: 'mcp_Read',
        args: { mode: 'file', path: 'notes/plan.md' },
        type: 'tool_call',
      },
    ],
  });

function wired(scripts: ScriptStep[][], options: { respond?: () => Response; failStop?: () => void } = {}) {
  const sent: string[] = [];
  const wiring = createWiring(persistence, {
    root: fixture.root,
    scripts,
    transport: (async () => {
      sent.push('request');
      return (options.respond ?? (() => new Response('{"ok":true}')))();
    }) as unknown as typeof fetch,
    ...(options.failStop === undefined ? {} : { failStop: options.failStop }),
  });
  return { wiring, sent };
}

async function history(wiring: ReturnType<typeof wired>['wiring'], runId: string) {
  return (await wiring.store.readEvents(runId, { after: '0', limit: 500 })).map((event) => ({
    seq: event.seq,
    ...event.event,
  }));
}

describe('run controller outcomes', () => {
  test('success references the recorded final result; intermediate messages and tools are in history, in order', async () => {
    const { wiring, sent } = wired([[read, final]]);
    const { runId, invocationId } = await wiring.createRun();
    const state = await wiring.controller.run(runId, invocationId, { kind: 'initial', goal: 'Read.' });
    if (state.kind !== 'succeeded') throw new Error(state.kind);
    const events = await history(wiring, runId);
    const result = events.find((event) => event.seq === state.resultSeq);
    expect(result).toMatchObject({ kind: 'assistant.message', payload: { text: 'Done.' } });
    const kinds = events.map((event) => event.kind);
    expect(kinds.indexOf('assistant.message')).toBeLessThan(kinds.indexOf('tool.operation'));
    expect(kinds.at(-1)).toBe('run.status');
    expect(sent).toHaveLength(2);
    const [invocation] = await db.admin`select disposition from runtime.invocations where run_id = ${runId}`;
    expect(invocation.disposition).toBe('settled');
  });

  test('the next request beyond the budget fails the run with the step limit', async () => {
    const { wiring, sent } = wired([[read, final]]);
    const { runId, invocationId } = await wiring.createRun(1);
    const state = await wiring.controller.run(runId, invocationId, { kind: 'initial', goal: 'Read.' });
    expect(state).toMatchObject({
      kind: 'failed',
      failure: { category: 'step_limit', reason: 'step_budget_exhausted' },
    });
    expect(sent).toHaveLength(1);
  });

  test('a provider error is a provider failure with application-owned text', async () => {
    const { wiring } = wired([[final]], {
      respond: () => new Response('{"error":"secret-ish detail"}', { status: 503 }),
    });
    const { runId, invocationId } = await wiring.createRun();
    const state = await wiring.controller.run(runId, invocationId, { kind: 'initial', goal: 'Go.' });
    expect(state).toMatchObject({
      kind: 'failed',
      failure: { category: 'provider_failure', reason: 'provider_unavailable' },
    });
    expect(JSON.stringify(state)).not.toContain('secret-ish');
  });

  test('a question makes the run wait; an accepted answer continues it to success', async () => {
    const { wiring } = wired([[ask], [echo]]);
    const { runId, invocationId } = await wiring.createRun();
    expect((await wiring.controller.run(runId, invocationId, { kind: 'initial', goal: 'Ask.' })).kind).toBe('waiting');
    const questionId = (await wiring.store.snapshot(runId)).pendingQuestion?.questionId ?? '';
    const answered = await wiring.answer(runId, questionId, { answer: true });
    if (answered.kind !== 'accepted') throw new Error(answered.kind);
    const state = await wiring.controller.run(runId, answered.acceptance.invocationId, {
      kind: 'resume',
      ...answered.resume,
    });
    expect(state.kind).toBe('succeeded');
  });

  test('a continuation that produces no new work, result or question is a runtime failure, not success', async () => {
    const { wiring } = wired([[ask], []]);
    const { runId, invocationId } = await wiring.createRun();
    await wiring.controller.run(runId, invocationId, { kind: 'initial', goal: 'Ask.' });
    const questionId = (await wiring.store.snapshot(runId)).pendingQuestion?.questionId ?? '';
    const answered = await wiring.answer(runId, questionId, { answer: true });
    if (answered.kind !== 'accepted') throw new Error(answered.kind);
    const continuation = { kind: 'resume' as const, ...answered.resume };
    // The graph is driven to completion outside the controller, so the controller's own continuation has nothing
    // left to do: it returns without new work, a result or a question.
    const outside = wiring.agentFor(runId, answered.acceptance.invocationId, [echo]);
    const drained = await new InvocationExecutor(new KeyedSerializer()).start({
      runId,
      agent: outside,
      input: continuation,
      budgetMax: 10,
    }).settled;
    expect(drained).toEqual({ kind: 'finished' });
    const state = await wiring.controller.run(runId, answered.acceptance.invocationId, continuation);
    expect(state).toMatchObject({
      kind: 'failed',
      failure: { category: 'runtime_failure', reason: 'no_op_continuation' },
    });
  });

  test('cancellation accepted during the model step wins over a late completion', async () => {
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    let reached = false;
    const { wiring } = wired([
      [
        async () => {
          reached = true;
          await held;
          return new AIMessage({ id: 'late', content: 'late result' });
        },
      ],
    ]);
    const { runId, invocationId } = await wiring.createRun();
    const running = wiring.controller.run(runId, invocationId, { kind: 'initial', goal: 'Wait.' });
    await eventually(() => reached, 5_000, 'model step');
    const { result, settled } = await wiring.cancel(runId);
    expect(result).toMatchObject({ kind: 'accepted', state: { kind: 'cancelling' } });
    release();
    await running;
    expect((await settled).kind).toBe('cancelled');
    expect((await wiring.store.snapshot(runId)).state.kind).toBe('cancelled');
  });

  test('an outcome whose commit cannot be established stops the service instead of guessing', async () => {
    let stopped = 0;
    const { wiring } = wired([[final]], { failStop: () => stopped++ });
    const { runId, invocationId } = await wiring.createRun();
    const store = wiring.store;
    const original = store.finishInvocation.bind(store);
    store.finishInvocation = async () => {
      throw Object.assign(new Error('Connection closed'), { code: 'ERR_POSTGRES_CONNECTION_CLOSED' });
    };
    try {
      await expect(wiring.controller.run(runId, invocationId, { kind: 'initial', goal: 'Go.' })).rejects.toBeInstanceOf(
        FailStop,
      );
    } finally {
      store.finishInvocation = original;
    }
    expect(stopped).toBe(1);
    expect((await store.snapshot(runId)).state.kind).toBe('working');
  });
});
