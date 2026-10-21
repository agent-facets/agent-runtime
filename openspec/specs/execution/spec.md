# Execution Specification

## Purpose

Let the owner start and observe agent tasks in a browser, answer questions, and receive durable results using subscription model access. Make disconnections, interruptions, failures, and the boundaries of permitted work explicit.

## Requirements

### Requirement: Reproducible development and operation

The project SHALL provide documented setup and dependency installation, pinned development tool versions, and repeatable commands to start the runtime and run its tests, type checks, and lint checks.

#### Scenario: Set up from a fresh checkout
- **WHEN** a developer follows the setup instructions on a supported environment with the documented prerequisites and subscription access
- **THEN** the developer SHALL be able to install the pinned toolchain and project dependencies, run the documented checks, and start the runtime and browser console
- **AND** the instructions SHALL identify the required persistent services and how to configure the workspace, provider access, and private-network listener

### Requirement: Start an identifiable agent run

The system SHALL allow the owner to start an agent task with a goal and SHALL assign each accepted run a stable identity associated with its submitted goal, configured workspace, and selected provider. Before dispatching agent work, the system SHALL refuse an unsupported provider, known-unusable authorization that cannot be renewed, or an unconfigured or unreadable workspace, and SHALL explain the unmet prerequisite.

#### Scenario: Start and reopen a task
- **WHEN** the owner starts a task and subsequently opens its run
- **THEN** the system SHALL show the same run identity, submitted goal, workspace, and provider
- **AND** opening the run SHALL NOT start another invocation

#### Scenario: Reject an unusable goal
- **WHEN** the owner submits a task with an empty or whitespace-only goal
- **THEN** the system SHALL explain that a goal is required
- **AND** no agent invocation SHALL begin

#### Scenario: Provider access is unavailable at start
- **WHEN** the owner requests an unsupported provider or one whose authorization is known to be unusable and cannot be renewed
- **THEN** the system SHALL explain the provider problem before dispatching any model or tool work
- **AND** it SHALL NOT switch providers or use billed API access

#### Scenario: A configured provider is unavailable in the installed build
- **WHEN** a provider remains configured but its integration is unavailable in the installed build
- **THEN** the console SHALL identify the integration as unavailable even if saved authorization exists
- **AND** starting a task with that provider SHALL be refused before model or tool work
- **AND** the system SHALL NOT offer login as a remedy for the missing integration or automatically select another provider or billing mode

#### Scenario: Workspace is unavailable at start
- **WHEN** the configured workspace is absent or unreadable
- **THEN** the system SHALL explain the workspace problem before dispatching any model or tool work

### Requirement: Browser access on the private network

The system SHALL provide a browser console usable from the owner's devices on the configured private network without requiring a browser on the runtime host. Its documented deployment SHALL restrict access to that private network rather than expose a public service.

#### Scenario: Use the console from another device
- **WHEN** the owner opens the configured console address from another device with private-network access
- **THEN** the owner SHALL be able to list runs, start a task, inspect a run, answer a pending question, cancel a working or waiting run, and view its result
- **AND** those interactions SHALL NOT require a terminal session on the runtime host

### Requirement: Run status and terminal outcomes are explicit

The console SHALL distinguish active work, waiting for the owner, successful completion, failure, interruption, cancellation in progress, and cancellation. Successful completion, failure, interruption, and cancellation SHALL be terminal outcomes: later requests, events, or restarts SHALL NOT change the outcome or restart agent work. The run list SHALL show each run's identity, goal, provider, status, start time, and last recorded activity time.

#### Scenario: Inspect runs at different stages
- **WHEN** the owner lists runs that are working, waiting for an answer, completed, failed, interrupted, cancelling, or cancelled
- **THEN** the console SHALL distinguish those states and allow the owner to open each run's history
- **AND** an incomplete run SHALL NOT be presented as successfully completed

