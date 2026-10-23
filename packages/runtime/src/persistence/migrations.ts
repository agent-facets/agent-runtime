import type { ReservedSQL, SQL } from 'bun';
import { PersistenceError, sqlStateOf } from './errors.ts';
import { RUNTIME_MIGRATIONS, type RuntimeMigration } from './runtime-migrations.ts';
import { SAVER_SCHEMA } from './saver/constants.ts';

export const RUNTIME_SCHEMA = 'runtime';

/** Saver migration positions shipped by the pinned @langchain/langgraph-checkpoint-postgres 1.0.5. */
export const SUPPORTED_SAVER_MIGRATIONS: readonly number[] = [0, 1, 2, 3, 4];

export function migrationChecksum(migration: Pick<RuntimeMigration, 'sql'>): string {
  const normalized = migration.sql.replaceAll('\r\n', '\n');
  return new Bun.CryptoHasher('sha256').update(normalized).digest('hex');
}

export interface JournalRow {
  version: number;
  name: string;
  checksum: string;
}

export type RuntimeSchemaState =
  | { kind: 'current' }
  | { kind: 'upgradable'; pending: RuntimeMigration[] }
  | { kind: 'incompatible'; reason: string };

/** Compares the recorded journal with the migrations this build ships; unknown, altered or gapped history is refused. */
export function classifyRuntimeJournal(
  rows: readonly JournalRow[],
  known: readonly RuntimeMigration[] = RUNTIME_MIGRATIONS,
): RuntimeSchemaState {
  const sorted = [...rows].sort((a, b) => a.version - b.version);
  for (const [index, row] of sorted.entries()) {
    const migration = known[index];
    if (row.version !== index + 1) {
      return { kind: 'incompatible', reason: `runtime migration history is not contiguous at version ${row.version}` };
    }
    if (migration === undefined) {
      return { kind: 'incompatible', reason: `runtime schema version ${row.version} is newer than this build` };
    }
    if (row.name !== migration.name || row.checksum !== migrationChecksum(migration)) {
      return { kind: 'incompatible', reason: `runtime migration ${row.version} differs from this build` };
    }
  }
  const pending = known.slice(sorted.length);
  return pending.length === 0 ? { kind: 'current' } : { kind: 'upgradable', pending };
}

export type SaverSchemaState =
  | { kind: 'absent' }
  | { kind: 'current' }
  | { kind: 'upgradable' }
  | { kind: 'incompatible'; reason: string };

/**
 * The saver's setup() skips silently when its ledger is newer than the installed package, so compatibility is
 * checked from the pinned ledger layout. This is read-only; the official saver performs every saver migration.
 */
export function classifySaverLedger(versions: readonly number[] | undefined): SaverSchemaState {
  if (versions === undefined) return { kind: 'absent' };
  const sorted = [...versions].sort((a, b) => a - b);
  // The pinned saver's positions are exactly 0..n-1, so any other recorded history is a gap, duplicate or unknown.
  if (sorted.some((version, index) => version !== index)) {
    return { kind: 'incompatible', reason: 'checkpoint migration history is not a supported sequence' };
  }
  if (sorted.length > SUPPORTED_SAVER_MIGRATIONS.length) {
    return { kind: 'incompatible', reason: `checkpoint schema version ${sorted.at(-1)} is newer than this build` };
  }
  return sorted.length === SUPPORTED_SAVER_MIGRATIONS.length ? { kind: 'current' } : { kind: 'upgradable' };
}

async function readRuntimeJournal(sql: SQL | ReservedSQL): Promise<JournalRow[]> {
  const [present] = await sql`select to_regclass('runtime.schema_migrations') is not null as present`;
  if (!present?.present) return [];
  const rows = await sql`select version, name, checksum from runtime.schema_migrations order by version`;
  return rows.map((row: JournalRow) => ({ version: Number(row.version), name: row.name, checksum: row.checksum }));
}

export async function readSaverLedger(sql: SQL | ReservedSQL): Promise<number[] | undefined> {
  const table = `${SAVER_SCHEMA}.checkpoint_migrations`;
  const [present] = await sql`select to_regclass(${table}) is not null as present`;
  if (!present?.present) return undefined;
  const rows = await sql`select v from checkpoints.checkpoint_migrations order by v`;
  return rows.map((row: { v: number | string }) => Number(row.v));
}

export async function inspectRuntimeSchema(sql: SQL | ReservedSQL): Promise<RuntimeSchemaState> {
  return classifyRuntimeJournal(await readRuntimeJournal(sql));
}

/** Applies pending runtime migrations, each atomically with its journal row. Callers must hold the migration lock. */
export async function migrateRuntimeSchema(connection: ReservedSQL): Promise<void> {
  await connection.begin(async (tx) => {
    await tx`create schema if not exists runtime`;
    await tx`create table if not exists runtime.schema_migrations (
      version integer primary key check (version > 0),
      name text not null,
      checksum text not null check (checksum ~ '^[0-9a-f]{64}$'),
      applied_at timestamptz not null default now()
    )`;
  });
  const state = await inspectRuntimeSchema(connection);
  if (state.kind === 'incompatible') throw new PersistenceError('schema_incompatible', state.reason);
  if (state.kind === 'current') return;
  for (const migration of state.pending) {
    try {
      await connection.begin(async (tx) => {
        await tx.unsafe(migration.sql);
        await tx`insert into runtime.schema_migrations (version, name, checksum)
          values (${migration.version}, ${migration.name}, ${migrationChecksum(migration)})`;
      });
    } catch (error) {
      throw new PersistenceError(
        'migration_failed',
        `runtime migration ${migration.version} failed`,
        sqlStateOf(error),
      );
    }
  }
}
