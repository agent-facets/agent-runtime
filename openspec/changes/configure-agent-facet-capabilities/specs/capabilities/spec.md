# Capabilities Spec Delta

## ADDED Requirements

### Requirement: Facet selection belongs to consuming agents

The owner SHALL be able to select installed facets in consuming configuration shared by all agents and in configuration for an individual agent. This SHALL apply to the existing root agent and named delegates. Facet authors SHALL NOT need to name consuming agents or supply a runtime opt-in marker for portable instructions. Installation alone SHALL NOT select a facet for any agent. A selection SHALL NOT fetch missing facets, modify the installation, or grant MCP authority.

An agent's available contributions SHALL be resolved from the union of its shared and individual facet selections, the recorded installation's materialization choices, compatibility checks, and effective permissions. Individual selections SHALL add to, not replace, shared selections; duplicate selections SHALL resolve once. Each facet reference SHALL identify exactly one installed facet. Missing or ambiguous facet references SHALL cause configuration refusal at startup, identifying the configuration scope and reference. An explicit prerequisite SHALL NOT implicitly select an additional facet for an agent.

#### Scenario: Share a facet across agents
- **WHEN** the owner selects an installed portable skill facet in shared configuration and no applicable restriction excludes it
- **THEN** the root agent and named delegates SHALL be able to discover and load that skill
- **AND** the facet SHALL NOT require knowledge of those agents or an authored runtime block

#### Scenario: Select a facet for one agent only
- **WHEN** a facet is selected for the root agent but is absent from shared configuration and a named delegate's configuration
- **THEN** the root agent SHALL have its compatible contributions available within its permissions
- **AND** the delegate SHALL NOT receive that facet's skills in its skill catalog or be allowed to load them
- **AND** delegation SHALL NOT automatically copy the root agent's loaded skills into the delegate's instruction context

#### Scenario: Install without selecting
- **WHEN** a facet is installed but no shared or individual agent configuration selects it
- **THEN** its contributions SHALL remain inspectable as installed but unselected
- **AND** agents SHALL NOT acquire its skills, delegate targets, or MCP tools merely because it was installed

#### Scenario: Shared and individual selections overlap
- **WHEN** shared and individual configuration both select the same installed facet for an agent
- **THEN** its effective contributions SHALL be identified unambiguously without duplicate skill listings or duplicate startup instruction insertion
- **AND** inspection SHALL identify the selection sources

#### Scenario: A configured facet reference cannot be resolved
- **WHEN** startup configuration selects a facet reference that matches no installed facet or more than one installed facet
- **THEN** the system SHALL refuse the configuration before accepting runs, identifying the shared or individual scope, reference, and conflicting facets when applicable
- **AND** it SHALL NOT drop, substitute, or install a facet to make the configuration valid

#### Scenario: Installation changes invalidate an existing selection
- **WHEN** an installation change makes a previously valid configured facet reference unresolved
- **THEN** an affected new run SHALL be refused before model or tool dispatch with that reference identified
- **AND** the system SHALL NOT silently omit the selected facet
- **AND** existing runs SHALL remain governed by their retained selections and continuation rules

#### Scenario: An installed contribution has an unavailable prerequisite
- **WHEN** a selected facet contains a contribution with an explicit prerequisite unavailable to the consuming agent
- **THEN** inspection SHALL identify that contribution as unusable for that agent with the prerequisite named
- **AND** work using that contribution SHALL be refused before dispatch without implicitly selecting another facet
- **AND** unrelated usable contributions SHALL remain available

### Requirement: Consuming configuration changes are explicit

The system SHALL accept shared and per-agent facet configuration through owner-managed operator configuration, taking effect on restart rather than through per-run or console-side overrides.

#### Scenario: Restart applies an owner configuration change
- **WHEN** the owner changes agent facet selections and restarts with valid configuration
- **THEN** newly accepted runs SHALL resolve selections from that configuration
- **AND** existing runs SHALL retain their accepted selections subject to current owner revocations and continuation compatibility

