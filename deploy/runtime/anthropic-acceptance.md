# Anthropic acceptance trial — operator checklist

> **Current status (2026-10-06).** This checklist records the local Anthropic trial and its pass conditions. That
> trial passed, as did the later Docker/Tailscale trial; neither result is changed here. Those trials ran under the
> since-removed deployment-wide `modelRequestCeiling`; current builds have no such ceiling, and each trial run now
> requests its six-request budget explicitly. The same tool runs the trial against OpenAI with `--provider openai`.
> The restored OpenAI build's live trial was accepted by the owner with documented
> exceptions ([evidence](../../architecture/integration-evidence/mvp-01/g5-openai-recovery.md)); final acceptance
> of both providers together is still pending.
> Nothing here grants authority for a new trial.

The bounded live trial behind gate G4 (MVP 01 task 12.12). **Do not start it without the fresh authorization
confirmed at task 12.20**, which names the tested build, the model, the credential slot, the authorization
operations (a console login, and renewal as the runtime performs it) and the request allowance. Nothing here grants
that authority. The earlier allowance recorded at 12.11 is suspended and does not carry over.

The trial runs **locally**: the built runtime started directly on the owner's machine, listening only on loopback,
with a dedicated database. Real Tailscale Serve HTTPS and a second-device journey are not part of it; they are
verified separately (task 16.7), and the G4 evidence says so.

The trial's fixture and pass conditions (`tests/acceptance/anthropic-trial.ts`) are tested offline by
`scripts/acceptance-anthropic.test.ts`, run with the repository checks.

## Limits the runtime enforces

The proposal for 12.20 (not an allowance until approved there):

| Limit | Value | Enforced by |
|---|---|---|
| Runs | 2 (journey, cancellation) | The tool starts exactly these, by fixed request IDs; repeating `start` starts nothing new. Start no other runs. |
| Model requests per run | 6 | Each run's own budget, requested explicitly by the tool (`stepBudget: 6`) and recorded with the run; the runtime enforces it durably across restarts |
| Model requests in total | 12 | **Not separately enforced.** It follows from the two runs above; `report` checks the two runs' subtotal. Nothing limits other runs in the deployment, so start none. |
| Retries | Counted in the per-run limit | Every physical request is admitted and counted; there are no hidden retries |

Authorization operations are separate from model requests: one console login if the slot has no usable
authorization, and refresh only as the runtime performs it on use. Connecting makes no model request.

## Setup

1. Build the tested commit (`bun run build`) and use fresh, trial-only storage: a dedicated PostgreSQL database on
   loopback, a private state directory (`0700`) for credentials, and a workspace directory containing only
   `acceptance/trial-note.md` with the text in `tests/acceptance/anthropic-trial.ts` (`TRIAL.note`). Never point it
   at a workspace with real content.
2. Write the operator configuration from `trialOperatorConfig(model, slot)` in that file — the model is the one
   authorized at 12.20 — with `workspace.root` set to the trial directory. It sets no budget: the deployment default
   applies to any other task, and the tool requests six for each trial run.
3. Start the runtime with a clean environment (only `PATH`, `HOME`, `DATABASE_URL`, `RUNTIME_STATE_DIR`,
   `RUNTIME_CONFIG_FILE`, `RUNTIME_PORT`) and `RUNTIME_PUBLIC_ORIGIN` unset, so it answers loopback only:
   `bun --no-env-file packages/runtime/dist/main.js`.
4. Show the owner the console (`http://127.0.0.1:<port>/`) before asking anything of them.

## Connecting the account (owner only)

5. The owner presses **Connect Anthropic**, signs in on Anthropic's page in the new tab, and pastes the code into
   the console. **The executor does not look**: no screenshots, page snapshots or network inspection of Anthropic's
   page, the code field or the login requests while the owner does this. It resumes only when the owner says the
   console shows the account connected.
6. `bun run acceptance:anthropic -- check --origin http://127.0.0.1:<port>` must report the deployment ready. It
   reads options only and sends no model request. A trial name used before this change was recorded without an
   explicit budget, so its fixed request IDs now conflict; use a new `--trial` name.

## The journey

7. `bun run acceptance:anthropic -- start --origin http://127.0.0.1:<port> --trial g4` prints two run addresses.
   This starts real model work.
8. Open the journey run. Confirm the read appears and the question waits.
9. Close the page, then reopen the address: the same question is pending, nothing duplicated.
10. While it waits, restart the runtime process (stop it, start it again with the same storage). Reopen the page:
    still waiting.
11. Answer **No**. Confirm the result appears and the history shows the answer `false`.
12. Open the cancellation run; when its question appears, press **Stop session**. Restart the runtime again and
    confirm the run is still cancelled and its question closed.
13. `bun run acceptance:anthropic -- report --origin http://127.0.0.1:<port> --journey <run> --cancel <run>` must
    end with `trial conditions hold`. It only reads the two named runs (which must differ). It checks that the
    journey's one question offered the expected negative answer as a single choice and that exactly that value was
    accepted for it — the boolean `false` by default; pass `--expected-answer no` only if the question declared the
    string `"no"` instead. It also checks each run's budget is 6 with at most 6 model requests charged (unconfirmed
    ones included), and at most 12 for the two runs together. That total is a **subtotal of the two named runs**:
    requests by any other run, such as a repeated journey or the owner's own tasks, are neither in it nor limited by
    the trial, and each such run has only its own budget.

Record only safe outcomes: the report's lines, run states, the browser used, and the request counts. Never record
tokens, authorization codes, raw provider bodies or the browser's network log.

## Stop conditions

Stop and report — do not retry, start another run or choose a larger limit — if any step fails, the login fails, the
provider refuses the profile or model, a run fails, or a limit is reached. A further attempt needs a new
authorization at 12.20.
