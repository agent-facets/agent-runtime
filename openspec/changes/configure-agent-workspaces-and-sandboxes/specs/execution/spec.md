# Spec Delta

## ADDED Requirements

### Requirement: Workspaces own shared execution environments

A workspace SHALL have a stable identity, persistent files, and an authoritative execution-policy revision. It SHALL own its sandbox environment.

Runs and invocations SHALL use their assigned workspace rather than own separate sandboxes by default.

Permitted invocations MAY share a workspace without merging actor identities, histories, tool permissions, or independent run budgets.

The shared model-step budget within one run SHALL remain effective.

Agents sharing a workspace SHALL be collaborators, not mutually isolated tenants. Work requiring mutual isolation SHALL use different workspaces.

Workspace sharing SHALL NOT promise conflict-free edits or introduce general file locking, automatic merges, task allocation, or a parallel scheduler.

A run SHALL reference its workspace. Model-generated arguments SHALL NOT select another workspace or widen its policy.

Facet selections, discussion restrictions, owner grants, and critical approvals SHALL remain independently enforced.

Owner management of several workspaces SHALL NOT grant agents cross-workspace discovery, communication, or delegation.

#### Scenario: Several agents use one workspace
- **WHEN** several permitted invocations use the same workspace
- **THEN** their workspace operations SHALL use its authoritative sandbox and persistent files
- **AND** actor identities, histories, tool permissions, and applicable run budgets SHALL remain distinct
- **AND** workspace use SHALL NOT reset consumed model steps

#### Scenario: Different workspaces remain isolated
- **WHEN** two workloads use separate workspaces
- **THEN** their task storage and sandbox execution SHALL remain separate
- **AND** permission to use one workspace SHALL NOT authorize access to the other

#### Scenario: An agent requests incompatible workspace policy
- **WHEN** an invocation would require policy different from the workspace's authoritative revision
- **THEN** the runtime SHALL reject it rather than reconfigure or widen the workspace silently
- **AND** existing active work SHALL retain its policy

### Requirement: The first workspace sandbox backend is Docker

Each active workspace SHALL have at most one authoritative Docker sandbox instance.

Concurrent provisioning SHALL NOT create competing instances. The runtime SHALL use an owner-controlled pinned image and validated policy.

Task containers SHALL run non-root, without privileged mode, with dropped Linux capabilities and privilege escalation disabled.

They SHALL have a read-only root filesystem and enforced resource limits. Writable storage SHALL be restricted to persistent workspace storage and bounded temporary storage.

The initial profile SHALL disable task-container network access.

Docker control, private runtime state, database credentials, and model-provider credentials SHALL NOT be available inside task containers.

The model loop, database access, and approval enforcement SHALL remain under trusted runtime control outside task containers.

The sandbox workload SHALL be an owner-approved MCP program using verified program content. This change SHALL NOT introduce arbitrary shell execution, native write tools, or native test tools.

Discovery SHALL obey the applicable program-placement, workspace-admission, and lifecycle controls.

Unavailable or unverifiable sandbox support SHALL reject affected execution without host fallback.

Dev Container interpretation, Kubernetes, additional backends, and repository-supplied lifecycle scripts remain outside this change.

#### Scenario: Concurrent workspace use provisions one sandbox
- **WHEN** several permitted invocations use a workspace that needs a sandbox
- **THEN** provisioning SHALL converge on at most one authoritative instance
- **AND** invocations SHALL use their run's workspace rather than select competing containers independently

#### Scenario: A task container cannot access runtime authority
- **WHEN** task operations execute inside the workspace container
- **THEN** it SHALL NOT have Docker control, runtime-state storage, database credentials, model-provider credentials, or direct network access
- **AND** permitted remote actions SHALL use the trusted runtime's normal permission and critical-approval checks

#### Scenario: Required sandbox support is unavailable
- **WHEN** the required Docker sandbox cannot be provisioned or used
- **THEN** the runtime SHALL reject affected execution explicitly
- **AND** it SHALL NOT execute the task on the host as a fallback

### Requirement: Workspace lifetime is independent of runs and containers

Workspace files SHALL use persistent storage separate from the disposable container.

Finishing or cancelling one run SHALL NOT delete the workspace or stop infrastructure still used by another invocation.

