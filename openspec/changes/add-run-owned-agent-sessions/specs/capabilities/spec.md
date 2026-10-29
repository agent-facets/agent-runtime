# Spec Delta

## ADDED Requirements

### Requirement: Read-only discussion is distinct from task delegation

A configured agent MAY request discussion without a task-delegation relationship or membership in the permitted-entry set.

Discussion permission SHALL NOT grant additional data access, tools, or task-assignment authority.

Every discussion turn SHALL use discussion mode, including when its session contains earlier task-mode history.

The runtime SHALL NOT deliver discussion as executable task instructions to an unrestricted actor.

Discussion MAY read authorized information, analyze it, and return advice.

It SHALL NOT use mutating tools, delegate tasks, change its mode or permissions, or cause another actor to perform prohibited work on its behalf.

Further consultations SHALL preserve these restrictions. Messages SHALL NOT promote discussion into task assignment.

There SHALL be no conductor, manager, or privileged-agent exception.

Discussion SHALL use a synchronous, exclusive call and return advice through its parent result.

It SHALL NOT introduce background consultations, unsolicited messages, busy-session queues, active-session steering, or automatic compaction.

A consultation needing clarification SHALL return that need as advice rather than invoke the owner-question tool.

Ordinary task-mode callers and delegates SHALL retain their existing owner-question behavior.

#### Scenario: Consult without a task relationship
- **WHEN** Reviewer requests advice from a new Publisher session without a task-delegation relationship
- **AND** applicable access and resource checks pass
- **THEN** Publisher SHALL receive the request in discussion mode and MAY return advice from authorized information
- **AND** Publisher SHALL NOT publish or delegate publication
- **AND** the consultation SHALL NOT add Publisher to Reviewer's task targets

#### Scenario: A discussion request contains an action instruction
- **WHEN** discussion asks its recipient to post a comment, modify code, publish, or delegate that work
- **THEN** the receiving invocation SHALL remain in discussion mode
- **AND** the prohibited operation SHALL NOT dispatch even if its normal role permits it

#### Scenario: Further consultation preserves the restriction
- **WHEN** an agent in discussion mode starts another permitted consultation
- **THEN** the receiving invocation SHALL also remain in discussion mode
- **AND** the chain SHALL NOT gain mutation or task-delegation rights

#### Scenario: A privileged role cannot escape discussion mode
- **WHEN** an agent with broad normal permissions receives discussion
- **THEN** the same restrictions SHALL apply without a conductor or manager exception

#### Scenario: Discussion does not grant information access
- **WHEN** a consultation requests information outside applicable owner access restrictions
- **THEN** discussion eligibility SHALL NOT authorize the read or disclosure

#### Scenario: Consultation returns a need for clarification
- **WHEN** the topic and authorized reads do not supply information needed by a discussion turn
- **THEN** it SHALL return that need to its caller as advice
- **AND** it SHALL NOT ask the owner directly or interrupt another actor with an unsolicited message

#### Scenario: A discussion turn is read-only after earlier task work
- **WHEN** a caller consults an accessible idle session containing earlier task-mode turns
- **THEN** the new turn SHALL use discussion mode
- **AND** mutating tools and task delegation SHALL be refused before dispatch

### Requirement: Discussion targets are exact sessions owned by the current run

An agent configuration SHALL remain distinct from a durable session and an execution turn.

Each session SHALL have a unique identity, one immutable owning run, a selected retained configuration, its own conversation, and idle or active execution state.

Several sessions MAY use the same configuration. Their histories SHALL remain separate.

Discussion SHALL target either a new session of a retained configuration or an exact accessible existing session owned by the caller's run.

A new-session target MAY use the caller's configuration. An existing-session target SHALL NOT be replaced with a fresh or different session.

Permitted callers MAY reuse idle sessions within the same run. Each turn SHALL use that run's workspace, budget, retained definitions, and applicable controls.

A shared workspace SHALL NOT grant access to another run's sessions. Each new run SHALL start fresh sessions without automatic import of earlier history.

Terminal runs SHALL accept no new turns. Terminal status SHALL NOT establish that uncertain external effects stopped.

