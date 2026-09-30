// Derived from @ex-machina/opencode-anthropic-auth src/version-rejection.ts (revision 156cb66); see PROVENANCE.md.
// Responses are only read, never rewritten (D1). A minimum-client-version rejection is recognized so it can be
// reported as such; there is no version adoption or retry (D5).
import type { SubscriptionProfile } from './profile.ts';

export const MAX_ERROR_BODY_BYTES = 16 * 1024;

/** What an unsuccessful Messages API response means, from its status and its allowlisted error type only. */
export type InferenceErrorKind =
  | 'authentication'
  | 'permission'
  | 'rate_limited'
  | 'overloaded'
  | 'client_version_rejected'
  | 'model_not_found'
  | 'request_too_large'
  | 'invalid_request'
  | 'server_error'
  | 'unknown';

const ERROR_TYPES: Record<string, InferenceErrorKind> = {
  authentication_error: 'authentication',
  permission_error: 'permission',
  rate_limit_error: 'rate_limited',
  overloaded_error: 'overloaded',
  not_found_error: 'model_not_found',
  request_too_large: 'request_too_large',
  invalid_request_error: 'invalid_request',
  api_error: 'server_error',
};

const VERSION_TOO_OLD = 'claude_code_version_too_old';
const MAX_REJECTION_MESSAGE_LENGTH = 1024;
const VERSION_REJECTION =
  /^Claude Code ([0-9.]{1,64}) does not support this model; version ([0-9.]{1,64}) or newer is required\./;
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function newerVersion(candidate: string, baseline: string): boolean {
  if (!VERSION.test(candidate) || !VERSION.test(baseline)) return false;
  const a = candidate.split('.').map(BigInt);
  const b = baseline.split('.').map(BigInt);
  for (let index = 0; index < 3; index++) {
    if ((a[index] ?? 0n) !== (b[index] ?? 0n)) return (a[index] ?? 0n) > (b[index] ?? 0n);
  }
  return false;
}

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object';

/**
 * Classifies an unsuccessful response. `body` is at most MAX_ERROR_BODY_BYTES of its text, when available; a
 * larger or unreadable body is classified by status alone. Nothing from the body is returned.
 */
export function classifyInferenceError(
  status: number,
  body: string | undefined,
  profile: SubscriptionProfile,
): InferenceErrorKind {
  let error: Record<string, unknown> | undefined;
  if (body !== undefined && body.length <= MAX_ERROR_BODY_BYTES) {
    try {
      const decoded: unknown = JSON.parse(body);
      if (isRecord(decoded) && decoded.type === 'error' && isRecord(decoded.error)) error = decoded.error;
    } catch {
      // Not the documented error shape: fall back to the status.
    }
  }

  if (status === 400 && error?.type === 'invalid_request_error' && isRecord(error.details)) {
    const message = error.message;
    const match =
      error.details.error_code === VERSION_TOO_OLD &&
      typeof message === 'string' &&
      message.length <= MAX_REJECTION_MESSAGE_LENGTH
        ? VERSION_REJECTION.exec(message)
        : null;
    // Only a rejection of the version this profile actually reports counts; anything else is a stale or unrelated
    // response and is classified as an ordinary invalid request.
    if (match?.[1] === profile.clientVersion && newerVersion(match[2] ?? '', profile.clientVersion)) {
      return 'client_version_rejected';
    }
  }
  const byType = typeof error?.type === 'string' ? ERROR_TYPES[error.type] : undefined;
  if (byType !== undefined) return byType;
  if (status === 401) return 'authentication';
  if (status === 403) return 'permission';
  if (status === 413) return 'request_too_large';
  if (status === 429) return 'rate_limited';
  if (status === 529) return 'overloaded';
  if (status >= 500) return 'server_error';
  if (status === 400) return 'invalid_request';
  return 'unknown';
}

/**
 * Observes an event stream, without changing it, to decide whether it ended the way a complete response does: a
 * `message_stop` event and no `error` event. A stream that ends otherwise was truncated or failed and must not be
 * turned into a message. Only event-name lines are examined; memory is bounded.
 */
export class StreamCompletion {
  static readonly #MAX_LINE = 256;
  readonly #decoder = new TextDecoder();
  #line = '';
  #skipping = false;
  #stopped = false;
  #failed = false;
  #afterStop = false;

  observe(chunk: Uint8Array): void {
    const text = this.#decoder.decode(chunk, { stream: true });
    let start = 0;
    for (let index = 0; index < text.length; index++) {
      const char = text[index];
      if (char !== '\n' && char !== '\r') continue;
      this.#take(text.slice(start, index));
      this.#end();
      start = index + 1;
    }
    this.#take(text.slice(start));
  }

  #take(part: string): void {
    if (this.#skipping) return;
    if (this.#line.length + part.length > StreamCompletion.#MAX_LINE) {
      // Data lines can be long; event-name lines never are.
      this.#skipping = true;
      this.#line = '';
      return;
    }
    this.#line += part;
  }

  #end(): void {
    const line = this.#line;
    this.#line = '';
    this.#skipping = false;
    if (!line.startsWith('event:')) return;
    const name = line.slice('event:'.length).trim();
    if (name === 'error') this.#failed = true;
    else if (name === 'message_stop') this.#stopped = true;
    else if (this.#stopped && name !== 'ping') this.#afterStop = true;
  }

  /** Whether everything observed so far is a complete, successfully terminated response. */
  get complete(): boolean {
    return this.#stopped && !this.#failed && !this.#afterStop;
  }

  /** Whether the stream has already shown that it cannot end successfully. */
  get failed(): boolean {
    return this.#failed || this.#afterStop;
  }
}
