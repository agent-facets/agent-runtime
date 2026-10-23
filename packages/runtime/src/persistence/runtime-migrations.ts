import { RUN_RECORDS_SQL } from './migrations/002-run-records.ts';
import { QUESTION_TEXT_BYTES_SQL } from './migrations/003-question-text-bytes.ts';

// Ordered application migrations for the `runtime` schema. Applied migrations are immutable: their name and
// normalized SQL checksum are journaled, and a build refuses a database whose history it does not recognize.

export interface RuntimeMigration {
  version: number;
  name: string;
  sql: string;
}

export const RUNTIME_MIGRATIONS: readonly RuntimeMigration[] = [
  {
    version: 1,
    name: 'runtime_owner',
    sql: `
create table runtime.runtime_owner (
  singleton smallint primary key check (singleton = 1),
  owner_id uuid not null,
  epoch bigint not null check (epoch > 0),
  started_at timestamptz not null
);
`,
  },
  { version: 2, name: 'run_records', sql: RUN_RECORDS_SQL },
  { version: 3, name: 'question_text_bytes', sql: QUESTION_TEXT_BYTES_SQL },
];
