# Execution Spec Delta

## ADDED Requirements

### Requirement: Goal runs use configured facet capabilities

For either supported subscription provider, a run started from a free-form goal SHALL make the existing root agent's configured, compatible, and authorized facet capabilities available without requiring a command. The root agent SHALL be able to load selected skills, delegate to available named agents, and call approved MCP tools within the same permission, budget, cancellation, question, and continuation rules as command-started runs. Delegates SHALL use their own retained effective facet selections rather than automatically inheriting the root agent's entire catalog.

A deployment without capability configuration SHALL retain the existing goal-based journey with confined native tools. Neither goal text nor a run-start request SHALL override owner-managed facet selections or replace the root agent with a facet-defined persona.

#### Scenario: Complete a facet-backed goal with either provider
- **WHEN** the owner selects either supported provider and submits a goal for an agent configured with a skill, a bounded named delegate, and an approved MCP tool
- **THEN** the run SHALL be able to load the skill, delegate a task, use the approved tool within effective permissions, ask and answer an owner question, and produce an inspectable result
- **AND** no selected command or synthetic command wrapper SHALL be required
- **AND** the run SHALL retain its selected provider and shared step budget across delegation and continuation

#### Scenario: Use the real voice-to-text skill at startup
- **WHEN** the owner installs the published `voice-to-text` facet unchanged into the independent runtime installation, selects it for the root agent, configures its skill for startup, and submits a goal containing dictated text
- **THEN** the root agent's first model request SHALL include that installed skill's instructions with the submitted goal
- **AND** the recorded run SHALL identify the skill's facet and version and startup loading
- **AND** neither runtime-specific author metadata nor a wrapper command SHALL be required

#### Scenario: A delegate has a different skill selection
- **WHEN** a goal run whose root uses `voice-to-text` delegates to an agent that has not selected that facet through shared or individual configuration
- **THEN** the system SHALL NOT automatically supply that skill's body or catalog entry to the delegate
- **AND** a delegate request to load the skill SHALL be refused without obtaining it from the root agent's loaded definitions

#### Scenario: Continue native operation without capabilities
- **WHEN** a deployment has no capability configuration and the owner submits a valid goal
- **THEN** the existing workspace read, search, question, and result journey SHALL remain available
- **AND** the system SHALL NOT require a facet installation or contact an MCP server to start that run
- **AND** absence of capability configuration alone SHALL NOT cause a warning, failure, or wait

## MODIFIED Requirements

### Requirement: Run history records ordered activity

The console SHALL show each run's ordered conversation and progress history, including agent messages, tool activity and outcomes, human questions and accepted answers, cancellation requests, status changes, and the final outcome. Recorded status changes SHALL include their recorded times. The selected command and its credential-safe arguments, startup skill supply for each agent, on-demand skill loads and bundled reference reads, delegation starts and outcomes, MCP calls, and capability refusals SHALL appear in that history. Agent-originated activity SHALL identify the responsible agent and facet contribution where applicable. Startup skill supply SHALL be recorded before the receiving agent's first model request and SHALL identify that agent, skill, originating facet, and version.

#### Scenario: Status changes remain inspectable
- **WHEN** a run changes from active work to waiting for an answer and then back to active work
- **THEN** its history SHALL show both changes in order with their recorded times
- **AND** the question and accepted answer SHALL remain visible

#### Scenario: Follow delegated activity
- **WHEN** a run delegates a task and the delegate records messages, tool calls, a question, and a result
- **THEN** the history SHALL distinguish that delegation and its activity from the caller's activity
- **AND** separate invocations of the same named agent SHALL remain distinguishable
- **AND** a delegate's result SHALL NOT by itself be presented as the whole run's successful final outcome

#### Scenario: Follow skill and MCP use
- **WHEN** a run loads a skill and calls an approved MCP tool
- **THEN** the history SHALL identify the skill load, the tool and server, and their originating facet versions
- **AND** it SHALL show the tool's recorded outcome, including a refusal, failure, or uncertainty rather than only successful output

#### Scenario: Capability activity is recorded in order
- **WHEN** a command run loads a skill, delegates a task, the delegate calls an approved tool and returns, and the caller finishes
- **THEN** the history SHALL show command selection, skill load, delegation start, the delegate's tool call and outcome, delegation end, and the final result in that order

#### Scenario: Goal-run startup activity is ordered
- **WHEN** a goal run preloads a root skill, later loads another skill on demand, and delegates to an agent with its own startup skill
- **THEN** history SHALL show root startup supply before the root's first message, the on-demand load when it occurs, delegation start, and delegate startup supply before the delegate's first message
- **AND** startup supply SHALL be distinguishable from an on-demand load and attributed to the receiving agent

