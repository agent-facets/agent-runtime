// Read-only inspection of a run's saved graph state (Decisions 6 and 7). Inspection never invokes the graph.
//
// A pending question is accepted as saved only when the saved head has a usable messages channel, exactly one
// pending interrupt, raised by the sole question call of the latest model message, whose payload is a valid
// question with the expected identity. The required-state digest covers the saved head's channel values and
// versions, its pending writes and its pending tasks/interrupts, in a canonical form that keeps message types,
// IDs, content, tool calls and provider replay metadata. A value this runtime cannot represent canonically makes
// the state unusable rather than silently dropped.
//
// Outcomes distinguish a confirmed problem (`missing`, `unusable`) from a failure to look (`unavailable`): only
// the former may close a question.
import { AIMessage, BaseMessage } from '@langchain/core/messages';
import type { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint';
import { canonicalJson, digestOf } from '../records/canonical.ts';
import { operationIdV2, type QuestionBinding, questionDefinitionSchema } from '../records/schemas.ts';
import { agentScope, type ExecutionAgent } from './agent.ts';
import { DELEGATE_TOOL } from './delegation.ts';
import { ASK_TOOL, callOperationId, QUESTION_PROTOCOL_VERSION, type QuestionPayload } from './tools.ts';

export interface SavedQuestion {
  checkpointNs: string;
  checkpointId: string;
  taskId: string;
  interruptId: string;
  payload: QuestionPayload;
  requiredStateDigest: string;
}

export type UnusableReason =
  | 'messages_unusable'
  | 'no_pending_question'
  | 'ambiguous_interrupt'
  | 'question_mismatch'
  | 'unsupported_value';

export type SavedStateInspection =
  | { kind: 'question'; question: SavedQuestion }
  | { kind: 'missing' }
  | { kind: 'unusable'; reason: UnusableReason }
  | { kind: 'unavailable' };

class Unsupported extends Error {}

/**
 * Canonical form of saved values. Messages become their type and complete stored data; plain JSON stays as is;
 * anything else (dates, maps, class instances, functions, non-finite numbers) is unsupported.
 */
export function canonicalSavedValue(value: unknown, depth = 0): unknown {
  if (depth > 64) throw new Unsupported('nesting');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Unsupported('number');
    return value;
  }
  if (value === undefined) return { $undefined: true };
  if (BaseMessage.isInstance(value)) {
    const stored = value.toDict();
    return { $message: stored.type, data: canonicalSavedValue(JSON.parse(JSON.stringify(stored.data)), depth + 1) };
  }
  if (Array.isArray(value)) return value.map((item) => canonicalSavedValue(item, depth + 1));
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        canonicalSavedValue(item, depth + 1),
      ]),
    );
  }
  throw new Unsupported(typeof value);
}

interface Snapshot {
  values: Record<string, unknown>;
  next: readonly string[];
  config: { configurable?: Record<string, unknown> };
  tasks: readonly { id: string; name: string; interrupts: readonly { id?: string; value?: unknown }[] }[];
}

/**
 * Inspects the latest saved head of a run for its pending question. `expectedQuestionId`, when given, must match
 * the saved question.
 */
export async function inspectSavedQuestion(
  agent: ExecutionAgent,
  saver: BaseCheckpointSaver,
  runId: string,
  expectedQuestionId?: string,
): Promise<SavedStateInspection> {
  const head = await readHead(agent, saver, runId, '');
  if (head.kind !== 'head') return head;
  return classifySavedQuestion(runId, head.snapshot, head.tuple, expectedQuestionId);
}

type SavedTuple = { checkpoint: { channel_values: unknown; channel_versions: unknown }; pendingWrites?: unknown };

/** The latest saved head of a graph at a checkpoint namespace, read without invoking it. */
async function readHead(
  agent: ExecutionAgent,
  saver: BaseCheckpointSaver,
  runId: string,
  checkpointNs: string,
): Promise<{ kind: 'head'; snapshot: Snapshot; tuple: SavedTuple } | { kind: 'missing' } | { kind: 'unavailable' }> {
  let snapshot: Snapshot;
  let tuple: Awaited<ReturnType<BaseCheckpointSaver['getTuple']>>;
  try {
    snapshot = (await agent.graph.getState({
      configurable: { thread_id: runId, ...(checkpointNs === '' ? {} : { checkpoint_ns: checkpointNs }) },
    })) as unknown as Snapshot;
    const checkpointId = snapshot.config.configurable?.checkpoint_id;
    if (typeof checkpointId !== 'string') return { kind: 'missing' };
    tuple = await saver.getTuple(snapshot.config as never);
  } catch {
    // A failure to read proves nothing about the saved state, so it never closes a question: only the checks
    // below, on state that was read, can confirm it missing or unusable.
    return { kind: 'unavailable' };
  }
  if (tuple === undefined) return { kind: 'missing' };
  return { kind: 'head', snapshot, tuple };
}

