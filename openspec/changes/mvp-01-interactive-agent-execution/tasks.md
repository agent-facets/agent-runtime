> **Before executing any tasks below**, load the `viper-execution-rules` skill for the full VIPER step protocol (step types, execution rules, gating, and hard constraints).

# Tasks

Implement the reconciled [proposal](proposal.md), [execution specification](specs/execution/spec.md), and [design](design.md). All checkboxes start unfinished; creating this artifact does not execute the work.

Owner-approved refinement on 2026-09-29 adds the Bun/Turbo monorepo and separate runtime/UI package boundaries after the original adversarial reconciliation. Retained adversarial artifacts/reviews describe the earlier revision, not a new review of these edits. Task identities, ordering and model-switch pauses are preserved; updating this plan marks no implementation work complete.

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

Each Step heading and its single numbered checkbox represent the same task, not two tasks. The execution TODO SHALL match the heading's type and description; the checkbox records OpenSpec progress. Sub-content does not create extra TODOs. Model-switch pauses are retained by owner choice; their completion evidence is the owner's affirmative continuation under the legend's fixed-notice protocol.

Execution constraints:

- The executor SHALL preserve the historical spikes, unrelated working-tree changes, and existing adversarial history. It SHALL NOT add Phase-2 facets, memory, API-key operation, arbitrary commands, workspace writes, or automatic active-run recovery.
- Each block SHALL land its own tests and documentation. Block checks mean `mise exec -- bun run check:verify`: forced execution of repository lint, root-script and package typechecks, repository-script and package deterministic tests, and the application build, plus the applicable explicitly invoked integration suite. Scaffolding establishes this command before subsequent blocks use it. Direct `bun test` and root `test`, `typecheck` and `lint` scripts SHALL remain available; a Turbo cache hit SHALL NOT count as freshly executed block-acceptance evidence.
- The Bun workspace SHALL separate `packages/runtime` from `packages/ui`, with one application deployment. Root configuration owns shared tooling; package manifests own application dependencies and use `workspace:*` for internal links. `packages/contracts` SHALL be introduced with the API block for pure browser-safe wire schemas/types, not server records or credential handling. The UI SHALL NOT import runtime internals. Package scaffolding does not authorize console feature work before the pre-console gates.
- Default tests SHALL be deterministic and independent of live credentials, provider traffic, production databases, and production services. Integration commands SHALL require isolated test storage and explicit invocation; fixtures SHALL never reset owner volumes or import spike credentials.
- Future-block test cases MAY remain explicitly skipped with a task reference until their prerequisite lands. A skipped mandatory G1–G5 check SHALL NOT count as passed. All Phase-1 acceptance skips SHALL be resolved before final acceptance.
- The owner SHALL supply the maintained Anthropic release required by design Decision 10. Blocks 1–8 and the explicitly mock-backed preparation in block 10 can proceed before delivery. Block 9 records the owner handoff; block 10 has one release-dependent pin/bind step after preparation. If the release is missing, execution SHALL stop there without skipping ahead. Real G2 and offline G4/G5 remain mandatory before console buildout. No fake, copied implementation, private import, global-fetch patch or upstream source edit substitutes for the release.
- Live verification SHALL have fresh approval for the named provider/model, account setup or renewal operations, maximum physical model requests, and any retry allowance. Approval of this task list or a prior spike SHALL NOT grant that authority. Operator login SHALL occur in the owner's private terminal; only safe readiness and verification outcomes enter the execution transcript.
- Verification failures SHALL stop dependent work. Changed approaches require explicit replanning; failed Bun checks SHALL NOT silently select Node, a custom saver, a middleware-only request counter, or billed access.
- Gate evidence SHALL live under `architecture/integration-evidence/mvp-01/`, indexed from `architecture/spike-reports/README.md`. Fixed files are `g1-bun-persistence.md`, `g2-anthropic-boundary.md`, `g3-dispatch-lifecycle.md`, `g4-anthropic-offline.md`, `g4-anthropic-live.md`, `g5-openai-offline.md`, `g5-openai-live.md`, `upstream-handoff.md`, `openai-cost-checkpoint.md`, and `phase-exit.md`.
- Evidence SHALL identify the tested source/dependency/image versions, commands, actual outcomes, observed physical-request counts, applicable owner authorization, unresolved failures and skipped cases. Tokens, authorization codes, raw provider bodies and sensitive fixture content SHALL NOT be recorded.
- Explore, Propose, Review and Verify steps SHALL NOT edit repository evidence files. Verify emits safe results; subsequent Implement steps transcribe those observed results and update the index, followed by a Verify of the records. No report SHALL claim a future check passed. Later reruns SHALL retain their own provenance rather than silently relabel earlier evidence.

## 1. Development foundation — Research

### Step 1 - Explore: Inventory the scaffold and preserved work; verify cited scope
- [x] 1.1 Explore: Inventory the scaffold and preserved work; verify cited scope

Inspect the existing Bun scaffold, mise configuration, root instructions and preserved spike directories. Distinguish files to extend from historical evidence and unrelated files to preserve; report the inventory with references.

Include the root-to-workspace migration, shared tooling versus package-owned dependencies, and runtime/UI import boundaries. Use the inspected Facets and Facet Registry Bun/Turbo conventions as references, not runtime dependencies or permission to copy their deployment, publishing, hook or credential-loading machinery.

### Step 2 - Explore: Assess pins and deployment prerequisites; verify the dependency inventory
- [x] 1.2 Explore: Assess pins and deployment prerequisites; verify the dependency inventory

Inspect selected dependency/image candidates and Compose/Tailscale requirements. Identify the owner-maintained auth-library release prerequisite early, so upstream delivery can proceed alongside independent work. Report the candidate pin matrix and gate ordering without installing packages or contacting providers.

Assess Turbo task inputs/outputs, local-only caching and browser/server TypeScript configuration. Check the design's Bun 1.3.14, Turbo 2.10.4 and other development-tool candidates, including the corrected core 1.2.13 candidate required by LangChain 1.5.14. Package metadata compatibility is not a passed Bun integration gate.

### Step 3 - Propose: Present foundation changes and upstream handoff; obtain owner approval
- [ ] 1.3 Propose: Present foundation changes and upstream handoff; obtain owner approval

Present scaffold, test isolation, container topology and commands. Notify the owner of the release contract needed at block 9; missing delivery does not prevent the independent work in blocks 1–8. Obtain approval for the next implementation block without implying provider authorization or upstream source-edit permission.

Include separate runtime/UI package scaffolding, the deferred contracts package, shared configuration, Turbo task/cache policy and the single application-build boundary. Functional UI work remains in its later block.

## 2. Development foundation — Implementation

### Step 4 - Pause: Switch model for implementation
- [ ] 2.1 Pause: Switch model for implementation

### Step 5 - Implement: Pin the toolchain and commands; verify frozen installation and scaffold checks
- [ ] 2.2 Implement: Pin the toolchain and commands; verify frozen installation and scaffold checks

