# Spec Delta

## Purpose

Let the owner start and observe agent tasks in a browser, answer questions, and receive durable results using subscription model access. Make disconnections, interruptions, failures, and the boundaries of permitted work explicit.

## ADDED Requirements

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

The console SHALL show each run's ordered conversation and progress history, including agent messages, tool activity and outcomes, human questions and accepted answers, cancellation requests, status changes, and the final outcome. Recorded status changes SHALL include their recorded times.

#### Scenario: Status changes remain inspectable
- **WHEN** a run changes from active work to waiting for an answer and then back to active work
- **THEN** its history SHALL show both changes in order with their recorded times
- **AND** the question and accepted answer SHALL remain visible

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

If the runtime process stops while a run is actively working, the system SHALL report the run as interrupted when it next starts and SHALL retain its last recorded progress. Startup and browser reconnection SHALL NOT automatically restart, retry, or resume that interrupted work, or mark it successful. An interrupted run SHALL NOT support manual continuation; further work SHALL require a new run.

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

### Requirement: The owner can cancel an unfinished run

The system SHALL allow the owner to cancel a working or waiting run. It SHALL durably record cancellation before acknowledging acceptance, prevent further model or tool dispatch after acceptance, and make a best-effort attempt to stop in-flight work. The console SHALL distinguish cancellation in progress from cancelled. Accepted cancellation SHALL prevent later answers from continuing the run and late results from replacing its cancelled outcome.

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

Each run SHALL have a finite, owner-configurable maximum number of agent steps, with a documented default. Each dispatched model-response request, including a retry, SHALL consume one step. Tool calls requested by that response SHALL belong to the same step and SHALL NOT consume additional steps. Recording questions or answers, renewing authorization, reconnecting the browser, and restarting the runtime SHALL NOT themselves consume steps. The console SHALL show the consumed count and maximum for every run. Human pauses and ordinary restarts SHALL NOT reset or extend the budget.

#### Scenario: Model requests and retries consume steps
- **WHEN** a run with a maximum of five steps dispatches two model-response requests and retries one of them
- **THEN** the console SHALL show three of five steps consumed
- **AND** processing their tool results SHALL NOT increase that count

#### Scenario: Answering after restart does not reset the budget
- **WHEN** a run pauses for a human answer, survives an ordinary restart, and continues after an accepted answer
- **THEN** subsequent work SHALL use the remaining budget rather than a fresh allowance

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

The owner SHALL be able to select Anthropic or OpenAI subscription access for a run. Each provider SHALL support agent messages, workspace read/search tool calls and their results, human question-and-answer continuation, and a final outcome. The provider associated with the run SHALL remain visible.

#### Scenario: Complete the journey with Anthropic
- **WHEN** a run using valid Anthropic subscription access investigates a workspace file, asks the owner a question, and receives an answer
- **THEN** the agent SHALL be able to use the tool result and accepted answer to produce its final result
- **AND** the console SHALL identify Anthropic as the run's provider

#### Scenario: Complete the journey with OpenAI
- **WHEN** a run using valid OpenAI subscription access investigates a workspace file, asks the owner a question, and receives an answer
- **THEN** the agent SHALL be able to use the tool result and accepted answer to produce its final result
- **AND** the console SHALL identify OpenAI as the run's provider

### Requirement: Subscription access can be established without a browser on the host

The system SHALL provide documented means to establish and reauthorize access to each supported subscription provider without requiring a browser on the runtime host.

#### Scenario: Authorize a runtime host without a browser
- **WHEN** the runtime host has no browser and the owner follows the documented authorization procedure using a browser on another device
- **THEN** the owner SHALL be able to establish access to either supported subscription provider

### Requirement: Usable subscription authorization survives ordinary restart

Existing usable authorization, including successfully renewed credentials, SHALL be reused after an ordinary runtime restart with persistent storage preserved. Restarting alone SHALL NOT require reauthorization.

#### Scenario: Restart after credential renewal
- **WHEN** provider authorization has been successfully renewed and the runtime restarts with its persistent storage preserved
- **THEN** subsequent requests SHALL use the current authorization rather than superseded credentials

#### Scenario: Restart retains usable authorization
- **WHEN** the runtime restarts while its saved subscription authorization remains usable
- **THEN** subsequent provider requests SHALL use that authorization without requiring the owner to authorize again

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

The agent SHALL be able to read and search files within the owner's explicitly configured workspace. The system SHALL enforce that boundary for all read and search requests, including paths reached through traversal or symbolic links, and SHALL NOT let the agent expand its own workspace access. A refused read or search SHALL be recorded as a tool outcome and returned to the agent without exposing forbidden content. A safely reported refusal SHALL NOT by itself fail the run; further work SHALL remain subject to cancellation, step limits, and other failures.

#### Scenario: Investigate files in the workspace
- **WHEN** the agent reads a permitted file or searches permitted workspace contents
- **THEN** it SHALL receive the requested content or matches with file locations sufficient to identify their source

#### Scenario: A requested file is missing or unreadable
- **WHEN** the agent requests a workspace file that does not exist or cannot be read
- **THEN** the system SHALL return an identifiable read failure rather than fabricate content or present the request as a successful empty read

#### Scenario: A path escapes the workspace
- **WHEN** a read or search request targets content outside the configured workspace through an absolute path, parent-directory traversal, or a symbolic link
- **THEN** the system SHALL deny access to that out-of-scope content
- **AND** it SHALL NOT expose that content in tool results or search matches
- **AND** the history SHALL record the refusal as a tool outcome
- **AND** the refusal alone SHALL NOT terminate the run

### Requirement: Agent tools do not mutate the environment

The agent's permitted tools SHALL be limited to workspace reading, workspace search, and human questions. The system SHALL prevent agent requests from editing files, running arbitrary commands, or changing external systems regardless of instructions in a goal, model output, or inspected content. An attempted call to an unavailable tool SHALL be recorded as refused. If the refusal cannot be handled safely as a tool outcome, the run SHALL fail with category "tool failure" without performing the requested action.

#### Scenario: A task requests a source edit or command
- **WHEN** a goal or agent request calls for editing a file, running an arbitrary command, or mutating an external system
- **THEN** the requested operation SHALL NOT be executed
- **AND** the limitation SHALL be visible in the run rather than reported as completed work

#### Scenario: Inspected content instructs a mutation
- **WHEN** a workspace file instructs the agent to execute a command, change files, or acquire additional permissions
- **THEN** the file content SHALL NOT expand the agent's permitted tool surface or authorize that operation

#### Scenario: The agent calls an unavailable mutating tool
- **WHEN** the agent attempts a tool call for writing a file or executing an arbitrary command
- **THEN** the history SHALL record the refused attempt and the requested action SHALL NOT occur
- **AND** the system SHALL either return a safe refusal outcome or fail the run with category "tool failure"

### Requirement: Provider credentials stay private

The system SHALL keep its provider credentials out of agent context and agent-accessible tool results, run histories, progress events, final results, browser-console data, and diagnostic logs. Provider failures and authentication guidance SHALL expose safe status information without credential values.

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
