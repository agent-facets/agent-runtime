# Spike 06 — Working Record

Appendix to
[06-postgres-checkpointer-concurrency.md](./06-postgres-checkpointer-concurrency.md).

This is the spike's **working record**, moved here verbatim when the spike was
sealed. The report states what was concluded; this document is how it was arrived
at, and it is kept because several of its parts cannot be recovered from the
report:

- the **source-derived contract** (§1–§7) read out of the installed `dist` and
  source maps at the pinned version — the oracle every acceptance criterion was
  written against, and the reason a later release can be diffed against what was
  actually measured here;
- the **corrections**: §2.2 records a source claim a later reading disproved,
  §8.25–§8.26 record measured claims that were wrong when first drafted, and
  §8.22 lists all 24 harness defects found by *executing* the harness rather than
  by reading it;
- the **evidence-set history** (§10), including two runs deliberately retained as
  audit and fault history rather than deleted.

**Read it as a laboratory notebook, not as a specification.** It was written
incrementally, so it contains claims that were later superseded. Each one is
marked in place rather than quietly fixed — a correction that erases its own
history teaches nothing, and the corrections are among the most useful things
here. **Where this document and the report disagree, the report is current.**

Section numbering is original and therefore not gapless.

Everything here is labelled by oracle class. The distinction is load-bearing and
must survive into the report:

| Class | Meaning |
| --- | --- |
| **documented** | Stated by the package README, exported types, or base Store semantics. |
| **source** | Read from the installed `dist` + source maps at the pinned version. A prediction, not a measurement. |
| **postgres** | Defined by PostgreSQL/pgvector, not by the package. |
| **architecture** | What this runtime needs, whether or not the package ever promised it. |
| **measured** | Observed by this harness against a real cluster. |

A **source** claim must never be reported as vendor documentation, and an
**architecture** claim must never be reported as a package guarantee.

---

## 1. Pins (Step 1)

Verified to agree across four independent places: the installed tree, the
lockfile, the harness fixture manifest, and npm integrity metadata.

| Package | Version |
| --- | --- |
| `@langchain/langgraph` | 1.4.13 |
| `@langchain/langgraph-checkpoint-postgres` | 1.0.5 |
| `@langchain/langgraph-checkpoint` | 1.1.5 |
| `@langchain/core` | 1.2.9 |
| `pg` | 8.16.3 |
| `zod` | 4.5.4 |
| TypeScript | 6.0.3 |
| `@types/node` | 24.12.2 |
| `@types/pg` | 8.15.6 |

Images, by digest:

- `node:24.6.0-bookworm-slim@sha256:9b741b28148b0195d62fa456ed84dd6c953c1f17a3761f3e6e6797a754d9edff`
- `pgvector/pgvector:pg17-bookworm@sha256:cf134a767f474095eeba57e0117be8e568e011a63f33fbf252f14c9b760f8e6f`

Server observed: PostgreSQL **17.11**, `server_version_num` **170011**.

The Store is the `./store` subpath export of the same checkpointer package. No
second vendor package is involved.

---

## 2. Source-derived contract (Step 1)

### 2.1 `PostgresSaver.setup()` — `dist/index.js:89-110`

The sequence, in order:

1. `CREATE SCHEMA IF NOT EXISTS <schema>`
2. `SELECT v FROM <schema>.checkpoint_migrations ORDER BY v DESC LIMIT 1`
   — a `42P01` (undefined_table) is **swallowed** and the version becomes `-1`.
3. `for (v = version + 1; v < MIGRATIONS.length; v++)`: `query(MIGRATIONS[v])`,
   then a **separate autocommit** `INSERT INTO checkpoint_migrations (v)`.

Three properties follow, all **source**:

- **No transaction.** DDL and its ledger row are not atomic with each other.
- **No advisory lock, no locking read.** Nothing serialises concurrent callers.
- **The ledger is a position, not a content hash.** Migration *N* means "the
  Nth element of whatever `MIGRATIONS` currently is".

`PostgresSaver.pool` is a **public** field (`dist/index.js:54`), so the harness
instruments it directly with no reflection.

Checkpointer migration 4 is `ALTER TABLE … DROP not null`, which **is**
idempotent. An earlier reading that claimed it errors on replay was withdrawn.

### 2.2 `PostgresStore`

- Builds **its own** `pg.Pool` in the constructor (`dist/store/index.js:25-32`)
  and exposes no injection point. `core` is `private` in the `.d.ts` but an
  ordinary own property at runtime, so the harness reaches the pool through a
  single guarded, fail-closed reflection helper (`src/reflect.ts`) rather than
  scattering casts.
- **Lazy setup guard:** `if (!this.isSetup && this.ensureTables) await setup()`,
  with `isSetup` assigned **only after** the awaited migrations finish. It is a
  plain boolean, not an in-flight promise, so concurrent first operations in a
  single process can all enter the migration loop. (**source** — measured in a09.)
- **Store migrations** (`dist/store/store-migrations.js`):
  - migration 3 contains `CREATE OR REPLACE FUNCTION`, then
    `DROP TRIGGER IF EXISTS`, then a bare `CREATE TRIGGER` with no
    `IF NOT EXISTS`. **Corrected in Step 14:** an earlier reading of this file
    recorded the bare `CREATE TRIGGER` but missed the `DROP TRIGGER IF EXISTS`
    immediately above it, and called migration 3 "the one migration whose DDL is
    not idempotent (`42710`/`XX000`)". That is **wrong**. The drop makes replay
    idempotent, and because the whole migration is a single `client.query()` it
    goes to PostgreSQL as one simple-query batch in an implicit transaction, so
    concurrent replayers serialise on the relation lock and still end with
    exactly one trigger. a08's measurement always agreed with the corrected
    reading — the `23505` it observed comes from the **ledger insert** — so no
    result changes; only the explanation attached to it does.

    **Corrected again at Step 43.** This paragraph previously added "and no
    `42710` was ever seen". That is now false: `frozen-v3` sampled `a07` with
    `{23505:2, 42710:1, none:1}`, and `frozen-v3-verify` sampled `a08` raising
    `XX000`. The Store setup race outcome set is `{23505, 42710, XX000, none}` —
    a **bounded set**, exactly as §8.2 said, and the tighter prose here
    overreached. The corrected reading of migration 3 stands; only the claim
    about what was never observed was wrong. Recorded here because a source prediction that survives into the
    report unchecked is exactly what the contract hierarchy exists to prevent;
  - migration 4 is `CREATE EXTENSION IF NOT EXISTS vector`, and is present in the
    list **only when `indexConfig` is set**. It is **unqualified**, so the
    extension lands wherever the `search_path` points — `public` in this harness,
    never the Store's own schema (measured in d12).
- Because the ledger stores positions while the list's *content* depends on
  `indexConfig`, changing `dims` after the first setup runs **nothing**.

### 2.3 Conflict clauses

| Path | Clause | Consequence (**source**) |
| --- | --- | --- |
| `checkpoint_blobs` upsert | `ON CONFLICT … DO NOTHING` | first-writer-wins on bytes |
| `checkpoints` upsert | `ON CONFLICT … DO UPDATE` | last-writer-wins on the row |
| `checkpoint_writes` (`putWrites`) | `DO UPDATE` **only** when every channel is special; otherwise `DO NOTHING` | mixed semantics on the same table |

### 2.4 Loader join

The checkpoint loader joins `checkpoints` to `checkpoint_blobs` with an **INNER**
join over `jsonb_each_text(checkpoint -> 'channel_versions')`. A referenced blob
row that is missing therefore does **not** raise: the channel silently vanishes
and the thread resumes on truncated state. This is why the reachability witness
in `src/inspect/checkpoints.ts` negates *that exact join* — any divergence would
make "referenced" mean something different from "readable".

### 2.5 Engine facts behind subgraphs and effect keys (read in Step 20)

All **source**, from `@langchain/langgraph@1.4.13`. They are the vendor
internals every family E and H claim rests on, so they are recorded verbatim
rather than paraphrased into the findings.

- **Task ids are derived, not random.** `algo.js` builds a PULL task's id as
  `uuid5(JSON.stringify([checkpointNamespace, step, name, PULL, [trigger]]),
  checkpoint.id)`. Every input is deterministic, and the uuid5 *namespace* is the
  id of the checkpoint the task runs against — which is what makes the effect key
  stable across a replay from the same checkpoint and different across a fork.
- **A subgraph namespace is `<node>:<taskId>`**, nested by appending
  `|<node>:<taskId>`. Nothing in the harness parses those separators; depth is
  derived from string containment and the ids are canonicalised out of the
  digest.
- **A task's config does not carry its parent checkpoint.**
  `_prepareSingleTask` sets `checkpoint_id: void 0` explicitly. The parent id is
  reachable only through `configurable.checkpoint_map`, an undocumented
  (but not underscore-prefixed) per-namespace map, and the task id only through
  `__pregel_task_id`, which is private by naming convention.
- **Writes are stored under the GRAPH's namespace, not the task's.**
  `PregelLoop.putWrites` stamps rows with `this.config.configurable.checkpoint_ns`
  and `this.checkpoint.id`, so a `checkpoint_writes` row carries
  `(graph namespace, parent checkpoint, task id, idx)`.
- **Completed-task reuse is gated on a key-presence test.**
  `PregelLoop.initialize` computes
  `skipDoneTasks = !("checkpoint_id" in config.configurable)`, and only when it
  is true does the loop match pending writes onto prepared tasks. Combined with
  the `checkpoint_id: void 0` above, this means **any loop initialised from a
  task's config — i.e. every subgraph — has reuse disabled**. Measured in e07,
  isolated by the e09 root control.
- **An explicit `checkpoint_id` forks rather than replays in place.** The engine
  writes a new checkpoint with `source: "fork"` whose parent is the named one,
  and runs the tasks against the fork. Measured in h03; see the correction note
  there.
- **Nothing compares the graph against the state it is resuming.** There is no
  compatibility check anywhere in the resume path — no node-set comparison, no
  channel-set comparison, no fingerprint. A thread paused by one graph will be
  resumed by any other graph handed the same `thread_id`. Every family H
  changed-graph outcome follows from this absence, and it is why the guard is an
  **architecture** obligation rather than a vendor setting to switch on.

### 2.6 Store namespace and search surface

- `validateNamespace` rejects `.`, `%`, `_`, `\`, and the root label `langgraph`.
  It does **not** reject `:`. It is **not** called by `listNamespaces`.
- `vectorSearch` / `hybridSearch` are `protected`. The only public entry point is
  `search(namespace, { mode })`.

---

## 3. PostgreSQL contract (Step 1, **postgres**)

- **`CREATE TABLE IF NOT EXISTS` is not concurrency-safe.** The existence check
  and the create are not atomic; concurrent creators may raise `42P07`
  (duplicate_table) or, once a unique index exists, `23505`.
- **`CREATE EXTENSION` is database-scoped.** This is the reason the harness uses
  one database per case rather than one schema per case: a Store case that
  created `vector` would otherwise decide the outcome of a case that must race
  for it.
- **`pg_advisory_lock` is owned by the session, not by the pool.** A safeguard
  must hold it on a dedicated single connection, never through the subject pool,
  or the DDL can run on a connection that does not hold the lock.
- **`checkpoint_blobs.version` is `TEXT` holding integers.** Ordering it as text
  puts `"10"` before `"2"`, silently reshuffling any projection past nine
  supersteps. All projections cast numerically.
- `xmin` gives transaction identity per row without asking the library.

---

## 4. Concurrency matrix decisions (Step 2)

- Every concurrency claim requires proof that **all** participants reached the
  rendezvous **before** any was released — an N-party barrier with per-party
  arrival rows, distinct backend PIDs, and distinct process nonces.
- Every lock claim requires a captured **blocked → blocking** backend edge, not
  elapsed time.
- Every transaction claim requires **backend drain** plus direct row/`xmin`
  evidence.
- Cases are precommitted as `deterministic` or `bounded-trials`. A
  `bounded-trials` case reports an **observed outcome set** and is never called
  race-free merely because no failure appeared.
- Trials are **per repeat**. A race between containers cannot be cheaply repeated
  inside one case (each trial needs a cold database), so the outcome set is
  aggregated across the run's three isolated repeats, and the report says so.

---

## 5. Store conformance matrix (Step 3)

Required coverage, per the approved scope:

setup/start/stop and use-after-stop; concurrent put/get/delete conflicts; JSON
serialization boundaries; namespace validation, round-trip identity, delimiter
collisions, prefix boundaries; `listNamespaces` prefix/suffix/maxDepth/limit/
offset; `getStats` with live, expired and swept rows; batch success,
read-your-writes ordering, injected operation failure, partial commit, and
`AsyncBatchedStore` rejection fan-out; nested pool acquisition and bounded
exhaustion; TTL zero, negative, refresh-on-read, manual sweep, concurrent
multi-sweeper; the full filter matrix (equality, inequality, numeric ranges,
membership, null, missing keys, nested values, unknown operators, empty lists);
text search, wildcard-shaped queries, JSON key-name matching; vector and hybrid
search for cosine, L2 and inner-product; thresholds, vector weights,
stale/missing vectors, dimension mismatch; migration under changing index
configuration; schema separation, pgvector extension/search-path, privileges.

Two rules fixed here:

1. **Convenience methods and `batch()` are separate paths.** A result from one is
   never generalised to the other.
2. **`InMemoryStore` is not automatically a valid differential oracle.** Where it
   shares the same defect, agreement with it proves nothing. Each case declares
   whether it is a valid, invalid, or absent oracle.

Embeddings are **literal frozen vectors** (8-dim) in `fixtures/embeddings.json`.
Expected rankings in `fixtures/rankings.json` are **hand-authored constants**,
independently computed — never produced by the same search implementation under
test. The embedder **refuses** text absent from the fixture rather than hashing
it, so an unnoticed input change fails loudly instead of silently re-ranking.

---

## 6. Namespace, pruning, restart and safeguard state machines (Step 4)

- **Subgraphs:** nested and parallel topologies, subgraph interrupts, crash
  resume inside a non-root namespace, per-namespace lineage and pending-write
  reuse, plus an **inlined-graph control** proving the extra namespaces come from
  subgraphs. The architecture must not depend on the exact vendor namespace
  string format.
- **Pruning live set:** retained heads ∪ parent lineage ∪ referenced channel
  versions ∪ pending writes ∪ interrupts. The controls are prune-nothing,
  prune-head, and a deliberately incomplete sweep that **must** produce
  detectable stranded references.
- **Restart:** graceful restart, unclean `SIGKILL` with recovery proven from
  database logs, database death under a live worker, full container replacement
  from immutable image IDs on the preserved named volume, and a **fresh-volume
  negative control that must not resume**.
- **Host-reboot boundary:** container-stack replacement is explicitly **not**
  proof of host/WSL/kernel reboot survival. That remains a P4 obligation and must
  be stated as such in the report.
- **Safeguards** (throwaway, in-harness only): advisory-lock single migrator;
  Store `ensureTables: false` after migration; per-thread advisory lease on a
  dedicated session; fail-closed Store namespace/config validation; compatibility
  manifest refusal before resume.

---

## 7. Harness and evidence apparatus (Step 5)

Located at `spikes/postgres-checkpointer-concurrency/`. Spike 05's mechanisms
were **copied and adapted**, never imported or modified; Spike 05's frozen
evidence in `tmp/spikes/langgraph-durability/{final,confirm}` is untouched.

- Evidence schema `agent-runtime/spike-evidence/2`; fixtures schema
  `agent-runtime/spike-fixtures/2`.
- **One PostgreSQL container + named volume per family per repeat**, on one
  shared internal network. Family G (`ownsDatabaseLifecycle: true`) runs last in
  a repeat because it destroys and recreates its own stack.
- **One database per case** — `databaseForCase()` → `spike_<sanitized_case_id>`.
  `provision --family <F> --cases <csv>` creates them and emits a `databases` map
  the driver reads.
- Workers run unprivileged as PID 1, read-only filesystem, all capabilities
  dropped, no published ports, no source mount. Posture is measured per worker,
  not assumed.
- App-name convention `<case>:<member>#<role>`. Concurrency witnesses count
  distinct **parties** (split on `#`), never connections — four pooled
  connections from one process must not read as four parties.
