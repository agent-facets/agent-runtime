// Answers the run's pending question, exactly as typed: a choice's value keeps its JSON type (`false` is not
// "false"), text is sent as written, and multiple choices are sent as the selected values.
import { canonicalAnswer, type QuestionView } from '@agent-runtime/contracts';
import { type FormEvent, useState } from 'react';
import type { ApiClient } from '../api/client.ts';
import { formatValue } from './format.ts';

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
  const [notice, setNotice] = useState<Notice | undefined>();

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
    <form className="panel question" onSubmit={submit} aria-label="Answer the question">
      <h2>The agent asks</h2>
      <p className="text prompt">{question.prompt}</p>
      {input.kind === 'text' && (
        <label>
          Your answer
          <textarea name="answer" value={text} rows={3} onChange={(event) => setText(event.target.value)} />
          <span className="hint">
            {input.minLength > 0 ? `At least ${input.minLength} characters; ` : ''}at most {input.maxLength}.
          </span>
        </label>
      )}
      {input.kind === 'choice' && (
        <fieldset>
          <legend>{input.multiple ? `Choose ${input.minSelections} to ${input.maxSelections}` : 'Choose one'}</legend>
          {input.options.map((option, index) => (
            <label key={JSON.stringify(option.value)} className="choice">
              <input
                type={input.multiple ? 'checkbox' : 'radio'}
                name="answer"
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
      <button type="submit" disabled={busy}>
        {busy ? 'Sending…' : 'Send answer'}
      </button>
      {notice !== undefined && <p className={`notice ${notice.tone}`}>{notice.text}</p>}
    </form>
  );
}
