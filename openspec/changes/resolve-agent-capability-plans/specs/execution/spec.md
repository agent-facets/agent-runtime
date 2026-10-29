# Spec Delta

## ADDED Requirements

### Requirement: Entry policy and depth resolve against configured agents

The permitted-entry set SHALL contain configured agents. Its default SHALL identify an agent within that set.

An invalid default or unresolved permitted-entry reference SHALL cause configuration refusal without fallback.

The supplied defaults SHALL include an ordinary configured agent with empty facet, startup-skill, and delegation-target selections.

The supplied entry policy SHALL permit that agent and select it as the default. The configuration model SHALL NOT require a special root-agent type.

Maximum delegation depth SHALL remain separate from individual agent configurations. Omitted depth SHALL resolve to 2.

Explicit depth SHALL be a non-negative safe integer without another policy maximum. Invalid values SHALL be rejected without rounding or clamping.

The resolved policy SHALL NOT contain a separate delegation-call limit.

Goal and command preparation SHALL use the selected entry agent's configuration. A command SHALL NOT select another agent or add capabilities.

#### Scenario: Entry policy references are invalid
- **WHEN** the default entry agent is outside the permitted-entry set
- **OR** a permitted-entry reference does not identify a configured agent
- **THEN** the system SHALL refuse the configuration
- **AND** it SHALL NOT substitute another agent or silently remove the invalid reference

### Requirement: Retained configurations include every configured agent

Retained definitions SHALL include every configured agent, including the entry agent and configurations outside task-delegation relationships.

Each configuration SHALL retain its own instructions, facet selections, startup choices, target relationships, and applicable capability definitions.

The catalog SHALL retain each configuration once rather than duplicate it for possible invocation paths.

Goal and command runs SHALL use the same capability-retention contract. A command SHALL add its task definition, arguments, prerequisites, and restrictions without expanding agent capabilities.

A run without selected facets SHALL still retain its agent configurations. Its binding SHALL identify no installation and contain no installed definitions.

Such a run SHALL NOT require an installation read or MCP discovery. The runtime SHALL NOT use a separate native-only configuration record.

Retained configurations SHALL have no fixed agent-count or aggregate snapshot-size limit. Separate facet-content, startup-instruction, and identifier validation SHALL remain effective.

The retained content SHALL remain exact and pass its integrity checks. Serialization or storage failures SHALL identify their actual cause.

The system SHALL NOT truncate, omit, or substitute definitions to make a catalog fit.

Removal of existing message and snapshot limits SHALL remain subject to operational monitoring first.

#### Scenario: Native configured agents can be retained without an installation
- **WHEN** configured agents select no facets but remain valid discussion targets
- **THEN** their definitions SHALL remain available through the normal retained capability binding
- **AND** retaining them SHALL NOT read an installation or start MCP discovery
- **AND** the runtime SHALL NOT use a separate native-only configuration record

#### Scenario: Retention keeps a large catalog complete
- **WHEN** a valid configuration contains many agents outside the task-delegation graph
- **THEN** retention SHALL preserve the complete configured catalog
- **AND** the runtime SHALL NOT limit retention to task-reachable targets or duplicate definitions for each possible call path

#### Scenario: Retention cannot silently omit part of a catalog
- **WHEN** a serialization or storage failure prevents retention of the complete catalog
- **THEN** the system SHALL report that failure
- **AND** it SHALL NOT accept a partial catalog or substitute current deployment definitions later

#### Scenario: Retention has no agent-count or aggregate size cap
- **WHEN** an otherwise valid new run needs more than 32 retained agent configurations and a total snapshot larger than 16 MiB
- **AND** each definition passes its own validation
- **AND** all other checks and required transport, serialization, and storage operations succeed
- **THEN** retention SHALL NOT reject the run because of the number of agents or total snapshot size
- **AND** the retained snapshot SHALL preserve the exact content and pass its integrity check
