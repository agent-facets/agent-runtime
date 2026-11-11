# Umbrella scope and contract ownership

This change is the source and approval-history umbrella for the [release roadmap](../ROADMAP.md).

The successor artifacts own implementation planning. The original proposal, design, and deltas remain reference material. They MUST NOT be applied or synchronized alongside the successors.

The decomposition does not archive this change, create tasks, modify main specs, or transfer adversarial reconciliation status.

## Successor key

| Order | Change | Owned scope |
|---|---|---|
| 01 | [admit-portable-facet-contributions](../admit-portable-facet-contributions/proposal.md) | Portable admission, exports, normalized sealed definitions, integrity, command text |
| 02 | [manage-definition-bound-tool-policy](../manage-definition-bound-tool-policy/proposal.md) | Tool identity, canonical names, classification, bootstrap, owner saves, receipts |
| 03 | [resolve-agent-capability-plans](../resolve-agent-capability-plans/proposal.md) | Normalized agent plans, retention data, startup preparation, bounded discovery |
| 04 | [support-canonical-provider-tool-names](../support-canonical-provider-tool-names/proposal.md) | Provider carriage and compatibility evidence |
| 05 | [configure-agent-workspaces-and-sandboxes](../configure-agent-workspaces-and-sandboxes/proposal.md) | Owner configuration, pre-run transport, Docker, workspace lifecycle, reset |
| 06 | [enforce-workspace-critical-approvals](../enforce-workspace-critical-approvals/proposal.md) | Exact approvals, gates, leaf accounting, intent, uncertainty resolution |
| 07 | [observe-runtime-message-capacity](../observe-runtime-message-capacity/proposal.md) | Monitoring-first capacity policy and faithful failures |
| 08 | [add-run-owned-agent-sessions](../add-run-owned-agent-sessions/proposal.md) | Atomic acceptance, sessions, execution, startup history, selection, continuation |

## All numbered source decisions

A row with several owners divides distinct contract portions. It does not create competing implementations of one record or transaction.

| Source decision | Primary allocation |
|---|---|
| 1. Independent agents, entry policy, depth | 03 normalized resolution; 05 serialized configuration; 08 execution enforcement |
| 2. Portable admission | 01 |
| 3. Current format and reset | 05 reset procedure and inventory; each successor owns its current record types |
| 4. Independent availability | 03 |
| 5. Dispatch permissions | 02 classification; 05 confinement; 06 critical gate; 08 invocation integration |
| 6. Exact tool identity and names | 02 canonical identity and collision rules; 04 actual provider carriage |
| 7. Classification console | 02 |
| 8. Docker and persistent workspaces | 05 |
| 9. Exact critical approvals | 06 |
| 10. Read-only discussion | 08 |
| 11. Goal/command resolution and discovery | 03 resolution; 05 placement; 06 gate; 08 atomic acceptance |
| 12. Retained records | 03 definitions; 02/05/06 owned policy records; 08 session and acceptance integration |
| 13. Creation and admission | 03 submitted-input identity; 06 workspace admission; 08 combined transaction and continuation |
| 14. Startup | 03 content preparation; 08 durable supply, history, replay, and selection reconciliation |
| 15. Inspection and owner interfaces | 03 prepared information; 02 classifications; 05 pre-run routes; 06 approvals; 08 history and sessions |
| 16. Continuation and reset boundary | 08 current-run continuation; 05 reset and pre-reset refusal |
| 17. Verification | Each owner verifies its work; 01/03/08 divide facet proof; 09 integrates release evidence |
| 18. Synchronous discussion | 08 |
| 19. Shared nesting depth | 03 retained policy; 08 execution, instructions, and tool exposure |
| 20. Shared budget and suspended callers | 08 model accounting and session occupancy; 06 active-leaf drain |
| 21. Same-run reusable sessions | 08 |
| 22. Session state and owner-selected agents | 08; consumes 03's immutable plans |
| Message-size and monitoring policy | 07, including the operational prerequisite for other owners' affected paths |

## Detailed source contracts

