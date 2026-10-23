// Browser views of facet-backed capabilities (design Decision 9): the installed catalog with configured grants and
// the last explicit server inspection, an inspection's result, and what one command run retained and used. These are
// projections chosen for display: they never carry a launch configuration, environment value, credential slot,
// private path, saved-graph binding or a whole retained snapshot.
import { z } from 'zod';
import {
  actorRefSchema,
  agentIdSchema,
  boundedText,
  commandIdSchema,
  contributionIdSchema,
  effectiveNameSchema,
  mcpToolNameSchema,
  nativeToolSchema,
  serverIdSchema,
  skillIdSchema,
  TASK_TEXT_MAX_BYTES,
} from './capabilities.ts';
import { digestSchema, instantSchema, reasonCodeSchema, sequenceSchema } from './common.ts';

/** Limits shared with the runtime's installation and snapshot bounds. */
export const CAPABILITY_VIEW_LIMITS = Object.freeze({
  contributions: 128,
  servers: 8,
  tools: 128,
  grants: 64,
  origins: 16,
  argumentEquals: 32,
  delegations: 32,
  usage: 256,
});

const plainText = (maxBytes: number) => boundedText(maxBytes).refine((text) => !/\p{Cc}/u.test(text), 'control text');
const count = z.number().int().min(0).max(2_147_483_647);
const unique = (values: readonly string[]) => new Set(values).size === values.length;

/** A facet a contribution or server came from: its name, version and recorded integrity. */
export const originViewSchema = z.strictObject({
  facet: z.string().regex(/^[A-Za-z0-9@][A-Za-z0-9@/._-]{0,255}$/),
  version: plainText(128),
  integrity: plainText(256),
});
export type OriginView = z.infer<typeof originViewSchema>;
const origins = z.array(originViewSchema).min(1).max(CAPABILITY_VIEW_LIMITS.origins);

/** A grant's top-level argument restriction value; one that cannot be shown safely is `withheld`. */
const restrictionValueSchema = z.union([
  z.strictObject({ kind: z.literal('value'), value: z.union([plainText(1024), z.number(), z.boolean(), z.null()]) }),
  z.strictObject({ kind: z.literal('withheld') }),
]);
const argumentFieldSchema = z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/);
export const toolGrantViewSchema = z.strictObject({
  tool: mcpToolNameSchema,
  definitionDigest: digestSchema,
  argumentEquals: z
    .record(argumentFieldSchema, restrictionValueSchema)
    .refine((map) => Object.keys(map).length <= CAPABILITY_VIEW_LIMITS.argumentEquals, 'too many restrictions'),
});
export type ToolGrantView = z.infer<typeof toolGrantViewSchema>;

export const contributionAvailabilityViewSchema = z.discriminatedUnion('kind', [
  /** `selectionRevision` is what a command start must name; skills and agents have none. */
  z.strictObject({ kind: z.literal('ready'), selectionRevision: digestSchema.optional() }),
  z.strictObject({
    kind: z.literal('refused'),
    reason: reasonCodeSchema,
    /** The public reference of the prerequisite or item the refusal concerns, when it has one. */
    subject: z
      .string()
      .regex(/^(?:command|skill|agent|mcp):[A-Za-z0-9@/._-]{1,255}$/)
      .optional(),
  }),
]);

export const contributionViewSchema = z.strictObject({
  id: contributionIdSchema,
  kind: z.enum(['command', 'skill', 'agent']),
  name: effectiveNameSchema,
  /** Absent for a refused contribution, or one whose description could not be shown safely. */
  description: plainText(1024).optional(),
  origins,
  availability: contributionAvailabilityViewSchema,
  /** Commands: whether the raw argument text may be empty. */
  arguments: z.strictObject({ required: z.boolean() }).optional(),
  /** Skills and agents: whether the owner's configuration allows new runs to use it. */
  allowed: z.boolean().optional(),
});
export type ContributionView = z.infer<typeof contributionViewSchema>;

