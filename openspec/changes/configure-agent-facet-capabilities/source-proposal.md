# Proposal

## Review status

The owner approved the revised Decision 22: session execution metadata, owner-only agent selection at the next model request, and uniform configuration retention. The switching permission and timing questions are resolved. Detailed conversation, checkpoint, and session-interface contracts still need completion and review before implementation.

The owner approved the structural split of the former Decision 4 into Decisions 4 through 10.

The owner approved all 22 decisions and their listed revisions. Sessions are reusable only within their creating run. Decision 22 now uses session execution metadata and existing operations, without separate claim machinery. Only the owner can select another retained agent, effective at the next model-step preparation. All runs use uniform capability snapshots and bindings. Remaining detailed conversation, checkpoint, and discovery contracts still block implementation readiness.

The owner approved Decision 3: one current internal format and an explicit reset of disposable development records. This approval changes the planning artifacts only. It does not authorize deletion of runtime data or approve the other proposed decisions.

## Why

The runtime facet project is empty, and adopting the first real skill, `voice-to-text`, exposes two unnecessary barriers: mandatory runtime-specific author metadata and capabilities restricted to command-started runs. The owner needs to select reusable facets for agents through consuming configuration, without modifying the published facet or inventing a wrapper command.

## What Changes

- The owner SHALL configure each agent independently, including its instructions, selected facets, startup skills, and permitted delegation targets. There SHALL be no shared selection scope or separate root configuration type. Facet authors SHALL NOT need to know their consumers or add runtime-specific metadata merely to make portable contributions usable. Installation alone SHALL NOT select a facet for an agent.

- Facet selection SHALL select all installed, materialized contributions of that facet as availability candidates. This change SHALL NOT require additional per-agent allowlists for MCP servers, tools, skills, or commands. Installation omissions, compatibility, prerequisites, grants, and execution restrictions SHALL still apply. Skill activation and task-delegation relationships SHALL remain separate from facet availability.

- A separate owner-controlled entry policy SHALL identify permitted entry agents and a default within that set. Entry eligibility SHALL remain outside individual agent configurations. The console SHALL list only permitted entry agents and initially select the default. A request that omits the agent SHALL use the default; an unknown or ineligible explicit choice SHALL be rejected without fallback. The runtime SHALL enforce this policy independently of the console for goal runs and command runs.

- The same agent configuration SHALL apply when an agent starts a run or receives delegated work. Entry eligibility SHALL NOT grant delegation permission, and a delegate-only agent SHALL remain usable through permitted delegation relationships. Explicit delegation relationships SHALL apply at every depth; selecting a facet SHALL NOT implicitly add delegation targets.

- Discussion SHALL be distinct from task delegation. A caller MAY select a new session of any retained agent configuration, including its own, or an accessible existing session of its current run. A task-delegation relationship SHALL NOT be necessary. The receiving turn SHALL use discussion mode under applicable access and execution controls. Discussion SHALL NOT grant additional data access, tools, or task-assignment authority.

- Discussion mode SHALL permit authorized reads, analysis, and advice, but SHALL prohibit mutating tools, task delegation, mode changes, and indirect execution of prohibited operations. Further consultations SHALL retain that restriction. Messages SHALL NOT promote discussion into task execution. Agent instructions SHALL explain the mode, and the runtime SHALL enforce it before dispatch.

- **Approved discussion contract:** A synchronous `tool__Discuss` call SHALL create one consultation turn in a new or existing accessible session of the caller's run. Its target SHALL distinguish a new retained agent configuration from an exact existing session ID. It SHALL accept a nonblank topic and return screened final advice with session and consultation identities. Topic and result sizes SHALL follow the Message-size and monitoring policy.

- A session SHALL have idle or active execution metadata. Active state SHALL identify its existing execution and ownership epoch. Atomic state updates under the existing owner fence SHALL prevent competing executions. Waiting for a child, approval, or answer SHALL keep the session active. Busy targets and waiting ancestors SHALL be refused without queues or interruption. No separate claim table, lease service, or operation ledger SHALL be added.

- Only the owner MAY select another agent configuration for a session. The selection SHALL come from the run's retained configurations, not current deployment definitions. A switch SHALL preserve session identity, history, run, workspace, provider binding, mode, depth, and consumed budget. It SHALL remain inspectable and use the existing idempotent mutation pattern. Agents SHALL NOT acquire a switch tool or authorize selection changes through messages.

