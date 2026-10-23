# agent-runtime

A personal agent runtime: start a repository task from a browser, leave, return, answer the agent's
questions, and collect the result using an existing Anthropic or OpenAI subscription.

> **Status: the Anthropic browser slice is built and verified offline; nothing has run against a real provider
> yet.** The [browser console](#browser-console-and-api), its REST/SSE API, controlled agent execution (see
> [Agent execution](#agent-execution)), PostgreSQL persistence, the confined read/search tools, credential storage
> and the [providers](#providers) exist: Anthropic subscription login and inference, and the OpenAI inference
> transport (not yet usable: no OpenAI login). They are verified against scripted provider networks, including
> real-browser journeys. The live Anthropic trial (gate G4), OpenAI login and the remaining acceptance work are
> delivered by the remaining tasks in
> [`openspec/changes/mvp-01-interactive-agent-execution`](openspec/changes/mvp-01-interactive-agent-execution/tasks.md).

Further reading:

- [Architecture](./architecture/README.md): design intent and open questions.
- [MVP roadmap](./openspec/roadmaps/framework-mvp.md): proposed scope and sequencing. Where the roadmap and older architecture disagree, the roadmap is current.
- [Spike reports](./architecture/spike-reports/README.md): historical research results. Each report links to its harness.

## Repository layout

A Bun-workspace monorepo orchestrated by [Turborepo](https://turborepo.com), deployed as **one** application.

| Path | Contents |
|---|---|
| `packages/runtime` | The Bun server and sole deployable application: persistence, configuration, credentials, workspace tools, security boundaries, agent execution, provider adapters, the run service and REST/SSE API, serving the console, and the operator `auth` command. |
| `packages/contracts` | Browser-safe API schemas, the public run-state and event unions, command envelopes and answer validation, shared by the runtime and the console. Pure validation (`zod` only). |
| `packages/ui` | The React browser console: API client, replaying event store, run views and question/cancellation controls. Its public entry is the HTML page the runtime bundles. |
| `packages/anthropic-subscription` | Private, server-only Anthropic subscription authorization and request profile: a minimal, project-maintained derivative of `@ex-machina/opencode-anthropic-auth` ([provenance](packages/anthropic-subscription/PROVENANCE.md)). No I/O of its own. |
| `scripts/` | Repository checks, fixture launchers, the acceptance-trial tool and their tests. |
| `tests/` | Explicitly launched integration, browser and container fixtures and the shared acceptance-trial fixture (never run by ordinary checks). |
| `deploy/` | Deployment configuration: Tailscale Serve, an example operator configuration and the [Anthropic acceptance checklist](deploy/runtime/anthropic-acceptance.md). |
| `spikes/`, `architecture/` | Historical evidence and design intent. Not application dependencies. |

Boundaries enforced by tests:

- The UI never imports runtime internals or server-only modules; the runtime uses only the UI's public entry.
- No package imports `spikes/**`.
- node-postgres (`pg`) is imported only by the official checkpointer adapter; application SQL uses Bun SQL.
- Only the application database adapter opens Bun SQL connections, and it exposes transactions and reserved
  sessions but no plain pool (see [Persistence](#persistence)).
- Only the application database adapter starts transactions with `begin()`.
- Workspace tool and agent execution source contains no process execution, dynamic evaluation or filesystem
  mutation.
- Internal dependencies use `workspace:*`; root owns development tooling, packages own application dependencies.
- The subscription package declares no dependencies, imports only its own modules and platform built-ins, never
  calls global `fetch` or reads the environment, and is imported only by the runtime through its public entry. No
  package imports the upstream plugin or an OpenCode host.
- The contracts package depends only on `zod`, imports nothing else, and uses no platform, server or browser API.
  Other packages import it only through its public entry. Server records, saved-graph bindings and credential
  references stay in the runtime; the API sends explicit projections.
- The console depends only on the contracts and React; its bundle contains no server code (a test checks it).

## Setup

Prerequisites: [mise](https://mise.jdx.dev), Docker Engine with Compose v2, and (for private access) a
Tailscale account.

```bash
mise trust                                 # mise ignores untrusted project config
mise install                               # installs the pinned Bun 1.3.14
mise exec -- bun install --frozen-lockfile  # reproduces bun.lock exactly
```

Pinned tools: Bun 1.3.14 (`mise.toml` and `packageManager`), Turbo 2.10.4, TypeScript 5.9.3, Biome 2.4.15.
Bun is configured to add exact versions. The runtime pins LangChain 1.5.14, `@langchain/core` 1.2.13, LangGraph
1.4.13 with its PostgreSQL checkpointer, and the provider models `@langchain/anthropic` 1.5.11 (with
`@anthropic-ai/sdk` 0.122.0) and `@langchain/openai` 1.6.0 (with `openai` 7.25.0), all in
`packages/runtime/package.json`. Their Bun compatibility is verified by the offline suites, not by live use. The
console pins React and React DOM 19.3.0 (`packages/ui`); browser journeys use Playwright 1.63.0 (root development
dependency) with its headless Chromium, installed once with `bun run browser:install`.

Each spike harness has its own README with separate requirements. `facets.json` configures optional agent
tooling; neither is needed to build or run the runtime.

### Worktrees

`.config/wt.toml` configures [Worktrunk](https://worktrunk.dev) to run `mise trust` when
`wt switch --create` creates a worktree. mise records trust by absolute path, so every new worktree needs it.

- The hook runs only when a worktree is created. Switching to an existing worktree does not run it; run
  `mise trust` there once if mise reports the config as untrusted.
- Worktrunk asks you to approve project hooks the first time they run, and again if they change.
- Approving this hook means every new worktree automatically trusts the `mise.toml` on its branch. When
  checking out a branch you have not reviewed, pass `--no-hooks` and inspect `mise.toml` before trusting it.

## Commands

Run from the repository root (prefix with `mise exec --` if mise is not activated in your shell).

| Command | What it does |
|---|---|
| `bun run dev` | Runs the runtime with hot reload (uncached). |
| `bun run build` | Builds the application to `packages/runtime/dist/`. |
| `bun run start` | Runs the built application. |
| `bun run check` | Lint, typechecks, unit tests and build through Turbo; reuses valid local cache results. |
| `bun run check:verify` | The same graph with `--force`: every task executes. Use this for acceptance. |
| `bun run test` / `typecheck` | Package and repository-script tests / typechecks through Turbo. |
| `bun run lint` | Biome lint and format check (read-only). `bun run format` applies fixes. |
| `bun test` | Direct Bun discovery of unit suites; excludes spikes, `tests/**`, generated output and `*.integration`/`*.live` suites. |
| `bun run test:integration` | Starts a disposable PostgreSQL fixture and runs `tests/integration` (persistence, ownership, run records, lifecycle, provider assembly and the API). Requires Docker. |
| `bun run test:browser` | Starts a disposable PostgreSQL fixture and runs `tests/browser`: the built console in headless Chromium against the run service, with scripted providers, including the acceptance-trial rehearsal. Requires Docker and `bun run browser:install`. |
| `bun run browser:install` | Downloads the pinned Playwright headless Chromium (once, into Playwright's user cache). |
| `bun run test:container` | Builds the image and smoke-tests the isolated Compose topology, including the served console and the Host/Origin checks. Requires Docker. |
| `bun run acceptance:anthropic` | The live Anthropic trial's operator tool; use only as the [checklist](deploy/runtime/anthropic-acceptance.md) describes, after fresh authorization. |
| `bun run provenance:anthropic` | Maintenance only, uses the network: re-verifies the subscription package's recorded upstream baseline, or lists what differs at a candidate revision (see [PROVENANCE.md](packages/anthropic-subscription/PROVENANCE.md)). Never part of `check`. |

Turbo caching is **local only** (remote caching and telemetry disabled). Package tasks are invalidated by
changes to their workspace dependencies' sources and to shared configuration (`bun.lock`, `bunfig.toml`,
`mise.toml`, root `package.json`, `tsconfig.base.json`). A cache hit restores `dist/` — server bundle, console page
and assets, operator command and execution manifest. Because cached results are replayed logs, acceptance evidence
uses `check:verify`. Build caching and run continuation are separate: a console-only change rebuilds the image but
does not change any execution manifest, so paused runs stay answerable; a change to execution code — including a
contracts module the server's execution uses — does change it.

The integration and container launchers accept no arguments, never read `.env`, forward only an allowlisted
environment, and refuse to start if storage, Compose, credential or provider variables (for example
`DATABASE_URL`, `PG*`, `COMPOSE_*`, `AGENT_RUNTIME_*`, `ANTHROPIC_*`) are set. Each run uses a uniquely named
Compose project with fresh storage and removes only what it created. The container smoke replaces the
Tailscale daemon with an inert namespace holder, so it performs no tailnet login and proves Docker topology,
not real Serve/HTTPS behavior.

## Persistence

PostgreSQL holds two schemas with separate owners: `runtime` for application records (Bun SQL) and `checkpoints`
for the official LangGraph checkpointer (its own `pg` pool). Their writes are separate transactions.

On startup the runtime:

1. Takes a single-instance ownership lock on a dedicated database session. A second instance changes nothing and
   reports `owned_elsewhere`.
2. Checks both schema histories before changing either, then applies pending migrations and the checkpointer's
   setup. Unknown, altered, newer or gapped histories are refused (`schema_incompatible`).
3. Claims a new owner epoch. Record changes are fenced by that epoch, so a stale process cannot write.

`/readyz` reports persistence as one of `unconfigured`, `starting`, `ready`, `unavailable`, `owned_elsewhere`,
`schema_incompatible`, `ownership_lost` or `stopping`. If ownership is lost after startup (for example, the database
session ends), the runtime stops and exits so its supervisor restarts it; it never silently reacquires ownership.
An incompatible schema keeps the process up but unready for the operator. PostgreSQL is configured with short TCP
keepalives so sessions orphaned by a replaced network namespace end in about 25 seconds and ownership can move to
the replacement.

**Bun SQL rules.** Two Bun 1.3.14 defects shape database access:

- A plain pool query can run inside another caller's transaction when the pool is busy. Application code therefore
  issues every statement in `transaction()`/`readOnly()` or on a reserved session; the adapter does not expose the
  pool, and a test forbids opening Bun SQL elsewhere. `tests/repro/bun-sql-pool-misrouting.ts` reproduces it.
- A failed `begin()` on a reserved session also raises an unhandled rejection, which would crash the process.
  Reserved sessions (migrations) use `sessionTransaction()` — explicit `BEGIN`/`COMMIT`/`ROLLBACK` — instead.

Details are in [the G1 evidence](architecture/integration-evidence/mvp-01/g1-bun-persistence.md).

Migration 3 limits question prompts to 16 KiB of UTF-8 (migration 2 counted characters). A database already
holding a longer prompt fails that migration and startup, rather than having its history rewritten.

Run records (runs, questions, invocations, model attempts, tool operations, events and execution definitions) are
validated both by runtime decoders and by database constraints; see
[`architecture/09-data-model-and-lifecycle.md`](architecture/09-data-model-and-lifecycle.md).

## Configuration

Environment variables (deployment wiring):

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | PostgreSQL connection; unset leaves persistence `unconfigured`. |
| `RUNTIME_PORT` | Loopback listener port, default `3000`. |
| `RUNTIME_STATE_DIR` | Private runtime state, default `/var/lib/agent-runtime`. Credentials live beneath it. |
| `RUNTIME_CONFIG_FILE` | Absolute path of the operator configuration file. Unset leaves agent execution unconfigured. |
| `RUNTIME_PUBLIC_ORIGIN` | The console's browser-visible HTTPS origin behind Tailscale Serve (for example `https://agent-runtime.your-tailnet.ts.net`). Requests naming any other host are refused; unset, only loopback requests are accepted. |

The operator configuration is a non-secret JSON file (at most 64 KiB). Unknown settings are refused, so an
endpoint, API key or other unsupported option can never be silently ignored:

```json
{
  "version": 1,
  "workspace": { "id": "main", "label": "My repository", "root": "/workspace",
                 "excludeNames": ["secrets.yaml"], "excludePaths": ["ops/keys"] },
  "providers": {
    "anthropic": { "authMode": "subscription", "model": "your-model-id", "profileId": "your-profile-id" }
  },
  "defaultProvider": "anthropic",
  "stepBudget": 50,
  "modelRequestDeadlineSeconds": 300
}
```

- Replace `your-model-id` and `your-profile-id`: models and request profiles are the owner's explicit choice, and
  there are no built-in defaults. The implemented profiles are `claude-cli-2.1.280` (Anthropic) and
  `codex-0.151.0` (OpenAI); see [Providers](#providers). Only `authMode: "subscription"` exists — there is no
  API-key mode and no billed fallback. At startup the runtime logs each configured provider's readiness
  (`provider_readiness`): Anthropic is `ready` with a usable stored credential (an expired access token still
  counts; it renews on use) and `reauthorization_required` without one; OpenAI reports `integration_unavailable`
  until its login exists; an unknown profile ID is `integration_unavailable`.
- `credentialSlot` (default `default`) names the provider's credential record; the `auth` command uses the
  configured slot unless given `--slot`.
- The workspace root must be a normalized absolute path that neither contains nor lies inside the runtime state
  directory, and does not contain the configuration file. Before the tools may use it, the root must also be its
  own canonical path (no symlink at any level), and the state directory and configuration file must resolve
  outside it. The state directory must exist and every private entry beneath it must be inspectable; if the
  private locations cannot be protected completely, workspace access stays unavailable.
- `stepBudget` defaults to 50 model requests per run; `modelRequestDeadlineSeconds` to 300.
- `modelRequestCeiling` (optional) limits model requests across **every** run of the deployment, durably and across
  restarts; admission stops at the ceiling and the run fails as `step_limit` (`request_ceiling_reached`). Unset,
  only each run's budget applies. The bounded acceptance trial uses it.
- Compose mounts the file named by `AGENT_RUNTIME_CONFIG` read-only at `/etc/agent-runtime/config.json`;
  [`deploy/runtime/config.example.json`](deploy/runtime/config.example.json) is a starting point.

The runtime (and the `auth` command) refuses to start, before loading any framework or provider code, if the
environment enables LangSmith/LangChain tracing, sets an HTTP(S)/ALL proxy, overrides a provider base URL or
enables the LangSmith gateway (`LANGSMITH_GATEWAY`), sets an OpenAI organization or project
(`OPENAI_ORGANIZATION`, `OPENAI_ORG_ID`, `OPENAI_PROJECT`, `OPENAI_PROJECT_ID`), disables or replaces TLS
verification (`NODE_TLS_REJECT_UNAUTHORIZED`, `NODE_EXTRA_CA_CERTS`, `SSL_CERT_*`), or turns on request logging
(`ANTHROPIC_LOG`/`OPENAI_LOG` below `warn`, `BUN_CONFIG_VERBOSE_FETCH`, `DEBUG`). Ambient API keys such as
`ANTHROPIC_API_KEY` are ignored: nothing reads them, and providers are selected only from this configuration.

## Authority boundaries

These components are implemented and tested, and are connected to the agent in the execution block.

**Workspace tools** (`mcp_Read` file and directory modes, `mcp_Search`) read only inside the configured root:

- Paths are relative. Absolute, `~`, drive, URL and backslash forms and any `..` component are refused; empty and
  `.` components are ignored, so `.` lists the root.
- Symlinks anywhere along a path, special files (FIFOs, sockets, devices), files with more than one hard link and
  runtime-private files (identified by inode) are refused. Each path component is re-checked after reading, and a
  file that changes while read is reported as changed rather than returned.
- Excluded wherever they appear, case-insensitively, before anything is revealed: `.git`, dependency trees
  (`node_modules`, `bower_components`, `jspm_packages`, `.venv`), `.env` and `.env.*` (templates included),
  private-key and keystore files (`*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.jks`, `*.keystore`, `*.ppk`, `id_rsa` …),
  credential stores (`.ssh`, `.aws`, `.netrc`, `.npmrc`, `.docker`, `credentials.json`, `auth.json` …) and
  Terraform state, plus the configured `excludeNames`/`excludePaths`. Excluded paths are refused identically
  whether or not they exist, and never appear in listings or search.
- Only UTF-8 text without NUL is read, and the whole file is checked, not just the lines returned. Each file is
  also screened for credentials as a whole before any line is paged, clipped or excerpted (see below), so line
  numbers always refer to the original file.
- Limits: 1 MiB per file; 200 lines by default and 2,000 at most; 200 directory entries by default and 2,000 at
  most; search stops at 100 matching lines, 2,000 examined files or 16 MiB read; one call examines at most 20,000
  directory entries, 2,000 directories and 64 levels. Every complete tool outcome — envelope, escaping and
  redaction included — is at most 64 KiB; a single longer line is returned as a marked prefix sized by its
  serialized length, and an outcome that would still exceed the bound is replaced by a `result_too_large`
  refusal. A bound that is reached is reported; a search that skipped an eligible file (too large, unreadable,
  changed or vanished during the search) is reported as incomplete, never as "no matches". The size a file is
  read at is rechecked on the opened file, and bytes read before a change was noticed still count toward the
  16-MiB bound.
- Directory pages are in Unicode code-point order and continue after the last returned name. Pagination is not a
  snapshot: edits between calls can change later pages. A directory with more than 20,000 entries returns no page
  rather than one that could skip names.
- Search is case-sensitive literal matching (no regular expressions or globs), one result per matching line, with
  long lines clipped around the match. It matches the original file text outside credential material, never the
  `[redacted credential]` markers; an occurrence that touches credential material is withheld and makes the
  search incomplete. A query that itself contains credential material is refused.

These checks detect escapes and observed changes on **owner-controlled** volumes. They are not protection against a
hostile process changing the tree concurrently, and the read-only mount is not a sandbox.

**Credentials** live only under `RUNTIME_STATE_DIR/credentials/<provider>/<slot>.json`: versioned, strictly
decoded records with a generation number and millisecond expiry, in `0700` directories and `0600`, single-linked
files owned by the runtime user. Access and refresh tokens must be 16 to 16,384 printable, non-space ASCII
characters. The 16-character minimum is this runtime's safety floor, not a provider format: exact-match screening
cannot safely recognize shorter values, so a stored record with a shorter token is treated as invalid (and left
as it is), and a shorter issued token is never written. Anything else (loose permissions, symlinks, hard links, FIFOs, invalid records)
fails closed. Records are replaced atomically and durably (exclusive temporary file, fsync, rename, directory
fsync). Refresh begins five minutes before expiry; one process refreshes while others wait for, or adopt, its
result. A caller that is already cancelled starts no refresh and launches no lock helper; a caller that stops
waiting for a refresh already in progress does not cancel it, and that refresh keeps the lock until the issuer
and the write have settled. A provider-scoped kernel lock (via the image's `/usr/bin/flock`) is shared by the runtime and operator
login, so a stale refresh can never overwrite a newer login. A definitive rejection records
"reauthorization required" and keeps no token material. **A refresh token is never replayed after a refresh whose
outcome is unknown** (a timeout or lost connection after sending, a server error, an unreadable or unusable
answer): the issuer may already have rotated it, so the slot is durably marked as needing reauthorization
(`refresh_outcome_unknown`) for every process. Only a refresh that certainly consumed nothing — never sent, or
throttled — keeps the credential for a later attempt. Anthropic login and refresh are implemented (see
[Providers](#providers)); OpenAI's are not yet.

**Secret-safe projections.** Goals and answers containing credential material are refused, not rewritten, before
anything is stored or sent: they are screened against every generation in use and the usable credentials stored
for the configured providers (and, for an answer, the run's own credential slot). If a stored record cannot be
read, input is refused as unscreenable rather than accepted.
Credential material is located over the complete text — a whole file, or a whole assembled model message — and
each occurrence is replaced by `[redacted credential]`, keeping line breaks so line numbers are unchanged. A
private-key block is masked whole, delimiters and body; one without its matching `END` line (or with another
`BEGIN` first) is withheld through the end of the file. A credential in a tool call's arguments, or in a result's
non-text field such as a path or cursor, withholds that call or result instead; refusals and errors from any
source are checked the same way. If a redacted result would still contain recognizable material, it is withheld
rather than redacted again. Model output is assembled completely (only after the provider's successful
end-of-response) before any of it is used, so a credential split across stream fragments is still caught; both
the buffered input and the redacted, serialized message are limited to 1 MiB. Detection combines exact matches of
this runtime's live credentials — through an opaque matcher from the credential boundary, which consumers cannot
enumerate and which execution code must be given explicitly — with a small set of unambiguous formats
(vendor-prefixed keys, private-key blocks, literal bearer tokens); it is not general secret scanning, and ordinary
identifiers, hashes and example JWTs pass through. The execution layer's matcher follows credential rotation: a
request **leases** its generation when the credential is resolved, before the request is admitted or sent, and
the lease ends only when that model call's response has been sanitized or discarded — not when its HTTP exchange
ends. A leased generation is never evicted, however many rotations happen meanwhile; released generations stay
screened until room is needed. The screen holds 64 generations; if all are leased, a new one is refused and its
request is not sent. Complete model responses are
sanitized inside the model call, before the graph checkpoints them, keeping the provider's full message (IDs, tool
calls, reasoning and replay metadata); only displayable text is redacted, and a credential anywhere else withholds
the response.
Diagnostics are flat allowlisted fields only — no free text, errors, requests, headers or bodies.

## Agent execution

Each run is one stock LangChain `createAgent` (tool behavior `v2`) with the official PostgreSQL checkpointer,
invoked at the root graph with the run ID as its thread, synchronous durability and a signal owned by the service
— a browser connection can never stop a run. Invocation never passes a `checkpoint_id`. The framework runs the
loop; the runtime only constrains what crosses into graph state and what is dispatched:

- **Tools.** `mcp_Read`, `mcp_Search` and `mcp_AskUser`, with explicit JSON schemas. Every call is identified by its
  run, issuing model message and provider call ID, and recorded before it runs and after. A call already completed
  is answered from its record; the same provider call ID bound to different arguments is refused as invalid. A call
  to any other tool (for example a file write or a command) is refused and recorded, never performed. A question
  must be the only call in its response: in a mixed batch, every call is refused. Failures inside the graph carry
  fixed text only, because the graph records exception text in its checkpoints.
- **Model requests** pass one guarded terminal (the SDK's `fetch`): exact HTTPS endpoint and method, no redirects,
  credentials resolved first (outside the budget), then durable admission under the run's short dispatch gate —
  ownership re-verified, run still working, one step reserved within budget — and the request starts while that
  gate is held. A provider's request profile adapts the request for that credential before admission (a request
  it cannot represent is refused unsent). Dispatch is recorded before the response is used; completion before its
  body ends, and a streamed body that ends without the provider's successful end-of-response (or carries an error
  event) fails instead of becoming a partial message. The deadline (default five minutes) covers the whole body.
  Hidden retries are not possible: every physical request is admitted and counted, and framework retries are
  forced off for every call. After a recoverable authorization rejection, one renewal retry is allowed, as another
  counted step. An unsuccessful response is classified into a safe provider code (rate limit, usage limit,
  authorization, unsupported model or profile, service unavailable) and reported with its attempt.
- **Budget.** The default is 50 model requests. The run reports `{ maximum, consumed, unconfirmed }`; an admission
  whose dispatch was never confirmed stays charged as unconfirmed. Tool calls from the last permitted response still
  run; only another model request fails the run with `step_limit`. An answer can be accepted with no steps left.
- **Questions.** A question becomes answerable only after the invocation has settled, read-only inspection has
  confirmed the saved interrupt, and one transaction has recorded it and moved the run to `waiting`. An answer
  names its run and question; an already-answered question acknowledges an identical answer (even after the run
  finished) and refuses a different one before anything else is checked. Before acceptance the runtime rebuilds
  the run's stored provider binding (never current defaults), compares the execution definition and re-inspects
  the saved state without running the graph: a temporary inability to look accepts nothing and changes nothing,
  while confirmed missing, unusable or incompatible state closes the question and fails the run as
  `continuation_unavailable`. `false`, `null`, `0` and permitted empty text are answers. The accepted answer is
  delivered once, to the saved interrupt by its ID.
- **Compatibility.** The execution definition covers the Bun version, the exact package versions and integrity
  values used by the execution code, digests of that code's own import closure (line endings normalized), the
  generated graph, middleware, tool schemas, the prompt, protocol versions and the run's binding. There is one code
  manifest per provider — the common execution closure plus that provider's adapter, following workspace packages
  into their source (so the Anthropic manifest includes the subscription package's files) — written at build time
  beside the bundle (`dist/execution-manifest.json`). A change to one provider's adapter does not refuse runs bound
  to the other. Browser code, documentation, tests and default settings are not inputs.
- **Cancellation** is recorded before it is acknowledged and serialized with admissions, so nothing is dispatched
  after it. A waiting run is cancelled at once; a working run is `cancelling` until its request bodies, tool calls
  and checkpoint writes have actually settled. An answer accepted earlier stays accepted.
- **Outcomes.** Success requires a new final assistant message from this invocation, recorded in history; a
  continuation that does nothing is a `runtime_failure`. Failures are classified from typed evidence only (see the
  categories in [`architecture/09`](architecture/09-data-model-and-lifecycle.md#phase-1-lifecycle-as-built)). If a
  final commit's outcome cannot be established, the service stops rather than guess.
- **Restart.** Before it reports ready, startup marks runs that were working as `interrupted` (their accepted answers
  kept, admissions never confirmed as sent recorded unconfirmed) and runs whose cancellation was accepted as
  `cancelled`. Waiting and finished runs are unchanged. Nothing is resumed, retried or dispatched.

The run service (`src/service/runs.ts`) composes all of this for the API: it admits the workspace afresh for each
start and continuation, builds each invocation from the run's stored binding through the provider assembly
(`src/providers/assembly.ts`), and dispatches work in the background, so it never depends on the request — or any
browser — that caused it. Verification with provider-free models, including every crash window, is recorded in
[the G3 evidence (2026-09-30)](architecture/integration-evidence/mvp-01/g3-dispatch-lifecycle.md).

## Browser console and API

Open the console at the `RUNTIME_PUBLIC_ORIGIN` address from any device on your tailnet. It lists runs (goal,
provider, status, start and last-activity times), starts a run, and shows one run: its status, budget
(`consumed` of `maximum`, plus any `unconfirmed` admissions), provider and workspace, history with recorded times,
the pending question, the final result or failure with its category and guidance, and a cancel button. Text from
the model, tools and workspace is rendered as plain text; nothing from a run is interpreted as markup or loads
external resources.

You can close the page at any time — the run continues — and reopen it later: the console reads a snapshot,
fills in history up to it, then follows the run's event stream from there. Whether the page is connected is shown
separately from the run's status; a dropped connection never shows a run as finished or failed. Questions accept
exactly the declared answer types: choices keep their JSON type (`false` is not `"false"`), text is sent as typed,
and multiple choices as the selected values.

The API (`/api/v1`, JSON only):

| Route | Purpose |
|---|---|
| `GET /options` | Workspace label and availability, configured providers with their readiness, the default budget and any ceiling |
| `GET`, `POST /runs` | List runs (newest first, paginated); start one with `{ requestId, goal, provider }` |
| `GET /runs/:runId` | A consistent snapshot of one run and the last history event it includes (`throughSeq`) |
| `GET /runs/:runId/events` | Committed history after a cursor, optionally up to a fixed bound |
| `GET /runs/:runId/stream` | Server-sent events: replay after the cursor (`after`, or the browser's `Last-Event-ID`), then the live tail; a comment heartbeat every 15 seconds |
| `POST /runs/:runId/questions/:questionId/answer` | `{ answer }` for that exact question |
| `POST /runs/:runId/cancel` | `{ requestId }` |

- **Idempotency.** Repeating a start with the same `requestId` and content returns the original run (`200`)
  before any prerequisite is checked again, so a lost reply can always be retried; different content is a
  conflict. An identical answer to an answered question is acknowledged (`200`) even after the run finished; a
  different one is a conflict. Only the request that actually started a run, or had an answer accepted, dispatches
  work. When a commit's outcome is unknown it is read back first; if that is impossible the reply is
  `503 acceptance_unknown`, and repeating the same request is safe. The console keeps a start's or cancellation's
  request ID until it gets a definite answer.
- **Errors** are `{ error: { code, message, runId?, questionId?, retryable, acceptance } }`, where `acceptance` says
  whether anything was recorded (`not_accepted`, `unknown`, `already_accepted`). Shape errors are `400`, Host/Origin
  refusals `403`, unknown runs or questions `404`, conflicts, closed questions, unavailable providers or workspace and
  confirmed continuation refusals `409`, and temporary unavailability `503` (which never records a failure).
- **Replay** reads committed history from the database after the client's cursor, so a reconnect, or an event
  recorded between a snapshot and its stream, is delivered exactly once. A cursor beyond recorded history is
  `409 cursor_ahead`. If storage fails mid-stream, the stream sends an unsequenced `availability` notice and
  closes without advancing the cursor. The stream is produced only as fast as it is read.
- **Requests from elsewhere** are refused: a request must name the configured address (or loopback, for health
  checks and in-container tools), and anything that changes state must also carry that same `Origin` (not `null`,
  not another site). Forwarding headers are ignored, and no response grants cross-origin access. Responses carry a
  restrictive content security policy and framing, referrer and sniffing protections.

## Providers

Both providers use the stock LangChain chat model for their API (`ChatAnthropic`, `ChatOpenAI` in streaming
Responses mode) with its SDK `fetch` set to the guarded terminal. The runtime owns credentials (storage, locking,
refresh, screening), admission and the one renewal retry; provider code only adapts requests, classifies failures
and checks that a response ended completely. Responses are never rewritten. Each model is built per run from the
run's stored model and profile, with an inert sentinel API key (so no ambient key is ever looked up), an explicit
endpoint (so neither the environment nor a gateway can redirect it) and retries off.

**Anthropic** (profile `claude-cli-2.1.280`). Authorization and the request profile come from
[`packages/anthropic-subscription`](packages/anthropic-subscription/README.md), a minimal, project-maintained
derivative of `@ex-machina/opencode-anthropic-auth` 2.0.0-next.5. It is updated only by manual review
([provenance and intentional differences](packages/anthropic-subscription/PROVENANCE.md)); it follows no npm tag
and recovers from no version rejection by itself. Requests carry the reference client's headers, betas, identity
and billing blocks, with the runtime's native tool names unchanged; a conversation must open with the user's text,
because the billing block derives from it. A client-version rejection fails the run as an unsupported
model/profile; updating the profile is a reviewed package change with a new profile ID.

Log in from a private terminal. The command prints a URL to open in a browser on any device, then reads the
pasted code; it shares the runtime's credential lock, so it can run while the service is up:

```bash
docker compose exec -it runtime bun dist/auth.js anthropic login     # inside the running application container
docker compose exec runtime bun dist/auth.js anthropic status        # safe status only; never refreshes
bun packages/runtime/src/auth.ts anthropic status [--slot s]         # from a checkout (RUNTIME_STATE_DIR, RUNTIME_CONFIG_FILE)
```

Token values are never printed. A rejection right after a renewal is definitive: the slot is marked as needing
reauthorization, and later runs fail with authorization guidance without sending anything.

**OpenAI** (profile `codex-0.151.0`). The inference transport exists: the measured Codex backend profile
(allowlisted headers, stateless replay of encrypted reasoning and function calls with matching IDs), token and
account always from one credential generation, and completion only on `response.completed`. It uses Bun's own
`fetch`, which a test shows adds no browser-style headers. Device login and renewal are not implemented, so OpenAI
stays unavailable.

Offline verification runs the stock models inside the stock agent against scripted provider streams
(`src/providers/*/inference.test.ts`, and the production assembly on the official saver in
`tests/integration/provider-assembly.integration.test.ts`); results are recorded in the dated
[G2](architecture/integration-evidence/mvp-01/g2-anthropic-boundary.md),
[G4 offline](architecture/integration-evidence/mvp-01/g4-anthropic-offline.md) and
[G5 offline](architecture/integration-evidence/mvp-01/g5-openai-offline.md) evidence. Nothing has been verified
against a real provider in this runtime yet; live checks happen only with the owner's fresh authorization.

## Deployment

`compose.yaml` defines three services:

- **runtime** — the single application image (non-root, read-only root filesystem, all capabilities dropped),
  serving the console, the API and health endpoints. It shares the Tailscale container's network namespace and
  listens only on `127.0.0.1:3000`. Writable locations are the private `runtime-state` volume
  (`/var/lib/agent-runtime`, mode `0700`) and a bounded `/tmp`. The owner workspace is mounted read-only at
  `/workspace`, and the operator configuration read-only at `/etc/agent-runtime/config.json`.
- **tailscale** — Tailscale Serve proxies HTTPS to the runtime's loopback listener. Funnel is disabled and
  no ports are published. Userspace networking; state in its own volume.
- **postgres** — PostgreSQL 17.11 on an internal network with no published port.

All images are pinned by digest. The Docker build uses the repository root as context with an allowlisting
`.dockerignore`, installs from the frozen lockfile, bundles the server, operator command and console into
`packages/runtime/dist/` (the console is bundled ahead of time from the UI package's HTML entry), and copies only
that output into the runtime image. There is no separate frontend server.

```bash
cp .env.example .env   # set the workspace, configuration path, tailnet name and a generated POSTGRES_PASSWORD
cp deploy/runtime/config.example.json /path/to/config.json   # then choose the model; see Configuration
docker compose up -d --build
docker compose logs tailscale   # first start: open the printed login URL to join your tailnet
docker compose exec -it runtime bun dist/auth.js anthropic login
```

`AGENT_RUNTIME_PUBLIC_HOST` must be the full tailnet name Serve publishes (`<TS_HOSTNAME>.<your-tailnet>.ts.net`);
the console only answers requests addressed to it. Restrict the machine to your own devices with your tailnet access
policy. The real tailnet login, Serve HTTPS and access from a second device are verified in the live Anthropic trial.

Health endpoints: `/healthz` (liveness) and `/readyz` — ready (`200`) only when persistence is ready, agent execution
is configured and composed, and the console is loaded; each is reported in `checks`. Provider authorization is not
part of readiness: an unauthorized provider is shown in the console and refuses starts.

### Troubleshooting

| Symptom | Cause and remedy |
|---|---|
| The console answers `403` | The address is not `RUNTIME_PUBLIC_ORIGIN`, or a change came from another page. Use exactly the configured tailnet name. |
| Starting a run reports the provider unavailable | No usable authorization: run the `auth … login` command; `auth … status` shows the slot's state. |
| Input is refused as unscreenable | A credential record cannot be read or is invalid. Check `auth … status`, and log in again. |
| The page shows “Reconnecting” | The connection dropped; the run is unaffected and the page catches up when it reconnects. |
| `503 acceptance_unknown` | Storage could not confirm a change. Repeat the same action; it cannot be applied twice. |
| `/readyz` stays `503` | `checks` names the part that is not ready; persistence states are described under Persistence. |

## Limitations

- Nothing has been verified against a real provider yet: the Anthropic slice is verified with scripted
  providers, and its live trial is pending. OpenAI login is not implemented, so OpenAI runs cannot be started.
- No application accounts: anyone your tailnet policy admits to the machine can use the console.
- No backup, retention or restore tooling; ordinary restarts preserve the database volume, nothing more.
- Read-only mounts and path checks are not a sandbox against hostile processes on the host; the workspace is
  assumed to be owner-controlled.
- Ordinary restarts are in scope; host-reboot and disaster-recovery guarantees are not.

## License

[MIT](./LICENSE) © 2026 Agent Facets, Inc.

Third-party material and dependencies keep their own licenses; see
[THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md). Some spike harnesses download software with separate
terms. In particular, the Obsidian spike image contains proprietary software that should not be redistributed.
