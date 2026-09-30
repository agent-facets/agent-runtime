# Framework MVP Roadmap

This roadmap orders the OpenSpec changes that take the agent runtime from an
empty Bun scaffold to its first complete proving workload. It records planning
decisions and dependencies only. Nothing listed here is implemented.

The deliverable is a **generalized personal agent runtime**. The PR-feedback
workload proves the runtime; it is not a dedicated PR-review application.

## Status vocabulary

| Status | Meaning |
|---|---|
| Proposal drafted | `proposal.md` exists and has not been reviewed |
| Proposal reviewed | The owner approved the proposal's scope |
| Implementation-ready | Delta specs, design, and tasks exist and are approved |
| Implemented | Tasks are complete and verified |
| Archived | The change has been archived into the main specs |

## Phases

| Order | Change | Status | Depends on | User-visible exit |
|---|---|---|---|---|
| 1 | [`mvp-01-interactive-agent-execution`](../changes/mvp-01-interactive-agent-execution/proposal.md) | Proposal reviewed | — | Start a task in a browser console, observe it, leave, return, answer a question, and obtain the result, using either Anthropic or OpenAI subscription access |
| 2 | [`mvp-02-facet-backed-capabilities`](../changes/mvp-02-facet-backed-capabilities/proposal.md) | Proposal reviewed | 1 | A facet-backed workflow loads a skill, delegates a bounded task, calls an approved MCP tool, asks a question, and produces an inspectable result |
| 3 | [`mvp-03-cross-run-memory`](../changes/mvp-03-cross-run-memory/proposal.md) | Proposal reviewed | 1, 2 | A fresh run uses relevant prior knowledge; a correction changes later behavior; a repository-specific preference does not leak into another repository |
| 4 | [`mvp-04-pr-feedback-to-plan`](../changes/mvp-04-pr-feedback-to-plan/proposal.md) | Proposal reviewed | 1, 2, 3 | Investigate a PR's feedback, decide items individually or in batches, discuss without accidental verdicts, and save an approved VIPER plan for accepted items; a later PR reuses and honors corrected preferences |

The order is strict. Each phase is usable on its own and each later phase
builds on the previous phase's observable behavior. No phase depends on a
deferred capability.

## Decision record

These decisions were approved at the meta plan's MVP boundary gate on
2026-09-23. They govern the four proposals. Design-level detail remains open
where noted.

### Tooling

- Bun and TypeScript, with mise managing the environment. The existing
  `bun init` scaffold is extended rather than replaced.
- Scaffold work is the first block of phase 1, not a separate phase.

### Execution

- LangChain `createAgent` on LangGraph owns the model/tool loop. The runtime
  does not implement a second loop or nest a vendor agent loop.
- The official LangGraph PostgreSQL checkpointer holds graph state. The runtime
  owns run records, events, human questions, exact decisions, results, and
  credential handling.
- The first interface is a small browser console. Existing LangChain frontend
  SDKs and components may be reused; the hosted Agent Server is not assumed.
- Anthropic subscription access delivers the first usable slice; OpenAI
  subscription access completes phase 1. This replaces the meta plan's default
  deferral of multiple providers. If OpenAI proves disproportionately costly,
  its placement is revisited explicitly rather than silently dropped.
- Initial tools are read-only plus human questions. Unrestricted source
  editing and external mutations are excluded.
- Persistence promise: execution is independent of the browser; a pending
  human question survives an ordinary process restart; an executor that dies
  mid-work is reported as interrupted, with no automatic recovery or
  exactly-once guarantee.

### Capabilities

- Reuse the `facet` CLI and the public `@agent-facets/adapter` SDK, plus a
  small runtime-specific adapter. No package manager, no archive loader, and no
  dependency on the private facet engine.
- `.opencode` materializations are not an input format for this runtime.
- The runtime supports a documented subset of skill, command, agent, and
  permission semantics and rejects unsupported requirements visibly.
- Installation consent is not runtime authorization; the runtime enforces
  effective tool permissions and owns MCP lifecycle and credentials.
- Facet composition is not relied upon; facets are installed explicitly.

### Memory

- **Hindsight replaces the custom Neo4j knowledge implementation for this
  MVP.** One memory system is authoritative for cross-run knowledge; the
  custom claim ledger, bitemporal model, and general reconciliation engine are
  deferred, not built alongside it.
- This supersedes, for the MVP scope, the accepted Lane N decision in
  [spike 07 §21](../../architecture/spike-reports/07-knowledge-plane-and-working-memory-working-record.md).
  It is not a finding that Hindsight reproduces the transactional
  accepted-claim guarantees demonstrated in
  [spike 08](../../architecture/spike-reports/08-observation-to-knowledge-reconciliation.md).
  Historical evidence is preserved unchanged.
- Integration is through the TypeScript SDK behind a thin runtime boundary.
  The Python LangGraph binding and the MCP server are not the integration path.
- Execution records remain authoritative for what happened and what the owner
  authorized. Retrieved memory is context, never evidence of authorization.
