// Operator configuration: the owner's non-secret choices for this deployment, read from RUNTIME_CONFIG_FILE.
// Credentials never appear here. Unknown fields are refused, so a misspelled or unsupported setting (an endpoint,
// an API key, a different auth mode) cannot be silently ignored. The parsed result is deeply frozen.
import { z } from 'zod';
import { isStorableText } from '../domain/text.ts';
import type { Provider } from '../records/schemas.ts';

export const OPERATOR_CONFIG_MAX_BYTES = 65_536;
export const DEFAULT_STEP_BUDGET = 50;
export const DEFAULT_MODEL_REQUEST_DEADLINE_SECONDS = 300;

const text = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine(isStorableText, 'must be well-formed text')
    .refine((value) => !/\p{Cc}/u.test(value), 'must not contain control characters');

/** Absolute, already-normalized container path; `/` itself is not a workspace. */
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

const basename = text(255).refine(
  (value) => !value.includes('/') && value !== '.' && value !== '..',
  'must be a single file name',
);
const relativePath = text(4096).refine(
  (value) =>
    !value.startsWith('/') &&
    !value.endsWith('/') &&
    value.split('/').every((part) => part !== '' && part !== '.' && part !== '..'),
  'must be a normalized relative path',
);

const providerSettings = z.strictObject({
  authMode: z.literal('subscription'),
  model: text(256),
  profileId: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,127}$/),
  credentialSlot: z
    .string()
    .regex(/^[a-z0-9][a-z0-9_-]{0,63}$/)
    .default('default'),
});

const operatorSchema = z
  .strictObject({
    version: z.literal(1),
    workspace: z.strictObject({
      id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
      label: text(256),
      root: absolutePath,
      /** Additional exclusions. They can only narrow what tools may read. */
      excludeNames: z.array(basename).max(256).default([]),
      excludePaths: z.array(relativePath).max(256).default([]),
    }),
    providers: z
      .strictObject({ anthropic: providerSettings.optional(), openai: providerSettings.optional() })
      .refine((providers) => providers.anthropic !== undefined || providers.openai !== undefined, {
        message: 'at least one provider must be configured',
      }),
    defaultProvider: z.enum(['anthropic', 'openai']),
    stepBudget: z.number().int().min(1).max(10_000).default(DEFAULT_STEP_BUDGET),
    modelRequestDeadlineSeconds: z.number().int().min(10).max(3600).default(DEFAULT_MODEL_REQUEST_DEADLINE_SECONDS),
  })
  .refine((config) => config.providers[config.defaultProvider] !== undefined, {
    message: 'the default provider must be configured',
    path: ['defaultProvider'],
  });

export type OperatorConfig = z.infer<typeof operatorSchema>;
export type ProviderSettings = z.infer<typeof providerSettings> & { provider: Provider };

export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

function isWithinOrEqual(parent: string, child: string): boolean {
  return child === parent || child.startsWith(`${parent}/`);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
}

export interface OperatorContext {
  /** Private runtime state (credentials live beneath it). */
  stateDir: string;
  /** Where this configuration was read from. */
  configFile: string;
}

/**
 * Parses operator configuration. Error messages name the offending setting but never echo its value. The
 * workspace may not contain, or be contained by, private runtime state or the configuration itself.
 */
export function parseOperatorConfig(source: string, context: OperatorContext): OperatorConfig {
  if (new TextEncoder().encode(source).byteLength > OPERATOR_CONFIG_MAX_BYTES) {
    throw new ConfigError('operator configuration is too large');
  }
  let raw: unknown;
  try {
    raw = JSON.parse(source);
  } catch {
    throw new ConfigError('operator configuration is not valid JSON');
  }
  const parsed = operatorSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    // Setting names come from the file, so only ordinary identifiers are echoed into logs.
    const name = (parts: PropertyKey[]) =>
      parts.map((part) => (/^[A-Za-z0-9_]{1,64}$/.test(String(part)) ? String(part) : '?')).join('.') || '(root)';
    const where =
      issue?.code === 'unrecognized_keys'
        ? `unsupported setting ${name([...issue.path, issue.keys[0] ?? '?'])}`
        : `invalid setting ${name(issue?.path ?? [])}`;
    throw new ConfigError(`operator configuration: ${where}`);
  }
  const config = parsed.data;
  const root = config.workspace.root;
  if (isWithinOrEqual(root, context.stateDir) || isWithinOrEqual(context.stateDir, root)) {
    throw new ConfigError('operator configuration: the workspace overlaps private runtime state');
  }
  if (isWithinOrEqual(root, context.configFile)) {
    throw new ConfigError('operator configuration: the workspace contains the configuration file');
  }
  return deepFreeze(config);
}

/** The configured settings for one provider, or undefined when the owner has not configured it. */
export function providerSettingsFor(config: OperatorConfig, provider: Provider): ProviderSettings | undefined {
  const settings = config.providers[provider];
  return settings === undefined ? undefined : Object.freeze({ ...settings, provider });
}
