// Sanitation of complete stock model messages before they become graph state.
//
// The message is kept whole: its type, ID, tool calls, invalid tool calls, usage, provider metadata and content
// blocks (including reasoning and signatures) are what providers need to continue a conversation, so nothing is
// dropped or reshaped. Only displayable text — string content and `text` blocks — is redacted, visibly. A
// credential anywhere else (tool-call arguments, IDs, reasoning, provider metadata) cannot be removed without
// changing what the model said or breaking replay, so the whole response is withheld instead.
import { AIMessage, mapStoredMessageToChatMessage } from '@langchain/core/messages';
import { isStorableText, utf8Bytes } from '../domain/text.ts';
import type { ContentPolicy } from '../security/content-policy.ts';
import { MESSAGE_MAX_BYTES } from '../security/pre-graph.ts';

export type SanitizedModelMessage =
  | { kind: 'message'; message: AIMessage; redacted: boolean }
  | { kind: 'rejected'; reason: 'unsafe' | 'unstorable' | 'too_large' | 'malformed' };

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** Fields whose content is displayable text: a string, or an array of blocks whose `text` blocks are text. */
const CONTENT_FIELDS = new Set(['content', 'content_blocks']);

class Rejected extends Error {
  constructor(readonly reason: 'unsafe' | 'unstorable') {
    super(reason);
  }
}

function plainJson(value: unknown): Json | undefined {
  try {
    const text = JSON.stringify(value);
    return text === undefined ? undefined : (JSON.parse(text) as Json);
  } catch {
    return undefined;
  }
}

/**
 * Sanitizes a complete model response. `assignId` supplies an ID for a message without one, so its identity is
 * fixed before the graph persists it.
 */
export function sanitizeModelMessage(
  policy: ContentPolicy,
  message: AIMessage,
  options: { assignId: () => string; maxBytes?: number },
): SanitizedModelMessage {
  if (!AIMessage.isInstance(message)) return { kind: 'rejected', reason: 'malformed' };
  const stored = message.toDict();
  const data = plainJson(stored.data);
  if (data === undefined || data === null || typeof data !== 'object' || Array.isArray(data)) {
    return { kind: 'rejected', reason: 'malformed' };
  }
  if (typeof data.id !== 'string' || data.id === '') data.id = options.assignId();

  let redacted = false;
  const check = (text: string) => {
    if (!isStorableText(text)) throw new Rejected('unstorable');
    if (policy.detect(text) !== undefined) throw new Rejected('unsafe');
  };
  const display = (text: string): string => {
    if (!isStorableText(text)) throw new Rejected('unstorable');
    const result = policy.redact(text);
    if (result !== text) redacted = true;
    return result;
  };
  const opaque = (value: Json): Json => {
    if (typeof value === 'string') {
      check(value);
      return value;
    }
    if (Array.isArray(value)) return value.map(opaque);
    if (value !== null && typeof value === 'object') {
      const out: { [key: string]: Json } = {};
      for (const [key, item] of Object.entries(value)) {
        check(key);
        out[key] = opaque(item);
      }
      return out;
    }
    return value;
  };
  const content = (value: Json): Json => {
    if (typeof value === 'string') return display(value);
    if (!Array.isArray(value)) return opaque(value);
    return value.map((block) => {
      if (block === null || typeof block !== 'object' || Array.isArray(block) || block.type !== 'text') {
        return opaque(block);
      }
      const out: { [key: string]: Json } = {};
      for (const [key, item] of Object.entries(block)) {
        check(key);
        out[key] = key === 'text' && typeof item === 'string' ? display(item) : opaque(item);
      }
      return out;
    });
  };

  let sanitized: { [key: string]: Json };
  try {
    sanitized = {};
    for (const [key, value] of Object.entries(data)) {
      check(key);
      sanitized[key] = CONTENT_FIELDS.has(key) ? content(value) : opaque(value);
    }
  } catch (error) {
    if (error instanceof Rejected) return { kind: 'rejected', reason: error.reason };
    throw error;
  }

  let rebuilt: AIMessage;
  try {
    const candidate = mapStoredMessageToChatMessage({ type: 'ai', data: sanitized as never });
    if (!AIMessage.isInstance(candidate)) return { kind: 'rejected', reason: 'malformed' };
    rebuilt = candidate;
  } catch {
    return { kind: 'rejected', reason: 'malformed' };
  }

  // Postconditions on the message as it will be stored: redaction left nothing recognizable (it is one pass, and
  // replacing one credential can expose a neighbouring format), and the result fits the bound.
  const serialized = JSON.stringify(rebuilt.toDict());
  if (policy.detect(serialized) !== undefined) return { kind: 'rejected', reason: 'unsafe' };
  if (utf8Bytes(serialized) > (options.maxBytes ?? MESSAGE_MAX_BYTES)) return { kind: 'rejected', reason: 'too_large' };
  return { kind: 'message', message: rebuilt, redacted };
}
