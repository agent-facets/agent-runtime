import { afterAll, describe, expect, test } from 'bun:test';
import { AIMessage, type BaseMessage, ToolMessage } from '@langchain/core/messages';
import { MemorySaver } from '@langchain/langgraph';
import { capabilitiesFor, commandFixture } from '../../test-support/lifecycle/wiring.ts';
import { MemoryLedger } from '../../test-support/memory-ledger.ts';
import { ScriptedModel } from '../../test-support/scripted-model.ts';
import { createFixture } from '../../test-support/workspace.ts';
import type { CapabilityConfig } from '../config/capabilities.ts';
import { exactSecretMatcher } from '../credentials/matcher.ts';
import { createContentPolicy, REDACTION } from '../security/content-policy.ts';
import { createExecutionAgent, type ExecutionAgentOptions, executionAgentParams } from './agent.ts';
import { currentCodeManifest } from './code-manifest.ts';
import { executionDefinition } from './definition.ts';
import type { ToolCallIdentity } from './operations.ts';
import {
  frozenMembership,
  LOAD_SKILL_TOOL,
  LOADED_SKILLS_METADATA,
  READ_REFERENCE_TOOL,
  retainedSkillsFor,
} from './skills.ts';

const fixture = createFixture();
afterAll(() => fixture.cleanup());
fixture.write('notes/plan.md', 'alpha\n');
const RUN = '00000000-0000-4000-8000-000000000002';
const SECRET = 'synthetic-skill-reference-secret-01';
const policy = createContentPolicy(exactSecretMatcher([SECRET]));
const origin = { facet: 'fixture-workflows', version: '0.0.1', source: 'local:fixture', integrity: 'sha256-x' };
const resource = (path: string, text: string | Uint8Array) => {
  const bytes = typeof text === 'string' ? new TextEncoder().encode(text) : text;
  return {
    path,
    byteLength: bytes.byteLength,
    sha256: new Bun.CryptoHasher('sha256').update(bytes).digest('hex'),
    content: Buffer.from(bytes).toString('base64'),
  };
};
const skill = (name: string, resources: unknown[] = [], extra: Record<string, unknown> = {}) => ({
  id: `skill:${name}`,
  name,
  description: `The ${name} skill.`,
  origins: [origin],
  exportDigest: 'a'.repeat(64),
  requires: [],
  instructions: `FULL INSTRUCTIONS FOR ${name}.`,
  resources,
  ...extra,
});
const guideText = `# Guide\nthe key is ${SECRET} here\n`;
const lines = Array.from({ length: 300 }, (_, index) => `line ${index + 1}`).join('\n');

function capabilities() {
  const { snapshot, input } = commandFixture();
  return capabilitiesFor(
    {
      ...snapshot,
      skills: [
        skill('review', [
          resource('references/guide.md', guideText),
          resource('references/long.md', lines),
          resource('assets/blob.bin', new Uint8Array([0xff, 0xfe])),
        ]),
        skill('notes'),
        skill('hidden'),
      ],
      authority: { ...snapshot.authority, skills: ['skill:review', 'skill:notes'] },
      agents: [
        ...snapshot.agents,
        {
          id: 'agent:reviewer',
          name: 'reviewer',
          description: 'Reviews.',
          origins: [origin],
          exportDigest: 'a'.repeat(64),
          requires: [],
          instructions: 'Review.',
          restrict: { skills: ['skill:notes'] },
        },
      ],
      command: { ...snapshot.command, requires: [] },
    },
    input,
  );
}
const grants = (allowSkills: string[] = ['skill:review', 'skill:notes']): CapabilityConfig => ({
  installation: { path: '/etc/agent-runtime/facets/installation.json', sha256: 'a'.repeat(64) },
  allowSkills,
  allowAgents: [],
  maxDelegationsPerRun: 8,
  localPrograms: {},
  servers: [],
});

/** A ledger that, like the store, records membership in the same step as a successful load's outcome. */
class SkillLedger extends MemoryLedger {
  readonly loaded = new Set<string>();
  override async complete(identity: ToolCallIdentity, outcome: Parameters<MemoryLedger['complete']>[1]) {
    await super.complete(identity, outcome);
    if (identity.binding?.kind === 'skill_load' && outcome.outcome === 'ok') this.loaded.add(identity.binding.skillId);
  }
}

