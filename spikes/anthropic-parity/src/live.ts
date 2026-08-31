// The live subscription gate.
//
// Offline parity proves the candidate request is byte-identical to the shipped
// plugin's on every profile-bearing path. It cannot prove the provider accepts
// that profile. This does, with exactly two bounded requests.
//
// Credential handling, stated plainly: the OpenCode credential file is opened
// O_RDONLY and parsed once. Parsing necessarily materialises the whole provider
// record, so the honest claim is not "the refresh token was never read" but
// "the refresh token is never used, never persisted, and never emitted". Only
// the access token and its expiry are retained past the read.
//
// Exit codes match the offline driver: 0 pass, 1 measured negative, 3 fault.

import { createHash } from "node:crypto";
import { closeSync, fstatSync, openSync, readFileSync } from "node:fs";
import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import type { AIMessageChunk } from "@langchain/core/messages";
import { concat } from "@langchain/core/utils/stream";
import { ChatAnthropic } from "@langchain/anthropic";

import {
  CLAUDE_CODE_IDENTITY,
  PROFILE_ID,
  PROFILE_REVISION,
  REQUIRED_BETAS,
  USER_AGENT,
  buildBillingText,
  validateRequest,
} from "./profile.ts";
import { canonicalize, managedDigestInput } from "./canonical.ts";
import type { CanonicalRequest } from "./canonical.ts";
import { createCandidateFetch } from "./candidate.ts";
import { createCaptureSink, createPoisonedFetch } from "./capture.ts";
import { referenceProvenance } from "./reference.ts";
import { SENTINEL_API_KEY, summariseMessage, withTimeout } from "./lanes.ts";
import type { MessageSummary } from "./lanes.ts";

// --- approved budget --------------------------------------------------------

const MODEL = "claude-opus-5";
const MAX_TOKENS = 256;
const MAX_REQUESTS = 2;

const SDK_TIMEOUT_MS = 120_000;
const STREAM_TIMEOUT_MS = 45_000;
const IDLE_CHUNK_TIMEOUT_MS = 20_000;
const WALL_CLOCK_BUDGET_MS = 120_000;
const EXPIRY_MARGIN_MS = 15 * 60 * 1000;
const EXPIRY_SANITY_CEILING_MS = 400 * 24 * 3600 * 1000;

const PROMPT =
  "Call the mcp_Echo tool with the value parity-probe, then confirm the result.";
const EXPECTED_ECHO_VALUE = "parity-probe";

const TOOL = {
  name: "mcp_Echo",
  description: "Echo a short string back to the caller.",
  input_schema: {
    type: "object",
    properties: {
      value: { type: "string", description: "Text to echo." },
    },
    required: ["value"],
  },
};

const ENV_DENYLIST = [
  /^ANTHROPIC_/,
  /^OPENAI_/,
  /^CLAUDE_/,
  /^LANGSMITH/,
  /^LANGCHAIN/,
  /_API_KEY$/,
  /_TOKEN$/,
  /^AWS_/,
  /^HTTP_PROXY$/i,
  /^HTTPS_PROXY$/i,
  /^ALL_PROXY$/i,
];

// ---------------------------------------------------------------------------

function sha256(value: unknown): string {
  return createHash("sha256")
    .update(typeof value === "string" ? value : JSON.stringify(value))
    .digest("hex");
}

function fault(step: string, error: unknown): never {
  process.stdout.write(
    `${JSON.stringify(
      {
        schema: "agent-runtime/spike-evidence/1",
        spike: "anthropic-parity",
        stage: "live",
        collected_at: new Date().toISOString(),
        outcome: {
          status: "fault",
          fault: {
            kind: "harness",
            step,
            message: error instanceof Error ? error.message : String(error),
          },
          failed_criteria: null,
        },
        acceptance: null,
      },
      null,
      2,
    )}\n`,
  );
  process.exit(3);
}

// --- credential preflight ---------------------------------------------------

type Credential = {
  accessToken: string;
  expiresAt: number;
  meta: Record<string, unknown>;
};

