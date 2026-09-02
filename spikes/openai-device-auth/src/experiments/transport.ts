// The offline transport differential.
//
// Two things are being separated here, and keeping them separate is the whole
// design:
//
//   gate A   the profile validator, which fails closed before dispatch
//   gate B   a complete canonical wire diff against the oracle capture
//
// Gate B catches drift the validator cannot see, because the validator
// recomputes from the same inputs and is therefore self-consistent with its own
// mistakes. A deliberate mutation that the validator does not check must still
// be caught by gate B, or the two are not independent and the differential is
// decorative.
//
// The oracle is the released Codex binary. If it cannot be run, that is
// recorded as an unavailable lane -- never silently replaced by the transcribed
// profile, which would be comparing the harness against its own assumptions.

import { HumanMessage } from "@langchain/core/messages";

import {
  canonicalize,
  diffRequests,
  managedDigestInput,
  validateAllowlist,
  type CanonicalRequest,
  type RawCapture,
  type WireDiff,
} from "../transport/canonical.ts";
import {
  createCandidateModel,
  createDecoratedFetch,
  scrubEnvironment,
  type MutableRequest,
} from "../transport/candidate.ts";
import {
  CODEX_FORBIDDEN_ON_CANDIDATE,
  ProfileViolationError,
  validateRequest,
  type ProfileExpectations,
  type ViolationCode,
} from "../transport/profile.ts";
import {
  createCaptureSink,
  createPoisonedFetch,
  responsesStreamEvents,
  streamResponse,
} from "../synthetic/provider.ts";
import { CHUNKERS } from "../synthetic/chunkers.ts";
import { SENTINEL_ACCOUNT_ID } from "../synthetic/issuer.ts";
import { CODEX_VERSION, ORIGINATOR, SUBSCRIPTION_BASE_URL } from "../reference.ts";
import { sanitizeText } from "../evidence.ts";
import { createNodeHttpTerminal, FETCH_UNREMOVABLE_HEADERS } from "../transport/node-http-terminal.ts";
import { serveOracleCapture } from "../oracle/capture-server.ts";
import { launchCodex, prepareCodexHome } from "../oracle/codex-http.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const OFFLINE_BASE_URL = "http://oracle.invalid/backend-api/codex";

/**
 * The un-poisoned fetch, kept so the loopback capture lane can still reach
 * 127.0.0.1 while every other path is poisoned.
 */
let trustedFetch: typeof globalThis.fetch | null = null;
const MODEL = "gpt-5.6-sol";
const USER_AGENT = `${ORIGINATOR}/${CODEX_VERSION} (Linux 6.0.0; x86_64) spike`;

const EXPECTATIONS: ProfileExpectations = {
  accountId: SENTINEL_ACCOUNT_ID,
  allowedModels: [MODEL],
  residency: null,
  userAgent: USER_AGENT,
};

/** Authored JSON Schema literals: no Zod converter in the trusted set. */
export const PROBE_TOOL = {
  type: "function" as const,
  function: {
    name: "spike_probe",
    description: "Return the supplied value unchanged. Has no side effects.",
    parameters: {
      type: "object",
      properties: { value: { type: "string", description: "Text to echo back." } },
      required: ["value"],
      additionalProperties: false,
    },
  },
};

export type TransportCase = {
  id: string;
  purpose: string;
  prompt: string;
};

export const TRANSPORT_CASES: readonly TransportCase[] = [
  { id: "T-1", purpose: "single user turn with one bound tool", prompt: "Probe the value alpha." },
  { id: "T-2", purpose: "longer prompt, same binding", prompt: "Probe the value beta, then stop." },
];

export type MutationSpec = {
  id: string;
  code: ViolationCode;
  apply: (request: MutableRequest) => void;
};

