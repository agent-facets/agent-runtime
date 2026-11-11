# Agent facet capability release roadmap

This roadmap is the release-chain index for the split of `configure-agent-facet-capabilities`.

The numbers define the default delivery order. They do not authorize independent deployments of incomplete controls. Design work MAY proceed in parallel.

The [umbrella](./configure-agent-facet-capabilities/proposal.md) retains the source scope and approval history. Its original deltas MUST NOT be applied alongside the successors.

## Release chain

| Order | Change | Planning artifacts | Main contract inputs |
|---|---|---|---|
| 01 | [Portable facet admission](./admit-portable-facet-contributions/proposal.md) | Proposal, specs, design | Existing installation and integrity contracts |
| 02 | [Definition-bound tool policy](./manage-definition-bound-tool-policy/proposal.md) | Proposal, specs, design | Existing tool definitions and owner boundary |
| 03 | [Agent capability plans](./resolve-agent-capability-plans/proposal.md) | Proposal, specs, design | 01, 02 |
| 04 | [Canonical provider tool names](./support-canonical-provider-tool-names/proposal.md) | Proposal and specs; design pending | 02 |
| 05 | [Owner configuration and workspace sandboxes](./configure-agent-workspaces-and-sandboxes/proposal.md) | Proposal and specs; design pending | 02, 03 |
| 06 | [Workspace critical approvals](./enforce-workspace-critical-approvals/proposal.md) | Proposal, specs, design | 02, 05 |
| 07 | [Message capacity and monitoring](./observe-runtime-message-capacity/proposal.md) | Proposal and specs; design pending | Cross-cutting measurement boundaries; can be designed early |
| 08 | [Run-owned agent sessions](./add-run-owned-agent-sessions/proposal.md) | Proposal and specs; design pending | 03, 04, 05, 06, 07 |
| 09 | Integrated release and published `voice-to-text` proof | Release gate, not another OpenSpec change | 01 through 08 |

All eight changes are planning artifacts. None has implementation tasks or implemented runtime work from this decomposition.

## Readiness rules

- **Design readiness:** The owned engineering contracts are complete enough for review. A design file alone does not prove this for dependent integration.
- **Implementation readiness:** The owned design is reviewed, required predecessor contracts are available, and implementation tasks have their own approval.
- **Release readiness:** Integration verification and the applicable operational approvals are complete.

OpenSpec's artifact status reports file dependencies. A `ready` tasks artifact MUST NOT be interpreted as implementation or deployment approval.

The owner approved artifact creation. Individual review of the final batch is deferred. Earlier source adversarial reviews do not certify these successor artifacts.

## Change boundaries and completion evidence

### 01. Portable facet admission

Owns portable versus explicit metadata, normalized exports and sealed definitions, integrity, and unchanged command text semantics.

Completion evidence MUST cover absent, null, empty, identity-only, explicit, and invalid metadata, preserved restrictions, deterministic exports, and published-facet admission.

Admission MUST NOT imply selection, activation, grants, or execution. Startup and live proof remain later integration work.

### 02. Definition-bound tool policy

Owns structured identities, canonical labels, collisions, selected origins, native bootstrap, immutable classifications, owner review, and shared mutation receipts.

Completion evidence MUST cover changed definitions, owner overrides, exact saves, conflicting submissions, safe inspection, and retained policy references.

Canonical labels in local records MUST NOT be reported as provider compatibility. Classification MUST NOT authorize discovery, grant access, or approve a critical operation.

### 03. Agent capability plans

Owns independent resolution, retained definitions, normal native-only bindings, submitted-input identity, bounded discovery, and startup preparation.

Completion evidence MUST cover complete catalogs, independent targets, scoped failures, stable hashes, native operation without installation reads, and exact startup content.

Session creation and durable startup supply MUST remain in the combined acceptance transaction owned by 08. This change does not define the serialized owner configuration.

### 04. Canonical provider tool names

Owns faithful carriage of the names from 02 through supported subscription providers.

Its design MUST resolve actual name constraints, adapter/profile changes, response mapping, continuation implications, and the required compatibility evidence.

Aliases MUST NOT count as canonical-name compliance. Live checks need separate approval.

### 05. Owner configuration and workspace sandboxes

