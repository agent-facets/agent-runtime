import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { openPersistence, type Persistence } from '../../packages/runtime/src/persistence/persistence.ts';
import {
  type CreateRunInput,
  type NewEvent,
  RunStore,
  RunStoreError,
} from '../../packages/runtime/src/records/run-store.ts';
import type { RunState } from '../../packages/runtime/src/records/schemas.ts';
import { AT, binding, DIGEST, workspace } from '../support/run-records.ts';
import { createScratchDatabase, type ScratchDatabase } from '../support/scratch-database.ts';

let db: ScratchDatabase;
let persistence: Persistence;
let store: RunStore;
beforeAll(async () => {
  db = await createScratchDatabase();
  persistence = await openPersistence({ url: db.url, onFault: () => {} });
  store = new RunStore(persistence.app, persistence.ownership);
});
afterAll(async () => {
  await persistence.close();
  await db.drop();
});

const request = (overrides: Partial<CreateRunInput> = {}): CreateRunInput => ({
  requestId: crypto.randomUUID(),
  goal: 'Inspect the repository',
  provider: 'anthropic',
  workspace,
  binding: binding as CreateRunInput['binding'],
  definition: { digest: DIGEST, manifest: { protocolVersion: 1 } },
  budgetMax: 50,
  ...overrides,
});

const message = (id: string, text = id): NewEvent => ({
  event: { kind: 'assistant.message', payload: { messageId: id, text } },
  sourceKey: `message:${id}`,
});

async function errorCode(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return 'ok';
  } catch (error) {
    return error instanceof RunStoreError ? error.code : `unexpected: ${String(error)}`;
  }
}

async function newRun() {
  return (await store.createRun(request())).snapshot;
}

describe('creation idempotency', () => {
  test('concurrent submissions of one request create exactly one run and one invocation', async () => {
    const input = request();
    const results = await Promise.all(Array.from({ length: 10 }, () => store.createRun(input)));
    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(new Set(results.map((result) => result.snapshot.runId)).size).toBe(1);

    const runId = results[0]?.snapshot.runId as string;
    const [counts] = await db.admin`
      select (select count(*) from runtime.runs where create_request_id = ${input.requestId})::int as runs,
             (select count(*) from runtime.invocations where run_id = ${runId})::int as invocations,
             (select count(*) from runtime.events where run_id = ${runId})::int as events`;
    expect(counts).toEqual({ runs: 1, invocations: 1, events: 2 });
  });

  test('a reused request ID with different content is a conflict, never a second run', async () => {
    const input = request();
    await store.createRun(input);
    expect(await errorCode(store.createRun({ ...input, goal: 'Something else' }))).toBe('request_conflict');
    const [row] =
      await db.admin`select count(*)::int as n from runtime.runs where create_request_id = ${input.requestId}`;
    expect(row.n).toBe(1);
  });

  test('a new run starts working with its creation history and budget', async () => {
    const snapshot = await newRun();
    expect(snapshot.state.kind).toBe('working');
    expect(snapshot.revision).toBe('1');
    expect(snapshot.throughSeq).toBe('2');
    expect(snapshot.budget).toEqual({ maximum: 50, consumed: 0, unconfirmed: 0 });
    const events = await store.readEvents(snapshot.runId, { after: '0', limit: 10 });
    expect(events.map((event) => [event.seq, event.event.kind])).toEqual([
      ['1', 'run.created'],
      ['2', 'run.status'],
    ]);
  });
});

