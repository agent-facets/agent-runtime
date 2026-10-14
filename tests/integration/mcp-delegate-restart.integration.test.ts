// The real-MCP fresh-process delegate witness (design Decision 11, gates 2 and 4; task 12.7). A child process drives a
// command run through the production service, both provider assemblies and the bundled synthetic server: the root
// loads a skill and calls the server in one response, then delegates; the delegate calls the server and asks the
// owner. The child is killed. A fresh owner answers with an exact `false`; the delegate calls the server again with the
// same arguments and asks again. Another fresh owner answers `false` and the run finishes. Completed calls are never
// repeated, the identical-argument call is new, tool identities stay canonical across requests, history and
// restarts, and the server only ever sees its own tool name. A separate case exhausts the shared step budget.
import { afterAll, afterEach, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { openPersistence, type Persistence } from '../../packages/runtime/src/persistence/persistence.ts';
import type { SentInference } from '../support/anthropic-network.ts';
import { type Provider, phaseReplies, SCENARIO } from '../support/mcp-delegate-scenario.ts';
import { mcpService, wire } from '../support/mcp-service.ts';
import { createScratchDatabase, eventually, type ScratchDatabase } from '../support/scratch-database.ts';

setDefaultTimeout(60_000);

const CHILD = join(import.meta.dir, '..', 'support', 'mcp-delegate-child.ts');
const scratch = mkdtempSync(join(tmpdir(), 'agent-runtime-mcp-delegate-'));
let db: ScratchDatabase;
beforeAll(async () => {
  db = await createScratchDatabase();
});
/** The owner this test opened, closed after each case even when it fails. */
let opened: Persistence | undefined;
afterEach(async () => {
  await opened?.close();
  opened = undefined;
});
afterAll(async () => {
  await db.drop();
  rmSync(scratch, { recursive: true, force: true });
});

interface Barrier {
  runId: string;
  state: string;
  stateDir: string;
  sent: number;
  requests: SentInference[];
}

/** Runs the first phase in a child process to its barrier, then kills it. */
async function firstPhaseInChild(provider: Provider): Promise<Barrier> {
  const childScratch = join(scratch, `child-${provider}`);
  mkdirSync(childScratch, { recursive: true });
  const reports: { w: string; [key: string]: unknown }[] = [];
  const child = Bun.spawn([process.execPath, '--no-env-file', CHILD], {
    env: {
      PATH: dirname(process.execPath),
      SCENARIO_PROVIDER: provider,
      SCENARIO_DATABASE_URL: db.url,
      SCENARIO_SCRATCH: childScratch,
      MCP_FIXTURE_PROGRAMS: process.env.MCP_FIXTURE_PROGRAMS,
    },
    stdout: 'pipe',
    stderr: 'ignore',
  });
  void (async () => {
    let buffer = '';
    for await (const bytes of child.stdout) {
      buffer += new TextDecoder().decode(bytes);
      for (let newline = buffer.indexOf('\n'); newline >= 0; newline = buffer.indexOf('\n')) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.startsWith('{')) reports.push(JSON.parse(line));
      }
    }
  })();
  try {
    await eventually(() => reports.some((r) => r.w === 'barrier' || r.w === 'child-error'), 40_000, 'barrier');
  } finally {
    child.kill('SIGKILL');
    await child.exited;
  }
  const failed = reports.find((report) => report.w === 'child-error');
  if (failed !== undefined) throw new Error(`child failed: ${JSON.stringify(failed)}`);
  return reports.find((report) => report.w === 'barrier') as unknown as Barrier;
}

/** A fresh owner of the same database; ownership is retried until the previous holder is gone. */
async function freshOwner(): Promise<Persistence> {
  await opened?.close();
  opened = undefined;
  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      opened = await openPersistence({ url: db.url, onFault: () => {} });
      return opened;
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await Bun.sleep(100);
    }
  }
}

