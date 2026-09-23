# Proposal

## Why

The runtime has no way to run an agent today: the repository holds a Bun hello-world scaffold and throwaway spike harnesses. Every later phase — facet-backed capabilities, cross-run memory, and the PR-feedback workload — needs a place where an agent task can be started, watched, paused for a human, and finished, so the smallest useful foundation comes first.

This is phase 1 of [the framework MVP roadmap](../../roadmaps/framework-mvp.md).

## What Changes

- **Development foundation.** Extend the existing Bun and TypeScript scaffold with pinned tool versions managed by mise, reproducible install, run, test, typecheck, and lint commands, a minimal application layout, and setup instructions in the root `README.md`.
- **Agent runs.** A user can start an agent task with a goal and receive a run that has a stable identity, a visible status, a progress history, and a final result or failure.
- **Browser console.** A small web console lists runs, shows a run's conversation and progress as it happens, presents questions the agent asks, accepts answers, and shows results. It is reachable from other devices on the owner's private network.
- **Leave and return.** Closing or losing the browser does not stop a run. Reopening the console shows the run's current state and everything that happened while the user was away.
- **Human questions.** An agent can pause to ask the user a question. The question stays visible and answerable until answered, including after an ordinary restart of the runtime. An answer is applied once, even if it is submitted twice.
- **Interruption is visible, not hidden.** If the runtime stops while a run is actively working, the run is shown as interrupted with its last known progress. It is not silently restarted, retried, or reported as successful.
- **Two subscription providers.** Runs can use the owner's Anthropic subscription, delivered first, and the owner's OpenAI subscription, completing the phase. The provider used by a run is visible. Authentication problems are reported to the user and never cause a silent switch to billed API access.
- **Limited tool surface.** Agents can read and search files within an explicitly configured workspace and ask the user questions. They cannot edit files, run arbitrary commands, or change external systems.
- **Credential hygiene.** Provider credentials never appear in run history, progress events, results, or the console.

## Capabilities

### New Capabilities

- `execution`: Starting agent runs, observing their progress, answering agent questions, receiving results, selecting a model provider, and seeing interruptions and failures.

### Modified Capabilities

None. The only existing capability is `spec-governance`, which this change follows but does not modify.

## Impact

- **Code:** first application code in the repository — runtime service, browser console, provider access, and tests. Spike code under `spikes/` is a reference for extraction, not a dependency.
- **Dependencies:** LangChain and LangGraph for the agent loop and checkpointing, provider integrations for Anthropic and OpenAI, and PostgreSQL for durable state. Bun compatibility of these packages is verified during implementation.
- **Systems:** a local PostgreSQL instance becomes required. The runtime binds to a private-network address; no public exposure.
- **Evidence it builds on:** spikes 03 and 04 demonstrated the subscription transports separately; spikes 05 and 06 established the checkpoint durability, one-writer-per-run, compatibility, and interrupt-identity safeguards this phase must honor. None of these was demonstrated with Bun or with the agent harness, so each is re-verified here rather than inherited.
- **Documentation:** no `docs/` directory exists, and the root `README.md` contains only the `bun init` boilerplate; neither informed this proposal. The root `README.md` is rewritten with setup and usage. Architecture documents informing this proposal — `architecture/README.md`, `02-control-plane.md`, and `05-model-authentication.md` — describe pre-implementation intent; their reconciliation with the `createAgent` harness and the console is recorded as an obligation in the roadmap and is detailed in this change's design.

## Non-goals

- **Automatic crash recovery.** Interrupted runs are reported, not resumed automatically, and no exactly-once guarantee is offered for work in progress.
- **Host reboot guarantees.** Only an ordinary runtime restart is in scope.
- **Facet-provided skills, agents, commands, or MCP tools.** Phase 2.
- **Cross-run memory or preferences.** Phase 3.
- **Mutating tools** — file edits, shell commands, GitHub posting, or any external change.
- **Providers beyond Anthropic and OpenAI subscriptions**, and API-key billing as a fallback.
- **Concurrent writers to one run**, scheduling, queues, or multi-user access.
- **Production security infrastructure.** Access relies on the owner's private network; credential hygiene and the limited tool surface are still required.
- **A polished or mobile-specific interface.** The console is minimal and functional.
- **Subagents, multi-agent topologies, or workflow graphs** beyond a single agent run.
