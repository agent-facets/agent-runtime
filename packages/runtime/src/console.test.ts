import { afterAll, describe, expect, test } from 'bun:test';
import { loadConsole } from './console.ts';
import { startServer } from './server.ts';

const files = await loadConsole();
const server = startServer({ port: 0, persistenceStatus: () => 'unconfigured', console: () => files });
const base = `http://127.0.0.1:${server.port}`;
afterAll(() => server.stop(true));

describe('the console from source', () => {
  test('is bundled once into a page and the scripts and styles it references', async () => {
    const page = new TextDecoder().decode(files.get('/')?.body);
    const referenced = [...page.matchAll(/(?:src|href)="\.\/([^"]+)"/g)].map((match) => `/${match[1]}`);
    expect(referenced.length).toBeGreaterThanOrEqual(2);
    expect([...files.keys()].sort()).toEqual(['/', ...referenced].sort());
    for (const path of referenced) expect(files.get(path)?.headers['cache-control']).toContain('immutable');
    expect(files.get('/')?.headers['cache-control']).toBe('no-store');
    // No server code or configuration reaches the browser bundle.
    const script = [...files.values()].map((file) => new TextDecoder().decode(file.body)).join('\n');
    for (const serverOnly of ['RUNTIME_STATE_DIR', 'DATABASE_URL', 'checkpoint_blobs', 'credentialSlot', 'flock']) {
      expect(script).not.toContain(serverOnly);
    }
  });
});

describe('serving the console', () => {
  test('serves exactly the listed files; every other path is not found', async () => {
    const page = await fetch(`${base}/`);
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toStartWith('text/html');
    expect(page.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await page.text()).toContain('<div id="root"></div>');
    const [asset] = [...files.keys()].filter((path) => path !== '/');
    expect((await fetch(`${base}${asset}`)).status).toBe(200);
    for (const path of [
      '/index.html',
      '/main.tsx',
      '/styles.css',
      '/../../etc/passwd',
      '/%2e%2e/package.json',
      '/workspace/README.md',
    ]) {
      expect((await fetch(`${base}${path}`)).status).toBe(404);
    }
    expect((await fetch(`${base}/`, { method: 'POST', headers: { origin: base } })).status).toBe(404);
    expect((await fetch(`${base}/`, { headers: { host: 'evil.example' } })).status).toBe(403);
  });

  test('before the console is loaded the page is unavailable, not empty', async () => {
    const pending = startServer({ port: 0, persistenceStatus: () => 'starting', console: () => undefined });
    try {
      expect((await fetch(`http://127.0.0.1:${pending.port}/`)).status).toBe(503);
    } finally {
      pending.stop(true);
    }
  });
});
