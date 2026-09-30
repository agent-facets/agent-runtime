# Delivery Phases

> **Superseded ordering (2026-09-29).** The P0–P9 sequence below is historical.
> Delivery now follows the four-phase
> [framework MVP roadmap](../openspec/roadmaps/framework-mvp.md): interactive
> agent execution, facet-backed capabilities, cross-run memory, then
> PR-feedback-to-plan. This document is retained for its reasoning and exit
> criteria, not as the current build order.

The system is built piecewise. Each phase produces something that works and can
be used, not a layer waiting on the next layer.

Two sequencing principles:

1. **Prove the risky, novel parts early.** Subscription transport parity and
   headless Obsidian bootstrap are the two things that could invalidate the
   design. They come before polish.
2. **Never build a durability story retroactively.** Idempotency, the event log,
   and compatibility manifests are cheap to add in phase 4 and expensive to
   retrofit in phase 9.

```text
P0  spikes ──▶ P1 compose ──▶ P2 obsidian ──▶ P3 auth ──▶ P4 runtime
                                                              │
                          P5 memory ◀───────────────────────┘
                              │
                              ▼
                          P6 surface ──▶ P7 backup ──▶ P8 interop ──▶ P9 sandbox
```

---

## P0 — Spikes

Answer the questions that could change the architecture. Throwaway code.

| Spike | Question | Status |
|---|---|---|
| [Obsidian headless](./spike-reports/01-obsidian-headless.md) | Does it boot, open a vault, and leave restricted mode without a GUI? | **Pass** |
| [Loopback bridge](./spike-reports/02-obsidian-loopback-bridge.md) | Can a sidecar in a shared netns reach the plugin and preserve streaming? | **Pass** |
| [Anthropic parity](./spike-reports/03-anthropic-parity.md) | Does a decorated fetch from a LangChain client produce a request matching the reference profile? | **Pass** |
| [OpenAI device auth](./spike-reports/04-openai-device-auth.md) | Does device-code login complete inside a container and refresh? | **Pass** |
| [LangGraph durability](./spike-reports/05-langgraph-durability.md) | Kill the process mid-run and mid-interrupt; does it resume correctly? | **Pass**, scoped |
| [Postgres checkpointer](./spike-reports/06-postgres-checkpointer-concurrency.md) | Do the official checkpointer and Store behave as documented under concurrency? | **Pass**, with required safeguards |

Findings live in [spike-reports/](./spike-reports/). Harnesses live in
`spikes/`.

**Exit:** every spike answered yes, or the architecture is revised in writing
before proceeding.

P0 exits on the **second** branch. Spike 06 answered *no* for both packages under
concurrency and the architecture is revised accordingly: the checkpointer is kept
behind four mandatory safeguards, and the vendor Store is replaced by an
app-owned memory index. Those revisions are in
[02-control-plane.md](./02-control-plane.md),
[04-memory-system.md](./04-memory-system.md),
[06-storage-and-backup.md](./06-storage-and-backup.md) and
[09-data-model-and-lifecycle.md](./09-data-model-and-lifecycle.md).

---

## P1 — Compose foundation

Repository skeleton, Postgres, internal network, configuration, migrations.

- Compose stack with an internal network and no public port bindings
- Postgres with pgvector, schema separation, migration tooling
- **Exactly one migrator**, serialised by a PostgreSQL advisory lock held on a
  dedicated connection — never through the application pool — and vendor
  components constructed with lazy setup disabled thereafter
  (see [spike 06](./spike-reports/06-postgres-checkpointer-concurrency.md))
- Configuration loading with **fail-loud** validation — no silent degradation
- Structured logging, health endpoints
- Startup assertion that no listener binds a host-routable address; internal
  Compose-network listeners are exempt (see
  [07-network-and-protocols.md](./07-network-and-protocols.md))

