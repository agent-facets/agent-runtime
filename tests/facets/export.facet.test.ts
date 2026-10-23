// Public-export gate (design Decision 11, gate 1): the pinned facet CLI and the runtime adapter install CLI-authored
// synthetic facets into isolated homes, and the sealer and runtime loader accept exactly what was recorded. Server
// declarations are joined to every facet that declares them through the lockfile's public server inventory. No
// model, tool or declared server is ever run.
import { beforeAll, describe, expect, test } from 'bun:test';
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { canonicalJson } from '../../packages/facet-adapter/src/canonical.ts';
import { foreignAdapters, runtimeFacetDir, UsageError } from '../../packages/facet-adapter/src/cli.ts';
import {
  exportAssetPath,
  exportRecordSchema,
  exportServersPath,
} from '../../packages/facet-adapter/src/export-record.ts';
import { SealError, sealInstallation } from '../../packages/facet-adapter/src/seal.ts';
import { type CliIdentity, verifyPinnedCli } from '../../packages/facet-adapter/src/toolchain.ts';
import { loadInstallation } from '../../packages/runtime/src/capabilities/installation.ts';
import {
  FacetSandbox,
  fixtureFacets,
  requireFacetFixture,
  runtimeAdapterDir,
  tree,
  writeManifest,
} from '../support/facet-fixture.ts';

const sandbox = new FacetSandbox(requireFacetFixture(process.env));
const repoRoot = resolve(import.meta.dir, '..', '..');
const rootEditorInputs = ['facets.json', 'facets.lock'].map((file) => join(repoRoot, file));
const rootBefore = rootEditorInputs.map((file) => (existsSync(file) ? readFileSync(file).toString('base64') : null));
let cli: CliIdentity;
let editorAdapterDir: string;

beforeAll(async () => {
  cli = await verifyPinnedCli(sandbox.fixture.cli);
  editorAdapterDir = sandbox.dir('editor-adapter');
  const built = await Bun.build({
    entrypoints: [join(repoRoot, 'packages', 'facet-adapter', 'test-support', 'editor-adapter.ts')],
    outdir: editorAdapterDir,
    naming: 'index.mjs',
    target: 'bun',
    format: 'esm',
  });
  if (!built.success) throw new Error('could not build the editor test adapter');
  writeFileSync(
    join(editorAdapterDir, 'package.json'),
    JSON.stringify({
      name: 'editor-test-adapter',
      private: true,
      type: 'module',
      main: './index.mjs',
      facetAdapterApiVersion: '0.3',
    }),
  );
});

const runtimeHome = (label: string) => sandbox.home(label, [runtimeAdapterDir]);
const install = (project: string, home: string, args: string[] = []) =>
  sandbox.expectFacet(['install', ...args], { cwd: project, home });
const seal = (project: string, home: string) => sealInstallation({ projectDir: project, facetDir: home, cli });
const readExport = (project: string, kind: string, name: string) =>
  exportRecordSchema.parse(JSON.parse(readFileSync(exportAssetPath(project, kind, name), 'utf8')));
const sealRefusal = (project: string, home: string) => {
  try {
    seal(project, home);
  } catch (error) {
    if (error instanceof SealError) return error.reason;
    throw error;
  }
  return 'sealed';
};
const lockOf = (project: string) =>
  JSON.parse(readFileSync(join(project, 'facets.lock'), 'utf8')) as {
    lockfileVersion: number;
    facets: Record<string, { integrity: string; servers: unknown[] }>;
  };
const serverOrigin = (project: string, facet: string, authoredName = 'repo-tools') => ({
  facet,
  version: '1.0.0',
  source: `local:./facets/${facet}`,
  integrity: lockOf(project).facets[facet]?.integrity as string,
  authoredName,
});
const repoTools = {
  type: 'stdio' as const,
  command: './never-run.sh',
  args: ['--fixture'],
  env: { FIXTURE_MODE: 'synthetic' },
};
const ids = (load: ReturnType<typeof loadInstallation>) => {
  if (load.kind !== 'ready') throw new Error(`catalog unavailable: ${load.reason}`);
  return Object.fromEntries(
    load.catalog.contributions.map((c) => [c.id, c.availability.kind === 'ready' ? 'ready' : c.availability.reason]),
  );
};

