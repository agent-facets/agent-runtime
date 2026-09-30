// Sanitation before anything reaches graph state, events or results.
//
// Model output is assembled into one complete message before any of it is released: a credential split across
// stream fragments is only recognizable once joined, so no fragment is exposed on its own. A message is released
// only after the provider's successful terminal event; complete-looking tool arguments without it are not a
// response. Displayable text is redacted visibly. Tool-call names, IDs and arguments carry meaning, so a
// credential there refuses the call instead of silently changing what the agent asked for.
import { isStorableText, utf8Bytes } from '../domain/text.ts';
import { boundOutcome, type ToolOutcome } from '../workspace/results.ts';
import { type ContentPolicy, stringsIn } from './content-policy.ts';

/** Bound on both the buffered input and the sanitized, serialized message. */
export const MESSAGE_MAX_BYTES = 1_048_576;
/** Retained-structure cost charged per fragment, so empty fragments cannot grow buffers without limit. */
const FRAGMENT_OVERHEAD_BYTES = 16;
const TOOL_CALL_OVERHEAD_BYTES = 64;
export const TOOL_RESULT_MAX_BYTES = 65_536;

export type StreamFragment =
  | { kind: 'text'; text: string }
  | { kind: 'tool_call'; index: number; id?: string; name?: string; argumentsDelta?: string }
  | { kind: 'terminal' };

export interface AssembledToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export type AssembledMessage =
  | { kind: 'message'; text: string; toolCalls: AssembledToolCall[]; redacted: boolean }
  | {
      kind: 'rejected';
      reason:
        | 'incomplete_response'
        | 'response_too_large'
        | 'unstorable_response'
        | 'unsafe_response'
        | 'malformed_tool_call'
        | 'credential_in_tool_call';
    };

export class CompleteMessageAssembler {
  #text: string[] = [];
  #calls = new Map<number, { id: string; name: string; args: string[] }>();
  #bytes = 0;
  #terminal = false;
  #overflow = false;

  constructor(
    private readonly policy: ContentPolicy,
    private readonly maxBytes = MESSAGE_MAX_BYTES,
  ) {}

  /** Buffers a fragment. Nothing is released until finish(). */
  push(fragment: StreamFragment): void {
    if (this.#terminal || this.#overflow) return;
    if (fragment.kind === 'terminal') {
      this.#terminal = true;
      return;
    }
    const added =
      fragment.kind === 'text'
        ? utf8Bytes(fragment.text)
        : utf8Bytes(fragment.id ?? '') + utf8Bytes(fragment.name ?? '') + utf8Bytes(fragment.argumentsDelta ?? '');
    const isNewCall = fragment.kind === 'tool_call' && !this.#calls.has(fragment.index);
    this.#bytes += added + FRAGMENT_OVERHEAD_BYTES + (isNewCall ? TOOL_CALL_OVERHEAD_BYTES : 0);
    if (this.#bytes > this.maxBytes) {
      this.#overflow = true;
      this.#release();
      return;
    }
    if (fragment.kind === 'text') {
      if (fragment.text !== '') this.#text.push(fragment.text);
      return;
    }
    const call = this.#calls.get(fragment.index) ?? { id: '', name: '', args: [] };
    call.id += fragment.id ?? '';
    call.name += fragment.name ?? '';
    if (fragment.argumentsDelta !== undefined && fragment.argumentsDelta !== '')
      call.args.push(fragment.argumentsDelta);
    this.#calls.set(fragment.index, call);
  }

  #release(): void {
    this.#text = [];
    this.#calls.clear();
  }

