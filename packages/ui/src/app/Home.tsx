// The run list and the form that starts a run.
import type { Options, Provider, RunSummary } from '@agent-runtime/contracts';
import { type FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import type { ApiClient } from '../api/client.ts';
import { RequestIdentity } from '../api/requests.ts';
import { formatTime, providerLabel, STATE_LABELS } from './format.ts';
import { runHref } from './route.ts';

const LIST_REFRESH_MS = 5_000;

export function Home({ client }: { client: ApiClient }) {
  return (
    <main>
      <StartForm client={client} />
      <RunList client={client} />
    </main>
  );
}

type Notice = { tone: 'error' | 'uncertain'; text: string } | undefined;

export function StartForm({ client }: { client: ApiClient }) {
  const [options, setOptions] = useState<Options | undefined>();
  const [optionsError, setOptionsError] = useState(false);
  const [goal, setGoal] = useState('');
  const [provider, setProvider] = useState<Provider | undefined>();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>();
  const identity = useRef(new RequestIdentity<{ goal: string; provider: Provider }>());

  useEffect(() => {
    let live = true;
    void client.options().then((outcome) => {
      if (!live) return;
      if (outcome.ok) {
        setOptions(outcome.value);
        setProvider((current) => current ?? outcome.value.defaultProvider);
      } else setOptionsError(true);
    });
    return () => {
      live = false;
    };
  }, [client]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (provider === undefined || busy) return;
    const content = { goal, provider };
    setBusy(true);
    setNotice(undefined);
    const outcome = await client.startRun({ requestId: identity.current.idFor(content), ...content });
    const settlement = identity.current.settle(outcome);
    setBusy(false);
    if (outcome.ok) {
      setGoal('');
      window.location.hash = runHref(outcome.value.run.runId);
      return;
    }
    if (settlement === 'unknown') {
      setNotice({
        tone: 'uncertain',
        text: 'The start may have been recorded, but no reply arrived. Submitting again is safe: it cannot start a second run.',
      });
    } else if (outcome.kind === 'refused') {
      setNotice({ tone: 'error', text: outcome.error.message });
    }
  };

  const selected = options?.providers.find((entry) => entry.provider === provider);
  return (
    <section className="panel">
      <h1>Start a task</h1>
      {optionsError && <p className="notice error">The runtime’s options could not be loaded.</p>}
      {options !== undefined && !options.workspace.available && (
        <p className="notice error">The workspace “{options.workspace.label}” is not available.</p>
      )}
      <form onSubmit={submit}>
        <label>
          Goal
          <textarea
            name="goal"
            value={goal}
            rows={4}
            required
            onChange={(event) => {
              setGoal(event.target.value);
            }}
          />
        </label>
        <div className="row">
          <label>
            Provider
            <select
              name="provider"
              value={provider ?? ''}
              onChange={(event) => setProvider(event.target.value as Provider)}
            >
              {options?.providers.map((entry) => (
                <option key={entry.provider} value={entry.provider}>
                  {providerLabel(entry.provider)} · {entry.model}
                  {entry.readiness === 'ready' ? '' : ` (${entry.readiness.replaceAll('_', ' ')})`}
                </option>
              ))}
            </select>
          </label>
          {options !== undefined && (
            <span className="hint">
              Workspace: {options.workspace.label} · Step budget: {options.defaultBudget}
              {options.modelRequestCeiling !== undefined &&
                ` · Deployment limit: ${options.modelRequestCeiling} model requests`}
            </span>
          )}
          <button type="submit" disabled={busy || provider === undefined || !/\S/.test(goal)}>
            {busy ? 'Starting…' : identity.current.pending ? 'Submit again' : 'Start'}
          </button>
        </div>
        {selected !== undefined && selected.readiness !== 'ready' && (
          <p className="notice error">
            {providerLabel(selected.provider)} is not ready ({selected.readiness.replaceAll('_', ' ')}).
          </p>
        )}
        {notice !== undefined && <p className={`notice ${notice.tone}`}>{notice.text}</p>}
      </form>
    </section>
  );
}

export function RunList({ client }: { client: ApiClient }) {
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
    <section className="panel">
      <h2>Runs</h2>
      {unavailable && <p className="notice uncertain">The run list cannot be refreshed right now.</p>}
      {runs !== undefined && runs.length === 0 && <p className="hint">No runs yet.</p>}
      {runs !== undefined && runs.length > 0 && (
        <table className="runs">
          <thead>
            <tr>
              <th>Goal</th>
              <th>Provider</th>
              <th>Status</th>
              <th>Started</th>
              <th>Last activity</th>
              <th>Run</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((run) => (
              <tr key={run.runId}>
                <td className="goal">
                  <a href={runHref(run.runId)}>{run.goal}</a>
                </td>
                <td>
                  {providerLabel(run.provider)} · {run.model}
                </td>
                <td>
                  <span className={`status status-${run.status}`}>{STATE_LABELS[run.status]}</span>
                </td>
                <td title={run.createdAt}>{formatTime(run.createdAt)}</td>
                <td title={run.lastActivityAt}>{formatTime(run.lastActivityAt)}</td>
                <td className="id" title={run.runId}>
                  {run.runId.slice(0, 8)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {next !== undefined && (
        <button type="button" className="secondary" onClick={() => void more()}>
          Load older runs
        </button>
      )}
    </section>
  );
}