/** Each mutation must fire its own code and dispatch nothing. */
export const MUTATIONS: readonly MutationSpec[] = [
  { id: "accept", code: "ACCEPT_MISMATCH", apply: (r) => r.headers.set("accept", "application/json") },
  { id: "auth-scheme", code: "AUTH_SCHEME_INVALID", apply: (r) => r.headers.set("authorization", "Token abc") },
  { id: "auth-missing", code: "AUTH_MISSING", apply: (r) => r.headers.delete("authorization") },
  { id: "account", code: "ACCOUNT_HEADER_MISSING", apply: (r) => r.headers.delete("chatgpt-account-id") },
  { id: "residency", code: "RESIDENCY_HEADER_UNEXPECTED", apply: (r) => r.headers.set("x-openai-internal-codex-residency", "us") },
  { id: "originator", code: "ORIGINATOR_MISMATCH", apply: (r) => r.headers.set("originator", "not_codex") },
  { id: "user-agent", code: "USER_AGENT_MISMATCH", apply: (r) => r.headers.set("user-agent", "curl/8") },
  { id: "version", code: "VERSION_HEADER_MISMATCH", apply: (r) => r.headers.set("version", "0.0.0") },
  { id: "stainless", code: "UNKNOWN_HEADER", apply: (r) => r.headers.set("x-stainless-lang", "js") },
  { id: "forbidden-header", code: "FORBIDDEN_HEADER_PRESENT", apply: (r) => r.headers.set("x-api-key", "k") },
  { id: "store", code: "STORE_NOT_FALSE", apply: (r) => { r.body.store = true; } },
  { id: "stream", code: "STREAM_NOT_TRUE", apply: (r) => { r.body.stream = false; } },
  { id: "tool-choice", code: "TOOL_CHOICE_MISSING", apply: (r) => { delete r.body.tool_choice; } },
  { id: "include", code: "INCLUDE_MISMATCH", apply: (r) => { r.body.include = []; } },
  { id: "max-output-tokens", code: "MAX_OUTPUT_TOKENS_PRESENT", apply: (r) => { r.body.max_output_tokens = 256; } },
  { id: "temperature", code: "UNSUPPORTED_PARAM_PRESENT", apply: (r) => { r.body.temperature = 0.5; } },
  { id: "model", code: "MODEL_NOT_ALLOWED", apply: (r) => { r.body.model = "gpt-4"; } },
  { id: "product-field", code: "CODEX_PRODUCT_FIELD_ON_CANDIDATE", apply: (r) => { r.body.client_metadata = { a: 1 }; } },
  { id: "thread-id", code: "THREAD_ID_INCONSISTENT", apply: (r) => r.headers.set("thread-id", randomUUID()) },
  { id: "routing-hint", code: "ROUTING_HINT_INCONSISTENT", apply: (r) => r.headers.set("x-codex-routing-hint", "model=other") },
  { id: "path", code: "PATH_MISMATCH", apply: (r) => { r.url.pathname = "/backend-api/codex/chat"; } },
  { id: "query", code: "QUERY_PARAM_PRESENT", apply: (r) => { r.url.searchParams.set("beta", "true"); } },
];

export type TransportReport = {
  environmentScrubbed: string[];
  allowlistErrors: string[];
  allowlistSize: number;
  cases: Array<{
    id: string;
    purpose: string;
    dispatched: number;
    violations: number;
    bodyOperations: string[];
    removedHeaders: string[];
    tokenResolverCalls: number;
    controlDiffers: boolean;
    violationCodes: string[];
    canonical: CanonicalRequest | null;
  }>;
  oracle: OracleReport;
  comparison: ComparisonReport | null;
  userTurn: UserTurnReport | null;
  fetchLaneHeaders: string[];
  mutations: Array<{ id: string; code: string; fired: boolean; dispatched: number }>;
  differentialMutation: { detectedByWireDiff: boolean; validatorStayedGreen: boolean } | null;
  streaming: Array<{ chunker: string; toolCallParsed: boolean; argumentsComplete: boolean }>;
  truncatedStreamRejected: boolean;
  responsesApiControl: { path: string | null; differs: boolean };
  forwardAttempts: number;
  poisonFired: number;
  managedDigestInput: unknown;
  acceptance: Record<string, boolean>;
};

export type OracleReport = {
  available: boolean;
  reason: string | null;
  exitCode: number | null;
  stderrTail: string;
  captures: number;
  websocketAttempts: number;
  canonical: CanonicalRequest | null;
  /** Names only, so the classification can be audited without the values. */
  headerNames: string[];
  bodyKeys: string[];
};

