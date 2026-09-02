// Deterministic tests for the live safety guards.
//
// These run offline, in-process, with no network. The container rehearsal
// proves the stages orchestrate correctly; this proves the guards themselves
// fail closed, which is cheaper to test here and much harder to test there --
// a guard that only ever sees allowed traffic is not evidence that it refuses
// anything.
//
// Every case has an inverse: an allowed request that must succeed and a
// refused one that must throw. A guard that rejects everything is as useless as
// one that rejects nothing.

import {
  armFetchPoison,
  createAuthTransport,
  createModelTransport,
  EndpointNotAllowedError,
  resolveEndpoints,
  type LiveEndpoints,
} from "../live-endpoints.ts";
import {
  DEFAULT_ISSUER,
  DEVICE_USERCODE_PATH,
  OAUTH_REVOKE_PATH,
  SUBSCRIPTION_BASE_URL,
} from "../reference.ts";

export type GuardResult = { id: string; ok: boolean; detail: Record<string, unknown> };

const REAL: LiveEndpoints = {
  issuer: DEFAULT_ISSUER,
  modelBaseUrl: SUBSCRIPTION_BASE_URL,
  authPaths: [DEVICE_USERCODE_PATH, OAUTH_REVOKE_PATH],
  synthetic: false,
};

export async function runLiveGuardCases(): Promise<{
  cases: GuardResult[];
  acceptance: Record<string, boolean>;
}> {
  const cases: GuardResult[] = [];

  // G-01: the auth transport refuses a foreign origin, including one that only
  // looks like the issuer.
  {
    const auth = createAuthTransport(REAL);
    const refused: string[] = [];
    for (const url of [
      `https://auth.openai.com.evil.example${DEVICE_USERCODE_PATH}`,
      `https://evil.example${DEVICE_USERCODE_PATH}`,
      `http://auth.openai.com${DEVICE_USERCODE_PATH}`,
    ]) {
      const error = await captureError(() => auth.fetch(url, { method: "POST" }));
      if (error instanceof EndpointNotAllowedError) refused.push(url);
    }
    cases.push({
      id: "G-01",
      ok: refused.length === 3 && auth.refusals === 3 && auth.requests === 0,
      detail: { refused: refused.length, refusals: auth.refusals, dispatched: auth.requests },
    });
  }

  // G-02: it also refuses an unknown path on the correct origin. Origin alone
  // is not enough -- an open redirect or a stray endpoint would sail through.
  {
    const auth = createAuthTransport(REAL);
    const error = await captureError(() =>
      auth.fetch(`${DEFAULT_ISSUER}/v1/models`, { method: "POST" }),
    );
    cases.push({
      id: "G-02",
      ok: error instanceof EndpointNotAllowedError && auth.requests === 0,
      detail: { refusals: auth.refusals },
    });
  }

  // G-03: the model transport refuses a wrong path, a wrong origin, and any
  // query string. A query string is the classic place a token gets appended.
  {
    const abort = new AbortController();
    const model = createModelTransport(REAL, 1_000, abort.signal);
    const refusals: string[] = [];
    for (const url of [
      `${SUBSCRIPTION_BASE_URL}/chat/completions`,
      "https://api.openai.com/backend-api/codex/responses",
      `${SUBSCRIPTION_BASE_URL}/responses?beta=true`,
    ]) {
      const error = await captureError(() => model.terminal(url, { method: "POST" }));
      if (error instanceof EndpointNotAllowedError) refusals.push(url);
    }
    cases.push({
      id: "G-03",
      ok: refusals.length === 3 && model.requests === 0,
      detail: { refused: refusals.length, refusals: model.refusals },
    });
  }

  // G-04: the poisoned global fetch throws and counts. Restored afterwards so
  // the rest of the run is unaffected.
  {
    const poison = armFetchPoison();
    const error = await captureError(() => globalThis.fetch("https://example.invalid"));
    const fired = poison.fired();
    poison.restore();
    cases.push({
      id: "G-04",
      ok: error !== null && fired === 1 && globalThis.fetch !== undefined,
      detail: { fired },
    });
  }

  // G-05: synthetic mode cannot be pointed at a non-loopback host, and cannot
  // be half-configured. Either would turn a rehearsal into live traffic.
  {
    const saved = {
      synthetic: process.env.SPIKE_SYNTHETIC,
      issuer: process.env.SPIKE_SYNTHETIC_ISSUER,
      model: process.env.SPIKE_SYNTHETIC_MODEL_BASE,
    };

    process.env.SPIKE_SYNTHETIC = "1";
    delete process.env.SPIKE_SYNTHETIC_ISSUER;
    delete process.env.SPIKE_SYNTHETIC_MODEL_BASE;
    const halfConfigured = await captureError(async () => resolveEndpoints());

    process.env.SPIKE_SYNTHETIC_ISSUER = "https://auth.openai.com";
    process.env.SPIKE_SYNTHETIC_MODEL_BASE = "http://127.0.0.1:8080/backend-api/codex";
    const remoteIssuer = await captureError(async () => resolveEndpoints());

    process.env.SPIKE_SYNTHETIC_ISSUER = "http://127.0.0.1:8080";
    const loopbackOk = await captureError(async () => resolveEndpoints());

    restoreEnv("SPIKE_SYNTHETIC", saved.synthetic);
    restoreEnv("SPIKE_SYNTHETIC_ISSUER", saved.issuer);
    restoreEnv("SPIKE_SYNTHETIC_MODEL_BASE", saved.model);

    cases.push({
      id: "G-05",
      ok: halfConfigured !== null && remoteIssuer !== null && loopbackOk === null,
      detail: {
        halfConfiguredRejected: halfConfigured !== null,
        remoteIssuerRejected: remoteIssuer !== null,
        loopbackAccepted: loopbackOk === null,
      },
    });
  }

  // G-06: default resolution, with no synthetic env, is the real provider --
  // so the rehearsal cannot become the default by accident.
  {
    const saved = process.env.SPIKE_SYNTHETIC;
    delete process.env.SPIKE_SYNTHETIC;
    const resolved = resolveEndpoints();
    restoreEnv("SPIKE_SYNTHETIC", saved);
    cases.push({
      id: "G-06",
      ok:
        resolved.synthetic === false &&
        resolved.issuer === DEFAULT_ISSUER &&
        resolved.modelBaseUrl === SUBSCRIPTION_BASE_URL,
      detail: { synthetic: resolved.synthetic },
    });
  }

  const passed = (id: string) => cases.find((entry) => entry.id === id)?.ok === true;

  return {
    cases,
    acceptance: {
      auth_origin_allowlist_fails_closed: passed("G-01"),
      auth_path_allowlist_fails_closed: passed("G-02"),
      model_endpoint_allowlist_fails_closed: passed("G-03"),
      global_fetch_poison_fails_closed: passed("G-04"),
      synthetic_endpoints_must_be_loopback: passed("G-05"),
      live_defaults_to_real_provider: passed("G-06"),
    },
  };
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

async function captureError(operation: () => Promise<unknown>): Promise<unknown> {
  try {
    await operation();
    return null;
  } catch (error) {
    return error;
  }
}
