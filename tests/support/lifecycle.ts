// A lifecycle harness for integration suites: real run records, the official saver, the stock agent with the
// durable ledger, publication under the true execution definition, and answer submission with continuation
// verification. Witnesses are the scripted model's call log and the database.
import { exactSecretMatcher } from '../../packages/runtime/src/credentials/matcher.ts';
import { createExecutionAgent, executionAgentParams } from '../../packages/runtime/src/execution/agent.ts';
import { type AnswerDeps, submitAnswer } from '../../packages/runtime/src/execution/answers.ts';
import { type CodeManifest, currentCodeManifest } from '../../packages/runtime/src/execution/code-manifest.ts';
import { type ContinuationDeps, verifyContinuation } from '../../packages/runtime/src/execution/continuation.ts';
import { executionDefinition } from '../../packages/runtime/src/execution/definition.ts';
import { InvocationExecutor, type InvocationInput } from '../../packages/runtime/src/execution/invocation.ts';
import { runOperationLedger } from '../../packages/runtime/src/execution/operations.ts';
import { publishSettledQuestion } from '../../packages/runtime/src/execution/publication.ts';
import type { ResumeEnvelope } from '../../packages/runtime/src/execution/tools.ts';
import { ASK_TOOL } from '../../packages/runtime/src/execution/tools.ts';
import { KeyedSerializer } from '../../packages/runtime/src/persistence/keyed-serializer.ts';
import type { Persistence } from '../../packages/runtime/src/persistence/persistence.ts';
import { type CreateRunInput, RunStore } from '../../packages/runtime/src/records/run-store.ts';
import type { ProviderBinding, QuestionInput } from '../../packages/runtime/src/records/schemas.ts';
import { createContentPolicy } from '../../packages/runtime/src/security/content-policy.ts';
import { AIMessage, ScriptedModel, type ScriptStep } from '../../packages/runtime/test-support/scripted-model.ts';
import type { Fixture } from '../../packages/runtime/test-support/workspace.ts';
import { binding as storedBinding, workspace as storedWorkspace } from './run-records.ts';

export const BINDING = storedBinding as ProviderBinding;
export const YES_NO: QuestionInput = {
  kind: 'choice',
  multiple: false,
  options: [
    { label: 'Yes', value: true },
    { label: 'No', value: false },
  ],
};

export const askStep =
  (input: QuestionInput = YES_NO, prompt = 'Proceed?'): ScriptStep =>
  () =>
    new AIMessage({
      id: 'm-ask',
      content: '',
      tool_calls: [{ id: 'c-ask', name: ASK_TOOL, args: { prompt, input }, type: 'tool_call' }],
    });

export const echoStep: ScriptStep = (messages) =>
  new AIMessage({ id: `m-${crypto.randomUUID()}`, content: String(messages.at(-1)?.content) });

export class Lifecycle {
  readonly store: RunStore;
  readonly gates = new KeyedSerializer();
  readonly executor = new InvocationExecutor(new KeyedSerializer());
  readonly policy = createContentPolicy(exactSecretMatcher([]));
  /** Overridable per test: what continuation verification sees. */
  code: () => Promise<CodeManifest> = currentCodeManifest;
  saver: Persistence['checkpoints']['saver'];
  reconstruct: ContinuationDeps['reconstruct'] = (binding) => ({ ok: true, binding });

  constructor(
    readonly persistence: Persistence,
    readonly fixture: Fixture,
  ) {
    this.store = new RunStore(persistence.app, persistence.ownership);
    this.saver = persistence.checkpoints.saver;
  }

  get workspacePolicy() {
    return this.fixture.policy();
  }

  agentFor(runId: string, invocationId: string, model: ScriptedModel, saver = this.saver) {
    const options = {
      runId,
      model,
      checkpointer: saver,
      workspace: this.workspacePolicy,
      contentPolicy: () => this.policy,
      operations: runOperationLedger({ store: this.store, gates: this.gates, runId, invocationId }),
    };
    return { agent: createExecutionAgent(options), params: executionAgentParams(options) };
  }

  async definitionDigest(runId: string) {
    const { agent, params } = this.agentFor(runId, crypto.randomUUID(), new ScriptedModel([]));
    return (
      await executionDefinition({
        code: await currentCodeManifest(),
        agent,
        params,
        binding: BINDING,
        workspacePolicyDigest: this.workspacePolicy.digest,
      })
    ).digest;
  }

  /** A run whose agent asked a question that is now published and answerable. */
  async waitingRun(steps: ScriptStep[] = [askStep(), echoStep], options: { budgetMax?: number } = {}) {
    const workspacePolicy = this.workspacePolicy;
    const provisional = crypto.randomUUID();
    const definition = await this.definitionDigest(provisional);
    const { snapshot } = await this.store.createRun({
      requestId: crypto.randomUUID(),
      goal: 'Decide.',
      provider: 'anthropic',
      workspace: { ...storedWorkspace, policyDigest: workspacePolicy.digest },
      binding: BINDING as CreateRunInput['binding'],
      definition: { digest: definition, manifest: { note: 'test' } },
      budgetMax: options.budgetMax ?? 10,
    });
    if (snapshot.state.kind !== 'working') throw new Error('expected a working run');
    const runId = snapshot.runId;
    const model = new ScriptedModel(steps);
    const { agent } = this.agentFor(runId, snapshot.state.invocationId, model);
    const settlement = await this.executor.start({
      runId,
      agent,
      input: { kind: 'initial', goal: 'Decide.' },
      budgetMax: options.budgetMax ?? 10,
    }).settled;
    const published = await publishSettledQuestion(
      { store: this.store, gates: this.gates, agent, saver: this.saver, definitionDigest: definition },
      {
        runId,
        invocationId: snapshot.state.invocationId,
        expectedRevision: (await this.store.snapshot(runId)).revision,
      },
      settlement,
    );
    if (published.kind !== 'published') throw new Error(`question not published: ${JSON.stringify(published)}`);
    return { runId, questionId: published.questionId, model };
  }

  answerDeps(overrides: Partial<AnswerDeps> = {}): AnswerDeps {
    const verify = (question: Parameters<AnswerDeps['verify']>[0]) =>
      verifyContinuation(
        {
          reconstruct: (binding) => this.reconstruct(binding),
          workspacePolicyDigest: () => this.workspacePolicy.digest,
          agentFor: (runId) => this.agentFor(runId, crypto.randomUUID(), new ScriptedModel([])),
          saver: this.saver,
          code: () => this.code(),
        },
        question,
      );
    return { store: this.store, gates: this.gates, verify, ...overrides };
  }

  answer(runId: string, questionId: string, submission: object, deps = this.answerDeps()) {
    return submitAnswer(deps, { runId, questionId, submission });
  }

  /** Dispatches the one resume an accepted answer permits, as the answer invocation. */
  async resume(runId: string, model: ScriptedModel, resume: { interruptId: string; envelope: ResumeEnvelope }) {
    const snapshot = await this.store.snapshot(runId);
    if (snapshot.state.kind !== 'working') throw new Error('expected a working run');
    const { agent } = this.agentFor(runId, snapshot.state.invocationId, model);
    const input: InvocationInput = { kind: 'resume', ...resume };
    return this.executor.start({ runId, agent, input, budgetMax: 10 }).settled;
  }
}
