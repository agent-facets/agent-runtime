# Proposal

## Why

The runtime facet project is empty, and adopting the first real skill, `voice-to-text`, exposes two unnecessary barriers: mandatory runtime-specific author metadata and capabilities restricted to command-started runs. The owner needs to select reusable facets for agents through consuming configuration, without modifying the published facet or inventing a wrapper command.

## What Changes

- The owner SHALL be able to select installed facets through shared configuration applicable to all agents and per-agent configuration for the existing root agent and named delegates. Facet authors SHALL NOT need to know their consumers or add runtime-specific metadata merely to make portable contributions usable. Installation alone SHALL NOT select a facet for an agent.

- Portable commands, skills, and agent instructions SHALL NOT require runtime-specific metadata. Absent, null, or empty runtime metadata SHALL mean no runtime-declared prerequisites or restrictions, without granting authority. Settings belonging to other coding tools SHALL NOT acquire runtime meaning. Non-empty runtime settings SHALL be validated against the supported behavior; supported requirements and restrictions SHALL remain enforced, and unsupported or malformed settings SHALL be refused. Migration SHALL NOT silently discard actual restrictions or grant authority.

- **BREAKING:** Shared/per-agent facet selection SHALL replace the flat `capabilities.allowSkills` and `capabilities.allowAgents` configuration contract. Configurations containing the superseded fields SHALL be refused with migration guidance rather than silently mapped to all agents. Migration SHALL distinguish selection from independent tool grants and SHALL NOT broaden access. Deployments without capability configuration SHALL retain their existing native-tool behavior.

- Goal runs and command-started runs SHALL resolve capabilities from the consuming agent's configuration. Commands SHALL supply task instructions and supported task-specific constraints, not unlock a separate capability system. Selected skills, delegates, and approved MCP tools SHALL be usable without a command wrapper.

- Facet availability SHALL remain separate from instruction activation and tool authorization. Selected skills SHALL remain discoverable and loadable on demand. The owner MAY explicitly select startup skills whose instructions SHALL be present before that agent's first model request; loading them SHALL NOT itself consume a model step. Unselected startup instructions SHALL NOT be preloaded merely because their facets are installed. A facet's description alone SHALL NOT establish an enforced automatic-loading rule.

- Each run SHALL retain its resolved agent selections and capability definitions. Later installation or configuration changes SHALL NOT replace them, while current owner revocations SHALL continue to constrain dispatch. Shared selections and delegation SHALL NOT bypass owner grants or caller restrictions. The owner SHALL be able to distinguish installed, selected, startup-loaded, and actually used contributions and inspect their provenance.

- The first real proof SHALL install the published `voice-to-text` facet unchanged into the independent runtime facet project. A goal run with the skill configured for startup SHALL include its installed instructions in the root agent's first model request, with identity and version recorded. In a separate per-agent configuration case, a delegate excluded from that facet SHALL neither receive its instructions nor be allowed to load it. Shared selection SHALL also be verified for root and delegate agents. A bounded live smoke check SHALL demonstrate useful handling of dictated text; deterministic tests SHALL establish loading and isolation. Production installation, deployment, grants, and live provider traffic SHALL remain separately approved operations.

## Non-goals

- Agent-initiated facet installation, updates, removal, configuration edits, or self-expansion of authority.
- Replacing the existing root agent with a facet-defined persona or offering selectable root agents. This change configures capabilities for the existing root and named delegates.
- Per-run or console-side selection overrides. Consuming configuration SHALL take effect on restart, like existing operator grants.
- A new approval framework, capability marketplace UI, general agent editor, or automatic facet dependency installation.
- VIPER integration, cross-run memory, or the PR-feedback workload.
- Universal coding-tool compatibility, arbitrary script or shell execution, broader MCP transports, or relaxed credential and permission boundaries.
- Changing the facet package format or requiring upstream authors to add consumer-specific configuration.

## Alternatives Considered

- Mandatory owner-authored compatibility declarations for every imported facet: rejected because portable instructions need no second opt-in marker; genuine requirements and restrictions remain distinct from selection.
- Relaxing admission only for skills: rejected because portable command and agent instructions have the same consumer-selection problem.
- Wrapping the skill in a command: rejected because ordinary goal runs would still lack configured capabilities.

## Capabilities

### New Capabilities

None. These changes extend existing product domains.

### Modified Capabilities

- `capabilities`: Shared/per-agent facet selection; portable admission and explicit compatibility rules; startup versus on-demand skill activation; inspectable effective availability; and independent authorization boundaries.
- `execution`: Capability-enabled goal runs alongside command starts; retained agent selections and definitions; startup instruction presence; provenance across execution, delegation, and continuation; and unchanged native-tool behavior without capability configuration.

## Impact

Affected areas include facet export and sealed-installation compatibility, operator/agent configuration, capability resolution and inspection, run admission and retained definitions, skill context assembly, delegation, and console/API projections.

Design SHALL specify migration for existing configuration and sealed inputs, shared/per-agent selection precedence, delegate capability resolution under caller restrictions, approved MCP exposure through shared selections, and bounded startup instruction context. Existing saved runs SHALL NOT be silently reinterpreted. Upgrade guidance SHALL identify continuation compatibility; incompatible waiting runs SHALL retain their history and be refused visibly rather than resumed with replacement definitions.

Documentation informing this proposal includes the root [README](../../../README.md#capability-configuration)—Capability configuration, Runtime facets, Authority boundaries, and Runtime facets in a deployment—the [runtime installation guide](../../../deploy/runtime/facets/README.md), and the [capability configuration example](../../../deploy/runtime/config.capabilities.example.json). These SHALL be updated for consumer-owned selection, portable admission, activation, and migration. The runtime manifest and lockfile SHALL record the proof installation independently of editor facets.

Verification SHALL use fast unit tests and service, API, and process-level checks for admission, migration, selection, goal-run use, isolation, permissions, snapshots, and continuation. Browser testing SHALL remain a small smoke check, not the primary behavior suite. No additional version-pin test is required.
