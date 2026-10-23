import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalJson, sha256Hex } from '../records/canonical.ts';
import { type CatalogLoad, loadInstallation, readInstallation } from './installation.ts';

const D = 'd'.repeat(64);
const integrity = `sha256:${'f'.repeat(64)}`;
const origin = { facet: 'workflows', version: '1.2.0', source: 'local:./facets/workflows', integrity };
const files = (path: string) => [{ path, integrity: `sha256:${'1'.repeat(64)}` }];

const common = (kind: string, name: string, requires: unknown[] = []) => ({
  id: `${kind}:${name}`,
  name,
  description: `About ${name}`,
  origins: [origin],
  exportDigest: D,
  requires,
});
const command = (name: string, requires: unknown[] = [], authoredName = name) => ({
  kind: 'command',
  facet: 'workflows',
  authoredName,
  materialization: authoredName === name ? { kind: 'authored' } : { kind: 'aliased', as: name },
  files: files(`commands/${authoredName}.md`),
  state: {
    kind: 'ready',
    definition: { ...common('command', name, requires), body: 'Do $ARGUMENTS.', arguments: { required: true } },
  },
});
const skill = (name: string, requires: unknown[] = []) => {
  const bytes = Buffer.from('# Reference\n');
  return {
    kind: 'skill',
    facet: 'workflows',
    authoredName: name,
    materialization: { kind: 'authored' },
    files: files(`skills/${name}/SKILL.md`),
    state: {
      kind: 'ready',
      definition: {
        ...common('skill', name, requires),
        instructions: 'Follow the guide.',
        resources: [
          {
            path: 'references/guide.md',
            byteLength: bytes.byteLength,
            sha256: sha256Hex(bytes.toString()),
            content: bytes.toString('base64'),
          },
        ],
      },
    },
  };
};
const agent = (name: string) => ({
  kind: 'agent',
  facet: 'workflows',
  authoredName: name,
  materialization: { kind: 'authored' },
  files: files(`agents/${name}.md`),
  state: { kind: 'ready', definition: { ...common('agent', name), instructions: 'Investigate.' } },
});

const server = (serverId: string, extra: Record<string, unknown> = {}) => ({
  serverId,
  fingerprint: `sha256:${'9'.repeat(64)}`,
  declaration: { type: 'stdio', command: './server', args: ['--fixture'], env: { MODE: 'synthetic' } },
  origins: [{ ...origin, authoredName: serverId }],
  ...extra,
});

const bundle = (items: unknown[], extra: Record<string, unknown> = {}) => ({
  format: 2,
  profile: 1,
  toolchain: {
    cli: { version: '0.36.0', platform: 'linux-x64', sha256: 'c'.repeat(64) },
    adapter: { name: 'agent-runtime', apiVersion: '0.3', sdkVersion: '0.30.0', sha256: 'a'.repeat(64) },
  },
  inputs: { manifestVersion: 0.2, lockfileVersion: 0.4, manifestSha256: D, lockSha256: D },
  facets: [{ facet: 'workflows', version: '1.2.0', source: { kind: 'local', path: './facets/workflows' }, integrity }],
  items,
  servers: [],
  omittedServers: [],
  ...extra,
});
const encode = (value: unknown) => new TextEncoder().encode(`${canonicalJson(value)}\n`);
const digestOf = (bytes: Uint8Array) => new Bun.CryptoHasher('sha256').update(bytes).digest('hex');
const open = (value: unknown, bytes = encode(value)) => loadInstallation(bytes, digestOf(bytes));
const ready = (load: CatalogLoad) => {
  if (load.kind !== 'ready') throw new Error(`catalog unavailable: ${load.reason}`);
  return load.catalog;
};
const availability = (load: CatalogLoad, id: string) =>
  ready(load).contributions.find((c) => c.id === id)?.availability;

