// Required-tool preflight through the production run service, against the synthetic MCP server bundle (design
// Decisions 5 and 9). Starting a command that needs an approved tool initializes, lists and closes one server process;
// nothing is called. Catalog reads, unapproved servers and optional tools launch nothing, and a retried request
// launches nothing again. The server's own witness log counts processes and requests independently.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { selectionRevision } from '../../packages/runtime/src/capabilities/command.ts';
import { type Catalog, loadInstallation } from '../../packages/runtime/src/capabilities/installation.ts';
import { createMcpPreflight, serverDigest } from '../../packages/runtime/src/capabilities/preflight.ts';
import { configuredCredentialSlots, type ServerAccess } from '../../packages/runtime/src/config/capabilities.ts';
import { parseOperatorConfig } from '../../packages/runtime/src/config/operator.ts';
import { NO_KNOWN_CREDENTIALS } from '../../packages/runtime/src/credentials/matcher.ts';
import { loadConfiguredMcpCredentials, McpCredentialStore } from '../../packages/runtime/src/credentials/mcp-store.ts';
import { CredentialStore } from '../../packages/runtime/src/credentials/store.ts';
import { inspectServer } from '../../packages/runtime/src/mcp/discovery.ts';
import { planLaunch } from '../../packages/runtime/src/mcp/transport.ts';
import { openPersistence, type Persistence } from '../../packages/runtime/src/persistence/persistence.ts';
import { createProviderAssembly } from '../../packages/runtime/src/providers/assembly.ts';
import { canonicalJson } from '../../packages/runtime/src/records/canonical.ts';
import { RunStore } from '../../packages/runtime/src/records/run-store.ts';
import { createContentPolicy } from '../../packages/runtime/src/security/content-policy.ts';
import { RunService } from '../../packages/runtime/src/service/runs.ts';
import { createFixture } from '../../packages/runtime/test-support/workspace.ts';
import { inferenceNetwork, sse, textTurn } from '../support/anthropic-network.ts';
import { requireMcpFixture } from '../support/mcp-fixture.ts';
import { createScratchDatabase, type ScratchDatabase } from '../support/scratch-database.ts';

const programs = requireMcpFixture();
const program = programs.program('synthetic');
let db: ScratchDatabase;
let persistence: Persistence;
const workspace = createFixture();
workspace.write('notes/plan.md', 'alpha\n');
const scratch = mkdtempSync(join(tmpdir(), 'agent-runtime-command-preflight-'));
beforeAll(async () => {
  db = await createScratchDatabase();
  persistence = await openPersistence({ url: db.url, onFault: () => {} });
});
afterAll(async () => {
  await persistence.close();
  await db.drop();
  workspace.cleanup();
  rmSync(scratch, { recursive: true, force: true });
});

const D = 'd'.repeat(64);
const integrity = `sha256:${'f'.repeat(64)}`;
const origin = { facet: 'workflows', version: '1.0.0', source: 'local:./facets/workflows', integrity };
const SLOT_VALUE = 'synthetic-preflight-slot-value-01';
const declaration = { type: 'stdio', command: './synthetic', args: [], env: { REPO_MODE: 'read' } };
let counter = 0;

