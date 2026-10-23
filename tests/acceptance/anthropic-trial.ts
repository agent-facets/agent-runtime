// The bounded Anthropic acceptance trial (task 12.8), shared by its offline rehearsal (scripted provider, the
// browser suite) and the live trial the owner runs after fresh authorization (task 12.11). Both use the same
// fixture content, the same two runs and the same pass conditions; only the provider behind the runtime differs.
//
// The cap is enforced by the runtime itself, not by this tooling: the trial deployment's configuration sets each
// run's budget to TRIAL.stepBudget and a deployment-wide ceiling of TRIAL.requestCeiling model requests, both
// durable across restarts. Retries count against them. This module only refuses to proceed against a deployment
// that is not configured that way, starts at most the two trial runs (by fixed request IDs, so repeating a step
// never starts another), and reports what happened.
import type { Options, RunEvent, RunSnapshot } from '../../packages/contracts/src/index.ts';
import type { ApiClient } from '../../packages/ui/src/api/client.ts';

export const TRIAL = Object.freeze({
  provider: 'anthropic' as const,
  stepBudget: 6,
  requestCeiling: 12,
  note: Object.freeze({
    path: 'acceptance/trial-note.md',
    content:
      '# Acceptance trial note\n\nThis synthetic note exists only for the runtime acceptance trial.\n\n' +
      'Release checklist: 1. build the image; 2. run the checks; 3. publish the notes.\n',
  }),
  journeyGoal:
    'Read the file acceptance/trial-note.md in the workspace. Then use the question tool to ask me exactly one ' +
    'yes/no question: whether to list the checklist steps. After my answer, reply in one or two sentences that ' +
    'respect it. Do not read any other file.',
  cancelGoal:
    'Without reading any file, use the question tool to ask me one yes/no question: whether I am ready. Then wait for my answer.',
});

/** The trial deployment's operator configuration (container paths), for the owner to mount. */
export function trialOperatorConfig(model: string, credentialSlot = 'default') {
  return {
    version: 1,
    workspace: { id: 'trial', label: 'Acceptance trial', root: '/workspace' },
    providers: { anthropic: { authMode: 'subscription', model, profileId: 'claude-cli-2.1.280', credentialSlot } },
    defaultProvider: 'anthropic',
    stepBudget: TRIAL.stepBudget,
    modelRequestCeiling: TRIAL.requestCeiling,
  };
}

/** Request IDs derived from the trial's name: the same trial always names the same two runs. */
export async function trialRequestIds(trial: string): Promise<{ journey: string; cancel: string }> {
  const id = async (role: string) => {
    const digest = new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`agent-runtime acceptance ${trial} ${role}`)),
    );
    digest[6] = ((digest[6] ?? 0) & 0x0f) | 0x40;
    digest[8] = ((digest[8] ?? 0) & 0x3f) | 0x80;
    const hex = [...digest.slice(0, 16)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
  };
  return { journey: await id('journey'), cancel: await id('cancel') };
}

export class TrialRefused extends Error {
  override readonly name = 'TrialRefused';
}

/** Refuses a deployment whose limits, provider or workspace are not the trial's. */
export async function checkTrialDeployment(client: ApiClient): Promise<Options> {
  const options = await client.options();
  if (!options.ok) throw new TrialRefused('the runtime’s options could not be read');
  const { value } = options;
  const anthropic = value.providers.find((entry) => entry.provider === TRIAL.provider);
  const problems = [
    value.defaultBudget !== TRIAL.stepBudget && `the step budget is ${value.defaultBudget}, not ${TRIAL.stepBudget}`,
    value.modelRequestCeiling !== TRIAL.requestCeiling &&
      `the model-request ceiling is ${value.modelRequestCeiling ?? 'unset'}, not ${TRIAL.requestCeiling}`,
    anthropic === undefined && 'Anthropic is not configured',
    anthropic !== undefined && anthropic.readiness !== 'ready' && `Anthropic is ${anthropic.readiness}`,
    !value.workspace.available && 'the workspace is not available',
  ].filter((problem): problem is string => typeof problem === 'string');
  if (problems.length > 0) throw new TrialRefused(problems.join('; '));
  return value;
}

