// A command-run harness for the MCP dispatch suites: the production run service and provider assembly over a real
// PostgreSQL fixture, a scripted model network (Anthropic or OpenAI) and the bundled synthetic MCP server, approved
// through operator configuration. The server's own witness log counts processes, listings and calls independently of
// the runtime under test. Synthetic inputs only; no provider or real server is contacted.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { selectionRevision } from '../../packages/runtime/src/capabilities/command.ts';
import { type CatalogLoad, loadInstallation } from '../../packages/runtime/src/capabilities/installation.ts';
import { createMcpPreflight } from '../../packages/runtime/src/capabilities/preflight.ts';
import { configuredCredentialSlots, type ServerAccess } from '../../packages/runtime/src/config/capabilities.ts';
import { parseOperatorConfig } from '../../packages/runtime/src/config/operator.ts';
import { NO_KNOWN_CREDENTIALS } from '../../packages/runtime/src/credentials/matcher.ts';
import { loadConfiguredMcpCredentials, McpCredentialStore } from '../../packages/runtime/src/credentials/mcp-store.ts';
import { CredentialStore } from '../../packages/runtime/src/credentials/store.ts';
import { inspectServer } from '../../packages/runtime/src/mcp/discovery.ts';
import { planLaunch } from '../../packages/runtime/src/mcp/transport.ts';
import type { Persistence } from '../../packages/runtime/src/persistence/persistence.ts';
import { createProviderAssembly } from '../../packages/runtime/src/providers/assembly.ts';
import { RunStore } from '../../packages/runtime/src/records/run-store.ts';
import { createContentPolicy } from '../../packages/runtime/src/security/content-policy.ts';
import { handleApi } from '../../packages/runtime/src/service/http.ts';
import { RunService, type RunServiceOptions } from '../../packages/runtime/src/service/runs.ts';
import { REAL_TIME } from '../../packages/runtime/src/service/stream.ts';
import { inferenceNetwork, offeredName, type SentInference } from './anthropic-network.ts';
import { requireMcpFixture } from './mcp-fixture.ts';
import {
  connectionDigest as connectionDigestFor,
  declaration,
  INSTALLATION_BYTES,
  INSTALLATION_SHA256,
  SERVER,
  SLOT_VALUE,
} from './synthetic-installation.ts';

const D = 'd'.repeat(64);

export { declaration, SERVER, SLOT_VALUE };
/** The name the given request offered the synthetic server's tool under. */
export const wire = (request: SentInference, tool: string) => offeredName(request, SERVER, tool);

export const catalogLoad = loadInstallation(INSTALLATION_BYTES, INSTALLATION_SHA256);
if (catalogLoad.kind !== 'ready') throw new Error(catalogLoad.reason);
const catalog = catalogLoad.catalog;

const programs = requireMcpFixture();
export const program = programs.program(SERVER);

/** The approval digest of the synthetic server's connection, as the owner would compute and approve it. */
export const connectionDigest = connectionDigestFor(program);

let reviewed: Promise<Map<string, string>> | undefined;
/** The owner's review step: one explicit inspection outside any run, giving each tool's definition digest. */
export function reviewedDigests(scratch: string): Promise<Map<string, string>> {
  reviewed ??= (async () => {
    const stateDir = join(scratch, 'review');
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    const policy = createContentPolicy(NO_KNOWN_CREDENTIALS);
    const plan = await planLaunch(
      {
        serverId: SERVER,
        program,
        args: [],
        declarationEnv: { REPO_MODE: 'read' },
        literalEnv: {},
        credentialEnv: { REPO_TOKEN: SLOT_VALUE },
      },
      { stateDir, bunPath: process.execPath, policy },
    );
    if (!plan.ok) throw new Error(plan.reason);
    const found = await inspectServer({ params: plan.params, policy });
    if (!('tools' in found)) throw new Error(found.reason);
    return new Map(
      found.tools.flatMap((tool) => (tool.status === 'supported' ? [[tool.name, tool.definitionDigest]] : [])),
    );
  })();
  return reviewed;
}

export interface Grant {
  name: string;
  argumentEquals?: Record<string, unknown>;
}

