# Spec Delta

## ADDED Requirements

### Requirement: Start a run from an installed command

The owner SHALL be able to start a run from the browser console by selecting an installed facet command, supplying its arguments, and selecting a subscription provider. The system SHALL validate the command's supported input requirements and explicitly declared prerequisites before dispatching agent work and SHALL record the selected command, submitted arguments, and resulting task goal with the run. Command arguments SHALL be treated as owner input, not as authority to execute shell commands.

Goal-only runs SHALL remain available whether or not runtime facets are installed.

#### Scenario: Select a command and begin its task
- **WHEN** the owner selects a supported installed command and supplies valid arguments
- **THEN** the system SHALL create an identifiable run using that command's instructions and supplied arguments
- **AND** the console SHALL show the command, its originating facet and version, the task goal, workspace, and selected provider
- **AND** a command that requires no arguments SHALL NOT require an unrelated free-form goal

#### Scenario: Refuse an unusable command selection
- **WHEN** the selected command is missing, requires unsupported behavior, has an explicitly declared required contribution that is absent or refused, or receives arguments that violate its declared constraints
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
- **THEN** the existing goal-based journey SHALL remain available with the configured provider and confined native tools
- **AND** installing facets alone SHALL NOT require command selection or grant additional tool access

### Requirement: A run keeps its original capability definitions

A run SHALL retain the exact command, skill, agent, permission-restriction, and MCP declaration definitions made available to it when it was accepted. Facet updates or removal SHALL NOT replace those definitions during that run, including definitions first used after a human pause or ordinary restart with preserved storage. Retaining a definition SHALL NOT itself grant permission to use it.

Retained definitions SHALL remain subject to runtime compatibility checks and current owner grants.

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

### Requirement: Run capability provenance remains inspectable

The console SHALL distinguish the capabilities bound to a run from those actually used. For the selected command, loaded skills, delegates, and MCP tools, the run SHALL identify their originating facets and versions and the effective permissions under which work was permitted or refused. This provenance SHALL remain inspectable with the recorded history after ordinary restart or removal of the installed facets.

#### Scenario: Inspect what a run actually used
- **WHEN** a run loads one of several available skills, invokes a named delegate, and calls an MCP tool
- **THEN** the console SHALL identify those contributions and their bound facet versions
- **AND** it SHALL NOT claim that other merely available skills or agents were used
- **AND** the owner SHALL be able to inspect the permissions relevant to the permitted or refused operations

#### Scenario: Inspect history after uninstalling a facet
- **WHEN** the owner reopens a finished run after removing a facet it used and restarting the runtime with preserved storage
- **THEN** its recorded command, capability provenance, and outcomes SHALL remain available without reinstalling that facet
- **AND** inspecting them SHALL NOT execute the command, delegate, or tool again

### Requirement: Delegated questions return to the original asker

A question raised by a delegate SHALL pause the same run and identify the asking delegate. Its accepted answer SHALL return to that exact pending question and asker without changing its meaning. The caller SHALL NOT advance past the outstanding delegation while that question is pending, and a persisted delegated question SHALL retain this routing across an ordinary compatible restart with preserved storage.

#### Scenario: A delegate asks the owner
- **WHEN** a delegate records a question during its task
- **THEN** the console SHALL show the run as waiting, the exact question and answer constraints, and the asking delegate
- **AND** neither the caller nor the delegate SHALL continue beyond that question without an accepted answer
- **AND** after the answer is accepted, the caller SHALL remain waiting for the delegate's eventual result or failure rather than treating the answer as the delegation's outcome

#### Scenario: Answer a delegated question after restart
- **WHEN** the runtime restarts while a persisted delegate question is pending and the owner submits a permitted negative answer
- **THEN** the same run SHALL deliver that answer to the original delegate's pending question
- **AND** the answer SHALL NOT be treated as missing input or start a replacement delegation
- **AND** already completed earlier tool operations SHALL NOT be repeated merely to reach the pending question

#### Scenario: Retry an answer after the caller asks a later question
- **WHEN** a delegate question has been answered and an old browser view resubmits that answer while the caller has a different pending question
- **THEN** the retry SHALL preserve the earlier question's accepted answer without another continuation
- **AND** it SHALL NOT answer the caller's later question

