# Requirement and scenario traceability

This file maps each source requirement and scenario of `configure-agent-facet-capabilities` to its successor changes. It is not normative. The successor specs contain the normative text. The [JSON companion](./traceability.json) contains the same mapping for each scenario, for verification.

## Status of the source deltas

- The original deltas in this change are historical records. Do not apply them. Do not sync them to the main specs together with the successors.
- The successors do not inherit an adversarial review status from this change. Earlier source reviews do not certify the successor artifacts.
- The [scope map](./scope-map.md) allocates the source decisions and the inherited cross-cutting contracts. This file allocates only requirements and scenarios.

## Sources

The mapping uses the original source files before the umbrella banners. The banners do not change the requirement blocks.

| Domain | Source file | Requirements | Scenarios | SHA-256 |
|---|---|---|---|---|
| capabilities | [specs/capabilities/spec.md](./specs/capabilities/spec.md) | 30 | 148 | `c029d22c41da26c99ba383628f0ccb71631558a7dc0776c7e9364f96a707d7cb` |
| execution | [specs/execution/spec.md](./specs/execution/spec.md) | 39 | 193 | `2b9d440e8592a708b4a3f1457bf97e655f24064714caaa3897eab8d913f85fc2` |
| **Total** | | **69** | **341** | |

## Successors

| Order | Change | Proposal | Capabilities spec | Execution spec |
|---|---|---|---|---|
| 01 | `admit-portable-facet-contributions` | [proposal](../admit-portable-facet-contributions/proposal.md) | [spec](../admit-portable-facet-contributions/specs/capabilities/spec.md) | [spec](../admit-portable-facet-contributions/specs/execution/spec.md) |
| 02 | `manage-definition-bound-tool-policy` | [proposal](../manage-definition-bound-tool-policy/proposal.md) | [spec](../manage-definition-bound-tool-policy/specs/capabilities/spec.md) | [spec](../manage-definition-bound-tool-policy/specs/execution/spec.md) |
| 03 | `resolve-agent-capability-plans` | [proposal](../resolve-agent-capability-plans/proposal.md) | [spec](../resolve-agent-capability-plans/specs/capabilities/spec.md) | [spec](../resolve-agent-capability-plans/specs/execution/spec.md) |
| 04 | `support-canonical-provider-tool-names` | [proposal](../support-canonical-provider-tool-names/proposal.md) | None | [spec](../support-canonical-provider-tool-names/specs/execution/spec.md) |
| 05 | `configure-agent-workspaces-and-sandboxes` | [proposal](../configure-agent-workspaces-and-sandboxes/proposal.md) | [spec](../configure-agent-workspaces-and-sandboxes/specs/capabilities/spec.md) | [spec](../configure-agent-workspaces-and-sandboxes/specs/execution/spec.md) |
| 06 | `enforce-workspace-critical-approvals` | [proposal](../enforce-workspace-critical-approvals/proposal.md) | [spec](../enforce-workspace-critical-approvals/specs/capabilities/spec.md) | [spec](../enforce-workspace-critical-approvals/specs/execution/spec.md) |
| 07 | `observe-runtime-message-capacity` | [proposal](../observe-runtime-message-capacity/proposal.md) | None | [spec](../observe-runtime-message-capacity/specs/execution/spec.md) |
| 08 | `add-run-owned-agent-sessions` | [proposal](../add-run-owned-agent-sessions/proposal.md) | [spec](../add-run-owned-agent-sessions/specs/capabilities/spec.md) | [spec](../add-run-owned-agent-sessions/specs/execution/spec.md) |

## Mapping rules

- The key of a scenario is its domain and its exact scenario heading. The successors keep each source heading without change.
- Each source scenario has exactly one successor owner. No successor repeats the body of a source scenario that another successor owns.
- Each successor requirement has one owner change.
- The primary owner of a source requirement is the successor that keeps the source requirement title. If no successor keeps the title, the primary owner is the successor that owns the most scenarios.
- A mixed source requirement has scenarios in more than one successor. The successors divide its scenarios and its normative clauses. The [scope map](./scope-map.md) records the inherited cross-cutting contracts.

## Coverage totals

| Order | Source scenarios: capabilities | Source scenarios: execution | Source total | Added scenarios | Successor total | Primary-owner requirements |
|---|---|---|---|---|---|---|
| 01 | 8 | 1 | 9 | 0 | 9 | 2 |
| 02 | 20 | 1 | 21 | 6 | 27 | 4 |
| 03 | 26 | 5 | 31 | 0 | 31 | 6 |
| 04 | 0 | 0 | 0 | 6 | 6 | 0 |
| 05 | 16 | 23 | 39 | 2 | 41 | 16 |
| 06 | 6 | 26 | 32 | 0 | 32 | 7 |
| 07 | 0 | 25 | 25 | 0 | 25 | 7 |
| 08 | 72 | 112 | 184 | 2 | 186 | 27 |
| **Total** | **148** | **193** | **341** | **16** | **357** | **69** |

