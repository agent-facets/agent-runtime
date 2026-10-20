// The real-MCP fresh-process delegate witness and integrated journey (design Decision 11, gates 2 and 4; tasks 12.7
// and 18.1). A child process starts a command run through the production API, both provider assemblies and the
// bundled synthetic server: the root loads a skill and calls the server in one response, reads the skill's bundled
// reference in the next, then delegates; the delegate calls the server and asks the owner. The child is killed. A
// fresh owner answers with an exact `false` through the API; the delegate calls the server again with the same
// arguments and asks again. Another fresh owner answers `false` and the run finishes with the root's own result.
// Completed calls are never repeated, the identical-argument call is new, tool identities stay canonical across
// requests, history and restarts, the server only ever sees its own tool name, the run's capabilities show what was
// actually used, and the event stream replays exactly the paginated history. A separate case exhausts the shared
// step budget.
//
// The retention witness (task 18.2) pauses a run after one completed call, then restarts with the installation
// replaced or removed and the tool's grant revoked: the run's first use of its skill, reference and agent comes from
// what it retained, the completed outcome is kept and nothing is sent again, and the new call is refused unsent.
import { afterAll, afterEach, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { selectionRevision } from '../../packages/runtime/src/capabilities/command.ts';
import { type CatalogLoad, loadInstallation } from '../../packages/runtime/src/capabilities/installation.ts';
import { openPersistence, type Persistence } from '../../packages/runtime/src/persistence/persistence.ts';
import type { SentInference } from '../support/anthropic-network.ts';
import { type Provider, phaseReplies, retentionReplies, SCENARIO, text } from '../support/mcp-delegate-scenario.ts';
import { mcpService, wire } from '../support/mcp-service.ts';
import { createScratchDatabase, eventually, type ScratchDatabase } from '../support/scratch-database.ts';
import { INSTALLATION_SHA256, ORIGINAL, sealedInstallation } from '../support/synthetic-installation.ts';

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
async function firstPhaseInChild(
  provider: Provider,
  kind: 'delegate' | 'retention' = 'delegate',
  name = `child-${provider}`,
): Promise<Barrier> {
  const childScratch = join(scratch, name);
  mkdirSync(childScratch, { recursive: true });
  const reports: { w: string; [key: string]: unknown }[] = [];
  const child = Bun.spawn([process.execPath, '--no-env-file', CHILD], {
    env: {
      PATH: dirname(process.execPath),
      SCENARIO_PROVIDER: provider,
      SCENARIO_KIND: kind,
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
      expect(first.sent).toBe(5);
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
      /** The run as the console reads it. */
      const view = async () => (await h.api('GET', `/runs/${first.runId}`)).body.run;
      const answer = (questionId: string) =>
        h.api('POST', `/runs/${first.runId}/questions/${questionId}/answer`, { answer: false });
      const firstQuestion = (await view()).pendingQuestion;
      expect(firstQuestion?.asker).toEqual({
        kind: 'delegate',
        delegationId: expect.any(String),
        agentId: 'agent:worker',
      });
      expect((await answer(firstQuestion.questionId)).status).toBe(202);
      await h.service.settled();
      const waitingAgain = await view();
      expect(waitingAgain.state.kind).toBe('waiting');
      expect(waitingAgain.pendingQuestion?.asker).toEqual(firstQuestion.asker);
      expect(waitingAgain.pendingQuestion?.questionId).not.toBe(firstQuestion.questionId);
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
      expect((await answer(waitingAgain.pendingQuestion.questionId)).status).toBe(202);
      await h.service.settled();
      const finished = await view();
      expect([finished.provider, finished.state.kind]).toEqual([provider, 'succeeded']);
      expect(finished.budget).toEqual({ maximum: 20, consumed: 9, unconfirmed: 0 });
      expect(h.net.sent).toHaveLength(2);
      // No MCP call after the second answer, so no process either; nothing earlier was repeated.
      expect(witnessOf(first.stateDir)).toEqual({
        spawns: 3,
        lists: 4,
        calls: ['list_items', 'list_items', 'list_items'],
      });

      // Physical model requests: five, two and two, all on the run's ordinals; answers exactly false.
      const [counts] = await db.admin`select (select count(*)::int from runtime.model_attempts
          where run_id = ${first.runId}) as attempts,
        (select array_agg(disposition -> 'answer' order by created_at) from runtime.questions
          where run_id = ${first.runId}) as answers`;
      expect(counts.attempts).toBe(9);
      expect(counts.answers).toEqual([false, false]);

      // Canonical identities in the ledger and history; the provider's wire names only on the wire.
      const ops = await operations();
      expect(ops.filter((op) => op.name === 'mcp_synthetic_list_items').map((op) => [op.call, op.delegate])).toEqual([
        ['call_r1b', false],
        ['call_d1', true],
        ['call_d3', true],
      ]);
      expect(ops.find((op) => op.call === 'call_r1a')?.name).toBe('mcp_LoadSkill');
      expect(ops.find((op) => op.call === 'call_r1r')?.name).toBe('mcp_ReadSkillReference');
      const [history] = await db.admin`select string_agg(payload::text, '') as text from runtime.events
        where run_id = ${first.runId}`;
      expect(String(history.text)).not.toContain('mcp_Alias_');
      const requests = [...first.requests, ...phaseTwo, ...h.net.sent];
      // Every request went to the run's own provider and model: no fallback.
      expect(new Set(requests.map((request) => request.body.model))).toEqual(
        new Set([provider === 'anthropic' ? 'claude-opus-5' : 'gpt-5.6-sol']),
      );
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
      // Each request carries its own actor's offer: four root requests with the delegation tool, five delegate
      // requests without it, all offering the server's tool.
      const offers = requests.map((request) =>
        ((request.body as unknown as { tools: { name: string }[] }).tools ?? []).map((tool) => tool.name),
      );
      expect(offers.filter((names) => names.includes('mcp_Delegate'))).toHaveLength(4);
      expect(offers.filter((names) => !names.includes('mcp_Delegate'))).toHaveLength(5);
      for (const [index, request] of requests.entries()) {
        expect(offers[index]).toContain(wire(request, 'list_items'));
      }

      // What the run actually used, read from its retained capabilities: one skill load and reference read by the
      // root, one delegation that ended in a result, and three calls of the server's tool.
      const capabilities = (await h.api('GET', `/runs/${first.runId}/capabilities`)).body;
      expect(capabilities.kind).toBe('command');
      expect(capabilities.bound.skills.map((skill: { id: string }) => skill.id)).toEqual(['skill:review']);
      expect(capabilities.bound.agents.map((agent: { id: string }) => agent.id)).toEqual(['agent:worker']);
      const used = (kind: string) =>
        capabilities.used.operations
          .filter((row: { kind: string }) => row.kind === kind)
          .map((row: { subject: string; ok: number; refused: number; error: number; uncertain: number }) => [
            row.subject,
            row.ok,
            row.refused + row.error + row.uncertain,
          ]);
      expect([used('skill_load'), used('skill_reference'), used('delegation'), used('mcp')]).toEqual([
        [['skill:review', 1, 0]],
        [[expect.stringContaining('skill:review'), 1, 0]],
        [['agent:worker', 1, 0]],
        [['synthetic/list_items', 3, 0]],
      ]);
      expect(capabilities.used.loadedSkills).toEqual([{ skillId: 'skill:review', actor: { kind: 'root' } }]);
      expect(capabilities.used.delegations).toEqual([
        { delegationId: firstQuestion.asker.delegationId, agentId: 'agent:worker', state: 'result' },
      ]);

      // The ordered history, through the paginated API.
      const events = await h.history(first.runId);
      const through = events.at(-1)?.seq as string;
      expect(events.map((event: { seq: string }) => event.seq)).toEqual(
        events.map((_: unknown, i: number) => `${i + 1}`),
      );
      const delegate = { kind: 'delegate', delegationId: firstQuestion.asker.delegationId, agentId: 'agent:worker' };
      const step = (event: (typeof events)[number]): string | undefined => {
        const by = event.payload.actor?.kind === 'delegate' ? 'delegate' : 'root';
        switch (event.kind) {
          case 'run.command':
            return `command ${event.payload.commandId}`;
          case 'tool.operation':
            return event.payload.disposition.kind === 'completed'
              ? `${by} ${event.payload.toolName} ${event.payload.disposition.outcome}`
              : undefined;
          case 'delegation.started':
            return `delegation started ${event.payload.agentId}`;
          case 'delegation.finished':
            return `delegation finished ${event.payload.outcome}`;
          case 'question.asked':
            return `${by} asked`;
          case 'question.answered':
            return `answered ${JSON.stringify(event.payload.answer)}`;
          case 'assistant.message':
            return event.payload.text === '' ? undefined : `${by} says ${event.payload.text}`;
          case 'run.status':
            return event.payload.state.kind === 'succeeded' ? 'succeeded' : undefined;
          default:
            return undefined;
        }
      };
      expect(events.map(step).filter((entry: string | undefined) => entry !== undefined)).toEqual([
        'command command:sync',
        'root mcp_LoadSkill ok',
        'root mcp_synthetic_list_items ok',
        'root mcp_ReadSkillReference ok',
        'delegation started agent:worker',
        'delegate mcp_synthetic_list_items ok',
        'delegate asked',
        'answered false',
        'delegate mcp_AskUser ok',
        'delegate mcp_synthetic_list_items ok',
        'delegate asked',
        'answered false',
        'delegate mcp_AskUser ok',
        'delegate says Checked twice.',
        'delegation finished result',
        'root mcp_Delegate ok',
        'root says The worker checked.',
        'succeeded',
      ]);
      // The questions name the delegate that asked them; the run's result is the root's own final message.
      for (const asked of events.filter((event: { kind: string }) => event.kind === 'question.asked')) {
        expect(asked.payload.actor).toEqual(delegate);
      }
      const result = events.find((event: { seq: string }) => event.seq === finished.state.resultSeq);
      expect([result?.kind, result?.payload.text, result?.payload.actor]).toEqual([
        'assistant.message',
        'The worker checked.',
        { kind: 'root' },
      ]);

      // The event stream replays exactly that history; a reconnect resumes after the last ID it saw.
      const cut = events.find((event: { kind: string }) => event.kind === 'question.answered')?.seq as string;
      const before = await h.stream(first.runId, { after: '0' }, cut);
      const after = await h.stream(first.runId, { after: '0', lastEventId: cut }, through);
      expect([...before, ...after]).toEqual(events);
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
        stepBudget: 4,
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
      // Three root requests and the delegate's first: the delegate's second request is never sent.
      expect(h.net.sent).toHaveLength(4);
      expect(h.witness().calls).toEqual(['list_items', 'list_items']);
    });
  }
});

