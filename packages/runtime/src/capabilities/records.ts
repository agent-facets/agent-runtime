// Closed, versioned capability records (design Decisions 6–8 and 10): the immutable definitions a command run
// retains, its actors, loaded-skill membership and the delegate and external outcome unions. Strict decoders refuse
// unknown fields and every bound is a named refusal, never truncation. These are server records; the browser only
// receives the public references in the contracts package.
import {
  type actorRefSchema,
  agentIdSchema,
  boundedText,
  commandIdSchema,
  digestSchema,
  effectiveNameSchema,
  mcpToolNameSchema,
  nativeToolSchema,
  providerSchema,
  reasonCodeSchema,
  resourcePathSchema,
  scalarSchema,
  serverIdSchema,
  skillIdSchema,
  TASK_TEXT_MAX_BYTES,
} from '@agent-runtime/contracts';
import { z } from 'zod';
import { canonicalJson, sha256Hex } from '../records/canonical.ts';

export const CAPABILITY_LIMITS = Object.freeze({
  snapshotBytes: 16 * 1024 * 1024,
  contributions: 128,
  skills: 32,
  agents: 16,
  commands: 32,
  servers: 8,
  skillInstructionBytes: 48 * 1024,
  referenceBytes: 1024 * 1024,
  taskBytes: TASK_TEXT_MAX_BYTES,
  boundTools: 64,
  toolDefinitionBytes: 32 * 1024,
  schemaDepth: 8,
  schemaProperties: 256,
  delegationsDefault: 8,
  delegationsMaximum: 32,
  delegationDepth: 1,
});

const utf8 = new TextEncoder();
const byteLength = (value: unknown) => utf8.encode(canonicalJson(value)).byteLength;
const unique = (values: readonly string[]) => new Set(values).size === values.length;
const plainText = (max: number) => boundedText(max).refine((text) => !/\p{Cc}/u.test(text), 'control characters');
const programIdSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/);
const jsonObject = z.record(z.string(), z.json());

export const actorKeySchema = z.union([z.literal('root'), digestSchema]);
export type ActorKey = z.infer<typeof actorKeySchema>;

/** The storage key of an actor reference: `root`, or the delegation's operation ID. */
export function actorKeyOf(actor: z.infer<typeof actorRefSchema>): ActorKey {
  return actor.kind === 'root' ? 'root' : actor.delegationId;
}

const originSchema = z.strictObject({
  facet: z.string().regex(/^[A-Za-z0-9@][A-Za-z0-9@/._-]{0,255}$/),
  version: plainText(128).pipe(z.string().min(1)),
  source: plainText(1024).pipe(z.string().min(1)),
  integrity: plainText(256).pipe(z.string().min(1)),
});

const mcpToolRefSchema = z.strictObject({ serverId: serverIdSchema, toolName: mcpToolNameSchema });

/** A resolved, explicitly declared prerequisite; prose is never interpreted as one. */
export const requirementSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('skill'), id: skillIdSchema }),
  z.strictObject({ kind: z.literal('agent'), id: agentIdSchema }),
  z.strictObject({ kind: z.literal('native'), name: nativeToolSchema }),
  z.strictObject({ kind: z.literal('mcp'), ...mcpToolRefSchema.shape }),
]);

/** Allowlists that only narrow: absent inherits, empty denies the category. */
export const restrictionSchema = z.strictObject({
  native: z.array(nativeToolSchema).max(3).refine(unique, 'duplicate entry').optional(),
  skills: z.array(skillIdSchema).max(CAPABILITY_LIMITS.skills).refine(unique, 'duplicate entry').optional(),
  agents: z.array(agentIdSchema).max(CAPABILITY_LIMITS.agents).refine(unique, 'duplicate entry').optional(),
  mcp: z
    .array(mcpToolRefSchema)
    .max(CAPABILITY_LIMITS.boundTools)
    .refine((refs) => unique(refs.map((ref) => `${ref.serverId}/${ref.toolName}`)), 'duplicate entry')
    .optional(),
});

