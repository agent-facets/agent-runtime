// Question publication (Decision 6): a question becomes answerable only after settlement, saved-state inspection
// and one application commit. Faults are injected at each boundary; the database is the witness.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { exactSecretMatcher } from '../../packages/runtime/src/credentials/matcher.ts';
import { createExecutionAgent } from '../../packages/runtime/src/execution/agent.ts';
import {
  InvocationExecutor,
  type InvocationSettlement,
  type ObservedInterrupt,
} from '../../packages/runtime/src/execution/invocation.ts';
import { runOperationLedger } from '../../packages/runtime/src/execution/operations.ts';
import { type PublicationDeps, publishSettledQuestion } from '../../packages/runtime/src/execution/publication.ts';
import { ASK_TOOL } from '../../packages/runtime/src/execution/tools.ts';
import { KeyedSerializer } from '../../packages/runtime/src/persistence/keyed-serializer.ts';
import { openPersistence, type Persistence } from '../../packages/runtime/src/persistence/persistence.ts';
import { type CreateRunInput, RunStore } from '../../packages/runtime/src/records/run-store.ts';
import { createContentPolicy } from '../../packages/runtime/src/security/content-policy.ts';
import { AIMessage, ScriptedModel } from '../../packages/runtime/test-support/scripted-model.ts';
import { createFixture } from '../../packages/runtime/test-support/workspace.ts';
import { AT, binding, DIGEST, workspace } from '../support/run-records.ts';
import { createScratchDatabase, type ScratchDatabase } from '../support/scratch-database.ts';

let db: ScratchDatabase;
let persistence: Persistence;
let store: RunStore;
const fixture = createFixture();
beforeAll(async () => {
  db = await createScratchDatabase();
  persistence = await openPersistence({ url: db.url, onFault: () => {} });
  store = new RunStore(persistence.app, persistence.ownership);
});
afterAll(async () => {
  await persistence.close();
  await db.drop();
  fixture.cleanup();
});

const ask = () =>
  new AIMessage({
    id: 'm-ask',
    content: '',
    tool_calls: [
      {
        id: 'c-ask',
        name: ASK_TOOL,
        args: {
          prompt: 'Proceed with the change?',
          input: {
            kind: 'choice',
            multiple: false,
            options: [
              { label: 'Yes', value: true },
              { label: 'No', value: false },
            ],
          },
        },
        type: 'tool_call',
      },
    ],
  });

type Saver = Persistence['checkpoints']['saver'];

/** A working run whose agent has asked its question, with everything needed to publish it. */
async function askedRun(saver: Saver = persistence.checkpoints.saver) {
  const { snapshot } = await store.createRun({
    requestId: crypto.randomUUID(),
    goal: 'Decide.',
    provider: 'anthropic',
    workspace,
    binding: binding as CreateRunInput['binding'],
    definition: { digest: DIGEST, manifest: { protocolVersion: 1 } },
    budgetMax: 10,
  });
  if (snapshot.state.kind !== 'working') throw new Error('expected a working run');
  const runId = snapshot.runId;
  const invocationId = snapshot.state.invocationId;
  const gates = new KeyedSerializer();
  const agent = createExecutionAgent({
    runId,
    model: new ScriptedModel([ask]),
    checkpointer: saver,
    workspace: fixture.policy(),
    contentPolicy: () => createContentPolicy(exactSecretMatcher([])),
    operations: runOperationLedger({ store, gates, runId, invocationId }),
  });
  const settlement = await new InvocationExecutor(new KeyedSerializer()).start({
    runId,
    agent,
    input: { kind: 'initial', goal: 'Decide.' },
    budgetMax: 10,
  }).settled;
  const revision = (await store.snapshot(runId)).revision;
  const deps: PublicationDeps = {
    store,
    gates,
    agent,
    saver,
    definitionDigest: DIGEST,
    inspectionAttempts: 2,
    inspectionRetryMs: 10,
  };
  return { runId, invocationId, revision, settlement, deps };
}

async function recorded(runId: string) {
  const [row] = await db.admin`
    select
      (select count(*)::int from runtime.questions where run_id = ${runId}) as questions,
      (select state ->> 'kind' from runtime.runs where run_id = ${runId}) as state,
      (select disposition from runtime.invocations where run_id = ${runId}) as invocation,
      (select disposition ->> 'kind' from runtime.tool_operations where run_id = ${runId}) as operation`;
  return row as { questions: number; state: string; invocation: string; operation: string | null };
}

const connectionLost = () => Object.assign(new Error('Connection closed'), { code: 'ERR_POSTGRES_CONNECTION_CLOSED' });