function loadCredential(file: string): Credential {
  const fd = openSync(file, "r");
  let raw: string;
  let mode: number;
  let uid: number;
  try {
    const stat = fstatSync(fd);
    mode = stat.mode & 0o777;
    uid = stat.uid;
    raw = readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }

  const parsed = JSON.parse(raw) as Record<
    string,
    { type?: string; access?: string; expires?: number } | undefined
  >;
  const record = parsed.anthropic;

  const type = record?.type ?? null;
  const accessToken = typeof record?.access === "string" ? record.access : "";
  const expiresAt = typeof record?.expires === "number" ? record.expires : Number.NaN;

  const now = Date.now();
  const remainingMs = expiresAt - now;

  const problems: string[] = [];
  if ((mode & 0o077) !== 0) problems.push("CREDENTIAL_MODE_TOO_OPEN");
  if (uid !== process.getuid?.()) problems.push("CREDENTIAL_OWNER_MISMATCH");
  if (type !== "oauth") problems.push("CREDENTIAL_NOT_OAUTH");
  if (accessToken.length === 0) problems.push("CREDENTIAL_ACCESS_MISSING");
  if (!Number.isFinite(expiresAt)) problems.push("CREDENTIAL_EXPIRY_INVALID");
  if (remainingMs < EXPIRY_MARGIN_MS) problems.push("CREDENTIAL_NEAR_EXPIRY");
  if (remainingMs > EXPIRY_SANITY_CEILING_MS) problems.push("CREDENTIAL_EXPIRY_IMPLAUSIBLE");

  if (problems.length > 0) {
    throw new Error(`credential preflight failed: ${problems.join(", ")}`);
  }

  return {
    accessToken,
    expiresAt,
    meta: {
      // A symbolic label, not the path: a real path would self-trip the
      // host-path rule in the evidence scan.
      source_kind: "opencode-auth-json",
      opened_read_only: true,
      mode_octal: mode.toString(8),
      owner_matches_process: true,
      provider: "anthropic",
      type,
      expires_at: new Date(expiresAt).toISOString(),
      seconds_remaining_at_preflight: Math.floor(remainingMs / 1000),
      safety_margin_seconds: EXPIRY_MARGIN_MS / 1000,
      margin_satisfied: true,
      refresh_used: false,
      credential_written: false,
      token_length_class: "opaque",
    },
  };
}

// --- terminal fetch ---------------------------------------------------------

type RequestRecord = {
  index: number;
  role: string;
  host: string;
  path: string;
  query: Array<[string, string]>;
  method: string;
  stream: boolean;
  validated_before_dispatch: boolean;
  budget_violations: string[];
  sent_betas: string[];
  sent_user_agent: string | null;
  x_api_key_present: boolean;
  authorization_scheme: string | null;
  authorization_value: string;
  stainless_retry_count: string | null;
  managed_digest: string;
  billing_text: string | null;
  first_user_role: unknown;
  first_user_content_kind: string;
  http_status: number | null;
  request_id: string | null;
  chunk_count: number;
  ttfb_ms: number | null;
  duration_ms: number | null;
};

function headerOf(request: CanonicalRequest, name: string): string | undefined {
  return request.headers.find(([key]) => key === name)?.[1];
}

function checkBudget(request: CanonicalRequest): string[] {
  const problems: string[] = [];
  const body = (request.body ?? {}) as Record<string, unknown>;

  if (request.host !== "api.anthropic.com") problems.push("HOST_NOT_ALLOWED");
  if (request.path !== "/v1/messages") problems.push("PATH_NOT_ALLOWED");
  if (body.model !== MODEL) problems.push("MODEL_OUT_OF_BUDGET");
  if (body.max_tokens !== MAX_TOKENS) problems.push("MAX_TOKENS_OUT_OF_BUDGET");
  if (body.stream !== true) problems.push("STREAM_EXPECTED");
  if (headerOf(request, "x-stainless-retry-count") !== "0") {
    problems.push("RETRY_OBSERVED");
  }

  // The billing algorithm reads the FIRST user message in the whole history.
  // A history whose leading text turn was trimmed would silently derive an
  // empty-text billing header, so the shape is asserted rather than assumed.
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const first = messages[0] as { role?: unknown; content?: unknown } | undefined;
  if (first?.role !== "user") problems.push("FIRST_MESSAGE_NOT_USER");
  if (typeof first?.content !== "string") problems.push("FIRST_MESSAGE_NOT_TEXT");

  const system = body.system as Array<{ text?: unknown }> | undefined;
  const expectedBilling = buildBillingText([{ role: "user", content: PROMPT }]);
  if (system?.[0]?.text !== expectedBilling) problems.push("BILLING_TEXT_UNEXPECTED");
  if (system?.[1]?.text !== CLAUDE_CODE_IDENTITY) problems.push("IDENTITY_UNEXPECTED");

  return problems;
}

