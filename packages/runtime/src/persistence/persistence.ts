import { type AppDatabase, createAppDatabase } from './app-database.ts';
import { PersistenceError, sqlStateOf } from './errors.ts';
import { KeyedSerializer } from './keyed-serializer.ts';
import { classifySaverLedger, inspectRuntimeSchema, migrateRuntimeSchema, readSaverLedger } from './migrations.ts';
import { LOCK_NAMESPACE, MIGRATION_LOCK, Ownership, type OwnershipOptions, releaseLockedSession } from './ownership.ts';
import { type CheckpointStore, createCheckpointStore } from './saver/checkpoint-saver.ts';

export type StartupStage = 'owned' | 'migrating' | 'migrated' | 'epoch_claimed';

export interface Persistence {
  readonly app: AppDatabase;
  readonly checkpoints: CheckpointStore;
  readonly ownership: Ownership;
  /** Per-run lifetime serialization: verification, invocation, stream settlement and final transition. */
  readonly executors: KeyedSerializer;
  /** Per-run short gate: admission, answer acceptance, cancellation and terminal commits. */
  readonly dispatchGates: KeyedSerializer;
  close(): Promise<void>;
}

export interface OpenPersistenceOptions {
  url: string;
  /** Receives every asynchronous persistence fault after startup, including ownership loss. */
  onFault: (error: PersistenceError) => void;
  ownership?: OwnershipOptions;
  /** Test witness for startup progress; never used to make decisions. */
  onStage?: (stage: StartupStage) => void;
}

function requireCompatible(state: { kind: string; reason?: string }): void {
  if (state.kind === 'incompatible') {
    throw new PersistenceError('schema_incompatible', state.reason ?? 'schema is incompatible with this build');
  }
}

/**
 * Establishes singleton ownership, then serially validates and migrates the runtime and checkpoint schemas and
 * claims a new owner epoch. A process that does not win ownership changes nothing.
 */
export async function openPersistence(options: OpenPersistenceOptions): Promise<Persistence> {
  let ownership: Ownership | undefined;
  let checkpoints: CheckpointStore | undefined;
  const pendingFaults: PersistenceError[] = [];
  const app = createAppDatabase({
    url: options.url,
    onFault: (error) => {
      if (ownership === undefined) pendingFaults.push(error);
      else ownership.markLost(new PersistenceError('ownership_lost', error.message));
    },
  });

  const closeAll = async () => {
    // Latch first so nothing new is dispatched; ownership is given up only after checkpoint work has ended.
    ownership?.shutdown();
    await checkpoints?.close().catch(() => {});
    await ownership?.release();
    await app.close().catch(() => {});
  };

  try {
    ownership = await Ownership.acquire(app, options.ownership);
    for (const fault of pendingFaults) ownership.markLost(new PersistenceError('ownership_lost', fault.message));
    options.onStage?.('owned');

    const migration = await app.reserve();
    let migrationLocked = false;
    try {
      const [lock] = await migration`select pg_try_advisory_lock(${LOCK_NAMESPACE}, ${MIGRATION_LOCK}) as locked`;
      if (lock?.locked !== true) throw new PersistenceError('migration_failed', 'the migration lock is held elsewhere');
      migrationLocked = true;
      options.onStage?.('migrating');

      // Both schemas are checked before either is changed.
      requireCompatible(await inspectRuntimeSchema(migration));
      requireCompatible(classifySaverLedger(await readSaverLedger(migration)));
      await ownership.verify();

      await migrateRuntimeSchema(migration);
      await ownership.verify();

      checkpoints = createCheckpointStore({ url: options.url, onFault: options.onFault });
      try {
        await checkpoints.setup();
      } catch (error) {
        throw new PersistenceError('migration_failed', 'checkpoint schema setup failed', sqlStateOf(error));
      }
      await ownership.verify();
      const saverState = classifySaverLedger(await readSaverLedger(migration));
      if (saverState.kind !== 'current') {
        throw new PersistenceError('schema_incompatible', 'checkpoint schema is not at the supported version');
      }
      options.onStage?.('migrated');

      await ownership.claimEpoch(app);
      options.onStage?.('epoch_claimed');

      await migration`select pg_advisory_unlock(${LOCK_NAMESPACE}, ${MIGRATION_LOCK})`;
      migrationLocked = false;
    } finally {
      // After a failure the migration lock is dropped as part of shutdown; the pool is closed immediately after.
      if (migrationLocked) await releaseLockedSession(migration);
      else migration.release();
    }

    const owned = ownership;
    owned.onLost(options.onFault);
    await owned.verify();
    const persistence: Persistence = {
      app,
      checkpoints,
      ownership: owned,
      executors: new KeyedSerializer(),
      dispatchGates: new KeyedSerializer(),
      close: closeAll,
    };
    return persistence;
  } catch (error) {
    await closeAll();
    if (error instanceof PersistenceError) throw error;
    throw new PersistenceError('database_unavailable', 'persistence startup failed', sqlStateOf(error));
  }
}
