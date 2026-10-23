import { describe, expect, test } from 'bun:test';
import type { CapabilityConfig } from '../config/capabilities.ts';
import { exactSecretMatcher } from '../credentials/matcher.ts';
import { canonicalJson, sha256Hex } from '../records/canonical.ts';
import { createContentPolicy } from '../security/content-policy.ts';
import { prepareCommandStart, selectionRevision } from './command.ts';
import { type Catalog, loadInstallation } from './installation.ts';
import { sealSnapshot } from './records.ts';
import { assembleSnapshot, type BoundTools } from './snapshot.ts';

const D = 'd'.repeat(64);
const SECRET = 'synthetic-snapshot-secret-value-01';
const policy = createContentPolicy(exactSecretMatcher([SECRET]));
const integrity = `sha256:${'f'.repeat(64)}`;
const origin = { facet: 'workflows', version: '1.0.0', source: 'local:./facets/workflows', integrity };

const base = (kind: string, name: string, requires: unknown[]) => ({
  id: `${kind}:${name}`,
  name,
  description: `About ${name}`,
  origins: [origin],
  exportDigest: D,
  requires,
});
const item = (kind: string, name: string, definition: Record<string, unknown>) => ({
  kind,
  facet: 'workflows',
  authoredName: name,
  materialization: { kind: 'authored' },
  files: [{ path: kind === 'skill' ? `skills/${name}/SKILL.md` : `${kind}s/${name}.md`, integrity }],
  state: { kind: 'ready', definition },
});
const resource = (path: string, bytes: Uint8Array) => ({
  path,
  byteLength: bytes.byteLength,
  sha256: new Bun.CryptoHasher('sha256').update(bytes).digest('hex'),
  content: Buffer.from(bytes).toString('base64'),
});
const command = (name: string, requires: unknown[] = [], restrict?: unknown) =>
  item('command', name, {
    ...base('command', name, requires),
    body: 'Triage $ARGUMENTS.',
    arguments: { required: true },
    ...(restrict === undefined ? {} : { restrict }),
  });
const skill = (name: string, requires: unknown[] = [], resources: unknown[] = []) =>
  item('skill', name, { ...base('skill', name, requires), instructions: `Use ${name}.`, resources });
const agent = (name: string, requires: unknown[] = []) =>
  item('agent', name, { ...base('agent', name, requires), instructions: `Act as ${name}.` });

