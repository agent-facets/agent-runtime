# Design

## Context

See [proposal.md](proposal.md) for motivation and scope, and the reconciled [capabilities specification](specs/capabilities/spec.md) and [execution delta](specs/execution/spec.md) for behavior. The [main execution specification](../../specs/execution/spec.md) remains the baseline; phase-1 acceptance and its exceptions are not reopened.

The application already uses Bun 1.3.14, stock LangChain `createAgent` 1.5.14, LangGraph 1.4.13, PostgreSQL, guarded model dispatch, a durable tool-operation ledger, and REST/SSE. The relevant existing boundaries are:

- `packages/runtime/src/execution/agent.ts:286`: one stock agent with fixed instructions and tools.
- `packages/runtime/src/execution/definition.ts:35`: execution compatibility includes code, packages, graph, tools, prompt, and stored binding.
- `packages/runtime/src/records/schemas.ts:82`: persisted question bindings; `:196`: operation identities currently have no agent dimension.
- `packages/runtime/src/persistence/migrations/002-run-records.ts:366`: tool-call uniqueness is currently run-wide; `:408`: one pending question per run.
- `packages/contracts/src/commands.ts:15` and `packages/contracts/src/api.ts:64`: strict goal-only start and public run contracts.
- `packages/runtime/src/config/operator.ts:57`: strict, non-secret, startup-loaded operator configuration.

Two researched constraints shape the design. The public facet SDK supplies transformed primary text, not original primary-file bytes. Also, a tool-invoked child agent is not automatically discoverable through the root's subgraph enumeration. Decisions 2 and 7 address these without a private facet-engine dependency, a framework fork, or a second handwritten model/tool loop.

## Goals / Non-Goals

**Goals:**

- Extend the existing service, ledger, compatibility checks, and browser contracts rather than create a parallel runtime.
- Separate immutable workflow definitions, current owner authority, and private credentials.
- Define a small supported facet/MCP profile with explicit refusals and bounded inputs.
- Preserve historical records and keep goal-only operation independent of facet availability wherever its existing prerequisites remain satisfied.

**Non-Goals:**

- A workflow DSL, general scheduler, hot configuration reload, runtime package installation, or a new authorization service.
- Nested delegation, facet-defined root-agent selection, remote MCP transports, MCP OAuth, sampling, elicitation, resource fetching, or asynchronous MCP tasks in this profile.
- Enforcing an MCP process's internal behavior or promising exactly-once external effects.

## Decisions

### 1. One application, an opt-in capability profile

The existing package boundaries SHALL remain: the runtime owns execution and I/O; contracts contain browser-safe schemas; the UI contains presentation only. A new private `packages/facet-adapter` package SHALL implement the public adapter protocol and install-time sealing tool. Runtime capability loading, policy, and MCP code SHALL live behind a runtime-owned boundary, not inside provider adapters or the browser package.

The initial profile SHALL use the built-in root agent and one level of sequential, caller-waits delegation. A delegate SHALL NOT receive a delegation tool. The default maximum SHALL be eight delegations per run, configurable from one to 32 and retained at run creation. The existing shared model-step budget still applies; this limit grants no extra model requests. A declaration requiring nesting or a different root-agent mode SHALL be refused, not silently downgraded.

Goal-only requests SHALL retain their existing wire form and native read/search/question behavior. Installing facets SHALL NOT add tools to those runs automatically. Command runs SHALL select capabilities through this profile.

A command that relies on another coding tool's agent-selection metadata SHALL require an explicit authored runtime adaptation. Removing that directive without preserving the required workflow instructions is not a compatibility strategy. Adapting the PR-feedback facet remains phase-4 work.

**Rationale / alternatives:** This is the smallest useful general workflow slice. Recursive agents and selectable root agents add routing and authorization cases without being required by the phase exit. An outer handoff graph is unnecessary: the bounded probe described below supports keeping the root stock agent and an ordinary delegation tool.

### 2. Public materialization followed by a sealed deployment input

The runtime facet project SHALL live at `deploy/runtime/facets/`, with its own `facets.json`, `facets.lock`, and supported-subset README. Runtime installation commands SHALL set an absolute `FACET_DIR` pointing to a dedicated owner-controlled home outside the checkout, conventionally `~/.local/share/agent-runtime/facet-home`. That home SHALL contain only the `agent-runtime` adapter; setup SHALL refuse to proceed if other adapters are present. Changing the command's working directory SHALL NOT change the selected home. The default editor facet home and repository-root installation SHALL remain untouched. Installation SHALL use the existing CLI, not a runtime package manager or archive reader.

Initial dependency selections are:

| Boundary | Selection | Evidence limit |
|---|---|---|
| Installer | `facet` CLI 0.33.0 | Installed CLI reports adapter API 0.3; its platform-specific binary digest SHALL be recorded |
| Public adapter SDK | `@agent-facets/adapter` 0.30.0, API 0.3 | Published package and public contract inspected; exact CLI/SDK export integration still requires its bounded check |
| MCP bridge | `@langchain/mcp-adapters` 1.1.4 | Versioned source inspected; existing LangChain peer ranges are compatible |
| MCP protocol/transport | `@modelcontextprotocol/sdk` 1.32.1 | Versioned source inspected; Bun execution remains a verification gate |

All new package versions and transitive resolutions SHALL be locked exactly. No existing provider or framework upgrade is implied. A dependency conflict or failed compatibility check SHALL stop implementation for a decision, not trigger an automatic upgrade, fork, or fallback.

The custom adapter SHALL emit data beneath `.agent-runtime-export/` through SDK file-transition plans:

- `assets/<kind>/<effective-name>.json`: transformed body, adapter metadata, and losslessly encoded skill companions.
- `servers.json`: effective MCP declaration names and portable declaration objects, never connection approvals.
- Refused asset records containing a fixed reason and safe field identification, so one unsupported contribution need not discard unrelated valid contributions.

The adapter SHALL implement the SDK's install, inspect, and removal planning contracts for those owned outputs. It SHALL NOT directly mutate project files, contact servers, or import the private facet engine. Asset `request.name` is the effective name; `metadata.description` supplies the description. Missing or unsupported runtime metadata SHALL become a refused contribution receipt. Runtime semantics SHALL require explicit `adapters.agent-runtime` version-1 metadata; front matter and settings for other coding tools SHALL NOT be interpreted as runtime authority.

After a successful CLI installation, the Bun sealing command SHALL join these exports to the public manifest/lockfile. The command SHALL verify the selected authored-to-effective-name mappings, aliases, omissions, file membership, and companion-byte integrity. Identical deduplicated server declarations SHALL retain all contributing origins. Extra, conflicting, missing, or mismatched export records SHALL prevent sealing the affected installation.

**Temporary upstream dependency (owner-approved, 2026-10-08):** Research against CLI 0.33.0, SDK 0.30.0/API 0.3 and lockfile format 0.3 identified missing public server provenance: the adapter receives effective server names and declarations without their originating facets, while the lockfile records no per-facet server inventory. The owner is working on an upstream change to add that data to the lockfile. Its released schema and supporting CLI version are not yet established. The server-origin join and its dependent tests MAY be deferred while text-asset export/sealing, metadata, catalog loading, isolation and other independent work proceed under their normal approval gates. This is a delivery-order change, not removal of the final provenance requirement.

