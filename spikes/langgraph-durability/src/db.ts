// Postgres connectivity.
//
// Two pools per process, always. The checkpointer gets its own; the probe gets
// another. Sharing one would let a probe write ride inside a checkpointer
// transaction, which would make re-execution atomic with the checkpoint and
// therefore structurally unobservable — the experiment could only ever pass.
//
// Auth is `trust` on an isolated, gateway-less network. That is a deliberate
// throwaway-harness decision: it avoids manufacturing a fake credential and
// avoids the Compose secret-ownership trap. It establishes nothing about how
// the production stack should provision a database password.

import pg from "pg";

export type Db = {
  pool: pg.Pool;
  appName: string;
  close(): Promise<void>;
};

export function connectionString(appName: string): string {
  const host = process.env.PGHOST ?? "postgres";
  const port = process.env.PGPORT ?? "5432";
  const user = process.env.PGUSER ?? "spike";
  const database = process.env.PGDATABASE ?? "spike";
  const params = new URLSearchParams({
    application_name: appName,
    connect_timeout: "5",
  });
  return `postgresql://${user}@${host}:${port}/${database}?${params.toString()}`;
}

export function openDb(appName: string, max = 4): Db {
  const pool = new pg.Pool({
    connectionString: connectionString(appName),
    max,
    // A killed peer's backend can hold locks until its TCP session decays. A
    // bounded statement timeout turns that into a reported fault instead of a
    // driver that hangs forever and looks like a failed measurement.
    statement_timeout: 15_000,
    idleTimeoutMillis: 5_000,
    connectionTimeoutMillis: 5_000,
  });
  return {
    pool,
    appName,
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