describe('question publication', () => {
  test('a settled, inspected question is published atomically with its exact binding', async () => {
    const { runId, invocationId, revision, settlement, deps } = await askedRun();
    expect(settlement.kind).toBe('interrupted');
    const outcome = await publishSettledQuestion(deps, { runId, invocationId, expectedRevision: revision }, settlement);
    expect(outcome.kind).toBe('published');
    expect(await recorded(runId)).toEqual({
      questions: 1,
      state: 'waiting',
      invocation: 'settled',
      operation: 'paused',
    });

    const snapshot = await store.snapshot(runId);
    expect(snapshot.pendingQuestion).toMatchObject({ prompt: 'Proceed with the change?' });
    const interrupt = settlement.kind === 'interrupted' ? settlement.interrupts[0] : undefined;
    const [question] = await db.admin`select binding from runtime.questions where run_id = ${runId}`;
    expect(question.binding).toMatchObject({
      threadId: runId,
      checkpointNs: '',
      interruptId: interrupt?.id,
      ordinal: 0,
      operationId: interrupt?.value.questionId,
      definitionDigest: DIGEST,
    });
    const kinds = (await store.readEvents(runId, { after: '0', limit: 100 })).map((event) => event.event.kind);
    expect(kinds.slice(-3)).toEqual(['run.status', 'tool.operation', 'question.asked']);
  });

  test('if the interrupt write itself fails, no question is published', async () => {
    const base = persistence.checkpoints.saver;
    const failing = Object.create(base) as Saver;
    failing.putWrites = async (config, writes, taskId) => {
      if (writes.some(([channel]) => channel === '__interrupt__')) throw connectionLost();
      return base.putWrites(config, writes, taskId);
    };
    const { runId, invocationId, revision, settlement, deps } = await askedRun(failing);
    const outcome = await publishSettledQuestion(deps, { runId, invocationId, expectedRevision: revision }, settlement);
    expect(outcome.kind).toBe('not_published');
    expect(await recorded(runId)).toMatchObject({ questions: 0, state: 'working', invocation: 'active' });
  });

  test('an interrupt seen in the stream but not confirmed by inspection is never published', async () => {
    const { runId, invocationId, revision, settlement, deps } = await askedRun();
    const unreadable = Object.create(deps.saver) as Saver;
    unreadable.getTuple = async () => {
      throw connectionLost();
    };
    const { agent: _agent, ...rest } = deps;
    const reader = createExecutionAgent({
      runId,
      model: new ScriptedModel([]),
      checkpointer: unreadable,
      workspace: fixture.policy(),
      contentPolicy: () => createContentPolicy(exactSecretMatcher([])),
      operations: runOperationLedger({ store, gates: deps.gates, runId, invocationId }),
    });
    const outcome = await publishSettledQuestion(
      { ...rest, agent: reader, saver: unreadable },
      { runId, invocationId, expectedRevision: revision },
      settlement,
    );
    expect(outcome).toEqual({ kind: 'not_published', reason: 'saved_state_unavailable' });
    expect(await recorded(runId)).toMatchObject({ questions: 0, state: 'working', operation: 'started' });

    // A streamed interrupt that does not match the saved one is not published either.
    const forged: InvocationSettlement =
      settlement.kind === 'interrupted'
        ? {
            kind: 'interrupted',
            interrupts: [{ ...(settlement.interrupts[0] as ObservedInterrupt), id: 'f'.repeat(32) }],
          }
        : settlement;
    const mismatch = await publishSettledQuestion(deps, { runId, invocationId, expectedRevision: revision }, forged);
    expect(mismatch).toEqual({ kind: 'not_published', reason: 'saved_state_unusable' });
    expect((await recorded(runId)).questions).toBe(0);
  });

  test('a commit that fails after the saver settled leaves the run unanswerable', async () => {
    const { runId, invocationId, revision, settlement, deps } = await askedRun();
    const failing = Object.create(store) as RunStore;
    failing.publishQuestion = async () => {
      throw Object.assign(new Error('rejected'), { code: '23514' });
    };
    const outcome = await publishSettledQuestion(
      { ...deps, store: failing },
      { runId, invocationId, expectedRevision: revision },
      settlement,
    );
    expect(outcome).toEqual({ kind: 'not_published', reason: 'commit_failed' });
    expect(await recorded(runId)).toMatchObject({ questions: 0, state: 'working' });
  });

  test('an uncertain commit is resolved by readback: a commit that happened counts, one that did not does not', async () => {
    const committed = await askedRun();
    const afterCommit = Object.create(store) as RunStore;
    afterCommit.publishQuestion = async (input) => {
      await store.publishQuestion(input);
      throw connectionLost();
    };
    const first = await publishSettledQuestion(
      { ...committed.deps, store: afterCommit },
      { runId: committed.runId, invocationId: committed.invocationId, expectedRevision: committed.revision },
      committed.settlement,
    );
    expect(first.kind).toBe('published');
    expect((await recorded(committed.runId)).state).toBe('waiting');

    const lost = await askedRun();
    const beforeCommit = Object.create(store) as RunStore;
    beforeCommit.publishQuestion = async () => {
      throw connectionLost();
    };
    const second = await publishSettledQuestion(
      { ...lost.deps, store: beforeCommit },
      { runId: lost.runId, invocationId: lost.invocationId, expectedRevision: lost.revision },
      lost.settlement,
    );
    expect(second).toEqual({ kind: 'not_published', reason: 'commit_failed' });
    expect((await recorded(lost.runId)).questions).toBe(0);
  });

  test('a run that changed first (cancellation accepted) is not made to wait', async () => {
    const { runId, invocationId, revision, settlement, deps } = await askedRun();
    await store.transition({
      runId,
      expectedRevision: revision,
      next: { kind: 'cancelling', cancellationId: crypto.randomUUID(), acceptedAt: AT, invocationId },
    });
    const outcome = await publishSettledQuestion(deps, { runId, invocationId, expectedRevision: revision }, settlement);
    expect(outcome).toEqual({ kind: 'not_published', reason: 'run_changed' });
    expect(await recorded(runId)).toMatchObject({ questions: 0, state: 'cancelling' });
  });
});