#### Scenario: A task attempts to override selection
- **WHEN** a goal, command argument, or agent instruction requests an unselected facet or a different agent configuration
- **THEN** that request SHALL NOT change effective selection or install the facet
- **AND** the task SHALL remain within the configuration accepted for its run

### Requirement: Superseded flat selections require explicit migration

The superseded `capabilities.allowSkills` and `capabilities.allowAgents` fields SHALL be refused at startup with migration guidance, whether supplied alone or alongside the new configuration. Migration guidance SHALL distinguish facet selection, startup activation, and independent tool grants, and SHALL NOT prescribe broadening access merely to preserve usability.

#### Scenario: Old flat lists need migration
- **WHEN** startup receives configuration containing either superseded flat-list field
- **THEN** startup SHALL refuse that configuration and identify the field and required migration
- **AND** it SHALL NOT reinterpret the list as shared access for every agent
- **AND** it SHALL NOT rewrite configuration or start agent work as part of migration

#### Scenario: Selection migration preserves independent grants
- **WHEN** the owner migrates selection configuration without changing server approvals, tool grants, or argument restrictions
- **THEN** those approvals, grants, and restrictions SHALL remain unchanged
- **AND** migration SHALL NOT implicitly approve a server, grant a tool, or relax an argument restriction
- **AND** guidance SHALL identify any additional contributions a proposed facet selection would expose rather than describe that expansion as an equivalent migration

### Requirement: Startup skill activation is explicitly configured

The owner SHALL be able to designate a selected skill for startup loading for an agent. Its full instructions SHALL be supplied before that agent's first model request and SHALL remain available during compatible continuation from the run's retained definitions. Startup loading SHALL NOT itself dispatch a model request, consume a model step, grant authority, or execute skill scripts. The system SHALL enforce documented finite startup-instruction limits. Unavailable, incompatible, disallowed, or over-limit startup selections SHALL refuse the affected root run or delegate invocation before its first model request, identifying the agent and affected skills rather than silently omitting or truncating instructions. A safely reported delegate-startup refusal SHALL return to the caller without by itself failing the containing run.

#### Scenario: Load a skill before an agent begins
- **WHEN** an agent starts with a valid selected startup skill
- **THEN** its first model request SHALL contain that installed skill's full instructions
- **AND** the run SHALL record the responsible agent, skill identity, facet version, and startup activation
- **AND** the loading operation itself SHALL consume no model step

#### Scenario: An imperative description does not force activation
- **WHEN** a selected on-demand skill's description says to load it first but the owner has not designated it for startup
- **THEN** that description SHALL NOT by itself cause the runtime to preload the skill body
- **AND** the agent SHALL remain able to request the skill through ordinary permitted skill loading

#### Scenario: Startup activation respects agent selection
- **WHEN** startup configuration names a skill outside that agent's effective facet selections or permissions
- **THEN** the affected agent SHALL NOT dispatch its first model request
- **AND** the system SHALL identify the invalid startup selection without implicitly selecting the facet or widening permissions

#### Scenario: Startup instructions exceed a supported bound
- **WHEN** an agent's configured startup instructions exceed a documented limit
- **THEN** the system SHALL report that limit before the agent's first model request
- **AND** it SHALL NOT silently truncate the instructions or downgrade the skills to on-demand loading

#### Scenario: A startup skill is requested again
- **WHEN** an agent requests a skill whose retained instructions are already present from startup and use remains permitted
- **THEN** the system SHALL return an already-loaded result identifying the skill and version
- **AND** it SHALL NOT return a missing-skill refusal or insert a second copy of the instructions
- **AND** the load operation itself SHALL consume no model step; model requests SHALL continue to consume steps normally

#### Scenario: Only designated skills are preloaded
- **WHEN** an agent has several available skills and only one is designated for startup
- **THEN** its first model request SHALL contain only the designated skill's full instructions
- **AND** the other skills SHALL remain discoverable by name and description until explicitly loaded

