# G3 — Harness dispatch and lifecycle

**Outcome: pass (2026-09-30), with provider-free models.** Recorded under task 8.13 from the task 8.12
verification and the negative controls run while implementing tasks 8.2–8.11. Provider bindings do not exist yet:
every model in these checks is a scripted in-process model, so real-provider behavior (G2, G4, G5) is not
established here.

## Question

With the stock root-level `createAgent` and the official PostgreSQL checkpointer under Bun, does the runtime keep
authority over dispatch, accepted human input and visible outcomes — no model dispatch after accepted cancellation
or beyond the budget, no hidden retries, no request charged for an authorization-only failure, a question
answerable only after its state is saved, an answer applied once, and the design's outcome for every
checkpoint/application crash window?

## Tested build

| Item | Value |
|---|---|
| Source | Working tree on commit `5711c8b` with uncommitted block-8 changes; SHA-256 prefix `20d4134be1ad7fc8` over the 152 tracked and untracked files under `packages/`, `tests/`, `scripts/` and the root build files |
| Execution-code manifest | `dist/execution-manifest.json` from the verified build: 40 modules, 39 locked packages; SHA-256 prefix of its JSON `0187d8110c17b4c1` |
| Runtime | Bun 1.3.14 |
| Framework | `langchain` 1.5.14, `@langchain/core` 1.2.13, `@langchain/langgraph` 1.4.13, `@langchain/langgraph-checkpoint` 1.1.5 |
| Saver | `@langchain/langgraph-checkpoint-postgres` 1.0.5 (`pg` 8.16.3) |
| Lockfile | `bun.lock` SHA-256 prefix `88815962fbbe32d4`, unchanged by a frozen install |
| Database | `postgres:17.11-bookworm@sha256:639ab7ceb90e13123085b741fb31ef493fba25463002f6da665352e7b534b652`, disposable launcher fixture |
| Image | `oven/bun:1.3.14-slim@sha256:d56a2534ffd262e92c12fd3249d3924d296d97086da773f821d7d0477435ea04` |
| Provider requests | **0.** Physical requests went to in-process fake transports that count them; no credentials or provider network |
| Owner authorization | None required (no live provider operation) |

## Method

Unit suites run with `bun test`; lifecycle suites through `mise exec -- bun run test:integration`, which starts a
uniquely named PostgreSQL fixture and gives each suite its own scratch database. The components under test are
the production ones (`packages/runtime/src/execution/`, `records/run-store.ts`): the boundary middleware, guarded
terminal, durable admission and tool ledger, publication, answer acceptance, continuation verification,
cancellation, the run controller and startup reconciliation. Only the model (`ScriptedModel`, `FetchingModel`) and
the HTTP transport are fakes; `FetchingModel` makes one request per model call through the terminal, as an SDK
would.

Witnesses never come from the controller's own state: the transport's request log, the scripted model's call log,
source-stream cancellation callbacks, raw reads of the database (application tables and the checkpointer's own
tables), and, for crash windows, the append-only stdout log of a child Bun process. Crash windows are produced by
running the production controller in a child (`packages/runtime/test-support/lifecycle/child.ts`), stopping it at a
deterministic barrier, killing it with SIGKILL, then opening a fresh owner and running the same reconciliation
startup performs. Waits use explicit latches, not timing.

## Results (task 8.12)

| Check | Observed |
|---|---|
| `bun install --frozen-lockfile` | exit 0, lockfile unchanged |
| `mise exec -- bun run check:verify` | exit 0; 7/7 tasks executed, 0 cached |
| Direct `bun test` | exit 0; 358 pass, 0 fail (37 files) |
| `bun run test:integration` | exit 0; 117 pass, 0 fail (16 files) |
| Container smoke | exit 0; 9/9 |
| Execution, credential, workspace and security suites in the pinned image (non-root, read-only root, no network, no capabilities) | exit 0; 219 pass, 0 fail |
| `openspec validate --strict` | valid |
| Historical spikes, reports and adversarial history | preservation digest `6edad445d47fbdeb` over 179 files, unchanged |

Integration suites (all pass): G1 3, controlled execution on the official saver 3, tool ledger 6, question
publication 6, answers 10, request accounting 8, cancellation 8, run controller 7, crash matrix 8.

### Crash windows

| Last committed | Required | Observed after SIGKILL and restart |
|---|---|---|
| Working, no saved question | Interrupted | `interrupted`; invocation `interrupted`; the one completed attempt kept; 0 requests after restart |
| Admitted, dispatch never confirmed | Interrupted, attempt honestly unconfirmed | `interrupted`; attempt `unconfirmed`, `consumed 0 / unconfirmed 1` |
| Graph interrupt saved, question uncommitted | Interrupted; orphan not answerable | `interrupted`; 0 questions; the checkpointer still holds the interrupt write; an answer finds no question; 0 requests |
| Waiting, question committed | Waiting; answer re-verified | `waiting`; the fresh process verified, accepted `false` and continued to `succeeded`; the model received `false` |
| Answer committed, resume not dispatched | Interrupted; answer kept, never redispatched | `interrupted`; invocations `settled, interrupted`; resubmission acknowledged as already accepted; 0 requests |
| Graph finished, outcome uncommitted | Interrupted; no reconstructed success | `interrupted` |
| Cancellation accepted | Cancelled | `cancelled`; 0 requests |
| Terminal outcome committed | Unchanged | identical records before and after |

