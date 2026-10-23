# MVP 02 integration witnesses — facet-backed capabilities

**Status: synthetic verification complete; owner acceptance not given.** Recorded under task 18.5 of
[`mvp-02-facet-backed-capabilities`](../../../openspec/changes/archive/2026-10-20-mvp-02-facet-backed-capabilities/tasks.md). Every
result below comes from scripted providers, a disposable PostgreSQL fixture, the bundled synthetic MCP server, local
synthetic facets and an isolated Compose project with internal networks. **No live provider request, deployment,
production facet or grant, or owner-state operation was made.**

## Tested build

- Source: commit `c93f314bb621b003540f684b5710f484ef92d336` plus the uncommitted task 18.1–18.3 changes (11 files,
  tests and the task list only; `git diff HEAD | sha256sum` = `4f0ff9001055f1b8c812ffbe2011e314b7ed2bf2d909f2de5ccb2c2a333f5dd5`).
  No runtime, contract, UI, image or configuration source changed after `c93f314`.
- Toolchain and pins: Bun 1.3.14; LangChain 1.5.14, `@langchain/core` 1.2.14, LangGraph 1.4.13,
  `@langchain/anthropic` 1.5.11, `@langchain/openai` 1.6.2; `@modelcontextprotocol/sdk` 1.32.1,
  `@langchain/mcp-adapters` 1.1.4; facet CLI 0.36.0 (linux-x64, SHA-256
  `c7b781b1a7cac5ce459cccb41da4ad12d0e6545d5cc6381a18a90706feb8451a`), `@agent-facets/adapter` 0.30.0 (API 0.3),
  `@agent-facets/protocol` 0.32.0; lockfile 0.4, manifest 0.2.
- Images built by the container suite: `sha256:8ea9542dadb676a5b4d7a7500ee6678af3b212cffa11f8c4026fbad21a76cc6e`
  and its rollback twin `sha256:2a687349c2df5cfeafdfac471a6a65485f00686d09dbc0b8cacdb3382c17e790`, the same IDs as at
  task 16.6.

## Verification (task 18.4)

Run once each, in order, on 2026-10-20, all exit 0. Nothing was rerun.

| Command | Result |
|---|---|
| `mise exec -- bun run test:facets` | 16 pass, 0 skipped, none deferred |
| `mise exec -- bun run check:verify` (forced) | 18/18 tasks; runtime 606, contracts 31, subscription 61, UI 33, facet adapter 42, MCP programs 6, scripts 58 tests |
| `mise exec -- bun run test:integration` | 279 pass across 32 files, including the MCP/Bun gate |
| `mise exec -- bun run test:browser` | 2 pass (the goal-run and command-run smoke checks) |
| `mise exec -- bun run test:container` | 29 checks pass, including the image and configuration-only rollbacks |

No `test.skip`, `describe.skip`, `test.todo` or `TODO UPSTREAM-SERVER-PROVENANCE` remains under `tests/`. The
container rollback fingerprint was `430072b8…f064` over 3 runs, 1 retained capability snapshot and 0 model attempts.
None of the retained logs contains the synthetic MCP credential.

## Design gates (design Decision 11)

| Gate | Evidence |
|---|---|
| 1. Public export | [`export.facet.test.ts`](../../../tests/facets/export.facet.test.ts): the 16 fixture cases — install, export and seal with the pinned toolchain; repeated and frozen installs; aliases, omissions, collisions; removal; server joins with every deduplicated origin; altered-bundle refusal; reproducible bytes; bidirectional isolation; absolute `FACET_DIR`; contaminated-home refusal. Same-response reference refusal: [`skill-loading.integration.test.ts`](../../../tests/integration/skill-loading.integration.test.ts) |
| 2. Durable delegates | [`mcp-delegate-restart.integration.test.ts`](../../../tests/integration/mcp-delegate-restart.integration.test.ts) (both providers, process death, two delegated questions, exact `false` answers, real MCP calls, shared budget), [`delegation-restart.integration.test.ts`](../../../tests/integration/delegation-restart.integration.test.ts), [`delegation.integration.test.ts`](../../../tests/integration/delegation.integration.test.ts). The MemorySaver probe ([`delegation-probe.integration.test.ts`](../../../tests/integration/delegation-probe.integration.test.ts)) is reported separately and is not counted as this gate |
| 3. MCP/Bun | [`mcp-transport.integration.test.ts`](../../../tests/integration/mcp-transport.integration.test.ts), [`mcp-dispatch.integration.test.ts`](../../../tests/integration/mcp-dispatch.integration.test.ts), [`mcp-credentials.integration.test.ts`](../../../tests/integration/mcp-credentials.integration.test.ts), [`command-preflight.integration.test.ts`](../../../tests/integration/command-preflight.integration.test.ts); in the image, [`container-smoke.ts`](../../../scripts/container-smoke.ts) (read-only program and bundle mounts, stopped-runtime provisioning, tampered or missing artifacts, private directories surviving restarts and image replacement) |
| 4. Integrated journey | The task 18.1–18.3 witnesses below |

