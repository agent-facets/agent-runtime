// Deterministic browser journeys (task 12.6): the built console in headless Chromium, against the runtime's API
// and run service on the official saver. The provider is a scripted network; it is also the witness that a
// repeated submission, a lost acknowledgement or a dropped connection never causes another model request.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser, Page } from 'playwright';
import { openPersistence, type Persistence } from '../../packages/runtime/src/persistence/persistence.ts';
import { createFixture } from '../../packages/runtime/test-support/workspace.ts';
import { sse, textTurn, toolTurn, YES_NO_QUESTION } from '../support/anthropic-network.ts';
import { sharedBrowser } from '../support/browser.ts';
import { consoleServer, SYNTHETIC_ACCESS, SYNTHETIC_REFRESH } from '../support/console-server.ts';
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

async function startFromForm(page: Page, goal: string) {
  await page.getByLabel('Goal').fill(goal);
  await page.getByRole('button', { name: /^(Start|Submit again)$/ }).click();
}

/** The tool result the model received for the question, from the request that followed the answer. */
function replayedAnswer(sent: { body: { messages: { content: unknown }[] } }[]) {
  const last = sent.at(-1)?.body.messages.at(-1)?.content as { content: string }[];
  return JSON.parse(String(last[0]?.content)).result.answer;
}

