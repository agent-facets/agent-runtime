// The live stage.
//
// Four subcommands. The first three run in three separate containers, because
// the properties being proven are exactly the ones a single long-lived process
// would hide:
//
//   init      one real device-code request. Prints the verification URL and the
//             one-time code to the terminal; neither reaches evidence.
//   complete  polls, exchanges, persists, and forces exactly one refresh.
//   reload    a *fresh* container reads the rotated credential, makes exactly
//             one model request, then revokes.
//   revoke    recovery only: revoke whatever token the volume still holds.
//
// Splitting `complete` from `reload` is what makes "survives a restart" a
// measurement rather than an assertion: the second container shares nothing
// with the first except the volume.
//
// Three things are deliberate and were not true of the first draft:
//
//   1. Every request goes through node:http behind an origin+path allowlist,
//      and the global fetch is poisoned for the whole process. The offline
//      differential measured that undici adds headers the reference client
//      never sends and that they cannot be removed, so a fetch-based live run
//      would knowingly send a non-parity request.
//   2. The idle-stream limit is a real race against the iterator, so a stall
//      aborts at 20s instead of waiting for the next chunk that never comes.
//   3. Any failure after the token exchange attempts revocation before exiting.
//      A token that exists but cannot be revoked is the worst outcome available
//      here, so it is the one the control flow is built around.
//
// The container never opens the operator's own credential store. The driver
// shell digests it before and after each stage; nothing in this file touches it.

import { HumanMessage } from "@langchain/core/messages";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { realClock } from "./clock.ts";
import { AuthError } from "./auth/errors.ts";
import { DeviceFlow } from "./auth/device-flow.ts";
import { NO_RETRY_POLICY, requestRefresh } from "./auth/refresh.ts";
import { CredentialStore, fileMode, type Credential } from "./store/credential-store.ts";
import { createCandidateModel, createDecoratedFetch, scrubEnvironment } from "./transport/candidate.ts";
import type { ProfileExpectations } from "./transport/profile.ts";
import { PROBE_TOOL } from "./experiments/transport.ts";
import {
  armFetchPoison,
  createAuthTransport,
  createModelTransport,
  resolveEndpoints,
  type GuardedTransport,
  type LiveEndpoints,
} from "./live-endpoints.ts";
import { CODEX_VERSION, OAUTH_CLIENT_ID, OAUTH_REVOKE_PATH, ORIGINATOR } from "./reference.ts";
import {
  digest,
  emit,
  EVIDENCE_SCHEMA,
  EXIT_USAGE,
  outcomeFor,
  sanitizeText,
  SPIKE_ID,
} from "./evidence.ts";

const STATE_DIR = process.env.SPIKE_STATE_DIR ?? "/state";
const PROVIDER = "openai";
// Not overridable. A one-shot billable request against the wrong model is an
// unrecoverable result, so the model under test is a constant and an attempt to
// override it is refused outright rather than honoured.
const MODEL = "gpt-5.6-sol";
const MODEL_TIMEOUT_MS = 60_000;
const IDLE_STREAM_TIMEOUT_MS = 20_000;

const USER_AGENT = `${ORIGINATOR}/${CODEX_VERSION} (Linux ${process.env.SPIKE_OS_RELEASE ?? "6.0.0"}; x86_64) spike`;

const command = process.argv[2];

function cleanupForFault(): Record<string, boolean> {
  const cleanup = lastFailureCleanup();
  return {
    refresh_token_revoked: cleanup?.revoked ?? false,
    state_removed: cleanup?.stateRemoved ?? false,
    revocation_attempted: cleanup?.attempted ?? false,
  };
}

// Declared before the dispatch below: `runReload` runs at module top level, so
// a const declared further down would still be in its temporal dead zone when
// the stream loop reaches it.
const IDLE = Symbol("idle");
const DEADLINE = Symbol("deadline");