During this deferral, implementation SHALL NOT invent origins, assume an unreleased lockfile field shape, or add a private-cache/archive-reader workaround. Server declarations MAY be exported, but server-bearing installations SHALL remain unsealable with a safe provenance-unavailable explanation until their complete join can be verified. Goal-only operation SHALL remain independent of this limitation. Deferred tests SHALL be identified before verification with explicit TODOs pointing to the group-9 revisit; passing interim checks SHALL NOT be reported as completion of the full public-export gate. No required provenance test may remain deferred at final verification.

Group 9's command-integration research SHALL revisit the upstream lockfile support, establish its actual schema and exact toolchain identity, and obtain approval for the remaining join and fixtures before dependent command/MCP journey implementation. If the required public data is still unavailable, that dependent work SHALL stop rather than treat the planned upstream feature as implemented. The owner also reported an installed CLI version of 0.35.0 on 2026-10-08; this is not proof of the new provenance support or automatic replacement of the initial 0.33.0 selection. Task 5.3 SHALL establish and approve the exact interim CLI version and binary digest before fixture installation; any later pin change SHALL likewise be explicit. SDK, provider and framework upgrades are not authorized by this deferral.

The sealer SHALL produce one canonical UTF-8 JSON bundle, `installation.json`. The owner SHALL pin its SHA-256 in operator configuration and supply the bundle read-only to the runtime. The hash covers the entire bundle, including source provenance, materialization choices, metadata, bodies, resources, and installer/adapter identities; it is not a field inside its own hashed payload.

The runtime project manifest, lockfile, documentation and authored local inputs SHALL be source-controlled. `.agent-runtime-export/`, `installation.json`, installer caches and adapter-home contents SHALL remain generated/local artifacts, not committed owner-specific installation state. The default generated bundle location SHALL be `deploy/runtime/facets/installation.json`. Compose SHALL accept `AGENT_RUNTIME_FACETS` as the host bundle path and mount that file read-only at `/etc/agent-runtime/facets/installation.json`; operator configuration SHALL name that path and its approved digest.

The sealer SHALL verify the CLI's shared skill/command namespace and separate agent/server namespaces after aliases and omissions. The reproducibility witness SHALL recreate the exports and sealed bundle from identical recorded inputs and the same pinned toolchain in isolated fixture installations, then compare the resulting bytes. Cross-installation checks SHALL inspect filesystem mutations, not reject equal content hashes: identical companion content in two legitimate installations is not evidence of a cross-write.

```text
facet CLI + public adapter → runtime exports + public manifest/lock
                                      ↓ seal
                         installation.json + SHA-256
                                      ↓ owner-pinned, read-only
                                runtime catalog
```

The bundle SHALL contain these closed, versioned records:

| Record | Required contents |
|---|---|
| Installation | `format: 1`, installer/adapter versions and integrity, manifest and lock digests, facet origins, selected items, declared omissions, server declarations |
| Origin | Facet identity, version, source kind/reference, CLI-recorded package and authored-file integrity |
| Selected item | Kind, authored reference, effective name, origins, exported-content digest, and `ready` or `refused` definition |
| Ready definition | Validated profile metadata, transformed body, and, for a skill, its declared text resources |
| Refused definition | Reason code and safe subject/field names; no executable interpretation |
| Resource | Skill-relative canonical path, byte length, SHA-256, and lossless bytes; only validated UTF-8 text is usable |

The runtime SHALL verify the owner-pinned bundle hash and strict format before offering contributions. Corrupt/unverifiable bundle input makes the catalog unavailable; a well-formed bundle's unsupported contributions remain individually refused. The runtime SHALL NOT rewrite the installation or reseal changed files automatically.

**Trust boundary:** Source hashes are CLI-verified provenance. Export hashes describe transformed materializations. The SDK normalizes/strips primary front matter, so the runtime SHALL NOT claim to recompute original primary-file hashes from the export. The pinned installer/adapter and the owner's final bundle digest form the build-product trust boundary. This is not protection against a compromised installer or an owner changing both the artifact and its trust anchor.

**Rationale / alternatives:** A sealed derived product satisfies recorded-installation integrity without pretending that transformed bytes equal source bytes. Reading private engine caches, adding an archive loader, or changing the facet protocol solely to obtain raw primary files is unnecessary.

### 3. Closed asset semantics and reference resolution

The runtime adapter's authored metadata SHALL have `runtimeVersion: 1`. Its supported fields are:

| Kind | Supported fields beyond version |
|---|---|
| Command | `arguments: { required: boolean }`, `requires`, `restrict` |
| Skill | `requires`; companion files come from the facet's declared skill files |
| Agent | `requires`, `restrict`; body supplies delegate instructions |

`requires` SHALL be a list of authored references to skills, agents, native tools, or named MCP tools. A local reference names the declaring facet's item; a cross-facet reference includes the facet identity. The sealer SHALL resolve references through recorded alias/omission choices. It SHALL NOT search prose for dependencies, install missing facets, or resolve by installation order. Cycles, absent required items, and refused dependencies make affected contributions unusable; unrelated valid items remain usable.

For commands and agents, `restrict` SHALL contain optional allowlists for `native`, `skills`, `agents`, and `mcp`. Absence means inherit; an empty list means deny that category. These are restrictions, never grants. Skill metadata declaring `restrict` SHALL be refused as unsupported, not ignored. Unknown behavioral fields, hooks, provider/model overrides, nested-agent requirements, and unsupported permission languages SHALL be refused. An agent definition requiring another agent is unsupported in the one-level profile.

Commands SHALL accept one raw text argument string. `required: true` rejects blank arguments; `false` permits an empty string. The literal `$ARGUMENTS` marker SHALL be substituted as text; when absent, arguments SHALL be appended in a clearly labelled owner-input section. There is no shell interpolation, file inclusion, expression evaluation, or executable template syntax. The resulting nonblank goal SHALL obey the existing 8-KiB goal limit. Invalid or oversized rendering is a start refusal, not truncation.

The root SHALL receive the command's rendered goal and the runtime's fixed safety instructions. A delegate SHALL receive its bound agent instructions and the caller's bounded task, not the caller's entire conversation automatically. Both use the run's stored provider/model/profile.

Available skills SHALL be advertised by name and description only. `mcp_LoadSkill` returns the full retained instructions and records successful loading for that actor; it does not change permissions. `mcp_ReadSkillReference` accepts a loaded skill ID and canonical resource path, with bounded paging. It SHALL read retained resource data, not resolve arbitrary host paths or execute bundled scripts. Repeated loading SHALL NOT duplicate loaded-skill membership.

`mcp_Delegate` and `mcp_AskUser` SHALL each be the sole tool call in their model response. Mixed batches containing either SHALL be refused as a whole. Skill loads are ordinary ledger operations and can accompany independent reads or MCP calls. Reference eligibility SHALL use the skills already loaded when the issuing model response is admitted: a sibling load does not enable a previously unloaded skill's reference within that same response.

**Rationale / alternatives:** Raw text arguments fit existing facet commands without a new form or template language. Explicit runtime metadata makes the supported subset auditable instead of silently approximating coding-tool-specific semantics.

### 4. Owner configuration and effective authority

