# Capabilities Specification

## Purpose

Let the owner reuse installed workflows, skills, named agents, and external tools without changing runtime code. Make their origins, supported behavior, and limits of authority explicit before and during use.

## Requirements

### Requirement: Reproducible runtime facet installation

The owner SHALL be able to install supported facets for the runtime through the existing facet CLI without modifying runtime source. Given the same facet source contents, project manifest, lockfile, and recorded materialization choices, repeated installation SHALL provide the same facet versions and installed commands, skills, agents, and MCP server declarations.

The documented deployment SHALL supply materialized facet inputs read-only to the runtime.

#### Scenario: Install a workflow from recorded inputs
- **WHEN** the owner follows the documented runtime installation procedure with a supported facet and its recorded installation inputs
- **THEN** the facet's selected commands, skills, agents, and server declarations SHALL become identifiable to the runtime without a runtime source change
- **AND** repeating the installation with the same inputs SHALL NOT silently select newer versions or different contributions

#### Scenario: Installation does not execute the workflow
- **WHEN** the owner installs a facet containing a command, an agent, and an MCP server declaration
- **THEN** installation SHALL NOT start an agent run, dispatch a model request, or execute an MCP tool
- **AND** installed server declarations SHALL remain subject to separate runtime authorization

#### Scenario: Installed facet inputs are read-only
- **WHEN** the runtime starts with the documented deployment's materialized facet installation
- **THEN** it SHALL be able to load the installed contributions without modifying that installation
- **AND** the materialized inputs SHALL NOT be writable by the runtime

### Requirement: Installed definitions match their recorded installation

Before offering an installed contribution for use, the system SHALL verify that its content corresponds to the recorded runtime installation, including its pinned source and selected materialization. Content that differs or cannot be verified SHALL be refused with the affected facet and contribution identified, rather than silently used under the recorded identity.

#### Scenario: Installed content has changed
- **WHEN** an installed command's instructions differ from the content established by its recorded installation
- **THEN** the affected command SHALL be unavailable with an integrity explanation
- **AND** the altered instructions SHALL NOT be used under the previously recorded identity

### Requirement: Runtime installation is separate from coding-tool installation

The runtime's facet installation SHALL use a dedicated manifest and lockfile and SHALL be independently selectable from coding-tool installations on the same machine. Runtime installation and updates SHALL NOT overwrite coding-tool materializations, and the runtime SHALL NOT use materialized coding-tool copies as its facet source.

#### Scenario: Update the runtime installation independently
- **WHEN** the owner updates a facet in the runtime's installation while a coding tool uses an older version
- **THEN** new runtime runs SHALL be able to select the updated runtime version
- **AND** the coding tool's installed version and materialized files SHALL remain unchanged
- **AND** the editor-facing manifest and lockfile SHALL remain unchanged

#### Scenario: A coding-tool-only asset is not a runtime asset
- **WHEN** a command or skill exists only in a coding-tool installation, including a materialized `.opencode` copy
- **THEN** the runtime SHALL NOT offer or load it as an installed runtime contribution
- **AND** the owner SHALL be directed to the runtime installation procedure rather than having that copy imported implicitly

### Requirement: Supported facet behavior is explicit

The system SHALL document the supported subset of command, skill, agent, permission, and MCP declaration behavior. A contribution that requires unsupported behavior SHALL be rejected before that behavior is used, with an explanation identifying the contribution and unsupported requirement. The system SHALL NOT silently discard a behavioral requirement in order to run the contribution.

A contribution whose explicitly declared required contribution is absent or refused SHALL itself be unusable. This check SHALL apply to supported declarations, not infer dependencies from prose alone. Unrelated usable contributions SHALL remain available.

#### Scenario: An agent requires unsupported execution behavior
- **WHEN** a facet-defined agent requires parallel, background, or long-lived delegation that the runtime does not support
- **THEN** the system SHALL identify that agent and the unsupported requirement
- **AND** it SHALL NOT run the agent as though the requirement had been honored

#### Scenario: A permission restriction cannot be enforced
- **WHEN** a contribution declares an access restriction the runtime cannot enforce
- **THEN** the affected contribution SHALL be refused before work using it is dispatched
- **AND** the restriction SHALL NOT be ignored or reduced to advice for the model

