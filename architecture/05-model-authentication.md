# Model Authentication

**Subscription authentication is the primary path.** API keys are the fallback.

Most agent frameworks assume metered API billing. We already pay for Claude and
ChatGPT subscriptions, and the coding-agent CLIs consume them. This document
describes how a LangGraph runtime does the same without becoming a CLI wrapper.

## The seam

The insight is that subscription access is a **transport** concern, not a model
concern. Authentication, headers, and request shaping happen below the model
client. Message conversion, tool binding, streaming, and usage stay above it.

```text
LangGraph node
      │
      ▼
ChatModel factory                    picks a transport by config
      │
      ├── ChatAnthropic ── Anthropic SDK ── subscription fetch ── OAuth
      ├── ChatAnthropic ── Anthropic SDK ── standard fetch ────── API key
      ├── ChatOpenAI ──── OpenAI SDK ───── subscription fetch ── OAuth
      └── ChatOpenAI ──── OpenAI SDK ───── standard fetch ────── API key
```

Both LangChain clients accept a custom client or fetch, so the subscription path
is a decorated `fetch` — not a subclassed model. We keep everything LangChain
already does correctly:

message conversion · content blocks · tool binding · tool results · streaming
deltas · usage metadata · prompt caching · beta header negotiation · structured
output · error wrapping · retry integration

**We MUST NOT subclass `BaseChatModel` for this.** Doing so forfeits the upgrade
path for all of the above.

**Verified.** [Spike 03](./spike-reports/03-anthropic-parity.md) built the
transport this way and Anthropic accepted it on a live subscription. The exact
construction:

```ts
new ChatAnthropic({
  model, maxTokens,
  apiKey: <sentinel>,        // constructor guard only
  maxRetries: 0,
  clientOptions: {
    fetch: subscriptionFetch,
    dangerouslyAllowBrowser: false,
  },
});
```

Four operational details the design could not have known, each of which changes
behaviour if missed:

1. **A sentinel API key is mandatory.** `ChatAnthropic` refuses to construct
   without one. The decorator deletes `x-api-key` before dispatch, so it never
   reaches the provider — and a non-null key usefully disables the SDK's ambient
   credential discovery, so no stray config file or environment variable can
   supply a real key behind our back.
2. **`maxRetries: 0` is required.** LangChain's own caller retries six times by
   default, on top of the SDK. A subscription transport MUST NOT silently
   multiply a failed request by seven.
3. **`dangerouslyAllowBrowser: false` removes a header.** LangChain hardcodes it
   true, which emits `anthropic-dangerous-direct-browser-access`. Overriding it
   deletes that signal rather than shipping a novel one.
4. **The beta query parameter MUST be appended exactly once.** LangChain routes
   to the beta endpoint by itself whenever `betas` is non-empty. Setting betas at
   the model layer *and* appending in the decorator doubles it.

## Why not the vendor agent SDKs

Claude Agent SDK and Codex SDK both authenticate with subscriptions, and both
run their own agent loop.

```text
LangGraph orchestration
      └── vendor agent loop
              └── model
```

Two nested loops means two sets of checkpoints, two tool permission models, two
retry policies, and two places a run can be paused. Our durability story
collapses. They remain viable as **specialist executors** behind a single
delegating node — never as the substrate.

The Codex SDK additionally operates at thread level, not model level: it has no
messages primitive, so it cannot back a `ChatModel` at all.

## Anthropic transport

The portable core already exists in `@ex-machina/opencode-anthropic-auth`, which
has no runtime dependencies and only a shallow coupling to OpenCode's credential
store. It is MIT licensed and authored in-house.

Responsibilities of the decorated fetch:

```text
request
  │
  ├── resolve credential            refresh if expiring
  ├── set Authorization: Bearer
  ├── remove x-api-key
  ├── union anthropic-beta          oauth + interleaved-thinking
  ├── set client user-agent
  ├── add billing/provenance header derived from first user text
  ├── transform system blocks       identity + sanitation
  ├── normalize tool names          client-native casing
  ├── append beta query param
  │
  ▼
upstream
  │
  ├── restore tool naming in stream
  ▼
response
```

Two carry-over decisions worth changing in the port:

