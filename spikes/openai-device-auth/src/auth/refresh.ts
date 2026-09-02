// Token refresh.
//
// Two properties are load-bearing and both are measured rather than assumed:
//
//   1. Rotation is partial. The issuer may return a new access token and omit
//      the refresh token, and dropping the old one in that case would strand
//      the credential. Every field is merged individually.
//   2. `retry-after` is attacker- and accident-controlled, so it is clamped.
//      An unclamped 86400 turns a rate limit into an outage.

import type { Clock } from "../clock.ts";
import { AuthError } from "./errors.ts";
import type { FetchLike } from "./device-flow.ts";
import { decodeJwtPayload } from "./device-flow.ts";
import { OAUTH_CLIENT_ID, OAUTH_TOKEN_PATH, RETRY_AFTER_CLAMP_MS } from "../reference.ts";

export type RefreshResponse = {
  idToken: string | null;
  accessToken: string | null;
  refreshToken: string | null;
  expiresAtSeconds: number | null;
};

export type RefreshOptions = {
  issuer: string;
  clientId?: string;
  fetch: FetchLike;
  clock: Clock;
};

/** Error codes the issuer uses to say a refresh token is finished. */
const TERMINAL_ERROR_CODES = new Set([
  "refresh_token_expired",
  "refresh_token_reused",
  "refresh_token_invalidated",
  "invalid_grant",
]);

export async function requestRefresh(
  refreshToken: string,
  options: RefreshOptions,
): Promise<RefreshResponse> {
  const issuer = options.issuer.replace(/\/+$/, "");

  let response: Response;
  try {
    response = await options.fetch(`${issuer}${OAUTH_TOKEN_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_id: options.clientId ?? OAUTH_CLIENT_ID,
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      }),
    });
  } catch (cause) {
    throw new AuthError(
      "NETWORK",
      `refresh failed: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }

  if (response.status === 429) {
    throw new AuthError(
      "RATE_LIMITED",
      "refresh was rate limited",
      parseRetryAfter(response.headers.get("retry-after"), options.clock),
    );
  }

  if (response.status >= 500) {
    throw new AuthError("UPSTREAM_5XX", `refresh failed with status ${response.status}`);
  }

  if (response.status === 401) {
    throw new AuthError("AUTH_REVOKED", "refresh was rejected as unauthorized");
  }

  if (!response.ok) {
    const code = await readErrorCode(response);
    if (code && TERMINAL_ERROR_CODES.has(code)) {
      throw new AuthError("AUTH_REVOKED", `refresh token is no longer usable: ${code}`);
    }
    throw new AuthError("AUTH_REVOKED", `refresh rejected with status ${response.status}`);
  }

  const payload = (await response.json()) as Record<string, unknown>;
  const accessToken = stringOrNull(payload.access_token);

  return {
    idToken: stringOrNull(payload.id_token),
    accessToken,
    refreshToken: stringOrNull(payload.refresh_token),
    expiresAtSeconds: expiryFrom(payload, accessToken, options.clock),
  };
}

/**
 * Seconds or an HTTP date, clamped. A malformed value falls back to the clamp
 * rather than producing a NaN sleep.
 */
export function parseRetryAfter(raw: string | null, clock: Clock): number {
  if (!raw) return RETRY_AFTER_CLAMP_MS;

  const trimmed = raw.trim();
  if (/^\d+$/.test(trimmed)) {
    return clampRetryAfter(Number.parseInt(trimmed, 10) * 1000);
  }

  const asDate = Date.parse(trimmed);
  if (Number.isFinite(asDate)) {
    return clampRetryAfter(asDate - clock.now());
  }

  return RETRY_AFTER_CLAMP_MS;
}

export function clampRetryAfter(ms: number): number {
  if (!Number.isFinite(ms) || ms < 0) return RETRY_AFTER_CLAMP_MS;
  return Math.min(ms, RETRY_AFTER_CLAMP_MS);
}

export type RetryPolicy = {
  /** Total attempts, including the first. */
  attempts: number;
  baseDelayMs: number;
};

export const DEFAULT_RETRY_POLICY: RetryPolicy = { attempts: 3, baseDelayMs: 500 };

/** No retries at all. The live stage runs under this. */
export const NO_RETRY_POLICY: RetryPolicy = { attempts: 1, baseDelayMs: 0 };

/**
 * Bounded retry. Permanent failures short-circuit on the first attempt, which
 * is the whole point of typing them: retrying a revoked token just burns quota
 * and can trip reuse detection.
 */
export async function withBoundedRetry<T>(
  operation: () => Promise<T>,
  policy: RetryPolicy,
  clock: Clock,
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= policy.attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!(error instanceof AuthError) || error.kind === "permanent") throw error;
      if (attempt === policy.attempts) break;
      const delay = error.retryAfterMs ?? policy.baseDelayMs * attempt;
      await clock.sleep(clampRetryAfter(delay));
    }
  }

  throw lastError;
}

// ---------------------------------------------------------------------------

async function readErrorCode(response: Response): Promise<string | null> {
  try {
    const payload = (await response.json()) as Record<string, unknown>;
    const error = payload.error;
    if (typeof error === "string") return error;
    if (error !== null && typeof error === "object" && !Array.isArray(error)) {
      const nested = (error as Record<string, unknown>).code;
      if (typeof nested === "string") return nested;
    }
    return null;
  } catch {
    return null;
  }
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function expiryFrom(
  payload: Record<string, unknown>,
  accessToken: string | null,
  clock: Clock,
): number | null {
  if (accessToken) {
    const exp = decodeJwtPayload(accessToken)?.exp;
    if (typeof exp === "number" && Number.isFinite(exp)) return Math.floor(exp);
  }
  const expiresIn = payload.expires_in;
  if (typeof expiresIn === "number" && Number.isFinite(expiresIn)) {
    return Math.floor(clock.now() / 1000) + Math.floor(expiresIn);
  }
  return null;
}
