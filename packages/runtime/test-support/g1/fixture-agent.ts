// G1 fixture agent: a deterministic, provider-free model and a sole interrupting question tool, assembled with the
// stock root-level createAgent and the official saver. Test-only; it is not part of the runtime build.
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { AIMessage, type BaseMessage, ToolMessage } from '@langchain/core/messages';
import type { ChatResult } from '@langchain/core/outputs';
import { interrupt } from '@langchain/langgraph';
import type { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint';
import { createAgent, tool } from 'langchain';

export const QUESTION_MESSAGE_ID = 'g1-model-question';
export const QUESTION_CALL_ID = 'g1-call-ask-1';
export const FINAL_MESSAGE_ID = 'g1-model-final';

export type Witness = (event: string, data?: Record<string, unknown>) => void;

export interface ResumeEnvelope {
  questionId: string;
  answer: boolean;
}

/** Stable question identity over the logical call binding, as the design specifies for operation IDs. */
export function questionIdFor(threadId: string, modelMessageId: string, toolCallId: string): string {
  return new Bun.CryptoHasher('sha256').update(JSON.stringify([threadId, modelMessageId, toolCallId])).digest('hex');
}

function isEnvelope(value: unknown, questionId: string): value is ResumeEnvelope {
  if (typeof value !== 'object' || value === null) return false;
  const envelope = value as Record<string, unknown>;
  return (
    envelope.questionId === questionId && Object.hasOwn(envelope, 'answer') && typeof envelope.answer === 'boolean'
  );
}

/**
 * Chooses its response from the conversation alone (never a process-local counter), so a fresh process reaches
 * the same decision. Any unexpected history is an invariant failure rather than a guess.
 */
class G1Model extends BaseChatModel {
  constructor(
    private readonly witness: Witness,
    private readonly beforeDispatch: () => Promise<void>,
  ) {
    super({});
  }

  _llmType() {
    return 'g1-deterministic';
  }

  override bindTools() {
    return this;
  }

  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    await this.beforeDispatch();
    this.witness('model.dispatch', { messages: messages.length });
    const toolMessages = messages.filter((message) => ToolMessage.isInstance(message));
    const last = messages.at(-1);

    if (toolMessages.length === 0) {
      this.witness('model.ask');
      const message = new AIMessage({
        id: QUESTION_MESSAGE_ID,
        content: '',
        tool_calls: [
          {
            id: QUESTION_CALL_ID,
            name: 'mcp_AskUser',
            type: 'tool_call',
            args: {
              prompt: 'Proceed with the change?',
              input: {
                kind: 'choice',
                multiple: false,
                options: [
                  { label: 'Yes', value: true },
                  { label: 'No', value: false },
                ],
              },
            },
          },
        ],
      });
      return { generations: [{ text: '', message }] };
    }

    if (toolMessages.length !== 1 || last === undefined || !ToolMessage.isInstance(last)) {
      throw new Error('G1 invariant: unexpected conversation shape');
    }
    if (last.tool_call_id !== QUESTION_CALL_ID || last.status === 'error' || typeof last.content !== 'string') {
      throw new Error('G1 invariant: the question result is missing or failed');
    }
    const result = JSON.parse(last.content) as { answer?: unknown };
    if (!Object.hasOwn(result, 'answer') || result.answer !== false) {
      throw new Error('G1 invariant: the delivered answer is not the boolean false');
    }
    this.witness('model.validated-false');
    const message = new AIMessage({ id: FINAL_MESSAGE_ID, content: 'The owner declined; nothing was changed.' });
    return { generations: [{ text: String(message.content), message }] };
  }
}

const askUserSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['prompt', 'input'],
  properties: {
    prompt: { type: 'string', maxLength: 16_384 },
    input: {
      type: 'object',
      required: ['kind', 'multiple', 'options'],
      properties: {
        kind: { const: 'choice' },
        multiple: { const: false },
        options: {
          type: 'array',
          minItems: 1,
          maxItems: 50,
          items: {
            type: 'object',
            required: ['label', 'value'],
            properties: { label: { type: 'string' }, value: { type: 'boolean' } },
          },
        },
      },
    },
  },
} as const;

export interface G1AgentOptions {
  saver: BaseCheckpointSaver;
  witness: Witness;
  /** Runs before every model dispatch; the lost-ownership case re-verifies ownership here. */
  beforeDispatch?: () => Promise<void>;
}

export function createG1Agent(options: G1AgentOptions) {
  const askUser = tool(
    async (input: { prompt: string }, runtime) => {
      options.witness('tool.enter');
      const threadId = String(runtime.configurable?.thread_id ?? '');
      const toolCallId = 'toolCallId' in runtime ? String(runtime.toolCallId) : runtime.toolCall?.id;
      if (!threadId || !toolCallId) throw new Error('G1 invariant: missing thread or tool-call identity');
      const questionId = questionIdFor(threadId, QUESTION_MESSAGE_ID, toolCallId);
      // The single interrupt, with a deterministic payload and no non-idempotent work before it.
      const resumed: unknown = interrupt({ questionId, prompt: input.prompt });
      if (!isEnvelope(resumed, questionId))
        throw new Error('G1 invariant: resume envelope does not match the question');
      options.witness('tool.answer-delivered', { answer: resumed.answer });
      return JSON.stringify({ answer: resumed.answer });
    },
    {
      name: 'mcp_AskUser',
      description: 'Ask the owner exactly one question and wait for the answer.',
      schema: askUserSchema,
    },
  );

  return createAgent({
    model: new G1Model(options.witness, options.beforeDispatch ?? (async () => {})),
    tools: [askUser],
    checkpointer: options.saver,
    version: 'v2',
  });
}