Operator configuration SHALL remain startup-loaded and non-secret. Version-1 goal-only configuration remains accepted. A new optional `capabilities` section SHALL contain:

```text
installation: { path: absolutePath, sha256: digest }
allowSkills: effectiveSkillId[]
allowAgents: effectiveAgentId[]
maxDelegationsPerRun: integer (default 8, maximum 32)
localPrograms: { programId: { bundlePath: absolutePath, sha256: digest } }
servers: ServerAccess[]
```

The initial local-program format SHALL be a self-contained Bun JavaScript bundle supplied by the deployment. The existing pinned Bun executable runs it; Node/npm/bunx download launchers are not supported. A facet's `command` identifies a program binding, not an arbitrary executable to spawn. Bundle bytes SHALL match the configured digest before launch. Fixed declaration arguments are passed as an argument vector, never through a shell.

A private `packages/mcp-programs` workspace package SHALL own explicitly selected server entry points and exact package dependencies. Its Bun build SHALL produce self-contained bundles and a manifest recording each program ID, dependency provenance, bundle filename and SHA-256. The image SHALL place them read-only under `/opt/agent-runtime/mcp/<programId>/<sha256>.js`; `localPrograms` entries SHALL reference those exact paths and digests.

This profile does not promise that every third-party server bundles successfully. A server requiring unsupported native dependencies, unresolved dynamic imports, or runtime package installation SHALL remain unavailable pending an explicit design decision. There SHALL be no automatic Node fallback or program-tree packaging fallback. Test fixtures SHALL remain test inputs; neither VIPER nor another production server is shipped or granted merely to complete this phase.

`ServerAccess` SHALL identify the installed effective server name, local program, derived working-directory policy, permitted literal environment settings, and private credential-slot bindings. Its approval SHALL be one of:

```text
ServerAccess = {
  serverId, programId,
  literalEnv: { environmentName: string },
  credentialEnv: { environmentName: privateSlotId },
  toolTimeoutSeconds: integer (default 60, range 1..300),
  approval
}

{ kind: "denied" }
{ kind: "approved", serverDigest, tools: ToolGrant[] }

ToolGrant = { name, definitionDigest, argumentEquals: { field: JSONScalar } }
```

The two approval variants are exclusive; a denied entry SHALL NOT carry tool grants. Duplicate server IDs or tool names within a grant, overlapping literal/credential environment targets, and overrides of protected environment keys SHALL be invalid. Digests are lowercase SHA-256 hex; JSON scalars are finite numbers, strings, booleans or null. Private slots SHALL be version-1 records `{ version: 1, value: string }` under `RUNTIME_STATE_DIR/mcp-credentials/<slot>.json`; paths and values remain server-only.

A local server's working directory SHALL be derived as `RUNTIME_STATE_DIR/mcp/<serverId>/`, with `HOME` and `TMPDIR` pointing to `home/` and `tmp/` beneath it. These directories SHALL be created owner-only (0700); unsafe pre-existing paths or symbolic links SHALL refuse launch rather than be repaired automatically. The owner SHALL NOT configure an arbitrary `cwd`. Retained definitions and approval digests SHALL use the logical per-server directory binding, resolved against private state at launch, rather than storing an absolute credential-state path.

This is the per-server data location provisioned by the feature, not a filesystem sandbox. Existing writable runtime-state and temporary locations remain accessible according to the process's operating-system permissions. The workspace, program artifacts, facet bundle and container root SHALL remain read-only, and no broader writable mount is introduced. Server data SHALL survive ordinary restart and SHALL NOT be deleted on invocation settlement or grant removal.

The effective server digest SHALL cover the portable declaration plus the actual program digest, argument vector, logical working-directory binding, and environment/credential-target binding configuration. It SHALL exclude credential values. The tool digest SHALL cover the raw advertised tool definition, including its input/output schemas and annotations, not just its name or an LLM-simplified schema. An empty approved tool list permits discovery only, not calls.

The initial scope predicate SHALL be equality on named top-level scalar arguments, such as `repository = "owner/repo-a"`. Every configured equality must match without coercion. Paths, regexes, arbitrary predicates, and semantic claims about the server's behavior are not supported scope languages. Unsupported restrictions SHALL be refused rather than treated as prompt advice.

For each new operation, authority SHALL be the intersection of the run's captured authority ceiling, current owner grants, command restrictions and the delegate's restrictions/caller ceiling. New configuration cannot insert new definitions or widen an existing run's captured ceiling; additional access requires a new run. Revocation takes effect when updated configuration is loaded on restart. This design does not introduce hot reload.

A server-declaration change blocks tools using that changed declaration. A tool-definition change blocks that tool, not unchanged tools with valid grants. Old retained declarations do not lose authorization solely because a different declaration shares their display name. Reapproval is an owner configuration action; a model, skill, server reply, or installation acknowledgement cannot perform it.

**Rationale / alternatives:** Explicit digests and simple equality predicates are sufficient for the scoped grant example without a general policy engine. There is no generic per-call confirmation tier. Workflows still ask their own substantive questions through the existing durable question mechanism.

### 5. MCP discovery and transport stay behind a guarded boundary

The supported transport SHALL be stdio only. HTTP declarations, OAuth, server-initiated sampling/elicitation, prompt/resource operations, and asynchronous task execution SHALL be visibly unsupported. A server's read-only annotations are descriptions, not proof of safety or permission.

The runtime SHALL construct an SDK `Client` and `StdioClientTransport` itself. `MultiServerMCPClient` SHALL NOT own authorization, automatic restarts, or call retries. One execution invocation SHALL own its connections, shared between its root and delegate by approved server identity; all SHALL close when that invocation settles, including at a human pause. Inspection uses a separate short-lived connection. MCP session-local state is not part of the durable run guarantee.

Discovery SHALL be possible only for an approved server configuration. Merely listing the installed catalog SHALL NOT launch a server. An explicit console discovery action SHALL initialize, list tools, and close the server without calling tools or models. The result is an inspection inventory, not an approval. The owner copies reviewed definition digests into configuration and restarts to make grants effective. Submitting a new command run explicitly authorizes bounded initialization and tool-list preflight for its already connection-approved, required MCP dependencies. This preflight SHALL check current definitions and grants before accepting the run, without calling tools or models. It SHALL NOT occur during `GET /capabilities` or when returning an already accepted creation request. Optional unavailable tools need not block unrelated commands.

A runtime-owned SDK-client boundary SHALL bound and screen discovery before providing supported definitions to `loadMcpTools`. The LangChain adapter SHALL be used for its public tool-definition adaptation, but its generated invocation functions SHALL NOT execute. Runtime-owned LangChain tool wrappers SHALL perform the actual guarded SDK calls. The raw tool definition and approved raw schema SHALL remain separate from the adapted model-facing schema.

This separation is necessary because adapter 1.1.4 simplifies schemas, can include raw tool errors in exceptions, and can automatically read embedded resources while converting results. None of those invocation behaviors is the runtime's authority or disclosure policy. The existing refusal of `DEBUG` and tracing SHALL also cover this adapter's `debug` logger. No dependency error or raw discovery payload SHALL be logged.

