# Spike 03 — Anthropic Subscription Parity

**Outcome: pass.** A decorated `fetch` under a stock `ChatAnthropic` produces a
request byte-identical to the reference client's on every compatibility-bearing
path, with **zero** unexplained differences across the whole wire. Anthropic
then accepted that request and completed a streaming tool-calling conversation
on a real subscription credential.

**No `BaseChatModel` subclass was needed.** The architecture's seam holds as
written.

## Question

> Does a decorated fetch from a LangChain client produce a request matching the
> reference profile — and does the provider accept it?

Two gates, and the second was required. Offline parity proves the request *is*
what the reference sends; only a live call proves the provider *accepts* it.
[05-model-authentication.md](../05-model-authentication.md) already says parity
is necessary but not sufficient, so an offline-only pass would have been a
partial result.

## Environment

| | |
|---|---|
| Host | Linux, WSL2, x86_64 |
| Docker | Engine 29.0.0 |
| Offline runs | `parity-20260831T014342Z`, `parity-verify-replay` |
| Live run | `live-20260831T020230Z` |
| Harness | [`spikes/anthropic-parity/`](../../spikes/anthropic-parity/) |

Immutable inputs, all verified by digest at build and asserted at run:

| Input | Pin |
|---|---|
| Base image | `node:24.6.0-bookworm-slim@sha256:9b741b28148b0195d62fa456ed84dd6c953c1f17a3761f3e6e6797a754d9edff` |
| Reference | `@ex-machina/opencode-anthropic-auth@1.8.1`, commit `f9947c0c…`, `sha512-p1kER9dY…/2Q==` |
| LangChain | `@langchain/anthropic@1.5.8`, `@langchain/core@1.2.9` |
| Anthropic SDK | `@anthropic-ai/sdk@0.115.0` |
| Schema runtime | `zod@4.5.4`, pinned directly so it cannot float |
| Reference profile | `claude-cli/2.1.87` |

## Method

```bash
./spikes/anthropic-parity/verify-parity.sh      # offline, 3 isolated repeats
./spikes/anthropic-parity/run-live.sh --yes     # live, 2 provider requests
```

### Two lanes, one client

Both lanes drive the **same** stock `ChatAnthropic`. Only the injected fetch and
the tool naming differ, so a serialization difference between them would be a
real finding rather than an artefact of comparing two different clients.

```text
                    fixture case
                          │
        ┌─────────────────┴─────────────────┐
        ▼                                   ▼
  reference lane                      candidate lane
  tool name: echo                     tool name: mcp_Echo
  fetch: shipped plugin loader        fetch: candidate decorator
        │                                   │
        │  plugin renames -> mcp_Echo       │  nothing renames
        └─────────────────┬─────────────────┘
                          ▼
                  capture sink (never forwards)
```

The reference lane executes the real shipped plugin through its own loader with
a fake OpenCode client and a sentinel OAuth record. **None of its internal
transform functions are imported** — comparing a copy of the oracle against the
oracle would prove only self-consistency.

A third **control** lane runs with no decorator. Its request must differ from
the candidate's, which is what proves the decorator is load-bearing rather than
the SDK doing the work.

## Acceptance

### Offline — 21/21

| Check | Result |
|---|---|
| Inputs pinned, fixtures unmodified, golden reference matches | Pass |
| Fixture binding guards hold | Pass |
| Reference is the shipped plugin loader | Pass |
| No `BaseChatModel` subclass | Pass |
| Decorator is load-bearing vs. undecorated control | Pass |
| Profile projection exact, all 5 cases | Pass |
| Wire diff clean — 0 profile-bearing, 0 unexplained, 0 allowlisted | Pass |
| 17 negative controls fail closed | Pass |
| Non-streaming parsing intact | Pass |
| Streaming intact across 4 chunkers | Pass |
| Truncated stream not silently completed | Pass |
| Native tool names need no rewrite | Pass |
| Reference stream defect reproduced | Pass |
| Network isolated (`ENETUNREACH`), 0 forward attempts | Pass |
| Reproducible and acceptance-stable across runs | Pass |
| No credential in evidence | Pass |

Six containers across two independent runs produced **one** managed digest:
`6583da85b8b4632d…`.

### Live — 24/24

| Check | Result |
|---|---|
| Credential read-only, expiry margin respected, no refresh | Pass |
| Validator gate proven live, gated every request | Pass |
| Budget respected, request count bounded to 2, no retries | Pass |
| Profile headers sent (UA, betas, Bearer, no `x-api-key`) | Pass |
| Both requests HTTP 200 and genuinely streamed | Pass |
| R1 forced tool call, wire-native name, args parsed | Pass |
| Local tool side-effect free | Pass |
| R2 tool result accepted, final text streamed, distinct id | Pass |
| Billing header stable across turns and independently recomputed | Pass |
| Output tokens within cap, usage reported | Pass |