export type UserTurnReport = {
  matches: boolean;
  oracle: unknown;
  candidate: unknown;
};

export type ComparisonReport = {
  profileBearing: number;
  unexplained: number;
  volatile: number;
  codexProduct: number;
  productOnCandidate: string[];
  diffs: WireDiff[];
};

export async function runTransportExperiment(): Promise<TransportReport> {
  const environmentScrubbed = scrubEnvironment();
  const allowlistErrors = validateAllowlist();

  let poisonFired = 0;
  const originalFetch = globalThis.fetch;
  trustedFetch = originalFetch;
  globalThis.fetch = createPoisonedFetch(() => {
    poisonFired += 1;
  }) as typeof globalThis.fetch;

  try {
    const cases: TransportReport["cases"] = [];
    let forwardAttempts = 0;

    for (const testCase of TRANSPORT_CASES) {
      const candidate = await driveCandidate(testCase.prompt, {});
      const control = await driveCandidate(testCase.prompt, { decorate: false });
      forwardAttempts += candidate.sink.forwardAttempts + control.sink.forwardAttempts;

      // A candidate that fails its own gate dispatches nothing, so there is no
      // capture to canonicalise. That is a *measured negative*, not a broken
      // apparatus, and conflating the two would destroy the only distinction
      // the exit codes exist to make.
      const rawCandidate = candidate.sink.captures[0];
      if (!rawCandidate) {
        const refused = findViolation(candidate.error);
        cases.push({
          id: testCase.id,
          purpose: testCase.purpose,
          dispatched: candidate.metrics.dispatches,
          violations: refused ? refused.violations.length : 1,
          violationCodes: refused ? refused.violations.map((v) => v.code) : ["NO_DISPATCH"],
          bodyOperations: [...new Set(candidate.metrics.bodyOperations)],
          removedHeaders: [...new Set(candidate.metrics.removedHeaders)],
          tokenResolverCalls: candidate.metrics.tokenResolverCalls,
          controlDiffers: true,
          canonical: null,
        });
        continue;
      }

      const candidateCanonical = canonicalize(rawCandidate, "/backend-api/codex");
      const controlCanonical = control.sink.captures[0]
        ? canonicalize(control.sink.captures[0], "/backend-api/codex")
        : null;

      const violations = validateRequest(
        {
          method: candidateCanonical.method,
          path: candidateCanonical.path,
          query: candidateCanonical.query,
          headers: new Map(candidateCanonical.headers),
          body: candidateCanonical.body as Record<string, unknown>,
        },
        EXPECTATIONS,
      );

      cases.push({
        id: testCase.id,
        purpose: testCase.purpose,
        dispatched: candidate.metrics.dispatches,
        violations: violations.length,
        violationCodes: violations.map((entry) => entry.code),
        bodyOperations: [...new Set(candidate.metrics.bodyOperations)],
        removedHeaders: [...new Set(candidate.metrics.removedHeaders)],
        tokenResolverCalls: candidate.metrics.tokenResolverCalls,
        controlDiffers:
          controlCanonical === null ||
          JSON.stringify(controlCanonical) !== JSON.stringify(candidateCanonical),
        canonical: candidateCanonical,
      });
    }

    const mutations = await runMutations();
    const streaming = await runStreamingCases();
    const truncatedStreamRejected = await runTruncatedStream();
    const responsesApiControl = await runResponsesApiControl();
    const oracle = await runOracleLane();

    // The oracle is captured server-side, so the candidate must be too --
    // otherwise `host` and `content-length` differ because of where the two
    // recordings were taken rather than because of what was sent. The
    // comparison case binds no tools, matching the responses-lite request the
    // oracle actually emits for this model.
    const comparisonCandidate = await captureCandidateOverLoopback();
    const fetchLaneHeaders = await captureCandidateOverFetch();
    const comparison =
      oracle.canonical && comparisonCandidate
        ? compare(oracle.canonical, comparisonCandidate)
        : null;
    const userTurn =
      oracle.canonical && comparisonCandidate
        ? compareUserTurn(oracle.canonical, comparisonCandidate)
        : null;
    const differentialMutation = comparison ? await runDifferentialMutation(oracle.canonical!) : null;

    const acceptance: Record<string, boolean> = {
      allowlist_empty_and_valid: allowlistErrors.length === 0,
      candidate_dispatches_once_per_call: cases.every((entry) => entry.dispatched === 1),
      candidate_passes_profile: cases.every((entry) => entry.violations === 0),
      oauth_token_resolved_per_request: cases.every((entry) => entry.tokenResolverCalls >= 1),
      sdk_fingerprint_headers_removed: cases.every((entry) =>
        entry.removedHeaders.some((name) => name.startsWith("x-stainless-")),
      ),
      decorator_is_load_bearing: cases.every((entry) => entry.controlDiffers),
      responses_api_selection_is_load_bearing: responsesApiControl.differs,
      mutations_fail_closed: mutations.every((entry) => entry.fired && entry.dispatched === 0),
      streaming_tool_call_parsed_all_chunkers: streaming.every(
        (entry) => entry.toolCallParsed && entry.argumentsComplete,
      ),
      truncated_stream_not_completed: truncatedStreamRejected,
      no_forward_attempts: forwardAttempts === 0 && poisonFired === 0,
      oracle_lane_available: oracle.available,
      wire_diff_no_profile_bearing: comparison !== null && comparison.profileBearing === 0,
      wire_diff_no_unexplained: comparison !== null && comparison.unexplained === 0,
      no_codex_product_field_on_candidate:
        comparison !== null && comparison.productOnCandidate.length === 0,
      differential_catches_validator_blind_spot:
        differentialMutation !== null &&
        differentialMutation.detectedByWireDiff &&
        differentialMutation.validatorStayedGreen,
      user_turn_encoding_matches: userTurn !== null && userTurn.matches,
      // The finding this records: the stock global fetch adds headers the
      // reference client never sends and no caller can remove, so the terminal
      // transport has to be node:http for the profile to be reachable at all.
      fetch_adds_unremovable_headers: FETCH_UNREMOVABLE_HEADERS.every((name) =>
        fetchLaneHeaders.includes(name),
      ),
    };

    return {
      environmentScrubbed,
      allowlistErrors,
      allowlistSize: 0,
      cases,
      oracle,
      comparison,
      mutations,
      differentialMutation,
      streaming,
      truncatedStreamRejected,
      responsesApiControl,
      userTurn,
      fetchLaneHeaders,
      forwardAttempts,
      poisonFired,
      managedDigestInput: cases[0]?.canonical
        ? managedDigestInput(cases[0].canonical)
        : { unavailable: "candidate refused its own profile gate" },
      acceptance,
    };
  } finally {
    globalThis.fetch = originalFetch;
  }
}

