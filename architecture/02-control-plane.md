# Control Plane

The control plane owns orchestration. It decides what runs, tracks what
happened, holds credentials, and mediates every privileged action.

## Core principle

**The runtime core MUST NOT import protocol code.** Run, Task, Event, Approval,
Artifact, and Memory are plain domain objects. REST, MCP, and A2A are adapters
that project those objects outward.

If protocol types leak into the core, every adapter becomes load-bearing and
none of them can be removed. An architecture test SHOULD enforce the import
direction.

```text
┌──────────────────────────────────────────────────────┐
│  ADAPTERS (thin, stateless, replaceable)             │
│   REST+SSE   ·   Remote MCP   ·   A2A   ·   Web UI   │
└───────────────────────┬──────────────────────────────┘
                        │  projections of one event log
┌───────────────────────▼──────────────────────────────┐
│  RUNTIME CORE (protocol-free)                        │
│   RunService · TaskService · ApprovalService         │
│   EventLog · ArtifactStore · MemoryService           │
│   AgentRegistry · Scheduler · IdempotencyLedger      │
└───────────────────────┬──────────────────────────────┘
                        │
┌───────────────────────▼──────────────────────────────┐
│  EXECUTION                                           │
│   LangGraph manager graph                            │
│   subagents · research jobs · sandboxed workspaces   │
└──────────────────────────────────────────────────────┘
```

## Manager and subagents

A single **manager agent** is the entry point. It receives an instruction,
decides whether to answer directly or decompose, and spawns subagents for
focused work.

```text
User instruction
       │
       ▼
   Manager agent
       │
       ├── answers directly              (cheap, no delegation)
       ├── spawns research subagent      (read-only tools)
       ├── spawns memory subagent        (vault read/write)
       └── spawns coding subagent        (sandboxed workspace)
```

Subagents are LangGraph subgraphs, not separate services. They inherit the run's
`thread_id` and land in their own `checkpoint_ns`, which is the natural fan-out
and retention key.

The runtime MUST treat `checkpoint_ns` as an **opaque grouping key**. Its format
is `<node>:<taskId>`, nested by appending — but that is a vendor detail, not a
contract, and nothing in the runtime may parse it. Retention in particular MUST
enumerate one head per live namespace rather than assume a single chain: a
subgraph's lineage is separately rooted, so a root-only sweep deletes it whole
(see [06-storage-and-backup.md](06-storage-and-backup.md)).

The manager MUST NOT hold provider credentials in its prompt context, and MUST
NOT be able to widen its own tool permissions.

## Agent definitions

An agent is configuration, not code. A definition is versioned and immutable
once referenced by a run.

```text
AgentDefinition
  id
  name
  version                    immutable once used
  model_ref                  provider + model + transport
  system_prompt_ref          content hash into the vault
  tools[]                    allowlisted tool names
  mcp_scopes[]               which brokered MCP tools are permitted
  trust_tier                 T0..T4 (see execution-security)
  limits                     max steps, wall clock, token budget
  approval_policy            what requires a human
```

Prompts SHOULD live in the Obsidian brain as Markdown so they are diffable and
reviewable. The runtime stores the content hash, and snapshots the resolved
text into the artifact store at run start so an audit is reproducible even if
the note is later edited.

**Definition versions MUST be stamped onto the run at start.** LangGraph applies
current code to every thread and does not persist topology, so a refactor can
otherwise make a paused run unresumable with no warning.

## Runs and tasks

A **run** is one invocation. A **task** is a unit of work inside it.

```text
Run
  run_id, thread_id
  agent_definition_id + version
  status, started_at, ended_at
  input, final_output
  compat_manifest            code + package versions at start
  usage                      tokens, requests, per-model breakdown

Task
  task_id, run_id
  checkpoint_ns              maps to the LangGraph subgraph
  parent_task_id
  kind                       research | memory | code | tool
  status, timings
  result_ref
```

LangGraph gives us checkpoints and pending writes. It does not give us runs,
approvals, schedules, leases, usage, or idempotency. Those are ours.

**Verified.** [Spike 05](./spike-reports/05-langgraph-durability.md) measured
both halves. After a `SIGKILL` mid-node, a fresh container resumed from persisted
state alone and reproduced the uninterrupted final state exactly; a node that had
already completed was not replayed, and in a fan-out a branch whose write had
landed as a pending write was reused rather than re-executed.

**That reuse is a root-namespace property.**
[Spike 06](./spike-reports/06-postgres-checkpointer-concurrency.md) measured the
identical fan-out *inside a subgraph*: the completed sibling re-executed, despite
its pending write being present and its task id unchanged. The mechanism is a
key-presence test — `skipDoneTasks = !("checkpoint_id" in config.configurable)` —
and the engine builds every task's config with `checkpoint_id: undefined`, present
as a key. **Any loop initialised from a task's config, which is every subgraph,
has reuse disabled.** A root-level control with the same topology and the same
thrown failure reused it, so the subgraph boundary is the only variable. Inside a
subagent the idempotency ledger is the only thing preventing a duplicate effect.

