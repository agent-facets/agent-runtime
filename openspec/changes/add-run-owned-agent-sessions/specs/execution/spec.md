# Spec Delta

## ADDED Requirements

### Requirement: A run starts at a configured entry agent

Each run SHALL identify its entry agent.

Goal and command starts SHALL use the separate validated entry policy. The console SHALL list only permitted entry agents and initially select the default.

An omitted entry choice SHALL use that default. An unknown or ineligible explicit choice SHALL be refused without fallback or model dispatch.

The runtime SHALL enforce eligibility independently of the console.

Selecting an entry SHALL choose an existing owner-managed configuration, not override its instructions, facets, startup skills, or task targets.

The same configuration SHALL apply when that agent receives delegated work, subject to invocation-specific restrictions.

Entry eligibility SHALL NOT grant delegation permission. A delegate-only agent SHALL remain available through permitted task relationships.

Supplied defaults SHALL preserve the native journey through an ordinary configuration, not a special root-agent type.

Repeated use of one configuration SHALL NOT merge distinct sessions or executions.

Accepted retries SHALL preserve the original run and entry identity before current policy checks.

#### Scenario: An omitted entry choice uses the default
- **WHEN** a new goal or command start omits entry selection and the policy is valid
- **THEN** the runtime SHALL use the configured default and its admission checks

#### Scenario: Select another permitted entry agent
- **WHEN** the owner selects an eligible non-default entry
- **THEN** the run SHALL use that agent rather than the default
- **AND** selection SHALL NOT edit either configuration or the entry policy

#### Scenario: A delegate-only agent is not an entry point
- **WHEN** an agent is outside the permitted-entry set
- **THEN** the console SHALL omit it from the entry selector
- **AND** direct starts naming it SHALL be refused without fallback or model dispatch
- **AND** otherwise permitted delegation SHALL remain available

#### Scenario: An explicit entry choice is unknown
- **WHEN** a new start names an unconfigured agent
- **THEN** the runtime SHALL refuse without substituting the default or dispatching model work

#### Scenario: Supplied defaults preserve the native journey
- **WHEN** the owner uses supplied defaults and submits a goal without entry selection
- **THEN** the ordinary default agent SHALL provide the existing confined native-tool journey
- **AND** admission SHALL NOT require installation access or MCP contact

#### Scenario: Start directly at an agent also used as a delegate
- **WHEN** an eligible configured agent starts a run and is also available as a task target
- **THEN** its depth-0 invocation SHALL use its own retained configuration
- **AND** it SHALL NOT require a separate root configuration or inherit a previous caller's selections

#### Scenario: Distinguish configured agents from invocations
- **WHEN** several task invocations or new sessions in a run use one configuration
- **THEN** their actor or session identities and execution provenance SHALL remain distinct
- **AND** new sessions SHALL retain their own instruction history
- **AND** delegates SHALL identify their parent and depth
- **AND** discussion turns SHALL identify their session, caller, and depth

#### Scenario: Retry an accepted start with an entry choice
- **WHEN** the owner retries the same accepted input and entry choice after configuration changes
- **THEN** the runtime SHALL return the original run and retained entry
- **AND** changed submitted entry input under that request identity SHALL cause conflict

#### Scenario: Retry an accepted start after the default changes
- **WHEN** an accepted request omitted entry selection and the default later changes
- **THEN** equal retry SHALL return the original run and entry identity
- **AND** accepted-request lookup SHALL precede current entry-policy lookup

#### Scenario: Retry after entry eligibility changes
- **WHEN** the accepted entry loses current entry eligibility and the owner retries the original request
- **THEN** the runtime SHALL return the original run before current eligibility checks
- **AND** the policy change SHALL NOT replace its retained entry identity

### Requirement: Goal runs use configured facet capabilities

For either supported subscription provider, a goal run SHALL make its entry agent's compatible, authorized capabilities available without requiring a command.

The agent SHALL be able to load selected skills, delegate through permitted relationships, and use approved MCP tools.

Goal and command runs SHALL share permission, budget, cancellation, question, and continuation rules.

At each permitted depth, delegates SHALL use their own retained configurations rather than inherit a caller's catalog or outgoing target list.

Availability SHALL remain subject to tool policy, resource restrictions, critical approvals, and interaction mode.

It SHALL NOT preload every available skill or authorize every installed agent as a task target.

Without capability configuration, the existing confined native journey SHALL remain available through the same capability-retention contract.

Goal text and start requests SHALL NOT override owner-managed selections or targets. Selecting an eligible configured entry SHALL NOT itself constitute a configuration override.

#### Scenario: Complete a facet-backed goal with either provider
- **WHEN** the owner selects either supported provider and submits a goal for an agent with a skill, permitted delegate, and approved MCP tool
- **THEN** the run SHALL be able to load the skill, delegate, use the tool, ask an owner question, and produce an inspectable result
- **AND** all operations SHALL remain within applicable execution controls
- **AND** no command or synthetic wrapper SHALL be required
- **AND** the provider binding and shared budget SHALL persist across delegation and continuation

