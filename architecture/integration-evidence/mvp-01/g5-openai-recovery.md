# G5 — OpenAI recovery: stock-library integration and live trial

**Outcome: accepted with documented exceptions (2026-10-06).** Recorded under task 14.8 from the reconciliation at
14.7 and the cleanup verification at 23.3. The OpenAI device login was restored and inference was rebuilt on the
stock `ChatOpenAI`; in the Docker/Tailscale deployment a fresh device login, a deliberate renewal, two
read/question/answer/result journeys and a durable cancellation worked, and all nine new OpenAI model requests
succeeded. The owner accepted the trial although the trial report failed one check and no single negative-answer
journey covered every planned condition (see [Exceptions](#exceptions-accepted-by-the-owner)). This is not an
unqualified automated pass, and it is not phase exit: final acceptance of both providers together is still open.

Earlier records stay as they were: the [offline G5](g5-openai-offline.md) and [failed live G5](g5-openai-live.md)
records describe the retired Codex-imitating adapter, and [openai-removal.md](openai-removal.md) its removal.

## Question

After the removal, can OpenAI subscription access be restored through public library configuration — with a
browser-only owner login and the existing guarded execution boundary — so that the interactive journey works live?

## Sources of this record

The recovery ran as a separate, owner-approved plan outside OpenSpec. At the owner's request that plan and its
results file were deleted after acceptance, so this record is reconstructed. Each claim below comes from one of:

- **Conversation** — the recovery conversation's safe observations and the owner's approvals and decisions.
- **Logs** — the five final offline verification logs, still present on the development host.
- **Read-only API (14.7)** — on 2026-10-06, with the owner's approval, GET requests from inside the runtime container
  to its own loopback listener: options, the run list, each run's budget, and the full histories of the five
  recovery runs. No auth or model request was made and nothing in the deployment changed.
- **Container metadata (14.7)** — `docker inspect` of the running runtime container.
- **Source** — the committed tree, checked again at 23.3.

Nothing observed at 14.7 contradicts the conversation's account. Claims resting on the conversation alone are marked.

**Corrected 2026-10-06 (task 25.4), from the observations already retained at 14.7:** the profile and slot were
first attributed to the read-only API, which does not expose them; and the repeat journey's answer time had been
used as its finish time, giving 5 s instead of about 3.4 s before the recreation. No new deployment read was made,
and the outcome, counts and accepted exceptions are unchanged.

## Authorization

All from the conversation:

- The owner chose the minimal TypeScript integration (restore the earlier device login; connect stock
  `ChatOpenAI` and the OpenAI SDK through public settings) and rejected wrappers, gateways, Python, the Codex
  app-server, other engines, provider or API-key fallback, and forks.
- After offline checks, the owner approved: committing the verified tree; recreating only the runtime container of
  `agent-runtime-live` with the new image; changing the OpenAI profile to `codex-responses-v1` and raising the
  deployment ceiling from 18 to 23 (the 11 requests already used plus 12); one owner-performed device login without
  executor observation; one deliberate renewal; the journey and cancellation runs with OpenAI selected, at most 6
  model requests per run and 12 new OpenAI requests in total; and controlled runtime restarts and recreation.
- After answering the first journey's question "yes" by mistake, the owner approved a repeat journey within the same
  allowance. The owner then accepted the trial step with the exceptions below, and accepted the final working state.

## Tested source and image

- Source: commit `dbf71453a0500163e2a8510f23ac4212d7572609`, on a local Graphite branch on top of `da65cab`; not
  pushed or merged. Its scope (43 files) is the restored `providers/openai/` (device auth and refresh, credentials,
  inference configuration, invocation binding) and `service/openai-auth.ts`, the provider assembly, the model
  boundary's completion check (`execution/agent.ts`), the Connect OpenAI panel and routes, `auth openai` commands,
  the acceptance tool's `--provider`/`--ceiling`/`--run` options, and their tests (source).
- Dependencies: `@langchain/openai` 1.6.2 and `openai` 7.28.0 added; `@langchain/core` raised from 1.2.13 to 1.2.14
  (source).
- Image: `agent-runtime/runtime:dbf7145-openai-recovery`, ID
  `sha256:ed0293c95c338ef9359146b079a6c559aa2aa6c7237e15376cdec92f6fb6b8d4` (conversation; the running container's
  image ID matches, container metadata). A scan of the image without network found both adapters and none of the
  retired wrapper's markers (conversation; the same check is part of the container smoke suite).
- Configuration: models OpenAI `gpt-5.6-sol` and Anthropic `claude-opus-5-5`, Anthropic still the default, budget 6
  per run, ceiling 23 (read-only API). Profiles OpenAI `codex-responses-v1` and Anthropic `claude-cli-2.1.280`
  (unchanged), slot `default` (conversation: the rollout's deployment observations; the API does not show profiles
  or slots).

## What the build does

- **Login.** Connect OpenAI shows OpenAI's device page and a short code; the owner approves there and the runtime
  notices by polling. POST-only `/api/v1/auth/openai/{begin,status,cancel}`; no paste-back, callback or completion
  endpoint. Existing credential records were reused without migration.
- **Inference.** Stock `ChatOpenAI` in streaming Responses mode against
  `https://chatgpt.com/backend-api/codex/responses` through the guarded terminal: `store: false` with encrypted
  reasoning replayed, retries off, truthful `agent_runtime` identity and the run as session and thread. No request
  rewriter or stream parser.
- **Completion.** A response is accepted only when the library's parse reports `completed` with no error or invalid
  tool call, checked before sanitation, checkpointing or tool execution; otherwise `provider_failure` /
  `incomplete_response`.
- **Compatibility.** The retired `codex-0.151.0` profile stays unsupported; its runs are readable and never rebound.

## Offline verification

**Recovery build (`dbf7145`), before rollout.** The first verification run stopped when the browser suite failed:
its fixture still configured the retired profile. The owner approved a one-line fixture repair, and all five
commands were then rerun (conversation). Final results (logs):

| Command | Result |
|---|---|
| `mise exec -- bun run check:verify` (forced) | Exit 0; 12/12 tasks, 0 cached. Runtime 432, contracts 17, subscription 61, UI 24, scripts 69 tests |
| `mise exec -- bun test` | 603 pass |
| `mise exec -- bun run test:integration` | 157 pass |
| `mise exec -- bun run test:browser` | 11 pass |
| `mise exec -- bun run test:container` | 12 checks pass |

**Cleanup (23.3), after this reconciliation's reporter and documentation changes**, on `dbf7145` plus uncommitted
changes to the acceptance tool, its tests and current documentation only: forced `check:verify` 12/12, 0 cached
(scripts 75 tests); `bun test` 609; integration 157; browser 11; container smoke 12 checks. No runtime, provider or
dependency file changed. These are separate results, not a rerun of the recovery's.

## Live trial (2026-10-06, `agent-runtime-live`)

**Rollout** (conversation). Only the runtime container was recreated with the new image; PostgreSQL, Tailscale,
the volumes and all recorded runs were kept. Both providers reported ready afterwards.

**Authorization** (conversation). The owner connected OpenAI from the console with a fresh device login
(credential generation 2 → 3), without executor observation of OpenAI's page or the code. One deliberate
`auth openai renew` advanced it to generation 4. Saved authorization survived the runtime restarts and recreation.

**Runs** (read-only API unless marked):

| Run | What happened | Requests |
|---|---|---|
| `d1a1aab4-e757-4e81-b546-1580636e249b` (owner's own, 16:19Z) | Succeeded; before the fresh login, so on the retained generation 2 (generation by chronology, conversation) | 1 |
| `0c7f1bbb-ea5f-48a5-a6b2-7b44fe970525` (owner's own, 16:23Z) | Succeeded; between login and renewal (conversation) | 1 |
| Journey `5d0248ff-6cd4-4311-aaab-87de309828b2` | Completed read of the trial note; one question declaring `"yes"`/`"no"`; stayed waiting through a runtime restart and a recreation (conversation; that container and Docker's events for the window no longer exist); answered `"yes"` by mistake; succeeded with the steps listed | 3 |
| Repeat journey `2e7d0541-a0db-4393-bbd9-001af2b177cf` | Completed read; one question declaring `"yes"`/`"no"`; answered `"no"` at 16:26:10.08Z; succeeded with a reply that declined to list the steps, finishing at 16:26:11.95Z, about 3.4 s before the current container was created (16:26:15.36Z), so it did not wait through a recreation | 3 |
| Cancellation `226d4742-0a3e-4a57-8b7f-ed6222b6b0d0` | No read; one question declaring `true`/`false`; cancelled from the API at 16:27:05Z with its question closed; still cancelled after the restart at 16:27:16Z | 1 |

Every one of these nine model attempts completed `ok`; no request was unconfirmed.

**Request accounting** (read-only API). Deployment: 14 runs, **20 of 23** requests charged, 0 unconfirmed.
OpenAI: 9 runs, 13 requests — the **4** `incomplete_response` failures of the retired adapter plus the **9** new
successful requests above (7 in the three trial runs, 2 in the owner's runs). Anthropic: 5 runs, 7 requests, none new.
So 9 of the 12 new OpenAI requests allowed were used; the trial report's own figure (4, for the repeat journey and
cancellation) is a subtotal of two runs, not the trial's consumption.

## Trial report

The acceptance tool's `report` on the repeat journey and the cancellation exited 1 with "the journey's question was
not answered with false" (conversation): it then accepted only the boolean `false`, and the model had declared the
string choices `"yes"`/`"no"`. The runtime handled the answer as specified; only the reporter's assumption was too
narrow. At 23.2 the reporter was corrected (it can be told to expect a declared `"no"`, matches the answer to the
question, and checks per-run and pair limits). Applied to the captured histories at 14.7, it passes the repeat
journey and cancellation with `--expected-answer no`, still fails them by default, and fails the first journey,
whose answer was `"yes"`. This retrospective result does not turn the original run into an automated pass.

## Credential screening

Count-only pattern scans after the trial found no credential-like matches in the then-current runtime container's
log or in eight runtime and checkpoint tables; a control query found the trial note's text (conversation). This was
a pattern scan, not an exact comparison with the live tokens across every protected surface, and logs of containers
replaced during the trial were no longer available.

## Exceptions accepted by the owner

- The trial report failed (literal `false` versus the declared `"no"`), as above.
- The first journey, which waited through both restart and recreation, received a positive answer; the repeat
  journey, which received the negative answer, finished before the recreation. No single negative-answer journey
  covered both.
- Two of the owner's own runs and a repeated journey ran within the trial's allowance.

## Limitations and open items

- The backend is the one the Codex CLI uses with a ChatGPT sign-in, not a vendor-documented third-party interface;
  it can change without notice. A stream that never finishes is ended by the five-minute full-body deadline.
- The device protocol is project-owned code; the account ID is decoded from the ID token without verifying its
  signature.
- The cause of the retired adapter's four failures was never established; this build does not explain it.
- Not covered here: whether Anthropic's earlier live records apply to this build after the shared `@langchain/core`
  and middleware changes, a rollback to a compatible image, and the requirement-by-requirement final audit. These
  belong to the phase's final acceptance (tasks 15–16).