#### Scenario: A terminal outcome does not change
- **WHEN** an answer, cancellation request, late provider response, or restart affects a run already completed, failed, cancelled, or interrupted
- **THEN** its terminal outcome SHALL remain unchanged and no agent work SHALL restart
- **AND** a request to change it SHALL receive an already-finished or not-continuable response

#### Scenario: The run list identifies recorded work
- **WHEN** the owner opens the run list
- **THEN** each listed run SHALL show its identity, goal, provider, status, start time, and last recorded activity time

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

### Requirement: Progress is observable while work continues

A connected console SHALL display newly recorded agent messages and tool activity in recorded order without requiring a page reload or waiting for the run to finish.

#### Scenario: Observe work as it happens
- **WHEN** a connected console displays a run that records a message or tool operation and then remains actively working
- **THEN** the new activity SHALL appear without a page reload while the run is still working

### Requirement: Execution independent of browser connection

A run SHALL continue independently of its browser connection. Reconnecting SHALL reconstruct its recorded history and current state without restarting the run, duplicating recorded entries, or losing recorded activity between history loading and live updates.

#### Scenario: Leave while the agent works
- **WHEN** the owner closes the browser or loses its connection during active work
- **THEN** the run SHALL continue until it reaches a question, a result, a failure, or accepted cancellation without requiring the browser to remain connected

#### Scenario: Return after activity occurred
- **WHEN** the owner reconnects after a run has produced additional progress, reached a question, or finished
- **THEN** the console SHALL show the activity recorded during the absence and the current question or outcome
- **AND** repeated reconnections SHALL NOT duplicate recorded entries or trigger another agent invocation

#### Scenario: Activity arrives during reconnection
- **WHEN** new progress is recorded while the console is reconstructing a run's history
- **THEN** that progress SHALL appear once in the reconstructed history or subsequent live updates

### Requirement: Durable run history and outcomes

The system SHALL retain the run's identity, goal, workspace, provider, recorded history, accepted answers, and recorded final outcome across an ordinary runtime restart with its persistent storage preserved.

#### Scenario: Inspect a completed run after restart
- **WHEN** the owner opens a previously completed run after an ordinary runtime restart
- **THEN** the console SHALL show the same identity, goal, workspace, provider, recorded history, accepted answers, and final result
- **AND** inspection SHALL NOT execute the task again

#### Scenario: Inspect a failed run after restart
- **WHEN** the owner opens a previously failed run after an ordinary runtime restart
- **THEN** the console SHALL retain the failure and recorded progress rather than present a fresh or successful run

#### Scenario: Inspect history after a provider integration is removed
- **WHEN** the installed build no longer supplies the provider integration used by an existing run
- **THEN** the run's identity, provider, recorded activity, questions, accepted answers and recorded outcome SHALL remain inspectable
- **AND** inspecting that history SHALL NOT execute work or silently substitute a different provider or model

### Requirement: Explicit human questions

An agent SHALL be able to pause a run with a question for the owner. The console SHALL show the exact question and any supplied answer choices or constraints, distinguish it from ordinary agent messages, and keep it pending until an answer is accepted or the run reaches a terminal outcome.

#### Scenario: Agent requests a decision
- **WHEN** an agent asks a question and the system records it as pending
- **THEN** the console SHALL show that the run is waiting for the owner and display the question and any answer choices or constraints
- **AND** the agent SHALL NOT advance beyond the question without an accepted answer

#### Scenario: No answer has been supplied
- **WHEN** the owner views, refreshes, or leaves a pending question without submitting an answer
- **THEN** the question SHALL remain pending
- **AND** viewing or leaving SHALL NOT supply an implicit answer

### Requirement: Answers target the exact pending question

The system SHALL associate an answer with the specific run and question the owner is answering, validate it against any declared answer constraints, and deliver the accepted answer without changing its meaning. Unknown, mismatched, or stale submissions SHALL NOT answer another question or advance the wrong run.

#### Scenario: Answer and continue
- **WHEN** the owner submits a valid answer to the current pending question
- **THEN** the system SHALL record the answer against that question and allow the same run to continue using it
- **AND** the question SHALL be shown as answered rather than pending

