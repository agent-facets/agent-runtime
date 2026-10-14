import { RUN_RECORDS_SQL } from './migrations/002-run-records.ts';
import { QUESTION_TEXT_BYTES_SQL } from './migrations/003-question-text-bytes.ts';
import { CAPABILITY_RECORDS_SQL } from './migrations/004-capability-records.ts';
import { CANONICAL_TOOL_NAMES_SQL } from './migrations/005-canonical-tool-names.ts';

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
  { version: 4, name: 'capability_records', sql: CAPABILITY_RECORDS_SQL },
  { version: 5, name: 'canonical_tool_names', sql: CANONICAL_TOOL_NAMES_SQL },
];
