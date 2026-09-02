# Spike 04 — OpenAI Device Auth and Transport Parity

**Outcome: pass.** OpenAI device-code login completes inside a container,
persists atomically, refreshes with full token rotation, survives a container
restart, and drives a streaming tool call on a real ChatGPT subscription
through a **stock `ChatOpenAI`** — no `BaseChatModel` subclass, no
response-byte rewriting.

One acceptance criterion measured false: the subscription backend does not
return an `x-request-id` header. That is a correction to an assumption about
provider metadata, not a transport failure, and it is recorded in
[Findings](#the-subscription-backend-does-not-return-x-request-id).

## Question

> Does OpenAI device-code login complete inside a container and refresh?

Three things had to hold, and only the third needed live traffic:

1. The device flow works headless — no browser, no loopback listener.
2. The credential store is correct under concurrency and crashes.
3. The provider *accepts* a stock LangChain client's request.

## Environment

| | |
|---|---|
| Host | Linux, WSL2, x86_64, uid 1000 |
| Docker | Engine 29.0.0 |
| Offline run | `offline-final`, 3 isolated repeats |
| Live run | `live-01`, 3 staged containers |
| Image | `sha256:a28faeb3b8a6a408d51dcf1a18ec221ff7d0659f6fc0a268204a7ddba2364516` |
| Harness | [`spikes/openai-device-auth/`](../../spikes/openai-device-auth/) |

Immutable inputs, verified by digest at build and asserted at run:

| Input | Pin |
|---|---|
| Base image | `node:24.6.0-bookworm-slim@sha256:9b741b28…d9edff` |
| Oracle | `@openai/codex@0.151.0-linux-x64`, `sha512-xcVyY1Ft…DDQ==`, Apache-2.0 |
| Oracle source | tag `rust-v0.151.0`, commit `78c29080…845452` |
| LangChain | `@langchain/openai@1.5.10`, `@langchain/core@1.2.9` |
| OpenAI SDK | `openai@7.8.0`, pinned directly so it cannot float |
| Live model | `gpt-5.6-sol` |

`main` diverges from the release branch at `a9519cbc…`; the released binary is
the oracle, and `main` was used only as a cross-check.

## Method

```bash
./spikes/openai-device-auth/verify-offline.sh          # offline, 3 repeats + syscall stage
./spikes/openai-device-auth/rehearse-live.sh           # full live path, synthetic endpoints
RUN_ID=live-01 ./spikes/openai-device-auth/run-live.sh --init     --yes
RUN_ID=live-01 ./spikes/openai-device-auth/run-live.sh --complete --yes
RUN_ID=live-01 ./spikes/openai-device-auth/run-live.sh --reload   --yes
```

### Three containers, because the restart is the measurement

`--complete` and `--reload` share nothing but a private Docker volume. Loading
a rotated credential in a *different* container is what makes "survives a
restart" a measurement rather than an assertion.

```text
  --init                --complete                --reload
  container A           container B               container C
  usercode request      poll → exchange           read credential
  session → volume      persist (atomic, 0600)    1 model request
  code → stderr only    force exactly 1 refresh   revoke → delete volume
        └──────── private volume, 0700, uid 1000 ────────┘
```

The operator's own credential store is never mounted. The driver digests it in
the shell before each stage and again on every exit path, including failures.

## Acceptance

### Offline — 68/68

| Group | Result |
|---|---|
| Device init, string interval, no browser/listener, 403/404 polling, 15m deadline | Pass |
| PKCE-bound exchange, claim extraction, no persistence on failure | Pass |
| 5-minute refresh margin, partial rotation, typed failures, bounded `retry-after` | Pass |
| 64 concurrent callers → exactly 1 upstream refresh | Pass |
| Single-flight per provider, not global; cross-process; guarded reread | Pass |
| Atomic write: same-dir temp, `fsync`, `rename`, directory `fsync`, `0600` | Pass |
| ≥200 crash iterations at every write boundary, all files valid | Pass |
| Syscall verification under `SYS_PTRACE`, negative control rejects 8 unsafe writers | Pass |
| Wire diff — 0 profile-bearing, 0 unexplained, allowlist empty | Pass |
| Decorator and `useResponsesApi` both proven load-bearing | Pass |
| Streaming tool call parsed across all chunkers; truncated stream not completed | Pass |
| Endpoint allowlists and global-fetch poison fail closed | Pass |
| Network isolated (`ENETUNREACH`), 0 forward attempts, 0 credential mounts | Pass |
| Reproducible and acceptance-stable across 3 runs | Pass |

Three containers produced **one** managed digest:
`25c681671c0baa93c18c81e09ffc6225a792f4505f42e79281222f5b95eb3a2f`.

Thirteen mutation classes were injected and each failed exactly the criterion it
was built to break, then the candidate was restored.

### Rehearsal — 13 scenarios

The full live path, including the real `run-live.sh`, runs against loopback-only
synthetic endpoints under the same container flags. Happy path, revocation
failure and recovery, idle stall, endless drip, store-initiated refresh, model
mismatch, rejected request, evidence leak, missing terminal event, real-init
persistence, volume reuse, blocked removal, and guard refusals.

### Live — 17/18

| Check | Result |
|---|---|
| Device initiated, no browser, no listener, volume fresh `0700` uid 1000 | Pass |
| Polled and exchanged, account claim present | Pass |
| Credential persisted atomically at `0600`, generation 2 | Pass |
| Exactly 1 forced refresh; access **and** refresh token both replaced | Pass |
| Credential survived restart into a fresh container | Pass |
| HTTP 200, genuinely streamed, native tool call parsed | Pass |
| Model returned exactly `gpt-5.6-sol` | Pass |
| Stop reason read off the wire | Pass |
| Usage and timings recorded | Pass |
| Exactly 1 dispatch, 0 retries, 0 refreshes during reload | Pass |
| `max_output_tokens` absent | Pass |
| Endpoint allowlists held; global-fetch poison never fired | Pass |
| Newest refresh token revoked; volume removed | Pass |
| **Provider request id recorded** | **Fail** |

Measured live traffic:

| | Value |
|---|---|
| Device polls / exchanges | 3 / 1, interval `5000 ms` parsed from a string |
| Refresh requests | 1 — new access token *and* new refresh token |
| Model request | `POST https://chatgpt.com/backend-api/codex/responses` |
| Status | `200` |
| Model returned | `gpt-5.6-sol` |
| Stop reason | `completed` |
| Tool calls | 1 × `spike_probe` |
| Chunks | 8 |
| Time to first chunk | 1201 ms |
| Total | 1930 ms |
| Tokens in / out | 145 / 19 |
| Provider request id | **absent** |

Zero leak-scan violations across all evidence. No volume or container remained.
The operator credential stayed mode `600`, digest `fd49d173…`, and was never
mounted.

## Findings

### Device auth is proprietary, not RFC 8628

This is the single most consequential correction. OpenAI's device flow is **not**
the RFC 8628 device authorization grant, and an implementation written from the
RFC would fail on every one of these points:

| RFC 8628 | Measured, `rust-v0.151.0` |
|---|---|
| `POST /device_authorization` | `POST /api/accounts/deviceauth/usercode` |
| `device_code` | `device_auth_id` |
| Poll `/token` with `grant_type=device_code` | `POST /api/accounts/deviceauth/token`, JSON body |
| `interval` is a number | `interval` is a **string** |
| `authorization_pending`, `slow_down` | HTTP **403/404** mean "keep polling" |
| Poll returns tokens | Poll returns an **authorization code + PKCE verifier** |
| — | A second `POST /oauth/token` exchanges that code |

The flow is three legs, not two, and the middle leg hands back a PKCE pair the
client must then redeem. Treating a 403 as fatal — the obvious reading — breaks
the login entirely.

`client_id` is the public constant `app_EMoamEEZ73f0CkXaXp7hrann`.

### OpenAI needs native API selection, not fetch-level rewriting

Spike 03 reached parity with Anthropic by decorating `fetch`. The same approach
does not transfer. `ChatOpenAI` requires:

```ts
new ChatOpenAI({
  model: "gpt-5.6-sol",
  useResponsesApi: true,        // selects BOTH the Responses encoder and decoder
  streaming: true,
  maxRetries: 0,
  maxConcurrency: 1,
  apiKey: SENTINEL_API_KEY,     // constructor guard; the decorator sets Authorization
  zdrEnabled: true,
  configuration: {
    baseURL: "https://chatgpt.com/backend-api/codex",
    apiKey: resolveToken,       // async, called per request
    fetch: decoratedFetch,
    // maxRetries deliberately absent
  },
});
```

`useResponsesApi` is proven load-bearing offline: without it the client emits a
Chat Completions body, and rewriting that body onto `/responses` in a decorator
would be forging a request rather than matching one.

### `configuration.maxRetries` silently re-enables SDK retries

LangChain writes `maxRetries: 0` into the client after spreading
`configuration` — but its **per-request** options path spreads `configuration`
again *without* that override. A `maxRetries` living in `configuration` is
therefore honoured on the request path. Its absence is asserted, not assumed.

### The async API-key setter resolves OAuth per request

`configuration.apiKey` accepts `() => Promise<string>` and is awaited on every
request, which is how a rotating OAuth token reaches the SDK without a subclass.

It assigns to a **shared field** on the client before headers are built, so two
in-flight requests on one cached client can cross-assign tokens. `maxConcurrency: 1`
removes the hazard here; a production port must not share one client across
concurrent requests with different credentials.

### Byte-level header parity is unreachable through `fetch`

Node's global `fetch` (undici) unconditionally adds `accept-language` and
`sec-fetch-mode`. `accept-encoding` and `connection` can be overridden;
these two **cannot be removed through the Fetch API at all** — they are added by
the Fetch specification's own request algorithm, below any caller.

Measured, not assumed: the identical request through `node:http` sends only
`connection`, `content-length`, `content-type`, and `host`. The live request
therefore goes through a `node:http` terminal. The seam is unaffected — the SDK
only needs a function returning a `Response`.

### The subscription backend does not return `x-request-id`

`x-request-id` is the OpenAI SDK's own convention
(`openai/src/core/api-promise.ts:71`) and holds for `api.openai.com`. It does
**not** hold for `chatgpt.com/backend-api/codex`: the live response carried no
such header, and `provider_request_id` is `null`.

The harness treated its presence as an acceptance criterion, so the live run is
a measured negative on that one field. Which header — if any — carries a
correlation id on this endpoint is unknown, because identifying it costs a
second billable request and a second device login.

**A production port must not depend on `x-request-id` for subscription-endpoint
correlation.** Stop reason, model, usage, and timings were all recoverable; the
request id was not.

### The stop reason must be read off the wire

The terminal `response.completed` event is the one field that cannot be
re-obtained after a one-shot billable request, and the client's chunk metadata
is an interpretation of it. The harness tees the response body and parses the
provider's own bytes.

This is load-bearing: a rehearsal scenario that omits only the terminal event
still produces a fully-parsed tool call, and only the wire reader notices that
no stop reason ever arrived.

### Codex's own credential file is not an atomicity oracle

The reference client's store is not crash-safe in the way the runtime needs, so
it was used as a behavioural reference for the *flow* and explicitly not as the
oracle for persistence. The atomic-write contract — same-directory temp,
`fsync`, `rename`, directory `fsync`, `0600` at create, no `chmod`, no
`truncate` — was verified independently under `strace`, with a negative control
proving the checker rejects unsafe writers.

### Residency is config-driven in the release

The pinned release derives `x-openai-internal-codex-residency` from
configuration. OpenCode derives it from a token claim. That is a divergence
between two references, not a defect in either; the harness follows the released
binary and records the difference.

### Revoke the token the store holds now, not the one you read

Found by audit and reproduced in rehearsal before it could bite live. Both token
resolvers call `getAccessToken`, which refreshes inside the 5-minute margin and
rotates the refresh token. Cleanup that revokes the token captured *before*
dispatch can therefore revoke a superseded one, receive a success response, and
then delete the only copy of the live token.

Cleanup now rereads the store immediately before revoking. The live run
confirms it: `refresh_token_revoked: true`.

## Architecture impact

[05-model-authentication.md](../05-model-authentication.md) holds in structure.
Reconciled with measured behaviour:

1. OpenAI device auth is proprietary — three legs, string interval, 403/404 as
   continue, PKCE redemption. The RFC 8628 description is wrong and is replaced.
2. OpenAI parity requires `useResponsesApi: true` plus an explicit `baseURL`,
   not fetch-level endpoint rewriting.
3. `configuration.maxRetries` must be absent; constructor `maxRetries: 0` alone
   is not sufficient.
4. The async `configuration.apiKey` resolver is the OAuth seam, and it is not
   safe to share one client across concurrent differing credentials.
5. Subscription transports that need byte parity must use `node:http`; global
   `fetch` adds two unremovable headers.
6. Credential-store requirements are now measured: 5-minute margin, partial
   rotation, guarded reread, cross-process single-flight per provider, and the
   full atomic-write syscall sequence.
7. Revocation must target the token the store currently holds.
8. Do not rely on `x-request-id` from the subscription endpoint.

No load-bearing decision changes. LangGraph remains the orchestrator; no vendor
agent loop is imported; Codex's agent-loop metadata stays outside transport
parity by design.

## Limitations

This spike does **not** establish:

- **Which header carries a request id**, if any, on the subscription endpoint.
  Identifying it costs another login and another billable request.
- **Rate limiting and failure modes.** No `429`, `5xx`, or `retry-after` from the
  real provider. Retries were disabled everywhere by design.
- **Concurrency against one subscription.** The store's concurrency is measured
  in depth; the *provider's* tolerance of parallel subagents is not.
- **Model breadth.** One model, one turn, one forced tool call. No second turn,
  no tool-result round trip.
- **Long-lived refresh behaviour.** One forced refresh. Nothing about refresh
  over hours, reuse detection, or issuer-side rotation policy.
- **Independent ground truth for the profile.** The oracle is the released Codex
  binary, which is strong evidence about *today* and is frozen per release.
- **apt reproducibility.** Only the base image digest and npm lockfile are pinned.

### Accepted harness limitations

The harness is throwaway and the following were found by audit and consciously
not repaired, because none of them affect the measured result:

- The image id is resolved per invocation from a mutable evidence path rather
  than compared across the three stages.
- There is no cross-invocation marker preventing a second billable request if
  `--reload` is re-run after a retained-volume failure.
- The 60-second wall-clock deadline starts after response headers arrive, not at
  request start.
- `--init` writes a one-line `provenance.ndjson`, so "persists nothing" is
  approximate.
- A dated `gpt-5.6-sol-*` snapshot would be accepted as the expected model.
- Generic fault evidence carries the provider's sanitized error text rather than
  the full structured field set.
- The leak scanner's device-code pattern is `XXXX-XXXX`; real codes are
  `XXXX-XXXXX`. Moot because `--init` discards its output, but miscalibrated.

## Reproducing

```bash
./spikes/openai-device-auth/verify-offline.sh     # offline, --network none, 3 repeats
./spikes/openai-device-auth/rehearse-live.sh      # the live path, synthetic endpoints
```

The offline stage proves its own isolation by attempting an outbound connection
and recording the errno. The entire live path — including the real driver shell,
container flags, private volume, timeouts, revocation, and cleanup — is
rehearsable against loopback-only synthetic endpoints with no traffic and no
credential, which is how it was validated before the real run.

Evidence lands in `tmp/spikes/openai-device-auth/<run-id>/`, git-ignored. No
report or evidence file contains a credential, a prompt, a response body, an
account identifier, or a one-time code.