#### Scenario: A negative answer is valid
- **WHEN** the owner submits a permitted negative answer such as "no" or a false-valued choice
- **THEN** the system SHALL accept and deliver that negative answer rather than treat it as missing input

#### Scenario: Invalid or misdirected submission
- **WHEN** a submission violates the question's declared constraints or identifies an unknown question or the wrong run
- **THEN** the system SHALL report the problem without accepting the answer or advancing a run

#### Scenario: An old browser view submits to a later question
- **WHEN** a run has advanced to a new question and an old browser view submits an answer to its earlier question
- **THEN** the submission SHALL NOT answer the new question
- **AND** the owner SHALL be shown the earlier question's recorded disposition or a stale-submission explanation

### Requirement: A question has at most one accepted answer

The system SHALL apply an accepted answer only once and SHALL prevent competing continuations of the same run. Duplicate submissions SHALL preserve the original accepted answer; conflicting later submissions SHALL NOT overwrite it.

#### Scenario: Retry after an answer response is lost
- **WHEN** the system has accepted an answer but the owner retries it because its acknowledgement was lost
- **THEN** the system SHALL report the already accepted answer
- **AND** the retry SHALL NOT create another decision or continuation

#### Scenario: Two browser tabs submit conflicting answers
- **WHEN** two tabs submit different answers to the same pending question
- **THEN** at most one answer SHALL be accepted and used to continue the run
- **AND** the other submission SHALL receive a visible conflict or already-answered response
- **AND** the accepted answer SHALL remain unchanged

### Requirement: Pending questions survive ordinary restart

A persisted pending question SHALL remain associated with the same run and retain its content, answer choices or constraints, and answerability after an ordinary restart with compatible runtime behavior and preserved persistent storage. An answered question SHALL NOT reappear as pending solely because its history remains stored.

#### Scenario: Restart while waiting for the owner
- **WHEN** the runtime restarts while a persisted question is awaiting an answer
- **THEN** the console SHALL show the same question on the same waiting run
- **AND** the owner SHALL be able to answer it and continue that run without starting over
- **AND** the restart itself SHALL NOT answer the question or continue past it

#### Scenario: Restart after a question was answered
- **WHEN** the runtime restarts after a question's answer has been accepted
- **THEN** the question SHALL retain its accepted answer and SHALL NOT be offered for a second decision

### Requirement: Unsafe continuation is refused visibly

The system SHALL refuse continuation when saved run state is confirmed missing, unusable, or incompatible with the available runtime behavior. The run SHALL be shown as failed with the category "continuation unavailable" and a specific reason. Its unanswered question SHALL remain in history but SHALL no longer be answerable. The refusal SHALL NOT dispatch agent work, accept the submitted answer, or fabricate a result. A temporary inability to inspect saved state SHALL instead report that continuation cannot currently be verified, without accepting an answer or claiming a terminal transition was recorded.

#### Scenario: Runtime behavior changed incompatibly
- **WHEN** the owner attempts to answer a persisted question after a change that prevents safely continuing the original run
- **THEN** the system SHALL display a compatibility refusal before any agent continuation
- **AND** it SHALL preserve the recorded question and decision history without interpreting the submission as an answer to different work
- **AND** the run SHALL be shown as failed with category "continuation unavailable", with the specific cause explained and the unanswered question no longer answerable

#### Scenario: Required saved state is unavailable
- **WHEN** the system confirms that the saved state required to continue an existing run is missing or unusable
- **THEN** it SHALL report that continuation is unavailable rather than start a replacement invocation or report successful completion
- **AND** any available run history SHALL remain inspectable
- **AND** the run SHALL be shown as failed with category "continuation unavailable", with the specific cause explained and the unanswered question no longer answerable

