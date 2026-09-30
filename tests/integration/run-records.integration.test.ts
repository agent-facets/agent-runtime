import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { TransactionSQL } from 'bun';
import { sqlStateOf } from '../../packages/runtime/src/persistence/errors.ts';
import { jsonText } from '../../packages/runtime/src/persistence/json.ts';
import { openPersistence, type Persistence } from '../../packages/runtime/src/persistence/persistence.ts';
import { operationIdFor } from '../../packages/runtime/src/records/schemas.ts';
import {
  AT,
  acceptAnswer,
  binding,
  DIGEST,
  insertEvent,
  pauseOnQuestion,
  type SeededRun,
  seedWorkingRun,
  workspace,
} from '../support/run-records.ts';
import { createScratchDatabase, type ScratchDatabase } from '../support/scratch-database.ts';

let db: ScratchDatabase;
let persistence: Persistence;
beforeAll(async () => {
  db = await createScratchDatabase();
  persistence = await openPersistence({ url: db.url, onFault: () => {} });
});
afterAll(async () => {
  await persistence.close();
  await db.drop();
});

const j = (value: unknown) => jsonText(value);

/**
 * Runs a transaction and returns 'committed' or the SQLSTATE that refused it (immediately or at commit). Refusals
 * must be integrity errors, so a syntax error or broken fixture can never pass as a rejected record.
 */
async function commits(body: (tx: TransactionSQL) => Promise<unknown>): Promise<string> {
  try {
    await persistence.app.transaction(body);
    return 'committed';
  } catch (error) {
    return sqlStateOf(error) ?? `no sqlstate: ${error instanceof Error ? error.message : String(error)}`;
  }
}
const REFUSED = /^(23\d{3}|P0001)$/;

async function seeded(): Promise<SeededRun> {
  let run: SeededRun | undefined;
  expect(
    await commits(async (tx) => {
      run = await seedWorkingRun(tx);
    }),
  ).toBe('committed');
  return run as SeededRun;
}

