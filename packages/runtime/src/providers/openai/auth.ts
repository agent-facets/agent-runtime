// OpenAI subscription authorization: the device login the released Codex client (rust-v0.151.0) speaks, and token
// refresh. Reimplemented from the protocol measured by the OpenAI device-auth spike (evidence only; nothing here
// imports it). It is not RFC 8628: bodies are JSON, the poll interval is a string, HTTP 403/404 mean "not approved
// yet", and the server supplies the PKCE pair once the owner approves.
//
// Every exchange goes through an injected transport and signal, one request per call; nothing here retries a token
// request. Results carry fixed reasons only — no response bodies, token values or upstream error text.
//
// Two deliberate differences from Codex, both for safety: an absent poll interval means 5 s rather than 0 (which
// polls in a tight loop), and an interval that cannot be parsed fails the login rather than becoming 0.
import { createHash } from 'node:crypto';
import { classify } from '../failure-mapping.ts';

export const OPENAI_AUTH_ORIGIN = 'https://auth.openai.com';
/** The public OAuth client of the Codex CLI. Not a secret: the flow uses PKCE and has no client secret. */
export const OPENAI_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
export const DEVICE_USERCODE_PATH = '/api/accounts/deviceauth/usercode';
export const DEVICE_TOKEN_PATH = '/api/accounts/deviceauth/token';
export const OAUTH_TOKEN_PATH = '/oauth/token';
/** Where the owner enters the code. The runtime shows it; it never requests it. */
export const DEVICE_VERIFICATION_URL = `${OPENAI_AUTH_ORIGIN}/codex/device`;
const DEVICE_REDIRECT_URI = `${OPENAI_AUTH_ORIGIN}/deviceauth/callback`;

/** Codex stops waiting for approval after 15 minutes. */
export const DEVICE_LOGIN_DEADLINE_MS = 15 * 60_000;
export const DEVICE_INTERVAL_DEFAULT_MS = 5_000;
export const DEVICE_INTERVAL_FLOOR_MS = 1_000;
export const DEVICE_INTERVAL_MAX_MS = 60_000;
/** One poll's limit, including its response body; an unanswered poll is followed by the next one. */
export const DEVICE_POLL_TIMEOUT_MS = 30_000;

const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_TOKEN_LENGTH = 16 * 1024;
const MAX_ID_LENGTH = 1024;
const USER_CODE = /^[A-Za-z0-9-]{4,64}$/;
const PRINTABLE = /^[\x21-\x7e]+$/;

/** Performs exactly one HTTP exchange. */
export type Transport = (request: Request) => Promise<Response>;

/** Thrown by a transport when the request certainly did not reach the network. */
export class NotSentError extends Error {
  override readonly name = 'NotSentError';
}

export interface AuthIo {
  transport: Transport;
  signal: AbortSignal;
  /** Epoch milliseconds; defaults to Date.now. */
  now?: () => number;
}

/**
 * Why an operation produced nothing usable.
 *
 * - `aborted`: the caller's signal ended it before anything was sent.
 * - `not_sent`: the request never reached the issuer.
 * - `throttled`: the issuer declined to process it now (HTTP 429); nothing was consumed.
 * - `rejected`: the issuer refused the grant (any other HTTP 4xx).
 * - `denied`: the device login was refused or abandoned at the issuer.
 * - `expired`: the owner did not approve the device login in time.
 * - `invalid_response`: the issuer answered with something unusable before any grant was spent.
 * - `outcome_unknown`: the request may have reached the issuer, but no usable result came back. A grant used for it
 *   (an authorization code or refresh token) may be spent and must not be sent again.
 */
export type OpenAIAuthFailureReason =
  | 'aborted'
  | 'not_sent'
  | 'throttled'
  | 'rejected'
  | 'denied'
  | 'expired'
  | 'invalid_response'
  | 'outcome_unknown';

export interface AuthFailure {
  ok: false;
  reason: OpenAIAuthFailureReason;
  /** The issuer's HTTP status, when one was received. */
  status?: number;
}

/** A started device login. Only `userCode` and `verificationUrl` are for the owner; the rest stays server-side. */
export interface DeviceSession {
  readonly deviceAuthId: string;
  readonly userCode: string;
  readonly verificationUrl: string;
  readonly intervalMs: number;
  /** When the runtime stops waiting for approval, epoch milliseconds. */
  readonly expiresAtMs: number;
}