describe('fixture facets', () => {
  test('every fixture manifest passes facet build --verify', async () => {
    for (const facet of ['rt-workflows', 'rt-collide', 'rt-servers', 'rt-servers-twin', 'rt-servers-conflict']) {
      const result = await sandbox.expectFacet(['build', '--verify', '--json'], {
        cwd: join(fixtureFacets, facet),
        home: sandbox.dir('verify-home'),
      });
      expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, verified: true });
    }
  });
});

describe('runtime installation and sealing', () => {
  test('installs, exports and seals text assets the runtime catalog accepts, recording the pinned toolchain', async () => {
    const home = await runtimeHome('runtime');
    const project = sandbox.project('runtime', ['rt-workflows']);
    await install(project, home);

    expect(readExport(project, 'command', 'triage')).toMatchObject({
      state: 'ready',
      body: 'Triage this synthetic report: $ARGUMENTS\n\nLoad the review skill, then delegate one question to the scout agent.\n',
      runtime: { arguments: { required: true } },
    });
    expect(readExport(project, 'command', 'legacy')).toMatchObject({
      state: 'refused',
      reason: 'unsupported_field',
      fields: ['model'],
    });
    expect(readExport(project, 'command', 'plain')).toMatchObject({
      state: 'refused',
      reason: 'runtime_metadata_missing',
    });
    const review = readExport(project, 'skill', 'review');
    if (review.state !== 'ready') throw new Error('expected a ready skill');
    const sample = review.companions.find((companion) => companion.path === 'assets/sample.bin');
    expect(Buffer.from(sample?.content ?? '', 'base64')).toEqual(
      readFileSync(join(fixtureFacets, 'rt-workflows', 'skills', 'review', 'assets', 'sample.bin')),
    );

    const sealed = seal(project, home);
    expect(sealed.installation.toolchain.cli).toEqual({
      version: '0.36.0',
      platform: 'linux-x64',
      sha256: 'c7b781b1a7cac5ce459cccb41da4ad12d0e6545d5cc6381a18a90706feb8451a',
    });
    expect(lockOf(project).lockfileVersion).toBe(0.4);
    expect(sealed.installation.inputs.lockfileVersion).toBe(0.4);
    expect(sealed.installation.toolchain.adapter.sha256).toBe(
      new Bun.CryptoHasher('sha256').update(readFileSync(join(runtimeAdapterDir, 'index.mjs'))).digest('hex'),
    );
    expect(ids(loadInstallation(sealed.bytes, sealed.sha256))).toEqual({
      'command:triage': 'ready',
      'command:legacy': 'unsupported_field',
      'command:plain': 'runtime_metadata_missing',
      'skill:review': 'ready',
      'skill:scratch': 'ready',
      'agent:scout': 'ready',
    });
    expect(existsSync(join(project, 'server-was-run'))).toBe(false);
  });

  test('a repeated install changes nothing and an altered bundle is refused by the runtime', async () => {
    const home = await runtimeHome('repeat');
    const project = sandbox.project('repeat', ['rt-workflows']);
    await install(project, home);
    const before = tree(project);
    await install(project, home);
    expect(tree(project)).toEqual(before);

    const sealed = seal(project, home);
    const altered = Buffer.from(sealed.bytes);
    altered[altered.indexOf('Triage')] = 'X'.charCodeAt(0);
    expect(loadInstallation(altered, sealed.sha256)).toEqual({
      kind: 'unavailable',
      reason: 'installation_digest_mismatch',
    });
    const repinned = new Bun.CryptoHasher('sha256').update(altered).digest('hex');
    expect(loadInstallation(altered, repinned).kind).toBe('ready');
    const reformatted = Buffer.from(JSON.stringify(JSON.parse(Buffer.from(sealed.bytes).toString()), null, 1));
    const reformattedPin = new Bun.CryptoHasher('sha256').update(reformatted).digest('hex');
    expect(loadInstallation(reformatted, reformattedPin)).toEqual({
      kind: 'unavailable',
      reason: 'installation_not_canonical',
    });
  });

  test('aliases, omissions and cross-facet references follow the recorded choices; collisions need a choice', async () => {
    const home = await runtimeHome('aliases');
    const project = sandbox.project('aliases', ['rt-workflows', 'rt-collide']);
    const before = tree(project);
    const collision = await sandbox.facet(['install'], { cwd: project, home });
    expect(collision.code).not.toBe(0);
    expect(`${collision.stderr}${collision.stdout}`).toContain('MATERIALIZATION_COLLISION');
    expect(tree(project)).toEqual(before);

    writeManifest(project, ['rt-workflows', 'rt-collide'], {
      'rt-collide': { commands: { triage: { kind: 'aliased', as: 'collide-triage' } } },
      'rt-workflows': { skills: { scratch: { kind: 'omitted' } } },
    });
    await install(project, home);
    expect(existsSync(exportAssetPath(project, 'command', 'collide-triage'))).toBe(true);
    expect(existsSync(exportAssetPath(project, 'skill', 'scratch'))).toBe(false);

    const sealed = seal(project, home);
    const items = sealed.installation.items;
    const aliased = items.find((item) => item.facet === 'rt-collide' && item.authoredName === 'triage');
    expect(aliased?.materialization).toEqual({ kind: 'aliased', as: 'collide-triage' });
    expect(aliased?.files.map((file) => file.path)).toEqual(['commands/triage.md']);
    expect(aliased?.state.kind === 'ready' && aliased.state.definition.requires).toEqual([
      { kind: 'skill', id: 'skill:review' },
    ]);
    expect(items.find((item) => item.authoredName === 'scratch')?.state).toEqual({ kind: 'omitted' });
    const catalog = ids(loadInstallation(sealed.bytes, sealed.sha256));
    expect(catalog['command:collide-triage']).toBe('ready');
    expect(catalog['skill:scratch']).toBeUndefined();
  });

  test('removing a facet removes exactly its exports', async () => {
    const home = await runtimeHome('removal');
    const project = sandbox.project('removal', ['rt-workflows', 'rt-collide'], {
      'rt-collide': { commands: { triage: { kind: 'aliased', as: 'collide-triage' } } },
    });
    await install(project, home);
    const kept = readFileSync(exportAssetPath(project, 'command', 'triage'));
    await sandbox.expectFacet(['remove', 'rt-collide'], { cwd: project, home });
    expect(existsSync(exportAssetPath(project, 'command', 'collide-triage'))).toBe(false);
    expect(existsSync(exportAssetPath(project, 'skill', 'notes'))).toBe(false);
    expect(readFileSync(exportAssetPath(project, 'command', 'triage'))).toEqual(kept);
    expect(seal(project, home).installation.facets.map((facet) => facet.facet)).toEqual(['rt-workflows']);
  });

  test('identical recorded inputs reproduce identical sealed bytes, including a frozen reinstall', async () => {
    const sealedIn = async (label: string, frozenFrom?: string) => {
      const home = await runtimeHome(label);
      const project = sandbox.project(label, ['rt-workflows']);
      if (frozenFrom !== undefined) cpSync(join(frozenFrom, 'facets.lock'), join(project, 'facets.lock'));
      await install(project, home, frozenFrom === undefined ? [] : ['--frozen-lockfile']);
      return { project, sealed: seal(project, home) };
    };
    const first = await sealedIn('reproduce-a');
    const second = await sealedIn('reproduce-b');
    const frozen = await sealedIn('reproduce-frozen', first.project);
    expect(Buffer.from(second.sealed.bytes).equals(Buffer.from(first.sealed.bytes))).toBe(true);
    expect(Buffer.from(frozen.sealed.bytes).equals(Buffer.from(first.sealed.bytes))).toBe(true);
    expect(frozen.sealed.sha256).toBe(first.sealed.sha256);
  });
});