function catalogOf(items: unknown[], servers: unknown[] = []): Catalog {
  const bytes = new TextEncoder().encode(
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
      items,
      servers,
      omittedServers: [],
    })}\n`,
  );
  const load = loadInstallation(bytes, new Bun.CryptoHasher('sha256').update(bytes).digest('hex'));
  if (load.kind !== 'ready') throw new Error(load.reason);
  return load.catalog;
}

const grants = (extra: Partial<CapabilityConfig> = {}): CapabilityConfig => ({
  installation: { path: '/etc/agent-runtime/facets/installation.json', sha256: D },
  allowSkills: ['skill:review', 'skill:notes', 'skill:depends', 'skill:leaky', 'skill:binary'],
  allowAgents: ['agent:scout', 'agent:needs-hidden'],
  maxDelegationsPerRun: 4,
  localPrograms: {},
  servers: [
    {
      serverId: 'repo',
      programId: 'repo',
      literalEnv: { REPO_MODE: 'private-literal-setting' },
      credentialEnv: { REPO_TOKEN: 'private-slot-name' },
      toolTimeoutSeconds: 60,
      approval: { kind: 'denied' },
    },
  ],
  ...extra,
});

const installedRepo = {
  serverId: 'repo',
  fingerprint: `sha256:${'9'.repeat(64)}`,
  declaration: { type: 'stdio', command: './repo', args: [], env: {} },
  origins: [{ ...origin, authoredName: 'repo' }],
};

function assemble(items: unknown[], commandId: string, config = grants(), bound?: BoundTools) {
  const catalog = catalogOf(items, [installedRepo]);
  const submission = {
    kind: 'command' as const,
    commandId,
    selectionRevision: selectionRevision(catalog.installationSha256, commandId),
    arguments: 'owner/repo-a',
    provider: 'anthropic' as const,
  };
  const start = prepareCommandStart(catalog, submission, policy);
  if (!start.ok) throw new Error(`start refused: ${start.reason}`);
  return assembleSnapshot({
    catalog,
    command: start.command,
    submission,
    renderedGoal: start.goal,
    grants: config,
    policy,
    ...(bound === undefined ? {} : { bound }),
  });
}

const guide = resource('references/guide.md', new TextEncoder().encode('# Guide\n'));
const standard = [
  command('triage', [{ kind: 'skill', id: 'skill:review' }]),
  skill('review', [], [guide]),
  skill('notes'),
  skill('ungranted'),
  skill('depends', [{ kind: 'skill', id: 'skill:ungranted' }]),
  agent('scout'),
  agent('needs-hidden', [{ kind: 'skill', id: 'skill:ungranted' }]),
];

describe('capability snapshot assembly', () => {
  test('retains every available definition, unloaded resources included, with the original authority ceiling', () => {
    const assembled = assemble(standard, 'command:triage');
    if (!assembled.ok) throw new Error(assembled.reason);
    const { snapshot } = assembled;
    expect(snapshot.command.id).toBe('command:triage');
    expect(snapshot.input).toEqual({ arguments: 'owner/repo-a', renderedGoal: 'Triage owner/repo-a.' });
    // Granted, ready and with their own prerequisites available; `depends` and `needs-hidden` need `ungranted`.
    expect(snapshot.skills.map((s) => s.id)).toEqual(['skill:notes', 'skill:review']);
    expect(snapshot.agents.map((a) => a.id)).toEqual(['agent:scout']);
    expect(snapshot.skills.find((s) => s.id === 'skill:review')?.resources).toEqual([guide]);
    expect(snapshot.authority).toEqual({
      native: ['mcp_Read', 'mcp_Search', 'mcp_AskUser'],
      skills: ['skill:notes', 'skill:review'],
      agents: ['agent:scout'],
      servers: [],
    });
    expect(snapshot.limits).toEqual({ maxDelegations: 4, delegationDepth: 1 });
    expect(assembled.digest).toBe(sealSnapshot(snapshot).digest);
  });

  test('the command restriction narrows what is retained and a required item must be available', () => {
    const restricted = assemble(
      [command('triage', [], { skills: ['skill:notes'], agents: [] }), ...standard.slice(1)],
      'command:triage',
    );
    expect(restricted.ok && [restricted.snapshot.skills.map((s) => s.id), restricted.snapshot.agents]).toEqual([
      ['skill:notes'],
      [],
    ]);
    expect(assemble(standard, 'command:triage', grants({ allowSkills: ['skill:notes'] }))).toEqual({
      ok: false,
      reason: 'prerequisite_not_granted',
      subject: 'skill:review',
    });
    expect(
      assemble(
        [command('triage', [{ kind: 'native', name: 'mcp_Search' }], { native: ['mcp_Read'] }), ...standard.slice(1)],
        'command:triage',
      ),
    ).toMatchObject({ ok: false, reason: 'prerequisite_restricted' });
  });

  test('a required MCP tool must have been bound by preflight', () => {
    const items = [command('sync', [{ kind: 'mcp', serverId: 'repo', toolName: 'list_prs' }]), ...standard.slice(1)];
    expect(assemble(items, 'command:sync')).toEqual({
      ok: false,
      reason: 'tool_unavailable',
      subject: 'mcp:repo/list_prs',
    });
  });

  test('holds nothing private and refuses recognizable credentials in any definition or text resource', () => {
    const assembled = assemble(standard, 'command:triage');
    const text = JSON.stringify(assembled);
    for (const secret of ['private-slot-name', 'private-literal-setting', 'REPO_TOKEN', '/etc/agent-runtime']) {
      expect(text).not.toContain(secret);
    }
    const leaky = [
      ...standard,
      item('skill', 'leaky', {
        ...base('skill', 'leaky', []),
        description: `Uses ${SECRET}`,
        instructions: 'x',
        resources: [],
      }),
    ];
    const refused = assemble(leaky, 'command:triage');
    expect(refused).toEqual({ ok: false, reason: 'credential_in_definition', subject: 'skill:leaky' });
    expect(JSON.stringify(refused)).not.toContain(SECRET);
    const inResource = [
      ...standard,
      skill('leaky', [], [resource('notes.md', new TextEncoder().encode(`token: ${SECRET}\n`))]),
    ];
    expect(assemble(inResource, 'command:triage')).toMatchObject({ reason: 'credential_in_definition' });
    // A binary resource is kept losslessly; it is never readable text, so it is not screened as text.
    const binary = [...standard, skill('binary', [], [resource('blob.bin', new Uint8Array([0xff, 0xfe, 0x00]))])];
    expect(assemble(binary, 'command:triage').ok).toBe(true);
  });

  test('identical definitions give the same digest whatever their key order', () => {
    const assembled = assemble(standard, 'command:triage');
    if (!assembled.ok) throw new Error(assembled.reason);
    const reorder = (value: unknown): unknown =>
      Array.isArray(value)
        ? value.map(reorder)
        : value !== null && typeof value === 'object'
          ? Object.fromEntries(
              Object.entries(value)
                .reverse()
                .map(([key, entry]) => [key, reorder(entry)]),
            )
          : value;
    expect(sealSnapshot(reorder(assembled.snapshot)).digest).toBe(assembled.digest);
    expect(assembled.digest).toBe(sha256Hex(canonicalJson(assembled.snapshot)));
  });
});
