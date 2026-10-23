// One MCP tool call (design Decisions 5 and 10): exactly one SDK request, with no retry, reconnect, resource fetch or
// progress-extended deadline. Arguments are checked first — size, the approved raw schema and credentials — and are
// sent exactly as given. A reply becomes a fixed, credential-safe outcome: text blocks are screened whole and only
// then clipped, structured content carrying a credential is withheld, and a server's error reply or raw failure text
// is never repeated. When dispatch may have happened but its completion cannot be established (deadline,
// cancellation, a lost connection or an unreadable reply), the outcome is `uncertain`, and the process is closed and
// awaited before returning.
import { z } from 'zod';
import type { ExternalOutcome } from '../capabilities/records.ts';
import { canonicalJson } from '../records/canonical.ts';
import { type ContentPolicy, stringsIn } from '../security/content-policy.ts';
import { TOOL_RESULT_MAX_BYTES } from '../security/pre-graph.ts';
import { largestFitting } from '../workspace/results.ts';
import { deadline } from './deadline.ts';
import type { ArgumentValidator } from './schema.ts';
import { closeSession, type McpSession } from './session.ts';

export const CALL_LIMITS = Object.freeze({ argumentBytes: 32 * 1024, structuredBytes: 32 * 1024 });
const ENVELOPE_RESERVE = 512;
const CLIPPED = '\n[result clipped]';
// JSON-RPC codes the SDK raises itself for a connection or deadline it gave up on; any other error code is a reply.
const LOCAL_ERROR_CODES = new Set([-32000, -32001]);

const rawResultSchema = z.looseObject({
  content: z.array(z.record(z.string(), z.unknown())).optional(),
  structuredContent: z.record(z.string(), z.unknown()).optional(),
  isError: z.boolean().optional(),
});

export interface CallInput {
  session: McpSession;
  toolName: string;
  /** The model's original arguments; never rewritten, defaulted or coerced. */
  args: Record<string, unknown>;
  validate: ArgumentValidator;
  timeoutMs: number;
  /** The run's cancellation. */
  signal: AbortSignal;
  policy: ContentPolicy;
  operationId: string;
  /**
   * The caller's dispatch admission. It receives `send`, which hands the request to the transport at once, and must
   * call it before releasing its dispatch gate, or not at all. Without it the request is sent directly.
   */
  admit?: (send: () => void) => Promise<void>;
}

export interface CallResult {
  outcome: ExternalOutcome;
  /** Whether a request was handed to the transport. */
  dispatched: boolean;
  /** Whether the session was closed (after a deadline, cancellation or broken connection). */
  closed: boolean;
}

const utf8 = new TextEncoder();
const bytes = (text: string) => utf8.encode(text).byteLength;
const fail = (kind: 'refused' | 'unavailable' | 'failed', reason: string, message: string): ExternalOutcome => ({
  kind,
  reason,
  message,
});

/** Checks before anything is sent. A refusal here means the request was never dispatched. */
export function checkArguments(input: Pick<CallInput, 'args' | 'validate' | 'policy'>): ExternalOutcome | undefined {
  let serialized: string;
  try {
    serialized = canonicalJson(input.args);
  } catch {
    return fail('refused', 'arguments_invalid', 'The tool arguments are not valid JSON data.');
  }
  if (bytes(serialized) > CALL_LIMITS.argumentBytes) {
    return fail('refused', 'arguments_too_large', 'The tool arguments exceed 32 KiB.');
  }
  for (const text of stringsIn(input.args)) {
    if (input.policy.detect(text) !== undefined) {
      return fail('refused', 'credential_in_arguments', 'The tool arguments contain credential material.');
    }
  }
  if (!input.validate(input.args)) {
    return fail('refused', 'arguments_invalid', "The tool arguments do not match the tool's approved input schema.");
  }
  return undefined;
}

