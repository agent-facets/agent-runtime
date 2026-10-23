import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { PlanAssetInstallRequest } from '@agent-facets/adapter';
import { assets } from './adapter.ts';
import { canonicalJson, sha256Hex } from './canonical.ts';
import { exportAssetPath, exportServersPath } from './export-record.ts';
import { type Installation, SealError, sealInstallation } from './seal.ts';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const cli = { version: '0.35.0', platform: 'linux-x64', sha256: 'a'.repeat(64) };
const fileHash = (text: string | Uint8Array) => `sha256:${sha256Hex(text)}`;

interface Asset {
  type: 'skill' | 'agent' | 'command';
  name: string;
  materialization?: { kind: 'authored' } | { kind: 'aliased'; as: string } | { kind: 'omitted' };
  primary: string;
  metadata?: Record<string, unknown>;
  companions?: Record<string, Uint8Array>;
}

const primaryPath = (asset: Asset) =>
  asset.type === 'skill' ? `skills/${asset.name}/SKILL.md` : `${asset.type}s/${asset.name}.md`;

/** A recorded installation as the CLI leaves it: manifest, lockfile, adapter home and the adapter's exports. */
async function installation(facets: Record<string, Asset[]>, adapters = ['agent-runtime']) {
  const root = mkdtempSync(join(tmpdir(), 'facet-seal-test-'));
  roots.push(root);
  const project = join(root, 'project');
  const facetDir = join(root, 'facet-home');
  mkdirSync(project);
  for (const name of adapters) {
    mkdirSync(join(facetDir, 'adapters', name, 'generations', 'gen-1'), { recursive: true });
    writeFileSync(
      join(facetDir, 'adapters', name, 'generations', 'gen-1', 'adapter.js'),
      `export default "${name}";\n`,
    );
    writeFileSync(
      join(facetDir, 'adapters', name, 'installation.json'),
      JSON.stringify({ schemaVersion: 1, activeGeneration: 'gen-1', apiVersion: '0.3', source: { kind: 'local' } }),
    );
  }
  const manifest: Record<string, unknown> = {};
  const lock: Record<string, unknown> = {};
  for (const [facet, entries] of Object.entries(facets)) {
    const overrides: Record<string, Record<string, unknown>> = {};
    for (const asset of entries) {
      if (asset.materialization !== undefined && asset.materialization.kind !== 'authored') {
        const group = `${asset.type}s`;
        overrides[group] = { ...overrides[group], [asset.name]: asset.materialization };
      }
    }
    manifest[facet] =
      Object.keys(overrides).length === 0
        ? `./facets/${facet}`
        : { source: `./facets/${facet}`, materialization: overrides };
    lock[facet] = {
      source: { kind: 'local', path: `./facets/${facet}` },
      version: '1.0.0',
      integrity: fileHash(facet),
      assets: entries.map((asset) => ({
        scope: 'project',
        type: asset.type,
        name: asset.name,
        materialization: asset.materialization ?? { kind: 'authored' },
        files: [
          { path: primaryPath(asset), integrity: fileHash(asset.primary) },
          ...Object.entries(asset.companions ?? {}).map(([path, bytes]) => ({
            path: `skills/${asset.name}/${path}`,
            integrity: fileHash(bytes),
          })),
        ].sort((a, b) => (a.path < b.path ? -1 : 1)),
      })),
    };
    for (const asset of entries) {
      const disposition = asset.materialization ?? { kind: 'authored' };
      if (disposition.kind === 'omitted') continue;
      const name = disposition.kind === 'aliased' ? disposition.as : asset.name;
      const request = {
        projectRoot: project,
        scope: 'project',
        assetType: asset.type,
        name,
        content: asset.primary,
        metadata: { name, description: `About ${asset.name}`, ...(asset.metadata ?? { runtimeVersion: 1 }) },
        ...(asset.type === 'skill' ? { companions: asset.companions ?? {}, ownedCompanionPaths: [] } : {}),
      } as PlanAssetInstallRequest;
      const planned = await assets.planInstall(request);
      if (!planned.ok || planned.plan.action.kind !== 'mutate') throw new Error('expected an export write');
      for (const mutation of planned.plan.action.mutations) {
        if (mutation.kind !== 'write') continue;
        mkdirSync(dirname(mutation.path), { recursive: true });
        writeFileSync(mutation.path, mutation.contents);
      }
    }
  }
  writeFileSync(
    join(project, 'facets.json'),
    `${JSON.stringify({ manifestVersion: 0.2, facets: manifest }, null, 2)}\n`,
  );
  writeFileSync(join(project, 'facets.lock'), `${JSON.stringify({ lockfileVersion: 0.3, facets: lock }, null, 2)}\n`);
  return { project, facetDir, seal: () => sealInstallation({ projectDir: project, facetDir, cli }) };
}