/** What approval yields: a one-time authorization code and the PKCE verifier the server supplied with it. */
export interface DeviceApproval {
  readonly authorizationCode: string;
  readonly codeVerifier: string;
}

export interface IssuedTokens {
  ok: true;
  accessToken: string;
  refreshToken: string;
  /** Absolute expiry, epoch milliseconds. */
  expiresAtMs: number;
  /** The ChatGPT account the tokens route to, from the ID token issued with them. */
  accountId: string;
}

export interface RefreshedTokens {
  ok: true;
  accessToken: string;
  /** Absent when the issuer did not rotate it. */
  refreshToken?: string;
  expiresAtMs: number;
  /** Absent when the issuer sent no ID token (or one without the account claim): the stored account stands. */
  accountId?: string;
}

const fail = (reason: OpenAIAuthFailureReason, status?: number): AuthFailure => ({
  ok: false,
  reason,
  ...(status === undefined ? {} : { status }),
});

const boundedString = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= max && PRINTABLE.test(value);

type Sent = { response: Response } | AuthFailure;

async function send(io: AuthIo, path: string, contentType: string, body: string): Promise<Sent> {
  if (io.signal.aborted) return fail('aborted');
  const request = new Request(`${OPENAI_AUTH_ORIGIN}${path}`, {
    method: 'POST',
    headers: { 'content-type': contentType, accept: 'application/json' },
    body,
    signal: io.signal,
    redirect: 'manual',
  });
  try {
    return { response: await io.transport(request) };
  } catch (error) {
    return fail(error instanceof NotSentError ? 'not_sent' : 'outcome_unknown');
  }
}

/** The body as a JSON object, read within the size bound and the caller's signal; undefined if it is not one. */
async function readJson(response: Response, signal: AbortSignal): Promise<Record<string, unknown> | undefined> {
  if (response.body === null) return undefined;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const onAbort = () => void reader.cancel().catch(() => {});
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (signal.aborted) return undefined;
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => {});
        return undefined;
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

const discard = (response: Response) => response.body?.cancel().catch(() => {});

/** The status of a token-grant failure: 429 consumed nothing, other 4xx refused the grant, anything else is unknown. */
function grantFailure(status: number): AuthFailure {
  if (status === 429) return fail('throttled', status);
  if (status >= 400 && status < 500) return fail('rejected', status);
  return fail('outcome_unknown', status);
}

