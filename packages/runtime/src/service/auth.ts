// Connecting Anthropic from the console (design Decision 16). An attempt is begun in the browser, the owner opens
// the provider's authorization page in another tab, and pastes the code that page shows into the console.
//
// Attempts live only in this process: a restart discards unfinished ones (saved credentials are untouched). The
// login's private state (PKCE verifier, OAuth state) never leaves the server, and the pasted code is held only for
// the one exchange it is used in. An attempt is exchanged at most once: after its code has been claimed, a
// repeated completion reports what happened instead of trying again, because a code whose exchange outcome is
// unknown may already have been used.
//
// Waiting for the owner holds no credential lock. The existing operator login (loginAnthropic) runs only once the
// code has arrived, so its lock covers just the reread, the exchange and the durable replacement — shared, as
// always, with refresh and the terminal `auth` command.
import {
  beginLogin,
  type AuthFailureReason as ExchangeFailure,
  type LoginFlow,
  type Transport,
} from '@agent-runtime/anthropic-subscription';
import type { AuthAttempt, AuthAttemptState, AuthFailureReason } from '@agent-runtime/contracts';
import type { CredentialCoordinator } from '../credentials/coordinator.ts';
import { CredentialLockError } from '../credentials/lock.ts';
import { LoginFailed, loginAnthropic } from '../providers/anthropic/credentials.ts';
import { formatDiagnostic } from '../security/diagnostics.ts';

/** How long an attempt waits for its code, and how long a finished attempt can still be looked up. */
export const ATTEMPT_LIFETIME_MS = 10 * 60_000;
export const MAX_RETAINED_ATTEMPTS = 32;
/** How long a completion request waits for the exchange before replying that it is still completing. */
export const COMPLETION_REPLY_WAIT_MS = 20_000;

export const FAILURE_MESSAGES: Record<AuthFailureReason, string> = {
  code_mismatch:
    'That is not the code from this sign-in. Copy the whole code Anthropic shows after you authorize, then paste it.',
  rejected: 'Anthropic refused the code. It may have expired or already been used. Start a new login.',
  denied: 'The sign-in was refused. Start a new login.',
  throttled: 'Anthropic is limiting authorization requests. Wait a little, then start a new login.',
  not_sent: 'Anthropic’s authorization service could not be reached. Check the connection, then start a new login.',
  outcome_unknown:
    'The login did not complete and its result is unknown; the code may have been used. Start a new login.',
  busy: 'Another login or renewal for Anthropic was in progress. Start a new login.',
  not_stored: 'The authorization could not be stored. Nothing was changed. Start a new login.',
  stopped: 'The runtime stopped before the login finished. Check the connection status, then start a new login.',
};

const EXCHANGE_FAILURES: Record<ExchangeFailure, AuthFailureReason> = {
  state_mismatch: 'code_mismatch',
  invalid_input: 'code_mismatch',
  rejected: 'rejected',
  throttled: 'throttled',
  not_sent: 'not_sent',
  outcome_unknown: 'outcome_unknown',
  aborted: 'stopped',
};

interface Attempt {
  readonly id: string;
  state: AuthAttemptState;
  readonly expiresAtMs: number;
  settledAtMs?: number;
  /** Present until the attempt settles. */
  flow?: LoginFlow;
  failure?: AuthFailureReason;
}

export type LoginOutcome =
  | { kind: 'attempt'; attempt: AuthAttempt; settled: boolean }
  /** Anthropic is not configured for this runtime. */
  | { kind: 'unconfigured' }
  | { kind: 'not_found' }
  /** The pasted text does not belong to this attempt; nothing was sent and the attempt still waits. */
  | { kind: 'code_mismatch'; attempt: AuthAttempt };

export interface AnthropicLoginOptions {
  /** The configured credential slot, or undefined when Anthropic is not configured. */
  slot: string | undefined;
  coordinator: (slot: string) => CredentialCoordinator;
  transport: Transport;
  now?: () => number;
  log?: (line: string) => void;
  /** Test seam: how long a completion request waits before replying. */
  replyWaitMs?: number;
}

export class AnthropicLogin {
  readonly #attempts = new Map<string, Attempt>();
  readonly #completions = new Set<Promise<void>>();
  readonly #stopping = new AbortController();
  readonly #now: () => number;
  readonly #log: (line: string) => void;

  constructor(private readonly options: AnthropicLoginOptions) {
    this.#now = options.now ?? Date.now;
    this.#log = options.log ?? (() => {});
  }

  /** Starts a login, or returns the one already waiting or completing (a reload must not strand it). */
  async start(): Promise<LoginOutcome> {
    if (this.options.slot === undefined) return { kind: 'unconfigured' };
    this.#prune();
    for (const attempt of this.#attempts.values()) {
      if (attempt.state === 'awaiting_code' || attempt.state === 'completing') return this.#outcome(attempt);
    }
    const attempt: Attempt = {
      id: crypto.randomUUID(),
      state: 'awaiting_code',
      expiresAtMs: this.#now() + ATTEMPT_LIFETIME_MS,
      flow: await beginLogin(),
    };
    this.#attempts.set(attempt.id, attempt);
    this.#prune();
    return this.#outcome(attempt);
  }

