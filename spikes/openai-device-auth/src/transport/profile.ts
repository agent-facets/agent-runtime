// The transport profile and its fail-closed validator.
//
// Three classes, and every observed field must land in exactly one of them:
//
//   exact       profile-bearing. Compared byte-for-byte between oracle and
//               candidate, and asserted directly by the validator.
//   volatile    identifiers and lengths that cannot match across processes.
//               Constrained by shape and by cross-field consistency instead --
//               a thread id that disagrees with the body is still a failure.
//   product     Codex's own agent-loop surface. Allowed on the oracle side,
//               forbidden on the candidate's: the runtime must not impersonate
//               Codex's sandbox and git metadata, so an appearance here is a
//               hard failure rather than a diff to excuse.
//
// Violations carry a code and a JSON pointer and never a value, so a violation
// report cannot become a credential or prompt leak.

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

export const EXPECTED_ACCEPT = "text/event-stream";
export const EXPECTED_CONTENT_TYPE = "application/json";
export const EXPECTED_INCLUDE = ["reasoning.encrypted_content"];
export const EXPECTED_TOOL_CHOICE = "auto";

/** Values that legitimately differ between machines; excluded from the digest. */
export const MACHINE_DEPENDENT_HEADERS = [
  "user-agent",
  "content-length",
  "session-id",
  "thread-id",
  "x-client-request-id",
  "x-codex-window-id",
];

/** Never permitted on the wire from either side. */
export const FORBIDDEN_HEADERS = [
  "x-api-key",
  "openai-organization",
  "openai-project",
  "openai-beta",
  "x-codex-inference-call-id",
];

/** Body parameters LangChain can emit that Codex never does. */
export const FORBIDDEN_BODY_KEYS = [
  "max_output_tokens",
  "temperature",
  "top_p",
  "user",
  "truncation",
  "previous_response_id",
  "prompt_cache_retention",
  "metadata",
  "max_tokens",
  "n",
  "frequency_penalty",
  "presence_penalty",
];

export const FORBIDDEN_SCHEMA_KEYS = ["$schema", "$id", "$defs", "definitions"];

/**
 * Codex product surface: excluded from the wire diff because the two clients
 * cannot share it.
 *
 * Exclusion from the diff and prohibition on the candidate are two different
 * claims, and conflating them is wrong in both directions. `/body/input` is
 * Codex's agent loop and cannot be diffed, but the candidate obviously has to
 * send a conversation -- so it lives here and *not* in the forbidden list, and
 * its user-turn encoding is asserted separately.
 */
export const CODEX_PRODUCT_POINTERS = [
  "/body/instructions",
  "/body/client_metadata",
  "/body/access_programs",
  // Codex's `input` array is its agent loop: environment context, its own
  // prior turns, and product-specific item types. The conversation *encoding*
  // still matters, so it is checked separately by comparing the user-turn item
  // shape rather than by diffing an array the two clients cannot share.
  "/body/input",
  "/headers/x-codex-turn-metadata",
  "/headers/x-codex-parent-thread-id",
  "/headers/x-openai-subagent",
  "/headers/x-codex-beta-features",
  "/headers/x-codex-turn-state",
  "/headers/x-oai-attestation",
  "/headers/x-openai-internal-codex-responses-lite",
  "/headers/x-openai-memgen-request",
  "/headers/x-codex-installation-id",
];

/**
 * The subset the candidate must never send. Impersonating Codex's sandbox,
 * approval, git, and attestation metadata is a claim about the caller that the
 * runtime has no right to make.
 */
export const CODEX_FORBIDDEN_ON_CANDIDATE = CODEX_PRODUCT_POINTERS.filter(
  (pointer) => pointer !== "/body/input",
);

/**
 * Volatile per-request identity and hop-by-hop transport headers.
 *
 * `host` and `connection` are hop-by-hop by RFC 9110: they describe the
 * connection, not the client, and two loopback endpoints cannot share them.
 * They are shape-checked, never value-compared.
 */
