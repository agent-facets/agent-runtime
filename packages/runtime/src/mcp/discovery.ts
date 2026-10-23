// Bounded tool discovery (design Decisions 5 and 10). Listing pages are requested through the SDK's generic request
// with a raw result schema, so nothing compiles or caches a server's schemas before they are checked here. A listing
// is bounded in pages and tools and must have unique names and a progressing cursor; anything else refuses the whole
// discovery. Within a valid listing each tool is judged on its own: its size, closed input schema, output schema
// bounds, task requirement and credential content. A refused tool keeps only its name and reason, never its text.
// Discovery is an inventory, not an approval, and never calls a tool.
import { mcpToolNameSchema } from '@agent-runtime/contracts';
import { z } from 'zod';
import { CAPABILITY_LIMITS, schemaShape } from '../capabilities/records.ts';
import { canonicalJson, digestOf } from '../records/canonical.ts';
import { type ContentPolicy, stringsIn } from '../security/content-policy.ts';
import { type Deadline, deadline } from './deadline.ts';
import { checkInputSchema, type SchemaRefusal } from './schema.ts';
import { closeSession, type McpSession, openSession, type SessionOpen } from './session.ts';
import type { StdioServerParameters } from './transport.ts';

export const DISCOVERY_LIMITS = Object.freeze({ deadlineMs: 15_000, pages: 8, tools: 128 });

export type ToolRefusal =
  | SchemaRefusal
  | 'tool_name_unsupported'
  | 'definition_too_large'
  | 'definition_invalid'
  | 'output_schema_unsupported'
  | 'task_required'
  | 'credential_in_definition';

export type DiscoveredTool =
  | { name: string; status: 'supported'; raw: Record<string, unknown>; definitionDigest: string }
  | { name: string; status: 'refused'; reason: ToolRefusal };

export type Discovery =
  | { ok: true; tools: DiscoveredTool[] }
  | {
      ok: false;
      reason:
        | 'listing_invalid'
        | 'too_many_pages'
        | 'too_many_tools'
        | 'discovery_timeout'
        | 'discovery_failed'
        | 'cancelled';
    };

/** One raw `tools/list` page, as the server sent it. */
export type ListPage = (
  cursor: string | undefined,
  options: ReturnType<Deadline['requestOptions']>,
) => Promise<unknown>;

const pageSchema = z.looseObject({
  tools: z.array(z.record(z.string(), z.unknown())),
  nextCursor: z.string().max(1024).optional(),
});
/** The result schema handed to the SDK: structure only, no interpretation of the tools themselves. */
export const RAW_LIST_RESULT = pageSchema;

const utf8 = new TextEncoder();
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** A tool's own verdict within a valid listing. */
export function judgeTool(raw: Record<string, unknown>, policy: ContentPolicy): DiscoveredTool {
  const name = raw.name as string;
  const refuse = (reason: ToolRefusal): DiscoveredTool => ({ name, status: 'refused', reason });
  if (!mcpToolNameSchema.safeParse(name).success) return refuse('tool_name_unsupported');
  let canonical: string;
  try {
    canonical = canonicalJson(raw);
  } catch {
    return refuse('definition_invalid');
  }
  if (utf8.encode(canonical).byteLength > CAPABILITY_LIMITS.toolDefinitionBytes) return refuse('definition_too_large');
  for (const text of stringsIn(raw)) if (policy.detect(text) !== undefined) return refuse('credential_in_definition');
  if (raw.description !== undefined && typeof raw.description !== 'string') return refuse('definition_invalid');
  const execution = raw.execution;
  if (isRecord(execution) && execution.taskSupport === 'required') return refuse('task_required');
  const input = checkInputSchema(raw.inputSchema);
  if (!input.ok) return refuse(input.reason);
  if (raw.outputSchema !== undefined) {
    const output = raw.outputSchema;
    if (!isRecord(output) || output.type !== 'object') return refuse('output_schema_unsupported');
    const inputShape = schemaShape(raw.inputSchema);
    const outputShape = schemaShape(output);
    if (
      Math.max(inputShape.depth, outputShape.depth) > CAPABILITY_LIMITS.schemaDepth ||
      inputShape.properties + outputShape.properties > CAPABILITY_LIMITS.schemaProperties
    ) {
      return refuse('output_schema_unsupported');
    }
  }
  return { name, status: 'supported', raw, definitionDigest: digestOf(raw) };
}

/** Lists every tool within the deadline and bounds, then judges each. */
export async function discoverTools(input: {
  listPage: ListPage;
  limit: Deadline;
  policy: ContentPolicy;
  outer?: AbortSignal;
}): Promise<Discovery> {
  const { listPage, limit, policy, outer } = input;
  const raws: Record<string, unknown>[] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; ; page++) {
    if (page >= DISCOVERY_LIMITS.pages) return { ok: false, reason: 'too_many_pages' };
    let result: unknown;
    try {
      result = await listPage(cursor, limit.requestOptions());
    } catch {
      if (outer?.aborted) return { ok: false, reason: 'cancelled' };
      return { ok: false, reason: limit.expired() ? 'discovery_timeout' : 'discovery_failed' };
    }
    const parsed = pageSchema.safeParse(result);
    if (!parsed.success) return { ok: false, reason: 'listing_invalid' };
    raws.push(...parsed.data.tools);
    if (raws.length > DISCOVERY_LIMITS.tools) return { ok: false, reason: 'too_many_tools' };
    cursor = parsed.data.nextCursor;
    if (cursor === undefined) break;
    if (cursors.has(cursor)) return { ok: false, reason: 'listing_invalid' };
    cursors.add(cursor);
  }
  const names = new Set<string>();
  for (const raw of raws) {
    const name = raw.name;
    if (typeof name !== 'string' || name.length === 0 || name.length > 256 || names.has(name)) {
      return { ok: false, reason: 'listing_invalid' };
    }
    names.add(name);
  }
  return { ok: true, tools: raws.map((raw) => judgeTool(raw, policy)) };
}

/** The session's raw `tools/list` request, for bounded discovery. */
export function sessionListPage(session: McpSession): ListPage {
  return (cursor, options) =>
    session.client.request(
      { method: 'tools/list', ...(cursor === undefined ? {} : { params: { cursor } }) },
      RAW_LIST_RESULT,
      options,
    );
}

/**
 * Inspects an approved server: starts it, initializes, lists its tools and closes it, all within one 15-second
 * deadline. Nothing is called and nothing is approved.
 */
export async function inspectServer(input: {
  params: StdioServerParameters;
  policy: ContentPolicy;
  outer?: AbortSignal;
  deadlineMs?: number;
  transportFor?: Parameters<typeof openSession>[3];
}): Promise<Discovery | Extract<SessionOpen, { ok: false }>> {
  const limit = deadline(input.deadlineMs ?? DISCOVERY_LIMITS.deadlineMs, input.outer);
  try {
    const opened = await openSession(input.params, limit, input.outer, input.transportFor);
    if (!opened.ok) return opened;
    try {
      return await discoverTools({
        listPage: sessionListPage(opened.session),
        limit,
        policy: input.policy,
        ...(input.outer === undefined ? {} : { outer: input.outer }),
      });
    } finally {
      await closeSession(opened.session);
    }
  } finally {
    limit.dispose();
  }
}
