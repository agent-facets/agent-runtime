> **Before executing any tasks below**, load the `viper-execution-rules` skill for the full VIPER step protocol (step types, execution rules, gating, and hard constraints).

# Tasks

## Step Types

- **Verify** → CHECK. Run automated checks (tests, lint, type checks).
  If all checks pass, proceed. If anything fails, STOP and notify the user.
- **Implement** → WRITE. Make code changes — create, edit, or delete files.
- **Propose** → READ-ONLY + USER GATE. Present intended changes in your message text first,
  then ask for approval using the `question` tool with a short prompt (Approve / Reject / Request changes).
  Never put details in the question — the question is just the gate. Do not write anything.
- **Explore** → READ-ONLY. Read files, search the codebase, investigate broadly.
  No writes allowed. Use this to understand the problem space before acting.
- **Review** → READ-ONLY + USER GATE. Present findings and analysis in your message text first,
  then ask for feedback using the `question` tool with a short prompt.
  Never put details in the question — the question is just the gate.
- **Pause** → PAUSE, NO TOOL. A model-switch pause. Emit this exact line of plain text and nothing else:
  "Switch models if desired, then send any message to continue."
  Then end the turn. Do NOT call the `question` tool, and do NOT tell the user to run a command.
  An affirmative continuation resumes execution; a stop, revise-plan, or
  question message is handled without advancing.

Each VIPER heading and its following OpenSpec checkbox describe **one** step/TODO, not two. Headings give the execution order; checkbox IDs preserve OpenSpec progress tracking. This plan is pause-enabled at every research/implementation boundary. Explore deliverables are read-only findings presented in the conversation, not file writes.

The reconciled [design](design.md), [capability requirements](specs/capabilities/spec.md), and [execution delta](specs/execution/spec.md) govern this checklist. Existing phase-1 acceptance, archived evidence, adversarial files, and archive-ignore policy remain unchanged. Cross-run memory, PR-feedback/VIPER facet adaptation, provider replacement, and unrelated cleanup are outside this change.

Each implementation block SHALL remain shippable with the goal-only path working and its own tests and documentation landed. Capability selection SHALL remain unavailable to public starts until its required backend gates pass. Synthetic fixtures SHALL NOT enable production grants, access owner credentials, or contact providers. A verification failure SHALL stop execution without automatic repair or rerun. Missing prerequisites SHALL be reported, not installed or worked around automatically. Live traffic, deployment, changes to owner configuration/credentials/volumes, and acceptance exceptions require fresh explicit owner approval; these tasks grant none.

Commands below run from the repository root, prefixed with `mise exec --` when needed. `bun run check:verify` includes forced lint, typechecks, unit tests and build; explicitly launched integration/browser/container suites use isolated fixtures. Each Verify SHALL run the checks applicable to the changed inputs, stop at the first failure, and retain command, revision, fixture identity and result evidence. Tests awaiting a later block SHALL be explicitly skipped with a TODO naming that block before verification, never hidden after a failing run; no required gate or final witness may remain skipped at completion.

### Temporary upstream dependency: `UPSTREAM-SERVER-PROVENANCE`

On 2026-10-08 the owner approved deferring the missing public server-origin join while upstream work adds per-facet server data to the CLI lockfile (design Decision 2). CLI 0.33.0/SDK 0.30.0 research and lockfile format 0.3 do not establish that join. The owner subsequently reported CLI 0.35.0; its presence is neither proof of the forthcoming fields nor approval to replace a pin. Task 5.3 SHALL establish the exact interim CLI/SDK pins and binary identity before fixture installation.

Group 6 SHALL implement independent text-asset sealing, metadata and catalog work plus raw server export behavior, without inventing server origins or a future lockfile schema. Server-bearing installations SHALL remain unsealable until provenance is verified. Only the provenance-dependent checks MAY be deferred, explicitly before verification with `TODO UPSTREAM-SERVER-PROVENANCE: revisit 9.1; complete 10.1; verify 10.2`. Task 6.9 is interim verification, not a pass of the full public-export gate. Independent MCP transport work in groups 7–8 MAY continue using clearly labelled synthetic inputs.

Task 9.1 SHALL revisit the released public contract; task 9.4 SHALL obtain approval for its exact pins and remaining integration. Tasks 10.1–10.2 SHALL complete and verify the deferred join before dependent command/MCP implementation. Missing upstream support at that point is a blocker, not permission to infer provenance or add a private-cache/archive-reader workaround. The full public-export gate and final integrated journey remain mandatory with no required provenance checks skipped. Existing completed work and adversarial history SHALL remain unchanged.

## 1. Durable capability foundation — Research

### Step 1 - Explore: Map records and migration constraints
- [x] 1.1 Explore: Map `records/schemas.ts`, `canonical.ts`, `run-store.ts`, migrations, application transaction ownership and legacy fixtures; deliver a record/constraint matrix covering design Decisions 6–8 and every preserved version-1 identity.

### Step 2 - Explore: Map execution and projection boundaries
- [x] 1.2 Explore: Inspect existing execution definitions, model-attempt admission, tool replay and contract/event consumers independently; deliver an integration map distinguishing immutable snapshots, actor identity, current authority and browser-safe projection.

### Step 3 - Propose: Approve the durable foundation block
- [x] 1.3 Propose: Present the complete foundation implementation and migration plan, including strict types, atomic transitions, compatibility, additive consumer changes and test coverage; obtain approval with no applied-migration edits or widened goal-only authority.

### Step 4 - Pause: Switch model for implementation
- [x] 1.4 Pause: Switch model for implementation; completion requires the fixed pause notice and an affirmative continuation, with no question tool.

## 2. Durable capability foundation — Implementation

### Step 5 - Implement: Define strict capability and actor records
- [x] 2.1 Implement: Add closed versioned capability-definition/snapshot, actor, loaded-skill, tool-binding, delegate-outcome and external-outcome types behind the runtime boundary; add unit fixtures that accept every designed variant and reject unknown fields, contradictory discriminators, invalid identifiers and every Decision-10 size/depth/count boundary.

### Step 6 - Implement: Add canonical snapshots and actor identities
- [x] 2.2 Implement: Extend canonicalization and identity helpers for content-addressed snapshots and version-2 actor-scoped operations; unit-test unchanged version-1 digests, canonical byte stability, control-character rejection, distinct actors/new messages, and exact binding conflicts rather than argument-only cache hits.

### Step 7 - Implement: Add the forward-only capability migration
- [x] 2.3 Implement: Add a migration after version 3 for snapshots, run capability bindings, actors, loaded skills, actor-attributed attempts, actor-scoped call uniqueness and versioned question/event/tool dispositions; integration-test same-run foreign keys, immutable bindings, singleton root/pending question/invocation, root-only final results and forbidden JSON fields. Preserve applied migration bytes and legacy history. Add a migration-registry fixture knowing only version 3; verify it classifies the migrated database as newer/incompatible before setup and leaves both schemas unchanged.

### Step 8 - Implement: Add atomic capability storage primitives
- [x] 2.4 Implement: Extend `RunStore` with fenced atomic snapshot/run/root-actor binding and actor-aware operation/attempt storage; integration-test rollback, concurrency, immutable replay bindings and ambiguous-commit readback without transactions spanning graph/model/MCP work. Delegation, skill and MCP-specific transitions land with their respective blocks.

### Step 9 - Implement: Preserve legacy contracts and projections
- [x] 2.5 Implement: Add backward-compatible shared actor/event/tool-binding schemas and safe projections, explicitly attributing new command-run model attempts and assistant messages as well as tool/question activity; update exhaustive consumers together. Contract and storage tests SHALL distinguish repeated delegates, accept old payloads as root where appropriate, reject false agent attribution of owner/system events, and preserve original event sequences and bytes.

### Step 10 - Implement: Reconcile actors and external intent on startup
- [x] 2.6 Implement: Extend startup reconciliation for active/waiting/abandoned delegates and external intent while keeping completed outcomes immutable; integration-test interrupted active work, accepted cancellation, untouched waiting/finished runs and zero restart redispatch.

### Step 11 - Implement: Document persistence and migration boundaries
- [x] 2.7 Implement: Update `architecture/09-data-model-and-lifecycle.md` and README persistence/compatibility guidance alongside these records; verify documentation against migration fixtures, including newer-schema refusal, no down-migration, no snapshot GC and preservation of credentials/history.

### Step 12 - Verify: Check the durable foundation block
- [x] 2.8 Verify: Run `bun run check:verify` and `bun run test:integration`; report passing migration, identity, atomicity, legacy-projection and startup cases before the delegate block, or stop with the first failure and retained evidence.

### Step 13 - Pause: Switch model for exploration
- [x] 2.9 Pause: Switch model for exploration; completion requires the fixed pause notice and an affirmative continuation, with no question tool.

## 3. Stock delegates and durable questions — Research

### Step 14 - Explore: Inspect stock child checkpoint behavior
- [x] 3.1 Explore: Inspect pinned `createAgent` child invocation and framework-provided namespace/resume behavior; deliver the exact public API path for stable task IDs and direct child inspection, distinguishing the existing MemorySaver observation from the still-unproven PostgreSQL/process boundary.

