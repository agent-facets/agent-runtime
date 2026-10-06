// Connecting a provider from the console (tasks 12.17 and 21.2): the built console in headless Chromium against the
// runtime's API, with scripted networks as the witness of every exchange. Anthropic's own page is never loaded: the
// test reads the sign-in link and pastes what that page would show. OpenAI has no integration in this build.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser, BrowserContext, Page } from 'playwright';
import { openPersistence, type Persistence } from '../../packages/runtime/src/persistence/persistence.ts';
import { createFixture } from '../../packages/runtime/test-support/workspace.ts';
import { sharedBrowser } from '../support/browser.ts';
import { consoleServer } from '../support/console-server.ts';
import { createScratchDatabase, type ScratchDatabase } from '../support/scratch-database.ts';

let db: ScratchDatabase;
let persistence: Persistence;
let browser: Browser;
const fixture = createFixture();
fixture.write('notes/plan.md', 'alpha\nbeta\n');
const scratch = mkdtempSync(join(tmpdir(), 'agent-runtime-connect-'));

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
const CODE = 'synthetic-console-browser-code';
const NEW_ACCESS = 'sk-ant-oat01-console-browser-login-access';
const NEW_REFRESH = 'sk-ant-ort01-console-browser-login-refresh';
const granted = () => Response.json({ access_token: NEW_ACCESS, refresh_token: NEW_REFRESH, expires_in: 3600 });

async function openConsole(url: string): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext();
  // Nothing may reach Anthropic's real sign-in page from a test.
  await context.route('https://claude.ai/**', (route) => route.abort());
  const page = await context.newPage();
  await page.goto(`${url}/`);
  return { context, page };
}

/** The sign-in link the console offers, and the text Anthropic's page would show for it. */
async function signIn(page: Page, code = CODE) {
  const link = page.getByRole('link', { name: 'Open Anthropic sign-in' });
  await link.waitFor({ timeout: TIMEOUT });
  const href = (await link.getAttribute('href')) as string;
  return { link, href, pasted: `${code}#${new URL(href).searchParams.get('state')}` };
}

const codeBox = (page: Page) => page.getByRole('textbox', { name: 'Code', exact: true });

async function paste(page: Page, text: string) {
  await codeBox(page).fill(text);
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
}

