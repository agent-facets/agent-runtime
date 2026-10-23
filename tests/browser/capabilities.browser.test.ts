// Browser smoke check for command runs: the built console in headless Chromium against the production API and run
// service, a scripted Anthropic network and the bundled synthetic MCP server. Command starts, inspection, provenance
// and both providers are tested at the API and service level; this only shows the console can start an installed
// command and display what the run retained and used.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser } from 'playwright';
import { openPersistence, type Persistence } from '../../packages/runtime/src/persistence/persistence.ts';
import type { SentInference } from '../support/anthropic-network.ts';
import { sharedBrowser } from '../support/browser.ts';
import { mcpConsole } from '../support/mcp-console.ts';
import { one, text } from '../support/mcp-delegate-scenario.ts';
import { SLOT_VALUE, wire } from '../support/mcp-service.ts';
import { createScratchDatabase, type ScratchDatabase } from '../support/scratch-database.ts';

let db: ScratchDatabase;
let persistence: Persistence;
let browser: Browser;
const scratch = mkdtempSync(join(tmpdir(), 'agent-runtime-capabilities-browser-'));
beforeAll(async () => {
  db = await createScratchDatabase();
  persistence = await openPersistence({ url: db.url, onFault: () => {} });
  browser = await sharedBrowser();
});
afterAll(async () => {
  await persistence.close();
  await db.drop();
  rmSync(scratch, { recursive: true, force: true });
});

const TIMEOUT = 15_000;
const LIST = { repository: 'owner/repo-a' };

describe('command runs in the console', () => {
  test('smoke: start an installed command and see what the run retained and used', async () => {
    const server = await mcpConsole({
      scratch,
      persistence,
      grants: [{ name: 'list_items', argumentEquals: LIST }],
      replies: [
        (request: SentInference) => one('anthropic', 'r1', ['call_r1', wire(request, 'list_items'), LIST]),
        () => text('anthropic', 'r2', 'Two items.'),
      ],
    });
    const page = await browser.newPage();
    try {
      await page.goto(server.url);
      await page.getByLabel('Provider').waitFor({ timeout: TIMEOUT });
      await page.getByLabel('Installed command').check();
      const select = page.locator('select[name="command"]');
      await select.waitFor({ timeout: TIMEOUT });
      await select.selectOption('command:sync');
      await page.getByLabel('Arguments').fill('owner/repo-a');
      await page.getByRole('button', { name: 'Start' }).click();
      await page.waitForURL(/#\/runs\/[0-9a-f-]{36}$/, { timeout: TIMEOUT });

      await page.locator('.message.final').waitFor({ timeout: TIMEOUT });
      const panel = page.locator('section.capabilities');
      await panel.getByText('— called').waitFor({ timeout: TIMEOUT });
      expect(await panel.textContent()).toContain('command:sync');
      expect(await page.content()).not.toContain(SLOT_VALUE);
      await server.service.settled();
      expect(server.net.sent).toHaveLength(2);
      expect(server.witness().calls).toEqual(['list_items']);
    } finally {
      await page.close();
      await server.stop();
    }
  }, 60_000);
});
