# Spec Delta

## ADDED Requirements

### Requirement: Critical-operation approvals bind exact execution

A critical request SHALL identify its workspace, run, actor, existing operation, tool identity, reviewed definition, and applicable policy revisions.

Its request digest SHALL bind that complete scope, target, and exact execution payload.

The payload SHALL contain exact arguments or reference an immutable, digest-verified change artifact. Human review SHALL describe the same target and content used at execution.

Trusted preparation SHALL derive the target and necessary file preconditions.

An operation that cannot preserve exact reviewed content SHALL be refused. Redacted or incomplete content SHALL NOT be presented as an exact approval review.

Each operation SHALL have at most one immutable approval scope. Changed scope SHALL require a new operation, request, and approval.

Request creation SHALL NOT dispatch the critical operation.

Approval SHALL NOT bypass ordinary permissions, sandbox constraints, or discussion mode. Replay and continuation SHALL preserve the reviewed scope.

Approval records and digest inputs SHALL use the current strict schema without internal format selectors.

#### Scenario: A critical operation's reviewed change is modified
- **WHEN** an approved critical operation's prepared change differs from the reviewed change
- **THEN** the runtime SHALL NOT execute it using the earlier approval
- **AND** the mismatch SHALL remain inspectable

#### Scenario: A resumed critical operation retains its approval scope
- **WHEN** a run resumes with a recorded critical-operation approval
- **THEN** approval SHALL remain bound to the original operation, target, and arguments or change
- **AND** continuation SHALL NOT turn it into general write or communication permission

#### Scenario: A bound policy revision changes
- **WHEN** proposed critical execution uses a different classification or execution-policy revision from the reviewed request
- **THEN** the runtime SHALL require a new operation, request, and approval
- **AND** the earlier decision SHALL remain associated with its original request digest

#### Scenario: Approval references a verified immutable change
- **WHEN** the owner reviews a critical request that references a change artifact
- **THEN** reviewed and executed content SHALL agree with the same immutable artifact and verified digest
- **AND** the runtime SHALL NOT substitute a later artifact at the same display path

#### Scenario: Shared edits cannot change an approved critical operation
- **WHEN** another agent changes workspace files after critical arguments or a change artifact were approved
- **THEN** execution SHALL use the exact approved immutable content or require new approval for changed content
- **AND** it SHALL NOT substitute current file bytes merely because the path is unchanged

#### Scenario: An approval request contains a schema version field
- **WHEN** an approval request or decision contains an internal format, profile, or schema-version selector
- **THEN** the runtime SHALL reject the record under the current strict schema
- **AND** it SHALL NOT compute its digest under another format or execute the operation

### Requirement: Each critical request has one authoritative owner decision

An immutable decision SHALL bind the reviewed request ID and digest, verdict, deciding authority, and decision time.

The runtime SHALL enforce one authoritative decision per request, including concurrent submissions.

A rejection SHALL NOT be overwritten as approval.

Approval requests and decisions SHALL remain separate from execution records. The existing operation identity SHALL remain authoritative; no parallel operation tracker SHALL be introduced.

Owner decisions SHALL use a separate approval interface, not answers to synthetic questions.

Equal submission retry SHALL return its recorded result without independently dispatching the operation.

#### Scenario: Concurrent decisions do not create contradictory outcomes
- **WHEN** concurrent approve and reject submissions target the same request
- **THEN** one authoritative decision SHALL govern it
- **AND** a rejection SHALL NOT be overwritten to make the operation executable

#### Scenario: Repeating approval does not independently dispatch twice
- **WHEN** the same approval submission is repeated
- **THEN** the runtime SHALL preserve the authoritative decision
- **AND** the repeated submission SHALL NOT independently dispatch the operation again

#### Scenario: Approval is not proof of execution
- **WHEN** a request exists or is approved but execution is not confirmed
- **THEN** history SHALL distinguish approval from execution state
- **AND** it SHALL NOT report successful execution solely from approval

