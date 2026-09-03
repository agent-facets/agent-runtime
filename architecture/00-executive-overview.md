# Executive Overview

Start here. This document is the orientation layer: what the system is, how the
pieces fit, what the research established, and where the work is going.

It is deliberately shallow. Every claim here is stated in full elsewhere, and
where this document and a detailed one differ, **the detailed document is
authoritative**. Nothing should be specified here for the first time.

## What this is

A private, always-on personal agent runtime that runs on one machine you own.

Its purpose is not conversation with a model. Its purpose is a durable system
that remembers what you and your agents learn, keeps long-running work alive
across restarts, coordinates approvals, and can be rebuilt from source control
and backups.

Phones and laptops are thin clients. They hold no authoritative state, so there
is nothing to merge between them.

## Why it exists

**Memory is the reason this system exists. Everything else is plumbing around
it.**

Model conversations forget. Notes go stale. Knowledge that lives only in a
vendor's product is neither portable nor inspectable. This system's bet is that
long-term knowledge should be human-readable Markdown you own, that agents write
into and read out of, with the execution machinery arranged to serve that.

## The one rule

> **Obsidian stores what the system knows.
> Postgres stores what the system did.**

A note is not a checkpoint; a checkpoint is not a note. Everything else in the
architecture follows from keeping these separate.

## The system at a glance

```text
                     PRIVATE TAILSCALE NETWORK
                                |
              +-----------------+-----------------+
              |                                   |
        Phone / Browser                    Coding Agents
              |                              MCP / A2A
              +-----------------+-----------------+
                                |
                                v
                  +---------------------------+
                  |    RUNTIME CONTROL PLANE  |
                  |                           |
                  |  Web UI / API / Streaming |
                  |  Manager Agent            |
                  |  Run and Task Services    |
                  |  Events and Approvals     |
                  |  Scheduler                |
                  |  Security Policy          |
                  +------+----------+---------+
                         |          |
             +-----------+          +----------------+
             |                                       |
             v                                       v
    +------------------+                    +------------------+
    | Claude / OpenAI  |                    | Agent Execution  |
    | Model Transports |                    | and Sandboxes    |
    +------------------+                    +--------+---------+
                                                     |
                                                     v
                                            Brokered Tools / MCP

                         RUNTIME DATA LAYER
                                  |
              +-------------------+-------------------+
              |                   |                   |
              v                   v                   v
      +---------------+   +---------------+   +---------------+
      |   Postgres    |   | Obsidian Vault|   | Artifact Store|
      |               |   |               |   |               |
      | Runs          |   | Knowledge     |   | Large outputs |
      | Events        |   | Memories      |   | Files         |
      | Checkpoints   |   | Procedures    |   | Run products  |
      | Approvals     |   | Markdown      |   +---------------+
      | Memory index  |   | Git history   |
      +---------------+   +---------------+
              |                   |
              +---------+---------+
                        |
                        v
                 Encrypted Backups
                 and Off-site Storage
```

Deployed as one Docker Compose stack on one machine:

```text
One owned machine
|
+-- Runtime and Web UI
+-- PostgreSQL with pgvector
+-- Headless Obsidian
+-- Small Obsidian network bridge
+-- Backup service
+-- Dynamically created agent sandboxes
```

Detail: [01-system-overview.md](./01-system-overview.md),
[07-network-and-protocols.md](./07-network-and-protocols.md).

## How a run works

```text
User request
     |
     v
Runtime creates a durable run
     |
     v
Relevant memory is retrieved
     |
     v
Manager agent decides what to do
     |
     +----------> Answer directly
     |
     +----------> Start specialist subagents
                        |
                        v
                  Use brokered tools
                        |
               +--------+--------+
               |                 |
               v                 v
        Safe operation      Approval needed
                                  |
                                  v
                             Ask the human
               |                 |
               +--------+--------+
                        |
                        v
              Record events and checkpoints
                        |
                        v
                 Produce final result
                        |
                        v
              Extract reusable knowledge
```

A run can pause waiting for human input, an unavailable resource, or a scheduled
time — and then continue from persisted state rather than depending on the
original process still being alive.

Detail: [02-control-plane.md](./02-control-plane.md),
[09-data-model-and-lifecycle.md](./09-data-model-and-lifecycle.md).

## How memory works