## Durability contract

The orchestrator's crash behaviour is a **setting**, not a property. It MUST be
set explicitly on every call.

- Every `invoke` / `stream` the runtime makes MUST pass `durability: "sync"`.
  Startup MUST fail if any entry point can be invoked without it.
- Ordinary crash resume MUST use the same `thread_id` with **no**
  `checkpoint_id`. Supplying one is fork/replay semantics: it disables
  completed-task skipping, and a branch that had already finished re-executes.
- An in-memory checkpointer MUST NOT be used outside unit tests. With
  `MemorySaver`, no state survived process replacement at all.
- **At most one worker may invoke a given `thread_id`.** Two workers resuming the
  same committed interrupt each executed the node, forked the lineage, and
  **both returned success**. The runtime MUST hold a per-thread PostgreSQL
  advisory lease on a **dedicated checked-out client** — a lock taken through
  `pool.query` lands on whichever backend was free and is then returned to the
  pool, where an idle timeout can drop it silently. A worker refused the lease
  MUST execute no graph node and MUST be recorded `awaiting_resource`. The
  subgraph boundary does not contain the duplicate: a concurrent resume forked
  the child namespace as well as the root.
- **The runtime MUST attach an `error` listener to every client its pool
  creates.** When PostgreSQL dies under an in-flight caller, `pg` emits `error`
  on the *client*, not the pool, and Node treats an unhandled `error` event as
  fatal. Without the listener the process does not receive a database failure —
  it vanishes. With it, the call rejects promptly and loudly, which is the
  difference between a retryable run and a run whose state is unknown.
- **Run status MUST derive from the runtime's own event log, never from the
  orchestrator's return value.** Six measured mechanisms return `completed: true`
  having executed zero nodes: a duplicate concurrent resume replaying persisted
  state, a resume against a renamed node, a resume against pruned state, a resume
  against a fresh volume, a put racing a delete, and a sweep that removed the
  thread it was told to keep.

The three modes, measured under a mid-run `SIGKILL`:

| Mode | Measured behaviour |
|---|---|
| `exit` | Nothing written mid-run; zero checkpoints existed at the kill and the run was unrecoverable |
| `async` | The next node was dispatched while persistence was still pending; the superstep was lost and replayed on resume |
| `sync` | The next node was not dispatched until the superstep was durable |

`async` is the pinned release's **default**, which is why this is a MUST rather
than a recommendation. Two honest limits: the async window was held open by a
test wrapper rather than sampled from a real disk race, so nothing here bounds
how often it is hit; and `sync` was shown to order dispatch after persistence,
not to have no crash-loss window at all.

## State machine

```text
     queued
        │
        ▼
     running ⇄ awaiting_input      human approval or clarification
        │    ⇄ awaiting_resource   vault or workspace lock held
        │    ⇄ awaiting_schedule   durable timer
        │
        ├──▶ succeeded
        ├──▶ failed
        └──▶ cancelled
```

Rules:

- Terminal states MUST be terminal. No transition leaves `succeeded`, `failed`,
  or `cancelled`.
- `awaiting_resource` is a first-class state, not an error. The vault **and the
  thread** are exclusive resources and contention is normal.
- `running` has no wall-clock cap by default, but MUST have a heartbeat.
- Cancellation is cooperative and MUST be durable: write `cancel_requested` to
  the event log first, then act, so a cancel that races a restart still lands.

## Event log

One append-only log is the substrate for everything observable.

```text
Event
  run_id
  seq            monotonic per run
  ts
  task_id
  type           step | tool_call | tool_result | message
                 | approval_requested | approval_decided
                 | error | usage | artifact | cancel_requested
  payload        JSONB, large values externalized to CAS
```

Every adapter streams `WHERE run_id = ? AND seq > ?`. That single decision buys
SSE `Last-Event-ID` replay, MCP resumption, and A2A `SubscribeToTask` snapshots
with no per-adapter state.

Adapters MUST NOT hold subscription state the core cannot reconstruct.

## Approvals

Approvals are a projection of LangGraph interrupts, not a parallel mechanism.
The interrupt is the source of truth; the approvals table is the index that
makes it queryable and renderable.

```text
Approval
  approval_id, run_id, task_id
  interrupt_id
  ordinal                 index within the node
  node_fingerprint        node name + definition version at raise time
  prompt, payload_schema
  status                  pending | approved | rejected | expired
  decided_by, decided_at, decision_payload
```

**Interrupt matching is index-based.** A conditionally skipped `interrupt()`
shifts every later index. The runtime MUST record the ordinal and the node
fingerprint, and MUST refuse to auto-resume when the fingerprint no longer
matches current code.

