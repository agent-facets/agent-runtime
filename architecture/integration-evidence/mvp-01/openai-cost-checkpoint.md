# OpenAI implementation cost — early checkpoint

**Decision (2026-09-30): proceed; cost is moderate and bounded.** Recorded under task 10.6 from the assessment in
tasks 9.3 and 9.5, which the owner approved with the provider plan, and from the offline OpenAI transport actually
built in task 10.5. The design's second checkpoint, before OpenAI's delivery block (task 13.2), still applies.

## What exists after this block

- The Responses inference transport: stock `ChatOpenAI` (`@langchain/openai` 1.6.0, `openai` 7.25.0) in streaming
  Responses mode through the guarded terminal, with the measured Codex backend profile `codex-0.151.0` implemented
  in the runtime (`packages/runtime/src/providers/openai/`): 362 lines of source (profile and adapter) and 678 lines
  of tests, against 1,049 lines of spike reference transport (`profile`, `candidate`, `canonical`).
- Offline G5 fixtures: two-turn stateless replay (encrypted reasoning, function call and output with matching call
  IDs), allowlisted headers, missing and failed terminal events, redirect refusal, full-body deadline, rotated token
  and account from one generation, typed failures (usage limit, rate limit, authorization, server error), one
  renewal retry, and retry layers.
- **Transport choice: Bun's own `fetch`.** The spike's `node:http` choice came from measuring Node's `fetch`
  (undici), which adds `accept-language` and `sec-fetch-mode`. A loopback capture of Bun 1.3.14's `fetch` shows it
  adds only `accept-encoding`, `connection`, `content-length` and `host`; a test pins this. `node:http` is not used.

Readiness stays `integration_unavailable`: nothing registers the adapter, and OpenAI authorization does not exist.

## Remaining OpenAI work (task 13 onward)

- The proprietary three-leg device flow (usercode, polling where 403/404 mean "continue", PKCE code exchange),
  refresh, and the operator command — about 560 lines of spike reference, with the shared credential coordinator,
  store, lock and no-replay rule already in place.
- Registration, readiness and the deterministic journey through the API and console.
- Live verification with fresh owner authorization: device login, renewal, restart and the previously unproven
  second-turn tool-result round trip.

## Risks

- The profile's body settings (`reasoning`, `text`, `parallel_tool_calls`) and user agent are frozen from one
  capture of one model at Codex 0.151.0; they may need re-capture for the configured model.
- The subscription backend returned no `x-request-id` in the spike; the runtime does not depend on one.
- Completion is read from each event's leading `type`; an event the reader cannot classify is never counted as
  completion, so an unexpected encoding fails closed rather than passing a truncated response.

No finding so far suggests OpenAI is disproportionate; if device authorization turns out to be, the phase is
replanned explicitly, not silently narrowed.
