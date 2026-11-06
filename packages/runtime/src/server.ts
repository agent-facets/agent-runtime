import type { ConsoleFiles } from './console.ts';
import { createRequestPolicy, type Refusal, SECURITY_HEADERS } from './request-policy.ts';

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
  /**
   * Development only: the live-reloading console, in place of `console`. Its requests pass the same request checks
   * first; its live-update channel must come from this same origin too.
   */
  developmentConsole?: DevelopmentConsole;
}

/** Per-connection state of a development console live-update channel. */
export interface DevelopmentSocketData {
  readonly kind: 'development-console';
  upstream?: WebSocket;
  pending: (string | Uint8Array)[];
  pendingBytes: number;
  closed: boolean;
}

export interface DevelopmentConsole {
  /** Whether a request asks to open the live-update channel. */
  isUpgrade(request: Request): boolean;
  /** Serves an accepted request for the page or a development asset; `origin` is the one it was addressed to. */
  fetch(request: Request, origin: string): Promise<Response>;
  websocket: Bun.WebSocketHandler<DevelopmentSocketData>;
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

  const refusal = (refused: Refusal) =>
    Response.json(
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

  const withSecurityHeaders = (response: Response, keepContentSecurityPolicy = false) => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      if (keepContentSecurityPolicy && name === 'content-security-policy' && response.headers.has(name)) continue;
      response.headers.set(name, value);
    }
    return response;
  };

  /** Every reply passes the request policy and carries the security headers. */
  const guarded =
    <A extends unknown[]>(handler: (request: Request, ...rest: A) => Response | Promise<Response>) =>
    async (request: Request, ...rest: A): Promise<Response> => {
      const refused = effective.check(request);
      return withSecurityHeaders(refused === undefined ? await handler(request, ...rest) : refusal(refused));
    };

  const development = options.developmentConsole;
  /** The development console sets its own (development) content security policy; nothing else may. */
  const developmentFetch = async (request: Request, srv: Bun.Server<DevelopmentSocketData>) => {
    if (development === undefined) return withSecurityHeaders(notFound());
    if (development.isUpgrade(request)) {
      const refused = effective.checkUpgrade(request);
      if (refused !== undefined) return withSecurityHeaders(refusal(refused));
      const data: DevelopmentSocketData = { kind: 'development-console', pending: [], pendingBytes: 0, closed: false };
      if (srv.upgrade(request, { data })) return undefined;
      return withSecurityHeaders(json({ error: { code: 'bad_request' } }, 400));
    }
    const refused = effective.check(request);
    if (refused !== undefined) return withSecurityHeaders(refusal(refused));
    const origin = effective.originFor(request) as string;
    return withSecurityHeaders(await development.fetch(request, origin), true);
  };

  const api = options.api;
  const consoleReady = () =>
    development !== undefined || options.console?.() !== undefined ? ('ready' as const) : ('unavailable' as const);
  const server = Bun.serve<DevelopmentSocketData>({
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
            consoleReady(),
          );
          return json(report, report.ready ? 200 : 503);
        }),
      },
      '/api/v1/*':
        api === undefined
          ? guarded(notFound)
          : guarded((request, srv: Bun.Server<DevelopmentSocketData>) => api(request, srv)),
    },
    ...(development === undefined
      ? {
          fetch: guarded((request: Request) =>
            options.console === undefined ? notFound() : serveConsole(request, options.console()),
          ),
        }
      : { fetch: developmentFetch, websocket: development.websocket }),
  });
  if (options.port === 0) {
    effective = createRequestPolicy({ port: server.port as number, publicOrigin: options.publicOrigin });
  }
  return server;
}
