// Durable request admission for the guarded terminal (Decision 8). Under the run's short dispatch gate, ownership
// is re-verified, the run must still be working under this invocation, and one model step is reserved within
// budget; the request is then started while the gate is still held, so cancellation accepted under the same gate
// can never fall between the check and the dispatch. Every later state of the attempt is recorded durably.

import type { KeyedSerializer } from '../persistence/keyed-serializer.ts';
import type { OwnerFence } from '../persistence/ownership.ts';
import { type RunStore, RunStoreError } from '../records/run-store.ts';
import { AdmissionRefused, type AdmissionTicket, type RequestAdmission } from './terminal.ts';

export type AdmissionRefusal = 'cancelled' | 'not_dispatchable' | 'step_budget_exhausted' | 'ownership_lost';

export interface RunAdmissionOptions {
  store: Pick<RunStore, 'reserveAttempt' | 'settleAttempt'>;
  gates: KeyedSerializer;
  owner: Pick<OwnerFence, 'assertHeld' | 'verify'>;
  runId: string;
  invocationId: string;
  /** Observes every attempt's ID and the credential generation it used (for rejection attribution). */
  onAttempt?: (attempt: { attemptId: string; credentialGeneration: number }) => void;
}

export function runAdmission(options: RunAdmissionOptions): RequestAdmission {
  const { store, gates, owner, runId } = options;
  return {
    admit: (request, begin) =>
      gates.run(runId, async () => {
        if (request.signal.aborted) throw new AdmissionRefused('cancelled');
        try {
          owner.assertHeld();
          await owner.verify();
        } catch {
          throw new AdmissionRefused('ownership_lost');
        }
        let attemptId: string;
        try {
          ({ attemptId } = await store.reserveAttempt(runId, options.invocationId));
        } catch (error) {
          if (error instanceof RunStoreError) {
            if (error.code === 'budget_exhausted') throw new AdmissionRefused('step_budget_exhausted');
            if (error.code === 'not_dispatchable' || error.code === 'run_finished') {
              throw new AdmissionRefused('not_dispatchable');
            }
          }
          throw error;
        }
        options.onAttempt?.({ attemptId, credentialGeneration: request.credentialGeneration });
        const ticket: AdmissionTicket = {
          attemptId,
          dispatched: () => store.settleAttempt(runId, attemptId, { kind: 'dispatched' }),
          completed: (result) => store.settleAttempt(runId, attemptId, { kind: 'completed', ...result }),
          abandoned: (reason) => store.settleAttempt(runId, attemptId, { kind: 'abandoned', reason }),
          unconfirmed: () => store.settleAttempt(runId, attemptId, { kind: 'unconfirmed' }),
        };
        // Still inside the gate: the request starts (or, if cancelled meanwhile, is recorded abandoned by the
        // terminal) before cancellation can be accepted.
        begin();
        return ticket;
      }),
  };
}
