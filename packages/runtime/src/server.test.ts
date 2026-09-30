import { afterEach, describe, expect, test } from 'bun:test';
import { LISTEN_HOSTNAME, startServer } from './server.ts';

let server: ReturnType<typeof startServer> | undefined;

afterEach(() => {
  server?.stop(true);
  server = undefined;
});

const start = () => {
  server = startServer({ port: 0, probeDatabase: async () => 'reachable' });
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

  test('never reports agent readiness during the foundation stage', async () => {
    const response = await fetch(`${start()}/readyz`);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      ready: false,
      stage: 'foundation',
      checks: { http: 'ok', database: 'reachable', agentExecution: 'not_implemented' },
    });
  });

  test('exposes no other routes or mutating methods', async () => {
    const base = start();
    expect((await fetch(`${base}/`)).status).toBe(404);
    expect((await fetch(`${base}/api/v1/runs`, { method: 'POST' })).status).toBe(404);
    expect((await fetch(`${base}/healthz`, { method: 'POST' })).ok).toBe(false);
  });
});
