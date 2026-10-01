// One run: identity, state, budget, failure explanation, the pending question, cancellation and history. The
// view follows the run's committed history; whether this page is connected is shown separately and never
// changes what the run is shown to be doing.
import type { RunView } from '@agent-runtime/contracts';
import { TERMINAL_STATE_KINDS } from '@agent-runtime/contracts';
import { useEffect, useRef, useState } from 'react';
import type { ApiClient } from '../api/client.ts';
import { RequestIdentity } from '../api/requests.ts';
import { type Connection, type EventSourceLike, RunSync } from '../state/sync.ts';
import type { TimelineView } from '../state/timeline.ts';
import { FAILURE_LABELS, formatTime, providerLabel, STATE_DESCRIPTIONS, STATE_LABELS } from './format.ts';
import { History } from './History.tsx';
import { QuestionForm } from './QuestionForm.tsx';

const CONNECTION_LABELS: Record<Connection, string> = {
  loading: 'Loading…',
  live: 'Live',
  reconnecting: 'Reconnecting… (the run is not affected)',
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
        <p className="notice error">There is no run with this identity.</p>
        <a href="#/">All runs</a>
      </main>
    );
  }
  if (view === undefined) return <main className="hint">Loading the run…</main>;
  return <RunPage client={client} view={view} connection={connection} refresh={() => sync.current?.refresh()} />;
}

export function RunPage({
  client,
  view,
  connection,
  refresh,
}: {
  client: ApiClient;
  view: TimelineView;
  connection: Connection;
  refresh: () => void;
}) {
  const { run } = view;
  const state = run.state;
  return (
    <main>
      <p>
        <a href="#/">All runs</a>
      </p>
      <section className="panel">
        <div className="title-row">
          <h1 className="goal text">{run.goal}</h1>
          <span className={`connection connection-${connection}`}>{CONNECTION_LABELS[connection]}</span>
        </div>
        <dl className="facts">
          <dt>Status</dt>
          <dd>
            <span className={`status status-${state.kind}`}>{STATE_LABELS[state.kind]}</span>
            <span className="hint"> {STATE_DESCRIPTIONS[state.kind]}</span>
          </dd>
          <dt>Provider</dt>
          <dd>
            {providerLabel(run.provider)} · {run.model} (subscription)
          </dd>
          <dt>Workspace</dt>
          <dd>
            {run.workspace.label} <code>{run.workspace.root}</code>
          </dd>
          <dt>Model requests</dt>
          <dd>
            {run.budget.consumed} of {run.budget.maximum} used
            {run.budget.unconfirmed > 0 && `, plus ${run.budget.unconfirmed} unconfirmed (counted against the budget)`}
          </dd>
          <dt>Started</dt>
          <dd title={run.createdAt}>{formatTime(run.createdAt)}</dd>
          <dt>Last activity</dt>
          <dd title={run.lastActivityAt}>{formatTime(run.lastActivityAt)}</dd>
          <dt>Run</dt>
          <dd>
            <code>{run.runId}</code>
          </dd>
        </dl>
        <Outcome run={run} />
        <CancelButton client={client} run={run} onSettled={refresh} />
      </section>
      {state.kind === 'waiting' && run.pendingQuestion !== undefined && (
        <QuestionForm
          key={run.pendingQuestion.questionId}
          client={client}
          runId={run.runId}
          question={run.pendingQuestion}
          onSettled={refresh}
        />
      )}
      <section className="panel">
        <h2>History</h2>
        <History events={view.events} state={state} />
      </section>
    </main>
  );
}

function Outcome({ run }: { run: RunView }) {
  const state = run.state;
  if (state.kind === 'failed') {
    const { failure } = state;
    return (
      <div className="outcome failed" role="alert">
        <p>
          <strong>Failed — {FAILURE_LABELS[failure.category]}</strong> ({failure.reason.replaceAll('_', ' ')})
        </p>
        <p className="text">{failure.message}</p>
        {failure.remediation !== undefined && <p className="text">{failure.remediation}</p>}
        {failure.retryAfterSeconds !== undefined && (
          <p>The provider asked to wait about {Math.ceil(failure.retryAfterSeconds / 60)} minutes.</p>
        )}
        <p className="hint">Finished {formatTime(state.finishedAt)}</p>
      </div>
    );
  }
  if (state.kind === 'interrupted') {
    return (
      <div className="outcome interrupted">
        <p>
          Interrupted {formatTime(state.detectedAt)}; last recorded activity {formatTime(state.lastActivityAt)}.
        </p>
      </div>
    );
  }
  if (state.kind === 'cancelled' || state.kind === 'cancelling') {
    return <p className="outcome">Cancellation accepted {formatTime(state.acceptedAt)}.</p>;
  }
  if (state.kind === 'succeeded') {
    return (
      <p className="outcome succeeded">
        Completed {formatTime(state.finishedAt)}. The result is marked in the history.
      </p>
    );
  }
  return null;
}

function CancelButton({ client, run, onSettled }: { client: ApiClient; run: RunView; onSettled: () => void }) {
  const identity = useRef(new RequestIdentity<string>());
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'error' | 'uncertain'; text: string } | undefined>();
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
        text: 'The cancellation may have been recorded, but no reply arrived. Cancelling again is safe.',
      });
    }
    if (outcome.kind === 'refused') {
      setNotice({ tone: 'error', text: outcome.error.message });
      onSettled();
    }
  };

  return (
    <div className="cancel">
      <button type="button" className="danger" disabled={busy} onClick={() => void cancel()}>
        {busy ? 'Cancelling…' : 'Cancel run'}
      </button>
      <span className="hint"> Stops further agent work. Work already sent to the provider may still finish.</span>
      {notice !== undefined && <p className={`notice ${notice.tone}`}>{notice.text}</p>}
    </div>
  );
}
