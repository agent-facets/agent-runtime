// Offline rehearsal of the bounded Anthropic acceptance trial (task 12.8): the shared trial fixture and pass
// conditions, the console in a real browser, and a scripted model that follows the trial's instructions. It
// covers leaving and returning, a runtime restart while a question waits, the false answer, the result and a
// cancellation that survives restart — and shows the deployment's ceiling holds the trial to its cap.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser } from 'playwright';
import { openPersistence, type Persistence } from '../../packages/runtime/src/persistence/persistence.ts';
import { RunStore } from '../../packages/runtime/src/records/run-store.ts';
import { createFixture } from '../../packages/runtime/test-support/workspace.ts';
import { ApiClient } from '../../packages/ui/src/api/client.ts';
import { checkTrialDeployment, reportTrial, startTrialRuns, TRIAL } from '../acceptance/anthropic-trial.ts';
import { type SentInference, sse, textTurn, toolTurn } from '../support/anthropic-network.ts';
import { sharedBrowser } from '../support/browser.ts';
import { consoleServer } from '../support/console-server.ts';
import { createScratchDatabase, type ScratchDatabase } from '../support/scratch-database.ts';

let db: ScratchDatabase;
let persistence: Persistence;
let browser: Browser;
const fixture = createFixture();
fixture.write(TRIAL.note.path, TRIAL.note.content);
const scratch = mkdtempSync(join(tmpdir(), 'agent-runtime-rehearsal-'));
beforeAll(async () => {
  db = await createScratchDatabase();
  persistence = await openPersistence({ url: db.url, onFault: () => {} });
  browser = await sharedBrowser();
});
afterAll(async () => {
  await persistence.close();
  await db.drop();
  fixture.cleanup();
  rmSync(scratch, { recursive: true, force: true });
});

const TIMEOUT = 15_000;
const QUESTION = {
  prompt: 'Shall I list the checklist steps?',
  input: {
    kind: 'choice',
    multiple: false,
    options: [
      { label: 'Yes', value: true },
      { label: 'No', value: false },
    ],
  },
};

/** A scripted model that follows the trial's goals: what it returns depends on the conversation so far. */
function trialModel(request: SentInference): Response {
  const messages = request.body.messages;
  const goal = messages[0]?.content;
  const id = () => `msg_${crypto.randomUUID().slice(0, 8)}`;
  if (goal === TRIAL.cancelGoal) return sse(toolTurn(id(), `toolu_${id()}`, 'mcp_AskUser', QUESTION));
  if (goal !== TRIAL.journeyGoal) throw new Error('unexpected goal');
  if (messages.length === 1)
    return sse(toolTurn(id(), `toolu_${id()}`, 'mcp_Read', { mode: 'file', path: TRIAL.note.path }));
  if (messages.length === 3) return sse(toolTurn(id(), `toolu_${id()}`, 'mcp_AskUser', QUESTION));
  return sse(textTurn(id(), 'Understood: I will not list the steps.'));
}

const operator = { stepBudget: TRIAL.stepBudget, modelRequestCeiling: TRIAL.requestCeiling };

describe('acceptance trial rehearsal', () => {
  test('the trial journey and its pass conditions, across leaving, a restart and a cancellation', async () => {
    let server = await consoleServer({
      persistence,
      scratch,
      workspaceRoot: fixture.root,
      replies: trialModel,
      operator,
    });
    const api = (url: string) =>
      new ApiClient({
        base: url,
        fetch: (input, init) => fetch(input, { ...init, headers: { ...(init.headers as object), origin: url } }),
      });

    // The tooling refuses a deployment without the trial's limits.
    const unlimited = await consoleServer({ persistence, scratch, workspaceRoot: fixture.root, replies: [] });
    await expect(checkTrialDeployment(api(unlimited.url))).rejects.toThrow('ceiling is unset');
    await unlimited.stop();

    await checkTrialDeployment(api(server.url));
    const runs = await startTrialRuns(api(server.url), 'rehearsal');
    // Repeating the step names the same runs and starts nothing.
    expect(await startTrialRuns(api(server.url), 'rehearsal')).toEqual(runs);

    const context = await browser.newContext();
    let page = await context.newPage();
    await page.goto(`${server.url}/#/runs/${runs.journey}`);
    await page.getByRole('form', { name: 'Answer the question' }).waitFor({ timeout: TIMEOUT });
    expect(await page.getByText('mcp_Read').count()).toBeGreaterThan(0);
    await page.close();

    // The runtime restarts while both runs wait for answers.
    await server.stop();
    await new RunStore(persistence.app, persistence.ownership).reconcileAfterRestart();
    const firstNetwork = server.net.sent.length;
    server = await consoleServer({ persistence, scratch, workspaceRoot: fixture.root, replies: trialModel, operator });

    page = await context.newPage();
    await page.goto(`${server.url}/#/runs/${runs.journey}`);
    await page.getByRole('form', { name: 'Answer the question' }).waitFor({ timeout: TIMEOUT });
    await page.getByLabel('No').check();
    await page.getByRole('button', { name: 'Send answer' }).click();
    await page.locator('.message.final').waitFor({ timeout: TIMEOUT });

    await page.goto(`${server.url}/#/runs/${runs.cancel}`);
    await page.getByRole('form', { name: 'Answer the question' }).waitFor({ timeout: TIMEOUT });
    await page.getByRole('button', { name: 'Cancel run' }).click();
    await page.locator('.facts .status-cancelled').waitFor({ timeout: TIMEOUT });
    await context.close();

    // After another restart, the cancellation stands.
    await server.stop();
    await new RunStore(persistence.app, persistence.ownership).reconcileAfterRestart();
    const total = firstNetwork + server.net.sent.length;
    server = await consoleServer({ persistence, scratch, workspaceRoot: fixture.root, replies: trialModel, operator });
    const report = await reportTrial(api(server.url), runs);
    expect(report).toEqual({ passed: true, requests: { journey: 3, cancel: 1, total: 4 }, findings: [] });
    expect(total).toBe(4);
    await server.stop();
  }, 90_000);

  test('the deployment ceiling stops model requests across runs, even when each run has budget left', async () => {
    // The ceiling counts every run in a deployment, so this case uses a database of its own.
    const own = await createScratchDatabase();
    const ownPersistence = await openPersistence({ url: own.url, onFault: () => {} });
    const server = await consoleServer({
      persistence: ownPersistence,
      scratch,
      workspaceRoot: fixture.root,
      replies: trialModel,
      operator: { stepBudget: TRIAL.stepBudget, modelRequestCeiling: 2 },
    });
    try {
      const client = new ApiClient({
        base: server.url,
        fetch: (input, init) => fetch(input, { ...init, headers: { ...(init.headers as object), origin: server.url } }),
      });
      const runs = await startTrialRuns(client, 'ceiling');
      await server.service.settled();
      // Two requests are all the deployment admits: the journey's read and one of the two questions.
      expect(server.net.sent).toHaveLength(2);
      const states = await Promise.all(
        [runs.journey, runs.cancel].map(async (runId) => {
          const run = await client.run(runId);
          return run.ok ? run.value.run.state : undefined;
        }),
      );
      const stopped = states.filter((state) => state?.kind === 'failed');
      expect(stopped.length).toBeGreaterThanOrEqual(1);
      for (const state of stopped) {
        expect(state?.kind === 'failed' && state.failure).toMatchObject({
          category: 'step_limit',
          reason: 'request_ceiling_reached',
        });
      }
    } finally {
      await server.stop();
      await ownPersistence.close();
      await own.drop();
    }
  }, 60_000);
});
