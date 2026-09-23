# Proposal

## Why

Persistent conversations do not stop an agent from relearning the owner's preferences in every new run. Cross-run memory lets the framework reuse useful outcomes and explicit instructions while keeping remembered context separate from what the owner actually authorized.

This is phase 3 of [the framework MVP roadmap](../../roadmaps/framework-mvp.md). It depends on [`mvp-01-interactive-agent-execution`](../mvp-01-interactive-agent-execution/proposal.md) and [`mvp-02-facet-backed-capabilities`](../mvp-02-facet-backed-capabilities/proposal.md); their proposals are reviewed, not implemented.

## What Changes

- **Remember useful outcomes.** The system SHALL retain selected useful outcomes with their source run and context, without requiring approval for every extracted observation. A recorded statement or inferred pattern SHALL NOT be presented as an owner-approved instruction merely because it was retained or repeated.
- **Use memory in new runs.** An agent SHALL receive relevant prior knowledge within the current repository and workflow scope. A repository-specific preference SHALL NOT apply to another repository unless the owner explicitly broadens its scope. Run identity is provenance, not a barrier preventing learning across runs.
- **Explicit standing instructions.** The owner SHALL be able to ask the system to remember an instruction for future applicable work. Its intended scope SHALL be visible; unclear scope SHALL prompt clarification. Applicable active instructions SHALL be loaded directly rather than depending on semantic search finding them.
- **Preserve authority boundaries.** Inferred preferences SHALL inform recommendations, not grant permission or finalize decisions. A standing instruction SHALL control only behavior the workflow makes configurable; it SHALL NOT silently override mandatory facet instructions. A reusable workflow change remains a separately reviewed facet-source change.
- **Inspect what is remembered.** The user SHALL be able to inspect retained knowledge, its available source attribution, and active standing instructions, distinguishing historical outcomes, inferred observations, and explicit instructions. A run SHALL identify the memory and instructions supplied to it.
- **Correct or disable memory.** The user SHALL be able to correct or retire a remembered fact and edit or disable a standing instruction. Pending and completed corrections SHALL be distinguishable; a completed correction SHALL govern subsequent applicable runs. Original run decisions SHALL remain unchanged by memory curation.
- **Report memory failures.** Unavailable retrieval, failed retention, and incomplete processing SHALL be visible rather than reported as an empty memory bank or a successful save. Provider credentials SHALL NOT be retained in memory.

## Capabilities

### New Capabilities

- `memory`: Retaining attributed knowledge and scoped instructions across runs, applying them where relevant, and inspecting, correcting, or disabling them.

### Modified Capabilities

- `execution`: Runs identify the memory and standing instructions supplied to them and expose memory-operation failures without changing their exact decision history. This capability is introduced by phase 1 and extended by phase 2; the later delta targets that archived baseline, not a duplicate execution spec.

## Impact

- **Architecture decision:** Hindsight replaces the custom Neo4j knowledge implementation for this MVP, as approved in the roadmap. This explicitly supersedes [spike 07 §21](../../../architecture/spike-reports/07-knowledge-plane-and-working-memory-working-record.md#section-21--locked-stage-1-decision-steps-3337) within the MVP scope. Neo4j is not deployed alongside it as another knowledge authority. Historical spikes remain unchanged; this is not a claim of equivalent transactional reconciliation guarantees.
- **Framework reuse:** Hindsight supplies extraction, retrieval, consolidation, and curation. A thin integration uses its official TypeScript SDK; the runtime supplies scope and authority policy, selected-outcome retention, direct instruction loading, and the inspection/correction experience. Hindsight's directives affect its own `reflect` calls, so storing a directive alone does not apply it to our agent.
- **Storage boundary:** Hindsight owns cross-run knowledge behind its API. Execution records and LangGraph checkpoints remain in the execution database; they, not retrieved memories, establish what happened and what was authorized. Memory-management operations do not grant general file-edit or external-action permission to facets.
- **Deployment and usage:** self-hosted Hindsight requires persistent PostgreSQL storage and its own model, embedding, and reranking configuration. Begin with its documented personal Claude subscription mode and local embedding/reranking defaults. Its credentials and model transport are independent of the runtime's tested transports; quota use and latency remain unmeasured. Cloud or API-key operation requires an explicit decision, never an automatic billing fallback.
- **Evidence limits:** Hindsight 0.10 documentation supports the proposed integration, but no instance has been exercised here. Fact edits rebuild derived knowledge asynchronously; source-document reprocessing resets fact curation. Design SHALL account for these limitations instead of promising immediate consistency. Before acceptance, bounded integration checks SHALL cover Bun SDK access, independent authentication, processing completion, fresh-run reuse, correction, repository/workflow scope, and ordinary restart persistence. This is not a benchmark programme.
- **Documentation:** no `docs/` directory exists; the root `README.md` contains only Bun scaffold instructions and has no relevant memory documentation. [The memory design](../../../architecture/04-memory-system.md), [reconciliation report](../../../architecture/spike-reports/08-observation-to-knowledge-reconciliation.md), and [Hindsight documentation](https://hindsight.vectorize.io/developer/api/memories) informed this proposal. Later implementation SHALL update setup/usage documentation and reconcile the architecture overview, memory, authentication, storage, and delivery documents identified in the roadmap.

## Non-goals

- A parallel Neo4j knowledge service, custom accepted-claim ledger, bitemporal model, or general conflict-reconciliation engine.
- Replacing execution records or checkpoints with memory, or treating source attribution as proof of truth.
- Automatic promotion of inferred preferences into standing instructions, permission changes, or facet edits.
- `reflect`-driven features, mental models, Obsidian integration, sophisticated retrieval tuning, or a renewed memory benchmark programme.
- Guaranteed memory accuracy, production recovery tooling, or blanket compatibility claims for subscription providers.
- PR-specific noise rules and the review-to-plan workflow; those belong to phase 4.
