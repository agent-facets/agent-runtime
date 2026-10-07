// Run-store primitives for command runs and actor-aware records (design Decisions 6 and 8): atomic creation with
// a retained snapshot and root actor, actor-scoped operation replay, run-wide accounting shared by actors,
// attributed history and creation readback. No graph, model or MCP work happens inside these transactions.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { sealSnapshot } from '../../packages/runtime/src/capabilities/records.ts';
import { openPersistence, type Persistence } from '../../packages/runtime/src/persistence/persistence.ts';
import { digestOf } from '../../packages/runtime/src/records/canonical.ts';
import {
  type CreateRunInput,
  RunStore,
  RunStoreError,
  type ToolOperationIdentity,
} from '../../packages/runtime/src/records/run-store.ts';
import { operationIdFor, operationIdV2 } from '../../packages/runtime/src/records/schemas.ts';
import {
  askFromDelegate,
  insertOperation,
  sampleCommandInput,
  sampleSnapshot,
  startDelegate,
} from '../support/capabilities.ts';
import { binding, DIGEST, workspace } from '../support/run-records.ts';
import { createScratchDatabase, type ScratchDatabase } from '../support/scratch-database.ts';

let db: ScratchDatabase;
let persistence: Persistence;
let store: RunStore;
beforeAll(async () => {
  db = await createScratchDatabase();
  persistence = await openPersistence({ url: db.url, onFault: () => {} });
  store = new RunStore(persistence.app, persistence.ownership);
});
afterAll(async () => {
  await persistence.close();
  await db.drop();
});

function commandRequest(
  options: { arguments?: string; snapshot?: Record<string, unknown>; budgetMax?: number; maxDelegations?: number } = {},
): CreateRunInput {
  const args = options.arguments ?? `owner/repo-${crypto.randomUUID().slice(0, 8)}`;
  return {
    requestId: crypto.randomUUID(),
    goal: `Triage ${args}`,
    provider: 'anthropic',
    workspace,
    binding: binding as CreateRunInput['binding'],
    definition: { digest: DIGEST, manifest: { protocolVersion: 1 } },
    budgetMax: options.budgetMax ?? 50,
    capability: {
      input: sampleCommandInput({ arguments: args }),
      snapshot: sampleSnapshot({
        input: { arguments: args, renderedGoal: `Triage ${args}` },
        limits: { maxDelegations: options.maxDelegations ?? 8, delegationDepth: 1 },
        ...options.snapshot,
      }) as never,
    },
  };
}

const cap = (input: CreateRunInput) => input.capability as NonNullable<CreateRunInput['capability']>;

const nativeRequest = (): CreateRunInput => ({
  requestId: crypto.randomUUID(),
  goal: 'Inspect the repository',
  provider: 'anthropic',
  workspace,
  binding: binding as CreateRunInput['binding'],
  definition: { digest: DIGEST, manifest: { protocolVersion: 1 } },
  budgetMax: 50,
});

async function errorCode(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return 'ok';
  } catch (error) {
    return error instanceof RunStoreError ? error.code : error instanceof RangeError ? 'range' : `unexpected: ${error}`;
  }
}

function identity(
  runId: string,
  actorKey: string | undefined,
  callId: string,
  extra: Partial<ToolOperationIdentity> = {},
) {
  const modelMessageId = `message-${callId}`;
  return {
    operationId:
      actorKey === undefined
        ? operationIdFor(runId, modelMessageId, callId)
        : operationIdV2(runId, actorKey, modelMessageId, callId),
    modelMessageId,
    providerToolCallId: callId,
    toolName: 'mcp_Read',
    arguments: { path: 'README.md' },
    argumentDigest: digestOf({ path: 'README.md' }),
    ...(actorKey === undefined
      ? {}
      : {
          actor:
            actorKey === 'root'
              ? { kind: 'root' as const }
              : { kind: 'delegate' as const, delegationId: actorKey, agentId: 'agent:helper' },
          binding: { kind: 'native' as const, name: 'mcp_Read' as const },
        }),
    ...extra,
  } satisfies ToolOperationIdentity;
}

const working = (snapshot: { state: { kind: string; invocationId?: string } }) =>
  (snapshot.state as { invocationId: string }).invocationId;