Run completion SHALL NOT itself delete session history. Authorized owner inspection SHALL remain separate from agent addressability.

This change SHALL NOT add automatic deletion, promise indefinite retention, or authorize cross-run memory extraction.

#### Scenario: Consult a new session of the caller's own configuration
- **WHEN** Reviewer requests a new session of its own configuration and applicable checks pass
- **THEN** the runtime SHALL create a distinct Reviewer session for discussion
- **AND** matching the caller's configuration SHALL NOT itself cause refusal

#### Scenario: Several sessions use one configuration
- **WHEN** a caller requests new Researcher sessions in two sequential operations
- **THEN** the runtime SHALL create two distinct session IDs
- **AND** each session SHALL keep its own history

#### Scenario: An existing-session target is not replaced
- **WHEN** a named session is busy, unavailable, or inaccessible to the caller
- **THEN** the runtime SHALL refuse the call
- **AND** it SHALL NOT substitute a new or different session

#### Scenario: Reuse an idle session within the run
- **WHEN** a caller names an idle session created by the same run and applicable checks pass
- **THEN** the runtime SHALL start a new turn in that session
- **AND** the turn SHALL use that run's budget, workspace, retained definitions, and execution controls

#### Scenario: A later run cannot address an earlier session
- **WHEN** a caller in a new run names a session created by an earlier run in the same workspace
- **THEN** the runtime SHALL refuse the call as unavailable
- **AND** it SHALL NOT resume the session, start a turn in it, or import its history

#### Scenario: A terminal run accepts no new turns
- **WHEN** a run becomes terminal while one of its sessions is idle
- **THEN** the runtime SHALL NOT start another turn in that session
- **AND** authorized owner history inspection SHALL remain available
- **AND** terminal status SHALL NOT be presented as proof that uncertain effects stopped

#### Scenario: Owner inspection does not make a session addressable
- **WHEN** the owner inspects session history from a finished run
- **THEN** inspection SHALL NOT make that session callable or add it to an agent-visible catalog

#### Scenario: A session in another workspace is not a target
- **WHEN** a caller names a session belonging to another workspace
- **THEN** the runtime SHALL refuse the call as unavailable
- **AND** it SHALL NOT disclose that session's content or status

### Requirement: Session discovery exposes scoped identities rather than transcripts

A model request offering discussion SHALL receive a runtime-supplied catalog of accessible sessions owned by its current run.

The catalog SHALL identify session ID, selected agent configuration, and busy status. It SHALL NOT expose transcripts or hidden reasoning.

The runtime SHALL derive the current run and caller access from trusted execution context, not model input.

Discovery SHALL query existing session records rather than a separate registry. It SHALL NOT introduce another model-facing discovery tool.

The catalog SHALL reflect a consistent view at preparation. Entries SHALL be ordered by session ID, and the exact catalog SHALL be retained with the prepared request.

A request without discussion capability SHALL NOT require this catalog.

Discovery SHALL NOT grant invocation permission. A later call SHALL repeat ownership, access, mode, depth, budget, and occupancy checks.

The catalog SHALL NOT introduce another session-count or message-size ceiling.

#### Scenario: Discover sessions without transcripts
- **WHEN** the runtime prepares a model request that offers discussion
- **THEN** its catalog SHALL identify accessible same-run sessions, their selected configurations, and busy status
- **AND** it SHALL contain no transcripts or hidden reasoning
- **AND** it SHALL exclude sessions owned by other runs, even in the same workspace

#### Scenario: Discovery does not authorize a later call
- **WHEN** a session shown as idle becomes busy before the caller invokes it
- **THEN** the runtime SHALL refuse the invocation as busy
- **AND** the earlier catalog SHALL NOT authorize a competing turn

#### Scenario: Model output cannot widen discovery
- **WHEN** model output names another run or workspace for discovery
- **THEN** it SHALL NOT expand the catalog's scope
- **AND** the catalog SHALL contain only accessible sessions owned by the caller's current run

### Requirement: Only the owner selects the agent of a session

