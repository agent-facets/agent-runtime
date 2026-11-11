# Proposal

## Why

Agents need reusable conversations within a run without confusing conversation history, execution state, or current authority. The runtime also needs one atomic acceptance and continuation contract for goal runs, command runs, delegated tasks, and discussions.

## What Changes

- Every actor SHALL use a session owned immutably by its creating run. Configured-agent identity, session identity, and execution-turn identity SHALL remain distinct.
- Goal and command runs SHALL use their selected entry agent's retained configuration. Commands SHALL add task instructions and restrictions, not capabilities.
- Acceptance SHALL atomically retain the run, entry session, capability binding, initial execution, complete startup supply, and creation history.
- Accepted retries SHALL return the original run before current configuration or provider-readiness checks.
- Task delegation SHALL enforce each caller's explicit outgoing relationships and the retained depth limit.
- A synchronous `tool__Discuss` call SHALL create a consultation turn in a new or accessible existing session of the same run.
- New discussion sessions MAY use any permitted retained configuration, including the caller's own. A task-delegation relationship SHALL NOT be required.
- Discussion SHALL remain read-only and prohibit task delegation, mode escape, and indirect prohibited actions. Advice SHALL NOT grant authority.
- A session SHALL have at most one active execution. Waiting for a child, approval, or owner answer SHALL keep it occupied.
- Busy targets and waiting ancestors SHALL be refused without queues, interruption, or substitution of another session.
- Task and discussion children SHALL share path-local depth and the run's model-step budget. Returns and later turns SHALL NOT reset consumed work.
- Runtime instructions SHALL expose mode, depth, remaining child levels, and permitted child interactions. Dispatch checks SHALL enforce those restrictions independently.
- Only the owner MAY select another configuration for a session, from the run's retained configurations.
- Each model-step preparation SHALL capture the latest committed selection. Already-prepared requests and their resulting tool calls SHALL retain their captured configuration.
- Selection changes SHALL preserve session identity, history, run, workspace, provider, mode, depth, and consumed budget. They SHALL NOT interrupt work or enqueue input.
- Historical instructions SHALL remain separate from current capability and permission. Startup supply SHALL avoid duplicate bodies and synthetic tool calls.
- Conversation history SHALL remain ordered and replay-safe, separately from execution checkpoints.
- Durable holds and permitted continuation SHALL preserve captured context, caller chains, and uncertainty controls. They SHALL NOT reopen terminal runs or repeat uncertain effects.
- Agent discovery SHALL expose only accessible sessions of the current run. Owner inspection of older history SHALL NOT make those sessions callable.
- Every new run SHALL start fresh sessions. Run completion SHALL prevent new turns without automatically deleting retained history.

## Non-goals

This change SHALL NOT add cross-run invocation, automatic history import, memory extraction, learning, or dreaming.

It SHALL NOT add background consultations, busy-session queues, active-session steering, automatic compaction, or a separate chat interface.

It SHALL NOT add a claim table, lease service, second operation ledger, or separate native-only configuration record.

It SHALL NOT replace the approved tool-policy, workspace, approval, provider-carriage, or capacity contracts.

It SHALL NOT execute deployment, resets, production facet changes, grant changes, or live provider traffic during this decomposition.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `capabilities`: Session-scoped discussion, owner selection, current capability enforcement, bounded child interactions, and authority that history cannot expand.
- `execution`: Atomic acceptance and startup, session turns, ordered conversation, prepared-step bindings, replay, held continuation, and accurate inspection.

## Design work remaining

The design MUST complete and review:

- Durable conversation records, message identities, ordering, and source references.
- Context boundaries for new turns and reuse after failed or incomplete turns.
- Prepared-step capture, instruction-supply provenance, and checkpoint bindings.
- Atomic acceptance, child admission, completion, and session release under the existing ownership fence.
- Integration of workspace holds, control tools, owner answers, cancellation, and complete ancestor-chain verification.
- Closed owner-inspection interfaces and historical pagination.
- Startup failures after owner selection and result attribution when a turn uses several selected configurations.
- Current-schema constraints and the record inventory needed by the separately approved reset.

Same-run ownership, owner-only selection, next-preparation timing, the session catalog, and the owner selection route are already approved constraints.

No `design.md` or `tasks.md` SHALL be created during this decomposition.

## Impact

This change is item 08 in the [release roadmap](../ROADMAP.md). It integrates retained capability plans, tool policy, provider carriage, workspace controls, critical approvals, and the monitoring-first capacity policy.

Affected areas include run acceptance, actor execution, session persistence, startup membership, model preparation, operation replay, checkpoints, owner APIs, and console history.

Verification SHALL cover concurrency, same-run access, busy refusal, depth, shared budgets, owner selection, exact replay, failed-turn handling, and held continuation.

The integrated `voice-to-text` proof SHALL verify first-request startup supply, delegate isolation, and independent startup selection for both agents.

The bounded live proof SHALL wait for release integration and separate approval. Deterministic tests SHALL remain the primary behavior coverage.

The root README's Agent execution, Persistence, and Browser console and API sections informed this proposal.

External follow-ups SHALL include those sections, `architecture/09-data-model-and-lifecycle.md`, deployment recovery guidance, and session console patterns under `DESIGN_SYSTEM.md`.

The repository has no files under `docs/`. This decomposition SHALL NOT edit those implementation files.