const demo = (): Record<string, Asset[]> => ({
  demo: [
    {
      type: 'command',
      name: 'run',
      primary: '---\nagent: build\n---\nRun $ARGUMENTS.\n',
      metadata: { runtimeVersion: 1, requires: [{ kind: 'skill', name: 'guide' }] },
    },
    {
      type: 'skill',
      name: 'guide',
      primary: '# Guide\n',
      companions: { 'refs/a.md': new TextEncoder().encode('alpha\n'), 'b.bin': new Uint8Array([0, 1, 2]) },
    },
    { type: 'agent', name: 'helper', primary: 'Help.\n', materialization: { kind: 'aliased', as: 'demo-helper' } },
    { type: 'skill', name: 'unused', primary: '# Unused\n', materialization: { kind: 'omitted' } },
  ],
});

const refusal = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    if (error instanceof SealError) return error.reason;
    throw error;
  }
  throw new Error('expected the seal to be refused');
};
const stateOf = (sealed: { installation: Installation }, kind: string, name: string) =>
  sealed.installation.items.find((item) => item.kind === kind && item.authoredName === name)?.state;

describe('text-asset sealing', () => {
  test('joins exports to recorded names, aliases and omissions with source and export integrity kept apart', async () => {
    const fixture = await installation(demo());
    const sealed = fixture.seal();
    const { installation: bundle } = sealed;
    expect(bundle.toolchain.cli).toEqual(cli);
    expect(bundle.toolchain.adapter).toEqual({
      name: 'agent-runtime',
      apiVersion: '0.3',
      sdkVersion: '0.30.0',
      sha256: sha256Hex('export default "agent-runtime";\n'),
    });
    expect(bundle.inputs.lockSha256).toBe(sha256Hex(readFileSync(join(fixture.project, 'facets.lock'))));
    expect(bundle.servers).toEqual([]);
    expect(stateOf(sealed, 'skill', 'unused')).toEqual({ kind: 'omitted' });

    const run = bundle.items.find((item) => item.authoredName === 'run');
    if (run?.state.kind !== 'ready') throw new Error('expected a ready command');
    const definition = run.state.definition as {
      body: string;
      exportDigest: string;
      requires: unknown;
      origins: unknown;
    };
    expect(definition.body).toBe('Run $ARGUMENTS.\n');
    expect(definition.requires).toEqual([{ kind: 'skill', id: 'skill:guide' }]);
    expect(definition.origins).toEqual([
      { facet: 'demo', version: '1.0.0', source: 'local:./facets/demo', integrity: fileHash('demo') },
    ]);
    // The source hash of the authored primary and the digest of its transformed export are distinct facts.
    expect(run.files).toEqual([
      { path: 'commands/run.md', integrity: fileHash('---\nagent: build\n---\nRun $ARGUMENTS.\n') },
    ]);
    expect(definition.exportDigest).toBe(sha256Hex(readFileSync(exportAssetPath(fixture.project, 'command', 'run'))));

    const helper = stateOf(sealed, 'agent', 'helper');
    expect(helper?.kind === 'ready' && helper.definition.id).toBe('agent:demo-helper');
    const guide = stateOf(sealed, 'skill', 'guide');
    if (guide?.kind !== 'ready' || !('resources' in guide.definition)) throw new Error('expected a ready skill');
    expect(
      guide.definition.resources.map((resource) => [resource.path, Buffer.from(resource.content, 'base64')]),
    ).toEqual([
      ['b.bin', Buffer.from([0, 1, 2])],
      ['refs/a.md', Buffer.from('alpha\n')],
    ]);
  });

  test('identical recorded inputs give identical bytes, with no digest of the bundle inside it', async () => {
    const first = (await installation(demo())).seal();
    const second = (await installation(demo())).seal();
    expect(Buffer.from(first.bytes).equals(Buffer.from(second.bytes))).toBe(true);
    expect(first.sha256).toBe(sha256Hex(first.bytes));
    expect(new TextDecoder().decode(first.bytes)).toBe(`${canonicalJson(first.installation)}\n`);
    expect(new TextDecoder().decode(first.bytes)).not.toContain(first.sha256);
  });

  test('refuses missing, extra, mismatched or non-canonical export records', async () => {
    const missing = await installation(demo());
    rmSync(exportAssetPath(missing.project, 'agent', 'demo-helper'));
    expect(refusal(missing.seal)).toBe('export_missing');

    const extra = await installation(demo());
    const stray = exportAssetPath(extra.project, 'skill', 'unused');
    writeFileSync(
      stray,
      readFileSync(exportAssetPath(extra.project, 'skill', 'guide'))
        .toString()
        .replace('"guide"', '"unused"'),
    );
    expect(refusal(extra.seal)).toBe('export_unexpected');

    const renamed = await installation(demo());
    writeFileSync(
      exportAssetPath(renamed.project, 'command', 'other'),
      readFileSync(exportAssetPath(renamed.project, 'command', 'run')),
    );
    expect(refusal(renamed.seal)).toBe('export_mismatch');

    const reformatted = await installation(demo());
    const path = exportAssetPath(reformatted.project, 'command', 'run');
    writeFileSync(path, JSON.stringify(JSON.parse(readFileSync(path, 'utf8')), null, 2));
    expect(refusal(reformatted.seal)).toBe('export_invalid');
  });

  test('refuses companions that differ from the recorded files', async () => {
    for (const tamper of [
      (record: { companions: { path: string; content: string; sha256: string }[] }) => {
        record.companions = record.companions.slice(1);
      },
      (record: { companions: { path: string; content: string; sha256: string }[] }) => {
        const bytes = Buffer.from('ALPHA\n');
        const [, second] = record.companions;
        if (second === undefined) throw new Error('fixture');
        second.content = bytes.toString('base64');
        second.sha256 = sha256Hex(bytes);
      },
    ]) {
      const fixture = await installation(demo());
      const path = exportAssetPath(fixture.project, 'skill', 'guide');
      const record = JSON.parse(readFileSync(path, 'utf8'));
      tamper(record);
      writeFileSync(path, `${canonicalJson(record)}\n`);
      expect(refusal(fixture.seal)).toBe('export_mismatch');
    }
  });

  test('refuses manifest and lockfile disagreement, unsupported versions and colliding names', async () => {
    const edited = await installation(demo());
    const manifestPath = join(edited.project, 'facets.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    manifest.facets.demo.materialization.agents.helper.as = 'renamed';
    writeFileSync(manifestPath, JSON.stringify(manifest));
    expect(refusal(edited.seal)).toBe('inputs_disagree');

    const old = await installation(demo());
    const lockPath = join(old.project, 'facets.lock');
    writeFileSync(lockPath, readFileSync(lockPath, 'utf8').replace('"lockfileVersion": 0.3', '"lockfileVersion": 0.2'));
    expect(refusal(old.seal)).toBe('input_version_unsupported');

    const commented = await installation(demo());
    writeFileSync(
      join(commented.project, 'facets.json'),
      `// note\n${readFileSync(join(commented.project, 'facets.json'), 'utf8')}`,
    );
    expect(refusal(commented.seal)).toBe('input_unreadable');

    const collision = await installation({
      a: [{ type: 'skill', name: 'shared', primary: '# A\n' }],
      b: [{ type: 'command', name: 'shared', primary: 'B\n' }],
    });
    expect(refusal(collision.seal)).toBe('namespace_collision');
  });

  test('refuses a facet home shared with another adapter', async () => {
    const fixture = await installation(demo(), ['agent-runtime', 'opencode']);
    expect(refusal(fixture.seal)).toBe('facet_home_contaminated');
  });

  test('keeps refusals contribution-local, including bounds the runtime cannot accept', async () => {
    const sealed = (
      await installation({
        demo: [
          { type: 'command', name: 'ok', primary: 'Fine.\n' },
          { type: 'command', name: 'huge', primary: 'x'.repeat(8193) },
          { type: 'command', name: 'unsupported', primary: 'x', metadata: { runtimeVersion: 1, model: 'other' } },
          {
            type: 'command',
            name: 'depends',
            primary: 'x',
            metadata: { runtimeVersion: 1, requires: [{ kind: 'skill', name: 'blank' }] },
          },
          { type: 'skill', name: 'blank', primary: '   \n' },
        ],
      })
    ).seal();
    expect(stateOf(sealed, 'command', 'ok')?.kind).toBe('ready');
    expect(stateOf(sealed, 'command', 'huge')).toEqual({
      kind: 'refused',
      reason: 'definition_too_large',
      fields: ['body'],
    });
    expect(stateOf(sealed, 'command', 'unsupported')).toEqual({
      kind: 'refused',
      reason: 'unsupported_field',
      fields: ['model'],
    });
    expect(stateOf(sealed, 'skill', 'blank')).toEqual({
      kind: 'refused',
      reason: 'body_unsupported',
      fields: ['body'],
    });
    expect(stateOf(sealed, 'command', 'depends')).toEqual({
      kind: 'refused',
      reason: 'prerequisite_refused',
      subject: 'skill:blank',
      fields: ['requires'],
    });
  });

  test('refuses server-bearing installations without inventing origins or dropping servers', async () => {
    // TODO UPSTREAM-SERVER-PROVENANCE: revisit 9.1; complete 10.1; verify 10.2 (the complete server join).
    const fixture = await installation(demo());
    writeFileSync(
      exportServersPath(fixture.project),
      `${canonicalJson({ format: 1, servers: { tools: { type: 'stdio', command: 'bun', args: [], env: {} } } })}\n`,
    );
    expect(refusal(fixture.seal)).toBe('server_provenance_unavailable');
    writeFileSync(exportServersPath(fixture.project), `${canonicalJson({ format: 1, servers: {} })}\n`);
    expect(fixture.seal().installation.servers).toEqual([]);
  });
});