function timer<T>(ms: number, value: T): { promise: Promise<T>; cancel: () => void } {
  let handle: NodeJS.Timeout;
  const promise = new Promise<T>((resolve) => {
    handle = setTimeout(() => resolve(value), ms);
  });
  return { promise, cancel: () => clearTimeout(handle) };
}

/**
 * Every refresh, wherever it originates -- the forced one in `complete`, or one
 * the credential store decides to make on its own inside the expiry margin.
 * Counted rather than asserted: `reload` calls `getAccessToken`, which can
 * refresh, and an unbudgeted refresh there would otherwise leave no trace.
 */
let refreshCalls = 0;

/**
 * What the failure path managed to do about the credential, recorded so the
 * fault JSON carries it. A revocation that succeeded but was only announced on
 * stderr is invisible to the driver, which then retains a volume whose token is
 * already dead -- and a retained volume is indistinguishable from one that
 * still needs recovering.
 */
type FailureCleanup = { attempted: boolean; revoked: boolean; stateRemoved: boolean };
let failureCleanup: FailureCleanup | null = null;

// Read through a function: the top-level handler runs after assignments the
// compiler cannot see, and reading the binding directly narrows it to `null`.
function lastFailureCleanup(): FailureCleanup | null {
  return failureCleanup;
}

const endpoints = resolveEndpoints();

if (process.env.SPIKE_LIVE_MODEL !== undefined) {
  process.stderr.write("SPIKE_LIVE_MODEL is not honoured; the live model is pinned\n");
  process.exit(EXIT_USAGE);
}

const poison = armFetchPoison();
const auth = createAuthTransport(endpoints);

try {
  if (command === "init") process.exit(await runInit());
  else if (command === "complete") process.exit(await runComplete());
  else if (command === "reload") process.exit(await runReload());
  else if (command === "revoke") process.exit(await runRevoke());
  else {
    process.stderr.write("usage: live.ts <init|complete|reload|revoke>\n");
    process.exit(EXIT_USAGE);
  }
} catch (error) {
  // Through emit(), not straight to stdout. This object embeds an unbounded,
  // provider- and SDK-controlled message, and it is the artifact the driver
  // persists on the one stage that cannot be repeated -- so it has to pass the
  // same leak scan as every other emission rather than relying on one regex.
  process.exit(
    emit({
      schema: EVIDENCE_SCHEMA,
      spike: SPIKE_ID,
      stage: `live-${command ?? "unknown"}`,
      synthetic: endpoints.synthetic,
      cleanup: cleanupForFault(),
      outcome: {
        status: "fault",
        fault: { step: "live-driver", message: sanitizeText((error as Error).message) },
      },
    }),
  );
}

// ---------------------------------------------------------------------------

async function runInit(): Promise<number> {
  scrubEnvironment();

  const volume = await inspectStateVolume();
  if (!volume.writable) {
    throw new Error(`state volume ${STATE_DIR} is not writable by this container`);
  }
  if (!volume.empty) {
    throw new Error(`state volume ${STATE_DIR} is not empty; refusing to reuse it`);
  }

  const listenersBefore = await countListeners();
  const flow = new DeviceFlow({ issuer: endpoints.issuer, clock: realClock, fetch: auth.fetch });
  const session = await flow.initiate();
  const listenersAfter = await countListeners();

  // The session and the code live in the private volume only, and reach the
  // operator's terminal on stderr. Neither is written to stdout, which is what
  // the driver captures as evidence.
  await writeFile(
    join(STATE_DIR, "device-session.json"),
    `${JSON.stringify({ ...session, createdAt: Date.now() }, null, 2)}\n`,
    { mode: 0o600 },
  );

  process.stderr.write(
    `\n  Visit:      ${session.verificationUri}\n  Enter code: ${session.userCode}\n\n`,
  );

  const acceptance = {
    device_initiated: flow.metrics.usercodeCalls === 1,
    volume_fresh_and_writable: volume.empty && volume.writable,
    volume_owner_only: volume.mode === 0o700,
    no_listener_started: listenersAfter === listenersBefore,
    no_endpoint_refusals: auth.refusals === 0,
    no_global_fetch_bypass: poison.fired() === 0,
  };

  return emit({
    schema: EVIDENCE_SCHEMA,
    spike: SPIKE_ID,
    stage: "live-init",
    synthetic: endpoints.synthetic,
    device: {
      usercode_calls: flow.metrics.usercodeCalls,
      interval_ms: session.intervalMs,
      verification_host: new URL(session.verificationUri).host,
    },
    volume,
    isolation: {
      listeners_before: listenersBefore,
      listeners_after: listenersAfter,
      auth_requests: auth.requests,
      endpoint_refusals: auth.refusals,
      global_fetch_attempts: poison.fired(),
    },
    acceptance,
    outcome: outcomeFor(acceptance),
  });
}

