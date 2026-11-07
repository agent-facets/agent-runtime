// The sidebar: a way to start a session, every session (newest first, refreshed while open), and the installed
// capabilities. Each session shows its first message, status, provider, start time, short identity and how long
// ago it last changed: the first message leads, the rest is quieter metadata.
import type { RunSummary } from '@agent-runtime/contracts';
import { type MouseEvent, useCallback, useEffect, useRef, useState } from 'react';
import type { ApiClient } from '../api/client.ts';
import { formatAge, formatClock, formatTime, providerLabel } from './format.ts';
import { CAPABILITIES_HREF, runHref } from './route.ts';
import { button, CloseIcon, cx, meta, muted, PlusIcon, Status, sectionTitle } from './ui.tsx';

const LIST_REFRESH_MS = 5_000;

/** A row in the sidebar: a quiet fill when hovered, a stronger one when it is the current page. */
const navRow = (active: boolean) =>
  cx(
    'block rounded-lg px-3 py-2 text-sm focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-blue-600',
    'hover:bg-zinc-200/60 dark:hover:bg-zinc-800/70',
    active && 'bg-zinc-200/80 dark:bg-zinc-800',
  );

export function Sidebar({
  client,
  activeRunId,
  capabilitiesActive = false,
  onClose,
  onNavigate,
}: {
  client: ApiClient;
  activeRunId: string | undefined;
  capabilitiesActive?: boolean;
  /** Present while the sidebar is an open drawer. */
  onClose: (() => void) | undefined;
  /** Called when a destination is chosen, including the page already shown. */
  onNavigate?: () => void;
}) {
  const close = useRef<HTMLButtonElement>(null);
  const drawer = onClose !== undefined;
  useEffect(() => {
    if (drawer) close.current?.focus();
  }, [drawer]);
  const chose = (event: MouseEvent) => {
    if (event.target instanceof Element && event.target.closest('a') !== null) onNavigate?.();
  };
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: links are activated by keyboard as clicks; this only observes them.
    <nav aria-label="Console" className="flex h-full flex-col" onClick={chose}>
      <div className="flex h-14 shrink-0 items-center justify-between pr-2 pl-4">
        <a href="#/" className="rounded text-sm font-semibold tracking-tight">
          Agent runtime
        </a>
        {onClose !== undefined && (
          <button ref={close} type="button" className={button.ghost} aria-label="Close sessions" onClick={onClose}>
            <CloseIcon />
          </button>
        )}
      </div>
      <div className="px-3">
        <a href="#/" className={cx(button.secondary, 'w-full')}>
          <PlusIcon />
          New session
        </a>
      </div>
      <h2 className={cx(sectionTitle, 'px-5 pt-6 pb-2')}>Sessions</h2>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        <SessionList client={client} activeRunId={activeRunId} />
      </div>
      <div className="border-t border-zinc-200 p-2 dark:border-zinc-800">
        <a
          href={CAPABILITIES_HREF}
          aria-current={capabilitiesActive ? 'page' : undefined}
          className={cx(navRow(capabilitiesActive), 'font-medium text-zinc-700 dark:text-zinc-300')}
        >
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
  const [olderFailed, setOlderFailed] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);

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
    setLoadingOlder(true);
    const outcome = await client.listRuns(next);
    setLoadingOlder(false);
    setOlderFailed(!outcome.ok);
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
        <p role="status" className="px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
          The list cannot be refreshed right now.
        </p>
      )}
      {runs === undefined && !unavailable && <p className={cx('px-3 py-2', meta)}>Loading sessions…</p>}
      {runs !== undefined && runs.length === 0 && <p className={cx('px-3 py-2 text-sm', muted)}>No sessions yet.</p>}
      {runs !== undefined && runs.length > 0 && (
        <ul className="sessions space-y-0.5">
          {runs.map((run) => (
            <SessionItem key={run.runId} run={run} active={run.runId === activeRunId} />
          ))}
        </ul>
      )}
      {olderFailed && (
        <p role="status" className="px-3 pt-2 text-xs text-amber-700 dark:text-amber-400">
          Older sessions could not be loaded.
        </p>
      )}
      {next !== undefined && (
        <button
          type="button"
          className={cx(button.ghost, 'mt-2 w-full')}
          disabled={loadingOlder}
          onClick={() => void more()}
        >
          {loadingOlder ? 'Loading…' : 'Load older sessions'}
        </button>
      )}
    </>
  );
}

export function SessionItem({ run, active }: { run: RunSummary; active: boolean }) {
  return (
    <li>
      <a href={runHref(run.runId)} aria-current={active ? 'page' : undefined} className={navRow(active)}>
        <span className="flex items-baseline gap-2">
          <span className="session-title min-w-0 flex-1 truncate font-medium" title={run.goal}>
            {run.goal}
          </span>
          <time
            dateTime={run.lastActivityAt}
            title={`Last activity ${formatTime(run.lastActivityAt)}`}
            className={cx('shrink-0', meta)}
          >
            {formatAge(run.lastActivityAt)}
          </time>
        </span>
        <span className="mt-0.5 flex min-w-0 items-center gap-1 text-xs">
          <Status kind={run.status} className="shrink-0" />
          <span
            className={cx('truncate', muted)}
            title={`${run.model} · started ${formatTime(run.createdAt)} · ${run.runId}`}
          >
            · {providerLabel(run.provider)} · started <time dateTime={run.createdAt}>{formatClock(run.createdAt)}</time>{' '}
            · <span className="font-mono">{run.runId.slice(0, 8)}</span>
          </span>
        </span>
      </a>
    </li>
  );
}
