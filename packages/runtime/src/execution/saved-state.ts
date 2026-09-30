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
import { operationIdFor, questionDefinitionSchema } from '../records/schemas.ts';
import type { ExecutionAgent } from './agent.ts';
import { ASK_TOOL, QUESTION_PROTOCOL_VERSION, type QuestionPayload } from './tools.ts';

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
  let snapshot: Snapshot;
  let tuple: Awaited<ReturnType<BaseCheckpointSaver['getTuple']>>;
  try {
    snapshot = (await agent.graph.getState({ configurable: { thread_id: runId } })) as unknown as Snapshot;
    const checkpointId = snapshot.config.configurable?.checkpoint_id;
    if (typeof checkpointId !== 'string') return { kind: 'missing' };
    tuple = await saver.getTuple(snapshot.config as never);
  } catch {
    // A failure to read proves nothing about the saved state, so it never closes a question: only the checks
    // below, on state that was read, can confirm it missing or unusable.
    return { kind: 'unavailable' };
  }
  if (tuple === undefined) return { kind: 'missing' };
  return classifySavedQuestion(runId, snapshot, tuple, expectedQuestionId);
}

/** The structural checks and digest, separated from I/O so every refusal can be exercised directly. */
export function classifySavedQuestion(
  runId: string,
  snapshot: Snapshot,
  tuple: { checkpoint: { channel_values: unknown; channel_versions: unknown }; pendingWrites?: unknown },
  expectedQuestionId?: string,
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
    operationIdFor(runId, last.id, call.id) !== payload.questionId ||
    (expectedQuestionId !== undefined && payload.questionId !== expectedQuestionId)
  ) {
    return { kind: 'unusable', reason: 'question_mismatch' };
  }

  let requiredStateDigest: string;
  try {
    requiredStateDigest = digestOf(
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