// ---------------------------------------------------------------------------

type DriveOptions = {
  decorate?: boolean;
  /** Replaces the in-process sink, so the request is captured as received. */
  terminal?: (input: string, init: RequestInit) => Promise<Response>;
  withTools?: boolean;
  validate?: boolean;
  mutate?: (request: MutableRequest) => void;
  chunker?: (typeof CHUNKERS)[number];
  truncate?: boolean;
  baseUrl?: string;
};

async function driveCandidate(prompt: string, options: DriveOptions) {
  const events = responsesStreamEvents({
    responseId: "resp_SPIKESENTINEL",
    model: MODEL,
    toolName: PROBE_TOOL.function.name,
    toolArguments: JSON.stringify({ value: "alpha" }),
    truncate: options.truncate,
  }).join("");

  const chunks = (options.chunker ?? CHUNKERS[0]!).split(events);
  const sink = createCaptureSink(() => streamResponse(chunks));

  const decorated = createDecoratedFetch(options.terminal ?? sink.fetch, {
    baseUrl: options.baseUrl ?? OFFLINE_BASE_URL,
    expectations: EXPECTATIONS,
    resolveToken: async () => "SPIKE-ACCESS-TOKEN",
    enabled: options.decorate !== false,
    validate: options.validate,
    mutate: options.mutate,
  });

  const base = createCandidateModel({
    model: MODEL,
    baseUrl: options.baseUrl ?? OFFLINE_BASE_URL,
    fetch: decorated.fetch,
    resolveToken: async () => "SPIKE-ACCESS-TOKEN",
  });
  const model = options.withTools === false ? base : base.bindTools([PROBE_TOOL], { strict: true });

  const collected: Array<Record<string, unknown>> = [];
  let error: unknown = null;

  try {
    const stream = await model.stream([
      new HumanMessage({ content: [{ type: "text", text: prompt }] }),
    ]);
    for await (const chunk of stream) {
      collected.push(chunk as unknown as Record<string, unknown>);
    }
  } catch (caught) {
    error = caught;
  }

  return { sink, metrics: decorated.metrics, collected, error };
}

