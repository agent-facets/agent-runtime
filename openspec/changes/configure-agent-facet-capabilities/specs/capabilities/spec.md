# Capabilities Spec Delta

<!-- split-umbrella-note:start -->
> Historical umbrella delta. Its requirements and scenarios are retained for traceability, not for application alongside the successors.
> Use the [release roadmap](../../../ROADMAP.md) and [scope map](../../scope-map.md) to select the owning change.
> Review notes below are historical. The prompt session catalog and owner selection route are settled; detailed conversation, checkpoint, and owner-inspection contracts remain incomplete.
<!-- split-umbrella-note:end -->

The owner approved design Decision 3. It sets one current record format and an explicit reset of disposable development records. The related corrections do not approve other design decisions.

The owner approved the structural split of the former Decision 4 into Decisions 4 through 10.

The owner approved Decisions 4 through 20, including Contracts 12A through 12D, 13A through 13D, and 15A through 15D. Decision 6 includes the approved tool-origin naming replacement and its change-local follow-ups. Decision 14 includes the approved startup-history replacements and related corrections to Decisions 12 and 13. Decision 18 includes the approved Message-size and monitoring policy and its change-local corrections. Decision 19 includes approved depth awareness, tool exposure, and related prompt corrections.

The owner approved Decision 21's durable sessions, exclusive turns, same-run ownership, and related corrections. The owner approved the revised Decision 22. It simplifies session state and lets only the owner change the selected agent of a session. A selection change applies at the next model request. Every accepted run uses the same capability retention. Decision 22 has no open questions about agent selection.

All 22 decisions are approved. The exact contracts for conversation records, checkpoints, and session discovery still need explicit completion. The session parts of this change are not ready for implementation.

## ADDED Requirements

### Requirement: Facet selection belongs to consuming agents

The owner SHALL configure each agent independently, including its instructions, selected facets, startup skills, and permitted delegation targets. There SHALL be no shared selection scope or separate configuration type for entry agents and delegates. Facet authors SHALL NOT need to name consuming agents or supply a runtime opt-in marker for portable instructions. Installation alone SHALL NOT select a facet for any agent. A selection SHALL NOT fetch missing facets, modify the installation, or grant MCP authority.

An agent's available contributions SHALL be resolved from its own facet selections, the recorded installation's materialization choices, compatibility checks, and applicable execution permissions. Selections and startup skills SHALL NOT be inherited from another agent. Duplicate selections SHALL resolve once. Each facet reference SHALL identify exactly one installed facet. Missing or ambiguous references SHALL cause configuration refusal at startup, identifying the agent, field, reference, and safe cause. An explicit prerequisite SHALL NOT implicitly select an additional facet.

Facet selection SHALL select all installed, materialized contributions of the facet as availability candidates without additional per-agent MCP server, tool, skill, or command allowlists. Installation omissions, compatibility checks, prerequisites, owner grants, resource restrictions, and interaction-mode rules SHALL remain effective. Availability SHALL NOT load all skill bodies at startup or implicitly add task-delegation relationships.

The system SHALL NOT impose a fixed count limit on configured agents or retained agent configurations. Delegation-target lists and the permitted-entry set SHALL NOT have separate fixed count limits. Their references SHALL still identify configured agents. Facet content validation, startup-instruction limits, and identifier rules SHALL remain effective. The common message-size policy SHALL apply to message content, and the retained configurations SHALL have no fixed aggregate size limit. A failure SHALL identify the actual cause rather than report an agent-count failure.

#### Scenario: Select a facet without a second contribution allowlist
- **WHEN** an agent selects an installed facet with supported skills, commands, and MCP tool declarations and applicable checks pass
- **THEN** those contributions SHALL become availability candidates without another per-agent server or contribution list
- **AND** owner tool approval, critical-operation approval, startup activation, and discussion restrictions SHALL still apply independently

#### Scenario: Facet selection does not approve a tool
- **WHEN** a selected facet declares an MCP tool without applicable owner approval
- **THEN** selecting the facet SHALL NOT authorize execution of that tool
- **AND** inspection SHALL distinguish facet selection from the missing approval

#### Scenario: Agent configuration exceeds the previously proposed count bound
- **WHEN** the owner configures more than 32 agents with valid references, and each agent passes the applicable content validation and startup-instruction limits
- **THEN** configuration validation SHALL NOT reject the configuration because of the number of agents
- **AND** valid target lists and permitted-entry sets above 32 SHALL NOT be rejected solely for their counts

#### Scenario: Define an agent directly
- **WHEN** the owner supplies an otherwise valid agent configuration with its own instructions
- **THEN** the system SHALL NOT require that configuration to reference an existing native agent or an installed agent contribution
- **AND** its selected facets and delegation targets SHALL remain subject to their normal validation

#### Scenario: Configure the same facet independently for several agents
- **WHEN** the owner selects the same installed portable skill facet in two agent configurations and no applicable restriction excludes it
- **THEN** each agent SHALL be able to discover and load that skill through its own configuration
- **AND** neither selection SHALL depend on inheritance from the other agent
- **AND** the facet SHALL NOT require knowledge of those agents or an authored runtime block

#### Scenario: Select a facet for one agent only
- **WHEN** a facet is selected for a caller but is absent from its delegate's configuration
- **THEN** the caller SHALL have its compatible contributions available within its permissions
- **AND** the delegate SHALL NOT receive that facet's skills in its skill catalog or be allowed to load them
- **AND** delegation SHALL NOT automatically copy the caller's loaded skills into the delegate's instruction context

#### Scenario: Install without selecting
- **WHEN** a facet is installed but no agent configuration selects it
- **THEN** its contributions SHALL remain inspectable as installed but unselected
- **AND** agents SHALL NOT acquire its skills, delegate targets, or MCP tools merely because it was installed

#### Scenario: An agent repeats a selection
- **WHEN** an agent's configuration repeats a facet or startup skill reference
- **THEN** its effective contributions SHALL be identified unambiguously without duplicate skill listings or duplicate startup instruction insertion
- **AND** inspection SHALL identify the configured agent responsible for the selection

#### Scenario: A configured facet reference cannot be resolved
- **WHEN** startup configuration selects a facet reference that matches no installed facet or more than one installed facet
- **THEN** the system SHALL refuse the configuration before accepting runs, identifying the agent, field, reference, and conflicting facets when applicable
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

### Requirement: Delegation targets belong to each configured agent

Each agent SHALL have an explicit list of permitted delegation targets. Every target SHALL identify a configured agent. An absent or empty list SHALL permit no delegation. These relationships SHALL apply whether the caller is an entry agent or a delegated invocation. Facet selection SHALL NOT implicitly add targets, and a caller SHALL NOT need to copy a target's facet selections into its own configuration. A target list SHALL describe that agent's outgoing relationships, not all relationships available to descendants. Delegation SHALL remain subject to permission checks, target usability, depth limits, and work budgets.

#### Scenario: A configured target has its own capabilities
- **WHEN** a caller delegates to a permitted configured target with different facet selections
- **THEN** the target SHALL use its own retained configuration under applicable execution restrictions
- **AND** the caller SHALL NOT need to select those same facets merely to name the target

#### Scenario: Facet selection does not authorize delegation
- **WHEN** a selected facet contains an agent contribution but the caller has no configured relationship to the requested target
- **THEN** the caller SHALL NOT acquire permission to invoke that target from facet selection alone

#### Scenario: Target checks apply to nested calls
- **WHEN** Coordinator permits Reviewer, Reviewer permits Researcher, and applicable permissions and depth limits permit the chain
- **THEN** Reviewer SHALL be able to invoke Researcher without Coordinator also listing Researcher as its own target
- **AND** Reviewer SHALL NOT invoke a target absent from Reviewer's own target list

#### Scenario: An agent has no delegation targets
- **WHEN** an agent's configured target list is absent or empty
- **THEN** that agent SHALL NOT delegate, even if other agents exist in the installation or configuration

#### Scenario: Entry eligibility and delegation permission are separate
- **WHEN** an agent is permitted as an entry point but a caller has no configured delegation relationship to it
- **THEN** entry eligibility SHALL NOT permit that caller to invoke it
- **AND** an agent absent from the entry set SHALL remain callable through an otherwise permitted delegation relationship