The initial input-schema profile SHALL allow object-root JSON schemas with scalar types, nested objects, homogeneous arrays, `required`, `additionalProperties: false`, enum/const, numeric bounds, string lengths, and array lengths. Nullable scalar `type` pairs are allowed. Non-operative title/description/default annotations are retained, but defaults SHALL NOT be inserted. References, schema composition/conditionals, regexes/formats, remote resolution, coercion, and unknown behavioral keywords SHALL be refused. Structural validation of this closed profile precedes compilation with the SDK's public AJV validator. Validation SHALL use the original arguments and raw approved schema, not an adapter-simplified schema or mutated/defaulted arguments.

New MCP dispatch SHALL require, in order: exact operation identity/replay resolution; active actor and contribution checks; current matching server/tool grants; supported raw schema and argument restrictions; credential-safe arguments; and final run/ownership/cancellation admission. Connection and discovery can happen outside the short dispatch gate, under cancellation tracking; the final current-definition/grant checks and request initiation SHALL be serialized with cancellation acceptance. There SHALL be one SDK `callTool` attempt per admitted operation, with no retry, process restart, or resource-following call hidden underneath it.

The transport SHALL use a fixed working directory and `shell: false`. It SHALL discard stderr rather than inherit it. The SDK's inherited defaults (`HOME`, `LOGNAME`, `PATH`, `SHELL`, `TERM`, `USER`) SHALL all be overridden with explicit non-secret deployment values. Only approved literal settings and that server's credential bindings SHALL be added. Provider credentials, database settings, tracing/proxy settings, loader hooks, and arbitrary parent environment variables SHALL NOT be forwarded. A local server remains trusted, unsandboxed code despite these provisions.

Connection/discovery SHALL have a 15-second deadline. A tool call SHALL have a 60-second default wall deadline, configurable from one to 300 seconds. The SDK call SHALL receive the run signal and an absolute total timeout; progress SHALL NOT extend it. On cancellation/deadline, the runtime SHALL abort the request, close the transport, and await tracked local work. The stock stdio transport's close sequence terminates its owned child if graceful shutdown fails. It does not prove that the server or another external service reversed an action.

Only text blocks and JSON structured content SHALL enter the runtime result projection. Unsupported binary/resource/task results SHALL not trigger follow-up protocol requests. Text is screened as a whole before clipping; structured content containing recognized credentials in any field is withheld. Server `isError` replies become fixed, credential-safe failures rather than raw exception strings.

The closed external outcome union SHALL be:

| Kind | Fields and meaning |
|---|---|
| `ok` | Sanitized text and optional JSON; a valid completion response was received |
| `refused` | Safe reason/message; policy or input checks prevented tool dispatch |
| `unavailable` | Safe reason/message; launch, connection, or discovery failed before the call |
| `failed` | Safe reason/message; a response reported failure or its completed result could not be used safely |
| `uncertain` | Safe reason/message and operation identity; dispatch may have occurred but completion cannot be established |

Raw SDK errors, stderr, headers, credential values, and server error bodies SHALL NOT be fields of this union. An uncertain result SHALL NOT be retried automatically. Cancellation remains the run's lifecycle outcome, with the tool's uncertainty recorded separately where needed.

**Rationale / alternatives:** This reuses stock MCP framing, transport, schema validation, and LangChain adaptation while keeping policy at the existing runtime boundary. Using adapter invocation helpers directly would introduce unapproved I/O and unsafe error projections. Remote MCP adds origin/authentication decisions that are not needed for the first supported slice.

### 6. Immutable run inputs and retained capability snapshots

Public contribution IDs SHALL be `<kind>:<effective-name>`; authored references and versions remain separate provenance. Server IDs use effective declared names. An MCP tool reference SHALL be the pair `{ serverId, toolName }`. Model-facing external tool names SHALL be `mcp_ext_` plus the first 48 hex characters of the canonical server/tool identity digest. A collision SHALL refuse the affected binding, never select a different tool. Native tool names are reserved.

The model-facing description SHALL begin with the credential-safe public server and tool names. Console/history labels SHALL use that public reference rather than requiring the owner to interpret the hashed wire name. The runtime-added description prefix SHALL NOT alter the raw definition used for approval.

The normalized run input SHALL be exactly one of:

```text
{ kind: "goal", goal, provider }
{ kind: "command", commandId, selectionRevision, arguments, provider }
```

`arguments` is the raw text string. `selectionRevision` identifies the resolved command definitions offered to the owner. The browser cannot provide prompts, graphs, endpoints, grants, workspace paths, checkpoint IDs, or credential references. Unknown request fields remain invalid.

An accepted command run SHALL retain a content-addressed `CapabilitySnapshot` containing the command and rendered goal, all definitions made available to its actors, unloaded skill bodies and resources, bound agent definitions, raw/adapted MCP definitions, server/program identities, original authority ceiling, limits, provenance, and interpretation/protocol versions. Private credential values SHALL never enter the snapshot. Availability observations and mutable current grants are not substitutes for retained definitions.

Snapshot identity SHALL be SHA-256 of canonical JSON using the existing canonicalization rules. Snapshots SHALL be immutable and retained while referenced by runs. Runtime installation removal does not remove snapshots. No snapshot garbage collection is introduced in this phase.

The creation-request digest SHALL use the normalized submitted input, including the requested selection revision, not re-render against whatever is now installed. An existing request identity SHALL be resolved before checking the current installation, provider readiness, or MCP service. Identical retries return the original run; different input conflicts. A new request against a stale selection revision is refused without silently selecting the updated workflow.

Creation SHALL atomically bind the immutable input, capability snapshot, execution definition, initial invocation, and initial history to the new run. The run SHALL NOT be acknowledged or dispatched with a missing snapshot. The public `goal` for command runs is the validated rendered goal, preserving the existing meaningful run-list field.

The execution-definition digest SHALL include the retained snapshot digest, actor/tool/question protocols, root and delegate graph shapes, prompts, tool schemas, supported interpretation profile, and the relevant runtime/package code closures. Current owner grants and credential values SHALL NOT be incorporated as frozen execution code: revocation is a dispatch restriction, not permission to rewrite a snapshot. Runtime code incompatibility still refuses continuation under the existing contract.

Before accepting an answer, the runtime SHALL reconstruct from retained definitions and verify the saved root/delegate state without invoking either graph. Confirmed missing/unusable definitions or incompatible code produce `continuation_unavailable`; temporary inability to inspect storage produces `cannot_verify` without accepting an answer or changing the recorded outcome. MCP unavailability alone is not evidence of corrupt graph state.

**Rationale / alternatives:** Keeping only version labels or rereading installed files would strand waiting runs or silently change their behavior. Keeping full retained definitions in application persistence avoids requiring old installation directories to remain mounted.

### 7. Stock tool-invoked delegates with explicit child-state inspection

The root SHALL remain stock `createAgent`. Its `mcp_Delegate` tool SHALL invoke a freshly reconstructed stock child `createAgent`, using the same run thread ID, official saver, provider binding, root invocation ownership, cancellation tracking, and model-admission boundary. There SHALL be no independently scheduled child run, separately charged budget, custom model loop, or outer sibling-handoff graph.

Each delegation SHALL have a stable ID equal to its parent delegation-tool operation ID. A new call to the same named agent has a new delegation identity. The framework-provided checkpoint namespace at that parent tool task SHALL be recorded with the delegation. The child SHALL be the only graph invocation within that tool task; no application-chosen namespace or independent thread is substituted. Child task input SHALL have a stable message identity derived from the delegation ID, so parent-tool re-entry does not create a different initial task.