### Step 15 - Explore: Map delegate lifecycle and shared admission
- [x] 3.2 Explore: Inspect `controller.ts`, publication, saved-state inspection, answer acceptance, provider assembly, model admission and cancellation tracking; deliver an actor-aware wiring plan that shares one provider, run budget, owner epoch and root invocation without a second scheduler or model loop.

### Step 16 - Propose: Approve the durable delegate block
- [x] 3.3 Propose: Present the complete delegate slice and bounded PostgreSQL fixture plan, using synthetic retained definitions before public command admission exists; obtain approval for explicit root/child state validation, test process boundaries and failure classification without claiming an MCP transport pass.

### Step 17 - Pause: Switch model for implementation
- [x] 3.4 Pause: Switch model for implementation; completion requires the fixed pause notice and an affirmative continuation, with no question tool.

## 4. Stock delegates and durable questions — Implementation

### Step 18 - Implement: Add the minimal PostgreSQL child-resume probe
- [x] 4.1 Implement: Add `tests/integration/delegation-probe.integration.test.ts` using the existing isolated database fixture, pinned stock agents and official saver. A root tool invokes a child that reads a synthetic value and interrupts; direct inspection of a freshly reconstructed child at the framework namespace SHALL match the propagated interrupt. Resume a fresh root/child pair by interrupt ID with `{ answer: false }`; verify the read count stays one, the parent tool body is entered twice and the answer is preserved exactly. No production delegate implementation or provider request is required. Keep this probe distinct from the later production-controller/fresh-process witness.

### Step 19 - Verify: Check PostgreSQL child-resume compatibility first
- [x] 4.2 Verify: Run `bun run check:verify` and `bun run test:integration`, including the new probe, before implementing the remaining delegate steps. On failure, stop for an owner decision without repair, rerun, framework upgrade, replacement engine or dropping durable questions.

### Step 20 - Implement: Add bounded stock tool-invoked delegates
- [x] 4.3 Implement: Make agent construction actor-aware and implement `mcp_Delegate` with stock child `createAgent`, same run thread, framework namespace, stable delegation/tool-operation and task-message IDs, and bound task/instructions only. Add atomic begin/complete transitions; test caller-ceiling/agent restriction intersection, no caller-transcript inheritance or nested delegation tool, root-only parentage, depth one, default-eight/configurable-1–32 limits and replay not consuming another slot. Update execution-definition graph/protocol inputs and test per-provider manifest coverage as delegate modules land; representative delegate-code changes SHALL change the relevant digest. Follow the existing import closure and add explicit roots only for otherwise unreachable resume-critical code.

### Step 21 - Implement: Attribute delegate activity and typed outcomes
- [x] 4.4 Implement: Extend boundary middleware for actor-scoped operation/message/event identity and exclusive `mcp_Delegate`/`mcp_AskUser` batches; test whole-batch refusal, same-named sequential delegates and cross-actor provider-call collisions. A safely handled delegate failure SHALL reach the parent as an identifiable failure, not a fabricated result, and allow caller continuation; typed terminal failures still stop the run. Test unknown-error termination and only a new root final result succeeding.

### Step 22 - Implement: Share provider and physical-request accounting
- [x] 4.5 Implement: Route child models through the existing selected-provider assembly, guarded terminal and run-wide admission counter; test shared physical-request ordinals, counted renewal retries, no fallback, exhausted-budget refusal and no extra model charge for tools or delegation creation.

### Step 23 - Implement: Inspect and publish delegated questions
- [x] 4.6 Implement: Implement version-2 root/delegate question publication and direct saved-child inspection using retained thread/namespace bindings; test atomic question/actor/run settlement, matching actor/task/operation/interrupt/payload/digests, missing or contradictory root/child state, no graph invocation during inspection, and the parent delegation operation remaining started rather than native-question paused.

### Step 24 - Implement: Resume the original delegated asker
- [x] 4.7 Implement: Extend continuation compatibility and atomic answer acceptance to reconstruct retained child definitions, check loaded-skill membership and resume only the root interrupt-ID map; test exact negative/null/zero/permitted-empty answers, identical answer retries, stale answers after later questions, `cannot_verify` without mutation and confirmed loss producing `continuation_unavailable` without accepting the answer.

### Step 25 - Implement: Settle delegated cancellation and interruption
- [x] 4.8 Implement: Track the child under existing in-flight cancellation and settlement; integration-test cancellation while active or waiting, accepted-cancel/late-result races, no orphan actor, no caller continuation after cancellation and process-death interruption without automatic recovery.

### Step 26 - Implement: Add the fresh-process delegate witness
- [x] 4.9 Implement: Add a provider-free PostgreSQL fresh-process witness through the production controller and official saver: two sequential questions from one delegate across restart, two calls to the same named agent, lost answer acknowledgement, exact negative answers and unchanged completed native/synthetic-external operation counts. Assert re-entry preserves saved state and genuinely new identical-argument calls remain new; label the external stand-in as synthetic, not a real MCP pass.

### Step 27 - Implement: Document delegates and restart routing
- [x] 4.10 Implement: Update `architecture/02-control-plane.md`, `architecture/09-data-model-and-lifecycle.md` and README execution/restart/budget guidance; verify they describe tool-invoked sequential children, explicit child inspection, recoverable delegate outcomes, root-only success and no manager/scheduler revival.

### Step 28 - Verify: Check durable delegate behavior
- [x] 4.11 Verify: Run `bun run check:verify` and `bun run test:integration`, including the fresh-process delegate witness; its PostgreSQL/process-boundary pass is required before group 5 or any later feature block. Report evidence and stop on any failure without an engine replacement, framework upgrade or loss of durable-question behavior. Group 12 later adds the distinct full MCP replay gate.

### Step 29 - Pause: Switch model for exploration
- [x] 4.12 Pause: Switch model for exploration; completion requires the fixed pause notice and an affirmative continuation, with no question tool.

## 5. Isolated facet export and catalog — Research

### Step 30 - Explore: Inspect the pinned public facet toolchain
- [x] 5.1 Explore: Load `using-facets`, read the installed CLI's usage/authoring instructions and public SDK 0.30.0/API 0.3 contracts; deliver exact CLI 0.33.0 binary integrity, export/inspect/remove interfaces and an isolated absolute `FACET_DIR` procedure without importing the private engine or treating adjacent source as binary equivalence.

### Step 31 - Explore: Map export integrity and installation isolation
- [x] 5.2 Explore: Inspect public manifest/lock materialization, alias/omission namespaces, companion bytes and transformed-primary limitations; deliver a sealer join/refusal matrix and reproducibility fixture plan with cross-installation mutation checks in both directions. Identify the complete deduplicated-server-origin join as `UPSTREAM-SERVER-PROVENANCE`, deferred to 9.1/10.1–10.2 rather than blocking independent work or claiming the current public inputs provide it.

### Step 32 - Propose: Approve the export and catalog block
- [x] 5.3 Propose: Present the adapter, text-asset sealer, loader, supported metadata and raw server-export implementation with the explicit server-provenance deferral and fixture-only install scope. Establish and obtain approval for the exact interim CLI version/binary SHA-256 and SDK pin, accounting for the owner-reported CLI 0.35.0 without assuming provenance support. Obtain approval for the block without committing generated owner-specific exports, adding production facets/grants, inventing upstream fields or claiming the full export gate will pass during the deferral.

  Approval recorded 2026-10-08: owner approved the group-6 proposal and interim CLI 0.35.0 (Linux x86-64), binary SHA-256 `d6590bb2c1af0119e2bdfcafbfc0dbafe98e6e9ef015ae524926e983fa9a2a46`, replacing the initial CLI 0.33.0 selection for this block. SDK remains `@agent-facets/adapter` 0.30.0/API 0.3 with `yaml` 2.9.0; Bun/provider/framework pins remain unchanged. Initial sealer inputs are project manifest 0.2 and lockfile 0.3. Fixtures use local synthetic facets and a test-only editor adapter in separate disposable homes, not owner editor tooling. CLI/SDK installation compatibility remains unproven until the group-6 fixture gate. `UPSTREAM-SERVER-PROVENANCE` and its return points remain unchanged; no production facets/grants, owner-state operations, live requests or deployment were approved.

### Step 33 - Pause: Switch model for implementation
- [x] 5.4 Pause: Switch model for implementation; completion requires the fixed pause notice and an affirmative continuation, with no question tool.

## 6. Isolated facet export and catalog — Implementation

### Step 34 - Implement: Add the public adapter workspace package
- [x] 6.1 Implement: Add private `packages/facet-adapter` with public SDK 0.30.0, exact lockfile resolutions, normal build/typecheck/test tasks and package-boundary checks; verify frozen installation/build compatibility without upgrading the existing framework/provider pins, and add its license notice to `THIRD_PARTY_NOTICES.md`. In this same change, update the Dockerfile's manifest/source COPY lists, the hard-coded workspace-package assertions and intended dependency boundaries in `scripts/workspace-boundaries.test.ts`, and any required non-`src` build-context allowlist entries. Tested packages SHALL declare `test: "bun test"` and appear in `scripts/test-discovery.test.ts`'s Turbo graph. Verify existing wildcard workspace/Turbo configuration before changing it; do not add redundant configuration. The image build SHALL remain valid from this block onward.