Stop, replacement, and explicit owner-controlled deletion SHALL remain separate lifecycle operations. The runtime SHALL coordinate them with active work.

A sandbox replacement SHALL preserve workspace identity and designated persistent files. It SHALL NOT promise restoration of processes or temporary state.

The runtime SHALL NOT automatically snapshot, restore, roll back, synchronize, merge, or commit workspace files.

Git save points SHALL require explicit owner or authorized-agent action. This change SHALL NOT introduce automatic idle-stop or workspace deletion.

Retained definitions, run history, execution checkpoints, and approval records SHALL remain distinct from workspace files. Continuation SHALL NOT imply filesystem rewind.

#### Scenario: One run finishes while another still uses the workspace
- **WHEN** one run finishes or is cancelled while another invocation remains active
- **THEN** cleanup SHALL NOT stop their shared infrastructure or delete the workspace
- **AND** the remaining invocation SHALL retain its workspace access and permissions

#### Scenario: A stopped workspace gets a replacement container
- **WHEN** an authorized lifecycle operation replaces a sandbox after coordinating active work
- **THEN** workspace identity and designated persistent files SHALL remain
- **AND** the runtime SHALL NOT claim that background processes or temporary state were restored

#### Scenario: Restart uses current files without filesystem recovery
- **WHEN** a workspace container restarts after files changed since an earlier Git commit or execution checkpoint
- **THEN** it SHALL use existing persistent files rather than restore an earlier filesystem state automatically
- **AND** retained execution records SHALL remain distinct from those files

#### Scenario: Finishing work does not create automatic save points
- **WHEN** agent work finishes or the workspace becomes idle
- **THEN** the runtime SHALL NOT automatically commit, snapshot, restore, stop, or delete the workspace
- **AND** an owner or permitted agent MAY create an explicit Git save point under normal tool rules

#### Scenario: Deletion cannot race active execution
- **WHEN** the owner requests deletion while a workspace has active or concurrently starting work
- **THEN** lifecycle coordination SHALL prevent deletion underneath that work
- **AND** finishing a run alone SHALL NOT authorize workspace deletion

### Requirement: Runtime records use one current strict schema

The runtime SHALL accept one current format for each retained execution record type.

This rule SHALL apply to runs, events, checkpoints, snapshots, operations, approvals, and related records.

An internal format selector SHALL NOT permit acceptance of an earlier format.

The runtime SHALL refuse records that do not match the current schema. It SHALL NOT convert, repair, or partly use them.

#### Scenario: New records have no format selector
- **WHEN** the runtime writes a new run, event, checkpoint, snapshot, or operation record
- **THEN** the record SHALL match the current strict schema for its type
- **AND** it SHALL NOT contain a numeric selector for an internal format, profile, or schema version

#### Scenario: A record in an earlier format is refused
- **WHEN** the runtime reads a run, checkpoint, or operation record that does not match the current strict schema
- **THEN** it SHALL refuse that record and identify the affected run or record
- **AND** it SHALL NOT convert it, use part of it, or continue work from it

#### Scenario: Current-format runs keep their execution guarantees
- **WHEN** a current-format run waits for an answer and the runtime restarts with the same current schema
- **THEN** replay, request idempotency, compatible continuation, history watermarks, and uncertain-outcome controls SHALL retain their existing rules
- **AND** the run SHALL keep its retained definitions, grants, and policy revisions
- **AND** recorded history SHALL remain inspectable

#### Scenario: Saved state in an earlier format does not continue
- **WHEN** a waiting run's saved state does not match the current strict schema
- **THEN** the runtime SHALL refuse continuation as "continuation unavailable" before accepting the answer or dispatching work
- **AND** it SHALL NOT decode an earlier format, convert the state, or reinterpret it with current agent configurations

### Requirement: The current record schema does not change the API path

Removal of internal format selectors SHALL NOT change the `/api/v1` route prefix.

Requests SHALL obey the current contract for each route.

#### Scenario: A client uses the existing API path
- **WHEN** a client calls an existing `/api/v1` route after the change to one current record schema
- **THEN** the runtime SHALL handle the call under that route's current contract
- **AND** the route SHALL NOT move to another version path

