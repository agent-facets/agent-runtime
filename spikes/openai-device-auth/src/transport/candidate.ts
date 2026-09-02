// The candidate: a stock ChatOpenAI with a decorated fetch.
//
// No BaseChatModel subclass and no response-byte rewriting. The decorator is
// the only place the request is touched, and every operation it performs is
// recorded, so "LangChain could not express this field" is a measurement rather
// than an assumption. If an operation never fires, the stock model surface
// already produced the right value and the decorator is doing less than
// believed -- which is worth knowing either way.
//
// Two seams are proven here:
//
//   configuration.apiKey   an async resolver, called per request, which is how
//                          an OAuth token reaches the SDK without a subclass
//   configuration.fetch    covers streaming and non-streaming alike, because
//                          the SDK funnels every request through one fetch
//
// `configuration.maxRetries` is deliberately absent. LangChain writes
// `maxRetries: 0` into the client after spreading `configuration`, but its
// per-request options path spreads `configuration` again *without* that
// override -- so a `maxRetries` living in `configuration` silently re-enables
// SDK retries. Its absence is asserted, not assumed.

import { ChatOpenAI } from "@langchain/openai";
import { randomUUID } from "node:crypto";

import {
  ACCOUNT_HEADER,
  CAPTURED_PARALLEL_TOOL_CALLS,
  CAPTURED_REASONING,
  CAPTURED_TEXT,
  CODEX_VERSION,
  ORIGINATOR,
  RESIDENCY_HEADER,
  RESPONSES_PATH,
  VERSION_HEADER,
} from "../reference.ts";
import {
  EXPECTED_ACCEPT,
  EXPECTED_INCLUDE,
  EXPECTED_TOOL_CHOICE,
  FORBIDDEN_BODY_KEYS,
  ProfileViolationError,
  validateRequest,
  type ObservedRequest,
  type ProfileExpectations,
} from "./profile.ts";

export const SENTINEL_API_KEY = "sk-SPIKESENTINEL-not-a-real-key";

export type DecoratorOptions = {
  baseUrl: string;
  expectations: ProfileExpectations;
  resolveToken: () => Promise<string>;
  /** Turned off only by the control lane that proves the decorator matters. */
  enabled?: boolean;
  /** Turned off by the mutation that proves the gate is load-bearing. */
  validate?: boolean;
  mutate?: (request: MutableRequest) => void;
};

export type MutableRequest = {
  url: URL;
  headers: Headers;
  body: Record<string, unknown>;
};

export type DecoratorMetrics = {
  dispatches: number;
  tokenResolverCalls: number;
  bodyOperations: string[];
  removedHeaders: string[];
  originAssertions: number;
};

export type DecoratedFetch = {
  fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  metrics: DecoratorMetrics;
};

/** Fingerprint headers the OpenAI SDK adds and Codex never sends. */
const STRIPPED_HEADERS = [
  "openai-organization",
  "openai-project",
  "openai-beta",
  "x-api-key",
];

export function createDecoratedFetch(
  terminal: (input: string, init: RequestInit) => Promise<Response>,
  options: DecoratorOptions,
): DecoratedFetch {
  const metrics: DecoratorMetrics = {
    dispatches: 0,
    tokenResolverCalls: 0,
    bodyOperations: [],
    removedHeaders: [],
    originAssertions: 0,
  };

  const expectedOrigin = new URL(options.baseUrl).origin;

  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const href =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const url = new URL(href);

    const headers = new Headers();
    collectHeaders(init?.headers, input, headers);

    if (options.enabled === false) {
      metrics.dispatches += 1;
      return terminal(url.toString(), { ...init, headers });
    }

    // Gateway and environment hijack detector. LangSmith gateway discovery and
    // OPENAI_BASE_URL both change the origin, and either would otherwise ship a
    // subscription token somewhere it was never meant to go.
    metrics.originAssertions += 1;
    if (url.origin !== expectedOrigin) {
      throw new Error(`refusing to dispatch: origin ${url.origin} is not ${expectedOrigin}`);
    }
    if (!url.pathname.endsWith(RESPONSES_PATH)) {
      throw new Error(`refusing to dispatch: path ${url.pathname} is not the Responses endpoint`);
    }

    for (const name of [...headers.keys()]) {
      if (name.startsWith("x-stainless-") || STRIPPED_HEADERS.includes(name)) {
        metrics.removedHeaders.push(name);
        headers.delete(name);
      }
    }

    metrics.tokenResolverCalls += 1;
    const token = await options.resolveToken();

    headers.set("authorization", `Bearer ${token}`);
    headers.set(ACCOUNT_HEADER, options.expectations.accountId);
    headers.set("originator", ORIGINATOR);
    headers.set(VERSION_HEADER, CODEX_VERSION);
    headers.set("user-agent", options.expectations.userAgent);
    headers.set("accept", EXPECTED_ACCEPT);
    headers.set("content-type", "application/json");

    if (options.expectations.residency === null) {
      headers.delete(RESIDENCY_HEADER);
    } else {
      headers.set(RESIDENCY_HEADER, options.expectations.residency);
    }

    const conversationId = randomUUID();
    headers.set("session-id", conversationId);
    headers.set("thread-id", conversationId);
    headers.set("x-client-request-id", conversationId);

    const body = parseBody(init?.body);
    const operations = completeProfileBody(body);
    metrics.bodyOperations.push(...operations);

    if (typeof body.model === "string") {
      headers.set("x-codex-routing-hint", `model=${body.model}`);
    }

    const mutable: MutableRequest = { url, headers, body };
    options.mutate?.(mutable);

    const serialized = JSON.stringify(mutable.body);
    mutable.headers.set("content-length", String(Buffer.byteLength(serialized, "utf8")));

    if (options.validate !== false) {
      const observed: ObservedRequest = {
        method: (init?.method ?? "POST").toUpperCase(),
        path: mutable.url.pathname,
        query: [...mutable.url.searchParams.entries()],
        headers: new Map([...mutable.headers.entries()]),
        body: mutable.body,
      };
      const violations = validateRequest(observed, options.expectations);
      if (violations.length > 0) throw new ProfileViolationError(violations);
    }

    metrics.dispatches += 1;
    return terminal(mutable.url.toString(), {
      ...init,
      method: (init?.method ?? "POST").toUpperCase(),
      headers: mutable.headers,
      body: serialized,
    });
  };

  return { fetch, metrics };
}

