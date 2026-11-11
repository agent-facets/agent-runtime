# Spec Delta

## ADDED Requirements

### Requirement: Portable contributions are admitted without runtime declarations

Portable command, skill, and agent instructions SHALL NOT require runtime-specific metadata.

Absent, null, and empty runtime metadata SHALL have the same meaning: no declared runtime prerequisites, no declared restrictions, and no granted authority.

Settings for other coding tools SHALL NOT acquire runtime meaning. Documentation and inspection SHALL NOT present those settings as enforced.

Non-empty runtime settings SHALL be validated against supported behavior. Supported requirements and restrictions SHALL remain enforced. Unsupported or malformed settings SHALL cause refusal with the problem identified.

The system SHALL NOT discard actual runtime settings to admit a contribution as portable.

#### Scenario: Adopt portable instructions without author adaptation
- **WHEN** the owner selects an installed portable command, skill, or agent whose runtime metadata is absent, null, or empty
- **THEN** all three cases SHALL be admitted identically without a runtime-metadata compatibility refusal
- **AND** the owner SHALL NOT need to alter the published facet or supply a replacement opt-in marker
- **AND** the contribution SHALL remain subject to installation integrity and the consuming agent's permissions

#### Scenario: Other coding-tool settings are not runtime controls
- **WHEN** a portable contribution contains settings specific to another coding tool and no runtime block
- **THEN** those settings SHALL NOT select the runtime's provider, tools, hooks, or permissions
- **AND** inspection SHALL identify portable admission rather than imply that those settings are enforced

#### Scenario: An invalid explicit block is not portable fallback
- **WHEN** a contribution has a runtime block with a malformed restriction, unsupported version, or unsupported field
- **THEN** the contribution SHALL be refused with the affected setting identified
- **AND** the system SHALL NOT remove the block and admit the contribution as unrestricted portable instructions

#### Scenario: Explicit requirements still bind alongside portable contributions
- **WHEN** a contribution has supported explicit runtime prerequisites or restrictions
- **AND** portable contributions exist in the same installation
- **THEN** those prerequisites SHALL still be checked and those restrictions SHALL still be enforced
- **AND** portable admission of other contributions SHALL NOT relax them

## MODIFIED Requirements

### Requirement: Supported facet behavior is explicit

The system SHALL document the supported subset of command, skill, agent, permission, and MCP declaration behavior.

A contribution that explicitly declares unsupported runtime behavior SHALL be refused before that behavior is used. The explanation SHALL identify the contribution and unsupported requirement. The system SHALL NOT discard a declared behavioral requirement to run the contribution.

A contribution SHALL be unusable for an agent if an explicitly declared prerequisite is absent, refused, or unavailable to that agent. This check SHALL apply to supported declarations. It SHALL NOT infer dependencies from prose alone. Unrelated usable contributions SHALL remain available.

#### Scenario: An agent requires unsupported execution behavior
- **WHEN** a facet-defined agent explicitly requires parallel, background, or long-lived delegation in its runtime declaration
- **AND** the runtime does not support that behavior
- **THEN** the system SHALL identify that agent and the unsupported requirement
- **AND** it SHALL NOT run the agent as though the requirement had been honored

#### Scenario: A permission restriction cannot be enforced
- **WHEN** a contribution declares a runtime access restriction the system cannot enforce
- **THEN** the affected contribution SHALL be refused before work using it is dispatched
- **AND** the restriction SHALL NOT be ignored or reduced to advice for the model

#### Scenario: A facet requires automatic composition
- **WHEN** a facet requires other facets to be installed or composed automatically
- **THEN** the system SHALL explain that this behavior is unsupported
- **AND** it SHALL NOT fetch, install, or authorize additional facets on the agent's behalf

#### Scenario: A declared prerequisite is unavailable
- **WHEN** a command explicitly declares a required skill or agent in a supported format
- **AND** that prerequisite is absent, refused, or unavailable to the consuming agent
- **THEN** the command SHALL be shown as unusable for that agent with that prerequisite named
- **AND** the runtime SHALL dispatch no model or tool work for that command
- **AND** another otherwise usable contribution with no dependency on the refused item SHALL remain available
