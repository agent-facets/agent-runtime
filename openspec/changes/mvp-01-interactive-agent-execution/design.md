# Design

## Context

See [proposal.md](proposal.md) for motivation and [the execution spec](specs/execution/spec.md) for the behavior contract. At initial authoring the repository contained a minimal Bun scaffold and reference spikes; current implementation progress is recorded in [tasks.md](tasks.md). The reconciled spec has 30 requirements and 65 scenarios. This document designs those requirements; it does not itself establish implementation or integration-test acceptance.

The [MVP roadmap](../../roadmaps/framework-mvp.md) selects LangChain `createAgent`, LangGraph, the official PostgreSQL checkpointer, a browser console, and Anthropic followed by OpenAI subscription access. Historical architecture documents describe a larger system and are superseded where this design identifies a Phase-1 difference.

Owner clarifications on 2026-09-29:

- Services SHALL run in Docker Compose, with Tailscale Serve providing private HTTPS access.
- Workspaces are owner-controlled volumes; hostile concurrent filesystem mutation is outside the supported environment. Read-only mounts do not replace path confinement or credential exclusions.
- The owner selected the maintained `@ex-machina/opencode-anthropic-auth` code as the Anthropic subscription basis. The original direct-consumption/public-release prerequisite is superseded by the internal-extraction decision below; the library's maintenance status is not in question.
- API-key support remains deferred. Provider identity and authentication mode SHALL be separate so a later explicitly selected API-key mode does not require another execution architecture. No API-key path or automatic billing fallback is enabled now.
- `Bun.sql` SHALL serve application-owned database queries. The official checkpointer integration is the narrow exception permitting `pg`, including construction and error handling of its pool; application records SHALL NOT use that driver.

Owner-requested refinement on 2026-09-29, after the original adversarial reconciliation: the repository SHALL use a Bun-workspace monorepo orchestrated by Turborepo, with separate runtime and UI packages but one application deployment. The retained adversarial artifacts/reviews describe the earlier revision; this refinement does not claim a new adversarial review.

Owner-approved refinement on 2026-09-30, during provider research: retain LangChain/LangGraph and stock ChatAnthropic, but replace the upstream public-release dependency with a minimal, explicitly maintained internal extraction of the plugin's v2 subscription auth/profile code. This changes implementation ownership, not the execution specification, provider order or safety gates. It does not authorize upstream edits, implementation before the block proposal is approved, or live provider operations. Historical evidence and adversarial artifacts remain records of their original revisions.

## Goals / Non-Goals

**Goals:**

- Keep model/tool scheduling in the framework while giving the application enforceable authority over dispatch, accepted human input, and visible outcomes.
- Specify records, identities, wire contracts, and commit boundaries sufficient to implement the durability and concurrency requirements without pretending graph and application writes share a transaction.
- Reuse reviewed provider code through explicit integration boundaries, keeping the Anthropic derivative minimal and internally maintained, and verify it under Bun before building out the console.

**Non-Goals:**

- A custom agent loop, replacement checkpointer, OpenCode host, complete Agent Server implementation, general effect ledger, distributed worker system, or crash-recovery queue.
- Token-by-token browser rendering, arbitrary question schemas, regex search, or configurable agent-supplied endpoints.
- Automatic compatibility migration of paused runs. Conservative refusal is preferable to replaying a human answer into changed work.
- Forking LangChain or a provider SDK, hosting OpenCode, publishing a new auth library, or automatically synchronizing the internal derivative with upstream.

## Decisions

### 1. Separate runtime and UI packages, one containerized Bun application

The operational stack SHALL contain three services:

| Service | Responsibility and exposure | Persistent storage |
|---|---|---|
| `runtime` | Bun application, execution controller, REST/SSE and bundled React console; listens on `127.0.0.1:3000` in the Tailscale service's network namespace | Private runtime credential volume; owner workspace bind-mounted read-only at `/workspace` |
| `tailscale` | Tailscale Serve HTTPS proxy to the runtime's loopback listener; Funnel disabled; no published application port | Separate Tailscale state volume |
| `postgres` | Application and graph state on the Compose backend network; no published database port | PostgreSQL data volume |

The Tailscale container SHALL have the connectivity needed to reach PostgreSQL and the subscription providers; the runtime shares that network namespace. The runtime SHALL NOT mount the Docker socket, Tailscale credentials, the host home directory, or unrelated repositories. It SHALL run as a non-root user, with a read-only application image and writable private state/scratch locations only. These deployment controls are not advertised as a sandbox against hostile host processes.

Tailnet access policy SHALL restrict this service to the owner's approved devices or principals. Phase 1 trusts those permitted peers; it does not introduce application accounts or trust arbitrary forwarded identity headers. The server SHALL validate the configured public Host/Origin, reject cross-origin/null-origin browser mutations, require JSON writes, and expose no permissive CORS policy. Model/workspace content SHALL render as text or sanitized Markdown without executable HTML or automatic external-resource loading.

The initial toolchain target is Bun 1.3.14, the installed version observed during authoring. `mise.toml`, root `packageManager: bun@1.3.14`, dependency versions, the single `bun.lock`, and container images SHALL be pinned during scaffolding. Initial development-tool candidates are Turbo 2.10.4, TypeScript 5.9.3, Bun types 1.3.14 and Biome 2.4.15. Initial integration candidates are `langchain` 1.5.14, LangGraph 1.4.13, core 1.2.13, checkpoint 1.1.5, PostgreSQL saver 1.0.5, and the provider integrations used in the spikes. Core 1.2.13 replaces the earlier 1.2.9 candidate because the published LangChain 1.5.14 manifest requires core `^1.2.13`. These are a candidate matrix, not an asserted compatible release set. Any required version adjustment SHALL be recorded and the resulting exact matrix reverified. No Node runtime fallback is implicit.

Scaffolding SHALL remove the unused floating `node = "latest"` entry from mise.toml. If a development-only tool later requires Node, its purpose and exact version SHALL be explicit; its presence SHALL NOT authorize changing the application runtime.

**Package ownership.** The private root SHALL declare Bun workspaces under `packages/*`, retain one lockfile, and own Turbo, shared strict TypeScript configuration, Biome and repository scripts. Packages SHALL declare their own application dependencies and use `workspace:*` for internal dependencies. Package-local TypeScript configurations SHALL distinguish browser and server environments.

| Package | Responsibility | Permitted first-party dependencies |
|---|---|---|
| `packages/runtime` | Bun server, agent/controller, persistence, provider/credential adapters, REST/SSE and operator commands; sole deployable application | Contracts; Anthropic subscription package; UI's public HTML entry solely for application assembly |
| `packages/ui` | React console, browser API client, browser-only dependencies and unit tests | Contracts; never runtime internals |
| `packages/contracts` | Pure browser-safe API schemas/types shared by server and client | Neither runtime nor UI; no database drivers, provider SDKs, Bun/Node APIs or credential handling |
| `packages/anthropic-subscription` | Private server-only subscription auth primitives and deterministic Anthropic request-profile adaptation; introduced in the provider block | No first-party dependencies; injected contracts SHALL NOT depend on runtime, UI or browser contracts |

The contracts package SHALL be introduced with the API block by extracting shared wire definitions, not duplicating schemas or moving server authority into the browser. Persistence, graph state and credential records SHALL remain runtime-private. Packages SHALL expose explicit public entry points; private shared TypeScript source exports are sufficient without a publication/declaration pipeline. Foundation work SHALL establish the runtime and UI package/configuration boundaries without implementing the console or creating a speculative contracts package. A package shell SHALL NOT be counted as delivered UI functionality or passing feature tests. Functional browser work remains after the real G2 and offline G4/G5 gates.

The private Anthropic package SHALL be consumed by the runtime through `workspace:*` and explicit public entry points, with its own Bun tests and typecheck included in the root check graph. It SHALL NOT depend on an OpenCode host/plugin package, LangChain or a provider SDK. Runtime-owned application assembly SHALL include its execution-used source/resources in the single image; UI and browser contracts SHALL NOT import it. It adds no service, standalone operational process or package-publication pipeline.

`Bun.serve` SHALL import the UI package's public HTML entry and serve its React/CSS assets alongside the API. The runtime's application build SHALL own the complete deployable output under `packages/runtime/dist/`, including the browser assets; the UI is a source package, not a second deployed server or a prerequisite standalone bundle. Docker SHALL build from the repository root with the frozen root lockfile and required workspace manifests/sources, preserving resolution of any dependencies not bundled into the output. Initial workspace pruning is deferred. The production image SHALL require neither Turbo nor a UI development server to serve requests. Runtime auth commands SHALL also run inside the runtime image. Development HMR/log forwarding SHALL NOT be enabled in operational serving. No Vite, Express, separate frontend server, ORM or package-publication tooling is needed.