## Task 18.1–18.3 witnesses

**Integrated journey, both providers** —
[`mcp-delegate-restart.integration.test.ts:146`](../../../tests/integration/mcp-delegate-restart.integration.test.ts).
A child process starts `command:sync` through `POST /api/v1/runs`. The root loads `skill:review` and calls
`list_items` in one response, reads the skill's bundled reference in the next, and delegates to `agent:worker`; the
delegate calls the server and asks the owner. The child is killed. A fresh owner answers `false` through the API;
the delegate calls the server again with the same arguments and asks again; another fresh owner answers `false` and
the run succeeds with the root's own final message. Observed for each provider:

- Model requests 5 + 2 + 2 = 9, all on the run's ordinals and all to the run's own provider and model (no fallback);
  budget shown as 9 of 20 with 0 unconfirmed. Four root requests offer `mcp_Delegate`, five delegate requests do not.
- Server witness: 3 starts, 4 listings, 3 calls (one preflight inspection, one connection per invocation); the
  completed calls were never repeated and the identical-argument call was new.
- Canonical names (`mcp_synthetic_list_items`) in operations and history; provider aliases only on the wire.
- `GET /runs/:id/capabilities` reports exactly what was used: one skill load and one reference read by the root,
  one delegation ending in `result`, three successful `synthetic/list_items` calls.
- Paginated history, in order: command selection, skill load, root call, reference read, delegation start, delegate
  call, delegate question, `false`, delegate call, delegate question, `false`, delegate result, delegation end,
  root result, success. Questions name the asking delegate; the run's result is the root's message.
- The event stream, read up to the first answer and then reconnected with `Last-Event-ID`, equals that history.

**Retention and revocation, both providers, replacement and removal** — four cases at
[`mcp-delegate-restart.integration.test.ts:404`](../../../tests/integration/mcp-delegate-restart.integration.test.ts).
A child process starts the run, makes one granted call and pauses on a root question before anything else is used.
A fresh owner restarts with the installation replaced (version 1.1.0, changed skill, reference and agent texts) or
removed, and the tool's grant revoked. After the answer:

- The first load, reference read and delegate instructions come from the retained 1.0.0 definitions; no request
  contains the replacement text.
- The completed call's recorded disposition is byte-identical before and after, and its outcome reaches the model
  from the saved graph state. The delegate's new call is refused `tool_not_granted`. The server witness is unchanged
  (2 starts, 2 listings, 1 call): nothing was sent again.
- With no installation at all, the finished run's capabilities still show version 1.0.0, the captured grant, the
  revoked current grant and the recorded use; reading them starts nothing.
- Replacement: a new run is accepted under the 1.1.0 revision and retains the replacement texts.
- Removal: the catalog reports `installation_missing`, a command start is refused `capabilities_unavailable` (503,
  not accepted), and a goal run starts and succeeds with exactly `mcp_AskUser`, `mcp_Read` and `mcp_Search`.

Replay of an *already completed* MCP operation through the ledger after revocation does not occur in a natural
restart: the completed outcome is already in the saved graph state, so the call is never re-entered. By owner
decision (recorded under task 17.2) this is not staged; the ledger's replay-before-permission check is covered by the
unit test [`execution/mcp.test.ts:195`](../../../packages/runtime/src/execution/mcp.test.ts).

