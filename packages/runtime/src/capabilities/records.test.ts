import { describe, expect, test } from 'bun:test';
import { sha256Hex } from '../records/canonical.ts';
import {
  actorKeyOf,
  agentDefinitionSchema,
  CAPABILITY_LIMITS,
  CapabilityRecordError,
  capabilitySnapshotSchema,
  commandRunInputSchema,
  delegateOutcomeSchema,
  delegateStateSchema,
  externalOutcomeSchema,
  loadedSkillSchema,
  mcpToolDefinitionSchema,
  openSnapshot,
  runActorSchema,
  sealSnapshot,
  skillDefinitionSchema,
  skillResourceSchema,
} from './records.ts';

const D = 'a'.repeat(64);
const E = 'e'.repeat(64);
const origin = { facet: 'workflows', version: '1.2.0', source: 'local:facets/workflows', integrity: `sha256-${D}` };

function resource(path: string, bytes: Uint8Array | string) {
  const data = typeof bytes === 'string' ? Buffer.from(bytes) : Buffer.from(bytes);
  return { path, byteLength: data.byteLength, sha256: sha256OfBytes(data), content: data.toString('base64') };
}
function sha256OfBytes(data: Uint8Array) {
  return new Bun.CryptoHasher('sha256').update(data).digest('hex');
}

const skill = (name: string, extra: Record<string, unknown> = {}) => ({
  id: `skill:${name}`,
  name,
  description: 'Reviews a change.',
  origins: [origin],
  exportDigest: D,
  requires: [],
  instructions: 'Read the diff, then report.',
  resources: [resource('references/guide.md', '# Guide\n')],
  ...extra,
});
const agent = (name: string, extra: Record<string, unknown> = {}) => ({
  id: `agent:${name}`,
  name,
  description: 'Investigates one question.',
  origins: [origin],
  exportDigest: D,
  requires: [{ kind: 'skill', id: 'skill:review' }],
  instructions: 'Answer the task.',
  restrict: { native: ['mcp_Read'], mcp: [] },
  ...extra,
});
const tool = (toolName: string, extra: Record<string, unknown> = {}) => ({
  serverId: 'github',
  toolName,
  raw: {
    name: toolName,
    description: 'Lists issues.',
    inputSchema: { type: 'object', properties: { repository: { type: 'string' } }, additionalProperties: false },
  },
  definitionDigest: D,
  adapted: {
    name: `mcp_github_${toolName}`,
    description: 'github / list_issues: Lists issues.',
    schema: { type: 'object' },
  },
  ...extra,
});

function snapshot(extra: Record<string, unknown> = {}) {
  return {
    version: 1,
    profile: 1,
    installation: { sha256: D },
    command: {
      id: 'command:triage',
      name: 'triage',
      description: 'Triage issues.',
      origins: [origin],
      exportDigest: D,
      requires: [
        { kind: 'skill', id: 'skill:review' },
        { kind: 'agent', id: 'agent:helper' },
        { kind: 'native', name: 'mcp_Read' },
        { kind: 'mcp', serverId: 'github', toolName: 'list_issues' },
      ],
      body: 'Triage $ARGUMENTS',
      arguments: { required: true },
      restrict: { skills: ['skill:review'] },
    },
    input: { arguments: 'owner/repo-a', renderedGoal: 'Triage owner/repo-a' },
    skills: [skill('review')],
    agents: [agent('helper')],
    servers: [
      {
        serverId: 'github',
        origins: [origin],
        declaration: { command: 'github-mcp' },
        programId: 'github',
        serverDigest: D,
      },
    ],
    tools: [tool('list_issues')],
    authority: {
      native: ['mcp_Read', 'mcp_Search', 'mcp_AskUser'],
      skills: ['skill:review'],
      agents: ['agent:helper'],
      servers: [
        {
          serverId: 'github',
          serverDigest: D,
          tools: [{ name: 'list_issues', definitionDigest: D, argumentEquals: { repository: 'owner/repo-a' } }],
        },
      ],
    },
    limits: { maxDelegations: 8, delegationDepth: 1 },
    ...extra,
  };
}

const parses = (value: unknown) => capabilitySnapshotSchema.safeParse(value).success;

