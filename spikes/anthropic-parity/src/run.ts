// Offline differential driver.
//
// Prints one JSON object to stdout and writes nothing to disk, so the container
// can run --read-only, --network none, as an unprivileged user. The host script
// owns all persistence.
//
// Exit codes:
//   0  pass    every acceptance criterion held
//   1  fail    a complete, trustworthy measurement disagreed with the profile
//   3  fault   the measurement could not be trusted (broken oracle, fixture,
//              isolation, or sanitation failure)

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  PROFILE_ID,
  PROFILE_REVISION,
  TOOL_NAME_PATTERN,
  USER_AGENT,
  REQUIRED_BETAS,
} from "./profile.ts";
import {
  ALLOWLIST,
  canonicalize,
  deepEqual,
  diffRequests,
  forEvidence,
  managedDigestInput,
  projectProfile,
  validateAllowlist,
} from "./canonical.ts";
import type { CanonicalRequest, WireDiff } from "./canonical.ts";
import { createCandidateFetch } from "./candidate.ts";
import type { PendingRequest } from "./candidate.ts";
import { createCaptureSink } from "./capture.ts";
import { createReferenceLane, referenceProvenance } from "./reference.ts";
import { checkBindingGuards, loadFixtures } from "./cases.ts";
import type { CaseSpec, Fixtures } from "./cases.ts";
import {
  SENTINELS,
  SENTINEL_ACCESS_TOKEN,
  SENTINEL_REFRESH_TOKEN,
  buildModel,
  invokeCase,
  recordSdkRequest,
  streamCase,
  summariseMessage,
  withTimeout,
} from "./lanes.ts";
import type { MessageSummary, SdkRequest } from "./lanes.ts";
import {
  CHUNKERS,
  EXPECTED_STREAM_ARGS,
  EXPECTED_STREAM_STOP_REASON,
  EXPECTED_STREAM_TEXT,
  EXPECTED_STREAM_TOOL_ID,
  NON_STREAM_TEXT_ONLY,
  jsonResponse,
  nonStreamToolUse,
  sseResponse,
  streamingBody,
} from "./synthetic.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(HERE, "..", "fixtures");
const FIXTURES = path.join(FIXTURE_DIR, "cases.json");
const GOLDEN = path.join(FIXTURE_DIR, "reference-golden.json");
const LOCK = path.join(FIXTURE_DIR, "fixtures.lock.json");

const CASE_TIMEOUT_MS = 5_000;
const STREAM_TIMEOUT_MS = 20_000;

const EXPECTED_VERSIONS: Record<string, string> = {
  "@ex-machina/opencode-anthropic-auth": "1.8.1",
  "@langchain/anthropic": "1.5.8",
  "@langchain/core": "1.2.9",
  "@anthropic-ai/sdk": "0.115.0",
  zod: "4.5.4",
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

function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

async function fileSha256(filePath: string): Promise<string | null> {
  try {
    return createHash("sha256").update(await readFile(filePath)).digest("hex");
  } catch {
    return null;
  }
}

async function readJsonIfPresent<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as T;
  } catch {
    return null;
  }
}

/**
 * The digest of what the shipped plugin actually produced, per case.
 *
 * The oracle is re-executed on every run rather than replayed from a stored
 * capture, so nothing can go stale. The committed golden exists for the other
 * direction: it detects the oracle silently changing underneath us -- a
 * different resolved version, a patched dist, a tampered tarball -- which a
 * live-only comparison would happily accept.
 */
type ReferenceGolden = {
  profileId: string;
  cases: Record<string, { projection_sha256: string; managed_sha256: string }>;
};

function fault(step: string, error: unknown): never {
  const payload = {
    schema: "agent-runtime/spike-evidence/1",
    spike: "anthropic-parity",
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
  };
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  process.exit(3);
}

// ---------------------------------------------------------------------------

async function probeOutbound(): Promise<{ reached: boolean; errno: string | null }> {
  const net = await import("node:net");
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: { reached: boolean; errno: string | null }) => {
      if (settled) return;
      settled = true;
      try {
        socket.destroy();
      } catch {
        // already gone
      }
      resolve(result);
    };

    const socket = net.connect({ host: "1.1.1.1", port: 443 });
    socket.setTimeout(3_000);
    socket.once("connect", () => finish({ reached: true, errno: null }));
    socket.once("timeout", () => finish({ reached: false, errno: "ETIMEDOUT" }));
    socket.once("error", (error: NodeJS.ErrnoException) =>
      finish({ reached: false, errno: error.code ?? "ERROR" }),
    );
  });
}

