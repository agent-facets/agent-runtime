// The terminal capture sink and the synthetic Responses stream.
//
// The sink is the only permitted egress point in an offline run: it records the
// fully transformed request and answers from a fixture. It never forwards, so a
// bug that tries to reach the provider shows up as a counted forward attempt
// rather than a silent real API call.

import type { RawCapture } from "../transport/canonical.ts";

export type CaptureSink = {
  captures: RawCapture[];
  forwardAttempts: number;
  fetch: (input: string, init: RequestInit) => Promise<Response>;
};

export function createCaptureSink(
  respond: (capture: RawCapture) => Response,
): CaptureSink {
  const sink: CaptureSink = {
    captures: [],
    forwardAttempts: 0,
    fetch: async (input, init) => {
      const headers: Record<string, string> = {};
      const initHeaders = init.headers;
      if (initHeaders instanceof Headers) {
        initHeaders.forEach((value, key) => {
          headers[key] = value;
        });
      } else if (Array.isArray(initHeaders)) {
        for (const [key, value] of initHeaders) headers[key] = String(value);
      } else if (initHeaders) {
        for (const [key, value] of Object.entries(initHeaders)) headers[key] = String(value);
      }

      let bodyRaw = "";
      const body = init.body;
      if (typeof body === "string") {
        bodyRaw = body;
      } else if (body !== undefined && body !== null) {
        // Anything non-string here means the request escaped serialisation and
        // would have been streamed to a real socket.
        sink.forwardAttempts += 1;
      }

      const capture: RawCapture = {
        method: (init.method ?? "POST").toUpperCase(),
        url: input,
        headers,
        bodyRaw,
      };
      sink.captures.push(capture);
      return respond(capture);
    },
  };

  return sink;
}

/** Installed over globalThis.fetch so an un-intercepted call is loud. */
export function createPoisonedFetch(onCall: () => void) {
  return async function poisonedFetch(): Promise<Response> {
    onCall();
    throw new Error("network access attempted from an offline run");
  };
}

// ---------------------------------------------------------------------------
// A minimal, well-formed Responses API SSE stream carrying one function call.

export type StreamScript = {
  responseId: string;
  model: string;
  toolName: string;
  toolArguments: string;
  /** Cut the stream before the terminal event. */
  truncate?: boolean;
};

export function responsesStreamEvents(script: StreamScript): string[] {
  const callId = "call_SPIKESENTINEL";
  const argumentChunks = splitEvenly(script.toolArguments, 3);

  const events: Array<[string, unknown]> = [
    [
      "response.created",
      { type: "response.created", response: { id: script.responseId, model: script.model } },
    ],
    [
      "response.output_item.added",
      {
        type: "response.output_item.added",
        output_index: 0,
        item: {
          type: "function_call",
          id: "fc_SPIKESENTINEL",
          call_id: callId,
          name: script.toolName,
          arguments: "",
        },
      },
    ],
  ];

  // A truncated stream is cut *inside* the arguments, which is the case that
  // matters: the tool name has arrived, the JSON has not, and nothing may
  // present that as a finished call.
  const delivered = script.truncate ? argumentChunks.slice(0, 1) : argumentChunks;

  for (const chunk of delivered) {
    events.push([
      "response.function_call_arguments.delta",
      {
        type: "response.function_call_arguments.delta",
        output_index: 0,
        item_id: "fc_SPIKESENTINEL",
        delta: chunk,
      },
    ]);
  }

  if (script.truncate) {
    return events.map(([, payload]) => `data: ${JSON.stringify(payload)}\n\n`);
  }

  events.push([
    "response.function_call_arguments.done",
    {
      type: "response.function_call_arguments.done",
      output_index: 0,
      item_id: "fc_SPIKESENTINEL",
      arguments: script.toolArguments,
    },
  ]);
  events.push([
    "response.output_item.done",
    {
      type: "response.output_item.done",
      output_index: 0,
      item: {
        type: "function_call",
        id: "fc_SPIKESENTINEL",
        call_id: callId,
        name: script.toolName,
        arguments: script.toolArguments,
      },
    },
  ]);
  events.push([
    "response.completed",
    {
      type: "response.completed",
      response: {
        id: script.responseId,
        model: script.model,
        status: "completed",
        output: [
          {
            type: "function_call",
            id: "fc_SPIKESENTINEL",
            call_id: callId,
            name: script.toolName,
            arguments: script.toolArguments,
          },
        ],
        usage: { input_tokens: 11, output_tokens: 7, total_tokens: 18 },
      },
    },
  ]);

  return events.map(([, payload]) => `data: ${JSON.stringify(payload)}\n\n`);
}

export function streamResponse(chunks: Uint8Array[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "text/event-stream",
      "x-request-id": "resp_SPIKESENTINEL",
    },
  });
}

function splitEvenly(value: string, parts: number): string[] {
  if (value.length === 0) return [""];
  const size = Math.ceil(value.length / parts);
  const out: string[] = [];
  for (let index = 0; index < value.length; index += size) {
    out.push(value.slice(index, index + size));
  }
  return out;
}