#### Scenario: Use the real voice-to-text skill at startup
- **WHEN** the owner installs the published `voice-to-text` facet unchanged in the independent runtime installation
- **AND** the entry agent selects it and designates its skill for startup
- **AND** the owner submits a goal containing dictated text
- **THEN** the first model request SHALL include the installed instructions and submitted goal
- **AND** the run SHALL identify the skill's facet, version, and startup supply
- **AND** no runtime-specific author metadata or command wrapper SHALL be required

#### Scenario: A delegate has a different skill selection
- **WHEN** an entry agent using `voice-to-text` delegates to a configuration that does not select it
- **THEN** the runtime SHALL NOT automatically supply its body or catalog entry to the delegate
- **AND** a delegate load request SHALL be refused without obtaining the caller's loaded definition

#### Scenario: The same startup skill is configured independently
- **WHEN** two agents independently select `voice-to-text` for startup and one invokes the other
- **THEN** each new session SHALL receive its retained instructions before its first model request
- **AND** supply SHALL be attributed to the correct execution and configuration

#### Scenario: A goal uses bounded nested delegation
- **WHEN** a goal starts at Coordinator with maximum depth 2 and permitted targets lead through Reviewer to Researcher
- **THEN** both delegation steps SHALL be available subject to permissions, usability, and remaining budget
- **AND** Researcher SHALL NOT create a depth-3 child
- **AND** Reviewer MAY delegate again at depth 2 after return if the remaining controls permit it

#### Scenario: Continue native operation without capabilities
- **WHEN** the owner submits a valid goal without capability configuration
- **THEN** the existing workspace read, search, question, and result journey SHALL remain available
- **AND** the start SHALL NOT require installation access or MCP contact
- **AND** missing capability configuration alone SHALL NOT cause warning, failure, or wait
- **AND** the run SHALL retain a normal binding with no installation or installed definitions
- **AND** inspection SHALL show an ordinary goal run

### Requirement: Discussion invocations retain a read-only execution mode

The runtime SHALL keep discussion separate from task delegation when it creates or addresses an agent invocation.

The runtime SHALL set discussion mode before model or tool dispatch. It SHALL tell the agent about the mode.

A discussion SHALL NOT become executable task instructions for an unrestricted actor. The mode SHALL limit actual dispatch, not only the offered tools or the prompt text.

A further discussion that a discussion invocation causes SHALL keep the restriction.

Message content and returned advice SHALL NOT authorize task execution or mode changes. Each later action SHALL pass the normal execution checks of the recipient.

Discussion SHALL NOT bypass applicable owner access restrictions or run-wide resource controls.

The discussion tool SHALL have a fixed read-only, noncritical classification. That classification SHALL NOT grant authority to the operations in a turn.

The requirements that follow specify invocation, depth, accounting, sessions, turns, session ownership by the run, session state, owner agent selection, and replay.

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

Each task actor and each discussion turn SHALL receive a depth-awareness block from the runtime before its first model request.

Each later request of that actor or turn SHALL contain the same block.

The block SHALL show the retained mode, the current depth, the maximum depth, the remaining child levels, and the child interactions that the mode permits.

A later turn of the same session MAY receive a different block.

Compatible continuation SHALL rebuild the block from the same retained run, actor, and turn records. It SHALL NOT use changed deployment defaults or get the depth from conversation text.

The recorded prompt and the applicable execution-definition digest SHALL include the block.

A discussion turn SHALL receive its own block. It SHALL NOT copy the depth instructions of its caller.

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
- **WHEN** an idle session had an earlier turn at depth 2
- **AND** a caller at depth 0 in the same run starts a later turn under a retained maximum of 2
- **THEN** each request of the later turn SHALL contain a depth-awareness block for depth 1 with one remaining child level
- **AND** the block of the earlier turn SHALL NOT limit the later turn

### Requirement: A discussion returns one final result through its parent operation

The runtime SHALL offer the native discussion control tool `tool__Discuss`. Its input SHALL contain only `target` and `topic`.

The `target` SHALL have exactly one of two kinds:

- A `new` target SHALL contain only `kind: "new"` and `agentId`. The agent ID SHALL identify a configuration that the run retained.
- A `session` target SHALL contain only `kind: "session"` and `sessionId`. The session ID SHALL identify an existing session that the current run owns.

The `topic` SHALL be a nonblank, self-contained string. The runtime SHALL be able to store it. The common message-size policy SHALL apply to it, without a separate size limit.

The input SHALL contain only its strict fields. The runtime SHALL apply credential screening to it. The caller SHALL NOT supply a workspace, actor, mode, depth, checkpoint, provider, or budget override.

A successful call SHALL start one turn in the target session. The turn SHALL use the run and workspace of the caller. For a `new` target, the runtime SHALL create the session and its initial turn atomically.

The turn SHALL return screened final advice through the parent tool result. It SHALL NOT copy the conversation of the caller or attach to a live actor.

A successful result SHALL use the existing tool-outcome envelope: `outcome: "ok"` with `result: { discussionId, sessionId, agentId, text }`. Each consultation SHALL have its own operation, discussion ID, and result. Result attribution across owner selection changes remains part of the pending detailed design.

The discussion call SHALL be the only tool call in its model response. If a response mixes it with other calls, the runtime SHALL refuse every call in that batch without dispatch.

The caller SHALL wait for the result. This version SHALL NOT start background consultations or add a message bus. A later follow-up SHALL be a new operation. It MAY target the same session when that session is idle.