Only the owner SHALL change a session's selected agent configuration.

Agent tools, discussion messages, delegated instructions, and model output SHALL NOT authorize that change.

The selected configuration SHALL belong to the owning run's retained catalog. Selection SHALL NOT read current deployment definitions or add a new configuration.

A selection change SHALL preserve session identity, owning run, conversation, workspace, provider, model, and consumed budget.

It SHALL preserve the current turn's mode and depth. A discussion turn SHALL remain read-only.

Changes SHALL remain inspectable and use durable submission identities. Equal retry SHALL return its original result without replacing a later selection.

New selection mutations for terminal runs SHALL be refused. Equal receipt replay SHALL still return its recorded result.

Independent permissions, grants, and restrictions SHALL remain effective. Selection SHALL NOT let agents manage their facets at runtime.

#### Scenario: The owner selects another retained agent for an idle session
- **WHEN** the owner selects retained Reviewer configuration for an idle Researcher session
- **THEN** the next turn SHALL use Reviewer unless another selection commits before preparation
- **AND** session identity, run, history, workspace, provider binding, and consumed budget SHALL remain unchanged

#### Scenario: An agent cannot change the selection
- **WHEN** model output, a discussion topic, or a delegated task requests another session configuration
- **THEN** that request SHALL NOT change the selection
- **AND** no agent tool SHALL perform the mutation

#### Scenario: Selection is limited to retained configurations
- **WHEN** the requested configuration exists in deployment but is absent from the run's retained catalog
- **THEN** the runtime SHALL refuse the selection
- **AND** it SHALL NOT add that configuration to the run

#### Scenario: A retry of an earlier change does not replace a later selection
- **WHEN** the owner changes A to B, then B to C, and retries the first change with its original submission identity
- **THEN** the runtime SHALL return the original first result
- **AND** the session SHALL remain selected as C

#### Scenario: A selection change does not widen authority
- **WHEN** the owner selects a configuration whose role permits a tool denied by an applicable owner restriction
- **THEN** the tool call SHALL remain refused before dispatch
- **AND** selection SHALL NOT supply the missing authority

#### Scenario: A discussion turn stays read-only after a selection change
- **WHEN** the owner selects a configuration with mutating tools during a discussion turn
- **THEN** the turn SHALL remain in discussion mode
- **AND** mutation and task delegation SHALL remain unavailable

#### Scenario: A terminal run rejects a new selection
- **WHEN** the owner submits a new selection mutation for a session whose run is terminal
- **THEN** the runtime SHALL refuse it
- **AND** it SHALL NOT reopen the run or change the session's selection

#### Scenario: Terminal state does not invalidate an accepted selection receipt
- **WHEN** the owner retries an accepted selection with the same submission identity and input after the run becomes terminal
- **THEN** the runtime SHALL return the recorded result
- **AND** it SHALL NOT apply the mutation again or reopen execution

### Requirement: Effective capabilities follow the selected agent configuration

Each model request's effective capabilities SHALL come from its captured retained configuration, turn mode, applicable restrictions, and current owner grants.

Historical instruction content SHALL NOT itself grant access to skills, references, tools, or delegation targets.

At preparation, instructions, skill catalog, startup requirements, and offered tools SHALL agree with the selected retained configuration.

Only configured startup skills SHALL receive automatic supply. Matching bodies already present in session history SHALL NOT be inserted again.

Each supply SHALL retain originating-turn and selection provenance without synthetic tool calls.

Each prepared request SHALL retain its agent configuration and tool definitions. Later selection changes SHALL NOT rewrite earlier bindings or digests.

#### Scenario: An earlier skill does not authorize a later reference read
- **WHEN** a session loads skill S under A and the owner selects B, which does not select S
- **AND** the runtime prepares a later request under B
- **THEN** S's earlier instructions SHALL remain history
- **AND** new requests under B to load S or read its bundled references SHALL be refused
- **AND** already-prepared work SHALL retain its captured configuration under the preparation-time switching rules

