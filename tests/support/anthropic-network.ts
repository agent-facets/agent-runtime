// A fake Anthropic Messages API and token endpoint for suites that run the production provider assembly. Each is
// an independent witness: it records every request that actually left the guarded terminal. Nothing is contacted.

const event = (name: string, payload: Record<string, unknown> = {}) =>
  `event: ${name}\ndata: ${JSON.stringify({ type: name, ...payload })}\n\n`;

export const opening = (id: string) =>
  event('message_start', {
    message: {
      id,
      type: 'message',
      role: 'assistant',
      model: 'claude-opus-5',
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 3, output_tokens: 1 },
    },
  });

const closing = (stop: string) =>
  event('message_delta', { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 2 } }) +
  event('message_stop');

export const textTurn = (id: string, value: string) =>
  opening(id) +
  event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }) +
  event('content_block_delta', { index: 0, delta: { type: 'text_delta', text: value } }) +
  event('content_block_stop', { index: 0 }) +
  closing('end_turn');

export const toolTurn = (id: string, toolId: string, name: string, input: unknown) =>
  opening(id) +
  event('content_block_start', { index: 0, content_block: { type: 'tool_use', id: toolId, name, input: {} } }) +
  event('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } }) +
  event('content_block_stop', { index: 0 }) +
  closing('tool_use');

export const YES_NO_QUESTION = {
  prompt: 'Proceed?',
  input: {
    kind: 'choice',
    multiple: false,
    options: [
      { label: 'Yes', value: true },
      { label: 'No', value: false },
    ],
  },
};

/** An event stream; with `stall`, the body stays open after the given text until the request is aborted. */
export const sse = (body: string, stall = false) =>
  new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(body));
        if (!stall) controller.close();
      },
    }),
    { headers: { 'content-type': 'text/event-stream', 'request-id': `req_${crypto.randomUUID().slice(0, 8)}` } },
  );

export interface SentInference {
  headers: Record<string, string>;
  body: { model: string; messages: { role: string; content: unknown }[] };
}

/**
 * Replies in order, or by what each request contains; an unscripted request fails the way a lost connection
 * would.
 */
export function inferenceNetwork(replies: (() => Response)[] | ((request: SentInference) => Response)) {
  const sent: SentInference[] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    const request = { headers: Object.fromEntries(new Headers(init.headers)), body: JSON.parse(String(init.body)) };
    sent.push(request);
    if (typeof replies === 'function') return replies(request);
    const reply = replies.shift();
    if (reply === undefined) throw new Error('unscripted inference request');
    return reply();
  }) as unknown as typeof fetch;
  return { sent, replies, fetchImpl };
}

export function tokenNetwork(replies: Response[] = []) {
  const sent: Record<string, string>[] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    sent.push(JSON.parse(new TextDecoder().decode(init.body as ArrayBuffer)));
    const reply = replies.shift();
    if (reply === undefined) throw new Error('unscripted token request');
    return reply;
  }) as unknown as typeof fetch;
  return { sent, fetchImpl };
}