**Verified.** [Spike 06](./spike-reports/06-postgres-checkpointer-concurrency.md)
resumed a paused thread against five pinned graph variants with nothing stopping
it. A **renamed node** returned no error, a result object and `completed: true`
while executing zero nodes and leaving the head, the checkpoint count and the
interrupt row untouched — the caller is told the run succeeded and the approval
it was waiting on is silently abandoned. A **moved interrupt** delivered the
decision to a position that no longer interrupts, advanced the head, and raised a
*new* interrupt. A widened channel set was harmless. The guard then refused all
three unsafe variants **before invoking**, leaving persisted state untouched and
producing a stable typed refusal.

Two consequences the design must carry: the moved interrupt is **structurally
invisible** — same node names, same channels — so the manifest MUST fingerprint
node bodies and not only their names; and the guard deliberately **over-refuses**
a widened channel set, which is the accepted cost of a fail-closed rule that
cannot distinguish widening from narrowing.

**Raw `__interrupt__` rows are a historical record, not a pending-approval
queue.** A nested interrupt is written at both the subgraph and the root level,
and consuming an interrupt does not delete its row. A runtime that counts those
rows to find outstanding approvals therefore over-counts twice over. Approval
state MUST be the runtime's own row, keyed on
`(thread, raising checkpoint_ns, task)` and reconciled against the tables rather
than derived from them.

**A committed interrupt survives the death of the process holding it.**
[Spike 05](./spike-reports/05-langgraph-durability.md) killed a paused process
with `SIGKILL`; a fresh container rediscovered the same interrupt from Postgres
before being told anything, resumed it with a decision, and left no interrupt
pending at the head of the chain.

The decision payload MUST be a truthy structured object. On the pinned release a
bare `false` never becomes a resume write: the invocation fails with
`EmptyInputError` and the thread stays paused. A rejection is
`{ approved: false }`, never `false`.

Side effects MUST be idempotent across resume, and this is measured rather than
cautionary. On resume a node re-executes from its top: the killed node's external
effect was observed **twice** on a connection the graph did not own, and the code
before an `interrupt()` ran again and re-raised before the stored decision was
applied. Spawning a container before an interrupt spawns two.

The orchestrator therefore provides **at-least-once** node execution, bounded by
superstep granularity. Exactly-once is the idempotency ledger's job.

## Scheduling

Recurring work uses a database-backed claim rather than in-process cron, so a
restart cannot silently drop a schedule and a second worker cannot double-fire.

```text
Schedule
  schedule_id, agent_definition_id
  cron or fire_at
  next_fire_at, last_fired_at
  payload

ScheduleExecution
  unique (schedule_id, plan_time)     the claim
  status, attempt, runner_id, error_code
```

The unique key on `(schedule_id, plan_time)` is the lock. Every worker races to
insert; exactly one wins. This keeps the Postgres image stock and yields an
audit table for free.

Timers that fired during downtime need an explicit recorded policy —
fire-once-late or skip — not an accident of sweeper ordering.

## Failure taxonomy

Retry policy is only defensible if failures are classified. Two namespaces:

| Namespace | Meaning | Examples |
|---|---|---|
| `platform.*` | The runtime failed | `platform.worker_crashed`, `platform.db_unavailable`, `platform.timeout` |
| `agent_error.*` | The agent or provider failed | `agent_error.rate_limit`, `agent_error.context_overflow`, `agent_error.auth_expired`, `agent_error.tool_denied` |

Each code carries `auto_retryable` and a remediation string. Codes are written
into the event log and the run archive so failure classes can be aggregated.

`agent_error.auth_expired` is distinguished from `agent_error.rate_limit`
because they need opposite responses: one needs a human to re-authenticate, the
other needs backoff.

## Web UI

Deliberately small. It exists to answer four questions:

1. What is running?
2. What needs me?
3. What did it do?
4. What did it learn?

```text
/                 active runs, recent history
/runs/:id         transcript, tool calls, artifacts, usage, cost
/approvals        pending decisions with diffs and large tap targets
/agents           definitions, versions, permissions
/memory           recent brain writes, provenance, broken links
```

Streaming uses SSE with `id: <seq>` so the browser reconnects with
`Last-Event-ID` and gets exact replay. WebSocket is deferred until something
genuinely needs bidirectional low-latency traffic.

The approvals view is the highest-value screen and SHOULD be designed for a
phone first.

## Open questions

- Whether the manager is one graph with conditional routing, or a small set of
  purpose-built graphs selected by a classifier.
- How a run's token budget is enforced mid-run without corrupting a checkpoint.
- Whether subagent transcripts stream to the UI by default or on demand.
- Whether cost estimates are surfaced at all, given subscription usage has no
  meaningful per-request dollar figure.