#### Scenario: Offered tools follow the selected configuration
- **WHEN** the owner selects B, whose facets supply a tool absent from A's selections
- **THEN** the next prepared request MAY offer that tool under applicable mode, classification, grants, and restrictions
- **AND** it SHALL NOT offer a facet tool supplied only by A

#### Scenario: Selected skills are not all preloaded
- **WHEN** the selected configuration has several available skills but only one startup skill
- **THEN** automatic startup supply SHALL be limited to that designated skill
- **AND** other skills SHALL remain discoverable until explicitly loaded
- **AND** earlier history SHALL NOT be erased or treated as new startup supply

#### Scenario: Earlier request bindings do not change
- **WHEN** the owner inspects a request prepared under A before a later selection of B
- **THEN** inspection SHALL show A and the tool definitions captured for that request
- **AND** its recorded definition digests SHALL remain unchanged

### Requirement: Discussion nesting uses the existing invocation-depth bound

Task delegation and discussion SHALL share the run's retained maximum depth.

The entry actor SHALL have depth 0. Each new task child or discussion turn SHALL use its current caller's depth plus 1.

The default SHALL remain 2. Depth SHALL use non-negative safe-integer validation without another policy maximum.

A maximum of 0 SHALL prohibit both kinds of child invocation.

The runtime SHALL check the bound before incrementing depth. Model input SHALL NOT override or reset it.

A turn SHALL keep its depth across all its requests. A later turn in the same session SHALL derive depth from its new caller.

Returning to a caller SHALL NOT add depth. Later sibling calls SHALL use the caller's depth plus 1 again.

Further discussion SHALL remain in discussion mode. It SHALL NOT permit task delegation.

Naming an ancestor's configuration for a new session SHALL create a distinct session and consume a depth level.

Targeting an occupied session in the waiting chain SHALL be refused as busy.

There SHALL be no separate discussion-depth setting or total discussion-call limit.

#### Scenario: A mixed path reaches the common depth bound
- **WHEN** a run with maximum depth 2 creates a task delegate at depth 1 and that delegate starts discussion
- **THEN** the discussion SHALL have depth 2 and remain read-only
- **AND** further child requests SHALL be refused before child creation

#### Scenario: Returning permits another sibling consultation
- **WHEN** discussion returns and its caller requests another permitted consultation within the remaining budget
- **THEN** the new consultation SHALL use the caller's depth plus 1
- **AND** completed siblings SHALL NOT accumulate nesting depth

#### Scenario: Naming an ancestor's configuration does not restore its authority
- **WHEN** a discussion turn requests a new session of an ancestor's configuration within the depth bound
- **THEN** the runtime SHALL create a distinct read-only turn at the caller's depth plus 1
- **AND** it SHALL NOT address the ancestor's session, task tools, or another workspace

#### Scenario: A session in the waiting chain is busy
- **WHEN** discussion targets its caller's session or another ancestor waiting for a child
- **THEN** the runtime SHALL refuse the call as busy
- **AND** it SHALL NOT start a turn there or substitute another session

#### Scenario: A reused session gets the depth of its new caller
- **WHEN** a session previously had a depth-2 turn and a later same-run caller at depth 0 consults it
- **THEN** the new turn SHALL have depth 1
- **AND** the earlier depth SHALL NOT limit the new turn

### Requirement: Agents know their remaining nesting capacity

Each task actor and discussion turn SHALL receive runtime instructions stating its mode, current depth, retained maximum depth, and remaining child levels.

Remaining levels SHALL equal maximum depth minus current depth.

The instructions SHALL identify the child interactions permitted by mode and depth. Values SHALL come from retained execution records, not model input.

They SHALL distinguish nesting capacity from a total call allowance and SHALL NOT imply a budget reset after return.

Below the maximum, task actors SHALL receive instructions that keep delegation and discussion subject to target and dispatch checks.

Discussion turns SHALL receive instructions permitting further authorized discussion but prohibiting task delegation.

At the maximum, instructions SHALL state that neither child interaction is available. Callers SHALL know that a child created at the maximum cannot create another child.

