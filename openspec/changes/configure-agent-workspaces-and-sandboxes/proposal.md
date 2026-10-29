# Proposal

## Why

The runtime needs a complete owner configuration and a verifiable boundary for workspace execution. The approved behavior does not yet define the configuration file, Docker launch and mount contracts, or final reset inventory.

## What Changes

- The owner SHALL configure independent agents, a separate entry policy, delegation depth, registered workspaces, and a default workspace.
- Configuration SHALL preserve independent server approvals, program approvals, tool grants, argument restrictions, and credential rules.
- **BREAKING:** Superseded flat capability selections and the delegation-call limit SHALL be refused with migration guidance. They SHALL NOT be silently converted into broader access.
- Workspace selection SHALL use registered identities, not model-supplied host paths.
- Each workspace SHALL own persistent files, an execution-policy revision, and at most one authoritative Docker sandbox instance.
- Sandbox workloads SHALL be owner-approved MCP programs. They SHALL use verified program content and enforced workspace placement without host fallback.
- Task containers SHALL use the approved hardened Docker profile. They SHALL receive no network access, runtime-private storage, Docker control, or provider credentials.
- Trusted runtime connectors SHALL remain distinct from sandboxed task programs. Local confinement SHALL NOT be presented as confinement of remote effects.
- Workspace lifetime SHALL remain independent of runs and replaceable containers. Run completion SHALL NOT delete files or stop infrastructure used by another invocation.
- The runtime SHALL use one current strict record format. Incompatible state SHALL be refused rather than converted or automatically deleted.
- An explicit reset SHALL remove only approved disposable runtime records and create the current schema.
- Reset planning SHALL identify exact targets, dependencies, and protected records. Application SHALL require separate approval and revalidation of the state-bound plan.
- Runtime exports and sealed bundles SHALL be regenerated from configured sources after the applicable reset.

## Non-goals

This change SHALL NOT add arbitrary shell execution, native write or test tools, additional sandbox backends, or repository-supplied lifecycle scripts.

It SHALL NOT add workspace attachment state machines, automatic snapshots, filesystem rewind, automatic commits, idle-stop, deletion, or cross-workspace agent access.

It SHALL NOT implement critical-operation gates or session recovery. Those changes supply independent execution controls.

It SHALL NOT execute a reset, change production configuration or grants, deploy infrastructure, or send live provider traffic during this decomposition.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `capabilities`: Owner configuration, explicit migration, workspace policy boundaries, safe reset of runtime facet inputs, and unchanged external version semantics.
- `execution`: Registered workspace selection, Docker confinement, persistent workspace lifetime, current-record validation, and separately approved development reset.

## Design work remaining

The design MUST resolve:

- The complete configuration shape, defaults, reference validation, and refusal mappings.
- Pre-run owner interfaces, including paged options and capability inspection.
- Program placement, verified content availability, daemon mount sources, provisioning, and lifecycle controls.
- How discovery obeys the same placement and workspace-admission constraints as execution.
- The reset plan representation, target-state binding, protected-record inventory, and application procedure.
- The final current-schema inventory and foreign-key dependencies supplied by all successor changes.
- Deployment and rollback procedures that preserve protected data and do not claim unfinished controls.

No `design.md` or `tasks.md` SHALL be created during this decomposition.

## Impact

This change is item 05 in the [release roadmap](../ROADMAP.md). Its final reset inventory and actual reset remain part of release integration, not an early deployment shortcut.

Affected areas include owner configuration, workspace records, MCP launch, Docker provisioning, persistence startup, owner options, and deployment examples.

The root [README](../../../README.md#configuration), `compose.yaml`, and documentation under `deploy/runtime/` informed this proposal.

External follow-ups SHALL include the configuration example, deployment and installation guidance, `architecture/08-execution-security.md`, and `architecture/09-data-model-and-lifecycle.md`.

Console work SHALL use the existing design system. The repository has no files under `docs/`.
