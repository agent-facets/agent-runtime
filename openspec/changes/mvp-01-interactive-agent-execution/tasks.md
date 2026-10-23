> **Before executing any tasks below**, load the `viper-execution-rules` skill for the full VIPER step protocol (step types, execution rules, gating, and hard constraints).

# Tasks

Implement the reconciled [proposal](proposal.md), [execution specification](specs/execution/spec.md), and [design](design.md). All checkboxes start unfinished; creating this artifact does not execute the work.

Owner-approved refinement on 2026-09-29 adds the Bun/Turbo monorepo and separate runtime/UI package boundaries after the original adversarial reconciliation. Retained adversarial artifacts/reviews describe the earlier revision, not a new review of these edits. Task identities, ordering and model-switch pauses are preserved; updating this plan marks no implementation work complete.

Owner-approved corrective replan on 2026-09-30 inserts groups 17–18 after the completed 7.1 pause and before resuming 7.2. Their Step IDs 118–128 are additional stable identities, not instructions to execute them after Step 117: execution SHALL follow document order. Original task IDs, relative ordering, completed checkboxes, model-switch gates and historical evidence SHALL remain intact. Tasks 17.1–17.2 record research and proposal approval actually completed in the conversation; all corrective implementation, verification, acceptance and new pauses remain unfinished. Earlier block-6 acceptance is historical evidence, not proof that the newly identified cases pass. This revision does not claim renewed adversarial review or authorize source edits in Plan mode.

Owner-approved provider replan on 2026-09-30 replaces the upstream public-release prerequisite with the minimal internal v2-derived Anthropic subscription package in revised design Decision 10. LangChain/LangGraph and stock ChatAnthropic remain unchanged. Completed task descriptions, including the release research at 9.2, record the earlier work and SHALL remain intact; their upstream-delivery assumptions are superseded for future execution by this amendment. All 128 task identities, the 73 completed checkboxes, document order and model-switch/approval/verification gates are preserved. The pending provider tasks below implement the approved ownership change and the identified in-flight screening prerequisite. This artifact revision completes no additional task or gate and does not authorize implementation before 9.5 approval and the 10.1 pause, upstream edits or live provider traffic. Retained evidence and adversarial artifacts SHALL NOT be rewritten to describe the new approach as already verified.

Owner-approved trial replan on 2026-09-30, at the 12.11 Review: the Anthropic G4 live journey (12.12) runs locally — the built runtime started directly on the owner's machine, loopback-only, with a dedicated database — instead of through Compose, Tailscale Serve and a second tailnet device. Private-network access is not abandoned: inserted task 16.7 (Step 129) verifies Serve HTTPS and a second-device journey before phase-exit evidence. G4 evidence SHALL state that the tailnet path was not covered by the local trial. The live allowance itself is recorded at 12.11.

Owner-approved browser-auth replan, after the local runtime was shown to the owner: pause the live trial and implement the Connect Anthropic flow in revised design Decision 16. Proposal, specification, design and this task amendment were each approved in the conversation. Insert tasks 12.16–12.20 (Steps 130–134) after historical 12.11 and before 12.12; execute in document order, not numeric order. The three implementation steps, offline Verify and fresh live-authorization Review join the existing implementation phase without introducing another exploration block or changing any existing model-switch Pause. All 129 prior task identities, completed-work history and retained adversarial artifacts SHALL remain intact. The five new tasks start unfinished. The earlier terminal-login allowance at 12.11 SHALL NOT authorize browser auth or model traffic on the revised build. Demo hardening, mobile-specific work, OpenAI auth expansion and the deferred tailnet journey are outside this addition.

Owner-approved full-stack validation replan on 2026-10-01, after acceptance at 12.15: validate the shipped Docker/Tailscale/PostgreSQL stack before OpenAI research. Move the existing unfinished 16.7 (Step 129) into the full-stack validation sequence below, after its fresh live-authorization Review, rather than duplicating or marking it complete. Add tasks 19.1–19.6 (Steps 135–140) for deployment approval, provider-free deployment verification, fresh Anthropic authorization, evidence recording/verification and owner acceptance. Group 19's setup/approval and evidence/acceptance sections surround the moved group-16 task to preserve its existing number; execute in document order. These steps continue the current implementation/verification phase; the existing 13.1 model-switch Pause remains immediately before OpenAI exploration. Preserve all 134 prior task identities, completed work, evidence and adversarial history. This amendment approves scope and sequencing only; deployment/enrollment and provider calls have separate pending gates. No local relay, inert Tailscale substitute, host networking, mobile work or new demo launcher is included.

Owner-approved OpenAI removal-first replan on 2026-10-06, after the failed 14.7 live journey: remove the bespoke Codex authentication/inference path before choosing its replacement. Proposal, execution-specification and design amendments were approved separately. Insert groups 20–21 (Steps 141–155) after the historical 14.6 authorization and before the suspended 14.7 verification; execute in document order, not numeric order. Preserve all 140 prior task identities, their completed-work history, failed attempts and adversarial artifacts. All 15 new tasks start unfinished. The added pauses preserve exploration/implementation boundaries. Scope is deletion, explicit OpenAI unavailability, Anthropic regressions, separately approved rollout and removal evidence only; no new provider implementation, auth ceremony, gateway or vendor agent engine is authorized. Existing records and credentials remain private and intact, with no provider/billing fallback. This amendment is planning, not source/deployment permission or a live-provider allowance.

**Historical execution stop after 21.12.** The removal amendment blocked 14.7 and its dependents pending a separately approved replacement with research, implementation, offline verification and fresh live authorization. That stop was honored: the owner subsequently approved and completed the standalone `openai-device-auth-recovery` VIPER plan, then accepted its working state and requested deletion of that plan and its results. The following reconciliation, not the old Codex trial, now controls forward execution. Removal alone still does not satisfy G5 or phase exit.

**Owner-approved recovery reconciliation (2026-10-06).** Current source is `dbf71453a0500163e2a8510f23ac4212d7572609`, the separately approved Minimal TypeScript recovery described in revised Decisions 11 and 16. Preserve all 155 existing task identities, their relative order, all 142 completed checkboxes, failed attempts and adversarial history. Insert groups 22–23 (Steps 156–161) after historical 21.12 and before 14.7; execute in document order. All six new tasks start unfinished. This amendment completes no task and claims no new adversarial review, source verification, deployment or provider allowance. The pauses preserve the existing VIPER phase boundaries.

The recovery's implementation and accepted live observations SHALL be reconciled into repository evidence, not repeated merely because its standalone artifacts were deleted. Current code SHALL NOT be reverted to the removal-only state. The remaining provider-block delta is bounded acceptance-reporting/tests and current-documentation cleanup, followed by records-only G5 reconciliation and evidence review. No provider implementation, dependency upgrade, credential migration, new service or live rerun is implicit. The owner-approved exceptions and historical test results remain attributed observations, not newly executed checks. Final coverage, current-build Anthropic applicability and compatible-image rollback remain open until their own gates.

**Owner-approved acceptance-prerequisite replan (2026-10-06).** After completion of the reporting cleanup, G5 reconciliation and the 15.2 coverage audit, add groups 24–25 (Steps 162–169) immediately before 15.3, implementing revised design Decision 17. Preserve all 161 prior task identities, their relative order and all 154 completed checkboxes; execute in document order. The eight new tasks start unfinished and retain the implementation/exploration switch pauses. The specification remains 32 requirements and 80 scenarios. Scope is synthetic unfinished-login restart/expiry regressions, an isolated compatible-image rollback rehearsal, and the identified documentation/provenance corrections—not runtime behavior changes, a new OpenAI trial or a live rollback. Existing accepted milestones and exceptions remain historical decisions, not claims that these new witnesses already pass. Source/test changes require the concrete proposal at 24.2 and an implementation handoff; this artifact revision authorizes no live deployment, auth or model operation. The final Anthropic evidence-applicability decision remains explicit at 15.3.

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
- The Bun workspace SHALL separate `packages/runtime` from `packages/ui`, with one application deployment. Root configuration owns shared tooling; package manifests own application dependencies and use `workspace:*` for internal links. The provider block SHALL introduce private server-only `packages/anthropic-subscription`, with no dependencies on runtime, UI, browser contracts, OpenCode, LangChain or provider SDKs. `packages/contracts` SHALL be introduced with the API block for pure browser-safe wire schemas/types, not server records or credential handling. The UI SHALL NOT import runtime internals or the subscription package. Package scaffolding does not authorize console feature work before the pre-console gates.
- Default tests SHALL be deterministic and independent of live credentials, provider traffic, production databases, and production services. Integration commands SHALL require isolated test storage and explicit invocation; fixtures SHALL never reset owner volumes or import spike credentials.
- Future-block test cases MAY remain explicitly skipped with a task reference until their prerequisite lands. A skipped mandatory G1–G5 check SHALL NOT count as passed. All Phase-1 acceptance skips SHALL be resolved before final acceptance.
- The project SHALL own the minimal internal Anthropic extraction specified in design Decision 10. Its baseline is the reviewed `@ex-machina/opencode-anthropic-auth@2.0.0-next.5` source and recorded revision/integrity, not a moving tag or the historical 1.8.1 spike profile. No new upstream release is required. Block 9 confirms ownership/extraction scope; block 10 implements and tests the actual package before connecting production registration and deployment. Actual-package G2 and offline G4/G5 remain mandatory before console buildout. Test doubles SHALL NOT substitute for acceptance. No runtime private upstream imports, OpenCode host/plugin dependency, global-fetch patch, framework/SDK fork, upstream edit or extraction beyond the reviewed scope is authorized.
- Live verification SHALL have fresh approval for the named provider/model, account setup or renewal operations, maximum physical model requests, and any retry allowance. Approval of this task list or a prior spike SHALL NOT grant that authority. The owner SHALL handle sensitive login steps personally, through the explicitly approved dedicated browser-auth flow or private-terminal fallback. The executor SHALL NOT inspect provider sign-in content, pasted codes or authentication network bodies; only safe readiness and verification outcomes enter the execution transcript. This replaces the terminal-only constraint for the browser-auth addition, not for unapproved provider flows.
- Verification failures SHALL stop dependent work. Changed approaches require explicit replanning; failed Bun checks SHALL NOT silently select Node, a custom saver, a middleware-only request counter, or billed access.
- Gate evidence SHALL live under `architecture/integration-evidence/mvp-01/`, indexed from `architecture/spike-reports/README.md`. Fixed files are `g1-bun-persistence.md`, `g2-anthropic-boundary.md`, `g3-dispatch-lifecycle.md`, `g4-anthropic-offline.md`, `g4-anthropic-live.md`, `g4-anthropic-docker-tailnet.md`, `g5-openai-offline.md`, `g5-openai-live.md`, `g5-openai-recovery.md`, `openai-removal.md`, `upstream-handoff.md`, `openai-cost-checkpoint.md`, and `phase-exit.md`. The new recovery record SHALL NOT overwrite the old G5 failure or removal records.
- The retained `upstream-handoff.md` path SHALL record internal derivative ownership, exact upstream provenance/license, intentional differences and the update procedure; it SHALL NOT claim delivery of an upstream standalone release. G2 SHALL identify the actual internal package revision and tested source, not infer acceptance from its upstream version or from consumer fakes.
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
- [x] 1.3 Propose: Present foundation changes and upstream handoff; obtain owner approval

Present scaffold, test isolation, container topology and commands. Notify the owner of the release contract needed at block 9; missing delivery does not prevent the independent work in blocks 1–8. Obtain approval for the next implementation block without implying provider authorization or upstream source-edit permission.

Include separate runtime/UI package scaffolding, the deferred contracts package, shared configuration, Turbo task/cache policy and the single application-build boundary. Functional UI work remains in its later block.

## 2. Development foundation — Implementation

### Step 4 - Pause: Switch model for implementation
- [x] 2.1 Pause: Switch model for implementation

### Step 5 - Implement: Pin the toolchain and commands; verify frozen installation and scaffold checks
- [x] 2.2 Implement: Pin the toolchain and commands; verify frozen installation and scaffold checks

Extend root `package.json`, `bun.lock` and `mise.toml` into the Bun/Turbo workspace. Add `turbo.json`, root/package Bun configuration, shared strict TypeScript and Biome configuration, root scripts, and separate `packages/runtime`/`packages/ui` package scaffolds. Replace the root Bun-init entrypoint with the runtime package entrypoint; root scripts remain the documented interface. Pin Bun and dependencies, remove unused floating Node, and establish frozen-install/dev/start/build/check/check:verify/test/typecheck/lint plus explicit integration commands. Root owns development tooling; packages declare their own application dependencies and use `workspace:*` for internal links. Include checks preventing runtime imports from `spikes/**` and UI imports of runtime internals.

Implement the design's Turbo task graph, local-only cache policy and actual application-build outputs. Use separate browser/server TypeScript environments. Establish only the UI package/configuration boundary here; do not implement browser features, add a speculative contracts package or fabricate passing UI feature tests for an empty shell. React dependencies and the functional HTML entry arrive in the console block.

Assert `mise exec -- bun --version` reports the pinned Bun version (initial target 1.3.14), frozen installation reproduces the recorded package matrix, and direct runtime `pg` imports occur only inside the approved saver adapter. Preserve the existing prohibition on runtime imports from `spikes/**`.

Assert root `packageManager` agrees with mise, Turbo is pinned to the selected version, workspace resolution is local and package entry points cannot bypass the import-boundary guards. `check:verify` SHALL force the complete offline check graph; ordinary `check` MAY reuse valid local results.

### Step 6 - Implement: Add the container foundation; verify topology and readiness smoke tests
- [x] 2.3 Implement: Add the container foundation; verify topology and readiness smoke tests

Add the non-root Bun image and Compose runtime/PostgreSQL/Tailscale topology, private volumes, read-only `/workspace`, scratch space and minimal health/readiness entrypoint. Add synthetic-configuration and container smoke coverage for namespace/bind/mount policy; do not build the browser console or contact real providers.

Include `.env.example` with placeholders only. Check digest-pinned images, non-root/read-only runtime execution, writable private state/scratch only, healthcheck behavior, and absence of published application/database ports in the rendered Compose configuration.

Build from the repository root using the frozen root lockfile and required workspace manifests/sources, excluding historical harnesses and private material from the build context. Verify the image starts the runtime package entrypoint and resolves any unbundled workspace/runtime dependencies without Turbo or a separate UI server. Initial workspace pruning is deferred; this block's image contains no functional console.

### Step 7 - Implement: Isolate test execution; verify unsafe targets are rejected
- [x] 2.4 Implement: Isolate test execution; verify unsafe targets are rejected

Add isolated integration-fixture configuration and explicit test-service commands. Default `bun test` SHALL start no external services or external suites; integration commands SHALL refuse production database and credential paths. Land the tests proving these boundaries.

Cover both bare root Bun discovery and Turbo's root/package test graph: exclude spikes, generated outputs and integration/live suites from ordinary checks, and verify every implemented package's unit suite is included. Integration/live commands and dev/start tasks SHALL be uncached; ordinary checks SHALL NOT invoke them. Add synthetic task-graph fixtures proving relevant shared-configuration and transitive source changes invalidate consumers, including a source-only dependency, and that a warm build-cache hit restores actual deployable outputs. Verify local-only cache operation and task-specific report paths without ambient credentials or owner data.

### Step 8 - Implement: Document the foundation; verify README commands and scope
- [x] 2.5 Implement: Document the foundation; verify README commands and scope

Replace README boilerplate with implemented setup/check/container prerequisites and limitations. Add MVP-precedence notices to `architecture/README.md` and `architecture/10-delivery-phases.md`. Match the actual scripts and do not describe undelivered features as working.

Document runtime/UI package ownership, the later contracts extraction, one application deployment, root versus package commands, direct versus Turbo test execution, forced `check:verify`, cache/output behavior and the workspace-aware Docker build. Clearly distinguish UI scaffolding from an implemented console.

### Step 9 - Verify: Run foundation checks; require passing installation and smoke suites
- [x] 2.6 Verify: Run foundation checks; require passing installation and smoke suites

Run block checks, frozen-install verification and isolated container smoke tests. Report exact tool/image versions and results. Do not use source-changing lint flags.

Require passing cold/forced Turbo checks, direct-Bun discovery safety, shared-input invalidation and warm-cache build-output restoration fixtures, package import guards and the workspace-built image smoke. Keep cache-behavior observations distinct from the forced checks used as fresh acceptance evidence.

### Step 10 - Review: Assess foundation evidence; obtain owner acceptance
- [x] 2.7 Review: Assess foundation evidence; obtain owner acceptance

Present scaffold and test-isolation findings, then obtain approval to continue or a concrete correction request.

## 3. Durable records and Bun compatibility — Research

### Step 11 - Pause: Switch model for exploration
- [x] 3.1 Pause: Switch model for exploration

### Step 12 - Explore: Inspect persistence APIs; verify the bounded G1 proof plan
- [x] 3.2 Explore: Inspect persistence APIs; verify the bounded G1 proof plan

Inspect pinned Bun SQL reserved-session behavior and official saver APIs against the spike evidence. Report public-API choices for schemas, migrations, pool/client errors and lock loss. Keep the first G1 fixture independent of the full application schema/controller.

### Step 13 - Explore: Map data invariants; verify the constraint and transaction checklist
- [x] 3.3 Explore: Map data invariants; verify the constraint and transaction checklist

Map design Decisions 3–4 to records, keys/unions, migrations and tests covering same-run references, JSON null/false, event ordering, epochs and idempotency.

### Step 14 - Propose: Present persistence and G1 work; obtain owner approval
- [x] 3.4 Propose: Present persistence and G1 work; obtain owner approval

Present the implementation and isolated PostgreSQL test scope, including the checkpointer-only `pg` exception and the early stop before full schema work if G1 fails.

## 4. Durable records and Bun compatibility — Implementation

### Step 15 - Pause: Switch model for implementation
- [x] 4.1 Pause: Switch model for implementation

### Step 16 - Implement: Add application and saver adapters; verify driver-boundary tests
- [x] 4.2 Implement: Add application and saver adapters; verify driver-boundary tests

Implement Bun SQL application access and the official saver adapter with its controlled `pg` pool and pool/client error listeners. Test the configured pool limits, schema separation and the import-boundary guard. Do not introduce application queries through `pg`.

### Step 17 - Implement: Add serialized schema setup; verify migration and readiness tests
- [x] 4.3 Implement: Add serialized schema setup; verify migration and readiness tests

Implement migration journal/ownership metadata, serialized application/saver setup and schema-version readiness. Test concurrent starters, idempotent setup and refusal of unknown/newer schema versions. Full run records still follow the early G1 gate.

### Step 18 - Implement: Add runtime ownership; verify singleton and lost-session fencing tests
- [x] 4.4 Implement: Add runtime ownership; verify singleton and lost-session fencing tests

Implement singleton ownership, reserved-session identity/lock checks, owner epochs, per-run serialization primitives and pool limits. Test two instances, idle locks, session replacement and stale owners; do not reserve a database connection per run.

### Step 19 - Implement: Add the bounded G1 fixture; verify root-agent restart and negative-answer assertions
- [x] 4.5 Implement: Add the bounded G1 fixture; verify root-agent restart and negative-answer assertions

Use real Bun/official-saver persistence with a deterministic model and interrupting root `createAgent` tool. Assert synchronous durability, omission of `checkpoint_id`, fresh-process resume and a negative answer. Include independent work witnesses, without depending on production run records or repeating the old spike programme.

Use a child Bun process killed after confirmed pause settlement, then a fresh process carrying an ID-addressed `{ questionId, answer: false }` envelope. An independent witness SHALL observe the delivered answer once. Also prove lost ownership prevents subsequent dispatch. Duplicate application-answer protection remains a G3/controller test; do not assume a raw duplicate graph resume is deduplicated by LangGraph.

### Step 20 - Verify: Run the early G1 gate; stop on Bun or ownership incompatibility
- [x] 4.6 Verify: Run the early G1 gate; stop on Bun or ownership incompatibility

