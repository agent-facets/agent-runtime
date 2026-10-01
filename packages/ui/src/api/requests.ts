// Request identities for commands whose outcome can be unknown. A start or cancellation keeps the same request ID
// until the server has given a definite answer, so retrying after a lost response can never start a second run or
// record a second cancellation: the server recognizes the ID and returns what it already recorded. Changing what
// is being submitted (a different goal or provider) is a new request with a new ID.
import type { ApiOutcome } from './client.ts';

export type Settlement = 'definite' | 'unknown';

/** Whether an outcome settles the request (a new submission needs a new ID) or leaves it to be retried as is. */
export function settlementOf(outcome: ApiOutcome<unknown>): Settlement {
  if (outcome.ok) return 'definite';
  if (outcome.kind !== 'refused') return 'unknown';
  return outcome.error.acceptance === 'unknown' ? 'unknown' : 'definite';
}

export class RequestIdentity<Content> {
  #content: string | undefined;
  #id: string | undefined;

  constructor(private readonly newId: () => string = () => crypto.randomUUID()) {}

  /** The ID to submit `content` with: the pending one if this is a retry of the same content, else a new one. */
  idFor(content: Content): string {
    const key = JSON.stringify(content);
    if (this.#id === undefined || this.#content !== key) {
      this.#id = this.newId();
      this.#content = key;
    }
    return this.#id;
  }

  /** Records the outcome of submitting with the current ID; a definite outcome retires it. */
  settle(outcome: ApiOutcome<unknown>): Settlement {
    const settlement = settlementOf(outcome);
    if (settlement === 'definite') {
      this.#id = undefined;
      this.#content = undefined;
    }
    return settlement;
  }

  get pending(): boolean {
    return this.#id !== undefined;
  }
}
