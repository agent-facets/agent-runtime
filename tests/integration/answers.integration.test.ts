// Answer acceptance (Decisions 5 and 6): exact answers, accepted once, delivered through one ID-addressed resume;
// duplicates acknowledged, conflicts refused, and saved-state problems told apart from temporary outages.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { CodeManifest } from '../../packages/runtime/src/execution/code-manifest.ts';
import { openPersistence, type Persistence } from '../../packages/runtime/src/persistence/persistence.ts';
import type { Answer, QuestionInput } from '../../packages/runtime/src/records/schemas.ts';
import { ScriptedModel } from '../../packages/runtime/test-support/scripted-model.ts';
import { createFixture } from '../../packages/runtime/test-support/workspace.ts';
import { askStep, echoStep, Lifecycle } from '../support/lifecycle.ts';
import { createScratchDatabase, type ScratchDatabase } from '../support/scratch-database.ts';

let db: ScratchDatabase;
let persistence: Persistence;
let life: Lifecycle;
const fixture = createFixture();
beforeAll(async () => {
  db = await createScratchDatabase();
  persistence = await openPersistence({ url: db.url, onFault: () => {} });
  life = new Lifecycle(persistence, fixture);
});
afterAll(async () => {
  await persistence.close();
  await db.drop();
  fixture.cleanup();
});

async function recorded(runId: string) {
  const [row] = await db.admin`
    select (select state ->> 'kind' from runtime.runs where run_id = ${runId}) as state,
      (select count(*)::int from runtime.invocations where run_id = ${runId}) as invocations,
      (select disposition ->> 'kind' from runtime.questions where run_id = ${runId}) as question`;
  return row as { state: string; invocations: number; question: string };
}

const connectionLost = () => Object.assign(new Error('Connection closed'), { code: 'ERR_POSTGRES_CONNECTION_CLOSED' });

describe('accepting an answer', () => {
  test('a false answer is accepted once and delivered through the saved interrupt', async () => {
    const { runId, questionId } = await life.waitingRun();
    const result = await life.answer(runId, questionId, { answer: false });
    if (result.kind !== 'accepted') throw new Error(result.kind);
    expect(result.resume.envelope).toEqual({ questionId, answer: false });
    expect(await recorded(runId)).toEqual({ state: 'working', invocations: 2, question: 'answered' });

    const continuation = new ScriptedModel([echoStep]);
    expect(await life.resume(runId, continuation, result.resume)).toEqual({ kind: 'finished' });
    expect(continuation.calls).toHaveLength(1);
    expect(JSON.parse(String(continuation.calls[0]?.messages.at(-1)?.content))).toEqual({
      outcome: 'ok',
      result: { answer: false },
    });
    const [operation] = await db.admin`
      select disposition ->> 'kind' as kind from runtime.tool_operations where run_id = ${runId}`;
    expect(operation.kind).toBe('completed');
  });

  test('null, zero and permitted empty text are answers, not missing input', async () => {
    const cases: { input: QuestionInput; answer: Answer }[] = [
      { input: { kind: 'text', minLength: 0, maxLength: 10 } as const, answer: '' },
      {
        input: {
          kind: 'choice',
          multiple: false,
          options: [
            { label: 'None', value: null },
            { label: 'Zero', value: 0 },
          ],
        } as const,
        answer: null,
      },
      {
        input: {
          kind: 'choice',
          multiple: false,
          options: [
            { label: 'None', value: null },
            { label: 'Zero', value: 0 },
          ],
        } as const,
        answer: 0,
      },
    ];
    for (const { input, answer } of cases) {
      const { runId, questionId } = await life.waitingRun([askStep(input), echoStep]);
      const result = await life.answer(runId, questionId, { answer });
      expect(result.kind === 'accepted' && result.acceptance.answer).toBe(answer);
    }
  });

  test('a repeated answer is acknowledged without another invocation, even after the run finished', async () => {
    const { runId, questionId } = await life.waitingRun();
    const first = await life.answer(runId, questionId, { answer: true });
    if (first.kind !== 'accepted') throw new Error(first.kind);
    const again = await life.answer(runId, questionId, { answer: true });
    expect(again).toEqual({
      kind: 'already_accepted',
      answer: true,
      acceptedAt: first.acceptance.acceptedAt,
      invocationId: first.acceptance.invocationId,
    });
    await life.resume(runId, new ScriptedModel([echoStep]), first.resume);
    const snapshot = await life.store.snapshot(runId);
    await life.store.transition({
      runId,
      expectedRevision: snapshot.revision,
      apply: async (tx) => {
        await tx`update runtime.invocations set disposition = 'settled', ended_at = now()
          where run_id = ${runId} and disposition = 'active'`;
      },
      next: {
        kind: 'failed',
        finishedAt: '2026-09-30T00:00:00.000000Z',
        failure: {
          category: 'runtime_failure',
          reason: 'test_stop',
          message: 'Stopped.',
          operation: { kind: 'runtime' },
        },
      },
    });
    expect((await life.answer(runId, questionId, { answer: true })).kind).toBe('already_accepted');
    expect((await life.answer(runId, questionId, { answer: false })).kind).toBe('answer_conflict');
    expect((await recorded(runId)).invocations).toBe(2);
  });

  test('two tabs answering differently at once: exactly one answer is accepted and it never changes', async () => {
    const { runId, questionId } = await life.waitingRun();
    const results = await Promise.all([
      life.answer(runId, questionId, { answer: true }),
      life.answer(runId, questionId, { answer: false }),
    ]);
    const kinds = results.map((result) => result.kind).sort();
    expect(kinds).toEqual(['accepted', 'answer_conflict']);
    const winner = results.find((result) => result.kind === 'accepted');
    const [row] =
      await db.admin`select disposition -> 'answer' as answer from runtime.questions where run_id = ${runId}`;
    expect(row.answer).toBe(winner?.kind === 'accepted' ? winner.acceptance.answer : 'none');
    expect((await recorded(runId)).invocations).toBe(2);
  });

  test('unknown or misdirected questions and invalid answers change nothing', async () => {
    const { runId, questionId } = await life.waitingRun();
    const other = await life.waitingRun();
    expect(await life.answer(runId, 'f'.repeat(64), { answer: true })).toEqual({
      kind: 'not_found',
      target: 'run_or_question',
    });
    expect(await life.answer(runId, other.questionId, { answer: true })).toEqual({
      kind: 'not_found',
      target: 'run_or_question',
    });
    expect(await life.answer(runId, questionId, { answer: 'false' })).toEqual({
      kind: 'answer_invalid',
      code: 'answer_not_an_option',
    });
    expect(await life.answer(runId, questionId, {})).toEqual({ kind: 'answer_invalid', code: 'answer_missing' });
    expect(await recorded(runId)).toEqual({ state: 'waiting', invocations: 1, question: 'pending' });
  });
});