- Each model-step preparation SHALL capture the latest committed agent selection for its instructions and offered tools. Already-prepared requests and their resulting tools SHALL retain their captured configuration. A later selection SHALL affect the following preparation; several earlier changes SHALL resolve to the latest committed selection. Current owner revocations SHALL remain effective. Switching SHALL NOT interrupt work, create concurrent execution, or enqueue a user message. The console SHALL distinguish selected and already-prepared agents.

- Every session SHALL have an immutable creating-run identity. Agent discovery and targeting SHALL be limited to accessible sessions of that run, even within a shared workspace. Every new run SHALL start fresh sessions without automatic import of earlier conversations. Terminal runs SHALL admit no new turns, without claiming that uncertain effects have stopped. Run completion SHALL NOT itself delete retained history.

- Authorized owner inspection MAY examine old session history without making those sessions agent invocation targets. Future memory extraction, learning, or dreaming SHALL need separate design and approval. This change SHALL NOT implement those workflows, grant cross-run history access, or add old history to new model contexts.

- A consultation that needs clarification SHALL return that need to its caller rather than ask the owner directly. Ordinary task delegates SHALL retain their existing owner-question behavior.

- **Approved nesting:** Discussion and task children SHALL share the existing path-local maximum depth, including its default of 2 and explicit zero value. Each new child SHALL increase depth, while repeated sibling calls SHALL NOT accumulate depth.

- Each turn's system prompt SHALL state its retained mode, depth, maximum depth, remaining child levels, and permitted child interactions. A later turn in the same session SHALL derive depth from its current caller, not the session's creation depth. At maximum depth, the runtime SHALL omit delegation and discussion tools. Discussion mode SHALL omit task delegation at every depth. Unrelated eligible tools and retained targets SHALL remain. Continuation SHALL preserve that turn's block and independent dispatch checks.

- **Approved accounting:** Discussions SHALL share the run's model-step budget and provider binding without a separate call-count or tool-call budget. Pending parent wrappers SHALL NOT prevent the workspace approval barrier from draining active leaf effects.

- **Approved session context:** Acceptance SHALL retain exact configured definitions, including the caller's own configuration and targets outside the task graph. New sessions SHALL receive their own retained instructions, permitted tools, startup skills, runtime instructions, and topic. Existing sessions SHALL retain their own prior conversation without automatic caller or sibling context. Prior task authority SHALL NOT widen a later discussion turn's permissions. Native-only definitions SHALL NOT require an installation read.

- **Session conversation and recovery:** Session messages SHALL have stable identities, unique session order, and source execution or operation references. Conversation history SHALL remain separate from LangGraph execution checkpoints. A new consultation SHALL use the session's retained history through a new operation. Replay SHALL NOT append duplicate inputs or outputs. Resuming prepared work SHALL retain its captured context despite an owner selection change. Existing uncertain-effect protections SHALL prohibit automatic repetition of uncertain external work.

- **Pending session details:** Conversation, checkpoint, discovery, and owner-control interface shapes still need completion and review. Discovery SHALL query existing sessions of the trusted current run, without a separate registry or automatic transcript exposure. A discovered session SHALL still pass ownership, access, and busy-state checks before invocation.

- Historical instruction supply SHALL remain separate from current capabilities. Each preparation SHALL reconcile the selected agent's instructions, skill catalog, startup requirements, and offered tools. Only configured startup skills SHALL receive automatic supply, without duplicate bodies or synthetic tool calls. Earlier content SHALL remain history, not permission. Each model request SHALL retain its selected configuration and tool definitions without later rewrites.

- Each agent's facet-provided tool candidates SHALL come from its selected facets without a second tool-selection list. Independent owner grants, server approvals, definition digests, and argument restrictions SHALL remain effective. Read/write and critical declarations SHALL describe execution policy, not per-agent capability selection. The existing confined native-tool set SHALL retain its policy. A caller's catalog SHALL NOT become the target's authority ceiling. Applicable owner, run-wide, command, and authored restrictions SHALL constrain execution without silent reinterpretation.

