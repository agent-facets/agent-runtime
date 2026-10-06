# G5 (live) — OpenAI journey in the shipped deployment

**Outcome: fail (2026-10-03 and 2026-10-05).** Recorded on 2026-10-06 under task 21.5, after the owner chose to
remove the OpenAI integration (design Decision 11). Login, renewal and restart/recreation worked against the real
service; every real model request (four, in four runs) failed as an incomplete response. The cause was not
recorded. The cancellation journey was never started. This record does not complete task 14.7 or G5, and it is not
evidence about any replacement integration.

## Question

Does the shipped deployment, with OpenAI configured, accept an owner-performed console device login, renew it, keep
it across restart and recreation of the runtime container, and run the real read/question/answer/result journey and
a cancellation within the authorized request cap?

## Authorization

- 14.6 (granted 2026-10-03): the commit of the 14.5-verified tree, deployed by recreating only the runtime container
  of `agent-runtime-live` on its existing volumes, with OpenAI added to its configuration (model `gpt-5.6-sol`,
  profile `codex-0.151.0`, slot `default`) and the deployment ceiling raised by 12 to 18. One owner-performed
  Connect OpenAI device login from the laptop, without executor observation of OpenAI's page or the code entry; one
  forced `auth openai renew`; runtime restart and recreation; the `TRIAL` note with its journey and cancellation goals
  on OpenAI, driven by the executor in a headless browser while the owner watched; at most 6 model requests per run
  and 12 for OpenAI in total, retries included; stop on any failure, refusal or exhausted limit, with no rerun. Also
  granted: one `auth anthropic renew` in the deployment.
- Attempt 2 (2026-10-05): after an owner-approved correction (below), the owner re-authorized the same bounded
  journey on the corrected build.

## Tested builds

| Attempt | Source | Runtime image |
|---|---|---|
| 1 (2026-10-03) | `a5e15f7` | `sha256:e3efab3882df1d62020c8a54d90b3f4dd7e5532bf3acf191aadd8fcdc22ab30a` |
| 2 (2026-10-05) | `de0ec76` | `sha256:5c930854f139058bc1b4e845e28939c59f96fc7f8b98c41b6e2e2d0194e17887` |

Deployment: Compose project `agent-runtime-live` at `https://agent-runtime-live.boa-beaufort.ts.net` (tailnet only,
no published ports), as recorded in [g4-anthropic-docker-tailnet.md](g4-anthropic-docker-tailnet.md). Each attempt
recreated only the runtime container on the existing volumes; both logins were kept between attempts.

## Results

| Step | Result |
|---|---|
| Owner connects OpenAI from the laptop (device login) | Ready, generation 1; one `provider_login_connected` diagnostic |
| `auth openai renew` (one token request, no model request) | Renewed, generation 1 → 2: a real OpenAI renewal |
| Runtime restart, then recreation | OpenAI still ready without logging in again |
| `auth anthropic renew` (one token request, no model request) | Renewed, generation 2 → 3: the first real Anthropic renewal |
| Attempt 1 journey run `463b0e10-8f47-4279-a377-b21522872170` | **Failed** on its first model request: an HTTP response was received, the attempt completed `failed`, and the run failed `provider_failure` / `incomplete_response` ("ended before it was complete; partial output was not used"). 1 request, 0 unconfirmed; no assistant output stored |
| Attempt 1 cancellation run | Not started (the trial stopped at the failure) |
| Owner's own OpenAI runs from the laptop, on the attempt-1 image (`179d571a…`, `2bcb7952…`) | Both failed the same way, 1 request each. One owner Anthropic run between the attempts succeeded |
| Attempt 2 journey run `36447c50-dbfc-45e9-828c-4fa32093ebf5` | **Failed** the same way on its first request: `provider_failure` / `incomplete_response`, 1 request, 0 unconfirmed. No `model_stream_incomplete` diagnostic was written. The response's content type and body shape were not recorded |
| Attempt 2 cancellation run | Not started |

Request counts at the end: OpenAI 4 (2 trial, 2 owner), all failed with `incomplete_response`; deployment total 11
of the 18-request ceiling.

## Correction between the attempts

After attempt 1 the owner approved a narrow change (`de0ec76`), based on read-only reading of the Codex 0.151.0 and
0.160.0 sources: end the response at `response.completed`, as Codex does, instead of failing on any event after it,
and log a `model_stream_incomplete` diagnostic listing only received event names when a response is judged
incomplete. Offline verification before attempt 2: forced `check:verify` 12/12 (none cached; runtime 443 tests),
integration 152, browser 11, container smoke 11. No provider request was made. The request profile was not
re-captured.

## Cause

Not established. Attempt 2 wrote no event-name diagnostic, so the response was not judged incomplete by the event
check. Later read-only source inspection and synthetic in-memory probes showed that a valid event stream labelled
with a content type other than `text/event-stream`, or with none, reproduces this failure without that diagnostic
(the runtime's wrapper treated any other successful body as incomplete), while the stock OpenAI SDK accepts the
same bytes. Public Codex sources do not require that content type on a successful stream. This shows a compatibility
mismatch in the removed wrapper. It does not show what the live responses actually carried, so it is a hypothesis,
not the recorded cause.

## What this establishes

- The reimplemented device login and refresh worked against the real issuer, from a browser-only laptop, and the
  credential survived restart and recreation of the runtime container.
- A real renewal occurred for both providers (OpenAI 1 → 2, Anthropic 2 → 3).
- No real OpenAI model request completed through the Codex-emulating integration on either build.

## Limitations and open items

- The OpenAI read/question/answer/result journey, its second-turn tool-result path and the cancellation journey were
  never observed live.
- Response headers and body shape were not recorded, so the failure cannot be attributed.
- No credential scan of the deployment is recorded for these attempts.
- The integration was removed on 2026-10-06 (design Decision 11). G5 and the final dual-provider acceptance stay open
  until a separately designed and authorized replacement passes; no allowance granted for these attempts carries
  over. The renewed OpenAI credential remains in the deployment's private storage, unused.