describe('run records', () => {
  test('a consistent new run commits, even though its rows reference each other in both directions', async () => {
    const run = await seeded();
    const [row] = await persistence.app.readOnly(
      (tx) => tx`
      select state_kind, state_invocation_id::text as invocation, last_seq::text as last_seq
      from runtime.runs where run_id = ${run.runId}`,
    );
    expect(row).toEqual({ state_kind: 'working', invocation: run.invocationId, last_seq: '2' });
  });

  test('refuses invalid run-state unions, including JSON null and unknown keys', async () => {
    const run = await seeded();
    const invalid = [
      { kind: 'working', invocationId: run.invocationId, ownerEpoch: run.epoch, extra: true },
      { kind: 'waiting', questionId: DIGEST, bindingDigest: DIGEST, invocationId: run.invocationId },
      { kind: 'failed', finishedAt: AT, failure: { category: 'runtime_failure', reason: 'x', message: 'y' } },
      { kind: 'succeeded', finishedAt: AT },
      null,
    ];
    for (const state of invalid) {
      expect(
        await commits(
          (tx) => tx`update runtime.runs set state = ${j(state)}::text::jsonb, revision = revision + 1
          where run_id = ${run.runId}`,
        ),
      ).toMatch(REFUSED);
    }
    expect(await commits((tx) => tx`update runtime.runs set state = null where run_id = ${run.runId}`)).toMatch(
      REFUSED,
    );
  });

  test('refuses workspace and provider bindings outside the enabled subscription pairs', async () => {
    for (const [field, value] of [
      ['binding', { ...binding, authMode: 'api_key' }],
      ['binding', { ...binding, provider: 'anthropic-api' }],
      ['binding', { ...binding, apiKey: 'sk-test' }],
      ['workspace', { ...workspace, root: 'relative/path' }],
    ] as const) {
      expect(
        await commits(async (tx) => {
          const run = await seedWorkingRun(tx);
          await tx.unsafe(`update runtime.runs set ${field} = $1::text::jsonb where run_id = $2`, [
            j(value),
            run.runId,
          ]);
        }),
      ).toMatch(REFUSED);
    }
  });

  test('refuses an oversubscribed budget and counters that disagree with recorded attempts', async () => {
    const run = await seeded();
    expect(
      await commits((tx) => tx`update runtime.runs set consumed = 30, unconfirmed = 21 where run_id = ${run.runId}`),
    ).toMatch(REFUSED);
    // Counters must be backed by attempts: one consumed step needs one dispatched attempt.
    expect(await commits((tx) => tx`update runtime.runs set consumed = 1 where run_id = ${run.runId}`)).toMatch(
      REFUSED,
    );
    expect(
      await commits(async (tx) => {
        await tx`insert into runtime.model_attempts (run_id, attempt_id, invocation_id, ordinal, provider, model,
            profile_id, state)
          values (${run.runId}, ${crypto.randomUUID()}, ${run.invocationId}, 1, 'anthropic', 'claude-test',
            'anthropic.subscription.v1', ${j({ kind: 'dispatched', dispatchedAt: AT })}::text::jsonb)`;
        await tx`update runtime.runs set consumed = 1 where run_id = ${run.runId}`;
      }),
    ).toBe('committed');
  });

  test('refuses an attempt whose provider binding differs from the run', async () => {
    const run = await seeded();
    expect(
      await commits(async (tx) => {
        await tx`insert into runtime.model_attempts (run_id, attempt_id, invocation_id, ordinal, provider, model,
            profile_id, state)
          values (${run.runId}, ${crypto.randomUUID()}, ${run.invocationId}, 1, 'openai', 'claude-test',
            'anthropic.subscription.v1', ${j({ kind: 'reserved' })}::text::jsonb)`;
        await tx`update runtime.runs set unconfirmed = 1 where run_id = ${run.runId}`;
      }),
    ).toMatch(REFUSED);
  });

  test('refuses cross-run references', async () => {
    const [a, b] = [await seeded(), await seeded()];
    // Run A cannot point its working state at run B's invocation.
    const foreignState = { kind: 'working', invocationId: b.invocationId, ownerEpoch: a.epoch };
    expect(
      await commits(
        (tx) => tx`update runtime.runs set state = ${j(foreignState)}::text::jsonb, revision = revision + 1
        where run_id = ${a.runId}`,
      ),
    ).toMatch(REFUSED);
    // An attempt in run A cannot belong to run B's invocation.
    expect(
      await commits(async (tx) => {
        await tx`insert into runtime.model_attempts (run_id, attempt_id, invocation_id, ordinal, provider, model,
            profile_id, state)
          values (${a.runId}, ${crypto.randomUUID()}, ${b.invocationId}, 1, 'anthropic', 'claude-test',
            'anthropic.subscription.v1', ${j({ kind: 'reserved' })}::text::jsonb)`;
        await tx`update runtime.runs set unconfirmed = 1 where run_id = ${a.runId}`;
      }),
    ).toMatch(REFUSED);
  });

  test('allows at most one pending question per run', async () => {
    let question: Awaited<ReturnType<typeof pauseOnQuestion>> | undefined;
    expect(
      await commits(async (tx) => {
        question = await pauseOnQuestion(tx, await seedWorkingRun(tx));
      }),
    ).toBe('committed');
    expect(
      await commits(async (tx) => {
        const run = question as SeededRun;
        const second = operationIdFor(run.runId, 'message-call-2', 'call-2');
        await tx`insert into runtime.tool_operations (run_id, operation_id, model_message_id, provider_tool_call_id,
            tool_name, arguments, argument_digest, disposition)
          values (${run.runId}, ${second}, 'message-call-2', 'call-2', 'mcp_AskUser', '{}'::jsonb, ${DIGEST},
            ${j({ kind: 'paused', questionId: second })}::text::jsonb)`;
        await tx`insert into runtime.questions (run_id, question_id, operation_id, prompt, input, binding,
            payload_digest, binding_digest, disposition)
          select run_id, ${second}, ${second}, prompt, input,
            jsonb_set(binding, '{operationId}', to_jsonb(${second}::text)), payload_digest, binding_digest, disposition
          from runtime.questions where run_id = ${run.runId}`;
      }),
    ).toMatch(REFUSED);
  });

  test('accepts false and null answers, and an accepted answer can never change', async () => {
    for (const answer of [false, null]) {
      let question: Awaited<ReturnType<typeof pauseOnQuestion>> | undefined;
      expect(
        await commits(async (tx) => {
          question = await pauseOnQuestion(tx, await seedWorkingRun(tx));
        }),
      ).toBe('committed');
      const q = question as NonNullable<typeof question>;
      expect(await commits((tx) => acceptAnswer(tx, q, answer))).toBe('committed');

      const [row] = await persistence.app.readOnly(
        (tx) => tx`
        select disposition::text as disposition from runtime.questions
        where run_id = ${q.runId} and question_id = ${q.questionId}`,
      );
      const disposition = JSON.parse(row.disposition) as { kind: string; answer?: unknown };
      expect(disposition.kind).toBe('answered');
      expect(Object.hasOwn(disposition, 'answer')).toBe(true);
      expect(disposition.answer).toBe(answer);

      const conflicting = { ...disposition, answer: true };
      expect(
        await commits(
          (tx) => tx`update runtime.questions set disposition = ${j(conflicting)}::text::jsonb
          where run_id = ${q.runId} and question_id = ${q.questionId}`,
        ),
      ).toMatch(REFUSED);
    }
  });

  test('an answered disposition without the answer property is refused', async () => {
    let question: Awaited<ReturnType<typeof pauseOnQuestion>> | undefined;
    await commits(async (tx) => {
      question = await pauseOnQuestion(tx, await seedWorkingRun(tx));
    });
    const q = question as NonNullable<typeof question>;
    const missing = { kind: 'answered', acceptedAt: AT, invocationId: crypto.randomUUID() };
    expect(
      await commits(
        (tx) => tx`update runtime.questions set disposition = ${j(missing)}::text::jsonb
        where run_id = ${q.runId} and question_id = ${q.questionId}`,
      ),
    ).toMatch(REFUSED);
  });

  test('a waiting run must reference its pending question and binding', async () => {
    let question: Awaited<ReturnType<typeof pauseOnQuestion>> | undefined;
    await commits(async (tx) => {
      question = await pauseOnQuestion(tx, await seedWorkingRun(tx));
    });
    const q = question as NonNullable<typeof question>;
    const wrongBinding = { kind: 'waiting', questionId: q.questionId, bindingDigest: 'e'.repeat(64) };
    expect(
      await commits(
        (tx) => tx`update runtime.runs set state = ${j(wrongBinding)}::text::jsonb, revision = revision + 1
        where run_id = ${q.runId}`,
      ),
    ).toMatch(REFUSED);
  });

  test('terminal outcomes, events and definitions are immutable, and history has no gaps', async () => {
    const run = await seeded();
    const finished = { kind: 'succeeded', finishedAt: AT, resultSeq: '3' };
    expect(
      await commits(async (tx) => {
        await insertEvent(
          tx,
          run.runId,
          3,
          'assistant.message',
          { messageId: 'final', text: 'Done.' },
          'message:final',
        );
        await tx`update runtime.invocations set disposition = 'settled', ended_at = now()
          where run_id = ${run.runId} and invocation_id = ${run.invocationId}`;
        await tx`update runtime.runs set state = ${j(finished)}::text::jsonb, revision = revision + 1,
          last_seq = 4 where run_id = ${run.runId}`;
        await insertEvent(tx, run.runId, 4, 'run.status', { revision: '2', state: finished }, 'status:2');
      }),
    ).toBe('committed');

    const cancelled = { kind: 'cancelled', finishedAt: AT, cancellationId: crypto.randomUUID(), acceptedAt: AT };
    expect(
      await commits(
        (tx) => tx`update runtime.runs set state = ${j(cancelled)}::text::jsonb, revision = revision + 1
        where run_id = ${run.runId}`,
      ),
    ).toMatch(REFUSED);
    expect(await commits((tx) => tx`update runtime.events set source_key = 'x' where run_id = ${run.runId}`)).toMatch(
      REFUSED,
    );
    expect(await commits((tx) => tx`delete from runtime.events where run_id = ${run.runId}`)).toMatch(REFUSED);
    expect(await commits((tx) => tx`update runtime.execution_definitions set manifest = '{}'::jsonb`)).toMatch(REFUSED);
    expect(await commits((tx) => tx`delete from runtime.runs where run_id = ${run.runId}`)).toMatch(REFUSED);

    const other = await seeded();
    expect(
      await commits(async (tx) => {
        await insertEvent(tx, other.runId, 4, 'assistant.message', { messageId: 'm', text: 'skipped 3' }, 'message:m');
        await tx`update runtime.runs set last_seq = 4 where run_id = ${other.runId}`;
      }),
    ).toMatch(REFUSED);
  });

  test('success must point at a recorded assistant result', async () => {
    const run = await seeded();
    const finished = { kind: 'succeeded', finishedAt: AT, resultSeq: '2' };
    expect(
      await commits(async (tx) => {
        await tx`update runtime.invocations set disposition = 'settled', ended_at = now()
          where run_id = ${run.runId} and invocation_id = ${run.invocationId}`;
        await tx`update runtime.runs set state = ${j(finished)}::text::jsonb, revision = revision + 1
          where run_id = ${run.runId}`;
      }),
    ).toMatch(REFUSED);
  });

  test('a new invocation must use the current owner epoch', async () => {
    const run = await seeded();
    expect(
      await commits(
        (tx) => tx`insert into runtime.invocations (run_id, invocation_id, owner_epoch, kind, disposition)
        values (${run.runId}, ${crypto.randomUUID()}, ${Number(run.epoch) + 7}, 'initial', 'active')`,
      ),
    ).toMatch(REFUSED);
  });

  test('model attempts only move forward', async () => {
    const run = await seeded();
    const attemptId = crypto.randomUUID();
    expect(
      await commits(async (tx) => {
        await tx`insert into runtime.model_attempts (run_id, attempt_id, invocation_id, ordinal, provider, model,
            profile_id, state)
          values (${run.runId}, ${attemptId}, ${run.invocationId}, 1, 'anthropic', 'claude-test',
            'anthropic.subscription.v1', ${j({ kind: 'reserved' })}::text::jsonb)`;
        await tx`update runtime.runs set unconfirmed = 1 where run_id = ${run.runId}`;
      }),
    ).toBe('committed');
    const completed = { kind: 'completed', dispatchedAt: AT, completedAt: AT, outcome: 'ok' };
    expect(
      await commits(async (tx) => {
        await tx`update runtime.model_attempts set state = ${j(completed)}::text::jsonb
          where run_id = ${run.runId} and attempt_id = ${attemptId}`;
        await tx`update runtime.runs set unconfirmed = 0, consumed = 1 where run_id = ${run.runId}`;
      }),
    ).toMatch(REFUSED);
  });

  test('database and runtime compute the same operation identity; reused call IDs are refused', async () => {
    const run = await seeded();
    const [row] = await persistence.app.readOnly(
      (tx) => tx`select runtime.operation_id(${run.runId}, 'message-1', 'call-1') as id`,
    );
    expect(row.id).toBe(operationIdFor(run.runId, 'message-1', 'call-1'));

    const insertOperation = (tx: TransactionSQL, messageId: string) => {
      const operationId = operationIdFor(run.runId, messageId, 'call-1');
      return tx`insert into runtime.tool_operations (run_id, operation_id, model_message_id, provider_tool_call_id,
          tool_name, arguments, argument_digest, disposition)
        values (${run.runId}, ${operationId}, ${messageId}, 'call-1', 'mcp_Read', '{}'::jsonb, ${DIGEST},
          ${j({ kind: 'started' })}::text::jsonb)`;
    };
    expect(await commits((tx) => insertOperation(tx, 'message-1'))).toBe('committed');
    // The same provider call ID bound to a different model message is an invalid call, not a new operation.
    expect(await commits((tx) => insertOperation(tx, 'message-2'))).toMatch(REFUSED);
  });
});