A session SHALL have a maximum of one active turn. A session SHALL stay busy while its turn waits for a child. Every session in the active waiting chain of the caller SHALL be busy, including the session of the caller.

The runtime SHALL claim an existing target session atomically, so that concurrent requests cannot start competing turns.

If the target session is busy, the runtime SHALL refuse the call with `discussion_target_busy`. It SHALL NOT queue the request, interrupt the active turn, or steer it.

If the target is unknown, owned by another run, not accessible, or otherwise unavailable, the runtime SHALL refuse the call with `discussion_target_unavailable`. This refusal SHALL NOT show the content or status of a session that the caller cannot access.

The runtime SHALL NOT refuse a `new` target because it names the agent configuration of the caller. Access checks and the other admission checks SHALL also apply to an idle session.

The answer of a turn SHALL complete the existing consultation. It SHALL NOT be a new call from the target to the caller.

The runtime SHALL release the session only after it durably records the terminal result of the turn. After that release, another permitted caller in the same run MAY consult the session.

A turn with unsettled work SHALL NOT make its session idle. Cancellation, uncertain storage, and unresolved external effects SHALL keep their existing rules.

The runtime SHALL NOT offer the discussion tool when the caller is at its retained maximum depth. Tool exposure SHALL NOT bypass the independent target, mode, permission, budget, or workspace-gate checks.

The result SHALL contain the final advice, not the child transcript. The runtime SHALL apply credential screening to the advice before it returns or records the advice.

The common message-size policy SHALL apply to the advice, without a separate advice size limit. The runtime SHALL NOT truncate, summarize, or omit part of the advice.

If a provider, transport, serialization, or storage failure occurs, the outcome SHALL identify that actual failure category. The runtime SHALL NOT report missing advice as a successful result.

Ordinary refusals and scoped failures SHALL identify their cause. They SHALL NOT pretend to give advice. Cancellation, budget exhaustion, storage failure, and uncertain dispatch SHALL keep their run-level meaning.

If a discussion needs clarification, it SHALL return that need to its caller. It SHALL NOT ask the owner directly. Ordinary task delegates SHALL still be able to ask owner questions. Approval controls for critical read-only leaf operations SHALL remain available.

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
- **WHEN** a caller receives advice from a session
- **AND** the caller then makes a new discussion call with a new topic and the same session ID
- **THEN** the runtime SHALL start a new turn in the same session with a new discussion ID
- **AND** the turn SHALL use the session's own prior conversation and the new topic
- **AND** the turn SHALL NOT receive the caller's conversation or the history of other sessions

#### Scenario: A follow-up to a new target creates another session
- **WHEN** a caller makes a new discussion call with a `new` target after it received earlier advice
- **THEN** the runtime SHALL create a different session for that call
- **AND** earlier discussion history SHALL NOT be copied into the new session

#### Scenario: Concurrent requests name the same idle session
- **WHEN** 2 requests for a turn in the same idle session arrive at the same time
- **THEN** a maximum of one turn SHALL start in that session
- **AND** the other request SHALL be refused with `discussion_target_busy`

#### Scenario: A busy session is refused without a queue
- **WHEN** a caller names a session whose turn is active or waits for a child
- **THEN** the runtime SHALL refuse the call with `discussion_target_busy`
- **AND** it SHALL NOT queue the request, interrupt the active turn, or add the topic to that turn

#### Scenario: A session becomes available after durable completion
- **WHEN** a turn completes and the runtime durably records its terminal result
- **AND** all work of the turn is settled
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
- **WHEN** a discussion request has a blank topic, an unknown field, or a target kind other than `new` or `session`
- **OR** it has a `new` target whose agent ID is not a retained agent configuration, or a runtime-managed credential
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

Discussions SHALL use the retained provider binding, owner invocation, and shared model-step budget of the run.

Each new child model request SHALL pass durable admission and consume a normal run step. The deployment model-request ceiling SHALL remain effective.

Tool argument validation, time limits, and process limits SHALL remain effective. Ordinary message content in tool arguments and common tool results SHALL obey the common message-size policy.

Session creation, turn start, startup supply, and result bookkeeping SHALL NOT create separate model charges. Discussion SHALL NOT add a new counter for total discussion calls or durable tool calls.

Each turn SHALL use the model-step budget of its run. Reuse of a session SHALL NOT create a new budget. Current grants, the workspace gate, and compatibility checks SHALL apply to each turn.

Each new discussion, model request, and tool call SHALL obey the workspace gate. A hold SHALL stop new dispatch. It SHALL NOT make a false refusal, owner question, or successful result.

Waiting SHALL NOT consume model steps. Parent operations SHALL keep their original identities while children wait.

A suspended discussion caller SHALL NOT block approval drain. Its session SHALL stay occupied while it waits. The runtime SHALL NOT hold a dispatch gate while it waits for the completion of a child.

#### Scenario: Discussion model work consumes the same run budget
- **WHEN** a caller and its nested consultations issue model requests
- **THEN** each new request SHALL consume the same run-level model-step budget and deployment ceiling
- **AND** the start of a consultation or the return from it SHALL NOT reset or duplicate that budget

