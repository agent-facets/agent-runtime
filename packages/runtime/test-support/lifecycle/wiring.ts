// Production lifecycle components wired for tests: the controller, guarded terminal with durable admission, the
// durable tool ledger, tracked saver and continuation verification — with a scripted model and a fake transport in
// place of a provider. Command runs get the production delegation wiring: one model handle per actor on the same
// invocation, admission, signal and tracked work. Used by the crash-matrix and delegate witnesses. Test-only.

import { sealSnapshot } from '../../src/capabilities/records.ts';
import type { CapabilityConfig } from '../../src/config/capabilities.ts';
import { exactSecretMatcher } from '../../src/credentials/matcher.ts';
import { runAdmission } from '../../src/execution/admission.ts';
import { createExecutionAgent, type ExecutionAgentOptions, executionAgentParams } from '../../src/execution/agent.ts';
import { type AnswerDeps, submitAnswer } from '../../src/execution/answers.ts';
import { ActiveInvocations, cancelRun } from '../../src/execution/cancellation.ts';
import { currentCodeManifest } from '../../src/execution/code-manifest.ts';
import { verifyContinuation } from '../../src/execution/continuation.ts';
import { type ControllerDeps, type InvocationWiring, RunController } from '../../src/execution/controller.ts';
import { executionDefinition } from '../../src/execution/definition.ts';
import { type DelegateRef, delegateMessageRecorder, runDelegationPort } from '../../src/execution/delegation.ts';
import { InFlight, trackedSaver } from '../../src/execution/in-flight.ts';
import { InvocationExecutor } from '../../src/execution/invocation.ts';
import { runOperationLedger } from '../../src/execution/operations.ts';
import { type CredentialRenewal, createTerminal, type RequestAdmission } from '../../src/execution/terminal.ts';
import { InvocationConnections } from '../../src/mcp/connections.ts';
import { KeyedSerializer } from '../../src/persistence/keyed-serializer.ts';
import type { Persistence } from '../../src/persistence/persistence.ts';
import { type CreateRunInput, type RunCapabilities, RunStore } from '../../src/records/run-store.ts';
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
  /**
   * Script for each invocation, in the order invocations start. One invocation's model calls — its root's and its
   * delegates', which are sequential — take the steps in order.
   */
  scripts: ScriptStep[][];
  transport: typeof fetch;
  /** The terminal's one credential renewal, for exercising a renewed (and separately counted) request. */
  renewal?: CredentialRenewal;
  failStop?: () => void;
  barriers?: ControllerDeps['barriers'];
  /** Current grants for command-run skill tools; without it actors get no skill tools. */
  skills?: { current: CapabilityConfig | undefined };
}

const ORIGIN = {
  facet: 'fixture-workflows',
  version: '0.0.1',
  source: 'local:fixture',
  integrity: `sha256-${'a'.repeat(64)}`,
};
const agentDefinition = (name: string, extra: Record<string, unknown> = {}) => ({
  id: `agent:${name}`,
  name,
  description: `The ${name} agent.`,
  origins: [ORIGIN],
  exportDigest: 'a'.repeat(64),
  requires: [],
  instructions: `You are the ${name} agent. Do the task.`,
  ...extra,
});

/**
 * A synthetic command with two retained agents — `helper`, with the caller's tools, and `narrow`, restricted to
 * reading — as a run would retain them. Nothing here is a real facet or grant.
 */
export function commandFixture(options: { maxDelegations?: number; arguments?: string } = {}) {
  const args = options.arguments ?? 'owner/repo-a';
  const snapshot = {
    version: 1,
    profile: 1,
    installation: { sha256: 'a'.repeat(64) },
    command: {
      id: 'command:triage',
      name: 'triage',
      description: 'Triage a repository.',
      origins: [ORIGIN],
      exportDigest: 'a'.repeat(64),
      requires: [{ kind: 'agent', id: 'agent:helper' }],
      body: 'Triage $ARGUMENTS',
      arguments: { required: true },
    },
    input: { arguments: args, renderedGoal: `Triage ${args}` },
    skills: [],
    agents: [agentDefinition('helper'), agentDefinition('narrow', { restrict: { native: ['mcp_Read'] } })],
    servers: [],
    tools: [],
    authority: {
      native: ['mcp_Read', 'mcp_Search', 'mcp_AskUser'],
      skills: [],
      agents: ['agent:helper', 'agent:narrow'],
      servers: [],
    },
    limits: { maxDelegations: options.maxDelegations ?? 8, delegationDepth: 1 },
  };
  const input = {
    kind: 'command' as const,
    commandId: 'command:triage',
    selectionRevision: 'a'.repeat(64),
    arguments: args,
    provider: 'anthropic' as const,
  };
  return { snapshot, input };
}