Owns the configuration file, owner start/options integration, workspace policy, Docker placement and lifecycle, and explicit reset procedure.

Its design MUST resolve launch and mount contracts, verified program availability, discovery admission, configuration refusals, and reset plan/application details.

The final reset inventory depends on all completed record contracts, including 08. This is a release-integration dependency, not an instruction to reset at stage 05.

Completion evidence MUST include disposable-database reset safety and Docker acceptance against verified settings. Protected owner data and workspace files MUST remain intact.

### 06. Workspace critical approvals

Owns exact approval scope, durable gates and leaves, critical dispatch intent, uncertainty resolution, and owner decision interfaces.

Completion evidence MUST cover concurrent admission, drain, immutable reviewed content, one critical slot, lost acknowledgements, stale executors, and truthful outcomes.

It MUST NOT weaken sandbox controls or implement a separate execution ledger. Checkpoint and session integration belongs to 08.

### 07. Message capacity and monitoring

Owns the common message-size policy, faithful failure classification, operational measurements, and evidence-based future limits.

Its design MUST select collection, storage, owner inspection, independent host evidence, and deployment verification. No monitoring stack is selected by this roadmap.

Monitoring MUST operate before affected limits stop enforcement anywhere in the release. This gate also applies to aggregate snapshots and new session paths.

Instrument registration alone is insufficient. Completion evidence MUST establish collection and durable host evidence after runtime termination.

### 08. Run-owned agent sessions

Owns combined acceptance, task/discussion execution, durable startup, session reuse, owner selection, prepared-step capture, history, and continuation.

Its design MUST complete conversation storage, failed-turn reuse, checkpoint bindings, owner inspection, and integration with workspace holds and control tools.

The approved same-run scope, owner-only switching, next-preparation timing, prompt catalog, and selection route remain constraints, not open architectural choices.

Completion evidence MUST include exact replay, concurrency, active/waiting exclusion, depth and budget enforcement, selection races, and complete ancestor-chain recovery.

### 09. Integrated release gate

Before a release is declared complete:

1. The relevant designs and implementation tasks MUST be complete and reviewed.
2. Deterministic behavior, persistence, API, component, and process verification MUST pass. Browser checks MUST remain limited smoke and layout checks.
3. Docker verification MUST pass for the actual development deployment. Missing Docker coverage MUST NOT be reported as full verification.
4. Monitoring collection, storage, inspection, and independent host evidence MUST operate before affected limits stop enforcement.
5. The completed current schema and exact reset inventory MUST distinguish disposable execution records from protected owner data and foreign-key dependencies.
6. Actual reset, deployment, production facet installation, configuration/grant changes, and live provider traffic MUST receive their separate approvals.
7. The unchanged published `voice-to-text` installation MUST have recorded identity, resolved version, integrity, and deterministic context evidence.
8. Entry startup, delegate exclusion, independent startup selection, nested depth refusal, and shared-budget behavior MUST be verified together.
9. A separately approved bounded live check MUST demonstrate useful handling of dictated text. Supplied instructions alone MUST NOT be reported as model compliance.

## Dependency and scope guardrails

The default delivery order and the contract-input graph are different facts. Monitoring can be designed early, while final reset targets cannot be closed before all record contracts exist.

Changes 05 and 06 MUST both be effective before new sandboxed MCP execution is enabled. Change 08 MUST preserve their admission boundaries without splitting atomic acceptance.

No change MAY use temporary compatibility formats, guessed limits, host fallback, or incomplete controls to bypass a release prerequisite.

Cross-run memory and `mvp-04-pr-feedback-to-plan` are outside this release chain. This roadmap does not reorder those projects.

When a successor is archived, this roadmap MUST retain its change name in plain text and link to the applicable main specs instead of its archive path.

## Traceability and follow-ups

The [scope map](./configure-agent-facet-capabilities/scope-map.md) allocates all 22 source decisions and their detailed contracts.

The [requirement and scenario map](./configure-agent-facet-capabilities/traceability.md) identifies primary successor ownership for all source scenarios. Its JSON companion supports verification.

Each successor retains its documentation/data-model, runtime/deployment, and console follow-ups. This decomposition changes planning artifacts only.

Full official STE Dictionary verification remains incomplete. No claim of fully verified STE compliance is made.
