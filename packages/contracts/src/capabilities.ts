// Facet-backed capability identities shared by the server and the browser (design Decisions 6, 8 and 9): public
// contribution references, the agent that performed recorded activity, and how a tool call was bound. Private
// checkpoint bindings, credential slots and environment values never appear here.
import { z } from 'zod';
import { digestSchema } from './common.ts';
import { isStorableText, utf8Bytes } from './text.ts';

/** A facet item's effective (post-alias) name. */
export const effectiveNameSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,127}$/);
export const contributionKindSchema = z.enum(['command', 'skill', 'agent']);
export type ContributionKind = z.infer<typeof contributionKindSchema>;

const contributionId = (kind: ContributionKind) => z.string().regex(new RegExp(`^${kind}:[a-z0-9][a-z0-9._-]{0,127}$`));
/** Public contribution IDs are `<kind>:<effective-name>`. */
export const commandIdSchema = contributionId('command');
export const skillIdSchema = contributionId('skill');
export const agentIdSchema = contributionId('agent');
export const contributionIdSchema = z.union([commandIdSchema, skillIdSchema, agentIdSchema]);

/** An MCP server's effective declared name; also a private state-directory name, so deliberately narrow. */
export const serverIdSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/);
export const mcpToolNameSchema = z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/);
/**
 * An MCP tool's canonical agent-tool name: `mcp_<serverId>_<toolName>`, both components spelled exactly as given.
 * It is a readable name, not an identity — underscores make the components ambiguous, so the server/tool pair is
 * always kept alongside it. Built-in tools (`mcp_` then an uppercase letter) can never take this form.
 */
export const mcpCanonicalToolName = (serverId: string, toolName: string) => `mcp_${serverId}_${toolName}`;
/** The longest tool name a call can be recorded under: a canonical MCP name with both components at their limits. */
export const TOOL_CALL_NAME_MAX = 197;
export const nativeToolSchema = z.enum(['mcp_Read', 'mcp_Search', 'mcp_AskUser']);
export type NativeTool = z.infer<typeof nativeToolSchema>;

/** Canonical skill-relative resource path: plain segments only, no traversal, absolute or empty parts. */
export const resourcePathSchema = z
  .string()
  .max(512)
  .regex(/^[A-Za-z0-9_-][A-Za-z0-9._-]*(?:\/[A-Za-z0-9_-][A-Za-z0-9._-]*)*$/)
  .refine((path) => path.split('/').every((segment) => segment !== '.' && segment !== '..'), 'unsafe path');

/** Text bounded in UTF-8 bytes; `nonEmpty` additionally requires a non-whitespace character. */
export const boundedText = (maxBytes: number, options: { nonBlank?: boolean } = {}) =>
  z
    .string()
    .refine(isStorableText, 'text must be well-formed Unicode without NUL')
    .refine((text) => utf8Bytes(text) <= maxBytes, `must be at most ${maxBytes} UTF-8 bytes`)
    .refine((text) => !options.nonBlank || /\S/.test(text), 'must not be blank');

/** Rendered command goals and delegate tasks share the existing goal limit. */
export const TASK_TEXT_MAX_BYTES = 8192;

/** The agent responsible for recorded activity. A delegate is identified by its delegation, never only its name. */
export const actorRefSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('root') }),
  z.strictObject({ kind: z.literal('delegate'), delegationId: digestSchema, agentId: agentIdSchema }),
]);
export type ActorRef = z.infer<typeof actorRefSchema>;

/** What a tool call was bound to when it was admitted, by public reference. */
export const toolBindingSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('native'), name: nativeToolSchema }),
  z.strictObject({ kind: z.literal('skill_load'), skillId: skillIdSchema }),
  z.strictObject({ kind: z.literal('skill_reference'), skillId: skillIdSchema, path: resourcePathSchema }),
  z.strictObject({ kind: z.literal('delegation'), agentId: agentIdSchema }),
  z.strictObject({
    kind: z.literal('mcp'),
    serverId: serverIdSchema,
    toolName: mcpToolNameSchema,
    definitionDigest: digestSchema,
  }),
]);
export type ToolBinding = z.infer<typeof toolBindingSchema>;

/** How a delegation ended, as shown in history; the detailed outcome stays with its operation. */
export const delegationEndSchema = z.enum(['result', 'refused', 'failed', 'abandoned']);

export const commandEventSchema = z.strictObject({
  commandId: commandIdSchema,
  selectionRevision: digestSchema,
  arguments: boundedText(TASK_TEXT_MAX_BYTES),
  snapshotDigest: digestSchema,
});

export const delegationStartedSchema = z.strictObject({
  delegationId: digestSchema,
  agentId: agentIdSchema,
  parentActor: actorRefSchema,
  task: boundedText(TASK_TEXT_MAX_BYTES, { nonBlank: true }),
});

export const delegationFinishedSchema = z.strictObject({
  delegationId: digestSchema,
  outcome: delegationEndSchema,
  operationId: digestSchema,
});
