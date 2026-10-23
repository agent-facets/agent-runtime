// Request accounting (Decision 8): every physical model request is durably reserved before it is sent, confirmed
// before its response is used, and counted against the run's budget; the transport's own log is the witness.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { runAdmission } from '../../packages/runtime/src/execution/admission.ts';
import { createExecutionAgent } from '../../packages/runtime/src/execution/agent.ts';
import { executionFailureOf } from '../../packages/runtime/src/execution/failures.ts';
import { InvocationExecutor, type InvocationInput } from '../../packages/runtime/src/execution/invocation.ts';
import { runOperationLedger } from '../../packages/runtime/src/execution/operations.ts';
import { publishSettledQuestion } from '../../packages/runtime/src/execution/publication.ts';
import { type CredentialRenewal, createTerminal } from '../../packages/runtime/src/execution/terminal.ts';
import { READ_TOOL } from '../../packages/runtime/src/execution/tools.ts';
import { KeyedSerializer } from '../../packages/runtime/src/persistence/keyed-serializer.ts';
import type { OwnerFence } from '../../packages/runtime/src/persistence/ownership.ts';
import { openPersistence, type Persistence } from '../../packages/runtime/src/persistence/persistence.ts';
import type { CreateRunInput } from '../../packages/runtime/src/records/run-store.ts';
import { AIMessage, FetchingModel, type ScriptStep } from '../../packages/runtime/test-support/scripted-model.ts';
import { createFixture } from '../../packages/runtime/test-support/workspace.ts';
import { askStep, BINDING, echoStep, Lifecycle } from '../support/lifecycle.ts';
import { AT, workspace as storedWorkspace } from '../support/run-records.ts';
import { createScratchDatabase, type ScratchDatabase } from '../support/scratch-database.ts';

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

const ORIGIN = 'https://api.provider.test';
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

interface Options {
  budgetMax?: number;
  respond?: (count: number) => Response;
  credentials?: () => Promise<{ headers: Record<string, string>; generation: number }>;
  renewal?: CredentialRenewal;
  owner?: Pick<OwnerFence, 'assertHeld' | 'verify'>;
}

/** A run whose model requests go through the guarded terminal with durable admission. */
async function accountedRun(steps: ScriptStep[], options: Options = {}) {
  const { snapshot } = await life.store.createRun({
    requestId: crypto.randomUUID(),
    goal: 'Work.',
    provider: 'anthropic',
    workspace: { ...storedWorkspace, policyDigest: life.workspacePolicy.digest },
    binding: BINDING as CreateRunInput['binding'],
    definition: { digest: await life.definitionDigest(crypto.randomUUID()), manifest: { note: 'test' } },
    budgetMax: options.budgetMax ?? 10,
  });
  if (snapshot.state.kind !== 'working') throw new Error('expected a working run');
  const runId = snapshot.runId;
  const sent: string[] = [];
  const transport = (async () => {
    sent.push('request');
    return (options.respond ?? (() => new Response('{"ok":true}')))(sent.length);
  }) as unknown as typeof fetch;

  const invoke = async (invocationId: string, script: ScriptStep[], input: InvocationInput) => {
    const controller = new AbortController();
    const terminal = createTerminal({
      policy: { origin: ORIGIN, routes: [{ method: 'POST', path: '/v1/messages' }] },
      signal: controller.signal,
      credentials:
        options.credentials ?? (async () => ({ headers: { authorization: 'Bearer synthetic' }, generation: 1 })),
      admission: runAdmission({
        store: life.store,
        gates: life.gates,
        owner: options.owner ?? persistence.ownership,
        runId,
        invocationId,
      }),
      transport,
      ...(options.renewal === undefined ? {} : { renewal: options.renewal }),
    });
    const model = new FetchingModel(script, terminal);
    const agent = createExecutionAgent({
      runId,
      model,
      checkpointer: life.saver,
      workspace: life.workspacePolicy,
      contentPolicy: () => life.policy,
      operations: runOperationLedger({ store: life.store, gates: life.gates, runId, invocationId }),
    });
    const settled = await new InvocationExecutor(new KeyedSerializer()).start({
      runId,
      agent,
      input,
      budgetMax: options.budgetMax ?? 10,
    }).settled;
    return { settled, agent, model };
  };
  const first = await invoke(snapshot.state.invocationId, steps, { kind: 'initial', goal: 'Work.' });
  return { runId, invocationId: snapshot.state.invocationId, sent, invoke, ...first };
}

async function attempts(runId: string) {
  const rows = await db.admin`
    select state ->> 'kind' as kind from runtime.model_attempts where run_id = ${runId} order by ordinal`;
  const [budget] = await db.admin`select consumed, unconfirmed from runtime.runs where run_id = ${runId}`;
  return {
    states: rows.map((row: { kind: string }) => row.kind),
    consumed: Number(budget.consumed),
    unconfirmed: Number(budget.unconfirmed),
  };
}

const refusalOf = (settled: { kind: string; error?: unknown }) => {
  const evidence = settled.kind === 'failed' ? executionFailureOf(settled.error)?.evidence : undefined;
  return evidence?.kind === 'terminal' ? `${evidence.code}:${evidence.reason ?? ''}` : settled.kind;
};

