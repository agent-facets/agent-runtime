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
- `awaiting_resource` is a first-class state, not an error. The vault is an
  exclusive resource and contention is normal.
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

Side effects MUST be idempotent across resume. On resume a node re-executes from
its top, so anything before an `interrupt()` runs twice. Spawning a container
before an interrupt spawns two.

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
