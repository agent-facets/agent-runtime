// Derived from @ex-machina/opencode-anthropic-auth src/auth.ts (revision 156cb66); see PROVENANCE.md.
// Kept: the authorization URL, pasted-callback parsing, and the bounded validation of inputs and token responses.
// Changed: all I/O uses the injected transport and signal (no global fetch, no fixed timeout, no retry); failures
// distinguish requests that never left from ones whose outcome is unknown (D2); a refresh response may omit
// `refresh_token` (D3); the login state is always required to match.
import { contentLength, readBoundedText } from './bounded.ts';
import {
  type AuthFailure,
  type AuthFailureReason,
  type AuthOperation,
  type ExchangeResult,
  type IoContext,
  type LoginFlow,
  NotSentError,
  type RefreshResult,
} from './contracts.ts';
import {
  AUTHORIZE_URL,
  CLIENT_ID,
  CODE_CALLBACK_URL,
  OAUTH_SCOPES,
  TOKEN_REQUEST_HEADERS,
  TOKEN_URL,
} from './oauth.ts';
import { generatePkce } from './pkce.ts';

const MAX_TOKEN_RESPONSE_BYTES = 64 * 1024;
const MAX_TOKEN_LENGTH = 8 * 1024;
const MAX_CALLBACK_INPUT_BYTES = 16 * 1024;
const MAX_VERIFIER_BYTES = 1024;
const MAX_REDIRECT_URI_BYTES = 2 * 1024;

function isWellFormedUtf16(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      if (index + 1 >= value.length) return false;
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function isBoundedUtf8(value: unknown, maxBytes: number): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxBytes || !isWellFormedUtf16(value)) {
    return false;
  }
  return new TextEncoder().encode(value).byteLength <= maxBytes;
}

interface ParsedTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAtMs: number;
}

/** Validates a token response. A supplied refresh token must be valid; an omitted one is allowed only if permitted. */
function parseTokens(text: string, now: number, requireRefresh: boolean): ParsedTokens | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const fields = value as Record<string, unknown>;
  if (!isBoundedUtf8(fields.access_token, MAX_TOKEN_LENGTH)) return undefined;
  const expiresIn = fields.expires_in;
  if (typeof expiresIn !== 'number' || !Number.isSafeInteger(expiresIn) || expiresIn <= 0) return undefined;
  const hasRefresh = 'refresh_token' in fields;
  if (hasRefresh ? !isBoundedUtf8(fields.refresh_token, MAX_TOKEN_LENGTH) : requireRefresh) return undefined;
  const expiresAtMs = now + expiresIn * 1000;
  if (!Number.isSafeInteger(expiresAtMs)) return undefined;
  return {
    accessToken: fields.access_token,
    ...(hasRefresh ? { refreshToken: fields.refresh_token as string } : {}),
    expiresAtMs,
  };
}

function parseCallbackInput(input: string): { code: string; state: string } | undefined {
  const trimmed = input.trim();
  try {
    const url = new URL(trimmed);
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    if (code && state) return { code, state };
  } catch {
    // Not a URL: try the pasted `code#state` and query forms.
  }
  const hashSplits = trimmed.split('#');
  if (hashSplits.length === 2 && hashSplits[0] && hashSplits[1]) return { code: hashSplits[0], state: hashSplits[1] };
  const params = new URLSearchParams(trimmed);
  const code = params.get('code');
  const state = params.get('state');
  return code && state ? { code, state } : undefined;
}

const fail = (operation: AuthOperation, reason: AuthFailureReason, status?: number): AuthFailure => ({
  ok: false,
  operation,
  reason,
  ...(status === undefined ? {} : { status }),
});

