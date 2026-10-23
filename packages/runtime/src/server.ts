export const LISTEN_HOSTNAME = '127.0.0.1';
export const DEFAULT_PORT = 3000;

export type DatabaseStatus = 'unconfigured' | 'reachable' | 'unreachable';

export interface ReadinessReport {
  ready: false;
  stage: 'foundation';
  checks: {
    http: 'ok';
    database: DatabaseStatus;
    agentExecution: 'not_implemented';
  };
}

export interface ServerOptions {
  port: number;
  probeDatabase: () => Promise<DatabaseStatus>;
}

const json = (body: unknown, status: number) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store' } });

export async function readiness(probeDatabase: () => Promise<DatabaseStatus>): Promise<ReadinessReport> {
  return {
    ready: false,
    stage: 'foundation',
    checks: { http: 'ok', database: await probeDatabase(), agentExecution: 'not_implemented' },
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
        // Agent execution is not implemented in the foundation, so the service never reports itself ready.
        GET: async () => json(await readiness(options.probeDatabase), 503),
      },
    },
    fetch: () => json({ error: { code: 'not_found' } }, 404),
  });
}
