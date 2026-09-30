// Anthropic subscription credentials: the internal subscription package supplies the protocol, and this module
// connects it to the runtime's credential coordinator (storage, locking, refresh coordination) through an auth
// transport that can reach exactly one endpoint.
import {
  type AuthFailureReason,
  exchangeAuthorization,
  NotSentError,
  type RefreshResult,
  refreshAuthorization,
  TOKEN_ENDPOINT,
  type Transport,
} from '@agent-runtime/anthropic-subscription';
import {
  type CredentialCoordinator,
  type CredentialIssuer,
  DEFAULT_ISSUER_DEADLINE_MS,
  type IssuerOutcome,
} from '../../credentials/coordinator.ts';
import { type EndpointPolicy, matchesPolicy } from '../../execution/terminal.ts';

/** Token exchange and refresh: exactly one HTTPS endpoint and method. */
export const ANTHROPIC_AUTH_POLICY: EndpointPolicy = Object.freeze({
  origin: TOKEN_ENDPOINT.origin,
  routes: Object.freeze([Object.freeze({ method: TOKEN_ENDPOINT.method, path: TOKEN_ENDPOINT.path })]),
});

/**
 * Failures Bun's fetch reports before any request byte is written: name resolution, TCP connect and TLS setup
 * (all observed as `ConnectionRefused` on Bun 1.3.14). Any other failure may follow delivery.
 */
const PRE_CONNECTION_CODES = new Set([
  'ConnectionRefused',
  'FailedToOpenSocket',
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
]);

/**
 * The transport for token requests. It refuses any other destination and never follows a redirect, so a
 * credential-bearing request cannot be forwarded. Errors carry fixed text only.
 */
export function createAnthropicAuthTransport(transport: typeof fetch = fetch): Transport {
  return async (request) => {
    const url = URL.canParse(request.url) ? new URL(request.url) : undefined;
    if (url === undefined || !matchesPolicy(ANTHROPIC_AUTH_POLICY, url, request.method)) {
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
export function issuerOutcome(result: RefreshResult): IssuerOutcome {
  if (result.ok) {
    return {
      kind: 'refreshed',
      credential: {
        accessToken: result.accessToken,
        ...(result.refreshToken === undefined ? {} : { refreshToken: result.refreshToken }),
        expiresAtMs: result.expiresAtMs,
      },
    };
  }
  switch (result.reason) {
    case 'rejected':
      return { kind: 'rejected', reason: 'refresh_rejected' };
    case 'invalid_input':
      // The stored refresh token can never be sent; only a new login helps.
      return { kind: 'rejected', reason: 'refresh_token_unusable' };
    case 'aborted':
    case 'not_sent':
    case 'throttled':
      return { kind: 'unavailable' };
    case 'state_mismatch':
    case 'outcome_unknown':
      return { kind: 'uncertain' };
  }
}

export function anthropicIssuer(options: { transport: Transport; now?: () => number }): CredentialIssuer {
  return {
    async refresh(current, signal) {
      return issuerOutcome(
        await refreshAuthorization(current.refreshToken, {
          transport: options.transport,
          signal,
          ...(options.now === undefined ? {} : { now: options.now }),
        }),
      );
    },
  };
}

export class LoginFailed extends Error {
  override readonly name = 'LoginFailed';
  constructor(readonly reason: AuthFailureReason) {
    super('the Anthropic authorization could not be completed');
  }
}

/**
 * Completes an operator login under the provider lock: the owner opens the URL on any device, pastes the code
 * back, and the exchanged authorization becomes the slot's next generation.
 */
export async function loginAnthropic(options: {
  coordinator: CredentialCoordinator;
  transport: Transport;
  flow: { authorizationUrl: string; redirectUri: string; state: string; verifier: string };
  /** Shows the URL and returns what the owner pasted. */
  readCode: (signal: AbortSignal) => Promise<string>;
  signal?: AbortSignal;
  now?: () => number;
}) {
  return options.coordinator.authorize(
    async (signal) => {
      const pasted = await options.readCode(signal);
      const result = await exchangeAuthorization(pasted, options.flow, {
        transport: options.transport,
        // The owner may take their time pasting; the exchange itself has the ordinary issuer deadline.
        signal: AbortSignal.any([signal, AbortSignal.timeout(DEFAULT_ISSUER_DEADLINE_MS)]),
        ...(options.now === undefined ? {} : { now: options.now }),
      });
      if (!result.ok) throw new LoginFailed(result.reason);
      return {
        accessToken: result.accessToken,
        refreshToken: result.refreshToken,
        expiresAtMs: result.expiresAtMs,
        account: {},
      };
    },
    options.signal === undefined ? {} : { signal: options.signal },
  );
}
