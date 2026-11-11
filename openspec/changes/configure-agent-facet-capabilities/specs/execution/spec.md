# Execution Spec Delta

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

### Requirement: A run starts at a configured entry agent

A run SHALL identify its entry agent. A separate owner-controlled entry policy SHALL identify permitted entry agents and the default entry agent. The policy SHALL remain outside individual agent configurations. Every policy reference SHALL resolve to a configured agent, and the default SHALL belong to the permitted entry set. Invalid policy configuration SHALL be rejected.

The console SHALL provide an agent selector for goal runs and command runs. It SHALL list only permitted entry agents and initially select the default. A start request MAY name a permitted entry agent; an omitted choice SHALL use the configured default. The runtime SHALL enforce eligibility independently of the console and SHALL reject an unknown or ineligible explicit choice without fallback.

Selecting an entry agent SHALL select an existing owner-managed configuration, not override its instructions, facets, startup skills, or delegation targets. The same configuration SHALL apply when that agent receives a delegated task. Applicable execution restrictions MAY differ by invocation. Entry eligibility SHALL NOT grant delegation permission, and absence from the entry set SHALL NOT prevent otherwise permitted delegation.

Supplied default settings SHALL include an ordinary agent configuration that preserves existing native behavior, with empty facet, startup-skill, and delegation-target lists. The supplied entry policy SHALL permit that agent and select it as the default. It SHALL use the same configuration structure as other agents, not a special root configuration type.

#### Scenario: An omitted entry choice uses the default
- **WHEN** a new goal or command start omits an entry-agent choice and the entry policy is valid
- **THEN** the runtime SHALL select the configured default and apply its configuration and admission checks

#### Scenario: Select another permitted entry agent
- **WHEN** the owner selects a permitted agent other than the default
- **THEN** the new run SHALL use the selected agent rather than the default
- **AND** the selection SHALL NOT edit either agent's configuration or the entry policy

#### Scenario: A delegate-only agent is not an entry point
- **WHEN** a configured agent is absent from the permitted entry set
- **THEN** the console SHALL omit it from the entry selector
- **AND** a direct run-start request that names it SHALL be rejected without fallback or model dispatch
- **AND** otherwise permitted delegation to it SHALL remain available

#### Scenario: An explicit entry choice is unknown
- **WHEN** a new start names an agent that does not exist in configuration
- **THEN** the runtime SHALL reject the request without falling back to the default or dispatching model work

#### Scenario: Entry policy references are invalid
- **WHEN** an entry-policy reference does not identify a configured agent or the default is outside the permitted entry set
- **THEN** configuration validation SHALL reject the policy with the affected field and reference identified
- **AND** it SHALL NOT silently choose another default or add an agent to the entry set

#### Scenario: Supplied defaults preserve the native journey
- **WHEN** the owner uses the supplied default settings and submits a goal without an entry-agent choice
- **THEN** the ordinary default agent SHALL provide the existing confined native-tool journey
- **AND** admission SHALL NOT require a facet installation or contact an MCP server

#### Scenario: Start directly at an agent also used as a delegate
- **WHEN** the owner starts a run at an eligible configured agent that other agents can also invoke
- **THEN** the run SHALL use that agent's retained configuration for its depth-0 invocation
- **AND** it SHALL NOT require a separate root configuration or inherit selections from a previous caller

#### Scenario: Distinguish configured agents from invocations
- **WHEN** several task invocations or new sessions in a run use the same configured agent
- **THEN** each SHALL have a distinct actor or session identity, instruction context, startup membership, and history
- **AND** each delegated invocation SHALL identify its parent actor and depth
- **AND** each discussion turn SHALL identify its session, caller, and depth

#### Scenario: Retry an accepted start with an entry choice
- **WHEN** the owner retries an accepted request with the same submitted input and entry-agent choice after configuration changes
- **THEN** the system SHALL return the original run and retained entry configuration
- **AND** reusing that request identity with a different submitted entry-agent choice SHALL cause a conflict rather than replace the accepted run

#### Scenario: Retry an accepted start after the default changes
- **WHEN** an accepted request omitted an entry-agent choice and the default later changes
- **THEN** a retry with the same submitted input SHALL return the original run and its retained entry identity
- **AND** accepted-request lookup SHALL occur before the runtime reads the current entry policy

#### Scenario: Retry after entry eligibility changes
- **WHEN** an accepted run's entry agent is later removed from the permitted entry set and the owner retries the same submitted request
- **THEN** the runtime SHALL return the original run before checking current entry eligibility
- **AND** the policy change SHALL NOT replace that run's entry identity

### Requirement: Goal runs use configured facet capabilities

For either supported subscription provider, a run started from a free-form goal SHALL make the entry agent's configured, compatible, and authorized facet capabilities available without requiring a command. The entry agent SHALL be able to load selected skills, delegate through its configured relationships, and call approved MCP tools within the same permission, budget, cancellation, question, and continuation rules as command-started runs. At every permitted depth, delegates SHALL use their own retained configurations rather than inherit the caller's catalog or outgoing target list.

Facet-provided skill, command, and MCP tool candidates SHALL come from the agent's selected facets without another per-agent contribution allowlist. Existing owner grants, resource restrictions, read/write policy, critical approval, and discussion mode SHALL still govern execution. Availability SHALL NOT imply startup loading of every skill or permission to delegate to every installed agent.

A deployment without capability configuration SHALL retain the existing goal-based journey with confined native tools. Its runs SHALL use the same capability retention as other runs, and that retention SHALL NOT change their authority. Neither goal text nor a run-start request SHALL override owner-managed facet selections or delegation targets. Selecting an existing configured entry agent SHALL NOT count as a configuration override.

#### Scenario: Complete a facet-backed goal with either provider
- **WHEN** the owner selects either supported provider and submits a goal for an agent configured with a skill, a bounded named delegate, and an approved MCP tool
- **THEN** the run SHALL be able to load the skill, delegate a task, use the approved tool within effective permissions, ask and answer an owner question, and produce an inspectable result
- **AND** no selected command or synthetic command wrapper SHALL be required
- **AND** the run SHALL retain its selected provider and shared step budget across delegation and continuation

#### Scenario: Use the real voice-to-text skill at startup
- **WHEN** the owner installs the published `voice-to-text` facet unchanged into the independent runtime installation, selects it for the entry agent, configures its skill for startup, and submits a goal containing dictated text
- **THEN** the entry agent's first model request SHALL include that installed skill's instructions with the submitted goal
- **AND** the recorded run SHALL identify the skill's facet and version and startup loading
- **AND** neither runtime-specific author metadata nor a wrapper command SHALL be required

#### Scenario: A delegate has a different skill selection
- **WHEN** a goal run whose entry agent uses `voice-to-text` delegates to an agent that has not selected that facet in its own configuration
- **THEN** the system SHALL NOT automatically supply that skill's body or catalog entry to the delegate
- **AND** a delegate request to load the skill SHALL be refused without obtaining it from the caller's loaded definitions

#### Scenario: The same startup skill is configured independently
- **WHEN** two agents independently select `voice-to-text` and designate its skill for startup, and one invokes the other
- **THEN** each invocation SHALL receive the retained installed instructions before its own first model request
- **AND** the run SHALL attribute each startup supply to its own actor and configured agent

#### Scenario: A goal uses bounded nested delegation
- **WHEN** a goal starts at Coordinator with a maximum depth of 2 and permitted relationships lead through Reviewer to Researcher
- **THEN** both delegation steps SHALL be available subject to permissions, usability, and remaining budgets
- **AND** a further delegation from Researcher SHALL fail before a depth-3 actor starts
- **AND** Reviewer SHALL remain able to delegate again at depth 2 after Researcher returns, within the remaining budgets

#### Scenario: Continue native operation without capabilities
- **WHEN** a deployment has no capability configuration and the owner submits a valid goal
- **THEN** the existing workspace read, search, question, and result journey SHALL remain available
- **AND** the system SHALL NOT require a facet installation or contact an MCP server to start that run
- **AND** absence of capability configuration alone SHALL NOT cause a warning, failure, or wait
- **AND** the run SHALL retain a capability binding that identifies no installation and contains no installed definitions
- **AND** inspection SHALL show the run as an ordinary goal run

### Requirement: Discussion invocations retain a read-only execution mode

The runtime SHALL distinguish discussion from task delegation when it creates or addresses an agent invocation. It SHALL establish discussion mode before model or tool dispatch and explain the mode to the agent. A discussion SHALL NOT become executable task instructions for an unrestricted actor. The mode SHALL constrain actual dispatch, not only the advertised tools or prompt text.

Further discussion caused by a discussion invocation SHALL retain the restriction. Neither message content nor returned advice SHALL authorize task execution or mode changes. Any subsequent action SHALL pass the recipient's normal execution checks. Discussion SHALL NOT bypass applicable owner access restrictions or run-wide resource controls. Approved design Decisions 18 through 22 specify invocation, depth, accounting, sessions, turns, the run scope of sessions, session state, owner agent selection, and replay.

#### Scenario: Discussion is enforced before the first tool request
- **WHEN** an agent normally authorized to mutate resources receives a discussion request
- **THEN** its receiving invocation SHALL start with an explicit discussion-mode instruction and runtime-enforced restrictions
- **AND** mutating tools and task delegation SHALL be blocked before dispatch even if the model requests them

#### Scenario: Advice is not execution authority
- **WHEN** an agent returns advice from a discussion that includes a suggested write operation
- **THEN** returning the advice SHALL NOT dispatch the operation or grant permission to perform it
- **AND** any subsequent action SHALL require the recipient's normal role, mode, and policy checks

#### Scenario: Discussion cannot be routed through unrestricted task execution
- **WHEN** a discussion invocation asks another agent to perform a prohibited write or task delegation
- **THEN** the runtime SHALL NOT route that request into an unrestricted task actor to escape discussion mode
- **AND** any permitted further consultation SHALL remain read-only

#### Scenario: Runtime bookkeeping remains possible during discussion
- **WHEN** a discussion performs an authorized read or returns advice
- **THEN** the runtime MAY persist its history, checkpoint, and budget records
- **AND** those records SHALL NOT authorize mutation of task resources

### Requirement: Depth awareness persists across actor requests and continuation

Each task actor and each discussion turn SHALL receive its runtime-generated depth-awareness block before its first model request. Every later request in that actor or turn SHALL contain the same block. It SHALL describe the retained mode, current depth, maximum depth, remaining child levels, and mode-specific child interactions. A later turn of the same session MAY receive a different block.

Compatible continuation SHALL reconstruct the block from the same retained run, actor, and turn records. It SHALL NOT use changed deployment defaults or infer depth from conversation text. Prompt assembly and applicable execution-definition digests SHALL cover the block. A discussion turn SHALL receive its own block rather than copy its caller's depth instructions.

#### Scenario: A returned child does not change caller depth
- **WHEN** a child returns to an existing caller at depth 1 with retained maximum 2
- **THEN** the caller's next request SHALL retain the same depth-awareness block and one remaining child level
- **AND** consumed model steps SHALL remain consumed

#### Scenario: Compatible continuation preserves depth instructions
- **WHEN** an actor continues compatibly after deployment defaults change
- **THEN** its system prompt SHALL reconstruct its original depth-awareness block from retained records
- **AND** current permissions and workspace admission SHALL still constrain dispatch

#### Scenario: First request includes depth awareness before startup skills
- **WHEN** an actor starts with configured startup skills
- **THEN** its first system prompt SHALL include its depth-awareness block before the startup-skill blocks
- **AND** the mode and depth restrictions SHALL agree with the offered child-interaction tools

#### Scenario: A later turn receives its own depth block
- **WHEN** an idle session had an earlier turn at depth 2 and a caller at depth 0 in the same run starts a later turn under a retained maximum of 2
- **THEN** each request of the later turn SHALL contain a depth-awareness block for depth 1 with one remaining child level
- **AND** the block of the earlier turn SHALL NOT limit the later turn

### Requirement: A discussion returns one final result through its parent operation