/**
 * The owner's current approval of a server's connection, compared with what is installed now: `not_configured`
 * (no entry), `denied`, `program_unavailable`, `reapproval_required` (the approved digest is not the current one) or
 * `approved`. `currentDigest` is the approval digest of the installed declaration under the configured program and
 * bindings, for the owner to review and copy; it is absent when it cannot be computed.
 */
export const connectionViewSchema = z.strictObject({
  kind: z.enum(['not_configured', 'denied', 'program_unavailable', 'reapproval_required', 'approved']),
  currentDigest: digestSchema.optional(),
});
export type ConnectionView = z.infer<typeof connectionViewSchema>;

/** One advertised tool as an inspection found it. */
export const inspectedToolSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('supported'),
    name: mcpToolNameSchema,
    description: plainText(32 * 1024).optional(),
    definitionDigest: digestSchema,
    /** The raw advertised definition, as it would be approved: bounded and screened. */
    definition: z.record(z.string(), z.json()),
    /** Against the current grants: granted for exactly this definition, granted for another, or not granted. */
    grant: z.enum(['granted', 'reapproval_required', 'not_granted']),
  }),
  z.strictObject({ status: z.literal('refused'), name: mcpToolNameSchema.optional(), reason: reasonCodeSchema }),
]);
export type InspectedTool = z.infer<typeof inspectedToolSchema>;

/** A server's tools as observed by an explicit inspection; observations are never authority. */
export const serverObservationSchema = z.strictObject({
  observedAt: instantSchema,
  tools: z.array(inspectedToolSchema).max(CAPABILITY_VIEW_LIMITS.tools),
});
export type ServerObservation = z.infer<typeof serverObservationSchema>;

export const serverViewSchema = z.strictObject({
  serverId: serverIdSchema,
  origins,
  transport: z.enum(['stdio', 'http']),
  connection: connectionViewSchema,
  grants: z.array(toolGrantViewSchema).max(CAPABILITY_VIEW_LIMITS.grants),
  /** The last inspection of exactly this installation and connection binding since the runtime started. */
  observation: serverObservationSchema.optional(),
});
export type ServerView = z.infer<typeof serverViewSchema>;

export const catalogViewSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('unconfigured') }),
  z.strictObject({ kind: z.literal('unavailable'), reason: reasonCodeSchema }),
  z.strictObject({
    kind: z.literal('ready'),
    /** The verified installation's digest: discovery and command selections are made against it. */
    catalogRevision: digestSchema,
    contributions: z.array(contributionViewSchema).max(CAPABILITY_VIEW_LIMITS.contributions),
    servers: z.array(serverViewSchema).max(CAPABILITY_VIEW_LIMITS.servers),
  }),
]);
export type CatalogView = z.infer<typeof catalogViewSchema>;

export const discoverServerSchema = z.strictObject({ catalogRevision: digestSchema });
export type DiscoverServerCommand = z.infer<typeof discoverServerSchema>;

/** A completed inspection: the server as it is now viewed, with the new observation. */
export const discoveryResultSchema = z.strictObject({ catalogRevision: digestSchema, server: serverViewSchema });
export type DiscoveryResult = z.infer<typeof discoveryResultSchema>;

// --- One run's capabilities ---------------------------------------------------------------------------------------

const definitionRef = <T extends z.ZodType>(id: T) => z.strictObject({ id, name: effectiveNameSchema, origins });

/** The authority a run was accepted under: never widened by later configuration. */
const capturedPermissionsSchema = z.strictObject({
  native: z.array(nativeToolSchema).max(3),
  skills: z.array(skillIdSchema).max(CAPABILITY_VIEW_LIMITS.contributions),
  agents: z.array(agentIdSchema).max(CAPABILITY_VIEW_LIMITS.contributions),
  servers: z
    .array(
      z.strictObject({
        serverId: serverIdSchema,
        serverDigest: digestSchema,
        grants: z.array(toolGrantViewSchema).max(CAPABILITY_VIEW_LIMITS.grants),
      }),
    )
    .max(CAPABILITY_VIEW_LIMITS.servers),
});