  #reject(reason: Extract<AssembledMessage, { kind: 'rejected' }>['reason']): AssembledMessage {
    this.#release();
    return { kind: 'rejected', reason };
  }

  finish(): AssembledMessage {
    if (this.#overflow) return this.#reject('response_too_large');
    if (!this.#terminal) return this.#reject('incomplete_response');
    const toolCalls: AssembledToolCall[] = [];
    for (const index of [...this.#calls.keys()].sort((a, b) => a - b)) {
      const call = this.#calls.get(index) as { id: string; name: string; args: string[] };
      let parsed: unknown;
      try {
        parsed = JSON.parse(call.args.join('') || '{}');
      } catch {
        return this.#reject('malformed_tool_call');
      }
      if (
        call.id === '' ||
        call.name === '' ||
        typeof parsed !== 'object' ||
        parsed === null ||
        Array.isArray(parsed)
      ) {
        return this.#reject('malformed_tool_call');
      }
      for (const text of [call.id, call.name, ...stringsIn(parsed)]) {
        if (!isStorableText(text)) return this.#reject('unstorable_response');
        if (this.policy.detect(text) !== undefined) return this.#reject('credential_in_tool_call');
      }
      toolCalls.push({ id: call.id, name: call.name, arguments: parsed as Record<string, unknown> });
    }
    const raw = this.#text.join('');
    this.#release();
    if (!isStorableText(raw)) return { kind: 'rejected', reason: 'unstorable_response' };
    const text = this.policy.redact(raw);
    // Redaction must leave nothing recognizable, and can lengthen the text: both are checked on the final form.
    if (this.policy.detect(text) !== undefined) return { kind: 'rejected', reason: 'unsafe_response' };
    if (utf8Bytes(JSON.stringify({ text, toolCalls })) > this.maxBytes) {
      return { kind: 'rejected', reason: 'response_too_large' };
    }
    return { kind: 'message', text, toolCalls, redacted: text !== raw };
  }
}

const UNSAFE_OUTCOME: ToolOutcome<never> = Object.freeze({
  outcome: 'refused',
  code: 'credential_in_result',
  message: 'The result contained credential material and was withheld.',
});
const OUTCOME_CODE = /^[a-z][a-z0-9_]{0,63}$/;
const OUTCOME_MESSAGE_MAX_BYTES = 1_024;

/**
 * Final check of any tool outcome before it is returned to the agent or recorded, followed by the complete
 * serialized size bound. In a successful result, `text` fields are redacted (and must then be clean); a credential
 * in any other field (a path, a name, a cursor) withholds the whole result. Refusals and errors must carry an
 * application-style code and a short, credential-free message, whatever produced them.
 */
export function sanitizeToolOutcome<T>(
  policy: ContentPolicy,
  outcome: ToolOutcome<T>,
  limit = TOOL_RESULT_MAX_BYTES,
): ToolOutcome<T> {
  if (outcome.outcome !== 'ok') {
    const safe =
      OUTCOME_CODE.test(outcome.code) &&
      isStorableText(outcome.message) &&
      utf8Bytes(outcome.message) <= OUTCOME_MESSAGE_MAX_BYTES &&
      policy.detect(outcome.code) === undefined &&
      policy.detect(outcome.message) === undefined;
    return boundOutcome(
      limit,
      safe ? { outcome: outcome.outcome, code: outcome.code, message: outcome.message } : UNSAFE_OUTCOME,
    );
  }
  let refused = false;
  const visit = (value: unknown, key: string | undefined): unknown => {
    if (typeof value === 'string') {
      if (key === 'text') {
        const redacted = policy.redact(value);
        if (policy.detect(redacted) !== undefined) refused = true;
        return redacted;
      }
      if (policy.detect(value) !== undefined) refused = true;
      return value;
    }
    if (Array.isArray(value)) return value.map((item) => visit(item, undefined));
    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value).map(([name, item]) => {
          if (policy.detect(name) !== undefined) refused = true;
          return [name, visit(item, name)];
        }),
      );
    }
    return value;
  };
  const result = visit(outcome.result, undefined) as T;
  return boundOutcome(limit, refused ? UNSAFE_OUTCOME : { outcome: 'ok', result });
}
