import { afterEach, describe, expect, test } from 'bun:test';
import { type AgentExecutionStatus, LISTEN_HOSTNAME, type PersistenceStatus, startServer } from './server.ts';

let server: ReturnType<typeof startServer> | undefined;
let status: PersistenceStatus = 'ready';
let execution: AgentExecutionStatus = 'unconfigured';

afterEach(() => {
  server?.stop(true);
  server = undefined;
  status = 'ready';
  execution = 'unconfigured';
});

const start = (options: Partial<Parameters<typeof startServer>[0]> = {}) => {
  server = startServer({ port: 0, persistenceStatus: () => status, agentExecution: () => execution, ...options });
  return `http://${LISTEN_HOSTNAME}:${server.port}`;
};

describe('server', () => {
  test('listens only on loopback', () => {
    start();
    expect(server?.hostname).toBe('127.0.0.1');
  });

  test('reports liveness', async () => {
    const response = await fetch(`${start()}/healthz`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok' });
  });

  test('is ready only when persistence, agent execution and the console are', async () => {
    const files = new Map([['/', { body: new Uint8Array(), headers: { 'content-type': 'text/html' } }]]);
    const base = start({ console: () => files });
    const report = async () => {
      const response = await fetch(`${base}/readyz`);
      return [response.status, await response.json()];
    };
    expect(await report()).toEqual([
      503,
      { ready: false, checks: { http: 'ok', persistence: 'ready', agentExecution: 'unconfigured', console: 'ready' } },
    ]);
    execution = 'ready';
    expect((await report())[0]).toBe(200);
    status = 'ownership_lost';
    expect(await report()).toEqual([
      503,
      {
        ready: false,
        checks: { http: 'ok', persistence: 'ownership_lost', agentExecution: 'ready', console: 'ready' },
      },
    ]);
  });

  test('reports the current persistence status on every request', async () => {
    const base = start();
    for (const next of ['starting', 'owned_elsewhere', 'schema_incompatible', 'ownership_lost'] as const) {
      status = next;
      const body = (await (await fetch(`${base}/readyz`)).json()) as { checks: { persistence: string } };
      expect(body.checks.persistence).toBe(next);
    }
  });

  test('without an API or console, only health and readiness exist', async () => {
    const base = start();
    expect((await fetch(`${base}/`)).status).toBe(404);
    expect((await fetch(`${base}/api/v1/runs`, { method: 'POST', headers: { origin: base } })).status).toBe(404);
    expect((await fetch(`${base}/healthz`, { method: 'POST', headers: { origin: base } })).ok).toBe(false);
  });
});

describe('request policy', () => {
  const PUBLIC = 'https://agent-runtime.example.ts.net';

  test('only the configured private address and loopback are served; forged hosts are refused', async () => {
    const base = start({ publicOrigin: PUBLIC });
    const port = server?.port;
    const get = (host: string) => fetch(`${base}/healthz`, { headers: { host } });
    for (const host of [
      'agent-runtime.example.ts.net',
      `127.0.0.1:${port}`,
      `localhost:${port}`,
      'AGENT-RUNTIME.example.ts.net',
    ]) {
      expect((await get(host)).status).toBe(200);
    }
    for (const host of [
      'evil.example',
      'agent-runtime.example.ts.net:8443',
      `127.0.0.1:${(port ?? 0) + 1}`,
      '127.0.0.1',
      'agent-runtime.example.ts.net.evil',
    ]) {
      const refused = await get(host);
      expect(refused.status).toBe(403);
      expect(((await refused.json()) as { error: { code: string } }).error.code).toBe('forbidden');
    }
    // A forwarded host never stands in for the real one.
    expect(
      (
        await fetch(`${base}/healthz`, {
          headers: { host: 'evil.example', 'x-forwarded-host': 'agent-runtime.example.ts.net' },
        })
      ).status,
    ).toBe(403);
  });

  test('changes are accepted only from the same origin as the host', async () => {
    let handled = 0;
    const base = start({
      publicOrigin: PUBLIC,
      api: async () => {
        handled++;
        return Response.json({ ok: true });
      },
    });
    const post = (headers: Record<string, string>) =>
      fetch(`${base}/api/v1/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: '{}',
      });
    expect(
      (await post({ host: 'agent-runtime.example.ts.net', origin: PUBLIC, 'sec-fetch-site': 'same-origin' })).status,
    ).toBe(200);
    expect((await post({ origin: base })).status).toBe(200);
    const refused: Record<string, string>[] = [
      { host: 'agent-runtime.example.ts.net' },
      { host: 'agent-runtime.example.ts.net', origin: 'null' },
      { host: 'agent-runtime.example.ts.net', origin: 'https://evil.example' },
      { host: 'agent-runtime.example.ts.net', origin: 'http://agent-runtime.example.ts.net' },
      { host: 'agent-runtime.example.ts.net', origin: base },
      { host: 'agent-runtime.example.ts.net', origin: PUBLIC, 'sec-fetch-site': 'cross-site' },
      { host: 'agent-runtime.example.ts.net', origin: PUBLIC, 'sec-fetch-site': 'same-site' },
    ];
    for (const headers of refused) expect((await post(headers)).status).toBe(403);
    expect(handled).toBe(2);
  });

  test('no response grants cross-origin access, and every response carries the security headers', async () => {
    const base = start({ api: async () => Response.json({ ok: true }) });
    for (const response of [
      await fetch(`${base}/healthz`, { headers: { origin: 'https://evil.example' } }),
      await fetch(`${base}/api/v1/options`, {
        method: 'OPTIONS',
        headers: { origin: base, 'access-control-request-method': 'POST' },
      }),
      await fetch(`${base}/api/v1/options`),
      await fetch(`${base}/healthz`, { headers: { host: 'evil.example' } }),
    ]) {
      expect(response.headers.get('access-control-allow-origin')).toBeNull();
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
      expect(response.headers.get('x-frame-options')).toBe('DENY');
      expect(response.headers.get('content-security-policy')).toContain("default-src 'none'");
      expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    }
  });
});
