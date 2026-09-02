// Canonicalisation and the complete-wire diff.
//
// Canonicalisation is deliberately narrow: only transformations that are
// provably non-semantic for HTTP/JSON, applied symmetrically to both lanes.
// Sorting or deduplicating arrays, trimming, case-folding values, dropping
// unknown keys, coercing numbers, and redacting before comparison are all
// forbidden, because each of them can hide real drift.
//
// Three OpenAI-specific normalisations exist, and no others:
//
//   1. `host` is dropped from the comparison. The fidelity lane talks to the
//      real subscription host and the deterministic lane to loopback, so a host
//      difference is expected; each lane asserts its own host separately.
//   2. The provider base path prefix is stripped, leaving `/responses`.
//   3. A zstd-compressed body is decompressed, and `content-encoding` is then
//      compared as a first-class field so decompression cannot mask it.

import { createHash } from "node:crypto";
import { zstdDecompressSync } from "node:zlib";

import { sanitizeText } from "../evidence.ts";
import { classifyPointer, isProfilePointer, MACHINE_DEPENDENT_HEADERS } from "./profile.ts";

export type RawCapture = {
  method: string;
  url: string;
  headers: Record<string, string>;
  bodyRaw: string;
  /** Present only when the body arrived compressed. */
  bodyBytes?: Buffer;
};

export type CanonicalRequest = {
  method: string;
  host: string;
  path: string;
  query: Array<[string, string]>;
  queryOrder: string;
  headers: Array<[string, string]>;
  body: unknown;
};

export function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

export function canonicalize(capture: RawCapture, basePathPrefix = ""): CanonicalRequest {
  const url = new URL(capture.url);

  const queryOrder = [...url.searchParams.keys()].join(",");
  const query: Array<[string, string]> = [...url.searchParams.entries()].sort((a, b) =>
    a[0] === b[0] ? compare(a[1], b[1]) : compare(a[0], b[0]),
  );

  const headers: Array<[string, string]> = Object.entries(capture.headers)
    .map(([name, value]): [string, string] => [name.toLowerCase(), value])
    .sort((a, b) => compare(a[0], b[0]));

  let path = url.pathname;
  if (basePathPrefix && path.startsWith(basePathPrefix)) {
    path = path.slice(basePathPrefix.length) || "/";
  }

  let raw = capture.bodyRaw;
  const encoding = headers.find(([name]) => name === "content-encoding")?.[1];
  if (encoding === "zstd" && capture.bodyBytes) {
    raw = zstdDecompressSync(capture.bodyBytes).toString("utf8");
  }

  let body: unknown;
  try {
    body = sortKeys(JSON.parse(raw));
  } catch {
    body = { __unparsed_body__: raw };
  }

  return { method: capture.method.toUpperCase(), host: url.host, path, query, queryOrder, headers, body };
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// ---------------------------------------------------------------------------

export type DiffKind = "added" | "removed" | "changed" | "typeChanged";
export type DiffCategory =
  | "profile-bearing"
  | "volatile-transport"
  | "codex-product"
  | "unexplained";

export type WireDiff = {
  pointer: string;
  kind: DiffKind;
  category: DiffCategory;
};

export type AllowlistRule = {
  id: string;
  pointer: string;
  category: "volatile-transport";
  rationale: string;
};

/**
 * Committed allowlist. Deliberately empty and expected to stay that way: an
 * entry may not name a pointer inside the projection, which is checked at load,
 * so the wire diff can never be weakened into agreement.
 */
export const ALLOWLIST: AllowlistRule[] = [];

export function validateAllowlist(): string[] {
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const rule of ALLOWLIST) {
    if (seen.has(rule.id)) errors.push(`duplicate allowlist rule id: ${rule.id}`);
    seen.add(rule.id);
    if (isProfilePointer(rule.pointer)) {
      errors.push(`allowlist rule ${rule.id} names profile-bearing pointer ${rule.pointer}`);
    }
    if (!rule.rationale.trim()) errors.push(`allowlist rule ${rule.id} has no rationale`);
  }
  return errors;
}

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function walk(
  pointer: string,
  reference: unknown,
  candidate: unknown,
  out: Array<Omit<WireDiff, "category">>,
): void {
  if (Object.is(reference, candidate)) return;

  if (reference === undefined && candidate !== undefined) {
    out.push({ pointer, kind: "added" });
    return;
  }
  if (reference !== undefined && candidate === undefined) {
    out.push({ pointer, kind: "removed" });
    return;
  }

  const referenceType = typeOf(reference);
  if (referenceType !== typeOf(candidate)) {
    out.push({ pointer, kind: "typeChanged" });
    return;
  }

  if (referenceType === "array") {
    const a = reference as unknown[];
    const b = candidate as unknown[];
    for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
      walk(`${pointer}/${index}`, a[index], b[index], out);
    }
    return;
  }

  if (referenceType === "object") {
    const a = reference as Record<string, unknown>;
    const b = candidate as Record<string, unknown>;
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      walk(`${pointer}/${escapePointer(key)}`, a[key], b[key], out);
    }
    return;
  }

  out.push({ pointer, kind: "changed" });
}

