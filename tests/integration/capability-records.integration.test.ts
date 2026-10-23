// Database invariants of migration 4 (design Decisions 6–8): retained snapshots and command bindings, root and
// delegate actors, actor-scoped operation identity, loaded skills, versioned questions, attributed events and
// external dispatch dispositions. Records are seeded raw so the schema itself is the witness.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { TransactionSQL } from 'bun';
import { sqlStateOf } from '../../packages/runtime/src/persistence/errors.ts';
import { jsonText } from '../../packages/runtime/src/persistence/json.ts';
import { openPersistence, type Persistence } from '../../packages/runtime/src/persistence/persistence.ts';
import { operationIdV2 } from '../../packages/runtime/src/records/schemas.ts';
import {
  appendEvent,
  askFromDelegate,
  insertOperation,
  type SeededCommandRun,
  seedCommandRun,
  startDelegate,
} from '../support/capabilities.ts';
import { AT, DIGEST, pauseOnQuestion, seedWorkingRun } from '../support/run-records.ts';
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
const REFUSED = /^(23\d{3}|P0001)$/;
async function commits(body: (tx: TransactionSQL) => Promise<unknown>): Promise<string> {
  try {
    await persistence.app.transaction(body);
    return 'committed';
  } catch (error) {
    return sqlStateOf(error) ?? `no sqlstate: ${error instanceof Error ? error.message : String(error)}`;
  }
}

async function seeded<T>(seed: (tx: TransactionSQL) => Promise<T>): Promise<T> {
  let value: T | undefined;
  expect(
    await commits(async (tx) => {
      value = await seed(tx);
    }),
  ).toBe('committed');
  return value as T;
}
const commandRun = () => seeded((tx) => seedCommandRun(tx));

describe('run actors', () => {
  test('every new run gets exactly one root actor with the run', async () => {
    const run = await seeded((tx) => seedWorkingRun(tx));
    const rows = await db.admin`select actor_key, kind, state from runtime.run_actors where run_id = ${run.runId}`;
    expect(rows).toEqual([{ actor_key: 'root', kind: 'root', state: null }]);
    expect(
      await commits(
        (tx) => tx`insert into runtime.run_actors (run_id, actor_key, kind) values (${run.runId}, 'root', 'root')`,
      ),
    ).toMatch(REFUSED);
    expect(await commits((tx) => tx`delete from runtime.run_actors where run_id = ${run.runId}`)).toMatch(REFUSED);
  });

  test('a delegate is started by its parent root delegation operation in a command run', async () => {
    const run = await commandRun();
    expect(await commits((tx) => startDelegate(tx, run, 'call-d1'))).toBe('committed');
    // Native runs have no delegation limit to consume.
    const native = await seeded((tx) => seedWorkingRun(tx));
    expect(await commits((tx) => startDelegate(tx, native, 'call-d1'))).toMatch(REFUSED);
    // Without its delegation operation, or with one bound to a different agent, a delegate is refused.
    const other = await commandRun();
    expect(
      await commits(
        (tx) => tx`insert into runtime.run_actors (run_id, actor_key, kind, parent_actor, agent_id, task_digest,
          checkpoint_ns, state) values (${other.runId}, ${DIGEST}, 'delegate', 'root', 'agent:helper', ${DIGEST},
          'tools:x', ${j({ kind: 'active' })}::text::jsonb)`,
      ),
    ).toMatch(REFUSED);
    expect(
      await commits(async (tx) => {
        const id = await startDelegate(tx, other, 'call-d2');
        await tx`update runtime.tool_operations set tool_binding = ${j({ kind: 'delegation', agentId: 'agent:other' })}::text::jsonb
          where run_id = ${other.runId} and operation_id = ${id}`;
      }),
    ).toMatch(REFUSED);
  });

  test('delegations beyond the captured limit are refused', async () => {
    const run = await seeded((tx) => seedCommandRun(tx, { maxDelegations: 2 }));
    expect(await commits((tx) => startDelegate(tx, run, 'call-1'))).toBe('committed');
    expect(await commits((tx) => startDelegate(tx, run, 'call-2'))).toBe('committed');
    expect(await commits((tx) => startDelegate(tx, run, 'call-3'))).toMatch(REFUSED);
  });

  test('delegate identity is immutable and its state moves only forward', async () => {
    const run = await commandRun();
    const id = await seeded((tx) => startDelegate(tx, run, 'call-i'));
    const update = (sql: (tx: TransactionSQL) => Promise<unknown>) => commits(sql);
    expect(
      await update(
        (tx) =>
          tx`update runtime.run_actors set agent_id = 'agent:other' where run_id = ${run.runId} and actor_key = ${id}`,
      ),
    ).toMatch(REFUSED);
    const state = (value: unknown) =>
      update(
        (tx) => tx`update runtime.run_actors set state = ${j(value)}::text::jsonb
          where run_id = ${run.runId} and actor_key = ${id}`,
      );
    expect(await state({ kind: 'completed', outcome: { kind: 'result', text: 'Found it.' } })).toBe('committed');
    expect(await state({ kind: 'active' })).toMatch(REFUSED);
    expect(await state({ kind: 'abandoned', reason: 'interrupted' })).toMatch(REFUSED);
  });

  test('refuses contradictory actor shapes and unknown state fields', async () => {
    const run = await commandRun();
    for (const [kind, parent, state] of [
      ['root', null, { kind: 'active' }],
      ['delegate', null, { kind: 'active' }],
      ['delegate', 'root', { kind: 'active', extra: 1 }],
      ['delegate', 'root', { kind: 'waiting' }],
      ['delegate', 'root', { kind: 'completed', outcome: { kind: 'result' } }],
    ] as const) {
      expect(
        await commits(async (tx) => {
          const id = await insertOperation(tx, run.runId, {
            actorKey: 'root',
            callId: crypto.randomUUID(),
            toolName: 'mcp_Delegate',
            binding: { kind: 'delegation', agentId: 'agent:helper' },
          });
          await tx`insert into runtime.run_actors (run_id, actor_key, kind, parent_actor, agent_id, task_digest,
              checkpoint_ns, state)
            values (${run.runId}, ${id}, ${kind}, ${parent}, 'agent:helper', ${DIGEST}, 'tools:x', ${j(state)}::text::jsonb)`;
        }),
      ).toMatch(REFUSED);
    }
  });
});