### Step 35 - Implement: Export through SDK file-transition plans
- [x] 6.2 Implement: Implement SDK-owned file-transition plans for install, inspect and removal of asset/server/refusal exports; test effective names/descriptions, lossless skill companions, missing/unsupported metadata, owned-output removal, repeated installation and zero direct file mutation, server launch or private-engine imports from the adapter.

### Step 36 - Implement: Resolve supported metadata and references
- [x] 6.3 Implement: Implement explicit version-1 runtime metadata and independent reference resolution: raw command arguments, `requires`, command/agent allowlist restrictions and no skill `restrict`; unit-test aliases, omissions, local/cross-facet skill/agent/native references, cycles, absent/refused prerequisites, skill/command shared namespace and separate agent/server namespaces without prose inference or automatic composition. Validate MCP reference syntax without guessing server origins; defer the verified authored-server-to-effective-server binding and its dependent checks to 10.1 under `UPSTREAM-SERVER-PROVENANCE`.

### Step 37 - Implement: Seal canonical recorded installations
- [x] 6.4 Implement: Implement the canonical text-asset sealer joining exports to the CLI-managed manifest/lock and recorded installer/adapter identities; test missing/extra/conflicting text-asset records, mappings, companion integrity, transformed-versus-source hash separation and deterministic bundle bytes without a self-hashed digest field. While `UPSTREAM-SERVER-PROVENANCE` is unresolved, test that server-bearing installations are refused as provenance unavailable without fabricated origins or silently dropped servers. The complete server join and all deduplicated origins land in 10.1.

### Step 38 - Implement: Load and validate the runtime catalog
- [x] 6.5 Implement: Implement the runtime loader/catalog behind the capability boundary; test owner-pinned digest/canonical-format/UTF-8/bounds checks, whole-catalog corrupt-input unavailability, contribution-local unsupported refusals, reserved/colliding IDs and usable unrelated contributions. Goal-only readiness SHALL remain independent of an optional unusable catalog.

### Step 39 - Implement: Establish isolated runtime installation inputs
- [x] 6.6 Implement: Create CLI-authored synthetic facet fixtures and the dedicated `deploy/runtime/facets/` project inputs using the CLI rather than hand-writing lockfiles; keep production selection empty until separately chosen, refuse contaminated runtime adapter homes, and verify generated export/bundle/cache exclusions without changing root editor inputs or archive-ignore policy. Include text-only sealing fixtures and separate server-export/provenance-refusal fixtures. Test that changing the install command's working directory does not change its absolute selected `FACET_DIR`; verify the sealed installation records the actual CLI version and platform-binary SHA-256 approved in 5.3.

### Step 40 - Implement: Add the public export fixture gate
- [x] 6.7 Implement: Add an explicitly launched interim public-export fixture check using separate runtime/editor homes: command, skill companion, agent and raw server export; alias, omission, unsupported metadata, removal and repeated install; equal text-only sealed bytes from identical inputs; altered-bundle refusal; server-bearing sealing refusal; no cross-writes in either direction and no model/tool execution. Before verification, explicitly skip only the missing lockfile server-origin join and dependent MCP-reference/full-server-bundle checks with `TODO UPSTREAM-SERVER-PROVENANCE: revisit 9.1; complete 10.1; verify 10.2`; do not defer raw server-export behavior that the current SDK already supports. Verify fixture manifests with `facet build --verify`. Add `scripts/run-facets.ts` behind `bun run test:facets`, invoking only `tests/facets/*.facet.test.ts` with disposable runtime/editor homes and an allowlisted environment. Refuse missing or mismatched pinned CLI inputs before installation; never download or repair them automatically. Add launcher-refusal coverage in `scripts/fixture-guards.test.ts` and a facet-suite exclusion witness in `scripts/test-discovery.test.ts`. Keep the suites under the existing `tests/**` exclusion; ordinary unit checks SHALL NOT run CLI installations.

### Step 41 - Implement: Document installation and sealing
- [x] 6.8 Implement: Write `deploy/runtime/facets/README.md` and update README layout/setup/install/seal/supported-subset guidance; validate commands against fixture runs and describe absolute isolated `FACET_DIR`, pinned digests, generated artifacts, explicit runtime adaptation and source-versus-export integrity without promising coding-tool parity. Describe server-bearing sealing refusal as an operational limitation while provenance support is absent, not as a completed feature or README progress narration; the tracked upstream work and return point belong in this checklist and design.

### Step 42 - Verify: Check interim public export and isolation
- [x] 6.9 Verify: Run `bun run check:verify`, `bun run test:facets` and `bun run test:container`; report exact CLI/SDK identity, text-asset reproducibility/isolation and raw server-export evidence, a working frozen-lockfile image build, and every explicitly deferred provenance-dependent check. A pass permits independent groups 7–8, but the full public-export gate remains pending until 10.2. Stop on any failure or incompatibility rather than adding skips after failure, upgrading dependencies or reading private caches.

### Step 43 - Pause: Switch model for exploration
- [x] 6.10 Pause: Switch model for exploration; completion requires the fixed pause notice and an affirmative continuation, with no question tool.

## 7. MCP configuration, credentials and transport — Research

### Step 44 - Explore: Map configuration and private credential ownership
- [x] 7.1 Explore: Inspect operator configuration, private credential file hygiene, content screening and ownership advisory locks; deliver a strict grant/secret/maintenance-lock plan with no provider authorization regression, live secret rewrite or owner-device helper.

### Step 45 - Explore: Inspect the pinned SDK transport
- [x] 7.2 Explore: Inspect pinned SDK 1.32.1 stdio lifecycle, environment defaults, pagination, deadlines, cancellation and public AJV exports; deliver the supported API and refusal map without launching a server.

### Step 46 - Explore: Inspect adapter adaptation and logging
- [x] 7.3 Explore: Inspect adapter 1.1.4 definition adaptation, generated invocation/resource helpers and debug logger; deliver the allowed adaptation path and every invocation/logging path the runtime must exclude.

### Step 47 - Explore: Inspect Bun packaging and workspace integration
- [x] 7.4 Explore: Inspect Bun 1.3.14 self-contained bundling and the package/image build graph; deliver supported inputs, dynamic/native-dependency failure cases and same-block scaffolding requirements without building anything.

### Step 48 - Explore: Inspect launch ownership and execution coverage
- [x] 7.5 Explore: Inspect workspace/execution process detectors, SDK-constructor coverage, environment preflight and execution import-closure discovery; deliver narrow transport-ownership and compatibility tests that preserve existing native restrictions.

### Step 49 - Propose: Approve the MCP boundary block
- [x] 7.6 Propose: Present the whole MCP boundary block, including package pins, protected environment, fixed state directories, discovery consent, timeouts, fixture isolation and license/docs changes; obtain approval without a production server choice, program-tree fallback, remote transport or broader schema language.

  Approval recorded 2026-10-08: owner approved the group-8 proposal, including exact `@modelcontextprotocol/sdk` 1.32.1 and `@langchain/mcp-adapters` 1.1.4 pins, with Bun 1.3.14 and existing provider/framework/Zod pins unchanged. Reuse singleton `Ownership.acquire()` for MCP maintenance without migrations or epoch claims; initialize configured MCP screening after runtime ownership is acquired. Use bounded public SDK discovery before schema compilation and an unconnected inventory-only SDK client for `loadMcpTools` adaptation; generated invocation/resource helpers remain forbidden. Use the SDK's conservative 1-MiB receive-buffer limit, fixed Bun `--no-install --no-env-file` launch flags, explicit protected environment, and tracked child-close completion. Declaration/owner literal environment duplicates must agree; literal/credential overlap and interpolation are refused. The new program package has an empty production inventory; server processes and credentials used for verification are synthetic and isolated. Verification remains ordered and stop-on-first-failure. No production server/facet selection, owner-state operation, live request, deployment, fallback or relaxation of `UPSTREAM-SERVER-PROVENANCE` was approved. Task 7.7's model-switch pause precedes implementation.

### Step 50 - Pause: Switch model for implementation
- [x] 7.7 Pause: Switch model for implementation; completion requires the fixed pause notice and an affirmative continuation, with no question tool.

## 8. MCP configuration, credentials and transport — Implementation

### Step 51 - Implement: Add strict capability configuration and grants
- [x] 8.1 Implement: Add the optional strict `capabilities` operator configuration and denied/approved server/tool-grant unions; unit-test legacy configuration, delegation limits, valid digest/identifier grammar, duplicate grants, protected or overlapping environment targets, top-level scalar equality without coercion and refusal of unsupported predicates or arbitrary cwd.