/** The digest of a saved head: channel values and versions, pending writes and pending tasks/interrupts. */
function savedStateDigest(snapshot: Snapshot, tuple: SavedTuple): string {
  return digestOf(
    JSON.parse(
      canonicalJson(
        canonicalSavedValue({
          channelValues: tuple.checkpoint.channel_values,
          channelVersions: tuple.checkpoint.channel_versions,
          pendingWrites: tuple.pendingWrites ?? [],
          next: [...snapshot.next],
          tasks: snapshot.tasks.map((pending) => ({
            id: pending.id,
            name: pending.name,
            interrupts: pending.interrupts.map((raisedItem) => ({ id: raisedItem.id, value: raisedItem.value })),
          })),
        }),
      ),
    ),
  );
}

/**
 * The structural checks and digest, separated from I/O so every refusal can be exercised directly. `actorKey`
 * selects version-2 (actor-scoped) question identity; without it the identity is the phase-1 one.
 */
export function classifySavedQuestion(
  runId: string,
  snapshot: Snapshot,
  tuple: SavedTuple,
  expectedQuestionId?: string,
  actorKey?: string,
): SavedStateInspection {
  const messages = snapshot.values.messages;
  if (!Array.isArray(messages) || messages.length === 0 || !messages.every((item) => BaseMessage.isInstance(item))) {
    return { kind: 'unusable', reason: 'messages_unusable' };
  }
  const raised = snapshot.tasks.flatMap((task) => task.interrupts.map((item) => ({ task, item })));
  if (raised.length === 0) return { kind: 'unusable', reason: 'no_pending_question' };
  if (raised.length !== 1) return { kind: 'unusable', reason: 'ambiguous_interrupt' };
  const [{ task, item }] = raised as [(typeof raised)[number]];
  if (typeof item.id !== 'string' || item.id === '') return { kind: 'unusable', reason: 'ambiguous_interrupt' };

  const payload = item.value as Partial<QuestionPayload> | undefined;
  const definition = questionDefinitionSchema.safeParse({ prompt: payload?.prompt, input: payload?.input });
  const last = [...messages].reverse().find((message) => AIMessage.isInstance(message)) as AIMessage | undefined;
  const calls = last?.tool_calls ?? [];
  const call = calls.length === 1 && calls[0]?.name === ASK_TOOL ? calls[0] : undefined;
  if (
    payload?.protocolVersion !== QUESTION_PROTOCOL_VERSION ||
    typeof payload.questionId !== 'string' ||
    !definition.success ||
    last === undefined ||
    typeof last.id !== 'string' ||
    call?.id === undefined ||
    callOperationId(runId, actorKey, last.id, call.id) !== payload.questionId ||
    (expectedQuestionId !== undefined && payload.questionId !== expectedQuestionId)
  ) {
    return { kind: 'unusable', reason: 'question_mismatch' };
  }

  let requiredStateDigest: string;
  try {
    requiredStateDigest = savedStateDigest(snapshot, tuple);
  } catch {
    return { kind: 'unusable', reason: 'unsupported_value' };
  }
  const configurable = snapshot.config.configurable ?? {};
  return {
    kind: 'question',
    question: {
      checkpointNs: String(configurable.checkpoint_ns ?? ''),
      checkpointId: String(configurable.checkpoint_id),
      taskId: task.id,
      interruptId: item.id,
      payload: payload as QuestionPayload,
      requiredStateDigest,
    },
  };
}

type WithoutDefinition<T> = T extends unknown ? Omit<T, 'definitionDigest'> : never;
/** A question binding as saved state establishes it; the definition digest is added by whoever records it. */
export type InspectedBinding = WithoutDefinition<QuestionBinding>;

export type BindingInspection =
  | { kind: 'question'; interruptId: string; payload: QuestionPayload; binding: InspectedBinding }
  | { kind: 'missing' }
  | { kind: 'unusable'; reason: UnusableReason }
  | { kind: 'unavailable' };

/**
 * The binding of a run's pending question, from saved state only (Decision 7). A native run's root question keeps
 * the phase-1 binding. In a command run the binding is version 2 and its required-state digest also covers the
 * asker's loaded-skill membership. A delegate's question is not visible through the root's subgraph enumeration:
 * the root's sole pending call must be the recorded delegation, and the delegate rebuilt from its retained
 * definition is inspected directly at its recorded namespace. Both saved heads must agree — the same interrupt and
 * payload — and both are covered by the digest. Nothing is invoked.
 */
