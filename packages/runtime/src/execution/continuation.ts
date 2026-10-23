// Continuation verification (Decision 7): before an answer is accepted, the run's stored binding is rebuilt, the
// execution definition for it is compared with the one the question was published under, and the saved head is
// re-inspected against the recorded question binding. Nothing here invokes the graph or writes anything.
import type { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint';
import { digestOf } from '../records/canonical.ts';
import type { RecordedQuestion } from '../records/run-store.ts';
import type { Provider, ProviderBinding } from '../records/schemas.ts';
import type { ExecutionAgent, executionAgentParams } from './agent.ts';
import type { ContinuationCheck } from './answers.ts';
import type { CodeManifest } from './code-manifest.ts';
import { executionDefinition } from './definition.ts';
import { inspectSavedQuestion } from './saved-state.ts';

export interface ContinuationDeps {
  /** Rebuilds the run's stored binding (never current defaults), or reports why it no longer can be. */
  reconstruct(binding: ProviderBinding): { ok: true; binding: ProviderBinding } | { ok: false };
  /** The admitted workspace policy digest, or undefined when workspace access is unavailable. */
  workspacePolicyDigest(): string | undefined;
  /** Builds the agent (and its parameters) that would continue this run, for inspection only. */
  agentFor(
    runId: string,
    binding: ProviderBinding,
  ): {
    agent: ExecutionAgent;
    params: ReturnType<typeof executionAgentParams>;
  };
  saver: BaseCheckpointSaver;
  /** The running code's manifest for runs bound to that provider. */
  code(provider: Provider): Promise<CodeManifest>;
}

export async function verifyContinuation(
  deps: ContinuationDeps,
  question: RecordedQuestion,
): Promise<ContinuationCheck> {
  const reconstructed = deps.reconstruct(question.run.binding);
  const policyDigest = deps.workspacePolicyDigest();
  if (!reconstructed.ok || policyDigest === undefined || policyDigest !== question.run.workspace.policyDigest) {
    return { kind: 'incompatible', problem: 'run_binding_unavailable' };
  }
  const { agent, params } = deps.agentFor(question.runId, reconstructed.binding);
  let digest: string;
  try {
    ({ digest } = await executionDefinition({
      code: await deps.code(reconstructed.binding.provider),
      agent,
      params,
      binding: reconstructed.binding,
      workspacePolicyDigest: policyDigest,
    }));
  } catch {
    return { kind: 'unavailable' };
  }
  if (digest !== question.binding.definitionDigest) return { kind: 'incompatible', problem: 'definition_changed' };

  const inspection = await inspectSavedQuestion(agent, deps.saver, question.runId, question.questionId);
  switch (inspection.kind) {
    case 'unavailable':
      return { kind: 'unavailable' };
    case 'missing':
      return { kind: 'incompatible', problem: 'saved_state_missing' };
    case 'unusable':
      return {
        kind: 'incompatible',
        problem: inspection.reason === 'question_mismatch' ? 'question_binding_mismatch' : 'saved_state_unusable',
      };
  }
  const saved = inspection.question;
  const recorded = question.binding;
  if (
    saved.checkpointNs !== recorded.checkpointNs ||
    saved.checkpointId !== recorded.checkpointId ||
    saved.taskId !== recorded.taskId ||
    saved.interruptId !== recorded.interruptId ||
    digestOf(saved.payload) !== recorded.payloadDigest ||
    saved.requiredStateDigest !== recorded.requiredStateDigest
  ) {
    return { kind: 'incompatible', problem: 'question_binding_mismatch' };
  }
  return { kind: 'compatible', interruptId: saved.interruptId };
}