- Tools SHALL have explicit read-only or mutating classifications and explicit critical designations supplied by runtime definitions or owner-controlled configuration. Missing required declarations SHALL prevent execution. Model output and external tool claims SHALL NOT override that policy. Runtime history, checkpoint, and budget writes SHALL remain permissible execution bookkeeping rather than task-resource mutation.

- **Approved control-tool exception:** `tool__Discuss` SHALL have fixed runtime-owned read-only, non-critical policy. The console SHALL display but not edit it. Each child leaf operation SHALL still require its independent owner classification, permissions, and any critical approval. The control tool SHALL NOT grant approval for unknown child effects.

- The runtime SHALL register tool definitions for owner inspection and classification after installation, authorized discovery, or native registration supplies them. Classification SHALL record `effect: "read" | "write"` and `critical: boolean`. A facet tool identity SHALL retain the selected facet, installed version, effective server ID, and tool name. A native identity SHALL retain its kind and native tool name. Classification SHALL bind the reviewed definition digest. Changed definitions SHALL require renewed classification.

- Model tool definitions and console labels SHALL use `tool__<name>` for native tools and `facet__<server>__<name>` for facet tools through MCP. The runtime SHALL retain structured identities separately from those names. It SHALL reject ambiguous effective server IDs and exposed names before it offers tools. Classification and prefixes SHALL NOT replace server approvals, grants, or argument restrictions.

- The runtime SHALL reserve `mcp__<server>__<name>` for MCP servers outside facets. This change SHALL NOT add standalone MCP configuration, agent access, discovery, or execution. Agent capability selection SHALL remain facet-based, without additional per-agent tool lists.

- Owner-managed classification records SHALL use the existing PostgreSQL application database's `runtime` schema. This change SHALL NOT introduce a separate database or datastore for classifications.

- Classification and execution-policy records SHALL use one current schema for each record type. Edits SHALL create immutable revisions without replacing the revisions bound to accepted runs or approvals. The runtime SHALL reject malformed records, unsupported sandbox variants, and unsupported restrictions. The first sandbox variant SHALL be Docker with validated settings. A run SHALL reference its workspace without a separate attachment lifecycle model.

- Critical approval requests SHALL bind the workspace, run, actor, existing operation identity, tool definition, policy revisions, target, and exact arguments or immutable change artifact. Immutable approve/reject decisions SHALL bind the reviewed request digest. One authoritative resolution SHALL govern each request. Approval SHALL remain separate from execution, and repeated submissions SHALL NOT independently redispatch work. Uncertain execution SHALL NOT be relabeled as failure to enable an automatic retry.

- **Approved record contracts:** Every accepted run SHALL retain configured agents through the existing capability snapshot and run binding. Facet-free goals SHALL use `installation: { kind: "none" }` and empty installed-definition collections, without installation reads or MCP discovery. There SHALL be no unbound native-goal path or separate native-only configuration record. Snapshots SHALL preserve exact definitions, mode-specific usability, and immutable policy references. The runtime SHALL refuse unsupported installed-agent bindings without name substitution or discarded restrictions.

- **Approved development reset:** The runtime SHALL support one current internal format without format-version bumps, legacy decoders, or old-record compatibility paths. An explicit reset SHALL remove disposable runtime records and create the current database schema without a data-preservation migration. The procedure SHALL identify its targets and obtain separate owner approval before deletion. It SHALL NOT delete workspace files, repositories, owner configuration, credentials, or upstream facet sources. It SHALL NOT reset unrelated databases or services. Normal startup SHALL NOT delete records automatically.

- The installation procedure SHALL regenerate runtime adapter exports and sealed bundles from configured facet sources. The runtime SHALL NOT resume pre-reset runs or preserve their request identities. Current records SHALL retain integrity, permission, replay, and continuation checks. Immutable policy revisions, record identities, and content hashes SHALL remain. Upstream facet formats, dependency versions, `/api/v1`, and explicit authored `runtimeVersion: 1` settings SHALL remain unchanged.

- **Approved workspace admission:** PostgreSQL SHALL arbitrate workspace admission and effect accounting under the existing owner fence. Request creation and gate closure SHALL be atomic. Only previously admitted leaf work MAY settle after closure. Suspended callers SHALL NOT block drain. Approved execution SHALL use one workspace slot and the existing operation ledger, without a second send on retry or restart.

