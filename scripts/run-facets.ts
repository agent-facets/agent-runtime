// Explicit facet-export launcher. Refuses an unsafe environment or an unpinned facet CLI before anything is installed,
// builds the runtime adapter, then runs only tests/facets/*.facet.test.ts with disposable runtime/editor homes and an
// allowlisted environment. Nothing is downloaded or repaired; no model, server or owner facet home is used.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ToolchainError, verifyPinnedCli } from '../packages/facet-adapter/src/toolchain.ts';
import { FACET_FIXTURE_MARKER } from '../tests/support/facet-fixture.ts';
import { assertSafeLaunch, fixtureEnv, runCommand } from './lib/fixture-env.ts';
import { repoRoot } from './lib/workspace.ts';

assertSafeLaunch('test:facets', process.argv.slice(2), process.env);

const binary = Bun.which('facet', { PATH: process.env.PATH ?? '' });
if (binary === null) {
  console.error(
    'test:facets refuses to start: the pinned facet CLI is not on PATH. It is never installed automatically.',
  );
  process.exit(1);
}
try {
  await verifyPinnedCli(binary);
} catch (error) {
  if (!(error instanceof ToolchainError)) throw error;
  console.error(`test:facets refuses to start: ${error.message}. It is never replaced automatically.`);
  process.exit(1);
}

const scratch = mkdtempSync(join(tmpdir(), 'agent-runtime-facets-'));
try {
  writeFileSync(join(scratch, FACET_FIXTURE_MARKER), `${scratch}\n`);
  const env = fixtureEnv(process.env, {
    HOME: join(scratch, 'home'),
    FACET_FIXTURE_DIR: scratch,
    FACET_FIXTURE_CLI: binary,
  });
  await runCommand([process.execPath, 'run', '--cwd', 'packages/facet-adapter', 'build'], { env, cwd: repoRoot });
  const tests = Bun.spawn(
    // The CLI ignore pattern replaces the root configuration, which excludes tests/** from ordinary runs.
    [process.execPath, '--no-env-file', 'test', '--path-ignore-patterns=**/node_modules/**', './tests/facets/'],
    { cwd: repoRoot, env, stdout: 'inherit', stderr: 'inherit' },
  );
  process.exitCode = await tests.exited;
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