function options(model: ScriptedModel, ledger: SkillLedger, current = grants()): ExecutionAgentOptions {
  return {
    runId: RUN,
    model,
    checkpointer: new MemorySaver(),
    workspace: fixture.policy(),
    contentPolicy: () => policy,
    operations: ledger,
    scope: {
      actor: { kind: 'root' },
      capabilities: capabilities(),
      skills: { current, loaded: async () => [...ledger.loaded] },
    },
  };
}
const call = (name: string, args: Record<string, unknown>) => ({ id: `call-${crypto.randomUUID()}`, name, args });
const turn =
  (...calls: ReturnType<typeof call>[]) =>
  () =>
    new AIMessage({ id: `m-${crypto.randomUUID()}`, content: '', tool_calls: calls });
const results = (messages: BaseMessage[]) =>
  messages.filter((message) => ToolMessage.isInstance(message)).map((message) => JSON.parse(String(message.content)));

async function run(steps: (() => AIMessage)[], current = grants()) {
  const model = new ScriptedModel([...steps, () => new AIMessage({ id: 'm-final', content: 'Done.' })]);
  const ledger = new SkillLedger();
  const agent = createExecutionAgent(options(model, ledger, current));
  const state = await agent.invoke(
    { messages: [{ role: 'user', content: 'Triage.' }] },
    { configurable: { thread_id: RUN } },
  );
  return { messages: state.messages as BaseMessage[], ledger };
}

describe('skill advertisement', () => {
  test('an actor sees its retained skills by ID and description only; delegates are narrowed by their agent', () => {
    const params = executionAgentParams(options(new ScriptedModel([]), new SkillLedger()));
    const load = params.tools.find((tool) => tool.name === LOAD_SKILL_TOOL);
    expect(params.tools.map((tool) => tool.name)).toContain(READ_REFERENCE_TOOL);
    expect(load?.description).toContain('skill:review: The review skill.');
    expect(load?.description).toContain('skill:notes: The notes skill.');
    expect(load?.description).not.toContain('skill:hidden');
    expect(load?.description).not.toContain('FULL INSTRUCTIONS');
    const { snapshot } = capabilities();
    expect(
      retainedSkillsFor(
        snapshot,
        snapshot.agents.find((agent) => agent.id === 'agent:reviewer'),
      ).map((s) => s.id),
    ).toEqual(['skill:notes']);
  });

  test('a native goal run and an actor without the skills port get no skill tools', () => {
    const native = executionAgentParams({ ...options(new ScriptedModel([]), new SkillLedger()), scope: undefined });
    expect(native.tools.map((tool) => tool.name)).toEqual(['mcp_Read', 'mcp_Search', 'mcp_AskUser']);
  });
});

describe('loading skills and reading references', () => {
  test('a load returns instructions; a sibling load does not enable a same-response reference; a later one does', async () => {
    const read = { skill: 'skill:review', path: 'references/guide.md' };
    const { messages, ledger } = await run([
      turn(
        call(LOAD_SKILL_TOOL, { skill: 'skill:review' }),
        call(READ_REFERENCE_TOOL, read),
        call('mcp_Read', { mode: 'file', path: 'notes/plan.md' }),
      ),
      turn(call(READ_REFERENCE_TOOL, read)),
    ]);
    const [load, early, native, later] = results(messages);
    expect(load).toEqual({
      outcome: 'ok',
      result: {
        skill: 'skill:review',
        text: 'FULL INSTRUCTIONS FOR review.',
        references: [
          { path: 'references/guide.md', bytes: new TextEncoder().encode(guideText).byteLength },
          { path: 'references/long.md', bytes: new TextEncoder().encode(lines).byteLength },
          { path: 'assets/blob.bin', bytes: 2 },
        ],
      },
    });
    expect(early).toMatchObject({ outcome: 'refused', code: 'skill_not_loaded' });
    expect(native).toMatchObject({ outcome: 'ok' });
    // The whole reference is screened before lines are returned.
    expect(later).toEqual({
      outcome: 'ok',
      result: {
        skill: 'skill:review',
        path: 'references/guide.md',
        totalLines: 2,
        startLine: 1,
        lines: [
          { line: 1, text: '# Guide' },
          { line: 2, text: `the key is ${REDACTION} here` },
        ],
        complete: true,
      },
    });
    expect(JSON.stringify(messages.map((message) => message.content))).not.toContain(SECRET);
    expect([...ledger.loaded]).toEqual(['skill:review']);
    // Each response carries the membership it was produced under.
    const frozen = messages
      .filter((message) => AIMessage.isInstance(message))
      .map((message) => (message as AIMessage).response_metadata?.[LOADED_SKILLS_METADATA]);
    expect(frozen).toEqual([[], ['skill:review'], ['skill:review']]);
  });

  test('references page within bounds, refuse binary or unknown paths, and never reach the filesystem', async () => {
    const page = (args: Record<string, unknown>) => call(READ_REFERENCE_TOOL, { skill: 'skill:review', ...args });
    const { messages } = await run([
      turn(call(LOAD_SKILL_TOOL, { skill: 'skill:review' })),
      turn(
        page({ path: 'references/long.md', startLine: 250, lineLimit: 10 }),
        page({ path: 'assets/blob.bin' }),
        page({ path: 'references/missing.md' }),
        page({ path: '../../etc/passwd' }),
        page({ path: 'references/long.md', lineLimit: 2001 }),
      ),
    ]);
    const [, paged, binary, missing, escaping, oversized] = results(messages);
    expect(paged.result).toMatchObject({ totalLines: 300, startLine: 250, complete: false, nextStartLine: 260 });
    expect(paged.result.lines.map((entry: { line: number }) => entry.line)).toEqual([
      250, 251, 252, 253, 254, 255, 256, 257, 258, 259,
    ]);
    expect([binary.code, missing.code, escaping.code, oversized.code]).toEqual([
      'reference_not_text',
      'reference_missing',
      'invalid_argument',
      'invalid_argument',
    ]);
  });

  test('unavailable skills are refused; current grants narrow new loads only', async () => {
    const { messages, ledger } = await run(
      [
        turn(
          call(LOAD_SKILL_TOOL, { skill: 'skill:hidden' }),
          call(LOAD_SKILL_TOOL, { skill: 'skill:review' }),
          call(LOAD_SKILL_TOOL, { skill: 'skill:notes' }),
        ),
      ],
      grants(['skill:notes']),
    );
    expect(results(messages).map((result) => result.code ?? result.outcome)).toEqual([
      'skill_unavailable',
      'skill_not_permitted',
      'ok',
    ]);
    // Repeated loads of a skill keep one membership; refusals add none.
    expect([...ledger.loaded]).toEqual(['skill:notes']);
  });
});