describe('actor-scoped operations', () => {
  test('database and runtime compute the same version-2 identity', async () => {
    const run = await commandRun();
    const [row] = await db.admin`select runtime.operation_id_v2(${run.runId}, 'root', 'message-1', 'call-1') as id`;
    expect(row.id).toBe(operationIdV2(run.runId, 'root', 'message-1', 'call-1'));
  });

  test('a provider call ID is unique per actor, not per run', async () => {
    const run = await commandRun();
    const delegate = await seeded((tx) => startDelegate(tx, run, 'call-d'));
    expect(await commits((tx) => insertOperation(tx, run.runId, { actorKey: 'root', callId: 'call-1' }))).toBe(
      'committed',
    );
    expect(await commits((tx) => insertOperation(tx, run.runId, { actorKey: delegate, callId: 'call-1' }))).toBe(
      'committed',
    );
    // The same actor rebinding its call ID to another message is invalid, not a new operation.
    expect(
      await commits((tx) =>
        insertOperation(tx, run.runId, { actorKey: delegate, callId: 'call-1', messageId: 'message-other' }),
      ),
    ).toMatch(REFUSED);
  });

  test('identities must match their version; version 1 is always the root', async () => {
    const run = await commandRun();
    const delegate = await seeded((tx) => startDelegate(tx, run, 'call-d'));
    const insert = (version: number, actor: string, operationId: string) =>
      commits(
        (tx) => tx`insert into runtime.tool_operations (run_id, operation_id, model_message_id, provider_tool_call_id,
          tool_name, arguments, argument_digest, disposition, identity_version, actor_key)
        values (${run.runId}, ${operationId}, 'message-x', 'call-x', 'mcp_Read', '{}'::jsonb, ${DIGEST},
          ${j({ kind: 'started' })}::text::jsonb, ${version}, ${actor})`,
      );
    expect(await insert(2, delegate, operationIdV2(run.runId, 'root', 'message-x', 'call-x'))).toMatch(REFUSED);
    expect(await insert(1, delegate, operationIdV2(run.runId, delegate, 'message-x', 'call-x'))).toMatch(REFUSED);
    expect(await insert(2, delegate, operationIdV2(run.runId, delegate, 'message-x', 'call-x'))).toBe('committed');
  });

  test('operations name a same-run actor', async () => {
    const [a, b] = [await commandRun(), await commandRun()];
    const foreign = await seeded((tx) => startDelegate(tx, b, 'call-d'));
    expect(await commits((tx) => insertOperation(tx, a.runId, { actorKey: foreign, callId: 'call-1' }))).toMatch(
      REFUSED,
    );
    expect(
      await commits(
        (tx) => tx`insert into runtime.model_attempts (run_id, attempt_id, invocation_id, ordinal, provider, model,
          profile_id, state, actor_key)
        values (${a.runId}, ${crypto.randomUUID()}, ${a.invocationId}, 1, 'anthropic', 'claude-test',
          'anthropic.subscription.v1', ${j({ kind: 'reserved' })}::text::jsonb, ${foreign})`,
      ),
    ).toMatch(REFUSED);
  });

  test('tool bindings are strict and immutable', async () => {
    const run = await commandRun();
    for (const binding of [
      { kind: 'native', name: 'shell' },
      { kind: 'skill_reference', skillId: 'skill:review', path: '../escape' },
      { kind: 'mcp', serverId: 'github', toolName: 'list', definitionDigest: DIGEST, env: {} },
    ]) {
      expect(
        await commits((tx) =>
          insertOperation(tx, run.runId, { actorKey: 'root', callId: crypto.randomUUID(), binding }),
        ),
      ).toMatch(REFUSED);
    }
    const id = await seeded((tx) =>
      insertOperation(tx, run.runId, {
        actorKey: 'root',
        callId: 'call-b',
        binding: { kind: 'native', name: 'mcp_Read' },
      }),
    );
    expect(
      await commits(
        (
          tx,
        ) => tx`update runtime.tool_operations set tool_binding = ${j({ kind: 'native', name: 'mcp_Search' })}::text::jsonb
          where run_id = ${run.runId} and operation_id = ${id}`,
      ),
    ).toMatch(REFUSED);
  });

  test('dispatch intent and uncertainty exist only for external calls, and intent never becomes abandoned', async () => {
    const run = await commandRun();
    const mcp = { kind: 'mcp', serverId: 'github', toolName: 'list_issues', definitionDigest: DIGEST };
    const uncertain = { kind: 'completed', outcome: 'uncertain', result: { outcome: 'uncertain' } };
    expect(
      await commits((tx) =>
        insertOperation(tx, run.runId, {
          actorKey: 'root',
          callId: 'native',
          binding: { kind: 'native', name: 'mcp_Read' },
          disposition: { kind: 'dispatching' },
        }),
      ),
    ).toMatch(REFUSED);
    const id = await seeded((tx) => insertOperation(tx, run.runId, { actorKey: 'root', callId: 'mcp', binding: mcp }));
    const move = (disposition: unknown) =>
      commits(
        (tx) => tx`update runtime.tool_operations set disposition = ${j(disposition)}::text::jsonb
          where run_id = ${run.runId} and operation_id = ${id}`,
      );
    expect(await move(uncertain)).toMatch(REFUSED);
    expect(await move({ kind: 'dispatching' })).toBe('committed');
    expect(await move({ kind: 'abandoned', reason: 'interrupted' })).toMatch(REFUSED);
    expect(await move(uncertain)).toBe('committed');
  });
});

