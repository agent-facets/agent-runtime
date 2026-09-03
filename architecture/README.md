# Agent Runtime Architecture

Working architecture for a portable, single-node personal agent runtime.

These documents capture design intent before implementation. They are not a
specification of shipped behaviour. Where a decision is still open, it is
recorded as an open question rather than resolved silently.

## Reading order

| Document                                                           | Covers                                                      |
|--------------------------------------------------------------------|-------------------------------------------------------------|
| [00-executive-overview.md](./00-executive-overview.md)             | Start here. Orientation, learnings, direction — no detail   |
| [01-system-overview.md](./01-system-overview.md)                   | Goals, non-goals, constraints, the whole-system picture     |
| [02-control-plane.md](./02-control-plane.md)                       | LangGraph orchestration, agents, runs, approvals, web UI    |
| [03-obsidian-brain.md](./03-obsidian-brain.md)                     | Obsidian container, MCP bootstrap, vault as knowledge store |
| [04-memory-system.md](./04-memory-system.md)                       | Memory taxonomy, write path, retrieval, provenance          |
| [05-model-authentication.md](./05-model-authentication.md)         | Subscription-first Anthropic/OpenAI auth, transports        |
| [06-storage-and-backup.md](./06-storage-and-backup.md)             | Postgres, artifacts, logs, Git, S3 backup and restore       |
| [07-network-and-protocols.md](./07-network-and-protocols.md)       | Tailnet ingress, REST/SSE, remote MCP, A2A                  |
| [08-execution-security.md](./08-execution-security.md)             | Trust tiers, MCP broker, sandboxing, secrets                |
| [09-data-model-and-lifecycle.md](./09-data-model-and-lifecycle.md) | Entities, state machines, retention, idempotency            |
| [10-delivery-phases.md](./10-delivery-phases.md)                   | What to build, in what order, with exit criteria            |
| [spike-reports/](./spike-reports/)                                 | Measured findings from the P0 spikes                        |

## Terminology

| Term | Meaning |
|---|---|
| **Node** | The single machine running the whole Compose stack |
| **Control plane** | The LangGraph service that owns runs, tasks, and approvals |
| **Brain** | The Obsidian vault: human-readable, Git-backed long-term knowledge |
| **Run** | One invocation of an agent, durably tracked and resumable |
| **Task** | A unit of work within a run, possibly executed by a subagent |
| **Artifact** | A large immutable output, content-addressed on disk |
| **Broker** | The policy layer between agents and the raw Obsidian MCP server |
| **Transport** | The authenticated HTTP path used to reach a model provider |

## Conventions

- Requirement keywords follow [RFC 2119](https://www.ietf.org/rfc/rfc2119.txt).
- Every document states its own open questions rather than deferring to a
  central list, so a document can be read standalone.
- Diagrams are ASCII so they diff cleanly and survive in the vault.
- [00-executive-overview.md](./00-executive-overview.md) is an orientation layer,
  not a source of truth. It carries no requirements and records no decisions;
  where it and a detailed document differ, the detailed document wins.

## Load-bearing decisions

These are the decisions the rest of the architecture depends on. Changing any
of them invalidates multiple documents.

1. **One node, no data sync.** Laptops and phones are clients. There is exactly
   one authoritative copy of state. Backup is not sync.
2. **LangGraph is the orchestrator, with explicit `durability: "sync"`.** Agent
   loops belong to us, not to a vendor harness. Other agent SDKs may be
   specialist executors, never the substrate. Every graph invocation MUST set
   `durability: "sync"`; the pinned release defaults to a mode that was measured
   to lose the in-flight superstep on a crash.
3. **The runtime core is protocol-free.** REST, MCP, and A2A are adapters over
   one internal domain model and one event log.
4. **Obsidian is canonical for knowledge; Postgres is canonical for execution.**
   Neither is a substitute for the other.
5. **Subscription authentication is the primary path.** API keys are the
   fallback, not the default.
6. **Git holds text only.** Databases, logs, artifacts, indexes, and credentials
   are excluded by construction.
7. **Vector indexes are derived.** They are rebuilt, not restored.
8. **One writer per thread.** At most one worker may invoke a given `thread_id`,
   enforced by a per-thread advisory lease on a dedicated session. The
   checkpointer serialises nothing per thread: two concurrent resumes of one
   committed interrupt each executed the node and forked the lineage while both
   reported success.
9. **The memory index is ours.** The official Postgres checkpointer is used
   unmodified; the official Store is not. Its search, filter and namespace
   semantics cannot express the memory model, and the defects are silent.

## Status

Pre-implementation. No application code exists yet. The repository contains
OpenSpec governance, facet tooling, these documents, and the throwaway P0 spike
harnesses under `spikes/`.

P0 progress is tracked in the
[spike report index](./spike-reports/README.md). All six spikes pass; the sixth
passes **with required safeguards**. Both
Obsidian spikes — headless bootstrap and the loopback bridge — are reconciled
into [03-obsidian-brain.md](./03-obsidian-brain.md); the bridge is stock NGINX
in a shared network namespace, not custom code.

The [Anthropic parity spike](./spike-reports/03-anthropic-parity.md) confirms
the load-bearing authentication decision: a decorated `fetch` under a stock
`ChatAnthropic` reproduces the reference client's request exactly, and Anthropic
accepted it on a real subscription. No `BaseChatModel` subclass is required.

The [OpenAI device-auth spike](./spike-reports/04-openai-device-auth.md) does the
same for the second provider on a stock `ChatOpenAI`, and corrects two
assumptions: OpenAI's device flow is proprietary rather than RFC 8628, and the
subscription endpoint returns no `x-request-id`.

The [LangGraph durability spike](./spike-reports/05-langgraph-durability.md)
confirms that a run resumes correctly in a fresh container after the runtime
process is killed mid-node and while paused on an interrupt — **provided** every
invocation sets `durability: "sync"`. It also measures the resume contract as
at-least-once, which is what makes the idempotency ledger in
[09-data-model-and-lifecycle.md](./09-data-model-and-lifecycle.md) load-bearing
rather than defensive.

The [Postgres checkpointer spike](./spike-reports/06-postgres-checkpointer-concurrency.md)
closes P0. The checkpointer's writes are atomic against process death and a
paused run survives the database being destroyed and both containers being
replaced on a preserved volume — but only behind four runtime-owned safeguards:
one migrator under an advisory lock, one writer per thread, a compatibility
refusal that fingerprints node bodies, and an `error` listener on every pooled
client. The vendor Store is replaced for the memory index. **Host, WSL, kernel
and Docker-daemon reboot remain untested**, and carry forward to P4.