describe('retained definitions after the installation changes and a grant is revoked', () => {
  const REPLACED = sealedInstallation({
    version: '1.1.0',
    skillInstructions: 'Replaced skill.',
    agentInstructions: 'Replaced agent.',
    guide: '# Replaced\n',
  });
  const replaced = loadInstallation(REPLACED.bytes, REPLACED.sha256);
  const removed: CatalogLoad = { kind: 'unavailable', reason: 'installation_missing' };
  const commandStart = (provider: Provider, sha256: string) => ({
    requestId: crypto.randomUUID(),
    provider,
    command: {
      id: 'command:sync',
      selectionRevision: selectionRevision(sha256, 'command:sync'),
      arguments: 'owner/repo-a',
    },
  });

  for (const provider of ['anthropic', 'openai'] as const) {
    for (const change of ['replaced', 'removed'] as const) {
      test(`${provider}: installation ${change}, grant revoked — the run continues from what it retained`, async () => {
        const name = `retention-${change}-${provider}`;
        const first = await firstPhaseInChild(provider, 'retention', name);
        expect([first.state, first.sent]).toEqual(['waiting', 2]);
        // One inspection before acceptance and one connection for the call, closed at the pause.
        const once = { spawns: 2, lists: 2, calls: ['list_items'] };
        expect(witnessOf(first.stateDir)).toEqual(once);
        const completed = async () =>
          (
            (await db.admin`select disposition::text as d from runtime.tool_operations
              where run_id = ${first.runId} and provider_tool_call_id = 'call_k1'`) as { d: string }[]
          )[0]?.d;
        const recorded = await completed();
        expect(JSON.parse(recorded as string)).toMatchObject({ kind: 'completed', outcome: 'ok' });

        // A fresh owner after process death: the installation is replaced or gone, and the tool's grant revoked.
        const persistence = await freshOwner();
        const restarted = (options: {
          grants: { name: string }[];
          catalog: CatalogLoad;
          replies: Parameters<typeof mcpService>[0]['replies'];
        }) =>
          mcpService({
            scratch: join(scratch, name),
            persistence,
            provider,
            stateDir: first.stateDir,
            allowAgents: [...SCENARIO.allowAgents],
            allowSkills: [...SCENARIO.allowSkills],
            grants: options.grants,
            catalog: async () => options.catalog,
            replies: options.replies,
          });
        const h = await restarted({
          grants: [],
          catalog: change === 'replaced' ? replaced : removed,
          replies: retentionReplies(provider, 2),
        });
        await h.service.store.reconcileAfterRestart();
        const question = (await h.api('GET', `/runs/${first.runId}`)).body.run.pendingQuestion;
        expect(
          (await h.api('POST', `/runs/${first.runId}/questions/${question.questionId}/answer`, { answer: false }))
            .status,
        ).toBe(202);
        await h.service.settled();
        expect((await h.api('GET', `/runs/${first.runId}`)).body.run.state.kind).toBe('succeeded');
        expect(h.net.sent).toHaveLength(6);

        // Nothing reached the server again: the completed call kept its record, and the new one was refused unsent.
        expect(witnessOf(first.stateDir)).toEqual(once);
        expect(await completed()).toBe(recorded);
        // The completed outcome came to the model from the saved state.
        expect(JSON.stringify(h.net.sent[0]?.body)).toContain('2 items in owner/repo-a');
        const outcomes = (await db.admin`select provider_tool_call_id as call, disposition ->> 'outcome' as outcome,
            disposition #>> '{result,code}' as code, disposition::text as text
          from runtime.tool_operations where run_id = ${first.runId}
            and provider_tool_call_id in ('call_k3', 'call_k4', 'call_k6')
          order by created_at`) as { call: string; outcome: string; code: string | null; text: string | null }[];
        expect(outcomes.map((row) => [row.call, row.outcome, row.code])).toEqual([
          ['call_k3', 'ok', null],
          ['call_k4', 'ok', null],
          ['call_k6', 'refused', 'tool_not_granted'],
        ]);
        // First uses after the restart: the retained skill, reference and agent, never the replacement.
        expect(JSON.parse(outcomes[0]?.text as string).result.result.text).toBe(ORIGINAL.skillInstructions);
        expect(outcomes[1]?.text).toContain('Check the item count.');
        expect(outcomes.some((row) => row.text?.includes('Replaced'))).toBe(false);
        expect(JSON.stringify(h.net.sent[3]?.body)).toContain(ORIGINAL.agentInstructions);
        expect(JSON.stringify(h.net.sent).includes('Replaced')).toBe(false);

        // The finished run is inspected with no installation at all; inspecting it starts nothing.
        const gone = await restarted({ grants: [], catalog: removed, replies: [() => text(provider, 'g1', 'Read.')] });
        const view = (await gone.api('GET', `/runs/${first.runId}/capabilities`)).body;
        expect(view.command.origins.map((origin: { version: string }) => origin.version)).toEqual(['1.0.0']);
        const usage = Object.fromEntries(
          view.used.operations.map((row: { kind: string; ok: number; refused: number; codes: string[] }) => [
            row.kind,
            [row.ok, row.refused, row.codes],
          ]),
        );
        expect(usage).toEqual({
          native: [1, 0, []],
          skill_load: [1, 0, []],
          skill_reference: [1, 0, []],
          delegation: [1, 0, []],
          mcp: [1, 1, ['tool_not_granted']],
        });
        expect(view.permissions.captured.servers[0].grants).toHaveLength(1);
        expect(view.permissions.current.servers[0].grants).toEqual([]);
        expect((await gone.history(first.runId)).at(-1)).toMatchObject({
          kind: 'run.status',
          payload: { state: { kind: 'succeeded' } },
        });
        expect(witnessOf(first.stateDir)).toEqual(once);

        if (change === 'replaced') {
          // A new run is accepted under the replacement and retains its definitions; the earlier run keeps its own.
          const next = await restarted({
            grants: [...SCENARIO.grants],
            catalog: replaced,
            replies: [() => text(provider, 'n1', 'Done.')],
          });
          const started = await next.api('POST', '/runs', commandStart(provider, REPLACED.sha256));
          expect(started.status).toBe(202);
          await next.service.settled();
          const retained = await next.service.store.readCapabilities(started.body.run.runId);
          expect([retained?.snapshot.skills[0]?.instructions, retained?.snapshot.agents[0]?.instructions]).toEqual([
            'Replaced skill.',
            'Replaced agent.',
          ]);
          const later = (await next.api('GET', `/runs/${started.body.run.runId}/capabilities`)).body;
          expect(later.command.origins.map((origin: { version: string }) => origin.version)).toEqual(['1.1.0']);
        } else {
          // Without an installation commands are unavailable, while a goal run starts with the three native tools.
          expect((await gone.api('GET', '/capabilities')).body).toEqual(removed);
          expect(await gone.api('POST', '/runs', commandStart(provider, INSTALLATION_SHA256))).toMatchObject({
            status: 503,
            body: { error: { code: 'capabilities_unavailable', acceptance: 'not_accepted' } },
          });
          const goal = await gone.api('POST', '/runs', {
            requestId: crypto.randomUUID(),
            provider,
            goal: 'Read the notes.',
          });
          expect(goal.status).toBe(202);
          await gone.service.settled();
          const [stored] = await db.admin`select d.manifest from runtime.runs r
            join runtime.execution_definitions d on d.digest = r.definition_digest
            where r.run_id = ${goal.body.run.runId}`;
          expect((stored?.manifest as { tools: { name: string }[] }).tools.map((tool) => tool.name)).toEqual([
            'mcp_AskUser',
            'mcp_Read',
            'mcp_Search',
          ]);
          expect((await gone.api('GET', `/runs/${goal.body.run.runId}`)).body.run.state.kind).toBe('succeeded');
          expect(witnessOf(first.stateDir)).toEqual(once);
        }
      });
    }
  }
});