- **Approved recovery:** A durable held state SHALL preserve checkpoint and caller-chain identity without an owner question or extra model charge. Unresolved effects SHALL retain the workspace hold. Explicit owner resolution SHALL require the old executor to be stopped and SHALL record an assertion separately from runtime evidence. Resolution SHALL NOT fabricate a result or authorize a retry. Database fencing alone SHALL NOT be described as exactly-once remote execution.

- **Approved owner interfaces:** New starts SHALL submit an owner-registered workspace ID and MAY submit an eligible entry agent. Definition-bound classification saves, individual approval decisions, and uncertain-effect resolutions SHALL have durable submission identities and conflict checks. Collection views SHALL use bounded pages rather than fixed agent or invocation count limits. Owner controls SHALL retain the existing private deployment boundary and SHALL NOT claim named-human authentication from Host or Origin checks.

- Classification, execution-policy, approval-request, and approval-decision records SHALL use the existing PostgreSQL `runtime` schema. Producer provenance SHALL NOT grant authority by itself. A future classifier needs an explicitly supported authorization contract; Jev integration and automatic classification remain out of scope.

- The owner SHALL inspect and edit classifications through a Tool classifications page under Configuration in the browser console. It SHALL list registered native and MCP tools with their origin, applicable facet version, and status. Explicit Save SHALL bind Read/Write and critical choices to the displayed definition digest and persist them in PostgreSQL. Stale-definition saves SHALL be rejected. Opening the page SHALL NOT classify tools, execute them, or start MCP discovery. The page SHALL NOT change agent selections, server approvals, or independent grants. A raw JSON editor and separate classification CLI are out of scope.

- A deduplicated MCP tool SHALL retain the explicit origin choice recorded during installation, including facet identity and installed version. The harness SHALL use that origin and the reviewed definition digest for classification lookup. It SHALL NOT merge classifications, choose an origin again, or require agreement from unselected origins. Missing selected-origin records or matching classifications SHALL leave the tool unavailable without fallback. Accepted runs SHALL retain their selected origin and policy despite later installation changes, subject to current independent owner revocations and continuation checks.

- Authorized task work MAY read, edit, and perform permitted tests within an enforced sandbox. Subprocesses SHALL NOT bypass its constraints. Remote tools SHALL remain subject to their own resource permissions; local filesystem confinement SHALL NOT establish confinement of remote effects. Tool permission or critical-operation approval SHALL NOT authorize sandbox escape or access outside the operation's permitted scope.

- The workspace SHALL be the isolation and lifecycle unit, with stable identity, persistent files, and an authoritative execution-policy revision. Several permitted runs or agent invocations MAY attach to it without merging their identities, histories, independent run budgets, or tool permissions. Agents in one workspace are collaborators; work needing mutual isolation SHALL use different workspaces.

- Each active workspace SHALL have at most one authoritative Docker sandbox instance. The initial profile SHALL use an owner-controlled pinned image, non-root user, dropped capabilities, no privilege escalation, a read-only root filesystem, persistent workspace storage, bounded temporary storage, enforced resource limits, and no task-container network access. Task containers SHALL NOT receive runtime state, Docker control, database credentials, or model-provider credentials. Model requests and permitted remote tools SHALL remain under trusted runtime control. Unavailable sandbox support SHALL NOT fall back to host execution.

- Workspace lifetime SHALL remain independent of a run or container. Finishing or cancelling one run SHALL NOT delete the workspace or stop infrastructure used by another invocation. A container restart SHALL use existing persistent files without filesystem rewind or a promise to restore background processes. Deletion SHALL be explicit and owner-controlled. The runtime SHALL prevent competing creation and teardown beneath active work without introducing a separate attachment state machine, automatic idle-stop, or automatic deletion.

- Workspace policy SHALL NOT change beneath active work or be widened by an attaching agent. Discussion restrictions and critical approvals SHALL remain independently enforced. Agents SHALL coordinate shared-file changes without a general locking or merge system. Critical execution SHALL use immutable arguments or frozen change artifacts, not mutable workspace contents at the same path.

- A workspace record SHALL identify its storage, execution-policy revision, and sandbox reference; a run SHALL reference its workspace. These application records SHALL use PostgreSQL, while file contents SHALL stay in workspace storage. Invocations SHALL use their run's workspace and SHALL NOT choose another through model arguments. Git save points SHALL be explicit owner or authorized-agent actions. The runtime SHALL NOT automatically snapshot, restore, roll back, synchronize, merge, or commit workspace files. Existing definition snapshots, execution checkpoints, run history, and approval records SHALL remain effective.