const witnessOf = (stateDir: string) => {
  const path = join(stateDir, 'mcp', 'synthetic', 'home', 'witness.log');
  const lines = existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n') : [];
  return {
    spawns: lines.filter((line) => line.startsWith('spawn ')).length,
    lists: lines.filter((line) => line === 'list').length,
    calls: lines.filter((line) => line.startsWith('call ')).map((line) => line.slice('call '.length)),
  };
};

/** Every structured tool name a request carried: offered tools and historical calls, in the provider's own form. */
function requestToolNames(provider: Provider, request: SentInference): string[] {
  const body = request.body as unknown as Record<string, unknown>;
  const offered = ((body.tools ?? []) as { name: string }[]).map((tool) => tool.name);
  if (provider === 'anthropic') {
    const history = (body.messages as { content: unknown }[]).flatMap((message) =>
      Array.isArray(message.content)
        ? (message.content as { type: string; name?: string }[])
            .filter((block) => block.type === 'tool_use')
            .map((block) => block.name as string)
        : [],
    );
    return [...offered, ...history];
  }
  const history = ((body.input ?? []) as { type: string; name?: string }[])
    .filter((item) => item.type === 'function_call')
    .map((item) => item.name as string);
  return [...offered, ...history];
}

for (const provider of ['anthropic', 'openai'] as const) {
  describe(`${provider}: a real MCP delegate across process death and restarts`, () => {
    test('completed calls are never repeated; answers, identities and request counts survive', async () => {
      const first = await firstPhaseInChild(provider);
      expect(first.state).toBe('waiting');
      expect(first.sent).toBe(4);
      expect(witnessOf(first.stateDir)).toEqual({ spawns: 2, lists: 3, calls: ['list_items', 'list_items'] });

      const operations = async () =>
        (await db.admin`select provider_tool_call_id as call, tool_name as name, actor_key <> 'root' as delegate
          from runtime.tool_operations where run_id = ${first.runId}
          order by created_at, operation_id`) as { call: string; name: string; delegate: boolean }[];

      // Fresh owner after process death: the delegate's question is still pending and answerable.
      let persistence = await freshOwner();
      const options = (phase: 2 | 3) => ({
        // The child's scratch: the same workspace, so the run's execution definition is unchanged.
        scratch: join(scratch, `child-${provider}`),
        persistence,
        provider,
        stateDir: first.stateDir,
        grants: [...SCENARIO.grants],
        allowAgents: [...SCENARIO.allowAgents],
        allowSkills: [...SCENARIO.allowSkills],
        replies: phaseReplies(provider, phase),
      });
      let h = await mcpService(options(2));
      await h.service.store.reconcileAfterRestart();
      const firstQuestion = (await h.service.store.snapshot(first.runId)).pendingQuestion;
      expect(firstQuestion?.asker?.kind).toBe('delegate');
      expect(await h.service.answer(first.runId, firstQuestion?.questionId as string, { answer: false })).toMatchObject(
        {
          status: 202,
        },
      );
      await h.service.settled();
      const waitingAgain = await h.service.store.snapshot(first.runId);
      expect(waitingAgain.state.kind).toBe('waiting');
      expect(waitingAgain.pendingQuestion?.asker).toEqual(firstQuestion?.asker);
      expect(waitingAgain.pendingQuestion?.questionId).not.toBe(firstQuestion?.questionId);
      expect(h.net.sent).toHaveLength(2);
      // Only the genuinely new call reached the server; the delegate's completed one was not repeated.
      expect(witnessOf(first.stateDir)).toEqual({
        spawns: 3,
        lists: 4,
        calls: ['list_items', 'list_items', 'list_items'],
      });
      const phaseTwo = h.net.sent;

      // Every handle closed and reopened: the same delegate finishes, then the root.
      persistence = await freshOwner();
      h = await mcpService(options(3));
      expect(
        (await h.service.answer(first.runId, waitingAgain.pendingQuestion?.questionId as string, { answer: false }))
          .status,
      ).toBe(202);
      await h.service.settled();
      expect((await h.service.store.snapshot(first.runId)).state.kind).toBe('succeeded');
      expect(h.net.sent).toHaveLength(2);
      // No MCP call after the second answer, so no process either; nothing earlier was repeated.
      expect(witnessOf(first.stateDir)).toEqual({
        spawns: 3,
        lists: 4,
        calls: ['list_items', 'list_items', 'list_items'],
      });

      // Physical model requests: four, two and two, all on the run's ordinals; answers exactly false.
      const [counts] = await db.admin`select (select count(*)::int from runtime.model_attempts
          where run_id = ${first.runId}) as attempts,
        (select array_agg(disposition -> 'answer' order by created_at) from runtime.questions
          where run_id = ${first.runId}) as answers`;
      expect(counts.attempts).toBe(8);
      expect(counts.answers).toEqual([false, false]);

      // Canonical identities in the ledger and history; the provider's wire names only on the wire.
      const ops = await operations();
      expect(ops.filter((op) => op.name === 'mcp_synthetic_list_items').map((op) => [op.call, op.delegate])).toEqual([
        ['call_r1b', false],
        ['call_d1', true],
        ['call_d3', true],
      ]);
      expect(ops.find((op) => op.call === 'call_r1a')?.name).toBe('mcp_LoadSkill');
      const [history] = await db.admin`select string_agg(payload::text, '') as text from runtime.events
        where run_id = ${first.runId}`;
      expect(String(history.text)).not.toContain('mcp_Alias_');
      const requests = [...first.requests, ...phaseTwo, ...h.net.sent];
      for (const request of requests) {
        const names = requestToolNames(provider, request);
        // Anthropic's profile cannot carry the canonical name; OpenAI's wire contract can, so it is never aliased.
        if (provider === 'anthropic') expect(names).not.toContain('mcp_synthetic_list_items');
        else expect(names.some((name) => name.startsWith('mcp_Alias_'))).toBe(false);
      }
      // After restart, the delegate's earlier call was re-sent in history under the wire name its request offered.
      const resumed = phaseTwo[0] as SentInference;
      const offered = wire(resumed, 'list_items');
      expect(requestToolNames(provider, resumed).filter((name) => name === offered)).toHaveLength(2);
      // Each request carries its own actor's offer: three root requests with the delegation tool, five delegate
      // requests without it, all offering the server's tool.
      const offers = requests.map((request) =>
        ((request.body as unknown as { tools: { name: string }[] }).tools ?? []).map((tool) => tool.name),
      );
      expect(offers.filter((names) => names.includes('mcp_Delegate'))).toHaveLength(3);
      expect(offers.filter((names) => !names.includes('mcp_Delegate'))).toHaveLength(5);
      for (const [index, request] of requests.entries()) {
        expect(offers[index]).toContain(wire(request, 'list_items'));
      }
    });
  });
}

describe('the shared budget with a real MCP delegate', () => {
  for (const provider of ['anthropic', 'openai'] as const) {
    test(`${provider}: a delegate cannot obtain a fresh allowance`, async () => {
      const persistence = await freshOwner();
      const replies = phaseReplies(provider, 1);
      const h = await mcpService({
        scratch: join(scratch, `budget-${provider}`),
        persistence,
        provider,
        stepBudget: 3,
        grants: [...SCENARIO.grants],
        allowAgents: [...SCENARIO.allowAgents],
        allowSkills: [...SCENARIO.allowSkills],
        replies,
      });
      const started = await h.start('owner/repo-a');
      const runId = (started.body as { run: { runId: string } }).run.runId;
      await h.service.settled();
      const [row] = await db.admin`select state from runtime.runs where run_id = ${runId}`;
      expect(row.state).toMatchObject({ kind: 'failed', failure: { category: 'step_limit' } });
      // Root, root, delegate: the delegate's second request is never sent.
      expect(h.net.sent).toHaveLength(3);
      expect(h.witness().calls).toEqual(['list_items', 'list_items']);
    });
  }
});
