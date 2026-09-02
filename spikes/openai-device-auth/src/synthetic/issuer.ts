// A synthetic OAuth issuer speaking the pinned Codex device protocol.
//
// It exists so the deterministic matrix can force races that a real issuer
// would only produce by luck: a refresh response can be held at a barrier until
// every concurrent caller is parked, which turns "exactly one upstream refresh"
// into a measurement rather than a hope.
//
// Every credential it mints is a sentinel. There is no network, so a sentinel
// costs nothing -- there is no upstream to reject it.

import type { Clock } from "../clock.ts";
import type { FetchLike } from "../auth/device-flow.ts";
import { s256 } from "../auth/device-flow.ts";
import {
  DEVICE_TOKEN_PATH,
  DEVICE_USERCODE_PATH,
  OAUTH_REVOKE_PATH,
  OAUTH_TOKEN_PATH,
} from "../reference.ts";

export const SENTINEL_ACCOUNT_ID = "acct-SPIKESENTINEL-0001";
export const SENTINEL_USER_CODE = "ZZZZ-ZZZZ";
export const SENTINEL_DEVICE_AUTH_ID = "devauth-SPIKESENTINEL";
export const SENTINEL_AUTHORIZATION_CODE = "authcode-SPIKESENTINEL";
export const SENTINEL_CODE_VERIFIER = "verifier-SPIKESENTINEL-0123456789abcdef";

export type RefreshOutcome =
  | { kind: "rotate-both" }
  | { kind: "access-only" }
  | { kind: "refresh-only" }
  | { kind: "status"; status: number; retryAfter?: string; errorCode?: string };

export type IssuerOptions = {
  issuer: string;
  clock: Clock;
  /** Raw value emitted for `interval`. Codex sends a string. */
  interval?: unknown;
  omitInterval?: boolean;
  /** Statuses returned by the poll endpoint before it yields the code. */
  pollStatuses?: number[];
  pkce?: "valid" | "mismatch";
  exchangeStatus?: number;
  exchangeOmitsAccount?: boolean;
  usercodeStatus?: number;
  /** Consumed in order; the last entry repeats once exhausted. */
  refreshPlan?: RefreshOutcome[];
  /** Awaited before every refresh response is produced. */
  refreshGate?: () => Promise<void>;
  accessTokenLifetimeSeconds?: number;
};

export type IssuerCalls = {
  usercode: number;
  poll: number;
  exchange: number;
  refresh: number;
  revoke: number;
};

export type SyntheticIssuer = {
  fetch: FetchLike;
  calls: IssuerCalls;
  /** Sentinel refresh tokens minted so far, in order. */
  issuedRefreshTokens: string[];
  currentAccessToken: () => string;
};