#### Scenario: No child capacity at depth zero
- **WHEN** an entry actor starts at depth 0 with a retained maximum of 0
- **THEN** its instructions SHALL show zero remaining child levels
- **AND** they SHALL state that task delegation and discussion are unavailable

#### Scenario: A task actor can plan one further level
- **WHEN** a task actor starts at depth 1 with maximum depth 2
- **THEN** its instructions SHALL show one remaining child level
- **AND** they SHALL explain that a depth-2 child cannot create another child
- **AND** target, permission, budget, and workspace checks SHALL remain applicable

#### Scenario: Discussion capacity does not permit task delegation
- **WHEN** discussion starts at depth 1 with maximum depth 2
- **THEN** its instructions SHALL describe one remaining discussion level
- **AND** they SHALL explicitly prohibit task delegation

### Requirement: Offered child tools respect depth and mode

At maximum depth, the runtime SHALL omit `tool__Delegate` and `tool__Discuss` from offered tools.

Discussion mode SHALL omit `tool__Delegate` at every depth.

Remaining depth alone SHALL NOT permit tool exposure. Applicable target, mode, and permission checks SHALL also pass.

Filtering SHALL preserve unrelated eligible tools and retained definitions.

Dispatch SHALL independently enforce depth, mode, target, permissions, budget, and workspace admission. Instructions and tool exposure SHALL NOT replace enforcement.

#### Scenario: Both modes omit child tools at the maximum
- **WHEN** a task actor or discussion turn reaches depth 2 under maximum depth 2
- **THEN** neither child-interaction tool SHALL be offered
- **AND** unrelated eligible tools and retained targets SHALL remain

#### Scenario: The model requests an omitted child tool
- **WHEN** a model requests delegation or discussion prohibited by its depth or mode
- **THEN** dispatch SHALL refuse it before child creation
- **AND** the request SHALL NOT override the retained depth or mode

### Requirement: Discussion tool use follows explicit tool policy

Discussion SHALL permit only independently authorized tools with a trusted read-only classification.

Required effect and critical declarations SHALL come from runtime or owner-controlled policy. Missing declarations SHALL prevent execution.

Critical reads SHALL still require their own approval.

Model output, tool names, descriptions, HTTP methods, and server claims SHALL NOT override explicit policy.

The runtime SHALL enforce discussion mode before dispatch regardless of model compliance.

Permitted runtime history, checkpoint, and budget bookkeeping MAY continue. That bookkeeping SHALL NOT authorize mutation of task resources.

The fixed policy of `tool__Discuss` SHALL NOT approve its child operations.

Discussion SHALL NOT expose task delegation, mutating tools, or `tool__AskUser`.

Sandbox write access and critical approval SHALL NOT override the discussion lock.

An explicit authored child prohibition SHALL block both task delegation and discussion within its scope. The restriction and its source SHALL remain inspectable.

#### Scenario: Authorized read-only tool use during discussion
- **WHEN** discussion requests an independently authorized read-only tool
- **THEN** it MAY execute under its resource, argument, and applicable critical-approval restrictions
- **AND** the runtime MAY record the operation and account for its execution

#### Scenario: A mutating tool is requested during discussion
- **WHEN** discussion requests a mutating tool normally available to the selected role
- **THEN** the runtime SHALL refuse it before dispatch
- **AND** a model claim that the call is harmless SHALL NOT override the mode

#### Scenario: Tool effects are not trusted or classified
- **WHEN** discussion requests a tool without a trusted read-only classification
- **THEN** that tool SHALL remain unavailable
- **AND** its name, HTTP method, description, or server claim alone SHALL NOT permit execution

#### Scenario: Discussion cannot use approval to gain write authority
- **WHEN** discussion requests mutation or task delegation despite writable storage or critical approval
- **THEN** the runtime SHALL refuse the request under the discussion lock

#### Scenario: Discussion cannot bypass an explicit authored child prohibition
- **WHEN** a command denies agent invocation through an empty authored agent restriction
- **THEN** task delegation and discussion under that command SHALL both be refused
- **AND** the restriction and its source SHALL remain available for inspection

### Requirement: Session startup supply is durable and replay-safe