The root's automatic subgraph enumeration SHALL NOT be relied on to find the child. When an interrupt bubbles up, the runtime SHALL:

- Match the root pending tool task to the recorded delegation and its bound agent definition.
- Reconstruct that child and inspect its state directly at the retained thread/namespace using the public graph state API.
- Require exactly one supported pending question, with matching actor, operation, payload, task, and interrupt identity; validate both root and child state before publication or acceptance.

These are correctness checks, not permission to invoke a graph during inspection. The resume SHALL still be sent to the root with the existing interrupt-ID resume map. Framework control-flow exceptions SHALL pass through model/tool middleware unchanged. Re-entering the parent tool is expected; replay guards and the child's checkpoint, not an assumption that the function runs once, prevent duplicate completed work.

Delegation-tool re-entry SHALL reattach to the recorded child state using the inherited resume context and stable task identity. It SHALL NOT create a replacement thread, change the initial task's identity, reset saved child state, or perform an external effect outside the operation ledger. Passing the same stable input through the stock invocation API is not itself a reset; the invariant is preservation of the saved execution and recorded outcomes.

A separate child thread with mirrored parent interrupts was considered and rejected: it introduces a second question-resume mapping and replay-order invariant without an advantage over the observed same-thread path.

Question bindings SHALL be versioned:

| Variant | Required binding |
|---|---|
| Existing binding | Retain the phase-1 shape and decoder for historical records |
| Version 2, root | Actor `root`, root thread, leaf checkpoint namespace/ID, task and interrupt IDs, question operation ID, payload/state/definition digests |
| Version 2, delegate | Delegate ID and agent reference; the same leaf fields for the child; plus root checkpoint/task identity and parent delegation-operation ID |

The stored binding digest SHALL cover the entire applicable variant. Required-state verification SHALL include the actor's loaded-skill membership and retained-definition references as well as checkpoint facts, so losing or inventing a successful skill-load record cannot silently change reference eligibility. Current owner grants remain a separate dispatch check. The database SHALL prohibit a delegate binding without its delegation/parent operation and prohibit contradictory root/delegate fields. The browser receives asker attribution, not these private checkpoint bindings.

A delegate's question SHALL publish as the run's sole pending question. Its answer resumes the original child; the caller receives only the child's eventual sanitized result or task-failure outcome. A safe delegate refusal does not automatically fail the whole run. Shared step-limit failure, unsafe execution/storage state, or another existing run-ending failure remains terminal. Only a new final root assistant result can become the run's successful result.

**Observed bounded probe:** Under the pinned Bun/LangChain/LangGraph versions, a root tool invoked a child that read a synthetic value and interrupted. The propagated root interrupt matched direct inspection of a freshly constructed child at its saved namespace. A fresh root/child pair over the retained `MemorySaver` resumed by interrupt ID with `{ answer: false }`; the read count stayed one, the delegation-tool body was entered twice, and the final answer was preserved exactly. No files, services, or provider requests were involved. This establishes the in-memory API path, not PostgreSQL/process-restart or production-controller correctness; those remain mandatory bounded integration checks.

**Rationale / alternatives:** Explicit child inspection closes the discovery gap without replacing stock agent loops. A dynamically invoked child is usable here, but treating root-only inspection as sufficient is not. Static outer routing would add a transcript handoff protocol without being needed by the observed public API path.

### 8. Durable identities, record shapes, and atomicity

Application persistence SHALL gain the following records through a new migration; applied migrations SHALL NOT be edited:

| Record | Key and immutable identity | Mutable state / constraints |
|---|---|---|
| Capability snapshot | `snapshot_digest` | Immutable versioned payload; digest verified on use |
| Run capability binding | `run_id` | Immutable command input, snapshot digest and captured limits; absent for legacy/native goal-only runs |
| Run actor | `(run_id, actor_key)` | `root`, or a delegate whose key equals its parent delegation-operation ID |
| Loaded skill | `(run_id, actor_key, skill_id)` | Immutable first successful load operation and bound definition digest |
| Existing tool operation | `(run_id, operation_id)` | Add identity version, actor key, bound tool reference and external-dispatch disposition |
| Existing model attempt | `(run_id, attempt_id)` | Add actor attribution; run-wide ordinals, provider binding and accounting stay authoritative |

Root actors SHALL have no delegation fields. Delegate actors SHALL have a parent actor, parent operation, bound agent reference, task digest, framework checkpoint namespace, and one of:

```text
{ kind: "active" }
{ kind: "waiting", questionId }
{ kind: "completed", outcome: DelegateOutcome }
{ kind: "abandoned", reason }

DelegateOutcome =
  { kind: "result", text }
  | { kind: "refused", reason, message }
  | { kind: "failed", reason, message }
```

The initial profile requires the parent actor to be `root`. Typed runtime evidence, not interpretation of assistant prose, SHALL determine refused/failed outcomes. A final assistant message explaining an inability remains an attributed delegate result; it does not invent an execution-failure category. Unknown exceptions and unsafe state remain run-ending failures.

Operation identity version 1 SHALL retain the existing formula for historical/native records. Version 2 SHALL be SHA-256 over the newline-separated tuple `v2`, run ID, actor key, model-message ID, and provider tool-call ID. Those identifier components SHALL reject control characters. This gives identical replay the same identity while distinguishing actors and genuinely new calls.

The current `(run_id, provider_tool_call_id)` uniqueness constraint SHALL become actor-scoped. Rebinding the same actor's provider call ID to another issuer, tool, or argument digest SHALL be refused as inconsistent, not treated as a cache hit. A delegate ID is an operation identity, never just an agent name. A question ID SHALL remain its asking tool's operation ID.

Tool disposition SHALL support the existing started/paused/completed/abandoned states plus an external dispatch-intent state. External completed outcomes SHALL distinguish `ok`, `refused`, `error`, and `uncertain`. A durable dispatch intent means the request may have been sent; it SHALL NOT be displayed as proof of physical delivery. A crash between committing that intent and initiating transport remains uncertain, with no automatic replay.

The runtime SHALL preserve these atomic boundaries under the existing run lock and owner-epoch fence:

| Atomic change | Invariant |
|---|---|
| Accept command run | Input, snapshot binding, execution definition, root actor, invocation and initial history refer to the same accepted work |
| Begin delegation | Parent operation, delegate identity, limit consumption and start event cannot disagree; replay does not count twice |
| Complete a skill load | Successful outcome, loaded-skill membership and use provenance become visible together |
| Admit external dispatch | Working state, owner/invocation/actor authority and durable dispatch intent are confirmed before the SDK request starts under the cancellation gate |
| Record a tool outcome | Immutable operation binding, sanitized result and ordered event agree; an unconfirmed commit cannot become a model-visible success |
| Publish delegated question | Child question binding, asking operation, delegate waiting state, settled root invocation and run waiting state refer to one pending question |
| Accept its answer | Exact answer, answer invocation and run/delegate active states agree; only that invocation can continue it |
| Complete delegation | Parent tool outcome, delegate outcome and end event agree before the root consumes the result |
| Cancel or reconcile startup | Question/delegate dispositions and the run outcome cannot leave runnable orphan work |