function escapePointer(token: string): string {
  return token.replace(/~/g, "~0").replace(/\//g, "~1");
}

function shapeForDiff(request: CanonicalRequest): Record<string, unknown> {
  return {
    method: request.method,
    path: request.path,
    query: Object.fromEntries(request.query),
    queryOrder: request.queryOrder,
    headers: Object.fromEntries(request.headers),
    body: request.body,
  };
}

export function diffRequests(
  reference: CanonicalRequest,
  candidate: CanonicalRequest,
): WireDiff[] {
  const raw: Array<Omit<WireDiff, "category">> = [];
  walk("", shapeForDiff(reference), shapeForDiff(candidate), raw);

  return raw.map((entry): WireDiff => {
    const classification = classifyPointer(entry.pointer);
    if (classification === "product") return { ...entry, category: "codex-product" };
    if (classification === "volatile") return { ...entry, category: "volatile-transport" };
    if (isProfilePointer(entry.pointer)) return { ...entry, category: "profile-bearing" };
    return { ...entry, category: "unexplained" };
  });
}

export function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b));
}

// ---------------------------------------------------------------------------

/** Machine-dependent values become typed markers on the way to disk only. */
export function forEvidence(request: CanonicalRequest): CanonicalRequest {
  return {
    ...request,
    headers: request.headers.map(([name, value]): [string, string] => {
      if (name === "authorization") return [name, "Bearer <sentinel>"];
      if (MACHINE_DEPENDENT_HEADERS.includes(name)) {
        return [name, `<machine:${typeof value}:${value.length}>`];
      }
      return [name, value];
    }),
  };
}

/** Header values that are credentials or account identity, never evidence. */
const SECRET_HEADERS = [
  "authorization",
  "chatgpt-account-id",
  "x-codex-installation-id",
  "x-oai-attestation",
  "x-codex-turn-metadata",
];

/**
 * Bulky or identity-bearing body fields. Codex's `instructions` is ~20 KB of
 * product prompt and `client_metadata` carries sandbox and workspace details,
 * so both are recorded as a digest and a length: enough to prove they were
 * present and stable, nothing that could leak.
 */
const DIGESTED_BODY_KEYS = ["instructions", "client_metadata", "input"];

/**
 * The oracle's capture is real traffic from a real client. Everything that
 * leaves the process is redacted here, *after* every comparison has already
 * happened on the unredacted in-memory values.
 */
export function redactCanonicalForEvidence(request: CanonicalRequest): CanonicalRequest {
  return {
    ...request,
    host: "<host>",
    headers: request.headers.map(([name, value]): [string, string] => {
      if (SECRET_HEADERS.includes(name)) return [name, `<redacted:${value.length}>`];
      if (MACHINE_DEPENDENT_HEADERS.includes(name)) {
        return [name, `<machine:${value.length}>`];
      }
      return [name, sanitizeText(value)];
    }),
    body: redactBody(request.body),
  };
}

function redactBody(value: unknown, key: string | null = null): unknown {
  if (key !== null && DIGESTED_BODY_KEYS.includes(key)) {
    const serialized = JSON.stringify(value ?? null);
    return {
      __digest: createHash("sha256").update(serialized).digest("hex").slice(0, 32),
      __length: serialized.length,
    };
  }
  if (Array.isArray(value)) return value.map((entry) => redactBody(entry));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [name, nested] of Object.entries(value as Record<string, unknown>)) {
      out[name] = redactBody(nested, name);
    }
    return out;
  }
  return typeof value === "string" ? sanitizeText(value) : value;
}

export function managedDigestInput(request: CanonicalRequest): unknown {
  return sortKeys({
    method: request.method,
    path: request.path,
    query: request.query,
    queryOrder: request.queryOrder,
    headers: request.headers.filter(([name]) => !MACHINE_DEPENDENT_HEADERS.includes(name)),
    body: request.body,
  });
}
