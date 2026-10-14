import { describe, expect, test } from 'bun:test';
import { MemorySaver } from '@langchain/langgraph';
import { capabilitiesFor, commandFixture } from '../../test-support/lifecycle/wiring.ts';
import { MemoryLedger } from '../../test-support/memory-ledger.ts';
import { ScriptedModel } from '../../test-support/scripted-model.ts';
import { createFixture } from '../../test-support/workspace.ts';
import { exactSecretMatcher } from '../credentials/matcher.ts';
import { operationIdFor, operationIdV2 } from '../records/schemas.ts';
import { createContentPolicy } from '../security/content-policy.ts';
import { createExecutionAgent, type ExecutionAgentOptions, executionAgentParams, SYSTEM_PROMPT } from './agent.ts';
import { currentCodeManifest } from './code-manifest.ts';
import { executionDefinition } from './definition.ts';
import {
  DELEGATE_PROMPT,
  DELEGATE_TOOL,
  type DelegationPort,
  delegableAgents,
  delegateDescription,
  nativeToolsFor,
} from './delegation.ts';
import { identityFor } from './operations.ts';

const fixture = createFixture();
const RUN = '00000000-0000-4000-8000-000000000001';
const D = 'b'.repeat(64);

const port: DelegationPort = {
  start: async () => ({ kind: 'not_dispatchable' }),
  complete: async () => {},
  child: () => {
    throw new Error('not built here');
  },
  readDelegate: async () => undefined,
  loadedSkills: async () => [],
};

function options(extra: Partial<ExecutionAgentOptions> = {}): ExecutionAgentOptions {
  return {
    runId: RUN,
    model: new ScriptedModel([]),
    checkpointer: new MemorySaver(),
    workspace: fixture.policy(),
    contentPolicy: () => createContentPolicy(exactSecretMatcher([])),
    operations: new MemoryLedger(),
    ...extra,
  };
}

function capabilities(overrides: Record<string, unknown> = {}) {
  const { snapshot, input } = commandFixture();
  return capabilitiesFor({ ...snapshot, ...overrides }, input);
}
const names = (params: ReturnType<typeof executionAgentParams>) => params.tools.map((tool) => tool.name);

