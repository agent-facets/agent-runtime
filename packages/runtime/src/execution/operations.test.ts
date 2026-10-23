import { describe, expect, test } from 'bun:test';
import { KeyedSerializer } from '../persistence/keyed-serializer.ts';
import { RunStoreError } from '../records/run-store.ts';
import { AdmissionUnknown, identityFor, OutcomeUnconfirmed, runOperationLedger } from './operations.ts';

const RUN = '00000000-0000-4000-8000-000000000001';
const identity = identityFor(
  RUN,
  'msg_1',
  { id: 'call_1', name: 'mcp_repo_list_items', args: { repository: 'owner/a' } },
  {
    actor: { kind: 'root' },
    binding: { kind: 'mcp', serverId: 'repo', toolName: 'list_items', definitionDigest: 'd'.repeat(64) },
  },
);
if (identity === undefined) throw new Error('unrepresentable');
const OK = { outcome: 'ok', result: { text: 'two' } } as const;

/** Stands for a commit whose outcome the database connection could not report. */
const AMBIGUOUS = new Error('connection lost during commit');

/** A store double: each step either commits, fails ambiguously or fails outright; readback reports the stored row. */
function store(options: {
  admit?: 'admitted' | 'unresolved' | 'not_dispatchable' | typeof AMBIGUOUS;
  complete?: 'ok' | typeof AMBIGUOUS | Error;
  stored?: unknown;
  readbackFails?: boolean;
}) {
  const log: string[] = [];
  return {
    log,
    startToolOperation: async () => ({ kind: 'execute' as const }),
    async admitExternalCall() {
      log.push('admit');
      if (options.admit === AMBIGUOUS) throw AMBIGUOUS;
      return options.admit ?? 'admitted';
    },
    async completeToolOperation() {
      log.push('complete');
      if (options.complete instanceof Error) throw options.complete;
    },
    async readToolDisposition() {
      log.push('readback');
      return options.stored as never;
    },
    async withCommitCertainty<T>(operation: () => Promise<T>, readback: () => Promise<T | undefined>) {
      try {
        return { committed: true as const, value: await operation() };
      } catch (error) {
        if (error !== AMBIGUOUS) throw error;
        if (options.readbackFails) throw new RunStoreError('acceptance_unknown', 'unknown');
        const found = await readback();
        return found === undefined ? { committed: false as const } : { committed: true as const, value: found };
      }
    },
  };
}

const ledgerOf = (fake: ReturnType<typeof store>) =>
  runOperationLedger({ store: fake as never, gates: new KeyedSerializer(), runId: RUN, invocationId: 'i' });

describe('external admission', () => {
  test('only a call whose own intent committed sends, and it sends inside the run gate', async () => {
    const gates = new KeyedSerializer();
    const fake = store({});
    const admit = fake.admitExternalCall;
    let competing: Promise<unknown> | undefined;
    fake.admitExternalCall = async () => {
      // Cancellation acceptance arrives while the intent is being recorded: it must wait for the send.
      competing = gates.run(RUN, async () => {
        fake.log.push('cancel');
      });
      return admit();
    };
    const ledger = runOperationLedger({ store: fake as never, gates, runId: RUN, invocationId: 'i' });
    expect(await ledger.admitExternal?.(identity, () => fake.log.push('send'))).toBe('admitted');
    await competing;
    expect(fake.log).toEqual(['admit', 'send', 'cancel']);
    for (const decided of ['unresolved', 'not_dispatchable'] as const) {
      let sent = false;
      expect(await ledgerOf(store({ admit: decided })).admitExternal?.(identity, () => (sent = true))).toBe(decided);
      expect(sent).toBe(false);
    }
  });

  test('an ambiguous intent commit never sends: a recorded intent is unresolved, an absent one not recorded', async () => {
    let sent = false;
    const send = () => {
      sent = true;
    };
    expect(
      await ledgerOf(store({ admit: AMBIGUOUS, stored: { kind: 'dispatching' } })).admitExternal?.(identity, send),
    ).toBe('unresolved');
    expect(await ledgerOf(store({ admit: AMBIGUOUS, stored: undefined })).admitExternal?.(identity, send)).toBe(
      'not_recorded',
    );
    expect(sent).toBe(false);
    const unknown = ledgerOf(store({ admit: AMBIGUOUS, readbackFails: true })).admitExternal?.(identity, send);
    await expect(unknown).rejects.toBeInstanceOf(AdmissionUnknown);
    expect(sent).toBe(false);
  });

  test('a send that fails after the intent committed is unresolved, not a refusal', async () => {
    const admission = await ledgerOf(store({})).admitExternal?.(identity, () => {
      throw new Error('transport closed');
    });
    expect(admission).toBe('unresolved');
  });
});

describe('external completion', () => {
  test('an outcome counts only once it is known to be stored exactly', async () => {
    await ledgerOf(store({ complete: 'ok' })).completeExternal?.(identity, OK);
    // Ambiguous, but the exact outcome reads back: recorded.
    await ledgerOf(
      store({ complete: AMBIGUOUS, stored: { kind: 'completed', outcome: 'ok', result: OK } }),
    ).completeExternal?.(identity, OK);
    // Ambiguous with nothing, or something else, recorded; a readback that fails; an outright failure: unknown.
    for (const fake of [
      store({ complete: AMBIGUOUS, stored: { kind: 'dispatching' } }),
      store({ complete: AMBIGUOUS, stored: { kind: 'completed', outcome: 'ok', result: { outcome: 'ok' } } }),
      store({ complete: AMBIGUOUS, readbackFails: true }),
      store({ complete: new Error('constraint') }),
    ]) {
      await expect(ledgerOf(fake).completeExternal?.(identity, OK) as Promise<void>).rejects.toBeInstanceOf(
        OutcomeUnconfirmed,
      );
    }
  });
});
