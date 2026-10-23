// The package's injected-I/O contracts. The package performs no I/O of its own: every HTTP exchange goes through a
// caller-supplied transport (in the runtime, a policy-enforcing terminal), and every operation honors a caller
// signal. It keeps no credentials, persists nothing and never retries.

/** Performs exactly one HTTP exchange. The package never calls global fetch. */
export type Transport = (request: Request) => Promise<Response>;

/**
 * Thrown by a transport when the request certainly did not reach the network (refused before dispatch, pre-aborted,
 * connection never established). Any other transport failure is treated as possibly delivered.
 */
export class NotSentError extends Error {
  override readonly name = 'NotSentError';
}

export interface IoContext {
  transport: Transport;
  /** Cancels the exchange, including reading the response body. */
  signal: AbortSignal;
  /** Epoch milliseconds; defaults to Date.now. */
  now?: () => number;
}

export type AuthOperation = 'exchange' | 'refresh';

/**
 * Why an auth operation produced no credential. Nothing more specific than this leaves the package: no response
 * bodies, token values or upstream exception text.
 *
 * - `invalid_input`: refused locally; nothing was sent.
 * - `state_mismatch`: the pasted callback does not belong to this login; nothing was sent.
 * - `aborted`: the caller's signal ended the operation before anything was sent.
 * - `not_sent`: the transport reported that the request never reached the issuer.
 * - `throttled`: the issuer declined to process the request now (HTTP 429); nothing was consumed.
 * - `rejected`: the issuer definitively refused the grant (any other HTTP 4xx).
 * - `outcome_unknown`: the request may have reached the issuer, but no usable result came back (timeout or abort after
 *   sending, connection loss, 5xx, or an unreadable or invalid success body). A refresh token used for such a
 *   request may already have been consumed, so it must not be replayed.
 */
export type AuthFailureReason =
  | 'invalid_input'
  | 'state_mismatch'
  | 'aborted'
  | 'not_sent'
  | 'throttled'
  | 'rejected'
  | 'outcome_unknown';

export interface AuthFailure {
  ok: false;
  operation: AuthOperation;
  reason: AuthFailureReason;
  /** The issuer's HTTP status, when one was received. */
  status?: number;
}

export interface IssuedAuthorization {
  ok: true;
  accessToken: string;
  refreshToken: string;
  /** Absolute expiry, epoch milliseconds. */
  expiresAtMs: number;
}

export interface RefreshedAuthorization {
  ok: true;
  accessToken: string;
  /** Absent when the issuer did not rotate it: the caller keeps its current refresh token. */
  refreshToken?: string;
  /** Absolute expiry, epoch milliseconds. */
  expiresAtMs: number;
}

export type ExchangeResult = IssuedAuthorization | AuthFailure;
export type RefreshResult = RefreshedAuthorization | AuthFailure;

/** A started login. `state` and `verifier` are private to the operator session that started it. */
export interface LoginFlow {
  readonly authorizationUrl: string;
  readonly redirectUri: string;
  readonly state: string;
  readonly verifier: string;
}