Measured live traffic:

| | Request 1 | Request 2 |
|---|---|---|
| Path | `/v1/messages?beta=true` | `/v1/messages?beta=true` |
| Status | `200` | `200` |
| Request id | `req_011Cea19p1EomJ8GkTjYyViH` | `req_011Cea19uNwRAqqiss4gbKyx` |
| Model returned | `claude-opus-5` | `claude-opus-5` |
| Stop reason | `tool_use` | `end_turn` |
| Tool calls | 1 × `mcp_Echo` | 0 |
| Chunks | 10 | 6 |
| Time to first byte | 666 ms | 570 ms |
| Tokens in/out | 565 / 52 | 501 / 41 |

## Findings

### The seam is exactly what the architecture claimed

```ts
new ChatAnthropic({
  model: "claude-opus-5",
  maxTokens: 256,
  apiKey: SENTINEL,          // constructor guard only; the decorator strips it
  maxRetries: 0,
  clientOptions: {
    fetch: decoratedFetch,
    dangerouslyAllowBrowser: false,
  },
});
```

`clientOptions` is spread verbatim into the Anthropic client for **both** the
streaming and non-streaming paths, so one injected fetch covers both. Message
conversion, tool binding, tool results, streaming deltas, and usage metadata all
stayed with LangChain and all survived unmodified.

### Four operational details the design could not have known

1. **A sentinel API key is structurally required.** `ChatAnthropic` throws
   `"Anthropic API key not found"` without one. It is inert plumbing — the
   decorator deletes `x-api-key` and sets `Authorization` — but it has a useful
   side effect: a non-null `apiKey` disables the SDK's ambient credential
   discovery entirely, so no config file or environment credential can leak into
   an offline run.
2. **LangChain retries six times by default.** The SDK's own retries are already
   hardcoded to zero by LangChain, but `AsyncCaller` defaults to `maxRetries: 6`.
   A single failing request would otherwise fire seven times. `maxRetries: 0` is
   mandatory for any measurement, and prudent for a subscription transport.
3. **`anthropic-dangerous-direct-browser-access` is removable at the source.**
   LangChain hardcodes `dangerouslyAllowBrowser: true`, but it is spread *before*
   `clientOptions`, so `dangerouslyAllowBrowser: false` deletes the header rather
   than requiring a diff allowlist entry for it.
4. **The beta query parameter must not be added twice.** LangChain routes to the
   beta endpoint automatically when `betas` is non-empty, which appends
   `?beta=true` on its own. Passing betas at the model level *and* appending in
   the decorator would double it. Leaving betas off the model and letting the
   decorator append is the shape that matched.

### Native tool naming works, and it deletes fragile code

The architecture proposed naming LangChain tools in Claude-native casing rather
than prefixing on the way out and un-prefixing with a regex over the raw
response stream. That is confirmed, and the spike measured *why* it matters.

The reference plugin's un-prefixer is a regex over decoded response chunks with
no cross-chunk buffering. Feeding both lanes the identical response body:

| Chunking | Reference lane | Candidate lane |
|---|---|---|
| Whole body | `echo` — rewrite worked | `mcp_Echo` |
| One byte at a time | `mcp_Echo` — **rewrite silently failed** | `mcp_Echo` |

The candidate is immune by construction: it never rewrites response bytes, so
there is nothing to break at a chunk boundary. It parsed correctly under all
four chunkers, including one-byte and delimiter-straddling splits, and the live
stream parsed correctly at real network chunk sizes.

This is the single strongest argument for the native-naming decision, and it is
now measured rather than asserted.

### Tool schemas are profile-bearing, so they are authored, not generated

`input_schema` is provider-visible and materially affects behaviour, so it is
inside the exact-match projection. Generating it from Zod would inject
`$schema` and can add or drop `additionalProperties` across dependency bumps —
reproducible, but not *correct*, and it re-drifts on the first upgrade.

The harness authors JSON Schema literals and passes them straight to
`bindTools`. `$schema`, `$id`, `$defs`, and `definitions` are therefore
**forbidden keys** rather than allowlisted ones, and the Zod converter is out of
the trusted computing base of the parity claim entirely.

### The billing header is stable across turns — and that is load-bearing

The provenance header is derived from the **first user message in the whole
history**. A `ToolMessage` serializes to a second `role: "user"` message
containing a `tool_result` block, so the obvious worry is that turn two derives
a different header.