### Step 52 - Implement: Intersect authority and enforce reapproval
- [x] 8.2 Implement: Implement effective authority as captured ceiling intersected with current owner grants and command/delegate/caller restrictions; unit-test no widening from new configuration or instructions, no authority from skill loading, restart-effective revocation, declaration-wide versus tool-specific reapproval and unchanged retained definitions remaining eligible.

### Step 53 - Implement: Provision private MCP credentials safely
- [x] 8.3 Implement: Add private MCP slots with provider-equivalent atomic replacement, owner-only/non-symlink/single-link hygiene and `auth mcp set/status`; unit/integration-test stdin-only 16–16,384 printable non-space ASCII values, status-only output, singleton maintenance-lock refusal while runtime ownership is held, no epoch/migration changes and no network request or deletion.

### Step 54 - Implement: Extend known-credential screening
- [x] 8.4 Implement: Extend the opaque credential matcher and content-policy inputs to configured MCP secrets without exposing slot metadata/values; test fail-closed unusable slots, exact known-value/high-confidence screening, declaration/metadata/argument refusal before recording or dispatch, and no provider credential forwarded to a child process.

### Step 55 - Implement: Build pinned self-contained MCP programs
- [x] 8.5 Implement: Add private `packages/mcp-programs` build inputs, exact dependency provenance and content-addressed Bun-bundle manifest; test deterministic paths/digests and rejection of missing/tampered/unsupported programs, native dependencies, unresolved imports and runtime installers. Synthetic server fixtures SHALL remain test inputs, not an implicitly shipped production server. Apply the same immediate Dockerfile, build-context, package-boundary and test-discovery integration required by task 6.1 when introducing this package; do not defer it to group 16.

### Step 56 - Implement: Launch owned stdio processes with fixed state
- [x] 8.6 Implement: Add the pinned SDK/adapter dependencies and runtime-owned stdio client boundary at `packages/runtime/src/mcp/transport.ts`; test digest-checked argv with no shell, explicit scrubbed environment, discarded stderr, owner-only `RUNTIME_STATE_DIR/mcp/<serverId>/{home,tmp}` placement, symlink/unsafe-path refusal, directory persistence and no claim of process sandboxing. Update added dependency/license notices. Verify the pinned SDK/adapter public imports under Bun without network traffic. Test that introduced resume-critical MCP modules and their package closure participate in the per-provider execution manifests immediately; use existing import traversal and add explicit roots only when necessary.

### Step 57 - Implement: Enforce MCP launch and logging ownership
- [x] 8.7 Implement: Extend `scripts/workspace-boundaries.test.ts` with MCP-specific ownership checks: SDK stdio transport construction belongs only in `packages/runtime/src/mcp/transport.ts`, and new capability/MCP modules cannot bypass it through direct process APIs. Preserve the existing workspace/execution/subscription no-process/no-mutation checks and legitimate credential-lock helpers; update stale explanatory comments rather than relaxing native restrictions. Add detector fixtures for SDK construction and bypass attempts. Regression-test that enabled `DEBUG`, including the adapter's namespace, is refused before SDK/adapter import and that accepted settings produce no raw dependency payload/error logs; extend environment rules only if inspection identifies an uncovered logger control.

### Step 58 - Implement: Bound discovery and validate raw schemas
- [x] 8.8 Implement: Implement bounded connection/discovery and closed raw-schema validation before public AJV compilation or `loadMcpTools` adaptation; test 15-second/eight-page/128-tool and schema limits, unknown/ref/composition/format rejection, unchanged original arguments, no defaults/coercion and visible unsupported HTTP/OAuth/sampling/elicitation/resource/task behavior.

### Step 59 - Implement: Bound and sanitize one MCP call
- [x] 8.9 Implement: Implement the single-attempt call/result primitive with fixed safe outcome union, 1-MiB raw-message and 32-KiB argument limits, existing 64-KiB serialized result limit, absolute call deadline, cancellation and owned-child cleanup; fixture-test text screening before clipping, structured-content withholding, raw error/stderr suppression, no progress extension, retry, resource fetch or package download.

### Step 60 - Implement: Add the isolated MCP and Bun gate
- [x] 8.10 Implement: Add explicitly launched MCP/Bun fixture coverage for initialize/list/call/close, missing bundle, changed tool definition, timeout/disconnect, oversized/secret-bearing responses, environment isolation and persistent private directories; assert exact request/spawn counts and preserve failure evidence without contacting a provider or effectful remote service. Supply test-only server variants for repository-scoped success, explicit error, delay, disconnect, oversized text, credential echo, stderr noise and binary/resource content. Keep process suites under `tests/integration/`; have `scripts/run-integration.ts` build their synthetic bundles before running them, with launcher-guard coverage and no owner-state access. `bun run test:integration` SHALL run this MCP/Bun gate; ordinary unit suites SHALL NOT launch MCP servers.

### Step 61 - Implement: Document grants and private provisioning
- [x] 8.11 Implement: Update configuration examples, facet setup guidance, README credentials/security/troubleshooting, and `architecture/08-execution-security.md`/`07-network-and-protocols.md`; verify examples parse and document connection approval versus tool grants, stdin-only stopped-runtime provisioning, stdio-only support and request restriction versus unsandboxed process access.

### Step 62 - Verify: Check MCP configuration and transport
- [x] 8.12 Verify: Run `bun run check:verify`, `bun run test:integration` including the MCP/Bun gate, and `bun run test:container`; report synthetic-secret absence, maintenance-lock refusal, logging/launch-boundary coverage, manifest inclusion and a working image build. Stop on any failure without automatic fallback.

### Step 63 - Pause: Switch model for exploration
- [x] 8.13 Pause: Switch model for exploration; completion requires the fixed pause notice and an affirmative continuation, with no question tool.

## 9. Retained command starts and skill execution — Research

### Step 64 - Explore: Revisit upstream server provenance
- [x] 9.1 Explore: Revisit `UPSTREAM-SERVER-PROVENANCE`: inspect the released CLI's public lockfile server inventory, source/version/integrity linkage, authored/effective names, aliases/omissions and identical-declaration origins. Establish the actual supported schema and exact CLI binary/SDK identities without guessing fields or treating adjacent source as binary equivalence. Deliver the remaining join/reference/fixture plan for 9.4 approval; if support is still missing, report the blocker and do not proceed to dependent group-10 implementation.

### Step 65 - Explore: Map command acceptance and retained definitions
- [x] 9.2 Explore: Inspect run-service creation retry order, provider/workspace prerequisites, catalog revisions and stored execution closure; deliver the normalized-input/digest and atomic snapshot binding flow, resolving accepted request IDs before current readiness/discovery.

### Step 66 - Explore: Map actor-local skill and reference tools
- [x] 9.3 Explore: Inspect native tool admission, content policy, resource paging and model-response batch handling; deliver actor-local skill-load/reference eligibility and command-to-delegate capability wiring that preserves native confinement and immutable retained definitions.

### Step 67 - Propose: Approve the command and skill block
- [x] 9.4 Propose: Present the whole command/skill integration with service-level tests, same-response membership rules and required-MCP preflight boundaries. Include completion of `UPSTREAM-SERVER-PROVENANCE`, the actual public lockfile contract, exact CLI version/binary SHA-256 and SDK compatibility, every resumed fixture, and the full public-export gate before dependent implementation. Obtain explicit approval for any pin change and for this block without adding a template language, facet-selected root agent, additional goal-only tools or a private-cache/archive-reader workaround. Missing upstream support remains a blocker for the dependent block.

  Approval recorded 2026-10-12: owner approved the group-10 proposal and exact CLI 0.36.0 (Linux x86-64), binary SHA-256 `c7b781b1a7cac5ce459cccb41da4ad12d0e6545d5cc6381a18a90706feb8451a`, replacing the interim 0.35.0 pin. New seals SHALL require public lockfile 0.4 with manifest 0.2; SDK remains `@agent-facets/adapter` 0.30.0/API 0.3. Add exact `@agent-facets/protocol` 0.32.0 to install-time tooling only for public parsing, inventory planning/derivation and fingerprinting; lock its resolutions and update boundary/license coverage. The released inventory records each authored server's name, fingerprint and materialization beneath its facet's source/version/integrity. Recompute export fingerprints, compare complete sets and manifest intent, retain all origins and omissions, and resolve MCP references without private caches or archive readers. Regenerate only the empty dedicated runtime lockfile through the CLI in an isolated runtime-only adapter home; preserve the owner's newly regenerated editor lockfile. Upstream support is available, but the runtime join and full export gate remain unproven until 10.1–10.2, with all six deferred witnesses restored before dependent implementation.

  The approved command/skill integration preserves historical goal digests and resolves accepted request IDs before current screening/readiness/catalog/discovery; uses deterministic installation/command selection revisions, literal argument rendering, required-only approved MCP preflight, and atomic screened snapshots. Optional tools SHALL NOT cause unrelated discovery launches. Skill load outcome, membership and provenance SHALL commit together only on final success. Per-response reference eligibility SHALL be frozen in bounded runtime-owned checkpointed metadata, validated on reuse rather than trusted from provider output; sibling loading SHALL NOT enable a same-response reference. Current grants gate new operations after exact replay lookup without rewriting retained tool definitions or breaking existing delegate-question re-entry. Goal-only tools remain the native three for both providers. Group 12 owns real MCP dispatch/replay integration and group 14 owns public HTTP command exposure. Verification remains ordered and stop-on-first-failure, including the mandatory 10.2 gate before further group-10 implementation. No production facets/grants, owner-state operation, live traffic, deployment, framework/provider/Bun upgrade or fallback was approved. Task 9.5's model-switch pause precedes implementation.