**Task and cache contract.** Default scripts SHALL cover frozen installation, development/operational start, build, deterministic tests, type checking and linting. Root `check` SHALL aggregate repository lint, root-script and package typechecks, repository-script and package unit tests, and the application build. `check:verify` SHALL run the same graph with forced task execution for block acceptance. Root `test`, `typecheck` and `lint` scripts SHALL remain independently callable; package tests use `bun test`. Bare root `bun test` SHALL discover only safe offline suites, excluding historical spikes, integration/live fixtures and generated outputs. Explicit integration/live commands SHALL NOT be dependencies of ordinary `check` or `test`.

Turbo SHALL use local-only caching in Phase 1, with no remote-cache credentials or uploads. Cache keys SHALL include the applicable root configuration, lockfile, package inputs and transitive source dependencies, including source-only packages without a build task. Cacheable application builds SHALL declare their actual `dist/**` outputs; a hit SHALL restore the complete deployable output. Test reports, if emitted, SHALL have task-specific output paths rather than overlapping ownership of a shared directory. Development servers and operational start SHALL be uncached; persistent development tasks SHALL be marked persistent. Integration and live-provider tasks SHALL be uncached and SHALL retain their existing isolation/authorization gates. A cached log SHALL NOT be presented as newly executed acceptance evidence. Runtime credentials and owner fixture content SHALL NOT enter build inputs, browser bundles or cache artifacts.

**Alternatives:** a flat package couples browser/server dependency and test boundaries; separate deployed services add an unnecessary network/deployment boundary. Bun workspaces plus Turbo provide package-level checks while retaining one application. Host-native services and direct LAN HTTP reduce container setup, but contradict the clarified deployment preference and enlarge the listener's trust boundary.

### 2. A thin controller around one framework-owned agent definition

Each run SHALL use `createAgent` with a configured, unbound stock model instance, the three tools below, execution middleware, and the official saver. The selected tool-execution version is `v2`. Per-run model instances prevent shared mutable SDK authorization state between simultaneous runs; the underlying immutable definition is common.

The controller SHALL own run admission, graph invocation lifetime, state inspection, app transactions, and stream projection. It SHALL NOT choose the next model/tool step itself. Its public framework integration uses `wrapModelCall`, `wrapToolCall`, model lifecycle hooks, tool runtime context, dynamic `interrupt`, and ID-addressed `Command` resume values.

Initial and resumed invocations SHALL use the run ID as `thread_id`, explicit synchronous durability, a service-owned AbortSignal, and `updates`/`custom` streams. Browser request cancellation SHALL NOT propagate to that signal. Normal invocation configuration SHALL omit the `checkpoint_id` key entirely; read-only state inspection can use checkpoint references. Inspecting a run SHALL never invoke its graph.

The agent SHALL be invoked directly at the root graph namespace, never nested in a parent graph. The spike's completed pending-write reuse was root-only; adding a parent graph would change replay behavior.

The runtime SHALL expose native tool names `mcp_Read`, `mcp_Search`, and `mcp_AskUser`, with explicit JSON Schema literals. Tools SHALL NOT contain schema-generation metadata incompatible with the pinned provider profile. Completed model messages and tool activity are sufficient for live progress; raw token, reasoning, debug, and checkpoint streams SHALL NOT be exposed to the browser.

Read/search-only batches are permitted with bounded concurrency. A question SHALL be the sole tool call in its model response. Middleware SHALL refuse every call in a mixed question/read batch or a multiple-question batch, returning matching safe tool outcomes without dispatching any call. The agent can ask separately on its next model step. Missing or ambiguous tool-call IDs SHALL fail safely before tool dispatch. This avoids implementing a human-question scheduler or relying on a parallel-tool hint for correctness.

Graph control-flow exceptions SHALL propagate unchanged. Expected read/search refusals become safe tool results; cancellation, budget exhaustion, persistence errors, and fatal invariant failures SHALL reach the controller as typed failures, not assistant text that looks like successful completion.

**Alternatives:** a hand-written loop duplicates `createAgent`; a vendor agent SDK nests another loop; full Agent Server introduces deployment and protocol surface not required by the spec.

### 3. Application records and graph checkpoints have separate authority

One PostgreSQL database SHALL use separate `runtime` and `checkpoints` schemas. The official saver SHALL own the latter, including migrations and serialization. Bun SQL SHALL own the former. The application SHALL inspect saved graph state through supported APIs rather than treating private checkpoint tables as an application model.

All identifiers below are opaque to clients. Run, invocation, attempt, cancellation, and create-request IDs are UUIDs. Question and tool-operation identities are stable application identities derived from their logical call binding. Timestamps are UTC instants. Event sequence numbers are PostgreSQL integers serialized as decimal strings, avoiding JavaScript integer precision assumptions.

| Record | Required fields and identity |
|---|---|
| `Run` | `runId`, unique `createRequestId`, submitted-input digest, exact goal, workspace snapshot, provider binding, definition digest, budget maximum, confirmed dispatched count, reserved/unconfirmed attempt count, `state`, creation/last-activity times, `lastSeq`, revision |
| `ProviderBinding` | `provider: anthropic | openai`, `authMode: subscription`, model ID, transport-profile ID, credential-slot reference; no credential values |
| `WorkspaceSnapshot` | Owner-configured workspace ID and label, canonical container root, access-policy digest; not a source-code snapshot |
| `Question` | `(runId, questionId)`, logical tool-operation ID, exact prompt/input definition, payload digest, saved-state binding, disposition |
| `Invocation` | `invocationId`, `runId`, runtime-owner epoch, kind `initial | answer`, answer reference when applicable, start/end disposition; no restart dispatch queue |
| `ModelAttempt` | `(runId, attemptId)`, invocation ID, ordinal, provider/model/profile, admission time, dispatch evidence and safe completion metadata |
| `ToolOperation` | `(runId, operationId)`, model-message ID, provider tool-call ID, tool name, argument digest, disposition, bounded sanitized result |
| `Event` | `(runId, seq)`, recorded time, event discriminator/payload, unique per-run source key for replay deduplication |
| `ExecutionDefinition` | Immutable digest, dependency/integrity manifest, execution-code manifest digest, graph/tool/middleware/prompt/profile configuration and question protocol version |
| `RuntimeOwner` | Singleton owner ID/epoch and startup metadata; authority is conditional on the live database ownership lock |

`Run.state` SHALL be a validated discriminated union, not independent nullable result/error/question columns:

| Discriminator | Required payload; other variants' payloads forbidden |
|---|---|
| `working` | Active invocation ID and owner epoch |
| `waiting` | Pending question ID and saved-state binding digest |
| `cancelling` | Cancellation ID, accepted time, invocation reference if local work is still settling |
| `succeeded` | Finished time and recorded final assistant-result reference |
| `failed` | Finished time and typed failure |
| `cancelled` | Finished time, cancellation ID and accepted time |
| `interrupted` | Detection time, last recorded activity time and interrupted invocation reference |

`Question.disposition` SHALL be exactly one of `pending`, `answered { answer, acceptedAt, invocationId }`, or `closed { reason, closedAt }`. Closed questions preserve their original content and have no accepted answer. A question answered before later cancellation remains answered; cancellation does not erase the decision.

`ToolOperation.disposition` SHALL distinguish `started`, `paused { questionId }`, `completed { outcome: ok | refused | error, result }`, and `abandoned { reason }`. Question replay is special: an accepted answer SHALL NOT cause the wrapper to bypass the framework interrupt call.

The database SHALL enforce: one pending question per run; one accepted answer per question; one current invocation for a working run; unique event sequence/source keys; and unique logical call registration. A reused provider tool-call ID with a different model-message binding or arguments is an invalid call, not a cache hit. The same persisted call reuses its operation identity and completed read/search result; identical arguments with a new call ID are new work.

**Physical storage contract.** Application tables SHALL use the `runtime` schema; saver tables remain in `checkpoints`. UUID, text, integer, bigint, timestamptz and jsonb below denote PostgreSQL types. Named JSON objects SHALL have strict runtime decoders and database checks for their discriminator, required keys and primitive types. Unknown authority-bearing fields SHALL be rejected.