- A critical approval request SHALL close admission for all new agent work in its workspace before execution. Already-started work MAY settle under existing timeout and outcome rules, but its results SHALL NOT trigger further dispatch. New model requests, tool calls, discussions, and delegations SHALL remain blocked across all runs sharing that workspace. The owner controls and runtime bookkeeping SHALL remain available.

- After in-flight work settles, only an individually approved critical operation MAY execute, with at most one such execution at a time per workspace. Approval SHALL NOT resolve other requests. Ordinary work SHALL resume only when outstanding requests are resolved and authorized critical execution has finished, subject to run permissions and terminal states. Confirmed failures SHALL NOT be silently retried. An uncertain outcome SHALL retain the workspace hold until explicit owner resolution.

- Workspace approval queues and execution gates SHALL be independent. A hold in Workspace A SHALL NOT pause Workspace B. Cross-workspace agent discovery, communication, and delegation are out of scope. Owner management of several workspaces SHALL NOT imply agent access across them.

- Operations designated critical SHALL require human approval before execution on every exposed route, including wrappers and remote tools. Approval SHALL identify the operation, target, and exact arguments or change. Changes to that scope SHALL require new approval, and approval SHALL NOT authorize unrelated future operations. Non-critical work SHALL still pass ordinary permission, sandbox, mode, and budget checks. Discussion SHALL remain read-only regardless of sandbox write access or critical approval.

- Supplied default settings SHALL include an ordinary agent configuration that preserves the existing native behavior, with empty facet, startup-skill, and delegation-target lists. The supplied entry policy SHALL permit that agent and select it as the default. Accepted runs SHALL retain their entry identity, and accepted retries SHALL return the original run before current entry-policy checks.

- The runtime SHALL support multiple delegation layers within a finite depth limit. The entry invocation SHALL have depth 0, and each new child SHALL have its caller's depth plus 1. Return to an existing caller SHALL NOT add a layer or reset consumed budgets.

- Runs SHALL use a finite delegation depth and the existing shared model-step budget, without a separate delegation-call limit. The runtime SHALL reject the superseded `capabilities.maxDelegationsPerRun` setting with instructions for the owner to update configuration. The reset SHALL remove old run records and their count limits.

- Owner-controlled run configuration SHALL contain the entry policy and maximum delegation depth, separately from individual agent configurations. An agent SHALL NOT increase or reset the run's depth limit. Each accepted run SHALL retain the depth limit used at acceptance.

- Omitted maximum delegation depth SHALL default to 2. Explicit depth SHALL be a finite, non-negative safe integer, with no additional policy maximum. Depth 0 SHALL disable delegation. Invalid numeric values SHALL be rejected without rounding or clamping. A high depth SHALL NOT expand the run-wide model-step budget.

- Configuration SHALL NOT impose a fixed agent-count limit or separate fixed counts for delegation targets and permitted entry agents. References SHALL still identify configured agents. Retained records SHALL NOT reintroduce an agent-count cap. Message and aggregate snapshot sizes SHALL follow the Message-size and monitoring policy. Separate facet-content and startup controls SHALL remain effective, with explicit failures and no truncation.

- Portable commands, skills, and agent instructions SHALL NOT require runtime-specific metadata. Absent, null, or empty runtime metadata SHALL mean no runtime-declared prerequisites or restrictions, without granting authority. Settings belonging to other coding tools SHALL NOT acquire runtime meaning. Non-empty runtime settings SHALL be validated against the supported behavior; supported requirements and restrictions SHALL remain enforced, and unsupported or malformed settings SHALL be refused. Migration SHALL NOT silently discard actual restrictions or grant authority.

- **BREAKING:** Independent agent configuration and explicit delegation relationships SHALL replace the flat `capabilities.allowSkills` and `capabilities.allowAgents` contract. Configurations containing the superseded fields SHALL be refused with migration guidance rather than silently mapped to all agents. Migration SHALL distinguish selection from independent tool grants and SHALL NOT broaden access. Deployments without capability configuration SHALL retain their existing native-tool behavior.