async function runComplete(): Promise<number> {
  scrubEnvironment();

  const session = JSON.parse(
    await readFile(join(STATE_DIR, "device-session.json"), "utf8"),
  ) as { deviceAuthId: string; userCode: string; verificationUri: string; intervalMs: number };

  const flow = new DeviceFlow({ issuer: endpoints.issuer, clock: realClock, fetch: auth.fetch });
  const authorization = await flow.poll(session);
  const tokens = await flow.exchange(authorization);

  // From here on a real credential exists. Every exit path has to consider it.
  let newestRefreshToken: string | null = tokens.refreshToken;
  let storeForCleanup: CredentialStore | null = null;

  try {
    const store = createStore();
    storeForCleanup = store;
    await store.initialise();

    const credential: Credential = {
      provider: PROVIDER,
      type: "oauth",
      access_token: tokens.accessToken,
      refresh_token: tokens.refreshToken,
      expires_at: tokens.expiresAtSeconds,
      account_id: tokens.accountId,
      scopes: [],
      profile_id: `codex/${CODEX_VERSION}`,
      created_at: Math.floor(Date.now() / 1000),
      rotated_at: Math.floor(Date.now() / 1000),
      state: "active",
    };

    const installed = await store.install(credential);
    const beforeAccess = fingerprint(installed.credential.access_token);
    const beforeRefresh = fingerprint(installed.credential.refresh_token ?? "");

    // Exactly one refresh, forced regardless of the expiry margin.
    refreshCalls += 1;
    const response = await requestRefresh(installed.credential.refresh_token ?? "", {
      issuer: endpoints.issuer,
      fetch: auth.fetch,
      clock: realClock,
    });

    const rotated: Credential = {
      ...installed.credential,
      access_token: response.accessToken ?? installed.credential.access_token,
      refresh_token: response.refreshToken ?? installed.credential.refresh_token,
      expires_at: response.expiresAtSeconds ?? installed.credential.expires_at,
      rotated_at: Math.floor(Date.now() / 1000),
    };
    newestRefreshToken = rotated.refresh_token;

    const committed = await store.install(rotated);

    // The device session is single-use and now spent. Removing it here means a
    // retained volume carries a credential and nothing else.
    await rm(join(STATE_DIR, "device-session.json"), { force: true });

    const acceptance = {
      device_authorized: true,
      account_claim_present: tokens.accountId.length > 0,
      credential_persisted: committed.generation >= 2,
      credential_mode_0600: (await fileMode(store.pathFor(PROVIDER))) === 0o600,
      access_token_replaced: fingerprint(rotated.access_token) !== beforeAccess,
      refresh_token_rotation_handled:
        response.refreshToken === null ||
        fingerprint(rotated.refresh_token ?? "") !== beforeRefresh,
      refresh_request_budget_respected: refreshCalls === 1,
      no_endpoint_refusals: auth.refusals === 0,
      no_global_fetch_bypass: poison.fired() === 0,
    };

    return emit({
      schema: EVIDENCE_SCHEMA,
      spike: SPIKE_ID,
      stage: "live-complete",
      synthetic: endpoints.synthetic,
      device: {
        polls: flow.metrics.tokenCalls,
        exchanges: flow.metrics.exchangeCalls,
        interval_ms: session.intervalMs,
      },
      refresh: {
        requests: 1,
        returned_new_access: response.accessToken !== null,
        returned_new_refresh: response.refreshToken !== null,
        access_fingerprint_changed: fingerprint(rotated.access_token) !== beforeAccess,
      },
      store: { generation: committed.generation },
      isolation: {
        auth_requests: auth.requests,
        endpoint_refusals: auth.refusals,
        global_fetch_attempts: poison.fired(),
      },
      acceptance,
      outcome: outcomeFor(acceptance),
    });
  } catch (error) {
    await revokeOnFailure(storeForCleanup, newestRefreshToken, "live-complete", error);
    throw error;
  }
}

