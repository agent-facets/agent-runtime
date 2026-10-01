// Contract-valid runs and events for the console's tests. Test-only.
import type { RunEvent, RunSnapshot, RunState } from '@agent-runtime/contracts';

export const RUN = '00000000-0000-4000-8000-000000000001';
export const QUESTION = 'a'.repeat(64);
export const AT = '2026-09-30T12:00:00.000000Z';

export function snapshot(throughSeq: string, state: RunState = { kind: 'working' }, extra = {}): RunSnapshot {
  return {
    run: {
      runId: RUN,
      goal: 'Summarize the plan.',
      provider: 'anthropic',
      authMode: 'subscription',
      model: 'claude-opus-5',
      workspace: { label: 'Main', root: '/workspace' },
      state,
      budget: { maximum: 10, consumed: 0, unconfirmed: 0 },
      createdAt: AT,
      lastActivityAt: AT,
      ...extra,
    },
    throughSeq,
  };
}

const base = (seq: number | string) => ({ runId: RUN, seq: String(seq), recordedAt: AT });

export const message = (seq: number | string, text = `message ${seq}`): RunEvent => ({
  ...base(seq),
  kind: 'assistant.message',
  payload: { messageId: `m${seq}`, text },
});

export const status = (seq: number | string, state: RunState): RunEvent => ({
  ...base(seq),
  kind: 'run.status',
  payload: { state },
});

export const asked = (seq: number | string): RunEvent => ({
  ...base(seq),
  kind: 'question.asked',
  payload: {
    questionId: QUESTION,
    prompt: 'Proceed?',
    input: {
      kind: 'choice',
      multiple: false,
      options: [
        { label: 'Yes', value: true },
        { label: 'No', value: false },
      ],
    },
  },
});

export const answered = (seq: number | string, answer: unknown = false): RunEvent =>
  ({ ...base(seq), kind: 'question.answered', payload: { questionId: QUESTION, answer, acceptedAt: AT } }) as RunEvent;

export const attempt = (seq: number | string, consumed: number): RunEvent => ({
  ...base(seq),
  kind: 'model.attempt',
  payload: {
    attemptId: '00000000-0000-4000-8000-0000000000a1',
    ordinal: consumed,
    state: { kind: 'dispatched', dispatchedAt: AT },
    budget: { maximum: 10, consumed, unconfirmed: 0 },
  },
});

export const succeeded: RunState = { kind: 'succeeded', finishedAt: AT, resultSeq: '3' };

/** A JSON response as the API sends it. */
export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export const refusal = (code: string, status: number, acceptance = 'not_accepted', retryable = status === 503) =>
  json({ error: { code, message: 'Refused.', retryable, acceptance } }, status);
