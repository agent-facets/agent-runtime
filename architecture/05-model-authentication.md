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

Honest limits: parity is necessary, not sufficient. The profile is a set of
signals the provider can change unilaterally, and the maintenance model is
re-capturing the reference client on each release. This is ongoing work, and it
is why every agent definition MUST be able to fall back to an API transport.

Anthropic's Agent SDK documentation states that third-party developers need
prior approval to offer claude.ai login or rate limits in their products. This
runtime is personal and internal, not a product offering login to others — but
the distinction matters, the subscription transport stays opt-in, and the
architecture MUST never depend on it exclusively.

## OpenAI transport

Same shape, different flow. ChatGPT/Codex authentication uses OAuth with two
paths — a browser callback and a device code — and the device path is the one
that works in a container.

Responsibilities:

```text
  ├── resolve credential            refresh if expiring
  ├── set Authorization: Bearer
  ├── set account id header         decoded from the id token
  ├── set residency header          when the claim is present
  ├── rewrite endpoint              subscription responses endpoint
  ├── restrict to allowed models
  └── omit max output tokens        matches the reference client
```

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
- Refresh MUST be single-flight per provider. Concurrent refresh against a
  rotating refresh token causes a cascade of 401s.
- Rotation MUST be atomic: temp file, fsync, rename.
- Reads MUST tolerate rotation mid-flight and retry once with the new value.
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
