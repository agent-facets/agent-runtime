// The agent's entire tool surface: read, search and ask. Schemas are explicit JSON Schema literals (no schema
// generation), and each tool re-validates its arguments itself, so the schema is a description for the model,
// not the enforcement. Read and search results pass the complete outcome sanitizer before they are returned.
import { AIMessage, type BaseMessage } from '@langchain/core/messages';
import { interrupt } from '@langchain/langgraph';
import { tool } from 'langchain';
import { canonicalAnswer } from '../domain/questions.ts';
import { type Answer, operationIdFor, type QuestionInput, questionDefinitionSchema } from '../records/schemas.ts';
import type { ContentPolicy } from '../security/content-policy.ts';
import { sanitizeToolOutcome } from '../security/pre-graph.ts';
import type { WorkspacePolicy } from '../workspace/policy.ts';
import { readWorkspace } from '../workspace/read.ts';
import type { ToolOutcome } from '../workspace/results.ts';
import { searchWorkspace } from '../workspace/search.ts';
import { ExecutionFailure } from './failures.ts';

export const READ_TOOL = 'mcp_Read';
export const SEARCH_TOOL = 'mcp_Search';
export const ASK_TOOL = 'mcp_AskUser';
export const TOOL_NAMES: readonly string[] = [READ_TOOL, SEARCH_TOOL, ASK_TOOL];
export const QUESTION_PROTOCOL_VERSION = 1;

const positive = { type: 'integer', minimum: 1 } as const;

export const READ_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['mode', 'path'],
  properties: {
    mode: { type: 'string', enum: ['file', 'directory'] },
    path: { type: 'string', description: 'Path relative to the workspace root; "." is the root.' },
    startLine: { ...positive, description: 'File mode: first line to return (default 1).' },
    lineLimit: { ...positive, maximum: 2000, description: 'File mode: lines to return (default 200).' },
    afterName: { type: 'string', description: 'Directory mode: continue after this entry name.' },
    entryLimit: { ...positive, maximum: 2000, description: 'Directory mode: entries to return (default 200).' },
  },
} as const;

export const SEARCH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['query'],
  properties: {
    query: { type: 'string', description: 'Case-sensitive literal text on a single line.' },
    path: { type: 'string', description: 'Subtree relative to the workspace root (default: the root).' },
    maxMatches: { ...positive, maximum: 100 },
  },
} as const;

const choiceValue = { type: ['string', 'number', 'boolean', 'null'] } as const;

export const ASK_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['prompt', 'input'],
  properties: {
    prompt: { type: 'string', description: 'The exact question for the owner.' },
    input: {
      type: 'object',
      description:
        'Either { kind: "text", minLength, maxLength }, { kind: "choice", multiple: false, options }, or ' +
        '{ kind: "choice", multiple: true, options, minSelections, maxSelections }.',
      required: ['kind'],
      properties: {
        kind: { type: 'string', enum: ['text', 'choice'] },
        minLength: { type: 'integer', minimum: 0 },
        maxLength: { type: 'integer', minimum: 1 },
        multiple: { type: 'boolean' },
        options: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['label', 'value'],
            properties: { label: { type: 'string' }, value: choiceValue },
          },
        },
        minSelections: { type: 'integer', minimum: 0 },
        maxSelections: { type: 'integer', minimum: 1 },
      },
    },
  },
} as const;

/** The interrupt payload: deterministic for a given call, so a replayed task raises the identical interrupt. */
export interface QuestionPayload {
  protocolVersion: typeof QUESTION_PROTOCOL_VERSION;
  questionId: string;
  prompt: string;
  input: QuestionInput;
}

/** The resume value: the question it answers and the typed answer, so `false` and `null` are delivered intact. */
export interface ResumeEnvelope {
  questionId: string;
  answer: Answer;
}

export interface ToolContext {
  workspace: WorkspacePolicy;
  /** The current content policy (its exact matcher follows credential generations). */
  contentPolicy: () => ContentPolicy;
  /** Confirms the delivered answer is the one recorded as accepted for this question (Decision 5). */
  confirmAnswer?: (envelope: ResumeEnvelope) => boolean;
}