/** Sends one token request and validates its answer. Never retries. */
async function tokenRequest(
  operation: AuthOperation,
  payload: Record<string, string>,
  io: IoContext,
  requireRefresh: boolean,
): Promise<ParsedTokens | AuthFailure> {
  if (io.signal.aborted) return fail(operation, 'aborted');
  const request = new Request(TOKEN_URL, {
    method: 'POST',
    headers: TOKEN_REQUEST_HEADERS,
    body: JSON.stringify(payload),
    signal: io.signal,
    redirect: 'manual',
  });

  let response: Response;
  try {
    response = await io.transport(request);
  } catch (error) {
    return fail(operation, error instanceof NotSentError ? 'not_sent' : 'outcome_unknown');
  }

  const status = response.status;
  if (status < 200 || status >= 300) {
    await response.body?.cancel().catch(() => {});
    if (status === 429) return fail(operation, 'throttled', status);
    if (status >= 400 && status < 500) return fail(operation, 'rejected', status);
    return fail(operation, 'outcome_unknown', status);
  }

  const declared = contentLength(response.headers);
  if (declared !== undefined && declared > MAX_TOKEN_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => {});
    return fail(operation, 'outcome_unknown', status);
  }
  let text: string;
  try {
    text = await readBoundedText(response.body, MAX_TOKEN_RESPONSE_BYTES, 'token response', io.signal);
  } catch {
    // Oversized, malformed, aborted or lost mid-read: the issuer answered, so the grant may have been consumed.
    return fail(operation, 'outcome_unknown', status);
  }
  return parseTokens(text, (io.now ?? Date.now)(), requireRefresh) ?? fail(operation, 'outcome_unknown', status);
}

/** Starts a subscription login: the URL for the owner to open, and the private state needed to finish it. */
export async function beginLogin(): Promise<LoginFlow> {
  const pkce = await generatePkce();
  const state = crypto.randomUUID().replace(/-/g, '');
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set('code', 'true');
  url.searchParams.set('client_id', CLIENT_ID);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', CODE_CALLBACK_URL);
  url.searchParams.set('scope', OAUTH_SCOPES.join(' '));
  url.searchParams.set('code_challenge', pkce.challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', state);
  return Object.freeze({
    authorizationUrl: url.toString(),
    redirectUri: CODE_CALLBACK_URL,
    state,
    verifier: pkce.verifier,
  });
}

/** Exchanges the code the owner pasted (a callback URL, `code#state` or query form) for a new authorization. */
export async function exchangeAuthorization(pasted: string, flow: LoginFlow, io: IoContext): Promise<ExchangeResult> {
  if (
    !isBoundedUtf8(pasted, MAX_CALLBACK_INPUT_BYTES) ||
    !isBoundedUtf8(flow.verifier, MAX_VERIFIER_BYTES) ||
    !isBoundedUtf8(flow.redirectUri, MAX_REDIRECT_URI_BYTES) ||
    !isBoundedUtf8(flow.state, MAX_TOKEN_LENGTH)
  ) {
    return fail('exchange', 'invalid_input');
  }
  const callback = parseCallbackInput(pasted);
  if (!callback) return fail('exchange', 'invalid_input');
  if (callback.state !== flow.state) return fail('exchange', 'state_mismatch');
  if (!isBoundedUtf8(callback.code, MAX_TOKEN_LENGTH)) return fail('exchange', 'invalid_input');

  const result = await tokenRequest(
    'exchange',
    {
      code: callback.code,
      state: callback.state,
      grant_type: 'authorization_code',
      client_id: CLIENT_ID,
      redirect_uri: flow.redirectUri,
      code_verifier: flow.verifier,
    },
    io,
    true,
  );
  if ('ok' in result) return result;
  return {
    ok: true,
    accessToken: result.accessToken,
    refreshToken: result.refreshToken as string,
    expiresAtMs: result.expiresAtMs,
  };
}

/**
 * Exchanges a refresh token for a new access token, and possibly a rotated refresh token. Exactly one request is
 * made: a refresh token may already have been consumed when the outcome is unknown, so replaying it is the
 * caller's decision, never this function's.
 */
export async function refreshAuthorization(refreshToken: string, io: IoContext): Promise<RefreshResult> {
  if (!isBoundedUtf8(refreshToken, MAX_TOKEN_LENGTH)) return fail('refresh', 'invalid_input');
  const result = await tokenRequest(
    'refresh',
    { grant_type: 'refresh_token', refresh_token: refreshToken, client_id: CLIENT_ID },
    io,
    false,
  );
  if ('ok' in result) return result;
  return { ok: true, ...result };
}