The runtime SHALL expose the native discussion control tool `tool__Discuss`. Its input SHALL contain only `target` and `topic`. The `target` SHALL have exactly one of two kinds. A `new` target SHALL contain only an `agentId` that identifies an agent configuration retained for the run. A `session` target SHALL contain only the `sessionId` of an existing session that the current run owns. The `topic` SHALL be a nonblank, self-contained string.

The topic SHALL be storable, and the common message-size policy SHALL apply to it without a separate size limit. The input SHALL contain only its strict fields, and the runtime SHALL apply credential screening to it. The caller SHALL NOT supply a workspace, actor, mode, depth, checkpoint, provider, or budget override.

A successful call SHALL start one turn in the target session, in the run and workspace of the caller. For a `new` target, the runtime SHALL create the session before the turn. The turn SHALL return screened final advice through the parent tool result. It SHALL NOT copy the caller's conversation or attach to a live actor. A successful result SHALL have outcome `ok` and contain the `discussionId`, `sessionId`, `agentId`, and advice `text`. Each consultation SHALL have its own operation, discussion ID, and result.

The discussion call SHALL be the only tool call in its model response. A mixed batch SHALL refuse every call without dispatch. The caller SHALL wait for its result; this version SHALL NOT start background consultations or introduce a message bus. A later follow-up SHALL be a new operation. It MAY target the same session when that session is idle.

A session SHALL have at most one active turn. A session SHALL remain busy while its turn waits for a child. Every session in the active waiting chain of the caller, including the session of the caller, SHALL be busy. The runtime SHALL claim an existing target session atomically, so that concurrent requests cannot start competing turns. If the target session is busy, the runtime SHALL refuse the call with `discussion_target_busy`. It SHALL NOT queue the request, interrupt the active turn, or steer it.

If the target is unknown, owned by another run, inaccessible, or otherwise unavailable, the runtime SHALL refuse the call with `discussion_target_unavailable`. This refusal SHALL NOT disclose the content or status of a session that the caller cannot access. The runtime SHALL NOT refuse a `new` target because it names the agent configuration of the caller. An idle session SHALL still be subject to access checks and the other admission checks.

The answer of a turn SHALL complete the existing consultation. It SHALL NOT be a new call from the target to the caller. The runtime SHALL release the session only after it durably records the terminal result of the turn. After that release, another permitted caller in the same run MAY consult the session. A turn with unsettled work SHALL NOT make its session idle. Cancellation, uncertain storage, and unresolved external effects SHALL keep their existing rules.

The runtime SHALL omit the discussion tool when the caller is at its retained maximum depth. Tool exposure SHALL NOT bypass independent target, mode, permission, budget, or workspace-gate checks.

The result SHALL contain the final advice, not the child transcript. The runtime SHALL apply credential screening to the advice before it returns or records the advice. The common message-size policy SHALL apply to the advice without a separate advice size limit. The runtime SHALL NOT truncate, summarize, or omit part of the advice. If a provider, transport, serialization, or storage failure occurs, the outcome SHALL identify that actual failure category. The runtime SHALL NOT report missing advice as a successful result.

Ordinary refusals and scoped failures SHALL identify their cause without pretending to provide advice. Cancellation, budget exhaustion, storage failure, and uncertain dispatch SHALL retain their run-level semantics. A discussion needing clarification SHALL return that need to its caller rather than ask the owner directly. This SHALL NOT remove owner questions from ordinary task delegates or approval controls for critical read-only leaf operations.

#### Scenario: Discussion is an exclusive call
- **WHEN** a model response requests discussion alongside another tool call
- **THEN** every call in that batch SHALL be refused before dispatch
- **AND** no session SHALL be created and no turn SHALL start

#### Scenario: The caller receives only the finished advice
- **WHEN** a permitted discussion turn produces a valid final answer
- **THEN** the caller SHALL receive the complete screened answer after its outcome is durably confirmed
- **AND** the result SHALL identify the discussion ID, session ID, and agent ID
- **AND** the turn SHALL NOT inject intermediate conversation or unsolicited messages into an existing actor

#### Scenario: A follow-up reuses an idle session
- **WHEN** a caller receives advice from a session and then makes a new discussion call with a new topic and the same session ID
- **THEN** the runtime SHALL start a new turn in the same session with a new discussion ID
- **AND** the turn SHALL use the session's own prior conversation and the new topic
- **AND** the turn SHALL NOT receive the caller's conversation or the history of other sessions

#### Scenario: A follow-up to a new target creates another session
- **WHEN** a caller makes a new discussion call with a `new` target after it received earlier advice
- **THEN** the runtime SHALL create a different session for that call
- **AND** earlier discussion history SHALL NOT be copied into the new session

#### Scenario: Concurrent requests name the same idle session
- **WHEN** 2 requests for a turn in the same idle session arrive at the same time
- **THEN** at most one turn SHALL start in that session
- **AND** the other request SHALL be refused with `discussion_target_busy`

#### Scenario: A busy session is refused without a queue
- **WHEN** a caller names a session whose turn is active or waits for a child
- **THEN** the runtime SHALL refuse the call with `discussion_target_busy`
- **AND** it SHALL NOT queue the request, interrupt the active turn, or add the topic to that turn

#### Scenario: A session becomes available after durable completion
- **WHEN** a turn completes and the runtime durably records its terminal result
- **THEN** another permitted caller in the same run MAY start a new turn in that session
- **AND** before that record is durable, the session SHALL remain busy

#### Scenario: An unavailable session is refused safely
- **WHEN** a caller names a session ID that does not exist, that another run owns, or that the caller cannot access
- **THEN** the runtime SHALL refuse the call with `discussion_target_unavailable`
- **AND** the refusal SHALL NOT disclose whether the session is busy or what it contains

#### Scenario: A large topic is accepted
- **WHEN** a caller requests discussion with a retained target and a nonblank topic larger than 100 KiB that passes credential screening
- **AND** the input passes all other applicable checks, and the required transport, serialization, and storage operations succeed
- **THEN** the runtime SHALL NOT refuse the call because of the topic size
- **AND** the discussion turn SHALL receive the complete topic

#### Scenario: Invalid discussion input is refused
- **WHEN** a discussion request has a blank topic, an unknown field, a target kind other than `new` or `session`, a `new` target whose agent ID is not a retained agent configuration, or a runtime-managed credential
- **THEN** the runtime SHALL refuse the call without creating a session or starting a turn
- **AND** it SHALL NOT echo or durably record the credential

#### Scenario: Large advice returns complete
- **WHEN** a discussion turn produces final advice larger than 100 KiB and the runtime records the advice durably
- **AND** the input passes all other applicable checks, and the required transport, serialization, and storage operations succeed
- **THEN** the caller SHALL receive the complete screened advice
- **AND** the runtime SHALL NOT truncate, summarize, or omit part of the advice

#### Scenario: A backend failure stops advice delivery
- **WHEN** a provider, transport, serialization, or storage failure prevents delivery of discussion advice
- **THEN** the outcome SHALL identify that actual failure category under the applicable child-failure or run-level rules
- **AND** the runtime SHALL NOT report a discussion size limit as the cause
- **AND** it SHALL NOT return partial advice or report a successful result without the advice

### Requirement: Discussion shares run accounting without blocking approval drain

Discussions SHALL use the run's retained provider binding, owner invocation, and shared model-step budget. Each new child model request SHALL pass durable admission and consume a normal run step. The deployment model-request ceiling SHALL remain effective. Tool argument validation, time limits, and process limits SHALL remain effective. Ordinary message content in tool arguments and common tool results SHALL follow the Message-size and monitoring policy.

Session creation, turn start, startup supply, and result bookkeeping SHALL NOT create separate model charges. Discussion SHALL NOT introduce a new total discussion-call or durable tool-call counter.

Each turn SHALL use the model-step budget of its run. Reuse of a session SHALL NOT create a fresh budget. Current grants, the workspace gate, and compatibility checks SHALL apply to each turn.

Every new discussion, model request, and tool call SHALL obey the workspace gate. A hold SHALL suspend new dispatch, not fabricate a refusal, owner question, or successful result. Waiting SHALL NOT consume model steps. Parent operations SHALL retain their original identities while children wait.

The workspace drain set SHALL distinguish active leaf effects from logical discussion or delegation wrappers. A parent awaiting its child, or a child waiting for approval, SHALL NOT prevent draining merely because its orchestration promise is unresolved. Actual cancellation tracking SHALL still include child work and durable writes. No dispatch gate SHALL be held while awaiting a child's completion.

#### Scenario: Discussion model work consumes the same run budget
- **WHEN** a caller and its nested consultations issue model requests
- **THEN** each new request SHALL consume the same run-level model-step budget and deployment ceiling
- **AND** the start of a consultation or the return from it SHALL NOT reset or duplicate that budget

#### Scenario: A reused session does not get a fresh budget
- **WHEN** a caller starts a later turn in an existing session of the same run
- **THEN** each model request of that turn SHALL consume the run-level model-step budget of that run
- **AND** the earlier use of the session SHALL NOT restore or add model steps

#### Scenario: A child critical read does not deadlock its parent
- **WHEN** a discussion child requests an otherwise permitted critical read and closes the workspace gate
- **THEN** the caller chain SHALL remain suspended while actual admitted leaf effects settle
- **AND** unresolved parent tool wrappers SHALL NOT stop the workspace from becoming ready for individual approval
- **AND** approving the read SHALL NOT permit further model requests until ordinary admission reopens

#### Scenario: A workspace hold is not a consultation failure
- **WHEN** a discussion has more work but its workspace gate closes
- **THEN** the runtime SHALL preserve its pending operation and checkpoint rather than manufacture a refusal or owner question
- **AND** resumption SHALL continue the same logical invocation under the normal admission and compatibility checks

### Requirement: Discussion context uses the target's retained definitions

Acceptance SHALL retain the configured discussion catalog and necessary definitions. The catalog SHALL include configured agents not reachable through task-delegation edges and the agent configuration of the caller. The runtime SHALL retain each configuration once. If no installed facet data is needed, retention of configured definitions SHALL NOT require an installation read.

A new session SHALL receive its retained instructions, eligible read-only tool descriptions, configured startup skills, runtime instructions, and the explicit topic. A later turn of an existing session SHALL receive the session's own prior conversation and the new topic. A new topic alone SHALL NOT cause another startup activation or duplicate skill-body insertion. No turn SHALL automatically receive the conversation of the caller, a sibling session, or another session. No turn SHALL automatically receive hidden reasoning or history from other sessions or runs. Runtime instructions and offered tools SHALL reflect the current turn's mode and depth.

The stored history of a session and the model context of a turn are different records. The runtime SHALL NOT automatically compact, summarize, or truncate the prior conversation of a session. A new run SHALL NOT automatically receive session history from an earlier run in its model context.

A session SHALL use its selected agent configuration from the configurations retained for its run. Current deployment definitions SHALL NOT replace those retained definitions. If the retained definitions of the selected configuration are incompatible with the current runtime, the runtime SHALL refuse the turn explicitly.

The target's mode-specific usability and startup checks SHALL remain separate from task-mode usability. Invalid targets SHALL have inspectable reasons rather than executable replacement definitions. Workspace reads SHALL use authorized current files without filesystem snapshots or cross-workspace access.

Loaded skill history SHALL belong to the session. It SHALL identify the turn and the agent selection that loaded each skill. Each model response SHALL freeze the eligible skill membership for the tool calls of that response, under the existing rule for reference reads. Skill history from an earlier turn or an earlier agent selection SHALL NOT bypass the mode, the selected configuration, or the current grants of a later request.

Every accepted run SHALL retain a capability binding, including a run whose agents select no facets. The supplied single-agent default MAY consult a new session of its own agent configuration. The runtime SHALL NOT assume that the supplied default has no discussion target.

Retention SHALL include the complete catalog. It SHALL NOT drop a target or delay a definition until first use. A fixed aggregate snapshot size limit SHALL NOT apply to the catalog. Facet content validation and startup-instruction limits SHALL remain effective for each definition.