#### Scenario: A reused session does not get a fresh budget
- **WHEN** a caller starts a later turn in an existing session of the same run
- **THEN** each model request of that turn SHALL consume the run-level model-step budget of that run
- **AND** the earlier use of the session SHALL NOT restore or add model steps

#### Scenario: A workspace hold is not a consultation failure
- **WHEN** a discussion has more work but its workspace gate closes
- **THEN** the runtime SHALL preserve its pending operation and checkpoint rather than manufacture a refusal or owner question
- **AND** resumption SHALL continue the same logical invocation under the normal admission and compatibility checks

### Requirement: Discussion context uses the target's retained definitions

Discussion targets SHALL come from the agent configurations that the run retained. These configurations include the configuration of the caller and configurations outside the task-delegation relationships.

A new session SHALL receive its retained instructions, eligible read-only tool descriptions, configured startup skills, runtime instructions, and the explicit topic.

A later turn of an existing session SHALL receive the prior conversation of the session and the new topic. A new topic alone SHALL NOT cause another startup activation or a duplicate insertion of a skill body.

No turn SHALL automatically receive the conversation of the caller, a sibling session, or another session. No turn SHALL automatically receive hidden reasoning or history from other sessions or runs.

Runtime instructions and offered tools SHALL agree with the mode and depth of the current turn.

The stored history of a session and the model context of a turn are different records. The runtime SHALL NOT automatically compact, summarize, or truncate the prior conversation of a session.

A new run SHALL NOT automatically receive session history from an earlier run in its model context.

A session SHALL use its selected agent configuration from the configurations that its run retained. Current deployment definitions SHALL NOT replace those retained definitions.

If the retained definitions of the selected configuration are not compatible with the current runtime, the runtime SHALL refuse the turn explicitly.

The facets and targets that the caller did not select SHALL NOT become denials for the target. The target SHALL use its own retained selections.

The mode-specific usability and startup checks of the target SHALL stay separate from task-mode usability. An invalid target SHALL have an inspectable reason, not an executable replacement definition.

Workspace reads SHALL use authorized current files. They SHALL NOT use filesystem snapshots or access to other workspaces.

Loaded skill history SHALL belong to the session. It SHALL identify the turn and the agent selection that loaded each skill.

Each model response SHALL freeze the eligible skill membership for the tool calls of that response, under the existing rule for reference reads.

Skill history from an earlier turn or an earlier agent selection SHALL NOT bypass the mode, the selected configuration, or the current grants of a later request.

Each accepted run SHALL retain a capability binding, including a run whose agents select no facets. The supplied single-agent default MAY consult a new session of its own agent configuration. The runtime SHALL NOT assume that the supplied default has no discussion target.

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

### Requirement: Discussion lifecycle and replay preserve one turn per operation

A discussion SHALL identify its target session and its distinct execution turn. History and replay SHALL record it as a discussion operation, not as a synthetic task delegation.

The identity of each turn SHALL come from the operation identity of the actual parent actor.

The target session, parent, mode, depth, input digest, and checkpoint namespace of a turn SHALL NOT change. Each model request of a turn SHALL keep the agent configuration that the runtime captured for it.

If an operation identity occurs again with different input, the runtime SHALL refuse it. It SHALL NOT start another turn.

Each session SHALL identify its owning run. That owner SHALL NOT change.

Each session lookup and each turn admission SHALL make sure that the current run owns the session. A session of another run SHALL NOT be found or admitted, also in a shared workspace. A session of a terminal run SHALL NOT admit a new turn.

Session creation, startup memberships, and the start event with its complete startup list SHALL commit atomically before the first turn executes.

The claim of an existing session SHALL commit atomically with the start of its turn.

If the runtime refuses a call before a turn starts, it SHALL complete the parent operation and the refusal history without an executable turn.

Turn completion SHALL atomically commit conversation changes, the terminal result, completion history, and the parent tool outcome before the caller sees them. Session release SHALL join that transaction only when all turn work is settled. The runtime SHALL NOT report an unconfirmed commit as a confirmed result.

Replay of a completed operation SHALL return the exact recorded outcome. It SHALL NOT add the topic to the session again, start a new turn, create a session, or call a model.

Active re-entry SHALL use the same turn and namespace.

Compatible continuation SHALL verify the full suspended ancestor chain without execution of the graph. It SHALL keep the session, mode, depth, retained definitions, the binding of each prepared request, and the loaded membership.

Current owner revocations and the workspace gate SHALL still limit new dispatch.

A record of work without a discussion SHALL NOT receive invented discussion provenance.

Session, turn, and selection records SHALL use the current strict schema. The runtime SHALL NOT add a format version or a decoder for an earlier format.

The session catalog in prompts and the owner selection route are approved. Conversation records, failed-turn reuse, checkpoint bindings, selection-related storage and result attribution, and owner-inspection transport still need complete contracts. These requirements SHALL NOT be read as proof that those contracts are ready for implementation.

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

Each session SHALL have an execution state of idle or active.

An active session SHALL identify its active turn and the existing owner epoch of that turn.

Inspection SHALL show if an active turn runs or waits. The runtime SHALL get that status from the existing records of the turn.

A turn that waits for a child, an approval, or an answer SHALL keep its session active.