### Requirement: Recorded tool outcomes survive continuation

When continuing a waiting run, including after an ordinary compatible restart or within a delegate, the system SHALL reuse the durably recorded outcome of the same completed tool operation rather than dispatch it again to reconstruct or resume work. A genuinely new operation SHALL NOT be treated as a replay merely because its tool and arguments match an earlier call. This behavior SHALL NOT be presented as a guarantee that external effects occur exactly once.

#### Scenario: Resume past a completed MCP operation
- **WHEN** a run continues after an owner question and continuation encounters the same MCP operation whose completed outcome was durably recorded
- **THEN** the recorded outcome SHALL be reused
- **AND** the operation SHALL NOT be sent to the server again

#### Scenario: Request a new operation with the same arguments
- **WHEN** an agent makes a genuinely new permitted tool request with the same arguments as an earlier completed operation
- **THEN** the system SHALL treat it as a new operation subject to current dispatch checks
- **AND** it SHALL NOT silently substitute the earlier operation's recorded outcome

## RENAMED Requirements

- FROM: `### Requirement: Agent tools do not mutate the environment`
- TO: `### Requirement: Agent tools stay within explicitly authorized actions`

## MODIFIED Requirements

### Requirement: Run history records ordered activity

The console SHALL show each run's ordered conversation and progress history, including agent messages, tool activity and outcomes, human questions and accepted answers, cancellation requests, status changes, and the final outcome. Recorded status changes SHALL include their recorded times. The selected command and its credential-safe arguments, skill loads and bundled reference reads, delegation starts and outcomes, MCP calls, and capability refusals SHALL appear in that history. Agent-originated activity SHALL identify the responsible agent and facet contribution where applicable.

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

### Requirement: Active work interrupted by process death is reported

If the runtime process stops while a run is actively working, the system SHALL report the run as interrupted when it next starts and SHALL retain its last recorded progress. Startup and browser reconnection SHALL NOT automatically restart, retry, or resume that interrupted work, or mark it successful. An interrupted run SHALL NOT support manual continuation; further work SHALL require a new run. These rules SHALL also apply when active work is delegated or an MCP call is in flight.

#### Scenario: Process stops during a model request or tool operation
- **WHEN** the runtime starts after its process stopped during active work
- **THEN** the run SHALL be shown as interrupted with its last recorded progress
- **AND** no new model request or tool operation SHALL be dispatched to recover that run automatically
- **AND** unrecorded in-flight work SHALL NOT be represented as completed

#### Scenario: Process stops after accepting an answer
- **WHEN** an answer has been accepted and the runtime process stops while the run is actively continuing from it
- **THEN** the run SHALL be shown as interrupted after startup and the accepted answer SHALL remain recorded
- **AND** resubmitting that answer SHALL NOT restart the interrupted work

#### Scenario: Request manual continuation of an interrupted run
- **WHEN** the owner attempts to continue a run marked interrupted
- **THEN** the system SHALL refuse continuation and explain that further work requires a new run
- **AND** the original history SHALL remain inspectable

#### Scenario: Process stops during delegated work or an MCP call
- **WHEN** the runtime starts after its process stopped while a delegate was actively working or an MCP call was in flight, without a recorded pending question or accepted cancellation
- **THEN** the containing run SHALL be shown as interrupted with the last recorded delegate and tool activity
- **AND** the runtime SHALL NOT redispatch the delegation or MCP call to recover it
- **AND** it SHALL NOT claim that an external operation with no recorded outcome certainly completed or had no effect

### Requirement: The owner can cancel an unfinished run

The system SHALL allow the owner to cancel a working or waiting run. It SHALL durably record cancellation before acknowledging acceptance, prevent further model or tool dispatch after acceptance, and make a best-effort attempt to stop in-flight work. The console SHALL distinguish cancellation in progress from cancelled. Accepted cancellation SHALL prevent later answers from continuing the run and late results from replacing its cancelled outcome. Cancellation SHALL cover the run's delegates and MCP calls without claiming to undo external effects.

#### Scenario: Cancel active work
- **WHEN** the owner cancels a run during a model request or tool operation
- **THEN** the system SHALL acknowledge cancellation only after recording it and SHALL dispatch no further agent work
- **AND** the console SHALL show cancellation in progress until execution stops, then cancelled
- **AND** the system SHALL NOT claim that already-submitted provider work was necessarily stopped or its quota use reversed

