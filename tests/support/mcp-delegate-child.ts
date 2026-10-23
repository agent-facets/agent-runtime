// The first phase of the real-MCP delegate restart witness, run in its own process: it starts the command run through
// the production service and waits until the delegate asks its first question, reports, and waits to be killed.
// Synthetic inputs only; launched by tests/integration/mcp-delegate-restart.integration.test.ts.
import { openPersistence } from '../../packages/runtime/src/persistence/persistence.ts';
import { type Provider, phaseReplies, SCENARIO } from './mcp-delegate-scenario.ts';
import { mcpService } from './mcp-service.ts';

const report = (value: Record<string, unknown>) => process.stdout.write(`${JSON.stringify(value)}\n`);
try {
  const provider = process.env.SCENARIO_PROVIDER as Provider;
  const persistence = await openPersistence({ url: process.env.SCENARIO_DATABASE_URL as string, onFault: () => {} });
  const h = await mcpService({
    scratch: process.env.SCENARIO_SCRATCH as string,
    persistence,
    provider,
    grants: [...SCENARIO.grants],
    allowAgents: [...SCENARIO.allowAgents],
    allowSkills: [...SCENARIO.allowSkills],
    replies: phaseReplies(provider, 1),
  });
  const started = await h.start('owner/repo-a');
  const runId = (started.body as { run: { runId: string } }).run.runId;
  await h.service.settled();
  const snapshot = await h.service.store.snapshot(runId);
  report({
    w: 'barrier',
    runId,
    state: snapshot.state.kind,
    stateDir: h.stateDir,
    sent: h.net.sent.length,
    requests: h.net.sent,
  });
  await new Promise(() => {});
} catch (error) {
  report({ w: 'child-error', message: error instanceof Error ? error.message : String(error) });
  process.exit(1);
}
