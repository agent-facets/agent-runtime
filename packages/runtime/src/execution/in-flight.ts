// Local work that must settle before a run's outcome is recorded (Decision 8). A rejected graph promise does not
// prove that a request body, a tool read or a checkpoint write has stopped, so each of those registers itself here
// and cancellation waits for all of them — including work registered while it waits.
import type { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint';

export class InFlight {
  readonly #pending = new Set<Promise<void>>();

  /** Registers work; returns it unchanged. */
  track<T>(work: Promise<T>): Promise<T> {
    const settled = work.then(
      () => {},
      () => {},
    );
    this.#pending.add(settled);
    void settled.then(() => this.#pending.delete(settled));
    return work;
  }

  get size(): number {
    return this.#pending.size;
  }

  /** Resolves once nothing registered is still running. */
  async settled(): Promise<void> {
    while (this.#pending.size > 0) await Promise.all([...this.#pending]);
  }
}

/** A saver whose checkpoint and pending-write persistence is tracked; reads pass through unchanged. */
export function trackedSaver<S extends BaseCheckpointSaver>(saver: S, inflight: InFlight): S {
  return new Proxy(saver, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== 'function') return value;
      if (property === 'put' || property === 'putWrites') {
        return (...args: unknown[]) => inflight.track(value.apply(target, args));
      }
      return value.bind(target);
    },
  });
}
