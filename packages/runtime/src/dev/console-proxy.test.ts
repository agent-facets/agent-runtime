import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HTMLBundle } from 'bun';
import { SECURITY_HEADERS } from '../request-policy.ts';
import { LISTEN_HOSTNAME, startServer } from '../server.ts';
import { createDevelopmentConsole, developmentContentSecurityPolicy, inlineScriptHashes } from './console-proxy.ts';
import { type ConsoleServer, startConsoleServer } from './console-server.ts';

// A disposable console source, so live-reload edits never touch the real console.
const fixture = mkdtempSync(join(tmpdir(), 'agent-runtime-dev-console-'));
writeFileSync(
  join(fixture, 'index.html'),
  '<!doctype html><html><head><link rel="stylesheet" href="./styles.css" /></head>' +
    '<body><div id="root"></div><script type="module" src="./main.ts"></script></body></html>',
);
writeFileSync(join(fixture, 'main.ts'), 'document.getElementById("root")?.append("fixture");\n');
writeFileSync(join(fixture, 'styles.css'), '.fixture { color: red; }\n');

const PUBLIC_HOST = 'agent-runtime.example.ts.net';
let consoleServer: ConsoleServer;
let server: ReturnType<typeof startServer> | undefined;

beforeAll(async () => {
  const bundle = (await import(join(fixture, 'index.html'))).default as HTMLBundle;
  consoleServer = await startConsoleServer(bundle);
});
afterAll(async () => {
  await consoleServer.stop();
  rmSync(fixture, { recursive: true, force: true });
});
afterEach(async () => {
  await server?.stop(true);
  server = undefined;
});

const start = (socket = consoleServer.socket) => {
  server = startServer({
    port: 0,
    persistenceStatus: () => 'ready',
    publicOrigin: `https://${PUBLIC_HOST}`,
    developmentConsole: createDevelopmentConsole({ socket }),
  });
  return `http://${LISTEN_HOSTNAME}:${server.port}`;
};

const publicHost = { host: PUBLIC_HOST };

/** Opens the live-update channel; resolves with how it went, and the socket when it opened. */
function openChannel(base: string, headers: Record<string, string>, onMessage?: (kind: string, ws: WebSocket) => void) {
  return new Promise<{ outcome: 'opened' | 'refused'; ws?: WebSocket }>((resolve) => {
    const ws = new WebSocket(`${base.replace('http', 'ws')}/_bun/hmr`, { headers });
    ws.binaryType = 'arraybuffer';
    ws.onmessage = (event) => {
      const kind = String.fromCharCode(new Uint8Array(event.data as ArrayBuffer)[0] ?? 0);
      if (kind === 'V') resolve({ outcome: 'opened', ws });
      onMessage?.(kind, ws);
    };
    ws.onerror = () => resolve({ outcome: 'refused' });
  });
}