#### Scenario: Saved state is temporarily inaccessible
- **WHEN** a temporary storage failure prevents checking whether a pending run can safely continue
- **THEN** the system SHALL report that continuation cannot currently be verified and SHALL dispatch no agent work
- **AND** it SHALL NOT accept the answer or infer a permanent incompatibility from the outage
- **AND** the console SHALL distinguish the last recorded run status from the current inability to continue

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

### Requirement: Accepted cancellation survives ordinary restart

After an ordinary restart with persistent storage preserved, a run whose cancellation was already accepted SHALL be reported as cancelled, even if work was still stopping when the process ended. It SHALL NOT be resumed or reclassified as interrupted.

#### Scenario: Cancel a waiting run and restart
- **WHEN** cancellation of a run waiting for an answer is accepted and the runtime subsequently restarts
- **THEN** the run SHALL remain cancelled and its question SHALL no longer accept answers
- **AND** a stale answer submission SHALL NOT continue the run

#### Scenario: Restart while cancellation is in progress
- **WHEN** the runtime restarts after cancellation was accepted but before its in-flight work was confirmed stopped
- **THEN** the run SHALL be reported as cancelled without resuming agent work
- **AND** its recorded history SHALL remain available

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

### Requirement: Work beyond the step budget is refused

When another model-response request would exceed the run's step budget, the system SHALL fail the run with category "step limit" without dispatching that request or further agent work. Tool calls belonging to the last permitted request SHALL remain permitted until the run finishes, pauses, is cancelled, or encounters a failure.

#### Scenario: An agent exceeds its configured limit
- **WHEN** a run has consumed its permitted steps and would need another model-response request to continue
- **THEN** the system SHALL record a failure with category "step limit" instead of dispatching that request
- **AND** the console SHALL show the limit and consumed count alongside the recorded progress

#### Scenario: Answering with no remaining model steps
- **WHEN** a run has used its full budget, receives a valid answer to its pending question, and next requires another model-response request
- **THEN** the answer SHALL remain recorded
- **AND** the run SHALL fail with category "step limit" without dispatching the additional request

#### Scenario: The last permitted step finishes the task
- **WHEN** the last permitted model-response request produces the final result without requiring another request
- **THEN** the system SHALL allow successful completion rather than fail solely because the consumed count equals the maximum

### Requirement: Failures remain distinguishable from results

The system SHALL expose errors that prevent a run from continuing as failures with the affected operation and a credential-safe explanation. It SHALL preserve recorded progress and SHALL NOT present partial output as a successful final result.

#### Scenario: A provider request fails without recovery
- **WHEN** a model request fails and the run cannot continue
- **THEN** the console SHALL show a failed run and identify the provider operation that failed
- **AND** recorded messages and tool activity SHALL remain inspectable
- **AND** any partial response SHALL NOT be labelled as the final successful result

### Requirement: Failed runs explain their category and cause

Each failed run SHALL show one primary category from the following set, together with a credential-safe explanation of the specific cause and affected operation:

- "authorization": provider authorization is unusable and cannot be renewed.
- "rate or quota limit": provider usage limits prevent continued work.
- "provider failure": another provider or transport problem, including unavailable service or unsupported response behavior.
- "step limit": further model work would exceed the run's budget.
- "continuation unavailable": required saved state is confirmed missing, unusable, or incompatible.
- "tool failure": a tool problem prevents safe continued work.
- "runtime failure": another runtime problem, including an unexpected no-op continuation.

Authorization guidance SHALL explain how to restore access. Rate or quota guidance SHALL advise waiting or reducing usage where applicable rather than reauthorizing. More specific diagnostic reasons SHALL NOT be concealed by the primary category.

#### Scenario: Authorization and quota failures have different guidance
- **WHEN** a run cannot continue because authorization cannot be renewed or because its provider reports an exhausted usage limit
- **THEN** the console SHALL show "authorization" or "rate or quota limit", respectively
- **AND** it SHALL give the corresponding access-restoration or usage-limit guidance

#### Scenario: Unsupported provider behavior is identified
- **WHEN** an unsupported provider response prevents continued work
- **THEN** the run SHALL fail with category "provider failure"
- **AND** its explanation SHALL identify the unsupported behavior rather than report invalid authorization

