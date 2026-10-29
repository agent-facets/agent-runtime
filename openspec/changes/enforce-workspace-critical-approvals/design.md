# Design

## Context

See [proposal.md](./proposal.md#why) for the reason for this change.

The runtime already records operation identities, dispatch intent, and outcomes. This change extends that lifecycle with exact critical approvals and durable workspace admission.

It extracts the approval and gate contracts from Decisions 9, 12, 13, and 15 of the original change.

This is item 06 in the [release roadmap](../ROADMAP.md).

## Goals / Non-Goals

**Goals:**

- Bind approval to exact reviewed execution.
- Serialize critical effects within each workspace.
- Preserve durable admission and truthful uncertain outcomes.
- Keep owner decisions separate from execution evidence.

**Non-Goals:**

- Docker provisioning or owner configuration.
- Session conversation and checkpoint recovery.
- Another operation ledger or a general approval platform.
- Automatic retry or guarantees of exactly-once external effects.

## Decisions

### 1. Bind each approval to one immutable execution scope

The runtime MUST use these closed shapes:

```text
ApprovalScope = {
  kind: "critical-operation-approval",
  workspaceId: UUID,
  runId: UUID,
  actorKey: ActorKey,
  operationId: Digest,
  toolIdentity: ToolIdentity,
  definitionDigest: Digest,
  classificationRevision: ClassificationRef,
  executionPolicyRevision: PolicyRef,
  target:
    {
      kind: "workspace",
      workspaceId: UUID,
      paths: RelativePath[]
    }
    | {
        kind: "remote",
        serverId: ServerId,
        resourceArguments: JsonObject
      },
  executionPayload:
    { kind: "inline", arguments: JsonObject }
    | {
        kind: "artifact",
        sha256: Digest,
        byteLength: SafeInteger,
        mediaType: "application/json"
      },
  preconditions: {
    path: RelativePath,
    state:
      { kind: "absent" }
      | { kind: "file", sha256: Digest }
  }[]
}

ApprovalRequest = {
  requestId: UUID,
  scope: ApprovalScope,
  requestDigest: Digest,
  createdAt: Instant
}

ApprovalDecision = {
  decisionId: UUID,
  requestId: UUID,
  requestDigest: Digest,
  verdict: "approve" | "reject",
  decidedBy: OwnerConsoleProducer,
  decidedAt: Instant
}
```

Identity and policy references MUST use the contracts supplied by the tool-policy and workspace changes.

`OwnerConsoleProducer` MUST identify the authorized `deployment-owner` route, not client-supplied identity.

The request digest MUST equal `H(scope)`. Request IDs, decision metadata, and timestamps MUST NOT enter that digest.

`H` MUST use runtime canonical JSON encoded as UTF-8 without a trailing newline.

The request MUST reference the same operation, actor, run, and workspace as the operation's retained binding.

That binding MUST preserve the exact selected origin and server declaration. Tool names MUST NOT substitute for structured identity.

Inline arguments MUST be the exact validated execution arguments, not a summary.

An artifact MUST contain the canonical JSON argument object as immutable PostgreSQL bytes. A mutable file path MUST NOT serve as the execution payload.

Artifacts MUST retain the approved 1-MiB bound. Length, digest, and canonical encoding MUST be verified before review and execution.

This contract MUST NOT introduce an agent artifact-upload tool.

The trusted adapter MUST prepare targets and necessary file preconditions before request creation.

A remote target MUST retain the complete argument object. A model-written target label MUST NOT establish semantic confinement.

Workspace paths MUST be normalized relative paths without traversal or symlink escape.

If an operation depends on an existing file version, execution MUST check its digest or absence. A file-change adapter MUST enforce the precondition with the mutation.

An earlier unprotected file read MUST NOT substitute for that guarantee.

Unsupported preparation MUST refuse with `approval_scope_unsupported`.

Credential and content screening MUST precede request persistence. Unsafe exact review MUST refuse with `approval_content_unreviewable`.

Redacted or incomplete content MUST NOT be presented as the exact approved payload. Independently configured transport credentials MUST NOT enter approval content.

One logical operation MUST have at most one approval request. Equal-scope replay MUST reuse it; changed scope under that operation identity MUST fail verification.

A changed proposal requires a new operation, request, and decision. It MUST NOT overwrite the earlier scope.

**Rationale:** Immutable reviewed content prevents later file changes, aliases, or policy edits from changing what approval authorizes.

**Rejected alternatives:** Mutable paths and summarized arguments cannot establish exact execution. Reusing a request for changed scope would turn one approval into broader permission.

### 2. Use durable workspace admission and leaf accounting

PostgreSQL MUST hold the authoritative coordination records. Process-local serialization MUST NOT establish workspace permission.

The records MUST use these closed shapes:

```text
WorkspaceGate = {
  workspaceId: UUID,
  revision: PositiveDecimal,
  admission: "open" | "closed",
  criticalSlot: null | {
    runId: UUID,
    operationId: Digest,
    requestId: UUID
  }
}

LeafIdentity =
  { kind: "model", runId: UUID, attemptId: UUID }
  | { kind: "tool", runId: UUID, operationId: Digest }

WorkspaceLeaf = {
  leafId: Digest,
  workspaceId: UUID,
  actorKey: ActorKey,
  identity: LeafIdentity,
  ownerEpoch: PositiveDecimal,
  admissionRevision: PositiveDecimal,
  state:
    { kind: "active" }
    | { kind: "settled" }
    | { kind: "unresolved", reason: ReasonCode }
}
```

The leaf key MUST be:

```text
leafId = H({
  kind: "workspace-leaf",
  identity
})
```

There MUST be one gate per workspace and one leaf per underlying model attempt or tool operation.

Each leaf MUST reference that existing execution record. It MUST NOT duplicate the operation result or become another execution ledger.

The lock order MUST be owner, workspace, run, then operation-specific records. Equal-level keys MUST use deterministic order.

Cancellation and completion MUST obey the same order.

Database locks MUST NOT remain held across model responses, tool responses, child invocations, or owner decisions.

Ordinary admission MUST atomically check the open gate and reserve the existing attempt or dispatch intent with its leaf.

Admission is permission to complete the authorized handoff, not proof that the destination received it.

An effect admitted before closure MAY complete that handoff afterward. It MUST remain in the drain set until its effect stops and durable settlement is confirmed.

Work without prior admission MUST NOT start.

Child creation MUST also check the gate. Suspended control wrappers MUST NOT create active leaves merely because their promises remain unresolved.

Skill bookkeeping and checkpoint writes MUST NOT count as leaf effects. Their underlying file reads MUST still pass tool admission.

The session change MUST integrate the gate check with same-run ownership and the atomic idle-to-active transition.

Exclusion from drain accounting MUST NOT release an occupied session or remove real child work from cancellation tracking.

Critical request creation MUST atomically insert the immutable scope, close the gate, and pause the operation for approval.

At that point, the critical operation MUST NOT already have an ordinary dispatch intent or active leaf.

The operation disposition MUST add:

```text
{ kind: "awaiting_approval", requestId: UUID }
```

Its transitions MUST be from `started` to `awaiting_approval`, then to `dispatching` or a confirmed non-execution `completed` result.

The existing owner-question pause variant MUST NOT be reused for approval. A dispatching operation MUST NOT return to approval waiting to obtain another send.

Every gate, leaf, request, decision, or resolution change visible in the workspace queue MUST increment the gate revision atomically.

Classification saves MUST retain their separate registry revision.

**Rationale:** Durable admission establishes a common boundary for competing executors and exposes the database-to-transport interval honestly.

**Rejected alternatives:** Process-local locks cannot fence another executor. Counting suspended wrappers as active effects can deadlock a child's approval.

### 3. Reopen admission only after complete durable settlement

Completion MUST atomically commit the existing attempt or tool outcome, applicable history, and leaf settlement.

A timeout MUST NOT settle a leaf unless termination of its underlying effect is confirmed.

Lost acknowledgement, lost executor ownership, or an unconfirmed remote effect MUST leave the leaf unresolved.

The runtime MUST NOT treat a timeout or a new owner epoch as proof that an effect stopped.

Changing any leaf to unresolved MUST atomically close its workspace gate, even when no critical request exists.

That recovery hold MUST use the unresolved-effect interface. The runtime MUST NOT manufacture an approval request for it.

Gate inspection MUST derive its state from durable records under the gate lock:

| State | Meaning |
|---|---|
| `open` | Ordinary admission is open |
| `draining` | A closed workspace still has active ordinary leaf work |
| `outcome_unknown` | A workspace leaf remains unresolved |
| `executing` | The critical slot is occupied |
| `held` | The gate is closed without the preceding active-work conditions |

These inspection labels MUST NOT replace the gate, leaf, request, or operation records.

Reopening MUST require all of these conditions:

- Every leaf is settled.
- The critical slot is empty.
- Every approval request is closed.

A request MUST remain open while undecided or approved but awaiting execution.

A request can close after rejection, confirmed execution, confirmed non-execution refusal, or explicit uncertainty resolution.

The final predicate check, gate reopening, and revision increment MUST be atomic.

An open gate MUST NOT coexist with an unresolved approval request, occupied critical slot, or unresolved workspace leaf.

This invariant MUST cover model effects and tool effects.

A gate closed for approval MUST remain closed while previously admitted work drains, even if the initiating request is rejected.

The runtime MUST NOT replace this stateful rule with a predicate that ignores work still draining after rejection.

Transactions that change these facts MUST preserve the invariant under the workspace lock.

Workspace coordination MUST NOT hold database locks across external work or use one workspace's hold to block another workspace.

Container lifecycle coordination belongs to the workspace change. It MUST use the ownership fence and preserve workspace independence.

A closed gate alone MUST NOT be reported as a verified resumable run checkpoint. The session change owns durable hold publication and continuation verification.

Reopening MUST NOT resume terminal or unauthorized work or bypass those continuation checks.

**Rationale:** Admission state must remain consistent with durable effects, including operations whose outcomes are unknown.

**Rejected alternatives:** Clearing a hold on restart loses external-effect uncertainty. Reopening immediately after rejection can race work that was admitted before closure.

### 4. Dispatch only the confirmed critical-intent winner

An approval submission MUST atomically insert its immutable decision and mutation receipt.

The unique decision for that request MUST remain authoritative.

Equal submission replay MUST return that decision. A different submission after a decision exists MUST return `approval_conflict`, even if its verdict matches.

Decision insertion MUST NOT send a tool request. Approval MAY be recorded while ordinary work drains, but execution MUST wait.

The executor MUST claim an approved request only when the drain set is empty and the critical slot is unoccupied.

The claim MUST atomically reserve the slot, add the critical leaf, and record dispatch intent in the existing tool operation.

The request MUST still match the retained tool, exact payload, definition digest, workspace policy, and classification revision.

Current grants, run state, interaction mode, resource rules, and verified sandbox settings MUST also permit execution.

Ready approvals MUST be selected by `(createdAt, requestId)` within the workspace. Undecided requests MAY be skipped but MUST NOT be treated as resolved.

This is deterministic dispatch through the existing executor, not another task scheduler.

Only the confirmed intent winner MAY hand the frozen arguments to the transport.

Existing intent, an ambiguous commit, approval replay, or restart MUST NOT authorize another send.

A crash after intent but before send MAY leave an unresolved operation that never executed. The runtime MUST preserve that uncertainty rather than assume dispatch occurred or did not occur.

Confirmed completion MUST atomically record the outcome, settle the leaf, clear the critical slot, and append history.

Confirmed failure MUST NOT cause automatic retry.

An uncertain result MUST retain the slot and hold, even if its run becomes terminal.

Pre-dispatch completion MUST use these reasons:

| Condition before intent | Recorded reason |
|---|---|
| Owner rejection | `approval_rejected` |
| Cancellation or independent revocation | `approval_not_executed` |
| Definition or file-precondition mismatch | `approval_scope_changed` |

These non-executed operations MUST NOT obtain a dispatch leaf.

A request without a human decision MAY close through confirmed non-execution. The runtime MUST NOT manufacture a reject decision.

Cancellation after intent MUST follow the normal uncertain-effect rules. A cancelled run MUST NOT by itself clear the critical slot.

**Rationale:** Durable intent prevents replay from becoming another send, while preserving the unavoidable gap between database commit and external execution.

**Rejected alternative:** Treating missing response data as proof of non-execution can repeat an external effect.

### 5. Resolve uncertainty through an explicit owner assertion

Any unresolved workspace leaf MUST use this separate resolution record:

```text
OwnerOutcomeResolution = {
  resolutionId: UUID,
  workspaceId: UUID,
  leafId: Digest,
  observedOutcomeDigest: Digest,
  assertion:
    "effect_confirmed"
    | "no_effect_confirmed"
    | "acknowledged_unknown",
  executorStopped: true,
  evidence: string,
  resolvedBy: OwnerConsoleProducer,
  resolvedAt: Instant
}
```

The owner MUST stop the old executor and any continuing local process before resolution.

For a remote operation, the owner MUST establish that no execution remains in progress. If that cannot be established, the hold MUST remain.

`executorStopped` MUST record the owner's assertion. It MUST NOT be presented as a fact proved by the database.

Evidence MUST be nonblank, screened text of at most 8192 UTF-8 bytes.

The inspection API and resolution transaction MUST compute:

```text
observedOutcomeDigest = H({
  kind: "unresolved-workspace-effect",
  leafId,
  ownerEpoch,
  reason,
  recordedState:
    { kind: "model", state: AttemptState }
    | { kind: "tool", disposition: ToolDisposition }
})
```

The reason and owner epoch MUST come from the unresolved leaf.

The recorded state MUST be the complete persisted state of the referenced attempt or operation, validated against its current schema.

Inspection MUST use one consistent store view. The mutation MUST recompute the digest from locked records.

A changed outcome after inspection MUST cause a conflict rather than resolve stale evidence.

Resolution MUST be immutable and unique per leaf.

One transaction MUST record the resolution and receipt, change the leaf from unresolved to settled, and release its critical slot if present.

Here, settled MUST mean removal from drain membership, not proof of successful execution.

The original attempt or operation outcome MUST remain inspectable. Resolution MUST NOT rewrite it, refund a model step, fabricate output, or authorize another execution.

`acknowledged_unknown` MUST mean that the effect remains unknown after execution stopped. It MUST NOT permit a still-active process.

A new owner epoch MUST NOT be treated as sufficient fencing for network effects.

Resolution of one leaf MUST NOT promise that its workspace reopens. Other requests or effects can retain the hold.

The same contract MUST cover ordinary unresolved effects without creating a false critical-approval request.

**Rationale:** An owner can establish operational facts that the runtime cannot prove, but the recorded assertion must remain distinct from runtime evidence.

**Rejected alternatives:** Relabeling uncertainty as failure permits unsafe retry. Replacing the original result with owner testimony creates false execution history.

### 6. Use separate owner routes for decisions and outcome resolution

Routes MUST remain relative to `/api/v1` and behind the existing owner-console boundary.

They MUST NOT be registered as agent tools or exposed inside task containers.

The API MUST provide:

```text
POST /workspaces/:workspaceId/approvals/:approvalId/decision

body: {
  submissionId: UUID,
  requestDigest: Digest,
  verdict: "approve" | "reject"
}

result: {
  submissionId: UUID,
  decision: ApprovalDecision
}
```

The `approvalId` path value MUST identify the approval request's `requestId`.

The mutation family MUST be `approval_decision`. Its target MUST identify the exact workspace and request.

The API MUST also provide:

```text
POST /workspaces/:workspaceId/unresolved-effects/:leafId/resolve

body: {
  submissionId: UUID,
  observedOutcomeDigest: Digest,
  assertion:
    "effect_confirmed"
    | "no_effect_confirmed"
    | "acknowledged_unknown",
  executorStopped: true,
  evidence: string
}

result: {
  submissionId: UUID,
  resolution: OwnerOutcomeResolution
}
```

The mutation family MUST be `outcome_resolution`. Its target MUST identify the exact workspace and leaf.

Both routes MUST use the shared mutation-receipt contract. Inputs MUST reject unknown fields and preserve credential screening.

After access and structural checks, equal receipt replay MUST precede current-state checks.

New decisions MUST match the request digest and workspace.

Stale digests, already-decided requests, and closed operations MUST return `409 approval_conflict`, except for equal receipt replay.

A request belonging to another workspace MUST return `404 not_found`.

Outcome resolution MUST compare the exact unresolved leaf and observed outcome digest under the workspace gate.

A stale or already-resolved leaf MUST return `409 approval_conflict`, except for equal receipt replay.

Changed input under the same submission identity MUST return `409 request_conflict`.

An unconfirmed commit MUST return `503 acceptance_unknown` with unknown acceptance. Retry MUST use the same identity and body.

Successful mutations MUST return status 200 with their recorded decision or resolution.

A resolution response MUST NOT promise tool success or workspace reopening.

Owner reads, decisions, resolutions, answers, and cancellations MUST remain available during a hold.

These endpoints MUST NOT directly dispatch a critical operation. The executor MUST apply the dispatch contract after the mutation commits.

The console MUST use individual Approve and Reject actions. It MUST NOT turn them into bulk permission approval.

**Rationale:** Separate routes preserve the distinction between owner decisions, normal answers, and assertions about uncertain effects.

**Rejected alternatives:** Reusing the question API conflates different identities and replay rules. Dispatch inside the approval route makes response retries dangerous.

### 7. Inspect decisions and execution as separate states

The owner API MUST provide these reads relative to `/api/v1`:

```text
GET /workspaces/:workspaceId/approvals
  -> {
    workspace: WorkspaceOption,
    gate: GateView,
    approvals: Page<ApprovalSummary>,
    unresolvedEffectCount: Decimal
  }

GET /workspaces/:workspaceId/approvals/:approvalId
  -> ApprovalDetail

GET /workspaces/:workspaceId/unresolved-effects
  -> {
    gateRevision: PositiveDecimal,
    effects: Page<UnresolvedLeafSummary>
  }

GET /workspaces/:workspaceId/unresolved-effects/:leafId
  -> UnresolvedLeafDetail
```

`WorkspaceOption` MUST identify the registered workspace, display name, and current availability under the owner configuration contract.

`GateView` MUST contain `revision` and `state`. State MUST be one of `open`, `draining`, `held`, `executing`, or `outcome_unknown`.

`ApprovalSummary` MUST identify:

- Request ID and digest.
- Workspace, run, actor, and operation.
- Structured tool identity.
- Request creation time.
- Decision state.
- Execution state.

Decision state MUST be the closed union `pending | approved | rejected`. Approved and rejected variants MUST include the immutable decision ID and decision time.

Execution state MUST be the closed union `not_started | executing | succeeded | failed | not_executed | uncertain`.

Terminal execution variants MUST include recorded time and a safe reason or an outcome reference.

Owner outcome assertions MUST appear separately. Acknowledging an unknown outcome MUST NOT change its runtime execution state to succeeded.

`ApprovalDetail` MUST add the exact scope, verified inline or artifact argument object, and any owner outcome resolution.

Artifact bytes MUST be digest-verified before display.

List rows MAY omit large review content. Approve MUST use the detail content and its request digest, not a summary or redacted substitute.

`UnresolvedLeafSummary` MUST identify the leaf, run, actor, model attempt or tool operation, and safe reason.

`UnresolvedLeafDetail` MUST add the recorded owner epoch, observed outcome digest, and safe outcome evidence.

These views MUST NOT expose credentials or private checkpoints. They MUST include ordinary unresolved effects, not only critical operations.

Each collection MUST accept its own cursor and limit. Approval and unresolved-effect collections MUST NOT share cursors.

Pages MUST use the shared default of 50 and maximum of 100. Approval order MUST use `(createdAt, requestId)`.

Cursors MUST bind endpoint, context, filter, order, gate revision, and last key.

Unknown or altered cursor fields MUST return `400 invalid_cursor`.

Each response MUST identify its observed gate revision. A later page at a changed revision MUST return `409 capability_selection_changed`.

The caller MUST obtain a new first page for that collection. Responses MUST NOT combine different revisions.

Owner reads MUST remain available during holds and MUST NOT dispatch work.

**Rationale:** Separate decision and execution states prevent approval from appearing to prove success.

**Rejected alternatives:** A single approved/completed flag conceals uncertain effects. Unbound pagination can combine incompatible queue states.

### 8. Preserve record relationships and typed history

Records MUST use the existing PostgreSQL `runtime` schema and these logical keys:

| Record | Key and enforced relationship |
|---|---|
| Approval artifact | `sha256`; immutable bytes, verified digest, and length |
| Approval request | `requestId`; unique `(runId, operationId)` and matching run, actor, operation, and workspace |
| Approval decision | `decisionId`; unique `requestId` and immutable reviewed digest |
| Workspace gate | `workspaceId` |
| Workspace leaf | Identity-derived `leafId`; reference to its existing attempt or operation |
| Owner outcome resolution | `resolutionId`; unique `leafId` |
| Mutation receipt | `(family, submissionId)`; immutable input digest and result reference |

Policy references MUST point to immutable classification and execution-policy revisions.

Foreign keys MUST prevent deletion of referenced records. Strict checks MUST reject invalid variants and inconsistent state fields.

Transactional validation MUST check canonical digests and agreement between the scope, operation binding, policy references, and workspace.

The runtime MUST use these typed run events and source keys:

| Event | Source key |
|---|---|
| `approval.requested` | `approval:<requestId>:requested` |
| `approval.decided` | `approval:<requestId>:decided` |
| `approval.outcome_resolved` | `resolution:<resolutionId>` |

Events MUST identify their corresponding immutable records. A repeated source identity MUST NOT create another request, decision, resolution, or history entry.

Ordinary unresolved effects MUST NOT acquire invented approval requests merely to fit the history interface.

Operation completion MUST retain the existing tool-history identity. Approval events MUST NOT imply confirmed execution.

The session change owns final run/session projections and historical watermark reconstruction. It MUST distinguish recorded historical events from current gate and revocation state.

The session change also owns checkpoint persistence, durable hold publication, accepted answers during holds, and complete ancestor-chain verification.

Those integrations MUST preserve this gate's admission and settlement boundaries. A waiting wrapper MUST remain logically occupied without becoming an active drain leaf.

The workspace change owns Docker creation and teardown. It MUST use the runtime ownership fence and short lifecycle coordination.

An uncertain Docker creation outcome MUST be inspected through its deterministic workspace container identity. It MUST NOT cause creation of another competing container.

Database locks MUST NOT remain held across Docker or other external work.

**Rationale:** Shared identities and enforced references prevent approval records from becoming a parallel execution system.

**Rejected alternatives:** Independent result storage or mutable history projections can disagree with the authoritative operation and its accepted execution context.

## Verification

Verification MUST cover these boundaries:

| Boundary | Required evidence |
|---|---|
| Exact scope | Reviewed and executed arguments agree. Changed targets, policy references, artifacts, and file preconditions cannot reuse approval. |
| Review safety | Unsafe, incomplete, or unverifiable content cannot be approved as exact execution. Artifact bytes preserve canonical encoding, length, and digest. |
| Admission races | Competing closure and admission produce one durable ordering. Later work receives no dispatch permission or model-step reservation. |
| Drain | Active model and tool leaves must settle. Suspended wrappers do not block drain or release occupied sessions. |
| Decisions | Concurrent approve/reject attempts produce one immutable decision. Equal receipt replay returns the original result. |
| Dispatch | Only the confirmed intent winner sends. Lost acknowledgement, existing intent, or restart does not authorize another send. |
| Settlement | Outcome, history, leaf settlement, and slot release remain atomic. Timeout alone does not prove termination. |
| Uncertainty | Ordinary and critical unresolved effects retain the hold. Owner resolution cannot fabricate results, refund work, or authorize retry. |
| Inspection | Decision and execution states remain separate. Queue pages preserve gate revision. Unknown outcomes remain visibly unknown. |
| Workspace isolation | Holds and locks do not create a global workspace barrier. |
| Native runs | A facet-free run uses its normal retained binding and still exposes workspace holds and approval state. |

Database tests MUST use real PostgreSQL constraints and competing executor contexts.

Tests MUST cover lost commit acknowledgement, stale owner epochs, cancellation before and after intent, revocation, precondition changes, and conflicting resolutions.

Model and tool transports MUST use deterministic substitutes. Tests MUST inject deadlines and failures rather than sleep through timeout bounds.

The session change owns integrated checkpoint, answer-during-hold, and ancestor-continuation tests. Those tests MUST verify that gate reopening does not bypass saved-state validation.

The workspace change owns Docker enforcement verification. Development-stack acceptance MUST include its separately identified Docker tier before full release verification is claimed.

Console behavior MUST use component and API tests. Browser checks MUST remain a small smoke and layout set using the existing design system.

A verification failure MUST stop work. Repair or rerun requires owner approval.

## Risks / Trade-offs

- **Approval covers changed content:** Bind exact immutable scope and verify file preconditions with mutation.
- **Database commit is mistaken for external execution:** Preserve the intent-to-transport gap and uncertain outcomes.
- **A waiting caller prevents drain:** Count active leaves separately from logical orchestration waits.
- **Rejection reopens the workspace too early:** Retain closure until every reopening predicate passes.
- **A cancelled run clears continuing effects:** Preserve unresolved leaves and occupied slots until valid settlement.
- **Owner testimony becomes fabricated runtime evidence:** Store the assertion separately and retain the original outcome.
- **Queue pages mix states:** Bind cursors to gate revision and reject stale continuation.
- **A partial release bypasses controls:** Keep complete workspace and session integration as release gates.

## Migration Plan

The implementation MUST create the gate, leaf, approval, artifact, decision, and resolution records in the existing runtime database.

It MUST extend the existing operation lifecycle rather than create another execution ledger.

The current schema MUST enforce immutable references, uniqueness, closed variants, and the awaiting-approval disposition.

The reset change owns the final schema inventory and any approved removal of earlier disposable records. This change MUST NOT add an automatic destructive startup migration.

Workspace registration and verified sandbox enforcement MUST be available before affected execution is enabled.

Session acceptance and recovery MUST preserve the atomic boundaries and ownership fence. A gate row alone MUST NOT establish resumable execution.

The deployment procedure MUST explain how to stop an old executor and establish that no local or remote execution continues before owner resolution.

It MUST state that a database epoch does not prove termination of network effects.

Actual deployment, resets, grant changes, critical operations, and owner outcome resolutions require their separate approvals.

## External follow-ups

| Area | Required follow-up |
|---|---|
| README | Explain exact approvals, workspace holds, individual decisions, uncertain effects, cancellation, and owner resolution. |
| Data model | Update `architecture/09-data-model-and-lifecycle.md` with keys, immutable records, admission predicates, receipts, and separate outcome assertions. |
| Security | Update `architecture/08-execution-security.md` with critical-operation boundaries and limits of external-effect fencing. |
| Runtime and deployment | Document executor shutdown, unresolved-effect procedures, independent workspaces, and reset inventory ownership. |
| Console | Provide individual approval review, separate decision/execution states, gate status, and safe unresolved-effect evidence using existing design-system patterns. |

The repository has no files under `docs/`. This decomposition does not edit those external implementation files.

## Dependencies and release boundary

This change consumes exact tool policy and mutation receipts from item 02 and registered workspace policy from item 05.

Item 08 owns the combined acceptance transaction, durable hold publication, session occupancy, prepared-step bindings, and continuation.

The owner API remains available during holds, but it does not dispatch operations itself.

There are no unresolved decisions within this local approval and gate scope. Complete runtime deployment still requires the dependent workspace and session contracts.