Extend root `package.json`, `bun.lock` and `mise.toml` into the Bun/Turbo workspace. Add `turbo.json`, root/package Bun configuration, shared strict TypeScript and Biome configuration, root scripts, and separate `packages/runtime`/`packages/ui` package scaffolds. Replace the root Bun-init entrypoint with the runtime package entrypoint; root scripts remain the documented interface. Pin Bun and dependencies, remove unused floating Node, and establish frozen-install/dev/start/build/check/check:verify/test/typecheck/lint plus explicit integration commands. Root owns development tooling; packages declare their own application dependencies and use `workspace:*` for internal links. Include checks preventing runtime imports from `spikes/**` and UI imports of runtime internals.

Implement the design's Turbo task graph, local-only cache policy and actual application-build outputs. Use separate browser/server TypeScript environments. Establish only the UI package/configuration boundary here; do not implement browser features, add a speculative contracts package or fabricate passing UI feature tests for an empty shell. React dependencies and the functional HTML entry arrive in the console block.

Assert `mise exec -- bun --version` reports the pinned Bun version (initial target 1.3.14), frozen installation reproduces the recorded package matrix, and direct runtime `pg` imports occur only inside the approved saver adapter. Preserve the existing prohibition on runtime imports from `spikes/**`.

Assert root `packageManager` agrees with mise, Turbo is pinned to the selected version, workspace resolution is local and package entry points cannot bypass the import-boundary guards. `check:verify` SHALL force the complete offline check graph; ordinary `check` MAY reuse valid local results.

### Step 6 - Implement: Add the container foundation; verify topology and readiness smoke tests
- [ ] 2.3 Implement: Add the container foundation; verify topology and readiness smoke tests

Add the non-root Bun image and Compose runtime/PostgreSQL/Tailscale topology, private volumes, read-only `/workspace`, scratch space and minimal health/readiness entrypoint. Add synthetic-configuration and container smoke coverage for namespace/bind/mount policy; do not build the browser console or contact real providers.

Include `.env.example` with placeholders only. Check digest-pinned images, non-root/read-only runtime execution, writable private state/scratch only, healthcheck behavior, and absence of published application/database ports in the rendered Compose configuration.

Build from the repository root using the frozen root lockfile and required workspace manifests/sources, excluding historical harnesses and private material from the build context. Verify the image starts the runtime package entrypoint and resolves any unbundled workspace/runtime dependencies without Turbo or a separate UI server. Initial workspace pruning is deferred; this block's image contains no functional console.

### Step 7 - Implement: Isolate test execution; verify unsafe targets are rejected
- [ ] 2.4 Implement: Isolate test execution; verify unsafe targets are rejected

Add isolated integration-fixture configuration and explicit test-service commands. Default `bun test` SHALL start no external services or external suites; integration commands SHALL refuse production database and credential paths. Land the tests proving these boundaries.

Cover both bare root Bun discovery and Turbo's root/package test graph: exclude spikes, generated outputs and integration/live suites from ordinary checks, and verify every implemented package's unit suite is included. Integration/live commands and dev/start tasks SHALL be uncached; ordinary checks SHALL NOT invoke them. Add synthetic task-graph fixtures proving relevant shared-configuration and transitive source changes invalidate consumers, including a source-only dependency, and that a warm build-cache hit restores actual deployable outputs. Verify local-only cache operation and task-specific report paths without ambient credentials or owner data.

### Step 8 - Implement: Document the foundation; verify README commands and scope
- [ ] 2.5 Implement: Document the foundation; verify README commands and scope

Replace README boilerplate with implemented setup/check/container prerequisites and limitations. Add MVP-precedence notices to `architecture/README.md` and `architecture/10-delivery-phases.md`. Match the actual scripts and do not describe undelivered features as working.

Document runtime/UI package ownership, the later contracts extraction, one application deployment, root versus package commands, direct versus Turbo test execution, forced `check:verify`, cache/output behavior and the workspace-aware Docker build. Clearly distinguish UI scaffolding from an implemented console.

### Step 9 - Verify: Run foundation checks; require passing installation and smoke suites
- [ ] 2.6 Verify: Run foundation checks; require passing installation and smoke suites

Run block checks, frozen-install verification and isolated container smoke tests. Report exact tool/image versions and results. Do not use source-changing lint flags.

Require passing cold/forced Turbo checks, direct-Bun discovery safety, shared-input invalidation and warm-cache build-output restoration fixtures, package import guards and the workspace-built image smoke. Keep cache-behavior observations distinct from the forced checks used as fresh acceptance evidence.

### Step 10 - Review: Assess foundation evidence; obtain owner acceptance
- [ ] 2.7 Review: Assess foundation evidence; obtain owner acceptance

Present scaffold and test-isolation findings, then obtain approval to continue or a concrete correction request.

## 3. Durable records and Bun compatibility — Research

### Step 11 - Pause: Switch model for exploration
- [ ] 3.1 Pause: Switch model for exploration

### Step 12 - Explore: Inspect persistence APIs; verify the bounded G1 proof plan
- [ ] 3.2 Explore: Inspect persistence APIs; verify the bounded G1 proof plan

Inspect pinned Bun SQL reserved-session behavior and official saver APIs against the spike evidence. Report public-API choices for schemas, migrations, pool/client errors and lock loss. Keep the first G1 fixture independent of the full application schema/controller.

### Step 13 - Explore: Map data invariants; verify the constraint and transaction checklist
- [ ] 3.3 Explore: Map data invariants; verify the constraint and transaction checklist

Map design Decisions 3–4 to records, keys/unions, migrations and tests covering same-run references, JSON null/false, event ordering, epochs and idempotency.

### Step 14 - Propose: Present persistence and G1 work; obtain owner approval
- [ ] 3.4 Propose: Present persistence and G1 work; obtain owner approval

Present the implementation and isolated PostgreSQL test scope, including the checkpointer-only `pg` exception and the early stop before full schema work if G1 fails.

## 4. Durable records and Bun compatibility — Implementation

### Step 15 - Pause: Switch model for implementation
- [ ] 4.1 Pause: Switch model for implementation

### Step 16 - Implement: Add application and saver adapters; verify driver-boundary tests
- [ ] 4.2 Implement: Add application and saver adapters; verify driver-boundary tests

Implement Bun SQL application access and the official saver adapter with its controlled `pg` pool and pool/client error listeners. Test the configured pool limits, schema separation and the import-boundary guard. Do not introduce application queries through `pg`.

### Step 17 - Implement: Add serialized schema setup; verify migration and readiness tests
- [ ] 4.3 Implement: Add serialized schema setup; verify migration and readiness tests

Implement migration journal/ownership metadata, serialized application/saver setup and schema-version readiness. Test concurrent starters, idempotent setup and refusal of unknown/newer schema versions. Full run records still follow the early G1 gate.

### Step 18 - Implement: Add runtime ownership; verify singleton and lost-session fencing tests
- [ ] 4.4 Implement: Add runtime ownership; verify singleton and lost-session fencing tests

Implement singleton ownership, reserved-session identity/lock checks, owner epochs, per-run serialization primitives and pool limits. Test two instances, idle locks, session replacement and stale owners; do not reserve a database connection per run.