async function runMutations(): Promise<TransportReport["mutations"]> {
  const results: TransportReport["mutations"] = [];

  for (const mutation of MUTATIONS) {
    const run = await driveCandidate(TRANSPORT_CASES[0]!.prompt, { mutate: mutation.apply });
    const violation = findViolation(run.error);
    results.push({
      id: mutation.id,
      code: mutation.code,
      fired: violation !== null && violation.violations.some((v) => v.code === mutation.code),
      dispatched: run.sink.captures.length,
    });
  }

  return results;
}

async function runStreamingCases(): Promise<TransportReport["streaming"]> {
  const results: TransportReport["streaming"] = [];

  for (const chunker of CHUNKERS) {
    const run = await driveCandidate(TRANSPORT_CASES[0]!.prompt, { chunker });
    const assembled = assembleToolCall(run.collected);
    results.push({
      chunker: chunker.id,
      toolCallParsed: assembled.name === PROBE_TOOL.function.name,
      argumentsComplete: assembled.argumentsComplete,
    });
  }

  return results;
}

async function runTruncatedStream(): Promise<boolean> {
  const run = await driveCandidate(TRANSPORT_CASES[0]!.prompt, { truncate: true });
  const assembled = assembleToolCall(run.collected);
  // A stream cut mid-arguments must not be presented as a finished tool call.
  return !assembled.argumentsComplete;
}

async function runResponsesApiControl(): Promise<TransportReport["responsesApiControl"]> {
  const sink = createCaptureSink(() =>
    streamResponse([new TextEncoder().encode("data: [DONE]\n\n")]),
  );

  const { ChatOpenAI } = await import("@langchain/openai");
  const model = new ChatOpenAI({
    model: MODEL,
    useResponsesApi: false,
    streaming: true,
    maxRetries: 0,
    apiKey: "sk-SPIKESENTINEL-not-a-real-key",
    configuration: {
      baseURL: OFFLINE_BASE_URL,
      fetch: (async (input: string, init: RequestInit) =>
        sink.fetch(input, init)) as unknown as typeof globalThis.fetch,
    },
  });

  try {
    const stream = await model.stream([new HumanMessage("control")]);
    for await (const _chunk of stream) void _chunk;
  } catch {
    // The synthetic body is not a valid Chat Completions stream; the path is
    // what is being measured, not the parse.
  }

  const path = sink.captures[0] ? new URL(sink.captures[0].url).pathname : null;
  return { path, differs: path !== null && !path.endsWith("/responses") };
}

async function runOracleLane(): Promise<OracleReport> {
  const sse = responsesStreamEvents({
    responseId: "resp_ORACLE",
    model: MODEL,
    toolName: PROBE_TOOL.function.name,
    toolArguments: JSON.stringify({ value: "alpha" }),
  }).join("");

  const server = await serveOracleCapture({ basePath: "/backend-api/codex", sse });
  const home = await mkdtemp(join(tmpdir(), "spike-codex-"));

  try {
    await prepareCodexHome({
      codexHome: join(home, "codex"),
      captureBaseUrl: server.url,
      model: MODEL,
      nowSeconds: Math.floor(Date.now() / 1000),
    });

    const launch = await launchCodex({
      codexHome: join(home, "codex"),
      workDirectory: join(home, "work"),
      captureBaseUrl: server.url,
      model: MODEL,
      prompt: TRANSPORT_CASES[0]!.prompt,
      timeoutMs: 90_000,
    });

    const capture = server.captures[0] ?? null;

    return {
      available: capture !== null,
      reason:
        capture === null
          ? launch.timedOut
            ? "the oracle produced no request before the timeout"
            : "the oracle produced no request"
          : null,
      exitCode: launch.exitCode,
      stderrTail: redactTail(launch.stderr),
      captures: server.captures.length,
      websocketAttempts: server.otherRequests.length,
      canonical: capture ? canonicalize(capture, "/backend-api/codex") : null,
      headerNames: capture ? Object.keys(capture.headers).map((n) => n.toLowerCase()).sort() : [],
      bodyKeys: capture ? bodyKeysOf(capture.bodyRaw) : [],
    };
  } catch (error) {
    return {
      available: false,
      reason: `oracle launch failed: ${(error as Error).message}`,
      exitCode: null,
      stderrTail: "",
      captures: 0,
      websocketAttempts: 0,
      canonical: null,
      headerNames: [],
      bodyKeys: [],
    };
  } finally {
    await server.close();
    await rm(home, { recursive: true, force: true });
  }
}