describe('continuation verification', () => {
  test('a temporary inability to read saved state accepts nothing and changes nothing', async () => {
    const { runId, questionId } = await life.waitingRun();
    const healthy = life.saver;
    const unreadable = Object.create(healthy) as typeof healthy;
    unreadable.getTuple = async () => {
      throw connectionLost();
    };
    life.saver = unreadable;
    try {
      expect(await life.answer(runId, questionId, { answer: true })).toEqual({ kind: 'cannot_verify' });
    } finally {
      life.saver = healthy;
    }
    expect(await recorded(runId)).toEqual({ state: 'waiting', invocations: 1, question: 'pending' });
    expect((await life.answer(runId, questionId, { answer: true })).kind).toBe('accepted');
  });

  test('changed execution code closes the question and fails the run as continuation unavailable', async () => {
    const { runId, questionId } = await life.waitingRun();
    const original = life.code;
    life.code = async (): Promise<CodeManifest> => {
      const code = await original();
      return {
        ...code,
        executionCode: code.executionCode.map((entry) =>
          entry.path === 'src/execution/tools.ts' ? { ...entry, digest: '0'.repeat(64) } : entry,
        ),
      };
    };
    try {
      expect(await life.answer(runId, questionId, { answer: true })).toEqual({
        kind: 'continuation_unavailable',
        problem: 'definition_changed',
      });
    } finally {
      life.code = original;
    }
    expect(await recorded(runId)).toEqual({ state: 'failed', invocations: 1, question: 'closed' });
    const [run] = await db.admin`select state -> 'failure' as failure from runtime.runs where run_id = ${runId}`;
    expect(run.failure).toMatchObject({ category: 'continuation_unavailable', reason: 'definition_changed' });
    expect(await life.answer(runId, questionId, { answer: true })).toEqual({ kind: 'not_answerable' });
  });

  test('missing saved state and an unconstructible stored binding are confirmed refusals', async () => {
    const missing = await life.waitingRun();
    await life.saver.deleteThread(missing.runId);
    expect(await life.answer(missing.runId, missing.questionId, { answer: true })).toEqual({
      kind: 'continuation_unavailable',
      problem: 'saved_state_missing',
    });

    const unbound = await life.waitingRun();
    const original = life.reconstruct;
    life.reconstruct = () => ({ ok: false });
    try {
      expect(await life.answer(unbound.runId, unbound.questionId, { answer: true })).toEqual({
        kind: 'continuation_unavailable',
        problem: 'run_binding_unavailable',
      });
    } finally {
      life.reconstruct = original;
    }
    expect((await recorded(unbound.runId)).state).toBe('failed');
  });
});

describe('uncertain commits', () => {
  test('an acceptance that committed is found by readback; one that did not is reported as not stored', async () => {
    const committed = await life.waitingRun();
    const afterCommit = Object.create(life.store) as typeof life.store;
    afterCommit.acceptAnswer = async (input) => {
      await life.store.acceptAnswer(input);
      throw connectionLost();
    };
    const first = await life.answer(
      committed.runId,
      committed.questionId,
      { answer: false },
      life.answerDeps({ store: afterCommit }),
    );
    expect(first.kind).toBe('accepted');
    expect((await recorded(committed.runId)).invocations).toBe(2);

    const lost = await life.waitingRun();
    const beforeCommit = Object.create(life.store) as typeof life.store;
    beforeCommit.acceptAnswer = async () => {
      throw connectionLost();
    };
    expect(
      await life.answer(lost.runId, lost.questionId, { answer: false }, life.answerDeps({ store: beforeCommit })),
    ).toEqual({
      kind: 'storage_failed',
    });
    expect(await recorded(lost.runId)).toEqual({ state: 'waiting', invocations: 1, question: 'pending' });
  });

  test('when ownership cannot be re-verified, the outcome is unknown and nothing may be dispatched', async () => {
    const { runId, questionId } = await life.waitingRun();
    const unverifiable = Object.create(life.store) as typeof life.store;
    unverifiable.acceptAnswer = async () => {
      throw connectionLost();
    };
    unverifiable.withCommitCertainty = async () => {
      const { RunStoreError } = await import('../../packages/runtime/src/records/run-store.ts');
      throw new RunStoreError('acceptance_unknown', 'unknown');
    };
    expect(await life.answer(runId, questionId, { answer: true }, life.answerDeps({ store: unverifiable }))).toEqual({
      kind: 'acceptance_unknown',
    });
  });
});
