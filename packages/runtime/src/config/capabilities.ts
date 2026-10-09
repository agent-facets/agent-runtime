// The optional `capabilities` section of operator configuration (design Decision 4): the pinned runtime facet
// installation, the skills and agents the owner allows, delegation limits, deployment-supplied MCP programs and
// per-server access. It holds no secrets: a server's credentials are named private slots. Every grant is explicit;
// anything this profile cannot enforce (an arbitrary working directory, a predicate other than top-level scalar
// equality, an override of a protected environment variable) is refused rather than ignored.
import {
  agentIdSchema,
  digestSchema,
  mcpToolNameSchema,
  serverIdSchema,
  skillIdSchema,
} from '@agent-runtime/contracts';
import { z } from 'zod';
import { NO_KNOWN_CREDENTIALS } from '../credentials/matcher.ts';
import { isStorableText } from '../domain/text.ts';
import { createContentPolicy } from '../security/content-policy.ts';

export const CAPABILITY_CONFIG_LIMITS = Object.freeze({
  servers: 8,
  toolGrants: 64,
  argumentEquals: 32,
  environment: 64,
  environmentValueBytes: 4096,
  scalarBytes: 1024,
  skills: 32,
  agents: 16,
  delegationsDefault: 8,
  delegationsMaximum: 32,
  toolTimeoutDefaultSeconds: 60,
  toolTimeoutMaximumSeconds: 300,
});

export const programIdSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/);
export const credentialSlotIdSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/);
export const environmentNameSchema = z.string().regex(/^[A-Z_][A-Z0-9_]{0,127}$/);
export const argumentFieldSchema = z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/);

/**
 * Environment variables a server's configuration may never set. The launcher sets the process-identity and
 * location variables itself; loader, proxy, TLS, tracing/debug, provider, database and runtime-control settings
 * could redirect or observe the server, or reach this runtime's own authority.
 */
const PROTECTED_NAMES = new Set([
  'HOME',
  'LOGNAME',
  'PATH',
  'SHELL',
  'TERM',
  'USER',
  'TMPDIR',
  'TMP',
  'TEMP',
  'PWD',
  'DEBUG',
  'DATABASE_URL',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
]);
const PROTECTED_PREFIXES = [
  'LD_',
  'DYLD_',
  'NODE_',
  'BUN_',
  'NPM_',
  'LANGSMITH_',
  'LANGCHAIN_',
  'OTEL_',
  'ANTHROPIC_',
  'OPENAI_',
  'CLAUDE_',
  'CODEX_',
  'PG',
  'POSTGRES_',
  'RUNTIME_',
  'AGENT_RUNTIME_',
  'FACET_',
];

export function isProtectedEnvironmentName(name: string): boolean {
  const upper = name.toUpperCase();
  return PROTECTED_NAMES.has(upper) || PROTECTED_PREFIXES.some((prefix) => upper.startsWith(prefix));
}

const absolutePath = z
  .string()
  .max(4096)
  .refine(
    (value) =>
      /^\/[^\0]*$/.test(value) &&
      value !== '/' &&
      !value.endsWith('/') &&
      !value.includes('//') &&
      !value.split('/').some((part) => part === '.' || part === '..') &&
      !/\p{Cc}/u.test(value),
    'must be a normalized absolute path other than /',
  );

const unique = (values: readonly string[]) => new Set(values).size === values.length;
const utf8 = new TextEncoder();
const textUpTo = (maxBytes: number) =>
  z
    .string()
    .refine(isStorableText, 'must be well-formed text')
    .refine((value) => !/\p{Cc}/u.test(value), 'must not contain control characters')
    .refine((value) => utf8.encode(value).byteLength <= maxBytes, `must be at most ${maxBytes} bytes`);

/** A top-level argument value compared by exact equality, never coerced. */
const grantScalarSchema = z.union([
  textUpTo(CAPABILITY_CONFIG_LIMITS.scalarBytes),
  z.number().refine(Number.isFinite),
  z.boolean(),
  z.null(),
]);
export type GrantScalar = z.infer<typeof grantScalarSchema>;

// Literal settings are non-secret configuration; a recognizable credential belongs in a private slot instead.
const credentialFormats = createContentPolicy(NO_KNOWN_CREDENTIALS);
const literalValue = textUpTo(CAPABILITY_CONFIG_LIMITS.environmentValueBytes).refine(
  (value) => credentialFormats.detect(value) === undefined,
  'credential material belongs in credentialEnv',
);