### Step 19 - Implement: Add the bounded G1 fixture; verify root-agent restart and negative-answer assertions
- [ ] 4.5 Implement: Add the bounded G1 fixture; verify root-agent restart and negative-answer assertions

Use real Bun/official-saver persistence with a deterministic model and interrupting root `createAgent` tool. Assert synchronous durability, omission of `checkpoint_id`, fresh-process resume and a negative answer. Include independent work witnesses, without depending on production run records or repeating the old spike programme.

Use a child Bun process killed after confirmed pause settlement, then a fresh process carrying an ID-addressed `{ questionId, answer: false }` envelope. An independent witness SHALL observe the delivered answer once. Also prove lost ownership prevents subsequent dispatch. Duplicate application-answer protection remains a G3/controller test; do not assume a raw duplicate graph resume is deduplicated by LangGraph.

### Step 20 - Verify: Run the early G1 gate; stop on Bun or ownership incompatibility
- [ ] 4.6 Verify: Run the early G1 gate; stop on Bun or ownership incompatibility

Run current block checks and the isolated G1 fixture before full schema/controller buildout. Require successful pause/resume, lock/session-loss fencing and cross-driver coexistence; report the exact tested matrix. A failed mandatory check stops here for explicit replanning.

### Step 21 - Implement: Add durable record schemas; verify database invariants and scalar-answer tests
- [ ] 4.7 Implement: Add durable record schemas; verify database invariants and scalar-answer tests

Add run/question/invocation/attempt/tool/event/definition records, variant CHECKs, same-run references, deferred consistency and uniqueness. Tests SHALL reject invalid unions, duplicate pending questions, cross-run references and oversubscribed budgets while accepting allowed false/null values.

### Step 22 - Implement: Add atomic mutations and snapshots; verify idempotency and event-order tests
- [ ] 4.8 Implement: Add atomic mutations and snapshots; verify idempotency and event-order tests

Implement creation-request idempotency, event/source-key allocation, atomic transition primitives and consistent snapshots. Add concurrency/rollback tests for one creation per request, payload conflicts, ordered committed history and terminal protection.

Explicitly test same-source-key/same-payload replay, same-key/different-payload refusal, decimal-string event sequences and same-owner ambiguous-commit readback before dispatch.

### Step 23 - Implement: Document persistence; verify schema and evidence descriptions
- [ ] 4.9 Implement: Document persistence; verify schema and evidence descriptions

Update README database/test setup, `architecture/06-storage-and-backup.md` and `architecture/09-data-model-and-lifecycle.md`. Add separately dated evidence pointers to the spike-report index. Distinguish G1 results from the unfinished full lifecycle and retain original spike reports unchanged.

Record the already-observed early G1 results in `g1-bun-persistence.md`, including the exact tested source/matrix and its limited proof scope. Do not claim later record-schema checks have passed before their Verify step.

### Step 24 - Verify: Run persistence regressions; require passing G1 and record suites
- [ ] 4.10 Verify: Run persistence regressions; require passing G1 and record suites

Run block checks and PostgreSQL ownership/saver/schema/mutation suites against the resulting exact matrix, including pool failures, rollback and preserved-storage restart.

### Step 25 - Review: Assess persistence evidence; obtain owner acceptance
- [ ] 4.11 Review: Assess persistence evidence; obtain owner acceptance

Present the durable-record and G1 findings. Do not claim host reboot or active crash recovery has been established.

## 5. Workspace, credential and input boundaries — Research

### Step 26 - Pause: Switch model for exploration
- [ ] 5.1 Pause: Switch model for exploration

### Step 27 - Explore: Inspect workspace enforcement; verify the bounded tool test plan
- [ ] 5.2 Explore: Inspect workspace enforcement; verify the bounded tool test plan

Inspect file APIs and mount assumptions against Decision 12. Cover file/directory reads, literal search, credential exclusions, static escapes, aliases, changed targets and the declared non-hostile-volume assumption.

### Step 28 - Explore: Inspect credential and input contracts; verify the coordination plan
- [ ] 5.3 Explore: Inspect credential and input contracts; verify the coordination plan

Inspect reuse evidence and provider/question/failure types. Report cross-process coordination, partial rotation, safe projection and future auth-mode boundaries without implementing API-key access.

### Step 29 - Propose: Present authority-boundary work; obtain owner approval
- [ ] 5.4 Propose: Present authority-boundary work; obtain owner approval

Present the next implementation block and its tests. Provider-network access remains disabled.

## 6. Workspace, credential and input boundaries — Implementation

### Step 30 - Pause: Switch model for implementation
- [ ] 6.1 Pause: Switch model for implementation

### Step 31 - Implement: Add configuration and input contracts; verify typed validation tests
- [ ] 6.2 Implement: Add configuration and input contracts; verify typed validation tests

Implement validated operator configuration, immutable workspace/provider snapshots, question/failure DTOs, readiness states and tracing/environment guards. Test unsupported modes/endpoints/authority fields and distinctions among scalar false, strings, null, permitted empty text and canonical multi-choice answers.

Add table-driven failure-mapping tests for every category and operation context, including device-poll 403/404 versus inference rejection. Test explicit tracing refusal and prove ambient API keys cannot select a billed mode or reach a subscription request.

### Step 32 - Implement: Add private credential storage; verify permissions and atomic replacement
- [ ] 6.3 Implement: Add private credential storage; verify permissions and atomic replacement

Implement versioned records, generations, strict decoding, `0700` directories, `0600` records and complete atomic replacement. Test truncated/invalid files, interrupted writes, preserved-storage restart and newer-generation selection using synthetic credentials.

### Step 33 - Implement: Add shared refresh coordination; verify two-process rotation exclusion
- [ ] 6.4 Implement: Add shared refresh coordination; verify two-process rotation exclusion

Implement provider-scoped single-flight and the runtime/operator lock covering reread, injected refresh, partial merge and durable replacement. Test two processes contending for the same credential: exactly one refresh occurs, an omitted refresh token preserves the existing value, and reauthorization cannot be overwritten by a stale refresh. Test temporary failure separately from definitive rejection.

### Step 34 - Implement: Add confinement and file reads; verify path and byte-limit fixtures
- [ ] 6.5 Implement: Add confinement and file reads; verify path and byte-limit fixtures

Implement the common workspace policy and `mcp_Read` file mode. Test traversal, absolute paths, symlink components/leaves, special files, changed targets, credential locations and known hard-link aliases. Assert the one-MiB file bound, 200 default/2,000 maximum lines and 64-KiB result bound, with typed missing/unreadable errors and visible truncation.

### Step 35 - Implement: Add directory reads; verify filtered discovery and pagination
- [ ] 6.6 Implement: Add directory reads; verify filtered discovery and pagination

Implement directory mode with `.` discovery, name ordering, 200 default/2,000 maximum entries, the 64-KiB result bound and the same exclusions before returning metadata. Test excluded entries, unchanged-tree cursor continuation and visible truncation; document that pagination is not a filesystem snapshot.

### Step 36 - Implement: Add literal search; verify scan limits and nonfatal refusals
- [ ] 6.7 Implement: Add literal search; verify scan limits and nonfatal refusals

