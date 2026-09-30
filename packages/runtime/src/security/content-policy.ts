// Credential detection for text entering or leaving the agent: owner input, tool results and model output.
//
// Two kinds of evidence, deliberately narrow:
//   - exact matches of this runtime's live credential values, supplied by the credential boundary through an
//     opaque KnownSecrets source (callers never see the values), and
//   - a small set of high-confidence credential formats (vendor-prefixed keys, private-key blocks, bearer
//     headers with a literal token).
// Long identifiers, hashes, UUIDs and base64 are not treated as secrets, and generic JWT-shaped strings are not
// matched by pattern: a repository's test JWT and a live token look alike, so live tokens are caught by exact
// match instead. This is credential hygiene for this runtime, not general data-loss prevention.

/** Opaque view of live credential values; provided by the credential boundary. */
export interface KnownSecrets {
  /** Current values, each at least 16 characters. */
  values(): Iterable<string>;
}

const MIN_KNOWN_SECRET_LENGTH = 16;
export const REDACTION = '[redacted credential]';

export const CREDENTIAL_PATTERNS: readonly { rule: string; pattern: RegExp }[] = [
  { rule: 'anthropic_key', pattern: /sk-ant-(?:api|oat|ort|admin)\d{2}-[A-Za-z0-9_-]{20,}/g },
  {
    rule: 'openai_key',
    pattern: /sk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{40,}|sk-[A-Za-z0-9]{20,}T3BlbkFJ[A-Za-z0-9]{20,}/g,
  },
  { rule: 'github_token', pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{60,}\b/g },
  { rule: 'slack_token', pattern: /\bxox[abprs]-[A-Za-z0-9-]{20,}/g },
  { rule: 'private_key', pattern: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/g },
  { rule: 'bearer_token', pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{32,}=*/g },
];

export interface ContentPolicy {
  /** The first rule a text violates, if any. */
  detect(text: string): string | undefined;
  /** Text with every detected credential replaced by a visible marker. */
  redact(text: string): string;
}

export function createContentPolicy(known: KnownSecrets = { values: () => [] }): ContentPolicy {
  const secrets = () => [...known.values()].filter((value) => value.length >= MIN_KNOWN_SECRET_LENGTH);
  return {
    detect(text) {
      if (secrets().some((secret) => text.includes(secret))) return 'known_credential';
      for (const { rule, pattern } of CREDENTIAL_PATTERNS) {
        pattern.lastIndex = 0;
        if (pattern.test(text)) return rule;
      }
      return undefined;
    },
    redact(text) {
      let result = text;
      // Longest first, so a secret containing another is replaced whole.
      for (const secret of secrets().sort((a, b) => b.length - a.length)) result = result.replaceAll(secret, REDACTION);
      for (const { pattern } of CREDENTIAL_PATTERNS) result = result.replace(pattern, REDACTION);
      return result;
    },
  };
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