It does not, and the live run confirms it: both requests carried
`cc_version=2.1.87.142; cc_entrypoint=sdk-cli; cch=b42d0;`, identical, and equal
to an independent recomputation from the prompt constant.

**But that holds only because the leading text turn was still present.** If a
compacted or resumed history ever begins with a tool-result message, the
extractor finds no text block, returns `""`, and derives a degenerate header
from the empty string — a different client fingerprint. The profile validator
cannot catch this, because it recomputes from the same messages and is therefore
self-consistent with the wrong answer.

The production port MUST assert that the first message is a text user turn, and
MUST NOT send a truncated history. This is a latent hazard, not a theoretical
one.

### Fail-closed validation is real, and it was proven live

Every transformed request is validated against the active profile before
dispatch; a violation throws with codes and JSON pointers only, never values.
Seventeen mutations — user-agent, beta set, beta order, duplicate beta, missing
and extra query params, reintroduced `x-api-key`, missing and non-Bearer
authorization, unknown header, mutated identity, swapped system order, wrong
billing text, unsanitised system, lowercase tool name, forbidden schema key,
lowercase historical `tool_use` — each fired its specific code **and** dispatched
nothing.

The live probe re-proved the gate immediately before spending quota by running
one mutation against a non-forwarding sink, and it poisoned `globalThis.fetch`
for the duration so any path bypassing the decorated fetch would throw rather
than reach the network. The poison never fired; dispatch count was exactly two.

### The differential is not vacuous

A deliberate mutation test removed one sanitation rule from the candidate — a
change the profile validator does not check. Three cases immediately failed at
`/body/system/2/text` as profile-bearing, while the golden, the validator, and
every other criterion stayed green.

That is the property that matters: gate A catches drift the validator alone
cannot see, and the two mechanisms are genuinely independent.

## Architecture impact

[05-model-authentication.md](../05-model-authentication.md) is correct in
structure and in its two carry-over decisions. Reconciled with measured
behaviour:

1. The exact `ChatAnthropic` construction is now recorded, including the
   sentinel key, `maxRetries: 0`, and `dangerouslyAllowBrowser: false`.
2. Native tool naming is confirmed, with the reference defect as the evidence.
3. Tool schemas are authored literals; generated-schema keys are forbidden.
4. The billing-header history hazard is recorded as a production requirement.
5. The decorator must not append the beta query parameter when the model layer
   already routes to the beta endpoint.

No load-bearing decision changes. The subscription transport stays opt-in and
every agent definition still needs an API fallback.

## Limitations

This spike does **not** establish:

- **Credential lifecycle.** The live probe consumed an existing access token
  read-only and refused anything inside a 15-minute expiry margin. OAuth login,
  refresh, single-flight, rotation, and atomic persistence are all untested —
  that is the P3 credential-store work.
- **Independent ground truth.** The oracle is the in-house plugin, which is a
  prior hypothesis about the real Claude Code client, not an observation of it.
  Passing parity proves bug-compatibility with that hypothesis. The reference
  repository's own captures cover system-prompt text only, not whole wire
  requests. The live acceptance is the stronger evidence, and it is evidence
  about *today*.
- **Durability of the profile.** Anthropic can change the accepted signal set
  unilaterally. `claude-cli/2.1.87`, the beta flags, and the billing algorithm
  are frozen constants that must be re-captured per reference release.
- **Rate limiting and failure modes.** No `429`, `529`, or `retry-after`
  behaviour was exercised. Retries were disabled everywhere by design.
- **Concurrency.** One request at a time. Nothing about parallel subagents
  against one subscription.
- **Model breadth.** One model, `claude-opus-5`, chosen because it is the
  operator's configured model and therefore known-entitled — so an entitlement
  failure could not be mistaken for a transport failure. It is an alias with no
  dated snapshot; the returned model was recorded and matched.
- **apt reproducibility.** Only the base image digest and the npm lockfile are
  pinned.

## Reproducing

```bash
./spikes/anthropic-parity/verify-parity.sh --cleanup          # offline, no network
node --no-warnings --import ./src/mock-provider.ts src/live.ts # live path, synthetic provider
./spikes/anthropic-parity/run-live.sh --yes                    # live, consumes quota
```

The offline stage runs `--network none` and proves its own isolation by
attempting an outbound connection and recording the errno. The live path can be
rehearsed end to end against a synthetic provider with no traffic and no
credential, which is how it was validated before the real run.

Evidence lands in `tmp/spikes/anthropic-parity/<run-id>/`, git-ignored.
`evidence.json` carries the offline acceptance matrix; `live-evidence.json`
carries the live one. Neither contains a credential, a prompt, or a response
body.