| Table | Columns and constraints |
|---|---|
| `runs` | `run_id uuid PK`; `create_request_id uuid UNIQUE NOT NULL`; `input_digest text NOT NULL`; `goal text NOT NULL`, nonblank and at most 8 KiB; `workspace jsonb NOT NULL`; `binding jsonb NOT NULL`; `definition_digest text FK execution_definitions`; `budget_max integer > 0`; `consumed integer >= 0`; `unconfirmed integer >= 0`; `state jsonb NOT NULL`; `revision bigint >= 0`; `last_seq bigint >= 0`; creation/last-activity timestamptz fields. `consumed + unconfirmed <= budget_max`. |
| `questions` | Composite PK `(run_id uuid, question_id text)`; `operation_id text`; prompt/input/binding/disposition payloads; payload and binding digests; creation time. Same-run FK to the tool operation. Partial UNIQUE on `run_id` where disposition is pending. |
| `invocations` | Composite PK `(run_id uuid, invocation_id uuid)`; owner epoch bigint; kind `initial` or `answer`; question reference present iff kind is answer; start time; disposition `active`, `settled` or `interrupted`, with end time iff not active. Partial UNIQUE on `run_id` where active. |
| `model_attempts` | Composite PK `(run_id uuid, attempt_id uuid)`; same-run invocation FK; positive per-run ordinal with UNIQUE `(run_id, ordinal)`; admission time; validated attempt-state payload defined in Decision 8. |
| `tool_operations` | Composite PK `(run_id uuid, operation_id text)`; nonempty model-message ID and provider tool-call ID; UNIQUE `(run_id, provider_tool_call_id)`; tool name; validated arguments and argument digest; disposition/result payload; creation time. |
| `events` | Composite PK `(run_id uuid, seq bigint)` with `seq > 0`; recorded_at timestamptz; event kind and validated payload; `source_key text NOT NULL`; UNIQUE `(run_id, source_key)`. |
| `execution_definitions` | `digest text PK`; complete immutable manifest jsonb; creation time. |
| `runtime_owner` | Singleton key constrained to 1; owner UUID; positive epoch bigint; startup time. Epoch values in historical invocations are snapshots, not foreign keys to the mutable current epoch. |

Workspace and provider-binding objects SHALL require exactly the fields defined above. Provider and auth-mode values SHALL be constrained to the enabled Phase-1 pairs. Digests SHALL be lowercase SHA-256 hex strings.

The run-state JSON discriminator and payload SHALL obey the existing variant table through CHECK constraints: required variant keys are present and correctly typed, other variants' keys are absent. Same-run invocation, question and result-event references SHALL be enforced through extracted reference columns and foreign keys. `succeeded` is the wire/database token displayed as “Completed”; it is not a second state.

Question disposition checks SHALL use answer-property presence, not truthiness: JSON null and false remain valid answered values. Pending and closed variants SHALL contain no accepted-answer payload. Cross-row consistency—such as a waiting run referencing its sole pending question—SHALL be enforced at transaction completion by same-run references and deferred constraint checks.

Operation IDs SHALL be SHA-256 over the canonical tuple `(runId, modelMessageId, providerToolCallId)`. A question ID SHALL equal its sole question-operation ID. Model-message IDs SHALL be assigned once before checkpoint persistence and remain stable on replay.

Event source keys SHALL be namespaced by logical source and phase: creation request, invocation/status revision, model attempt/phase, model message, tool operation/phase, question/disposition or cancellation request. Reobserving the same key with the same payload is idempotent; a different payload is an invariant failure. Source keys SHALL NOT be derived only from tool arguments.

**Alternative:** storing only graph messages cannot establish exact owner decisions, browser replay, or terminal-state authority. A generalized effect ledger is unnecessary for this read-only, non-recovering phase.

### 4. Singleton runtime ownership and short dispatch gates

The service SHALL acquire a dedicated-session PostgreSQL advisory lock for this runtime database/schema before migrations or startup reconciliation. A second instance SHALL fail readiness rather than inspect/reclassify another live instance's work. The connection SHALL remain reserved; returning it to a pool is not equivalent to unlocking it.

Within the owner process, a per-run single-flight executor SHALL cover state verification, initial/resume invocation, stream settlement, and the final application transition. A separate short per-run dispatch gate SHALL serialize model/tool admission, answer acceptance, cancellation, and terminal commits. Cancellation SHALL NOT wait for the lifetime executor lock or an entire provider response.

Application transitions SHALL validate owner epoch, expected state/revision, and invocation identity. Event sequence allocation SHALL serialize on the same run record, making visible order agree with committed transitions, not merely with an independent sequence allocator. Status/detail, affected question or budget records, and their events SHALL commit atomically.

No transaction or dispatch gate SHALL remain held during a provider response or human wait. The short gate does include the durable admission decision and initiation of local I/O, closing the read-cancellation-then-fetch race. In-flight work initiated before cancellation acceptance remains subject to best-effort abort.

Loss or replacement of the ownership session SHALL disable dispatch and make the service fail-stop. The implementation SHALL verify the reserved connection's identity and lock ownership, including before dispatch; it SHALL NOT silently reconnect and continue under a lost lock. Epoch checks fence stale app writes. Old active runs are never taken over by a new process, even if late graph writes from the old process exist.

The saver integration SHALL construct its pool through the public constructor boundary so pool and checked-out-client errors can be handled without private-field reflection. This is the approved checkpointer-only `pg` exception. Application and saver pool sizes SHALL be budgeted together.

**Atomicity boundaries.** Each row describes one application transaction, not an ordered implementation recipe.

| Operation | Changes that SHALL commit together | Protected invariant |
|---|---|---|
| Create run | Idempotency binding, run, initial invocation and creation/status events | An accepted start has one durable run and invocation |
| Record activity | Source-key deduplication, event sequence allocation, event and last-activity metadata | Cursor order agrees with committed history |
| Publish question | Settled invocation, question/binding, waiting state and question/status events | Answerability never precedes verified persistence |
| Accept answer | Conditional question decision, new invocation, working state and answer/status events | At most one accepted answer and continuation owner |
| Reserve request | State/epoch check, attempt reservation, budget capacity and admission event | No unreserved model dispatch or budget overspend |
| Confirm request dispatch | Attempt evidence, reserved-to-consumed accounting and dispatch event | Public confirmed counts match recorded evidence |
| Cancel | Cancellation identity, unanswered-question closure, run state and cancellation/status events | No acceptance acknowledgement without durable cancellation |
| Finalize | Conditional terminal state, invocation disposition, applicable question closure and final events | Exactly one terminal outcome; late work cannot replace it |
| Reconcile startup | Per-run interruption/cancellation classification, invocation/attempt disposition and events | No automatic redispatch of prior active work |

Saver writes and issuer credential rotation remain outside these transactions. Credential-file replacement has its own durability boundary; neither cross-driver nor provider/local atomicity SHALL be claimed.

The initial Bun SQL pool maximum SHALL be five: one reserved ownership session, one temporary migration reservation, and at least three ordinary connections during migration. The saver pool maximum SHALL be four. PostgreSQL capacity SHALL exceed the combined nine connections plus operator/maintenance headroom. No connection is reserved per active run. Ownership-session idle/lifetime retirement SHALL be disabled where supported and verified by the pinned Bun integration gate; any unexpected loss remains fail-stop.

**Alternative:** dedicated per-thread database leases remain viable for multiple executors, but a single service owner plus per-run serialization is smaller for this phase. Distributed fencing, queues, and automatic executor takeover are not introduced.

### 5. Exact human-input shapes and idempotent acceptance

The question tool SHALL support these bounded input variants:

| `input.kind` | Shape | Accepted answer |
|---|---|---|
| `text` | `minLength`, `maxLength`, with maximum 8 KiB | A string satisfying the bounds; empty only if permitted |
| `choice` | `multiple: false`, ordered nonempty options `{ label, value }` | One exact option value |
| `choice` | `multiple: true`, ordered options and selection-count bounds | A distinct set of option values, canonically ordered by the declared options |

Choice values SHALL be JSON scalars: string, finite number, boolean, or null. Type matters: `false` is not `"false"`. Prompts SHALL be bounded to 16 KiB, option counts to 50, and labels to 256 characters. Unsupported definitions are safe tool refusals, not unconstrained schemas or guessed UI controls.

Every answer submission SHALL name its run and question and contain an `answer` property. Validation SHALL check property presence and the declared input variant, never truthiness. Duplicate comparison uses the validated canonical answer; text is not silently trimmed or rewritten. A matching accepted answer returns the recorded acceptance without another invocation, even when the run subsequently finished. A different answer returns a conflict. Wrong-run/unknown questions and closed questions cannot target the current question by inference.

The saved-state binding SHALL include thread/run ID, opaque checkpoint namespace, checkpoint ID, task ID, interrupt ID, ordinal zero, logical tool-call identity, question payload digest, required-state digest, and execution-definition digest. The question tool SHALL execute exactly one interrupt with a deterministic payload and no non-idempotent prefix. Resume data SHALL be an ID-addressed object containing `questionId` and the typed answer, so a negative answer is enclosed in a truthy envelope. The tool SHALL check the returned envelope against the recorded acceptance before returning its tool result.

