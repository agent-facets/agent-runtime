// MCP dispatch through the production run service (design Decisions 4, 5 and 8; tasks 12.2–12.6): each new call is
// permitted by the run's ceiling and the owner's current grants, validated against the approved raw schema, and only
// then admitted with durable intent and sent once. Refused calls send nothing; matching calls need no confirmation.
// The bundled synthetic server's witness log counts processes, listings and calls independently.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openPersistence, type Persistence } from '../../packages/runtime/src/persistence/persistence.ts';
import {
  type SentInference,
  sse,
  textTurn,
  toolsTurn,
  toolTurn,
  YES_NO_QUESTION,
} from '../support/anthropic-network.ts';
import { mcpService, SLOT_VALUE, wire } from '../support/mcp-service.ts';
import { functionCallTurn, responsesStream, textTurn as responsesText } from '../support/openai-network.ts';
import { createScratchDatabase, eventually, type ScratchDatabase } from '../support/scratch-database.ts';

type Provider = 'anthropic' | 'openai';
const PROVIDERS: readonly Provider[] = ['anthropic', 'openai'];
/** One scripted model turn calling `name`, in the provider's own stream format. */
const callTurn = (provider: Provider, id: string, name: string, input: unknown) =>
  provider === 'anthropic'
    ? sse(toolTurn(`msg_${id}`, `toolu_${id}`, name, input))
    : responsesStream(functionCallTurn(`resp_${id}`, `toolu_${id}`, name, input));
const finalTurn = (provider: Provider, text: string) =>
  provider === 'anthropic'
    ? sse(textTurn(`msg_${crypto.randomUUID()}`, text))
    : responsesStream(responsesText(`resp_${crypto.randomUUID()}`, text));

// Each case starts real server processes and waits for them to close.
setDefaultTimeout(30_000);

let db: ScratchDatabase;
let persistence: Persistence;
const scratch = mkdtempSync(join(tmpdir(), 'agent-runtime-mcp-dispatch-'));
beforeAll(async () => {
  db = await createScratchDatabase();
  persistence = await openPersistence({ url: db.url, onFault: () => {} });
});
afterAll(async () => {
  await persistence.close();
  await db.drop();
  rmSync(scratch, { recursive: true, force: true });
});

/** A call to the synthetic server's tool, under whatever name the request offered it. */
const call = (provider: Provider, id: string, tool: string, input: unknown) => (request: SentInference) =>
  callTurn(provider, id, wire(request, tool), input);
/** A call under a name the request never offered. */
const unoffered = (provider: Provider, id: string, name: string, input: unknown) => () =>
  callTurn(provider, id, name, input);
const done =
  (provider: Provider, text = 'Done.') =>
  () =>
    finalTurn(provider, text);

async function operations(runId: string) {
  return (await db.admin`select provider_tool_call_id as call, tool_name as name, disposition ->> 'kind' as kind,
      disposition ->> 'outcome' as outcome, disposition #>> '{result,code}' as code, disposition -> 'result' as result
    from runtime.tool_operations where run_id = ${runId} order by created_at, operation_id`) as {
    call: string;
    name: string;
    kind: string;
    outcome: string | null;
    code: string | null;
    result: Record<string, unknown> | null;
  }[];
}
async function dispositions(runId: string, call: string) {
  const rows = (await db.admin`select e.payload #>> '{disposition,kind}' as kind from runtime.events e
    join runtime.tool_operations o on o.run_id = e.run_id and o.operation_id = e.payload ->> 'operationId'
    where e.run_id = ${runId} and e.kind = 'tool.operation' and o.provider_tool_call_id = ${call}
    order by e.seq`) as { kind: string }[];
  return rows.map((row) => row.kind);
}
const runIdOf = (result: { body: unknown }) => (result.body as { run: { runId: string } }).run.runId;

