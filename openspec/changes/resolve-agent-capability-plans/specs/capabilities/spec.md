# Spec Delta

## ADDED Requirements

### Requirement: Facet selection belongs to consuming agents

Each configured agent SHALL have independent instructions, facet selections, startup skills, and permitted delegation targets.

There SHALL be no shared selection scope or separate configuration type for entry agents and delegates. Selections and startup skills SHALL NOT be inherited from another agent.

Installation alone SHALL NOT select a facet. Selection SHALL NOT fetch missing facets, modify the installation, or grant MCP authority.

An agent's contributions SHALL resolve from its own selections, recorded materialization choices, compatibility checks, prerequisites, and applicable permissions.

Facet selection SHALL include all installed, materialized contributions of the facet as availability candidates. It SHALL NOT require additional per-agent server, tool, skill, or command allowlists.

Installation omissions, owner grants, resource restrictions, and interaction-mode rules SHALL remain effective.

Availability SHALL NOT load every skill body at startup or implicitly add task-delegation relationships.

Duplicate selections SHALL resolve once. Each facet reference SHALL identify exactly one installed facet.

Missing or ambiguous references SHALL cause configuration refusal at startup. The explanation SHALL identify the agent, field, reference, and safe cause.

An explicit prerequisite SHALL NOT implicitly select another facet. An unusable contribution SHALL NOT make unrelated usable contributions unavailable.

#### Scenario: Select a facet without a second contribution allowlist
- **WHEN** an agent selects an installed facet with supported skills, commands, and MCP tool declarations
- **AND** applicable checks pass
- **THEN** those contributions SHALL become availability candidates without another per-agent server or contribution list
- **AND** owner tool approval, critical-operation approval, startup activation, and discussion restrictions SHALL still apply independently

#### Scenario: Facet selection does not approve a tool
- **WHEN** a selected facet declares an MCP tool without applicable owner approval
- **THEN** selecting the facet SHALL NOT authorize execution of that tool
- **AND** inspection SHALL distinguish facet selection from the missing approval

#### Scenario: Configure the same facet independently for several agents
- **WHEN** the owner selects the same installed portable skill facet in two agent configurations
- **AND** no applicable restriction excludes it
- **THEN** each agent SHALL be able to discover and load that skill through its own configuration
- **AND** neither selection SHALL depend on inheritance from the other agent
- **AND** the facet SHALL NOT require knowledge of those agents or an authored runtime block

#### Scenario: Select a facet for one agent only
- **WHEN** a facet is selected for a caller but is absent from its delegate's configuration
- **THEN** the caller SHALL have its compatible contributions available within its permissions
- **AND** the delegate SHALL NOT receive that facet's skills in its catalog or be allowed to load them
- **AND** delegation SHALL NOT copy the caller's loaded skills into the delegate's instruction context

#### Scenario: Install without selecting
- **WHEN** a facet is installed but no agent configuration selects it
- **THEN** its contributions SHALL remain inspectable as installed but unselected
- **AND** installation alone SHALL NOT give agents its skills, delegate targets, or MCP tools

#### Scenario: An agent repeats a selection
- **WHEN** an agent's configuration repeats a facet or startup skill reference
- **THEN** its effective contributions SHALL be identified unambiguously without duplicate skill listings or startup instruction insertion
- **AND** inspection SHALL identify the configured agent responsible for the selection

#### Scenario: A configured facet reference cannot be resolved
- **WHEN** startup configuration selects a facet reference that matches no installed facet or more than one installed facet
- **THEN** the system SHALL refuse the configuration before accepting runs
- **AND** the explanation SHALL identify the agent, field, reference, and conflicting facets when applicable
- **AND** the system SHALL NOT drop, substitute, or install a facet to make the configuration valid

#### Scenario: Installation changes invalidate an existing selection
- **WHEN** an installation change makes a previously valid configured facet reference unresolved
- **THEN** an affected new run SHALL be refused before model or tool dispatch with that reference identified
- **AND** the system SHALL NOT silently omit the selected facet
- **AND** existing runs SHALL remain governed by their retained selections and continuation rules

#### Scenario: An installed contribution has an unavailable prerequisite
- **WHEN** a selected facet contains a contribution with an explicit prerequisite unavailable to the consuming agent
- **THEN** inspection SHALL identify that contribution as unusable for that agent with the prerequisite named
- **AND** work using that contribution SHALL be refused before dispatch without selecting another facet implicitly
- **AND** unrelated usable contributions SHALL remain available

