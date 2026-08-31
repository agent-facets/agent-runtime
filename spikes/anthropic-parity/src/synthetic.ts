// Synthetic Anthropic responses. No provider is contacted, so these are the
// only responses either lane ever sees.
//
// The streaming payload is deliberately hostile to a naive parser: it carries a
// four-byte emoji, CJK text, an escaped blank line, and the literal substring
// "data:" inside a text delta, and it splits one tool call's input JSON across
// three fragments.

export const NON_STREAM_TEXT_ONLY = {
  id: "msg_fixture_text",
  type: "message",
  role: "assistant",
  model: "claude-sonnet-4-5-20250929",
  content: [{ type: "text", text: "Acknowledged." }],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: { input_tokens: 11, output_tokens: 5 },
};

export function nonStreamToolUse(toolName: string) {
  return {
    id: "msg_fixture_tool",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-4-5-20250929",
    content: [
      { type: "text", text: "Calling the tool." },
      {
        type: "tool_use",
        id: "toolu_fixture_response_1",
        name: toolName,
        input: { value: "pong" },
      },
    ],
    stop_reason: "tool_use",
    stop_sequence: null,
    usage: { input_tokens: 23, output_tokens: 17 },
  };
}

export const ADVERSARIAL_TEXT_FRAGMENTS = [
  "Checking ",
  "\u{1F9EA} ",
  "\u691C\u8A3C ",
  "line one\n\nline two ",
  "not a real data: prefix ",
  "done.",
];

export const EXPECTED_STREAM_TEXT = ADVERSARIAL_TEXT_FRAGMENTS.join("");
export const EXPECTED_STREAM_TOOL_ID = "toolu_fixture_stream_1";
export const EXPECTED_STREAM_ARGS = { value: "ping", depth: 2 };
export const EXPECTED_STREAM_STOP_REASON = "tool_use";
export const EXPECTED_STREAM_USAGE = { input_tokens: 31, output_tokens: 24 };

function event(name: string, payload: unknown): string {
  return `event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`;
}

/**
 * A complete Anthropic SSE body ending in message_stop.
 *
 * With `truncate`, the stream is cut mid tool-input JSON: the caller receives a
 * syntactically incomplete argument object and no terminal events. A parser
 * that reported complete arguments from that would be silently inventing data.
 */
export function streamingBody(toolName: string, options?: { truncate?: boolean }): string {
  const parts: string[] = [];
  const truncate = options?.truncate === true;

  parts.push(
    event("message_start", {
      type: "message_start",
      message: {
        id: "msg_fixture_stream",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-5-20250929",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: EXPECTED_STREAM_USAGE.input_tokens,
          output_tokens: 1,
        },
      },
    }),
  );

  parts.push("event: ping\ndata: {\"type\":\"ping\"}\n\n");

  parts.push(
    event("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    }),
  );

  for (const fragment of ADVERSARIAL_TEXT_FRAGMENTS) {
    parts.push(
      event("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: fragment },
      }),
    );
  }

  parts.push(
    event("content_block_stop", { type: "content_block_stop", index: 0 }),
  );

  parts.push(
    event("content_block_start", {
      type: "content_block_start",
      index: 1,
      content_block: {
        type: "tool_use",
        id: EXPECTED_STREAM_TOOL_ID,
        name: toolName,
        input: {},
      },
    }),
  );

  // Input JSON split across three fragments, including a split inside a key.
  const fragments = ['{"val', 'ue":"ping","de', 'pth":2}'];
  for (const partial of truncate ? fragments.slice(0, 2) : fragments) {
    parts.push(
      event("content_block_delta", {
        type: "content_block_delta",
        index: 1,
        delta: { type: "input_json_delta", partial_json: partial },
      }),
    );
  }

  if (truncate) return parts.join("");

  parts.push(
    event("content_block_stop", { type: "content_block_stop", index: 1 }),
  );

  // Forward-compatibility: an event neither lane knows about.
  parts.push(
    event("fixture_unknown_event", { type: "fixture_unknown_event", index: 9 }),
  );

  parts.push(
    event("message_delta", {
      type: "message_delta",
      delta: {
        stop_reason: EXPECTED_STREAM_STOP_REASON,
        stop_sequence: null,
      },
      usage: { output_tokens: EXPECTED_STREAM_USAGE.output_tokens },
    }),
  );

  parts.push(event("message_stop", { type: "message_stop" }));

  return parts.join("");
}

// ---------------------------------------------------------------------------
// Chunkers

export type Chunker = {
  id: string;
  split: (bytes: Uint8Array) => Uint8Array[];
};

function fixedSize(size: number): (bytes: Uint8Array) => Uint8Array[] {
  return (bytes) => {
    const out: Uint8Array[] = [];
    for (let index = 0; index < bytes.length; index += size) {
      out.push(bytes.subarray(index, Math.min(index + size, bytes.length)));
    }
    return out;
  };
}

/** Split so that every SSE frame delimiter straddles a chunk boundary. */
function straddleDelimiters(bytes: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = [];
  let start = 0;
  for (let index = 0; index + 1 < bytes.length; index += 1) {
    // 0x0a === "\n"
    if (bytes[index] === 0x0a && bytes[index + 1] === 0x0a) {
      const cut = index + 1;
      out.push(bytes.subarray(start, cut));
      start = cut;
      index += 1;
    }
  }
  if (start < bytes.length) out.push(bytes.subarray(start));
  return out;
}

export const CHUNKERS: Chunker[] = [
  { id: "whole-body", split: (bytes) => [bytes] },
  { id: "one-byte", split: fixedSize(1) },
  { id: "seven-bytes", split: fixedSize(7) },
  { id: "straddle-frame-delimiter", split: straddleDelimiters },
];

export function sseResponse(body: string, chunker: Chunker): Response {
  const bytes = new TextEncoder().encode(body);
  const chunks = chunker.split(bytes);

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "request-id": "req_fixture_stream",
    },
  });
}

export function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "request-id": "req_fixture_json",
    },
  });
}