A new session's initial startup supply SHALL be atomic with session creation, its first execution, and the corresponding creation history.

The complete required set SHALL be available before the affected first model request. Partial startup supply SHALL NOT permit execution.

Initial history SHALL identify the session, execution, selected configuration, retained skills, definition digests, origins, and installed versions.

Startup supply SHALL NOT create synthetic tool calls or separate per-skill startup activities.

Later turns SHALL reuse the session's instruction history without repeating initial activation.

At preparation after an owner selection change, required startup skills absent from that history with the same retained definition digest SHALL be supplied.

Supply SHALL retain its originating turn and selection provenance. It SHALL NOT erase earlier history or grant current authority.

Startup SHALL NOT itself dispatch a model request, consume a model step, or execute scripts.

Initial entry-startup failure SHALL prevent acceptance. A safely reported child-startup refusal SHALL return to its caller without itself failing the containing run.

Required startup failures SHALL NOT cause silent omission, partial success, or fallback to an earlier selection.

A repeated skill load SHALL check applicable availability and permissions before relying on earlier supply.

When use remains permitted and the retained skill is already supplied, the result SHALL identify that skill and version as already loaded without another body insertion.

Compatible continuation SHALL preserve captured startup context. Recorded supply SHALL NOT prove provider delivery or instruction compliance.

#### Scenario: Load a skill before an agent begins
- **WHEN** an agent starts with a valid selected startup skill
- **THEN** its first model request SHALL contain that installed skill's full instructions
- **AND** the run SHALL identify the responsible agent, skill, facet version, and startup activation
- **AND** startup itself SHALL consume no model step

#### Scenario: Startup skills appear within new-session history
- **WHEN** a new session starts with several configured startup skills
- **THEN** its creation activity SHALL show the complete startup list before its first model request
- **AND** inspection SHALL identify each retained skill, definition digest, origin, and installed version
- **AND** the runtime SHALL NOT add per-skill startup activities or synthetic tool calls

#### Scenario: A startup skill is requested again
- **WHEN** an agent requests an already-supplied retained skill and use remains permitted
- **THEN** the result SHALL identify the skill and version as already loaded
- **AND** it SHALL NOT report a missing skill or insert another copy of the body
- **AND** the load SHALL consume no extra model step while model requests retain normal accounting

#### Scenario: Independently configured startup activation is attributed separately
- **WHEN** two configurations independently designate the same selected startup skill and one invokes the other
- **THEN** each new session SHALL receive the skill before its first model request
- **AND** each activation SHALL identify its configuration and distinct execution

#### Scenario: A selection change supplies only missing startup skills
- **WHEN** the owner selects a configuration requiring startup skills A and B
- **AND** session history already contains A with the same retained definition digest
- **THEN** the next preparation SHALL supply B without inserting another copy of A
- **AND** history SHALL attribute B's supply to the preparing turn and selection change
- **AND** the runtime SHALL NOT record that supply as a tool call

## MODIFIED Requirements

### Requirement: Named delegation is bounded

An agent SHALL be able to delegate a specified task to a permitted configured agent and receive its result or failure.

Each caller's explicit target checks SHALL apply at every depth. An ancestor's outgoing list SHALL NOT replace a descendant's own list.

The caller SHALL wait for completion. Results SHALL return through the existing parent operation, not an unsolicited channel or independent background task.

A later request SHALL be a new operation subject to normal admission.

The entry invocation SHALL have depth 0. Each new delegated invocation SHALL use its caller's depth plus 1.

The runtime SHALL refuse a child beyond the retained maximum before it starts. Return to an existing caller SHALL NOT increase depth.

A new invocation of an earlier agent name SHALL still consume a depth level.

The depth setting SHALL remain separate from individual agents. Omission SHALL resolve to 2; explicit zero SHALL permit entry but no delegated child.

Explicit depth SHALL be a non-negative safe integer without another policy maximum. Invalid values SHALL be rejected without rounding, clamping, or default substitution.

A higher depth SHALL NOT increase or reset the shared model-step budget.