export const VOLATILE_POINTERS = [
  "/headers/host",
  "/headers/connection",
  "/headers/session-id",
  "/headers/thread-id",
  "/headers/x-client-request-id",
  "/headers/x-codex-window-id",
  "/headers/x-codex-routing-hint",
  "/headers/content-length",
  "/headers/authorization",
  "/headers/user-agent",
  "/body/prompt_cache_key",
];

export const PROFILE_HEADER_NAMES = [
  "accept",
  "content-type",
  ACCOUNT_HEADER,
  "originator",
  VERSION_HEADER,
  RESIDENCY_HEADER,
  ...FORBIDDEN_HEADERS,
];

export type ViolationCode =
  | "METHOD_MISMATCH"
  | "PATH_MISMATCH"
  | "QUERY_PARAM_PRESENT"
  | "ACCEPT_MISMATCH"
  | "CONTENT_TYPE_MISMATCH"
  | "AUTH_MISSING"
  | "AUTH_SCHEME_INVALID"
  | "ACCOUNT_HEADER_MISSING"
  | "RESIDENCY_HEADER_UNEXPECTED"
  | "RESIDENCY_VALUE_INVALID"
  | "ORIGINATOR_MISMATCH"
  | "USER_AGENT_MISMATCH"
  | "VERSION_HEADER_MISMATCH"
  | "FORBIDDEN_HEADER_PRESENT"
  | "UNKNOWN_HEADER"
  | "STORE_NOT_FALSE"
  | "STREAM_NOT_TRUE"
  | "TOOL_CHOICE_MISSING"
  | "INCLUDE_MISMATCH"
  | "PARALLEL_TOOL_CALLS_MISMATCH"
  | "REASONING_MISMATCH"
  | "TEXT_MISMATCH"
  | "MAX_OUTPUT_TOKENS_PRESENT"
  | "UNSUPPORTED_PARAM_PRESENT"
  | "TOOL_STRICT_NOT_BOOLEAN"
  | "TOOL_SHAPE_NESTED_FUNCTION"
  | "TOOL_SCHEMA_FORBIDDEN_KEY"
  | "CODEX_PRODUCT_FIELD_ON_CANDIDATE"
  | "THREAD_ID_INCONSISTENT"
  | "ROUTING_HINT_INCONSISTENT"
  | "MODEL_NOT_ALLOWED";

export type Violation = { code: ViolationCode; pointer: string };

export type ProfileExpectations = {
  accountId: string;
  allowedModels: readonly string[];
  /** Codex emits residency only when configuration demands it. */
  residency: string | null;
  userAgent: string;
};

export type ObservedRequest = {
  method: string;
  path: string;
  query: Array<[string, string]>;
  headers: Map<string, string>;
  body: Record<string, unknown>;
};

/**
 * Header names the candidate is permitted to send. Anything else is an
 * UNKNOWN_HEADER: the SDK's `x-stainless-*` family in particular must be
 * deleted rather than tolerated, because Codex sends none of them.
 */
export const CANDIDATE_ALLOWED_HEADERS = new Set([
  "accept",
  "content-type",
  "content-length",
  "authorization",
  ACCOUNT_HEADER,
  RESIDENCY_HEADER,
  "originator",
  VERSION_HEADER,
  "user-agent",
  "session-id",
  "thread-id",
  "x-client-request-id",
  "x-codex-window-id",
  "x-codex-routing-hint",
  "accept-encoding",
  "connection",
  "host",
]);

