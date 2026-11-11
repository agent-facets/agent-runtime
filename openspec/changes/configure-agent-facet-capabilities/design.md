# Design

## Umbrella reference

This file retains the original decisions and approval history. It is not an implementation design for one executable change.

The [release roadmap](../ROADMAP.md) defines the numbered chain. The [scope map](./scope-map.md) allocates the decisions and detailed contracts to successors.

Implementation planning MUST use the successor that owns the work. This umbrella MUST NOT receive tasks or be applied alongside those changes.

The original proposal is preserved in [source-proposal.md](./source-proposal.md). Review notes below describe their historical approval checkpoints, not successor readiness.

The prompt session catalog and owner selection route are settled. Conversation, checkpoint, and owner-inspection details remain pending in item 08.

The native-run inspection test below is corrected to require its normal capability snapshot. This aligns it with the already-approved uniform-retention rule.

## Context

Read [proposal.md](./proposal.md#why) for the reason for this change. Read the capability and execution delta specs for the behavior contract.

The runtime has these limits at this time:

- The adapter needs `runtimeVersion: 1` for each text contribution. See `packages/facet-adapter/src/metadata.ts:73`.
- A ready export must contain runtime settings. See `packages/facet-adapter/src/export-record.ts:38`.
- The runtime has a verified installation with provenance and materialization choices. But operator configuration selects flat lists of skill IDs and agent IDs. See `packages/runtime/src/config/capabilities.ts:178`.
- A snapshot must have a command. See `packages/runtime/src/capabilities/records.ts:246`. Goal starts do not keep a snapshot.
- MCP preflight does discovery only for the servers that a command needs. See `packages/runtime/src/capabilities/preflight.ts:40`.

The persistence layer already keeps immutable definition snapshots. It records tool operations for each actor. It records on-demand skill membership in a transaction. An actor key is `root` or the digest of a delegation operation.

Loaded membership needs a successful tool operation at this time. See `packages/runtime/src/persistence/migrations/004-capability-records.ts:283`. Thus, it cannot correctly record startup supply. Continuation does a check of the exact execution-definition identity and checkpoint identity. See `packages/runtime/src/execution/continuation.ts:35`. If the runtime can read an old snapshot, this does not prove that the run can continue.

## Planning status

Decision 1 uses independent agent configuration and bounded nested delegation. Decisions 4 through 10 separate discussion from task execution and define tool policy, sandboxing, and critical-operation approval. The owner first approved their structural split only.

The owner approved all 22 decisions and their listed revisions. Sessions are reusable only within their creating run. Decision 22 now uses session execution metadata and existing operations, without separate claim machinery. Only the owner can select another retained agent, effective at the next model-step preparation. All runs use uniform capability snapshots and bindings. Remaining conversation, checkpoint, and owner-inspection contracts still block implementation readiness.

The approved partial adversarial reconciliation defines native bootstrap, a sandbox workload, a session catalog, the owner selection route, and a reset interface. The complete owner configuration shape, Docker launch and mount contracts, and provider name compatibility remain unresolved. The monitoring destination remains an implementation-plan prerequisite. This reconciliation does not make the design implementation-ready.

The item-by-item decision review is complete. The same-run session-scope question is resolved in Decision 21. The remaining session-specific contracts must be completed and explicitly reviewed before implementation.

The broad discussion and return-to-caller questions are replaced by the approved decisions. The owner approved Decisions 12, 13, and 15 with their earlier contracts and the listed session-related corrections. Tasks MUST NOT be presented as implementation-ready before session-contract completion, review, and reconciliation. Earlier adversarial reports describe previous designs, not approval of this revision.

## Terminology

In this design, each term below has one definition only.

| Term | Meaning |
|---|---|
| Selection | The facets that the owner configures for an agent. A selection controls availability. It does not give authority. |
| Startup skill | A selected skill that the runtime supplies before the first model request of an agent. |
| Agent | A configured unit with its own instructions, facet selections, startup skills, and delegation targets. |
| Entry agent | The configured agent at which a run starts. This is a role in a run, not a separate configuration type. |
| Actor | One invocation of a configured agent in a run. The first invocation has depth 0. |
| Session | One durable conversation owned by its creating run, with owner-selected agent configuration and execution metadata. Agent selection does not define session identity. |
| Turn | One execution episode in a session. Existing actor identities identify execution turns, not reusable sessions. Parent, mode, depth, and operation belong to the turn. |
| Discussion | A read-only consultation turn in a new or existing accessible session of the same run. It is not task assignment. |
| Delegation | Task assignment through an explicit configured relationship, subject to the target's permissions and execution restrictions. |
| Tool effect | The runtime-recognized classification of an operation as read-only or mutating. |
| Sandbox | The enforced resource and execution boundaries of a task. Remote tools also have their own resource permissions. |
| Workspace | A stable runtime resource that owns persistent files, an execution-policy revision, and a sandbox environment shared by permitted invocations. |
| Workspace gate | The orchestrator's admission control for all agent work using one workspace while critical approval or execution is outstanding. |
| Critical operation | An operation explicitly designated as requiring human approval before execution. |
| Plan | The resolution of selections, usability, and startup skills for one agent in one run. |
| Retained definitions | The exact definitions and selections that a run keeps when the runtime accepts it. |
| Current grants | The server approvals and tool grants in operator configuration at the time of an operation. |
| Native-only goal | An ordinary goal whose agent selects no facets. It retains the same capability snapshot and run binding as other goals. |

## Goals and Non-Goals

**Goals:**

- Keep these four items different in records and in inspection: installation admission, agent availability, instruction activation, and dispatch authority.
- Use one resolution contract for new goal runs and new command runs. Each actor gets the retained configuration of its agent.
- Keep agent configuration independent of entry roles, delegation depth, and execution permission checks.
- Separate read-only consultation from task assignment and direct tool use. Enforce the discussion restriction before dispatch.
- Keep tool permissions, sandbox constraints, read/write effects, and critical-operation approval distinct.
- Isolate workspaces from each other while letting permitted agents collaborate inside one workspace. Keep workspace lifetime separate from run and container lifetime.
- Keep accepted-request identity, permission narrowing, credential screening, and atomic actor history.
- Use the published `voice-to-text` installation as a real acceptance input. Do not make a CLI change or an SDK change a prerequisite.

**Non-Goals:**

- A new provider, a new graph framework, or changes to retained agent definitions during a run. Owner selection among those retained definitions is supported under Decision 22.
- Conductor, manager, or privileged-agent exceptions to discussion-mode restrictions.
- A general approval platform or a general hierarchy of named roles. Critical-operation approvals in Decision 9 are in scope.
- Rule-of-Two coloring, dynamic information-flow tracking, and automatic critical-operation classification.
- Dev Container interpretation, Kubernetes, additional sandbox backends, and arbitrary repository-supplied lifecycle scripts in this first implementation.
- A general file-locking, automatic merge, or agent task-allocation system. Workspace sharing does not itself add parallel scheduling.
- Background consultations, queued calls to occupied sessions, active-session steering, automatic compaction, and cross-run session invocation. Future memory extraction or dreaming needs separate design and approval.
- Automatic workspace filesystem snapshots, rollback, restore, synchronization, commit schedules, idle-stop, or deletion. Cross-workspace agent discovery, communication, and delegation are also out of scope.
- Runtime control from the front matter, descriptions, scripts, or hooks of other coding tools.
- Automatic conversion of old selections, repair of installations, approval of MCP services, or changes to live infrastructure during implementation verification.

## Decisions

### 1. Each agent has its own configuration and explicit delegation targets

The owner MUST configure each agent independently. Each agent configuration MUST define:

- **Identity:** The name used to select the agent or identify it as a delegation target.
- **Instructions:** The instructions that define how the agent works.
- **Facets:** The agent’s selected facets.
- **Startup skills:** The selected skills supplied before each invocation’s first model request.
- **Delegation targets:** The configured agents that this agent can call.

The configuration defines the agent directly. It MUST NOT require a reference to an existing native agent or an installed agent contribution.

This decision does not require a particular storage format. Optional reuse of instructions does not change these fields.

There MUST NOT be a shared selection scope. There MUST NOT be separate configuration structures for root agents and delegates.

An agent configuration MUST NOT inherit facet selections or startup skills from another agent. To give several agents the same selections, the owner MUST configure those selections for each agent.

**Entry agents and delegated invocations**

A run MUST identify its entry agent.

A separate owner-controlled entry policy MUST identify the agents permitted as run entry points and the default entry agent.

This policy MUST remain outside individual agent configurations. An agent MUST NOT declare its own entry eligibility.

Every entry-policy reference MUST identify a configured agent. The default MUST belong to the permitted entry set. Invalid policy configuration MUST be rejected.

Entry eligibility MUST NOT grant delegation permission. Absence from the entry set MUST NOT prevent an otherwise permitted delegation to that agent.

The entry agent is the first agent invocation in that run. It is not a different kind of agent configuration.

The same agent configuration MUST apply when that agent starts a run or receives a delegated task. Applicable execution restrictions can differ between those invocations.

Each invocation MUST have its own identity, instruction context, startup membership, and history. Several invocations of one configured agent MUST NOT become one actor.

**Entry selection**

The console MUST provide an agent selector for goal runs and command runs. It MUST list only permitted entry agents and initially select the default.

A start request MAY name a permitted entry agent. If the request omits that choice, the runtime MUST use the configured default.

The runtime MUST enforce entry eligibility independently of the console. It MUST reject an unknown or ineligible explicit selection without fallback.

Command availability MUST use the selected agent's configuration. Selecting a command MUST NOT change the entry agent.

The accepted run MUST retain its entry-agent identity. Later entry-policy changes MUST NOT replace that identity.

A retry of an accepted request MUST return the original run before the runtime reads the current entry policy.

**Compatibility default**

The supplied default settings MUST include an ordinary agent configuration that preserves the existing native behavior. Its facet, startup-skill, and delegation-target lists MUST be empty.

The supplied entry policy MUST permit that agent and select it as the default. The agent MUST use the same configuration structure as every other agent.

**Facet selections and startup skills**

Facet selection MUST control contribution availability for that agent. Installation alone MUST NOT select a facet.

An agent’s facet selections MUST select all installed, materialized contributions of those facets as availability candidates.

This change MUST NOT require additional per-agent allowlists for MCP servers, tools, skills, or commands.

Installation omissions, compatibility checks, prerequisites, owner grants, resource restrictions, and interaction-mode rules MUST still apply.

Finer-grained per-agent selection is out of scope for this change.

Availability MUST NOT imply startup loading of every skill body. Explicit startup designations and on-demand loading MUST remain separate from facet selection.

Facet selection MUST NOT implicitly add task-delegation relationships between configured agents.

Each facet reference MUST identify exactly one installed facet. Materialization aliases and omissions MUST remain effective.

Repeated facet references and startup skill references MUST resolve once. Effective lists MUST use a deterministic order.

Each agent MUST have a maximum of 128 facet references and 8 unique startup skills. The instruction-byte limits in Decision 14 MUST continue to apply.

A startup skill MUST belong to a facet selected by that agent. A startup designation MUST NOT select a facet implicitly.

Selection and startup activation MUST NOT grant tool authority.

**Explicit delegation relationships**

Each agent MUST have an explicit list of permitted delegation targets. Each target MUST identify a configured agent.

An absent or empty target list MUST permit no delegation.

Facet selection alone MUST NOT add delegation targets. A caller MUST NOT need to copy a target agent's facet selections into its own configuration.

The target list MUST apply whether the caller is the entry agent or a delegated invocation.

The target list describes that agent's outgoing delegation relationships. It does not describe all agents that descendants can call.

A configured relationship permits the runtime to consider a delegation request. It does not bypass permission checks, depth limits, budgets, or target usability checks.

**Delegation depth**

The owner-controlled run configuration MUST contain the entry policy and the maximum delegation depth.

Run configuration MUST remain separate from individual agent configurations. An agent MUST NOT increase or reset the run’s depth limit.

Each accepted run MUST retain the depth limit used at acceptance.

If run configuration omits the maximum delegation depth, the runtime MUST use 2.

The configured value MUST be a finite, non-negative safe integer. Depth 0 MUST permit the entry invocation but no delegated invocation.

The runtime MUST NOT impose an additional policy maximum on delegation depth.

Validation MUST reject negative, fractional, non-finite, or inexactly represented values. It MUST NOT round or clamp them.

Each child invocation MUST have its caller’s depth plus 1. The runtime MUST reject a child beyond the configured limit before it starts.

A high depth limit MUST NOT increase or reset the run-wide model-step budget.

This change MUST support multiple delegation layers.

The entry invocation MUST have depth 0. Each new delegated invocation MUST have its caller's depth plus 1.

The run MUST have a finite maximum delegation depth. A request that would exceed this limit MUST fail before the target starts.

Decision 19 applies this same bound to discussion children. The approved extension does not change the distinction between consultation and task assignment.

For a maximum depth of 2:

```text
Coordinator                         depth 0
└─ Reviewer                         depth 1
   └─ Researcher                    depth 2
      └─ Any new delegated agent    depth 3: rejected
```

A result or request returned to an existing caller MUST NOT create another delegation layer.

After Researcher returns, Reviewer MAY delegate again at depth 2. The target relationship, permission checks, and work budgets MUST still permit that call.

A new invocation MUST increase depth even when its target has the same agent name as an earlier invocation.

New runs MUST NOT have a separate limit on the total number of delegation calls.

Delegation depth MUST limit nested invocation layers. The existing run-wide model-step budget MUST limit model work across the entry agent and all descendants.

A new delegate MUST NOT receive a fresh model-step budget. Return to a caller MUST NOT reset consumed budget.

Repeated delegation MUST remain available while the configured relationship, depth limit, permissions, target usability, and remaining work budget permit it.

The runtime MUST NOT reject an otherwise permitted delegation solely because of the number of earlier delegation calls.

This decision does not introduce parallel execution or change its existing restrictions.

**Agent configuration capacity**

The runtime MUST NOT impose a fixed limit on the number of configured agents.

Delegation-target lists and the permitted-entry set MUST NOT have separate fixed count limits. Their references MUST still identify configured agents.

Record validation MUST NOT reintroduce a fixed agent-count limit for retained agent configurations.

The separate facet-content and startup limits MUST remain effective. Message and aggregate snapshot sizes MUST follow the Message-size and monitoring policy. A failure MUST identify its actual boundary, not report an agent-count failure.

**Ownership and validation**

The owner MUST control agent configuration. Agent instructions and tool results MUST NOT change selections, delegation targets, or execution limits.

Configuration changes MUST take effect on restart. Accepted runs MUST retain their agent definitions, selections, and delegation relationships.

Selection changes MUST NOT replace retained configuration. Current independent owner revocations MUST continue to constrain dispatch.

Validation MUST reject unknown configuration fields, malformed values, and ambiguous or unresolved references. Errors MUST identify the agent, field, reference, and safe cause.

The runtime MUST reject the superseded `allowSkills` and `allowAgents` fields with explicit migration guidance. It MUST NOT silently convert them into access for every agent.

This change MUST preserve independent server approvals, program approvals, tool grants, and credential rules.

Deployments without agent capability configuration MUST retain the existing native goal journey. This compatibility behavior MUST NOT require a separate root configuration structure.

**Rationale and alternatives:** Independent agent configuration separates agent identity from its role in a run. Explicit target lists describe the configured graph. A separate depth limit constrains its execution. Shared selections introduce inheritance that this model does not need.

### 2. Portable admission means that a contribution has no runtime settings

The adapter MUST process absent, null, and empty runtime metadata in the same way.

Before classification, the adapter MUST remove the installer-supplied `name` and `description` from the behavioral settings. Thus, metadata with only these identity fields is portable. An empty authored block does not need to remain distinct after installation.

This change needs no change to the upstream command-line interface (CLI), software development kit (SDK), or package format.

**Explicit runtime settings**

Non-empty runtime settings MUST use the explicit `runtimeVersion: 1` profile. The adapter MUST keep the validation rules for these fields:

- Commands: arguments, prerequisites, and restrictions.
- Skills: prerequisites.
- Bounded agents: prerequisites and restrictions.

The adapter MUST reject unknown fields, malformed values, unsupported versions, and unsupported declared execution behavior.

Owner configuration and bounded execution support nested delegation. Nested delegation MUST NOT need a new author metadata marker.

An SDK input type of `unknown` does not itself define a behavioral setting. The adapter MUST NOT use that input type as a reason to discard a malformed value.

Settings for other tools and front matter in primary files remain outside this classification. The runtime MUST NOT use them as runtime controls.

**Text export format**

Text exports MUST use this closed state union:

```text
Ready = {
  state: "ready", kind, name, description, body, companions,
  admission: { kind: "portable" }
           | { kind: "explicit", settings: RuntimeMetadataV1 }
}
Refused = { state: "refused", kind, name, reason, fields }
```

**Normalization rules**

- The adapter MUST normalize portable commands to optional raw text arguments, no prerequisites, and no restrictions.
- The adapter MUST normalize portable skills and agents to no prerequisites and no restrictions.
- The `$ARGUMENTS` substitution and the `## Owner input` append behavior MUST NOT change. Neither operation evaluates shell syntax.
- Explicit settings MUST keep their restrictions. This includes empty allowlists that block a category.
- A block with only `{ runtimeVersion: 1 }` is explicit. It uses its supported defaults. It does not give special authorization.

**Sealed definitions**

Sealed ready definitions MUST keep their normalized fields. They MUST also contain this admission union:

```text
admission: { kind: "portable" }
         | { kind: "explicit", runtimeVersion: 1 }
```

Validators MUST make sure that portable definitions have empty prerequisites and no restrictions. Portable command definitions MUST also have optional arguments. Refused records MUST NOT contain a usable definition.

These checks prevent a definition from being both portable and restricted.

**Reasons for this decision**

A tagged admission record explains compatibility without adding declarations that the author did not supply.

Rejecting `{}`, null, or identity-only metadata makes runtime settings mandatory again. This conflicts with portable admission.

Discarding incorrect non-empty settings can remove restrictions without an error. The adapter rejects those settings instead.

### 3. Use one current format and reset disposable development records

This application is in development. Existing runtime records do not need preservation.

**One current format**

The runtime MUST support one current internal record format. This change MUST NOT add format or profile version bumps, legacy decoders, or compatibility paths for old records.

Internal record schemas MUST NOT contain numeric fields whose sole purpose is to select an old format. Internal type names MUST NOT use version suffixes to distinguish old and new formats.

The runtime MUST validate current records against their complete schemas. It MUST reject malformed records, unsupported variants, and incorrect hashes.

**Explicit development reset**

Implementation MUST provide an explicit reset procedure for disposable development state. The procedure MUST identify its targets before deletion. The owner MUST approve execution separately.

The reset MUST remove old runtime records, including runs, events, checkpoints, capability snapshots, operation records, and related database records. It MUST create the current database schema without a data-preservation migration.

The runtime MUST NOT resume old runs, preserve their request identities, or convert their records into the new format.

The installation procedure MUST regenerate runtime adapter exports and sealed installation bundles from the configured facet sources. It MUST NOT convert old refusal records into usable definitions.

The reset MUST NOT delete workspace files, source repositories, owner configuration, credentials, or upstream facet sources. It MUST NOT reset unrelated databases or services.

Normal application startup MUST NOT delete records automatically.

**Reset interface**

The reset command MUST provide separate `reset plan` and `reset apply --plan <digest>` operations.

Planning MUST identify the database, exact disposable targets, dependent records, protected owner records, and expected current schema. It MUST NOT delete data.

The plan digest MUST bind the target state and protected-record inventory using the runtime's canonical hash rules.

Apply MUST require separate owner authorization for that exact plan. It MUST acquire exclusive runtime ownership and revalidate the plan before deletion.

A changed target or protected state MUST refuse application and require a new plan and approval.

The reset MUST classify records by ownership and lifecycle. It MUST NOT assume that every artifact or revision table is either wholly disposable or wholly protected.

Foreign-key dependencies MUST be resolved without deleting protected data through `CASCADE`.

Normal startup MUST refuse an incompatible schema with actionable reset guidance and MUST NOT perform the reset.

This change MUST NOT register a destructive `006` migration in the ordinary startup migration path.

**Correctness after the reset**

Records created after the reset MUST retain the normal integrity, permission, replay, and continuation checks.

An accepted run MUST retain its definitions and policy references. Later configuration changes MUST NOT replace that accepted context.

Policy revisions, record identities, and content hashes MUST remain. They identify specific data and decisions; they are not legacy format versions.

**External contracts**

This decision MUST NOT change upstream facet formats, dependency versions, or the existing `/api/v1` route prefix.

Explicit authored `runtimeVersion: 1` settings MUST retain their supported meaning. Removing internal format versions MUST NOT discard authored restrictions.

**Reason**

There are no old runtime records that need preservation. Support for multiple internal formats adds code and tests without a current user need. A development reset permits one implementation of the current contracts.

### 4. Resolve agent availability independently

**Review status:** Approved as written.

Task-delegation resolution MUST start at the entry agent and use the explicit delegation relationships of each configured agent. It MUST NOT infer task relationships from facet selection or discussion availability. A descendant's outgoing target list MUST NOT be intersected with its ancestor's outgoing target list. Those lists describe different edges, not inherited permission filters. Discussion eligibility is separate and does not need a task-delegation edge.

Each agent plan MUST contain its own facet selection, contribution candidates, startup IDs, and configured task-delegation targets. A task-only reachability check is insufficient for discussion. Decision 21 defines retained configurations and accessible sessions within the current run. First use MUST NOT substitute current deployment definitions.

An agent definition and an actor's execution context are different items. One configured agent can occur on several paths and in different interaction modes. The runtime MUST NOT cache one path's or mode's permission result as unconditional permission for every invocation of that agent.

**Design dependencies:** Classification uses PostgreSQL and the owner-only console page below. Classification identity and installer-selected origin lookup do not add per-agent selection lists. Docker provides workspace-level isolation. Decisions 12, 13, and 15 define the approved record, admission, and interface contracts. Decisions 18 through 22 define the approved discussion, depth, accounting, and session behavior. Deferred contract completion still blocks implementation.

An installed contribution MUST keep its `command:<name>`, `skill:<name>`, or `agent:<name>` ID after materialization. Aliasing and omission occur before consumer selection. The runtime MUST reject ambiguity. It MUST NOT resolve ambiguity by iteration order. The omitted items of a selected facet stay omitted. Selection MUST NOT materialize them again.

Availability MUST use these different dimensions:

```text
selection = { kind: "unselected" }
          | { kind: "selected", agent: AgentId }
usability = { kind: "usable" }
          | { kind: "unusable", reason, subject? }
activation = { kind: "on-demand" } | { kind: "startup" }
```

Usability rules:

- The runtime MUST examine usability only for selected materialized candidates. Inspection keeps omitted, unselected, and refused installation records as different records.
- The runtime MUST do a check of a prerequisite in the context where the contribution is used. An actor's applicable execution restrictions MUST remain separate from its agent's selected catalog.
- Requirements MUST NOT add selections.
- Cyclic or unavailable requirements MUST reject the dependent contribution, not unrelated candidates.
- A delegate startup failure is different from the decision that its caller can try that delegation.

**Rationale and alternatives:** Independent catalogs preserve specialization. Explicit task edges express assignment authority. Discussion remains read-only. Sandboxing permits authorized task work while explicit critical designations identify operations that need human approval. Ordinary permission, resource, credential, and budget checks remain effective. This model does not require dynamic context coloring or an automatic classifier.

### 5. Enforce tool permissions before dispatch

**Review status:** Approved as written.

Decision 19 adds approved depth-aware tool exposure. At the depth limit, the runtime MUST omit both child-interaction tools. Discussion mode MUST omit task delegation at every depth. Dispatch MUST enforce the same rules independently, without removing unrelated eligible tools or retained definitions.

**Tool permissions**

The following selection rule applies to facet-provided tools. The existing confined native-tool set remains governed by its runtime policy and applicable restrictions.

Each agent’s tool candidates MUST come from its selected facets. The runtime MUST apply independent owner grants and applicable resource and argument restrictions.

An agent MUST NOT need a second tool-selection list for contributions already selected through its facets.

Read/write classification and critical designation MUST describe tool execution policy. They MUST NOT act as additional per-agent capability-selection configuration.

Existing server approvals, definition digests, and supported argument restrictions MUST remain effective.

Tools MUST have an explicit read-only or mutating classification and an explicit critical designation.

Runtime definitions or owner-controlled configuration MUST supply those declarations. Model output MUST NOT change them.

**Remaining permission checks**

A tool without the required policy declarations MUST NOT be executable.

Existing owner grants, credential protections, and supported authored restrictions MUST remain enforced.

A caller’s selected tool catalog MUST NOT become the target agent’s tool catalog or authority ceiling.

Permission to delegate MUST come from an explicit configured relationship. That relationship permits task assignment; it does not bypass the target’s permissions.

Owner restrictions and applicable run-wide and command restrictions MUST constrain every affected invocation.

Existing authored restrictions MUST NOT be silently discarded or reinterpreted during migration.

An agent's tool permissions MAY permit specific writes without permitting all writes. For example, a reviewer MAY post review comments while remaining unable to modify source code. A sandbox MUST NOT grant a tool permission that the agent lacks.

MCP rules:

- An actor MUST have three items: a selection of the facet that declares the tool, a retained bound tool, and independent owner authority.
- An MCP call MUST satisfy explicit tool policy, current mode, resource permissions, and applicable owner, run-wide, command, and authored restrictions. The workspace gate MUST permit dispatch. Critical calls MUST have individual approval and use the approved-operation exception in Decision 13. The caller's selected catalog MUST NOT define the target's authority ceiling. Local confinement MUST NOT substitute for checks of remote resource permissions. Final policy and approval records belong to Decisions 12 and 13.
- The captured argument restrictions and the current argument restrictions MUST both pass.
- Current selections MUST NOT make an accepted run narrower or wider. Current grants MUST continue to narrow dispatch.
- Current grants that are wider MUST NOT increase the captured authority.

For each new operation, dispatch MUST apply these checks against the retained plan and restrictions of the actor that does the operation:

| Operation | Necessary checks |
|---|---|
| Native tool | Captured native authority, explicit tool policy, current mode, resource and sandbox restrictions, and approval if critical |
| Skill load | A usable skill in the retained plan of the actor, applicable restrictions, and explicit prerequisites that are satisfied at the time of the load |
| Skill reference read | The skill-load checks, the frozen loaded membership of the actor, and confinement to the retained resources |
| Discussion | A new retained configuration target or an exact accessible same-run session; exclusive turn admission, workspace admission, depth, budget, access, and read-only mode under Decisions 18 through 21 |
| Delegation | A caller outside discussion mode, a retained task target, applicable permissions and explicit operation policy, depth, budgets, and startup checks |
| MCP call | A usable retained actor tool, explicit effect and critical policy, current mode, resource permission, approval if critical, captured and current grants, equal digests, and argument restrictions |

Dispatch MUST NOT use current facet selections as authorization. A selection removal MUST NOT cause a "no longer permitted" rejection for an accepted run. The captured skill set and agent set of a run are retention bounds. They are not sufficient authorization. Plan membership of the actor and the applicable restrictions stay necessary.

### 6. Classify tools by exact identity and definition

**Review status:** Approved. The owner approved this replacement and its listed change-local follow-ups.

The classification values MUST be `effect: "read" | "write"` and `critical: boolean`. These values describe tool execution policy, not a per-agent selection list. A model MUST NOT assign or change these values.

Owner-managed classifications and fixed runtime declarations MUST remain subject to their respective rules.

**Tool names**

The runtime MUST use these names in model tool definitions and console labels:

| Tool origin | Name |
|---|---|
| Native runtime tool | `tool__<name>` |
| MCP server outside facets | `mcp__<server>__<name>` |
| Facet-provided tool through MCP | `facet__<server>__<name>` |

The prefixes `tool__`, `mcp__`, and `facet__` are literal strings. `<server>` is the effective server ID. `<name>` is the tool name within that server or the native runtime.

A tool supplied through a facet MUST use `facet__`, even when the runtime calls it through MCP. The prefix MUST identify the selected origin, not only the transport.

The prefix MUST NOT grant permission or establish a tool's effect.

**Standalone MCP scope**

This change MUST reserve `mcp__` for MCP servers configured outside facets. It MUST NOT add configuration, agent access, discovery, or execution support for those servers.

Standalone MCP support needs a separate design and approval. The runtime MUST NOT treat an unknown tool name as permission to connect to a server.

**Structured identity**

The runtime MUST retain structured identities separately from model-visible names:

```text
Native identity = {
  kind: "native",
  tool: <native tool name>
}

Facet identity = {
  kind: "facet",
  facet: <selected installed facet identity>,
  version: <installed facet version>,
  server: <effective server ID>,
  tool: <tool name>
}
```

The facet version identifies the installed source. It is not an internal record-format version.

The runtime MUST NOT reconstruct identity from a name split at `__`. Each exposed name MUST reference exactly one retained identity.

**Name conflicts**

After installation resolves aliases and alternative origins, each effective server ID MUST identify one selected server within the installation.

The runtime MUST reject ambiguous server IDs and exposed tool names before it offers tools to a model. It MUST NOT resolve conflicts by iteration order, truncation, or selection of another origin.

These checks MUST include conflicts caused by `__` within name components. Name construction MUST preserve the structured identity without ambiguity.

**Classification and definition changes**

A classification MUST identify the exact tool identity and the definition digest that the owner reviewed.

If the definition changes, the runtime MUST require renewed classification before execution. Existing server approvals, definition checks, and argument restrictions MUST remain effective.

**Selected origin**

When installation selects one origin from alternatives, the runtime MUST retain that choice, its facet identity, and its installed version.

The runtime MUST use that retained origin to find the classification for the exact identity and reviewed definition digest.

The model MUST NOT choose or override the classification origin.

The runtime MUST NOT merge classifications from other origins or select an origin again. It MUST NOT require classifications from unselected origins to agree.

If the selected origin or its matching classification is unavailable, the tool MUST remain unavailable. The runtime MUST NOT substitute another origin's classification.

**Authored native references**

Explicit authored `runtimeVersion: 1` references MUST keep their supported spelling.

| Authored reference | Retained identity | Exposed name |
|---|---|---|
| `mcp_Read` | `{ kind: "native", tool: "Read" }` | `tool__Read` |
| `mcp_Search` | `{ kind: "native", tool: "Search" }` | `tool__Search` |
| `mcp_AskUser` | `{ kind: "native", tool: "AskUser" }` | `tool__AskUser` |

This mapping MUST apply to native prerequisite entries and `restrict.native`. It MUST preserve restrictions and MUST NOT require changes to published facets.

**Provider carriage**

Canonical tool identity and provider wire spelling are different facts. The runtime MUST record both accurately where translation occurs.

The current Anthropic profile rejects the new canonical prefixes and therefore causes wire aliases. The OpenAI adapter also has a name-format and length rule.

These are current adapter rules, not proof of the subscription services' actual constraints.

Aliased wire names MUST NOT be reported as satisfying the approved model-visible naming requirement. This reconciliation does not authorize a naming exception.

Provider compatibility MUST be established before the naming requirement is declared complete. Any live check needs separate owner approval.

### 7. Manage classifications through the owner console

**Review status:** Approved as written.

**Owner-managed classification**

Owner-managed tool classification records MUST use the existing PostgreSQL application database, in the `runtime` schema. This change MUST NOT introduce a separate database or datastore for classifications.

The browser console MUST provide an owner-only Tool classifications page under Configuration.

The page MUST list registered MCP and native tools. It MUST show the tool name, selected origin, applicable facet version, and classification status.

The owner MUST be able to inspect the tool definition, select Read or Write, set its critical status, and explicitly save the classification.

Decision 18 adds a narrow exception for the runtime control tool `tool__Discuss`. Its fixed declaration MUST be visible but non-editable. The owner-editing rules continue to apply to leaf native and MCP tools.

Saving MUST persist the classification in the existing PostgreSQL `runtime` schema and bind it to the displayed tool-definition digest.

If the definition changes before saving, the runtime MUST reject the stale save and require review of the current definition.

Unclassified tools and changed definitions that need renewed classification MUST be clearly identified. Merely opening the page MUST NOT classify or execute a tool.

This page MUST NOT change agent facet selections, approve MCP servers, or grant tool access.

Classification changes MUST use an explicit Save action, not autosave. Registered-tool inspection MUST NOT silently start MCP discovery. A raw JSON editor and a separate classification CLI are out of scope for this change.

The runtime MUST register tool definitions for classification when they become available during installation, discovery, or native-tool registration.

The owner MUST be able to inspect each tool and assign its read/write classification and critical designation.

Tool execution MUST remain unavailable until the required classification exists. Classification MUST NOT approve an MCP server, grant tool access, or bypass existing restrictions.

Discovery needed to obtain a tool definition MUST obey the existing server-discovery approval rules.

**Native classification bootstrap**

The runtime MUST create an initial classification when it first registers an explicitly declared native tool. Registration and the initial classification MUST commit atomically.

The initial declarations MUST be:

| Native tool | Effect | Critical | Owner editable |
|---|---|---|---|
| `Read` | `read` | `false` | Yes |
| `Search` | `read` | `false` | Yes |
| `AskUser` | `read` | `false` | Yes |
| `LoadSkill` | `read` | `false` | Yes |
| `ReadSkillReference` | `read` | `false` | Yes |
| `Delegate` | `write` | `false` | Yes |
| `Discuss` | `read` | `false` | No |

`Delegate` is conservatively classified as mutating because it can assign work that changes task resources. Child operations MUST still pass their independent controls.

The runtime MUST NOT overwrite an owner revision during startup. A previously registered identity MUST NOT receive another bootstrap classification merely because its definition changed.

A changed definition MUST require renewed classification before execution. Missing or damaged classification state MUST NOT cause automatic permission expansion.

Bootstrap MUST NOT approve MCP servers, grant tools, or alter agent selections. Facet-provided tools MUST NOT receive automatic classifications.

### 8. Isolate workspaces with Docker and persistent storage

**Review status:** Approved as written.

**Sandboxed task execution**

Authorized task execution MAY read, edit, and perform permitted tests within an enforced sandbox.

Sandboxing MUST constrain the resources and execution routes available to the task. Subprocesses MUST NOT bypass those constraints.

Remote tools MUST remain subject to their own resource permissions. Local filesystem confinement MUST NOT be treated as confinement of a remote service.

Tool permission MUST NOT authorize sandbox escape. A critical designation or human approval MUST NOT grant access outside the operation’s permitted resource scope.

This change does not authorize arbitrary shell execution. Docker is the first supported sandbox backend under the workspace contract below.

**Sandbox workload**

The sandbox workload in this change is an owner-approved MCP program. This change MUST NOT introduce arbitrary shell execution, a native write tool, or a native test tool.

Server configuration MUST distinguish execution in the trusted runtime from execution inside the assigned workspace's Docker container.

Sandbox execution MUST use the verified owner-bound program, not an arbitrary command supplied by a facet or model.

Sandbox-hosted programs MUST receive no network access, credential environment, Docker socket, runtime-state storage, or provider credentials.

Program availability inside the container MUST preserve verified content and read-only access. Deployment MUST define the mapping between runtime paths and Docker daemon mount sources.

Discovery starts a process and MUST obey the same placement, workspace gate, and lifecycle controls as later tool execution.

Runtime-hosted connectors MUST NOT be described as sandboxed. A deployment MUST NOT claim read-only workspace confinement unless it actually enforces that boundary.

Missing or unverifiable placement controls MUST refuse the affected server without host fallback.

The complete owner configuration and Docker launch and mount contracts remain incomplete. Naming the workload does not make those contracts implementation-ready.

**Workspace isolation**

A workspace MUST be a first-class runtime resource with a stable identity, persistent files, and an execution-policy revision.

The workspace MUST own its sandbox environment. A run or agent invocation MUST attach to a workspace rather than own a separate sandbox by default.

Several permitted invocations MAY share one workspace. Sharing MUST NOT merge their identities, histories, budgets, or tool permissions.

The existing shared model-step budget within one run MUST remain effective. Attaching several runs to one workspace MUST NOT combine their independent run budgets or reset consumed steps.

Agents within one workspace are collaborators, not mutually isolated tenants. Work that needs isolation from other work MUST use a separate workspace.

**First Docker backend**

The first supported sandbox backend MUST be Docker.

Each active workspace MUST have at most one authoritative Docker sandbox instance. Concurrent attachment requests MUST NOT create competing instances.

The runtime MUST use an owner-controlled, pinned image and a validated execution policy.

Task containers MUST NOT receive the Docker control socket, runtime-state storage, database credentials, or model-provider credentials.

Containers MUST run without privileged mode, with a non-root user, dropped Linux capabilities, privilege escalation disabled, and enforced resource limits.

The root filesystem MUST be read-only. Writable locations MUST be restricted to workspace-owned storage and explicitly bounded temporary storage.

The initial profile MUST disable task-container network access. Model requests and permitted remote-tool operations MUST remain under trusted runtime control.

Missing or unavailable sandbox support MUST reject affected execution. The runtime MUST NOT silently fall back to host execution.

**Workspace and container lifetime**

Workspace files MUST use persistent storage separate from the disposable container.

Finishing or cancelling one run MUST NOT delete its workspace or stop infrastructure still used by another invocation.

Stopping or recreating a sandbox MUST preserve designated workspace files. It MUST NOT promise preservation of running processes or temporary state.

Workspace deletion MUST be an explicit owner-controlled operation, separate from stopping its container.

The runtime MUST NOT delete or replace a workspace beneath active work. It MUST coordinate attachment, stopping, recreation, and deletion.

This version MUST NOT introduce automatic idle-stop or workspace deletion. Workspace use MUST be represented by the simple run reference in Decision 12, not a separate attachment lifecycle model. Backend handles and coordination needed to prevent competing creation or teardown beneath active work remain implementation concerns.

**Workspace policy**

The workspace MUST identify the execution-policy revision governing its sandbox.

An attaching invocation MUST accept that policy or be rejected. Attachment MUST NOT silently widen access or replace the workspace’s policy.

A workspace policy MUST NOT change underneath active execution.

Agent facet selections, discussion restrictions, owner grants, and critical-operation requirements MUST remain independently enforced.

Discussion MUST remain read-only even when other agents can write to the shared workspace.

**Shared-file coordination**

The runtime MUST NOT promise conflict-free edits between agents sharing a workspace.

This change MUST NOT add a general file-locking, automatic merge, or agent task-allocation system.

Infrastructure lifecycle coordination MUST remain the runtime’s responsibility.

A critical approval MUST bind immutable arguments or a frozen change artifact. Execution MUST NOT substitute mutable workspace contents merely because they occupy the same path.

**Architectural references**

These are references, not dependencies or security guarantees:

- [Hermes Docker configuration](https://hermes-agent.nousresearch.com/docs/user-guide/configuration#docker-backend): shared execution environments and the distinction between file and process persistence.
- [Orca workspaces](https://www.onorca.dev/docs/model/worktrees) and [per-workspace environments](https://www.onorca.dev/docs/ways-to-run): explicit workspace identity and lifecycle, separate from agent sessions. A Git worktree alone is not a sandbox.
- [OpenClaw workspace access](https://docs.openclaw.ai/gateway/sandboxing/workspace-access): workspace access independent of sandbox placement.
- [OpenHands workspace architecture](https://docs.openhands.dev/sdk/arch/workspace): an execution-environment abstraction independent of conversation identity.

### 9. Approve exact critical operations within each workspace

**Review status:** Approved as written.

**Critical operations**

The runtime MUST require human approval before executing an operation designated critical.

Critical status MUST be explicitly configured for this version. Automatic classification is out of scope.

Critical status MUST remain separate from read/write classification. A permitted sandboxed file edit MAY be non-critical. A GitHub push or deployment MAY be designated critical.

Approval MUST identify the operation, target, and exact arguments or change to be executed.

A changed operation, target, or approved content MUST require new approval.

Approval MUST NOT authorize unrelated future operations.

The critical-operation gate MUST apply to every exposed route to that operation, including remote tools and wrappers.

Non-critical operations MUST still pass ordinary permissions, sandbox, mode, and budget checks.

Approval decisions and execution outcomes MUST remain inspectable.

**Workspace-wide coordination**

A workspace MUST be the scope of its execution gate and critical-approval queue.

Every agent invocation using that workspace MUST obey the same gate, including invocations belonging to different runs.

A pending approval in one workspace MUST NOT block execution in another workspace.

Agents MUST operate only within their assigned workspace. Cross-workspace discovery, communication, and delegation are out of scope.

Owner management of several workspaces MUST remain distinct from agent access to those workspaces.

### 10. Keep discussion read-only and separate from task delegation

**Review status:** Approved as written.

**Discussion is separate from task delegation**

Discussion MUST be a distinct interaction from task delegation.

Any configured agent MAY discuss with another configured agent without a task-delegation relationship. Owner access restrictions and run-wide resource controls MUST still apply.

Discussion permission MUST NOT grant access to additional data or tools.

A discussion MUST place the receiving invocation in discussion mode. The runtime MUST NOT treat the request as executable task instructions for an unrestricted actor.

Task delegation MUST continue to require an explicit configured target. Discussion MUST NOT implicitly create that relationship.

**Discussion-mode restrictions**

In discussion mode, an agent MAY read authorized information, analyze it, and return advice.

An agent in discussion mode MUST NOT:

- Use a mutating tool.
- Delegate a task.
- Change its mode or permissions.
- Cause another actor to perform a prohibited operation on its behalf.

Any further discussion caused by that invocation MUST preserve the discussion restriction.

Message content MUST NOT promote a discussion into task delegation. A request such as “publish this now” MUST NOT change the mode.

Returned advice MUST NOT itself grant authority to act. Any subsequent action MUST pass the recipient’s normal execution checks.

This change MUST NOT provide a conductor, manager, or privileged-agent exception.

Discussion mode MUST remain read-only. It MUST prohibit mutating tools, task delegation, and mode escape.

A writable sandbox or critical-operation approval MUST NOT override the discussion lock.

Discussion MAY return advice. Subsequent task execution MUST receive normal authorization.

This change MUST NOT introduce conductor or privileged-agent exceptions.

**Tool effects and enforcement**

Every executable tool MUST have the explicit effect and critical-policy declarations described above.

Discussion mode MUST permit only tools classified as read-only and independently authorized for that invocation.

An unclassified tool MUST be unavailable in discussion mode.

Classification MUST describe the operation’s effects. A tool name, description, or HTTP method MUST NOT establish that it is read-only.

External tool declarations alone MUST NOT override runtime or owner-controlled tool policy. This version MUST NOT infer policy through an automatic classifier.

Agent instructions MUST explain the active mode. The runtime MUST also enforce it before dispatch, regardless of model compliance.

The restriction concerns mutations to task resources. Runtime history, checkpoint, and budget records MAY still be written as necessary for execution and audit.

### 11. Goal and command admission bind approved MCP tools under one bounded policy

**Review status:** Approved as written.

Start modes:

- Both start modes MUST resolve the same configured capabilities.
- A command adds its retained task definition, arguments, prerequisites, and narrowing restrictions. It MUST NOT add facets, delegates, or tool grants.
- After configuration validation, the supplied default in Decision 1 MUST preserve native goal behavior without facet installation access. Contract 12A and Decision 21 govern native configuration and session retention, including new sessions of the caller's own configuration.
- A native-only start MUST NOT read an installation or do MCP discovery. It MUST retain the native configuration and session context needed by its turns.
- If the entry agent has a startup designation but no selected facets, the runtime MUST reject the start as `startup_skill_unavailable`. It MUST NOT fall back to native operation.
- An empty entry-agent selection does not make an installed command selectable.

Discovery candidates:

- For configured starts, discovery candidates MUST account for permitted task execution and read-only discussion. Explicit tool policy, resource permissions, exact server and program approval, and a minimum of 1 applicable tool grant limit this set. Discussion availability MUST NOT make mutating tools callable in discussion mode. Discovery MUST obey the configured process and resource restrictions.
- The runtime MUST NOT contact unselected, unapproved, denied, unsupported, or statically restricted servers.
- Explicit inspection by the owner with discovery-only approval stays available as a different operation.
- If applicable authority excludes a server from every permitted invocation context, it MUST NOT be a discovery candidate. Decision 21 adds read-only discussion turns to this test. The earlier delegation-only candidate rule MUST NOT be used as a fallback.

Admission MUST initialize, list tools, and close each candidate. It MUST NOT call a tool. The per-server limits on time, pages, and tools MUST stay. The time limit for each server is 15 seconds.

Admission MUST also have an overall discovery deadline of 15 seconds and a maximum of 2 concurrent inspections. The candidate order MUST be deterministic, with required entry-agent prerequisites before optional candidates. When the deadline expires, the runtime MUST cancel and close the sessions that are not complete. Tests MUST inject deadlines and discovery results. They MUST NOT wait for these bounds.

Discovery results:

- The runtime MUST keep a discovery result for each server and tool. A result is `bound`, with approved definitions and digests, or `unavailable`, with a safe reason.
- The runtime MUST make callable only the tool definitions that are supported, granted, and equal to their grant.
- A name collision MUST exclude each tool in the collision. The runtime MUST NOT select a winner.
- The runtime MUST preserve originating references and the explicit origin selection recorded during installation.
- Historical origin references MAY remain visible for provenance. Only the installation-selected origin MUST determine classification lookup for the deduplicated tool.
- Runtime discovery MUST NOT invent or replace the selected origin.

Optional failures:

- An optional failure MUST remove only that server or tool from the usable catalog of the run. The runtime MUST record the reason.
- An optional failure MUST NOT cause a goal or a command that is otherwise correct to fail.
- If the unavailable tool is an explicit prerequisite of the selected command or of an entry-agent startup skill, admission MUST reject the start.
- If an on-demand skill or a delegate needs the tool, that contribution MUST become unusable. Use of the contribution MUST then fail in its own scope.
- An unrelated delegate startup problem MUST NOT block entry-agent admission.
- A discussion-only usability problem MUST remain scoped to that interaction. It MUST NOT grant mutation rights to make an agent usable in discussion. Decisions 18 and 21 define the corresponding refusal and startup checks.

Each optional discovery failure that removes an eligible server or tool MUST also add a `capability.unavailable` history event. The event MUST be in the acceptance transaction. Its payload MUST be `{ subject, reason, affectedAgents }`. The `subject` is `mcp:<serverId>` or `mcp:<serverId>/<toolName>`, and `affectedAgents` contains retained plan keys. A failure of a full server MUST make one server event, not one event for each tool. Independent tool failures MUST make tool events.

The source key MUST be `capability-unavailable:<digest>`. The digest is the SHA-256 of the canonical JSON `{ subject, reason, affectedAgents }`, with sorted unique agent keys. The source key MUST be unique in the run. These events are admission results that the owner can see. They are not tool calls, and they do not prove use.

Subsequent discovery MUST NOT add bound tools to an accepted run. If an optional server recovers after acceptance, only a new run can get the tools that admission omitted. The dispatch-time checks for definitions and grants stay necessary. Successful admission discovery does not prove that a subsequent call is safe or available.

**Rationale and alternatives:** Discovery for commands only cannot support usual goals. If any optional selected server could cause the full run to fail, availability would become a new prerequisite. Lazy discovery that adds definitions after acceptance would break the retained-definition contract. Bounded admission discovery makes these costs and the unavailable results explicit.

### 12. Keep a closed start union, agent plans, and exact definitions

**Review status:** Approved as written, including Contracts 12A through 12D. The owner also approved the startup-history alignment under Decision 14.

The capability snapshot MUST keep the entry-agent identity, start variant, configured agents, and exact capability definitions available to the run. It MUST keep selections, startup IDs, restrictions, task targets, discovery results, captured authority, and execution limits. Decision 21 separates retained configurations, run-owned sessions, and execution turns. Decision 22 defines the discussion record requirements. This remains a definition snapshot, not a workspace filesystem snapshot.

**Session-contract completion:** A session has immutable owning `runId`, owner-selected agent configuration, conversation state, and execution metadata under Decision 22. Existing execution and operation records MUST identify work performed in that session. Historical instruction supply MUST remain separate from current authority. Remaining conversation and checkpoint details require completion; no separate claim table or lease service is needed.

Critical-operation approval records MUST remain distinct from immutable definition snapshots. The runtime MUST preserve workspace scope, decisions, and execution outcomes for compatible continuation. The contract additions below specify their keys and constraints. Decision 13 specifies admission and replay. Existing agent, facet, and tool-use provenance MUST remain intact.

**Policy revisions**

Policy records MUST identify their immutable revision. A revision identifies a particular saved policy.

Policy records MUST NOT contain a schema-version field. Decision 3 defines one current record format.

An edit MUST create a new revision rather than overwrite a revision retained by a run or approval request.

Unsupported variants and unsupported restrictions MUST be rejected. They MUST NOT be ignored or interpreted as unrestricted access.

**Tool classification record**

```text
ToolClassification
  classificationId
  revision
  toolIdentity
    MCP: selected facet, installed version, server, tool
    Native: tool name
  definitionDigest
  effect: read | write
  critical: boolean
  provenance
  createdAt
```

A classification revision MUST bind its tool identity, reviewed definition digest, effect, and critical designation.

Runs MUST retain the applicable classification revision. Installation changes MUST NOT replace it.

Classification MUST remain separate from independent server approvals, grants, and critical-operation approval.

**Execution-policy record**

```text
ExecutionPolicy
  policyId
  revision
  sandbox: SandboxSpec
  provenance
  createdAt
```

`SandboxSpec` MUST be a discriminated union of explicitly supported sandbox mechanisms.

Each mechanism MUST have validated settings for its supported resource boundaries. The runtime MUST NOT accept an unrestricted settings blob as proof of enforcement.

A workspace MUST identify its governing execution-policy revision. A run MUST identify its workspace, and its invocations MUST use that workspace under the governing policy. Starting a run MUST NOT silently replace or widen the workspace policy.

Policy configuration MUST NOT claim enforcement that its backend cannot provide.

Docker is the only supported `SandboxSpec` backend in this first version. Its settings MUST enforce Decision 8's image, access, network, and resource rules. Other backend variants MUST be rejected. The outlines above name the record boundaries; the closed contracts below define their fields.

**Workspace record boundaries**

```text
Workspace
  workspaceId
  displayName
  storageReference
  executionPolicyRevision
  sandboxReference

Run
  workspaceId
```

An invocation MUST use its run’s workspace. It MUST NOT select another workspace through model-generated arguments.

Workspace files MUST remain in persistent workspace storage. The runtime MUST NOT automatically snapshot, roll back, restore, synchronize, or merge those files.

Git save points MUST be explicit actions by the owner or an authorized agent. The runtime MUST NOT impose an automatic commit schedule.

A container restart MUST use the existing workspace files. It MUST NOT promise restoration of background processes.

Workspace deletion MUST remain an explicit owner-controlled action. Finishing a run MUST NOT delete the workspace.

This version MUST NOT introduce automatic idle-stop or workspace deletion.

The runtime MUST prevent competing container creation and teardown beneath active work. These safeguards MUST NOT require a separate agent-attachment lifecycle model.

These records MUST use the existing PostgreSQL `runtime` schema. Workspace file contents MUST remain in workspace storage, not in database rows.

Backend handles and internal coordination are not additional user-facing workspace concepts. The contracts below define workspace and run keys without an attachment state machine.

Removing filesystem snapshot machinery MUST NOT remove retained agent and tool definitions, PostgreSQL run records, execution checkpoints, or approval records.

Runtime continuation MUST NOT imply that workspace files have been rewound to an earlier state.

The model loop, database access, credentials, and approval enforcement MUST remain outside task containers. Agent attachment means that workspace operations execute in that environment; it does not require every agent process to live in the container.

**Approval-request record**

```text
ApprovalRequest
  requestId
  workspaceId
  runId
  actorKey
  operationId
  toolIdentity
  definitionDigest
  classificationRevision
  executionPolicyRevision
  target
  executionPayload
  requestDigest
  createdAt
```

An approval request MUST identify its workspace, one exact proposed critical operation, and its applicable policy revisions.

`executionPayload` MUST contain the exact arguments or reference an immutable, digest-verified change artifact.

The owner’s review MUST describe the same target and content that execution will use.

The request digest MUST bind the complete approval scope, including workspace identity. Contract 12C below defines its fields and canonical format.

Changing the operation, target, arguments, change artifact, or bound policy revision MUST require a new request and approval.

Creating an approval request MUST NOT dispatch the operation.

**Approval-decision record**

```text
ApprovalDecision
  decisionId
  requestId
  requestDigest
  verdict: approve | reject
  decidedBy
  decidedAt
```

A decision MUST bind the exact request digest that was reviewed.

Approval MUST NOT authorize other operations or bypass current owner revocations, resource restrictions, sandbox constraints, or discussion mode.

Decision records MUST be immutable. Rejection MUST NOT be rewritten into approval.

The runtime MUST enforce one authoritative resolution for each approval request. Concurrent decisions MUST NOT produce contradictory executable outcomes.

**Provenance and future classifiers**

Provenance MUST identify the authorized producer of a record independently of its policy contents.

A future classifier’s proposal MUST NOT automatically authorize policy changes or approve critical operations.

Adding a classifier integration MUST require an explicitly supported producer and authorization contract. Unknown producers MUST NOT gain authority through a free-form provenance field.

Jev integration and automatic classification remain out of scope for this change.

**Storage and interface**

These application records MUST use the existing PostgreSQL `runtime` schema.

The approved Tool classifications page MUST create classification revisions through explicit saves.

Contracts 12A through 12D define records, canonical digests, and storage constraints. Decision 13 defines atomic admission. Decision 15 defines public interfaces.

New-run snapshots and bindings MUST NOT require or enforce a delegation-call limit. They MUST retain the maximum delegation depth and the applicable run-wide budget contract.

The current record format MUST NOT contain a delegation-call count field. The runtime MUST NOT add that limit to new runs through a storage default.

The earlier shared-selection shape and fixed `delegationDepth: 1` shape are withdrawn. Implementation MUST NOT use them as a fallback. Configured identity MUST remain distinct from actor identity, parent identity, mode, depth, and permission context. Decisions 18 through 22 define the approved discussion extension.

Snapshot rules:

- `CapturedAuthority` MUST keep the native grant shapes and the server and tool grant shapes. This includes server digests, tool digests, and argument equality restrictions.
- Its retained skill and agent references MUST cover the configured graph available to the run, not a flat allowlist from current configuration.
- Agent plans and inherited restrictions decide which actor can use those IDs.
- Retained agent configurations MUST keep their explicit outgoing delegation targets, including those of delegated agents.
- An accepted run MUST retain the tool’s selected-origin reference, applicable classification, and reviewed definition digest.
- A later installation that selects another origin MUST NOT replace those retained records.
- Current independent owner revocations and continuation checks MUST remain effective.
- Retained agent configurations MUST be unique by configured agent identity. Multiple actors MAY reference the same configuration. Path-dependent execution contexts MUST NOT collapse into that identity.
- Role, mode, and tool-effect checks MUST remain distinct from static selection. A task execution's usability result MUST NOT grant the same tool to a discussion invocation.
- In an agent's selection, facet IDs, contribution IDs, and tool IDs MUST be unique.
- Each usable reference MUST point to retained definitions and selected origins.
- Each startup reference MUST have an explicit usable or unusable resolution.
- Unusable references MUST have safe identification and reasons. They MUST NOT have executable replacement definitions.

The runtime MUST resolve the entry invocation's startup result before acceptance, after discovery-dependent prerequisites. Each designated skill MUST be usable and within the count and byte bounds. An entry startup rejection MUST prevent acceptance.

Known startup problems MUST remain inspectable and reject the affected invocation rather than unrelated entry work. Startup prerequisite checks MUST respect the recipient's mode. A prerequisite MUST NOT enable mutation or task delegation in discussion mode. Decisions 18, 21, and 22 define new-session startup and reused-session checks. Current checks before supply MUST NOT replace retained configuration.

The snapshot MUST keep exact definitions, skill resources, restrictions, selected origin versions, and admission basis. Decision 21 retains configured discussion targets, including the caller's configuration, not only task descendants. Absence of a task edge alone does not make a configured target unrelated.

The runtime MUST NOT impose a fixed aggregate snapshot size ceiling or a separate fixed count limit on retained agent configurations. Snapshot sizes and failures MUST follow the Message-size and monitoring policy. Separate facet-content and startup limits MUST remain effective. A failure MUST be explicit, never a truncation.

Every accepted run MUST have a capability snapshot and run-capability binding under the closed start union. A goal binding MUST NOT contain command metadata. The submitted goal stays in its run records and input records. A native-only goal MUST use the same records with `installation: { kind: "none" }`, without an installation read or MCP discovery.

#### 12A. Closed retained records and restriction scopes

**Review status:** Approved with Decision 12.

All new objects below MUST reject unknown fields. `Digest` means 64 lowercase hexadecimal SHA-256 characters. New record IDs and revision IDs MUST be UUIDs, unless a digest key is specified. Existing run, actor, contribution, and operation IDs MUST keep their validators. Timestamps MUST use the existing `instantSchema`.

`C(value)` means the existing runtime `canonicalJson` encoding. `H(value)` means SHA-256 of its UTF-8 bytes, without a final newline. Object keys are sorted recursively; JSON array order is preserved. Set-like record arrays MUST be sorted and deduplicated before sealing. Tool argument arrays MUST NOT be reordered. JSON numbers MUST be finite; integer counters MUST be safe integers. PostgreSQL `jsonb::text` MUST NOT substitute for `C`.

The new snapshot MUST use this closed shape:

```text
CapabilitySnapshot = {
  installation: { kind: "none" } | { kind: "sealed", sha256: Digest },
  entryAgentId: AgentId,
  start: { kind: "goal" }
       | { kind: "command", definition: CommandDefinition,
           arguments: string, renderedGoal: string },
  agents: AgentPlan[],
  definitions: { skills: SkillDefinition[], agents: InstalledAgentDefinition[],
                 commands: CommandDefinition[], servers: ServerDefinition[],
                 tools: BoundTool[] },
  discovery: DiscoveryResult[],
  authority: CapturedAuthority,
  restrictions: { source: { kind: "command", id: CommandId, exportDigest: Digest },
                  restrict: Restriction }[],
  limits: { maxDelegationDepth: SafeInteger }
}
AgentPlan = {
  agentId: AgentId, instructions: string, facets: Origin[],
  startupSkills: SkillId[], delegationTargets: AgentId[],
  candidates: { skills: SkillId[], agents: InstalledAgentId[],
                commands: CommandId[], tools: Digest[] },
  availability: {
    task: CandidateResolution[], discussion: CandidateResolution[]
  },
  definitionDigest: Digest
}
CandidateResolution = {
  subject: { kind: "skill", id: SkillId } | { kind: "agent", id: InstalledAgentId }
         | { kind: "command", id: CommandId } | { kind: "tool", toolKey: Digest },
  result: { kind: "usable" } | { kind: "unusable", reason: ReasonCode }
}
DiscoveryResult =
  { kind: "bound", serverId: ServerId, toolKeys: Digest[] }
  | { kind: "unavailable", serverId: ServerId,
      reason: "server_unavailable" | "tools_unavailable", affectedAgents: AgentId[] }
RunCapabilityBinding = {
  runId: UUID, submittedInput: SubmittedStart,
  entryAgentId: AgentId, snapshotDigest: Digest,
  limits: { maxDelegationDepth: SafeInteger }
}
```

`Origin`, retained resources, server definitions, and authored definition bodies MUST reuse their existing validated shapes. Text definitions MUST contain the admission union from Decision 2. `InstalledAgentId` and `AgentId` have separate namespaces in records, even if their text is equal. No name match MUST create a delegation edge or instruction source.

`BoundTool` MUST contain the existing raw and adapted definition, server ID, and tool name. It MUST also contain `toolKey`, the exact installation-selected `Origin`, and a `ClassificationRef`. Its `definitionDigest` MUST match the reviewed raw definition. Native tool policies MUST reside in the execution manifest, not invented MCP records.

`CapturedAuthority` MUST preserve existing native grants and server/tool grants, including both digests and `argumentEquals`. It MUST contain retained configured IDs and explicit per-agent edges, not a flat agent list. Skill IDs remain retention bounds, not an extra owner selection list. The record MUST NOT contain a fixed agent-count bound or a delegation-count field.

The runtime MUST retain every configured agent once. Candidate arrays are derived from facet selections, not editable allowlists. Each candidate MUST have one resolution for each mode. These resolutions describe acceptance-time prerequisites, not unconditional permission for every ancestry path. Each startup ID MUST refer to a selected skill resolution. All usable references MUST resolve to exact retained definitions.

`definitionDigest` MUST equal `H({kind:"configured-agent", plan})`, where `plan` contains all `AgentPlan` fields except that digest. Plans MUST be sorted by `agentId`. Definitions MUST be sorted by their typed stable identity. Resource lists MUST be sorted by path. Classification references MUST identify immutable revisions, not the current head.

A configured agent's instruction body MUST use the existing 48-KiB instruction bound. Separate facet-content, schema, resource, and startup controls MUST remain effective. Configured agent and edge arrays MUST have no separate fixed count bound.

Snapshot serialization and persistence MUST follow the Message-size and monitoring policy. The current SQL schema MUST NOT retain the removed aggregate snapshot ceiling. Strict shape, reference, canonical encoding, and digest checks MUST still pass before acceptance.

Every run, including the supplied single-agent default, MUST retain configured agents through `CapabilitySnapshot` and `RunCapabilityBinding`. A single configured agent can create another session of itself under Decision 21. The runtime MUST retain that configuration rather than infer that no discussion target exists.

With `installation.kind: "none"`, all installed-definition arrays and facet selections MUST be empty. Native-only definitions MUST NOT cause an installation read or MCP discovery. This change MUST NOT add a separate native-only retention record.

Owner agent selections MUST reference these immutable retained plans. A prepared model step MUST capture its selected plan, definition digest, prompt, and offered tool definitions. Later owner selections MUST NOT overwrite that binding or the run's retained catalog.

**Authored restrictions**

The existing `restrict.native`, `restrict.skills`, and `restrict.mcp` fields MUST keep their meanings. An absent category adds no restriction; an empty array denies that category. Command restrictions MUST apply throughout the run, including consultations. An explicitly activated instruction source's restrictions MUST remain attached to that source's execution scope. Selection of a facet alone MUST NOT activate its agent instructions or restrictions.

This version does not bind installed agent definitions to independently configured agents. An explicit installed-agent prerequisite or nonempty authored `restrict.agents` therefore MUST fail closed as `authored_agent_binding_unsupported`. A matching configured name MUST NOT satisfy it. An explicit empty `restrict.agents` MUST prohibit both child interaction routes within its scope, so discussion cannot bypass it. Portable agent definitions remain inspectable candidates; they MUST NOT become executable targets automatically. This is an explicit compatibility refusal, not a conversion or removal of a restriction.

`Restriction` MUST use the supported resolved authored restriction fields defined above. `snapshot.restrictions` MUST be empty for goals. A command with explicit restrictions MUST have exactly one entry matching `start.definition.id`, its `exportDigest`, and its normalized restriction object. A command without restrictions MUST have no entry. No optional instruction-source reuse is introduced here. The runtime MUST evaluate each applicable restriction independently. It MUST NOT derive inherited denials from a caller's unselected facets or outgoing target list.

#### 12B. Policy revisions and the Docker workspace contract

**Review status:** Approved with Decision 12.

```text
ToolIdentity = { kind: "native", tool: NativeToolName }
  | { kind: "facet", facet: FacetName, version: string, server: ServerId, tool: ToolName }
ClassificationRef = { classificationId: Digest, revision: UUID, definitionDigest: Digest }
PolicyRef = { policyId: UUID, revision: UUID }
Producer = { kind: "owner_console", principal: "deployment-owner" }
         | { kind: "owner_configuration", configurationDigest: Digest }
         | { kind: "runtime_builtin", protocol: string }
ToolClassification = {
  classificationId: Digest, revision: UUID,
  toolIdentity: ToolIdentity, definitionDigest: Digest,
  effect: "read" | "write", critical: boolean,
  provenance: Producer, createdAt: Instant
}
ExecutionPolicy = {
  policyId: UUID, revision: UUID,
  sandbox: {
    kind: "docker", image: DigestPinnedImage,
    uid: PositiveInteger, gid: PositiveInteger,
    memoryBytes: PositiveSafeInteger, cpuMillis: PositiveSafeInteger,
    pidsLimit: PositiveSafeInteger, temporaryBytes: PositiveSafeInteger,
    network: "none", readOnlyRoot: true, dropCapabilities: ["ALL"],
    noNewPrivileges: true
  },
  provenance: Producer, createdAt: Instant
}
Workspace = {
  workspaceId: UUID, displayName: string,
  storageReference: { kind: "directory", absolutePath: string },
  executionPolicyRevision: PolicyRef,
  sandboxReference: { kind: "docker", name: string }
}
```

`toolKey` and `classificationId` MUST both equal `H({kind:"tool-identity", identity: ToolIdentity})`. Identity MUST include the selected installed version. The registry MUST retain the latest observed definition and a nullable classification head for each identity. A head update MUST NOT alter an existing revision. A native definition digest MUST cover its canonical name, description, input schema, and runtime tool protocol version.

The server MUST supply provenance from the authorized route. Clients MUST NOT select a producer. `runtime_builtin` MUST be limited to explicit runtime declarations, including the initial native classifications in Decision 7 and the fixed `Discuss` declaration. It MUST NOT classify arbitrary MCP tools. Owner-console provenance identifies the deployment authority, not an authenticated human name. Decision 15 states the trust boundary.

`DigestPinnedImage` MUST name an owner-configured repository and `@sha256:` digest, never a mutable tag alone. UID and GID MUST be nonzero. Resource settings MUST be representable and enforceable by the configured Docker backend. Unsupported limits MUST cause rejection, not silent omission. The runtime MUST verify effective container settings before task dispatch.

The workspace directory MUST be owner-configured, canonical, and outside runtime-private storage. Distinct workspace roots MUST NOT overlap or resolve to the same directory. The workspace mount MUST be `/workspace`; the bounded temporary mount MUST be `/tmp`. No other writable mount, host namespace, privileged device, Docker socket, or host credential mount is permitted. Default Docker seccomp confinement MUST remain enabled. Task arguments MUST NOT control mounts, image, environment, UID, or Docker options.

The sandbox name MUST be derived as `agent-runtime-workspace-<workspaceId>`. The runtime MUST verify its workspace and policy labels, mounts, image digest, and security settings before reuse. An existing name with different settings MUST cause a safe failure, not adoption or automatic replacement.

Owner deployment configuration MUST register workspace IDs, display names, storage roots, policy revisions, and a default workspace ID. This version adds no workspace create, delete, or policy-edit HTTP endpoint. Startup MUST reject conflicting registrations. Unchanged registrations MUST reuse existing records. Policy changes MUST be refused while nonterminal runs, unresolved effects, or approval work use that workspace. Explicit maintenance can replace the disposable container only after these checks; files remain unchanged.

For every new run, `Run.workspaceId` MUST reference the workspace. Its immutable execution manifest MUST retain `{workspaceId, entryAgentId, executionPolicyRevision, nativeClassifications}`. `nativeClassifications` MUST contain exact classification references for available native leaf tools and explicit fixed control declarations. This applies to native-only goals with their normal capability binding too. The manifest MUST NOT retain a Docker container ID as a continuation identity.

#### 12C. Exact approval scope and immutable review content

**Review status:** Approved with Decision 12.

```text
ApprovalScope = {
  kind: "critical-operation-approval",
  workspaceId: UUID, runId: UUID, actorKey: ActorKey, operationId: Digest,
  toolIdentity: ToolIdentity, definitionDigest: Digest,
  classificationRevision: ClassificationRef,
  executionPolicyRevision: PolicyRef,
  target: { kind: "workspace", workspaceId: UUID, paths: RelativePath[] }
        | { kind: "remote", serverId: ServerId, resourceArguments: JsonObject },
  executionPayload: { kind: "inline", arguments: JsonObject }
                  | { kind: "artifact", sha256: Digest, byteLength: SafeInteger,
                      mediaType: "application/json" },
  preconditions: { path: RelativePath, state: { kind: "absent" }
                    | { kind: "file", sha256: Digest } }[]
}
ApprovalRequest = {
  requestId: UUID, scope: ApprovalScope,
  requestDigest: Digest, createdAt: Instant
}
ApprovalDecision = {
  decisionId: UUID, requestId: UUID, requestDigest: Digest,
  verdict: "approve" | "reject", decidedBy: OwnerConsoleProducer, decidedAt: Instant
}
```

`requestDigest` MUST equal `H(scope)`. Request IDs, decision metadata, and timestamps MUST NOT enter that digest. The tool identity already binds the selected facet version. The operation's retained binding MUST also identify the exact selected origin and server declaration. A request MUST refer to that same operation, run, actor, and workspace.

Inline arguments MUST be the exact validated execution arguments, not a summary. Artifact bytes MUST contain their canonical JSON object, not a mutable file path. `sha256` MUST equal the hash of those bytes. Artifacts MUST be immutable PostgreSQL bytes with a 1-MiB bound and verified length, digest, and canonical encoding. Tool-specific controls outside the Message-size and monitoring policy MUST still apply. This does not add an agent artifact-upload tool.

The trusted tool adapter MUST prepare the target and any file preconditions before request creation. A remote target MUST retain the complete argument object as `resourceArguments`; it MUST NOT claim semantic confinement from a model-written target label. Native workspace paths MUST be normalized relative paths without traversal or symlink escape.

An adapter MUST NOT approve an operation that later reads mutable content as its change payload. It MUST capture that content in immutable arguments or a retained artifact. If the operation depends on an existing file version, the adapter MUST check its digest or absence at execution. A file-change adapter MUST enforce that condition with the mutation, not through an unprotected earlier read. Unsupported preparation MUST refuse with `approval_scope_unsupported`. This requirement does not introduce arbitrary shell execution or filesystem snapshots.

Credential and content screening MUST precede request persistence. If exact review content cannot be shown safely, the operation MUST be refused as `approval_content_unreviewable`. Redacted text MUST NOT be presented as the exact approved payload. Authenticated transports MAY use independently configured credentials; their values MUST NOT enter approval content.

One logical operation MUST have at most one approval request. A replay with equal scope MUST reuse it. Different scope for that identity MUST fail verification. A changed proposal needs a new tool operation, request, and decision; it MUST NOT overwrite the previous request. Accepted runs MUST keep their bound policy revisions, not switch to current classification heads. Independent current grant revocations still apply.

#### 12D. PostgreSQL keys, invariants, and current schema

**Review status:** Approved with Decision 12.

All tables MUST use the existing `runtime` schema. These are required logical keys, not a second database:

| Record | Key and enforced relationship |
|---|---|
| Registered tool | `toolKey`; structured identity unique; current definition digest and nullable classification head |
| Classification revision | `(classificationId, revision)`; immutable body; matching registered identity |
| Execution-policy revision | `(policyId, revision)`; immutable body; Docker-only closed schema |
| Workspace | `workspaceId`; unique sandbox name and canonical storage root; policy revision foreign key |
| Run | Existing run ID and unique creation request ID; workspace foreign key required |
| Session | Stable session ID; immutable owning run; owner-selected retained agent; idle or active execution metadata; conversation details pending completion |
| Session execution | Existing run-scoped actor and operation identity; exact session reference; immutable caller, mode, and depth; session metadata identifies at most one active execution |
| Prepared model step | Existing model-attempt identity with captured agent selection, retained definition, prompt, and offered tool definitions |
| Capability binding | Existing `runId`; closed start-union input; snapshot foreign key; immutable body |
| Run policy references | `(runId, classificationId, revision)` and the retained workspace policy reference; foreign keys to immutable policy rows |
| Approval artifact | `sha256`; immutable bytes and verified length |
| Approval request | `requestId`; unique `(runId, operationId)`; same-run actor and operation foreign keys |
| Approval decision | `decisionId`; unique `requestId`; immutable reviewed digest and verdict |
| Mutation receipt | `(family, submissionId)`; immutable input digest and result reference |
| Workspace gate and leaf admission | Keys and transitions in Decision 13 |
| Owner outcome resolution | Unique leaf identity; immutable assertion and evidence under Decision 13 |

Foreign keys MUST prevent deletion of referenced definitions, policy revisions, requests, and artifacts. SQL checks MUST enforce closed discriminators, variant-specific nullability, and valid state transitions. Transactional validators MUST check canonical digests, snapshot agreement, and cross-record policy identity. A JSON shape check alone MUST NOT count as proof of those relationships.

The existing actor table MUST retain `(runId, actorKey)` uniqueness for execution turns. Each actor MUST reference its exact session in the same run. New child actors MUST reference the actual same-run parent actor and parent operation. Their depth MUST equal parent depth plus 1. Root depth MUST equal 0. A discussion actor MUST NOT have a task-delegation child.

Session ownership MUST remain immutable. Agent lookups and turn admission MUST reject sessions owned by another run, even within the same workspace. A terminal run MUST admit no new turns. History retention MUST NOT imply session addressability or confirmed termination of external effects.

New-session startup supply, session creation, its initial execution, and the creation event MUST retain Decision 14's atomic invariant. A later execution MUST change idle session state to active atomically without duplicate instruction supply. Owner-selected startup requirements MUST be reconciled at model-step preparation under Decision 22. Instruction history MUST retain its source execution and agent-selection provenance without synthetic tool calls.

Every run MUST have a workspace reference. The reset in Decision 3 removes old rows, so the current schema has no nullable workspace exception. The schema MUST NOT assign a host path to a workspace or invent a policy revision. Continuation follows Decision 16.

**Code basis:** `packages/runtime/src/capabilities/records.ts:62-147` defines retained resources and authored restrictions. Lines 246-315 define the snapshot and digest checks that this change replaces. `packages/runtime/src/records/canonical.ts:3-27` defines runtime canonical encoding. The current record validators MUST be equally strict.

**Rationale and alternatives:** A nullable `command` in all records lets contradictory combinations of command and input occur. A closed start union and a closed binding keep the difference without a wrapper command. Retaining only the entry agent's visible definitions would break first use by a descendant after a pause.

### 13. Creation identity and snapshot retention are atomic and do not depend on current selection

**Review status:** Approved as written, including Contracts 13A through 13D. The owner also approved the startup-history corrections under Decision 14.

**Session-contract completion:** Decision 22 requires atomic changes to session execution metadata under the existing ownership fence. New-session creation and existing-session reuse MUST preserve acceptance, replay, and workspace gates without a separate claim subsystem. Conversation and checkpoint bindings still need detailed completion. A display-only busy flag MUST NOT replace atomic enforcement.

**Simple workspace coordination**

Run records MUST identify their workspace without owning its lifetime. Concurrent provisioning MUST NOT create competing containers. Finishing one operation or run MUST NOT delete the shared workspace or stop infrastructure used by other work. No separate attachment lifecycle or automatic filesystem recovery is required.

**Close admission before draining work**

When a critical operation requires approval, the orchestrator MUST record the request and close admission for new agent work in that workspace before the critical operation can execute.

The gate MUST block new model requests, tool calls, task delegations, and discussions in that workspace.

Already-started work MAY finish under its existing timeout, cancellation, and outcome rules.

Decision 20 distinguishes active leaf effects from suspended orchestration waits. Parent discussion and delegation promises MUST NOT prevent a hold from draining when their children are waiting for approval. Cancellation tracking still covers their real child work.

Results from already-started work MUST NOT trigger further agent work while the gate is closed.

The runtime MUST wait for already-started work to settle before reporting the workspace as ready for approved critical execution.

The critical operation that caused the hold MUST remain unexecuted.

Owner approval controls and necessary runtime bookkeeping MUST remain available.

This is a dispatch barrier, not filesystem freezing or rollback. Gate admission MUST be authoritative across all runs using the workspace. The implementation MUST prevent new work racing past closure.

**Individual approval and resumption**

Each approval request MUST identify its workspace and one exact reviewed operation.

The request digest MUST include the workspace identity alongside the previously defined approval scope.

Approving one request MUST NOT approve or resolve another request.

The orchestrator MAY execute only the individually approved operation while ordinary workspace admission remains closed.

At most one approved critical operation MUST execute at a time in a workspace.

A changed operation, target, arguments, policy revision, or approved artifact MUST require a new request and approval.

A rejected request MUST NOT execute.

Ordinary work MUST remain blocked while approval requests are unresolved or approved critical execution is still active.

Once all requests are resolved and authorized critical execution has finished, the orchestrator MAY reopen ordinary admission, subject to existing run permissions and terminal-state rules.

Confirmed failures MUST remain recorded and MUST NOT be silently retried. An uncertain outcome MUST keep the workspace held until explicit owner resolution.

**Critical-operation integration**

Approval and execution MUST remain separate records.

The runtime MUST reuse its existing operation identity and execution-history model rather than introduce a second operation tracker.

Repeating an approval submission MUST NOT independently dispatch the operation again.

Execution history MUST distinguish confirmed success, confirmed failure, and an uncertain outcome.

An uncertain outcome MUST NOT be treated as failure merely to permit an automatic retry. Approval alone MUST NOT be recorded as successful execution.

Decision 12 defines the record boundaries and single-resolution invariant. Contracts 13A through 13D below specify atomic admission, recovery, and request identity. The question-and-answer API MUST NOT serve as the critical-approval API.

**Run creation**

The creation uniqueness boundary MUST stay the owner request ID. Explicit entry choice, workspace choice, and submitted budget MUST be part of new request identity. Command input MUST also keep the normalized command ID, selection revision, arguments, and provider. Derived selections, discovery output, current grants, and resolved defaults MUST NOT enter that identity. An accepted retry MUST return its original run without resolving current defaults. Contract 13D defines the input digest.

After structural screening and input screening, the runtime MUST return the original run for an accepted request with the same input. It MUST do this before it reads current installations, selections, provider readiness, or MCP services. If a request ID has different submitted input, the runtime MUST return a conflict. Concurrent acceptance MUST converge on one authoritative run and binding through the uniqueness boundary. A candidate snapshot that loses MUST NOT replace it.

Acceptance MUST persist these items in one atomic operation:

- The run and its normalized input identity.
- Its new entry session with immutable owning run identity.
- The immutable content-addressed capability snapshot and run binding.
- The entry actor and its startup memberships.
- The first invocation and the creation history.
- The optional `capability.unavailable` events.

The `run.created` event MUST identify the entry actor and configured agent. It MUST contain the complete startup list defined in Decision 14. The list MUST match the actor's startup memberships. An empty startup set needs no membership rows and MUST have an empty event list.

A capability-bound entry actor MUST never exist without all designated startup memberships and its creation event. An accepted run MUST never be visible without a necessary snapshot. Snapshot keys MUST stay `sha256(canonical JSON bytes)`. The runtime MUST do a check of the digest each time that it reads a retained snapshot.

New runs MUST validate installation integrity and the configured references that they use again. Thus, subsequent drift cannot silently remove a selection. A failure of integrity of the full bundle stays a rejection of the full bundle. Startup validation MUST reject an unavailable or unsupported installation when configured references need it. This change adds no degraded-readiness mode. Native operation without capability configuration MUST NOT depend on installation availability.

If the runtime knows about a rejection before acceptance, it MUST NOT write an accepted run or dispatch model or task work. MCP discovery remains bounded preflight. Workspace setup MUST preserve Decisions 8, 9, 12, and 13, including the workspace gate; it MUST NOT silently execute task work or create an automatic filesystem snapshot. If the commit acknowledgement is uncertain, the runtime MUST keep the `acceptance_unknown` contract. This contract needs a retry with the same request identity. The runtime MUST NOT invent a new run.

Admission MUST NOT recreate removed message-size ceilings through rendering, record validation, or SQL checks. Provider and local capacity failures MUST retain their actual stage under the Message-size and monitoring policy. A failure after acceptance MUST NOT imply that the input was never accepted.

New-request validation MUST use this observable order:

1. Structural screening and credential screening.
2. Accepted-request lookup and the conflict response.
3. The configuration-validation gate, including entry-policy references and default membership.
4. Entry-agent resolution and eligibility, then installation checks and command selection and revision checks when they apply.
5. Provider admission and workspace admission.
6. Process-free resolution of retained task and discussion availability: explicit tool policy, modes, sandbox and resource constraints, startup bounds, and definition screening.
7. Bounded MCP discovery.
8. Resolution of prerequisites and startup that depend on discovery, then final snapshot screening and sealing.
9. Construction of the execution definition.
10. Atomic acceptance.

A known failure MUST stop all subsequent stages. An MCP process MUST NOT start before all applicable process-free checks pass. Interaction-scoped unusability MUST NOT become an unrelated entry-admission failure. Accepted-request lookup stays before current-state checks. Decisions 18 through 22 supply the approved discussion-specific admission and replay requirements.

#### 13A. Durable workspace admission and effect accounting

**Review status:** Approved with Decision 13.

The existing process-local `KeyedSerializer` MUST NOT be the workspace authority. PostgreSQL MUST contain these coordination records:

```text
WorkspaceGate = {
  workspaceId: UUID, revision: PositiveDecimal,
  admission: "open" | "closed",
  criticalSlot: null | { runId: UUID, operationId: Digest, requestId: UUID }
}
LeafIdentity = { kind: "model", runId: UUID, attemptId: UUID }
             | { kind: "tool", runId: UUID, operationId: Digest }
WorkspaceLeaf = {
  leafId: Digest, workspaceId: UUID, actorKey: ActorKey,
  identity: LeafIdentity, ownerEpoch: PositiveDecimal,
  admissionRevision: PositiveDecimal,
  state: { kind: "active" }
       | { kind: "settled" }
       | { kind: "unresolved", reason: ReasonCode }
}
```

`leafId` MUST equal `H({kind:"workspace-leaf", identity})`. A gate MUST have one row per workspace. A leaf MUST have one row per underlying model attempt or tool operation. It MUST reference that existing execution record. It MUST NOT duplicate the operation's result or become a second execution ledger.

The owner fence, workspace gate, and run lock MUST follow one lock order: owner, workspace, run, then operation-specific records. Equal-level keys MUST use deterministic order. Every path that takes these locks MUST use that order, including cancellation and completion. No database lock may remain held across a model response, tool response, child invocation, or owner decision.

Ordinary leaf admission MUST atomically check the open gate and reserve its existing attempt or dispatch intent with a leaf record. Child actor creation MUST also check the gate, but a suspended control wrapper MUST NOT create an active leaf. Skill bookkeeping and checkpoint writes are not leaf effects; their underlying file reads still require tool admission.

Child admission MUST atomically change the target session from idle to active and verify its owning run. Active metadata MUST identify the existing execution and owner epoch. Waiting for a child keeps that session active, although its wrapper is not an active drain leaf. Busy targets and waiting ancestors MUST be refused without a queue or competing execution. Completion MUST NOT make the session idle while work remains unsettled.

Critical request creation MUST atomically insert the immutable scope, close the gate, and pause its operation for approval. A critical operation MUST NOT have an ordinary dispatch intent or active leaf at this point. Concurrent admissions that commit first have visible leaves to drain. Admissions after closure MUST NOT obtain permission to start.

The tool-operation disposition MUST add `{kind:"awaiting_approval", requestId}`. Its allowed transitions are from `started`, then to `dispatching` or a confirmed non-execution `completed` result. The existing `paused` question variant MUST NOT be reused for approval. A dispatching operation MUST never return to `awaiting_approval` to obtain another send.

Every gate, leaf, request, decision, or resolution change visible in the workspace queue MUST increment the gate revision in its transaction. This permits consistent queue pages and stale-state detection without a global workspace lock. Classification saves use their separate registry revision.

Admission is the durable permission boundary, not proof that a request reached its destination. An admitted leaf MAY complete its already-authorized transport handoff after closure. It remains in the drain set until its effect stops and settlement is confirmed. Work without that prior admission MUST NOT start. This definition makes the database-to-transport interval explicit.

Completion MUST atomically commit the existing attempt or tool outcome, applicable history, and leaf settlement. A timeout MUST NOT settle a leaf unless termination of the underlying effect is confirmed. Lost acknowledgement, lost executor ownership, or an unconfirmed remote effect MUST leave the leaf unresolved. Neither a timeout nor a new owner epoch proves that an effect stopped.

Changing any leaf to `unresolved` MUST atomically close its workspace gate, including when no critical request exists. This conservative recovery hold prevents new work from racing an effect whose termination is unknown. The unresolved-effect owner interface, not a fabricated approval request, resolves that hold.

Gate readiness MUST be computed from durable records under the gate lock. `draining` means an ordinary leaf is active. `outcome_unknown` means an unresolved leaf exists. `executing` means a critical slot is active. Otherwise a closed gate is `held`. These are inspection states; they MUST NOT replace the underlying admission and operation records.

The gate MUST reopen only when all leaves are settled, the critical slot is empty, and every request is closed. A request is closed after rejection, confirmed execution, confirmed non-execution refusal, or explicit uncertainty resolution. An undecided request or approved operation awaiting execution MUST keep the gate closed. Reopening MUST be atomic with its last predicate check and gate revision increment.

**Gate consistency**

A transaction MUST NOT leave ordinary admission open while an approval request remains unresolved, the critical slot is occupied, or any workspace leaf is unresolved.

This rule MUST cover model effects as well as tool effects.

A gate closed for approval MUST remain closed while previously admitted work drains, even if the initiating request is rejected.

Reopening MUST retain the complete predicate already defined in this contract: settled leaves, an empty critical slot, and closed requests.

Transactions that change these facts MUST preserve the invariant under the workspace lock. Tests MUST exercise conflicting admissions and state changes.

The runtime MUST NOT replace this model with the adversary's three-predicate gate.

One workspace's lock MUST NOT be held while work in another workspace runs. Workspace-specific container creation MUST use the same ownership fence and a separate short lifecycle lock. Docker's deterministic container name supplies the creation uniqueness boundary. Unknown Docker create outcomes MUST be inspected by name and verified, not answered with another container name.

#### 13B. Approval, dispatch, cancellation, and uncertain outcomes

**Review status:** Approved with Decision 13.

An approval submission MUST insert its mutation receipt and immutable decision atomically. The unique request decision is authoritative. An equal submission replay MUST return that decision. A different submission after a decision exists MUST return `approval_conflict`, even if its verdict is equal. Decision insertion MUST NOT send a tool request.

The executor MUST claim an approved request only when the drain set is empty and no critical slot is occupied. The claim MUST atomically reserve that slot, add the critical leaf, and record intent in the existing tool operation. The request MUST still match the retained tool, payload, definition, workspace policy, and classification revision. Current grants, run state, mode, resource rules, and verified sandbox settings MUST also pass.

The executor MUST select ready approvals by `(createdAt, requestId)` within one workspace. It MAY skip undecided requests, but MUST NOT treat them as resolved. This is deterministic dispatch within an existing run executor, not a parallel task scheduler. A valid approval MAY be recorded while ordinary work drains; it cannot execute early.

Only the confirmed intent winner MAY hand the frozen arguments to the transport. An existing intent, ambiguous commit, approval replay, or process restart MUST NOT authorize another send. There is no atomic transaction between PostgreSQL and an external service. A crash after intent but before send can therefore leave an unresolved operation that never executed.

Confirmed tool completion MUST atomically record the outcome, settle its leaf, clear its critical slot, and append history. Confirmed failure MUST NOT be retried automatically. An uncertain result MUST retain the slot and hold, even if its run becomes terminal. Owner decisions and execution results MUST remain separate facts.

Rejection MUST complete an undispatched operation with `approval_rejected`. Cancellation or revocation before intent MUST complete it with `approval_not_executed`. These operations MUST NOT obtain a dispatch leaf. A request without a human decision MAY close through this recorded non-execution outcome. The runtime MUST NOT manufacture a reject decision for it.

Cancellation after intent MUST use normal cancellation and uncertain-effect rules. It MUST NOT clear a slot merely because the run became cancelled. A definition or file precondition mismatch before intent MUST complete the operation with `approval_scope_changed`, without execution. A new operation is necessary to propose changed scope.

For any unresolved workspace leaf, the owner MUST use this separate resolution record:

```text
OwnerOutcomeResolution = {
  resolutionId: UUID, workspaceId: UUID, leafId: Digest,
  observedOutcomeDigest: Digest,
  assertion: "effect_confirmed" | "no_effect_confirmed" | "acknowledged_unknown",
  executorStopped: true, evidence: string,
  resolvedBy: OwnerConsoleProducer, resolvedAt: Instant
}
```

The owner MUST stop the old executor and any continuing local process before resolution. For a remote operation, the owner MUST establish that no execution remains in progress. `executorStopped` records that owner's assertion; the database cannot prove it. The evidence text MUST be nonblank, screened, and at most 8192 UTF-8 bytes.

The read API and resolution transaction MUST calculate the same digest:

```text
observedOutcomeDigest = H({
  kind: "unresolved-workspace-effect",
  leafId, ownerEpoch, reason,
  recordedState: { kind: "model", state: AttemptState }
               | { kind: "tool", disposition: ToolDisposition }
})
```

`reason` and `ownerEpoch` MUST come from the unresolved leaf. `recordedState` MUST be the complete persisted state of its referenced attempt or operation, validated against that record's current schema. The read MUST use one consistent store view. The resolution transaction MUST recompute the digest from locked records. A late outcome that changes it MUST cause a conflict, not resolution against stale evidence.

The resolution MUST be immutable and unique per leaf. In one transaction, it MUST change that leaf from `unresolved` to `settled` and release its critical slot if present. Here, `settled` describes drain membership, not proof of success. The immutable resolution and original attempt or tool outcome MUST remain inspectable. The runtime MUST NOT rewrite that outcome, refund a model step, supply invented output, or authorize another execution. `acknowledged_unknown` means the outcome remains unknown after the executor stopped; it does not permit an active process.

If stopping the old executor cannot be established, the workspace MUST remain held. An owner epoch change alone is insufficient fencing for network effects. The system MUST document this operational limit instead of claiming exactly-once external execution. Other workspaces remain independent.

`approval.requested`, `approval.decided`, and `approval.outcome_resolved` MUST be typed run events. Their source keys MUST be `approval:<requestId>:requested`, `approval:<requestId>:decided`, and `resolution:<resolutionId>`. Operation completion MUST continue to use the existing tool-history identity. No approval event MUST imply confirmed execution.

#### 13C. Durable hold continuation without owner questions

**Review status:** Approved with Decision 13.

A workspace hold MUST suspend a run at an execution checkpoint before its next dispatch. It MUST NOT occupy a model step or create an owner question. Add this nonterminal run-state variant and invocation settlement reason:

```text
RunState += { kind: "held", workspaceId: UUID, gateRevision: PositiveDecimal,
              bindingDigest: Digest }
InvocationSettlement += { kind: "workspace_hold", bindingDigest: Digest }
WorkspaceResumeBinding = {
  runId: UUID, workspaceId: UUID, executionDefinitionDigest: Digest,
  frames: { actorKey: ActorKey, sessionId: UUID, parentOperationId: Digest | null,
            checkpointNs: string, checkpointId: string, taskId: string,
            mode: "task" | "discussion", depth: SafeInteger,
            requiredStateDigest: Digest }[],
  next: { kind: "model", actorKey: ActorKey }
      | { kind: "tool", actorKey: ActorKey, operationId: Digest,
          argumentDigest: Digest }
      | { kind: "answer", actorKey: ActorKey, questionId: Digest,
          questionBindingDigest: Digest, acceptedAnswerDigest: Digest }
}
```

`bindingDigest` MUST equal `H(binding)`. Frames MUST contain the root-to-leaf active caller chain in order. Each frame MUST match its durable turn, owning session, run, and checkpoint. The state digest MUST include its messages, pending tool identities, and frozen loaded-skill membership. Parent operation links MUST match adjacent frames. The checkpoint namespace and identifiers MUST keep their existing bounds.

Session conversation and active-execution bindings MUST be completed before this continuation shape is implementation-ready. Resuming a paused execution MUST preserve its captured model-step context. A later execution in the same session needs a new operation and its own verified binding. An owner selection change MUST affect subsequent preparation, not rewrite already-prepared work or invalidate continuation solely because selection changed.

The hold transition MUST occur only after checkpoint persistence is confirmed. It MUST atomically publish the saved binding, run state, invocation settlement, and run history. A failed checkpoint write MUST cause existing storage-failure behavior, not a fabricated resumable hold. A wrapper waiting for its child remains a logical wait, not an active drain leaf.

On reopening, the existing executor MUST claim each eligible held run with an owner-fenced compare-and-set. It MUST verify the complete saved binding and execution definition before resuming. A temporary verification failure leaves the run held. Confirmed incompatibility MUST fail with the existing continuation reason, without model dispatch. Competing wakeups MUST converge on one invocation.

A run already waiting for an owner answer MUST keep that question and state. The owner MAY submit an answer while the workspace is held. Answer acceptance MUST atomically record the normal answer disposition and a held binding with `next.kind: "answer"`. `questionBindingDigest` MUST identify the verified original question binding. `acceptedAnswerDigest` MUST equal `H({questionId, answer})` using the existing canonical answer value. Cancellation controls remain available in either state. No second answer or synthetic question is necessary when the workspace reopens.

Answer continuation MUST verify those digests against the accepted answer record before supplying its normal resume envelope. It MUST NOT interpret that answer as a new topic or model input. Only the one claimed continuation may consume the answered question.

Nested task questions MUST use `QuestionBinding = {actorKey, leaf, frames}`. `leaf` MUST preserve every existing question leaf field, including `interruptId`, operation identity, payload digest, and definition digest. `frames` MUST use the ancestor-frame structure above and end at the actual asker. The existing question and answer identity formulas MUST remain intact. Discussion actors still cannot ask the owner under Decision 18. Tests MUST cover several child depths; the existing one-child verifier is insufficient.

#### 13D. Submitted input identity and acceptance races

**Review status:** Approved with Decision 13.

```text
SubmittedStart = {
  workspaceId: UUID, provider: Provider,
  entry: { kind: "default" } | { kind: "explicit", agentId: AgentId },
  budget: { kind: "default" } | { kind: "explicit", steps: StepBudget },
  start: { kind: "goal", goal: string }
       | { kind: "command", id: CommandId, selectionRevision: Digest,
           arguments: string }
}
```

The input digest MUST equal `H({kind:"run-start", input:SubmittedStart})`. The creation request ID remains the uniqueness key, not part of that digest. Text MUST retain its submitted bytes after existing validation; it MUST NOT be trimmed. Explicit null for optional entry or budget fields MUST be invalid, not omission. The input MUST retain omission separately from an explicit value equal to today's default.

An API start MUST name an owner-registered workspace ID, not a host path. The console MAY initially select the configured default, but MUST submit its ID. A start without a workspace MUST be rejected. The reset in Decision 3 removes old accepted requests. The runtime MUST NOT keep an old parser or input digest for retry lookup.

Acceptance MUST recheck the workspace gate and authoritative policy revision inside the final transaction. A gate closure after preflight MUST prevent new acceptance with `workspace_unavailable`. A classification or catalog change after preflight MUST reject the candidate with `capability_selection_changed`; it MUST NOT seal stale current state as a fresh selection. The final transaction MUST serialize against registry-head edits through the observed registry revision.

Two equal accepted submissions MUST converge on the existing unique creation request ID and return the winning run. The loser MUST NOT replace its snapshot. A different submission MUST return `request_conflict`. An unconfirmed commit MUST return `acceptance_unknown`; retry MUST use the same identity and input. Candidate artifacts without accepted references MUST NOT trigger execution or claim accepted work.

**Code basis:** `packages/runtime/src/execution/admission.ts:29-64` supplies existing model admission. `packages/runtime/src/execution/operations.ts:174-196` supplies intent-before-send behavior. `packages/runtime/src/persistence/ownership.ts:165-178` supplies the owner fence. These mechanisms MUST be extended to the workspace boundary, not replaced with process-local approval flags.

**Rationale and alternatives:** If the runtime resolved configuration again before retry lookup, an update would break accepted-request identity. If a run and its definitions used different commits, accepted work could become unrecoverable.

### 14. Startup is actor initialization, not a synthetic tool call

**Review status:** Approved with the startup-history replacements and their listed change-local follow-ups. Decision 19 adds the approved depth-awareness block to prompt assembly.

The runtime MUST supply startup instructions in the system prompt of the actor that gets them. The prompt MUST have these parts in this sequence:

1. The execution-role prompt with retained configured-agent instructions and the active interaction mode.
2. The runtime-generated depth-awareness block from Decision 19.
3. The session catalog from Decision 22, when the request offers `tool__Discuss`.
4. The MCP note, when applicable.
5. The fixed startup preamble.
6. Startup-skill blocks in retained stable-ID order.

Initial startup activation belongs to a new session's first execution. A later execution with the same selected agent MUST reuse retained instruction history without duplicate body insertion. Under Decision 22, an owner selection change can require different instructions and configured startup skills at the next model-step preparation. Mode and depth remain those of the current execution, not the selected agent's previous use.

The preamble MUST be: `The following skills are already loaded for this agent. Their instructions grant no additional authority.` Each header MUST identify the skill ID and the origin facet and version. Each body MUST contain the retained instructions verbatim. The runtime MUST NOT trim or interpolate the body. Headers and delimiters MUST use one deterministic format.

Each prepared step's selected agent MUST have a maximum of 8 unique startup skills. Their full bodies MUST total at most 96 KiB of UTF-8 text, excluding runtime headers and the preamble. The 48-KiB limit for each skill also applies. These startup limits MUST NOT become a cumulative cap on retained conversation history. The runtime MUST NOT silently truncate required instructions or fall back to on-demand loads.

Startup bodies MUST pass credential screening and content screening before the runtime persists public events or supplies the model. A rejection MUST identify safe actor and skill references. It MUST NOT show the rejected content.

The execution definition's `promptDigest` MUST cover the assembled entry system prompt except captured session-catalog data. The exact complete prompt, including that catalog, MUST be retained with its prepared request. The snapshot digest covers the retained agent instructions and startup bodies. The execution-code identity covers the prompt and catalog assembly behavior. The runtime MUST NOT rewrite stored digests.

There MUST NOT be a separate actor-initialization table. The key `root` identifies the entry turn, not an agent configuration or reusable session. Child actor keys MUST use their issuing operation identity, not the configured agent name. Each turn has its own events and execution context. Session skill state MUST retain its originating turn. Decision 22 defines session and turn binding requirements. A discussion MUST NOT collapse into an unrestricted task actor.

Instruction-supply history MUST identify the run, session, skill, retained definition, originating execution, and agent-selection provenance. It MUST remain distinct from current skill availability and permission. Its complete checkpoint and record binding needs detailed completion. It MUST preserve this activation distinction:

```text
{ kind: "startup" }
| { kind: "on_demand", operationId }
```

Startup membership MUST NOT require a separate event key or tool-operation foreign key. On-demand membership MUST reference a successful load operation from its originating turn in the same session.

Database constraints MUST enforce exclusive source variants, run and session ownership, originating-turn identity, and correspondence with retained definitions. The development reset removes old memberships; no conversion is necessary.

The runtime MUST include startup-skill information in the event that records the actor's creation:

| Actor | Event |
|---|---|
| Entry actor | `run.created` |
| Task delegate | `delegation.started` |
| Discussion actor | `discussion.started` |

Each event MUST identify the turn, session, and configured agent. For a new session, its `startupSkills` field MUST contain this list:

```text
startupSkills: {
  skillId: SkillId,
  definitionDigest: Digest
}[]
```

The list MUST contain each newly activated startup skill once, in stable skill-ID order. A new session without startup skills MUST have an empty list. A later turn in an existing session MUST have an empty new-activation list and retain its session reference. Inspection MUST obtain earlier startup provenance from the session's recorded activation rather than invent new supply.

Each entry MUST reference the exact retained definition. Inspection MUST obtain the facet origin, installed version, admission basis, and selection provenance from retained records.

New-session creation, its first execution, initial startup-supply records, and the corresponding creation event MUST commit atomically. Entry creation MUST remain part of atomic run acceptance under Decision 13. An existing-session execution MUST atomically change idle session metadata to active and record its start without duplicate instruction supply.

At model-step preparation after an owner selection change, required instruction supply MUST identify the selected retained agent and the preparing execution. Existing step history and supply records MUST carry this provenance without synthetic tool calls or per-skill startup events. Previously supplied content MUST remain history, not authority to use a skill under another selection. Unusable selected startup requirements MUST prevent dispatch without silent omission or fallback to an earlier profile.

For a new session, the event's startup list MUST match its complete initial startup membership set. An executable turn MUST NOT use a session with a partial startup set.

The creation event MUST precede the actor's first model request. Discussion creation MUST establish discussion mode before model or tool dispatch. The workspace gate MUST permit child creation and dispatch.

The runtime MUST NOT create separate `skill.startup` events or synthetic tool calls for startup supply.

A startup refusal MUST retain the safe actor or target reference, affected skill references, and refusal reason.

For a child invocation, the refused result, refusal history, and parent-operation completion MUST commit atomically. The runtime MUST NOT create an executable child or startup memberships.

Refusal history MUST use the applicable operation or discussion identity, not a separate `startup:` key. A startup refusal alone MUST NOT fail the containing run.

An entry startup refusal MUST prevent run acceptance.

Creation events MUST retain their existing source-key identities. Startup supply MUST NOT introduce a separate event-key namespace.

A replay with equal content MUST reuse the recorded creation event and memberships. Conflicting actor identities, startup lists, or definition digests MUST fail verification.

Before the first request of an actor and before budget reservation, model-dispatch admission MUST make sure of these items:

- The recorded startup membership is complete.
- The runtime can reconstruct the system prompt of the actor exactly.
- The applicable current prerequisite checks and permission checks pass.
- The actor's interaction mode is established and its dispatch restrictions are enforceable. In discussion mode, no mutating tool or task-delegation operation can pass dispatch admission.

Startup itself does not use a model step. The prepared prompt MUST contain the selected agent's required startup instructions without duplicate body insertion. The runtime MUST NOT add synthetic graph messages on replay. Continuation of prepared work MUST preserve its captured prompt; subsequent preparation MUST use the current owner selection from retained definitions. Recorded supply means prepared instruction supply. It does not prove provider delivery or model compliance.

A new load request MUST do a check of retained availability and applicable permission before it does a check of loaded membership. For a skill that is already loaded, the result MUST be `outcome: "ok"` with `result: { kind: "already_loaded", skill, version }`. The runtime MUST NOT insert the body again. A first on-demand load MUST return `result: { kind: "loaded", skill, version, text, references }`. It MUST keep the atomic membership history and tool-completion history.

The model request that asked for a load uses its usual step. The load does not add a model request. Operation replay keeps its recorded-result behavior.

Each model response MUST freeze the instruction-supply state eligible under its captured selected agent and current execution mode. Earlier supply MUST NOT bypass current grants or the selected profile's available skills. The order of on-demand sibling loads and reference reads MUST NOT change. Reference reads MUST continue to use retained bundled bytes. They MUST never use deployment paths or execute scripts.

**Rationale and alternatives:** Durable membership records which skills an actor has loaded. The creation event makes its startup set visible in run history. Separate per-skill events duplicate that information without a necessary execution guarantee.

Atomic creation keeps actor state, membership, and history consistent. Dispatch checks still verify the complete startup set and reconstructed prompt. Recorded startup supply does not prove provider delivery or model compliance.

### 15. Public inspection keeps selection, supply, and actual use different

**Review status:** Approved as written, including Contracts 15A through 15D.

The owner-only Tool classifications page MUST follow Decision 7 and Contracts 15A through 15D below. Saves MUST bind the displayed definition digest and expected revision. A save MUST create a new classification revision, not overwrite retained work. Opening the page MUST NOT start discovery or execute tools. This API changes classification only, not agent selections or independent grants.

The page MUST use `DESIGN_SYSTEM.md` and existing console components and recipes. A new reusable pattern, if necessary, MUST be added to the design system during implementation rather than implemented as a one-off style.

The endpoints MUST stay. This change MUST NOT add a facet-selection mutation API. Owner selection among a run's retained agents is a separate session control under Decision 22. `GET /capabilities` MUST keep the `unconfigured | unavailable | ready` union. A `ready` response MUST show these items:

- Installed contributions and admission results.
- Independent agent configurations, instructions, facet selections, and outgoing delegation targets.
- The separate entry policy, including permitted entry agents and the default.
- Usability and startup configuration for each agent.
- Independent server approvals and grants.
- Explicit tool permissions, read/write classifications, critical designations, sandbox constraints, and discussion eligibility, separately from task-delegation relationships.

Static inspection MUST NOT start processes. It MUST show the usability of an undiscovered tool as not verified, not as usable. Installation omissions and unselected items MUST stay different from compatibility rejections and permission rejections. The runtime MUST remove the old flat contribution field `allowed`, because it would be ambiguous for each agent. Inspection MUST show selection, usability, and authorization as different items.

`catalogRevision` MUST continue to identify the sealed installation for explicit server discovery. Command `selectionRevision` MUST identify the offered entry and workspace context under Contract 15A. Neither revision grants authority. An accepted retry MUST still return its original run after a revision change.

`GET /runs/:runId/capabilities` MUST use this closed public union:

```text
{ kind: "unavailable", throughSeq, reason }
| { kind: "goal", throughSeq, agents, definitions, permissions, limits, usage }
| { kind: "command", throughSeq, command, agents, definitions, permissions, limits, usage }
```

The goal variant and the command variant MUST show these items as different items:

- Retained plans.
- Provenance and admission.
- Startup configuration and recorded startup supply.
- On-demand loads.
- Delegate invocations.
- Discussion invocations and their read-only mode, distinct from task assignments.
- Critical-operation requests, human decisions, and execution outcomes, separately from ordinary tool permissions and sandbox constraints.
- Tool calls.
- Unavailable discovery results.

`agents` MUST distinguish configured identity, actor identity, parent, interaction mode, and nested-invocation depth. Decision 19 extends the common depth bound to discussion. Distinct invocations MUST NOT merge. Permission and mode rejections MUST remain distinct from captured availability. Internal checkpoints, credentials, and unscreened bodies MUST NOT appear in projections. Decisions 18 and 22 define discussion results and lifecycle history.

Inspection MUST distinguish run-owned sessions from their executions. It MUST show session identity, current owner-selected agent, occupied or idle state, execution identities, and recorded outcomes. It MUST separately identify the agent and tools captured by each prepared model step. Owner history inspection MUST remain separate from agent-visible discovery. Discovery MUST query existing sessions of the current run without exposing full transcripts or hidden reasoning. Detailed discovery and inspection shapes still require completion.

New-session startup history MUST appear within `run.created`, `delegation.started`, or `discussion.started`, according to the initial execution kind. Each event MUST identify execution, session, selected agent, and initial startup supply. A new topic alone MUST NOT claim another startup activation. Owner changes can cause new required instruction supply at preparation; existing step history MUST distinguish that cause and its selected agent. The runtime MUST NOT add synthetic tool calls or separate per-skill startup events.

Inspection MUST show each startup skill's retained facet origin, installed version, admission basis, and selection provenance. It MUST distinguish startup membership from later on-demand loads. Inspection MUST use one consistent store view through `throughSeq` for bindings, actor records, membership, operations, and history. Inspection MUST NOT infer use from availability or from configured startup alone. It MUST NOT infer provider delivery or instruction compliance from recorded supply.

Admission errors MUST use the credential-safe error envelope and status mapping:

| Condition | Mapping |
|---|---|
| An incorrect operator schema, old fields, or an unresolved configured reference at startup | A startup configuration rejection with the agent, field, and reference. The service does not accept runs. |
| A changed command selection revision | `409 capability_selection_changed` |
| A selected contribution, prerequisite, or startup selection is unusable, or the startup set is more than the startup bounds | `409 capability_unavailable`. The message gives the safe actor or skill subject and the reason. |
| A new-run facet reference becomes incorrect after startup | `409 capability_unavailable`. The message identifies the affected agent and reference. |
| An unreadable, incorrect, or mismatched sealed installation | `503 capabilities_unavailable` |
| Required MCP discovery is unavailable | `503 mcp_server_unavailable` |
| Optional MCP discovery is unavailable | The runtime accepts the run with a retained unavailable result and a history event at acceptance. There is no error for the full run. |
| Delegate startup is unusable | A recorded delegate result `{ kind: "refused", reason, message }` |
| An answer arrives, and the retained state or checkpoint state is confirmed incompatible | `409 continuation_unavailable`. The runtime does not accept the answer. |
| The runtime cannot verify storage or state temporarily | The retryable verification error or storage error. This is not a confirmed incompatibility. |

Diagnostic reasons MUST include these codes:

- `facet_reference_unresolved`
- `delegate_unknown`
- `startup_skill_unavailable`
- `too_many_startup_skills`
- `startup_instructions_too_large`
- `command_not_selected`
- `prerequisite_unavailable`

Startup and retained usability records MUST contain these machine-readable reasons. Public admission errors MUST keep their envelope and HTTP codes. Messages MUST identify the safe reason and affected subject. This change MUST NOT add an unversioned envelope field. Optional unavailable results MUST remain visible in history and inspection. Tool-policy, mode, effect, and interaction refusals MUST remain distinguishable. Decision 18 supplies discussion refusal codes inside the tool-outcome envelope. Entry eligibility remains separate from discussion and task eligibility.

The console MUST use the same model for goal runs and command runs. The entry selector MUST list only policy-permitted agents and initially select the default. Command availability MUST follow the selected agent without changing it. Only the command variant shows command details. Labels for installed, configured, loaded, and used items MUST stay different. The rendering stays plain text. Critical-approval presentation MUST identify the workspace, individual request, operation, target, and exact arguments or change under Decisions 12 and 13. It MUST distinguish draining current work from waiting for owner action and show each request separately. It MUST NOT substitute a generic permission to act or imply that a hold affects other workspaces.

#### 15A. Start options, revision identity, and owner access

**Review status:** Approved with Decision 15.

All paths below are relative to `/api/v1`. Objects MUST be strict. Credential-screening and same-origin mutation checks MUST remain effective. Routes that receive ordinary messages MUST follow the Message-size and monitoring policy instead of the former common JSON-size ceiling.

Unrelated authentication and administration routes MUST retain their separate input controls. New routes MUST stay behind the existing owner-console deployment boundary. They MUST NOT be registered as agent tools or exposed inside task containers.

The current Host and Origin checks are routing and request-origin protections, not named-user authentication. This version MUST record the principal as `deployment-owner`. It MUST NOT invent a verified person's identity. The private ingress boundary MUST admit only the owner. Deployments with other users MUST add authentication before exposing these controls. Provider authentication remains browser-only and separate from approval provenance.

Trusted MCP connectors MUST NOT expose runtime administration to agents. Their owner-approved launch configuration MUST exclude private runtime storage and administration credentials. A connector able to reach the owner API is part of the trusted boundary, not a sandboxed task. Its approval MUST NOT be described as host-process isolation.

`GET /options` MUST preserve provider and budget fields. It MUST add `defaultEntryAgentId`, `defaultWorkspaceId`, and the first pages of `entryAgents` and `workspaces`. The console MUST fetch further pages rather than truncate options. `GET /options/agents` and `GET /options/workspaces` MUST serve those remaining pages.

```text
EntryOption = { agentId: AgentId, displayName: string }
WorkspaceOption = { workspaceId: UUID, displayName: string,
                    availability: "available" | "held" | "unavailable" }
Page<T> = { items: T[], next: string | null }
StartGoal = { requestId: UUID, provider: Provider, workspaceId: UUID,
              entryAgentId?: AgentId, stepBudget?: StepBudget, goal: string }
StartCommand = { requestId: UUID, provider: Provider, workspaceId: UUID,
                 entryAgentId?: AgentId, stepBudget?: StepBudget,
                 command: { id: CommandId, selectionRevision: Digest, arguments: string } }
```

`POST /runs` MUST accept exactly one of these start shapes. A fresh acceptance MUST return the existing run snapshot with status 202. An equal accepted retry MUST return its original snapshot with status 200. It MUST use Contract 13D's input identity and validation order. An unknown or ineligible explicit entry MUST return `409 capability_unavailable`, with no fallback. An unknown, held, or inadmissible workspace MUST return `409 workspace_unavailable` before discovery.

`GET /capabilities?entryAgentId=<id>&workspaceId=<id>` MUST return command availability for that context. Omitted query choices use current defaults for inspection only. An invalid explicit choice MUST fail without fallback. The existing `unconfigured | unavailable | ready` union MUST remain. A configured-native registry MAY be `ready` with `installation: {kind:"none"}` and no commands.

Command revisions MUST use this formula:

```text
selectionRevision = H({
  kind: "command-selection",
  installation, commandId, entryAgentId,
  workspaceId, executionPolicyRevision,
  configurationDigest, authorityDigest, registryRevision
})
```

`configurationDigest` MUST cover normalized agent configurations, entry policy, and depth setting. `authorityDigest` MUST cover approved server/program identities, definition grants, and argument restrictions, without secret values. `registryRevision` MUST change on registered-definition or classification-head changes. Dynamic gate state MUST NOT enter this digest. Workspace holds remain a separate admission check. Unchanged structured data MUST produce the same digest regardless of object insertion order.

The first `ready` response MUST include pages for configured agents, installed contributions, and commands. Further pages MUST use `/capabilities/agents`, `/capabilities/contributions`, and `/capabilities/commands` with the same context. Selected, unselected, unusable, and not-yet-verified states MUST remain explicit. Removing the ambiguous flat `allowed` field MUST NOT remove grant inspection.

#### 15B. Definition-bound classification saves

**Review status:** Approved with Decision 15.

```text
GET /tool-classifications
  -> Page<ToolSummary>
GET /tool-classifications/:toolKey
  -> {
    toolKey: Digest, identity: ToolIdentity, displayName: string,
    definitionDigest: Digest, definition: JsonObject,
    classification:
      { kind: "unclassified" }
      | { kind: "needs_review", revision: UUID }
      | { kind: "classified", revision: UUID, effect: "read" | "write", critical: boolean }
      | { kind: "fixed", effect: "read" | "write", critical: boolean }
  }
POST /tool-classifications/:toolKey/save
  body: { submissionId: UUID, definitionDigest: Digest,
          expectedRevision: UUID | null, effect: "read" | "write", critical: boolean }
  -> { submissionId: UUID, classification: ToolClassification }
```

`ToolSummary` MUST contain the detail fields except the definition body. Facet tool identity MUST include the installed version under Contract 12B. A detail read MUST show the exact screened definition, not an adapted substitute. If screening cannot permit exact review, the API MUST return `capability_unavailable` and disable Save. Neither list nor detail reads may start discovery.

`displayName` MUST equal the model-visible name defined in Decision 6. The detail MUST retain the structured identity separately from that name. This interface MUST NOT add support for standalone MCP servers.

A save MUST compare the registered definition digest and current classification revision atomically. `expectedRevision: null` means no existing head. A stale digest or head MUST return `409 classification_changed`, without a new revision. Saving a fixed declaration MUST return `403 forbidden`. Unknown tool keys MUST return `404 not_found`.

A successful save MUST atomically append the immutable revision, update its head and registry revision, and store the mutation receipt. It MUST return status 200 with that saved revision, not an unrelated later head. A repeated equal submission MUST return its saved result even after another save. Reusing its ID with different input MUST return `409 request_conflict`.

#### 15C. Approval decisions and explicit outcome resolution

**Review status:** Approved with Decision 15.

```text
GET /workspaces/:workspaceId/approvals
  -> { workspace: WorkspaceOption, gate: GateView, approvals: Page<ApprovalSummary>,
       unresolvedEffectCount: Decimal }
GET /workspaces/:workspaceId/approvals/:approvalId
  -> ApprovalDetail
POST /workspaces/:workspaceId/approvals/:approvalId/decision
  body: { submissionId: UUID, requestDigest: Digest, verdict: "approve" | "reject" }
  -> { submissionId: UUID, decision: ApprovalDecision }
GET /workspaces/:workspaceId/unresolved-effects
  -> { gateRevision: PositiveDecimal, effects: Page<UnresolvedLeafSummary> }
GET /workspaces/:workspaceId/unresolved-effects/:leafId
  -> UnresolvedLeafDetail
POST /workspaces/:workspaceId/unresolved-effects/:leafId/resolve
  body: { submissionId: UUID, observedOutcomeDigest: Digest,
          assertion: "effect_confirmed" | "no_effect_confirmed" | "acknowledged_unknown",
          executorStopped: true, evidence: string }
  -> { submissionId: UUID, resolution: OwnerOutcomeResolution }
```

`GateView` MUST contain `{revision, state}`, where state is `open | draining | held | executing | outcome_unknown`. `ApprovalSummary` MUST contain request ID and digest, workspace/run/actor/operation references, tool identity, creation time, decision state, and execution state. The closed decision union is `pending | approved | rejected`. Approved and rejected variants MUST include the immutable decision ID and time.

The execution union MUST be `not_started | executing | succeeded | failed | not_executed | uncertain`. Terminal variants MUST include a safe reason or outcome reference and recorded time. An owner outcome assertion MUST appear separately from this runtime execution state. An unknown outcome MUST NOT become `succeeded` merely because the owner acknowledged it.

`ApprovalDetail` MUST add the exact `ApprovalScope`, verified inline or artifact argument object, and any owner outcome resolution. Artifact bytes MUST be digest-verified before display. List rows MAY omit large review content, but Approve MUST use detail content and its digest. The console MUST use explicit per-request Approve and Reject actions, never a bulk permission action.

`UnresolvedLeafSummary` MUST identify the leaf, run, actor, model-attempt or tool-operation identity, and safe reason. `UnresolvedLeafDetail` MUST add the recorded owner epoch, `observedOutcomeDigest`, and safe outcome evidence. It MUST NOT expose provider credentials or private checkpoints. This surface includes ordinary leaves that block drain after a crash, not only critical operations.

Each collection route MUST accept its own `cursor` and `limit`. Approval pages and unresolved-effect pages MUST NOT share a cursor. Each response MUST identify its observed gate revision. Advancing either collection at a changed revision MUST return `409 capability_selection_changed`, requiring a new first page for that collection.

A decision MUST match the request digest and workspace. A stale digest, already-decided request, or closed operation MUST return `409 approval_conflict`. Equal submission replay MUST be checked first. An approval ID belonging to another workspace MUST return `404 not_found`.

Outcome resolution MUST compare the exact unresolved leaf and outcome digest under the workspace gate. A stale or already-resolved leaf MUST return `409 approval_conflict`, except for equal submission replay. A successful response records the assertion only. It MUST NOT promise workspace reopening or tool success. Other requests and leaves can keep the gate closed.

Owner reads, decisions, outcome resolutions, answer submissions, and cancellations MUST remain available during a hold. No endpoint MUST directly dispatch a critical operation. The executor follows Contract 13B after the mutation commits.

#### 15D. Mutation receipts, bounded inspection, and errors

**Review status:** Approved with Decision 15.

Mutation families MUST be `classification_save`, `approval_decision`, `outcome_resolution`, and `session_agent_select`. A receipt key MUST be `(family, submissionId)`. Its input digest MUST equal `H({kind:"mutation-input", family, target, body})`, excluding only `submissionId`. `target` MUST identify the exact tool, workspace request or leaf, or owning run and session. The result reference and receipt MUST commit with the mutation.

After structural and credential checks, equal receipt lookup MUST precede current-state checks. A different input under the same key MUST conflict. Unknown commit status MUST use `503 acceptance_unknown` with `acceptance: "unknown"`. Retry MUST use the same submission ID and body. The server MUST NOT create a new submission identity to repair uncertainty.

All new collection endpoints MUST use keyset pages with default limit 50 and maximum 100. IDs determine stable order; approval queues use `(createdAt, requestId)`. A cursor MUST bind endpoint, context, filter, order, revision or watermark, and last key. Unknown or altered cursor fields MUST return `400 invalid_cursor`. Catalog and configuration cursor revisions that changed MUST return `409 capability_selection_changed`, requiring a fresh first page. Gate queue reads MAY restart on revision change; they MUST NOT mix revisions within one response.

The existing run-capability union MUST remain, but its large collections MUST use `Page<T>` rather than fixed-size arrays. `agents` MUST separate configured plans, sessions, and execution turns. `definitions` MUST show safe identity and provenance, not full snapshot bodies. `permissions` MUST show captured policy and grants separately from current revocation status. `limits` MUST contain depth and run budget, without a delegation-call counter.

`GET /runs/:runId/capabilities/:collection` MUST serve `plans`, `actors`, `definitions`, or `usage`. It MUST accept the same `throughSeq` and page cursor chosen by the initial projection. All visible actor states, memberships, usage, and outcomes MUST be derived through that sequence. Mutable current rows MUST NOT supply later outcomes to an earlier page. Event payloads and immutable lifecycle records MUST permit reconstruction without an open transaction across HTTP requests.

A facet-free goal MAY have empty installed-definition collections, but MUST use the normal goal projection and retained binding. Workspace identity, gate state, and approval links MUST appear for every run. Live workspace and agent-selection state MUST be labeled separately from historical `throughSeq` data. Current grant status MUST be labeled as a current check, not historical authority. The projection MUST NOT infer compliance or successful execution from supplied instructions or approval.

The API MUST preserve the existing error envelope: `{error:{code,message,retryable,acceptance,...existingReferences}}`. It MUST NOT add an unversioned general-purpose details field. The classification and approval additions remain `classification_changed` and `approval_conflict`, both status 409.

Public failure contracts MUST also distinguish reliable size and context rejection evidence under the Message-size and monitoring policy. Unknown provider failures MUST remain unclassified. Reports MUST preserve the actual local or provider boundary and whether acceptance or dispatch occurred. The console MUST show safe explanations without raw provider bodies or message contents. Tool preparation and execution refusals remain typed tool outcomes, not new HTTP envelopes.

| Condition | HTTP result |
|---|---|
| Malformed shape, missing workspace, invalid cursor | Existing 400 code; `acceptance: "not_accepted"` |
| Request-origin rejection or fixed-policy edit | `403 forbidden` |
| Unknown record or wrong workspace scope | `404 not_found` |
| Changed mutation input | `409 request_conflict` |
| Stale classification review | `409 classification_changed`; re-read before another save |
| Conflicting decision or outcome resolution | `409 approval_conflict`; no automatic retry |
| Held or unavailable workspace on new start | `409 workspace_unavailable` |
| Historical cursor beyond committed events | `409 cursor_ahead` |
| Temporary storage or verification failure | Existing 503 error with accurate retryability |
| Unconfirmed mutation commit | `503 acceptance_unknown`; retry identical input only |

**Code basis:** `packages/contracts/src/commands.ts:28-80` defines existing strict starts. `packages/runtime/src/service/results.ts:8-39` defines error mapping. `packages/runtime/src/request-policy.ts:1` describes the deployment boundary. The implementation MUST preserve these distinctions rather than describe Origin checks as human authentication.

**Rationale and alternatives:** If goal responses stay `native`, the main new capability path is not visible. One ready or refused flag cannot accurately show installation, selection, authorization, and actual activation.

**Owner session-agent selection**

```text
POST /runs/:runId/sessions/:sessionId/agent

body: {
  submissionId: UUID,
  agentId: AgentId
}

result: {
  submissionId: UUID,
  sessionId: UUID,
  selection: {
    seq: NonNegativeSafeInteger,
    agentId: AgentId
  }
}
```

The route MUST remain owner-only and MUST NOT be exposed as an agent tool.

It MUST accept only a configuration retained by the owning run. Unknown pairs of run and session MUST return `404 not_found`. An unavailable retained target MUST return `409 capability_unavailable`.

A new selection for a terminal run MUST return `409 capability_unavailable`. Equal receipt replay MUST still return the recorded result before current-state checks.

A successful selection MUST atomically update session selection metadata, record its sequence and provenance, and store the mutation receipt.

The sequence MUST start at zero for initial selection and increase for each committed new selection.

The route MUST NOT require `expectedSeq`. Existing mutation receipts MUST prevent an earlier retry from overwriting a later selection.

The latest committed selection at model-step preparation MUST apply. Already-prepared requests and their tool calls MUST keep their captured selection.

Success MUST return status 200 and the saved selection, not an unrelated later selection.

### 16. Current runs continue only under their retained execution definition

**Review status:** Approved as written.

The development reset in Decision 3 removes runs and records from before this change. The runtime MUST NOT read, resume, or convert those records. Native runs and capability-bound runs that the runtime accepts after the reset MUST stay readable without access to the current installation.

The runtime MUST reject the superseded `capabilities.maxDelegationsPerRun` setting with migration guidance. It MUST NOT silently ignore the setting.

Guidance MUST explain that new runs use delegation depth and the run-wide model-step budget instead of a delegation-call limit.

Before the runtime accepts an answer, continuation MUST still need these items:

- Valid records in the current format.
- Exact compatibility of the saved execution definition.
- Correct actor bindings and checkpoint bindings.
- The original provider binding and workspace binding.

Continuation of a current run MUST use retained agent configurations, delegation relationships, execution limits, and startup memberships. Current configuration MUST NOT change its execution definition. Changes to the startup, skill, or nested-delegation protocol MUST be part of the execution-definition digest.

Owner selection among retained agents is authorized session metadata, not a replacement deployment definition. It MUST NOT invalidate continuation solely because selection changed. Existing checkpoints and prepared-step bindings MUST retain their original context. New preparation MUST use the latest owner selection without rewriting previous prompts, tool definitions, or digests.

Continuation MUST preserve tool policy, workspace identity, sandbox constraints, approval holds, and discussion restrictions. A restart MUST NOT broaden approval, clear an unresolved hold, or promote discussion into task execution. Decisions 20 and 22 define discussion suspension and ancestor-chain verification. Records MUST NOT receive invented approvals or discussion history. Execution continuation MUST NOT rewind workspace files.

The execution-code identity covers common execution roots and their import closure. These roots include agent assembly, run-store behavior, and capability authority. See lines 23 to 45 of `packages/runtime/src/execution/code-manifest.ts`. If a later build changes this identity, a current run that waits fails the exact execution-definition check. It fails as `continuation_unavailable` with `definition_changed`, and its records stay readable.

The implementation MUST NOT bypass the check. It MUST NOT rewrite recorded digests to make a false compatibility.

Selection changes in the same build during a pause MUST NOT make a current run incompatible. The runtime does not put current selections into retained definitions.

Persistence MUST create the current database schema after the reset in Decision 3. This change MUST NOT add a data-preservation migration. The current schema MUST contain these items:

- Closed snapshot and binding records without fields that select a format.
- Message and aggregate snapshot records without the removed application size ceilings, under the Message-size and monitoring policy.
- No delegation-count fields or delegation-count enforcement.
- Run-capability bindings that contain goal inputs or command inputs, with a start mode that agrees.
- Actor and delegation consistency checks for capability-bound goal runs and nested delegations, including parent identity and depth.
- The exclusive startup or on-demand membership source and a nullable operation reference.
- Complete startup lists in actor-creation events, with exact actor identities and retained definition digests.
- Atomic agreement between actor creation, startup memberships, and the creation event, including empty startup sets.
- Startup refusal history under existing operation or discussion identities, without executable children or partial memberships.
- Replay of creation events without duplicate memberships or history; rejection of conflicting startup lists or definition digests.
- Absence of separate per-skill startup events and startup event keys.
- The `capability.unavailable` event payloads and their source-key consistency checks.
- The discussion actor, tool binding, result, and history variants proposed in Decision 22.

Acceptance MUST enforce entry startup completeness. Creation of every executable delegate MUST enforce delegate startup completeness. The runtime MUST NOT invent startup or selection provenance. Contracts 12D and 13A through 13C define the additional database constraints and held-state transitions.

**Rationale and alternatives:** Support for old records needs more decoders and conversion code without a current user need. A promise to resume runs across code changes can require unsafe exceptions to the code-identity check. The reset and the exact execution-definition check keep one strict boundary.

### 17. Verification proves real installation and deterministic context before live behavior

**Review status:** Approved as written. Live traffic, deployment, owner-state changes, and data resets still need separate approval.

Fast unit checks MUST cover these items:

- Equivalence of metadata without settings for commands, skills, and agents.
- The rejection behavior for explicit restrictions.
- Configuration normalization errors and migration errors.
- Explicit rejection and migration guidance for `capabilities.maxDelegationsPerRun`.
- Default depth 2 when omitted, explicit depth 0, and valid explicit depth above 8.
- Rejection of negative, fractional, non-finite, and inexactly represented depth values without rounding or clamping.
- More than 32 configured agents and valid target and entry sets above 32 without a fixed count rejection.
- Per-agent selection and provenance.
- All installed supported skill, command, and MCP tool candidates from a selected facet, without another per-agent allowlist.
- Unselected facets remain unavailable despite installation, and selected facets do not bypass owner grants or add task-delegation relationships.
- Dependency usability.
- Startup limits.
- Startup-list order, unique skill IDs, exact definition digests, and empty lists in actor-creation events.
- Startup membership without a separate event key, and on-demand membership with its successful load operation.
- Depth-awareness values from retained actor records, including depth 0 with maximum 0.
- Task and discussion prompts at depth 1 with maximum 2, with different permitted child interactions.
- Both modes at the maximum depth, with no delegation or discussion tool offered.
- Child-tool omission without removal of unrelated eligible tools or retained definitions.
- Permission narrowing.
- Role-specific writes, independently of a caller's selected tool catalog.
- Explicit read-only or mutating classification and critical designation, with missing required declarations preventing tool execution.
- Tests MUST verify native bootstrap, owner overrides, unchanged revisions after restart, and refusal of changed definitions pending review. Facet tools MUST remain unavailable without their required owner classification.
- Structured facet and native identities, separate from exposed names.
- Model-visible names and console labels with the `tool__` and `facet__` prefixes.
- Rejection of ambiguous effective server IDs and exposed names, including conflicts caused by `__` within components.
- Reservation of `mcp__` without standalone MCP configuration, discovery, agent access, or execution.
- Definition changes that require renewed classification while unchanged retained definitions remain identifiable by their original digest.
- Classification lookup through the installation-selected origin, without merging or requiring agreement from other origins.
- Missing selected-origin references or matching classifications, and mismatched definition digests, without fallback to another origin.
- Preservation of existing authored restriction scopes after re-export and resealing.
- Critical status independent of read/write classification.
- Rejection of model or server claims that try to override runtime or owner-controlled tool policy.
- Critical-approval invalidation when the operation, target, or exact arguments or change differs.
- Immutable policy revisions without schema-version fields; rejection of unsupported variants and restrictions.
- Rejection of malformed records, unsupported variants, incorrect hashes, and fields that only select an old format.
- Docker as the only initial sandbox variant, with validated pinned-image, network, resource, user, and filesystem constraints.
- Workspace policy compatibility for new attachments, without first-attacher-wins configuration or silent policy widening.
- Unknown record producers that cannot acquire authority through provenance metadata.
- The tagged public records and retained records.
- Canonical request, policy-reference, tool-identity, and agent-plan digest vectors, including object-key order and argument-array order.
- Explicit omission versus explicit default values in start identity, including budget and entry choice.
- Configured-native retention without an installation.
- Explicit refusal of unsupported authored installed-agent bindings, without name-based substitution or discarded restrictions.
- Strict Docker settings, non-overlapping workspace roots, verified image digests, and refusal of mismatched existing container names.
- Exact approval arguments and artifact bytes, changed file preconditions, and refusal of unsafe or incomplete owner review content.

Message-policy tests MUST also cover these items:

- Valid ordinary messages above the former field ceilings, without artificial text-size rejection.
- Message-bearing HTTP routes without the former body ceiling, while unrelated authentication and administration controls remain effective.
- Command expansion without a hidden rendered-goal ceiling, with full content screening and faithful retention.
- Model messages, tool outcomes, and retained snapshots without the removed common aggregate ceilings.
- Deliberate answer-length constraints without an additional universal byte limit.
- Reliable provider size and context errors, other invalid requests, and unknown, empty, or non-JSON responses.
- Local serialization and storage failures that do not become provider rejection or invariant violations merely because content is large.
- Retained accepted input, accurate acceptance and dispatch status, and no unchanged retry after confirmed size or context rejection.
- Required size, latency, failure, token-usage, persistence, and host measurements, without message bodies or credentials in telemetry.
- Unknown token usage that remains unknown rather than zero, and metric labels without per-run identifiers.
- Operational monitoring before removal of enforcement, including host evidence after process termination.

These tests MUST use deterministic adapters and fault injection. Capacity experiments, live provider requests, and deployment changes need separate owner approval. Tests MUST NOT exhaust development resources to discover a limit.

Test fixtures MUST use the actual installer metadata shape of the adapter, which includes identity-only metadata. This change does not add an authored presence marker.

Service tests and API tests MUST use deterministic model adapters for both providers. They MUST cover these items:

- Parity of goals and commands.
- The exact startup body in the first request of the entry agent.
- Startup lists in run, delegation, and discussion creation history, without separate per-skill events or synthetic tool calls.
- Atomic agreement between new-session creation, its initial turn, the complete startup membership set, and creation history.
- Creation replay without duplicate memberships or history, and refusal of changed startup lists or definition digests.
- The same depth-awareness block after a child returns and during compatible continuation.
- Refusal of prohibited child calls even when the model requests a tool omitted from its offered set.
- Safe startup-refusal history with parent-operation completion, without executable children or partial memberships.
- Catalog behavior for on-demand skills only.
- Independent configuration of the same startup skill for different agents and attribution to their separate actors.
- Delegate exclusion when only the caller selects a facet.
- Delegate-only skills under caller restrictions.
- The same configured agent as an entry agent and as a delegate.
- Default entry selection when the request omits an agent, and explicit selection of another permitted agent.
- A delegate-only agent that is absent from the entry selector and rejected by direct run-start requests.
- Invalid entry-policy references and a default outside the permitted entry set.
- Command availability under the selected entry agent without automatic agent changes.
- Accepted retries after the default or permitted entry set changes, including retries that omitted an agent.
- Explicit outgoing target checks at every depth, without copying ancestor target lists.
- A depth-2 chain that succeeds and a depth-3 request that fails under a maximum depth of 2.
- Repeated calls from the existing depth-1 caller that stay at depth 2 without resetting consumed budgets.
- Repeated permitted delegation without a count-based rejection while the run-wide budget remains.
- Model-step budget exhaustion across nested actors, without a fresh budget for a child or a reset on return.
- A new invocation of an earlier agent name that still increases depth.
- Already-loaded results.
- Bundled-reference eligibility.
- Discussion with an agent absent from the caller's task-delegation list, with authorized reads and advice only.
- A reviewer that can post comments in task execution but cannot modify code, and cannot do either in discussion mode.
- A Publisher consultation that cannot publish or delegate publication.
- Mode enforcement even when the model ignores its prompt or a discussion message requests a write.
- Rejection of task delegation, mode changes, and indirect mutation from discussion.
- Propagation of the discussion restriction through further consultations, with no conductor exception.
- Refusal of unclassified tools and rejection of server claims that try to establish read-only authority by themselves.
- Discussion information access within owner restrictions, not implicit access to another agent's data.
- `tool__Discuss` input validity without a topic-size ceiling, strict new-session or existing-session targets, unknown-field rejection, and exclusive-call batch refusal.
- New sessions of the caller's own configured agent, with different session identities and no automatic conversation copy.
- Sequential reuse of an exact idle session by different permitted callers in the same run, with retained conversation.
- Atomic idle-to-active session updates under the existing owner fence, busy refusal, and refusal of every waiting ancestor session.
- New topics with new turn identities, while completed-operation replay adds no topic, turn, or model work.
- New-turn depth from its current caller rather than the target session's creation depth, without a budget reset.
- Reused session skill state with originating-turn provenance, current-mode checks, and no duplicate startup activation.
- Rejection of other-run session targets within the same workspace, and fresh sessions and context for each new run.
- Terminal runs admitting no new turns while retained owner history and uncertain-effect records remain intact.
- Mixed task and discussion paths at the shared depth bound, including depth 0, repeated siblings, and safe-integer overflow checks.
- Consultation clarification returned as advice, without direct owner questions or unsolicited caller messages.
- No implicit parent or sibling context; new-session startup and reused-session history with turn-specific reference eligibility.
- Native discussion configurations retained without installation reads, including a single configured agent used by multiple sessions.
- Uniform snapshots and bindings for every accepted run, including facet-free goals with no installation or MCP access.
- Owner-only session-agent selection from retained configurations, with no agent-callable switch control.
- Owner changes during a model request, tool execution, or wait, without interrupting work or starting another execution.
- Captured agent and tools retained for the current prepared step; the latest committed selection used at the next preparation.
- Several selections before preparation, and idempotent replay of an earlier selection without overwriting the latest choice.
- Selected-versus-prepared agent inspection, with immutable historical request and tool provenance.
- Startup reconciliation after an owner switch, without loading all facet skills, duplicate body insertion, or synthetic tool calls.
- Earlier skill text retained as history without permission to use capabilities denied under the current captured agent and grants.
- Compatible continuation across owner selection changes without changed mode, depth, workspace, provider binding, or consumed budget.
- Runtime-owned discussion classification displayed without edits, while child leaf tools retain independent classification and approval.
- Authorized non-critical sandboxed edits and tests without a prompt for every intermediate write.
- Sandbox enforcement for tools and subprocesses, plus independent resource-permission checks for remote tools.
- Critical-operation approval before execution through every exposed route, including wrappers and remote tools.
- Rejection of attempts to use approval to bypass sandbox or resource permissions.
- A changed critical operation, target, arguments, or diff that cannot reuse an earlier approval.
- A changed bound classification or execution-policy revision that needs a new approval request and decision.
- Review content equal to the immutable arguments or digest-verified change artifact used for execution.
- Discussion-lock preservation despite sandbox write access or critical-operation approval.
- Several permitted invocations sharing one workspace without merged identities, permissions, or independent run budgets.
- Isolation between different workspace storage and execution environments.
- Cancelling one run or finishing one agent without stopping infrastructure still used by another invocation.
- Frozen critical-operation arguments or change artifacts despite concurrent edits to shared workspace paths.
- Owner inspection of tool definitions and their classifications under the resolved setup interface.
- Owner-only classification listing and explicit saves to PostgreSQL, with stale-definition saves rejected.
- No classification, tool execution, or MCP discovery from opening the classification page.
- Classification saves do not modify facet selections, server approvals, or independent tool grants.

These tests MUST prove that commands and instructions cannot increase authority. Optional MCP outages and name collisions MUST NOT cause unrelated goals to fail. Required failures and current revocations MUST prevent dispatch.

Process tests and persistence tests MUST prove these items:

- Atomic startup history and membership.
- Replay, concurrent acceptance, and concurrent delegate creation.
- Request retries after configuration changes.
- First use by a nested delegate after a pause.
- Selection removal compared with independent grant revocation.
- Retained inspection after the facet is uninstalled.
- Retained classification and selected-origin identity after a later installation selects another origin.
- Compatible continuation and incompatible continuation.
- Creation of the current database schema without a data-preservation migration.
- A reset procedure that identifies its targets before deletion and removes old runtime records. It keeps workspace files, source repositories, owner configuration, credentials, upstream facet sources, and unrelated databases and services.
- Normal application startup that does not delete records.
- New snapshots and bindings without a delegation-count field or an enforced count limit.
- Retained agent configurations above the previously proposed count bounds, without an aggregate snapshot ceiling or an agent-count limit.
- Retention and first use of discussion targets without task-delegation edges.
- Discussion-mode persistence across compatible continuation, distinct from unrestricted task invocations.
- Discussion history, checkpoint, and budget bookkeeping without mutation of task resources.
- Critical-operation requests, human decisions, and execution outcomes across replay and compatible continuation.
- Immutable classification and execution-policy revisions with historical run and request bindings.
- Stable workspace identity and existing persistent files across container restart or replacement, without filesystem rewind or restoration of background processes.
- Concurrent workspace use that does not create competing containers.
- Prevention of teardown or explicit deletion beneath active work, without a separate attachment state machine.
- No automatic workspace snapshots, rollback, synchronization, commits, idle-stop, or deletion.
- Preservation of capability-definition snapshots, execution checkpoints, run history, and approval records despite removal of filesystem recovery machinery.
- Preserved workspace files without a promise to restore background processes or temporary state.
- Missing sandbox support that fails explicitly without host execution fallback.
- Task containers without Docker control, runtime state, database credentials, or provider credentials.
- Concurrent decisions that converge on one authoritative resolution per approval request.
- Repeated approval submissions without independent redispatch.
- Approval creation or acceptance without invented execution success.
- Uncertain outcomes that do not become automatic retries by being relabeled as failures.
- Workspace-wide gate closure before drain, with race-safe admission across all runs using that workspace.
- In-flight calls that settle under existing rules without their results dispatching more work while held.
- New model requests, tool calls including reads, discussions, and delegations blocked by a workspace hold.
- Several approvals that remain independent, with at most one approved critical execution at a time per workspace.
- Owner controls and runtime bookkeeping that remain available during holds.
- Ordinary admission reopening only after requests and authorized critical work are resolved, respecting terminal run states.
- Uncertain critical outcomes that retain the hold through restart until explicit owner resolution.
- Workspace A's hold not blocking Workspace B, and agent attempts to select another workspace being rejected.
- Uncertain critical-operation outcomes handled under the resolved contract without invented success or broader approval.
- Proposed discussion actor keys derived from actual parent operations, including nested parents and replay conflicts.
- Atomic discussion startup and completion, with stable event-source keys and no duplicated advice on replay.
- Full discussion ancestor-chain and checkpoint verification during compatible continuation.
- A child critical read that drains leaf work without deadlocking on suspended parent wrappers.
- A workspace hold that preserves the discussion operation without a fake owner question, extra model charge, or new child identity.

Tests MUST continue to cover the shared model-step budget, retained tool-specific controls, and uncertain external dispatch. Message-size tests MUST follow the Message-size and monitoring policy rather than preserve removed ceilings. Decision 20 introduces no separate tool-call counter. Finite deadlines MUST use injected clocks and failures. Tests MUST NOT use slow timeout sleeps.

Contract-completion tests MUST also cover these cases:

- Two processes race workspace admission against gate closure, with deterministic barriers rather than sleeps.
- An intent commits but its acknowledgement or transport handoff is lost; recovery never resends it automatically.
- A stale owner loses database authority without proof that its external effect stopped; the hold remains.
- Equal and conflicting classification saves, decisions, and outcome resolutions, including lost HTTP responses.
- A decision arrives during drain, followed by cancellation or grant revocation before critical intent.
- More than one approved request uses one workspace slot without blocking another workspace.
- Ordinary and critical unresolved leaves both require explicit owner resolution without altered runtime outcomes or refunded budgets.
- A durable held run resumes once; checkpoint failure does not publish a false continuation binding.
- A nested task question receives an answer during a workspace hold, with no extra question or early dispatch.
- Native run inspection uses its normal capability snapshot and shows workspace holds.
- Catalog cursor staleness and historical run pages do not mix revisions or later actor outcomes.

The database tests MUST use real PostgreSQL constraints for uniqueness, foreign keys, and immutable records. Reset tests MUST use disposable test databases and directories, not development or production state. Model and tool adapters MUST remain deterministic. Docker verification MUST use a disposable local workspace and an approved test image, not production infrastructure.

Docker verification MUST be separately identifiable and mandatory in the development-stack acceptance gate. An environment without Docker MAY omit that tier from a limited check, but MUST NOT report full verification.

Explicit cases MUST cover these conditions:

- Selection changes or startup changes in the same build during a human pause.
- Inspection of current-run records after the facet is uninstalled or the configuration changes.
- Rejection of a changed execution-definition digest for a current run that waits.
- Facet-free goals under the supplied default with normal snapshots and bindings but no MCP or installation access during admission.
- Incorrect startup designations that reject the start and do not fall back to native.
- Optional discovery failures in acceptance history.
- Current prerequisite revocation before the first model request of a delegate.
- Startup prerequisite checks in discussion mode without enabling a mutating tool to satisfy a prerequisite.

The installation proof MUST use the published `voice-to-text` facet without changes. The pinned CLI and the updated runtime adapter MUST materialize it in the independent runtime project. Its resolved version, integrity, manifest, and lockfile MUST establish identity. Deterministic tests MUST compare captured requests with the actual exported installed body, not with a synthetic replacement. If bundled references are present, they MUST keep their installed bytes.

Different configurations MUST prove two cases. The first case selects startup only for the entry agent and excludes it from a delegate. The second case configures the same facet and startup skill independently for both agents. This work MUST NOT change editor installations or imply production selection.

Browser coverage MUST stay a small number of smoke checks on the built console. These checks start a goal and show startup provenance and selection provenance. They are not a behavior matrix. UI projections and rendering branches MUST mainly use component tests and data-pattern tests. The single version-pin snapshot stays the only pin test. This change needs no new suite of pin assertions.

A live journey needs separate approval. It MUST use a bounded dictated-text task, an explicit provider and step budget, and an outcome and provenance that the owner can inspect. Useful text interpretation is live evidence. Deterministic tests establish instruction supply and isolation. Owner authentication MUST stay browser-only.

These operations MUST each have their own approval gate: deployment, production installation, configuration and grant changes, owner-state operations, and provider traffic. If a verification fails, the work MUST stop for a report. Automatic repair and automatic reruns are not permitted.

**Rationale and alternatives:** A synthetic fixture alone cannot prove that the published facet installs without changes. A live model result alone cannot prove startup context or isolation. It is also not correct as the main regression test.

### 18. A discussion is one synchronous consultation turn in a new or existing session

**Review status:** Approved with the Message-size and monitoring policy and its listed change-local corrections. Decisions 19 and 21 add approved depth-aware exposure and same-run session targeting. Decision 22 is approved as an outline with explicit contract-completion requirements.

The runtime MUST provide the native control tool `tool__Discuss`. It MUST reuse the existing child-invocation path, not introduce a message bus or scheduler.

Tool exposure MUST obey Decision 19. The runtime MUST omit this tool at the actor's maximum depth. Its presence below that depth MUST NOT bypass target, mode, permission, budget, or workspace checks.

The tool MUST accept this closed input:

```text
{
  target:
    { kind: "new", agentId: AgentId }
    | { kind: "session", sessionId: SessionId },
  topic: string
}
```

For a new-session target, `agentId` MUST identify an exact retained configuration, including the caller's own configuration when selected. For an existing-session target, `sessionId` MUST identify an accessible idle session owned by the caller's run. The runtime MUST NOT substitute a fresh session or address another run's session.

`topic` MUST be nonblank, storable text. It MUST follow the Message-size and monitoring policy, without a separate discussion-topic size limit.

The runtime MUST reject unknown fields. It MUST screen input before public persistence or model supply.

Each accepted call MUST create one discussion turn in the selected session under Decision 21. A new-session target MUST also create that session. The turn MUST use the caller's run, workspace, and provider binding. It MUST NOT copy another session's conversation or attach to an occupied turn. Same-run ownership, access, and compatibility checks MUST pass before an existing session is claimed.

The caller MUST wait for the result. `tool__Discuss` MUST be the only tool call in its model response. A mixed batch MUST refuse every call without dispatch, with `discussion_not_alone`. This extends the existing exclusive-call rule for delegation and owner questions.

The success result MUST use the existing tool-outcome envelope:

```text
{
  outcome: "ok",
  result: { discussionId, sessionId, agentId, text }
}
```

The result MUST contain the child's final advice, not its full transcript. The runtime MUST screen the result before return or persistence.

Discussion results MUST follow the Message-size and monitoring policy. The runtime MUST NOT impose a separate advice-size limit or silently truncate advice.

Provider, transport, serialization, and storage failures MUST retain their actual failure category. A failure MUST NOT become a successful result with missing content.

The runtime MUST use stable refusal or failure codes:

| Condition | Code and behavior |
|---|---|
| Invalid input | `invalid_discussion`; no child |
| Unknown, absent, or refused retained target | `discussion_target_unavailable`; no child |
| Selected session is occupied, including the caller's session or a waiting ancestor | `discussion_target_busy`; no new turn |
| Depth would exceed the retained limit | `interaction_depth_exceeded`; no child |
| Target startup cannot satisfy discussion restrictions | `startup_skill_unavailable`; no executable child |
| Child ends without a final answer | `discussion_no_result`; failed child result |

Scoped refusals and ordinary child failures MUST return to the caller without pretending that useful advice was produced. Cancellation, budget exhaustion, storage failures, and uncertain dispatch MUST retain their existing run-level behavior. They MUST NOT be converted into successful discussion results.

**Return to a caller**

The first version MUST return advice only through the parent tool result. It MUST NOT add unsolicited messages to a live caller, sibling, or another run. A caller MAY send a new topic after it receives the result. That call creates a new operation and turn, and MAY reuse the same idle session. It MUST NOT reopen the previous completed operation.

`discussionId` identifies the consultation turn; `sessionId` identifies its reusable conversation. A busy refusal MUST NOT append a topic or start another turn. Unknown or inaccessible targets MUST retain the safe unavailable-target refusal. Unknown fields and model-supplied mode, workspace, depth, budget, or checkpoint overrides MUST remain prohibited.

A discussion actor MUST NOT invoke `tool__AskUser`. If it needs clarification, it MUST return that need in its advice. A task-mode caller can then use its existing owner-question tool. If the caller is also in discussion mode, the advice returns through the same chain.

This does not remove owner questions from ordinary task delegates. It also does not disable owner approval controls for a permitted critical read requested during discussion.

**Control-tool policy**

`tool__Discuss` MUST have a fixed runtime declaration: `effect: "read", critical: false`. Its orchestration bookkeeping is not a mutation of task resources. The classification page MUST identify that declaration as runtime-owned and non-editable. Leaf native and MCP tools MUST retain their owner-managed classification rules.

The fixed declaration MUST NOT approve a child tool call. Each child operation MUST pass its own mode, grant, critical-approval, and workspace-gate checks. This proposed exception prevents an approval for a whole consultation from becoming approval for unknown child effects.

**Rationale and alternatives:** A synchronous result gives each consultation a clear caller and completion boundary. Reusable sessions preserve useful prior conversation without concurrent entry. Separate sessions of one configuration permit independent analysis. Busy refusal avoids queues and active-session interruption. Returning missing information as advice avoids a separate nested owner-question protocol for consultations.

**Code basis:** `packages/runtime/src/execution/delegation.ts:42-50` defines the existing bounded child input. Lines 253-277 invoke the child and return its recorded result. `packages/runtime/src/execution/agent.ts:391-432` enforces exclusive tool calls.

### 19. Task delegation and discussion share one nested-invocation depth limit

**Review status:** Approved with actor depth awareness, mode-specific tool exposure, and the listed change-local corrections. Decision 21 applies these rules to each session turn. Decision 22 is approved as an outline with explicit contract-completion requirements.

The runtime MUST use one path-local `depth` for new child invocations. The entry actor has depth 0. Either a task delegation or a discussion MUST create its child at the caller's depth plus 1.

Both interactions MUST use the existing configured maximum delegation depth from Decision 1. Its default stays 2. Its accepted values stay non-negative safe integers without an additional policy maximum. There MUST NOT be a separate discussion-depth setting or a total discussion-call limit.

With a maximum of 2, these paths are permitted:

```text
Entry task: depth 0
  Task delegate: depth 1
    Discussion: depth 2

Entry task: depth 0
  Discussion: depth 1
    Further discussion: depth 2
```

An actor at depth 2 MUST NOT start another child under that limit. At depth 0, a configured maximum of 0 permits no discussion or task child. Returning to an existing caller does not add depth. Later sibling calls use the caller's depth plus 1 again.

The runtime MUST derive depth from retained parent records. The model MUST NOT supply or reset it. The runtime MUST test the bound before incrementing a safe integer, so the maximum representable value cannot overflow.

**Actor awareness and tool exposure**

The runtime MUST include a depth-awareness block in each execution turn's system prompt before its first model request. Every later request within that turn MUST contain the same block. A later turn in the same session MUST derive its own depth from its current caller.

The block MUST state:

- The actor's task or discussion mode.
- Its current depth.
- The run's retained maximum depth.
- Its remaining child levels, calculated as maximum depth minus current depth.
- The child interactions that its mode and depth permit.

The runtime MUST derive these values from retained run and actor records. Model input MUST NOT set or change them.

The block MUST explain that each new delegation or discussion adds one level. Returning to an existing caller does not add depth. Later sibling calls use the caller's depth plus one again.

The block MUST distinguish remaining nesting levels from a total call allowance. It MUST NOT imply that a return resets the shared model-step budget.

**Mode-specific instructions**

For a task actor below the maximum depth, the block MUST explain that task delegation and discussion remain subject to permitted targets and dispatch checks.

For a discussion actor below the maximum depth, the block MUST permit further discussion subject to those checks. It MUST explicitly prohibit task delegation.

At the maximum depth, the block MUST state that neither task delegation nor further discussion is available.

The block MUST explain that a child created at the maximum depth cannot create another child. This lets the caller account for the child's restrictions when it assigns work.

**Offered tools and enforcement**

At the maximum depth, the runtime MUST omit `tool__Delegate` and `tool__Discuss` from the tools offered to the model.

In discussion mode, the runtime MUST omit `tool__Delegate` at every depth.

Remaining depth alone MUST NOT cause the runtime to offer a child-interaction tool. The applicable target, mode, and permission checks MUST also permit its exposure.

This filtering MUST NOT remove unrelated eligible tools or discard retained agent definitions.

Dispatch MUST independently enforce depth, mode, target, permission, budget, and workspace-gate checks. Prompt text and tool exposure MUST NOT replace those checks.

Compatible continuation MUST reconstruct the depth-awareness block from the same retained records. It MUST NOT use changed deployment defaults or infer depth from conversation text.

Prompt assembly and the applicable execution-definition digests MUST cover the depth-awareness block.

**Illustrative prompt content**

Task actor at depth 1:

```text
Interaction mode: task
Current depth: 1
Maximum depth: 2
Remaining child levels: 1

A delegation or discussion creates a child at depth 2.
That child cannot create another child.
Use only the permitted targets offered by your tools.
Other permission, budget, and workspace checks still apply.
```

Discussion actor at depth 1:

```text
Interaction mode: discussion
Current depth: 1
Maximum depth: 2
Remaining child levels: 1

You may start another permitted discussion at depth 2.
You cannot delegate a task.
The child discussion cannot create another child.
Other permission, budget, and workspace checks still apply.
```

At depth 2, either actor instead receives this part:

```text
Remaining child levels: 0

You cannot delegate a task or start another discussion.
Use your remaining permitted tools.
If you cannot complete the work, explain the limitation.
```

The examples illustrate the required information; they do not introduce new permissions.

A discussion actor MUST be allowed to make a further discussion when depth, budget, access, and workspace admission permit it. It MUST NOT delegate a task. Every discussion descendant MUST remain in discussion mode.

Selecting a configured agent for a new session MAY use any retained configuration, including one already present in the call chain. Selecting an existing session MUST obey its same-run ownership and active-execution state. An occupied session or waiting ancestor MUST be refused, regardless of its selected agent. Returning an answer completes an existing call and is not a reverse consultation. Each new nested execution increases depth and uses the shared budget.

**Rationale and alternatives:** One depth setting is simpler than independent counters for mixed paths. A depth limit does not replace a work budget. Separate discussion limits could permit consultation from the deepest task delegate, but add another configuration contract. That alternative is deferred, not silently enabled.

### 20. Discussions use the run budget and release active-effect accounting while suspended

**Review status:** Approved as written.

A discussion MUST use the existing run, provider binding, invocation ownership, and model-step admission rules. It MUST NOT receive a separate model-step allocation. Every new child model request MUST consume a step from the same run budget. The deployment model-request ceiling MUST continue to apply.

Creation of the discussion actor, startup instruction supply, and result bookkeeping MUST NOT consume model steps. The caller's request that selected the tool already consumed its normal step. Each subsequent model request consumes its own normal step.

Session creation or reuse MUST NOT create a new run budget. Every turn MUST charge its owning run under Decision 21. A completed turn can release its session for a later call, but MUST NOT refund consumed work.

This change MUST NOT introduce a total discussion-call or tool-call budget. The current execution code has durable model-step accounting, but no general durable tool-call counter. Tool argument validation, time limits, process limits, and intentional paging MUST remain effective. Message and common result sizes MUST follow the Message-size and monitoring policy. A refused call does not refund the model request that produced it. Replaying a completed operation MUST NOT dispatch or charge new model work.

The runtime MUST run nested consultations sequentially within the caller chain. A discussion MUST NOT start background work or fan out several child invocations from one response. This does not serialize otherwise independent runs that share a workspace.

**Workspace holds**

Every new discussion start, child model request, and child tool call MUST pass the workspace gate from Decision 13. No parent wait may hold that gate while a child runs.

The gate's drain set MUST contain active leaf effects, such as admitted model requests and tool executions. A pending discussion or delegation wrapper MUST NOT count as a leaf effect merely because its promise has not resolved. A child waiting for critical approval or an owner answer is suspended, not an active external effect.

A suspended execution keeps its session active. Exclusion from the active-effect drain set MUST NOT make that session an available target. Session execution metadata and workspace drain accounting MUST remain separate.

A workspace hold MUST suspend new dispatch rather than manufacture a discussion refusal. The runtime MUST preserve the pending operation identity and input through its durable pause path. It MUST NOT publish a fake owner question or consume model steps while waiting for the gate.

When a child requests a critical read, the runtime MUST record that request and close ordinary workspace admission. Its parent chain MUST remain suspended. The runtime MUST let already-started leaf effects settle without waiting for the suspended parent wrappers to finish.

The individually approved leaf operation MAY execute under Decision 13. Its result MAY be recorded while the hold remains closed. Neither the child nor an ancestor MUST dispatch its next model request until ordinary admission reopens.

Cancellation tracking MUST still include child work and durable completion writes. Separating drain accounting MUST NOT let a run finish while its actual work continues. Run cancellation or terminal failure MUST prevent further child dispatch and preserve the existing uncertain-effect rules.

An approval hold MUST preserve the logical parent-child wait. It MUST NOT fabricate a timeout result to escape the hold or reset the run budget. Existing deadlines on an already-started leaf operation remain effective.

**Rationale and alternatives:** Counting suspended parent tools as active effects would deadlock a critical request made by their child. Separate drain accounting solves that problem without a new scheduler or another resource quota.

**Code basis:** `packages/runtime/src/execution/admission.ts:14-64` provides run-wide model admission. `packages/runtime/src/execution/delegation.ts:253-260` tracks the whole child promise. `packages/runtime/src/execution/in-flight.ts:20-27` waits for every tracked promise, so it cannot serve unchanged as the workspace drain set.

### 21. Discussions create or reuse sessions through exclusive turns

**Review status:** Approved with the reusable-session model and the same-run ownership resolution. Decision 22 is approved as an outline. Closed session-specific contracts still need completion and review before implementation.

**Identity**

An agent configuration defines instructions, facet selections, and execution policy. A session identifies one durable conversation with an owner-selected configuration from its run's retained set. Selection is metadata, not session identity.

Multiple sessions MAY use the same configured agent. Bill 1 and Bill 2 are different sessions, even when both use Bill's configuration.

A turn is one execution episode within a session. Session identity MUST remain separate from the turn's caller, operation, run, depth, mode, and execution state.

Completion of a turn MUST NOT delete the session or its conversation. A later permitted consultation MAY start another turn in that session.

**Session ownership and lifetime**

Each session MUST belong to exactly one creating run. Its owning run identity MUST be immutable.

An agent MUST discover or address only sessions owned by its current run. Sharing a workspace MUST NOT grant access to another run's sessions.

Every new run MUST start with fresh agent sessions. It MUST NOT target, resume, or automatically import sessions from earlier runs.

Within a run, permitted callers MAY reuse an idle session. All turns MUST use that run's budget, workspace, retained definitions, and applicable execution controls.

When a run becomes terminal, its sessions MUST stop accepting new turns. This MUST NOT imply that uncertain external effects have stopped.

Ending a run MUST NOT itself delete its retained session history. History retention and session addressability MUST remain separate.

Authorized owner inspection MAY examine retained history. That inspection MUST NOT make an old session available as an agent invocation target.

Future memory extraction, learning, or dreaming workflows MAY use retained history only under a separately approved design. This change MUST NOT implement those workflows or grant agents cross-run history access.

Retained history MUST NOT be automatically added to a new run's model context or agent-visible session catalog.

**History and model context**

A session MUST retain its conversation and the provenance of its turns. Its stored history MUST remain distinct from the context supplied to a model request.

This decision MUST NOT introduce automatic compaction. A future compaction feature MUST preserve session identity and distinguish retained history from the compacted model context.

A new session MUST start with its retained agent instructions, permitted tools, startup skills, runtime instructions, and explicit topic.

A reused session MUST retain its own prior conversation. It MUST NOT automatically receive the caller's conversation, hidden reasoning, or other sessions' histories.

Reuse MUST NOT replace retained definitions with current deployment definitions. The owner MAY select another retained configuration under Decision 22. Prepared steps MUST preserve their captured agent and tools, while subsequent preparation uses the latest committed selection. Incompatible retained context MUST cause an explicit refusal rather than silent substitution.

**Discussion targets**

A discussion MUST explicitly select either a new session from a retained agent configuration or an existing accessible session.

A new session MAY use the caller's own configured agent. Equality of configured agent IDs MUST NOT cause refusal.

An existing-session target MUST identify that exact session. The runtime MUST NOT silently substitute a fresh session or another session of the same agent.

A task-delegation relationship or entry-policy membership MUST NOT be necessary for discussion. Applicable access restrictions MUST still apply.

Cross-workspace session discovery and communication MUST remain prohibited.

The runtime MUST let an agent discover accessible session identities, their selected agents, and whether they are occupied. Discovery MUST query existing sessions of the current run, not a separate registry. Discovery MUST NOT automatically expose full conversations or hidden reasoning.

**One active turn per session**

A session MUST have at most one active turn. A turn that waits for a child remains active and keeps its session occupied.

Starting execution in an existing session MUST atomically change its execution metadata from idle to active under the existing owner fence. Active metadata MUST identify the existing execution and owner epoch. Concurrent requests MUST NOT start competing executions. No separate claim table or lease service is permitted.

A request targeting an occupied session MUST return an explicit busy refusal. This version MUST NOT queue, interrupt, or steer that session.

A session in the caller's active waiting chain MUST NOT become a nested target. This rule applies to every waiting ancestor, not only the immediate caller.

Returning an answer MUST complete the existing consultation. It MUST NOT create a reverse call or a new turn in the caller.

After durable completion releases the target session, another permitted caller MAY consult it again.

**Depth, mode, and authority**

Each consultation turn MUST derive its depth from the current caller's depth plus one. The depth used when a session was created MUST NOT become its permanent depth.

Every model request within that turn MUST use its current depth-awareness block under Decision 19. A later turn MAY have a different depth and block.

Discussion turns MUST remain read-only. Earlier task-mode activity in the same session MUST NOT grant task authority to a discussion turn.

Session reuse MUST NOT reset the caller's run budget or grant additional authority. Current grants, workspace gates, and continuation checks MUST remain effective.

Retained skill state MUST remain attributable to its session and originating turn. Each model response MUST freeze the membership eligible for that turn's reference reads.

Prior conversation or loaded membership MUST NOT bypass current mode, permission, or resource restrictions.

**Results and replay**

Each consultation MUST have its own operation identity and result. Its result MUST identify both the target session and the consultation.

Replaying a completed operation MUST return its recorded result. It MUST NOT append the topic again, create another turn, or repeat model work.

A new topic MUST use a new operation. It MAY target the same idle session.

The runtime MUST preserve existing cancellation, storage uncertainty, and external-effect rules. It MUST NOT mark a session idle while its turn has unsettled work.

**Retained definitions**

The runtime MUST retain configured definitions needed to create permitted discussion sessions, including the caller's own configuration.

It MUST retain each configured definition once rather than duplicate it for every possible call path.

A configuration without installed facet data MUST NOT require an installation read merely to retain its agent definitions.

Session reuse and definition retention MUST follow the Message-size and monitoring policy. They MUST NOT introduce an aggregate snapshot ceiling.

The same-run scope question is resolved by the ownership contract above. Session-related record, admission, and replay contracts remain incomplete until their closed shapes receive review.

**Explicitly deferred**

Background consultations, queued calls to occupied sessions, active-session steering, and automatic compaction remain outside this revision.

These features need separate design and approval. Reusable foreground sessions MUST NOT implicitly enable them. An owner agent-selection change under Decision 22 is a setting change, not queued input or active-session message steering.

### 22. Session state controls execution and owner-selected agents

**Review status:** Approved with session-state simplification, owner-only agent switching at the next model request, and uniform configuration retention. The switching permission and timing questions are resolved. The partial reconciliation defines the session catalog and owner selection route. Conversation, checkpoint, and owner-inspection details still need completion and review before implementation.

**Execution state belongs to the session**

A session MUST contain its owning run, selected agent configuration, ordered conversation, and current execution state.

Execution state MUST distinguish idle from active. Active state MUST identify the current execution and the existing runtime ownership epoch.

Whether an active execution is running or waiting MUST come from its execution records. Waiting for a child, approval, or owner answer MUST NOT make the session idle.

Starting work MUST atomically change an idle session to active under the existing ownership fence. Concurrent requests MUST NOT start competing executions.

Completion MUST return the session to idle only after its result is durable and its work is settled. Uncertain completion MUST NOT make the session available.

The runtime MUST use session state and existing operation records for these checks. This change MUST NOT introduce a separate claim table, lease service, or second operation ledger.

**Only the owner can select another agent**

Only the owner MAY change a session's selected agent configuration. Agent tools, discussion messages, and delegated instructions MUST NOT authorize that change.

The owner MUST select from the agent configurations retained by the session's run. A selection MUST NOT fetch current deployment definitions or create an unretained configuration.

The change MUST preserve session identity, owning run, conversation history, workspace, provider binding, execution mode, depth, and consumed budget.

In particular, selecting another agent MUST NOT turn a read-only discussion into task execution.

Owner selection changes MUST remain inspectable. They MUST use the existing idempotent mutation pattern. Replaying an earlier selection request MUST NOT overwrite a later selection.

**Apply selection at model-step preparation**

The owner MAY request an agent change while the session is active.

At model-step preparation, the runtime MUST capture the latest committed agent selection. It MUST use that retained configuration to assemble the request's instructions and offered tools.

A step already prepared MUST retain its captured agent configuration. Its model request and resulting tool calls MUST NOT acquire a different agent's permissions midway through execution.

A selection committed after that capture MUST affect the following model request. If several changes commit before capture, the latest committed selection MUST apply.

Current owner revocations MUST continue to constrain dispatch.

The switch MUST NOT interrupt current work, create a concurrent execution, or enqueue a new user message.

The console MUST distinguish the selected agent for future preparation from the agent used by an already-prepared step.

**Instruction history is not current authority**

The runtime MUST distinguish previously supplied instructions from currently available skills and permitted operations.

Effective capabilities MUST come from the selected retained configuration, current interaction mode, applicable restrictions, and current grants.

Earlier instruction content MUST remain part of session history. It MUST NOT grant access to tools or resources unavailable under the current execution context.

At the next preparation boundary, the runtime MUST reconcile the selected agent's instructions, skill catalog, startup requirements, and tool exposure.

Selecting an agent MUST NOT load every skill in its facets. Only its configured startup skills receive automatic supply.

Required instruction supply MUST avoid duplicate body insertion and retain its originating execution and agent-selection provenance. It MUST NOT require synthetic tool calls.

Each model request MUST record the agent configuration and tool definitions used for that step. Authorized selection changes MUST NOT rewrite earlier bindings or digests.

**Conversation storage remains separate from checkpoints**

Session messages MUST have stable identities and a sequence unique within the session. Each message MUST retain its source execution or operation where applicable.

The runtime MUST reuse its validated message and tool-result representations, including provider metadata needed for continuation.

A new execution MUST identify the session conversation state from which it starts. Operation replay MUST NOT append the same input or output again.

Session history MUST describe the durable conversation. LangGraph checkpoints MUST describe how to resume a particular execution.

A later consultation MUST start a new execution using the session's retained conversation. Resuming interrupted work MUST use that execution's existing checkpoint and captured step context.

An owner agent-selection change MUST NOT invalidate continuation solely because the selected agent changed. Already-prepared work MUST preserve its original binding; subsequent preparation MUST use the current selection.

Existing ownership, operation replay, and uncertain-effect protections MUST remain effective. This change MUST NOT adopt recovery that automatically repeats uncertain external operations.

Automatic compaction remains deferred.

**Session catalog**

Each prepared request that offers `tool__Discuss` MUST contain a runtime-supplied session catalog with this shape:

```text
{
  sessions: {
    sessionId: UUID,
    agentId: AgentId,
    busy: boolean
  }[]
}
```

`agentId` MUST identify the session's selected agent at capture time. Entries MUST be ordered by session ID.

The catalog MUST contain only sessions owned by the caller's run that pass applicable access restrictions. It MUST contain no transcripts or hidden reasoning.

The runtime MUST query existing session records, not a separate registry. The current run MUST come from trusted execution context, not model input.

The catalog MUST be captured from a consistent store view during preparation. Its exact contents MUST be retained with that prepared request.

Catalog data MUST NOT change the immutable execution-definition digest. The catalog template and assembly behavior MUST remain covered by execution-code identity.

A request that does not offer `tool__Discuss` MUST NOT need this catalog.

The catalog MUST NOT impose a new fixed session-count or message-size ceiling. Applicable provider and storage failures MUST follow the Message-size and monitoring policy.

`busy: false` is an observation, not execution permission. Invocation MUST repeat ownership, access, mode, depth, budget, and occupancy checks.

This change MUST NOT add another model-facing discovery tool.

**Use one configuration-retention mechanism**

Every accepted run MUST retain its configured agents through the existing capability snapshot and run binding.

A run without selected facets MUST use `installation: { kind: "none" }`, with empty installed-definition collections.

Such a run MUST NOT require an installation read or MCP discovery.

Sessions MUST reference retained configurations consistently, regardless of whether their tools are native or facet-provided.

This change MUST NOT introduce a separate native-only configuration record.

**Required contract completion**

Decisions 21 and 22 define the approved behavior, but the record sketches below are not a complete implementation contract. The following detailed shapes and interfaces still need completion and review:

- Durable session conversation records, message identities, and the context state bound to each turn.
- Session and execution checkpoint bindings, including captured model-step context and instruction-supply provenance.
- Owner session inspection interfaces with closed input and output shapes. The model-facing catalog and owner selection route are defined in Decisions 22 and 15.

These gaps MUST NOT be filled by silently reusing the former fresh-only actor contract. Session execution metadata and existing operations replace separate claim machinery. Uniform capability snapshots and bindings resolve the native-only retention choice. Same-run ownership remains immutable. Owner-only switching and next-request timing are resolved above.

The discussion identity MUST be the actor-scoped digest of the issuing operation. For a discussion operation, the formula uses the domain tag `tool-operation`, not a format version:

```text
discussionId = sha256("tool-operation\n" + runId + "\n" + parentActorKey
                     + "\n" + modelMessageId + "\n" + providerToolCallId)
actorKey = discussionId
```

The runtime MUST use the actual parent actor key, not the literal `root`. Tool name, argument digest, and immutable binding MUST participate in replay conflict checks. Reusing an operation identity with changed input MUST fail rather than create another actor.

The model-facing input MAY select an existing session ID under Decision 18. It MUST NOT contain an actor key, checkpoint namespace, workspace, mode, provider, or budget override. Those values come from runtime records.

**Constraints on contract completion**

Every actor MUST reference a session, including entry and task actors. The session creation identity MUST distinguish run entry creation from creation by a parent operation.

Session, actor, and conversation references MUST enforce same-run ownership through their keys and foreign keys.

Conversation records MUST contain incremental messages, not copies of complete prepared model requests. Appending a full request would duplicate earlier conversation during reuse.

Prepared request capture MUST remain separate from conversation messages. It MUST preserve the exact prompt, conversation state, offered tools, selected agent, and dynamic catalog used by that request.

A digest is insufficient unless the corresponding immutable content can be recovered.

Existing first-message identities, including `discussion-<discussionId>`, MUST remain consistent with source-based deduplication. Repeated source identity with different content MUST fail verification.

Message positions and selection sequences MUST use validated counters with explicit overflow refusal. They MUST NOT become policy limits on conversation length or selection count.

Returning a session to idle MUST match its active execution and ownership epoch. A stale executor MUST NOT release another execution's session.

Instruction-supply history MUST use session identity for every actor kind. It MUST retain originating execution and selection provenance without becoming current authority.

The completed contract MUST define failed-turn reuse and provider-valid message history. It MUST NOT fabricate missing tool results, silently discard messages, or repeat uncertain effects.

The following partial record sketch separates session identity, mutable owner selection, and operation-bound execution. Conversation and checkpoint details remain subject to the review above:

```text
SessionIdentity = { runId, sessionId, workspaceId }
SessionState = {
  identity: SessionIdentity,
  selectedAgentId,
  execution: { kind: "idle" }
           | { kind: "active", actorKey, ownerEpoch }
}
DiscussionTarget = { kind: "new", agentId }
                 | { kind: "session", sessionId }
DiscussionActorRef = { kind: "discussion", discussionId, sessionId, agentId }
DiscussionToolBinding = { kind: "discussion", target: DiscussionTarget }
DiscussionRecord = {
  runId, discussionId, sessionId, parentActorKey, initialAgentId,
  requestedTarget: DiscussionTarget,
  initialDefinitionDigest, snapshotDigest, argumentDigest,
  mode: "discussion", depth,
  checkpointNs,
  state: { kind: "active" }
       | { kind: "result", text }
       | { kind: "failed", reason, message }
}
```

The turn's unique key MUST be `(runId, discussionId)`. Its session MUST belong to that same run. The turn MUST reference its parent operation and parent turn in the same run. Its workspace MUST come from that run. Mode, target session, parent, depth, input identity, initial definition identity, and checkpoint namespace MUST be immutable for that turn.

Every prepared model step MUST retain its own selected agent, definition identity, prompt, and offered tool definitions. A later owner selection MUST NOT change that prepared step's binding. Historical result provenance MUST identify the recorded execution context rather than the session's current selection.

The session identity MUST remain separate from those turn bindings. A later topic can create a new turn in the same session but MUST NOT alter an earlier turn's bindings or result. Lookup and admission MUST reject another run's session without revealing its conversation. Run termination MUST prevent new turns without implying that uncertain effects stopped.

`checkpointNs` MUST preserve the framework-supplied namespace exactly. It MUST NOT be generated from the configured agent name. The first input message MUST have the stable ID `discussion-<discussionId>`.

**Atomic boundaries**

Before child execution, one atomic operation MUST change the idle session to active, persist the new execution and its bindings, and record `discussion.started`. A new-session target MUST also create the session and initial instruction-supply state in that operation. An existing-session target MUST preserve its own conversation and instruction history without duplicate supply. The mode MUST already be restrictive.

The start event MUST use Decision 14's new-session or reused-session startup representation. The existing parent tool operation can be started earlier; both insertions need not share one transaction. A replay MUST reuse the recorded target session and turn, not append the topic again or create a replacement session.

A representable refusal before turn creation MUST atomically complete the parent operation and record a safe refusal event. It MUST NOT create an executable turn, append a topic, or create startup membership. Busy targets, waiting ancestors, and inaccessible sessions MUST follow this refusal path. Input that cannot form an operation binding MUST use the existing invalid-call refusal path.

Turn completion MUST atomically persist its conversation changes, terminal result, end event, and parent tool outcome. It MUST change session execution state to idle only when that turn has no unsettled work. The caller MUST NOT observe an unconfirmed result. A commit whose result cannot be verified MUST keep existing uncertain-storage behavior and MUST NOT make the session available prematurely.

Run termination MUST settle active discussion records through the existing run-finalization contract, with a safe failure reason rather than invented advice. The caller MUST NOT resume from cancellation or budget exhaustion as though it received a successful result. A verification failure MUST NOT be reported as confirmed settlement.

The history event names and source keys MUST be:

| Event | Source key |
|---|---|
| `discussion.started` | `discussion:<discussionId>:started` |
| `discussion.completed` | `discussion:<discussionId>:completed` |
| `discussion.refused` | `discussion:<discussionId>:refused` |

Start payloads MUST identify the discussion turn, target session, configured agent, parent turn, depth, requested target kind, and new-activation startup list. Completion payloads MUST identify the same turn and session with its `result` or `failed` outcome. Refusal payloads MUST identify the caller, safe target reference, and reason. A startup refusal MUST also identify affected skills safely. Full advice belongs in the recorded tool outcome, not duplicated in lifecycle payloads.

The start event MUST precede the turn's first model request. A source key repeated with equal content MUST be idempotent. A conflicting payload, including a changed session or startup list, MUST fail verification. Skill membership MUST identify its session and originating turn without a separate startup event key. Its complete closed storage shape remains subject to review.

**Replay and continuation**

A completed operation MUST return its exact recorded outcome without a new turn, topic append, current catalog lookup, model dispatch, or step consumption. An active discussion MUST re-enter the same execution, active-session state, and checkpoint namespace, never a replacement turn. A new operation against an idle session MUST remain distinct from that replay.

Before work resumes, verification MUST check the full suspended ancestor chain. It MUST verify parent operations, session ownership and active-execution metadata, turn modes, depths, retained definitions, captured step context, and checkpoint identities. Waiting ancestor sessions MUST remain occupied. The workspace gate and current independent grants MUST still constrain new dispatch. The verifier MUST NOT invoke the graph as a test.

The execution-definition digest MUST cover the execution code, tool schema, prompt behavior, depth semantics, and retained discussion targets. Records MUST NOT acquire invented discussion history.

The current database schema MUST contain run-owned sessions with execution metadata, existing execution and operation records, and their history. It MUST NOT add a separate claim table or contain the root-only parent assumption for child records. A discussion turn MUST NOT have a task-delegation child. Remaining detailed shapes and constraints need completion before implementation.

Public projections MUST show session identity, discussion turn identity, configured agent, parent turn, mode, depth, and safe outcome separately from task delegation. They MUST NOT expose internal checkpoint state or claim that advice performed an external action. Retained owner history MUST remain inspectable without exposing old sessions as targets to another run.

**Rationale and alternatives:** Session execution metadata and existing operations enforce exclusive execution without another claim system. Selected agent configuration is separate from session identity. Captured model-step bindings permit owner changes without changing in-flight work. Ordered session history preserves conversation, while LangGraph checkpoints preserve execution recovery. Uniform run bindings remove a native-only retention special case.

**Code basis:** `packages/runtime/src/records/run-store.ts:457-500` checks replay identity. Lines 663-802 provide child-start and atomic-completion patterns. `packages/runtime/src/persistence/migrations/004-capability-records.ts:16-56` contains the existing root-only actor constraints. `packages/runtime/src/execution/saved-state.ts:294-354` handles only one child level and needs generalization.

**Architectural reference:** OpenCode V2.2.6 stores execution metadata on its [session row](https://github.com/anomalyco/opencode/blob/dc2ffcf8bf26f9e669b6aa22b95f50e12be15e06/packages/core/src/session/sql.ts#L66-L82). Its [context preparation](https://github.com/anomalyco/opencode/blob/dc2ffcf8bf26f9e669b6aa22b95f50e12be15e06/packages/core/src/session/context.ts#L126-L165) selects the current agent and tools. Its [restart contract](https://github.com/anomalyco/opencode/blob/dc2ffcf8bf26f9e669b6aa22b95f50e12be15e06/packages/core/src/session/execution/restart.ts#L47-L62) permits repeated external effects after a crash. This design borrows the session-state distinction, not that recovery guarantee or OpenCode's process-local concurrency assumptions.

## Message-size and monitoring policy

**Review status:** Approved with Decision 18. This policy includes the listed corrections to earlier decisions. It does not approve Decisions 19 through 22.

### Ordinary message content

The runtime MUST NOT impose an independent size ceiling on ordinary user or agent message content.

This rule MUST cover user goals, command arguments, rendered goals, owner-question prompts, text answers, delegated tasks, discussion topics, and returned advice.

A question MAY specify a deliberate answer-length constraint as part of its requested response format. A hidden universal byte ceiling MUST NOT supplement that constraint.

Text MUST remain valid for its encoding and storage representation. Required nonblank checks, strict input shapes, credential screening, and permission checks MUST remain effective.

The runtime MUST NOT silently truncate, summarize, or omit content to make a request fit. This policy does not introduce automatic conversation compression.

### Application limits to remove

Implementation MUST remove the following application-imposed ceilings from the affected message paths. Contract validators, record decoders, SQL checks, and error messages MUST agree.

| Existing ceiling | Proposed treatment |
|---|---|
| 8-KiB goals, command arguments, rendered goals, delegated tasks, and discussion topics | Remove. |
| Universal 8-KiB text-answer ceiling and the matching ceiling on permitted answer-length declarations | Remove. Preserve a question's deliberately specified answer constraint. |
| 16-KiB question prompts and 64-KiB aggregate question-text ceiling | Remove. |
| 64-KiB HTTP bodies on routes that receive ordinary messages | Remove for those routes. Do not change unrelated authentication or administration routes merely because they share a parser. |
| Anthropic adapter's 10-MiB inference-request ceiling | Remove. Do not replace it with a guessed provider maximum. |
| 1-MiB complete model-message ceiling | Remove as a message-admission policy. |
| 64-KiB complete tool-result ceiling and the related 69,000-byte database-representation ceiling | Remove from the common result path. |
| 16-MiB canonical snapshot ceiling and the related 32-MiB SQL check | Remove, so retained command content does not encounter a hidden replacement limit. |

Intentional paging for filesystem reads, searches, and bundled references MAY remain. Paging MUST NOT become an undisclosed size ceiling on ordinary messages or returned advice.

Runtime and deployment defaults MUST NOT silently recreate the removed limits. Implementation MUST identify remaining platform-enforced limits and report them accurately.

This change MUST retain separate facet-content validation, startup-skill limits, identifier rules, approval-artifact limits, execution budgets, deadlines, and sandbox resource controls. Those controls are outside this message-size revision.

### Provider ownership of request capacity

Subscription adapters MUST provide authentication, endpoint checks, and faithful request adaptation. They MUST NOT invent an independent inference-payload size policy.

The provider MUST remain authoritative for its accepted request size and model context capacity. A local estimate MUST NOT reject input as excessive context without a verified provider contract.

Any future local context check MUST examine the complete adapted request, not only one message. It MUST account for instructions, history, tool definitions, and applicable output allowance.

The runtime MUST NOT automatically resend an unchanged request after a confirmed size or context rejection.

### Failure reporting

Where reliable evidence exists, the runtime MUST distinguish request-size rejection, context-capacity rejection, and other invalid requests.

Unknown responses MUST remain unclassified provider failures. An HTTP status alone MUST NOT establish a context-capacity failure.

Error handling MUST support empty bodies, non-JSON bodies, connection failures, and unknown error codes. It MUST NOT expose credentials, message contents, or arbitrary raw provider error bodies.

Local serialization or storage failure MUST NOT be reported as provider rejection. A capacity failure MUST NOT be reported as an internal invariant violation merely because the request was large.

Failure reporting MUST preserve whether acceptance or dispatch occurred. Existing uncertainty and replay rules MUST remain effective.

The console MUST show a safe explanation of the rejecting boundary when known. The runtime MUST preserve accepted input and MUST NOT invent a successful result.

### Required monitoring

Monitoring MUST be operational before the removed limits cease enforcement.

| Boundary | Required measurements |
|---|---|
| Message handling | Content byte sizes by message type; failures by stage and reason |
| Provider requests | Complete adapted request bytes, latency, status, normalized failure reason, and provider-reported token usage |
| Returned data | Complete model-message and tool-result sizes |
| Persistence | Serialized record and checkpoint sizes, write duration, and failures |
| Host process | Memory use, concurrent work, restarts, and out-of-memory terminations |

Missing provider token usage MUST remain unknown, not zero.

Telemetry MUST NOT duplicate message bodies, credentials, or raw provider error bodies. Metric labels MUST NOT contain message content or per-run identifiers.

The owner MUST be able to inspect size distributions and correlate failures with their execution stage. Host-level monitoring MUST remain available when the runtime process terminates.

The implementation plan MUST identify the telemetry destination, host-monitoring source, and verification method. Monitoring MUST NOT depend only on the process successfully flushing data before termination.

Measurements SHOULD use serialized bytes already available at the relevant boundary, rather than create additional complete copies solely for monitoring.

Instrument registration alone MUST NOT be reported as proof that monitoring is operational.

Deployment verification MUST establish successful collection, durable storage, owner inspection, and host evidence after runtime termination.

A loopback listener MUST have an explicitly reachable collector topology. A collector in another container MUST NOT be assumed to share that loopback interface.

Host OOM and restart evidence MUST be verified for the selected platform and collector. A metric name alone is not that verification.

This reconciliation does not select Prometheus, cAdvisor, or node-exporter as deployment dependencies. The monitoring destination remains an explicit implementation-plan prerequisite.

### Later limits and accepted risk

A later application size limit MUST have a documented constraint or measured operational reason. Its proposal MUST identify the protected resource, measurement unit, enforcement boundary, and user-visible failure.

The owner MUST approve that policy separately. Monitoring MUST NOT automatically introduce new limits.

Until then, the application accepts the risk of resource exhaustion before a provider can reject a request. Monitoring does not guarantee a recoverable failure or unlimited capacity.

## Risks and Trade-offs

- **Risk:** Large messages can exhaust resources before a provider rejects them. **Accepted approach:** Make monitoring operational first. Preserve host evidence after process termination. Add later application limits only with a documented constraint or measured reason and separate owner approval. Do not promise recoverability or unlimited capacity.
- **Risk:** Facet-level selection gives access to more contributions than a single-item allowlist did. **Mitigation:** Migration MUST list the additional contributions. It MUST use installation materialization choices or a narrower selection where necessary. It MUST NOT call the expansion equivalent.
- **Risk:** Independent configuration can repeat the same selections across agents. **Mitigation:** Show each agent's configuration explicitly. Do not add implicit inheritance to reduce repetition. Enforce startup bounds for each actor without truncation.
- **Risk:** A depth limit does not bound repeated work. **Mitigation:** All actors consume the existing run-wide model-step budget. Delegation and return MUST NOT reset it. This change does not introduce parallel execution. Decision 1 defines the depth default and numeric validation without a separate delegation-call limit.
- **Risk:** Optional discovery adds startup latency, and it keeps an outage in one run. **Mitigation:** Bound the concurrency and the time, and keep the reasons. Make a new run necessary for definitions that become available. Do not silently bind replacements after acceptance.
- **Risk:** Startup records cannot prove provider delivery or compliance. **Mitigation:** Commit prepared supply with actor creation. Do a check of the prompt before dispatch. Keep the usual model-attempt evidence as a different record.
- **Risk:** Caller restrictions and per-agent selection can become confused. **Mitigation:** Keep facet selection separate from the classification records in Decisions 6 and 7 and independent owner grants. Test nested delegation without authority expansion.
- **Risk:** Discussion can be mistaken for task assignment or relayed to a privileged actor. **Mitigation:** Enforce discussion mode before dispatch and through further consultations. Prohibit delegation and mutating tools without conductor exceptions.
- **Risk:** A tool description overrides the intended policy. **Mitigation:** Require explicit runtime or owner-controlled effect and critical declarations. Reject missing policy rather than assuming non-critical status.
- **Risk:** A Docker filesystem boundary does not constrain remote effects. **Mitigation:** Keep remote-tool permission and critical-operation checks in the trusted runtime. Do not inject credentials or unrestricted remote access into task containers.
- **Risk:** A shared workspace permits conflicting edits. **Mitigation:** State that agents coordinate their files and that no general locking or merge system is provided. Bind critical approvals to frozen content rather than a mutable path.
- **Risk:** One run tears down infrastructure used by another. **Mitigation:** Keep persistent workspace ownership separate from run completion. Prevent competing creation and teardown beneath active work without adding filesystem recovery or attachment lifecycle records.
- **Risk:** New work bypasses an approval while existing calls drain. **Mitigation:** Close workspace-wide admission first. Track already-started work, allow it to settle, and prohibit follow-on dispatch until the gate permits it.
- **Risk:** One approval resumes unrelated critical work. **Mitigation:** Bind each request to one operation and workspace. Execute approved critical operations one at a time and keep the gate closed while other requests or executions remain outstanding.
- **Risk:** File persistence is mistaken for process persistence. **Mitigation:** Keep persistent workspace storage separate from replaceable containers. Report interrupted work rather than promise background-process restoration.
- **Risk:** Generic or stale approval authorizes a different critical operation. **Mitigation:** Bind approval to the operation, target, and exact arguments or change. Require new approval when they change.
- **Risk:** Discussion reaches configurations outside the task-delegation graph. **Mitigation:** Decision 21 retains the configured catalog and limits session discovery to the current run. Task-only reachability is insufficient. Other-run and cross-workspace session lookup remain prohibited.
- **Risk:** A session accepts competing executions or a nested call back to a waiting ancestor. **Mitigation:** Use atomic session-state updates under the existing owner fence. Treat waiting sessions as active and refuse busy targets without a queue. Preserve uncertainty rather than make unsettled work idle.
- **Risk:** The development reset removes old runs and their history. **Mitigation:** Apply the reset only to disposable development state. Identify its targets before deletion, and get separate owner approval. Keep workspace files, source repositories, owner configuration, credentials, and upstream facet sources.
- **Risk:** A later code change makes the execution definition of a current run that waits incompatible. **Mitigation:** Keep the exact execution-definition check. Rehearse the rejection and the continuation in the same build.
- **Risk:** Installed prompts stay untrusted content. **Mitigation:** Keep the content screening and the dispatch boundaries. Portable admission gives no authority, and it does not execute scripts.
- **Risk:** A bundle fault prevents the validation of startup references. **Mitigation:** Fail explicitly without changes to retained state. Restore a correct configuration and bundle before the runtime serves work. This change adds no degraded-readiness mode.
- **Risk:** Changes to the startup prompt change the continuation identity. **Mitigation:** Digest the assembled entry prompt, and keep agent bodies in the snapshot. This is intentional compatibility enforcement. It is not a reason to bypass the check.

## Migration Plan

1. **Prepare without changes to production.**
   - Complete and review the remaining conversation, checkpoint, and session-interface details in Decision 22 before implementation. Same-run ownership, owner-only switching, next-request timing, and uniform retention are resolved.
   - Identify the telemetry destination, independent host-monitoring source, and verification method before implementation.
   - Verify monitoring before removed message-size ceilings cease enforcement. Keep capacity experiments and deployment changes behind separate approval gates.
   - Finalize explicit tool policy, sandbox enforcement, critical approvals, and discussion-mode records without silently changing existing authored restrictions.
   - Finalize simple workspace references and atomic workspace-gate admission with existing operation records. Do not introduce filesystem snapshotting or a separate attachment lifecycle model.
   - Use the separately verified implementation milestones below. Do not treat a build milestone as approval to deploy incomplete controls.
   - Use disposable storage and installations to make sure that record validation, the reset scope, and deterministic behavior are correct.
   - Re-export with the updated adapter. Then reseal.
   - Do not edit exports manually. Do not change old rejections into ready definitions.
2. **Prepare the explicit operator migration.**
   - Replace old flat lists with reviewed independent agent configurations, startup IDs, and explicit delegation relationships.
   - Configure the separate permitted-entry set and its default, and a finite delegation depth under the resolved contracts.
   - Remove `capabilities.maxDelegationsPerRun` explicitly. Document that new runs use depth and the run-wide model-step budget instead.
   - Keep server approvals, program approvals, tool digests, credentials, and argument restrictions. Change them only with separate owner approval.
   - Prepare owner-controlled pinned Docker images, persistent workspace storage, and the trusted provisioning path under separate deployment approval. Do not infer new mounts or credentials from repository lifecycle scripts.
   - Document discussion eligibility separately from task relationships. Register tools for owner inspection and classification using structured identities and reviewed definition digests.
   - Preserve server-discovery approvals, server and tool grants, and argument restrictions. Classification is not authorization for those operations.
   - Examine the additional contributions that materialization supplies.
   - Pin the new sealed digest.
   - Put the published voice facet in the independent runtime manifest and lockfile. Never use an editor copy.
   - Complete re-materialization, resealing, and removal of superseded configuration fields before you restart the upgraded runtime.
   - If you restart before you complete these tasks, startup validation MUST reject the configuration.
3. **Document the current-format boundary.**
   - New starts need a sealed installation in the current format and the new configuration.
   - The supplied default agent and entry policy preserve native operation without capability configuration. Document other configured-native cases after Decision 12 is finalized.
   - The runtime reads only records in the current format. The reset removes older runtime records.
   - Work that waits after the reset continues only when its original execution binding and checkpoint binding pass verification.
   - The runtime does not resume runs from before the reset.
   - Selection removal has an effect only on new runs. Independent revocation of a server or a tool constrains accepted work.
4. **Do the non-live verification, and give one report.**
   - Use unit, service, API, process, and facet-install coverage, and a minimal console smoke check.
   - Run the suites one at a time where the check pipeline needs this.
   - If a failure occurs, stop.
   - Before you ask for live approval, record the actual provenance of the published facet.
   - Also record the context evidence and the isolation evidence.
5. **Deploy only with separate approval.**
   - Identify the reset targets, and get separate owner approval for the reset.
   - Identify protected owner configuration and credentials, including any records in the same database as disposable state.
   - Stop runtime execution before the reset. Do not let an old executor continue against the new schema.
   - Do the explicit development reset, and create the current database schema.
   - Regenerate the runtime adapter exports and the sealed installation bundle from the configured facet sources.
   - Restart with validated configuration.
   - Get separate approval for a live smoke run and for production facet changes or grant changes. This design gives no authorization for them.
6. **Roll back as a coherent set.**
   - A configuration-only removal of capabilities MUST stop new facet-backed work. It MUST NOT delete history or restore revoked tools.
   - Do not point an older binary at a database schema that it cannot read.
   - A return to an older build can use a fresh development database and inputs that match that build.
   - No backup of disposable pre-reset execution records is needed for compatibility.
   - Any further reset or deployment change needs separate owner approval. Protected data MUST remain intact.
   - Do not discard data that the runtime accepted after the reset without explicit owner approval.

### Implementation milestones

Implementation MUST use separately verified milestones:

1. Current records and reset safety.
2. Portable admission, agent configuration, startup supply, and deterministic facet proof.
3. Tool naming and classification.
4. Workspace execution and approval controls.
5. Sessions, selection, and continuation.
6. Monitoring verification and removal of message-size enforcement.

These are build milestones, not permission to deploy incomplete security controls.

The deterministic `voice-to-text` installation and context proof MAY run early with test substitutes. Live proof MUST wait for the controls required by the deployed configuration.

### Documentation alignment

After review, document Contracts 12A through 12D, 13A through 13D, and 15A through 15D alongside the discussion design. In root `README.md`, update API starts, workspace choices, cursor behavior, revision conflicts, and held-run states. Explain the private owner boundary without claiming named-user authentication. Keep provider login browser-only.

Update `architecture/09-data-model-and-lifecycle.md` with the new logical keys, immutable policy revisions, atomic gate predicates, and owner outcome assertions. Its current Approval lifecycle describes interrupt-derived approval identity and potential re-asking. Replace that future contract with operation-bound critical requests and no automatic redispatch; retain historical spike findings as historical evidence only.

Document the Message-size and monitoring policy in `README.md`, `architecture/09-data-model-and-lifecycle.md`, and deployment guidance. Distinguish removed application ceilings from actual provider, transport, serialization, and storage failures. Describe accepted resource-exhaustion risk and monitoring that survives process termination. Document safe boundary errors without raw provider bodies or message contents. Later application limits need measured evidence or a documented constraint and separate owner approval.

Update deployment documentation under `deploy/runtime/` and the example configuration with owner-registered workspace IDs, storage paths, pinned images, resource limits, and policy references. Document trusted remote connectors separately from task-container confinement. Include the procedure to stop a stale executor before owner resolution, and state that an epoch change alone cannot stop remote effects. Existing files MUST NOT be deleted or restored as part of that procedure.

Use the existing console components for explicit Save, per-request decisions, unresolved-effect evidence, and workspace hold states. Add a reusable design-system pattern only if these states need one. Keep policy changes, runtime deployment, production facets/grants, and live traffic behind their separate approval gates.

After review, document Decisions 18 through 22 in root `README.md` and `architecture/09-data-model-and-lifecycle.md`. Distinguish agent configuration, run-owned session, execution turn, retained history, and model context. Explain new-session creation, exact idle-session reuse, busy refusal, current-turn depth, shared run budget, and operation replay.

Document fresh sessions for every new run and rejection of older sessions as agent targets, even within a shared workspace. Distinguish authorized owner history inspection from agent-visible discovery. Future memory extraction and dreaming need separate design and approval; retained history does not imply an indefinite-retention promise.

Explain that suspended wrappers remain occupied sessions but are not active leaf effects for approval drain. Update session and turn inspection with existing console design-system patterns. Do not add background consultations, active-session steering, automatic compaction, or a standalone chat interface.

Document owner-only agent selection at the next model-step preparation. Distinguish current selection, captured in-flight agent context, and historical instruction supply. Explain that switching does not change session identity, provider binding, mode, depth, or budget. Use existing console patterns to show selected-versus-prepared state and clear failures. Document uniform snapshots and bindings for facet-free goals without a separate native-only retention path.

Document workspace-level isolation and the initial Docker profile in root `README.md` and the deployment guide. Explain persistent current files, explicit Git save points, simple run-to-workspace references, and no automatic filesystem recovery or idle-stop. Distinguish these files from retained definitions and execution checkpoints. Explain workspace-wide drain and approval holds, individual decisions, uncertain outcomes, and independence of other workspaces. The data-model document MUST describe workspace-scoped requests and dispatch gates without an attachment lifecycle system. Preserve the console design system for workspace and approval surfaces.

The Tool classifications page MUST follow `DESIGN_SYSTEM.md` and `packages/ui/src/app/ui.tsx`. During implementation, add any required reusable configuration-page pattern to the design system. Check the page against the development deployment at desktop, phone, and short sizes in light and dark. Behavior coverage MUST remain in component, service, and API tests; browser coverage stays limited to smoke and layout checks. Owner instructions MUST explain explicit Save, stale definitions, and the distinction between classification and grants.

The repository has no files under `docs/`. The documentation that exists now conflicts with this design. The implementation scope MUST include these updates:

- Root `README.md`, section "Capability configuration": This section says that goals never use grants, and it shows flat lists. The section "Runtime facets" needs author opt-in. The sections "Authority boundaries" and "Agent execution" describe the command-centric boundary. Replace this text. Describe independent agents with facet-only capability selection, entry policy, owner tool grants, read/write and critical declarations, task relationships, depth, and budgets. Do not introduce per-agent server or contribution allowlists. Distinguish sandboxed tasks from read-only discussion and critical approval. Keep the no-conductor-exception rule. Also describe portable admission, startup activation, and discovery.
- Root `README.md`, sections "Persistence", "Browser console and API", and "Runtime facets in a deployment". Also the upgrade, rollback, and troubleshooting text. Explain the new record variants and projection variants, startup supply, and stale selection errors. Explain selection compared with revocation, and continuation of current runs. Replace the upgrade text with the explicit development reset, its targets, its separate approval, and the data that it keeps. The API table MUST NOT label each goal as `native`.
- `deploy/runtime/facets/README.md`: Replace the text about a mandatory runtime block and about rejection without metadata. Document the validation of actual settings and the unchanged semantics of other tools. Describe re-export and resealing from the configured facet sources after the reset, the startup limits, and the installation reads for all configured new runs. Update the statement about an empty installation only when the real installation is recorded.
- `deploy/runtime/config.capabilities.example.json`: Show independent agents, explicit task targets, entry policy, finite depth, and unchanged independent grants. Include a delegate-only agent. Show explicit tool effects, critical designations, sandbox constraints, and approval configuration without implying production approval. Show read-only discussion and startup configured independently for agents. Omit superseded fields.
- `architecture/09-data-model-and-lifecycle.md`: Update capability records and lifecycle sections. Include agent and invocation identity, mode, parent actors, task depth, goal bindings, startup membership, and atomic actor creation. Distinguish task delegation from discussion. Describe explicit tool policy, sandbox constraints, critical approvals, invalidation, replay, and uncertain execution under the resolved contracts. Describe one current record format without fields that select a format. Preserve ordinary facet and tool-use provenance and historical descriptions.
- `architecture/08-execution-security.md`: Document the sandbox workload, trusted runtime connectors, verified placement and mounts, critical approvals, and the separation of local confinement from remote permissions.
- `deploy/runtime/facets/facets.json` and `facets.lock`: Record the actual resolved version and integrity of the published proof installation. Make sure of the version during installation. Do not copy the version from a claim in a plan that nobody verified.
- Root `README.md`: Change the text "Delegation (command runs only)", "Skills (command runs only)", and "Goal runs have no delegation". Explain native compatibility and configured entry agents under the resolved contract. Explain when an unreadable configured bundle prevents startup validation.

Documentation MUST link to main specs or to active local documentation. It MUST never link to archived change paths. This change does not open the roadmap again, and it does not include memory work.
