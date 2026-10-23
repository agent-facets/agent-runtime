// Identifiers and failure shapes shared by the API and the server's records.
import { z } from 'zod';

export const uuidSchema = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
/** Lowercase SHA-256 hex: question and tool-operation identities. */
export const digestSchema = z.string().regex(/^[0-9a-f]{64}$/);
/** UTC instant with up to microsecond precision, as the server records it. */
export const instantSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/)
  .refine((value) => !Number.isNaN(Date.parse(value)), 'invalid instant');
/**
 * Event sequence numbers and cursors: PostgreSQL bigints carried as decimal strings, so no client compares them
 * as floating-point numbers. `0` is the cursor before the first event.
 */
export const sequenceSchema = z.string().regex(/^(?:0|[1-9][0-9]{0,18})$/);
export const reasonCodeSchema = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);

export const providerSchema = z.enum(['anthropic', 'openai']);
export type Provider = z.infer<typeof providerSchema>;
export const PROVIDER_LABELS: Readonly<Record<Provider, string>> = Object.freeze({
  anthropic: 'Anthropic',
  openai: 'OpenAI',
});

export const failureCategorySchema = z.enum([
  'authorization',
  'rate_or_quota_limit',
  'provider_failure',
  'step_limit',
  'continuation_unavailable',
  'tool_failure',
  'runtime_failure',
]);
export type FailureCategory = z.infer<typeof failureCategorySchema>;

export const operationRefSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('runtime') }),
  z.strictObject({ kind: z.literal('model_attempt'), attemptId: uuidSchema }),
  z.strictObject({ kind: z.literal('tool_operation'), operationId: digestSchema }),
]);

/** A run failure: one category, a stable reason code and application-owned explanation. */
export const failureSchema = z.strictObject({
  category: failureCategorySchema,
  reason: reasonCodeSchema,
  message: z.string().min(1).max(2048),
  operation: operationRefSchema,
  remediation: z.string().min(1).max(1024).optional(),
  retryAfterSeconds: z.number().int().min(0).max(604_800).optional(),
});
export type Failure = z.infer<typeof failureSchema>;