describe('server declarations joined through the public server inventory', () => {
  const installServers = async (label: string, facets: string[], materialization: Record<string, unknown> = {}) => {
    const home = await runtimeHome(label);
    const project = sandbox.project(label, facets, materialization);
    await install(project, home, ['--accept-mcp']);
    return { home, project };
  };

  test('seals a server-only facet with its declaration joined to its originating facet', async () => {
    const home = await runtimeHome('server-only');
    const project = sandbox.project('server-only', ['rt-servers-twin']);
    const unapproved = await sandbox.facet(['install'], { cwd: project, home });
    expect(unapproved.code).not.toBe(0);
    expect(existsSync(exportServersPath(project))).toBe(false);

    await install(project, home, ['--accept-mcp']);
    expect(lockOf(project).facets['rt-servers-twin']?.servers).toEqual([
      {
        name: 'repo-tools',
        fingerprint: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
        materialization: { kind: 'authored' },
      },
    ]);
    const sealed = seal(project, home);
    expect(sealed.installation.items).toEqual([]);
    expect(sealed.installation.servers).toEqual([
      {
        serverId: 'repo-tools',
        fingerprint: (lockOf(project).facets['rt-servers-twin']?.servers[0] as { fingerprint: string }).fingerprint,
        declaration: repoTools,
        origins: [serverOrigin(project, 'rt-servers-twin')],
      },
    ]);
    const load = loadInstallation(sealed.bytes, sealed.sha256);
    expect(load.kind === 'ready' && load.catalog.installation.servers.map((server) => server.serverId)).toEqual([
      'repo-tools',
    ]);
    expect(existsSync(join(project, 'server-was-run'))).toBe(false);
  });

  test('retains every contributing origin of an identical deduplicated server declaration', async () => {
    const { home, project } = await installServers('dedup', ['rt-servers', 'rt-servers-twin']);
    expect(JSON.parse(readFileSync(exportServersPath(project), 'utf8'))).toEqual({
      format: 1,
      servers: { 'repo-tools': repoTools },
    });
    const sealed = seal(project, home);
    expect(sealed.installation.servers.map((server) => [server.serverId, server.origins])).toEqual([
      ['repo-tools', [serverOrigin(project, 'rt-servers'), serverOrigin(project, 'rt-servers-twin')]],
    ]);
    expect(ids(loadInstallation(sealed.bytes, sealed.sha256))).toEqual({ 'command:sync': 'ready' });
    expect(existsSync(join(project, 'server-was-run'))).toBe(false);
  });

  test('joins aliased and omitted server choices to their authored declarations', async () => {
    const home = await runtimeHome('server-choices');
    const project = sandbox.project('server-choices', ['rt-servers', 'rt-servers-conflict']);
    const before = tree(project);
    const collision = await sandbox.facet(['install', '--accept-mcp'], { cwd: project, home });
    expect(collision.code).not.toBe(0);
    expect(`${collision.stderr}${collision.stdout}`).toContain('MATERIALIZATION_COLLISION');
    expect(tree(project)).toEqual(before);

    writeManifest(project, ['rt-servers', 'rt-servers-conflict'], {
      'rt-servers-conflict': { servers: { 'repo-tools': { kind: 'aliased', as: 'other-tools' } } },
    });
    await install(project, home, ['--accept-mcp']);
    const aliased = seal(project, home);
    expect(aliased.installation.servers.map((server) => [server.serverId, server.origins])).toEqual([
      ['other-tools', [serverOrigin(project, 'rt-servers-conflict')]],
      ['repo-tools', [serverOrigin(project, 'rt-servers')]],
    ]);
    expect(aliased.installation.servers[0]?.declaration).toEqual({ ...repoTools, args: ['--other'] });

    writeManifest(project, ['rt-servers', 'rt-servers-conflict'], {
      'rt-servers': { servers: { 'repo-tools': { kind: 'omitted' } } },
    });
    await install(project, home, ['--accept-mcp']);
    expect(Object.keys(JSON.parse(readFileSync(exportServersPath(project), 'utf8')).servers)).toEqual(['repo-tools']);
    const omitted = seal(project, home);
    expect(omitted.installation.servers.map((server) => [server.serverId, server.origins])).toEqual([
      ['repo-tools', [serverOrigin(project, 'rt-servers-conflict')]],
    ]);
    expect(omitted.installation.omittedServers).toEqual([
      {
        facet: 'rt-servers',
        authoredName: 'repo-tools',
        fingerprint: (lockOf(project).facets['rt-servers']?.servers[0] as { fingerprint: string }).fingerprint,
      },
    ]);
    // The omitted declaration is not the one `sync` refers to, even though another facet's server now has its name.
    expect(ids(loadInstallation(omitted.bytes, omitted.sha256))).toEqual({ 'command:sync': 'prerequisite_omitted' });
  });

  test('refuses missing, extra or conflicting server records against the recorded installation', async () => {
    const { home, project } = await installServers('server-records', ['rt-servers']);
    const path = exportServersPath(project);
    const exported = readFileSync(path);
    const write = (servers: Record<string, unknown>) =>
      // Canonical bytes, so each tampered record reaches the record check rather than the encoding check.
      writeFileSync(path, `${canonicalJson({ format: 1, servers })}\n`);

    rmSync(path);
    expect(sealRefusal(project, home)).toBe('server_export_missing');
    write({ 'extra-tools': repoTools, 'repo-tools': repoTools });
    expect(sealRefusal(project, home)).toBe('server_export_unexpected');
    write({ 'repo-tools': { ...repoTools, args: ['--write'] } });
    expect(sealRefusal(project, home)).toBe('server_export_mismatch');
    writeFileSync(path, exported);

    // A server choice edited without reinstalling disagrees with what the lockfile recorded.
    writeManifest(project, ['rt-servers'], { 'rt-servers': { servers: { 'repo-tools': { kind: 'omitted' } } } });
    expect(sealRefusal(project, home)).toBe('inputs_disagree');
    writeManifest(project, ['rt-servers']);
    expect(sealRefusal(project, home)).toBe('sealed');
    expect(existsSync(join(project, 'server-was-run'))).toBe(false);
  });

  test('resolves authored MCP references through the verified server mapping', async () => {
    const { home, project } = await installServers('server-refs', ['rt-servers'], {
      'rt-servers': { servers: { 'repo-tools': { kind: 'aliased', as: 'fixture-tools' } } },
    });
    const sealed = seal(project, home);
    const sync = sealed.installation.items.find((item) => item.authoredName === 'sync');
    expect(sync?.state.kind === 'ready' && sync.state.definition.requires).toEqual([
      { kind: 'mcp', serverId: 'fixture-tools', toolName: 'list_items' },
    ]);
    expect(sealed.installation.servers.map((server) => server.serverId)).toEqual(['fixture-tools']);
    expect(ids(loadInstallation(sealed.bytes, sealed.sha256))).toEqual({ 'command:sync': 'ready' });
  });

  test('reproduces identical bytes and refuses an altered bundle for a server-bearing installation', async () => {
    const sealedIn = async (label: string, frozenFrom?: string) => {
      const home = await runtimeHome(label);
      const project = sandbox.project(label, ['rt-servers', 'rt-servers-twin']);
      if (frozenFrom !== undefined) cpSync(join(frozenFrom, 'facets.lock'), join(project, 'facets.lock'));
      await install(project, home, ['--accept-mcp', ...(frozenFrom === undefined ? [] : ['--frozen-lockfile'])]);
      return { project, sealed: seal(project, home) };
    };
    const first = await sealedIn('server-reproduce-a');
    const second = await sealedIn('server-reproduce-b');
    const frozen = await sealedIn('server-reproduce-frozen', first.project);
    expect(Buffer.from(second.sealed.bytes).equals(Buffer.from(first.sealed.bytes))).toBe(true);
    expect(Buffer.from(frozen.sealed.bytes).equals(Buffer.from(first.sealed.bytes))).toBe(true);

    const altered = Buffer.from(first.sealed.bytes);
    altered[altered.indexOf('--fixture')] = '+'.charCodeAt(0);
    expect(loadInstallation(altered, first.sealed.sha256)).toEqual({
      kind: 'unavailable',
      reason: 'installation_digest_mismatch',
    });
  });

  test('removing and reinstalling a declaring facet changes only its origin', async () => {
    const { home, project } = await installServers('server-removal', ['rt-servers', 'rt-servers-twin']);
    await sandbox.expectFacet(['remove', 'rt-servers-twin', '--accept-mcp'], { cwd: project, home });
    const removed = seal(project, home);
    expect(removed.installation.servers.map((server) => [server.serverId, server.origins])).toEqual([
      ['repo-tools', [serverOrigin(project, 'rt-servers')]],
    ]);
    expect(Object.keys(JSON.parse(readFileSync(exportServersPath(project), 'utf8')).servers)).toEqual(['repo-tools']);

    writeManifest(project, ['rt-servers', 'rt-servers-twin']);
    await install(project, home, ['--accept-mcp']);
    expect(seal(project, home).installation.servers[0]?.origins).toEqual([
      serverOrigin(project, 'rt-servers'),
      serverOrigin(project, 'rt-servers-twin'),
    ]);
    expect(existsSync(join(project, 'server-was-run'))).toBe(false);
  });
});

