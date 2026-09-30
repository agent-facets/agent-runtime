// The durable tool-operation ledger: recorded before and after each call, reused only for the same binding,
// refused once the run no longer permits work, and consistent with the events history.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { exactSecretMatcher } from '../../packages/runtime/src/credentials/matcher.ts';
import { createExecutionAgent } from '../../packages/runtime/src/execution/agent.ts';
import { InvocationExecutor } from '../../packages/runtime/src/execution/invocation.ts';
import {
  identityFor,
  jsonbTextBytes,
  RECORDED_OUTCOME_MAX_BYTES,
  runOperationLedger,
  ToolCallConflict,
} from '../../packages/runtime/src/execution/operations.ts';
import { READ_TOOL } from '../../packages/runtime/src/execution/tools.ts';
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
fixture.write('notes/plan.md', 'alpha\n');
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

async function newRun() {
  const { snapshot } = await store.createRun({
    requestId: crypto.randomUUID(),
    goal: 'Inspect the repository',
    provider: 'anthropic',
    workspace,
    binding: binding as CreateRunInput['binding'],
    definition: { digest: DIGEST, manifest: { protocolVersion: 1 } },
    budgetMax: 10,
  });
  if (snapshot.state.kind !== 'working') throw new Error('expected a working run');
  const gates = new KeyedSerializer();
  const ledger = runOperationLedger({ store, gates, runId: snapshot.runId, invocationId: snapshot.state.invocationId });
  return { runId: snapshot.runId, invocationId: snapshot.state.invocationId, revision: snapshot.revision, ledger };
}

const read = (id: string, path = 'notes/plan.md') => ({ id, name: READ_TOOL, args: { mode: 'file', path } });
const ok = { outcome: 'ok' as const, result: { lines: [{ line: 1, text: 'alpha' }] } };

async function toolEvents(runId: string) {
  return (await store.readEvents(runId, { after: '0', limit: 100 }))
    .filter((event) => event.event.kind === 'tool.operation')
    .map((event) => [event.seq, (event.event.payload as { disposition: { kind: string } }).disposition.kind]);
}