- Learning policy:
  - A decision about one run stays an exact execution record and may also be
    retained as an attributed outcome.
  - An inferred preference informs recommendations only.
  - An explicit "remember this" instruction is stored with its scope and loaded
    directly in applicable future work, not left to semantic recall.
  - A reusable workflow change becomes a separately reviewed facet-source
    change.
- Standing rules can control only behavior a workflow makes configurable; they
  never silently override mandatory facet instructions.
- Deployment: self-hosted, accessed over its API. Hindsight's own model
  access starts with its documented personal Claude subscription mode, with
  independent credentials and a bounded integration check. No silent fallback
  to billed API access. Cloud or API-key operation is an explicit alternative.
- `reflect`-driven features and mental models are deferred.

### First workload

- GitHub-specific behavior lives in the workload and its facet, not the
  runtime core.
- The existing `address-pr-feedback` facet is adapted through reviewed changes
  to its authored source for batch decisions, configurable noise handling, and
  the VIPER handoff.
- The existing VIPER MCP server stores generated plans. A saved plan is not
  authorization to execute it.

## Deferred scope

Autonomous code implementation, GitHub posting, facet publication, scheduling,
concurrency beyond one active run per thread, providers beyond Anthropic and
OpenAI, broad protocol adapters (A2A, remote-management MCP), production
security infrastructure, automatic crash recovery, host-reboot guarantees,
Obsidian integration, retrieval tuning, backup/restore tooling, and sandboxed
execution.

Basic credential hygiene and enforcement of the limited tool surface are not
deferred.

## Questions reserved for design

These do not change phase boundaries and are answered in each change's design:

1. Bun compatibility of the chosen LangChain, LangGraph, PostgreSQL
   checkpointer, provider, and MCP packages, including the checkpointer's use
   of node-postgres alongside any use of `Bun.sql`.
2. How the console transport exposes runs, events, and questions: the
   documented Agent Streaming Protocol endpoints or a narrower runtime API.
3. Extraction of the Anthropic and OpenAI spike transports into runtime
   code, and their integration with `createAgent` tool serialization and
   multi-turn tool-result round trips.
4. The graph compatibility check for generated `createAgent` graphs.
5. The adapter's materialized layout and the supported subset of facet asset
   semantics.
6. Hindsight bank layout, tag scoping, observation scopes, and how explicit
   instructions are stored, listed, and loaded.
7. Where review reports and generated plans live relative to the reviewed
   repository.

## Documentation obligations

No `docs/` directory or root documentation beyond the Bun scaffold README
exists. Architecture documents describe pre-implementation intent. The
following reconciliation is owed during implementation, not by this roadmap:

| Document | Required update |
|---|---|
| `architecture/README.md` | Knowledge canonicality, memory system selection, first interface |
| `architecture/02-control-plane.md` | `createAgent` harness, facet-hosted capabilities, console transport |
| `architecture/04-memory-system.md` | Hindsight replaces custom extraction, reconciliation, and retrieval for the MVP |
| `architecture/05-model-authentication.md` | Which transports are production paths; Hindsight's separate model access |
| `architecture/06-storage-and-backup.md` | Hindsight's PostgreSQL storage and recovery assumptions |
| `architecture/10-delivery-phases.md` | Superseded for the MVP by this roadmap |
| `README.md` | Setup and usage for each delivered phase |

Spike 07's Step 64 obligation to reconcile the architecture documents with the
Lane N decision is carried forward and now includes this supersession.

## Lifecycle after proposal review

Each change proceeds in roadmap order:

1. Delta specs, design, and tasks are authored and approved.
2. Implementation runs its tasks, including bounded integration checks for
   the reserved design questions.
3. Verification confirms the phase exit.
4. Downstream proposals are reviewed against what implementation actually
   established, and revised if an assumption no longer holds.
5. The change is archived before the next change's specs are finalized, so
   later changes modify real main specs.

## Sources

- Meta plan: internal planning document, not included in this repository
- Governance: `openspec/config.yaml`, `openspec/specs/spec-governance/spec.md`
- Architecture: `architecture/README.md`, `architecture/02-control-plane.md`,
  `architecture/04-memory-system.md`, `architecture/05-model-authentication.md`,
  `architecture/10-delivery-phases.md`
- Spikes: `architecture/spike-reports/03` through `08`
- Facets (separate repositories, not included here): the facets repository
  (adapter SDK, protocol, CLI docs), the `address-pr-feedback` facet in the
  facet registry, and the `viper-plans` repository
- Frameworks: https://docs.langchain.com/oss/javascript/langchain/agents,
  https://docs.langchain.com/oss/javascript/langgraph/persistence,
  https://docs.langchain.com/oss/javascript/langchain/mcp
- Hindsight 0.10.1: https://hindsight.vectorize.io/,
  https://hindsight.vectorize.io/sdks/nodejs,
  https://hindsight.vectorize.io/developer/models
