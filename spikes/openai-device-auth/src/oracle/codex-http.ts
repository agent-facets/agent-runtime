// The official Codex oracle, driven over loopback HTTP.
//
// This runs the released binary. It does not import, reimplement, or
// transcribe Codex's request builder: comparing a copy of the oracle against
// the oracle would prove only self-consistency, which is the mistake spike 03
// called out and deliberately avoided.
//
// Four provider settings are load-bearing and none of them are cosmetic:
//
//   name = "openai"                is what `is_openai()` compares, and it gates
//                                  the ChatGPT auth headers
//   base_url ending /backend-api/codex
//                                  is what `supports_codex_backend_routes()`
//                                  checks; without it the routing hint silently
//                                  disappears
//   http_headers.version           a config provider does not inherit the
//                                  built-in provider's `version` header
//   supports_websockets = false    the only supported way to make the lane
//                                  deterministic without faking a network fault
//
// The auth file is a sentinel with a far-future expiry, so Codex neither
// refreshes nor reaches an issuer. There is no network to reach one on.

import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { CODEX_VERSION } from "../reference.ts";
import { mintSentinelIdToken, mintSentinelJwt, SENTINEL_ACCOUNT_ID } from "../synthetic/issuer.ts";

/** Any id except the reserved `openai`; the `name` field carries the semantics. */
const PROVIDER_ID = "openai-subscription";

export type OracleLaunchOptions = {
  codexHome: string;
  workDirectory: string;
  captureBaseUrl: string;
  model: string;
  prompt: string;
  timeoutMs?: number;
  /** Enables the rollout-trace cross-check lane. */
  rolloutTraceRoot?: string;
  binary?: string;
};

export type OracleLaunchResult = {
  ok: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
  stdout: string;
  timedOut: boolean;
};

export async function prepareCodexHome(options: {
  codexHome: string;
  captureBaseUrl: string;
  model: string;
  nowSeconds: number;
}): Promise<void> {
  await mkdir(options.codexHome, { recursive: true, mode: 0o700 });

  // The provider *id* cannot be `openai`: 0.151.0 rejects the config outright
  // with "Built-in providers cannot be overridden". The id is renamed and the
  // `name` field -- which is what `is_openai()` actually compares, and
  // therefore what gates the ChatGPT auth headers -- is kept as `openai`.
  const config = [
    `model = "${options.model}"`,
    `model_provider = "${PROVIDER_ID}"`,
    `approval_policy = "never"`,
    `sandbox_mode = "danger-full-access"`,
    ``,
    `[model_providers.${PROVIDER_ID}]`,
    `name = "openai"`,
    `base_url = "${options.captureBaseUrl}"`,
    `wire_api = "responses"`,
    `requires_openai_auth = true`,
    `supports_websockets = false`,
    `request_max_retries = 0`,
    `stream_max_retries = 0`,
    ``,
    `[model_providers.${PROVIDER_ID}.http_headers]`,
    `version = "${CODEX_VERSION}"`,
    ``,
  ].join("\n");

  await writeFile(join(options.codexHome, "config.toml"), config, { mode: 0o600 });

  // A year of headroom keeps Codex out of its five-minute refresh window, so
  // the lane exercises the request path and nothing else.
  const expiry = options.nowSeconds + 365 * 24 * 3600;
  const auth = {
    OPENAI_API_KEY: null,
    tokens: {
      id_token: mintSentinelIdToken(false),
      access_token: mintSentinelJwt(expiry, 1),
      refresh_token: "SPIKESENTINELREFRESH-0001",
      account_id: SENTINEL_ACCOUNT_ID,
    },
    last_refresh: new Date(options.nowSeconds * 1000).toISOString(),
  };

  await writeFile(join(options.codexHome, "auth.json"), `${JSON.stringify(auth, null, 2)}\n`, {
    mode: 0o600,
  });
}

export async function launchCodex(options: OracleLaunchOptions): Promise<OracleLaunchResult> {
  await mkdir(options.workDirectory, { recursive: true });

  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    CODEX_HOME: options.codexHome,
    HOME: options.workDirectory,
    TERM: "dumb",
    NO_COLOR: "1",
    RUST_BACKTRACE: "1",
  };

  if (options.rolloutTraceRoot) {
    environment.CODEX_ROLLOUT_TRACE_ROOT = options.rolloutTraceRoot;
  }

  const child = spawn(
    options.binary ?? "codex",
    ["exec", "--skip-git-repo-check", "-C", options.workDirectory, options.prompt],
    { env: environment, stdio: ["ignore", "pipe", "pipe"] },
  );

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });

  const timeoutMs = options.timeoutMs ?? 60_000;
  let timedOut = false;

  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve) => {
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, timeoutMs);

      child.once("error", () => {
        clearTimeout(timer);
        resolve({ code: null, signal: null });
      });
      child.once("exit", (code, signal) => {
        clearTimeout(timer);
        resolve({ code, signal });
      });
    },
  );

  return {
    ok: !timedOut && result.code === 0,
    exitCode: result.code,
    signal: result.signal,
    stdout: stdout.slice(0, 4_000),
    stderr: stderr.slice(-4_000),
    timedOut,
  };
}