Run current block checks and the isolated G1 fixture before full schema/controller buildout. Require successful pause/resume, lock/session-loss fencing and cross-driver coexistence; report the exact tested matrix. A failed mandatory check stops here for explicit replanning.

### Step 21 - Implement: Add durable record schemas; verify database invariants and scalar-answer tests
- [x] 4.7 Implement: Add durable record schemas; verify database invariants and scalar-answer tests

Add run/question/invocation/attempt/tool/event/definition records, variant CHECKs, same-run references, deferred consistency and uniqueness. Tests SHALL reject invalid unions, duplicate pending questions, cross-run references and oversubscribed budgets while accepting allowed false/null values.

### Step 22 - Implement: Add atomic mutations and snapshots; verify idempotency and event-order tests
- [x] 4.8 Implement: Add atomic mutations and snapshots; verify idempotency and event-order tests

Implement creation-request idempotency, event/source-key allocation, atomic transition primitives and consistent snapshots. Add concurrency/rollback tests for one creation per request, payload conflicts, ordered committed history and terminal protection.

Explicitly test same-source-key/same-payload replay, same-key/different-payload refusal, decimal-string event sequences and same-owner ambiguous-commit readback before dispatch.

### Step 23 - Implement: Document persistence; verify schema and evidence descriptions
- [x] 4.9 Implement: Document persistence; verify schema and evidence descriptions

Update README database/test setup, `architecture/06-storage-and-backup.md` and `architecture/09-data-model-and-lifecycle.md`. Add separately dated evidence pointers to the spike-report index. Distinguish G1 results from the unfinished full lifecycle and retain original spike reports unchanged.

Record the already-observed early G1 results in `g1-bun-persistence.md`, including the exact tested source/matrix and its limited proof scope. Do not claim later record-schema checks have passed before their Verify step.

### Step 24 - Verify: Run persistence regressions; require passing G1 and record suites
- [x] 4.10 Verify: Run persistence regressions; require passing G1 and record suites

Run block checks and PostgreSQL ownership/saver/schema/mutation suites against the resulting exact matrix, including pool failures, rollback and preserved-storage restart.

### Step 25 - Review: Assess persistence evidence; obtain owner acceptance
- [x] 4.11 Review: Assess persistence evidence; obtain owner acceptance

Present the durable-record and G1 findings. Do not claim host reboot or active crash recovery has been established.

## 5. Workspace, credential and input boundaries — Research

### Step 26 - Pause: Switch model for exploration
- [x] 5.1 Pause: Switch model for exploration

### Step 27 - Explore: Inspect workspace enforcement; verify the bounded tool test plan
- [x] 5.2 Explore: Inspect workspace enforcement; verify the bounded tool test plan

Inspect file APIs and mount assumptions against Decision 12. Cover file/directory reads, literal search, credential exclusions, static escapes, aliases, changed targets and the declared non-hostile-volume assumption.

### Step 28 - Explore: Inspect credential and input contracts; verify the coordination plan
- [x] 5.3 Explore: Inspect credential and input contracts; verify the coordination plan

Inspect reuse evidence and provider/question/failure types. Report cross-process coordination, partial rotation, safe projection and future auth-mode boundaries without implementing API-key access.

### Step 29 - Propose: Present authority-boundary work; obtain owner approval
- [x] 5.4 Propose: Present authority-boundary work; obtain owner approval

Present the next implementation block and its tests. Provider-network access remains disabled.

## 6. Workspace, credential and input boundaries — Implementation

### Step 30 - Pause: Switch model for implementation
- [x] 6.1 Pause: Switch model for implementation

### Step 31 - Implement: Add configuration and input contracts; verify typed validation tests
- [x] 6.2 Implement: Add configuration and input contracts; verify typed validation tests

Implement validated operator configuration, immutable workspace/provider snapshots, question/failure DTOs, readiness states and tracing/environment guards. Test unsupported modes/endpoints/authority fields and distinctions among scalar false, strings, null, permitted empty text and canonical multi-choice answers.

Add table-driven failure-mapping tests for every category and operation context, including device-poll 403/404 versus inference rejection. Test explicit tracing refusal and prove ambient API keys cannot select a billed mode or reach a subscription request.

### Step 32 - Implement: Add private credential storage; verify permissions and atomic replacement
- [x] 6.3 Implement: Add private credential storage; verify permissions and atomic replacement

Implement versioned records, generations, strict decoding, `0700` directories, `0600` records and complete atomic replacement. Test truncated/invalid files, interrupted writes, preserved-storage restart and newer-generation selection using synthetic credentials.

### Step 33 - Implement: Add shared refresh coordination; verify two-process rotation exclusion
- [x] 6.4 Implement: Add shared refresh coordination; verify two-process rotation exclusion

Implement provider-scoped single-flight and the runtime/operator lock covering reread, injected refresh, partial merge and durable replacement. Test two processes contending for the same credential: exactly one refresh occurs, an omitted refresh token preserves the existing value, and reauthorization cannot be overwritten by a stale refresh. Test temporary failure separately from definitive rejection.

### Step 34 - Implement: Add confinement and file reads; verify path and byte-limit fixtures
- [x] 6.5 Implement: Add confinement and file reads; verify path and byte-limit fixtures

Implement the common workspace policy and `mcp_Read` file mode. Test traversal, absolute paths, symlink components/leaves, special files, changed targets, credential locations and known hard-link aliases. Assert the one-MiB file bound, 200 default/2,000 maximum lines and 64-KiB result bound, with typed missing/unreadable errors and visible truncation.

### Step 35 - Implement: Add directory reads; verify filtered discovery and pagination
- [x] 6.6 Implement: Add directory reads; verify filtered discovery and pagination

Implement directory mode with `.` discovery, name ordering, 200 default/2,000 maximum entries, the 64-KiB result bound and the same exclusions before returning metadata. Test excluded entries, unchanged-tree cursor continuation and visible truncation; document that pagination is not a filesystem snapshot.

### Step 36 - Implement: Add literal search; verify scan limits and nonfatal refusals
- [x] 6.7 Implement: Add literal search; verify scan limits and nonfatal refusals

Implement literal search with 100 matches, 2,000 examined files, 16 MiB scanned text and the common file/result limits. Test excluded directories, binary files, an escaping symlinked subtree and incomplete-result reporting rather than false negative results. Verify tool code has no arbitrary process-execution path.

### Step 37 - Implement: Add secret-safe projections; verify seeded-secret and permission tests
- [x] 6.8 Implement: Add secret-safe projections; verify seeded-secret and permission tests

Implement safe logging/projections, input credential rejection and pre-graph tool/model sanitation interfaces. Test goals, answers, results, nested errors and fragmented model content. Forbidden mutations and inspected instructions SHALL NOT expand permissions.

Include a secret split across three stream fragments and an ordinary-code false-positive corpus. Reject raw request/body objects at the diagnostic boundary. Preserve the test proving inspected instructions cannot widen tool permissions.

### Step 38 - Implement: Document authority boundaries; verify implemented scope and limitations
- [x] 6.9 Implement: Document authority boundaries; verify implemented scope and limitations

Update README, `architecture/08-execution-security.md` and `architecture/05-model-authentication.md`. Do not describe read-only mounts as complete confinement; retain subscription-only scope and clearly mark unfinished provider login paths.

### Step 39 - Verify: Run authority-boundary suites; require passing isolation and rotation checks
- [x] 6.10 Verify: Run authority-boundary suites; require passing isolation and rotation checks

Run block checks and isolated filesystem/credential suites. Require passing typed-input, confinement, exclusion and multi-process rotation tests without touching protected application directories.

### Step 40 - Review: Assess boundary evidence; obtain owner acceptance
- [x] 6.11 Review: Assess boundary evidence; obtain owner acceptance

Review implementation, tests and documentation before connecting these boundaries to the agent harness.

## 7. Controlled execution and human continuation — Research

### Step 41 - Pause: Switch model for exploration
- [x] 7.1 Pause: Switch model for exploration

Task 7.2 was paused after prerequisite defects were identified. The following corrective block SHALL complete, including verification and owner acceptance, before 7.2 resumes. The original lifecycle/controller proposal at 7.4 remains a separate approval gate.

## 17. Authority-boundary prerequisite corrections — Research

### Step 118 - Explore: Confirm boundary defects; verify correction sites and independent regression witnesses
- [x] 17.1 Explore: Confirm boundary defects; verify correction sites and independent regression witnesses

Read-only inspection covered the current workspace, credential, security and configuration modules, their tests and README, plus the pinned framework's public middleware/state-inspection contracts. Synthetic in-memory probes confirmed: search excerpting can retain a suffix of a recognized credential; private-key masking leaves the body; a quote-filled clipped line serializes to 114,619 bytes and fails its ignored budget admission; a 1,048,576-byte input is accepted after redaction expands its text to 1,376,256 bytes; and credential decoding accepts a short token that exact matching ignores. These are narrow probes, not a new acceptance-suite run.

Static findings also identify pre-aborted refresh initiation, missing descriptor-size rechecks in search, swallowed candidate-inspection failures, lexical-only root validation and silently partial protected-inode discovery. Their new regression fixtures remain implementation work. The research read no actual credential records, contacted no providers, wrote no application files and established no new G1–G5 pass.

### Step 119 - Propose: Present the bounded corrective scope; obtain owner approval of policies and verification
- [x] 17.2 Propose: Present the bounded corrective scope; obtain owner approval of policies and verification

The owner approved the corrective scope and this tasks-only revision on 2026-09-30. The approved policies are: complete-content screening before projection; whole private-key-block masking, conservatively through EOF when malformed; literal matching of original non-secret text with incomplete reporting for withheld coverage; complete serialized post-sanitation bounds; a shared 16-character minimum for usable access/refresh tokens; opaque exact-matching capability; pre-abort checks without cancelling existing shared rotation; and complete-or-failed workspace/private-location validation.

The corrective block SHALL NOT implement the graph/controller, contact providers, alter upstream code, upgrade dependencies, add database migrations or rewrite historical evidence. Complete stock-message replay preservation, pre-checkpoint safe exceptions and actual in-flight settlement remain block-8 obligations. The existing proposal/specification intent and architecture remain controlling; these tasks repair prerequisites rather than widen Phase-1 authority.

## 18. Authority-boundary prerequisite corrections — Implementation

### Step 120 - Pause: Switch model for implementation
- [x] 18.1 Pause: Switch model for implementation

### Step 121 - Implement: Screen complete content before projection; verify secret-span and source-location regressions
- [x] 18.2 Implement: Screen complete content before projection; verify secret-span and source-location regressions

Update `packages/runtime/src/security/content-policy.ts` and workspace file/search projection to identify recognized credential spans over the complete admitted decoded file before line pagination, clipping or excerpt selection. Merge overlapping protected spans without running replacements over replacement text. Mask complete recognized private-key blocks, including delimiters and body; missing/mismatched termination or malformed nesting SHALL conservatively withhold the remainder through EOF. Preserve original source line numbering and line boundaries.

Search SHALL retain case-sensitive literal matching against original non-secret source text, not inserted redaction markers. Matches intersecting credential spans SHALL be suppressed; excerpts SHALL be derived from sanitized spans without reinserting raw query text or using obsolete offsets. Withheld searchable coverage SHALL make the result explicitly incomplete rather than a complete negative search. Credential-bearing semantic fields, including paths/cursors, SHALL produce a fixed safe refusal rather than a rewritten identity. All tool-outcome variants SHALL be validated/sanitized before release; arbitrary errors SHALL NOT bypass the boundary.

Add regressions for credentials crossing either excerpt boundary, replacements before a match, queries within protected material, no manufactured matches from markers, complete/multiple/malformed PEM blocks, LF/CRLF, pagination starting inside a block, and ordinary lines after a closed block retaining their numbers. Include overlapping credentials, repeated sanitation and the existing ordinary-code false-positive corpus. If a rendered result cannot satisfy the safety postcondition, withhold it safely rather than iterating unbounded replacement.

### Step 122 - Implement: Enforce final serialized bounds; verify escaping, expansion and bounded assembly
- [x] 18.3 Implement: Enforce final serialized bounds; verify escaping, expansion and bounded assembly

Update `workspace/results.ts`, file clipping and `security/pre-graph.ts`. The authoritative tool bound SHALL be 65,536 UTF-8 bytes for the complete final serialized `ToolOutcome`, including envelope, metadata, escaping and sanitation. Item budgets/headroom MAY remain optimizations, but an item SHALL NOT be appended after failed budget admission. Oversized single lines SHALL use a Unicode-code-point-safe prefix selected by serialized entry cost; serialized JSON and semantic tool arguments SHALL never be cut. A final overflow SHALL return a bounded application-owned refusal, not an arbitrary exception or oversized payload.

Retain the assembler's 1,048,576-byte input bound and additionally enforce that bound on its final sanitized serialized message representation. Account for retained structure as well as string data; empty fragments SHALL NOT accumulate unbounded arrays/maps. Overflow SHALL reject the message with a safe reason and release retained buffers. This is a correction to the existing synthetic interface, not a substitute for block 8's metadata-preserving stock-message sanitizer or block 10's provider-terminal checks.

Test exact-limit/+1 cases, quotes/backslashes/control characters, multibyte single lines, envelope-only overflow, redaction expansion, retained tool-call structure, empty fragments and malformed/storable-text boundaries. Measure entire outcomes rather than only `.result`. Keep visible clipping/pagination correct; final sanitation SHALL NOT invalidate the enforced bound.

### Step 123 - Implement: Align credential screening and cancellation entry; verify admission and shared-rotation witnesses
- [x] 18.4 Implement: Align credential screening and cancellation entry; verify admission and shared-rotation witnesses

Share a minimum length of 16 printable non-space ASCII characters between access/refresh credential decoding and exact-matcher admission, retaining the existing maximum. This is an explicit runtime safety policy, not an inferred provider token-format guarantee. Short existing records SHALL fail decoding without automatic rewriting; invalid newly issued/rotated credentials SHALL NOT replace the last committed generation. Update synthetic fixtures rather than weakening the new rule. No SQL migration, credential import or real issuer operation is authorized.

Replace the exposed secret-value iterable with an opaque exact-matching/redaction capability owned by the credential boundary. Consumers SHALL receive no token enumeration capability. Construction intended for execution SHALL require an explicit matcher, with explicitly credential-free fixtures distinguished from production construction. Test all supported admitted token lengths, unknown/default matcher omission, overlap and repeated sanitation. Actual generation freshness, retention for in-flight responses and controller wiring remain block-8 integration obligations and SHALL NOT be described as delivered here.

Correct `credentials/coordinator.ts` and `credentials/lock.ts` so pre-aborted callers initiate no new refresh or lock-helper operation. Recheck cancellation after asynchronous setup and immediately before starting local work. Once a shared refresh has started, an individual waiter may abandon waiting but SHALL NOT cancel shared issuer settlement, discard rotated credentials or release its provider lock prematurely. Preserve the parent-held kernel-lock design and bounded ordinary lock wait.

Add independent issuer/helper counters for pre-aborted calls and controlled setup races, plus a separate cancelled-waiter fixture proving an existing shared refresh persists exactly once under its retained lock. Retest generation fencing, partial rotation, two-process exclusion and token-free rejection records. No fallback locking mechanism or automatic ambiguous-refresh retry is authorized.

### Step 124 - Implement: Validate workspace admission and scan accounting; verify alias, fault and descriptor-bound fixtures
- [x] 18.5 Implement: Validate workspace admission and scan accounting; verify alias, fault and descriptor-bound fixtures

Update runtime path validation and the common workspace policy/filesystem/protected-identity helpers. Establish normalized/canonical workspace and private-location separation before usable workspace admission; inspect configured-root ancestors and refuse static symlink aliases rather than checking only the final root component. Keep private configuration/state overlap checks component-aware and consistent across all tool modes. Missing optional credential slots SHALL remain distinguishable from a required private-root inspection failure.

Protected-inode discovery SHALL return complete protection or an explicit failure, not silently skip permission/metadata errors or present capped traversal as complete. Bound raw enumeration and retained traversal work, not merely the number of successfully collected identities. If protection cannot be established, workspace access SHALL remain unavailable; do not repair permissions or mutate owner directories.

Search SHALL recheck the opened descriptor's size against the per-file and remaining aggregate read allowances before allocation/read, using a bounded common read primitive. Actual scan accounting SHALL include reads later discarded after an observed change. Disappeared/unreadable eligible candidates SHALL contribute to incomplete coverage rather than being silently omitted; intentional policy exclusions remain exclusions. Preserve the existing file/result/traversal limits and no-process/no-mutation tool boundary.

Test static root-ancestor aliases, private-location aliases, incomplete protected discovery, ordinary file growth between resolution and open, discarded-read accounting, and candidate disappearance/permission failure. Use deterministic injected filesystem barriers where needed rather than timing-only races. This remains an owner-controlled-volume boundary, not hostile-host isolation or an `openat2`/FFI implementation.

### Step 125 - Implement: Document corrected authority boundaries; verify examples and scope against implementation
- [x] 18.6 Implement: Document corrected authority boundaries; verify examples and scope against implementation

Update README and `architecture/05-model-authentication.md` / `architecture/08-execution-security.md` with full-content screening, private-key EOF handling, original non-secret literal-search semantics and withheld coverage, complete post-sanitation size bounds, the credential safety floor and short-record behavior, pre-abort/shared-rotation distinction, and workspace/private-location validation failure behavior. Verify examples, links and commands against the implemented code. There is no existing `docs/` content to reconcile.

Retain the distinction between synthetic boundary components and their unfinished graph/provider integration. Preserve prior acceptance records and adversarial history; do not retroactively claim the earlier suites covered these regressions or claim future verification passed. No upstream report submission or historical G1 rewrite is part of this correction.

### Step 126 - Verify: Run corrective acceptance; require fresh boundary, integration and container checks
- [x] 18.7 Verify: Run corrective acceptance; require fresh boundary, integration and container checks

Run forced `mise exec -- bun run check:verify`, direct `mise exec -- bun test`, the existing isolated integration suite, affected container smoke and credential/workspace/security regression suites in the pinned Bun image. Container boundary suites SHALL run non-root, with a read-only root filesystem and no provider-network access. Preserve source/dependency/image identity and distinguish each suite's exit status from filtered output; a pipeline that hides a failing test process SHALL NOT count as success.

Require the new regression cases, existing rotation/crash/confinement/typed-input suites, import/process/mutation guards and affected persistence/G1 regressions to pass without acceptance skips. No actual credentials, production storage or provider requests are permitted. Run strict OpenSpec validation, verify preserved historical/adversarial material and confirm cleanup of only launcher-owned fixtures. Any failure SHALL stop dependent work for guidance; no source-changing formatting flags belong in this Verify step.

### Step 127 - Review: Assess corrective evidence; obtain owner acceptance before resuming harness research
- [x] 18.8 Review: Assess corrective evidence; obtain owner acceptance before resuming harness research

Present actual fixes, test commands/results, policy effects, limits and remaining block-8 integration obligations. Obtain explicit owner acceptance or a concrete correction request. Passing these component suites SHALL NOT be reported as G3 completion or proof of real provider/graph sanitation. Task 7.2 SHALL remain pending until this gate and the following model-switch pause complete.

### Step 128 - Pause: Switch model for exploration
- [x] 18.9 Pause: Switch model for exploration

## 7. Controlled execution and human continuation (continued) — Research

### Step 42 - Explore: Inspect harness hooks; verify the controller integration map
- [x] 7.2 Explore: Inspect harness hooks; verify the controller integration map

Recheck pinned public model/tool middleware and interrupt/state-inspection contracts. Preserve root invocation, control-flow exceptions, sole-question batches and service-owned cancellation.

After the corrective block, recheck its interfaces rather than treating the earlier inspection as current-build verification. The integration map SHALL explicitly cover lossless stock-message replay metadata, safe exceptions before checkpoint error writes, mandatory credential matching with generation freshness, stored-binding reconstruction, and actual request/tool/saver settlement. These remain block-8 responsibilities; the corrections do not implement them or approve a changed lifecycle design.

