// The credential screen the execution layer uses: an opaque exact matcher over every credential generation that a
// response may still contain. Consumers receive matchers, never the values.
//
// A request leases its generation when the credential is resolved, before the request is admitted or sent. The
// lease is released only once that request's response has been sanitized or safely discarded — the end of the model
// call — not when its HTTP exchange ends, so a slow or late response is still checked against the credential it
// was sent with, however many rotations happened meanwhile. A leased generation is never evicted. Released
// generations stay screened (a rotated-away token is still a credential) until room is needed.
//
// The screen is bounded. When every retained generation is leased, a new generation is refused, so the request that
// needed it is not sent: screening fails closed rather than quietly losing coverage.
import { type ExactSecretMatcher, exactSecretMatcher } from './matcher.ts';
import type { UsableCredential } from './record.ts';

export const SCREEN_CAPACITY = 64;

type ScreenedCredential = Pick<UsableCredential, 'provider' | 'slot' | 'generation' | 'accessToken' | 'refreshToken'>;

export class ScreenCapacityError extends Error {
  override readonly name = 'ScreenCapacityError';
  /** Safe reason code, surfaced by the terminal as its refusal reason. */
  readonly reason = 'credential_screen_full';
  constructor() {
    super('too many credential generations are in use to screen another');
  }
}

export interface ScreenLease {
  /** Ends this lease; calling it again changes nothing. */
  release(): void;
}

export class CredentialScreen {
  /** In recency order: the first entry is the least recently leased. */
  readonly #entries = new Map<string, { tokens: readonly string[]; leases: number }>();
  #matcher: ExactSecretMatcher = exactSecretMatcher([]);

  readonly #capacity: number;

  constructor(capacity = SCREEN_CAPACITY) {
    this.#capacity = capacity;
  }

  /** Screens a generation and keeps it screened until released. Throws ScreenCapacityError when full. */
  lease(credential: ScreenedCredential): ScreenLease {
    const key = `${credential.provider}\u0000${credential.slot}\u0000${credential.generation}`;
    let entry = this.#entries.get(key);
    const added = entry === undefined;
    if (entry === undefined) {
      if (this.#entries.size >= this.#capacity) {
        const idle = [...this.#entries].find(([, candidate]) => candidate.leases === 0);
        if (idle === undefined) throw new ScreenCapacityError();
        this.#entries.delete(idle[0]);
      }
      entry = { tokens: [credential.accessToken, credential.refreshToken], leases: 0 };
    } else {
      // Re-inserted below as the most recently leased.
      this.#entries.delete(key);
    }
    this.#entries.set(key, entry);
    if (added) this.#matcher = exactSecretMatcher([...this.#entries.values()].flatMap((retained) => retained.tokens));
    entry.leases++;
    const held = entry;
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        held.leases--;
      },
    };
  }

  /** A matcher over every retained generation, current at the time of the call. */
  matcher(): ExactSecretMatcher {
    return this.#matcher;
  }
}

/**
 * The leases of one run's model call in progress (a run makes one model call at a time; a renewal retry adds a
 * second generation to the same call). The terminal pins each credential it resolves; the model boundary releases
 * them once the call's response has been sanitized or discarded.
 */
export class ScreenScope {
  readonly #leases: ScreenLease[] = [];

  constructor(private readonly screen: CredentialScreen) {}

  pin(credential: ScreenedCredential): void {
    this.#leases.push(this.screen.lease(credential));
  }

  release(): void {
    for (const lease of this.#leases.splice(0)) lease.release();
  }
}
