// A command-run harness for the MCP dispatch suites: the production run service and provider assembly over a real
// PostgreSQL fixture, a scripted model network (Anthropic or OpenAI) and the bundled synthetic MCP server, approved
// through operator configuration. The server's own witness log counts processes, listings and calls independently of
// the runtime under test. Synthetic inputs only; no provider or real server is contacted.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { selectionRevision } from '../../packages/runtime/src/capabilities/command.ts';
import { type CatalogLoad, loadInstallation } from '../../packages/runtime/src/capabilities/installation.ts';
import { createMcpPreflight, serverDigest } from '../../packages/runtime/src/capabilities/preflight.ts';
import { configuredCredentialSlots, type ServerAccess } from '../../packages/runtime/src/config/capabilities.ts';
import { parseOperatorConfig } from '../../packages/runtime/src/config/operator.ts';
import { NO_KNOWN_CREDENTIALS } from '../../packages/runtime/src/credentials/matcher.ts';
import { loadConfiguredMcpCredentials, McpCredentialStore } from '../../packages/runtime/src/credentials/mcp-store.ts';
import { CredentialStore } from '../../packages/runtime/src/credentials/store.ts';
import { externalToolName } from '../../packages/runtime/src/mcp/adapt.ts';
import { inspectServer } from '../../packages/runtime/src/mcp/discovery.ts';
import { planLaunch } from '../../packages/runtime/src/mcp/transport.ts';
import type { Persistence } from '../../packages/runtime/src/persistence/persistence.ts';
import { createProviderAssembly } from '../../packages/runtime/src/providers/assembly.ts';
import { canonicalJson } from '../../packages/runtime/src/records/canonical.ts';
import { RunStore } from '../../packages/runtime/src/records/run-store.ts';
import { createContentPolicy } from '../../packages/runtime/src/security/content-policy.ts';
import { RunService, type RunServiceOptions } from '../../packages/runtime/src/service/runs.ts';
import { inferenceNetwork } from './anthropic-network.ts';
import { requireMcpFixture } from './mcp-fixture.ts';

const D = 'd'.repeat(64);
const integrity = `sha256:${'f'.repeat(64)}`;
const origin = { facet: 'workflows', version: '1.0.0', source: 'local:./facets/workflows', integrity };
/** The synthetic server's credential: only the server may ever receive it. */
export const SLOT_VALUE = 'synthetic-dispatch-slot-value-0001';
export const SERVER = 'synthetic';
export const declaration = { type: 'stdio', command: './synthetic', args: [], env: { REPO_MODE: 'read' } };
export const wire = (tool: string) => externalToolName(SERVER, tool);

const definition = (kind: string, name: string, extra: Record<string, unknown>) => ({
  kind,
  facet: 'workflows',
  authoredName: name,
  materialization: { kind: 'authored' },
  files: [{ path: kind === 'skill' ? `skills/${name}/SKILL.md` : `${kind}s/${name}.md`, integrity }],
  state: {
    kind: 'ready',
    definition: {
      id: `${kind}:${name}`,
      name,
      description: `About ${name}`,
      origins: [origin],
      exportDigest: D,
      requires: [],
      ...extra,
    },
  },
});

const guide = new TextEncoder().encode('# Guide\nCheck the item count.\n');
const bundleBytes = new TextEncoder().encode(
  `${canonicalJson({
    format: 2,
    profile: 1,
    toolchain: {
      cli: { version: '0.36.0', platform: 'linux-x64', sha256: 'c'.repeat(64) },
      adapter: { name: 'agent-runtime', apiVersion: '0.3', sdkVersion: '0.30.0', sha256: 'a'.repeat(64) },
    },
    inputs: { manifestVersion: 0.2, lockfileVersion: 0.4, manifestSha256: D, lockSha256: D },
    facets: [
      { facet: 'workflows', version: '1.0.0', source: { kind: 'local', path: './facets/workflows' }, integrity },
    ],
    items: [
      definition('command', 'sync', {
        body: 'Sync $ARGUMENTS.',
        arguments: { required: true },
        requires: [{ kind: 'mcp', serverId: SERVER, toolName: 'list_items' }],
      }),
      definition('agent', 'worker', { instructions: 'Do the delegated task with the tools you have.' }),
      definition('skill', 'review', {
        instructions: 'Review the item count.',
        resources: [
          {
            path: 'references/guide.md',
            byteLength: guide.byteLength,
            sha256: new Bun.CryptoHasher('sha256').update(guide).digest('hex'),
            content: Buffer.from(guide).toString('base64'),
          },
        ],
      }),
    ],
    servers: [
      {
        serverId: SERVER,
        fingerprint: `sha256:${'9'.repeat(64)}`,
        declaration,
        origins: [{ ...origin, authoredName: SERVER }],
      },
    ],
    omittedServers: [],
  })}\n`,
);
export const catalogLoad = loadInstallation(
  bundleBytes,
  new Bun.CryptoHasher('sha256').update(bundleBytes).digest('hex'),
);
if (catalogLoad.kind !== 'ready') throw new Error(catalogLoad.reason);
const catalog = catalogLoad.catalog;

const programs = requireMcpFixture();
export const program = programs.program(SERVER);

/** The approval digest of the synthetic server's connection, as the owner would compute and approve it. */
export const connectionDigest = serverDigest(
  { serverId: SERVER, declaration },
  {
    serverId: SERVER,
    programId: SERVER,
    literalEnv: {},
    credentialEnv: { REPO_TOKEN: 'repo-token' },
    toolTimeoutSeconds: 60,
    approval: { kind: 'denied' },
  },
  program,
);

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
    toolTimeoutSeconds: 60,
    approval: {
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
    catalog: async (): Promise<CatalogLoad> => catalogLoad,
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
  return { service, net, witness, start, stateDir, logs, digests, operator };
}