const base = {
  name: effectiveNameSchema,
  description: plainText(1024),
  origins: z.array(originSchema).min(1).max(16),
  exportDigest: digestSchema,
  requires: z.array(requirementSchema).max(64),
};
const nameMatchesId = (definition: { id: string; name: string }) => definition.id.endsWith(`:${definition.name}`);

export const commandDefinitionSchema = z
  .strictObject({
    id: commandIdSchema,
    ...base,
    body: boundedText(CAPABILITY_LIMITS.taskBytes),
    arguments: z.strictObject({ required: z.boolean() }),
    restrict: restrictionSchema.optional(),
  })
  .refine(nameMatchesId, 'id does not match name');

/** Bundled bytes are kept losslessly; only validated UTF-8 text is ever readable by an agent. */
export const skillResourceSchema = z
  .strictObject({
    path: resourcePathSchema,
    byteLength: z.number().int().min(0).max(CAPABILITY_LIMITS.referenceBytes),
    sha256: digestSchema,
    content: z.base64(),
  })
  .refine((resource) => {
    const bytes = Buffer.from(resource.content, 'base64');
    const digest = new Bun.CryptoHasher('sha256').update(bytes).digest('hex');
    return (
      bytes.byteLength === resource.byteLength &&
      bytes.toString('base64') === resource.content &&
      digest === resource.sha256
    );
  }, 'resource content does not match its length and digest');

export const skillDefinitionSchema = z
  .strictObject({
    id: skillIdSchema,
    ...base,
    instructions: boundedText(CAPABILITY_LIMITS.skillInstructionBytes, { nonBlank: true }),
    resources: z
      .array(skillResourceSchema)
      .max(256)
      .refine((resources) => unique(resources.map((resource) => resource.path)), 'duplicate resource path'),
  })
  .refine(nameMatchesId, 'id does not match name');

export const agentDefinitionSchema = z
  .strictObject({
    id: agentIdSchema,
    ...base,
    instructions: boundedText(CAPABILITY_LIMITS.skillInstructionBytes, { nonBlank: true }),
    restrict: restrictionSchema.optional(),
  })
  .refine(nameMatchesId, 'id does not match name');

export const serverDefinitionSchema = z
  .strictObject({
    serverId: serverIdSchema,
    origins: z.array(originSchema).min(1).max(16),
    declaration: jsonObject,
    programId: programIdSchema,
    serverDigest: digestSchema,
  })
  .refine((server) => byteLength(server.declaration) <= CAPABILITY_LIMITS.toolDefinitionBytes, 'declaration too large');

/**
 * Nesting depth through `properties`/`items`, and the number of property entries, across a raw tool definition's
 * schemas. The full closed schema profile is checked before discovery results are used; these are size bounds.
 */
export function schemaShape(schema: unknown, depth = 1): { depth: number; properties: number } {
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) return { depth: 0, properties: 0 };
  let deepest = depth;
  let properties = 0;
  const record = schema as Record<string, unknown>;
  const children: unknown[] = [];
  if (record.properties !== null && typeof record.properties === 'object' && !Array.isArray(record.properties)) {
    const entries = Object.values(record.properties);
    properties += entries.length;
    children.push(...entries);
  }
  if (record.items !== undefined) children.push(record.items);
  for (const child of children) {
    const shape = schemaShape(child, depth + 1);
    deepest = Math.max(deepest, shape.depth);
    properties += shape.properties;
  }
  return { depth: deepest, properties };
}

export const mcpToolDefinitionSchema = z
  .strictObject({
    serverId: serverIdSchema,
    toolName: mcpToolNameSchema,
    /** The raw advertised definition, as approved; never the adapter-simplified one. */
    raw: jsonObject,
    definitionDigest: digestSchema,
    adapted: z.strictObject({
      name: z.string().regex(/^mcp_ext_[0-9a-f]{48}$/),
      description: plainText(CAPABILITY_LIMITS.toolDefinitionBytes),
      schema: jsonObject,
    }),
  })
  .refine((tool) => tool.raw.name === tool.toolName, 'raw definition name does not match')
  .refine((tool) => byteLength(tool.raw) <= CAPABILITY_LIMITS.toolDefinitionBytes, 'tool definition too large')
  .refine((tool) => {
    const input = schemaShape(tool.raw.inputSchema);
    const output = schemaShape(tool.raw.outputSchema);
    return (
      Math.max(input.depth, output.depth) <= CAPABILITY_LIMITS.schemaDepth &&
      input.properties + output.properties <= CAPABILITY_LIMITS.schemaProperties
    );
  }, 'tool schema exceeds depth or property bounds');

