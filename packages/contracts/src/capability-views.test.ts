import { describe, expect, test } from 'bun:test';
import {
  catalogViewSchema,
  discoverServerSchema,
  runCapabilitiesSchema,
  serverViewSchema,
} from './capability-views.ts';

const D = 'd'.repeat(64);
const origin = { facet: 'workflows', version: '1.0.0', integrity: `sha256:${'f'.repeat(64)}` };
const server = {
  serverId: 'github',
  origins: [origin],
  transport: 'stdio',
  connection: { kind: 'approved', currentDigest: D },
  grants: [{ tool: 'list_issues', definitionDigest: D, argumentEquals: { token: { kind: 'withheld' } } }],
};

describe('capability views', () => {
  test('a server view carries approval and grants, never its launch configuration or credentials', () => {
    expect(serverViewSchema.safeParse(server).success).toBe(true);
    for (const extra of [
      { declaration: { command: '/opt/x' } },
      { credentialEnv: { TOKEN: 'slot' } },
      { programId: 'github' },
      { bundlePath: '/opt/agent-runtime/mcp/github/x.js' },
    ]) {
      expect(serverViewSchema.safeParse({ ...server, ...extra }).success).toBe(false);
    }
    const leaky = {
      ...server,
      grants: [{ ...server.grants[0], argumentEquals: { token: { kind: 'value', value: 'a\u0007' } } }],
    };
    expect(serverViewSchema.safeParse(leaky).success).toBe(false);
  });

  test('the catalog distinguishes unconfigured, unavailable and ready; discovery names only a revision', () => {
    expect(catalogViewSchema.safeParse({ kind: 'unconfigured' }).success).toBe(true);
    expect(catalogViewSchema.safeParse({ kind: 'unavailable', reason: 'installation_missing' }).success).toBe(true);
    expect(
      catalogViewSchema.safeParse({ kind: 'ready', catalogRevision: D, contributions: [], servers: [server] }).success,
    ).toBe(true);
    expect(
      catalogViewSchema.safeParse({ kind: 'ready', catalogRevision: D, contributions: [], servers: [], path: '/etc' })
        .success,
    ).toBe(false);
    expect(discoverServerSchema.safeParse({ catalogRevision: D }).success).toBe(true);
    for (const body of [{}, { catalogRevision: D, serverId: 'github' }, { catalogRevision: 'x' }]) {
      expect(discoverServerSchema.safeParse(body).success).toBe(false);
    }
  });

  test("a run's view never carries the retained snapshot, checkpoint bindings or tool arguments", () => {
    expect(runCapabilitiesSchema.safeParse({ kind: 'native', throughSeq: '0' }).success).toBe(true);
    expect(runCapabilitiesSchema.safeParse({ kind: 'native', throughSeq: '0', snapshot: {} }).success).toBe(false);
    expect(
      runCapabilitiesSchema.safeParse({ kind: 'unavailable', reason: 'snapshot_unreadable', throughSeq: '3' }).success,
    ).toBe(true);
    const command = {
      kind: 'command',
      throughSeq: '9',
      snapshotDigest: D,
      command: {
        id: 'command:triage',
        name: 'triage',
        origins: [origin],
        selectionRevision: D,
        arguments: '',
        renderedGoal: 'Triage.',
      },
      bound: { skills: [], agents: [], tools: [] },
      used: {
        operations: [],
        loadedSkills: [],
        delegations: [{ delegationId: D, agentId: 'agent:helper', state: 'result' }],
      },
      limits: { maxDelegations: 8, delegationDepth: 1 },
      permissions: {
        captured: { native: ['mcp_Read'], skills: [], agents: [], servers: [] },
        current: { kind: 'unconfigured' },
      },
    };
    expect(runCapabilitiesSchema.safeParse(command).success).toBe(true);
    const withBinding = {
      ...command,
      used: { ...command.used, delegations: [{ ...command.used.delegations[0], checkpointNs: 'tools:x' }] },
    };
    expect(runCapabilitiesSchema.safeParse(withBinding).success).toBe(false);
    expect(runCapabilitiesSchema.safeParse({ ...command, snapshot: {} }).success).toBe(false);
  });
});