### Requirement: Delegation targets belong to each configured agent

Each agent SHALL have an explicit list of permitted delegation targets. Every target SHALL identify a configured agent.

An absent or empty list SHALL permit no delegation. The relationships SHALL apply whether the caller is an entry agent or a delegated invocation.

Facet selection SHALL NOT implicitly add targets. A caller SHALL NOT need to copy a target's facet selections into its own configuration.

A target list SHALL describe that agent's outgoing relationships, not all relationships available to its descendants.

Delegation SHALL remain subject to permissions, target usability, depth limits, and work budgets.

#### Scenario: A configured target has its own capabilities
- **WHEN** a caller delegates to a permitted configured target with different facet selections
- **THEN** the target SHALL use its own retained configuration under applicable execution restrictions
- **AND** the caller SHALL NOT need to select those facets merely to name the target

#### Scenario: Facet selection does not authorize delegation
- **WHEN** a selected facet contains an agent contribution
- **AND** the caller has no configured relationship to the requested target
- **THEN** facet selection alone SHALL NOT give the caller permission to invoke that target

#### Scenario: An agent has no delegation targets
- **WHEN** an agent's configured target list is absent or empty
- **THEN** that agent SHALL NOT delegate
- **AND** other agents in the installation or configuration SHALL NOT create an implicit relationship

#### Scenario: Entry eligibility and delegation permission are separate
- **WHEN** an agent is permitted as an entry point
- **AND** a caller has no configured delegation relationship to it
- **THEN** entry eligibility SHALL NOT permit that caller to invoke it
- **AND** an agent outside the entry set SHALL remain callable through an otherwise permitted delegation relationship

### Requirement: Configured identities do not silently replace authored agent references

Installed agent contributions and independently configured agents SHALL remain distinct identities.

Facet selection SHALL NOT automatically activate installed agent instructions or bind their restrictions to a configured agent.

An explicit installed-agent prerequisite or nonempty authored agent restriction SHALL be refused when no supported binding exists.

The runtime SHALL NOT satisfy that reference through a matching configured name or discard the unsupported requirement.

An explicit empty authored agent restriction SHALL prohibit child interactions within its scope, including discussion.

Supported command restrictions SHALL constrain the entire affected run. An absent restriction category SHALL add no restriction. An explicit empty category SHALL deny that category.

A caller's omitted facet or outgoing target SHALL NOT become an inherited denial.

#### Scenario: A configured name matches an installed agent
- **WHEN** a contribution requires an installed agent
- **AND** an independently configured agent has the same textual name
- **THEN** the runtime SHALL NOT treat the name match as an executable binding
- **AND** it SHALL report the unsupported requirement without making unrelated contributions unavailable

### Requirement: Startup skill activation is explicitly configured

The owner SHALL be able to designate a selected skill for an agent's startup instructions.

Startup preparation SHALL contain the retained full instructions of each designated skill. It SHALL NOT truncate, interpolate, or duplicate those bodies.

The system SHALL validate startup selections against the agent's effective selections, compatibility, prerequisites, and applicable permissions.

Unavailable, incompatible, disallowed, or over-limit startup selections SHALL prevent the affected activation before its first model request.

The refusal SHALL identify the agent, affected skills, and safe cause. It SHALL NOT omit a required skill or downgrade it to on-demand loading.

Startup preparation SHALL NOT dispatch a model request, consume a model step, grant authority, or execute skill scripts.

Only explicitly designated skills SHALL receive automatic startup preparation. A description that instructs the agent to load a skill SHALL NOT itself establish startup activation.

The system SHALL preserve the documented startup limits. These limits SHALL NOT become a cumulative limit on retained conversation history.

#### Scenario: An imperative description does not force activation
- **WHEN** a selected on-demand skill's description says to load it first
- **AND** the owner has not designated it for startup
- **THEN** that description SHALL NOT by itself cause the runtime to preload the skill body
- **AND** the agent SHALL remain able to request the skill through ordinary permitted skill loading

#### Scenario: Startup activation respects agent selection
- **WHEN** startup configuration names a skill outside that agent's effective facet selections or permissions
- **THEN** the affected agent SHALL NOT dispatch its first model request
- **AND** the system SHALL identify the invalid startup selection
- **AND** it SHALL NOT implicitly select the facet or widen permissions

