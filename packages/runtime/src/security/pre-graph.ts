// Sanitation before anything reaches graph state, events or results.
//
// Model output is assembled into one complete message before any of it is released: a credential split across
// stream fragments is only recognizable once joined, so no fragment is exposed on its own. A message is released
// only after the provider's successful terminal event; complete-looking tool arguments without it are not a
// response. Displayable text is redacted visibly. Tool-call names, IDs and arguments carry meaning, so a
// credential there refuses the call instead of silently changing what the agent asked for.
import { utf8Bytes } from '../domain/text.ts';
import type { ToolOutcome } from '../workspace/results.ts';
import { type ContentPolicy, stringsIn } from './content-policy.ts';

export const MESSAGE_MAX_BYTES = 1_048_576;

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
      reason: 'incomplete_response' | 'response_too_large' | 'malformed_tool_call' | 'credential_in_tool_call';
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
    this.#bytes += added;
    if (this.#bytes > this.maxBytes) {
      this.#overflow = true;
      this.#text = [];
      this.#calls.clear();
      return;
    }
    if (fragment.kind === 'text') {
      this.#text.push(fragment.text);
      return;
    }
    const call = this.#calls.get(fragment.index) ?? { id: '', name: '', args: [] };
    call.id += fragment.id ?? '';
    call.name += fragment.name ?? '';
    if (fragment.argumentsDelta !== undefined) call.args.push(fragment.argumentsDelta);
    this.#calls.set(fragment.index, call);
  }

  finish(): AssembledMessage {
    if (this.#overflow) return { kind: 'rejected', reason: 'response_too_large' };
    if (!this.#terminal) return { kind: 'rejected', reason: 'incomplete_response' };
    const toolCalls: AssembledToolCall[] = [];
    for (const index of [...this.#calls.keys()].sort((a, b) => a - b)) {
      const call = this.#calls.get(index) as { id: string; name: string; args: string[] };
      let parsed: unknown;
      try {
        parsed = JSON.parse(call.args.join('') || '{}');
      } catch {
        return { kind: 'rejected', reason: 'malformed_tool_call' };
      }
      if (
        call.id === '' ||
        call.name === '' ||
        typeof parsed !== 'object' ||
        parsed === null ||
        Array.isArray(parsed)
      ) {
        return { kind: 'rejected', reason: 'malformed_tool_call' };
      }
      for (const text of [call.id, call.name, ...stringsIn(parsed)]) {
        if (this.policy.detect(text) !== undefined) return { kind: 'rejected', reason: 'credential_in_tool_call' };
      }
      toolCalls.push({ id: call.id, name: call.name, arguments: parsed as Record<string, unknown> });
    }
    const raw = this.#text.join('');
    const text = this.policy.redact(raw);
    return { kind: 'message', text, toolCalls, redacted: text !== raw };
  }
}

/**
 * Final check of a tool outcome before it is returned to the agent or recorded. Line and excerpt text is
 * redacted; a credential in any other field (a path, a name, a cursor) replaces the whole result with a refusal.
 */
export function sanitizeToolOutcome<T>(policy: ContentPolicy, outcome: ToolOutcome<T>): ToolOutcome<T> {
  if (outcome.outcome !== 'ok') return outcome;
  let refused = false;
  const visit = (value: unknown, key: string | undefined): unknown => {
    if (typeof value === 'string') {
      if (key === 'text') return policy.redact(value);
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
  if (refused) {
    return {
      outcome: 'refused',
      code: 'credential_in_result',
      message: 'The result contained credential material and was withheld.',
    };
  }
  return { outcome: 'ok', result };
}
