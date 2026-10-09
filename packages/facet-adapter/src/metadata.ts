// Explicit runtime metadata (design Decision 3): only an `adapters.agent-runtime` block declaring
// `runtimeVersion: 1` gives a contribution runtime semantics. Settings for other coding tools, primary-file front
// matter and prose are never interpreted. Anything this profile cannot honor is refused, never ignored.
import { z } from 'zod';

export const assetNameSchema = z
  .string()
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
export const facetNameSchema = z
  .string()
  .max(256)
  .regex(/^(?:@[A-Za-z0-9][A-Za-z0-9._-]*\/)?[A-Za-z0-9][A-Za-z0-9._-]*$/);
const toolNameSchema = z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/);
export const NATIVE_TOOLS = ['mcp_Read', 'mcp_Search', 'mcp_AskUser'] as const;
const nativeToolSchema = z.enum(NATIVE_TOOLS);

/** An authored reference: a local item by name, or another facet's item with its facet identity. */
const authoredRefSchema = z.strictObject({ facet: facetNameSchema.optional(), name: assetNameSchema });
const mcpRefSchema = z.strictObject({
  facet: facetNameSchema.optional(),
  server: assetNameSchema,
  tool: toolNameSchema,
});

export const requirementSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('skill'), ...authoredRefSchema.shape }),
  z.strictObject({ kind: z.literal('agent'), ...authoredRefSchema.shape }),
  z.strictObject({ kind: z.literal('native'), name: nativeToolSchema }),
  z.strictObject({ kind: z.literal('mcp'), ...mcpRefSchema.shape }),
]);
export type AuthoredRequirement = z.infer<typeof requirementSchema>;

export const restrictionSchema = z.strictObject({
  native: z.array(nativeToolSchema).max(3).optional(),
  skills: z.array(authoredRefSchema).max(32).optional(),
  agents: z.array(authoredRefSchema).max(16).optional(),
  mcp: z.array(mcpRefSchema).max(64).optional(),
});
export type AuthoredRestriction = z.infer<typeof restrictionSchema>;

export type AssetKind = 'command' | 'skill' | 'agent';

export interface RuntimeMetadata {
  runtimeVersion: 1;
  requires: AuthoredRequirement[];
  /** Commands only. */
  arguments?: { required: boolean };
  /** Commands and agents only; absent means inherit. */
  restrict?: AuthoredRestriction;
}

export type MetadataResult =
  | { ok: true; description: string; runtime: RuntimeMetadata }
  | { ok: false; reason: string; fields: string[] };

// `name` and `description` are supplied by the installer beside the authored adapter block.
const installerFields = ['name', 'description'];
const fieldsByKind: Record<AssetKind, string[]> = {
  command: ['runtimeVersion', 'arguments', 'requires', 'restrict'],
  skill: ['runtimeVersion', 'requires'],
  agent: ['runtimeVersion', 'requires', 'restrict'],
};

const fieldSchemas = {
  arguments: z.strictObject({ required: z.boolean() }),
  requires: z.array(requirementSchema).max(64),
  restrict: restrictionSchema,
};

const refuse = (reason: string, fields: string[]): MetadataResult => ({ ok: false, reason, fields: fields.sort() });

/** Validates the installer-supplied metadata for one contribution; an unsupported contribution is refused. */
export function validateRuntimeMetadata(kind: AssetKind, metadata: unknown): MetadataResult {
  if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return refuse('runtime_metadata_missing', []);
  }
  const record = metadata as Record<string, unknown>;
  if (!Object.hasOwn(record, 'runtimeVersion')) return refuse('runtime_metadata_missing', ['runtimeVersion']);
  if (record.runtimeVersion !== 1) return refuse('runtime_version_unsupported', ['runtimeVersion']);

  const allowed = new Set([...installerFields, ...fieldsByKind[kind]]);
  const unsupported = Object.keys(record).filter((key) => !allowed.has(key));
  if (unsupported.length > 0) return refuse('unsupported_field', unsupported);

  const description = record.description ?? '';
  const invalid: string[] = [];
  if (typeof description !== 'string') invalid.push('description');
  const parsed: Partial<Record<keyof typeof fieldSchemas, unknown>> = {};
  for (const key of ['arguments', 'requires', 'restrict'] as const) {
    if (record[key] === undefined) continue;
    const result = fieldSchemas[key].safeParse(record[key]);
    if (result.success) parsed[key] = result.data;
    else invalid.push(key);
  }
  if (invalid.length > 0) return refuse('invalid_field', invalid);

  const requires = (parsed.requires ?? []) as AuthoredRequirement[];
  const restrict = parsed.restrict as AuthoredRestriction | undefined;
  if (kind === 'agent') {
    // One-level profile: a delegate cannot delegate, so an agent may neither require nor permit another agent.
    const nested: string[] = [];
    if (requires.some((requirement) => requirement.kind === 'agent')) nested.push('requires');
    if ((restrict?.agents?.length ?? 0) > 0) nested.push('restrict');
    if (nested.length > 0) return refuse('nested_delegation_unsupported', nested);
  }

  const runtime: RuntimeMetadata = { runtimeVersion: 1, requires };
  if (kind === 'command')
    runtime.arguments = (parsed.arguments as { required: boolean } | undefined) ?? { required: false };
  if (restrict !== undefined) runtime.restrict = restrict;
  return { ok: true, description: description as string, runtime };
}
