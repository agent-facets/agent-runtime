// The scripted model side of the real-MCP delegate restart witness (task 12.7), shared by the child process that runs
// its first phase and the fresh owners that continue it. Each phase's replies answer the requests of that phase in
// order; tool calls use whatever wire name the request offered, so each provider's translation is exercised.
import { type SentInference, sse, textTurn, toolsTurn, toolTurn, YES_NO_QUESTION } from './anthropic-network.ts';
import { wire } from './mcp-service.ts';
import { responsesStream, textTurn as responsesText } from './openai-network.ts';

export type Provider = 'anthropic' | 'openai';
type Call = [callId: string, name: string, input: unknown];
type Reply = (request: SentInference) => Response;

const data = (type: string, payload: Record<string, unknown> = {}) =>
  `data: ${JSON.stringify({ type, ...payload })}\n\n`;

/** One OpenAI Responses turn issuing the given function calls, in order. */
function responsesCalls(id: string, calls: Call[]): string {
  const items = calls.map(([callId, name, input], index) => ({
    id: `fc_${id}_${index}`,
    type: 'function_call',
    call_id: callId,
    name,
    arguments: JSON.stringify(input),
    status: 'completed',
  }));
  const response = (status: string, output: unknown[]) => ({
    id,
    object: 'response',
    created_at: 1,
    status,
    model: 'gpt-5.6-sol',
    output,
    usage: { input_tokens: 7, output_tokens: 5, total_tokens: 12 },
  });
  return (
    data('response.created', { response: response('in_progress', []) }) +
    items
      .map(
        (item, index) =>
          data('response.output_item.added', {
            output_index: index,
            item: { ...item, arguments: '', status: 'in_progress' },
          }) +
          data('response.function_call_arguments.delta', {
            output_index: index,
            item_id: item.id,
            delta: item.arguments,
          }) +
          data('response.output_item.done', { output_index: index, item }),
      )
      .join('') +
    data('response.completed', { response: response('completed', items) })
  );
}

const calls = (provider: Provider, id: string, list: Call[]) =>
  provider === 'anthropic' ? sse(toolsTurn(`msg_${id}`, list)) : responsesStream(responsesCalls(`resp_${id}`, list));
const one = (provider: Provider, id: string, call: Call) =>
  provider === 'anthropic'
    ? sse(toolTurn(`msg_${id}`, call[0], call[1], call[2]))
    : responsesStream(responsesCalls(`resp_${id}`, [call]));
const text = (provider: Provider, id: string, value: string) =>
  provider === 'anthropic' ? sse(textTurn(`msg_${id}`, value)) : responsesStream(responsesText(`resp_${id}`, value));

const LIST = { repository: 'owner/repo-a' };
const ASK = YES_NO_QUESTION;

/** The replies of one phase: 1 runs until the delegate's first question, 2 until its second, 3 to the end. */
export function phaseReplies(provider: Provider, phase: 1 | 2 | 3): Reply[] {
  switch (phase) {
    case 1:
      return [
        // The root loads a skill and calls the server in one response.
        (request) =>
          calls(provider, 'r1', [
            ['call_r1a', 'mcp_LoadSkill', { skill: 'skill:review' }],
            ['call_r1b', wire(request, 'list_items'), LIST],
          ]),
        () => one(provider, 'r2', ['call_r2', 'mcp_Delegate', { agent: 'agent:worker', task: 'Check the count.' }]),
        (request) => one(provider, 'd1', ['call_d1', wire(request, 'list_items'), LIST]),
        () => one(provider, 'd2', ['call_d2', 'mcp_AskUser', ASK]),
      ];
    case 2:
      return [
        // The same arguments again: a new operation, sent again.
        (request) => one(provider, 'd3', ['call_d3', wire(request, 'list_items'), LIST]),
        () => one(provider, 'd4', ['call_d4', 'mcp_AskUser', ASK]),
      ];
    case 3:
      return [() => text(provider, 'd5', 'Checked twice.'), () => text(provider, 'r3', 'The worker checked.')];
  }
}

/** The witness's grants and allowances. */
export const SCENARIO = {
  grants: [{ name: 'list_items', argumentEquals: LIST }],
  allowAgents: ['agent:worker'],
  allowSkills: ['skill:review'],
} as const;
