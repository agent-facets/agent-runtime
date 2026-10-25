import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { FACET_FIXTURE_MARKER, requireFacetFixture } from '../tests/support/facet-fixture.ts';
import { FIXTURE_DATABASE_PREFIX, requireIntegrationFixture } from '../tests/support/integration-fixture.ts';
import { MCP_FIXTURE_MARKER, requireMcpFixture } from '../tests/support/mcp-fixture.ts';
import { assertSafeLaunch, fixtureEnv, refusedOverrides } from './lib/fixture-env.ts';
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

  test('refuses unexpected arguments and each unsafe override, naming every problem', () => {
    const refusal = (argv: string[], env: Record<string, string>) => () => assertSafeLaunch('test:x', argv, env);
    for (const env of [
      { DATABASE_URL: 'postgres://owner@127.0.0.1/agent_runtime' },
      { COMPOSE_FILE: 'compose.yaml' },
      { AGENT_RUNTIME_WORKSPACE: '/home/owner/repo' },
      { FACET_DIR: '/home/owner/.facet' },
      { FACET_TOKEN: 'x' },
    ] as Record<string, string>[]) {
      const [name] = Object.keys(env);
      expect(refusal([], env)).toThrow(`test:x refuses to start: refused environment overrides: ${name}`);
    }
    expect(refusal(['-f', 'compose.override.yaml'], {})).toThrow(
      'test:x refuses to start: unexpected arguments: -f compose.override.yaml.',
    );
    expect(refusal(['--x'], { COMPOSE_FILE: 'compose.yaml' })).toThrow(
      'unexpected arguments: --x; refused environment overrides: COMPOSE_FILE',
    );
    expect(refusal([], { PATH: '/usr/bin', HOME: '/home/owner', FACET_DIR: '' })).not.toThrow();
  });
});

// Each launcher is started once with an argument and an override it must refuse, proving it applies the policy
// above before doing anything. A fake `docker` executable records any invocation; refusal must come first.
describe('launchers apply the policy before starting anything', () => {
  const fakeBin = join(scratch, 'bin');
  const witness = join(scratch, 'docker-invocations');
  mkdirSync(fakeBin);
  writeFileSync(join(fakeBin, 'docker'), `#!/bin/sh\necho "$@" >> '${witness}'\nexit 1\n`);
  chmodSync(join(fakeBin, 'docker'), 0o755);

  const running = new Set<Bun.Subprocess>();
  afterEach(async () => {
    for (const proc of running) proc.kill('SIGKILL');
    await Promise.all([...running].map((proc) => proc.exited));
    running.clear();
  });

  const launch = async (script: string, args: string[], extraEnv: Record<string, string>) => {
    const proc = Bun.spawn([process.execPath, '--no-env-file', script, ...args], {
      cwd: repoRoot,
      env: { PATH: `${fakeBin}:${dirname(process.execPath)}:/usr/bin:/bin`, HOME: scratch, ...extraEnv },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    running.add(proc);
    const [code, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stderr).text(),
      new Response(proc.stdout).text(),
    ]);
    running.delete(proc);
    return { code, stderr };
  };

  for (const script of [
    'scripts/run-integration.ts',
    'scripts/run-browser.ts',
    'scripts/run-console-offline.ts',
    'scripts/container-smoke.ts',
    'scripts/run-facets.ts',
  ]) {
    test(`${script} refuses unsafe targets without starting anything`, async () => {
      const result = await launch(script, ['-f', 'compose.override.yaml'], { COMPOSE_FILE: 'compose.yaml' });
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain('refuses to start');
      expect(result.stderr).toContain('unexpected arguments: -f compose.override.yaml');
      expect(result.stderr).toContain('refused environment overrides: COMPOSE_FILE');
      expect(existsSync(witness)).toBe(false);
    });
  }

  test('scripts/run-facets.ts refuses a missing CLI', async () => {
    // PATH holds no facet CLI at all.
    const missing = await launch('scripts/run-facets.ts', [], {});
    expect(missing.code).not.toBe(0);
    expect(missing.stderr).toContain('not on PATH');
  });
});

describe('facet fixture guard', () => {
  test('refuses to run outside a launcher-provisioned scratch directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-runtime-facet-guard-'));
    try {
      expect(() => requireFacetFixture({})).toThrow();
      expect(() => requireFacetFixture({ FACET_FIXTURE_DIR: dir, FACET_FIXTURE_CLI: '/bin/true' })).toThrow();
      writeFileSync(join(dir, FACET_FIXTURE_MARKER), `${dir}\n`);
      expect(requireFacetFixture({ FACET_FIXTURE_DIR: dir, FACET_FIXTURE_CLI: '/bin/true' })).toEqual({
        scratch: dir,
        cli: '/bin/true',
      });
      expect(() => requireFacetFixture({ FACET_FIXTURE_DIR: repoRoot, FACET_FIXTURE_CLI: '/bin/true' })).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
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

describe('MCP fixture guard', () => {
  test('process suites accept only the launcher-built program directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-runtime-mcp-guard-'));
    try {
      expect(() => requireMcpFixture({})).toThrow('test:integration');
      expect(() => requireMcpFixture({ MCP_FIXTURE_PROGRAMS: dir })).toThrow();
      expect(() => requireMcpFixture({ MCP_FIXTURE_PROGRAMS: 'relative/dir' })).toThrow();
      writeFileSync(join(dir, MCP_FIXTURE_MARKER), `${dir}\n`);
      writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ version: 1, bun: Bun.version, programs: [] }));
      expect(requireMcpFixture({ MCP_FIXTURE_PROGRAMS: dir }).manifest.programs).toEqual([]);
      expect(() => requireMcpFixture({ MCP_FIXTURE_PROGRAMS: repoRoot })).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