```text
Conversations, runs, files and results
                  |
                  v
          Memory extraction
                  |
                  v
       Dedupe and reconciliation
                  |
       +----------+-----------+
       |                      |
       v                      v
Clear new knowledge       Conflict or uncertainty
       |                      |
       |                 Human review
       |                      |
       +----------+-----------+
                  |
                  v
        Markdown in Obsidian
          CANONICAL MEMORY
                  |
                  v
       Chunk, embed and index
          DERIVED SEARCH DATA
                  |
                  v
   Keyword + semantic + links + recency
                  |
                  v
            Future agent runs
```

The separation that matters:

```text
Canonical knowledge     = Markdown in the vault
Search acceleration     = Rebuildable database index
Execution history       = Postgres events and checkpoints
Large generated files   = Artifact storage
```

Because the index is derived rather than canonical, retrieval and extraction are
replaceable behind a stable boundary. That is deliberate: it is what lets an
alternative memory approach be evaluated on results without it becoming the sole
owner of the knowledge.

Detail: [04-memory-system.md](./04-memory-system.md),
[03-obsidian-brain.md](./03-obsidian-brain.md).

## Who owns what

The sharpest idea in the architecture is that the orchestration framework is an
engine, not the operating system.

| LangGraph owns | The runtime owns |
|---|---|
| Graph execution | Run and task status |
| Checkpointing working state | The event history |
| Interrupting and resuming | Approvals |
| Manager and subagent structure | Scheduling |
| | Idempotency |
| | Compatibility checks |
| | Concurrency policy |
| | Memory lifecycle |
| | Security and tool policy |

This keeps the product model from being coupled to framework internals, and it
is why run status derives from our own event log rather than from what the
orchestrator returns.

Detail: [02-control-plane.md](./02-control-plane.md),
[08-execution-security.md](./08-execution-security.md).

## What the research established

Six spikes were run before any implementation, each answering one question that
could have changed the architecture. All six passed. Full results and their
limits are in the [spike report index](./spike-reports/README.md).

In plain terms:

1. **The approach is feasible.** Obsidian runs headless and reproducibly; its
   desktop-only interface can be reached safely through a very small bridge;
   Claude and ChatGPT subscription access both work through the normal model
   abstraction; runs survive process replacement.

2. **Durable execution is at-least-once.** After a crash a step may run again.
   Anything with an external effect therefore needs a stable identity recorded
   in a ledger. This makes idempotency load-bearing rather than defensive.

3. **Success can be reported when nothing happened.** Several mechanisms can
   report completion having done no work. A caller checking only for errors
   detects none of them, which is why status must come from our own event log.

4. **The framework's defaults are not the safe ones.** Durability, retries, and
   concurrency all required explicit configuration to behave as the architecture
   assumes. These are now recorded as mandatory settings, asserted at startup.

5. **We should own the memory index.** The generic vendor store cannot express
   the memory model — scope, validity, provenance, supersession, lexical search
   — and its shortcomings are silent rather than loud. The index is ours. This
   costs nothing to change later because the index is rebuildable by design.

6. **Subscription authentication works, but is provider-specific.** Both
   providers sit behind one model interface, but their transports differ and
   should not be forced into one implementation. API keys remain a recorded
   fallback, because a silent switch changes both cost and behaviour.

The most important limit: **durability across a full host or kernel reboot has
not been tested.** Process, container, and full-stack replacement have. This is
the largest open risk against the durability goal and is scheduled with the
runtime work.

## Where this is going

```text
[ Complete ] Architecture and risky experiments
[ Next     ] Docker Compose foundation
[ Later    ] Durable runtime
[ Later    ] Memory and retrieval
[ Later    ] User interface and protocols
[ Later    ] Backup and restore
[ Later    ] Sandboxed execution
```

The order is not arbitrary. Authentication and durability are proven early
because a late failure there would be structural. The interface comes after the
domain model, so it does not calcify an incomplete one. Code execution comes
last, because it is the only capability whose absence is safe.

Detail and exit criteria: [10-delivery-phases.md](./10-delivery-phases.md).

## Current position

Design is complete enough to build. No application code exists yet.

The remaining uncertainties are no longer about feasibility — they are product
choices: how memory is extracted and retrieved, how much of that is automatic,
how conflicts are reviewed, how much autonomy agents get, and how full machine
recovery behaves end to end.

## What this document is not

It is not a specification, and it is not the place to record a decision. It
carries no requirement keywords and no open questions of its own; each detailed
document states its own. If something here is the only place a rule is written
down, that is a defect in the detailed documents, not a feature of this one.
