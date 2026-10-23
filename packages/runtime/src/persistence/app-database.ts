import { type ReservedSQL, SQL, type TransactionSQL } from 'bun';
import { PersistenceError } from './errors.ts';

/**
 * Connection budget for application SQL: one reserved ownership session, one temporary migration
 * reservation and at least three ordinary connections while migrating.
 */
export const APP_POOL_MAX = 5;
export const APP_APPLICATION_NAME = 'agent-runtime/app';
const CONNECT_TIMEOUT_SECONDS = 5;

/**
 * Application SQL access. The raw pool is deliberately not exposed: on Bun 1.3.14 a plain pool query can be sent on
 * a connection that is inside another caller's transaction when the pool is busy (it then commits or rolls back
 * with that transaction). Statements issued through begin() or a reserved session were not affected, so every
 * application statement runs in an explicit transaction or on a reserved session.
 */
export interface AppDatabase {
  /** A read-write transaction. */
  transaction<T>(body: (tx: TransactionSQL) => Promise<T>): Promise<T>;
  /** A read-only transaction; `repeatable read` gives one consistent snapshot across its statements. */
  readOnly<T>(body: (tx: TransactionSQL) => Promise<T>, isolation?: 'read committed' | 'repeatable read'): Promise<T>;
  /** A dedicated session (ownership, migrations); callers must release it. */
  reserve(): Promise<ReservedSQL>;
  /** Closes every application connection. Connection closes after this call are not faults. */
  close(timeoutSeconds?: number): Promise<void>;
}

export interface AppDatabaseOptions {
  url: string;
  /**
   * Called once for an unexpected connection close. Bun's close callback does not identify the connection,
   * so any unexpected close is treated as possible loss of the ownership session.
   */
  onFault: (error: PersistenceError) => void;
}

export function createAppDatabase(options: AppDatabaseOptions): AppDatabase {
  let closing = false;
  let faulted = false;
  const sql = new SQL(options.url, {
    adapter: 'postgres',
    max: APP_POOL_MAX,
    // Zero disables client-side idle and lifetime retirement, which would otherwise end the ownership session.
    idleTimeout: 0,
    maxLifetime: 0,
    connectionTimeout: CONNECT_TIMEOUT_SECONDS,
    connection: { application_name: APP_APPLICATION_NAME, TimeZone: 'UTC' },
    onclose: () => {
      if (closing || faulted) return;
      faulted = true;
      options.onFault(new PersistenceError('database_connection_closed', 'an application database connection closed'));
    },
  });
  return {
    transaction: (body) => sql.begin(body) as ReturnType<typeof body>,
    readOnly: (body, isolation = 'read committed') =>
      sql.begin(`isolation level ${isolation} read only`, body) as ReturnType<typeof body>,
    reserve: () => sql.reserve(),
    // Shutdown has already stopped all work; the timeout only bounds discarding a dead reserved session, which
    // Bun otherwise waits on for the full period.
    async close(timeoutSeconds = 1) {
      closing = true;
      await sql.close({ timeout: timeoutSeconds });
    },
  };
}