**Whole-run credential capture, both providers** —
[`mcp-dispatch.integration.test.ts:344`](../../../tests/integration/mcp-dispatch.integration.test.ts). A successful
run with an echoed credential (redacted), a server error carrying it (fixed `mcp_tool_error`), an out-of-scope call
(refused, unsent), standard-error noise carrying it and an environment report (showing `REPO_TOKEN` was delivered
through the server's binding); and an uncertain run (echo, then a server crash ending the run as
`tool_failure`/`mcp_outcome_unknown` with no further model turn). For each, more than 15 surfaces are checked: model
request bodies, retained definitions, saved graph state, every runtime table, the run detail and result, history,
run capabilities, catalog, run list, the event stream and diagnostics. No surface contained the credential; a failure
would name only the surface. A launch plan without a credential binding carries none
([`transport.test.ts:93`](../../../packages/runtime/src/mcp/transport.test.ts)). A model reply that itself repeats
the credential is refused whole as unsafe model output and fails the run as `provider_failure`/`unsupported_response`
before anything is stored or dispatched (existing behavior, [`execution/outcomes.ts`](../../../packages/runtime/src/execution/outcomes.ts));
the call-level `credential_in_arguments` refusal applies below that screen ([`mcp/call.test.ts`](../../../packages/runtime/src/mcp/call.test.ts)).
Console rendering of these values is covered by the UI component tests, not a browser journey.

**Traceability additions** — unsupported parallel, background, long-lived and composition metadata and an
unenforceable restriction category are refused
([`metadata.test.ts:60`](../../../packages/facet-adapter/src/metadata.test.ts)); a command whose declared prerequisite
is refused is not accepted, names `skill:review`, runs no preflight and sends nothing, while an unrelated command
starts ([`command-start.integration.test.ts:273`](../../../tests/integration/command-start.integration.test.ts)); a
coding tool's materialized command in the workspace is not offered, cannot be started and is left untouched
([`capability-api.integration.test.ts:190`](../../../tests/integration/capability-api.integration.test.ts)).

## Scenario coverage

Every scenario of the [capabilities](../../../openspec/specs/capabilities/spec.md)
(37) and [execution](../../../openspec/specs/execution/spec.md) (43) deltas,
with the tests that witness it. All listed suites passed in the task 18.4 run. Paths are under `tests/integration/`
unless stated; "facets" is `tests/facets/export.facet.test.ts`, "container" is `scripts/container-smoke.ts`, and
"restart" is `mcp-delegate-restart.integration.test.ts`.

### Capabilities

