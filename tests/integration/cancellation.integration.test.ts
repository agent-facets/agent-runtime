// Durable cancellation (Decision 8): acknowledged only after it is recorded, no dispatch after acceptance, and
// `cancelling` until local work has actually settled. Work is held at deterministic latches; the transport log,
// source-stream cancellation and the database are the witnesses.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { runAdmission } from '../../packages/runtime/src/execution/admission.ts';
import { createExecutionAgent } from '../../packages/runtime/src/execution/agent.ts';
import { ActiveInvocations, cancelRun } from '../../packages/runtime/src/execution/cancellation.ts';
import { InFlight, trackedSaver } from '../../packages/runtime/src/execution/in-flight.ts';
import { InvocationExecutor, type InvocationSettlement } from '../../packages/runtime/src/execution/invocation.ts';
import { runOperationLedger } from '../../packages/runtime/src/execution/operations.ts';
import { type AppliedCredential, createTerminal } from '../../packages/runtime/src/execution/terminal.ts';
import { READ_TOOL } from '../../packages/runtime/src/execution/tools.ts';
import { KeyedSerializer } from '../../packages/runtime/src/persistence/keyed-serializer.ts';
import { openPersistence, type Persistence } from '../../packages/runtime/src/persistence/persistence.ts';
import type { CreateRunInput, RunStore } from '../../packages/runtime/src/records/run-store.ts';
import { AIMessage, FetchingModel, type ScriptStep } from '../../packages/runtime/test-support/scripted-model.ts';
import { createFixture } from '../../packages/runtime/test-support/workspace.ts';
import { BINDING, Lifecycle } from '../support/lifecycle.ts';
import { AT, workspace as storedWorkspace } from '../support/run-records.ts';
import { createScratchDatabase, eventually, type ScratchDatabase } from '../support/scratch-database.ts';

let db: ScratchDatabase;
let persistence: Persistence;
let life: Lifecycle;
const fixture = createFixture();
fixture.write('notes/plan.md', 'alpha\n');
beforeAll(async () => {
  db = await createScratchDatabase();
  persistence = await openPersistence({ url: db.url, onFault: () => {} });
  life = new Lifecycle(persistence, fixture);
});
afterAll(async () => {
  await persistence.close();
  await db.drop();
  fixture.cleanup();
});

function latch() {
  let release: () => void = () => {};
  const promise = new Promise<void>((resolve) => (release = resolve));
  return { promise, release };
}

const readStep: ScriptStep = () =>
  new AIMessage({
    id: `m-${crypto.randomUUID()}`,
    content: '',
    tool_calls: [
      {
        id: `c-${crypto.randomUUID()}`,
        name: READ_TOOL,
        args: { mode: 'file', path: 'notes/plan.md' },
        type: 'tool_call',
      },
    ],
  });
const finalStep: ScriptStep = () => new AIMessage({ id: `m-${crypto.randomUUID()}`, content: 'Done.' });

interface Holds {
  credentials?: () => Promise<AppliedCredential>;
  respond?: (count: number) => Response;
  store?: RunStore;
  /** Holds a tool call in flight before it reaches the dispatch gate. */
  beforeToolStart?: () => Promise<void>;
  saverWrites?: { hold: () => Promise<void> };
}

const active = new ActiveInvocations();