#### Scenario: A facet requires automatic composition
- **WHEN** a facet requires other facets to be installed or composed automatically
- **THEN** the system SHALL explain that this behavior is unsupported
- **AND** it SHALL NOT fetch, install, or authorize additional facets on the agent's behalf

#### Scenario: A declared prerequisite is unavailable
- **WHEN** a command explicitly declares, in a supported format, a required skill or agent that is absent or refused
- **THEN** the command SHALL be shown as unusable with that prerequisite named
- **AND** starting it SHALL dispatch no model or tool work
- **AND** another otherwise usable contribution with no dependency on the refused item SHALL remain available

### Requirement: Installed contributions are identifiable

The owner SHALL be able to inspect installed commands, skills, agents, and MCP server declarations with their names, descriptions, originating facets, and versions. References used to select a contribution SHALL identify it unambiguously. Conflicting names SHALL NOT silently select or replace one contribution with another.

#### Scenario: Inspect available workflow contributions
- **WHEN** the owner inspects the runtime's installed facets in the console
- **THEN** the console SHALL identify each selected contribution, its originating facet and version, and whether it is usable or refused
- **AND** a refused contribution SHALL include its reason rather than appear ready for use
- **AND** the owner SHALL be able to inspect the configured server and tool grants and the agents available for delegation, separately from any further restrictions applied within a run

#### Scenario: Two contributions have an unresolved name conflict
- **WHEN** two installed contributions cannot be distinguished by the name used to select them
- **THEN** the system SHALL report the conflict and the contributing facets
- **AND** it SHALL NOT resolve the ambiguous reference by installation order or silently overwrite either contribution

### Requirement: Skills are discovered and loaded on demand

An agent SHALL be able to discover the names and descriptions of the skills available to it and explicitly load a selected skill's full instructions when needed. Skill discovery SHALL NOT supply every skill's full instructions as initial agent context. Loading a skill SHALL NOT install additional assets or grant additional authority. A loaded skill's bundled text references SHALL be readable on demand from its retained definitions, with access confined to that skill's bundled resources. This SHALL NOT grant general deployment-filesystem access or code execution.

#### Scenario: Load an applicable skill
- **WHEN** an agent selects an available skill from its advertised name and description
- **THEN** the system SHALL supply that skill's full instructions from the definitions bound to the run
- **AND** the run SHALL identify the skill and facet version that were loaded

#### Scenario: An unused skill stays out of the full instruction context
- **WHEN** a run has several available skills and loads only one of them
- **THEN** the unselected skills' full instructions SHALL NOT be included merely because those skills are installed

#### Scenario: Request a missing or disallowed skill
- **WHEN** an agent asks to load a skill that is missing from its bound definitions or not permitted to that agent
- **THEN** the system SHALL return an identifiable refusal without supplying another skill or installing one

#### Scenario: Read a bundled skill reference
- **WHEN** an agent requests a bundled text reference belonging to a loaded skill
- **THEN** the system SHALL supply the reference from that skill's retained definitions
- **AND** a later installation update SHALL NOT substitute a different version of the reference

#### Scenario: A skill reference is missing or escapes its bundle
- **WHEN** an agent requests a reference belonging to a skill it has not loaded, missing from the loaded skill's retained resources, or targeting content outside them
- **THEN** the system SHALL refuse the request without exposing unrelated content
- **AND** loading the skill SHALL NOT authorize arbitrary filesystem access or execution of a referenced script

### Requirement: Named delegation is bounded

An agent SHALL be able to delegate a specified task to an available facet-defined agent and receive its result or failure. The caller SHALL wait for that delegation to finish rather than launch independent background work. The system SHALL document and enforce finite delegation limits and SHALL refuse delegation outside those limits before dispatching the requested work.

Safely handled delegation refusals or task failures SHALL return to the caller with the delegate identity and reason and SHALL NOT by themselves fail the run. Failures already defined as terminal for the run, including exhaustion of its shared budget, SHALL remain terminal when encountered by a delegate.

#### Scenario: Delegate a task and use its result
- **WHEN** an agent delegates a bounded task to an available named agent
- **THEN** that agent SHALL receive the task and its bound instructions
- **AND** its result SHALL return to the caller within the same run
- **AND** a delegate failure SHALL remain distinguishable from a successful result

