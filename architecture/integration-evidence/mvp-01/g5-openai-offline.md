# G5 (offline) — OpenAI transport

**Outcome: pass (2026-09-30), offline transport only.** Recorded under task 10.10 from the task 10.9 verification.
OpenAI authorization (device login, renewal) is not implemented, so OpenAI remains `integration_unavailable`; the
live part of G5 — device login, renewal, restart and the two-turn tool-result journey against the subscription
backend — is outstanding (tasks 13–14). Nothing here was sent to OpenAI.

## Question

Under Bun, does stock `ChatOpenAI` in streaming Responses mode, through the guarded terminal with the measured
Codex backend profile, send only the profile's headers and body settings; replay encrypted reasoning and function
calls statelessly with matching call IDs; take token and account from one credential generation; use a response
only after `response.completed`; refuse redirects; honor the full-body deadline; keep failures typed; and keep every
retry layer off? Which terminal transport should it use?

## Tested build

As in [g2-anthropic-boundary.md](g2-anthropic-boundary.md) (source prefix `099b8d50e005b31f`, Bun 1.3.14). Model
packages: `@langchain/openai` 1.6.0 with `openai` 7.25.0. Profile `codex-0.151.0` (measured in spike 04 against
Codex `rust-v0.151.0`). Provider requests: **0**.

## Method

- **Profile unit tests** (`packages/runtime/src/providers/openai/profile.test.ts`, 11): request adaptation,
  completion detection over `data:`-only and `event:` streams at several chunk sizes, error classification.
- **Offline journey** (`inference.test.ts`, 13): the real agent, terminal and coordinator with a fake network
  streaming Responses events (`data:` lines, as the backend was observed to send) one byte per chunk, and a fake
  credential issuer.
- **Transport capture** (`transport.test.ts`, 1): Bun's `fetch` sends a profile request to a loopback raw socket
  and the request head is parsed.

## Results (task 10.9)

All 25 tests pass, within forced `check:verify` and direct `bun test`.

- **Headers** are rebuilt from an allowlist: `accept: text/event-stream`, content type, bearer authorization, the
  account header, `originator: codex_exec`, `version: 0.151.0`, the profile user agent, consistent session/thread/
  request IDs and the model routing hint. No `x-stainless-*`, sentinel key, organization or project header is sent,
  even with `OPENAI_API_KEY` and `OPENAI_ORGANIZATION` set in the environment.
- **Body**: `store: false`, `stream: true`, `tool_choice: auto`, `include: ["reasoning.encrypted_content"]`,
  `parallel_tool_calls: false`, the captured `reasoning` and `text` settings, `strict: false` on flat function
  tools, and none of the parameters the reference never sends; a request for another model, a nested
  Chat-Completions tool or generated schema keys is refused unsent.
- **Replay.** Turn two replays the encrypted reasoning item unchanged and the function call and its output with
  call ID `call_01`.
- **Coherent credentials.** After a rotation the request carries the new generation's token and account together;
  a 401 renews once, retried as a counted request.
- **Completeness.** Complete tool arguments without `response.completed`, and a `response.failed` event, fail the
  run as `incomplete_response` with its attempt and store no assistant message; a nested or late-placed
  `response.completed` is never taken for completion.
- **Other failures.** A 307 is refused, not followed; a body stalled past the deadline fails as `request_timeout`;
  429 `usage_limit_reached` is `quota_exhausted` with `retry-after`, 429 `rate_limit_exceeded` `rate_limited`,
  403 `authorization_rejected`, 502 `provider_unavailable` — each sent once with its attempt.
- **Retry layers.** A control shows `maxRetries` inside `configuration` reaching the request path; the factory sets
  none there, and its model sends one request on a 500.
- **Transport.** Bun 1.3.14's `fetch` adds only `accept-encoding`, `connection`, `content-length` and `host` —
  not the `accept-language` and `sec-fetch-mode` that Node's `fetch` added in spike 04. **Bun's `fetch` is
  selected; `node:http` is not used.**

### Negative controls

| Mutation | Detected by |
|---|---|
| One SDK header passed through the allowlist | offline journey (wire test) |
| No Responses completion check | offline journey |
| `strict` left `null` | offline journey |
| Account not taken from the token's generation | offline journey (rotation test) |

## Limitations and open items

- The body settings and user agent are frozen from one capture of one model at Codex 0.151.0 and may need
  re-capture for the configured model; the live G5 will show whether the backend accepts them.
- No OpenAI device login or refresh exists; the credential issuer here is a fake.
- The previously unproven second-turn tool-result round trip is established offline only.