describe('connecting Anthropic from the console', () => {
  test('connect without a terminal: the goal being written survives, readiness updates, no run or model request', async () => {
    const server = await consoleServer({
      persistence,
      scratch,
      workspaceRoot: fixture.root,
      replies: [],
      credential: false,
      tokens: [granted()],
    });
    const { context, page } = await openConsole(server.url);
    try {
      await page.getByText('Connect it below.').waitFor({ timeout: TIMEOUT });
      await page.getByLabel('Goal').fill('A goal written before connecting.');
      await page.getByRole('button', { name: 'Connect Anthropic' }).click();

      const { link, href, pasted } = await signIn(page);
      expect(new URL(href).origin).toBe('https://claude.ai');
      expect(await link.getAttribute('target')).toBe('_blank');
      expect(await link.getAttribute('rel')).toBe('noopener noreferrer');

      // Text from another sign-in is refused without using up this one.
      await paste(page, `${CODE}#${'f'.repeat(32)}`);
      await page.getByText('That is not the code from this sign-in').waitFor({ timeout: TIMEOUT });
      expect(await codeBox(page).inputValue()).toBe('');
      expect(server.tokens.sent).toEqual([]);

      await paste(page, pasted);
      await page.getByText('Connected. You can start tasks now.').waitFor({ timeout: TIMEOUT });
      await page.getByRole('button', { name: 'Reconnect' }).waitFor({ timeout: TIMEOUT });
      expect(await page.getByLabel('Provider').inputValue()).toBe('anthropic');
      expect(await page.locator('select[name="provider"] option').first().textContent()).not.toContain(
        'reauthorization',
      );
      expect(await page.getByLabel('Goal').inputValue()).toBe('A goal written before connecting.');
      expect(await page.getByRole('button', { name: 'Start' }).isEnabled()).toBe(true);

      // One exchange, no model request and no run; the code went nowhere else.
      expect(server.tokens.sent).toHaveLength(1);
      expect(server.tokens.sent[0]).toMatchObject({ grant_type: 'authorization_code', code: CODE });
      expect(server.net.sent).toEqual([]);
      await page.getByText('No runs yet.').waitFor({ timeout: TIMEOUT });
      const stored = await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }));
      const html = await page.content();
      for (const secret of [CODE, NEW_ACCESS, NEW_REFRESH]) {
        expect(stored).not.toContain(secret);
        expect(html).not.toContain(secret);
        expect(server.logs.join('\n')).not.toContain(secret);
      }
    } finally {
      await context.close();
      await server.stop();
    }
  });

  test('reconnecting when the reply is lost: the console reads the outcome back instead of sending the code again', async () => {
    const server = await consoleServer({
      persistence,
      scratch,
      workspaceRoot: fixture.root,
      replies: [],
      tokens: [granted()],
    });
    const { context, page } = await openConsole(server.url);
    try {
      await page.route('**/api/v1/auth/anthropic/complete', async (route) => {
        await route.fetch();
        await route.abort('failed');
      });
      await page.getByRole('button', { name: 'Reconnect' }).click();
      await paste(page, (await signIn(page)).pasted);
      await page.getByText('Connected. You can start tasks now.').waitFor({ timeout: TIMEOUT });
      expect(server.tokens.sent).toHaveLength(1);
      expect(server.net.sent).toEqual([]);
    } finally {
      await context.close();
      await server.stop();
    }
  });

  test('a refused code ends that login; a reload finds the login in progress; cancelling closes it', async () => {
    const server = await consoleServer({
      persistence,
      scratch,
      workspaceRoot: fixture.root,
      replies: [],
      credential: false,
      tokens: [new Response(null, { status: 400 })],
    });
    const { context, page } = await openConsole(server.url);
    try {
      await page.getByRole('button', { name: 'Connect Anthropic' }).click();
      await paste(page, (await signIn(page)).pasted);
      await page.getByText('Anthropic refused the code').waitFor({ timeout: TIMEOUT });
      await page.getByRole('button', { name: 'Connect Anthropic' }).waitFor({ timeout: TIMEOUT });
      expect(await page.getByText('Connect it below.').count()).toBe(1);

      // A new login survives a reload: Connect returns the same sign-in instead of starting another.
      await page.getByRole('button', { name: 'Connect Anthropic' }).click();
      const before = (await signIn(page)).href;
      await page.reload();
      await page.getByRole('button', { name: 'Connect Anthropic' }).click();
      expect((await signIn(page)).href).toBe(before);

      await codeBox(page).fill('typed, then abandoned');
      await page.getByRole('button', { name: 'Cancel' }).click();
      await page.getByRole('button', { name: 'Connect Anthropic' }).waitFor({ timeout: TIMEOUT });
      expect(await codeBox(page).count()).toBe(0);
      expect(server.tokens.sent).toHaveLength(1);
      expect(server.net.sent).toEqual([]);
    } finally {
      await context.close();
      await server.stop();
    }
  });
});

describe('a configured OpenAI in a build without its integration', () => {
  test('is shown as unavailable with no way to connect or start, even when authorized; nothing is sent', async () => {
    const server = await consoleServer({
      persistence,
      scratch,
      workspaceRoot: fixture.root,
      replies: [],
      openai: true,
    });
    const { context, page } = await openConsole(server.url);
    try {
      await page.getByRole('button', { name: 'Reconnect' }).waitFor({ timeout: TIMEOUT });
      const option = page.locator('select[name="provider"] option[value="openai"]');
      expect(await option.textContent()).toContain('(integration unavailable)');
      await page.getByLabel('Goal').fill('A goal for OpenAI.');
      await page.getByLabel('Provider').selectOption('openai');
      await page
        .getByText('This build has no OpenAI integration, so it cannot run tasks.')
        .waitFor({ timeout: TIMEOUT });
      expect(await page.getByRole('button', { name: 'Start' }).isDisabled()).toBe(true);
      expect(await page.getByRole('button', { name: /Connect|Reconnect/ }).count()).toBe(0);
      expect(await page.getByText('Connect it below.').count()).toBe(0);

      // A console from an earlier build asking for the retired OpenAI login gets the ordinary not-found answer.
      const stale = await page.evaluate(async () => {
        const response = await fetch('/api/v1/auth/openai/begin', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        });
        return { status: response.status, body: (await response.json()) as { error: { code: string } } };
      });
      expect([stale.status, stale.body.error.code]).toEqual([404, 'not_found']);

      await page.getByText('No runs yet.').waitFor({ timeout: TIMEOUT });
      expect(server.net.sent).toEqual([]);
      expect(server.tokens.sent).toEqual([]);
    } finally {
      await context.close();
      await server.stop();
    }
  });
});