/**
 * Fields the reference sends that the stock model surface cannot express, plus
 * removal of parameters LangChain emits and Codex never does. Each operation is
 * returned so the report can state exactly what the seam could not do on its
 * own.
 */
export function completeProfileBody(body: Record<string, unknown>): string[] {
  const operations: string[] = [];

  if (body.store !== false) {
    body.store = false;
    operations.push("set:store");
  }
  if (body.tool_choice !== EXPECTED_TOOL_CHOICE) {
    body.tool_choice = EXPECTED_TOOL_CHOICE;
    operations.push("set:tool_choice");
  }
  if (JSON.stringify(body.include) !== JSON.stringify(EXPECTED_INCLUDE)) {
    body.include = [...EXPECTED_INCLUDE];
    operations.push("set:include");
  }
  if (body.parallel_tool_calls !== CAPTURED_PARALLEL_TOOL_CALLS) {
    body.parallel_tool_calls = CAPTURED_PARALLEL_TOOL_CALLS;
    operations.push("set:parallel_tool_calls");
  }
  if (JSON.stringify(body.reasoning) !== JSON.stringify(CAPTURED_REASONING)) {
    body.reasoning = { ...CAPTURED_REASONING };
    operations.push("set:reasoning");
  }
  if (JSON.stringify(body.text) !== JSON.stringify(CAPTURED_TEXT)) {
    body.text = { ...CAPTURED_TEXT };
    operations.push("set:text");
  }
  if (body.stream !== true) {
    body.stream = true;
    operations.push("set:stream");
  }
  for (const key of FORBIDDEN_BODY_KEYS) {
    if (key in body) {
      delete body[key];
      operations.push(`delete:${key}`);
    }
  }

  return operations;
}

function parseBody(body: unknown): Record<string, unknown> {
  if (typeof body !== "string") return {};
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as Record<string, unknown>;
  } catch {
    return {};
  }
}

function collectHeaders(
  initHeaders: HeadersInit | undefined,
  input: string | URL | Request,
  out: Headers,
): void {
  if (initHeaders instanceof Headers) {
    initHeaders.forEach((value, key) => out.set(key, value));
  } else if (Array.isArray(initHeaders)) {
    for (const [key, value] of initHeaders) out.set(key, String(value));
  } else if (initHeaders) {
    for (const [key, value] of Object.entries(initHeaders)) out.set(key, String(value));
  } else if (input instanceof Request) {
    input.headers.forEach((value, key) => out.set(key, value));
  }
}

// ---------------------------------------------------------------------------

export type CandidateModelOptions = {
  model: string;
  baseUrl: string;
  fetch: DecoratedFetch["fetch"];
  resolveToken: () => Promise<string>;
};

/**
 * The exact stock construction the spike claims is sufficient. Nothing here is
 * a subclass, a patched prototype, or a private field.
 */
export function createCandidateModel(options: CandidateModelOptions): ChatOpenAI {
  return new ChatOpenAI({
    model: options.model,
    useResponsesApi: true,
    streaming: true,
    maxRetries: 0,
    // The SDK's async apiKey setter assigns to a shared field on the client
    // before headers are built, so two in-flight requests on one cached client
    // can cross-assign tokens. One at a time removes the hazard; credential
    // store concurrency is measured separately and properly.
    maxConcurrency: 1,
    apiKey: SENTINEL_API_KEY,
    zdrEnabled: true,
    configuration: {
      baseURL: options.baseUrl,
      apiKey: options.resolveToken,
      fetch: options.fetch as unknown as typeof globalThis.fetch,
      // maxRetries deliberately absent -- see the note at the top of the file.
    },
  });
}

/** Environment variables that must be scrubbed before any measurement. */
export const HIJACK_ENV_VARS = [
  "OPENAI_API_KEY",
  "OPENAI_API_BASE",
  "OPENAI_BASE_URL",
  "OPENAI_ORGANIZATION",
  "OPENAI_ORG_ID",
  "OPENAI_PROJECT_ID",
  "OPENAI_ADMIN_KEY",
  "OPENAI_CUSTOM_HEADERS",
  "OPENAI_WEBHOOK_SECRET",
  "OPENAI_LOG",
  "LANGSMITH_GATEWAY",
  "LANGSMITH_GATEWAY_API_KEY",
  "LANGSMITH_API_KEY",
  "LANGCHAIN_API_KEY",
];

export function scrubEnvironment(): string[] {
  const removed: string[] = [];
  for (const name of HIJACK_ENV_VARS) {
    if (process.env[name] !== undefined) {
      delete process.env[name];
      removed.push(name);
    }
  }
  return removed;
}