function instrumentBody(
  response: Response,
  record: RequestRecord,
  startedAt: number,
): Response {
  if (!response.body) return response;

  const reader = response.body.getReader();

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const idle = new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error("stream idle timeout")),
            IDLE_CHUNK_TIMEOUT_MS,
          );
          timer.unref?.();
        });
        const result = await Promise.race([reader.read(), idle]);
        if (result.done) {
          record.duration_ms = Date.now() - startedAt;
          controller.close();
          return;
        }
        record.chunk_count += 1;
        if (record.ttfb_ms === null) record.ttfb_ms = Date.now() - startedAt;
        controller.enqueue(result.value);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });

  return new Response(stream, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const credentialFile = process.env.LIVE_CREDENTIAL_FILE;
  if (!credentialFile) fault("config", new Error("LIVE_CREDENTIAL_FILE is unset"));

  const envOffenders = Object.keys(process.env).filter((key) =>
    ENV_DENYLIST.some((pattern) => pattern.test(key)),
  );
  if (envOffenders.length > 0) {
    fault("environment", new Error(`denylisted env present: ${envOffenders.join(", ")}`));
  }

  let credential: Credential;
  try {
    credential = loadCredential(credentialFile);
  } catch (error) {
    return fault("credential", error);
  }

  const provenance = await referenceProvenance().catch((error) =>
    fault("provenance", error),
  );

  // Anything that bypasses clientOptions.fetch -- including a stray refresh --
  // hits this instead of the network.
  const realFetch = globalThis.fetch.bind(globalThis);
  let poisonedFired = false;
  globalThis.fetch = createPoisonedFetch(() => {
    poisonedFired = true;
  }) as typeof globalThis.fetch;

  const records: RequestRecord[] = [];
  let dispatched = 0;
  let currentRole = "unknown";

  const terminal = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    dispatched += 1;
    if (dispatched > MAX_REQUESTS) {
      throw new Error(`request budget exceeded: ${dispatched} > ${MAX_REQUESTS}`);
    }

    const url = typeof input === "string" ? input : input.toString();
    const headers: Record<string, string> = {};
    if (init?.headers instanceof Headers) {
      init.headers.forEach((value, key) => {
        headers[key] = value;
      });
    }

    const canonical = canonicalize({
      method: (init?.method ?? "POST").toUpperCase(),
      url,
      headers,
      bodyRaw: typeof init?.body === "string" ? init.body : "",
    });

    const violations = validateRequest({
      method: canonical.method,
      host: canonical.host,
      path: canonical.path,
      query: canonical.query,
      headers: canonical.headers,
      body: (canonical.body ?? {}) as Record<string, unknown>,
    });
    const budget = checkBudget(canonical);

    const body = (canonical.body ?? {}) as Record<string, unknown>;
    const system = body.system as Array<{ text?: unknown }> | undefined;
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const first = messages[0] as { role?: unknown; content?: unknown } | undefined;
    const authorization = headerOf(canonical, "authorization") ?? null;

    const record: RequestRecord = {
      index: dispatched,
      role: currentRole,
      host: canonical.host,
      path: canonical.path,
      query: canonical.query,
      method: canonical.method,
      stream: body.stream === true,
      validated_before_dispatch: violations.length === 0,
      budget_violations: budget,
      sent_betas: (headerOf(canonical, "anthropic-beta") ?? "").split(",").filter(Boolean),
      sent_user_agent: headerOf(canonical, "user-agent") ?? null,
      x_api_key_present: headerOf(canonical, "x-api-key") !== undefined,
      authorization_scheme: authorization ? authorization.split(" ")[0]! : null,
      authorization_value: "<redacted>",
      stainless_retry_count: headerOf(canonical, "x-stainless-retry-count") ?? null,
      managed_digest: sha256(managedDigestInput(canonical)),
      billing_text: typeof system?.[0]?.text === "string" ? system[0].text : null,
      first_user_role: first?.role ?? null,
      first_user_content_kind: typeof first?.content,
      http_status: null,
      request_id: null,
      chunk_count: 0,
      ttfb_ms: null,
      duration_ms: null,
    };
    records.push(record);

    if (violations.length > 0 || budget.length > 0) {
      throw new Error(
        `refused before dispatch: ${[...violations.map((v) => v.code), ...budget].join(", ")}`,
      );
    }

    const startedAt = Date.now();
    const response = await realFetch(url, init);
    record.http_status = response.status;
    record.request_id =
      response.headers.get("request-id") ??
      response.headers.get("anthropic-request-id");

    return instrumentBody(response, record, startedAt);
  };

  const liveFetch = createCandidateFetch({
    accessToken: credential.accessToken,
    terminal,
    validate: true,
  });

  // --- prove the gate is armed, without touching the network ---------------
  const selfTestSink = createCaptureSink(() => new Response("{}", { status: 200 }));
  const selfTestFetch = createCandidateFetch({
    accessToken: credential.accessToken,
    terminal: selfTestSink.fetch,
    mutate: (pending) => pending.headers.set("user-agent", "curl/8.15.0"),
  });

  let gateSelfTest = { blocked: false, dispatched: true, codes: [] as string[] };
  try {
    await selfTestFetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: new Headers({ "content-type": "application/json" }),
      body: JSON.stringify({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        stream: true,
        messages: [{ role: "user", content: PROMPT }],
      }),
    });
  } catch (error) {
    const typed = error as Error & {
      profileViolation?: boolean;
      violations?: Array<{ code: string }>;
    };
    if (typed.profileViolation === true) {
      gateSelfTest = {
        blocked: true,
        dispatched: selfTestSink.captures.length > 0,
        codes: (typed.violations ?? []).map((violation) => violation.code),
      };
    }
  }

  if (
    !gateSelfTest.blocked ||
    gateSelfTest.dispatched ||
    !gateSelfTest.codes.includes("USER_AGENT_MISMATCH")
  ) {
    globalThis.fetch = realFetch;
    return fault("gate-selftest", new Error("validator gate did not block a mutated request"));
  }

  // --- the two provider requests -------------------------------------------
  const model = new ChatAnthropic({
    model: MODEL,
    maxTokens: MAX_TOKENS,
    apiKey: SENTINEL_API_KEY,
    maxRetries: 0,
    clientOptions: {
      fetch: liveFetch as never,
      dangerouslyAllowBrowser: false,
      maxRetries: 0,
      timeout: SDK_TIMEOUT_MS,
    },
  });

  let first: MessageSummary;
  let second: MessageSummary;
  let localTool = {
    invoked: false,
    name: TOOL.name,
    pure: true,
    side_effects: [] as string[],
    result_equals_input: false,
    input_matched_expected: false,
  };

  try {
    await withTimeout("live-probe", WALL_CLOCK_BUDGET_MS, async () => {
      currentRole = "force-tool";
      const forced = model.bindTools([TOOL] as never, {
        tool_choice: { type: "tool", name: TOOL.name },
      } as never);

      const firstStream = await withTimeout("live/r1", STREAM_TIMEOUT_MS, () =>
        forced.stream([new HumanMessage(PROMPT)]),
      );
      let firstAggregate: AIMessageChunk | undefined;
      for await (const chunk of firstStream) {
        firstAggregate = firstAggregate === undefined ? chunk : concat(firstAggregate, chunk);
      }
      if (firstAggregate === undefined) throw new Error("request 1 produced no chunks");
      first = summariseMessage(firstAggregate);

      const call = first.toolCalls[0];
      if (!call || typeof call.id !== "string") {
        throw new Error("request 1 returned no usable tool call");
      }
      // Hoisted so the narrowing survives into the stream callback below.
      const toolCallId: string = call.id;
      const toolCallName: string = call.name;
      const toolCallArgs = call.args as Record<string, unknown>;

      // Pure, bounded, side-effect free: no fs, net, env, or process access.
      const args = call.args as { value?: unknown };
      const value = typeof args?.value === "string" ? args.value : "";
      if (value.length > 64) throw new Error("tool argument too long");
      const echoed = value;
      localTool = {
        invoked: true,
        name: TOOL.name,
        pure: true,
        side_effects: [],
        result_equals_input: echoed === value,
        input_matched_expected: value === EXPECTED_ECHO_VALUE,
      };

      currentRole = "tool-result-then-text";
      const open = model.bindTools([TOOL] as never);
      const secondStream = await withTimeout("live/r2", STREAM_TIMEOUT_MS, () =>
        open.stream([
          new HumanMessage(PROMPT),
          new AIMessage({
            content: first.text,
            tool_calls: [
              { name: toolCallName, args: toolCallArgs, id: toolCallId, type: "tool_call" },
            ],
          }),
          new ToolMessage({ content: echoed, tool_call_id: toolCallId }),
        ]),
      );
      let secondAggregate: AIMessageChunk | undefined;
      for await (const chunk of secondStream) {
        secondAggregate = secondAggregate === undefined ? chunk : concat(secondAggregate, chunk);
      }
      if (secondAggregate === undefined) throw new Error("request 2 produced no chunks");
      second = summariseMessage(secondAggregate);
    });
  } catch (error) {
    globalThis.fetch = realFetch;
    // A provider rejection or malformed stream is a measured negative, not a
    // fault: it answers the architectural question in the negative.
    const message = error instanceof Error ? error.message : String(error);
    const measured = /status|4\d\d|5\d\d|stream|chunk|tool call|parse/i.test(message);
    const payload = {
      schema: "agent-runtime/spike-evidence/1",
      spike: "anthropic-parity",
      stage: "live",
      collected_at: new Date().toISOString(),
      profile: { profile_id: PROFILE_ID, profile_revision: PROFILE_REVISION },
      credential: credential.meta,
      requests: records,
      gating: {
        dispatch_count: dispatched,
        expected_dispatch_count: MAX_REQUESTS,
        global_fetch_poisoned: true,
        poisoned_fetch_fired: poisonedFired,
        validator_gate_proven_live: true,
        gate_selftest: gateSelfTest,
      },
      outcome: measured
        ? { status: "fail", failed_criteria: 1, failed: ["live_conversation_completed"], error: message, fault: null }
        : { status: "fault", failed_criteria: null, fault: { kind: "harness", step: "live", message } },
    };
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    process.exit(measured ? 1 : 3);
  }

  globalThis.fetch = realFetch;

  // --- assertions ----------------------------------------------------------
  const r1 = records[0];
  const r2 = records[1];
  const usage1 = (first!.usage ?? {}) as { input_tokens?: number; output_tokens?: number };
  const usage2 = (second!.usage ?? {}) as { input_tokens?: number; output_tokens?: number };
  const call = first!.toolCalls[0];

  const acceptance: Record<string, boolean> = {
    credential_read_only: true,
    expiry_margin_respected: true,
    no_refresh_no_rotation: poisonedFired === false,
    validator_gate_proven_live:
      gateSelfTest.blocked && !gateSelfTest.dispatched,
    validator_gated_every_request: records.every((r) => r.validated_before_dispatch),
    budget_respected_every_request: records.every((r) => r.budget_violations.length === 0),
    request_count_bounded: dispatched === MAX_REQUESTS,
    no_retries_observed: records.every((r) => r.stainless_retry_count === "0"),
    profile_headers_sent: records.every(
      (r) =>
        r.sent_user_agent === USER_AGENT &&
        r.x_api_key_present === false &&
        r.authorization_scheme === "Bearer" &&
        REQUIRED_BETAS.every((beta, index) => r.sent_betas[index] === beta),
    ),
    both_requests_http_200: records.every((r) => r.http_status === 200),
    both_requests_streamed: records.every((r) => r.chunk_count > 1),
    r1_forced_tool_call: first!.stopReason === "tool_use" && first!.toolCalls.length === 1,
    r1_tool_name_is_wire_native: call?.name === TOOL.name,
    r1_tool_args_fully_parsed:
      typeof (call?.args as { value?: unknown })?.value === "string",
    r1_tool_use_id_shape: typeof call?.id === "string" && call.id.startsWith("toolu_"),
    local_tool_side_effect_free: localTool.pure && localTool.side_effects.length === 0,
    r2_tool_result_accepted: second!.stopReason === "end_turn",
    r2_final_text_streamed: second!.text.length > 0 && second!.toolCalls.length === 0,
    r2_distinct_response_id:
      typeof second!.responseId === "string" && second!.responseId !== first!.responseId,
    billing_header_stable_across_turns:
      r1?.billing_text !== null && r1?.billing_text === r2?.billing_text,
    billing_matches_independent_recomputation:
      r1?.billing_text === buildBillingText([{ role: "user", content: PROMPT }]),
    first_message_is_text_user_turn: records.every(
      (r) => r.first_user_role === "user" && r.first_user_content_kind === "string",
    ),
    output_tokens_within_cap:
      (usage1.output_tokens ?? 0) > 0 &&
      (usage1.output_tokens ?? 0) <= MAX_TOKENS &&
      (usage2.output_tokens ?? 0) > 0 &&
      (usage2.output_tokens ?? 0) <= MAX_TOKENS,
    usage_reported: (usage1.input_tokens ?? 0) > 0 && (usage2.input_tokens ?? 0) > 0,
  };

  const evidence = {
    schema: "agent-runtime/spike-evidence/1",
    spike: "anthropic-parity",
    stage: "live",
    collected_at: new Date().toISOString(),

    profile: {
      profile_id: PROFILE_ID,
      profile_revision: PROFILE_REVISION,
      user_agent: USER_AGENT,
      required_betas: REQUIRED_BETAS,
    },

    environment: {
      node_version: process.version,
      platform: process.platform,
      arch: process.arch,
      tz: process.env.TZ ?? null,
      denylist_clean: true,
    },

    provenance,
    credential: credential.meta,

    request_budget: {
      max_requests: MAX_REQUESTS,
      max_tokens: MAX_TOKENS,
      langchain_max_retries: 0,
      sdk_max_retries: 0,
      sdk_timeout_ms: SDK_TIMEOUT_MS,
      per_stream_timeout_ms: STREAM_TIMEOUT_MS,
      idle_chunk_timeout_ms: IDLE_CHUNK_TIMEOUT_MS,
      wall_clock_budget_ms: WALL_CLOCK_BUDGET_MS,
    },

    conversation: {
      model_requested: MODEL,
      model_returned_r1: first!.model,
      model_returned_r2: second!.model,
      tool: {
        name: TOOL.name,
        schema_sha256: sha256(TOOL.input_schema),
        matches_name_pattern: true,
      },
      prompt_sha256: sha256(PROMPT),
      system_block_count: 2,
      tool_choice_r1: `tool:${TOOL.name}`,
      tool_choice_r2: "auto",
    },

    billing: {
      algorithm: "first-user-text",
      billing_text_r1: r1?.billing_text ?? null,
      billing_text_stable_across_requests: r1?.billing_text === r2?.billing_text,
      matches_independent_recomputation:
        r1?.billing_text === buildBillingText([{ role: "user", content: PROMPT }]),
      r2_contains_tool_result_as_user: true,
    },

    requests: records,

    responses: [
      {
        index: 1,
        stop_reason: first!.stopReason,
        response_id: first!.responseId,
        tool_calls: first!.toolCalls.map((c) => ({
          name: c.name,
          id_prefix_ok: typeof c.id === "string" && c.id.startsWith("toolu_"),
          args_keys: Object.keys((c.args ?? {}) as Record<string, unknown>),
        })),
        usage: first!.usage,
        text_length: first!.text.length,
      },
      {
        index: 2,
        stop_reason: second!.stopReason,
        response_id: second!.responseId,
        tool_calls: second!.toolCalls.length,
        usage: second!.usage,
        text_length: second!.text.length,
      },
    ],

    local_tool: localTool,

    gating: {
      dispatch_count: dispatched,
      expected_dispatch_count: MAX_REQUESTS,
      global_fetch_poisoned: true,
      poisoned_fetch_fired: poisonedFired,
      validator_gate_proven_live: true,
      gate_selftest: {
        mutation: "wrong-user-agent",
        expected_code: "USER_AGENT_MISMATCH",
        blocked: gateSelfTest.blocked,
        dispatched: gateSelfTest.dispatched,
      },
    },

    acceptance,
  };

  const serialised = JSON.stringify(evidence, null, 2);
  if (serialised.includes(credential.accessToken)) {
    return fault("sanitization", new Error("access token reached evidence"));
  }
  if (/sk-ant-(?:api|oat|ort)\d{2}-/.test(serialised)) {
    return fault("sanitization", new Error("credential-shaped string reached evidence"));
  }

  const failed = Object.entries(acceptance).filter(([, value]) => value === false);
  process.stdout.write(
    `${JSON.stringify(
      {
        ...evidence,
        outcome: {
          status: failed.length === 0 ? "pass" : "fail",
          failed_criteria: failed.length,
          failed: failed.map(([key]) => key),
          fault: null,
        },
      },
      null,
      2,
    )}\n`,
  );
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((error) => fault("main", error));
