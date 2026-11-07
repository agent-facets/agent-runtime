// The sidebar: a way to start a session, every session (newest first, refreshed while open), and the installed
// capabilities. Each session shows its first message, status, provider, start time, short identity and how long
// ago it last changed.
import type { RunSummary } from '@agent-runtime/contracts';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ApiClient } from '../api/client.ts';
import { formatAge, formatShortTime, formatTime, providerLabel } from './format.ts';
import { CAPABILITIES_HREF, runHref } from './route.ts';
import { button, CloseIcon, cx, muted, PlusIcon, Status } from './ui.tsx';

const LIST_REFRESH_MS = 5_000;

export function Sidebar({
  client,
  activeRunId,
  onClose,
}: {
  client: ApiClient;
  activeRunId: string | undefined;
  /** Present while the sidebar is an open drawer. */
  onClose: (() => void) | undefined;
}) {
  const close = useRef<HTMLButtonElement>(null);
  const drawer = onClose !== undefined;
  useEffect(() => {
    if (drawer) close.current?.focus();
  }, [drawer]);
  return (
    <nav aria-label="Sessions" className="flex h-full flex-col">
      <div className="flex h-14 shrink-0 items-center justify-between px-4">
        <a href="#/" className="text-sm font-semibold tracking-tight">
          Agent runtime
        </a>
        {onClose !== undefined && (
          <button ref={close} type="button" className={button.ghost} aria-label="Close sessions" onClick={onClose}>
            <CloseIcon />
          </button>
        )}
      </div>
      <div className="px-3">
        <a href="#/" className={cx(button.secondary, 'w-full justify-start')}>
          <PlusIcon />
          New session
        </a>
      </div>
      <h2 className={cx('px-5 pt-6 pb-2 text-xs font-medium', muted)}>Sessions</h2>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        <SessionList client={client} activeRunId={activeRunId} />
      </div>
      <div className="border-t border-zinc-200 p-3 dark:border-zinc-800">
        <a href={CAPABILITIES_HREF} className={cx(button.ghost, 'w-full justify-start')}>
          Installed capabilities
        </a>
      </div>
    </nav>
  );
}

export function SessionList({ client, activeRunId }: { client: ApiClient; activeRunId?: string | undefined }) {
  const [runs, setRuns] = useState<RunSummary[] | undefined>();
  const [next, setNext] = useState<string | undefined>();
  const [unavailable, setUnavailable] = useState(false);

  const refresh = useCallback(async () => {
    const outcome = await client.listRuns();
    if (!outcome.ok) {
      setUnavailable(true);
      return;
    }
    setUnavailable(false);
    setRuns((current) => {
      // Keep pages loaded beyond the first; the first page replaces its own entries.
      const first = outcome.value.runs;
      const ids = new Set(first.map((run) => run.runId));
      return [...first, ...(current ?? []).slice(first.length).filter((run) => !ids.has(run.runId))];
    });
    setNext((current) => current ?? outcome.value.next);
  }, [client]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), LIST_REFRESH_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  const more = async () => {
    if (next === undefined) return;
    const outcome = await client.listRuns(next);
    if (!outcome.ok) return;
    setRuns((current) => {
      const known = new Set((current ?? []).map((run) => run.runId));
      return [...(current ?? []), ...outcome.value.runs.filter((run) => !known.has(run.runId))];
    });
    setNext(outcome.value.next);
  };

  return (
    <>
      {unavailable && (
        <p className={cx('px-3 py-2 text-xs text-amber-700 dark:text-amber-400')}>
          The list cannot be refreshed right now.
        </p>
      )}
      {runs !== undefined && runs.length === 0 && <p className={cx('px-3 py-2 text-sm', muted)}>No sessions yet.</p>}
      {runs !== undefined && runs.length > 0 && (
        <ul className="sessions space-y-0.5">
          {runs.map((run) => (
            <SessionItem key={run.runId} run={run} active={run.runId === activeRunId} />
          ))}
        </ul>
      )}
      {next !== undefined && (
        <button type="button" className={cx(button.ghost, 'mt-2 w-full')} onClick={() => void more()}>
          Load older sessions
        </button>
      )}
    </>
  );
}

export function SessionItem({ run, active }: { run: RunSummary; active: boolean }) {
  return (
    <li>
      <a
        href={runHref(run.runId)}
        aria-current={active ? 'page' : undefined}
        className={cx(
          'block rounded-lg px-3 py-2 hover:bg-zinc-200/60 dark:hover:bg-zinc-800',
          active && 'bg-zinc-200/80 dark:bg-zinc-800',
        )}
      >
        <span className="flex items-baseline gap-2">
          <span className="session-title min-w-0 flex-1 truncate text-sm font-medium" title={run.goal}>
            {run.goal}
          </span>
          <time
            dateTime={run.lastActivityAt}
            title={`Last activity ${formatTime(run.lastActivityAt)}`}
            className={cx('shrink-0 text-xs', muted)}
          >
            {formatAge(run.lastActivityAt)}
          </time>
        </span>
        <span className="mt-0.5 flex items-center gap-1 text-xs">
          <Status kind={run.status} />
          <span className={muted}>· {providerLabel(run.provider)}</span>
        </span>
        <span className={cx('mt-0.5 block truncate text-xs', muted)} title={`${run.model} · ${run.runId}`}>
          Started{' '}
          <time dateTime={run.createdAt} title={formatTime(run.createdAt)}>
            {formatShortTime(run.createdAt)}
          </time>{' '}
          · <span className="font-mono">{run.runId.slice(0, 8)}</span>
        </span>
      </a>
    </li>
  );
}