export function createSyntheticIssuer(options: IssuerOptions): SyntheticIssuer {
  const issuer = options.issuer.replace(/\/+$/, "");
  const calls: IssuerCalls = { usercode: 0, poll: 0, exchange: 0, refresh: 0, revoke: 0 };
  const issuedRefreshTokens: string[] = [];
  const plan = [...(options.refreshPlan ?? [{ kind: "rotate-both" as const }])];
  const lifetime = options.accessTokenLifetimeSeconds ?? 3600;

  let pollsSeen = 0;
  let accessSerial = 0;
  let refreshSerial = 0;
  let latestAccessToken = "";

  const mintAccess = (): string => {
    accessSerial += 1;
    latestAccessToken = mintSentinelJwt(
      Math.floor(options.clock.now() / 1000) + lifetime,
      accessSerial,
    );
    return latestAccessToken;
  };

  const mintRefresh = (): string => {
    refreshSerial += 1;
    const token = `SPIKESENTINELREFRESH-${String(refreshSerial).padStart(4, "0")}`;
    issuedRefreshTokens.push(token);
    return token;
  };

  const fetch: FetchLike = async (input, init) => {
    const url = new URL(input);
    const path = url.pathname;

    if (path === DEVICE_USERCODE_PATH) {
      calls.usercode += 1;
      const status = options.usercodeStatus ?? 200;
      if (status !== 200) return json({}, status);

      const body: Record<string, unknown> = {
        device_auth_id: SENTINEL_DEVICE_AUTH_ID,
        user_code: SENTINEL_USER_CODE,
      };
      if (!options.omitInterval) {
        body.interval = options.interval ?? "5";
      }
      return json(body, 200);
    }

    if (path === DEVICE_TOKEN_PATH) {
      calls.poll += 1;
      const scripted = options.pollStatuses ?? [];
      const status = pollsSeen < scripted.length ? (scripted[pollsSeen] as number) : 200;
      pollsSeen += 1;

      if (status !== 200) return json({}, status);

      const verifier = SENTINEL_CODE_VERIFIER;
      const challenge =
        options.pkce === "mismatch" ? s256(`${verifier}-tampered`) : s256(verifier);

      return json(
        {
          authorization_code: SENTINEL_AUTHORIZATION_CODE,
          code_verifier: verifier,
          code_challenge: challenge,
        },
        200,
      );
    }

    if (path === OAUTH_TOKEN_PATH) {
      const raw = typeof init?.body === "string" ? init.body : "";
      const isRefresh = raw.includes("refresh_token");

      if (!isRefresh) {
        calls.exchange += 1;
        const status = options.exchangeStatus ?? 200;
        if (status !== 200) return json({}, status);

        return json(
          {
            id_token: mintSentinelIdToken(options.exchangeOmitsAccount === true),
            access_token: mintAccess(),
            refresh_token: mintRefresh(),
          },
          200,
        );
      }

      calls.refresh += 1;
      if (options.refreshGate) await options.refreshGate();

      const outcome = plan.length > 1 ? (plan.shift() as RefreshOutcome) : (plan[0] as RefreshOutcome);

      if (outcome.kind === "status") {
        const headers: Record<string, string> = { "content-type": "application/json" };
        if (outcome.retryAfter !== undefined) headers["retry-after"] = outcome.retryAfter;
        return new Response(
          JSON.stringify(outcome.errorCode ? { error: outcome.errorCode } : {}),
          { status: outcome.status, headers },
        );
      }

      const payload: Record<string, unknown> = {};
      if (outcome.kind === "rotate-both" || outcome.kind === "access-only") {
        payload.access_token = mintAccess();
        payload.id_token = mintSentinelIdToken(false);
      }
      if (outcome.kind === "rotate-both" || outcome.kind === "refresh-only") {
        payload.refresh_token = mintRefresh();
      }
      return json(payload, 200);
    }

    if (path === OAUTH_REVOKE_PATH) {
      calls.revoke += 1;
      return new Response("", { status: 200 });
    }

    throw new Error(`synthetic issuer received an unexpected path: ${path} (${issuer})`);
  };

  return { fetch, calls, issuedRefreshTokens, currentAccessToken: () => latestAccessToken };
}

// ---------------------------------------------------------------------------

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function base64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

export function mintSentinelJwt(expSeconds: number, serial: number): string {
  const header = base64url({ alg: "none", typ: "JWT" });
  const payload = base64url({
    exp: expSeconds,
    sentinel: `SPIKESENTINELACCESS-${String(serial).padStart(4, "0")}`,
  });
  return `${header}.${payload}.SPIKESENTINELSIGNATURE`;
}

export function mintSentinelIdToken(omitAccount: boolean): string {
  const header = base64url({ alg: "none", typ: "JWT" });
  const claims: Record<string, unknown> = { sentinel: "SPIKESENTINELID" };
  if (!omitAccount) {
    claims["https://api.openai.com/auth"] = { chatgpt_account_id: SENTINEL_ACCOUNT_ID };
  }
  return `${header}.${base64url(claims)}.SPIKESENTINELSIGNATURE`;
}

/** A barrier that releases once `count` callers have arrived. */
export function createBarrier(count: number): { gate: () => Promise<void>; arrived: () => number } {
  let arrived = 0;
  let release: () => void = () => {};
  const opened = new Promise<void>((resolve) => {
    release = resolve;
  });

  return {
    arrived: () => arrived,
    gate: async () => {
      arrived += 1;
      if (arrived >= count) release();
      await opened;
    },
  };
}
