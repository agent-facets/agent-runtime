// The crash matrix (Decision 6): a child process drives a run with the production controller to each crash window
// and is killed there with SIGKILL. A fresh owner then reconciles, as startup does, and the recorded outcome is
// checked against the design's table. The child's dispatch reports and the database are the witnesses; nothing may
// be redispatched after the restart.
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { dirname, join } from 'node:path';
import { openPersistence, type Persistence } from '../../packages/runtime/src/persistence/persistence.ts';
import { createWiring, echo } from '../../packages/runtime/test-support/lifecycle/wiring.ts';
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

interface Report {
  w: string;
  [key: string]: unknown;
}

let opened: Persistence | undefined;
afterEach(async () => {
  await opened?.close();
  opened = undefined;
});

/** Runs the child to its barrier, kills it, and returns everything it reported. */
async function crashAt(scenario: string): Promise<Report[]> {
  const reports: Report[] = [];
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
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.startsWith('{')) reports.push(JSON.parse(line) as Report);
        newline = buffer.indexOf('\n');
      }
    }
  })();
  try {
    await eventually(
      () => reports.some((report) => report.w === 'barrier' || report.w === 'child-error'),
      20_000,
      `${scenario} barrier`,
    );
  } finally {
    child.kill('SIGKILL');
    await child.exited;
  }
  const failed = reports.find((report) => report.w === 'child-error');
  if (failed !== undefined) throw new Error(`child failed: ${JSON.stringify(failed)}`);
  return reports;
}

/** A fresh owner after the crash: ownership is retried until the killed session is gone, then reconciled. */
async function restart(scripts: Parameters<typeof createWiring>[1]['scripts'] = []) {
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
  const dispatched: string[] = [];
  const wiring = createWiring(opened, {
    root: fixture.root,
    scripts,
    transport: (async () => {
      dispatched.push('request');
      return new Response('{"ok":true}');
    }) as unknown as typeof fetch,
  });
  const reconciled = await wiring.store.reconcileAfterRestart();
  return { wiring, reconciled, dispatched };
}

const runIdOf = (reports: Report[]) => reports.find((report) => report.w === 'run')?.runId as string;
const barrierOf = (reports: Report[]) => reports.find((report) => report.w === 'barrier') as Report;
const dispatchesOf = (reports: Report[]) => reports.filter((report) => report.w === 'dispatch').length;

async function records(runId: string) {
  const [row] = await db.admin`
    select r.state ->> 'kind' as state, r.consumed, r.unconfirmed,
      (select count(*)::int from runtime.questions q where q.run_id = r.run_id) as questions,
      (select string_agg(disposition, ',' order by started_at) from runtime.invocations i where i.run_id = r.run_id) as invocations,
      (select string_agg(state ->> 'kind', ',' order by ordinal) from runtime.model_attempts a where a.run_id = r.run_id) as attempts
    from runtime.runs r where r.run_id = ${runId}`;
  return row as {
    state: string;
    consumed: number;
    unconfirmed: number;
    questions: number;
    invocations: string;
    attempts: string | null;
  };
}

