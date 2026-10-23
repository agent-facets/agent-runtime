// The browser API (`/api/v1`, design Decision 13): response bodies, the public run-state union, history events and
// the error envelope. These are projections of server records chosen for display. Nothing here carries a
// credential reference, saved-graph binding, owner epoch, invocation identity or provider reasoning.
import { z } from 'zod';
import {
  digestSchema,
  failureSchema,
  instantSchema,
  providerSchema,
  reasonCodeSchema,
  sequenceSchema,
  uuidSchema,
} from './common.ts';
import { answerSchema, questionInputSchema, questionPromptSchema, withinQuestionText } from './questions.ts';

export const API_PREFIX = '/api/v1';
/** The largest request body the API reads. */
export const REQUEST_BODY_MAX_BYTES = 65_536;
export const RUN_PAGE_DEFAULT = 50;
export const RUN_PAGE_MAX = 100;
export const EVENT_PAGE_DEFAULT = 200;
export const EVENT_PAGE_MAX = 1000;

export const RUN_STATE_KINDS = [
  'working',
  'waiting',
  'cancelling',
  'succeeded',
  'failed',
  'cancelled',
  'interrupted',
] as const;
export const runStateKindSchema = z.enum(RUN_STATE_KINDS);
export type RunStateKind = z.infer<typeof runStateKindSchema>;
export const TERMINAL_STATE_KINDS: ReadonlySet<RunStateKind> = new Set([
  'succeeded',
  'failed',
  'cancelled',
  'interrupted',
]);

export const runStateSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('working') }),
  z.strictObject({ kind: z.literal('waiting'), questionId: digestSchema }),
  z.strictObject({ kind: z.literal('cancelling'), acceptedAt: instantSchema }),
  /** `resultSeq` is the history event holding the final result. */
  z.strictObject({ kind: z.literal('succeeded'), finishedAt: instantSchema, resultSeq: sequenceSchema }),
  z.strictObject({ kind: z.literal('failed'), finishedAt: instantSchema, failure: failureSchema }),
  z.strictObject({ kind: z.literal('cancelled'), finishedAt: instantSchema, acceptedAt: instantSchema }),
  z.strictObject({ kind: z.literal('interrupted'), detectedAt: instantSchema, lastActivityAt: instantSchema }),
]);
export type RunState = z.infer<typeof runStateSchema>;

const count = z.number().int().min(0).max(2_147_483_647);
/** Model requests: confirmed sent, and admitted without confirmation (still charged against the maximum). */
export const budgetSchema = z.strictObject({ maximum: count.min(1), consumed: count, unconfirmed: count });
export type Budget = z.infer<typeof budgetSchema>;

export const questionViewSchema = z
  .strictObject({ questionId: digestSchema, prompt: questionPromptSchema, input: questionInputSchema })
  .refine(withinQuestionText, 'question text is too large');
export type QuestionView = z.infer<typeof questionViewSchema>;

export const runViewSchema = z.strictObject({
  runId: uuidSchema,
  goal: z.string(),
  provider: providerSchema,
  authMode: z.literal('subscription'),
  model: z.string().min(1).max(256),
  workspace: z.strictObject({ label: z.string().min(1).max(256), root: z.string().min(1).max(4096) }),
  state: runStateSchema,
  budget: budgetSchema,
  createdAt: instantSchema,
  lastActivityAt: instantSchema,
  pendingQuestion: questionViewSchema.optional(),
});
export type RunView = z.infer<typeof runViewSchema>;

/** A consistent view of a run and the last history event it includes; history after it arrives by replay. */
export const runSnapshotSchema = z.strictObject({ run: runViewSchema, throughSeq: sequenceSchema });
export type RunSnapshot = z.infer<typeof runSnapshotSchema>;

export const runSummarySchema = z.strictObject({
  runId: uuidSchema,
  goal: z.string(),
  provider: providerSchema,
  model: z.string().min(1).max(256),
  status: runStateKindSchema,
  createdAt: instantSchema,
  lastActivityAt: instantSchema,
});
export type RunSummary = z.infer<typeof runSummarySchema>;

/** Newest first. `next` continues the listing; it is absent on the last page. */
export const runListSchema = z.strictObject({
  runs: z.array(runSummarySchema).max(RUN_PAGE_MAX),
  next: z.string().min(1).max(256).optional(),
});
export type RunList = z.infer<typeof runListSchema>;

export const providerReadinessSchema = z.enum([
  'unconfigured',
  'integration_unavailable',
  'reauthorization_required',
  'temporarily_unavailable',
  'ready',
]);
export type ProviderReadiness = z.infer<typeof providerReadinessSchema>;

export const optionsSchema = z.strictObject({
  workspace: z.strictObject({ label: z.string().min(1).max(256), available: z.boolean() }),
  providers: z.array(
    z.strictObject({
      provider: providerSchema,
      authMode: z.literal('subscription'),
      model: z.string().min(1).max(256),
      readiness: providerReadinessSchema,
    }),
  ),
  defaultProvider: providerSchema,
  defaultBudget: count.min(1),
  /** A limit on model requests across all runs, when the operator configured one. */
  modelRequestCeiling: count.min(1).optional(),
});
export type Options = z.infer<typeof optionsSchema>;

export const attemptStateSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('reserved') }),
  z.strictObject({ kind: z.literal('dispatched'), dispatchedAt: instantSchema }),
  z.strictObject({
    kind: z.literal('completed'),
    dispatchedAt: instantSchema,
    completedAt: instantSchema,
    outcome: z.enum(['ok', 'failed']),
  }),
  z.strictObject({ kind: z.literal('abandoned'), reason: reasonCodeSchema, at: instantSchema }),
  z.strictObject({ kind: z.literal('unconfirmed'), detectedAt: instantSchema }),
]);

