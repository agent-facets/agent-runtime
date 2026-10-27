import { describe, expect, test } from 'bun:test';
import { commandFixture } from '../../test-support/lifecycle/wiring.ts';
import { withMcp } from '../../test-support/mcp-snapshot.ts';
import { type Catalog, loadInstallation } from '../capabilities/installation.ts';
import { legacyMcpToolName, sealSnapshot } from '../capabilities/records.ts';
import type { CapabilityConfig } from '../config/capabilities.ts';
import { exactSecretMatcher } from '../credentials/matcher.ts';
import { canonicalJson } from '../records/canonical.ts';
import type { CapabilityRecord } from '../records/run-store.ts';
import { createContentPolicy } from '../security/content-policy.ts';
import { catalogView, runCapabilitiesView } from './capability-views.ts';

const D = 'd'.repeat(64);
const SECRET = 'synthetic-capability-view-secret-01';
const policy = createContentPolicy(exactSecretMatcher([SECRET]));
const integrity = `sha256:${'f'.repeat(64)}`;
const origin = { facet: 'workflows', version: '1.0.0', source: 'local:/home/owner/private/facets', integrity };

const item = (kind: string, name: string, description: string, extra: Record<string, unknown> = {}) => ({
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
      description,
      origins: [origin],
      exportDigest: D,
      requires: [],
      ...extra,
    },
  },
});

function catalog(items: unknown[]): Catalog {
  const bytes = new TextEncoder().encode(
    `${canonicalJson({
      format: 2,
      profile: 1,
      toolchain: {
        cli: { version: '0.36.5', platform: 'linux-x64', sha256: 'c'.repeat(64) },
        adapter: { name: 'agent-runtime', apiVersion: '0.3', sdkVersion: '0.30.0', sha256: 'a'.repeat(64) },
      },
      inputs: { manifestVersion: 0.2, lockfileVersion: 0.4, manifestSha256: D, lockSha256: D },
      facets: [
        { facet: 'workflows', version: '1.0.0', source: { kind: 'local', path: '/home/owner/private' }, integrity },
      ],
      items,
      servers: [
        {
          serverId: 'repo',
          fingerprint: `sha256:${'9'.repeat(64)}`,
          declaration: { type: 'stdio', command: '/opt/private/repo', args: ['--token-file=/secret'], env: {} },
          origins: [{ ...origin, authoredName: 'repo' }],
        },
      ],
      omittedServers: [],
    })}\n`,
  );
  const load = loadInstallation(bytes, new Bun.CryptoHasher('sha256').update(bytes).digest('hex'));
  if (load.kind !== 'ready') throw new Error(load.reason);
  return load.catalog;
}

const config = (approval: CapabilityConfig['servers'][number]['approval']): CapabilityConfig => ({
  installation: { path: '/etc/agent-runtime/facets/installation.json', sha256: D },
  allowSkills: [],
  allowAgents: [],
  maxDelegationsPerRun: 8,
  localPrograms: { repo: { bundlePath: `/opt/agent-runtime/mcp/repo/${D}.js`, sha256: D } },
  servers: [
    {
      serverId: 'repo',
      programId: 'repo',
      literalEnv: { REPO_MODE: 'read' },
      credentialEnv: { REPO_TOKEN: 'repo-slot' },
      toolTimeoutSeconds: 60,
      approval,
    },
  ],
});

describe('the catalog view', () => {
  test('shows plain text as text, leaves out credential-bearing text and never shows launch configuration', () => {
    const installed = catalog([
      item('command', 'markup', '<img src=x onerror=alert(1)> **bold**', {
        body: 'Do it.',
        arguments: { required: false },
      }),
      item('skill', 'leaky', `Uses ${SECRET} to log in.`, { instructions: 'Do.', resources: [] }),
    ]);
    const view = catalogView(
      { kind: 'ready', catalog: installed },
      config({
        kind: 'approved',
        serverDigest: D,
        tools: [
          { name: 'list', definitionDigest: D, argumentEquals: { repository: 'owner/repo-a', token: SECRET, n: 2 } },
        ],
      }),
      policy,
      () => undefined,
    );
    if (view.kind !== 'ready') throw new Error(view.kind);
    expect(view.contributions.find((entry) => entry.id === 'command:markup')?.description).toBe(
      '<img src=x onerror=alert(1)> **bold**',
    );
    expect(view.contributions.find((entry) => entry.id === 'skill:leaky')).not.toHaveProperty('description');
    expect(view.servers[0]?.grants[0]?.argumentEquals).toEqual({
      repository: { kind: 'value', value: 'owner/repo-a' },
      token: { kind: 'withheld' },
      n: { kind: 'value', value: 2 },
    });
    // The approved digest no longer matches what is installed and configured: reapproval, with the digest to review.
    expect(view.servers[0]?.connection).toMatchObject({
      kind: 'reapproval_required',
      currentDigest: expect.any(String),
    });
    const text = JSON.stringify(view);
    for (const hidden of [
      SECRET,
      '/opt/private',
      '--token-file',
      'REPO_MODE',
      'repo-slot',
      'REPO_TOKEN',
      '/home/owner',
    ]) {
      expect(text).not.toContain(hidden);
    }
  });

  test('an unconfigured deployment and an unreadable installation are distinct', () => {
    expect(catalogView({ kind: 'unconfigured' }, undefined, policy, () => undefined)).toEqual({ kind: 'unconfigured' });
    expect(
      catalogView(
        { kind: 'unavailable', reason: 'installation_digest_mismatch' },
        config({ kind: 'denied' }),
        policy,
        () => undefined,
      ),
    ).toEqual({ kind: 'unavailable', reason: 'installation_digest_mismatch' });
  });
});

