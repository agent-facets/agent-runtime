// One session: its state at a glance in a slim header, details on request, failure explanation, the way to stop it,
// and its conversation. A pending question is answered in a form docked below the conversation, like a reply. The
// view follows the run's committed history; whether this page is connected is shown separately and never changes
// what the session is shown to be doing.
import type { RunCapabilitiesView, RunView } from '@agent-runtime/contracts';
import { TERMINAL_STATE_KINDS } from '@agent-runtime/contracts';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ApiClient } from '../api/client.ts';
import { RequestIdentity } from '../api/requests.ts';
import { type Connection, type EventSourceLike, RunSync } from '../state/sync.ts';
import type { TimelineView } from '../state/timeline.ts';
import { RunCapabilitiesPanel } from './Capabilities.tsx';
import { budgetSummary, budgetUsage, FAILURE_LABELS, formatTime, providerLabel, STATE_DESCRIPTIONS } from './format.ts';
import { Conversation } from './History.tsx';
import { QuestionForm } from './QuestionForm.tsx';
import { ArrowDownIcon, button, ChevronIcon, code, cx, hint, muted, notice, Status, summaryLine } from './ui.tsx';

const CONNECTION_LABELS: Record<Connection, string> = {
  loading: 'Loading…',
  live: 'Live',
  reconnecting: 'Reconnecting… (the session is not affected)',
  complete: 'All history loaded',
  not_found: 'Not found',
};

export function RunDetail({
  client,
  runId,
  openEventSource,
}: {
  client: ApiClient;
  runId: string;
  openEventSource?: (url: string) => EventSourceLike;
}) {
  const [view, setView] = useState<TimelineView | undefined>();
  const [connection, setConnection] = useState<Connection>('loading');
  const sync = useRef<RunSync | undefined>(undefined);
  const capabilities = useRunCapabilities(client, runId, view);

  useEffect(() => {
    const created = new RunSync({
      client,
      runId,
      ...(openEventSource === undefined ? {} : { openEventSource }),
      onChange: (timeline, next) => {
        setConnection(next);
        setView(timeline?.view());
      },
    });
    sync.current = created;
    created.start();
    return () => created.stop();
  }, [client, runId, openEventSource]);

  if (connection === 'not_found') {
    return (
      <main className="mx-auto max-w-3xl space-y-3 px-4 py-10">
        <p className={notice('error')}>There is no session with this identity.</p>
        <a href="#/" className={button.link}>
          Start a new session
        </a>
      </main>
    );
  }
  if (view === undefined) {
    return <main className={cx('mx-auto max-w-3xl px-4 py-10 text-sm', muted)}>Loading the session…</main>;
  }
  return (
    <RunPage
      client={client}
      view={view}
      connection={connection}
      refresh={() => sync.current?.refresh()}
      capabilities={capabilities}
    />
  );
}

/** Events after which a run's capability view can differ: its use of tools, skills and delegates. */
const CAPABILITY_EVENTS = new Set(['tool.operation', 'delegation.started', 'delegation.finished']);

/**
 * A run's retained capabilities, read when the page opens and again after recorded capability activity. At most one
 * read is in flight; activity during it causes one more read afterwards.
 */