export const toolDispositionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('started') }),
  z.strictObject({ kind: z.literal('paused'), questionId: digestSchema }),
  z.strictObject({
    kind: z.literal('completed'),
    outcome: z.enum(['ok', 'refused', 'error']),
    /** The sanitized outcome the agent received. */
    result: z.record(z.string(), z.json()),
  }),
  z.strictObject({ kind: z.literal('abandoned'), reason: reasonCodeSchema }),
]);

const envelope = <K extends string, P extends z.ZodType>(kind: K, payload: P) =>
  z.strictObject({
    runId: uuidSchema,
    seq: sequenceSchema.refine((seq) => seq !== '0', 'sequence numbers start at 1'),
    recordedAt: instantSchema,
    kind: z.literal(kind),
    payload,
  });

/** One committed history event. Events are ordered by `seq` within their run, and delivered at most once each. */
export const runEventSchema = z.discriminatedUnion('kind', [
  envelope(
    'run.created',
    z.strictObject({ provider: providerSchema, model: z.string().min(1).max(256), budgetMax: count.min(1) }),
  ),
  envelope('run.status', z.strictObject({ state: runStateSchema })),
  envelope(
    'model.attempt',
    z.strictObject({ attemptId: uuidSchema, ordinal: count.min(1), state: attemptStateSchema, budget: budgetSchema }),
  ),
  envelope('assistant.message', z.strictObject({ messageId: z.string().min(1).max(256), text: z.string() })),
  envelope(
    'tool.operation',
    z.strictObject({
      operationId: digestSchema,
      toolName: z.string().min(1).max(128),
      disposition: toolDispositionSchema,
    }),
  ),
  envelope(
    'question.asked',
    z
      .strictObject({ questionId: digestSchema, prompt: questionPromptSchema, input: questionInputSchema })
      .refine(withinQuestionText, 'question text is too large'),
  ),
  envelope(
    'question.answered',
    z
      .strictObject({ questionId: digestSchema, answer: answerSchema, acceptedAt: instantSchema })
      .refine((value) => Object.hasOwn(value, 'answer'), 'answer is required'),
  ),
  envelope(
    'question.closed',
    z.strictObject({ questionId: digestSchema, reason: reasonCodeSchema, closedAt: instantSchema }),
  ),
  envelope('cancellation.accepted', z.strictObject({ acceptedAt: instantSchema })),
]);
export type RunEvent = z.infer<typeof runEventSchema>;
export type RunEventKind = RunEvent['kind'];

/** A page of history strictly after a cursor; `nextAfter` is the cursor for the following page. */
export const eventPageSchema = z.strictObject({
  events: z.array(runEventSchema).max(EVENT_PAGE_MAX),
  nextAfter: sequenceSchema,
});
export type EventPage = z.infer<typeof eventPageSchema>;

export const answerAcceptedSchema = z.strictObject({
  acceptance: z
    .strictObject({ questionId: digestSchema, answer: answerSchema, acceptedAt: instantSchema })
    .refine((value) => Object.hasOwn(value, 'answer'), 'answer is required'),
  run: runViewSchema,
  throughSeq: sequenceSchema,
});
export type AnswerAccepted = z.infer<typeof answerAcceptedSchema>;

export const cancellationAcceptedSchema = z.strictObject({
  cancellation: z.strictObject({ acceptedAt: instantSchema }),
  run: runViewSchema,
  throughSeq: sequenceSchema,
});
export type CancellationAccepted = z.infer<typeof cancellationAcceptedSchema>;

export const ERROR_CODES = [
  'invalid_request',
  'json_required',
  'request_too_large',
  'goal_required',
  'goal_too_long',
  'goal_not_storable',
  'answer_invalid',
  'credential_in_input',
  'invalid_cursor',
  'forbidden',
  'not_found',
  'method_not_allowed',
  'request_conflict',
  'answer_conflict',
  'not_answerable',
  'continuation_unavailable',
  'provider_unavailable',
  'workspace_unavailable',
  'cancellation_conflict',
  'run_finished',
  'cursor_ahead',
  'cannot_verify',
  'screening_unavailable',
  'storage_unavailable',
  'acceptance_unknown',
  'service_unavailable',
] as const;
export const errorCodeSchema = z.enum(ERROR_CODES);
export type ErrorCode = z.infer<typeof errorCodeSchema>;

/**
 * Whether a refused mutation changed anything: `not_accepted` (definitively not), `unknown` (it may have been
 * recorded; repeating the same request is safe) or `already_accepted` (an earlier identical request was).
 */
export const acceptanceSchema = z.enum(['not_accepted', 'unknown', 'already_accepted']);
export type Acceptance = z.infer<typeof acceptanceSchema>;

export const errorEnvelopeSchema = z.strictObject({
  error: z.strictObject({
    code: errorCodeSchema,
    message: z.string().min(1).max(1024),
    runId: uuidSchema.optional(),
    questionId: digestSchema.optional(),
    retryable: z.boolean(),
    acceptance: acceptanceSchema,
  }),
});
export type ErrorEnvelope = z.infer<typeof errorEnvelopeSchema>;

/** An unsequenced, unstored notice on the event stream: replay could not continue; nothing durable changed. */
export const streamAvailabilitySchema = z.strictObject({
  available: z.literal(false),
  code: z.enum(['storage_unavailable', 'reader_too_slow', 'service_stopping']),
});
export type StreamAvailability = z.infer<typeof streamAvailabilitySchema>;