interface ToolRuntimeView {
  signal?: AbortSignal;
  toolCallId?: string;
  configurable?: { thread_id?: unknown };
  state?: { messages?: BaseMessage[] };
}

const refusal = (code: string, message: string): ToolOutcome<never> => ({ outcome: 'refused', code, message });

/** The ID of the model message that issued a tool call, from the state the tool runs in. */
export function issuingMessageId(messages: readonly BaseMessage[] | undefined, toolCallId: string): string | undefined {
  const issuers = (messages ?? []).filter(
    (message) => AIMessage.isInstance(message) && message.tool_calls?.some((call) => call.id === toolCallId),
  );
  return issuers.length === 1 && typeof issuers[0]?.id === 'string' && issuers[0].id !== '' ? issuers[0].id : undefined;
}

export function createExecutionTools(context: ToolContext) {
  const workspaceTool = (
    name: string,
    description: string,
    schema: object,
    run: typeof readWorkspace | typeof searchWorkspace,
  ) =>
    tool(
      async (args: unknown, runtime: ToolRuntimeView) => {
        const policy = context.contentPolicy();
        const outcome = await run(context.workspace, args, { signal: runtime.signal, screen: policy });
        return JSON.stringify(sanitizeToolOutcome(policy, outcome as ToolOutcome<unknown>));
      },
      { name, description, schema },
    );

  const read = workspaceTool(
    READ_TOOL,
    'Read a text file as numbered lines, or list a directory, inside the configured workspace. Read-only.',
    READ_SCHEMA,
    readWorkspace,
  );
  const search = workspaceTool(
    SEARCH_TOOL,
    'Search text files in the workspace for a literal, case-sensitive string. Read-only.',
    SEARCH_SCHEMA,
    searchWorkspace,
  );

  const ask = tool(
    async (args: unknown, runtime: ToolRuntimeView) => {
      const policy = context.contentPolicy();
      const parsed = questionDefinitionSchema.safeParse(args);
      if (!parsed.success) {
        return JSON.stringify(refusal('invalid_question', 'The question or its answer definition is not supported.'));
      }
      const threadId = runtime.configurable?.thread_id;
      const toolCallId = runtime.toolCallId;
      const messageId =
        typeof toolCallId === 'string' ? issuingMessageId(runtime.state?.messages, toolCallId) : undefined;
      if (typeof threadId !== 'string' || typeof toolCallId !== 'string' || messageId === undefined) {
        throw new ExecutionFailure('tool_call_unrepresentable');
      }
      const payload: QuestionPayload = {
        protocolVersion: QUESTION_PROTOCOL_VERSION,
        questionId: operationIdFor(threadId, messageId, toolCallId),
        prompt: parsed.data.prompt,
        input: parsed.data.input,
      };
      // The only interrupt, with nothing non-idempotent before it. On resume the framework returns the value.
      const resumed: unknown = interrupt(payload);
      if (typeof resumed !== 'object' || resumed === null || Array.isArray(resumed)) {
        throw new ExecutionFailure('invariant_violation');
      }
      const envelope = resumed as Partial<ResumeEnvelope>;
      if (envelope.questionId !== payload.questionId || !Object.hasOwn(envelope, 'answer')) {
        throw new ExecutionFailure('invariant_violation');
      }
      const valid = canonicalAnswer(payload.input, envelope);
      if (!valid.ok || JSON.stringify(valid.answer) !== JSON.stringify(envelope.answer)) {
        throw new ExecutionFailure('invariant_violation');
      }
      if (context.confirmAnswer !== undefined && !context.confirmAnswer(envelope as ResumeEnvelope)) {
        throw new ExecutionFailure('invariant_violation');
      }
      return JSON.stringify(sanitizeToolOutcome(policy, { outcome: 'ok', result: { answer: valid.answer } }));
    },
    {
      name: ASK_TOOL,
      description: 'Ask the owner one question and wait for the answer. It must be the only tool call in its response.',
      schema: ASK_SCHEMA,
    },
  );

  return [read, search, ask];
}