**Alternative:** bare values, positional “answer the latest question” requests, and polling an accepted-answer table instead of calling `interrupt` on replay lose either negative answers, identity, or framework resume semantics.

### 6. Checkpoint settlement precedes answerable questions

A streamed interrupt is only a candidate pause. A question SHALL become answerable only after the graph stream has settled successfully, all saver writes have completed, and read-only inspection confirms the matching saved head/task/interrupt and required state. Under continued exclusive ownership, one application transaction SHALL publish the exact question, its binding and events, and `working → waiting`. Neither graph stream notifications nor historical interrupt rows are the pending-question authority.

Before accepting an unanswered question, the controller SHALL establish compatibility and the exact pending binding without invoking the graph. It SHALL then atomically record the answer, mark the question answered, allocate its invocation, change the run to working, and append the answer/status events. Only the transaction winner can dispatch the corresponding resume command, and only after confirmed acceptance. No accepted-answer replay queue is created.

Validation of a pending submission SHALL follow this precedence: request shape and identity; already-answered/closed disposition; current waiting binding; answer constraints; saved-state/definition compatibility; required workspace/provider availability; conditional acceptance. Fresh prerequisites SHALL NOT invalidate a duplicate acknowledgement. An exhausted model budget SHALL NOT prevent recording a valid human answer: the next model-request admission, if needed, produces the specified step-limit failure.

Confirmed missing, unusable, or incompatible graph state SHALL atomically close the unanswered question and produce `failed / continuation_unavailable`. A temporary inspection failure SHALL instead return an unavailable response and leave the last committed state unchanged. The console SHALL show the inability to continue, not falsely claim that a terminal failure was saved.

Separate saver and application commits yield explicit crash windows:

| Last committed application condition | Behavior after ordinary restart |
|---|---|
| Working, no saved question yet | Interrupted; last recorded progress retained |
| Working, graph interrupt saved but app question uncommitted | Interrupted; orphan checkpoint does not create an answerable question |
| Waiting, unanswered question committed | Waiting; a later answer requires fresh read-only compatibility/binding verification |
| Answer committed and run working, resume not yet dispatched | Interrupted; answer retained and never redispatched |
| Graph finished, application final outcome uncommitted | Interrupted; graph output does not reconstruct success |
| Cancellation accepted, including cancelling | Cancelled; no resume |
| Terminal outcome committed | Same terminal outcome |

An ambiguous application commit SHALL block dispatch until readback establishes its outcome under the same live owner. A client response SHALL distinguish `acceptance_unknown` from a confirmed rejection; retrying the same request is safe. If ownership or certainty cannot be maintained, the service SHALL fail-stop rather than perform work that might be a duplicate.

**Alternative:** a transaction spanning Bun SQL and the saver does not exist. Publishing questions on interrupt emission, resuming to test compatibility, or reconstructing success from checkpoints would violate the spec.

### 7. Compatibility compares the current implementation against the stored run binding

Continuation SHALL rebuild the candidate agent using the run's stored provider, auth mode, model, profile configuration and workspace policy—not current defaults for new runs. Changing a default model alone SHALL NOT invalidate a paused run. If its recorded binding can no longer be constructed or permitted, continuation SHALL fail visibly rather than substitute another binding.

The execution-definition digest SHALL cover canonical JSON containing:

| Field | Compared content |
|---|---|
| `protocolVersion` | Question payload, resume-envelope and application continuation-contract versions |
| `runtimeVersion` | Exact Bun version |
| `packages` | Versions and integrity identifiers for the selected runtime dependency closure, including framework, serializer, saver and selected provider integration |
| `executionCode` | Sorted module/resource paths and SHA-256 content digests for agent assembly, middleware, tools, executor, run-transition logic, selected provider adapter and their owned transitive dependencies |
| `graph` | Sorted generated nodes/edges and declared state-schema digest |
| `middleware` | Ordered identities and configuration digests |
| `tools` | Tool names and input/output schema digests |
| `promptDigest` | Effective system-prompt digest |
| `runBinding` | The run's stored provider/auth-mode/model/profile configuration and workspace-policy digest |

The execution-code manifest SHALL be generated from explicit execution roots and their owned import/resource closure. Dynamic dependencies SHALL be declared. Digests SHALL use source/resource content with normalized line endings, not Git revision, deployment time or whole-image identity. Browser-only assets, unrelated development dependencies, credentials, expiry, default settings for future runs and workspace contents SHALL be excluded. Changes to a tool body or resume-critical helper SHALL change the manifest even when names and schemas do not.

Monorepo package boundaries SHALL NOT replace that execution closure. The selected provider's execution-used source/resources in `packages/anthropic-subscription` and their relevant dependency closure SHALL be included through workspace-aware resolution; the closure SHALL NOT stop at the runtime package directory. UI sources/dependencies used only for application asset assembly SHALL remain excluded; shared contract modules used by execution and their relevant dependencies SHALL be included. Changes confined to browser code, browser-only dependencies or development tooling SHALL NOT invalidate a waiting run merely because the root lockfile, application bundle or Turbo cache key changed. Turbo task hashes SHALL NOT serve as execution-definition digests.

The current manifest SHALL be constructed for the stored run binding and compared with the saved manifest. Exact equality remains the conservative policy: some harmless execution-code changes can refuse continuation, but redeploying identical execution content or changing only browser assets SHALL NOT do so.

The required-state digest SHALL cover the saved checkpoint's channel-value/version maps and the read-only state's pending next/task/interrupt bindings. The canonical representation SHALL preserve message type, ID, content, tool calls/results and provider replay metadata; object keys are sorted, arrays retain order, and typed serializer tags and scalar types are preserved. Credentials and application decision disposition are not inputs. The selected serializer/normalizer is part of the execution definition.

At publication and continuation, inspection SHALL independently require a usable messages channel and exactly the expected pending question tool call/interrupt. A matching digest is not a substitute for structural validation. Missing referenced state, ambiguous interrupts or an unsupported serialized value SHALL fail closed. Temporary inspection failure SHALL remain distinct from confirmed incompatibility.

Normal invocation SHALL target the latest verified head without explicitly replaying an older checkpoint. Ordinary repository edits do not alter the execution definition; completed tool results remain recorded and later intentional reads see current contents.

**Alternative:** a hand-maintained schema version or generated function text alone can miss changed behavior. Hashing an entire deployment would unnecessarily invalidate questions for unrelated changes.

### 8. Physical-request budgets and cancellation share the terminal boundary

The default budget SHALL be 50 model requests, configurable by the owner as a positive finite integer. The chosen maximum is snapshotted per run. The public count is model requests, not graph supersteps or completed model callbacks. Tool calls from the final permitted response can finish or ask a question; only another model request exceeds the limit.

All physical model requests SHALL pass an injected terminal transport gate after credential resolution and profile validation. That gate SHALL recheck owner/run/invocation state, cancellation and remaining budget. SDK and LangChain automatic retries SHALL be disabled, including per-call overrides. Initially, generic network/rate-limit retries are disabled; at most one explicit credential-renewal retry is allowed after a recoverable authorization rejection. It SHALL pass the same gate and consume another model step. Auth exchange/refresh traffic consumes no model steps.

The built-in model-call limiter and graph recursion limit SHALL NOT be the authoritative budget: they count different events and can manufacture assistant messages. A separate graph recursion safety bound SHALL be derived generously from the configured request budget; hitting it is a runtime invariant failure, not a successful answer or a misreported model limit.

HTTP submission and PostgreSQL commit cannot be atomic. `ModelAttempt` SHALL distinguish reserved admission, confirmed local dispatch, completed attempt, known abandoned-before-dispatch, and dispatch-unconfirmed. Reservation occupies capacity before I/O; a request SHALL NOT dispatch without durable reservation. Local dispatch evidence SHALL be persisted before its response can cause further agent work. The public budget SHALL report confirmed consumed steps plus any unconfirmed admission separately, never pretend that an uncertain attempt was known sent or known unsent. Unconfirmed admission remains conservatively charged against capacity. A crash in that gap interrupts the run; it does not authorize a retry or affect any resumable waiting run, which has no unsettled attempt.

Cancellation acceptance SHALL atomically record its identity, invalidate unanswered-question acceptance, and change state under the same dispatch gate. It SHALL abort service-owned invocation/request signals and prevent subsequent admissions. The controller SHALL track actual local in-flight operations, including streaming bodies; a rejected graph promise alone does not prove they stopped. `cancelling` remains visible until local work settles. Late outputs can be discarded and SHALL NOT overwrite a cancelled outcome.

