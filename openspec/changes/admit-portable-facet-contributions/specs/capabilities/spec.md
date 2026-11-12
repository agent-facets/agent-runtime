# Spec Delta

## ADDED Requirements

### Requirement: Portable contributions are admitted without runtime declarations

Portable commands, skills, and agents SHALL NOT require runtime settings.

Absent, null, and empty runtime settings SHALL declare no runtime prerequisites, no runtime restrictions, and no authority.

Installer-supplied `name` and `description` fields alone SHALL NOT make runtime settings explicit. Identity, content, and installation-integrity checks SHALL remain effective.

Portable admission SHALL NOT change owner grants, remove explicit restrictions, or bypass owner controls for skills and agents.

A ready portable command SHALL need no additional command allowlist entry. An owner start SHALL still pass the existing admission checks.

A ready portable contribution SHALL be eligible to satisfy an explicit prerequisite. Satisfying that prerequisite SHALL NOT grant permission to use the contribution.

#### Scenario: Adopt portable instructions without author adaptation
- **WHEN** the owner selects an installed portable command, skill, or agent whose runtime settings are absent, null, or empty
- **THEN** all three cases SHALL be admitted identically without a refusal for missing runtime settings
- **AND** the owner SHALL NOT need to alter the published facet or supply a replacement opt-in marker
- **AND** the contribution SHALL remain subject to installation integrity and the consuming agent's permissions

#### Scenario: Other coding-tool settings are not runtime controls
- **WHEN** a portable contribution contains settings specific to another coding tool and no runtime settings
- **THEN** those settings SHALL NOT select the runtime's provider, tools, hooks, or permissions
- **AND** inspection SHALL identify portable admission rather than imply that those settings are enforced

#### Scenario: An invalid explicit block is not portable fallback
- **WHEN** a contribution has explicit runtime settings with a malformed restriction, unsupported version, or unsupported field
- **THEN** the contribution SHALL be refused with the affected setting identified
- **AND** the system SHALL NOT remove those settings and admit the contribution as unrestricted portable instructions

#### Scenario: Explicit requirements still bind alongside portable contributions
- **WHEN** a contribution declares supported prerequisites or restrictions through explicit runtime settings
- **AND** portable contributions exist in the same installation
- **THEN** those prerequisites SHALL still be checked and those restrictions SHALL still be enforced
- **AND** portable admission of other contributions SHALL NOT relax them

#### Scenario: Runtime settings contain only installer identity fields
- **WHEN** a contribution has valid installer-supplied identity fields and no behavioral runtime settings
- **THEN** it SHALL receive portable admission
- **AND** missing `runtimeVersion` SHALL NOT cause refusal

#### Scenario: An explicit prerequisite identifies a ready portable contribution
- **WHEN** an otherwise valid explicit command requires an installed skill or agent that is ready with portable admission
- **THEN** portable admission SHALL NOT make that prerequisite unavailable
- **AND** execution SHALL remain subject to the owner's grants and applicable restrictions

### Requirement: Explicit runtime settings keep strict validation

Runtime settings SHALL be explicit when any field remains after exclusion of installer-supplied `name` and `description`.

Explicit runtime settings SHALL declare supported `runtimeVersion: 1`. Missing or unsupported versions, malformed values, unsupported fields, and unsupported behavior SHALL cause refusal.

Malformed non-object settings SHALL NOT be treated as absent or empty settings.

Validation of explicit settings SHALL precede prerequisite resolution. The same invalid settings SHALL produce the same setting-validation refusal.

Valid explicit settings SHALL preserve their prerequisites, restrictions, and supported defaults. The system SHALL NOT discard settings to obtain portable admission.

#### Scenario: Explicit restrictions omit the runtime version
- **WHEN** runtime settings contain a restriction but no `runtimeVersion`
- **THEN** the contribution SHALL be refused with the missing version identified
- **AND** the restriction SHALL NOT be discarded to obtain portable admission

#### Scenario: Explicit settings contain only the supported version
- **WHEN** otherwise valid runtime settings contain only `runtimeVersion: 1` and optional installer identity fields
- **THEN** the contribution SHALL receive explicit admission with the supported defaults
- **AND** it SHALL NOT acquire prerequisites, restrictions, or authority from those defaults

#### Scenario: Runtime settings have a malformed top-level value
- **WHEN** runtime settings are neither absent, null, nor an object of fields
- **OR** runtime settings are an array
- **THEN** the contribution SHALL be refused as malformed
- **AND** the value SHALL NOT be treated as empty runtime settings

