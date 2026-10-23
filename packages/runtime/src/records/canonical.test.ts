import { describe, expect, test } from 'bun:test';
import { canonicalJson, digestOf, parseSequence } from './canonical.ts';
import { creationInputDigest, isAmbiguousCommitError, RunStoreError } from './run-store.ts';

describe('canonical JSON', () => {
  test('sorts object keys recursively and keeps array order and scalar types', () => {
    expect(canonicalJson({ b: [2, 1], a: { d: false, c: null } })).toBe('{"a":{"c":null,"d":false},"b":[2,1]}');
    expect(digestOf({ x: 1, y: 2 })).toBe(digestOf({ y: 2, x: 1 }));
    expect(digestOf({ answer: false })).not.toBe(digestOf({ answer: 'false' }));
  });

  test('creation identity covers the submitted goal and provider exactly', () => {
    const base = creationInputDigest({ goal: 'Inspect', provider: 'anthropic' });
    expect(creationInputDigest({ goal: 'Inspect', provider: 'anthropic' })).toBe(base);
    expect(creationInputDigest({ goal: 'Inspect ', provider: 'anthropic' })).not.toBe(base);
    expect(creationInputDigest({ goal: 'Inspect', provider: 'openai' })).not.toBe(base);
  });
});

describe('decimal sequences', () => {
  test('preserve values beyond the JavaScript safe-integer range', () => {
    expect(parseSequence('9007199254740993')).toBe(9_007_199_254_740_993n);
    expect(parseSequence('9007199254740993') > parseSequence('9007199254740992')).toBe(true);
    expect(parseSequence('0')).toBe(0n);
  });

  test('refuse non-canonical or out-of-range cursors', () => {
    for (const text of ['', '-1', '01', '1.0', '1e3', ' 1', '9223372036854775808', 'abc']) {
      expect(() => parseSequence(text)).toThrow(RangeError);
    }
  });
});

describe('commit certainty', () => {
  test('a server-reported rejection is definite; connection loss is ambiguous', () => {
    expect(isAmbiguousCommitError(Object.assign(new Error('x'), { errno: '23505' }))).toBe(false);
    expect(isAmbiguousCommitError(Object.assign(new Error('x'), { errno: '40001' }))).toBe(false);
    expect(isAmbiguousCommitError(Object.assign(new Error('x'), { errno: '08006' }))).toBe(true);
    expect(isAmbiguousCommitError(Object.assign(new Error('x'), { errno: '57P01' }))).toBe(true);
    expect(isAmbiguousCommitError(Object.assign(new Error('closed'), { code: 'ERR_POSTGRES_CONNECTION_CLOSED' }))).toBe(
      true,
    );
    expect(isAmbiguousCommitError(new RunStoreError('stale_revision', 'x'))).toBe(false);
  });
});
