import type { ConsoleFiles } from './console.ts';
import { createRequestPolicy, SECURITY_HEADERS } from './request-policy.ts';

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

/** Whether runs can be served: configured, persistence ready and the run service composed. */
export type AgentExecutionStatus = 'ready' | 'unconfigured' | 'unavailable';

export interface ReadinessReport {
  ready: boolean;
  checks: {
    http: 'ok';
    persistence: PersistenceStatus;
    agentExecution: AgentExecutionStatus;
    console: 'ready' | 'unavailable';
  };
}

export interface ServerOptions {
  port: number;
  persistenceStatus: () => PersistenceStatus;
  /** Handles `/api/v1/*`; absent, the API answers 404 like any unknown path. */
  api?: (request: Request, server: { timeout(request: Request, seconds: number): void }) => Promise<Response>;
  /** The console's files once loaded; until then the page answers 503. */
  console?: () => ConsoleFiles | undefined;
  agentExecution?: () => AgentExecutionStatus;
  /** The browser-visible origin (RUNTIME_PUBLIC_ORIGIN); without it only loopback requests are accepted. */
  publicOrigin?: string;
}

const json = (body: unknown, status: number) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store' } });

const notFound = () => json({ error: { code: 'not_found' } }, 404);

export function readiness(
  persistence: PersistenceStatus,
  agentExecution: AgentExecutionStatus = 'unconfigured',
  console: 'ready' | 'unavailable' = 'unavailable',
): ReadinessReport {
  return {
    ready: persistence === 'ready' && agentExecution === 'ready' && console === 'ready',
    checks: { http: 'ok', persistence, agentExecution, console },
  };
}

/** Only files listed in the console's manifest are served; every other path is not found. */
function serveConsole(request: Request, files: ConsoleFiles | undefined): Response {
  const { pathname } = new URL(request.url);
  if (request.method !== 'GET' && request.method !== 'HEAD') return notFound();
  if (files === undefined) return json({ error: { code: 'service_unavailable' } }, 503);
  const file = files.get(pathname);
  if (file === undefined) return notFound();
  return new Response(request.method === 'HEAD' ? null : file.body, { headers: file.headers });
}

export function startServer(options: ServerOptions) {
  // The listener port is known only once bound when 0 was requested (tests); the policy follows the actual port.
  let effective = createRequestPolicy({ port: options.port, publicOrigin: options.publicOrigin });

  /** Every reply passes the request policy and carries the security headers. */
  const guarded =
    <A extends unknown[]>(handler: (request: Request, ...rest: A) => Response | Promise<Response>) =>
    async (request: Request, ...rest: A): Promise<Response> => {
      const refused = effective.check(request);
      const response =
        refused === undefined
          ? await handler(request, ...rest)
          : Response.json(
              {
                error: {
                  code: refused.code,
                  message: 'This request is not accepted from this address or page.',
                  retryable: false,
                  acceptance: 'not_accepted',
                },
              },
              { status: refused.status, headers: { 'cache-control': 'no-store' } },
            );
      for (const [name, value] of Object.entries(SECURITY_HEADERS)) response.headers.set(name, value);
      return response;
    };

  const api = options.api;
  const server = Bun.serve({
    hostname: LISTEN_HOSTNAME,
    port: options.port,
    development: false,
    routes: {
      '/healthz': {
        GET: guarded(() => json({ status: 'ok' }, 200)),
      },
      '/readyz': {
        GET: guarded(() => {
          const report = readiness(
            options.persistenceStatus(),
            options.agentExecution?.() ?? 'unconfigured',
            options.console?.() === undefined ? 'unavailable' : 'ready',
          );
          return json(report, report.ready ? 200 : 503);
        }),
      },
      '/api/v1/*':
        api === undefined ? guarded(notFound) : guarded((request, srv: Bun.Server<undefined>) => api(request, srv)),
    },
    fetch: guarded((request) =>
      options.console === undefined ? notFound() : serveConsole(request, options.console()),
    ),
  });
  if (options.port === 0) {
    effective = createRequestPolicy({ port: server.port as number, publicOrigin: options.publicOrigin });
  }
  return server;
}