All 341 source scenarios have exactly one owner. No source scenario is missing, and no source scenario has two owners. 17 of the 69 source requirements are mixed. 37 source scenarios move away from the primary owner of their source requirement.

## MODIFIED source requirements

| Domain | Source requirement | Owner | Relocated scenarios |
|---|---|---|---|
| capabilities | Supported facet behavior is explicit | 01 | None |
| capabilities | Installed contributions are identifiable | 03 | None |
| capabilities | Skills are discovered and loaded on demand | 03 | None |
| capabilities | Named delegation is bounded | 08 | None |
| capabilities | Facets and delegates can only narrow authority | 08 | None |
| execution | Run history records ordered activity | 08 | None |
| execution | Start a run from an installed command | 08 | "A portable command supplies task instructions" moves to 01. The 01 requirement keeps the portable-command contract for all portable commands. |
| execution | A run keeps its original capability definitions | 08 | "A later installation selects another tool origin" moves to 02. The baseline grant-revocation scenario stays in 08. "Saved state in an earlier format does not continue" moves to 05. "Retention has no agent-count or aggregate size cap" moves to 03. |
| execution | Run capability provenance remains inspectable | 08 | None |

Each successor that keeps a MODIFIED title also keeps the MODIFIED operation for that title.

OpenSpec requires every current main-spec scenario to remain within its MODIFIED requirement. The grant-revocation scenario therefore remains in 08, even though 02 defines the related tool policy. The owner approved this correction after strict validation identified the omitted baseline scenario.

## Requirement mapping

The split column shows the scenario count for each owner of a mixed requirement.