### Step 68 - Pause: Switch model for implementation
- [x] 9.5 Pause: Switch model for implementation; completion requires the fixed pause notice and an affirmative continuation, with no question tool.

## 10. Retained command starts and skill execution — Implementation

### Step 69 - Implement: Complete verified server provenance
- [x] 10.1 Implement: Complete `UPSTREAM-SERVER-PROVENANCE` using the approved released public lockfile contract and exact toolchain pins. Join every selected server declaration to its originating facets/source/version/integrity and recorded alias/omission choices; retain all identical-declaration origins and reject missing/extra/conflicting records. Finish authored MCP-reference resolution through that mapping. Remove the explicitly deferred provenance skips and add server-only, deduplicated-origin, alias/omission, conflicting-declaration, frozen-install, removal/reinstall, reproducibility, altered-bundle and bidirectional-isolation witnesses. Preserve primary-source versus transformed-export integrity separation. Update fixture preflight and installation documentation to the observed supported behavior; introduce no private-cache/archive-reader dependency, fabricated provenance or unrelated SDK/provider/framework upgrade.

### Step 70 - Verify: Complete the public export gate
- [x] 10.2 Verify: Run `bun run check:verify`, `bun run test:facets` and `bun run test:container` against the completed public server-provenance integration. Report actual toolchain identities and all text/server join, reproducibility/isolation and frozen-image results; no `UPSTREAM-SERVER-PROVENANCE` witness may remain skipped. Passing the complete public-export gate is required before the remaining group-10 implementation. Stop on missing upstream support or any failed check without automatic repair, rerun, fallback or dependency upgrade.

### Step 71 - Implement: Add exclusive command start contracts
- [x] 10.3 Implement: Add normalized exclusive goal/command inputs and strict shared start/error contracts; contract tests SHALL reject both/neither modes and arbitrary prompts, graphs, paths, grants or credential references, while preserving the existing goal wire form and typed command arguments/revision. Keep the public HTTP command form disabled until group 14.

### Step 72 - Implement: Render and validate selected commands
- [x] 10.4 Implement: Implement raw-text `$ARGUMENTS` substitution or labelled append, required/optional arguments and selection revisions; unit-test blank/oversized goals, literal shell-like content, secret-bearing arguments, stale selection, missing/refused prerequisites and no automatic free-form fallback or alternate command.

### Step 73 - Implement: Capture complete immutable run capabilities
- [x] 10.5 Implement: Assemble and atomically retain immutable snapshots containing all available definitions, unloaded resources, agents, raw/adapted tool definitions, program/declaration identity, original authority ceiling and limits; integration-test digest/bounds validation, no private credentials, deduplication, installation removal and atomic rollback with no acknowledged run lacking its snapshot. Test that assembly refuses a known managed credential in any snapshot field and that its canonical digest is independent of input object key order.

### Step 74 - Implement: Preserve submitted-input creation idempotency
- [x] 10.6 Implement: Extend run creation so normalized submitted input resolves existing request identity before installation/provider/server checks; integration-test lost acknowledgements across installation updates/removal and provider/MCP outage, different-input conflicts, fresh stale-selection refusal, and zero duplicate model work or MCP preflight for accepted retries.

### Step 75 - Implement: Preflight approved required MCP definitions
- [x] 10.7 Implement: Add bounded preflight only for a new command's approved required MCP dependencies and bind the current reviewed definitions; test no tool/model call during preflight, no server launch for catalog reads, no launch without matching connection approval, optional-unavailable isolation and safe attributed start errors.

### Step 76 - Implement: Load retained skills and confined references
- [x] 10.8 Implement: Implement `mcp_LoadSkill` and `mcp_ReadSkillReference` through the actor-aware operation ledger and retained resources, atomically committing successful outcome/membership/provenance; unit/integration-test name/description-only advertisement, on-demand full instructions, idempotent membership, disallowed or unloaded/missing/escaping references, UTF-8/bounded paging, and no arbitrary filesystem/script access.

### Step 77 - Implement: Freeze reference eligibility per model response
- [x] 10.9 Implement: Capture loaded membership when a model response is admitted; test load plus independent read is allowed, sibling load does not enable a same-response reference, later responses can read it, and replay/cancellation cannot invent or lose a successful load record. Cover mixed MCP calls through test doubles here and real MCP dispatch in group 12.

### Step 78 - Implement: Bind retained definitions into execution compatibility
- [x] 10.10 Implement: Bind the root/delegate factories to retained definitions and extend per-provider execution manifests with resume-critical capability/delegate/MCP code and interpretation/tool/question versions; test install changes alone preserving continuation, code or confirmed snapshot loss refusing it, storage inspection outage accepting nothing, and native goal-only authority remaining unchanged with or without facets. Add a named regression asserting that a configured catalog leaves goal runs with exactly `mcp_Read`, `mcp_Search` and `mcp_AskUser` for both provider assemblies. Manifest tests SHALL confirm the coverage established as earlier modules landed, not introduce it for the first time here.

### Step 79 - Implement: Document command and skill retention
- [x] 10.11 Implement: Update facet metadata/argument/skill docs, README execution/compatibility and `architecture/02-control-plane.md`/`09-data-model-and-lifecycle.md`; verify the service fixture demonstrates retained first-use-after-pause, bound-versus-used provenance and no grants embedded as frozen authority.

### Step 80 - Verify: Check command acceptance and skill loading
- [x] 10.12 Verify: Run `bun run check:verify`, `bun run test:integration` and `bun run test:facets`, including the load/reference cases in the integration suite; report command retry, snapshot and ordinary-skill-batch evidence and stop on any failure. Confirm the full public-export gate remains covered with no server-provenance checks deferred.

### Step 81 - Pause: Switch model for exploration
- [x] 10.13 Pause: Switch model for exploration; completion requires the fixed pause notice and an affirmative continuation, with no question tool.

## 11. MCP dispatch through the durable run boundary — Research

Revision recorded 2026-10-13: owner approved replacing the global hashed tool-name scheme with design Decision 6's readable canonical names and provider-owned two-way translation. The existing dispatch findings and approval below remain historical evidence; only the naming/provider-integration portion requires renewed research and approval. Tasks 11.1–11.3 and 12.1 are reopened for that refinement, not to repeat unrelated research or discard existing implementation. Task 12.2 remains incomplete: its first production Anthropic dispatch witness was refused locally by the subscription profile before a model request. The former 12.1 unit pass does not establish the revised naming contract. This planning revision authorizes no repair, test rerun or application edit by itself; implementation follows the revised research, approval and pause steps. Earlier completed blocks, archived/adversarial artifacts and phase-1 acceptance remain unchanged.

### Step 82 - Explore: Map MCP admission and provider translation
- [x] 11.1 Explore: Retain the delivered operation-replay, current-grant, cancellation-gate and commit-certainty findings and call-admission/crash-window matrix. Inspect the pinned Anthropic auth/provider and OpenAI request/response paths to locate provider-owned canonical-to-wire-to-canonical translation, including outgoing definitions, tool choices and historical calls, incoming streamed calls, existing name/schema refusals and immutable profile/compatibility rules. Deliver a focused integration map for reversible request-local mappings, unchanged compatible names, alias/canonical collision handling, logical-request retry stability and restoration before agent dispatch or persistence. Distinguish locally imposed restrictions from proven provider requirements; do not launch servers, contact providers, upgrade dependencies or repeat unrelated completed research.