export interface HarnessOptions {
  scratch: string;
  persistence: Persistence;
  provider?: 'anthropic' | 'openai';
  /** Granted tools; the connection is approved for the synthetic server's exact current binding. */
  grants: Grant[];
  /** Scripted model replies, in order or by request. */
  replies: Parameters<typeof inferenceNetwork>[0];
  stepBudget?: number;
  allowAgents?: string[];
  allowSkills?: string[];
  maxDelegationsPerRun?: number;
  /** `denied` configures the synthetic server's connection as denied instead of approved. */
  approval?: 'denied';
  /** The installed catalog the service reads; the synthetic bundle unless given. */
  catalog?: () => Promise<CatalogLoad>;
  /** The approved server's call deadline; 60 seconds unless given. */
  toolTimeoutSeconds?: number;
  /** Reuse an existing private state directory (a restart of the same deployment). */
  stateDir?: string;
  store?: RunServiceOptions['store'];
}

let counter = 0;

export async function mcpService(options: HarnessOptions) {
  const digests = await reviewedDigests(options.scratch);
  const base = join(options.scratch, `case-${++counter}`);
  const stateDir = options.stateDir ?? join(base, 'state');
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  mkdirSync(base, { recursive: true });
  const configFile = join(base, 'config.json');
  const provider = options.provider ?? 'anthropic';
  const access: ServerAccess = {
    serverId: SERVER,
    programId: SERVER,
    literalEnv: {},
    credentialEnv: { REPO_TOKEN: 'repo-token' },
    toolTimeoutSeconds: options.toolTimeoutSeconds ?? 60,
    approval:
      options.approval === 'denied'
        ? { kind: 'denied' }
        : {
            kind: 'approved',
            serverDigest: connectionDigest,
            tools: options.grants.map((grant) => ({
              name: grant.name,
              definitionDigest: digests.get(grant.name) as string,
              argumentEquals: (grant.argumentEquals ?? {}) as Record<string, string>,
            })),
          },
  };
  const source = JSON.stringify({
    version: 1,
    workspace: { id: 'main', label: 'Main workspace', root: join(options.scratch, 'workspace') },
    providers:
      provider === 'anthropic'
        ? { anthropic: { authMode: 'subscription', model: 'claude-opus-5', profileId: 'claude-cli-2.1.280' } }
        : { openai: { authMode: 'subscription', model: 'gpt-5.6-sol', profileId: 'codex-responses-v1' } },
    defaultProvider: provider,
    stepBudget: options.stepBudget ?? 20,
    capabilities: {
      installation: { path: join(base, 'installation.json'), sha256: D },
      allowAgents: options.allowAgents ?? [],
      allowSkills: options.allowSkills ?? [],
      ...(options.maxDelegationsPerRun === undefined ? {} : { maxDelegationsPerRun: options.maxDelegationsPerRun }),
      localPrograms: { [SERVER]: program },
      servers: [access],
    },
  });
  mkdirSync(join(options.scratch, 'workspace'), { recursive: true });
  writeFileSync(join(options.scratch, 'workspace', 'notes.md'), 'alpha\n');
  writeFileSync(configFile, source);
  const operator = parseOperatorConfig(source, { stateDir, configFile });
  if (options.stateDir === undefined) {
    await CredentialStore.forStateDir(stateDir).replace(
      provider === 'anthropic'
        ? {
            version: 1,
            provider: 'anthropic',
            authMode: 'subscription',
            slot: 'default',
            generation: 1,
            updatedAtMs: Date.now(),
            lifecycle: 'usable',
            accessToken: 'sk-ant-oat01-mcp-dispatch-access-000001',
            refreshToken: 'sk-ant-ort01-mcp-dispatch-refresh-00001',
            expiresAtMs: Date.now() + 3_600_000,
            account: {},
          }
        : {
            version: 1,
            provider: 'openai',
            authMode: 'subscription',
            slot: 'default',
            generation: 1,
            updatedAtMs: Date.now(),
            lifecycle: 'usable',
            accessToken: 'synthetic-mcp-dispatch-openai-access',
            refreshToken: 'synthetic-mcp-dispatch-openai-refresh',
            expiresAtMs: Date.now() + 3_600_000,
            account: { accountId: 'acct_mcp_dispatch' },
          },
    );
    await McpCredentialStore.forStateDir(stateDir).replace('repo-token', SLOT_VALUE);
  }
  const credentials = McpCredentialStore.forStateDir(stateDir);
  const net = inferenceNetwork(options.replies);
  const assembly = createProviderAssembly({ config: operator, stateDir, inferenceTransport: net.fetchImpl });
  // As the runtime does at startup, once it owns the database: configured slots join credential screening.
  assembly.admitMcpCredentials(await loadConfiguredMcpCredentials(credentials, configuredCredentialSlots(operator)));
  const launch = { stateDir, bunPath: process.execPath, readCredential: (slot: string) => credentials.read(slot) };
  const logs: string[] = [];
  const service = new RunService({
    operator,
    locations: { stateDir, configFile },
    persistence: options.persistence,
    assembly,
    failStop: () => logs.push('fail_stop'),
    store: options.store ?? new RunStore(options.persistence.app, options.persistence.ownership),
    catalog: options.catalog ?? (async (): Promise<CatalogLoad> => catalogLoad),
    preflight: createMcpPreflight(launch),
    mcpLaunch: launch,
    log: (line) => logs.push(line),
  });
  const witnessPath = join(stateDir, 'mcp', SERVER, 'home', 'witness.log');
  const witness = () => {
    const lines = existsSync(witnessPath) ? readFileSync(witnessPath, 'utf8').trim().split('\n') : [];
    return {
      spawns: lines.filter((line) => line.startsWith('spawn ')).length,
      lists: lines.filter((line) => line === 'list').length,
      calls: lines.filter((line) => line.startsWith('call ')).map((line) => line.slice('call '.length)),
    };
  };
  /** The process IDs the server reported starting with, in order. */
  const spawns = () =>
    (existsSync(witnessPath) ? readFileSync(witnessPath, 'utf8').trim().split('\n') : [])
      .filter((line) => line.startsWith('spawn '))
      .map((line) => line.slice('spawn '.length));
  const start = (args: string, requestId = crypto.randomUUID()) =>
    service.createRun({
      kind: 'command',
      requestId,
      provider,
      command: {
        id: 'command:sync',
        selectionRevision: selectionRevision(catalog.installationSha256, 'command:sync'),
        arguments: args,
      },
    });
  /** One request through the production API routes (`path` is below `/api/v1`). */
  const api = async (method: 'GET' | 'POST', path: string, body?: unknown) => {
    const response = await handleApi(
      new Request(`http://127.0.0.1:3000/api/v1${path}`, {
        method,
        ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
      }),
      () => service,
    );
    // biome-ignore lint/suspicious/noExplicitAny: a test reads whatever the contract returned.
    return { status: response.status, body: (await response.json()) as any };
  };
  /** The same command start as `start`, through the production API route. */
  const startApi = (args: string, requestId = crypto.randomUUID()) =>
    api('POST', '/runs', {
      requestId,
      provider,
      command: {
        id: 'command:sync',
        selectionRevision: selectionRevision(catalog.installationSha256, 'command:sync'),
        arguments: args,
      },
    });
  /**
   * Reads a run's event stream through the production route from a cursor (`after`, or the `Last-Event-ID` a
   * reconnecting browser sends) until the event with sequence `through`, then closes it; returns the events read.
   */
  const stream = async (runId: string, cursor: { after?: string; lastEventId?: string }, through: string) => {
    const response = await handleApi(
      new Request(`http://127.0.0.1:3000/api/v1/runs/${runId}/stream?after=${cursor.after ?? '0'}`, {
        headers: cursor.lastEventId === undefined ? {} : { 'last-event-id': cursor.lastEventId },
      }),
      () => service,
      undefined,
      { ...REAL_TIME, pollMs: 20 },
    );
    if (response.status !== 200) throw new Error(`stream refused: ${response.status}`);
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    // biome-ignore lint/suspicious/noExplicitAny: a test reads whatever the contract returned.
    const events: any[] = [];
    let buffer = '';
    try {
      while (events.at(-1)?.seq !== through) {
        const end = buffer.indexOf('\n\n');
        if (end < 0) {
          const { done, value } = await reader.read();
          if (done) throw new Error('the stream ended early');
          buffer += decoder.decode(value, { stream: true });
          continue;
        }
        const block = buffer.slice(0, end).split('\n');
        buffer = buffer.slice(end + 2);
        const data = block.find((line) => line.startsWith('data: '));
        if (data === undefined) continue;
        const event = JSON.parse(data.slice('data: '.length));
        if (!block.includes(`id: ${event.seq}`)) throw new Error('an event was sent without its sequence as its ID');
        events.push(event);
      }
    } finally {
      await reader.cancel();
    }
    return events;
  };
  /** A run's complete history through the paginated events route. */
  const history = async (runId: string) => {
    // biome-ignore lint/suspicious/noExplicitAny: a test reads whatever the contract returned.
    const events: any[] = [];
    for (let after = '0'; ; ) {
      const page = await api('GET', `/runs/${runId}/events?after=${after}&limit=10`);
      if (page.status !== 200) throw new Error(`history refused: ${page.status}`);
      if (page.body.events.length === 0) return events;
      events.push(...page.body.events);
      after = page.body.nextAfter;
    }
  };
  return { service, net, witness, spawns, start, startApi, api, stream, history, stateDir, logs, digests, operator };
}