| # | Domain | Operation | Source requirement | Scenarios | Primary owner | Split |
|---|---|---|---|---|---|---|
| 1 | capabilities | ADDED | Facet selection belongs to consuming agents | 11 | 03 | 03: 9, 05: 2 |
| 2 | capabilities | ADDED | Delegation targets belong to each configured agent | 5 | 03 | 03: 4, 08: 1 |
| 3 | capabilities | ADDED | Consuming configuration changes are explicit | 2 | 05 | 05: 1, 08: 1 |
| 4 | capabilities | ADDED | Superseded flat selections require explicit migration | 2 | 05 | None |
| 5 | capabilities | ADDED | Startup skill activation is explicitly configured | 9 | 03 | 03: 4, 08: 5 |
| 6 | capabilities | ADDED | Portable contributions are admitted without runtime declarations | 4 | 01 | None |
| 7 | capabilities | ADDED | Read-only discussion is distinct from task delegation | 18 | 08 | None |
| 8 | capabilities | ADDED | Only the owner selects the agent of a session | 6 | 08 | None |
| 9 | capabilities | ADDED | Effective capabilities follow the selected agent configuration | 4 | 08 | None |
| 10 | capabilities | ADDED | Discussion nesting uses the existing invocation-depth bound | 5 | 08 | None |
| 11 | capabilities | ADDED | Agents know their remaining nesting capacity | 3 | 08 | None |
| 12 | capabilities | ADDED | Offered child tools respect depth and mode | 2 | 08 | None |
| 13 | capabilities | ADDED | Discussion tool use follows explicit tool policy | 3 | 08 | None |
| 14 | capabilities | ADDED | Tool permissions and sandbox constraints remain separate | 4 | 05 | 05: 3, 06: 1 |
| 15 | capabilities | ADDED | Tool names identify their selected origin | 2 | 02 | None |
| 16 | capabilities | ADDED | Ambiguous tool names prevent tool exposure | 2 | 02 | None |
| 17 | capabilities | ADDED | Standalone MCP names remain reserved without execution support | 1 | 02 | None |
| 18 | capabilities | ADDED | Critical operations require explicit human approval | 16 | 06 | 02: 11, 06: 4, 08: 1 |
| 19 | capabilities | ADDED | Classification and execution policies use immutable revisions | 5 | 05 | 02: 1, 05: 4 |
| 20 | capabilities | ADDED | Classification saves preserve the exact owner review | 3 | 02 | None |
| 21 | capabilities | ADDED | Configured identities do not silently replace authored agent references | 2 | 03 | 03: 1, 08: 1 |
| 22 | capabilities | ADDED | Owner controls expose authority without inventing identity | 2 | 06 | 05: 1, 06: 1 |
| 23 | capabilities | ADDED | A development reset regenerates runtime facet inputs | 1 | 05 | None |
| 24 | capabilities | ADDED | Admission decisions from before a reset are not used again | 1 | 05 | None |
| 25 | capabilities | ADDED | Facet version identifiers keep their meaning | 1 | 05 | None |
| 26 | capabilities | MODIFIED | Supported facet behavior is explicit | 4 | 01 | None |
| 27 | capabilities | MODIFIED | Installed contributions are identifiable | 3 | 03 | None |
| 28 | capabilities | MODIFIED | Skills are discovered and loaded on demand | 5 | 03 | None |
| 29 | capabilities | MODIFIED | Named delegation is bounded | 15 | 08 | None |
| 30 | capabilities | MODIFIED | Facets and delegates can only narrow authority | 7 | 08 | None |
| 31 | execution | ADDED | A run starts at a configured entry agent | 11 | 08 | 03: 1, 08: 10 |
| 32 | execution | ADDED | Goal runs use configured facet capabilities | 6 | 08 | None |
| 33 | execution | ADDED | Discussion invocations retain a read-only execution mode | 4 | 08 | None |
| 34 | execution | ADDED | Depth awareness persists across actor requests and continuation | 4 | 08 | None |
| 35 | execution | ADDED | A discussion returns one final result through its parent operation | 12 | 08 | None |
| 36 | execution | ADDED | Discussion shares run accounting without blocking approval drain | 4 | 08 | 06: 1, 08: 3 |
| 37 | execution | ADDED | Discussion context uses the target's retained definitions | 10 | 08 | 03: 3, 08: 7 |
| 38 | execution | ADDED | Discussion lifecycle and replay preserve one turn per operation | 6 | 08 | None |
| 39 | execution | ADDED | A session has one execution state | 3 | 08 | None |
| 40 | execution | ADDED | Session conversation history is ordered and replay-safe | 4 | 08 | None |
| 41 | execution | ADDED | An owner agent selection applies at the next model request preparation | 6 | 08 | None |
| 42 | execution | ADDED | Critical-operation approvals bind exact execution | 9 | 06 | None |
| 43 | execution | ADDED | Workspaces own shared execution environments | 4 | 05 | 05: 3, 08: 1 |
| 44 | execution | ADDED | The first workspace sandbox backend is Docker | 3 | 05 | None |
| 45 | execution | ADDED | Workspace lifetime is independent of runs and containers | 6 | 05 | 05: 5, 06: 1 |
| 46 | execution | ADDED | Critical approvals hold all new agent work in their workspace | 4 | 06 | None |
| 47 | execution | ADDED | Workspace holds resolve through individual approvals | 4 | 06 | None |
| 48 | execution | ADDED | Workspace admission is durable across executor boundaries | 3 | 06 | None |
| 49 | execution | ADDED | Owner outcome resolution does not invent execution evidence | 3 | 06 | None |
| 50 | execution | ADDED | A workspace hold preserves resumable execution without a question | 2 | 08 | None |
| 51 | execution | ADDED | Submitted workspace and entry choices have stable retry identity | 3 | 08 | None |
| 52 | execution | ADDED | Large inspection views preserve their committed history boundary | 2 | 08 | 06: 1, 08: 1 |
| 53 | execution | ADDED | Runtime records use one current strict schema | 3 | 05 | None |
| 54 | execution | ADDED | The current record schema does not change the API path | 1 | 05 | None |
| 55 | execution | ADDED | A development reset removes disposable runtime records | 1 | 05 | None |
| 56 | execution | ADDED | A development reset preserves owner and external data | 2 | 05 | None |
| 57 | execution | ADDED | A development reset needs separate owner approval | 2 | 05 | None |
| 58 | execution | ADDED | Work from before a reset does not continue | 2 | 05 | None |
| 59 | execution | ADDED | Ordinary message content follows the common message-size policy | 7 | 07 | None |
| 60 | execution | ADDED | The provider decides request capacity | 2 | 07 | None |
| 61 | execution | ADDED | Provider rejections are reported faithfully | 4 | 07 | None |
| 62 | execution | ADDED | A failure keeps the accepted input | 2 | 07 | None |
| 63 | execution | ADDED | Size and resource monitors operate before limits are removed | 6 | 07 | None |
| 64 | execution | ADDED | A new size limit needs evidence and separate approval | 2 | 07 | None |
| 65 | execution | ADDED | Capacity risk is stated without capacity claims | 2 | 07 | None |
| 66 | execution | MODIFIED | Run history records ordered activity | 13 | 08 | None |
| 67 | execution | MODIFIED | Start a run from an installed command | 8 | 08 | 01: 1, 08: 7 |
| 68 | execution | MODIFIED | A run keeps its original capability definitions | 16 | 08 | 02: 1, 03: 1, 05: 1, 08: 13 |
| 69 | execution | MODIFIED | Run capability provenance remains inspectable | 7 | 08 | None |

## Relocated scenarios