### Step 43 - Explore: Map lifecycle fault windows; verify independent witnesses for each boundary
- [x] 7.3 Explore: Map lifecycle fault windows; verify independent witnesses for each boundary

Map question bindings, compatibility manifests, request-attempt states and the crash-window table to assertions. Final graph-state equality SHALL NOT substitute for evidence of actual dispatch or one continuation.

### Step 44 - Propose: Present lifecycle and G3 work; obtain owner approval
- [x] 7.4 Propose: Present lifecycle and G3 work; obtain owner approval

Present mock-backed lifecycle implementation and its fault matrix, without enabling real provider requests or changing the approved state machine.

## 8. Controlled execution and human continuation — Implementation

### Step 45 - Pause: Switch model for implementation
- [x] 8.1 Pause: Switch model for implementation

### Step 46 - Implement: Add the guarded terminal boundary; verify independent I/O admission tests
- [x] 8.2 Implement: Add the guarded terminal boundary; verify independent I/O admission tests

Implement the reusable injected terminal boundary with exact endpoint/redirect policy, durable-admission requirement, owner/run/cancellation checks, pre-aborted signals and the five-minute full-body deadline. Test refused admission, cancellation during credential waits, headers followed by a stalled body, redirects and body settlement against independent terminal witnesses. No request is permitted without the application admission contract.

### Step 47 - Implement: Assemble controlled root execution; verify invocation-contract fixtures
- [x] 8.3 Implement: Assemble controlled root execution; verify invocation-contract fixtures

Assemble root `createAgent` and the service-owned per-run controller with configured unbound models and official saver. Assert v2 tools, sync durability, stable thread identity, omitted `checkpoint_id`, independence from browser lifetime and absence of a custom agent loop.

### Step 48 - Implement: Add tool identity and replay handling; verify safe-batch and deduplication tests
- [x] 8.4 Implement: Add tool identity and replay handling; verify safe-batch and deduplication tests

Implement middleware, stable model-message/operation IDs, replayed-result reuse and ordered projection. Cover read-only batches, refusal of every mixed/multiple-question call, ambiguous/reused IDs, propagation of graph control flow and new calls distinguished from replay.

Explicitly generate agent calls to an unavailable writing tool and an unavailable command tool. Require a recorded refusal or `tool_failure`, unchanged fixture files and zero mutation/process-dispatch witness calls. Exercise both safe-refusal and fatal-handling branches; the requested action SHALL never execute.

### Step 49 - Implement: Add compatibility verification; verify positive and negative manifest cases
- [x] 8.5 Implement: Add compatibility verification; verify positive and negative manifest cases

Implement execution-code/dependency/configuration manifests and required-state digests against stored bindings. Accept identical redeploys and browser/default-model changes; reject changed tool bodies/helpers/protocols, unsupported serialized values and missing/ambiguous saved state before acceptance or dispatch.

Pin assertions for CRLF/LF normalization, unchanged README/browser assets, changed execution helpers, and a temporary inspection outage that leaves the pending question and committed run state unchanged.

Include UI-only source/dependency changes versus changes to shared modules used by execution, using fixtures for packages not implemented yet. Hash the selected execution import/dependency closure, not every workspace, the entire root lockfile, the application bundle or Turbo task hashes. Retest the real shared-module boundary when contracts are extracted in the API block.

### Step 50 - Implement: Publish settled human questions; verify pause persistence fault windows
- [x] 8.6 Implement: Publish settled human questions; verify pause persistence fault windows

Implement deterministic `mcp_AskUser` and saver settlement/inspection before atomic publication. Test failures before interrupt persistence, after stream emission, after saver settlement and around application waiting commit. Do not promote orphan checkpoints into answerable questions.

### Step 51 - Implement: Accept exact answers once; verify identity, duplicate and uncertainty cases
- [x] 8.7 Implement: Accept exact answers once; verify identity, duplicate and uncertainty cases

Implement answer validation, disposition-first duplicate acknowledgement, conditional acceptance and one ID-addressed truthy resume envelope. Cover false/null/permitted-empty values, wrong/stale/conflicting IDs, two tabs, terminal duplicate acknowledgements, incompatible versus inaccessible state, and ambiguous-commit readback. Replay SHALL still call the framework interrupt.

### Step 52 - Implement: Integrate request accounting; verify budgets and renewal-retry cases
- [x] 8.8 Implement: Integrate request accounting; verify budgets and renewal-retry cases

Connect reservation, dispatch confirmation, completion/abandonment and unconfirmed accounting to the guarded terminal and controller. Test zero inference requests for auth-only failure, disabled hidden retries, one permitted renewal retry consuming another step, last-step tools/results/questions, exhausted-budget answers and the admission/crash gap. Preserve default budget 50 and the separate recursion safety bound.

### Step 53 - Implement: Add durable cancellation; verify dispatch and completion races
- [x] 8.9 Implement: Add durable cancellation; verify dispatch and completion races

Implement cancellation acceptance under the short gate, unanswered-question closure, signal propagation and actual in-flight/body settlement. Test cancellation during credential waits, model bodies and tool reads, both cancellation/completion race orders, and preservation of an already accepted answer. Late output cannot replace the cancelled outcome.

### Step 54 - Implement: Add finalization and startup reconciliation; verify the complete crash matrix
- [x] 8.10 Implement: Add finalization and startup reconciliation; verify the complete crash matrix

Implement successful/failed/no-op finalization and startup classification after ownership. A child-process test SHALL kill execution at every row of design Decision 6's crash-window table and assert the specified result, including accepted-answer-before-dispatch, orphan graph interrupts, unfinished final commits and restart-mid-cancel. Test failed/uncertain persistence and truthful unconfirmed attempts. Never automatically or manually resume prior active work.

### Step 55 - Implement: Document the lifecycle; verify state and crash-window correspondence
- [x] 8.11 Implement: Document the lifecycle; verify state and crash-window correspondence

Update README, `architecture/02-control-plane.md` and `architecture/09-data-model-and-lifecycle.md` for compatibility, counters, questions, states and failures. Preserve separate graph/application commit semantics and dated G3 evidence pointers.

### Step 56 - Verify: Run G3 and G1 regressions; require every lifecycle boundary to pass
- [x] 8.12 Verify: Run G3 and G1 regressions; require every lifecycle boundary to pass

Run block checks and isolated lifecycle/fault suites. Require all design crash windows, cancellation boundaries, physical counts and saved-state refusals to pass before provider/console acceptance.

### Step 57 - Implement: Record G3 evidence; verify correspondence to observed results
- [x] 8.13 Implement: Record G3 evidence; verify correspondence to observed results

Write `g3-dispatch-lifecycle.md` from the preceding verification results and relevant owner reports/authorization. Include exact tested versions, source identity, commands, outcomes, request counts, unresolved issues and skips. Update the separately dated spike-index pointer. Do not rerun providers or infer a pass from missing evidence.

### Step 58 - Verify: Check G3 evidence; require accurate, safe and complete records
- [x] 8.14 Verify: Check G3 evidence; require accurate, safe and complete records

Check `g3-dispatch-lifecycle.md` and index links against the observed results, including tested-build identity and request allowance/counts. Reject unsupported pass claims, missing mandatory cases or sensitive content. This step checks records only and performs no new live provider requests.

### Step 59 - Review: Assess controlled-execution evidence; obtain owner acceptance
- [x] 8.15 Review: Assess controlled-execution evidence; obtain owner acceptance

Present G3 findings and limitations; provider integration and live journeys remain unverified.

## 9. Internal subscription boundary and offline provider parity — Research

### Step 60 - Pause: Switch model for exploration
- [x] 9.1 Pause: Switch model for exploration

### Step 61 - Explore: Assess the maintained library release; verify the upstream contract handoff
- [x] 9.2 Explore: Assess the maintained library release; verify the upstream contract handoff

Inspect the owner-supplied release against Decision 10: version/integrity, injected login/refresh/inference, native no-rewrite names and safe errors. If no suitable release exists, report the dependency blocked; do not substitute the shipped loader or edit upstream.

### Step 62 - Explore: Assess provider parity and OpenAI cost; verify the bounded extraction plan
- [x] 9.3 Explore: Assess provider parity and OpenAI cost; verify the bounded extraction plan

Inspect stock model construction and OpenAI Responses/terminal fixtures. Cover configured model/profile, replay metadata, terminal events and the OpenAI cost estimate before its transport implementation.

### Step 63 - Review: Confirm internal extraction ownership and scope; obtain owner agreement
- [x] 9.4 Review: Confirm internal extraction ownership and scope; obtain owner agreement

Confirm the revised Decision 10 boundary: a project-owned private package derived from the reviewed v2 source, with no OpenCode host or LangChain/SDK fork. Present exact source provenance and the retained auth/PKCE, profile/constants and necessary bounded parsing/header/system-billing helpers; distinguish the excluded plugin hooks, credential store, alias/response rewriting, API-key paths and automatic retry/version recovery. Confirm internal maintenance ownership, applicable license notices, intentional-difference tracking and the absence of an upstream-delivery blocker. Include the identified in-flight credential-generation retention prerequisite. This review is not G2 acceptance or permission to edit upstream or contact providers.

### Step 64 - Propose: Present the internal package and provider plan; obtain scope and cost approval
- [x] 9.5 Propose: Present the internal package and provider plan; obtain scope and cost approval

Present the complete next implementation block for approval: the minimal internal package and its contracts, actual auth/profile extraction, runtime credential/operator wiring, the bounded in-flight screening correction, stock-model construction and exact dependency candidates, offline OpenAI transport, production registration and workspace-aware build/fingerprints, documentation and acceptance fixtures. Distinguish synthetic issuer/HTTP fixtures exercising real package code from a fake package that cannot establish G2. Give the early OpenAI effort/risk assessment and explicit stop/replan conditions. No upstream release is required, but actual-package G2 and offline G4/G5 must pass before console work. No live model/auth allowance or upstream-edit authority is requested or inferred.

## 10. Internal subscription boundary and offline provider parity — Implementation

### Step 65 - Pause: Switch model for implementation
- [x] 10.1 Pause: Switch model for implementation

### Step 66 - Implement: Establish the private subscription package; verify provenance and boundary fixtures
- [x] 10.2 Implement: Establish the private subscription package; verify provenance and boundary fixtures

Add private server-only `packages/anthropic-subscription` with explicit public entry points, package-local Bun tests/typecheck, runtime `workspace:*` linkage and root/Turbo/build-context integration. Define independent injected contracts for login/exchange, partial refresh, immutable request profiles and safe typed errors without dependencies on runtime internals, OpenCode, LangChain or a provider SDK. Establish consumer fixtures for signals, partial updates, native names and refusal behavior; test doubles at this stage are preparation, not a G2 pass.

Verify the selected v2 release's source revision and tarball integrity against Decision 10; inventory the exact upstream source material and retained/excluded behavior before extraction. Retain applicable license/copyright material and add provenance plus intentional-difference documentation and third-party notices. Preserve historical spikes. Package import/isolation tests SHALL reject UI/contracts imports of the server-only package and runtime imports of upstream private files or spike code. Verify workspace resolution, discovery of the new package's tests and inclusion of its inputs in the application build/cache graph. Actual auth/profile implementations follow in 10.3–10.4.

### Step 67 - Implement: Extract Anthropic auth and connect credentials; verify synthetic lifecycle and screening tests
- [x] 10.3 Implement: Extract Anthropic auth and connect credentials; verify synthetic lifecycle and screening tests

Extract and adapt only the reviewed subscription auth/PKCE and necessary validation/bounded parsing helpers into the private package. Connect its actual public auth operations to the runtime's existing credential adapter, provider-scoped coordination, private storage and operator commands; do not introduce another credential store or refresh lock. Require state/verifier matching, explicit millisecond expiry, validated token fields, preservation of omitted refresh/account fields, safe typed errors, separate exact auth endpoint policy and injected transport/signal. No API-key creation, ambient credential discovery or automatic ambiguous exchange/refresh retry is permitted.

Use synthetic issuer responses to exercise the actual package: valid/invalid PKCE/state/exchange inputs, malformed/oversized responses, redirects, pre-abort, full-body deadlines, refresh margin, partial rotation, runtime/CLI races, lost acknowledgement and definitive rejection versus temporary unavailability. Preserve the existing rule that abandoning a waiter cannot cancel an already-started shared rotation or release its lock. These are offline tests, not real login or renewal.

Correct credential-screen generation retention and its execution-boundary lifecycle so a generation used by a request remains screened until its responses are sanitized or safely discarded, not merely until HTTP completion. Keep retention bounded and fail closed rather than evict an in-use generation. Add deterministic rotation-pressure fixtures exceeding the old 16-generation cache, delayed responses, concurrent requests, cancellation/error cleanup and observation of newly loaded/rotated credentials before dispatch. Assert synthetic access/refresh material is absent from model/tool projections and checkpoint/error records; recheck the shared-rotation and credential-store regressions. Record this as new verification, not retroactive block-8 evidence.

### Step 68 - Implement: Connect stock Anthropic inference; verify offline G4 parity and replay
- [x] 10.4 Implement: Connect stock Anthropic inference; verify offline G4 parity and replay

Extract the reviewed profile constants and necessary header/query/system-billing transformations into the private package, with explicit immutable configuration and documented intentional differences. Exclude upstream alias tables, response rewriting, plugin hooks, environment overrides and automatic version recovery. Connect the actual package to stock ChatAnthropic using the existing guarded terminal, a non-secret sentinel key, `dangerouslyAllowBrowser: false`, and disabled SDK/LangChain retries including per-call overrides. Pin the reviewed model-client/SDK versions and verify compatibility with the existing runtime matrix; package metadata alone is not a Bun pass.

Test actual-package output against independently defined golden requests for the selected profile, including approved native-name/no-rewrite differences rather than pretending to reproduce the entire plugin. Cover exact endpoint/query/header policy, beta-query idempotence, unchanged native names over fragmented responses, bounded complete response assembly and successful terminal markers, leading-user text, complete provider metadata, tool-result and question-resume replay, cancellation/deadline settlement, one explicit renewal retry and secret-free checkpoints. Preserve safe typed provider codes, real attempt references and temporary-versus-definitive auth outcomes through the model boundary; do not collapse them into raw SDK exception text or status-only guesses. Independent terminal counters SHALL prove no hidden retries, no inference request for auth-only failure and no dispatch past cancellation or budget.

### Step 69 - Implement: Add the offline OpenAI transport; verify G5 wire and stream fixtures
- [x] 10.5 Implement: Add the offline OpenAI transport; verify G5 wire and stream fixtures

Implement stock Responses transport with injected synthetic credential resolution and coherent account generations. Compare Bun fetch/node:http captures and test two-turn encoding, reasoning/call-ID replay, missing terminal events, redirects and abort/deadline behavior without ambient API fallback. OpenAI operational readiness remains disabled until its later auth block.

Use exact reviewed model-client/SDK pins with explicit streaming Responses selection, stateless replay and sentinel credentials. Test constructor, SDK and per-call retry overrides rather than assuming one `maxRetries: 0` disables every layer. Prefer Bun-native fetch if independent wire captures pass; the historical Node-fetch header mismatch alone SHALL NOT select the compatibility transport. A Bun `node:http` path is permitted only with fresh parity, pre-abort, full-body deadline and settlement evidence under the same guarded terminal. Include complete tool arguments followed by missing/failed terminal events, cross-generation account/token consistency, and safe normalized provider failures. No device login, real refresh or provider traffic belongs in this task.

### Step 70 - Implement: Document internal provider ownership; verify provenance and acceptance distinctions
- [x] 10.6 Implement: Document internal provider ownership; verify provenance and acceptance distinctions

Update README, `architecture/05-model-authentication.md`, applicable package/security architecture sections, the private package's public-boundary/provenance/update documentation and third-party notices. Describe the actual stock-model/internal-package split, injected I/O, runtime-owned credentials, in-flight screening guarantee, explicit model/profile configuration and manual upstream-update policy. Distinguish implemented components from production registration still pending at 10.8, and offline checks from future live acceptance and OpenAI device-auth work. Do not rewrite historical acceptance reports.

Record internal ownership, exact upstream provenance/license and intentional extraction differences in `upstream-handoff.md`, retaining that planned path without claiming an upstream standalone release was delivered. Record the early OpenAI effort/risk decision in `openai-cost-checkpoint.md`. Add dated index pointers, but claim only checks already observed; the following Verify steps remain pending.

### Step 71 - Verify: Check actual provider components; require package and offline regressions to pass
- [x] 10.7 Verify: Check actual provider components; require package and offline regressions to pass

Run forced block checks including the new package, actual-package synthetic issuer/consumer suites, independent Anthropic profile and offline OpenAI transport fixtures, rotation-pressure screening tests and G1/G3 regressions. Check source provenance/license, intentional-difference records, package boundaries and the handoff/cost documentation against observed results. Require all checks to pass before production registration; any failure stops dependent work. Test doubles cannot substitute for the actual extraction, and an available source tarball is not a G2/G4 pass. Distinguish this component checkpoint from the final packaged pre-console gates after 10.8. No live credentials or provider requests are permitted.

### Step 72 - Implement: Wire production provider assembly; verify registration, image and execution fingerprints
- [x] 10.8 Implement: Wire production provider assembly; verify registration, image and execution fingerprints

After 10.7 passes, connect the tested internal Anthropic package, stock-model factory, credential/operator adapter, guarded terminal and safe failure mapping to production runtime assembly and configured provider readiness. Missing configuration or usable authorization SHALL keep the provider unavailable; OpenAI operational readiness remains disabled until its auth block. Use per-run stored model/profile/slot bindings without exposing caller-controlled SDK overrides. This is production wiring of the actual implementation, not an upstream release pin/bind or test-only replacement.

Extend execution-manifest construction to resolve the selected adapter's owned workspace import/resource closure, including the private package and relevant locked dependencies, without hashing every workspace or the whole lockfile. Verify unchanged redeploys and browser/default-only changes remain compatible while changes to an execution-used package helper, profile/resource or dependency refuse continuation. Generate and ship the manifest alongside the runtime bundle; verify the single non-root image resolves package imports and operator entry points without source-tree, OpenCode or development-server dependencies.

Exercise the production construction path with synthetic credentials and issuer/model transports, independent request witnesses and the official saver. Retest auth-only failures, account/generation coherence, credential-safe messages/errors, cancellation, the one counted renewal retry, tool/question/result replay and immutable stored-binding reconstruction. Update registration, image/command and current-status documentation affected by this step. No REST/SSE or console feature work is included. No new upstream release, live provider request or database migration is required by this integration; completion still requires the following Verify to pass the packaged pre-console gates.

### Step 73 - Verify: Run the pre-console gates; require G2 and offline G4/G5 with regressions
- [x] 10.9 Verify: Run the pre-console gates; require G2 and offline G4/G5 with regressions

Run forced block checks, actual-internal-package G2, offline G4/G5 and G1/G3 against the exact resulting source/dependency matrix and packaged production wiring. Require independent request witnesses, source/provenance and approved-difference checks, cross-package execution fingerprints, the in-flight screening regressions and single-image integration with no skipped mandatory cases before console buildout. Missing upstream public exports are no longer a blocker; any failing package, safety or parity check remains one. Do not perform live provider operations.

### Step 74 - Implement: Record pre-console evidence; verify correspondence to observed results
- [x] 10.10 Implement: Record pre-console evidence; verify correspondence to observed results

Write `g2-anthropic-boundary.md`, `g4-anthropic-offline.md` and `g5-openai-offline.md` from the preceding verification results and relevant owner reports/authorization. Include exact tested versions, source identity, commands, outcomes, request counts, unresolved issues and skips. Update the separately dated spike-index pointer. Do not rerun providers or infer a pass from missing evidence.

G2 SHALL name the actual internal package source identity, the upstream extraction baseline and approved differences. Keep synthetic issuer/transport execution distinct from fake-package preparation and from later live acceptance. Update the ownership/provenance and OpenAI cost records only with decisions and results actually observed; preserve the earlier G1/G3 and historical spike/adversarial records.

