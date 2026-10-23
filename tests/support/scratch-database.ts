// Per-test databases inside the launcher-owned fixture server, so suites never share schema or ownership state.
import { SQL } from 'bun';
import { FIXTURE_DATABASE_PREFIX, type IntegrationFixture, requireIntegrationFixture } from './integration-fixture.ts';

const NAME = /^agent_runtime_fixture_[a-z0-9_]{1,40}$/;

export interface ScratchDatabase {
  name: string;
  url: string;
  /** Administrative connection to the scratch database (not an application pool). */
  admin: SQL;
  /** Terminates the scratch database's backends, which only this test created. */
  terminate(where: { applicationName?: string; pid?: number }): Promise<number>;
  drop(): Promise<void>;
}

let counter = 0;

export async function createScratchDatabase(
  fixture: IntegrationFixture = requireIntegrationFixture(),
): Promise<ScratchDatabase> {
  const name = `${FIXTURE_DATABASE_PREFIX}${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}_${++counter}`;
  if (!NAME.test(name)) throw new Error('invalid scratch database name');
  const server = new SQL(fixture.databaseUrl, { max: 1 });
  await server.unsafe(`create database "${name}"`);
  const url = new URL(fixture.databaseUrl);
  url.pathname = `/${name}`;
  const admin = new SQL(url.toString(), { max: 2, connection: { application_name: 'fixture-admin' } });

  return {
    name,
    url: url.toString(),
    admin,
    async terminate(where) {
      const rows = await admin`
        select pg_terminate_backend(pid) as ok from pg_stat_activity
        where datname = ${name} and pid <> pg_backend_pid()
          and (${where.applicationName ?? null}::text is null or application_name = ${where.applicationName ?? null})
          and (${where.pid ?? null}::int is null or pid = ${where.pid ?? null})`;
      return rows.filter((row: { ok: boolean }) => row.ok).length;
    },
    async drop() {
      await admin.close({ timeout: 1 });
      await server`select pg_terminate_backend(pid) from pg_stat_activity where datname = ${name}`;
      await server.unsafe(`drop database if exists "${name}"`);
      await server.close({ timeout: 1 });
    },
  };
}

/** Polls until the predicate holds, failing after the deadline. */
export async function eventually(predicate: () => boolean | Promise<boolean>, timeoutMs = 5_000, label = 'condition') {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await Bun.sleep(25);
  }
  throw new Error(`timed out waiting for ${label}`);
}