1. **Tool naming.** Rather than prefixing tool names on the way out and
   un-prefixing them with a regex over the raw stream, we SHOULD name our
   LangChain tools in the expected casing natively. That deletes the only
   chunk-boundary-fragile code in the whole path.
2. **Refresh margin.** Refresh SHOULD trigger before expiry, not at it.

**Decision 1 is now measured, not merely preferred.**
[Spike 03](./spike-reports/03-anthropic-parity.md) fed both paths the identical
response body and split it differently:

| Chunking | Plugin's regex un-prefixer | Native naming |
|---|---|---|
| Whole body | `echo` — worked | `mcp_Echo` |
| One byte at a time | `mcp_Echo` — **silently failed** | `mcp_Echo` |

The rewriter has no cross-chunk buffering, so a tool name split across two
network reads is never restored and the failure is silent. Native naming has
nothing to break. The port MUST name tools in the client-native convention and
MUST NOT rewrite response bytes.

Decision 2 remains unimplemented: the spike consumed an existing token
read-only and refused anything inside a 15-minute margin rather than refreshing.
The refresh path itself is P3 work.

Additions the plugin does not need but a long-running server does:

- Rate-limit handling that honours `retry-after`.
- Typed auth failures distinguished from transient errors.
- Concurrency limits appropriate to a subscription rather than an API tier.

## Compatibility parity

The subscription path works because requests present a coherent, expected client
profile. If our profile drifts, we do not get a clear error — we get degraded
behaviour or a rejection that looks like something else.

Parity is therefore a **tested property**, not an assumption.

```text
CompatibilityProfile
  profile_id
  client_version
  user_agent
  beta_flags[]
  system_prompt_shape
  tool_naming_convention
  billing_header_algorithm
  query_params
  captured_from            reference client version
  captured_at
```

Verification:

- **Golden fixtures.** Capture reference requests from the known-good client.
- **Differential tests.** Same prompt and tools through both paths; assert
  headers, system block structure, tool shapes, and query params match.
- **Drift detection.** Fail closed on unexpected divergence rather than
  silently sending a novel profile.
- **Pinned profiles.** The active profile is recorded on every run so a
  behaviour change can be correlated with a profile change.

**Verified.** [Spike 03](./spike-reports/03-anthropic-parity.md) implemented all
four and measured them: five request shapes matched the reference exactly, the
complete canonical wire diff was empty, and seventeen independent mutations each
failed closed before dispatch with a specific violation code. The drift
allowlist is committed and **empty**; an entry may not name a path inside the
exact-match projection, which is enforced at load.

Three implementation rules the spike settled:

- **Tool schemas are profile-bearing and MUST be authored as JSON Schema
  literals**, not generated from Zod. Generation injects `$schema` and shifts
  `additionalProperties` across dependency bumps. `$schema`, `$id`, `$defs`, and
  `definitions` are forbidden keys rather than allowlisted ones.
- **Canonicalisation MUST NOT sort or deduplicate arrays, trim, case-fold, drop
  unknown keys, coerce numbers, or redact before comparing.** Each of those can
  hide a real difference. Only header-name casing and JSON object key order are
  non-semantic enough to normalise.
- **The provenance header derives from the first user message in the whole
  history.** A `tool_result` turn serializes as a second `user` message, so a
  multi-turn conversation stays stable — but only while the leading text turn is
  present. A compacted history beginning with a tool result derives the header
  from an empty string, producing a different client fingerprint. The validator
  cannot detect this, because it recomputes from the same messages and is
  self-consistent with the wrong answer. The transport MUST assert the first
  message is a text user turn and MUST NOT send a truncated history.

Honest limits: parity is necessary, not sufficient. The profile is a set of
signals the provider can change unilaterally, and the maintenance model is
re-capturing the reference client on each release. This is ongoing work, and it
is why every agent definition MUST be able to fall back to an API transport.

The oracle is also worth naming precisely: it is an in-house plugin, so parity
against it proves bug-compatibility with a prior hypothesis about the real
client. The live acceptance in spike 03 is the stronger evidence — and it is
evidence about the provider's behaviour *today*.