/** Starts a run in the background, registered for cancellation, with holds at the requested points. */
async function startRun(steps: ScriptStep[], holds: Holds = {}) {
  const store = holds.store ?? life.store;
  const { snapshot } = await life.store.createRun({
    requestId: crypto.randomUUID(),
    goal: 'Work.',
    provider: 'anthropic',
    workspace: { ...storedWorkspace, policyDigest: life.workspacePolicy.digest },
    binding: BINDING as CreateRunInput['binding'],
    definition: { digest: await life.definitionDigest(crypto.randomUUID()), manifest: { note: 'test' } },
    budgetMax: 10,
  });
  if (snapshot.state.kind !== 'working') throw new Error('expected a working run');
  const runId = snapshot.runId;
  const invocationId = snapshot.state.invocationId;
  const sent: string[] = [];
  const inflight = new InFlight();
  const executor = new InvocationExecutor(new KeyedSerializer());
  let invocation: ReturnType<InvocationExecutor['start']> | undefined;

  const base = persistence.checkpoints.saver;
  let saver = base;
  if (holds.saverWrites !== undefined) {
    const held = Object.create(base) as typeof base;
    held.putWrites = async (config, writes, taskId) => {
      await holds.saverWrites?.hold();
      return base.putWrites(config, writes, taskId);
    };
    saver = held;
  }
  const terminal = createTerminal({
    policy: { origin: 'https://api.provider.test', routes: [{ method: 'POST', path: '/v1/messages' }] },
    get signal() {
      return invocation?.signal ?? new AbortController().signal;
    },
    credentials: holds.credentials ?? (async () => ({ headers: { authorization: 'Bearer synthetic' }, generation: 1 })),
    admission: runAdmission({ store, gates: life.gates, owner: persistence.ownership, runId, invocationId }),
    transport: (async () => {
      sent.push('request');
      return (holds.respond ?? (() => new Response('{"ok":true}')))(sent.length);
    }) as unknown as typeof fetch,
    track: (work: Promise<void>) => {
      inflight.track(work);
    },
  } as never);
  const agent = createExecutionAgent({
    runId,
    model: new FetchingModel(steps, terminal),
    checkpointer: trackedSaver(saver, inflight),
    workspace: life.workspacePolicy,
    contentPolicy: () => life.policy,
    operations: ((ledger) => ({
      start: async (identity: Parameters<typeof ledger.start>[0]) => {
        await holds.beforeToolStart?.();
        return ledger.start(identity);
      },
      complete: ledger.complete,
    }))(runOperationLedger({ store, gates: life.gates, runId, invocationId })),
    track: (work) => {
      inflight.track(work);
    },
  });
  invocation = executor.start({ runId, agent, input: { kind: 'initial', goal: 'Work.' }, budgetMax: 10 });
  active.register(runId, invocation, inflight);
  return { runId, invocationId, sent, inflight, invocation };
}

const cancel = (runId: string, requestId = crypto.randomUUID()) =>
  cancelRun({ store: life.store, gates: life.gates, active }, runId, requestId);

async function recorded(runId: string) {
  const [row] = await db.admin`
    select state ->> 'kind' as state,
      (select count(*)::int from runtime.model_attempts a where a.run_id = r.run_id) as attempts,
      (select count(*)::int from runtime.tool_operations t where t.run_id = r.run_id) as tools
    from runtime.runs r where run_id = ${runId}`;
  return row as { state: string; attempts: number; tools: number };
}