async function seedDelegate(runId: string, callId: string): Promise<string> {
  let delegationId = '';
  await db.admin.begin(async (tx) => {
    const [row] = await tx`select state ->> 'invocationId' as invocation from runtime.runs where run_id = ${runId}`;
    delegationId = await startDelegate(tx, { runId, invocationId: row.invocation, epoch: '1' }, callId);
  });
  return delegationId;
}

describe('command run creation', () => {
  test('binds input, retained snapshot, root actor, invocation and selection history in one commit', async () => {
    const input = commandRequest();
    const { created, snapshot } = await store.createRun(input);
    expect(created).toBe(true);
    const sealed = sealSnapshot(input.capability?.snapshot);
    expect(snapshot.command).toEqual({
      commandId: 'command:triage',
      selectionRevision: DIGEST,
      arguments: cap(input).input.arguments,
      snapshotDigest: sealed.digest,
    });
    expect(snapshot.goal).toBe(input.goal);
    const events = await store.readEvents(snapshot.runId, { after: '0', limit: 10 });
    expect(events.map((event) => event.event.kind)).toEqual(['run.created', 'run.command', 'run.status']);
    const capabilities = await store.readCapabilities(snapshot.runId);
    expect(capabilities?.snapshotDigest).toBe(sealed.digest);
    expect(capabilities?.snapshot).toEqual(sealed.payload);
    expect(capabilities?.maxDelegations).toBe(8);
    const actors = await db.admin`select actor_key from runtime.run_actors where run_id = ${snapshot.runId}`;
    expect(actors).toEqual([{ actor_key: 'root' }]);
  });

  test('a native run has no binding and its history keeps the phase-1 shape', async () => {
    const { snapshot } = await store.createRun(nativeRequest());
    expect(snapshot.command).toBeUndefined();
    expect(await store.readCapabilities(snapshot.runId)).toBeUndefined();
    const events = await store.readEvents(snapshot.runId, { after: '0', limit: 10 });
    expect(events.map((event) => event.event.kind)).toEqual(['run.created', 'run.status']);
  });

  test('a retry returns the original run and definitions even after the installation changed', async () => {
    const input = commandRequest();
    const original = await store.createRun(input);
    const updated = sampleSnapshot({
      input: (input.capability?.snapshot as { input: unknown }).input,
      installation: { sha256: 'c'.repeat(64) },
    });
    const retry = await store.createRun({
      ...input,
      capability: { input: cap(input).input, snapshot: updated as never },
    });
    expect(retry.created).toBe(false);
    expect(retry.snapshot.runId).toBe(original.snapshot.runId);
    expect(retry.snapshot.command?.snapshotDigest).toBe(original.snapshot.command?.snapshotDigest as string);
    const different = { ...cap(input).input, arguments: 'owner/other' };
    expect(
      await errorCode(
        store.createRun({
          ...input,
          goal: 'Triage owner/other',
          capability: {
            input: different,
            snapshot: sampleSnapshot({
              input: { arguments: 'owner/other', renderedGoal: 'Triage owner/other' },
            }) as never,
          },
        }),
      ),
    ).toBe('request_conflict');
  });

  test('concurrent submissions create one run and one retained snapshot', async () => {
    const input = commandRequest();
    const results = await Promise.all(Array.from({ length: 8 }, () => store.createRun(input)));
    expect(results.filter((result) => result.created)).toHaveLength(1);
    const digest = sealSnapshot(input.capability?.snapshot).digest;
    const [row] = await db.admin`select
        (select count(*) from runtime.runs where create_request_id = ${input.requestId})::int as runs,
        (select count(*) from runtime.capability_snapshots where digest = ${digest})::int as snapshots`;
    expect(row).toEqual({ runs: 1, snapshots: 1 });
  });

  test('identical retained definitions are stored once and shared', async () => {
    const args = 'owner/shared';
    const [a, b] = [commandRequest({ arguments: args }), commandRequest({ arguments: args })];
    const [first, second] = [await store.createRun(a), await store.createRun(b)];
    expect(first.snapshot.runId).not.toBe(second.snapshot.runId);
    expect(first.snapshot.command?.snapshotDigest).toBe(second.snapshot.command?.snapshotDigest as string);
  });

  test('a failed creation leaves neither a run, a binding nor its snapshot', async () => {
    const input = commandRequest({ budgetMax: 0 });
    await expect(store.createRun(input)).rejects.toThrow();
    const digest = sealSnapshot(input.capability?.snapshot).digest;
    const [row] = await db.admin`select
        (select count(*) from runtime.runs where create_request_id = ${input.requestId})::int as runs,
        (select count(*) from runtime.capability_snapshots where digest = ${digest})::int as snapshots`;
    expect(row).toEqual({ runs: 0, snapshots: 0 });
  });

  test('refuses a snapshot that does not describe the submission, before writing anything', async () => {
    const input = commandRequest();
    for (const changed of [
      { ...input, goal: 'Something else' },
      {
        ...input,
        capability: { ...cap(input), input: { ...cap(input).input, commandId: 'command:other' } },
      },
      {
        ...input,
        capability: { ...cap(input), input: { ...cap(input).input, provider: 'openai' as const } },
      },
      {
        ...input,
        capability: { ...cap(input), snapshot: { ...cap(input).snapshot, extra: 1 } as never },
      },
    ]) {
      await expect(store.createRun(changed)).rejects.toThrow();
    }
    expect(await store.findCreation(input.requestId)).toBeUndefined();
  });

  test('an ambiguous creation commit is established by readback of the complete binding', async () => {
    const input = commandRequest();
    const outcome = await store.withCommitCertainty(
      async () => {
        await store.createRun(input);
        throw Object.assign(new Error('Connection closed'), { code: 'ERR_POSTGRES_CONNECTION_CLOSED' });
      },
      async () => {
        const found = await store.findCreation(input.requestId);
        return found === undefined ? undefined : store.snapshot(found.runId);
      },
    );
    expect(outcome.committed).toBe(true);
    const snapshot = outcome.committed ? outcome.value : undefined;
    expect(snapshot?.command?.snapshotDigest).toBe(sealSnapshot(input.capability?.snapshot).digest);
    expect((await store.readCapabilities(snapshot?.runId as string))?.snapshot.command.id).toBe('command:triage');
  });

  test('a corrupted retained snapshot is refused when read', async () => {
    const { snapshot } = await store.createRun(commandRequest());
    const digest = snapshot.command?.snapshotDigest as string;
    await db.admin.unsafe('alter table runtime.capability_snapshots disable trigger capability_snapshots_immutable');
    try {
      await db.admin`update runtime.capability_snapshots set payload = jsonb_set(payload, '{input,arguments}', '"changed"')
        where digest = ${digest}`;
    } finally {
      await db.admin.unsafe('alter table runtime.capability_snapshots enable trigger capability_snapshots_immutable');
    }
    await expect(store.readCapabilities(snapshot.runId)).rejects.toThrow('does not match');
  });
});