Request deadlines SHALL cover the full request/body lifetime, not just response headers or socket inactivity. The default model-request deadline is five minutes, owner-configurable. Signals SHALL compose run cancellation with the deadline and honor pre-aborted signals. None comes from the browser connection. A model timeout is `provider_failure`, distinct from a step-limit failure.

**Alternative:** counting `afterModel`, checking cancellation before an unrelated await, or relying only on AbortSignal leaves hidden-request, overspend, or check-then-dispatch races.

### 9. Provider identity, auth mode, credentials, and transport are separate

The application SHALL have a small explicit provider-binding registry, not a generic plugin platform. Each entry supplies: supported provider/auth-mode pair, configured model/profile, credential lifecycle adapter, stock model construction, guarded terminal transport, and safe error classification. Phase 1 registers only `(anthropic, subscription)` and `(openai, subscription)`.

Model IDs SHALL be required owner configuration, not inferred from historical spike IDs or an SDK's capability table. The binding SHALL reject an unsupported model/profile combination before model dispatch. The selected pair/model/profile remains fixed for a run; credential generations can renew behind its slot reference.

A later `api_key` mode can add a credential adapter, endpoint/profile and explicit selection without duplicating run states, the question protocol, budget accounting, or the agent loop. It is not a different provider named `anthropic-api`, and it SHALL NOT appear as an enabled branch now. Ambient API keys, alternate base URLs, gateways, insecure TLS settings, proxy overrides and tracing/debug configuration SHALL NOT silently modify the selected subscription path.

Startup SHALL refuse configuration that enables LangSmith tracing or legacy LangChain tracing, including enabled LANGSMITH_TRACING or LANGCHAIN_TRACING_V2. Custom remote tracing callbacks SHALL NOT be registered in Phase 1. This does not disable the application's sanitized local history and diagnostics.

Credential records SHALL live only in the private runtime volume, outside workspace access and PostgreSQL run/checkpoint records. Their versioned shape SHALL include provider/auth mode, slot ID, generation, lifecycle state, access/refresh material, explicit epoch-millisecond expiry, and required provider account metadata. Ready, reauthorization-required, and temporarily-unavailable outcomes SHALL be distinguishable without exposing secrets.

Refresh SHALL use provider-scoped single-flight and a cross-process lock shared by runtime and operator auth commands. The guarded ownership interval covers rereading current credentials, provider refresh, partial-field merge, and durable replacement—not only the persistence callback. A newer usable generation wins over stale memory. Omitted refresh tokens SHALL preserve the prior value. Reauthorization and refresh SHALL use the same exclusion boundary.

Credential replacement SHALL be complete, atomic within the volume, restrictive (`0700` directories/`0600` records), and acknowledged only after durable persistence. Incomplete writes and invalid records SHALL fail closed. Refresh begins within five minutes of expiry; definitive rejection marks reauthorization required and stops automatic retries. Upstream token rotation and local persistence are not one transaction: a crash between them can require reauthorization, which SHALL be reported honestly.

Auth is an operator setup action inside the container, not an agent tool or a run question. Documentation SHALL provide provider-specific headless login/reauthorization commands. Browser run APIs expose only safe provider readiness metadata, not callbacks, codes, tokens, or credential files. This is compatible with adding another explicit auth mode later without building that UI now.

**Alternative:** a single “provider token” string conflates provider, billing route, principal metadata and lifecycle. Importing whatever ambient credential a stock SDK discovers would permit unintended billing.

### 10. Maintain a minimal internal Anthropic subscription package

The runtime SHALL use `packages/anthropic-subscription`, a private source-level derivative of the owner-maintained plugin's v2 auth/profile code, behind stock ChatAnthropic's injected transport. LangChain/LangGraph SHALL remain the execution engine. Neither OpenCode hosting nor a fork/subclass replacement of the stock model or SDK is part of this decision.

**Provenance and ownership.** The reviewed extraction baseline is `@ex-machina/opencode-anthropic-auth@2.0.0-next.5`, upstream revision `156cb66c6889e1be3ad2b839345ea409942ab40f`, whose published tarball integrity is `sha512-EBnFXXBCbd1rl496OydEBqMRqcuqAgpjFH1vhWio0Lw+hZHzzwFWoabrRDSKE3gC09Knd7Q6+lp4DvAOt0qjWw==`. Research verified those package bytes, not their integration or live operation. Implementation SHALL retain applicable MIT/copyright notices and record the upstream source paths, selected material and intentional differences. This is an explicit internal derivative, not an installed plugin, runtime deep import or claim of an upstream-supported standalone API.

The project SHALL own maintenance of the derivative. Upstream changes SHALL be reviewed and selectively incorporated, with updated provenance and regression evidence; moving tags, automated synchronization and silent profile updates SHALL NOT change deployed behavior. No new upstream release is required. Editing the separate upstream repository remains outside this change's authorization.

**Package boundary.** The package SHALL provide a small documented public surface with independently testable auth and request-profile operations:

| Operation | Required contract |
|---|---|
| Begin subscription login | Produce the authorization URL and private flow state needed for PKCE/state validation. No browser launch, credential-file access, API-key creation or OpenCode interaction. |
| Exchange subscription authorization | Require the matching login state and verifier; use injected auth transport and signal; return validated access/refresh material and absolute epoch-millisecond expiry, or a safe typed failure. No automatic exchange retry. |
| Refresh subscription authorization | Independently callable through injected auth transport and signal; return validated access material/expiry and optional replacement refresh/account fields. Omission SHALL remain distinguishable from an invalid supplied value so the runtime can merge safely. No automatic retry of an ambiguous rotation. |
| Adapt an inference request | Apply the explicitly selected, immutable profile's required headers, URL/query and body transformations using injected credential resolution and a guarded terminal. Native tool names and tool-call/result relationships SHALL remain unchanged; response bytes SHALL NOT be rewritten. Non-subscription credentials SHALL fail closed. |
| Report failures | Return an allowlisted operation/reason and safe status metadata sufficient to distinguish invalid input/state, definitive authorization rejection, temporary transport/issuer failure, cancellation and unsupported response/profile behavior. Raw bodies, credentials and arbitrary upstream exception text SHALL NOT be exposed. |

The extracted surface SHALL be limited to the auth/PKCE primitives, profile constants and necessary header, system/billing-body and bounded parsing helpers. OpenCode hooks, connection/session management, credential-store integration, alias tables, response-name rewriting, automatic version recovery, API-key modes and unrelated plugin features SHALL NOT be carried over. Profile data SHALL be explicit rather than read from ambient environment overrides. Request-profile behavior includes the declared client version, required beta headers/query and leading-user-text-dependent billing metadata; unsupported model/profile combinations SHALL be refused before dispatch.

The runtime SHALL continue to own credential storage, provider-scoped locking, refresh coordination, generation selection, durable replacement, safe diagnostics, admission, request budgets and the sole permitted renewal retry. All auth and inference I/O SHALL use their separately injected policy-enforcing transports and honor their signals/deadlines. The package SHALL have no autonomous persistence, retry loop, global-fetch interception or network fallback. Shared refresh settlement remains governed by Decision 9: an abandoning waiter does not cancel another caller's already-started rotation.

Native `mcp_Read`, `mcp_Search`, and `mcp_AskUser` names SHALL be verified unchanged on request, fragmented response and replay paths. Removing upstream aliases/response transformations is an intentional divergence, not byte-for-byte parity with the full plugin. Offline golden fixtures SHALL independently establish unchanged profile behavior and explicitly enumerate approved differences; expected outputs SHALL NOT be generated solely by the implementation under test. Bounds, parsing, partial-refresh support and injection adaptations SHALL likewise be recorded as deliberate differences rather than silently inherited assumptions.

Stock `ChatAnthropic` SHALL use an explicit non-secret sentinel API key, disabled SDK/LangChain retries including call-level overrides, and `clientOptions.dangerouslyAllowBrowser: false`. The existing guarded terminal SHALL remain the final inference-I/O authority. Conversation replay SHALL preserve complete provider metadata, the leading user text and tool-call/result relationships. Provider-stream validation SHALL refuse truncated or unsuccessfully terminated responses before any partial message becomes graph state; this validation does not authorize response rewriting.

**Acceptance.** G2 SHALL exercise the actual internal package's public surface using synthetic issuer/transport fixtures, including cancellation, exact endpoint/redirect restrictions, partial rotation, safe errors and independent request counters. Test doubles MAY exercise consumer failure paths but SHALL NOT substitute for package acceptance. G2 and actual-package offline G4/G5 remain mandatory before console work; live journeys retain their separate fresh-authorization gates. New-package source/resources SHALL participate in the execution definition and runtime-owned image as required by Decisions 1 and 7.