#### Scenario: Request an unavailable delegate or exceed a limit
- **WHEN** an agent requests an unavailable named delegate or a delegation that exceeds a documented limit
- **THEN** the system SHALL report the target and refusal reason without dispatching that delegation
- **AND** it SHALL NOT silently substitute another agent

#### Scenario: Request independent background delegation
- **WHEN** an agent requests parallel, background, or long-lived delegated work outside the supported bounded model
- **THEN** the system SHALL refuse that request rather than start an independently continuing task

#### Scenario: A safely handled delegate failure
- **WHEN** a delegate returns a task failure after a safely refused tool call, without a run-ending failure
- **THEN** the caller SHALL receive an identifiable failure outcome rather than a fabricated result
- **AND** the caller SHALL remain able to continue within the run's existing permissions and remaining budget

### Requirement: Facets and delegates can only narrow authority

The system SHALL enforce each agent's effective permissions from the owner's grants, narrowed by the applicable facet restrictions and, for a delegate, its caller's effective permissions. Installing a facet, loading instructions, or delegating a task SHALL NOT grant authority. Permission enforcement SHALL apply to actual dispatch, not only to which tools are advertised to the model.

An MCP grant's scope SHALL identify its server and tool and any supported constraints on request arguments. A target restriction means an owner-configured constraint on arguments selecting a resource, such as a repository identifier. The runtime SHALL enforce these constraints before dispatch and SHALL refuse restrictions it cannot enforce. These checks constrain requests, not the server process's independent access to resources.

#### Scenario: A facet requests more access than the owner granted
- **WHEN** a facet declares access to a tool or target outside the owner's grant
- **THEN** an agent using that facet SHALL NOT be able to dispatch the out-of-scope operation
- **AND** the refusal SHALL identify the denied operation without performing it

#### Scenario: A delegate has a narrower tool set
- **WHEN** a caller delegates to an agent whose restrictions exclude a tool that the caller can use
- **THEN** the delegate's attempt to call that tool SHALL be refused
- **AND** calling through another delegate SHALL NOT restore the excluded permission

#### Scenario: Instructions attempt to expand permissions
- **WHEN** a command, skill, delegate instruction, inspected file, or MCP response instructs an agent to acquire additional access
- **THEN** that content SHALL NOT change the agent's effective permissions or authorize the requested operation

### Requirement: MCP use requires runtime approval

The runtime SHALL launch or connect only to owner-approved MCP server configurations and SHALL dispatch only explicitly permitted tools within their granted scope. Consent to install a facet or materialize a server declaration SHALL NOT by itself authorize runtime connection or tool execution. A changed server declaration, newly discovered tool, or changed advertised tool definition SHALL require applicable owner approval; retaining a name SHALL NOT preserve approval for changed definitions.

A changed server declaration SHALL make tools using that declaration unavailable until reapproved. A changed or additional advertised tool definition SHALL make that tool unavailable without invalidating otherwise authorized, unchanged tools. The console SHALL identify the affected declaration or tool and the change requiring approval without exposing credentials.

#### Scenario: Installation consent is not runtime authorization
- **WHEN** a facet's server declaration was accepted during installation but has not received runtime approval
- **THEN** the runtime SHALL NOT launch or connect to that server or dispatch its tools
- **AND** the console SHALL distinguish the installed declaration from approved access

#### Scenario: Call an approved tool
- **WHEN** an agent requests a permitted tool from an approved server with arguments within its effective scope
- **THEN** the runtime SHALL be able to dispatch the call and return its credential-safe outcome to that agent
- **AND** the run SHALL identify the server, tool, and originating facet declaration

#### Scenario: A server or its advertised tools change
- **WHEN** a facet update changes a server's connection or launch declaration, or an approved server advertises an additional tool or a changed definition for an existing tool
- **THEN** the changed declaration, additional tool, or changed tool definition SHALL NOT become authorized merely because an existing name is retained
- **AND** requests without the applicable authorization SHALL be refused before connection or tool dispatch, respectively
- **AND** a declaration change SHALL block calls using that changed declaration, while a tool-definition change SHALL block the affected tool
- **AND** requests whose retained declarations, advertised definitions, and current grants remain valid SHALL remain eligible for dispatch
- **AND** the console SHALL explain which declaration or tool requires reapproval

### Requirement: Granted MCP calls do not require generic confirmation