describe('actor-scoped operations', () => {
  test('root and delegate calls with the same provider call ID are distinct operations', async () => {
    const { snapshot } = await store.createRun(commandRequest());
    const delegate = await seedDelegate(snapshot.runId, 'call-d');
    const invocation = working(snapshot);
    expect(
      await store.startToolOperation(snapshot.runId, invocation, identity(snapshot.runId, 'root', 'call-1')),
    ).toEqual({
      kind: 'execute',
    });
    expect(
      await store.startToolOperation(snapshot.runId, invocation, identity(snapshot.runId, delegate, 'call-1')),
    ).toEqual({
      kind: 'execute',
    });
    const outcome = { outcome: 'ok' as const, result: { text: 'hello' } };
    await store.completeToolOperation(snapshot.runId, identity(snapshot.runId, delegate, 'call-1'), outcome);
    expect(
      await store.startToolOperation(snapshot.runId, invocation, identity(snapshot.runId, delegate, 'call-1')),
    ).toEqual({
      kind: 'reuse',
      outcome,
    });
    // A genuinely new call with the same arguments is new work.
    expect(
      await store.startToolOperation(snapshot.runId, invocation, identity(snapshot.runId, delegate, 'call-2')),
    ).toEqual({
      kind: 'execute',
    });
  });

  test('a rebinding of the same call is a conflict, never a cache hit', async () => {
    const { snapshot } = await store.createRun(commandRequest());
    const invocation = working(snapshot);
    const base = identity(snapshot.runId, 'root', 'call-1');
    await store.startToolOperation(snapshot.runId, invocation, base);
    await store.completeToolOperation(snapshot.runId, base, { outcome: 'ok', result: {} });
    for (const changed of [
      { ...base, argumentDigest: digestOf({ path: 'other' }) },
      { ...base, toolName: 'mcp_Search' },
      { ...base, binding: { kind: 'native' as const, name: 'mcp_Search' as const } },
    ]) {
      expect(await errorCode(store.startToolOperation(snapshot.runId, invocation, changed))).toBe('tool_call_conflict');
    }
    const wrongIdentity = { ...base, operationId: operationIdFor(snapshot.runId, base.modelMessageId, 'call-1') };
    expect(await errorCode(store.startToolOperation(snapshot.runId, invocation, wrongIdentity))).toBe('range');
  });

  test('a delegate that is not running cannot start work', async () => {
    const { snapshot } = await store.createRun(commandRequest());
    const delegate = await seedDelegate(snapshot.runId, 'call-d');
    await db.admin`update runtime.run_actors set state = ${JSON.stringify({ kind: 'completed', outcome: { kind: 'result', text: 'x' } })}::text::jsonb
      where run_id = ${snapshot.runId} and actor_key = ${delegate}`;
    expect(
      await store.startToolOperation(snapshot.runId, working(snapshot), identity(snapshot.runId, delegate, 'call-1')),
    ).toEqual({ kind: 'not_dispatchable' });
    const actor = { kind: 'delegate' as const, delegationId: delegate, agentId: 'agent:helper' };
    expect(await errorCode(store.reserveAttempt(snapshot.runId, working(snapshot), actor))).toBe('not_dispatchable');
  });

  test('command-run history names the acting agent; native history keeps its phase-1 shape', async () => {
    const { snapshot } = await store.createRun(commandRequest());
    const delegate = await seedDelegate(snapshot.runId, 'call-d');
    const invocation = working(snapshot);
    await store.startToolOperation(snapshot.runId, invocation, identity(snapshot.runId, 'root', 'call-r'));
    await store.startToolOperation(snapshot.runId, invocation, identity(snapshot.runId, delegate, 'call-x'));
    const tools = (await store.readEvents(snapshot.runId, { after: '0', limit: 50 })).flatMap((stored) =>
      stored.event.kind === 'tool.operation' ? [stored.event.payload] : [],
    );
    expect(tools.map((payload) => [payload.actor, payload.binding])).toEqual([
      [{ kind: 'root' }, { kind: 'native', name: 'mcp_Read' }],
      [
        { kind: 'delegate', delegationId: delegate, agentId: 'agent:helper' },
        { kind: 'native', name: 'mcp_Read' },
      ],
    ]);

    const native = (await store.createRun(nativeRequest())).snapshot;
    await store.startToolOperation(native.runId, working(native), identity(native.runId, undefined, 'call-n'));
    const [attempt] = [await store.reserveAttempt(native.runId, working(native))];
    expect(attempt.ordinal).toBe(1);
    const nativeEvents = await store.readEvents(native.runId, { after: '2', limit: 10 });
    for (const stored of nativeEvents) expect(Object.hasOwn(stored.event.payload, 'actor')).toBe(false);
  });
});