| Scenario | Evidence |
|---|---|
| Install a workflow from recorded inputs | facets: install/export/seal, repeated install, frozen reproducibility |
| Installation does not execute the workflow | facets: no server execution sentinel after install and seal; installation uses no runtime |
| Installed facet inputs are read-only | container: failed writes to the bundle and program mounts, read-only mount assertions |
| Installed content has changed | facets: altered bundle refused; `packages/runtime/src/capabilities/installation.test.ts`; container: tampered bundle makes only the catalog unavailable |
| Update the runtime installation independently | facets: bidirectional isolation, removal and reinstall of a declaring facet |
| A coding-tool-only asset is not a runtime asset | facets: isolation; `capability-api` editor-only case. The owner is directed to the runtime procedure by documentation ([`deploy/runtime/facets/README.md`](../../../deploy/runtime/facets/README.md)), not by a refusal message |
| An agent requires unsupported execution behavior | `packages/facet-adapter/src/metadata.test.ts` (parallel, background, long-lived, nested); `adapter.test.ts` refusal records |
| A permission restriction cannot be enforced | `metadata.test.ts` (unknown restriction category); `packages/runtime/src/config/capabilities.test.ts` (unsupported predicates) |
| A facet requires automatic composition | `metadata.test.ts` (composition and installation fields refused) |
| A declared prerequisite is unavailable | `command-start` refused-prerequisite case; facet adapter `resolve.test.ts`, `seal.test.ts`; runtime `capabilities/installation.test.ts` |
| Inspect available workflow contributions | `capability-api` catalog cases; `packages/ui/src/app/views.test.tsx`; browser command smoke check |
| Two contributions have an unresolved name conflict | runtime `capabilities/installation.test.ts`; facet adapter `seal.test.ts`; facets collision case |
| Load an applicable skill | restart journey; `skill-loading`; runtime `execution/skills.test.ts` |
| An unused skill stays out of the full instruction context | runtime `execution/skills.test.ts`; restart journey (bound versus used) |
| Request a missing or disallowed skill | runtime `execution/skills.test.ts`; `skill-loading` refusal cases |
| Read a bundled skill reference | restart journey; retention cases (retained reference after replacement); `skill-loading` |
| A skill reference is missing or escapes its bundle | runtime `execution/skills.test.ts`; `skill-loading` unloaded-reference case |
| Delegate a task and use its result | restart journey; `delegation` |
| Request an unavailable delegate or exceed a limit | `delegation`; `capability-records` limit case |
| Request independent background delegation | `metadata.test.ts`; `delegation` exclusive-batch refusal |
| A safely handled delegate failure | `delegation`; retention cases (refused call, delegate result, root continues) |
| A facet requests more access than the owner granted | runtime `capabilities/authority.test.ts`; `mcp-dispatch` refusals; credential capture out-of-scope call |
| A delegate has a narrower tool set | runtime `capabilities/authority.test.ts`, `execution/mcp.test.ts`, `execution/delegation.test.ts`; `delegation` |
| Instructions attempt to expand permissions | runtime `capabilities/authority.test.ts`, `security/permission-invariance.test.ts` |
| Installation consent is not runtime authorization | `capability-api` denied connection; `command-preflight` |
| Call an approved tool | `mcp-dispatch` (both providers); restart journey; `mcp-transport` |
| A server or its advertised tools change | runtime `capabilities/authority.test.ts`, `capabilities/preflight.test.ts`; `command-preflight` changed definition; `mcp-transport` |
| Dispatch a matching call | `mcp-dispatch` (both providers, no confirmation) |
| Arguments violate the approved contract | `mcp-dispatch` refusals; runtime `mcp/call.test.ts`; credential capture out-of-scope call |
| Authenticate an approved server without exposing its secret | credential capture (both providers); `mcp-transport` environment case; `transport.test.ts:93` |
| A tool outcome or connection error contains credentials | credential capture (echo, error, noise, uncertain); `mcp-transport`; runtime `mcp/call.test.ts` |
| A declaration contains a recognized credential | runtime `mcp/transport.test.ts`, `capabilities/preflight.test.ts` |
| A synthetic tool-service credential stays private | credential capture (both providers, success and uncertain); container: no service output contains it |
| A local server executable is absent | `mcp-transport` missing bundle; container: missing and tampered programs refused before starting |
| An MCP service is unavailable | runtime `capabilities/preflight.test.ts`; `command-start` preflight outage; `mcp-dispatch` |
| A tool reply is lost after dispatch | `mcp-dispatch` deadline, cancellation and crash cases; credential capture uncertain case; `views.test.tsx` uncertainty label |
| A capability failure prevents continued work | `mcp-dispatch` uncertain cases (attributed failure, progress kept); credential capture uncertain case |

### Execution

