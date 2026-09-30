# G1 — Bun persistence and ownership

**Outcome: pass (early gate, 2026-09-29), with one Bun SQL defect found afterwards and mitigated.**
Recorded under task 4.9 from the task 4.6 verification and observations made while implementing task 4.8.
The later persistence regression run (task 4.10) is recorded separately and is not claimed here.

## Question

Can the selected framework matrix run under Bun with the official PostgreSQL checkpointer, so that a settled
human question survives process death, a fresh process delivers a negative answer exactly once, and lost runtime
ownership prevents further dispatch — without a Node fallback or a custom saver?

## Tested build

| Item | Value |
|---|---|
| Source | Working tree on commit `e028cc7` with uncommitted Phase-1 changes (tasks 4.2–4.5); `bun.lock` SHA-256 prefix `fed91e4527b4f2ff` at the gate |
| Runtime | Bun 1.3.14 (`mise.toml`, `packageManager`) |
| Framework | `langchain` 1.5.14, `@langchain/core` 1.2.13, `@langchain/langgraph` 1.4.13, `@langchain/langgraph-checkpoint` 1.1.5, `@langchain/langgraph-sdk` 1.10.2 (transitive) |
| Saver | `@langchain/langgraph-checkpoint-postgres` 1.0.5, `pg` 8.16.3, `pg-pool` 3.14.0 |
| Application SQL | Bun SQL (built into Bun 1.3.14) |
| Database | `postgres:17.11-bookworm@sha256:639ab7ceb90e13123085b741fb31ef493fba25463002f6da665352e7b534b652`, disposable launcher fixture (tmpfs) |
| Provider requests | **0** — the model is a deterministic in-process fixture; no provider credentials or network |

Lockfile integrity prefixes: langchain `sha512-/orHDk5xbNSI…`, core `sha512-ADGTxZ84n3ci…`, LangGraph
`sha512-LO1ak6jNQ9jR…`, checkpoint `sha512-BwDwl5VeTOh6…`, saver `sha512-kCpp9pOidYDe…`, pg-pool
`sha512-gKtPkFdQPU3D…`.

## Method

`mise exec -- bun run test:integration` starts a uniquely named PostgreSQL fixture on loopback and runs
`tests/integration/`. Each suite creates its own scratch database. The G1 suite
(`tests/integration/g1-bun-persistence.integration.test.ts`) runs real Bun child processes
(`packages/runtime/test-support/g1/child.ts`) through the runtime's actual startup path (`openPersistence`):
ownership, serialized migrations, saver setup and epoch claim. Children write one JSON line per observation to
stdout synchronously; the parent keeps that append-only log as the independent witness, never graph state.

The fixture agent is the stock root-level `createAgent` (`version: "v2"`) with a deterministic model that decides
only from the conversation, and a sole `mcp_AskUser` tool containing a single `interrupt()` with no prior side
effects. Invocations pass `{ thread_id }`, `durability: "sync"` and no `checkpoint_id` key.

1. Child A runs until the stream is fully drained, reads the saved head through public APIs
   (`agent.graph.getState`, `saver.getTuple`), reports the binding, and stays alive holding ownership.
2. The parent kills A with SIGKILL and waits for the ownership session to end.
3. Child B starts fresh, claims a new owner epoch, re-reads the binding before invoking, and resumes with
   `Command({ resume: { [interruptId]: { questionId, answer: false } } })`.
4. Separately, a child's ownership backend is terminated, then it attempts a model dispatch — both before and
   after the process has observed the loss.

## Results (task 4.6)

| Check | Observed |
|---|---|
| `mise exec -- bun run check:verify` | 7/7 tasks executed, 0 cached |
| Direct `bun test` | 68 pass, 0 fail |
| `bun run test:integration` (fresh fixture) | 23 pass, 0 fail (G1 plus adapter, startup and ownership suites) |
| G1 stability | 5 consecutive passes |
| Negative control | Resuming with `answer: true` instead of `false` fails the G1 test, so the assertion discriminates the delivered value |

G1 assertions that held:

- Invocation configuration contained only `thread_id` and `durability: "sync"`.
- After the drained stream: one saved tuple, root namespace `""`, one pending task with one interrupt whose
  payload carries the expected question ID, no task error.
- Child A performed exactly one model dispatch (the question) and entered the tool once; no answer was delivered.
- After SIGKILL (exit by signal, no clean shutdown), the ownership lock was released and child B claimed epoch 2.
- Child B read an identical binding before invoking, then: the tool was re-entered once (replay calls `interrupt()`
  again), the answer was delivered once with the boolean `false`, the model validated `false` once, and produced the
  final message. The final head had no pending tasks and a new checkpoint ID.
- Across both processes: one question asked, one negative answer delivered, one completion.
- Lost ownership prevented model dispatch in both orderings: the dispatch attempt failed with `ownership_lost`, and
  the model and tool witnesses stayed at zero.
- Bun SQL (application) and `pg` (saver) operated side by side in each process against one database.

Supporting measurements from tasks 4.2–4.4 on the same matrix:

- A reserved Bun SQL session keeps its transaction on the same backend; a server-terminated reserved session is
  **not** reconnected (queries fail with `ERR_POSTGRES_CONNECTION_CLOSED`), and the pool close callback fires.