describe('frozen membership', () => {
  const retained = capabilities().snapshot.skills.filter((s) => s.id !== 'skill:hidden');
  const issued = (value: unknown) => [
    new AIMessage({
      id: 'm1',
      content: '',
      tool_calls: [{ id: 'c1', name: READ_REFERENCE_TOOL, args: {} }],
      response_metadata: { [LOADED_SKILLS_METADATA]: value },
    }),
  ];

  test('is read from the issuing response and validated, never trusted as-is', () => {
    expect(frozenMembership(issued(['skill:review']), 'c1', retained)).toEqual(new Set(['skill:review']));
    for (const value of [undefined, 'skill:review', ['skill:hidden'], ['skill:review', 'skill:review'], [1]]) {
      expect(frozenMembership(issued(value), 'c1', retained)).toBeUndefined();
    }
    expect(frozenMembership(issued(['skill:review']), 'other', retained)).toBeUndefined();
  });
});

describe('skills in execution compatibility', () => {
  const binding = {
    provider: 'anthropic' as const,
    authMode: 'subscription' as const,
    model: 'claude-test',
    profileId: 'anthropic.subscription.v1',
    credentialSlot: 'anthropic-default',
  };
  const definitionOf = async (
    current: CapabilityConfig | undefined,
    code?: Awaited<ReturnType<typeof currentCodeManifest>>,
  ) => {
    const built = options(new ScriptedModel([]), new SkillLedger(), current as CapabilityConfig);
    return executionDefinition({
      code: code ?? (await currentCodeManifest('anthropic')),
      agent: createExecutionAgent(built),
      params: executionAgentParams(built),
      binding,
      workspacePolicyDigest: 'c'.repeat(64),
    });
  };

  test("revoking or changing current grants never changes a run's definition", async () => {
    const granted = await definitionOf(grants());
    expect((await definitionOf(grants([]))).digest).toBe(granted.digest);
    expect((await definitionOf(undefined)).digest).toBe(granted.digest);
    expect(granted.manifest.capabilities).toMatchObject({ skillProtocol: 1 });
    const tools = (granted.manifest.tools as { name: string }[]).map((entry) => entry.name);
    expect(tools).toEqual(expect.arrayContaining([LOAD_SKILL_TOOL, READ_REFERENCE_TOOL]));
  });

  test('a change to the skill code changes the definition', async () => {
    const code = await currentCodeManifest('anthropic');
    const changed = {
      ...code,
      executionCode: code.executionCode.map((entry) =>
        entry.path === 'src/execution/skills.ts' ? { ...entry, digest: 'd'.repeat(64) } : entry,
      ),
    };
    expect((await definitionOf(grants(), changed)).digest).not.toBe((await definitionOf(grants(), code)).digest);
  });
});