const definition = (kind: string, name: string, extra: Record<string, unknown>) => ({
  kind,
  facet: 'workflows',
  authoredName: name,
  materialization: { kind: 'authored' },
  files: [{ path: `${kind}s/${name}.md`, integrity }],
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
const installedServer = (serverId: string) => ({
  serverId,
  fingerprint: `sha256:${'9'.repeat(64)}`,
  declaration,
  origins: [{ ...origin, authoredName: serverId }],
});
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
        requires: [{ kind: 'mcp', serverId: 'synthetic', toolName: 'list_items' }],
      }),
      definition('command', 'plain', { body: 'Summarize.', arguments: { required: false } }),
      definition('agent', 'needs-other', {
        instructions: 'Use the other server.',
        requires: [{ kind: 'mcp', serverId: 'other', toolName: 'list_items' }],
      }),
    ],
    servers: [installedServer('other'), installedServer('synthetic')],
    omittedServers: [],
  })}\n`,
);
const catalogLoad = loadInstallation(bundleBytes, new Bun.CryptoHasher('sha256').update(bundleBytes).digest('hex'));
if (catalogLoad.kind !== 'ready') throw new Error(catalogLoad.reason);
const catalog: Catalog = catalogLoad.catalog;
const access = (approval: ServerAccess['approval']): ServerAccess => ({
  serverId: 'synthetic',
  programId: 'synthetic',
  literalEnv: {},
  credentialEnv: { REPO_TOKEN: 'repo-token' },
  toolTimeoutSeconds: 60,
  approval,
});
const digest = serverDigest(catalog.installation.servers[1] as never, access({ kind: 'denied' }), program);

/** The owner's review step: an explicit inspection of the approved server, outside any run. */
async function reviewedListItemsDigest(): Promise<string> {
  const stateDir = join(scratch, 'review');
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const plan = await planLaunch(
    {
      serverId: 'synthetic',
      program,
      args: [],
      declarationEnv: { REPO_MODE: 'read' },
      literalEnv: {},
      credentialEnv: { REPO_TOKEN: SLOT_VALUE },
    },
    { stateDir, bunPath: process.execPath, policy: createContentPolicy(NO_KNOWN_CREDENTIALS) },
  );
  if (!plan.ok) throw new Error(plan.reason);
  const found = await inspectServer({ params: plan.params, policy: createContentPolicy(NO_KNOWN_CREDENTIALS) });
  if (!('tools' in found)) throw new Error(found.reason);
  const tool = found.tools.find((entry) => entry.name === 'list_items');
  if (tool?.status !== 'supported') throw new Error('list_items is not supported');
  return tool.definitionDigest;
}

async function harness(servers: ServerAccess[]) {
  const base = join(scratch, `case-${++counter}`);
  const stateDir = join(base, 'state');
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const configFile = join(base, 'config.json');
  const source = JSON.stringify({
    version: 1,
    workspace: { id: 'main', label: 'Main workspace', root: workspace.root },
    providers: { anthropic: { authMode: 'subscription', model: 'claude-opus-5', profileId: 'claude-cli-2.1.280' } },
    defaultProvider: 'anthropic',
    stepBudget: 10,
    capabilities: {
      installation: { path: join(base, 'installation.json'), sha256: D },
      allowAgents: ['agent:needs-other'],
      localPrograms: { synthetic: program },
      servers,
    },
  });
  writeFileSync(configFile, source);
  const operator = parseOperatorConfig(source, { stateDir, configFile });
  await CredentialStore.forStateDir(stateDir).replace({
    version: 1,
    provider: 'anthropic',
    authMode: 'subscription',
    slot: 'default',
    generation: 1,
    updatedAtMs: Date.now(),
    lifecycle: 'usable',
    accessToken: 'sk-ant-oat01-command-preflight-access-01',
    refreshToken: 'sk-ant-ort01-command-preflight-refresh-01',
    expiresAtMs: Date.now() + 3_600_000,
    account: {},
  });
  const credentials = McpCredentialStore.forStateDir(stateDir);
  await credentials.replace('repo-token', SLOT_VALUE);
  const net = inferenceNetwork([() => sse(textTurn('msg_done', 'Synced.'))]);
  const assembly = createProviderAssembly({ config: operator, stateDir, inferenceTransport: net.fetchImpl });
  // As the runtime does at startup, once it owns the database: configured slots join credential screening.
  assembly.admitMcpCredentials(await loadConfiguredMcpCredentials(credentials, configuredCredentialSlots(operator)));
  const service = new RunService({
    operator,
    locations: { stateDir, configFile },
    persistence,
    assembly,
    failStop: () => {},
    store: new RunStore(persistence.app, persistence.ownership),
    catalog: async () => catalogLoad,
    preflight: createMcpPreflight({
      stateDir,
      bunPath: process.execPath,
      readCredential: (slot) => credentials.read(slot),
    }),
  });
  const witness = (serverId = 'synthetic') => {
    const path = join(stateDir, 'mcp', serverId, 'home', 'witness.log');
    const lines = existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n') : [];
    return {
      spawns: lines.filter((line) => line.startsWith('spawn ')).length,
      lists: lines.filter((line) => line === 'list').length,
      calls: lines.filter((line) => line.startsWith('call ')).length,
    };
  };
  const start = (commandId: string, args: string, requestId = crypto.randomUUID(), revision?: string) =>
    service.createRun({
      kind: 'command',
      requestId,
      provider: 'anthropic',
      command: {
        id: commandId,
        selectionRevision: revision ?? selectionRevision(catalog.installationSha256, commandId),
        arguments: args,
      },
    });
  return { service, net, witness, start, stateDir };
}

// biome-ignore lint/suspicious/noExplicitAny: response bodies under test
const errorOf = (result: { status: number; body: any }) => [
  result.status,
  result.body.error?.code,
  result.body.error?.subject,
];

describe('required-tool preflight', () => {
  test('one bounded inspection binds the approved definitions; no tool is called and retries launch nothing', async () => {
    const reviewed = await reviewedListItemsDigest();
    const h = await harness([
      access({
        kind: 'approved',
        serverDigest: digest,
        tools: [{ name: 'list_items', definitionDigest: reviewed, argumentEquals: {} }],
      }),
    ]);
    const requestId = crypto.randomUUID();
    const started = await h.start('command:sync', 'owner/repo-a', requestId);
    expect(started.status).toBe(202);
    await h.service.settled();
    expect(h.witness()).toEqual({ spawns: 1, lists: 1, calls: 0 });
    expect(h.net.sent).toHaveLength(1);
    // biome-ignore lint/suspicious/noExplicitAny: response body under test
    const runId = (started.body as any).run.runId as string;
    const retained = await h.service.store.readCapabilities(runId);
    expect(retained?.snapshot.tools.map((tool) => [tool.toolName, tool.definitionDigest])).toEqual([
      ['list_items', reviewed],
    ]);
    expect(retained?.snapshot.servers.map((server) => [server.serverId, server.serverDigest])).toEqual([
      ['synthetic', digest],
    ]);
    expect(JSON.stringify(retained)).not.toContain(SLOT_VALUE);

    expect((await h.start('command:sync', 'owner/repo-a', requestId)).status).toBe(200);
    expect(h.witness()).toEqual({ spawns: 1, lists: 1, calls: 0 });
  });

  test('catalog reads and refusals decided before launch start no process', async () => {
    const reviewed = await reviewedListItemsDigest();
    const unapproved = await harness([]);
    expect(errorOf(await unapproved.start('command:sync', 'x'))).toEqual([
      409,
      'capability_unavailable',
      'mcp:synthetic/list_items',
    ]);
    expect(errorOf(await unapproved.start('command:sync', 'x', crypto.randomUUID(), D))).toEqual([
      409,
      'capability_selection_changed',
      'command:sync',
    ]);
    const redeclared = await harness([
      access({
        kind: 'approved',
        serverDigest: D,
        tools: [{ name: 'list_items', definitionDigest: reviewed, argumentEquals: {} }],
      }),
    ]);
    expect(errorOf(await redeclared.start('command:sync', 'x'))).toEqual([
      409,
      'capability_unavailable',
      'mcp:synthetic/list_items',
    ]);
    for (const h of [unapproved, redeclared]) {
      expect(h.witness()).toEqual({ spawns: 0, lists: 0, calls: 0 });
      expect(h.net.sent).toEqual([]);
    }
  });

  test('a changed tool definition is refused after one inspection, with nothing called', async () => {
    const h = await harness([
      access({
        kind: 'approved',
        serverDigest: digest,
        tools: [{ name: 'list_items', definitionDigest: D, argumentEquals: {} }],
      }),
    ]);
    expect(errorOf(await h.start('command:sync', 'x'))).toEqual([
      409,
      'capability_unavailable',
      'mcp:synthetic/list_items',
    ]);
    expect(h.witness()).toEqual({ spawns: 1, lists: 1, calls: 0 });
    expect(h.net.sent).toEqual([]);
  });

  test('a tool needed only optionally launches nothing and does not block an unrelated command', async () => {
    const h = await harness([]);
    const started = await h.start('command:plain', '');
    expect(started.status).toBe(202);
    await h.service.settled();
    // biome-ignore lint/suspicious/noExplicitAny: response body under test
    const retained = await h.service.store.readCapabilities((started.body as any).run.runId);
    expect(retained?.snapshot.agents).toEqual([]);
    expect(retained?.snapshot.tools).toEqual([]);
    expect([h.witness('synthetic'), h.witness('other')]).toEqual([
      { spawns: 0, lists: 0, calls: 0 },
      { spawns: 0, lists: 0, calls: 0 },
    ]);
  });
});