#### Scenario: Cancellation races with completion
- **WHEN** cancellation and successful completion compete for an unfinished run
- **THEN** the system SHALL record one terminal outcome
- **AND** cancellation accepted first SHALL prevent a late result from replacing the cancelled outcome
- **AND** completion recorded first SHALL produce an already-completed response to cancellation

#### Scenario: Cancel a run with a delegate
- **WHEN** cancellation is accepted while a delegate is working or waiting for the owner
- **THEN** no further model request, tool call, or delegation SHALL be dispatched by the caller or any delegate
- **AND** a pending delegate question SHALL no longer accept an answer that continues work
- **AND** a late delegate result SHALL NOT resume the caller or replace the cancelled outcome

#### Scenario: Cancel with an MCP call in flight
- **WHEN** cancellation is accepted after an MCP call was dispatched
- **THEN** the runtime SHALL make a best-effort attempt to stop that call and SHALL dispatch no follow-on work
- **AND** it SHALL NOT claim that cancellation reversed an external change or proved that the server performed no action

### Requirement: Agent steps have a visible finite budget

Each run SHALL have a finite, owner-configurable maximum number of agent steps, with a documented default. Each model-response request dispatched by the system for that run, including requests made by delegates and retries, SHALL consume one step. A tool call itself SHALL NOT consume an additional step, but model-response requests made to perform delegated work SHALL consume steps from the same run budget. Recording questions or answers, renewing authorization, reconnecting the browser, and restarting the runtime SHALL NOT themselves consume steps. The console SHALL show the consumed count and maximum for every run. Human pauses, delegation, and ordinary restarts SHALL NOT reset or extend the budget.

#### Scenario: Model requests and retries consume steps
- **WHEN** a run with a maximum of five steps dispatches two model-response requests and retries one of them
- **THEN** the console SHALL show three of five steps consumed
- **AND** processing their tool results SHALL NOT increase that count

#### Scenario: Answering after restart does not reset the budget
- **WHEN** a run pauses for a human answer, survives an ordinary restart, and continues after an accepted answer
- **THEN** subsequent work SHALL use the remaining budget rather than a fresh allowance

#### Scenario: Delegate requests count against the containing run
- **WHEN** a run with a maximum of five steps makes two model-response requests in the caller and two in a delegate
- **THEN** the console SHALL show four of five steps consumed for that run
- **AND** skill loading and MCP calls that dispatch no model-response request through the runtime SHALL NOT themselves add model steps

#### Scenario: Delegation cannot create a fresh allowance
- **WHEN** a run has exhausted its model-step budget and a delegate needs another model-response request
- **THEN** the run SHALL fail with category "step limit" without dispatching that request
- **AND** creating or returning from a delegation SHALL NOT grant another allowance

### Requirement: Both subscription providers support the interactive journey

The owner SHALL be able to select Anthropic or OpenAI subscription access for a run. Each provider SHALL support agent messages, workspace read/search tool calls and their results, human question-and-answer continuation, and a final outcome. Each provider SHALL also support runs using an installed command, on-demand skills, bounded named delegation, and approved MCP tools. The provider associated with the run SHALL remain visible, and delegated model work SHALL use that selected subscription provider.

#### Scenario: Complete the journey with Anthropic
- **WHEN** a run using valid Anthropic subscription access investigates a workspace file, asks the owner a question, and receives an answer
- **THEN** the agent SHALL be able to use the tool result and accepted answer to produce its final result
- **AND** the console SHALL identify Anthropic as the run's provider

#### Scenario: Complete the journey with OpenAI
- **WHEN** a run using valid OpenAI subscription access investigates a workspace file, asks the owner a question, and receives an answer
- **THEN** the agent SHALL be able to use the tool result and accepted answer to produce its final result
- **AND** the console SHALL identify OpenAI as the run's provider

#### Scenario: Complete a facet-backed journey with either provider
- **WHEN** the owner selects either supported provider for an installed command with an available skill, a bounded delegate, and an approved MCP tool
- **THEN** the run SHALL be able to load the skill, delegate its task, let the delegate call the approved tool and ask a question, deliver the accepted answer to that delegate, return its outcome to the caller, and produce an inspectable final result
- **AND** caller and delegate model requests SHALL use the selected provider rather than falling back to another provider or billed API access

