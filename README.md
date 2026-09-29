# agent-runtime

A personal agent runtime: start a repository task from a browser, leave, return, answer the agent's
questions, and collect the result using an existing Anthropic or OpenAI subscription.

> **Status: development foundation only.** The workspace, toolchain, checks and container topology exist.
> Agent execution, persistence, provider access and the browser console are **not implemented yet**; they
> are delivered by the remaining tasks in
> [`openspec/changes/mvp-01-interactive-agent-execution`](openspec/changes/mvp-01-interactive-agent-execution/tasks.md).
> The runtime currently serves only health and readiness endpoints, and readiness always reports
> `ready: false`.

Further reading:

- [Architecture](./architecture/README.md): design intent and open questions.
- [MVP roadmap](./openspec/roadmaps/framework-mvp.md): proposed scope and sequencing. Where the roadmap and older architecture disagree, the roadmap is current.
- [Spike reports](./architecture/spike-reports/README.md): historical research results. Each report links to its harness.

## Repository layout

A Bun-workspace monorepo orchestrated by [Turborepo](https://turborepo.com), deployed as **one** application.

| Path | Contents |
|---|---|
| `packages/runtime` | The Bun server and sole deployable application. Will own execution, persistence, providers, REST/SSE and operator commands. |
| `packages/ui` | Browser console package. Currently an empty package boundary; the console arrives in its later block. |
| `packages/contracts` | Not created yet. Browser-safe API schemas/types, extracted when the API is implemented. |
| `scripts/` | Repository checks, fixture launchers and their tests. |
| `tests/` | Explicitly launched integration and container fixtures (never run by ordinary checks). |
| `deploy/` | Deployment configuration (Tailscale Serve). |
| `spikes/`, `architecture/` | Historical evidence and design intent. Not application dependencies. |

Boundaries enforced by tests:

- The UI never imports runtime internals or server-only modules; the runtime uses only the UI's public entry.
- No package imports `spikes/**`.
- node-postgres (`pg`) is imported only by the official checkpointer adapter; application SQL uses `Bun.sql`.
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
| `bun run test:integration` | Starts a disposable PostgreSQL fixture and runs `tests/integration`. Requires Docker. |
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
`/healthz` (liveness) and `/readyz` (foundation readiness: database reachability; agent execution is reported
as `not_implemented`).

## Limitations

- No agent runs, provider authentication, persistence schema or console yet.
- Read-only mounts and path checks are not a sandbox against hostile processes on the host; the workspace is
  assumed to be owner-controlled.
- Ordinary restarts are in scope; host-reboot and disaster-recovery guarantees are not.

## License

[MIT](./LICENSE) © 2026 Agent Facets, Inc.

Third-party material and dependencies keep their own licenses; see
[THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md). Some spike harnesses download software with separate
terms. In particular, the Obsidian spike image contains proprietary software that should not be redistributed.