async function runReload(): Promise<number> {
  scrubEnvironment();

  const store = createStore();
  const file = await store.read(PROVIDER);
  if (!file) throw new AuthError("RELOGIN_REQUIRED", "no credential survived the restart");

  // From here the credential is loaded and every failure has to consider it,
  // including failures in the setup below and in evidence emission itself.
  try {
    return await performReload(store, file.credential.refresh_token);
  } catch (error) {
    await revokeOnFailure(store, file.credential.refresh_token, "live-reload", error);
    throw error;
  }
}

async function performReload(
  store: CredentialStore,
  refreshToken: string | null,
): Promise<number> {
  const file = await store.read(PROVIDER);
  if (!file) throw new AuthError("RELOGIN_REQUIRED", "credential vanished mid-stage");

  const expectations: ProfileExpectations = {
    accountId: file.credential.account_id ?? "",
    allowedModels: [MODEL],
    residency: null,
    userAgent: USER_AGENT,
  };

  let statusCode = 0;
  let requestId: string | null = null;
  let responseModel: string | null = null;
  let chunks = 0;
  let firstByteMs: number | null = null;
  let toolCalls = 0;
  let usage: Record<string, unknown> | null = null;
  let sawMaxOutputTokens = false;
  let idleTimedOut = false;
  let deadlineExceeded = false;

  const abort = new AbortController();
  const modelTransport = createModelTransport(endpoints, MODEL_TIMEOUT_MS, abort.signal);
  const startedAt = Date.now();
  const observed = createStreamObserver();

  const decorated = createDecoratedFetch(
    async (input, init) => {
      const body = typeof init.body === "string" ? init.body : "";
      sawMaxOutputTokens ||= body.includes("max_output_tokens");

      const response = await modelTransport.terminal(input, init);
      statusCode = response.status;
      requestId = response.headers.get("x-request-id");
      if (!response.body) return response;

      // Read the terminal event from the provider's own bytes rather than from
      // the client's interpretation of them. The stop reason is the one field
      // that cannot be recovered after a one-shot billable request, so it is
      // taken from the wire.
      const [forSdk, forObserver] = response.body.tee();
      observed.consume(forObserver);
      return new Response(forSdk, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    },
    {
      baseUrl: endpoints.modelBaseUrl,
      expectations,
      resolveToken: () => store.getAccessToken(PROVIDER),
    },
  );

  const model = createCandidateModel({
    model: MODEL,
    baseUrl: endpoints.modelBaseUrl,
    fetch: decorated.fetch,
    resolveToken: () => store.getAccessToken(PROVIDER),
  }).bindTools([PROBE_TOOL], { strict: true });

  const stream = await model.stream([
    new HumanMessage({
      content: [
        { type: "text", text: "Call spike_probe with the value alpha. Do not answer in prose." },
      ],
    }),
  ]);

  const iterator = stream[Symbol.asyncIterator]();

  // Two independent bounds, because they fail differently. The idle race catches
  // a stalled stream, which an elapsed-time check after a chunk cannot see at
  // all. The wall-clock deadline catches a stream that keeps dripping just
  // inside the idle limit forever -- a case the socket timeout also misses,
  // because setTimeout on a ClientRequest measures inactivity, not duration.
  const total = timer(MODEL_TIMEOUT_MS, DEADLINE);
  try {
    for (;;) {
      const pending = iterator.next();
      const idle = timer(IDLE_STREAM_TIMEOUT_MS, IDLE);
      const settled = await Promise.race([pending, idle.promise, total.promise]);
      idle.cancel();

      if (settled === IDLE || settled === DEADLINE) {
        idleTimedOut = settled === IDLE;
        deadlineExceeded = settled === DEADLINE;
        abort.abort();
        pending.catch(() => {});
        throw new Error(
          settled === IDLE
            ? `stream idle for more than ${IDLE_STREAM_TIMEOUT_MS}ms`
            : `stream exceeded the ${MODEL_TIMEOUT_MS}ms wall-clock deadline`,
        );
      }
      if (settled.done) break;

      const now = Date.now();
      chunks += 1;
      firstByteMs ??= now - startedAt;

      const record = settled.value as unknown as Record<string, unknown>;
      const calls = record.tool_call_chunks as Array<{ name?: string }> | undefined;
      if (calls?.some((call) => call.name)) toolCalls += 1;

      const metadata = record.response_metadata as Record<string, unknown> | undefined;
      if (metadata?.model_name) responseModel = String(metadata.model_name);
      const usageMetadata = record.usage_metadata as Record<string, unknown> | undefined;
      if (usageMetadata) usage = usageMetadata;
    }
  } finally {
    total.cancel();
  }

  const wire = await observed.settled(5_000);
  responseModel ??= wire.model;
  const totalMs = Date.now() - startedAt;

  const revoked = await revokeRefreshToken(await newestStoredRefreshToken(store, refreshToken));

  const acceptance = {
    credential_survived_restart: true,
    request_succeeded: statusCode === 200,
    genuinely_streamed: chunks > 1,
    tool_call_parsed: toolCalls > 0,
    // Exact, or the documented dated-snapshot form of the same model. Anything
    // else invalidates the result rather than qualifying it.
    model_is_expected:
      responseModel === MODEL || (responseModel?.startsWith(`${MODEL}-`) ?? false),
    stop_reason_recorded: wire.stopReason !== null,
    usage_recorded: usage !== null || wire.usage !== null,
    request_id_recorded: requestId !== null,
    timings_recorded: firstByteMs !== null && totalMs > 0,
    dispatch_budget_respected: decorated.metrics.dispatches === 1,
    no_unbudgeted_refresh: refreshCalls === 0,
    oauth_resolver_used: decorated.metrics.tokenResolverCalls >= 1,
    max_output_tokens_absent: !sawMaxOutputTokens,
    idle_timeout_not_triggered: !idleTimedOut,
    deadline_not_exceeded: !deadlineExceeded,
    no_endpoint_refusals: modelTransport.refusals === 0 && auth.refusals === 0,
    no_global_fetch_bypass: poison.fired() === 0,
    refresh_token_revoked: revoked,
  };

  const code = emit({
    schema: EVIDENCE_SCHEMA,
    spike: SPIKE_ID,
    stage: "live-reload",
    synthetic: endpoints.synthetic,
    request: {
      status: statusCode,
      provider_request_id: requestId,
      model_requested: MODEL,
      model_returned: responseModel,
      stop_reason: wire.stopReason,
      incomplete_reason: wire.incompleteReason,
      chunks,
      time_to_first_chunk_ms: firstByteMs,
      total_ms: totalMs,
      tool_calls: toolCalls,
      usage: usage ?? wire.usage,
      dispatches: decorated.metrics.dispatches,
      removed_headers: [...new Set(decorated.metrics.removedHeaders)],
      body_operations: [...new Set(decorated.metrics.bodyOperations)],
    },
    isolation: {
      model_requests: modelTransport.requests,
      auth_requests: auth.requests,
      refresh_calls: refreshCalls,
      endpoint_refusals: modelTransport.refusals + auth.refusals,
      global_fetch_attempts: poison.fired(),
    },
    cleanup: { refresh_token_revoked: revoked, state_removed: revoked },
    acceptance,
    managed_digest: digest(acceptance),
    outcome: outcomeFor(acceptance),
  });

  // Only remove the local state once revocation is confirmed. Deleting the last
  // revocable token would leave a live session with no way to end it.
  if (revoked) await clearState();

  return code;
}

/** Recovery only. Revokes whatever the volume still holds, then clears it. */
async function runRevoke(): Promise<number> {
  scrubEnvironment();

  const store = createStore();
  const file = await store.read(PROVIDER).catch(() => null);
  const revoked = await revokeRefreshToken(file?.credential.refresh_token ?? null);
  if (revoked) await clearState();

  const acceptance = {
    credential_present: file !== null,
    refresh_token_revoked: revoked,
    no_endpoint_refusals: auth.refusals === 0,
  };

  return emit({
    schema: EVIDENCE_SCHEMA,
    spike: SPIKE_ID,
    stage: "live-revoke",
    synthetic: endpoints.synthetic,
    cleanup: { refresh_token_revoked: revoked, state_removed: revoked },
    acceptance,
    outcome: outcomeFor(acceptance),
  });
}

// ---------------------------------------------------------------------------

function createStore(): CredentialStore {
  return new CredentialStore({
    directory: join(STATE_DIR, "credentials"),
    clock: realClock,
    retryPolicy: NO_RETRY_POLICY,
    refresh: (credential) => {
      refreshCalls += 1;
      return requestRefresh(credential.refresh_token ?? "", {
        issuer: endpoints.issuer,
        fetch: auth.fetch,
        clock: realClock,
      });
    },
  });
}

/**
 * Reads the provider's own SSE bytes off a teed branch to recover the terminal
 * event. LangChain's chunk metadata is an interpretation; the stop reason is
 * the one field that cannot be re-obtained after a one-shot billable request,
 * so it is taken from the wire and the client's view is used only as a
 * fallback.
 *
 * Bounded: the tail is all that matters, so the buffer is capped rather than
 * accumulating an unbounded response.
 */
function createStreamObserver(): {
  consume: (body: ReadableStream<Uint8Array>) => void;
  settled: (timeoutMs: number) => Promise<StreamObservation>;
} {
  const result: StreamObservation = {
    stopReason: null,
    incompleteReason: null,
    model: null,
    usage: null,
  };
  let done: Promise<void> = Promise.resolve();

  return {
    consume: (body) => {
      done = (async () => {
        const decoder = new TextDecoder();
        let tail = "";
        for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
          tail += decoder.decode(chunk, { stream: true });
          if (tail.length > 262_144) tail = tail.slice(-131_072);
        }
        for (const line of tail.split("\n")) {
          if (!line.startsWith("data:")) continue;
          let event: unknown;
          try {
            event = JSON.parse(line.slice(5).trim());
          } catch {
            continue;
          }
          if (event === null || typeof event !== "object") continue;
          const response = (event as Record<string, unknown>).response;
          if (response === null || typeof response !== "object") continue;
          const record = response as Record<string, unknown>;
          if (typeof record.status === "string") result.stopReason = record.status;
          if (typeof record.model === "string") result.model = record.model;
          if (record.usage !== null && typeof record.usage === "object") {
            result.usage = record.usage as Record<string, unknown>;
          }
          const incomplete = record.incomplete_details;
          if (incomplete !== null && typeof incomplete === "object") {
            const reason = (incomplete as Record<string, unknown>).reason;
            if (typeof reason === "string") result.incompleteReason = reason;
          }
        }
      })().catch(() => {});
    },
    settled: async (timeoutMs) => {
      const guard = timer(timeoutMs, DEADLINE);
      await Promise.race([done, guard.promise]);
      guard.cancel();
      return result;
    },
  };
}

