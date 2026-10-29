# Spec Delta

## ADDED Requirements

### Requirement: Tool names identify their selected origin

Model tool definitions and console labels SHALL use `tool__<name>` for native tools. Facet tools through MCP SHALL use `facet__<server>__<name>`.

These prefixes are literal strings. The server component SHALL identify the effective server ID. The name component SHALL identify the tool within that server or the native runtime.

The runtime SHALL retain each structured tool identity separately from its exposed name. It SHALL NOT reconstruct identity from a name split at `__`.

A prefix SHALL NOT grant permission or establish a tool's effect. Agent capability selection SHALL remain facet-based, without additional per-agent tool lists.

#### Scenario: Native tool names agree across interfaces
- **WHEN** the runtime exposes the native tool named `Read`
- **THEN** the model tool definition and console label SHALL use `tool__Read`
- **AND** that name SHALL reference the retained native identity

#### Scenario: A facet tool uses its origin prefix despite MCP transport
- **WHEN** a selected facet supplies tool `search` through effective MCP server `docs`
- **THEN** the model tool definition and console label SHALL use `facet__docs__search`
- **AND** its identity SHALL retain the selected facet, installed version, server ID, and tool name
- **AND** the prefix SHALL NOT bypass classification, grants, or argument restrictions

### Requirement: Ambiguous tool names prevent tool exposure

After installation resolves aliases and alternative origins, each effective server ID SHALL identify one selected server within the installation.

Each exposed tool name SHALL reference exactly one retained identity. The runtime SHALL reject ambiguous server IDs and exposed names before it offers tools to a model.

It SHALL NOT resolve conflicts by iteration order, truncation, or selection of another origin.

#### Scenario: Distinct selected servers have the same effective ID
- **WHEN** two distinct selected servers retain the same effective ID after installation resolves aliases and alternative origins
- **THEN** the runtime SHALL reject the ambiguous server ID before it offers tools
- **AND** it SHALL NOT select one server by iteration order

#### Scenario: Separators in components cause a name conflict
- **WHEN** server `a__b` with tool `c` and server `a` with tool `b__c` produce the same exposed name
- **THEN** the runtime SHALL reject that conflict before it offers tools
- **AND** it SHALL NOT merge identities or classifications

### Requirement: Standalone MCP names remain reserved without execution support

The runtime SHALL reserve `mcp__<server>__<name>` for MCP servers configured outside facets.

This change SHALL NOT add configuration, agent access, discovery, or execution support for those servers.

The runtime SHALL NOT treat an unknown tool name as permission to connect to a server.

#### Scenario: A model requests a standalone MCP tool
- **WHEN** a model requests `mcp__docs__search` without a retained supported tool binding
- **THEN** the runtime SHALL refuse the call
- **AND** it SHALL NOT discover, connect to, or execute a standalone MCP server because of that name

### Requirement: Tool classifications bind reviewed definitions

Every tool SHALL have explicit effect and critical declarations from runtime definitions or owner-controlled policy.

Effect SHALL be `read` or `write`. Critical status SHALL be an independent boolean. Tool names, descriptions, model output, and external tool claims SHALL NOT establish or change these values.

Missing required declarations SHALL prevent execution. The system SHALL NOT infer that an unclassified tool is read-only or non-critical.

The runtime SHALL register tool definitions when installation, authorized discovery, or native registration makes them available.

Classification SHALL bind the structured tool identity and reviewed definition digest. A changed definition SHALL require renewed classification before execution.

A native identity SHALL retain its kind and native tool name. A facet identity SHALL retain its kind, selected facet, installed version, effective server ID, and tool name.

Classification SHALL NOT approve a server, grant tool access, or relax resource and argument restrictions. Discovery SHALL retain its independent approval requirements.

#### Scenario: Inspect and classify a newly available tool
- **WHEN** a tool definition becomes available through installation, authorized discovery, or native registration
- **THEN** the owner SHALL be able to inspect its definition and assign its effect and critical designation when that policy is owner-editable
- **AND** execution SHALL remain unavailable until the required classification exists

#### Scenario: A tool definition changes after classification
- **WHEN** a tool retains its stable identity but has a different definition digest
- **THEN** the runtime SHALL require classification of the changed definition before executing it
- **AND** the earlier classification SHALL remain associated with the definition that the owner reviewed