/**
 * Drive the candidate against a real loopback HTTP endpoint so its request is
 * recorded exactly as the oracle's is: as received by a server, headers and
 * all. Capturing one side at the fetch boundary and the other at the socket
 * produces differences that belong to the apparatus, not to the clients.
 */
async function captureCandidateOverLoopback(): Promise<CanonicalRequest | null> {
  const sse = responsesStreamEvents({
    responseId: "resp_SPIKESENTINEL",
    model: MODEL,
    toolName: PROBE_TOOL.function.name,
    toolArguments: JSON.stringify({ value: "alpha" }),
  }).join("");

  const server = await serveOracleCapture({ basePath: "/backend-api/codex", sse });
  try {
    await driveCandidate(TRANSPORT_CASES[0]!.prompt, {
      withTools: false,
      baseUrl: server.url,
      terminal: createNodeHttpTerminal({ timeoutMs: 30_000 }),
    });
    const capture = server.captures[0];
    return capture ? canonicalize(capture, "/backend-api/codex") : null;
  } finally {
    await server.close();
  }
}

/**
 * The same request through the stock global fetch, recorded so the header
 * difference is a measurement rather than a claim.
 */
async function captureCandidateOverFetch(): Promise<string[]> {
  const sse = responsesStreamEvents({
    responseId: "resp_SPIKESENTINEL",
    model: MODEL,
    toolName: PROBE_TOOL.function.name,
    toolArguments: JSON.stringify({ value: "alpha" }),
  }).join("");

  const server = await serveOracleCapture({ basePath: "/backend-api/codex", sse });
  try {
    await driveCandidate(TRANSPORT_CASES[0]!.prompt, {
      withTools: false,
      baseUrl: server.url,
      terminal: (input, init) => (trustedFetch as typeof globalThis.fetch)(input, init),
    });
    const capture = server.captures[0];
    return capture ? Object.keys(capture.headers).map((n) => n.toLowerCase()).sort() : [];
  } finally {
    await server.close();
  }
}

/**
 * `input` as a whole is Codex's agent loop and is excluded from the diff, but
 * the encoding of a *user turn* is shared ground and must still agree. This
 * compares the structural shape -- item type, role, and content block types --
 * and never the text.
 */
function compareUserTurn(
  oracle: CanonicalRequest,
  candidate: CanonicalRequest,
): UserTurnReport {
  const oracleShape = userTurnShape(oracle.body);
  const candidateShape = userTurnShape(candidate.body);
  return {
    matches:
      oracleShape !== null &&
      candidateShape !== null &&
      JSON.stringify(oracleShape) === JSON.stringify(candidateShape),
    oracle: oracleShape,
    candidate: candidateShape,
  };
}

function userTurnShape(body: unknown): unknown {
  const input = (body as Record<string, unknown> | null)?.input;
  if (!Array.isArray(input)) return null;

  const userItems = input.filter(
    (item): item is Record<string, unknown> =>
      item !== null && typeof item === "object" && (item as Record<string, unknown>).role === "user",
  );
  const last = userItems.at(-1);
  if (!last) return null;

  const content = last.content;
  return {
    // `id` is a per-item identifier minted by whoever owns the conversation
    // store; it is not part of the encoding.
    keys: Object.keys(last)
      .filter((key) => key !== "id")
      .sort(),
    type: last.type ?? null,
    role: last.role,
    contentIsArray: Array.isArray(content),
    contentTypes: Array.isArray(content)
      ? content.map((block) =>
          block !== null && typeof block === "object"
            ? ((block as Record<string, unknown>).type ?? null)
            : typeof block,
        )
      : typeof content,
  };
}

