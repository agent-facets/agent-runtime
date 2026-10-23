# OpenAI removal — offline acceptance and rollout

**Outcome: pass (2026-10-06).** Recorded under task 21.10 from tasks 21.6 (offline acceptance) and 21.9 (deployed
checks). The bespoke OpenAI Codex integration was removed from the source and from the running deployment. A
configured OpenAI is now reported as unavailable, Anthropic works as before, and recorded runs and saved
credentials are preserved. This is not a G5 result: no OpenAI journey was attempted, and G5, dual-provider
acceptance and phase exit stay open pending a separately approved replacement.

## Question

Can the OpenAI integration that failed its live journey ([g5-openai-live.md](g5-openai-live.md)) be removed so
that a configured OpenAI is visibly unavailable and makes no auth or model requests, while Anthropic, the shared
safeguards, run history and private credentials stay intact in the real deployment?

## Authorization

- Planning (2026-10-06): the owner chose removal before replacement and approved the proposal, specification, design
  (Decision 11) and task amendments, then the removal-only scope at 20.3.
- 21.7 (2026-10-06): after the offline results, the owner asked for a test of retained-credential screening to be
  added first, and approved committing the verified tree through Graphite, building an image from it and recreating
  only the runtime container of `agent-runtime-live`. No login, renewal, model request, revocation or credential
  change was authorized, and none was made.

## Tested source and image

- Source: commit `c30c9b4`, on top of `de0ec76` (the build that was deployed before). The tested working tree was
  committed unchanged; no commit hook is configured.
- Dependencies: `@langchain/openai` 1.6.0 and `openai` 7.25.0 removed from `packages/runtime/package.json` and
  `bun.lock`. A stale `openai` lockfile entry, kept only because LangSmith lists it as an optional peer, was also
  removed; a clean resolution in a scratch copy produced the same lockfile. No other package changed version.
  `bun install --frozen-lockfile` passes.
- Image: `agent-runtime/runtime:c30c9b4-openai-removal`, ID
  `sha256:7e4d8e936788a9aef5770264954bf3db5eef9a0883d957100b13df06a7a295a3`, built from the committed tree.

## What was removed

- `packages/runtime/src/providers/openai/` (device login and refresh, the `codex-0.151.0` request profile, the
  response-stream checks, the model wiring) and its tests; `service/openai-auth.ts` and its test;
  `tests/support/openai-network.ts`.
- The `/api/v1/auth/openai/*` routes, the Connect OpenAI panel and its CSS, the UI client's provider parameter on
  login calls, and the OpenAI-only browser-contract fields (`awaiting_approval`, `userCode`, `denied`).
- `auth openai login|status|renew`: the command now refuses with an "unavailable" message and exit code 1 before
  reading configuration or credentials.
- From shared code: the terminal's `endAt`/`onIncomplete` hooks and the `streamEvents` diagnostic field (both files
  are again byte-identical to `f95802a`), the device-poll failure classification, and the startup refusals for
  settings only the OpenAI SDK read (`OPENAI_BASE_URL`, `OPENAI_API_BASE`, `OPENAI_ORG*`/`PROJECT*`, `OPENAI_LOG`).
- The OpenAI execution manifest: each build now ships manifests only for the providers it has an adapter for.

## Offline acceptance (21.6)

| Command | Result |
|---|---|
| `mise exec -- bun run check:verify` (forced) | Exit 0; 12/12 tasks, 0 cached. Runtime 377, contracts 17, subscription 61, UI 24, scripts 69 tests |
| `mise exec -- bun test` | Exit 0; 548 pass |
| `mise exec -- bun run test:integration` | Exit 0; 149 pass. After the 21.7 test addition: 150 pass |
| `mise exec -- bun run test:browser` | Exit 0; 10 pass |
| `mise exec -- bun run test:container` | Exit 0; 12/12 checks, including the new image scan |
| `openspec validate mvp-01-interactive-agent-execution --strict`; `git diff --check`; lint | Pass |

New or rewritten checks, all using synthetic credentials and scripted networks that record every request:

- **Configured but unavailable.** With a usable saved OpenAI authorization, options report `integration_unavailable`.
  An API start is refused with `provider_unavailable` and creates no run. An OpenAI default stays the default.
  Inference and token networks see nothing, and the credential file is byte-for-byte unchanged.
- **Retired routes and commands.** Every `/api/v1/auth/openai/*` operation gets the ordinary `404 not_found`, and a
  console from an older build calling one gets the same. `auth openai login|status|renew` refuses even when its
  configuration file is missing (so nothing was read), sends nothing and leaves the saved record unchanged.
- **Console.** With OpenAI selected, the notice says the build has no OpenAI integration, Start is disabled and
  there is no Connect or Reconnect action.