export function validateRequest(
  request: ObservedRequest,
  expectations: ProfileExpectations,
): Violation[] {
  const violations: Violation[] = [];
  const add = (code: ViolationCode, pointer: string) => violations.push({ code, pointer });

  if (request.method !== "POST") add("METHOD_MISMATCH", "/method");
  if (!request.path.endsWith(RESPONSES_PATH)) add("PATH_MISMATCH", "/path");
  if (request.query.length > 0) add("QUERY_PARAM_PRESENT", "/query");

  const header = (name: string) => request.headers.get(name) ?? null;

  if (header("accept") !== EXPECTED_ACCEPT) add("ACCEPT_MISMATCH", "/headers/accept");
  if (header("content-type") !== EXPECTED_CONTENT_TYPE) {
    add("CONTENT_TYPE_MISMATCH", "/headers/content-type");
  }

  const authorization = header("authorization");
  if (!authorization) {
    add("AUTH_MISSING", "/headers/authorization");
  } else if (!/^Bearer \S+$/.test(authorization)) {
    add("AUTH_SCHEME_INVALID", "/headers/authorization");
  }

  const account = header(ACCOUNT_HEADER);
  if (!account || account !== expectations.accountId) {
    add("ACCOUNT_HEADER_MISSING", `/headers/${ACCOUNT_HEADER}`);
  }

  const residency = header(RESIDENCY_HEADER);
  if (expectations.residency === null) {
    if (residency !== null) add("RESIDENCY_HEADER_UNEXPECTED", `/headers/${RESIDENCY_HEADER}`);
  } else if (residency !== expectations.residency) {
    add("RESIDENCY_VALUE_INVALID", `/headers/${RESIDENCY_HEADER}`);
  }

  if (header("originator") !== ORIGINATOR) add("ORIGINATOR_MISMATCH", "/headers/originator");
  if (header(VERSION_HEADER) !== CODEX_VERSION) {
    add("VERSION_HEADER_MISMATCH", `/headers/${VERSION_HEADER}`);
  }
  if (header("user-agent") !== expectations.userAgent) {
    add("USER_AGENT_MISMATCH", "/headers/user-agent");
  }

  for (const name of FORBIDDEN_HEADERS) {
    if (request.headers.has(name)) add("FORBIDDEN_HEADER_PRESENT", `/headers/${name}`);
  }
  for (const name of request.headers.keys()) {
    if (name.startsWith("x-stainless-") || !CANDIDATE_ALLOWED_HEADERS.has(name)) {
      if (!FORBIDDEN_HEADERS.includes(name)) add("UNKNOWN_HEADER", `/headers/${name}`);
    }
  }

  // Cross-field consistency for the volatile identifiers.
  const threadId = header("thread-id");
  const requestId = header("x-client-request-id");
  if (threadId === null || requestId === null || threadId !== requestId) {
    add("THREAD_ID_INCONSISTENT", "/headers/thread-id");
  }

  const routingHint = header("x-codex-routing-hint");
  const model = request.body.model;
  if (routingHint !== null && routingHint !== `model=${String(model)}`) {
    add("ROUTING_HINT_INCONSISTENT", "/headers/x-codex-routing-hint");
  }

  // Body invariants.
  if (request.body.stream !== true) add("STREAM_NOT_TRUE", "/body/stream");
  if (request.body.store !== false) add("STORE_NOT_FALSE", "/body/store");
  if (request.body.tool_choice !== EXPECTED_TOOL_CHOICE) {
    add("TOOL_CHOICE_MISSING", "/body/tool_choice");
  }
  if (JSON.stringify(request.body.include) !== JSON.stringify(EXPECTED_INCLUDE)) {
    add("INCLUDE_MISMATCH", "/body/include");
  }
  if (request.body.parallel_tool_calls !== CAPTURED_PARALLEL_TOOL_CALLS) {
    add("PARALLEL_TOOL_CALLS_MISMATCH", "/body/parallel_tool_calls");
  }
  if (JSON.stringify(request.body.reasoning) !== JSON.stringify(CAPTURED_REASONING)) {
    add("REASONING_MISMATCH", "/body/reasoning");
  }
  if (JSON.stringify(request.body.text) !== JSON.stringify(CAPTURED_TEXT)) {
    add("TEXT_MISMATCH", "/body/text");
  }
  if (typeof model !== "string" || !expectations.allowedModels.includes(model)) {
    add("MODEL_NOT_ALLOWED", "/body/model");
  }

  for (const key of FORBIDDEN_BODY_KEYS) {
    if (key in request.body) {
      add(
        key === "max_output_tokens" ? "MAX_OUTPUT_TOKENS_PRESENT" : "UNSUPPORTED_PARAM_PRESENT",
        `/body/${key}`,
      );
    }
  }

  for (const pointer of CODEX_FORBIDDEN_ON_CANDIDATE) {
    if (pointer.startsWith("/body/")) {
      const key = pointer.slice("/body/".length);
      if (key in request.body) add("CODEX_PRODUCT_FIELD_ON_CANDIDATE", pointer);
    } else if (pointer.startsWith("/headers/")) {
      const name = pointer.slice("/headers/".length);
      if (request.headers.has(name)) add("CODEX_PRODUCT_FIELD_ON_CANDIDATE", pointer);
    }
  }

  violations.push(...validateTools(request.body.tools));

  return violations;
}

