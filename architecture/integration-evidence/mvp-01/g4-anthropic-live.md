# G4 (live) — Anthropic subscription journey

**Outcome: pass (2026-09-30), local loopback deployment.** Recorded under task 12.13 from the task 12.12
verification. Together with [g4-anthropic-offline.md](g4-anthropic-offline.md) this completes G4 for the
Anthropic usable slice, with two items outside it: a real token renewal did not occur, and the private-network path
(Tailscale Serve HTTPS from a second device) was not part of this trial — it is task 16.7.

## Question

With a real Claude subscription, does the built runtime let the owner connect Anthropic from the console, then run
the agent through a real read, tool result, question, runtime restart, answer and final result — and a cancellation
that survives a restart — over the browser console, within the authorized request cap, without exposing credentials?

## Authorization

Granted at task 12.20 (the earlier 12.11 allowance was suspended and not used): Anthropic subscription, profile
`claude-cli-2.1.280`, model `claude-opus-5-5`, slot `default`; one owner-performed console login with no executor
observation of Anthropic's page, the code or the login requests; renewal only as the runtime performs it; the
`TRIAL` fixture; two runs, 6 model requests each, 12 in total including retries; stop on any failure.

## Tested build and environment

- Source: commit `4ac080937060bd12947cd5c250aa650c761f7f82` ("Add browser-based Connect Anthropic login flow …"),
  built with `bun run build`. The only uncommitted change while testing was the task list.
- Bun 1.3.14. `@langchain/anthropic` 1.5.11 with `@anthropic-ai/sdk` 0.122.0, `langchain` 1.5.14,
  `@langchain/core` 1.2.13, `@langchain/langgraph` 1.4.13, `@langchain/langgraph-checkpoint-postgres` 1.0.5.
- Deployment: the runtime started directly on the owner's Linux host (`bun --no-env-file dist/main.js` with a clean
  environment: `PATH`, `HOME`, `DATABASE_URL`, `RUNTIME_STATE_DIR`, `RUNTIME_CONFIG_FILE`, `RUNTIME_PORT=3000`;
  `RUNTIME_PUBLIC_ORIGIN` unset, so loopback only). A dedicated PostgreSQL 17.11 container on loopback with a fresh
  volume; a private (`0700`) trial state directory; a workspace containing only `acceptance/trial-note.md`;
  operator configuration from `trialOperatorConfig('claude-opus-5-5', 'default')` (`stepBudget` 6,
  `modelRequestCeiling` 12).
- Browser: Chrome 154 on Windows, reaching `http://127.0.0.1:3000/`. The executor drove the journey through Chrome
  DevTools in a tab the owner watched; the owner performed the login.

## Steps and results

| Step | Result |
|---|---|
| Before login: options and `/readyz` | Anthropic `reauthorization_required`; console shows **Connect Anthropic** |
| Owner connects Anthropic in the console (real token exchange) | Console showed connected; options `ready`; `auth anthropic status`: ready, generation 1; one `provider_login_connected` diagnostic |
| `acceptance:anthropic check` | `deployment ready for the trial: budget 6 per run, ceiling 12 requests` (no model request) |
| `acceptance:anthropic start --trial g4` | Journey run `04f40616-0090-4fd4-ac2b-fe51e550d478`, cancellation run `047df3bc-e7e0-4aba-95f1-9327e3b3870f` |
| Journey: real model reads the note and asks | Request 1: `mcp_Read` of `acceptance/trial-note.md` completed; request 2: `mcp_AskUser` "Should I list the checklist steps from acceptance/trial-note.md?" (yes/no); run waiting, 2 of 6 used |
| Close and reopen the page | Same single pending question; history without duplicates |
| Restart the runtime while both runs wait | Both still waiting with unchanged budgets (journey 2, cancellation 1); Anthropic still ready without logging in again |
| Answer **No** in the console | `Answer accepted: false`; request 3 produced the result "You said no, so I won't list the steps. The note … contains a three-step release checklist."; run **Completed**, 3 of 6 used |
| Cancellation run: question pending, press **Cancel run** | **Cancelled**, question closed, 1 of 6 used |
| Restart the runtime again; reload | Still **Cancelled**, question closed, no cancel button |
| `acceptance:anthropic report` | `model requests: journey 3, cancellation 1, total 4 of 12` · `trial conditions hold` |
| Browser console and page requests | No console errors or warnings; no failed API requests |

**Model requests: 4** for the trial. All completed `ok`; none unconfirmed; no retries.

After the trial, with the owner's agreement, the owner used the console directly: two further runs, both
succeeded, using 1 and 5 requests. They are not part of the trial; the deployment-wide total was 10 of the 12-request
ceiling, which held.

## Secrecy

A scan loaded the stored access and refresh tokens in memory and searched, printing only counts: `/options`, the run
list, all four run snapshots and complete histories, the runtime's diagnostic log, and a full `pg_dump` of the trial
database (run records, events and checkpoints). **0 occurrences** of either token on every surface. The login code
was handled only by the owner and the login endpoint; the executor never saw it. No token, code, raw provider body or
network log was recorded.

## What this establishes

- Anthropic accepted the console login (PKCE URL, fixed callback code, single exchange) and the stored
  authorization was usable immediately and after two restarts.
- Anthropic accepted profile `claude-cli-2.1.280` with model `claude-opus-5-5` and the runtime's native tool names
  (`mcp_Read`, `mcp_AskUser`) over real streaming responses, under Bun.
- The real agent loop works end to end: tool call → tool result → question → durable pause across a restart →
  typed `false` answer → final result that respects it; cancellation is durable across a restart.
- Budgets and the deployment ceiling counted every real request, and the console reflected them live.

## Limitations and open items

- **No real token renewal occurred** (the access token was valid for about eight hours; generation stayed 1). Renewal
  is verified offline only ([g2-anthropic-boundary.md](g2-anthropic-boundary.md),
  [g4-anthropic-offline.md](g4-anthropic-offline.md)).
- **Not covered: Tailscale Serve HTTPS and a second tailnet device** (moved to task 16.7 by the owner-approved trial
  replan). The browser reached the runtime over loopback.
- The runtime ran directly on the host, not in the Compose image; the image itself is covered by container smoke
  tests, not by this live run.
- One provider, one model and one short journey; this is not a load, quota or long-run test.