export async function inspectQuestionBinding(
  agent: ExecutionAgent,
  saver: BaseCheckpointSaver,
  runId: string,
  expectedQuestionId?: string,
): Promise<BindingInspection> {
  const scope = agentScope(agent);
  if (scope === undefined) {
    const inspection = await inspectSavedQuestion(agent, saver, runId, expectedQuestionId);
    if (inspection.kind !== 'question') return inspection;
    const saved = inspection.question;
    return {
      kind: 'question',
      interruptId: saved.interruptId,
      payload: saved.payload,
      binding: {
        threadId: runId,
        checkpointNs: saved.checkpointNs,
        checkpointId: saved.checkpointId,
        taskId: saved.taskId,
        interruptId: saved.interruptId,
        ordinal: 0,
        operationId: saved.payload.questionId,
        payloadDigest: digestOf(saved.payload),
        requiredStateDigest: saved.requiredStateDigest,
      },
    };
  }

  const port = scope.delegation;
  if (port === undefined) return { kind: 'unusable', reason: 'question_mismatch' };
  const root = await readHead(agent, saver, runId, '');
  if (root.kind !== 'head') return root;
  const messages = root.snapshot.values.messages;
  const last = Array.isArray(messages)
    ? ([...messages].reverse().find((message) => AIMessage.isInstance(message)) as AIMessage | undefined)
    : undefined;
  const calls = last?.tool_calls ?? [];
  const call = calls.length === 1 ? calls[0] : undefined;
  const skills = async (actorKey: string) =>
    (await port.loadedSkills(actorKey)).map(({ skillId, operationId, definitionDigest }) => ({
      skillId,
      operationId,
      definitionDigest,
    }));

  if (call?.name !== DELEGATE_TOOL) {
    const inspection = classifySavedQuestion(runId, root.snapshot, root.tuple, expectedQuestionId, 'root');
    if (inspection.kind !== 'question') return inspection;
    const saved = inspection.question;
    let loaded: unknown;
    try {
      loaded = await skills('root');
    } catch {
      return { kind: 'unavailable' };
    }
    return {
      kind: 'question',
      interruptId: saved.interruptId,
      payload: saved.payload,
      binding: {
        version: 2,
        actor: 'root',
        threadId: runId,
        checkpointNs: saved.checkpointNs,
        checkpointId: saved.checkpointId,
        taskId: saved.taskId,
        interruptId: saved.interruptId,
        operationId: saved.payload.questionId,
        payloadDigest: digestOf(saved.payload),
        requiredStateDigest: digestOf({ state: saved.requiredStateDigest, loadedSkills: loaded }),
      },
    };
  }

  // A delegated question: the root waits in its delegation call; the delegate holds the question.
  const raised = root.snapshot.tasks.flatMap((task) => task.interrupts.map((item) => ({ task, item })));
  if (raised.length !== 1)
    return { kind: 'unusable', reason: raised.length === 0 ? 'no_pending_question' : 'ambiguous_interrupt' };
  const [{ task: rootTask, item: rootInterrupt }] = raised as [(typeof raised)[number]];
  if (typeof last?.id !== 'string' || typeof call.id !== 'string')
    return { kind: 'unusable', reason: 'question_mismatch' };
  const delegationId = operationIdV2(runId, 'root', last.id, call.id);
  let delegate: Awaited<ReturnType<typeof port.readDelegate>>;
  let loaded: unknown;
  try {
    delegate = await port.readDelegate(delegationId);
    loaded = await skills(delegationId);
  } catch {
    return { kind: 'unavailable' };
  }
  const definition = scope.capabilities.snapshot.agents.find((candidate) => candidate.id === delegate?.agentId);
  if (delegate === undefined || definition === undefined) return { kind: 'unusable', reason: 'question_mismatch' };
  const child = port.child({ kind: 'delegate', delegationId, agentId: definition.id }, definition);
  const head = await readHead(child, saver, runId, delegate.checkpointNs);
  if (head.kind !== 'head') return head;
  const inspection = classifySavedQuestion(runId, head.snapshot, head.tuple, expectedQuestionId, delegationId);
  if (inspection.kind !== 'question') return inspection;
  const saved = inspection.question;
  if (
    saved.checkpointNs !== delegate.checkpointNs ||
    rootInterrupt.id !== saved.interruptId ||
    canonicalJson(rootInterrupt.value ?? null) !== canonicalJson(saved.payload)
  ) {
    return { kind: 'unusable', reason: 'question_mismatch' };
  }
  let rootDigest: string;
  try {
    rootDigest = savedStateDigest(root.snapshot, root.tuple);
  } catch {
    return { kind: 'unusable', reason: 'unsupported_value' };
  }
  const rootConfig = root.snapshot.config.configurable ?? {};
  return {
    kind: 'question',
    interruptId: saved.interruptId,
    payload: saved.payload,
    binding: {
      version: 2,
      actor: 'delegate',
      delegationId,
      agentId: definition.id,
      threadId: runId,
      checkpointNs: saved.checkpointNs,
      checkpointId: saved.checkpointId,
      taskId: saved.taskId,
      interruptId: saved.interruptId,
      operationId: saved.payload.questionId,
      payloadDigest: digestOf(saved.payload),
      requiredStateDigest: digestOf({ root: rootDigest, child: saved.requiredStateDigest, loadedSkills: loaded }),
      parent: {
        checkpointNs: String(rootConfig.checkpoint_ns ?? ''),
        checkpointId: String(rootConfig.checkpoint_id),
        taskId: rootTask.id,
        operationId: delegationId,
      },
    },
  };
}
