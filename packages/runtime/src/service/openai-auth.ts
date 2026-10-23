// Connecting OpenAI from the console (design Decision 16, extended to OpenAI's device login). Beginning an attempt
// asks OpenAI for a short code; the console shows it with a link to OpenAI's page, where the owner signs in and
// enters it. Meanwhile this service polls OpenAI in the background and, once the owner approves, exchanges the
// approval and stores the authorization. Nothing is pasted back into the console.
//
// Attempts live only in this process: a restart discards unfinished ones (saved credentials are untouched).
// Polling holds no credential lock; only the exchange and the durable replacement do, shared as always with
// refresh and the terminal `auth` command. An approval is exchanged at most once.
import type { AuthAttempt, AuthAttemptState, AuthFailureReason } from '@agent-runtime/contracts';
import type { CredentialCoordinator } from '../credentials/coordinator.ts';
import { CredentialLockError } from '../credentials/lock.ts';
import type { OpenAIAuthFailureReason, Transport } from '../providers/openai/auth.ts';
import { beginOpenAILogin, completeOpenAILogin, OpenAILoginFailed } from '../providers/openai/credentials.ts';
import { formatDiagnostic } from '../security/diagnostics.ts';
import { ATTEMPT_LIFETIME_MS, type LoginOutcome, MAX_RETAINED_ATTEMPTS } from './auth.ts';

export const OPENAI_FAILURE_MESSAGES: Record<AuthFailureReason, string> = {
  code_mismatch: 'That code does not belong to this sign-in. Start a new login.',
  rejected: 'OpenAI refused the authorization. Start a new login.',
  denied: 'The sign-in was refused or abandoned on OpenAI’s page. Start a new login.',
  throttled: 'OpenAI is limiting authorization requests. Wait a little, then start a new login.',
  not_sent: 'OpenAI’s authorization service could not be reached. Check the connection, then start a new login.',
  outcome_unknown: 'The login did not complete and its result is unknown. Start a new login.',
  busy: 'Another login or renewal for OpenAI was in progress. Start a new login.',
  not_stored: 'The authorization could not be stored. Nothing was changed. Start a new login.',
  stopped: 'The runtime stopped before the login finished. Check the connection status, then start a new login.',
};

const FAILURES: Record<Exclude<OpenAIAuthFailureReason, 'expired' | 'aborted'>, AuthFailureReason> = {
  not_sent: 'not_sent',
  throttled: 'throttled',
  rejected: 'rejected',
  denied: 'denied',
  invalid_response: 'outcome_unknown',
  outcome_unknown: 'outcome_unknown',
};

interface Attempt {
  readonly id: string;
  state: AuthAttemptState;
  expiresAtMs: number;
  settledAtMs?: number;
  /** Present while the owner can still act on them. */
  userCode?: string;
  verificationUrl?: string;
  failure?: AuthFailureReason;
  /** Stops this attempt's polling (cancel) — not an exchange already under way. */
  readonly polling: AbortController;
}

export interface OpenAILoginOptions {
  /** The configured credential slot, or undefined when OpenAI is not configured. */
  slot: string | undefined;
  coordinator: (slot: string) => CredentialCoordinator;
  transport: Transport;
  now?: () => number;
  log?: (line: string) => void;
  /** Test seam: the wait between polls. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

export class OpenAILogin {
  readonly #attempts = new Map<string, Attempt>();
  readonly #work = new Set<Promise<void>>();
  readonly #stopping = new AbortController();
  readonly #now: () => number;
  readonly #log: (line: string) => void;
  /** The attempt being started, so concurrent begins share it rather than each asking OpenAI for a code. */
  #starting: Promise<LoginOutcome> | undefined;

  constructor(private readonly options: OpenAILoginOptions) {
    this.#now = options.now ?? Date.now;
    this.#log = options.log ?? (() => {});
  }