### Requirement: Critical approvals hold all new agent work in their workspace

A critical request SHALL close admission for new agent work throughout its workspace before critical execution.

Request creation and gate closure SHALL be atomic.

The hold SHALL block new model requests, tool calls, delegations, and discussions across all runs using that workspace.

Previously admitted leaf work MAY settle under its existing timeout and outcome rules. Its results SHALL NOT trigger further dispatch while the gate remains closed.

Owner controls and necessary runtime bookkeeping SHALL remain available.

Gates SHALL be independent between workspaces.

#### Scenario: Gate closure precedes drain
- **WHEN** a critical operation requests approval while ordinary work is active
- **THEN** the runtime SHALL close new workspace admission before waiting for that work to settle
- **AND** no later ordinary dispatch SHALL enter through the closed gate

#### Scenario: In-flight results do not restart the agent loop
- **WHEN** previously admitted work returns a result while the workspace gate is closed
- **THEN** the runtime MAY record that result
- **AND** the result SHALL NOT trigger another model request or tool dispatch until admission permits it

#### Scenario: All runs in a workspace share the hold
- **WHEN** one run requests critical approval in a shared workspace
- **THEN** new agent work from every run using that workspace SHALL remain blocked
- **AND** another run SHALL NOT bypass the hold through a different actor or tool route

#### Scenario: Another workspace remains independent
- **WHEN** Workspace A has an approval hold and Workspace B remains admissible
- **THEN** Workspace A's hold SHALL NOT prevent permitted work in Workspace B
- **AND** work in Workspace B SHALL still obey its own controls

### Requirement: Workspace admission is durable across executor boundaries

Workspace admission and active-effect accounting SHALL use durable records under the runtime's ownership fence.

Ordinary admission SHALL atomically check the gate and reserve the admitted effect. A competing gate closure SHALL produce one consistent ordering.

The runtime SHALL NOT rely only on process-local coordination.

An unresolved ordinary external effect SHALL close workspace admission even when no critical approval request exists.

A process restart or ownership-epoch change SHALL NOT prove that an external effect stopped.

#### Scenario: Admission wins a race with closure
- **WHEN** ordinary admission commits before a competing gate closure
- **THEN** that admitted effect SHALL remain part of the work that must settle
- **AND** the later closure SHALL prevent further ordinary admission

#### Scenario: Closure wins a race with admission
- **WHEN** gate closure commits before a competing ordinary admission
- **THEN** the new work SHALL NOT dispatch
- **AND** a blocked model request SHALL NOT consume a model step merely for waiting

#### Scenario: A process restart leaves an external intent unresolved
- **WHEN** restart finds an external dispatch intent whose outcome or termination cannot be confirmed
- **THEN** the workspace SHALL remain held for that unresolved effect
- **AND** the runtime SHALL NOT invent an approval request or redispatch the operation to clear the uncertainty

### Requirement: Suspended callers do not block approval drain

The drain set SHALL contain active leaf effects, not suspended orchestration wrappers.

A caller waiting for a child SHALL NOT count as active external work merely because its tool promise remains unresolved.

Exclusion from drain accounting SHALL NOT make a waiting session available for another execution.

Cancellation and finalization SHALL still account for actual child work and unresolved effects.

#### Scenario: A child critical read does not deadlock its parent
- **WHEN** a child requests approval for a permitted critical read while its caller waits
- **THEN** approval drain SHALL wait for active leaf effects, not the suspended caller wrapper
- **AND** the caller's session SHALL remain occupied
- **AND** the approved child operation SHALL remain subject to its independent execution controls

### Requirement: Workspace holds resolve through individual approvals

Approving one request SHALL NOT approve or resolve another.

After previously admitted work settles, only an individually approved critical operation MAY execute while ordinary admission remains closed.

At most one critical operation SHALL execute at a time per workspace. Rejected requests SHALL NOT execute.