Implement literal search with 100 matches, 2,000 examined files, 16 MiB scanned text and the common file/result limits. Test excluded directories, binary files, an escaping symlinked subtree and incomplete-result reporting rather than false negative results. Verify tool code has no arbitrary process-execution path.

### Step 37 - Implement: Add secret-safe projections; verify seeded-secret and permission tests
- [ ] 6.8 Implement: Add secret-safe projections; verify seeded-secret and permission tests

Implement safe logging/projections, input credential rejection and pre-graph tool/model sanitation interfaces. Test goals, answers, results, nested errors and fragmented model content. Forbidden mutations and inspected instructions SHALL NOT expand permissions.

Include a secret split across three stream fragments and an ordinary-code false-positive corpus. Reject raw request/body objects at the diagnostic boundary. Preserve the test proving inspected instructions cannot widen tool permissions.

### Step 38 - Implement: Document authority boundaries; verify implemented scope and limitations
- [ ] 6.9 Implement: Document authority boundaries; verify implemented scope and limitations

Update README, `architecture/08-execution-security.md` and `architecture/05-model-authentication.md`. Do not describe read-only mounts as complete confinement; retain subscription-only scope and clearly mark unfinished provider login paths.

### Step 39 - Verify: Run authority-boundary suites; require passing isolation and rotation checks
- [ ] 6.10 Verify: Run authority-boundary suites; require passing isolation and rotation checks

Run block checks and isolated filesystem/credential suites. Require passing typed-input, confinement, exclusion and multi-process rotation tests without touching protected application directories.

### Step 40 - Review: Assess boundary evidence; obtain owner acceptance
- [ ] 6.11 Review: Assess boundary evidence; obtain owner acceptance

Review implementation, tests and documentation before connecting these boundaries to the agent harness.

## 7. Controlled execution and human continuation — Research

### Step 41 - Pause: Switch model for exploration
- [ ] 7.1 Pause: Switch model for exploration

### Step 42 - Explore: Inspect harness hooks; verify the controller integration map
- [ ] 7.2 Explore: Inspect harness hooks; verify the controller integration map

Recheck pinned public model/tool middleware and interrupt/state-inspection contracts. Preserve root invocation, control-flow exceptions, sole-question batches and service-owned cancellation.

### Step 43 - Explore: Map lifecycle fault windows; verify independent witnesses for each boundary
- [ ] 7.3 Explore: Map lifecycle fault windows; verify independent witnesses for each boundary

Map question bindings, compatibility manifests, request-attempt states and the crash-window table to assertions. Final graph-state equality SHALL NOT substitute for evidence of actual dispatch or one continuation.

### Step 44 - Propose: Present lifecycle and G3 work; obtain owner approval
- [ ] 7.4 Propose: Present lifecycle and G3 work; obtain owner approval

Present mock-backed lifecycle implementation and its fault matrix, without enabling real provider requests or changing the approved state machine.

## 8. Controlled execution and human continuation — Implementation

### Step 45 - Pause: Switch model for implementation
- [ ] 8.1 Pause: Switch model for implementation

### Step 46 - Implement: Add the guarded terminal boundary; verify independent I/O admission tests
- [ ] 8.2 Implement: Add the guarded terminal boundary; verify independent I/O admission tests

Implement the reusable injected terminal boundary with exact endpoint/redirect policy, durable-admission requirement, owner/run/cancellation checks, pre-aborted signals and the five-minute full-body deadline. Test refused admission, cancellation during credential waits, headers followed by a stalled body, redirects and body settlement against independent terminal witnesses. No request is permitted without the application admission contract.

### Step 47 - Implement: Assemble controlled root execution; verify invocation-contract fixtures
- [ ] 8.3 Implement: Assemble controlled root execution; verify invocation-contract fixtures

Assemble root `createAgent` and the service-owned per-run controller with configured unbound models and official saver. Assert v2 tools, sync durability, stable thread identity, omitted `checkpoint_id`, independence from browser lifetime and absence of a custom agent loop.

### Step 48 - Implement: Add tool identity and replay handling; verify safe-batch and deduplication tests
- [ ] 8.4 Implement: Add tool identity and replay handling; verify safe-batch and deduplication tests

Implement middleware, stable model-message/operation IDs, replayed-result reuse and ordered projection. Cover read-only batches, refusal of every mixed/multiple-question call, ambiguous/reused IDs, propagation of graph control flow and new calls distinguished from replay.

Explicitly generate agent calls to an unavailable writing tool and an unavailable command tool. Require a recorded refusal or `tool_failure`, unchanged fixture files and zero mutation/process-dispatch witness calls. Exercise both safe-refusal and fatal-handling branches; the requested action SHALL never execute.

### Step 49 - Implement: Add compatibility verification; verify positive and negative manifest cases
- [ ] 8.5 Implement: Add compatibility verification; verify positive and negative manifest cases

Implement execution-code/dependency/configuration manifests and required-state digests against stored bindings. Accept identical redeploys and browser/default-model changes; reject changed tool bodies/helpers/protocols, unsupported serialized values and missing/ambiguous saved state before acceptance or dispatch.

Pin assertions for CRLF/LF normalization, unchanged README/browser assets, changed execution helpers, and a temporary inspection outage that leaves the pending question and committed run state unchanged.

Include UI-only source/dependency changes versus changes to shared modules used by execution, using fixtures for packages not implemented yet. Hash the selected execution import/dependency closure, not every workspace, the entire root lockfile, the application bundle or Turbo task hashes. Retest the real shared-module boundary when contracts are extracted in the API block.

### Step 50 - Implement: Publish settled human questions; verify pause persistence fault windows
- [ ] 8.6 Implement: Publish settled human questions; verify pause persistence fault windows

Implement deterministic `mcp_AskUser` and saver settlement/inspection before atomic publication. Test failures before interrupt persistence, after stream emission, after saver settlement and around application waiting commit. Do not promote orphan checkpoints into answerable questions.

### Step 51 - Implement: Accept exact answers once; verify identity, duplicate and uncertainty cases
- [ ] 8.7 Implement: Accept exact answers once; verify identity, duplicate and uncertainty cases

Implement answer validation, disposition-first duplicate acknowledgement, conditional acceptance and one ID-addressed truthy resume envelope. Cover false/null/permitted-empty values, wrong/stale/conflicting IDs, two tabs, terminal duplicate acknowledgements, incompatible versus inaccessible state, and ambiguous-commit readback. Replay SHALL still call the framework interrupt.

### Step 52 - Implement: Integrate request accounting; verify budgets and renewal-retry cases
- [ ] 8.8 Implement: Integrate request accounting; verify budgets and renewal-retry cases

Connect reservation, dispatch confirmation, completion/abandonment and unconfirmed accounting to the guarded terminal and controller. Test zero inference requests for auth-only failure, disabled hidden retries, one permitted renewal retry consuming another step, last-step tools/results/questions, exhausted-budget answers and the admission/crash gap. Preserve default budget 50 and the separate recursion safety bound.

### Step 53 - Implement: Add durable cancellation; verify dispatch and completion races
- [ ] 8.9 Implement: Add durable cancellation; verify dispatch and completion races

