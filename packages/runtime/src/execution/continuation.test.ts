import { afterAll, describe, expect, test } from 'bun:test';
import { AIMessage, HumanMessage } from '@langchain/core/messages';
import { MemorySaver } from '@langchain/langgraph';
import { MemoryLedger } from '../../test-support/memory-ledger.ts';
import { ScriptedModel } from '../../test-support/scripted-model.ts';
import { createFixture } from '../../test-support/workspace.ts';
import { exactSecretMatcher } from '../credentials/matcher.ts';
import { KeyedSerializer } from '../persistence/keyed-serializer.ts';
import type { ProviderBinding } from '../records/schemas.ts';
import { createContentPolicy } from '../security/content-policy.ts';
import { createExecutionAgent, executionAgentParams } from './agent.ts';
import { type CodeManifest, currentCodeManifest } from './code-manifest.ts';
import { executionDefinition } from './definition.ts';
import { InvocationExecutor } from './invocation.ts';
import { classifySavedQuestion, inspectSavedQuestion } from './saved-state.ts';
import { ASK_TOOL } from './tools.ts';

const fixture = createFixture();
afterAll(() => fixture.cleanup());
const workspace = fixture.policy();
const policy = createContentPolicy(exactSecretMatcher([]));
const binding: ProviderBinding = {
  provider: 'anthropic',
  authMode: 'subscription',
  model: 'model-a',
  profileId: 'anthropic-sub',
  credentialSlot: 'default',
};

function agentFor(runId: string, model = new ScriptedModel([]), saver = new MemorySaver()) {
  const options = {
    runId,
    model,
    checkpointer: saver,
    workspace,
    contentPolicy: () => policy,
    operations: new MemoryLedger(),
  };
  return { agent: createExecutionAgent(options), params: executionAgentParams(options), saver, model };
}

async function definition(
  changes: { code?: CodeManifest; binding?: ProviderBinding; policyDigest?: string; runtime?: string } = {},
) {
  const { agent, params } = agentFor(crypto.randomUUID());
  return executionDefinition({
    code: changes.code ?? (await currentCodeManifest()),
    agent,
    params,
    binding: changes.binding ?? binding,
    workspacePolicyDigest: changes.policyDigest ?? workspace.digest,
    ...(changes.runtime === undefined ? {} : { runtimeVersion: changes.runtime }),
  });
}