### Requirement: Success requires a recorded agent result

The system SHALL report successful completion only when a final result produced by agent work in that run has been durably recorded. If a newly dispatched continuation reports completion without new agent activity, a recorded result, or a persisted pending question, the system SHALL report a "runtime failure" identifying the unexpected no-op. Inspection and duplicate-answer acknowledgement SHALL NOT count as newly dispatched continuations.

#### Scenario: A dispatched continuation unexpectedly does nothing
- **WHEN** an accepted answer causes a new continuation to be dispatched and it reports completion without new agent activity, a result, or a pending question
- **THEN** the run SHALL fail with category "runtime failure" and an explanation that continuation produced no work
- **AND** it SHALL NOT be shown as successfully completed

### Requirement: Durable acceptance is reported truthfully

The system SHALL NOT confirm that a run, pending question, answer, cancellation, or final outcome has been durably recorded when its persistence has failed. A persistence failure SHALL be reported without treating the unrecorded transition as successful.

#### Scenario: An answer cannot be persisted
- **WHEN** storing a submitted answer fails before acceptance
- **THEN** the system SHALL report that the answer was not accepted
- **AND** it SHALL NOT continue the agent using that unaccepted answer

#### Scenario: A final outcome cannot be persisted
- **WHEN** the agent produces an outcome but the system cannot durably record it
- **THEN** the system SHALL expose the persistence failure rather than confirm durable successful completion

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

### Requirement: Subscription access can be established without a browser on the host

The system SHALL provide documented means to establish and reauthorize access to each supported subscription provider using only a normal browser on the owner's device, without requiring a browser on the runtime host. Required owner-side setup SHALL NOT require an installed helper, browser extension, client-side CLI command, tunnel, or credential-file transfer. Optional server-side operator tooling MAY remain available.

#### Scenario: Authorize a runtime host without a browser
- **WHEN** the runtime host has no browser and the owner follows the documented authorization procedure using a browser on another device
- **THEN** the owner SHALL be able to establish access to either supported subscription provider

#### Scenario: Authorize or reconnect from a browser-only device
- **WHEN** the owner establishes or reauthorizes a supported provider from another device with access to the console
- **THEN** the required owner actions SHALL be completable in a normal browser
- **AND** no installed helper, extension, client-side CLI command, tunnel or credential-file transfer SHALL be required

### Requirement: Anthropic access can be connected from the console

The owner SHALL be able to connect or reauthorize Anthropic subscription access from the console without a terminal command. The console SHALL provide an explicit connect action, guide the owner to the provider's authorization page and accept the provider-issued code in a dedicated authentication form. It SHALL distinguish an unfinished login, safely stored authorization and an unsuccessful or uncertain attempt. Connecting an account SHALL NOT start an agent run or make a model request. Existing terminal authorization MAY remain available as a fallback.

#### Scenario: Connect without a terminal
- **WHEN** Anthropic requires authorization and the owner chooses to connect it from the console
- **THEN** the console SHALL guide the owner through provider authorization in a separate tab and submission of the resulting code in the dedicated form
- **AND** it SHALL show connected status and refresh run-start readiness only after usable authorization has been durably stored
- **AND** no terminal command or agent task SHALL be required

#### Scenario: Login is refused or cannot be confirmed
- **WHEN** the provider rejects a submitted code, the exchange outcome is uncertain, or the runtime cannot confirm durable credential storage
- **THEN** the console SHALL explain the unsuccessful or uncertain login without claiming that attempt connected the account
- **AND** it SHALL NOT automatically repeat the exchange, start a run, or erase previously stored authorization
- **AND** its explanation SHALL omit codes, tokens and raw provider error content

#### Scenario: An unfinished login expires or the runtime restarts
- **WHEN** an unfinished login expires or the runtime restarts before its completion can be confirmed
- **THEN** the console SHALL require the owner to inspect current connection status or explicitly start a new login rather than silently reuse the old code
- **AND** previously stored usable authorization SHALL remain available across the restart