**Alternatives:** waiting for upstream public exports adds delivery work the owner chose to avoid; a full plugin fork retains unnecessary host machinery; forking LangChain or the provider SDK increases maintenance without removing a demonstrated limitation of their public transport seam. A narrow internal derivative removes the release dependency while making its provenance, intentional divergence and maintenance responsibility explicit. It does not weaken dispatch, credential or replay guarantees.

### 11. OpenAI extraction retains Responses semantics and independent auth

OpenAI SHALL use stock `ChatOpenAI` in streaming Responses mode against the configured subscription profile, with no shared Anthropic auth assumptions. The device-login, credential-rotation and transport spike is reference evidence, not an imported runtime dependency.

The adapter SHALL preserve the documented device initiation/poll/exchange distinctions: polling 403/404 responses are not inference authorization failures. Tokens and required account metadata SHALL come from one coherent credential generation for a dispatched request. Decoded identity claims are routing metadata received through the trusted issuer flow, not locally verified authorization policy.

The model endpoint SHALL be exactly the configured HTTPS Codex Responses endpoint. The adapter SHALL preserve stateless message replay, matching function-call IDs and encrypted reasoning metadata while excluding those internals from browser history. A complete tool-argument fragment SHALL NOT count as a complete provider response: truncated streams or missing successful terminal markers are provider failures.

Bun-native fetch is preferred when it passes the request-profile fixtures. The spike's `node:http` terminal can run through Bun's compatibility API only if required wire parity and signal/body behavior are reverified; that is not a Node runtime fallback. Header stripping, profile fields and parameter support SHALL be tested for the selected model rather than generalized from one captured model.

Both providers SHALL enforce separate exact HTTPS origin/port/method/path policies for auth and inference, and SHALL reject unvalidated redirects before forwarding credentials. Credential resolution is outside the model-step count; every terminal inference dispatch is inside it. No library path may silently bypass this boundary.

**Alternative:** a provider-name string passed to the harness can initialize an unintended API client. A parsed first-turn tool call alone is insufficient evidence of OpenAI tool-result or human-resume compatibility.

### 12. Bounded workspace tools and secret-safe projections

The owner SHALL configure one workspace ID/root for this runtime deployment. Every run snapshots that selection. Neither HTTP start requests nor model arguments can nominate another root. A later multi-workspace selection can be added without changing the run's workspace binding shape.

| Tool | Input contract | Safe result |
|---|---|---|
| `mcp_Read` | File mode: `{ mode: file, path, startLine?, lineLimit? }`; directory mode: `{ mode: directory, path, afterName?, entryLimit? }`; paths relative to the configured root | File mode returns numbered UTF-8 lines and bounds; directory mode returns filtered entries `{ name, kind: file \| directory, sizeBytes? }`, truncation and next-name cursor; both return typed refusals/errors |
| `mcp_Search` | Literal query, optional relative subtree and match limit | File/line matches, scan bounds and incomplete/truncated indication, or typed refusal/error |
| `mcp_AskUser` | Prompt and the question-input union in Decision 5 | The exact accepted typed answer after verified resume |

Read/search SHALL reject absolute/escaping paths, symlink entries or components, special files, runtime credential/configuration locations, and excluded secret files. Enumeration and the actual read SHALL share the same policy; a glob match is not authorization. Component-aware canonical containment and before/after identity checks SHALL refuse changed targets rather than use stale path checks. Known credential-file hard-link aliases SHALL also be excluded. Search SHALL NOT spawn an agent-specified command.

Initial bounds SHALL be: one MiB per text file, 200 default/2,000 maximum returned read lines, 100 search matches, 2,000 examined files, 16 MiB total scanned text, and 64 KiB returned content per tool call. Binary files and default `.git`/dependency-directory traversal are excluded. Reaching a bound SHALL be visible, never represented as a complete negative search. These values are operator policy, not authority the model can widen.

Directory mode SHALL accept `.` for workspace discovery, return entries in name order, and default to 200 entries with a maximum of 2,000 and the same 64-KiB result bound. It SHALL apply the same path, symlink, special-file and credential exclusions as file reads before returning entry metadata. Directory pagination is not a filesystem snapshot; concurrent ordinary edits can change later pages, which SHALL be documented. Directory reading is part of workspace reading, not an additional permission.

Read-only mounts prevent container writes but do not prevent a host process from changing a mounted tree. The supported threat model excludes hostile concurrent mutation; stronger root-relative OS file-opening enforcement is deferred explicitly, not claimed by the path checks. The system is not general secret discovery or data-loss prevention: permitted repository content is sent to the selected provider.

Provider credential values SHALL remain only in the credential/transport boundary. Goal/answer inputs containing recognized live credential material SHALL be rejected rather than silently changed. Tool outputs and model responses SHALL be checked before entering graph state, events or results. The model wrapper SHALL return only sanitized complete messages; tool results SHALL be sanitized before their wrapper returns. SDK/error paths SHALL use allowlisted codes and safe metadata, not raw request/response objects or arbitrary exception text. Raw tracing and browser token streaming remain disabled. Synthetic-secret checks SHALL include split streaming fragments and failure paths, not just completed console text.

Exact matching SHALL cover credentials from each generation before its request is dispatched and retain coverage until all responses using that generation have been sanitized or safely discarded, including after cancellation and rotation. Bounded retention SHALL NOT evict a still-referenced generation merely because newer generations arrive. At capacity the implementation SHALL preserve existing protection and fail closed before admitting work it cannot screen. Provider integration SHALL verify this under rotation pressure; a fixed recent-generation cache alone is not evidence of in-flight coverage.

**Alternative:** `.gitignore`, read-only Docker mounts, UI-only redaction, or a prompt telling the model not to access secrets does not enforce this contract.

### 13. Narrow REST commands and application-owned replay SSE

The console SHALL use app-owned JSON REST plus native EventSource, not the broader Agent Streaming Protocol. That protocol and its frontend adapters can serve custom backends; a commercial server is not the reason for rejecting them. The reason is that thread branching/state injection and transient replay do not replace this application's exact decision and durable-history contracts.

API shapes SHALL be versioned under `/api/v1`. Inputs reject unknown authority-bearing fields. Run IDs and question IDs are explicit; clients cannot submit graph commands, checkpoint IDs, tool sets, paths, arbitrary configuration or credentials.

The server routes in `packages/runtime` and browser client in `packages/ui` SHALL consume the shared wire schemas/types from `packages/contracts`. Shared validation SHALL NOT substitute for runtime authorization, saved-state verification or transaction checks. Internal run/checkpoint/credential representations SHALL NOT be exported merely to reuse their types in the browser.

| Endpoint | Request | Success contract |
|---|---|---|
| `GET /options` | None | Workspace label, enabled providers/models/auth modes, safe readiness state, default budget; no secrets |
| `POST /runs` | `{ requestId, goal, provider }` | `202` with the durable run snapshot and cursor; identical request ID/content returns the original run; conflicting content is `409` |
| `GET /runs` | Bounded pagination cursor/limit | Run summaries containing identity, goal, provider, status, start/last-activity times |
| `GET /runs/:runId` | None | `{ run, throughSeq }` from a consistent snapshot, including current question or terminal detail when applicable |
| `GET /runs/:runId/events` | `after`, optional fixed `through`, bounded page limit | Ordered committed events and next cursor; fixed-upper-bound pagination for initial history |
| `GET /runs/:runId/stream` | Initial `after` cursor; reconnect `Last-Event-ID` | SSE replay/live tail of committed events strictly after the validated cursor |
| `POST /runs/:runId/questions/:questionId/answer` | `{ answer }` | `202` with recorded acceptance and current run snapshot; equal already-accepted answer returns `200` without invocation |
| `POST /runs/:runId/cancel` | `{ requestId }` | `202` for accepted cancellation, `200` for its idempotent repetition; attempts to change a terminal outcome return `409` |

Goal length SHALL be bounded to 8 KiB. Shape/answer errors are `400`; Host/Origin refusals `403`; unknown run/question `404`; stale/conflicting/closed input, unavailable configured binding, or confirmed continuation refusal `409`; temporary storage/inspection unavailability or uncertain commit `503`. Responses SHALL use `{ error: { code, message, runId?, questionId?, retryable, acceptance: not_accepted | unknown | already_accepted } }`, omitting inapplicable IDs. A definitive run failure and its HTTP response are different concepts: `503` does not fabricate a durable failed run.

Common validation SHALL precede endpoint handling: Host/Origin and content-type checks; bounded parsing; identifier/envelope validation. No failed mutation SHALL be acknowledged as accepted.

