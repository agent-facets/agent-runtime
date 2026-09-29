# Proposal

## Why

The owner needs to hand a repository task to an agent from a browser, leave, return, answer a question, and collect the result using an existing subscription. Separate spikes demonstrated provider transports and persistence safeguards, but not their integration under Bun in an interactive agent. This phase delivers that usable foundation before facets, memory, and the PR-feedback workload depend on it.

This is phase 1 of [the framework MVP roadmap](../../roadmaps/framework-mvp.md).

## What Changes

- **Development foundation.** Extend the existing Bun and TypeScript scaffold into a Bun-workspace monorepo orchestrated by Turborepo, with separate runtime and UI packages delivered as one application. Provide mise-managed pinned tools, one lockfile, reproducible install/build/run/test/typecheck/lint commands, and root README setup instructions.
- **Agent runs.** A user can start an agent task with a goal and receive a run that has a stable identity, a visible status, a progress history, and a final result or failure.
- **Browser console.** A small web console lists runs, shows a run's conversation and progress as it happens, presents questions the agent asks, accepts answers, and shows results. It is reachable from other devices on the owner's private network.
- **Leave and return.** Closing or losing the browser does not stop a run. Reopening the console shows the run's current state and everything that happened while the user was away.
- **Human questions.** An agent can pause to ask the user a question. Persisted questions survive ordinary runtime restarts, and an answer is applied once despite duplicate submissions. If saved state is incompatible with the current runtime, continuation is visibly refused rather than delivering the answer to different work.
- **Interruption is visible, not hidden.** If the runtime stops while a run is actively working, the run is shown as interrupted with its last recorded progress. It is not resumed automatically or manually, or reported as successful.
- **Two subscription providers.** Anthropic delivers the first usable slice; OpenAI completes the phase. The run's provider is visible. Authorization problems, quota/rate limits, and other failures are distinguishable. Neither billed API fallback nor silent provider switching is allowed.
- **Provider authorization.** The owner can establish and renew subscription access without a browser on the runtime host. Usable authorization survives ordinary runtime restarts; authorization failures explain how to restore access.
- **Cancellation.** The owner can cancel a working or waiting run. Once cancellation is accepted, no further agent work is dispatched; stopping in-flight work is best-effort. Cancellation survives ordinary restart and does not become a successful result.
- **Bounded work.** Each run has a finite, owner-configurable maximum number of agent steps, with documented counting rules. Exceeding the limit produces a visible failure; human pauses and restarts do not reset the budget.
- **Limited tool surface.** Agents can read and search files within an explicitly configured workspace and ask the user questions. They cannot edit files, run arbitrary commands, or change external systems.
- **Credential hygiene.** Provider credentials stay out of agent context, tool results, run history, progress events, results, the console, and diagnostic logs.

**Phase exit.** With either provider, the owner can start a task, observe it, leave, return, answer a question, and obtain the result. Anthropic is usable independently. Assess OpenAI integration cost before its implementation block and revisit the phase explicitly if disproportionate cost emerges; do not silently omit it.

## Capabilities

### New Capabilities

- `execution`: Starting, observing, cancelling, and finishing bounded agent runs; answering questions; establishing and renewing subscription access; selecting a provider; and seeing interruptions and classified failures.

### Modified Capabilities

None. The only existing capability is `spec-governance`, which this change follows but does not modify.

## Impact

- **Code:** first application code in the repository — separate runtime and browser UI packages, provider access, and tests, delivered as one application. Browser-safe API contracts become a shared package when the API is implemented. Spike code under `spikes/` is a reference for extraction, not a dependency.
- **Dependencies:** LangChain and LangGraph, provider integrations, and PostgreSQL for durable state; Turborepo for development task orchestration, not an operational service or agent framework. After scaffolding, verify Bun compatibility of the agent harness, official PostgreSQL checkpointer, and subscription transports before building out the console. The checkpointer's node-postgres dependency and transports tested on Node are integration risks. Any runtime fallback requires explicit replanning, not an implicit switch from Bun.
- **Provider risk:** subscription client requirements can change. Unsupported transport behavior is reported visibly rather than bypassed through a different provider or billed API access.
- **Systems:** a local PostgreSQL instance becomes required. The runtime binds to a private-network address; no public exposure.
- **Evidence it builds on:** spikes 03 and 04 demonstrated the subscription transports separately; spikes 05 and 06 established the checkpoint durability, one-writer-per-run, compatibility, and interrupt-identity safeguards this phase must honor. None of these was demonstrated with Bun or with the agent harness, so each is re-verified here rather than inherited.
- **Documentation:** no `docs/` directory exists, and the root `README.md` contains only the `bun init` boilerplate; neither informed this proposal. The root `README.md` is rewritten with setup and usage. Architecture documents informing this proposal — `architecture/README.md`, `02-control-plane.md`, and `05-model-authentication.md` — describe pre-implementation intent; their reconciliation with the `createAgent` harness and the console is recorded as an obligation in the roadmap and is detailed in this change's design.

## Non-goals

- **Automatic or manual crash recovery.** Interrupted runs remain inspectable but cannot be resumed; further work starts a new run. No exactly-once guarantee is offered for work in progress.
- **Host reboot guarantees.** Only an ordinary runtime restart is in scope.
- **Facet-provided skills, agents, commands, or MCP tools.** Phase 2.
- **Cross-run memory or preferences.** Phase 3.
- **Mutating tools** — file edits, shell commands, GitHub posting, or any external change.
- **Providers beyond Anthropic and OpenAI subscriptions**, and API-key billing as a fallback.
- **Concurrent writers to one run**, scheduling, queues, or multi-user access.
- **Production security infrastructure.** Access relies on the owner's private network; credential hygiene and the limited tool surface are still required.
- **A polished or mobile-specific interface.** The console is minimal and functional.
- **Subagents, multi-agent topologies, or workflow graphs** beyond a single agent run.
- **Run deletion, retention-policy or export tooling, and usage/cost dashboards.** Failure explanations remain in scope.