describe('crash windows', () => {
  test('working, no saved question → interrupted, progress kept, nothing redispatched', async () => {
    const reports = await crashAt('working');
    expect(barrierOf(reports).name).toBe('model-step');
    const runId = runIdOf(reports);
    const { reconciled, dispatched } = await restart();
    expect(reconciled.interrupted).toBeGreaterThanOrEqual(1);
    expect(await records(runId)).toMatchObject({
      state: 'interrupted',
      invocations: 'interrupted',
      attempts: 'completed',
    });
    expect(dispatchesOf(reports)).toBe(1);
    expect(dispatched).toHaveLength(0);
  });

  test('admitted but never confirmed sent → interrupted, the attempt unconfirmed and still charged', async () => {
    const reports = await crashAt('admission-gap');
    expect(barrierOf(reports).name).toBe('transport');
    const runId = runIdOf(reports);
    await restart();
    expect(await records(runId)).toMatchObject({
      state: 'interrupted',
      attempts: 'unconfirmed',
      consumed: 0,
      unconfirmed: 1,
    });
  });

  test('graph interrupt saved but question uncommitted → interrupted; the orphan is never answerable', async () => {
    const reports = await crashAt('orphan-interrupt');
    expect(barrierOf(reports).name).toBe('settled');
    const runId = runIdOf(reports);
    const { wiring, dispatched } = await restart();
    expect(await records(runId)).toMatchObject({ state: 'interrupted', questions: 0 });
    const tuple = await opened?.checkpoints.saver.getTuple({ configurable: { thread_id: runId, checkpoint_ns: '' } });
    expect(tuple?.pendingWrites?.some(([, channel]) => channel === '__interrupt__')).toBe(true);
    expect(await wiring.answer(runId, 'a'.repeat(64), { answer: true })).toEqual({
      kind: 'not_found',
      target: 'run_or_question',
    });
    expect(dispatched).toHaveLength(0);
  });

  test('waiting with a committed question → still waiting; a fresh process verifies, accepts and continues it', async () => {
    const reports = await crashAt('waiting');
    expect(barrierOf(reports)).toMatchObject({ name: 'published', state: 'waiting' });
    const runId = runIdOf(reports);
    const { wiring, reconciled, dispatched } = await restart([[echo]]);
    expect(reconciled).toEqual({ interrupted: 0, cancelled: 0 });
    const snapshot = await wiring.store.snapshot(runId);
    expect(snapshot.state.kind).toBe('waiting');
    const answered = await wiring.answer(runId, snapshot.pendingQuestion?.questionId ?? '', { answer: false });
    if (answered.kind !== 'accepted') throw new Error(answered.kind);
    const state = await wiring.controller.run(runId, answered.acceptance.invocationId, {
      kind: 'resume',
      ...answered.resume,
    });
    expect(state.kind).toBe('succeeded');
    expect(dispatched).toHaveLength(1);
    const events = await wiring.store.readEvents(runId, { after: '0', limit: 200 });
    const final = events.filter((event) => event.event.kind === 'assistant.message').at(-1);
    expect(JSON.parse((final?.event.payload as { text: string }).text)).toEqual({
      outcome: 'ok',
      result: { answer: false },
    });
  });

  test('answer committed, resume not dispatched → interrupted; the answer is kept and never redispatched', async () => {
    const reports = await crashAt('answer-accepted');
    const barrier = barrierOf(reports);
    expect(barrier).toMatchObject({ name: 'answer-accepted', answered: 'accepted' });
    const runId = runIdOf(reports);
    const { wiring, dispatched } = await restart();
    expect(await records(runId)).toMatchObject({ state: 'interrupted', invocations: 'settled,interrupted' });
    expect((await wiring.answer(runId, barrier.questionId as string, { answer: false })).kind).toBe('already_accepted');
    expect(dispatched).toHaveLength(0);
    expect(dispatchesOf(reports)).toBe(1);
  });

  test('graph finished, final outcome uncommitted → interrupted; success is not reconstructed', async () => {
    const reports = await crashAt('graph-finished');
    expect(barrierOf(reports).name).toBe('settled');
    const runId = runIdOf(reports);
    await restart();
    expect(await records(runId)).toMatchObject({ state: 'interrupted' });
  });

  test('cancellation accepted, work still stopping → cancelled, never resumed or interrupted', async () => {
    const reports = await crashAt('cancelling');
    expect(barrierOf(reports)).toMatchObject({ name: 'cancelling', accepted: 'accepted', state: 'cancelling' });
    const runId = runIdOf(reports);
    const { reconciled, dispatched } = await restart();
    expect(reconciled.cancelled).toBeGreaterThanOrEqual(1);
    expect(await records(runId)).toMatchObject({ state: 'cancelled' });
    expect(dispatched).toHaveLength(0);
  });

  test('terminal outcome committed → the same outcome after restart', async () => {
    const reports = await crashAt('terminal');
    expect(barrierOf(reports)).toMatchObject({ name: 'done', state: 'succeeded' });
    const runId = runIdOf(reports);
    const before = await records(runId);
    await restart();
    expect(await records(runId)).toEqual(before);
    expect(before.state).toBe('succeeded');
  });
});
