# Anthropic parity spike harness

Throwaway P0 code. It exists to answer one architectural question, not to ship.
Findings live in [`architecture/spike-reports/`](../../architecture/spike-reports/).

## The question

> Does a decorated `fetch` from a stock LangChain client produce a request
> matching the reference profile?

## Two lanes, one client

Both lanes drive the **same** stock `ChatAnthropic` with the same model
settings. Only the injected fetch and the tool naming differ, so a serialization
difference between them would be a real finding rather than an artefact of
comparing two different clients.

```text
                    fixture case
                          │
        ┌─────────────────┴─────────────────┐
        ▼                                   ▼
  reference lane                      candidate lane
  tool name: echo                     tool name: mcp_Echo
  fetch: shipped plugin               fetch: candidate decorator
        │                                   │
        │  plugin renames -> mcp_Echo       │  nothing renames
        └─────────────────┬─────────────────┘
                          ▼
                  capture sink (never forwards)
```

A third **control** lane runs with no decorator at all. Its request must differ
from the candidate's, which is what proves the decorator is load-bearing rather
than the SDK doing the work.

The reference lane executes the real shipped plugin
(`@ex-machina/opencode-anthropic-auth@1.8.1`) through its own loader, with a
fake OpenCode client and a sentinel OAuth record. None of its internal transform
functions are imported: comparing a copy of the oracle against the oracle would
prove only self-consistency.

The fixtures include OpenCode-branded prompt text. Its license and the reference
plugin's license are in
[`THIRD_PARTY_NOTICES.md`](../../THIRD_PARTY_NOTICES.md).

## The deliberate asymmetry

Inputs differ before transformation and must be identical after it. That is the
whole point — but it is also the one place the harness could become a
tautology, so four guards constrain it:

| Guard | Prevents |
|---|---|
| Logical and wire names are each unique | Two tools aliasing on the wire |
| Candidate input name equals the expected wire name | The candidate quietly renaming |
| At least one reference name differs from its wire name | A no-op oracle |
| Wire names match the profile's casing convention | Silent convention drift |

## Running it

```bash
./verify-parity.sh                # offline: 3 isolated repeats, no network
./verify-parity.sh --repeats 1    # single measurement
./verify-parity.sh --cleanup      # and remove the image afterwards
```

## The live gate

Offline parity proves the request *is* what the reference sends. Only a real
call proves the provider *accepts* it, so the spike is complete only when both
gates pass.

```bash
# rehearse the entire live path with a synthetic provider: no traffic,
# no credential, every layer below the network exercised
node --no-warnings --import ./src/mock-provider.ts src/live.ts

./run-live.sh --yes               # THIS CONSUMES SUBSCRIPTION QUOTA
```

Two streaming requests, capped at 256 output tokens each, retries disabled at
every layer. The credential is bind-mounted read-only and the container runs as
its owner. The probe never refreshes, rotates, copies, or emits it, and refuses
any credential inside a 15-minute expiry margin.

Before spending quota the probe proves its own gate is armed: it runs one
mutation against a non-forwarding sink and requires the violation to fire with
nothing dispatched. It also replaces `globalThis.fetch` with a poison function
for the duration, so any path bypassing the decorated fetch throws instead of
reaching the network.

`run-live.sh` refuses to run without `--yes`.

The build phase has network access. The measurement phase does not:

```text
--network none   --read-only   --tmpfs /tmp
--cap-drop ALL   --security-opt no-new-privileges
no published ports   no credential mount   unprivileged user
```

`--network none` is not only a safety control, it is the primary determinism
control: nothing timing-dependent can enter a capture because nothing
timing-dependent happens. It also makes sentinel credentials free — there is no
upstream to reject them.

Isolation is **measured, not asserted**: the driver attempts a real outbound TCP
connection and records the errno. Running the driver on a networked host makes
`network_isolated` fail, which is the proof that the check is not a rubber
stamp.

## What is compared

Two gates over the same captured pair.

**Gate A — exact profile projection.** Method, host, path, ordered query pairs,
authorization scheme, `x-api-key` absence, `user-agent`, ordered `anthropic-beta`
values, the full ordered `system[]` array, tool definitions including schema
bytes, replayed `tool_use` names, model, `max_tokens`, and `stream`. Compared
with plain structural equality — no matchers, no tolerances.

