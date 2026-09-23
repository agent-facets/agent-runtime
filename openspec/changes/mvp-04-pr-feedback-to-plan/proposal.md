# Proposal

## Why

PR feedback is a useful test of the generalized framework: the agent must investigate independently, bring evidence to human decisions, remember applicable preferences, and deliver a usable artifact. Today the existing review facet requires repeated per-item gates and stops without producing a VIPER plan, leaving the owner to repeat preferences and translate accepted feedback into implementation work.

This is phase 4 of [the framework MVP roadmap](../../roadmaps/framework-mvp.md). It depends on [`mvp-01-interactive-agent-execution`](../mvp-01-interactive-agent-execution/proposal.md), [`mvp-02-facet-backed-capabilities`](../mvp-02-facet-backed-capabilities/proposal.md), and [`mvp-03-cross-run-memory`](../mvp-03-cross-run-memory/proposal.md). These are proposal dependencies, not claims of implemented functionality.

## What Changes

- **Submit a PR for investigation.** The user SHALL be able to start the workload with a GitHub PR URL or repository/PR identifier. The agent SHALL collect line comments, review summaries, and general PR comments, inspect relevant code, and prepare evidence-linked recommendations without requesting permission for each read. Incomplete access or retrieval SHALL be reported rather than presented as a complete review.
- **Review recommendations, not raw dumps.** Each item SHALL show its source, relevant code context, assessment, and proposed disposition. Recommendations SHALL remain distinct from final decisions. Changed feedback or code that invalidates an assessment SHALL require renewed review rather than silently inheriting an earlier verdict.
- **Choose individual or batch decisions.** The user SHALL be able to accept, ignore, or discuss an item, or explicitly decide a displayed selection of items together. A batch decision SHALL identify exactly which items it covers. Discussion, a draft reply, or a conversational affirmative SHALL NOT finalize a verdict or advance unresolved work.
- **Make noise handling configurable and inspectable.** Explicit scoped preferences SHALL be able to exclude non-actionable automation from the decision queue without repeating the same confirmation on every PR. Excluded items SHALL remain visible with their reasons and applicable rule, and the user SHALL be able to restore them. A bot's identity or an inferred preference alone SHALL NOT hide actionable findings.
- **Preserve a review record.** The workload SHALL produce a local report linking feedback, evidence, decisions, and exclusions. Its writes SHALL be confined to the approved report destination; reports SHALL remain distinct from the runtime's authoritative decision records.
- **Generate the VIPER handoff.** Accepted feedback SHALL become a proposed VIPER plan with links to the originating items, bounded implementation scope, verification work, and the required step ordering and approval gates. Ignored or unresolved feedback SHALL NOT silently become implementation scope. The user SHALL review the complete plan and choose whether to retain model-switch pauses before it is saved through the existing VIPER plan tools.
- **Keep saving separate from execution.** The saved plan SHALL have a visible name and location in the intended workspace. Saving or approving that plan SHALL NOT execute it, modify application source, or post to GitHub.
- **Reuse and correct preferences.** Outcomes SHALL use phase 3's attributed retention and scoped instruction handling. A decision about one PR SHALL NOT automatically become a standing instruction. An explicit preference correction SHALL affect subsequent applicable reviews without rewriting historical verdicts.

## Acceptance Journey

1. On a first PR, the agent investigates and presents recommendations. The owner discusses an edge case; no verdict changes. The owner then accepts a displayed selection, affecting exactly those items.
2. The owner records a repository-scoped instruction to exclude non-actionable bot overviews. A fresh review applies it, while an actionable finding from the same bot remains reviewable and all exclusions remain inspectable.
3. The owner corrects or disables that instruction. After the correction completes, another review follows the new instruction; a different repository never receives the repository-specific rule.
4. The agent drafts a VIPER plan covering the accepted work. The owner approves its content and pause choice; the saved artifact is available for a separate execution session. No source changes or GitHub writes occur.

## Capabilities

### New Capabilities

- `reviews`: Investigating feedback against relevant evidence, presenting recommendations, discussing and recording explicit dispositions, and inspecting configurable exclusions.
- `planning`: Producing reviewable VIPER plans from accepted work and saving approved plans for separate execution.

### Modified Capabilities

- `execution`: Human decisions can cover explicitly identified item selections, and runs expose their review-report and plan artifacts. The later delta extends the execution baseline established by phases 1–3 after their archival; it does not create a PR-specific runtime core.

## Impact

- **Workload and facets:** adapt authored `@agentfacets/address-pr-feedback` assets for the runtime, selected-item batches, configurable exclusions, and the planning handoff. Version 2.0.5 explicitly forbids general batching and excludes useful bot summaries from its noise batch; memory cannot override those instructions. Existing `viper-plans` assets and MCP storage are reused, with authored compatibility adjustments only where necessary. Materialized `.opencode` copies are not edited as source.
- **Permissions and integration:** GitHub access is read-only. Reports and approved plans are narrow, owner-configured artifact-write exceptions to earlier read-only defaults, not general mutation authority. MCP processes use the intended workspace and preserve read-before-edit safeguards. Publishing facets is unnecessary for a local integration.
- **Documentation:** no relevant `docs/` documentation exists; the root `README.md` is Bun scaffold documentation. Authored PR-review skill/command files in the sibling facet registry and the sibling `viper-plans/README.md` informed this proposal. Implementation SHALL document workload setup, GitHub access, artifact locations, decisions, and preference handling in the runtime README and affected authored facet documentation, and reconcile the old delivery roadmap.

## Non-goals

- Executing generated plans, changing source code, posting replies, resolving GitHub threads, or publishing facets.
- A PR-specific application architecture, autonomous verdicts on substantive feedback, or memory-based authorization.
- New memory machinery, another plan store, generalized scheduling, or a production security platform.
- Automatic facet rewriting from learned preferences, or support for every review provider beyond the GitHub workload.
