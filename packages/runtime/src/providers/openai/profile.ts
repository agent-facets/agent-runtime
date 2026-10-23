// The OpenAI subscription (Codex backend) request profile. Its values are measured, not inferred: they come from
// the OpenAI device-auth spike's captures of the released Codex client (rust-v0.151.0) and are re-captured per
// release. The spike is evidence only; nothing here imports it.
//
// Stock ChatOpenAI in Responses mode encodes the conversation (stateless input items, encrypted reasoning, matching
// function-call IDs); the profile only completes what the stock model surface cannot express and removes what the
// reference never sends. Responses are never rewritten.
import type { PreparedRequest } from '../../execution/terminal.ts';
import type { ProviderErrorCode } from '../failure-mapping.ts';

export interface OpenAISubscriptionProfile {
  readonly id: string;
  readonly baseURL: string;
  readonly origin: string;
  readonly path: string;
  readonly originator: string;
  readonly clientVersion: string;
  readonly userAgent: string;
  readonly accountHeader: string;
  readonly include: readonly string[];
  readonly toolChoice: string;
  readonly parallelToolCalls: boolean;
  readonly reasoning: Readonly<Record<string, string>>;
  readonly text: Readonly<Record<string, string>>;
}

export const CODEX_0_151_0: OpenAISubscriptionProfile = Object.freeze({
  id: 'codex-0.151.0',
  baseURL: 'https://chatgpt.com/backend-api/codex',
  origin: 'https://chatgpt.com',
  path: '/backend-api/codex/responses',
  // `codex exec`, the non-interactive entrypoint an agent runtime resembles.
  originator: 'codex_exec',
  clientVersion: '0.151.0',
  userAgent: 'codex_exec/0.151.0 (Linux 6.0.0; x86_64) agent-runtime',
  accountHeader: 'chatgpt-account-id',
  include: Object.freeze(['reasoning.encrypted_content']),
  toolChoice: 'auto',
  parallelToolCalls: false,
  reasoning: Object.freeze({ context: 'all_turns', effort: 'low' }),
  text: Object.freeze({ verbosity: 'low' }),
});

const PROFILES: ReadonlyMap<string, OpenAISubscriptionProfile> = new Map([[CODEX_0_151_0.id, CODEX_0_151_0]]);
export const OPENAI_PROFILE_IDS: readonly string[] = Object.freeze([...PROFILES.keys()]);
export const openaiProfileFor = (id: string) => PROFILES.get(id);

/** Parameters LangChain can emit that the reference never sends. */
const REMOVED_BODY_KEYS = [
  'max_output_tokens',
  'temperature',
  'top_p',
  'user',
  'truncation',
  'previous_response_id',
  'prompt_cache_retention',
  'metadata',
  'max_tokens',
  'n',
  'frequency_penalty',
  'presence_penalty',
];
const GENERATED_SCHEMA_KEYS = new Set(['$schema', '$id', '$defs', 'definitions']);
export const MAX_REQUEST_BODY_BYTES = 10 * 1024 * 1024;

export type OpenAIAdaptRefusal =
  | 'unsupported_endpoint'
  | 'body_too_large'
  | 'invalid_body'
  | 'model_not_bound'
  | 'tool_shape_unsupported'
  | 'tool_schema_not_authored'
  | 'credential_incomplete';