**Gate B — complete canonical wire diff.** Every remaining difference is
classified `profile-bearing`, `client-serialization`, `volatile-transport`, or
`unexplained`. Profile-bearing and unexplained both fail. The allowlist is
committed and **empty**: an entry may not name a pointer inside the projection,
which is checked at load, so gate B can never weaken gate A.

Canonicalisation is deliberately narrow — lowercase and sort header *names*,
sort JSON object *keys*. Sorting or deduplicating arrays, trimming, case
folding, dropping unknown keys, coercing numbers, and redacting before
comparison are all forbidden, because each of them can hide real drift.

Tool schemas are profile-bearing and are authored as **JSON Schema literals**
passed straight to `bindTools`. No Zod-to-JSON-Schema converter runs, so
`$schema` never appears and needs no allowlist entry — it is forbidden instead.

## Fail-closed validation

The candidate validates every transformed request against the active profile
*before* dispatch and throws on any violation. Errors carry violation codes and
JSON pointers only, never values, so a violation report can never become a
credential or prompt leak.

Seventeen negative controls mutate one profile-bearing field each and assert the
specific violation code fires **and** that nothing was dispatched.

## Secrets

No real credential exists anywhere in the offline stage. Sentinels are
structurally valid and unmistakably fake:

```text
api key   sk-ant-api03-SENTINEL-…
access    sk-ant-oat01-SENTINEL-…
refresh   sk-ant-ort01-SENTINEL-…
```

Comparison happens on unredacted in-memory values; redaction is applied only on
the way to disk. The container writes nothing — it prints one JSON object to
stdout — and the driver scans the whole run directory for sentinels,
key-shaped strings, plaintext bearer tokens, JWTs, and host paths before
reporting. A hit quarantines the directory and exits 4.

## Evidence

```text
tmp/spikes/anthropic-parity/<run-id>/
  evidence.json      offline acceptance matrix and summary
  run-N.json         full per-container measurement
  digest-N.txt       managed canonical digest per run
  acceptance-N.json  per-run acceptance, compared across runs
  repeat.diff        present only when runs disagree
  live-evidence.json live acceptance matrix (live runs only)
  scan.json          secret-scan result
  build.log
```

Live evidence records status codes, request and response ids, stop reasons,
chunk counts, timings, token usage, and the billing header. It never records the
credential, the prompt, the response text, raw headers, or raw bodies.

## Exit semantics

The distinction that matters: a reproducible negative is a valid spike result,
a broken harness is not.

| Code | Meaning |
|---|---|
| `0` | Every acceptance criterion held in every repeat |
| `1` | **Measured negative** — a complete, trustworthy measurement disagreed |
| `2` | Usage error |
| `3` | **Harness fault** — the measurement cannot be trusted; fix and re-run |
| `4` | Sanitization violation; evidence quarantined |

## Pinned inputs

| Input | Pin |
|---|---|
| Base image | `node:24.6.0-bookworm-slim@sha256:9b741b28148b…edff` |
| Reference | `@ex-machina/opencode-anthropic-auth@1.8.1` (`f9947c0c…`) |
| LangChain | `@langchain/anthropic@1.5.8`, `@langchain/core@1.2.9` |
| Anthropic SDK | `@anthropic-ai/sdk@0.115.0` |
| Schema runtime | `zod@4.5.4`, pinned directly so it cannot float |

`package-lock.json` is committed and installed with `npm ci --ignore-scripts`.

## Known limitations

- **The offline lanes prove request shape only.** Whether the provider accepts
  the profile is a separate, gated stage — `run-live.sh --yes`, which was run
  and passed. Live results are in the
  [spike report](../../architecture/spike-reports/03-anthropic-parity.md).
- **The oracle is in-house.** The plugin is a prior hypothesis about the real
  client, not an independent observation of it. Passing parity proves
  bug-compatibility with that hypothesis. The repository's own captures cover
  system prompt text only, not whole wire requests.
- **Sentinel credentials only.** Nothing here exercises refresh, rotation,
  single-flight, or expiry.
- **apt packages are not pinned** — only the base image digest and the npm
  lockfile.
- **Deviation from the approved proposal.** The proposal named Vitest and
  `test/*.test.ts`. The harness instead computes an acceptance matrix in a
  single driver, matching the Obsidian spikes' shape and removing the
  Vite/Vitest dependency tree. Assertion coverage is unchanged.