describe('runtime and editor installations stay separate', () => {
  test('neither installation writes into the other, in either direction', async () => {
    const runtime = {
      home: await runtimeHome('iso-runtime'),
      project: sandbox.project('iso-runtime', ['rt-workflows', 'rt-servers']),
    };
    const editor = {
      home: await sandbox.home('iso-editor', [editorAdapterDir]),
      project: sandbox.project('iso-editor', ['rt-workflows']),
    };
    const sides = [runtime.home, runtime.project, editor.home, editor.project];
    const snapshot = () => sides.map((dir) => tree(dir));

    const beforeRuntime = snapshot();
    await install(runtime.project, runtime.home, ['--accept-mcp']);
    const afterRuntime = snapshot();
    expect(afterRuntime[2]).toEqual(beforeRuntime[2]);
    expect(afterRuntime[3]).toEqual(beforeRuntime[3]);

    await install(editor.project, editor.home);
    const afterEditor = snapshot();
    expect(afterEditor[0]).toEqual(afterRuntime[0]);
    expect(afterEditor[1]).toEqual(afterRuntime[1]);

    expect(existsSync(join(runtime.project, '.editor-test'))).toBe(false);
    expect(existsSync(join(editor.project, '.agent-runtime-export'))).toBe(false);
    expect(existsSync(exportServersPath(runtime.project))).toBe(true);
    expect(existsSync(join(editor.project, '.editor-test', 'commands', 'triage.md'))).toBe(true);
    // Identical companion content in two legitimate installations is not a cross-write.
    const review = readExport(runtime.project, 'skill', 'review');
    const editorGuide = readFileSync(
      join(editor.project, '.editor-test', 'skills', 'review', 'references', 'guide.md'),
    );
    expect(review.state === 'ready' && Buffer.from(review.companions[1]?.content ?? '', 'base64')).toEqual(editorGuide);
    expect(existsSync(join(sandbox.fixture.scratch, 'home', '.facet'))).toBe(false);
    expect(rootEditorInputs.map((file) => (existsSync(file) ? readFileSync(file).toString('base64') : null))).toEqual(
      rootBefore,
    );
  });

  test('the selected home is the absolute FACET_DIR, whatever the working directory', async () => {
    const home = await runtimeHome('cwd');
    const lists = [];
    for (const cwd of [sandbox.dir('cwd-a'), sandbox.dir('cwd-b')]) {
      lists.push((await sandbox.expectFacet(['adapter', 'list'], { cwd, home })).stdout);
      expect(existsSync(join(cwd, '.facet'))).toBe(false);
    }
    expect(lists[0]).toContain('agent-runtime');
    expect(lists[1]).toBe(lists[0]);
    expect(runtimeFacetDir({ FACET_DIR: home })).toBe(home);
    expect(() => runtimeFacetDir({ FACET_DIR: 'relative/facet-home' })).toThrow(UsageError);
  });

  test('a runtime home that also holds another adapter is refused', async () => {
    const home = await sandbox.home('contaminated', [runtimeAdapterDir, editorAdapterDir]);
    expect(foreignAdapters(home)).toEqual(['editor-test']);
    const project = sandbox.project('contaminated', ['rt-workflows']);
    await install(project, home);
    expect(existsSync(join(project, '.editor-test'))).toBe(true);
    expect(sealRefusal(project, home)).toBe('facet_home_contaminated');
  });
});
