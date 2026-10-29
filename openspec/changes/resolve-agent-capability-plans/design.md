# Design

## Context

See [proposal.md](./proposal.md#why) for the reason for this change.

The current runtime uses global capability selections and retains capability snapshots for command runs. Its supplied native-goal path does not use that binding.

This change defines independent agent plans and the common retained capability representation. It extracts the settled resolution and preparation contracts from the original change.

It is item 03 in the [release roadmap](../ROADMAP.md).

## Goals / Non-Goals

**Goals:**

- Resolve independent agent configurations into exact retained plans.
- Keep goal and command preparation consistent.
- Preserve authored restrictions and independent tool policy.
- Prepare bounded startup content without execution side effects.
- Provide inspectable availability and refusal reasons.

**Non-Goals:**

- The serialized owner configuration file.
- Session conversation, membership, or checkpoint records.
- Atomic run acceptance and child execution.
- Owner-selection history or request-time session reconciliation.
- Removal of message limits before operational monitoring.

## Decisions

### 1. Resolve each agent from its own validated configuration

Owner configuration MUST supply each agent's identity, instructions, selected facets, startup skills, and permitted task targets.

The owner configuration change defines its serialized form. This change MUST NOT introduce another configuration file or a special root-agent type.

Each configured identity MUST remain distinct from an installed-agent contribution identity. Matching text MUST NOT create an instruction binding or delegation relationship.

Selections and startup skills MUST NOT be inherited from another agent.

Facet references MUST resolve through the recorded installation's identities, aliases, and omissions. Each reference MUST identify exactly one installed facet.

A selected facet MUST contribute all its installed, materialized contributions as candidates. Additional per-agent server, tool, skill, or command allowlists MUST NOT be introduced.

Candidate status MUST remain subject to compatibility, prerequisites, independent grants, resource restrictions, and interaction mode.

Repeated facet and startup references MUST resolve once in deterministic order.

Each agent MUST retain the approved maximum of 128 facet references. Its configured instruction body MUST retain the 48-KiB bound.

Configured-agent lists, permitted-entry sets, and delegation-target lists MUST NOT acquire separate fixed count limits.

Every task target MUST identify a configured agent. An absent or empty target list MUST permit no task delegation.

The target list MUST describe only that agent's outgoing relationships. It MUST NOT constrain descendants by requiring all their targets in an ancestor's list.

The permitted-entry set and default MUST remain separate from individual agents. Every entry reference MUST resolve, and the default MUST belong to that set.

The supplied ordinary agent MUST have empty facet, startup-skill, and task-target lists. The supplied entry policy MUST permit it and select it as the default.

Maximum delegation depth MUST remain a run-level setting. Omission MUST resolve to 2; explicit zero MUST remain valid.

Depth MUST be a non-negative safe integer without another policy maximum. Negative, fractional, non-finite, or inexact values MUST be rejected without rounding or clamping.

Plans MUST NOT contain a delegation-call counter or create a new model-step budget.

An invalid reference MUST produce a safe refusal identifying the agent, field, reference, and cause. Resolution MUST NOT fetch assets, substitute a target, or silently drop the reference.

**Rationale:** Independent configuration separates an agent's identity from its position in a run.

**Rejected alternatives:** Shared selections add implicit inheritance. Ancestor-wide target intersections would prevent a delegate from using its own approved outgoing relationships.

### 2. Use one closed retained-plan and snapshot representation

The runtime MUST use these closed shapes:

```text
CapabilitySnapshot = {
  installation:
    { kind: "none" }
    | { kind: "sealed", sha256: Digest },
  entryAgentId: AgentId,
  start:
    { kind: "goal" }
    | {
        kind: "command",
        definition: CommandDefinition,
        arguments: string,
        renderedGoal: string
      },
  agents: AgentPlan[],
  definitions: {
    skills: SkillDefinition[],
    agents: InstalledAgentDefinition[],
    commands: CommandDefinition[],
    servers: ServerDefinition[],
    tools: BoundTool[]
  },
  discovery: DiscoveryResult[],
  authority: CapturedAuthority,
  restrictions: {
    source: {
      kind: "command",
      id: CommandId,
      exportDigest: Digest
    },
    restrict: Restriction
  }[],
  limits: {
    maxDelegationDepth: NonNegativeSafeInteger
  }
}

AgentPlan = {
  agentId: AgentId,
  instructions: string,
  facets: Origin[],
  startupSkills: SkillId[],
  delegationTargets: AgentId[],
  candidates: {
    skills: SkillId[],
    agents: InstalledAgentId[],
    commands: CommandId[],
    tools: Digest[]
  },
  availability: {
    task: CandidateResolution[],
    discussion: CandidateResolution[]
  },
  definitionDigest: Digest
}

CandidateResolution = {
  subject:
    { kind: "skill", id: SkillId }
    | { kind: "agent", id: InstalledAgentId }
    | { kind: "command", id: CommandId }
    | { kind: "tool", toolKey: Digest },
  result:
    { kind: "usable" }
    | { kind: "unusable", reason: ReasonCode }
}

DiscoveryResult =
  {
    kind: "bound",
    serverId: ServerId,
    toolKeys: Digest[]
  }
  | {
      kind: "unavailable",
      serverId: ServerId,
      reason: "server_unavailable" | "tools_unavailable",
      affectedAgents: AgentId[]
    }

RunCapabilityBinding = {
  runId: UUID,
  submittedInput: SubmittedStart,
  entryAgentId: AgentId,
  snapshotDigest: Digest,
  limits: {
    maxDelegationDepth: NonNegativeSafeInteger
  }
}
```

All objects MUST reject unknown fields.

`Digest` MUST contain 64 lowercase hexadecimal SHA-256 characters. Existing run, contribution, operation, and actor identifiers MUST retain their applicable validators.

Configured-agent and installed-agent identifiers MUST occupy separate namespaces, even when their text matches.

Origins, resources, and definition bodies MUST reuse their validated shapes. Text definitions MUST contain the admission record from the portable-admission change.

The snapshot MUST retain every configured agent once, including the entry agent and configurations outside the task graph.

Each candidate MUST have one resolution for each mode. These resolutions MUST describe preparation-time prerequisites, not unconditional permission for every later invocation.

Every startup ID MUST identify a selected skill resolution. Every usable reference MUST resolve to an exact retained definition.

Candidate lists MUST be derived from facet selections. They MUST NOT become editable owner allowlists.

Plans MUST be sorted by `agentId`. Definitions MUST be sorted by typed stable identity. Resource lists MUST be sorted by path.

Set-like arrays MUST be sorted and deduplicated before sealing. Tool argument arrays MUST NOT be reordered.

The plan digest MUST be:

```text
H({
  kind: "configured-agent",
  plan: <all AgentPlan fields except definitionDigest>
})
```

The snapshot digest MUST cover the complete canonical snapshot. `H` MUST use runtime canonical JSON, UTF-8, and no trailing newline.

With `installation.kind: "none"`, all installed-definition arrays and facet selections MUST be empty. Preparation MUST NOT read an installation or start MCP discovery.

Every accepted run MUST use this snapshot and binding contract. There MUST NOT be an unbound native-goal path or separate native-only configuration record.

Binding fields MUST agree with the snapshot and submitted start. The session change owns their atomic persistence with run and session creation.

Definitions MUST remain immutable for the accepted run. Later deployment configuration or installation changes MUST NOT replace them.

Shape, reference, canonical encoding, and digest checks MUST remain effective without a fixed configured-agent count or aggregate snapshot ceiling.

Operational monitoring MUST precede removal of existing size enforcement. The capacity change owns that release gate.

**Rationale:** One representation preserves native and facet-backed configurations without separate retention rules.

**Rejected alternatives:** A command-only snapshot excludes goal runs. Retaining only task-reachable agents loses permitted discussion targets. A nullable command permits contradictory start records.

### 3. Keep retained authority separate from candidate selection

Bound facet tools MUST use this closed shape:

```text
BoundTool = {
  serverId: ServerId,
  toolName: ToolName,
  raw: JsonObject,
  definitionDigest: Digest,
  adapted: {
    name: string,
    description: string,
    schema: JsonObject
  },
  toolKey: Digest,
  origin: Origin,
  classification: ClassificationRef
}
```

`raw`, `adapted`, server identity, and tool name MUST retain their supported validation rules.

The definition digest MUST identify the reviewed raw definition. The adapted name MUST equal the canonical facet-tool name.

`origin` MUST identify the installation-selected facet and version. `toolKey` and `classification` MUST agree with that exact structured identity and reviewed definition.

Native classifications MUST remain in the execution manifest. The snapshot MUST NOT represent native tools as MCP records.

Captured authority MUST use this shape:

```text
CapturedAuthority = {
  native: NativeGrant[],
  skills: SkillId[],
  agents: {
    agentId: AgentId,
    delegationTargets: AgentId[]
  }[],
  servers: {
    serverId: ServerId,
    serverDigest: Digest,
    tools: {
      name: ToolName,
      definitionDigest: Digest,
      argumentEquals: Record<string, Scalar>
    }[]
  }[]
}
```

`NativeGrant` and `Scalar` MUST reuse the existing validated native-grant and argument-value vocabularies. Canonical exposed names MUST NOT change a grant's meaning.

Server approval digests, tool-definition digests, and argument restrictions MUST remain effective.

The `agents` collection MUST retain configured identities and explicit outgoing edges. It MUST NOT become a flat global delegation allowlist.

The `skills` collection MUST describe retention bounds, not another owner selection list.

Captured authority MUST NOT contain a fixed configured-agent count or delegation-call count.

Applicable current grants MUST constrain retained authority. Captured and current argument restrictions MUST both pass before dispatch.

A caller's unselected facets or omitted outgoing targets MUST NOT become inherited denials against a target's own configuration.

Authored `restrict.native`, `restrict.skills`, and `restrict.mcp` MUST retain their supported meanings.

An absent category MUST add no restriction. An explicit empty category MUST deny that category.

Command restrictions MUST apply throughout the run, including consultations. Facet selection alone MUST NOT activate installed-agent instructions or their restrictions.

This version MUST NOT bind installed-agent definitions to independently configured agents.

An explicit installed-agent prerequisite or nonempty authored `restrict.agents` MUST fail closed as `authored_agent_binding_unsupported`.

A matching configured name MUST NOT satisfy the reference. The runtime MUST NOT remove the restriction to make the contribution usable.

An explicit empty `restrict.agents` MUST prohibit both task delegation and discussion within its scope.

For goal starts, the snapshot's command-restriction collection MUST be empty.

For a command with explicit restrictions, it MUST contain exactly one entry matching the command ID, export digest, and normalized restrictions.

For a command without restrictions, that collection MUST be empty.

Each applicable restriction MUST be evaluated independently. No optional instruction-source reuse is introduced by this change.

**Rationale:** Facet selection determines candidates. Retained grants, current revocations, source restrictions, and interaction mode determine whether execution is permitted.

**Rejected alternatives:** Inheriting a caller's selected catalog would erase the target's independent capabilities. Matching configured and installed agent names would discard unsupported authored semantics.

### 4. Preserve submitted choices separately from resolved defaults

Submitted starts MUST use this closed shape:

```text
SubmittedStart = {
  workspaceId: UUID,
  provider: Provider,
  entry:
    { kind: "default" }
    | { kind: "explicit", agentId: AgentId },
  budget:
    { kind: "default" }
    | { kind: "explicit", steps: StepBudget },
  start:
    { kind: "goal", goal: string }
    | {
        kind: "command",
        id: CommandId,
        selectionRevision: Digest,
        arguments: string
      }
}
```

Provider and budget values MUST retain their existing validators.

The submitted-input digest MUST be:

```text
H({
  kind: "run-start",
  input: SubmittedStart
})
```

The owner creation request ID MUST remain the uniqueness key. It MUST NOT be part of this digest.

Submitted text MUST retain its bytes after validation. It MUST NOT be trimmed or replaced with rendered command text for identity calculation.

Omission MUST remain distinct from an explicit value equal to the current default.

Explicit null for optional entry or budget fields MUST be invalid, not omission.

Derived agent selections, resolved defaults, discovery output, and current grants MUST NOT enter the submitted-input digest.

A start MUST identify an owner-registered workspace by ID, not by host path. A console-selected default workspace MUST still be submitted explicitly.

After structural and credential checks, accepted-request lookup MUST precede current configuration, installation, provider-readiness, and MCP checks.

An equal accepted retry MUST return its original run. Changed submitted input under the same creation request ID MUST produce `request_conflict`.

Capability preparation MUST NOT replace the winning snapshot or resolve current defaults again for an accepted retry.

The final acceptance transaction belongs to the session change. It MUST recheck the workspace gate, authoritative workspace policy, and observed registry revision.

A gate closure after preflight MUST prevent acceptance with `workspace_unavailable`.

A classification or catalog change after preflight MUST reject the candidate with `capability_selection_changed`.

Equal concurrent submissions MUST converge on one authoritative run and binding. An unconfirmed commit MUST preserve `acceptance_unknown` and require identical retry.

A prepared candidate without accepted references MUST NOT trigger execution or be reported as accepted work.

**Rationale:** Submitted identity must survive changes to defaults and deployment configuration.

**Rejected alternatives:** Hashing resolved defaults breaks accepted retries after configuration changes. Treating explicit null as omission conceals malformed input.

### 5. Resolve capabilities through bounded, authorized preflight

Goal and command preparation MUST use the same configured capability model.

A command MUST add its retained definition, arguments, prerequisites, and narrowing restrictions. It MUST NOT add facets, task targets, or grants.

A snapshot with no installed facet data MUST NOT require an installation read or MCP discovery.

An entry startup designation without the required selected facet MUST fail as `startup_skill_unavailable`. It MUST NOT fall back to native operation.

An empty entry selection MUST NOT make an installed command selectable.

After the accepted-request lookup, new-request preparation MUST preserve this observable order:

1. Configuration validation, including entry-policy references and default membership.
2. Entry resolution and eligibility, followed by applicable installation, command, and selection-revision checks.
3. Provider and workspace admission.
4. Process-free availability checks, including policy, modes, resource restrictions, startup bounds, and definition screening.
5. Bounded MCP discovery.
6. Discovery-dependent prerequisite and startup checks, followed by snapshot screening and sealing.

The session change owns subsequent execution-definition construction and atomic acceptance.

A known failure MUST stop later stages. An MCP process MUST NOT start before applicable process-free checks pass.

Discovery candidates MUST account for permitted task and discussion contexts. They MUST satisfy server and program approval, explicit tool policy, resource restrictions, and at least one applicable tool grant.

The runtime MUST NOT contact unselected, unapproved, denied, unsupported, or statically restricted servers.

A server excluded from every permitted invocation context MUST NOT become a candidate.

Owner inspection with discovery-only approval MUST remain a separate operation.

Discovery MUST initialize the server, list its tools, and close the connection. It MUST NOT call a tool.

Discovery MUST obey the configured placement, workspace gate, process restrictions, and lifecycle controls. The workspace and approval changes own those enforcement contracts.

The existing page and tool limits MUST remain effective. The time limits MUST be:

| Bound | Value |
|---|---|
| Per-server discovery deadline | 15 seconds |
| Overall discovery deadline | 15 seconds |
| Concurrent inspections | At most 2 |

Candidate order MUST be deterministic. Required entry prerequisites MUST precede optional candidates.

On deadline expiry, the runtime MUST cancel and close incomplete discovery sessions.

Only supported, granted tool definitions matching their approved digests MUST become callable candidates.

Name collisions MUST exclude every conflicting tool rather than select a winner. Discovery MUST preserve the installation-selected origin.

Optional failures MUST affect only the relevant server, tool, or contribution. They MUST NOT reject an otherwise valid goal or command.

An unavailable explicit prerequisite of the selected command or entry startup MUST reject the start.

A prerequisite failure affecting an on-demand skill, delegate, or discussion context MUST remain scoped to that use. It MUST NOT grant extra authority to make that context usable.

Prepared optional-unavailability facts MUST use:

```text
{
  subject: string,
  reason: ReasonCode,
  affectedAgents: AgentId[]
}
```

The subject MUST be `mcp:<serverId>` or `mcp:<serverId>/<toolName>`. A full-server failure MUST produce one server fact, not one fact per tool.

Affected agent IDs MUST be sorted and unique. The history source key MUST be:

```text
capability-unavailable:<H({ subject, reason, affectedAgents })>
```

The session change MUST commit these facts as `capability.unavailable` events within acceptance. They MUST NOT be reported as tool calls or evidence of use.

Later discovery MUST NOT add bound tools to an accepted run. A recovered optional server requires a new run for newly available definitions.

Successful discovery MUST NOT replace dispatch-time definition, grant, mode, and resource checks.

**Rationale:** Bounded preflight makes optional unavailability explicit while preserving immutable accepted definitions.

**Rejected alternatives:** Command-only discovery excludes goal runs. Lazy catalog expansion changes accepted definitions. Treating every optional outage as fatal creates undeclared prerequisites.

### 6. Prepare startup content from exact retained skill definitions

Startup preparation MUST use the selected retained plan's startup IDs and matching retained skill definitions.

It MUST NOT read replacement bodies from the current installation or create independently mutable copies of those definitions.

Startup IDs MUST be unique and sorted by stable skill ID.

The prepared startup content MUST use this exact preamble:

`The following skills are already loaded for this agent. Their instructions grant no additional authority.`

Each skill header MUST identify its skill ID, origin facet, and installed version. Headers and delimiters MUST use one deterministic format.

Each body MUST contain the retained instructions verbatim. The runtime MUST NOT trim, interpolate, summarize, or truncate it.

The approved bounds MUST remain:

| Bound | Value |
|---|---|
| Unique startup skills for the selected agent | At most 8 |
| Each skill's instruction body | At most 48 KiB |
| Combined startup bodies | At most 96 KiB of UTF-8 text |

The combined-body measurement MUST exclude runtime headers and the preamble. These bounds MUST NOT become cumulative conversation-history limits.

A required startup set that cannot satisfy the applicable checks MUST be refused as a complete set. The runtime MUST NOT omit a skill or fall back to on-demand supply.

Startup bodies MUST pass credential and content screening before public history or model supply. Refusals MUST identify safe agent or target references, affected skills, and the reason without exposing rejected content.

Preparation MUST NOT execute scripts, dispatch a model request, or consume a model step.

The final prompt MUST place startup content after the runtime role and mode instructions, depth-awareness block, applicable session catalog, and applicable MCP note.

The session change owns final prompt assembly, prepared-request capture, and startup membership.

It MUST commit new-session creation, initial execution, complete startup supply, and creation history atomically. This preparation contract MUST NOT introduce a separate commit for startup membership.

Later turns and owner selection changes MUST use the session change's history and eligibility rules. Preparing a required set MUST NOT itself cause duplicate body insertion.

The snapshot digest MUST cover retained agent instructions and startup bodies. The execution-code identity MUST cover assembly behavior.

Prepared instruction supply MUST NOT be presented as proof of provider delivery or model compliance.

**Rationale:** Exact retained bodies and deterministic preparation preserve reproducibility without turning startup into a synthetic tool call.

**Rejected alternatives:** Loading all selected skills defeats explicit activation. Truncation and on-demand fallback conceal an unusable required startup set.

### 7. Keep prepared availability distinct from accepted execution

Capability inspection MUST identify each configured agent's instructions, facet selections, startup designations, and outgoing task targets.

It MUST distinguish installed, selected, unselected, unusable, and not-yet-verified contributions where applicable.

Portable admission, explicit runtime settings, known refusals, independent grants, and actual execution MUST remain separate facts.

Inspection MUST be available without starting a run. Reading prepared availability MUST NOT itself dispatch model work or perform discovery.

Safe projections MUST NOT expose credentials, environment values, credential slots, private deployment paths, checkpoints, or complete retained snapshot bodies.

The existing catalog states MUST remain `unconfigured`, `unavailable`, and `ready`.

A configured-native catalog MAY be `ready` with no installation and no commands. An unavailable required installation MUST NOT be disguised as an unconfigured native catalog.

The ambiguous flat `allowed` field MUST be removed from the new projection. Independent grant inspection MUST remain available.

Large collections MUST use the shared bounded-page contract rather than fixed agent or invocation count limits.

The owner configuration change owns the pre-run route and cursor integration. The session change owns historical views, watermarks, usage, and actual instruction-supply provenance.

Command selection revisions MUST use:

```text
selectionRevision = H({
  kind: "command-selection",
  installation,
  commandId,
  entryAgentId,
  workspaceId,
  executionPolicyRevision,
  configurationDigest,
  authorityDigest,
  registryRevision
})
```

`configurationDigest` MUST cover normalized agent configurations, entry policy, and depth setting.

`authorityDigest` MUST cover approved server and program identities, definition grants, and argument restrictions. It MUST NOT contain secret values.

`registryRevision` MUST change when registered definitions or classification heads change.

Dynamic workspace gate state MUST NOT enter the command-selection digest. Admission MUST check the live gate separately.

Equivalent structured data MUST produce the same digest regardless of object insertion order.

Command availability MUST use the selected entry agent and workspace context. Omitted inspection choices MAY use current defaults.

Invalid explicit choices MUST fail without fallback. Selecting a command MUST NOT select another entry agent.

A selection revision MUST NOT be reported as proof of acceptance, dispatch permission, startup supply, or instruction compliance.

**Rationale:** Context-bound revisions detect stale command choices without confusing a temporary workspace hold with changed definitions.

**Rejected alternatives:** A single allowed flag hides different refusal causes. Including live gate state in selection identity would conflate admission with capability definition changes.

## Verification

Verification MUST cover these boundaries:

| Boundary | Required evidence |
|---|---|
| Independent plans | Agents resolve only their own selections and outgoing targets. Repeated references do not duplicate candidates or startup bodies. |
| Entry policy | Every permitted entry resolves, the default belongs to that set, and invalid policy causes refusal without fallback. |
| Depth policy | Omission yields 2. Zero and larger safe integers remain valid. Invalid numbers are not rounded or clamped. |
| Retained catalog | Every configured agent is retained once, including non-task targets. Native-only plans use the normal binding without installation access. |
| Closed records | Unknown fields, inconsistent references, incorrect hashes, and contradictory start variants fail validation. |
| Restrictions | Empty denials remain distinct from omission. Unsupported authored-agent bindings fail closed. Caller selection omissions do not become inherited denials. |
| Tool policy | Bound tools preserve raw definitions, selected origins, reviewed digests, immutable classifications, and independent grants. |
| Discovery | Only eligible servers are contacted. Discovery is bounded, deterministic, and never calls a tool. Optional failures remain scoped. |
| Startup | Exact bodies, stable order, provenance, and the approved byte/count bounds remain intact. Preparation causes no model dispatch or script execution. |
| Start identity | Omitted and explicit choices remain distinct. Submitted text remains unchanged. Accepted retries do not depend on current defaults. |
| Inspection | Prepared availability does not imply use. Context-bound command revisions change for relevant configuration and policy changes, not live gate state. |

Tests MUST use deterministic provider and discovery substitutes. Deadline tests MUST inject clocks and outcomes rather than wait for discovery timeouts.

Canonical test vectors MUST distinguish runtime hashes without a trailing newline from adapter file encodings.

Large-catalog tests MUST preserve complete content without introducing another configured-agent or aggregate snapshot limit.

The deterministic facet proof MUST prepare startup content from the unchanged published `voice-to-text` installation.

It MUST verify separate selections for two agents, exclusion from an unselected agent, and independent startup preparation when both select the skill.

These tests MUST NOT use an editor skill copy as the runtime source.

The session change owns integrated first-request, durable startup-history, nested-execution, and live-behavior verification.

A verification failure MUST stop work. Repair or rerun requires owner approval.

## Risks / Trade-offs

- **Selection becomes authority:** Keep candidate resolution separate from grants, restrictions, mode, and critical approval.
- **A caller's catalog becomes the target's ceiling:** Resolve each target independently and retain only applicable execution restrictions.
- **Configured names replace authored references:** Keep the namespaces separate and refuse unsupported bindings.
- **Discovery expands accepted definitions later:** Bind its results at acceptance; require a new run for newly available tools.
- **Optional failures reject unrelated work:** Record scoped unusability and reject entry only when its required inputs fail.
- **Large catalogs exhaust resources:** Preserve accurate failures and the monitoring-first capacity policy without silent truncation.
- **Startup preparation appears to be durable supply:** Keep preparation separate from the session change's atomic history and membership contract.
- **A split acceptance transaction exposes partial state:** Require the session change to commit the complete accepted state atomically.

## Migration Plan

The owner configuration change MUST provide validated independent agents, entry policy, and depth configuration.

Superseded flat selections and delegation-count settings MUST be refused through that change's migration guidance. They MUST NOT be silently converted into broader selections.

The runtime MUST use one current retained-plan representation. It MUST NOT add old-record decoders, format-version selectors, or a separate native-only binding.

The reset change owns removal of disposable earlier records and creation of the completed current schema. This change MUST NOT execute that reset.

The session change MUST integrate the prepared snapshot, run binding, entry session, startup supply, invocation, and history in one acceptance transaction.

The workspace changes MUST supply placement and admission controls before discovery or execution uses the new runtime configuration.

The capacity change MUST verify monitoring before existing message and aggregate snapshot ceilings stop enforcement.

The release MUST preserve independent server approvals, program approvals, grants, credential rules, and current revocations.

Deployment, actual reset, production facet changes, and live provider traffic require separate owner approval.

## External follow-ups

| Area | Required follow-up |
|---|---|
| README | Explain independent selections, separate entry policy, task targets, startup designation, goal/command parity, and native-only retention. |
| Installation guidance | Explain when configured plans require a verified installation and how accepted definitions remain independent of later installation changes. |
| Data model | Update `architecture/09-data-model-and-lifecycle.md` with plan identities, snapshot shapes, canonical hashes, and source restrictions. |
| Runtime and deployment | Coordinate validated owner configuration, authorized discovery placement, current schema, and the reset inventory. |
| Console | Show per-agent availability and startup designation without claiming use. Keep grants and refusal causes visible through the owner interface. |

The repository has no files under `docs/`. This decomposition does not edit these external implementation files.

## Dependencies and release boundary

This change consumes portable definitions and exact tool policy from roadmap items 01 and 02.

The owner configuration change owns serialized configuration, workspace registration, and pre-run transport integration.

The approval change owns durable workspace gates. The session change owns acceptance, execution, prepared-step capture, history, and continuation.

This design defines preparation contracts, not an independently deployable agent runtime.

There are no unresolved decisions within this preparation scope. Completing its design does not complete the dependent configuration, session, provider, or monitoring designs.
