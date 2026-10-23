import { describe, expect, test } from 'bun:test';
import {
  classifyRuntimeJournal,
  classifySaverLedger,
  type JournalRow,
  migrationChecksum,
  SUPPORTED_SAVER_MIGRATIONS,
} from './migrations.ts';
import { RUNTIME_MIGRATIONS, type RuntimeMigration } from './runtime-migrations.ts';

const known: RuntimeMigration[] = [
  { version: 1, name: 'first', sql: 'create table runtime.a ();\n' },
  { version: 2, name: 'second', sql: 'create table runtime.b ();\n' },
];
const row = (migration: RuntimeMigration): JournalRow => ({
  version: migration.version,
  name: migration.name,
  checksum: migrationChecksum(migration),
});

describe('runtime migration journal', () => {
  test('shipped migrations are numbered contiguously from 1 with unique names', () => {
    expect(RUNTIME_MIGRATIONS.map((m) => m.version)).toEqual(RUNTIME_MIGRATIONS.map((_, index) => index + 1));
    expect(new Set(RUNTIME_MIGRATIONS.map((m) => m.name)).size).toBe(RUNTIME_MIGRATIONS.length);
  });

  test('checksums ignore line-ending style only', () => {
    const lf = migrationChecksum({ sql: 'select 1;\nselect 2;\n' });
    expect(migrationChecksum({ sql: 'select 1;\r\nselect 2;\r\n' })).toBe(lf);
    expect(migrationChecksum({ sql: 'select 1;\nselect 3;\n' })).not.toBe(lf);
    expect(lf).toMatch(/^[0-9a-f]{64}$/);
  });

  test('a fresh database has every migration pending; a complete one is current', () => {
    expect(classifyRuntimeJournal([], known)).toEqual({ kind: 'upgradable', pending: known });
    expect(classifyRuntimeJournal([row(known[0] as RuntimeMigration)], known)).toEqual({
      kind: 'upgradable',
      pending: known.slice(1),
    });
    expect(classifyRuntimeJournal(known.map(row), known)).toEqual({ kind: 'current' });
  });

  test('refuses newer, altered, renamed or gapped history', () => {
    const [first, second] = known as [RuntimeMigration, RuntimeMigration];
    const cases: JournalRow[][] = [
      [...known.map(row), { version: 3, name: 'future', checksum: 'f'.repeat(64) }],
      [{ ...row(first), checksum: '0'.repeat(64) }],
      [{ ...row(first), name: 'renamed' }],
      [row(second)],
    ];
    for (const rows of cases) expect(classifyRuntimeJournal(rows, known).kind).toBe('incompatible');
  });
});

describe('checkpoint saver ledger', () => {
  test('recognizes absent, partial and current ledgers', () => {
    expect(classifySaverLedger(undefined)).toEqual({ kind: 'absent' });
    expect(classifySaverLedger([0, 1])).toEqual({ kind: 'upgradable' });
    expect(classifySaverLedger([...SUPPORTED_SAVER_MIGRATIONS].reverse())).toEqual({ kind: 'current' });
  });

  test('refuses newer, gapped, duplicate or negative positions', () => {
    for (const versions of [
      [0, 1, 2, 3, 4, 5],
      [0, 1, 3],
      [0, 0, 1],
      [-1, 0],
      [1, 2],
    ]) {
      expect(classifySaverLedger(versions).kind).toBe('incompatible');
    }
    expect(classifySaverLedger([0, 1, 2, 3, 4, 5])).toEqual({
      kind: 'incompatible',
      reason: 'checkpoint schema version 5 is newer than this build',
    });
  });
});
