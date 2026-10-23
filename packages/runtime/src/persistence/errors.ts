export type PersistenceFaultCode =
  | 'database_unavailable'
  | 'database_connection_closed'
  | 'checkpoint_pool_error'
  | 'owned_elsewhere'
  | 'ownership_lost'
  | 'stale_owner'
  | 'schema_incompatible'
  | 'migration_failed'
  | 'shutdown';

/**
 * A persistence failure carrying only a stable code and a safe message. Driver errors can contain connection
 * strings, hosts or parameters, so their text is never copied here.
 */
export class PersistenceError extends Error {
  override readonly name = 'PersistenceError';

  constructor(
    readonly code: PersistenceFaultCode,
    message: string,
    readonly sqlState?: string,
  ) {
    super(message);
  }
}

const SQLSTATE = /^[0-9A-Z]{5}$/;

/** Extracts a PostgreSQL SQLSTATE when a driver error exposes one; nothing else from the error is retained. */
export function sqlStateOf(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  for (const key of ['errno', 'code', 'sqlState'] as const) {
    const value = (error as Record<string, unknown>)[key];
    if (typeof value === 'string' && SQLSTATE.test(value)) return value;
  }
  return undefined;
}

export function asPersistenceError(error: unknown, code: PersistenceFaultCode, message: string): PersistenceError {
  if (error instanceof PersistenceError) return error;
  return new PersistenceError(code, message, sqlStateOf(error));
}