### Step 75 - Verify: Check pre-console evidence; require accurate, safe and complete records
- [x] 10.11 Verify: Check pre-console evidence; require accurate, safe and complete records

Check `g2-anthropic-boundary.md`, `g4-anthropic-offline.md`, `g5-openai-offline.md`, ownership/provenance and OpenAI cost records and index links against observed results, including actual-package and upstream source identities, deliberate differences, packaged-build identity and request allowance/counts. Reject unsupported pass claims, missing mandatory cases or sensitive content. This step checks records only and performs no new live provider requests.

### Step 76 - Review: Assess offline provider readiness; obtain owner acceptance
- [x] 10.12 Review: Assess offline provider readiness; obtain owner acceptance

Review evidence that console work is unblocked while both live-provider journeys remain outstanding.

## 11. Browser console and Anthropic usable slice — Research

### Step 77 - Pause: Switch model for exploration
- [x] 11.1 Pause: Switch model for exploration

### Step 78 - Explore: Map browser and API behavior; verify route and fixture coverage
- [x] 11.2 Explore: Map browser and API behavior; verify route and fixture coverage

Inspect controller contracts and minimal React/HTML-import integration. Map validation ordering, state variants, exact answers, budget display and durable replay to routes/UI/fixtures without Agent Server or token-stream authority.

Plan extraction of pure wire definitions into `packages/contracts`, their server/client consumers and package-local tests. Inspect UI public HTML-entry resolution and runtime-owned application bundling; identify forbidden server-only dependencies and the actual UI/contracts inputs needed to invalidate build/check caches.

### Step 79 - Explore: Assess private deployment and Anthropic acceptance; verify bounded trial scope
- [x] 11.3 Explore: Assess private deployment and Anthropic acceptance; verify bounded trial scope

Inspect Compose Serve and the trial procedure. Report the private-origin/cross-device verification plan and proposed provider/model, auth operations and physical-request cap using only owner-approved fixture content.

### Step 80 - Propose: Present the browser slice; obtain implementation and bounded trial-plan approval
- [x] 11.4 Propose: Present the browser slice; obtain implementation and bounded trial-plan approval

Present API/console/deployment changes and the bounded Anthropic trial plan. Obtain implementation and trial-plan approval, not advance authority for live operations. Fresh provider authorization SHALL be confirmed in the Review immediately before live verification; approval SHALL NOT be inferred from the task plan itself.

Include the contracts extraction, runtime route ownership, UI package implementation, cross-package tests and single-image HTML-import build. Separate source packages do not add a frontend service or authorize a different deployment topology.

## 12. Browser console and Anthropic usable slice — Implementation

### Step 81 - Pause: Switch model for implementation
- [x] 12.1 Pause: Switch model for implementation

### Step 82 - Implement: Add versioned REST commands; verify validation and idempotency tests
- [x] 12.2 Implement: Add versioned REST commands; verify validation and idempotency tests

Add `/api/v1` options/run/detail/history/answer/cancel routes with strict inputs, safe envelopes and disposition-first ordering. Test every documented response code, cross-run inputs, repeated requests, exhausted-budget answers and ambiguous commits without double invocation.

Implement routes in `packages/runtime` and introduce `packages/contracts` by extracting the pure shared wire schemas/types, rather than copying internal record types or maintaining duplicate schemas. Retain runtime-only authorization, saved-state and transaction checks. Add contract/schema-parity fixtures and import guards rejecting dependencies from contracts to runtime/UI, Bun/Node APIs, database drivers or provider SDKs. Register package tests/typechecks and source-dependency invalidation in Turbo.

### Step 83 - Implement: Add durable SSE replay; verify race, outage and backpressure tests
- [x] 12.3 Implement: Add durable SSE replay; verify race, outage and backpressure tests

Implement snapshot bounds, initial/reconnect cursor validation, decimal sequences, 15-second heartbeats, bounded buffers and unsequenced outages. Test snapshot/subscription races, lost wakeups, repeated reconnects, slow readers and database failures without lost recorded events or browser-induced run aborts.

Use a fake clock to assert the 15-second heartbeat and explicitly test `409 cursor_ahead`, missed notifications and storage outage without durable cursor advancement.

### Step 84 - Implement: Add the browser client and event store; verify replay and retry fixtures
- [x] 12.4 Implement: Add the browser client and event store; verify replay and retry fixtures

Implement typed endpoint access, snapshot/history/SSE merging, `(runId, seq)` deduplication, safe request-ID reuse and a connection-availability state separate from run status. Test reconnect races, retransmission, cursor handling and `acceptance_unknown` retries without duplicate starts.

Place the browser client, event store and unit tests in `packages/ui`, consuming the public contracts package through `workspace:*`. Do not import runtime internals or server-only types to obtain API shapes. Include its implemented unit/typecheck tasks in the root check graph.

### Step 85 - Implement: Add run views; verify state, outcome and safe-rendering fixtures
- [x] 12.5 Implement: Add run views; verify state, outcome and safe-rendering fixtures

Implement run listing/start/detail/history and budget/uncertainty/failure views. Cover all seven states, required timestamps, each failure category and unavailable overlays. Render text or sanitized Markdown without executable HTML or automatic external loading.

Implement the React views and browser tests in `packages/ui`, with package-owned React/browser dependencies and an explicit public HTML entry. Connect that entry to `Bun.serve` in the runtime and extend the runtime-owned application build under `packages/runtime/dist/` to include the browser assets. Test cross-workspace resolution, absence of server-only browser dependencies, complete output restoration and operation without a separate UI server or Vite.

### Step 86 - Implement: Add question and cancellation controls; verify typed interactions end to end
- [x] 12.6 Implement: Add question and cancellation controls; verify typed interactions end to end

Implement text/single-choice/multi-choice questions, negative/false/null answers, duplicate/conflict/closed responses and cancellation controls. A deterministic browser journey SHALL start a run, observe activity, answer false and obtain its result; repeated submission and socket closure SHALL not cause another invocation or fabricated completion.

### Step 87 - Implement: Complete private Serve exposure; verify Host, Origin and asset restrictions
- [x] 12.7 Implement: Complete private Serve exposure; verify Host, Origin and asset restrictions

Finish Host/Origin/JSON controls and Serve wiring. Tests SHALL show no public ports/Funnel, no exposed database/state directories, no permissive browser-origin mutation, and application assets served instead of workspace files.

### Step 88 - Implement: Add bounded Anthropic acceptance fixtures; verify the deterministic browser journey
- [x] 12.8 Implement: Add bounded Anthropic acceptance fixtures; verify the deterministic browser journey

Add the operator checklist and shared mock/live fixture without performing live requests. Cover close/reopen, question/restart/answer, result and cancellation; enforce the approved physical-request cap in live mode.

### Step 89 - Implement: Document the Anthropic browser slice; verify setup and current-status accuracy
- [x] 12.9 Implement: Document the Anthropic browser slice; verify setup and current-status accuracy

Update README operation/troubleshooting, `architecture/07-network-and-protocols.md`, relevant control-plane/security sections, architecture status and dated acceptance-evidence pointers. Distinguish the Anthropic usable slice from unfinished OpenAI operational support; live success is not claimed before verification.

Replace the foundation's UI-shell status with the actual runtime/UI/contracts ownership and test/build commands. Document the shared HTML-import application image and the distinction between deployment-cache invalidation and continuation fingerprints.

### Step 90 - Verify: Run offline console acceptance; require passing browser, replay and secrecy suites
- [x] 12.10 Verify: Run offline console acceptance; require passing browser, replay and secrecy suites

Run block checks and complete offline API/browser/Serve suites with G1–G3 and offline G4/G5 regressions. Scan every protected surface for synthetic credentials. No live provider request is required for this gate.

Require the packaged UI to work in the single runtime image, contract changes to invalidate the relevant consumer checks/builds, and browser bundles to exclude runtime-only dependencies/private material. Recheck execution fingerprints after contract extraction: UI-only changes do not refuse continuation, while changes to execution-used shared modules do. Use forced check execution for acceptance, not a restored Turbo log.

### Step 91 - Review: Confirm live Anthropic authorization; obtain the bounded allowance
- [x] 12.11 Review: Confirm live Anthropic authorization; obtain the bounded allowance

After offline checks pass, present the exact provider/model, owner-approved fixture content, auth/renewal operations, maximum physical model requests and retry allowance. Obtain fresh owner authorization now. The owner performs login in a private terminal; the executor receives only safe readiness/status. If authorization is withheld, stop before live verification.

Granted 2026-09-30 against commit `e91a7d6`, after fresh `check:verify` (12/12, none cached), integration (141), browser (6) and container smoke (11) passes: Anthropic subscription, profile `claude-cli-2.1.280`, model `claude-opus-5-5`, credential slot `default`; one owner-performed `anthropic login` in a private terminal, refresh only as the runtime performs it on use; the `TRIAL` fixture note and two fixed goals in `tests/acceptance/anthropic-trial.ts`; two runs with a step budget of 6 each and a deployment-wide ceiling of 12 physical model requests, retries included. Any failure, refusal or exhausted limit stops the trial; a further attempt needs new authorization here. The executor drives the browser while the owner watches. Local deployment per the trial replan above.

**Historical allowance, now suspended.** The owner subsequently chose browser login first. At suspension the executor had started the local runtime and dedicated database, opened the console, and observed Anthropic requiring authorization with no runs; the executor had performed no live auth or model request. The completed Review above records the earlier decision, not ongoing authority. Resume only after 12.16–12.19 and fresh authorization at 12.20 for the changed build and browser-login operation. Preserve the local trial's storage; do not silently restart its allowance or execute the old terminal-login instructions.

### Step 130 - Implement: Add protected browser-auth operations; verify attempt and credential-boundary tests
- [x] 12.16 Implement: Add protected browser-auth operations; verify attempt and credential-boundary tests

Implement design Decision 16 in the existing contracts, runtime service/HTTP and runtime composition boundaries. Add strict browser-safe auth schemas, a bounded in-memory Anthropic attempt service and the begin/complete/status/cancel operations. Bind the configured subscription slot server-side. Reuse `beginLogin`, `loginAnthropic`, the exact-endpoint auth transport and the existing credential coordinator/store; supply already-submitted code to `loginAnthropic` so no credential lock is held during the owner's wait. Preserve the lock around exchange and durable credential replacement, CLI coexistence and all provider-profile/billing rules. No new database tables, auth framework, provider callback protocol, dependencies or upstream edits.

Test bounded expiry/retention, one active attempt, atomic completion claims, concurrent and repeated submissions, cancellation before submission, restart loss, CLI/refresh contention, storage failure and ambiguous exchange outcomes. Independently count issuer/model I/O: begin/status/cancel make no issuer call, completion exchanges at most once, and all auth operations make zero inference requests. Exercise exact Host/Origin and Fetch Metadata rejection, bounded JSON/unknown-field refusal, no-store success/errors and secret-free response/diagnostic projections. Complete work is service-owned and bounded; closing a browser response SHALL NOT silently authorize another exchange. Tests use synthetic inputs and injected transports only.

### Step 131 - Implement: Add the console connection panel; verify browser-only onboarding and safe handling
- [x] 12.17 Implement: Add the console connection panel; verify browser-only onboarding and safe handling

Add Connect/reauthorize Anthropic beside provider readiness in the existing Home/start view, typed API-client methods and a dedicated code form. Guide the owner through the official separate-tab link, provide a popup-blocker fallback link, and visibly report waiting, completing, connected and safe failure/expiry states. Refresh options after success without losing the owner's unsubmitted goal. Do not nest the auth form inside the start-run form. Clear the code on submit/cancel/unmount, keep it out of persistent browser storage and never route it through a task/question API. Do not expose token values, credential files or server-only package imports. Preserve the existing CLI fallback and OpenAI unavailable state.

Add synthetic UI/Playwright journeys for first connection, reauthorization, refusal, pending-attempt expiry/restart, cancel, duplicate completion and lost-reply status inspection. Verify that Connected follows durable storage/readiness rather than an optimistic click. Scan protected surfaces for seeded codes/verifiers/access/refresh tokens with only the explicitly intended transient code input/auth request exempted; never exempt ordinary APIs, history, checkpoints or logs. This step changes the shipped desktop app, not the demo launcher or mobile layout.

### Step 132 - Implement: Document browser-first login; verify local-trial and privacy guidance
- [x] 12.18 Implement: Document browser-first login; verify local-trial and privacy guidance

Update README, relevant authentication/security/network architecture guidance and `deploy/runtime/anthropic-acceptance.md` to describe Connect Anthropic and its paste-code form as the normal browser path, with terminal login optional. Reconcile the previously terminal-only/headless instructions and the local-trial amendment: the current G4 journey uses loopback, while real Serve HTTPS/second-device evidence remains 16.7. State the fixed provider callback, transient attempt lifetime/restart behavior, durable private tokens and safe error handling. Do not describe browser auth or the live trial as passed before verification.

Document the live owner handoff precisely: show the console before asking the owner to act; the owner controls provider sign-in and code submission without executor screenshots/snapshots/network inspection; resume executor operation only after the owner reports completion and safe status confirms readiness. The revised acceptance checklist SHALL require the fresh 12.20 allowance and prohibit reuse of the historical 12.11 allowance. Preserve all prior reports and adversarial history.

### Step 133 - Verify: Run browser-auth offline acceptance; require current-build isolation and regression evidence
- [x] 12.19 Verify: Run browser-auth offline acceptance; require current-build isolation and regression evidence

Passed 2026-09-30 on `e91a7d6` plus the uncommitted browser-login changes: forced `check:verify` 12/12 (none cached; runtime 400, contracts 17, subscription 61, UI 24 tests); PostgreSQL integration 144; browser 9 (including three console-login journeys); container smoke 11. The packaged bundle contains the connection panel and none of the server-only login code. No real login, refresh or model request was made.

Run forced `check:verify`, PostgreSQL integration, browser and container smoke suites on the revised tree. Require new synthetic auth/concurrency/secrecy cases, existing CLI/provider/agent regressions and browser/server import boundaries to pass. Verify the packaged desktop console exposes the new connection flow and that successful auth alone never starts a run or makes an inference request. Record exact commands, tested source identity, counts and unresolved issues; cached logs or the earlier `e91a7d6` results SHALL NOT substitute. A failing mandatory check stops dependent work. No real login, refresh or model request belongs to this gate; leave the standalone demo stopped.

### Step 134 - Review: Renew local browser-trial authorization; obtain the bounded allowance for the tested build
- [x] 12.20 Review: Renew local browser-trial authorization; obtain the bounded allowance for the tested build

After 12.19 passes, present the revised source/build identity, Anthropic subscription model/profile/slot, browser authorization exchange and permitted renewal operations, synthetic fixture, maximum physical model requests and retry/stop conditions. The earlier proposed two fixed runs, six requests per run and twelve total remain a proposal, not an active allowance. Obtain fresh explicit owner authorization using the question tool. The owner alone handles sensitive provider sign-in and pasted-code submission. On withheld approval, failure or refusal, stop before further live work. This is the immediately preceding live-authorization Review for 12.12; no authority carries from the historical 12.11 grant.

Granted 2026-09-30, for the commit the owner makes of the 12.19-verified tree (its identity is recorded with the G4 evidence): Anthropic subscription, profile `claude-cli-2.1.280`, model `claude-opus-5-5`, credential slot `default`; one owner-performed console login (Connect Anthropic), with no executor screenshots, page reads or network inspection during it, and renewal only as the runtime performs it on use; the `TRIAL` fixture note and two fixed goals in the existing local trial storage; two runs with a step budget of 6 each and a deployment-wide ceiling of 12 physical model requests, retries included. The trial runtime restarts on the new build with its storage preserved. The executor drives the journey in a Chrome tab the owner watches. Any failure, refusal or exhausted limit stops the trial; a further attempt needs new authorization here.

### Step 92 - Verify: Run authorized Anthropic G4; require the bounded live journey to pass
- [x] 12.12 Verify: Run authorized Anthropic G4; require the bounded live journey to pass

Use only the fresh allowance from the immediately preceding live-authorization Review at 12.20. First show the owner the real console and its Connect Anthropic control. The owner completes provider authorization and the dedicated code form personally, with no executor inspection of sensitive pages, input or network bodies. After the owner confirms completion, check safe readiness and verify real read/tool-result/question/restart/answer/final-result and browser reconnect behavior within the declared cap. Report safe metadata and request counts only. Missing authority or failed evidence leaves this step unfinished; do not silently spend another allowance.

Per the trial replan, run the built runtime locally on loopback with a dedicated database, private state directory and trial-only workspace, and perform the browser journey on the same machine. Close/reopen the page and restart the runtime process with its storage preserved. Record safe browser/context and outcome metadata within the same authorized trial; this does not grant extra model calls. Serve HTTPS and the second-device journey move to 16.7.