### Requirement: Consuming configuration changes are explicit

The system SHALL accept independent agent configuration and a separate entry policy through owner-managed operator configuration, taking effect on restart. Entry eligibility SHALL remain outside individual agent configurations. A run MAY select an entry agent permitted by that policy but SHALL NOT override the policy or the agent's selections, startup skills, or delegation targets. Agents SHALL NOT change their own configuration or entry eligibility through instructions or tool results.

#### Scenario: Restart applies an owner configuration change
- **WHEN** the owner changes agent facet selections or delegation targets and restarts with valid configuration
- **THEN** newly accepted runs SHALL resolve selections from that configuration
- **AND** existing runs SHALL retain their accepted configurations and relationships subject to current owner revocations and continuation compatibility

#### Scenario: A task attempts to override selection
- **WHEN** a goal, command argument, or agent instruction requests an unselected facet or a change to configured delegation targets
- **THEN** that request SHALL NOT change effective configuration or install the facet
- **AND** the task SHALL remain within the configuration accepted for its run

### Requirement: Superseded flat selections require explicit migration

The superseded `capabilities.allowSkills` and `capabilities.allowAgents` fields SHALL be refused at startup with migration guidance, whether supplied alone or alongside the new configuration. Migration guidance SHALL distinguish facet selection, startup activation, and independent tool grants, and SHALL NOT prescribe broadening access merely to preserve usability.

#### Scenario: Old flat lists need migration
- **WHEN** startup receives configuration containing either superseded flat-list field
- **THEN** startup SHALL refuse that configuration and identify the field and required migration
- **AND** it SHALL NOT reinterpret the list as access for every agent
- **AND** it SHALL NOT rewrite configuration or start agent work as part of migration

#### Scenario: Selection migration preserves independent grants
- **WHEN** the owner migrates selection configuration without changing server approvals, tool grants, or argument restrictions
- **THEN** those approvals, grants, and restrictions SHALL remain unchanged
- **AND** migration SHALL NOT implicitly approve a server, grant a tool, or relax an argument restriction
- **AND** guidance SHALL identify any additional contributions a proposed facet selection would expose rather than describe that expansion as an equivalent migration

### Requirement: Startup skill activation is explicitly configured

The owner SHALL be able to designate a selected skill for startup loading for an agent. Its full instructions SHALL be supplied before that actor's first model request and SHALL remain available during compatible continuation from the run's retained definitions. Startup loading SHALL NOT itself dispatch a model request, consume a model step, grant authority, or execute skill scripts. The system SHALL enforce documented finite startup-instruction limits. Unavailable, incompatible, disallowed, or over-limit startup selections SHALL refuse the affected entry start or delegate invocation before its first model request, identifying the agent and affected skills rather than silently omitting or truncating instructions. A safely reported delegate-startup refusal SHALL return to the caller without by itself failing the containing run.

Startup activation SHALL occur for a new session's first turn. Later turns SHALL retain that session's skill history and originating-turn provenance without another startup activation or duplicate body insertion. An owner agent selection change is the only exception. After that change, the next model request preparation SHALL supply each startup skill of the selected configuration that the session history does not contain with the same retained definition digest. Each turn SHALL apply its own mode, depth, permission, and reference-eligibility checks.

#### Scenario: Load a skill before an agent begins
- **WHEN** an agent starts with a valid selected startup skill
- **THEN** its first model request SHALL contain that installed skill's full instructions
- **AND** the run SHALL record the responsible agent, skill identity, facet version, and startup activation
- **AND** the loading operation itself SHALL consume no model step

#### Scenario: Startup skills appear within new-session history
- **WHEN** a new session starts its first turn with several configured startup skills
- **THEN** its creation activity SHALL show the complete startup list before its first model request
- **AND** inspection SHALL identify each retained skill, definition digest, facet origin, and installed version
- **AND** the runtime SHALL NOT add separate per-skill startup activities or synthetic tool calls

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

#### Scenario: Independently configured startup activation is attributed separately
- **WHEN** the owner configures the same selected skill for startup in two agent configurations and one invokes the other
- **THEN** each actor SHALL receive that skill before its own first model request
- **AND** each startup activation SHALL identify its configured agent and distinct actor

#### Scenario: A selection change supplies only missing startup skills
- **WHEN** the owner selects an agent configuration with startup skills A and B for a session whose history contains A with the same retained definition digest
- **THEN** the next model request of that session SHALL contain the full instructions of B
- **AND** the runtime SHALL NOT insert a second copy of A
- **AND** history SHALL attribute the supply of B to its turn and to the selection change
- **AND** the runtime SHALL NOT record the supply as a tool call

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

### Requirement: Read-only discussion is distinct from task delegation

An agent configuration SHALL be a template. A session SHALL be a durable conversation with a unique session ID, an owning run, a selected agent configuration, an ordered conversation, and an execution state of idle or active. The selected agent configuration SHALL be one of the configurations retained for the owning run. A turn SHALL be one request to a session. Each turn SHALL record its caller actor, caller operation, run, depth, mode, budget use, and execution state. Several sessions MAY use the same agent configuration. When a turn finishes, its session SHALL remain durable and available for a later turn.

A configured agent MAY discuss with a target without a task-delegation relationship or membership in the permitted-entry set. The target SHALL be one of two kinds: a new session of a retained agent configuration, or an exact existing session that the current run owns and the caller can access. A new-session target MAY name the agent configuration of the caller. The runtime SHALL NOT substitute a new session or a different session for an existing-session target. A session SHALL NOT be a target from another workspace. Owner access restrictions and run-wide resource controls SHALL still apply.

Each session SHALL belong to exactly one run, which is the run that created it. The owning run of a session SHALL NOT change. An agent SHALL discover and address only sessions that the current run owns. A shared workspace SHALL NOT give a run access to the sessions of another run. Each new run SHALL use new agent sessions. It SHALL NOT target, resume, or automatically import the sessions of an earlier run.

Within one run, permitted callers MAY reuse an idle session. Each turn of the session SHALL use the budget, workspace, retained definitions, and execution controls of that run.

When a run becomes terminal, its sessions SHALL NOT accept new turns. The runtime SHALL NOT present this as proof that uncertain external effects stopped. The end of a run SHALL NOT itself delete session history. Retention of history SHALL remain separate from addressability. Authorized owner inspection MAY examine that history without making the old session a target for agent invocation. This change SHALL NOT add automatic deletion or promise indefinite retention.

This change SHALL NOT implement or grant access to session history across runs. A new run SHALL NOT automatically receive old session history in its model context or in its agent-visible session catalog. Memory extraction, learnings, and dreaming from retained history need a separately approved design. Background compaction and long-term memory remain outside this change.

An agent that can request discussion SHALL be able to discover the sessions that its current run owns, including in a shared workspace. Discovery SHALL show the session ID, the selected agent configuration, and the busy status of each session. Discovery SHALL NOT expose full transcripts or hidden reasoning.

Discovery SHALL use the existing session records, not a separate session registry. The runtime SHALL get the current run and the access of the caller from trusted execution context, not from model input. A discovery result SHALL NOT grant access to a session. Each later invocation SHALL check ownership, access, and busy status again.

Discussion permission SHALL NOT grant additional data access or tools. Each discussion turn SHALL use discussion mode, even when the session history contains earlier task-mode turns. The runtime SHALL NOT deliver a discussion as executable task instructions to an unrestricted actor.

In discussion mode, an agent MAY read authorized information, analyze it, and return advice. It SHALL NOT use mutating tools, delegate tasks, change its mode or permissions, or cause another actor to perform a prohibited operation on its behalf. Further discussions caused by that turn SHALL preserve this restriction. Messages SHALL NOT promote a discussion into task assignment. This change SHALL provide no conductor, manager, or privileged-agent exception.

The first version SHALL use a synchronous, exclusive discussion call and return advice through its parent result. It SHALL NOT add a live message bus or unsolicited messages to an existing caller. This change SHALL NOT start consultations in the background, queue requests for busy sessions, steer an active session, or automatically compact session history. An owner agent selection change for an active session SHALL NOT be a message, a queued request, or a steering instruction to the active turn. A consultation that needs clarification SHALL return that need in its advice rather than invoke the owner-question tool. Ordinary task-mode callers and delegates SHALL retain existing owner-question behavior.

