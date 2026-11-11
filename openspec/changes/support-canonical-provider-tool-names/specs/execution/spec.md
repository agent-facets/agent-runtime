# Spec Delta

## ADDED Requirements

### Requirement: Provider requests preserve canonical tool names

For each supported subscription provider, model-visible tool definitions SHALL use the canonical native and facet names required by tool policy.

Runtime history and console labels SHALL NOT be the only places that preserve those names.

Where translation occurs, the runtime SHALL distinguish canonical identity from actual provider wire spelling. It SHALL NOT report an alias as the required canonical name.

An unsupported naming condition SHALL NOT cause silent truncation, another origin, or an undeclared naming exception.

#### Scenario: Canonical names reach the provider request
- **WHEN** a supported provider request offers native tool `Read` and facet tool `search` from effective server `docs`
- **THEN** its model-visible tool definitions SHALL use `tool__Read` and `facet__docs__search`
- **AND** those names SHALL reference the corresponding retained identities and reviewed definitions
- **AND** canonical labels in local history alone SHALL NOT establish compliance

#### Scenario: An alias does not satisfy the naming requirement
- **WHEN** an adapter sends an alias instead of a required canonical tool name
- **THEN** inspection and verification SHALL distinguish the actual wire name from the canonical name
- **AND** the result SHALL NOT be reported as successful canonical-name compatibility

### Requirement: Provider adaptation preserves tool-call identity

Provider adaptation SHALL preserve the relationship between offered tools, tool choice, prior tool calls, and returned calls.

A name mapping SHALL NOT change tool-call IDs, arguments, results, or ordinary text.

A returned call SHALL resolve unambiguously to a tool offered in that request. Unknown names SHALL NOT acquire authority through a guessed identity or another origin.

Request-specific mappings SHALL NOT be shared across unrelated requests, delegates, or concurrent runs.

#### Scenario: Tool-name handling preserves the operation
- **WHEN** a provider adapter processes tool definitions, tool choice, prior calls, and a returned call
- **THEN** each tool reference SHALL remain associated with the same offered tool
- **AND** call IDs, arguments, results, and ordinary text SHALL remain unchanged
- **AND** another request's mapping SHALL NOT affect that operation

#### Scenario: The provider returns an unoffered tool name
- **WHEN** a provider response names a tool that cannot be resolved to an offered tool for that request
- **THEN** the runtime SHALL refuse the unsupported call without executing a guessed target
- **AND** it SHALL NOT select another origin or connect to a new server

### Requirement: Provider compatibility claims identify their evidence

Current adapter validation rules SHALL NOT be presented as proof of actual subscription-service constraints.

Verification SHALL distinguish deterministic adapter results from evidence obtained against the supported service and profile.

Provider compatibility SHALL be established before the canonical-naming requirement is declared complete.

A live compatibility check SHALL require separate owner approval. That approval SHALL remain distinct from approval of this proposal or its future design.

#### Scenario: Local validation is not live compatibility evidence
- **WHEN** deterministic tests accept canonical names under a local adapter rule
- **THEN** the report SHALL identify that result as local adapter evidence
- **AND** it SHALL NOT claim that the live subscription service accepted those names

#### Scenario: A live compatibility check lacks approval
- **WHEN** verification would send a live provider request without separate owner approval
- **THEN** the runtime verification workflow SHALL NOT send that request
- **AND** the report SHALL leave the required live evidence unresolved rather than claim success