The change from idle to active SHALL be atomic under the existing owner fence. Two competing turns SHALL NOT become active in one session.

A session SHALL become idle only after the runtime durably records the terminal result of its turn and all work of the turn is settled. An uncertain outcome SHALL keep the session active.

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

Each session SHALL keep an ordered conversation.

Each message SHALL have a stable ID and a position that is unique in the order of its session. Each message SHALL preserve its source execution or operation where applicable.

Messages SHALL keep the validated content of model messages and tool outcomes, including their recorded provider metadata.

A new turn SHALL bind the exact prior conversation of its session when the turn starts.

Replay and recovery SHALL NOT add a duplicate input message or output message.

The conversation of a session SHALL be a record separate from the execution checkpoint of a turn.

A new consultation SHALL start a new turn that uses the conversation of its session. Permitted continuation of paused work SHALL use its existing checkpoint and captured prepared-request binding. This rule SHALL NOT authorize continuation of terminal interrupted work.

An owner agent selection change SHALL NOT make continuation unavailable only because the selected agent changed. Prepared work SHALL keep its earlier binding. Later request preparation SHALL use the new selection.

Ownership checks, exact replay, and the rules for uncertain outcomes SHALL remain effective. The runtime SHALL NOT automatically repeat an external effect with an uncertain outcome.

The runtime SHALL NOT automatically compact the conversation.

#### Scenario: Replay does not duplicate messages
- **WHEN** recovery repeats an operation whose input and output messages are already recorded
- **THEN** the conversation SHALL contain each of those messages once
- **AND** each message SHALL keep its original ID and position

#### Scenario: A new turn binds the prior conversation
- **WHEN** a later turn starts in a session whose conversation contains 6 messages
- **THEN** the turn SHALL bind those 6 messages in their recorded order
- **AND** the turn SHALL NOT receive messages from another session

#### Scenario: Resumption after a selection change keeps the prepared binding
- **WHEN** a turn stops after the runtime prepared a request with configuration A
- **AND** the owner selects configuration B before resumption
- **THEN** resumption SHALL continue from the existing checkpoint with configuration A for that prepared request
- **AND** the next prepared request SHALL use configuration B
- **AND** the runtime SHALL NOT refuse continuation only because the selected agent changed

#### Scenario: Resumption does not repeat an uncertain effect
- **WHEN** resumption finds a tool call whose external effect has an uncertain outcome
- **THEN** the runtime SHALL NOT dispatch that tool call again automatically
- **AND** the uncertain outcome SHALL remain visible

### Requirement: An owner agent selection applies at the next model request preparation

Only the deployment owner MAY change the selected agent of a session. Agents and discussion callers SHALL NOT change it.

The owner MAY change the selection while the session is active. The new selection SHALL come from the configurations that the run retained.

When the runtime prepares a model request, it SHALL capture the latest committed selection. It SHALL assemble the instructions and tools of that request from the retained configuration of the captured selection.

A prepared request SHALL keep its captured selection for the request and for the tool calls in its response. A later agent selection SHALL NOT replace that captured configuration. Current owner revocations SHALL still constrain dispatch.

A change after capture SHALL apply to the next request preparation. If several changes occur before a capture, the latest committed change SHALL apply.

Current owner revocations SHALL still apply to each request and each tool call.

A selection change SHALL NOT interrupt current work, start another turn, or start concurrent execution in the session. It SHALL NOT add a user message or a queued message.

The mode and depth of a turn SHALL NOT change during the turn. The selected agent MAY change between the model requests of one turn.

The console SHALL show the agent selected for future requests separately from the agent of each prepared request.

#### Scenario: A change during a model request applies to the next request
- **WHEN** the owner selects configuration B while a request prepared with configuration A waits for the provider
- **THEN** that request and the tool calls in its response SHALL use configuration A
- **AND** the next prepared request SHALL use configuration B

#### Scenario: The latest change before capture applies
- **WHEN** the owner selects configuration B and then configuration C before the next request preparation
- **THEN** the next prepared request SHALL use configuration C
- **AND** the intermediate selection of B SHALL NOT cause an additional model request

#### Scenario: A tool call keeps its prepared configuration
- **WHEN** a response to a request prepared with configuration A contains a tool call
- **AND** the owner selects configuration B before dispatch
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

### Requirement: Discussion stays read-only in a shared workspace

A discussion invocation MAY share a workspace with task invocations that have write permission.

Writable workspace storage SHALL NOT give write permission to a discussion invocation. The discussion SHALL keep its read-only mode, with no task delegation and no mode escape.

Task writes in the sandbox workload SHALL use only MCP tools that the owner approved. Sessions SHALL NOT add an arbitrary native write tool.

#### Scenario: Discussion shares a workspace with writers
- **WHEN** a discussion invocation shares a workspace with task invocations permitted to write
- **THEN** discussion SHALL remain read-only with no task delegation or mode escape
- **AND** writable storage SHALL NOT grant the discussion invocation write permission

### Requirement: A workspace hold preserves resumable execution without a question

The runtime SHALL provide a nonterminal held state with a verified saved continuation binding.

The checkpoint chain of a held invocation SHALL keep the owning run, session, execution turn, parent operation, mode, depth, pending dispatch, execution definition, captured agent selection, and frozen eligible skill membership.

