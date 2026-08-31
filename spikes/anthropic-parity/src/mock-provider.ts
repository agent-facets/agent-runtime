// Synthetic provider for rehearsing the live probe without provider traffic.
//
//   node --no-warnings --import ./src/mock-provider.ts src/live.ts
//
// Preloaded modules run before the main module, so live.ts captures this as its
// "real" fetch. Every layer below the network is therefore exercised -- the
// credential preflight, the validator gate, the budget assertions, the streaming
// instrumentation, the two-request assembly, and the evidence sanitiser --
// while nothing leaves the process.
//
// This exists so a change to the live probe can be proven before it is allowed
// to spend subscription quota.

import { streamingBody } from "./synthetic.ts";

function event(name: string, payload: unknown): string {
  return `event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`;
}

/** Request 2: a plain text answer that terminates the conversation. */
function finalTextBody(): string {
  const parts: string[] = [];

  parts.push(
    event("message_start", {
      type: "message_start",
      message: {
        id: "msg_mock_final",
        type: "message",
        role: "assistant",
        model: "claude-opus-5",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        // Larger than request 1: the history grew by two turns.
        usage: { input_tokens: 92, output_tokens: 1 },
      },
    }),
  );

  parts.push(
    event("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    }),
  );

  for (const fragment of ["The tool ", "returned ", "parity-probe", "."]) {
    parts.push(
      event("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: fragment },
      }),
    );
  }

  parts.push(event("content_block_stop", { type: "content_block_stop", index: 0 }));

  parts.push(
    event("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 12 },
    }),
  );

  parts.push(event("message_stop", { type: "message_stop" }));

  return parts.join("");
}

function chunkedStream(body: string, chunkSize = 128): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(body);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (let index = 0; index < bytes.length; index += chunkSize) {
        controller.enqueue(bytes.subarray(index, Math.min(index + chunkSize, bytes.length)));
      }
      controller.close();
    },
  });
}

let call = 0;

globalThis.fetch = (async (input: string | URL | Request) => {
  call += 1;

  const href =
    typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  if (!href.startsWith("https://api.anthropic.com/v1/messages")) {
    throw new Error(`mock provider refused unexpected url: ${href}`);
  }

  const body = call === 1 ? streamingBody("mcp_Echo") : finalTextBody();

  return new Response(chunkedStream(body), {
    status: 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "request-id": `req_mock_${call}`,
    },
  });
}) as typeof globalThis.fetch;

process.stderr.write("[mock-provider] synthetic Anthropic installed; no traffic will leave\n");