/** A command run's retained definitions, for building its agents before the run exists. */
export function capabilitiesFor(snapshot: unknown, input: RunCapabilities['input']): RunCapabilities {
  const sealed = sealSnapshot(snapshot);
  return {
    input,
    snapshotDigest: sealed.digest,
    maxDelegations: sealed.payload.limits.maxDelegations,
    snapshot: sealed.payload,
  };
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

  /** Steps drawn in order from one invocation's shared script, by whichever of its actors calls next. */
  const stepsFrom = (queue: ScriptStep[]): ScriptStep[] =>
    Array.from({ length: 256 }, () => (messages, signal) => {
      const step = queue.shift();
      if (step === undefined) throw new Error('scripted model: no step left');
      return step(messages, signal);
    });

  interface Wired {
    runId: string;
    invocationId: string;
    inflight: InFlight;
    signal: () => AbortSignal;
    admission: (actor?: DelegateRef) => RequestAdmission;
    model: (admission: RequestAdmission) => FetchingModel;
    capabilities?: RunCapabilities;
  }

  const agentOptions = (wired: Wired, actor?: DelegateRef): ExecutionAgentOptions => {
    const base: ExecutionAgentOptions = {
      runId: wired.runId,
      model: wired.model(wired.admission(actor)),
      checkpointer: trackedSaver(saver, wired.inflight),
      workspace,
      contentPolicy: () => contentPolicy,
      operations: runOperationLedger({ store, gates, runId: wired.runId, invocationId: wired.invocationId }),
      track: (work: Promise<unknown>) => {
        wired.inflight.track(work);
      },
    };
    const { capabilities } = wired;
    if (capabilities === undefined) return base;
    const skills =
      options.skills === undefined
        ? {}
        : {
            skills: {
              current: options.skills.current,
              loaded: async (actorKey: string) =>
                (await store.readLoadedSkills(wired.runId, actorKey)).map((loaded) => loaded.skillId),
            },
          };
    if (actor !== undefined) {
      return {
        ...base,
        scope: { actor, capabilities, ...skills },
        recordMessage: delegateMessageRecorder(store, wired.runId, actor),
      };
    }
    return {
      ...base,
      scope: {
        actor: { kind: 'root' },
        capabilities,
        ...skills,
        delegation: runDelegationPort({
          store,
          gates,
          runId: wired.runId,
          invocationId: wired.invocationId,
          child: (child) => createExecutionAgent(agentOptions(wired, child)),
        }),
      },
    };
  };

  const invocationWiring = (wiring: InvocationWiring, queue: ScriptStep[]): Wired => ({
    runId: wiring.runId,
    invocationId: wiring.invocationId,
    inflight: wiring.inflight,
    signal: wiring.signal,
    ...(wiring.capabilities === undefined ? {} : { capabilities: wiring.capabilities }),
    admission: (actor) =>
      runAdmission({
        store,
        gates,
        owner: persistence.ownership,
        runId: wiring.runId,
        invocationId: wiring.invocationId,
        ...(actor === undefined ? {} : { actor }),
      }),
    model: (admission) =>
      new FetchingModel(
        stepsFrom(queue),
        createTerminal({
          policy: { origin: 'https://api.provider.test', routes: [{ method: 'POST', path: '/v1/messages' }] },
          get signal() {
            return wiring.signal();
          },
          credentials: async () => ({ headers: { authorization: 'Bearer synthetic' }, generation: 1 }),
          admission,
          transport: options.transport,
          ...(options.renewal === undefined ? {} : { renewal: options.renewal }),
          track: (work) => {
            wiring.inflight.track(work);
          },
        }),
      ),
  });

  const wire: ControllerDeps['wire'] = (wiring) =>
    createExecutionAgent(agentOptions(invocationWiring(wiring, [...(scripts.shift() ?? [])])));

  /** Agent and parameters for inspection and definitions only; its model is never called. */
  const inspectionAgent = (runId: string, capabilities?: RunCapabilities) => {
    const refuse: RequestAdmission = {
      admit: async () => {
        throw new Error('inspection only');
      },
    };
    const built = agentOptions({
      runId,
      invocationId: crypto.randomUUID(),
      inflight: new InFlight(),
      signal: () => AbortSignal.abort(),
      admission: () => refuse,
      model: () => new FetchingModel([], options.transport),
      ...(capabilities === undefined ? {} : { capabilities }),
    });
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

  const definitionDigest = async (capabilities?: RunCapabilities) => {
    const { agent, params } = inspectionAgent(crypto.randomUUID(), capabilities);
    return (
      await executionDefinition({
        code: await currentCodeManifest(BINDING.provider),
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
          agentFor: async (runId) => inspectionAgent(runId, await store.readCapabilities(runId)),
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
    inspectionAgent,
    /** An agent wired for one invocation, for driving the graph outside the controller. */
    agentFor(runId: string, invocationId: string, script: ScriptStep[]) {
      scripts.unshift(script);
      return wire({
        runId,
        invocationId,
        binding: BINDING,
        inflight: new InFlight(),
        signal: () => new AbortController().signal,
        connections: new InvocationConnections(),
      });
    },
    /** Queues the script of the next invocation to start. */
    script(steps: ScriptStep[]) {
      scripts.push(steps);
    },
    async createRun(budgetMax = 10, command?: { snapshot: unknown; input: RunCapabilities['input'] }) {
      const capabilities = command === undefined ? undefined : capabilitiesFor(command.snapshot, command.input);
      const goal = capabilities?.snapshot.input.renderedGoal ?? 'Decide.';
      const { snapshot } = await store.createRun({
        requestId: crypto.randomUUID(),
        goal,
        provider: 'anthropic',
        workspace: { id: 'main', label: 'Main workspace', root: options.root, policyDigest: workspace.digest },
        binding: BINDING,
        definition: { digest: await definitionDigest(capabilities), manifest: { note: 'lifecycle-wiring' } },
        budgetMax,
        ...(capabilities === undefined
          ? {}
          : {
              capability: {
                input: capabilities.input,
                snapshot: capabilities.snapshot,
              } as CreateRunInput['capability'],
            }),
      });
      if (snapshot.state.kind !== 'working') throw new Error('expected a working run');
      return { runId: snapshot.runId, invocationId: snapshot.state.invocationId, goal };
    },
    answer: (runId: string, questionId: string, submission: object) =>
      submitAnswer(answerDeps, { runId, questionId, submission }),
    cancel: (runId: string) => cancelRun({ store, gates, active }, runId, crypto.randomUUID()),
  };
}