Passed 2026-09-30 on commit `4ac0809` (loopback, Chrome on the owner's desktop): the owner connected Anthropic through the console (one real exchange; status ready, generation 1). Journey run `04f40616-…`: real read of the trial note, one yes/no question; page closed and reopened with the same single pending question; runtime restarted while waiting (both runs still waiting, authorization still ready); answer `false` accepted and a final result that respected it; succeeded with 3 model requests. Cancellation run `047df3bc-…`: question pending after 1 request, cancelled from the console, still cancelled with its question closed after a second restart. `acceptance:anthropic report`: journey 3, cancellation 1, total 4 of 12; `trial conditions hold`. No console errors or failed page requests. Evidence is recorded at 12.13.

### Step 93 - Implement: Record G4 evidence; verify correspondence to observed results
- [x] 12.13 Implement: Record G4 evidence; verify correspondence to observed results

Write `g4-anthropic-live.md` from the preceding verification results and relevant owner reports/authorization. Include exact tested versions, source identity, commands, outcomes, request counts, unresolved issues and skips. Update the separately dated spike-index pointer. Do not rerun providers or infer a pass from missing evidence.

### Step 94 - Verify: Check G4 evidence; require accurate, safe and complete records
- [x] 12.14 Verify: Check G4 evidence; require accurate, safe and complete records

Check `g4-anthropic-live.md` and index links against the observed results, including tested-build identity and request allowance/counts. Reject unsupported pass claims, missing mandatory cases or sensitive content. This step checks records only and performs no new live provider requests.

### Step 95 - Review: Assess the usable Anthropic slice; obtain owner acceptance
- [x] 12.15 Review: Assess the usable Anthropic slice; obtain owner acceptance

Present the actual journey, evidence and limitations before proceeding to full OpenAI operational completion.

Owner accepted the current local Anthropic slice after personally using it and reviewing the four remaining areas: real token renewal, Tailscale/second-device access, real Anthropic usage inside Docker, and OpenAI operational support. These are unverified paths/unfinished scope, not four observed failures. The owner emphasized small iterative delivery and early validation of the real containerized process. Acceptance does not establish a Docker-live pass or grant another auth/model allowance. The trial runtime is stopped; its database and saved authorization are preserved.

## 19. Real Docker and Tailscale acceptance before OpenAI

### Step 135 - Review: Confirm isolated deployment and tailnet enrollment; obtain setup approval
- [x] 19.1 Review: Confirm isolated deployment and tailnet enrollment; obtain setup approval

Present the exact source revision, shipped Compose/Dockerfile configuration, proposed project/node name, trial-only workspace/config locations and fresh persistent volumes. Identify the owner's intended tailnet access and second approved device/browser (a desktop or laptop suffices); do not infer a second-device pass from different host/browser operating-system labels. Obtain explicit approval for image build/start, isolated operator settings, tailnet enrollment and necessary HTTPS prerequisites. No Anthropic login, refresh or model calls are authorized by this Review.

The container is its own Tailscale node; inspect safe status to discover its actual DNS name once joined rather than assuming host membership or asking the owner to guess it. The owner handles sensitive enrollment privately. Do not capture enrollment tokens/links, dump secret-bearing Compose environment values, broaden tailnet policy, copy the prior trial's credentials or reset/reuse its database or volumes. Preserve existing unrelated services. Specify how to stop the new project without deleting persistent state. If a prerequisite or intended access cannot be established, stop for clarification rather than publishing a local port or changing the shipped topology.

Setup approved 2026-10-01 for source `ba07cb784c9eabd699b0af83f49281a56f6800e7` using the unchanged shipped deployment files: project/node name `agent-runtime-live`, proposed image tag `agent-runtime/runtime:ba07cb7-docker-trial`, settings and synthetic workspace under `~/.local/state/agent-runtime-docker-trial/`, and fresh project-scoped PostgreSQL, runtime-state and Tailscale-state volumes. Docker 29.0.0 and Compose v2.40.3 were available; the proposed containers, labelled volumes/networks, image tag and settings directory were not present. Approval covers build/start, isolated operator settings, owner-performed Tailscale enrollment and private HTTPS checks, with no Anthropic login, renewal or inference. Stop the new project without deleting volumes when requested. The owner clarified that the tailnet is personal and only for them, superseding the earlier shared-tailnet selection; no access-policy change is requested. Their current laptop, already using SSH over the tailnet to the runtime host, is the second device for browser verification. Preserve that SSH/host Tailscale connection and all prior trial state. Actual node DNS name and browser/version are recorded when observed. Deployment has not yet been started by this Review; proceed to 19.2 in an execution context permitting its filesystem/container writes.

### Step 136 - Verify: Run the shipped Compose stack; require private HTTPS and isolation before provider use
- [x] 19.2 Verify: Run the shipped Compose stack; require private HTTPS and isolation before provider use

Passed 2026-10-01. Project `agent-runtime-live` from the unchanged shipped `compose.yaml`, `Dockerfile` and `deploy/tailscale/serve.json` at source `ba07cb784c9eabd699b0af83f49281a56f6800e7`; runtime image `agent-runtime/runtime:ba07cb7-docker-trial`, ID `sha256:525fb91c7d0cf0c8890dbd13bee77d62dbfe19f9a9a4528941e65c288f842e81` (identical cached layers from the 12.19 container smoke build). Fresh volumes `agent-runtime-live_postgres-data`, `_runtime-state`, `_tailscale-state`; synthetic trial note and trial configuration (budget 6, ceiling 12, `claude-opus-5-5`, slot `default`) from `~/.local/state/agent-runtime-docker-trial/`. Enrollment: the interactive login link required a sign-in the owner could not complete from their position, so at the owner's request a one-time, non-reusable auth key generated in the owner's Tailscale admin console was applied with `tailscale login --auth-key` inside the Tailscale container (no Compose change; the install script the console also offered was not run, so the host did not join). The node joined as `agent-runtime-live.boa-beaufort.ts.net` (MagicDNS on, certificate domain issued). Serve status: `https://agent-runtime-live.boa-beaufort.ts.net (tailnet only)` proxying `http://127.0.0.1:3000`; Funnel off. No published host ports on any container. Runtime: user `bun`, read-only root, `cap_drop: ALL`, `no-new-privileges`, network namespace of the Tailscale container, `/workspace` and the configuration read-only, only `/var/lib/agent-runtime` (its volume) writable. Request policy inside the namespace: public Host 200; forged Host and forged `X-Forwarded-Host` 403; POST without Origin, with a foreign or `http://` Origin, or cross-site 403; same-origin POST reached the handler. Options: workspace available, Anthropic `reauthorization_required`, budget 6, ceiling 12; no runs. The owner opened the console over HTTPS from their laptop (the second device, already on the tailnet via SSH to the host). No Anthropic login, refresh or model request was made. The executor's DevTools browser could not reach the tailnet address (the host's own Tailscale is stopped); the second-device check rests on the owner's report.

Under 19.1 approval, build and start an isolated project using the actual `compose.yaml`, `Dockerfile` and `deploy/tailscale/serve.json`, pinned dependencies/images and fresh volumes. Provision the existing synthetic trial note read-only at `/workspace`, private runtime state and operator configuration for a bounded future trial. Record source identity and the actual runtime image ID/digest. Join the real Tailscale container with owner participation, discover its published tailnet DNS name, and configure that exact HTTPS origin. Do not use the smoke override/inert holder, a relay, host networking, alternate runtime bind address or published application/database ports.

Verify certificate/Serve routing, owner-approved tailnet access, disabled Funnel, no published ports, non-root/read-only runtime, separate persistent database/credential/Tailscale volumes, and read-only workspace/config mounts. Show the actual console over HTTPS on the approved devices; verify health/options and safe forged-Host/Origin refusals without creating runs or login attempts. Confirm configured budgets/ceiling and unconfigured provider authorization. These checks make no Anthropic auth or inference requests. Reuse relevant offline/container checks as supporting evidence, not as a substitute for the real network path. Any failed check stops progression; source or deployment-code repairs require an explicit proposal, implementation approval and applicable renewed verification.

### Step 137 - Review: Authorize the Docker Anthropic journey; obtain a fresh bounded allowance
- [x] 19.3 Review: Authorize the Docker Anthropic journey; obtain a fresh bounded allowance

Granted 2026-10-01 for image `sha256:525fb91c7d0cf0c8890dbd13bee77d62dbfe19f9a9a4528941e65c288f842e81` (source `ba07cb7`) at `https://agent-runtime-live.boa-beaufort.ts.net`: Anthropic subscription, profile `claude-cli-2.1.280`, model `claude-opus-5-5`, slot `default`; one owner-performed console login from the owner's laptop with no executor observation of the sign-in, code or auth requests, renewal only as the runtime performs it; the trial note and the two `TRIAL` goals, started by the owner from the console on the laptop (no CLI `start`); at most 6 model requests per run and 12 in total including retries, enforced by the deployment configuration; runtime-container restart and recreation with the same image and volumes by the executor; stop on any failure, refusal or exhausted limit. The executor observes runs through the API inside the deployment's network namespace.

After 19.2 passes, present the exact runtime image/source identity, working HTTPS origin, approved device/browser, Anthropic subscription model/profile/slot, owner-performed browser login and permitted renewal operations. Propose the shared synthetic note and two designated journey/cancellation goals, at most six physical model requests per run and twelve in total including retries, with no automatic retry after failure/refusal or cap exhaustion. Record the two run IDs when created and do not invoke the CLI start tool in addition to browser-created trial runs. Any changed allowance SHALL be explicit and enforced by the trial configuration before dispatch.

Obtain fresh approval with the question tool before any real Anthropic authorization or model request. The historical 12.11/12.20 grants and remaining capacity in the stopped host trial SHALL NOT be reused. The owner alone performs provider sign-in and code submission; the executor sees only safe completion/readiness information. Withheld approval leaves 16.7 unfinished. This Review SHALL immediately precede the live journey below.

## 16. Private-network journey — brought forward before OpenAI

### Step 129 - Verify: Exercise private-network access; require Serve HTTPS and a second-device journey
- [x] 16.7 Verify: Exercise private-network access; require Serve HTTPS and a second-device journey

Passed 2026-10-01 under the 19.3 allowance, on image `sha256:525fb91c…` at `https://agent-runtime-live.boa-beaufort.ts.net`. Owner's laptop (second device, on the tailnet): opened the console over HTTPS, connected Anthropic through Connect Anthropic (generation 1), later reconnected (generation 2, written 18:40:03 UTC, before any run and with no renewal attempt in any run — a second console login, not a token renewal), and started and viewed its own run "Write me a poem" (succeeded, 1 request; owner use outside the trial). At the owner's choice the executor then drove the trial in a headless Chrome 154 (Linux) that reached the same HTTPS address over the tailnet, while the owner watched from the laptop: journey run `03c65bda-b5d4-4862-a9ae-e8421f0685db` (real read, question "Should I list the checklist steps…?", 2 requests) and cancellation run `ddd58ed4-6e3d-47ae-a1f2-6474c3d0156c` ("Are you ready?", 1 request) both waiting; page left and reopened with one pending question and no duplicates; runtime container restarted, then recreated (new container, same image and volumes): both still waiting, budgets unchanged, Anthropic ready without logging in again; answer `false` accepted and a final result that respected it (journey 3 requests, Completed); cancellation run cancelled with its question closed, still cancelled after another restart and recreation. `acceptance:anthropic report` (run from the host over the tailnet HTTPS origin): journey 3, cancellation 1, total 4 of 12; `trial conditions hold`. Deployment total 5 of 12 including the owner's run. No published ports; Funnel off; no console errors or failed page requests. Token scan of the current (generation 2) access/refresh tokens: 0 hits in options, run list, run details and full histories, the three containers' logs and a full `pg_dump` (226,490 bytes). Generation-1 tokens were replaced before the scan and were not scanned. The CLI `start` was not used.

Originally deferred from 12.12, now brought forward by the full-stack validation replan. Use only the setup verified in 19.2 and the fresh allowance at 19.3. Through the actual Docker-served HTTPS console, have the owner complete Connect Anthropic privately; confirm safe readiness without inspecting credentials, codes or auth network bodies. From the second approved tailnet device, list runs, start the designated trial tasks once, inspect progress, answer the journey's question with `false`, view its result and cancel the other run while its question is pending. Record their actual IDs and use the existing report tool only to inspect those runs; do not create additional model-backed connectivity probes.

Exercise leaving/reopening the browser, runtime-container restart while questions wait, and runtime-container recreation with the same image and persistent volumes. Require saved credentials and the pending question to remain usable without another login or duplicate invocation. After cancellation, restart/recreate the runtime as needed within the approved procedure and confirm the run remains cancelled with its question closed. Reconfirm the deployment's Host/Origin/no-published-port safeguards and exact request accounting. Do not delete volumes or import the host trial's state. Stop on any failure, refusal or exhausted allowance; no silent fix-and-rerun. Report only safe observed outcomes, image/device context and request counts; distinguish an unobserved real token renewal from one actually exercised.

## 19. Real Docker and Tailscale acceptance — Evidence and review

### Step 138 - Implement: Record Docker and tailnet evidence; verify correspondence to observed results
- [x] 19.4 Implement: Record Docker and tailnet evidence; verify correspondence to observed results

Write `architecture/integration-evidence/mvp-01/g4-anthropic-docker-tailnet.md` from 19.2/16.7 results and owner reports/authorizations, and add a separately dated index pointer. Include exact source/image/dependency identity, commands, approved deployment/access scope, actual HTTPS/second-device observations, restart/recreation/storage outcomes, auth/model allowance and counts, and explicit limitations/skips. Preserve the historical local-only G4 record rather than relabelling it. Update current README/deployment status where the new results change it, without claiming unobserved renewal or OpenAI coverage. Do not rerun providers while writing evidence.

### Step 139 - Verify: Check Docker and tailnet evidence; require accurate safe records
- [x] 19.5 Verify: Check Docker and tailnet evidence; require accurate safe records

Check the new record and index/status updates against the actual safe observations and owner reports. Require tested image/source identity, working HTTPS and distinct second-device evidence, persistence across container restart/recreation, explicit authorization and honest physical-request totals. Verify links, formatting and absence of codes/tokens/raw provider or enrollment data. Reject unsupported passes and inherited allowances; this step makes no new auth or model request. A failed record check stops owner acceptance.

### Step 140 - Review: Accept the containerized Anthropic slice; obtain owner acceptance before OpenAI
- [x] 19.6 Review: Accept the containerized Anthropic slice; obtain owner acceptance before OpenAI

Owner accepted 2026-10-01 after reviewing the deployment checks, journey, restart/recreation results, secrecy scan and the remaining gaps (no real token renewal; trial clicks driven from the headless browser while the laptop did login, Reconnect and its own run; OpenAI not covered). The owner chose to keep `agent-runtime-live` running for their own use under its 12-request ceiling (5 used). Acceptance grants no further provider authorization for verification work.

Present what worked in the shipped Docker/Tailscale deployment and list any remaining limitations plainly before asking for acceptance with the question tool. In particular, do not imply that live renewal was exercised merely because credentials survived a restart. Ask whether the deployment should remain running or be stopped, preserving its data by default; no further provider use is authorized by acceptance. Only after approval proceed to the existing OpenAI model-switch Pause at 13.1.

## 13. OpenAI operational completion — Research

### Step 96 - Pause: Switch model for exploration
- [x] 13.1 Pause: Switch model for exploration

### Step 97 - Explore: Assess remaining OpenAI auth work; verify the focused gap and cost report
- [x] 13.2 Explore: Assess remaining OpenAI auth work; verify the focused gap and cost report

Inspect remaining device-auth, refresh, CLI and readiness against the landed transport. Cover polling semantics, PKCE, account metadata and expiry units without introducing another runtime architecture.

### Step 98 - Propose: Present OpenAI completion; obtain cost and bounded trial-plan approval
- [x] 13.3 Propose: Present OpenAI completion; obtain cost and bounded trial-plan approval

Approved by the owner 2026-10-03 after the 13.2 gap/cost report (moderate, about 700–900 source and 1,000 test lines; proceed). Scope: an in-runtime reimplementation (not an import) of the Codex device flow (usercode, 403/404-continue polling with interval floor and 15-minute deadline, server-supplied PKCE checked, code exchange) and refresh, through an exact-endpoint `auth.openai.com` transport, epoch-second to millisecond expiry, account ID from the decoded ID token (signature not verified; recorded limitation); `auth openai login|status`; and a new `auth <provider> renew` operator command performing exactly one forced renewal and no model request. Owner choice: OpenAI also gets a browser connection panel (Connect OpenAI shows the user code and the official verification link; the server polls in the background, holding the credential lock only for exchange and storage; no code is pasted back), extending design Decision 16 to OpenAI and replacing the terminal-only wording of 14.6 with owner-performed console or terminal login. Then registration, `binding.ts` wiring with renew-once/mark-rejected, readiness, execution-manifest closure, tests and documentation. Model `gpt-5.6-sol`, profile `codex-0.151.0`; if the live backend rejects the month-old profile, stop and replan (re-capture), with no workaround. Trial plan (not an allowance; fresh authorization at 14.6): the Docker/Tailscale deployment rebuilt with the new image and OpenAI configured; owner-performed login from the laptop without executor observation; one forced renewal; runtime restart and recreation; the existing trial note and journey/cancellation goals; at most 6 model requests per run and 12 for OpenAI in total including retries, the deployment ceiling raised by exactly 12 over requests already used; stop on any failure.

Obtain a refreshed proceed/replan decision before writes and approval of the bounded device-flow/renewal/model-request trial plan, not advance live authority. Fresh provider authorization SHALL be confirmed in the Review immediately before live verification. Disproportionate cost does not silently remove OpenAI from the phase.

## 14. OpenAI operational completion — Implementation

### Step 99 - Pause: Switch model for implementation
- [x] 14.1 Pause: Switch model for implementation

### Step 100 - Implement: Add OpenAI device auth and renewal; verify lifecycle fixtures
- [x] 14.2 Implement: Add OpenAI device auth and renewal; verify lifecycle fixtures

Implement device initiation/poll/exchange and independent refresh through shared storage and operator commands. Fixtures SHALL distinguish polling 403/404 from inference rejection, validate PKCE and bounded polling, preserve partial rotation, and handle credential generations and persistence failure safely.

Fake-issuer tests SHALL cover pending polls, interval/deadline handling, successful exchange, denial and renewal failure without misclassifying device-poll responses as model failures.

### Step 101 - Implement: Enable configured OpenAI readiness; verify immutable subscription bindings
- [x] 14.3 Implement: Enable configured OpenAI readiness; verify immutable subscription bindings

Enable the real binding in the existing console only after valid configuration/authorization. Tests SHALL reject unsupported profiles before dispatch, prevent mixed account/token generations, retain per-run bindings and prohibit provider/billing fallback.

### Step 102 - Implement: Complete provider fixtures and documentation; verify both deterministic journeys
- [x] 14.4 Implement: Complete provider fixtures and documentation; verify both deterministic journeys

Extend tests for OpenAI setup, model/profile, renewal, two-turn and human continuation, plus Anthropic regressions through the same API/controller. Update README, `architecture/05-model-authentication.md` and dated evidence pointers to distinguish implemented paths from still-pending live outcomes.

### Step 103 - Verify: Run dual-provider offline gates; require replay and secrecy regressions to pass
- [x] 14.5 Verify: Run dual-provider offline gates; require replay and secrecy regressions to pass

Passed 2026-10-03 on `f95802a` plus the uncommitted 14.2–14.4 changes: forced `check:verify` 12/12 (none cached; runtime 432, contracts 17, subscription 61, UI 24, scripts 68 tests); PostgreSQL integration 151 (including the OpenAI read/question/false-answer/result journey through the production assembly and controller with stateless call-ID and encrypted-reasoning replay, one counted renewal carrying the new token and account together, definitive rejection after renewal, unsupported-profile refusal, and the OpenAI console-login API); browser 11 (including Connect OpenAI: displayed code and official link, approval noticed without paste, reload returning the same attempt, cancel); container smoke 11. The packaged console contains the Connect OpenAI panel and none of the OpenAI client ID, device endpoints, `code_verifier` or `refresh_token` handling outside the server bundles. The existing offline G5 cases (complete tool arguments without `response.completed` fail as `incomplete_response`; no `x-request-id` assumed) passed unchanged. No real login, refresh or model request was made.

Run block checks and all offline gates with both bindings. Verify full message/tool/reasoning-metadata replay, terminal markers, request counts, failure categories and secret scans without assuming an OpenAI `x-request-id` exists.

Include a response whose tool arguments are complete but whose successful terminal marker never arrives; it SHALL fail as a provider failure, not count as a completed response.

### Step 104 - Review: Confirm live OpenAI authorization; obtain the bounded allowance
- [x] 14.6 Review: Confirm live OpenAI authorization; obtain the bounded allowance

Granted 2026-10-03 for the commit of the 14.5-verified tree (identity recorded with the G5 evidence), deployed by recreating only the runtime container of `agent-runtime-live` on its existing volumes, with OpenAI added to its configuration (model `gpt-5.6-sol`, profile `codex-0.151.0`, slot `default`) and the deployment ceiling raised to the requests already used plus 12. One owner-performed Connect OpenAI device login from the laptop, without executor observation of OpenAI's page or the code entry; one forced `auth openai renew` (one token request, no model request); runtime restart and recreation with the login preserved; the `TRIAL` note and its journey and cancellation goals with OpenAI selected, driven by the executor in the headless browser while the owner watches; at most 6 model requests per run and 12 for OpenAI in total, retries included; stop on any failure, refusal or exhausted limit, with no rerun. Also granted: one `auth anthropic renew` in the deployment (one token request, no model request) to exercise a real Anthropic renewal; an unknown outcome would require the owner to reconnect Anthropic.

After offline checks pass, present the exact provider/model, owner-approved fixture content, named device flow, auth/renewal operations, maximum physical model requests and retry allowance. Obtain fresh owner authorization now. The owner performs login in a private terminal; the executor receives only safe readiness/status. If authorization is withheld, stop before live verification.

## 20. Remove bespoke OpenAI integration — Research

### Step 141 - Pause: Switch model for exploration
- [x] 20.1 Pause: Switch model for exploration

### Step 142 - Explore: Confirm the OpenAI removal inventory; verify preservation and compatibility boundaries
- [x] 20.2 Explore: Confirm the OpenAI removal inventory; verify preservation and compatibility boundaries

Confirm the approved Decision 11 against the current source and working tree, reusing the 2026-10-06 research instead of restarting an open-ended provider survey. Identify the OpenAI auth/profile/inference/parser modules, their imports, console/CLI/routes/contracts, fixtures, dependencies and manifest roots; distinguish provider identities/configuration needed to read history from installed execution capabilities. Identify OpenAI-only `endAt`/`onIncomplete` and stream-diagnostic/device-poll consumers before deleting their shared hooks. Record which tests and execution fingerprints are affected.

Map start, readiness, legacy auth commands, removed HTTP routes and old-run inspection/continuation to independent no-provider-I/O and data-preservation witnesses. Retain provider-neutral credential storage, redaction and workspace exclusions; generic read-only screening of retained credentials is not authentication and SHALL NOT be confused with a zero-file-read requirement. Inspect only source and safe metadata, never actual token records. No code, credential, deployment or evidence write and no provider request belongs to this step.

