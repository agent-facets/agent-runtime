// Postgres connectivity.
//
// Four pools per process, never fewer, and each with a declared job:
//
//   subject  the pool handed to PostgresSaver / PostgresStore. Nothing the
//            harness reads is ever read through it.
//   probe    execution witnesses and barrier arrivals. Separate so a probe write
//            cannot ride inside a checkpointer transaction, which would make
//            re-execution atomic with the checkpoint and therefore unobservable.
//   observe  pg_stat_activity / pg_locks sampling. Read-only, and excluded by
//            name from its own projections so the observer never appears in the
//            lock graph it is capturing.
//   inspect  raw projections after the participants have drained.
//
// Auth is `trust` on an isolated, gateway-less network. That is a throwaway
// harness decision and establishes nothing about production provisioning.

import pg from "pg";

export type Role = "subject" | "probe" | "observe" | "inspect" | "lease" | "migrator";

export type DbOptions = {
  /** Overrides PGDATABASE. Provisioning needs the maintenance database; cases need their own. */
  database?: string;
  /**
   * Overrides PGUSER. Family C constrains connections with a per-role
   * CONNECTION LIMIT, which only isolates the subject if the harness's own pools
   * keep connecting as the unconstrained role.
   */
  user?: string;
  max?: number;
  /**
   * Bounded by default so a killed peer's lingering locks surface as a reported
   * fault instead of an indefinite hang. Family C overrides it per case: a lane
   * measuring a lock wait must be allowed to wait, and one measuring pool
   * exhaustion must fail loudly rather than time out anonymously.
   */
  statementTimeoutMs?: number | null;
  /** Set explicitly so a lock wait reports 55P03 rather than an anonymous 57014. */
  lockTimeoutMs?: number | null;
  idleTimeoutMillis?: number;
  connectionTimeoutMillis?: number;
  /**
   * pg-pool emits 'error' on the Pool for a client that fails while idle, and an
   * unhandled 'error' event kills the process. Leaving it unhandled is itself a
   * measurable condition (family G), so it is opt-in rather than automatic.
   */
  captureIdleErrors?: boolean;
};

export type Db = {
  pool: pg.Pool;
  appName: string;
  role: Role;
  idleErrors: Array<{ message: string; code: string | null }>;
  close(): Promise<void>;
};

export function connectionString(appName: string, database?: string, asUser?: string): string {
  const host = process.env.PGHOST ?? "postgres";
  const port = process.env.PGPORT ?? "5432";
  const user = asUser ?? process.env.PGUSER ?? "spike";
  const db = database ?? process.env.PGDATABASE ?? "spike";
  const params = new URLSearchParams({
    application_name: appName,
    connect_timeout: "5",
  });
  return `postgresql://${user}@${host}:${port}/${db}?${params.toString()}`;
}

/**
 * `<case>:<member>#<role>`.
 *
 * The `#` matters: a participant opens several pools, and every concurrency
 * witness counts PARTIES rather than connections. Splitting on `#` recovers the
 * member from any backend, and `member` is assigned by the driver before the
 * race, so it is a managed value rather than a volatile one.
 */
export function appNameFor(caseId: string, member: string, role: string): string {
  return `${caseId}:${member}#${role}`;
}

export function memberFromAppName(appName: string): string {
  const withoutCase = appName.slice(appName.indexOf(":") + 1);
  return withoutCase.split("#")[0] ?? withoutCase;
}

export function roleFromAppName(appName: string): string {
  const withoutCase = appName.slice(appName.indexOf(":") + 1);
  return withoutCase.includes("#") ? withoutCase : `${withoutCase}#?`;
}

export function openDb(appName: string, role: Role, options: DbOptions = {}): Db {
  const {
    database,
    user,
    max = role === "observe" ? 1 : role === "probe" ? 2 : 4,
    statementTimeoutMs = 15_000,
    lockTimeoutMs = null,
    idleTimeoutMillis = 5_000,
    connectionTimeoutMillis = 5_000,
    captureIdleErrors = true,
  } = options;

  const pool = new pg.Pool({
    connectionString: connectionString(appName, database, user),
    max,
    ...(statementTimeoutMs === null ? {} : { statement_timeout: statementTimeoutMs }),
    ...(lockTimeoutMs === null ? {} : { lock_timeout: lockTimeoutMs }),
    idleTimeoutMillis,
    connectionTimeoutMillis,
  });

  const idleErrors: Array<{ message: string; code: string | null }> = [];
  if (captureIdleErrors) {
    pool.on("error", (error: unknown) => {
      idleErrors.push({
        message: error instanceof Error ? error.message : String(error),
        code: (error as { code?: string } | null)?.code ?? null,
      });
    });
  }

  return {
    pool,
    appName,
    role,
    idleErrors,
    close: async () => {
      await pool.end();
    },
  };
}

export async function waitForDb(db: Db, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      await db.pool.query("SELECT 1");
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error(`database not reachable within ${timeoutMs}ms: ${String(lastError)}`);
}

export type SqlError = {
  name: string;
  message: string;
  code: string | null;
  constraint: string | null;
};

export function describeSqlError(error: unknown): SqlError {
  const err = error as
    | { name?: string; message?: string; code?: string; constraint?: string }
    | null;
  return {
    name: err?.name ?? "Error",
    message: err?.message ?? String(error),
    code: err?.code ?? null,
    constraint: err?.constraint ?? null,
  };
}