- Pool roles: `subject`, `probe`, `observe`, `inspect`, plus `lease` and
  `migrator`.
- **Statement gate:** patches `query` on each physical client via
  `pool.on('connect')`, passing `text`/`values` **byte-identically**. `post` gates
  fire on **rejection as well as fulfilment** — required because the cold
  migration-version read legitimately rejects with `42P01`.
- **Kills anchor on a durable `spike_probe.gate_park` row** via the `awaitpark`
  subcommand, never on a sleep. The registry enforces that a kill case launches
  `sequential`.
- Exit codes: `0` pass, `1` measured fail, `2` usage, `3` harness fault,
  `4` sanitization failure.
- Non-final runs (`--lane` / `--family` / `--only` / `repeats < 3`) write
  `evidence.subset.json` and **never** `evidence.json`.
- Volumes are released only when a repeat passes. A failing repeat preserves its
  containers, network and volumes, and `--cleanup` refuses on a failed run.
- Candidate evidence is **scanned before promotion**: no credential, DSN
  password, host path, raw checkpoint payload, arbitrary Store value, or database
  log containing sensitive material may survive.

### 7.1 Structural anti-tautology rules

- **Declared oracles are verified present.** `cases.ts` declares each case's
  oracles; `summarize.ts` checks each one produced something. Without this,
  `[].every(...) === true` and `undefined !== false` would make "never measured"
  read as "measured clean".
- **`pairedWith` is mechanical.** The driver expands any selection to include the
  stock pair of every selected mitigation case, so a mitigation can never be
  reported without its stock result in the same evidence set.
- **Per-lane digests plus an overall digest over the per-lane digests** — not
  over concatenated managed arrays — so one unstable lane cannot contaminate the
  bytes a citable lane's claim rests on.

### 7.2 Digest rules (hardened during Steps 8–9)

- `bounded-trials` cases contribute **only structural facts** to `managed`. Their
  `results` and `sqlstateMultiset` are replaced with `"<race outcome: see
  findings>"` and retained verbatim in a separate, non-digested top-level
  `findings` array. Digesting a genuine race outcome would report expected
  variation as a reproducibility failure.
- `VOLATILE_RESULT_KEYS` = `{party, acquiredAt, releasedAt, observedContention,
  waitedMs}` are stripped from digested results wherever they appear.
- `managedResults()` sorts the remaining results by content signature, making
  symmetric racers an **order-invariant multiset**: "one session ran five ledger
  inserts and three ran none" is preserved; "it happened to be party 2" is not.
- The drain record contributes only `drained` / `remaining`; its `waitedMs` is a
  property of TCP teardown on the day and stays in `findings`.
- **Acceptance is the elementwise AND across every repeat**, and the global
  cross-repeat criteria are printed and tallied alongside the per-case ones.

---

## 8. Measured results to date

### 8.1 Family S — harness self-test (Step 8)

All 26 criteria pass. The load-bearing ones:

- Overlap witness **4** with parallel launch vs **1** for the sequential control
  running the same four participants — the differential is what makes "four
  parties overlapped" mean something.
- Gate statement multiset and order **byte-identical** to an ungated run, with
  **0** unclassified vendor statements.
- Lock edge `p1#subject → p0#subject`, `transactionid`, `ShareLock`, with both
  independent lock oracles agreeing and zero unattributed backends.

**Defect found by running it:** `declared_gates_were_reached` passed vacuously —
it compared a snapshot instead of the live `reached` set. `Instrumentation.reached`
and `.unreached` are both **functions**. Fixed.

### 8.2 Family A — setup and migrations (Step 9)

13 cases (`a01`–`a13`), three isolated repeats, **one distinct overall digest**,
`reproducible_across_runs: true`, `acceptance_stable_across_runs: true`.

| Finding | Evidence |
| --- | --- |
| Concurrent `PostgresSaver.setup()` fails loudly for most callers but converges | Gated lane: 4 racers **proven** to have read an empty ledger (4 durable park rows on the version read, 4 distinct backends, released only after all arrived); 3 of 4 raise `23505`; terminal schema and ledger match the serial baseline exactly |
| The sequential control discriminates | Same 4 racers, same gate, released one at a time: exactly **1** runs migrations, nothing raises |
| `PostgresStore.setup()` races identically | a07: 3 of 4 raise `23505`, schema converges |
| The trigger migration is genuinely non-idempotent | a08: ledger rewound past migration 3, both racers replay it, trigger exists **exactly once** afterwards |
| Lazy setup races itself **inside one process** | a09: 8 concurrent first operations → **8** migration reads during the operation phase, 1 `put` fulfilled, **7** rejected `23505`. Control a10 (awaited setup): **0** migration statements, 8/8 fulfilled |
| A killed migrator leaves the schema ahead of the ledger | a05: after `SIGKILL` at the ledger insert, `checkpoints` exists with ledger `[0]`; retry converges to baseline `[0,1,2,3,4]`; `waitExit` 137 and **no** shutdown witness row proves the kill was uncatchable |
| An index-config change is a silent no-op | a11: ledger unchanged, column stays `vector(8)`, mismatch surfaces only on write as `22000`, `vectorRows` 0 |
| The advisory-lock safeguard eliminates the failures | a13: **0** SQLSTATEs across 4 racers, every session's `pg_advisory_unlock` returned true, holding intervals disjoint on the **server** clock, terminal schema identical to baseline |

Observed SQLSTATE sets across the three final repeats:

| Case | r1 | r2 | r3 |
| --- | --- | --- | --- |
| a02 passive race | `{23505:2, none:2}` | `{23505:2, none:2}` | `{23505:1, none:3}` |
| a03 gated race | `{23505:3, none:1}` | `{23505:3, none:1}` | `{23505:3, none:1}` |
| a07 Store race | `{23505:3, none:1}` | `{23505:3, none:1}` | `{23505:3, none:1}` |
| a08 trigger race | `{23505:1, none:1}` | `{23505:1, none:1}` | `{23505:1, none:1}` |
| a13 advisory lock | `{none:4}` | `{none:4}` | `{none:4}` |

`42P07` (duplicate_table, from concurrent `CREATE TABLE IF NOT EXISTS`) was also
observed during harness development, in runs not part of the citable set. The
outcome is therefore a **bounded set**, not a fixed profile, and must be reported
that way.

### 8.3 Family B — checkpointer concurrency and conflicts (Step 10)

9 cases (`b01`–`b09`), provisioned with a migrated checkpointer.

| Finding | Evidence |
| --- | --- |
| **Two workers resuming the same interrupt both execute it** | b02: `finish` executed **2×** on **2 distinct process nonces**; `gate/resumed` 2×; the root namespace ends with **2 leaves** — a forked lineage. Both workers returned success. Observed in **5 of 6** repeats across two runs; 1× in the sixth, so the outcome set is `{1, 2}` and it is reported as a bounded race, not as "always duplicates" |
| Sequential resume does **not** duplicate | b03 control: same two workers, same fixture, released one at a time — `finish` executed **1×** on **1** process, in every repeat |
| **Terminal graph output is not evidence of execution** | b03: the second worker returned `steps: ["prepare","gate","finish"]` and `completed: true` while contributing **zero** node executions. It read the persisted state channel back. This is why the independent probe is the oracle |
| Same checkpoint id → last-writer-wins on the row | b04: exactly **1** checkpoint row survives, its metadata belongs to exactly one writer, never a merge |
| Same `(channel, version)` → first-writer-wins on the bytes | b05: **both** checkpoint rows survive, **1** blob row, owned by one writer — so the losing checkpoint points at bytes it did not write |
| **A single `put()` collision splits the row from its bytes** | b06: one checkpoint row and one blob row survive, and `rowOwnerEqualsByteOwner` is **false in all three repeats** (row `p0`/bytes `p1`, then `p1`/`p0`, then `p0`/`p1`). The surviving checkpoint describes state that its own writer never stored. Invariant, because the row is `DO UPDATE` and the bytes are `DO NOTHING` |
| `putWrites` has **opposite** semantics on one table, chosen by channel name | b07 ordinary channel → `idx 0`, first-writer-wins (`DO NOTHING`). b08 `__interrupt__` → `idx -3`, last-writer-wins (`DO UPDATE`). Same method, same table, same primary key |
| Readers never observe a torn checkpoint | b09: 59–66 samples per repeat while a writer committed a 5-checkpoint chain; **0** samples saw a stranded reference or a broken parent, and the reader saw **≥2 distinct checkpoint counts**, proving it sampled during the writes rather than after them |

### 8.4 Family C — atomicity, pools, locks, deletion (Step 11)

9 cases (`c01`–`c09`).

| Finding | Evidence |
| --- | --- |
| `put()` is atomic against process death | c01 (killed after both blob upserts, before the checkpoint row) and c02 (killed after every row, before `COMMIT`): **0 checkpoints, 0 blobs, 0 writes** survive |
| An acknowledged commit **is** durable | c03 (killed after `COMMIT` returned, before the promise resolved): **1 checkpoint, 2 blobs** survive. This is what makes c01/c02 mean "the transaction rolled back" rather than "the kill landed early" |
| `putWrites()` is atomic across multiple rows | c04: 3 writes in one transaction, killed before `COMMIT` → **0** write rows |
| **The detector is not blind** | c05 control — harness SQL writing a checkpoint and its blob in two *autocommit* statements, killed between them — left **1 checkpoint, 0 blobs, 1 stranded reference**. Partial state is therefore detectable, which is the precondition for c01–c04 meaning anything |
| A starved pool serializes rather than hangs | c06: 6 concurrent `put()`s through `max: 1` → **6/6** fulfilled on **1** backend, **0** idle-client errors |
| Connection exhaustion is loud and bounded | c07: role limit 2 → 2 accepted, 2 refused, single SQLSTATE **`53300`**. No hang, no anonymous timeout |
| Lock contention proven, not inferred | c08: captured edge `p1#subject → p0#subject`, `transactionid`/`ShareLock`, both lock oracles agreeing, **0** unattributed backends and **0** self-edges, sampled while the holder was still parked before `COMMIT` |
| **`deleteThread()` can strand a surviving checkpoint's parent** | c09: writer parked after its blobs, deleter ran to completion, writer then committed → the writer's rows survive as an atomic set (**0** stranded, **0** orphans) but with **`brokenLineage: 1`** — a checkpoint whose `parent_checkpoint_id` names a row the delete removed |

### 8.5 Step 12 verification result — the core concurrency sub-result

Run `core-v4`, families S+A+B+C, **37 cases**, three isolated repeats:

- **176/176 acceptance criteria pass in every repeat.**
- `reproducible_across_runs: true`, `acceptance_stable_across_runs: true`.
- **One distinct overall digest:** `3e84d5e21c3b559fe31e3bc1d9c35f5f7f0ec871428d8c4940dcc958ea0676b4`
  — **as computed at the time, and no longer reproducible.** The digested form
  changed twice after this (Steps 25 and 31) and `core-v4` has been deleted. The
  FINDINGS in this section stand; the digest does not. Cite `frozen-v2`'s
  `1dfdb524…` instead.
- Per-lane digests, identical across all three repeats:
  - `selftest` `be5afd9438b890d93c9d0a38817f63033bd687a36404ab5ae011a623c9cc508e`
  - `stock` `bd350bf3e00c8b4c170eb29034091d96eb998283cb22693d9b490dbd8e19471c`
  - `mit-migration` `83993dc2a440091e0078e0f19c39d70a7181661975aa4a1abfef728b15bd5cbc`
- `no_declared_oracle_missing`, `every_worker_posture_measured`,
  `no_credential_in_evidence` all true. Typecheck and shell syntax clean.

### 8.6 Family D, slice 1 — Store setup, lifecycle, CRUD, schema (Step 14)

13 cases (`d01`–`d13`). Smoke run `d-smoke2`, **one** repeat, **68/68 pass**.
`d08` and `d09` are `bounded-trials`, so their outcomes below are a **single
sample** and must not be reported as behaviour until the three-repeat run.

| Finding | Evidence |
| --- | --- |
| **A rejected `put()` is not a no-op** | d06: an indexed item re-put with text the frozen embedder refuses. `put()` **rejects**, and the item is left holding the **new** value with **0** vector rows and `unindexedItems: 1` — still readable, now invisible to vector search. `executePut` upserts the row, DELETEs the vectors, and only then embeds, all autocommit, so the caller's failure arrives after two commits |
| The control localises it | d07: the identical sequence with known text leaves **1** vector row on the new value. d06's empty vector set is the failure's doing, not the fixture's |
| **A closed Store fails anonymously** | d03: all four operations after `stop()` fail — but with a bare `Error`, `"Cannot use a pool after calling end on the pool"`, and **SQLSTATE `null`**. Nothing checks `isClosed`; the ended pool refuses. A second `stop()` is safe, and the pre-`stop()` write survives |
| `ensureTables: false` behaves as the safeguard needs | d04 (cold): every operation refused, **0** tables created, **0** migration statements. d05 (migrated): every operation completes, still **0** migration statements |
| Lazy setup migrates inside the first operation | d02: migration statements appear **during** the operation phase; d01's explicit `start()` shows **0** there. Same terminal ledger |
| **The Store's schema is not self-contained** | d12: `CREATE EXTENSION vector` lands in **`public`**, never in `lg_store`; `store_vectors.embedding` resolves to `public.vector`. A second Store migrated on a connection whose `search_path` holds only its own schema fails with **`42704` `type "vector" does not exist`** |
| Schema separation does isolate DATA | d11: two Stores, two schemas, same namespace and key — each returns its own value, each schema holds exactly 1 item, ledgers independent, stored digests differ (read from the tables, not through either API) |
| **A metric change is a silent no-op** | d13: restart configured for `l2` after a `cosine` setup → ledger unchanged `[0..6]`, only `idx_store_vectors_embedding_cosine_hnsw` exists, the configured metric has **no index at all**, writes still succeed. The a11 mechanism with a consequence nothing raises on |
| `put` racing `delete` can lose an acknowledged write | d09 (1 sample): **both** callers returned success and the terminal state holds **0** items. The put committed and the delete removed it; neither caller was told |
| Concurrent puts did not split row from vectors (1 sample) | d08: `itemRows 1`, owner `p1`, vectors `["p1"]`, `itemOwnerEqualsVectorOwner: true`, `orphanVectors 0`. Unlike b06 the split is **not forced** — both sides are last-writer-wins in separate autocommit statements — so ordering decides and one sample proves nothing either way |

**Value serialization (d10), nine hand-authored literal expectations, all matched:**
`undefined` keys dropped; `Date` → ISO string, round-trips as a **string**;
`NaN`/`±Infinity` → `null`; a NUL byte rejected by PostgreSQL with **`22P05`**;
a `BigInt` rejected by `JSON.stringify` with a `TypeError` and **no SQLSTATE**,
never reaching the database; non-ASCII keys and nesting intact.

Two expectations were **wrong when first authored and the criteria caught them**
— the literal-oracle discipline working, not a harness defect:

- **JSONB orders object keys by LENGTH first, then bytes.** Not insertion order,
  not alphabetical: `{"title","marker"}` stores `title` first, `{"z","aa"}`
  stores `z` first. A discriminating case was added, because the original
  key-order case used only single-character keys and could not tell length-first
  from lexicographic.
- **JSONB `numeric` re-renders positionally.** `1e308` is stored and returned as
  **309 digits**. The value survives; its representation does not.

### 8.7 Family D, slice 2 — batch, pool, TTL (Step 15)

13 cases (`d14`–`d26`). Smoke runs `d-smoke3` / `d-smoke4`, **one** repeat,
**52/52 pass**. `d26` is `bounded-trials`, one sample.