/** Decodes a JWT's claims without verifying its signature: identity claims are routing metadata here, not policy. */
export function decodeJwtClaims(token: string): Record<string, unknown> | undefined {
  const parts = token.split('.');
  if (parts.length !== 3 || parts[1] === undefined || !/^[A-Za-z0-9_-]+$/.test(parts[1])) return undefined;
  try {
    const value: unknown = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** The ChatGPT account ID claim of an ID token: nested under the OpenAI auth namespace, or flat. */
export function accountIdOf(idToken: string): string | undefined {
  const claims = decodeJwtClaims(idToken);
  if (claims === undefined) return undefined;
  const namespace = claims['https://api.openai.com/auth'];
  const nested =
    namespace !== null && typeof namespace === 'object' && !Array.isArray(namespace)
      ? (namespace as Record<string, unknown>).chatgpt_account_id
      : undefined;
  const id = typeof nested === 'string' ? nested : claims.chatgpt_account_id;
  return typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id) ? id : undefined;
}

/**
 * Absolute expiry in epoch milliseconds: the access token's own `exp` (epoch seconds), else `expires_in` (seconds
 * from now). Undefined when neither gives a time in the future.
 */
function expiryOf(accessToken: string, fields: Record<string, unknown>, now: number): number | undefined {
  const exp = decodeJwtClaims(accessToken)?.exp;
  let expiresAtMs: number | undefined;
  if (typeof exp === 'number' && Number.isSafeInteger(exp)) expiresAtMs = exp * 1000;
  else if (typeof fields.expires_in === 'number' && Number.isSafeInteger(fields.expires_in)) {
    expiresAtMs = now + fields.expires_in * 1000;
  }
  return expiresAtMs !== undefined && Number.isSafeInteger(expiresAtMs) && expiresAtMs > now ? expiresAtMs : undefined;
}

/** Parses the poll interval: seconds as a number or digit string, clamped to the floor and maximum. */
export function parseInterval(raw: unknown): number | undefined {
  if (raw === undefined || raw === null) return DEVICE_INTERVAL_DEFAULT_MS;
  let seconds: number;
  if (typeof raw === 'number') seconds = raw;
  else if (typeof raw === 'string' && /^\d{1,6}$/.test(raw.trim())) seconds = Number(raw.trim());
  else return undefined;
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;
  return Math.min(Math.max(seconds * 1000, DEVICE_INTERVAL_FLOOR_MS), DEVICE_INTERVAL_MAX_MS);
}

const s256 = (verifier: string) => createHash('sha256').update(verifier).digest('base64url');

/** Asks the issuer for a device code. Nothing has been granted yet, so any failure is safe to start over from. */
export async function startDeviceLogin(io: AuthIo): Promise<{ ok: true; session: DeviceSession } | AuthFailure> {
  const sent = await send(
    io,
    DEVICE_USERCODE_PATH,
    'application/json',
    JSON.stringify({ client_id: OPENAI_CLIENT_ID }),
  );
  if (!('response' in sent)) return sent;
  const { response } = sent;
  if (response.status < 200 || response.status >= 300) {
    await discard(response);
    return response.status === 429 ? fail('throttled', 429) : fail('rejected', response.status);
  }
  const fields = await readJson(response, io.signal);
  if (io.signal.aborted) return fail('aborted');
  const deviceAuthId = fields?.device_auth_id;
  const userCode = fields?.user_code ?? fields?.usercode;
  const intervalMs = parseInterval(fields?.interval);
  if (!boundedString(deviceAuthId, MAX_ID_LENGTH) || typeof userCode !== 'string' || !USER_CODE.test(userCode)) {
    return fail('invalid_response', response.status);
  }
  if (intervalMs === undefined) return fail('invalid_response', response.status);
  return {
    ok: true,
    session: Object.freeze({
      deviceAuthId,
      userCode,
      verificationUrl: DEVICE_VERIFICATION_URL,
      intervalMs,
      expiresAtMs: (io.now ?? Date.now)() + DEVICE_LOGIN_DEADLINE_MS,
    }),
  };
}

export type PollResult =
  | { ok: true; kind: 'pending' }
  | { ok: true; kind: 'approved'; approval: DeviceApproval }
  | AuthFailure;

/**
 * One poll. 403/404 (and, as for any poll, throttling, server errors and lost connections) mean "keep waiting";
 * classification is the shared device-poll rule, so these never look like an inference authorization failure.
 */
export async function pollDeviceLogin(session: DeviceSession, io: AuthIo): Promise<PollResult> {
  const sent = await send(
    io,
    DEVICE_TOKEN_PATH,
    'application/json',
    JSON.stringify({ device_auth_id: session.deviceAuthId, user_code: session.userCode }),
  );
  if (!('response' in sent)) {
    if (sent.reason === 'aborted' || io.signal.aborted) return fail('aborted');
    return { ok: true, kind: 'pending' };
  }
  const { response } = sent;
  if (response.status < 200 || response.status >= 300) {
    await discard(response);
    const verdict = classify({
      kind: 'device_poll',
      provider: 'openai',
      evidence: { kind: 'http', status: response.status, code: 'unknown' },
    });
    if (verdict.kind === 'continue_polling') return { ok: true, kind: 'pending' };
    return fail(
      verdict.kind === 'login_failed' && verdict.reason === 'login_expired' ? 'expired' : 'denied',
      response.status,
    );
  }
  const fields = await readJson(response, io.signal);
  if (io.signal.aborted) return fail('aborted');
  const authorizationCode = fields?.authorization_code;
  const codeVerifier = fields?.code_verifier;
  const codeChallenge = fields?.code_challenge;
  if (
    !boundedString(authorizationCode, MAX_TOKEN_LENGTH) ||
    !boundedString(codeVerifier, MAX_ID_LENGTH) ||
    !boundedString(codeChallenge, MAX_ID_LENGTH)
  ) {
    return fail('invalid_response', response.status);
  }
  // The server supplies the PKCE pair; the only check available is that it is consistent before the code is spent.
  if (s256(codeVerifier) !== codeChallenge) return fail('invalid_response', response.status);
  return { ok: true, kind: 'approved', approval: Object.freeze({ authorizationCode, codeVerifier }) };
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}

/**
 * Polls at the session's interval until the owner approves, the issuer refuses, the session's deadline passes or
 * the signal aborts. A poll whose turn falls after the deadline is never sent.
 */
export async function waitForDeviceApproval(
  session: DeviceSession,
  io: AuthIo & { sleep?: (ms: number, signal: AbortSignal) => Promise<void> },
): Promise<{ ok: true; approval: DeviceApproval } | AuthFailure> {
  const now = io.now ?? Date.now;
  const sleep = io.sleep ?? abortableSleep;
  while (true) {
    if (io.signal.aborted) return fail('aborted');
    if (now() >= session.expiresAtMs) return fail('expired');
    const result = await pollDeviceLogin(session, {
      ...io,
      signal: AbortSignal.any([io.signal, AbortSignal.timeout(DEVICE_POLL_TIMEOUT_MS)]),
    });
    // A poll that timed out is one more unanswered poll, not the end of the login.
    const timedOut = !result.ok && result.reason === 'aborted' && !io.signal.aborted;
    if (!result.ok && !timedOut) return result;
    if (result.ok && result.kind === 'approved') return { ok: true, approval: result.approval };
    const remaining = session.expiresAtMs - now();
    if (remaining <= 0) return fail('expired');
    await sleep(Math.min(session.intervalMs, remaining), io.signal);
  }
}

/** Exchanges an approved device login for tokens. The authorization code is single-use: this is never repeated. */
export async function exchangeDeviceApproval(
  approval: DeviceApproval,
  io: AuthIo,
): Promise<IssuedTokens | AuthFailure> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: approval.authorizationCode,
    redirect_uri: DEVICE_REDIRECT_URI,
    client_id: OPENAI_CLIENT_ID,
    code_verifier: approval.codeVerifier,
  });
  const sent = await send(io, OAUTH_TOKEN_PATH, 'application/x-www-form-urlencoded', body.toString());
  if (!('response' in sent)) return sent;
  const { response } = sent;
  if (response.status < 200 || response.status >= 300) {
    await discard(response);
    return grantFailure(response.status);
  }
  const fields = await readJson(response, io.signal);
  const accessToken = fields?.access_token;
  const refreshToken = fields?.refresh_token;
  const idToken = fields?.id_token;
  if (
    fields === undefined ||
    !boundedString(accessToken, MAX_TOKEN_LENGTH) ||
    !boundedString(refreshToken, MAX_TOKEN_LENGTH) ||
    !boundedString(idToken, MAX_TOKEN_LENGTH)
  ) {
    return fail('outcome_unknown', response.status);
  }
  const accountId = accountIdOf(idToken);
  const expiresAtMs = expiryOf(accessToken, fields, (io.now ?? Date.now)());
  if (accountId === undefined || expiresAtMs === undefined) return fail('outcome_unknown', response.status);
  return { ok: true, accessToken, refreshToken, expiresAtMs, accountId };
}