### Requirement: Workspace reading and search are confined

The agent SHALL be able to read and search files within the owner's explicitly configured workspace. The system SHALL enforce that boundary for its native workspace read and search requests, including paths reached through traversal or symbolic links, and SHALL NOT let an agent or delegate expand that access. Loaded instructions and MCP grants SHALL NOT widen what the native workspace tools return. A refused read or search SHALL be recorded as a tool outcome and returned to the agent without exposing forbidden content. A safely reported refusal SHALL NOT by itself fail the run; further work SHALL remain subject to cancellation, step limits, and other failures. MCP requests SHALL remain subject to owner grants and supported argument restrictions; those dispatch checks SHALL NOT be represented as sandboxing the server process or proving which resources it accesses.

#### Scenario: Investigate files in the workspace
- **WHEN** the agent reads a permitted file or searches permitted workspace contents
- **THEN** it SHALL receive the requested content or matches with file locations sufficient to identify their source

#### Scenario: A requested file is missing or unreadable
- **WHEN** the agent requests a workspace file that does not exist or cannot be read
- **THEN** the system SHALL return an identifiable read failure rather than fabricate content or present the request as a successful empty read

#### Scenario: A path escapes the workspace
- **WHEN** a native workspace read or search request targets content outside the configured workspace through an absolute path, parent-directory traversal, or a symbolic link
- **THEN** the system SHALL deny access to that out-of-scope content
- **AND** it SHALL NOT expose that content in tool results or search matches
- **AND** the history SHALL record the refusal as a tool outcome
- **AND** the refusal alone SHALL NOT terminate the run

#### Scenario: Delegation and MCP approval do not widen native workspace access
- **WHEN** an agent or delegate uses native workspace read or search to request content outside the configured boundary, including after loading a skill or receiving an MCP grant
- **THEN** the native request SHALL be refused without exposing the forbidden content
- **AND** skill loading, delegation, and MCP approval SHALL NOT change that native-tool boundary

### Requirement: Agent tools stay within explicitly authorized actions

By default, agents SHALL be limited to confined workspace reading, workspace search, human questions, and supported skill loading and bounded delegation. Additional MCP actions SHALL require explicit owner grants and SHALL remain constrained by each agent's effective permissions. The system SHALL refuse agent-requested file edits, arbitrary command execution, bundled-script execution, or external changes unless dispatched through an explicitly granted MCP tool within its supported request constraints, regardless of instructions in a goal, model output, facet, or inspected content. An unavailable or denied tool call SHALL be recorded as refused. If the refusal cannot be handled safely as a tool outcome, the run SHALL fail with category "tool failure" without performing the requested action.

#### Scenario: A task requests a source edit or command
- **WHEN** a goal or agent request calls for editing a file, running an arbitrary command, or mutating an external system without an applicable explicit owner grant
- **THEN** the requested operation SHALL NOT be executed
- **AND** the limitation SHALL be visible in the run rather than reported as completed work

#### Scenario: Inspected content instructs a mutation
- **WHEN** a workspace file, loaded skill, bundled reference, or tool result instructs the agent to execute a command, change files, or acquire additional permissions
- **THEN** that content SHALL NOT expand the agent's permitted tool surface or authorize that operation

#### Scenario: The agent calls an unavailable mutating tool
- **WHEN** the agent attempts an unavailable tool call for writing a file or executing an arbitrary command
- **THEN** the history SHALL record the refused attempt and the requested action SHALL NOT occur
- **AND** the system SHALL either return a safe refusal outcome or fail the run with category "tool failure"

#### Scenario: The owner grants one narrowly scoped tool action
- **WHEN** the owner grants an MCP tool only for requests whose `repository` argument equals `owner/repo-a`, and the approved schema and agent permissions allow the request
- **THEN** a request for `owner/repo-a` SHALL be permitted and its outcome SHALL be recorded
- **AND** a request for `owner/repo-b` SHALL be refused without being sent to the server
- **AND** permission to use that tool SHALL NOT grant general source editing or shell access
