// Postgres connectivity for Lane M's derived projection and the shared
// execution plane.
//
// Two rules are imported unchanged from spike 06, which measured both failures
// rather than assuming them:
//
//   1. An `error` listener on every pooled client, not only on the pool. pg
//      emits `error` on the CLIENT when a server dies under an in-flight call,
//      and an `error` event with no listener is fatal in Node — the worker dies
//      before the awaited promise can reject, and a real measurement is recorded
//      as a harness fault instead.
//
//   2. `max >= 2` wherever a component may acquire a second connection while
//      holding one. A pool of one deadlocks against itself, silently, and only
//      under the concurrency the case exists to create.
//
// Auth is `trust` on a gateway-less, unpublished network. That is a throwaway
// harness decision and establishes nothing about production provisioning.

import pg from "pg";

export type PoolRole = "app" | "migrator" | "probe";

export type Db = {
  pool: pg.Pool;
  role: PoolRole;
  appName: string;
  /** Errors seen on idle or checked-out clients, kept as evidence rather than thrown away. */
  clientErrors: Array<{ message: string; code: string | null }>;
  close(): Promise<void>;
};

export function connectionString(appName: string): string {
  const host = process.env.PGHOST ?? "pg-m";
  const port = process.env.PGPORT ?? "5432";
  const user = process.env.PGUSER ?? "spike";
  const database = process.env.PGDATABASE ?? "kpwm";
  const params = new URLSearchParams({ application_name: appName, connect_timeout: "5" });
  return `postgresql://${user}@${host}:${port}/${database}?${params.toString()}`;
}

export function openDb(appName: string, role: PoolRole, max?: number): Db {
  const pool = new pg.Pool({
    connectionString: connectionString(appName),
    // The migrator is deliberately 1: it must hold exactly one session, because
    // a session-level advisory lock belongs to a backend and not to a pool.
    max: max ?? (role === "migrator" ? 1 : 4),
    statement_timeout: 15_000,
    idleTimeoutMillis: 5_000,
    connectionTimeoutMillis: 5_000,
  });

  const clientErrors: Array<{ message: string; code: string | null }> = [];
  const record = (error: unknown): void => {
    clientErrors.push({
      message: error instanceof Error ? error.message : String(error),
      code: (error as { code?: string } | null)?.code ?? null,
    });
  };
  pool.on("error", record);
  pool.on("connect", (client) => {
    client.on("error", record);
  });

  return {
    pool,
    role,
    appName,
    clientErrors,
    close: async () => {
      await pool.end();
    },
  };
}

export async function waitForDb(db: Db, timeoutMs: number, pollMs = 250): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown = null;
  while (Date.now() < deadline) {
    try {
      await db.pool.query("SELECT 1");
      return;
    } catch (error) {
      last = error;
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  }
  throw new Error(`postgres not reachable within ${timeoutMs}ms: ${String(last)}`);
}

export function describeSqlError(error: unknown): {
  message: string;
  code: string | null;
  constraint: string | null;
} {
  const err = error as { message?: string; code?: string; constraint?: string } | null;
  return {
    message: err?.message ?? String(error),
    code: err?.code ?? null,
    constraint: err?.constraint ?? null,
  };
}