| Finding | Evidence |
| --- | --- |
| **`batch()` commits a prefix and abandons the suffix** | d15: three puts, the middle one an invalid namespace. The batch rejects, `p-before` **is committed**, `p-after` never ran. `batch()` acquires one client and loops with sequential awaits — there is no `BEGIN` anywhere — so the caller learns the batch failed and nothing tells it which half happened |
| The convenience path does not behave that way | d16 control: the identical three writes one call at a time — the failure is isolated to its own call and the third still runs. Confirms the "never generalise batch from convenience" rule with a measurement rather than an assertion |
| **A caller can be told its write failed after it committed** | d17: four independent callers enqueued in one tick through `AsyncBatchedStore`, one invalid. `processBatchQueue` catches once and runs `batch.forEach(({reject}) => reject(e))`, so **all four reject** — yet `fan-a` and `fan-b` are **present in the table**. Two callers received a rejection for a write that is durable |
| **A batch carrying a search deadlocks a pool of one** | d18: `batch()` holds the only client; with no index configured, `executeSearch` delegates a query to `textSearch`, which calls `withClient` and waits for a connection that cannot be returned. The call **did not settle within 15s**. d19 (pool of 2) completes with 1 result; d20 (pool of 1, index configured, so the query reuses the held client) completes with 1 result. Three points isolate it to the unindexed text-search branch under a starved pool |
| A starved Store pool does **not** hang on its own | d21: six concurrent convenience puts through `max: 1` → 6/6 fulfilled on **1** backend, all six items written. This is what stops d18 being blamed on the pool size |
| **`ttl: 0` means "never expires"** | d22: `calculateExpiresAt` guards with `if (!effectiveTtl) return null` and zero is falsy, so a zero-minute lifetime produces `expires_at NULL` and a permanently readable item — the inverse of the request. `ttl: -1` is arithmetic instead: a past `expires_at`, and `get()` returns null. A positive ttl lands in the future, so the pair is not vacuous |
| **A read can shorten the item it read** | d23: item written with `ttl: 600`, `defaultTtl: 1`, `refreshOnRead: true`. The read issues **1** `UPDATE` and moves `expires_at` from `2026-09-02 06:47` to `2026-09-01 20:48` — roughly **ten hours earlier**. `refreshTtl` recomputes from `defaultTtl` and ignores the ttl the item was written with |
| The refresh is driven by the default alone | d24 control: `refreshOnRead` with **no** `defaultTtl` → `calculateExpiresAt()` returns null, **0** update statements, `expires_at` untouched |
| Expired rows are still rows | d25: 3 live + 4 expired → `getStats` reports `total 7, expired 4`, agreeing exactly with the table. `sweepExpiredItems()` returns **4**, leaving 3 live and 0 expired. `get()` filters expired rows without removing them |
| Concurrent sweepers divide the work without double-counting | d26 (1 sample): counts `[6, 0]` summing to the 6 seeded expired rows, no error, the live row survives both. The split is an interleaving outcome; the **sum** is the invariant |

### 8.8 Family D, slice 3 — namespaces, pagination, filters (Step 16)

10 cases (`d27`–`d36`). Smoke run `d-smoke5`, **41/41 pass on the first run** —
every one of the 10 authored namespace shapes and all 13 authored filter
expectations matched without correction.

| Finding | Evidence |
| --- | --- |
| **The delimiter is a legal label character** | d27: `validateNamespace` rejects `.`, `%`, `_` and `\` — an ordinary underscore is refused — but accepts `:`, which is exactly what the Store joins labels with |
| **So two different namespaces are one row** | d28: `["spike","a:b"]` and `["spike","a","b"]` both join to `spike:a:b`, which is half the primary key. **1** row exists; the second write overwrites the first, and reading through *either* namespace returns it. Namespace round-trip identity does not hold |
| **Prefix matching is string-prefix, not path-prefix** | d29: `LIKE 'alpha%'` — `listNamespaces({prefix:["alpha"]})` returns `["alpha","alpha:one","alphabet"]`. `alphabet` is nowhere underneath `alpha`. `search()` builds the same pattern and crosses the same boundary. A deeper prefix (`alpha:one`) is still exact, so prefixes are not simply broken |
| **`maxDepth` is applied after `LIMIT`** | d30: four namespaces, three at depth 2 sorting first. `{maxDepth:1, limit:2}` returns **nothing**; `{maxDepth:1, limit:100}` returns `["zz"]`. The same `limit:2` without `maxDepth` returns a full page, so the empty page is the interaction, not a broken limit |
| **`listNamespaces` skips the validator every other path runs** | d31: `prefix:["%"]` is accepted and returns **both tenants** (`tenant-a:x`, `tenant-b:y`), while `search(["%"])` and `put(["%"],…)` both refuse it. `validateNamespace`'s own source comment cites cross-tenant exposure as the reason it exists |
| Ordinary pagination is sound | d32 control: limit/offset over a flat set gives full, disjoint pages covering the whole set |
| The filter matrix behaves as the SQL says | d33: all 13 authored expectations matched. `$ne` returns `["f1","f3","f4"]` — it **excludes the row holding a JSON null and the row missing the key**, because `NULL != '2'` is NULL. A nested-object filter is `@>` **containment**, so `{nested:{a:1}}` also matches `{a:1,b:2}` |
| **Three filters fail OPEN** | d34: an unrecognised operator (`$regex`), an empty `$in`, and an empty `$nin` each produce no condition at all — `buildOperatorCondition` falls to `default: break` and the caller only appends conditions it was given. All three return **every row**, and none raises. A restrictive filter over the same corpus still returns exactly one row, so this is the filter being dropped rather than the corpus being small |
| A `null` or array filter value matches nothing | d35: `{n:null}` compares against the literal text `"null"`, which `->>` never produces for a JSON null; `{tags:[1,2]}` compares against `String([1,2])` = `"1,2"`. `$exists` confirms both rows are present |
| **A numeric filter fails the whole query on mixed types** | d36: `(value ->> key)::numeric` is applied across the scanned set, so one row holding text at that key raises **`22P02`** and the query returns nothing. An equality filter on the same key still works, so the failure is specific to the casting operators |

### 8.9 Family D, slice 4 — text, vector and hybrid search (Step 17)

9 cases (`d37`–`d45`). Smoke run `d-smoke6`, **35/35 pass**. Every ordering is
scored against `fixtures/rankings.json`, authored by hand from the frozen vectors
and pgvector's documented operators.

| Finding | Evidence |
| --- | --- |
| Cosine ranks correctly | d37: `["alpha","beta","delta","gamma"]`, matching the authored order exactly |
| L2 ranks correctly, and differently | d38: `["alpha","gamma","beta","delta"]`, matching the authored order — and different from cosine, which is what proves `distanceMetric` is not being ignored |
| **Inner-product ranking is exactly reversed** | d39: authored `["beta","delta","alpha","gamma"]`, actual `["gamma","alpha","delta","beta"]` — `isExactlyReversed: true`. pgvector's `<#>` returns the **negative** inner product, and the implementation orders `MIN(<#>)` **descending**, so the best match sorts last. The whole corpus is returned; only the order is wrong |
| **One `similarityThreshold`, three meanings** | d40: the same corpus and query. Cosine `0.9` → `["alpha","beta"]` (negated into a distance bound, correct). L2 `1` → `["alpha","gamma"]` (used as a raw **distance** ceiling, a different notion). Inner product `0.5` → **`[]`**, because it is compared against a quantity that is always negative. Without a threshold all four come back |
| An unindexed item is invisible to vector search | d41: the store-to-vectors join is an INNER join, so an item written with `index: false` cannot appear however well it matches — but text search finds it and the projection lists it as unindexed. This is the same readable-but-invisible state d06 produces by accident |
| A dimension mismatch is loud but unclassifiable | d42: `Query embedding dimension mismatch: expected 8, got 9`, a plain `Error` with **SQLSTATE `null`** — guarded in JavaScript ahead of any SQL. Same shape as the closed-Store failure in d03 |
| Hybrid weighting works, and is cosine-only | d43: at `vectorWeight: 1` the mixed item ranks last and the rest reproduce the cosine order; at `0` it rises into the top two on text alone. `hybridSearch` always uses `<=>` — `distanceMetric` is not a parameter it accepts |
| Text search indexes the serialized JSON | d44: a query for the field **name** `title` matches every item, and a `%` query matches every item through the OR'd `value::text ILIKE '%%%'` fallback. A term appearing nowhere matches nothing, so neither is an unfiltered query |
| **`batch()` can only ever do cosine** | d45: a batched search operation carries no mode, no `distanceMetric` and no threshold, and `executeSearch` routes a query on an indexed Store straight to the cosine path. The same query that ranks three ways through `search()` has exactly one available ranking through `batch()` |

### 8.10 Step 18 verification result — the complete Store sub-result

Run `store-v1`, family D, **45 cases**, three isolated repeats:

- **179/179 acceptance criteria pass in every repeat.**
- `reproducible_across_runs: true`, `acceptance_stable_across_runs: true`;
  the three per-repeat acceptance maps are byte-identical.
- **One distinct overall digest:** `4bf493dcbd44344859a35c422dcdc95bd65bd770f13f721c463821c263c64074`
  — **as computed at the time, and no longer reproducible**, for the reason given
  in §8.5. The findings stand; cite `frozen-v2`'s `1dfdb524…`.
- Lane digest `stock` `189dba1428a6b68dd613970a6b7934fed2f1ab681c19c8c36165a005016aa133`
- `no_declared_oracle_missing`, `every_worker_posture_measured`,
  `no_credential_in_evidence` all true.

Bounded-trials outcome sets over the three repeats:

| Case | r1 | r2 | r3 | Reading |
| --- | --- | --- | --- | --- |
| d08 concurrent put | owner `p1`, agree | owner `p1`, agree | owner `p0`, agree | Which writer wins varies; the row and its vectors had the **same** owner in all three. The b06-style split is possible in principle but was **not observed** — three samples, reported as such |
| d09 put vs delete | `itemRows 1` | `itemRows 0` | `itemRows 0` | **Both outcomes occur**, and in every repeat *both callers returned success*. A put can report success and leave nothing behind |
| d26 concurrent sweepers | `[0,6]` | `[6,0]` | `[0,6]` | One sweeper always takes all six; the **sum** is invariant, the split is not |

One reproducibility hazard was fixed before this run: d23/d24 returned absolute
`expires_at` instants into their results, which would have entered the digest and
changed every run. They joined `VOLATILE_RESULT_KEYS`; the criteria depend on the
**direction** of the change, which is computed in the participant and digested as
a boolean, and the instants remain in `findings`.

### 8.11 Family E — subgraph namespaces and lifecycle (Step 20)

9 cases (`e01`–`e09`). Smoke run `eh-smoke4`, **one** repeat, **97/97 pass**
across families E and H together. `e08` is `bounded-trials`, so its outcome is a
**single sample**. Nothing here is a sealed sub-result: families E and H are
verified together with the rest at Step 26.

| Finding | Evidence |
| --- | --- |
| A subgraph gets its own namespace, and the control proves the subgraph caused it | e01: 2 namespaces, each chain singly rooted with one leaf, subgraph checkpoints naming an ancestor run through `metadata -> 'parents'`. e02 control — the **same four node bodies** inlined — produces exactly **1** namespace and **0** cross-namespace parents |
| Two instances of one compiled subgraph do not collide | e03: the same compiled object added as two nodes yields **3** distinct namespaces (root plus one per call site), both instances execute their nodes (`sub_a` 2×, `sub_b` 2×), and the two children are siblings of one parent |
| Nesting composes to depth two | e06: 3 namespaces, containment depth **2**, every chain singly rooted. Depth is derived from string containment, never by counting `\|` or `:` |
| **A subgraph interrupt is recorded at BOTH levels** | e04: `__interrupt__` rows land **once in the subgraph namespace and once in the root** — the parent task hosting the subgraph re-raises it as it bubbles up. The authored expectation was that the interrupt is confined to the namespace it was raised in; it is not. Anything counting `__interrupt__` rows to decide how many approvals are outstanding double-counts a nested one |
| Resume re-enters the subgraph rather than restarting it | e04: `sub_gate` entered **2×**, resumed **1×** — the replay is expected, a second consumption is not — and the run completes |
| A crash inside a subgraph resumes into the same namespace | e05: worker SIGKILLed while executing `sub_b`, anchored on a durable park row; no shutdown witness (uncatchable), backend drained before projection; `sub_b` re-executes on a **second process**, every chain stays singly rooted, and the namespace count equals e01's uncrashed baseline |
| **Pending-write reuse does not happen inside a subgraph** | e07: a two-sibling fan-out where `sub_slow` throws after `sub_fast`'s write has landed. On resume `sub_fast` executes **again** (2 executions, 2 processes) despite its pending write being present and its task id unchanged |
| The root control isolates the subgraph as the cause | e09: the **identical** topology and the **identical** thrown failure at the root — `sub_fast` executes **once** (reused), `sub_slow` twice. Only the nesting differs, so the lost reuse is attributable to the subgraph boundary and to nothing else. Mechanism in §2.5: `skipDoneTasks` is a key-presence test that a task-derived config always fails |
| Concurrent resume of a subgraph interrupt forks the ROOT, not the child | e08 (1 sample): both workers released together (2 distinct nonces, all arrived before release); `sub_gate` entered 1× / resumed 1×, but `finish` executed **2×** on **2** processes and the thread ends with **2 leaves in the root namespace and 1 in the child**. The duplicate execution family B found is not confined by the namespace boundary |

### 8.12 Family H — effect keys (Step 20)

7 cases (`h01`–`h07`), the effect-key half of family H; the changed-graph and
compatibility-guard cases are Step 21. Same smoke run, same one repeat. `h04` is
`bounded-trials`.

The key under test is the one proposed in
`architecture/09-data-model-and-lifecycle.md:106`,
`hash(run, ns, parent_checkpoint, task, ordinal, tool, canonical_args)`. It is an
**architecture** construct: LangGraph publishes no effect key. Every case
collects it twice — from the config a node can see while it runs, and from
`checkpoint_writes` afterwards — and the two are never reconciled inside the
harness.

| Finding | Evidence |
| --- | --- |
| **Only two of the seven components are publicly reachable** | h01: `run` and `ns` come off the public config. `parent_checkpoint` requires `configurable.checkpoint_map`, undocumented; `task` requires `__pregel_task_id`, private by naming convention. `ordinal`, `tool` and `canonical_args` are runtime state by construction |
| **The obvious field is deliberately empty** | h01: `configurable.checkpoint_id` is `null` inside every task — present as a key, undefined as a value. A runtime keying on it would hash `null` for every effect. That same present-but-undefined key is the mechanism behind e07 |
| **The namespace a node sees is not the namespace its writes carry** | h01: the task namespace (`<graph ns>` plus its own `<node>:<taskId>`) differs from the `checkpoint_ns` on its write rows in every case. A key built from what the node sees could not be rediscovered from the tables — and, because the task namespace embeds the task id, `ns` and `task` would stop being independent |
| The four row-recoverable components do reconstruct | h01, h05, h07: every recorded effect has a `checkpoint_writes` row with the same `(ns, parent_checkpoint, task)` triple |
| **The key IS stable across a sync crash resume** | h02: worker killed after recording its effect and before its writes landed; the fresh container computed the **identical** key, with identical `ns`, `parent_checkpoint`, `task` and `ordinal`. The first of the two properties `architecture/09` marks "assumed, not measured" holds |
| **The key DOES change across an explicit fork** | h03: replaying from an explicit `checkpoint_id` produced a different key, a different parent checkpoint, a different task id, and a second head in the root namespace. The second assumed property holds. **The authored expectation was wrong**: it predicted the fork would reuse the named checkpoint as the uuid5 namespace and therefore reproduce the key. It does not — the engine writes a new `source: "fork"` checkpoint and runs the tasks against that |
| The pair is the result | h03: one mechanism measured in both directions by one harness — unchanged where the ledger must suppress, changed where it must not. Either alone would be consistent with a key that is simply always stable, or always volatile. A second, genuinely different call in the same run keeps "the keys matched" non-vacuous |
| **`task` is load-bearing** | h05: three siblings in one superstep calling the same tool with the same arguments — every component except `task` identical. The full key gives **3** distinct values; dropping `task` collapses them to **1** |
| **`ordinal` is load-bearing and is not in the database** | h06: one node execution performing three identical effects. The full key gives **3**; dropping `ordinal` gives **1**. The row side has **fewer** write rows than effects, because `idx` counts a task's writes, not a node's effects — so the ordinal is runtime state the ledger must carry itself |
| The key survives one namespace down | h07: the same tool and arguments at the root and inside a subgraph land in different namespaces with different parent checkpoints, produce different keys, and both remain reconstructible from rows |
| Async durability, 1 sample | h04: the superstep survived the kill, so the key matched. Whether it survives is the race, so the outcome is reported as a set and not as behaviour |

