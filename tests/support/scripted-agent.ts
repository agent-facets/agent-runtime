// A scripted stand-in for the model, for the offline console: it follows the conversation instead of a fixed
// list, so an owner can start any number of runs by hand. Every run reads `notes/plan.md`, asks one question and
// then reports the answer it received. Words in the goal pick a variant:
//   "text"    — the question takes free text;
//   "several" — a multiple-choice question whose values are null, 0 and "0";
//   "fail"    — the provider answers with a server error instead (a provider_failure run).
// Each reply is delayed briefly so the console's working state is visible.
import { type SentInference, sse, textTurn, toolTurn, YES_NO_QUESTION } from './anthropic-network.ts';

const REPLY_DELAY_MS = 1_500;

const TEXT_QUESTION = {
  prompt: 'Anything I should keep in mind while summarizing?',
  input: { kind: 'text', minLength: 0, maxLength: 500 },
};

const SEVERAL_QUESTION = {
  prompt: 'Which of these apply? (Pick one or two.)',
  input: {
    kind: 'choice',
    multiple: true,
    minSelections: 1,
    maxSelections: 2,
    options: [
      { label: 'Unknown', value: null },
      { label: 'Zero', value: 0 },
      { label: 'The text zero', value: '0' },
    ],
  },
};

const id = (prefix: string) => `${prefix}_${crypto.randomUUID().slice(0, 8)}`;

/** The answer the model received, from the tool result that follows its question. */
function receivedAnswer(request: SentInference): unknown {
  const last = request.body.messages.at(-1)?.content as { content?: unknown }[] | undefined;
  try {
    return JSON.parse(String(last?.[0]?.content)).result?.answer;
  } catch {
    return undefined;
  }
}

export async function scriptedAgent(request: SentInference): Promise<Response> {
  await Bun.sleep(REPLY_DELAY_MS);
  const { messages } = request.body;
  const goal = JSON.stringify(messages[0]?.content ?? '').toLowerCase();
  if (goal.includes('fail')) {
    return new Response(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'Overloaded.' } }), {
      status: 500,
      headers: { 'content-type': 'application/json' },
    });
  }
  if (messages.length === 1) {
    return sse(toolTurn(id('msg'), id('toolu'), 'mcp_Read', { mode: 'file', path: 'notes/plan.md' }));
  }
  if (messages.length === 3) {
    const question = goal.includes('several')
      ? SEVERAL_QUESTION
      : goal.includes('text')
        ? TEXT_QUESTION
        : YES_NO_QUESTION;
    return sse(toolTurn(id('msg'), id('toolu'), 'mcp_AskUser', question));
  }
  return sse(
    textTurn(
      id('msg'),
      `I read notes/plan.md (three steps: build, check, publish). You answered ${JSON.stringify(receivedAnswer(request))}, so I am done.`,
    ),
  );
}
