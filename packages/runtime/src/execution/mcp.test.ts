import { describe, expect, test } from 'bun:test';
import { MemorySaver } from '@langchain/langgraph';
import { capabilitiesFor, commandFixture } from '../../test-support/lifecycle/wiring.ts';
import { withMcp } from '../../test-support/mcp-snapshot.ts';
import { MemoryLedger } from '../../test-support/memory-ledger.ts';
import { ScriptedModel } from '../../test-support/scripted-model.ts';
import { createFixture } from '../../test-support/workspace.ts';
import { sealSnapshot } from '../capabilities/records.ts';
import { NO_KNOWN_CREDENTIALS } from '../credentials/matcher.ts';
import { externalToolName } from '../mcp/adapt.ts';
import { InvocationConnections } from '../mcp/connections.ts';
import { digestOf } from '../records/canonical.ts';
import { createContentPolicy } from '../security/content-policy.ts';
import { type ExecutionAgentOptions, executionAgentParams, MCP_PROMPT, SYSTEM_PROMPT } from './agent.ts';
import type { McpPort } from './mcp.ts';
import { mcpBindings, retainedMcpToolsFor } from './mcp.ts';

const fixture = createFixture();
const RUN = '00000000-0000-4000-8000-000000000003';
const SERVER = 'e'.repeat(64);
const policy = createContentPolicy(NO_KNOWN_CREDENTIALS);
const listItems = {
  name: 'list_items',
  description: 'Lists items in one repository.',
  inputSchema: {
    type: 'object',
    properties: { repository: { type: 'string', description: 'owner/name' } },
    required: ['repository'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true },
};
const comment = { name: 'comment', description: 'Comments.', inputSchema: { type: 'object', properties: {} } };
const remove = { name: 'delete_repo', description: 'Deletes.', inputSchema: { type: 'object', properties: {} } };

async function capabilities(extra: { command?: Record<string, unknown>; narrow?: Record<string, unknown> } = {}) {
  const { snapshot, input } = commandFixture();
  const equipped = await withMcp(snapshot, [
    {
      serverId: 'repo',
      serverDigest: SERVER,
      tools: [listItems, comment, remove],
      argumentEquals: { list_items: { repository: 'owner/repo-a' } },
      ungranted: ['delete_repo'],
    },
  ]);
  return capabilitiesFor(
    {
      ...equipped,
      command: { ...equipped.command, ...extra.command },
      agents: equipped.agents.map((agent) =>
        agent.id === 'agent:narrow' ? { ...agent, ...(extra.narrow ?? { restrict: { mcp: [] } }) } : agent,
      ),
    },
    input,
  );
}

function port(counts: { reads: number }): McpPort {
  return {
    current: undefined,
    connections: new InvocationConnections(),
    launch: {
      stateDir: '/nonexistent',
      bunPath: '/nonexistent/bun',
      readCredential: async () => {
        counts.reads++;
        return { kind: 'missing' };
      },
    },
    signal: () => new AbortController().signal,
  };
}

function options(scope: ExecutionAgentOptions['scope']): ExecutionAgentOptions {
  return {
    runId: RUN,
    model: new ScriptedModel([]),
    checkpointer: new MemorySaver(),
    workspace: fixture.policy(),
    contentPolicy: () => policy,
    operations: new MemoryLedger(),
    ...(scope === undefined ? {} : { scope }),
  };
}

const wire = (tool: string) => externalToolName('repo', tool);

describe('runtime-owned MCP tools', () => {
  test('retained granted tools are offered under stable credential-safe names, without starting anything', async () => {
    const counts = { reads: 0 };
    const run = await capabilities();
    const params = executionAgentParams(options({ actor: { kind: 'root' }, capabilities: run, mcp: port(counts) }));
    const names = params.tools.map((tool) => tool.name);
    expect(names).toEqual(expect.arrayContaining([wire('list_items'), wire('comment')]));
    // Retained, but outside the run's authority ceiling: never offered.
    expect(names).not.toContain(wire('delete_repo'));
    for (const name of [wire('list_items'), wire('comment')]) expect(name).toMatch(/^mcp_ext_[0-9a-f]{48}$/);
    const list = params.tools.find((tool) => tool.name === wire('list_items'));
    expect(list?.description.startsWith('repo / list_items: ')).toBe(true);
    expect(params.systemPrompt).toBe(`${SYSTEM_PROMPT}\n\n${MCP_PROMPT}`);
    // Building tools (and the definitions that describe them) plans no launch and reads no credential.
    expect(counts.reads).toBe(0);
  });

  test('the approval input stays the raw advertised definition; adaptation never alters it', async () => {
    const run = await capabilities();
    const retained = run.snapshot.tools.find((tool) => tool.toolName === 'list_items');
    expect(retained?.raw).toEqual(listItems);
    expect(retained?.definitionDigest).toBe(digestOf(listItems));
    // The adapted model-facing form is plain data, separate from the raw definition.
    expect(JSON.parse(JSON.stringify(retained?.adapted))).toEqual(retained?.adapted);
    expect(mcpBindings(run.snapshot).get(wire('list_items'))).toEqual({
      kind: 'mcp',
      serverId: 'repo',
      toolName: 'list_items',
      definitionDigest: digestOf(listItems),
    });
  });

  test('command and agent restrictions narrow what is offered; a delegate cannot regain an excluded tool', async () => {
    const restricted = await capabilities({
      command: { restrict: { mcp: [{ serverId: 'repo', toolName: 'comment' }] } },
    });
    expect(retainedMcpToolsFor(restricted.snapshot).map((tool) => tool.toolName)).toEqual(['comment']);
    const run = await capabilities({ narrow: { restrict: { mcp: [{ serverId: 'repo', toolName: 'list_items' }] } } });
    const narrow = run.snapshot.agents.find((agent) => agent.id === 'agent:narrow');
    expect(retainedMcpToolsFor(run.snapshot, narrow).map((tool) => tool.toolName)).toEqual(['list_items']);
    const none = await capabilities();
    const params = executionAgentParams(
      options({
        actor: { kind: 'delegate', delegationId: 'd'.repeat(64), agentId: 'agent:narrow' },
        capabilities: none,
        mcp: port({ reads: 0 }),
      }),
    );
    // `narrow` excludes every MCP tool: it gets none, and no external-tool instructions.
    expect(params.tools.some((tool) => tool.name.startsWith('mcp_ext_'))).toBe(false);
    expect(params.systemPrompt).not.toContain(MCP_PROMPT);
  });

  test('goal runs and actors without the MCP port get no external tools', async () => {
    expect(executionAgentParams(options(undefined)).tools.map((tool) => tool.name)).toEqual([
      'mcp_Read',
      'mcp_Search',
      'mcp_AskUser',
    ]);
    const run = await capabilities();
    const params = executionAgentParams(options({ actor: { kind: 'root' }, capabilities: run }));
    expect(params.tools.some((tool) => tool.name.startsWith('mcp_ext_'))).toBe(false);
    expect(params.systemPrompt).toBe(SYSTEM_PROMPT);
  });

  test('colliding or reserved model-facing names are refused when the definitions are retained', async () => {
    const run = await capabilities();
    const tools = run.snapshot.tools;
    const [first, second] = tools as [(typeof tools)[number], (typeof tools)[number]];
    expect(() =>
      sealSnapshot({
        ...run.snapshot,
        tools: [first, { ...second, adapted: { ...second.adapted, name: first.adapted.name } }],
      }),
    ).toThrow();
    expect(() =>
      sealSnapshot({ ...run.snapshot, tools: [{ ...first, adapted: { ...first.adapted, name: 'mcp_Read' } }] }),
    ).toThrow();
  });
});