const toolGrantSchema = z.strictObject({
  name: mcpToolNameSchema,
  definitionDigest: digestSchema,
  argumentEquals: z.record(z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/), scalarSchema),
});

/** The authority a run was created under. Current owner grants can only narrow it at dispatch. */
export const authorityCeilingSchema = z.strictObject({
  native: z.array(nativeToolSchema).max(3).refine(unique, 'duplicate entry'),
  skills: z.array(skillIdSchema).max(CAPABILITY_LIMITS.skills).refine(unique, 'duplicate entry'),
  agents: z.array(agentIdSchema).max(CAPABILITY_LIMITS.agents).refine(unique, 'duplicate entry'),
  servers: z
    .array(
      z.strictObject({
        serverId: serverIdSchema,
        serverDigest: digestSchema,
        tools: z
          .array(toolGrantSchema)
          .max(CAPABILITY_LIMITS.boundTools)
          .refine((tools) => unique(tools.map((tool) => tool.name)), 'duplicate tool grant'),
      }),
    )
    .max(CAPABILITY_LIMITS.servers)
    .refine((servers) => unique(servers.map((server) => server.serverId)), 'duplicate server'),
});

export const capabilitySnapshotSchema = z
  .strictObject({
    version: z.literal(1),
    /** The supported interpretation profile for runtime facet metadata. */
    profile: z.literal(1),
    installation: z.strictObject({ sha256: digestSchema }),
    command: commandDefinitionSchema,
    input: z.strictObject({
      arguments: boundedText(CAPABILITY_LIMITS.taskBytes),
      renderedGoal: boundedText(CAPABILITY_LIMITS.taskBytes, { nonBlank: true }),
    }),
    skills: z.array(skillDefinitionSchema).max(CAPABILITY_LIMITS.skills),
    agents: z.array(agentDefinitionSchema).max(CAPABILITY_LIMITS.agents),
    servers: z.array(serverDefinitionSchema).max(CAPABILITY_LIMITS.servers),
    tools: z.array(mcpToolDefinitionSchema).max(CAPABILITY_LIMITS.boundTools),
    authority: authorityCeilingSchema,
    limits: z.strictObject({
      maxDelegations: z.number().int().min(1).max(CAPABILITY_LIMITS.delegationsMaximum),
      delegationDepth: z.literal(CAPABILITY_LIMITS.delegationDepth),
    }),
  })
  .refine(
    (snapshot) =>
      unique([
        snapshot.command.id,
        ...snapshot.skills.map((skill) => skill.id),
        ...snapshot.agents.map((agent) => agent.id),
      ]),
    'duplicate contribution',
  )
  .refine((snapshot) => unique(snapshot.servers.map((server) => server.serverId)), 'duplicate server')
  .refine(
    (snapshot) => unique(snapshot.tools.map((tool) => `${tool.serverId}/${tool.toolName}`)),
    'duplicate tool definition',
  )
  .refine((snapshot) => unique(snapshot.tools.map((tool) => tool.adapted.name)), 'colliding model-facing tool name')
  .refine((snapshot) => {
    const servers = new Set(snapshot.servers.map((server) => server.serverId));
    return snapshot.tools.every((tool) => servers.has(tool.serverId));
  }, 'tool without a retained server');
export type CapabilitySnapshot = z.infer<typeof capabilitySnapshotSchema>;