### Requirement: Start a run from an installed command

The owner SHALL be able to start a run from the browser console by selecting an installed facet command available to the configured root agent, supplying its arguments, and selecting a subscription provider. The system SHALL validate the command's supported input requirements and explicitly declared prerequisites within that agent's selected capabilities before dispatching agent work and SHALL record the selected command, submitted arguments, and resulting task goal with the run. Command arguments SHALL be treated as owner input, not as authority to execute shell commands. A command SHALL supply task instructions and applicable narrowing constraints, not additional facet selections or grants.

Goal runs SHALL remain available whether or not runtime facets are installed, with capabilities resolved from the same consuming configuration rather than gated by command selection.

#### Scenario: Select a command and begin its task
- **WHEN** the owner selects a supported installed command available to the root agent and supplies valid arguments
- **THEN** the system SHALL create an identifiable run using that command's instructions and supplied arguments
- **AND** the console SHALL show the command, its originating facet and version, the task goal, workspace, and selected provider
- **AND** a command that requires no arguments SHALL NOT require an unrelated free-form goal

#### Scenario: Refuse an unusable command selection
- **WHEN** the selected command is missing, outside the root agent's selections, requires unsupported behavior, has an explicitly declared required contribution unavailable to that agent, or receives arguments that violate its declared constraints
- **THEN** the system SHALL explain the affected command and unmet requirement before dispatching model or tool work
- **AND** it SHALL NOT silently start a free-form task or substitute another command

#### Scenario: Retry the same creation request after a facet update
- **WHEN** a command run was accepted, its acknowledgement was lost, the installed facet was updated, and the owner retries the same creation request with the same submitted command and arguments
- **THEN** the system SHALL return the original run with its original bound definitions
- **AND** it SHALL NOT create another run or reinterpret the accepted request using the update
- **AND** reusing that request identity with different command input SHALL produce a conflict rather than change the original run

#### Scenario: Command arguments contain runtime-managed credentials
- **WHEN** submitted command arguments contain runtime-managed provider or tool-service credentials
- **THEN** the system SHALL refuse the input without echoing or durably recording those credentials
- **AND** it SHALL NOT dispatch agent work using that input

#### Scenario: Goal-only runs remain available
- **WHEN** the owner submits a valid free-form goal without selecting a command, whether or not runtime facets are installed
- **THEN** the goal-based journey SHALL remain available with the configured provider, confined native tools, and any selected compatible and authorized facet capabilities
- **AND** installing facets alone SHALL NOT require command selection or grant additional tool access

#### Scenario: A command does not expand agent configuration
- **WHEN** a command requests a skill, delegate, or MCP tool unavailable under its agent's configuration and effective permissions
- **THEN** selecting the command SHALL NOT make that contribution available
- **AND** an explicit unmet prerequisite SHALL refuse command start, while an unsupported or denied tool request during work SHALL receive the applicable refusal

#### Scenario: A portable command supplies task instructions
- **WHEN** the owner starts a run from an available portable command whose runtime metadata is absent, null, or empty
- **THEN** its instructions and submitted text SHALL form the task under the documented command argument rules
- **AND** no runtime prerequisite or restriction SHALL be attributed to the absent block
- **AND** the run SHALL use the root agent's configured capabilities and effective permissions without gaining additional selections or grants

### Requirement: A run keeps its original capability definitions

Every goal or command-started run using facets SHALL retain its resolved shared and per-agent selections, startup skill choices, and the exact command, skill, agent, permission-restriction, and MCP declaration definitions made available to it when accepted. Facet updates, removal, or subsequent configuration changes SHALL NOT replace those selections or definitions during that run, including definitions first used by a delegate or after a human pause or ordinary compatible restart with preserved storage. Retaining a definition SHALL NOT itself grant permission to use it.

Retained definitions SHALL remain subject to runtime compatibility checks and current owner grants. Upgrade guidance SHALL identify configuration and continuation compatibility; incompatible saved runs SHALL NOT be silently reinterpreted as new selections or replacement definitions. Removing a facet from shared or individual selection, or removing a startup designation, SHALL affect newly accepted runs rather than revoke retained availability in an accepted run. Revoking an independent server approval or tool grant SHALL still constrain that run's later dispatch. Selection removal SHALL NOT be presented as permission revocation.

#### Scenario: Update a facet while a run is in progress
- **WHEN** a facet is updated after a run starts and that run later loads a skill or invokes an agent it has not used before
- **THEN** the run SHALL use the definitions originally made available to it
- **AND** a newly accepted run SHALL be able to use the updated installation without changing the older run

