# Spec Delta

## ADDED Requirements

### Requirement: Owner configuration defines agents directly without fixed agent-count limits

The owner SHALL be able to define each agent with its own instructions, facet selections, startup skills, and permitted delegation targets.

The configuration SHALL NOT require a reference to an existing native agent or installed agent contribution.

Configured agents, delegation-target lists, and permitted-entry sets SHALL NOT have separate fixed count limits.

References SHALL still identify configured agents. Applicable identifier, facet-content, and startup-instruction validation SHALL remain effective.

A failure SHALL identify its actual cause rather than invent an agent-count limit.

#### Scenario: Agent configuration exceeds the previously proposed count bound
- **WHEN** the owner configures more than 32 agents with valid references
- **AND** each agent passes applicable content and startup-instruction validation
- **THEN** configuration validation SHALL NOT reject the configuration because of the number of agents
- **AND** valid target lists and permitted-entry sets above 32 SHALL NOT be rejected solely for their counts

#### Scenario: Define an agent directly
- **WHEN** the owner supplies a valid agent configuration with its own instructions
- **THEN** the system SHALL NOT require a reference to an existing native agent or installed agent contribution
- **AND** its selected facets and delegation targets SHALL remain subject to their normal validation

### Requirement: Consuming configuration changes are explicit

Independent agent configuration and the separate entry policy SHALL come from owner-managed operator configuration.

Configuration changes SHALL take effect on restart. Entry eligibility SHALL remain outside individual agent configurations.

A run MAY select a permitted entry agent. It SHALL NOT override the entry policy, facet selections, startup skills, or delegation targets.

Agent instructions and tool results SHALL NOT change agent configuration or entry eligibility.

#### Scenario: Restart applies an owner configuration change
- **WHEN** the owner changes facet selections or delegation targets and restarts with valid configuration
- **THEN** newly accepted runs SHALL resolve selections from that configuration
- **AND** existing runs SHALL retain their accepted configurations and relationships
- **AND** current independent revocations and continuation compatibility SHALL remain effective

### Requirement: Superseded flat selections require explicit migration

The runtime SHALL refuse superseded flat skill and agent selections, whether supplied alone or alongside the new configuration.

The refusal SHALL identify the obsolete settings and explain the required owner configuration changes.

Migration guidance SHALL preserve independent server approvals, tool grants, argument restrictions, and credential boundaries.

The runtime SHALL NOT silently map old selections to every agent, rewrite owner configuration, or start agent work as part of migration.

Guidance SHALL identify any additional contributions made available by facet-level selection. It SHALL NOT describe broader availability as equivalent access.

#### Scenario: Old flat lists need migration
- **WHEN** configuration contains the superseded flat skill or agent selection fields
- **THEN** the runtime SHALL refuse that configuration with migration guidance
- **AND** it SHALL NOT ignore the fields or grant their selections to every agent
- **AND** the same refusal SHALL apply when old and new fields appear together

#### Scenario: Selection migration preserves independent grants
- **WHEN** the owner follows the documented selection migration
- **THEN** existing server approvals, tool grants, and argument restrictions SHALL remain unchanged unless separately approved
- **AND** migration SHALL NOT prescribe broader grants to make the new selection valid

### Requirement: Owner choices remain available through bounded pages

Valid owner choices SHALL remain accessible when they exceed one page.

The console SHALL request further pages rather than truncate valid agents, workspaces, contributions, or registered tools.

Paging SHALL preserve its context and revision rules. A page boundary SHALL NOT become a fixed configuration-count limit.

#### Scenario: More choices exist than fit one page
- **WHEN** valid owner choices exceed the first page
- **THEN** the owner SHALL be able to reach the remaining choices through further pages
- **AND** the console SHALL NOT silently hide them or treat the first page as the complete configuration

### Requirement: Tool permissions and sandbox constraints remain separate

A sandbox SHALL constrain local execution without granting tool permission, critical-operation approval, or remote-resource access.

Tool permissions SHALL remain explicit and enforced independently of writable workspace storage.

Subprocesses SHALL remain subject to the sandbox boundary. Permission to perform one operation SHALL NOT authorize escape from its permitted scope.

Remote tools SHALL remain subject to their own resource permissions. Local filesystem confinement SHALL NOT establish confinement of a remote service.

#### Scenario: A sandbox does not grant tool permission
- **WHEN** an agent has a writable workspace but lacks permission for a requested tool operation
- **THEN** the runtime SHALL refuse the operation
- **AND** sandbox write access SHALL NOT supply the missing permission

