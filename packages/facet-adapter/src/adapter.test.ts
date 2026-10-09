import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import type { FileMutationAction, PlanAssetInstallRequest } from '@agent-facets/adapter';
import adapter, { assets, mcpServers } from './adapter.ts';
import { exportAssetPath, exportRecordSchema, exportServersPath } from './export-record.ts';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function project(): string {
  const root = mkdtempSync(join(tmpdir(), 'facet-adapter-test-'));
  roots.push(root);
  return root;
}

/** Every file beneath a directory with its bytes, to prove planning wrote nothing. */
function snapshot(root: string): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else files[relative(root, path)] = readFileSync(path).toString('base64');
    }
  };
  walk(root);
  return files;
}

/** Stands in for the CLI's transaction: applies a planned action exactly as described. */
function apply(action: FileMutationAction) {
  if (action.kind === 'unchanged') return;
  for (const mutation of action.mutations) {
    if (mutation.kind === 'write') {
      mkdirSync(dirname(mutation.path), { recursive: true });
      writeFileSync(mutation.path, mutation.contents);
    } else rmSync(mutation.path);
  }
}

const runtime = (extra: Record<string, unknown> = {}) => ({ runtimeVersion: 1, ...extra });
const request = (root: string, overrides: Partial<PlanAssetInstallRequest> = {}): PlanAssetInstallRequest =>
  ({
    projectRoot: root,
    scope: 'project',
    assetType: 'command',
    name: 'review-pr',
    content: '---\nagent: build\nmodel: other\n---\nReview $ARGUMENTS.\n',
    metadata: {
      name: 'review-pr',
      description: 'Review a pull request',
      ...runtime({ arguments: { required: true } }),
    },
    ...overrides,
  }) as PlanAssetInstallRequest;

async function install(req: PlanAssetInstallRequest) {
  const result = await assets.planInstall(req);
  if (!result.ok) throw new Error(`planning failed: ${result.failure.code}`);
  apply(result.plan.action);
  return result.plan;
}
const readExport = (root: string, kind: string, name: string) =>
  exportRecordSchema.parse(JSON.parse(readFileSync(exportAssetPath(root, kind, name), 'utf8')));

describe('agent-runtime adapter identity', () => {
  test('is a planning adapter with text-asset and server capabilities', () => {
    expect(adapter.name).toBe('agent-runtime');
    expect(adapter.apiVersion).toBe('0.3');
    expect(adapter.assets).not.toBe(false);
    expect(adapter.mcpServers).not.toBe(false);
  });

  test('build-time metadata validation accepts any object and leaves refusal to each export', () => {
    expect(adapter.buildAssetMetadata({ runtimeVersion: 9, hooks: [] })).toEqual({
      ok: true,
      data: { runtimeVersion: 9, hooks: [] },
    });
    expect(adapter.buildAssetMetadata(undefined)).toEqual({ ok: true, data: {} });
    expect(adapter.buildAssetMetadata('x').ok).toBe(false);
  });
});

