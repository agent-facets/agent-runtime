# Proposal

## Why

After phase 1, an agent's instructions and tools are fixed in runtime code, so every new workflow means changing the runtime. The owner already packages workflows, skills, agents, and MCP connections as facets for coding tools; letting the runtime run those facets makes workflows reusable, versioned, and editable without touching the runtime — and is what the PR-feedback workload in phase 4 needs.

This is phase 2 of [the framework MVP roadmap](../../roadmaps/framework-mvp.md). It depends on [`mvp-01-interactive-agent-execution`](../mvp-01-interactive-agent-execution/proposal.md).

## What Changes

- **Install facets for the runtime.** The owner installs facets with the existing `facet` CLI, and a runtime adapter materializes their skills, agents, commands, and MCP server declarations for the runtime. The runtime's installed facets are kept separate from any coding-tool installation on the same machine and are reproducible from the project's facet manifest and lockfile.
- **Start a run from a command.** A user can start a run by choosing an installed facet command and supplying its arguments. The run shows which facets, commands, skills, agents, and versions it used, and keeps using those same definitions for its whole lifetime even if facets are updated meanwhile.
- **Skills on demand.** An agent sees the installed skills available to it and loads a skill's full instructions only when it needs them.
- **Named delegates.** An agent can hand a bounded task to a facet-defined agent and receive its result. The delegation and its outcome appear in the run's progress history.
- **MCP tools.** A run can use tools from MCP servers declared by installed facets and approved by the owner. Tool calls and their outcomes appear in the run's progress history.
- **Runtime-enforced permissions.** What a run, and each delegate, may do is decided by the runtime from the owner's configuration and the permissions a facet declares, and it can only be narrowed by a facet, never widened. Installing or approving a facet does not by itself grant it access to anything. A facet that requires behavior the runtime does not support is rejected with a clear explanation instead of running with that requirement silently ignored.
- **Questions from any level.** A facet-defined agent or delegate that asks the user a question pauses the run in the same way as phase 1, and the answer returns to whoever asked.
- **Visible failures.** A missing facet, an unavailable MCP server, a rejected tool call, or an unsupported facet requirement is reported to the user in the console with the facet and item responsible.

## Capabilities

### New Capabilities

- `capabilities`: Installing facet-provided workflows, skills, agents, commands, and MCP tools for the runtime, choosing which a run may use, and seeing which were used and what they were permitted to do.

### Modified Capabilities

- `execution`: Runs can be started from a facet command, record the capability versions they used, and include delegate activity and MCP tool calls in their history. `execution` is introduced by `mvp-01-interactive-agent-execution`; this change's delta targets it once that change is archived.

## Impact

- **Code:** a runtime adapter package built on the public `@agent-facets/adapter` SDK; runtime code that loads materialized assets, resolves commands and skills, runs delegates, manages MCP connections, and enforces permissions; console views for choosing commands and inspecting capabilities.
- **Dependencies:** the `facet` CLI and its adapter SDK, pinned separately; the LangChain MCP adapters, subject to Bun verification. The private facet engine is not a dependency.
- **Project files:** `facets.json` and `facets.lock` gain the runtime's own facet entries, managed by the CLI.
- **Existing facets:** facets authored for coding tools are not promised to run unchanged. Their authored sources may need runtime-specific adapter settings or wording. Materialized `.opencode` copies are not used as input.
- **Documentation:** no `docs/` directory exists; the root `README.md` covers only setup delivered by phase 1 and did not inform this proposal. The README gains instructions for installing facets for the runtime and approving MCP servers. The facet CLI, adapter SDK, and manifest documentation in the facets repository informed this proposal; `architecture/02-control-plane.md`, whose agent registry predates facets, is recorded in the roadmap for reconciliation.

## Non-goals

- **A facet registry, publishing workflow, or facet-management interface.** The existing CLI remains the installation tool.
- **Composed facets.** Facets that depend on other facets are not supported; required facets are installed explicitly.
- **Full parity with every coding tool's facet semantics.** Only a documented subset is supported; the rest is rejected visibly.
- **Mutating tools by default.** A facet cannot grant itself file edits, shell access, or external changes; those remain outside the MVP except where the owner explicitly allows a specific tool.
- **Secrets inside facets.** MCP credentials are supplied by the runtime's configuration, never by facet declarations.
- **Parallel, background, or long-lived delegates**, multi-agent scheduling, or a general workflow-graph language.
- **Changes to the PR-feedback or VIPER facets.** Those belong to phase 4.
- **Memory of preferences or past runs.** Phase 3.
