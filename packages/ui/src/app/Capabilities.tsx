// Installed capabilities and one run's retained capabilities. Reading either starts nothing on the server; the only
// action here is an explicit server inspection, which starts that approved server briefly to list its tools and
// calls nothing. Every value from the server is rendered as text.
import type {
  CatalogView,
  ContributionView,
  OriginView,
  RunCapabilitiesView,
  ServerView,
  ToolGrantView,
} from '@agent-runtime/contracts';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ApiClient } from '../api/client.ts';
import { actorLabel, formatTime } from './format.ts';
import { button, ChevronIcon, card, code, cx, hint, muted, notice, subheading, summaryLine } from './ui.tsx';

export type CatalogState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'error' }
  | { kind: 'loaded'; catalog: CatalogView };

/** The installed catalog, loaded only when asked for (on opening a view of it, or an explicit refresh). */
export function useCatalog(client: ApiClient) {
  const [state, setState] = useState<CatalogState>({ kind: 'idle' });
  const loading = useRef<Promise<void> | undefined>(undefined);
  const load = useCallback(() => {
    loading.current ??= (async () => {
      setState((current) => (current.kind === 'loaded' ? current : { kind: 'loading' }));
      const outcome = await client.capabilities();
      setState(outcome.ok ? { kind: 'loaded', catalog: outcome.value } : { kind: 'error' });
      loading.current = undefined;
    })();
    return loading.current;
  }, [client]);
  /** Records a server as an inspection returned it. */
  const replaceServer = useCallback((server: ServerView) => {
    setState((current) =>
      current.kind === 'loaded' && current.catalog.kind === 'ready'
        ? {
            kind: 'loaded',
            catalog: {
              ...current.catalog,
              servers: current.catalog.servers.map((entry) => (entry.serverId === server.serverId ? server : entry)),
            },
          }
        : current,
    );
  }, []);
  return { state, load, replaceServer };
}

export type Catalog = ReturnType<typeof useCatalog>;

export const originsLabel = (origins: readonly OriginView[]) =>
  origins.map((origin) => `${origin.facet} ${origin.version}`).join(', ');

const words = (text: string) => text.replaceAll('_', ' ');

const CONNECTION_LABELS: Record<ServerView['connection']['kind'], string> = {
  approved: 'connection approved',
  reapproval_required: 'needs approval again (its declaration, program or bindings changed)',
  denied: 'denied by the owner',
  not_configured: 'not approved (no configuration)',
  program_unavailable: 'its program is not available',
};

const LIST = 'space-y-2 text-sm';

function GrantList({ grants }: { grants: readonly ToolGrantView[] }) {
  if (grants.length === 0) return <p className={cx('text-sm', hint)}>No tools granted.</p>;
  return (
    <ul className={cx('grants', LIST)}>
      {grants.map((grant) => (
        <li key={grant.tool}>
          <code className={code}>{grant.tool}</code>{' '}
          <span className={hint} title={grant.definitionDigest}>
            definition {grant.definitionDigest.slice(0, 12)}
          </span>
          {Object.entries(grant.argumentEquals).map(([name, value]) => (
            <span key={name} className={hint}>
              {' '}
              · only <code className={code}>{name}</code> ={' '}
              {value.kind === 'value' ? JSON.stringify(value.value) : '(withheld)'}
            </span>
          ))}
        </li>
      ))}
    </ul>
  );
}

function contributionStatus(contribution: ContributionView): string {
  if (contribution.availability.kind === 'refused') {
    const { reason, subject } = contribution.availability;
    return `refused: ${words(reason)}${subject === undefined ? '' : ` (${subject})`}`;
  }
  if (contribution.allowed === false) return 'installed; not allowed by the owner’s configuration';
  return 'ready';
}