### Step 83 - Propose: Approve durable MCP dispatch and provider translation
- [x] 11.2 Propose: Present the whole ledger-to-MCP wiring and delegate replay gate completion, retaining the previously approved current-grant, actor-cancellation, one-SDK-attempt and terminal-uncertainty scope. Obtain approval for the concrete canonical-name/provider-translation integration and finite tests: readable provider-neutral identities, explicit server/tool bindings, names-only bidirectional adaptation in the applicable provider integration, immutable request-local inverse mappings, streamed response restoration, historical calls/tool choices, and compatibility/provenance-documentation changes. Identify any necessary immutable-profile versioning explicitly. No universal hashed/Ext naming, provider replacement, generic confirmation, automatic recovery or unrelated dependency upgrade is authorized.

  Approval recorded 2026-10-13: owner approved the group-12 proposal. Wrap retained MCP definitions in runtime-owned tools; preserve raw approval digests, stable wire names, no-launch inspection and goal-only native authority. Resolve exact replay before current permission checks. For new calls, intersect captured/current/command/delegate authority, revalidate the retained declaration against current program/environment bindings, validate original arguments and screening, then commit fenced dispatch intent and initiate one SDK request under the existing cancellation gate; no network wait spans that gate or a database transaction. Use lazy invocation-owned connections keyed by server ID and approved digest, shared by root/delegates; serialize calls per connection outside the run gate and perform bounded tool listing before each new operation, without notification/cache-invalidation machinery. Replay SHALL launch/list/call nothing. Controller and cancellation settlement SHALL await common connection cleanup at pause, finish or failure, preserving server data and introducing no automatic reconnect or retry.

  Persist safe outcomes before model consumption and resolve ambiguous commits by exact same-owner readback. A confirmed first admission may initiate its one request; pre-existing intent or unresolved admission SHALL NOT authorize a send. Pending intent or completed uncertainty SHALL terminate execution as `tool_failure` / `mcp_outcome_unknown`, without a subsequent model turn or queued recovery dispatch; cancellation/interruption retains precedence, and lost ownership or unresolvable storage uses fail-stop. Wire current `effectiveAgents` checks for new delegations while preserving existing recorded delegate re-entry. Include focused behavioral, cancellation/crash, commit-readback, credential-capture and fresh-process PostgreSQL/real-MCP witnesses, mixed skill/MCP batches and shared-budget tests through both scripted provider assemblies. Update affected execution compatibility inputs, README and architecture 08/09. Do not restore the owner-deleted source-scanning checks. Pins and applied migrations remain unchanged; no production grants, owner-state operations, live traffic, deployment or public HTTP command starts were approved. Task 11.3's model-switch pause precedes implementation; task 12.9 runs `check:verify` then `test:integration`, stopping at the first failure without automatic repair or rerun.

  Revised approval recorded 2026-10-13: owner approved the canonical-name/provider-translation integration. Canonical MCP names are `mcp_<serverId>_<toolName>` without normalization or truncation (at most 197 characters); cross-server canonical collisions refuse the affected bindings, built-in names stay reserved and dispatch uses the retained server/tool pair. A forward migration widens stored operation/history tool names to 197 characters with matching runtime/API validation; applied migrations and existing records are unchanged. Each provider supplies a names-only model-call adapter through the existing public `wrapModelCall` boundary: an immutable per-call bijection over definitions, explicit tool choices and historical calls keeps compatible names and assigns short deterministic aliases otherwise, translates request copies only and restores parsed response names before screening, persistence and dispatch; unknown/ambiguous aliases are refused. Anthropic keeps its existing wire-name convention; OpenAI uses the pinned SDK-documented function-name subset (letters, digits, `_`, `-`, at most 64), not claimed as live-backend validation. No SSE parser, model subclass, provider-profile ID/value change or endpoint/authentication change. Naming behavior is versioned through execution compatibility; exact legacy hashed names remain decodable in historical snapshots, new snapshots emit canonical names only, and incompatible continuations are refused without rewriting records. The previously approved dispatch, replay, connection, uncertainty and verification scope is unchanged.

### Step 84 - Pause: Switch model for implementation
- [x] 11.3 Pause: Switch model for implementation; completion requires the fixed pause notice and an affirmative continuation, with no question tool.

## 12. MCP dispatch through the durable run boundary — Implementation

### Step 85 - Implement: Bind canonical tools and translate provider wire names
- [x] 12.1 Implement: Wrap adapted MCP definitions with runtime-owned LangChain tools named `mcp_<serverId>_<toolName>`, preserving component spellings, existing built-in names and explicit retained server/tool bindings. Update the adapter/snapshot name handling without rewriting existing stored records; test canonical collision/reserved-name refusal, no underscore-based identity inference, unchanged raw approval digests and no invocation of adapter-generated call/resource helpers. Implement only necessary names-only canonical-to-wire-to-canonical adaptation in each applicable provider integration, with Anthropic adaptation owned by its auth/provider code rather than shared tool construction. Add focused tests for unchanged compatible names, casing/character/length adaptation, one-to-one mappings including unchanged names, unknown/ambiguous aliases, outgoing definitions/tool choices/historical calls, streaming chunk boundaries, logical-request retry stability and root/delegate/concurrent-request isolation. Verify restored canonical names before agent dispatch/checkpointing and unchanged call IDs, arguments, results, schema semantics, permissions, response-completion checks and physical-request accounting. Include the affected translation code/protocol in per-provider execution compatibility and exercise the production provider request/response paths, not only standalone naming helpers.

### Step 86 - Implement: Admit one authorized durable MCP operation
- [x] 12.2 Implement: Wire dispatch in the designed order: exact replay, active actor/contribution, current matching server/tool grants, raw schema and argument equality, secret-safe arguments, then final ownership/run/cancellation admission with durable intent; integration-test out-of-scope repository and other denied cases send zero `callTool` requests while matching grants need no generic confirmation. Through both scripted production provider assemblies, verify that returned wire names restore to the intended canonical binding and the MCP server receives its original tool name. Independent fixture counters SHALL observe exactly one SDK `callTool` attempt per admitted new operation and zero for refused or completed-replay operations; name translation SHALL NOT add model requests or external attempts.

### Step 87 - Implement: Serialize MCP initiation with cancellation
- [x] 12.3 Implement: Serialize final definition/grant checks and SDK request initiation with cancellation acceptance, with connections/discovery tracked outside short gates; race-test no dispatch after accepted cancellation, call deadlines, best-effort child termination, settled local work, no late root success and no claim that external effects were undone.

### Step 88 - Implement: Settle shared invocation-owned MCP sessions
- [x] 12.4 Implement: Share invocation-owned connections by approved server identity between root/delegate and close them at settlement, human pause or failure; test one appropriate connection per identity, separate short-lived inspection, retained directory data and no durable MCP-session promise or automatic reconnect/retry of an operation. For a successful fixture invocation using one approved server identity, multiple root/delegate calls SHALL share one child process, which closes at pause or settlement; count separate discovery/preflight connections separately. An accepted creation-request retry SHALL launch zero processes.

### Step 89 - Implement: Persist outcomes before model consumption
- [x] 12.5 Implement: Record safe completed outcomes atomically before model consumption and reuse exact completed bindings before new-dispatch permission checks; integration-test new identical-argument operations remain new, completed replay after grant revocation sends nothing, ambiguous completion commits never fabricate success, and recognized credentials never reach graph/checkpoint/history. Verify that structured tool identities in retained definitions, checkpoints and history remain canonical, with unchanged tool-call IDs and argument bindings; provider-local aliases SHALL NOT become durable operation identity or cause stored records to be rewritten.

### Step 90 - Implement: Stop runs on unknown external effects
- [x] 12.6 Implement: Record unconfirmed external intent as uncertain and end the run with `tool_failure`/`mcp_outcome_unknown` unless cancellation/interruption already determines it; crash/disconnect tests SHALL prove no automatic retry or later model turn, inspectable prior progress and no false claim of delivery, success or zero effect.

### Step 91 - Implement: Complete real MCP delegate replay coverage
- [x] 12.7 Implement: Complete the PostgreSQL fresh-process delegate gate using the bundled MCP fixture rather than only a stand-in; test an MCP operation before each of two questions, exact negative answers across restart, unchanged completed-call counts, genuinely new identical-argument calls, mixed skill-load/MCP batches and shared-budget exhaustion through both scripted provider assemblies. Assert canonical tool identities across root/delegate requests, persisted history and restart, correct re-translation of outgoing historical calls, isolated per-request mappings, and original server-side tool names without repeated effects or added physical model requests.

### Step 92 - Implement: Document canonical names, dispatch and uncertainty
- [x] 12.8 Implement: Update README MCP/restart/uncertainty and provider guidance, `architecture/07-network-and-protocols.md`/`08-execution-security.md`/`09-data-model-and-lifecycle.md`, and the Anthropic subscription package's README/PROVENANCE documentation. Replace the blanket no-response-rewriting/no-aliasing account, including intentional difference D1, with the narrow provider-owned names-only round trip and canonical runtime/persisted identities; preserve upstream source hashes and historical extraction evidence rather than claiming upstream synchronization or live validation. Verify matching grants remain distinct from workflow-specific approvals, unknown replies leave external recovery to the owner, existing stored records remain immutable and any required profile change follows the existing compatibility rules.

### Step 93 - Verify: Check the complete durable MCP boundary
- [x] 12.9 Verify: Run `bun run check:verify` and `bun run test:integration`, including the MCP/Bun and full durable-delegate gates; report both-provider canonical/wire round-trip, persisted-identity, dispatch-intent and uncertainty evidence before exposing capabilities through the browser. Preserve the existing stop-on-first-failure rule; a naming-helper unit pass SHALL NOT substitute for the production provider integration witnesses.

### Step 94 - Pause: Switch model for exploration
- [x] 12.10 Pause: Switch model for exploration; completion requires the fixed pause notice and an affirmative continuation, with no question tool.

## 13. Browser catalog, command mode and provenance — Research

### Step 95 - Explore: Map safe capability routes and event replay
- [x] 13.1 Explore: Inspect HTTP security/acceptance envelopes, projection, SSE replay and strict contracts; deliver route/event mappings for catalog, explicit discovery, retained run capabilities and actor-attributed legacy-compatible history without exposing private bindings.

