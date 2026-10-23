// The credential screen the execution layer uses: an opaque exact matcher that follows credential rotation.
//
// A credential generation is observed when it is resolved for a request, before that request is sent, so the
// screen already knows it when the response is sanitized. Earlier generations stay in the screen — a response to a
// request made with them may still be in flight, and a rotated-away token is still a credential — up to a bound of
// the most recent generations. Consumers receive matchers, never the values.
import { type ExactSecretMatcher, exactSecretMatcher } from './matcher.ts';
import type { UsableCredential } from './record.ts';

export const RETAINED_GENERATIONS = 16;

export class CredentialScreen {
  readonly #generations = new Map<string, readonly string[]>();
  #matcher: ExactSecretMatcher = exactSecretMatcher([]);

  readonly #retained: number;

  constructor(retained = RETAINED_GENERATIONS) {
    this.#retained = retained;
  }

  /** Adds a usable credential generation's token values. Observing the same generation again changes nothing. */
  observe(credential: Pick<UsableCredential, 'provider' | 'slot' | 'generation' | 'accessToken' | 'refreshToken'>) {
    const key = `${credential.provider}\u0000${credential.slot}\u0000${credential.generation}`;
    if (this.#generations.has(key)) return;
    this.#generations.set(key, [credential.accessToken, credential.refreshToken]);
    while (this.#generations.size > this.#retained) {
      const oldest = this.#generations.keys().next().value as string;
      this.#generations.delete(oldest);
    }
    this.#matcher = exactSecretMatcher([...this.#generations.values()].flat());
  }

  /** A matcher over every retained generation, current at the time of the call. */
  matcher(): ExactSecretMatcher {
    return this.#matcher;
  }
}