The runtime SHALL publish the hold and settle the invocation atomically, after it confirms that the checkpoint is stored. The runtime SHALL NOT show a failed checkpoint write as a resumable hold.

A suspended turn SHALL keep its session occupied until its actual work and completion are settled.

If a process stops during work that has no durable held or waiting state, the runtime SHALL report that work as interrupted under the existing rules. Only a durable held or waiting state SHALL permit continuation.

When the gate opens again, the runtime SHALL resume eligible held work through one owner-fenced invocation claim. The runtime SHALL verify the full retained caller chain before dispatch.

A temporary verification failure SHALL keep the work held. A confirmed incompatibility SHALL fail without execution of the graph as a check.

Waiting SHALL NOT consume model steps or publish synthetic owner questions.

Existing owner questions SHALL remain answerable during a workspace hold. An accepted answer SHALL keep its normal identity. It SHALL schedule the held continuation, not dispatch.

Cancellation SHALL remain available. Nested task questions SHALL keep the actual asker and the complete ancestor chain.

#### Scenario: The workspace reopens after a durable pause
- **WHEN** a compatible held run becomes eligible after its workspace gate reopens
- **THEN** one executor SHALL claim the saved continuation and resume the same logical work
- **AND** it SHALL NOT duplicate a child actor, completed operation, or consumed model step

#### Scenario: The owner answers while another run holds the workspace
- **WHEN** a valid answer arrives for a waiting task while the shared workspace gate is closed
- **THEN** the runtime SHALL accept the answer under its normal question identity and continuation checks
- **AND** further execution SHALL remain held until workspace admission permits it

### Requirement: Submitted workspace and entry choices have stable retry identity

A new start request SHALL name an owner-registered workspace ID. It MAY name an eligible entry agent and an explicit step budget.

An omitted choice SHALL stay different from an explicit value in the submitted identity.

The runtime SHALL NOT accept host paths, policy overrides, or model-selected workspace changes as start choices.

After structural and credential screening, the runtime SHALL look up the accepted request before current configuration and admission checks.

An equal retry of an accepted request SHALL return the original run. Changed submitted input SHALL cause a conflict.

Final acceptance SHALL check the workspace gate, the governing policy, and the observed selection state again. That check SHALL be atomic with run creation and its retained records.

Request identity SHALL use one current formula. The runtime SHALL NOT keep an identity formula from an earlier record format.

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

Run capability inspection SHALL keep a committed history watermark across pages of plans, actors, definitions, and usage. Each page SHALL have a bounded size.

Earlier pages SHALL NOT use actor outcomes that changed later.

Cursor validation SHALL bind the run, collection, context, order, and watermark.

If historical verification is not available, inspection SHALL fail explicitly. It SHALL NOT combine inconsistent views.

#### Scenario: A child completes after the first history page
- **WHEN** a child finishes after the owner obtained a capability view at an earlier watermark
- **THEN** later pages for that watermark SHALL retain the earlier child state
- **AND** the owner SHALL obtain a new view to observe the completed result

## MODIFIED Requirements

### Requirement: Run history records ordered activity

The console SHALL show the ordered conversation and progress history of each run.

That history SHALL include agent messages, tool activity and outcomes, human questions and accepted answers, cancellation requests, status changes, and the final outcome. Recorded status changes SHALL include their recorded times.

That history SHALL also show the selected command and its credential-safe arguments, startup skill supply for each actor, on-demand skill loads, and bundled reference reads. It SHALL show delegation starts and outcomes, MCP calls, and capability refusals.

Activity from an agent SHALL identify the configured agent, the actor, and the facet contribution where applicable. Delegated activity SHALL identify its parent actor and depth.

Startup skill supply SHALL occur before the first model request of the receiving actor. It SHALL identify the skill, the originating facet, and the version.

The startup supply of a new session SHALL appear in the creation activity of its first turn, not as separate events for each skill.

That activity SHALL identify the session, turn, configured agent, and the complete list of new activations with exact retained definition digests. A new session without startup skills SHALL show an empty list.

A later turn of a reused session SHALL identify its session. It SHALL NOT report another initial session-startup activation. Any selection-caused supply SHALL retain its separate preparation provenance.

Inspection SHALL keep the original skill provenance. It SHALL show startup supply separately from later on-demand loads. Recorded supply SHALL NOT prove provider delivery or model compliance.

The complete startup set and its creation history SHALL become visible atomically with the new session and its first turn.

Recovery SHALL NOT duplicate that activity or accept a different startup set for the same creation identity. Later turn admission SHALL keep the history and skill state of the existing session without duplicates.

History SHALL show each owner agent selection change for a session. Each entry SHALL show its time, the earlier and new agent configurations, and the deployment-owner authority.

Each model request SHALL identify the agent configuration that the runtime captured for it.

If a selection change causes startup supply, that supply SHALL appear before the first model request that contains it. That supply SHALL identify its turn and the selection change. History SHALL NOT show that supply as a tool call or as a new session.

History SHALL show read-only discussion separately from task delegation. It SHALL identify the responsible invocation and its mode, and show tool refusals that the mode causes.

For each discussion turn, history SHALL identify the session, the turn, and the discussion ID.

History SHALL NOT show consultation advice as evidence of a completed external action. The runtime SHALL still write its history during discussion.

