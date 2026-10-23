// Runtime-private subscription credential records. They live only in the private runtime state volume, never in
// PostgreSQL, the workspace, run history or browser data. Decoding is strict: an unknown version, field or
// provider/auth-mode pair is refused rather than guessed at.
import { z } from 'zod';
import type { Provider } from '../records/schemas.ts';

export const CREDENTIAL_RECORD_VERSION = 1;
export const CREDENTIAL_RECORD_MAX_BYTES = 65_536;

export const slotSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/);

/**
 * Token bounds. The 16-character minimum is this runtime's safety floor, not a provider format: exact-match
 * screening cannot safely recognize shorter values, so shorter tokens are refused instead of silently unscreened.
 */
export const CREDENTIAL_TOKEN_MIN_LENGTH = 16;
export const CREDENTIAL_TOKEN_MAX_LENGTH = 16_384;
export const CREDENTIAL_TOKEN_PATTERN = /^[\x21-\x7e]+$/;

const secret = z
  .string()
  .min(CREDENTIAL_TOKEN_MIN_LENGTH)
  .max(CREDENTIAL_TOKEN_MAX_LENGTH)
  .regex(CREDENTIAL_TOKEN_PATTERN, 'must be printable ASCII without spaces');
// Epoch milliseconds. The lower bound (September 2001) rejects epoch seconds, which would otherwise decode as 1970.
const epochMs = z.number().int().min(1_000_000_000_000).max(Number.MAX_SAFE_INTEGER);
const generation = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const reason = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);

/**
 * Provider account metadata required to route a request, from the same issuance as the tokens it accompanies.
 * OpenAI subscription requests carry the account ID; Anthropic's requirements come from the maintained library's
 * contract and are empty until that integration lands.
 */
export const accountSchemas = {
  anthropic: z.strictObject({}),
  openai: z.strictObject({ accountId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/) }),
} as const satisfies Record<Provider, z.ZodType>;

function recordSchema<P extends Provider>(provider: P) {
  const common = {
    version: z.literal(CREDENTIAL_RECORD_VERSION),
    provider: z.literal(provider),
    authMode: z.literal('subscription'),
    slot: slotSchema,
    generation,
    updatedAtMs: epochMs,
  };
  return z.discriminatedUnion('lifecycle', [
    z.strictObject({
      ...common,
      lifecycle: z.literal('usable'),
      accessToken: secret,
      refreshToken: secret,
      expiresAtMs: epochMs,
      account: accountSchemas[provider],
    }),
    // A definitively rejected credential keeps no token material: nothing can accidentally retry with it.
    z.strictObject({ ...common, lifecycle: z.literal('reauthorization_required'), reason }),
  ]);
}

const schemas = { anthropic: recordSchema('anthropic'), openai: recordSchema('openai') };

export type CredentialRecord = z.infer<(typeof schemas)['anthropic']> | z.infer<(typeof schemas)['openai']>;
export type UsableCredential = Extract<CredentialRecord, { lifecycle: 'usable' }>;

/** Decodes a record for the expected provider and slot; anything else is refused. */
export function decodeCredentialRecord(value: unknown, provider: Provider, slot: string): CredentialRecord | undefined {
  const parsed = schemas[provider].safeParse(value);
  if (!parsed.success || parsed.data.slot !== slot) return undefined;
  return parsed.data;
}

/** The newer of two views of one slot; a higher generation always wins over stale memory. */
export function newerRecord<T extends CredentialRecord | undefined>(a: T, b: T): T {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return b.generation > a.generation ? b : a;
}
