// Command envelopes accepted from the browser API. They carry identities and owner input only: a client cannot
// nominate a workspace, endpoint, model, tool set, checkpoint, credential or configuration. Unknown fields are
// refused, not stripped. Credential screening of goals and answers is applied separately (security/).
import { z } from 'zod';
import { isStorableText, utf8Bytes } from '../domain/text.ts';
import { providerSchema } from '../records/schemas.ts';

export const GOAL_MAX_BYTES = 8192;

export type CommandErrorCode = 'invalid_request' | 'goal_required' | 'goal_too_long' | 'goal_not_storable';

export type CommandResult<T> = { ok: true; value: T } | { ok: false; code: CommandErrorCode; field?: string };

const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

const startRunSchema = z.strictObject({ requestId: uuid, goal: z.string(), provider: providerSchema });
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

/** Client-supplied field names are echoed only when they look like ordinary identifiers. */
function safeField(name: string | undefined): string | undefined {
  return name !== undefined && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name) ? name : undefined;
}

function firstPath(error: z.ZodError): string | undefined {
  const issue = error.issues[0];
  if (issue === undefined) return undefined;
  if (issue.code === 'unrecognized_keys') return safeField(issue.keys[0]);
  return safeField(issue.path.map(String).join('.') || undefined);
}
