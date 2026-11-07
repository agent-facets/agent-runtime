// Answers the run's pending question, exactly as typed: a choice's value keeps its JSON type (`false` is not
// "false"), text is sent as written, and multiple choices are sent as the selected values.
import { canonicalAnswer, type QuestionView } from '@agent-runtime/contracts';
import { type FormEvent, useState } from 'react';
import type { ApiClient } from '../api/client.ts';
import { actorLabel, formatValue } from './format.ts';
import { button, cx, field, label, muted, notice } from './ui.tsx';

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

type Notice = { tone: 'error' | 'uncertain' | 'info'; text: string };

/** The pending question's form, which the session page moves to on request. */
export const QUESTION_FORM_ID = 'pending-question';

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
  const [message, setNotice] = useState<Notice | undefined>();

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
    <form
      id={QUESTION_FORM_ID}
      className={cx(
        'question space-y-3 border-amber-300 p-4 shadow-sm dark:border-amber-800',
        'rounded-xl border bg-white dark:bg-zinc-900',
      )}
      onSubmit={submit}
      aria-label="Answer the question"
    >
      <div>
        <h3 className="text-xs font-semibold tracking-wide text-amber-700 uppercase dark:text-amber-400">
          {question.asker === undefined
            ? 'The agent asks'
            : question.asker.kind === 'root'
              ? 'The root agent asks'
              : `${actorLabel(question.asker)} asks`}
        </h3>
        <p className="prompt mt-1 text-[0.9375rem] break-words whitespace-pre-wrap">{question.prompt}</p>
      </div>
      {input.kind === 'text' && (
        <label className={label}>
          Your answer
          <textarea
            name="answer"
            value={text}
            rows={2}
            className={cx(field, 'max-h-40')}
            onChange={(event) => setText(event.target.value)}
          />
          <span className={cx('mt-1 block text-xs font-normal', muted)}>
            {input.minLength > 0 ? `At least ${input.minLength} characters; ` : ''}at most {input.maxLength}.
          </span>
        </label>
      )}
      {input.kind === 'choice' && (
        <fieldset className="max-h-48 space-y-1 overflow-y-auto">
          <legend className={cx('mb-1 text-xs', muted)}>
            {input.multiple ? `Choose ${input.minSelections} to ${input.maxSelections}` : 'Choose one'}
          </legend>
          {input.options.map((option, index) => (
            <label
              key={JSON.stringify(option.value)}
              className="flex cursor-pointer items-center gap-2.5 rounded-lg border border-zinc-200 px-3 py-2 text-sm hover:bg-zinc-50 has-checked:border-zinc-900 has-checked:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-800 dark:has-checked:border-zinc-100 dark:has-checked:bg-zinc-800"
            >
              <input
                type={input.multiple ? 'checkbox' : 'radio'}
                name="answer"
                className="accent-zinc-900 dark:accent-zinc-100"
                checked={input.multiple ? multiple.has(index) : single === index}
                onChange={() => {
                  if (!input.multiple) return setSingle(index);
                  const next = new Set(multiple);
                  if (next.has(index)) next.delete(index);
                  else next.add(index);
                  setMultiple(next);
                }}
              />
              {option.label}
            </label>
          ))}
        </fieldset>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" className={button.primary} disabled={busy}>
          {busy ? 'Sending…' : 'Send answer'}
        </button>
        {message !== undefined && <p className={cx(notice(message.tone), 'flex-1')}>{message.text}</p>}
      </div>
    </form>
  );
}
