// Cancellation (Decision 8). Acceptance is durable and serialized with admissions under the run's short dispatch
// gate, so once it commits no further model request or tool call is admitted. The running invocation's service
// signal is then aborted, and the run stays `cancelling` until the invocation and all tracked local work — request
// bodies, tool calls, checkpoint writes — have actually settled; only then is it recorded `cancelled`. Late output
// cannot replace the outcome: every success, failure or publication path requires a state that cancellation has
// already left.
import type { KeyedSerializer } from '../persistence/keyed-serializer.ts';
import type { CancellationResult, RunStore } from '../records/run-store.ts';
import type { RunState } from '../records/schemas.ts';
import type { InFlight } from './in-flight.ts';
import type { RunningInvocation } from './invocation.ts';

export const CANCELLED = Object.freeze(new Error('The run was cancelled.'));

/** The invocations this process is running, with their tracked local work. */
export class ActiveInvocations {
  readonly #runs = new Map<string, { invocation: RunningInvocation; inflight: InFlight }>();

  register(runId: string, invocation: RunningInvocation, inflight: InFlight): void {
    this.#runs.set(runId, { invocation, inflight });
    void invocation.settled
      .then(() => inflight.settled())
      .finally(() => {
        if (this.#runs.get(runId)?.invocation === invocation) this.#runs.delete(runId);
      });
  }

  get(runId: string) {
    return this.#runs.get(runId);
  }
}

export interface CancellationDeps {
  store: Pick<RunStore, 'acceptCancellation' | 'finishCancellation'>;
  gates: KeyedSerializer;
  active: ActiveInvocations;
}

/**
 * Accepts cancellation and starts stopping the run. `result` is available once acceptance is durable; `settled`
 * resolves with the run's recorded state once local work has stopped and the outcome is recorded.
 */
export async function cancelRun(
  deps: CancellationDeps,
  runId: string,
  requestId: string,
): Promise<{ result: CancellationResult; settled: Promise<RunState> }> {
  const result = await deps.gates.run(runId, () => deps.store.acceptCancellation(runId, requestId));
  const accepted = result.kind === 'accepted' || result.kind === 'repeated';
  if (!accepted || result.state.kind !== 'cancelling') return { result, settled: Promise.resolve(result.state) };
  const running = deps.active.get(runId);
  running?.invocation.cancel(CANCELLED);
  const settled = (async () => {
    if (running !== undefined) {
      await running.invocation.settled;
      await running.inflight.settled();
    }
    return deps.store.finishCancellation(runId);
  })();
  return { result, settled };
}
