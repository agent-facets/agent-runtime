# OpenAI device-auth and transport-parity spike harness

Throwaway P0 code. It exists to answer one architectural question, not to ship.
Findings live in
[`architecture/spike-reports/04-openai-device-auth.md`](../../architecture/spike-reports/04-openai-device-auth.md).

**Status: answered, pass.** Offline 68/68 across three repeats on one managed
digest; 13 rehearsal scenarios; and a live run (`live-01`) that logged in with a
real device code, refreshed with full token rotation, reloaded in a fresh
container, made one streaming `gpt-5.6-sol` tool call at HTTP 200, revoked, and
removed its volume. One acceptance criterion measured false — the subscription
endpoint returns no `x-request-id` — which is recorded as a finding.

## The question

> Does OpenAI device-code login complete inside a container and refresh?

Two things had to come with it, because neither is separable from the answer in
practice. A login that cannot be stored durably is not a login, and a token that
cannot produce an accepted request proves nothing. So the harness covers three
areas:

1. The device-code protocol, refresh, and typed failures.
2. The credential store: single-flight, cross-process locking, atomic rotation,
   and crash consistency.
3. Transport-semantic parity between the released Codex client and a decorated
   `fetch` under a stock `ChatOpenAI`.

## The protocol is not RFC 8628

This was the first measured correction, and it invalidates the obvious
implementation:

| | RFC 8628 | What Codex 0.151.0 actually speaks |
|---|---|---|
| Bodies | form-encoded | JSON |
| Poll interval | number | **string** |
| "keep waiting" | `authorization_pending` | HTTP **403 or 404** |
| PKCE | client generates | **server supplies** the pair |
| Deadline | `expires_in` | hard-coded **15 minutes** |

Two deliberate divergences from Codex, both safety-motivated and both reported
rather than smuggled in as parity: an absent interval yields a default instead
of Codex's `0` (which hot-polls), and an unparsable interval is a permanent
failure instead of `0`.

## Three lanes, one client

```text
                       fixture case
                            │
        ┌───────────────────┼───────────────────┐
        ▼                   ▼                   ▼
  oracle lane         candidate lane       control lane
  released Codex      stock ChatOpenAI     stock ChatOpenAI
  binary, loopback    + decorated fetch    no decorator
  provider override                        (also: responses off)
        │                   │                   │
        └───────────────────┴───────────────────┘
                            ▼
                capture sink — never forwards
```

The oracle is the **released binary**, not a transcription of it. None of
Codex's request-building code is imported: comparing a copy of the oracle
against the oracle would prove only self-consistency. If the binary cannot be
run, the lane is recorded as unavailable — never silently replaced by the
harness's own constants, which would be comparing the harness against its own
assumptions.

Four provider settings are load-bearing for the deterministic lane, and each
one is verified in Codex's source rather than guessed:

| Setting | Why |
|---|---|
| `name = "openai"` | what `is_openai()` compares; gates the ChatGPT auth headers |
| base URL ending `/backend-api/codex` | what `supports_codex_backend_routes()` checks |
| `http_headers.version` | a config provider does not inherit the built-in `version` header |
| `supports_websockets = false` | the only supported way to make the lane deterministic |

## Two gates over the same capture

**Gate A — the profile validator.** Every transformed request is checked before
dispatch and throws on any violation. Errors carry violation codes and JSON
pointers only, never values, so a violation report cannot become a credential
or prompt leak.

**Gate B — a complete canonical wire diff.** Every field lands in exactly one of
three classes:

| Class | Treatment |
|---|---|
| exact | compared byte-for-byte |
| volatile | shape and cross-field consistency only — a `thread-id` that disagrees with the body still fails |
| Codex product surface | allowed on the oracle, **forbidden** on the candidate |

The third class is not an allowlist. It names pointers that must appear on
exactly one side, so nothing in it can excuse a candidate-side difference: the
runtime must not impersonate Codex's sandbox and git metadata. The committed
allowlist is empty, and an entry naming a pointer inside the projection is
rejected at load.