describe('shared run accounting', () => {
  test('root and delegate attempts share one ordinal sequence and one budget', async () => {
    const { snapshot } = await store.createRun(commandRequest({ budgetMax: 3 }));
    const delegate = await seedDelegate(snapshot.runId, 'call-d');
    const invocation = working(snapshot);
    const delegateActor = { kind: 'delegate' as const, delegationId: delegate, agentId: 'agent:helper' };
    const first = await store.reserveAttempt(snapshot.runId, invocation);
    const second = await store.reserveAttempt(snapshot.runId, invocation, delegateActor);
    await store.settleAttempt(snapshot.runId, second.attemptId, { kind: 'dispatched' });
    const third = await store.reserveAttempt(snapshot.runId, invocation, delegateActor);
    expect([first.ordinal, second.ordinal, third.ordinal]).toEqual([1, 2, 3]);
    expect(await errorCode(store.reserveAttempt(snapshot.runId, invocation, delegateActor))).toBe('budget_exhausted');
    expect(await errorCode(store.reserveAttempt(snapshot.runId, invocation))).toBe('budget_exhausted');
    expect((await store.snapshot(snapshot.runId)).budget).toEqual({ maximum: 3, consumed: 1, unconfirmed: 2 });

    const attempts = (await store.readEvents(snapshot.runId, { after: '0', limit: 50 })).flatMap((stored) =>
      stored.event.kind === 'model.attempt' ? [[stored.event.payload.ordinal, stored.event.payload.actor?.kind]] : [],
    );
    expect(attempts).toEqual([
      [1, 'root'],
      [2, 'delegate'],
      [2, 'delegate'],
      [3, 'delegate'],
    ]);
    const rows = await db.admin`select ordinal, actor_key from runtime.model_attempts where run_id = ${snapshot.runId}
      order by ordinal`;
    expect(rows.map((row: { actor_key: string }) => row.actor_key)).toEqual(['root', delegate, delegate]);
  });
});

