// Credential detection for text entering or leaving the agent: owner input, tool results and model output.
//
// Two kinds of evidence, deliberately narrow:
//   - exact matches of this runtime's live credential values, located by the credential boundary's opaque
//     matcher (callers never see the values), and
//   - a small set of high-confidence credential formats (vendor-prefixed keys, private-key blocks, bearer
//     headers with a literal token).
// Long identifiers, hashes, UUIDs and base64 are not treated as secrets, and generic JWT-shaped strings are not
// matched by pattern: a repository's test JWT and a live token look alike, so live tokens are caught by exact
// match instead. This is credential hygiene for this runtime, not general data-loss prevention.
//
// Detection works on spans of the complete text, so callers screen a whole document or message before they
// paginate, clip or excerpt it: a credential cut by an excerpt boundary would no longer be recognizable.
import { type ExactSecretMatcher, isExactSecretMatcher, type Span } from '../credentials/matcher.ts';

export type { Span } from '../credentials/matcher.ts';

export const REDACTION = '[redacted credential]';

export const CREDENTIAL_PATTERNS: readonly { rule: string; pattern: RegExp }[] = [
  { rule: 'anthropic_key', pattern: /sk-ant-(?:api|oat|ort|admin)\d{2}-[A-Za-z0-9_-]{20,}/g },
  {
    rule: 'openai_key',
    pattern: /sk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{40,}|sk-[A-Za-z0-9]{20,}T3BlbkFJ[A-Za-z0-9]{20,}/g,
  },
  { rule: 'github_token', pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{60,}\b/g },
  { rule: 'slack_token', pattern: /\bxox[abprs]-[A-Za-z0-9-]{20,}/g },
  { rule: 'bearer_token', pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{32,}=*/g },
];

const PRIVATE_KEY_BEGIN = /-----BEGIN ((?:[A-Z0-9]+ )*)PRIVATE KEY-----/g;
const ANY_PEM_BEGIN = '-----BEGIN ';

/**
 * Private-key blocks, delimiters and body together. A block without its matching END delimiter, or with another
 * BEGIN before it, is malformed and is withheld through the end of the text.
 */
function privateKeySpans(text: string): Span[] {
  const spans: Span[] = [];
  PRIVATE_KEY_BEGIN.lastIndex = 0;
  for (let match = PRIVATE_KEY_BEGIN.exec(text); match !== null; match = PRIVATE_KEY_BEGIN.exec(text)) {
    const start = match.index;
    const afterBegin = start + match[0].length;
    const end = `-----END ${match[1]}PRIVATE KEY-----`;
    const endIndex = text.indexOf(end, afterBegin);
    const nextBegin = text.indexOf(ANY_PEM_BEGIN, afterBegin);
    if (endIndex < 0 || (nextBegin >= 0 && nextBegin < endIndex)) {
      spans.push([start, text.length]);
      break;
    }
    spans.push([start, endIndex + end.length]);
    PRIVATE_KEY_BEGIN.lastIndex = endIndex + end.length;
  }
  return spans;
}

/** Sorted, merged spans: overlapping or touching spans become one. */
export function mergeSpans(spans: Iterable<Span>): Span[] {
  const sorted = [...spans].filter(([start, end]) => end > start).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: [number, number][] = [];
  for (const [start, end] of sorted) {
    const last = merged.at(-1);
    if (last !== undefined && start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  return merged;
}

/**
 * Replaces each span with the redaction marker, keeping line breaks inside a span so line numbering is
 * unchanged: every non-empty line segment of a span becomes one marker.
 */
export function renderRedacted(text: string, spans: readonly Span[]): string {
  let result = '';
  let cursor = 0;
  for (const [start, end] of spans) {
    result += text.slice(cursor, start);
    for (const piece of text.slice(start, end).split(/(\r?\n)/)) {
      result += piece === '' || piece === '\n' || piece === '\r\n' ? piece : REDACTION;
    }
    cursor = end;
  }
  return result + text.slice(cursor);
}

export interface ContentPolicy {
  /** The visible replacement for protected material. */
  readonly marker: string;
  /** Sorted, merged spans of recognized credential material in the complete text. */
  spans(text: string): Span[];
  /** The first rule a text violates, if any. */
  detect(text: string): string | undefined;
  /** Text with every detected credential replaced by a visible marker, line structure preserved. */
  redact(text: string): string;
}

/**
 * The execution content policy. The exact matcher is required, so production code cannot silently fall back to
 * pattern-only screening; credential-free contexts pass NO_KNOWN_CREDENTIALS explicitly.
 */
export function createContentPolicy(matcher: ExactSecretMatcher): ContentPolicy {
  if (!isExactSecretMatcher(matcher))
    throw new TypeError('a credential matcher from the credential boundary is required');
  const rawSpans = (text: string): { rule: string; span: Span }[] => {
    const found: { rule: string; span: Span }[] = matcher
      .spans(text)
      .map((span) => ({ rule: 'known_credential', span }));
    for (const span of privateKeySpans(text)) found.push({ rule: 'private_key', span });
    for (const { rule, pattern } of CREDENTIAL_PATTERNS) {
      for (const match of text.matchAll(pattern))
        found.push({ rule, span: [match.index, match.index + match[0].length] });
    }
    return found;
  };
  const policy: ContentPolicy = {
    marker: REDACTION,
    spans: (text) => mergeSpans(rawSpans(text).map(({ span }) => span)),
    detect(text) {
      const found = rawSpans(text);
      const known = found.find(({ rule }) => rule === 'known_credential');
      return (known ?? found[0])?.rule;
    },
    redact: (text) => renderRedacted(text, policy.spans(text)),
  };
  return Object.freeze(policy);
}

/** Every string inside a JSON value, including object keys. */
export function* stringsIn(value: unknown): Generator<string> {
  if (typeof value === 'string') yield value;
  else if (Array.isArray(value)) for (const item of value) yield* stringsIn(item);
  else if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      yield key;
      yield* stringsIn(item);
    }
  }
}

export type InputScreen = { ok: true } | { ok: false; code: 'credential_in_input' };

/**
 * Goals and answers containing credential material are refused, never rewritten: the owner's words are either
 * recorded exactly or not at all. The response names no rule and echoes nothing.
 */
export function screenOwnerInput(policy: ContentPolicy, value: unknown): InputScreen {
  for (const text of stringsIn(value)) {
    if (policy.detect(text) !== undefined) return { ok: false, code: 'credential_in_input' };
  }
  return { ok: true };
}