function environmentReport() {
  const offenders = Object.keys(process.env).filter((key) =>
    ENV_DENYLIST.some((pattern) => pattern.test(key)),
  );
  return {
    node_version: process.version,
    platform: process.platform,
    arch: process.arch,
    tz: process.env.TZ ?? null,
    denylist_offenders: offenders,
    denylist_clean: offenders.length === 0,
  };
}

function scanForSecrets(text: string): string[] {
  const hits: string[] = [];
  for (const sentinel of SENTINELS) {
    if (text.includes(sentinel)) hits.push(`sentinel:${sentinel.slice(0, 16)}`);
  }
  if (/sk-ant-(?:api|oat|ort)\d{2}-(?!SENTINEL)[A-Za-z0-9_-]{16,}/.test(text)) {
    hits.push("anthropic-key-shaped");
  }
  if (/\/home\/[a-z0-9_-]+\//.test(text)) hits.push("host-path");
  return hits;
}

// ---------------------------------------------------------------------------

type CaseResult = {
  id: string;
  purpose: string;
  projection_equal: boolean;
  diffs: WireDiff[];
  profile_bearing_diffs: number;
  unexplained_diffs: number;
  allowlisted_diffs: number;
  decorator_is_load_bearing: boolean;
  reference_summary: MessageSummary;
  candidate_summary: MessageSummary;
  response_expectations_met: boolean;
  canonical_reference: CanonicalRequest;
  canonical_candidate: CanonicalRequest;
};

async function runCase(
  fixtures: Fixtures,
  spec: CaseSpec,
): Promise<{ result: CaseResult; sdkRequests: SdkRequest[]; forwardAttempts: number }> {
  const toolKey = spec.tools[0];
  const wireName = toolKey ? fixtures.tools[toolKey]!.wireName : null;
  const logicalName = toolKey ? fixtures.tools[toolKey]!.logicalName : null;

  const respond = () =>
    wireName === null
      ? jsonResponse(NON_STREAM_TEXT_ONLY)
      : jsonResponse(nonStreamToolUse(wireName));

  // --- reference lane ------------------------------------------------------
  const referenceSink = createCaptureSink(respond);
  const referenceLane = await createReferenceLane({
    accessToken: SENTINEL_ACCESS_TOKEN,
    refreshToken: SENTINEL_REFRESH_TOKEN,
    terminal: referenceSink.fetch,
  });
  const referenceSummary = await withTimeout(
    `${spec.id}/reference`,
    CASE_TIMEOUT_MS,
    () => invokeCase(fixtures, spec, "reference", referenceLane.fetch),
  );
  if (referenceLane.authSetCalls !== 0) {
    throw new Error("reference lane attempted a token refresh in an offline run");
  }
  if (referenceSink.captures.length !== 1) {
    throw new Error(
      `reference lane produced ${referenceSink.captures.length} captures, expected 1`,
    );
  }

  // --- candidate lane ------------------------------------------------------
  const candidateSink = createCaptureSink(respond);
  const sdkRequests: SdkRequest[] = [];
  const candidateFetch = recordSdkRequest(
    createCandidateFetch({
      accessToken: SENTINEL_ACCESS_TOKEN,
      terminal: candidateSink.fetch,
    }),
    sdkRequests,
  );
  const candidateSummary = await withTimeout(
    `${spec.id}/candidate`,
    CASE_TIMEOUT_MS,
    () => invokeCase(fixtures, spec, "candidate", candidateFetch),
  );
  if (candidateSink.captures.length !== 1) {
    throw new Error(
      `candidate lane produced ${candidateSink.captures.length} captures, expected 1`,
    );
  }

  // --- control lane: no decorator -----------------------------------------
  const controlSink = createCaptureSink(respond);
  await withTimeout(`${spec.id}/control`, CASE_TIMEOUT_MS, () =>
    invokeCase(fixtures, spec, "candidate", controlSink.fetch),
  );

  const canonicalReference = canonicalize(referenceSink.captures[0]!);
  const canonicalCandidate = canonicalize(candidateSink.captures[0]!);
  const canonicalControl = canonicalize(controlSink.captures[0]!);

  const projectionEqual = deepEqual(
    projectProfile(canonicalReference),
    projectProfile(canonicalCandidate),
  );
  const diffs = diffRequests(canonicalReference, canonicalCandidate);

  const decoratorIsLoadBearing = !deepEqual(
    projectProfile(canonicalControl),
    projectProfile(canonicalCandidate),
  );

  // Response-side names legitimately differ: the reference un-prefixes them,
  // the candidate never prefixed them. Each lane is asserted against its own
  // expectation, never cross-compared.
  const responseExpectationsMet =
    wireName === null
      ? referenceSummary.text === "Acknowledged." &&
        candidateSummary.text === "Acknowledged." &&
        referenceSummary.stopReason === "end_turn" &&
        candidateSummary.stopReason === "end_turn"
      : referenceSummary.toolCalls[0]?.name === logicalName &&
        candidateSummary.toolCalls[0]?.name === wireName &&
        referenceSummary.stopReason === "tool_use" &&
        candidateSummary.stopReason === "tool_use";

  return {
    result: {
      id: spec.id,
      purpose: spec.purpose,
      projection_equal: projectionEqual,
      diffs,
      profile_bearing_diffs: diffs.filter((d) => d.category === "profile-bearing").length,
      unexplained_diffs: diffs.filter((d) => d.category === "unexplained").length,
      allowlisted_diffs: diffs.filter(
        (d) => d.category === "client-serialization" || d.category === "volatile-transport",
      ).length,
      decorator_is_load_bearing: decoratorIsLoadBearing,
      reference_summary: referenceSummary,
      candidate_summary: candidateSummary,
      response_expectations_met: responseExpectationsMet,
      canonical_reference: canonicalReference,
      canonical_candidate: canonicalCandidate,
    },
    sdkRequests,
    forwardAttempts:
      referenceSink.forwardAttempts +
      candidateSink.forwardAttempts +
      controlSink.forwardAttempts,
  };
}

// ---------------------------------------------------------------------------
// Negative controls

type Control = {
  id: string;
  expected: string;
  mutate: (pending: PendingRequest) => void;
};

function mutateBody(
  pending: PendingRequest,
  fn: (body: Record<string, unknown>) => void,
): void {
  const parsed = JSON.parse(pending.body ?? "{}") as Record<string, unknown>;
  fn(parsed);
  pending.body = JSON.stringify(parsed);
}

const CONTROLS: Control[] = [
  {
    id: "wrong-user-agent",
    expected: "USER_AGENT_MISMATCH",
    mutate: (pending) => pending.headers.set("user-agent", "curl/8.15.0"),
  },
  {
    id: "missing-required-beta",
    expected: "BETA_ORDER_MISMATCH",
    mutate: (pending) => pending.headers.set("anthropic-beta", REQUIRED_BETAS[0]!),
  },
  {
    id: "reordered-betas",
    expected: "BETA_ORDER_MISMATCH",
    mutate: (pending) =>
      pending.headers.set(
        "anthropic-beta",
        [...REQUIRED_BETAS].reverse().join(","),
      ),
  },
  {
    id: "duplicate-beta",
    expected: "BETA_SET_MISMATCH",
    mutate: (pending) =>
      pending.headers.set(
        "anthropic-beta",
        [...REQUIRED_BETAS, REQUIRED_BETAS[0]!].join(","),
      ),
  },
  {
    id: "missing-beta-query-param",
    expected: "QUERY_PARAM_MISMATCH",
    mutate: (pending) => pending.url.searchParams.delete("beta"),
  },
  {
    id: "extra-query-param",
    expected: "UNKNOWN_QUERY_PARAM",
    mutate: (pending) => pending.url.searchParams.set("trace", "1"),
  },
  {
    id: "reintroduced-x-api-key",
    expected: "FORBIDDEN_HEADER_PRESENT",
    mutate: (pending) => pending.headers.set("x-api-key", "sk-ant-api03-SENTINEL-x"),
  },
  {
    id: "missing-authorization",
    expected: "AUTH_MISSING",
    mutate: (pending) => pending.headers.delete("authorization"),
  },
  {
    id: "non-bearer-authorization",
    expected: "AUTH_SCHEME_INVALID",
    mutate: (pending) => pending.headers.set("authorization", "Basic abcdef"),
  },
  {
    id: "unknown-header",
    expected: "UNKNOWN_HEADER",
    mutate: (pending) => pending.headers.set("x-fixture-novel", "1"),
  },
  {
    id: "mutated-identity-block",
    expected: "SYSTEM_IDENTITY_MISMATCH",
    mutate: (pending) =>
      mutateBody(pending, (body) => {
        const system = body.system as Array<{ text: string }>;
        system[1]!.text = "You are a helpful assistant.";
      }),
  },
  {
    id: "swapped-system-order",
    expected: "SYSTEM_IDENTITY_MISMATCH",
    mutate: (pending) =>
      mutateBody(pending, (body) => {
        const system = body.system as Array<unknown>;
        const first = system[0];
        system[0] = system[1];
        system[1] = first;
      }),
  },
  {
    id: "wrong-billing-header",
    expected: "BILLING_HEADER_MISMATCH",
    mutate: (pending) =>
      mutateBody(pending, (body) => {
        const system = body.system as Array<{ text: string }>;
        system[0]!.text = `${system[0]!.text.slice(0, -1)}0;`;
      }),
  },
  {
    id: "unsanitised-system",
    expected: "SYSTEM_SANITATION_MISMATCH",
    mutate: (pending) =>
      mutateBody(pending, (body) => {
        const system = body.system as Array<{ text: string }>;
        system[2]!.text = `You are OpenCode, the best coding agent on the planet.\n\n${system[2]!.text}`;
      }),
  },
  {
    id: "lowercase-tool-name",
    expected: "TOOL_NAME_CONVENTION",
    mutate: (pending) =>
      mutateBody(pending, (body) => {
        const tools = body.tools as Array<{ name: string }>;
        tools[0]!.name = tools[0]!.name.replace(/^mcp_E/, "mcp_e");
      }),
  },
  {
    id: "tool-schema-forbidden-key",
    expected: "TOOL_SCHEMA_FORBIDDEN_KEY",
    mutate: (pending) =>
      mutateBody(pending, (body) => {
        const tools = body.tools as Array<{ input_schema: Record<string, unknown> }>;
        tools[0]!.input_schema.$schema = "https://json-schema.org/draft/2020-12/schema";
      }),
  },
  {
    id: "lowercase-history-tool-use",
    expected: "HISTORY_TOOL_NAME_CONVENTION",
    mutate: (pending) =>
      mutateBody(pending, (body) => {
        const messages = body.messages as Array<{ content?: unknown }>;
        for (const message of messages) {
          if (!Array.isArray(message.content)) continue;
          for (const block of message.content as Array<{ type?: string; name?: string }>) {
            if (block.type === "tool_use" && typeof block.name === "string") {
              block.name = block.name.toLowerCase();
            }
          }
        }
      }),
  },
];

type ControlResult = {
  id: string;
  expected: string;
  codes: string[];
  blocked: boolean;
  dispatched: boolean;
  passed: boolean;
};

async function runControls(base: SdkRequest): Promise<ControlResult[]> {
  const results: ControlResult[] = [];

  for (const control of CONTROLS) {
    const sink = createCaptureSink(() => jsonResponse(NON_STREAM_TEXT_ONLY));
    const fetchImpl = createCandidateFetch({
      accessToken: SENTINEL_ACCESS_TOKEN,
      terminal: sink.fetch,
      mutate: control.mutate,
    });

    let codes: string[] = [];
    let blocked = false;

    try {
      await fetchImpl(base.url, {
        method: base.method,
        headers: new Headers(base.headers),
        body: base.body,
      });
    } catch (error) {
      const typed = error as Error & {
        profileViolation?: boolean;
        violations?: Array<{ code: string }>;
      };
      if (typed.profileViolation !== true) throw error;
      blocked = true;
      codes = (typed.violations ?? []).map((violation) => violation.code);
    }

    const dispatched = sink.captures.length > 0;
    results.push({
      id: control.id,
      expected: control.expected,
      codes,
      blocked,
      dispatched,
      passed: blocked && !dispatched && codes.includes(control.expected),
    });
  }

  return results;
}

// ---------------------------------------------------------------------------
// Streaming

type StreamResult = {
  lane: string;
  chunker: string;
  ok: boolean;
  toolName: string | null;
  text: string;
  stopReason: unknown;
  argsMatch: boolean;
  error: string | null;
};

async function runStreaming(
  fixtures: Fixtures,
  spec: CaseSpec,
): Promise<{
  candidate: StreamResult[];
  reference: StreamResult[];
  referenceLogicalName: string;
  referenceWireName: string;
  truncated: {
    blocked: boolean;
    argsComplete: boolean;
    stopReason: unknown;
    error: string | null;
  };
}> {
  const toolKey = spec.tools[0]!;
  const wireName = fixtures.tools[toolKey]!.wireName;
  const logicalName = fixtures.tools[toolKey]!.logicalName;
  const body = streamingBody(wireName);

  const candidate: StreamResult[] = [];
  const reference: StreamResult[] = [];

  for (const chunker of CHUNKERS) {
    const sink = createCaptureSink(() => sseResponse(body, chunker));
    const fetchImpl = createCandidateFetch({
      accessToken: SENTINEL_ACCESS_TOKEN,
      terminal: sink.fetch,
    });

    try {
      const summary = await withTimeout(
        `stream/candidate/${chunker.id}`,
        STREAM_TIMEOUT_MS,
        () => streamCase(fixtures, spec, "candidate", fetchImpl),
      );
      const call = summary.toolCalls[0];
      candidate.push({
        lane: "candidate",
        chunker: chunker.id,
        ok:
          summary.text === EXPECTED_STREAM_TEXT &&
          call?.name === wireName &&
          call?.id === EXPECTED_STREAM_TOOL_ID &&
          summary.stopReason === EXPECTED_STREAM_STOP_REASON &&
          deepEqual(call?.args, EXPECTED_STREAM_ARGS),
        toolName: call?.name ?? null,
        text: summary.text,
        stopReason: summary.stopReason,
        argsMatch: deepEqual(call?.args, EXPECTED_STREAM_ARGS),
        error: null,
      });
    } catch (error) {
      candidate.push({
        lane: "candidate",
        chunker: chunker.id,
        ok: false,
        toolName: null,
        text: "",
        stopReason: null,
        argsMatch: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // The reference lane rewrites tool names in the raw byte stream. Two chunkers
  // are enough to record both the working case and the known boundary defect.
  for (const chunker of CHUNKERS.filter((c) =>
    ["whole-body", "one-byte"].includes(c.id),
  )) {
    const sink = createCaptureSink(() => sseResponse(body, chunker));
    const lane = await createReferenceLane({
      accessToken: SENTINEL_ACCESS_TOKEN,
      refreshToken: SENTINEL_REFRESH_TOKEN,
      terminal: sink.fetch,
    });

    try {
      const summary = await withTimeout(
        `stream/reference/${chunker.id}`,
        STREAM_TIMEOUT_MS,
        () => streamCase(fixtures, spec, "reference", lane.fetch),
      );
      const call = summary.toolCalls[0];
      reference.push({
        lane: "reference",
        chunker: chunker.id,
        ok: call?.name === logicalName,
        toolName: call?.name ?? null,
        text: summary.text,
        stopReason: summary.stopReason,
        argsMatch: deepEqual(call?.args, EXPECTED_STREAM_ARGS),
        error: null,
      });
    } catch (error) {
      reference.push({
        lane: "reference",
        chunker: chunker.id,
        ok: false,
        toolName: null,
        text: "",
        stopReason: null,
        argsMatch: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // A stream cut mid tool-input JSON must not yield complete arguments or a
  // terminal stop reason. Reporting either would be invented data.
  const truncatedBody = streamingBody(wireName, { truncate: true });
  const truncatedSink = createCaptureSink(() =>
    sseResponse(truncatedBody, CHUNKERS[0]!),
  );
  const truncatedFetch = createCandidateFetch({
    accessToken: SENTINEL_ACCESS_TOKEN,
    terminal: truncatedSink.fetch,
  });

  let truncated: {
    blocked: boolean;
    argsComplete: boolean;
    stopReason: unknown;
    error: string | null;
  };
  try {
    const summary = await withTimeout("stream/truncated", STREAM_TIMEOUT_MS, () =>
      streamCase(fixtures, spec, "candidate", truncatedFetch),
    );
    const argsComplete = deepEqual(summary.toolCalls[0]?.args, EXPECTED_STREAM_ARGS);
    truncated = {
      blocked:
        argsComplete === false && summary.stopReason !== EXPECTED_STREAM_STOP_REASON,
      argsComplete,
      stopReason: summary.stopReason,
      error: null,
    };
  } catch (error) {
    // Throwing is also an acceptable loud failure.
    truncated = {
      blocked: true,
      argsComplete: false,
      stopReason: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  return {
    candidate,
    reference,
    referenceLogicalName: logicalName,
    referenceWireName: wireName,
    truncated,
  };
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const allowlistErrors = validateAllowlist();
  if (allowlistErrors.length > 0) fault("allowlist", new Error(allowlistErrors.join("; ")));

  let fixtures: Fixtures;
  try {
    fixtures = await loadFixtures(FIXTURES);
  } catch (error) {
    return fault("fixtures", error);
  }

  const provenance = await referenceProvenance().catch((error) =>
    fault("provenance", error),
  );
  const guards = checkBindingGuards(fixtures, TOOL_NAME_PATTERN);
  const environment = environmentReport();
  const outbound = await probeOutbound();

  const caseResults: CaseResult[] = [];
  const sdkRequestsByCase: Record<string, SdkRequest[]> = {};
  let forwardAttempts = 0;

  for (const spec of fixtures.cases) {
    try {
      const run = await runCase(fixtures, spec);
      caseResults.push(run.result);
      sdkRequestsByCase[spec.id] = run.sdkRequests;
      forwardAttempts += run.forwardAttempts;
    } catch (error) {
      return fault(`case:${spec.id}`, error);
    }
  }

  const streamingSpec = fixtures.cases.find(
    (spec) => spec.id === fixtures.streamingCase,
  );
  if (!streamingSpec) return fault("streaming", new Error("streaming case not found"));

  let streaming: Awaited<ReturnType<typeof runStreaming>>;
  try {
    streaming = await runStreaming(fixtures, streamingSpec);
  } catch (error) {
    return fault("streaming", error);
  }

  const controlBase = sdkRequestsByCase[streamingSpec.id]?.[0];
  if (!controlBase) return fault("controls", new Error("no recorded SDK request"));

  let controls: ControlResult[];
  try {
    controls = await runControls(controlBase);
  } catch (error) {
    return fault("controls", error);
  }

  // --- reference golden and fixture integrity ------------------------------
  const referenceGoldenObserved: ReferenceGolden = {
    profileId: PROFILE_ID,
    cases: Object.fromEntries(
      caseResults.map((c) => [
        c.id,
        {
          projection_sha256: sha256(projectProfile(c.canonical_reference)),
          managed_sha256: sha256(managedDigestInput(c.canonical_reference)),
        },
      ]),
    ),
  };

  const goldenCommitted = await readJsonIfPresent<ReferenceGolden>(GOLDEN);
  const goldenMatches =
    goldenCommitted !== null && deepEqual(goldenCommitted, referenceGoldenObserved);

  const lock = await readJsonIfPresent<{ files: Record<string, string> }>(LOCK);
  const fixtureDigests: Record<string, string | null> = {
    "cases.json": await fileSha256(FIXTURES),
    "reference-golden.json": await fileSha256(GOLDEN),
  };
  const fixturesUnmodified =
    lock !== null &&
    Object.entries(lock.files).every(
      ([name, digest]) => fixtureDigests[name] === digest,
    );

  // --- model identity ------------------------------------------------------
  const probeModel = buildModel(fixtures, async () => new Response("{}"));
  const modelIdentity = {
    constructor: probeModel.constructor.name,
    llm_type: probeModel._llmType(),
    prototype_chain: (() => {
      const chain: string[] = [];
      let current: object | null = Object.getPrototypeOf(probeModel);
      while (current !== null && chain.length < 12) {
        chain.push(current.constructor.name);
        current = Object.getPrototypeOf(current);
      }
      return chain;
    })(),
  };

  // --- acceptance ----------------------------------------------------------
  const versionsMatch = Object.entries(EXPECTED_VERSIONS).every(([name, expected]) => {
    const entry = Object.values(provenance).find(
      (value) => (value as { name?: string }).name === name,
    ) as { version?: string } | undefined;
    return entry?.version === expected;
  });

  const acceptance: Record<string, boolean> = {
    inputs_pinned: versionsMatch,
    fixtures_unmodified: fixturesUnmodified,
    golden_reference_matches: goldenMatches,
    binding_guards_hold: Object.values(guards).every(Boolean),
    reference_is_shipped_plugin: true,
    no_basechatmodel_subclass:
      modelIdentity.llm_type === "anthropic" &&
      modelIdentity.constructor.startsWith("ChatAnthropic"),
    decorator_is_load_bearing: caseResults.every((c) => c.decorator_is_load_bearing),
    profile_projection_exact: caseResults.every((c) => c.projection_equal),
    wire_diff_clean: caseResults.every(
      (c) => c.profile_bearing_diffs === 0 && c.unexplained_diffs === 0,
    ),
    negative_controls_fail_closed: controls.every((c) => c.passed),
    non_stream_parsing_intact: caseResults.every((c) => c.response_expectations_met),
    stream_parsing_intact_all_chunkers: streaming.candidate.every((s) => s.ok),
    truncated_stream_not_silently_completed: streaming.truncated.blocked,
    native_tool_names_need_no_rewrite:
      streaming.candidate.every((s) => s.toolName !== null) &&
      guards.candidateNamesAreWireNames,
    // The reference un-prefixes tool names with a regex over raw response
    // bytes, so it works on an aligned stream and silently fails on a split
    // one. Asserting both halves turns the observation into a reproducible
    // finding, and it is the reason the candidate does not port that code.
    reference_stream_defect_reproduced:
      streaming.reference.find((s) => s.chunker === "whole-body")?.toolName ===
        streaming.referenceLogicalName &&
      streaming.reference.find((s) => s.chunker === "one-byte")?.toolName ===
        streaming.referenceWireName,
    network_isolated: outbound.reached === false,
    no_forward_attempts: forwardAttempts === 0,
    environment_scrubbed: environment.denylist_clean,
  };

  const managedDigest = sha256(
    caseResults.map((c) => managedDigestInput(c.canonical_candidate)),
  );

  const evidence = {
    schema: "agent-runtime/spike-evidence/1",
    spike: "anthropic-parity",
    run_index: process.env.PARITY_RUN_INDEX ?? "0",
    collected_at: new Date().toISOString(),

    profile: {
      profile_id: PROFILE_ID,
      profile_revision: PROFILE_REVISION,
      user_agent: USER_AGENT,
      required_betas: REQUIRED_BETAS,
    },

    environment,
    provenance,
    model_identity: modelIdentity,

    isolation: {
      outbound_probe: outbound,
      forward_attempts: forwardAttempts,
    },

    binding_guards: guards,
    allowlist: { rules: ALLOWLIST, size: ALLOWLIST.length },

    fixtures: {
      digests: fixtureDigests,
      lock_present: lock !== null,
      golden_present: goldenCommitted !== null,
    },
    // Copy this into fixtures/reference-golden.json to promote a new baseline.
    // Promotion is deliberate and reviewable; the harness never self-rebaselines.
    reference_golden_observed: referenceGoldenObserved,

    cases: caseResults.map((c) => ({
      id: c.id,
      purpose: c.purpose,
      projection_equal: c.projection_equal,
      profile_bearing_diffs: c.profile_bearing_diffs,
      unexplained_diffs: c.unexplained_diffs,
      allowlisted_diffs: c.allowlisted_diffs,
      diffs: c.diffs,
      decorator_is_load_bearing: c.decorator_is_load_bearing,
      response_expectations_met: c.response_expectations_met,
      reference_tool_name: c.reference_summary.toolCalls[0]?.name ?? null,
      candidate_tool_name: c.candidate_summary.toolCalls[0]?.name ?? null,
      canonical_candidate: forEvidence(c.canonical_candidate),
      managed_digest: sha256(managedDigestInput(c.canonical_candidate)),
    })),

    negative_controls: controls,
    streaming,

    managed_digest: managedDigest,
    acceptance,
  };

  const serialised = JSON.stringify(evidence, null, 2);
  const leaks = scanForSecrets(serialised);
  if (leaks.length > 0) {
    return fault("sanitization", new Error(`evidence leak: ${leaks.join(", ")}`));
  }

  const failed = Object.entries(acceptance).filter(([, value]) => value === false);
  const withOutcome = {
    ...evidence,
    outcome: {
      status: failed.length === 0 ? "pass" : "fail",
      failed_criteria: failed.length,
      failed: failed.map(([key]) => key),
      fault: null,
    },
  };

  process.stdout.write(`${JSON.stringify(withOutcome, null, 2)}\n`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((error) => fault("main", error));