#### Scenario: Shared startup activation is attributed separately
- **WHEN** the owner configures a selected skill for shared startup loading and the root agent invokes an eligible delegate
- **THEN** the root and delegate SHALL each receive that skill before their respective first model requests
- **AND** each startup activation SHALL identify the receiving agent

### Requirement: Portable contributions are admitted without runtime declarations

Portable command, skill, and agent instructions SHALL NOT require runtime-specific metadata. Absent, null, or empty runtime metadata SHALL be treated identically: no runtime-declared prerequisites or restrictions, and no granted authority. Settings belonging to other coding tools SHALL NOT acquire runtime meaning; documentation and inspection SHALL NOT present them as enforced.

Non-empty runtime settings SHALL be validated against the supported behavior. Supported requirements and restrictions SHALL remain enforced; unsupported or malformed settings SHALL cause refusal with the problem identified. The system SHALL NOT silently discard actual runtime settings to admit a contribution as portable.

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
- **WHEN** a contribution has supported explicit runtime prerequisites or restrictions and portable contributions exist in the same installation
- **THEN** those prerequisites SHALL still be checked and those restrictions SHALL still be enforced
- **AND** portable admission of other contributions SHALL NOT relax them

## MODIFIED Requirements

### Requirement: Supported facet behavior is explicit

The system SHALL document the supported subset of command, skill, agent, permission, and MCP declaration behavior.

A contribution whose explicitly declared required contribution is absent, refused, or unavailable to the consuming agent SHALL itself be unusable for that agent. This check SHALL apply to supported declarations, not infer dependencies from prose alone. Unrelated usable contributions SHALL remain available.

#### Scenario: An agent requires unsupported execution behavior
- **WHEN** a facet-defined agent explicitly requires, in its runtime declaration, parallel, background, or long-lived delegation that the runtime does not support
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
- **WHEN** a command explicitly declares, in a supported format, a required skill or agent that is absent, refused, or unavailable to the consuming agent
- **THEN** the command SHALL be shown as unusable for that agent with that prerequisite named
- **AND** starting it SHALL dispatch no model or tool work
- **AND** another otherwise usable contribution with no dependency on the refused item SHALL remain available

### Requirement: Installed contributions are identifiable

The owner SHALL be able to inspect installed commands, skills, agents, and MCP server declarations with their names, descriptions, originating facets, and versions. References used to select a contribution SHALL identify it unambiguously. Conflicting names SHALL NOT silently select or replace one contribution with another. Inspection SHALL distinguish installation from each agent's effective selection and startup configuration, and SHALL identify portable admission, explicit runtime behavior, or refusal separately from authorization.

#### Scenario: Inspect available workflow contributions
- **WHEN** the owner inspects the runtime's installed facets in the console
- **THEN** the console SHALL identify each installed contribution, its originating facet and version, its portable or explicit admission basis, and for which agents it is selected and usable or refused
- **AND** a refused contribution SHALL include its reason rather than appear ready for use
- **AND** the owner SHALL be able to inspect configured server and tool grants and agents available for delegation, separately from further restrictions applied within a run

#### Scenario: Inspect what each agent receives
- **WHEN** the owner inspects a facet selected only for the root agent and another selected through shared configuration
- **THEN** inspection SHALL distinguish each agent's effective selections and their shared or individual sources
- **AND** it SHALL distinguish configured startup loading from on-demand availability
- **AND** neither a selection nor a startup setting SHALL be reported as evidence of actual use in a run
- **AND** inspection SHALL be available without starting a run and SHALL distinguish unselected contributions from contributions excluded by known compatibility or permission restrictions, with reasons

#### Scenario: Two contributions have an unresolved name conflict
- **WHEN** two installed contributions cannot be distinguished by the name used to select them
- **THEN** the system SHALL report the conflict and the contributing facets
- **AND** it SHALL NOT resolve the ambiguous reference by installation order or silently overwrite either contribution

### Requirement: Skills are discovered and loaded on demand