describe('cancellation', () => {
  test('a waiting run is cancelled at once; its question closes and a stale answer cannot continue it', async () => {
    const { runId, questionId } = await life.waitingRun();
    const { result, settled } = await cancel(runId);
    expect(result).toMatchObject({ kind: 'accepted', state: { kind: 'cancelled' } });
    expect((await settled).kind).toBe('cancelled');
    const [question] =
      await db.admin`select disposition ->> 'kind' as kind from runtime.questions where run_id = ${runId}`;
    expect(question.kind).toBe('closed');
    expect(await life.answer(runId, questionId, { answer: true })).toEqual({ kind: 'not_answerable' });
  });

  test('cancellation during a credential wait: nothing is admitted or sent, then the run is cancelled', async () => {
    const credentialWait = latch();
    const { runId, sent } = await startRun([finalStep], {
      credentials: async () => {
        await credentialWait.promise;
        return { headers: { authorization: 'Bearer synthetic' }, generation: 1 };
      },
    });
    await Bun.sleep(50);
    const { result, settled } = await cancel(runId);
    expect(result).toMatchObject({ kind: 'accepted', state: { kind: 'cancelling' } });
    expect((await settled).kind).toBe('cancelled');
    credentialWait.release();
    await Bun.sleep(30);
    expect(sent).toHaveLength(0);
    expect(await recorded(runId)).toEqual({ state: 'cancelled', attempts: 0, tools: 0 });
  });

  test('cancellation after headers stops the stalled body; the attempt settles before the run is cancelled', async () => {
    const witness: string[] = [];
    const { runId, sent } = await startRun([finalStep], {
      respond: () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('partial'));
            },
            cancel() {
              witness.push('source-cancelled');
            },
          }),
        ),
    });
    await eventually(async () => (await recorded(runId)).attempts === 1, 5_000, 'dispatch');
    await Bun.sleep(30);
    const { settled } = await cancel(runId);
    expect((await settled).kind).toBe('cancelled');
    expect(witness).toEqual(['source-cancelled']);
    expect(sent).toHaveLength(1);
    const [attempt] =
      await db.admin`select state ->> 'kind' as kind, state ->> 'outcome' as outcome from runtime.model_attempts where run_id = ${runId}`;
    expect(attempt).toEqual({ kind: 'completed', outcome: 'failed' });
  });

  test('a tool call held at its start is never dispatched once cancellation is accepted', async () => {
    const toolStart = latch();
    const { runId, sent, inflight } = await startRun([readStep, finalStep], {
      beforeToolStart: () => toolStart.promise,
    });
    await eventually(() => inflight.size > 0 && sent.length === 1, 5_000, 'tool in flight');
    await Bun.sleep(30);
    const cancellation = await cancel(runId);
    expect(cancellation.result).toMatchObject({ kind: 'accepted', state: { kind: 'cancelling' } });
    let finished = false;
    void cancellation.settled.then(() => (finished = true));
    await Bun.sleep(50);
    expect(finished).toBe(false);
    expect((await recorded(runId)).state).toBe('cancelling');
    toolStart.release();
    expect((await cancellation.settled).kind).toBe('cancelled');
    expect(await recorded(runId)).toEqual({ state: 'cancelled', attempts: 1, tools: 0 });
    expect(sent).toHaveLength(1);
  });

  test('a checkpoint write in progress keeps the run cancelling until it settles', async () => {
    const write = latch();
    let holding = false;
    const { runId, sent } = await startRun([readStep, finalStep], {
      saverWrites: {
        hold: async () => {
          holding = true;
          await write.promise;
        },
      },
    });
    await eventually(() => holding, 5_000, 'held checkpoint write');
    const cancellation = await cancel(runId);
    let finished = false;
    void cancellation.settled.then(() => (finished = true));
    await Bun.sleep(50);
    expect(finished).toBe(false);
    expect((await recorded(runId)).state).toBe('cancelling');
    write.release();
    expect((await cancellation.settled).kind).toBe('cancelled');
    expect(sent.length).toBeLessThanOrEqual(1);
  });

  test('a repeated request returns its disposition; a different request conflicts; a finished run stays finished', async () => {
    const { runId } = await life.waitingRun();
    const requestId = crypto.randomUUID();
    const first = await cancel(runId, requestId);
    const again = await cancel(runId, requestId);
    expect(again.result).toMatchObject({
      kind: 'repeated',
      cancellationId: first.result.kind === 'accepted' ? first.result.cancellationId : 'none',
    });
    expect((await cancel(runId)).result.kind).toBe('conflict');

    const finished = await life.waitingRun();
    const snapshot = await life.store.snapshot(finished.runId);
    await life.store.refuseContinuation({
      runId: finished.runId,
      questionId: finished.questionId,
      expectedRevision: snapshot.revision,
      failure: {
        category: 'runtime_failure',
        reason: 'test_stop',
        message: 'Stopped.',
        operation: { kind: 'runtime' },
      },
    });
    expect((await cancel(finished.runId)).result).toMatchObject({ kind: 'finished', state: { kind: 'failed' } });
  });

  test('cancellation first: a late completion cannot replace the cancelled outcome', async () => {
    const hold = latch();
    const { runId, invocation } = await startRun([
      async () => {
        await hold.promise;
        return new AIMessage({ id: 'late', content: 'late result' });
      },
    ]);
    await eventually(async () => (await recorded(runId)).attempts === 1, 5_000, 'dispatch');
    const { settled } = await cancel(runId);
    hold.release();
    const outcome: InvocationSettlement = await invocation.settled;
    expect(['failed', 'finished']).toContain(outcome.kind);
    expect((await settled).kind).toBe('cancelled');
    const snapshot = await life.store.snapshot(runId);
    await expect(
      life.store.transition({
        runId,
        expectedRevision: snapshot.revision,
        next: { kind: 'succeeded', finishedAt: AT, resultSeq: '1' },
      }),
    ).rejects.toMatchObject({ code: 'run_finished' });
    expect((await life.store.snapshot(runId)).state.kind).toBe('cancelled');
  });

  test('an answer accepted before cancellation stays accepted', async () => {
    const { runId, questionId } = await life.waitingRun();
    const answered = await life.answer(runId, questionId, { answer: true });
    expect(answered.kind).toBe('accepted');
    const { result, settled } = await cancel(runId);
    expect(result).toMatchObject({ kind: 'accepted', state: { kind: 'cancelling' } });
    expect((await settled).kind).toBe('cancelled');
    const [question] =
      await db.admin`select disposition ->> 'kind' as kind, disposition -> 'answer' as answer from runtime.questions where run_id = ${runId}`;
    expect(question).toEqual({ kind: 'answered', answer: true });
  });
});
