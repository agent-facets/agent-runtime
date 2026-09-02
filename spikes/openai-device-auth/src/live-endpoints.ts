// Where the live stage is allowed to send bytes, and nothing else.
//
// Every live request -- device init, poll, exchange, refresh, revoke, and the
// model dispatch -- goes through one guarded transport with an explicit
// origin+path allowlist. A subscription access token is the most sensitive
// thing this spike handles, and "the SDK resolved a base URL from somewhere"
// is not an acceptable answer to where it was sent.
//
// Two decisions worth stating:
//
//   * Everything uses node:http, not global fetch. The offline differential
//     measured that undici adds `accept-language` and `sec-fetch-mode` and that
//     neither can be removed through the Fetch API, so a fetch-based live run
//     would knowingly send a non-parity request. Using one transport for auth
//     traffic too means the global fetch can be poisoned for the whole process
//     rather than only around the model call.
//
//   * The synthetic rehearsal reuses this exact policy with loopback origins
//     substituted, so the rehearsal exercises the real allowlist code rather
//     than a parallel implementation that could drift away from it.

import {
  DEFAULT_ISSUER,
  DEVICE_TOKEN_PATH,
  DEVICE_USERCODE_PATH,
  OAUTH_REVOKE_PATH,
  OAUTH_TOKEN_PATH,
  RESPONSES_PATH,
  SUBSCRIPTION_BASE_URL,
} from "./reference.ts";
import { createNodeHttpTerminal } from "./transport/node-http-terminal.ts";

export type LiveEndpoints = {
  issuer: string;
  modelBaseUrl: string;
  /** Absolute paths permitted on the issuer origin. */
  authPaths: readonly string[];
  synthetic: boolean;
};

export class EndpointNotAllowedError extends Error {
  constructor(url: URL) {
    // Origin and path only. A query string or body could carry a token.
    super(`refusing to dispatch to ${url.origin}${url.pathname}`);
    this.name = "EndpointNotAllowedError";
  }
}

export const AUTH_PATHS = [
  DEVICE_USERCODE_PATH,
  DEVICE_TOKEN_PATH,
  OAUTH_TOKEN_PATH,
  OAUTH_REVOKE_PATH,
] as const;

/**
 * Real endpoints unless the rehearsal explicitly substitutes loopback ones.
 * Substitution requires SPIKE_SYNTHETIC=1 *and* both URLs, and both must be
 * loopback: a half-configured rehearsal must not silently reach the provider.
 */
export function resolveEndpoints(): LiveEndpoints {
  const synthetic = process.env.SPIKE_SYNTHETIC === "1";
  if (!synthetic) {
    return {
      issuer: DEFAULT_ISSUER,
      modelBaseUrl: SUBSCRIPTION_BASE_URL,
      authPaths: AUTH_PATHS,
      synthetic: false,
    };
  }

  const issuer = process.env.SPIKE_SYNTHETIC_ISSUER;
  const modelBaseUrl = process.env.SPIKE_SYNTHETIC_MODEL_BASE;
  if (!issuer || !modelBaseUrl) {
    throw new Error("synthetic mode requires SPIKE_SYNTHETIC_ISSUER and SPIKE_SYNTHETIC_MODEL_BASE");
  }
  for (const candidate of [issuer, modelBaseUrl]) {
    const host = new URL(candidate).hostname;
    if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
      throw new Error("synthetic endpoints must be loopback");
    }
  }

  return { issuer, modelBaseUrl, authPaths: AUTH_PATHS, synthetic: true };
}

export type GuardedTransport = {
  fetch: (input: string, init?: RequestInit) => Promise<Response>;
  /** Requests refused by the allowlist. Must be zero on a clean run. */
  refusals: number;
  requests: number;
};

/** The auth transport: issuer origin, four known paths, nothing else. */
export function createAuthTransport(
  endpoints: LiveEndpoints,
  timeoutMs = 30_000,
): GuardedTransport {
  const terminal = createNodeHttpTerminal({ timeoutMs });
  const issuerOrigin = new URL(endpoints.issuer).origin;
  const state: GuardedTransport = {
    refusals: 0,
    requests: 0,
    fetch: async (input, init) => {
      const url = new URL(input);
      const allowed =
        url.origin === issuerOrigin &&
        endpoints.authPaths.some((path) => url.pathname === path);

      if (!allowed) {
        state.refusals += 1;
        throw new EndpointNotAllowedError(url);
      }

      state.requests += 1;
      return terminal(url.toString(), { ...init, method: init?.method ?? "POST" });
    },
  };
  return state;
}

/** The model transport: exactly one origin and exactly the Responses path. */
export function createModelTransport(
  endpoints: LiveEndpoints,
  timeoutMs: number,
  signal: AbortSignal,
): GuardedTransport & { terminal: (input: string, init: RequestInit) => Promise<Response> } {
  const terminal = createNodeHttpTerminal({ timeoutMs });
  const base = new URL(endpoints.modelBaseUrl);
  const expectedPath = `${base.pathname.replace(/\/+$/, "")}${RESPONSES_PATH}`;

  const state = {
    refusals: 0,
    requests: 0,
    fetch: async (input: string, init?: RequestInit) => state.terminal(input, init ?? {}),
    terminal: async (input: string, init: RequestInit) => {
      const url = new URL(input);
      if (url.origin !== base.origin || url.pathname !== expectedPath || url.search !== "") {
        state.refusals += 1;
        throw new EndpointNotAllowedError(url);
      }
      state.requests += 1;
      return terminal(url.toString(), { ...init, signal });
    },
  };

  return state;
}

/**
 * Replace the global fetch for the whole live process. Any code path that
 * bypasses the guarded transports throws instead of reaching the network, and
 * the counter proves afterwards that nothing tried.
 */
export function armFetchPoison(): { fired: () => number; restore: () => void } {
  const original = globalThis.fetch;
  let fired = 0;

  globalThis.fetch = (async () => {
    fired += 1;
    throw new Error("global fetch is disabled during the live stage");
  }) as typeof globalThis.fetch;

  return {
    fired: () => fired,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}