| Contract | Ownership and boundary |
|---|---|
| 12A | 03 owns retained capability shapes, definition references, restriction scopes, and canonical hashes. 08 commits them with the session and run. |
| 12B | 02 owns classification identity and revisions. 05 owns workspace and Docker policy. 08 retains exact execution-manifest references. |
| 12C | 06 owns approval scope, immutable review content, and preconditions. |
| 12D | Each successor owns its record constraints. 08 owns the combined session/run acceptance and execution relationships. |
| 13A | 06 owns gates, leaves, locking, and drain. 08 integrates session admission and occupancy atomically. |
| 13B | 06 owns decisions, intent, dispatch, cancellation outcomes, and owner uncertainty resolution. |
| 13C | 08 owns held checkpoint publication, answer acceptance during holds, and complete ancestor verification. |
| 13D | 03 owns submitted identity. 08 owns accepted lookup, final rechecks, and creation races. |
| 15A | 05 owns owner start/options and pre-run transport, consuming 03's prepared data and revisions. |
| 15B | 02 owns classification inspection and saves. |
| 15C | 06 owns approval and unresolved-effect interfaces. |
| 15D | 02 owns common receipts. Each mutation owner defines its semantics. 08 owns historical projection and session selection. |

## Transactions that MUST remain intact

- Run acceptance MUST commit the run, entry session, capability binding, initial execution, startup supply, and creation history together.
- Child admission MUST combine workspace admission, same-run checks, and exclusive session activation. A suspended wrapper is not an active drain leaf.
- Turn completion MUST preserve conversation, terminal result, parent outcome, history, and safe session release without partial visibility.
- Critical request creation MUST bind immutable scope and close admission atomically. Dispatch intent and the critical slot MUST have one confirmed winner.
- Checkpoint persistence MUST be confirmed before a resumable hold is published. A gate alone does not prove a valid continuation.
- Classification and owner mutations MUST commit their immutable result and receipt together. Equal replay must not overwrite later state.

The physical session, checkpoint, and owner-inspection contracts remain design work in 08. Docker placement and discovery integration remain design work in 05.

## Source clauses that span several successors

| Source concern | Allocation rule |
|---|---|
| Facet selection and configuration capacity | 03 resolves candidates; 05 owns the file and validation lifecycle; 07 governs aggregate size; 08 enforces accepted context. |
| Startup activation | 03 prepares exact required content. 08 owns initial supply, repeated loads, history, selection changes, and failure scope. |
| Critical operations and classification | 02 defines reviewed tool policy. 06 approves exact operations. 08 keeps discussion and ancestor restrictions effective. |
| Immutable classification and execution policies | 02 owns classification records; 05 owns workspace policies and the reset boundary. |
| Complete retained definitions | 03 prepares the catalog; 02 owns tool-policy identity; 08 commits and reuses it; 07 gates ceiling removal. |
| Goal and command admission | 01 defines portable text semantics; 03 prepares inputs; 05 exposes owner choices; 06 supplies admission; 08 commits execution. |
| Owner inspection | Prepared availability, current grants, recorded use, owner decisions, and runtime outcomes MUST remain distinct. Each interface owner implements its own projection. |
| Runtime recovery | 06 preserves unresolved effects. 08 preserves the logical session and checkpoint chain. 05 owns operational shutdown and reset procedures. |

The [scenario map](./traceability.md) assigns each source scenario one primary successor. Integration scenarios can exercise several contracts without duplicating their implementation ownership.

## Verification and external follow-ups

| Work | Owner |
|---|---|
| Published facet admission and regenerated export evidence | 01 |
| Deterministic startup content and independent selections | 03 |
| Integrated startup, delegate exclusion, nested execution, and bounded live proof | 08; release gate 09 and separate live approval |
| Classification data, stale-save behavior, native bootstrap, and configuration page | 02 |
| Gate races, exact approvals, dispatch uncertainty, and resolution controls | 06 |
| Configuration example, Docker verification, reset targets, and deployment procedure | 05 |
| Provider-name transport and compatibility documentation | 04 |
| Conversation, checkpoint, session history, and selection UI | 08 |
| Capacity failures, collection topology, independent host evidence, and limit-removal verification | 07 |

Each successor MUST retain documentation/data-model, runtime/deployment, and console follow-ups. The original external documentation remains unchanged by this decomposition.

## Planning status and historical limits

Designs are present for 01, 02, 03, and 06. Designs are deliberately absent for 04, 05, 07, and 08. No implementation tasks are authored here.

The source design's partial session sketches are not substitute designs for 08. The source's rejected adversarial recommendations remain rejected, not implicit defaults.

All original adversarial artifacts, reviews, and state are retained unchanged. Their status records historical reconciliation, not review of later successor artifacts.

The owner approved final batch completion without further item-by-item prompts on 2026-11-11. Individual artifact review is deferred.

Full official STE Dictionary verification remains incomplete. The release is not implemented, deployed, or proven live by these planning artifacts.