History SHALL identify critical-operation requests, human decisions, and execution outcomes. A proposal or approval alone SHALL NOT show that execution occurred.

The existing contracts for agent identity, facet provenance, tool activity, credential screening, and safe projection SHALL remain effective.

The console SHALL identify the workspace that a hold affects. It SHALL show work in flight that settles separately from a wait for individual approval.

The console SHALL keep each request and decision separately inspectable. It SHALL NOT imply that one approval resolves the full queue.

If an uncertain outcome keeps a workspace held, the console SHALL show it. The owner controls SHALL remain available.

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
- **WHEN** the owner selects configuration B for an active session
- **AND** the next prepared request supplies a startup skill of B
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

The owner SHALL be able to start a run from the browser console with an installed facet command that is available to the selected entry agent. The owner SHALL supply its arguments and select a subscription provider.

Before dispatch, the system SHALL validate the supported input requirements and explicitly declared prerequisites of the command, within the selected capabilities of that agent.

The system SHALL record the entry agent, the selected command, the submitted arguments, and the resulting task goal.

Command arguments SHALL be owner input. They SHALL NOT give authority to execute shell commands.

A command SHALL supply task instructions and applicable narrowing constraints. It SHALL NOT supply more facet selections, delegation relationships, or grants.

Command availability SHALL use the agent that the entry policy selected. Selection of a command SHALL NOT change the entry agent or bypass entry eligibility.

Goal runs SHALL remain available whether or not runtime facets are installed. Their capabilities SHALL come from the same agent configuration, not from command selection.

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
- **WHEN** the selected command is missing, outside the entry agent's selections, or requires unsupported behavior
- **OR** it has an explicitly declared required contribution unavailable to that agent, or receives arguments that violate its declared constraints
- **THEN** the system SHALL explain the affected command and unmet requirement before dispatching model or tool work
- **AND** it SHALL NOT silently start a free-form task or substitute another command

#### Scenario: Retry the same creation request after a facet update
- **WHEN** a command run was accepted, its acknowledgement was lost, and the installed facet was updated
- **AND** the owner retries the same creation request with the same submitted command and arguments
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

### Requirement: A run keeps its original capability definitions

Each accepted goal run or command run SHALL keep a capability snapshot and a run binding.

The snapshot SHALL keep the entry-agent identity, the independent agent configurations, the outgoing delegation relationships, the execution limits, the startup choices, and the exact contribution definitions available at acceptance.

Retained definitions SHALL include instructions, skills, commands, permission restrictions, and MCP declarations where applicable.

Facet updates, facet removal, and later configuration changes SHALL NOT replace those definitions during the run. This rule SHALL also apply to first use by a nested delegate, and after a human pause or a compatible restart.

Retention of a definition or relationship SHALL NOT itself bypass permission checks.

Retention SHALL include the configured discussion catalog, including targets outside the task-delegation relationships. First use of a target SHALL NOT substitute current deployment definitions.

Retention SHALL keep the explicit tool policy, the sandbox and resource constraints, and the critical-approval requirements. Approval records for specific actions SHALL stay separate from the immutable definition snapshots.

A resumed discussion SHALL keep its restrictive mode. It SHALL NOT get unrestricted task permissions.

A run whose agents select no facets SHALL use the same capability snapshot and run binding. That binding SHALL identify no installation and contain no installed definitions.

Acceptance of that run SHALL NOT read an installation or start MCP discovery. The runtime SHALL NOT keep a special unbound path or a separate configuration record for native goal runs.

The binding MAY keep native tool policy where necessary. It SHALL NOT show native tools as MCP records. The runtime SHALL NOT convert earlier records of unbound runs.

Current independent owner revocations and compatibility checks SHALL still limit continuation and execution.

Run snapshots and bindings SHALL NOT contain or enforce a delegation-call limit. They SHALL keep the maximum delegation depth and the applicable run-wide budget contract. Storage defaults SHALL NOT add a delegation-call limit to a run.

The runtime SHALL keep the exact snapshot content and its integrity check. A serialization or storage failure SHALL cause an explicit error that identifies that failure.

The runtime SHALL NOT truncate, omit, or substitute definitions after such a failure. It SHALL NOT show the failure as an agent-count cap or a size limit.

Retained definitions SHALL remain subject to runtime compatibility checks and current owner grants. Configuration guidance SHALL identify the compatibility rules for configuration and for continuation of current-format runs.

The runtime SHALL NOT silently interpret an incompatible saved run as new selections or replacement definitions.

Removal of a facet selection, a startup designation, or a configured delegation relationship SHALL affect only newly accepted runs. It SHALL NOT replace a retained configuration.

Revocation of an independent server approval or tool grant SHALL still limit later dispatch in an accepted run. Configuration removal SHALL NOT be shown as independent permission revocation.

An owner agent selection change for a session SHALL choose only from the configurations that its run retained. It SHALL NOT change those retained configurations.

#### Scenario: Update a facet while a run is in progress
- **WHEN** a facet is updated after a run starts and that run later loads a skill or invokes an agent it has not used before
- **THEN** the run SHALL use the definitions originally made available to it
- **AND** a newly accepted run SHALL be able to use the updated installation without changing the older run