#### Scenario: Consult without a task relationship
- **WHEN** Reviewer asks a new Publisher session for advice without a configured task-delegation relationship and applicable access and resource checks pass
- **THEN** the Publisher session SHALL receive the request in a discussion turn and MAY return advice from authorized information
- **AND** Publisher SHALL NOT publish or delegate publication in response
- **AND** the consultation SHALL NOT add Publisher to Reviewer's task-delegation targets

#### Scenario: A discussion request contains an action instruction
- **WHEN** a discussion asks its recipient to post a comment, modify code, publish, or delegate such work
- **THEN** the runtime SHALL keep the receiving invocation in discussion mode
- **AND** the prohibited operation SHALL NOT dispatch even if the agent's normal role permits it

#### Scenario: Further consultation preserves the restriction
- **WHEN** an agent in discussion mode causes a further permitted discussion
- **THEN** the next receiving invocation SHALL also remain in discussion mode
- **AND** the chain SHALL NOT grant mutation or task-delegation rights

#### Scenario: A privileged role cannot escape discussion mode
- **WHEN** an agent with broad normal permissions receives a discussion request
- **THEN** the same discussion restrictions SHALL apply without a conductor or manager exception

#### Scenario: Discussion does not grant information access
- **WHEN** a consultation requests information outside applicable owner access restrictions
- **THEN** discussion eligibility SHALL NOT authorize the read or disclosure

#### Scenario: Consultation returns a need for clarification
- **WHEN** a discussion turn needs information that its topic and authorized reads do not supply
- **THEN** it SHALL return that need to its caller as advice
- **AND** it SHALL NOT ask the owner directly or interrupt an existing caller actor with an unsolicited message

#### Scenario: Consult a new session of the caller's own configuration
- **WHEN** Reviewer requests a new session of the Reviewer configuration and applicable access and resource checks pass
- **THEN** the runtime SHALL create a distinct Reviewer session for a discussion turn
- **AND** it SHALL NOT refuse the request because the target uses the same agent configuration as the caller

#### Scenario: Several sessions use one configuration
- **WHEN** a caller requests a new session of the Researcher configuration in 2 sequential operations
- **THEN** the runtime SHALL create 2 sessions with different session IDs
- **AND** each session SHALL keep its own history

#### Scenario: An existing-session target is not replaced
- **WHEN** a caller names an existing session that is busy, unavailable, or not accessible to the caller
- **THEN** the runtime SHALL refuse the call
- **AND** it SHALL NOT start a turn in a new session or in a different session

#### Scenario: Discover sessions without transcripts
- **WHEN** an agent requests the sessions that it can access
- **THEN** the result SHALL identify the session ID, selected agent configuration, and busy status of each session that the current run owns
- **AND** it SHALL NOT contain a full transcript or hidden reasoning
- **AND** it SHALL NOT list a session that another run owns, even when that run uses the same workspace

#### Scenario: Discovery does not authorize a later call
- **WHEN** an agent discovers an idle session and that session becomes busy before the agent names it in a discussion call
- **THEN** the runtime SHALL refuse the call as busy
- **AND** the earlier discovery result SHALL NOT authorize a turn in that session

#### Scenario: Model output cannot widen discovery
- **WHEN** model output names another run or another workspace for session discovery
- **THEN** the runtime SHALL NOT list the sessions of that run or workspace
- **AND** the result SHALL contain only sessions that the current run of the caller owns and that the caller can access

#### Scenario: Reuse an idle session within the run
- **WHEN** a caller in a run names an idle session that the same run created and applicable checks pass
- **THEN** the runtime SHALL start a new turn in that session
- **AND** the turn SHALL use the budget, workspace, retained definitions, and execution controls of that run

#### Scenario: A later run cannot address an earlier session
- **WHEN** a caller in a new run names a session that an earlier run created in the same workspace
- **THEN** the runtime SHALL refuse the call as unavailable
- **AND** it SHALL NOT resume the session, start a turn in it, or import its history into the new run

#### Scenario: A terminal run accepts no new turns
- **WHEN** a run becomes terminal while one of its sessions is idle
- **THEN** the runtime SHALL NOT start a new turn in that session
- **AND** the session history SHALL remain available to authorized owner inspection
- **AND** the terminal state SHALL NOT be shown as proof that uncertain external effects stopped

#### Scenario: Owner inspection does not make a session addressable
- **WHEN** the authorized owner inspects the history of a session from a finished run
- **THEN** the inspection SHALL NOT make that session a discussion target or add it to the session catalog of any run

#### Scenario: A discussion turn is read-only after earlier task work
- **WHEN** a caller consults an accessible idle session whose history contains task-mode turns
- **THEN** the new turn SHALL use discussion mode
- **AND** mutating tools and task delegation SHALL be refused before dispatch

#### Scenario: A session in another workspace is not a target
- **WHEN** a caller names a session that belongs to a different workspace
- **THEN** the runtime SHALL refuse the call as unavailable
- **AND** it SHALL NOT disclose the content or status of that session

### Requirement: Only the owner selects the agent of a session

The owner SHALL be able to change the selected agent configuration of a session. Only the owner SHALL make this change. Agent tools, discussion messages, delegated instructions, and model output SHALL NOT authorize it. The owner SHALL select only an agent configuration retained for the owning run of the session. A selection change SHALL NOT read the current deployment configuration or create an agent configuration.

A selection change SHALL keep the session ID, owning run, conversation history, workspace, provider binding, and model-step budget of the session. It SHALL keep the mode and depth of the current turn. It SHALL NOT change the provider or the model. A discussion turn SHALL remain read-only after a selection change.

Each selection change SHALL be inspectable. It SHALL use the existing owner rules for idempotent changes. An equal retry SHALL return the original result. A retry of an earlier change SHALL NOT replace a later selection.

Permission declarations, owner grants, and restrictions SHALL still apply after a selection change. A selection change SHALL NOT bypass them. It SHALL NOT let an agent manage its facets at runtime.

#### Scenario: The owner selects another retained agent for an idle session
- **WHEN** the owner selects the retained Reviewer configuration for an idle session that uses the Researcher configuration
- **THEN** the next turn of that session SHALL use the Reviewer configuration
- **AND** the session ID, owning run, conversation history, workspace, provider binding, and model-step budget SHALL NOT change

#### Scenario: An agent cannot change the selection
- **WHEN** a model response, a discussion topic, or a delegated task asks for a change to the selected agent of a session
- **THEN** the selected agent configuration of that session SHALL NOT change
- **AND** no agent tool SHALL make that change

#### Scenario: Selection is limited to retained configurations
- **WHEN** the owner requests an agent configuration that the current deployment contains but the run does not retain
- **THEN** the runtime SHALL refuse the selection change
- **AND** it SHALL NOT add that configuration to the retained configurations of the run

#### Scenario: A retry of an earlier change does not replace a later selection
- **WHEN** the owner changes a session from A to B, then from B to C, and then retries the first change with its original submission identity
- **THEN** the runtime SHALL return the original result of the first change
- **AND** the selected agent configuration of the session SHALL remain C

#### Scenario: A selection change does not widen authority
- **WHEN** the owner selects an agent configuration whose role permits a tool that an owner restriction denies for the run
- **THEN** the runtime SHALL refuse a call to that tool before dispatch
- **AND** the selection change SHALL NOT grant the tool

#### Scenario: A discussion turn stays read-only after a selection change
- **WHEN** the owner selects an agent configuration with mutating tools for a session during a discussion turn
- **THEN** that turn SHALL remain in discussion mode
- **AND** mutating tools and task delegation SHALL remain unavailable to that turn

### Requirement: Effective capabilities follow the selected agent configuration

The effective capabilities of a model request SHALL come from the selected retained agent configuration, the mode of the turn, applicable restrictions, and current owner grants. Instruction content in the session history SHALL remain history. That content SHALL NOT grant access to a skill, a skill reference, a tool, or a delegation target.

