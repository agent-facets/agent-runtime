# Design

## Context

See [proposal.md](./proposal.md#why) for motivation and the capability and execution delta specs for the behavioral contract.

The current adapter requires `runtimeVersion: 1` for every text contribution (`packages/facet-adapter/src/metadata.ts:73`). Its ready export contains mandatory runtime settings (`packages/facet-adapter/src/export-record.ts:38`). The runtime has a verified installation with provenance and materialization choices, but operator configuration selects flat skill/agent IDs (`packages/runtime/src/config/capabilities.ts:178`). Snapshots require a command (`packages/runtime/src/capabilities/records.ts:246`); goal starts bypass their retention. MCP preflight discovers only command-required servers (`packages/runtime/src/capabilities/preflight.ts:40`).

Existing persistence already provides immutable definition snapshots, actor-scoped tool operations, and transactional on-demand skill membership. Actor keys are `root` or a delegation operation digest. Loaded membership currently requires a successful tool operation (`packages/runtime/src/persistence/migrations/004-capability-records.ts:283`), so it cannot truthfully represent startup supply. Continuation checks exact execution-definition and checkpoint identity (`packages/runtime/src/execution/continuation.ts:35`); reading an old snapshot alone does not establish resumability.

## Goals / Non-Goals

**Goals:**
- Separate installation admission, consuming-agent availability, instruction activation, and dispatch authority in both records and inspection.
- Use one new-run resolution contract for goals and commands, with immutable actor-specific selections and definitions.
- Preserve accepted-request identity, permission narrowing, credential screening, and actor/history atomicity.
- Make the published `voice-to-text` installation a real acceptance input without a CLI/SDK prerequisite.

**Non-Goals:**
- A new provider, graph framework, configurable root persona, recursive delegation, or mutable per-run agent configuration.
- Interpreting another coding tool's front matter, descriptions, scripts, or hooks as runtime control.
- Automatically converting old selections, repairing installations, approving MCP services, or changing live infrastructure during implementation verification.

## Decisions

### 1. Owner configuration has separate shared, root, and delegate selection scopes

The optional `capabilities` object SHALL retain `installation`, `maxDelegationsPerRun`, `localPrograms`, and `servers` with their existing grant and credential meanings. It SHALL replace `allowSkills` and `allowAgents` with this closed structure:

```text
selection: {
  shared: Selection,
  root: Selection,
  delegates: Record<AgentId, Selection>
}
Selection = { facets: FacetRef[], startupSkills: SkillId[] }
AgentId = "agent:<effective-name>"
SkillId = "skill:<effective-name>"
FacetRef = exact installation.facets[].facet identity
```

Missing selection objects and lists SHALL default to empty; null and unknown configuration fields SHALL be refused. `shared` is not an agent name. Delegate keys SHALL use the existing effective agent ID, including installation aliasing; `agent:root` remains reserved. A delegate scope SHALL resolve to exactly one installed, materialized agent, but configuring it SHALL NOT itself make that agent callable. Materialized refused agents MAY have configuration so their refusal remains inspectable.

Each scope SHALL accept at most 128 facet references and eight startup skill references; at most 16 delegate scopes SHALL be accepted. After shared/individual deduplication, each actor SHALL also be limited to eight startup skills. The per-actor instruction-byte limit is defined in Decision 8. An over-limit combined startup set SHALL refuse the affected root run or delegate invocation, not silently drop entries. Repeated facet/skill references SHALL normalize once. Shared and individual lists SHALL combine additively, preserving both sources when they overlap. A delegate without an individual entry SHALL receive shared selection only. Effective lists SHALL be sorted by stable ID, not installation order. There is no per-agent subtraction from shared selection; an isolation case MUST therefore use root-only selection, not shared selection plus an empty delegate list.

Startup IDs identify materialized skills, not facets. They SHALL NOT implicitly add the skill's facet to selection. This contribution-level activation control does not replace facet-level availability.

Startup configuration validation SHALL check structure and superseded fields before resolving the pinned installation and every configured facet/delegate reference. Missing or ambiguous facet references SHALL fail startup with a safe field path, scope, reference, and conflicting identities. Startup skill usability SHALL be evaluated for the receiving actor: invalid root startup refuses a new run; invalid delegate startup refuses that invocation, not unrelated root work. Inspection SHALL expose these problems beforehand without starting work.

Reference matching SHALL be exact and case-sensitive. A refusal MAY list installed identities with the same unscoped name as diagnostic candidates, but SHALL NOT select one automatically. Unreachable configured delegate scopes SHALL remain valid and SHALL produce a `delegate_unreachable` diagnostic. Statically unusable startup designations SHALL produce a `startup_skill_unavailable` diagnostic identifying scope, actor, skill, and cause; these diagnostics SHALL NOT turn an invocation-scoped startup refusal into whole-configuration refusal.

When configured facet references or delegate scope keys require installation validation, an unreadable, unverifiable, or unsupported pinned installation SHALL refuse startup configuration validation with its cause and repair guidance. This change SHALL NOT introduce a degraded-readiness mode or accept new runs before those references are validated. Refusal SHALL NOT modify retained runs or definitions. Restoring a valid bundle/configuration permits the ordinary retained-state continuation checks; installation availability does not become an input to a retained run’s execution definition. With no configured facet references or delegate scope keys, installation validation is unnecessary for native goal operation; capability inspection may independently report an unavailable installation.

**Rationale / alternative:** Separate fields avoid collisions between shared scope and named agents. Per-contribution availability lists would preserve the original coupling and contradict facet-level selection. Silently mapping old lists to shared selection would broaden access; their presence, including empty old lists or old/new mixtures, SHALL instead produce explicit migration guidance.

### 2. Portable admission means no actual runtime settings, not a metadata-presence distinction

The adapter SHALL treat absent, null, and empty runtime metadata identically. Installer-supplied `name` and `description` SHALL be separated from behavioral settings before classification. Thus an identity-only installer metadata object is portable. An empty authored block need not survive installation as a distinguishable value. No upstream CLI/SDK or package-format change is required.

Non-empty runtime settings SHALL use the existing explicit `runtimeVersion: 1` profile. Supported kind-specific fields retain their current validation: command arguments/prerequisites/restrictions, skill prerequisites, and bounded-agent prerequisites/restrictions. Unknown fields, malformed values, unsupported versions, and unsupported nested delegation SHALL be refused. An unknown-typed SDK input is not itself a behavioral setting; a supplied malformed value SHALL NOT be deliberately erased by the adapter. Other tools' settings and primary-file front matter SHALL remain outside this classification and SHALL NOT acquire runtime meaning.

Text exports SHALL advance to `format: 2`, with the following closed state union:

```text
Ready = {
  format: 2, state: "ready", kind, name, description, body, companions,
  admission: { kind: "portable" }
           | { kind: "explicit", settings: RuntimeMetadataV1 }
}
Refused = { format: 2, state: "refused", kind, name, reason, fields }
```

Portable commands SHALL normalize to optional raw text arguments, no prerequisites, and no restrictions. Portable skills and agents SHALL normalize to no prerequisites or restrictions. Existing `$ARGUMENTS` substitution and `## Owner input` append behavior SHALL remain unchanged; neither evaluates shell syntax. Explicit settings SHALL retain their actual restrictions, including empty allowlists that deny a category. A marker-only `{ runtimeVersion: 1 }` is explicit, with its supported defaults, not a special authorization grant.

Sealed ready definitions SHALL carry `admission: { kind: "portable" } | { kind: "explicit", runtimeVersion: 1 }` alongside their normalized fields. Validators SHALL require portable definitions to have empty prerequisites, no restrictions, and optional arguments for commands. Refused records SHALL have no usable definition. This prevents contradictory portable/restricted states.

**Rationale / alternative:** A tagged admission record explains compatibility without inventing authored declarations. Treating `{}`, null, or identity-only metadata as invalid would recreate the rejected opt-in requirement. Dropping non-empty invalid settings would silently relax restrictions.

### 3. Version installation and retained formats without rewriting historical meaning

New seals SHALL use `format: 3, profile: 2`; new capability snapshots SHALL use `version: 2, profile: 2`. Profile 2 describes consumer selection and portable admission; it does not change the explicit authored settings version. The server-export document remains format 1 because its shape and meaning do not change. Facet manifest 0.2, lockfile 0.4, CLI/SDK pins, canonical encoding, source integrity, companion verification, and installation digest checks SHALL remain unchanged.

New seals SHALL require format-2 text exports from a real re-materialization using the updated adapter. They SHALL NOT reinterpret old `runtime_metadata_missing` refusals as portable: those exports do not retain enough information to establish a new ready definition. New-run configuration SHALL require the new installation format and provide re-export/reseal guidance for older bundles. The runtime SHALL never perform this migration itself.

An older or unknown sealed installation format SHALL report `installation_format_unsupported`, with re-materialization and resealing guidance. This is distinct from an unreadable file or a digest mismatch.

Stored version-1 snapshots SHALL retain their existing decoder, digest, and original explicit-only semantics for inspection and conditional continuation. New version-2 data SHALL NOT be injected into old snapshot bytes. Unknown versions/profiles and digest mismatches SHALL remain refusals.

**Rationale / alternative:** Adding defaults to strict historical decoders would silently reinterpret old data. A versioned boundary makes installation migration explicit while preserving history and the possibility of compatible old execution.

### 4. Resolve availability per agent; propagate restrictions rather than catalogs

Resolution SHALL produce a root plan and a plan for each reachable named delegate. A target is reachable only when its agent contribution belongs to the root's selected facets and survives applicable restrictions. Each plan SHALL contain its own shared-plus-individual facet selection, contribution candidates, startup IDs, and usability outcomes. Delegate configuration SHALL NOT copy the root's skill catalog or loaded instructions. Definitions needed only by a reachable delegate SHALL still be retained before the run is accepted.

An installed contribution SHALL keep its existing `command:<name>`, `skill:<name>`, or `agent:<name>` ID after materialization. Aliasing and omission precede consumer selection. Ambiguity SHALL be refused, never resolved by iteration order. A selected facet's omitted items remain omitted; selection SHALL NOT rematerialize them.

Availability SHALL be represented as separate dimensions:

```text
selection = { kind: "unselected" }
          | { kind: "selected", sources: SelectionSource[] }
SelectionSource = { kind: "shared" }
                | { kind: "individual", agent: "root" | AgentId }
usability = { kind: "usable" }
          | { kind: "unusable", reason, subject? }
activation = { kind: "on-demand" } | { kind: "startup" }
```

Usability is evaluated only for selected materialized candidates; omitted/unselected/refused installation records remain separately inspectable. A prerequisite SHALL be checked in the context where its contribution is used: a skill or command in its receiving actor, and a delegate's declared requirements in that delegate's plan under caller restrictions. Requirements SHALL NOT add selections. Cyclic or unavailable requirements SHALL refuse the dependent contribution, not unrelated candidates. Delegate startup failure is distinct from whether the root may attempt that delegation.

Permission evaluation SHALL retain an explicit narrowing context independent of selected catalogs. A command's restrictions apply to the root and all its delegates. A delegate additionally inherits its caller's restrictions and its own agent restrictions. Native access is the existing confined native set intersected with those restrictions. Skill and delegate permission filters are inherited restrictions, not a copy of the caller's selected IDs: a delegate MAY use its own selected skill that the root did not select, provided no caller restriction denies it. Delegates still cannot delegate.

For MCP, an actor MUST have the declaring facet selected, a retained bound tool, and independent owner authority. Delegate MCP calls MUST additionally fit the caller's effective MCP authority, including the caller's availability ceiling; a delegate-only selection cannot bypass a tool unavailable to its caller. Both captured and current argument restrictions MUST pass. Current selections SHALL NOT narrow or expand already accepted runs; current independent server approvals and tool grants SHALL continue to narrow dispatch. Broader current grants SHALL NOT enlarge captured authority.

For each new operation, dispatch SHALL enforce the following checks against the receiving actor’s retained plan and restrictions:

| Operation | Required checks |
|---|---|
| Native tool | Captured native authority, command restrictions, and delegate/caller restrictions |
| Skill load | Usable skill in the actor’s retained plan, applicable restrictions, and currently satisfied explicit prerequisites |
| Skill reference read | Skill-load checks plus that actor’s frozen loaded membership and retained resource confinement |
| Delegation | Root actor, usable retained delegate target, captured delegation limit, and the target’s startup checks |
| MCP call | Usable retained actor tool, captured grant, caller ceiling, current server/tool approval, matching digests, and both captured/current argument restrictions |

Current facet selections SHALL NOT be read as dispatch authorization. Selection removal SHALL NOT produce a “no longer permitted” refusal for an accepted run. The run-wide captured skill/agent sets are retention bounds, not sufficient authorization; actor-plan membership and applicable restrictions remain mandatory.

**Rationale / alternative:** Intersecting every delegate catalog with the root catalog would make individual delegate skill selection ineffective. Copying the root catalog would violate isolation. Keeping explicit restriction propagation separate resolves both without relaxing MCP caller authority.

### 5. Goal and command admission bind approved MCP tools under one bounded policy

Both start modes SHALL resolve the same configured capabilities. A command adds its retained task definition, arguments, prerequisites, and narrowing restrictions; it SHALL NOT add facets, delegates, or tool grants. After configuration validation, a goal SHALL remain native when capabilities are absent or both the root’s effective facet selection and startup designation are empty. That native start SHALL perform no installation read, MCP discovery, or capability retention. A non-empty root startup designation with no selected facets SHALL instead refuse as `startup_skill_unavailable`; it SHALL NOT fall back to native operation. An empty root selection does not make an installed command selectable.

For configured starts, discovery candidates SHALL be the selected stdio servers usable by the root or reachable delegates, limited by caller authority, exact server/program approval, and at least one applicable tool grant. Unselected, unapproved, denied, unsupported, or statically restricted servers SHALL NOT be contacted. Explicit owner-triggered inspection with discovery-only approval remains available separately.

A server selected only by a delegate and unavailable to its caller SHALL NOT be a discovery candidate. Its delegate-plan outcome SHALL identify `excluded_by_caller`.

Admission SHALL initialize, list tools, and close each candidate without calling a tool. The existing per-server 15-second/page/tool limits SHALL remain; admission SHALL additionally have a 15-second overall discovery deadline and at most two concurrent inspections. Candidate ordering SHALL be deterministic, with required root prerequisites ahead of optional candidates. Deadline expiry SHALL cancel/close outstanding sessions. Tests SHALL inject deadlines and discovery results rather than wait for these bounds.

Discovery outcomes SHALL be retained per server/tool as `bound` with approved definitions and digests, or `unavailable` with a safe reason. Only matching, supported, granted tool definitions SHALL become callable. Name collisions SHALL exclude every colliding tool, not pick a winner. All declaring origins of a deduplicated server SHALL be retained; agent selection provenance SHALL separately identify the selected origins rather than invent one winning facet.

An optional failure SHALL remove only that server/tool from this run's usable catalog and record why. It SHALL NOT fail an otherwise valid goal or command. If the unavailable tool is an explicit prerequisite of the selected command or root startup skill, admission SHALL refuse. If it is required by an on-demand skill or delegate, that contribution SHALL be unusable and use SHALL refuse in its own scope. An unrelated delegate-startup problem SHALL NOT block root admission.

Every optional discovery failure that removes an otherwise eligible server/tool SHALL also produce a `capability.unavailable` history event in the acceptance transaction. Its payload SHALL be `{ subject, reason, affectedAgents }`, where `subject` is `mcp:<serverId>` or `mcp:<serverId>/<toolName>` and `affectedAgents` contains retained plan keys. A whole-server failure SHALL produce one server event rather than duplicate events for every tool; independent tool failures SHALL produce tool events. The source key SHALL be `capability-unavailable:<digest>`, where the digest is SHA-256 of canonical JSON `{ subject, reason, affectedAgents }` with sorted unique agent keys, unique within the run. These are owner-visible admission outcomes, not tool calls or proof of use.

No later discovery SHALL expand an accepted run's bound tools. An optional server recovering after acceptance requires a new run to gain tools omitted at admission. Existing dispatch-time definition and grant checks remain mandatory; successful admission discovery is not proof that a later call is safe or available.

**Rationale / alternative:** Command-only discovery cannot support ordinary goals. Failing the whole run for any selected optional server would turn availability into a new prerequisite. Lazy discovery that adds definitions after acceptance would violate retained-definition semantics. Bounded admission discovery makes these costs and unavailable outcomes explicit.

### 6. Retain a versioned start union, agent plans, and exact definitions

The version-2 snapshot SHALL have these concrete top-level fields:

```text
{
  version: 2, profile: 2,
  installation: { sha256 },
  start: { kind: "goal" }
       | { kind: "command", command: CommandDefinition,
           input: { arguments, renderedGoal } },
  selection: { shared: ResolvedSelection, root: ResolvedSelection,
               delegates: Record<AgentId, ResolvedSelection> },
  plans: AgentPlan[],
  skills: SkillDefinition[], agents: AgentDefinition[],
  servers: ServerDefinition[], tools: McpToolDefinition[],
  discovery: DiscoveryOutcome[],
  authority: CapturedAuthority,
  limits: { maxDelegations, delegationDepth: 1,
            startupSkills: 8, startupInstructionBytes: 98304 }
}
ResolvedSelection = {
  facets: { facet, version, source, integrity }[], startupSkills: SkillId[]
}
AgentPlan = {
  agent: "root" | AgentId,
  facets: { facet, sources: SelectionSource[] }[],
  skills: { id: SkillId, usability, activation }[],
  delegates: { id: AgentId, usability }[],
  mcp: { serverId, toolName, selectedOrigins: FacetRef[], usability }[],
  startupSkills: SkillId[],
  startup: { kind: "ready" }
         | { kind: "refused", reason, subjects: SkillId[] }
}
```

`CapturedAuthority` SHALL retain the existing native and server/tool grant shapes, including server/tool digests and argument equality restrictions. Its skill/agent ID sets SHALL be the union retained for these plans, not a flat current allowlist. Agent plans and inherited restrictions determine which actor may use those IDs. Delegate plans SHALL have empty delegate-target lists. Root and reachable delegate plans SHALL be unique by agent key; facet IDs and contribution/tool IDs within a plan SHALL be unique. All usable references SHALL point to retained definitions and selected origins; all startup references SHALL have an explicit usable or unusable resolution. Unusable references SHALL carry safe identification/reasons, not executable replacement definitions.

Every plan’s startup outcome SHALL be resolved before acceptance, after discovery-dependent prerequisite evaluation. A ready outcome SHALL require every designated skill to be usable and the combined startup set to satisfy count and byte bounds. A refused root outcome SHALL prevent acceptance; a refused delegate outcome SHALL remain retained and refuse that invocation without blocking unrelated root work. Current permission and content-policy checks before supply may still refuse a plan that was ready at acceptance; they SHALL NOT replace its retained selections or definitions.

The exact definitions, bundled skill resources, explicit restrictions, selected origin versions, and admission basis SHALL be retained. The snapshot SHALL include resolved shared/root scopes and the individual scopes of reachable delegates; unrelated delegate configuration SHALL NOT affect that run. Existing 16-MiB snapshot and contribution/tool limits remain. A bounds failure SHALL be explicit, never a truncation.

The persisted run-capability binding SHALL discriminate between legacy command bindings and version-2 bindings with `input: GoalRunInput | CommandRunInput`, `snapshotDigest`, `maxDelegations`, and the matching snapshot version. Binding validation SHALL require input/start mode agreement. A goal binding SHALL NOT contain command metadata; the submitted goal remains in its existing run/input records. A native goal SHALL have no capability binding.

**Rationale / alternative:** Making `command` nullable everywhere leaves contradictory command/input combinations possible. A closed start union and versioned binding preserve the distinction without a wrapper command. Retaining only root-visible definitions would fail first-use-after-pause for delegates.

### 7. Creation identity and snapshot retention are atomic, independent of current selection

The creation uniqueness boundary SHALL remain the existing owner request ID. The goal input digest SHALL remain the existing canonical `{ goal, provider }` formula; command input SHALL retain the normalized submitted command ID, selection revision, arguments, and provider. Derived selections, discovery output, and current grants SHALL NOT enter request identity.

After structural/input screening, an already accepted matching request SHALL return its original run before consulting current installations, selections, provider readiness, or MCP services. A different submitted input under the same request ID SHALL conflict. Concurrent acceptance SHALL converge on one authoritative run/binding through the existing uniqueness boundary; a losing candidate snapshot SHALL NOT replace it.

Acceptance SHALL atomically persist the run, normalized input identity, immutable content-addressed snapshot and binding when present, root actor, root startup memberships and `skill.startup` events, initial invocation, creation history, and optional `capability.unavailable` events. A capability-bound root SHALL never exist without all its designated startup memberships and supply events; an empty startup set requires no membership rows. A run SHALL never become visible as accepted with a missing required snapshot. Snapshot keys SHALL remain `sha256(canonical JSON bytes)`; the digest SHALL be verified on every retained read. New runs SHALL revalidate installation integrity and the scopes they use, so later drift cannot silently remove a selection. Whole-bundle integrity failure remains a whole-bundle refusal.

Known pre-acceptance refusal SHALL write no accepted run or model/tool dispatch. MCP discovery is the sole bounded external preflight action permitted here. Uncertain commit acknowledgement SHALL retain the existing `acceptance_unknown` contract and require retrying the same request identity, not inventing a new run.

New-request validation SHALL have this observable order: structural and credential screening; accepted-request lookup/conflict handling; configuration-validation gate; installation and command selection/revision checks when applicable; provider/workspace admission; process-free per-actor resolution, restrictions, startup bounds, and definition screening; bounded MCP discovery; discovery-dependent prerequisite/startup resolution and final snapshot screening/sealing; execution-definition construction; atomic acceptance. A known failure SHALL stop later stages. No MCP process SHALL launch before all applicable process-free checks have passed. A delegate-only unusability outcome is retained rather than treated as a root-admission failure. Accepted-request lookup remains ahead of all current-state checks.

**Rationale / alternative:** Re-resolving configuration before retry lookup would break accepted-request identity after an update. Independent commits for a run and its definitions would create unrecoverable accepted work.

### 8. Startup is actor initialization, not a synthetic tool call

Startup instructions SHALL be supplied in the receiving actor’s system prompt: the fixed root prompt, or the fixed delegate prompt plus retained agent instructions; the existing MCP note when applicable; then a fixed startup preamble and one header/body block per startup skill in retained stable-ID order. The preamble SHALL state: `The following skills are already loaded for this agent. Their instructions grant no additional authority.` Each header SHALL identify the skill ID and originating facet/version; each body SHALL contain the retained instructions verbatim, without trimming or interpolation. Headers and delimiters SHALL use one deterministic, versioned format.

At most eight unique startup skills and 96 KiB of total UTF-8 skill-body bytes SHALL be permitted per actor, excluding runtime-authored headers and preamble, in addition to the existing 48-KiB per-skill bound. No silent truncation or fallback to on-demand loading is permitted. Startup bodies SHALL pass credential/content screening before persistence of public events or model supply. A rejection SHALL identify safe actor/skill references without echoing rejected content.

For version-2 capability runs, the execution definition’s `promptDigest` SHALL cover the assembled root system prompt and `manifest.capabilities` SHALL include `startupProtocol: 1`. Retained delegate instructions/startup bodies are covered by the snapshot digest; prompt assembly behavior is covered by the execution-code and startup-protocol identity. Legacy definition verification SHALL preserve its original formula rather than rewriting stored digests.

There SHALL be no separate actor-initialization table. Actor identity SHALL remain `root` or the delegation operation digest, not the agent name, so separate invocations of one named delegate have independent startup memberships and events.

Loaded-skill membership SHALL retain uniqueness on `(runId, actorKey, skillId)` and the retained definition digest, with an activation union replacing the mandatory operation-only source:

```text
{ kind: "startup", eventKey }
| { kind: "on_demand", operationId }
```

Startup membership SHALL have no tool-operation foreign key. On-demand membership SHALL still require the same actor's successful load operation. Existing memberships SHALL migrate as `on_demand` without changing their meaning. Database constraints SHALL enforce the exclusive source variants, actor ownership, and definition correspondence.

Root startup membership and supply history SHALL commit with acceptance as specified in Decision 7. For a permitted delegate start, its actor, `delegation.started`, all startup memberships, and all `skill.startup` events SHALL commit atomically. The invariant is that an executable actor never exists with a partial startup set. Delegation history SHALL place `delegation.started` before its startup events, and startup events before its first model request.

A retained startup refusal or failed current startup check SHALL atomically record the refused delegation outcome, its capability-refusal history, and the parent tool-operation completion, without creating an executable delegate or any startup membership. It SHALL return safely to the caller rather than fail the containing run by itself.

Per-skill startup event keys SHALL remain `startup:<actorKey>:<skillId>`, unique within a run; a delegate startup refusal SHALL use `startup:<actorKey>:refused`. These namespaces SHALL remain distinct from existing tool-operation event keys. Replays with matching payloads SHALL be idempotent; mismatched retained identities SHALL fail verification.

Model-dispatch admission SHALL verify the complete recorded startup membership and exact reconstruction of the actor’s system prompt, together with applicable current prerequisite/permission checks, before its first request and budget reservation. Startup itself consumes no model step. The prompt SHALL contain one copy of each startup body per assembled request, without appending synthetic graph messages on replay. Compatible continuation SHALL reconstruct it from retained definitions. Recorded supply means prepared instruction supply, not proof of provider delivery or model compliance.

A new load request SHALL check retained availability and applicable permission before loaded membership. For an already loaded skill it SHALL return `outcome: "ok"` with `result: { kind: "already_loaded", skill, version }`, with no body re-insertion. A first on-demand load SHALL return `result: { kind: "loaded", skill, version, text, references }` and retain the existing atomic membership/tool-completion history. The ordinary model request that asked for a load still consumes its normal step; the load introduces no model request of its own. Operation replay retains its existing recorded-outcome semantics.

The actor's frozen loaded-skill membership on a model response SHALL include startup membership, allowing its references to be read from the first response. On-demand sibling load/reference ordering SHALL remain unchanged. Reference reads SHALL continue to use retained bundled bytes, never deployment paths or script execution.

**Rationale / alternative:** A fake tool operation misattributes startup and requires a provider call that did not occur. Prompt-only injection loses durable provenance and reference eligibility. Folding membership and history into actor creation removes a separate initialization transaction and its crash window; dispatch still verifies that the assembled prompt matches the retained startup set.

### 9. Public inspection separates selection, supply, and actual use

The existing endpoints SHALL remain; no selection mutation API is added. `GET /capabilities` SHALL retain the `unconfigured | unavailable | ready` union. A ready response SHALL expose installed contributions/admission outcomes, shared/root/delegate selection sources, per-agent usability and startup configuration, and independent server approvals/grants. Static inspection SHALL start no processes and SHALL label undiscovered tool usability as not verified rather than usable. Installation omissions and unselected items SHALL remain distinguishable from compatibility or permission refusal.

The old flat contribution `allowed` field SHALL be removed rather than retained with ambiguous per-agent meaning. Selection, usability, and authorization SHALL be projected separately.

`catalogRevision` SHALL continue to identify the sealed installation for explicit server discovery. Command `selectionRevision` SHALL instead bind the installation plus the normalized root selection, applicable restrictions, and grant configuration relevant to availability. This prevents a command card from retaining a valid-looking revision across a selection-changing restart. Neither revision is authority. An accepted retry SHALL still return its original run despite a later revision change.

`GET /runs/:runId/capabilities` SHALL use this closed public union:

```text
{ kind: "native", throughSeq }
| { kind: "unavailable", throughSeq, reason }
| { kind: "goal", throughSeq, agents, definitions, permissions, limits, usage }
| { kind: "command", throughSeq, command, agents, definitions, permissions, limits, usage }
```

The goal and command variants SHALL expose retained plans, provenance/admission, startup configuration, recorded startup supply, on-demand loads, delegate invocations, tool calls, and unavailable discovery outcomes separately. `agents` SHALL identify plan keys and actual actor instances; multiple invocations of one named agent SHALL not collapse. Legacy command projections SHALL identify selection provenance as legacy rather than invent shared/individual sources. Current independent permission refusals SHALL be distinguished from captured availability. Internal checkpoint state, credential values, and unscreened bodies SHALL not enter these projections.

Startup history SHALL add a typed activity `skill.startup` with actor reference, skill ID, originating facet/version, and retained admission/selection provenance. It SHALL precede the receiving actor's first recorded model request and message. Inspection SHALL use one consistent store view through `throughSeq` for bindings, actor records, membership, operations, and history. It SHALL not infer use from availability, use from configured startup alone, or instruction compliance from recorded supply.

Admission errors SHALL use the existing credential-safe error envelope and status mapping:

| Condition | Mapping |
|---|---|
| Invalid operator schema, old fields, unresolved startup-time facet/delegate reference | Startup configuration refusal with field/scope/reference; no accepting service |
| Changed command selection revision | `409 capability_selection_changed` |
| Selected contribution, prerequisite, or startup selection unusable; startup bounds exceeded | `409 capability_unavailable`, safe actor/skill subject and reason in the explanation |
| New-run facet reference invalidated after startup | `409 capability_unavailable`, affected scope/reference identified |
| Unreadable, invalid, or mismatched sealed installation | `503 capabilities_unavailable` |
| Required MCP discovery unavailable | `503 mcp_server_unavailable` |
| Optional MCP discovery unavailable | Accepted run with retained unavailable outcome and acceptance-time history event; no whole-run error |
| Delegate startup unusable | Recorded delegate `{ kind: "refused", reason, message }` |
| Confirmed incompatible retained/checkpoint state on answer | `409 continuation_unavailable`, answer not accepted |
| Temporary inability to verify storage/state | Existing retryable verification/storage error, not confirmed incompatibility |

Diagnostic reasons SHALL include `facet_reference_unresolved`, `delegate_unknown`, `delegate_unreachable`, `startup_skill_unavailable`, `too_many_startup_skills`, `startup_instructions_too_large`, `command_not_selected`, `prerequisite_unavailable`, and `installation_format_unsupported`. Startup diagnostics and retained usability/refusal records SHALL carry these machine-readable reasons. Public admission errors SHALL retain the existing envelope and HTTP codes, with the safe reason and affected scope/subject explained in the message; this change SHALL NOT add an unversioned error-envelope field. Optional unavailable outcomes SHALL be visible in both run history and capability inspection.

The console SHALL render the same model for goal and command runs, with command details only in the command variant. Installed/configured/loaded/used labels SHALL not be conflated. Rendering remains plain text.

**Rationale / alternative:** Keeping goal responses `native` would hide the principal new capability path. A single ready/refused flag cannot express installation, selection, authorization, and actual activation accurately.

### 10. Compatibility preserves records, not a promise to resume changed execution

Version-1 command snapshots and native runs SHALL remain readable without current installation access. For a legacy snapshot, retained skill/agent availability SHALL remain its captured flat lists and explicit restrictions, not current shared/per-agent selection. Current independent MCP grants SHALL still constrain new dispatch. No new startup designations SHALL be applied to a legacy run.

Continuation SHALL still require supported retained formats, exact saved execution-definition compatibility, valid actor/checkpoint bindings, and the original provider/workspace binding before accepting an answer. A version-2 continuation SHALL use retained plans and startup memberships; current selection SHALL not change its execution definition. Startup/skill protocol changes SHALL participate in the execution-definition digest.

This upgrade necessarily changes common execution roots and their import closure, including agent assembly, run-store behavior, and capability authority (`packages/runtime/src/execution/code-manifest.ts:23–45`). Therefore runs waiting under the current pre-upgrade build will fail the exact execution-definition check after this upgrade as `continuation_unavailable` with `definition_changed`, even though their snapshots remain readable. Guidance SHALL tell the owner to finish or cancel waiting work before upgrading. The implementation SHALL NOT bypass the check or rewrite recorded digests to manufacture compatibility.

A legacy run that genuinely passes all compatibility checks SHALL continue under its retained flat availability and current independent MCP restrictions; snapshot version alone SHALL NOT cause dispatch refusal. Tests SHALL distinguish this conditional legacy contract from the actual pre-upgrade incompatibility assessment. Same-build selection changes during a pause SHALL preserve compatibility because current selections are not substituted into retained definitions.

Persistence evolution SHALL use the next forward migration, currently 006, leaving previous migration text/checksums intact. It SHALL accept snapshot v1 and v2 under their separate closed key sets; permit goal or command inputs in version-2 run-capability bindings with matching start modes; extend actor/delegation consistency checks to capability-bound goal runs; add the exclusive startup/on-demand membership source and nullable operation reference; and register `skill.startup` and `capability.unavailable` event payloads and source-key consistency checks. Root startup completeness SHALL be enforced with acceptance, and delegate startup completeness with executable delegate creation. Existing memberships SHALL retain their original on-demand meaning. Historical snapshots and events SHALL NOT be rewritten, re-digested, or supplied with invented startup/selection provenance.

**Rationale / alternative:** A blanket historical-data rejection would lose useful inspection; a blanket resume guarantee would require unsafe code-identity bypasses or a separate legacy execution engine. This change retains the existing conservative compatibility boundary.

### 11. Verification proves real installation and deterministic context before live behavior

Fast unit checks SHALL cover no-settings equivalence for command/skill/agent, explicit restriction refusal, configuration normalization/migration errors, per-agent selection and provenance, dependency usability, startup limits, permission narrowing, and the tagged public/retained records. Test fixtures SHALL use the adapter's actual installer metadata shape, including identity-only metadata; no authored presence marker is introduced.

Service/API tests SHALL cover both providers through deterministic model adapters: goal and command parity, the root's exact first-request startup body, on-demand-only catalog behavior, shared startup on separate actors, root-only delegate exclusion, delegate-only skills under caller restrictions, already-loaded results, and bundled-reference eligibility. They SHALL prove commands and instructions cannot expand authority. Optional MCP outages and name collisions SHALL not fail unrelated goals; required failures and current revocations SHALL prevent dispatch.

Process/persistence tests SHALL prove atomic startup history/membership, replay and concurrent acceptance/delegate creation, request retries after configuration changes, delegate first use after pause, selection removal versus independent grant revocation, retained inspection after uninstall, and compatible/incompatible continuation. Model/tool budget and uncertain external-dispatch behavior SHALL remain covered. Finite deadlines SHALL use injected clocks/failures, not slow timeout sleeps.

Explicit cases SHALL cover same-build selection/startup changes during a human pause, v1 snapshot inspection after upgrade, actual pre-upgrade execution-digest rejection, native goals with empty selections and no MCP/installation access during admission, invalid startup designations refusing rather than falling back to native, optional discovery failures appearing in acceptance history, and current prerequisite revocation before a delegate’s first model request.

The installation proof SHALL use the published `voice-to-text` facet unchanged, materialized with the pinned CLI and updated runtime adapter in the independent runtime project. Its resolved version/integrity and manifest/lockfile SHALL establish identity; deterministic captured requests SHALL be compared with the actual exported installed body, not a rewritten synthetic substitute. Bundled references, if present, SHALL retain their installed bytes. Separate configurations SHALL prove root-only startup/delegate exclusion and shared selection/startup. This work SHALL NOT modify editor installations or imply production selection.

Browser coverage SHALL remain a handful of built-console smoke checks for starting a goal and seeing startup/selection provenance, not a behavior matrix. UI projections and rendering branches SHALL primarily use component/data-pattern tests. The existing single version-pin snapshot remains the only pin test; no new pin assertion suite is required.

A separately approved live journey SHALL use a bounded dictated-text task, explicit provider and step budget, and inspectable outcome/provenance. Useful text interpretation is live evidence; deterministic tests establish instruction supply and isolation. Deployment, production installation/configuration/grant edits, owner-state operations, and provider traffic SHALL each remain approval-gated. Owner authentication SHALL remain browser-only. Any failed verification SHALL stop the work for reporting; automatic repair or rerun is excluded.

**Rationale / alternative:** A synthetic fixture alone cannot prove the published facet installs unchanged. A live model outcome alone cannot prove startup context or isolation and is unsuitable as the primary regression test.

## Risks / Trade-offs

- **Facet-level selection exposes more than a former single-item allowlist** → Migration SHALL enumerate additional contributions and use installation materialization choices or narrower selection where necessary; it SHALL not call the expansion equivalent.
- **Shared startup is additive and consumes context in every actor** → Document the lack of per-agent subtraction, retain both selection sources, and enforce finite per-actor bounds without truncation.
- **Optional discovery adds startup latency and freezes an outage into one run** → Bound concurrency/time, retain reasons, and require a new run for newly available definitions; do not bind later replacements silently.
- **Startup records cannot prove provider delivery or compliance** → Commit prepared supply with actor creation, verify its prompt before dispatch, and retain ordinary model-attempt evidence separately.
- **Caller restrictions and per-agent selection can be accidentally conflated** → Keep separate resolution/authority models and test delegate-only skills alongside denied delegate MCP tools.
- **This upgrade invalidates pre-upgrade waiting execution definitions** → Publish the assessed incompatibility, preserve history, rehearse refusal and same-build continuation, and finish or cancel waiting work before upgrading.
- **Installed prompts remain untrusted content** → Retain existing content screening and dispatch boundaries; portable admission grants no authority or script execution.
- **A bundle fault prevents startup reference validation** → Fail explicitly without modifying retained state; restore a valid configuration/bundle before serving work. No degraded-readiness mode is introduced.
- **Startup prompt changes alter continuation identity** → Digest the assembled root prompt and retain delegate bodies in the snapshot; this is intentional compatibility enforcement, not a reason to bypass it.

## Migration Plan

1. **Prepare without touching production.** Implement versioned decoders, new-run resolution, persistence migration, activation, and projections together. Validate existing history decoding and deterministic behavior with disposable storage/installations. Re-export with the updated adapter and reseal; do not hand-edit exports or convert old refusals into ready definitions.
2. **Prepare explicit operator migration.** Replace old flat lists with reviewed shared/root/delegate facet scopes and independent startup IDs. Preserve server/program approvals, tool digests, credentials, and argument restrictions unchanged unless separately approved. Review materialized extra contributions. Pin the new sealed digest. The published voice facet belongs to the independent runtime manifest/lockfile, never an editor copy. Re-materialization, resealing, and removal of superseded configuration fields SHALL be complete before restarting the upgraded runtime; otherwise startup validation SHALL refuse.
3. **Document the compatibility matrix.** New starts require installation format 3/profile 2 and the new configuration. Native/no-capability starts remain native. Snapshot v1 and v2 history is readable. Waiting work resumes only when its original execution/checkpoint binding passes verification; this upgrade’s pre-upgrade waiting runs are incompatible and SHALL be finished or cancelled beforehand. Selection removal affects new runs, whereas independent server/tool revocation constrains accepted work.
4. **Run non-live verification and report once.** Use unit, service/API, process, facet-install, and minimal console smoke coverage. Keep suites serial where the existing check pipeline requires it. Stop on any failure. Record actual published-facet provenance and context/isolation evidence before seeking live approval.
5. **Deploy only with separate approval.** Back up storage and the coherent image/configuration/sealed-bundle set, settle important waiting runs, apply the forward migration, and restart with validated configuration. A live smoke run and production facet/grant changes require their own approval; this design creates no authorization for them.
6. **Rollback as a coherent set.** Configuration-only removal of capabilities SHALL stop new facet-backed work without deleting history or restoring revoked tools. An older binary may refuse the newer database migration; image rollback SHALL therefore use a separately approved pre-migration backup/restoration strategy, not a destructive down migration or old code pointed at unsupported state. Data accepted after the backup SHALL not be discarded without explicit owner approval.

### Documentation alignment

There are no files under `docs/` in the inspected tree. Existing user-facing documentation conflicts directly with this design and SHALL be updated within implementation scope:

- Root `README.md`: Capability configuration (`:283`) currently says goals never use grants and advertises flat lists; Runtime facets (`:327`) requires author opt-in; Authority boundaries and Agent execution describe the command-centric boundary. Replace these with selection/activation/authorization, portable admission, per-agent narrowing, bounds, and discovery policy.
- Root `README.md`: Persistence (`:173`), Browser console and API (`:587`), Runtime facets in a deployment (`:802`), upgrade/rollback and troubleshooting SHALL explain new record/projection variants, startup supply, stale selection errors, selection versus revocation, and conditional continuation. The API table SHALL stop labeling every goal `native`.
- `deploy/runtime/facets/README.md`: replace mandatory-runtime-block/refused-without-metadata wording, document actual-settings validation and unchanged other-tool semantics, describe re-export/reseal format migration, startup limits, and reads for all configured new runs. Update the empty-installation statement only when the real installation is recorded.
- `deploy/runtime/config.capabilities.example.json`: show the new selection structure, root-only and shared startup choices, named delegates, and unchanged independent grants; omit superseded fields. Examples SHALL distinguish placeholders from a production-approved configuration.
- `architecture/09-data-model-and-lifecycle.md`: update the as-built capability record and lifecycle sections for goal bindings, startup/on-demand membership sources, actor-creation atomicity, and capability-bound delegation. Preserve historical descriptions as historical rather than presenting command-only restrictions as the current contract.
- `deploy/runtime/facets/facets.json` and `facets.lock`: record the published proof installation’s actually resolved version and integrity. The version SHALL be verified during installation rather than copied from an unverified planning claim.
- Root `README.md`: explicitly revise “Delegation (command runs only)”, “Skills (command runs only)”, and “Goal runs have no delegation”; clarify which empty-selection goals remain native and when an unreadable configured bundle prevents startup validation.

Documentation SHALL link to main specs or active local documentation, never archived change paths. No roadmap reopening or memory work is included.
