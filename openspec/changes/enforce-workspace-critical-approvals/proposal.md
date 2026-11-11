# Proposal

## Why

A critical operation needs approval for its exact effect, not general permission for later work. Shared workspaces also need a durable admission gate that remains effective across concurrent runs, failures, and restarts.

## What Changes

- A critical request SHALL bind its workspace, run, actor, operation, reviewed tool definition, policy revisions, target, and exact arguments or immutable change content.
- Changed execution scope SHALL require new approval. One decision SHALL NOT approve unrelated operations or resolve other requests.
- Request creation and workspace gate closure SHALL be atomic.
- The gate SHALL block new agent dispatch across all runs using that workspace while allowing previously admitted leaf work to settle.
- Suspended delegation and discussion wrappers SHALL NOT count as active leaf effects merely because they await a child.
- Individually approved critical operations SHALL execute one at a time per workspace.
- Approval, dispatch intent, runtime outcome, and owner assertions SHALL remain distinct durable facts.
- Unconfirmed execution SHALL retain the hold. Retry, restart, or a new ownership epoch SHALL NOT authorize another send.
- Owner resolution SHALL identify the exact unresolved effect and observed state. It SHALL require the old executor to be stopped and preserve uncertainty honestly.
- Resolution SHALL NOT fabricate output, refund model work, rewrite the runtime outcome, or authorize retry.
- Owner inspection and individual decision controls SHALL remain available during holds.
- Workspace gates SHALL remain independent. A hold in one workspace SHALL NOT pause unrelated workspaces.

## Non-goals

This change SHALL NOT define Docker provisioning, owner configuration, or workspace storage layout.

It SHALL NOT define session conversation, checkpoint capture, held-run continuation, or owner agent switching.

It SHALL NOT add a second operation ledger, a general approval platform, bulk permission approval, or automatic classification.

It SHALL NOT promise exactly-once external effects, undo completed effects, or treat database fencing as proof that external work stopped.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `capabilities`: Exact critical-operation approval, independent effect and critical declarations, and owner authority that does not expand discussion permissions.
- `execution`: Durable workspace admission, leaf-effect accounting, critical dispatch, truthful uncertainty resolution, and inspectable decisions and outcomes.

## Impact

This change is item 06 in the [release roadmap](../ROADMAP.md). It consumes definition-bound tool policy, mutation receipts, and registered workspace policy.

The session change owns atomic integration with actor admission, durable holds, answers, and checkpoint continuation. Approval drain SHALL NOT release a session that remains occupied.

Affected areas include operation records, workspace gates, approval artifacts, executor admission, owner APIs, and console approval surfaces.

Verification SHALL cover concurrent admission, gate closure, individual decisions, dispatch intent, lost acknowledgements, stale owners, unresolved ordinary effects, and independent workspaces.

The root [README](../../../README.md#authority-boundaries) and its persistence and console/API sections informed this proposal.

External follow-ups SHALL include `architecture/08-execution-security.md`, `architecture/09-data-model-and-lifecycle.md`, deployment guidance, and console patterns for approvals and unresolved effects.

Console behavior SHALL use component and API tests, with limited browser smoke and layout checks.

The repository has no files under `docs/`. This decomposition SHALL NOT execute operations, change grants, deploy controls, or resolve actual uncertain effects.