describe('admitting MCP calls', () => {
  for (const provider of PROVIDERS) {
    test(`${provider}: a matching call is sent once without confirmation; refused calls send nothing`, async () => {
      const h = await mcpService({
        scratch,
        persistence,
        provider,
        grants: [{ name: 'list_items', argumentEquals: { repository: 'owner/repo-a' } }],
        replies: [
          call(provider, '1', 'list_items', { repository: 'owner/repo-a' }),
          call(provider, '2', 'list_items', { repository: 'owner/repo-b' }),
          call(provider, '3', 'list_items', { repository: 'owner/repo-a', extra: true }),
          unoffered(provider, '4', 'mcp_synthetic_fail', {}),
          done(provider),
        ],
      });
      const started = await h.start('owner/repo-a');
      expect(started.status).toBe(202);
      const runId = runIdOf(started);
      await h.service.settled();
      expect((await h.service.store.snapshot(runId)).state.kind).toBe('succeeded');
      expect(h.net.sent).toHaveLength(5);

      // One process for preflight, one for the invocation; one listing each; exactly one call, which the server
      // received under its own tool name.
      expect(h.witness()).toEqual({ spawns: 2, lists: 2, calls: ['list_items'] });
      const ops = await operations(runId);
      expect(ops.map((op) => [op.call, op.outcome, op.code])).toEqual([
        ['toolu_1', 'ok', null],
        ['toolu_2', 'refused', 'argument_out_of_scope'],
        ['toolu_3', 'refused', expect.stringMatching(/^(invalid_argument|arguments_invalid)$/)],
        ['toolu_4', 'refused', 'tool_unavailable'],
      ]);
      expect(ops[0]?.result).toEqual({
        outcome: 'ok',
        result: { text: '2 items in owner/repo-a', json: { count: 2 } },
      });
      // Intent was recorded before the call was sent; refused calls never reached dispatch.
      expect(await dispositions(runId, 'toolu_1')).toEqual(['started', 'dispatching', 'completed']);
      expect(await dispositions(runId, 'toolu_2')).toEqual(['started', 'completed']);
      // No generic confirmation: the run asked nothing.
      expect(await db.admin`select 1 from runtime.questions where run_id = ${runId}`).toHaveLength(0);

      // The model saw the provider's wire name; the run recorded the canonical one.
      const offered = wire(h.net.sent[0] as SentInference, 'list_items');
      expect(offered).toMatch(provider === 'anthropic' ? /^mcp_Alias_\d+$/ : /^mcp_synthetic_list_items$/);
      expect(ops.slice(0, 3).map((op) => op.name)).toEqual(Array(3).fill('mcp_synthetic_list_items'));
      const history = await db.admin`select string_agg(payload::text, '') as text from runtime.events
        where run_id = ${runId}`;
      expect(String(history[0]?.text)).not.toContain('mcp_Alias_');

      // The server's credential reached only the server.
      const stored =
        await db.admin`select (select string_agg(payload::text, '') from runtime.events where run_id = ${runId})
        || (select string_agg(disposition::text, '') from runtime.tool_operations where run_id = ${runId}) as text`;
      expect(String(stored[0]?.text)).not.toContain(SLOT_VALUE);
      expect(JSON.stringify(h.net.sent)).not.toContain(SLOT_VALUE);
    });
  }
});

/** Whether a process is still running. */
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
async function runFailure(runId: string) {
  const [row] = await db.admin`select state from runtime.runs where run_id = ${runId}`;
  return row.state as { kind: string; failure?: { category: string; reason: string } };
}

