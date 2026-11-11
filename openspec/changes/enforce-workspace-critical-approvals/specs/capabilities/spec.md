# Spec Delta

## ADDED Requirements

### Requirement: Non-critical writes remain subject to ordinary execution controls

A permitted operation classified as non-critical SHALL NOT require generic owner confirmation merely because it writes within the sandbox.

Independent grants, argument restrictions, interaction mode, sandbox constraints, and workspace admission SHALL remain effective.

Non-critical status SHALL NOT itself grant permission.

#### Scenario: Non-critical sandboxed work does not require approval for every write
- **WHEN** an authorized sandboxed operation is classified as mutating but non-critical
- **AND** all applicable permission, mode, resource, and workspace checks pass
- **THEN** it MAY execute without an additional approval for that write
- **AND** non-critical status SHALL NOT bypass any independent execution control

### Requirement: Critical operations require explicit human approval

Every operation designated critical SHALL require owner approval before execution.

Approval SHALL identify the workspace, operation, target, and exact arguments or immutable change content.

Changed scope SHALL require new approval. Each request SHALL require its own decision.

Approval SHALL NOT authorize unrelated operations, resolve other requests, grant missing permission, or override discussion restrictions.

The critical gate SHALL apply to every exposed route, including wrappers and remote tools.

A critical request SHALL hold new agent work across its workspace while owner controls and necessary runtime bookkeeping remain available.

Decisions, dispatch, runtime outcomes, and owner assertions about uncertain effects SHALL remain distinct inspectable facts.

#### Scenario: A critical push waits for approval
- **WHEN** a permitted GitHub push is designated critical
- **THEN** the runtime SHALL obtain approval of its exact target and arguments or change before execution
- **AND** that approval SHALL NOT authorize another target or later changes

#### Scenario: Critical and mutating classifications are independent
- **WHEN** a permitted sandboxed edit is non-critical and a permitted push is critical
- **THEN** the edit MAY execute under ordinary checks while the push SHALL require approval
- **AND** both SHALL remain unavailable in discussion mode because they mutate resources

#### Scenario: A critical request changes after approval
- **WHEN** the operation, target, arguments, or proposed change differs from the approved request
- **THEN** the runtime SHALL require new approval before executing the changed request

#### Scenario: A wrapper cannot bypass a critical gate
- **WHEN** a wrapper or remote tool provides another route to a designated critical operation
- **THEN** that route SHALL enforce the same approval requirement before the effect occurs

### Requirement: Owner controls expose authority without inventing identity

Approval and outcome-resolution controls SHALL remain behind the private owner-access boundary.

Provenance SHALL identify the deployment owner without claiming authentication of a named person through Host or Origin checks.

Client-supplied provenance SHALL NOT grant owner authority.

A deployment serving other users SHALL require authentication before exposing these controls.

#### Scenario: Owner provenance reflects the actual boundary
- **WHEN** the runtime records an owner classification, approval decision, or outcome resolution under the private deployment boundary
- **THEN** provenance SHALL identify the deployment authority
- **AND** it SHALL NOT claim a verified human identity from Host or Origin checks