#### Scenario: Missing policy declarations prevent execution
- **WHEN** a requested tool lacks its required effect or critical declaration
- **THEN** the runtime SHALL refuse execution rather than assume the tool is non-critical

#### Scenario: Exposed names do not replace tool identities
- **WHEN** a tool name contains `__` or resembles another tool's label
- **THEN** the runtime SHALL retain the separate identity components
- **AND** the label SHALL NOT cause one tool to receive another tool's classification

#### Scenario: Classification does not approve discovery or tool use
- **WHEN** the owner classifies a tool without the server or tool having the required independent approvals
- **THEN** classification alone SHALL NOT authorize server discovery, connection, or tool execution
- **AND** existing definition checks and argument restrictions SHALL remain effective

### Requirement: Installation-selected origin determines tool classification

For a deduplicated MCP tool, classification lookup SHALL use the explicit origin selected during installation and the reviewed definition digest.

The runtime SHALL preserve that origin's facet identity and installed version. Runtime discovery and model output SHALL NOT choose or replace the origin.

Classifications from other origins SHALL NOT be merged or required to agree.

A missing selected-origin reference or matching classification SHALL leave the tool unavailable. The runtime SHALL NOT substitute another origin's policy.

#### Scenario: Installation selects the authoritative origin
- **WHEN** installation selects Facet B as the origin of a deduplicated MCP tool that also has a reference from Facet A
- **THEN** the runtime SHALL use the matching classification for Facet B's selected origin and reviewed definition
- **AND** a different classification for Facet A SHALL neither override nor block the selected classification
- **AND** the model and runtime discovery SHALL NOT choose another origin

#### Scenario: The selected origin lacks a matching classification
- **WHEN** the selected-origin reference is missing or its classification does not match the reviewed definition
- **THEN** the tool SHALL remain unavailable
- **AND** the runtime SHALL NOT substitute another origin's classification

### Requirement: Native bootstrap preserves explicit policy and owner review

The runtime SHALL create an initial classification when it first registers an explicitly declared native tool. Registration and initial classification SHALL be atomic.

The initial declarations SHALL be:

| Native tool | Effect | Critical | Owner editable |
|---|---|---|---|
| `Read` | `read` | `false` | Yes |
| `Search` | `read` | `false` | Yes |
| `AskUser` | `read` | `false` | Yes |
| `LoadSkill` | `read` | `false` | Yes |
| `ReadSkillReference` | `read` | `false` | Yes |
| `Delegate` | `write` | `false` | Yes |
| `Discuss` | `read` | `false` | No |

`Delegate` SHALL be classified as mutating because its assigned task can change resources. Each child operation SHALL still pass its independent execution controls.

The runtime SHALL NOT overwrite an owner revision during startup.

A previously registered identity SHALL NOT receive another bootstrap classification merely because its definition changed. A changed definition SHALL require renewed classification before execution.

Missing or damaged classification state SHALL NOT cause automatic permission expansion.

Bootstrap SHALL NOT approve MCP servers, grant tools, or alter agent selections. Facet-provided tools SHALL NOT receive automatic classifications.

The fixed `Discuss` declaration SHALL NOT itself enable the discussion tool or approve unknown child effects.

#### Scenario: First native registration establishes explicit policy
- **WHEN** the runtime first registers an explicitly declared native tool
- **THEN** its registration and initial classification SHALL become visible atomically
- **AND** the classification SHALL match the declared effect, critical status, and owner-editability rule
- **AND** independent grants and agent selections SHALL remain unchanged

#### Scenario: Restart preserves an owner classification
- **WHEN** the owner changes an editable native classification and the runtime restarts with the same tool definition
- **THEN** the owner revision SHALL remain effective
- **AND** bootstrap SHALL NOT replace it with the initial declaration

#### Scenario: Changed native definitions need renewed classification
- **WHEN** a previously registered native identity receives a different definition digest
- **THEN** the earlier classification SHALL NOT authorize the changed definition
- **AND** the runtime SHALL NOT treat the new definition as first registration to bypass review

#### Scenario: Damaged classification state does not restore permission
- **WHEN** a previously registered native tool lacks usable required classification state
- **THEN** execution SHALL remain unavailable
- **AND** the runtime SHALL NOT recreate permissive defaults merely because the current classification is missing