describe('command bindings and snapshots', () => {
  test('a command binding and its recorded selection must agree, and occur together', async () => {
    expect(await commits((tx) => seedCommandRun(tx, { event: false }))).toMatch(REFUSED);
    const run = await seeded((tx) => seedWorkingRun(tx));
    const payload = { commandId: 'command:triage', selectionRevision: DIGEST, arguments: '', snapshotDigest: DIGEST };
    expect(await commits((tx) => appendEvent(tx, run.runId, 'run.command', payload, 'command'))).toMatch(REFUSED);
    const bound = await commandRun();
    expect(
      await commits((tx) =>
        appendEvent(tx, bound.runId, 'run.command', { ...payload, snapshotDigest: bound.snapshotDigest }, 'command-2'),
      ),
    ).toMatch(REFUSED);
  });

  test('snapshots and bindings are immutable and never deleted', async () => {
    const run = await commandRun();
    for (const statement of [
      (tx: TransactionSQL) =>
        tx`update runtime.capability_snapshots set payload = payload where digest = ${run.snapshotDigest}`,
      (tx: TransactionSQL) => tx`delete from runtime.capability_snapshots where digest = ${run.snapshotDigest}`,
      (tx: TransactionSQL) => tx`update runtime.run_capabilities set max_delegations = 9 where run_id = ${run.runId}`,
      (tx: TransactionSQL) => tx`delete from runtime.run_capabilities where run_id = ${run.runId}`,
    ]) {
      expect(await commits(statement)).toMatch(REFUSED);
    }
  });

  test('refuses malformed command inputs and snapshot envelopes', async () => {
    const run = await seeded((tx) => seedWorkingRun(tx));
    const [sealed] = await db.admin`select digest from runtime.capability_snapshots limit 1`;
    for (const input of [
      {
        kind: 'command',
        commandId: 'command:triage',
        selectionRevision: DIGEST,
        arguments: '',
        provider: 'anthropic',
        goal: 'x',
      },
      { kind: 'goal', commandId: 'command:triage', selectionRevision: DIGEST, arguments: '', provider: 'anthropic' },
      { kind: 'command', commandId: 'skill:triage', selectionRevision: DIGEST, arguments: '', provider: 'anthropic' },
    ]) {
      expect(
        await commits(
          (tx) => tx`insert into runtime.run_capabilities (run_id, input, snapshot_digest, max_delegations)
            values (${run.runId}, ${j(input)}::text::jsonb, ${sealed.digest}, 8)`,
        ),
      ).toMatch(REFUSED);
    }
    for (const payload of [{ version: 2 }, { version: 1, profile: 1, secret: 'x' }]) {
      expect(
        await commits(
          (tx) =>
            tx`insert into runtime.capability_snapshots (digest, payload) values (${'f'.repeat(64)}, ${j(payload)}::text::jsonb)`,
        ),
      ).toMatch(REFUSED);
    }
  });
});