type Json = Record<string, unknown>;
const isRecord = (value: unknown): value is Json =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function hasGeneratedSchemaKey(value: unknown, depth = 0): boolean {
  if (depth > 64 || value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some((item) => hasGeneratedSchemaKey(item, depth + 1));
  return Object.entries(value).some(
    ([key, item]) => GENERATED_SCHEMA_KEYS.has(key) || hasGeneratedSchemaKey(item, depth + 1),
  );
}

export interface OpenAIRequestContext {
  profile: OpenAISubscriptionProfile;
  /** The run's configured model: nothing else may be requested. */
  model: string;
  /** The run's stable conversation identity (session, thread and request correlation headers). */
  conversationId: string;
  /** Token and account from one credential generation. */
  accessToken: string;
  accountId: string;
}

/**
 * Adapts one Responses request to the profile. Headers are rebuilt from an allowlist, so nothing the SDK adds
 * (its sentinel key, `x-stainless-*`, organization or project) can reach the backend.
 */
export function adaptOpenAIRequest(
  request: PreparedRequest,
  context: OpenAIRequestContext,
): PreparedRequest | { refused: OpenAIAdaptRefusal } {
  const { profile } = context;
  const url = request.url;
  if (
    request.method !== 'POST' ||
    url.origin !== profile.origin ||
    url.pathname !== profile.path ||
    url.search !== '' ||
    url.username !== '' ||
    url.password !== '' ||
    url.hash !== ''
  ) {
    return { refused: 'unsupported_endpoint' };
  }
  if (!context.accessToken || !context.accountId) return { refused: 'credential_incomplete' };
  if (new TextEncoder().encode(request.body).byteLength > MAX_REQUEST_BODY_BYTES) return { refused: 'body_too_large' };

  let body: unknown;
  try {
    body = JSON.parse(request.body);
  } catch {
    return { refused: 'invalid_body' };
  }
  if (!isRecord(body) || !Array.isArray(body.input) || body.input.length === 0) return { refused: 'invalid_body' };
  if (body.model !== context.model) return { refused: 'model_not_bound' };
  if (body.tools !== undefined) {
    if (!Array.isArray(body.tools)) return { refused: 'invalid_body' };
    for (const tool of body.tools) {
      // A nested `function` is the Chat Completions shape: the wrong encoder ran.
      if (!isRecord(tool) || tool.type !== 'function' || 'function' in tool || typeof tool.name !== 'string') {
        return { refused: 'tool_shape_unsupported' };
      }
      if (hasGeneratedSchemaKey(tool.parameters)) return { refused: 'tool_schema_not_authored' };
      if (typeof tool.strict !== 'boolean') tool.strict = false;
    }
  }

  for (const key of REMOVED_BODY_KEYS) delete body[key];
  body.stream = true;
  body.store = false;
  body.tool_choice = profile.toolChoice;
  body.include = [...profile.include];
  body.parallel_tool_calls = profile.parallelToolCalls;
  body.reasoning = { ...profile.reasoning };
  body.text = { ...profile.text };

  const headers = new Headers({
    accept: 'text/event-stream',
    'content-type': 'application/json',
    authorization: `Bearer ${context.accessToken}`,
    [profile.accountHeader]: context.accountId,
    originator: profile.originator,
    version: profile.clientVersion,
    'user-agent': profile.userAgent,
    'session-id': context.conversationId,
    'thread-id': context.conversationId,
    'x-client-request-id': context.conversationId,
    'x-codex-routing-hint': `model=${context.model}`,
  });
  return { url: new URL(url), method: 'POST', headers, body: JSON.stringify(body) };
}

/** Event names a diagnostic may carry: lowercase dotted identifiers only; anything else is reported as `other`. */
const EVENT_NAME = /^[a-z][a-z0-9_.]{0,63}$/;
const SUMMARY_LIMIT = 64;

/**
 * Observes a Responses event stream. Like the reference client, which stops reading once it has seen
 * `response.completed`, the response is complete at the end of that event: `endAt` then gives the offset in the last
 * observed chunk where it ends, and nothing after it is read or passed on. Before that, `response.failed`,
 * `response.incomplete` and `error` fail the stream. Event types are read from `event:` lines or the leading `type`
 * of each `data:` line; an event whose type cannot be read in the bounded prefix is never taken for completion, so an
 * unreadable stream fails closed.
 *
 * It also keeps a bounded summary of the event names seen (consecutive repeats counted, never any content), which
 * `onIncomplete` receives when the terminal judges the response incomplete.
 */
export class ResponsesCompletion {
  static readonly #PREFIX = 512;
  static readonly #FAILURES = new Set(['response.failed', 'response.incomplete', 'error']);
  readonly #prefix = new Uint8Array(ResponsesCompletion.#PREFIX);
  #prefixLength = 0;
  #lastWasCR = false;
  #completed = false;
  #failed = false;
  #finished = false;
  #endAt: number | undefined;
  readonly #summary: { name: string; count: number }[] = [];
  #summaryOverflow = false;

  constructor(private readonly report?: (summary: string) => void) {}

  observe(chunk: Uint8Array): void {
    this.#endAt = undefined;
    if (this.#finished) return;
    for (let index = 0; index < chunk.length; index++) {
      const byte = chunk[index] as number;
      if (byte === 0x0a && this.#lastWasCR) {
        // The second byte of a CRLF ending: the line already ended at the CR.
        this.#lastWasCR = false;
        continue;
      }
      this.#lastWasCR = byte === 0x0d;
      if (byte !== 0x0a && byte !== 0x0d) {
        if (this.#prefixLength < ResponsesCompletion.#PREFIX) this.#prefix[this.#prefixLength] = byte;
        this.#prefixLength++;
        continue;
      }
      const empty = this.#prefixLength === 0;
      this.#line();
      // A blank line ends an event; once the completed event has ended, the response is complete.
      if (empty && this.#completed && !this.#failed) {
        this.#finished = true;
        // Include the LF of a CRLF blank line when it is in this chunk; a lone CR is itself a valid line end.
        this.#endAt = byte === 0x0d && chunk[index + 1] === 0x0a ? index + 2 : index + 1;
        return;
      }
    }
  }

  #line(): void {
    const length = Math.min(this.#prefixLength, ResponsesCompletion.#PREFIX);
    const truncated = this.#prefixLength > ResponsesCompletion.#PREFIX;
    this.#prefixLength = 0;
    if (length === 0) return;
    const line = new TextDecoder().decode(this.#prefix.subarray(0, length));
    let type: string | undefined;
    if (line.startsWith('event:')) {
      type = line.slice('event:'.length).trim();
      if (truncated) type = undefined;
    } else if (line.startsWith('data:')) {
      type = /^\s*\{\s*"type"\s*:\s*"([^"\\]{1,128})"/.exec(line.slice(5))?.[1];
      this.#note(type === undefined ? (line.slice(5).trim() === '[DONE]' ? 'done_marker' : 'untyped') : type);
    }
    if (type === undefined || this.#completed) return;
    if (ResponsesCompletion.#FAILURES.has(type)) this.#failed = true;
    else if (type === 'response.completed') this.#completed = true;
  }

  #note(type: string): void {
    const name = EVENT_NAME.test(type) ? type : 'other';
    const last = this.#summary.at(-1);
    if (last?.name === name) last.count++;
    else if (this.#summary.length < SUMMARY_LIMIT) this.#summary.push({ name, count: 1 });
    else this.#summaryOverflow = true;
  }

  get complete(): boolean {
    return this.#completed && !this.#failed;
  }

  get failed(): boolean {
    return this.#failed;
  }

  /** Where the response ended within the chunk just observed, once it is complete; nothing after it is read. */
  get endAt(): number | undefined {
    return this.#endAt;
  }

  /** The event names seen, in order, with consecutive repeats counted (`name*count`). */
  summary(): string {
    const parts = this.#summary.map(({ name, count }) => (count === 1 ? name : `${name}*${count}`));
    if (this.#summaryOverflow) parts.push('more');
    return parts.join(',');
  }

  onIncomplete(): void {
    this.report?.(this.summary());
  }
}

/** Safe provider codes from an unsuccessful response's status and allowlisted error code. */
export function classifyOpenAIError(status: number, body: string | undefined): ProviderErrorCode {
  let code: unknown;
  if (body !== undefined && body.length <= 16 * 1024) {
    try {
      const decoded: unknown = JSON.parse(body);
      const error = isRecord(decoded) ? decoded.error : undefined;
      if (isRecord(error)) code = error.code ?? error.type;
    } catch {
      // Not JSON: the status decides.
    }
  }
  if (code === 'usage_limit_reached' || code === 'usage_not_included' || code === 'insufficient_quota') {
    return 'quota_exhausted';
  }
  if (code === 'rate_limit_exceeded') return 'rate_limited';
  if (code === 'model_not_found' || code === 'unsupported_model') return 'model_unsupported';
  if (status === 401 || status === 403) return 'auth_rejected';
  if (status === 429) return 'rate_limited';
  if (status === 503 || status === 529) return 'overloaded';
  if (status >= 500) return 'server_error';
  if (status === 400 || status === 404 || status === 413 || status === 422) return 'bad_request';
  return 'unknown';
}