describe('text-asset export plans', () => {
  test('exports the effective name, description and body without other tools front matter', async () => {
    const root = project();
    const plan = await install(request(root, { name: 'team-review' }));
    expect(plan.occupancy).toBe('absent');
    expect(plan.primaryPath).toBe(join(root, '.agent-runtime-export', 'assets', 'command', 'team-review.json'));
    expect(readExport(root, 'command', 'team-review')).toEqual({
      format: 1,
      state: 'ready',
      kind: 'command',
      name: 'team-review',
      description: 'Review a pull request',
      body: 'Review $ARGUMENTS.\n',
      runtime: { runtimeVersion: 1, requires: [], arguments: { required: true } },
      companions: [],
    });
  });

  test('planning never writes, and an unchanged re-install plans nothing', async () => {
    const root = project();
    writeFileSync(join(root, 'unrelated.txt'), 'kept');
    const before = snapshot(root);
    const first = await assets.planInstall(request(root));
    expect(snapshot(root)).toEqual(before);
    if (!first.ok) throw new Error('planning failed');
    apply(first.plan.action);
    const exported = snapshot(root);
    const again = await assets.planInstall(request(root));
    expect(again.ok && again.plan).toEqual({
      occupancy: 'equivalent',
      action: { kind: 'unchanged' },
      primaryPath: exportAssetPath(root, 'command', 'review-pr'),
    });
    expect(snapshot(root)).toEqual(exported);
  });

  test('replacing a changed export carries the exact prior state as its precondition', async () => {
    const root = project();
    await install(request(root));
    const prior = readFileSync(exportAssetPath(root, 'command', 'review-pr'));
    const result = await assets.planInstall(request(root, { content: 'Changed.\n' }));
    if (!result.ok || result.plan.action.kind !== 'mutate') throw new Error('expected a write');
    expect(result.plan.occupancy).toBe('divergent');
    const [mutation] = result.plan.action.mutations;
    expect(mutation.kind).toBe('write');
    expect(mutation.boundary).toBe(root);
    expect(mutation.expected.kind === 'regular-file' && Buffer.from(mutation.expected.contents).equals(prior)).toBe(
      true,
    );
  });

  test('skill companions are exported losslessly, including binary and empty files', async () => {
    const root = project();
    const binary = new Uint8Array([0, 255, 1, 128]);
    await install(
      request(root, {
        assetType: 'skill',
        name: 'guide',
        content: '# Guide\n',
        metadata: { name: 'guide', description: 'Guidance', ...runtime() },
        companions: {
          'references/z.md': new TextEncoder().encode('zed\n'),
          'a.bin': binary,
          'empty.txt': new Uint8Array(),
        },
        ownedCompanionPaths: [],
      } as Partial<PlanAssetInstallRequest>),
    );
    const record = readExport(root, 'skill', 'guide');
    if (record.state !== 'ready') throw new Error('expected a ready skill');
    expect(record.companions.map((companion) => companion.path)).toEqual(['a.bin', 'empty.txt', 'references/z.md']);
    expect(Buffer.from(record.companions[0]?.content ?? '', 'base64')).toEqual(Buffer.from(binary));
    expect(record.companions[1]).toMatchObject({ byteLength: 0, content: '' });
    expect(record.companions[0]?.sha256).toBe(new Bun.CryptoHasher('sha256').update(binary).digest('hex'));
  });

  test('missing or unsupported runtime metadata becomes a contribution-local refusal record', async () => {
    const root = project();
    const cases: [string, Partial<PlanAssetInstallRequest>, string, string[]][] = [
      [
        'no-block',
        { metadata: { name: 'no-block', description: 'd' } },
        'runtime_metadata_missing',
        ['runtimeVersion'],
      ],
      [
        'v2',
        { metadata: { name: 'v2', description: 'd', runtimeVersion: 2 } },
        'runtime_version_unsupported',
        ['runtimeVersion'],
      ],
      [
        'extras',
        { metadata: { name: 'extras', description: 'd', ...runtime({ model: 'x', hooks: {} }) } },
        'unsupported_field',
        ['hooks', 'model'],
      ],
      [
        'skill-restrict',
        {
          assetType: 'skill',
          companions: {},
          ownedCompanionPaths: [],
          metadata: { name: 'skill-restrict', description: 'd', ...runtime({ restrict: {} }) },
        } as Partial<PlanAssetInstallRequest>,
        'unsupported_field',
        ['restrict'],
      ],
      [
        'bad-args',
        { metadata: { name: 'bad-args', description: 'd', ...runtime({ arguments: { required: 'yes' } }) } },
        'invalid_field',
        ['arguments'],
      ],
      [
        'nested',
        {
          assetType: 'agent',
          metadata: { name: 'nested', description: 'd', ...runtime({ requires: [{ kind: 'agent', name: 'other' }] }) },
        },
        'nested_delegation_unsupported',
        ['requires'],
      ],
    ];
    for (const [name, overrides, reason, fields] of cases) {
      await install(request(root, { name, ...overrides }));
      const kind = overrides.assetType ?? 'command';
      expect(readExport(root, kind, name)).toEqual({ format: 1, state: 'refused', kind, name, reason, fields });
    }
  });

  test('refuses unsupported scopes and escaping companion paths before reading anything', async () => {
    const root = project();
    const user = await assets.planInstall(request(root, { scope: 'user' }));
    expect(user.ok === false && user.failure.code).toBe('unsupported-scope');
    const escaping = await assets.planInstall(
      request(root, {
        assetType: 'skill',
        name: 'guide',
        companions: { '../outside.md': new Uint8Array() },
        ownedCompanionPaths: [],
      } as Partial<PlanAssetInstallRequest>),
    );
    expect(escaping.ok === false && escaping.failure.code).toBe('invalid-companion-path');
    expect(snapshot(root)).toEqual({});
  });

  test('removal deletes only the owned export and reports an already absent one', async () => {
    const root = project();
    await install(request(root));
    writeFileSync(join(root, 'unrelated.txt'), 'kept');
    const removal = await assets.planRemoval({
      projectRoot: root,
      scope: 'project',
      assetType: 'command',
      name: 'review-pr',
    });
    if (!removal.ok || removal.plan.kind !== 'remove') throw new Error('expected a removal');
    expect(removal.plan.action.mutations.map((mutation) => mutation.kind)).toEqual(['delete']);
    apply(removal.plan.action);
    expect(Object.keys(snapshot(root))).toEqual(['unrelated.txt']);
    const again = await assets.planRemoval({
      projectRoot: root,
      scope: 'project',
      assetType: 'command',
      name: 'review-pr',
    });
    expect(again.ok && again.plan.kind).toBe('absent');
  });
});

