# Proposal

## Why

This change is a coordination umbrella. It is not an executable change and it is not a ninth feature. It records how the owner divided the original plan into eight successor changes.

The original goal was to use the published `voice-to-text` skill in ordinary goal runs without author changes or a wrapper command. Consumer-owned facet selection remains the release's purpose.

The original plan grew into a large set of related contracts. The owner approved a split of that plan into eight successor changes. Each successor owns a part of the original scope for design, tasks, implementation, and verification.

Related documents:

- [Roadmap](../ROADMAP.md) shows the order of the successor changes and the release gate.
- [Scope map](./scope-map.md) shows which successor owns each source decision and contract.
- [Traceability](./traceability.md) maps each source requirement and scenario to its successor owners.
- [Source proposal](./source-proposal.md) is the original proposal. It keeps the original bytes, including the review notes.

## What Changes

- This umbrella keeps the approved split of the original scope into these eight successor changes:
  - 01 [admit-portable-facet-contributions](../admit-portable-facet-contributions/proposal.md)
  - 02 [manage-definition-bound-tool-policy](../manage-definition-bound-tool-policy/proposal.md)
  - 03 [resolve-agent-capability-plans](../resolve-agent-capability-plans/proposal.md)
  - 04 [support-canonical-provider-tool-names](../support-canonical-provider-tool-names/proposal.md)
  - 05 [configure-agent-workspaces-and-sandboxes](../configure-agent-workspaces-and-sandboxes/proposal.md)
  - 06 [enforce-workspace-critical-approvals](../enforce-workspace-critical-approvals/proposal.md)
  - 07 [observe-runtime-message-capacity](../observe-runtime-message-capacity/proposal.md)
  - 08 [add-run-owned-agent-sessions](../add-run-owned-agent-sessions/proposal.md)
- The original proposal moves to `source-proposal.md` without changes. This proposal replaces it as the umbrella summary.
- The source design and the original delta specs stay in this change as the approval reference. They are superseded for implementation ownership. The successor changes own all implementation work.
- This umbrella MUST NOT receive implementation tasks or be applied, archived, or synchronized alongside the successors. Successors supply the implementation deltas.
- The source adversarial artifacts, reviews, and state stay unchanged. Their statuses record the historical reconciliation of the source artifacts. They do not certify a successor file.
- Release 09 in the roadmap is a gate, not a change. It integrates release evidence. The actual reset, deployment, grants, production facets, and live provider traffic are separate operations that need separate owner approval.
- The main specs under `openspec/specs/` do not change. The application source does not change.

### Planning status

- Designs are present for successors 01, 02, 03, and 06.
- Designs are not present for successors 04, 05, 07, and 08.
- No successor has tasks. This umbrella has no tasks.
- The prompt session catalog and owner selection route are settled. Conversation, checkpoint, and owner-inspection contracts in 08 remain incomplete. The design areas of 04, 05, and 07 are also incomplete.
- A tasks-ready status from the OpenSpec tool does not show that a successor is ready for implementation. Each successor needs a complete, approved design and approved tasks first.

### Review and language status

- On 2026-11-11, the owner gave explicit approval to complete this final planning batch without more item-by-item prompts. The individual review of each final artifact is deferred.
- The full verification of the text against the official STE Dictionary is not complete. These artifacts do not claim STE compliance.

## Non-goals

- New feature scope. The traceability files map all 69 source requirements and 341 source scenarios to successor owners. They also identify 16 supplementary scenarios for already-approved safeguards.
- New global design decisions. This umbrella does not change, add, or remove a source decision.
- New workflow schema or status flags in this umbrella's `.openspec.yaml`.
- Tasks, implementation, apply, archive, or spec sync for this umbrella.
- Loss of approval history. The source proposal and adversarial files remain byte-identical. The source design and deltas retain their original content with umbrella notices and identified consistency corrections.
- Changes to the main specs, the application source, the external documentation, or a deployment.
- The reset, deployment, grants, production facet installation, and live provider traffic. These operations stay separate and need separate owner approval.

## Capabilities

### New Capabilities

None. This umbrella does not add a product domain.

### Modified Capabilities

- `capabilities`: Historical scope only. The original delta specs record the source scope for this existing capability. Successors 01, 02, 03, 05, 06, and 08 own the implementation deltas.
- `execution`: Historical scope only. The original delta specs record the source scope for this existing capability. All eight successors own implementation deltas for this capability.

The [scope map](./scope-map.md) gives the exact owner of each part. This umbrella does not apply either delta.

## Impact

- **Planning artifacts:** This change preserves `source-proposal.md`, replaces this proposal, and adds scope and traceability maps. Umbrella notices identify the retained design and deltas as source references. The stale native-snapshot test wording is corrected to the approved uniform-retention contract.
- **Successor changes:** Each successor owns its design, tasks, implementation, and verification. Each successor also owns its follow-ups in three areas:
  - Documentation and data model.
  - Runtime and deployment.
  - Console.
- **External follow-ups:** The root README, the runtime facet installation guide, and the capability configuration example stay unchanged in this change. The successor that owns the related work updates them.
- **Code and data:** No effect. The application source, the main specs, the database, and the deployment do not change.
- **Release:** The roadmap gate 09 collects the evidence from the successors. The release is not implemented, deployed, or proven live by these planning artifacts.
