# Delivery Phases

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
| Postgres checkpointer | Do the official checkpointer and store behave as documented under concurrency? | Not started |

Findings live in [spike-reports/](./spike-reports/). Harnesses live in
`spikes/`.

**Exit:** every spike answered yes, or the architecture is revised in writing
before proceeding.

---

## P1 — Compose foundation

Repository skeleton, Postgres, internal network, configuration, migrations.

- Compose stack with an internal network and no public port bindings
- Postgres with pgvector, schema separation, migration tooling
- Configuration loading with **fail-loud** validation — no silent degradation
- Structured logging, health endpoints
- Startup assertion that every listener is loopback-bound

**Exit:** `docker compose up` produces a healthy stack; a smoke test writes and
reads a row through migrations.

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
- Idempotency ledger, with a test that `effect_key` is stable across a crash
  resume and changes across a genuine fork
- Compatibility manifest per run
- Failure taxonomy and retry policy
- Agent definition registry with versioning
- Content-addressed artifact store
- Architecture test enforcing no protocol imports in the core

**Exit:** a run pauses on approval, survives a full stack restart, resumes with
the decision, and produces a complete replayable transcript. A deliberately
duplicated effect is caught by the ledger.

[Spike 05](./spike-reports/05-langgraph-durability.md) proves the runtime half of
that sentence — a `SIGKILL` of the runtime process, resumed in a fresh
container — but **not** the full stack restart: Postgres never died in the spike.
Killing the database and the host remains this phase's obligation.

---

## P5 — Memory

The reason for the system.

- Brokered MCP access to Obsidian with allowlists and schema pinning
- Extraction at run boundaries with redaction
- Reconciliation: new, reinforced, superseded, conflicting
- Vault writes with full provenance frontmatter
- Indexer: watcher, chunker, embedder, pgvector upsert, git-sha reconciliation
- Multi-channel retrieval with fusion and context budget
- Consolidation jobs

**Exit:** an agent learns a fact in one run, retrieves it with correct
provenance in a later run, has it superseded by a correction, and the vault
shows the full history. Deleting the index and rebuilding from the vault
restores retrieval.

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
