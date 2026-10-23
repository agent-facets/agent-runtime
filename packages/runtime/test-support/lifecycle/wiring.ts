// Production lifecycle components wired for tests: the controller, guarded terminal with durable admission, the
// durable tool ledger, tracked saver and continuation verification — with a scripted model and a fake transport in
// place of a provider. Used by the crash-matrix child and its parent. Test-only.
import { exactSecretMatcher } from '../../src/credentials/matcher.ts';
import { runAdmission } from '../../src/execution/admission.ts';
import { createExecutionAgent, executionAgentParams } from '../../src/execution/agent.ts';
import { type AnswerDeps, submitAnswer } from '../../src/execution/answers.ts';
import { ActiveInvocations, cancelRun } from '../../src/execution/cancellation.ts';
import { currentCodeManifest } from '../../src/execution/code-manifest.ts';
import { verifyContinuation } from '../../src/execution/continuation.ts';
import { type ControllerDeps, RunController } from '../../src/execution/controller.ts';
import { executionDefinition } from '../../src/execution/definition.ts';
import { InFlight, trackedSaver } from '../../src/execution/in-flight.ts';
import { InvocationExecutor } from '../../src/execution/invocation.ts';
import { runOperationLedger } from '../../src/execution/operations.ts';
import { createTerminal } from '../../src/execution/terminal.ts';
import { KeyedSerializer } from '../../src/persistence/keyed-serializer.ts';
import type { Persistence } from '../../src/persistence/persistence.ts';
import { RunStore } from '../../src/records/run-store.ts';
import type { ProviderBinding } from '../../src/records/schemas.ts';
import { createContentPolicy } from '../../src/security/content-policy.ts';
import { createWorkspacePolicy } from '../../src/workspace/policy.ts';
import { AIMessage, FetchingModel, type ScriptStep } from '../scripted-model.ts';

export const BINDING: ProviderBinding = {
  provider: 'anthropic',
  authMode: 'subscription',
  model: 'claude-test',
  profileId: 'anthropic.subscription.v1',
  credentialSlot: 'anthropic-default',
};

export const ask: ScriptStep = () =>
  new AIMessage({
    id: 'm-ask',
    content: '',
    tool_calls: [
      {
        id: 'c-ask',
        name: 'mcp_AskUser',
        args: {
          prompt: 'Proceed?',
          input: {
            kind: 'choice',
            multiple: false,
            options: [
              { label: 'Yes', value: true },
              { label: 'No', value: false },
            ],
          },
        },
        type: 'tool_call',
      },
    ],
  });
export const final: ScriptStep = () => new AIMessage({ id: `m-${crypto.randomUUID()}`, content: 'Done.' });
export const echo: ScriptStep = (messages) =>
  new AIMessage({ id: `m-${crypto.randomUUID()}`, content: String(messages.at(-1)?.content) });

export interface WiringOptions {
  root: string;
  /** Script for each invocation's model, in the order invocations start. */
  scripts: ScriptStep[][];
  transport: typeof fetch;
  failStop?: () => void;
  barriers?: ControllerDeps['barriers'];
}

export function createWiring(persistence: Persistence, options: WiringOptions) {
  const store = new RunStore(persistence.app, persistence.ownership);
  const gates = new KeyedSerializer();
  const active = new ActiveInvocations();
  const workspace = createWorkspacePolicy({
    id: 'main',
    label: 'Main workspace',
    root: options.root,
    excludeNames: [],
    excludePaths: [],
  });
  const contentPolicy = createContentPolicy(exactSecretMatcher([]));
  const saver = persistence.checkpoints.saver;
  const scripts = [...options.scripts];

  const agentOptions = (runId: string, invocationId: string, model: FetchingModel, inflight: InFlight) => ({
    runId,
    model,
    checkpointer: trackedSaver(saver, inflight),
    workspace,
    contentPolicy: () => contentPolicy,
    operations: runOperationLedger({ store, gates, runId, invocationId }),
    track: (work: Promise<unknown>) => {
      inflight.track(work);
    },
  });

  const wire: ControllerDeps['wire'] = (wiring) => {
    const terminal = createTerminal({
      policy: { origin: 'https://api.provider.test', routes: [{ method: 'POST', path: '/v1/messages' }] },
      get signal() {
        return wiring.signal();
      },
      credentials: async () => ({ headers: { authorization: 'Bearer synthetic' }, generation: 1 }),
      admission: runAdmission({
        store,
        gates,
        owner: persistence.ownership,
        runId: wiring.runId,
        invocationId: wiring.invocationId,
      }),
      transport: options.transport,
      track: (work) => {
        wiring.inflight.track(work);
      },
    });
    const model = new FetchingModel(scripts.shift() ?? [], terminal);
    return createExecutionAgent(agentOptions(wiring.runId, wiring.invocationId, model, wiring.inflight));
  };

  /** Agent and parameters for inspection and definitions only; its model is never called. */
  const inspectionAgent = (runId: string) => {
    const built = agentOptions(runId, crypto.randomUUID(), new FetchingModel([], options.transport), new InFlight());
    return { agent: createExecutionAgent(built), params: executionAgentParams(built) };
  };

  const controller = new RunController({
    store,
    gates,
    executor: new InvocationExecutor(new KeyedSerializer()),
    active,
    saver,
    wire,
    failStop: options.failStop ?? (() => persistence.ownership.shutdown()),
    ...(options.barriers === undefined ? {} : { barriers: options.barriers }),
  });

  const definitionDigest = async () => {
    const { agent, params } = inspectionAgent(crypto.randomUUID());
    return (
      await executionDefinition({
        code: await currentCodeManifest(),
        agent,
        params,
        binding: BINDING,
        workspacePolicyDigest: workspace.digest,
      })
    ).digest;
  };

  const answerDeps: AnswerDeps = {
    store,
    gates,
    verify: (question) =>
      verifyContinuation(
        {
          reconstruct: (binding) => ({ ok: true, binding }),
          workspacePolicyDigest: () => workspace.digest,
          agentFor: (runId) => inspectionAgent(runId),
          saver,
          code: currentCodeManifest,
        },
        question,
      ),
  };

  return {
    store,
    controller,
    workspace,
    /** An agent wired for one invocation, for driving the graph outside the controller. */
    agentFor(runId: string, invocationId: string, script: ScriptStep[]) {
      scripts.unshift(script);
      return wire({
        runId,
        invocationId,
        binding: BINDING,
        inflight: new InFlight(),
        signal: () => new AbortController().signal,
      });
    },
    async createRun(budgetMax = 10) {
      const { snapshot } = await store.createRun({
        requestId: crypto.randomUUID(),
        goal: 'Decide.',
        provider: 'anthropic',
        workspace: { id: 'main', label: 'Main workspace', root: options.root, policyDigest: workspace.digest },
        binding: BINDING,
        definition: { digest: await definitionDigest(), manifest: { note: 'crash-matrix' } },
        budgetMax,
      });
      if (snapshot.state.kind !== 'working') throw new Error('expected a working run');
      return { runId: snapshot.runId, invocationId: snapshot.state.invocationId };
    },
    answer: (runId: string, questionId: string, submission: object) =>
      submitAnswer(answerDeps, { runId, questionId, submission }),
    cancel: (runId: string) => cancelRun({ store, gates, active }, runId, crypto.randomUUID()),
  };
}