describe('initiating MCP calls under cancellation', () => {
  test('cancelling during a call aborts it as uncertain, ends its server process and continues nothing', async () => {
    const h = await mcpService({
      scratch,
      persistence,
      grants: [{ name: 'list_items' }, { name: 'slow' }],
      replies: [(request) => sse(toolTurn('msg_1', 'toolu_1', wire(request, 'slow'), { ms: 20_000 }))],
    });
    const runId = runIdOf(await h.start('owner/repo-a'));
    await eventually(() => h.witness().calls.includes('slow'), 10_000, 'slow call');
    const pid = Number(h.spawns().at(-1));
    expect((await h.service.cancel(runId, crypto.randomUUID())).status).toBe(202);
    await h.service.settled();

    expect((await h.service.store.snapshot(runId)).state.kind).toBe('cancelled');
    // Nothing after the call: no further model request, no other call, no late success.
    expect(h.net.sent).toHaveLength(1);
    expect(h.witness().calls).toEqual(['slow']);
    const [op] = await operations(runId);
    expect([op?.outcome, op?.code]).toEqual(['uncertain', 'mcp_call_cancelled']);
    // The invocation's server process was closed, best effort, before the run settled.
    await eventually(() => !alive(pid), 10_000, 'server exit');
  });

  test('a call not yet sent when cancellation is accepted is never sent', async () => {
    const h = await mcpService({
      scratch,
      persistence,
      grants: [{ name: 'list_items', argumentEquals: { repository: 'owner/repo-a' } }, { name: 'slow' }],
      replies: [
        (request) =>
          sse(
            toolsTurn('msg_1', [
              ['toolu_a', wire(request, 'slow'), { ms: 20_000 }],
              ['toolu_b', wire(request, 'list_items'), { repository: 'owner/repo-a' }],
            ]),
          ),
      ],
    });
    const runId = runIdOf(await h.start('owner/repo-a'));
    await eventually(() => h.witness().calls.includes('slow'), 10_000, 'slow call');
    expect((await h.service.cancel(runId, crypto.randomUUID())).status).toBe(202);
    await h.service.settled();
    expect((await h.service.store.snapshot(runId)).state.kind).toBe('cancelled');
    // Calls on one connection are made one at a time; the second was refused admission after cancellation.
    expect(h.witness().calls).toEqual(['slow']);
    expect(await dispositions(runId, 'toolu_b')).not.toContain('dispatching');
    expect(h.net.sent).toHaveLength(1);
  });

  test('a call past its deadline is uncertain and ends the run with no further model turn', async () => {
    const h = await mcpService({
      scratch,
      persistence,
      toolTimeoutSeconds: 1,
      grants: [{ name: 'list_items' }, { name: 'slow' }],
      replies: [(request) => sse(toolTurn('msg_1', 'toolu_1', wire(request, 'slow'), { ms: 5_000 }))],
    });
    const runId = runIdOf(await h.start('owner/repo-a'));
    await h.service.settled();
    expect(await runFailure(runId)).toMatchObject({
      kind: 'failed',
      failure: { category: 'tool_failure', reason: 'mcp_outcome_unknown' },
    });
    const [op] = await operations(runId);
    expect([op?.outcome, op?.code]).toEqual(['uncertain', 'mcp_call_timeout']);
    expect(h.net.sent).toHaveLength(1);
    expect(h.witness().calls).toEqual(['slow']);
  });

  test('a server that exits mid-call leaves the outcome unknown; nothing is retried or reconnected', async () => {
    const h = await mcpService({
      scratch,
      persistence,
      grants: [{ name: 'list_items' }, { name: 'crash' }],
      replies: [(request) => sse(toolTurn('msg_1', 'toolu_1', wire(request, 'crash'), {}))],
    });
    const runId = runIdOf(await h.start('owner/repo-a'));
    await h.service.settled();
    expect(await runFailure(runId)).toMatchObject({
      kind: 'failed',
      failure: { category: 'tool_failure', reason: 'mcp_outcome_unknown' },
    });
    const [op] = await operations(runId);
    expect([op?.outcome, op?.code]).toEqual(['uncertain', 'mcp_outcome_unknown']);
    // Progress stays inspectable: the intent and its unknown outcome, never a claimed success or a claim of no effect.
    expect(await dispositions(runId, 'toolu_1')).toEqual(['started', 'dispatching', 'completed']);
    // One preflight process and one invocation process: the crashed server was not restarted.
    expect(h.witness()).toEqual({ spawns: 2, lists: 2, calls: ['crash'] });
    expect(h.net.sent).toHaveLength(1);
  });
});