describe('loaded skills', () => {
  const load = (skillId = 'skill:review') => ({ kind: 'skill_load', skillId });
  const ok = { kind: 'completed', outcome: 'ok', result: { outcome: 'ok' } };

  test("membership comes from the same actor's successful load operation", async () => {
    const run = await commandRun();
    const insertSkill = (actorKey: string, operationId: string, skillId = 'skill:review') =>
      commits(
        (tx) => tx`insert into runtime.loaded_skills (run_id, actor_key, skill_id, operation_id, definition_digest)
          values (${run.runId}, ${actorKey}, ${skillId}, ${operationId}, ${DIGEST})`,
      );
    const loaded = await seeded((tx) =>
      insertOperation(tx, run.runId, { actorKey: 'root', callId: 'load-1', binding: load(), disposition: ok }),
    );
    const refused = await seeded((tx) =>
      insertOperation(tx, run.runId, {
        actorKey: 'root',
        callId: 'load-2',
        binding: load(),
        disposition: { kind: 'completed', outcome: 'refused', result: { outcome: 'refused' } },
      }),
    );
    const delegate = await seeded((tx) => startDelegate(tx, run, 'call-d'));
    expect(await insertSkill('root', refused)).toMatch(REFUSED);
    expect(await insertSkill(delegate, loaded)).toMatch(REFUSED);
    expect(await insertSkill('root', loaded, 'skill:other')).toMatch(REFUSED);
    expect(await insertSkill('root', loaded)).toBe('committed');
    expect(await insertSkill('root', loaded)).toMatch(REFUSED);
    expect(await commits((tx) => tx`delete from runtime.loaded_skills where run_id = ${run.runId}`)).toMatch(REFUSED);
  });
});

