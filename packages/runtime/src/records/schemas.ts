// Strict decoders for runtime-private run records. They mirror the database checks in
// persistence/migrations/002-run-records.ts: exact keys, discriminators and primitive types. Unknown fields are
// refused rather than stripped. These are server records, not browser wire contracts.
import { z } from 'zod';

const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
export const digest = z.string().regex(/^[0-9a-f]{64}$/);
const instant = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/)
  .refine((value) => !Number.isNaN(Date.parse(value)), 'invalid instant');
const positiveDecimal = z.string().regex(/^[1-9][0-9]{0,17}$/);
const code = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);
const nonEmpty = (max: number) => z.string().min(1).max(max);
const int = (min: number, max: number) => z.number().int().min(min).max(max);
const scalar = z.union([z.string(), z.number().refine(Number.isFinite), z.boolean(), z.null()]);

export const providerSchema = z.enum(['anthropic', 'openai']);
export type Provider = z.infer<typeof providerSchema>;

export const workspaceSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
  label: nonEmpty(256),
  root: nonEmpty(4096).startsWith('/'),
  policyDigest: digest,
});
export type WorkspaceSnapshot = z.infer<typeof workspaceSchema>;

export const providerBindingSchema = z.strictObject({
  provider: providerSchema,
  authMode: z.literal('subscription'),
  model: nonEmpty(256),
  profileId: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,127}$/),
  credentialSlot: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
});
export type ProviderBinding = z.infer<typeof providerBindingSchema>;

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
  z.strictObject({ kind: z.literal('model_attempt'), attemptId: uuid }),
  z.strictObject({ kind: z.literal('tool_operation'), operationId: digest }),
]);

export const failureSchema = z.strictObject({
  category: failureCategorySchema,
  reason: code,
  message: nonEmpty(2048),
  operation: operationRefSchema,
  remediation: nonEmpty(1024).optional(),
  retryAfterSeconds: int(0, 604_800).optional(),
});
export type Failure = z.infer<typeof failureSchema>;

export const runStateSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('working'), invocationId: uuid, ownerEpoch: positiveDecimal }),
  z.strictObject({ kind: z.literal('waiting'), questionId: digest, bindingDigest: digest }),
  z.strictObject({
    kind: z.literal('cancelling'),
    cancellationId: uuid,
    acceptedAt: instant,
    invocationId: uuid.optional(),
  }),
  z.strictObject({ kind: z.literal('succeeded'), finishedAt: instant, resultSeq: positiveDecimal }),
  z.strictObject({ kind: z.literal('failed'), finishedAt: instant, failure: failureSchema }),
  z.strictObject({ kind: z.literal('cancelled'), finishedAt: instant, cancellationId: uuid, acceptedAt: instant }),
  z.strictObject({ kind: z.literal('interrupted'), detectedAt: instant, lastActivityAt: instant, invocationId: uuid }),
]);
export type RunState = z.infer<typeof runStateSchema>;
export type RunStateKind = RunState['kind'];
export const TERMINAL_STATES: ReadonlySet<RunStateKind> = new Set(['succeeded', 'failed', 'cancelled', 'interrupted']);

const choiceOption = z.strictObject({ label: nonEmpty(256), value: scalar });
const distinctValues = (options: { value: unknown }[]) =>
  new Set(options.map((option) => JSON.stringify(option.value))).size === options.length;

export const questionInputSchema = z.union([
  z
    .strictObject({ kind: z.literal('text'), minLength: int(0, 8192), maxLength: int(1, 8192) })
    .refine((input) => input.minLength <= input.maxLength, 'minLength exceeds maxLength'),
  z
    .strictObject({
      kind: z.literal('choice'),
      multiple: z.literal(false),
      options: z.array(choiceOption).min(1).max(50),
    })
    .refine((input) => distinctValues(input.options), 'option values must be distinct'),
  z
    .strictObject({
      kind: z.literal('choice'),
      multiple: z.literal(true),
      options: z.array(choiceOption).min(1).max(50),
      minSelections: int(0, 50),
      maxSelections: int(1, 50),
    })
    .refine((input) => distinctValues(input.options), 'option values must be distinct')
    .refine(
      (input) => input.minSelections <= input.maxSelections && input.maxSelections <= input.options.length,
      'invalid selection bounds',
    ),
]);
export type QuestionInput = z.infer<typeof questionInputSchema>;

export const questionBindingSchema = z.strictObject({
  threadId: uuid,
  checkpointNs: z.string().max(512),
  checkpointId: nonEmpty(256),
  taskId: nonEmpty(256),
  interruptId: nonEmpty(256),
  ordinal: z.literal(0),
  operationId: digest,
  payloadDigest: digest,
  requiredStateDigest: digest,
  definitionDigest: digest,
});
export type QuestionBinding = z.infer<typeof questionBindingSchema>;

