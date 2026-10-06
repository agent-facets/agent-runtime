// OpenAI subscription credentials: the device-login and refresh protocol (./auth.ts) connected to the runtime's
// credential coordinator (storage, locking, refresh coordination) through an auth transport that can reach exactly
// the issuer's three endpoints.
//
// A login holds no credential lock while the owner approves it on another device: polling runs unlocked, and only
// the code exchange and the durable replacement run under the provider lock, shared with refresh and the operator
// commands.
import {
  type CredentialCoordinator,
  type CredentialIssuer,
  type CredentialState,
  DEFAULT_ISSUER_DEADLINE_MS,
  type IssuerOutcome,
} from '../../credentials/coordinator.ts';
import { type EndpointPolicy, matchesPolicy } from '../../execution/terminal.ts';
import {
  type AuthFailure,
  DEVICE_TOKEN_PATH,
  DEVICE_USERCODE_PATH,
  type DeviceSession,
  exchangeDeviceApproval,
  NotSentError,
  OAUTH_TOKEN_PATH,
  OPENAI_AUTH_ORIGIN,
  type OpenAIAuthFailureReason,
  type RefreshedTokens,
  refreshOpenAI,
  startDeviceLogin,
  type Transport,
  waitForDeviceApproval,
} from './auth.ts';

/** Device code, polling and token requests: exactly these HTTPS endpoints, POST only. */
export const OPENAI_AUTH_POLICY: EndpointPolicy = Object.freeze({
  origin: OPENAI_AUTH_ORIGIN,
  routes: Object.freeze(
    [DEVICE_USERCODE_PATH, DEVICE_TOKEN_PATH, OAUTH_TOKEN_PATH].map((path) =>
      Object.freeze({ method: 'POST' as const, path }),
    ),
  ),
});

/** Failures Bun's fetch reports before any request byte is written. Any other failure may follow delivery. */
const PRE_CONNECTION_CODES = new Set([
  'ConnectionRefused',
  'FailedToOpenSocket',
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
]);

/**
 * The transport for authorization requests. It refuses any other destination and never follows a redirect, so a
 * credential-bearing request cannot be forwarded. Errors carry fixed text only.
 */
export function createOpenAIAuthTransport(transport: typeof fetch = fetch): Transport {
  return async (request) => {
    const url = URL.canParse(request.url) ? new URL(request.url) : undefined;
    if (url === undefined || !matchesPolicy(OPENAI_AUTH_POLICY, url, request.method)) {
      throw new NotSentError('the authorization request targeted an unapproved endpoint');
    }
    if (request.signal.aborted) throw new NotSentError('the authorization request was cancelled before sending');
    const body = await request.arrayBuffer();
    try {
      return await transport(url.href, {
        method: request.method,
        headers: request.headers,
        body,
        signal: request.signal,
        redirect: 'manual',
      });
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      if (!request.signal.aborted && typeof code === 'string' && PRE_CONNECTION_CODES.has(code)) {
        throw new NotSentError('the authorization service could not be reached');
      }
      throw new Error('the authorization request failed');
    }
  };
}

/** Maps a refresh result onto the coordinator's outcomes; only a refresh that consumed nothing may be tried again. */
export function issuerOutcome(result: RefreshedTokens | AuthFailure): IssuerOutcome {
  if (result.ok) {
    return {
      kind: 'refreshed',
      credential: {
        accessToken: result.accessToken,
        ...(result.refreshToken === undefined ? {} : { refreshToken: result.refreshToken }),
        expiresAtMs: result.expiresAtMs,
        ...(result.accountId === undefined ? {} : { account: { accountId: result.accountId } }),
      },
    };
  }
  switch (result.reason) {
    case 'rejected':
    case 'denied':
    case 'expired':
      return { kind: 'rejected', reason: 'refresh_rejected' };
    case 'aborted':
    case 'not_sent':
    case 'throttled':
      return { kind: 'unavailable' };
    case 'invalid_response':
    case 'outcome_unknown':
      return { kind: 'uncertain' };
  }
}

export function openaiIssuer(options: { transport: Transport; now?: () => number }): CredentialIssuer {
  return {
    async refresh(current, signal) {
      return issuerOutcome(
        await refreshOpenAI(current.refreshToken, {
          transport: options.transport,
          signal,
          ...(options.now === undefined ? {} : { now: options.now }),
        }),
      );
    },
  };
}

export class OpenAILoginFailed extends Error {
  override readonly name = 'OpenAILoginFailed';
  constructor(readonly reason: OpenAIAuthFailureReason) {
    super('the OpenAI authorization could not be completed');
  }
}

/** Starts a device login: the code and page for the owner. Throws OpenAILoginFailed if the issuer gave none. */
export async function beginOpenAILogin(options: {
  transport: Transport;
  signal?: AbortSignal;
  now?: () => number;
}): Promise<DeviceSession> {
  const result = await startDeviceLogin({
    transport: options.transport,
    signal: AbortSignal.any([
      ...(options.signal === undefined ? [] : [options.signal]),
      AbortSignal.timeout(DEFAULT_ISSUER_DEADLINE_MS),
    ]),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  if (!result.ok) throw new OpenAILoginFailed(result.reason);
  return result.session;
}

/**
 * Waits (unlocked) for the owner to approve `session`, then exchanges the approval under the provider lock: the
 * result becomes the slot's next generation. Throws OpenAILoginFailed when no authorization was issued.
 */
export async function completeOpenAILogin(options: {
  coordinator: CredentialCoordinator;
  transport: Transport;
  session: DeviceSession;
  signal?: AbortSignal;
  now?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Told when the owner has approved and the exchange begins. */
  onApproved?: () => void;
}): Promise<CredentialState> {
  const signal = options.signal ?? new AbortController().signal;
  const now = options.now === undefined ? {} : { now: options.now };
  const approved = await waitForDeviceApproval(options.session, {
    transport: options.transport,
    signal,
    ...now,
    ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
  });
  if (!approved.ok) throw new OpenAILoginFailed(approved.reason);
  options.onApproved?.();
  return options.coordinator.authorize(
    async (lockedSignal) => {
      const issued = await exchangeDeviceApproval(approved.approval, {
        transport: options.transport,
        signal: AbortSignal.any([lockedSignal, AbortSignal.timeout(DEFAULT_ISSUER_DEADLINE_MS)]),
        ...now,
      });
      if (!issued.ok) throw new OpenAILoginFailed(issued.reason);
      return {
        accessToken: issued.accessToken,
        refreshToken: issued.refreshToken,
        expiresAtMs: issued.expiresAtMs,
        account: { accountId: issued.accountId },
      };
    },
    { signal },
  );
}