describe('capability snapshots', () => {
  test('accept a complete snapshot and seal it to its canonical content address', () => {
    expect(parses(snapshot())).toBe(true);
    const sealed = sealSnapshot(snapshot());
    expect(sealed.digest).toBe(sha256Hex(sealed.canonical));
    expect(openSnapshot(sealed.digest, JSON.parse(sealed.canonical))).toEqual(sealed.payload);
  });

  test('the content address is independent of input key order', () => {
    const value = snapshot();
    const reversed = JSON.parse(JSON.stringify(value), (_key, item) =>
      item !== null && typeof item === 'object' && !Array.isArray(item)
        ? Object.fromEntries(Object.entries(item).reverse())
        : item,
    );
    expect(sealSnapshot(reversed).digest).toBe(sealSnapshot(value).digest);
  });

  test('a stored snapshot that does not match its address is refused', () => {
    const sealed = sealSnapshot(snapshot());
    const altered = { ...sealed.payload, input: { ...sealed.payload.input, arguments: 'owner/repo-b' } };
    expect(() => openSnapshot(sealed.digest, altered)).toThrow(CapabilityRecordError);
    expect(() => openSnapshot(sealed.digest, { ...sealed.payload, extra: 1 })).toThrow(CapabilityRecordError);
  });

  test('refuses unknown fields, other versions and contradictory references', () => {
    const invalid = [
      snapshot({ extra: true }),
      snapshot({ version: 2 }),
      snapshot({ profile: 2 }),
      snapshot({ grants: [] }),
      snapshot({ skills: [skill('review'), skill('review')] }),
      snapshot({ servers: [] }),
      snapshot({ tools: [tool('list_issues'), tool('list_issues')] }),
      snapshot({ tools: [tool('a'), tool('b', { adapted: tool('a').adapted })] }),
      snapshot({ skills: [skill('review', { id: 'skill:other' })] }),
      snapshot({ skills: [skill('review', { restrict: {} })] }),
      snapshot({ agents: [agent('helper', { id: 'skill:helper' })] }),
      snapshot({ tools: [tool('list_issues', { raw: { ...tool('x').raw, name: 'x' } })] }),
      snapshot({ limits: { maxDelegations: 8, delegationDepth: 2 } }),
    ];
    for (const value of invalid) expect(parses(value)).toBe(false);
  });

  test('refuses invalid identifiers and names', () => {
    for (const [field, value] of [
      ['servers', [{ ...snapshot().servers[0], serverId: '../github' }]],
      ['skills', [skill('Review')]],
      ['agents', [agent('helper', { requires: [{ kind: 'agent', id: 'helper' }] })]],
      ['agents', [agent('helper', { restrict: { native: ['shell'] } })]],
      ['agents', [agent('helper', { origins: [] })]],
      ['agents', [agent('helper', { origins: [{ ...origin, version: 'v1\n' }] })]],
    ] as const) {
      expect(parses(snapshot({ [field]: value }))).toBe(false);
    }
    expect(parses(snapshot({ authority: { ...snapshot().authority, native: ['mcp_Read', 'mcp_Read'] } }))).toBe(false);
  });

  test('enforces the delegation limit range', () => {
    for (const [maxDelegations, ok] of [
      [1, true],
      [32, true],
      [0, false],
      [33, false],
    ] as const) {
      expect(parses(snapshot({ limits: { maxDelegations, delegationDepth: 1 } }))).toBe(ok);
    }
  });

  test('enforces contribution counts', () => {
    const skills = (n: number) => Array.from({ length: n }, (_, i) => skill(`s${i}`, { resources: [] }));
    const agents = (n: number) => Array.from({ length: n }, (_, i) => agent(`a${i}`));
    const servers = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ ...snapshot().servers[0], serverId: i === 0 ? 'github' : `s${i}` }));
    const tools = (n: number) => Array.from({ length: n }, (_, i) => tool(`t${i}`));
    expect(parses(snapshot({ skills: skills(32) }))).toBe(true);
    expect(parses(snapshot({ skills: skills(33) }))).toBe(false);
    expect(parses(snapshot({ agents: agents(16) }))).toBe(true);
    expect(parses(snapshot({ agents: agents(17) }))).toBe(false);
    expect(parses(snapshot({ servers: servers(8) }))).toBe(true);
    expect(parses(snapshot({ servers: servers(9) }))).toBe(false);
    expect(parses(snapshot({ tools: tools(64) }))).toBe(true);
    expect(parses(snapshot({ tools: tools(65) }))).toBe(false);
  });

  test('enforces goal, task and instruction byte limits', () => {
    const goal = (renderedGoal: string) => snapshot({ input: { arguments: '', renderedGoal } });
    expect(parses(goal('é'.repeat(4096)))).toBe(true);
    expect(parses(goal(`${'é'.repeat(4096)}a`))).toBe(false);
    expect(parses(goal('   '))).toBe(false);
    const instructions = (text: string) => snapshot({ skills: [skill('review', { instructions: text })] });
    expect(parses(instructions('a'.repeat(CAPABILITY_LIMITS.skillInstructionBytes)))).toBe(true);
    expect(parses(instructions('a'.repeat(CAPABILITY_LIMITS.skillInstructionBytes + 1)))).toBe(false);
    expect(parses(instructions('a\u0000'))).toBe(false);
  });

  test('keeps skill resources lossless, digest-checked and at most 1 MiB each', () => {
    const exact = new Uint8Array(CAPABILITY_LIMITS.referenceBytes).fill(0x61);
    expect(skillResourceSchema.safeParse(resource('big.txt', exact)).success).toBe(true);
    const over = new Uint8Array(CAPABILITY_LIMITS.referenceBytes + 1).fill(0x61);
    expect(skillResourceSchema.safeParse(resource('big.txt', over)).success).toBe(false);
    // Non-UTF-8 bytes are retained losslessly; they are refused only when read as text.
    expect(skillResourceSchema.safeParse(resource('image.bin', new Uint8Array([0xff, 0xfe, 0x00]))).success).toBe(true);
    const tampered = { ...resource('a.md', 'one'), content: Buffer.from('two').toString('base64') };
    expect(skillResourceSchema.safeParse(tampered).success).toBe(false);
    for (const path of ['../escape.md', '/abs.md', 'a//b.md', 'a/./b.md', 'a\\b.md', '']) {
      expect(skillResourceSchema.safeParse(resource(path, 'x')).success).toBe(false);
    }
    const duplicate = [resource('a.md', 'x'), resource('a.md', 'y')];
    expect(skillDefinitionSchema.safeParse(skill('review', { resources: duplicate })).success).toBe(false);
  });

  test('bounds advertised tool definitions by size, schema depth and property count', () => {
    const nested = (depth: number): Record<string, unknown> =>
      depth === 1 ? { type: 'string' } : { type: 'object', properties: { next: nested(depth - 1) } };
    const withSchema = (inputSchema: unknown) => tool('x', { raw: { name: 'x', inputSchema } });
    expect(mcpToolDefinitionSchema.safeParse(withSchema(nested(8))).success).toBe(true);
    expect(mcpToolDefinitionSchema.safeParse(withSchema(nested(9))).success).toBe(false);
    const properties = (n: number) => ({
      type: 'object',
      properties: Object.fromEntries(Array.from({ length: n }, (_, i) => [`p${i}`, { type: 'string' }])),
    });
    expect(mcpToolDefinitionSchema.safeParse(withSchema(properties(256))).success).toBe(true);
    expect(mcpToolDefinitionSchema.safeParse(withSchema(properties(257))).success).toBe(false);
    const large = tool('x', { raw: { name: 'x', description: 'd'.repeat(CAPABILITY_LIMITS.toolDefinitionBytes) } });
    expect(mcpToolDefinitionSchema.safeParse(large).success).toBe(false);
  });

  test('refuses a snapshot whose canonical payload exceeds 16 MiB', () => {
    const block = new Uint8Array(CAPABILITY_LIMITS.referenceBytes).fill(0x61);
    const heavy = (count: number) =>
      Array.from({ length: count }, (_, i) =>
        skill(`s${i}`, { resources: [resource('a.txt', block), resource('b.txt', block)] }),
      );
    expect(() => sealSnapshot(snapshot({ skills: heavy(5) }))).not.toThrow();
    let error: unknown;
    try {
      sealSnapshot(snapshot({ skills: heavy(7) }));
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(CapabilityRecordError);
    expect((error as CapabilityRecordError).reason).toBe('snapshot_too_large');
  });
});