#### Scenario: Target context does not inherit the caller's loaded instructions
- **WHEN** a caller with loaded skills invokes another agent for discussion
- **THEN** the new session SHALL receive its own retained startup context and explicit topic
- **AND** the caller's loaded skill bodies and conversation SHALL NOT be copied automatically

#### Scenario: A later turn uses only the session's own history
- **WHEN** a caller starts a later turn in an idle session of the same run, and a different caller made the earlier turn
- **THEN** the model context SHALL contain the session's prior conversation and the new topic
- **AND** it SHALL NOT contain the conversation of either caller or of another session

#### Scenario: A later turn does not repeat startup supply
- **WHEN** a session with configured startup skills receives a later turn
- **THEN** the runtime SHALL retain the session's startup instructions without duplicate body insertion or a second startup activity
- **AND** history SHALL distinguish the later turn from the startup of the session

#### Scenario: A long session history is not compacted
- **WHEN** the prior conversation of a session is larger than 100 KiB and the session receives a later turn
- **AND** the input passes all other applicable checks, and the required transport, serialization, and storage operations succeed
- **THEN** the model context SHALL contain the complete prior conversation
- **AND** the runtime SHALL NOT automatically summarize, truncate, or remove earlier messages

#### Scenario: Earlier skill state does not bypass a later turn's restrictions
- **WHEN** a skill loaded in an earlier turn of a session is outside the grants or mode of a later turn
- **THEN** the later turn SHALL NOT use that skill state to obtain a tool or authority that its mode or grants deny

#### Scenario: Retained session definitions are not replaced
- **WHEN** the deployment configuration of an agent changes after a session of that agent was created
- **THEN** a later turn of that session SHALL use the definitions of its selected agent configuration retained for the run
- **AND** if those definitions are incompatible with the current runtime, the runtime SHALL refuse the turn explicitly without substitution of current definitions

#### Scenario: The supplied default consults its own configuration
- **WHEN** an agent in a run of the supplied single-agent default requests a new session of its own agent configuration and applicable checks pass
- **THEN** the runtime SHALL NOT refuse the call because no other configured agent exists

#### Scenario: Native configured agents can be retained without an installation
- **WHEN** an entry agent can consult another configured native agent and neither needs installed facet data
- **THEN** the run SHALL retain those definitions and the discussion catalog without an installation read
- **AND** the run SHALL retain the agent configuration of the entry agent once
- **AND** later configuration changes SHALL NOT replace those accepted definitions

#### Scenario: Retention keeps a large catalog complete
- **WHEN** the required discussion definitions are larger than 16 MiB in total and each definition passes its own validation
- **AND** the input passes all other applicable checks, and the required transport, serialization, and storage operations succeed
- **THEN** admission SHALL NOT refuse the run because of the total catalog size
- **AND** the run SHALL retain every required definition with its exact content

#### Scenario: Retention cannot silently omit part of a catalog
- **WHEN** a serialization or storage failure prevents retention of the required discussion definitions
- **THEN** admission SHALL fail explicitly and identify that failure
- **AND** the runtime SHALL NOT truncate targets or load current definitions lazily to make the run continue

### Requirement: Discussion lifecycle and replay preserve one turn per operation

A discussion SHALL identify its target session and its distinct execution turn. It SHALL use a discussion operation-binding kind, not a synthetic task-delegation record. The identity of each turn SHALL derive from the actual parent actor's operation identity. The target session, parent, mode, depth, input digest, and checkpoint namespace of a turn SHALL remain immutable. Each model request of a turn SHALL keep the agent configuration binding captured for it. If an operation identity is used again with conflicting input, the runtime SHALL refuse it rather than start another turn.

Each session record SHALL identify its owning run, and that identity SHALL NOT change. Every session lookup and every turn admission SHALL check that the current run owns the session. A session of another run SHALL NOT be found or admitted, even in a shared workspace. A session of a terminal run SHALL NOT admit a new turn.

Session creation, startup memberships, and the start event with its complete startup list SHALL commit atomically before the first turn executes. The claim of an existing session SHALL commit atomically with the start of its turn. A representable refusal before a turn starts SHALL complete its parent operation and refusal history without an executable turn. Turn completion SHALL atomically commit its terminal result, completion history, and parent tool outcome before the caller observes it. An unconfirmed commit SHALL NOT be reported as a confirmed result.

Completed operation replay SHALL return the exact recorded outcome. It SHALL NOT add the topic to the session again, start a new turn, create a session, or call a model. Active re-entry SHALL use the same turn and namespace. Compatible continuation SHALL verify the full suspended ancestor chain without executing the graph. It SHALL preserve the session, mode, depth, retained definitions, the binding of each prepared request, and loaded membership. Current owner revocations and the workspace gate SHALL still constrain new dispatch.

A record of work without a discussion SHALL NOT receive invented discussion provenance. The exact contracts for conversation records, checkpoints, and session discovery still need explicit completion. These requirements SHALL NOT be read as proof that those contracts are ready for implementation.

#### Scenario: Replay of a completed discussion returns its recorded result
- **WHEN** the same parent operation is replayed after its discussion completed
- **THEN** the runtime SHALL return the original recorded outcome
- **AND** it SHALL NOT add the topic to the session, start a turn, create a session, or call a model
- **AND** changed current configuration SHALL NOT replace that recorded result

#### Scenario: A new topic is a new operation
- **WHEN** a caller sends a new topic to an idle session of the same run after an earlier turn completed
- **THEN** the runtime SHALL treat the call as a new operation with a new discussion ID
- **AND** the recorded result of the earlier operation SHALL NOT change

#### Scenario: A nested parent determines turn identity
- **WHEN** a discussion is requested by a non-entry actor
- **THEN** the turn SHALL bind to that actual parent's operation and actor identity
- **AND** it SHALL NOT be attributed to the entry actor

#### Scenario: A session lookup checks the owning run
- **WHEN** a run requests a turn in a session that another run owns in the same workspace
- **THEN** admission SHALL refuse the turn before it claims the session or dispatches model work
- **AND** the owning run of that session SHALL NOT change

#### Scenario: Startup is never partially visible
- **WHEN** session creation or startup persistence fails
- **THEN** no executable session with a partial startup set SHALL become visible
- **AND** the caller SHALL NOT receive an invented successful result

#### Scenario: Completion is durable before return
- **WHEN** a discussion turn finishes but its result commit cannot be verified
- **THEN** the runtime SHALL preserve uncertain-storage behavior
- **AND** it SHALL NOT return unconfirmed advice as a completed operation
- **AND** the session SHALL remain busy

### Requirement: A session has one execution state

Each session SHALL have an execution state of idle or active. An active session SHALL identify its active turn and the existing owner epoch of that turn. Inspection SHALL show whether an active turn runs or waits. The runtime SHALL get that status from the existing records of the turn. A turn that waits for a child, an approval, or an answer SHALL keep its session active.

The change from idle to active SHALL be atomic under the existing owner fence. Two competing turns SHALL NOT become active in one session. A session SHALL become idle only after the runtime durably records the terminal result of its turn and all work of the turn is settled. An uncertain outcome SHALL keep the session active.

The runtime SHALL keep this state with the session and the existing operation records. It SHALL NOT add a separate claim record, a lease service, or a second operation record for sessions.

#### Scenario: A waiting turn keeps its session active
- **WHEN** a turn waits for an owner answer, a child, or an approval
- **THEN** session discovery SHALL show that session as busy
- **AND** a discussion call that names that session SHALL be refused with `discussion_target_busy`

#### Scenario: Inspection shows the active turn
- **WHEN** the owner inspects an active session
- **THEN** inspection SHALL identify the active turn
- **AND** it SHALL show whether that turn runs or waits

#### Scenario: An uncertain effect keeps the session active
- **WHEN** a tool effect of a turn has an uncertain outcome
- **THEN** the session SHALL remain active
- **AND** the runtime SHALL NOT start another turn in that session

### Requirement: Session conversation history is ordered and replay-safe

Each session SHALL keep an ordered conversation. Each message SHALL have a stable ID and a position that is unique in the order of its session. Each message SHALL identify the turn and the operation that produced it. Messages SHALL keep the validated content of model messages and tool outcomes, including their recorded provider metadata.

A new turn SHALL bind the exact prior conversation of its session when the turn starts. Replay and recovery SHALL NOT add a duplicate input message or output message. The conversation of a session SHALL be a record separate from the execution checkpoint of a turn. A new consultation SHALL start a new turn that uses the conversation of its session. Resumption of an interrupted turn SHALL use its existing checkpoint and the binding captured for its prepared request.

An owner agent selection change SHALL NOT make continuation unavailable only because the selected agent changed. Prepared work SHALL keep its earlier binding. Later request preparation SHALL use the new selection. Ownership checks, exact replay, and uncertain-outcome rules SHALL remain effective. The runtime SHALL NOT automatically repeat an external effect with an uncertain outcome. The runtime SHALL NOT automatically compact the conversation.

#### Scenario: Replay does not duplicate messages
- **WHEN** recovery repeats an operation whose input and output messages are already recorded
- **THEN** the conversation SHALL contain each of those messages once
- **AND** each message SHALL keep its original ID and position

#### Scenario: A new turn binds the prior conversation
- **WHEN** a later turn starts in a session whose conversation contains 6 messages
- **THEN** the turn SHALL bind those 6 messages in their recorded order
- **AND** the turn SHALL NOT receive messages from another session

#### Scenario: Resumption after a selection change keeps the prepared binding
- **WHEN** a turn stops after the runtime prepared a request with configuration A, and the owner selects configuration B before resumption
- **THEN** resumption SHALL continue from the existing checkpoint with configuration A for that prepared request
- **AND** the next prepared request SHALL use configuration B
- **AND** the runtime SHALL NOT refuse continuation only because the selected agent changed

#### Scenario: Resumption does not repeat an uncertain effect
- **WHEN** resumption finds a tool call whose external effect has an uncertain outcome
- **THEN** the runtime SHALL NOT dispatch that tool call again automatically
- **AND** the uncertain outcome SHALL remain visible

### Requirement: An owner agent selection applies at the next model request preparation

The owner MAY change the selected agent of a session while the session is active. When the runtime prepares a model request, it SHALL capture the latest committed selection. It SHALL assemble the instructions and tools of that request from the retained configuration of the captured selection. A prepared request SHALL keep its captured selection for the request and for the tool calls in its response. The runtime SHALL NOT change the permissions of a tool call after its request was prepared.

A change after capture SHALL apply to the next request preparation. If several changes occur before a capture, the latest committed change SHALL apply. Current owner revocations SHALL still apply to each request and tool call.

A selection change SHALL NOT interrupt current work, start another turn, or start concurrent execution in the session. It SHALL NOT add a user message or a queued message. The mode and depth of a turn SHALL NOT change during the turn. The selected agent MAY change between the model requests of one turn.

The console SHALL show the agent selected for future requests separately from the agent of each prepared request.

#### Scenario: A change during a model request applies to the next request
- **WHEN** the owner selects configuration B while a request prepared with configuration A waits for the provider
- **THEN** that request and the tool calls in its response SHALL use configuration A
- **AND** the next prepared request SHALL use configuration B

#### Scenario: The latest change before capture applies
- **WHEN** the owner selects configuration B and then configuration C before the next request preparation
- **THEN** the next prepared request SHALL use configuration C
- **AND** no request SHALL use configuration B

#### Scenario: A tool call keeps its prepared configuration
- **WHEN** a response to a request prepared with configuration A contains a tool call, and the owner selects configuration B before dispatch
- **THEN** the runtime SHALL check that tool call against configuration A, the mode of the turn, and current owner grants and revocations
- **AND** configuration B SHALL NOT authorize or refuse that tool call

#### Scenario: A selection change does not interrupt the turn
- **WHEN** the owner changes the selected agent of an active session
- **THEN** the active turn SHALL continue without interruption
- **AND** no new turn, user message, or queued message SHALL appear in the session

