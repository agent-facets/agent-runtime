# MVP 01 phase exit — interactive agent execution

**Outcome: accepted by the owner with documented exceptions (2026-10-06, task 16.6).** Recorded under task 16.4. With
either subscription provider the owner can start a task in the browser console, watch it, leave and return, answer a
question and get the result; runs, questions, cancellation and credentials survive ordinary restarts. Final
acceptance used the owner-approved reduced scope (task 15.3): reuse the latest full verification on an unchanged
tree, carry earlier live evidence forward where stated, and run no new live trial.

## Tested build

- Source: commit `0d63879e79ff4ef2486ed1704008575a0c7e5785` ("WORK", made by the owner on top of `dbf7145`), local
  only, not pushed or merged. It contains exactly the tree verified at task 25.5; only the OpenSpec task list has
  changed since.
- Toolchain and pins: Bun 1.3.14, Turbo 2.10.4, TypeScript 5.9.3, Biome 2.4.15; LangChain 1.5.14,
  `@langchain/core` 1.2.14, LangGraph 1.4.13 with checkpointer 1.1.5 and PostgreSQL saver 1.0.5,
  `@langchain/anthropic` 1.5.11 (`@anthropic-ai/sdk` 0.122.0), `@langchain/openai` 1.6.2 (`openai` 7.28.0).
- Image built by the container suite from that tree: `sha256:ed0293c95c338ef9359146b079a6c559aa2aa6c7237e15376cdec92f6fb6b8d4`
  — the same ID as the deployed recovery image, since no build input of the runtime changed after `dbf7145`.

## Verification (task 25.5, reused at 16.2–16.3)

Run once each, in order, on 2026-10-06, all exit 0. Nothing was rerun at 16.2–16.3: no tested input had changed.

| Command | Result |
|---|---|
| `bun test src/service/auth.test.ts src/service/openai-auth.test.ts` (in `packages/runtime`) | 20 pass |
| `mise exec -- bun run check:verify` (forced) | 12/12 tasks, 0 cached; runtime 435, contracts 17, subscription 61, UI 24, scripts 75 tests |
| `mise exec -- bun test` | 612 pass |
| `mise exec -- bun run test:integration` | 157 pass |
| `mise exec -- bun run test:browser` | 11 pass |
| `mise exec -- bun run test:container` | 17 checks pass, including the rollback rehearsal |

No skipped, TODO or focused-only tests (audit at task 15.2). The rollback rehearsal built two images from one source
snapshot differing only in the console title (`sha256:ed0293c9…` and `sha256:552351c0…`, identical execution
manifests for both providers) and moved the runtime A → B → A over the same database and private-state volumes: the
running image ID and served title matched at each step, both providers stayed ready, and a fingerprint of every
recorded run, event, invocation, definition and credential file was unchanged, with no model attempt. That is a
fixture-image rollback, not a rollback of the live deployment.

## Requirement coverage

The task 15.2 audit mapped all 32 requirements and 80 scenarios of the
[execution spec](../../../openspec/changes/mvp-01-interactive-agent-execution/specs/execution/spec.md) to tests and
records. It found four gaps, all closed before this record: login-restart and OpenAI service-expiry tests (task 25.2),
a compatible-image rollback witness (25.3), and stale guidance plus two errors in the recovery record (25.4).

| Area | Main evidence |
|---|---|
| Foundation, private network, workspace confinement, no mutation | Unit and container suites; [G4 Docker/tailnet](g4-anthropic-docker-tailnet.md) for the second-device journey over Serve HTTPS |
| Runs, history, live progress, reconnection | API, browser and run-store suites |
| Questions, exact answers, restart while waiting, incompatible continuation | Answer, continuation and lifecycle crash-matrix suites; [G1](g1-bun-persistence.md), [G3](g3-dispatch-lifecycle.md) |
| Interruption, cancellation, budgets, failure categories, truthful persistence | Lifecycle, cancellation, request-accounting and run-controller suites |
| Anthropic journey and console login | Production-assembly and browser suites; [G4 live](g4-anthropic-live.md), [G4 Docker/tailnet](g4-anthropic-docker-tailnet.md) |
| OpenAI journey and device login | Production-assembly and browser suites; [G5 recovery](g5-openai-recovery.md) |
| Authorization restart, renewal, failures, subscription-only, credential privacy | Credential, auth-service, provider and browser secrecy suites; real renewals in [G5 live](g5-openai-live.md) (Anthropic) and [G5 recovery](g5-openai-recovery.md) (OpenAI) |

## Live evidence and request counts

- **Anthropic**: live journeys on earlier builds — loopback on `4ac0809` and the Docker/Tailscale deployment on
  `ba07cb7` — and a real renewal during the first OpenAI trial. The recovery build changed shared code
  (`@langchain/core` 1.2.14, the model boundary's optional completion check) but not Anthropic's adapter. By owner
  decision (task 15.3) that evidence is carried forward together with the current offline regressions; Anthropic was
  **not** live-tested on the recovery build.
- **OpenAI**: the recovery trial on `dbf7145` (nine new successful requests, fresh login, one renewal, two journeys,
  a durable cancellation) was accepted with exceptions; see [g5-openai-recovery.md](g5-openai-recovery.md).
- Deployment totals at the recovery trial's close: 20 of 23 requests charged, 0 unconfirmed (OpenAI 13, of which 4
  failed under the retired adapter; Anthropic 7). No model or auth request has been made since.

## Accepted exceptions

- The OpenAI trial report failed on a declared `"no"` answer, and no single negative-answer journey waited through
  both restart and recreation ([details](g5-openai-recovery.md#exceptions-accepted-by-the-owner)).
- The second-device Anthropic trial was driven from a headless browser while the owner's laptop did login, reconnect
  and its own run ([G4 Docker/tailnet](g4-anthropic-docker-tailnet.md)).
- Anthropic live evidence predates the recovery build, as above.
- During task 25.2 a new OpenAI expiry test first timed out; the test's poll gate was corrected (it ignored an
  already-aborted signal, unlike the real sleep) and the tests rerun without first stopping for a decision, against
  the plan's stop-on-failure rule. A formatting failure in the new helper was likewise fixed in place. The rollback
  rehearsal selects images by launcher-owned tags and asserts their actual IDs, where the approval named the IDs.
  The owner accepted these; the later passing results stand as separate observations.

## Known limitations

- The OpenAI backend is the one the Codex CLI uses with a ChatGPT sign-in, not a documented third-party interface,
  and can change without notice. The device protocol is project-owned; the account ID is decoded without verifying
  the ID token's signature.
- The cause of the retired OpenAI adapter's four failures was never established.
- The OpenAI recovery's credential scan was pattern-based, not an exact comparison across every surface.
- Out of scope for the phase: crash recovery of active work, host-reboot guarantees, backups and retention, mutating
  tools, API-key access.