describe('event history', () => {
  test('concurrent activity gets a contiguous sequence in commit order', async () => {
    const { runId } = await newRun();
    const stored = await Promise.all(
      Array.from({ length: 25 }, (_, index) => store.recordActivity(runId, [message(`m${index}`)])),
    );
    const seqs = stored
      .flat()
      .map((event) => Number(event.seq))
      .sort((a, b) => a - b);
    expect(seqs).toEqual(Array.from({ length: 25 }, (_, index) => index + 3));

    const history = await store.readEvents(runId, { after: '0', limit: 100 });
    expect(history.map((event) => event.seq)).toEqual(Array.from({ length: 27 }, (_, index) => String(index + 1)));
    const recordedOrder = history.map((event) => event.recordedAt);
    expect([...recordedOrder].sort()).toEqual(recordedOrder);
  });

  test('a rolled-back transaction leaves no event and no gap', async () => {
    const { runId } = await newRun();
    const failing = store.transition({
      runId,
      expectedRevision: '1',
      next: { kind: 'cancelling', cancellationId: crypto.randomUUID(), acceptedAt: AT },
      apply: async () => {
        throw new Error('simulated failure inside the transaction');
      },
    });
    await expect(failing).rejects.toThrow('simulated failure');
    expect((await store.snapshot(runId)).throughSeq).toBe('2');
    const [next] = await store.recordActivity(runId, [message('after-rollback')]);
    expect(next?.seq).toBe('3');
  });

  test('replaying a source key with the same event is idempotent; different content is refused', async () => {
    const { runId } = await newRun();
    const [first] = await store.recordActivity(runId, [message('same', 'hello')]);
    const [again] = await store.recordActivity(runId, [message('same', 'hello')]);
    expect(again?.seq).toBe(first?.seq as string);
    expect(again?.recordedAt).toBe(first?.recordedAt as string);
    expect(await errorCode(store.recordActivity(runId, [message('same', 'changed')]))).toBe('source_key_conflict');
    expect((await store.snapshot(runId)).throughSeq).toBe('3');
  });

  test('cursors are decimal strings, including beyond the JavaScript safe-integer range', async () => {
    const { runId } = await newRun();
    expect(await store.readEvents(runId, { after: '9007199254740993', limit: 10 })).toEqual([]);
    expect((await store.readEvents(runId, { after: '1', through: '2', limit: 10 })).map((event) => event.seq)).toEqual([
      '2',
    ]);
    await expect(store.readEvents(runId, { after: '1.5', limit: 10 })).rejects.toThrow(RangeError);
    await expect(store.readEvents(runId, { after: '9223372036854775808', limit: 10 })).rejects.toThrow(RangeError);
  });
});

describe('state transitions', () => {
  const finish = (runId: string, expectedRevision: string, resultSeq: string): Promise<unknown> =>
    store
      .transition({
        runId,
        expectedRevision,
        next: {
          kind: 'failed',
          finishedAt: AT,
          failure: {
            category: 'runtime_failure',
            reason: 'test_stop',
            message: 'Stopped by the test.',
            operation: { kind: 'runtime' },
          },
        },
        apply: async (tx) => {
          await tx`update runtime.invocations set disposition = 'settled', ended_at = now()
          where run_id = ${runId} and disposition = 'active'`;
        },
      })
      .then(() => resultSeq);

  test('a transition and its status event commit together and advance the revision', async () => {
    const { runId } = await newRun();
    await finish(runId, '1', '3');
    const snapshot = await store.snapshot(runId);
    expect(snapshot.state.kind).toBe('failed');
    expect(snapshot.revision).toBe('2');
    const [status] = await store.readEvents(runId, { after: '2', limit: 10 });
    expect(status?.event).toEqual({ kind: 'run.status', payload: { revision: '2', state: snapshot.state } });
  });

  test('competing transitions from one revision: exactly one wins, the other sees a stale revision', async () => {
    const { runId, state } = await newRun();
    // Cancellation retains the still-active invocation until its work settles.
    const invocationId = state.kind === 'working' ? state.invocationId : '';
    const cancel = (id: string): Promise<unknown> =>
      store.transition({
        runId,
        expectedRevision: '1',
        next: { kind: 'cancelling', cancellationId: id, acceptedAt: AT, invocationId },
      });
    const outcomes = await Promise.all([
      errorCode(cancel(crypto.randomUUID())),
      errorCode(cancel(crypto.randomUUID())),
    ]);
    expect(outcomes.sort()).toEqual(['ok', 'stale_revision']);
    expect((await store.snapshot(runId)).revision).toBe('2');
  });

  test('a finished outcome never changes and refuses later activity', async () => {
    const { runId } = await newRun();
    await finish(runId, '1', '3');
    const cancelled: RunState = {
      kind: 'cancelled',
      finishedAt: AT,
      cancellationId: crypto.randomUUID(),
      acceptedAt: AT,
    };
    expect(await errorCode(store.transition({ runId, expectedRevision: '2', next: cancelled }))).toBe('run_finished');
    expect(await errorCode(store.recordActivity(runId, [message('late')]))).toBe('run_finished');
    expect((await store.snapshot(runId)).state.kind).toBe('failed');
  });

  test('a stale owner cannot create or change runs', async () => {
    const { runId } = await newRun();
    const staleStore = new RunStore(persistence.app, {
      ownerId: crypto.randomUUID(),
      epoch: persistence.ownership.epoch,
      assertHeld: () => {},
      verify: async () => {},
    });
    await expect(staleStore.createRun(request())).rejects.toMatchObject({ code: 'stale_owner' });
    await expect(staleStore.recordActivity(runId, [message('stale')])).rejects.toMatchObject({ code: 'stale_owner' });
  });
});

