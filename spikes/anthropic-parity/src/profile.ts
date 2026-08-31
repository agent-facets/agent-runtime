// The compatibility profile for claude-cli/2.1.87, plus the fail-closed
// validator that every candidate request must satisfy BEFORE dispatch.
//
// Constants are transcribed from the pinned reference package
// @ex-machina/opencode-anthropic-auth@1.8.1 (commit f9947c0c). They are
// asserted against the shipped plugin's real output by the differential run,
// so a transcription error surfaces as a parity failure, not a silent pass.

import { createHash } from "node:crypto";

export const PROFILE_ID = "claude-cli/2.1.87";
export const PROFILE_REVISION = 1;

export const CLAUDE_CODE_VERSION = "2.1.87";
export const CLAUDE_CODE_ENTRYPOINT = "sdk-cli";
export const USER_AGENT = `claude-cli/${CLAUDE_CODE_VERSION} (external, cli)`;

export const REQUIRED_BETAS = ["oauth-2025-04-20", "interleaved-thinking-2025-05-14"];

export const CLAUDE_CODE_IDENTITY =
  "You are a Claude agent, built on Anthropic's Claude Agent SDK.";
export const OPENCODE_IDENTITY_PREFIX = "You are OpenCode";
export const PARAGRAPH_REMOVAL_ANCHORS = [
  "github.com/anomalyco/opencode",
  "opencode.ai/docs",
];
export const TEXT_REPLACEMENTS = [
  { match: "if OpenCode honestly", replacement: "if the assistant honestly" },
  {
    match:
      "Here is some useful information about the environment you are running in:",
    replacement: "Environment context you are running in:",
  },
];

export const CCH_SALT = "59cf53e54c78";
export const CCH_POSITIONS = [4, 7, 20];
export const BILLING_PREFIX = "x-anthropic-billing-header: ";

export const API_HOST = "api.anthropic.com";
export const API_PATH = "/v1/messages";
export const BETA_QUERY_PARAM = "beta";
export const BETA_QUERY_VALUE = "true";

// Claude Code sends PascalCase-after-prefix tool names. A lowercase name is a
// documented non-Claude-Code signal, so casing is profile-bearing.
export const TOOL_NAME_PATTERN = /^mcp_[A-Z][A-Za-z0-9_]*$/;

export const FORBIDDEN_HEADERS = ["x-api-key"];

// Generated-schema drift is eliminated at the source rather than allowlisted:
// tools are authored as JSON Schema literals, so these keys must never appear.
export const FORBIDDEN_SCHEMA_KEYS = ["$schema", "$id", "$defs", "definitions"];

// Provider-visible headers the profile knows about. Anything else is a novel
// client fingerprint and fails closed.
export const KNOWN_HEADERS = [
  "accept",
  "anthropic-beta",
  "anthropic-version",
  "authorization",
  "content-length",
  "content-type",
  "user-agent",
  "x-stainless-arch",
  "x-stainless-lang",
  "x-stainless-os",
  "x-stainless-package-version",
  "x-stainless-retry-count",
  "x-stainless-runtime",
  "x-stainless-runtime-version",
  "x-stainless-timeout",
];

// Machine-dependent values. Retained and compared between lanes; replaced with
// typed markers only when evidence is persisted, so a run stays portable.
export const MACHINE_DEPENDENT_HEADERS = [
  "x-stainless-arch",
  "x-stainless-os",
  "x-stainless-runtime-version",
];

// ---------------------------------------------------------------------------
// Billing / provenance derivation (mirrors the reference cch algorithm).

function sha256hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

type WireMessage = {
  role?: string;
  content?: string | Array<{ type?: string; text?: string }>;
};

export function extractFirstUserMessageText(messages: WireMessage[]): string {
  const userMsg = messages.find((message) => message.role === "user");
  if (!userMsg) return "";

  const content = userMsg.content;
  if (typeof content === "string") return content;

  if (Array.isArray(content)) {
    const textBlock = content.find((block) => block.type === "text");
    if (textBlock?.text) return textBlock.text;
  }

  return "";
}

export function computeCCH(messageText: string): string {
  return sha256hex(messageText).slice(0, 5);
}

export function computeVersionSuffix(
  messageText: string,
  version: string = CLAUDE_CODE_VERSION,
): string {
  const chars = CCH_POSITIONS.map((index) => messageText[index] || "0").join("");
  return sha256hex(`${CCH_SALT}${chars}${version}`).slice(0, 3);
}

export function buildBillingText(messages: WireMessage[]): string {
  const text = extractFirstUserMessageText(messages);
  const suffix = computeVersionSuffix(text);
  const cch = computeCCH(text);
  return (
    BILLING_PREFIX +
    `cc_version=${CLAUDE_CODE_VERSION}.${suffix}; ` +
    `cc_entrypoint=${CLAUDE_CODE_ENTRYPOINT}; ` +
    `cch=${cch};`
  );
}

// ---------------------------------------------------------------------------
// Validator

export type Violation = {
  code: string;
  pointer: string;
};

export type ValidatableRequest = {
  method: string;
  host: string;
  path: string;
  query: Array<[string, string]>;
  headers: Array<[string, string]>;
  body: Record<string, unknown>;
};

function headerValue(
  headers: Array<[string, string]>,
  name: string,
): string | undefined {
  const hit = headers.find(([key]) => key === name);
  return hit?.[1];
}

function containsForbiddenSchemaKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsForbiddenSchemaKey);
  if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (FORBIDDEN_SCHEMA_KEYS.includes(key)) return true;
      if (containsForbiddenSchemaKey(child)) return true;
    }
  }
  return false;
}

