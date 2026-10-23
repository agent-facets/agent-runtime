# Anthropic acceptance trial — operator checklist

The bounded live trial behind gate G4 (MVP 01 task 12.12). **Do not start it without the fresh authorization
confirmed at task 12.11**, which names the model, the credential slot, the second tailnet device, the
authorization operations and the request allowance. Nothing here grants that authority, and no earlier allowance
carries over.

The trial is rehearsed offline with the same fixture and pass conditions
(`tests/browser/acceptance-rehearsal.browser.test.ts`, run by `bun run test:browser`).

## Limits the runtime enforces

| Limit | Value | Enforced by |
|---|---|---|
| Runs | 2 (journey, cancellation) | The tool starts exactly these, by fixed request IDs; repeating `start` starts nothing new. Start no other runs. |
| Model requests per run | 6 | Each run's step budget (`stepBudget: 6`), durable across restarts |
| Model requests in total | 12 | The deployment-wide ceiling (`modelRequestCeiling: 12`), durable across restarts |
| Retries | Counted in the limits above | Every physical request is admitted and counted; there are no hidden retries |

Authorization operations are separate from model requests: one `auth anthropic login` if the slot has no usable
authorization, and refresh only as the runtime performs it on use.

## Setup

1. Use a **dedicated deployment** with fresh volumes (a separate Compose project name), so the ceiling counts only
   this trial. Never point it at a workspace with real content: create a directory containing only
   `acceptance/trial-note.md` with the text in `tests/acceptance/anthropic-trial.ts` (`TRIAL.note`).
2. Write the operator configuration from `trialOperatorConfig(model, slot)` in that file — the model is the one
   authorized at 12.11 — and point `AGENT_RUNTIME_CONFIG` at it. Set `AGENT_RUNTIME_PUBLIC_HOST` to the trial node's
   tailnet name and `AGENT_RUNTIME_WORKSPACE` to the trial directory.
3. `docker compose up -d`, then in a private terminal:
   `docker compose exec -it runtime bun dist/auth.js anthropic login` (paste the code there; nothing else sees it).
4. `bun run acceptance:anthropic -- check --origin https://<tailnet name>` must report the deployment ready.

## The journey

5. `bun run acceptance:anthropic -- start --origin https://<tailnet name> --trial g4` prints two run addresses.
6. On the **second tailnet device**, open the journey run. Confirm the read appears and the question waits.
7. Close the page, then reopen the address: the same question is pending, nothing duplicated.
8. While it waits, restart the runtime: `docker compose restart runtime`. Reopen the page: still waiting.
9. Answer **No**. Confirm the result appears and the history shows the answer `false`.
10. Open the cancellation run; when its question appears, press **Cancel run**. Restart the runtime again and
    confirm the run is still cancelled and its question closed.
11. `bun run acceptance:anthropic -- report --origin https://<tailnet name> --journey <run> --cancel <run>` must end
    with `trial conditions hold`, reporting at most 12 model requests.

Record only safe outcomes: the report's lines, run states, device type and browser, and the request counts. Never
record tokens, authorization codes, raw provider bodies or the browser's network log.

## Stop conditions

Stop and report — do not retry, start another run or raise a limit — if any step fails, the provider refuses the
profile or model, a run fails, or a limit is reached. A further attempt needs a new authorization at 12.11.
