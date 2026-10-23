// The first phase of the real-MCP restart witnesses, run in its own process: it starts the command run through the
// production API, waits until the run asks its first question, reports, and waits to be killed. `SCENARIO_KIND`
// selects the retention witness's replies instead of the delegate witness's.
// Synthetic inputs only; launched by tests/integration/mcp-delegate-restart.integration.test.ts.
import { openPersistence } from '../../packages/runtime/src/persistence/persistence.ts';
import { type Provider, phaseReplies, retentionReplies, SCENARIO } from './mcp-delegate-scenario.ts';
import { mcpService, SLOT_VALUE } from './mcp-service.ts';

/** Reports to the parent; a report carrying the server's credential is replaced, never printed. */
const report = (value: Record<string, unknown>) => {
  const line = JSON.stringify(value);
  process.stdout.write(
    line.includes(SLOT_VALUE)
      ? `${JSON.stringify({ w: 'child-error', message: 'a report carried the credential' })}\n`
      : `${line}\n`,
  );
};
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
    replies: process.env.SCENARIO_KIND === 'retention' ? retentionReplies(provider, 1) : phaseReplies(provider, 1),
  });
  const started = await h.startApi('owner/repo-a');
  if (started.status !== 202) throw new Error(`start refused: ${started.status}`);
  const runId = started.body.run.runId as string;
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
