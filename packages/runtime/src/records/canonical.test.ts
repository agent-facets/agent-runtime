import { describe, expect, test } from 'bun:test';
import { canonicalJson, digestOf, parseSequence } from './canonical.ts';
import { creationInputDigest, isAmbiguousCommitError, RunStoreError } from './run-store.ts';

describe('canonical JSON', () => {
  test('sorts object keys recursively and keeps array order and scalar types', () => {
    expect(canonicalJson({ b: [2, 1], a: { d: false, c: null } })).toBe('{"a":{"c":null,"d":false},"b":[2,1]}');
    expect(digestOf({ x: 1, y: 2 })).toBe(digestOf({ y: 2, x: 1 }));
    expect(digestOf({ answer: false })).not.toBe(digestOf({ answer: 'false' }));
  });

  test('canonical bytes are stable: nested key order never matters and JSON types do', () => {
    const a = { z: { y: [1, { b: 2, a: 1 }], x: 'é' }, a: null };
    const b = { a: null, z: { x: 'é', y: [1, { a: 1, b: 2 }] } };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(canonicalJson(a)).toBe('{"a":null,"z":{"x":"é","y":[1,{"a":1,"b":2}]}}');
    expect(digestOf([1, 2])).not.toBe(digestOf([2, 1]));
    expect(digestOf({ n: 0 })).not.toBe(digestOf({ n: '0' }));
    expect(() => canonicalJson({ n: Number.NaN })).toThrow();
  });

  test('a phase-1 goal creation identity is unchanged', () => {
    expect(creationInputDigest({ goal: 'Inspect', provider: 'anthropic' })).toBe(
      'c9133c96b51d81430dc92ff2df5b7e8781832390333a893f568a2fa8143fcb79',
    );
  });

  test('command creation identity covers the normalized submission, never a goal with the same text', () => {
    const command = {
      kind: 'command' as const,
      commandId: 'command:triage',
      selectionRevision: 'a'.repeat(64),
      arguments: 'owner/repo-a',
      provider: 'anthropic' as const,
    };
    const base = creationInputDigest(command);
    expect(creationInputDigest({ ...command })).toBe(base);
    for (const changed of [
      { ...command, arguments: 'owner/repo-b' },
      { ...command, arguments: 'owner/repo-a ' },
      { ...command, selectionRevision: 'b'.repeat(64) },
      { ...command, commandId: 'command:other' },
      { ...command, provider: 'openai' as const },
    ]) {
      expect(creationInputDigest(changed)).not.toBe(base);
    }
    expect(creationInputDigest({ goal: 'owner/repo-a', provider: 'anthropic' })).not.toBe(base);
    expect(() => creationInputDigest({ ...command, renderedGoal: 'x' } as never)).toThrow();
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