#### Scenario: A subprocess attempts to escape the sandbox
- **WHEN** an authorized operation starts a subprocess that attempts access outside its sandbox constraints
- **THEN** the enforced boundary SHALL prevent that access
- **AND** tool permission or critical-operation approval SHALL NOT authorize the escape

#### Scenario: A remote tool needs independent resource permission
- **WHEN** an agent requests a remote operation through an otherwise permitted tool
- **THEN** the request SHALL remain subject to applicable remote-resource and argument restrictions
- **AND** local workspace confinement SHALL NOT be presented as proof of permission for the remote effect

### Requirement: Execution policies use immutable validated revisions

A workspace SHALL own its authoritative execution-policy revision. Invocations SHALL use their run's workspace under that policy.

New work SHALL NOT widen the policy or change it beneath active execution.

Policy edits SHALL create immutable revisions. They SHALL NOT overwrite revisions retained by runs or approval requests.

A revision ID SHALL identify policy content, not select an earlier record format.

Docker SHALL be the only initial sandbox variant. Image, user, memory, CPU, process, temporary-storage, mount, and network settings SHALL have strict validation.

Malformed policy records, unsupported variants, and unenforceable restrictions SHALL be refused. Refusal SHALL NOT grant unrestricted access.

Policy records SHALL use the existing application database. Producer provenance SHALL NOT grant authority by itself.

An unsupported producer or classifier SHALL require an explicitly supported authorization contract before it can change policy. Automatic classification remains outside this change.

#### Scenario: A policy record identifies its revision without a schema version
- **WHEN** the owner saves a classification or execution policy
- **THEN** the record SHALL have an immutable revision ID and match its current strict schema
- **AND** it SHALL NOT contain a numeric field that selects an internal format, profile, or schema version

#### Scenario: A policy record contains a schema version field
- **WHEN** the runtime reads a classification or execution-policy record with an internal schema-version selector
- **THEN** the runtime SHALL reject the record as incompatible with its current strict schema
- **AND** it SHALL NOT use the field to select another interpretation

#### Scenario: A policy uses an unsupported sandbox contract
- **WHEN** an execution policy names an unsupported sandbox variant or restriction, or fails current-record validation
- **THEN** the runtime SHALL reject it with the unsupported part identified
- **AND** it SHALL NOT ignore that part, convert an earlier format, or claim that the requested confinement is enforced

#### Scenario: Provenance is not authorization
- **WHEN** a record or proposal names an unsupported classifier or producer in its provenance
- **THEN** that metadata SHALL NOT authorize a policy change or critical-operation decision
- **AND** an explicitly supported producer and authorization contract SHALL be required

### Requirement: A development reset regenerates runtime facet inputs

The deployment procedure SHALL regenerate runtime adapter exports and sealed bundles from the configured facet sources after the applicable development reset.

Regeneration SHALL preserve the independent runtime manifest, lockfile, materialization choices, and source provenance.

It SHALL NOT use an editor's materialized copies as runtime sources or modify upstream facet content.

#### Scenario: Generate the runtime installation again after a reset
- **WHEN** the owner prepares the current runtime installation after an approved development reset
- **THEN** adapter exports and the sealed bundle SHALL be generated from the configured facet sources
- **AND** the runtime SHALL validate the regenerated inputs under the current admission contract
- **AND** editor installations and upstream facet sources SHALL remain unchanged

### Requirement: Admission decisions from before a reset are not used again

The runtime SHALL evaluate regenerated contributions under the current admission contract.

An earlier refusal SHALL NOT be converted into a ready definition by editing its stored disposition.

The runtime SHALL NOT retain an earlier admission decision as a substitute for validating the regenerated input.

#### Scenario: An earlier refusal does not carry forward
- **WHEN** a contribution was refused before the reset and is regenerated under the current admission contract
- **THEN** its current metadata and content SHALL determine its admission
- **AND** an old refusal SHALL NOT force rejection or be edited into a ready definition
- **AND** supported explicit restrictions SHALL remain effective

### Requirement: Facet version identifiers keep their meaning

The current internal record format SHALL NOT change external facet versions, manifest versions, lockfile versions, or dependency pins.

Explicit authored `runtimeVersion: 1` settings SHALL retain their supported meaning.

Regeneration SHALL NOT require an upstream package-format change or an internal-format marker in authored facets.

#### Scenario: Authored version metadata stays valid
- **WHEN** a facet supplies supported explicit `runtimeVersion: 1` settings
- **THEN** regeneration SHALL validate them under that authored contract
- **AND** the internal record-format change SHALL NOT require the author to change that version
- **AND** malformed or unsupported settings SHALL still be refused
