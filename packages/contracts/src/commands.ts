// Command envelopes accepted by the API. They carry identities and owner input only: a client cannot nominate a
// workspace, endpoint, model, tool set, checkpoint, credential or configuration. Unknown fields are refused, not
// stripped. Credential screening of goals and answers happens on the server, which alone can recognize this
// runtime's live credentials.
import { z } from 'zod';
import { commandIdSchema, TASK_TEXT_MAX_BYTES } from './capabilities.ts';
import { digestSchema, providerSchema, uuidSchema } from './common.ts';
import { isStorableText, utf8Bytes } from './text.ts';

export const GOAL_MAX_BYTES = 8192;
/** A command's raw argument text shares the goal limit; blank is allowed here and judged by the command. */
export const COMMAND_ARGUMENTS_MAX_BYTES = TASK_TEXT_MAX_BYTES;

export type CommandErrorCode =
  | 'invalid_request'
  | 'goal_required'
  | 'goal_too_long'
  | 'goal_not_storable'
  | 'command_arguments_invalid';

export type CommandResult<T> = { ok: true; value: T } | { ok: false; code: CommandErrorCode; field?: string };

const startRunSchema = z.strictObject({ requestId: uuidSchema, goal: z.string(), provider: providerSchema });
export type StartRunCommand = z.infer<typeof startRunSchema>;

/** Goals are kept exactly as submitted; blank goals, oversized goals and unstorable text are refused. */
export function parseStartRun(body: unknown): CommandResult<StartRunCommand> {
  const parsed = startRunSchema.safeParse(body);
  if (!parsed.success) return { ok: false, code: 'invalid_request', field: firstPath(parsed.error) };
  const { goal } = parsed.data;
  if (!/\S/.test(goal)) return { ok: false, code: 'goal_required', field: 'goal' };
  if (!isStorableText(goal)) return { ok: false, code: 'goal_not_storable', field: 'goal' };
  if (utf8Bytes(goal) > GOAL_MAX_BYTES) return { ok: false, code: 'goal_too_long', field: 'goal' };
  return { ok: true, value: parsed.data };
}

const startCommandRunSchema = z.strictObject({
  requestId: uuidSchema,
  provider: providerSchema,
  command: z.strictObject({ id: commandIdSchema, selectionRevision: digestSchema, arguments: z.string() }),
});
export type StartCommandRunCommand = z.infer<typeof startCommandRunSchema>;

/** A start request is exactly one of a free-form goal or an installed command with its raw argument text. */
export type StartRunRequest = ({ kind: 'goal' } & StartRunCommand) | ({ kind: 'command' } & StartCommandRunCommand);

/**
 * Parses either start form. Supplying both or neither is invalid, and a command start can carry nothing but the
 * command's ID, the selection revision it was offered under and its raw arguments: no prompt, graph, path, grant,
 * endpoint or credential reference. Arguments are kept exactly as submitted.
 */
export function parseStartRunRequest(body: unknown): CommandResult<StartRunRequest> {
  const record = typeof body === 'object' && body !== null && !Array.isArray(body) ? body : undefined;
  const hasGoal = record !== undefined && Object.hasOwn(record, 'goal');
  const hasCommand = record !== undefined && Object.hasOwn(record, 'command');
  if (hasGoal && hasCommand) return { ok: false, code: 'invalid_request', field: 'command' };
  if (!hasCommand) {
    const goal = parseStartRun(body);
    return goal.ok ? { ok: true, value: { kind: 'goal', ...goal.value } } : goal;
  }
  const parsed = startCommandRunSchema.safeParse(body);
  if (!parsed.success) return { ok: false, code: 'invalid_request', field: firstPath(parsed.error) };
  const text = parsed.data.command.arguments;
  if (!isStorableText(text) || utf8Bytes(text) > COMMAND_ARGUMENTS_MAX_BYTES) {
    return { ok: false, code: 'command_arguments_invalid', field: 'command.arguments' };
  }
  return { ok: true, value: { kind: 'command', ...parsed.data } };
}

/**
 * An answer submission is exactly `{ answer }`. Only the envelope is checked here; the value is validated against
 * the targeted question by canonicalAnswer. `answer: false`, `null`, `0` and `""` are present answers.
 */
export function parseAnswerSubmission(body: unknown): CommandResult<{ answer: unknown }> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return { ok: false, code: 'invalid_request' };
  const keys = Object.keys(body);
  if (keys.length !== 1 || keys[0] !== 'answer') {
    return { ok: false, code: 'invalid_request', field: safeField(keys.find((key) => key !== 'answer') ?? 'answer') };
  }
  return { ok: true, value: { answer: (body as { answer: unknown }).answer } };
}

const cancelRunSchema = z.strictObject({ requestId: uuidSchema });
export type CancelRunCommand = z.infer<typeof cancelRunSchema>;

export function parseCancelRun(body: unknown): CommandResult<CancelRunCommand> {
  const parsed = cancelRunSchema.safeParse(body);
  return parsed.success
    ? { ok: true, value: parsed.data }
    : { ok: false, code: 'invalid_request', field: firstPath(parsed.error) };
}

/** Client-supplied field names are echoed only when they look like ordinary identifiers. */
function safeField(name: string | undefined): string | undefined {
  return name !== undefined && /^[A-Za-z][A-Za-z0-9_]{0,63}(?:\.[A-Za-z][A-Za-z0-9_]{0,63}){0,2}$/.test(name)
    ? name
    : undefined;
}

function firstPath(error: z.ZodError): string | undefined {
  const issue = error.issues[0];
  if (issue === undefined) return undefined;
  if (issue.code === 'unrecognized_keys') return safeField(issue.keys[0]);
  return safeField(issue.path.map(String).join('.') || undefined);
}