#### Scenario: The console shows both agents
- **WHEN** the owner selects configuration B while a prepared request uses configuration A
- **THEN** the console SHALL show configuration B as the selection for future requests
- **AND** it SHALL show configuration A as the agent of the prepared request

#### Scenario: A revocation applies after a selection change
- **WHEN** the owner revokes a tool grant after the runtime prepared a request that offers that tool
- **THEN** a call to that tool SHALL be refused before dispatch
- **AND** the captured selection SHALL NOT restore the revoked grant

### Requirement: Critical-operation approvals bind exact execution

For an operation explicitly designated critical, the runtime SHALL preserve the requested operation, target, exact arguments or change, human decision, and execution outcome. Changed scope SHALL require new approval. Approval SHALL NOT authorize unrelated future operations or bypass normal permissions, sandbox constraints, or discussion mode. Replay, restart, and uncertain-execution behavior SHALL preserve the approved scope and SHALL NOT invent successful execution or broaden authorization.

An approval request SHALL identify the workspace, run, actor, existing operation identity, tool identity and definition digest, classification revision, execution-policy revision, target, and exact execution payload. Its request digest SHALL bind the complete scope, including workspace identity. The payload SHALL contain exact arguments or reference an immutable, digest-verified change artifact. Human review SHALL describe the same target and content used at execution. A change to any bound operation, target, arguments, artifact, or policy revision SHALL require a new request and approval. Creating a request SHALL NOT dispatch the critical operation and SHALL close workspace admission as specified below.

An immutable approval decision SHALL bind the reviewed request ID and digest, approve or reject verdict, deciding authority, and decision time. Rejection SHALL NOT be overwritten as approval. The runtime SHALL enforce one authoritative resolution for each request, including concurrent decisions. Approval requests and decisions SHALL use the existing PostgreSQL `runtime` schema and remain separate from execution records.

The runtime SHALL reuse existing operation identity and history rather than create a parallel operation tracker. Repeated approval submission SHALL NOT independently dispatch the operation again. History SHALL distinguish confirmed success, confirmed failure, and uncertain outcome. An uncertain outcome SHALL NOT be treated as failure merely to permit automatic retry. Each operation SHALL have at most one immutable approval scope. Changed scope SHALL require a new operation, not overwrite the earlier request. Approval submission SHALL use a separate owner interface, not an answer to a synthetic question.

The request digest SHALL cover a closed scope in the current strict schema for approval requests, with the runtime's canonical JSON encoding. Approval requests, decisions, and digest inputs SHALL NOT contain a numeric format, profile, or schema version field. Exact arguments or digest-verified argument artifacts SHALL supply execution. Trusted preparation SHALL derive targets and necessary file preconditions. Operations that cannot preserve exact reviewed content SHALL be refused. Redacted or incomplete content SHALL NOT be offered as an exact approval review.

#### Scenario: A critical operation's reviewed change is modified
- **WHEN** the human approved a critical operation with one change and the prepared change later differs
- **THEN** the runtime SHALL NOT execute the changed operation using the earlier approval
- **AND** the mismatch SHALL remain inspectable

#### Scenario: A resumed critical operation retains its approval scope
- **WHEN** a run resumes with a recorded critical-operation approval
- **THEN** the approval SHALL remain bound to the original operation, target, and arguments or change
- **AND** continuation SHALL NOT transform it into general write or communication permission

#### Scenario: A bound policy revision changes
- **WHEN** a proposed critical execution uses a different classification or execution-policy revision from its reviewed request
- **THEN** the runtime SHALL require a new request and approval
- **AND** the earlier decision SHALL remain associated with its original request digest

#### Scenario: Approval references a verified immutable change
- **WHEN** the owner reviews a critical request whose payload references a change artifact
- **THEN** the reviewed and executed content SHALL agree with the same immutable artifact and verified digest
- **AND** the runtime SHALL NOT substitute a later artifact at the same display path

#### Scenario: Concurrent decisions do not create contradictory outcomes
- **WHEN** concurrent approve and reject submissions target the same approval request
- **THEN** one authoritative resolution SHALL govern that request
- **AND** a rejection SHALL NOT be overwritten by an approval to make the operation executable

#### Scenario: Repeating approval does not independently dispatch twice
- **WHEN** the same approval submission is repeated for a request
- **THEN** the runtime SHALL preserve the request's authoritative resolution
- **AND** the repeated submission SHALL NOT independently dispatch the operation again

#### Scenario: Approval is not proof of execution
- **WHEN** an approval request exists or is approved but execution has not been confirmed
- **THEN** history SHALL distinguish the approval state from execution state
- **AND** it SHALL NOT report successful execution solely from approval

#### Scenario: An uncertain operation is not automatically retried as a failure
- **WHEN** the runtime cannot confirm the outcome of a critical execution attempt
- **THEN** it SHALL preserve the uncertain outcome under the operation lifecycle
- **AND** it SHALL NOT relabel the attempt as failed merely to permit automatic redispatch

#### Scenario: An approval request contains a schema version field
- **WHEN** the runtime reads an approval request or decision that contains a numeric format, profile, or schema version field
- **THEN** the runtime SHALL reject the record because it does not match the current strict schema
- **AND** it SHALL NOT compute the request digest under another format or execute the operation

### Requirement: Workspaces own shared execution environments

A workspace SHALL be a first-class runtime resource with a stable identity, persistent files, and an authoritative execution-policy revision. It SHALL own its sandbox environment. Runs and agent invocations SHALL attach to a workspace rather than own separate sandboxes by default. Several permitted invocations MAY share a workspace without merging identities, histories, independent run budgets, or tool permissions. The existing shared model-step budget within one run SHALL remain effective.

Agents within one workspace SHALL be treated as collaborators, not mutually isolated tenants. Work requiring isolation from other work SHALL use different workspaces. The runtime SHALL NOT promise conflict-free edits or add a general file-locking, automatic merge, or task-allocation system in this change. Infrastructure lifecycle coordination SHALL remain the runtime's responsibility. Workspace sharing SHALL NOT itself imply a new parallel scheduler.

A run SHALL identify its workspace through a simple reference. Its invocations SHALL use that workspace under its governing policy and SHALL NOT choose another through model-generated arguments. The runtime SHALL NOT require a separate attachment lifecycle record. Starting work SHALL NOT silently replace or widen workspace policy. Facet selections, discussion restrictions, owner grants, and critical approval requirements SHALL remain independently enforced. Cross-workspace agent discovery, communication, and delegation SHALL remain out of scope; owner management of several workspaces SHALL remain a separate authority.

#### Scenario: Several agents use one workspace
- **WHEN** several permitted invocations attach to the same workspace
- **THEN** their workspace operations SHALL use that workspace's authoritative sandbox and persistent files
- **AND** their actor identities, histories, tool permissions, and applicable run budgets SHALL remain distinct
- **AND** attaching SHALL NOT reset consumed model steps

#### Scenario: Different workspaces remain isolated
- **WHEN** two workloads use separate workspaces
- **THEN** their task storage and sandbox execution SHALL remain separate
- **AND** an attachment to one workspace SHALL NOT authorize access to the other

#### Scenario: An agent requests incompatible workspace policy
- **WHEN** an attachment would require policy different from the workspace's authoritative execution-policy revision
- **THEN** the runtime SHALL reject the incompatible attachment rather than silently reconfigure or widen the workspace
- **AND** existing active work SHALL retain its policy

#### Scenario: Discussion shares a workspace with writers
- **WHEN** a discussion invocation shares a workspace with task invocations permitted to write
- **THEN** discussion SHALL remain read-only with no task delegation or mode escape
- **AND** writable storage SHALL NOT grant the discussion invocation write permission

### Requirement: The first workspace sandbox backend is Docker

Each active workspace SHALL have at most one authoritative Docker sandbox instance. Concurrent provisioning or attachment SHALL NOT create competing instances. The runtime SHALL use an owner-controlled pinned image and validated policy. Task containers SHALL run non-root, without privileged mode, with dropped Linux capabilities, privilege escalation disabled, a read-only root filesystem, enforced resource limits, and writable access restricted to workspace storage and bounded temporary storage.

The initial profile SHALL disable task-container network access. Docker control, private runtime state, database credentials, and model-provider credentials SHALL NOT be available inside task containers. The model loop, database access, and approval enforcement SHALL remain outside task containers. Model requests and permitted remote tools SHALL remain under trusted runtime control. Unavailable sandbox support SHALL reject affected execution without fallback to the host.

Dev Container interpretation, Kubernetes, additional backends, and arbitrary repository-supplied lifecycle scripts SHALL remain out of scope for this first implementation.

#### Scenario: Concurrent workspace use provisions one sandbox
- **WHEN** several permitted invocations use a workspace that needs a sandbox
- **THEN** provisioning SHALL converge on at most one authoritative instance for that workspace
- **AND** invocations SHALL use their run's workspace rather than independently select competing containers

#### Scenario: A task container cannot access runtime authority
- **WHEN** task operations execute inside the workspace container
- **THEN** the container SHALL NOT have Docker control, runtime-state storage, database credentials, model-provider credentials, or direct network access under the initial profile
- **AND** permitted remote actions SHALL use the trusted runtime's normal permission and critical-approval checks

#### Scenario: Required sandbox support is unavailable
- **WHEN** the required Docker sandbox cannot be provisioned or used
- **THEN** the runtime SHALL reject affected execution explicitly
- **AND** it SHALL NOT silently execute the task on the host

### Requirement: Workspace lifetime is independent of runs and containers

Workspace files SHALL use persistent storage separate from the disposable container. Finishing or cancelling one run SHALL NOT delete the workspace or stop infrastructure still used by another invocation. Stop, recreation, and explicit owner-controlled deletion SHALL be separate lifecycle operations. The runtime SHALL coordinate them with attachments and SHALL NOT delete, replace, or change policy beneath active work.

Stopping or recreating a sandbox SHALL use the existing persistent workspace files without promising preservation of running processes or temporary state. A workspace record SHALL identify its storage, execution-policy revision, and sandbox reference. Runs SHALL reference that workspace in PostgreSQL; file contents SHALL remain in workspace storage. The runtime SHALL NOT require separate sandbox-generation or attachment lifecycle records. It SHALL prevent competing creation and teardown beneath active work as implementation safeguards.

The runtime SHALL NOT automatically snapshot, restore, roll back, synchronize, merge, or commit workspace files. Git save points SHALL be explicit owner or authorized-agent actions. This version SHALL NOT introduce automatic idle-stop or workspace deletion. Retained agent and tool definitions, PostgreSQL run records, execution checkpoints, and approval records SHALL remain intact. Execution continuation SHALL NOT imply that workspace files were rewound.

#### Scenario: One run finishes while another still uses the workspace
- **WHEN** one attached run finishes or is cancelled while another invocation remains active
- **THEN** cleanup SHALL NOT stop their shared infrastructure or delete the workspace
- **AND** the remaining invocation SHALL retain its attachment and permissions

#### Scenario: A stopped workspace gets a replacement container
- **WHEN** an authorized lifecycle operation replaces a sandbox after coordinating active work
- **THEN** workspace identity and designated persistent files SHALL remain
- **AND** the runtime SHALL NOT claim that background processes or temporary state were restored

#### Scenario: Restart uses current files without filesystem recovery
- **WHEN** a workspace container restarts after files changed since an earlier Git commit or execution checkpoint
- **THEN** it SHALL use the existing persistent files rather than automatically restore an earlier filesystem state
- **AND** retained runtime execution records SHALL remain distinct from those files

#### Scenario: Finishing work does not create automatic save points
- **WHEN** agent work finishes or the workspace becomes idle
- **THEN** the runtime SHALL NOT automatically commit, snapshot, restore, stop, or delete the workspace
- **AND** an owner or permitted agent MAY create an explicit Git save point under normal tool rules

#### Scenario: Deletion cannot race active execution
- **WHEN** the owner requests deletion while a workspace has active execution or concurrent attachments
- **THEN** lifecycle coordination SHALL prevent deletion underneath that work
- **AND** finishing a run alone SHALL NOT count as authorization to delete the workspace

