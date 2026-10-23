// Display wording for run states, failure categories and times. All text is application-owned; values from the
// server are rendered as plain text by React, never as markup.
import type { FailureCategory, Provider, RunStateKind } from '@agent-runtime/contracts';
import { PROVIDER_LABELS } from '@agent-runtime/contracts';

export const STATE_LABELS: Record<RunStateKind, string> = {
  working: 'Working',
  waiting: 'Waiting for you',
  cancelling: 'Cancelling',
  succeeded: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
  interrupted: 'Interrupted',
};

export const STATE_DESCRIPTIONS: Record<RunStateKind, string> = {
  working: 'The agent is working. You can close this page; the run continues.',
  waiting: 'The agent is waiting for your answer.',
  cancelling: 'Cancellation was accepted. Work already in progress is stopping.',
  succeeded: 'The run finished with a recorded result.',
  failed: 'The run stopped with a failure. Its history is preserved.',
  cancelled: 'The run was cancelled. Its history is preserved.',
  interrupted:
    'The runtime stopped while this run was working. It will not be resumed; start a new run to continue the work.',
};

export const FAILURE_LABELS: Record<FailureCategory, string> = {
  authorization: 'authorization',
  rate_or_quota_limit: 'rate or quota limit',
  provider_failure: 'provider failure',
  step_limit: 'step limit',
  continuation_unavailable: 'continuation unavailable',
  tool_failure: 'tool failure',
  runtime_failure: 'runtime failure',
};

export const providerLabel = (provider: Provider) => PROVIDER_LABELS[provider];

/** A recorded instant in the reader's locale, with the exact UTC value available on hover. */
export function formatTime(instant: string): string {
  const date = new Date(instant);
  return Number.isNaN(date.getTime())
    ? instant
    : date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'medium' });
}

/** Typed values shown as themselves: `false` is "false", `null` is "null", text is quoted. */
export function formatValue(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return value.length === 0 ? '(none)' : value.map(formatValue).join(', ');
  return String(value);
}