At the next model request preparation after a selection change, the runtime SHALL make the instructions, skill catalog, startup skills, and offered tools agree with the selected configuration. The runtime SHALL supply only configured startup skills automatically. It SHALL NOT load all skill bodies of the selected facets. It SHALL NOT insert a skill body again when the session history contains it with the same retained definition digest. Each startup supply SHALL identify its originating turn and the selection change that caused it. The runtime SHALL NOT add synthetic tool calls to supply instructions.

Each model request SHALL record the agent configuration and the tool definitions that it used. A selection change SHALL NOT change the recorded binding or definition digests of an earlier request.

#### Scenario: An earlier skill does not authorize a later reference read
- **WHEN** a session loaded skill S under agent configuration A and the owner then selects configuration B, which does not select S
- **THEN** the instructions of S SHALL remain in the session history
- **AND** a request to read a bundled reference of S SHALL be refused
- **AND** a request to load S SHALL be refused

#### Scenario: Offered tools follow the selected configuration
- **WHEN** the owner selects configuration B, whose facets supply a tool that configuration A does not supply
- **THEN** the next prepared request MAY offer that tool, subject to mode, classification, grants, and restrictions
- **AND** that request SHALL NOT offer a facet tool that only configuration A supplies

#### Scenario: Selected skills are not all preloaded
- **WHEN** the owner selects a configuration whose facets supply several skills and only one of them is a startup skill
- **THEN** the next prepared request SHALL contain the full instructions of only that startup skill
- **AND** the other skills SHALL remain discoverable by name and description until an explicit load

#### Scenario: Earlier request bindings do not change
- **WHEN** the owner inspects a model request that the runtime prepared with configuration A before the owner selected configuration B
- **THEN** inspection SHALL show configuration A and the tool definitions of that request
- **AND** the recorded definition digests of that request SHALL NOT change

### Requirement: Discussion nesting uses the existing invocation-depth bound

Task delegation and discussion SHALL share the run's configured maximum nested depth. The entry actor SHALL have depth 0. Every new task child and every discussion turn SHALL have the current depth of its caller plus 1. The existing default of 2 and non-negative safe-integer validation SHALL apply, with no extra policy maximum. A maximum of 0 SHALL prohibit both task and discussion children. The runtime SHALL check the bound before it increments depth and SHALL NOT accept a model-supplied depth override.

Each turn SHALL keep one depth for all of its requests. A session SHALL NOT keep a permanent depth from its creation, and a later turn of the same session MAY have a different depth. A discussion turn MAY make a further permitted discussion but SHALL NOT delegate a task. Every discussion turn caused by a discussion turn SHALL use discussion mode. Return to a caller SHALL NOT add depth, and later sibling calls SHALL use that caller's depth again.

A new-session target that names the agent configuration of an ancestor SHALL create a new session rather than resume the session of the ancestor, and it SHALL consume a depth level. A request for any session in the active waiting chain of the caller SHALL be refused as busy. There SHALL be no additional discussion-depth setting or total discussion-call limit.

#### Scenario: A mixed path reaches the common depth bound
- **WHEN** a run with maximum depth 2 starts a task delegate at depth 1 and that delegate starts a discussion
- **THEN** the discussion SHALL have depth 2 and remain read-only
- **AND** any further child request SHALL be refused before that child starts

#### Scenario: Returning permits another sibling consultation
- **WHEN** a discussion returns and its caller requests another permitted consultation within the remaining budget
- **THEN** the new consultation SHALL use the caller's depth plus 1
- **AND** completed sibling consultations SHALL NOT accumulate nesting depth

#### Scenario: Naming an ancestor's configuration does not restore its authority
- **WHEN** a discussion turn requests a new session of an ancestor's agent configuration and the common depth bound permits it
- **THEN** the runtime SHALL create a distinct session with a read-only turn at the caller's depth plus 1
- **AND** it SHALL NOT address the ancestor's session, task tools, or another workspace

#### Scenario: A session in the waiting chain is busy
- **WHEN** a discussion turn names the session of its caller or of another ancestor that waits for a child
- **THEN** the runtime SHALL refuse the call as busy
- **AND** it SHALL NOT start a turn in that session or in a substitute session

#### Scenario: A reused session gets the depth of its new caller
- **WHEN** a session had a turn at depth 2 and a later caller at depth 0 in the same run consults it
- **THEN** the later turn SHALL have depth 1
- **AND** the depth of the earlier turn SHALL NOT limit the later turn

### Requirement: Agents know their remaining nesting capacity

The system prompt of each task actor and each discussion turn SHALL state its mode, current depth, retained maximum depth, remaining child levels, and child interactions permitted by mode and depth. Remaining child levels SHALL equal maximum depth minus current depth. The runtime SHALL derive these values from retained run, actor, and turn records, not model input.

The prompt SHALL explain that each new delegation or discussion adds one level. A return to an existing caller SHALL NOT add depth. Later sibling calls SHALL use the caller's depth plus one again. The prompt SHALL distinguish nesting capacity from a total call allowance. It SHALL NOT imply that a return resets the shared model-step budget.

A task actor below the maximum SHALL receive instructions that make delegation and discussion subject to permitted targets and dispatch checks. A discussion turn below the maximum SHALL receive instructions that permit further discussion subject to those checks but prohibit task delegation. At the maximum depth, the prompt SHALL state that neither child interaction is available. The caller SHALL know that a child created at the maximum cannot create another child.

#### Scenario: No child capacity at depth zero
- **WHEN** an entry actor starts at depth 0 with a retained maximum of 0
- **THEN** its system prompt SHALL show zero remaining child levels
- **AND** it SHALL state that task delegation and discussion are unavailable

#### Scenario: A task actor can plan one further level
- **WHEN** a task actor starts at depth 1 with a retained maximum of 2
- **THEN** its system prompt SHALL show one remaining child level
- **AND** it SHALL explain that permitted delegation or discussion creates a depth-2 child that cannot create another child
- **AND** target, permission, budget, and workspace checks SHALL remain applicable

#### Scenario: Discussion capacity does not permit task delegation
- **WHEN** a discussion turn starts at depth 1 with a retained maximum of 2
- **THEN** its system prompt SHALL describe one remaining discussion level
- **AND** it SHALL explicitly prohibit task delegation

### Requirement: Offered child tools respect depth and mode

At the maximum depth, the runtime SHALL omit `tool__Delegate` and `tool__Discuss` from the tools offered to the model. Discussion mode SHALL omit `tool__Delegate` at every depth. Remaining depth alone SHALL NOT permit tool exposure; applicable target, mode, and permission checks SHALL also pass.

This filtering SHALL NOT remove unrelated eligible tools or discard retained agent definitions. Dispatch SHALL independently enforce depth, mode, target, permission, budget, and workspace-gate checks. Prompt text and tool exposure SHALL NOT replace those checks.

#### Scenario: Both modes omit child tools at the maximum
- **WHEN** a task actor or discussion turn reaches depth 2 under a retained maximum of 2
- **THEN** neither child-interaction tool SHALL be offered to its model
- **AND** unrelated eligible tools and retained target definitions SHALL remain

#### Scenario: The model requests an omitted child tool
- **WHEN** a model requests delegation or discussion that its depth or mode prohibits
- **THEN** dispatch SHALL refuse the call before child creation
- **AND** the request SHALL NOT override the retained depth or mode

### Requirement: Discussion tool use follows explicit tool policy

Every executable tool SHALL have an explicit read-only or mutating classification and an explicit critical designation supplied by runtime definitions or owner-controlled configuration. A tool without the required declarations SHALL NOT be executable. Discussion mode SHALL permit only read-only tools independently authorized for that invocation. Critical read-only tools SHALL also require approval. Model output, names, descriptions, HTTP methods, and external tool claims SHALL NOT override explicit policy. This version SHALL NOT use an automatic policy classifier.

Agent instructions SHALL explain the active mode. The runtime SHALL enforce it before dispatch regardless of model compliance. The restriction concerns task-resource mutations; runtime history, checkpoint, and budget records MAY still be written for execution and audit.

The native `tool__Discuss` control tool SHALL have fixed runtime-owned `effect: "read"` and `critical: false`. Its policy SHALL be inspectable but not editable through owner classification controls. This narrow control-tool exception SHALL NOT approve its child operations. Leaf native and MCP tools SHALL retain their independent owner-managed policy, and critical reads SHALL still need their own approval. A consultation SHALL NOT expose task delegation, mutating tools, or `tool__AskUser`.

