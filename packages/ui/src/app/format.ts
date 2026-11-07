// Display wording for run states, failure categories and times. All text is application-owned; values from the
// server are rendered as plain text by React, never as markup.
import type { ActorRef, FailureCategory, Provider, RunStateKind } from '@agent-runtime/contracts';
import { PROVIDER_LABELS, STEP_BUDGET_MAX, STEP_BUDGET_MIN } from '@agent-runtime/contracts';

export const STATE_LABELS: Record<RunStateKind, string> = {
  working: 'Working',
  waiting: 'Waiting for you',
  cancelling: 'Stopping',
  succeeded: 'Finished',
  failed: 'Failed',
  cancelled: 'Stopped',
  interrupted: 'Interrupted',
};

export const STATE_DESCRIPTIONS: Record<RunStateKind, string> = {
  working: 'The agent is working. You can close this page; the session continues.',
  waiting: 'The agent is waiting for your answer.',
  cancelling: 'Stopping. Work already in progress may still finish.',
  succeeded: 'The agent finished responding.',
  failed: 'The agent stopped with a failure. The conversation is preserved.',
  cancelled: 'The session was stopped. The conversation is preserved.',
  interrupted:
    'The runtime stopped while this session was working. It will not be resumed; start a new session to continue the work.',
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

/**
 * Who performed recorded agent activity. Root activity in a native or older run carries no actor and needs no
 * label; delegates are told apart by their delegation, so two calls to one named agent stay distinguishable.
 */
export function actorLabel(actor: ActorRef | undefined): string | undefined {
  if (actor === undefined) return undefined;
  return actor.kind === 'root' ? 'Root agent' : `Delegate ${actor.agentId} · ${actor.delegationId.slice(0, 8)}`;
}

export const DELEGATION_OUTCOME_LABELS = {
  result: 'returned a result',
  refused: 'was refused',
  failed: 'failed',
  abandoned: 'was abandoned',
} as const;

export const TASK_BUDGET_GUIDANCE = `Enter a whole number from ${STEP_BUDGET_MIN} to ${STEP_BUDGET_MAX.toLocaleString('en-US')}.`;

/** A task's model-request limit as typed into the start form, or undefined unless it is an accepted whole number. */
export function parseTaskBudget(text: string): number | undefined {
  const trimmed = text.trim();
  if (!/^\d{1,6}$/.test(trimmed)) return undefined;
  const value = Number(trimmed);
  return value >= STEP_BUDGET_MIN && value <= STEP_BUDGET_MAX ? value : undefined;
}

/**
 * A task's model-request usage. Unconfirmed requests may or may not have reached the provider; they are not shown
 * as used, but they still count against the limit, so they reduce what remains.
 */
export function budgetUsage(budget: { maximum: number; consumed: number; unconfirmed: number }): string {
  const remaining = Math.max(0, budget.maximum - budget.consumed - budget.unconfirmed);
  const unconfirmed =
    budget.unconfirmed > 0
      ? ` · ${budget.unconfirmed} unconfirmed (${budget.unconfirmed === 1 ? 'counts' : 'count'} against the limit)`
      : '';
  return `${budget.consumed} of ${budget.maximum} used${unconfirmed} · ${remaining} remaining`;
}

/** A session's model-request usage in a few words; the full accounting is in its details. */
export function budgetSummary(budget: { maximum: number; consumed: number; unconfirmed: number }): string {
  const unconfirmed = budget.unconfirmed > 0 ? ` (+${budget.unconfirmed} unconfirmed)` : '';
  return `${budget.consumed}/${budget.maximum} requests${unconfirmed}`;
}

/** A recorded instant in the reader's locale, with the exact UTC value available on hover. */
export function formatTime(instant: string): string {
  const date = new Date(instant);
  return Number.isNaN(date.getTime())
    ? instant
    : date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'medium' });
}

/** A recorded instant to the minute, for lists; the exact value stays available on hover. */
export function formatShortTime(instant: string): string {
  const date = new Date(instant);
  return Number.isNaN(date.getTime())
    ? instant
    : date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/** How long ago an instant was, briefly ("now", "5m", "3h", "2d"), or its date when older than a week. */
export function formatAge(instant: string, now: number = Date.now()): string {
  const at = new Date(instant).getTime();
  if (Number.isNaN(at)) return instant;
  const minutes = Math.floor(Math.max(0, now - at) / 60_000);
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)}h`;
  if (minutes < 7 * 24 * 60) return `${Math.floor(minutes / (24 * 60))}d`;
  return new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** Typed values shown as themselves: `false` is "false", `null` is "null", text is quoted. */
export function formatValue(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return value.length === 0 ? '(none)' : value.map(formatValue).join(', ');
  return String(value);
}
