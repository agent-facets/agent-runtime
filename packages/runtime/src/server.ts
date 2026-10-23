export const LISTEN_HOSTNAME = '127.0.0.1';
export const DEFAULT_PORT = 3000;

export type PersistenceStatus =
  | 'unconfigured'
  | 'starting'
  | 'ready'
  | 'unavailable'
  | 'owned_elsewhere'
  | 'schema_incompatible'
  | 'ownership_lost'
  | 'stopping';

export interface ReadinessReport {
  ready: false;
  stage: 'foundation';
  checks: {
    http: 'ok';
    persistence: PersistenceStatus;
    agentExecution: 'not_implemented';
  };
}

export interface ServerOptions {
  port: number;
  persistenceStatus: () => PersistenceStatus;
}

const json = (body: unknown, status: number) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store' } });

export function readiness(persistence: PersistenceStatus): ReadinessReport {
  return {
    ready: false,
    stage: 'foundation',
    checks: { http: 'ok', persistence, agentExecution: 'not_implemented' },
  };
}

export function startServer(options: ServerOptions) {
  return Bun.serve({
    hostname: LISTEN_HOSTNAME,
    port: options.port,
    development: false,
    routes: {
      '/healthz': {
        GET: () => json({ status: 'ok' }, 200),
      },
      '/readyz': {
        // Agent execution is not implemented yet, so the service never reports itself ready.
        GET: () => json(readiness(options.persistenceStatus()), 503),
      },
    },
    fetch: () => json({ error: { code: 'not_found' } }, 404),
  });
}