#### Scenario: Startup instructions exceed a supported bound
- **WHEN** an agent's configured startup instructions exceed a documented limit
- **THEN** the system SHALL report that limit before the agent's first model request
- **AND** it SHALL NOT truncate the instructions or downgrade the skills to on-demand loading

#### Scenario: Only designated skills are preloaded
- **WHEN** an agent has several available skills and only one is designated for startup
- **THEN** its first model request SHALL contain only the designated skill's full instructions
- **AND** the other skills SHALL remain discoverable by name and description until explicitly loaded

## MODIFIED Requirements

### Requirement: Installed contributions are identifiable

The owner SHALL be able to inspect installed commands, skills, agents, and MCP server declarations with their names, descriptions, originating facets, and versions.

Contribution references SHALL identify their targets unambiguously. Conflicting names SHALL NOT silently select or replace one contribution with another.

Inspection SHALL distinguish installation from each agent's effective selections and startup configuration.

Portable admission, explicit runtime behavior, and refusal SHALL remain distinct from authorization.

#### Scenario: Inspect available workflow contributions
- **WHEN** the owner inspects the runtime's installed facets in the console
- **THEN** the console SHALL identify each installed contribution, its originating facet and version, and its portable or explicit admission basis
- **AND** it SHALL show for which agents the contribution is selected and usable or refused
- **AND** a refused contribution SHALL include its reason rather than appear ready for use
- **AND** server grants, tool grants, and available delegation targets SHALL remain inspectable separately from further restrictions within a run

#### Scenario: Inspect what each agent receives
- **WHEN** the owner inspects a facet selected for one agent and another selected independently for several agents
- **THEN** inspection SHALL distinguish each agent's selections, instructions, and configured delegation targets
- **AND** it SHALL distinguish configured startup loading from on-demand availability
- **AND** neither selection nor a startup setting SHALL be reported as evidence of actual use
- **AND** inspection SHALL be available without starting a run
- **AND** it SHALL distinguish unselected contributions from those excluded by known compatibility or permission restrictions, with reasons

#### Scenario: Two contributions have an unresolved name conflict
- **WHEN** two installed contributions cannot be distinguished by the name used to select them
- **THEN** the system SHALL report the conflict and the contributing facets
- **AND** it SHALL NOT resolve the reference by installation order or overwrite either contribution silently

### Requirement: Skills are discovered and loaded on demand

An agent SHALL be able to discover the names and descriptions of skills available through its effective selections.

It SHALL be able to load a selected skill's full instructions explicitly when needed.

Skill discovery SHALL NOT supply every skill's full instructions as initial context. Only explicitly configured startup skills SHALL be preloaded.

Loading a skill SHALL NOT install assets or grant authority.

A loaded skill's bundled text references SHALL be readable on demand from its retained definitions. Access SHALL remain confined to that skill's bundled resources.

This rule SHALL apply to startup-loaded and on-demand-loaded skills. It SHALL NOT grant deployment-filesystem access or code execution.

A reference read SHALL require the skill in the requester's current effective capabilities. A body retained from an earlier agent selection SHALL NOT itself authorize access.

#### Scenario: Load an applicable skill
- **WHEN** an agent selects an available skill from its advertised name and description
- **THEN** the system SHALL supply its full instructions from the definitions bound to the run
- **AND** the run SHALL identify the skill and facet version loaded

#### Scenario: An unused skill stays out of the full instruction context
- **WHEN** a run has several available skills, none configured for startup, and loads only one
- **THEN** the other skills' full instructions SHALL NOT be included merely because those skills are installed or available

#### Scenario: Request a missing or disallowed skill
- **WHEN** an agent asks to load a skill missing from its bound definitions, outside its effective selections, or not permitted to it
- **THEN** the system SHALL return an identifiable refusal
- **AND** it SHALL NOT supply another skill or install one

#### Scenario: Read a bundled skill reference
- **WHEN** an agent requests a bundled text reference belonging to a startup-loaded or on-demand-loaded skill
- **AND** the request remains permitted under its current effective capabilities
- **THEN** the system SHALL supply the reference from that skill's retained definitions
- **AND** a later installation update SHALL NOT substitute another version

#### Scenario: A skill reference is missing or escapes its bundle
- **WHEN** an agent requests a reference from an unloaded skill, outside its current capabilities, missing from retained resources, or outside the skill's bundle
- **THEN** the system SHALL refuse the request without exposing unrelated content
- **AND** loading the skill SHALL NOT authorize arbitrary filesystem access or execution of a referenced script