#### Scenario: Authorized read-only tool use during discussion
- **WHEN** an invocation in discussion mode requests an independently authorized tool classified as read-only
- **THEN** the tool MAY execute within its existing resource and argument restrictions
- **AND** the runtime MAY record the operation and account for its execution

#### Scenario: A mutating tool is requested during discussion
- **WHEN** an invocation in discussion mode requests a mutating tool that its normal role can use
- **THEN** the runtime SHALL reject the call before dispatch
- **AND** a model claim that the call is harmless SHALL NOT override the mode

#### Scenario: Tool effects are not trusted or classified
- **WHEN** a discussion invocation requests a tool without a trusted read-only classification
- **THEN** the tool SHALL be unavailable in discussion mode
- **AND** its name, HTTP method, description, or server-supplied claim alone SHALL NOT permit execution

### Requirement: Tool permissions and sandbox constraints remain separate

Each agent's facet-provided tool candidates SHALL come from its selected facets without a second per-agent selection list. Read/write classification and critical designation SHALL describe tool execution policy rather than additional per-agent capability selection. Existing server approvals, definition digests, argument restrictions, owner grants, credential protections, and supported authored restrictions SHALL remain enforced. The confined native-tool set SHALL retain its existing policy. Tool permission SHALL NOT authorize sandbox escape or access outside the operation's permitted resource scope.

Authorized task execution MAY read, edit, and perform permitted tests within an enforced workspace-owned Docker sandbox. Subprocesses SHALL NOT bypass its constraints. Remote tools SHALL remain subject to their own resource permissions; local filesystem confinement SHALL NOT establish confinement of a remote service. This change SHALL NOT authorize arbitrary shell execution. Docker SHALL be the only initial backend. Unsupported security or resource settings SHALL cause rejection rather than silent omission.

#### Scenario: Non-critical sandboxed work does not require approval for every write
- **WHEN** a permitted non-critical tool edits a sandboxed working copy or performs permitted tests in task mode
- **THEN** it MAY execute without critical-operation approval
- **AND** ordinary permission, resource, sandbox, mode, budget, and workspace-gate checks SHALL still apply

#### Scenario: A sandbox does not grant tool permission
- **WHEN** an agent lacks permission to modify code but has access to an otherwise writable sandbox
- **THEN** the sandbox SHALL NOT authorize code edits for that agent

#### Scenario: A subprocess attempts to escape the sandbox
- **WHEN** a permitted tool starts a subprocess that attempts access outside its allowed sandbox resources
- **THEN** the sandbox SHALL enforce the same constraints on the subprocess
- **AND** tool permission or critical approval SHALL NOT authorize escape

#### Scenario: A remote tool needs independent resource permission
- **WHEN** a tool requests a remote operation outside its permitted resource scope
- **THEN** the runtime SHALL reject it regardless of local process confinement or critical designation
- **AND** human approval SHALL NOT grant access outside that scope

### Requirement: Tool names identify their selected origin

Model tool definitions and console labels SHALL use `tool__<name>` for native tools and `facet__<server>__<name>` for facet tools through MCP. These prefixes are literal strings. The server component SHALL identify the effective server ID. The name component SHALL identify the tool within that server or the native runtime.

The runtime SHALL retain each structured tool identity separately from its exposed name. It SHALL NOT reconstruct identity from a name split at `__`. A prefix SHALL NOT grant permission or establish a tool's effect. Agent capability selection SHALL remain facet-based, without additional per-agent tool lists.

#### Scenario: Native tool names agree across interfaces
- **WHEN** the runtime exposes the native tool named `Read`
- **THEN** the model tool definition and console label SHALL use `tool__Read`
- **AND** that name SHALL reference the retained native identity

#### Scenario: A facet tool uses its origin prefix despite MCP transport
- **WHEN** a selected facet supplies tool `search` through effective MCP server `docs`
- **THEN** the model tool definition and console label SHALL use `facet__docs__search`
- **AND** its identity SHALL retain the selected facet, installed version, server ID, and tool name
- **AND** the prefix SHALL NOT bypass classification, grants, or argument restrictions

### Requirement: Ambiguous tool names prevent tool exposure

After installation resolves aliases and alternative origins, each effective server ID SHALL identify one selected server within the installation. Each exposed tool name SHALL reference exactly one retained identity. The runtime SHALL reject ambiguous server IDs and exposed names before it offers tools to a model. It SHALL NOT resolve conflicts by iteration order, truncation, or selection of another origin.

#### Scenario: Distinct selected servers have the same effective ID
- **WHEN** two distinct selected servers retain the same effective ID after installation resolves aliases and alternative origins
- **THEN** the runtime SHALL reject the ambiguous server ID before it offers tools
- **AND** it SHALL NOT select one server by iteration order

#### Scenario: Separators in components cause a name conflict
- **WHEN** server `a__b` with tool `c` and server `a` with tool `b__c` produce the same exposed name
- **THEN** the runtime SHALL reject that conflict before it offers tools
- **AND** it SHALL NOT merge identities or classifications

### Requirement: Standalone MCP names remain reserved without execution support

The runtime SHALL reserve `mcp__<server>__<name>` for MCP servers configured outside facets. This change SHALL NOT add configuration, agent access, discovery, or execution support for those servers. The runtime SHALL NOT treat an unknown tool name as permission to connect to a server.

#### Scenario: A model requests a standalone MCP tool
- **WHEN** a model requests `mcp__docs__search` without a retained supported tool binding
- **THEN** the runtime SHALL refuse the call
- **AND** it SHALL NOT discover, connect to, or execute a standalone MCP server because of that name

### Requirement: Critical operations require explicit human approval

Every tool SHALL have explicit effect and critical-policy declarations from runtime definitions or owner-controlled configuration. Missing required declarations SHALL prevent execution. Model output SHALL NOT change them. Critical status SHALL be separate from read/write classification and SHALL be configured explicitly, not inferred by an automatic classifier.

The runtime SHALL register tool definitions for owner inspection and classification after installation, authorized discovery, or native registration supplies them. Classification SHALL record `effect: "read" | "write"` and `critical: boolean`. A facet tool identity SHALL retain its kind, selected facet, installed version, effective server ID, and tool name. A native identity SHALL retain its kind and native tool name. Exposed names SHALL NOT replace these identity components.

Each classification SHALL identify the reviewed tool-definition digest. A changed definition SHALL require renewed classification before execution. Classification SHALL NOT approve an MCP server, grant access, or relax resource and argument restrictions. Discovery SHALL retain its existing approval requirements. Owner-managed classification records SHALL use the existing PostgreSQL application database's `runtime` schema, without a separate database or datastore.

The browser console SHALL provide an owner-only Tool classifications page under Configuration. It SHALL list registered native and MCP tools with tool name, selected origin, applicable facet version, and classification status. The owner SHALL be able to inspect the definition, select Read or Write, set critical status, and explicitly save. Save SHALL bind the values to the displayed definition digest and persist them in PostgreSQL. A definition change before saving SHALL cause rejection and require review of the current definition. The page SHALL clearly identify unclassified tools and changed definitions needing renewed classification.

For the runtime-owned `tool__Discuss` declaration, the page SHALL show fixed read-only, non-critical values without edit controls. Other owner-editable native and MCP tool classifications SHALL keep the normal save flow.

Classification changes SHALL NOT autosave. Opening the page SHALL NOT classify or execute tools or silently start MCP discovery. The page SHALL NOT change agent facet selections, approve MCP servers, or grant tool access. The implementation SHALL use the existing console design system; a raw JSON editor and separate classification CLI are outside this change.

For a deduplicated MCP tool, the harness SHALL honor the explicit origin selected during installation and preserve its facet identity and installed version. It SHALL look up the classification through that origin, server, tool name, and reviewed definition digest. Runtime discovery and model output SHALL NOT choose or replace the origin. Other origin classifications SHALL NOT be merged or required to agree. Missing origin references or matching classifications SHALL leave the tool unavailable without fallback to another origin's policy.

