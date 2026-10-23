// Explicit integration launcher. Provisions a uniquely named, disposable PostgreSQL fixture on loopback, builds the
// synthetic MCP server programs into a disposable directory, runs the integration suites against them with an
// allowlisted environment, and removes only what it created.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPrograms } from '../packages/mcp-programs/src/builder.ts';
import { SYNTHETIC_PROGRAMS } from '../packages/mcp-programs/test-support/programs.ts';
import { MCP_FIXTURE_MARKER } from '../tests/support/mcp-fixture.ts';
import { assertSafeLaunch } from './lib/fixture-env.ts';
import { runSuiteWithFixture } from './lib/postgres-fixture.ts';
import { repoRoot } from './lib/workspace.ts';

assertSafeLaunch('test:integration', process.argv.slice(2), process.env);

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
  exitCode = await runSuiteWithFixture('./tests/integration', 'it', { MCP_FIXTURE_PROGRAMS: programs });
} finally {
  rmSync(programs, { recursive: true, force: true });
}
process.exit(exitCode);