- **History.** OpenAI runs written through the store alone stay readable, finished ones stay finished, and cancelling
  them is refused. Answering a question one left waiting gets `409 continuation_unavailable`: the run closes as
  `run_binding_unavailable`, the stored binding is kept as recorded, and nothing is sent.
- **Screening (added at 21.7).** With OpenAI configured, a goal containing the retained OpenAI access or refresh
  token is refused as `credential_in_input` without being echoed. Nothing is sent and the record is unchanged.
- **Absence.** No package depends on or imports an OpenAI client, and production sources contain none of the
  retired Codex markers. Inside the freshly built smoke image, no file under `/app` contains any of eight retired
  markers (issuer and API hosts, the Codex backend path, the Codex client ID, `deviceauth`, `codex_exec`,
  `x-codex`, `/auth/openai/`). Control: the previously deployed image (`sha256:5c930854…`) contains seven of them.
- **Anthropic regressions.** Unchanged and passing: login, renewal, streaming, tool-result and question replay,
  budgets, cancellation, failed-body handling and the production assembly on the official saver.

## Effect on continuing paused Anthropic runs

Compared with `de0ec76`, the Anthropic execution manifest changes in three shared files (`../contracts/src/auth.ts`,
`src/execution/terminal.ts`, `src/providers/failure-mapping.ts`), and the `openai` package drops out of it (it was
included as LangSmith's optional peer). An Anthropic question waiting at rollout would therefore have become
unanswerable. The definition checks were not weakened to avoid this.

## Rollout (21.8)

- Before rollout, read-only GET requests inside the runtime container found 9 runs (OpenAI 4 failed; Anthropic 4
  succeeded, 1 cancelled), none waiting or active, so no question could be stranded. The same was checked again
  immediately before the change. Options then showed OpenAI `ready` on the old build.
- The image was scanned again in a network-less container: 8 files, no retired markers, manifest providers
  `["anthropic"]`.
- Only `AGENT_RUNTIME_IMAGE` in the deployment's private env file was changed (other settings were compared, not
  printed). Then `docker compose … up -d --no-deps --no-build runtime` recreated only the runtime container.
  PostgreSQL and Tailscale kept running (up 4 days), and the operator configuration was not changed: OpenAI stays
  configured and Anthropic stays the default.

## Deployed checks (21.9)

| Check | Result |
|---|---|
| Runtime container | Image `sha256:7e4d8e93…`, user `bun`, read-only root, `cap_drop: ALL`, `no-new-privileges`, Tailscale network namespace |
| Mounts | `/workspace` and the configuration read-only; only `agent-runtime-live_runtime-state` writable |
| Published ports (runtime, tailscale, postgres) | None |
| Startup diagnostics | `provider_readiness` Anthropic `ready`, OpenAI `integration_unavailable`; `startup_reconciled` count 0 |
| `/readyz` | 200; persistence, agent execution and console ready |
| Options (in-container and over tailnet HTTPS) | Anthropic `ready`; OpenAI `integration_unavailable`; default Anthropic; ceiling 18 |
| Run history | 9 runs as before. The four OpenAI runs (`463b0e10…`, `179d571a…`, `2bcb7952…`, `36447c50…`) read as failed `incomplete_response`, 6 events each |
| Retired route | `GET /api/v1/auth/openai/begin` → 404 `not_found` (a POST without `Origin` is refused earlier, 403, by the request policy) |
| Saved credentials | Both records mode `0600`. The OpenAI record was last modified 2026-10-03T23:57:49Z (its generation-2 renewal), so the rollout did not touch it. Contents were not read |
| Console over `https://agent-runtime-live.boa-beaufort.ts.net` (headless Chrome on the host, via the tailnet) | OpenAI listed as "(integration unavailable)". Selecting it shows "This build has no OpenAI integration, so it cannot run tasks. Signing in would not change that.", disables Start and shows no Connect or Reconnect action. Only `GET` options/runs requests, all 200. One DevTools issue entry reported the content security policy blocking `eval`; no console errors. Nothing was submitted |

A live OpenAI start refusal was not exercised, because no safe live check was approved for it; the refusal is
established by the offline tests and the deployed `integration_unavailable` state. No provider requests were made
during the removal: the deployment total remains 11 of 18 model requests.

## Limitations and open items

- G5 (OpenAI live journey), dual-provider acceptance and phase exit remain open. A replacement needs its own
  approved design (supported library APIs, browser-only owner login), verification and fresh live authorization.
- The renewed OpenAI credential remains in private storage, unused. Its eventual cleanup or revocation is a separate
  owner decision.
- This record covers source, image and deployment checks only. It does not re-run any Anthropic live journey.
