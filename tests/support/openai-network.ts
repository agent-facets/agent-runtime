// A scripted OpenAI subscription (Codex backend) network for integration journeys: streaming Responses events as
// `data:` lines only, as the backend was observed to send them. Nothing here contacts OpenAI.
const data = (type: string, payload: Record<string, unknown> = {}) =>
  `data: ${JSON.stringify({ type, ...payload })}\n\n`;

const response = (id: string, status: string, output: unknown[]) => ({
  id,
  object: 'response',
  created_at: 1,
  status,
  model: 'gpt-5.6-sol',
  output,
  usage: { input_tokens: 7, output_tokens: 5, total_tokens: 12 },
});

/** One turn: opaque reasoning, then a complete function call. */
export function functionCallTurn(id: string, callId: string, name: string, args: unknown): string {
  const reasoning = { id: `rs_${id}`, type: 'reasoning', summary: [], encrypted_content: `gAAAA-${id}-reasoning` };
  const call = {
    id: `fc_${id}`,
    type: 'function_call',
    call_id: callId,
    name,
    arguments: JSON.stringify(args),
    status: 'completed',
  };
  return (
    data('response.created', { response: response(id, 'in_progress', []) }) +
    data('response.output_item.added', { output_index: 0, item: reasoning }) +
    data('response.output_item.done', { output_index: 0, item: reasoning }) +
    data('response.output_item.added', { output_index: 1, item: { ...call, arguments: '', status: 'in_progress' } }) +
    data('response.function_call_arguments.delta', { output_index: 1, item_id: call.id, delta: call.arguments }) +
    data('response.function_call_arguments.done', { output_index: 1, item_id: call.id, arguments: call.arguments }) +
    data('response.output_item.done', { output_index: 1, item: call }) +
    data('response.completed', { response: response(id, 'completed', [reasoning, call]) })
  );
}

/** One turn: a final text message. */
export function textTurn(id: string, text: string): string {
  const message = {
    id: `msg_${id}`,
    type: 'message',
    role: 'assistant',
    status: 'completed',
    content: [{ type: 'output_text', text, annotations: [] }],
  };
  return (
    data('response.created', { response: response(id, 'in_progress', []) }) +
    data('response.output_item.added', { output_index: 0, item: { ...message, content: [], status: 'in_progress' } }) +
    data('response.content_part.added', {
      output_index: 0,
      item_id: message.id,
      content_index: 0,
      part: { type: 'output_text', text: '' },
    }) +
    data('response.output_text.delta', { output_index: 0, item_id: message.id, content_index: 0, delta: text }) +
    data('response.output_text.done', { output_index: 0, item_id: message.id, content_index: 0, text }) +
    data('response.output_item.done', { output_index: 0, item: message }) +
    data('response.completed', { response: response(id, 'completed', [message]) })
  );
}

export const responsesStream = (body: string) =>
  new Response(body, { headers: { 'content-type': 'text/event-stream' } });

export const openaiUnauthorized = () =>
  new Response(JSON.stringify({ error: { code: 'token_expired', message: 'x' } }), {
    status: 401,
    headers: { 'content-type': 'application/json' },
  });

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
/** A structurally valid, unsigned JWT carrying `claims`; synthetic only. */
export const syntheticJwt = (claims: Record<string, unknown>) =>
  `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64(claims)}.c3ludGhldGlj`;
