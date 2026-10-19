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
import { useCallback, useRef, useState } from 'react';
import type { ApiClient } from '../api/client.ts';
import { actorLabel, formatTime } from './format.ts';

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

const words = (code: string) => code.replaceAll('_', ' ');

const CONNECTION_LABELS: Record<ServerView['connection']['kind'], string> = {
  approved: 'connection approved',
  reapproval_required: 'needs approval again (its declaration, program or bindings changed)',
  denied: 'denied by the owner',
  not_configured: 'not approved (no configuration)',
  program_unavailable: 'its program is not available',
};

function GrantList({ grants }: { grants: readonly ToolGrantView[] }) {
  if (grants.length === 0) return <p className="hint">No tools granted.</p>;
  return (
    <ul className="grants">
      {grants.map((grant) => (
        <li key={grant.tool}>
          <code>{grant.tool}</code>{' '}
          <span className="hint" title={grant.definitionDigest}>
            definition {grant.definitionDigest.slice(0, 12)}
          </span>
          {Object.entries(grant.argumentEquals).map(([field, value]) => (
            <span key={field} className="hint">
              {' '}
              · only <code>{field}</code> = {value.kind === 'value' ? JSON.stringify(value.value) : '(withheld)'}
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
  const [notice, setNotice] = useState<string | undefined>();
  const inspect = async () => {
    setBusy(true);
    setNotice(undefined);
    const outcome = await client.discoverServer(server.serverId, revision);
    setBusy(false);
    if (outcome.ok) return onInspected(outcome.value.server);
    setNotice(outcome.kind === 'refused' ? outcome.error.message : 'The inspection result did not arrive.');
  };
  const { connection, observation } = server;
  return (
    <li className="server">
      <p>
        <strong>{server.serverId}</strong> <span className="hint">({originsLabel(server.origins)})</span> —{' '}
        {CONNECTION_LABELS[connection.kind]}
        {server.transport !== 'stdio' && ' · transport not supported'}
      </p>
      {connection.currentDigest !== undefined && connection.kind !== 'approved' && (
        <p className="hint">
          Digest to review and approve: <code>{connection.currentDigest}</code>
        </p>
      )}
      <GrantList grants={server.grants} />
      {connection.kind === 'approved' && server.transport === 'stdio' && (
        <p>
          <button type="button" className="secondary" disabled={busy} onClick={() => void inspect()}>
            {busy ? 'Inspecting…' : 'Inspect server'}
          </button>{' '}
          <span className="hint">Starts it briefly to list its tools; calls nothing and approves nothing.</span>
        </p>
      )}
      {notice !== undefined && <p className="notice error">{notice}</p>}
      {observation !== undefined && (
        <div className="observation">
          <p className="hint">Tools listed {formatTime(observation.observedAt)}:</p>
          <ul>
            {observation.tools.map((tool, index) =>
              tool.status === 'supported' ? (
                <li key={tool.name}>
                  <code>{tool.name}</code> — {words(tool.grant)}{' '}
                  <span className="hint" title={tool.definitionDigest}>
                    definition <code>{tool.definitionDigest}</code>
                  </span>
                  {tool.description !== undefined && <p className="text">{tool.description}</p>}
                  <details>
                    <summary>Definition</summary>
                    <pre>{JSON.stringify(tool.definition, null, 2)}</pre>
                  </details>
                </li>
              ) : (
                <li key={tool.name ?? `refused-${index}`}>
                  {tool.name === undefined ? '(unnamed tool)' : <code>{tool.name}</code>} — unsupported:{' '}
                  {words(tool.reason)}
                </li>
              ),
            )}
          </ul>
        </div>
      )}
    </li>
  );
}

/** The installed catalog, opened on demand. */
export function InstalledCapabilities({ client, catalog }: { client: ApiClient; catalog: Catalog }) {
  const { state } = catalog;
  return (
    <details
      className="panel capabilities"
      onToggle={(event) => {
        if (event.currentTarget.open && state.kind === 'idle') void catalog.load();
      }}
    >
      <summary>Installed capabilities</summary>
      <p>
        <button type="button" className="secondary" onClick={() => void catalog.load()}>
          Refresh
        </button>
      </p>
      {state.kind === 'loading' && <p className="hint">Loading…</p>}
      {state.kind === 'error' && <p className="notice error">The installed capabilities could not be loaded.</p>}
      {state.kind === 'loaded' && state.catalog.kind === 'unconfigured' && (
        <p className="hint">No runtime facets are configured for this deployment.</p>
      )}
      {state.kind === 'loaded' && state.catalog.kind === 'unavailable' && (
        <p className="notice error">The installation cannot be read ({words(state.catalog.reason)}).</p>
      )}
      {state.kind === 'loaded' && state.catalog.kind === 'ready' && (
        <>
          <h3>Contributions</h3>
          <ul className="contributions">
            {state.catalog.contributions.map((contribution) => (
              <li key={contribution.id}>
                <code>{contribution.id}</code> <span className="hint">({originsLabel(contribution.origins)})</span> —{' '}
                {contributionStatus(contribution)}
                {contribution.description !== undefined && <p className="text">{contribution.description}</p>}
              </li>
            ))}
          </ul>
          <h3>MCP servers</h3>
          {state.catalog.servers.length === 0 ? (
            <p className="hint">No servers are installed.</p>
          ) : (
            <ul className="servers">
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
    </details>
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

/** What a command run retained and actually used; nothing for a goal run. */
export function RunCapabilitiesPanel({ capabilities }: { capabilities: RunCapabilitiesView | undefined }) {
  if (capabilities === undefined || capabilities.kind === 'native') return null;
  if (capabilities.kind === 'unavailable') {
    return (
      <section className="panel capabilities">
        <h2>Capabilities</h2>
        <p className="notice error">This run’s retained definitions cannot be read ({words(capabilities.reason)}).</p>
      </section>
    );
  }
  const { command, bound, used, limits, permissions } = capabilities;
  const loaded = new Set(used.loadedSkills.map((entry) => entry.skillId));
  const delegated = new Set(used.delegations.map((entry) => entry.agentId));
  const called = new Set(used.operations.filter((row) => row.kind === 'mcp').map((row) => row.subject));
  return (
    <section className="panel capabilities">
      <h2>Capabilities</h2>
      <dl className="facts">
        <dt>Command</dt>
        <dd>
          <code>{command.id}</code> <span className="hint">({originsLabel(command.origins)})</span>
          {command.arguments !== '' && (
            <>
              {' '}
              with arguments <span className="text">{command.arguments}</span>
            </>
          )}
        </dd>
        <dt>Limits</dt>
        <dd>
          Up to {limits.maxDelegations} delegations, depth {limits.delegationDepth}
        </dd>
      </dl>
      <h3>Bound to this run</h3>
      <ul className="bound">
        {bound.skills.map((skill) => (
          <li key={skill.id}>
            Skill <code>{skill.id}</code> <span className="hint">({originsLabel(skill.origins)})</span> —{' '}
            {loaded.has(skill.id) ? 'loaded' : 'not used'}
          </li>
        ))}
        {bound.agents.map((agent) => (
          <li key={agent.id}>
            Agent <code>{agent.id}</code> <span className="hint">({originsLabel(agent.origins)})</span> —{' '}
            {delegated.has(agent.id) ? 'delegated to' : 'not used'}
          </li>
        ))}
        {bound.tools.map((tool) => (
          <li key={`${tool.serverId}/${tool.toolName}`}>
            Tool{' '}
            <code>
              {tool.serverId} / {tool.toolName}
            </code>{' '}
            <span className="hint">({originsLabel(tool.origins)})</span> —{' '}
            {called.has(`${tool.serverId}/${tool.toolName}`) ? 'called' : 'not used'}
          </li>
        ))}
      </ul>
      {used.delegations.length > 0 && (
        <>
          <h3>Delegations</h3>
          <ul>
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
          <h3>Recorded use</h3>
          <ul className="usage">
            {used.operations.map((row) => (
              <li key={`${row.kind} ${row.subject}`}>
                {words(row.kind)} <code>{row.subject}</code>: {row.ok} completed
                {row.refused > 0 && `, ${row.refused} refused`}
                {row.error > 0 && `, ${row.error} failed`}
                {row.uncertain > 0 && `, ${row.uncertain} with an unknown outcome`}
                {row.pending > 0 && `, ${row.pending} without a recorded outcome`}
                {row.codes.length > 0 && <span className="hint"> ({row.codes.map(words).join('; ')})</span>}
              </li>
            ))}
          </ul>
        </>
      )}
      <details>
        <summary>Permissions</summary>
        <p className="hint">
          Granted when the run started (new operations also need the current configuration; neither ever widens the
          other).
        </p>
        {permissions.captured.servers.map((server) => (
          <div key={server.serverId}>
            <p>
              <strong>{server.serverId}</strong>{' '}
              <span className="hint" title={server.serverDigest}>
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
        <p className="hint">Current configuration:</p>
        {permissions.current.kind === 'unconfigured' ? (
          <p>No capabilities are configured now: new operations of this run are refused.</p>
        ) : (
          permissions.current.servers.map((server) => (
            <div key={server.serverId}>
              <p>
                <strong>{server.serverId}</strong> — {words(server.connection)}
              </p>
              <GrantList grants={server.grants} />
            </div>
          ))
        )}
      </details>
    </section>
  );
}
