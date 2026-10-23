# G4 (Docker and tailnet) — Anthropic journey in the shipped deployment

**Outcome: pass (2026-10-01).** Recorded under task 19.4 from tasks 19.2 (deployment) and 16.7 (journey). It
repeats the [local live trial](g4-anthropic-live.md) in the shipped Compose deployment behind Tailscale Serve,
reached over HTTPS from the tailnet, including restart and recreation of the runtime container. A real token
renewal still did not occur.

## Question

Does the shipped image, run by the shipped `compose.yaml` with Tailscale Serve as its only ingress, serve the console
privately over HTTPS on the owner's tailnet, accept a console login, run the real Anthropic journey, and keep
authorization, pending questions and outcomes across restart and recreation of the runtime container — without
publishing ports or exposing credentials?

## Authorization

- 19.1 (setup): isolated project `agent-runtime-live`, fresh volumes, owner-performed enrollment; no Anthropic use.
  The owner described the tailnet as personal and owner-only.
- 19.3 (live): image `sha256:525fb91c…`, Anthropic subscription, profile `claude-cli-2.1.280`, model
  `claude-opus-5-5`, slot `default`; owner-performed console login; renewal only as the runtime performs it; the
  `TRIAL` note and two goals; at most 6 model requests per run and 12 in total, retries included; stop on failure.
  At the owner's choice during the journey, the executor drove the two trial runs in a headless browser while the
  owner watched from the laptop.

## Tested build and deployment

- Source: commit `ba07cb784c9eabd699b0af83f49281a56f6800e7`; `compose.yaml`, `Dockerfile` and
  `deploy/tailscale/serve.json` unchanged. Runtime image `agent-runtime/runtime:ba07cb7-docker-trial`, ID
  `sha256:525fb91c7d0cf0c8890dbd13bee77d62dbfe19f9a9a4528941e65c288f842e81` (Bun 1.3.14; same package matrix as
  [g4-anthropic-live.md](g4-anthropic-live.md)). Tailscale `v1.102.5`, PostgreSQL `17.11` (digest-pinned in
  `compose.yaml`).
- Compose project `agent-runtime-live` with fresh volumes `agent-runtime-live_postgres-data`,
  `agent-runtime-live_runtime-state` and `agent-runtime-live_tailscale-state`. Workspace: only
  `acceptance/trial-note.md`, mounted read-only; operator configuration from
  `trialOperatorConfig('claude-opus-5-5', 'default')` (budget 6, ceiling 12), mounted read-only.
- Enrollment: the interactive login link needed a sign-in the owner could not complete from where they were, so the
  owner generated a one-time, non-reusable, non-ephemeral auth key in their Tailscale admin console and the executor
  applied it once with `tailscale login --auth-key` inside the Tailscale container (no Compose change; the host was
  not enrolled). The key was shared in the conversation at the owner's choice and is not recorded here.
- Node: `agent-runtime-live.boa-beaufort.ts.net` (MagicDNS on, certificate issued). Serve:
  `https://agent-runtime-live.boa-beaufort.ts.net (tailnet only)` → `http://127.0.0.1:3000`.

## Deployment checks (19.2, before any Anthropic use)

| Check | Result |
|---|---|
| Published host ports (tailscale, runtime, postgres) | None |
| Funnel | Off (tailnet only) |
| Runtime container | User `bun`, read-only root, `cap_drop: ALL`, `no-new-privileges`, Tailscale container's network namespace |
| Mounts | `/workspace` and the configuration read-only; only `/var/lib/agent-runtime` (its volume) writable |
| Request policy (inside the namespace) | Public Host 200; forged Host and forged `X-Forwarded-Host` 403; POST without Origin, with a foreign or `http://` Origin, or cross-site 403; same-origin POST reaches the handler |
| Console over HTTPS from the owner's laptop | Loaded (owner report) |
| Options | Workspace available; Anthropic `reauthorization_required`; budget 6; ceiling 12; no runs |

## Journey (16.7)

| Step | Result |
|---|---|
| Owner connects Anthropic from the laptop over HTTPS | Ready, generation 1; one `provider_login_connected` diagnostic |
| Owner reconnects and runs "Write me a poem" from the laptop (owner use, not the trial) | Generation 2 written 18:40:03 UTC, 13 s before that run, with no renewal attempt in any run: a second console login, not a renewal. The run succeeded with 1 request |
| Headless Chrome 154 (Linux) opens the same HTTPS address over the tailnet | Valid certificate, secure context, page loaded; Anthropic shown as connected |
| Journey run `03c65bda-b5d4-4862-a9ae-e8421f0685db` started from the console | Real read of the trial note; question "Should I list the checklist steps from acceptance/trial-note.md?"; waiting, 2 requests |
| Cancellation run `ddd58ed4-6e3d-47ae-a1f2-6474c3d0156c` started from the console | Question "Are you ready?"; waiting, 1 request |
| Leave the page and reopen it | One pending question; history without duplicates |
| `docker compose restart runtime` (same container, new start) | Both waiting, budgets unchanged; Anthropic ready without a new login |
| `docker compose up -d --force-recreate --no-deps runtime` (new container `a3e0bb69…`, same image and volumes) | Both waiting, budgets unchanged; Anthropic ready (generation 2) without a new login |
| Answer **No** | `Answer accepted: false`; result "You said no, so I won't list the steps. The file acceptance/trial-note.md is a test note made only for the acceptance trial, and it has a three-step release checklist."; Completed, 3 requests |
| Cancel the second run | Cancelled, question closed |
| Restart, then recreate again (new container `5b4a3d9d…`) | Still cancelled, no pending question, 1 request |
| `acceptance:anthropic report` from the host over the tailnet HTTPS origin | `model requests: journey 3, cancellation 1, total 4 of 12` · `trial conditions hold` |
| Browser console and page requests (headless) | No errors or warnings; no failed requests |

**Model requests: 4** for the trial (all completed `ok`, none unconfirmed, no retries); **5** in the deployment
including the owner's run. The CLI `start` command was not used.

## Secrecy

A scan loaded the current (generation 2) access and refresh tokens and searched, printing only counts: `/options`,
the run list, all three runs' snapshots and complete histories, the logs of all three containers, and a full
`pg_dump` of the deployment's database (226,490 bytes). **0 occurrences.** The generation-1 tokens had already been
replaced and were not part of the scan. Login codes were handled by the owner only.

## What this establishes

- The shipped image and Compose topology work end to end with a real subscription: Tailscale Serve is the only
  ingress, over HTTPS with a valid certificate, with no published ports.
- The console login works over the tailnet from a second device, and a repeated login (Reconnect) replaces the
  stored authorization cleanly.
- Saved authorization, a pending question and a cancelled outcome survive both a restart and a full recreation of
  the runtime container on the same volumes, without logging in again or repeating work.

## Limitations and open items

- **No real token renewal occurred** (both generations came from console logins; no run needed a renewal). Renewal
  remains verified offline only.
- The trial runs were driven from a headless browser on a separate Linux machine reaching the tailnet address, at
  the owner's choice; the owner's laptop exercised login, Reconnect, a task start and its result, and watched the
  trial runs. The two trial answers/cancellations were not clicked on the laptop itself.
- Tailscale-container replacement with this deployment was not repeated (covered by container smoke tests with an
  inert namespace holder). The PostgreSQL container was not restarted.
- One provider, one model and a short journey; not a load, quota or long-run test. OpenAI is not covered.