Gate B must catch drift gate A cannot see, so one mutation the validator does
not check is applied deliberately and must still be caught. Otherwise the two
gates are not independent and the diff is decorative.

## The credential store

One file and one lock file per provider, under a `0700` directory:

```text
credentials/openai.json     0600
credentials/openai.lock     stable inode, never unlinked
credentials/anthropic.json  0600
```

Splitting per provider is what makes "single-flight per provider" true rather
than aspirational — a shared document would serialise an Anthropic refresh
behind an OpenAI one. Namespace preservation stays real and is asserted by
digesting the sibling file across every crash.

Coalescing is two layers:

```text
in-process promise map   collapses N callers in one process
kernel flock             collapses N processes on one host
```

The lock holder **rereads before refreshing**. If a peer already advanced the
generation and left a usable token, it adopts that token and makes no upstream
call.

The lock is a real `flock(2)` held by a `flock(1)` child. The kernel releases it
when the holder's descriptors close, so a SIGKILL mid-refresh cannot strand it —
no lease, no staleness heuristic, no pid file to go wrong. The lock file is
never unlinked, and inode stability is asserted across the whole run.

Rotation is:

```text
open(temp, O_WRONLY|O_CREAT|O_EXCL, 0600)   same directory
write → fsync(temp) → close
rename(temp, target)
fsync(directory)
```

The mode comes from `open(2)`, not a follow-up `chmod`, so the file is never
briefly world-readable. The directory `fsync` is not optional: without it the
rename is durable only by luck.

## Verified by the kernel, not by the store

A separate `SYS_PTRACE` container traces the write and checks the ordered
sequence from `strace` output. The application's own logging is not evidence: a
store that *reports* calling `fsync` and one that *calls* it are
indistinguishable from inside the process.

The negative control matters as much: a truncate-in-place writer is traced too,
and the checker must reject it.

## Running it

```bash
./verify-offline.sh                # 3 repeats + the syscall stage, no network
./verify-offline.sh --repeats 1    # single measurement
./verify-offline.sh --no-oracle    # build without the 347 MB Codex binary
./verify-offline.sh --cleanup      # remove the image afterwards
```

The build phase has network access. Every measurement phase does not:

```text
--network none   --read-only   --tmpfs /tmp
--cap-drop ALL   --security-opt no-new-privileges
no published ports   no credential mount   unprivileged user
```

Loopback stays up inside that namespace, which is what the synthetic issuer and
the oracle capture server use. Nothing can route anywhere, and isolation is
**measured, not asserted**: the driver attempts a real outbound connection and
records the errno. Running it on a networked host makes `network_isolated`
fail, which is the proof that the check is not a rubber stamp.

## The live gate

Rehearse first. The rehearsal runs **`run-live.sh` itself** — not a copy of it —
against a loopback-only synthetic issuer and Responses endpoint. That
distinction matters: a rehearsal that reimplements the `docker run` invocation
proves nothing about the image pin, the credential tripwire, the volume-reuse
refusal, or the cleanup-versus-retention branch, and the last of those is the
one whose failure destroys the only revocable token.

```bash
./rehearse-live.sh              # no provider traffic, no credential
```

Then the live stages:

```bash
RUN_ID=... ./run-live.sh --init --yes       # one device-code request
RUN_ID=... ./run-live.sh --complete --yes   # poll, exchange, persist, refresh
RUN_ID=... ./run-live.sh --reload --yes     # fresh container: model call, revoke
RUN_ID=... ./run-live.sh --revoke --yes     # recovery only
```

Stages run in separate containers, because the restart is part of what is being
proven: `--reload` shares nothing with `--complete` except the volume.

### Everything goes through node:http, behind an allowlist

Every live request — device init, poll, exchange, refresh, revoke, and the model
dispatch — uses the `node:http` terminal, not global `fetch`. This is not a
style preference: the offline differential measured that undici adds
`accept-language` and `sec-fetch-mode` and that neither can be removed through
the Fetch API, so a fetch-based live run would knowingly send a non-parity
request.

