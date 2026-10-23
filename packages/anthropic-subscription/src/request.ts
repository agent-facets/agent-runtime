// Derived from @ex-machina/opencode-anthropic-auth src/transform.ts (revision 156cb66); see PROVENANCE.md.
// Kept: the OAuth headers (bearer authorization, merged betas, reported user agent, no x-api-key), the `beta=true`
// query, and the [billing, identity, ...system] layout. Not carried over: tool-name aliasing (D1), OpenCode prompt
// sanitation (D7) and environment-configured endpoints (D6). Added: requests the profile cannot represent faithfully
// are refused instead of sent — a conversation that does not open with user text, non-native tool names and
// generated tool schemas.
import { BILLING_PREFIX, billingText, firstUserMessageText, type WireMessage } from './billing.ts';
import type { SubscriptionProfile } from './profile.ts';

export const MAX_REQUEST_BODY_BYTES = 10 * 1024 * 1024;

/** Keys a JSON Schema generator adds; tool schemas are authored literals, so these never belong in one. */
const GENERATED_SCHEMA_KEYS = new Set(['$schema', '$id', '$defs', 'definitions']);

/** Headers describing the original body, which the adaptation replaces. */
const BODY_DESCRIBING_HEADERS = [
  'content-digest',
  'content-encoding',
  'content-length',
  'content-md5',
  'content-range',
  'digest',
  'etag',
];

export type AdaptRefusal =
  | 'unsupported_endpoint'
  | 'body_too_large'
  | 'invalid_body'
  | 'leading_user_text_required'
  | 'tool_name_not_native'
  | 'tool_schema_not_authored';

export interface InferenceRequest {
  url: string;
  method: string;
  headers: Headers;
  body: string;
}

export type AdaptResult = ({ ok: true } & InferenceRequest) | { ok: false; reason: AdaptRefusal };

type Json = Record<string, unknown>;
const isRecord = (value: unknown): value is Json =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function hasGeneratedSchemaKey(value: unknown, depth = 0): boolean {
  if (depth > 64 || value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some((item) => hasGeneratedSchemaKey(item, depth + 1));
  return Object.entries(value).some(
    ([key, item]) => GENERATED_SCHEMA_KEYS.has(key) || hasGeneratedSchemaKey(item, depth + 1),
  );
}

function mergedBetas(headers: Headers, profile: SubscriptionProfile): string {
  const incoming = (headers.get('anthropic-beta') ?? '')
    .split(',')
    .map((beta) => beta.trim())
    .filter(Boolean);
  return [...new Set([...profile.requiredBetas, ...incoming])].join(',');
}

/** [identity, ...the request's own text blocks], dropping repeated identity and stale billing blocks. */
function systemWithIdentity(system: unknown, profile: SubscriptionProfile): Json[] {
  const identity = { type: 'text', text: profile.identity };
  const kept = (text: string) => text !== '' && text !== profile.identity && !text.startsWith(BILLING_PREFIX);
  if (system === undefined || system === null) return [identity];
  if (typeof system === 'string') return kept(system) ? [identity, { type: 'text', text: system }] : [identity];
  const items = Array.isArray(system) ? system : [system];
  const rest: Json[] = [];
  for (const item of items) {
    if (typeof item === 'string') {
      if (kept(item)) rest.push({ type: 'text', text: item });
    } else if (isRecord(item) && item.type === 'text' && typeof item.text === 'string' && kept(item.text)) {
      rest.push(item);
    }
  }
  return [identity, ...rest];
}

function refusal(reason: AdaptRefusal): AdaptResult {
  return { ok: false, reason };
}

/**
 * Adapts one Messages API request to the subscription profile. The caller supplies the access token of the
 * credential generation this request is sent with; the result is sent unchanged or not at all.
 */
export function adaptInferenceRequest(
  request: InferenceRequest,
  context: { profile: SubscriptionProfile; accessToken: string },
): AdaptResult {
  const { profile } = context;
  const url = URL.canParse(request.url) ? new URL(request.url) : undefined;
  if (
    url === undefined ||
    request.method.toUpperCase() !== 'POST' ||
    url.origin !== profile.origin ||
    url.username !== '' ||
    url.password !== '' ||
    url.hash !== '' ||
    url.pathname !== profile.path ||
    (url.search !== '' && url.search !== '?beta=true')
  ) {
    return refusal('unsupported_endpoint');
  }
  url.search = '?beta=true';

  if (new TextEncoder().encode(request.body).byteLength > MAX_REQUEST_BODY_BYTES) return refusal('body_too_large');
  let parsed: unknown;
  try {
    parsed = JSON.parse(request.body);
  } catch {
    return refusal('invalid_body');
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.messages) || parsed.messages.length === 0) {
    return refusal('invalid_body');
  }
  const messages = parsed.messages as WireMessage[];
  // The billing block derives from the first user text; a history that does not open with it would derive a
  // different, degenerate client fingerprint (D7).
  if (!isRecord(messages[0]) || messages[0].role !== 'user' || firstUserMessageText(messages.slice(0, 1)) === '') {
    return refusal('leading_user_text_required');
  }

  if (parsed.tools !== undefined) {
    if (!Array.isArray(parsed.tools)) return refusal('invalid_body');
    for (const tool of parsed.tools) {
      if (!isRecord(tool) || typeof tool.name !== 'string') return refusal('invalid_body');
      if (!profile.toolName.test(tool.name)) return refusal('tool_name_not_native');
      if (hasGeneratedSchemaKey(tool.input_schema)) return refusal('tool_schema_not_authored');
    }
  }
  for (const message of messages) {
    if (!isRecord(message) || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (isRecord(block) && block.type === 'tool_use') {
        if (typeof block.name !== 'string' || !profile.toolName.test(block.name))
          return refusal('tool_name_not_native');
      }
    }
  }

  const system = systemWithIdentity(parsed.system, profile);
  system.unshift({ type: 'text', text: billingText(messages, profile) });
  parsed.system = system;

  const headers = new Headers(request.headers);
  for (const name of BODY_DESCRIBING_HEADERS) headers.delete(name);
  headers.delete('x-api-key');
  headers.set('authorization', `Bearer ${context.accessToken}`);
  headers.set('anthropic-beta', mergedBetas(request.headers, profile));
  headers.set('user-agent', profile.userAgent);

  return { ok: true, url: url.href, method: 'POST', headers, body: JSON.stringify(parsed) };
}