export const answerSchema = z.union([scalar, z.array(scalar)]);
export type Answer = z.infer<typeof answerSchema>;

/** Requires the answer property to be present; false, null, zero and empty text are valid answers. */
const answeredDisposition = z
  .strictObject({ kind: z.literal('answered'), answer: answerSchema, acceptedAt: instant, invocationId: uuid })
  .refine((value) => Object.hasOwn(value, 'answer'), 'answer is required');

export const questionDispositionSchema = z.union([
  z.strictObject({ kind: z.literal('pending') }),
  answeredDisposition,
  z.strictObject({ kind: z.literal('closed'), reason: code, closedAt: instant }),
]);
export type QuestionDisposition = z.infer<typeof questionDispositionSchema>;

export const toolDispositionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('started') }),
  z.strictObject({ kind: z.literal('paused'), questionId: digest }),
  z.strictObject({
    kind: z.literal('completed'),
    outcome: z.enum(['ok', 'refused', 'error']),
    result: z.record(z.string(), z.json()),
  }),
  z.strictObject({ kind: z.literal('abandoned'), reason: code }),
]);
export type ToolDisposition = z.infer<typeof toolDispositionSchema>;

export const attemptStateSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('reserved') }),
  z.strictObject({ kind: z.literal('dispatched'), dispatchedAt: instant }),
  z.strictObject({
    kind: z.literal('completed'),
    dispatchedAt: instant,
    completedAt: instant,
    outcome: z.enum(['ok', 'failed']),
    providerRequestId: nonEmpty(256).optional(),
  }),
  z.strictObject({ kind: z.literal('abandoned'), reason: code, at: instant }),
  z.strictObject({ kind: z.literal('unconfirmed'), detectedAt: instant }),
]);
export type AttemptState = z.infer<typeof attemptStateSchema>;

const budgetSchema = z.strictObject({
  maximum: int(1, 2_147_483_647),
  consumed: int(0, 2_147_483_647),
  unconfirmed: int(0, 2_147_483_647),
});

export const eventSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('run.created'),
    payload: z.strictObject({
      requestId: uuid,
      provider: providerSchema,
      model: nonEmpty(256),
      budgetMax: int(1, 2_147_483_647),
    }),
  }),
  z.strictObject({
    kind: z.literal('run.status'),
    payload: z.strictObject({ revision: positiveDecimal, state: runStateSchema }),
  }),
  z.strictObject({
    kind: z.literal('model.attempt'),
    payload: z.strictObject({
      attemptId: uuid,
      ordinal: int(1, 2_147_483_647),
      state: attemptStateSchema,
      budget: budgetSchema,
    }),
  }),
  z.strictObject({
    kind: z.literal('assistant.message'),
    payload: z.strictObject({ messageId: nonEmpty(256), text: z.string().max(1_048_576) }),
  }),
  z.strictObject({
    kind: z.literal('tool.operation'),
    payload: z.strictObject({ operationId: digest, toolName: nonEmpty(128), disposition: toolDispositionSchema }),
  }),
  z.strictObject({
    kind: z.literal('question.asked'),
    payload: z.strictObject({ questionId: digest, prompt: nonEmpty(16_384), input: questionInputSchema }),
  }),
  z.strictObject({
    kind: z.literal('question.answered'),
    payload: z
      .strictObject({ questionId: digest, answer: answerSchema, invocationId: uuid, acceptedAt: instant })
      .refine((value) => Object.hasOwn(value, 'answer'), 'answer is required'),
  }),
  z.strictObject({
    kind: z.literal('question.closed'),
    payload: z.strictObject({ questionId: digest, reason: code, closedAt: instant }),
  }),
  z.strictObject({
    kind: z.literal('cancellation.accepted'),
    payload: z.strictObject({ cancellationId: uuid, requestId: uuid, acceptedAt: instant }),
  }),
]);
export type RunEvent = z.infer<typeof eventSchema>;
export type RunEventKind = RunEvent['kind'];

/** Operation identity: SHA-256 over the run, model message and provider tool-call IDs (newline-separated). */
export function operationIdFor(runId: string, modelMessageId: string, providerToolCallId: string): string {
  for (const part of [modelMessageId, providerToolCallId]) {
    if (part.length === 0 || part.length > 256 || /\p{Cc}/u.test(part)) throw new Error('invalid call identity');
  }
  return new Bun.CryptoHasher('sha256').update(`${runId}\n${modelMessageId}\n${providerToolCallId}`).digest('hex');
}
