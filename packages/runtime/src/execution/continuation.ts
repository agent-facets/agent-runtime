// Continuation verification (Decision 7): before an answer is accepted, the run's stored binding is rebuilt, the
// execution definition for it is compared with the one the question was published under, and the saved head is
// re-inspected against the recorded question binding. Nothing here invokes the graph or writes anything.
import type { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint';
import { CapabilityRecordError } from '../capabilities/records.ts';
import { canonicalJson } from '../records/canonical.ts';
import type { RecordedQuestion } from '../records/run-store.ts';
import type { Provider, ProviderBinding } from '../records/schemas.ts';
import type { ExecutionAgent, executionAgentParams } from './agent.ts';
import type { ContinuationCheck } from './answers.ts';
import type { CodeManifest } from './code-manifest.ts';
import { executionDefinition } from './definition.ts';
import { inspectQuestionBinding } from './saved-state.ts';

export interface ContinuationDeps {
  /** Rebuilds the run's stored binding (never current defaults), or reports why it no longer can be. */
  reconstruct(binding: ProviderBinding): { ok: true; binding: ProviderBinding } | { ok: false };
  /** The admitted workspace policy digest, or undefined when workspace access is unavailable. */
  workspacePolicyDigest(): string | undefined;
  /**
   * Builds the agent (and its parameters) that would continue this run, for inspection only; for a command run,
   * from its retained definitions. A retained snapshot that fails its revalidation raises CapabilityRecordError.
   */
  agentFor(
    runId: string,
    binding: ProviderBinding,
  ):
    | { agent: ExecutionAgent; params: ReturnType<typeof executionAgentParams> }
    | Promise<{ agent: ExecutionAgent; params: ReturnType<typeof executionAgentParams> }>;
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
  let built: Awaited<ReturnType<ContinuationDeps['agentFor']>>;
  try {
    built = await deps.agentFor(question.runId, reconstructed.binding);
  } catch (error) {
    // Retained definitions confirmed corrupt cannot continue; failing to read them proves nothing.
    return error instanceof CapabilityRecordError
      ? { kind: 'incompatible', problem: 'definition_changed' }
      : { kind: 'unavailable' };
  }
  const { agent, params } = built;
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

  const inspection = await inspectQuestionBinding(agent, deps.saver, question.runId, question.questionId);
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
  // Every field of the recorded binding — the asker, both saved heads where there are two, the interrupt, payload
  // and required state — must be what saved state establishes now.
  const { definitionDigest: _definition, ...recorded } = question.binding;
  if (canonicalJson(recorded) !== canonicalJson(inspection.binding)) {
    return { kind: 'incompatible', problem: 'question_binding_mismatch' };
  }
  return { kind: 'compatible', interruptId: inspection.interruptId };
}