/** The safe outcome of a completed reply. */
export function projectResult(raw: unknown, policy: ContentPolicy): ExternalOutcome {
  const parsed = rawResultSchema.safeParse(raw);
  if (!parsed.success || 'task' in (raw as Record<string, unknown>)) {
    return fail('failed', 'mcp_result_unsupported', 'The tool replied in a form this runtime does not support.');
  }
  if (parsed.data.isError === true) {
    return fail('failed', 'mcp_tool_error', 'The tool reported an error.');
  }
  const blocks = parsed.data.content ?? [];
  const texts = blocks
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text as string);
  let text: string | undefined;
  if (texts.length > 0) {
    // Screened as a whole before anything is clipped, so a credential cannot be cut in two.
    const whole = policy.redact(texts.join('\n'));
    text = policy.detect(whole) === undefined ? whole : undefined;
  }
  let json: Record<string, unknown> | undefined = parsed.data.structuredContent;
  if (json !== undefined) {
    let serialized: string | undefined;
    try {
      serialized = canonicalJson(json);
    } catch {
      serialized = undefined;
    }
    const credential = [...stringsIn(json)].some((value) => policy.detect(value) !== undefined);
    if (serialized === undefined || credential || bytes(serialized) > CALL_LIMITS.structuredBytes) json = undefined;
  }
  if (text === undefined && json === undefined) {
    const withheld = texts.length > 0 || parsed.data.structuredContent !== undefined;
    return withheld
      ? fail('failed', 'mcp_result_withheld', 'The tool result could not be returned safely and was withheld.')
      : fail(
          'failed',
          'mcp_result_unsupported',
          'The tool returned no text or structured result this runtime supports.',
        );
  }
  const outcome: ExternalOutcome = { kind: 'ok', ...(json === undefined ? {} : { json: json as never }) };
  if (text === undefined) return outcome;
  const fits = (candidate: string) =>
    bytes(JSON.stringify({ ...outcome, text: candidate })) + ENVELOPE_RESERVE <= TOOL_RESULT_MAX_BYTES;
  if (fits(text)) return { ...outcome, text };
  const clipped = largestFitting(text, (prefix) => fits(`${prefix}${CLIPPED}`));
  return { ...outcome, text: `${clipped}${CLIPPED}` };
}

/**
 * Makes the call. The caller has already established authority; durable dispatch intent is recorded by `admit`
 * (or was established by the caller).
 */
export async function callTool(input: CallInput): Promise<CallResult> {
  const refused = checkArguments(input);
  if (refused !== undefined) return { outcome: refused, dispatched: false, closed: false };
  if (input.signal.aborted) {
    return {
      outcome: fail('refused', 'cancelled', 'The run was cancelled before the call.'),
      dispatched: false,
      closed: false,
    };
  }
  if (input.session.client.transport === undefined) {
    return {
      outcome: fail('unavailable', 'mcp_server_unavailable', 'The server connection is no longer available.'),
      dispatched: false,
      closed: false,
    };
  }
  const uncertain = (reason: string, message: string): ExternalOutcome => ({
    kind: 'uncertain',
    reason,
    message,
    operationId: input.operationId,
  });
  let oversized = false;
  const previous = input.session.client.onerror;
  input.session.client.onerror = (error) => {
    // SDK-generated, never server text: only used to name the outcome.
    if (error.message.startsWith('ReadBuffer exceeded maximum size')) oversized = true;
  };
  const limit = deadline(input.timeoutMs, input.signal);
  try {
    let pending: Promise<unknown> | undefined;
    // The SDK writes the request to the transport synchronously within `request()`.
    const send = () => {
      pending = input.session.client.request(
        { method: 'tools/call', params: { name: input.toolName, arguments: input.args } },
        rawResultSchema,
        limit.requestOptions(),
      );
      pending.catch(() => {});
    };
    if (input.admit === undefined) send();
    else await input.admit(send);
    if (pending === undefined) {
      return {
        outcome: fail('refused', 'not_admitted', 'The call was not admitted for dispatch.'),
        dispatched: false,
        closed: false,
      };
    }
    let raw: unknown;
    try {
      raw = await pending;
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      if (typeof code === 'number' && !LOCAL_ERROR_CODES.has(code) && !limit.expired() && !oversized) {
        // A JSON-RPC error reply: the server answered, and reported failure.
        return {
          outcome: fail('failed', 'mcp_call_error', 'The server rejected the tool call.'),
          dispatched: true,
          closed: false,
        };
      }
      const closed = await closeSession(input.session);
      const outcome = input.signal.aborted
        ? uncertain('mcp_call_cancelled', 'The run was cancelled after the call was sent; its effect is unknown.')
        : oversized
          ? uncertain('mcp_response_too_large', 'The reply exceeded 1 MiB and was discarded; the effect is unknown.')
          : limit.expired()
            ? uncertain('mcp_call_timeout', 'The tool did not reply in time; its effect is unknown.')
            : uncertain('mcp_outcome_unknown', 'The connection ended before the tool replied; its effect is unknown.');
      return { outcome, dispatched: true, closed };
    }
    return { outcome: projectResult(raw, input.policy), dispatched: true, closed: false };
  } finally {
    limit.dispose();
    input.session.client.onerror = previous;
  }
}
