// MCP dispatch through the production run service (design Decisions 4, 5 and 8; tasks 12.2–12.6): each new call is
// permitted by the run's ceiling and the owner's current grants, validated against the approved raw schema, and only
// then admitted with durable intent and sent once. Refused calls send nothing; matching calls need no confirmation.
// The bundled synthetic server's witness log counts processes, listings and calls independently.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openPersistence, type Persistence } from '../../packages/runtime/src/persistence/persistence.ts';
import { sse, textTurn, toolTurn } from '../support/anthropic-network.ts';
import { mcpService, SLOT_VALUE, wire } from '../support/mcp-service.ts';
import { createScratchDatabase, type ScratchDatabase } from '../support/scratch-database.ts';

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

const call = (id: string, tool: string, input: unknown) => () =>
  sse(toolTurn(`msg_${id}`, `toolu_${id}`, wire(tool), input));
const done =
  (text = 'Done.') =>
  () =>
    sse(textTurn(`msg_${crypto.randomUUID()}`, text));

async function operations(runId: string) {
  return (await db.admin`select provider_tool_call_id as call, disposition ->> 'kind' as kind,
      disposition ->> 'outcome' as outcome, disposition #>> '{result,code}' as code, disposition -> 'result' as result
    from runtime.tool_operations where run_id = ${runId} order by created_at, operation_id`) as {
    call: string;
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
  test('a matching call is sent once without confirmation; refused calls send nothing', async () => {
    const h = await mcpService({
      scratch,
      persistence,
      grants: [{ name: 'list_items', argumentEquals: { repository: 'owner/repo-a' } }],
      replies: [
        call('1', 'list_items', { repository: 'owner/repo-a' }),
        call('2', 'list_items', { repository: 'owner/repo-b' }),
        call('3', 'list_items', { repository: 'owner/repo-a', extra: true }),
        call('4', 'fail', {}),
        done(),
      ],
    });
    const started = await h.start('owner/repo-a');
    expect(started.status).toBe(202);
    const runId = runIdOf(started);
    await h.service.settled();
    expect((await h.service.store.snapshot(runId)).state.kind).toBe('succeeded');
    expect(h.net.sent).toHaveLength(5);

    // One process for preflight, one for the invocation; one listing each; exactly one call.
    expect(h.witness()).toEqual({ spawns: 2, lists: 2, calls: ['list_items'] });
    const ops = await operations(runId);
    expect(ops.map((op) => [op.call, op.outcome, op.code])).toEqual([
      ['toolu_1', 'ok', null],
      ['toolu_2', 'refused', 'argument_out_of_scope'],
      ['toolu_3', 'refused', expect.stringMatching(/^(invalid_argument|arguments_invalid)$/)],
      ['toolu_4', 'refused', 'tool_unavailable'],
    ]);
    expect(ops[0]?.result).toEqual({ outcome: 'ok', result: { text: '2 items in owner/repo-a', json: { count: 2 } } });
    // Intent was recorded before the call was sent; refused calls never reached dispatch.
    expect(await dispositions(runId, 'toolu_1')).toEqual(['started', 'dispatching', 'completed']);
    expect(await dispositions(runId, 'toolu_2')).toEqual(['started', 'completed']);
    // No generic confirmation: the run asked nothing.
    expect(await db.admin`select 1 from runtime.questions where run_id = ${runId}`).toHaveLength(0);
    // The server's credential reached only the server.
    const stored =
      await db.admin`select (select string_agg(payload::text, '') from runtime.events where run_id = ${runId})
      || (select string_agg(disposition::text, '') from runtime.tool_operations where run_id = ${runId}) as text`;
    expect(String(stored[0]?.text)).not.toContain(SLOT_VALUE);
    expect(JSON.stringify(h.net.sent)).not.toContain(SLOT_VALUE);
  });
});
