# Proposal

## Why

Goal and command runs need the same consumer-owned capability model. Each configured agent needs its own retained instructions, facet selections, startup requirements, and permitted task targets.

## What Changes

- The runtime SHALL resolve each configured agent independently. There SHALL be no shared selection scope, special root configuration type, or implicit inheritance of another agent's selections.
- Facet selection SHALL produce availability candidates from installed, materialized contributions. It SHALL NOT require additional per-agent server, tool, skill, or command allowlists.
- Startup activation and task-delegation relationships SHALL remain separate from facet availability.
- A separate entry policy SHALL identify permitted entry agents and a default within that set.
- The normalized policy SHALL retain maximum delegation depth, with default 2 and explicit zero support. Valid values SHALL be non-negative safe integers without another policy maximum.
- Capability plans SHALL retain every configured agent once, including configurations outside the task-delegation graph.
- Goal and command preparation SHALL use the same resolved capabilities. A command SHALL add task instructions, prerequisites, and narrowing restrictions, not capabilities.
- Every accepted run SHALL use the common capability snapshot and binding contract. Facet-free plans SHALL identify no installation and contain no installed definitions.
- Plans without installed facet data SHALL NOT require an installation read or MCP discovery.
- Startup preparation SHALL use only explicitly configured startup skills. It SHALL preserve their exact retained bodies, stable order, provenance, and existing startup bounds.
- Authored references and restrictions SHALL retain their meaning. A configured name SHALL NOT silently substitute for an installed-agent reference.
- MCP discovery SHALL remain independently authorized, bounded, and subject to workspace placement and admission controls.
- Prepared availability SHALL remain distinct from permission to execute. Current revocations and invocation-specific restrictions SHALL still constrain dispatch.

## Non-goals

This change SHALL NOT define the serialized owner configuration file or Docker launch contract.

It SHALL NOT implement session storage, child execution, owner agent switching, or the combined run-acceptance transaction.

It SHALL NOT persist startup history independently of session creation, dispatch a model merely to supply startup instructions, or claim that prepared instructions prove provider delivery.

It SHALL NOT add automatic facet installation, contribution allowlists, inherited target catalogs, or installed-agent bindings based on matching names.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `capabilities`: Independent selections, target relationships, prerequisite resolution, startup preparation, skill availability, and inspection of prepared capabilities.
- `execution`: Uniform retained plans, complete definition catalogs, native-only bindings, and goal/command preparation without acceptance side effects.

## Impact

Affected areas include normalized configuration, capability resolution, snapshots, startup preparation, MCP preflight, and capability inspection.

This change is item 03 in the [release roadmap](../ROADMAP.md). It consumes portable admission and definition-bound tool policy from items 01 and 02.

The owner configuration change supplies validated configuration. The session change owns atomic acceptance, startup history, depth enforcement, and request-time reconciliation.

The monitoring change owns removal of aggregate snapshot limits and other affected message ceilings. Monitoring SHALL operate before enforcement stops.

Verification SHALL cover independent selections, explicit relationships, native-only plans, retained definitions, scoped refusals, startup bounds, and deterministic startup-context preparation.

The root [README](../../../README.md#configuration) and [runtime installation guide](../../../deploy/runtime/facets/README.md) informed this proposal. Their command-only capability and flat-list guidance SHALL be updated through the assigned successor changes.

External follow-ups SHALL include retained-plan descriptions in `architecture/09-data-model-and-lifecycle.md`, capability-inspection projections, and documentation of selection versus activation and authorization.

The repository has no files under `docs/`. This decomposition SHALL NOT edit those external implementation files.