  /** Starts a login, or returns the one already in progress (a reload must not strand it or start another). */
  async start(): Promise<LoginOutcome> {
    if (this.options.slot === undefined) return { kind: 'unconfigured' };
    this.#prune();
    for (const attempt of this.#attempts.values()) {
      if (attempt.state === 'awaiting_approval' || attempt.state === 'completing') return this.#outcome(attempt);
    }
    this.#starting ??= this.#begin().finally(() => {
      this.#starting = undefined;
    });
    return this.#starting;
  }

  status(attemptId: string): LoginOutcome {
    this.#prune();
    const attempt = this.#attempts.get(attemptId);
    return attempt === undefined ? { kind: 'not_found' } : this.#outcome(attempt);
  }

  /** Stops waiting for the owner's approval. Once approved, the exchange is reported as it goes. */
  cancel(attemptId: string): LoginOutcome {
    this.#prune();
    const attempt = this.#attempts.get(attemptId);
    if (attempt === undefined) return { kind: 'not_found' };
    if (attempt.state === 'awaiting_approval') {
      this.#settle(attempt, 'cancelled');
      attempt.polling.abort(new Error('cancelled'));
    }
    return this.#outcome(attempt);
  }

  /** Aborts unfinished logins and waits for them (and any credential lock) to settle. */
  async stop(): Promise<void> {
    this.#stopping.abort(new Error('the runtime is stopping'));
    while (this.#work.size > 0) await Promise.allSettled([...this.#work]);
  }

  async #begin(): Promise<LoginOutcome> {
    const slot = this.options.slot as string;
    const attempt: Attempt = {
      id: crypto.randomUUID(),
      state: 'awaiting_approval',
      expiresAtMs: this.#now(),
      polling: new AbortController(),
    };
    const signal = AbortSignal.any([this.#stopping.signal, attempt.polling.signal]);
    let session: Awaited<ReturnType<typeof beginOpenAILogin>>;
    try {
      session = await beginOpenAILogin({ transport: this.options.transport, signal, now: this.#now });
    } catch (error) {
      this.#attempts.set(attempt.id, attempt);
      this.#fail(attempt, error);
      return this.#outcome(attempt);
    }
    attempt.expiresAtMs = session.expiresAtMs;
    attempt.userCode = session.userCode;
    attempt.verificationUrl = session.verificationUrl;
    this.#attempts.set(attempt.id, attempt);
    this.#prune();

    const work = completeOpenAILogin({
      coordinator: this.options.coordinator(slot),
      transport: this.options.transport,
      session,
      signal,
      now: this.#now,
      ...(this.options.sleep === undefined ? {} : { sleep: this.options.sleep }),
      onApproved: () => {
        if (attempt.state !== 'awaiting_approval') return;
        attempt.state = 'completing';
        attempt.userCode = undefined;
        attempt.verificationUrl = undefined;
      },
    }).then(
      (state) => {
        if (state.kind === 'ready') this.#settle(attempt, 'connected');
        else this.#fail(attempt, undefined);
      },
      (error) => this.#fail(attempt, error),
    );
    this.#work.add(work);
    void work.finally(() => this.#work.delete(work));
    return this.#outcome(attempt);
  }

  #fail(attempt: Attempt, error: unknown): void {
    if (attempt.settledAtMs !== undefined) return;
    let reason: AuthFailureReason;
    if (error instanceof OpenAILoginFailed) {
      const failed = error.reason;
      if (failed === 'expired') {
        this.#settle(attempt, 'expired');
        return;
      }
      reason = failed === 'aborted' ? 'stopped' : FAILURES[failed];
    } else if (error instanceof CredentialLockError) {
      reason = error.code === 'lock_busy' ? 'busy' : error.code === 'lock_aborted' ? 'stopped' : 'not_stored';
    } else reason = 'not_stored';
    this.#settle(attempt, 'failed', reason);
  }

  #settle(attempt: Attempt, state: AuthAttemptState, failure?: AuthFailureReason): void {
    if (attempt.settledAtMs !== undefined) return;
    attempt.state = state;
    attempt.settledAtMs = this.#now();
    attempt.userCode = undefined;
    attempt.verificationUrl = undefined;
    if (failure !== undefined) attempt.failure = failure;
    if (state === 'connected' || state === 'failed') {
      this.#log(
        formatDiagnostic({
          event: state === 'connected' ? 'provider_login_connected' : 'provider_login_failed',
          provider: 'openai',
          ...(failure === undefined ? {} : { reason: failure }),
        }),
      );
    }
  }

  /** Forgets old finished attempts and keeps the retained set bounded. Expiry is the poller's to report. */
  #prune(): void {
    const now = this.#now();
    for (const [id, attempt] of this.#attempts) {
      if (attempt.settledAtMs !== undefined && now >= attempt.settledAtMs + ATTEMPT_LIFETIME_MS) {
        this.#attempts.delete(id);
      }
    }
    for (const [id, attempt] of this.#attempts) {
      if (this.#attempts.size <= MAX_RETAINED_ATTEMPTS) break;
      if (attempt.settledAtMs !== undefined) this.#attempts.delete(id);
    }
  }

  #outcome(attempt: Attempt): LoginOutcome {
    return { kind: 'attempt', attempt: this.#view(attempt), settled: attempt.settledAtMs !== undefined };
  }

  #view(attempt: Attempt): AuthAttempt {
    return {
      attemptId: attempt.id,
      provider: 'openai',
      state: attempt.state,
      expiresAt: new Date(attempt.expiresAtMs).toISOString(),
      ...(attempt.state === 'awaiting_approval' && attempt.verificationUrl !== undefined
        ? { authorizationUrl: attempt.verificationUrl }
        : {}),
      ...(attempt.state === 'awaiting_approval' && attempt.userCode !== undefined
        ? { userCode: attempt.userCode }
        : {}),
      ...(attempt.failure === undefined
        ? {}
        : { failure: { reason: attempt.failure, message: OPENAI_FAILURE_MESSAGES[attempt.failure] } }),
    };
  }
}