describe('snapshots', () => {
  test('each snapshot is internally consistent while writers append concurrently', async () => {
    const { runId } = await newRun();
    let writing = true;
    const writer = (async () => {
      for (let index = 0; writing && index < 200; index++) await store.recordActivity(runId, [message(`w${index}`)]);
    })();
    const snapshots = [];
    for (let index = 0; index < 20; index++) snapshots.push(await store.snapshot(runId));
    writing = false;
    await writer;

    for (const snapshot of snapshots) {
      const events = await store.readEvents(runId, { after: '0', through: snapshot.throughSeq, limit: 1_000 });
      expect(events.length).toBe(Number(snapshot.throughSeq));
      expect(events.at(-1)?.seq).toBe(snapshot.throughSeq);
    }
    const bounds = snapshots.map((snapshot) => Number(snapshot.throughSeq));
    expect([...bounds].sort((a, b) => a - b)).toEqual(bounds);
  });
});

describe('ambiguous commits', () => {
  const connectionLost = () =>
    Object.assign(new Error('Connection closed'), { code: 'ERR_POSTGRES_CONNECTION_CLOSED' });

  test('a commit that happened is found by readback before anything is dispatched', async () => {
    const input = request();
    const outcome = await store.withCommitCertainty(
      async () => {
        await store.createRun(input);
        throw connectionLost();
      },
      async () => store.findCreation(input.requestId),
    );
    expect(outcome.committed).toBe(true);
  });

  test('a commit that did not happen is reported as not committed', async () => {
    const outcome = await store.withCommitCertainty(
      async () => {
        throw connectionLost();
      },
      async () => store.findCreation(crypto.randomUUID()),
    );
    expect(outcome).toEqual({ committed: false });
  });

  test('without verified ownership the outcome stays unknown', async () => {
    const detached = new RunStore(persistence.app, {
      ownerId: persistence.ownership.ownerId,
      epoch: persistence.ownership.epoch,
      assertHeld: () => {},
      verify: async () => {
        throw new Error('ownership cannot be verified');
      },
    });
    const outcome = detached.withCommitCertainty(
      async () => {
        throw connectionLost();
      },
      async () => undefined,
    );
    expect(await errorCode(outcome)).toBe('acceptance_unknown');
  });

  test('definite rejections are not treated as uncertain', async () => {
    const outcome = store.withCommitCertainty(
      () => store.recordActivity(crypto.randomUUID(), [message('missing-run')]),
      async () => undefined,
    );
    expect(await errorCode(outcome)).toBe('run_not_found');
  });
});