export class CapabilityRecordError extends Error {
  override readonly name = 'CapabilityRecordError';
  constructor(
    readonly reason: 'snapshot_invalid' | 'snapshot_too_large' | 'snapshot_digest_mismatch',
    message: string,
  ) {
    super(message);
  }
}

/** A validated snapshot with its canonical bytes and content address (SHA-256 of canonical JSON). */
export function sealSnapshot(value: unknown): { digest: string; payload: CapabilitySnapshot; canonical: string } {
  const parsed = capabilitySnapshotSchema.safeParse(value);
  if (!parsed.success) throw new CapabilityRecordError('snapshot_invalid', 'the capability snapshot is invalid');
  const canonical = canonicalJson(parsed.data);
  if (utf8.encode(canonical).byteLength > CAPABILITY_LIMITS.snapshotBytes) {
    throw new CapabilityRecordError('snapshot_too_large', 'the capability snapshot exceeds 16 MiB');
  }
  return { digest: sha256Hex(canonical), payload: parsed.data, canonical };
}

/** Revalidates a stored snapshot before use: strict shape, bounds and its content address. */
export function openSnapshot(digest: string, value: unknown): CapabilitySnapshot {
  const sealed = sealSnapshot(value);
  if (sealed.digest !== digest) {
    throw new CapabilityRecordError('snapshot_digest_mismatch', 'the stored capability snapshot does not match');
  }
  return sealed.payload;
}

/** A command run's normalized submitted input; its digest is the creation-request identity. */
export const commandRunInputSchema = z.strictObject({
  kind: z.literal('command'),
  commandId: commandIdSchema,
  selectionRevision: digestSchema,
  arguments: boundedText(CAPABILITY_LIMITS.taskBytes),
  provider: providerSchema,
});
export type CommandRunInput = z.infer<typeof commandRunInputSchema>;

export const delegateOutcomeSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('result'), text: boundedText(65_536) }),
  z.strictObject({ kind: z.literal('refused'), reason: reasonCodeSchema, message: plainText(2048) }),
  z.strictObject({ kind: z.literal('failed'), reason: reasonCodeSchema, message: plainText(2048) }),
]);
export type DelegateOutcome = z.infer<typeof delegateOutcomeSchema>;

export const delegateStateSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('active') }),
  z.strictObject({ kind: z.literal('waiting'), questionId: digestSchema }),
  z.strictObject({ kind: z.literal('completed'), outcome: delegateOutcomeSchema }),
  z.strictObject({ kind: z.literal('abandoned'), reason: reasonCodeSchema }),
]);
export type DelegateState = z.infer<typeof delegateStateSchema>;

/** A run's agents: the single root, or a one-level delegate whose key is its parent delegation operation. */
export const runActorSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('root') }),
  z.strictObject({
    kind: z.literal('delegate'),
    delegationId: digestSchema,
    parentActor: z.literal('root'),
    agentId: agentIdSchema,
    taskDigest: digestSchema,
    checkpointNs: z.string().min(1).max(512),
    state: delegateStateSchema,
  }),
]);
export type RunActor = z.infer<typeof runActorSchema>;

export const loadedSkillSchema = z.strictObject({
  actorKey: actorKeySchema,
  skillId: skillIdSchema,
  /** The first successful load; repeated loads do not add membership. */
  operationId: digestSchema,
  definitionDigest: digestSchema,
});
export type LoadedSkill = z.infer<typeof loadedSkillSchema>;

const safeFailure = { reason: reasonCodeSchema, message: plainText(2048) };

/** The closed result of one MCP call. Raw SDK errors, stderr and server error bodies are never fields. */
export const externalOutcomeSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('ok'), text: boundedText(65_536).optional(), json: z.json().optional() }),
  z.strictObject({ kind: z.literal('refused'), ...safeFailure }),
  z.strictObject({ kind: z.literal('unavailable'), ...safeFailure }),
  z.strictObject({ kind: z.literal('failed'), ...safeFailure }),
  z.strictObject({ kind: z.literal('uncertain'), ...safeFailure, operationId: digestSchema }),
]);
export type ExternalOutcome = z.infer<typeof externalOutcomeSchema>;