/**
 * The owner's configuration as this runtime loaded it, for the run's retained servers: new operations are checked
 * against it as well as the captured authority. `connection` compares the approved digest with the retained one.
 */
const currentPermissionsSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('unconfigured') }),
  z.strictObject({
    kind: z.literal('configured'),
    skills: z.array(skillIdSchema).max(CAPABILITY_VIEW_LIMITS.contributions),
    agents: z.array(agentIdSchema).max(CAPABILITY_VIEW_LIMITS.contributions),
    servers: z
      .array(
        z.strictObject({
          serverId: serverIdSchema,
          connection: z.enum(['not_configured', 'denied', 'approved_as_retained', 'approved_otherwise']),
          grants: z.array(toolGrantViewSchema).max(CAPABILITY_VIEW_LIMITS.grants),
        }),
      )
      .max(CAPABILITY_VIEW_LIMITS.servers),
  }),
]);

/** How recorded operations of one kind and subject ended; `pending` have no recorded outcome (yet). */
export const usageSchema = z.strictObject({
  kind: z.enum(['native', 'skill_load', 'skill_reference', 'delegation', 'mcp']),
  /** The public subject: a native tool, skill, agent or `<serverId>/<toolName>`. */
  subject: z.string().min(1).max(256),
  ok: count,
  refused: count,
  error: count,
  uncertain: count,
  pending: count,
  /** The distinct refusal and failure codes recorded, at most eight. */
  codes: z.array(reasonCodeSchema).max(8),
});
export type UsageView = z.infer<typeof usageSchema>;

export const delegationViewSchema = z.strictObject({
  delegationId: digestSchema,
  agentId: agentIdSchema,
  state: z.enum(['active', 'waiting', 'result', 'refused', 'failed', 'abandoned']),
});

export const runCapabilitiesSchema = z.discriminatedUnion('kind', [
  /** A goal-only run (or one recorded before capabilities existed): native tools only. */
  z.strictObject({ kind: z.literal('native'), throughSeq: sequenceSchema }),
  /** The run's retained definitions cannot be read or verified; nothing current is substituted. */
  z.strictObject({ kind: z.literal('unavailable'), reason: reasonCodeSchema, throughSeq: sequenceSchema }),
  z.strictObject({
    kind: z.literal('command'),
    /** The last history event this view includes. */
    throughSeq: sequenceSchema,
    snapshotDigest: digestSchema,
    command: z.strictObject({
      id: commandIdSchema,
      name: effectiveNameSchema,
      origins,
      selectionRevision: digestSchema,
      arguments: boundedText(TASK_TEXT_MAX_BYTES),
      renderedGoal: boundedText(TASK_TEXT_MAX_BYTES),
    }),
    bound: z.strictObject({
      skills: z.array(definitionRef(skillIdSchema)).max(CAPABILITY_VIEW_LIMITS.contributions),
      agents: z.array(definitionRef(agentIdSchema)).max(CAPABILITY_VIEW_LIMITS.contributions),
      tools: z
        .array(
          z.strictObject({
            serverId: serverIdSchema,
            toolName: mcpToolNameSchema,
            definitionDigest: digestSchema,
            origins,
          }),
        )
        .max(CAPABILITY_VIEW_LIMITS.grants),
    }),
    used: z.strictObject({
      operations: z
        .array(usageSchema)
        .max(CAPABILITY_VIEW_LIMITS.usage)
        .refine((rows) => unique(rows.map((row) => `${row.kind} ${row.subject}`)), 'duplicate usage'),
      loadedSkills: z.array(z.strictObject({ skillId: skillIdSchema, actor: actorRefSchema })).max(512),
      delegations: z.array(delegationViewSchema).max(CAPABILITY_VIEW_LIMITS.delegations),
    }),
    limits: z.strictObject({ maxDelegations: count.min(1), delegationDepth: count.min(1) }),
    permissions: z.strictObject({ captured: capturedPermissionsSchema, current: currentPermissionsSchema }),
  }),
]);
export type RunCapabilitiesView = z.infer<typeof runCapabilitiesSchema>;