describe('sealed installation verification', () => {
  test('offers usable contributions with origins, versions and retained resources', () => {
    const catalog = ready(
      open(bundle([command('triage', [{ kind: 'skill', id: 'skill:review' }]), skill('review'), agent('scout')])),
    );
    expect(catalog.contributions.map((c) => [c.id, c.facet, c.version, c.availability.kind])).toEqual([
      ['command:triage', 'workflows', '1.2.0', 'ready'],
      ['skill:review', 'workflows', '1.2.0', 'ready'],
      ['agent:scout', 'workflows', '1.2.0', 'ready'],
    ]);
  });

  test('makes the whole catalog unavailable for unverifiable bytes, without throwing', () => {
    const value = bundle([command('triage')]);
    const bytes = encode(value);
    const pinned = digestOf(bytes);
    expect(loadInstallation(bytes, 'e'.repeat(64))).toEqual({
      kind: 'unavailable',
      reason: 'installation_digest_mismatch',
    });
    const altered = encode({ ...value, items: [command('triage2')] });
    expect(loadInstallation(altered, pinned)).toEqual({ kind: 'unavailable', reason: 'installation_digest_mismatch' });
    const pretty = new TextEncoder().encode(JSON.stringify(value, null, 2));
    expect(open(value, pretty)).toEqual({ kind: 'unavailable', reason: 'installation_not_canonical' });
    expect(open(null, new Uint8Array([0xff, 0xfe, 0x7b]))).toEqual({
      kind: 'unavailable',
      reason: 'installation_unreadable',
    });
    expect(open(bundle([command('triage')], { format: 1 }))).toEqual({
      kind: 'unavailable',
      reason: 'installation_invalid',
    });
    expect(open({ ...bundle([command('triage')]), extra: true })).toEqual({
      kind: 'unavailable',
      reason: 'installation_invalid',
    });
  });

  test('refuses structurally inconsistent bundles and server declarations as a whole', () => {
    const wrongId = command('triage');
    (wrongId.state.definition as { id: string }).id = 'command:other';
    expect(open(bundle([wrongId])).kind).toBe('unavailable');
    const foreignOrigin = command('triage');
    foreignOrigin.state.definition.origins = [{ ...origin, version: '9.9.9' }];
    expect(open(bundle([foreignOrigin])).kind).toBe('unavailable');
    expect(open(bundle([command('triage'), command('triage')])).kind).toBe('unavailable');
    for (const servers of [
      [{ serverId: 'repo' }],
      [server('repo'), server('repo')],
      [server('repo', { origins: [{ ...origin, version: '9.9.9', authoredName: 'repo' }] })],
      [server('repo', { origins: [{ ...origin, facet: 'absent', authoredName: 'repo' }] })],
      [server('repo', { declaration: { type: 'stdio', command: 'x', args: [], env: {}, cwd: '/' } })],
    ]) {
      expect(open(bundle([], { servers }))).toEqual({ kind: 'unavailable', reason: 'installation_invalid' });
    }
    // One authored server is either selected (once) or omitted, never both.
    expect(
      open(
        bundle([], {
          servers: [server('repo')],
          omittedServers: [{ facet: 'workflows', authoredName: 'repo', fingerprint: `sha256:${'9'.repeat(64)}` }],
        }),
      ),
    ).toEqual({ kind: 'unavailable', reason: 'installation_invalid' });
  });

  test('keeps every origin of a server and judges required tools by their installed server', () => {
    const shared = server('repo', {
      origins: [
        { ...origin, authoredName: 'repo' },
        { ...origin, facet: 'other', authoredName: 'tools' },
      ],
    });
    const load = open(
      bundle(
        [
          command('uses-repo', [{ kind: 'mcp', serverId: 'repo', toolName: 'list_prs' }]),
          command('uses-docs', [{ kind: 'mcp', serverId: 'docs', toolName: 'search' }]),
          command('uses-missing', [{ kind: 'mcp', serverId: 'absent', toolName: 'x' }]),
        ],
        {
          facets: [
            { facet: 'other', version: '1.2.0', source: { kind: 'local', path: './facets/other' }, integrity },
            { facet: 'workflows', version: '1.2.0', source: { kind: 'local', path: './facets/workflows' }, integrity },
          ],
          servers: [server('docs', { declaration: { type: 'http', url: 'https://mcp.example.test/' } }), shared],
          omittedServers: [{ facet: 'other', authoredName: 'unused', fingerprint: `sha256:${'8'.repeat(64)}` }],
        },
      ),
    );
    expect(
      ready(load)
        .installation.servers.find((s) => s.serverId === 'repo')
        ?.origins.map((o) => o.facet),
    ).toEqual(['workflows', 'other']);
    expect(availability(load, 'command:uses-repo')?.kind).toBe('ready');
    expect(availability(load, 'command:uses-docs')).toEqual({
      kind: 'refused',
      reason: 'server_transport_unsupported',
      subject: 'mcp:docs/search',
      fields: ['requires'],
    });
    expect(availability(load, 'command:uses-missing')).toMatchObject({
      kind: 'refused',
      reason: 'prerequisite_missing',
      subject: 'mcp:absent/x',
    });
  });

  test('rejects invalid resources, oversized definitions and exceeded counts', () => {
    const badResource = skill('review');
    badResource.state.definition.resources[0] = { ...badResource.state.definition.resources[0], sha256: D } as never;
    expect(open(bundle([badResource])).kind).toBe('unavailable');
    const escaping = skill('review');
    (escaping.state.definition.resources[0] as { path: string }).path = '../outside.md';
    expect(open(bundle([escaping])).kind).toBe('unavailable');
    const huge = command('triage');
    huge.state.definition.body = 'x'.repeat(8193);
    expect(open(bundle([huge])).kind).toBe('unavailable');
    const many = Array.from({ length: 33 }, (_, index) => command(`c${index}`));
    expect(open(bundle(many))).toEqual({ kind: 'unavailable', reason: 'installation_too_large' });
  });

  test('keeps contribution-level problems local and leaves unrelated contributions usable', () => {
    const refused = {
      ...command('legacy'),
      state: { kind: 'refused', reason: 'unsupported_field', fields: ['model'] },
    };
    const omitted = { ...agent('unused'), materialization: { kind: 'omitted' }, state: { kind: 'omitted' } };
    const load = open(
      bundle([
        refused,
        omitted,
        command('needs-legacy-skill', [{ kind: 'skill', id: 'skill:absent' }]),
        command('chained', [{ kind: 'skill', id: 'skill:needs-absent' }]),
        skill('needs-absent', [{ kind: 'agent', id: 'agent:missing' }]),
        agent('root'),
        command('fine'),
      ]),
    );
    expect(availability(load, 'command:legacy')).toEqual({
      kind: 'refused',
      reason: 'unsupported_field',
      fields: ['model'],
    });
    expect(ready(load).contributions.some((c) => c.id === 'agent:unused')).toBe(false);
    expect(availability(load, 'command:needs-legacy-skill')).toMatchObject({
      kind: 'refused',
      reason: 'prerequisite_refused',
      subject: 'skill:absent',
    });
    expect(availability(load, 'skill:needs-absent')).toMatchObject({ kind: 'refused', reason: 'prerequisite_refused' });
    expect(availability(load, 'command:chained')).toMatchObject({ kind: 'refused', reason: 'prerequisite_refused' });
    expect(availability(load, 'agent:root')).toMatchObject({ kind: 'refused', reason: 'reserved_name' });
    expect(availability(load, 'command:fine')?.kind).toBe('ready');
  });

  test('refuses both claimants of an indistinguishable name rather than choosing one', () => {
    const otherFacet = { ...skill('triage'), facet: 'other' };
    otherFacet.state.definition.origins = [{ ...origin, facet: 'other' }];
    const load = open(
      bundle([command('triage'), otherFacet, agent('triage')], {
        facets: [
          { facet: 'other', version: '1.2.0', source: { kind: 'local', path: './facets/other' }, integrity },
          { facet: 'workflows', version: '1.2.0', source: { kind: 'local', path: './facets/workflows' }, integrity },
        ],
      }),
    );
    expect(availability(load, 'command:triage')).toMatchObject({ kind: 'refused', reason: 'name_conflict' });
    expect(availability(load, 'skill:triage')).toMatchObject({ kind: 'refused', reason: 'name_conflict' });
    expect(availability(load, 'agent:triage')?.kind).toBe('ready');
  });
});

describe('reading the installation file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'installation-read-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test('a missing or mismatched file is unavailable; a matching file is ready', async () => {
    const path = join(dir, 'installation.json');
    expect(await readInstallation(path, D)).toEqual({ kind: 'unavailable', reason: 'installation_missing' });
    const bytes = encode(bundle([command('triage')]));
    writeFileSync(path, bytes);
    expect((await readInstallation(path, D)).kind).toBe('unavailable');
    expect((await readInstallation(path, digestOf(bytes))).kind).toBe('ready');
  });
});
