// Development only. Relays the console page, its development assets and Bun's live-update channel from the private
// development console server (console-server.ts) to the runtime's own listener. The runtime has already applied its
// request checks; this relay forwards only the few paths the live-reloading page needs and nothing else, so no
// other development route (source files, editor hooks, workspace discovery) is reachable from the browser.
import type { DevelopmentConsole, DevelopmentSocketData } from '../server.ts';

/** The live-update channel Bun's development client opens. */
export const HMR_PATH = '/_bun/hmr';

const SAFE_SEGMENT = '[A-Za-z0-9._-]{1,200}';
const READABLE = [/^\/$/, new RegExp(`^/_bun/client/${SAFE_SEGMENT}$`), new RegExp(`^/_bun/asset/${SAFE_SEGMENT}$`)];
/** The development client's reports: its page leaving, and runtime errors to map to source. */
const REPORTS = new Set(['/_bun/unref', '/_bun/report_error']);

const MAX_REPORT_BYTES = 1024 * 1024;
const MAX_PENDING_BYTES = 1024 * 1024;

const FORWARDED_REQUEST_HEADERS = ['accept', 'content-type', 'if-none-match', 'if-modified-since'];
const DROPPED_RESPONSE_HEADERS = new Set([
  'connection',
  'content-encoding',
  'content-length',
  'keep-alive',
  'set-cookie',
  'transfer-encoding',
]);

/** The development content security policy: same-origin, plus what live updates need and no more. */
export function developmentContentSecurityPolicy(origin: string, scriptHashes: readonly string[] = []): string {
  const socket = origin.replace(/^http/, 'ws');
  return [
    "default-src 'none'",
    // Updated modules arrive over the channel and run from blob: URLs; the page's own bootstrap is pinned by hash.
    `script-src 'self' blob: ${scriptHashes.map((hash) => `'${hash}'`).join(' ')}`.trimEnd(),
    // The development overlay styles its own elements inline.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    `connect-src 'self' ${socket}`,
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

/** The sha256 source hashes of a page's inline scripts. */
export function inlineScriptHashes(html: string): string[] {
  const hashes: string[] = [];
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    const [, attributes = '', body = ''] = match;
    if (/\bsrc\s*=/i.test(attributes) || body.length === 0) continue;
    hashes.push(`sha256-${new Bun.CryptoHasher('sha256').update(body).digest('base64')}`);
  }
  return hashes;
}

const notFound = () =>
  Response.json({ error: { code: 'not_found' } }, { status: 404, headers: { 'cache-control': 'no-store' } });

const unavailable = () =>
  Response.json({ error: { code: 'service_unavailable' } }, { status: 503, headers: { 'cache-control': 'no-store' } });

function permitted(method: string, pathname: string): boolean {
  if (method === 'GET' || method === 'HEAD') return READABLE.some((pattern) => pattern.test(pathname));
  return method === 'POST' && REPORTS.has(pathname);
}

export interface DevelopmentConsoleOptions {
  /** The private development console server's Unix socket. */
  socket: string;
}

export function createDevelopmentConsole(options: DevelopmentConsoleOptions): DevelopmentConsole {
  const { socket } = options;

  const fetchConsole = async (request: Request, origin: string): Promise<Response> => {
    const url = new URL(request.url);
    if (!permitted(request.method, url.pathname)) return notFound();
    const headers = new Headers();
    for (const name of FORWARDED_REQUEST_HEADERS) {
      const value = request.headers.get(name);
      if (value !== null) headers.set(name, value);
    }
    let body: ArrayBuffer | undefined;
    if (request.method === 'POST') {
      body = await request.arrayBuffer();
      if (body.byteLength > MAX_REPORT_BYTES) {
        return Response.json({ error: { code: 'payload_too_large' } }, { status: 413 });
      }
    }
    let upstream: Response;
    try {
      upstream = await fetch(`http://console${url.pathname}${url.search}`, {
        unix: socket,
        method: request.method,
        headers,
        redirect: 'manual',
        ...(body === undefined ? {} : { body }),
      });
    } catch {
      return unavailable();
    }
    const responseHeaders = new Headers();
    for (const [name, value] of upstream.headers) {
      if (DROPPED_RESPONSE_HEADERS.has(name) || name.startsWith('access-control-')) continue;
      responseHeaders.set(name, value);
    }
    const page = url.pathname === '/';
    if (page) responseHeaders.set('cache-control', 'no-store');
    if (page && upstream.ok) {
      const html = await upstream.text();
      responseHeaders.set(
        'content-security-policy',
        developmentContentSecurityPolicy(origin, inlineScriptHashes(html)),
      );
      return new Response(request.method === 'HEAD' ? null : html, {
        status: upstream.status,
        headers: responseHeaders,
      });
    }
    responseHeaders.set('content-security-policy', developmentContentSecurityPolicy(origin));
    return new Response(request.method === 'HEAD' ? null : upstream.body, {
      status: upstream.status,
      headers: responseHeaders,
    });
  };

  const send = (ws: Bun.ServerWebSocket<DevelopmentSocketData>, message: string | ArrayBuffer | Uint8Array) => {
    if (ws.data.closed) return;
    ws.send(typeof message === 'string' ? message : new Uint8Array(message));
  };

  const websocket: Bun.WebSocketHandler<DevelopmentSocketData> = {
    open(ws) {
      const upstream = new WebSocket(`ws+unix://${socket}:${HMR_PATH}`);
      upstream.binaryType = 'arraybuffer';
      ws.data.upstream = upstream;
      upstream.onopen = () => {
        for (const message of ws.data.pending) upstream.send(message);
        ws.data.pending = [];
        ws.data.pendingBytes = 0;
      };
      upstream.onmessage = (event: MessageEvent<string | ArrayBuffer>) => send(ws, event.data);
      upstream.onclose = () => {
        if (!ws.data.closed) ws.close(1001, 'development console restarted');
      };
      upstream.onerror = () => {
        if (!ws.data.closed) ws.close(1011, 'development console unavailable');
      };
    },
    message(ws, message) {
      const upstream = ws.data.upstream;
      const payload = typeof message === 'string' ? message : new Uint8Array(message);
      if (upstream !== undefined && upstream.readyState === WebSocket.OPEN) {
        upstream.send(payload);
        return;
      }
      ws.data.pendingBytes += typeof payload === 'string' ? payload.length : payload.byteLength;
      if (ws.data.pendingBytes > MAX_PENDING_BYTES) {
        ws.close(1009, 'too much pending data');
        return;
      }
      ws.data.pending.push(payload);
    },
    close(ws) {
      ws.data.closed = true;
      ws.data.pending = [];
      ws.data.upstream?.close();
    },
  };

  return {
    isUpgrade: (request) =>
      new URL(request.url).pathname === HMR_PATH && request.headers.get('upgrade')?.toLowerCase() === 'websocket',
    fetch: fetchConsole,
    websocket,
  };
}