Each transport carries an explicit origin **and** path allowlist, and
`globalThis.fetch` is poisoned for the whole process, so any path that bypasses
them throws instead of reaching the network. Six deterministic guard tests in
the offline suite prove the allowlists refuse foreign origins, unknown paths,
query strings, and half-configured synthetic endpoints — and that live mode
defaults to the real provider rather than to the rehearsal.

### Budgets, measured rather than asserted

One device-code session (15-minute deadline), exactly one refresh, exactly one
model request. Retries are disabled at both the LangChain and SDK layers.
Output tokens are **not** capped, because `max_output_tokens` must be absent to
match the reference; the bound is on request count and time instead.

Refreshes are **counted**, not assumed. `reload` calls `getAccessToken`, which
can refresh on its own inside the expiry margin, so the count is asserted to be
exactly one in `complete` and exactly zero in `reload` — an unbudgeted refresh
would otherwise leave no trace at all.

Two independent time bounds, because they fail differently:

| Bound | Catches | Why the other one misses it |
|---|---|---|
| 20s idle race against the stream | a stalled stream | elapsed-time checks only run when a chunk arrives |
| 60s wall-clock deadline | a stream dripping just inside the idle limit | `ClientRequest#setTimeout` measures socket *inactivity*, not duration |

Both are exercised by the rehearsal: a stalling server aborts at ~21s, and a
server emitting one event every 5s forever aborts at ~60s.

### The stop reason comes off the wire

The live model request is a single, non-repeatable, billable event, so a field
missing from the evidence schema is permanently unrecoverable. The terminal SSE
event is therefore read from a teed branch of the provider's own bytes rather
than from the client's interpretation of them, and `stop_reason`,
`incomplete_reason`, usage, the provider request id, time-to-first-chunk, and
total duration are all required by the acceptance map.

### Credential safety

**The operator's existing credential store is never mounted, read, or written by
any container.** The driver shell digests it before the stage and re-checks the
digest and mode on every exit path, including failures.

Everything the spike creates lives in one private Docker volume, seeded
`0700` and owned by the container user from the image so a fresh volume is
writable unprivileged. `--init` refuses a volume that already exists or is
non-empty.

Every failure after the token exchange attempts revocation before exiting. If
revocation cannot be confirmed the volume is deliberately **kept** and named in
the output — deleting the only revocable token would leave a live session with
no way to end it — and `--revoke` finishes the job later.

The image is pinned **by id**, resolved from the passing offline evidence — and
the driver refuses to go live on evidence with any failing criterion, so three
staged invocations cannot silently run three different builds and none of them
can run on a build that did not pass.

The model is a constant. `SPIKE_LIVE_MODEL` is refused outright, in the driver
and again in the container, and a real run that reports `synthetic: true` is a
hard fault. `IMAGE_ID` is likewise refused in a live run — the image comes from
passing offline evidence or not at all; only `--rehearsal` may inject one.

A real `--init` persists **nothing**. Its acceptance lines are printed to the
terminal and the emission is discarded; only the rehearsal keeps a sanitized
counters-only summary, because something has to be asserted against there.
Operational output is redacted before it reaches any log, and the leak scan
covers every artifact rather than only evidence JSON — the one-time code first
surfaced in an operational log that a JSON-only scan could not see.

Every failure after the token exchange records what cleanup actually achieved —
`refresh_token_revoked`, `state_removed`, `revocation_attempted` — in the fault
JSON itself. A revocation announced only on stderr is invisible to the driver,
which would then retain a volume whose token is already dead, indistinguishable
from one that still needs recovering.

Fault evidence goes through the same leak scan as everything else. It is the one
artifact that embeds an unbounded, provider- and SDK-controlled string, and it is
persisted on the stage that cannot be repeated — so it is not exempted. The
driver then scans the whole run directory itself: the container can only check
what it emits, and a second, outside pass is what covers the rest. A hit exits 4
and quarantines the directory regardless of how the stage itself ended.

The raw init emission is removed by an `EXIT` trap rather than on the success
branch, because every refusal, `ERR` exit, and SIGINT between writing it and
reaching that branch would otherwise leave it behind.