describe("a run's capability view", () => {
  async function record(snapshotOverride?: (snapshot: Record<string, unknown>) => unknown) {
    const { snapshot, input } = commandFixture();
    const equipped = await withMcp(snapshot, [
      { serverId: 'repo', serverDigest: D, tools: [{ name: 'list', inputSchema: { type: 'object' } }] },
    ]);
    const payload = snapshotOverride === undefined ? equipped : snapshotOverride(equipped as never);
    const sealed = sealSnapshot(payload);
    const delegation = 'e'.repeat(64);
    const mcp = {
      kind: 'mcp' as const,
      serverId: 'repo',
      toolName: 'list',
      definitionDigest: sealed.payload.tools[0]?.definitionDigest as string,
    };
    return {
      throughSeq: '12',
      binding: { input, snapshotDigest: sealed.digest, maxDelegations: 8, payload: JSON.parse(sealed.canonical) },
      delegates: [
        {
          delegationId: delegation,
          agentId: 'agent:helper',
          state: { kind: 'completed', outcome: { kind: 'failed', reason: 'delegate_no_result', message: 'No.' } },
        },
      ],
      operations: [
        {
          actorKey: 'root',
          binding: mcp,
          disposition: { kind: 'completed', outcome: 'ok', result: { outcome: 'ok' } },
        },
        {
          actorKey: delegation,
          binding: mcp,
          disposition: {
            kind: 'completed',
            outcome: 'uncertain',
            result: { outcome: 'uncertain', code: 'mcp_call_timeout' },
          },
        },
        { actorKey: 'root', binding: mcp, disposition: { kind: 'dispatching' } },
        {
          actorKey: 'root',
          binding: undefined,
          disposition: { kind: 'completed', outcome: 'refused', result: { code: 'tool_unavailable' } },
        },
        {
          actorKey: 'root',
          binding: { kind: 'delegation', agentId: 'agent:helper' },
          disposition: { kind: 'completed', outcome: 'ok', result: {} },
        },
      ],
      loadedSkills: [{ actorKey: delegation, skillId: 'skill:review', agentId: 'agent:helper' }],
    } as CapabilityRecord;
  }

  test('aggregates recorded use and separates captured from current permissions', async () => {
    const view = runCapabilitiesView(await record(), config({ kind: 'approved', serverDigest: D, tools: [] }), policy);
    if (view.kind !== 'command') throw new Error(view.kind);
    expect(view.used.operations).toEqual([
      {
        kind: 'mcp',
        subject: 'repo/list',
        ok: 1,
        refused: 0,
        error: 0,
        uncertain: 1,
        pending: 1,
        codes: ['mcp_call_timeout'],
      },
      { kind: 'delegation', subject: 'agent:helper', ok: 1, refused: 0, error: 0, uncertain: 0, pending: 0, codes: [] },
    ]);
    expect(view.used.delegations).toEqual([{ delegationId: 'e'.repeat(64), agentId: 'agent:helper', state: 'failed' }]);
    expect(view.used.loadedSkills).toEqual([
      { skillId: 'skill:review', actor: { kind: 'delegate', delegationId: 'e'.repeat(64), agentId: 'agent:helper' } },
    ]);
    expect(view.permissions.current).toMatchObject({
      servers: [{ serverId: 'repo', connection: 'approved_as_retained' }],
    });
    expect(runCapabilitiesView(await record(), undefined, policy)).toMatchObject({
      permissions: { current: { kind: 'unconfigured' } },
    });
    expect(
      runCapabilitiesView(
        await record(),
        config({ kind: 'approved', serverDigest: 'b'.repeat(64), tools: [] }),
        policy,
      ),
    ).toMatchObject({ permissions: { current: { servers: [{ connection: 'approved_otherwise' }] } } });
    expect(JSON.stringify(view)).not.toContain('local:fixture');
  });

  test('a snapshot retained under the earlier tool names is shown; corrupt retained data is unavailable, never replaced', async () => {
    const legacy = await record((snapshot) => ({
      ...snapshot,
      tools: (snapshot.tools as { serverId: string; toolName: string; adapted: object }[]).map((tool) => ({
        ...tool,
        adapted: { ...tool.adapted, name: legacyMcpToolName(tool.serverId, tool.toolName) },
      })),
    }));
    expect(runCapabilitiesView(legacy, undefined, policy).kind).toBe('command');
    const corrupt = await record();
    (corrupt.binding as { payload: { input: { arguments: string } } }).payload.input.arguments = 'changed';
    expect(runCapabilitiesView(corrupt, undefined, policy)).toEqual({
      kind: 'unavailable',
      reason: 'snapshot_unreadable',
      throughSeq: '12',
    });
    expect(
      runCapabilitiesView({ throughSeq: '3', delegates: [], operations: [], loadedSkills: [] }, undefined, policy),
    ).toEqual({ kind: 'native', throughSeq: '3' });
  });
});
