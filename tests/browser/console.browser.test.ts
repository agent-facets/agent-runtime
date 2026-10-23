// Browser smoke check: the built console in headless Chromium against the runtime's API and run service on the
// official saver, with a scripted provider. Behavior is tested at the API, service and component level; this only
// shows that the pieces work together in a real browser.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser, Page } from 'playwright';
import { openPersistence, type Persistence } from '../../packages/runtime/src/persistence/persistence.ts';
import { createFixture } from '../../packages/runtime/test-support/workspace.ts';
import { sse, textTurn, toolTurn, YES_NO_QUESTION } from '../support/anthropic-network.ts';
import { sharedBrowser } from '../support/browser.ts';
import { consoleServer, SYNTHETIC_ACCESS } from '../support/console-server.ts';
import { createScratchDatabase, type ScratchDatabase } from '../support/scratch-database.ts';

let db: ScratchDatabase;
let persistence: Persistence;
let browser: Browser;
const fixture = createFixture();
fixture.write('notes/plan.md', 'alpha\nbeta\n');
const scratch = mkdtempSync(join(tmpdir(), 'agent-runtime-browser-'));

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
const read = () => sse(toolTurn('msg_read', 'toolu_read', 'mcp_Read', { mode: 'file', path: 'notes/plan.md' }));
const ask =
  (question: unknown = YES_NO_QUESTION) =>
  () =>
    sse(
      toolTurn(
        `msg_${crypto.randomUUID().slice(0, 6)}`,
        `toolu_${crypto.randomUUID().slice(0, 6)}`,
        'mcp_AskUser',
        question,
      ),
    );
const finish = (text: string) => () => sse(textTurn(`msg_${crypto.randomUUID().slice(0, 6)}`, text));

const status = (page: Page) => page.locator('.facts .status');

describe('the console', () => {
  test('smoke: start a task, answer false after reconnecting, and see the result once', async () => {
    const server = await consoleServer({
      persistence,
      scratch,
      workspaceRoot: fixture.root,
      replies: [read, ask(), finish('Two steps in the plan; stopping as you asked.')],
    });
    const page = await browser.newPage();
    try {
      await page.goto(server.url);
      await page.getByLabel('Provider').waitFor({ timeout: TIMEOUT });
      await page.getByLabel('Goal').fill('Summarize notes/plan.md, then ask me before continuing.');
      await page.getByRole('button', { name: 'Start' }).click();
      await page.waitForURL(/#\/runs\/[0-9a-f-]{36}$/, { timeout: TIMEOUT });
      await page.getByRole('form', { name: 'Answer the question' }).waitFor({ timeout: TIMEOUT });

      // A dropped connection never changes what the run is shown to be doing; the page catches up.
      const restarted = server.dropConnections();
      await page.getByText('Reconnecting').waitFor({ timeout: TIMEOUT });
      expect(await status(page).textContent()).toBe('Waiting for you');
      await restarted;
      await page.getByText('Live', { exact: true }).waitFor({ timeout: TIMEOUT });

      await page.getByLabel('No').check();
      await page.getByRole('button', { name: 'Send answer' }).click();
      await page.locator('.message.final').waitFor({ timeout: TIMEOUT });
      expect(await status(page).textContent()).toBe('Completed');
      expect(await page.locator('.event-question-answered strong').textContent()).toBe('false');

      // Every recorded event appears once, in order; only model turns without text are not listed.
      const seqs = await page
        .locator('.history > li')
        .evaluateAll((items) => items.map((item) => item.getAttribute('data-seq')));
      const runId = page.url().split('/').at(-1) as string;
      const recorded = (await (await fetch(`${server.url}/api/v1/runs/${runId}/events?after=0`)).json()) as {
        events: { seq: string; kind: string; payload: { text?: string } }[];
      };
      expect(seqs).toEqual(
        recorded.events
          .filter((event) => event.kind !== 'assistant.message' || event.payload.text !== '')
          .map((event) => event.seq),
      );
      await server.service.settled();
      expect(server.net.sent).toHaveLength(3);
      expect(await page.content()).not.toContain(SYNTHETIC_ACCESS);
    } finally {
      await page.close();
      await server.stop();
    }
  }, 60_000);
});