**Exit:** `docker compose up` produces a healthy stack; a smoke test writes and
reads a row through migrations, and a deliberate N-process cold start converges
to one schema with no migration SQLSTATE.

---

## P2 — Obsidian brain

The memory appliance, deterministic and reproducible.

- Slim Obsidian image, pinned by digest, multi-arch
- Entrypoint converger: vault registry, plugin sync, settings merge, restricted
  mode, readiness gate
- MCP bridge in a shared network namespace — stock NGINX, configuration only,
  no custom code (see [spike 02](./spike-reports/02-obsidian-loopback-bridge.md))
- Layered health checks
- Vault structure, frontmatter schema, `.gitignore` written **before** `git init`
- Commit daemon with quiescence, single-flight lock, and a secret guard

**Exit:** a cold start from an empty volume reaches a working authenticated MCP
call with no manual step; five restarts produce zero diffs.

---

## P3 — Model authentication

The distinguishing capability. Nothing above it works without it.

- `model-auth`: credential store, atomic rotation, single-flight refresh, typed
  errors
- Anthropic subscription transport extracted from the existing plugin core —
  request shaping is already proven end to end by
  [spike 03](./spike-reports/03-anthropic-parity.md); what remains for this
  phase is the credential lifecycle around it
- Compatibility profile with captured fixtures and differential tests
- OpenAI subscription transport with device-code login
- API-key transports as fallback
- `auth login` / `auth status` CLI
- Model factory selecting transport by configuration

**Exit:** a LangGraph node completes a tool-calling, streaming conversation
through both subscription transports; parity tests pass; credentials survive a
container restart with rotation intact.

---

## P4 — Runtime core

Orchestration and durability. Protocol-free.

- Domain model: Run, Task, Event, Approval, Artifact
- Append-only event log with per-run sequence
- LangGraph manager graph with Postgres checkpointing, every invocation pinned to
  `durability: "sync"` and asserted at startup — the pinned release's default
  loses the in-flight superstep on a crash
  (see [spike 05](./spike-reports/05-langgraph-durability.md))
- Crash resume on the same `thread_id` with **no** `checkpoint_id`; supplying one
  is fork semantics and re-executes completed branches
- Interrupt-backed approvals with ordinal and node fingerprint, and truthy
  structured decision payloads — a bare `false` does not resume
- Idempotency ledger carrying its own `ordinal` and keyed on the namespace the
  writes carry. Both key properties are measured in P0
  ([spike 06](./spike-reports/06-postgres-checkpointer-concurrency.md)); P4
  carries them as regression tests
- **A per-thread advisory lease on a dedicated session before any resume.** Two
  workers on one `thread_id` both execute and fork the lineage; a refused worker
  is recorded `awaiting_resource`
- **Compatibility refusal before invoking**, using normalised node-body
  fingerprints — a moved `interrupt()` is structurally invisible
- **An `error` listener on every pooled client**, without which a database
  failure kills the process instead of rejecting the call
- Run status derived from the runtime's own event log, never from the
  orchestrator's return value — six measured mechanisms report success having
  executed nothing
- Compatibility manifest per run
- Failure taxonomy and retry policy
- Agent definition registry with versioning
- Content-addressed artifact store
- Architecture test enforcing no protocol imports in the core

**Exit:** a run pauses on approval, survives a full stack restart, resumes with
the decision, and produces a complete replayable transcript. A deliberately
duplicated effect is caught by the ledger.

[Spike 05](./spike-reports/05-langgraph-durability.md) proves the runtime half of
that sentence. [Spike 06](./spike-reports/06-postgres-checkpointer-concurrency.md)
discharges the **database** half: a graceful restart, an unclean `SIGKILL`, the
server destroyed under a demonstrably blocked backend, and both containers
replaced from pinned image ids on the preserved named volume — with a
fresh-volume control that loses everything.

What remains this phase's obligation is the **host** half: no host, WSL, kernel
or Docker-daemon reboot occurred, the page cache was never dropped, and the
volume never left the running daemon.

