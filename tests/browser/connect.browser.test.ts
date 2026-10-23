// Connecting a provider from the console (tasks 12.17 and 14.3): the built console in headless Chromium against the
// runtime's API, with scripted issuers as the witness of every exchange. The providers' own pages are never loaded:
// for Anthropic the test reads the sign-in link and pastes what that page would show; for OpenAI the scripted issuer
// approves the device code as OpenAI's page would.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
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

describe('connecting OpenAI from the console', () => {
  const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const jwt = (claims: Record<string, unknown>) => `${b64({ alg: 'RS256' })}.${b64(claims)}.c3ludGhldGlj`;
  const VERIFIER = 'synthetic-browser-verifier-0123456789abcdefghijklmn';
  const OPENAI_ACCESS = jwt({ exp: Math.floor(Date.now() / 1000) + 864_000, sub: 'browser-openai-access' });
  const OPENAI_REFRESH = 'synthetic-browser-openai-refresh-token';
  const deviceCode = () =>
    Response.json({ device_auth_id: 'deviceauth_browser', user_code: 'BRWS-24680', interval: '1' });
  const waiting = () => new Response(null, { status: 403 });
  const approval = () =>
    Response.json({
      authorization_code: 'synthetic-browser-authorization-code',
      code_verifier: VERIFIER,
      code_challenge: createHash('sha256').update(VERIFIER).digest('base64url'),
    });
  const issued = () =>
    Response.json({
      id_token: jwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct_browser' } }),
      access_token: OPENAI_ACCESS,
      refresh_token: OPENAI_REFRESH,
    });

  async function openOpenAI(url: string) {
    const opened = await openConsole(url);
    // Nothing may reach OpenAI's real pages from a test.
    await opened.context.route('https://auth.openai.com/**', (route) => route.abort());
    await opened.page.getByLabel('Provider').selectOption('openai');
    return opened;
  }

  test('the console shows the code and page; approval elsewhere is noticed; no paste, run or model request', async () => {
    const server = await consoleServer({
      persistence,
      scratch,
      workspaceRoot: fixture.root,
      replies: [],
      openai: [deviceCode(), waiting(), waiting(), approval(), issued()],
    });
    const { context, page } = await openOpenAI(server.url);
    try {
      await page.getByText('Connect it below.').waitFor({ timeout: TIMEOUT });
      await page.getByLabel('Goal').fill('A goal written before connecting OpenAI.');
      await page.getByRole('button', { name: 'Connect OpenAI' }).click();

      const link = page.getByRole('link', { name: 'Open OpenAI sign-in' });
      await link.waitFor({ timeout: TIMEOUT });
      expect(await link.getAttribute('href')).toBe('https://auth.openai.com/codex/device');
      expect(await link.getAttribute('target')).toBe('_blank');
      expect(await link.getAttribute('rel')).toBe('noopener noreferrer');
      expect(await page.locator('code.user-code').textContent()).toBe('BRWS-24680');
      expect(await page.getByRole('textbox', { name: 'Code', exact: true }).count()).toBe(0);

      await page.getByText('Connected. You can start tasks now.').waitFor({ timeout: TIMEOUT });
      await page.getByRole('button', { name: 'Reconnect' }).waitFor({ timeout: TIMEOUT });
      expect(await page.getByLabel('Provider').inputValue()).toBe('openai');
      expect(await page.getByLabel('Goal').inputValue()).toBe('A goal written before connecting OpenAI.');
      expect(await page.getByText('Connect it below.').count()).toBe(0);

      expect(server.openaiSent).toEqual([
        '/api/accounts/deviceauth/usercode',
        '/api/accounts/deviceauth/token',
        '/api/accounts/deviceauth/token',
        '/api/accounts/deviceauth/token',
        '/oauth/token',
      ]);
      expect(server.net.sent).toEqual([]);
      expect(server.tokens.sent).toEqual([]);
      const stored = await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }));
      const html = await page.content();
      for (const secret of [OPENAI_ACCESS, OPENAI_REFRESH, VERIFIER, 'synthetic-browser-authorization-code']) {
        expect(stored).not.toContain(secret);
        expect(html).not.toContain(secret);
        expect(server.logs.join('\n')).not.toContain(secret);
      }
    } finally {
      await context.close();
      await server.stop();
    }
  });

  test('cancelling while waiting closes the login; a reload finds a login still waiting', async () => {
    const server = await consoleServer({
      persistence,
      scratch,
      workspaceRoot: fixture.root,
      replies: [],
      openai: [deviceCode(), ...Array.from({ length: 60 }, waiting)],
    });
    const { context, page } = await openOpenAI(server.url);
    try {
      await page.getByRole('button', { name: 'Connect OpenAI' }).click();
      await page.locator('code.user-code').waitFor({ timeout: TIMEOUT });
      await page.reload();
      await page.getByLabel('Provider').selectOption('openai');
      await page.getByRole('button', { name: 'Connect OpenAI' }).click();
      expect(await page.locator('code.user-code').textContent()).toBe('BRWS-24680');
      expect(server.openaiSent.filter((path) => path.endsWith('/usercode'))).toHaveLength(1);

      await page.getByRole('button', { name: 'Cancel' }).click();
      await page.getByRole('button', { name: 'Connect OpenAI' }).waitFor({ timeout: TIMEOUT });
      expect(server.openaiSent).not.toContain('/oauth/token');
      expect(server.net.sent).toEqual([]);
    } finally {
      await context.close();
      await server.stop();
    }
  });
});
