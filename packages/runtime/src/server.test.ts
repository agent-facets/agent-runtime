import { afterEach, describe, expect, test } from 'bun:test';
import { LISTEN_HOSTNAME, type PersistenceStatus, startServer } from './server.ts';

let server: ReturnType<typeof startServer> | undefined;
let status: PersistenceStatus = 'ready';

afterEach(() => {
  server?.stop(true);
  server = undefined;
  status = 'ready';
});

const start = () => {
  server = startServer({ port: 0, persistenceStatus: () => status });
  return `http://${LISTEN_HOSTNAME}:${server.port}`;
};

describe('foundation server', () => {
  test('listens only on loopback', () => {
    start();
    expect(server?.hostname).toBe('127.0.0.1');
  });

  test('reports liveness', async () => {
    const response = await fetch(`${start()}/healthz`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok' });
  });

  test('never reports agent readiness, even with persistence ready', async () => {
    const response = await fetch(`${start()}/readyz`);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      ready: false,
      stage: 'foundation',
      checks: { http: 'ok', persistence: 'ready', agentExecution: 'not_implemented' },
    });
  });

  test('reports the current persistence status on every request', async () => {
    const base = start();
    for (const next of ['starting', 'owned_elsewhere', 'schema_incompatible', 'ownership_lost'] as const) {
      status = next;
      const body = (await (await fetch(`${base}/readyz`)).json()) as { checks: { persistence: string } };
      expect(body.checks.persistence).toBe(next);
    }
  });

  test('exposes no other routes or mutating methods', async () => {
    const base = start();
    expect((await fetch(`${base}/`)).status).toBe(404);
    expect((await fetch(`${base}/api/v1/runs`, { method: 'POST' })).status).toBe(404);
    expect((await fetch(`${base}/healthz`, { method: 'POST' })).ok).toBe(false);
  });
});
