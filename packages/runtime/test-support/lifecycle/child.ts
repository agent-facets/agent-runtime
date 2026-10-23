// Crash-matrix child: drives one run with the production controller to a named point, reports it on stdout as a
// JSON line, and then waits to be killed. Every physical model request it makes is reported too, so the parent
// has an independent record of dispatch. Test-only.
import { openPersistence } from '../../src/persistence/persistence.ts';
import type { ScriptStep } from '../scripted-model.ts';
import { ask, createWiring, final } from './wiring.ts';

const report = (event: Record<string, unknown>) => process.stdout.write(`${JSON.stringify(event)}\n`);
const forever = () => new Promise<never>(() => {});
const barrier = async (name: string, data: Record<string, unknown> = {}) => {
  report({ w: 'barrier', name, ...data });
  return forever();
};

const scenario = process.env.LIFECYCLE_SCENARIO ?? '';
const url = process.env.LIFECYCLE_DATABASE_URL ?? '';
const root = process.env.LIFECYCLE_WORKSPACE_ROOT ?? '';

let reachedModel: () => void = () => {};
const modelReached = new Promise<void>((resolve) => (reachedModel = resolve));
const blockInModel: ScriptStep = async () => {
  // Where cancellation is exercised the model step only waits; elsewhere reaching it is the crash point.
  if (scenario === 'cancelling') {
    reachedModel();
    return forever();
  }
  return barrier('model-step');
};
const transport = (async () => {
  report({ w: 'dispatch' });
  if (scenario === 'admission-gap') return barrier('transport');
  return new Response('{"ok":true}');
}) as unknown as typeof fetch;

const scripts: Record<string, ScriptStep[][]> = {
  working: [[blockInModel]],
  'admission-gap': [[final]],
  'orphan-interrupt': [[ask]],
  waiting: [[ask]],
  'answer-accepted': [[ask]],
  'graph-finished': [[final]],
  cancelling: [[blockInModel]],
  terminal: [[final]],
};

try {
  const persistence = await openPersistence({ url, onFault: () => {} });
  let runId = '';
  const wiring = createWiring(persistence, {
    root,
    scripts: scripts[scenario] ?? [],
    transport,
    barriers: {
      afterSettlement: async (_, settlement) => {
        if (scenario === 'orphan-interrupt' && settlement.kind === 'interrupted') await barrier('settled', { runId });
        if (scenario === 'graph-finished' && settlement.kind === 'finished') await barrier('settled', { runId });
      },
    },
  });
  const run = await wiring.createRun();
  runId = run.runId;
  report({ w: 'run', runId });

  if (scenario === 'cancelling') {
    const started = wiring.controller.run(runId, run.invocationId, { kind: 'initial', goal: 'Decide.' });
    void started.catch(() => {});
    // Once the model step is running, cancellation is durably accepted; the process then dies before any local
    // work is stopped, so the recorded state is `cancelling`.
    await modelReached;
    const result = await wiring.store.acceptCancellation(runId, crypto.randomUUID());
    await barrier('cancelling', { accepted: result.kind, state: result.state.kind });
  }

  const state = await wiring.controller.run(runId, run.invocationId, { kind: 'initial', goal: 'Decide.' });
  if (scenario === 'waiting') await barrier('published', { state: state.kind });
  if (scenario === 'answer-accepted') {
    const snapshot = await wiring.store.snapshot(runId);
    const questionId = snapshot.pendingQuestion?.questionId ?? '';
    const answered = await wiring.answer(runId, questionId, { answer: false });
    await barrier('answer-accepted', { questionId, answered: answered.kind });
  }
  await barrier('done', { state: state.kind });
} catch (error) {
  report({ w: 'child-error', name: error instanceof Error ? error.name : 'unknown' });
  process.exit(1);
}
