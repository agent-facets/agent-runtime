# Proposal

## Why

Phase 1 fixes agent instructions and tools in runtime code. Facet-backed workflows let the owner reuse versioned commands, skills, agents, and MCP connections without changing that code, while the runtime retains authority over permitted actions.

This is phase 2 of [the framework MVP roadmap](../../roadmaps/framework-mvp.md), building on the accepted phase-1 [execution specification](../../specs/execution/spec.md). It supplies the reusable workflow support needed by the later PR-feedback workload.

## What Changes

- **Install facets for the runtime.** The owner SHALL install runtime facets through the existing `facet` CLI using a dedicated runtime manifest and lockfile, separate from coding-tool installations. The selected contributions SHALL be reproducible from the recorded installation inputs. The console SHALL identify installed commands, skills, agents, server declarations, versions, and refusals.
- **Start from a command.** The owner SHALL be able to select an installed command and supply its arguments. Runs SHALL retain their selected definitions and inspectable provenance across facet updates or removal. Goal-only runs SHALL remain available. Retained definitions SHALL NOT bypass runtime compatibility checks or owner authorization.
- **Skills on demand.** Agents SHALL discover skill names and descriptions, then load full instructions and bundled text references when needed. Loads SHALL be recorded. Reference access SHALL stay within the loaded skill's retained resources, without granting general filesystem access or code execution.
- **Bounded named delegates.** An agent SHALL be able to delegate a task and receive its result or failure while the caller waits. Delegates SHALL use the run's provider and step budget, SHALL NOT exceed the caller's effective permissions, and SHALL remain subject to run cancellation and interruption. Their activity SHALL be attributable in history. Delegation limits SHALL be finite and documented.
- **Approved MCP tools.** The runtime SHALL use only server configurations and scoped tools explicitly granted through owner configuration. Installation consent SHALL NOT authorize runtime access. Changed server declarations or advertised tool definitions SHALL require applicable reapproval. Matching calls SHALL be authorized by the configured grants without an additional generic per-call confirmation gate; workflow-specific approval requirements remain separate.
- **Runtime-enforced permissions.** Facet and agent restrictions SHALL only narrow owner grants. Installing or approving a facet does not by itself grant it access to anything. Inspected content and model output SHALL NOT expand permissions. Unsupported behavioral requirements SHALL be refused visibly rather than ignored.
- **Questions from delegates.** A delegate's question SHALL pause the same run and return the accepted answer to the original asker, including after an ordinary compatible restart.
- **Visible failures.** Unusable command selections SHALL be refused before agent dispatch. Runtime capability problems SHALL identify the affected facet and item and remain distinguishable from successful results. Existing failure categories and credential-safe explanations SHALL be retained.

## Capabilities

### New Capabilities

- `capabilities`: Installing and inspecting facet-provided workflows, skills, agents, commands, and MCP tools; selecting usable contributions; enforcing and inspecting their permitted scope.

### Modified Capabilities

- `execution`: Add command starts, retained capability definitions, provenance, and delegate-question routing. Extend "Run history records ordered activity", "Agent steps have a visible finite budget", "The owner can cancel an unfinished run", "Active work interrupted by process death is reported", "Workspace reading and search are confined", and "Both subscription providers support the interactive journey". Rename and modify "Agent tools do not mutate the environment" as "Agent tools stay within explicitly authorized actions". Command prerequisite refusals SHALL precede dispatch.

## Impact

- **Code:** a runtime adapter using the public `@agent-facets/adapter` SDK; loading and resolution; bounded delegation; MCP lifecycle and permission enforcement; operator configuration, API contracts, and console views. Resume-critical loader and delegation code SHALL participate in existing compatibility checks.
- **Dependencies:** the facet CLI and adapter SDK, pinned separately; LangChain MCP adapters and their required dependencies, subject to bounded Bun verification. The private facet engine SHALL NOT become a dependency.
- **Project files:** a dedicated runtime installation directory with its own `facets.json` and `facets.lock`, managed by the CLI. The root editor-facing manifest and lockfile SHALL remain separate.
- **Deployment:** materialized facets SHALL be supplied read-only. Locally launched MCP server executables SHALL be pinned and supplied reproducibly, not downloaded on demand at runtime. Design SHALL specify packaging, supported transports, lifecycle, and any narrowly writable destinations without making the workspace or root filesystem generally writable.
- **Existing facets:** facets authored for coding tools are not promised to run unchanged. Their authored sources may need runtime-specific adapter settings or wording. Materialized `.opencode` copies SHALL NOT be used as input.
- **Verification:** the command → skill → delegate → approved tool → question → result journey SHALL support both Anthropic and OpenAI. Bounded checks SHALL cover permissions, shared budgets, restart routing, and preservation of completed tool outcomes during continuation, without promising exactly-once external effects. Live checks and acceptance exceptions require explicit owner decisions; phase-1 acceptance is not reopened.
- **Documentation:** no `docs/` directory exists. The root `README.md` informed this proposal, particularly Configuration, Authority boundaries, Agent execution, Browser console and API, and Deployment. Updates SHALL document installation, approvals, supported semantics, deployment, and usage, and remove milestone/progress narration rather than maintain status updates. `architecture/02-control-plane.md` and `architecture/08-execution-security.md` informed the lifecycle and authority boundaries and SHALL be reconciled where affected. Facet CLI, adapter SDK, and manifest documentation informed installation and compatibility requirements.

## Non-goals

- A facet registry, publishing workflow, or facet-management interface.
- Automatic facet composition; required facets are installed explicitly.
- Full parity with every coding tool's facet semantics.
- Mutating tools by default or general shell/source-edit authority; only explicitly granted, scoped tool actions are permitted.
- Secrets in facet declarations; MCP credentials come from private runtime configuration.
- Parallel, background, or long-lived delegates, multi-agent scheduling, or a general workflow-graph language.
- Sandboxing MCP server processes or a new broker service.
- Changes to the PR-feedback or VIPER facets, which belong to phase 4.
- Cross-run memory, which belongs to phase 3.
