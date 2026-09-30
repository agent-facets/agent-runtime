// Credential lifecycle for one provider slot: current-credential resolution, refresh, definitive rejection and
// (re)authorization, coordinated so that exactly one refresh happens however many callers and processes race.
//
// Two layers of exclusion: an in-process single flight per slot, and the cross-process provider lock (lock.ts)
// shared with operator auth commands. The lock covers the whole interval that matters — reread the record, call
// the issuer, merge the partial result and durably replace the record — so a stale process can never overwrite a
// newer generation. Waiters that give up (their signal aborts) stop waiting; the shared operation, and the lock,
// continue until the issuer and the write have actually settled.
//
// Provider protocol is injected (CredentialIssuer). Issuer rotation and local persistence cannot be one
// transaction: if the process dies between them, the new tokens are lost and reauthorization may be required.
import type { Provider } from '../records/schemas.ts';
import { acquireProviderLock, CredentialLockError, DEFAULT_LOCK_WAIT_MS } from './lock.ts';
import {
  CREDENTIAL_RECORD_VERSION,
  type CredentialRecord,
  decodeCredentialRecord,
  type UsableCredential,
} from './record.ts';
import type { CredentialStore } from './store.ts';

export const REFRESH_MARGIN_MS = 5 * 60_000;
export const DEFAULT_ISSUER_DEADLINE_MS = 30_000;

/** Fields an issuer returns. An omitted refresh token or account keeps the stored value. */
export interface IssuedCredential {
  accessToken: string;
  refreshToken?: string;
  expiresAtMs: number;
  account?: Record<string, string>;
}

export type IssuerOutcome =
  | { kind: 'refreshed'; credential: IssuedCredential }
  /** The issuer definitively rejected the refresh grant. */
  | { kind: 'rejected'; reason: string }
  /** Nothing definitive was learned (network, 5xx, ambiguous response). */
  | { kind: 'unavailable' };

export interface CredentialIssuer {
  refresh(current: UsableCredential, signal: AbortSignal): Promise<IssuerOutcome>;
}

export type CredentialState =
  | { kind: 'ready'; credential: Readonly<UsableCredential> }
  | { kind: 'unconfigured' }
  | { kind: 'reauthorization_required' }
  | { kind: 'temporarily_unavailable' };

export interface CoordinatorOptions {
  store: CredentialStore;
  provider: Provider;
  slot: string;
  issuer: CredentialIssuer;
  now?: () => number;
  lockWaitMs?: number;
  issuerDeadlineMs?: number;
}

const inflight = new Map<string, Promise<CredentialState>>();

export class CredentialCoordinator {
  readonly #key: string;
  readonly #now: () => number;

  constructor(private readonly options: CoordinatorOptions) {
    this.#key = `${options.store.root}\u0000${options.provider}\u0000${options.slot}`;
    this.#now = options.now ?? Date.now;
  }

  /**
   * The credential to use for a request, refreshing it first when it is within five minutes of expiry. Every
   * value in the returned credential (token and account metadata) comes from one generation.
   */
  async current(signal?: AbortSignal): Promise<CredentialState> {
    const read = await this.options.store.read(this.options.provider, this.options.slot);
    const state = this.#stateOf(read.kind === 'record' ? read.record : read.kind);
    if (state.kind !== 'ready' || !this.#expiring(state.credential)) return state;
    return this.refresh({ observedGeneration: state.credential.generation, signal });
  }

  /**
   * Refreshes unless a newer usable generation than `observedGeneration` is already stored, in which case that
   * one is adopted. `observedGeneration` is the generation the caller last used (for example, the one an
   * inference request was rejected with); omit it to refresh whatever is current.
   */
  refresh(request: { observedGeneration?: number; signal?: AbortSignal } = {}): Promise<CredentialState> {
    let shared = inflight.get(this.#key);
    if (shared === undefined) {
      shared = this.#refreshUnderLock(request.observedGeneration).finally(() => inflight.delete(this.#key));
      inflight.set(this.#key, shared);
    }
    return abandonable(shared, request.signal);
  }

  /**
   * Records a definitive rejection of the generation a request used. A rejection of an older generation than
   * the stored one (for example, after the owner reauthorized) changes nothing.
   */
  async markRejected(observedGeneration: number, reason: string): Promise<CredentialState> {
    return this.#withLock(async (current) => {
      if (current === undefined || current.generation !== observedGeneration)
        return this.#stateOf(current ?? 'missing');
      return this.#write(this.#rejected(current.generation + 1, reason));
    }).catch(() => ({ kind: 'temporarily_unavailable' }) as const);
  }

  /**
   * Operator (re)authorization. The lock is held for the whole flow, including the owner's browser step, so no
   * refresh can interleave; runtime refreshes meanwhile report temporary unavailability after their lock wait.
   */
  async authorize(
    issue: (
      signal: AbortSignal,
    ) => Promise<{ accessToken: string; refreshToken: string; expiresAtMs: number; account: Record<string, string> }>,
    options: { lockWaitMs?: number; signal?: AbortSignal } = {},
  ): Promise<CredentialState> {
    const signal = options.signal ?? new AbortController().signal;
    return this.#withLock(
      async (current) => {
        const issued = await issue(signal);
        const generation = (current?.generation ?? 0) + 1;
        const record = this.#usable(generation, { ...issued });
        if (record === undefined) throw new Error('issued credential is invalid');
        return this.#write(record);
      },
      { waitMs: options.lockWaitMs, signal },
      true,
    );
  }