#### Scenario: Restart after changing the installed facets
- **WHEN** a run is waiting for an answer and its installed facet is updated or removed
- **AND** the runtime restarts with compatible runtime behavior and preserved run storage
- **THEN** answering the question SHALL continue the original run using its retained definitions
- **AND** updating or removing the installation alone SHALL NOT replace its question or require starting the task over

#### Scenario: Required retained definitions are lost
- **WHEN** the system confirms that definitions required to continue a waiting run are missing or unusable in its preserved state
- **THEN** the system SHALL refuse continuation as "continuation unavailable" without accepting the answer or dispatching work
- **AND** it SHALL NOT substitute the currently installed versions or fabricate a result
- **AND** available history SHALL remain inspectable

#### Scenario: A grant is revoked for an existing run
- **WHEN** an owner revocation has taken effect in runtime configuration
- **AND** an existing run next requests the affected tool
- **THEN** the request SHALL be refused and recorded without dispatching the tool
- **AND** retained definitions and classifications SHALL NOT restore the revoked access
- **AND** the refusal SHALL NOT claim to undo an earlier dispatched action

#### Scenario: Agent selections change during a human pause
- **WHEN** a goal run is waiting for an answer
- **AND** the owner changes agent selections, startup choices, or delegation relationships before an otherwise compatible restart
- **THEN** continuation SHALL use the run's original entry identity, configurations, relationships, limits, and startup definitions at every delegation depth
- **AND** newly accepted runs SHALL use the changed configuration
- **AND** broader new grants or selections SHALL NOT expand the older run's authority

#### Scenario: Retry a goal start after configuration changes
- **WHEN** a goal run was accepted and its acknowledgement was lost
- **AND** the owner retries the same creation request after a configuration or installation change
- **THEN** the system SHALL return the original run with its retained selections and definitions
- **AND** it SHALL NOT accept a replacement run or reinterpret the accepted goal using the new configuration

#### Scenario: The runtime cannot safely interpret a current-format waiting run
- **WHEN** the runtime determines that a waiting current-format run's saved selections or definitions are incompatible
- **THEN** it SHALL refuse continuation as "continuation unavailable" before accepting the answer or dispatching work
- **AND** it SHALL preserve the recorded question and history without applying new configuration to reconstruct the run

#### Scenario: New runs have no delegation-call limit
- **WHEN** the runtime accepts a new run under the current configuration
- **THEN** the run SHALL use its depth limit and run-wide model-step budget without a separate delegation-call limit
- **AND** storage defaults SHALL NOT add a delegation-call limit to the run

#### Scenario: Snapshot storage fails
- **WHEN** a serialization or storage failure prevents retention of a new run's snapshot
- **THEN** the runtime SHALL reject the run explicitly and identify that failure
- **AND** it SHALL NOT truncate, omit, or substitute definitions or report a size limit as the cause

#### Scenario: First discussion use occurs after a configuration change
- **WHEN** an accepted run first consults an agent after that agent's deployment configuration changes
- **THEN** it SHALL use the discussion definitions and applicable policy retained for the run
- **AND** the absence of a task-delegation relationship SHALL NOT justify substituting current deployment definitions

#### Scenario: A selection change uses the retained configuration
- **WHEN** the deployment configuration of agent B changes after the run was accepted
- **AND** the owner then selects B for a session of that run
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

The console SHALL show the capabilities bound to a run separately from skills loaded at startup or on demand, agents invoked, and tools called.

It SHALL show configured agent identity separately from actor identity, parent actor, and depth.

For each actor, the run SHALL identify its retained facet selections, contribution origins and versions, and effective permissions for permitted or refused work.

Startup activation SHALL stay separate from on-demand loads. It SHALL NOT prove that the agent obeyed the instructions.

This provenance SHALL remain inspectable after restart, configuration changes, or removal of installed facets. Retained provenance SHALL identify the responsible agent configuration and the portable or explicit admission. Inspection SHALL NOT invent configuration provenance for a run.

Inspection SHALL show discussion eligibility separately from task-delegation relationships. It SHALL show the actual mode of each invocation.

Inspection SHALL identify each discussion session, its owning run, its turns, and their discussion IDs, separately from configured agent identity.

Inspection SHALL show the selected agent configuration of each session and its owner selection changes. For each model request, it SHALL show the agent configuration and the tool definitions that the request used.

Read/write policy, critical designations, sandbox constraints, approvals, and refusal reasons SHALL stay separate from capability availability.

Run records SHALL NOT receive invented discussion or approval provenance. Ordinary agent, facet, and tool-use provenance SHALL remain inspectable.

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
- **WHEN** a turn makes 2 model requests, the first with configuration A
- **AND** the owner selects configuration B before the second request
- **THEN** inspection SHALL show configuration A and its tool definitions for the first request
- **AND** it SHALL show configuration B and its tool definitions for the second request
- **AND** it SHALL show configuration B as the current selection of the session
- **AND** the recorded binding of the first request SHALL NOT change

#### Scenario: Owner inspects the sessions of a finished run
- **WHEN** the authorized owner inspects a finished run whose sessions remain retained
- **THEN** inspection SHALL show the history of those sessions
- **AND** inspection SHALL NOT make those sessions discussion targets for a later run