### 8.13 Family H — changed graphs and the compatibility guard (Step 21)

10 cases (`h08`–`h17`), five stock and five guarded, one pinned variant each.
Smoke run `eh-smoke6`, **one** repeat, **144/144 pass** across E and H together
(lane digests `stock 329d3b4f…`, `mit-compat 18e2f6f0…`). Not a sealed
sub-result: verification across three repeats is Step 26.

The guard is **architecture**, not vendor. LangGraph publishes no compatibility
check. `architecture/09-data-model-and-lifecycle.md:159` requires one and marks
the quarantine path **not verified**; these cases are what makes it measurable.

The manifest has two halves, and keeping them apart is the whole design:
**structure** (node and channel names, read off the *compiled* graph, not off
anything the fixture declares) and **fingerprints** (a normalised hash of each
node's own source, comments stripped and whitespace collapsed). Every variant
changes exactly one thing.

**Stock lane — what the engine does when nothing stops it:**

| Variant | Outcome |
| --- | --- |
| identical (control) | Resumes, consumes the interrupt once, completes. This is what makes every refusal below mean something rather than "this fixture never resumes" |
| cosmetic | Resumes and completes. Neither manifest half sees the change, which is what stops the normalisation rule being a source-hash equality check that would quarantine every reformatting |
| **renamed node** | **The quietest and worst failure of the four.** The resume returns **no error**, a result object, and `completed: true` — while executing **zero** nodes and leaving the checkpoint head, the checkpoint count and the interrupt row exactly where they were. The caller is told the run succeeded; the approval it was waiting on is silently abandoned. The authored expectation was "resumes into the wrong branch"; the measured behaviour is worse, because nothing anywhere reports a problem |
| added channel | **Harmless.** Resumes, consumes the interrupt, completes. The persisted state simply lacks the new channel and its default applies. The authored expectation that a changed state-channel set is dangerous was **wrong** for a *widened* schema |
| **moved interrupt** | The decision payload is delivered to a position that no longer interrupts. The run advances past the old pause point and raises a **new** interrupt at the node the call moved to: `completed: false`, head advanced. The original approval is consumed by nothing and a fresh one is now outstanding — "resuming into the wrong branch", measured |

**Mitigation lane `mit-compat` — the guard:**

| Requirement | Evidence |
| --- | --- |
| Allows identical and cosmetic | h13/h14: verdict `compatible`, invoked, resumed, completed, and `h13` reproduces its stock pair's outcome exactly |
| Refuses before invoking | h15/h16/h17: `invoked: false` in all three. A guard that refused *after* invoking would already have consumed the interrupt it exists to protect |
| Leaves persisted state untouched | h15/h16/h17: checkpoint count, interrupt rows and head id all unchanged, and **zero** graph nodes executed |
| Produces a stable typed refusal | Code `graph_incompatible`, with sorted reasons naming the specific change: `node-added:approval` + `node-removed:gate` (+ the engine's own `branch:to:*` channels) for the rename, `channel-added:notes` for the widened schema, `node-body-changed:{gate,finish}` for the moved interrupt |
| **Refuses exactly the unsafe variants** | The lane-level criterion: invoked `[true, true, false, false, false]` across the five |

Two results that justify design choices rather than merely passing:

- **The moved interrupt is structurally invisible.** `structureDiffers: false`,
  `fingerprintsDiffer: true`, and the refusal carries **no** structural reason.
  A manifest built from node and channel names alone would have waved it
  through. This is the entire justification for fingerprinting node bodies, and
  it is exactly the change `architecture/09` warns about when it says interrupt
  matching is positional.
- **The guard over-refuses the widened channel set**, recorded as its own
  criterion rather than hidden. h11 measured that the engine tolerates the
  variant; h16 refuses it anyway. That is the deliberate cost of a fail-closed
  rule that cannot distinguish a widened schema from a narrowed one without
  deciding semantic equivalence, which it cannot do. A mitigation that quietly
  over-refused would be changing more than its stated target.

### 8.14 Family F — retention and blob reachability (Step 22)

10 cases (`f01`–`f10`). Smoke run `f-smoke1`, **one** repeat, **38/38 pass**
after one authored expectation was corrected. Not a sealed sub-result.

Each case uses **two threads** in one database: a `retained` thread paused on a
committed interrupt, and a `stale` thread run to completion. Two rather than one
because pruning is inherently cross-thread — within a single chain every
checkpoint is an ancestor of the head, so a correct reachability sweep deletes
nothing and the case would prove nothing.

**The schema fact that governs everything else (source, confirmed by reading all
four migrations):**

> There is **no timestamp column anywhere** in the checkpointer schema.
> `checkpoints` is `(thread_id, checkpoint_ns, checkpoint_id,
> parent_checkpoint_id, type, checkpoint, metadata)`; `checkpoint_blobs` is
> `(thread_id, checkpoint_ns, channel, version, type, blob)`;
> `checkpoint_writes` is `(thread_id, checkpoint_ns, checkpoint_id, task_id, idx,
> channel, type, blob)`. Not one `created_at`.

So "delete data older than N days" cannot be expressed against these tables. The
only time-like handles are `checkpoint ->> 'ts'` inside the JSONB document and
the fact that `checkpoint_id` happens to be a time-ordered UUIDv6 — an encoding
assumption, not a column. **`checkpoint_blobs` has neither**: its only ordering is
`version`, a per-channel counter that says nothing about when the row was
written. A date-based retention policy therefore cannot reach the blob table at
all, and must go through reachability or not at all.

| Finding | Evidence |
| --- | --- |
| **Blob rows are shared, heavily** | f01: `sharingMax` **6** — one blob row referenced by six live checkpoints — with **10** shared versions in a three-checkpoint thread. A channel that stops changing keeps its version number and every later checkpoint goes on referencing it |
| Naive date-based checkpoint deletion breaks lineage and strands blobs | f02: deleting all but the newest two checkpoints by `checkpoint ->> 'ts'` left `brokenLineage 1` and `orphanBlobs 1`. Deleting by date cannot know what the survivors point at |
| **Naive version-based blob deletion corrupts the live head, silently** | f03: "delete every blob version superseded by a newer one" — the only rule the blob table's columns permit — deleted 3 blobs and produced **3 stranded references** on the retained thread. And the resume then **completed with the full step list and no error**. The loader's INNER join drops the missing channel instead of raising, so the run continues on truncated state |
| The architecture's proposed rule works | f04: live set = retained heads ∪ parent lineage ∪ referenced channel versions ∪ pending writes ∪ interrupts. The stale thread went to **0/0/0**, every row of the retained thread survived unchanged, **0** stranded, **0** broken, **0** dead writes — and the paused run still resumed to completion |
| Bracketed from below | f05: the same sweep told to retain both threads deleted **nothing** (0/0/0) and the run still resumed |
| **Bracketed from above — and over-pruning is silent** | f06: told to retain nothing, the sweep deleted the retained thread too (8 checkpoints, 22 blobs, 18 writes). The resume then returned **no error**, `completed: true`, and an **empty step list**, having executed nothing. The authored expectation that a pruned run fails to resume was **wrong**. The discriminator has to be the replayed steps — `["prepare","gate","finish"]` vs `[]` — because both runs report completion |
| Incomplete sweeps are detectable | f07: keeping only the newest version per channel — the plausible and wrong rule — stranded live references. f08: keeping only the leaves broke parent lineage. Both mutations damage the database, which is what makes f04's clean bill of health falsifiable |
| **Delete order decides whether a crashed sweep corrupts** | f09 (safe: writes → checkpoints → blobs, killed before the blob delete): **0** stranded, **14** orphan blobs, run still resumes — harmless garbage. f10 (unsafe: blobs first, killed before the checkpoint delete): **22** stranded references. Same sweep, same crash point, opposite outcome |

Two results tie the family to the rest of the spike:

- **Stranded references never raise.** f03 and f10 both left the database
  corrupted and both resumed to completion without error. This is the loader's
  INNER join, recorded in §2.4 as a source prediction, now measured twice.
- **`f06` is the third "success with nothing done" in the matrix**, after `h10`
  (renamed node) and `d09` (put racing delete). Reporting completion while doing
  nothing is this stack's characteristic failure mode, and every one of them is
  invisible to a caller that checks only for an error.

### 8.15 Family G — database and container-stack restart (Step 23)

5 cases (`g01`–`g05`). Smoke run `g-smoke3`, **one** repeat, **31/31 pass**. Not
a sealed sub-result.

Each case is two parties around one driver-performed action: party 0 pauses a
thread on a committed interrupt and photographs the cluster; the driver acts on
the database stack; party 1 — a genuinely fresh runtime container — photographs
it again and resumes using persisted state alone.

The continuity witness is **`pg_control_system().system_identifier`**, not
anything Docker reports. A container id proves a *container* was replaced; only
the system identifier proves the *data* is the same data, since it is written
once by initdb and survives every restart of that cluster. It also keeps host
paths out of evidence entirely — no mountpoint is ever read.

| Finding | Evidence |
| --- | --- |
| A graceful restart preserves everything | g01: identical system identifier with a **later** postmaster start time — same data, new server process — log delta shows `database system is shut down` x1 and **no** recovery; all 3 checkpoints / 1 interrupt / 8 blobs / 6 writes intact; the paused run resumed to `["prepare","gate","finish"]` |
| An unclean kill recovers, and the log proves it | g02: `was not properly shut down` x1 and `redo starts at` x1 in the delta. Recovery is read from the log rather than inferred from the server coming back. Same identifier, every row intact, run resumed |
| The database dying under a live backend is survivable | g03: a worker demonstrably held an open transaction on a real backend when the server was SIGKILLed; recovery ran; state committed before the death survived; the run resumed |
| **The container stack can be replaced on a preserved volume** | g04: `sameContainer: false`, image equal to the pinned `PG_IMAGE_ID`, `sameVolume: true`, **identical system identifier** `7680721714255183912`, all rows intact, and a fresh runtime container resumed from persisted state alone |
| **A stack replacement always crash-recovers** | g04's log delta shows `was not properly shut down` x1 and `redo starts at` x1 — because `docker rm -f` is a SIGKILL. Replacing a container is never a clean stop, so the recovery path is exercised on every stack replacement whether or not anyone intended it |
| **The negative control loses everything** | g05: the same replacement onto a NEW volume, re-provisioned so the schema exists and the state does not. System identifier **changed** (`7680721714255183912` -> `7680721968389238824`), state `0/0/0/0`, and the resume returned an **empty** step list |
| Volume continuity is what preserves the run | The g04/g05 differential: identical replacement procedure, and only the volume decides whether the run survives |

`completed` is useless as the resume discriminator here, for the reason f06
established: a resume against absent state also reports success. Every family G
criterion therefore turns on the **replayed steps** — `["prepare","gate","finish"]`
versus `[]`.

**This satisfies the container-stack half of the P4 restart obligation and
nothing more.** No host, WSL, kernel or Docker-daemon reboot occurred; the page
cache was never dropped; the volume never left the running daemon. The report
must say so explicitly rather than let "the whole stack was replaced" be read as
"the host can reboot".

### 8.16 Family I — the per-thread lease and the Store guard (Step 24)

8 cases (`i01`–`i08`). Smoke run `i-smoke2`, **one** repeat, **81/81 pass**
across three lanes (`stock`, `mit-lease`, `mit-storeguard`). Not a sealed
sub-result.

Two of the four approved safeguards already live beside the findings that
motivated them — `mit-migration` is a13 in family A, `mit-compat` is h13–h17 in
family H. Family I carries the remaining two.

Selecting `--family I` alone caused the driver to pull in **b02, d22, d28, d31,
d34 and d01** plus their own `requires` closure. That is the pairing rule working
mechanically rather than editorially: it is not possible to run a mitigation
without the stock case whose defect it answers landing in the same evidence set.

**Per-thread lease (`mit-lease`, paired with b02):**

| Finding | Evidence |
| --- | --- |
| Two provably concurrent workers, exactly one executor | i01: both released together (2 distinct nonces, all arrived before release). Party 0 took the lease and ran; party 1 was refused, executed **nothing**, and was classified **`awaiting_resource`** — a real state in the architecture's run machine, not a failure |
| The duplicate b02 measures is eliminated | i01: `finish` executed **1×** on **1** process, interrupt consumed once, root namespace ends with **1** leaf |
| The lease is a lease, not a coincidence | i01: the lock is taken with `pg_try_advisory_lock` on an explicitly checked-out client from a `max: 1` pool, and the holding backend is reported. §3 requires this — a lock taken through `pool.query` lands on whichever backend was free and is then returned to the pool |
| The guard is what does the work | i02 control: the identical code with the lease step skipped lets **both** workers acquire and execute. The differential is what attributes i01's single execution to the lease rather than to the fixture |
| **The stock negative is not erased** | b02 ran in the same evidence set and reproduced its finding: `finish` executed **2×** on **2** processes |
| A lease releases | i03: party 0 takes and releases without running; party 1 then acquires the freed lock and completes the run. Sequential on purpose, so acquiring second is evidence of release rather than of lucky timing |

**Store guard (`mit-storeguard`):** every rule names the case that measured the
hazard, and the guard refuses **before the Store is touched** — a guard that
refused afterwards would already have written the row it objected to.

| Case | Refuses | Because |
| --- | --- | --- |
| i04 (pairs d28) | `namespace_contains_delimiter` | `:` is both a legal label character and the delimiter, so two differently-shaped namespaces become one row |
| i05 (pairs d31) | `namespace_contains_like_metacharacter` | prefixes are matched with `LIKE`, and `listNamespaces` never calls the validator that `put`/`search` do |
| i06 (pairs d22) | `ttl_zero_means_never_expires` | `calculateExpiresAt` treats 0 as falsy, so asking for immediate expiry returns immortality |
| i07 (pairs d34) | `filter_operator_not_recognised` **and** `filter_membership_list_is_empty` | both shapes emit no SQL condition at all, so the query returns every row |
| i08 (control) | nothing | an ordinary namespace with a positive ttl passes the guard, **reaches the Store, and comes back with a written row** — the anti-vacuity check for the whole lane |

The lane-level criterion `storeguard_refuses_exactly_the_measured_unsafe_shapes`
asserts the reached/not-reached vector across all five: a guard that refused
everything would satisfy every refusal criterion above while being useless.

### 8.17 Step 25 evidence set — SUPERSEDED, retained as history

> **Superseded by §8.20.** The set described below (`final-v3`) has been deleted,
> and so have the two runs beside it. It was produced before the Step 28 audit,
> so it contains g03's false in-flight claim, f01's cross-thread sharing figure,
> f04's vacuous live-set rule, and f09/f10's misattributed damage — all corrected
> in §8.19. **Nothing here is citable.** The citable set is `frozen-v2`, digest
> `1dfdb524…`. This section is kept only to date when each measurement was first
> made and to record the reproducibility defects that finding it exposed.

Run **`final-v3`**, the whole approved matrix, three isolated repeats:

- **131 cases**, six lanes: `selftest`, `stock`, `mit-migration`, `mit-lease`,
  `mit-storeguard`, `mit-compat`.
- **574/574 acceptance criteria pass in every repeat.**
- All eight global criteria true, including **`reproducible_across_runs: true`**
  and `acceptance_stable_across_runs: true`.
- `final: true`, `subset: false` at the time. Superseded; see the banner above.
- **One overall digest:** `7305cb44fb0740b8b8aef371956c0406571a84ad366b3ad7164a0981299de28f`
- Per-lane digests:

  | Lane | Digest |
  | --- | --- |
  | `selftest` | `be5afd9438b890d9…` |
  | `stock` | `44e7a3c498588ab6…` |
  | `mit-migration` | `83993dc2a440091e…` |
  | `mit-lease` | `53bffa45a7efba4e…` |
  | `mit-storeguard` | `b3ed0a35ca90f610…` |
  | `mit-compat` | `d75335101d628284…` |

- Sanitisation scan clean on every rule (DSN passwords, `PGPASSWORD`, bearer
  tokens, JWTs, provider keys, provider hosts, host paths).

**Three independent full runs, nine isolated repeats, one digest.** `final-v1`
and `final-v2` were run before the reproducibility defects in §8.16 #17 were
fixed; their raw bundles re-scored through the corrected summarizer produce
`7305cb44…` as well. That is stronger evidence than three repeats of one run —
the bundles were collected on three separate occasions, against separately
initdb'd clusters, and agree byte for byte once the volatile fields are removed.

Both earlier sets were retained for exactly that reason at the time. All three
have since been deleted along with the pre-hardening sets — see §10.

**Re-baselining note.** Fixing the reproducibility defects changed *what* is
digested, so every digest recorded before Step 31 — `core-v4`'s, `store-v1`'s,
`final-v3`'s — is superseded. The interim re-baselined values once recorded here
have been removed rather than corrected: the sets are deleted and the summarizer
has changed again since, so nobody can recompute them and a reader would only be
tempted to quote a number that means nothing. **The one digest that matters is
`frozen-v2`'s `1dfdb524…` (§8.20).** No findings changed — only the bytes.

**Smoke-run provenance.** The single-repeat runs cited in §8.11–8.16
(`eh-smoke4`, `eh-smoke6`, `f-smoke1`, `g-smoke3`, `i-smoke2`, and family D's
`d-smoke2`–`d-smoke6`) were working measurements, not evidence, and have been
deleted from `tmp/`. Everything they measured is covered by `final-v3` at three
repeats. They are named in this document only to record when each finding was
first observed.

### 8.18 Step 26 verification — STOPPED on one unproven race (historical)

> The run described here (`verify-v1`) is deleted and its digest superseded. The
> defect it caught was repaired in Step 31 and Step 32 passes; see §8.19–8.20.

Run **`verify-v1`**, fresh build (Docker builder cache pruned first), whole
matrix, three isolated repeats. Everything below passed:

- **Reproducibility, across runs and not merely across repeats.** All three
  repeats produced `7305cb44fb0740b8b8aef371956c0406571a84ad366b3ad7164a0981299de28f`
  — byte-identical to `final-v3`, and to `final-v1` and `final-v2` when their
  bundles are re-scored. That is **twelve isolated repeats across four
  independent full runs**, every lane `distinct=1`.
- **Pins agree four ways** — installed tree, lockfile version AND integrity,
  fixture manifest version AND integrity — for all six packages.
- **Provenance**: runtime image `sha256:119496d8…`, database image
  `sha256:17a06c0a…` resolving the pinned
  `pgvector/pgvector:pg17-bookworm@sha256:cf134a76…` digest. The driver asserts
  per party that the container it started runs exactly `IMAGE_ID`.
- **Worker posture measured, not assumed**: read-only rootfs, user `node`, all
  capabilities dropped, zero published ports, zero bind mounts.
- **No egress**: TCP `ENETUNREACH`, DNS `ESERVFAIL` from inside a worker.
- **Sanitisation**: all twelve scan rules zero, and an independent grep of the
  promoted `evidence.json` finds no host path, `/var/lib/docker`, `PGPASSWORD`,
  DSN, provider key or bearer token.
- **30 differential and control criteria true**, each naming the case it
  localises — `e02_control_isolates_the_subgraph_as_the_cause`,
  `g05_volume_continuity_is_what_preserves_the_run`,
  `h03_the_key_discriminates_a_crash_resume_from_a_fork`, and so on. 24 controls
  and 2 mutations across 131 cases.

**One check failed, and it stops the step:**
`acceptance_stable_across_runs: false`. Repeats 2 and 3 were 574/574; repeat 1
had a single failure —
`stock.b09_reader_sampled_while_the_writer_was_committing`.

That criterion is b09's **anti-vacuity witness**. b09 claims that a reader never
observes a torn checkpoint, and the claim is only meaningful if the reader
actually sampled *while* the writer was committing. The witness is "the reader
saw at least two distinct checkpoint counts":

| Repeat | samples | distinct counts | observed |
| --- | --- | --- | --- |
| 1 | **1** | **1** | `[5]` |
| 2 | 10 | 3 | `[3,4,5]` |
| 3 | 64 | 6 | `[0,1,2,3,4,5]` |

In repeat 1 the writer completed all five checkpoints before the reader issued
its first query, so the reader sampled a settled database and b09's main criteria
were vacuous for that repeat.

This is the defect class already recorded twice — a criterion decided by the
interleaving rather than by the behaviour (§8.18 #2 and #4) — except that here it
is the *guard against* vacuity that is racy, which is worse: it fails safe, but
it fails. Both parties are released from one barrier and then simply run, so
nothing forces the reader's first sample to precede the writer's last commit.

The fix is a second rendezvous — the reader takes one sample and only then
releases the writer — which makes "the reader saw the database before and after"
structural instead of lucky. It is a harness change, so it belongs to the audit
and hardening block (Steps 28–31) rather than to this Verify.

### 8.19 Step 28 audit and Step 31 hardening

The Step 26 stop triggered an independent audit (Step 28), whose corrections were
approved at Step 29 and applied at Step 31. Two claims were **false as written**
and one approved-scope obligation had **never been exercised**.

**Claims corrected, not merely reworded:**

| Claim | What was wrong | Repair |
| --- | --- | --- |
| g03 "the database dying under a live worker is survivable" | The driver acted only AFTER party 0 exited, and the participant rolled back and released its client before returning. No backend was live at the kill; `heldBackend` meant "a pid was once read". g03 was g02 with a prior transaction, and the client-visible failure was never measured | New driver trigger `restart.atGate` fires while a party is still parked. A dedicated session holds the checkpoint table, a real `put()` blocks on it, and only once `pg_stat_activity` reports a waiting **subject** backend is the park recorded and the server SIGKILLed |
| f01 "one blob row referenced by six live checkpoints" | `sharing` grouped by `(ns, channel, version)` without `thread_id`, summing two independent threads running the same graph. `checkpoint_blobs` is thread-keyed, so cross-thread sharing is impossible | `thread_id` added to the grouping. Measured per-thread maximum is **3**, not 6 |
| f09/f10 "delete order decides whether a crashed sweep corrupts" | Every stranded reference belonged to the STALE thread the sweep was halfway through deleting — condemned rows, not corruption of anything retained. Whole-thread retention makes it structurally impossible for either order to touch a retained thread | Damage witnesses partitioned retained-vs-stale. f10 now pairs the unsafe order with an incomplete rule, which puts **3 stranded references in the retained thread** while f09 leaves **0** |
| f04 "the architecture's live-set rule works" | The sweep retained every row of a retained thread, so "retained heads ∪ parent lineage" was vacuous — no head was chosen and no lineage walked | New `f11` walks the live set from an explicit head with a recursive CTE, against a thread carrying an abandoned fork branch. It deleted **6 checkpoints from inside a retained thread**, which whole-thread retention cannot do |

**Oracles that could not have failed:**

- **`s07`** is the first case in the matrix to deliver `SIGTERM`. Eleven kill
  cases prove their SIGKILL was uncatchable by asserting **no** `process/sigterm`
  row exists — but every one sent SIGKILL, so the handler had never fired
  anywhere and the witness was empty in all 131 cases. Requiring exactly one row
  under a catchable signal is what makes those eleven absences load-bearing.
- **`c10`** writes blobs first, in the vendor's order. `c05` writes the checkpoint
  row first and leaves a *stranded reference*, but a torn `put()` cannot:
  `_dumpBlobs` runs before the checkpoint upsert, so partial vendor state is
  *orphan blobs*. c05 validated a detector for damage the vendor path does not
  produce.
- **`f12`/`f13`** mutate the pending-writes and interrupt terms of the live set,
  neither of which had ever been mutated.
- Three findings were recorded in prose but asserted by nothing: `c09`'s broken
  parent link, `d17`'s two callers told a committed write failed, and `d39`'s
  exactly-reversed inner-product order were all presence checks
  (`Array.isArray`, `typeof === "boolean"`). All three now assert the value.
- `d45` scored the batch path against the convenience path — two outputs of one
  implementation agreeing. It now scores against the authored fixture.
- `h04`'s async lane required `processes === 2`, hard-asserting one side of its
  own race; it now classifies.

**Bounded-trial contract, made honest.** `trials` was declared and never read: no
loop exists, so a race is sampled **once per isolated repeat, three times per
citable set**. The registry now rejects any value but `1`, and the report must
say `n = 3` rather than imply a trial count independent of repeats. Outcomes that
remain **source-possible but unsampled** are recorded rather than treated as
impossible: d08's item/vector owner split, e08 both workers consuming a child
interrupt, h04's effect-key mismatch, d26's partial sweeper split, b05's party 1
winning blob ownership.

**Two of those were sampled at Step 37 and are no longer unsampled.** `frozen-v3`
repeat 2 shows e08 with **two leaves in the CHILD namespace** as well as the
root, so "both workers consumed the child interrupt" is measured; repeat 3 shows
no duplication at all. e08's outcome set is `{none, root-only fork, root and
child fork}` — three distinct outcomes in three repeats. And `a07` sampled
`42710`. Both were invisible until the Step 43 observation repair, because the
first `observed` reduction summed leaves to a scalar and dropped SQLSTATE
constraints.

### 8.20 Step 32 — the final experimental result

Run **`frozen-v2`**, the hardened matrix, three isolated repeats:

- **136 cases**, six lanes; **598/598 acceptance criteria pass in every repeat.**
- All **nine** global criteria true, including `reproducible_across_runs` and
  `acceptance_stable_across_runs` — the check that stopped Step 26.
- `final: true`, `subset: false`.
- **One overall digest:** `1dfdb524813563119c3843941eb87545f505d9316801a4637d6f900ee36ce465`
- Sanitisation scan clean on every rule.

**Reproducibility is established across runs, not merely across repeats.**
`frozen-v1` and `frozen-verify` — two earlier independent full runs, the second
from a pruned builder cache — re-score to the identical digest. That is **nine
isolated repeats across three independent full runs**, against separately
initdb'd clusters, agreeing byte for byte.

Static and provenance checks: typecheck, shell syntax and registry validation
clean; pins agree four ways for all six packages; database image resolves the
pinned `pgvector/pgvector:pg17-bookworm@sha256:cf134a76…` digest and the driver
asserts per party that each container ran exactly `IMAGE_ID`; worker posture
measured (read-only, `node`, all capabilities dropped, zero published ports, zero
binds); no egress.

Structural counts: **107 candidates, 25 controls, 4 mutations**; 17
`bounded-trials` cases, every one declaring `trials: 1`; 13 mitigation cases,
every one with a stock pair. Lane separation holds — the only `h1x`/`i0x`
criteria in `stock` are the stock changed-graph variants and the unguarded lease
control, which is where they belong.

Stability of the repaired findings across all three repeats:

| Finding | r1 | r2 | r3 |
| --- | --- | --- | --- |
| g03 blocked backend at the kill | 1 | 1 | 1 |
| g03 call settled and rejected loudly | yes | yes | yes |
| f09 stranded refs in the RETAINED thread | 0 | 0 | 0 |
| f10 stranded refs in the RETAINED thread | 3 | 3 | 3 |
| b09 observed chain lengths | `[0..5]` | `[0..5]` | `[0,5]` |

b09's row is worth reading precisely: the reader observed every intermediate
state in two repeats and only the endpoints in the third. The window is
structural at both ends — `0` and `5` are guaranteed by the rendezvous and the
`writer/done` stop — but catching a mid-chain state is not, which is why the
criterion is named `sampled_across_the_commit_sequence` and not "while the writer
was committing".

**`frozen-v2` was promoted as the final set and is now INTERIM.** Step 34
audited it against the approved Step 29 contract rather than against the case
registry, and found the contract incomplete — see §8.21. Its individual measured
claims stand except where §8.21 narrows them; it is not the final evidence.

### 8.21 Step 34 audit — the evidence contract reopened

Step 32 verified that every REGISTERED criterion passed. It could not verify that
the registry contained everything Step 29 approved, and it did not: passing 598
criteria says nothing about a criterion that was never written. Seven findings,
all result-changing or claim-narrowing. The user approved reopening at Step 35.

**Criteria that did not isolate what their case existed to show.**

| Case | What the criterion actually asserted | Repair |
| --- | --- | --- |
| f11 | `deleted.checkpoints > 0` — satisfied by the five STALE-thread deletions alone. Measured intra-thread signal is **one** checkpoint (retained 4 → 3), and the case would have passed unchanged had head-scoped retention pruned nothing inside the retained thread | Per-thread delta asserted separately from the stale removal; resume now requires a non-empty step list |
| f12 | Two criteria stating one fact. The purpose claimed "the paused run loses the writes its resume depends on" — the resume is **byte-identical to the correct sweep's**, `["prepare","gate","finish"]`, in all three repeats | Narrowed to the row loss and the silence around it; f17/f18 added to measure a consequence |
| f13 | `f13_the_paused_run_lost_its_decision_point` read `before.writes > after.writes` and was named for a behaviour the same result set contradicts | Renamed to what was measured: exactly the interrupt rows go, the approval stops being discoverable, and a caller already holding a command still resumes |

**An obligation that was never exercised at all.** Head-scoped retention was
measured only against single-namespace threads. `liveHead` filtered
`checkpoint_ns === ''`, and `liveCheckpointsSql` recurses on
`parent_checkpoint_id` WITHIN a namespace — and e01 measured that a subgraph's
chain is **separately rooted**. So a root head reaches none of a subgraph's rows,
and every one of them becomes a deletion candidate, including the
`__interrupt__` row that IS the outstanding approval. No family F case used a
subgraph, so nothing could see this. f15 seeds one head per live namespace; f16
runs the old root-only behaviour as a declared mutation and must destroy the
child namespace while leaving the root intact.

The architecture's retention table also keeps **completed** runs, and every F
case retained a paused thread — so "the retained run still resumes" was the only
survival claim available, and a completed run cannot be resumed. f14 retains a
completed thread and asserts readability instead, from the negated INNER join the
loader performs, corroborated by a state read that must execute no node.

**A guard rule attributed to a case it cannot answer.** `guards.ts` claimed
`namespace_contains_like_metacharacter` covered "d29/d31". d29 uses `["alpha"]`,
`["alphabet"]`, `["alpha","one"]` — ordinary labels, no metacharacter. Nothing
about that request is refusable; the defect is that the vendor renders it as
`LIKE 'alpha%'` and returns a sibling. It needs an **output-side** rule, and now
has one: element-wise label-array comparison, which never touches the delimiter.
d30 was unaddressed entirely. And the guard's allow-path was proven for `put`
only — `listNamespaces` and `search` were never reached on the allow side, so
"refuses only its stated target" was unmeasured for two of the three shapes it
screens. i09–i12 close all three.

**Evidence that pointed at a section it did not contain.** `managed` replaces a
bounded case's results with the literal string `"<race outcome: see findings>"`,
and `findings` was never copied into the promoted `evidence.json`. Every race
outcome this spike measured — 17 cases — was absent from the file the report
cites, surviving only in per-repeat `run.json`. An `observed` block is now
assembled from all repeats, reduced to id-free scalars, digest-excluded by
construction, with two globals requiring it to be complete and its pointers to
resolve.

**Facts measured and never asserted.** g05's raw evidence shows
`sameContainer: false` and the pinned image, but its acceptance map asserted only
volume discontinuity — "the identical replacement procedure" was prose. And
`g05_the_run_did_not_come_back` was misnamed: the resume **succeeded** against
nothing (`error: null`, `completed: true`, empty step list, a fresh checkpoint
written). Renamed, with the silence asserted separately.

**The canonicaliser was never self-tested.** Every managed digest is computed
over tokenised output and nothing checked that the tokenisation is injective or
that no raw uuid escaped. A ranker collision would silently merge rows a
regression had made different; an escaped id would make an honest run
irreproducible with no explanation. The leak scanner checks credentials and host
paths, never volatile ids. s08 asserts injectivity, disjoint token namespaces, no
surviving uuid — and declares the one deliberate many-to-one mapping,
`nsSkeleton`'s uuid collapse, so an intended collapse can never read as a
collision.

**A correction the new cases produced immediately.** f14 was authored asserting
that head-scoped retention of a completed thread leaves ZERO `__interrupt__`
rows. One survives, and must: the completed run's own interrupt write is attached
to a checkpoint the live head descends from, so a correct sweep keeps it.
**Consuming an interrupt does not delete its row.**

That makes `__interrupt__` a historical record rather than a pending-approval
queue, and it compounds e04: a runtime counting those rows to find outstanding
approvals over-counts once for every nested interrupt (recorded at both levels)
and once for every interrupt already answered. Approval state has to be the
runtime's own, keyed on `(thread, raising namespace, task)`, and reconciled
against the tables rather than derived from them.

**Claims that must not be made from `frozen-v2`.** Head-scoped retention is
unproven for any multi-namespace thread; f12/f13 show row loss, not a resume
consequence; f11 does not show intra-thread pruning; the Store guard does not
address d29 or d30; and `evidence.json` carries no bounded-trial outcome data, so
any race figure quoted from it is really quoted from a per-repeat file.

### 8.23 Step 37 — the reopened evidence set

Run **`frozen-v3`**, the corrected matrix, three isolated repeats:

- **146 cases** (was 136), six lanes; **657/657 acceptance criteria pass in every
  repeat** (was 598).
- All **eleven** global criteria true — the nine from §8.20 plus
  `every_bounded_case_has_a_persisted_outcome_set` and
  `no_managed_field_points_at_absent_findings`.
- **One overall digest:** `4f947c3d0fd4e59e4ac5321d26a8fd8f33c40a28f3a7cb3c2d4f22beca7160bf`
- `final: true`. Sanitisation scan clean on every rule.
- **The `observed` block exists**: all 17 bounded-trial cases, three samples
  each, digest-excluded. It captures real variation the promoted file previously
  did not carry at all — `e08` three distinct outcomes, `a02`, `a07`, `b02` and
  `i02` two apiece.

Ten cases added: `s08`, `f14`–`f18`, `i09`–`i12`.

**What the new cases measured.**

| Case | Result |
| --- | --- |
| `f14` | Head-scoped retention of a **completed** thread pruned its abandoned branch (6 → 5 checkpoints), and the terminal state stayed readable: 6 referenced channels, **0** unresolved, a state read returning `["prepare","gate","finish"]` with **0** node executions |
| `f15` | A thread paused **inside a subgraph**, seeded with one head per live namespace: 2 namespaces, 2 heads, and **every namespace byte-identical before and after** — root `3/8/6/1` and child `3/8/6/1` — with the child's approval intact and the run resuming |
| `f16` | The same fixture seeded from the **root only**: the child namespace deleted entirely (`3/8/6/1` → `0/0/0/0`) including its `__interrupt__` row, the root untouched, and the resume returning **`interrupted: true, completed: false, steps: ["prepare"]`** — the old approval consumed by nothing and a **fresh** one now outstanding |
| `f17`/`f18` | The pending-writes term measured by consequence: with the write deleted the surviving sibling **re-executed**; with the live set complete it was **reused**. This is the claim f12 could not support |
| `i09` | The vendor returned the sibling `alphabet` for prefix `["alpha"]`, reproducing d29 inside the mitigation lane; the guard dropped exactly **1** non-descendant and kept both true descendants |
| `i10`/`i11` | `maxDepth` + `limit` refused before the Store was touched; the same `maxDepth` **without** paging allowed and returning a result |
| `i12` | A recognised filter allowed, reaching the Store and returning a **proper non-empty subset** (1 of 3) |
| `s08` | Checkpoint labels and rankers injective, token namespaces disjoint, **no raw uuid survives canonicalisation**, and `nsSkeleton`'s collapse declared |

**`frozen-v3` supersedes `frozen-v2`.** The earlier set remains on disk as audit
history for the Step 34 comparison; its digest is not citable.

### 8.24 Step 38 — verification of the reopened result

Run **`frozen-v3-verify`**, fresh build with the Docker builder cache pruned
first, whole matrix, three isolated repeats:

- **146 cases, 657/657 in every repeat**, all eleven global criteria true,
  `final: true`.
- **Digest `4f947c3d0fd4e59e4ac5321d26a8fd8f33c40a28f3a7cb3c2d4f22beca7160bf` —
  byte-identical to `frozen-v3`.** Six isolated repeats across two independent
  full runs, against separately initdb'd clusters.
- Sanitisation scan clean on every rule; no host path, DSN, credential or bearer
  token in the promoted bytes.

Checks beyond the acceptance map:

| Check | Result |
| --- | --- |
| Pins agree four ways (installed tree, lockfile version + integrity, fixture manifest version + integrity) | true, all six packages |
| Database image resolves the pinned digest | `pgvector/pgvector:pg17-bookworm@sha256:cf134a76…` |
| Worker posture, read back from `docker inspect` | read-only rootfs, user `node`, all capabilities dropped, 0 published ports, 0 binds |
| Egress from inside a worker | TCP `ENETUNREACH`, DNS `ESERVFAIL` |
| Structural counts | 112 candidates, 28 controls, **6 mutations**; 17 bounded cases all declaring `trials: 1`; 17 mitigation cases all paired |
| Lane separation | `selftest` 32, `stock` 546, `mit-migration` 7, `mit-lease` 13, `mit-storeguard` 29, `mit-compat` 25 — zero false in each |
| Bounded outcomes | 17 cases, every one contributing exactly 3 samples summing to 3 occurrences |

**`frozen-v3` is the citable evidence set for the report.**

### 8.25 Step 43 — the observation repair and the documentation

**The `observed` block was repaired before any report cited it.** Step 40's audit
found that the Step 37 version answered only three of the eight fields
`managedProjection` elides, so six of seventeen bounded cases read as "no
variation observed" while their raw bundles showed them flipping — d09 most
sharply, whose terminal database differed between repeats (0, 0, 1 items).

Three changes:

1. **The reduction moved into the pinned image** (`observationFor` in
   `summarize.ts`). It had been authored host-side in the driver's jq, which made
   it the one analysis in the run whose code was not version-locked to the
   evidence it described — and `verify-concurrency.sh`'s own header says the
   driver owns persistence and no analysis. The driver now only groups
   observations across repeats and counts occurrences.
2. **The observation covers every elided field**, derived from a single
   `RACED_FIELDS` list rather than a per-case declaration that could drift:
   nested failures with constraints, SQLSTATE multiset, sorted executions,
   lineage with **per-namespace** leaf counts, reachability counts, ownership
   with its agreement relations, terminal Store state, per-party work counters,
   and effect-key equality classes.
3. **The dangling-pointer global now checks FIELD granularity.** It compared case
   ids before, which is one level too coarse to catch the defect it was written
   for.

Effect, re-scored over `frozen-v3`'s own bundles:

| Case | Old distinct outcomes | Repaired |
| --- | --- | --- |
| a03 | 1 | **3** |
| a02, a07 | 2 | **3** |
| a08, b05, b06, b07, b08, d08, d09, d26 | 1 | **2** |
| e08 | 3 | 3, now with per-namespace attribution |

`a09`'s signature had been literally empty; it now carries eight operations, one
fulfilled, and seven rejections across four distinct constraints. `b06` shows the
invariant and the variation together: `rowOwnerEqualsByteOwner: false` in all
three repeats, with the winner alternating.

**Owners are reported by role, literally, not canonically relabelled.** §7.2
establishes that roles are assigned by the driver before the race, so `p0`/`p1`
are managed labels rather than volatile ids — "the same role did not always win"
is itself an observation, and relabelling it away would hide it. The relations
that carry the finding (`rowOwnerEqualsByteOwner`,
`itemOwnerEqualsVectorOwner`) are emitted explicitly beside the owners.

**Two stale claims corrected** (§2.2, §8.19): `42710` HAS been observed, in a07;
and e08's child-namespace fork is no longer "source-possible but unsampled" — it
was sampled in `frozen-v3` repeat 2.

**Documentation written.** The Spike 06 report, plus reconciliation of
`architecture/{README,02,04,06,09,10}.md`, `spike-reports/README.md` and the
harness README. All relative links resolve; no stale "still open" / "not started"
/ "assumed, not measured" / "no spike has yet resumed" claims remain outside the
two intentional ones (the README's boilerplate about open decisions, and the
deliberate host-reboot boundary).

### 8.26 Step 43 — the citable set, and three report claims it corrected

**`frozen-v5` is the citable final evidence set.** 146 cases, three isolated
repeats, **657/657 in every repeat**, all eleven globals true, `final: true`,
scan clean on all twelve rules, 17 bounded cases each contributing exactly three
samples. One distinct overall digest,
`4f947c3d0fd4e59e4ac5321d26a8fd8f33c40a28f3a7cb3c2d4f22beca7160bf` — **identical
to `frozen-v3` and `frozen-v3-verify`**, which is the check that defect 24's fix
altered process liveness and nothing measured. Nine isolated repeats across three
independent full runs now agree on that digest.

**Three report claims were written against `frozen-v3`'s samples and did not hold
for the citable run.** All three were bounded-race outcome sets, which is exactly
where a report is most likely to overstate, because the citable run samples a
subset of what the harness has ever seen:

| Claim as drafted | What `frozen-v5` sampled | Correction |
| --- | --- | --- |
| Store setup SQLSTATEs are `{23505, 42710, XX000, none}` | `{23505, none}` in all three repeats | Set now attributed to the accumulated observation across runs, with the citable run's own sample stated first |
| `b02` duplication is bounded `{1, 2}` "over the citable set" | duplication in **all three** repeats — the set is `{2}` here | `{1, 2}` is now named as the accumulated set; the citable run sampled only duplication |
| `e08` sampled three outcomes: none, root-only fork, child fork | **two** outcomes, both duplicating: `[1,2]` ×2 and `[2,2]` ×1 | Restated as "duplicated in all three; both namespaces forked in one" |

The pattern is worth keeping: **an outcome set accumulated across runs must never
be presented as what the cited run produced.** The first version of each sentence
did precisely that, and only re-scoring every bounded case against the promoted
`observed` block caught it. The finding is unchanged in each case — the hazard is
real and the safeguard still eliminates it — but the frequency was overstated.

Claims re-verified against `frozen-v5` and found accurate as written: `b06`'s
`rowOwnerEqualsByteOwner: false` in all three with the winner alternating
(`p1`,`p1`,`p0`); `d09`'s put-versus-delete losing an acknowledged write in one
repeat with **both** callers reporting success; `a09`'s single fulfilled `put`
against four distinct rejection constraints.

### 8.27 Step 44 — verification of the final spike and documentation

Run **`frozen-v5-verify`**, fresh build with the Docker builder cache pruned
first (**0 `CACHED` layers** in `build.log`), whole matrix, three isolated
repeats:

- **146 cases, 657/657 in every repeat**, all eleven globals true, `final: true`.
- **Digest `4f947c3d0fd4e59e4ac5321d26a8fd8f33c40a28f3a7cb3c2d4f22beca7160bf`.**
  Overall digest, **every per-lane digest**, and the **entire acceptance map** are
  equal to `frozen-v5`'s. Twelve isolated repeats across four independent full
  runs now agree.
- Sanitisation scan clean on all twelve rules.

| Check | Result |
| --- | --- |
| Structure | 112 candidates, 28 controls, 6 mutations; 17 bounded all declaring `trials: 1`; 17 mitigation cases all paired |
| Lane separation | `selftest` 32, `stock` 546, `mit-migration` 7, `mit-lease` 13, `mit-storeguard` 29, `mit-compat` 25 — zero false in each |
| Criterion arithmetic | 652 lane criteria + 5 in-image globals = 657 `flat`; the other 6 globals are driver-computed cross-repeat facts and are named as such |
| Bounded outcomes | 17 observed cases, present in promoted evidence, **88 raced fields** elided from `managed` |
| Worker posture | uniform across every worker and repeat: read-only rootfs, user `node`, `capDrop: ALL`, 0 published ports, 0 binds |
| Egress | TCP `ENETUNREACH`, DNS `ESERVFAIL` |
| h02 specifically | passed 3/3 here and 3/3 in `frozen-v5` — six consecutive passes since defect 24 |

Documentation checks, all passing:

- Relative links across `architecture/**` and the harness README all resolve.
- `tmp/` confirmed git-ignored via `git check-ignore`.
- No credential, DSN, bearer token, private key, host path or WSL path in any
  Spike 06 document. (The `bearer` hits elsewhere in `architecture/` are design
  prose in unrelated documents, not secrets.)
- Both status tables — `10-delivery-phases.md:37` and `spike-reports/README.md:22`
  — read **"Pass, with required safeguards"**, matching the report's first line.
- Stock and mitigation findings are visibly separated; every safeguard claim
  names its case and its stock pair.
- Source-read claims carry `(source)` and the closing paragraph states that
  source-derived behaviour is a prediction paired with a measurement.
- Container-stack replacement is never called host-reboot proof; the boundary is
  stated in Architecture impact **and** Limitations.
- Store semantic quality is explicitly out of scope.

### 8.22 Harness defects found by execution (Steps 8–37)

1. `declared_gates_were_reached` passed vacuously (snapshot vs live set).
2. Two family-A criteria encoded the **source prediction** that every racer
   reaches a ledger insert. A racer that loses the `CREATE TABLE` race never gets
   there, so the criteria were themselves decided by the interleaving — `a04`'s
   discriminator flapped in repeat 2. Both now key on **migration DDL**, which is
   a witness of what the racer read rather than a prediction of what it would do.
3. **Acceptance laundering.** The final acceptance map was taken from repeat 1,
   so a criterion that failed in repeat 2 was hidden by repeat 1 passing, and the
   global cross-repeat criteria were never counted at all — a run reported
   success with `reproducible_across_runs: false`. Now an elementwise AND across
   all repeats, with global criteria included in the tally.
4. **A criterion comparing against a raced value.** `b03`'s discriminator
   required the parallel and sequential execution counts to differ — but the
   parallel count is itself a race outcome (2, 2, 1 across repeats), so the
   criterion failed for the interleaving rather than for the behaviour. Same
   class as defect 2. The control now asserts its **own** deterministic property
   ("sequential resume executes the final node exactly once"), and the
   comparison against the parallel lane is reported as a finding.
5. **A gate that could never fire.** `c05` gated a `pool.query()` call, but
   pg-pool always dispatches that internally as
   `client.query(text, values, callback)`, and the gate deliberately delegates
   callback-form queries untouched. No gate can bind to `pool.query()`. Every
   vendor write path takes a client explicitly, which is why this only affected
   harness code; the control now does the same, which also makes it properly
   comparable to the `put()` it controls for.
6. **A fixture that manufactured the corruption it was testing for.**
   `checkpointFor()` hardcoded `channel_versions` to `"1"` while callers passed a
   different `newVersions` to `put()`. Those are separate vendor arguments — what
   the checkpoint *claims* to reference versus what is *written* — so the
   mismatch fabricated a stranded reference plus an orphan blob, indistinguishable
   from the real defect. It contaminated `c09`'s first result. Version is now
   threaded through both.
7. **Volatile identifiers in the digest.** Checkpoint ids are UUIDv6
   (time-ordered) and task ids are UUIDv5 values derived from them, so both
   change every run; the reader's sample count and which intermediate states it
   caught are scheduling artifacts; and *which* writer won a conflict is the race
   outcome itself. All are now canonicalised or moved to `findings`:
   `canonicalCheckpointLabels()` relabels ids from the **lineage shape** (a
   recursive id-free signature, siblings walked in signature order), and the
   conflict witness is digested as structure only — `distinctRowOwners`,
   `unattributableRows`, `rowOwnerEqualsByteOwner` — with the actual winner
   retained verbatim. For `bounded-trials` cases the `thread`, `executions` and
   `reachability` projections are excluded from the digest too, because a fork is
   a genuine race outcome; the terminal *schema* stays managed because it
   converges regardless of who won.
8. **A scoped run crashed the summarizer.** Every criteria block runs whenever
   its lane is present, but a `--family D` run legitimately contains no family-C
   case. `survivingRows()` reached into `bundle.workers` on a case that never
   ran, threw a `TypeError`, and the driver reported it as
   `HARNESS FAULT: summarize reported a harness fault` — a run-selection bug
   wearing the costume of a measurement failure. Fixed at the root:
   `resultsOf`/`liveResults`/`firstResult`/`sqlstatesOf` accept an absent bundle
   and return empty, so an absent case contributes **no** criteria rather than a
   false one. The `{} as CaseBundle` idiom that hid it is gone. Re-summarizing
   the sealed `core-v4` bundles through the fixed code reproduces all three
   per-repeat digests **byte-identically** with zero criteria drift.
9. **A gate attached after the pool had already connected.** `ttlRefreshOnRead`
   called `store.start()` and only then `instrumentPool`. The gate patches on the
   pool's `connect` event, so a client that already exists is never patched, and
   pg reuses idle clients — the refresh `UPDATE` ran on an unpatched connection
   and was never recorded. d23's criterion caught it as a failure; the real
   damage was next door, where **d24's "no update was issued" was passing
   vacuously** for the same reason. Instrumentation now precedes every vendor
   call in that function, matching what family A already did. Same class as
   defect 1: an oracle that was not attached reads exactly like an oracle that
   found nothing.
10. **A worker that measured a hang could not report it.** d18 deadlocks a pool
    of one deliberately, so the pg socket never closes and `pool.end()` can never
    resolve. The worker emitted its JSON and then sat there until the driver's
    per-case timeout fired, turning a **measured** hang into
    `HARNESS FAULT: party 0 never terminated`. The worker contract is now
    enforced rather than assumed: `main()` flushes stdout and calls
    `process.exit()`, so a deliberately leaked handle can never convert a result
    into a fault. The flush is explicit because stdout is a pipe here and
    `process.exit()` would otherwise truncate the evidence.
11. **A method lifted off its object, reported as a measured failure.** The
    shared subgraph invoke path did `const invoke = graph.invoke` before calling
    it, which detaches the receiver — and `Pregel.invoke` reads
    `this.outputChannels` on its first line. Every family E run therefore failed
    with `TypeError: Cannot read properties of undefined`, which
    `invokeNested` dutifully caught and returned as a graph-level error. The
    worker exited 0, the driver printed `ok`, and the failure was indistinguishable
    from a fixture that legitimately threw. Only `e05` surfaced it, because a case
    whose kill is anchored on a park row cannot silently not-park: the driver
    stopped with `party 0 never parked`. The object is now cast instead of the
    method. The general lesson is the one defect 1 and defect 9 already taught in
    a different costume — an oracle that never ran looks exactly like an oracle
    that found nothing — with the addition that a **kill anchor is also a
    liveness check**, and the only reason this did not reach a sealed result.
12. **A comparison broken by PostgreSQL's own JSONB key ordering.** The changed-
    graph participant compared the stored manifest against the freshly computed
    one with `JSON.stringify`. The stored copy comes back out of a `jsonb`
    column, and jsonb reorders object keys **by length, then bytewise** — the
    exact behaviour d10 measured in slice 1 of family D — so two identical
    fingerprint maps stringified to different strings and every variant, including
    the identical control, reported `fingerprintsDiffer: true`. The array-valued
    half was never affected, because jsonb preserves array order, which is
    precisely why the bug hid: the structural comparison beside it was correct.
    Now compared with `stable()`, which sorts keys before serialising. Notably
    `compareManifests` itself was always right — it compares per key rather than
    per serialisation — so the guard's verdicts were correct throughout and only
    the two explanatory flags were wrong. A measured fact about the database, from
    one family, invalidating a comparison in another.
13. **A stale variable pointed the reprovision at a database that no longer
    existed.** The fresh-volume control recreates the server on an empty volume
    and then re-provisions, so the schema exists and the state does not. But
    `CASE_DB` still named the per-case database, which the fresh volume had just
    destroyed, so the provisioning container could not connect and the run died
    as a harness fault. It now falls back to the admin database for that one
    call. Trivial in itself, and worth recording because it is the first bug this
    harness produced in the DRIVER rather than in a participant or a criterion —
    a new class, introduced the moment the driver gained the power to change the
    database under a case.
14. **A log oracle reading the wrong window.** Family G proves crash recovery
    from PostgreSQL's own log, read as the delta either side of one action,
    because the container is per family and its log accumulates across every case
    that restarts it. That is correct for a restart and wrong for a REPLACEMENT:
    `docker rm -f` destroys the old container's log, so the new container starts
    at line zero and an offset taken from the old one skips past the whole
    startup — including every recovery line. g04 dutifully reported
    `newLines: 0` from a log that had plenty. The baseline is now zero for the
    two actions that replace the container. Same class as defects 1 and 9: an
    oracle pointed somewhere useless reads exactly like an oracle that found
    nothing. The marker phrase for a clean stop was wrong in the same round —
    PostgreSQL logs `database system is shut down`, not `shutdown complete` — and
    that one failed loudly on g01 rather than passing vacuously, because the
    criterion demanded a positive count rather than an absence.
15. **The projector keyed off the family where the case had overridden it.**
    Family I is declared `provision: "bare"` and each case overrides upward —
    the lease cases need a migrated checkpointer, the Store guard cases a
    migrated Store. `cmdProject` decided whether to project a thread from
    `family.provision` alone, so the lease cases projected nothing and three
    declared oracles reported producing nothing. Fixed as a UNION of the family's
    and the case's provisioning, deliberately not "the case wins": several family
    D cases override DOWN to `bare` because starting with no store tables is
    their subject, and letting the override win there would have changed what
    those already-sealed projections contain. The regression guard confirms both
    sealed digests still reproduce.
16. **A positional argument read as an options object.** The Store guard's
    allow-path called `store.put(ns, key, value, { index: false, ttl })`, but the
    signature is `put(namespace, key, value, index?, options?)` — the index is
    the fourth POSITIONAL argument and options the fifth. The object was
    therefore read as the index field list and failed with `TypeError: fields is
    not iterable`. Caught because i08 exists at all: it is the control that
    requires the allow-path to reach the Store and come back, so a guard whose
    allow-path was broken could not pass it. The four refusal cases never touch
    the Store and would all have stayed green.
17. **Four separate sources of digest volatility, all found by the first full
    run and none by any smoke run.** `final-v1` produced **574/574 acceptance
    criteria passing in every one of three repeats**, with
    `acceptance_stable_across_runs: true` — and three *different* overall
    digests. Only the `stock` lane drifted; `selftest`, `mit-migration`,
    `mit-lease`, `mit-storeguard` and `mit-compat` were identical across
    repeats. Ten cases differed, from four causes:

    - **Family G digested the cluster's identity.** `system_identifier` is minted
      by initdb and every repeat initdbs a fresh volume, so it changes by
      construction; `postmaster_start_time` is the wall clock. Both are now in
      `VOLATILE_RESULT_KEYS`. What family G actually asserts is the RELATION
      between two photographs — same identifier or not, later start time or not —
      and every one of those is already computed as a boolean in the criteria.
    - **A `bounded-trials` case's conflict witness was still managed.** It had
      been left in on the assumption that its reduced form is invariant, which is
      true for b06 — the row is `DO UPDATE` and the bytes are `DO NOTHING`, so a
      collision always splits them — but false for b04, where both writers send
      the SAME payload and which one owns the surviving metadata is decided by
      arrival order alone. Three repeats of `core-v4` never sampled the other
      outcome; the full matrix did on its first attempt. `conflictWitness` now
      joins `thread`/`executions`/`reachability`/`store`/`storeConflict` in the
      raced-out set.
    - **Parallel siblings were labelled by finishing order.** `fan_a` was
      `<task:3>` in one repeat and `<task:4>` in the next, with no behavioural
      difference at all — LangGraph guarantees no ordering between branches of a
      superstep, which `canonical.ts` already said in its own comments about a
      different function.

      This one took **three attempts**, and the intermediate states are worth
      recording because each looked sufficient:

      1. Sort the write array by content and re-derive effect task labels from
        `(node, ordinal, party)`. Fixed `h05` and `e07`; `e03` still drifted.
      2. Add the namespace skeleton and byte count to the ranking key. `e03`
        still drifted, because the two root-level tasks that *spawn* the parallel
        subgraphs both write under the ROOT namespace — their own rows are
        identical in every field, and the thing that tells them apart lives in
        OTHER rows, namely the namespace `left:<id>` versus `right:<id>`.
      3. What shipped: **subgraph namespaces canonicalise to their skeleton**,
        with embedded ids blanked to a constant `<id>` rather than replaced by
        task labels — so no namespace string depends on the ranking at all. The
        task ranking additionally gained a role tiebreak, recovering a task's
        call site from any namespace that embeds its id.

      The skeleton keeps everything that is a result — which call site a
      namespace belongs to, how deeply it nests, whether two namespaces share an
      ancestor — and gives up one thing: the namespace no longer names *which*
      task it belongs to. That linkage survives in the effect records, which
      carry `task` as its own field.
    - **A control was classified as deterministic when it IS the race.**
      `i02-thread-lease-disabled-control` runs b02's two workers with the lease
      switched off; its whole purpose is to let the duplicate happen. It is now
      `bounded-trials`, like the b02 it controls for.

    Re-scoring `final-v1`'s three repeats through the corrected summarizer yields
    **one** digest, and re-scoring the two sealed sets yields exactly one digest
    each — different values than before, because *what* is digested changed, but
    one apiece. That is the check that matters: the change removed instability
    rather than introducing it. The lesson is that a single-repeat smoke run
    cannot find any of this, and that `acceptance_stable_across_runs` passing
    while `reproducible_across_runs` fails is the signature of volatile bytes
    rather than of unstable behaviour.
18. **A fatal `error` event on a checked-out client, mistaken for a harness
    fault.** When PostgreSQL is destroyed under an in-flight caller, `pg` emits
    `error` on the CLIENT — not on the pool — and Node treats an `error` event
    with no listener as fatal. The g03 worker was killed outright before its
    awaited `put()` could reject, reporting no JSON at all, which the driver read
    as `every_worker_reported_json: false`. Twice. `openDb` now attaches a
    listener to every client the pool creates, which swallows nothing: the
    in-flight query still rejects through its own promise, the process merely
    survives long enough to say so.

    This is worth carrying into the report as an **architecture** finding rather
    than a harness note. A runtime that does not attach that listener does not
    receive a database failure — it dies, and the difference between "the call
    rejected" and "the process vanished" is the difference between a run that can
    be retried and one whose state is unknown. With the listener attached, the
    measured behaviour is exactly what the architecture needs: `Client has
    encountered a connection error and is not queryable`, promptly, with a
    backend demonstrably blocked in the server at the moment of the kill.
19. **Two statements that stopped referencing their own parameter.** The
    head-scoped sweep numbered its head arrays from `$2`, leaving `$1` declared
    and unused, and the pending-writes omission reduced to `WHERE false`, doing
    the same. PostgreSQL cannot infer the type of a parameter a statement never
    references and raises `42P18`. It surfaced as `f09: party 0 never parked` —
    a kill gate that could not be reached because the statement before it had
    failed — which is the same costume defect 11 wore: a real fault presenting as
    a missing rendezvous. The head-scoped branch now numbers from `$1`, and the
    empty branch keeps a `WHERE false AND thread_id = ANY($1)` predicate purely
    so the parameter stays referenced.
20. **One last volatile counter, found only by a second full run.** `frozen-v1`
    passed 598/598 in all three repeats with a single digest, and the independent
    `frozen-verify` run passed 598/598 too — with TWO digests, differing in one
    field of one case: g03's `idleClientErrors`, 4 in one repeat and 2 in the
    next. It counts how many POOLED sockets happened to be open when the server
    was destroyed, which is connection scheduling rather than a property of the
    failure. Every deterministic fact the case asserts was identical across all
    six repeats — `blockedBackends: 1`, `callSettled`, `callRejected`,
    `observedClientErrors: 1`. Moved to `VOLATILE_RESULT_KEYS`.

    Worth recording for the same reason as #17: a run that is internally
    reproducible can still be irreproducible ACROSS runs, and only a second
    independent full run finds it. `frozen-v1` alone would have looked complete.
21. **Defect 19's class, reappearing the moment two features combined.** The
    head-scoped sweep binds three head arrays; the `pending-writes` omission
    emits a subquery that references only `$1`. Neither is wrong alone, and
    together PostgreSQL raised `08P01 bind message supplies 3 parameters, but
    prepared statement "" requires 1`. The branch's SQL depended on `omit` while
    the bind list depended on `headScoped`, and nothing made either aware of the
    other. Both omission branches now reference every declared parameter through
    a predicate that cannot change a result.

    Caught only because f17 exists: it is the first case to combine head-scoped
    retention with an omission, and no earlier case could have reached the
    combination.
22. **A fixture that retained the branch it was supposed to prune.**
    `headsFromProjection` takes the NEWEST leaf, which is right for a paused
    thread — the abandoned fork is older than the live branch. f14 manufactures
    its abandoned branch by forking AFTER the run completed, so the fork's rows
    are the newer ones, and the sweep dutifully retained the abandoned branch and
    deleted the terminal state.

    Every row-count criterion passed while it did so: rows were pruned inside a
    retained thread, the lineage was undamaged, nothing was stranded. The only
    thing that caught it was reading the state back — `apiSteps` returned
    `["prepare"]` where the terminal state is `["prepare","gate","finish"]`. f14
    now selects the head with the greatest `step`, which is a structural property
    rather than an assumption about id ordering.

    The lesson is the one this spike keeps relearning in new costumes: a
    criterion that counts rows cannot tell you WHICH rows, and a retention case
    that never reads its own survivor is measuring tidiness rather than
    survival.
23. **A global criterion that failed a run for the shape of its selection.**
    `every_bounded_case_has_a_persisted_outcome_set` required a non-empty
    outcome set. Family F contains no `bounded-trials` case, so a `--family F`
    run legitimately produced none and the criterion reported a failure that had
    nothing to do with the evidence. Same class as defect 8: a run-selection
    property wearing the costume of a measurement failure. The count equality and
    the dangling-pointer check carry the real content; the non-empty requirement
    was removed.
24. **An unresolved Promise is not a process park.** `frozen-v4` repeats 1 and 2
    passed, but repeat 3's h02 victim persisted its `after-effect` park row and
    then exited normally before the driver issued `SIGKILL`. The driver correctly
    stopped with `docker kill failed`; the run's promoted-looking filename holds
    `outcome.status: fault` and is not evidence. The source used `await new
    Promise<never>(() => {})`. Once the pools' idle sockets closed, that Promise
    supplied no referenced event-loop handle, so Node had permission to exit 0.
    Previous runs happened to kill inside the pool idle window and concealed the
    race. The same pattern appears in intentional forever-parks in A, C, E, F, H
    and S; they need one shared keepalive helper. Family G's `recordNodePark` is
    different: it must return so the worker can observe the restarted database.

---

## 9. Case registry as built

**Family S (self-test):** `s01-pins`, `s02-barrier-overlap`,
`s03-barrier-serial-control`, `s04-gate-passthrough`, `s05-lock-edge`,
`s06-embedding-oracle`.

**Family A (setup and migrations):** `a01-saver-setup-serial`,
`a02-saver-setup-race-passive`, `a03-saver-setup-race-gated`,
`a04-saver-setup-gated-sequential-control`, `a05-saver-setup-kill-before-ledger`,
`a06-store-setup-serial`, `a07-store-setup-race-gated`, `a08-store-trigger-race`,
`a09-store-lazy-same-process`, `a10-store-lazy-awaited-control`,
`a11-store-index-config-change`, `a12-colocated-schemas`,
`a13-saver-setup-advisory-lock` (lane `mit-migration`, paired with `a03`).

**Family B (checkpointer concurrency and conflicts):**
`b01-graph-serial-baseline`, `b02-same-thread-parallel-resume`,
`b03-same-thread-sequential-control`, `b04-put-conflict-metadata`,
`b05-blob-conflict-bytes`, `b06-checkpoint-and-blob-split`,
`b07-putwrites-ordinary-channel`, `b08-putwrites-special-channel`,
`b09-read-under-concurrent-commits`.

**Family C (atomicity, pools, locks, deletion):**
`c01-kill-inside-put-before-checkpoint-row`, `c02-kill-inside-put-before-commit`,
`c03-kill-after-commit-acknowledged`, `c04-kill-inside-putwrites-before-commit`,
`c05-nonatomic-writer-control`, `c06-pool-max1-serialization`,
`c07-role-connection-limit`, `c08-lock-wait-on-conflicting-put`,
`c09-delete-thread-versus-open-write`.

**Family D, slice 1 (Store setup, lifecycle, CRUD, schema):**
`d01-store-explicit-start-baseline`, `d02-store-lazy-first-operation`,
`d03-store-use-after-stop`, `d04-store-ensure-tables-false-cold`,
`d05-store-ensure-tables-false-migrated`,
`d06-put-failure-leaves-committed-row`, `d07-put-success-indexes-control`,
`d08-concurrent-put-same-key`, `d09-concurrent-put-and-delete`,
`d10-value-serialization-boundaries`, `d11-schema-isolation-two-stores`,
`d12-vector-extension-placement`, `d13-index-metric-config-change`.

**Family D, slice 2 (batch, pool, TTL):** `d14-batch-read-your-writes`,
`d15-batch-partial-commit-on-failure`,
`d16-convenience-path-error-isolation-control`,
`d17-async-batched-store-rejection-fanout`,
`d18-batch-search-nested-acquisition`,
`d19-batch-search-nested-acquisition-max2-control`,
`d20-batch-search-indexed-shares-client-control`,
`d21-store-pool-max1-serialization`, `d22-ttl-zero-and-negative`,
`d23-ttl-refresh-on-read-uses-the-default`,
`d24-ttl-refresh-without-a-default-control`, `d25-manual-sweep-and-statistics`,
`d26-concurrent-sweepers`.

**Family D, slice 3 (namespaces, pagination, filters):**
`d27-namespace-validation-matrix`, `d28-namespace-delimiter-collision`,
`d29-namespace-prefix-boundary`, `d30-list-namespaces-maxdepth-after-limit`,
`d31-list-namespaces-skips-validation`,
`d32-list-namespaces-pagination-control`, `d33-filter-matrix`,
`d34-filter-fail-open`, `d35-filter-null-and-array-values`,
`d36-filter-numeric-cast-on-mixed-types`.

**Family D, slice 4 (text, vector, hybrid search):** `d37-vector-search-cosine`,
`d38-vector-search-l2`, `d39-vector-search-inner-product`,
`d40-vector-search-thresholds`, `d41-vector-search-unindexed-item`,
`d42-vector-search-dimension-mismatch`, `d43-hybrid-search-weights`,
`d44-text-search-semantics`, `d45-search-convenience-versus-batch`.

**Family E (subgraph namespaces and lifecycle):** `e01-nested-subgraph-baseline`,
`e02-inlined-graph-control`, `e03-parallel-subgraph-instances`,
`e04-subgraph-interrupt-and-resume`, `e05-subgraph-crash-resume`,
`e06-nested-depth-two`, `e07-subgraph-pending-write-reuse`,
`e08-subgraph-concurrent-resume`,
`e09-root-fanout-pending-write-reuse-control`.

**Family H, effect-key half (Step 20):**
`h01-effect-key-components-baseline`, `h02-effect-key-across-crash-resume`,
`h03-effect-key-across-explicit-fork`, `h04-effect-key-async-durability`,
`h05-effect-key-fanout-siblings`, `h06-effect-key-multiple-ordinals`,
`h07-effect-key-inside-subgraph`.

**Family I (mitigation lanes):** `i01-thread-lease-parallel-resume` and
`i03-thread-lease-released-on-exit` (lane `mit-lease`, both paired with `b02`),
`i02-thread-lease-disabled-control` (lane `stock`),
`i04-store-guard-rejects-delimiter-in-a-label` (pairs `d28`),
`i05-store-guard-rejects-wildcard-prefix` (pairs `d31`),
`i06-store-guard-rejects-zero-ttl` (pairs `d22`),
`i07-store-guard-rejects-fail-open-filters` (pairs `d34`),
`i08-store-guard-allows-safe-operations-control` (pairs `d01`) — all lane
`mit-storeguard`.

Family I added `src/guards.ts` (`threadLeaseKey`, `acquireThreadLease`,
`checkStoreOperation`) and `src/family-i.ts`. The lease uses the one-key
`bigint` advisory space, disjoint from the two-key form `contract.ts` already
spends on migrations, so a thread lease and a migration lock cannot collide by
arithmetic accident. Family I is declared `provision: "bare"` and every case
overrides it upward, which is why the projector now unions the family's
provisioning with the case's.

**Family G (database and container-stack restart):**
`g01-graceful-database-restart`, `g02-unclean-database-kill-and-recovery`,
`g03-database-death-under-a-live-worker`,
`g04-container-stack-replacement-on-the-preserved-volume`,
`g05-fresh-volume-negative-control`.

Family G added `src/family-g.ts` and the driver's first case-directed control
over the database stack: `CaseDef.restart = { afterParty, action }`, applied by
`apply_stack_action` BETWEEN two parties. Between, not inside — acting on the
server while a worker still holds pooled connections measures pg's reconnect
behaviour, which is a different question from whether persisted state survives
the stack that wrote it. `start_family_database` was refactored around a reusable
`create_pg_container`, and log evidence is captured as **marker counts over a
line delta**, never as raw log text, so nothing the server printed can ride into
evidence. `g05` must run last within the family: it replaces the volume, which
destroys every other family G database.

**Family F (retention and blob reachability):** `f01-blob-sharing-baseline`,
`f02-naive-checkpoint-deletion-by-date`, `f03-naive-superseded-blob-deletion`,
`f04-reachability-sweep-retains-a-paused-thread`, `f05-prune-nothing-control`,
`f06-prune-head-control`, `f07-incomplete-sweep-omits-channel-versions`,
`f08-incomplete-sweep-omits-ancestors`, `f09-kill-pruner-safe-order`,
`f10-kill-pruner-unsafe-order-control`.

Family F added `src/prune.ts` (the throwaway sweep, the two naive policies, and
`threadCounts`) and `src/family-f.ts`. `reachability()` in
`src/inspect/checkpoints.ts` was generalised to `reachabilityAcross(db,
threadIds)` — pruning damage is cross-thread by nature, and a thread-scoped
witness would report a clean bill of health for the retained thread while the
sweep had strewn stranded references next door. `reachability(db, threadId)`
remains as a one-element call, so families A–E are unchanged; the sealed digests
confirm it.

Family F declares **no `executions` oracle** on any case, for the reason
`h10`/`h15`–`h17` do not: `f06` legitimately executes nothing, and several other
cases might, so requiring a non-empty execution set would convert a finding into
a harness fault. `f06` also omits `lineage`, because pruning the head is
precisely the case where the retained thread has zero checkpoint rows.

**Family H, changed-graph half (Step 21):** stock —
`h08-changed-graph-identical-control`, `h09-changed-graph-cosmetic`,
`h10-changed-graph-renamed-node`, `h11-changed-graph-added-channel`,
`h12-changed-graph-moved-interrupt`; lane `mit-compat`, each paired with the
stock case above it — `h13-compat-guard-identical`,
`h14-compat-guard-cosmetic`, `h15-compat-guard-renamed-node`,
`h16-compat-guard-added-channel`, `h17-compat-guard-moved-interrupt`.

`h10`, `h15`, `h16` and `h17` deliberately do **not** declare the `executions`
oracle. Its presence check requires a non-empty set, and an empty one is the
result: a refused resume runs nothing, and the renamed-node variant runs nothing
either. Declaring it would have converted a finding into a harness fault — which
is exactly what happened on the first run of `h10` before the declaration was
corrected.

`bounded-trials, trials: 1`: `a02`, `a03`, `a07`, `a08`, `a09`, `b02`, `b04`,
`b05`, `b06`, `b07`, `b08`, `d08`, `d09`, `d26`, `e08`, `h04`.

The `embeddings` oracle-presence check was broadened in Step 17. It previously
recognised only s06's independently computed orderings; it now also accepts a
case carrying the hand-authored `expectedOrder` it was scored against. Both
shapes prove the frozen fixture was consulted, and neither is satisfied by a case
that merely used the embedder to write something — which is why `embeddings` is
declared on the three ranking cases and on nothing else in family D.

Two registry mechanisms were added in Step 14. A case may now override its
family's `provision`, because several Store cases must begin with **no** store
tables — whether `setup()` ran is their subject, and provisioning them like the
rest would answer the question before the case started. And `FamilyDef` gained
`projectsStore`, so only family D pays the cost of an item-level Store
projection; families A–C already capture the terminal Store *schema* through
`relations` and `storeLedger`, and adding a constant empty projection to their
digests would assert nothing.

New harness modules added in Steps 10–11: `src/graph.ts` (the interrupt fixture
and its probe-recorded node executions), `src/family-b.ts`, `src/family-c.ts`,
plus `conflictWitness()`, `executionCounts()` and `sampleConsistency()` in
`src/inspect/checkpoints.ts` and `canonicalCheckpointLabels()` /
`canonicaliseProjection()` in `src/canonical.ts`.

Added in Step 21: `src/graph-manifest.ts` (manifest construction, source
normalisation, and `compareManifests`) and `src/variants.ts` (the five pinned
changed-graph variants, all compiled into the **same** image as the baseline — a
variant living in a separate build would make "the graph changed"
indistinguishable from "the runtime changed"). The manifest is stored as a
`spike_probe.event` row rather than in a new table, so the guard's input sits on
a connection the checkpointer does not own and **no case outside family H gains a
relation** — adding a table to the probe schema would have changed the
`relations` list, and therefore the digest, of every case in the matrix.

Added in Step 20: `src/subgraphs.ts` (six topologies plus the two fan-out
controls and one shared invoke path), `src/effect-key.ts`, `src/family-e.ts`,
`src/family-h.ts`, and `src/inspect/effects.ts` (`effectEvents` for the config
side, `effectSites` for the row side). Four mechanisms went with them:

- **`recordNodePark`** — a durable park recorded from inside a NODE body rather
  than at a vendor SQL boundary. Families A and C anchor kills on a statement
  because the question there is what half a `put()` leaves behind; families E and
  H need the kill to land while user code runs, before the task's writes exist at
  all. Counting statement ordinals to find that moment would be guesswork about
  how many statements a superstep emits. It reuses `gate_park`, so the driver's
  `awaitpark` contract is unchanged, with `position = 'node'` so the two kinds of
  park are never confused in evidence.
- **The `effectKey` oracle** requires BOTH sides non-empty, and declaring it is
  what makes the projector emit them — keyed off the case's declared oracle
  rather than off its family, so no sealed digest gains a constant empty array.
- **Effect keys are ranked, not digested.** A key is a SHA-256 over a checkpoint
  id and a task id, so the hash is as volatile as a timestamp while every
  criterion asks an *equality* question. One ranker across all five key fields,
  assigned in a content order (node, ordinal, party) rather than array order —
  three siblings in one superstep write their probe rows in whatever order they
  finish.
- **Embedded ids inside namespace strings are rewritten** by
  `canonicaliseProjection`, which now replaces every uuid found *within* a string
  with its lineage or task label. Bare-token handling is untouched and `""` stays
  literal, so a projection with no subgraphs canonicalises exactly as before —
  confirmed by re-summarizing both sealed bundles (`core-v4`, `store-v1`) through
  the changed code: all six per-repeat digests reproduce byte-identically with
  zero acceptance drift.

---

## 10. Standing constraints

- Spike 05 is complete and accepted: scoped pass, `48/48`, digest
  `d5aa45b71b6b0cafc73ef9de30ea274add6d74e8ccfdf2645200a9b6dc38873a`. Its harness
  and evidence are read-only reference material.
- Leftover Spike 05 trust-auth volumes: `lgdur-confirm-r{1,2,3}-pgdata`.
- Unrelated uncommitted work exists in the repo (architecture docs,
  `spikes/openai-device-auth`). It must not be folded into Spike 06 commits.
- `npx tsc --noEmit` and `bash -n verify-concurrency.sh` are run after every edit
  round, plus `node src/main.ts cases` to run the registry validator.
- **Version-control state, at the point the spike was sealed:**
  - The harness is tracked. The Step 31 hardening was committed in
    `f4486a0 "More work"`.
  - The audit-2 corrections, the `parkUntilKilled()` fix, this appendix and the
    report were all still **uncommitted** when the spike closed. Until they are
    committed, what is in history is the pre-audit-2 harness — which still
    carries f11's criterion that the stale deletions satisfy, f12/f13's
    overstated purposes, root-only head enumeration, and no `observed` block —
    and **a checkout of that commit will not reproduce the citable digest.**
  - `tmp/` is gitignored by design, so no evidence set is in version control.
    Evidence is reproduced by re-running the harness, not by checking it out.

  A reader must therefore confirm the working tree is clean for
  `spikes/postgres-checkpointer-concurrency/` before treating a re-run as a
  reproduction.

- **Evidence on disk**, all under `tmp/spikes/postgres-checkpointer-concurrency/`:

  | Set | What it is |
  | --- | --- |
  | `frozen-v5` | **The citable final evidence set.** 146 cases, 3 repeats, 657/657, eleven globals, `final: true`, digest `4f947c3d0fd4e59e4ac5321d26a8fd8f33c40a28f3a7cb3c2d4f22beca7160bf` |
  | `frozen-v5-verify` | The Step 44 fresh-build run (builder cache pruned, 0 CACHED layers). Identical overall digest, per-lane digests **and** acceptance map |
  | `killfix-check` | The defect-24 validation subset: 13 kill-anchored cases (closure 18), 1 repeat, 106/106, every victim exiting 137 and s07 exiting 143. Non-final by construction (`evidence.subset.json`) |
  | `frozen-v4` | **Harness fault, never citable.** Repeats 1 and 2 passed with digest `4f947c3d…`; repeat 3 stopped at h02 when the victim exited before its planned kill (§8.22 defect 24). Retained on disk as the evidence OF that defect — its `evidence.json` carries `outcome.status: "fault"`, so the filename cannot be mistaken for a result. Its Docker objects and image were removed |
  | `frozen-v3` | Audit history. Same digest and criteria, but its non-digested `observed` block collapses six bounded cases (§8.25), so it cannot support the report's outcome-distribution prose. Superseded by `frozen-v5` |
  | `frozen-v3-verify` | The Step 38 fresh-build run (builder cache pruned). Same digest, independently produced |
  | `frozen-v2` | The Step 32 set. Superseded at Step 34 (§8.21). Audit history; its digest is not citable |

  Every pre-hardening set (`core-v4`, `store-v1`, `final-v1/2/3`, `verify-v1`) has
  been deleted: they were produced by superseded criteria and a superseded
  digested form, and keeping them invites citing a stale digest. The findings
  they established survive in §8.1–8.16, corrected where §8.19 says so.

  Re-scoring any set is `node src/main.ts summarize < <set>/repeat-N/bundles.json`.
- **No open defects.** b09's racy anti-vacuity witness (§8.18) was repaired in
  Step 31 and Step 32 passes on every check.