#### Scenario: Shared edits cannot change an approved critical operation
- **WHEN** one agent changes workspace files after a critical operation's arguments or change artifact were approved
- **THEN** execution SHALL use the exact immutable approved content or require a new approval if the proposed content changes
- **AND** the runtime SHALL NOT substitute current file bytes merely because the path is unchanged

### Requirement: Critical approvals hold all new agent work in their workspace

When a critical operation requires approval, the orchestrator SHALL record the request and close admission for new agent work in that workspace before the critical operation can execute. Closure SHALL be authoritative across every invocation and run using that workspace and SHALL prevent new work racing past the gate. It SHALL block new model requests, tool calls, delegations, and discussions, not only writes. Owner approval controls and necessary runtime bookkeeping SHALL remain available.

Already-started leaf effects MAY finish under existing timeout, cancellation, and outcome rules. Their results SHALL NOT trigger further agent work while the gate is closed. The runtime SHALL wait for those effects to settle before reporting readiness for approved critical execution. Suspended discussion or delegation wrappers SHALL NOT count as active effects that prevent drain. The requested critical operation SHALL remain unexecuted until individually authorized. This barrier SHALL NOT imply filesystem snapshotting, freezing, or rollback.

#### Scenario: Gate closure precedes drain
- **WHEN** a critical request and another proposed operation race in the same workspace
- **THEN** closure SHALL prevent admission of work after the gate closes
- **AND** only work already admitted as started under the execution contract MAY settle
- **AND** the critical request SHALL NOT execute merely because it caused the hold

#### Scenario: In-flight results do not restart the agent loop
- **WHEN** a previously started model request or tool call completes while its workspace is held
- **THEN** the runtime MAY record its result
- **AND** the result SHALL NOT dispatch another model request, tool call, discussion, or delegation until admission reopens

#### Scenario: All runs in a workspace share the hold
- **WHEN** one agent requests critical approval in a workspace shared by several runs
- **THEN** all agents using that workspace SHALL stop admission of new work, including read-only tools
- **AND** another agent or run SHALL NOT bypass the hold

#### Scenario: Another workspace remains independent
- **WHEN** Workspace A has a pending approval and Workspace B has otherwise permitted work
- **THEN** A's queue and gate SHALL NOT block B's work
- **AND** agents in A SHALL NOT use discovery, communication, or delegation into B to escape A's hold

### Requirement: Workspace holds resolve through individual approvals

Approving one request SHALL NOT approve or resolve another. After already-started work settles, the orchestrator MAY execute only an individually approved critical operation while ordinary admission stays closed. At most one approved critical operation SHALL execute at a time per workspace. Rejected requests SHALL NOT execute. All normal tool, mode, resource, and policy checks SHALL remain effective.

Ordinary work SHALL remain blocked while requests are unresolved or authorized critical execution is active. Once all requests are resolved and authorized critical work has finished, the orchestrator MAY reopen admission subject to existing permissions and terminal-state rules. Confirmed failures SHALL remain recorded without silent retry. An uncertain outcome SHALL keep the workspace held until explicit owner resolution. Restart SHALL NOT silently clear the hold. The owner resolution SHALL remain separate from runtime outcome evidence and SHALL NOT authorize another execution.

#### Scenario: One approval leaves the other requests pending
- **WHEN** several critical requests exist in a held workspace and the owner approves one
- **THEN** only that reviewed operation MAY execute after in-flight work settles
- **AND** all other requests SHALL still require their own decisions
- **AND** ordinary workspace work SHALL remain blocked

#### Scenario: Approved critical operations do not run concurrently
- **WHEN** more than one request has approval in the same workspace
- **THEN** the orchestrator SHALL execute at most one approved critical operation at a time
- **AND** it SHALL NOT reopen ordinary admission between them while approved work remains active or requests remain unresolved

#### Scenario: Ordinary work resumes after the hold is resolved
- **WHEN** all approval requests are resolved, authorized critical execution has finished, and no uncertain outcome awaits owner resolution
- **THEN** the orchestrator MAY reopen ordinary workspace admission
- **AND** terminal or otherwise unauthorized runs SHALL NOT resume merely because the workspace gate reopened

#### Scenario: Uncertain execution retains the workspace hold
- **WHEN** the result of critical execution is uncertain
- **THEN** the workspace SHALL remain held until explicit owner resolution
- **AND** the runtime SHALL NOT silently retry the operation or clear the hold on restart

### Requirement: Workspace admission is durable across executor boundaries

Workspace admission SHALL be authoritative in PostgreSQL under the existing owner fence. Ordinary admission SHALL atomically check the gate and record the model attempt or operation intent with its active-effect membership. Critical request creation SHALL atomically close that same gate and retain its immutable scope before execution. Process-local locks alone SHALL NOT establish the workspace boundary.

Only work admitted before closure MAY complete an already-authorized handoff. Such work SHALL remain in the drain set until its effect stops and durable settlement is confirmed. Suspended callers SHALL NOT be active effects. Lost ownership, timeout, or uncertain storage SHALL NOT prove settlement. The gate SHALL reopen only after all effect, request, and critical-execution predicates permit it.

An unresolved ordinary effect SHALL also close workspace admission, even when no critical request exists. This recovery hold SHALL use the unresolved-effect interface rather than a fabricated approval request.

#### Scenario: Admission wins a race with closure
- **WHEN** an ordinary effect commits admission before a critical request closes its workspace gate
- **THEN** its recorded membership SHALL be visible to drain
- **AND** the workspace SHALL NOT report readiness until that effect is confirmed settled

#### Scenario: Closure wins a race with admission
- **WHEN** gate closure commits before another operation's admission
- **THEN** the later operation SHALL receive no dispatch permission or model-step reservation
- **AND** it SHALL remain suspended without a fabricated tool refusal

#### Scenario: A process restart leaves an external intent unresolved
- **WHEN** an executor stops after an external dispatch intent but before confirmed settlement
- **THEN** restart SHALL retain the unresolved effect and any workspace hold
- **AND** it SHALL NOT resend merely because no response was recorded

### Requirement: Owner outcome resolution does not invent execution evidence

An unresolved effect SHALL retain workspace admission closure until explicit owner resolution. Resolution SHALL identify the exact unresolved effect and observed outcome digest. The owner SHALL stop the old executor and establish that no local or remote execution remains active before resolution. If this cannot be established, the hold SHALL remain.

The runtime SHALL record the owner's screened evidence and assertion separately from the original runtime outcome. The assertion MAY confirm an effect, confirm no effect, or acknowledge an unknown outcome after execution stopped. Resolution SHALL NOT rewrite recorded results, fabricate advice, refund model work, or authorize a retry. It SHALL be immutable, conflict-checked, and idempotent for equal submission identity.

#### Scenario: The owner accepts an unknown outcome after stopping execution
- **WHEN** the owner establishes that execution stopped but its effect remains unknown
- **THEN** the owner MAY record an acknowledged-unknown resolution for that effect
- **AND** the original operation SHALL remain visibly uncertain
- **AND** no tool call SHALL be dispatched by that resolution

#### Scenario: A stale executor might still act
- **WHEN** a new owner epoch exists but termination of an earlier executor is not established
- **THEN** the runtime SHALL NOT treat the epoch change as proof that external work stopped
- **AND** the workspace hold SHALL remain unresolved

#### Scenario: Rejection or cancellation occurs before dispatch
- **WHEN** a critical request is rejected or its run loses permission before dispatch intent
- **THEN** the operation SHALL close with a recorded non-execution result
- **AND** it SHALL NOT occupy a critical execution slot or fabricate a human decision

### Requirement: A workspace hold preserves resumable execution without a question

The runtime SHALL provide a nonterminal held state with a verified saved continuation binding. Its checkpoint chain SHALL retain owning run, session, execution turn, parent operation, mode, depth, pending dispatch, execution definition, captured agent selection, and frozen eligible skill membership. Hold publication and invocation settlement SHALL be atomic after checkpoint persistence is confirmed. A failed checkpoint write SHALL NOT be presented as a resumable hold. A suspended turn SHALL keep its session occupied until its actual work and completion are settled.

Reopening SHALL resume eligible held work through one owner-fenced invocation claim. The runtime SHALL verify the entire retained caller chain before dispatch. A temporary verification failure SHALL leave work held. A confirmed incompatibility SHALL fail without executing the graph as a check. Waiting SHALL NOT consume model steps or publish synthetic owner questions.

Existing owner questions SHALL remain answerable during a workspace hold. An accepted answer SHALL retain its normal identity and schedule held continuation rather than dispatch. Cancellation SHALL remain available. Nested task questions SHALL preserve the actual asker and complete ancestor chain.

#### Scenario: The workspace reopens after a durable pause
- **WHEN** a compatible held run becomes eligible after its workspace gate reopens
- **THEN** one executor SHALL claim the saved continuation and resume the same logical work
- **AND** it SHALL NOT duplicate a child actor, completed operation, or consumed model step

#### Scenario: The owner answers while another run holds the workspace
- **WHEN** a valid answer arrives for a waiting task while the shared workspace gate is closed
- **THEN** the runtime SHALL accept the answer under its normal question identity and continuation checks
- **AND** further execution SHALL remain held until workspace admission permits it

### Requirement: Submitted workspace and entry choices have stable retry identity

New start requests SHALL name an owner-registered workspace ID. They MAY name an eligible entry agent and explicit step budget. Omitted choices SHALL remain distinct from explicit values in the submitted identity. The runtime SHALL NOT accept host paths, policy overrides, or model-selected workspace changes as start choices.

After structural and credential screening, accepted-request lookup SHALL precede current configuration and admission checks. Equal accepted retries SHALL return their original run. Changed submitted input SHALL conflict. Final acceptance SHALL recheck the workspace gate, governing policy, and observed selection state atomically with run creation and its retained records. Request identity SHALL use one current formula. The runtime SHALL NOT keep an identity formula from an earlier record format.

#### Scenario: Submitted budget changes under an existing request ID
- **WHEN** an accepted request ID is reused with a different explicit budget or omission state
- **THEN** the runtime SHALL return a request conflict rather than create or modify a run

#### Scenario: The workspace closes after preflight
- **WHEN** a valid candidate run completes preflight but its workspace gate closes before acceptance
- **THEN** final acceptance SHALL refuse the candidate without accepted run or actor records
- **AND** preflight success SHALL NOT count as dispatch authority

#### Scenario: A run without selected facets retains a binding
- **WHEN** the runtime accepts a new run whose agents select no facets
- **THEN** the runtime SHALL retain a capability binding that identifies no installation and contains no installed definitions
- **AND** acceptance SHALL NOT read an installation or start MCP discovery
- **AND** subsequent configuration changes SHALL NOT replace that accepted context

### Requirement: Large inspection views preserve their committed history boundary

Run capability inspection SHALL keep a committed history watermark across paginated plans, actors, definitions, and usage. Earlier pages SHALL NOT use later mutable actor outcomes. Cursor validation SHALL bind run, collection, context, ordering, and watermark. Unavailable historical verification SHALL fail explicitly rather than combine inconsistent views.

Live workspace gate state and current revocation checks SHALL be labeled separately from historical run data. Ordinary run inspection SHALL expose the workspace and approval state of every run, including a run whose agents select no facets. No view SHALL infer tool execution from a human approval or instruction compliance from startup supply.

#### Scenario: A child completes after the first history page
- **WHEN** a child finishes after the owner obtained a capability view at an earlier watermark
- **THEN** later pages for that watermark SHALL retain the earlier child state
- **AND** the owner SHALL obtain a new view to observe the completed result

#### Scenario: A run without selected facets requires approval
- **WHEN** a run whose agents select no facets has a critical operation that waits for approval
- **THEN** ordinary run inspection SHALL show its workspace and approval state
- **AND** the absence of installed definitions SHALL NOT hide the hold

### Requirement: Runtime records use one current strict schema