The runtime SHALL require human approval before any operation designated critical executes. Approval SHALL identify the workspace, operation, target, and exact arguments or change. Changed scope SHALL require new approval. Each request SHALL require its own decision; approval SHALL NOT authorize unrelated operations or resolve other pending requests. The gate SHALL apply to every exposed route, including wrappers and remote tools, and hold new agent work across the shared workspace. Owner controls and runtime bookkeeping SHALL remain available. Decisions, execution outcomes, and owner assertions about uncertain effects SHALL remain separate inspectable facts.

Discussion mode SHALL remain read-only and prohibit task delegation and mode escape. A writable sandbox or critical-operation approval SHALL NOT override that lock. No conductor or privileged-agent exception is included.

#### Scenario: Inspect and classify a newly available tool
- **WHEN** a tool definition becomes available through installation, authorized discovery, or native registration
- **THEN** the owner SHALL be able to inspect its definition and assign its effect and critical designation when that policy is owner-editable
- **AND** execution SHALL remain unavailable until the required classification exists

#### Scenario: Save a reviewed classification through the console
- **WHEN** the authenticated owner inspects a registered tool on the Configuration page and explicitly saves its effect and critical status
- **THEN** the classification SHALL be persisted in the PostgreSQL runtime schema for the displayed tool-definition digest
- **AND** agent facet selections, independent server approvals, and tool grants SHALL remain unchanged

#### Scenario: A definition changes before classification is saved
- **WHEN** the tool definition no longer matches the digest displayed for the owner's classification edit
- **THEN** the runtime SHALL reject the stale save and require review of the current definition
- **AND** it SHALL NOT apply the old review to the changed definition

#### Scenario: Viewing classifications has no tool side effects
- **WHEN** the owner opens the Tool classifications page or changes unsaved form values
- **THEN** the runtime SHALL NOT save a classification, execute a tool, or start MCP discovery as a consequence
- **AND** unclassified and changed-definition states SHALL remain clearly identified

#### Scenario: Classification access is owner-only
- **WHEN** a request lacks owner authorization for classification inspection or mutation
- **THEN** the runtime SHALL deny that access rather than rely only on hiding the console page

#### Scenario: Installation selects the authoritative origin
- **WHEN** installation explicitly selects Facet B as the origin of a deduplicated MCP tool that also has a reference from Facet A
- **THEN** the harness SHALL use the matching classification for Facet B's selected origin and reviewed definition
- **AND** a different classification for Facet A SHALL neither override nor block the selected classification
- **AND** the model and runtime discovery SHALL NOT choose another origin

#### Scenario: The selected origin lacks a matching classification
- **WHEN** the selected-origin reference is missing or its classification does not match the reviewed tool-definition digest
- **THEN** the tool SHALL remain unavailable
- **AND** the runtime SHALL NOT substitute another origin's classification

#### Scenario: Exposed names do not replace tool identities
- **WHEN** a tool name contains `__` or resembles another tool's label
- **THEN** the runtime SHALL retain the separate identity components
- **AND** the label SHALL NOT cause one tool to receive another tool's classification

#### Scenario: A tool definition changes after classification
- **WHEN** a tool retains its stable identity but has a different definition digest
- **THEN** the runtime SHALL require classification of the changed definition before executing it
- **AND** the earlier classification SHALL remain associated with the definition that the owner reviewed

#### Scenario: Classification does not approve discovery or tool use
- **WHEN** the owner classifies a tool without the server or tool having the required independent approvals
- **THEN** classification alone SHALL NOT authorize server discovery, connection, or tool execution
- **AND** existing definition checks and argument restrictions SHALL remain effective

#### Scenario: A critical push waits for approval
- **WHEN** a permitted GitHub push is explicitly designated critical
- **THEN** the runtime SHALL obtain human approval of the exact target and arguments or change before execution
- **AND** approval SHALL NOT authorize another target or later changes

#### Scenario: Critical and mutating classifications are independent
- **WHEN** a permitted sandboxed edit is designated non-critical and a permitted push is designated critical
- **THEN** the edit MAY execute under ordinary checks while the push SHALL require human approval
- **AND** both SHALL still be unavailable in discussion mode because they mutate resources

#### Scenario: A critical request changes after approval
- **WHEN** the operation, target, arguments, or approved change differs from the human-approved request
- **THEN** the runtime SHALL require new approval before executing that request

#### Scenario: A wrapper cannot bypass a critical gate
- **WHEN** an exposed wrapper or remote tool provides another route to a designated critical operation
- **THEN** that route SHALL enforce the same approval requirement before the effect occurs

#### Scenario: Missing policy declarations prevent execution
- **WHEN** a requested tool lacks its required effect or critical declaration
- **THEN** the runtime SHALL refuse execution rather than assume the tool is non-critical

#### Scenario: Discussion cannot use approval to gain write authority
- **WHEN** a discussion invocation requests a mutation or task delegation despite sandbox write access or critical-operation approval
- **THEN** the runtime SHALL reject that request under the discussion lock

### Requirement: Classification and execution policies use immutable revisions

Tool classifications and execution policies SHALL each use one current format. The runtime SHALL NOT select an earlier interpretation from a record's schema-version field. An immutable revision ID SHALL identify one saved policy, not a record format. An edit SHALL create a new revision rather than overwrite one retained by a run or approval request.

Classification revisions SHALL bind the tool identity, reviewed definition digest, effect, and critical designation. Each run or invocation SHALL identify its exact execution-policy revision.

Execution policies SHALL use supported sandbox mechanisms with validated settings. Docker SHALL be the only initial variant. The runtime SHALL reject malformed policy records, unsupported variants, and unsupported restrictions. A refusal SHALL NOT grant unrestricted access. Policy configuration SHALL NOT claim controls that its backend cannot enforce.

A workspace SHALL own its authoritative policy revision. Invocations SHALL use their run's workspace under that policy. New work SHALL NOT widen policy or change it beneath active execution. Image, user, memory, CPU, process, temporary-storage, mount, and network settings SHALL have strict validation rules.

These records SHALL use the existing PostgreSQL `runtime` schema. Producer provenance SHALL identify an authorized producer independently of record contents. An unknown producer SHALL NOT acquire authority through a free-form field. A future classifier proposal SHALL NOT automatically authorize a policy change or approve a critical operation. Jev integration and automatic classification remain outside this change.

#### Scenario: Editing a classification preserves accepted work
- **WHEN** the owner explicitly saves a new classification for a tool whose earlier revision is retained by a run or approval request
- **THEN** the system SHALL create a new revision and keep the earlier revision intact
- **AND** existing bindings SHALL NOT silently change to the new revision

#### Scenario: A policy record identifies its revision without a schema version
- **WHEN** the owner saves a classification or execution policy
- **THEN** the saved record SHALL have an immutable revision ID and match the current strict schema for its record type
- **AND** the record SHALL NOT contain a numeric format, profile, or schema version field

#### Scenario: A policy record contains a schema version field
- **WHEN** the runtime reads a classification or execution-policy record that contains a schema version field
- **THEN** the runtime SHALL reject the record because it does not match the current strict schema
- **AND** it SHALL NOT use the field to select another interpretation

#### Scenario: A policy uses an unsupported sandbox contract
- **WHEN** an execution policy does not match the current record format, or names an unsupported sandbox variant or unsupported restriction
- **THEN** the runtime SHALL reject it with the unsupported part identified
- **AND** it SHALL NOT ignore that part, convert it from an earlier format, or claim the requested confinement is enforced

#### Scenario: Provenance is not authorization
- **WHEN** a record or proposal names an unsupported classifier or producer in its provenance
- **THEN** that metadata SHALL NOT authorize a policy change or critical-operation decision
- **AND** an explicitly supported producer and authorization contract SHALL be required before integration

### Requirement: Classification saves preserve the exact owner review

Classification inspection SHALL show registered definitions without starting discovery or executing tools. A save SHALL compare both the reviewed definition digest and expected current classification revision. A stale review SHALL be rejected without replacing a newer policy. A successful save SHALL create an immutable revision and retain its authorized provenance.

Each save SHALL have a durable submission identity. An equal retry SHALL return the original saved revision, even after a later edit. Conflicting reuse SHALL fail. An uncertain commit SHALL require the same submission identity, not a new save. Fixed runtime declarations SHALL remain visible and non-editable.

