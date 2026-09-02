// Typed auth failures.
//
// The split that matters operationally is permanent vs transient: a permanent
// failure must never be retried and must never be silently repaired, while a
// transient one is retried under a bounded policy. The two sets are closed --
// an unclassified failure is itself a finding, so `classify` never invents a
// default category.

export type AuthFailureKind = "permanent" | "transient";

export type AuthErrorCode =
  // permanent
  | "DEVICE_INTERVAL_INVALID"
  | "DEVICE_DENIED"
  | "DEVICE_TIMEOUT"
  | "PKCE_MISMATCH"
  | "CLAIMS_INCOMPLETE"
  | "AUTH_REVOKED"
  | "GENERATION_REGRESSION"
  | "RELOGIN_REQUIRED"
  // transient
  | "RATE_LIMITED"
  | "UPSTREAM_5XX"
  | "NETWORK"
  | "LOCK_TIMEOUT"
  | "STORE_CONTENDED";

export const PERMANENT_CODES: readonly AuthErrorCode[] = [
  "DEVICE_INTERVAL_INVALID",
  "DEVICE_DENIED",
  "DEVICE_TIMEOUT",
  "PKCE_MISMATCH",
  "CLAIMS_INCOMPLETE",
  "AUTH_REVOKED",
  "GENERATION_REGRESSION",
  "RELOGIN_REQUIRED",
];

export const TRANSIENT_CODES: readonly AuthErrorCode[] = [
  "RATE_LIMITED",
  "UPSTREAM_5XX",
  "NETWORK",
  "LOCK_TIMEOUT",
  "STORE_CONTENDED",
];

export class AuthError extends Error {
  readonly code: AuthErrorCode;
  readonly kind: AuthFailureKind;
  readonly retryAfterMs: number | null;

  constructor(code: AuthErrorCode, message: string, retryAfterMs: number | null = null) {
    super(message);
    this.name = "AuthError";
    this.code = code;
    this.kind = PERMANENT_CODES.includes(code) ? "permanent" : "transient";
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * Both sets together must cover every code exactly once. Called by the driver
 * as an acceptance criterion rather than trusted by construction.
 */
export function classificationIsExhaustive(all: readonly AuthErrorCode[]): boolean {
  const union = new Set<string>([...PERMANENT_CODES, ...TRANSIENT_CODES]);
  if (union.size !== PERMANENT_CODES.length + TRANSIENT_CODES.length) return false;
  return all.every((code) => union.has(code)) && union.size === all.length;
}

export const ALL_CODES: readonly AuthErrorCode[] = [...PERMANENT_CODES, ...TRANSIENT_CODES];

export function isAuthError(value: unknown): value is AuthError {
  return value instanceof AuthError;
}
