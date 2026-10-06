// The live acceptance trial's operator tool (task 12.8; run only under a fresh, bounded allowance). It talks to the
// deployed runtime's API — never to a provider, whose requests the runtime makes and caps — and prints safe
// outcomes only. The origin is the console's address: loopback for the local trial, or the tailnet name behind
// Serve. The provider defaults to Anthropic; `--provider openai --ceiling <n>` runs the same trial against OpenAI
// on a deployment whose ceiling is <n> (requests already used plus the trial's allowance).
//
//   bun run acceptance:anthropic -- check  --origin <origin> [--provider <p> --ceiling <n>] [--trial <name>]
//   bun run acceptance:anthropic -- start  --origin <origin> --trial <name> [--provider <p> --ceiling <n>]
//                                          [--run <journey|cancel>]
//   bun run acceptance:anthropic -- report --origin <origin> --journey <run> --cancel <run> [--provider <p> --ceiling <n>]
//                                          [--expected-answer <false|no>]
//
// `check` changes nothing. `start` starts (or finds) the trial's two runs, or only the one `--run` names; repeating
// it starts nothing new. `report` only reads the two runs `start` printed and states whether the pass conditions
// hold. The journey's answer must be the boolean `false`, or the string "no" with `--expected-answer no` when the
// question declared that value. Its request count is a subtotal of those two runs only.
import { parseArgs } from 'node:util';
import { ApiClient } from '../packages/ui/src/api/client.ts';
import {
  checkTrialDeployment,
  reportTrial,
  startTrialRun,
  TRIAL,
  TrialRefused,
} from '../tests/acceptance/anthropic-trial.ts';

const USAGE =
  'usage: acceptance:anthropic <check|start> --origin <https://host | http://127.0.0.1:port> [--trial <name>] [--run <journey|cancel>] | report --origin <origin> --journey <run> --cancel <run> [--expected-answer <false|no>]; each with [--provider <anthropic|openai> --ceiling <n>]';

const { positionals, values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    origin: { type: 'string' },
    trial: { type: 'string' },
    journey: { type: 'string' },
    cancel: { type: 'string' },
    provider: { type: 'string' },
    ceiling: { type: 'string' },
    run: { type: 'string' },
    'expected-answer': { type: 'string' },
  },
  allowPositionals: true,
  strict: true,
});
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const [action] = positionals;
const origin = values.origin;
const trial = values.trial ?? 'g4';
const provider = values.provider ?? TRIAL.provider;
const ceiling = values.ceiling === undefined ? TRIAL.requestCeiling : Number(values.ceiling);
const expectedAnswer = values['expected-answer'];
if (
  positionals.length !== 1 ||
  (action !== 'check' && action !== 'start' && action !== 'report') ||
  origin === undefined ||
  !/^(?:https:\/\/[a-z0-9.-]+|http:\/\/(?:127\.0\.0\.1|localhost):\d{1,5})$/i.test(origin) ||
  !/^[a-z0-9-]{1,64}$/.test(trial) ||
  (provider !== 'anthropic' && provider !== 'openai') ||
  !Number.isInteger(ceiling) ||
  ceiling < 1 ||
  (values.run !== undefined && (action !== 'start' || (values.run !== 'journey' && values.run !== 'cancel'))) ||
  (expectedAnswer !== undefined && (action !== 'report' || (expectedAnswer !== 'false' && expectedAnswer !== 'no'))) ||
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
  await checkTrialDeployment(client, { provider, requestCeiling: ceiling });
  if (action === 'check') {
    console.log(
      `deployment ready for the ${provider} trial: budget ${TRIAL.stepBudget} per run, ceiling ${ceiling} requests`,
    );
    process.exit(0);
  }
  if (action === 'start') {
    if (values.run !== 'cancel') {
      console.log(`journey run: ${origin}/#/runs/${await startTrialRun(client, trial, 'journey', provider)}`);
    }
    if (values.run !== 'journey') {
      console.log(`cancellation run: ${origin}/#/runs/${await startTrialRun(client, trial, 'cancel', provider)}`);
    }
    process.exit(0);
  }
  const report = await reportTrial(
    client,
    { journey: values.journey as string, cancel: values.cancel as string },
    provider,
    expectedAnswer === 'no' ? 'no' : false,
  );
  console.log(
    `model requests: journey ${report.requests.journey}, cancellation ${report.requests.cancel}, named-run subtotal ${report.requests.total} of ${TRIAL.requestCeiling} (these two runs only; other runs count against the deployment's ceiling)`,
  );
  for (const finding of report.findings) console.log(`finding: ${finding}`);
  console.log(report.passed ? 'trial conditions hold' : 'trial conditions do not hold');
  process.exit(report.passed ? 0 : 1);
} catch (error) {
  console.error(error instanceof TrialRefused ? `refused: ${error.message}` : 'the trial tool failed');
  process.exit(1);
}