type StreamObservation = {
  stopReason: string | null;
  incompleteReason: string | null;
  model: string | null;
  usage: Record<string, unknown> | null;
};

/** Everything the spike put in the private volume, and nothing else. */
async function clearState(): Promise<void> {
  await rm(join(STATE_DIR, "credentials"), { recursive: true, force: true });
  await rm(join(STATE_DIR, "device-session.json"), { force: true });
}

/**
 * The refresh token the store holds *now*, not the one read at the start of the
 * stage. Both token resolvers call `getAccessToken`, which refreshes inside the
 * expiry margin and rotates the refresh token when the issuer supplies a new
 * one -- so the token captured before dispatch can already be superseded by the
 * time cleanup runs. Revoking that stale token can return success while the
 * live one stays valid, and the state removal that follows would then destroy
 * the only copy of it.
 */
async function newestStoredRefreshToken(
  store: CredentialStore | null,
  fallback: string | null,
): Promise<string | null> {
  if (!store) return fallback;
  const file = await store.read(PROVIDER).catch(() => null);
  return file?.credential.refresh_token ?? fallback;
}

/**
 * Best-effort revocation on a failure path. It must never mask the original
 * error, and it must never delete the credential: if revocation did not
 * succeed, the volume is the only way to finish the job later.
 */
