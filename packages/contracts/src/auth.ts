// Connecting a subscription provider from the console (design Decision 16). The browser starts a login attempt and
// the owner signs in on the provider's own page in another tab:
//
// - Anthropic shows a code after sign-in, which the owner pastes back into the browser form.
// - OpenAI (a device login) has the browser show a short code, which the owner enters on OpenAI's page; the server
//   notices the approval itself, so nothing is pasted back.
//
// The attempt and its private login state live only on the server; responses carry the attempt's identity, state,
// the provider's page and (for OpenAI) the code to enter there — never an authorization code, verifier or token.
import { z } from 'zod';
import { instantSchema, providerSchema, uuidSchema } from './common.ts';
import { utf8Bytes } from './text.ts';

/** The largest pasted authorization code (a callback URL or `code#state`) the runtime accepts. */
export const AUTH_CODE_MAX_BYTES = 16 * 1024;
/** The largest request body the authentication operations read. */
export const AUTH_BODY_MAX_BYTES = 32 * 1024;

export const AUTH_ATTEMPT_STATES = [
  /** Anthropic: waiting for the owner to paste the code the provider's page shows. */
  'awaiting_code',
  /** OpenAI: waiting for the owner to enter `userCode` on the provider's page and approve. */
  'awaiting_approval',
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
  'denied',
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
  provider: providerSchema,
  state: authAttemptStateSchema,
  /** When an unfinished attempt stops accepting a code or approval. */
  expiresAt: instantSchema,
  /** The provider's sign-in page; present only while the attempt is waiting for the owner. */
  authorizationUrl: z
    .string()
    .max(4096)
    .regex(/^https:\/\/[^\s/?#]+\/\S*$/, 'must be an HTTPS URL')
    .optional(),
  /** OpenAI only: the code the owner enters on the provider's page; present only while awaiting approval. */
  userCode: z
    .string()
    .regex(/^[A-Za-z0-9-]{4,64}$/)
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
