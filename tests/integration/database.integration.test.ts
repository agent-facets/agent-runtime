import { afterAll, describe, expect, test } from 'bun:test';
import { SQL } from 'bun';
import { requireIntegrationFixture } from '../support/integration-fixture.ts';

const fixture = requireIntegrationFixture();
const sql = new SQL(fixture.databaseUrl, { max: 1 });

afterAll(() => sql.close());

describe('isolated PostgreSQL fixture', () => {
  test('connects to the launcher-owned fixture database through Bun SQL', async () => {
    const [row] = await sql`select current_database() as name`;
    expect(row.name).toStartWith('agent_runtime_fixture_');
  });
});