describe('request accounting', () => {
  test('each physical request is reserved, confirmed and completed; the counts match what was sent', async () => {
    const { runId, sent, settled } = await accountedRun([readStep, finalStep]);
    expect(settled).toEqual({ kind: 'finished' });
    expect(sent).toHaveLength(2);
    expect(await attempts(runId)).toEqual({ states: ['completed', 'completed'], consumed: 2, unconfirmed: 0 });
    const kinds = (await life.store.readEvents(runId, { after: '0', limit: 100 }))
      .filter((event) => event.event.kind === 'model.attempt')
      .map((event) => (event.event.payload as { state: { kind: string } }).state.kind);
    expect(kinds).toEqual(['reserved', 'dispatched', 'completed', 'reserved', 'dispatched', 'completed']);
  });

  test('tool calls from the last permitted request still run; the next request is refused, never sent', async () => {
    const { runId, sent, settled } = await accountedRun([readStep, finalStep], { budgetMax: 1 });
    expect(refusalOf(settled)).toBe('admission_refused:step_budget_exhausted');
    expect(sent).toHaveLength(1);
    expect(await attempts(runId)).toEqual({ states: ['completed'], consumed: 1, unconfirmed: 0 });
    const [operation] =
      await db.admin`select disposition ->> 'outcome' as outcome from runtime.tool_operations where run_id = ${runId}`;
    expect(operation.outcome).toBe('ok');
  });

  test('a final answer on the last permitted request completes without a step-limit failure', async () => {
    const { runId, settled } = await accountedRun([finalStep], { budgetMax: 1 });
    expect(settled).toEqual({ kind: 'finished' });
    expect(await attempts(runId)).toMatchObject({ consumed: 1 });
  });

  test('an answer is accepted with no steps left; only the next model request is refused', async () => {
    const { runId, invocationId, sent, settled, agent, invoke } = await accountedRun([askStep()], { budgetMax: 1 });
    const published = await publishSettledQuestion(
      {
        store: life.store,
        gates: life.gates,
        agent,
        saver: life.saver,
        definitionDigest: (await life.store.snapshot(runId)).definitionDigest,
      },
      { runId, invocationId, expectedRevision: (await life.store.snapshot(runId)).revision },
      settled,
    );
    if (published.kind !== 'published') throw new Error(JSON.stringify(published));
    const answered = await life.answer(runId, published.questionId, { answer: false });
    if (answered.kind !== 'accepted') throw new Error(answered.kind);
    const resumed = await invoke(answered.acceptance.invocationId, [echoStep], { kind: 'resume', ...answered.resume });
    expect(refusalOf(resumed.settled)).toBe('admission_refused:step_budget_exhausted');
    const [row] =
      await db.admin`select disposition -> 'answer' as answer from runtime.questions where run_id = ${runId}`;
    expect(row.answer).toBe(false);
    expect(sent).toHaveLength(1);
    expect(await attempts(runId)).toEqual({ states: ['completed'], consumed: 1, unconfirmed: 0 });
  });

  test('an authorization failure before any request consumes no step and sends nothing', async () => {
    const { runId, sent, settled } = await accountedRun([finalStep], {
      credentials: async () => {
        throw new Error('no usable credential');
      },
    });
    expect(refusalOf(settled)).toBe('credential_unavailable:');
    expect(sent).toHaveLength(0);
    expect(await attempts(runId)).toEqual({ states: [], consumed: 0, unconfirmed: 0 });
  });

  test('the one renewal retry is another admitted, counted step, and cannot exceed the budget', async () => {
    const renewal: CredentialRenewal = {
      recoverable: async (response) => response.status === 401,
      renew: async () => {},
    };
    const respond = (count: number) =>
      count === 1 ? new Response('{}', { status: 401 }) : new Response('{"ok":true}');
    const roomy = await accountedRun([finalStep], { renewal, respond });
    expect(roomy.settled).toEqual({ kind: 'finished' });
    expect(roomy.sent).toHaveLength(2);
    expect(await attempts(roomy.runId)).toEqual({ states: ['completed', 'completed'], consumed: 2, unconfirmed: 0 });

    const tight = await accountedRun([finalStep], { renewal, respond, budgetMax: 1 });
    expect(refusalOf(tight.settled)).toBe('admission_refused:step_budget_exhausted');
    expect(tight.sent).toHaveLength(1);
  });

  test('a request whose sending cannot be confirmed stays charged as unconfirmed', async () => {
    const { runId, settled } = await accountedRun([finalStep], {
      respond: () => {
        throw new TypeError('connection reset');
      },
    });
    expect(refusalOf(settled)).toBe('provider_unreachable:');
    expect(await attempts(runId)).toEqual({ states: ['unconfirmed'], consumed: 0, unconfirmed: 1 });
  });

  test('nothing is admitted once the run is cancelling or ownership cannot be verified', async () => {
    const lostOwner = await accountedRun([finalStep], {
      owner: {
        assertHeld: () => {},
        verify: async () => {
          throw new Error('ownership session changed');
        },
      },
    });
    expect(refusalOf(lostOwner.settled)).toBe('admission_refused:ownership_lost');
    expect(lostOwner.sent).toHaveLength(0);

    const { runId, invocationId, sent, invoke } = await accountedRun([finalStep]);
    const snapshot = await life.store.snapshot(runId);
    await life.store.transition({
      runId,
      expectedRevision: snapshot.revision,
      next: { kind: 'cancelling', cancellationId: crypto.randomUUID(), acceptedAt: AT, invocationId },
    });
    const later = await invoke(invocationId, [finalStep], { kind: 'initial', goal: 'More.' });
    expect(refusalOf(later.settled)).toBe('admission_refused:not_dispatchable');
    expect(sent).toHaveLength(1);
  });
});
