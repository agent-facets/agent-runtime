// Synthetic capability records for persistence tests: a valid retained snapshot, raw command-run seeding and
// delegate seeding that bypass the runtime's mutation layer, so the schema itself is shown to accept consistent
// capability records and refuse inconsistent ones. Nothing here is a real facet, grant or credential.
import type { TransactionSQL } from 'bun';
import { type CommandRunInput, sealSnapshot } from '../../packages/runtime/src/capabilities/records.ts';
import { jsonText } from '../../packages/runtime/src/persistence/json.ts';
import { operationIdV2 } from '../../packages/runtime/src/records/schemas.ts';
import { DIGEST, type SeededRun, seedWorkingRun } from './run-records.ts';

const j = (value: unknown) => jsonText(value);
const origin = { facet: 'fixture-workflows', version: '0.0.1', source: 'local:fixture', integrity: `sha256-${DIGEST}` };

export function sampleSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    profile: 1,
    installation: { sha256: DIGEST },
    command: {
      id: 'command:triage',
      name: 'triage',
      description: 'Triage a repository.',
      origins: [origin],
      exportDigest: DIGEST,
      requires: [{ kind: 'skill', id: 'skill:review' }],
      body: 'Triage $ARGUMENTS',
      arguments: { required: true },
    },
    input: { arguments: 'owner/repo-a', renderedGoal: 'Triage owner/repo-a' },
    skills: [
      {
        id: 'skill:review',
        name: 'review',
        description: 'Reviews findings.',
        origins: [origin],
        exportDigest: DIGEST,
        requires: [],
        instructions: 'Review carefully.',
        resources: [],
      },
    ],
    agents: [
      {
        id: 'agent:helper',
        name: 'helper',
        description: 'Answers one bounded task.',
        origins: [origin],
        exportDigest: DIGEST,
        requires: [],
        instructions: 'Do the task.',
      },
    ],
    servers: [],
    tools: [],
    authority: {
      native: ['mcp_Read', 'mcp_Search', 'mcp_AskUser'],
      skills: ['skill:review'],
      agents: ['agent:helper'],
      servers: [],
    },
    limits: { maxDelegations: 8, delegationDepth: 1 },
    ...overrides,
  };
}

export const sampleCommandInput = (overrides: Partial<CommandRunInput> = {}): CommandRunInput => ({
  kind: 'command',
  commandId: 'command:triage',
  selectionRevision: DIGEST,
  arguments: 'owner/repo-a',
  provider: 'anthropic',
  ...overrides,
});

/** Appends one event at the next sequence, as the runtime's run-locked append would. */
export async function appendEvent(
  tx: TransactionSQL,
  runId: string,
  kind: string,
  payload: unknown,
  sourceKey: string,
) {
  const [row] =
    await tx`update runtime.runs set last_seq = last_seq + 1 where run_id = ${runId} returning last_seq::int as seq`;
  await tx`insert into runtime.events (run_id, seq, kind, payload, source_key)
    values (${runId}, ${row.seq}, ${kind}, ${j(payload)}::text::jsonb, ${sourceKey})`;
  return row.seq as number;
}

export interface SeededCommandRun extends SeededRun {
  snapshotDigest: string;
}

/** A working command run: the seeded native run plus its retained snapshot, binding and recorded selection. */
export async function seedCommandRun(
  tx: TransactionSQL,
  options: { maxDelegations?: number; event?: boolean } = {},
): Promise<SeededCommandRun> {
  const run = await seedWorkingRun(tx);
  const sealed = sealSnapshot(sampleSnapshot());
  await tx`insert into runtime.capability_snapshots (digest, payload)
    values (${sealed.digest}, ${sealed.canonical}::text::jsonb) on conflict do nothing`;
  const input = sampleCommandInput();
  await tx`insert into runtime.run_capabilities (run_id, input, snapshot_digest, max_delegations)
    values (${run.runId}, ${j(input)}::text::jsonb, ${sealed.digest}, ${options.maxDelegations ?? 8})`;
  if (options.event !== false) {
    await appendEvent(
      tx,
      run.runId,
      'run.command',
      {
        commandId: input.commandId,
        selectionRevision: input.selectionRevision,
        arguments: input.arguments,
        snapshotDigest: sealed.digest,
      },
      'command',
    );
  }
  return { ...run, snapshotDigest: sealed.digest };
}