Implement cancellation acceptance under the short gate, unanswered-question closure, signal propagation and actual in-flight/body settlement. Test cancellation during credential waits, model bodies and tool reads, both cancellation/completion race orders, and preservation of an already accepted answer. Late output cannot replace the cancelled outcome.

### Step 54 - Implement: Add finalization and startup reconciliation; verify the complete crash matrix
- [ ] 8.10 Implement: Add finalization and startup reconciliation; verify the complete crash matrix

Implement successful/failed/no-op finalization and startup classification after ownership. A child-process test SHALL kill execution at every row of design Decision 6's crash-window table and assert the specified result, including accepted-answer-before-dispatch, orphan graph interrupts, unfinished final commits and restart-mid-cancel. Test failed/uncertain persistence and truthful unconfirmed attempts. Never automatically or manually resume prior active work.

### Step 55 - Implement: Document the lifecycle; verify state and crash-window correspondence
- [ ] 8.11 Implement: Document the lifecycle; verify state and crash-window correspondence

Update README, `architecture/02-control-plane.md` and `architecture/09-data-model-and-lifecycle.md` for compatibility, counters, questions, states and failures. Preserve separate graph/application commit semantics and dated G3 evidence pointers.

### Step 56 - Verify: Run G3 and G1 regressions; require every lifecycle boundary to pass
- [ ] 8.12 Verify: Run G3 and G1 regressions; require every lifecycle boundary to pass

Run block checks and isolated lifecycle/fault suites. Require all design crash windows, cancellation boundaries, physical counts and saved-state refusals to pass before provider/console acceptance.

### Step 57 - Implement: Record G3 evidence; verify correspondence to observed results
- [ ] 8.13 Implement: Record G3 evidence; verify correspondence to observed results

Write `g3-dispatch-lifecycle.md` from the preceding verification results and relevant owner reports/authorization. Include exact tested versions, source identity, commands, outcomes, request counts, unresolved issues and skips. Update the separately dated spike-index pointer. Do not rerun providers or infer a pass from missing evidence.

### Step 58 - Verify: Check G3 evidence; require accurate, safe and complete records
- [ ] 8.14 Verify: Check G3 evidence; require accurate, safe and complete records

Check `g3-dispatch-lifecycle.md` and index links against the observed results, including tested-build identity and request allowance/counts. Reject unsupported pass claims, missing mandatory cases or sensitive content. This step checks records only and performs no new live provider requests.

### Step 59 - Review: Assess controlled-execution evidence; obtain owner acceptance
- [ ] 8.15 Review: Assess controlled-execution evidence; obtain owner acceptance

Present G3 findings and limitations; provider integration and live journeys remain unverified.

## 9. Maintained provider boundaries and offline parity — Research

### Step 60 - Pause: Switch model for exploration
- [ ] 9.1 Pause: Switch model for exploration

### Step 61 - Explore: Assess the maintained library release; verify the upstream contract handoff
- [ ] 9.2 Explore: Assess the maintained library release; verify the upstream contract handoff

Inspect the owner-supplied release against Decision 10: version/integrity, injected login/refresh/inference, native no-rewrite names and safe errors. If no suitable release exists, report the dependency blocked; do not substitute the shipped loader or edit upstream.

### Step 62 - Explore: Assess provider parity and OpenAI cost; verify the bounded extraction plan
- [ ] 9.3 Explore: Assess provider parity and OpenAI cost; verify the bounded extraction plan

Inspect stock model construction and OpenAI Responses/terminal fixtures. Cover configured model/profile, replay metadata, terminal events and the OpenAI cost estimate before its transport implementation.

### Step 63 - Review: Confirm the upstream delivery handoff; obtain owner agreement
- [ ] 9.4 Review: Confirm the upstream delivery handoff; obtain owner agreement

Present the gap against Decision 10 and confirm the delivery owner, required public contract and existing or planned release. The owner can approve mock-backed preparation while delivery remains outstanding. This is not G2 acceptance and does not authorize edits to the library repository.

### Step 64 - Propose: Present the release and provider plan; obtain delivery and cost approval
- [ ] 9.5 Propose: Present the release and provider plan; obtain delivery and cost approval

Present the runtime-side preparation and early OpenAI cost checkpoint for approval. Name the upstream handoff and the single blocked pin/bind step. Preparation can proceed without a delivered release, but real G2 and offline G4/G5 must pass before console work. No live model allowance is requested or inferred.

## 10. Maintained provider boundaries and offline parity — Implementation

### Step 65 - Pause: Switch model for implementation
- [ ] 10.1 Pause: Switch model for implementation

### Step 66 - Implement: Prepare the Anthropic boundary contract; verify mock-backed consumer fixtures
- [ ] 10.2 Implement: Prepare the Anthropic boundary contract; verify mock-backed consumer fixtures

Define the runtime-side boundary and parameterized consumer fixtures for injected login/refresh/inference, native names, safe errors, signals and partial credential updates. Verify the fixtures against a test-only fake. Do not implement copied provider protocol/profile transformations or claim that fake success establishes G2 or real G4 parity.

### Step 67 - Implement: Connect Anthropic credential lifecycle; verify synthetic auth and renewal tests
- [ ] 10.3 Implement: Connect Anthropic credential lifecycle; verify synthetic auth and renewal tests

Prepare the credential adapter and operator commands against the declared boundary using a test-only fake; bind the maintained implementation only at the pin/bind step. Test PKCE/state/exchange, refresh margin, runtime/CLI races and terminal rejection using synthetic credentials only; perform no real login here.

### Step 68 - Implement: Connect stock Anthropic inference; verify offline G4 parity and replay
- [ ] 10.4 Implement: Connect stock Anthropic inference; verify offline G4 parity and replay

Prepare stock ChatAnthropic construction and parameterized offline fixtures against the declared boundary. Mock-backed consumer tests are preparation only; actual request-profile parity must be rerun against the pinned maintained release. Test sentinel key, `dangerouslyAllowBrowser: false`, retry overrides, profile bytes, fragmented streams, leading-user-text preservation, tool-result replay, cancellation and secret-free checkpoints.

### Step 69 - Implement: Add the offline OpenAI transport; verify G5 wire and stream fixtures
- [ ] 10.5 Implement: Add the offline OpenAI transport; verify G5 wire and stream fixtures

Implement stock Responses transport with injected synthetic credential resolution and coherent account generations. Compare Bun fetch/node:http captures and test two-turn encoding, reasoning/call-ID replay, missing terminal events, redirects and abort/deadline behavior without ambient API fallback. OpenAI operational readiness remains disabled until its later auth block.

### Step 70 - Implement: Document provider integration; verify release and evidence distinctions
- [ ] 10.6 Implement: Document provider integration; verify release and evidence distinctions

Update README, `architecture/05-model-authentication.md` and dated gate-evidence pointers. Distinguish the maintained release and selected matrix from deferred live checks and remaining OpenAI device-auth work.

Record the handoff and early cost decision in upstream-handoff.md and openai-cost-checkpoint.md. Clearly mark missing real-package evidence and do not describe a mock-backed Anthropic binding as operational.

