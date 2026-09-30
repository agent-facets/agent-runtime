import { describe, expect, test } from 'bun:test';
import type { QuestionInput } from '../records/schemas.ts';
import { canonicalAnswer } from './questions.ts';
import { codePoints, isStorableText, utf8Bytes } from './text.ts';

const text = (minLength: number, maxLength: number): QuestionInput => ({ kind: 'text', minLength, maxLength });
const typedOptions = [
  { label: 'No', value: false },
  { label: 'The word false', value: 'false' },
  { label: 'Unknown', value: null },
  { label: 'Zero', value: 0 },
  { label: 'Empty', value: '' },
];
const single: QuestionInput = { kind: 'choice', multiple: false, options: typedOptions };
const multi = (minSelections: number, maxSelections: number): QuestionInput => ({
  kind: 'choice',
  multiple: true,
  options: typedOptions,
  minSelections,
  maxSelections,
});

describe('text measurement', () => {
  test('counts UTF-8 bytes and code points rather than UTF-16 units', () => {
    expect(utf8Bytes('é')).toBe(2);
    expect(utf8Bytes('😀')).toBe(4);
    expect('😀'.length).toBe(2);
    expect(codePoints('😀é')).toBe(2);
    expect(codePoints('e\u0301')).toBe(2);
  });

  test('refuses NUL and lone surrogates but accepts paired surrogates', () => {
    expect(isStorableText('a\u0000b')).toBe(false);
    expect(isStorableText('\uD83D')).toBe(false);
    expect(isStorableText('x\uDE00')).toBe(false);
    expect(isStorableText('😀')).toBe(true);
  });
});

describe('canonical answers', () => {
  test('the answer property must be present; false, null, zero and empty values are answers', () => {
    expect(canonicalAnswer(single, {})).toEqual({ ok: false, code: 'answer_missing' });
    expect(canonicalAnswer(single, { answer: undefined })).toEqual({ ok: false, code: 'answer_missing' });
    for (const value of [false, 'false', null, 0, '']) {
      expect(canonicalAnswer(single, { answer: value })).toEqual({ ok: true, answer: value });
    }
  });

  test('choice values compare by JSON type as well as value', () => {
    const booleanOnly: QuestionInput = { kind: 'choice', multiple: false, options: [{ label: 'No', value: false }] };
    for (const answer of ['false', 0, null, '']) {
      expect(canonicalAnswer(booleanOnly, { answer })).toEqual({ ok: false, code: 'answer_not_an_option' });
    }
    const zeroOnly: QuestionInput = { kind: 'choice', multiple: false, options: [{ label: 'Zero', value: 0 }] };
    expect(canonicalAnswer(zeroOnly, { answer: '0' }).ok).toBe(false);
    expect(canonicalAnswer(zeroOnly, { answer: false }).ok).toBe(false);
  });

  test('refuses values of the wrong shape', () => {
    for (const answer of [[false], { value: false }, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(canonicalAnswer(single, { answer }).ok).toBe(false);
    }
    for (const answer of [false, 'false', { value: false }, [[0]]]) {
      expect(canonicalAnswer(multi(0, 5), { answer }).ok).toBe(false);
    }
    expect(canonicalAnswer(text(0, 10), { answer: 5 })).toEqual({ ok: false, code: 'answer_wrong_type' });
  });

  test('multiple choices come back in declared option order, whatever the submission order', () => {
    const first = canonicalAnswer(multi(1, 5), { answer: [0, false] });
    const second = canonicalAnswer(multi(1, 5), { answer: [false, 0] });
    expect(first).toEqual({ ok: true, answer: [false, 0] });
    expect(second).toEqual(first);
    expect(canonicalAnswer(multi(1, 5), { answer: ['', null, 'false'] })).toEqual({
      ok: true,
      answer: ['false', null, ''],
    });
  });

  test('repeated selections are refused, not merged, and selection counts are enforced', () => {
    expect(canonicalAnswer(multi(0, 5), { answer: [false, false] })).toEqual({
      ok: false,
      code: 'answer_duplicate_selection',
    });
    expect(canonicalAnswer(multi(0, 5), { answer: [] })).toEqual({ ok: true, answer: [] });
    expect(canonicalAnswer(multi(1, 5), { answer: [] })).toEqual({ ok: false, code: 'answer_selection_count' });
    expect(canonicalAnswer(multi(1, 2), { answer: [false, 0, null] })).toEqual({
      ok: false,
      code: 'answer_selection_count',
    });
    expect(canonicalAnswer(multi(1, 2), { answer: ['missing'] })).toEqual({ ok: false, code: 'answer_not_an_option' });
  });

  test('text is preserved exactly, including whitespace and combining characters', () => {
    for (const answer of ['  padded  ', 'e\u0301', 'no', 'line\nbreak']) {
      expect(canonicalAnswer(text(0, 100), { answer })).toEqual({ ok: true, answer });
    }
    expect(canonicalAnswer(text(0, 10), { answer: '' })).toEqual({ ok: true, answer: '' });
    expect(canonicalAnswer(text(1, 10), { answer: '' })).toEqual({ ok: false, code: 'answer_too_short' });
  });

  test('declared text lengths count code points; the storage ceiling is 8 KiB of UTF-8', () => {
    expect(canonicalAnswer(text(0, 3), { answer: '😀😀😀' }).ok).toBe(true);
    expect(canonicalAnswer(text(0, 3), { answer: '😀😀😀😀' })).toEqual({ ok: false, code: 'answer_too_long' });
    expect(canonicalAnswer(text(0, 8192), { answer: 'a'.repeat(8192) }).ok).toBe(true);
    expect(canonicalAnswer(text(0, 8192), { answer: 'a'.repeat(8193) }).ok).toBe(false);
    expect(canonicalAnswer(text(0, 8192), { answer: 'é'.repeat(4096) }).ok).toBe(true);
    expect(canonicalAnswer(text(0, 8192), { answer: 'é'.repeat(4097) })).toEqual({
      ok: false,
      code: 'answer_too_long',
    });
    expect(canonicalAnswer(text(0, 8192), { answer: '😀'.repeat(2048) }).ok).toBe(true);
    expect(canonicalAnswer(text(0, 8192), { answer: '😀'.repeat(2049) }).ok).toBe(false);
  });

  test('unstorable text is refused', () => {
    expect(canonicalAnswer(text(0, 10), { answer: 'a\u0000' })).toEqual({ ok: false, code: 'answer_not_storable' });
    expect(canonicalAnswer(text(0, 10), { answer: '\uD83D' })).toEqual({ ok: false, code: 'answer_not_storable' });
  });
});