describe('the durable tool ledger', () => {
  test('a call is recorded before and after it runs, and its completed record is reused', async () => {
    const { runId, ledger } = await newRun();
    const identity = identityFor(runId, 'm1', read('c1'));
    if (identity === undefined) throw new Error('identity');
    expect(await ledger.start(identity)).toEqual({ kind: 'execute' });
    await ledger.complete(identity, ok);
    await ledger.complete(identity, ok);
    expect(await ledger.start(identity)).toEqual({ kind: 'reuse', outcome: ok });
    expect(await toolEvents(runId)).toEqual([
      ['3', 'started'],
      ['4', 'completed'],
    ]);
    const [row] =
      await db.admin`select disposition ->> 'kind' as kind from runtime.tool_operations where run_id = ${runId}`;
    expect(row.kind).toBe('completed');
    await expect(ledger.complete(identity, { outcome: 'error', code: 'x', message: 'x' })).rejects.toMatchObject({
      code: 'invariant_violation',
    });
  });

  test('a provider call ID bound to different arguments or another message is a conflict', async () => {
    const { runId, ledger } = await newRun();
    const first = identityFor(runId, 'm1', read('c1'));
    const otherArgs = identityFor(runId, 'm1', read('c1', 'notes'));
    const otherMessage = identityFor(runId, 'm2', read('c1'));
    if (first === undefined || otherArgs === undefined || otherMessage === undefined) throw new Error('identity');
    await ledger.start(first);
    await expect(ledger.start(otherArgs)).rejects.toBeInstanceOf(ToolCallConflict);
    await expect(ledger.start(otherMessage)).rejects.toBeInstanceOf(ToolCallConflict);
    const [row] = await db.admin`select count(*)::int as n from runtime.tool_operations where run_id = ${runId}`;
    expect(row.n).toBe(1);
  });

  test('after cancellation nothing new starts, while in-flight work can still record its outcome', async () => {
    const { runId, invocationId, revision, ledger } = await newRun();
    const inFlight = identityFor(runId, 'm1', read('c1'));
    const later = identityFor(runId, 'm1', read('c2'));
    if (inFlight === undefined || later === undefined) throw new Error('identity');
    await ledger.start(inFlight);
    await store.transition({
      runId,
      expectedRevision: revision,
      next: { kind: 'cancelling', cancellationId: crypto.randomUUID(), acceptedAt: AT, invocationId },
    });
    expect(await ledger.start(later)).toEqual({ kind: 'not_dispatchable' });
    await ledger.complete(inFlight, ok);
    expect(await toolEvents(runId)).toEqual([
      ['3', 'started'],
      ['5', 'completed'],
    ]);
  });

  test('a ledger for another invocation cannot start work', async () => {
    const { runId } = await newRun();
    const stale = runOperationLedger({ store, gates: new KeyedSerializer(), runId, invocationId: crypto.randomUUID() });
    const identity = identityFor(runId, 'm1', read('c1'));
    if (identity === undefined) throw new Error('identity');
    expect(await stale.start(identity)).toEqual({ kind: 'not_dispatchable' });
  });

  test('the stored-form estimate is an upper bound, and an outcome at the bound is accepted', async () => {
    const { runId, ledger } = await newRun();
    const identity = identityFor(runId, 'm1', read('c1'));
    if (identity === undefined) throw new Error('identity');
    // Many small members maximize PostgreSQL's added separators; grow until just under the bound.
    const entries: { n: number; k: string; e: string }[] = [];
    let outcome = { outcome: 'ok' as const, result: { entries } };
    while (
      jsonbTextBytes({ outcome: 'ok', result: { entries: [...entries, { n: 0, k: 'd', e: 'é"\\' }] } }) <=
      RECORDED_OUTCOME_MAX_BYTES
    ) {
      entries.push({ n: entries.length, k: 'd', e: 'é"\\' });
    }
    outcome = { outcome: 'ok', result: { entries } };
    await ledger.start(identity);
    await ledger.complete(identity, outcome);
    const [row] = await db.admin`
      select octet_length((disposition -> 'result')::text) as bytes from runtime.tool_operations where run_id = ${runId}`;
    expect(Number(row.bytes)).toBeLessThanOrEqual(jsonbTextBytes(outcome));
  });

  test('an agent run records each tool call and its outcome in history order', async () => {
    const { runId, invocationId } = await newRun();
    const gates = new KeyedSerializer();
    const model = new ScriptedModel([
      () =>
        new AIMessage({
          id: 'm1',
          content: '',
          tool_calls: [
            { ...read('c1'), type: 'tool_call' },
            { id: 'c2', name: 'write_file', args: { path: 'notes/plan.md', content: 'x' }, type: 'tool_call' },
          ],
        }),
      () => new AIMessage({ id: 'm2', content: 'Done.' }),
    ]);
    const agent = createExecutionAgent({
      runId,
      model,
      checkpointer: persistence.checkpoints.saver,
      workspace: fixture.policy(),
      contentPolicy: () => createContentPolicy(exactSecretMatcher([])),
      operations: runOperationLedger({ store, gates, runId, invocationId }),
    });
    const settled = await new InvocationExecutor(new KeyedSerializer()).start({
      runId,
      agent,
      input: { kind: 'initial', goal: 'Read.' },
      budgetMax: 10,
    }).settled;
    expect(settled).toEqual({ kind: 'finished' });
    const rows = await db.admin`
      select tool_name, disposition ->> 'outcome' as outcome, disposition #>> '{result,code}' as code
      from runtime.tool_operations where run_id = ${runId} order by tool_name`;
    expect(rows).toEqual([
      { tool_name: 'mcp_Read', outcome: 'ok', code: null },
      { tool_name: 'write_file', outcome: 'refused', code: 'tool_unavailable' },
    ]);
    const kinds = (await toolEvents(runId)).map(([, kind]) => kind);
    expect(kinds.filter((kind) => kind === 'started')).toHaveLength(2);
    expect(kinds.filter((kind) => kind === 'completed')).toHaveLength(2);
    expect(await Bun.file(`${fixture.root}/notes/plan.md`).text()).toBe('alpha\n');
  });
});
