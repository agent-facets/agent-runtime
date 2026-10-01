// Human questions and their answers (design Decision 5): the bounded input variants an agent may ask with, and the
// canonical validation of an answer against one. Shared by the server, which decides, and the browser, which uses
// the same rules to explain a refusal before submitting.
import { z } from 'zod';
import { codePoints, isStorableText, utf8Bytes } from './text.ts';

export const QUESTION_PROMPT_MAX_BYTES = 16_384;
/** UTF-8 bytes of a question's text: prompt, option labels and string option values together. */
export const QUESTION_TEXT_MAX_BYTES = 65_536;
export const TEXT_ANSWER_MAX_BYTES = 8192;
export const MAX_OPTIONS = 50;

const int = (min: number, max: number) => z.number().int().min(min).max(max);
const storable = z.string().refine(isStorableText, 'text must be well-formed Unicode without NUL');
/** Nonempty text bounded in UTF-8 bytes. */
const bytesUpTo = (max: number) =>
  storable.refine((text) => text.length > 0 && utf8Bytes(text) <= max, `must be 1 to ${max} UTF-8 bytes`);
/** Nonempty text bounded in code points. */
const codePointsUpTo = (max: number) =>
  storable.refine((text) => text.length > 0 && codePoints(text) <= max, `must be 1 to ${max} characters`);

/** Choice values are JSON scalars; type matters, so `false` is not `"false"`. */
export const scalarSchema = z.union([storable, z.number().refine(Number.isFinite), z.boolean(), z.null()]);
export type Scalar = z.infer<typeof scalarSchema>;

const choiceOption = z.strictObject({ label: codePointsUpTo(256), value: scalarSchema });
const distinctValues = (options: { value: unknown }[]) =>
  new Set(options.map((option) => JSON.stringify(option.value))).size === options.length;

export const questionInputSchema = z.union([
  z
    .strictObject({ kind: z.literal('text'), minLength: int(0, 8192), maxLength: int(1, 8192) })
    .refine((input) => input.minLength <= input.maxLength, 'minLength exceeds maxLength'),
  z
    .strictObject({
      kind: z.literal('choice'),
      multiple: z.literal(false),
      options: z.array(choiceOption).min(1).max(MAX_OPTIONS),
    })
    .refine((input) => distinctValues(input.options), 'option values must be distinct'),
  z
    .strictObject({
      kind: z.literal('choice'),
      multiple: z.literal(true),
      options: z.array(choiceOption).min(1).max(MAX_OPTIONS),
      minSelections: int(0, MAX_OPTIONS),
      maxSelections: int(1, MAX_OPTIONS),
    })
    .refine((input) => distinctValues(input.options), 'option values must be distinct')
    .refine(
      (input) => input.minSelections <= input.maxSelections && input.maxSelections <= input.options.length,
      'invalid selection bounds',
    ),
]);
export type QuestionInput = z.infer<typeof questionInputSchema>;

export const questionPromptSchema = bytesUpTo(QUESTION_PROMPT_MAX_BYTES);

/** Mirrors the runtime database's question_text_bytes. */
export function questionTextBytes(prompt: string, input: QuestionInput): number {
  let bytes = utf8Bytes(prompt);
  if (input.kind === 'choice') {
    for (const option of input.options) {
      bytes += utf8Bytes(option.label) + (typeof option.value === 'string' ? utf8Bytes(option.value) : 0);
    }
  }
  return bytes;
}

export const withinQuestionText = ({ prompt, input }: { prompt: string; input: QuestionInput }) =>
  questionTextBytes(prompt, input) <= QUESTION_TEXT_MAX_BYTES;

/** A complete question definition: its prompt and input variant, bounded together. */
export const questionDefinitionSchema = z
  .strictObject({ prompt: questionPromptSchema, input: questionInputSchema })
  .refine(withinQuestionText, 'question text is too large');
export type QuestionDefinition = z.infer<typeof questionDefinitionSchema>;

export const answerSchema = z.union([scalarSchema, z.array(scalarSchema).max(MAX_OPTIONS)]);
export type Answer = z.infer<typeof answerSchema>;

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
