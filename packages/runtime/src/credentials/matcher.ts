// Exact matching of live credential values, owned by the credential boundary. Consumers receive only the ability
// to locate occurrences in text; the values themselves cannot be enumerated or read back.
import { CREDENTIAL_TOKEN_MAX_LENGTH, CREDENTIAL_TOKEN_MIN_LENGTH, CREDENTIAL_TOKEN_PATTERN } from './record.ts';

/** A half-open [start, end) range of UTF-16 offsets. */
export type Span = readonly [start: number, end: number];

export interface ExactSecretMatcher {
  /** Every occurrence of a known credential value in `text`, possibly overlapping. */
  spans(text: string): Span[];
}

const MATCHERS = new WeakSet<ExactSecretMatcher>();

/**
 * Builds a matcher over the given credential values. Values outside the admitted token grammar are refused
 * rather than dropped: a value that could not be recognized must never be accepted as screened.
 */
export function exactSecretMatcher(values: Iterable<string>): ExactSecretMatcher {
  const secrets = [...new Set(values)];
  for (const value of secrets) {
    if (
      value.length < CREDENTIAL_TOKEN_MIN_LENGTH ||
      value.length > CREDENTIAL_TOKEN_MAX_LENGTH ||
      !CREDENTIAL_TOKEN_PATTERN.test(value)
    ) {
      throw new TypeError('a credential value outside the admitted token grammar cannot be matched');
    }
  }
  const matcher: ExactSecretMatcher = Object.freeze({
    spans(text: string): Span[] {
      const found: Span[] = [];
      for (const secret of secrets) {
        for (let index = text.indexOf(secret); index >= 0; index = text.indexOf(secret, index + 1)) {
          found.push([index, index + secret.length]);
        }
      }
      return found;
    },
  });
  MATCHERS.add(matcher);
  return matcher;
}

/**
 * The matcher for contexts that hold no live credentials (tests, and anything that never touches provider
 * access). Execution code must be given the credential boundary's matcher explicitly.
 */
export const NO_KNOWN_CREDENTIALS: ExactSecretMatcher = exactSecretMatcher([]);

/** True for matchers built by this module; a structurally similar object cannot stand in for one. */
export function isExactSecretMatcher(value: unknown): value is ExactSecretMatcher {
  return typeof value === 'object' && value !== null && MATCHERS.has(value as ExactSecretMatcher);
}
