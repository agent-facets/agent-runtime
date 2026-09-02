// Constants transcribed from the pinned Codex release.
//
// Source of truth: @openai/codex 0.151.0-linux-x64, whose npm SLSA provenance
// binds it to github.com/openai/codex at refs/tags/rust-v0.151.0, commit
// 78c290807ce710180111df227df3b7a4fe845452. Every value below is public: the
// OAuth client is a public client and the device flow uses PKCE, so there is no
// client secret anywhere in this file or in the protocol it describes.
//
// These are transcribed, not derived. The differential exists to catch the case
// where a transcription is wrong.

export const CODEX_VERSION = "0.151.0";
export const CODEX_SOURCE_TAG = "rust-v0.151.0";
export const CODEX_SOURCE_COMMIT = "78c290807ce710180111df227df3b7a4fe845452";

/** Public OAuth client id. Overridable in Codex via an env var; not a secret. */
export const OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

export const DEFAULT_ISSUER = "https://auth.openai.com";

export const DEVICE_USERCODE_PATH = "/api/accounts/deviceauth/usercode";
export const DEVICE_TOKEN_PATH = "/api/accounts/deviceauth/token";
export const DEVICE_VERIFICATION_PATH = "/codex/device";
export const DEVICE_REDIRECT_PATH = "/deviceauth/callback";

export const OAUTH_TOKEN_PATH = "/oauth/token";
export const OAUTH_REVOKE_PATH = "/oauth/revoke";

/** Subscription transport. Note there is no `/v1` segment. */
export const SUBSCRIPTION_BASE_URL = "https://chatgpt.com/backend-api/codex";
export const RESPONSES_PATH = "/responses";

/**
 * The originator is per-entrypoint, not a single constant. `codex_cli_rs` is
 * the interactive TUI's default; `codex exec` -- the non-interactive entrypoint
 * an agent runtime actually resembles -- sends `codex_exec`. Measured from the
 * released binary, not transcribed from source.
 */
export const ORIGINATOR_TUI = "codex_cli_rs";
export const ORIGINATOR_EXEC = "codex_exec";
export const ORIGINATOR = ORIGINATOR_EXEC;

/**
 * Body constants captured from the oracle for this model at this version.
 * They are server-driven (`ModelInfo`) and cannot be predicted offline, so they
 * are pinned from a capture and must be re-captured per release -- exactly like
 * the reference user-agent, and with the same maintenance cost.
 */
export const CAPTURED_PARALLEL_TOOL_CALLS = false;
export const CAPTURED_REASONING = { context: "all_turns", effort: "low" } as const;
export const CAPTURED_TEXT = { verbosity: "low" } as const;
export const ACCOUNT_HEADER = "chatgpt-account-id";
export const RESIDENCY_HEADER = "x-openai-internal-codex-residency";
export const VERSION_HEADER = "version";

/**
 * Codex refreshes this far before the access token's `exp`. Measured, not
 * guessed: CHATGPT_ACCESS_TOKEN_REFRESH_WINDOW_MINUTES = 5.
 */
export const REFRESH_MARGIN_SECONDS = 5 * 60;

/** Codex gives up on device polling after exactly this long. */
export const DEVICE_DEADLINE_SECONDS = 15 * 60;

/**
 * Codex deserialises `interval` from a JSON *string* and defaults it to 0 when
 * absent, which would hot-poll. The runtime deliberately diverges: it clamps to
 * a floor and refuses an unparsable value. That divergence is a safety decision
 * and is reported as such rather than smuggled in as parity.
 */
export const DEVICE_INTERVAL_FLOOR_MS = 1_000;
export const DEVICE_INTERVAL_DEFAULT_MS = 5_000;

/** Upper bound applied to a server-supplied `retry-after`. */
export const RETRY_AFTER_CLAMP_MS = 60_000;

/** Statuses that mean "keep polling" on the device token endpoint. */
export const DEVICE_POLL_CONTINUE_STATUSES: readonly number[] = [403, 404];

export const SCOPES = [
  "openid",
  "profile",
  "email",
  "offline_access",
  "api.connectors.read",
  "api.connectors.invoke",
] as const;