| Endpoint | Endpoint-specific precedence and responses |
|---|---|
| Create run | Existing request ID: matching content returns the original run, differing content is `409 request_conflict`; otherwise goal/provider validation `400`, configured workspace/provider prerequisites `409`, conditional create; storage uncertainty `503 acceptance_unknown` |
| Answer question | Run/question existence `404`; answered disposition first: equal canonical answer `200`, different answer `409 answer_conflict`; closed question or non-waiting run `409 not_answerable`; answer constraints `400 answer_invalid`; temporary verification failure `503 cannot_verify`; confirmed invalid continuation `409 continuation_unavailable`; remaining prerequisites `409`; conditional acceptance |
| Cancel run | Run existence `404`; matching accepted cancellation ID returns its recorded disposition `200`; terminal or already-owned conflicting cancellation `409`; conditional cancellation; uncertain commit `503 acceptance_unknown` |
| Run detail/history | Existence `404`; malformed pagination `400`; unavailable storage `503` without a fabricated current state |
| Event stream | Existence `404`; validate decimal cursor and run binding `400`; cursor ahead of committed history `409 cursor_ahead`; replay then tail; post-header outages use the unsequenced availability indication |

Definitive mutation refusals SHALL report `acceptance: not_accepted`; uncertain commits SHALL report `unknown`. An identical accepted answer SHALL be acknowledged before fresh compatibility/provider checks or terminal-state refusal. Atomic race losers SHALL reread the winning disposition rather than dispatch their own continuation.

The run snapshot SHALL expose the state union, provider binding without credential references, workspace label/root, goal, times, and budget `{ maximum, consumed, unconfirmed }`. The configured root is the container workspace path, not an arbitrary host path supplied by a browser. Confirmed failure closes the question in the same transaction; an unavailable overlay leaves the last recorded state visible but disables unverified continuation.

Event payloads SHALL be a validated union: run creation; status transition with its typed state detail; request admission/dispatch/outcome with attempt ID and safe budget data; complete sanitized assistant message; tool start/outcome keyed by operation; exact question/answer/closure; and cancellation acceptance. Every envelope contains run ID, sequence, recorded time and discriminator. No raw graph-state, credential, provider-reasoning or SDK-error payload is a wire variant.

The initial snapshot establishes cursor C. History pages are bounded through C; SSE replays everything after C. The browser merges by `(runId, seq)`, deduplicates retransmissions and never infers completion from a closed socket. The server SHALL query committed history after its cursor; local notifications are only wakeups and a bounded database tail check closes notification/reconnect gaps. Per-run sequence allocation shares the transaction ordering described in Decision 4.

SSE comment heartbeats SHALL be emitted every 15 seconds to keep idle connections alive; request-specific Bun idle timeout handling SHALL not change ordinary API timeouts. Slow-client buffers are bounded and can be disconnected for replay. A storage outage SHALL send an unsequenced availability indication when possible and close the stream without advancing the durable cursor. There is no event-retention expiry in Phase 1, so reconnect never silently skips pruned history.

**Alternative:** consuming a graph stream directly in an HTTP handler couples execution to the browser and supplies no durable replay store. WebSockets and Agent Server-compatible state mutation add no required value here.

### 14. Typed outcomes and documentation are part of the implementation contract

Failures SHALL use these wire categories, mapped to the spec's display labels:

| Category | Example reason codes | User guidance |
|---|---|---|
| `authorization` | Missing authorization, terminal refresh rejection, revoked authorization | Reauthorize the selected provider |
| `rate_or_quota_limit` | Rate limit or exhausted quota | Wait/reduce usage where applicable; no provider/billing switch |
| `provider_failure` | Timeout, unreachable service, unsupported profile/response, truncated stream | Inspect provider/profile condition; no success from partial output |
| `step_limit` | Next request exceeds configured maximum | Start separately with an appropriate future budget |
| `continuation_unavailable` | Missing checkpoint/channel, definition mismatch, interrupt mismatch, changed workspace binding | Preserve history; start a new run |
| `tool_failure` | Unrepresentable call identity or unrecoverable tool handling | Inspect the recorded safe operation explanation |
| `runtime_failure` | Unexpected no-op, missing final result, persistence or ownership invariant failure | Inspect safe diagnostics; never silently retry active work |

A failure shape SHALL contain category, stable reason code, safe message, affected operation reference and optional remediation/retry-after information. Request/operation references are discriminated as runtime, model-attempt or tool-operation references. They are not raw exception objects. Terminal graph return alone SHALL NOT constitute success: the controller requires a new recorded agent-produced final result, successful saver settlement and the atomic application success/event commit. Duplicate acknowledgements and state inspection are not candidate new completions.

Failure mapping SHALL consider operation context and typed provider codes, not HTTP status alone. Device-login polling 403/404 responses are not model authorization failures. A recoverable expired credential can take the one permitted renewal path; definitive rejection maps to authorization, usage-limit responses to rate_or_quota_limit, and unsupported/truncated provider responses to provider_failure. Fatal tool handling maps to tool_failure; persistence, ownership and unexpected no-op violations map to runtime_failure when that failure can be durably recorded.

If finalization cannot be persisted, the console SHALL receive an unsequenced, unstored availability notice when possible, not confirmed success or a fabricated durable failure. Readback can confirm an already-committed outcome; otherwise fail-stop and startup reconciliation apply. Raw provider error bodies SHALL NOT be logged.

No `docs/` directory exists. The root README now documents the completed foundation and mock-backed lifecycle; provider integration SHALL update it with the internal subscription-package ownership, provenance/update policy, workspace checks/build, auth commands, model/profile configuration and current acceptance limits. Its recent-generation screening description SHALL be reconciled with the in-flight guarantee in Decision 12. `architecture/05-model-authentication.md` still describes the superseded upstream-release prerequisite and SHALL be updated in the provider block. Existing architecture reconciliation SHALL explicitly separate delivered MVP behavior from historical future intent:

| Document | Required reconciliation |
|---|---|
| `architecture/README.md` | Separate runtime/UI packages in a Bun/Turbo monorepo, one application deployment; `createAgent` owns the loop; browser first; question-only continuation; roadmap supersedes old knowledge canonicality without implementing memory now |
| `architecture/02-control-plane.md` | Thin controller, exact questions, seven states, guarded dispatch and REST/SSE; defer manager/subgraphs/scheduling and active recovery |
| `architecture/05-model-authentication.md` | Minimal internal v2-derived Anthropic package, provenance and intentional differences, explicit provider/auth-mode split, durable credentials, no current API-key fallback, evidence limits |
| `architecture/06-storage-and-backup.md` | Two PostgreSQL ownership schemas, Bun SQL/checkpointer exception, separate commits and preserved volumes; defer retention, backup tooling and host-reboot promises |
| `architecture/07-network-and-protocols.md` | Compose namespace + Serve, owner-restricted tailnet trust and origin controls; real replay storage rather than replay “for free”; broader protocol/auth machinery deferred |
| `architecture/08-execution-security.md` | Actual read-only tools, volume assumptions, path/secret enforcement; no Phase-1 allowlisted network tool or executor sandbox claims |
| `architecture/09-data-model-and-lifecycle.md` | This run/question/event model, request budget and compatibility contract; no general effect-key dependency on private graph fields |
| `architecture/10-delivery-phases.md` | Prominent notice that the four-phase OpenSpec roadmap supersedes its MVP order |
| `architecture/spike-reports/README.md` | Separately dated pointers to new MVP integration evidence, clearly distinguished from the original spike results |
| `packages/anthropic-subscription/README.md` and `THIRD_PARTY_NOTICES.md` | Public package boundary, exact upstream provenance/license, retained and excluded behavior, deliberate adaptations and manual update/check procedure |

The architecture overview SHALL identify related older crash-survival/knowledge descriptions as historical rather than silently importing them into current guarantees. Historical spike reports and disposable harnesses SHALL remain unchanged. The report index SHALL distinguish new MVP integration evidence from original spike results. Documentation of the internal subscription package is project-owned; no upstream documentation or release change is required. The planned `upstream-handoff.md` evidence path SHALL record the decision to own the derivative, its provenance and maintenance boundary rather than claim an upstream delivery occurred.

### 15. Staged integration gates precede dependent implementation

The task plan SHALL make these gates explicit. Common and offline provider checks precede console buildout; live checks gate acceptance of each provider's usable slice. A failed mandatory check SHALL stop the dependent block with recorded evidence and an explicit replanning decision.

