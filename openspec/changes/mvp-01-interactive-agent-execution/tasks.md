> **Before executing any tasks below**, load the `viper-execution-rules` skill for the full VIPER step protocol (step types, execution rules, gating, and hard constraints).

# Tasks

Implement the reconciled [proposal](proposal.md), [execution specification](specs/execution/spec.md), and [design](design.md). All checkboxes start unfinished; creating this artifact does not execute the work.

Owner-approved refinement on 2026-09-29 adds the Bun/Turbo monorepo and separate runtime/UI package boundaries after the original adversarial reconciliation. Retained adversarial artifacts/reviews describe the earlier revision, not a new review of these edits. Task identities, ordering and model-switch pauses are preserved; updating this plan marks no implementation work complete.

Owner-approved corrective replan on 2026-09-30 inserts groups 17–18 after the completed 7.1 pause and before resuming 7.2. Their Step IDs 118–128 are additional stable identities, not instructions to execute them after Step 117: execution SHALL follow document order. Original task IDs, relative ordering, completed checkboxes, model-switch gates and historical evidence SHALL remain intact. Tasks 17.1–17.2 record research and proposal approval actually completed in the conversation; all corrective implementation, verification, acceptance and new pauses remain unfinished. Earlier block-6 acceptance is historical evidence, not proof that the newly identified cases pass. This revision does not claim renewed adversarial review or authorize source edits in Plan mode.

Owner-approved provider replan on 2026-09-30 replaces the upstream public-release prerequisite with the minimal internal v2-derived Anthropic subscription package in revised design Decision 10. LangChain/LangGraph and stock ChatAnthropic remain unchanged. Completed task descriptions, including the release research at 9.2, record the earlier work and SHALL remain intact; their upstream-delivery assumptions are superseded for future execution by this amendment. All 128 task identities, the 73 completed checkboxes, document order and model-switch/approval/verification gates are preserved. The pending provider tasks below implement the approved ownership change and the identified in-flight screening prerequisite. This artifact revision completes no additional task or gate and does not authorize implementation before 9.5 approval and the 10.1 pause, upstream edits or live provider traffic. Retained evidence and adversarial artifacts SHALL NOT be rewritten to describe the new approach as already verified.

Owner-approved trial replan on 2026-09-30, at the 12.11 Review: the Anthropic G4 live journey (12.12) runs locally — the built runtime started directly on the owner's machine, loopback-only, with a dedicated database — instead of through Compose, Tailscale Serve and a second tailnet device. Private-network access is not abandoned: inserted task 16.7 (Step 129) verifies Serve HTTPS and a second-device journey before phase-exit evidence. G4 evidence SHALL state that the tailnet path was not covered by the local trial. The live allowance itself is recorded at 12.11.

Owner-approved browser-auth replan, after the local runtime was shown to the owner: pause the live trial and implement the Connect Anthropic flow in revised design Decision 16. Proposal, specification, design and this task amendment were each approved in the conversation. Insert tasks 12.16–12.20 (Steps 130–134) after historical 12.11 and before 12.12; execute in document order, not numeric order. The three implementation steps, offline Verify and fresh live-authorization Review join the existing implementation phase without introducing another exploration block or changing any existing model-switch Pause. All 129 prior task identities, completed-work history and retained adversarial artifacts SHALL remain intact. The five new tasks start unfinished. The earlier terminal-login allowance at 12.11 SHALL NOT authorize browser auth or model traffic on the revised build. Demo hardening, mobile-specific work, OpenAI auth expansion and the deferred tailnet journey are outside this addition.

Owner-approved full-stack validation replan on 2026-10-01, after acceptance at 12.15: validate the shipped Docker/Tailscale/PostgreSQL stack before OpenAI research. Move the existing unfinished 16.7 (Step 129) into the full-stack validation sequence below, after its fresh live-authorization Review, rather than duplicating or marking it complete. Add tasks 19.1–19.6 (Steps 135–140) for deployment approval, provider-free deployment verification, fresh Anthropic authorization, evidence recording/verification and owner acceptance. Group 19's setup/approval and evidence/acceptance sections surround the moved group-16 task to preserve its existing number; execute in document order. These steps continue the current implementation/verification phase; the existing 13.1 model-switch Pause remains immediately before OpenAI exploration. Preserve all 134 prior task identities, completed work, evidence and adversarial history. This amendment approves scope and sequencing only; deployment/enrollment and provider calls have separate pending gates. No local relay, inert Tailscale substitute, host networking, mobile work or new demo launcher is included.

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
- Gate evidence SHALL live under `architecture/integration-evidence/mvp-01/`, indexed from `architecture/spike-reports/README.md`. Fixed files are `g1-bun-persistence.md`, `g2-anthropic-boundary.md`, `g3-dispatch-lifecycle.md`, `g4-anthropic-offline.md`, `g4-anthropic-live.md`, `g4-anthropic-docker-tailnet.md`, `g5-openai-offline.md`, `g5-openai-live.md`, `upstream-handoff.md`, `openai-cost-checkpoint.md`, and `phase-exit.md`.
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

Inspect all 31 requirements and 71 scenarios, directory-reading coverage, G1–G5 records, browser-auth acceptance, exact pins, block-local documentation and deferred-test markers. Report missing evidence without editing code or declaring skips passed. An omission returns to its owning block for an explicitly approved correction, not late feature work here.

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