describe('invocation-owned MCP connections', () => {
  test('root and delegate share one server process per invocation; it closes at a pause, and its data stays', async () => {
    const h = await mcpService({
      scratch,
      persistence,
      allowAgents: ['agent:worker'],
      grants: [{ name: 'list_items' }, { name: 'remember' }, { name: 'recall' }],
      replies: [
        (request) => sse(toolTurn('msg_r1', 'toolu_r1', wire(request, 'list_items'), { repository: 'owner/repo-a' })),
        () => sse(toolTurn('msg_r2', 'toolu_r2', 'mcp_Delegate', { agent: 'agent:worker', task: 'Note the count.' })),
        (request) => sse(toolTurn('msg_d1', 'toolu_d1', wire(request, 'remember'), { value: 'two' })),
        () => sse(textTurn('msg_d2', 'Noted.')),
        () => sse(toolTurn('msg_r3', 'toolu_r3', 'mcp_AskUser', YES_NO_QUESTION)),
        // After the answer: a new invocation, a new process, the same server data.
        (request) => sse(toolTurn('msg_r4', 'toolu_r4', wire(request, 'recall'), {})),
        () => sse(textTurn('msg_r5', 'Recalled.')),
      ],
    });
    const requestId = crypto.randomUUID();
    const runId = runIdOf(await h.start('owner/repo-a', requestId));
    await h.service.settled();
    const waiting = await h.service.store.snapshot(runId);
    expect(waiting.state.kind).toBe('waiting');
    // Preflight's short-lived process, then one process for every call of the invocation, root's and delegate's.
    expect(h.witness()).toEqual({ spawns: 2, lists: 3, calls: ['list_items', 'remember'] });
    const [, invocation] = h.spawns().map(Number) as [number, number];
    await eventually(() => !alive(invocation), 10_000, 'closed at the pause');

    // A retried creation request returns the run and starts nothing.
    const retried = await h.start('owner/repo-a', requestId);
    expect(runIdOf(retried)).toBe(runId);
    expect(h.witness().spawns).toBe(2);

    const questionId = waiting.pendingQuestion?.questionId as string;
    expect((await h.service.answer(runId, questionId, { answer: true })).status).toBe(202);
    await h.service.settled();
    expect((await h.service.store.snapshot(runId)).state.kind).toBe('succeeded');
    expect(h.witness()).toEqual({ spawns: 3, lists: 4, calls: ['list_items', 'remember', 'recall'] });
    const ops = await operations(runId);
    expect(ops.find((op) => op.call === 'toolu_r4')?.result).toMatchObject({ result: { text: 'two' } });
    await eventually(() => !alive(Number(h.spawns().at(-1))), 10_000, 'closed at settlement');
  });
});

/** How many saved-graph records contain `text`: checkpoints, channel blobs and pending writes. */
async function checkpointsContaining(text: string) {
  const [row] = await db.admin`select
      (select count(*) from checkpoints.checkpoint_blobs where position(convert_to(${text}, 'UTF8') in blob) > 0)
      + (select count(*) from checkpoints.checkpoint_writes where position(convert_to(${text}, 'UTF8') in blob) > 0)
      + (select count(*) from checkpoints.checkpoints where position(${text} in checkpoint::text) > 0) as n`;
  return Number(row.n);
}

describe('recorded MCP outcomes', () => {
  test('identical arguments make new operations; outcomes are stored canonical and credential-free', async () => {
    const h = await mcpService({
      scratch,
      persistence,
      grants: [{ name: 'list_items' }, { name: 'echo_secret' }],
      replies: [
        call('anthropic', '1', 'list_items', { repository: 'owner/repo-a' }),
        call('anthropic', '2', 'list_items', { repository: 'owner/repo-a' }),
        call('anthropic', '3', 'echo_secret', {}),
        done('anthropic'),
      ],
    });
    const runId = runIdOf(await h.start('owner/repo-a'));
    await h.service.settled();
    expect((await h.service.store.snapshot(runId)).state.kind).toBe('succeeded');
    // The same arguments under a new call are new work, sent again; nothing was answered from another record.
    expect(h.witness().calls).toEqual(['list_items', 'list_items', 'echo_secret']);
    const ops = await operations(runId);
    expect(ops.map((op) => [op.call, op.name, op.outcome])).toEqual([
      ['toolu_1', 'mcp_synthetic_list_items', 'ok'],
      ['toolu_2', 'mcp_synthetic_list_items', 'ok'],
      ['toolu_3', 'mcp_synthetic_echo_secret', 'ok'],
    ]);
    // The echoed credential was redacted from text and its structured copy withheld before anything stored it.
    expect(ops[2]?.result).toEqual({ outcome: 'ok', result: { text: expect.not.stringContaining(SLOT_VALUE) } });
    const history = await db.admin`select string_agg(payload::text, '') as text from runtime.events
      where run_id = ${runId}`;
    expect(String(history[0]?.text)).not.toContain(SLOT_VALUE);
    expect(await checkpointsContaining(SLOT_VALUE)).toBe(0);
    expect(JSON.stringify(h.net.sent)).not.toContain(SLOT_VALUE);
    // The model saw aliases; saved graph state holds the canonical names, with the provider's call IDs.
    expect(JSON.stringify(h.net.sent)).toContain('mcp_Alias_');
    expect(await checkpointsContaining('mcp_synthetic_list_items')).toBeGreaterThan(0);
    expect(await checkpointsContaining('toolu_2')).toBeGreaterThan(0);
    expect(await checkpointsContaining('mcp_Alias_')).toBe(0);
  });
});