describe('command run input', () => {
  test('is exactly the submitted command, revision, raw arguments and provider', () => {
    const input = {
      kind: 'command',
      commandId: 'command:triage',
      selectionRevision: D,
      arguments: '',
      provider: 'openai',
    };
    expect(commandRunInputSchema.safeParse(input).success).toBe(true);
    expect(commandRunInputSchema.safeParse({ ...input, prompt: 'x' }).success).toBe(false);
    expect(commandRunInputSchema.safeParse({ ...input, commandId: 'skill:triage' }).success).toBe(false);
    expect(commandRunInputSchema.safeParse({ ...input, arguments: 'a'.repeat(8193) }).success).toBe(false);
  });
});

describe('actors and outcomes', () => {
  const delegate = {
    kind: 'delegate',
    delegationId: D,
    parentActor: 'root',
    agentId: 'agent:helper',
    taskDigest: E,
    checkpointNs: 'tools:task-1',
    state: { kind: 'active' },
  };

  test('accepts every actor and delegate state variant', () => {
    expect(runActorSchema.safeParse({ kind: 'root' }).success).toBe(true);
    for (const state of [
      { kind: 'active' },
      { kind: 'waiting', questionId: E },
      { kind: 'completed', outcome: { kind: 'result', text: '' } },
      { kind: 'completed', outcome: { kind: 'refused', reason: 'tool_denied', message: 'Denied.' } },
      { kind: 'completed', outcome: { kind: 'failed', reason: 'tool_failed', message: 'Failed.' } },
      { kind: 'abandoned', reason: 'interrupted' },
    ]) {
      expect(delegateStateSchema.safeParse(state).success).toBe(true);
      expect(runActorSchema.safeParse({ ...delegate, state }).success).toBe(true);
    }
  });

  test('refuses contradictory, nested and unknown actor shapes', () => {
    for (const actor of [
      { kind: 'root', delegationId: D },
      { ...delegate, parentActor: E },
      { ...delegate, checkpointNs: '' },
      { ...delegate, agentId: 'helper' },
      { ...delegate, state: { kind: 'waiting' } },
      { ...delegate, state: { kind: 'completed', outcome: { kind: 'result', text: 'x', extra: 1 } } },
      { ...delegate, extra: true },
    ]) {
      expect(runActorSchema.safeParse(actor).success).toBe(false);
    }
    expect(delegateOutcomeSchema.safeParse({ kind: 'result', text: 'a'.repeat(65_537) }).success).toBe(false);
    expect(delegateOutcomeSchema.safeParse({ kind: 'failed', reason: 'X', message: 'm' }).success).toBe(false);
  });

  test('actor keys are root or the delegation operation, never an agent name', () => {
    expect(actorKeyOf({ kind: 'root' })).toBe('root');
    expect(actorKeyOf({ kind: 'delegate', delegationId: D, agentId: 'agent:helper' })).toBe(D);
    const loaded = { actorKey: D, skillId: 'skill:review', operationId: E, definitionDigest: D };
    expect(loadedSkillSchema.safeParse(loaded).success).toBe(true);
    expect(loadedSkillSchema.safeParse({ ...loaded, actorKey: 'agent:helper' }).success).toBe(false);
  });

  test('external outcomes are closed and carry no raw error fields', () => {
    for (const outcome of [
      { kind: 'ok', text: 'done' },
      { kind: 'ok', json: { count: 1 } },
      { kind: 'refused', reason: 'scope_denied', message: 'Not granted.' },
      { kind: 'unavailable', reason: 'server_unavailable', message: 'Unavailable.' },
      { kind: 'failed', reason: 'tool_error', message: 'Failed.' },
      { kind: 'uncertain', reason: 'mcp_outcome_unknown', message: 'Unknown.', operationId: D },
    ]) {
      expect(externalOutcomeSchema.safeParse(outcome).success).toBe(true);
    }
    for (const outcome of [
      { kind: 'failed', reason: 'tool_error', message: 'Failed.', stderr: 'trace' },
      { kind: 'uncertain', reason: 'mcp_outcome_unknown', message: 'Unknown.' },
      { kind: 'ok', text: 'x', raw: {} },
      { kind: 'delivered' },
    ]) {
      expect(externalOutcomeSchema.safeParse(outcome).success).toBe(false);
    }
  });

  test('agents may not declare restrictions outside their allowlist categories', () => {
    expect(agentDefinitionSchema.safeParse(agent('helper', { restrict: { shell: [] } })).success).toBe(false);
    expect(agentDefinitionSchema.safeParse(agent('helper', { model: 'x' })).success).toBe(false);
  });
});