### Step 96 - Explore: Map the additive browser journey
- [x] 13.2 Explore: Inspect `Home.tsx`, `RunDetail.tsx`, API client, timeline and browser fixtures independently; deliver a small UI plan for command selection, grants/refusals, discovery and actor/provenance labels with the existing provider/question/cancel experience intact.

### Step 97 - Propose: Approve the server and console block
- [x] 13.3 Propose: Present the complete server-and-console block, including no-launch reads, plain-text rendering and both-provider scripted browser cases; obtain approval without facet management, approval-editing APIs or a separate multi-agent dashboard.

  Approval recorded 2026-10-14: owner approved the server-and-console block. Add strict browser-safe schemas and `GET /capabilities` (installed contributions, command argument requirements and selection revisions, configured grants and last discovery observations; never launches), `POST /capabilities/servers/:serverId/discover` (`{ catalogRevision }`, the verified installation digest; a stale revision is `409 capability_selection_changed` before launch; current connection approval checked first; one short-lived initialize/list/close; no tool or model call and no approval change) and `GET /runs/:runId/capabilities` (retained definitions, provenance, aggregated usage, actors, limits and captured/recorded/current permission explanations read under one consistent view with `throughSeq`; no catalog dependency, graph invocation or launch; missing or corrupt retained data is unavailable, never replaced by the current installation). Discovery observations live in a bounded in-memory cache keyed by installation, server and effective connection digest, cleared on restart, with concurrent inspections of one binding coalesced; observations carry their time, never authorize dispatch or replace preflight, and nothing discovers in the background or polls. Projections expose public names, descriptions, facet names/versions/integrity, approval digests and screened argument restrictions, never launch configuration, environment values, credential slots, private paths, checkpoint bindings or whole snapshots; refusal names and metadata are screened too. Enable the exclusive command start over HTTP with lookup-first retries; the console keeps Goal as the default mode, adds an explicit Command mode with description, raw arguments and availability, shares provider selection and browser login, loads the catalog on demand with explicit refresh only, never turns a refused command into a goal, and keeps the exact submitted payload and request ID after an unknown acknowledgement with a "Retry same start" action. The run page adds a compact capabilities panel and the question asker, enriches capability history with retained origins, refreshes the panel on relevant activity with coalesced requests and renders all supplied content as plain text. Verification extends the existing fixtures (zero-launch reads, one-connection discovery, HTTP command starts, both scripted providers through the browser with the real synthetic MCP server, reconnect, cancellation, retained views after uninstall, goal/login regressions and credential/markup capture) and the browser launcher with the existing disposable MCP-program preparation; gates run `check:verify`, `test:integration` then `test:browser`, stopping at the first failure. No migration, facet or grant editing, separate agent dashboard, live provider traffic or deployment.

### Step 98 - Pause: Switch model for implementation
- [x] 13.4 Pause: Switch model for implementation; completion requires the fixed pause notice and an affirmative continuation, with no question tool.

## 14. Browser catalog, command mode and provenance — Implementation

Revision recorded 2026-10-15: after the first 14.8 run failed in `check:verify` (an unrecorded runtime test under load), the owner directed that behavior be tested through logic, service, API and process-level tests, console behavior through component and data-pattern unit tests, and real browsers only as smoke checks; slow, low-value tests are made fast or removed. Design Decision 11 records the rule. Tasks 14.8 and 18.1–18.4 are reworded accordingly. The browser suite is reduced to one goal-run and one command-run smoke check with a single scripted provider; the deployment-ceiling case moves to the API suite; login, conflict, cancellation, retry, both-provider and capture journeys remain covered at the API, service and integration level. 14.8 reruns from `check:verify` with its full output kept.

### Step 99 - Implement: Expose safe capability inspection and discovery
- [x] 14.1 Implement: Add strict safe catalog/discovery/run-capability schemas and complete the new error/event variants, then implement `/api/v1/capabilities`, server discovery and run capability routes; contract/API tests SHALL enforce bounds, Host/Origin/body/security headers, configured-versus-effective grants, no credential/environment/slot/checkpoint exposure and no launch on GET. API fixture counters SHALL show zero launches for catalog GET or refused discovery, and exactly one short-lived connection/process for one successful explicit discovery action.

### Step 100 - Implement: Enable validated command starts through HTTP
- [x] 14.2 Implement: Enable the exclusive command start through HTTP only after prerequisite backend gates pass; integration-test status/error mappings, zero work for refused selections, uncertain-acceptance retry behavior and unchanged goal starts/provider authorization.

### Step 101 - Implement: Add command selection and installed capability views
- [x] 14.3 Implement: Add goal/command mode, command description/arguments/revision/readiness and installed-contribution/server inspection to the start view; unit/browser-test no-argument commands, stale/unsupported/missing selections, explicit native-goal selection when the catalog is unconfigured/unavailable, discovery without approval mutation and retained request IDs after unknown acceptance. Never silently turn a refused command into a goal run.

### Step 102 - Implement: Show retained and actually used capabilities
- [x] 14.4 Implement: Add the retained capability panel with command/origin/version, bound versus used items, limits and recorded/current permission explanations; test viewing finished runs after uninstall/restart without fetching new definitions, starting a server or invoking a graph/tool.

### Step 103 - Implement: Attribute ordered history and pending questions
- [x] 14.5 Implement: Extend ordered history, pending questions and results with actor/public contribution labels, delegation start/end and uncertainty; UI/timeline/browser tests SHALL distinguish repeated named delegates, original asker, delegate result versus root final result, exact negative answers, cancellation, legacy events and reconnect replay with no duplicate or missing event.

### Step 104 - Implement: Add safe browser projection fixtures
- [x] 14.6 Implement: Add credential-bearing and markup-like catalog, discovery, argument, question and result fixtures to contract/projection/browser capture tests; verify plain-text rendering, no external resource loading, no secrets in responses/SSE/console, and no internal imports in the UI bundle.

### Step 105 - Implement: Document capability usage without status narration
- [x] 14.7 Implement: Update README console/API/usage/troubleshooting and `architecture/07-network-and-protocols.md` alongside the routes; remove README milestone/progress/status narration from its introduction, Providers and Limitations rather than update it, preserving setup, operational caveats and stable historical evidence links. Verify documented requests and links against API/browser fixtures.

### Step 106 - Verify: Check the server-and-console block
- [x] 14.8 Verify: Run `bun run check:verify`, `bun run test:integration` and `bun run test:browser`; report both-provider command/delegate question, replay and provenance results from the API and integration suites, the two browser smoke checks, and the goal-only and provider-login regressions still green.

### Step 107 - Pause: Switch model for exploration
- [x] 14.9 Pause: Switch model for exploration; completion requires the fixed pause notice and an affirmative continuation, with no question tool.

## 15. Reproducible deployment inputs — Research

### Step 108 - Explore: Map image inputs and isolated deployment fixtures
- [x] 15.1 Explore: Inspect `Dockerfile`, `.dockerignore`, Compose, build manifests, environment allowlists and disposable container/rollback fixtures; deliver a read-only bundle/program mount and private-state plan that preserves the existing topology and owner volumes.

### Step 109 - Propose: Approve reproducible deployment packaging
- [x] 15.2 Propose: Present the complete image/configuration/documentation block and synthetic container witness, including no-production-server defaults, old-waiting-run incompatibility and schema-aware rollback limits; obtain approval for repository/test changes only, not live deployment or maintenance of owner state.

  Approval recorded 2026-10-18: owner approved the group-16 packaging proposal for repository and test changes only. Build `packages/mcp-programs` in the image and copy its manifest and digest-addressed artifacts beneath `/opt/agent-runtime/mcp/`, keeping the production inventory empty and synthetic servers out of the default image; verify manifest paths/digests, unchanged provider execution manifests and no installer/Node fallback. Add an explicitly selected `compose.facets.yaml` overlay that requires `AGENT_RUNTIME_FACETS` only when selected and binds that file read-only at `/etc/agent-runtime/facets/installation.json` without creating a host path; the base Compose file stays usable without facets, with its three services, volumes and security limits unchanged. Extend the isolated container fixture with read-only synthetic program and sealed-bundle mounts: catalog reads launch nothing, explicit discovery launches only the expected process, a test-only helper checks private `cwd`/`HOME`/`TMPDIR` placement, retained server data and cleanup through the production MCP boundary without a model request or new endpoint, stopped-runtime stdin provisioning succeeds and is refused while ownership is held, and missing/tampered artifacts are refused; networks stay internal and credentials synthetic. Extend the rollback fingerprint to retained capability records and MCP credential files; verify that disabling capabilities refuses fresh command starts while retained history stays readable; add a PostgreSQL migration-4→5 preservation test and a schema-4 registry refusing schema 5 without changing storage, labelled as a compatibility fixture rather than proof of historical-binary rollback. Keep the compatible-image rollback check; add no down-migration or restore automation. Update README, `.env.example`, deployment examples, facet setup guidance and applicable notices; the native example stays capability-free. Verification runs `check:verify` → `test:integration` → `test:browser` → `test:container` with complete logs, stopping at the first failure. No dependency upgrade, further timeout cleanup, live deployment or owner-state operation was approved.