  async #refreshUnderLock(observedGeneration: number | undefined): Promise<CredentialState> {
    try {
      return await this.#withLock(async (current) => {
        if (current === undefined || current.lifecycle !== 'usable') return this.#stateOf(current ?? 'missing');
        const newer = observedGeneration !== undefined && current.generation > observedGeneration;
        if (newer && !this.#expiring(current)) return this.#stateOf(current);

        let outcome: IssuerOutcome;
        try {
          outcome = await this.options.issuer.refresh(
            Object.freeze(structuredClone(current)),
            AbortSignal.timeout(this.options.issuerDeadlineMs ?? DEFAULT_ISSUER_DEADLINE_MS),
          );
        } catch {
          outcome = { kind: 'unavailable' };
        }
        if (outcome.kind === 'unavailable') return { kind: 'temporarily_unavailable' };
        if (outcome.kind === 'rejected') return this.#write(this.#rejected(current.generation + 1, outcome.reason));

        // Partial rotation: an omitted refresh token or account keeps the stored value; a supplied one must be
        // valid, or nothing is written (the merge is validated as a whole record).
        const merged = this.#usable(current.generation + 1, {
          accessToken: outcome.credential.accessToken,
          refreshToken: outcome.credential.refreshToken ?? current.refreshToken,
          expiresAtMs: outcome.credential.expiresAtMs,
          account: outcome.credential.account ?? current.account,
        });
        if (merged === undefined) return { kind: 'temporarily_unavailable' };
        return this.#write(merged);
      });
    } catch {
      return { kind: 'temporarily_unavailable' };
    }
  }

  async #withLock<T>(
    body: (current: CredentialRecord | undefined) => Promise<T>,
    options: { waitMs?: number; signal?: AbortSignal } = {},
    rethrow = false,
  ): Promise<T> {
    const { store, provider, slot } = this.options;
    let lock: Awaited<ReturnType<typeof acquireProviderLock>>;
    try {
      lock = await acquireProviderLock(store, provider, {
        waitMs: options.waitMs ?? this.options.lockWaitMs ?? DEFAULT_LOCK_WAIT_MS,
        signal: options.signal,
      });
    } catch (error) {
      if (rethrow) throw error;
      throw error instanceof CredentialLockError ? error : new CredentialLockError('lock_unavailable', 'lock failed');
    }
    try {
      await store.removeAbandonedTemps(provider, slot);
      const read = await store.read(provider, slot);
      if (read.kind === 'unsafe') throw new CredentialLockError('unsafe_storage', 'credential storage is not private');
      return await body(read.kind === 'record' ? read.record : undefined);
    } finally {
      await lock.release();
    }
  }

  async #write(record: CredentialRecord): Promise<CredentialState> {
    await this.options.store.replace(record);
    return this.#stateOf(record);
  }

  #usable(
    generation: number,
    fields: { accessToken: string; refreshToken: string; expiresAtMs: number; account: Record<string, string> },
  ): UsableCredential | undefined {
    const { provider, slot } = this.options;
    const candidate = {
      version: CREDENTIAL_RECORD_VERSION,
      provider,
      authMode: 'subscription',
      slot,
      generation,
      updatedAtMs: this.#now(),
      lifecycle: 'usable',
      accessToken: fields.accessToken,
      refreshToken: fields.refreshToken,
      expiresAtMs: fields.expiresAtMs,
      account: fields.account,
    };
    return decodeCredentialRecord(candidate, provider, slot) as UsableCredential | undefined;
  }

  #rejected(generation: number, reason: string): CredentialRecord {
    const { provider, slot } = this.options;
    const record = decodeCredentialRecord(
      {
        version: CREDENTIAL_RECORD_VERSION,
        provider,
        authMode: 'subscription',
        slot,
        generation,
        updatedAtMs: this.#now(),
        lifecycle: 'reauthorization_required',
        reason: /^[a-z][a-z0-9_]{0,63}$/.test(reason) ? reason : 'rejected',
      },
      provider,
      slot,
    );
    if (record === undefined) throw new Error('invalid rejection record');
    return record;
  }

  #expiring(credential: UsableCredential): boolean {
    return credential.expiresAtMs - this.#now() <= REFRESH_MARGIN_MS;
  }

  #stateOf(record: CredentialRecord | 'missing' | 'invalid' | 'unsafe'): CredentialState {
    if (record === 'missing') return { kind: 'unconfigured' };
    // A corrupt record needs the owner to authorize again; unsafe storage is not repaired automatically.
    if (record === 'invalid') return { kind: 'reauthorization_required' };
    if (record === 'unsafe') return { kind: 'temporarily_unavailable' };
    if (record.lifecycle === 'reauthorization_required') return { kind: 'reauthorization_required' };
    return { kind: 'ready', credential: Object.freeze(structuredClone(record)) };
  }
}

/** Waits for a shared operation, or stops waiting when the caller's signal aborts; the operation continues. */
function abandonable(shared: Promise<CredentialState>, signal: AbortSignal | undefined): Promise<CredentialState> {
  if (signal === undefined) return shared;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    shared.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}
