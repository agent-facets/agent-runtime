// Regression guard for the Bun 1.3.14 pool defect: under contention a plain pool query could run inside another
// caller's transaction (and fail with 25P02 when that transaction aborted, or leave the connection stuck). The
// runtime therefore issues every statement in an explicit transaction. This drives the contention that exposed it.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { sessionTransaction } from '../../packages/runtime/src/persistence/app-database.ts';
import { sqlStateOf } from '../../packages/runtime/src/persistence/errors.ts';
import { openPersistence, type Persistence } from '../../packages/runtime/src/persistence/persistence.ts';
import { type CreateRunInput, RunStore } from '../../packages/runtime/src/records/run-store.ts';
import { binding, DIGEST, workspace } from '../support/run-records.ts';
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

describe('application SQL under pool contention', () => {
  test('conflicting transactions never leak into, or poison, concurrent reads and creations', async () => {
    const tally: Record<string, number> = {};
    const note = (label: string) => {
      tally[label] = (tally[label] ?? 0) + 1;
    };

    for (let round = 0; round < 25; round++) {
      const input: CreateRunInput = {
        requestId: crypto.randomUUID(),
        goal: 'Inspect the repository',
        provider: 'anthropic',
        workspace,
        binding: binding as CreateRunInput['binding'],
        definition: { digest: DIGEST, manifest: { protocolVersion: 1 } },
        budgetMax: 50,
      };
      let probing = true;
      const probes = (async () => {
        while (probing) {
          await Promise.all(
            Array.from({ length: 4 }, () =>
              persistence.app
                // A plain SELECT never has a transaction ID of its own; one here means it ran in a writer's transaction.
                .readOnly((tx) => tx`select pg_current_xact_id_if_assigned()::text as xid`)
                .then(
                  ([row]) => note(row.xid === null ? 'probe:isolated' : 'probe:inside-writer'),
                  (error) => note(`probe:${sqlStateOf(error) ?? 'error'}`),
                ),
            ),
          );
        }
      })();
      const creations = await Promise.allSettled(Array.from({ length: 10 }, () => store.createRun(input)));
      probing = false;
      await probes;
      for (const result of creations) {
        note(
          result.status === 'fulfilled'
            ? `create:${result.value.created}`
            : `create:${sqlStateOf(result.reason) ?? 'error'}`,
        );
      }
      const runIds = new Set(
        creations.flatMap((result) => (result.status === 'fulfilled' ? [result.value.snapshot.runId] : [])),
      );
      expect(runIds.size).toBe(1);
    }

    expect(Object.keys(tally).sort()).toEqual(['create:false', 'create:true', 'probe:isolated']);
    expect(tally['create:true']).toBe(25);
    expect(tally['create:false']).toBe(225);

    const [stuck] = await db.admin`
      select count(*)::int as n from pg_stat_activity
      where datname = ${db.name} and state like 'idle in transaction%'`;
    expect(stuck.n).toBe(0);
  }, 120_000);
});

// Bun 1.3.14: a failed ReservedSQL.begin() rejects to its caller and also raises an unhandled rejection (which
// bun:test reports as a failure). Reserved sessions use sessionTransaction() instead.
describe('transactions on reserved sessions', () => {
  test('a failed transaction rolls back cleanly and leaves the session in autocommit', async () => {
    await db.admin.unsafe('create table if not exists session_tx (v int check (v < 10))');
    const session = await persistence.app.reserve();
    try {
      let code: string | undefined;
      try {
        await sessionTransaction(session, async () => {
          await session`insert into session_tx values (1)`;
          await session`insert into session_tx values (${50})`;
        });
      } catch (error) {
        code = sqlStateOf(error);
      }
      expect(code).toBe('23514');
      await Bun.sleep(100);
      // Autocommit again: a plain insert on the session is visible to another connection at once.
      await session`insert into session_tx values (2)`;
      expect((await db.admin`select v from session_tx order by v`).map((row: { v: number }) => row.v)).toEqual([2]);

      await sessionTransaction(session, () => session`insert into session_tx values (3)`);
      expect((await db.admin`select v from session_tx order by v`).map((row: { v: number }) => row.v)).toEqual([2, 3]);
    } finally {
      session.release();
    }
  });
});