#### Scenario: Invalid settings also name a missing prerequisite
- **WHEN** explicit runtime settings fail validation and also name a missing prerequisite
- **THEN** the refusal SHALL identify the invalid settings before prerequisite resolution
- **AND** repeating the same inputs SHALL produce the same setting-validation refusal

### Requirement: Settings for other tools are not runtime controls

Settings for other coding tools and primary-file front matter SHALL NOT become runtime settings.

Their contents SHALL NOT select the runtime's provider, tools, hooks, or permissions. They SHALL NOT create enforced runtime prerequisites or restrictions.

The runtime SHALL NOT report those contents as enforced behavior. Their lack of runtime meaning SHALL NOT bypass installation, integrity, content, or credential checks.

#### Scenario: Primary-file front matter contains a tool restriction
- **WHEN** an otherwise valid portable contribution has a tool restriction in its primary-file front matter
- **THEN** that restriction SHALL NOT become an enforced runtime restriction
- **AND** inspection SHALL identify portable admission without claiming that the front-matter restriction is enforced
- **AND** independent owner permissions SHALL remain effective

### Requirement: Contribution admission is identifiable

The installed-capability view and console SHALL identify each ready contribution's admission as portable or explicit.

A refused contribution SHALL show its refusal reason without an admission label.

The portable-admission explanation SHALL distinguish absent runtime settings from permission to execute. It SHALL NOT imply that settings for other tools are enforced.

#### Scenario: Inspect portable and explicit contributions together
- **WHEN** the owner inspects an installation containing ready portable and explicit contributions
- **THEN** the installed-capability view and console SHALL identify their respective admissions
- **AND** the portable explanation SHALL identify the absence of runtime settings without implying granted authority

#### Scenario: Inspect a refused contribution without an admission label
- **WHEN** the owner inspects a contribution refused for invalid runtime settings
- **THEN** the console SHALL show the refusal reason
- **AND** it SHALL NOT label that contribution as portable or explicit

### Requirement: Earlier installation artifacts require regeneration

The system SHALL accept only exports and sealed installations that satisfy the current admission contract and integrity checks.

It SHALL refuse incompatible earlier artifacts rather than infer admission or convert them automatically. Upgrade guidance SHALL explain regeneration and replacement of the owner-pinned bundle digest.

This refusal SHALL NOT authorize changes to owner configuration or disable otherwise valid native goal starts.

#### Scenario: The runtime receives an incompatible earlier sealed installation
- **WHEN** the configured sealed installation uses an incompatible earlier representation
- **THEN** the installation SHALL be unavailable and its contributions SHALL NOT be offered
- **AND** the refusal and upgrade guidance SHALL identify the need to regenerate and pin the resulting bundle
- **AND** native goal starts SHALL remain subject to their normal checks

#### Scenario: Sealing encounters an incompatible earlier export
- **WHEN** the owner attempts to seal an incompatible earlier export
- **THEN** sealing SHALL fail with the affected export identified
- **AND** it SHALL NOT produce a usable installation by inferring missing admission

#### Scenario: The owner regenerates a compatible installation
- **WHEN** the owner regenerates valid exports and a sealed installation from configured sources and pins its new digest
- **THEN** the runtime SHALL accept the installation if its current validation and integrity checks pass
- **AND** contributions previously refused only for missing runtime settings SHALL become ready with portable admission
- **AND** other applicable refusals and owner restrictions SHALL remain effective

## MODIFIED Requirements

### Requirement: Supported facet behavior is explicit

The system SHALL document the supported subset of command, skill, agent, permission, and MCP declaration behavior.

The documented subset SHALL state that runtime settings are optional. It SHALL distinguish explicit runtime requirements from other tools' settings and primary-file front matter.

A contribution that explicitly declares unsupported runtime behavior SHALL be refused before that behavior is used. The explanation SHALL identify the contribution and unsupported requirement. The system SHALL NOT discard a declared behavioral requirement to run the contribution.

A contribution SHALL be unusable if an explicitly declared prerequisite is absent or refused. This check SHALL apply to supported declarations. It SHALL NOT infer dependencies from prose alone. Unrelated usable contributions SHALL remain available.

#### Scenario: An agent requires unsupported execution behavior
- **WHEN** a facet-defined agent explicitly requires parallel, background, or long-lived delegation through its runtime settings
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
- **AND** that prerequisite is absent or refused
- **THEN** the command SHALL be shown as unusable with that prerequisite named
- **AND** starting it SHALL dispatch no model or tool work
- **AND** another otherwise usable contribution with no dependency on the refused item SHALL remain available