function compare(oracle: CanonicalRequest, candidate: CanonicalRequest): ComparisonReport {
  const diffs = diffRequests(oracle, candidate);
  const candidateHeaders = new Set(candidate.headers.map(([name]) => name));
  const candidateBody = candidate.body as Record<string, unknown>;

  const productOnCandidate = diffs
    .filter(
      (diff) =>
        diff.category === "codex-product" &&
        diff.kind === "added" &&
        CODEX_FORBIDDEN_ON_CANDIDATE.some((pointer) => diff.pointer.startsWith(pointer)),
    )
    .map((diff) => diff.pointer)
    .filter((pointer) => {
      if (pointer.startsWith("/headers/")) {
        return candidateHeaders.has(pointer.slice("/headers/".length).split("/")[0] ?? "");
      }
      return (pointer.slice("/body/".length).split("/")[0] ?? "") in candidateBody;
    });

  return {
    profileBearing: diffs.filter((diff) => diff.category === "profile-bearing").length,
    unexplained: diffs.filter((diff) => diff.category === "unexplained").length,
    volatile: diffs.filter((diff) => diff.category === "volatile-transport").length,
    codexProduct: diffs.filter((diff) => diff.category === "codex-product").length,
    productOnCandidate,
    diffs: diffs.slice(0, 200),
  };
}

/**
 * A mutation the validator does not check. If gate B does not catch it, the two
 * gates are not independent and the wire diff is decorative.
 */
async function runDifferentialMutation(
  oracle: CanonicalRequest,
): Promise<TransportReport["differentialMutation"]> {
  const run = await driveCandidate(TRANSPORT_CASES[0]!.prompt, {
    mutate: (request) => {
      const tools = request.body.tools;
      if (Array.isArray(tools) && tools[0] && typeof tools[0] === "object") {
        delete (tools[0] as Record<string, unknown>).description;
      }
    },
  });

  if (!run.sink.captures[0]) {
    return { detectedByWireDiff: false, validatorStayedGreen: false };
  }

  const mutated = canonicalize(run.sink.captures[0], "/backend-api/codex");
  const diffs = diffRequests(oracle, mutated);

  return {
    detectedByWireDiff: diffs.some(
      (diff) => diff.pointer.startsWith("/body/tools") && diff.category === "profile-bearing",
    ),
    validatorStayedGreen: findViolation(run.error) === null,
  };
}

// ---------------------------------------------------------------------------

function findViolation(error: unknown): ProfileViolationError | null {
  if (error instanceof ProfileViolationError) return error;
  const cause = (error as { cause?: unknown } | null)?.cause;
  if (cause instanceof ProfileViolationError) return cause;
  return null;
}

function assembleToolCall(chunks: Array<Record<string, unknown>>): {
  name: string | null;
  argumentsComplete: boolean;
} {
  let name: string | null = null;
  let args = "";

  for (const chunk of chunks) {
    const partials = chunk.tool_call_chunks as
      | Array<{ name?: string; args?: string }>
      | undefined;
    for (const partial of partials ?? []) {
      if (partial.name) name = partial.name;
      if (partial.args) args += partial.args;
    }
    const complete = chunk.tool_calls as Array<{ name?: string; args?: unknown }> | undefined;
    for (const call of complete ?? []) {
      if (call.name) name = call.name;
    }
  }

  let argumentsComplete = false;
  try {
    const parsed: unknown = JSON.parse(args);
    argumentsComplete =
      parsed !== null && typeof parsed === "object" && "value" in (parsed as object);
  } catch {
    argumentsComplete = false;
  }

  return { name, argumentsComplete };
}

function bodyKeysOf(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return [];
    return Object.keys(parsed as Record<string, unknown>).sort();
  } catch {
    return [];
  }
}

function redactTail(text: string): string {
  return sanitizeText(text).slice(-1_500);
}

export const SUBSCRIPTION_REFERENCE_BASE = SUBSCRIPTION_BASE_URL;
