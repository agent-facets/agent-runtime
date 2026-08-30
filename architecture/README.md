# Agent Runtime Architecture

Working architecture for a portable, single-node personal agent runtime.

These documents capture design intent before implementation. They are not a
specification of shipped behaviour. Where a decision is still open, it is
recorded as an open question rather than resolved silently.

## Reading order

| Document                                                           | Covers                                                      |
|--------------------------------------------------------------------|-------------------------------------------------------------|
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

## Load-bearing decisions

These are the decisions the rest of the architecture depends on. Changing any
of them invalidates multiple documents.

1. **One node, no data sync.** Laptops and phones are clients. There is exactly
   one authoritative copy of state. Backup is not sync.
2. **LangGraph is the orchestrator.** Agent loops belong to us, not to a vendor
   harness. Other agent SDKs may be specialist executors, never the substrate.
3. **The runtime core is protocol-free.** REST, MCP, and A2A are adapters over
   one internal domain model and one event log.
4. **Obsidian is canonical for knowledge; Postgres is canonical for execution.**
   Neither is a substitute for the other.
5. **Subscription authentication is the primary path.** API keys are the
   fallback, not the default.
6. **Git holds text only.** Databases, logs, artifacts, indexes, and credentials
   are excluded by construction.
7. **Vector indexes are derived.** They are rebuilt, not restored.

## Status

Pre-implementation. No application code exists yet. The repository currently
contains OpenSpec governance, facet tooling, and these documents.