The runtime SHALL accept one current format for each type of retained execution record. This rule SHALL apply to runs, events, checkpoints, snapshots, operations, approvals, and related records. A format selector SHALL NOT permit the runtime to accept an earlier format. The runtime SHALL refuse records that do not match the current format. It SHALL NOT convert, repair, or partly use those records.

#### Scenario: New records have no format selector
- **WHEN** the runtime writes a new run, event, checkpoint, snapshot, or operation record
- **THEN** the record SHALL match the current strict schema for its record type
- **AND** the record SHALL NOT contain a numeric format, profile, or schema version field

#### Scenario: A record in an earlier format is refused
- **WHEN** the runtime reads a run, checkpoint, or operation record that does not match the current strict schema
- **THEN** the runtime SHALL refuse to use that record and SHALL identify the affected run or record
- **AND** it SHALL NOT convert the record, use part of it, or continue work from it

#### Scenario: Current-format runs keep their execution guarantees
- **WHEN** a current-format run waits for an answer and the runtime restarts with the same current schema
- **THEN** replay, request idempotency, compatible continuation, the history watermark, and uncertain-outcome controls SHALL apply under their existing rules
- **AND** the run SHALL keep its retained definitions, grants, and policy revisions
- **AND** its recorded history SHALL remain inspectable

### Requirement: The current record schema does not change the API path

The removal of internal format selectors SHALL NOT change the `/api/v1` route prefix. Requests SHALL obey the current contracts defined by this change.

#### Scenario: A client uses the existing API path
- **WHEN** a client calls an existing `/api/v1` route after the change to one current record schema
- **THEN** the runtime SHALL handle the call under the current contract for that route
- **AND** the route SHALL NOT move to another version path

### Requirement: A development reset removes disposable runtime records

An explicit development reset SHALL remove disposable runtime records. These records SHALL include runs, events, checkpoints, snapshots, operation records, and the records that depend on them. The reset SHALL then create the current schema. It SHALL NOT run a migration that keeps data from the removed records.

#### Scenario: A reset leaves an empty current schema
- **WHEN** the owner runs an approved development reset with its exact targets identified
- **THEN** the targeted runtime records SHALL be removed
- **AND** the current schema SHALL exist with no run, event, checkpoint, snapshot, or operation records
- **AND** no data from the removed records SHALL be converted into the current schema

### Requirement: A development reset preserves owner and external data

A development reset SHALL NOT delete workspace files, source repositories, owner configuration, credentials, or upstream facet sources. It SHALL NOT change a database or service outside its approved targets. A reset SHALL NOT rewrite owner configuration or broaden agent selections, grants, or approvals.

The reset procedure SHALL distinguish owner configuration from disposable execution records, including when both use the same database. A shared storage location SHALL NOT authorize deletion of protected data.

#### Scenario: A reset keeps owner and external data
- **WHEN** an approved development reset completes
- **THEN** workspace files, source repositories, owner configuration, credentials, and upstream facet sources SHALL remain unchanged
- **AND** each database or service outside the approved targets SHALL remain unchanged

#### Scenario: Owner configuration errors remain after a reset
- **WHEN** owner configuration contains a superseded field and the owner completes a development reset
- **THEN** startup SHALL still refuse that configuration with its migration guidance
- **AND** the reset SHALL NOT rewrite the configuration or broaden selections or grants to make it valid

### Requirement: A development reset needs separate owner approval

The runtime SHALL NOT start a development reset automatically. A reset SHALL start only after the owner separately approves it and its exact targets are identified. Startup, an upgrade, or a record that does not match the current schema SHALL NOT cause a reset. Approval of a change or of a design decision SHALL NOT count as approval to reset a deployment.

#### Scenario: Startup finds a record in an earlier format
- **WHEN** the runtime starts and finds a runtime record that does not match the current strict schema
- **THEN** it SHALL refuse to use that record
- **AND** it SHALL NOT delete the record or start a reset

#### Scenario: A reset request lacks approval or exact targets
- **WHEN** a reset request has no separate owner approval or does not identify its exact targets
- **THEN** no record SHALL be deleted
- **AND** the refusal SHALL identify the missing approval or target

### Requirement: Work from before a reset does not continue

After a development reset, the runtime SHALL NOT resume, replay, or continue a run accepted before the reset. It SHALL NOT automatically retry a removed start request, answer, or operation. It SHALL NOT keep or apply the limits from removed runs. New work SHALL use the current configuration and rules.

The reset SHALL remove accepted-request identities with their runs. A later start submission SHALL undergo current admission checks as a new request. It SHALL NOT recover the removed run or its accepted-request status.

#### Scenario: An answer arrives for a removed run
- **WHEN** the owner submits an answer for a question from a run that the reset removed
- **THEN** the runtime SHALL refuse the answer and identify the run as unavailable
- **AND** it SHALL NOT start, reconstruct, or resume that run

#### Scenario: A client resends a request from before the reset
- **WHEN** a client resends a start request that the runtime accepted before a reset
- **THEN** the runtime SHALL NOT return the removed run or apply its retained definitions or limits
- **AND** the runtime SHALL evaluate the request as a new request under the current configuration and admission checks

### Requirement: Ordinary message content follows the common message-size policy

Ordinary message content SHALL include goals, command arguments, rendered goals, owner-question prompts, text answers, delegate tasks, discussion topics, and returned advice. The system SHALL NOT apply an independent size limit to ordinary message content. This rule SHALL also apply to a complete model message, a tool outcome, and the HTTP body of a route that submits ordinary message content. Authorization and administration routes SHALL keep their own limits.

The system SHALL keep its checks for valid encoding, storage validity, required nonblank values, strict objects, credential screening, and permissions. It SHALL NOT silently truncate, summarize, or omit message content. It SHALL NOT compress a conversation automatically.

A question MAY declare an answer-length constraint for the response format that it requests. The console SHALL show that constraint with the question. The system SHALL NOT apply a hidden universal size limit to answers.

This policy SHALL NOT remove facet content validation, startup-skill limits, identifier rules, approval-artifact limits, owner-evidence limits, execution budgets, deadlines, or sandbox resource limits. Intentional pages of workspace reads, workspace searches, and bundled skill references SHALL remain. These pages SHALL NOT act as a hidden limit on ordinary message content.

#### Scenario: A large goal is accepted complete
- **WHEN** the owner submits a nonblank goal larger than 100 KiB with valid encoding and no runtime-managed credential
- **AND** the input passes all other applicable checks, and the required transport, serialization, and storage operations succeed
- **THEN** the system SHALL accept the goal without a size-limit refusal
- **AND** the run history and the first model request SHALL contain the complete goal

#### Scenario: Large command arguments and delegate tasks stay complete
- **WHEN** a command run receives arguments larger than 100 KiB and its agent delegates a task larger than 100 KiB
- **AND** the input passes all other applicable checks, and the required transport, serialization, and storage operations succeed
- **THEN** the system SHALL NOT refuse the arguments, the rendered goal, or the delegate task because of size
- **AND** the delegate SHALL receive the complete task

#### Scenario: A large question and answer stay complete
- **WHEN** an agent asks a question with a prompt larger than 100 KiB and no answer-length constraint
- **AND** the owner submits a text answer larger than 100 KiB
- **AND** the input passes all other applicable checks, and the required transport, serialization, and storage operations succeed
- **THEN** the console SHALL show the complete prompt
- **AND** the system SHALL accept and deliver the complete answer

#### Scenario: A declared answer-length constraint applies
- **WHEN** a question declares an answer-length constraint and the owner submits a longer answer
- **THEN** the system SHALL refuse the answer and identify the declared constraint
- **AND** it SHALL NOT truncate the answer to make it fit

#### Scenario: Required checks still apply to large content
- **WHEN** large message content is blank, has invalid encoding, has an unknown field in a strict object, or contains a runtime-managed credential
- **THEN** the system SHALL refuse the content for that cause without a size-limit explanation
- **AND** it SHALL NOT echo or durably record the credential

#### Scenario: A long conversation is not compressed
- **WHEN** a run's recorded tool outcomes are larger than 100 KiB in total and the agent makes another model request
- **THEN** that request SHALL contain the complete recorded conversation
- **AND** the system SHALL NOT automatically summarize, truncate, or remove earlier messages

#### Scenario: Unrelated limits remain effective
- **WHEN** an agent's startup instructions exceed the documented startup limit, or a run exhausts its model-step budget
- **THEN** the system SHALL apply that limit under its existing rules
- **AND** it SHALL NOT report the result as a message-size refusal

### Requirement: The provider decides request capacity

The selected provider SHALL be the authority for context capacity and request capacity. Each subscription adapter SHALL manage authorization, endpoints, and the faithful adaptation of the request. It SHALL NOT apply an independent size policy to inference requests. A local estimate SHALL NOT reject input as over the context capacity unless a verified provider contract supports that check. Such a check SHALL measure the full adapted request, including instructions, history, tool definitions, and the output allowance. After a confirmed size or context rejection, the system SHALL NOT automatically send the unchanged request again.

#### Scenario: A large request goes to the provider
- **WHEN** a full adapted request for either provider is larger than 10 MiB and no verified provider contract supports a local capacity check
- **AND** the input passes all other applicable checks, and the required transport, serialization, and storage operations succeed
- **THEN** the system SHALL send the request to the selected provider
- **AND** it SHALL NOT refuse the request because of a local size limit or estimate

#### Scenario: The provider refuses a request that is too large
- **WHEN** the selected provider rejects a request with reliable evidence of a request-size or context-capacity cause
- **THEN** the run failure SHALL identify that cause and the affected provider operation
- **AND** the system SHALL NOT automatically send the unchanged request again

### Requirement: Provider rejections are reported faithfully

The system SHALL identify a request-size rejection, a context-capacity rejection, or another invalid-request rejection only from reliable evidence. Without reliable evidence, the rejection SHALL remain unclassified. An HTTP status alone SHALL NOT establish a context-capacity cause. The system SHALL also report empty responses, responses that are not JSON, network failures, and unknown failures. Reports SHALL NOT expose credentials, message content, or raw provider error bodies.

A serialization or storage failure SHALL NOT be reported as a provider rejection. A large request SHALL NOT be reported as an invariant violation. These reasons SHALL appear as the specific cause within the existing failure categories.

#### Scenario: A provider gives reliable context evidence
- **WHEN** a provider rejection contains a documented error type that identifies context capacity
- **THEN** the run SHALL fail with category "provider failure" and identify a context-capacity rejection
- **AND** the explanation SHALL NOT include the message content or the raw error body

#### Scenario: An HTTP status alone is not a context cause
- **WHEN** the provider rejects a request with HTTP status 400 and an empty body or a body that is not JSON
- **THEN** the system SHALL report an unclassified provider rejection with that status
- **AND** it SHALL NOT claim a context-capacity or request-size cause

#### Scenario: A network failure is not a provider rejection
- **WHEN** the connection to the provider fails before the system receives a response
- **THEN** the system SHALL report a network failure
- **AND** it SHALL NOT claim that the provider rejected the request for its size or context

#### Scenario: A local failure is not a provider rejection
- **WHEN** the system cannot serialize or store a large request or result
- **THEN** the failure SHALL identify the serialization or storage cause
- **AND** it SHALL NOT be reported as a provider rejection or an invariant violation

### Requirement: A failure keeps the accepted input

When a failure stops work, the system SHALL keep each input that it accepted before the failure. It SHALL keep uncertainty about acceptance and dispatch status under the existing replay rules. The console SHALL give a credential-safe explanation of the failure. It SHALL show that the accepted input remains recorded. The system SHALL NOT report a false success.

#### Scenario: A provider rejects a request after an accepted answer
- **WHEN** the provider rejects a request that contains an accepted owner answer
- **THEN** the answer SHALL remain recorded as accepted
- **AND** the console SHALL explain the failure and show that the answer remains recorded
- **AND** the run SHALL NOT be shown as successfully completed