describe('server declaration export plans', () => {
  const stdio = { type: 'stdio', command: 'bun', args: ['server.js'] } as const;

  test('exports effective names and portable declarations, then plans nothing for the same set', async () => {
    const root = project();
    const first = await mcpServers.plan({
      projectRoot: root,
      desired: [{ name: 'repo-tools', declaration: stdio }],
      previouslyOwnedNames: [],
    });
    if (!first.ok) throw new Error('planning failed');
    expect(first.plan.outcomes).toEqual([{ kind: 'absent', name: 'repo-tools', ownership: 'untracked' }]);
    expect(snapshot(root)).toEqual({});
    apply(first.plan.action);
    expect(JSON.parse(readFileSync(exportServersPath(root), 'utf8'))).toEqual({
      format: 1,
      servers: { 'repo-tools': { type: 'stdio', command: 'bun', args: ['server.js'], env: {} } },
    });
    const again = await mcpServers.plan({
      projectRoot: root,
      desired: [{ name: 'repo-tools', declaration: { ...stdio, env: {} } }],
      previouslyOwnedNames: ['repo-tools'],
    });
    expect(again.ok && again.plan.action).toEqual({ kind: 'unchanged' });
  });

  test('replaces a changed declaration, removes obsolete owned entries and keeps unowned ones', async () => {
    const root = project();
    const initial = await mcpServers.plan({
      projectRoot: root,
      desired: [
        { name: 'repo-tools', declaration: stdio },
        { name: 'old', declaration: { type: 'http', url: 'https://mcp.example.test/' } },
        { name: 'foreign', declaration: stdio },
      ],
      previouslyOwnedNames: [],
    });
    if (!initial.ok) throw new Error('planning failed');
    apply(initial.plan.action);
    const next = await mcpServers.plan({
      projectRoot: root,
      desired: [{ name: 'repo-tools', declaration: { ...stdio, args: ['other.js'] } }],
      previouslyOwnedNames: ['repo-tools', 'old'],
    });
    if (!next.ok) throw new Error('planning failed');
    expect(next.plan.outcomes).toEqual([
      { kind: 'divergent', name: 'repo-tools', ownership: 'tracked' },
      { kind: 'obsolete-owned', name: 'old', occupancy: 'present' },
    ]);
    apply(next.plan.action);
    expect(Object.keys(JSON.parse(readFileSync(exportServersPath(root), 'utf8')).servers).sort()).toEqual([
      'foreign',
      'repo-tools',
    ]);
  });

  test('refuses an unreadable export document without planning a write', async () => {
    const root = project();
    mkdirSync(dirname(exportServersPath(root)), { recursive: true });
    writeFileSync(exportServersPath(root), '{ not json');
    const result = await mcpServers.plan({ projectRoot: root, desired: [], previouslyOwnedNames: ['x'] });
    expect(result.ok === false && result.failure.code).toBe('parse-failed');
  });
});
