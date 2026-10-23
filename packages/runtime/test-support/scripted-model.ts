// A provider-free chat model for execution tests. Each call takes the next scripted step, chosen from the
// conversation it receives; every physical call is recorded, with the signal it was given. Test-only.
import type { CallbackManagerForLLMRun } from '@langchain/core/callbacks/manager';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { AIMessage, BaseMessage } from '@langchain/core/messages';
import type { ChatResult } from '@langchain/core/outputs';

// Root-level integration suites cannot resolve the runtime's dependencies themselves, so they take these from here.
export { AIMessage, ToolMessage } from '@langchain/core/messages';

export type ScriptStep = (messages: BaseMessage[], signal: AbortSignal | undefined) => AIMessage | Promise<AIMessage>;

export class ScriptedModel extends BaseChatModel {
  readonly calls: { messages: BaseMessage[]; signal: AbortSignal | undefined }[] = [];

  constructor(private readonly steps: ScriptStep[]) {
    super({});
  }

  _llmType() {
    return 'scripted';
  }

  override bindTools() {
    return this;
  }

  async _generate(
    messages: BaseMessage[],
    options: this['ParsedCallOptions'],
    _runManager?: CallbackManagerForLLMRun,
  ): Promise<ChatResult> {
    this.calls.push({ messages, signal: options.signal });
    const step = this.steps[this.calls.length - 1];
    if (step === undefined) throw new Error('scripted model: no step left');
    const message = await step(messages, options.signal);
    return { generations: [{ text: typeof message.content === 'string' ? message.content : '', message }] };
  }
}

/** Resolves when the signal aborts, rejecting with its reason; for steps that must wait to be cancelled. */
export function untilAborted(signal: AbortSignal | undefined): Promise<never> {
  return new Promise((_, reject) => {
    if (signal === undefined) return;
    if (signal.aborted) reject(signal.reason);
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}

/** Everything a MemorySaver holds, decoded to text, for scanning what was persisted. */
export function persistedText(saver: object): string {
  const decode = (value: unknown): unknown => {
    if (value instanceof Uint8Array) return new TextDecoder().decode(value);
    if (Array.isArray(value)) return value.map(decode);
    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, decode(item)]));
    }
    return value;
  };
  const { storage, writes } = saver as { storage: unknown; writes: unknown };
  return JSON.stringify(decode({ storage, writes }));
}

/**
 * A scripted model that, like a provider SDK, makes one HTTP request per model call through the `fetch` it is
 * given (the guarded terminal), reads the whole response, and fails on an unsuccessful status. The step then
 * decides the message. `requestsPerCall` > 1 imitates an SDK retrying on its own.
 */
export class FetchingModel extends ScriptedModel {
  constructor(
    steps: ScriptStep[],
    private readonly fetchImpl: typeof fetch,
    private readonly url = 'https://api.provider.test/v1/messages',
  ) {
    super(steps);
  }

  override async _generate(
    messages: BaseMessage[],
    options: this['ParsedCallOptions'],
    runManager?: CallbackManagerForLLMRun,
  ): Promise<ChatResult> {
    const response = await this.fetchImpl(this.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'sentinel' },
      body: JSON.stringify({ messages: messages.length }),
      signal: options.signal,
    });
    const text = await response.text();
    if (!response.ok) throw Object.assign(new Error(`provider error ${text}`), { status: response.status });
    return super._generate(messages, options, runManager);
  }
}
