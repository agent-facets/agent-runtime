import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { PlanAssetInstallRequest } from '@agent-facets/adapter';
import { computeMcpServerFingerprint } from '@agent-facets/protocol';
import { assets } from './adapter.ts';
import { canonicalJson, sha256Hex } from './canonical.ts';
import { exportAssetPath, exportServersPath } from './export-record.ts';
import { type Installation, SealError, sealInstallation } from './seal.ts';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const cli = { version: '0.36.0', platform: 'linux-x64', sha256: 'a'.repeat(64) };
const fileHash = (text: string | Uint8Array) => `sha256:${sha256Hex(text)}`;

interface Asset {
  type: 'skill' | 'agent' | 'command';
  name: string;
  materialization?: { kind: 'authored' } | { kind: 'aliased'; as: string } | { kind: 'omitted' };
  primary: string;
  metadata?: Record<string, unknown>;
  companions?: Record<string, Uint8Array>;
}

type Declaration =
  | { type: 'stdio'; command: string; args: string[]; env: Record<string, string> }
  | { type: 'http'; url: string };

interface Server {
  name: string;
  declaration: Declaration;
  materialization?: { kind: 'aliased'; as: string } | { kind: 'omitted' };
}

const stdio = (command: string, args: string[] = []): Declaration => ({ type: 'stdio', command, args, env: {} });

const primaryPath = (asset: Asset) =>
  asset.type === 'skill' ? `skills/${asset.name}/SKILL.md` : `${asset.type}s/${asset.name}.md`;

