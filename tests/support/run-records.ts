// Raw record seeding for database-invariant tests. It deliberately bypasses the runtime's mutation layer so the
// schema itself is shown to accept consistent records and refuse inconsistent ones.
import type { SQL, TransactionSQL } from 'bun';
import { jsonText } from '../../packages/runtime/src/persistence/json.ts';
import { operationIdFor } from '../../packages/runtime/src/records/schemas.ts';

export const DIGEST = 'd'.repeat(64);
export const AT = '2026-09-29T12:00:00.000000Z';
type Tx = TransactionSQL;
const j = (value: unknown) => jsonText(value);

export const workspace = { id: 'main', label: 'Main workspace', root: '/workspace', policyDigest: DIGEST };
export const binding = {
  provider: 'anthropic',
  authMode: 'subscription',
  model: 'claude-test',
  profileId: 'anthropic.subscription.v1',
  credentialSlot: 'anthropic-default',
};

export async function currentEpoch(sql: SQL | Tx): Promise<string> {
  const [row] = await sql`select epoch::text as epoch from runtime.runtime_owner where singleton = 1`;
  return row.epoch as string;
}

export async function ensureDefinition(tx: Tx): Promise<void> {
  await tx`insert into runtime.execution_definitions (digest, manifest)
    values (${DIGEST}, ${j({ protocolVersion: 1 })}::text::jsonb) on conflict do nothing`;
}

export async function insertEvent(
  tx: Tx,
  runId: string,
  seq: number,
  kind: string,
  payload: unknown,
  sourceKey: string,
) {
  await tx`insert into runtime.events (run_id, seq, kind, payload, source_key)
    values (${runId}, ${seq}, ${kind}, ${j(payload)}::text::jsonb, ${sourceKey})`;
}

export interface SeededRun {
  runId: string;
  invocationId: string;
  epoch: string;
}

/** A newly created working run: definition, run, active initial invocation and its two creation events. */
export async function seedWorkingRun(tx: Tx, options: { budgetMax?: number } = {}): Promise<SeededRun> {
  const runId = crypto.randomUUID();
  const invocationId = crypto.randomUUID();
  const epoch = await currentEpoch(tx);
  await ensureDefinition(tx);
  const state = { kind: 'working', invocationId, ownerEpoch: epoch };
  await tx`insert into runtime.runs (run_id, create_request_id, input_digest, goal, workspace, binding,
      definition_digest, budget_max, state, revision, last_seq)
    values (${runId}, ${crypto.randomUUID()}, ${DIGEST}, 'Inspect the repository', ${j(workspace)}::text::jsonb,
      ${j(binding)}::text::jsonb, ${DIGEST}, ${options.budgetMax ?? 50}, ${j(state)}::text::jsonb, 1, 2)`;
  await tx`insert into runtime.invocations (run_id, invocation_id, owner_epoch, kind, disposition)
    values (${runId}, ${invocationId}, ${epoch}, 'initial', 'active')`;
  await insertEvent(
    tx,
    runId,
    1,
    'run.created',
    { requestId: crypto.randomUUID(), provider: 'anthropic', model: 'claude-test', budgetMax: options.budgetMax ?? 50 },
    'create',
  );
  await insertEvent(tx, runId, 2, 'run.status', { revision: '1', state }, 'status:1');
  return { runId, invocationId, epoch };
}

export interface SeededQuestion extends SeededRun {
  questionId: string;
  bindingDigest: string;
}

/** Moves a seeded working run to waiting on a pending question, as question publication would. */
export async function pauseOnQuestion(tx: Tx, run: SeededRun, callId = 'call-1'): Promise<SeededQuestion> {
  const questionId = operationIdFor(run.runId, `message-${callId}`, callId);
  const questionBinding = {
    threadId: run.runId,
    checkpointNs: '',
    checkpointId: 'checkpoint-1',
    taskId: 'task-1',
    interruptId: 'interrupt-1',
    ordinal: 0,
    operationId: questionId,
    payloadDigest: DIGEST,
    requiredStateDigest: DIGEST,
    definitionDigest: DIGEST,
  };
  const bindingDigest = 'b'.repeat(64);
  const input = {
    kind: 'choice',
    multiple: false,
    options: [
      { label: 'Yes', value: true },
      { label: 'No', value: false },
    ],
  };
  await tx`insert into runtime.tool_operations (run_id, operation_id, model_message_id, provider_tool_call_id,
      tool_name, arguments, argument_digest, disposition)
    values (${run.runId}, ${questionId}, ${`message-${callId}`}, ${callId}, 'mcp_AskUser',
      ${j({ prompt: 'Proceed?' })}::text::jsonb, ${DIGEST}, ${j({ kind: 'paused', questionId })}::text::jsonb)`;
  await tx`insert into runtime.questions (run_id, question_id, operation_id, prompt, input, binding, payload_digest,
      binding_digest, disposition)
    values (${run.runId}, ${questionId}, ${questionId}, 'Proceed?', ${j(input)}::text::jsonb,
      ${j(questionBinding)}::text::jsonb, ${DIGEST}, ${bindingDigest}, ${j({ kind: 'pending' })}::text::jsonb)`;
  await tx`update runtime.invocations set disposition = 'settled', ended_at = now()
    where run_id = ${run.runId} and invocation_id = ${run.invocationId}`;
  const state = { kind: 'waiting', questionId, bindingDigest };
  const [row] = await tx`update runtime.runs set state = ${j(state)}::text::jsonb,
      revision = revision + 1, last_seq = last_seq + 2 where run_id = ${run.runId}
    returning last_seq::int as last_seq, revision::text as revision`;
  await insertEvent(
    tx,
    run.runId,
    row.last_seq - 1,
    'question.asked',
    { questionId, prompt: 'Proceed?', input },
    `question:${questionId}`,
  );
  await insertEvent(
    tx,
    run.runId,
    row.last_seq,
    'run.status',
    { revision: row.revision, state },
    `status:${row.revision}`,
  );
  return { ...run, questionId, bindingDigest };
}

/** Accepts an answer and starts its continuation invocation, as answer acceptance would. */
export async function acceptAnswer(tx: Tx, question: SeededQuestion, answer: unknown): Promise<string> {
  const invocationId = crypto.randomUUID();
  const disposition = { kind: 'answered', answer, acceptedAt: AT, invocationId };
  await tx`update runtime.questions set disposition = ${j(disposition)}::text::jsonb
    where run_id = ${question.runId} and question_id = ${question.questionId}`;
  await tx`insert into runtime.invocations (run_id, invocation_id, owner_epoch, kind, question_id, disposition)
    values (${question.runId}, ${invocationId}, ${question.epoch}, 'answer', ${question.questionId}, 'active')`;
  const state = { kind: 'working', invocationId, ownerEpoch: question.epoch };
  const [row] = await tx`update runtime.runs set state = ${j(state)}::text::jsonb, revision = revision + 1,
      last_seq = last_seq + 2 where run_id = ${question.runId} returning last_seq::int as last_seq, revision::text as revision`;
  await insertEvent(
    tx,
    question.runId,
    row.last_seq - 1,
    'question.answered',
    { questionId: question.questionId, answer, invocationId, acceptedAt: AT },
    `answer:${question.questionId}`,
  );
  await insertEvent(
    tx,
    question.runId,
    row.last_seq,
    'run.status',
    { revision: row.revision, state },
    `status:${row.revision}`,
  );
  return invocationId;
}