| Scenario | Evidence |
|---|---|
| Select a command and begin its task | restart journey (API start); `command-start`; `capability-api` |
| Refuse an unusable command selection | `command-start`; `capability-api` refused selections |
| Retry the same creation request after a facet update | `command-start` retry after update, removal and outages; `capability-api` |
| Command arguments contain runtime-managed credentials | `command-start`; `capability-api` |
| Goal-only runs remain available | `command-start` (both providers, three native tools); retention removal case |
| Update a facet while a run is in progress | retention replacement cases (fresh process); `skill-loading` |
| Restart after changing the installed facets | retention replacement and removal cases (fresh process) |
| Required retained definitions are lost | `skill-loading` confirmed loss; `delegation` saved-state loss |
| A grant is revoked for an existing run | retention cases (new call refused unsent, completed outcome kept); `skill-loading` revoked load |
| Inspect what a run actually used | restart journey capabilities view; `capability-api`; runtime `service/capability-views.test.ts` |
| Inspect history after uninstalling a facet | retention cases (inspection with no installation, nothing started); `capability-api` |
| A delegate asks the owner | restart journey; `delegation` |
| Answer a delegated question after restart | restart journey (both providers, exact `false`, fresh processes); `delegation-restart` |
| Retry an answer after the caller asks a later question | `delegation` stale answer case |
| Resume past a completed MCP operation | restart journey (completed calls never repeated); retention cases |
| Request a new operation with the same arguments | restart journey (identical-argument call is new); `mcp-dispatch` |
| Status changes remain inspectable | `api.integration.test.ts` stream replay; `run-store` |
| Follow delegated activity | restart journey ordered history; `capability-records` attributed history |
| Follow skill and MCP use | restart journey ordered history; `skill-loading`; `mcp-dispatch` |
| Capability activity is recorded in order | restart journey (paginated history and reconnected stream agree) |
| Process stops during a model request or tool operation | `lifecycle-crash-matrix` |
| Process stops after accepting an answer | `lifecycle-crash-matrix` |
| Request manual continuation of an interrupted run | `lifecycle-crash-matrix`; `api.integration.test.ts` |
| Process stops during delegated work or an MCP call | `capability-store` restart settlement; `mcp-dispatch` uncertainty; `lifecycle-crash-matrix` |
| Cancel active work | `cancellation`; `api.integration.test.ts` |
| Cancellation races with completion | `cancellation`; `run-controller` |
| Cancel a run with a delegate | `delegation` active and waiting cancellation |
| Cancel with an MCP call in flight | `mcp-dispatch`; `mcp-transport` |
| Model requests and retries consume steps | `request-accounting` |
| Answering after restart does not reset the budget | `request-accounting`; restart journey (9 of 20 across three processes) |
| Delegate requests count against the containing run | restart journey; `delegation` |
| Delegation cannot create a fresh allowance | restart budget cases (both providers); `delegation` |
| Complete the journey with Anthropic | `provider-assembly` (production Anthropic assembly); browser goal smoke check |
| Complete the journey with OpenAI | `provider-assembly` (production OpenAI assembly) |
| Complete a facet-backed journey with either provider | restart journey (both providers) |
| Investigate files in the workspace | runtime `workspace/*.test.ts`; `api.integration.test.ts` |
| A requested file is missing or unreadable | runtime `workspace/read-file.test.ts` |
| A path escapes the workspace | runtime `workspace/*.test.ts`, `workspace/admission.test.ts` |
| Delegation and MCP approval do not widen native workspace access | runtime `execution/delegation.test.ts`, `security/permission-invariance.test.ts` |
| A task requests a source edit or command | runtime `execution/agent.test.ts`, `security/permission-invariance.test.ts` |
| Inspected content instructs a mutation | runtime `security/permission-invariance.test.ts`, `authority.test.ts` |
| The agent calls an unavailable mutating tool | runtime `execution/agent.test.ts` |
| The owner grants one narrowly scoped tool action | `mcp-dispatch` (both providers); credential capture out-of-scope call |

## Not performed

- No live Anthropic or OpenAI request: provider journeys are scripted against the production assemblies. Phase-1
  live evidence and its accepted exceptions are not carried forward to this phase's new behavior.
- No deployment, image push or change to the live deployment, its configuration, credentials or volumes.
- No production facet selection, program inventory (the image ships an empty manifest) or grant.
- The container fixture shows a compatible-image and a configuration-only rollback over preserved storage, not a
  rollback of the live deployment or to a binary predating migrations 4 and 5.
- MCP server processes are trusted code: request restrictions are not process isolation.

## Deployment (after review, owner-approved, 2026-10-20)

The verified build was deployed to the live Compose project `agent-runtime-live` after the task 18.7 review. The
results above predate it and are unaffected.

- Image `agent-runtime/runtime:3639d5d-mvp-02`, ID `sha256:8ea9542d…cc6e` — the same ID the container suite verified —
  built from the clean `3639d5d` tree (the stack through #34). It replaced `dbf7145-openai-recovery`
  (`sha256:ed0293c9…`); the previous environment file is kept as `compose.env.dbf7145`.
- No run was waiting or working (14 runs, all finished), so none was cancelled.
- Before the switch the database (schema 3) was saved with `pg_dump` to a private file under the deployment's state
  directory (`backups/pre-mvp-02-20261020T140004Z.dump`, mode 0600). Startup applied migrations 4 and 5; the earlier
  image now refuses this database, so the dump is the only way back. Restoring it would be a separate owner decision.
- Only the runtime service was recreated; configuration (goal-only, no `capabilities`), workspace, Tailscale,
  PostgreSQL and volumes were unchanged.
- Read-only checks after the switch: healthy and ready; schema versions 1–5; both providers ready; all 14 runs, their
  histories and capability views (`native`) readable; a fingerprint of runs, events, model attempts and questions
  unchanged; catalog `unconfigured`; the console served over the tailnet address. No model request was made.

## Owner decisions pending

- Acceptance of this phase, and whether live provider trials are required for it.
- Any production facets, programs, grants or MCP credentials for the live deployment.