### Step 71 - Verify: Check independent provider preparation; distinguish completed fixtures from blocked gates
- [ ] 10.7 Verify: Check independent provider preparation; distinguish completed fixtures from blocked gates

Run block checks, mock-backed consumer suites, offline OpenAI transport checks and G1/G3 regressions. Require those checks to pass. Report real G2 and real-package Anthropic parity as outstanding—not skipped passes—when the release is unavailable.

### Step 72 - Implement: Bind the reviewed Anthropic release; verify real-package contract and parity suites
- [ ] 10.8 Implement: Bind the reviewed Anthropic release; verify real-package contract and parity suites

BLOCKED until the owner supplies a reviewed release satisfying Decision 10. Stop before writes if it is unavailable; do not skip ahead. Pin its exact version/integrity, connect its public exports/options to the prepared adapter and enable only the real supported binding. Completion requires the following Verify to pass G2 and actual-package offline G4, with no private imports, global-fetch replacement, unchanged-loader fallback or copied provider implementation.

### Step 73 - Verify: Run the pre-console gates; require G2 and offline G4/G5 with regressions
- [ ] 10.9 Verify: Run the pre-console gates; require G2 and offline G4/G5 with regressions

Run block checks, G2, offline G4/G5 and G1/G3 against the exact resulting matrix. Require independent request witnesses and no skipped mandatory cases before console buildout.

### Step 74 - Implement: Record pre-console evidence; verify correspondence to observed results
- [ ] 10.10 Implement: Record pre-console evidence; verify correspondence to observed results

Write `g2-anthropic-boundary.md`, `g4-anthropic-offline.md` and `g5-openai-offline.md` from the preceding verification results and relevant owner reports/authorization. Include exact tested versions, source identity, commands, outcomes, request counts, unresolved issues and skips. Update the separately dated spike-index pointer. Do not rerun providers or infer a pass from missing evidence.

### Step 75 - Verify: Check pre-console evidence; require accurate, safe and complete records
- [ ] 10.11 Verify: Check pre-console evidence; require accurate, safe and complete records

Check `g2-anthropic-boundary.md`, `g4-anthropic-offline.md`, `g5-openai-offline.md` and index links against the observed results, including tested-build identity and request allowance/counts. Reject unsupported pass claims, missing mandatory cases or sensitive content. This step checks records only and performs no new live provider requests.

### Step 76 - Review: Assess offline provider readiness; obtain owner acceptance
- [ ] 10.12 Review: Assess offline provider readiness; obtain owner acceptance

Review evidence that console work is unblocked while both live-provider journeys remain outstanding.

## 11. Browser console and Anthropic usable slice — Research

### Step 77 - Pause: Switch model for exploration
- [ ] 11.1 Pause: Switch model for exploration

### Step 78 - Explore: Map browser and API behavior; verify route and fixture coverage
- [ ] 11.2 Explore: Map browser and API behavior; verify route and fixture coverage

Inspect controller contracts and minimal React/HTML-import integration. Map validation ordering, state variants, exact answers, budget display and durable replay to routes/UI/fixtures without Agent Server or token-stream authority.

Plan extraction of pure wire definitions into `packages/contracts`, their server/client consumers and package-local tests. Inspect UI public HTML-entry resolution and runtime-owned application bundling; identify forbidden server-only dependencies and the actual UI/contracts inputs needed to invalidate build/check caches.

### Step 79 - Explore: Assess private deployment and Anthropic acceptance; verify bounded trial scope
- [ ] 11.3 Explore: Assess private deployment and Anthropic acceptance; verify bounded trial scope

Inspect Compose Serve and the trial procedure. Report the private-origin/cross-device verification plan and proposed provider/model, auth operations and physical-request cap using only owner-approved fixture content.

### Step 80 - Propose: Present the browser slice; obtain implementation and bounded trial-plan approval
- [ ] 11.4 Propose: Present the browser slice; obtain implementation and bounded trial-plan approval

Present API/console/deployment changes and the bounded Anthropic trial plan. Obtain implementation and trial-plan approval, not advance authority for live operations. Fresh provider authorization SHALL be confirmed in the Review immediately before live verification; approval SHALL NOT be inferred from the task plan itself.

Include the contracts extraction, runtime route ownership, UI package implementation, cross-package tests and single-image HTML-import build. Separate source packages do not add a frontend service or authorize a different deployment topology.

## 12. Browser console and Anthropic usable slice — Implementation

### Step 81 - Pause: Switch model for implementation
- [ ] 12.1 Pause: Switch model for implementation

### Step 82 - Implement: Add versioned REST commands; verify validation and idempotency tests
- [ ] 12.2 Implement: Add versioned REST commands; verify validation and idempotency tests

Add `/api/v1` options/run/detail/history/answer/cancel routes with strict inputs, safe envelopes and disposition-first ordering. Test every documented response code, cross-run inputs, repeated requests, exhausted-budget answers and ambiguous commits without double invocation.

Implement routes in `packages/runtime` and introduce `packages/contracts` by extracting the pure shared wire schemas/types, rather than copying internal record types or maintaining duplicate schemas. Retain runtime-only authorization, saved-state and transaction checks. Add contract/schema-parity fixtures and import guards rejecting dependencies from contracts to runtime/UI, Bun/Node APIs, database drivers or provider SDKs. Register package tests/typechecks and source-dependency invalidation in Turbo.

### Step 83 - Implement: Add durable SSE replay; verify race, outage and backpressure tests
- [ ] 12.3 Implement: Add durable SSE replay; verify race, outage and backpressure tests

Implement snapshot bounds, initial/reconnect cursor validation, decimal sequences, 15-second heartbeats, bounded buffers and unsequenced outages. Test snapshot/subscription races, lost wakeups, repeated reconnects, slow readers and database failures without lost recorded events or browser-induced run aborts.

Use a fake clock to assert the 15-second heartbeat and explicitly test `409 cursor_ahead`, missed notifications and storage outage without durable cursor advancement.

### Step 84 - Implement: Add the browser client and event store; verify replay and retry fixtures
- [ ] 12.4 Implement: Add the browser client and event store; verify replay and retry fixtures

Implement typed endpoint access, snapshot/history/SSE merging, `(runId, seq)` deduplication, safe request-ID reuse and a connection-availability state separate from run status. Test reconnect races, retransmission, cursor handling and `acceptance_unknown` retries without duplicate starts.

Place the browser client, event store and unit tests in `packages/ui`, consuming the public contracts package through `workspace:*`. Do not import runtime internals or server-only types to obtain API shapes. Include its implemented unit/typecheck tasks in the root check graph.

### Step 85 - Implement: Add run views; verify state, outcome and safe-rendering fixtures
- [ ] 12.5 Implement: Add run views; verify state, outcome and safe-rendering fixtures

Implement run listing/start/detail/history and budget/uncertainty/failure views. Cover all seven states, required timestamps, each failure category and unavailable overlays. Render text or sanitized Markdown without executable HTML or automatic external loading.

