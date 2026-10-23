import { afterAll, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { FIXTURE_DATABASE_PREFIX, requireIntegrationFixture } from '../tests/support/integration-fixture.ts';
import { fixtureEnv, refusedOverrides } from './lib/fixture-env.ts';
import { repoRoot } from './lib/workspace.ts';

const scratch = mkdtempSync(join(tmpdir(), 'agent-runtime-guard-test-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe('launcher environment policy', () => {
  test('refuses ambient storage, credential, Compose and provider overrides', () => {
    const env = {
      PATH: '/usr/bin',
      DATABASE_URL: 'postgres://owner@db/prod',
      PGPASSWORD: 'x',
      COMPOSE_FILE: 'other.yaml',
      COMPOSE_PROJECT_NAME: 'agent-runtime',
      TS_AUTHKEY: 'x',
      AGENT_RUNTIME_WORKSPACE: '/home/owner',
      ANTHROPIC_API_KEY: 'x',
      OPENAI_API_KEY: 'x',
      LANGSMITH_TRACING: 'true',
      EMPTY_IS_IGNORED: '',
    };
    expect(refusedOverrides(env)).toEqual([
      'AGENT_RUNTIME_WORKSPACE',
      'ANTHROPIC_API_KEY',
      'COMPOSE_FILE',
      'COMPOSE_PROJECT_NAME',
      'DATABASE_URL',
      'LANGSMITH_TRACING',
      'OPENAI_API_KEY',
      'PGPASSWORD',
      'TS_AUTHKEY',
    ]);
    expect(refusedOverrides({ PATH: '/usr/bin', HOME: '/home/owner', DOCKER_HOST: 'unix:///run/docker.sock' })).toEqual(
      [],
    );
  });

  test('forwards only allowlisted variables plus launcher-provided fixture settings', () => {
    expect(fixtureEnv({ PATH: '/bin', SECRET_TOKEN: 'x', HOME: '/h' }, { FIXTURE: '1' })).toEqual({
      PATH: '/bin',
      HOME: '/h',
      FIXTURE: '1',
    });
  });

  // A fake `docker` executable records any invocation; refusal must happen before it is ever called.
  const fakeBin = join(scratch, 'bin');
  const witness = join(scratch, 'docker-invocations');
  mkdirSync(fakeBin);
  writeFileSync(join(fakeBin, 'docker'), `#!/bin/sh\necho "$@" >> '${witness}'\nexit 1\n`);
  chmodSync(join(fakeBin, 'docker'), 0o755);

  const launch = async (script: string, args: string[], extraEnv: Record<string, string>) => {
    const proc = Bun.spawn([process.execPath, '--no-env-file', script, ...args], {
      cwd: repoRoot,
      env: { PATH: `${fakeBin}:${dirname(process.execPath)}:/usr/bin:/bin`, HOME: scratch, ...extraEnv },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    return { code: await proc.exited, stderr: await new Response(proc.stderr).text() };
  };

  for (const script of ['scripts/run-integration.ts', 'scripts/container-smoke.ts']) {
    test(`${script} refuses unsafe targets without starting anything`, async () => {
      for (const [args, env] of [
        [[], { DATABASE_URL: 'postgres://owner@127.0.0.1/agent_runtime' }],
        [[], { COMPOSE_FILE: 'compose.yaml' }],
        [[], { AGENT_RUNTIME_WORKSPACE: '/home/owner/repo' }],
        [['-f', 'compose.override.yaml'], {}],
      ] as const) {
        const result = await launch(script, [...args], env);
        expect(result.code).not.toBe(0);
        expect(result.stderr).toContain('refuses to start');
      }
      expect(existsSync(witness)).toBe(false);
    });
  }
});

describe('integration fixture guard', () => {
  const fixtureDir = mkdtempSync(join(tmpdir(), 'agent-runtime-it-guard-'));
  const markerPath = join(fixtureDir, 'fixture.json');
  const databaseUrl = `postgres://agent_runtime_fixture:pw@127.0.0.1:5999/${FIXTURE_DATABASE_PREFIX}abc`;
  writeFileSync(markerPath, JSON.stringify({ project: 'agent-runtime-it-abc', databaseUrl, token: 'x'.repeat(36) }));
  afterAll(() => rmSync(fixtureDir, { recursive: true, force: true }));

  test('accepts the launcher-provisioned fixture', () => {
    const fixture = requireIntegrationFixture({
      INTEGRATION_FIXTURE_FILE: markerPath,
      INTEGRATION_DATABASE_URL: databaseUrl,
    });
    expect(fixture.databaseUrl).toBe(databaseUrl);
  });

  test('refuses missing, non-loopback, non-fixture or mismatched databases', () => {
    const cases: Record<string, string | undefined>[] = [
      {},
      { INTEGRATION_FIXTURE_FILE: markerPath, INTEGRATION_DATABASE_URL: databaseUrl.replace('127.0.0.1', 'postgres') },
      {
        INTEGRATION_FIXTURE_FILE: markerPath,
        INTEGRATION_DATABASE_URL: databaseUrl.replace(FIXTURE_DATABASE_PREFIX, ''),
      },
      { INTEGRATION_FIXTURE_FILE: markerPath, INTEGRATION_DATABASE_URL: databaseUrl.replace('5999', '5432') },
      { INTEGRATION_FIXTURE_FILE: join(repoRoot, 'package.json'), INTEGRATION_DATABASE_URL: databaseUrl },
    ];
    for (const env of cases) expect(() => requireIntegrationFixture(env)).toThrow();
  });
});
