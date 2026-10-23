// Question publication (Decision 6). A streamed interrupt is only a candidate: the question becomes answerable
// after the invocation has settled (the stream ended, so every synchronous saver write has completed), read-only
// inspection confirms the matching saved head, task and interrupt, and one application transaction records it.
// If any step fails, nothing is published: an orphan checkpoint interrupt never becomes an answerable question.
import type { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint';
import type { KeyedSerializer } from '../persistence/keyed-serializer.ts';
import { digestOf } from '../records/canonical.ts';
import { type RunStore, RunStoreError } from '../records/run-store.ts';
import type { QuestionBinding } from '../records/schemas.ts';
import type { ExecutionAgent } from './agent.ts';
import type { InvocationSettlement } from './invocation.ts';
import { inspectSavedQuestion, type SavedStateInspection } from './saved-state.ts';

export type PublicationOutcome =
  | { kind: 'published'; questionId: string; revision: string }
  | {
      kind: 'not_published';
      reason: 'not_a_question' | 'saved_state_unavailable' | 'saved_state_unusable' | 'run_changed' | 'commit_failed';
    }
  /** The commit may or may not have happened and readback could not tell: nothing may be dispatched. */
  | { kind: 'unknown' };

export interface PublicationDeps {
  store: Pick<RunStore, 'publishQuestion' | 'findPublishedQuestion' | 'withCommitCertainty'>;
  gates: KeyedSerializer;
  agent: ExecutionAgent;
  saver: BaseCheckpointSaver;
  definitionDigest: string;
  /** Attempts and pause for inspection that could not read the saved state. */
  inspectionAttempts?: number;
  inspectionRetryMs?: number;
}

export async function publishSettledQuestion(
  deps: PublicationDeps,
  run: { runId: string; invocationId: string; expectedRevision: string },
  settlement: InvocationSettlement,
): Promise<PublicationOutcome> {
  if (settlement.kind !== 'interrupted' || settlement.interrupts.length !== 1) {
    return { kind: 'not_published', reason: 'not_a_question' };
  }
  const [candidate] = settlement.interrupts as [(typeof settlement.interrupts)[number]];
  const questionId = candidate.value?.questionId;
  if (typeof questionId !== 'string') return { kind: 'not_published', reason: 'saved_state_unusable' };

  let inspection: SavedStateInspection = { kind: 'unavailable' };
  const attempts = deps.inspectionAttempts ?? 3;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    inspection = await inspectSavedQuestion(deps.agent, deps.saver, run.runId, questionId);
    if (inspection.kind !== 'unavailable') break;
    if (attempt < attempts) await Bun.sleep(deps.inspectionRetryMs ?? 250);
  }
  if (inspection.kind === 'unavailable') return { kind: 'not_published', reason: 'saved_state_unavailable' };
  if (inspection.kind !== 'question' || inspection.question.interruptId !== candidate.id) {
    return { kind: 'not_published', reason: 'saved_state_unusable' };
  }
  const saved = inspection.question;
  const binding: QuestionBinding = {
    threadId: run.runId,
    checkpointNs: saved.checkpointNs,
    checkpointId: saved.checkpointId,
    taskId: saved.taskId,
    interruptId: saved.interruptId,
    ordinal: 0,
    operationId: questionId,
    payloadDigest: digestOf(saved.payload),
    requiredStateDigest: saved.requiredStateDigest,
    definitionDigest: deps.definitionDigest,
  };

  try {
    const outcome = await deps.store.withCommitCertainty(
      () =>
        deps.gates.run(run.runId, () =>
          deps.store.publishQuestion({
            runId: run.runId,
            expectedRevision: run.expectedRevision,
            invocationId: run.invocationId,
            questionId,
            prompt: saved.payload.prompt,
            input: saved.payload.input,
            binding,
          }),
        ),
      () => deps.store.findPublishedQuestion(run.runId, questionId),
    );
    return outcome.committed
      ? { kind: 'published', questionId, revision: outcome.value.revision }
      : { kind: 'not_published', reason: 'commit_failed' };
  } catch (error) {
    if (error instanceof RunStoreError) {
      if (error.code === 'acceptance_unknown') return { kind: 'unknown' };
      if (error.code === 'stale_revision' || error.code === 'run_finished') {
        return { kind: 'not_published', reason: 'run_changed' };
      }
    }
    return { kind: 'not_published', reason: 'commit_failed' };
  }
}
