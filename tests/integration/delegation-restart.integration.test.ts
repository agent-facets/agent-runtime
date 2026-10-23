// The fresh-process delegate witness (design Decision 11, gate 2; task 4.9): a child process drives a command run
// through the production controller and official saver until its delegate asks the owner, and is killed. Fresh
// owners — first after that process death, then again after closing every handle — verify and answer the delegate's
// two sequential questions with exact negative answers, then the root delegates to the same named agent again and
// finishes. Completed operations are never repeated; physical requests are counted on both sides. Provider-free.
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { dirname, join } from 'node:path';
import { openPersistence, type Persistence } from '../../packages/runtime/src/persistence/persistence.ts';
import { createWiring, echo } from '../../packages/runtime/test-support/lifecycle/wiring.ts';
import { AIMessage, type ScriptStep } from '../../packages/runtime/test-support/scripted-model.ts';
import { createFixture } from '../../packages/runtime/test-support/workspace.ts';
import { createScratchDatabase, eventually, type ScratchDatabase } from '../support/scratch-database.ts';

const CHILD = join(import.meta.dir, '..', '..', 'packages', 'runtime', 'test-support', 'lifecycle', 'child.ts');

let db: ScratchDatabase;
const fixture = createFixture();
fixture.write('notes/plan.md', 'alpha\n');
beforeAll(async () => {
  db = await createScratchDatabase();
});
afterAll(async () => {
  await db.drop();
  fixture.cleanup();
});
let opened: Persistence | undefined;
afterEach(async () => {
  await opened?.close();
  opened = undefined;
});

/** Runs the child to its barrier and kills it; returns its reports. */
async function crashAt(scenario: string) {
  const reports: { w: string; [key: string]: unknown }[] = [];
  const child = Bun.spawn([process.execPath, '--no-env-file', CHILD], {
    env: {
      PATH: dirname(process.execPath),
      LIFECYCLE_SCENARIO: scenario,
      LIFECYCLE_DATABASE_URL: db.url,
      LIFECYCLE_WORKSPACE_ROOT: fixture.root,
    },
    stdout: 'pipe',
    stderr: 'pipe',
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
    await eventually(() => reports.some((r) => r.w === 'barrier' || r.w === 'child-error'), 20_000, 'barrier');
  } finally {
    child.kill('SIGKILL');
    await child.exited;
  }
  const failed = reports.find((report) => report.w === 'child-error');
  if (failed !== undefined) throw new Error(`child failed: ${JSON.stringify(failed)}`);
  return reports;
}

let requests = 0;
/** A fresh owner: ownership is retried until the previous holder is gone; startup reconciliation runs first. */
async function freshOwner() {
  await opened?.close();
  opened = undefined;
  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      opened = await openPersistence({ url: db.url, onFault: () => {} });
      break;
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await Bun.sleep(100);
    }
  }
  const wiring = createWiring(opened, {
    root: fixture.root,
    scripts: [],
    transport: (async () => {
      requests++;
      return new Response('{"ok":true}');
    }) as unknown as typeof fetch,
  });
  const reconciled = await wiring.store.reconcileAfterRestart();
  return { wiring, reconciled };
}

const toolCall =
  (id: string, name: string, args: Record<string, unknown>): ScriptStep =>
  () =>
    new AIMessage({ id: `m-${id}`, content: '', tool_calls: [{ id: `c-${id}`, name, args, type: 'tool_call' }] });
const say =
  (text: string): ScriptStep =>
  () =>
    new AIMessage({ id: `m-${crypto.randomUUID()}`, content: text });

async function counts(runId: string) {
  const [row] = await db.admin`select
      (select count(*)::int from runtime.tool_operations where run_id = ${runId} and tool_name = 'mcp_Read'
        and disposition ->> 'kind' = 'completed') as reads,
      (select count(*)::int from runtime.model_attempts where run_id = ${runId}) as attempts`;
  return row as { reads: number; attempts: number };
}

test('a delegate’s two questions are answered across restarts; completed work is never repeated', async () => {
  const reports = await crashAt('delegate-waiting');
  expect(reports.find((report) => report.w === 'barrier')).toMatchObject({ name: 'published', state: 'waiting' });
  expect(reports.filter((report) => report.w === 'dispatch')).toHaveLength(3);
  const runId = reports.find((report) => report.w === 'run')?.runId as string;

  // After process death: still waiting, nothing dispatched by startup; the delegate's question is answerable.
  let { wiring, reconciled } = await freshOwner();
  expect(reconciled).toEqual({ interrupted: 0, cancelled: 0 });
  expect(await counts(runId)).toEqual({ reads: 1, attempts: 3 });
  const first = (await wiring.store.snapshot(runId)).pendingQuestion;
  expect(first?.asker?.kind).toBe('delegate');
  const answered = await wiring.answer(runId, first?.questionId as string, { answer: false });
  if (answered.kind !== 'accepted') throw new Error(answered.kind);
  // The acknowledgement was lost: the retry is acknowledged, and starts nothing.
  expect((await wiring.answer(runId, first?.questionId as string, { answer: false })).kind).toBe('already_accepted');
  wiring.script([
    toolCall('child-3', 'mcp_AskUser', {
      prompt: 'And now?',
      input: { kind: 'choice', multiple: false, options: [{ label: 'Nothing', value: null }] },
    }),
  ]);
  const before = requests;
  expect(
    (await wiring.controller.run(runId, answered.acceptance.invocationId, { kind: 'resume', ...answered.resume })).kind,
  ).toBe('waiting');
  expect(requests - before).toBe(1);
  const second = (await wiring.store.snapshot(runId)).pendingQuestion;
  expect(second?.asker).toEqual(first?.asker);
  expect(second?.questionId).not.toBe(first?.questionId);
  expect((await counts(runId)).reads).toBe(1);

  // Every handle closed and reopened: the same delegate resumes from its saved state; then the root delegates to the
  // same named agent again, which is a new delegation.
  ({ wiring } = await freshOwner());
  const again = await wiring.answer(runId, second?.questionId as string, { answer: null });
  if (again.kind !== 'accepted') throw new Error(again.kind);
  wiring.script([
    echo,
    toolCall('root-2', 'mcp_Delegate', { agent: 'agent:helper', task: 'Read the plan.' }),
    toolCall('child-b1', 'mcp_Read', { mode: 'file', path: 'notes/plan.md' }),
    say('second'),
    echo,
  ]);
  const resumed = requests;
  const state = await wiring.controller.run(runId, again.acceptance.invocationId, { kind: 'resume', ...again.resume });
  expect(state.kind).toBe('succeeded');
  expect(requests - resumed).toBe(5);
  // One read per delegation: the first delegation's completed read was not repeated by either continuation.
  expect(await counts(runId)).toEqual({ reads: 2, attempts: 9 });

  const actors = await db.admin`select actor_key, agent_id, state from runtime.run_actors
    where run_id = ${runId} and kind = 'delegate' order by created_at`;
  expect(actors.map((row: { agent_id: string }) => row.agent_id)).toEqual(['agent:helper', 'agent:helper']);
  expect(actors[0].state.outcome.text).toContain('"answer":null');
  expect(actors[1].state.outcome).toEqual({ kind: 'result', text: 'second' });
  const answers = await db.admin`select disposition -> 'answer' as answer from runtime.questions
    where run_id = ${runId} order by created_at`;
  expect(answers.map((row: { answer: unknown }) => row.answer)).toEqual([false, null]);
});
