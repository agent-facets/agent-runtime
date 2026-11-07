// The start page: one composer that starts a session from a message or an installed command. A session is shown to
// the owner as a conversation; the API still calls the recorded execution a run.
import type { ContributionView, Options, Provider } from '@agent-runtime/contracts';
import { STEP_BUDGET_MAX, STEP_BUDGET_MIN } from '@agent-runtime/contracts';
import { type FormEvent, type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import type { ApiClient, StartBody } from '../api/client.ts';
import { RequestIdentity } from '../api/requests.ts';
import { type Catalog, originsLabel, useCatalog } from './Capabilities.tsx';
import { ConnectAnthropic, ConnectOpenAI } from './Connect.tsx';
import { parseTaskBudget, providerLabel, TASK_BUDGET_GUIDANCE } from './format.ts';
import { runHref } from './route.ts';
import {
  ArrowUpIcon,
  button,
  column,
  composer,
  cx,
  Disclosure,
  field,
  label,
  meta,
  muted,
  Notice,
  notice,
  pageTitle,
} from './ui.tsx';

export function Home({ client }: { client: ApiClient }) {
  const catalog = useCatalog(client);
  return (
    <main className="flex h-full overflow-y-auto">
      <div className={cx(column, 'my-auto py-10')}>
        <StartForm client={client} catalog={catalog} />
      </div>
    </main>
  );
}

type StartNotice = { tone: 'error' | 'uncertain'; text: string } | undefined;
type Mode = 'goal' | 'command';
type StartContent =
  | { provider: Provider; goal: string; stepBudget: number }
  | { provider: Provider; command: { id: string; selectionRevision: string; arguments: string }; stepBudget: number };

export function StartForm({ client, catalog }: { client: ApiClient; catalog: Catalog }) {
  const [options, setOptions] = useState<Options | undefined>();
  const [optionsError, setOptionsError] = useState(false);
  const [mode, setMode] = useState<Mode>('goal');
  const [goal, setGoal] = useState('');
  const [commandId, setCommandId] = useState('');
  const [args, setArgs] = useState('');
  const [provider, setProvider] = useState<Provider | undefined>();
  // The session's model-request limit as typed; seeded once from the configured default, then the owner's to change.
  const [budgetText, setBudgetText] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [notice_, setNotice] = useState<StartNotice>();
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
      setBudgetText((current) => current ?? String(outcome.value.defaultBudget));
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
  const stepBudget = budgetText === undefined ? undefined : parseTaskBudget(budgetText);

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
        text: 'The start may have been recorded, but no reply arrived. Submitting again is safe: it cannot start a second session.',
      });
    } else if (outcome.kind === 'refused') {
      // A refused command is never turned into a message session; a changed selection needs a fresh look first.
      setNotice({ tone: 'error', text: outcome.error.message });
      if (outcome.error.code === 'capability_selection_changed') void catalog.load();
    }
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (provider === undefined || stepBudget === undefined || busy) return;
    let content: StartContent;
    if (mode === 'goal') content = { provider, goal, stepBudget };
    else {
      if (command === undefined || revision === undefined) return;
      content = { provider, command: { id: command.id, selectionRevision: revision, arguments: args }, stepBudget };
    }
    await send({ requestId: identity.current.idFor(content), ...content } as StartBody);
  };

  const commandReady =
    command !== undefined && revision !== undefined && (command.arguments?.required !== true || /\S/.test(args));
  const canStart =
    provider !== undefined && stepBudget !== undefined && !busy && (mode === 'goal' ? /\S/.test(goal) : commandReady);
  const selected = options?.providers.find((entry) => entry.provider === provider);
  const chooseMode = (next: Mode) => {
    setMode(next);
    if (next === 'command' && catalog.state.kind === 'idle') void catalog.load();
  };

  return (
    <section className="start">
      <h1 className={cx(pageTitle, 'mb-6 text-center')}>New session</h1>
      {(optionsError || (options !== undefined && !options.workspace.available)) && (
        <div className="mb-3 space-y-3">
          {optionsError && <Notice tone="error">The runtime’s options could not be loaded.</Notice>}
          {options !== undefined && !options.workspace.available && (
            <Notice tone="error">The workspace “{options.workspace.label}” is not available.</Notice>
          )}
        </div>
      )}
      <form onSubmit={submit} aria-label="Start a session" className={composer}>
        {mode === 'goal' ? (
          <label className="block">
            <span className="sr-only">Your message</span>
            <textarea
              name="goal"
              value={goal}
              rows={4}
              required
              placeholder="What should the agent do?"
              className="block max-h-[50dvh] min-h-28 w-full resize-y rounded-t-2xl border-0 bg-transparent px-4 pt-4 pb-2 text-base placeholder:text-zinc-400 focus:outline-none dark:placeholder:text-zinc-500"
              onChange={(event) => setGoal(event.target.value)}
              onKeyDown={(event) => {
                // Ctrl/Cmd+Enter starts the session; Enter alone adds a line.
                if (event.key === 'Enter' && (event.metaKey || event.ctrlKey))
                  event.currentTarget.form?.requestSubmit();
              }}
            />
          </label>
        ) : (
          <div className="space-y-3 px-4 pt-4 pb-2">
            <CommandFields
              catalog={catalog}
              commands={commands}
              command={command}
              commandId={commandId}
              setCommandId={setCommandId}
              args={args}
              setArgs={setArgs}
            />
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2 px-3 pt-1 pb-3">
          <fieldset className="mode inline-flex rounded-lg bg-zinc-100 p-0.5 dark:bg-zinc-800">
            <legend className="sr-only">Start from</legend>
            {(
              [
                ['goal', 'Message'],
                ['command', 'Installed command'],
              ] as const
            ).map(([value, text]) => (
              <label
                key={value}
                className={cx(
                  'cursor-pointer rounded-md px-2.5 py-1 text-xs font-medium pointer-coarse:py-2',
                  'has-focus-visible:outline-2 has-focus-visible:outline-blue-600',
                  mode === value
                    ? 'bg-white text-zinc-900 shadow-xs dark:bg-zinc-950 dark:text-zinc-100'
                    : 'text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100',
                )}
              >
                <input
                  type="radio"
                  name="mode"
                  className="sr-only"
                  checked={mode === value}
                  onChange={() => chooseMode(value)}
                />
                {text}
              </label>
            ))}
          </fieldset>
          {/* Named directly rather than by a wrapping label, whose text would include the selected option's. */}
          <span className="min-w-0">
            <select
              name="provider"
              aria-label="Model"
              value={provider ?? ''}
              disabled={options === undefined}
              className="h-8 max-w-[14rem] truncate rounded-md border-0 bg-transparent pr-7 pl-2 text-xs font-medium text-zinc-700 hover:bg-zinc-100 pointer-coarse:h-11 sm:max-w-xs dark:text-zinc-300 dark:hover:bg-zinc-800"
              onChange={(event) => setProvider(event.target.value as Provider)}
            >
              {options === undefined && <option value="">Loading models…</option>}
              {options?.providers.map((entry) => (
                <option key={entry.provider} value={entry.provider}>
                  {providerLabel(entry.provider)} · {entry.model}
                  {entry.readiness === 'ready' ? '' : ` (${entry.readiness.replaceAll('_', ' ')})`}
                </option>
              ))}
            </select>
          </span>
          <button type="submit" disabled={!canStart} className={cx(button.primary, 'ml-auto')}>
            {busy ? 'Starting…' : identity.current.pending ? 'Submit again' : 'Start session'}
            {!busy && <ArrowUpIcon />}
          </button>
        </div>
      </form>
      <div className="mt-4 space-y-3 px-1">
        {selected !== undefined && selected.readiness !== 'ready' && (
          <p className={notice('error')}>
            {providerLabel(selected.provider)} is not ready ({selected.readiness.replaceAll('_', ' ')}).
            {selected.readiness === 'reauthorization_required' && ' Connect it below.'}
          </p>
        )}
        {notice_ !== undefined && <Notice tone={notice_.tone}>{notice_.text}</Notice>}
        {unsettled !== undefined && (
          <p className="flex flex-wrap items-center gap-2 text-sm">
            <button type="button" className={button.secondary} disabled={busy} onClick={() => void send(unsettled)}>
              Retry same start
            </button>
            <span className={muted}>Sends exactly what was submitted, with the same request identity.</span>
          </p>
        )}
        <div className="flex flex-wrap items-start gap-x-6 gap-y-3">
          <SessionOptions budgetText={budgetText} setBudgetText={setBudgetText} />
          {/* Its own form, outside the session form: the code is never part of a message. */}
          {selected !== undefined &&
            (selected.readiness === 'ready' || selected.readiness === 'reauthorization_required') && (
              <ProviderConnection ready={selected.readiness === 'ready'}>
                {selected.provider === 'anthropic' ? (
                  <ConnectAnthropic
                    client={client}
                    readiness={selected.readiness}
                    onConnected={() => void loadOptions()}
                  />
                ) : (
                  <ConnectOpenAI
                    client={client}
                    readiness={selected.readiness}
                    onConnected={() => void loadOptions()}
                  />
                )}
              </ProviderConnection>
            )}
          {options !== undefined && (
            <span className={cx('text-sm sm:ml-auto', muted)}>Workspace: {options.workspace.label}</span>
          )}
        </div>
      </div>
    </section>
  );
}

/** Settings most sessions leave alone. An invalid limit keeps them open. */
export function SessionOptions({
  budgetText,
  setBudgetText,
}: {
  budgetText: string | undefined;
  setBudgetText: (text: string) => void;
}) {
  const limit = budgetText === undefined ? undefined : parseTaskBudget(budgetText);
  const invalid = budgetText !== undefined && limit === undefined;
  return (
    <Disclosure
      className="options open:basis-full"
      forced={invalid}
      summary={
        <>
          Options
          <span className={muted}>
            {' · '}
            {limit === undefined ? 'request limit needs a value' : `${limit.toLocaleString('en-US')}-request limit`}
          </span>
        </>
      }
    >
      <TaskBudgetField budgetText={budgetText} setBudgetText={setBudgetText} />
    </Disclosure>
  );
}

/** A healthy connection stays out of the way; one that needs a sign-in is shown open. */
export function ProviderConnection({ ready, children }: { ready: boolean; children: ReactNode }) {
  return (
    <Disclosure
      className="connection-settings open:basis-full"
      forced={!ready}
      summary={
        <>
          Connection
          <span className={ready ? muted : 'text-amber-700 dark:text-amber-400'}>
            {' · '}
            {ready ? 'Connected' : 'Sign-in needed'}
          </span>
        </>
      }
    >
      {children}
    </Disclosure>
  );
}

/** The session's own model-request limit, chosen before it starts; delegated agents share it. */
export function TaskBudgetField({
  budgetText,
  setBudgetText,
}: {
  budgetText: string | undefined;
  setBudgetText: (text: string) => void;
}) {
  const invalid = budgetText !== undefined && parseTaskBudget(budgetText) === undefined;
  return (
    <div className="field max-w-sm">
      <label className={label}>
        Model-request limit
        <span className="block w-32">
          <input
            type="number"
            name="stepBudget"
            inputMode="numeric"
            min={STEP_BUDGET_MIN}
            max={STEP_BUDGET_MAX}
            step={1}
            required
            value={budgetText ?? ''}
            disabled={budgetText === undefined}
            aria-invalid={invalid}
            aria-describedby="step-budget-help"
            className={field}
            onChange={(event) => setBudgetText(event.target.value)}
          />
        </span>
      </label>
      <p
        id="step-budget-help"
        className={cx('mt-1.5 text-xs', invalid ? 'notice error text-red-700 dark:text-red-400' : muted)}
      >
        {invalid
          ? TASK_BUDGET_GUIDANCE
          : 'Maximum model requests for this session’s work, including delegated agents. Each model response counts; tool calls do not.'}
      </p>
    </div>
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
    <button type="button" className={button.secondary} onClick={() => void catalog.load()}>
      Refresh commands
    </button>
  );
  if (state.kind === 'idle' || state.kind === 'loading') {
    return <p className={cx('py-2 text-sm', muted)}>Loading installed commands…</p>;
  }
  if (state.kind === 'error') {
    return (
      <div className="flex flex-wrap items-center gap-3">
        <Notice tone="error" className="flex-1">
          The installed commands could not be loaded.
        </Notice>
        {refresh}
      </div>
    );
  }
  if (state.catalog.kind === 'unconfigured') {
    return (
      <p className={notice('info')}>No runtime facets are configured for this deployment. Send a message instead.</p>
    );
  }
  if (state.catalog.kind === 'unavailable') {
    return (
      <div className="flex flex-wrap items-center gap-3">
        <p className={cx(notice('error'), 'flex-1')}>
          The installed commands cannot be read ({state.catalog.reason.replaceAll('_', ' ')}). Send a message instead,
          or try again.
        </p>
        {refresh}
      </div>
    );
  }
  if (commands.length === 0) {
    return (
      <div className="flex flex-wrap items-center gap-3">
        <p className={cx('flex-1 text-sm', muted)}>No commands are installed. Send a message instead.</p>
        {refresh}
      </div>
    );
  }
  return (
    <>
      <div className="flex flex-wrap items-end gap-2">
        <label className={cx(label, 'min-w-0 flex-1')}>
          Command
          <select
            name="command"
            aria-label="Command"
            value={props.commandId}
            className={field}
            onChange={(event) => props.setCommandId(event.target.value)}
          >
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
      {command !== undefined && (
        <>
          <p className={meta}>
            {command.name} · {originsLabel(command.origins)}
          </p>
          {command.description !== undefined && (
            <p className="text-sm whitespace-pre-wrap break-words">{command.description}</p>
          )}
          <label className={label}>
            Arguments {command.arguments?.required === true ? '(required)' : '(optional)'}
            <textarea
              name="arguments"
              value={props.args}
              rows={3}
              className={cx(field, 'max-h-[40dvh] resize-y')}
              onChange={(event) => props.setArgs(event.target.value)}
            />
          </label>
        </>
      )}
    </>
  );
}
