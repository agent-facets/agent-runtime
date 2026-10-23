// Exclusive maintenance while the runtime is stopped. Operator tooling that must not race a live runtime takes the
// same singleton ownership lock the runtime holds for its whole life, without migrating anything or claiming an owner
// epoch, so a running runtime (or another maintenance command) makes it refuse instead of waiting.
import { createAppDatabase } from './app-database.ts';
import { PersistenceError } from './errors.ts';
import { Ownership } from './ownership.ts';

export class MaintenanceRefused extends Error {
  override readonly name = 'MaintenanceRefused';
  constructor(readonly reason: 'runtime_running' | 'database_unavailable') {
    super(
      reason === 'runtime_running'
        ? 'the runtime (or other maintenance) owns the database'
        : 'the database is unavailable, so exclusive maintenance cannot be established',
    );
  }
}

/** Runs `body` while holding singleton ownership; the database schema and owner epoch are left unchanged. */
export async function withMaintenanceOwnership<T>(url: string, body: () => Promise<T>): Promise<T> {
  let lost: PersistenceError | undefined;
  const app = createAppDatabase({
    url,
    onFault: (error) => {
      lost = error;
    },
  });
  let ownership: Ownership | undefined;
  try {
    try {
      ownership = await Ownership.acquire(app);
    } catch (error) {
      throw new MaintenanceRefused(
        error instanceof PersistenceError && error.code === 'owned_elsewhere'
          ? 'runtime_running'
          : 'database_unavailable',
      );
    }
    if (lost !== undefined) throw new MaintenanceRefused('database_unavailable');
    await ownership.verify().catch(() => {
      throw new MaintenanceRefused('database_unavailable');
    });
    return await body();
  } finally {
    await ownership?.release();
    await app.close().catch(() => {});
  }
}