Anthropic's Agent SDK documentation states that third-party developers need
prior approval to offer claude.ai login or rate limits in their products. This
runtime is personal and internal, not a product offering login to others — but
the distinction matters, the subscription transport stays opt-in, and the
architecture MUST never depend on it exclusively.

## OpenAI transport

Different shape and a different flow. Measured end to end in
[Spike 04](./spike-reports/04-openai-device-auth.md), including a live device
login, refresh, restart, and streaming tool call.

### The device flow is proprietary, not RFC 8628

Do not implement this from the RFC; every one of these differs:

```text
  POST /api/accounts/deviceauth/usercode    not /device_authorization
    → device_auth_id                        not device_code
    → interval is a STRING                  not a number

  POST /api/accounts/deviceauth/token       JSON body, polled
    → HTTP 403/404 mean KEEP POLLING        not authorization_pending
    → returns an authorization code + PKCE verifier, NOT tokens

  POST /oauth/token                          redeems that code for tokens
  POST /oauth/revoke                         revocation
```

Three legs, not two. Treating a 403 as fatal breaks the login entirely. The
`client_id` is a public constant. There is no browser callback and no loopback
listener, which is what makes it container-friendly.

### Transport construction

The Anthropic approach — decorate `fetch` and rewrite the endpoint — does
**not** transfer. OpenAI needs native API selection:

- `useResponsesApi: true` selects both the Responses encoder and decoder. The
  decorator MUST NOT rewrite a Chat Completions body onto `/responses`.
- `configuration.baseURL` points at the subscription endpoint directly.
- `configuration.apiKey` accepts an **async resolver**, called per request. This
  is the OAuth seam; no `BaseChatModel` subclass is needed.
- Constructor `maxRetries: 0`, and `configuration.maxRetries` MUST be absent —
  LangChain's per-request path re-spreads `configuration` without the override,
  silently re-enabling SDK retries.
- The async key setter assigns to a shared client field before headers are
  built, so one client MUST NOT serve concurrent requests with different
  credentials.

Responsibilities:

```text
  ├── resolve credential            async, per request, refresh if expiring
  ├── set Authorization: Bearer
  ├── set chatgpt-account-id        decoded from the id token
  ├── set residency header          config-driven in the reference release
  ├── set originator + version
  ├── strip SDK fingerprint headers x-stainless-*, openai-organization, ...
  ├── restrict to allowed models
  └── omit max output tokens        matches the reference client
```

### Byte parity requires `node:http`

Node's global `fetch` (undici) adds `accept-language` and `sec-fetch-mode` and
neither can be removed through the Fetch API — they are added below any caller
by the Fetch specification's own request algorithm. A transport that needs
byte-level header parity MUST use `node:http`. The SDK seam is unaffected; it
only requires a function returning a `Response`.

### Two operational cautions

- **Do not rely on `x-request-id`.** It is an OpenAI SDK convention that holds
  for `api.openai.com` and does **not** hold for the subscription endpoint,
  which returned no such header. Correlation must not depend on it.
- **Revoke the token the store currently holds**, not one read earlier in the
  request. A resolver can refresh and rotate mid-request; revoking the
  superseded token can succeed while leaving the live session valid.

The subscription endpoint is less documented than Anthropic's, so the OpenAI
transport SHOULD be marked experimental for longer, and the API transport
SHOULD remain the default until parity tests are stable.

## Credential store

One store, provider-namespaced, shared by both transports.

```text
Credential
  provider          anthropic | openai
  type              oauth | api_key
  access_token
  refresh_token
  expires_at
  account_id
  scopes[]
  profile_id        which compatibility profile it was issued under
  created_at, rotated_at
```

Requirements:

- Stored in a dedicated Docker volume, mode `0600`, mounted **only** into the
  control plane.
- Never in Git, the vault, agent context, sandboxes, logs, event payloads, or
  backups in plaintext.
- Refresh MUST be single-flight **per provider**, not globally, and MUST hold a
  cross-process lock. Concurrent refresh against a rotating refresh token causes
  a cascade of 401s.
- The lock holder MUST reread under the lock before refreshing, and adopt a
  peer's newer generation instead of refreshing again.