### Requirement: A development reset removes disposable runtime records

An explicit development reset SHALL remove only its approved disposable runtime records.

Those records SHALL include targeted runs, events, checkpoints, snapshots, operations, and dependent execution records.

The reset SHALL create the current schema without migrating data from the removed records.

#### Scenario: A reset leaves an empty current schema
- **WHEN** the owner runs an approved development reset with its exact targets identified
- **THEN** the targeted runtime records SHALL be removed
- **AND** the current schema SHALL contain no run, event, checkpoint, snapshot, or operation records from those targets
- **AND** data from the removed records SHALL NOT be converted into the current schema

### Requirement: A development reset preserves owner and external data

A reset SHALL NOT delete workspace files, source repositories, owner configuration, credentials, or upstream facet sources.

It SHALL NOT change a database or service outside its approved targets.

The procedure SHALL distinguish protected owner data from disposable execution records, including when they share storage.

Record ownership, lifecycle, and dependencies SHALL determine the reset inventory. A shared table or database SHALL NOT itself authorize deletion of protected data.

A reset SHALL NOT rewrite owner configuration or broaden selections, grants, or approvals.

#### Scenario: A reset keeps owner and external data
- **WHEN** an approved development reset completes
- **THEN** workspace files, repositories, owner configuration, credentials, and upstream facet sources SHALL remain unchanged
- **AND** databases and services outside the approved targets SHALL remain unchanged

#### Scenario: Owner configuration errors remain after a reset
- **WHEN** owner configuration contains a superseded field and a development reset completes
- **THEN** startup SHALL still refuse that configuration with migration guidance
- **AND** the reset SHALL NOT rewrite it or broaden selections or grants to make it valid

### Requirement: A development reset needs separate owner approval

The runtime SHALL NOT start a development reset automatically.

Startup, an upgrade, or an incompatible record SHALL NOT cause deletion or reset.

Approval of a change or design SHALL NOT count as approval to reset a deployment.

The reset interface SHALL separate `reset plan` from `reset apply --plan <digest>`.

Planning SHALL identify the database, exact targets, dependent records, protected records, and expected current schema without deleting data.

Application SHALL require separate owner approval for that plan, exclusive runtime ownership, and revalidation of the bound state.

A changed target or protected state SHALL require a new plan and approval.

Normal startup SHALL refuse an incompatible schema with reset guidance. It SHALL NOT run a destructive reset through its ordinary migration path.

#### Scenario: Startup finds a record in an earlier format
- **WHEN** startup finds a runtime record that does not match the current strict schema
- **THEN** the runtime SHALL refuse to use that record
- **AND** it SHALL NOT delete the record or start a reset

#### Scenario: A reset request lacks approval or exact targets
- **WHEN** a reset request lacks separate owner approval or exact targets
- **THEN** no record SHALL be deleted
- **AND** the refusal SHALL identify the missing approval or target

#### Scenario: Planning a reset does not delete records
- **WHEN** the owner requests `reset plan`
- **THEN** the output SHALL identify the target and protected-record inventory and the plan digest
- **AND** planning SHALL NOT delete the records

#### Scenario: The approved reset state changes
- **WHEN** the target or protected state differs from the approved reset plan
- **THEN** application SHALL refuse deletion under that plan
- **AND** the owner SHALL need a new plan and approval

### Requirement: Work from before a reset does not continue

After a reset, the runtime SHALL NOT resume, replay, or continue removed runs.

It SHALL NOT automatically retry removed start requests, answers, or operations, or retain their execution limits.

Accepted-request identities SHALL be removed with their targeted runs.

A later start submission SHALL undergo current admission checks as a new request. It SHALL NOT recover the removed run or its accepted-request status.

#### Scenario: An answer arrives for a removed run
- **WHEN** the owner submits an answer for a question from a removed run
- **THEN** the runtime SHALL refuse the answer and identify the run as unavailable
- **AND** it SHALL NOT reconstruct, start, or resume that run

#### Scenario: A client resends a request from before the reset
- **WHEN** a client resends a start request accepted before a reset
- **THEN** the runtime SHALL NOT return the removed run or apply its definitions or limits
- **AND** it SHALL evaluate the submission as a new request under current configuration and admission checks
