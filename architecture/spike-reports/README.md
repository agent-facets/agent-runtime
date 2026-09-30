# Spike Reports

Findings from the P0 spikes listed in
[10-delivery-phases.md](../10-delivery-phases.md).

A spike answers one question that could change the architecture. Its code is
throwaway; its report is not. Each report records what was measured, how to
reproduce it, and what the architecture must change as a result.

**A reproducible negative result is a successful spike.** These reports exist
to kill assumptions early, not to confirm them.

## Status

| # | Spike | Question | Outcome |
|---|---|---|---|
| [01](./01-obsidian-headless.md) | Obsidian headless | Does it boot, open a vault, and leave restricted mode without a GUI? | **Pass** |
| [02](./02-obsidian-loopback-bridge.md) | Loopback bridge | Can a separately networked runtime reach the loopback-only plugin, and what is the minimum mediation? | **Pass** |
| [03](./03-anthropic-parity.md) | Anthropic parity | Does a decorated fetch from a LangChain client match the reference profile? | **Pass** |
| [04](./04-openai-device-auth.md) | OpenAI device auth | Does device-code login complete in a container and refresh? | **Pass** |
| [05](./05-langgraph-durability.md) | LangGraph durability | Does a run resume correctly after a kill mid-run and mid-interrupt? | **Pass**, scoped |
| [06](./06-postgres-checkpointer-concurrency.md) | Postgres checkpointer and Store | Do the official checkpointer and Store behave as documented under concurrency? | **Pass**, with required safeguards |
| [08](./08-observation-to-knowledge-reconciliation.md) | Observation to knowledge | Can an evidence-backed observation become durable, human-approved knowledge a later task retrieves? | **Pass**, scoped |

## MVP integration evidence

Added 2026-09-29. These records verify the Phase-1 build
([mvp-01](../../openspec/changes/mvp-01-interactive-agent-execution/tasks.md)) under Bun. They are separate from
the original spike results above, which were measured on Node and are left unchanged.

| Gate | Record | Outcome |
|---|---|---|
| G1 — Bun persistence and ownership | [g1-bun-persistence.md](../integration-evidence/mvp-01/g1-bun-persistence.md) | **Pass** (early gate), with a Bun SQL pool defect found and mitigated |
| G3 — Harness dispatch and lifecycle (added 2026-09-30) | [g3-dispatch-lifecycle.md](../integration-evidence/mvp-01/g3-dispatch-lifecycle.md) | **Pass** with provider-free models; real-provider gates outstanding |
| G2 — Internal Anthropic subscription boundary (added 2026-09-30) | [g2-anthropic-boundary.md](../integration-evidence/mvp-01/g2-anthropic-boundary.md) | **Pass** offline against synthetic issuers; live login outstanding |
| G4 — Anthropic transport, offline part (added 2026-09-30) | [g4-anthropic-offline.md](../integration-evidence/mvp-01/g4-anthropic-offline.md) | **Pass** offline, including the production assembly on the official saver; live journey outstanding |
| G5 — OpenAI transport, offline part (added 2026-09-30) | [g5-openai-offline.md](../integration-evidence/mvp-01/g5-openai-offline.md) | **Pass** offline; Bun `fetch` selected; device auth and live journey outstanding |
| Anthropic code ownership (added 2026-09-30) | [upstream-handoff.md](../integration-evidence/mvp-01/upstream-handoff.md) | **Decision record**: internal derivative of the maintained plugin replaces the planned upstream release; provenance and differences recorded. Not a gate result |
| OpenAI cost checkpoint (added 2026-09-30) | [openai-cost-checkpoint.md](../integration-evidence/mvp-01/openai-cost-checkpoint.md) | **Decision record**: proceed, moderate cost; Bun `fetch` selected over `node:http` by a loopback capture. Not a gate result |

## Working records

A report is the conclusion; it is not the notebook. Where a spike's reasoning is
worth keeping — the source reading its criteria were written against, the claims
it had to correct, the defects found by running it — that record is kept beside
the report as an appendix and linked from it.

| Spike | Working record |
|---|---|
| 06 | [06-postgres-checkpointer-concurrency-appendix.md](./06-postgres-checkpointer-concurrency-appendix.md) |

Appendices are laboratory notebooks: written incrementally, containing superseded
claims that are marked in place rather than erased. They do not follow the report
structure below, and **where an appendix and its report disagree, the report is
current.**

## Report structure

Every report carries the same sections so they can be compared and audited:

```text
Outcome              pass | partial | fail, stated first
Question             the single thing the spike answers
Environment          host, versions, immutable inputs
Method               what was run, and how to run it again
Acceptance           the matrix, with measured results
Findings             what was learned, including surprises
Architecture impact  what changes in the design documents
Limitations          what this spike does NOT establish
Reproducing          the exact commands, and where evidence lands
```

## Evidence

Reports cite sanitized evidence. Raw evidence lives under
`tmp/spikes/<name>/<run-id>/` and is git-ignored: it contains machine-specific
paths and is regenerated by re-running the harness.

No report contains a credential. Secrets are compared by digest and never
reproduced.