New runs SHALL have no separate delegation-call limit. Repeated calls SHALL remain subject to relationships, depth, usability, permissions, and remaining work budget.

The superseded `capabilities.maxDelegationsPerRun` setting SHALL be refused with migration guidance. It SHALL NOT be ignored or converted into depth.

Current run records SHALL NOT contain or enforce the removed call-count limit.

Safely handled delegation refusals and task failures SHALL return the target identity and reason without themselves failing the containing run.

Existing terminal failures, including shared-budget exhaustion, SHALL remain terminal when encountered by a delegate.

#### Scenario: Delegate a task and use its result
- **WHEN** an agent delegates a bounded task to a permitted configured target
- **THEN** the target SHALL receive the task and its retained instructions
- **AND** its result SHALL return within the same run
- **AND** a failed invocation SHALL remain distinct from a successful result

#### Scenario: Target checks apply to nested calls
- **WHEN** Coordinator permits Reviewer and Reviewer permits Researcher
- **AND** permissions and depth permit the chain
- **THEN** Reviewer SHALL be able to invoke Researcher without Coordinator listing Researcher
- **AND** Reviewer SHALL NOT invoke a target absent from its own list

#### Scenario: Use two delegation layers
- **WHEN** maximum depth is 2 and Coordinator delegates to Reviewer, which delegates to Researcher through permitted relationships
- **THEN** their depths SHALL be 0, 1, and 2
- **AND** Researcher SHALL NOT create a depth-3 child

#### Scenario: Omitted depth uses the default
- **WHEN** owner run configuration omits maximum delegation depth
- **THEN** a newly accepted run SHALL retain maximum depth 2

#### Scenario: Depth zero disables delegation
- **WHEN** a run has explicit maximum depth 0
- **THEN** its entry invocation SHALL remain permitted at depth 0
- **AND** delegated children SHALL be refused before creation

#### Scenario: An explicit depth exceeds eight
- **WHEN** configuration supplies a non-negative safe integer greater than 8 as maximum depth
- **THEN** numeric validation SHALL accept it without another policy ceiling
- **AND** execution SHALL still obey that depth, shared budget, and permissions

#### Scenario: An invalid depth is not normalized
- **WHEN** depth is negative, fractional, non-finite, or not exactly representable as a safe integer
- **THEN** validation SHALL reject it and identify the field
- **AND** it SHALL NOT round, clamp, or replace the value with a default

#### Scenario: The existing caller delegates again
- **WHEN** Researcher returns to Reviewer at depth 1 and Reviewer requests another permitted delegation
- **THEN** the new child SHALL have depth 2
- **AND** the earlier call SHALL NOT consume another nesting level or reset consumed budget

#### Scenario: An earlier agent name does not reset depth
- **WHEN** an actor at maximum depth requests another invocation of an earlier agent name
- **THEN** the runtime SHALL refuse the new child
- **AND** it SHALL NOT treat that invocation as return to an existing caller

#### Scenario: Repeated delegation has no separate count limit
- **WHEN** another delegation satisfies relationships, depth, permissions, target usability, and remaining budget
- **THEN** earlier delegation count alone SHALL NOT cause refusal

#### Scenario: Nested actors consume one model-step budget
- **WHEN** model work across entry and descendant actors exhausts the run budget
- **THEN** further model dispatch SHALL stop under the existing exhaustion rules
- **AND** a new child or return SHALL NOT create fresh budget

#### Scenario: The superseded call-count setting needs migration
- **WHEN** configuration contains `capabilities.maxDelegationsPerRun`
- **THEN** validation SHALL refuse it with guidance to use depth and the shared model-step budget
- **AND** it SHALL NOT ignore the setting or convert it into depth

#### Scenario: A run record with a delegation-call limit is refused
- **WHEN** a run record contains the removed delegation-call limit
- **THEN** the runtime SHALL refuse it as incompatible with the current format
- **AND** it SHALL NOT enforce, convert, or remove that field to continue the run

#### Scenario: Request an unavailable delegate or exceed a limit
- **WHEN** a requested target is unavailable, unlisted, or outside an applicable invocation limit
- **THEN** the runtime SHALL report the target and refusal reason without dispatching that delegation
- **AND** it SHALL NOT substitute another agent

