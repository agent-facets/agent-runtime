// The live Anthropic acceptance trial's operator tool (task 12.8; run only under the allowance confirmed at task
// 12.11). It talks to the deployed runtime's API — never to Anthropic, whose requests the runtime makes and caps —
// and prints safe outcomes only.
//
//   bun run acceptance:anthropic -- check  --origin https://<tailnet name> [--trial <name>]
//   bun run acceptance:anthropic -- start  --origin https://<tailnet name> --trial <name>
//   bun run acceptance:anthropic -- report --origin https://<tailnet name> --journey <run> --cancel <run>
//
// `check` changes nothing. `start` starts (or finds) the trial's two runs; repeating it starts nothing new.
// `report` only reads the two runs `start` printed and states whether the trial's pass conditions hold.
import { parseArgs } from 'node:util';
import { ApiClient } from '../packages/ui/src/api/client.ts';
import {
  checkTrialDeployment,
  reportTrial,
  startTrialRuns,
  TRIAL,
  TrialRefused,
} from '../tests/acceptance/anthropic-trial.ts';

const USAGE =
  'usage: acceptance:anthropic <check|start> --origin https://<host> [--trial <name>] | report --origin https://<host> --journey <run> --cancel <run>';

const { positionals, values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    origin: { type: 'string' },
    trial: { type: 'string' },
    journey: { type: 'string' },
    cancel: { type: 'string' },
  },
  allowPositionals: true,
  strict: true,
});
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const [action] = positionals;
const origin = values.origin;
const trial = values.trial ?? 'g4';
if (
  positionals.length !== 1 ||
  (action !== 'check' && action !== 'start' && action !== 'report') ||
  origin === undefined ||
  !/^(?:https:\/\/[a-z0-9.-]+|http:\/\/(?:127\.0\.0\.1|localhost):\d{1,5})$/i.test(origin) ||
  !/^[a-z0-9-]{1,64}$/.test(trial) ||
  (action === 'report' && (!UUID.test(values.journey ?? '') || !UUID.test(values.cancel ?? '')))
) {
  console.error(USAGE);
  process.exit(2);
}

// The runtime accepts changes only from its own origin, as a browser on that page would send them.
const client = new ApiClient({
  base: origin,
  fetch: (input, init) =>
    fetch(input, { ...init, headers: { ...(init.headers as object), origin }, signal: AbortSignal.timeout(30_000) }),
});

try {
  await checkTrialDeployment(client);
  if (action === 'check') {
    console.log(
      `deployment ready for the trial: budget ${TRIAL.stepBudget} per run, ceiling ${TRIAL.requestCeiling} requests`,
    );
    process.exit(0);
  }
  if (action === 'start') {
    const runs = await startTrialRuns(client, trial);
    console.log(`journey run: ${origin}/#/runs/${runs.journey}`);
    console.log(`cancellation run: ${origin}/#/runs/${runs.cancel}`);
    process.exit(0);
  }
  const report = await reportTrial(client, { journey: values.journey as string, cancel: values.cancel as string });
  console.log(
    `model requests: journey ${report.requests.journey}, cancellation ${report.requests.cancel}, total ${report.requests.total} of ${TRIAL.requestCeiling}`,
  );
  for (const finding of report.findings) console.log(`finding: ${finding}`);
  console.log(report.passed ? 'trial conditions hold' : 'trial conditions do not hold');
  process.exit(report.passed ? 0 : 1);
} catch (error) {
  console.error(error instanceof TrialRefused ? `refused: ${error.message}` : 'the trial tool failed');
  process.exit(1);
}