#### Scenario: Acceptance of a large submission is uncertain
- **WHEN** the system cannot confirm whether it durably accepted a large goal or answer
- **THEN** it SHALL NOT confirm acceptance or report success
- **AND** a retry with the same submission identity SHALL obey the existing retry rules for that identity
- **AND** the system SHALL NOT report a size limit as the cause

### Requirement: Size and resource monitors operate before limits are removed

Size and resource monitors SHALL operate before the system stops the enforcement of a removed size limit. The monitors SHALL measure these values:

- Message size, by message type, failure stage, and failure reason.
- For each full adapted provider request: size, latency, status, normalized failure, and the token counts that the provider reports.
- The sizes of complete model messages and tool outcomes.
- The size, write duration, and write failures of serialized records and checkpoints.
- Host memory, concurrency, process restarts, and out-of-memory terminations.

If the provider does not report token usage, the monitors SHALL record the usage as unknown, not as 0. Telemetry SHALL NOT contain a duplicate message body, credentials, or raw error bodies. Metric labels SHALL NOT contain message content or run identities.

The owner SHALL be able to inspect size distributions and correlate them with the failure stage. Host monitor data SHALL remain available after the runtime process stops, including after an out-of-memory termination. It SHALL NOT depend on a final write from a process that stops. The monitors SHOULD measure bytes that are already serialized and SHOULD NOT make a full copy only for measurement. The monitors SHALL NOT automatically add a limit.

#### Scenario: Monitors are available before removed limits stop
- **WHEN** a deployment changes to a version without the removed size limits
- **THEN** before removed limits cease enforcement, instrumentation, collection, owner inspection, and independent host monitoring SHALL be operational
- **AND** measurements SHALL become available as the corresponding operations occur

#### Scenario: The owner inspects size distributions
- **WHEN** runs with different message types and failures have occurred
- **THEN** the owner SHALL be able to see the size distribution for each message type
- **AND** the owner SHALL be able to correlate each failure with its stage and reason

#### Scenario: The provider reports no token usage
- **WHEN** a provider response does not report token usage
- **THEN** the monitors SHALL record the token usage as unknown
- **AND** they SHALL NOT record the usage as 0

#### Scenario: Telemetry excludes content and credentials
- **WHEN** a monitored request contains a synthetic credential and known message text, and the provider returns an error body
- **THEN** telemetry SHALL contain no occurrence of the credential, the message text, or the raw error body
- **AND** no metric label SHALL contain message content or a run identity

#### Scenario: Host data remains after a process termination
- **WHEN** the host stops the runtime process because memory is exhausted
- **THEN** the owner SHALL be able to inspect the memory use, the restart, and the out-of-memory termination for that period
- **AND** that data SHALL NOT depend on a final write from the stopped process

#### Scenario: Monitors do not add a limit
- **WHEN** a measured size is larger than all earlier measured sizes
- **THEN** the system SHALL NOT refuse, truncate, or delay the content because of that measurement

### Requirement: A new size limit needs evidence and separate approval

A later application size limit SHALL have a documented provider or platform constraint, or a measurement, that supports it. It SHALL identify the protected resource, the unit, the boundary where it applies, and the error that the user sees. It SHALL need separate owner approval. Runtime and deployment defaults SHALL NOT silently create a removed limit again. Documentation SHALL identify each limit that a platform still enforces on ordinary message content.

#### Scenario: Supplied defaults do not create a removed limit again
- **WHEN** the owner uses the supplied runtime and deployment defaults and submits a goal larger than 100 KiB through the console
- **AND** the input passes all other applicable checks, and the required transport, serialization, and storage operations succeed
- **THEN** no runtime or deployment default SHALL refuse the goal because of its size
- **AND** documentation SHALL identify each platform limit that remains in effect

#### Scenario: A proposed limit lacks evidence or approval
- **WHEN** a new application size limit has no documented constraint or measurement, or has no separate owner approval
- **THEN** the system SHALL NOT enforce that limit

### Requirement: Capacity risk is stated without capacity claims

The owner accepts the risk that resource exhaustion can occur before a provider rejects a request. Documentation SHALL state this risk. Monitors SHALL NOT be presented as a guarantee of recovery or of unlimited capacity. Documentation and test reports SHALL NOT claim a capacity or maximum safe size without measurements that support the claim. Capacity experiments and live provider traffic SHALL need separate owner approval. Automated tests for this policy SHALL be deterministic and SHALL NOT need live provider authorization.

#### Scenario: Documentation states the accepted risk
- **WHEN** the owner reads the documentation for message sizes
- **THEN** it SHALL state that resource exhaustion can occur before a provider rejects a request
- **AND** it SHALL NOT claim a capacity or maximum safe size without measurements that support the claim
- **AND** it SHALL NOT present monitoring as a guarantee of recovery

#### Scenario: Policy tests stay deterministic
- **WHEN** the automated tests for this policy run
- **THEN** they SHALL use deterministic provider substitutes
- **AND** they SHALL NOT need live provider authorization

## MODIFIED Requirements

### Requirement: Run history records ordered activity

The console SHALL show each run's ordered conversation and progress history, including agent messages, tool activity and outcomes, human questions and accepted answers, cancellation requests, status changes, and the final outcome. Recorded status changes SHALL include their recorded times. The selected command and its credential-safe arguments, startup skill supply for each actor, on-demand skill loads and bundled reference reads, delegation starts and outcomes, MCP calls, and capability refusals SHALL appear in that history. Agent-originated activity SHALL identify the configured agent, actor, and facet contribution where applicable. Delegated activity SHALL identify its parent actor and depth. Startup skill supply SHALL precede the receiving actor's first model request and identify the skill, originating facet, and version.

New-session startup supply SHALL appear within its first turn's creation activity, not as separate per-skill events. That activity SHALL identify the session, turn, configured agent, and complete new-activation list with exact retained definition digests. A new session without startup skills SHALL show an empty list. A reused session's later turn SHALL identify its session without reporting another startup activation. Inspection SHALL retain the original skill provenance and distinguish startup supply from later on-demand loads. Recorded supply SHALL NOT prove provider delivery or model compliance.

The complete startup set and its creation history SHALL become visible atomically with the new session and its first turn. Recovery SHALL NOT duplicate that activity or accept a different startup set for the same creation identity. Later turn admission SHALL preserve the existing session's history and skill state without duplicating them.

History SHALL show each owner agent selection change for a session with its time, the earlier and new agent configurations, and the deployment-owner authority. Each model request SHALL identify the agent configuration that the runtime captured for it. Startup supply that a selection change causes SHALL appear before the first model request that contains it. That supply SHALL identify its turn and the selection change. History SHALL NOT present that supply as a tool call or as a new session.

History SHALL distinguish read-only discussion from task delegation, identify the responsible invocation and its mode, and show mode-based tool refusals. For each discussion turn, history SHALL identify the session, the turn, and the discussion ID. Consultation advice SHALL NOT be presented as evidence of a completed external action. Runtime history writes SHALL remain permitted during discussion.

History SHALL identify critical-operation requests, human decisions, and execution outcomes. A proposal or approval alone SHALL NOT establish that execution occurred. Existing agent identity, facet provenance, tool activity, credential-screening, and safe-projection contracts SHALL remain effective.

The console SHALL identify the workspace affected by a hold and distinguish settling in-flight work from waiting for individual approval. It SHALL keep each request and decision separately inspectable and SHALL NOT imply that one approval resolves the entire queue. An uncertain outcome keeping a workspace held SHALL remain visible, and the owner controls SHALL remain available.

#### Scenario: Status changes remain inspectable
- **WHEN** a run changes from active work to waiting for an answer and then back to active work
- **THEN** its history SHALL show both changes in order with their recorded times
- **AND** the question and accepted answer SHALL remain visible

#### Scenario: Follow delegated activity
- **WHEN** a run delegates a task and the delegate records messages, tool calls, a question, and a result
- **THEN** the history SHALL distinguish that delegation and its activity from the caller's activity
- **AND** separate invocations of the same named agent SHALL remain distinguishable
- **AND** a delegate's result SHALL NOT by itself be presented as the whole run's successful final outcome

#### Scenario: Follow discussion without implying task execution
- **WHEN** an agent consults another agent and receives advice
- **THEN** history SHALL identify the interaction as discussion and show the receiving invocation's read-only mode
- **AND** it SHALL NOT label the interaction as a delegated action or claim that recommended writes occurred
- **AND** any blocked mutation or task-delegation request SHALL remain inspectable
- **AND** history SHALL identify the session ID and discussion ID of the turn

#### Scenario: Follow sequential turns of one session
- **WHEN** a caller consults a new session and later consults the same session with a new topic in the same run
- **THEN** history SHALL show 2 turns with distinct discussion IDs and the same session ID
- **AND** each turn SHALL identify its caller and depth

#### Scenario: A busy refusal remains inspectable
- **WHEN** a discussion call is refused because its target session is busy
- **THEN** history SHALL show the refusal with the requested session ID and the busy reason
- **AND** it SHALL NOT show a turn in that session for the refused call

#### Scenario: Follow an agent selection change
- **WHEN** the owner selects configuration B for an active session and the next prepared request supplies a startup skill of B
- **THEN** history SHALL show the selection change, the startup supply, and that model request in that order
- **AND** each model request SHALL identify the agent configuration that it used
- **AND** history SHALL NOT show a tool call for the startup supply

#### Scenario: Follow skill and MCP use
- **WHEN** a run loads a skill and calls an approved MCP tool
- **THEN** the history SHALL identify the skill load, the tool and server, and their originating facet versions
- **AND** it SHALL show the tool's recorded outcome, including a refusal, failure, or uncertainty rather than only successful output

#### Scenario: Capability activity is recorded in order
- **WHEN** a command run loads a skill, delegates a task, the delegate calls an approved tool and returns, and the caller finishes
- **THEN** the history SHALL show command selection, skill load, delegation start, the delegate's tool call and outcome, delegation end, and the final result in that order

#### Scenario: Goal-run startup activity is ordered
- **WHEN** a goal run preloads an entry-agent skill, later loads another skill on demand, and delegates to an agent with its own startup skill
- **THEN** run creation history SHALL include the entry actor's startup list before its first model request
- **AND** delegation start history SHALL include the delegate's startup list before its first model request
- **AND** the on-demand load SHALL appear when it occurs, separately from each actor's startup list

#### Scenario: Startup creation is atomic
- **WHEN** persistence fails during actor creation or startup preparation
- **THEN** no executable actor with a partial startup set SHALL become visible
- **AND** history SHALL NOT report successful actor creation with an incomplete startup list

#### Scenario: Creation replay preserves startup history
- **WHEN** recovery repeats actor creation with the same identity and startup set
- **THEN** the runtime SHALL reuse the recorded actor, startup set, and creation activity
- **AND** it SHALL NOT add duplicate startup history or supply duplicate instructions

#### Scenario: Creation replay changes the startup set
- **WHEN** a repeated creation identity has a different startup list or retained definition digest
- **THEN** the runtime SHALL reject the conflict
- **AND** it SHALL NOT replace the recorded startup set or dispatch the conflicting actor

#### Scenario: Child startup refusal remains inspectable
- **WHEN** a child's startup skill is unavailable or fails a prerequisite check
- **THEN** refusal history SHALL identify the safe target reference, affected skills, and reason
- **AND** the refused result and parent-operation completion SHALL become visible atomically with that history
- **AND** no executable child or startup membership SHALL be created
- **AND** the refusal alone SHALL NOT fail the containing run

### Requirement: Start a run from an installed command

The owner SHALL be able to start a run from the browser console using an installed facet command available to the selected entry agent, its arguments, and a subscription provider. The system SHALL validate the command's supported input requirements and explicitly declared prerequisites within that agent's selected capabilities before dispatching work. It SHALL record the entry agent, selected command, submitted arguments, and resulting task goal. Command arguments SHALL be treated as owner input, not as authority to execute shell commands. A command SHALL supply task instructions and applicable narrowing constraints, not additional facet selections, delegation relationships, or grants.

