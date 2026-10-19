# agent-runtime

A personal agent runtime: start a repository task from a browser — a free-form goal or an installed facet command —
leave, return, answer the agent's questions, and collect the result using an existing Anthropic or ChatGPT
subscription. Command runs can load skills on demand, delegate bounded tasks to named agents and call MCP tools the
owner has granted; everything else stays read-only.

Recorded live and deployment checks are in [`architecture/integration-evidence/`](architecture/integration-evidence/);
see [Providers](#providers) and [Limitations](#limitations) for what they do and do not establish.

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
| `packages/facet-adapter` | Install-time tooling for the runtime's own facet installation: the `agent-runtime` adapter for the `facet` CLI and the sealer that turns a completed installation into the bundle the runtime verifies. Never imported by the runtime or shipped in its image. See [Runtime facets](#runtime-facets). |
| `packages/mcp-programs` | Builds explicitly selected MCP server programs into self-contained, content-addressed Bun bundles with a manifest of their exact dependencies; the image ships them under `/opt/agent-runtime/mcp/`. No program is selected; its synthetic test servers (`test-support/`) are built only by the integration, browser and container launchers. See [Capability configuration](#capability-configuration). |
| `packages/anthropic-subscription` | Private, server-only Anthropic subscription authorization and request profile: a minimal, project-maintained derivative of `@ex-machina/opencode-anthropic-auth` ([provenance](packages/anthropic-subscription/PROVENANCE.md)). No I/O of its own. |
| `scripts/` | Repository checks, fixture launchers, the acceptance-trial tool and their tests. |
| `tests/` | Explicitly launched integration, browser, container and facet-export fixtures and the shared acceptance-trial fixture (never run by ordinary checks). |
| `compose.yaml`, `compose.facets.yaml` | The deployment and its optional runtime-facet overlay (see [Deployment](#deployment)). |
| `deploy/` | Deployment configuration: Tailscale Serve, an example operator configuration, the runtime's [facet project](deploy/runtime/facets/README.md) and the [Anthropic acceptance checklist](deploy/runtime/anthropic-acceptance.md). |
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
- Only `packages/facet-adapter` depends on the facet SDK, and only through its public entry points; no package
  imports the facet engine, protocol or CLI internals, and nothing depends on the adapter package.
- Only the runtime's OpenAI adapter (`src/providers/openai/`) imports the OpenAI client or names its endpoints, and
  production sources and the shipped image contain none of the retired Codex request rewriter or stream parser.

## Setup

Prerequisites: [mise](https://mise.jdx.dev), Docker Engine with Compose v2, and (for private access) a
Tailscale account.

```bash
mise trust                                 # mise ignores untrusted project config
mise install                               # installs the pinned Bun 1.3.14
mise exec -- bun install --frozen-lockfile  # reproduces bun.lock exactly
```

Pinned tools: Bun 1.3.14 (`mise.toml` and `packageManager`), Turbo 2.10.4, TypeScript 5.9.3, Biome 2.4.15.
Bun is configured to add exact versions. The runtime pins LangChain 1.5.14, `@langchain/core` 1.2.14, LangGraph
1.4.13 with its PostgreSQL checkpointer, and the provider models `@langchain/anthropic` 1.5.11 (with
`@anthropic-ai/sdk` 0.122.0) and `@langchain/openai` 1.6.2 (with `openai` 7.28.0), all in
`packages/runtime/package.json`. Their Bun compatibility is verified by the offline suites, not by live use. The
console pins React and React DOM 19.3.0 (`packages/ui`); browser journeys use Playwright 1.63.0 (root development
dependency) with its headless Chromium, installed once with `bun run browser:install`.

Each spike harness has its own README with separate requirements. The root `facets.json` configures optional
coding-tool facets for working on this repository; neither is needed to build or run the runtime. The runtime's own
facet installation is separate (see [Runtime facets](#runtime-facets)) and needs the pinned `facet` CLI only when you
install facets for it or run `bun run test:facets`.

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
| `bun run build` | Builds the application to `packages/runtime/dist/`, the runtime facet adapter to `packages/facet-adapter/dist/` and the (empty) MCP program set to `packages/mcp-programs/dist/`. |
| `bun run start` | Runs the built application. |
| `bun run check` | Lint, typechecks, unit tests and build through Turbo; reuses valid local cache results. |
| `bun run check:verify` | The same graph with `--force`: every task executes. Use this for acceptance. |
| `bun run test` / `typecheck` | Package and repository-script tests / typechecks through Turbo. |
| `bun run lint` | Biome lint and format check (read-only). `bun run format` applies fixes. |
| `bun test` | Direct Bun discovery of unit suites; excludes spikes, `tests/**`, generated output and `*.integration`/`*.live` suites. |
| `bun run test:integration` | Starts a disposable PostgreSQL fixture and runs `tests/integration` (persistence, ownership, run records, lifecycle, provider assembly, the API and the MCP/Bun process gate, whose synthetic server bundles it builds into a disposable directory first). Requires Docker. |
| `bun run test:browser` | Starts a disposable PostgreSQL fixture, builds the synthetic MCP programs and runs `tests/browser`: two smoke checks of the built console in headless Chromium (a goal run and a command run) against the run service with a scripted provider. Behavior is tested at the API, service and component level, not here. Requires Docker and `bun run browser:install`. |
| `bun run console:offline` | Runs the console on this machine at `http://127.0.0.1:4310/` (or a free port, printed) with nothing real behind it: a disposable PostgreSQL fixture, a synthetic workspace and credential, and a scripted model that reads a file, asks one question and reports your answer. Goals containing “text”, “several” or “fail” choose a text question, a multiple-choice question or a provider failure. No provider is contacted. Ctrl+C stops it and removes everything it created. Requires Docker. |
| `bun run test:facets` | Runs `tests/facets` with the pinned `facet` CLI (on `PATH`): installs synthetic fixture facets into disposable runtime and editor homes, then checks exports, sealing (including the join of MCP server declarations to every facet that declares them), reproducibility and isolation between the two installations. Refuses an unpinned CLI without running it. No Docker, model or MCP server is used. |
| `bun run browser:install` | Downloads the pinned Playwright headless Chromium (once, into Playwright's user cache). |
| `bun run test:container` | Builds the image and smoke-tests the isolated Compose topology, including the served console and the Host/Origin checks and runtime facets with synthetic inputs (below), then rehearses an image rollback and a configuration-only rollback over preserved storage. Stops at the first failed check. Requires Docker. |
| `bun run acceptance:anthropic` | The live trial's operator tool (Anthropic by default; `--provider openai --ceiling <n>` for OpenAI); use only as the [checklist](deploy/runtime/anthropic-acceptance.md) describes, after fresh authorization. Its `report` only reads two named runs. |
| `bun run provenance:anthropic` | Maintenance only, uses the network: re-verifies the subscription package's recorded upstream baseline, or lists what differs at a candidate revision (see [PROVENANCE.md](packages/anthropic-subscription/PROVENANCE.md)). Never part of `check`. |

Turbo caching is **local only** (remote caching and telemetry disabled). Package tasks are invalidated by
changes to their workspace dependencies' sources and to shared configuration (`bun.lock`, `bunfig.toml`,
`mise.toml`, root `package.json`, `tsconfig.base.json`). A cache hit restores `dist/` — server bundle, console page
and assets, operator command and execution manifest. Because cached results are replayed logs, acceptance evidence
uses `check:verify`. Build caching and run continuation are separate: a console-only change rebuilds the image but
does not change any execution manifest, so paused runs stay answerable; a change to execution code — including a
contracts module the server's execution uses — does change it.

The integration, container and facet launchers accept no arguments, never read `.env`, forward only an allowlisted
environment, and refuse to start if storage, Compose, credential, provider or facet-CLI variables (for example
`DATABASE_URL`, `PG*`, `COMPOSE_*`, `AGENT_RUNTIME_*`, `ANTHROPIC_*`, `FACET_*`) are set. Each run uses a uniquely named
Compose project with fresh storage and removes only what it created. The container smoke replaces the
Tailscale daemon with an inert namespace holder, so it performs no tailnet login and proves Docker topology,
not real Serve/HTTPS behavior.

**Runtime facets in the container.** The suite builds the synthetic MCP server into a disposable directory and
mounts it read-only beside the image's own (empty) program directory, and mounts a synthetic sealed installation
through `compose.facets.yaml`. It checks that the image ships only the selected programs, digest-named; that reading
the catalog starts nothing; that `auth mcp set` stores a credential from standard input only while the runtime is
stopped; that explicit inspection starts the approved server once and leaves no process behind; that a tampered or
missing program, or a tampered bundle, is refused without starting anything while goal runs stay ready; and that a
missing bundle file stops the container from starting. A second helper (`tests/container/mcp-state.ts`) starts the
server through the runtime's own launch and call code to check its working directory, `HOME`, `TMPDIR` and
environment, and that data it stores survives restarts and image replacement. No tool is granted and no model is
involved.

**Rollback rehearsal.** The container suite builds two images from one disposable copy of the build context; the
second differs only in the console page's title, so both ship identical execution manifests for both providers
while having distinct image IDs. With the runtime stopped, a test-only helper (`tests/container/rollback-state.ts`,
bundled and mounted read-only into a one-off container) writes synthetic credentials and records one run per
provider and one command run with a retained capability snapshot, each cancelled before any work, through the
runtime's own stores. The runtime then moves from the first
image to the second and back over the same database and private-state volumes. At each step the suite checks the
running image ID and served title, readiness of both providers, that the database and private-state volumes are the
same, and that a read-only fingerprint of every recorded run, event, invocation, definition, retained capability record and
provider and MCP credential file is unchanged, with no model attempt. Finally, a configuration-only rollback removes
`capabilities` from the configuration and restarts: new command starts and inspection are refused, while the command
run's retained capabilities stay readable and the fingerprint is unchanged. All fixture networks are internal. This
shows that a compatible image can be rolled back on preserved storage; it is not a rollback of a live deployment,
does not show compatibility with older execution code (a changed execution manifest refuses waiting runs instead) or
with a binary that predates the current schema, and leaves crash, question and cancellation semantics to the
integration suites.

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

Migration 4 adds the records for facet-backed command runs: content-addressed capability snapshots (the exact
definitions a command run retains), each command run's binding to its snapshot, run actors (every run's root
agent and any delegates) and loaded-skill membership. It also adds actor attribution to operations, model attempts
and questions, and a dispatch-intent state for external calls. Existing runs gain a root actor and nothing else:
their events, answers, results, provider bindings and execution definitions keep their recorded bytes. Snapshots
are never garbage-collected, and removing installed facets does not remove them.

Migration 5 widens the recorded tool-name bound to 197 characters for canonical MCP tool names; no row is rewritten.

Migrations only move forward. There is no down-migration: a build that predates a migration refuses a database that
has it (`schema_incompatible`) before changing anything, so rolling back the image after upgrading needs a build that
knows the newer schema. Preserved credentials and history are never rewritten or deleted by an upgrade.

Run records (runs, questions, invocations, model attempts, tool operations, events, execution definitions, and the
capability records above) are validated both by runtime decoders and by database constraints; see
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
  `codex-responses-v1` (OpenAI); see [Providers](#providers). Only `authMode: "subscription"` exists — there is no API-key mode and no billed
  fallback. At startup the runtime logs each configured provider's readiness (`provider_readiness`): a provider is
  `ready` with a usable stored credential (an expired access token still counts; it renews on use) and
  `reauthorization_required` without one. A profile ID this build does not implement (including the retired
  `codex-0.151.0`) makes the provider `integration_unavailable`, whatever authorization is stored.
  Such configuration is still accepted, and the configured default provider is never silently replaced.
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
enables the LangSmith gateway (`LANGSMITH_GATEWAY`), disables or replaces TLS verification
(`NODE_TLS_REJECT_UNAUTHORIZED`, `NODE_EXTRA_CA_CERTS`, `SSL_CERT_*`), sets an OpenAI organization or project
(`OPENAI_ORGANIZATION`, `OPENAI_ORG_ID`, `OPENAI_PROJECT`, `OPENAI_PROJECT_ID`), or turns on request logging
(`ANTHROPIC_LOG` or `OPENAI_LOG` below `warn`, `BUN_CONFIG_VERBOSE_FETCH`, `DEBUG`). Ambient API keys such as
`ANTHROPIC_API_KEY` and `OPENAI_API_KEY` are ignored: nothing reads them, and providers are selected only from this
configuration.

### Capability configuration

An optional `capabilities` section holds the owner's grants for facet-backed command runs. Without it the
deployment is goal-only, exactly as before, and goal runs never use these grants.
[`deploy/runtime/config.capabilities.example.json`](deploy/runtime/config.capabilities.example.json) shows every
setting with placeholder digests:

- `installation`: the absolute path of the sealed `installation.json` and its pinned SHA-256 (see
  [Runtime facets](#runtime-facets)).
- `allowSkills`, `allowAgents`: the skills and agents (`skill:<name>`, `agent:<name>`) runs may use.
  `maxDelegationsPerRun` defaults to 8, at most 32.
- `localPrograms`: deployment-supplied MCP server bundles by program ID. Each `bundlePath` must end in
  `<programId>/<sha256>.js`, and the bundle's bytes must match `sha256` before it is started.
- `servers`: one entry per installed server. `programId` names the bundle that runs for it; the facet's own
  `command` never runs. `literalEnv` holds non-secret settings, and `credentialEnv` maps environment variables to
  private credential slots. `toolTimeoutSeconds` is the per-call deadline (default 60, at most 300). There is no
  working-directory setting.
- `approval` is either `{ "kind": "denied" }` or `{ "kind": "approved", "serverDigest", "tools" }`. Approving a
  server permits connecting to it; each entry in `tools` permits calls to one tool, identified by name and the
  `definitionDigest` of its exact advertised definition. An empty `tools` list permits discovery only.
  `argumentEquals` restricts named top-level arguments to exact scalar values, compared without coercion, for
  example `{ "repository": "owner/repo-a" }`. No other kind of restriction exists.
- A changed server declaration needs a new `serverDigest`, which blocks all of that server's tools until then. A
  changed tool definition needs a new `definitionDigest` for that tool only. Grants are read at startup:
  revoking one takes effect on restart, and new grants never widen a run that was already accepted.
- Refused: unknown settings, duplicate servers or tool grants, a denied entry carrying grants, an environment
  variable set as both a literal and a credential, a recognizable credential in a literal value, and any attempt to
  set process identity, location, loader, proxy, TLS, tracing, debug, provider, database or runtime settings
  (`HOME`, `PATH`, `TMPDIR`, `NODE_*`, `BUN_*`, `LD_*`, `*_PROXY`, `DEBUG`, `ANTHROPIC_*`, `PG*`, `RUNTIME_*` and
  similar).

**MCP credentials** live in private slots, never in the configuration. Provision one with the runtime **stopped**,
reading the value from standard input (never from arguments), for example from a file:

```bash
bun dist/auth.js mcp set repo-token < /path/to/token-file    # inside the application image, runtime stopped
bun dist/auth.js mcp status repo-token                       # missing, present or unusable; never the value
```

`set` accepts 16 to 16,384 printable, non-space ASCII characters, and needs `DATABASE_URL`. It takes the runtime's
singleton database ownership for the write, without migrating or changing the owner epoch, so it refuses while the
runtime (or another `set`) is running. The value takes effect when the runtime next starts. Neither command makes a
network request, and nothing deletes a slot.

## Runtime facets

Commands, skills and agents for the runtime come from a dedicated facet project,
[`deploy/runtime/facets/`](deploy/runtime/facets/README.md). It has its own manifest and lockfile and is installed
with the pinned `facet` CLI into an isolated, absolute `FACET_DIR`. It stays separate from the editor facets in the
repository root and from their materialized copies, which the runtime never reads. The `agent-runtime` adapter
exports each contribution. `bun packages/facet-adapter/src/cli.ts seal` then joins the exports to the recorded
manifest and lockfile and writes one canonical `installation.json`. The owner pins that file's SHA-256.

- Runtime behavior comes only from an explicit `agent-runtime` block (`runtimeVersion: 1`) in a facet's
  `facet.json`. Unsupported settings, missing prerequisites and requirement cycles refuse that contribution, with a
  reason, rather than being ignored. Facets written for coding tools usually need explicit runtime adaptation.
- Installing a facet grants nothing. Installation never starts a run or launches a declared MCP server.
- The lockfile (version 0.4) records every MCP server each facet declares. The seal joins each selected server's
  exported declaration to every facet that declares it and refuses any missing, extra or edited server export.
  Selecting a server does not approve it; approval lives only in [operator configuration](#capability-configuration).
- Generated exports and `installation.json` are local artifacts and are never committed. The runtime reads the
  pinned bundle afresh for each new command start; an accepted run keeps the definitions it retained.

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
throttled — keeps the credential for a later attempt. Login and refresh are implemented for both providers (see
[Providers](#providers)).

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

**MCP credentials** live under `RUNTIME_STATE_DIR/mcp-credentials/<slot>.json` (`{ "version": 1, "value" }`) with
the same private-file rules and atomic replacement as provider records. The runtime reads the configured slots once
at startup, after it owns the database, and screens their values for the rest of its life, like provider
credentials: in goals, answers, tool arguments, declarations and results. A missing slot holds nothing to screen
(its server cannot start). If a configured slot is unusable, every goal and answer is refused as unscreenable until
it is fixed, and startup logs `mcp_credentials_unusable`.

**MCP servers** (the boundary used by facet-backed command runs) are local stdio programs only; HTTP declarations,
OAuth, server-initiated sampling, elicitation and roots, resource reads and asynchronous tasks are refused. One
module starts them: the owner-bound bundle is verified against its configured SHA-256 and run by the runtime's own
pinned Bun with `--config=/dev/null --no-install --no-env-file`, from `RUNTIME_STATE_DIR/mcp/<serverId>/` with
`HOME` and `TMPDIR` in its `home/` and `tmp/` (owner-only, kept across restarts, refused rather than repaired when
unsafe). The argument vector is fixed (no shell). The environment is built from nothing: fixed identity values,
the declaration's and owner's literals (which must agree) and that server's own credentials; nothing of the
runtime's environment, including provider credentials, is passed on. Standard error is discarded.

- Discovery and initialization share one 15-second deadline, at most eight listing pages and 128 tools, and one
  incoming message is at most 1 MiB. A tool definition is at most 32 KiB, with input schemas limited to a closed
  subset: object roots, scalar types (or a scalar paired with `null`), nested objects, single-schema arrays,
  `required`, `additionalProperties` as a boolean, `enum`/`const` and numeric, length and item bounds. References,
  `anyOf`/`oneOf`/`allOf`, conditionals, patterns and formats are refused, and such a tool is unavailable.
  Arguments are validated against the raw approved schema as given: no defaults are inserted and nothing is
  coerced.
- A call is exactly one request, with no retry, reconnect or resource fetch, within the server's
  `toolTimeoutSeconds`; progress notifications cannot extend it. Arguments are at most 32 KiB and are refused if
  they carry credential material. Only text and JSON results are used: text is screened whole and then clipped to
  the 64-KiB result limit, and structured content carrying a credential is withheld. A server's error reply
  becomes a fixed message. If a call was sent but its completion cannot be established (deadline, cancellation, a
  lost connection or a reply over 1 MiB), the outcome is uncertain, and the process is closed and awaited.
- Grants restrict what the runtime **sends**. A server is trusted, unsandboxed code running as the runtime user,
  with that user's access to other writable runtime locations; its data directory is a location, not a sandbox.
- In a command run, each granted tool is offered to the model as `mcp_<serverId>_<toolName>`, spelled exactly as
  declared (at most 197 characters); the run's history and saved state use that name, and the server receives its
  own tool name. Two servers' tools with the same such name are both left unbound (a command requiring one is
  refused); a tool is always dispatched by its recorded server and tool, never by splitting its name.
- A new call is checked in order: an exact completed call is answered from its record (even after a grant was
  revoked, and without contacting the server); otherwise the run's original authority narrowed by the owner's current
  grants and the command's and agent's restrictions, the approved raw schema and argument restrictions, credential
  screening, and the server still advertising the approved definition. Matching calls need no confirmation; a
  workflow's own questions are separate. Only then is the dispatch **intent** recorded and the one request sent,
  inside the run's dispatch gate, so an accepted cancellation can never fall between them; waiting for the reply
  happens outside it. The outcome is recorded before the model sees it.
- One run invocation starts each approved server lazily, shares it between the root agent and its delegates, makes
  one call at a time on it and closes it when the invocation ends — at a question, at the end or on failure. Nothing
  reconnects or retries; server data in its directory survives, MCP session state does not.
- **An uncertain outcome ends the run** as `tool_failure` / `mcp_outcome_unknown` (unless cancellation already
  decided it), with no further model turn: the runtime does not know whether the external action happened, so it
  neither retries nor lets the agent try to recover. Whether and how to check or repair the external system is the
  owner's decision. The same applies to an intent left without an outcome by a crash, which startup records as
  uncertain.

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
- **Delegation (command runs only).** A command run's root agent can call `mcp_Delegate` with one of the run's
  retained agents and a bounded task (8 KiB), as the only call in its response, and waits for it. The delegate is
  another stock `createAgent`, invoked from inside that tool call on the run's thread, saver, provider binding,
  invocation, cancellation and budget — not a separate run or scheduler. It receives the fixed delegate instructions,
  its retained agent instructions and the task, not the caller's conversation; its tools are the caller's narrowed
  by the agent's restrictions, and it has no delegation tool (one level deep). A run has at most 8 delegations by
  default (1–32, retained with the run); a further one, or an unavailable agent, is refused before any work starts.
  Each call to an agent is its own delegation, identified by its parent tool call. Its result, or an identified
  failure (for example a result too large to return), is returned to the caller, which continues; budget, provider,
  storage and unsafe-state failures still end the run. Only a new final message from the root can be the run's
  result. Goal runs have no delegation and keep exactly the three native tools.
- **Command runs.** A command start names an installed command, the selection revision it was offered under (a
  digest of the pinned installation and the command ID, so any installation change makes older selections stale)
  and raw argument text. A retried request is resolved by that normalized submission before anything current is
  read, so it returns the original run even after the installation changed or vanished, or a provider or server
  became unavailable. A new start then requires: arguments free of credential material; the current revision; a
  usable command; a rendered goal (the literal `$ARGUMENTS` replaced by the text, or the text appended under an
  `## Owner input` heading; required arguments must be non-blank, and the result at most 8 KiB, never truncated);
  provider and workspace readiness; and, for each MCP tool the command requires, a connection-approved server whose
  current declaration and program match the approved digest and a grant for the tool's current definition, checked
  by one bounded inspection (start, initialize, list, close; nothing is called). Servers needed only by optional
  tools are not started. The run then retains, atomically with its acceptance, every definition it may use — the
  ready skills and agents currently allowed and their own prerequisites, unloaded skill instructions and resources,
  bound tool definitions and the authority ceiling — so it never needs the installation again. A refused start
  never becomes a free-form goal or another command.
- **Skills (command runs only).** An actor sees its skills by ID and description in `mcp_LoadSkill`. Loading one
  returns its retained instructions and reference paths, and records the actor's membership in the same commit as
  the outcome (repeated loads keep the first). `mcp_ReadSkillReference` returns numbered lines of a loaded skill's
  UTF-8 reference from the retained bytes (never the filesystem), screened as a whole before paging (at most 2,000
  lines and 64 KiB per call). Eligibility is the membership frozen on the response that issued the call, so a skill
  loaded in the same response can be read from the next one. Loading grants nothing else.
- **Budget.** The default is 50 model requests. The run reports `{ maximum, consumed, unconfirmed }`; an admission
  whose dispatch was never confirmed stays charged as unconfirmed. Tool calls from the last permitted response still
  run; only another model request fails the run with `step_limit`. An answer can be accepted with no steps left.
  Delegates' requests (and their renewal retries) are charged to the same budget with the same ordinals; delegating
  itself and tool calls cost nothing.
- **Questions.** A question becomes answerable only after the invocation has settled, read-only inspection has
  confirmed the saved interrupt, and one transaction has recorded it and moved the run to `waiting`. An answer
  names its run and question; an already-answered question acknowledges an identical answer (even after the run
  finished) and refuses a different one before anything else is checked. Before acceptance the runtime rebuilds
  the run's stored provider binding (never current defaults), compares the execution definition and re-inspects
  the saved state without running the graph: a temporary inability to look accepts nothing and changes nothing,
  while confirmed missing, unusable or incompatible state closes the question and fails the run as
  `continuation_unavailable`. `false`, `null`, `0` and permitted empty text are answers. The accepted answer is
  delivered once, to the saved interrupt by its ID. A delegate's question pauses the whole run and names the
  delegate that asked; the root's delegation call stays open meanwhile. Because the root's state does not reveal a
  delegate invoked from a tool, verification rebuilds that delegate from the run's retained definition and inspects
  its saved state directly, requiring both saved heads to agree. The answer is still delivered through the root, by
  interrupt ID, and reaches the delegate that asked; completed tool calls are answered from their records.
- **Compatibility.** The execution definition covers the Bun version, the exact package versions and integrity
  values used by the execution code, digests of that code's own import closure (line endings normalized), the
  generated graph, middleware, tool schemas, the prompt, protocol versions and the run's binding. There is one code
  manifest per provider — the common execution closure plus that provider's adapter, following workspace packages
  into their source (so the Anthropic manifest includes the subscription package's files) — written at build time
  beside the bundle (`dist/execution-manifest.json`). A change to one provider's adapter does not refuse runs bound
  to the other. Browser code, documentation, tests and default settings are not inputs. A command run's definition
  also covers its retained snapshot digest and the delegation and skill protocols, but not the owner's current
  grants: those are checked when a new load, read or delegation runs, after any recorded replay, so a revocation
  takes effect on restart without making waiting runs incompatible. Updating or removing the installation does not
  affect accepted runs.
- **Cancellation** is recorded before it is acknowledged and serialized with admissions, so nothing is dispatched
  after it. A waiting run is cancelled at once; a working run is `cancelling` until its request bodies, tool calls
  and checkpoint writes — including a delegate's — have actually settled. An answer accepted earlier stays accepted.
  A delegate active or waiting at cancellation is recorded abandoned, and its late result cannot resume the caller.
- **Outcomes.** Success requires a new final assistant message from this invocation, recorded in history; a
  continuation that does nothing is a `runtime_failure`. Failures are classified from typed evidence only (see the
  categories in [`architecture/09`](architecture/09-data-model-and-lifecycle.md#phase-1-lifecycle-as-built)). If a
  final commit's outcome cannot be established, the service stops rather than guess.
- **Restart.** Before it reports ready, startup marks runs that were working as `interrupted` (their accepted answers
  kept, admissions never confirmed as sent recorded unconfirmed) and runs whose cancellation was accepted as
  `cancelled`. A delegate still running is recorded abandoned, and an external call whose dispatch may have begun
  is recorded with an unknown outcome rather than as sent, completed or unsent. Waiting and finished runs are
  unchanged. Nothing is resumed, retried or dispatched.

The run service (`src/service/runs.ts`) composes all of this for the API: it admits the workspace afresh for each
start and continuation, builds each invocation from the run's stored binding through the provider assembly
(`src/providers/assembly.ts`), and dispatches work in the background, so it never depends on the request — or any
browser — that caused it. Verification with provider-free models, including every crash window, is recorded in
[the G3 evidence (2026-09-30)](architecture/integration-evidence/mvp-01/g3-dispatch-lifecycle.md).

## Browser console and API

Open the console at the `RUNTIME_PUBLIC_ORIGIN` address from any device on your tailnet. It lists runs (goal,
provider, status, start and last-activity times), starts a run, and shows one run: its status, budget
(`consumed` of `maximum`, plus any `unconfirmed` admissions), provider and workspace, history with recorded times,
the pending question (and, in a command run, which agent asked it), the final result or failure with its category
and guidance, and a cancel button. Text from the model, tools, workspace and installed facets is rendered as plain
text; nothing is interpreted as markup or loads external resources.

**Starting from a command.** The start form offers a free-form task (the default) or an **Installed command**:
choose one, read its description and origin, and enter its raw argument text (required or optional, as the command
declares). The provider choice and **Connect** buttons are shared by both. The installed commands are read only when
command mode is chosen, and again only with **Refresh commands**. A refused command — changed since it was shown,
missing a prerequisite, or with unusable arguments — is reported and never started as a free-form task instead. If
a start's reply is lost, **Retry same start** sends exactly what was submitted, with the same request identity,
whatever has been refreshed or edited since.

**Installed capabilities** (a collapsible panel under the start form, read when opened) lists every installed
command, skill and agent with its facet and version and whether it is ready, refused (with the reason) or not allowed
by the owner's configuration; and every MCP server with its connection approval (approved, denied, not configured,
needing approval again, or program unavailable — with the current approval digest to review), its configured tool
grants and argument restrictions, and the tools its last inspection listed. **Inspect server** is offered only for an
approved connection: it starts the server briefly to list its tools (their definitions and digests, and whether each
is granted for exactly that definition), then closes it. It calls nothing and approves nothing; grants change only in
[operator configuration](#capability-configuration). Inspection results are kept in memory for display until the
runtime restarts.

**A command run's capabilities** appear in a panel on its page: the command and its arguments, the definitions the
run retained (skills, agents and tools, each with its facet and version) and whether each was actually used, its
delegations and their outcomes, the recorded outcomes of its tool use (completed, refused, failed, unknown or
without a recorded outcome), its limits, and its permissions — those it was accepted under, and the owner's current
configuration, which new operations must also satisfy. It is read from the run's own records, so it stays the same
after the facet is updated or removed, and reading it starts nothing. History entries name the facet each skill,
agent and tool came from.

**Connecting Anthropic.** When Anthropic needs authorization, the start form says so and offers **Connect
Anthropic**: open Anthropic's sign-in in a new tab, approve access with your Claude account, then copy the code
Anthropic shows and paste it into the console's code field. The provider then shows as ready, with no terminal and
without starting a task; **Reconnect** replaces a working authorization the same way. Details under
[Providers](#providers).

You can close the page at any time — the run continues — and reopen it later: the console reads a snapshot,
fills in history up to it, then follows the run's event stream from there. Whether the page is connected is shown
separately from the run's status; a dropped connection never shows a run as finished or failed. Questions accept
exactly the declared answer types: choices keep their JSON type (`false` is not `"false"`), text is sent as typed,
and multiple choices as the selected values.

The API (`/api/v1`, JSON only):

| Route | Purpose |
|---|---|
| `GET /options` | Workspace label and availability, configured providers with their readiness, the default budget and any ceiling |
| `GET`, `POST /runs` | List runs (newest first, paginated); start one with `{ requestId, goal, provider }` or `{ requestId, provider, command: { id, selectionRevision, arguments } }` (exactly one form) |
| `GET /runs/:runId` | A consistent snapshot of one run and the last history event it includes (`throughSeq`) |
| `GET /runs/:runId/capabilities` | `native` for a goal run; for a command run its retained definitions, recorded use, limits and captured/current permissions, with the history boundary it includes (`throughSeq`); `unavailable` if its retained definitions cannot be verified |
| `GET /capabilities` | The installed catalog (`unconfigured`, `unavailable` or `ready` with its `catalogRevision`), servers with connection approval, grants and the last inspection; starts nothing |
| `POST /capabilities/servers/:serverId/discover` | `{ catalogRevision }`: inspect one approved server (initialize, list tools, close); `409 capability_selection_changed` if the catalog changed since it was shown |
| `GET /runs/:runId/events` | Committed history after a cursor, optionally up to a fixed bound |
| `GET /runs/:runId/stream` | Server-sent events: replay after the cursor (`after`, or the browser's `Last-Event-ID`), then the live tail; a comment heartbeat every 15 seconds |
| `POST /runs/:runId/questions/:questionId/answer` | `{ answer }` for that exact question |
| `POST /runs/:runId/cancel` | `{ requestId }` |
| `POST /auth/anthropic/begin` | `{}`: start connecting Anthropic, or return the login already in progress, with Anthropic's sign-in URL |
| `POST /auth/anthropic/complete` | `{ attemptId, code }`: exchange the pasted code once; `202` while it is still completing |
| `POST /auth/anthropic/status`, `…/cancel` | `{ attemptId }`: read a login's state, or close one still waiting for its code |

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
  Command starts add `command_arguments_invalid` (`400`), `capability_selection_changed` and
  `capability_unavailable` (`409`, with the affected `subject` such as `skill:review` or `mcp:github/list_issues`),
  and `capabilities_unavailable` or `mcp_server_unavailable` (`503`). A retried command start with the same
  `requestId` is answered from the record before the installation or any server is consulted.
- **Replay** reads committed history from the database after the client's cursor, so a reconnect, or an event
  recorded between a snapshot and its stream, is delivered exactly once. A cursor beyond recorded history is
  `409 cursor_ahead`. If storage fails mid-stream, the stream sends an unsequenced `availability` notice and
  closes without advancing the cursor. The stream is produced only as fast as it is read.
- **Requests from elsewhere** are refused: a request must name the configured address (or loopback, for health
  checks and in-container tools), and anything that changes state must also carry that same `Origin` (not `null`,
  not another site). Forwarding headers are ignored, and no response grants cross-origin access. Responses carry a
  restrictive content security policy and framing, referrer and sniffing protections.

## Providers

Anthropic uses the stock LangChain chat model for its API (`ChatAnthropic`) with its SDK `fetch` set to the guarded
terminal. The runtime owns credentials (storage, locking,
refresh, screening), admission and the one renewal retry; provider code only adapts requests, classifies failures
and checks that a response ended completely. Response bytes are never rewritten; the only change to a parsed
response is the tool-name translation below. Each model is built per run from the
run's stored model and profile, with an inert sentinel API key (so no ambient key is ever looked up), an explicit
endpoint (so neither the environment nor a gateway can redirect it) and retries off.

**Tool names.** The runtime's tool names are canonical (`mcp_Read`, `mcp_<serverId>_<toolName>`, …) everywhere it
records them. A provider whose wire contract cannot carry a name translates it for one model call only: names it
accepts stay unchanged, others are sent as short aliases (`mcp_Alias_<n>`) that no other name in that call uses, and
the parsed response's tool names are restored before the response is screened, stored or acted on. Only structured
name fields change — offered tools, a tool choice and earlier calls replayed in the request — never call IDs,
arguments, results or text. A renewal retry re-sends the same names; root, delegate and concurrent calls never share
a mapping. A response naming a tool under a name that call did not offer is refused (an unknown name as an
unavailable tool; a canonical name the call only offered under its alias fails the call). Anthropic accepts its
profile's `mcp_` + capital-letter convention; OpenAI accepts the SDK's documented function-name form (letters,
digits, `_` and `-`, at most 64 characters). Neither rule has been checked against the live services.

**Anthropic** (profile `claude-cli-2.1.280`). Authorization and the request profile come from
[`packages/anthropic-subscription`](packages/anthropic-subscription/README.md), a minimal, project-maintained
derivative of `@ex-machina/opencode-anthropic-auth` 2.0.0-next.5. It is updated only by manual review
([provenance and intentional differences](packages/anthropic-subscription/PROVENANCE.md)); it follows no npm tag
and recovers from no version rejection by itself. Requests carry the reference client's headers, betas, identity
and billing blocks, with tool names in the profile's convention (others travel under aliases, as above); a
conversation must open with the user's text,
because the billing block derives from it. A client-version rejection fails the run as an unsupported
model/profile; updating the profile is a reviewed package change with a new profile ID.

**Log in from the console** (the normal way): **Connect Anthropic** on the start form opens Anthropic's sign-in
in a new tab. Anthropic's page then shows a code (its fixed callback page, not a redirect back to the console);
paste it into the console's code field. How it behaves:

- A login waits up to ten minutes for its code. While it waits it holds no credential lock, so runs and renewals
  continue. Pressing Connect again (after a reload, say) returns the same login rather than starting a second one.
- The code is exchanged **once**. A code from a different sign-in is refused before anything is sent; after that,
  a refusal, a throttle or an exchange whose outcome is unknown ends the login, and a new login is needed. A code
  that may have been used is never sent again. Only after the new authorization is durably stored does the console
  say connected; an unsuccessful login leaves any earlier authorization as it was.
- Unfinished logins live only in the runtime's memory: a restart forgets them (saved authorization is unaffected).
- The code goes only to the login endpoint. It never becomes part of a task, history, logs or browser storage, and
  responses never echo it. Token values stay on the server; the browser sees only the login's state.

**Or from a terminal** (fallback). The command prints the same URL and reads the pasted code; it shares the
runtime's credential lock, so it can run while the service is up:

```bash
docker compose exec -it runtime bun dist/auth.js anthropic login     # inside the running application container
docker compose exec runtime bun dist/auth.js anthropic status        # safe status only; never refreshes
docker compose exec runtime bun dist/auth.js anthropic renew         # renew now: one token request, no model request
bun packages/runtime/src/auth.ts anthropic status [--slot s]         # from a checkout (RUNTIME_STATE_DIR, RUNTIME_CONFIG_FILE)
```

Token values are never printed. A rejection right after a renewal is definitive: the slot is marked as needing
reauthorization, and later runs fail with authorization guidance without sending anything. `renew` exists so a
real renewal can be exercised deliberately; ordinary use never needs it, because access renews itself within five
minutes of expiry. Like any renewal, one whose outcome is unknown marks the slot as needing a new login.

**OpenAI (ChatGPT subscription).** Sign-in is a device login with nothing to paste back and no callback: **Connect OpenAI** on the start form (or
`auth openai login`) shows a link to OpenAI's device page and a short code; enter the code there from any browser
and approve, and the runtime notices the approval itself and stores the authorization (`auth openai status|renew`
work as for Anthropic). The device protocol is the project's own TypeScript, not a library's; the account ID it
stores comes from the decoded ID token, whose signature is not verified. Inference is the stock `ChatOpenAI`
(`@langchain/openai` 1.6.2, `openai` 7.28.0) in streaming Responses mode, pointed at the ChatGPT Codex backend
(`https://chatgpt.com/backend-api/codex/responses`) through the same guarded terminal, with stateless replay
(`store: false`, encrypted reasoning) and only public library settings, with retries off. The terminal supplies the
token and account header from one credential generation; requests identify the application as `agent_runtime`,
carry the run as their session and thread, and do not imitate a Codex client. A response counts only when the
library's own parse reports it `completed`: anything else fails the run before the response is stored or any tool
in it runs. This uses the same Codex backend the Codex CLI uses with a ChatGPT sign-in; it is not OpenAI's API-key
platform and not a vendor-documented third-party interface, so it can change without notice. Use the profile
`codex-responses-v1`. An earlier build reached OpenAI by imitating the Codex CLI, and every real model request it
made failed as incomplete ([evidence](architecture/integration-evidence/mvp-01/g5-openai-live.md)); that wrapper
stays removed. Runs it recorded (profile `codex-0.151.0`) stay readable, and a question they left waiting cannot be
answered (answering closes the run as `continuation_unavailable`); they are never rebound to the current profile.
Saved OpenAI authorization is the same subscription sign-in either way and was kept without conversion.

Offline verification runs the stock model inside the stock agent against scripted provider streams
(`src/providers/anthropic/inference.test.ts`, `src/providers/openai/inference.test.ts`, and the production assembly
on the official saver in `tests/integration/provider-assembly.integration.test.ts`). Live and deployment checks are
recorded, with what each observed and its exceptions, in [`architecture/integration-evidence/`](architecture/integration-evidence/)
— for example [G4 live](architecture/integration-evidence/mvp-01/g4-anthropic-live.md) and the
[OpenAI recovery record](architecture/integration-evidence/mvp-01/g5-openai-recovery.md). A recorded live check
applies to the build it names; live checks happen only with the owner's fresh authorization.

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
that output into the runtime image. There is no separate frontend server. It also builds the MCP server programs
selected in `packages/mcp-programs/src/programs.ts` (none yet) and copies them, with their manifest, read-only to
`/opt/agent-runtime/mcp/<programId>/<sha256>.js`. Test servers never enter the build context, and nothing is installed
or downloaded when a server starts.

```bash
cp .env.example .env   # set the workspace, configuration path, tailnet name and a generated POSTGRES_PASSWORD
cp deploy/runtime/config.example.json /path/to/config.json   # then choose the model; see Configuration
docker compose up -d --build
docker compose logs tailscale   # first start: open the printed login URL to join your tailnet
# then open the console and press Connect Anthropic (or use the terminal login under Providers)
```

`AGENT_RUNTIME_PUBLIC_HOST` must be the full tailnet name Serve publishes (`<TS_HOSTNAME>.<your-tailnet>.ts.net`);
the console only answers requests addressed to it. Restrict the machine to your own devices with your tailnet access
policy. This deployment has been verified with a real tailnet node, Serve HTTPS and a second device, including the
live Anthropic journey and restart/recreation of the runtime container
([evidence](architecture/integration-evidence/mvp-01/g4-anthropic-docker-tailnet.md)). Enrolling the Tailscale
container: open the login link it prints (`docker compose logs tailscale`), or, if you cannot complete that sign-in,
generate a one-time auth key in the Tailscale admin console and run
`docker compose exec tailscale tailscale login --auth-key=<key>` (do not run the console's install script on the
host; only the container should join).

### Runtime facets in a deployment

Without runtime facets, use `compose.yaml` alone and leave `capabilities` out of the operator configuration. To
offer commands, seal an installation (see [Runtime facets](#runtime-facets)), set `AGENT_RUNTIME_FACETS` to the
bundle's absolute host path, and select the overlay on every Compose command:

```bash
docker compose -f compose.yaml -f compose.facets.yaml up -d --build
```

The overlay mounts the bundle read-only at `/etc/agent-runtime/facets/installation.json`; a missing file stops the
runtime container from starting instead of mounting an empty path. Name that path and the bundle's SHA-256 in
`capabilities.installation`, and each server's program in `capabilities.localPrograms` by its path under
`/opt/agent-runtime/mcp/` and digest (from the image's `/opt/agent-runtime/mcp/manifest.json`). Then, in order:

1. Start the runtime with the server's connection approved and no tools granted, and press **Inspect server** in the
   console. Inspection starts the server once, lists its tools and closes it; it calls nothing and approves nothing.
2. Copy the digests of the reviewed tools into `capabilities.servers[].approval.tools`, with any argument
   restrictions.
3. Provision the server's credentials with the runtime stopped, then start it again:

   ```bash
   docker compose -f compose.yaml -f compose.facets.yaml stop runtime
   docker compose -f compose.yaml -f compose.facets.yaml run --rm --no-deps -T runtime \
     bun dist/auth.js mcp set repo-token < /path/to/token-file
   docker compose -f compose.yaml -f compose.facets.yaml up -d runtime
   ```

Each server keeps its data in `/var/lib/agent-runtime/mcp/<serverId>/` (its working directory, with `home/` and
`tmp/` as `HOME` and `TMPDIR`) in the private-state volume. That data survives restarts and upgrades, and nothing
deletes it. No other writable location is added.

**Upgrading and rolling back.** Execution code changed with runtime facets, so a run waiting for an answer under an
earlier build may be refused as `continuation_unavailable` after the upgrade, with its history kept: finish or cancel
waiting runs before upgrading. The upgrade applies migrations 4 and 5, which only move forward. To stop offering
commands, remove `capabilities` from the configuration and restart: new command starts are refused, recorded
history and retained capabilities stay readable, and credentials stay where they are. Rolling the image back past
the migrations is not possible: an older build refuses the upgraded database without changing it. Recovering from
a failed upgrade is an owner decision; there is no backup, restore or down-migration tooling, and nothing is
deleted automatically.

Health endpoints: `/healthz` (liveness) and `/readyz` — ready (`200`) only when persistence is ready, agent execution
is configured and composed, and the console is loaded; each is reported in `checks`. Provider authorization is not
part of readiness: an unauthorized provider is shown in the console and refuses starts.

### Troubleshooting

| Symptom | Cause and remedy |
|---|---|
| The console answers `403` | The address is not `RUNTIME_PUBLIC_ORIGIN`, or a change came from another page. Use exactly the configured tailnet name. |
| Starting a run reports the provider unavailable | No usable authorization: press **Connect Anthropic** or **Connect OpenAI** on the start form (or run `auth <provider> login`); `auth <provider> status` shows the slot's state. |
| OpenAI shows “integration unavailable” | The configured profile is not one this build implements (for example the retired `codex-0.151.0`). Configure `codex-responses-v1`. See [Providers](#providers). |
| The console login says the code is not from this sign-in | The pasted text is from another (older) sign-in, or only part of the code was copied. Copy the whole code from the tab this login opened. |
| The console login failed or expired | Press **Connect Anthropic** again for a new sign-in. A failed login never retries its code. |
| `auth mcp set` says to stop the runtime first | The runtime (or another `set`) owns the database. Stop the runtime, run `set`, then start it again; nothing was changed. |
| Every goal is refused as unscreenable and startup logged `mcp_credentials_unusable` | A configured MCP credential slot cannot be read safely (permissions, owner, links or an invalid record). Check it with `auth mcp status <slot>`, fix its storage or set it again with the runtime stopped. |
| Input is refused as unscreenable | A credential record cannot be read or is invalid. Check `auth … status`, and log in again. |
| The page shows “Reconnecting” | The connection dropped; the run is unaffected and the page catches up when it reconnects. |
| `503 acceptance_unknown` | Storage could not confirm a change. Repeat the same action; it cannot be applied twice. |
| A command start says the installed commands changed | The pinned installation changed since the commands were shown. Press **Refresh commands**, review the command and start again. |
| A command is unavailable or names a missing prerequisite | The `subject` names what is missing, refused or not granted. Check **Installed capabilities**; grants and allowed skills and agents change only in operator configuration (restart to apply). |
| The installed commands cannot be read | The pinned bundle is missing, unreadable or does not match its configured SHA-256. Free-form tasks still work. |
| **Inspect server** is not offered, or is refused | The server's connection is not approved for exactly what is installed now: review the shown digest and update `capabilities.servers`, then restart. A server that cannot start reports `mcp_server_unavailable`. |
| `/readyz` stays `503` | `checks` names the part that is not ready; persistence states are described under Persistence. |

## Limitations

- Automated verification uses scripted provider networks and synthetic MCP servers; live behavior is only what the
  recorded live checks observed for the builds they name. OpenAI depends on a backend that is not a documented
  third-party interface (see [Providers](#providers)), and the tool-name forms each provider is sent are local
  choices, not verified provider limits.
- MCP servers are trusted, unsandboxed processes; grants restrict what the runtime sends, not what a server does.
  An external action whose outcome is unknown ends the run; whether it happened is for the owner to check.
- Server inspection results are kept in memory only and are not authority; there is no console for editing grants
  or installing facets.
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
