import { describe, expect, test } from 'bun:test';
import { MemorySaver } from '@langchain/langgraph';
import { capabilitiesFor, commandFixture } from '../../test-support/lifecycle/wiring.ts';
import { withMcp } from '../../test-support/mcp-snapshot.ts';
import { MemoryLedger } from '../../test-support/memory-ledger.ts';
import { AIMessage, ScriptedModel, ToolMessage } from '../../test-support/scripted-model.ts';
import { createFixture } from '../../test-support/workspace.ts';
import { legacyMcpToolName, openSnapshot, sealSnapshot } from '../capabilities/records.ts';
import { NO_KNOWN_CREDENTIALS } from '../credentials/matcher.ts';
import { InvocationConnections } from '../mcp/connections.ts';
import { digestOf } from '../records/canonical.ts';
import { createContentPolicy } from '../security/content-policy.ts';
import {
  createExecutionAgent,
  type ExecutionAgentOptions,
  executionAgentParams,
  MCP_PROMPT,
  SYSTEM_PROMPT,
} from './agent.ts';
import { executionFailureOf } from './failures.ts';
import type { McpPort } from './mcp.ts';
import { mcpBindings, retainedMcpToolsFor } from './mcp.ts';
import { identityFor } from './operations.ts';

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

const canonical = (tool: string) => `mcp_repo_${tool}`;

