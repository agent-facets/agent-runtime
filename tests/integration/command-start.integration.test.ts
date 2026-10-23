// Command starts through the production run service (design Decisions 6 and 9): a new command start is checked
// against the current installation, providers, workspace and required-tool preflight; a retried request is resolved
// by its normalized submission before any of them, so a lost acknowledgement can always be retried — after the
// installation changed or vanished, or a provider or MCP server became unavailable — without new model work or
// preflight. The model network, catalog reads and preflight calls are independent witnesses. Inputs are synthetic.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { StartRunRequest } from '../../packages/contracts/src/index.ts';
import { selectionRevision } from '../../packages/runtime/src/capabilities/command.ts';
import { type CatalogLoad, loadInstallation } from '../../packages/runtime/src/capabilities/installation.ts';
import { NO_BOUND_TOOLS } from '../../packages/runtime/src/capabilities/snapshot.ts';
import { parseOperatorConfig } from '../../packages/runtime/src/config/operator.ts';
import { CredentialStore } from '../../packages/runtime/src/credentials/store.ts';
import { openPersistence, type Persistence } from '../../packages/runtime/src/persistence/persistence.ts';
import { createProviderAssembly } from '../../packages/runtime/src/providers/assembly.ts';
import { canonicalJson } from '../../packages/runtime/src/records/canonical.ts';
import { RunStore } from '../../packages/runtime/src/records/run-store.ts';
import { type McpPreflight, RunService } from '../../packages/runtime/src/service/runs.ts';
import { createFixture } from '../../packages/runtime/test-support/workspace.ts';
import { inferenceNetwork, sse, textTurn } from '../support/anthropic-network.ts';
import { createScratchDatabase, type ScratchDatabase } from '../support/scratch-database.ts';

let db: ScratchDatabase;
let persistence: Persistence;
const fixture = createFixture();
fixture.write('notes/plan.md', 'alpha\n');
const scratch = mkdtempSync(join(tmpdir(), 'agent-runtime-command-start-'));
beforeAll(async () => {
  db = await createScratchDatabase();
  persistence = await openPersistence({ url: db.url, onFault: () => {} });
});
afterAll(async () => {
  await persistence.close();
  await db.drop();
  fixture.cleanup();
  rmSync(scratch, { recursive: true, force: true });
});

