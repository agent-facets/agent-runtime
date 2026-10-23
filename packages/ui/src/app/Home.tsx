// The run list and the form that starts a run.
import type { ContributionView, Options, Provider, RunSummary } from '@agent-runtime/contracts';
import { type FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import type { ApiClient, StartBody } from '../api/client.ts';
import { RequestIdentity } from '../api/requests.ts';
import { type Catalog, InstalledCapabilities, originsLabel, useCatalog } from './Capabilities.tsx';
import { ConnectAnthropic, ConnectOpenAI } from './Connect.tsx';
import { formatTime, providerLabel, STATE_LABELS } from './format.ts';
import { runHref } from './route.ts';

const LIST_REFRESH_MS = 5_000;

export function Home({ client }: { client: ApiClient }) {
  const catalog = useCatalog(client);
  return (
    <main>
      <StartForm client={client} catalog={catalog} />
      <InstalledCapabilities client={client} catalog={catalog} />
      <RunList client={client} />
    </main>
  );
}

type Notice = { tone: 'error' | 'uncertain'; text: string } | undefined;
type Mode = 'goal' | 'command';
type StartContent =
  | { provider: Provider; goal: string }
  | { provider: Provider; command: { id: string; selectionRevision: string; arguments: string } };

export function StartForm({ client, catalog }: { client: ApiClient; catalog: Catalog }) {
  const [options, setOptions] = useState<Options | undefined>();
  const [optionsError, setOptionsError] = useState(false);
  const [mode, setMode] = useState<Mode>('goal');
  const [goal, setGoal] = useState('');
  const [commandId, setCommandId] = useState('');
  const [args, setArgs] = useState('');
  const [provider, setProvider] = useState<Provider | undefined>();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>();
  // A start whose acknowledgement was lost: retried exactly as sent, whatever has been refreshed or edited since.
  const [unsettled, setUnsettled] = useState<StartBody | undefined>();
  const identity = useRef(new RequestIdentity<StartContent>());

  const live = useRef(true);
  const loadOptions = useCallback(async () => {
    const outcome = await client.options();
    if (!live.current) return;
    if (outcome.ok) {
      setOptionsError(false);
      setOptions(outcome.value);
      setProvider((current) => current ?? outcome.value.defaultProvider);
    } else setOptionsError(true);
  }, [client]);

  useEffect(() => {
    live.current = true;
    void loadOptions();
    return () => {
      live.current = false;
    };
  }, [loadOptions]);

  const ready =
    catalog.state.kind === 'loaded' && catalog.state.catalog.kind === 'ready' ? catalog.state.catalog : undefined;
  const commands = ready?.contributions.filter((entry) => entry.kind === 'command') ?? [];
  const command = commands.find((entry) => entry.id === commandId);
  const revision = command?.availability.kind === 'ready' ? command.availability.selectionRevision : undefined;

  const send = async (body: StartBody) => {
    setBusy(true);
    setNotice(undefined);
    const outcome = await client.startRun(body);
    const settlement = identity.current.settle(outcome);
    setBusy(false);
    if (settlement === 'definite') setUnsettled(undefined);
    if (outcome.ok) {
      setGoal('');
      setArgs('');
      window.location.hash = runHref(outcome.value.run.runId);
      return;
    }
    if (settlement === 'unknown') {
      setUnsettled(body);
      setNotice({
        tone: 'uncertain',
        text: 'The start may have been recorded, but no reply arrived. Submitting again is safe: it cannot start a second run.',
      });
    } else if (outcome.kind === 'refused') {
      // A refused command is never turned into a goal run; a changed selection needs a fresh look first.
      setNotice({ tone: 'error', text: outcome.error.message });
      if (outcome.error.code === 'capability_selection_changed') void catalog.load();
    }
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (provider === undefined || busy) return;
    let content: StartContent;
    if (mode === 'goal') content = { provider, goal };
    else {
      if (command === undefined || revision === undefined) return;
      content = { provider, command: { id: command.id, selectionRevision: revision, arguments: args } };
    }
    await send({ requestId: identity.current.idFor(content), ...content } as StartBody);
  };

  const commandReady =
    command !== undefined && revision !== undefined && (command.arguments?.required !== true || /\S/.test(args));
  const canStart = provider !== undefined && !busy && (mode === 'goal' ? /\S/.test(goal) : commandReady);
  const selected = options?.providers.find((entry) => entry.provider === provider);
  return (
    <section className="panel">
      <h1>Start a task</h1>
      {optionsError && <p className="notice error">The runtime’s options could not be loaded.</p>}
      {options !== undefined && !options.workspace.available && (
        <p className="notice error">The workspace “{options.workspace.label}” is not available.</p>
      )}
      <form onSubmit={submit}>
        <fieldset className="mode">
          <legend>Start from</legend>
          <label className="choice">
            <input type="radio" name="mode" checked={mode === 'goal'} onChange={() => setMode('goal')} />
            Free-form task
          </label>
          <label className="choice">
            <input
              type="radio"
              name="mode"
              checked={mode === 'command'}
              onChange={() => {
                setMode('command');
                if (catalog.state.kind === 'idle') void catalog.load();
              }}
            />
            Installed command
          </label>
        </fieldset>
        {mode === 'goal' ? (
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
        ) : (
          <CommandFields
            catalog={catalog}
            commands={commands}
            command={command}
            commandId={commandId}
            setCommandId={setCommandId}
            args={args}
            setArgs={setArgs}
          />
        )}
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
          <button type="submit" disabled={!canStart}>
            {busy ? 'Starting…' : identity.current.pending ? 'Submit again' : 'Start'}
          </button>
        </div>
        {selected !== undefined && selected.readiness !== 'ready' && (
          <p className="notice error">
            {providerLabel(selected.provider)} is not ready ({selected.readiness.replaceAll('_', ' ')}).
            {selected.readiness === 'reauthorization_required' && ' Connect it below.'}
          </p>
        )}
        {notice !== undefined && <p className={`notice ${notice.tone}`}>{notice.text}</p>}
        {unsettled !== undefined && (
          <p>
            <button type="button" className="secondary" disabled={busy} onClick={() => void send(unsettled)}>
              Retry same start
            </button>{' '}
            <span className="hint">Sends exactly what was submitted, with the same request identity.</span>
          </p>
        )}
      </form>
      {/* Its own form, outside the task form: the code is never part of a task. */}
      {selected !== undefined &&
        (selected.readiness === 'ready' || selected.readiness === 'reauthorization_required') &&
        (selected.provider === 'anthropic' ? (
          <ConnectAnthropic client={client} readiness={selected.readiness} onConnected={() => void loadOptions()} />
        ) : (
          <ConnectOpenAI client={client} readiness={selected.readiness} onConnected={() => void loadOptions()} />
        ))}
    </section>
  );
}

function CommandFields(props: {
  catalog: Catalog;
  commands: ContributionView[];
  command: ContributionView | undefined;
  commandId: string;
  setCommandId: (id: string) => void;
  args: string;
  setArgs: (args: string) => void;
}) {
  const { catalog, commands, command } = props;
  const { state } = catalog;
  const refresh = (
    <button type="button" className="secondary" onClick={() => void catalog.load()}>
      Refresh commands
    </button>
  );
  if (state.kind === 'idle' || state.kind === 'loading') return <p className="hint">Loading installed commands…</p>;
  if (state.kind === 'error') {
    return <p className="notice error">The installed commands could not be loaded. {refresh}</p>;
  }
  if (state.catalog.kind === 'unconfigured') {
    return (
      <p className="notice">No runtime facets are configured for this deployment. Start a free-form task instead.</p>
    );
  }
  if (state.catalog.kind === 'unavailable') {
    return (
      <p className="notice error">
        The installed commands cannot be read ({state.catalog.reason.replaceAll('_', ' ')}). Start a free-form task, or{' '}
        {refresh}
      </p>
    );
  }
  return (
    <>
      <div className="row">
        <label>
          Command
          <select name="command" value={props.commandId} onChange={(event) => props.setCommandId(event.target.value)}>
            <option value="">Choose a command…</option>
            {commands.map((entry) => (
              <option key={entry.id} value={entry.id} disabled={entry.availability.kind !== 'ready'}>
                {entry.name}
                {entry.availability.kind === 'ready'
                  ? ''
                  : ` (unavailable: ${entry.availability.reason.replaceAll('_', ' ')})`}
              </option>
            ))}
          </select>
        </label>
        {refresh}
      </div>
      {commands.length === 0 && <p className="hint">No commands are installed.</p>}
      {command !== undefined && (
        <>
          <p className="hint">
            {command.name} · {originsLabel(command.origins)}
          </p>
          {command.description !== undefined && <p className="text">{command.description}</p>}
          <label>
            Arguments {command.arguments?.required === true ? '(required)' : '(optional)'}
            <textarea
              name="arguments"
              value={props.args}
              rows={3}
              onChange={(event) => props.setArgs(event.target.value)}
            />
          </label>
        </>
      )}
    </>
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
        <div className="table-scroll">
          <table className="runs">
            <thead>
              <tr>
                <th>Goal</th>
                <th className="wide-only">Provider</th>
                <th>Status</th>
                <th className="wide-only">Started</th>
                <th>Last activity</th>
                <th className="wide-only">Run</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => (
                <tr key={run.runId}>
                  <td className="goal">
                    <a href={runHref(run.runId)}>{run.goal}</a>
                  </td>
                  <td className="wide-only">
                    {providerLabel(run.provider)} · {run.model}
                  </td>
                  <td>
                    <span className={`status status-${run.status}`}>{STATE_LABELS[run.status]}</span>
                  </td>
                  <td className="wide-only" title={run.createdAt}>
                    {formatTime(run.createdAt)}
                  </td>
                  <td title={run.lastActivityAt}>{formatTime(run.lastActivityAt)}</td>
                  <td className="id wide-only" title={run.runId}>
                    {run.runId.slice(0, 8)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {next !== undefined && (
        <button type="button" className="secondary" onClick={() => void more()}>
          Load older runs
        </button>
      )}
    </section>
  );
}
