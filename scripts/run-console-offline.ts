// The browser console on your machine with nothing real behind it: a disposable PostgreSQL fixture, a synthetic
// workspace, a synthetic credential and a scripted model (tests/support/scripted-agent.ts). No provider is
// contacted and no owner state, workspace or credential is read. Open the printed address on this machine; stop
// with Ctrl+C, which removes everything the launcher created.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openPersistence } from '../packages/runtime/src/persistence/persistence.ts';
import { createFixture } from '../packages/runtime/test-support/workspace.ts';
import { consoleServer } from '../tests/support/console-server.ts';
import { scriptedAgent } from '../tests/support/scripted-agent.ts';
import { assertSafeLaunch } from './lib/fixture-env.ts';
import { withFixtureDatabase } from './lib/postgres-fixture.ts';

/** Preferred port, so the address stays the same between sessions; any free port if it is taken. */
const PREFERRED_PORT = 4310;

assertSafeLaunch('console:offline', process.argv.slice(2), process.env);

const stopped = new Promise<void>((resolve) => {
  process.once('SIGINT', resolve);
  process.once('SIGTERM', resolve);
});

process.exit(
  await withFixtureDatabase('console', async ({ databaseUrl }) => {
    const workspace = createFixture();
    workspace.write('README.md', '# Synthetic workspace\n\nOnly for the offline console.\n');
    workspace.write('notes/plan.md', '# Plan\n\n1. Build the image.\n2. Run the checks.\n3. Publish the notes.\n');
    const scratch = mkdtempSync(join(tmpdir(), 'agent-runtime-console-'));
    const persistence = await openPersistence({ url: databaseUrl, onFault: () => {} });
    const start = (port: number) =>
      consoleServer({ persistence, scratch, workspaceRoot: workspace.root, replies: scriptedAgent, port });
    const server = await start(PREFERRED_PORT).catch(() => start(0));
    try {
      console.log(`offline console: ${server.url}/`);
      console.log('scripted model; no provider is contacted. Press Ctrl+C to stop and remove everything.');
      await stopped;
      return 0;
    } finally {
      await server.stop();
      await persistence.close();
      workspace.cleanup();
      rmSync(scratch, { recursive: true, force: true });
    }
  }),
);
