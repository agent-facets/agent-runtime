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
const APPLIED = [
  'b6438e72f8878eb5489ab5c28e4abb32fc51df5883a1669635ef41337c45b2de',
  '49db0b2c8c32ea6942066c49a3c179968699256ca716177ff80884ff9b8d90f3',
  '343f2f648f9e516c0bc753054737e5275435e7b7628f4d5a7c493f7ade26a63a',
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

  test('the capability migration is forward only: a build knowing only version 3 refuses its history', () => {
    expect(RUNTIME_MIGRATIONS.slice(0, 4).map((m) => m.name)).toEqual([
      'runtime_owner',
      'run_records',
      'question_text_bytes',
      'capability_records',
    ]);
    const shipped = RUNTIME_MIGRATIONS.map(row);
    expect(classifyRuntimeJournal(shipped.slice(0, 3)).kind).toBe('upgradable');
    expect(classifyRuntimeJournal(shipped, RUNTIME_MIGRATIONS.slice(0, 3))).toEqual({
      kind: 'incompatible',
      reason: 'runtime schema version 4 is newer than this build',
    });
  });

  test('canonical tool names are a later forward migration: a build knowing only version 4 refuses it', () => {
    expect(RUNTIME_MIGRATIONS[4]?.name).toBe('canonical_tool_names');
    const shipped = RUNTIME_MIGRATIONS.map(row);
    expect(classifyRuntimeJournal(shipped.slice(0, 4)).kind).toBe('upgradable');
    expect(classifyRuntimeJournal(shipped.slice(0, 5), RUNTIME_MIGRATIONS.slice(0, 4))).toEqual({
      kind: 'incompatible',
      reason: 'runtime schema version 5 is newer than this build',
    });
  });

  test('applied migrations are unchanged', () => {
    // Journaled checksums of migrations 1–3 as applied by phase-1 databases; editing them strands every database.
    expect(RUNTIME_MIGRATIONS.slice(0, 3).map((migration) => migrationChecksum(migration))).toEqual(APPLIED);
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