function ServerEntry({
  client,
  revision,
  server,
  onInspected,
}: {
  client: ApiClient;
  revision: string;
  server: ServerView;
  onInspected: (server: ServerView) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | undefined>();
  const inspect = async () => {
    setBusy(true);
    setProblem(undefined);
    const outcome = await client.discoverServer(server.serverId, revision);
    setBusy(false);
    if (outcome.ok) return onInspected(outcome.value.server);
    setProblem(outcome.kind === 'refused' ? outcome.error.message : 'The inspection result did not arrive.');
  };
  const { connection, observation } = server;
  return (
    <li className={cx('server space-y-2 p-4', card)}>
      <p className="text-sm">
        <strong className="font-semibold">{server.serverId}</strong>{' '}
        <span className={hint}>({originsLabel(server.origins)})</span> — {CONNECTION_LABELS[connection.kind]}
        {server.transport !== 'stdio' && ' · transport not supported'}
      </p>
      {connection.currentDigest !== undefined && connection.kind !== 'approved' && (
        <p className={cx('text-sm', hint)}>
          Digest to review and approve: <code className={cx(code, 'break-all')}>{connection.currentDigest}</code>
        </p>
      )}
      <GrantList grants={server.grants} />
      {connection.kind === 'approved' && server.transport === 'stdio' && (
        <p className="flex flex-wrap items-center gap-3 text-sm">
          <button type="button" className={button.secondary} disabled={busy} onClick={() => void inspect()}>
            {busy ? 'Inspecting…' : 'Inspect server'}
          </button>
          <span className={hint}>Starts it briefly to list its tools; calls nothing and approves nothing.</span>
        </p>
      )}
      {problem !== undefined && <p className={notice('error')}>{problem}</p>}
      {observation !== undefined && (
        <div className="observation space-y-2">
          <p className={cx('text-sm', hint)}>Tools listed {formatTime(observation.observedAt)}:</p>
          <ul className={LIST}>
            {observation.tools.map((tool, index) =>
              tool.status === 'supported' ? (
                <li key={tool.name}>
                  <code className={code}>{tool.name}</code> — {words(tool.grant)}{' '}
                  <span className={hint} title={tool.definitionDigest}>
                    definition <code className={cx(code, 'break-all')}>{tool.definitionDigest}</code>
                  </span>
                  {tool.description !== undefined && (
                    <p className="mt-1 whitespace-pre-wrap break-words">{tool.description}</p>
                  )}
                  <details className="group mt-1">
                    <summary className={summaryLine}>
                      <ChevronIcon />
                      Definition
                    </summary>
                    <Json value={tool.definition} />
                  </details>
                </li>
              ) : (
                <li key={tool.name ?? `refused-${index}`}>
                  {tool.name === undefined ? '(unnamed tool)' : <code className={code}>{tool.name}</code>} —
                  unsupported: {words(tool.reason)}
                </li>
              ),
            )}
          </ul>
        </div>
      )}
    </li>
  );
}

/** A JSON value, formatted and contained. */
export function Json({ value }: { value: unknown }) {
  return (
    <pre className="mt-2 max-h-96 overflow-auto rounded-lg bg-zinc-100 p-3 font-mono text-xs break-all whitespace-pre-wrap dark:bg-zinc-900">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

/** The installed capabilities page: read when it opens, and again on request. */
export function CapabilitiesPage({ client }: { client: ApiClient }) {
  const catalog = useCatalog(client);
  const { load } = catalog;
  useEffect(() => {
    void load();
  }, [load]);
  return (
    <main className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl px-4 py-8">
        <div className="mb-6 flex items-center justify-between gap-4">
          <h1 className="text-xl font-semibold tracking-tight">Installed capabilities</h1>
          <button type="button" className={button.secondary} onClick={() => void load()}>
            Refresh
          </button>
        </div>
        <InstalledCapabilities client={client} catalog={catalog} />
      </div>
    </main>
  );
}

/** The installed catalog's contents. */
export function InstalledCapabilities({ client, catalog }: { client: ApiClient; catalog: Catalog }) {
  const { state } = catalog;
  return (
    <section className="capabilities space-y-4">
      {(state.kind === 'loading' || state.kind === 'idle') && <p className={cx('text-sm', hint)}>Loading…</p>}
      {state.kind === 'error' && <p className={notice('error')}>The installed capabilities could not be loaded.</p>}
      {state.kind === 'loaded' && state.catalog.kind === 'unconfigured' && (
        <p className={cx('text-sm', hint)}>No runtime facets are configured for this deployment.</p>
      )}
      {state.kind === 'loaded' && state.catalog.kind === 'unavailable' && (
        <p className={notice('error')}>The installation cannot be read ({words(state.catalog.reason)}).</p>
      )}
      {state.kind === 'loaded' && state.catalog.kind === 'ready' && (
        <>
          <h2 className={subheading}>Contributions</h2>
          <ul className={cx('contributions divide-y divide-zinc-200 dark:divide-zinc-800', card)}>
            {state.catalog.contributions.map((contribution) => (
              <li key={contribution.id} className="px-4 py-3 text-sm">
                <code className={code}>{contribution.id}</code>{' '}
                <span className={hint}>({originsLabel(contribution.origins)})</span> —{' '}
                {contributionStatus(contribution)}
                {contribution.description !== undefined && (
                  <p className="mt-1 whitespace-pre-wrap break-words">{contribution.description}</p>
                )}
              </li>
            ))}
          </ul>
          <h2 className={subheading}>MCP servers</h2>
          {state.catalog.servers.length === 0 ? (
            <p className={cx('text-sm', hint)}>No servers are installed.</p>
          ) : (
            <ul className="servers space-y-3">
              {state.catalog.servers.map((server) => (
                <ServerEntry
                  key={server.serverId}
                  client={client}
                  revision={(state.catalog as Extract<CatalogView, { kind: 'ready' }>).catalogRevision}
                  server={server}
                  onInspected={catalog.replaceServer}
                />
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

const DELEGATION_STATES: Record<string, string> = {
  active: 'working',
  waiting: 'waiting for your answer',
  result: 'returned a result',
  refused: 'was refused',
  failed: 'failed',
  abandoned: 'was abandoned',
};

/** What a command run retained and actually used, folded; nothing for a message session. */
export function RunCapabilitiesPanel({ capabilities }: { capabilities: RunCapabilitiesView | undefined }) {
  if (capabilities === undefined || capabilities.kind === 'native') return null;
  if (capabilities.kind === 'unavailable') {
    return (
      <p className={notice('error')}>
        This session’s retained definitions cannot be read ({words(capabilities.reason)}).
      </p>
    );
  }
  const { command, bound, used, limits, permissions } = capabilities;
  const loaded = new Set(used.loadedSkills.map((entry) => entry.skillId));
  const delegated = new Set(used.delegations.map((entry) => entry.agentId));
  const called = new Set(used.operations.filter((row) => row.kind === 'mcp').map((row) => row.subject));
  return (
    <details className={cx('capabilities group px-4 py-3', card)}>
      <summary className={summaryLine}>
        <ChevronIcon />
        Capabilities <span className={hint}>· {command.name}</span>
      </summary>
      <dl className="facts mt-3 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1.5 text-sm">
        <dt className={muted}>Command</dt>
        <dd className="min-w-0 break-words">
          <code className={code}>{command.id}</code> <span className={hint}>({originsLabel(command.origins)})</span>
          {command.arguments !== '' && (
            <>
              {' '}
              with arguments <span className="whitespace-pre-wrap">{command.arguments}</span>
            </>
          )}
        </dd>
        <dt className={muted}>Limits</dt>
        <dd>
          Up to {limits.maxDelegations} delegations, depth {limits.delegationDepth}
        </dd>
      </dl>
      <h3 className={subheading}>Bound to this session</h3>
      <ul className={cx('bound', LIST)}>
        {bound.skills.map((skill) => (
          <li key={skill.id}>
            Skill <code className={code}>{skill.id}</code> <span className={hint}>({originsLabel(skill.origins)})</span>{' '}
            — {loaded.has(skill.id) ? 'loaded' : 'not used'}
          </li>
        ))}
        {bound.agents.map((agent) => (
          <li key={agent.id}>
            Agent <code className={code}>{agent.id}</code> <span className={hint}>({originsLabel(agent.origins)})</span>{' '}
            — {delegated.has(agent.id) ? 'delegated to' : 'not used'}
          </li>
        ))}
        {bound.tools.map((tool) => (
          <li key={`${tool.serverId}/${tool.toolName}`}>
            Tool{' '}
            <code className={code}>
              {tool.serverId} / {tool.toolName}
            </code>{' '}
            <span className={hint}>({originsLabel(tool.origins)})</span> —{' '}
            {called.has(`${tool.serverId}/${tool.toolName}`) ? 'called' : 'not used'}
          </li>
        ))}
      </ul>
      {used.delegations.length > 0 && (
        <>
          <h3 className={subheading}>Delegations</h3>
          <ul className={LIST}>
            {used.delegations.map((delegation) => (
              <li key={delegation.delegationId}>
                {actorLabel({ kind: 'delegate', delegationId: delegation.delegationId, agentId: delegation.agentId })} —{' '}
                {DELEGATION_STATES[delegation.state]}
              </li>
            ))}
          </ul>
        </>
      )}
      {used.operations.length > 0 && (
        <>
          <h3 className={subheading}>Recorded use</h3>
          <ul className={cx('usage', LIST)}>
            {used.operations.map((row) => (
              <li key={`${row.kind} ${row.subject}`}>
                {words(row.kind)} <code className={code}>{row.subject}</code>: {row.ok} completed
                {row.refused > 0 && `, ${row.refused} refused`}
                {row.error > 0 && `, ${row.error} failed`}
                {row.uncertain > 0 && `, ${row.uncertain} with an unknown outcome`}
                {row.pending > 0 && `, ${row.pending} without a recorded outcome`}
                {row.codes.length > 0 && <span className={hint}> ({row.codes.map(words).join('; ')})</span>}
              </li>
            ))}
          </ul>
        </>
      )}
      <details className="group/permissions mt-4">
        <summary className={summaryLine}>Permissions</summary>
        <div className="mt-2 space-y-2 text-sm">
          <p className={hint}>
            Granted when the session started (new operations also need the current configuration; neither ever widens
            the other).
          </p>
          {permissions.captured.servers.map((server) => (
            <div key={server.serverId}>
              <p>
                <strong className="font-semibold">{server.serverId}</strong>{' '}
                <span className={hint} title={server.serverDigest}>
                  connection {server.serverDigest.slice(0, 12)}
                </span>
              </p>
              <GrantList grants={server.grants} />
            </div>
          ))}
          <p>
            Skills: {permissions.captured.skills.join(', ') || 'none'} · Agents:{' '}
            {permissions.captured.agents.join(', ') || 'none'}
          </p>
          <p className={hint}>Current configuration:</p>
          {permissions.current.kind === 'unconfigured' ? (
            <p>No capabilities are configured now: new operations of this session are refused.</p>
          ) : (
            permissions.current.servers.map((server) => (
              <div key={server.serverId}>
                <p>
                  <strong className="font-semibold">{server.serverId}</strong> — {words(server.connection)}
                </p>
                <GrantList grants={server.grants} />
              </div>
            ))
          )}
        </div>
      </details>
    </details>
  );
}