describe('actor-aware agents', () => {
  test('a native goal run keeps exactly the three native tools and its prompt', () => {
    const params = executionAgentParams(options());
    expect(names(params)).toEqual(['mcp_Read', 'mcp_Search', 'mcp_AskUser']);
    expect(params.systemPrompt).toBe(SYSTEM_PROMPT);
  });

  test('a command run’s root may delegate to its retained agents; its delegates may not delegate', () => {
    const run = capabilities();
    const root = executionAgentParams(
      options({ scope: { actor: { kind: 'root' }, capabilities: run, delegation: port } }),
    );
    expect(names(root)).toEqual(['mcp_Read', 'mcp_Search', 'mcp_AskUser', DELEGATE_TOOL]);
    expect(root.systemPrompt).toBe(SYSTEM_PROMPT);
    const delegate = executionAgentParams(
      options({ scope: { actor: { kind: 'delegate', delegationId: D, agentId: 'agent:helper' }, capabilities: run } }),
    );
    expect(names(delegate)).toEqual(['mcp_Read', 'mcp_Search', 'mcp_AskUser']);
    expect(delegate.systemPrompt).toBe(`${DELEGATE_PROMPT}\n\nYou are the helper agent. Do the task.`);
    const narrow = executionAgentParams(
      options({ scope: { actor: { kind: 'delegate', delegationId: D, agentId: 'agent:narrow' }, capabilities: run } }),
    );
    expect(names(narrow)).toEqual(['mcp_Read']);
    expect(() =>
      executionAgentParams(
        options({
          scope: { actor: { kind: 'delegate', delegationId: D, agentId: 'agent:missing' }, capabilities: run },
        }),
      ),
    ).toThrow();
  });

  test('restrictions only narrow: command and agent allowlists intersect the run’s ceiling', () => {
    const { snapshot } = commandFixture();
    const restricted = capabilities({
      command: { ...snapshot.command, restrict: { native: ['mcp_Read', 'mcp_AskUser'], agents: ['agent:narrow'] } },
    });
    expect(nativeToolsFor(restricted)).toEqual(['mcp_Read', 'mcp_AskUser']);
    expect(delegableAgents(restricted).map((agent) => agent.id)).toEqual(['agent:narrow']);
    const narrow = restricted.snapshot.agents.find((agent) => agent.id === 'agent:narrow');
    expect(nativeToolsFor(restricted, narrow)).toEqual(['mcp_Read']);
    // An agent allowlisting a tool its caller lacks does not gain it.
    const widening = capabilities({
      command: { ...snapshot.command, restrict: { native: ['mcp_AskUser'] } },
    });
    expect(nativeToolsFor(widening, widening.snapshot.agents[1])).toEqual([]);
    const none = capabilities({ command: { ...snapshot.command, restrict: { agents: [] } } });
    const root = executionAgentParams(
      options({ scope: { actor: { kind: 'root' }, capabilities: none, delegation: port } }),
    );
    expect(names(root)).not.toContain(DELEGATE_TOOL);
    expect(delegateDescription(delegableAgents(capabilities()))).toContain('agent:helper: The helper agent.');
  });

  test('a command run’s definition covers its retained snapshot and delegate code; a native one has neither', async () => {
    const code = await currentCodeManifest('anthropic');
    const binding = {
      provider: 'anthropic' as const,
      authMode: 'subscription' as const,
      model: 'claude-test',
      profileId: 'anthropic.subscription.v1',
      credentialSlot: 'anthropic-default',
    };
    const definitionOf = async (scope: ExecutionAgentOptions['scope'], manifest = code) => {
      const built = options(scope === undefined ? {} : { scope });
      return executionDefinition({
        code: manifest,
        agent: createExecutionAgent(built),
        params: executionAgentParams(built),
        binding,
        workspacePolicyDigest: 'c'.repeat(64),
      });
    };
    const native = await definitionOf(undefined);
    expect(native.manifest.capabilities).toBeUndefined();
    const run = capabilities();
    const command = await definitionOf({ actor: { kind: 'root' }, capabilities: run, delegation: port });
    expect(command.manifest.capabilities).toEqual({
      snapshotDigest: run.snapshotDigest,
      delegationProtocol: 1,
      skillProtocol: 1,
      mcpProtocol: 2,
    });
    const other = capabilities({ input: { arguments: 'owner/repo-b', renderedGoal: 'Triage owner/repo-b' } });
    expect((await definitionOf({ actor: { kind: 'root' }, capabilities: other, delegation: port })).digest).not.toBe(
      command.digest,
    );
    // A change to the delegation code changes the definition of runs bound to either provider.
    const changed = {
      ...code,
      executionCode: code.executionCode.map((entry) =>
        entry.path === 'src/execution/delegation.ts' ? { ...entry, digest: 'd'.repeat(64) } : entry,
      ),
    };
    expect(code.executionCode.some((entry) => entry.path === 'src/execution/delegation.ts')).toBe(true);
    expect((await definitionOf(undefined, changed)).digest).not.toBe(native.digest);
  });

  test('command-run call identities are actor-scoped; native ones keep version 1', () => {
    const call = { id: 'call-1', name: 'mcp_Read', args: { path: 'a' } };
    expect(identityFor(RUN, 'm-1', call)?.operationId).toBe(operationIdFor(RUN, 'm-1', 'call-1'));
    const root = identityFor(RUN, 'm-1', call, {
      actor: { kind: 'root' },
      binding: { kind: 'native', name: 'mcp_Read' },
    });
    const delegate = identityFor(RUN, 'm-1', call, {
      actor: { kind: 'delegate', delegationId: D, agentId: 'agent:helper' },
    });
    expect(root?.operationId).toBe(operationIdV2(RUN, 'root', 'm-1', 'call-1'));
    expect(delegate?.operationId).toBe(operationIdV2(RUN, D, 'm-1', 'call-1'));
    expect(root?.binding).toEqual({ kind: 'native', name: 'mcp_Read' });
  });
});
