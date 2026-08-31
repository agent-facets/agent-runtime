// Canonicalisation, the profile projection, and the complete-wire diff.
//
// Canonicalisation is deliberately narrow. Only transformations that are
// provably non-semantic for HTTP/JSON are permitted, and they are applied
// symmetrically to both lanes. Anything that could mask drift -- sorting or
// deduplicating arrays, trimming or case-folding values, dropping unknown keys,
// coercing numbers, reordering multi-value headers, or redacting before
// comparison -- is forbidden.

import { MACHINE_DEPENDENT_HEADERS } from "./profile.ts";

export type RawCapture = {
  method: string;
  url: string;
  headers: Record<string, string>;
  bodyRaw: string;
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

/** Recursively sort object keys. Arrays keep their order. */
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

export function canonicalize(capture: RawCapture): CanonicalRequest {
  const url = new URL(capture.url);

  const queryOrder = [...url.searchParams.keys()].join(",");
  const query: Array<[string, string]> = [...url.searchParams.entries()].sort(
    (a, b) => (a[0] === b[0] ? compare(a[1], b[1]) : compare(a[0], b[0])),
  );

  const headers: Array<[string, string]> = Object.entries(capture.headers)
    .map(([name, value]): [string, string] => [name.toLowerCase(), value])
    .sort((a, b) => compare(a[0], b[0]));

  let body: unknown;
  try {
    body = sortKeys(JSON.parse(capture.bodyRaw));
  } catch {
    body = { __unparsed_body__: capture.bodyRaw };
  }

  return {
    method: capture.method.toUpperCase(),
    host: url.host,
    path: url.pathname,
    query,
    queryOrder,
    headers,
    body,
  };
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Profile projection: exactly the paths gate A reads.

const PROFILE_HEADER_NAMES = [
  "authorization",
  "user-agent",
  "anthropic-beta",
  "x-api-key",
];

export type ProfileProjection = {
  method: string;
  host: string;
  path: string;
  query: Array<[string, string]>;
  queryOrder: string;
  headers: Array<[string, string | null]>;
  system: unknown;
  tools: unknown;
  messages: unknown;
  model: unknown;
  maxTokens: unknown;
  stream: unknown;
};

export function projectProfile(request: CanonicalRequest): ProfileProjection {
  const body = (request.body ?? {}) as Record<string, unknown>;
  const headerMap = new Map(request.headers);

  return {
    method: request.method,
    host: request.host,
    path: request.path,
    query: request.query,
    queryOrder: request.queryOrder,
    headers: PROFILE_HEADER_NAMES.map((name): [string, string | null] => [
      name,
      headerMap.get(name) ?? null,
    ]),
    system: body.system ?? null,
    tools: body.tools ?? null,
    messages: body.messages ?? null,
    model: body.model ?? null,
    maxTokens: body.max_tokens ?? null,
    stream: body.stream ?? null,
  };
}

/**
 * True when a diff pointer lands inside the projection. The allowlist may never
 * name such a pointer, which is what stops gate B weakening gate A.
 */
export function isProfilePointer(pointer: string): boolean {
  if (
    pointer === "/method" ||
    pointer === "/host" ||
    pointer === "/path" ||
    pointer === "/queryOrder" ||
    pointer.startsWith("/query")
  ) {
    return true;
  }

  if (pointer.startsWith("/headers/")) {
    const name = pointer.slice("/headers/".length).split("/")[0] ?? "";
    return PROFILE_HEADER_NAMES.includes(name);
  }

  return (
    pointer.startsWith("/body/system") ||
    pointer.startsWith("/body/tools") ||
    pointer.startsWith("/body/messages") ||
    pointer === "/body/model" ||
    pointer === "/body/max_tokens" ||
    pointer === "/body/stream"
  );
}

// ---------------------------------------------------------------------------
// Complete-wire diff

export type DiffKind = "added" | "removed" | "changed" | "typeChanged";
export type DiffCategory =
  | "profile-bearing"
  | "client-serialization"
  | "volatile-transport"
  | "unexplained";

export type WireDiff = {
  pointer: string;
  kind: DiffKind;
  reference: unknown;
  candidate: unknown;
  category: DiffCategory;
  rule: string | null;
};

export type AllowlistRule = {
  id: string;
  pointer: string;
  category: "client-serialization" | "volatile-transport";
  rationale: string;
};

/**
 * Committed allowlist for non-profile differences.
 *
 * Deliberately empty. Both lanes drive the same stock ChatAnthropic and the
 * same Anthropic SDK, so a serialization difference is not expected and must
 * not be pre-excused. An entry added here has to name an exact pointer, and a
 * pointer inside the projection is rejected at load.
 */
export const ALLOWLIST: AllowlistRule[] = [];

export function validateAllowlist(): string[] {
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const rule of ALLOWLIST) {
    if (seen.has(rule.id)) errors.push(`duplicate allowlist rule id: ${rule.id}`);
    seen.add(rule.id);
    if (isProfilePointer(rule.pointer)) {
      errors.push(
        `allowlist rule ${rule.id} names profile-bearing pointer ${rule.pointer}`,
      );
    }
    if (!rule.rationale.trim()) {
      errors.push(`allowlist rule ${rule.id} has no rationale`);
    }
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
  out: Array<Omit<WireDiff, "category" | "rule">>,
): void {
  if (Object.is(reference, candidate)) return;

  const referenceMissing = reference === undefined;
  const candidateMissing = candidate === undefined;

  if (referenceMissing && !candidateMissing) {
    out.push({ pointer, kind: "added", reference: null, candidate });
    return;
  }
  if (!referenceMissing && candidateMissing) {
    out.push({ pointer, kind: "removed", reference, candidate: null });
    return;
  }

  const referenceType = typeOf(reference);
  const candidateType = typeOf(candidate);
  if (referenceType !== candidateType) {
    out.push({ pointer, kind: "typeChanged", reference, candidate });
    return;
  }

  if (referenceType === "array") {
    const a = reference as unknown[];
    const b = candidate as unknown[];
    const length = Math.max(a.length, b.length);
    for (let index = 0; index < length; index += 1) {
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

  out.push({ pointer, kind: "changed", reference, candidate });
}

function escapePointer(token: string): string {
  return token.replace(/~/g, "~0").replace(/\//g, "~1");
}

/** Headers as an object so pointers read /headers/<name>. */
function shapeForDiff(request: CanonicalRequest): Record<string, unknown> {
  return {
    method: request.method,
    host: request.host,
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
  const raw: Array<Omit<WireDiff, "category" | "rule">> = [];
  walk("", shapeForDiff(reference), shapeForDiff(candidate), raw);

  return raw.map((entry): WireDiff => {
    if (isProfilePointer(entry.pointer)) {
      return { ...entry, category: "profile-bearing", rule: null };
    }
    const rule = ALLOWLIST.find((candidateRule) => candidateRule.pointer === entry.pointer);
    if (rule) return { ...entry, category: rule.category, rule: rule.id };
    return { ...entry, category: "unexplained", rule: null };
  });
}

export function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b));
}

// ---------------------------------------------------------------------------
// Evidence shaping

/**
 * Replace machine-dependent header values with typed markers so persisted
 * evidence is portable. Applied only on the way to disk, never before a
 * comparison.
 */
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

/**
 * The subset asserted to be byte-identical across repeated container runs.
 * Machine-dependent header values are excluded; everything else is managed.
 */
export function managedDigestInput(request: CanonicalRequest): unknown {
  return sortKeys({
    method: request.method,
    host: request.host,
    path: request.path,
    query: request.query,
    queryOrder: request.queryOrder,
    headers: request.headers.filter(
      ([name]) => !MACHINE_DEPENDENT_HEADERS.includes(name),
    ),
    body: request.body,
  });
}