Implement the React views and browser tests in `packages/ui`, with package-owned React/browser dependencies and an explicit public HTML entry. Connect that entry to `Bun.serve` in the runtime and extend the runtime-owned application build under `packages/runtime/dist/` to include the browser assets. Test cross-workspace resolution, absence of server-only browser dependencies, complete output restoration and operation without a separate UI server or Vite.

### Step 86 - Implement: Add question and cancellation controls; verify typed interactions end to end
- [ ] 12.6 Implement: Add question and cancellation controls; verify typed interactions end to end

Implement text/single-choice/multi-choice questions, negative/false/null answers, duplicate/conflict/closed responses and cancellation controls. A deterministic browser journey SHALL start a run, observe activity, answer false and obtain its result; repeated submission and socket closure SHALL not cause another invocation or fabricated completion.

### Step 87 - Implement: Complete private Serve exposure; verify Host, Origin and asset restrictions
- [ ] 12.7 Implement: Complete private Serve exposure; verify Host, Origin and asset restrictions

Finish Host/Origin/JSON controls and Serve wiring. Tests SHALL show no public ports/Funnel, no exposed database/state directories, no permissive browser-origin mutation, and application assets served instead of workspace files.

### Step 88 - Implement: Add bounded Anthropic acceptance fixtures; verify the deterministic browser journey
- [ ] 12.8 Implement: Add bounded Anthropic acceptance fixtures; verify the deterministic browser journey

Add the operator checklist and shared mock/live fixture without performing live requests. Cover close/reopen, question/restart/answer, result and cancellation; enforce the approved physical-request cap in live mode.

### Step 89 - Implement: Document the Anthropic browser slice; verify setup and current-status accuracy
- [ ] 12.9 Implement: Document the Anthropic browser slice; verify setup and current-status accuracy

Update README operation/troubleshooting, `architecture/07-network-and-protocols.md`, relevant control-plane/security sections, architecture status and dated acceptance-evidence pointers. Distinguish the Anthropic usable slice from unfinished OpenAI operational support; live success is not claimed before verification.

Replace the foundation's UI-shell status with the actual runtime/UI/contracts ownership and test/build commands. Document the shared HTML-import application image and the distinction between deployment-cache invalidation and continuation fingerprints.

### Step 90 - Verify: Run offline console acceptance; require passing browser, replay and secrecy suites
- [ ] 12.10 Verify: Run offline console acceptance; require passing browser, replay and secrecy suites

Run block checks and complete offline API/browser/Serve suites with G1–G3 and offline G4/G5 regressions. Scan every protected surface for synthetic credentials. No live provider request is required for this gate.

Require the packaged UI to work in the single runtime image, contract changes to invalidate the relevant consumer checks/builds, and browser bundles to exclude runtime-only dependencies/private material. Recheck execution fingerprints after contract extraction: UI-only changes do not refuse continuation, while changes to execution-used shared modules do. Use forced check execution for acceptance, not a restored Turbo log.

### Step 91 - Review: Confirm live Anthropic authorization; obtain the bounded allowance
- [ ] 12.11 Review: Confirm live Anthropic authorization; obtain the bounded allowance

After offline checks pass, present the exact provider/model, owner-approved fixture content, auth/renewal operations, maximum physical model requests and retry allowance. Obtain fresh owner authorization now. The owner performs login in a private terminal; the executor receives only safe readiness/status. If authorization is withheld, stop before live verification.

### Step 92 - Verify: Run authorized Anthropic G4; require the bounded live journey to pass
- [ ] 12.12 Verify: Run authorized Anthropic G4; require the bounded live journey to pass

Use only the fresh allowance from the immediately preceding live-authorization Review. The owner completes headless setup in a private terminal. Verify real read/tool-result/question/restart/answer/final-result and browser reconnect behavior within the declared cap. Report safe metadata and request counts only. Missing authority or failed evidence leaves this step unfinished; do not silently spend another allowance.

The owner SHALL perform the browser journey from a second approved tailnet device over Tailscale Serve. Record safe device/context and outcome metadata within the same authorized trial; this does not grant extra model calls. Confirm the existing forged-Host/Origin and no-published-port checks also pass.

### Step 93 - Implement: Record G4 evidence; verify correspondence to observed results
- [ ] 12.13 Implement: Record G4 evidence; verify correspondence to observed results

Write `g4-anthropic-live.md` from the preceding verification results and relevant owner reports/authorization. Include exact tested versions, source identity, commands, outcomes, request counts, unresolved issues and skips. Update the separately dated spike-index pointer. Do not rerun providers or infer a pass from missing evidence.

### Step 94 - Verify: Check G4 evidence; require accurate, safe and complete records
- [ ] 12.14 Verify: Check G4 evidence; require accurate, safe and complete records

Check `g4-anthropic-live.md` and index links against the observed results, including tested-build identity and request allowance/counts. Reject unsupported pass claims, missing mandatory cases or sensitive content. This step checks records only and performs no new live provider requests.

### Step 95 - Review: Assess the usable Anthropic slice; obtain owner acceptance
- [ ] 12.15 Review: Assess the usable Anthropic slice; obtain owner acceptance

Present the actual journey, evidence and limitations before proceeding to full OpenAI operational completion.

## 13. OpenAI operational completion — Research

### Step 96 - Pause: Switch model for exploration
- [ ] 13.1 Pause: Switch model for exploration

### Step 97 - Explore: Assess remaining OpenAI auth work; verify the focused gap and cost report
- [ ] 13.2 Explore: Assess remaining OpenAI auth work; verify the focused gap and cost report

Inspect remaining device-auth, refresh, CLI and readiness against the landed transport. Cover polling semantics, PKCE, account metadata and expiry units without introducing another runtime architecture.

### Step 98 - Propose: Present OpenAI completion; obtain cost and bounded trial-plan approval
- [ ] 13.3 Propose: Present OpenAI completion; obtain cost and bounded trial-plan approval

Obtain a refreshed proceed/replan decision before writes and approval of the bounded device-flow/renewal/model-request trial plan, not advance live authority. Fresh provider authorization SHALL be confirmed in the Review immediately before live verification. Disproportionate cost does not silently remove OpenAI from the phase.

## 14. OpenAI operational completion — Implementation

### Step 99 - Pause: Switch model for implementation
- [ ] 14.1 Pause: Switch model for implementation

### Step 100 - Implement: Add OpenAI device auth and renewal; verify lifecycle fixtures
- [ ] 14.2 Implement: Add OpenAI device auth and renewal; verify lifecycle fixtures

Implement device initiation/poll/exchange and independent refresh through shared storage and operator commands. Fixtures SHALL distinguish polling 403/404 from inference rejection, validate PKCE and bounded polling, preserve partial rotation, and handle credential generations and persistence failure safely.

Fake-issuer tests SHALL cover pending polls, interval/deadline handling, successful exchange, denial and renewal failure without misclassifying device-poll responses as model failures.

### Step 101 - Implement: Enable configured OpenAI readiness; verify immutable subscription bindings
- [ ] 14.3 Implement: Enable configured OpenAI readiness; verify immutable subscription bindings

Enable the real binding in the existing console only after valid configuration/authorization. Tests SHALL reject unsupported profiles before dispatch, prevent mixed account/token generations, retain per-run bindings and prohibit provider/billing fallback.