Database constraints SHALL retain one root actor per run, one pending question and one active root invocation; reference valid same-run actors from new operations/attempts; and require a successful run's result event to belong to the root actor. Actor identities and operation bindings are immutable. Versioned JSON discriminators and their required/forbidden fields SHALL be checked by both storage constraints and strict runtime decoders; complete snapshot semantics and digests SHALL be revalidated before use.

The official checkpointer remains a separate transaction boundary. Application records SHALL NOT claim a saved interrupt exists until settled graph state has been inspected. No database transaction SHALL span model or MCP network work. A caller that cannot establish whether a completion commit succeeded SHALL use the existing commit-certainty behavior, not repeat the external operation.

A paused delegation's parent tool operation remains started while its actor identifies the pending child question; it SHALL NOT misuse the native question's `paused` disposition, whose question ID equals that operation's own ID. Completed operation replay SHALL check the exact binding and return the stored, screened outcome before considering permissions for a new dispatch. Revocation does not erase history or cause a previously completed action to run again.

Event source keys SHALL include the actor/operation identity where applicable, preserving the existing unique `(run_id, source_key)` and contiguous per-run sequence. For example, assistant-message identity is scoped by actor and message ID; delegation start/end by delegation ID and phase. Root-only historical events retain their original bytes and sequences; absent legacy actor metadata projects as root.

An uncertain external call SHALL terminate the run as `tool_failure` with reason `mcp_outcome_unknown`, unless cancellation/interruption already determines its outcome. This prevents a subsequent model turn from automatically attempting recovery of an unknown effect. Known safe refusals and recoverable tool failures remain tool outcomes. Existing authorization, quota, provider, step-limit, continuation and runtime failure categories SHALL remain unchanged.

**Rationale / alternatives:** Extending existing records preserves a single execution authority. A second event log, independent delegate runs, or argument-only result caching would weaken ownership, accounting, or replay semantics.

### 9. Browser/API contracts and validation order

The API SHALL retain `/api/v1` and the existing goal-start envelope. Command starts SHALL use an exclusive alternative shape:

```text
{ requestId, provider, goal }
or
{ requestId, provider,
  command: { id, selectionRevision, arguments: string } }
```

Supplying both forms, unknown fields, an invalid provider, or malformed identifiers is invalid. For a syntactically valid request, existing request-identity resolution precedes fresh readiness/discovery work. New requests then require credential-safe owner input, matching command revision, valid rendering/prerequisites, existing provider/workspace prerequisites, and successful durable acceptance. A retry of an already accepted request SHALL NOT reconnect MCP servers merely to rediscover its original command.

New public reads/actions SHALL be:

| Route | Contract |
|---|---|
| `GET /capabilities` | Installed origins, contribution states, safe refusal reasons, configured grants, and cached server/tool inspection; no server launch |
| `POST /capabilities/servers/:serverId/discover` | `{ catalogRevision }`; inspect an already connection-approved server without calling tools or models; return bounded, credential-safe definitions, digests, and reapproval reasons |
| `GET /runs/:runId/capabilities` | Retained command/provenance, bound versus used items, captured limits, actor tree, and recorded/current permission explanations |

All routes are under the existing API prefix and retain Host/Origin, body-size, response-security and no-cross-origin protections. Discovery is an explicit action because it can launch a trusted process; it does not grant access or edit operator configuration. Installation management and approval-editing APIs are not added.

Contribution availability SHALL be a discriminated union:

```text
{ kind: "ready", selectionRevision }
{ kind: "refused", reason, subject }
{ kind: "unavailable", reason, subject }
```

The catalog response SHALL be `{ kind: "unconfigured" }`, `{ kind: "unavailable", reason }`, or `{ kind: "ready", catalogRevision, contributions, servers }`. Each contribution view SHALL contain `id`, `kind`, `name`, `description`, `origins`, and its availability. Server/tool inspection SHALL identify definition digests, grant/reapproval disposition, and safe explanations, never private slot bindings or environment values. A run's capability response SHALL be `{ kind: "native" }` or `{ kind: "command", command, snapshotDigest, bound, used, actors, limits, permissions }`; `command` contains ID, revision, submitted arguments and rendered goal, while `used` refers to recorded operations rather than inferred model intent.

`refused` covers unsupported semantics, conflicts, integrity/prerequisite failures, denied scope and required reapproval. `unavailable` covers transient storage or approved-server availability. Top-level catalog state SHALL distinguish `unconfigured`, `ready` and `unavailable`. An unusable optional contribution SHALL NOT make unrelated native execution unready. Inability to enforce the shared credential-screening boundary still fails closed.

Start/discovery error mappings SHALL use the existing acceptance/error envelope with optional safe contribution identification:

| Condition | HTTP / code / acceptance |
|---|---|
| Malformed request or invalid command arguments | 400, `invalid_request` or `command_arguments_invalid`, `not_accepted` |
| Selection revision changed | 409, `capability_selection_changed`, `not_accepted` |
| Missing/refused prerequisite or unapproved access | 409, `capability_unavailable`, `not_accepted` |
| Temporary catalog, approved-server or screening outage | 503, `capabilities_unavailable`, `mcp_server_unavailable` or existing `screening_unavailable`, `not_accepted` |
| Duplicate request with different input | Existing 409 `request_conflict` |
| Uncertain acceptance commit | Existing 503 `acceptance_unknown`; repeat the same request identity |

The new codes SHALL be added to shared contracts, not sent as arbitrary strings. Existing answer and cancellation envelopes remain unchanged. `pendingQuestion` SHALL gain asker attribution for command runs; private checkpoint/thread bindings remain server-only.

History SHALL add a command-selection event and actor/contribution attribution to relevant messages, attempts, tool events and questions. Skill/reference use is recorded through attributed tool-operation events; delegation start/end identify the stable delegate instance. `uncertain` tool disposition SHALL have its own visible label. Run status stays the existing seven-state union. The UI SHALL distinguish a delegate result from the final root result and installed/bound entries from actual use.

The new public event kinds SHALL be `run.command` with `{ commandId, selectionRevision, arguments, snapshotDigest }`, `delegation.started` with `{ delegationId, agentId, parentActor, task }`, and `delegation.finished` with `{ delegationId, outcome, operationId }`, where the finished outcome is `result`, `refused`, `failed` or `abandoned` and its detailed recorded outcome remains in the corresponding operation. Existing agent-originated event payloads SHALL carry `actor: { kind: "root" } | { kind: "delegate", delegationId, agentId }` for new command runs. Tool events SHALL additionally identify their native/skill/reference/delegation/MCP binding, using public contribution references. Owner/system events SHALL NOT be falsely attributed to an agent. Legacy payloads without these fields remain valid and project as root where appropriate.

The start form SHALL offer goal or command mode, a command description/arguments field, readiness/refusal information, and the existing provider selection. The run view SHALL add a small capability/provenance panel and actor labels in the existing ordered history, not a separate multi-agent dashboard. All supplied content remains plain text. Server and UI contract changes ship together; stale browser bundles may require reload after upgrading the application protocol.

**Rationale / alternatives:** Additive command mode and the existing run lifecycle avoid a separate workflow API. Keeping discovery explicit avoids hidden process launches during ordinary page inspection, while configuration remains the only source of grants.