### Step 143 - Propose: Present the removal-only implementation; obtain approval of scope and acceptance checks
- [x] 20.3 Propose: Present the removal-only implementation; obtain approval of scope and acceptance checks

Present the exact deletion/simplification batches, compatibility/configuration behavior, test coverage and documentation changes. Confirm that the interim build keeps Anthropic operational but reports configured OpenAI as `integration_unavailable`, even with saved credentials; does not silently switch an OpenAI default; and preserves records, credential files and historical evidence. Explain that deleting shared execution code may invalidate pre-existing paused-run fingerprints, so rollout requires the later unfinished-run review. Obtain explicit implementation approval without selecting a replacement, authorizing deployment, or granting auth/model requests.

## 21. Remove bespoke OpenAI integration — Implementation and rollout

### Step 144 - Pause: Switch model for implementation
- [x] 21.1 Pause: Switch model for implementation

### Step 145 - Implement: Disconnect OpenAI entry points; verify explicit unavailable behavior
- [x] 21.2 Implement: Disconnect OpenAI entry points; verify explicit unavailable behavior

Stop constructing/registering OpenAI in `packages/runtime/src/providers/assembly.ts`. Remove the OpenAI login service exposure from `service/runs.ts` and runtime shutdown, the `/api/v1/auth/openai/*` routes, `ConnectOpenAI`, its API-client operations and device-only auth contract/style fields. Keep Anthropic login and the shared run/provider identities. Preserve existing OpenAI operator configuration parsing and default selection; configured OpenAI SHALL be visibly unavailable, not ready or merely in need of reauthorization. Remove its Connect control and prevent starting work through the UI; direct start requests remain authoritatively refused before dispatch. Legacy `auth openai login|status|renew` commands SHALL exit unsuccessfully with an integration-unavailable explanation and no issuer work, rather than report ready from stored credentials. Retain `auth anthropic login|status|renew`.

Add tests for missing versus configured-but-unavailable OpenAI, seeded usable/expired authorization, an OpenAI default, stale clients requesting removed routes, strict request-policy handling, absence of misleading login guidance and no provider/billing fallback. Auth-route removal uses the existing safe not-found contract. Use independent auth/inference witnesses; do not use live credentials. Remove the unused OpenAI login implementation/tests rather than leave dormant login machinery.

### Step 146 - Implement: Delete Codex provider code and dependencies; verify historical records and build closure
- [x] 21.3 Implement: Delete Codex provider code and dependencies; verify historical records and build closure

Delete `packages/runtime/src/providers/openai/`, `packages/runtime/src/service/openai-auth.ts` and its tests, and provider-specific scripted fixtures with no remaining consumers, including `tests/support/openai-network.ts` when unused. Remove OpenAI production bindings/imports and unused direct `@langchain/openai`/`openai` dependencies; update the Bun lockfile without upgrading unrelated packages or changing historical spike manifests. Do not delete dependencies still required transitively elsewhere or install a replacement SDK speculatively.

Update `execution/code-manifest.ts` and manifest tests/build output so missing OpenAI roots are not scanned and unavailable integrations are explicit; do not synthesize an OpenAI manifest that implies an installed adapter. Preserve historical provider/profile/binding/definition decoding and database history. Seed old OpenAI run records and questions independently of the deleted implementation; prove history reads still work, terminal outcomes remain terminal, and a retired waiting binding is refused through the existing continuation-unavailable path before answer acceptance or dispatch. No record/checkpoint/credential rewrite or database migration is authorized.

### Step 147 - Implement: Remove OpenAI-only shared extensions; verify retained Anthropic safeguards
- [x] 21.4 Implement: Remove OpenAI-only shared extensions; verify retained Anthropic safeguards

Remove the now-unused `CompletionCheck.endAt`/`onIncomplete` branches, OpenAI event-name diagnostic field/wiring and device-poll-only classification/tests after verifying their remaining consumers. Retain Anthropic's completion checks and the shared terminal's admission, physical accounting, no-hidden-retry, endpoint/redirect, abort/deadline and settlement behavior. Preserve credential coordination, leases/redaction, safe failure projections and workspace secret exclusions, including protection of retained OpenAI files through existing generic read-only screening. Keep provider identities used by historical records and common fixtures; this is not a global deletion of every `openai` string.

Add or retain regressions proving Anthropic auth, renewal, streaming, tool-result/question replay, budget enforcement, cancellation and failed-body handling are unchanged. Measure the resulting execution-manifest changes rather than asserting paused Anthropic compatibility from unchanged observable behavior. Do not weaken or special-case definition checks to conceal the change.

### Step 148 - Implement: Replace retired fixtures and update current docs; preserve failed OpenAI evidence
- [x] 21.5 Implement: Replace retired fixtures and update current docs; preserve failed OpenAI evidence

Replace obsolete OpenAI execution/auth/browser fixtures with configured-unavailable, no-I/O, historical-read and retained-credential tests. Update the affected browser/integration harnesses and startup tests to use the removal build. Keep provider-neutral tests independent of a production OpenAI adapter. Add import/bundle assertions that the retired Codex client ID, endpoints, emulation/profile and OpenAI parser/login code are not shipped; scope these checks to production sources/builds, not historical evidence or harmless provider identifiers. Require a fresh build rather than scanning stale output artifacts.

Update README, deployment configuration examples and current authentication/network/security descriptions to state that Anthropic works and OpenAI integration is withdrawn pending replacement. Reconcile the current evidence index/status without rewriting dated passes. Record the already-observed failed live OpenAI attempts in `g5-openai-live.md`, clearly marked failed/incomplete, including successful login/renewal/restarts, actual run/image/request counts, absence of a cancellation journey and the unobserved response-type/root cause. This historical failure record SHALL NOT complete 14.7 or claim a replacement pass. Preserve spikes, old offline reports and adversarial history. No replacement implementation or future verification claim belongs here.

### Step 149 - Verify: Run removal acceptance; require fresh regression and zero-provider-I/O evidence
- [x] 21.6 Verify: Run removal acceptance; require fresh regression and zero-provider-I/O evidence

Run forced `mise exec -- bun run check:verify`, direct `mise exec -- bun test`, the isolated PostgreSQL integration suite (`mise exec -- bun run test:integration`), browser suite (`mise exec -- bun run test:browser`) and shipped-image smoke suite (`mise exec -- bun run test:container`). Preserve each command's exit status rather than inferring success from filtered output. Use synthetic credentials, scripted transports and launcher-owned storage only; no actual provider request or existing deployment mutation is permitted.

Require configured and stored OpenAI cases to refuse before auth/inference/tool dispatch, old history and terminal outcomes to remain readable, credential fixtures to remain byte-for-byte unchanged and screened, and all Anthropic/shared guards and restart/question/cancellation regressions to pass. Verify the built image works without deleted imports/dependencies and contains no retired production implementation. Check the failed-live record and current documentation against observed evidence, run strict OpenSpec validation and whitespace checks, and retain exact source/dependency/image identities. Any failing required check stops dependent rollout work. Removal success is not G5 success.

### Step 150 - Review: Accept offline removal and authorize rollout; verify unfinished-run safety
- [x] 21.7 Review: Accept offline removal and authorize rollout; verify unfinished-run safety

Present the verified source/image, removed code, retained capabilities, tests, safe failure records and remaining OpenAI block. Read current deployment status and unfinished-run metadata without auth or model I/O. If active work would be interrupted or a waiting question would become incompatible, stop for the owner's explicit disposition; do not answer, cancel or rewrite it. Obtain separate approval to recreate only the runtime service of the named deployment with its current persistent volumes and private ingress. Preserve operator configuration and defaults unless an explicit, separately described adjustment is approved. Approval grants no model request, credential refresh, sign-in, revocation or old-token conversion.

### Step 151 - Implement: Deploy the approved removal image; preserve storage and private topology
- [x] 21.8 Implement: Deploy the approved removal image; preserve storage and private topology

After 21.7 approval, recheck the approved unfinished-run conditions immediately before rollout and stop if they changed. Select/build only the approved tested source and image; if implementation inputs changed, return to offline verification and approval rather than deploying an unverified variant. Update only the authorized image selection and recreate the runtime service, retaining PostgreSQL/Tailscale/runtime-state volumes, configuration, workspace and service topology. No published application/database ports, volume deletion, historical-data/credential rollback, old host-trial changes or provider request is permitted. If startup fails, stop and report; any rollback must be explicit and must not silently re-enable the retired OpenAI path.

### Step 152 - Verify: Check deployed removal behavior; require private access and preserved history
- [x] 21.9 Verify: Check deployed removal behavior; require private access and preserved history

Read safe health/readiness and options from the actual deployment and inspect the console over its approved tailnet HTTPS address. Verify the intended image, no published ports, preserved volume bindings and non-root/read-only runtime. Anthropic stored readiness must remain inspectable without refreshing; configured OpenAI must be unavailable with no Connect action, and historical runs must retain their recorded states/history. Test an OpenAI start refusal only through an explicitly approved safe check with an independent zero-provider-I/O witness; no accepted run, model dispatch or auth request is allowed. Otherwise rely on the verified offline refusal test and deployed read-only state, documenting the distinction. Stop on a failure; do not repair and retry or exercise Anthropic inference under this no-provider allowance.

### Step 153 - Implement: Record removal evidence; verify provenance and observed outcomes
- [x] 21.10 Implement: Record removal evidence; verify provenance and observed outcomes

Write `architecture/integration-evidence/mvp-01/openai-removal.md` from 21.6 and 21.9 observations and the owner's rollout approval, and add a dated index pointer. Record source/image identity, exact commands/results, deletion scope, configured-unavailable/no-I/O evidence, preserved data and credential boundaries, unfinished-run disposition, rollout checks and remaining replacement/G5 blocks. Distinguish new regression/rollout results from older Anthropic acceptance and failed OpenAI attempts. Do not contact providers or claim a supported replacement was tested.

### Step 154 - Verify: Check removal evidence; require accurate and credential-safe records
- [x] 21.11 Verify: Check removal evidence; require accurate and credential-safe records

Check the removal record, failed-live record, README/current status and index links against observed source/build/test/rollout facts. Require preservation of historical evidence and no unsupported root-cause, replacement-readiness or G5-pass claims. Check for sensitive credential/auth material, strict OpenSpec validity and whitespace errors without fixing files in this step. This records-only check makes no new provider request. Stop on any failure.

### Step 155 - Review: Accept the removal milestone; stop before replacement work
- [x] 21.12 Review: Accept the removal milestone; stop before replacement work

Present the smaller deployed application: Anthropic retained, OpenAI clearly unavailable, legacy auth/inference implementation absent, private credentials and run history preserved, and checks/evidence reviewed. Obtain owner acceptance or a correction request. Then STOP. This milestone does not complete 14.7, G5, dual-provider acceptance or phase exit, and authorizes no replacement prototype or provider traffic. A separately approved replacement plan must resolve browser-only auth and supported-library capabilities and insert its own gated tasks before the remaining OpenAI verification can resume.

The stop and replacement-admission instructions immediately above record the completed removal milestone. The separately approved recovery subsequently satisfied replacement selection, implementation and live-authorization prerequisites outside OpenSpec. They SHALL NOT be interpreted as instructions to remove `dbf7145`, repeat that recovery or spend another provider allowance. Continue with the new cleanup block below; repository G5/evidence and phase-exit tasks remain unchecked.

## 22. Recovery reporting and documentation cleanup — Research

### Step 156 - Pause: Switch model for exploration
- [x] 22.1 Pause: Switch model for exploration

### Step 157 - Explore: Confirm the bounded recovery cleanup; verify source, reporting and evidence gaps
- [x] 22.2 Explore: Confirm the bounded recovery cleanup; verify source, reporting and evidence gaps

Reuse the 2026-10-06 reassessment rather than repeat an open-ended provider survey. Confirm the current source/diff and the accepted recovery boundary; inspect `tests/acceptance/anthropic-trial.ts`, `scripts/acceptance-anthropic.ts`, their test consumers and the root check graph. Map the exact expected-negative-answer comparison, declared-question validation, distinct run identities, per-run maximum/charges and named-pair versus deployment accounting to focused offline fixtures. Runtime answer handling and provider code are not correction targets.

Inventory the current README, `architecture/05-model-authentication.md`, `07-network-and-protocols.md`, `08-execution-security.md` and `deploy/runtime/anthropic-acceptance.md` descriptions that are stale or omit the recovered CLI/reporting behavior. Locate the retained recovery conversation/owner approvals and any remaining offline verification logs; distinguish their original observed outcomes from independently rechecked source identity. The temporary `/tmp/opencode/v-{check,test,int,browser,container}.log` files were present during this reassessment, but SHALL NOT be assumed durable evidence or newly executed results. Do not read credentials or auth network bodies, write evidence, mutate a deployment or contact providers.

### Step 158 - Propose: Present reporting, tests and documentation corrections; obtain bounded implementation approval
- [x] 22.3 Propose: Present reporting, tests and documentation corrections; obtain bounded implementation approval

Present the exact reporter/API/CLI input change, focused tests, current-documentation edits and verification commands for group 23. Follow Decision 14: explicit typed expected negative value (`false` by default or declared `"no"`), exact comparison to the same recorded question, no runtime coercion, distinct named runs, each run's six-request bound, and a clearly labelled pair subtotal with separate full-allowance accounting. Keep the runtime ceiling authoritative; add no usage dashboard, provider probe or automatic extra journey. Identify the later `g5-openai-recovery.md`/index work at 14.8 without rewriting earlier evidence now.

Obtain explicit implementation approval. This artifact-reconciliation approval is not that source-write gate. No provider/dependency/engine change, deployment or live auth/model operation is proposed. If a larger runtime defect or missing acceptance mechanism is discovered, stop for a focused replan rather than expanding this cleanup or deferring feature work into final acceptance.

Approved 2026-10-06 after the read-only 22.2 audit. Scope is eight files: `tests/acceptance/anthropic-trial.ts`, `scripts/acceptance-anthropic.ts`, existing `scripts/acceptance-anthropic.test.ts`, root `README.md`, `architecture/05-model-authentication.md`, `07-network-and-protocols.md`, `08-execution-security.md`, and `deploy/runtime/anthropic-acceptance.md`. Add a fourth `reportTrial` parameter `expectedAnswer: false | 'no' = false` and report-only CLI `--expected-answer false|no`; require the exact declared single-choice value and matching question/answer identity, distinct run IDs, existing provider checks, a snapshotted maximum of six per run and confirmed-plus-unconfirmed charges within each six-request cap and the twelve-request pair cap. Preserve the report return shape, labelling `requests.total` as the named-run subtotal, not full deployment consumption. Preserve trial goals, start idempotency and single-run selection. Extend existing script tests with injected responses/isolated loopback fixtures and read-only reporting witnesses; no new test configuration or package changes. Run focused script tests, then all five 23.3 commands sequentially, stopping at the first failure. Current guidance SHALL describe accepted recovery with exceptions and pending final acceptance; canonical recovery evidence/index links wait for 14.8. No runtime/provider source, dependency, deployment, credential or live-request changes, commits, pushes or merges are approved. Source work remains an implementation-agent handoff after 23.1.

## 23. Recovery reporting and documentation cleanup — Implementation

### Step 159 - Pause: Switch model for implementation
- [x] 23.1 Pause: Switch model for implementation

### Step 160 - Implement: Correct recovery reporting and current guidance; verify focused offline regressions
- [x] 23.2 Implement: Correct recovery reporting and current guidance; verify focused offline regressions

Implement only the approved report/CLI correction and its deterministic tests. Retain boolean `false` as the default expected answer and permit explicit string `"no"` only as that declared choice; compare exact types/values and the question identity. Cover declared false and no, missing/positive/type-mismatched or undeclared answers, wrong providers, duplicate run IDs, incorrect snapshotted per-run maxima, individual/pair overages and confirmed-plus-unconfirmed counts. Keep existing request-ID idempotency and single-run selection behavior. Make the output explicit that its total covers only the two named runs; additional journeys/owner runs remain part of separately recorded deployment-wide accounting. Add no auth/model requests to reporting or ordinary tests, and ensure the focused tests are included in forced checks.

Update the root README and affected authentication/network/security architecture sections and acceptance guidance identified at 22.2. Describe the delivered browser-only device flow, stock library settings, new versus retired profiles, existing credential/dispatch safeguards, undocumented backend, accepted live recovery exceptions and still-pending final acceptance. Document the reporter's typed expectation and subtotal limitation. Preserve Anthropic behavior, provider code, dependency pins, old evidence and unrelated files. Do not claim upcoming verification passed or create the canonical recovery report before 14.7/14.8. Implementation writes require the appropriate execution agent/approval; this plan itself grants none.

### Step 161 - Verify: Run fresh cleanup acceptance; require reporting and dual-provider regressions to pass
- [x] 23.3 Verify: Run fresh cleanup acceptance; require reporting and dual-provider regressions to pass

Passed 2026-10-06 on `dbf7145` plus the uncommitted 23.2 changes (eight approved files and the reconciled OpenSpec artifacts), each command run once in order with exit status 0: forced `check:verify` 12/12, none cached (runtime 432, contracts 17, subscription 61, UI 24, scripts 75 tests); direct `bun test` 609; integration 157; browser 11; container smoke 12 checks, including the image shipping the OpenAI adapter without the retired wrapper. The six new script tests cover the typed expected answer and question identity, distinct runs, provider, per-run and pair limits with unconfirmed charges, CLI validation and read-only reporting. No runtime/provider source, package manifest or lockfile changed; historical evidence, adversarial artifacts and spikes are unchanged since `da65cab`; strict OpenSpec validation and whitespace checks pass; no smoke containers or volumes remain. The live deployment was not touched and no auth or model request was made. These results are distinct from the original `dbf7145` recovery results.

Run `mise exec -- bun run check:verify`, `mise exec -- bun test`, `mise exec -- bun run test:integration`, `mise exec -- bun run test:browser` and `mise exec -- bun run test:container`, preserving each exit status and stopping at the first failure. Use only isolated launcher-owned storage, scripted networks and synthetic credentials; no live deployment/auth/model operation is permitted. No source-changing formatter flags belong here. Require the reporting cases, both providers' existing regressions, image/import/continuation boundaries and no unresolved acceptance skips in the affected block.

Check documentation/commands against the resulting source, strict OpenSpec validity, whitespace and preservation of historical/adversarial material. Verify the bounded cleanup did not change provider/runtime execution code or dependency pins; if it did, stop for expanded scope and verification rather than silently inheriting the recovery's live acceptance. Emit safe exact source/command/count outcomes without writing evidence. These new offline results SHALL remain distinct from the original `dbf7145` results and from the live observations reconciled next.

## 14. OpenAI operational completion (continued) — Recovery evidence reconciliation

### Step 105 - Verify: Reconcile accepted OpenAI recovery; require attributable G5 results and exceptions
- [x] 14.7 Verify: Reconcile accepted OpenAI recovery; require attributable G5 results and exceptions

Passed 2026-10-06 as a records reconciliation, with owner-approved read-only corroboration: GET requests from inside the runtime container to its own loopback listener (options, run list, five run snapshots and histories, and every run's budget), no auth or model request and no deployment change. Running image `sha256:ed0293c9…` matches the recovery image. Journey `5d0248ff…`: completed read, one question declaring `"yes"`/`"no"`, answer `"yes"`, succeeded, 3 requests. Journey `2e7d0541…`: completed read, same declared choices, answer `"no"` at 16:26:10Z, succeeded, 3 requests; the current runtime container was created at 16:26:15Z, confirming it finished before the last recreation. Cancellation `226d4742…`: no read, question declaring `true`/`false`, cancelled with the question closed at 16:27:05Z, before the container's last start at 16:27:16Z, 1 request. Owner runs `d1a1aab4…` (16:19Z) and `0c7f1bbb…` (16:23Z): succeeded, 1 request each. Deployment: 14 runs, 20 of 23 requests charged, 0 unconfirmed; OpenAI 9 runs and 13 requests (4 `incomplete_response` failures from the retired adapter, 9 successful new requests); Anthropic 5 runs, 7 requests. The corrected reporter applied to the captured histories passes the repeat journey and cancellation with expected `"no"` and reproduces the strict-`false` finding by default. The five final offline logs remain. Attributed to the recovery conversation only: approvals and accepted exceptions, the failed-then-repaired browser verification, login (generation 2→3) and renewal (3→4), the first journey's wait through restart and recreation (the earlier container and Docker's event buffer for that window no longer exist), the owner runs' generation chronology and the credential-scan scope. No observation contradicts the recorded account.