describe('versioned question publication', () => {
  async function ask(runId: string, invocationId: string, revision: string, versioned: boolean) {
    const ask = identity(runId, versioned ? 'root' : undefined, 'ask', {
      toolName: 'mcp_AskUser',
      ...(versioned ? { binding: { kind: 'native' as const, name: 'mcp_AskUser' as const } } : {}),
    });
    await store.startToolOperation(runId, invocationId, ask);
    const leaf = {
      threadId: runId,
      checkpointNs: '',
      checkpointId: 'checkpoint-1',
      taskId: 'task-1',
      interruptId: 'interrupt-1',
      operationId: ask.operationId,
      payloadDigest: DIGEST,
      requiredStateDigest: DIGEST,
      definitionDigest: DIGEST,
    };
    const snapshot = await store.snapshot(runId);
    await store.publishQuestion({
      runId,
      expectedRevision: snapshot.revision,
      invocationId,
      questionId: ask.operationId,
      prompt: 'Proceed?',
      input: { kind: 'choice', multiple: false, options: [{ label: 'No', value: false }] },
      binding: versioned ? { version: 2, actor: 'root', ...leaf } : { ...leaf, ordinal: 0 },
    });
    void revision;
    return store.snapshot(runId);
  }

  test('a version-2 root question names its asker; a phase-1 question does not', async () => {
    const command = (await store.createRun(commandRequest())).snapshot;
    const waiting = await ask(command.runId, working(command), command.revision, true);
    expect(waiting.pendingQuestion?.asker).toEqual({ kind: 'root' });
    const asked = (await store.readEvents(command.runId, { after: '0', limit: 50 })).find(
      (stored) => stored.event.kind === 'question.asked',
    );
    expect(asked?.event.kind === 'question.asked' && asked.event.payload.actor).toEqual({ kind: 'root' });

    const native = (await store.createRun(nativeRequest())).snapshot;
    const legacy = await ask(native.runId, working(native), native.revision, false);
    expect(legacy.pendingQuestion).toBeDefined();
    expect(Object.hasOwn(legacy.pendingQuestion as object, 'asker')).toBe(false);
  });
});