### 10. Bounded inputs and credential handling

The initial profile SHALL enforce these bounds and report a named refusal rather than silently truncate definitions:

| Input / operation | Bound |
|---|---|
| Sealed installation or retained snapshot | 16 MiB canonical payload |
| Installed contributions | 128 total; at most 32 skills, 16 agents, 32 commands and eight server declarations |
| Skill instructions | 48 KiB UTF-8, returned whole |
| One bundled text reference | 1 MiB; paging uses existing read/result limits |
| Rendered command goal / delegate task | 8 KiB each |
| Bound MCP tools | 64 per run |
| Advertised tool definition | 32 KiB; schema depth eight and at most 256 property entries |
| Discovery | At most eight pages and 128 advertised tools; 15-second total deadline |
| MCP raw message / serialized call arguments | 1 MiB / 32 KiB |
| Agent-visible tool result | Existing 64-KiB complete serialized-outcome limit |
| Delegations | Depth one; default eight per run, owner-configurable up to 32 |

Sealed installation input SHALL match its canonical encoding after parsing; non-finite numbers, invalid UTF-8, unsafe resource paths, unknown formats and unsupported schema constructs SHALL be rejected. Runtime reference loading SHALL use retained resource identifiers, not filesystem traversal. Ordinary non-secret facet sources located in the workspace remain ordinary task data; reading them does not activate a skill or change grants.

MCP secrets SHALL be supplied in owner-provisioned private credential slots outside the workspace and installation. Slot names, target environment-variable bindings and value digests are not model input; credential values and private paths SHALL NOT appear in public projections or snapshots. Values SHALL meet the existing screenability floor and bounded text requirements. Slots SHALL use owner-only, non-symlinked private files, and unreadable/unusable configured credentials SHALL be reported rather than ignored.

The server-side operator entry point SHALL support `bun dist/auth.js mcp set <slot>` and `bun dist/auth.js mcp status <slot>`. `set` SHALL read the value from stdin, never from argv or a logged environment setting; it SHALL validate 16–16,384 printable, non-space ASCII characters and use the same atomic replacement and owner-only file hygiene as provider credentials. `status` SHALL report only missing, present or unusable, never the value.

Provisioning SHALL use the deployment's configured database and private-state directory while the runtime is stopped. Before replacing a slot, `set` SHALL acquire the existing singleton ownership advisory lock without claiming a new epoch or running migrations; inability to establish exclusive maintenance ownership SHALL refuse the write. This prevents a live process from retaining an inconsistent credential-screening set. The value becomes effective on the next runtime start. The command SHALL make no provider or MCP request and SHALL NOT remove credentials automatically. This is server-side operator tooling, not a new owner-device helper or model-login step.

Only the intended server's selected values SHALL be injected into its environment. The runtime's content policy SHALL cover known provider credentials and configured tool-service credentials before accepting command/delegate arguments, recording definitions, dispatching tool arguments, and recording/returning results. Arguments containing credentials SHALL be refused, not rewritten. Secret-bearing declarations or metadata SHALL be refused without echoing their contents. Text-result redaction and whole-structured-result withholding SHALL happen before graph/checkpoint ingestion.

The policy remains exact matching of runtime-known values plus documented high-confidence patterns, not universal secret detection. Server processes receive their own credentials intentionally and remain trusted code; the runtime's no-disclosure promise governs its forwarding, model context, records, projections and captured diagnostics, not the server's independent behavior.

**Rationale / alternatives:** Fixed bounds and existing sanitation rules are sufficient for the MVP. Arbitrary resource execution, generic DLP, unrestricted schema interpretation, or a new server sandbox would expand the project substantially.

### 11. Bounded verification and documentation are part of delivery

Implementation SHALL prove the risky boundaries early with synthetic inputs, before a production capability set or effectful external tool is enabled:

1. **Public export gate:** the selected CLI/SDK pair installs one runtime-compatible fixture with a command, skill companion, agent and server declaration. Alias, omission, unsupported metadata, removal and repeated-install cases produce the expected independent export. Sealing verifies the join and runtime refuses an altered bundle. The editor installation remains unchanged. The gate SHALL check both directions using fixture homes: runtime installation emits no editor materializations, and editor installation emits no runtime exports. It SHALL also compare repeated sealed output from identical inputs. Ordinary skill loading alongside an independent read SHALL be allowed, while a same-response reference to a newly loaded skill SHALL be refused until a later response.
2. **Durable delegate gate:** the stock root/child pattern runs through the official PostgreSQL saver and existing controller, then answers a delegate question from a fresh process. Completed native and synthetic MCP operations are not repeated; new identical-argument calls remain new operations. Include two sequential calls to the same named agent, exact negative answers, actor identity collisions, lost answer acknowledgements, shared budget exhaustion, cancellation and interrupted startup. Include two sequential questions from one delegate, answered across a process restart, without resetting the child or repeating completed operations.
3. **MCP/Bun gate:** the pinned SDK/adapter pair starts a bundled local fixture, discovers and calls it, then exercises schema/scope denials, changed tool definitions, missing program, timeout, disconnect, oversized/secret-bearing responses and stderr, and child cleanup. There SHALL be zero hidden retries, resource fetches, model requests or package downloads. Verify the fixed per-server working directory, HOME/TMPDIR placement and persistence, program-manifest digest checks, and stdin-only credential provisioning. A credential write while runtime ownership is held SHALL be refused without changing the slot.
4. **Integrated journey:** command, skill/reference, delegate, approved tool, delegate question and final root result under both scripted provider assemblies, with browser replay/provenance. Retained definitions continue after installation replacement/removal, while effective revocation still refuses new calls. Native goal-only behavior and old history remain covered.

These are finite acceptance witnesses, not a new benchmark programme. Existing relevant unit, integration, browser and container checks SHALL be run for changed inputs. A verification failure SHALL stop without automatic repair or rerun. Live provider requests, deployment, and any acceptance exception require fresh explicit owner decisions; this artifact authorizes none of them. The in-memory probe in Decision 7 SHALL NOT be relabelled as a PostgreSQL or live-provider pass.

Decision 2's temporary server-provenance deferral permits interim verification of independent work, not a pass of the complete public-export or integrated-journey gate. Those gates SHALL remain pending until the upstream lockfile join and every dependent witness have passed.

The following documentation changes SHALL accompany implementation, not this planning write:

| Document | Required change |
|---|---|
| `README.md` | Remove milestone/progress narration and stale acceptance statements from the introduction, Providers and Limitations; retain operational caveats and stable evidence links. Document the independent CLI installation, sealing/pinned digest, supported metadata, configuration/grants/secret slots, discovery, command mode, delegation, MCP boundaries, restart/compatibility and deployment inputs. Update the API, layout, command and troubleshooting sections. Explain that an uncertain MCP reply ends the run and leaves any external recovery decision to the owner. |
| `architecture/02-control-plane.md` | Replace the fixed-tool/no-delegate as-built account where affected; document stock root/tool-invoked children, one-level limits and explicit child-state inspection, without reviving the historical manager/scheduler design. |
| `architecture/08-execution-security.md` | Describe current scoped grants, reapproval, credential-safe projections and the unsandboxed MCP trust boundary. Do not reintroduce universal per-call confirmation from older design intent. |
| `architecture/09-data-model-and-lifecycle.md` | Add snapshots, actors, versioned operation/question bindings, delegate waiting and external uncertainty; retain the existing run terminal-state and restart rules. |
| `THIRD_PARTY_NOTICES.md` and deployment guidance | Identify added SDK/adapter/server-bundle licenses and reproducible image inputs; document the absence of runtime downloads and the migration rollback limitation. |
| `deploy/runtime/config.example.json` and `.env.example` | Show the capability section, placeholder approval digests, private slot references and `AGENT_RUNTIME_FACETS`, without credential values. |
| `deploy/runtime/facets/README.md` | Document the supported subset, absolute isolated `FACET_DIR`, install/seal procedure, generated-artifact policy, program supply, discovery/approval, and server-side credential provisioning. |
| `architecture/07-network-and-protocols.md` | Document capability routes, new event kinds and the stdio-only boundary. |

No `docs/` directory currently exists. The current README's fixed tool list, root-only question inspection, strict goal-start envelope, and three-service deployment are relevant as-built inputs, not a substitute for the new contracts above. Historical evidence and archived/adversarial artifacts SHALL remain unchanged.

**Rationale / alternatives:** Small, attributable witnesses settle integration risk while preserving the owner's good-enough delivery constraint. A fresh provider trial or broad phase-1 audit is not a prerequisite to writing or reviewing this design.

## Risks / Trade-offs

- **Adapter-home contamination** → Every runtime installation invocation uses the isolated absolute `FACET_DIR`; setup checks its adapter set, and fixture checks verify cross-write isolation in both directions.
- **Third-party bundling incompatibility** → The first profile supports verified self-contained Bun bundles only. Failed packaging is a visible unsupported-program condition, not permission to download dependencies, switch engines, or add a generic packer automatically.
- **Derived artifact trust** → The public SDK does not expose original primary bytes. Trust the pinned CLI/adapter transformation and owner-pinned final artifact; keep source and output integrity distinct. The export gate verifies the exact chosen toolchain, not a sibling checkout's version label.
- **Dynamic child inspection is version-sensitive** → Retain exact framework pins, framework-provided namespaces, both root/leaf binding checks and the PostgreSQL fresh-process gate. A failing gate stops the implementation; it does not authorize dropping durable delegate questions or substituting a new engine.
- **Adapter schema/output conveniences exceed the permitted surface** → Use bounded discovery and runtime-owned invocation/result handling. Unsupported schemas and content remain visible refusals instead of silently weakened contracts.
- **MCP processes are trusted code** → Pin Bun server bundles, use fixed argv/cwd/environment and private credential bindings, and disclose that request scope is not process isolation. No automatic download or universal sandbox claim.
- **External completion can be unknowable** → Record dispatch intent and uncertainty, stop rather than automatically retry an unknown effect, and reuse only recorded outcomes for the same logical operation.
- **Grant changes versus immutable definitions** → Existing runs keep their definitions and authority ceiling; current grants can narrow dispatch. Configuration takes effect on restart. New access requires a new run rather than mutation of an old one.
- **Sessions close at human pauses** → Only recorded tool results and agent checkpoints are durable. A tool that depends on volatile MCP session state may become unavailable or return an error after reconnection; persistent server-session workflows are outside this profile.
- **Restrictive first profile** → One-level delegates, raw-text command arguments, stdio Bun bundles and the schema subset require explicit runtime-specific facet adaptation. Unsupported behavior is refused; later expansion requires a separately reviewed change rather than silent emulation.
- **Retained definitions consume storage** → Deduplicate content-addressed snapshots and enforce limits. Retention/garbage-collection tooling remains deferred; no data is automatically deleted.
- **OpenAI backend instability remains** → Use the existing stock provider path and physical-request accounting. Both providers remain in the phase contract; prior accepted exceptions are neither reopened nor automatically carried forward to new behavior.

## Migration Plan

1. Add the adapter/sealer and capability modules without enabling capabilities in existing operator configuration. The initial fixture SHALL use only synthetic data and a locally supplied test server; no production grants or credentials are implied.
2. Add a new application migration after version 3. Introduce snapshot/binding/actor/skill records, actor-scoped operation identity and versioned question/event/disposition validation. Seed root attribution for existing runs without rewriting their original events, answers, results, provider bindings or execution definitions. Existing constraints and immutable migration histories remain enforced.
3. Deploy server and console contracts together after the bounded gates pass. Before any owner-approved deployment, explain that resume-critical code changed: old waiting runs are not promised cross-build compatibility. The owner can finish or cancel them before upgrade; otherwise an attempted incompatible continuation SHALL receive the existing visible refusal, with history preserved. Active work still becomes interrupted after process death.
4. Use the isolated runtime facet home to build the generated bundle and mount it through `AGENT_RUNTIME_FACETS` at the fixed read-only container path. Supply approved program artifacts under `/opt/agent-runtime/mcp/`; provision private credential slots through the stopped-runtime operator command. Local servers use the derived private per-server data directories. Leave the workspace and root filesystem read-only. Enable only reviewed server connections and specific tool grants. No operator config, image, credential, directory or live volume is changed by artifact generation.
5. A configuration-only rollback can disable new command starts while preserving stored histories. It SHALL NOT erase retained definitions or credentials. Removing grants intentionally denies subsequent dispatch by existing runs.
6. A binary rollback SHALL use a build compatible with the installed database schema and execution definitions. The existing phase-1 compatible-image rehearsal does not establish rollback from this new migration to a phase-1 binary. Older binaries correctly refuse newer schema histories. There SHALL be no automatic down-migration, volume replacement, history deletion, or promise that an old image resumes new capability runs. Recovery from a migration/deployment failure requires a separate owner decision; backup/restore tooling is not added here.

## Evidence Used

- Current runtime/contracts/persistence/UI source and root README cited above; no archived change was required to establish the new baseline.
- Public facet SDK contract: `@agent-facets/adapter` 0.30.0 and API 0.3; [SDK reference](https://github.com/agent-facets/facets/blob/main/docs/reference/adapter-sdk.mdx), [public request types](https://github.com/agent-facets/facets/blob/main/packages/adapter/src/types.ts), and [front-matter transformation](https://github.com/agent-facets/facets/blob/main/packages/common/src/front-matter.ts). The adjacent checkout reports CLI 0.33.1, while the installed binary reports 0.33.0; source inspection of that checkout is not claimed as binary equivalence.
- Versioned [MCP adapter tools source](https://unpkg.com/@langchain/mcp-adapters@1.1.4/dist/tools.js), [SDK client contract](https://unpkg.com/@modelcontextprotocol/sdk@1.32.1/dist/esm/client/index.d.ts), [stdio transport](https://unpkg.com/@modelcontextprotocol/sdk@1.32.1/dist/esm/client/stdio.js), and [AJV provider](https://unpkg.com/@modelcontextprotocol/sdk@1.32.1/dist/esm/validation/ajv-provider.d.ts).
- Installed `@langchain/langgraph` 1.4.13, `langchain` 1.5.14 and `@langchain/core` 1.2.14 source, plus the single provider-free in-memory probe described in Decision 7. Source/API findings and that limited observation remain distinct from pending integration evidence.