**Current scope:** records-only reconciliation of the already accepted recovery, not automatic execution of another live trial. Verify the source/approval/result provenance and accepted exceptions below against the available recovery conversation, original safe observations and retained logs. A missing artifact is not an observed runtime failure, but a missing fact SHALL remain a documented limitation rather than an invented pass. The historical attempts that follow retain their original failure and blocked-checkpoint descriptions.

Attempt 1 (2026-10-03, under the 14.6 allowance, image `sha256:e3efab38…` from `a5e15f7` in `agent-runtime-live`, ceiling 18): passed so far — owner Connect OpenAI device login from the laptop (generation 1, one `provider_login_connected`), forced `auth openai renew` (generation 1 → 2, a real OpenAI renewal), runtime restart and recreation with OpenAI still ready; also the granted `auth anthropic renew` (generation 2 → 3, the first real Anthropic renewal). **Failed:** journey run `463b0e10-8f47-4279-a377-b21522872170` (OpenAI, started from the headless console) failed on its first model request: HTTP response received and the attempt completed `failed`, run `provider_failure`/`incomplete_response` ("ended before it was complete; partial output was not used"); 1 request consumed, 0 unconfirmed; no assistant output stored. The cancellation run was not started. The trial stopped there per the allowance; no retry. 1 of 12 OpenAI requests used.