#### Scenario: Restart after changing the installed facets
- **WHEN** a run is waiting for an answer, its installed facet is updated or removed, and the runtime restarts with compatible runtime behavior and preserved run storage
- **THEN** answering the question SHALL continue the original run using its retained definitions
- **AND** updating or removing the installation alone SHALL NOT replace its question or require starting the task over

#### Scenario: Required retained definitions are lost
- **WHEN** the system confirms that definitions required to continue a waiting run are missing or unusable in its preserved state
- **THEN** the system SHALL refuse continuation as "continuation unavailable" without accepting the answer or dispatching work
- **AND** it SHALL NOT substitute the currently installed versions or fabricate a result
- **AND** available history SHALL remain inspectable

#### Scenario: A grant is revoked for an existing run
- **WHEN** an owner revocation has taken effect in runtime configuration and an existing run next requests the affected tool
- **THEN** the request SHALL be refused and recorded without dispatching the tool
- **AND** retained definitions SHALL NOT restore the revoked access
- **AND** the refusal SHALL NOT claim to undo any earlier dispatched action

#### Scenario: Agent selections change during a human pause
- **WHEN** a goal run is waiting for an answer and the owner changes shared, individual, or startup selections before an otherwise compatible restart
- **THEN** continuation SHALL use the run's original selections and startup definitions for root and delegated work
- **AND** newly accepted runs SHALL use the changed configuration
- **AND** broader new grants or selections SHALL NOT expand the older run's authority

#### Scenario: Retry a goal start after configuration changes
- **WHEN** a goal run was accepted, its acknowledgement was lost, and the owner retries the same creation request after a configuration or installation change
- **THEN** the system SHALL return the original run with its retained selections and definitions
- **AND** it SHALL NOT accept a replacement run or reinterpret the accepted goal using the new configuration

#### Scenario: An upgrade cannot safely interpret a waiting run
- **WHEN** an upgraded runtime determines that a waiting run's saved selections or definitions are incompatible
- **THEN** it SHALL refuse continuation as "continuation unavailable" before accepting the answer or dispatching work
- **AND** it SHALL preserve the recorded question and history without applying new configuration to reconstruct the run

#### Scenario: A compatible waiting run predates the selection contract
- **WHEN** a run accepted under the superseded configuration is waiting for an answer and the upgraded runtime verifies that its saved state and retained definitions remain compatible
- **THEN** answering SHALL continue that run using its retained definitions and original availability
- **AND** the runtime SHALL NOT reinterpret it using current shared or per-agent selections
- **AND** current owner revocations SHALL continue to constrain dispatch

### Requirement: Run capability provenance remains inspectable

The console SHALL distinguish the capabilities bound to a goal or command-started run from skills actually loaded at startup or on demand, delegates actually invoked, and tools actually called. For each responsible agent, the run SHALL identify its resolved facet selections and the originating facets and versions of used contributions, with the effective permissions under which work was permitted or refused. Startup activation SHALL be distinguishable from on-demand skill loading and SHALL NOT be represented as proof that the model followed the instructions. This provenance SHALL remain inspectable with recorded history after ordinary restart, configuration changes, or removal of installed facets. For facet-backed contributions, retained provenance SHALL also identify whether availability came from shared selection, individual selection, or both, and whether admission was portable or based on explicit runtime behavior.

#### Scenario: Inspect what a run actually used
- **WHEN** a run loads one of several available skills, invokes a named delegate, and calls an MCP tool
- **THEN** the console SHALL identify those contributions and their bound facet versions
- **AND** it SHALL NOT claim that other merely available skills or agents were used
- **AND** the owner SHALL be able to inspect the permissions relevant to the permitted or refused operations

#### Scenario: Inspect history after uninstalling a facet
- **WHEN** the owner reopens a finished run after removing a facet it used and restarting the runtime with preserved storage
- **THEN** its recorded command if any, capability provenance, and outcomes SHALL remain available without reinstalling that facet
- **AND** inspecting them SHALL NOT execute a command, delegate, or tool again

#### Scenario: Distinguish startup loading from mere availability
- **WHEN** an agent has one startup skill and another available skill that it never loads
- **THEN** the console SHALL identify the first skill as startup-loaded for that agent and the second as available but not loaded
- **AND** the report SHALL NOT claim the second skill was used or infer instruction compliance from the first skill's loading alone

#### Scenario: Inspect historical agent selection
- **WHEN** the owner inspects a completed goal run after changing shared or individual facet configuration
- **THEN** the run SHALL show the selections and facet versions retained for its agents rather than substitute current configuration
- **AND** an absent command SHALL NOT hide skill, delegation, or MCP provenance