- Refresh MUST be proactive on a 5-minute expiry margin.
- Rotation MUST be **partial-safe**: the issuer routinely returns a new access
  token and omits the refresh token. Merge each field individually; overwriting
  a stored refresh token with `undefined` strands the credential.
- Rotation MUST be atomic, and the full sequence is load-bearing: temp file in
  the **same directory**, exclusive create at `0600`, `fsync` the file,
  `rename`, then `fsync` the **directory**. No `chmod`, no `truncate` of the
  target.
- Reads MUST tolerate rotation mid-flight and retry once with the new value.
- `retry-after` MUST be clamped; an unclamped value turns a rate limit into an
  outage. Terminal errors (`invalid_grant`, reuse, expiry) MUST NOT be retried.

Verified under `strace` in [Spike 04](./spike-reports/04-openai-device-auth.md)
with 64 concurrent callers producing exactly one upstream refresh, ≥200 crash
iterations at every write boundary, and a negative control proving the checker
rejects unsafe writers. The reference client's own credential file is **not** an
atomicity oracle.
- A separate encrypted export exists for disaster recovery, with the key held
  outside the node.

Persistence across container restarts is not optional. A read-only credential
injection loses the rotated refresh token on exit, which means re-authorizing
on every restart.

## Setup experience

The target is: clone, start, authenticate in a browser, done.

```text
$ agent-runtime auth login anthropic

  Open this URL to authorize:
  https://...

  Paste the authorization code:
  ▏

  ✓ Authorized as <account>
  ✓ Credentials stored
  ✓ Compatibility profile: claude-cli/<version>
  ✓ Verified with a test completion
```

```text
$ agent-runtime auth login openai

  Visit:  https://...
  Enter code:  ABCD-EFGH

  waiting…
  ✓ Authorized as <account>
```

```text
$ agent-runtime auth status

  anthropic   oauth     expires in 6d      profile claude-cli/<version>   ok
  openai      oauth     expires in 21d     profile codex/<version>        ok
```

Anthropic's out-of-band paste-a-code flow is genuinely easier to containerize
than a localhost callback: the browser step can happen anywhere and only the
code comes back. OpenAI's device-code path is the container-friendly equivalent.

Both flows MUST work without a browser inside the container.

## Configuration

```yaml
models:
  default: claude-primary

  providers:
    claude-primary:
      provider: anthropic
      transport: subscription        # subscription | api
      model: <model-id>
      fallback: claude-api

    claude-api:
      provider: anthropic
      transport: api
      model: <model-id>

    gpt-primary:
      provider: openai
      transport: subscription
      model: <model-id>
      fallback: gpt-api
```

Fallback triggers on auth expiry, sustained rate limiting, or a compatibility
drift detection — and MUST be recorded as an event on the run, because a silent
transport switch changes both cost and behaviour.

## Observability

Every run records:

- Provider, model, transport, and compatibility profile id
- Auth type and credential rotation generation
- Request ids where the provider returns them
- Token usage and cache hit metrics
- Rate-limit encounters and backoff
- Any transport fallback, with the triggering reason

## Package layout

```text
packages/model-auth/            provider-neutral
  credential-store              persistence, rotation, atomic writes
  refresh                       single-flight, backoff, skew margin
  fetch-factory                 createSubscriptionFetch({store, rewrite})
  errors                        typed auth and rate-limit failures

packages/anthropic-subscription/
  oauth                         PKCE, exchange, refresh
  rewrite                       headers, system, tools, billing header
  profile                       captured compatibility profile
  model                         ChatAnthropic factory

packages/openai-subscription/
  oauth                         browser + device code
  rewrite                       headers, account id, endpoint
  profile
  model                         ChatOpenAI factory
```

`model-auth` MUST NOT import either provider package. The provider packages
supply rewrite rules; the shared package owns lifecycle.

## Open questions

- How aggressively to throttle concurrent subagents against one subscription.
- Whether compatibility profiles ship in the repository or are captured locally
  at setup time by each user.
- Whether a run may switch transports mid-run or only at start.
- What the runtime does when both the subscription and the API fallback are
  unavailable — fail the run, or park it in `awaiting_input`.
- Whether teammates share a compatibility profile or each capture their own.
