// Integration suites call this before touching storage. It accepts only the disposable fixture
// provisioned by `bun run test:integration`, never an owner or production database.
import { readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, relative } from 'node:path';

export const FIXTURE_DATABASE_PREFIX = 'agent_runtime_fixture_';

export interface IntegrationFixture {
  project: string;
  databaseUrl: string;
  token: string;
}

export function requireIntegrationFixture(env: Record<string, string | undefined> = process.env): IntegrationFixture {
  const markerPath = env.INTEGRATION_FIXTURE_FILE;
  const databaseUrl = env.INTEGRATION_DATABASE_URL;
  if (!markerPath || !databaseUrl) {
    throw new Error('integration fixture missing: run integration suites through `bun run test:integration`');
  }

  const fixtureParent = relative(realpathSync(tmpdir()), realpathSync(dirname(markerPath)));
  if (basename(markerPath) !== 'fixture.json' || fixtureParent.startsWith('..') || fixtureParent === '') {
    throw new Error('integration fixture marker is outside the launcher-owned temporary directory');
  }

  const url = new URL(databaseUrl);
  const database = url.pathname.slice(1);
  if (url.protocol !== 'postgres:' || url.hostname !== '127.0.0.1' || !database.startsWith(FIXTURE_DATABASE_PREFIX)) {
    throw new Error('integration database is not a loopback fixture database');
  }

  const marker = JSON.parse(readFileSync(markerPath, 'utf8')) as IntegrationFixture;
  if (
    marker.databaseUrl !== databaseUrl ||
    !marker.project.startsWith('agent-runtime-it-') ||
    marker.token.length < 16
  ) {
    throw new Error('integration database does not match the launcher fixture marker');
  }
  return marker;
}
