// Running one fixture case through a lane.
//
// Both lanes drive the same stock ChatAnthropic with the same model settings.
// Only the injected fetch and the tool naming differ, so a serialization
// difference between the lanes would be a real finding rather than an artefact
// of two different clients.

import { ChatAnthropic } from "@langchain/anthropic";
import { concat } from "@langchain/core/utils/stream";
import type { AIMessageChunk, BaseMessage } from "@langchain/core/messages";

import { buildMessages, buildTools } from "./cases.ts";
import type { CaseSpec, Fixtures, Lane } from "./cases.ts";

export const SENTINEL_API_KEY = "sk-ant-api03-SENTINEL-0000000000000000000000";
export const SENTINEL_ACCESS_TOKEN = "sk-ant-oat01-SENTINEL-0000000000000000000000";
export const SENTINEL_REFRESH_TOKEN = "sk-ant-ort01-SENTINEL-0000000000000000000000";

export const SENTINELS = [
  SENTINEL_API_KEY,
  SENTINEL_ACCESS_TOKEN,
  SENTINEL_REFRESH_TOKEN,
];

type FetchInput = string | URL | Request;
type LaneFetch = (input: FetchInput, init?: RequestInit) => Promise<Response>;

export type SdkRequest = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
};

export function buildModel(fixtures: Fixtures, laneFetch: LaneFetch): ChatAnthropic {
  return new ChatAnthropic({
    model: fixtures.model,
    maxTokens: fixtures.maxTokens,
    apiKey: SENTINEL_API_KEY,
    // LangChain's AsyncCaller retries six times by default; a single fixture
    // failure would otherwise fire seven captures.
    maxRetries: 0,
    clientOptions: {
      fetch: laneFetch as never,
      // Removes anthropic-dangerous-direct-browser-access at the source rather
      // than excusing it in the diff allowlist.
      dangerouslyAllowBrowser: false,
    },
  });
}

/**
 * Wraps a lane fetch so the pre-decorator request the SDK produced can be
 * replayed later by the negative controls.
 */
export function recordSdkRequest(
  inner: LaneFetch,
  store: SdkRequest[],
): LaneFetch {
  return async (input, init) => {
    const headers: Record<string, string> = {};
    const initHeaders = init?.headers;
    if (initHeaders instanceof Headers) {
      initHeaders.forEach((value, key) => {
        headers[key] = value;
      });
    } else if (Array.isArray(initHeaders)) {
      for (const [key, value] of initHeaders) headers[key] = String(value);
    } else if (initHeaders) {
      for (const [key, value] of Object.entries(initHeaders)) {
        headers[key] = String(value);
      }
    }

    store.push({
      url:
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url,
      method: (init?.method ?? "POST").toUpperCase(),
      headers,
      body: typeof init?.body === "string" ? init.body : "",
    });

    return inner(input, init);
  };
}

export type MessageSummary = {
  text: string;
  toolCalls: Array<{ name: string; args: unknown; id: string | undefined }>;
  stopReason: unknown;
  usage: unknown;
  responseId: unknown;
  model: unknown;
};

export function summariseMessage(message: AIMessageChunk | BaseMessage): MessageSummary {
  const content = message.content;
  let text = "";
  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    for (const block of content) {
      if (
        block !== null &&
        typeof block === "object" &&
        (block as { type?: unknown }).type === "text"
      ) {
        text += String((block as { text?: unknown }).text ?? "");
      }
    }
  }

  const additional = (message as { additional_kwargs?: Record<string, unknown> })
    .additional_kwargs;
  const metadata = (message as { response_metadata?: Record<string, unknown> })
    .response_metadata;

  const toolCalls =
    (message as { tool_calls?: Array<{ name: string; args: unknown; id?: string }> })
      .tool_calls ?? [];

  return {
    text,
    toolCalls: toolCalls.map((call) => ({
      name: call.name,
      args: call.args,
      id: call.id,
    })),
    // Non-streaming puts stop_reason on response_metadata; concatenated
    // streaming chunks put it on additional_kwargs.
    stopReason: metadata?.stop_reason ?? additional?.stop_reason ?? null,
    usage: (message as { usage_metadata?: unknown }).usage_metadata ?? null,
    responseId: metadata?.id ?? additional?.id ?? null,
    model: metadata?.model ?? additional?.model ?? null,
  };
}

export async function invokeCase(
  fixtures: Fixtures,
  spec: CaseSpec,
  lane: Lane,
  laneFetch: LaneFetch,
): Promise<MessageSummary> {
  const model = buildModel(fixtures, laneFetch);
  const tools = buildTools(fixtures, spec, lane);
  const messages = buildMessages(fixtures, spec, lane);

  const runnable = tools.length > 0 ? model.bindTools(tools as never) : model;
  const result = await runnable.invoke(messages, {
    headers: spec.extraHeaders,
  });

  return summariseMessage(result);
}

export async function streamCase(
  fixtures: Fixtures,
  spec: CaseSpec,
  lane: Lane,
  laneFetch: LaneFetch,
): Promise<MessageSummary> {
  const model = buildModel(fixtures, laneFetch);
  const tools = buildTools(fixtures, spec, lane);
  const messages = buildMessages(fixtures, spec, lane);

  const runnable = tools.length > 0 ? model.bindTools(tools as never) : model;
  const stream = await runnable.stream(messages, { headers: spec.extraHeaders });

  let aggregate: AIMessageChunk | undefined;
  for await (const chunk of stream) {
    aggregate = aggregate === undefined ? chunk : concat(aggregate, chunk);
  }

  if (aggregate === undefined) throw new Error("stream produced no chunks");
  return summariseMessage(aggregate);
}

export async function withTimeout<T>(
  label: string,
  ms: number,
  work: () => Promise<T>,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`timeout after ${ms}ms: ${label}`)),
          ms,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
