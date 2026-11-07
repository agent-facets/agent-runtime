// Answers the run's pending question, exactly as typed: a choice's value keeps its JSON type (`false` is not
// "false"), text is sent as written, and multiple choices are sent as the selected values.
import { canonicalAnswer, type QuestionView } from '@agent-runtime/contracts';
import { type FormEvent, useState } from 'react';
import type { ApiClient } from '../api/client.ts';
import { actorLabel, formatValue } from './format.ts';
import { button, cx, field, label, muted, Notice, optionRow } from './ui.tsx';

const INVALID: Record<string, string> = {
  answer_missing: 'Choose or enter an answer.',
  answer_wrong_type: 'That answer does not fit this question.',
  answer_too_short: 'The answer is too short.',
  answer_too_long: 'The answer is too long.',
  answer_not_storable: 'The answer contains characters that cannot be stored.',
  answer_not_an_option: 'Choose one of the offered options.',
  answer_duplicate_selection: 'An option is selected twice.',
  answer_selection_count: 'Select an allowed number of options.',
};

type AnswerNotice = { tone: 'error' | 'uncertain' | 'info'; text: string };

/** The pending question's form, which the session page moves to on request. */
export const QUESTION_FORM_ID = 'pending-question';

/** The element holding a question's record (or, before history has it, its provisional entry). */
export const questionRecordId = (questionId: string) => `question-${questionId}`;

/** The element holding a question's prompt: the form is described by it, so the prompt is shown only once. */
export const questionPromptId = (questionId: string) => `question-prompt-${questionId}`;

/** Moves to the answer form's first control, on request. */
export function focusAnswer() {
  document.getElementById(QUESTION_FORM_ID)?.querySelector<HTMLElement>('input, textarea')?.focus();
}

/** Brings a question's prompt into view and focus, on request. */
function viewQuestion(questionId: string) {
  const record = document.getElementById(questionRecordId(questionId));
  if (record === null) return;
  record.tabIndex = -1;
  record.scrollIntoView({ block: 'center' });
  record.focus({ preventScroll: true });
}

const askerLabel = (question: QuestionView) =>
  question.asker === undefined
    ? 'The agent asks'
    : question.asker.kind === 'root'
      ? 'The root agent asks'
      : `${actorLabel(question.asker)} asks`;

export function QuestionForm({
  client,
  runId,
  question,
  onSettled,
}: {
  client: ApiClient;
  runId: string;
  question: QuestionView;
  /** The run should be re-read: the answer was recorded, or something else was. */
  onSettled: () => void;
}) {
  const { input } = question;
  const [text, setText] = useState('');
  const [single, setSingle] = useState<number | undefined>();
  const [multiple, setMultiple] = useState<ReadonlySet<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const [message, setNotice] = useState<AnswerNotice | undefined>();

  const answer = (): { ok: true; value: unknown } | { ok: false } => {
    if (input.kind === 'text') return { ok: true, value: text };
    if (!input.multiple) {
      const option = single === undefined ? undefined : input.options[single];
      return option === undefined ? { ok: false } : { ok: true, value: option.value };
    }
    return { ok: true, value: input.options.filter((_, index) => multiple.has(index)).map((option) => option.value) };
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    const chosen = answer();
    if (!chosen.ok) return setNotice({ tone: 'error', text: INVALID.answer_missing as string });
    const valid = canonicalAnswer(input, { answer: chosen.value });
    if (!valid.ok) return setNotice({ tone: 'error', text: INVALID[valid.code] ?? 'That answer is not valid.' });
    setBusy(true);
    setNotice(undefined);
    const outcome = await client.answer(runId, question.questionId, valid.answer);
    setBusy(false);
    if (outcome.ok) {
      setNotice({ tone: 'info', text: `Answer accepted: ${formatValue(outcome.value.acceptance.answer)}` });
      return onSettled();
    }
    if (outcome.kind !== 'refused' || outcome.error.acceptance === 'unknown') {
      return setNotice({
        tone: 'uncertain',
        text: 'The answer may have been recorded, but no reply arrived. Submitting the same answer again is safe.',
      });
    }
    setNotice({ tone: 'error', text: outcome.error.message });
    // A conflict, a closed question or a refused continuation means the run changed: show what is recorded.
    if (outcome.status === 409) onSettled();
  };

  return (
    // The prompt itself is in the conversation (or its provisional entry above the form): the form only answers it,
    // and is described by it, so a screen reader hears the question with the controls.
    <form
      id={QUESTION_FORM_ID}
      className="question space-y-3"
      onSubmit={submit}
      aria-label="Answer the question"
      aria-describedby={questionPromptId(question.questionId)}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h3 className="flex items-center gap-1.5 text-xs font-medium text-amber-700 dark:text-amber-400">
          <span aria-hidden="true" className="size-1.5 rounded-full bg-amber-500" />
          {askerLabel(question)}
        </h3>
        <button type="button" className={button.link} onClick={() => viewQuestion(question.questionId)}>
          View question ↑
        </button>
      </div>
      {input.kind === 'text' && (
        <label className={label}>
          <span className="sr-only">Your answer</span>
          <textarea
            name="answer"
            value={text}
            rows={2}
            className={cx(field, 'max-h-40 resize-y')}
            onChange={(event) => setText(event.target.value)}
          />
          <span className={cx('mt-1 block text-xs font-normal', muted)}>
            {input.minLength > 0 ? `At least ${input.minLength} characters; ` : ''}at most {input.maxLength}.
          </span>
        </label>
      )}
      {input.kind === 'choice' && (
        <fieldset className="flex flex-wrap gap-2">
          <legend className={cx('mb-2 text-xs', muted)}>
            {input.multiple ? `Choose ${input.minSelections} to ${input.maxSelections}` : 'Choose one'}
          </legend>
          {input.options.map((option, index) => (
            <label key={JSON.stringify(option.value)} className={optionRow}>
              <input
                type={input.multiple ? 'checkbox' : 'radio'}
                name="answer"
                className="mt-0.5 accent-zinc-900 dark:accent-zinc-100"
                checked={input.multiple ? multiple.has(index) : single === index}
                onChange={() => {
                  if (!input.multiple) return setSingle(index);
                  const next = new Set(multiple);
                  if (next.has(index)) next.delete(index);
                  else next.add(index);
                  setMultiple(next);
                }}
              />
              <span className="min-w-0 break-words">{option.label}</span>
            </label>
          ))}
        </fieldset>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" className={button.primary} disabled={busy}>
          {busy ? 'Sending…' : 'Send answer'}
        </button>
        {message !== undefined && (
          <Notice tone={message.tone} className="min-w-48 flex-1">
            {message.text}
          </Notice>
        )}
      </div>
    </form>
  );
}