export function validateTools(tools: unknown): Violation[] {
  if (tools === undefined) return [];
  if (!Array.isArray(tools)) return [{ code: "TOOL_SHAPE_NESTED_FUNCTION", pointer: "/body/tools" }];

  const violations: Violation[] = [];
  tools.forEach((tool, index) => {
    const pointer = `/body/tools/${index}`;
    if (tool === null || typeof tool !== "object") {
      violations.push({ code: "TOOL_SHAPE_NESTED_FUNCTION", pointer });
      return;
    }
    const record = tool as Record<string, unknown>;

    // Codex flattens the function definition; a nested `function` object is the
    // Chat Completions shape and means the wrong encoder ran.
    if ("function" in record) {
      violations.push({ code: "TOOL_SHAPE_NESTED_FUNCTION", pointer: `${pointer}/function` });
    }
    if (typeof record.strict !== "boolean") {
      violations.push({ code: "TOOL_STRICT_NOT_BOOLEAN", pointer: `${pointer}/strict` });
    }
    for (const key of FORBIDDEN_SCHEMA_KEYS) {
      if (containsKey(record.parameters, key)) {
        violations.push({
          code: "TOOL_SCHEMA_FORBIDDEN_KEY",
          pointer: `${pointer}/parameters/${key}`,
        });
      }
    }
  });
  return violations;
}

function containsKey(value: unknown, key: string): boolean {
  if (Array.isArray(value)) return value.some((entry) => containsKey(entry, key));
  if (value === null || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (key in record) return true;
  return Object.values(record).some((entry) => containsKey(entry, key));
}

/** True when a diff pointer lands inside the exact-match projection. */
export function isProfilePointer(pointer: string): boolean {
  if (
    pointer === "/method" ||
    pointer === "/path" ||
    pointer === "/queryOrder" ||
    pointer.startsWith("/query")
  ) {
    return true;
  }

  if (pointer.startsWith("/headers/")) {
    const name = pointer.slice("/headers/".length).split("/")[0] ?? "";
    if (VOLATILE_POINTERS.includes(`/headers/${name}`)) return false;
    if (CODEX_PRODUCT_POINTERS.includes(`/headers/${name}`)) return false;
    return true;
  }

  if (pointer.startsWith("/body/")) {
    const key = pointer.slice("/body/".length).split("/")[0] ?? "";
    if (VOLATILE_POINTERS.includes(`/body/${key}`)) return false;
    if (CODEX_PRODUCT_POINTERS.includes(`/body/${key}`)) return false;
    return true;
  }

  return false;
}

export function classifyPointer(pointer: string): "exact" | "volatile" | "product" {
  const head = pointer.startsWith("/headers/")
    ? `/headers/${pointer.slice("/headers/".length).split("/")[0]}`
    : pointer.startsWith("/body/")
      ? `/body/${pointer.slice("/body/".length).split("/")[0]}`
      : pointer;

  if (CODEX_PRODUCT_POINTERS.includes(head)) return "product";
  if (VOLATILE_POINTERS.includes(head)) return "volatile";
  return "exact";
}

export class ProfileViolationError extends Error {
  readonly violations: Violation[];
  constructor(violations: Violation[]) {
    super(`profile violations: ${violations.map((v) => `${v.code}@${v.pointer}`).join(", ")}`);
    this.name = "ProfileViolationError";
    this.violations = violations;
  }
}
