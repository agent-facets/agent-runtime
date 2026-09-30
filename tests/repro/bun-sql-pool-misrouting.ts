// Standalone reproduction of a Bun SQL (PostgreSQL) pool defect observed on Bun 1.3.14. Not part of any check.
//
// Under contention, a plain pool query (sql`...`, not sql.begin) can be sent on a connection that is inside another
// caller's explicit transaction. A plain SELECT then reports a transaction ID (it ran inside a writer's transaction),
// or fails with 25P02 when that transaction has aborted, and a connection can be left "idle in transaction
// (aborted)". Statements issued through sql.begin() were not observed to be affected.
//
// Usage: REPRO_DATABASE_URL=postgres://user:pass@127.0.0.1:5432/scratch_db bun tests/repro/bun-sql-pool-misrouting.ts
// The database should be disposable; the script creates and drops one table.
import { SQL } from 'bun';

const url = process.env.REPRO_DATABASE_URL;
if (!url) throw new Error('set REPRO_DATABASE_URL to a disposable database');

const sql = new SQL(url, { max: 5 });
const table = `repro_${crypto.randomUUID().replaceAll('-', '').slice(0, 8)}`;
await sql.unsafe(`create table ${table} (id serial primary key, k uuid not null unique)`);
await sql.unsafe(`create table ${table}_lock (singleton int primary key)`);
await sql.unsafe(`insert into ${table}_lock values (1)`);

const tally: Record<string, number> = {};
const note = (label: string) => {
  tally[label] = (tally[label] ?? 0) + 1;
};

for (let round = 0; round < 25; round++) {
  const key = crypto.randomUUID();
  let probing = true;
  const probes = (async () => {
    while (probing) {
      await Promise.all(
        Array.from({ length: 4 }, () =>
          sql`select pg_current_xact_id_if_assigned()::text as xid`.then(
            ([row]) =>
              note(row.xid === null ? 'plain-query:own-transaction' : 'plain-query:INSIDE-ANOTHER-TRANSACTION'),
            (error) => note(`plain-query:error-${(error as { errno?: string }).errno}`),
          ),
        ),
      );
    }
  })();
  // Ten writers race on one unique key: one commits, nine fail with 23505 after waiting on the winner's row lock.
  const round_ = Promise.allSettled(
    Array.from({ length: 10 }, async () => {
      // A plain lookup first, as idempotent creation does, so plain queries and transactions queue together.
      await sql`select id from ${sql(table)} where k = ${key}`;
      return sql
        .begin(async (tx) => {
          await tx.unsafe(`select singleton from ${table}_lock for share`);
          await tx.unsafe(`insert into ${table} (k) values ($1)`, [key]);
          await tx.unsafe('select pg_sleep(0.002)');
        })
        .then(
          () => note('writer:committed'),
          async (error) => {
            note(`writer:error-${(error as { errno?: string }).errno}`);
            // Readback immediately after the failed transaction, as idempotent creation does.
            await sql`select id from ${sql(table)} where k = ${key}`.then(
              () => note('readback:ok'),
              (inner) => note(`readback:error-${(inner as { errno?: string }).errno}`),
            );
          },
        );
    }),
  );
  if (await Promise.race([round_.then(() => false), Bun.sleep(15_000).then(() => true)])) {
    // The pool has stopped making progress; show the server's view of every session through a separate connection.
    const observer = new SQL(url, { max: 1 });
    const sessions = await observer`
      select pid, state, wait_event_type, wait_event, left(query, 70) as last_statement
      from pg_stat_activity where datname = current_database() and pid <> pg_backend_pid() order by pid`;
    console.log({ bun: Bun.version, stalledInRound: round, ...tally });
    console.table(sessions);
    await observer.unsafe(`drop table if exists ${table}, ${table}_lock`).catch(() => {});
    process.exit(2);
  }
  probing = false;
  await probes;
}

const [stuck] = await sql`select count(*)::int as n from pg_stat_activity
  where datname = current_database() and state = 'idle in transaction (aborted)'`;
console.log({ bun: Bun.version, ...tally, idleInAbortedTransaction: stuck.n });
await sql.unsafe(`drop table ${table}, ${table}_lock`);
await sql.close({ timeout: 1 });
