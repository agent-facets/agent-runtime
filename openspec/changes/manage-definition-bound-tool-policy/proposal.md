# Proposal

## Why

The owner needs to know which tool definition a policy governs. Tool names alone cannot establish origin, authority, or whether an operation changes resources.

## What Changes

- Tools SHALL have explicit effect and critical declarations. Effect SHALL be `read` or `write`. Critical status SHALL remain independent of effect.
- Classification SHALL bind the structured tool identity and reviewed definition digest. A changed definition SHALL require renewed classification before execution.
- Facet tools SHALL retain the origin selected during installation, including its facet identity and installed version. The runtime SHALL NOT substitute or merge classifications from other origins.
- Native tools SHALL use canonical `tool__<name>` labels. Facet tools through MCP SHALL use `facet__<server>__<name>` labels.
- The runtime SHALL preserve structured identities separately from labels. Ambiguous effective server IDs or exposed names SHALL prevent tool exposure.
- The `mcp__<server>__<name>` form SHALL remain reserved for standalone MCP. This change SHALL NOT enable standalone MCP execution.
- Supported authored native references SHALL retain their existing spelling and resolve to the corresponding native identities.
- Initial native classifications SHALL come from explicit runtime declarations. Registration and initial classification SHALL be atomic.
- Native bootstrap SHALL NOT overwrite owner revisions or automatically classify a changed definition. Facet tools SHALL NOT receive automatic classifications.
- `Discuss` SHALL have fixed read-only, non-critical policy. Other listed native classifications SHALL remain owner-editable.
- The owner SHALL inspect definitions and explicitly save classifications through a Tool classifications page under Configuration.
- Saves SHALL reject stale definition or revision reviews. Equal submission retries SHALL return the original result without overwriting later changes.
- Classifications SHALL use immutable revisions in the existing runtime database. They SHALL remain separate from agent selection, independent grants, and exact-operation approvals.

## Non-goals

This change SHALL NOT implement discussion, session execution, Docker placement, or workspace approval gates.

It SHALL NOT prove provider compatibility with canonical names. Provider wire aliases SHALL NOT be reported as meeting the model-visible naming requirement.

It SHALL NOT add automatic classification, autosave, a classification CLI, a raw JSON editor, or a separate datastore.

Inspection SHALL NOT start MCP discovery, execute tools, approve servers, or grant access.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `capabilities`: Exact tool identity, canonical names, definition-bound classification, native bootstrap, and explicit owner review.
- `execution`: Retained tool-policy identity and selected origin, subject to current independent revocations.

## Impact

Affected areas include tool registration, capability records, policy persistence, owner APIs, and the browser console.

This change is item 02 in the [release roadmap](../ROADMAP.md). Provider carriage belongs to `support-canonical-provider-tool-names`. Critical execution belongs to `enforce-workspace-critical-approvals`.

The shared mutation-receipt contract SHALL support retry-safe owner controls. Each successor SHALL define its own mutation semantics.

Verification SHALL cover identity collisions, selected-origin lookup, changed definitions, native bootstrap, immutable revisions, competing saves, and retries after later edits.

Console behavior SHALL use component and API tests. Browser verification SHALL remain a small smoke and layout check using the existing design system.

The root [README](../../../README.md#authority-boundaries) informed this proposal. Authority, capability-configuration, and console/API guidance SHALL distinguish classification from grants and operation approval.

External follow-ups SHALL include policy descriptions in `architecture/09-data-model-and-lifecycle.md`, security boundaries in `architecture/08-execution-security.md`, and the classification console surface.

The repository has no files under `docs/`. This decomposition SHALL NOT edit those external implementation files.