describe('the console journey', () => {
  test('start, observe, leave and return, answer false, and see the result — without duplicate work', async () => {
    const server = await consoleServer({
      persistence,
      scratch,
      workspaceRoot: fixture.root,
      replies: [read, ask(), finish('Two steps in the plan; stopping as you asked.')],
    });
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      // The first start's acknowledgement is lost after the server recorded it.
      let lose = true;
      await page.route('**/api/v1/runs', async (route) => {
        if (route.request().method() === 'POST' && lose) {
          lose = false;
          await route.fetch();
          return route.abort('failed');
        }
        return route.continue();
      });
      await page.goto(server.url);
      await page.getByLabel('Provider').waitFor({ timeout: TIMEOUT });
      await startFromForm(page, 'Summarize notes/plan.md, then ask me before continuing.');
      await page.getByText('no reply arrived').waitFor({ timeout: TIMEOUT });
      // Submitting again reuses the request: it finds the run already started.
      await startFromForm(page, 'Summarize notes/plan.md, then ask me before continuing.');
      await page.waitForURL(/#\/runs\/[0-9a-f-]{36}$/, { timeout: TIMEOUT });
      const runUrl = page.url();

      // Activity appears without reloading: the read tool, then the question.
      await page.getByText('mcp_Read').first().waitFor({ timeout: TIMEOUT });
      await page.getByRole('form', { name: 'Answer the question' }).waitFor({ timeout: TIMEOUT });
      expect(await status(page).textContent()).toBe('Waiting for you');

      // Leave and come back in a fresh page: the same question, still pending.
      await page.close();
      const returned = await context.newPage();
      await returned.goto(runUrl);
      await returned.getByRole('form', { name: 'Answer the question' }).waitFor({ timeout: TIMEOUT });

      // The server drops every connection: the run is not shown as finished or failed, and the page reconnects.
      const restarted = server.dropConnections();
      await returned.getByText('Reconnecting').waitFor({ timeout: TIMEOUT });
      expect(await status(returned).textContent()).toBe('Waiting for you');
      await restarted;
      await returned.getByText('Live', { exact: true }).waitFor({ timeout: TIMEOUT });

      // The answer reaches the server twice (a repeated submission) and neither acknowledgement arrives. The run
      // continues once, and the page learns the outcome from the run's history, not from the lost replies.
      const answerStatuses: number[] = [];
      await returned.route('**/answer', async (route) => {
        answerStatuses.push((await route.fetch()).status(), (await route.fetch()).status());
        return route.abort('failed');
      });
      await returned.getByLabel('No').check();
      await returned.getByRole('button', { name: 'Send answer' }).click();

      await returned.locator('.message.final').waitFor({ timeout: TIMEOUT });
      expect(answerStatuses).toEqual([202, 200]);
      expect(await status(returned).textContent()).toBe('Completed');
      expect(await returned.locator('.message.final .text').textContent()).toBe(
        'Two steps in the plan; stopping as you asked.',
      );
      expect(await returned.locator('.event-question-answered strong').textContent()).toBe('false');
      // History is complete and each event appears once.
      const seqs = await returned
        .locator('.history > li')
        .evaluateAll((items) => items.map((item) => item.getAttribute('data-seq')));
      expect(seqs).toEqual(seqs.map((_, index) => String(index + 1)));

      await server.service.settled();
      expect(server.net.sent).toHaveLength(3);
      expect(replayedAnswer(server.net.sent)).toBe(false);
      expect(await returned.content()).not.toContain(SYNTHETIC_ACCESS);
    } finally {
      await context.close();
      await server.stop();
    }
  }, 60_000);

  test('typed choices and text arrive exactly; a second tab’s different answer is a visible conflict', async () => {
    const multiple = {
      prompt: 'Which apply?',
      input: {
        kind: 'choice',
        multiple: true,
        minSelections: 1,
        maxSelections: 2,
        options: [
          { label: 'Unknown', value: null },
          { label: 'Zero', value: 0 },
          { label: 'The text zero', value: '0' },
        ],
      },
    };
    const text = { prompt: 'Any notes?', input: { kind: 'text', minLength: 0, maxLength: 100 } };
    const server = await consoleServer({
      persistence,
      scratch,
      workspaceRoot: fixture.root,
      replies: [ask(multiple), ask(text), finish('Noted.')],
    });
    const context = await browser.newContext();
    try {
      const first = await context.newPage();
      await first.goto(server.url);
      await first.getByLabel('Provider').waitFor({ timeout: TIMEOUT });
      await startFromForm(first, 'Ask me two things.');
      await first.getByRole('form', { name: 'Answer the question' }).waitFor({ timeout: TIMEOUT });
      const second = await context.newPage();
      await second.goto(first.url());
      await second.getByRole('form', { name: 'Answer the question' }).waitFor({ timeout: TIMEOUT });
      // The second tab loses its connection and cannot read the run for a while, so it keeps showing the first
      // question — like a tab left open on another device.
      const blockReads = (route: import('playwright').Route) =>
        route.request().method() === 'GET' ? route.abort('failed') : route.continue();
      await second.route('**/api/v1/runs/**', blockReads);
      await server.dropConnections();
      await first.getByText('Live', { exact: true }).waitFor({ timeout: TIMEOUT });

      await first.getByLabel('Unknown').check();
      await first.getByLabel('The text zero').check();
      await first.getByRole('button', { name: 'Send answer' }).click();
      await first
        .getByRole('form', { name: 'Answer the question' })
        .getByText('Any notes?')
        .waitFor({ timeout: TIMEOUT });
      expect(replayedAnswer(server.net.sent)).toEqual([null, '0']);

      // The second tab still shows the first question; its different answer is refused, and it catches up.
      await second.getByLabel('Zero', { exact: true }).check();
      await second.getByRole('button', { name: 'Send answer' }).click();
      await second.getByText('A different answer to this question was already accepted.').waitFor({ timeout: TIMEOUT });
      await second.unroute('**/api/v1/runs/**', blockReads);
      await second
        .getByRole('form', { name: 'Answer the question' })
        .getByText('Any notes?')
        .waitFor({ timeout: TIMEOUT });

      // An empty text answer is a present answer.
      await first.getByRole('button', { name: 'Send answer' }).click();
      await first.locator('.message.final').waitFor({ timeout: TIMEOUT });
      await server.service.settled();
      expect(server.net.sent).toHaveLength(3);
      expect(replayedAnswer(server.net.sent)).toBe('');
    } finally {
      await context.close();
      await server.stop();
    }
  }, 60_000);

  test('a synthetic credential reaches no protected surface: page, API, stream, checkpoints or logs', async () => {
    const leak = `Here is the key ${SYNTHETIC_ACCESS} and ${SYNTHETIC_REFRESH}.`;
    const server = await consoleServer({
      persistence,
      scratch,
      workspaceRoot: fixture.root,
      replies: [
        finish(leak),
        () =>
          new Response(JSON.stringify({ type: 'error', error: { type: 'api_error', message: leak } }), {
            status: 500,
            headers: { 'content-type': 'application/json' },
          }),
      ],
    });
    const page = await browser.newPage();
    const surfaces: string[] = [];
    try {
      await page.goto(server.url);
      await page.getByLabel('Provider').waitFor({ timeout: TIMEOUT });
      // The goal itself is refused, not stored.
      await startFromForm(page, `Use ${SYNTHETIC_ACCESS} for this.`);
      await page.getByText('contains credential material').waitFor({ timeout: TIMEOUT });

      const runIds: string[] = [];
      for (const goal of ['Repeat a secret back to me.', 'Fail at the provider.']) {
        await page.goto(server.url);
        await page.getByLabel('Provider').waitFor({ timeout: TIMEOUT });
        await startFromForm(page, goal);
        await page.waitForURL(/#\/runs\/[0-9a-f-]{36}$/, { timeout: TIMEOUT });
        runIds.push(page.url().split('/').at(-1) as string);
        await page.locator('.facts .status-succeeded, .facts .status-failed').waitFor({ timeout: TIMEOUT });
        surfaces.push(await page.content());
      }
      expect(await page.locator('.outcome.failed').textContent()).toContain('provider failure');
      await server.service.settled();

      for (const runId of runIds) {
        const api = async (path: string) => (await fetch(`${server.url}/api/v1/runs/${runId}${path}`)).text();
        surfaces.push(await api(''), await api('/events?after=0'));
        // The raw event stream, read through the last recorded event.
        const stream = await fetch(`${server.url}/api/v1/runs/${runId}/stream?after=0`);
        const reader = (stream.body as ReadableStream<Uint8Array>).getReader();
        let text = '';
        while (!text.includes(': heartbeat') && !/"kind":"(succeeded|failed)"/.test(text)) {
          text += new TextDecoder().decode((await reader.read()).value);
        }
        await reader.cancel();
        surfaces.push(text);
        const stored = await db.admin`
          select coalesce(string_agg(convert_from(blob, 'UTF8'), ''), '') as text from checkpoints.checkpoint_blobs
            where thread_id = ${runId} and blob is not null
          union all select coalesce(string_agg(checkpoint::text || metadata::text, ''), '') from checkpoints.checkpoints
            where thread_id = ${runId}
          union all select coalesce(string_agg(convert_from(blob, 'UTF8'), ''), '') from checkpoints.checkpoint_writes
            where thread_id = ${runId}
          union all select coalesce(string_agg(payload::text, ''), '') from runtime.events where run_id = ${runId}
          union all select state::text || goal from runtime.runs where run_id = ${runId}`;
        surfaces.push(...stored.map((row: { text: string }) => row.text));
      }
      surfaces.push(server.logs.join('\n'), (await fetch(`${server.url}/api/v1/runs`)).statusText);
      expect(surfaces.join('\n')).toContain('[redacted credential]');
      for (const secret of [SYNTHETIC_ACCESS, SYNTHETIC_REFRESH]) {
        expect(surfaces.filter((surface) => surface.includes(secret))).toEqual([]);
      }
      expect(server.net.sent).toHaveLength(2);
    } finally {
      await page.close();
      await server.stop();
    }
  }, 60_000);

  test('cancelling a waiting run closes its question; nothing further is sent', async () => {
    const server = await consoleServer({ persistence, scratch, workspaceRoot: fixture.root, replies: [ask()] });
    const page = await browser.newPage();
    try {
      await page.goto(server.url);
      await page.getByLabel('Provider').waitFor({ timeout: TIMEOUT });
      await startFromForm(page, 'Ask, then wait.');
      await page.getByRole('form', { name: 'Answer the question' }).waitFor({ timeout: TIMEOUT });
      await page.getByRole('button', { name: 'Cancel run' }).click();
      await page.locator('.facts .status-cancelled').waitFor({ timeout: TIMEOUT });
      expect(await page.getByRole('form', { name: 'Answer the question' }).count()).toBe(0);
      expect(await page.getByRole('button', { name: 'Cancel run' }).count()).toBe(0);
      await page.getByText('Question closed without an answer (cancelled).').waitFor({ timeout: TIMEOUT });
      await server.service.settled();
      expect(server.net.sent).toHaveLength(1);
    } finally {
      await page.close();
      await server.stop();
    }
  }, 60_000);
});
