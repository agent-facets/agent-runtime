// Answer acceptance (Decisions 5 and 6), in the design's precedence:
//   1. the run and question exist;
//   2. a question already answered is answered: an equal canonical answer is acknowledged (even if the run has
//      since finished) and a different one is a conflict — no fresh check can invalidate the acknowledgement;
//   3. a closed question, or a run not waiting on it, is not answerable;
//   4. the answer satisfies the question's declared input;
//   5. continuation is verified without invoking the graph: a temporary inability to look changes nothing, while
//      a confirmed missing, unusable or incompatible saved state closes the question and fails the run;
//   6. acceptance is conditional on the run still waiting on the same question and binding. A race loser rereads
//      the winning disposition rather than continuing; an uncertain commit is resolved by same-owner readback.
// Only an `accepted` result may be followed by exactly one resume, addressed to the saved interrupt.
import { failureFor } from '../domain/failures.ts';
import { type AnswerErrorCode, canonicalAnswer } from '../domain/questions.ts';
import type { KeyedSerializer } from '../persistence/keyed-serializer.ts';
import { canonicalJson } from '../records/canonical.ts';
import { type AcceptedAnswer, type RecordedQuestion, type RunStore, RunStoreError } from '../records/run-store.ts';
import type { Answer } from '../records/schemas.ts';
import type { ResumeEnvelope } from './tools.ts';

export type ContinuationProblem =
  | 'saved_state_missing'
  | 'saved_state_unusable'
  | 'definition_changed'
  | 'question_binding_mismatch'
  | 'run_binding_unavailable';

export type ContinuationCheck =
  | { kind: 'compatible'; interruptId: string }
  | { kind: 'unavailable' }
  | { kind: 'incompatible'; problem: ContinuationProblem };

/** Read-only verification of a waiting run's saved state against its recorded question binding. */
export type VerifyContinuation = (question: RecordedQuestion) => Promise<ContinuationCheck>;

export type AnswerResult =
  | { kind: 'accepted'; acceptance: AcceptedAnswer; resume: { interruptId: string; envelope: ResumeEnvelope } }
  | { kind: 'already_accepted'; answer: Answer; acceptedAt: string; invocationId: string }
  | { kind: 'not_found'; target: 'run_or_question' }
  | { kind: 'answer_conflict' }
  | { kind: 'not_answerable' }
  | { kind: 'answer_invalid'; code: AnswerErrorCode }
  | { kind: 'continuation_unavailable'; problem: ContinuationProblem }
  | { kind: 'cannot_verify' }
  /** Storing the answer failed and readback confirmed it was not recorded: it was not accepted. */
  | { kind: 'storage_failed' }
  | { kind: 'acceptance_unknown' };

export interface AnswerDeps {
  store: Pick<RunStore, 'readQuestion' | 'acceptAnswer' | 'refuseContinuation' | 'withCommitCertainty' | 'snapshot'>;
  gates: KeyedSerializer;
  verify: VerifyContinuation;
}

const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);

export async function submitAnswer(
  deps: AnswerDeps,
  request: { runId: string; questionId: string; submission: object },
): Promise<AnswerResult> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const question = await deps.store.readQuestion(request.runId, request.questionId);
    if (question === undefined) return { kind: 'not_found', target: 'run_or_question' };
    const validated = canonicalAnswer(question.input, request.submission);

    if (question.disposition.kind === 'answered') {
      const { answer, acceptedAt, invocationId } = question.disposition;
      return validated.ok && same(validated.answer, answer)
        ? { kind: 'already_accepted', answer, acceptedAt, invocationId }
        : { kind: 'answer_conflict' };
    }
    const state = question.run.state;
    if (
      question.disposition.kind === 'closed' ||
      state.kind !== 'waiting' ||
      state.questionId !== question.questionId ||
      state.bindingDigest !== question.bindingDigest
    ) {
      return { kind: 'not_answerable' };
    }
    if (!validated.ok) return { kind: 'answer_invalid', code: validated.code };

    const check = await deps.verify(question);
    if (check.kind === 'unavailable') return { kind: 'cannot_verify' };
    if (check.kind === 'incompatible') {
      try {
        await deps.gates.run(request.runId, () =>
          deps.store.refuseContinuation({
            runId: request.runId,
            questionId: request.questionId,
            expectedRevision: question.run.revision,
            failure: failureFor(check.problem, { provider: question.run.binding.provider }),
          }),
        );
      } catch (error) {
        // Someone else changed the run first; report what is recorded now.
        if (error instanceof RunStoreError && error.code === 'stale_revision') continue;
        return { kind: 'cannot_verify' };
      }
      return { kind: 'continuation_unavailable', problem: check.problem };
    }

    const answer = validated.answer;
    let outcome: { committed: true; value: AcceptedAnswer } | { committed: false };
    try {
      outcome = await deps.store.withCommitCertainty(
        () =>
          deps.gates.run(request.runId, () =>
            deps.store.acceptAnswer({
              runId: request.runId,
              questionId: request.questionId,
              bindingDigest: question.bindingDigest,
              expectedRevision: question.run.revision,
              answer,
            }),
          ),
        async () => {
          const reread = await deps.store.readQuestion(request.runId, request.questionId);
          if (reread?.disposition.kind !== 'answered' || !same(reread.disposition.answer, answer)) return undefined;
          const snapshot = await deps.store.snapshot(request.runId);
          return {
            answer,
            acceptedAt: reread.disposition.acceptedAt,
            invocationId: reread.disposition.invocationId,
            revision: snapshot.revision,
          };
        },
      );
    } catch (error) {
      if (error instanceof RunStoreError) {
        if (error.code === 'acceptance_unknown') return { kind: 'acceptance_unknown' };
        // Lost a race (another tab, cancellation, failure): reread and report the winning disposition.
        if (error.code === 'stale_revision' || error.code === 'run_finished') continue;
      }
      throw error;
    }
    if (!outcome.committed) return { kind: 'storage_failed' };
    return {
      kind: 'accepted',
      acceptance: outcome.value,
      resume: { interruptId: check.interruptId, envelope: { questionId: request.questionId, answer } },
    };
  }
  return { kind: 'not_answerable' };
}