/** A recorded installation as the CLI leaves it: manifest, lockfile, adapter home and the adapter's exports. */
async function installation(
  facets: Record<string, Asset[]>,
  adapters = ['agent-runtime'],
  servers: Record<string, Server[]> = {},
) {
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
  const exportedServers: Record<string, Declaration> = {};
  for (const facet of Object.keys(servers)) facets[facet] ??= [];
  for (const [facet, entries] of Object.entries(facets)) {
    const overrides: Record<string, Record<string, unknown>> = {};
    for (const asset of entries) {
      if (asset.materialization !== undefined && asset.materialization.kind !== 'authored') {
        const group = `${asset.type}s`;
        overrides[group] = { ...overrides[group], [asset.name]: asset.materialization };
      }
    }
    const declared = [...(servers[facet] ?? [])].sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const server of declared) {
      if (server.materialization !== undefined) {
        overrides.servers = { ...overrides.servers, [server.name]: server.materialization };
      }
      if (server.materialization?.kind === 'omitted') continue;
      exportedServers[server.materialization?.kind === 'aliased' ? server.materialization.as : server.name] =
        server.declaration;
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
      servers: declared.map((server) => ({
        name: server.name,
        fingerprint: computeMcpServerFingerprint(server.declaration),
        materialization: server.materialization ?? { kind: 'authored' },
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
  writeFileSync(join(project, 'facets.lock'), `${JSON.stringify({ lockfileVersion: 0.4, facets: lock }, null, 2)}\n`);
  if (Object.keys(exportedServers).length > 0) {
    mkdirSync(dirname(exportServersPath(project)), { recursive: true });
    writeFileSync(exportServersPath(project), `${canonicalJson({ format: 1, servers: exportedServers })}\n`);
  }
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
    expect(bundle.format).toBe(2);
    expect(bundle.inputs.lockfileVersion).toBe(0.4);
    expect(bundle.servers).toEqual([]);
    expect(bundle.omittedServers).toEqual([]);
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
    for (const version of ['0.2', '0.3']) {
      writeFileSync(
        lockPath,
        readFileSync(lockPath, 'utf8').replace(/"lockfileVersion": [0-9.]+/, `"lockfileVersion": ${version}`),
      );
      expect(refusal(old.seal)).toBe('lockfile_migration_required');
    }
    try {
      old.seal();
    } catch (error) {
      expect((error as Error).message).toContain('facet install');
      expect((error as Error).message).toContain('0.36.0');
    }
    writeFileSync(
      lockPath,
      readFileSync(lockPath, 'utf8').replace(/"lockfileVersion": [0-9.]+/, '"lockfileVersion": 0.5'),
    );
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
});

describe('server sealing', () => {
  const repo = stdio('./repo-server', ['--read']);
  const withServers = (servers: Record<string, Server[]>, assetsByFacet: Record<string, Asset[]> = {}) =>
    installation(assetsByFacet, ['agent-runtime'], servers);
  const origin = (facet: string, authoredName: string) => ({
    facet,
    version: '1.0.0',
    source: `local:./facets/${facet}`,
    integrity: fileHash(facet),
    authoredName,
  });

  test('joins each selected server to every facet that declares it, under its effective name', async () => {
    const sealed = (
      await withServers({
        a: [{ name: 'repo', declaration: repo }],
        b: [
          { name: 'tools', declaration: repo },
          {
            name: 'docs',
            declaration: { type: 'http', url: 'https://mcp.example.test/' },
            materialization: { kind: 'omitted' },
          },
        ],
        c: [{ name: 'repo', declaration: stdio('./other'), materialization: { kind: 'aliased', as: 'c-repo' } }],
      })
    ).seal();
    expect(sealed.installation.servers).toEqual([
      {
        serverId: 'c-repo',
        fingerprint: computeMcpServerFingerprint(stdio('./other')),
        declaration: stdio('./other'),
        origins: [origin('c', 'repo')],
      },
      {
        serverId: 'repo',
        fingerprint: computeMcpServerFingerprint(repo),
        declaration: repo,
        // Identical declarations compose: no origin is a winner.
        origins: [origin('a', 'repo')],
      },
      {
        serverId: 'tools',
        fingerprint: computeMcpServerFingerprint(repo),
        declaration: repo,
        origins: [origin('b', 'tools')],
      },
    ]);
    expect(sealed.installation.omittedServers).toEqual([
      {
        facet: 'b',
        authoredName: 'docs',
        fingerprint: computeMcpServerFingerprint({ type: 'http', url: 'https://mcp.example.test/' }),
      },
    ]);
  });

  test('an identical declaration claimed by several facets keeps all of their origins', async () => {
    const sealed = (
      await withServers({
        a: [{ name: 'repo', declaration: repo }],
        b: [{ name: 'repo', declaration: stdio('./repo-server', ['--read']) }],
      })
    ).seal();
    expect(sealed.installation.servers.map((server) => [server.serverId, server.origins])).toEqual([
      ['repo', [origin('a', 'repo'), origin('b', 'repo')]],
    ]);
  });

  test('refuses missing, extra and changed server exports, including a deleted export file', async () => {
    const deleted = await withServers({ a: [{ name: 'repo', declaration: repo }] });
    rmSync(exportServersPath(deleted.project));
    expect(refusal(deleted.seal)).toBe('server_export_missing');

    const write = (project: string, servers: Record<string, unknown>) => {
      mkdirSync(dirname(exportServersPath(project)), { recursive: true });
      writeFileSync(exportServersPath(project), `${canonicalJson({ format: 1, servers })}\n`);
    };
    const extra = await withServers({ a: [{ name: 'repo', declaration: repo }] });
    write(extra.project, { repo, stray: stdio('./stray') });
    expect(refusal(extra.seal)).toBe('server_export_unexpected');

    const changed = await withServers({ a: [{ name: 'repo', declaration: repo }] });
    write(changed.project, { repo: { ...repo, args: ['--write'] } });
    expect(refusal(changed.seal)).toBe('server_export_mismatch');

    const reordered = await withServers({ a: [{ name: 'repo', declaration: stdio('./x', ['a', 'b']) }] });
    write(reordered.project, { repo: stdio('./x', ['b', 'a']) });
    expect(refusal(reordered.seal)).toBe('server_export_mismatch');

    const pretty = await withServers({ a: [{ name: 'repo', declaration: repo }] });
    writeFileSync(exportServersPath(pretty.project), JSON.stringify({ format: 1, servers: { repo } }, null, 2));
    expect(refusal(pretty.seal)).toBe('export_invalid');

    // An omitted server is not exported; exporting it anyway is an extra record.
    const omitted = await withServers({
      a: [{ name: 'repo', declaration: repo, materialization: { kind: 'omitted' } }],
    });
    write(omitted.project, { repo });
    expect(refusal(omitted.seal)).toBe('server_export_unexpected');
  });

  test('refuses server choices that differ from the manifest, stale server overrides and recorded collisions', async () => {
    const edited = await withServers({
      a: [{ name: 'repo', declaration: repo, materialization: { kind: 'aliased', as: 'a-repo' } }],
    });
    const manifestPath = join(edited.project, 'facets.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    manifest.facets.a.materialization.servers.repo = { kind: 'omitted' };
    writeFileSync(manifestPath, JSON.stringify(manifest));
    expect(refusal(edited.seal)).toBe('inputs_disagree');
    manifest.facets.a.materialization.servers = { repo: { kind: 'aliased', as: 'a-repo' }, gone: { kind: 'omitted' } };
    writeFileSync(manifestPath, JSON.stringify(manifest));
    expect(refusal(edited.seal)).toBe('inputs_disagree');

    const collision = await withServers({
      a: [{ name: 'repo', declaration: repo }],
      b: [{ name: 'repo', declaration: stdio('./different') }],
    });
    expect(refusal(collision.seal)).toBe('server_collision');
  });

  test('resolves authored MCP references through the verified mapping', async () => {
    const sealed = (
      await withServers(
        {
          tools: [{ name: 'repo', declaration: repo, materialization: { kind: 'aliased', as: 'team-repo' } }],
          dropped: [{ name: 'docs', declaration: stdio('./docs'), materialization: { kind: 'omitted' } }],
        },
        {
          app: [
            {
              type: 'command',
              name: 'sync',
              primary: 'Sync.\n',
              metadata: {
                runtimeVersion: 1,
                requires: [{ kind: 'mcp', facet: 'tools', server: 'repo', tool: 'list_prs' }],
                restrict: {
                  mcp: [
                    { facet: 'tools', server: 'repo', tool: 'list_prs' },
                    { facet: 'dropped', server: 'docs', tool: 'search' },
                  ],
                },
              },
            },
            {
              type: 'command',
              name: 'docs',
              primary: 'Docs.\n',
              metadata: {
                runtimeVersion: 1,
                requires: [{ kind: 'mcp', facet: 'dropped', server: 'docs', tool: 'search' }],
              },
            },
            {
              type: 'command',
              name: 'wrong-facet',
              primary: 'X.\n',
              // `team-repo` is an effective name, not something the app facet declares.
              metadata: { runtimeVersion: 1, requires: [{ kind: 'mcp', server: 'team-repo', tool: 'list_prs' }] },
            },
          ],
        },
      )
    ).seal();
    const sync = stateOf(sealed, 'command', 'sync');
    if (sync?.kind !== 'ready') throw new Error('expected a ready command');
    expect(sync.definition.requires).toEqual([{ kind: 'mcp', serverId: 'team-repo', toolName: 'list_prs' }]);
    expect((sync.definition as { restrict?: unknown }).restrict).toEqual({
      mcp: [{ serverId: 'team-repo', toolName: 'list_prs' }],
    });
    expect(stateOf(sealed, 'command', 'docs')).toEqual({
      kind: 'refused',
      reason: 'prerequisite_omitted',
      subject: 'mcp:dropped/docs/search',
      fields: ['requires'],
    });
    expect(stateOf(sealed, 'command', 'wrong-facet')).toMatchObject({
      kind: 'refused',
      reason: 'prerequisite_missing',
      subject: 'mcp:app/team-repo/list_prs',
    });
  });

  test('the joined servers do not depend on the order facets are listed in', async () => {
    const first = (
      await withServers({ a: [{ name: 'repo', declaration: repo }], b: [{ name: 'repo', declaration: repo }] })
    ).seal();
    const second = (
      await withServers({ b: [{ name: 'repo', declaration: repo }], a: [{ name: 'repo', declaration: repo }] })
    ).seal();
    // The hand-written lockfiles differ in key order (the CLI sorts them); the joined records must not.
    expect(second.installation.servers).toEqual(first.installation.servers);
    expect(first.installation.servers[0]?.origins.map((entry) => entry.facet)).toEqual(['a', 'b']);
  });

  test('refuses more selected servers than the runtime supports', async () => {
    const many = Array.from({ length: 9 }, (_, index) => ({ name: `s${index}`, declaration: stdio(`./s${index}`) }));
    expect(refusal((await withServers({ a: many })).seal)).toBe('installation_too_large');
  });
});
