// The candidate transport: a decorated fetch injected into stock ChatAnthropic
// through clientOptions.fetch. No BaseChatModel subclass, no custom Anthropic
// client, and no rewriting of response bytes.
//
// Two deliberate departures from the reference plugin, both from
// architecture/05-model-authentication.md:
//
//   1. Tool names are already Claude-native, so nothing renames them on the way
//      out and nothing has to un-rename them in the stream. That removes the
//      only chunk-boundary-fragile code in the path.
//   2. Every transformed request is validated against the active compatibility
//      profile before dispatch, and a violation throws rather than sending a
//      novel profile.

import {
  CLAUDE_CODE_IDENTITY,
  OPENCODE_IDENTITY_PREFIX,
  PARAGRAPH_REMOVAL_ANCHORS,
  REQUIRED_BETAS,
  TEXT_REPLACEMENTS,
  USER_AGENT,
  buildBillingText,
  profileViolationError,
  validateRequest,
} from "./profile.ts";
import { canonicalize } from "./canonical.ts";
import type { CanonicalRequest } from "./canonical.ts";

type FetchInput = string | URL | Request;

export type PendingRequest = {
  method: string;
  url: URL;
  headers: Headers;
  body: string | undefined;
};

export type CandidateOptions = {
  accessToken: string;
  terminal: (input: FetchInput, init?: RequestInit) => Promise<Response>;
  /** Negative-control hook. Mutates the fully transformed request in place. */
  mutate?: (pending: PendingRequest) => void;
  validate?: boolean;
};

// ---------------------------------------------------------------------------
// Header handling

export function mergeHeaders(input: FetchInput, init?: RequestInit): Headers {
  const headers = new Headers();

  if (input instanceof Request) {
    input.headers.forEach((value, key) => headers.set(key, value));
  }

  const initHeaders = init?.headers;
  if (initHeaders) {
    if (initHeaders instanceof Headers) {
      initHeaders.forEach((value, key) => headers.set(key, value));
    } else if (Array.isArray(initHeaders)) {
      for (const [key, value] of initHeaders) {
        if (typeof value !== "undefined") headers.set(key, String(value));
      }
    } else {
      for (const [key, value] of Object.entries(initHeaders)) {
        if (typeof value !== "undefined") headers.set(key, String(value));
      }
    }
  }

  return headers;
}

export function mergeBetaHeaders(headers: Headers): string {
  const incoming = headers.get("anthropic-beta") || "";
  const incomingList = incoming
    .split(",")
    .map((beta) => beta.trim())
    .filter(Boolean);

  return [...new Set([...REQUIRED_BETAS, ...incomingList])].join(",");
}

export function setOAuthHeaders(headers: Headers, accessToken: string): Headers {
  headers.set("authorization", `Bearer ${accessToken}`);
  headers.set("anthropic-beta", mergeBetaHeaders(headers));
  headers.set("user-agent", USER_AGENT);
  headers.delete("x-api-key");
  return headers;
}

// ---------------------------------------------------------------------------
// System prompt shaping

type SystemBlock = { type: string; text: string; [key: string]: unknown };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function sanitizeSystemText(text: string): string {
  const paragraphs = text.split(/\n\n+/);

  const filtered = paragraphs.filter((paragraph) => {
    if (paragraph.includes(OPENCODE_IDENTITY_PREFIX)) return false;
    for (const anchor of PARAGRAPH_REMOVAL_ANCHORS) {
      if (paragraph.includes(anchor)) return false;
    }
    return true;
  });

  let result = filtered.join("\n\n");
  for (const rule of TEXT_REPLACEMENTS) {
    result = result.replace(rule.match, rule.replacement);
  }
  return result.trim();
}

export function prependClaudeCodeIdentity(system: unknown): SystemBlock[] {
  const identityBlock: SystemBlock = { type: "text", text: CLAUDE_CODE_IDENTITY };

  if (system === null || system === undefined) return [identityBlock];

  if (typeof system === "string") {
    const sanitized = sanitizeSystemText(system);
    if (sanitized === CLAUDE_CODE_IDENTITY) return [identityBlock];
    return [identityBlock, { type: "text", text: sanitized }];
  }

  if (isRecord(system)) {
    const type = typeof system.type === "string" ? system.type : "text";
    const text = typeof system.text === "string" ? system.text : "";
    return [identityBlock, { ...system, type, text: sanitizeSystemText(text) }];
  }

  if (!Array.isArray(system)) return [identityBlock];

  const sanitized: SystemBlock[] = system.map((item: unknown) => {
    if (typeof item === "string") {
      return { type: "text", text: sanitizeSystemText(item) };
    }
    if (isRecord(item) && item.type === "text" && typeof item.text === "string") {
      return { ...item, type: "text", text: sanitizeSystemText(item.text) } as SystemBlock;
    }
    return { type: "text", text: String(item) };
  });

  if (sanitized[0]?.text === CLAUDE_CODE_IDENTITY) return sanitized;

  return [identityBlock, ...sanitized];
}

export function rewriteRequestBody(body: string): string {
  try {
    const parsed = JSON.parse(body);

    const billingText =
      Array.isArray(parsed.messages) &&
      parsed.messages.some((message: { role?: string }) => message.role === "user")
        ? buildBillingText(parsed.messages)
        : null;

    parsed.system = prependClaudeCodeIdentity(parsed.system);

    if (billingText && Array.isArray(parsed.system)) {
      parsed.system.unshift({ type: "text", text: billingText });
    }

    // No tool renaming: the bound tools already carry Claude-native names.
    return JSON.stringify(parsed);
  } catch {
    return body;
  }
}

// ---------------------------------------------------------------------------
// URL

export function rewriteUrl(input: FetchInput): URL {
  const href =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;
  const url = new URL(href);

  if (url.pathname === "/v1/messages" && !url.searchParams.has("beta")) {
    url.searchParams.set("beta", "true");
  }

  return url;
}

// ---------------------------------------------------------------------------

export function toValidatable(pending: PendingRequest): CanonicalRequest {
  const headers: Record<string, string> = {};
  pending.headers.forEach((value, key) => {
    headers[key] = value;
  });

  return canonicalize({
    method: pending.method,
    url: pending.url.toString(),
    headers,
    bodyRaw: pending.body ?? "",
  });
}

export function createCandidateFetch(options: CandidateOptions) {
  const validate = options.validate !== false;

  return async function candidateFetch(
    input: FetchInput,
    init?: RequestInit,
  ): Promise<Response> {
    const headers = mergeHeaders(input, init);
    setOAuthHeaders(headers, options.accessToken);

    let body = init?.body;
    if (typeof body === "string") body = rewriteRequestBody(body);

    const method = (
      init?.method ?? (input instanceof Request ? input.method : "GET")
    ).toUpperCase();

    const pending: PendingRequest = {
      method,
      url: rewriteUrl(input),
      headers,
      body: typeof body === "string" ? body : undefined,
    };

    options.mutate?.(pending);

    if (validate) {
      const canonical = toValidatable(pending);
      const violations = validateRequest({
        method: canonical.method,
        host: canonical.host,
        path: canonical.path,
        query: canonical.query,
        headers: canonical.headers,
        body: (canonical.body ?? {}) as Record<string, unknown>,
      });
      if (violations.length > 0) throw profileViolationError(violations);
    }

    return options.terminal(pending.url, {
      ...init,
      method: pending.method,
      headers: pending.headers,
      body: pending.body,
    });
  };
}
