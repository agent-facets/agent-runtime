import { SQL } from 'bun';
import type { DatabaseStatus } from './server.ts';

const PROBE_TIMEOUT_MS = 2_000;

export function createDatabaseProbe(databaseUrl: string | undefined): () => Promise<DatabaseStatus> {
  if (databaseUrl === undefined) return async () => 'unconfigured';
  const sql = new SQL(databaseUrl, { max: 1, idleTimeout: 30, connectionTimeout: PROBE_TIMEOUT_MS / 1000 });
  return async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<'unreachable'>((resolve) => {
      timer = setTimeout(() => resolve('unreachable'), PROBE_TIMEOUT_MS);
    });
    // Connection errors can include connection details, so only the outcome is reported.
    const probe = sql`select 1`.then(
      () => 'reachable' as const,
      () => 'unreachable' as const,
    );
    try {
      return await Promise.race([probe, timeout]);
    } finally {
      clearTimeout(timer);
    }
  };
}