const environmentMap = <T extends z.ZodType>(value: T) =>
  z
    .record(environmentNameSchema, value)
    .refine((map) => Object.keys(map).length <= CAPABILITY_CONFIG_LIMITS.environment, 'too many variables')
    .refine((map) => Object.keys(map).every((name) => !isProtectedEnvironmentName(name)), 'protected variable');

export const toolGrantSchema = z.strictObject({
  name: mcpToolNameSchema,
  definitionDigest: digestSchema,
  argumentEquals: z
    .record(argumentFieldSchema, grantScalarSchema)
    .refine((map) => Object.keys(map).length <= CAPABILITY_CONFIG_LIMITS.argumentEquals, 'too many restrictions')
    .default({}),
});
export type ToolGrant = z.infer<typeof toolGrantSchema>;

export const serverApprovalSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('denied') }),
  z.strictObject({
    kind: z.literal('approved'),
    serverDigest: digestSchema,
    tools: z
      .array(toolGrantSchema)
      .max(CAPABILITY_CONFIG_LIMITS.toolGrants)
      .refine((tools) => unique(tools.map((tool) => tool.name)), 'duplicate tool grant'),
  }),
]);
export type ServerApproval = z.infer<typeof serverApprovalSchema>;

export const serverAccessSchema = z
  .strictObject({
    serverId: serverIdSchema,
    programId: programIdSchema,
    literalEnv: environmentMap(literalValue).default({}),
    credentialEnv: environmentMap(credentialSlotIdSchema).default({}),
    toolTimeoutSeconds: z
      .number()
      .int()
      .min(1)
      .max(CAPABILITY_CONFIG_LIMITS.toolTimeoutMaximumSeconds)
      .default(CAPABILITY_CONFIG_LIMITS.toolTimeoutDefaultSeconds),
    approval: serverApprovalSchema,
  })
  .refine(
    (server) => Object.keys(server.literalEnv).every((name) => !Object.hasOwn(server.credentialEnv, name)),
    'an environment variable is both a literal and a credential',
  );
export type ServerAccess = z.infer<typeof serverAccessSchema>;

export const localProgramSchema = z.strictObject({ bundlePath: absolutePath, sha256: digestSchema });

export const capabilityConfigSchema = z
  .strictObject({
    installation: z.strictObject({ path: absolutePath, sha256: digestSchema }),
    allowSkills: z
      .array(skillIdSchema)
      .max(CAPABILITY_CONFIG_LIMITS.skills)
      .refine(unique, 'duplicate entry')
      .default([]),
    allowAgents: z
      .array(agentIdSchema)
      .max(CAPABILITY_CONFIG_LIMITS.agents)
      .refine(unique, 'duplicate entry')
      .default([]),
    maxDelegationsPerRun: z
      .number()
      .int()
      .min(1)
      .max(CAPABILITY_CONFIG_LIMITS.delegationsMaximum)
      .default(CAPABILITY_CONFIG_LIMITS.delegationsDefault),
    localPrograms: z
      .record(programIdSchema, localProgramSchema)
      .refine((programs) => Object.keys(programs).length <= CAPABILITY_CONFIG_LIMITS.servers, 'too many programs')
      // Deployment places each program at `<dir>/<programId>/<sha256>.js`; the path must name its own digest.
      .refine(
        (programs) =>
          Object.entries(programs).every(([id, program]) => program.bundlePath.endsWith(`/${id}/${program.sha256}.js`)),
        'a program path does not match its identity',
      )
      .default({}),
    servers: z
      .array(serverAccessSchema)
      .max(CAPABILITY_CONFIG_LIMITS.servers)
      .refine((servers) => unique(servers.map((server) => server.serverId)), 'duplicate server')
      .default([]),
  })
  .refine(
    (config) => config.servers.every((server) => Object.hasOwn(config.localPrograms, server.programId)),
    'a server names an unknown program',
  );
export type CapabilityConfig = z.infer<typeof capabilityConfigSchema>;

/**
 * Whether a call's arguments satisfy a grant's restrictions: every named top-level argument is present and equal
 * to its configured scalar, compared without coercion. An empty restriction set matches any arguments.
 */
export function argumentsMatch(grant: Pick<ToolGrant, 'argumentEquals'>, args: Record<string, unknown>): boolean {
  return Object.entries(grant.argumentEquals).every(
    ([field, expected]) => Object.hasOwn(args, field) && args[field] === expected,
  );
}

/** Every private credential slot the configuration binds to a server, denied servers included. */
export function configuredCredentialSlots(config: { capabilities?: CapabilityConfig } | undefined): string[] {
  const slots = (config?.capabilities?.servers ?? []).flatMap((server) => Object.values(server.credentialEnv));
  return [...new Set(slots)].sort();
}
