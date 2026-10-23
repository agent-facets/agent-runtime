// Checks every HTTP request before any route sees it (design Decision 1). The runtime listens only on loopback in
// the Tailscale namespace, and Tailscale Serve forwards the browser's own Host. So a request must name either the
// configured private-network address (RUNTIME_PUBLIC_ORIGIN) or loopback with this listener's port; anything else
// — a forged or rebound Host — is refused. A request that could change something must also come from that same
// origin: a missing, `null` or different Origin is refused, as is a cross-site fetch. Forwarding headers
// (X-Forwarded-*, Forwarded) are never consulted, and no response grants cross-origin access.

export interface RequestPolicyOptions {
  /** The browser-visible origin, `https://host[:port]`; undefined allows loopback only. */
  publicOrigin?: string;
  port: number;
}

const SAFE_METHODS = new Set(['GET', 'HEAD']);

/** Response headers for every reply: no sniffing, framing, referrers, cross-origin reads or foreign content. */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
  'content-security-policy':
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; " +
    "base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
});

/** Validates RUNTIME_PUBLIC_ORIGIN: an HTTPS origin with no path, query, fragment or credentials. */
export function parsePublicOrigin(value: string): string | undefined {
  if (!URL.canParse(value)) return undefined;
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') return undefined;
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '') return undefined;
  if (value !== url.origin && value !== `${url.origin}/`) return undefined;
  return url.origin;
}

export type Refusal = { status: 403; code: 'forbidden'; reason: 'host' | 'origin' };

export function createRequestPolicy(options: RequestPolicyOptions) {
  const origins = new Map<string, string>([
    [`127.0.0.1:${options.port}`, `http://127.0.0.1:${options.port}`],
    [`localhost:${options.port}`, `http://localhost:${options.port}`],
  ]);
  if (options.publicOrigin !== undefined) {
    const url = new URL(options.publicOrigin);
    origins.set(url.host, url.origin);
  }

  return {
    /** Undefined when the request may proceed. */
    check(request: Request): Refusal | undefined {
      const host = request.headers.get('host')?.toLowerCase();
      const expectedOrigin = host === undefined ? undefined : origins.get(host);
      if (expectedOrigin === undefined) return { status: 403, code: 'forbidden', reason: 'host' };
      if (SAFE_METHODS.has(request.method)) return undefined;
      const origin = request.headers.get('origin');
      if (origin === null || origin !== expectedOrigin) return { status: 403, code: 'forbidden', reason: 'origin' };
      const site = request.headers.get('sec-fetch-site');
      if (site !== null && site !== 'same-origin') return { status: 403, code: 'forbidden', reason: 'origin' };
      return undefined;
    },
  };
}

export type RequestPolicy = ReturnType<typeof createRequestPolicy>;