describe('settling delegates and external intent', () => {
  const mcp = { kind: 'mcp', serverId: 'github', toolName: 'list_issues', definitionDigest: DIGEST };
  const counts = async (runId: string) => {
    const [row] = await db.admin`select
        (select count(*) from runtime.model_attempts where run_id = ${runId})::int as attempts,
        (select count(*) from runtime.tool_operations where run_id = ${runId})::int as operations,
        (select count(*) from runtime.invocations where run_id = ${runId})::int as invocations`;
    return row;
  };
  const actorStates = async (runId: string) =>
    Object.fromEntries(
      (
        await db.admin`select actor_key, state::text as state from runtime.run_actors where run_id = ${runId} and kind = 'delegate'`
      ).map((row: { actor_key: string; state: string }) => [row.actor_key, JSON.parse(row.state)]),
    );
  const disposition = async (runId: string, operationId: string) => {
    const [row] = await db.admin`select disposition::text as d from runtime.tool_operations
      where run_id = ${runId} and operation_id = ${operationId}`;
    return JSON.parse(row.d);
  };

  /** A working command run with an active delegate, one completed and one dispatched external call. */
  async function interruptedShape() {
    const { snapshot } = await store.createRun(commandRequest());
    const delegate = await seedDelegate(snapshot.runId, 'call-d');
    let completed = '';
    let dispatched = '';
    await db.admin.begin(async (tx) => {
      completed = await insertOperation(tx, snapshot.runId, {
        actorKey: delegate,
        callId: 'done',
        binding: mcp,
        disposition: { kind: 'started' },
      });
      await tx`update runtime.tool_operations set disposition = ${JSON.stringify({ kind: 'completed', outcome: 'ok', result: { outcome: 'ok', result: { n: 1 } } })}::text::jsonb
        where run_id = ${snapshot.runId} and operation_id = ${completed}`;
      dispatched = await insertOperation(tx, snapshot.runId, { actorKey: delegate, callId: 'sent', binding: mcp });
      await tx`update runtime.tool_operations set disposition = ${JSON.stringify({ kind: 'dispatching' })}::text::jsonb
        where run_id = ${snapshot.runId} and operation_id = ${dispatched}`;
    });
    return { runId: snapshot.runId, delegate, completed, dispatched };
  }

  test('restart interrupts active delegates, records unknown external effects and dispatches nothing', async () => {
    const shape = await interruptedShape();
    const before = await counts(shape.runId);
    const completedBefore = await disposition(shape.runId, shape.completed);
    await store.reconcileAfterRestart();

    const snapshot = await store.snapshot(shape.runId);
    expect(snapshot.state.kind).toBe('interrupted');
    expect(await counts(shape.runId)).toEqual(before);
    expect(await actorStates(shape.runId)).toEqual({ [shape.delegate]: { kind: 'abandoned', reason: 'interrupted' } });
    expect(await disposition(shape.runId, shape.completed)).toEqual(completedBefore);
    expect(await disposition(shape.runId, shape.dispatched)).toMatchObject({
      kind: 'completed',
      outcome: 'uncertain',
      result: { outcome: 'uncertain', code: 'mcp_outcome_unknown' },
    });
    expect(await disposition(shape.runId, shape.delegate)).toEqual({ kind: 'abandoned', reason: 'interrupted' });
    const history = await store.readEvents(shape.runId, { after: '0', limit: 50 });
    const tail = history.slice(-3).map((stored) => stored.event);
    expect(tail[0]).toMatchObject({
      kind: 'tool.operation',
      payload: { operationId: shape.dispatched, disposition: { outcome: 'uncertain' }, binding: mcp },
    });
    expect(tail[1]).toEqual({
      kind: 'delegation.finished',
      payload: { delegationId: shape.delegate, outcome: 'abandoned', operationId: shape.delegate },
    });
    expect(tail[2]?.kind).toBe('run.status');

    // A second restart changes nothing more.
    await store.reconcileAfterRestart();
    expect((await store.readEvents(shape.runId, { after: '0', limit: 50 })).length).toBe(history.length);
  });

  test('accepted cancellation abandons delegates and records unknown external effects', async () => {
    const shape = await interruptedShape();
    const accepted = await store.acceptCancellation(shape.runId, crypto.randomUUID());
    expect(accepted.state.kind).toBe('cancelling');
    expect((await store.finishCancellation(shape.runId)).kind).toBe('cancelled');
    expect(await actorStates(shape.runId)).toEqual({ [shape.delegate]: { kind: 'abandoned', reason: 'cancelled' } });
    expect((await disposition(shape.runId, shape.dispatched)).outcome).toBe('uncertain');
  });

  test('cancelling a run waiting on a delegated question abandons that delegate at once', async () => {
    const { snapshot } = await store.createRun(commandRequest());
    let delegationId = '';
    await db.admin.begin(async (tx) => {
      ({ delegationId } = await askFromDelegate(tx, {
        runId: snapshot.runId,
        invocationId: working(snapshot),
        epoch: '1',
      }));
    });
    expect((await store.snapshot(snapshot.runId)).pendingQuestion?.asker).toEqual({
      kind: 'delegate',
      delegationId,
      agentId: 'agent:helper',
    });
    const result = await store.acceptCancellation(snapshot.runId, crypto.randomUUID());
    expect(result.state.kind).toBe('cancelled');
    expect(await actorStates(snapshot.runId)).toEqual({ [delegationId]: { kind: 'abandoned', reason: 'cancelled' } });
  });

  test('restart leaves a run waiting on a delegated question, and finished runs, untouched', async () => {
    const { snapshot } = await store.createRun(commandRequest());
    await db.admin.begin(async (tx) => {
      await askFromDelegate(tx, { runId: snapshot.runId, invocationId: working(snapshot), epoch: '1' });
    });
    const waitingBefore = await store.snapshot(snapshot.runId);
    const actorsBefore = await actorStates(snapshot.runId);
    await store.reconcileAfterRestart();
    expect(await store.snapshot(snapshot.runId)).toEqual(waitingBefore);
    expect(await actorStates(snapshot.runId)).toEqual(actorsBefore);
  });
});