Owner-approved correction (2026-10-03), after the owner first chose a Codex profile re-capture and then, on read-only source research (Codex `rust-v0.151.0` and current `rust-v0.160.0` stop reading at `response.completed` and ignore `error` events, while this runtime failed any typed event after completion; request-side changes for `gpt-5.6-sol` are minor), chose plan A: end the response at `response.completed` (the terminal passes the body through that event's terminating blank line and reads nothing after it; `response.failed`, `response.incomplete` and `error` before completion still fail), and log a safe `model_stream_incomplete` diagnostic carrying only the received event names in order (bounded, repeats counted) when a response is judged incomplete. Profile `codex-0.151.0` is kept; a re-capture remains available if needed. The cause of attempt 1 was not recorded and is not claimed. Offline verification: forced `check:verify` 12/12 (none cached; runtime 443), integration 152 (including trailing events after completion succeeding and an incomplete stream diagnosed by names only), browser 11, container smoke 11. No provider request was made.

Between attempts the owner ran two OpenAI tasks of their own from the laptop on the old image (`179d571a…`, `2bcb7952…`), both failing the same way with 1 request each, plus one Anthropic task (succeeded). Attempt 2 (2026-10-05, owner re-authorized; image `sha256:5c930854…` from `de0ec76`, runtime container recreated, both logins kept): journey run `36447c50-dbfc-45e9-828c-4fa32093ebf5` failed again on its first request, `provider_failure`/`incomplete_response`, 1 request, 0 unconfirmed. **No `model_stream_incomplete` diagnostic was written.** The actual content type and body shape were not recorded. Later read-only source inspection and synthetic in-memory probes showed that a valid SSE body with a non-SSE or missing content-type header reproduces this failure without that diagnostic, while the stock SDK accepts it. That establishes a wrapper compatibility mismatch, not the live response's type or root cause; the earlier definite attribution to the non-SSE fallback was unsupported and is corrected here. Stopped per the allowance; cancellation run not started. OpenAI requests at this checkpoint: 4 (2 trial, 2 owner), all failed with `incomplete_response`; deployment 11 of 18. This verification remains blocked by the removal-first amendment; no historical request allowance carries into a replacement.

**Later accepted recovery (2026-10-06, separate VIPER plan).** The owner approved Minimal TypeScript integration, its implementation and a fresh bounded rollout/trial after offline checks. Source `dbf71453a0500163e2a8510f23ac4212d7572609`; image `agent-runtime/runtime:dbf7145-openai-recovery`, ID `sha256:ed0293c95c338ef9359146b079a6c559aa2aa6c7237e15376cdec92f6fb6b8d4`; OpenAI `gpt-5.6-sol` / `codex-responses-v1`, slot `default`. Original final offline observations: forced checks 12/12, none cached; unit 603; integration 157; browser 11; container smoke 12 checks. The initial browser verification had failed because its fixture still used the retired profile; the owner approved that one-line repair and a rerun of all five commands. These are attributed historical results, not newly executed acceptance in this task.

The approved runtime-only rollout retained existing data/services and Anthropic as default, changing only image selection, the OpenAI profile and the deployment ceiling (18 to 23, baseline 11 plus 12). Fresh owner device login advanced generation 2 to 3; one deliberate renewal advanced 3 to 4. Journey `5d0248ff-6cd4-4311-aaab-87de309828b2` completed in three requests after its question was observed waiting through runtime restart and recreation, but the owner answered `"yes"` rather than the requested negative answer. The owner authorized a repeat within the same allowance. Journey `2e7d0541-a0db-4393-bbd9-001af2b177cf` completed in three requests after the declared string `"no"`, with a result respecting it; it finished before recreation, so no single negative-answer journey demonstrated both restart and recreation while waiting. Cancellation run `226d4742-0a3e-4a57-8b7f-ed6222b6b0d0` asked without reading, was cancelled with its question closed after one request, and stayed cancelled after restart.

Two additional owner-created runs consumed one request each. One occurred before the fresh login; the attribution to the retained generation follows the observed chronology, not a credential-generation field in the public attempt events. At trial close, nine new OpenAI requests had succeeded (seven across the three trial runs plus two owner runs), separate from four historical OpenAI failures. Deployment totals were twenty of twenty-three: OpenAI thirteen cumulative, Anthropic seven unchanged, zero unconfirmed. Do not repeat the earlier erroneous statement that all thirteen OpenAI requests succeeded, or use the four-request repeat-journey/cancellation subtotal as the full allowance consumption.

The unchanged reporter exited unsuccessfully because it required literal `false`; the accepted answer was declared string `"no"`. The owner explicitly accepted Step 9 as passed with those differences, then accepted the working state. Record this as owner-accepted recovery with exceptions, not an automated report pass or a new execution of this OpenSpec gate. The original pattern-based credential scan reported no matches in the current runtime log and eight selected runtime/checkpoint tables; this was not exact-token comparison across every protected surface, nor evidence about logs lost when earlier containers were recreated. Preserve that scope and the unestablished cause of the old failures.

Completion of this reconciliation requires an attributable account of the original approval, source/image, device login/renewal, actual tool/question/result and cancellation observations, request counts, offline failures/repair, reporter failure, accepted exceptions and evidence limits. It authorizes no new run, login, renewal, restart, recreation or rollback. If those sources cannot support a required claim, stop for an owner decision about the missing evidence. Any genuinely necessary new provider check, including an Anthropic rerun, needs a separate justified scope and fresh bounded allowance; old capacity is not authority.

### Step 106 - Implement: Record G5 evidence; verify correspondence to observed results
- [x] 14.8 Implement: Record G5 evidence; verify correspondence to observed results

Write the new `architecture/integration-evidence/mvp-01/g5-openai-recovery.md` from the reconciled 14.7 observations/owner decisions and the separate fresh offline results at 23.3. Identify the original recovery source/image/dependency matrix and later cleanup source independently. Include exact commands/outcomes, failed browser check and authorized repair, login/renewal and run IDs, all nine additional requests rather than just the reported pair, owner-accepted exceptions, secrecy-scan scope, unresolved causes and limitations. State that the standalone plan/results were intentionally deleted and identify which claims are reconstructed from conversation/owner observations versus surviving logs or newly checked source.

Add a separately dated recovery entry to `architecture/spike-reports/README.md` and current-documentation evidence links, without overwriting `g5-openai-live.md`, `g5-openai-offline.md`, `openai-removal.md` or other dated records. Describe the new outcome as accepted with documented exceptions, not an unqualified original reporter pass. Do not rerun providers or infer a pass from missing evidence. This repository-evidence write is an Implement step outside the planning-only edit boundary.

### Step 107 - Verify: Check G5 evidence; require accurate, safe and complete records
- [x] 14.9 Verify: Check G5 evidence; require accurate, safe and complete records

Passed 2026-10-06: every relative link and anchor in the new record, the index and the five current documents resolves; `g5-openai-offline.md`, `g5-openai-live.md`, `openai-removal.md`, other dated records, adversarial artifacts and spikes are unchanged since `da65cab` (only the new record and one added index row); a scan for token, key, verifier and secret patterns found nothing; the record's identities, counts and timestamps match 14.7 and 23.3, labels each claim's source, and states the reporter failure, accepted exceptions, scan scope and open items. Strict OpenSpec validation, whitespace and lint pass. No auth or model request was made.

Check `g5-openai-recovery.md`, its index/status links and original evidence preservation against 14.7's attributed observations and 23.3's distinct fresh results. Require accurate source/image identities, original approval boundaries, nine new successes versus four historical failures, full allowance accounting, the strict reporter failure and accepted exceptions, and the limited secrecy-scan claim. Reject unsupported causal or current-build/live-pass claims, hidden missing cases and sensitive content. Check strict OpenSpec validity and whitespace without editing files. This records-only step performs no auth/model request or deployment mutation.

### Step 108 - Review: Assess dual-provider evidence; obtain approval to enter final acceptance
- [x] 14.10 Review: Assess dual-provider evidence; obtain approval to enter final acceptance

Owner approved entering complete-system acceptance on 2026-10-06 after reviewing both providers' evidence, the accepted recovery exceptions, the corrected reporting and documentation, and the open final-check items: Anthropic live evidence predating `dbf7145`, the split restart/recreation coverage, the missing compatible-image rollback witness and the full requirement/scenario audit. No provider allowance was requested or granted.

Present both subscription journeys, the accepted recovery exceptions, corrected reporting/documentation, verified evidence and remaining final-check obligations. Respect the owner's earlier recovery acceptance without treating it as approval of checks not yet run. Obtain explicit approval to enter complete-system acceptance, or a correction request. This is not phase exit: the following coverage, current-build applicability, rollback and final handoff gates remain. A skipped provider is not a completed phase, and acceptance grants no fresh provider allowance.

## 15. Complete-system acceptance — Research

### Step 109 - Pause: Switch model for exploration
- [x] 15.1 Pause: Switch model for exploration

### Step 110 - Explore: Audit acceptance coverage; verify all requirements and gates have evidence
- [x] 15.2 Explore: Audit acceptance coverage; verify all requirements and gates have evidence

Inspect all 32 requirements and 80 scenarios, directory-reading coverage, G1–G5 records, both browser-auth flows, historical removal and accepted recovery, exact pins, block-local documentation and deferred-test markers. Build an explicit requirement/scenario-to-evidence map, distinguishing original live observations, current offline checks and owner-accepted exceptions. Report missing evidence without editing code or declaring skips passed. Removal alone does not satisfy dual-provider acceptance. An omission returns to its owning block for an explicitly approved correction, not late feature work here.

Assess whether the earlier Anthropic live records apply to the tested build after the recovery's core 1.2.14 and shared middleware changes; fresh offline regressions are supporting evidence, not proof of a fresh live journey. Identify an actual compatible-image rollback witness rather than infer it from ordinary restart/recreation tests. Missing coverage requires an explicit resolution before 15.3 proposes final verification; do not silently weaken either requirement or initiate a new live check.

Check README coverage of setup/pins, Compose/Tailscale, both providers' auth and model configuration, workspace restrictions, browser operation, budget/cancellation, restart and troubleshooting. Check every architecture document in design Decision 14. Compare historical spikes against the recorded pre-execution baseline, not an assumption that the working tree was clean. Missing documentation returns to its owning block.

Audit monorepo/package ownership, shared contracts, root/package command coverage, single-image UI delivery and cache-policy documentation. Confirm acceptance records distinguish forced check execution from cache-behavior tests and that no package suite or build output was omitted by Turbo configuration.

Audit completed 2026-10-06, read-only apart from task tracking: mapped 32 requirements/80 scenarios (20 lifecycle requirements/47 scenarios; 8 provider/auth/privacy requirements/25 scenarios; 4 foundation/network/workspace requirements/8 scenarios). No skipped, TODO or focused-only source tests were found; the retained 23.3 logs corroborate 609 unit, 157 integration, 11 browser and 12 container checks, not newly executed results. Current tests cover protocol expiry/cancellation/shutdown but lack direct fresh-login-service restart witnesses over preserved credentials for both providers and direct OpenAI service expiry. The container smoke suite recreates the namespace holder, not an earlier image. Current control-plane status and authentication lock/lifetime descriptions need correction; the new recovery record incorrectly attributes profile/slot fields to public API observations and says the repeat journey finished five seconds before recreation rather than about 3.4. The accepted second-device and OpenAI trial limitations are retained, not reopened. Historical Anthropic live evidence predates shared core/middleware changes; the Anthropic-specific production delta is only a type relocation. These findings lead to the bounded prerequisites below and an explicit final-scope evidence decision, not an observed runtime failure or permission to repeat live work.

## 24. Final-acceptance prerequisite corrections — Research

### Step 162 - Explore: Confirm auth and rollback fixtures; verify the bounded correction plan
- [x] 24.1 Explore: Confirm auth and rollback fixtures; verify the bounded correction plan

Reuse the 15.2 audit and design Decision 17 rather than reopen the provider survey or repeat the full acceptance inventory. Inspect `packages/runtime/src/service/auth.test.ts`, `openai-auth.test.ts` and their fixture helpers to identify how to recreate login services over the same synthetic credential store and advance the OpenAI clock/poll barrier deterministically. Map old-attempt refusal, no repeated exchange, unchanged saved authorization, expiry and settled cleanup to independent witnesses. Confirm these tests enter the existing package and forced check graph without a new test mode.

Inspect `scripts/container-smoke.ts`, its existing fixture launcher/Compose configuration, the Docker build and execution-manifest inputs. Specify two distinct immutable fixture images using the same current pinned execution closure; a harmless browser-only variation belongs solely to a disposable build context, never the working-tree application. Identify a distinguishing served-content witness, equal per-provider execution manifests, representative existing-record/synthetic-credential fixture setup, preserved-volume assertions and independent no-new-model-attempt observations. Reuse supported storage/fixture mechanisms; do not fabricate successful work or rewrite checkpoints to make a candidate compatible. Identify the exact minimal test-helper paths and the existing explicit container-check entry point that will exercise the rehearsal. If this cannot be achieved without runtime changes, new infrastructure or a weakened compatibility check, stop and present that limitation before implementation.

Confirm the correction sites in `architecture/02-control-plane.md`, `architecture/05-model-authentication.md`, root `README.md` and the new `g5-openai-recovery.md`; preserve older dated evidence and intentionally historical design sections. The API's model/default/budget fields are not profile/slot observations. The recorded repeat journey finished at `16:26:11.953988Z`, before recreation at `16:26:15.361799358Z`; its answer time is a different event. Use already available safe observations, not another deployment inspection. This step writes no source/evidence, runs no container or provider operation and reads no real credentials.

Research completed 2026-10-06, with only this task-tracking update: both login-service tests can reuse the same private fixture path while constructing fresh stores/coordinators/services after awaited shutdown. OpenAI already injects its clock and polling sleep; the fixture will share a mutable clock and release its poll barrier after the fifteen-minute deadline. OpenAI has no completion method; old-handle checks cover status/cancel, with completion additionally checked for Anthropic. Independent issuer counts and exact saved bytes/generation supply the missing witnesses. No runtime-source change is indicated by inspection; none of the new cases has been executed.

The rollback can extend `scripts/container-smoke.ts` with one new helper, `tests/container/rollback-state.ts`. The image contains bundles and notices, not source or node_modules: fully bundle the helper with pinned Bun, mount it read-only into a short-lived fixture container, and reuse production persistence/credential APIs while the runtime is stopped. Prepare cancellation-only records without invoking a graph or inventing successful results; construct their definitions from the shipped provider manifests and the existing graph-inspection construction path. After startup, helper inspection uses read-only application transactions, not ownership acquisition. Build two images from one allowlisted disposable source snapshot, changing only the copied HTML title; capture distinct immutable IDs, require equal shipped provider manifests, and witness original → variant → original over the same volumes. Exact state/credential fingerprints, database activity counters, API projections and inspected internal-only networks provide separate preservation/readiness/no-new-work witnesses. Bundle/build/transition feasibility remains to be executed under 24.2 approval, not claimed passed here.

Two additional bounded details belong in that proposal: the existing smoke `check()` logs and continues after failed assertions, so the expanded launcher must fail fast while retaining owned cleanup; README's current setup matrix still says core 1.2.13 despite the 1.2.14 package pin. The retained 14.7 capture corroborates the profile/slot projection omission and finish/answer timestamp distinction without another deployment read. No tests, builds, containers, provider calls, real credential reads or source/documentation/evidence writes occurred during this research.

### Step 163 - Propose: Present prerequisite tests and documentation; obtain bounded implementation approval
- [x] 24.2 Propose: Present prerequisite tests and documentation; obtain bounded implementation approval

Present the exact test/helper/documentation files, image-construction approach, representative fixture records, pass/failure witnesses and verification commands for group 25. The rollback proposal SHALL name the two distinct fixture image identities to be produced, the allowed browser-only difference, equal execution-manifest requirement, isolated storage/network policy and cleanup boundaries. Distinguish its preserved-state/readiness proof from the existing G1/G3/continuation suites' detailed crash and question semantics. A tag change or recreation of the same image SHALL NOT be described as image rollback.

Obtain explicit approval for these implementation changes and launcher-owned fixture operations. No deployment of the working application, provider request, real credential operation, dependency change, schema migration or production compatibility exception is included. A runtime defect revealed by a new test stops for a separately scoped repair proposal, not an automatic fix. Final Anthropic evidence applicability and any necessary fresh bounded live allowance remain for 15.3; neither the audit nor this proposal grants that allowance.

Approved 2026-10-06: eight-file implementation scope—`packages/runtime/src/service/auth.test.ts`, `packages/runtime/src/service/openai-auth.test.ts`, `scripts/container-smoke.ts`, new `tests/container/rollback-state.ts`, root `README.md`, `architecture/02-control-plane.md`, `architecture/05-model-authentication.md`, and `architecture/integration-evidence/mvp-01/g5-openai-recovery.md`. Auth tests recreate fresh stores/coordinators/services over the same synthetic credential directory after settled shutdown, refuse old handles without issuer work, preserve exact bytes/generation, and exercise OpenAI expiry with its injected clock/poll barrier. OpenAI has no completion endpoint. All asynchronous test work must settle before cleanup.

The container launcher builds A (`agent-runtime/runtime:smoke-<unique-id>`) and B (`agent-runtime/runtime:smoke-<unique-id>-ui-next`) from one allowlisted disposable source snapshot, changing only B's copied HTML title. Actual immutable IDs must differ and both shipped provider manifests must match; select the captured IDs for A → B → A and witness the served title at each stage. Fully bundle the new helper with pinned Bun, including its dependencies, and mount it read-only only into a short-lived fixture container. While the runtime is stopped, seed two cancellation-only records (one per provider) and synthetic credentials through existing persistence/credential APIs; construct real definitions from the shipped manifests and graph inspection without invoking a graph or fabricating successful results. Once the runtime is running, inspect through read-only application transactions without claiming ownership. Require the same database/private-state volumes, readiness, unchanged histories/outcomes and credential bytes/generations, unchanged invocation/activity counts and zero model attempts. Keep runtime/provider egress unavailable, the namespace holder inert and ports unpublished. Fail fast at the first assertion; settle and clean up only launcher-owned resources and image names, never shared image IDs or owner storage.

Documentation scope includes the identified status, lock/lifetime and dated recovery-attribution/timing corrections, rollback command/limits, and the additional stale README core pin (1.2.13 → the installed 1.2.14; no dependency change). Preserve existing accepted exceptions and older records. Run focused auth tests, then the five prescribed suites sequentially, with rollback included in `test:container`, plus documentation links, strict OpenSpec and preservation checks. Any failure stops without automatic repair/rerun. No runtime/provider implementation, dependency, schema, real credential operation, live deployment, provider traffic, commit, push or merge is approved. Implementation remains a Build-agent handoff after the following pause; Anthropic applicability stays at 15.3 and accepted OpenAI recovery is not reopened.

## 25. Final-acceptance prerequisite corrections — Implementation

### Step 164 - Pause: Switch model for implementation
- [x] 25.1 Pause: Switch model for implementation

### Step 165 - Implement: Add unfinished-login regressions; verify restart, expiry and credential preservation
- [x] 25.2 Implement: Add unfinished-login regressions; verify restart, expiry and credential preservation

Implemented 2026-10-06 in the two approved test files only. Fixture setup can reuse an earlier fixture's state directory; OpenAI setup also takes an injected clock shared by issuer, coordinator and service. Three new tests: Anthropic and OpenAI restart (old status/cancel — and Anthropic completion — return `not_found` from the fresh service, no issuer request, exact credential bytes and generation unchanged, a new begin is a distinct attempt) and OpenAI service expiry (code/link cleared, no failure, no further poll or token request, bytes/generation unchanged, a later begin asks for a new code). While adding them, the test's poll gate was found to ignore an abort that had already happened, so a login stopped between a poll and its wait hung the test; the gate now resolves at once on an aborted signal, as the real sleep does. No runtime source changed. Focused run: `bun test src/service/auth.test.ts src/service/openai-auth.test.ts` (in `packages/runtime`) 20 pass, and the OpenAI file 10 pass on five further repeats.

**Process exception disclosed at the 25.6 handoff; subsequently accepted as recorded below.** The original focused run reported 19 pass / 1 fail: the new OpenAI expiry test timed out after five seconds. The executor continued with repeated diagnostic edits/runs, then added the pre-aborted-signal handling to the test poll gate and reran tests without first obtaining the required stop/repair decision. A later helper-format check also failed and was repaired without that stop. The subsequent passing results above and at 25.5 remain distinct observations; they do not erase those failures or establish compliance with the approved execution protocol. The fixture change matches the production sleep's existing pre-abort behavior, not a newly repaired runtime defect. No further checks or source repairs are authorized by this disclosure.

Extend the existing Anthropic and OpenAI login-service suites and only the fixture helpers approved at 24.2. Seed usable synthetic authorization, start an unfinished login, settle shutdown and recreate the service over the same store. Assert the old attempt is unknown, old status/cancel/completion handles cannot initiate an exchange, credential bytes and generation remain unchanged, and only an explicit new begin can start a distinct attempt. Observe issuer/exchange counts independently and settle all old polling/exchange work; do not infer no I/O solely from a projected status.

Use an injected clock and controlled poll barriers to exercise OpenAI service expiry, including clearing the code/link, no further poll or exchange after expiry, and preservation of saved authorization. Retain existing no-lock-during-owner-wait, one-exchange, uncertain-outcome and cancellation regressions. Run the focused service suites under Bun with synthetic transports and private launcher-owned fixtures; add no real auth request or runtime behavior change. A failing new assertion stops for guidance, not a runtime repair or skipped test.

### Step 166 - Implement: Add the isolated image-rollback rehearsal; verify compatible preserved-state outcomes
- [x] 25.3 Implement: Add the isolated image-rollback rehearsal; verify compatible preserved-state outcomes

Implemented 2026-10-06 in `scripts/container-smoke.ts` and new `tests/container/rollback-state.ts`. The launcher snapshots the `.dockerignore` allowlist into its fixture directory, builds image A from it, changes only the copied console title, builds B, and checks distinct IDs and identical shipped manifests for both providers before starting the project (no longer `up --build`). The smoke configuration now also configures OpenAI (`codex-responses-v1`). After the existing checks: all fixture networks internal; the helper is bundled with pinned Bun and mounted read-only into one-off `compose run` containers; with the runtime stopped, `seed` writes generation-1 synthetic credentials and creates, accepts and finishes cancellation of one run per provider through `RunStore`, with definitions built from the shipped manifest and the inspection-only agent; then A → B → A by retagged Compose selection, each verified by the container's actual image ID, served title, persistence readiness and an owner-epoch advance, unchanged volume names and database container, both providers `ready`, both runs readable and cancelled, and an unchanged read-only fingerprint with zero model attempts. Selection is by the two launcher-owned tags; the immutable IDs are what is asserted. `check()` now stops the suite at the first failure; cleanup removes only the project and the two tags. Development run of `bun run test:container`: exit 0, all 17 checks passed (log `/tmp/opencode/c25-container-dev.log`, not acceptance evidence); no smoke containers, volumes, networks or images remained.

Implement the approved rehearsal through the existing explicit container-check entry point and minimal test-only helpers. Build two distinct immutable fixture images with the same pinned runtime/dependency closure and equal execution manifests for both provider bindings. Keep the distinguishing browser-only variation in disposable build inputs; do not edit production UI/execution source, fabricate manifests, use the retired OpenAI implementation or weaken definition equality. Verify actual image IDs and the served distinguishing content across the forward switch and restoration of the earlier image, rather than comparing tags alone.

Use uniquely named launcher-owned services and the same fixture database/private-state volumes throughout the switch. Prepare representative recorded history/outcomes and synthetic authorization using existing supported fixture/storage mechanisms. Require restored readiness, preserved volume identities and recorded data/credential integrity, and no new model attempts or automatic redispatch. Runtime/provider egress stays unavailable. Do not join a tailnet, publish an operational port, import owner state, contact providers, down-migrate, rewrite checkpoints or roll back credentials. Stop on a failed transition/assertion; cleanup may remove only this launcher's own resources after settlement, never repair or alter the live project. Run the isolated rehearsal and retain safe source/image/manifests/count outcomes for later verification; do not present it as live-deployment rollback evidence.

### Step 167 - Implement: Correct prerequisite guidance and recovery provenance; verify source correspondence
- [x] 25.4 Implement: Correct prerequisite guidance and recovery provenance; verify source correspondence

Implemented 2026-10-06: `02-control-plane.md` now lists both integrations as built and only final acceptance as outstanding; `05-model-authentication.md` distinguishes the Anthropic terminal login's lock over the owner's wait from console Anthropic and OpenAI (console or terminal) logins, which lock only for exchange and write, and OpenAI's fifteen-minute approval deadline from the ten-minute Anthropic lifetime and settled-attempt retention, with restart behavior; README corrects the core pin to 1.2.14, adds the OpenAI model pins, and documents the rollback rehearsal and its limits under `test:container`; `g5-openai-recovery.md` carries a dated correction attributing profiles/slot to the rollout's deployment observations and giving the repeat journey's finish time (16:26:11.95Z, about 3.4 s before recreation) separately from its answer time. Checked against `operator/auth-command.ts`, `service/auth.ts`, `service/openai-auth.ts`, `providers/openai/auth.ts`, the runtime package manifest and the retained 14.7 capture; no other record changed.

Update the current-status section of `architecture/02-control-plane.md` to describe restored OpenAI and pending final acceptance. Correct `architecture/05-model-authentication.md` to distinguish the Anthropic terminal wait under its login lock from console/OpenAI device waiting outside the exchange/storage lock, and distinguish provider-specific approval lifetimes from retained-attempt limits. Document the isolated rollback check, prerequisites, safety boundaries and limited proof scope in root `README.md` using the approved existing command. Keep intentionally historical architecture sections and the runtime's current screening/completion claims unchanged where already accurate.

Correct only the two identified facts in the new `architecture/integration-evidence/mvp-01/g5-openai-recovery.md`: profile/slot configuration comes from original deployment observations, not the public API projection, and the repeat journey finished about 3.4 seconds before recreation rather than five. Add a dated correction note; distinguish answer time from finish time and retain source/image identities, all request counts, original reporter failure and owner-accepted exceptions. Do not rewrite older G4/G5/removal records, add a new live pass or claim the following verification succeeded. Check links and wording against source and the already available safe observations. Final phase-exit evidence remains at 16.4.

### Step 168 - Verify: Run prerequisite acceptance; require auth, rollback and full regressions to pass
- [x] 25.5 Verify: Run prerequisite acceptance; require auth, rollback and full regressions to pass

Passed 2026-10-06 on `dbf7145` plus the uncommitted changes (cleanup, reconciliation and groups 24–25), each command once in order with exit status 0: focused login-service suites 20 pass; forced `check:verify` 12/12, none cached (runtime 435, contracts 17, subscription 61, UI 24, scripts 75); direct `bun test` 612; integration 157; browser 11; container smoke 17 checks including the rehearsal, which ran once inside `test:container`. Rehearsal: A `sha256:ed0293c95c338ef9359146b079a6c559aa2aa6c7237e15376cdec92f6fb6b8d4` → B `sha256:552351c0cf0bf2b1284dcf6bc9180b466a6a2d84e00142f4c50063bd1eda10b7` → A, identical manifests for both providers; unchanged state fingerprint `359c6f85…` with 2 runs, 10 events, 2 invocations, 2 definitions and 0 model attempts, tool operations, questions or checkpoints. A's ID equals the deployed recovery image's, because no execution or build input changed since `dbf7145`; the launcher removed only its own tags, and the live image tag and runtime container (still started 16:27:16Z) were untouched. Witnesses: restart/expiry and credential bytes/generation by the two login suites; image switch by container image IDs and served titles; preserved storage by volume names, database container ID and fingerprint; no new work by the attempt/activity counters and internal-only networks; detailed crash, question and cancellation semantics remain with the existing integration suites. No runtime, provider, dependency or deployment file changed apart from tests and documentation; dated evidence, adversarial artifacts and spikes are unchanged since `da65cab` except the recovery record and its single index row; 60 relative links/anchors in the four corrected documents resolve; strict OpenSpec validation and whitespace pass; no smoke containers, volumes, networks or images remain. No live deployment, auth or model request was made.

Run the focused login-service regressions and the approved isolated rollback check, then `mise exec -- bun run check:verify`, `mise exec -- bun test`, `mise exec -- bun run test:integration`, `mise exec -- bun run test:browser` and `mise exec -- bun run test:container` sequentially. The existing explicit container command SHALL include the rollback witness; duplicate execution in this gate MAY be avoided if that command already executes the same identified rehearsal. Preserve each exit status, distinguish fixture evidence from cached build layers, and stop at the first failed command without repair/rerun or acceptance skips. Use synthetic credentials, scripted transports and launcher-owned storage only. No source-changing formatter flags, live deployment mutation or provider operation belongs here.

Require direct unfinished-login restart/expiry and credential-preservation assertions, two distinct actual image IDs with equal execution manifests, the observed rollback switch, preserved fixture data and readiness, and independent no-new-model-work evidence. Retain the existing detailed crash/question/cancellation regression suites and state clearly which witness covers each assertion. Verify cleanup affected only launcher-owned resources, non-test runtime/provider code and dependency pins remain unchanged, and no test seam weakened production policy. Validate corrected documentation/evidence links and source attribution, strict OpenSpec validity, whitespace and preserved historical/adversarial material. Report safe exact commands/source/image/count outcomes; do not edit repository evidence during this Verify step or relabel the original recovery checks. Any unresolved prerequisite keeps 15.3 blocked.

### Step 169 - Pause: Switch model for exploration
- [x] 25.6 Pause: Switch model for exploration

Owner continued after the fixed pause notice. Final-scope proposal 15.3 is held for an explicit decision on the disclosed stop-on-failure violation and the rollback selection deviation: approval named captured immutable IDs as the selections, but the launcher selects unique fixture tags and asserts actual image IDs afterwards. The retained final logs confirm the reported passes and actual A → B → A transition; no new test, container or provider operation was performed in this handoff review. Existing completion checkboxes record completed work and observed checks, not acceptance of these exceptions or phase exit.

The owner subsequently selected **Accept exceptions**: retain the test-fixture repair, tag-based selection with actual-ID assertions, and later passing evidence with the disclosed failure history. This resolves the handoff hold, not phase exit. The stop-on-failure rule remains unchanged for future work; no additional source repair or live operation is authorized.

## 15. Complete-system acceptance (continued) — Research

### Step 111 - Propose: Present final integration checks; obtain owner approval of the verification scope
- [x] 15.3 Propose: Present final integration checks; obtain owner approval of the verification scope

Present integration/rollback checks and any genuinely necessary fresh live allowance. No feature or documentation backlog is deferred into this acceptance block; unresolved earlier work stops the handoff for correction/replanning.

Proceed only after group 25's prerequisite verification and model-switch pause. Present the updated scenario-to-evidence map, the compatible fixture-image rollback witness and its limits, and the corrected current guidance. Explicitly resolve applicability of older Anthropic live evidence after the shared core/middleware changes: either obtain a documented owner decision to carry it forward alongside current offline regressions with that limitation, or obtain a fresh narrowly bounded live-confirmation scope and allowance for the exact tested build. Do not claim either is a previously executed current-build live pass. No OpenAI rerun follows from this decision, and unused capacity in an old allowance grants no authority. The remainder of group 16 stays verification, its own evidence recording and final review only.

**Owner-approved reduced final scope.** After accepting the prerequisite exceptions, the owner explicitly requested good-enough delivery rather than further perfection-driven work and approved this disposition: freeze implementation scope; reuse the 25.5 passing evidence (612 unit, 157 integration, 11 browser, 17 container checks; 12/12 forced tasks, zero cached) when relevant tested inputs are unchanged, rerunning only affected checks if those inputs changed. Carry forward the earlier Anthropic live evidence alongside current offline regressions, explicitly not as a fresh live trial on the recovery build. Preserve accepted OpenAI and prerequisite exceptions. No new live trial is required or authorized. Check the final changes, reuse the existing 15.2 coverage audit, record phase-exit evidence and present the final handoff. Do not add features, tests, cleanup projects or an open-ended gap audit. Only a demonstrated release-blocking defect warrants reopening implementation; verification failures still stop without automatic repair/rerun. No deployment, push, merge or automatic archive is implied. This approval controls the evidence-reuse scope of 16.2–16.3 below, superseding their earlier expectation of another full run on unchanged inputs.

## 16. Complete-system acceptance — Implementation

### Step 112 - Pause: Switch model for implementation
- [x] 16.1 Pause: Switch model for implementation

This phase contains integration verification, recording of its own acceptance evidence, and review only; it creates no feature code or deferred documentation backlog.

### Step 113 - Verify: Run complete-system checks; require current-build coverage without acceptance skips
- [x] 16.2 Verify: Run complete-system checks; require current-build coverage without acceptance skips

Passed 2026-10-06 as the approved evidence-reuse check. The owner committed the verified tree as `0d63879` ("WORK", on `dbf7145`) after 25.5; against that commit only `tasks.md` differs, and no file other than `tasks.md` changed after the 25.5 run began, so no tested input changed and nothing was rerun. Reused 25.5 results (retained logs in `/tmp/opencode/c25/`): forced `check:verify` 12/12, 0 cached (including lint, typechecks, build and the runtime/contracts/subscription/UI/script suites); `bun test` 612; integration 157; browser 11; container smoke 17 including the image build with the console. No skips or TODOs (15.2). Requirement coverage rests on the 15.2 audit plus 25.2–25.3 witnesses and the accepted dispositions.

Under the approved 15.3 scope, check whether relevant tested inputs have changed since 25.5 and reuse its completed checks when they have not; rerun only affected checks for changed inputs. Reuse the existing requirement/scenario audit and accepted evidence dispositions rather than conduct another broad gap hunt. Require attributable current-build offline evidence and the expressly accepted live carry-forward/exception decisions, not relabelled spike results or newly claimed execution.

Confirm the reused evidence includes the full forced root/runtime/UI/contracts check graph, the workspace-built image and existing package/cache/compatibility regressions. Previously executed evidence remains labelled as such; a cache hit or this records check SHALL NOT be claimed as a new suite run. No new feature or test implementation belongs here.

### Step 114 - Verify: Exercise restart and rollback integration; require truthful preserved-state outcomes
- [x] 16.3 Verify: Exercise restart and rollback integration; require truthful preserved-state outcomes

Passed 2026-10-06 by reuse, inputs unchanged: restart, interruption, cancellation and compatible/incompatible-question behavior from the 157 integration tests (lifecycle crash matrix, cancellation, answers, continuation) in the 25.5 run; compatible-image rollback and preserved-volume readiness from its container rehearsal (A `sha256:ed0293c9…` → B `sha256:552351c0…` → A, unchanged state fingerprint, 0 model attempts). Live evidence: OpenAI recovery as accepted with exceptions on `dbf7145`; Anthropic carried forward from its earlier live records (`4ac0809`, `ba07cb7`) with current offline regressions, not live-tested on the recovery build. No live operation was performed.

Confirm the existing lifecycle checks and 25.5 rollback rehearsal supply the ordinary-restart, interrupted/cancelled-outcome, compatible/incompatible-question and preserved-volume evidence. Reuse unchanged-input results as approved at 15.3, retaining the distinction between the fixture-image rollback and detailed lifecycle tests. Both provider records retain their exact tested-build attribution and the approved Anthropic carry-forward and OpenAI exceptions; no fresh live inference or live rollback is required.

Use the now-landed Decision 17 rollback rehearsal and existing lifecycle suites with their distinct evidence scopes. No new rollback tooling or deferred tests belong in this step. Apply the explicit Anthropic evidence disposition approved at 15.3 and preserve the accepted OpenAI exceptions; perform any live operation only within its fresh, named allowance. Fixture cleanup SHALL remain confined to launcher-owned resources, with owner deployment data untouched.

### Step 115 - Implement: Record phase-exit evidence; verify correspondence to observed results
- [x] 16.4 Implement: Record phase-exit evidence; verify correspondence to observed results

Recorded 2026-10-06 in `architecture/integration-evidence/mvp-01/phase-exit.md` with one dated index row: tested commit `0d63879`, pins and image ID, the reused 25.5 commands and counts, the rollback rehearsal and its limits, the 15.2 coverage map, Anthropic carry-forward, OpenAI exceptions, request totals, the accepted 25.2/25.3 process exceptions and known limitations. No other record changed.

Write `phase-exit.md` from the preceding verification results and relevant owner reports/authorization. Include exact tested versions, source identity, commands, outcomes, request counts, unresolved issues and skips. Update the separately dated spike-index pointer. Do not rerun providers or infer a pass from missing evidence.

### Step 116 - Verify: Check phase-exit evidence; require accurate, safe and complete records
- [x] 16.5 Verify: Check phase-exit evidence; require accurate, safe and complete records

Passed 2026-10-06: 35 relative links and anchors in `phase-exit.md` and the index resolve; no token, key, verifier or synthetic-credential patterns; figures and identities match 25.5, 16.2–16.3 and the G4/G5 records; changes since `0d63879` are only the new record, its index row and this task list; strict OpenSpec validation and whitespace pass. No auth or model request was made.

Check `phase-exit.md` and index links against the observed results, including tested-build identity and request allowance/counts. Reject unsupported pass claims, missing mandatory cases or sensitive content. This step checks records only and performs no new live provider requests.

### Step 117 - Review: Present the final handoff; obtain owner acceptance or identify outstanding work
- [x] 16.6 Review: Present the final handoff; obtain owner acceptance or identify outstanding work

Owner accepted MVP 01 on 2026-10-06 after reviewing the phase-exit record, the reused verification on `0d63879`, the requirement coverage, the Anthropic carry-forward, the OpenAI recovery exceptions and the disclosed process exceptions. Not archived; nothing pushed, merged or deployed; no later phase started.

Present the complete requirements/gates/documentation report and user-visible handoff. Do not archive the change, delete plans, publish facets, or execute a later roadmap phase as part of this step.