describe('development console relay', () => {
  test('serves the page with the development policy: its bootstrap by hash, live updates from this origin', async () => {
    const base = start();
    const page = await fetch(`${base}/`, { headers: publicHost });
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('data-bun-dev-server-script');
    const hashes = inlineScriptHashes(html);
    expect(hashes.length).toBeGreaterThan(0);
    expect(page.headers.get('content-security-policy')).toBe(
      developmentContentSecurityPolicy(`https://${PUBLIC_HOST}`, hashes),
    );
    expect(page.headers.get('content-security-policy')).toContain(`connect-src 'self' wss://${PUBLIC_HOST}`);
    expect(page.headers.get('cache-control')).toBe('no-store');
    for (const name of ['x-frame-options', 'x-content-type-options', 'cross-origin-resource-policy']) {
      expect(page.headers.get(name)).toBe(SECURITY_HEADERS[name] as string);
    }
    const script = html.match(/src="([^"]+)"/)?.[1] ?? '';
    const stylesheet = html.match(/href="(\/_bun\/asset\/[^"]+)"/)?.[1] ?? '';
    expect((await fetch(`${base}${script}`, { headers: publicHost })).status).toBe(200);
    const css = await fetch(`${base}${stylesheet}`, { headers: publicHost });
    expect(await css.text()).toContain('fixture');
  });

  test('applies the request checks before relaying anything', async () => {
    const base = start();
    const html = await (await fetch(`${base}/`, { headers: publicHost })).text();
    const script = html.match(/src="([^"]+)"/)?.[1] ?? '';
    for (const path of ['/', script]) {
      expect((await fetch(`${base}${path}`, { headers: { host: 'forged.example' } })).status).toBe(403);
    }
    // A development report changes server state, so it must come from the console's own origin.
    const report = await fetch(`${base}/_bun/unref`, { method: 'POST', headers: publicHost, body: 'x' });
    expect(report.status).toBe(403);
  });

  test('relays only the page, its assets and the development reports; nothing else Bun serves', async () => {
    const base = start();
    for (const path of [
      '/packages/runtime/src/config.ts',
      '/main.ts',
      '/.well-known/appspecific/com.chrome.devtools.json',
      '/_bun/hmr',
      '/_bun/src/main.ts',
      '/_bun/client/../../etc/passwd',
      '/index.html',
    ]) {
      expect((await fetch(`${base}${path}`, { headers: publicHost })).status).toBe(404);
    }
    const posted = await fetch(`${base}/_bun/client/x.js`, {
      method: 'POST',
      headers: { ...publicHost, origin: `https://${PUBLIC_HOST}` },
      body: 'x',
    });
    expect(posted.status).toBe(404);
  });

  test('opens the live-update channel only from the console’s own origin and address', async () => {
    const base = start();
    const own = await openChannel(base, { ...publicHost, origin: `https://${PUBLIC_HOST}` });
    expect(own.outcome).toBe('opened');
    own.ws?.close();
    for (const headers of [
      publicHost,
      { ...publicHost, origin: 'null' },
      { ...publicHost, origin: 'https://foreign.example' },
      { ...publicHost, origin: `http://${PUBLIC_HOST}` },
      { host: 'forged.example', origin: 'https://forged.example' },
      { ...publicHost, origin: `https://${PUBLIC_HOST}`, 'sec-fetch-site': 'cross-site' },
    ]) {
      expect((await openChannel(base, headers)).outcome).toBe('refused');
    }
  });

  test('an edited stylesheet reaches an open page as a live update', async () => {
    const base = start();
    const html = await (await fetch(`${base}/`, { headers: publicHost })).text();
    const generation = (html.match(/src="([^"]+)"/)?.[1] ?? '').slice(-11, -3);
    let updated: () => void = () => {};
    const update = new Promise<void>((resolve) => {
      updated = resolve;
    });
    const channel = await openChannel(base, { ...publicHost, origin: `https://${PUBLIC_HOST}` }, (kind, ws) => {
      // As Bun's development client does: subscribe, name the page, report its bundle generation.
      if (kind === 'V') for (const message of ['she', 'n/', `i${generation}`]) ws.send(message);
      if (kind === 'u') updated();
    });
    expect(channel.outcome).toBe('opened');
    // An edit made before the subscription or file watch is in place goes unannounced, so edit until one is.
    let received = false;
    void update.then(() => {
      received = true;
    });
    for (let edit = 0; !received && edit < 40; edit++) {
      writeFileSync(join(fixture, 'styles.css'), `.fixture { color: green; }\n.edited-${edit} { color: blue; }\n`);
      await Promise.race([update, Bun.sleep(250)]);
    }
    expect(received).toBe(true);
    channel.ws?.close();
  });

  test('answers unavailable while the development console server is down', async () => {
    const base = start(join(fixture, 'absent.sock'));
    expect((await fetch(`${base}/`, { headers: publicHost })).status).toBe(503);
  });
});

describe('production serving', () => {
  test('has no development routes or live-update channel, and keeps the production policy', async () => {
    const files = new Map([
      ['/', { body: new TextEncoder().encode('<!doctype html>'), headers: { 'content-type': 'text/html' } }],
    ]);
    server = startServer({ port: 0, persistenceStatus: () => 'ready', console: () => files });
    const base = `http://${LISTEN_HOSTNAME}:${server.port}`;
    const page = await fetch(`${base}/`);
    expect(page.headers.get('content-security-policy')).toBe(SECURITY_HEADERS['content-security-policy'] as string);
    for (const path of ['/_bun/hmr', '/_bun/client/index.js', '/_bun/unref']) {
      expect((await fetch(`${base}${path}`)).status).toBe(404);
    }
    const channel = await openChannel(base, { origin: `http://${LISTEN_HOSTNAME}:${server.port}` });
    expect(channel.outcome).toBe('refused');
  });
});

describe('development policy helpers', () => {
  test('hashes inline scripts only', () => {
    const hashes = inlineScriptHashes('<script src="/a.js"></script><script>alert(1)</script><script></script>');
    expect(hashes).toEqual([`sha256-${new Bun.CryptoHasher('sha256').update('alert(1)').digest('base64')}`]);
  });

  test('allows live updates only from the page’s own origin, over the matching scheme', () => {
    expect(developmentContentSecurityPolicy('http://127.0.0.1:3000')).toContain(
      "connect-src 'self' ws://127.0.0.1:3000",
    );
    const policy = developmentContentSecurityPolicy('https://host.example', ['sha256-abc']);
    expect(policy).toContain("script-src 'self' blob: 'sha256-abc'");
    expect(policy).not.toContain('unsafe-eval');
    expect(policy).toContain("frame-ancestors 'none'");
  });
});