### Dispatch, budget and cancellation

- Each physical request was reserved, confirmed and completed, and the counts matched the transport's log. Tool
  calls from the last permitted response ran; the next request was refused with `step_limit` and never sent.
- An answer was accepted with no steps left; its continuation's first request was refused at admission.
- Credential failure before dispatch: 0 attempts, 0 requests. The one renewal retry was a second admitted, counted
  request, and with a budget of 1 it was refused.
- A transport failure after start recorded the attempt `unconfirmed`, still charged.
- After cancellation was accepted, or with ownership unverifiable, admission refused and nothing was sent.
- Cancellation during a credential wait, after headers with a stalled body (source stream cancelled), with a tool
  call in flight, and with a checkpoint write in flight: the run stayed `cancelling` until that work settled, then
  became `cancelled`. A late completion could not replace it; an answer accepted before cancellation stayed.
- Terminal: exact endpoint policy, no redirect followed (including Bun's own fetch against a local server), dispatch
  recorded before the response is released, full-body deadline, SDK credential headers replaced.

### Questions, answers and compatibility

- Publication happened only after settlement, inspection and one commit. No question was published when the
  interrupt write failed, when inspection could not read the saved state, when the streamed interrupt did not
  match the saved one, or when the commit failed; an uncertain commit was resolved by readback.
- Answers: `false`, `null`, `0` and permitted empty text accepted; duplicates acknowledged without another
  invocation, also after the run finished; two concurrent tabs produced one acceptance and one conflict; unknown,
  misdirected and invalid submissions changed nothing.
- A temporary inability to read saved state accepted nothing and changed nothing. Changed execution code, deleted
  saved state and an unconstructible stored binding each closed the question and failed the run as
  `continuation_unavailable`.
- The required-state digest was identical through a fresh official saver instance. Stored model messages kept their
  IDs, tool calls, reasoning blocks and provider metadata; synthetic credentials were absent from the checkpoint
  tables, including exception records.

### Negative controls

Each was run by temporarily changing the code, observing the failures below, and restoring it.

| Control | Tests that failed |
|---|---|
| Terminal follows redirects | 2 (redirect not followed; request sent once) |
| Terminal relies on fetch to stop a stalled body | 2 (cancellation and deadline body settlement) |
| Model responses not sanitized | 3 (redaction, message ID, credential in tool arguments) |
| Model-call failures rethrown raw | 1 — the provider text, including the synthetic credential, reached the checkpoint writes |
| Publication without saved-state confirmation | 1 (orphan interrupt published) |
| Answered questions not checked first | 2 (repeated answer, concurrent tabs) |
| Budget check removed | 3 (all budget cases; the database constraint then failed them as persistence errors) |
| Cancellation not waiting for tracked work | 2 (tool call, checkpoint write) |
| Restart does not interrupt working runs | 5 crash windows |
| Credential screen ignores new generations | 1 (rotated credentials persisted) |

## Findings

- **LangGraph records exception text.** A failed task's error name and message are written to the checkpoint. The
  boundary middleware therefore converts every non-control-flow failure into fixed text inside the node; the
  raw-rethrow control above shows the leak it prevents.
- **An aborted invocation can settle before its work stops.** When the service signal aborts, the graph promise can
  settle while a request body, tool call or checkpoint write is still running. Cancellation waits for tracked work,
  not the promise.
- **Several failures in one step arrive as an `AggregateError`.** Classification looks inside it.
- **PostgreSQL's `jsonb` text form is longer than compact JSON.** A tool result within the 64-KiB compact bound can
  exceed the recorded-result bound; such a result is replaced by the fixed size refusal before the agent sees it,
  so what is returned always equals what is recorded.

## Corrections during the block

- Generation-aware credential screening (`credentials/screening.ts`) was part of the approved scope for tasks
  8.3–8.4 but was implemented after those tasks were marked complete, before documentation (8.11). Its test and
  negative control are included above.
- Continuation verification first treated any failure to read saved state as confirmed unusable, which would have
  closed questions on unknown errors; it was changed so that only state actually read can confirm a problem.

## Limitations and open items

- No provider binding: Anthropic and OpenAI request profiles, SDK retry settings, error normalization (for example
  a 400 is classified as an unexpected provider response until adapters supply codes) and credential resolution are
  later blocks. The live journeys are not covered.
- No API or console: the controller is exercised directly, not through REST/SSE.
- A dispatched attempt whose completion was never recorded (process death during a response) stays `dispatched`
  after restart — known sent, completion unknown.
- Only an ordinary restart is covered; no host reboot or storage-loss scenarios.