---

## P5 — Memory

The reason for the system.

- Brokered MCP access to Obsidian with allowlists and schema pinning
- Extraction at run boundaries with redaction
- Reconciliation: new, reinforced, superseded, conflicting
- Vault writes with full provenance frontmatter
- Indexer: watcher, chunker, embedder, pgvector upsert, git-sha reconciliation,
  against an **app-owned** schema — the vendor `PostgresStore` is measured
  unsuitable for this role
  (see [spike 06](./spike-reports/06-postgres-checkpointer-concurrency.md))
- Multi-channel retrieval with fusion and context budget
- Consolidation jobs

**Exit:** an agent learns a fact in one run, retrieves it with correct
provenance in a later run, has it superseded by a correction, and the vault
shows the full history. Deleting the index and rebuilding from the vault
restores retrieval — judged on the documents returned and their order, not on
vector equality, since re-embedding is not guaranteed to reproduce identical
vectors.

---

## P6 — Surface

Make it usable from a couch and a phone.

- REST API and SSE with `Last-Event-ID` replay
- Web UI: runs, transcript, approvals, agents, memory
- Approvals inbox designed phone-first
- PWA manifest
- Tailscale Serve with path routing and identity headers
- Authorization mapping identity to permitted actions

**Exit:** start a run from a laptop browser, approve it from a phone, close the
tab mid-run, reopen, and see a complete transcript with no gaps or duplicates.

---

## P7 — Backup

Make the node replaceable.

- SST stack: per-user stage, private bucket, generated secret, Lambda API
- Node backup job: artifacts, archives, DB snapshot, vault, manifest last
- Presigned direct-to-object-store uploads with checksum enforcement
- Local upload journal for resumable cycles
- Restore flow with lazy artifact fetch and index rebuild
- Heartbeat on manifest success; alert on absence

**Exit:** a full restore onto a clean machine from the runbook alone, timed, with
a paused run resuming afterward.

---

## P8 — Interoperability

Let other agents use the node.

- Remote management MCP with a small tool surface and durable tasks
- OpenCode integration verified end to end
- A2A adapter with agent card, streaming, cancellation, input-required
- Optional push notifications

**Exit:** OpenCode on a laptop delegates a research run, disconnects, reconnects,
and retrieves the result. An A2A client completes a full lifecycle including an
input-required round trip.

---

## P9 — Sandboxed execution

The highest-risk capability, deliberately last.

- Executor broker: separate uid, unix socket, narrow validated RPC
- Rootless ephemeral workspaces with dropped capabilities and quotas
- Egress proxy with registry allowlist
- Artifact extraction by the broker
- Approval gate on workspace creation
- Git operations outside the sandbox, behind approval

**Exit:** a coding task runs, produces a diff, and lands behind approval. A red
team prompt instructed to escape reaches neither the container runtime, the
host filesystem, nor an unapproved network destination.

---

## Ordering rationale

**Why auth before the runtime.** If subscription transport does not work, the
economics change and possibly the whole approach. Finding that out in P3 costs
a week; finding out in P8 costs the project.

**Why Obsidian before memory.** The container bootstrap is fiddly and
independent of memory design. Proving it early de-risks the phase that actually
delivers value.

**Why the runtime before the UI.** A UI over an incomplete domain model
calcifies the domain model. The core should be exercisable from tests before it
has a face.

**Why backup after memory.** There is nothing worth restoring until the brain
exists. Before that, a rebuild is just `compose up`.

**Why sandboxing last.** It is the only capability whose absence is safe. Code
execution stays disabled until the broker exists — an agent that cannot run code
is limited; an agent that can run code badly is dangerous.

## Cross-cutting, from P1 onward

- Fail loudly on misconfiguration. Never degrade silently.
- Every phase ships with tests.
- Every secret path gets a guard the first time it exists.
- Every phase updates these documents when reality diverges from the plan.