export function validateRequest(req: ValidatableRequest): Violation[] {
  const violations: Violation[] = [];
  const add = (code: string, pointer: string) => {
    violations.push({ code, pointer });
  };

  if (req.method !== "POST") add("METHOD_MISMATCH", "/method");
  if (req.host !== API_HOST) add("HOST_MISMATCH", "/host");
  if (req.path !== API_PATH) add("PATH_MISMATCH", "/path");

  const betaParams = req.query.filter(([key]) => key === BETA_QUERY_PARAM);
  if (betaParams.length !== 1 || betaParams[0]?.[1] !== BETA_QUERY_VALUE) {
    add("QUERY_PARAM_MISMATCH", "/query/beta");
  }
  for (const [key] of req.query) {
    if (key !== BETA_QUERY_PARAM) add("UNKNOWN_QUERY_PARAM", `/query/${key}`);
  }

  // --- headers -------------------------------------------------------------
  const authorization = headerValue(req.headers, "authorization");
  if (!authorization) {
    add("AUTH_MISSING", "/headers/authorization");
  } else if (!authorization.startsWith("Bearer ") || authorization.length <= 7) {
    add("AUTH_SCHEME_INVALID", "/headers/authorization");
  }

  for (const forbidden of FORBIDDEN_HEADERS) {
    if (headerValue(req.headers, forbidden) !== undefined) {
      add("FORBIDDEN_HEADER_PRESENT", `/headers/${forbidden}`);
    }
  }

  if (headerValue(req.headers, "user-agent") !== USER_AGENT) {
    add("USER_AGENT_MISMATCH", "/headers/user-agent");
  }

  const beta = headerValue(req.headers, "anthropic-beta");
  if (beta === undefined) {
    add("MISSING_REQUIRED_HEADER", "/headers/anthropic-beta");
  } else {
    const values = beta.split(",");
    if (new Set(values).size !== values.length) {
      add("BETA_SET_MISMATCH", "/headers/anthropic-beta");
    }
    for (const [index, required] of REQUIRED_BETAS.entries()) {
      if (values[index] !== required) {
        add("BETA_ORDER_MISMATCH", `/headers/anthropic-beta/${index}`);
      }
    }
  }

  for (const [name] of req.headers) {
    if (!KNOWN_HEADERS.includes(name)) add("UNKNOWN_HEADER", `/headers/${name}`);
  }

  // --- system --------------------------------------------------------------
  const system = req.body.system;
  if (!Array.isArray(system)) {
    add("SYSTEM_SHAPE_MISMATCH", "/body/system");
  } else {
    const messages = Array.isArray(req.body.messages)
      ? (req.body.messages as WireMessage[])
      : [];
    const expectsBilling = messages.some((message) => message.role === "user");
    const identityIndex = expectsBilling ? 1 : 0;

    if (expectsBilling) {
      const first = system[0] as { text?: unknown } | undefined;
      if (typeof first?.text !== "string" || first.text !== buildBillingText(messages)) {
        add("BILLING_HEADER_MISMATCH", "/body/system/0");
      }
    }

    const identity = system[identityIndex] as { text?: unknown } | undefined;
    if (identity?.text !== CLAUDE_CODE_IDENTITY) {
      add("SYSTEM_IDENTITY_MISMATCH", `/body/system/${identityIndex}`);
    }

    for (const [index, block] of system.entries()) {
      const text = (block as { text?: unknown }).text;
      if (typeof text !== "string") {
        add("SYSTEM_SHAPE_MISMATCH", `/body/system/${index}`);
        continue;
      }
      if (text.includes(OPENCODE_IDENTITY_PREFIX)) {
        add("SYSTEM_SANITATION_MISMATCH", `/body/system/${index}`);
      }
      for (const anchor of PARAGRAPH_REMOVAL_ANCHORS) {
        if (text.includes(anchor)) {
          add("SYSTEM_SANITATION_MISMATCH", `/body/system/${index}`);
        }
      }
    }
  }

  // --- tools ---------------------------------------------------------------
  const tools = req.body.tools;
  if (tools !== undefined) {
    if (!Array.isArray(tools)) {
      add("TOOL_SHAPE_MISMATCH", "/body/tools");
    } else {
      for (const [index, tool] of tools.entries()) {
        const name = (tool as { name?: unknown }).name;
        if (typeof name !== "string" || !TOOL_NAME_PATTERN.test(name)) {
          add("TOOL_NAME_CONVENTION", `/body/tools/${index}/name`);
        }
        if (containsForbiddenSchemaKey((tool as { input_schema?: unknown }).input_schema)) {
          add("TOOL_SCHEMA_FORBIDDEN_KEY", `/body/tools/${index}/input_schema`);
        }
      }
    }
  }

  // --- replayed tool_use ---------------------------------------------------
  const messages = req.body.messages;
  if (Array.isArray(messages)) {
    for (const [messageIndex, message] of messages.entries()) {
      const content = (message as { content?: unknown }).content;
      if (!Array.isArray(content)) continue;
      for (const [blockIndex, block] of content.entries()) {
        const typed = block as { type?: unknown; name?: unknown };
        if (typed.type !== "tool_use") continue;
        if (typeof typed.name !== "string" || !TOOL_NAME_PATTERN.test(typed.name)) {
          add(
            "HISTORY_TOOL_NAME_CONVENTION",
            `/body/messages/${messageIndex}/content/${blockIndex}/name`,
          );
        }
      }
    }
  }

  return violations;
}

export function profileViolationError(violations: Violation[]): Error {
  const error = new Error(
    `profile validation failed before dispatch: ${violations
      .map((violation) => violation.code)
      .join(", ")}`,
  );
  // Codes and pointers only. Values never travel with the error.
  (error as Error & { violations?: Violation[] }).violations = violations;
  (error as Error & { profileViolation?: boolean }).profileViolation = true;
  return error;
}