An otherwise runnable MCP call that matches the current server and tool grants, the calling agent's effective permissions, the approved input schema, and supported argument restrictions SHALL be dispatched without an additional generic per-call owner confirmation. Invalid or out-of-scope calls SHALL be refused before tool dispatch. A matching grant SHALL NOT satisfy or bypass a workflow's own required approval.

#### Scenario: Dispatch a matching call
- **WHEN** an agent requests a matching call from an available approved server and any required workflow-specific approval has already been obtained
- **THEN** the runtime SHALL dispatch the call without asking an additional generic confirmation question
- **AND** its credential-safe outcome SHALL be returned and recorded

#### Scenario: Arguments violate the approved contract
- **WHEN** a requested tool call violates its approved input schema or a supported argument restriction in the owner's grant
- **THEN** the call SHALL be refused and recorded without being sent to the server

### Requirement: Tool-service credentials stay private

MCP authentication SHALL use owner-managed private configuration rather than credential values supplied by facets. Tool-service credentials SHALL be disclosed only through the approved server's authentication mechanism and SHALL remain absent from agent context, skill and delegate inputs, tool results, stored capability definitions, run histories, browser-console data, and diagnostic logs.

A server declaration containing credential material recognized by the runtime's screening SHALL be refused before connection or launch, without echoing that material.

#### Scenario: Authenticate an approved server without exposing its secret
- **WHEN** a tool call requires a privately configured credential for its approved server
- **THEN** the runtime SHALL provide it only to that server's authentication mechanism
- **AND** capability inspection, the requesting agent, and other servers SHALL NOT receive the credential value

#### Scenario: A tool outcome or connection error contains credentials
- **WHEN** an MCP result or failure includes a runtime-managed provider or tool-service credential
- **THEN** the system SHALL withhold or sanitize the sensitive content before it reaches an agent, a stored run record, the console, or a diagnostic log
- **AND** any resulting refusal SHALL explain the problem without repeating the credential

#### Scenario: A declaration contains a recognized credential
- **WHEN** a server declaration includes a known runtime-managed credential in an argument or environment setting
- **THEN** the declaration SHALL be refused before the server is launched or contacted
- **AND** the refusal and diagnostic output SHALL omit the credential value

#### Scenario: A synthetic tool-service credential stays private
- **WHEN** a known synthetic credential is configured privately for an approved server and a successful call and an error path are exercised
- **THEN** captured agent context, tool results, run history, progress events, final results, browser-console data, and diagnostic logs SHALL contain no occurrence of that credential

### Requirement: Local MCP servers are supplied reproducibly

Executables for locally launched MCP servers SHALL be pinned and supplied reproducibly with the deployment. The runtime SHALL NOT download or install a server executable on demand to satisfy a connection or tool request. A required executable that is unavailable SHALL produce an attributed server-unavailability explanation.

#### Scenario: A local server executable is absent
- **WHEN** an approved local server's pinned executable is absent from the deployment
- **THEN** the system SHALL identify the affected facet and server as unavailable
- **AND** it SHALL NOT fetch or install the missing executable

### Requirement: Capability problems identify the affected work

The system SHALL visibly distinguish missing contributions, unsupported behavior, denied operations, and unavailable MCP services. The explanation SHALL identify the affected facet and contribution when known and SHALL omit secrets. Failed or uncertain tool outcomes SHALL NOT be represented as successful empty results; an outcome whose completion cannot be established SHALL be identified as uncertain.

#### Scenario: An MCP service is unavailable
- **WHEN** an approved server cannot be started or reached for a requested tool
- **THEN** the system SHALL identify the affected server and tool and report unavailability
- **AND** it SHALL NOT fabricate tool output or report the requested operation as completed

#### Scenario: A tool reply is lost after dispatch
- **WHEN** the runtime dispatched an MCP call but cannot establish whether the server completed it
- **THEN** the outcome SHALL identify the operation and the uncertainty
- **AND** it SHALL NOT claim either successful completion or that the operation certainly had no effect

#### Scenario: A capability failure prevents continued work
- **WHEN** a capability problem prevents the run from continuing
- **THEN** the run SHALL expose a failure with the affected operation, its facet or contribution when known, and a credential-safe cause
- **AND** recorded progress SHALL remain inspectable rather than being replaced by a successful final result