#### Scenario: Facet tools do not receive native defaults
- **WHEN** an unclassified facet tool becomes available through installation or authorized discovery
- **THEN** native bootstrap SHALL NOT classify it
- **AND** the tool SHALL remain unavailable until its required owner classification exists

#### Scenario: The discussion declaration remains fixed
- **WHEN** the owner inspects the registered `Discuss` declaration
- **THEN** it SHALL show read-only, non-critical policy without edit controls
- **AND** that declaration SHALL NOT authorize a child operation or change its independent policy

### Requirement: Owners review classifications without tool side effects

The browser console SHALL provide an owner-only Tool classifications page under Configuration.

The page SHALL show registered native and MCP tools, their names, selected origins, applicable facet versions, and classification status.

The owner SHALL be able to inspect a definition, choose Read or Write, set critical status, and explicitly save owner-editable policy.

Fixed runtime declarations SHALL remain visible without edit controls. Unclassified tools and changed definitions needing review SHALL be clearly identified.

Classifications SHALL persist in the existing application database.

Opening the page or changing unsaved values SHALL NOT save policy, execute tools, or start MCP discovery.

The page SHALL NOT change agent selections, approve servers, or grant tool access. Changes SHALL NOT autosave.

The implementation SHALL use the existing console design system. A raw JSON editor and a separate classification CLI remain outside this change.

#### Scenario: Save a reviewed classification through the console
- **WHEN** the authorized owner inspects a registered tool and explicitly saves its effect and critical status
- **THEN** the classification SHALL persist for the displayed tool-definition digest
- **AND** agent selections, independent server approvals, and tool grants SHALL remain unchanged

#### Scenario: A definition changes before classification is saved
- **WHEN** the tool definition no longer matches the digest displayed for the owner's edit
- **THEN** the runtime SHALL reject the stale save and require review of the current definition
- **AND** it SHALL NOT apply the old review to the changed definition

#### Scenario: Viewing classifications has no tool side effects
- **WHEN** the owner opens the Tool classifications page or changes unsaved form values
- **THEN** the runtime SHALL NOT save a classification, execute a tool, or start MCP discovery as a consequence
- **AND** unclassified and changed-definition states SHALL remain clearly identified

#### Scenario: Classification access is owner-only
- **WHEN** a request lacks owner authorization for classification inspection or mutation
- **THEN** the runtime SHALL deny access
- **AND** hiding console controls SHALL NOT replace that enforcement

### Requirement: Classification revisions preserve accepted bindings

Each saved classification SHALL identify its reviewed tool definition and immutable policy revision.

An edit SHALL create a new revision. It SHALL NOT overwrite a revision retained by an accepted run or approval request.

A revision ID SHALL identify policy content, not select an older record format.

#### Scenario: Editing a classification preserves accepted work
- **WHEN** the owner saves a classification whose earlier revision is retained by a run or approval request
- **THEN** the system SHALL create a new revision and preserve the earlier revision
- **AND** existing bindings SHALL NOT silently change to the new revision

### Requirement: Classification saves preserve the exact owner review

A save SHALL compare the reviewed definition digest and expected current classification revision. A stale review SHALL be rejected without replacing newer policy.

A successful save SHALL create an immutable revision and retain its authorized provenance.

Each save SHALL have a durable submission identity. Equal retry SHALL return the original saved revision, even after a later edit.

Conflicting reuse of a submission identity SHALL fail. An uncertain commit SHALL require the same submission identity, not a new save.

#### Scenario: Two saves race from the same review
- **WHEN** two classification saves use the same expected revision
- **THEN** at most one SHALL update the current classification
- **AND** the other SHALL receive a conflict and require a new review

#### Scenario: A lost save response does not create another revision
- **WHEN** the owner retries an accepted save with equal submitted input and identity
- **THEN** the API SHALL return the original saved revision
- **AND** it SHALL NOT create another revision or overwrite a later edit

#### Scenario: Current definition no longer matches the review
- **WHEN** a registered tool changes after the owner opened its classification detail
- **THEN** a save for the earlier definition digest SHALL be refused
- **AND** the owner SHALL inspect the current definition before saving again