### Step 102 - Implement: Complete provider fixtures and documentation; verify both deterministic journeys
- [ ] 14.4 Implement: Complete provider fixtures and documentation; verify both deterministic journeys

Extend tests for OpenAI setup, model/profile, renewal, two-turn and human continuation, plus Anthropic regressions through the same API/controller. Update README, `architecture/05-model-authentication.md` and dated evidence pointers to distinguish implemented paths from still-pending live outcomes.

### Step 103 - Verify: Run dual-provider offline gates; require replay and secrecy regressions to pass
- [ ] 14.5 Verify: Run dual-provider offline gates; require replay and secrecy regressions to pass

Run block checks and all offline gates with both bindings. Verify full message/tool/reasoning-metadata replay, terminal markers, request counts, failure categories and secret scans without assuming an OpenAI `x-request-id` exists.

Include a response whose tool arguments are complete but whose successful terminal marker never arrives; it SHALL fail as a provider failure, not count as a completed response.

### Step 104 - Review: Confirm live OpenAI authorization; obtain the bounded allowance
- [ ] 14.6 Review: Confirm live OpenAI authorization; obtain the bounded allowance

After offline checks pass, present the exact provider/model, owner-approved fixture content, named device flow, auth/renewal operations, maximum physical model requests and retry allowance. Obtain fresh owner authorization now. The owner performs login in a private terminal; the executor receives only safe readiness/status. If authorization is withheld, stop before live verification.

### Step 105 - Verify: Run authorized OpenAI G5; require the bounded live journey to pass
- [ ] 14.7 Verify: Run authorized OpenAI G5; require the bounded live journey to pass

Use only the fresh allowance from the immediately preceding live-authorization Review. Require device login, controlled renewal, preserved-storage restart, second-turn tool results and browser question/answer/final result within the cap. Report safe metadata and counts. An Anthropic live rerun requires separate authorization and a justified shared-change coverage need.

### Step 106 - Implement: Record G5 evidence; verify correspondence to observed results
- [ ] 14.8 Implement: Record G5 evidence; verify correspondence to observed results

Write `g5-openai-live.md` from the preceding verification results and relevant owner reports/authorization. Include exact tested versions, source identity, commands, outcomes, request counts, unresolved issues and skips. Update the separately dated spike-index pointer. Do not rerun providers or infer a pass from missing evidence.

### Step 107 - Verify: Check G5 evidence; require accurate, safe and complete records
- [ ] 14.9 Verify: Check G5 evidence; require accurate, safe and complete records

Check `g5-openai-live.md` and index links against the observed results, including tested-build identity and request allowance/counts. Reject unsupported pass claims, missing mandatory cases or sensitive content. This step checks records only and performs no new live provider requests.

### Step 108 - Review: Assess dual-provider acceptance; obtain owner approval of the phase exit
- [ ] 14.10 Review: Assess dual-provider acceptance; obtain owner approval of the phase exit

Present both subscription journeys and remaining limitations or defects. A skipped provider is not a completed phase.

## 15. Complete-system acceptance — Research

### Step 109 - Pause: Switch model for exploration
- [ ] 15.1 Pause: Switch model for exploration

### Step 110 - Explore: Audit acceptance coverage; verify all requirements and gates have evidence
- [ ] 15.2 Explore: Audit acceptance coverage; verify all requirements and gates have evidence

Inspect all 30 requirements and 65 scenarios, directory-reading coverage, G1–G5 records, exact pins, block-local documentation and deferred-test markers. Report missing evidence without editing code or declaring skips passed. An omission returns to its owning block for an explicitly approved correction, not late feature work here.

Check README coverage of setup/pins, Compose/Tailscale, both providers' auth and model configuration, workspace restrictions, browser operation, budget/cancellation, restart and troubleshooting. Check every architecture document in design Decision 14. Compare historical spikes against the recorded pre-execution baseline, not an assumption that the working tree was clean. Missing documentation returns to its owning block.

Audit monorepo/package ownership, shared contracts, root/package command coverage, single-image UI delivery and cache-policy documentation. Confirm acceptance records distinguish forced check execution from cache-behavior tests and that no package suite or build output was omitted by Turbo configuration.

### Step 111 - Propose: Present final integration checks; obtain owner approval of the verification scope
- [ ] 15.3 Propose: Present final integration checks; obtain owner approval of the verification scope

Present integration/rollback checks and any genuinely necessary fresh live allowance. No feature or documentation backlog is deferred into this acceptance block; unresolved earlier work stops the handoff for correction/replanning.

## 16. Complete-system acceptance — Implementation

### Step 112 - Pause: Switch model for implementation
- [ ] 16.1 Pause: Switch model for implementation

This phase contains integration verification, recording of its own acceptance evidence, and review only; it creates no feature code or deferred documentation backlog.

### Step 113 - Verify: Run complete-system checks; require current-build coverage without acceptance skips
- [ ] 16.2 Verify: Run complete-system checks; require current-build coverage without acceptance skips

Run all block checks and existing isolated integration/browser suites from documented clean setup. Require passing automated or explicit manual evidence for every requirement/scenario, no unresolved Phase-1 TODO/skip, and current-build G1–G5 evidence rather than inherited spike claims.

Require the complete root/runtime/UI/contracts check graph to execute through `check:verify`, the workspace-built application image to include the UI, and the existing package/cache/compatibility regression suites to pass. No new feature implementation or cache result substitutes for this final integration evidence.

### Step 114 - Verify: Exercise restart and rollback integration; require truthful preserved-state outcomes
- [ ] 16.3 Verify: Exercise restart and rollback integration; require truthful preserved-state outcomes

Run existing checks for ordinary restart, interrupted/cancelled outcomes, compatible/incompatible questions, rollback to a compatible image and preserved-volume readiness. Require no destructive volume action, state loss, secret leak, fabricated success or unauthorized redispatch; both provider acceptance records must apply to the tested build.

### Step 115 - Implement: Record phase-exit evidence; verify correspondence to observed results
- [ ] 16.4 Implement: Record phase-exit evidence; verify correspondence to observed results

Write `phase-exit.md` from the preceding verification results and relevant owner reports/authorization. Include exact tested versions, source identity, commands, outcomes, request counts, unresolved issues and skips. Update the separately dated spike-index pointer. Do not rerun providers or infer a pass from missing evidence.

### Step 116 - Verify: Check phase-exit evidence; require accurate, safe and complete records
- [ ] 16.5 Verify: Check phase-exit evidence; require accurate, safe and complete records

Check `phase-exit.md` and index links against the observed results, including tested-build identity and request allowance/counts. Reject unsupported pass claims, missing mandatory cases or sensitive content. This step checks records only and performs no new live provider requests.

### Step 117 - Review: Present the final handoff; obtain owner acceptance or identify outstanding work
- [ ] 16.6 Review: Present the final handoff; obtain owner acceptance or identify outstanding work

Present the complete requirements/gates/documentation report and user-visible handoff. Do not archive the change, delete plans, publish facets, or execute a later roadmap phase as part of this step.
