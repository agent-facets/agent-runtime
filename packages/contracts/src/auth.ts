// Connecting a subscription provider from the console (design Decision 16). The browser starts a login attempt,
// opens the provider's authorization page, and submits the code that page shows. The attempt and its private login
// state live only on the server; responses carry the attempt's identity, state and the provider's authorization URL,
// never a code, verifier or token.
import { z } from 'zod';
import { instantSchema, uuidSchema } from './common.ts';
import { utf8Bytes } from './text.ts';

/** The largest pasted authorization code (a callback URL or `code#state`) the runtime accepts. */
export const AUTH_CODE_MAX_BYTES = 16 * 1024;
/** The largest request body the authentication operations read. */
export const AUTH_BODY_MAX_BYTES = 32 * 1024;

export const AUTH_ATTEMPT_STATES = [
  'awaiting_code',
  'completing',
  'connected',
  'failed',
  'cancelled',
  'expired',
] as const;
export const authAttemptStateSchema = z.enum(AUTH_ATTEMPT_STATES);
export type AuthAttemptState = z.infer<typeof authAttemptStateSchema>;

/** Why an attempt did not connect. `outcome_unknown` means the code may have been used: start a new login. */
export const AUTH_FAILURE_REASONS = [
  'code_mismatch',
  'rejected',
  'throttled',
  'not_sent',
  'outcome_unknown',
  'busy',
  'not_stored',
  'stopped',
] as const;
export const authFailureReasonSchema = z.enum(AUTH_FAILURE_REASONS);
export type AuthFailureReason = z.infer<typeof authFailureReasonSchema>;

export const authAttemptSchema = z.strictObject({
  attemptId: uuidSchema,
  provider: z.literal('anthropic'),
  state: authAttemptStateSchema,
  /** When an unfinished attempt stops accepting a code. */
  expiresAt: instantSchema,
  /** The provider's authorization page; present only while the attempt is waiting for its code. */
  authorizationUrl: z
    .string()
    .max(4096)
    .regex(/^https:\/\/[^\s/?#]+\/\S*$/, 'must be an HTTPS URL')
    .optional(),
  failure: z.strictObject({ reason: authFailureReasonSchema, message: z.string().min(1).max(512) }).optional(),
});
export type AuthAttempt = z.infer<typeof authAttemptSchema>;

export const beginLoginSchema = z.strictObject({});
export const attemptCommandSchema = z.strictObject({ attemptId: uuidSchema });
export type AttemptCommand = z.infer<typeof attemptCommandSchema>;
export const completeLoginSchema = z.strictObject({
  attemptId: uuidSchema,
  code: z
    .string()
    .min(1)
    .refine((code) => utf8Bytes(code) <= AUTH_CODE_MAX_BYTES, 'the code is too long'),
});
export type CompleteLoginCommand = z.infer<typeof completeLoginSchema>;