Normal permission, mode, resource, and policy checks SHALL remain effective.

The gate SHALL reopen only after active effects are settled, the critical slot is empty, and all requests are closed.

Rejecting the initiating request SHALL NOT reopen admission while earlier work still drains.

Timeout, lost ownership, or uncertain storage SHALL NOT by themselves prove settlement.

Confirmed failures SHALL remain recorded without silent retry. Unresolved effects SHALL retain the hold until valid owner resolution.

#### Scenario: One approval leaves the other requests pending
- **WHEN** several requests exist in a held workspace and the owner approves one
- **THEN** only that reviewed operation MAY execute after active leaf work settles
- **AND** other requests SHALL still require their own decisions
- **AND** ordinary workspace work SHALL remain blocked

#### Scenario: Approved critical operations do not run concurrently
- **WHEN** several requests have approval in the same workspace
- **THEN** at most one critical operation SHALL execute at a time
- **AND** ordinary admission SHALL remain closed while critical work is active or requests remain unresolved

#### Scenario: Ordinary work resumes after the hold is resolved
- **WHEN** all requests are closed, active effects are settled, and no critical execution or unresolved effect remains
- **THEN** ordinary workspace admission MAY reopen
- **AND** terminal or unauthorized runs SHALL NOT resume merely because the gate reopened

#### Scenario: Uncertain execution retains the workspace hold
- **WHEN** critical execution has an unresolved outcome
- **THEN** the workspace SHALL remain held until valid owner resolution
- **AND** the runtime SHALL NOT retry the operation silently or clear the hold on restart

### Requirement: Owner outcome resolution does not invent execution evidence

Resolution SHALL identify the exact unresolved effect and observed outcome digest.

The owner SHALL stop the old executor and establish that no local or remote execution remains active. If that cannot be established, the hold SHALL remain.

The owner's screened evidence and assertion SHALL remain separate from the original runtime outcome.

The assertion MAY confirm an effect, confirm no effect, or acknowledge an unknown outcome after execution stopped.

Resolution SHALL be immutable, conflict-checked, and idempotent for equal submission identity.

It SHALL NOT rewrite results, fabricate advice, refund model work, or authorize retry.

#### Scenario: An uncertain operation is not automatically retried as a failure
- **WHEN** the runtime cannot confirm a critical execution outcome
- **THEN** it SHALL preserve the uncertain outcome
- **AND** it SHALL NOT relabel the attempt as failed merely to permit automatic redispatch

#### Scenario: The owner accepts an unknown outcome after stopping execution
- **WHEN** the owner establishes that execution stopped but its effect remains unknown
- **THEN** the owner MAY record an acknowledged-unknown resolution
- **AND** the original operation SHALL remain visibly uncertain
- **AND** that resolution SHALL NOT dispatch a tool call

#### Scenario: A stale executor might still act
- **WHEN** a new owner epoch exists but termination of an earlier executor is not established
- **THEN** the runtime SHALL NOT treat the epoch change as proof that external work stopped
- **AND** the workspace hold SHALL remain unresolved

#### Scenario: Rejection or cancellation occurs before dispatch
- **WHEN** a critical request is rejected or its run loses permission before dispatch intent
- **THEN** the operation SHALL close with a recorded non-execution result
- **AND** it SHALL NOT occupy a critical slot or fabricate a human decision

### Requirement: Approval inspection applies to every run

Ordinary run inspection SHALL expose workspace and approval state even when a run has no selected facets.

Live gate state and current revocation checks SHALL remain distinct from historical run data.

Inspection SHALL NOT infer execution from approval or instruction compliance from startup supply.

#### Scenario: A run without selected facets requires approval
- **WHEN** a run whose agents select no facets has a critical operation waiting for approval
- **THEN** ordinary inspection SHALL show its workspace and approval state
- **AND** absent installed definitions SHALL NOT hide the hold