const D = 'd'.repeat(64);
const integrity = `sha256:${'f'.repeat(64)}`;
const origin = { facet: 'workflows', version: '1.0.0', source: 'local:./facets/workflows', integrity };
const ACCESS = 'sk-ant-oat01-command-start-access-0001';
const SECRET = 'sk-ant-oat01-command-start-access-0001';
let counter = 0;

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
/** The installation; `review: 'refused'` seals the skill `command:triage` requires as an unsupported contribution. */
function bundle(body: string, review: 'ready' | 'refused' = 'ready'): Uint8Array {
  const skill = definition('skill', 'review', { instructions: 'Review carefully.', resources: [] });
  return new TextEncoder().encode(
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
        definition('command', 'triage', {
          body,
          arguments: { required: true },
          requires: [{ kind: 'skill', id: 'skill:review' }],
        }),
        review === 'ready'
          ? skill
          : { ...skill, state: { kind: 'refused', reason: 'unsupported_field', fields: ['model'] } },
        definition('command', 'plain', { body: 'Summarize notes/plan.md.', arguments: { required: false } }),
      ],
      servers: [],
      omittedServers: [],
    })}\n`,
  );
}
const sha = (bytes: Uint8Array) => new Bun.CryptoHasher('sha256').update(bytes).digest('hex');

async function harness(options: { preflight?: McpPreflight } = {}) {
  const base = join(scratch, `case-${++counter}`);
  const stateDir = join(base, 'state');
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const configFile = join(base, 'config.json');
  const source = JSON.stringify({
    version: 1,
    workspace: { id: 'main', label: 'Main workspace', root: fixture.root },
    providers: {
      anthropic: { authMode: 'subscription', model: 'claude-opus-5', profileId: 'claude-cli-2.1.280' },
      openai: { authMode: 'subscription', model: 'gpt-5.6-sol', profileId: 'codex-responses-v1' },
    },
    defaultProvider: 'anthropic',
    stepBudget: 10,
    capabilities: {
      installation: { path: join(base, 'installation.json'), sha256: D },
      allowSkills: ['skill:review'],
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
    accessToken: ACCESS,
    refreshToken: 'sk-ant-ort01-command-start-refresh-0001',
    expiresAtMs: Date.now() + 3_600_000,
    account: {},
  });
  await CredentialStore.forStateDir(stateDir).replace({
    version: 1,
    provider: 'openai',
    authMode: 'subscription',
    slot: 'default',
    generation: 2,
    updatedAtMs: Date.now(),
    lifecycle: 'usable',
    accessToken: 'synthetic-command-start-openai-access',
    refreshToken: 'synthetic-command-start-openai-refresh',
    expiresAtMs: Date.now() + 3_600_000,
    account: { accountId: 'acct_command_start' },
  });
  const net = inferenceNetwork([() => sse(textTurn('msg_done', 'Triaged.'))]);
  const installed = { bytes: bundle('Triage $ARGUMENTS.') as Uint8Array | undefined };
  const counts = { catalog: 0, preflight: 0 };
  const service = new RunService({
    operator,
    locations: { stateDir, configFile },
    persistence,
    assembly: createProviderAssembly({ config: operator, stateDir, inferenceTransport: net.fetchImpl }),
    failStop: () => {},
    store: new RunStore(persistence.app, persistence.ownership),
    catalog: async (): Promise<CatalogLoad> => {
      counts.catalog++;
      return installed.bytes === undefined
        ? { kind: 'unavailable', reason: 'installation_missing' }
        : loadInstallation(installed.bytes, sha(installed.bytes));
    },
    preflight: async (input) => {
      counts.preflight++;
      return (options.preflight ?? (async () => ({ ok: true as const, bound: NO_BOUND_TOOLS })))(input);
    },
  });
  const revision = () => selectionRevision(sha(installed.bytes as Uint8Array), 'command:triage');
  const start = (requestId: string, args: string, rev = revision()) =>
    service.createRun({
      kind: 'command',
      requestId,
      provider: 'anthropic',
      command: { id: 'command:triage', selectionRevision: rev, arguments: args },
    } satisfies StartRunRequest);
  return { service, net, installed, counts, revision, start, stateDir };
}

// biome-ignore lint/suspicious/noExplicitAny: response bodies under test
const errorOf = (result: { status: number; body: any }) => [result.status, result.body.error?.code];

describe('command starts', () => {
  test('a command start renders its goal, retains its definitions and runs once', async () => {
    const h = await harness();
    const started = await h.start(crypto.randomUUID(), 'owner/repo-a');
    expect(started.status).toBe(202);
    // biome-ignore lint/suspicious/noExplicitAny: response body under test
    const run = (started.body as any).run;
    expect(run.goal).toBe('Triage owner/repo-a.');
    await h.service.settled();
    const done = await h.service.detail(run.runId);
    // biome-ignore lint/suspicious/noExplicitAny: response body under test
    expect((done.body as any).run.state.kind).toBe('succeeded');
    expect(h.net.sent).toHaveLength(1);
    const capabilities = await h.service.store.readCapabilities(run.runId);
    expect(capabilities?.input).toMatchObject({ commandId: 'command:triage', arguments: 'owner/repo-a' });
    expect(capabilities?.snapshot.skills.map((skill) => skill.id)).toEqual(['skill:review']);
    expect(h.counts).toEqual({ catalog: 1, preflight: 1 });
  });

  test('a retried request returns the original run after updates, removal and outages, with no new work', async () => {
    const h = await harness();
    const requestId = crypto.randomUUID();
    const first = await h.start(requestId, 'owner/repo-a');
    expect(first.status).toBe(202);
    const revision = h.revision();
    await h.service.settled();
    const before = { ...h.counts, sent: h.net.sent.length };

    const retried: number[] = [];
    // The installation is updated, then removed; the provider credential is removed; preflight would fail.
    h.installed.bytes = bundle('Triage $ARGUMENTS differently.');
    retried.push((await h.start(requestId, 'owner/repo-a', revision)).status);
    h.installed.bytes = undefined;
    retried.push((await h.start(requestId, 'owner/repo-a', revision)).status);
    rmSync(join(h.stateDir, 'credentials'), { recursive: true, force: true });
    retried.push((await h.start(requestId, 'owner/repo-a', revision)).status);
    expect(retried).toEqual([200, 200, 200]);
    await h.service.settled();
    expect({ ...h.counts, sent: h.net.sent.length }).toEqual(before);

    // The same request ID with different input is a conflict, also decided before any current check.
    expect(errorOf(await h.start(requestId, 'owner/repo-b', revision))).toEqual([409, 'request_conflict']);
    expect(
      errorOf(await h.service.createRun({ requestId, goal: 'Triage owner/repo-a.', provider: 'anthropic' })),
    ).toEqual([409, 'request_conflict']);
    expect(h.counts).toEqual({ catalog: before.catalog, preflight: before.preflight });
  });

  test('a fresh start against a changed installation is refused without starting anything', async () => {
    const h = await harness();
    const stale = h.revision();
    h.installed.bytes = bundle('Triage $ARGUMENTS differently.');
    const requestId = crypto.randomUUID();
    const refused = await h.start(requestId, 'owner/repo-a', stale);
    // biome-ignore lint/suspicious/noExplicitAny: response body under test
    expect((refused.body as any).error).toMatchObject({
      code: 'capability_selection_changed',
      acceptance: 'not_accepted',
      subject: 'command:triage',
    });
    expect(await h.service.store.findCreation(requestId)).toBeUndefined();
    expect(h.counts.preflight).toBe(0);
    // Under the current revision the same arguments start normally.
    expect((await h.start(crypto.randomUUID(), 'owner/repo-a')).status).toBe(202);
    await h.service.settled();
    expect(h.net.sent).toHaveLength(1);
  });

  test('refusals never fall back to a free-form goal and dispatch nothing', async () => {
    const h = await harness({
      preflight: async () => ({ ok: false, code: 'mcp_server_unavailable', reason: 'connection_timeout' }),
    });
    const ids = Array.from({ length: 4 }, () => crypto.randomUUID());
    const cases = [
      ['blank arguments', await h.start(ids[0] as string, '   ')],
      ['secret arguments', await h.start(ids[1] as string, `use ${SECRET}`)],
      ['preflight outage', await h.start(ids[2] as string, 'owner/repo-a')],
    ] as const;
    expect(cases.map(([label, result]) => [label, ...errorOf(result)])).toEqual([
      ['blank arguments', 400, 'command_arguments_invalid'],
      ['secret arguments', 400, 'credential_in_input'],
      ['preflight outage', 503, 'mcp_server_unavailable'],
    ]);
    expect(JSON.stringify(cases)).not.toContain(SECRET);
    h.installed.bytes = undefined;
    expect(errorOf(await h.start(ids[3] as string, 'owner/repo-a', D))).toEqual([503, 'capabilities_unavailable']);
    await h.service.settled();
    expect(h.net.sent).toEqual([]);
    for (const requestId of ids) expect(await h.service.store.findCreation(requestId)).toBeUndefined();
  });

  test('a command whose declared prerequisite is refused starts nothing; an unrelated command still starts', async () => {
    const h = await harness();
    h.installed.bytes = bundle('Triage $ARGUMENTS.', 'refused');
    const requestId = crypto.randomUUID();
    const refused = await h.start(requestId, 'owner/repo-a');
    // biome-ignore lint/suspicious/noExplicitAny: response body under test
    expect([refused.status, (refused.body as any).error]).toEqual([
      409,
      // The refusal names the prerequisite that is unavailable.
      expect.objectContaining({
        code: 'capability_unavailable',
        acceptance: 'not_accepted',
        subject: 'skill:review',
      }),
    ]);
    expect(await h.service.store.findCreation(requestId)).toBeUndefined();
    expect(h.counts.preflight).toBe(0);
    const plain = await h.service.createRun({
      kind: 'command',
      requestId: crypto.randomUUID(),
      provider: 'anthropic',
      command: {
        id: 'command:plain',
        selectionRevision: selectionRevision(sha(h.installed.bytes), 'command:plain'),
        arguments: '',
      },
    });
    expect(plain.status).toBe(202);
    await h.service.settled();
    // Only the unrelated command reached the model.
    expect(h.net.sent).toHaveLength(1);
  });

  test('a configured catalog leaves goal runs with exactly the three native tools under both providers', async () => {
    const h = await harness();
    for (const provider of ['anthropic', 'openai'] as const) {
      const started = await h.service.createRun({
        requestId: crypto.randomUUID(),
        goal: 'Summarize notes/plan.md.',
        provider,
      });
      expect(started.status).toBe(202);
      // biome-ignore lint/suspicious/noExplicitAny: response body under test
      const runId = (started.body as any).run.runId as string;
      const [stored] = await db.admin`select d.manifest from runtime.runs r
        join runtime.execution_definitions d on d.digest = r.definition_digest where r.run_id = ${runId}`;
      const manifest = stored?.manifest as { tools: { name: string }[]; capabilities?: unknown };
      expect([provider, manifest.tools.map((tool) => tool.name)]).toEqual([
        provider,
        ['mcp_AskUser', 'mcp_Read', 'mcp_Search'],
      ]);
      expect(manifest.capabilities).toBeUndefined();
      expect(await h.service.store.readCapabilities(runId)).toBeUndefined();
    }
    await h.service.settled();
    // Goal starts never read the catalog or run a preflight.
    expect(h.counts).toEqual({ catalog: 0, preflight: 0 });
  });
});