#### Scenario: Two saves race from the same review
- **WHEN** two classification saves use the same expected revision
- **THEN** at most one SHALL update the current classification
- **AND** the other SHALL receive a conflict and require a new review

#### Scenario: A lost save response does not create another revision
- **WHEN** the owner retries an accepted save with equal submitted input and identity
- **THEN** the API SHALL return the original saved revision
- **AND** it SHALL NOT create another revision or overwrite a later edit

#### Scenario: Current definition no longer matches the review
- **WHEN** a registered tool changes after the owner opened its classification detail
- **THEN** a save for the earlier definition digest SHALL be refused
- **AND** the owner SHALL inspect the current definition before saving again

### Requirement: Configured identities do not silently replace authored agent references

Installed agent contributions and independently configured agents SHALL remain distinct identities. Facet selection SHALL NOT automatically activate installed agent instructions or bind their restrictions to a configured agent. This version SHALL refuse an explicit installed-agent prerequisite or nonempty authored agent restriction when no supported binding exists. It SHALL NOT satisfy that reference by a matching name or discard it. An explicit empty authored agent restriction SHALL prohibit child interactions within its scope, including discussion.

Supported command restrictions SHALL constrain the entire affected run. Absent restriction categories SHALL add no restriction; explicit empty categories SHALL deny the category. A caller's omitted facet or outgoing target SHALL NOT become an inherited denial.

#### Scenario: A configured name matches an installed agent
- **WHEN** a contribution requires an installed agent and an independently configured agent has the same textual name
- **THEN** the runtime SHALL NOT treat the name match as an executable binding
- **AND** it SHALL report the unsupported requirement without making unrelated contributions unavailable

#### Scenario: Discussion cannot bypass an explicit authored child prohibition
- **WHEN** a command explicitly denies agent invocation through an empty authored agent restriction
- **THEN** task delegation and discussion under that command SHALL both be refused
- **AND** the runtime SHALL retain the restriction and its source for inspection

### Requirement: Owner controls expose authority without inventing identity

Classification and approval controls SHALL remain behind the owner-console deployment boundary. They SHALL NOT be model-callable tools or available inside task sandboxes. Host and Origin checks SHALL NOT be represented as named-human authentication. Decision provenance SHALL identify the deployment-owner authority actually established by that boundary. Deployments with additional users SHALL establish authentication before exposing these controls.

Owner lists SHALL use bounded pages without silently imposing new configured-agent or invocation count limits. Stale cursors SHALL fail explicitly rather than combine incompatible revisions. Secret values, private checkpoints, and unscreened content SHALL remain excluded.

#### Scenario: Owner provenance reflects the actual boundary
- **WHEN** a decision is submitted through the private owner console without named-user authentication
- **THEN** its provenance SHALL identify the deployment-owner authority
- **AND** it SHALL NOT claim a verified personal identity

#### Scenario: More choices exist than fit one page
- **WHEN** eligible agents or registered tools exceed the first page
- **THEN** inspection SHALL provide a continuation cursor
- **AND** it SHALL NOT silently discard the remaining entries or reject configuration by page size

### Requirement: A development reset regenerates runtime facet inputs

After a development reset, the installation procedure SHALL generate runtime adapter exports and the sealed bundle again. It SHALL use the configured facet sources and recorded installation inputs. It SHALL NOT modify upstream facet sources, owner configuration, agent selections, or grants.

#### Scenario: Generate the runtime installation again after a reset
- **WHEN** the owner completes an approved development reset and generates the runtime installation again from the configured facet sources
- **THEN** the adapter exports and the sealed bundle SHALL agree with those sources and the recorded installation inputs
- **AND** upstream facet sources, owner configuration, agent selections, and grants SHALL remain unchanged

### Requirement: Admission decisions from before a reset are not used again

The runtime SHALL NOT use or reinterpret a contribution refusal, admission result, or compatibility decision that it recorded before a development reset. It SHALL evaluate each contribution in the generated installation again under the current rules.

#### Scenario: An earlier refusal does not carry forward
- **WHEN** a contribution was refused before a reset and the generated installation contains it
- **THEN** the runtime SHALL decide its admission again from the generated content and the current rules
- **AND** the earlier refusal SHALL NOT cause the contribution to be refused or admitted

### Requirement: Facet version identifiers keep their meaning

The removal of record format selectors SHALL NOT change external facet versions, facet dependency versions, or the authored `runtimeVersion: 1` metadata. The runtime SHALL interpret these identifiers under their existing rules.

#### Scenario: Authored version metadata stays valid
- **WHEN** the generated installation contains a facet with its published version, its dependency versions, and an authored `runtimeVersion: 1` block
- **THEN** the runtime SHALL interpret these values under their existing rules
- **AND** the change to one current record schema SHALL NOT refuse or rewrite them

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
- **WHEN** the owner inspects a facet selected for one agent and another selected independently for several agents
- **THEN** inspection SHALL distinguish each agent's selections, instructions, and configured delegation targets
- **AND** it SHALL distinguish configured startup loading from on-demand availability
- **AND** neither a selection nor a startup setting SHALL be reported as evidence of actual use in a run
- **AND** inspection SHALL be available without starting a run and SHALL distinguish unselected contributions from contributions excluded by known compatibility or permission restrictions, with reasons

#### Scenario: Two contributions have an unresolved name conflict
- **WHEN** two installed contributions cannot be distinguished by the name used to select them
- **THEN** the system SHALL report the conflict and the contributing facets
- **AND** it SHALL NOT resolve the ambiguous reference by installation order or silently overwrite either contribution

### Requirement: Skills are discovered and loaded on demand

An agent SHALL be able to discover the names and descriptions of the skills available through its effective selections and explicitly load a selected skill's full instructions when needed. Skill discovery SHALL NOT supply every skill's full instructions as initial agent context; only explicitly configured startup skills SHALL be preloaded. Loading a skill SHALL NOT install additional assets or grant additional authority. A loaded skill's bundled text references SHALL be readable on demand from its retained definitions, with access confined to that skill's bundled resources. This SHALL apply to both startup-loaded and on-demand-loaded skills and SHALL NOT grant general deployment-filesystem access or code execution. A reference read SHALL need the skill in the current effective capabilities of the requester. A skill body in the session history from an earlier agent selection SHALL NOT authorize a reference read.

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
- **WHEN** an agent requests a reference belonging to a skill it has not loaded, outside its current effective capabilities, missing from the loaded skill's retained resources, or targeting content outside them
- **THEN** the system SHALL refuse the request without exposing unrelated content
- **AND** loading the skill SHALL NOT authorize arbitrary filesystem access or execution of a referenced script

### Requirement: Named delegation is bounded

An agent SHALL be able to delegate a specified task to a permitted configured agent and receive its result or failure. The same target checks SHALL apply at every delegation depth. The caller SHALL wait for that delegation to finish rather than launch independent background work. Results SHALL return through the existing parent tool operation. This version SHALL NOT add unsolicited messages or an interrupting channel to an active caller. A later request from the caller SHALL be a new operation subject to normal admission.

The entry invocation SHALL have depth 0. Every new delegated invocation SHALL have its caller's depth plus 1. Each run SHALL have a documented finite maximum depth. The system SHALL reject a request that exceeds it before the target starts. Return to an existing caller SHALL NOT increase depth. A new invocation of a previously used agent name SHALL still increase depth.

Owner-controlled run configuration SHALL contain the entry policy and maximum delegation depth. It SHALL remain separate from individual agent configurations. An agent SHALL NOT increase or reset the run's depth limit. Each accepted run SHALL retain the depth limit used at acceptance.

If the maximum delegation depth is omitted, the runtime SHALL use 2. Explicit depth SHALL be a finite, non-negative safe integer, with no additional policy maximum. Depth 0 SHALL permit the entry invocation but no delegation. Validation SHALL reject negative, fractional, non-finite, or inexactly represented values without rounding or clamping. A high depth limit SHALL NOT increase or reset the run-wide model-step budget.

