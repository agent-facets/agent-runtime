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
import { MenuButton } from './menu.tsx';
import { QuestionForm } from './QuestionForm.tsx';
import {
  ArrowDownIcon,
  button,
  ChevronIcon,
  code,
  column,
  composer,
  cx,
  Fact,
  Facts,
  floatingButton,
  hint,
  muted,
  Notice,
  notice,
  Status,
  smallButton,
  summaryLine,
} from './ui.tsx';

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
      <main>
        <BareBar />
        <div className={cx(column, 'space-y-3 py-10')}>
          <p className={notice('error')}>There is no session with this identity.</p>
          <a href="#/" className={button.link}>
            Start a new session
          </a>
        </div>
      </main>
    );
  }
  if (view === undefined) {
    return (
      <main>
        <BareBar />
        <p className={cx(column, 'py-10 text-sm', muted)}>Loading the session…</p>
      </main>
    );
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

/** The top bar before a session is known: only the way to the other sessions, on a narrow screen. */
function BareBar() {
  return (
    <div className="flex h-12 items-center border-b border-zinc-100 px-2 md:hidden dark:border-zinc-800/60">
      <MenuButton />
    </div>
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
  const page = useRef<HTMLElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const [atEnd, setAtEnd] = useState(true);
  const pending = state.kind === 'waiting' ? run.pendingQuestion : undefined;

  const measure = useCallback(() => {
    const element = activeScroller(page.current, scroller.current);
    if (element !== null) setAtEnd(element.scrollHeight - element.scrollTop - element.clientHeight < 80);
  }, []);
  // New activity never scrolls the page; it only offers the jump when it arrives out of view.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-measured whenever the conversation grows.
  useEffect(measure, [measure, view.events.length]);
  // Anything else that changes what is in view does too: the window, an opened disclosure, the answer form.
  useEffect(() => {
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    for (const element of [page.current, scroller.current, scroller.current?.firstElementChild]) {
      if (element instanceof Element) observer.observe(element);
    }
    return () => observer.disconnect();
  }, [measure]);

  return (
    // On a short screen the page scrolls as one, and the answer form follows the conversation instead of covering it.
    <main ref={page} onScroll={measure} className="session flex h-full flex-col short:block short:overflow-y-auto">
      <header className="session-head shrink-0 border-b border-zinc-100 dark:border-zinc-800/60">
        <div className={cx(column, 'flex items-center gap-3 py-2.5 max-md:pl-2')}>
          <MenuButton />
          <div className="min-w-0 flex-1">
            <h1 className="session-title truncate text-sm font-semibold" title={run.goal}>
              {run.goal}
            </h1>
            <p className="summary flex items-center gap-x-1.5 text-xs">
              <Status kind={state.kind} className="shrink-0" />
              <span className={cx('min-w-0 truncate', muted)}>
                · {providerLabel(run.provider)} · {run.model} · {budgetSummary(run.budget)}
              </span>
            </p>
          </div>
          <CancelButton client={client} run={run} onSettled={refresh} />
        </div>
      </header>
      <div className="relative min-h-0 flex-1">
        <div
          ref={scroller}
          onScroll={measure}
          className="conversation-scroller h-full overflow-y-auto short:h-auto short:overflow-visible"
        >
          <div className={cx(column, 'space-y-6 py-6')}>
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
                <span
                  role="status"
                  className={cx(
                    `connection connection-${connection} inline-flex items-center gap-1.5 text-xs`,
                    CONNECTION_TONE[connection],
                  )}
                >
                  <span aria-hidden="true" className={cx('size-1.5 rounded-full', CONNECTION_DOT[connection])} />
                  {CONNECTION_LABELS[connection]}
                </span>
                <details className="disclosure details group open:basis-full">
                  <summary className={summaryLine}>
                    <ChevronIcon />
                    Details
                  </summary>
                  <Facts className="mt-3">
                    <Fact label="Model">
                      {providerLabel(run.provider)} · {run.model} (subscription)
                    </Fact>
                    <Fact label="Model requests">
                      {budgetUsage(run.budget)}
                      <span className={hint}>
                        {' '}
                        This session’s own limit, shared with any delegated agents. Each model response counts; tool
                        calls and tokens do not.
                      </span>
                    </Fact>
                    <Fact label="Workspace">
                      {run.workspace.label} <code className={cx(code, 'break-all')}>{run.workspace.root}</code>
                    </Fact>
                    <Fact label="Started" title={run.createdAt}>
                      {formatTime(run.createdAt)}
                    </Fact>
                    <Fact label="Last activity" title={run.lastActivityAt}>
                      {formatTime(run.lastActivityAt)}
                    </Fact>
                    <Fact label="Session">
                      <code className={cx(code, 'break-all')}>{run.runId}</code>
                    </Fact>
                  </Facts>
                </details>
                <RunCapabilitiesPanel capabilities={capabilities} />
              </div>
              {/* A waiting question says so itself, where it is asked. */}
              {state.kind !== 'succeeded' && pending === undefined && (
                <p className={cx('text-sm', muted)}>{STATE_DESCRIPTIONS[state.kind]}</p>
              )}
              <Outcome run={run} />
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
                pendingQuestion={pending}
              />
            </section>
          </div>
        </div>
        <button
          type="button"
          className={cx(
            floatingButton,
            'absolute bottom-4 left-1/2 -translate-x-1/2 short:fixed',
            atEnd && 'pointer-events-none invisible opacity-0',
          )}
          onClick={() => jumpToLatest(activeScroller(page.current, scroller.current))}
        >
          <ArrowDownIcon />
          Jump to latest
        </button>
      </div>
      {pending !== undefined && (
        <div className={cx(column, 'answer-dock shrink-0 pb-4')}>
          <div
            className={cx(composer, 'max-h-[45dvh] overflow-y-auto px-4 py-3 short:max-h-none short:overflow-visible')}
          >
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
  live: muted,
  reconnecting: 'text-amber-700 dark:text-amber-400',
  complete: muted,
  not_found: muted,
};

const CONNECTION_DOT: Record<Connection, string> = {
  loading: 'bg-zinc-400',
  live: 'bg-emerald-500',
  reconnecting: 'bg-amber-500',
  complete: 'bg-zinc-400',
  not_found: 'bg-zinc-400',
};

/** Whichever element scrolls the conversation: its own scroller, or the whole page on a short screen. */
function activeScroller(page: HTMLElement | null, scroller: HTMLElement | null): HTMLElement | null {
  if (scroller !== null && getComputedStyle(scroller).overflowY !== 'visible') return scroller;
  return page;
}

/** Moves to the newest entry only when the owner asks: new activity never scrolls the page or takes focus. */
function jumpToLatest(scroller: HTMLElement | null) {
  const latest = scroller?.querySelector<HTMLElement>('.conversation > li:last-child');
  if (scroller === null || latest === null || latest === undefined) return;
  latest.scrollIntoView({ block: 'end' });
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
        className={smallButton.danger}
        disabled={busy}
        aria-describedby="stop-help"
        onClick={() => void cancel()}
      >
        {busy ? (
          'Stopping…'
        ) : (
          // One text run: the button's flex gap would otherwise separate the two words.
          <span>
            Stop<span className="max-sm:sr-only"> session</span>
          </span>
        )}
      </button>
      <span id="stop-help" className="sr-only">
        Stops further agent work. Work already sent to the provider may still finish.
      </span>
      {message !== undefined && (
        <Notice tone={message.tone} className="max-w-xs">
          {message.text}
        </Notice>
      )}
    </div>
  );
}