async function revokeOnFailure(
  store: CredentialStore | null,
  fallbackToken: string | null,
  stage: string,
  cause: unknown,
): Promise<FailureCleanup> {
  const token = await newestStoredRefreshToken(store, fallbackToken);
  const revoked = await revokeRefreshToken(token);
  if (revoked) await clearState();

  const result: FailureCleanup = {
    attempted: token !== null,
    revoked,
    stateRemoved: revoked,
  };
  failureCleanup = result;

  process.stderr.write(
    `${JSON.stringify({
      stage,
      failure_cleanup: {
        attempted_revocation: result.attempted,
        revoked: result.revoked,
        state_removed: result.stateRemoved,
        cause: sanitizeText((cause as Error)?.message ?? "unknown"),
      },
    })}\n`,
  );

  return result;
}

async function revokeRefreshToken(token: string | null): Promise<boolean> {
  if (!token) return false;
  try {
    const response = await auth.fetch(`${endpoints.issuer}${OAUTH_REVOKE_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token,
        token_type_hint: "refresh_token",
        client_id: OAUTH_CLIENT_ID,
      }),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function inspectStateVolume(): Promise<{
  path: string;
  empty: boolean;
  writable: boolean;
  mode: number | null;
  uid: number | null;
}> {
  await mkdir(STATE_DIR, { recursive: true, mode: 0o700 }).catch(() => {});

  let mode: number | null = null;
  let uid: number | null = null;
  try {
    const info = await stat(STATE_DIR);
    mode = info.mode & 0o777;
    uid = info.uid;
  } catch {
    return { path: STATE_DIR, empty: false, writable: false, mode, uid };
  }

  const entries = await readdir(STATE_DIR).catch(() => null);
  if (entries === null) return { path: STATE_DIR, empty: false, writable: false, mode, uid };

  // Writability is proven by writing, not inferred from the mode bits: the
  // failure this guards against is a root-owned volume under --user 1000.
  const probe = join(STATE_DIR, ".write-probe");
  let writable = false;
  try {
    await writeFile(probe, "", { mode: 0o600 });
    await rm(probe, { force: true });
    writable = true;
  } catch {
    writable = false;
  }

  return { path: STATE_DIR, empty: entries.length === 0, writable, mode, uid };
}

function fingerprint(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

async function countListeners(): Promise<number> {
  let total = 0;
  for (const path of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    const raw = await readFile(path, "utf8").catch(() => "");
    for (const line of raw.split("\n").slice(1)) {
      if (line.trim().split(/\s+/)[3] === "0A") total += 1;
    }
  }
  return total;
}

export type { GuardedTransport, LiveEndpoints };