  status(attemptId: string): LoginOutcome {
    this.#prune();
    const attempt = this.#attempts.get(attemptId);
    return attempt === undefined ? { kind: 'not_found' } : this.#outcome(attempt);
  }

  /** Closes an attempt that is still waiting for its code; anything later is reported as it is. */
  cancel(attemptId: string): LoginOutcome {
    this.#prune();
    const attempt = this.#attempts.get(attemptId);
    if (attempt === undefined) return { kind: 'not_found' };
    if (attempt.state === 'awaiting_code') this.#settle(attempt, 'cancelled');
    return this.#outcome(attempt);
  }

  /**
   * Exchanges the pasted code once. Only an attempt waiting for its code is claimed; any other state is reported
   * unchanged. The exchange belongs to this service, not to the request: a closed browser does not stop it, and
   * the reply says `completing` if it has not finished within the reply wait.
   */
  async complete(attemptId: string, code: string): Promise<LoginOutcome> {
    this.#prune();
    const attempt = this.#attempts.get(attemptId);
    if (attempt === undefined) return { kind: 'not_found' };
    const flow = attempt.flow;
    if (attempt.state !== 'awaiting_code' || flow === undefined) return this.#outcome(attempt);
    // A paste from another sign-in (or a partial copy) is refused before anything is used up.
    if (!code.includes(flow.state)) return { kind: 'code_mismatch', attempt: this.#view(attempt) };

    attempt.state = 'completing';
    const completion = this.#exchange(attempt, flow, code);
    this.#completions.add(completion);
    void completion.finally(() => this.#completions.delete(completion));
    await Promise.race([completion, Bun.sleep(this.options.replyWaitMs ?? COMPLETION_REPLY_WAIT_MS)]);
    return this.#outcome(attempt);
  }

  /** Aborts unfinished exchanges and waits for them (and their credential lock) to settle. */
  async stop(): Promise<void> {
    this.#stopping.abort(new Error('the runtime is stopping'));
    while (this.#completions.size > 0) await Promise.allSettled([...this.#completions]);
  }

  async #exchange(attempt: Attempt, flow: LoginFlow, code: string): Promise<void> {
    const slot = this.options.slot as string;
    let reason: AuthFailureReason | undefined;
    try {
      const state = await loginAnthropic({
        coordinator: this.options.coordinator(slot),
        transport: this.options.transport,
        flow,
        readCode: async () => code,
        signal: this.#stopping.signal,
        now: this.#now,
      });
      if (state.kind !== 'ready') reason = 'not_stored';
    } catch (error) {
      if (error instanceof LoginFailed) reason = EXCHANGE_FAILURES[error.reason];
      else if (error instanceof CredentialLockError) {
        reason = error.code === 'lock_busy' ? 'busy' : error.code === 'lock_aborted' ? 'stopped' : 'not_stored';
      } else reason = 'not_stored';
    }
    if (reason === undefined) this.#settle(attempt, 'connected');
    else this.#settle(attempt, 'failed', reason);
    this.#log(
      formatDiagnostic({
        event: reason === undefined ? 'provider_login_connected' : 'provider_login_failed',
        provider: 'anthropic',
        ...(reason === undefined ? {} : { reason }),
      }),
    );
  }

  #settle(attempt: Attempt, state: AuthAttemptState, failure?: AuthFailureReason): void {
    attempt.state = state;
    attempt.settledAtMs = this.#now();
    attempt.flow = undefined;
    if (failure !== undefined) attempt.failure = failure;
  }

  /** Expires attempts that waited too long, forgets old finished ones, and keeps the retained set bounded. */
  #prune(): void {
    const now = this.#now();
    for (const [id, attempt] of this.#attempts) {
      if (attempt.state === 'awaiting_code' && now >= attempt.expiresAtMs) this.#settle(attempt, 'expired');
      if (attempt.settledAtMs !== undefined && now >= attempt.settledAtMs + ATTEMPT_LIFETIME_MS) {
        this.#attempts.delete(id);
      }
    }
    // Only finished attempts are evicted, oldest first; at most one attempt is ever unfinished.
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
      provider: 'anthropic',
      state: attempt.state,
      expiresAt: new Date(attempt.expiresAtMs).toISOString(),
      ...(attempt.state === 'awaiting_code' && attempt.flow !== undefined
        ? { authorizationUrl: attempt.flow.authorizationUrl }
        : {}),
      ...(attempt.failure === undefined
        ? {}
        : { failure: { reason: attempt.failure, message: FAILURE_MESSAGES[attempt.failure] } }),
    };
  }
}