- With `idleTimeout: 0` an idle pooled connection is retained over the observation period; a control pool with a
  one-second idle timeout retired its connection.
- Pool budgets held: at most 5 application and 4 saver connections under load.
- Saver idle-client and checked-out-client failures were delivered to the configured listeners; the write rejected
  and later writes succeeded.
- Concurrent starters: one owner; the others changed nothing and never reached migration.
- Epoch fencing: a successor's epoch claim waited for an in-flight fenced transaction, after which the stale owner's
  fenced writes were refused.

## Findings

### Bun SQL: plain pool queries can run inside another caller's transaction

Observed while implementing task 4.8, after the gate. On Bun 1.3.14, when the pool is contended and transactions fail
(for example, nine concurrent creations losing a unique-key race), a plain pool query (`sql\`…\``, not
`sql.begin`) can be sent on a connection that is inside another caller's explicit transaction:

- A plain `SELECT` reported a transaction ID (`pg_current_xact_id_if_assigned()` non-null), meaning it executed inside
  a writer's transaction — 196 such queries in one run.
- When that transaction had aborted, the plain query failed with `25P02`, and a connection could be left
  `idle in transaction (aborted)`, eventually stalling the pool.
- Bun's transaction code awaits `ROLLBACK` before releasing its connection, and disabling prepared statements did not
  change the outcome.
- In the same runs, statements issued through `sql.begin()` were never observed inside another caller's transaction.

The consequence for correctness is severe: an unrelated autocommit write routed this way would commit or roll back
with a transaction it does not belong to. `tests/repro/bun-sql-pool-misrouting.ts` reproduces it with Bun's API
alone (one observed run: 182 plain queries inside another transaction, 151 failed with `25P02`); it is intermittent
and can also hang.

**Mitigation (owner-approved):** application code never uses the plain pool. `AppDatabase` exposes only
`transaction()`, `readOnly()` and reserved sessions, and a boundary test forbids opening Bun SQL anywhere else.
Under the same contention with every statement in a transaction: 2,000 concurrent creations and about 4,100
concurrent probes across five runs showed no `25P02`, no misrouted query and no stall. The regression suite
`tests/integration/bun-sql-discipline.integration.test.ts` repeats this contention. The mitigation is supported by
stress evidence, not by proof of Bun's internals.

### Orphaned ownership sessions after namespace replacement

Replacing the Tailscale container destroys the runtime's network namespace without a FIN or RST, so PostgreSQL kept the
old runtime's sessions, including the ownership lock, until TCP keepalive (hours by default). The replacement runtime
correctly refused ownership. PostgreSQL now runs with `tcp_keepalives_idle=10`, `tcp_keepalives_interval=5` and
`tcp_keepalives_count=3`; the container smoke test shows ownership moving to the replacement (epoch advanced).

### Driver details that shaped the implementation

- Bun SQL returns a jsonb `null` as JavaScript `null` and binds a JavaScript string as a JSON string, so records cross
  the driver only as JSON text (`::text::jsonb` on write, `::text` on read), preserving `false` and JSON `null`.
- Releasing a server-terminated reservation raises an unhandled rejection in Bun, and pool close waits for its full
  timeout on such a session; shutdown therefore releases only sessions whose unlock succeeded and closes with a short
  timeout.
- The saver's `setup()` silently skips when its ledger is newer than the package, so startup checks the saver ledger
  (read-only, versions 0–4 for saver 1.0.5) and refuses unknown, newer or gapped histories.

## Limitations

- Proves the pinned matrix under Bun for a single root-level question pause, SIGKILL after settlement, and one fresh
  resume. It does not prove duplicate-answer protection (a raw duplicate resume is not deduplicated by LangGraph;
  this is a G3 controller responsibility), active-work recovery, or crash timing inside the saver.
- The fixture database is tmpfs: process replacement with the database alive, not database or host restart.
- Settled-pause survival does not independently distinguish synchronous from asynchronous durability; both flush on
  stream closure. Synchronous durability is asserted as configuration.
- No provider transport, credential, console or Tailscale Serve behavior is covered.

## Upstream report draft (Bun)

> **Bun SQL (PostgreSQL): under contention, a pooled query can execute inside another caller's transaction**
>
> Bun 1.3.14, PostgreSQL 17.11, Linux x64. With `new SQL(url, { max: 5 })`, concurrent `sql.begin()` transactions that
> fail on a unique-key conflict (after waiting on the winner's row lock), combined with concurrent plain `sql\`…\``
> queries, sometimes route a plain query onto a connection inside another transaction: a plain `SELECT` reports a
> non-null `pg_current_xact_id_if_assigned()`, plain queries fail with `25P02`, a connection can remain
> `idle in transaction (aborted)`, and the pool can stall. Statements inside `sql.begin()` were not observed to be
> affected. Reproduction: `tests/repro/bun-sql-pool-misrouting.ts` (intermittent; run several times).

Not yet filed; filing is the owner's decision.

## Reproducing

```bash
mise exec -- bun run check:verify
mise exec -- bun run test:integration
REPRO_DATABASE_URL=postgres://…/disposable_db mise exec -- bun tests/repro/bun-sql-pool-misrouting.ts
```
