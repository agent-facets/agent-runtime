# agent-runtime

A personal agent runtime: start a repository task from a browser, leave, return, answer the agent's
questions, and collect the result using an existing Anthropic or OpenAI subscription.

> **Status: foundation, durable persistence and authority boundaries.** The workspace, toolchain, checks, container
> topology, the PostgreSQL persistence layer (runtime ownership, migrations, run records, the official
> checkpointer), operator configuration, private credential storage, and the confined read/search tools and
> secret-safe projections exist as tested components. They are **not yet connected to an agent**: agent execution,
> provider login and inference, and the browser console are **not implemented yet**; they are delivered by the
> remaining tasks in
> [`openspec/changes/mvp-01-interactive-agent-execution`](openspec/changes/mvp-01-interactive-agent-execution/tasks.md).
> The runtime serves only health and readiness endpoints, and readiness always reports `ready: false`.

Further reading:

- [Architecture](./architecture/README.md): design intent and open questions.
- [MVP roadmap](./openspec/roadmaps/framework-mvp.md): proposed scope and sequencing. Where the roadmap and older architecture disagree, the roadmap is current.
- [Spike reports](./architecture/spike-reports/README.md): historical research results. Each report links to its harness.

## Repository layout

A Bun-workspace monorepo orchestrated by [Turborepo](https://turborepo.com), deployed as **one** application.

| Path | Contents |
|---|---|
| `packages/runtime` | The Bun server and sole deployable application: persistence, configuration, credentials, workspace tools and security boundaries today; execution, providers, REST/SSE and operator commands later. |
| `packages/ui` | Browser console package. Currently an empty package boundary; the console arrives in its later block. |
| `packages/contracts` | Not created yet. Browser-safe API schemas/types, extracted when the API is implemented. |
| `scripts/` | Repository checks, fixture launchers and their tests. |
| `tests/` | Explicitly launched integration and container fixtures (never run by ordinary checks). |
| `deploy/` | Deployment configuration (Tailscale Serve). |
| `spikes/`, `architecture/` | Historical evidence and design intent. Not application dependencies. |

Boundaries enforced by tests:

- The UI never imports runtime internals or server-only modules; the runtime uses only the UI's public entry.
- No package imports `spikes/**`.
- node-postgres (`pg`) is imported only by the official checkpointer adapter; application SQL uses Bun SQL.
- Only the application database adapter opens Bun SQL connections, and it exposes transactions and reserved
  sessions but no plain pool (see [Persistence](#persistence)).
- Only the application database adapter starts transactions with `begin()`.
- Workspace tool source contains no process execution, dynamic evaluation or filesystem mutation.
- Internal dependencies use `workspace:*`; root owns development tooling, packages own application dependencies.

## Setup

Prerequisites: [mise](https://mise.jdx.dev), Docker Engine with Compose v2, and (for private access) a
Tailscale account.

```bash
mise trust                                 # mise ignores untrusted project config
mise install                               # installs the pinned Bun 1.3.14
mise exec -- bun install --frozen-lockfile  # reproduces bun.lock exactly
```

Pinned tools: Bun 1.3.14 (`mise.toml` and `packageManager`), Turbo 2.10.4, TypeScript 5.9.3, Biome 2.4.15.
Bun is configured to add exact versions. The LangChain/LangGraph candidate matrix is pinned in
`packages/runtime/package.json` but its Bun compatibility has not yet been verified.

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
| `bun run test:integration` | Starts a disposable PostgreSQL fixture and runs `tests/integration` (persistence, ownership, run records and the G1 gate). Requires Docker. |
| `bun run test:container` | Builds the image and smoke-tests the isolated Compose topology. Requires Docker. |

Turbo caching is **local only** (remote caching and telemetry disabled). Package tasks are invalidated by
changes to their workspace dependencies' sources and to shared configuration (`bun.lock`, `bunfig.toml`,
`mise.toml`, root `package.json`, `tsconfig.base.json`). A cache hit restores `dist/`. Because cached results
are replayed logs, acceptance evidence uses `check:verify`.

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
  there are no built-in defaults. Only
  `authMode: "subscription"` exists — there is no API-key mode and no billed fallback. A configured provider
  reports `integration_unavailable` until its integration is delivered (later blocks).
- The workspace root must be a normalized absolute path that neither contains nor lies inside the runtime state
  directory, and does not contain the configuration file.
- `stepBudget` defaults to 50 model requests per run; `modelRequestDeadlineSeconds` to 300.
- The Compose file does not mount a configuration file yet; that wiring arrives with agent execution.

The runtime refuses to start, before loading any framework or provider code, if the environment enables
LangSmith/LangChain tracing, sets an HTTP(S)/ALL proxy, overrides a provider base URL, disables or replaces TLS
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
- Only UTF-8 text without NUL is read, and the whole file is checked, not just the lines returned.
- Limits: 1 MiB per file; 200 lines by default and 2,000 at most; 200 directory entries by default and 2,000 at
  most; search stops at 100 matching lines, 2,000 examined files or 16 MiB read; one call examines at most 20,000
  directory entries, 2,000 directories and 64 levels. Every result, serialized, is at most 64 KiB. A bound that is
  reached is reported; a search that skipped a readable file (too large, unreadable, changed) is reported as
  incomplete, never as "no matches".
- Directory pages are in Unicode code-point order and continue after the last returned name. Pagination is not a
  snapshot: edits between calls can change later pages. A directory with more than 20,000 entries returns no page
  rather than one that could skip names.
- Search is case-sensitive literal matching (no regular expressions or globs), one result per matching line, with
  long lines clipped around the match.

These checks detect escapes and observed changes on **owner-controlled** volumes. They are not protection against a
hostile process changing the tree concurrently, and the read-only mount is not a sandbox.

**Credentials** live only under `RUNTIME_STATE_DIR/credentials/<provider>/<slot>.json`: versioned, strictly
decoded records with a generation number and millisecond expiry, in `0700` directories and `0600`, single-linked
files owned by the runtime user. Anything else (loose permissions, symlinks, hard links, FIFOs, invalid records)
fails closed. Records are replaced atomically and durably (exclusive temporary file, fsync, rename, directory
fsync). Refresh begins five minutes before expiry; one process refreshes while others wait for, or adopt, its
result. A provider-scoped kernel lock (via the image's `/usr/bin/flock`) is shared by the runtime and operator
login, so a stale refresh can never overwrite a newer login. A definitive rejection records
"reauthorization required" and keeps no token material. Provider login and refresh protocols are not implemented
yet; the lifecycle is tested with synthetic credentials.

**Secret-safe projections.** Goals and answers containing credential material are refused, not rewritten.
Credential values in tool output and model text are replaced by `[redacted credential]`; a credential in a tool
call's arguments or in a result's non-text field withholds that call or result instead. Model output is assembled
completely (at most 1 MiB, and only after the provider's successful end-of-response) before any of it is used, so
a credential split across stream fragments is still caught. Detection combines exact matches of this runtime's live
credentials with a small set of unambiguous formats (vendor-prefixed keys, private-key blocks, literal bearer
tokens); it is not general secret scanning, and ordinary identifiers, hashes and example JWTs pass through.
Diagnostics are flat allowlisted fields only — no free text, errors, requests, headers or bodies.

## Deployment

`compose.yaml` defines three services:

- **runtime** — the single application image (non-root, read-only root filesystem, all capabilities dropped).
  It shares the Tailscale container's network namespace and listens only on `127.0.0.1:3000`. Writable
  locations are the private `runtime-state` volume (`/var/lib/agent-runtime`, mode `0700`) and a bounded `/tmp`.
  The owner workspace is mounted read-only at `/workspace`.
- **tailscale** — Tailscale Serve proxies HTTPS to the runtime's loopback listener. Funnel is disabled and
  no ports are published. Userspace networking; state in its own volume.
- **postgres** — PostgreSQL 17.11 on an internal network with no published port.

All images are pinned by digest. The Docker build uses the repository root as context with an allowlisting
`.dockerignore`, installs from the frozen lockfile, and copies only the built output into the runtime image.

```bash
cp .env.example .env   # then set AGENT_RUNTIME_WORKSPACE and a generated, URL-safe POSTGRES_PASSWORD
docker compose up -d --build
docker compose logs tailscale   # first start: open the printed login URL to join your tailnet
```

The real tailnet login and Serve HTTPS path have not yet been exercised; they are verified during the
Anthropic acceptance block. Restrict the machine to your own devices with your tailnet access policy.
Health endpoints:
`/healthz` (liveness) and `/readyz` (persistence status; agent execution is reported as `not_implemented`).

## Limitations

- No agent runs, provider login or inference, or console yet. Run records, configuration, credential storage and
  the workspace tools exist as components; nothing uses them to run an agent yet.
- No backup, retention or restore tooling; ordinary restarts preserve the database volume, nothing more.
- Read-only mounts and path checks are not a sandbox against hostile processes on the host; the workspace is
  assumed to be owner-controlled.
- Ordinary restarts are in scope; host-reboot and disaster-recovery guarantees are not.

## License

[MIT](./LICENSE) © 2026 Agent Facets, Inc.

Third-party material and dependencies keep their own licenses; see
[THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md). Some spike harnesses download software with separate
terms. In particular, the Obsidian spike image contains proprietary software that should not be redistributed.