/** Starts the two trial runs, or finds them if they were already started. Never starts a third. */
export async function startTrialRuns(client: ApiClient, trial: string): Promise<{ journey: string; cancel: string }> {
  const ids = await trialRequestIds(trial);
  const start = async (requestId: string, goal: string) => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const outcome = await client.startRun({ requestId, goal, provider: TRIAL.provider });
      if (outcome.ok) return outcome.value.run.runId;
      // A lost reply is retried with the same request ID; anything definite stops the trial.
      if (outcome.kind === 'refused' && outcome.error.acceptance !== 'unknown') {
        throw new TrialRefused(`starting a trial run was refused: ${outcome.error.message}`);
      }
    }
    throw new TrialRefused('starting a trial run did not get a reply');
  };
  return { journey: await start(ids.journey, TRIAL.journeyGoal), cancel: await start(ids.cancel, TRIAL.cancelGoal) };
}

export interface TrialReport {
  passed: boolean;
  /** Model requests charged to each run: confirmed sent plus admitted but unconfirmed. */
  requests: { journey: number; cancel: number; total: number };
  findings: string[];
}

async function history(client: ApiClient, runId: string): Promise<{ snapshot: RunSnapshot; events: RunEvent[] }> {
  const snapshot = await client.run(runId);
  if (!snapshot.ok) throw new TrialRefused('a trial run could not be read');
  const events: RunEvent[] = [];
  let after = '0';
  while (BigInt(after) < BigInt(snapshot.value.throughSeq)) {
    const page = await client.events(runId, { after, through: snapshot.value.throughSeq });
    if (!page.ok) throw new TrialRefused('a trial run’s history could not be read');
    events.push(...page.value.events);
    if (page.value.events.length === 0) break;
    after = page.value.nextAfter;
  }
  return { snapshot: snapshot.value, events };
}

/**
 * The trial's pass conditions, from recorded history only: the journey read the note, asked one question, had
 * `false` accepted and finished with a result; the other run was cancelled while its question was pending and
 * stayed cancelled; and the requests charged stay within the cap.
 */
export async function reportTrial(client: ApiClient, runs: { journey: string; cancel: string }): Promise<TrialReport> {
  const journey = await history(client, runs.journey);
  const cancel = await history(client, runs.cancel);
  const charged = (snapshot: RunSnapshot) => snapshot.run.budget.consumed + snapshot.run.budget.unconfirmed;
  const requests = {
    journey: charged(journey.snapshot),
    cancel: charged(cancel.snapshot),
    total: charged(journey.snapshot) + charged(cancel.snapshot),
  };
  const findings: string[] = [];
  const kinds = (events: RunEvent[]) => events.map((event) => event.kind);
  const read = journey.events.some(
    (event) =>
      event.kind === 'tool.operation' &&
      event.payload.toolName === 'mcp_Read' &&
      event.payload.disposition.kind === 'completed' &&
      event.payload.disposition.outcome === 'ok',
  );
  if (!read) findings.push('the journey did not complete a workspace read');
  const asked = journey.events.filter((event) => event.kind === 'question.asked');
  if (asked.length !== 1) findings.push(`the journey asked ${asked.length} questions, not one`);
  const answered = journey.events.find((event) => event.kind === 'question.answered');
  if (answered?.kind !== 'question.answered' || answered.payload.answer !== false) {
    findings.push('the journey’s question was not answered with false');
  }
  if (journey.snapshot.run.state.kind !== 'succeeded')
    findings.push(`the journey is ${journey.snapshot.run.state.kind}`);
  if (cancel.snapshot.run.state.kind !== 'cancelled')
    findings.push(`the second run is ${cancel.snapshot.run.state.kind}`);
  if (!kinds(cancel.events).includes('question.closed')) findings.push('the second run’s question was not closed');
  if (requests.total > TRIAL.requestCeiling) findings.push(`${requests.total} model requests exceed the cap`);
  return { passed: findings.length === 0, requests, findings };
}