describe('execution definition', () => {
  test('identical execution content and binding give the same digest, whatever instance built it', async () => {
    const [first, second] = await Promise.all([definition(), definition()]);
    expect(first.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(second.digest).toBe(first.digest);
    expect(first.manifest).toMatchObject({
      protocolVersion: { question: 1, resumeEnvelope: 1, continuation: 1 },
      runtimeVersion: Bun.version,
      middleware: [{ name: 'ExecutionBoundary' }],
      runBinding: { ...binding, workspacePolicyDigest: workspace.digest },
    });
    expect((first.manifest.graph as { nodes: string[] }).nodes).toEqual([
      '__end__',
      '__start__',
      'model_request',
      'tools',
    ]);
  });

  test('the stored binding, workspace policy, runtime, packages and execution code all change it', async () => {
    const base = await definition();
    const code = await currentCodeManifest();
    const changedHelper: CodeManifest = {
      ...code,
      executionCode: code.executionCode.map((entry) =>
        entry.path === 'src/execution/tools.ts' ? { ...entry, digest: '0'.repeat(64) } : entry,
      ),
    };
    const changedPackage: CodeManifest = {
      ...code,
      packages: code.packages.map((entry) =>
        entry.name === 'langchain' ? { ...entry, integrity: 'sha512-other' } : entry,
      ),
    };
    for (const changed of [
      await definition({ binding: { ...binding, model: 'model-b' } }),
      await definition({ binding: { ...binding, profileId: 'anthropic-sub-2' } }),
      await definition({ policyDigest: 'f'.repeat(64) }),
      await definition({ runtime: '9.9.9' }),
      await definition({ code: changedHelper }),
      await definition({ code: changedPackage }),
    ]) {
      expect(changed.digest).not.toBe(base.digest);
    }
  });
});

describe('saved-state inspection', () => {
  const ask = () =>
    new AIMessage({
      id: 'm-ask',
      content: '',
      tool_calls: [
        {
          id: 'c-ask',
          name: ASK_TOOL,
          args: { prompt: 'Continue?', input: { kind: 'text', minLength: 0, maxLength: 20 } },
          type: 'tool_call',
        },
      ],
    });

  async function paused() {
    const runId = crypto.randomUUID();
    const setup = agentFor(runId, new ScriptedModel([ask, () => new AIMessage({ id: 'm-end', content: 'ok' })]));
    const executor = new InvocationExecutor(new KeyedSerializer());
    const settled = await executor.start({
      runId,
      agent: setup.agent,
      input: { kind: 'initial', goal: 'Ask.' },
      budgetMax: 5,
    }).settled;
    if (settled.kind !== 'interrupted') throw new Error('expected an interrupt');
    return {
      ...setup,
      runId,
      executor,
      raised: settled.interrupts[0] as { id: string; value: { questionId: string } },
    };
  }

  test('a saved question is found with its exact binding, and inspecting it never runs the graph', async () => {
    const { agent, saver, model, runId, raised } = await paused();
    const first = await inspectSavedQuestion(agent, saver, runId);
    const second = await inspectSavedQuestion(agent, saver, runId, raised.value.questionId);
    if (first.kind !== 'question') throw new Error(first.kind);
    expect(first.question).toMatchObject({
      checkpointNs: '',
      checkpointId: expect.any(String),
      taskId: expect.any(String),
      interruptId: raised.id,
      payload: { questionId: raised.value.questionId, prompt: 'Continue?' },
      requiredStateDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(second).toEqual(first);
    expect(model.calls).toHaveLength(1);
  });

  test('another question ID, a finished run and a thread without state are refused distinctly', async () => {
    const { agent, saver, runId, raised, executor } = await paused();
    expect(await inspectSavedQuestion(agent, saver, runId, 'e'.repeat(64))).toEqual({
      kind: 'unusable',
      reason: 'question_mismatch',
    });
    await executor.start({
      runId,
      agent,
      input: {
        kind: 'resume',
        interruptId: raised.id,
        envelope: { questionId: raised.value.questionId, answer: 'yes' },
      },
      budgetMax: 5,
    }).settled;
    expect(await inspectSavedQuestion(agent, saver, runId)).toEqual({
      kind: 'unusable',
      reason: 'no_pending_question',
    });
    expect(await inspectSavedQuestion(agent, saver, crypto.randomUUID())).toEqual({ kind: 'missing' });
  });

  test('a failure to read saved state is temporary; it never confirms the state missing or unusable', async () => {
    const { agent, runId } = await paused();
    for (const failure of [
      Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' }),
      new Error('anything'),
    ]) {
      const broken = new MemorySaver();
      broken.getTuple = async () => {
        throw failure;
      };
      const { agent: reader } = agentFor(runId, new ScriptedModel([]), broken);
      expect(await inspectSavedQuestion(reader, broken, runId)).toEqual({ kind: 'unavailable' });
    }
    expect(agent).toBeDefined();
  });

  test('structural refusals: unusable messages, ambiguous interrupts and unsupported values', () => {
    const runId = '00000000-0000-4000-8000-000000000000';
    const message = new AIMessage({
      id: 'm',
      content: '',
      tool_calls: [{ id: 'c', name: ASK_TOOL, args: {}, type: 'tool_call' }],
    });
    const snapshot = (overrides: object) => ({
      values: { messages: [new HumanMessage('goal'), message] },
      next: ['tools'],
      config: { configurable: { checkpoint_id: 'cp', checkpoint_ns: '' } },
      tasks: [{ id: 't', name: 'tools', interrupts: [{ id: 'i', value: {} }] }],
      ...overrides,
    });
    const tuple = { checkpoint: { channel_values: {}, channel_versions: {} }, pendingWrites: [] };
    expect(classifySavedQuestion(runId, snapshot({ values: { messages: 'nope' } }), tuple)).toEqual({
      kind: 'unusable',
      reason: 'messages_unusable',
    });
    expect(
      classifySavedQuestion(
        runId,
        snapshot({
          tasks: [
            { id: 't1', name: 'tools', interrupts: [{ id: 'a', value: {} }] },
            { id: 't2', name: 'tools', interrupts: [{ id: 'b', value: {} }] },
          ],
        }),
        tuple,
      ),
    ).toEqual({ kind: 'unusable', reason: 'ambiguous_interrupt' });
    expect(classifySavedQuestion(runId, snapshot({}), tuple)).toEqual({
      kind: 'unusable',
      reason: 'question_mismatch',
    });
  });

  test('a saved value this runtime cannot represent makes the state unusable, not silently dropped', async () => {
    const { agent, saver, runId } = await paused();
    const original = saver.getTuple.bind(saver);
    saver.getTuple = async (config) => {
      const tuple = await original(config);
      if (tuple === undefined) return tuple;
      return {
        ...tuple,
        checkpoint: { ...tuple.checkpoint, channel_values: { ...tuple.checkpoint.channel_values, extra: new Date(0) } },
      };
    };
    expect(await inspectSavedQuestion(agent, saver, runId)).toEqual({ kind: 'unusable', reason: 'unsupported_value' });
  });
});