- Goal runs and command-started runs SHALL resolve capabilities from the consuming agent's configuration. Commands SHALL supply task instructions and supported task-specific constraints, not unlock a separate capability system. Selected skills, delegates, and approved MCP tools SHALL be usable without a command wrapper.

- Facet availability SHALL remain separate from instruction activation and tool authorization. Selected skills SHALL remain discoverable and loadable on demand. The owner MAY explicitly select startup skills whose instructions SHALL be present before that agent's first model request; loading them SHALL NOT itself consume a model step. Unselected startup instructions SHALL NOT be preloaded merely because their facets are installed. A facet's description alone SHALL NOT establish an enforced automatic-loading rule.

- Initial startup history SHALL appear within the new session's first execution event, not as separate per-skill events. That event SHALL identify the session, execution, agent, and initial startup supply. Session creation, initial supply records, and that event SHALL commit atomically. Later preparation after owner selection MAY require new startup instructions, with execution and selection provenance but no duplicate bodies or synthetic tool calls. Inspection SHALL distinguish instruction history, current capability, individual executions, and on-demand loads. Recorded supply SHALL NOT prove provider delivery or model compliance.

- Each run SHALL retain its entry identity, resolved agent configurations, task relationships, discussion availability, execution limits, and capability definitions. Retention SHALL cover discussion targets as well as task descendants. Later configuration changes SHALL NOT replace retained definitions, while current owner revocations SHALL constrain dispatch. Tool policy, interaction mode, sandbox constraints, and critical approvals SHALL remain enforceable. Agent identity, facet provenance, tool activity, approval decisions, and execution outcomes SHALL remain inspectable after compatible continuation.

- The first real proof SHALL install the published `voice-to-text` facet unchanged into the independent runtime facet project. A goal run with the skill configured for startup SHALL include its installed instructions in the entry agent's first model request, with identity and version recorded. A delegate that does not select that facet SHALL neither receive its instructions nor be allowed to load it. Another case SHALL configure the same facet and startup skill independently for both agents. Deterministic tests SHALL also prove nested delegation, depth rejection, and repeated calls from an existing caller without a budget reset. A bounded live smoke check SHALL demonstrate useful handling of dictated text. Production installation, deployment, grants, and live provider traffic SHALL remain separately approved operations.

## Message-size and monitoring policy

Ordinary user and agent messages SHALL have no independent application size ceiling. This includes goals, command text, owner-question prompts, text answers, delegated tasks, discussion topics, and advice. Deliberate answer-format constraints MAY remain, without a hidden universal byte ceiling. Encoding validity, credential screening, strict shapes, and permissions SHALL remain effective.

Implementation SHALL remove the message-field, HTTP message-route, inference-request, common model-message, common tool-result, and aggregate snapshot ceilings listed in the design. Runtime and deployment defaults SHALL NOT silently recreate them. Unrelated authentication and administration routes, facet-content validation, startup controls, approval artifacts, execution budgets, deadlines, and sandbox controls SHALL retain their separate rules.

The provider SHALL remain authoritative for request size and model context capacity. Subscription adapters SHALL NOT invent an inference-payload size policy. Reliable size and context failures SHALL remain distinct from other invalid requests and unknown failures. Local storage or serialization failure SHALL NOT be reported as provider rejection. The console SHALL show safe boundary explanations and preserve accepted input, without raw provider error bodies or silent truncation.

Monitoring SHALL be operational before enforcement of the removed limits stops. It SHALL measure message, provider-request, result, record, and checkpoint sizes; latency; failures; and reported token usage. Host measurements SHALL cover memory, concurrency, restarts, and out-of-memory terminations. The owner SHALL be able to inspect distributions and correlate failures with execution stages. Telemetry SHALL NOT duplicate message bodies or credentials. The implementation plan SHALL identify its destination, independent host source, and verification method.

Later application limits SHALL need a documented constraint or measured operational reason and separate owner approval. Monitoring SHALL NOT automatically impose limits. This policy accepts resource-exhaustion risk before provider rejection; monitoring does not promise recoverability or unlimited capacity. Live capacity experiments and deployment changes SHALL remain separately approved operations.

## Non-goals