#### Scenario: A completion is submitted more than once
- **WHEN** the owner double-submits a login completion or loses its response and checks the same attempt again
- **THEN** the runtime SHALL perform at most one provider exchange for that attempt
- **AND** it SHALL report the attempt's known disposition, or that it can no longer be confirmed, without treating an unknown outcome as permission to repeat the exchange

#### Scenario: The owner cancels before submitting a code
- **WHEN** the owner cancels an unfinished login before submitting its code
- **THEN** the console SHALL discard the form's sensitive input and close that attempt
- **AND** later submission to that cancelled attempt SHALL NOT exchange a code or replace credentials
- **AND** cancelling login SHALL NOT revoke previously saved authorization

#### Scenario: Login material stays separate from agent work
- **WHEN** the owner submits an authorization code through the console
- **THEN** it SHALL be sent only to the dedicated authentication operation and cleared from the input on submission or dismissal
- **AND** it SHALL NOT appear in task inputs, agent context, run history, progress events, results, browser persistent storage, diagnostic logs or echoed responses
- **AND** provider access and refresh tokens SHALL remain server-only

### Requirement: OpenAI access can be connected from the console

The owner SHALL be able to connect or reauthorize OpenAI subscription access from the console using a normal browser. The console SHALL display a short-lived device user code and the provider's verification page, with nothing pasted back into the console. It SHALL distinguish waiting for approval, completion in progress, safely stored authorization and unsuccessful or uncertain completion. Connecting SHALL NOT start an agent run or make a model request. Optional server-side operator commands MAY remain available.

#### Scenario: Approve device login in the provider's browser page
- **WHEN** the owner starts OpenAI connection from the console and approves its displayed device code on the provider's verification page
- **THEN** the console SHALL notice completion without requiring a pasted code or a client-side helper
- **AND** it SHALL show connected status and update run-start readiness only after usable authorization has been durably stored
- **AND** no agent task or model request SHALL be started by connecting

#### Scenario: Return to an active device login
- **WHEN** the owner reloads the console or repeats its connect action while a device login is still awaiting approval
- **THEN** the console SHALL recover the same active attempt and its available approval instructions rather than initiate concurrent logins
- **AND** inspecting the attempt SHALL NOT repeat a credential exchange or start a model request

#### Scenario: A waiting device login is cancelled, expires or is lost on restart
- **WHEN** the owner cancels an attempt awaiting approval, its approval period expires, or the runtime restarts before completion can be confirmed
- **THEN** that closed or lost attempt SHALL NOT be reused to exchange or store credentials
- **AND** the console SHALL explain the disposition or uncertainty and require an explicit new login if needed
- **AND** previously stored usable authorization SHALL remain available

#### Scenario: Device approval cannot be completed or confirmed
- **WHEN** the provider refuses completion, an exchange outcome is uncertain, or durable credential storage cannot be confirmed
- **THEN** the console SHALL report the unsuccessful or uncertain attempt without claiming it connected the account
- **AND** it SHALL NOT automatically repeat the exchange, start a run or erase previously stored authorization
- **AND** failure explanations SHALL omit login secrets and raw provider error content

#### Scenario: Device login material stays separate from agent work
- **WHEN** a console-initiated device login is awaiting owner approval
- **THEN** its user code and provider verification link MAY appear only in the dedicated authentication responses and connection panel
- **AND** its user code SHALL be removed from that panel when the attempt ends or the panel is dismissed
- **AND** user codes SHALL NOT enter task inputs, agent context, tool results, run history, progress events, results, browser persistent storage or diagnostic logs
- **AND** provider tokens, private login verifiers and exchange secrets SHALL remain server-only

### Requirement: Usable subscription authorization survives ordinary restart

Existing usable authorization, including successfully renewed credentials, SHALL be reused after an ordinary runtime restart with persistent storage preserved. Restarting alone SHALL NOT require reauthorization.

