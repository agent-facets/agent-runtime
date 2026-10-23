// Interim public-export gate (tasks 6.6–6.7): the pinned facet CLI and the runtime adapter install CLI-authored
// synthetic facets into isolated homes, and the sealer and runtime loader accept exactly what was recorded. Server
// declarations are exported but not sealed while public server provenance is unavailable; the provenance-dependent
// witnesses are listed as explicit TODOs at the end and are not part of this interim gate.
import { beforeAll, describe, expect, test } from 'bun:test';
import { cpSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
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
const ids = (load: ReturnType<typeof loadInstallation>) => {
  if (load.kind !== 'ready') throw new Error(`catalog unavailable: ${load.reason}`);
  return Object.fromEntries(
    load.catalog.contributions.map((c) => [c.id, c.availability.kind === 'ready' ? 'ready' : c.availability.reason]),
  );
};

describe('fixture facets', () => {
  test('every fixture manifest passes facet build --verify', async () => {
    for (const facet of ['rt-workflows', 'rt-collide', 'rt-servers']) {
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
      version: '0.35.0',
      platform: 'linux-x64',
      sha256: 'd6590bb2c1af0119e2bdfcafbfc0dbafe98e6e9ef015ae524926e983fa9a2a46',
    });
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

describe('server declarations while provenance is unavailable', () => {
  test('raw declarations are exported, never launched, and a server-bearing installation is not sealed', async () => {
    const home = await runtimeHome('servers');
    const project = sandbox.project('servers', ['rt-workflows', 'rt-servers']);
    const unapproved = await sandbox.facet(['install'], { cwd: project, home });
    expect(unapproved.code).not.toBe(0);
    expect(existsSync(exportServersPath(project))).toBe(false);

    await install(project, home, ['--accept-mcp']);
    expect(JSON.parse(readFileSync(exportServersPath(project), 'utf8'))).toEqual({
      format: 1,
      servers: {
        'repo-tools': {
          type: 'stdio',
          command: './never-run.sh',
          args: ['--fixture'],
          env: { FIXTURE_MODE: 'synthetic' },
        },
      },
    });
    expect(sealRefusal(project, home)).toBe('server_provenance_unavailable');
    expect(existsSync(join(project, 'installation.json'))).toBe(false);
    expect(existsSync(join(project, 'server-was-run'))).toBe(false);
  });

  test('omitting the server leaves a sealable installation whose MCP reference stays refused', async () => {
    const home = await runtimeHome('servers-omitted');
    const project = sandbox.project('servers-omitted', ['rt-servers'], {
      'rt-servers': { servers: { 'repo-tools': { kind: 'omitted' } } },
    });
    await install(project, home);
    const sealed = seal(project, home);
    expect(sealed.installation.servers).toEqual([]);
    expect(ids(loadInstallation(sealed.bytes, sealed.sha256))).toEqual({
      'command:sync': 'server_provenance_unavailable',
    });
  });
});

describe('runtime and editor installations stay separate', () => {
  test('neither installation writes into the other, in either direction', async () => {
    const runtime = {
      home: await runtimeHome('iso-runtime'),
      project: sandbox.project('iso-runtime', ['rt-workflows']),
    };
    const editor = {
      home: await sandbox.home('iso-editor', [editorAdapterDir]),
      project: sandbox.project('iso-editor', ['rt-workflows']),
    };
    const sides = [runtime.home, runtime.project, editor.home, editor.project];
    const snapshot = () => sides.map((dir) => tree(dir));

    const beforeRuntime = snapshot();
    await install(runtime.project, runtime.home);
    const afterRuntime = snapshot();
    expect(afterRuntime[2]).toEqual(beforeRuntime[2]);
    expect(afterRuntime[3]).toEqual(beforeRuntime[3]);

    await install(editor.project, editor.home);
    const afterEditor = snapshot();
    expect(afterEditor[0]).toEqual(afterRuntime[0]);
    expect(afterEditor[1]).toEqual(afterRuntime[1]);

    expect(existsSync(join(runtime.project, '.editor-test'))).toBe(false);
    expect(existsSync(join(editor.project, '.agent-runtime-export'))).toBe(false);
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

describe('deferred until public server provenance exists', () => {
  // TODO UPSTREAM-SERVER-PROVENANCE: revisit 9.1; complete 10.1; verify 10.2. Each needs the lockfile to record which
  // facets contributed each server declaration; none may remain skipped at final verification.
  test.skip('seals a server-only facet with its declaration joined to its originating facet', () => {});
  test.skip('retains every contributing origin of an identical deduplicated server declaration', () => {});
  test.skip('joins aliased and omitted server choices to their authored declarations', () => {});
  test.skip('refuses missing, extra or conflicting server records against the recorded installation', () => {});
  test.skip('resolves authored MCP references through the verified server mapping', () => {});
  test.skip('reproduces identical bytes and refuses an altered bundle for a server-bearing installation', () => {});
});