function useRunCapabilities(client: ApiClient, runId: string, view: TimelineView | undefined) {
  const [capabilities, setCapabilities] = useState<RunCapabilitiesView | undefined>();
  const activity = view?.events.filter((event) => CAPABILITY_EVENTS.has(event.kind)).length ?? 0;
  const current = useRef({ client, runId, mounted: true });
  current.current = { ...current.current, client, runId };
  const reading = useRef(false);
  const again = useRef(false);
  useEffect(() => {
    current.current.mounted = true;
    return () => {
      current.current.mounted = false;
    };
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `activity` only triggers another read.
  useEffect(() => {
    const read = async () => {
      if (reading.current) {
        again.current = true;
        return;
      }
      reading.current = true;
      do {
        again.current = false;
        const target = current.current;
        const outcome = await target.client.runCapabilities(target.runId);
        if (current.current.mounted && current.current.runId === target.runId && outcome.ok) {
          setCapabilities(outcome.value);
        }
      } while (again.current && current.current.mounted);
      reading.current = false;
    };
    void read();
  }, [client, runId, activity]);
  return capabilities;
}

export function RunPage({
  client,
  view,
  connection,
  refresh,
  capabilities,
}: {
  client: ApiClient;
  view: TimelineView;
  connection: Connection;
  refresh: () => void;
  capabilities?: RunCapabilitiesView;
}) {
  const { run } = view;
  const state = run.state;
  const scroller = useRef<HTMLDivElement>(null);
  const [atEnd, setAtEnd] = useState(true);
  const pending = state.kind === 'waiting' ? run.pendingQuestion : undefined;

  const measure = useCallback(() => {
    const element = scroller.current;
    if (element !== null) setAtEnd(element.scrollHeight - element.scrollTop - element.clientHeight < 80);
  }, []);
  // New activity never scrolls the page; it only offers the jump when it arrives out of view.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-measured whenever the conversation grows.
  useEffect(measure, [measure, view.events.length]);

  return (
    <main className="session flex h-full flex-col">
      <header className="session-head shrink-0 border-b border-zinc-200 px-4 py-3 md:px-6 dark:border-zinc-800">
        <div className="mx-auto flex max-w-3xl items-start gap-3">
          <div className="min-w-0 flex-1">
            <h1 className="session-title truncate text-base font-semibold" title={run.goal}>
              {run.goal}
            </h1>
            <p className="summary mt-0.5 flex flex-wrap items-center gap-x-1.5 text-sm">
              <Status kind={state.kind} />
              <span className={muted}>
                · {providerLabel(run.provider)} · {run.model} · {budgetSummary(run.budget)}
              </span>
            </p>
          </div>
          <span
            className={cx(`connection connection-${connection} mt-1 shrink-0 text-xs`, CONNECTION_TONE[connection])}
          >
            {CONNECTION_LABELS[connection]}
          </span>
          <CancelButton client={client} run={run} onSettled={refresh} />
        </div>
      </header>
      <div className="relative min-h-0 flex-1">
        <div ref={scroller} onScroll={measure} className="conversation-scroller h-full overflow-y-auto">
          <div className="mx-auto max-w-3xl space-y-6 px-4 py-6 md:px-6">
            <div className="space-y-3">
              {state.kind !== 'succeeded' && <p className={cx('text-sm', muted)}>{STATE_DESCRIPTIONS[state.kind]}</p>}
              <Outcome run={run} />
              <details className="disclosure details group">
                <summary className={summaryLine}>
                  <ChevronIcon />
                  Details
                </summary>
                <dl className="facts mt-3 grid grid-cols-1 gap-x-4 gap-y-1 text-sm sm:grid-cols-[max-content_1fr] sm:gap-y-1.5">
                  <dt className={muted}>Model</dt>
                  <dd className="mb-1.5 sm:mb-0">
                    {providerLabel(run.provider)} · {run.model} (subscription)
                  </dd>
                  <dt className={muted}>Model requests</dt>
                  <dd className="mb-1.5 sm:mb-0">
                    {budgetUsage(run.budget)}
                    <span className={hint}>
                      {' '}
                      This session’s own limit, shared with any delegated agents. Each model response counts; tool calls
                      and tokens do not.
                    </span>
                  </dd>
                  <dt className={muted}>Workspace</dt>
                  <dd className="mb-1.5 break-all sm:mb-0">
                    {run.workspace.label} <code className={code}>{run.workspace.root}</code>
                  </dd>
                  <dt className={muted}>Started</dt>
                  <dd className="mb-1.5 sm:mb-0" title={run.createdAt}>
                    {formatTime(run.createdAt)}
                  </dd>
                  <dt className={muted}>Last activity</dt>
                  <dd className="mb-1.5 sm:mb-0" title={run.lastActivityAt}>
                    {formatTime(run.lastActivityAt)}
                  </dd>
                  <dt className={muted}>Session</dt>
                  <dd className="break-all">
                    <code className={code}>{run.runId}</code>
                  </dd>
                </dl>
              </details>
              <RunCapabilitiesPanel capabilities={capabilities} />
            </div>
            <section aria-labelledby="conversation-heading">
              <h2 id="conversation-heading" className="sr-only">
                Conversation
              </h2>
              <Conversation
                goal={run.goal}
                startedAt={run.createdAt}
                events={view.events}
                state={state}
                capabilities={capabilities}
                pendingQuestionId={pending?.questionId}
              />
            </section>
          </div>
        </div>
        <button
          type="button"
          className={cx(
            button.secondary,
            'absolute right-4 bottom-4 rounded-full shadow-md',
            atEnd && 'pointer-events-none invisible opacity-0',
          )}
          onClick={() => jumpToLatest(scroller.current)}
        >
          <ArrowDownIcon />
          Jump to latest
        </button>
      </div>
      {pending !== undefined && (
        <div className="shrink-0 border-t border-zinc-200 bg-zinc-50/80 px-4 py-3 md:px-6 dark:border-zinc-800 dark:bg-zinc-900/60">
          <div className="mx-auto max-h-[60dvh] max-w-3xl overflow-y-auto">
            <QuestionForm
              key={pending.questionId}
              client={client}
              runId={run.runId}
              question={pending}
              onSettled={refresh}
            />
          </div>
        </div>
      )}
    </main>
  );
}

const CONNECTION_TONE: Record<Connection, string> = {
  loading: muted,
  live: 'text-emerald-700 dark:text-emerald-400',
  reconnecting: 'text-amber-700 dark:text-amber-400',
  complete: muted,
  not_found: muted,
};

/** Moves to the newest entry only when the owner asks: new activity never scrolls the page or takes focus. */
function jumpToLatest(scroller: HTMLElement | null) {
  const latest = scroller?.querySelector<HTMLElement>('.conversation > li:last-child');
  if (scroller === null || latest === null || latest === undefined) return;
  scroller.scrollTo({ top: scroller.scrollHeight });
  latest.tabIndex = -1;
  latest.focus({ preventScroll: true });
}

function Outcome({ run }: { run: RunView }) {
  const state = run.state;
  if (state.kind === 'failed') {
    const { failure } = state;
    return (
      <div className={cx('outcome failed space-y-1', notice('error'))} role="alert">
        <p>
          <strong className="font-semibold">Failed — {FAILURE_LABELS[failure.category]}</strong> (
          {failure.reason.replaceAll('_', ' ')})
        </p>
        <p className="whitespace-pre-wrap">{failure.message}</p>
        {failure.remediation !== undefined && <p className="whitespace-pre-wrap">{failure.remediation}</p>}
        {failure.retryAfterSeconds !== undefined && (
          <p>The provider asked to wait about {Math.ceil(failure.retryAfterSeconds / 60)} minutes.</p>
        )}
        <p className="text-xs opacity-80">Finished {formatTime(state.finishedAt)}</p>
      </div>
    );
  }
  if (state.kind === 'interrupted') {
    return (
      <p className={cx('outcome interrupted', notice('error'))}>
        Interrupted {formatTime(state.detectedAt)}; last recorded activity {formatTime(state.lastActivityAt)}.
      </p>
    );
  }
  if (state.kind === 'cancelled' || state.kind === 'cancelling') {
    return <p className={cx('outcome text-sm', muted)}>Stop requested {formatTime(state.acceptedAt)}.</p>;
  }
  return null;
}

function CancelButton({ client, run, onSettled }: { client: ApiClient; run: RunView; onSettled: () => void }) {
  const identity = useRef(new RequestIdentity<string>());
  const [busy, setBusy] = useState(false);
  const [message, setNotice] = useState<{ tone: 'error' | 'uncertain'; text: string } | undefined>();
  if (TERMINAL_STATE_KINDS.has(run.state.kind) || run.state.kind === 'cancelling') return null;

  const cancel = async () => {
    setBusy(true);
    setNotice(undefined);
    const outcome = await client.cancel(run.runId, identity.current.idFor(run.runId));
    const settlement = identity.current.settle(outcome);
    setBusy(false);
    if (outcome.ok) return onSettled();
    if (settlement === 'unknown') {
      return setNotice({
        tone: 'uncertain',
        text: 'The stop may have been recorded, but no reply arrived. Stopping again is safe.',
      });
    }
    if (outcome.kind === 'refused') {
      setNotice({ tone: 'error', text: outcome.error.message });
      onSettled();
    }
  };

  return (
    <div className="cancel flex shrink-0 flex-col items-end gap-1">
      <button
        type="button"
        className={cx(button.danger, 'h-8 px-3')}
        disabled={busy}
        aria-describedby="stop-help"
        onClick={() => void cancel()}
      >
        {busy ? 'Stopping…' : 'Stop session'}
      </button>
      <span id="stop-help" className="sr-only">
        Stops further agent work. Work already sent to the provider may still finish.
      </span>
      {message !== undefined && <p className={cx(notice(message.tone), 'max-w-xs')}>{message.text}</p>}
    </div>
  );
}