### Step 110 - Pause: Switch model for implementation
- [x] 15.3 Pause: Switch model for implementation; completion requires the fixed pause notice and an affirmative continuation, with no question tool.

## 16. Reproducible deployment inputs — Implementation

### Step 111 - Implement: Package reproducible program and build inputs
- [x] 16.1 Implement: Complete final program-artifact packaging on top of the package/Dockerfile scaffolding already landed in groups 6 and 8, without importing install-time code into browser/provider runtime boundaries; build tests SHALL verify exact program manifest digests under `/opt/agent-runtime/mcp/<programId>/<sha256>.js`, relevant execution closure changes and no on-demand installer/Node fallback or test-only server in the default image.

### Step 112 - Implement: Mount sealed facets without widening writes
- [x] 16.2 Implement: Add optional `AGENT_RUNTIME_FACETS` host bundle wiring to the fixed read-only `/etc/agent-runtime/facets/installation.json` destination and complete non-secret examples; configuration/container tests SHALL cover native deployment without a selected facet bundle as well as approved synthetic capability deployment, preserving workspace/config/root read-only mounts and existing private-state/tmp limits.

### Step 113 - Implement: Exercise packaged MCP state and provisioning
- [x] 16.3 Implement: Extend the isolated container fixture to supply an explicitly test-built program and sealed bundle read-only, exercise persistent server cwd/HOME/TMPDIR and stopped-runtime stdin provisioning, and refuse tampered/missing artifacts; assert no additional writable mount, host credential access, provider request, package download or Tailscale enrollment.

### Step 114 - Implement: Preserve storage across supported upgrade paths
- [x] 16.4 Implement: Extend upgrade/compatibility fixtures for the new migration and stored capabilities, preserving record/credential fingerprints; test disable-new-starts configuration rollback and newer-schema rejection by an incompatible binary without executing a down-migration or claiming phase-1 binary compatibility.

### Step 115 - Implement: Document packaging and rollback limitations
- [x] 16.5 Implement: Complete README deployment/commands, `.env.example`, `deploy/runtime/config.example.json`, facet setup guidance and third-party notices; validate documented install/seal/mount/discover/grant/provision steps on synthetic inputs and explicitly document finishing/cancelling old waiting runs before upgrade, preserved history and owner-directed recovery with no automatic deletion/restore.

### Step 116 - Verify: Check isolated deployment and preserved state
- [x] 16.6 Verify: Run `bun run check:verify`, `bun run test:integration`, `bun run test:browser` and `bun run test:container`; report image identities, read-only mount assertions and preserved-storage evidence without touching the live deployment.

### Step 117 - Pause: Switch model for exploration
- [x] 16.7 Pause: Switch model for exploration; completion requires the fixed pause notice and an affirmative continuation, with no question tool.

## 17. Integrated phase-2 witnesses — Research

### Step 118 - Explore: Map requirements to phase-2 evidence
- [x] 17.1 Explore: Map every capability and execution-delta scenario plus the four design gates to existing results and remaining cross-component cases; deliver a coverage matrix distinguishing unit, PostgreSQL/process, MCP/Bun, browser/container and live evidence, with no substitution of the MemorySaver probe or accepted phase-1 exceptions.

### Step 119 - Propose: Approve the final finite integration witnesses
- [x] 17.2 Propose: Present the final finite synthetic witness and evidence plan for both stock provider assemblies, including secret capture, retained definitions, revocation and goal-only regressions; obtain approval for its exact scope and identify any owner-only live/deployment/acceptance decisions separately rather than authorizing them implicitly.

  Approval recorded 2026-10-18: owner approved the final witness and evidence scope for repository/test changes only. Extend the existing two-provider real-MCP fresh-process witness rather than add a harness: start and answer through the production API, read the bundled skill reference in a response after its load, keep process death, two delegated questions and exact `false` answers, verify root/delegate results, bound-versus-used provenance, canonical identities and no fallback, and compare paginated API history with SSE including reconnect cursors (9 model requests: 5 + 2 + 2; 3 server starts, 4 listings, 3 calls). For each provider, cover installation replacement and removal before first use of a retained skill/reference and agent across a fresh process, a new run seeing the replacement, restart-effective MCP revocation that replays the completed persisted outcome but refuses and never sends a genuinely new call, finished-history inspection without the installation starting nothing, and an unavailable optional catalog leaving native goal runs with exactly the three native tools. For each provider, add bounded success/recoverable and uncertain privacy-capture cases across model inputs, retained definitions, checkpoints, operations, history, API, SSE, final results and diagnostics; failures report only surface names and counts, never captured payloads or the credential. Add parameterized traceability for unsupported background/parallel/long-lived and automatic-composition metadata, a refused-prerequisite command start with zero model requests or server starts, and an editor-only selection remaining unavailable. A functional gap found by these witnesses stops for an owner decision. Verification runs `test:facets` → `check:verify` → `test:integration` → `test:browser` → `test:container`, stopping at the first failure; then the evidence report and read-only checks. No browser journeys, dependency upgrades, timeout cleanup, source-scanning checks, production facets/grants, live traffic, deployment, owner-state operation, archive or acceptance decision was approved.

  Clarification recorded 2026-10-20: a completed MCP call is not re-entered after an ordinary restart, because its outcome is already in the saved graph state; ledger replay is reachable only for staged re-entry. The owner chose the real flow only: the fresh-process revocation witness shows the completed outcome recorded unchanged and carried to the model from saved state with no further server request, and a new call refused and never sent. The ledger's replay-before-permission check remains covered by `packages/runtime/src/execution/mcp.test.ts:195`, and the evidence report says so. No staged re-entry test is added.

### Step 120 - Pause: Switch model for implementation
- [x] 17.3 Pause: Switch model for implementation; completion requires the fixed pause notice and an affirmative continuation, with no question tool.

## 18. Integrated phase-2 witnesses — Implementation

### Step 121 - Implement: Complete both scripted end-to-end journeys
- [x] 18.1 Implement: Add only cross-component missing witnesses: installed command → on-demand skill/reference → delegate → approved MCP tool → delegated question → exact answer → delegate outcome → final root result for Anthropic and OpenAI scripted assemblies, through the API; verify no provider fallback, fresh-process continuation, actual-use provenance, shared accounting and final ordered history from the API and event stream. Browser coverage stays the existing smoke checks.

### Step 122 - Implement: Complete retention and revocation integration
- [x] 18.2 Implement: Add cross-component installation replacement/removal and configuration-revocation cases: load an unused retained skill/reference or agent after restart, reuse completed outcomes but deny revoked new calls, and inspect old history without installation; verify optional capability failures do not widen or disable an otherwise ready native goal run and no required scenario remains skipped.

### Step 123 - Implement: Capture whole-journey credential privacy
- [x] 18.3 Implement: Add a whole-journey synthetic-credential capture assertion across model inputs, checkpointed tool results, retained definitions, histories, API responses, SSE, final results and diagnostic output; verify only the intended test server receives its value, with failure/refusal/uncertain paths included and raw sensitive evidence never saved. Rendering is covered by the console's component tests, not a browser journey.

### Step 124 - Verify: Run the final bounded synthetic witnesses
- [x] 18.4 Verify: Run `bun run test:facets`, `bun run check:verify`, `bun run test:integration` including the MCP/Bun gate, `bun run test:browser` and `bun run test:container` on the final changed inputs; stop at the first failure and report successful/failed/not-run distinctions, exact request counts, versions and fixture identifiers; `test:browser` is the two smoke checks. Do not run live acceptance or deploy.

### Step 125 - Implement: Record attributable phase-2 integration evidence
- [x] 18.5 Implement: Write a phase-2 evidence report under `architecture/integration-evidence/mvp-02/` mapping every delta scenario and design gate to its actual test/result, code revision, pinned tools and retained safe outputs; label live/deployment checks not performed and owner decisions still pending. Verify the report contains no missing required synthetic witness, invented pass or phase-1 exception carried forward as approval.

### Step 126 - Verify: Check evidence integrity and planning consistency
- [x] 18.6 Verify: Run strict OpenSpec validation and read-only evidence/link/whitespace checks after the evidence-only write; verify the report matches observed results and historical/adversarial files are unchanged, without rerunning unchanged application trials or claiming live acceptance.

### Step 127 - Review: Present results and remaining owner decisions
- [x] 18.7 Review: Present the completed scenario/gate matrix, remaining limitations and any separately required live/deployment/acceptance decisions, then request feedback through the question gate. Completion means feedback is recorded; this step neither runs live work nor declares owner acceptance, synchronizes specs or archives the change automatically.

  Feedback recorded 2026-10-20: owner reviewed the scenario/gate matrix, limitations and pending decisions and chose "Looks good, continue". This records feedback only; it is not owner acceptance of the phase, and no live trial, deployment, commit, spec sync or archive was performed or authorized.