- Dev Container interpretation, Kubernetes, additional sandbox backends, arbitrary repository-supplied lifecycle scripts, general file locking, automatic merges, and agent task allocation. Workspace sharing does not itself add a parallel scheduler.
- Separate attachment lifecycle records, automatic workspace filesystem snapshots or restoration, automatic commit schedules, idle-stop or deletion, and cross-workspace agent interactions. Existing execution records and retained capability definitions are not workspace filesystem snapshots.
- Agent-initiated facet installation, updates, removal, configuration edits, or self-expansion of authority.
- Background consultations, busy-session queues, active-session steering, automatic compaction, and cross-run session invocation. Retained history does not authorize future memory workflows or promise indefinite retention.
- Conductor, manager, or privileged-agent exceptions that permit mutation or task delegation from discussion mode.
- Per-run or console-side edits to an agent's configured selections, delegation targets, or the separate entry policy. Selecting a permitted entry agent SHALL select an existing configuration, not override it. Owner configuration SHALL take effect on restart, like existing operator grants.
- A general approval platform, capability marketplace UI, general agent editor, or automatic facet dependency installation. The specific critical-operation approval contracts described here are in scope.
- Rule-of-Two coloring, dynamic information-flow tracking, or an automatic critical-operation classifier.
- Finer-grained per-agent selection of MCP servers, tools, skills, or commands. Existing startup activation and explicit task-delegation targets remain in scope.
- VIPER integration, cross-run memory, or the PR-feedback workload.
- Universal coding-tool compatibility, arbitrary script or shell execution, broader MCP transports, or relaxed credential and permission boundaries.
- Changing the facet package format or requiring upstream authors to add consumer-specific configuration.
- Preservation, conversion, or continuation of pre-reset runtime records, and support for multiple internal record formats.

## Alternatives Considered

- Mandatory owner-authored compatibility declarations for every imported facet: rejected because portable instructions need no second opt-in marker; genuine requirements and restrictions remain distinct from selection.
- Relaxing admission only for skills: rejected because portable command and agent instructions have the same consumer-selection problem.
- Wrapping the skill in a command: rejected because ordinary goal runs would still lack configured capabilities.

## Capabilities

### New Capabilities

None. These changes extend existing product domains.

### Modified Capabilities

- `capabilities`: Independent agent configuration and explicit tool policy; task relationships and read-only discussion; sandbox constraints and critical-operation approval; portable admission; and startup versus on-demand activation.
- `execution`: Entry policy; goal and command parity; bounded task delegation; mode-enforced discussion; sandboxed task work and auditable critical operations; retained definitions and compatible continuation; and unchanged native behavior without capability configuration.

## Impact

Affected areas include facet exports, sealed bundles, owner configuration, capability resolution, run admission, retained definitions, skill context, delegation, and console interfaces.

The design SHALL specify the explicit development reset and regeneration of sealed inputs. It SHALL also define agent configuration, entry policy, task execution, discussion, tool policy, sandbox controls, critical approvals, replay, execution uncertainty, resource bounds, and startup context.

The reset SHALL remove pre-reset run records instead of converting them. It SHALL preserve owner configuration and authored restrictions. Runs accepted after the reset SHALL retain their exact definitions and normal continuation checks. Incompatible current runs SHALL fail continuation without replacement definitions.

This change uses explicit tool permissions, sandboxed task execution, and human approval for designated critical operations. It does not implement Rule-of-Two coloring, dynamic information-flow tracking, or an automatic critical-operation classifier.

The owner approved same-run sessions, session execution state, owner-only next-request agent switching, and uniform retention. The detailed conversation, checkpoint, and session-interface contracts still need completion and review before implementation-ready tasks are authored. Earlier adversarial reports describe previous designs, not approval of this revision.

Documentation informing this proposal includes the root [README](../../../README.md#capability-configuration)—Capability configuration, Runtime facets, Authority boundaries, and Runtime facets in a deployment—the [runtime installation guide](../../../deploy/runtime/facets/README.md), and the [capability configuration example](../../../deploy/runtime/config.capabilities.example.json). These SHALL be updated for consumer-owned selection, portable admission, activation, and migration. The runtime manifest and lockfile SHALL record the proof installation independently of editor facets.

Verification SHALL use fast unit, service, API, and process tests. Tests SHALL cover reset boundaries, schema initialization, regenerated bundles, admission, selection, goal-run use, isolation, permissions, snapshots, and current-run continuation. Browser tests SHALL remain a small smoke check, not the primary behavior suite. No additional version-pin test is needed.
