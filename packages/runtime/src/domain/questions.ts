import type { Answer, QuestionInput } from '../records/schemas.ts';
import { TEXT_ANSWER_MAX_BYTES } from '../records/schemas.ts';
import { codePoints, isStorableText, utf8Bytes } from './text.ts';

export type AnswerErrorCode =
  | 'answer_missing'
  | 'answer_wrong_type'
  | 'answer_too_short'
  | 'answer_too_long'
  | 'answer_not_storable'
  | 'answer_not_an_option'
  | 'answer_duplicate_selection'
  | 'answer_selection_count';

export type AnswerValidation = { ok: true; answer: Answer } | { ok: false; code: AnswerErrorCode };

type Scalar = string | number | boolean | null;

/** Choice values compare by JSON type and value: false is not "false", and 0 is not "0". */
function sameScalar(a: unknown, b: Scalar): boolean {
  if (a === null || b === null) return a === b;
  return typeof a === typeof b && a === b;
}

function isScalar(value: unknown): value is Scalar {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  );
}

/**
 * Validates a submission against the question it answers and returns the canonical answer. The submission must
 * carry an `answer` property; its value is checked by presence and declared variant, never truthiness. Text is
 * returned exactly as submitted. Multiple-choice selections are returned in the question's option order, so two
 * submissions choosing the same options compare equal; a repeated selection is refused rather than merged.
 */
export function canonicalAnswer(input: QuestionInput, submission: object): AnswerValidation {
  if (!Object.hasOwn(submission, 'answer')) return { ok: false, code: 'answer_missing' };
  const answer: unknown = (submission as { answer: unknown }).answer;
  if (answer === undefined) return { ok: false, code: 'answer_missing' };

  if (input.kind === 'text') {
    if (typeof answer !== 'string') return { ok: false, code: 'answer_wrong_type' };
    if (!isStorableText(answer)) return { ok: false, code: 'answer_not_storable' };
    const length = codePoints(answer);
    if (length < input.minLength) return { ok: false, code: 'answer_too_short' };
    if (length > input.maxLength || utf8Bytes(answer) > TEXT_ANSWER_MAX_BYTES) {
      return { ok: false, code: 'answer_too_long' };
    }
    return { ok: true, answer };
  }

  if (!input.multiple) {
    if (!isScalar(answer)) return { ok: false, code: 'answer_wrong_type' };
    const option = input.options.find((candidate) => sameScalar(answer, candidate.value));
    return option === undefined ? { ok: false, code: 'answer_not_an_option' } : { ok: true, answer: option.value };
  }

  if (!Array.isArray(answer)) return { ok: false, code: 'answer_wrong_type' };
  const chosen = new Set<number>();
  for (const selection of answer) {
    if (!isScalar(selection)) return { ok: false, code: 'answer_wrong_type' };
    const index = input.options.findIndex((candidate) => sameScalar(selection, candidate.value));
    if (index < 0) return { ok: false, code: 'answer_not_an_option' };
    if (chosen.has(index)) return { ok: false, code: 'answer_duplicate_selection' };
    chosen.add(index);
  }
  if (chosen.size < input.minSelections || chosen.size > input.maxSelections) {
    return { ok: false, code: 'answer_selection_count' };
  }
  return { ok: true, answer: input.options.filter((_, index) => chosen.has(index)).map((option) => option.value) };
}