#### Scenario: Restart after credential renewal
- **WHEN** provider authorization has been successfully renewed and the runtime restarts with its persistent storage preserved
- **THEN** subsequent requests SHALL use the current authorization rather than superseded credentials

#### Scenario: Restart retains usable authorization
- **WHEN** the runtime restarts while its saved subscription authorization remains usable
- **THEN** subsequent provider requests SHALL use that authorization without requiring the owner to authorize again

#### Scenario: Removing an integration preserves credentials without reusing them
- **WHEN** a build removes a provider integration while private authorization for that provider is saved
- **THEN** the removal SHALL leave the saved authorization unchanged in private storage
- **AND** the removed integration SHALL NOT log in, renew authorization or send model requests
- **AND** retained credentials SHALL NOT be converted or assumed valid for a different provider, account or authorization scheme, or treated as evidence that an absent integration is available

### Requirement: Authorization failures explain how to restore access

Missing or unusable authorization that cannot be renewed SHALL produce a visible authentication problem naming the provider and explaining how to restore access. After definitive rejection of authorization that cannot be renewed, the system SHALL stop automatic retries with those credentials. Expired access that can still be renewed SHALL NOT be treated as definitive rejection.

#### Scenario: Authorization is missing or revoked
- **WHEN** a requested provider has no usable authorization and it cannot be renewed
- **THEN** the system SHALL identify the affected provider and explain how the owner can authorize it again
- **AND** it SHALL NOT present the problem as an empty model response or successful task

#### Scenario: Definitively rejected authorization is not retried
- **WHEN** a provider definitively rejects the run's authorization and renewal is not possible
- **THEN** the system SHALL report the authorization failure and restoration guidance
- **AND** it SHALL NOT automatically repeat requests using the rejected authorization

### Requirement: Provider use remains subscription-only

Runs SHALL use the selected subscription provider and SHALL NOT fall back to billed API access or silently change providers when authorization, quota, or transport problems occur.

#### Scenario: Subscription access fails while API credentials are available
- **WHEN** subscription access fails and billed API credentials are also present in the environment
- **THEN** the system SHALL report the subscription-access problem without issuing a fallback billed API request or switching providers

#### Scenario: Subscription quota is exhausted
- **WHEN** the selected provider reports exhausted quota or rate limiting that prevents continued work
- **THEN** the console SHALL identify the provider limitation rather than report it as invalid authorization
- **AND** the system SHALL NOT move the run to another provider or billed API access

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

### Requirement: Provider credentials stay private

The system SHALL keep its provider access and refresh credentials and private login secrets out of agent context and agent-accessible tool results, run histories, progress events, final results, browser-console data, and diagnostic logs. Provider failures and authentication guidance SHALL expose safe status information without credential values. A short-lived owner-supplied authorization code MAY pass transiently through the dedicated login form and authentication operation, and a short-lived device user code MAY be displayed through the dedicated connection panel and authentication responses. These limited exceptions SHALL obey the corresponding login-material requirements above; neither kind of code SHALL enter an agent-work or diagnostic surface or browser persistent storage. Device user codes SHALL NOT be confused with server-only tokens, private verifiers or exchange secrets.

#### Scenario: A provider error contains sensitive request data
- **WHEN** a provider or authentication operation fails with an error containing credential values or authorization headers
- **THEN** the recorded and displayed failure SHALL omit those secrets
- **AND** diagnostic logs SHALL NOT contain the credential values

#### Scenario: Agent requests the runtime's credential material
- **WHEN** the agent requests to read or search the runtime's provider credential material
- **THEN** the system SHALL prevent that material from being returned, including when its location would otherwise fall within the configured workspace

#### Scenario: A synthetic credential is absent from protected surfaces
- **WHEN** a test supplies a known synthetic provider credential and exercises both a successful run and a provider-error path
- **THEN** captured agent context, tool results, run history, progress events, final results, browser-console data, and diagnostic logs SHALL contain no occurrence of that credential

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
