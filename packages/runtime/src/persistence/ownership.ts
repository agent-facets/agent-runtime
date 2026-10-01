import type { ReservedSQL, TransactionSQL } from 'bun';
import type { AppDatabase } from './app-database.ts';
import { PersistenceError, sqlStateOf } from './errors.ts';

// Session-level advisory lock keys (two int4 form), scoped by PostgreSQL to the current database.
export const LOCK_NAMESPACE = 1_095_193_172; // "AGRT"
export const OWNERSHIP_LOCK = 1;
export const MIGRATION_LOCK = 2;
/** Transaction-scoped: serializes model-request admissions across runs when a deployment-wide ceiling is set. */
export const REQUEST_CEILING_LOCK = 3;

const DEFAULT_VERIFY_INTERVAL_MS = 5_000;
const DEFAULT_VERIFY_TIMEOUT_MS = 3_000;

export interface SessionIdentity {
  pid: number;
  /** Full-precision text; a JavaScript Date would round away the microseconds that distinguish sessions. */
  backendStart: string;
  databaseOid: string;
}

interface IdentityRow {
  pid: number;
  backend_start: string;
  database_oid: string;
  owns_lock: boolean;
}

async function readIdentity(session: ReservedSQL): Promise<IdentityRow | undefined> {
  const rows = await session`
    select a.pid, a.backend_start::text as backend_start, a.datid::text as database_oid,
      exists (
        select 1 from pg_catalog.pg_locks l
        where l.locktype = 'advisory' and l.pid = a.pid and l.database = a.datid
          and l.classid = ${LOCK_NAMESPACE}::oid and l.objid = ${OWNERSHIP_LOCK}::oid and l.objsubid = 2
          and l.mode = 'ExclusiveLock' and l.granted
      ) as owns_lock
    from pg_catalog.pg_stat_activity a
    where a.pid = pg_backend_pid()`;
  return rows.length === 1 ? (rows[0] as IdentityRow) : undefined;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new PersistenceError('ownership_lost', 'ownership verification timed out')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export interface OwnershipOptions {
  verifyIntervalMs?: number;
  verifyTimeoutMs?: number;
}

/**
 * Singleton runtime ownership. Authority exists only while the reserved session that acquired the advisory lock is
 * alive and unchanged. Loss is latched permanently: this object never reacquires ownership or reconnects.
 */
export class Ownership {
  readonly ownerId = crypto.randomUUID();
  #epoch: string | undefined;
  #lost: PersistenceError | undefined;
  #listeners = new Set<(error: PersistenceError) => void>();
  #verifying: Promise<void> | undefined;
  #timer: ReturnType<typeof setInterval> | undefined;
  #released = false;

  private constructor(
    private readonly session: ReservedSQL,
    readonly identity: SessionIdentity,
    private readonly verifyTimeoutMs: number,
  ) {}

  /** Reserves a dedicated session and takes the ownership lock without waiting; a second instance is refused. */
  static async acquire(db: Pick<AppDatabase, 'reserve'>, options: OwnershipOptions = {}): Promise<Ownership> {
    const session = await db.reserve();
    let acquired = false;
    try {
      const [row] = await session`select pg_try_advisory_lock(${LOCK_NAMESPACE}, ${OWNERSHIP_LOCK}) as locked`;
      if (row?.locked !== true)
        throw new PersistenceError('owned_elsewhere', 'another runtime instance owns this database');
      acquired = true;
      const identity = await readIdentity(session);
      if (identity?.owns_lock !== true) throw new PersistenceError('ownership_lost', 'ownership lock was not observed');
      const ownership = new Ownership(
        session,
        { pid: Number(identity.pid), backendStart: identity.backend_start, databaseOid: identity.database_oid },
        options.verifyTimeoutMs ?? DEFAULT_VERIFY_TIMEOUT_MS,
      );
      ownership.#startMonitor(options.verifyIntervalMs ?? DEFAULT_VERIFY_INTERVAL_MS);
      return ownership;
    } catch (error) {
      // An unacquired session can return to the pool. A session that holds (or may hold) the lock is closed
      // with the pool instead, because returning it would hand the lock to unrelated pool users.
      if (!acquired) session.release();
      throw error instanceof PersistenceError
        ? error
        : new PersistenceError('database_unavailable', 'could not establish runtime ownership', sqlStateOf(error));
    }
  }

  get epoch(): string {
    if (this.#epoch === undefined) throw new PersistenceError('ownership_lost', 'ownership epoch has not been claimed');
    return this.#epoch;
  }

  get lost(): PersistenceError | undefined {
    return this.#lost;
  }

  /** Synchronous guard for dispatch paths: throws once loss has been observed. */
  assertHeld(): void {
    if (this.#lost !== undefined) throw this.#lost;
  }

  onLost(listener: (error: PersistenceError) => void): () => void {
    if (this.#lost !== undefined) listener(this.#lost);
    else this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  markLost(error: PersistenceError): void {
    if (this.#lost !== undefined) return;
    this.#lost = error;
    this.#stopMonitor();
    for (const listener of this.#listeners) {
      try {
        listener(error);
      } catch {
        // Listeners must not prevent other listeners from observing loss.
      }
    }
    this.#listeners.clear();
  }

  /** Re-reads the reserved session's identity and lock. Any mismatch, error or timeout latches loss. */
  verify(): Promise<void> {
    if (this.#lost !== undefined) return Promise.reject(this.#lost);
    this.#verifying ??= this.#verifyOnce().finally(() => {
      this.#verifying = undefined;
    });
    return this.#verifying;
  }

  async #verifyOnce(): Promise<void> {
    try {
      const row = await withTimeout(readIdentity(this.session), this.verifyTimeoutMs);
      const unchanged =
        row !== undefined &&
        row.owns_lock === true &&
        Number(row.pid) === this.identity.pid &&
        row.backend_start === this.identity.backendStart &&
        row.database_oid === this.identity.databaseOid;
      if (!unchanged) throw new PersistenceError('ownership_lost', 'the ownership session changed or lost its lock');
    } catch (error) {
      this.markLost(
        error instanceof PersistenceError && error.code === 'ownership_lost'
          ? error
          : new PersistenceError('ownership_lost', 'the ownership session is unavailable', sqlStateOf(error)),
      );
    }
    this.assertHeld();
  }

  /** Records a new owner epoch. Earlier owners' fenced transactions fail once this commits. */
  async claimEpoch(db: AppDatabase): Promise<string> {
    await this.verify();
    const [row] = await db.transaction(
      (tx) => tx`
      insert into runtime.runtime_owner (singleton, owner_id, epoch, started_at)
      values (1, ${this.ownerId}, 1, now())
      on conflict (singleton) do update
        set owner_id = excluded.owner_id, epoch = runtime.runtime_owner.epoch + 1, started_at = excluded.started_at
      returning epoch::text as epoch`,
    );
    this.#epoch = row.epoch as string;
    await this.verify();
    return this.#epoch;
  }

  /** Stops monitoring and latches the shutdown state, so nothing can be dispatched under this ownership again. */
  shutdown(): void {
    this.markLost(new PersistenceError('shutdown', 'the runtime is shutting down'));
  }

  /**
   * Final step of shutdown, after all work is stopped: unlocks and returns the session so the pool can close
   * without waiting for it. The pool is closing, so the unlocked connection is not reused.
   */
  async release(): Promise<void> {
    this.shutdown();
    if (this.#released) return;
    this.#released = true;
    await releaseLockedSession(this.session);
  }

  #startMonitor(intervalMs: number) {
    this.#timer = setInterval(() => {
      this.verify().catch(() => {});
    }, intervalMs);
    this.#timer.unref();
  }

  #stopMonitor() {
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
  }
}

/** Drops every advisory lock held by a reserved session and returns it to its (closing) pool. */
export async function releaseLockedSession(session: ReservedSQL): Promise<void> {
  try {
    await withTimeout(session`select pg_advisory_unlock_all()`, 1_000);
  } catch {
    // A dead or unresponsive session is left for the pool's close to discard. Releasing a server-closed
    // reservation makes Bun raise an unhandled rejection, and a dead session holds no locks anyway.
    return;
  }
  session.release();
}

/** The identity an application mutation is fenced by. */
export interface OwnerFence {
  readonly ownerId: string;
  readonly epoch: string;
  assertHeld(): void;
  /** Re-verifies the ownership session; required before acting on an uncertain commit. */
  verify(): Promise<void>;
}

/**
 * Runs an application transaction fenced by the current owner epoch. The owner row is share-locked first, so an
 * epoch change waits for in-flight fenced transactions and every later one observes the new epoch.
 */
export async function withOwnerFence<T>(
  db: AppDatabase,
  ownership: OwnerFence,
  body: (tx: TransactionSQL) => Promise<T>,
): Promise<T> {
  ownership.assertHeld();
  const epoch = ownership.epoch;
  return db.transaction(async (tx) => {
    const [row] = await tx`
      select owner_id::text as owner_id, epoch::text as epoch from runtime.runtime_owner where singleton = 1 for share`;
    if (row?.owner_id !== ownership.ownerId || row?.epoch !== epoch) {
      throw new PersistenceError('stale_owner', 'this runtime is no longer the current owner');
    }
    ownership.assertHeld();
    return body(tx);
  });
}