describe('versioned questions', () => {
  test('a pending delegated question is published only with its delegate waiting on it', async () => {
    expect(await commits(async (tx) => askFromDelegate(tx, await seedCommandRun(tx), { waiting: true }))).toBe(
      'committed',
    );
    expect(await commits(async (tx) => askFromDelegate(tx, await seedCommandRun(tx), { waiting: false }))).toMatch(
      REFUSED,
    );
  });

  test("a question's recorded asker must match its binding and its operation's actor", async () => {
    expect(
      await commits(async (tx) => {
        const run = await seedCommandRun(tx);
        const { questionId } = await askFromDelegate(tx, run, { waiting: true });
        await tx`update runtime.questions set actor_key = 'root' where run_id = ${run.runId} and question_id = ${questionId}`;
      }),
    ).toMatch(REFUSED);
    // A recorded phase-1 binding cannot be relabelled as version 2.
    expect(
      await commits(async (tx) => {
        const run = await seedWorkingRun(tx);
        const question = await pauseOnQuestion(tx, run);
        await tx`update runtime.questions set binding = binding || ${j({ version: 2, actor: 'root' })}::text::jsonb
          where run_id = ${run.runId} and question_id = ${question.questionId}`;
      }),
    ).toMatch(REFUSED);
  });

  test('a phase-1 question binding remains valid', async () => {
    expect(await commits(async (tx) => pauseOnQuestion(tx, await seedWorkingRun(tx)))).toBe('committed');
  });
});

describe('attributed history', () => {
  test('agent activity may name a delegate of the same run; owner and system events may not', async () => {
    const run = await commandRun();
    const delegationId = await seeded((tx) => startDelegate(tx, run, 'call-d'));
    const actor = { kind: 'delegate', delegationId, agentId: 'agent:helper' };
    expect(
      await commits((tx) => appendEvent(tx, run.runId, 'assistant.message', { messageId: 'm', text: 'x', actor }, 'm')),
    ).toBe('committed');
    expect(
      await commits((tx) =>
        appendEvent(
          tx,
          run.runId,
          'assistant.message',
          { messageId: 'n', text: 'x', actor: { ...actor, agentId: 'agent:other' } },
          'n',
        ),
      ),
    ).toMatch(REFUSED);
    expect(
      await commits((tx) =>
        appendEvent(
          tx,
          run.runId,
          'assistant.message',
          { messageId: 'o', text: 'x', actor: { ...actor, delegationId: 'f'.repeat(64) } },
          'o',
        ),
      ),
    ).toMatch(REFUSED);
    expect(
      await commits((tx) =>
        appendEvent(
          tx,
          run.runId,
          'cancellation.accepted',
          {
            cancellationId: crypto.randomUUID(),
            requestId: crypto.randomUUID(),
            acceptedAt: AT,
            actor: { kind: 'root' },
          },
          'cancellation',
        ),
      ),
    ).toMatch(REFUSED);
  });

  test('only a root assistant message can be the successful result', async () => {
    const finish = async (tx: TransactionSQL, run: SeededCommandRun, actor: unknown) => {
      const seq = await appendEvent(
        tx,
        run.runId,
        'assistant.message',
        { messageId: 'final', text: 'Done.', ...(actor === undefined ? {} : { actor }) },
        'message:final',
      );
      await tx`update runtime.invocations set disposition = 'settled', ended_at = now() where run_id = ${run.runId}`;
      await tx`update runtime.runs set state = ${j({ kind: 'succeeded', finishedAt: AT, resultSeq: String(seq) })}::text::jsonb,
        revision = revision + 1 where run_id = ${run.runId}`;
    };
    expect(
      await commits(async (tx) => {
        const run = await seedCommandRun(tx);
        const delegationId = await startDelegate(tx, run, 'call-d');
        await tx`update runtime.run_actors set state = ${j({ kind: 'completed', outcome: { kind: 'result', text: 'x' } })}::text::jsonb
          where run_id = ${run.runId} and actor_key = ${delegationId}`;
        await finish(tx, run, { kind: 'delegate', delegationId, agentId: 'agent:helper' });
      }),
    ).toMatch(REFUSED);
    expect(await commits(async (tx) => finish(tx, await seedCommandRun(tx), { kind: 'root' }))).toBe('committed');
    expect(await commits(async (tx) => finish(tx, await seedCommandRun(tx), undefined))).toBe('committed');
  });

  test('a finished run leaves no active or waiting delegate', async () => {
    expect(
      await commits(async (tx) => {
        const run = await seedCommandRun(tx);
        await startDelegate(tx, run, 'call-d');
        await tx`update runtime.invocations set disposition = 'interrupted', ended_at = now() where run_id = ${run.runId}`;
        await tx`update runtime.runs set state = ${j({ kind: 'interrupted', detectedAt: AT, lastActivityAt: AT, invocationId: run.invocationId })}::text::jsonb,
          revision = revision + 1 where run_id = ${run.runId}`;
      }),
    ).toMatch(REFUSED);
  });
});
