# Design

## Context

See [proposal.md](./proposal.md#why) for the reason for this change.

The runtime already retains tool definitions and operation identities. This change adds explicit classification records and owner review bound to those definitions.

It extracts Decisions 6 and 7 and the classification portions of Contracts 12B, 12D, 15B, and 15D from the original change.

This is item 02 in the [release roadmap](../ROADMAP.md).

## Goals / Non-Goals

**Goals:**

- Keep structured tool identity separate from exposed names.
- Bind classifications to reviewed definitions and immutable revisions.
- Provide safe native bootstrap and retry-safe owner saves.
- Preserve independent grants and current revocations.

**Non-Goals:**

- Provider-carriage compatibility.
- Standalone MCP execution.
- Session execution and critical-operation dispatch.
- Automatic classification or a separate policy datastore.

## Decisions

### 1. Derive canonical names from retained structured identities

The runtime MUST use this closed identity union:

```text
ToolIdentity =
  { kind: "native", tool: NativeToolName }
  | {
      kind: "facet",
      facet: FacetName,
      version: string,
      server: ServerId,
      tool: ToolName
    }
```

The facet variant MUST identify the installation-selected origin and installed version. The version identifies external facet content, not an internal record format.

The identity key MUST be:

```text
toolKey = H({
  kind: "tool-identity",
  identity: ToolIdentity
})
```

`H` MUST mean SHA-256 of the runtime's canonical JSON encoded as UTF-8, without a trailing newline.

The runtime MUST preserve array order and canonical object-key ordering. It MUST NOT substitute facet-export bytes or PostgreSQL `jsonb::text` for this encoding.

The canonical names MUST be:

| Origin | Name |
|---|---|
| Native | `tool__<name>` |
| Facet tool through MCP | `facet__<server>__<name>` |
| Reserved standalone MCP | `mcp__<server>__<name>` |

`<server>` MUST be the effective server ID. `<name>` MUST be the tool name within that server or the native runtime.

Each exposed name MUST reference exactly one retained structured identity. Identity MUST NOT be reconstructed by splitting the exposed name at `__`.

After installation resolves aliases and alternative origins, each effective server ID MUST identify one selected server.

Ambiguous server IDs or exposed names MUST cause refusal before tool exposure. This includes collisions caused by `__` within components.

The runtime MUST NOT resolve a collision by iteration order, truncation, merged classifications, or selection of another origin.

The reserved standalone MCP prefix MUST NOT enable configuration, discovery, connection, or execution for unsupported servers.

Authored native references MUST preserve this mapping:

| Authored reference | Native identity name | Canonical exposed name |
|---|---|---|
| `mcp_Read` | `Read` | `tool__Read` |
| `mcp_Search` | `Search` | `tool__Search` |
| `mcp_AskUser` | `AskUser` | `tool__AskUser` |

The mapping MUST apply to native prerequisites and `restrict.native`. It MUST preserve restrictions without changes to published facets.

Canonical identity and provider wire spelling MUST remain distinct facts. The provider-carriage change owns faithful transport of these names.

An alias MUST NOT be reported as proof that a provider received the required canonical name.

**Rationale:** Labels explain origin, while structured identities establish the exact classification target.

**Rejected alternatives:** Parsing names loses component boundaries. Choosing another origin after installation changes which reviewed policy governs the tool.

### 2. Keep immutable classifications behind a mutable registry head

Classification records MUST use the existing PostgreSQL `runtime` schema.

The records MUST use these closed shapes:

```text
Producer =
  { kind: "owner_console", principal: "deployment-owner" }
  | { kind: "owner_configuration", configurationDigest: Digest }
  | { kind: "runtime_builtin", protocol: string }

ClassificationRef = {
  classificationId: Digest,
  revision: UUID,
  definitionDigest: Digest
}

ToolClassification = {
  classificationId: Digest,
  revision: UUID,
  toolIdentity: ToolIdentity,
  definitionDigest: Digest,
  effect: "read" | "write",
  critical: boolean,
  provenance: Producer,
  createdAt: Instant
}
```

`classificationId` MUST equal the tool's identity-derived `toolKey`.

The registry MUST retain one current entry per structured identity. That entry MUST identify the latest observed definition and a nullable classification head.

The required logical keys MUST be:

| Record | Key and relationship |
|---|---|
| Registered tool | `toolKey`; unique structured identity |
| Classification revision | `(classificationId, revision)`; immutable body and matching registered identity |
| Classification head | A nullable reference to a revision belonging to that registered identity |
| Retained run policy reference | `(runId, classificationId, revision)`; reference to the immutable classification |

A head change MUST NOT modify an existing revision.

If the current definition differs from the head's reviewed definition, the tool MUST need renewed review. The old revision MUST remain available to existing retained bindings.

Missing required classification MUST keep execution unavailable. An exposed name or previous classification for another definition MUST NOT supply a fallback.

The native definition digest MUST cover its canonical name, description, input schema, and runtime tool protocol version.

Facet classification MUST use the reviewed tool-definition digest and the exact installation-selected identity. It MUST NOT use a provider alias as classification identity.

The server MUST supply provenance from the authorized route. Clients MUST NOT select a producer.

`runtime_builtin` MUST be limited to explicit runtime declarations. It MUST NOT classify arbitrary MCP tools.

Owner-console provenance MUST identify the deployment authority as `deployment-owner`. It MUST NOT claim authentication of a named person.

An immutable revision ID MUST identify policy, not select a record format. Unknown fields, unsupported variants, and invalid references MUST fail validation.

Database constraints MUST protect referenced revisions from deletion. Transactional validation MUST check identity agreement and canonical digests. A JSON shape check alone MUST NOT establish those relationships.

The registry revision MUST change when a registered definition or classification head changes. Accepted snapshots MUST retain exact classification references rather than follow the current head.

Current independent owner revocations MUST still constrain dispatch. Retention MUST NOT restore revoked grants.

**Rationale:** Immutable revisions preserve what an accepted run or approval reviewed. A separate head permits later owner edits without rewriting that history.

**Rejected alternatives:** Updating policy rows in place changes accepted bindings. Deriving identity from exposed names permits collisions and wrong-origin classification.

### 3. Bootstrap native policy only on first identity registration

The runtime MUST use the initial native declarations specified in the capabilities delta.

First registration of an explicitly declared native identity MUST atomically establish:

- The registered identity and reviewed definition.
- Its initial immutable classification revision.
- The classification head.
- The corresponding registry revision change.

Concurrent first-registration attempts MUST converge on one registered identity and its initial classification.

Bootstrap MUST follow these rules:

| Existing state | Required behavior |
|---|---|
| Identity absent, with an explicit native declaration | Create the registration and initial classification atomically |
| Identity present with the same definition and usable classification | Preserve its current classification |
| Identity present with a changed definition | Require renewed classification; do not bootstrap again |
| Identity present with missing or damaged required classification | Keep execution unavailable; do not restore defaults automatically |
| Facet tool without classification | Require owner classification; do not apply native defaults |

An owner revision MUST NOT be overwritten during startup.

`Delegate` MUST initially be classified as mutating. Its orchestration role MUST NOT conceal the possible effects of its assigned task.

The `Discuss` declaration MUST remain fixed as read-only and non-critical. Its fixed status MUST come from the explicit runtime declaration, not from client-supplied provenance.

Other native bootstrap classifications MUST remain owner-editable. Runtime-produced provenance alone MUST NOT make them fixed.

Registration MUST NOT expose a tool that the runtime does not otherwise support. In particular, recording the `Discuss` policy MUST NOT implement or enable discussion execution.

Bootstrap MUST NOT approve discovery, grant tool access, change agent selections, or authorize a child operation.

**Rationale:** Explicit initial declarations preserve the native journey without requiring an owner save for every fresh deployment.

**Rejected alternatives:** Seeding whenever a head is absent could undo owner decisions or conceal damaged state. Seeding changed definitions would bypass renewed review.

### 4. Bind owner review and saves to the displayed definition

All paths in this contract MUST remain relative to `/api/v1`.

Inputs and outputs MUST use strict objects. Existing credential screening, request-origin checks, and administration-route input controls MUST remain effective.

The API MUST provide:

```text
GET /tool-classifications
  -> Page<ToolSummary>

GET /tool-classifications/:toolKey
  -> ToolDetail

POST /tool-classifications/:toolKey/save
  body: {
    submissionId: UUID,
    definitionDigest: Digest,
    expectedRevision: UUID | null,
    effect: "read" | "write",
    critical: boolean
  }
  -> {
    submissionId: UUID,
    classification: ToolClassification
  }

Page<T> = {
  items: T[],
  next: string | null
}

ToolDetail = {
  toolKey: Digest,
  identity: ToolIdentity,
  displayName: string,
  definitionDigest: Digest,
  definition: JsonObject,
  classification:
    { kind: "unclassified" }
    | { kind: "needs_review", revision: UUID }
    | {
        kind: "classified",
        revision: UUID,
        effect: "read" | "write",
        critical: boolean
      }
    | {
        kind: "fixed",
        effect: "read" | "write",
        critical: boolean
      }
}
```

`ToolSummary` MUST contain the detail fields except `definition`.

`displayName` MUST equal the canonical name from Decision 1. Structured identity MUST remain separate and include the installed facet version where applicable.

A detail read MUST show the exact screened definition, not an adapted substitute. If screening cannot permit exact review, the API MUST return `409 capability_unavailable` and disable Save.

List and detail reads MUST NOT start discovery, execute tools, or classify a definition.

The list MUST use keyset pagination with default limit 50 and maximum 100. Tool IDs MUST determine stable order.

A cursor MUST bind the endpoint, applicable context and filter, order, registry revision, and last key. Unknown or altered cursor fields MUST return `400 invalid_cursor`.

A changed registry revision MUST return `409 capability_selection_changed` when a later page is requested. The caller MUST obtain a new first page rather than combine different revisions.

A save MUST compare the registered definition digest and current classification revision atomically. `expectedRevision: null` MUST mean that no classification head exists.

A successful save MUST atomically:

- Append the immutable classification revision.
- Update the classification head.
- Update the registry revision.
- Store the mutation receipt.

The response MUST use status 200 and return that saved revision, not an unrelated later head.

The failure mappings MUST be:

| Condition | Result |
|---|---|
| Unknown tool key | `404 not_found` |
| Fixed declaration submitted for editing | `403 forbidden` |
| Changed reviewed definition or classification head | `409 classification_changed` |
| Conflicting reuse of a submission identity | `409 request_conflict` |
| Unconfirmed mutation commit | `503 acceptance_unknown` |

Receipt replay MUST follow Decision 5 before current-state checks. Equal replay MUST return the original result even after a later save.

The console MUST use explicit Save, not autosave. It MUST show unclassified, changed-definition, editable, and fixed states accurately.

The page MUST NOT change facet selections, server approvals, or tool grants. It MUST use existing console components and patterns, not a raw JSON editor.

**Rationale:** The owner approves a particular definition and current policy state. Atomic comparison prevents a stale page from overwriting newer policy.

**Rejected alternatives:** Saving against a name alone can approve changed content. Returning the latest head on retry loses the identity of the owner's original mutation.

### 5. Commit each owner mutation with an immutable receipt

The supported mutation families MUST be:

```text
classification_save
approval_decision
outcome_resolution
session_agent_select
```

A receipt MUST use the unique key:

```text
(family, submissionId)
```

Its input digest MUST be:

```text
H({
  kind: "mutation-input",
  family,
  target,
  body
})
```

The digest input MUST exclude only `submissionId` from the submitted body.

The server MUST derive the family and target from the authorized route. The client MUST NOT choose a different mutation family through its body.

The target MUST identify:

| Family | Exact target |
|---|---|
| `classification_save` | The registered tool |
| `approval_decision` | The workspace and approval request |
| `outcome_resolution` | The workspace and unresolved leaf |
| `session_agent_select` | The owning run and session |

The mutation's owner MUST define its closed target and body shapes. Classification saves MUST use the tool key and body from Decision 4.

A receipt MUST retain the input digest and immutable result reference. Its result reference MUST identify the result of that mutation, not a mutable current head.

The mutation and its receipt MUST commit atomically. The system MUST NOT acknowledge one without the other.

Owner-access enforcement, structural validation, and credential screening MUST precede receipt replay.

After those checks, equal receipt lookup MUST precede current-state checks. Equal input MUST return the recorded result without applying the mutation again.

Different input under the same receipt key MUST return `409 request_conflict`.

An unconfirmed commit MUST return `503 acceptance_unknown` with `acceptance: "unknown"`. The caller MUST retry the same submission identity and body.

The server MUST NOT create another submission identity to repair uncertainty.

Each mutation family MUST validate its result reference and preserve its own authorization and conflict rules. A receipt MUST NOT authorize another operation or bypass a current access boundary.

The API MUST retain the existing error envelope and applicable references. This change MUST NOT add a general-purpose details field.

The approval change owns approval and outcome-resolution semantics. The session change owns agent-selection semantics. Neither integration MAY weaken this receipt contract.

**Rationale:** The receipt separates retry identity from current state. It lets a lost response return its original result without overwriting later owner work.

**Rejected alternatives:** Repeating the mutation on retry can create another revision or decision. Returning current state can falsely attribute a later result to the earlier submission.

### 6. Keep classification controls behind the owner boundary

Classification routes MUST remain behind the existing private owner-console deployment boundary.

The private ingress boundary MUST admit only the owner. A deployment serving other users MUST add authentication before exposing these controls.

Host and Origin checks MUST remain routing and request-origin protections. They MUST NOT be described as authentication of a named person.

Owner-console provenance MUST remain `deployment-owner`. Provider authentication MUST remain browser-only and separate from classification provenance.

Classification routes MUST NOT be registered as agent tools or exposed inside task containers.

Trusted MCP connectors MUST NOT expose runtime administration to agents. Their approved configuration MUST exclude private runtime storage and administration credentials.

A connector that can reach the owner API MUST be treated as part of the trusted boundary. Its approval MUST NOT be described as sandbox isolation.

Owner classification inspection and saves MUST remain available while agent execution is held. They MUST NOT dispatch model work, tools, or critical operations.

Definition review MUST preserve credential screening. If the exact definition cannot be safely displayed, the runtime MUST refuse the review rather than approve a modified substitute.

**Rationale:** Classification is an owner policy mutation, not an agent capability. Accurate provenance avoids claiming a human identity that the current deployment does not authenticate.

**Rejected alternative:** Hiding a console button would not prevent direct API access. Host or Origin checks alone cannot establish a named owner's identity.

## Verification

Verification MUST cover these boundaries:

| Boundary | Required evidence |
|---|---|
| Identity | Canonical names reference exact structured identities. Server and exposed-name collisions fail before exposure, including collisions caused by `__`. |
| Selected origin | Classification uses the installation-selected origin and reviewed digest. Missing matches do not cause another origin's policy to be used. |
| Native registration | First registration and initial classification are atomic. Concurrent registration does not create conflicting initial revisions. |
| Bootstrap safety | Restart preserves owner edits. Changed definitions and damaged classification state do not trigger permissive reseeding. Facet tools receive no native defaults. |
| Revisions | Saved revisions remain immutable and referenced revisions cannot be deleted. Head changes do not alter accepted bindings. |
| Saves | Definition and head comparisons prevent stale updates. Revision, head, registry revision, and receipt commit together. |
| Retry identity | Equal replay returns the original result after later edits. Conflicting reuse fails. Unconfirmed commits require identical retry. |
| Inspection | Reads do not discover or execute tools. Unsafe exact review disables Save. Pages do not combine registry revisions. |
| Access | Owner enforcement applies to API requests, not only console controls. Fixed declarations reject edits. |
| Authority | Classification does not approve servers, grant tools, authorize critical operations, or restore revoked access. |

Unit tests MUST cover canonical identity, digest inputs, classification rules, and strict schemas.

Service and API tests MUST cover owner access, safe review, conflict mappings, pagination, and retry behavior.

Database tests MUST use real PostgreSQL constraints for keys, foreign keys, immutable revisions, and concurrent saves.

Console behavior MUST use component and data-pattern tests. Browser checks MUST remain limited smoke and layout checks.

The classification page MUST be checked against the development deployment at desktop, phone, and short sizes in light and dark.

Provider-carriage verification belongs to item 04. Local identity tests MUST NOT be reported as proof that a provider received canonical names.

A verification failure MUST stop work. Repair or rerun requires owner approval.

## Risks / Trade-offs

- **A label selects the wrong policy:** Keep structured identity and reviewed digest authoritative. Reject ambiguous labels.
- **A tool changes after review:** Compare the definition digest and expected head atomically.
- **Bootstrap overwrites owner intent:** Seed only on first identity registration and preserve existing revisions.
- **A lost response creates another mutation:** Commit the receipt with the mutation and replay its immutable result.
- **Historical policy appears to restore access:** Keep current independent revocations effective.
- **A safe-looking page exposes unsafe definition content:** Require exact screened review or refuse it.
- **Canonical names exceed current adapter rules:** Keep provider compatibility as a release gate without granting an alias exception.
- **Partial delivery permits critical work without approval:** Do not deploy incomplete execution controls.

## Migration Plan

The implementation MUST create the classification registry, immutable revisions, and mutation receipts in the existing PostgreSQL `runtime` schema.

Records MUST use one current strict schema without format-version selectors or compatibility decoders.

The deployment MUST register the definitions needed for classification through authorized installation, discovery, or native registration. Opening the console MUST NOT trigger those operations.

Native first registration MUST follow Decision 3. Existing owner revisions MUST NOT be replaced as a startup convenience.

Facet tools MUST remain unavailable without their required owner classification and independent grants.

The reset change MUST include these records in its ownership and lifecycle inventory. It MUST distinguish protected owner policy from disposable runtime records rather than delete tables by category.

An actual reset, production classification change, grant change, deployment, or live provider check requires separate owner approval.

## External follow-ups

| Area | Required follow-up |
|---|---|
| README | Explain canonical identity, classification, independent grants, changed-definition review, explicit Save, and retry behavior. |
| Data model | Update `architecture/09-data-model-and-lifecycle.md` with registry keys, immutable revisions, retained references, and mutation receipts. |
| Security | Update `architecture/08-execution-security.md` with owner-access provenance and the separation of classification from authorization. |
| Runtime and deployment | Document native bootstrap, required facet classifications, and protected owner policy during reset planning. |
| Console | Build the Tool classifications page using `DESIGN_SYSTEM.md` and `packages/ui/src/app/ui.tsx`. Add a reusable design-system pattern only where necessary. |

The repository has no files under `docs/`. This decomposition does not edit these external implementation files.

## Dependencies and release boundary

This change supplies tool identities, classifications, and mutation-receipt rules to later changes.

`resolve-agent-capability-plans` retains its exact policy references. `support-canonical-provider-tool-names` establishes provider carriage of its canonical names.

`enforce-workspace-critical-approvals` owns approval requests, dispatch gates, and effect resolution. `add-run-owned-agent-sessions` owns atomic acceptance and session selection.

The owner configuration and reset change owns workspace policy and the final reset inventory. It MUST NOT treat this classification design as authorization to reset data.

There are no unresolved classification decisions in this design. Provider compatibility and complete execution integration remain separate release gates.