/**
 * Exchanges a refresh token once. A refresh whose outcome is unknown may have rotated the token upstream, so
 * replaying it is never this function's decision.
 */
export async function refreshOpenAI(refreshToken: string, io: AuthIo): Promise<RefreshedTokens | AuthFailure> {
  if (!boundedString(refreshToken, MAX_TOKEN_LENGTH)) return fail('rejected');
  const sent = await send(
    io,
    OAUTH_TOKEN_PATH,
    'application/json',
    JSON.stringify({ client_id: OPENAI_CLIENT_ID, grant_type: 'refresh_token', refresh_token: refreshToken }),
  );
  if (!('response' in sent)) return sent;
  const { response } = sent;
  if (response.status < 200 || response.status >= 300) {
    await discard(response);
    return grantFailure(response.status);
  }
  const fields = await readJson(response, io.signal);
  const accessToken = fields?.access_token;
  const rotated = fields?.refresh_token;
  const idToken = fields?.id_token;
  if (fields === undefined || !boundedString(accessToken, MAX_TOKEN_LENGTH))
    return fail('outcome_unknown', response.status);
  if (rotated !== undefined && rotated !== null && !boundedString(rotated, MAX_TOKEN_LENGTH)) {
    return fail('outcome_unknown', response.status);
  }
  const expiresAtMs = expiryOf(accessToken, fields, (io.now ?? Date.now)());
  if (expiresAtMs === undefined) return fail('outcome_unknown', response.status);
  const accountId = boundedString(idToken, MAX_TOKEN_LENGTH) ? accountIdOf(idToken) : undefined;
  return {
    ok: true,
    accessToken,
    ...(typeof rotated === 'string' ? { refreshToken: rotated } : {}),
    expiresAtMs,
    ...(accountId === undefined ? {} : { accountId }),
  };
}