#### Scenario: Request independent background delegation
- **WHEN** an agent requests parallel, background, or long-lived delegation outside the supported model
- **THEN** the runtime SHALL refuse rather than start independently continuing work

#### Scenario: A safely handled delegate failure
- **WHEN** a delegate returns a task failure after a safely refused tool call without a run-ending failure
- **THEN** its caller SHALL receive an identifiable failure rather than a fabricated result
- **AND** the caller SHALL remain able to continue within its permissions and remaining budget

### Requirement: Facets and delegates can only narrow authority

Each actor SHALL obey explicit tool policy, interaction mode, owner grants, sandbox and resource constraints, critical approvals, and applicable execution restrictions.

The runtime SHALL enforce those controls at dispatch, not only through instructions or offered tools.

A caller's selected catalog SHALL NOT become the target's catalog or authority ceiling.

Task delegation SHALL require an explicit relationship. An ancestor's outgoing list SHALL NOT become a global list for descendants.

Facet selection, instruction loading, and discussion SHALL NOT grant independent authority.

Authored restrictions SHALL retain their source and category semantics. Unsupported installed-agent bindings SHALL be refused rather than reinterpreted.

A role MAY permit specific writes without permitting all writes. The active interaction mode SHALL still constrain those permissions.

Returned advice SHALL NOT authorize subsequent operations. The recipient SHALL apply its own normal execution checks.

MCP grants SHALL identify server, tool, and supported argument restrictions. Resource constraints SHALL be enforced before dispatch.

Unsupported restrictions SHALL be refused rather than ignored.

These checks SHALL constrain requests. They SHALL NOT be presented as confinement of the server process's independent resource access.

Goal text, command arguments, instructions, and tool results SHALL NOT change accepted configuration or install additional facets.

#### Scenario: A facet requests more access than the owner granted
- **WHEN** a facet requests a tool or target outside the owner's grant
- **THEN** the runtime SHALL refuse the operation before dispatch
- **AND** the refusal SHALL identify the denied operation without performing it

#### Scenario: A delegate has a narrower tool set
- **WHEN** a delegate's applicable restrictions exclude a tool available to its caller
- **THEN** the delegate's call SHALL be refused
- **AND** further delegation SHALL NOT bypass a restriction whose scope applies to that work

#### Scenario: A reviewer can comment but cannot change code
- **WHEN** a reviewer's effective role permits review comments but prohibits source-code changes
- **THEN** task execution MAY post authorized comments without permission to modify code
- **AND** discussion mode SHALL permit neither comments nor code changes

#### Scenario: The target has a different selected tool catalog
- **WHEN** a permitted target selects an owner-authorized tool absent from its caller's catalog
- **AND** applicable restrictions permit the operation
- **THEN** the caller's catalog omission alone SHALL NOT prevent target use
- **AND** the target SHALL still pass its own role, mode, grant, and argument checks

#### Scenario: Instructions attempt to expand permissions
- **WHEN** a command, skill, delegated instruction, inspected file, or MCP response requests additional access
- **THEN** that content SHALL NOT change effective permissions or authorize the requested operation

#### Scenario: Repeated independent selection is not a server approval
- **WHEN** several agents select a facet whose server lacks applicable owner approval
- **THEN** those selections SHALL NOT authorize connection, launch, or tool dispatch
- **AND** inspection SHALL distinguish selection from missing approval

#### Scenario: Individual selection does not bypass an applicable execution restriction
- **WHEN** a delegate selects a tool excluded by an applicable owner, run-wide, command, or authored restriction
- **THEN** it SHALL NOT dispatch that tool even if broader deployment grants exist
- **AND** the refusal SHALL identify the restriction rather than treat selection as authority

#### Scenario: A task attempts to override selection
- **WHEN** goal text, command arguments, or instructions request an unselected facet or different delegation targets
- **THEN** the request SHALL NOT change effective configuration or install the facet
- **AND** execution SHALL remain within the configuration retained for the run