An agent SHALL be able to discover the names and descriptions of the skills available through its effective selections and explicitly load a selected skill's full instructions when needed. Skill discovery SHALL NOT supply every skill's full instructions as initial agent context; only explicitly configured startup skills SHALL be preloaded. Loading a skill SHALL NOT install additional assets or grant additional authority. A loaded skill's bundled text references SHALL be readable on demand from its retained definitions, with access confined to that skill's bundled resources. This SHALL apply to both startup-loaded and on-demand-loaded skills and SHALL NOT grant general deployment-filesystem access or code execution.

#### Scenario: Load an applicable skill
- **WHEN** an agent selects an available skill from its advertised name and description
- **THEN** the system SHALL supply that skill's full instructions from the definitions bound to the run
- **AND** the run SHALL identify the skill and facet version that were loaded

#### Scenario: An unused skill stays out of the full instruction context
- **WHEN** a run has several available skills, none configured for startup, and loads only one of them
- **THEN** the other skills' full instructions SHALL NOT be included merely because those skills are installed or available

#### Scenario: Request a missing or disallowed skill
- **WHEN** an agent asks to load a skill that is missing from its bound definitions, outside its effective selections, or not permitted to that agent
- **THEN** the system SHALL return an identifiable refusal without supplying another skill or installing one

#### Scenario: Read a bundled skill reference
- **WHEN** an agent requests a bundled text reference belonging to a startup-loaded or on-demand-loaded skill
- **THEN** the system SHALL supply the reference from that skill's retained definitions
- **AND** a later installation update SHALL NOT substitute a different version of the reference

#### Scenario: A skill reference is missing or escapes its bundle
- **WHEN** an agent requests a reference belonging to a skill it has not loaded, missing from the loaded skill's retained resources, or targeting content outside them
- **THEN** the system SHALL refuse the request without exposing unrelated content
- **AND** loading the skill SHALL NOT authorize arbitrary filesystem access or execution of a referenced script

### Requirement: Facets and delegates can only narrow authority

The system SHALL enforce each agent's effective permissions from the owner's grants, narrowed by the applicable facet restrictions and, for a delegate, its caller's effective permissions. Installing or selecting a facet, designating a startup skill, loading instructions, or delegating a task SHALL NOT grant authority beyond the owner's permissions or override an existing restriction. Shared and individual selections SHALL determine availability without bypassing dispatch checks. Permission enforcement SHALL apply to actual dispatch, not only to which tools are advertised to the model.

An MCP grant's scope SHALL identify its server and tool and any supported constraints on request arguments. A target restriction means an owner-configured constraint on arguments selecting a resource, such as a repository identifier. The runtime SHALL enforce these constraints before dispatch and SHALL refuse restrictions it cannot enforce. These checks constrain requests, not the server process's independent access to resources.

#### Scenario: A facet requests more access than the owner granted
- **WHEN** a facet declares access to a tool or target outside the owner's grant
- **THEN** an agent using that facet SHALL NOT be able to dispatch the out-of-scope operation
- **AND** the refusal SHALL identify the denied operation without performing it

#### Scenario: A delegate has a narrower tool set
- **WHEN** a caller delegates to an agent whose restrictions exclude a tool that the caller can use
- **THEN** the delegate's attempt to call that tool SHALL be refused
- **AND** calling through another delegate SHALL NOT restore the excluded permission

#### Scenario: Instructions attempt to expand permissions
- **WHEN** a command, skill, delegate instruction, inspected file, or MCP response instructs an agent to acquire additional access
- **THEN** that content SHALL NOT change the agent's effective permissions or authorize the requested operation

#### Scenario: Shared selection is not a server approval
- **WHEN** a shared facet declares an MCP server without applicable owner approval
- **THEN** no agent SHALL launch or connect to that server or dispatch its tools on the strength of shared selection
- **AND** inspection SHALL distinguish selection from the missing approval

#### Scenario: Individual selection does not bypass the caller
- **WHEN** a delegate selects a facet containing a tool excluded by its caller's effective permissions
- **THEN** the delegate SHALL NOT dispatch that tool even if a broader deployment grant exists
- **AND** the refusal SHALL identify the restriction rather than silently widening the caller's authority
