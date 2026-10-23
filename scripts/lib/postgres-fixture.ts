// A uniquely named, disposable PostgreSQL fixture on loopback for explicit suites: provisioned, used by one
// `bun test` run with an allowlisted environment, and removed — only what this launcher created.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FIXTURE_DATABASE_PREFIX, type IntegrationFixture } from '../../tests/support/integration-fixture.ts';
import { fixtureEnv, runCommand } from './fixture-env.ts';
import { repoRoot } from './workspace.ts';

/** Runs `bun test <suite>` against a fresh fixture database and returns its exit code. */
export async function runSuiteWithFixture(suite: string, label: string): Promise<number> {
  const id = crypto.randomUUID().replaceAll('-', '').slice(0, 12);
  const project = `agent-runtime-${label}-${id}`;
  const database = `${FIXTURE_DATABASE_PREFIX}${id}`;
  const password = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('hex');
  const fixtureDir = mkdtempSync(join(tmpdir(), `${project}-`));
  const envFile = join(fixtureDir, 'empty.env');
  await Bun.write(envFile, '');

  const composeEnv = fixtureEnv(process.env, { FIXTURE_DATABASE: database, FIXTURE_PASSWORD: password });
  const compose = [
    'docker',
    'compose',
    '--project-name',
    project,
    '--env-file',
    envFile,
    '-f',
    'tests/integration/compose.yaml',
  ];

  let exitCode = 1;
  try {
    await runCommand([...compose, 'up', '--detach', '--wait', '--wait-timeout', '120'], {
      env: composeEnv,
      cwd: repoRoot,
    });
    const published = (await runCommand([...compose, 'port', 'postgres', '5432'], { env: composeEnv, cwd: repoRoot }))
      .stdout;
    const port = /^127\.0\.0\.1:(\d+)$/m.exec(published)?.[1];
    if (port === undefined) throw new Error(`fixture database is not published on loopback: ${published.trim()}`);

    const fixture: IntegrationFixture = {
      project,
      databaseUrl: `postgres://agent_runtime_fixture:${password}@127.0.0.1:${port}/${database}`,
      token: crypto.randomUUID(),
    };
    const markerPath = join(fixtureDir, 'fixture.json');
    await Bun.write(markerPath, JSON.stringify(fixture));

    const tests = Bun.spawn(
      // The CLI ignore pattern replaces the root configuration, which excludes tests/** from ordinary runs.
      [process.execPath, '--no-env-file', 'test', '--path-ignore-patterns=**/node_modules/**', suite],
      {
        cwd: repoRoot,
        env: fixtureEnv(process.env, {
          INTEGRATION_FIXTURE_FILE: markerPath,
          INTEGRATION_DATABASE_URL: fixture.databaseUrl,
        }),
        stdout: 'inherit',
        stderr: 'inherit',
      },
    );
    exitCode = await tests.exited;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
  } finally {
    await runCommand([...compose, 'down', '--volumes', '--remove-orphans', '--timeout', '5'], {
      env: composeEnv,
      cwd: repoRoot,
      allowFailure: true,
    });
    rmSync(fixtureDir, { recursive: true, force: true });
  }
  return exitCode;
}