/** The root's version-2 delegation operation and the active delegate it starts. Returns the delegation ID. */
export async function startDelegate(
  tx: TransactionSQL,
  run: SeededRun,
  callId: string,
  agentId = 'agent:helper',
): Promise<string> {
  const delegationId = operationIdV2(run.runId, 'root', `message-${callId}`, callId);
  await tx`insert into runtime.tool_operations (run_id, operation_id, model_message_id, provider_tool_call_id,
      tool_name, arguments, argument_digest, disposition, identity_version, actor_key, tool_binding)
    values (${run.runId}, ${delegationId}, ${`message-${callId}`}, ${callId}, 'mcp_Delegate',
      ${j({ agent: agentId, task: 'Look.' })}::text::jsonb, ${DIGEST}, ${j({ kind: 'started' })}::text::jsonb, 2, 'root',
      ${j({ kind: 'delegation', agentId })}::text::jsonb)`;
  await tx`insert into runtime.run_actors (run_id, actor_key, kind, parent_actor, agent_id, task_digest, checkpoint_ns, state)
    values (${run.runId}, ${delegationId}, 'delegate', 'root', ${agentId}, ${DIGEST}, ${`tools:${callId}`},
      ${j({ kind: 'active' })}::text::jsonb)`;
  return delegationId;
}

/**
 * Moves a working command run to waiting on a question asked by a newly started delegate, as delegated-question
 * publication would: the delegate's question operation pauses, the version-2 delegate binding is recorded and,
 * unless `waiting` is false (to exercise the refusal), the delegate waits on it.
 */
export async function askFromDelegate(
  tx: TransactionSQL,
  run: SeededRun,
  options: { waiting?: boolean; callId?: string } = {},
): Promise<{ delegationId: string; questionId: string }> {
  const delegationId = await startDelegate(tx, run, options.callId ?? 'call-d');
  const questionId = await insertOperation(tx, run.runId, {
    actorKey: delegationId,
    callId: 'ask-1',
    toolName: 'mcp_AskUser',
    binding: { kind: 'native', name: 'mcp_AskUser' },
  });
  await tx`update runtime.tool_operations set disposition = ${j({ kind: 'paused', questionId })}::text::jsonb
    where run_id = ${run.runId} and operation_id = ${questionId}`;
  const binding = {
    version: 2,
    actor: 'delegate',
    delegationId,
    agentId: 'agent:helper',
    threadId: run.runId,
    checkpointNs: 'tools:call-d',
    checkpointId: 'child-checkpoint',
    taskId: 'child-task',
    interruptId: 'interrupt-1',
    operationId: questionId,
    payloadDigest: DIGEST,
    requiredStateDigest: DIGEST,
    definitionDigest: DIGEST,
    parent: { checkpointNs: '', checkpointId: 'root-checkpoint', taskId: 'root-task', operationId: delegationId },
  };
  await tx`insert into runtime.questions (run_id, question_id, operation_id, prompt, input, binding, payload_digest,
      binding_digest, disposition, actor_key)
    values (${run.runId}, ${questionId}, ${questionId}, 'Proceed?', ${j({ kind: 'text', minLength: 0, maxLength: 5 })}::text::jsonb,
      ${j(binding)}::text::jsonb, ${DIGEST}, ${DIGEST}, ${j({ kind: 'pending' })}::text::jsonb, ${delegationId})`;
  if (options.waiting !== false) {
    await tx`update runtime.run_actors set state = ${j({ kind: 'waiting', questionId })}::text::jsonb
      where run_id = ${run.runId} and actor_key = ${delegationId}`;
  }
  await tx`update runtime.invocations set disposition = 'settled', ended_at = now()
    where run_id = ${run.runId} and invocation_id = ${run.invocationId}`;
  const state = { kind: 'waiting', questionId, bindingDigest: DIGEST };
  const [row] = await tx`update runtime.runs set state = ${j(state)}::text::jsonb, revision = revision + 1
    where run_id = ${run.runId} returning revision::text as revision`;
  await appendEvent(tx, run.runId, 'run.status', { revision: row.revision, state }, `status:${row.revision}`);
  return { delegationId, questionId };
}

/** A version-2 operation issued by an actor. */
export async function insertOperation(
  tx: TransactionSQL,
  runId: string,
  options: {
    actorKey: string;
    callId: string;
    messageId?: string;
    toolName?: string;
    binding?: unknown;
    disposition?: unknown;
  },
): Promise<string> {
  const messageId = options.messageId ?? `message-${options.callId}`;
  const operationId = operationIdV2(runId, options.actorKey, messageId, options.callId);
  await tx`insert into runtime.tool_operations (run_id, operation_id, model_message_id, provider_tool_call_id,
      tool_name, arguments, argument_digest, disposition, identity_version, actor_key, tool_binding)
    values (${runId}, ${operationId}, ${messageId}, ${options.callId}, ${options.toolName ?? 'mcp_Read'}, '{}'::jsonb,
      ${DIGEST}, ${j(options.disposition ?? { kind: 'started' })}::text::jsonb, 2, ${options.actorKey},
      ${options.binding === undefined ? null : j(options.binding)}::text::jsonb)`;
  return operationId;
}