The image is pinned by id; the shell orchestrating it is not. Its `sha256` is
recorded in `provenance.ndjson` alongside the image id at every stage, so the
gap is at least visible.

## Secrets

No real credential exists anywhere in the offline stage. Sentinels are
structurally valid and unmistakably fake (`SPIKESENTINELACCESS-0001`,
`SPIKESENTINELREFRESH-0001`). With `--network none` there is no upstream to
reject them.

Comparison happens on unredacted in-memory values; redaction applies only on the
way to disk. The container prints one JSON object and scans it for
credential-shaped material *before* printing, so a leak never reaches disk; the
driver then scans the whole run directory independently. A hit quarantines the
directory and exits 4.

## Evidence

```text
tmp/spikes/openai-device-auth/<run-id>/
  evidence.json        offline acceptance matrix and summary
  run-N.json           full per-container measurement
  digest-N.txt         managed canonical digest per run
  acceptance-N.json    per-run acceptance, compared across runs
  syscall.json         kernel-trace findings
  scan.json            secret-scan result
  live-*.json          live acceptance (live runs only)
  provenance.ndjson    image id and driver digest, one line per stage
  build.log
```

Live evidence records status codes, request ids, stop reasons, chunk counts,
timings, and token usage. It never records the credential, the account id, the
one-time code, the prompt, the response text, raw headers, or raw bodies.

## Exit semantics

A reproducible negative is a valid spike result. A broken harness is not.

| Code | Meaning |
|---|---|
| `0` | every acceptance criterion held in every repeat |
| `1` | **measured negative** — a complete, trustworthy measurement disagreed |
| `2` | usage error |
| `3` | **harness fault** — the measurement cannot be trusted |
| `4` | sanitization violation; evidence quarantined |

## Pinned inputs

See [`fixtures/manifest.json`](./fixtures/manifest.json) for integrity hashes.

| Input | Pin |
|---|---|
| Base image | `node:24.6.0-bookworm-slim@sha256:9b741b28148b…edff` |
| Oracle | `@openai/codex@0.151.0` (+ `0.151.0-linux-x64`), tag `rust-v0.151.0`, commit `78c29080…` |
| LangChain | `@langchain/openai@1.5.10`, `@langchain/core@1.2.9` |
| OpenAI SDK | `openai@7.8.0`, pinned directly so it cannot float |

npm SLSA provenance binds the released Codex artifact to that source tag.
`package-lock.json` is committed and installed with `npm ci --ignore-scripts`.

## Known limitations

- **`main` is not the oracle.** Codex `main` (`a9519cbc…`) diverges from the
  release tag in `instructions` text and tool specs, so it is usable only for
  non-body cross-checks. The tag is authoritative.
- **The id token's signature is not verified**, only decoded. Acceptable for a
  spike; a production gap.
- **apt packages are not pinned** — only the base image digest and the npm
  lockfile.

Found by audit before the live run and deliberately not repaired, because none
of them changes the measured result:

- The image id is resolved per invocation from a mutable evidence path rather
  than compared across the three stages, so the three staged containers are
  bound to one build by convention, not by enforcement.
- Nothing in the volume records that a billable dispatch already happened, so
  re-running `--reload` after a retained-volume failure would issue a second
  model request.
- The 60-second wall-clock deadline starts once response headers arrive, not at
  request start; a slow header phase is bounded only by socket inactivity.
- `--init` appends one line to `provenance.ndjson`, so "a real init persists
  nothing" is approximate.
- `model_is_expected` accepts a dated `gpt-5.6-sol-*` snapshot, which is wider
  than the exact match the plan called for.
- Generic fault evidence carries the provider's sanitized error text instead of
  the full structured field set the success path emits.
- The leak scanner's device-code pattern is `XXXX-XXXX`, but real codes are
  `XXXX-XXXXX`. Moot in practice — `--init` discards its emission — but the
  pattern would not have caught a persisted real code.
- **One model.** Breadth across models and long conversations is untested.