describe('runtime-owned MCP tools', () => {
  test('retained granted tools are offered under their canonical names, without starting anything', async () => {
    const counts = { reads: 0 };
    const run = await capabilities();
    const params = executionAgentParams(options({ actor: { kind: 'root' }, capabilities: run, mcp: port(counts) }));
    const names = params.tools.map((tool) => tool.name);
    expect(names).toEqual(expect.arrayContaining([canonical('list_items'), canonical('comment')]));
    // Retained, but outside the run's authority ceiling: never offered.
    expect(names).not.toContain(canonical('delete_repo'));
    const list = params.tools.find((tool) => tool.name === canonical('list_items'));
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
    expect(mcpBindings(run.snapshot).get(canonical('list_items'))).toEqual({
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
    expect(params.tools.some((tool) => tool.name.startsWith('mcp_repo_'))).toBe(false);
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
    expect(params.tools.some((tool) => tool.name.startsWith('mcp_repo_'))).toBe(false);
    expect(params.systemPrompt).toBe(SYSTEM_PROMPT);
  });

  test('colliding, reserved or mismatched model-facing names are refused when the definitions are retained', async () => {
    const run = await capabilities();
    const tools = run.snapshot.tools;
    const [first, second] = tools as [(typeof tools)[number], (typeof tools)[number]];
    expect(() =>
      sealSnapshot({
        ...run.snapshot,
        tools: [first, { ...second, adapted: { ...second.adapted, name: first.adapted.name } }],
      }),
    ).toThrow();
    for (const name of ['mcp_Read', 'mcp_repo_other', 'mcp_ext_x', `mcp_ext_${'0'.repeat(48)}`]) {
      expect(() =>
        sealSnapshot({ ...run.snapshot, tools: [{ ...first, adapted: { ...first.adapted, name } }] }),
      ).toThrow();
    }
  });

  test('a snapshot retained under the earlier derived name stays readable, byte for byte', async () => {
    const run = await capabilities();
    const legacy = {
      ...run.snapshot,
      tools: run.snapshot.tools.map((tool) => ({
        ...tool,
        adapted: { ...tool.adapted, name: legacyMcpToolName(tool.serverId, tool.toolName) },
      })),
    };
    const sealed = sealSnapshot(legacy);
    expect(sealed.payload.tools.map((tool) => tool.adapted.name)).toEqual(
      legacy.tools.map((tool) => tool.adapted.name),
    );
    expect(openSnapshot(sealed.digest, JSON.parse(sealed.canonical)).tools[0]?.adapted.name).toMatch(
      /^mcp_ext_[0-9a-f]{48}$/,
    );
  });

  test('an exact completed call is answered from its record before any permission check, even after revocation', async () => {
    const counts = { reads: 0 };
    const run = await capabilities();
    const ledger = new MemoryLedger();
    const call = { id: 'c1', name: canonical('list_items'), args: { repository: 'owner/repo-a' } };
    const binding = mcpBindings(run.snapshot).get(canonical('list_items'));
    const identity = identityFor(RUN, 'm1', call, { actor: { kind: 'root' }, ...(binding ? { binding } : {}) });
    if (identity === undefined) throw new Error('unrepresentable');
    const recorded = { outcome: 'ok' as const, result: { text: 'recorded' } };
    ledger.rows.set('c1', { identity, outcome: recorded });
    const model = new ScriptedModel([
      () => new AIMessage({ id: 'm1', content: '', tool_calls: [{ ...call, type: 'tool_call' }] }),
      () => new AIMessage({ id: 'm2', content: 'Done.' }),
    ]);
    // The owner has since revoked everything: a new call would be refused, but this one is not new.
    const revoked: McpPort = {
      ...port(counts),
      current: {
        installation: { path: '/etc/agent-runtime/facets/installation.json', sha256: 'd'.repeat(64) },
        allowSkills: [],
        allowAgents: [],
        maxDelegationsPerRun: 8,
        localPrograms: {},
        servers: [],
      },
    };
    const agent = createExecutionAgent({
      ...options({ actor: { kind: 'root' }, capabilities: run, mcp: revoked }),
      model,
      operations: ledger,
    });
    await agent.invoke({ messages: [{ role: 'user', content: 'List.' }] }, { configurable: { thread_id: RUN } });
    expect(ledger.log).toEqual([`reuse:${canonical('list_items')}`]);
    expect(counts.reads).toBe(0);
    const replayed = model.calls[1]?.messages.at(-1);
    expect(ToolMessage.isInstance(replayed) && JSON.parse(replayed.content as string)).toEqual(recorded);
  });

  test('a call whose dispatch intent has no recorded outcome is never sent again: the run stops', async () => {
    const counts = { reads: 0 };
    const run = await capabilities();
    const call = { id: 'c1', name: canonical('list_items'), args: { repository: 'owner/repo-a' } };
    const model = new ScriptedModel([
      () => new AIMessage({ id: 'm1', content: '', tool_calls: [{ ...call, type: 'tool_call' }] }),
    ]);
    const agent = createExecutionAgent({
      ...options({ actor: { kind: 'root' }, capabilities: run, mcp: port(counts) }),
      model,
      operations: { start: async () => ({ kind: 'unresolved' }), complete: async () => {} },
    });
    const failure = await agent
      .invoke({ messages: [{ role: 'user', content: 'List.' }] }, { configurable: { thread_id: `${RUN}-u` } })
      .catch((error: unknown) => error);
    expect(executionFailureOf(failure)?.code).toBe('mcp_outcome_unknown');
    expect(model.calls).toHaveLength(1);
    expect(counts.reads).toBe(0);
  });

  test('a tool is bound to its retained server and tool, never to parts split from its name', async () => {
    const { snapshot } = commandFixture();
    const equipped = await withMcp(snapshot, [
      { serverId: 'git_hub', serverDigest: SERVER, tools: [{ ...comment, name: 'list_issues' }] },
    ]);
    const name = 'mcp_git_hub_list_issues';
    const sealed = sealSnapshot(equipped).payload;
    expect(sealed.tools.map((tool) => tool.adapted.name)).toEqual([name]);
    expect(mcpBindings(sealed).get(name)).toEqual({
      kind: 'mcp',
      serverId: 'git_hub',
      toolName: 'list_issues',
      definitionDigest: digestOf({ ...comment, name: 'list_issues' }),
    });
  });
});
