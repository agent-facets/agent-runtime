// Explicit browser-journey launcher: the console in a real (headless) browser against the runtime's service on a
// disposable PostgreSQL fixture, with scripted provider networks and the synthetic MCP server programs built into a
// disposable directory. Requires the pinned Playwright browser, installed once with `bun run browser:install`;
// nothing is downloaded here. The suites launch the only browser, so a missing one is reported from there.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPrograms } from '../packages/mcp-programs/src/builder.ts';
import { SYNTHETIC_PROGRAMS } from '../packages/mcp-programs/test-support/programs.ts';
import { MCP_FIXTURE_MARKER } from '../tests/support/mcp-fixture.ts';
import { assertSafeLaunch } from './lib/fixture-env.ts';
import { runSuiteWithFixture } from './lib/postgres-fixture.ts';
import { repoRoot } from './lib/workspace.ts';

assertSafeLaunch('test:browser', process.argv.slice(2), process.env);

const programs = mkdtempSync(join(tmpdir(), 'agent-runtime-mcp-programs-'));
let exitCode = 1;
try {
  await buildPrograms({
    programs: SYNTHETIC_PROGRAMS,
    packageRoot: join(repoRoot, 'packages', 'mcp-programs'),
    outDir: programs,
    lockfile: join(repoRoot, 'bun.lock'),
  });
  writeFileSync(join(programs, MCP_FIXTURE_MARKER), `${programs}\n`);
  exitCode = await runSuiteWithFixture('./tests/browser', 'it-browser', { MCP_FIXTURE_PROGRAMS: programs });
} finally {
  rmSync(programs, { recursive: true, force: true });
}
process.exit(exitCode);