| Gate | Required evidence | Pass condition |
|---|---|---|
| G1 — Bun persistence and ownership | Exact dependency matrix; official saver; Bun SQL; singleton/epoch behavior; root-level question pause, fresh-process resume and negative answer | Saved question survives; answer is applied once; lost ownership disables dispatch; no silent runtime substitution |
| G2 — Internal Anthropic subscription boundary | Reviewed extraction provenance/license and deviations; actual internal package; injected auth/inference transport, native/no-rewrite names, refresh coordination and safe errors | Actual-package contract fixtures pass under Bun with independent I/O witnesses, no OpenCode dependency, private upstream imports, global-fetch replacement or plugin-loader fallback |
| G3 — Harness dispatch and lifecycle | Independent physical-request/tool counters; cancellation during credential awaits; no hidden retries; budget exhaustion; checkpoint/application crash windows | No model dispatch after accepted cancellation or beyond capacity; auth-only failure consumes no model request; specified restart outcomes hold |
| G4 — Anthropic transport and journey | Bun request-profile fixtures, fragmented responses and browser-header check; separately authorized login/refresh and tool/question/result journey | Profile matches, tool names survive chunk boundaries, credentials persist safely, and the full journey works through createAgent |
| G5 — OpenAI transport and journey | Bun fetch versus Bun node:http golden captures; complete terminal-event checks; separately authorized device login, renewal, restart and two-turn tool-result journey | Selected terminal passes parity/abort checks and the previously unproven tool-result round trip succeeds |

Every live check SHALL have fresh owner authorization and a declared request limit. The OpenAI implementation-cost checkpoint remains before its delivery block. Failed extraction/contract/parity checks SHALL stop dependent work, not be papered over by moving the budget gate, enabling billed access, installing the full plugin, widening the approved extraction or silently choosing Node. The specific reviewed internal extraction in Decision 10 is authorized planning scope, not blanket permission to copy other provider implementations.

Verification results SHALL identify package/image versions, test commands, observed request counts and unresolved failures. Historical spike evidence SHALL not be relabelled as an integrated Bun result.

## Risks / Trade-offs

- **Unproven combined Bun/harness/provider matrix** → verify the selected exact package bytes before console buildout; incompatibility stops for explicit replanning, not a custom saver or Node fallback.
- **Monorepo cache or package-boundary mistakes** → verify shared-source invalidation, restoration of actual build outputs, uncached acceptance and browser/server dependency guards; do not confuse a deployment cache key with continuation compatibility.
- **Internal derivative adds protocol maintenance** → keep the extraction small, retain provenance/license and an explicit deviation list, review upstream changes manually and rerun package/transport gates for updates; do not fork the host or model framework.
- **Provider-controlled subscription support/policy and profile changes** → record the reviewed transport basis, pin/test profiles, surface failures without automatic version recovery and never reinterpret the selection as permission for billed access.
- **Separate checkpoint/application commits** → explicit crash-window behavior; pending-question durability only after settlement; no recovery of active work or reconstruction of uncommitted success.
- **Database/HTTP admission gap** → bounded reservation and honest unconfirmed-attempt reporting; no exact claim that the provider received a request after process death.
- **Conservative compatibility fingerprints** → harmless upgrades can make old questions non-continuable; preserve history and explain the refusal rather than risk misrouting an answer.
- **Cancellation cannot retract upstream work** → prevent new dispatch, propagate abort and wait for local settlement; do not claim quota reversal.
- **Trusted volumes/private peers** → explicit supported-environment assumptions; read-only mounts, exclusions and origin controls still apply, but this is not hostile-host isolation or a multi-user security product.
- **Credential rotation crash window** → partial-safe durable storage and reauthorization guidance; upstream refresh and local persistence cannot share a transaction.
- **No retention or truncating conversation compaction** → storage/context grow; tool outputs are bounded and provider context failures are visible. Preserve replay-critical metadata rather than silently summarize it away.

## Migration Plan

There is no existing application data to migrate. Scaffolding SHALL establish the Bun/Turbo workspace, runtime/UI package boundaries, shared configuration and container/toolchain/check commands before runtime features. The root Bun-init entrypoint SHALL be replaced by the runtime package entrypoint, leaving root scripts as the documented interface. The API block SHALL introduce contracts and the console block SHALL implement the UI only after the pre-console gates; no package split authorizes an additional deployment. The official saver setup and application schema migrations SHALL be serialized under ownership/migration locks before readiness; schema incompatibility SHALL fail startup. Spike databases and credentials SHALL NOT be implicitly imported.

Provider delivery SHALL add the private Anthropic package and its production runtime wiring, satisfy the provenance and actual-package integration gates in Decision 15, and update the shipped execution manifest before console buildout. It no longer waits for an upstream public release. The accepted run/credential records and lifecycle contracts remain unchanged; no database or credential migration is introduced by this package split. The Anthropic interactive slice still includes the actual pause/restart/answer and browser reconnect journey. OpenAI then closes the phase using the same application contracts; its integration cost SHALL be assessed before that block and explicitly replanned if disproportionate, never silently omitted. Auth commands and live tests require fresh owner authorization; no spent spike request allowance carries forward.

The required verification matrix SHALL include:

- Workspace/import-boundary checks; safe direct and Turbo test discovery; cold/forced execution, shared-input cache invalidation and warm-cache build-output restoration; a single image containing the runtime and, once implemented, the UI.
- Mocked model requests with independent dispatch counters, hidden-retry checks, fragmented/truncated SSE, deadlines and pre-aborted signals.
- Actual internal Anthropic package contracts with synthetic issuers/transports, reviewed-source provenance and approved-difference golden fixtures; workspace-package fingerprint invalidation and in-flight credential screening under rotation pressure.
- Official saver plus `createAgent` on Bun: tool-result rounds, sole/mixed questions, typed negative answers, saved-state inspection and generated-definition changes.
- Failures at interrupt emission, saver settlement, app waiting/answer/final commits, cancellation acceptance, and model admission; verify each documented crash window.
- Duplicate/conflicting answers, stale IDs, replayed tools, missing checkpoint blobs, temporary inspection outage and no-op continuation.
- Cancellation versus dispatch, response-body settlement, answer acceptance and final commit; terminal outcomes stay terminal.
- Budget retries, last permitted result/tool/question, exhausted-budget answer, and unconfirmed admission after process death.
- Cross-device Serve access, Host/Origin rejection, durable SSE replay including the snapshot/subscription race, and bounded slow-client handling.
- Path traversal/symlinks/special files, credential exclusions, known aliases, malicious inspected instructions, and seeded-secret absence before graph persistence as well as browser/log projection.
- Independently authorized live journeys for both providers, including OpenAI's previously unproven second-turn tool-result path and the integrated Anthropic login/refresh lifecycle.

Unit and fixture checks SHALL use `bun test`, directly and through the Turbo workspace graph, without live credentials or network dependence. Block acceptance SHALL use `check:verify` rather than inheriting cached check results. PostgreSQL/Compose integration and live-provider checks SHALL be explicit uncached opt-in commands, with their prerequisites and request limits documented; tests SHALL NOT silently install dependencies or start production services.

Operational rollback SHALL stop admission, preserve database and credential volumes, and restore a compatible pinned application image. Startup still marks former active work interrupted and honors accepted cancellation. A code rollback does not bypass definition or schema checks; incompatible paused questions fail visibly. Destructive down-migrations, checkpoint rewriting, automatic volume deletion and provider-credential rollback are not rollback mechanisms for this phase.

## References

- [Durability spike](../../../architecture/spike-reports/05-langgraph-durability.md) and [checkpointer/concurrency spike](../../../architecture/spike-reports/06-postgres-checkpointer-concurrency.md): measured invariants, not integrated Bun guarantees.
- [Anthropic spike](../../../architecture/spike-reports/03-anthropic-parity.md) and [OpenAI spike](../../../architecture/spike-reports/04-openai-device-auth.md): transport/auth evidence and remaining gaps.
- [Custom middleware](https://docs.langchain.com/oss/javascript/langchain/middleware/custom), [interrupts](https://docs.langchain.com/oss/javascript/langgraph/interrupts), and [streaming](https://docs.langchain.com/oss/javascript/langchain/streaming).
- [LangChain 1.5.14 source](https://github.com/langchain-ai/langchainjs/tree/langchain%401.5.14/libs/langchain/src/agents): public integration surfaces inspected during authoring.
- [Custom Agent Streaming Protocol backends](https://docs.langchain.com/langsmith/deploy-frameworks-and-platforms): alternative evaluated, not assumed to require a commercial server.
- [Tailscale Docker deployment](https://tailscale.com/kb/1282/docker) and [Anthropic authentication/support boundaries](https://code.claude.com/docs/en/legal-and-compliance#authentication-and-credential-use).