These source scenarios have an owner that is not the primary owner of their source requirement. The # column refers to the requirement mapping table.

| # | Scenario | Owner | Successor requirement |
|---|---|---|---|
| 1 | Agent configuration exceeds the previously proposed count bound | 05 | Owner configuration defines agents directly without fixed agent-count limits |
| 1 | Define an agent directly | 05 | Owner configuration defines agents directly without fixed agent-count limits |
| 2 | Target checks apply to nested calls | 08 | Named delegation is bounded |
| 3 | A task attempts to override selection | 08 | Facets and delegates can only narrow authority |
| 5 | Load a skill before an agent begins | 08 | Session startup supply is durable and replay-safe |
| 5 | Startup skills appear within new-session history | 08 | Session startup supply is durable and replay-safe |
| 5 | A startup skill is requested again | 08 | Session startup supply is durable and replay-safe |
| 5 | Independently configured startup activation is attributed separately | 08 | Session startup supply is durable and replay-safe |
| 5 | A selection change supplies only missing startup skills | 08 | Session startup supply is durable and replay-safe |
| 14 | Non-critical sandboxed work does not require approval for every write | 06 | Non-critical writes remain subject to ordinary execution controls |
| 18 | Inspect and classify a newly available tool | 02 | Tool classifications bind reviewed definitions |
| 18 | Save a reviewed classification through the console | 02 | Owners review classifications without tool side effects |
| 18 | A definition changes before classification is saved | 02 | Owners review classifications without tool side effects |
| 18 | Viewing classifications has no tool side effects | 02 | Owners review classifications without tool side effects |
| 18 | Classification access is owner-only | 02 | Owners review classifications without tool side effects |
| 18 | Installation selects the authoritative origin | 02 | Installation-selected origin determines tool classification |
| 18 | The selected origin lacks a matching classification | 02 | Installation-selected origin determines tool classification |
| 18 | Exposed names do not replace tool identities | 02 | Tool classifications bind reviewed definitions |
| 18 | A tool definition changes after classification | 02 | Tool classifications bind reviewed definitions |
| 18 | Classification does not approve discovery or tool use | 02 | Tool classifications bind reviewed definitions |
| 18 | Missing policy declarations prevent execution | 02 | Tool classifications bind reviewed definitions |
| 18 | Discussion cannot use approval to gain write authority | 08 | Discussion tool use follows explicit tool policy |
| 19 | Editing a classification preserves accepted work | 02 | Classification revisions preserve accepted bindings |
| 21 | Discussion cannot bypass an explicit authored child prohibition | 08 | Discussion tool use follows explicit tool policy |
| 22 | More choices exist than fit one page | 05 | Owner choices remain available through bounded pages |
| 31 | Entry policy references are invalid | 03 | Entry policy and depth resolve against configured agents |
| 36 | A child critical read does not deadlock its parent | 06 | Suspended callers do not block approval drain |
| 37 | Native configured agents can be retained without an installation | 03 | Retained configurations include every configured agent |
| 37 | Retention keeps a large catalog complete | 03 | Retained configurations include every configured agent |
| 37 | Retention cannot silently omit part of a catalog | 03 | Retained configurations include every configured agent |
| 43 | Discussion shares a workspace with writers | 08 | Discussion stays read-only in a shared workspace |
| 45 | Shared edits cannot change an approved critical operation | 06 | Critical-operation approvals bind exact execution |
| 52 | A run without selected facets requires approval | 06 | Approval inspection applies to every run |
| 67 | A portable command supplies task instructions | 01 | Portable commands preserve task input without adding authority |
| 68 | A later installation selects another tool origin | 02 | Retained tool policies preserve reviewed identities |
| 68 | Saved state in an earlier format does not continue | 05 | Runtime records use one current strict schema |
| 68 | Retention has no agent-count or aggregate size cap | 03 | Retained configurations include every configured agent |

Row 18 keeps its title in 06, but 02 owns 11 of its 16 scenarios. Row 19 has no successor with its title, so the count rule selects 05.

## Added successor scenarios

The successors contain 16 scenarios that are not in the source. These scenarios are supplementary tests of approved source constraints. They do not add scope.

| Order | Domain | Successor requirement | Scenarios |
|---|---|---|---|
| 02 | capabilities | Native bootstrap preserves explicit policy and owner review | 6 |
| 04 | execution | Provider requests preserve canonical tool names | 2 |
| 04 | execution | Provider adaptation preserves tool-call identity | 2 |
| 04 | execution | Provider compatibility claims identify their evidence | 2 |
| 05 | execution | A development reset needs separate owner approval | 2 |
| 08 | capabilities | Only the owner selects the agent of a session | 2 |

The [JSON companion](./traceability.json) lists the name of each added scenario.
