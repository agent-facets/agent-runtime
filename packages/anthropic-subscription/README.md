# @agent-runtime/anthropic-subscription

Private, server-only package: Anthropic subscription (Claude Pro/Max) authorization and the request profile that
subscription inference requires. The runtime uses it behind the stock LangChain `ChatAnthropic` model; it is not an
agent loop, a model wrapper or an OpenCode plugin.

It is a minimal, project-maintained derivative of `@ex-machina/opencode-anthropic-auth`. See
[PROVENANCE.md](PROVENANCE.md) for the exact upstream baseline, what was kept and the intentional differences, and
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for the license.

## Boundary

- **No I/O of its own.** Every HTTP exchange goes through a caller-supplied `Transport`, and every operation honors a
  caller `AbortSignal`. The package never calls global `fetch`, never retries and never reads the environment.
- **No credential ownership.** Storage, locking, refresh coordination, generation selection and screening belong to
  the runtime. The package returns validated values and forgets them.
- **Safe failures only.** Failures are an operation plus an allowlisted reason (and an HTTP status when one was
  received). No response bodies, token values or upstream exception text leave the package.
- **Transport-reported delivery.** A transport throws `NotSentError` only when a request certainly never left. Any
  other failure after sending is `outcome_unknown`, because the issuer may already have consumed a refresh token.

Only the public entry (`@agent-runtime/anthropic-subscription`) may be imported. The package depends on no other
workspace package, OpenCode, LangChain or provider SDK, and the browser UI and API contracts must not import it.

## Public surface

| Export | Purpose |
|---|---|
| `beginLogin()` | The authorization URL for the owner to open, and the private state and PKCE verifier to finish with. |
| `exchangeAuthorization(pasted, flow, io)` | Exchanges a pasted callback URL, `code#state` or query form. The state must match the login. |
| `refreshAuthorization(refreshToken, io)` | One refresh request; a response may omit `refresh_token` (keep the current one). |
| `TOKEN_ENDPOINT` | The only destination of token requests, for the caller's transport policy. |
| `CLAUDE_CLI_2_1_280`, `profileFor(id)`, `PROFILE_IDS` | Immutable request profiles, selected by exact ID. |
| `adaptInferenceRequest(request, { profile, accessToken })` | The request to send, or a refusal: `unsupported_endpoint`, `body_too_large`, `invalid_body`, `leading_user_text_required`, `tool_name_not_native`, `tool_schema_not_authored`. |
| `classifyInferenceError(status, body, profile)` | An allowlisted kind for an unsuccessful response, including `client_version_rejected`. |
| `StreamCompletion` | Observes an event stream, unchanged: complete only after `message_stop` with no `error` event. |
| `NotSentError`, `AuthFailure` reasons | The transport contract and the safe failure outcomes (`invalid_input`, `state_mismatch`, `aborted`, `not_sent`, `throttled`, `rejected`, `outcome_unknown`). |

`outcome_unknown` means the request may have reached the issuer; a refresh token used for it must not be sent
again. The runtime turns that into "reauthorization required".

## Tests

`bun test` in this package runs the auth outcomes against a synthetic transport that records every request, and
the request profile against golden fixtures in `test-support/golden/`. Those fixtures are generated from the
upstream implementation itself (`test-support/golden/generate.ts`), not from this package, and differ from
upstream output only by D1. Nothing here contacts a network.

## Status

Implemented and verified offline, with its runtime wiring (`packages/runtime/src/providers/anthropic/`),
registered in the runtime's provider assembly. Its execution-used sources are part of the execution definition of
runs bound to Anthropic, so a change here refuses continuation of paused Anthropic runs. Nothing has been verified
against Anthropic's service.