New runs SHALL NOT impose a separate delegation-call limit. All actors SHALL consume the same run-wide model-step budget. Delegation and return to a caller SHALL NOT reset that budget. The system SHALL NOT refuse an otherwise permitted delegation solely because of earlier delegation count.

The superseded `capabilities.maxDelegationsPerRun` setting SHALL be rejected with explicit migration guidance, not silently ignored. Run records SHALL NOT contain a delegation-call limit. The runtime SHALL NOT keep or enforce a delegation-call limit that a run recorded before a development reset.

Safely handled delegation refusals or task failures SHALL return to the caller with the target identity and reason and SHALL NOT by themselves fail the run. Failures already defined as terminal for the run, including exhaustion of its shared model-step budget, SHALL remain terminal when encountered by a delegate.

#### Scenario: Delegate a task and use its result
- **WHEN** an agent delegates a bounded task to a permitted configured agent
- **THEN** that agent SHALL receive the task and its retained instructions
- **AND** its result SHALL return to the caller within the same run
- **AND** a delegate failure SHALL remain distinguishable from a successful result

#### Scenario: Use two delegation layers
- **WHEN** the run's maximum depth is 2 and Coordinator delegates to Reviewer, which delegates to Researcher through permitted relationships
- **THEN** their invocation depths SHALL be 0, 1, and 2 respectively
- **AND** Researcher SHALL NOT start another delegated invocation at depth 3

#### Scenario: Omitted depth uses the default
- **WHEN** owner run configuration omits the maximum delegation depth
- **THEN** the runtime SHALL retain a maximum depth of 2 for a newly accepted run

#### Scenario: Depth zero disables delegation
- **WHEN** a run has an explicit maximum depth of 0
- **THEN** its entry invocation SHALL be permitted at depth 0
- **AND** every request to start a delegated invocation SHALL be rejected before the child starts

#### Scenario: An explicit depth exceeds eight
- **WHEN** owner run configuration supplies a finite, non-negative safe integer greater than 8 as the maximum depth
- **THEN** numeric validation SHALL accept that value without an additional policy ceiling
- **AND** delegation SHALL still obey that retained depth and the existing run-wide budget and permissions

#### Scenario: An invalid depth is not normalized
- **WHEN** the configured depth is negative, fractional, non-finite, or not exactly representable as a safe integer
- **THEN** validation SHALL reject the value with the field identified
- **AND** it SHALL NOT round, clamp, or substitute a default for the invalid value

#### Scenario: The existing caller delegates again
- **WHEN** Researcher returns to its existing Reviewer at depth 1 and Reviewer makes another permitted delegation within the remaining budgets
- **THEN** the new child SHALL have depth 2
- **AND** the completed call SHALL NOT consume another depth layer or reset any consumed work budget

#### Scenario: An earlier agent name does not reset depth
- **WHEN** an actor at the maximum depth requests a new invocation of an agent name already used earlier in the run
- **THEN** the system SHALL reject that request as exceeding depth
- **AND** it SHALL NOT treat a new invocation as return to the existing caller

#### Scenario: Repeated delegation has no separate count limit
- **WHEN** an agent in a new run requests another delegation within its configured relationships, depth limit, effective permissions, target usability, and remaining work budget
- **THEN** the runtime SHALL NOT refuse the request solely because of the number of earlier delegation calls

#### Scenario: Nested actors consume one model-step budget
- **WHEN** model work across the entry actor and descendants exhausts the run-wide model-step budget
- **THEN** further model dispatch SHALL stop under the existing budget-exhaustion contract
- **AND** a new child or return to an existing caller SHALL NOT create a fresh budget

#### Scenario: The superseded call-count setting needs migration
- **WHEN** configuration contains `capabilities.maxDelegationsPerRun`
- **THEN** validation SHALL reject the setting with guidance to use delegation depth and the run-wide model-step budget
- **AND** the runtime SHALL NOT silently ignore the setting or convert it into a depth value

#### Scenario: A run record with a delegation-call limit is refused
- **WHEN** the runtime reads a run record that contains a delegation-call limit
- **THEN** it SHALL refuse the record because the record does not match the current format
- **AND** it SHALL NOT enforce, convert, or remove that limit to continue the run

#### Scenario: Request an unavailable delegate or exceed a limit
- **WHEN** an agent requests an unavailable or unlisted target, or a delegation that exceeds a documented limit
- **THEN** the system SHALL report the target and refusal reason without dispatching that delegation
- **AND** it SHALL NOT silently substitute another agent

#### Scenario: Request independent background delegation
- **WHEN** an agent requests parallel, background, or long-lived delegated work outside the supported bounded model
- **THEN** the system SHALL refuse that request rather than start an independently continuing task

#### Scenario: A safely handled delegate failure
- **WHEN** a delegate returns a task failure after a safely refused tool call, without a run-ending failure
- **THEN** the caller SHALL receive an identifiable failure outcome rather than a fabricated result
- **AND** the caller SHALL remain able to continue within the run's existing permissions and remaining budget

### Requirement: Facets and delegates can only narrow authority

The system SHALL enforce each actor's explicit tool policy, interaction mode, owner grants, sandbox and resource constraints, critical-approval requirements, and run-wide, command, and authored restrictions. A caller's selected catalog SHALL NOT become the target's catalog or authority ceiling. Task delegation SHALL require an explicit relationship and SHALL NOT bypass the target's permissions. A caller's target list SHALL NOT become a global list for all descendants. Facet selection, instruction loading, and discussion SHALL NOT grant independent authority. Existing authored restrictions SHALL retain their explicit source and category semantics. Unsupported installed-agent bindings SHALL be refused rather than silently reinterpreted.

A role MAY permit specific writes without permitting all writes. Such permission SHALL remain subject to the active interaction mode. Returned discussion advice SHALL NOT itself grant authority; subsequent operations SHALL pass the recipient's normal execution checks.

An MCP grant's scope SHALL identify its server and tool and any supported constraints on request arguments. A target restriction means an owner-configured constraint on arguments selecting a resource, such as a repository identifier. The runtime SHALL enforce these constraints before dispatch and SHALL refuse restrictions it cannot enforce. These checks constrain requests, not the server process's independent access to resources.

#### Scenario: A facet requests more access than the owner granted
- **WHEN** a facet declares access to a tool or target outside the owner's grant
- **THEN** an agent using that facet SHALL NOT be able to dispatch the out-of-scope operation
- **AND** the refusal SHALL identify the denied operation without performing it

#### Scenario: A delegate has a narrower tool set
- **WHEN** a caller delegates to an agent whose restrictions exclude a tool that the caller can use
- **THEN** the delegate's attempt to call that tool SHALL be refused
- **AND** further delegation SHALL NOT bypass any restriction whose scope applies to that further work

#### Scenario: A reviewer can comment but cannot change code
- **WHEN** a reviewer's role permits posting review comments but prohibits source-code changes
- **THEN** ordinary task execution MAY post authorized comments without permission to modify source code
- **AND** the same reviewer in discussion mode SHALL NOT post comments or modify source code

#### Scenario: The target has a different selected tool catalog
- **WHEN** a permitted task target selects an owner-authorized tool absent from its caller's catalog and all applicable restrictions permit the operation
- **THEN** absence from the caller's catalog SHALL NOT by itself prevent the target's tool use
- **AND** the target SHALL still satisfy its own role, mode, grant, and argument checks

#### Scenario: Instructions attempt to expand permissions
- **WHEN** a command, skill, delegate instruction, inspected file, or MCP response instructs an agent to acquire additional access
- **THEN** that content SHALL NOT change the agent's effective permissions or authorize the requested operation

#### Scenario: Repeated independent selection is not a server approval
- **WHEN** several agents independently select a facet that declares an MCP server without applicable owner approval
- **THEN** no agent SHALL launch or connect to that server or dispatch its tools on the strength of those selections
- **AND** inspection SHALL distinguish selection from the missing approval

#### Scenario: Individual selection does not bypass an applicable execution restriction
- **WHEN** a delegate selects a facet containing a tool excluded by an owner, run-wide, command, or authored restriction applicable to that invocation
- **THEN** the delegate SHALL NOT dispatch that tool even if a broader deployment grant exists
- **AND** the refusal SHALL identify the applicable restriction rather than treat selection as authority