Command availability SHALL use the agent selected under the entry policy. Selecting a command SHALL NOT change the entry agent or bypass entry eligibility.

Goal runs SHALL remain available whether or not runtime facets are installed, with capabilities resolved from the same consuming configuration rather than gated by command selection.

#### Scenario: Select a command and begin its task
- **WHEN** the owner selects a supported installed command available to the entry agent and supplies valid arguments
- **THEN** the system SHALL create an identifiable run using that command's instructions and supplied arguments
- **AND** the console SHALL show the command, its originating facet and version, the task goal, workspace, and selected provider
- **AND** a command that requires no arguments SHALL NOT require an unrelated free-form goal

#### Scenario: A command does not switch the entry agent
- **WHEN** a command is unavailable to the selected entry agent but available to another agent
- **THEN** the console SHALL NOT offer it as available for the selected agent
- **AND** a direct start request for that command SHALL be refused under the selected agent's admission checks
- **AND** the runtime SHALL NOT switch to the other agent to make the command available

#### Scenario: Refuse an unusable command selection
- **WHEN** the selected command is missing, outside the entry agent's selections, requires unsupported behavior, has an explicitly declared required contribution unavailable to that agent, or receives arguments that violate its declared constraints
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
- **AND** the run SHALL use the entry agent's configured capabilities and effective permissions without gaining additional selections, delegation relationships, or grants

### Requirement: A run keeps its original capability definitions

Every accepted goal or command-started run SHALL retain, through its capability snapshot and run binding, its entry-agent identity, independent agent configurations, outgoing delegation relationships, execution limits, startup choices, and exact contribution definitions made available at acceptance. Retained definitions SHALL include instructions, skills, commands, permission restrictions, and MCP declarations where applicable. Facet updates, removal, or subsequent configuration changes SHALL NOT replace them during that run, including first use by a nested delegate or after a human pause or compatible restart. Retaining a definition or relationship SHALL NOT itself bypass permission checks.

Retention SHALL cover the configured discussion catalog, including targets outside task-delegation relationships, under the discussion requirements above. It SHALL preserve explicit tool policy, sandbox and resource constraints, and critical-approval requirements. Action-specific approval records SHALL remain distinct from immutable definition snapshots. A resumed discussion SHALL retain its restrictive mode rather than acquire unrestricted task permissions. First use SHALL NOT substitute current deployment definitions.

A run whose agents select no facets SHALL use the same capability snapshot and run binding. That binding SHALL identify no installation and contain no installed definitions. Acceptance of that run SHALL NOT read an installation or start MCP discovery. The runtime SHALL NOT keep a special unbound path or a separate configuration record for native goal runs. The binding MAY retain native tool policy where necessary, but it SHALL NOT present native tools as MCP records. The runtime SHALL NOT convert earlier records of unbound runs; the development reset rules apply to them.

Retained classification and execution-policy bindings SHALL identify immutable revision IDs. They SHALL NOT contain a schema version field. Editing current policy SHALL NOT overwrite revisions retained by accepted runs or approval requests. Current independent owner revocations and compatibility checks SHALL still constrain continuation and execution.

Tool-policy retention SHALL preserve the structured tool identity and reviewed definition digest associated with a classification. A changed deployment definition SHALL NOT inherit classification merely because its tool name is unchanged. Classification SHALL remain distinct from independent server and tool approvals and from action-specific critical-operation approval.

Each exposed name SHALL reference its exact retained tool identity. Native tools SHALL use `tool__<name>` and facet tools through MCP SHALL use `facet__<server>__<name>`. Dispatch SHALL NOT infer an origin from a name split at `__` or substitute another origin.

An accepted run SHALL retain each deduplicated tool's installation-selected origin, facet identity and installed version, applicable classification, and reviewed definition digest. A later installation selecting another origin SHALL NOT replace those retained records. Current independent owner revocations and continuation checks SHALL remain effective.

Run snapshots and bindings SHALL NOT contain or enforce a delegation-call limit. They SHALL retain the maximum delegation depth and applicable run-wide budget contract. Storage defaults SHALL NOT add a delegation-call limit to a run.

Retained agent configurations SHALL NOT have a separate fixed count limit. A retained snapshot SHALL NOT have a fixed aggregate size limit. The runtime SHALL keep the exact snapshot content and its integrity check. Facet content validation, startup-instruction limits, and identifier rules SHALL remain effective. A serialization or storage failure SHALL produce an explicit error that identifies that failure, without truncation, omission, or substitution. These failures SHALL NOT be presented as an agent-count cap or a size limit.

Retained definitions SHALL remain subject to runtime compatibility checks and current owner grants. Configuration guidance SHALL identify the compatibility rules for configuration and for continuation of current-format runs. Incompatible saved runs SHALL NOT be silently reinterpreted as new selections or replacement definitions. Removing an agent's facet selection, startup designation, or configured delegation relationship SHALL affect newly accepted runs rather than replace retained configuration. Revoking an independent server approval or tool grant SHALL still constrain an accepted run's later dispatch. Configuration removal SHALL NOT be presented as independent permission revocation. An owner agent selection change for a session SHALL choose only from the configurations retained for its run. It SHALL NOT change those retained configurations.

#### Scenario: Update a facet while a run is in progress
- **WHEN** a facet is updated after a run starts and that run later loads a skill or invokes an agent it has not used before
- **THEN** the run SHALL use the definitions originally made available to it
- **AND** a newly accepted run SHALL be able to use the updated installation without changing the older run

#### Scenario: A later installation selects another tool origin
- **WHEN** a run retains a deduplicated tool from one explicitly selected origin and a later installation selects a different origin
- **THEN** the accepted run SHALL retain its original origin reference, classification, and reviewed definition digest
- **AND** compatible continuation SHALL NOT substitute the new installation's classification
- **AND** current independent owner revocations SHALL continue to constrain dispatch

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
- **WHEN** a goal run is waiting for an answer and the owner changes agent selections, startup choices, or delegation relationships before an otherwise compatible restart
- **THEN** continuation SHALL use the run's original entry identity, configurations, relationships, limits, and startup definitions at every delegation depth
- **AND** newly accepted runs SHALL use the changed configuration
- **AND** broader new grants or selections SHALL NOT expand the older run's authority

#### Scenario: Retry a goal start after configuration changes
- **WHEN** a goal run was accepted, its acknowledgement was lost, and the owner retries the same creation request after a configuration or installation change
- **THEN** the system SHALL return the original run with its retained selections and definitions
- **AND** it SHALL NOT accept a replacement run or reinterpret the accepted goal using the new configuration

#### Scenario: The runtime cannot safely interpret a current-format waiting run
- **WHEN** the runtime determines that a waiting current-format run's saved selections or definitions are incompatible
- **THEN** it SHALL refuse continuation as "continuation unavailable" before accepting the answer or dispatching work
- **AND** it SHALL preserve the recorded question and history without applying new configuration to reconstruct the run

#### Scenario: Saved state in an earlier format does not continue
- **WHEN** a waiting run's saved state does not match the current strict schema
- **THEN** the runtime SHALL refuse continuation as "continuation unavailable" before accepting the answer or dispatching work
- **AND** it SHALL NOT decode, convert, or reinterpret that state with current agent configurations

#### Scenario: New runs have no delegation-call limit
- **WHEN** the runtime accepts a new run under the current configuration
- **THEN** the run SHALL use its depth limit and run-wide model-step budget without a separate delegation-call limit
- **AND** storage defaults SHALL NOT add a delegation-call limit to the run

#### Scenario: Retention has no agent-count or aggregate size cap
- **WHEN** an otherwise valid new run needs retained configurations for more than 32 agents with a total snapshot larger than 16 MiB
- **AND** the input passes all other applicable checks, and the required transport, serialization, and storage operations succeed
- **AND** each definition passes its own validation
- **THEN** retention SHALL NOT reject the run because of the number of agents or the total snapshot size
- **AND** the retained snapshot SHALL keep the exact content and pass its integrity check when the run reads it

#### Scenario: Snapshot storage fails
- **WHEN** a serialization or storage failure prevents retention of a new run's snapshot
- **THEN** the runtime SHALL reject the run explicitly and identify that failure
- **AND** it SHALL NOT truncate, omit, or substitute definitions or report a size limit as the cause

#### Scenario: First discussion use occurs after a configuration change
- **WHEN** an accepted run first consults an agent after that agent's deployment configuration changes
- **THEN** it SHALL use the discussion definitions and applicable policy retained for the run
- **AND** the absence of a task-delegation relationship SHALL NOT justify substituting current deployment definitions

#### Scenario: A selection change uses the retained configuration
- **WHEN** the deployment configuration of agent B changes after the run was accepted, and the owner then selects B for a session of that run
- **THEN** the session SHALL use the configuration of B that the run retained
- **AND** current deployment definitions SHALL NOT replace it

#### Scenario: Compatible continuation preserves discussion restrictions
- **WHEN** a discussion invocation continues after a compatible restart or human pause
- **THEN** it SHALL remain in discussion mode with the retained definitions and applicable current restrictions
- **AND** continuation SHALL NOT enable mutating tools or task delegation for that invocation

#### Scenario: Compatible continuation preserves tool policy and critical approvals
- **WHEN** a run continues after a compatible restart or human pause
- **THEN** its retained tool policy, sandbox and resource constraints, and critical-approval state SHALL remain effective
- **AND** restarting SHALL NOT broaden approval scope or disable the discussion lock
- **AND** an unresolved workspace-wide hold SHALL remain effective across every run using that workspace
- **AND** continuation SHALL NOT restore or rewind workspace file contents

### Requirement: Run capability provenance remains inspectable

The console SHALL distinguish capabilities bound to a run from skills loaded at startup or on demand, agents invoked, and tools called. It SHALL distinguish configured agent identity from actor identity, parent actor, and depth. For each actor, the run SHALL identify its retained facet selections, contribution origins and versions, and effective permissions for permitted or refused work. Startup activation SHALL remain distinct from on-demand loading and SHALL NOT establish instruction compliance. This provenance SHALL remain inspectable after restart, configuration changes, or removal of installed facets. Retained provenance SHALL identify the responsible agent configuration and portable or explicit admission. Inspection SHALL NOT invent configuration provenance for a run.

Inspection SHALL distinguish discussion eligibility from task-delegation relationships and show the actual mode for each invocation. It SHALL identify each discussion session, its owning run, its turns, and their discussion IDs separately from configured agent identity. It SHALL show the selected agent configuration of each session and its owner selection changes. For each model request, it SHALL show the agent configuration and tool definitions that the request used. Read/write policy, critical designations, sandbox constraints, approvals, and refusal reasons SHALL remain distinct from mere capability availability. Run records SHALL NOT receive invented discussion or approval provenance. Ordinary agent, facet, and tool-use provenance SHALL remain inspectable.

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
- **WHEN** the owner inspects a completed goal run after changing agent configuration
- **THEN** the run SHALL show the selections and facet versions retained for its agents rather than substitute current configuration
- **AND** an absent command SHALL NOT hide skill, delegation, or MCP provenance

#### Scenario: Inspect several sessions of one configuration
- **WHEN** a run creates 2 sessions of one agent configuration and one session receives 2 turns
- **THEN** inspection SHALL show 2 session IDs with the same configured agent and owning run
- **AND** it SHALL show the 2 turns of the reused session as separate turns with exact turn identities and discussion IDs

#### Scenario: Inspect a session after an agent selection change
- **WHEN** a turn makes 2 model requests, the first with configuration A, and the owner selects configuration B before the second request
- **THEN** inspection SHALL show configuration A and its tool definitions for the first request
- **AND** it SHALL show configuration B and its tool definitions for the second request
- **AND** it SHALL show configuration B as the current selection of the session
- **AND** the recorded binding of the first request SHALL NOT change

#### Scenario: Owner inspects the sessions of a finished run
- **WHEN** the authorized owner inspects a finished run whose sessions remain retained
- **THEN** inspection SHALL show the history of those sessions
- **AND** inspection SHALL NOT make those sessions discussion targets for a later run
