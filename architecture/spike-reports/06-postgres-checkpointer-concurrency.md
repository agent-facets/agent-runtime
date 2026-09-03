# Spike 06 — Postgres Checkpointer and Store Under Concurrency

**Outcome: pass with required safeguards.** The official `PostgresSaver` is fit
for this architecture's persistence layer — its writes are transactionally atomic
against process death, an acknowledged commit is durable, readers never observe a
torn checkpoint, a starved pool serialises rather than hangs, and a paused run
survives the database being destroyed and both containers being replaced on a
preserved volume. None of that holds *under concurrency* without runtime-owned
safeguards, and four are now mandatory rather than advisable.

The **`PostgresStore` is a measured fail for the memory-index role and is
replaced** by an app-owned pgvector and full-text schema. That is the one design
decision this spike changes.

**The characteristic failure mode of this stack is success with nothing done.**
Six independent mechanisms return `completed: true` having executed zero nodes:
a duplicate concurrent resume replaying persisted state, a resume against a
renamed node, a resume against pruned state, a resume against a fresh volume, a
put racing a delete, and a sweep that deleted the thread it was asked to keep.
A caller that checks only for an error detects none of them.

## Question

> Do the official checkpointer and Store behave as documented under concurrency?

**No, for both** — and the packages document almost no concurrency behaviour, so
most of what follows is measured against the PostgreSQL contract and against what
this architecture requires rather than against a vendor promise. Every finding
below is labelled by which.

## Environment

| | |
|---|---|
| Host | Linux, WSL2, x86_64 |
| Run id | `frozen-v5`, 3 isolated repeats, 146 cases, 657 acceptance criteria |
| Overall managed digest | `4f947c3d0fd4e59e4ac5321d26a8fd8f33c40a28f3a7cb3c2d4f22beca7160bf` |
| Runtime image | Built from the pinned base by digest; asserted per party |
| Database | PostgreSQL 17.11, `pgvector/pgvector:pg17-bookworm@sha256:cf134a76…` |
| Harness | [`spikes/postgres-checkpointer-concurrency/`](../../spikes/postgres-checkpointer-concurrency/) |

Immutable inputs, verified at run time against the installed tree, the committed
lockfile **and** the fixture manifest — version and integrity, all three:

| Input | Pin |
|---|---|
| Base image | `node:24.6.0-bookworm-slim@sha256:9b741b28…d9edff` |
| Database image | `pgvector/pgvector:pg17-bookworm@sha256:cf134a76…f8e6f` |
| Orchestrator | `@langchain/langgraph@1.4.13` |
| Checkpointer + Store | `@langchain/langgraph-checkpoint-postgres@1.0.5` |
| Checkpoint base | `@langchain/langgraph-checkpoint@1.1.5` |
| Core / driver | `@langchain/core@1.2.9`, `pg@8.16.3`, `zod@4.5.4` |

The Store is the `./store` subpath export of the checkpointer package; no second
vendor package is involved. No model, no provider, no credential. Embeddings are
frozen 8-dimensional literal vectors with hand-authored expected orderings.

## Method

```bash
./spikes/postgres-checkpointer-concurrency/verify-concurrency.sh   # 3 isolated repeats
```

146 cases across six lanes — `selftest`, `stock`, and four explicitly labelled
mitigation lanes. **112 candidates, 28 controls, 6 mutations.** One PostgreSQL
container and named volume per family per repeat, one database per case, on a
gateway-less internal network. Workers run unprivileged as PID 1 with read-only
filesystems, all capabilities dropped, no published ports and no source mount;
posture is read back out of `docker inspect` and asserted rather than described.

### What makes a concurrency claim admissible here

Terminal graph output cannot distinguish "this node ran" from "this channel was
restored" — measured directly: in `b03` a second worker returned
`steps: ["prepare","gate","finish"]` and `completed: true` while contributing
**zero** node executions. Every claim is therefore anchored to something a replay
cannot fake:

```text
execution counts    an independent probe, autocommit, on a connection the graph does not own
lineage             raw SQL against lg_checkpoints, never getState()
overlap             N-party barrier: arrival rows persisted before the release row exists,
                    plus a second witness counting distinct attached parties
lock contention     a captured blocked → blocking backend edge, cross-checked between
                    pg_locks and pg_blocking_pids() — never elapsed time
transactions        backend drain plus direct rows and xmin
kills               anchored on a durable gate-park row, never on a sleep
restart identity    pg_control_system().system_identifier, not anything Docker reports
```

Statement gates park operations without touching vendor SQL: `s04` compares the
statement multiset **and** order of a gated run against an ungated one, and both
must match exactly. An unrecognised statement is a fault, because it makes every
gate ordinal downstream of it unsound.

### Bounded races

17 cases are classified `bounded-trials`. Nothing loops the participant body, so
**a trial is one isolated repeat: n = 3 per citable set.** These cases report an
observed outcome *set* and are never called race-free because no failure
appeared. Their outcomes are persisted in the evidence's `observed` block,
excluded from every digest by construction.

## Acceptance

**657/657 in every repeat**, on one overall managed digest
`4f947c3d0fd4e59e4ac5321d26a8fd8f33c40a28f3a7cb3c2d4f22beca7160bf`, with eleven
global criteria true — including `reproducible_across_runs`,
`acceptance_stable_across_runs`, `every_bounded_case_has_a_persisted_outcome_set`
and `no_managed_field_points_at_absent_findings`.

Acceptance is the **elementwise AND across all three repeats**, computed inside
the pinned image from the collected bundles, so the claims and the code that
makes them stay on the same version.

| Group | Result |
|---|---|
| Pins, lockfile, manifest integrity, image provenance, PID 1, worker posture, egress | Pass |
| Setup and migration races, stock and advisory-lock lanes | Pass |
| Same-thread resume, conflicting `put`/`putWrites`/blobs, read consistency | Pass |
| Transaction atomicity, pool exhaustion, lock graphs, `deleteThread` | Pass |
| Complete public `PostgresStore` surface | Pass |
| Subgraph namespaces, lineage, pending-write reuse | Pass |
| Effect-key stability and fork discrimination | Pass |
| Changed-graph variants and compatibility refusal | Pass |
| Retention, blob reachability, per-namespace pruning | Pass |
| Database restart, container-stack replacement, fresh-volume control | Pass |
| Four mitigation lanes, each paired with its stock case | Pass |
| 28 controls and 6 mutations, each failing for its own named reason | Pass |
| Repeat stability, managed digests, sanitisation | Pass |

## Findings

### The checkpointer is atomic, and the detector proves it

`put()` and `putWrites()` are transactionally atomic against process death.
Killed after both blob upserts but before the checkpoint row (`c01`), after every
row but before `COMMIT` (`c02`), and mid-`putWrites` (`c04`): **0 checkpoints,
0 blobs, 0 writes** survive in each. Killed *after* `COMMIT` returned but before
the promise resolved (`c03`): **1 checkpoint, 2 blobs** survive — which is what
makes the first three mean "the transaction rolled back" rather than "the kill
landed early".

Two controls prove the detector is not blind. `c05` writes a checkpoint and its
blob in two autocommit statements and is killed between them, leaving a
**stranded reference**. `c10` writes them in the *vendor's* order — blobs first,
as `_dumpBlobs` does — leaving **orphan blobs**. `c05` alone validated a detector
for damage a torn `put()` cannot produce.

Readers never observe a torn checkpoint (`b09`): sampling across a five-checkpoint
commit sequence, **zero** samples saw a stranded reference or a broken parent.

### Concurrent setup is not safe, and the outcome is a bounded set

`setup()` is a read-then-DDL-then-insert sequence with **no transaction, no
advisory lock and no locking read** (source). Four racers proven to have read an
empty ledger — four durable park rows on the version read, four distinct
backends, released only after all arrived — produce `23505` for three of four
(`a03`). The Store setup races sampled `{23505, none}` in all three `frozen-v5`
repeats; across every run of this harness the accumulated set also contains
`42710` and `XX000`. The failure is therefore a **bounded set, not a fixed
profile**, and three samples do not exhaust it — a runtime that handles only the
SQLSTATE it happened to see will meet one it did not.

Lazy setup races *itself inside one process* (`a09`): eight concurrent first
operations produce eight migration reads, **one** fulfilled `put` and **seven**
rejections across four distinct constraints. The guard is a plain boolean
assigned only after the awaited migrations finish, not an in-flight promise. The
awaited control (`a10`) issues zero migration statements and fulfils 8/8.

A killed migrator leaves the schema **ahead of** the ledger (`a05`); retry
converges. An index-configuration change after first setup runs **nothing**
(`a11`, `d13`): the ledger stores positions, the column stays `vector(8)`, the
newly configured metric has no index at all, and writes keep succeeding.

**The advisory-lock safeguard eliminates it** (`a13`): zero SQLSTATEs across four
racers, every session's unlock returning true, holding intervals disjoint on the
*server* clock, terminal schema identical to the serial baseline.

### Two workers on one thread both execute

`b02`: two containers resume the same committed interrupt: the final node
executes **twice on two distinct process nonces** and the root namespace ends
with **two leaves** — a forked lineage. Both workers returned success. All three
`frozen-v5` repeats sampled that outcome; an earlier run sampled a
non-duplicating one, so the accumulated set is `{1, 2}`: duplication is the
common case, not a certainty, and its absence on one attempt proves nothing. The
sequential control (`b03`) never duplicates.

The subgraph boundary does not contain it. `e08` duplicated `finish` in **all
three** repeats, and the fork is not confined to the root: two repeats ended with
leaves-per-namespace `[1,2]` and the third with `[2,2]` — **both namespaces
forked**.

**The per-thread lease eliminates it** (`i01`): both workers provably released
together, one takes the lease and runs, the other executes **nothing** and is
classified `awaiting_resource`. The lock is taken with `pg_try_advisory_lock` on
an explicitly checked-out client from a `max: 1` pool — a lock taken through
`pool.query` lands on whichever backend was free and is then returned to the
pool. The disabled control (`i02`) lets both through, which is what attributes
the single execution to the lease rather than to the fixture.

### Conflict semantics are mixed on one table, by design

| Path | Clause | Consequence |
|---|---|---|
| `checkpoint_blobs` | `ON CONFLICT … DO NOTHING` | first writer wins the bytes |
| `checkpoints` | `ON CONFLICT … DO UPDATE` | last writer wins the row |
| `checkpoint_writes` | `DO UPDATE` only when every channel is special, else `DO NOTHING` | opposite semantics on one table, selected by channel name |

So a single `put()` collision **splits the row from its bytes** (`b06`):
`rowOwnerEqualsByteOwner` is **false in all three repeats**, with the winner
varying between them. The surviving checkpoint describes state its own writer
never stored. This is invariant, not a race: the row is `DO UPDATE` and the bytes
are `DO NOTHING`, so a collision always separates them.

`deleteThread()` racing an open write leaves the writer's rows as an atomic set
but with a **broken parent link** — a checkpoint naming a row the delete removed
(`c09`).

### Pools fail loudly; one nested acquisition does not

A starved pool serialises rather than hangs: six concurrent `put()`s through
`max: 1` all fulfil on one backend (`c06`). Connection exhaustion is loud and
bounded — a single `53300`, no anonymous timeout (`c07`).

The one measured hang is a `batch()` carrying a search on an unindexed Store with
`max: 1` (`d18`): `batch()` holds the only client and the search delegates to
`textSearch`, which waits for a connection that cannot be returned. It did not
settle within 15 s. `max: 2` completes; an indexed Store completes. **Any
component that acquires a second connection while holding one needs `max ≥ 2`.**

### Pruning must be reachability-based, per namespace

**There is no timestamp column anywhere in the checkpointer schema.** Not one
`created_at` across `checkpoints`, `checkpoint_blobs` or `checkpoint_writes`. A
date predicate cannot be *expressed* against these tables, let alone be correct.
`checkpoint_blobs` has no time-like handle at all — only `version`, a per-channel
counter.

Blob rows are shared: a channel that stops changing keeps its version and every
later checkpoint goes on referencing it (`f01`, per-thread maximum 3). So naive
deletion by date breaks lineage and strands blobs (`f02`), and "delete every
superseded blob version" — the only rule the blob table's columns permit —
strands live references on the retained thread (`f03`).

**Stranded references never raise.** The loader INNER-joins `checkpoints` to
`checkpoint_blobs` over `jsonb_each_text(channel_versions)`, so a missing blob
does not error: the channel silently vanishes and the thread resumes on truncated
state. Measured twice (`f03`, `f10`).

The architecture's rule works, with one correction that is easy to get wrong:

> live set = **retained heads, one per live namespace** ∪ parent lineage ∪
> referenced channel versions ∪ pending writes ∪ interrupts

The per-namespace part is load-bearing. A subgraph's chain is **separately
rooted**, and the sweep's recursion follows `parent_checkpoint_id` *within* a
namespace, so a root head reaches none of a child namespace's rows. Seeding from
the root only (`f16`) deletes the child namespace **entirely** — checkpoints,
blobs, writes and the `__interrupt__` row that was the outstanding approval —
while leaving the root untouched. The resume then returns
`interrupted: true, completed: false, steps: ["prepare"]`: the old approval
consumed by nothing and a **fresh** one now blocking the run. Seeding one head
per namespace (`f15`) leaves every namespace byte-identical and the run resumes.

Each term is individually falsifiable: omitting channel versions strands
references (`f07`), omitting ancestors breaks lineage (`f08`), omitting pending
writes makes a completed fan-out sibling **re-execute** (`f17`, against the
`f18` control where it is reused), and omitting interrupts removes the approval
from the tables (`f13`).

Delete order matters because the sweep cannot be transactional if a crash
mid-sweep is the question: **writes → checkpoints → blobs** leaves harmless
orphan blobs (`f09`); the reverse order paired with an incomplete rule leaves
three stranded references in the *retained* thread (`f10`).

A **completed** thread survives head-scoped pruning readably (`f14`): its
abandoned branch goes, and the terminal state still resolves — six referenced
channels, zero unresolved — with a state read returning the full step list and
executing no node.

### An `__interrupt__` row is history, not a pending-approval queue

Two measurements compound here, and together they make a runtime that counts
those rows wrong twice over:

- A **nested** interrupt is recorded at **both** levels — once in the subgraph
  namespace and once in the root, because the parent task re-raises it as it
  bubbles up (`e04`). The authored expectation that it stays in the namespace
  that raised it was wrong.
- **Consuming an interrupt does not delete its row** (`f14`). A completed run's
  own interrupt write is attached to a checkpoint the live head descends from, so
  a correct reachability sweep *keeps* it.

Approval state must therefore be the runtime's own row, keyed on
`(thread, raising namespace, task)`, reconciled against the tables and never
derived by counting them.

### Pending-write reuse does not happen inside a subgraph

`PregelLoop.initialize` computes `skipDoneTasks = !("checkpoint_id" in
config.configurable)`, and `_prepareSingleTask` builds every task's config with
`checkpoint_id: undefined` — **present as a key, undefined as a value**. A
key-presence test that any task-derived config fails means **every subgraph has
reuse disabled**.

Measured (`e07`): a two-sibling fan-out inside a subgraph where the slow sibling
throws after the fast one's write has landed — on resume the fast sibling
executes **again**, despite its pending write being present and its task id
unchanged. The root-level control (`e09`) with the identical topology and the
identical thrown failure reuses it. Only the nesting differs.

Spike 05's "a completed sibling was reused" is therefore a **root-namespace**
property. Inside a subagent, the idempotency ledger is the only thing preventing
a duplicate effect.

### The effect key holds, and three of its components are not publicly reachable

The key proposed in [09-data-model-and-lifecycle.md](../09-data-model-and-lifecycle.md)
is an **architecture** construct — LangGraph publishes no effect key. Both
properties the design assumed are now measured:

- **Stable across a `sync` crash resume** (`h02`): a worker killed after
  recording its effect and before its writes landed; the fresh container computed
  the **identical** key, with identical namespace, parent checkpoint, task and
  ordinal.
- **Different across an explicit fork** (`h03`): a new `source: "fork"`
  checkpoint, a new parent, new task ids, a second head, a different key. The
  authored prediction that a fork would reuse the named checkpoint as the uuid5
  namespace was **wrong**.

Both ablations are load-bearing: dropping `task` collapses three sibling effects
to one key (`h05`); dropping `ordinal` collapses three effects from one node to
one (`h06`).

Construction constraints that a runtime cannot discover from the public surface:

- Only `run` and `ns` come off the public config. `parent_checkpoint` requires
  the undocumented `configurable.checkpoint_map`; `task` requires the
  private-by-convention `__pregel_task_id`.
- `configurable.checkpoint_id` is **null inside every task**. A runtime keying on
  the obvious field hashes `null` for every effect in the system.
- **The namespace a node sees is not the namespace its writes carry.**
  `PregelLoop.putWrites` stamps rows with the *graph's* namespace. A key built
  from what the node sees cannot be rediscovered from `checkpoint_writes`, and
  because the task namespace embeds the task id, it would also collapse `ns` and
  `task` into each other.
- `ordinal` is **not in the database**: `idx` counts a task's writes, not a
  node's effects. The ledger must carry it.

### Nothing compares the graph against the state it resumes

There is no compatibility check anywhere in the resume path — no node-set
comparison, no channel-set comparison, no fingerprint. Every changed-graph
outcome follows from that absence.

| Variant | Stock outcome |
|---|---|
| identical (control) | Resumes, consumes the interrupt once, completes |
| cosmetic | Resumes and completes — neither manifest half sees the change |
| **renamed node** | **No error, a result object, `completed: true` — while executing zero nodes and leaving the checkpoint head, the checkpoint count and the interrupt row exactly where they were.** The caller is told the run succeeded; the approval it was waiting on is silently abandoned |
| added channel | **Harmless.** Resumes and completes; the persisted state simply lacks the channel and its default applies. The authored expectation that a changed channel set is dangerous was wrong for a *widened* schema |
| **moved interrupt** | The decision is delivered to a position that no longer interrupts. The run advances past the old pause point and raises a **new** interrupt: `completed: false`, head advanced. The original approval is consumed by nothing |

The renamed-node result is worse than the authored prediction. The prediction was
"resumes into the wrong branch"; the measurement is "reports success having done
nothing".

**The guard works** (`h13`–`h17`): it allows identical and cosmetic, refuses the
three unsafe variants with `invoked: false`, leaves checkpoint count, interrupt
rows and head id unchanged, executes zero nodes, and produces a stable typed
refusal `graph_incompatible` with sorted reasons naming the change.

Two design consequences:

- **The moved interrupt is structurally invisible** — `structureDiffers: false`,
  `fingerprintsDiffer: true`, and the refusal carries no structural reason. A
  manifest built from node and channel names alone would have waved it through.
  Node-body fingerprints are mandatory, not optional.
- **The guard over-refuses a widened channel set**, recorded as its own criterion
  rather than hidden. The engine tolerates that variant; the guard refuses it.
  That is the deliberate cost of a fail-closed rule that cannot distinguish
  widening from narrowing without deciding semantic equivalence.

### The database can die and the stack can be replaced

| Case | Result |
|---|---|
| `g01` graceful restart | Identical system identifier, later postmaster start, `database system is shut down` ×1 and **no** recovery in the log delta, every row intact, run resumed |
| `g02` unclean `SIGKILL` | `was not properly shut down` ×1 and `redo starts at` ×1 — recovery **read from the server's own log**, not inferred from it coming back |
| `g03` death under a live worker | A dedicated session holds the checkpoint table, a real `put()` blocks on it, and only once `pg_stat_activity` reports a **waiting subject backend** is the server destroyed. Measured: one blocked backend, the call settles promptly and **rejects loudly** — `Client has encountered a connection error and is not queryable` |
| `g04` container-stack replacement | Both containers removed and recreated from the pinned image id on the **same named volume**: different container, identical `system_identifier`, every row intact, a genuinely fresh runtime container resumed from persisted state alone |
| `g05` fresh-volume control | The identical procedure onto a **new** volume: identifier changes, state `0/0/0/0`, and the resume returns `error: null, completed: true` with an **empty step list** |

The `g04`/`g05` differential is the load-bearing result: identical replacement
procedure, and **only volume continuity decides whether the run survives**.
`completed` is useless as the discriminator here, which is why every family G
criterion turns on the replayed step list.

Two operational consequences: **every stack replacement crash-recovers**, because
`docker rm -f` is a `SIGKILL` — the recovery path runs whether or not anyone
intended it. And a runtime **must attach an `error` listener to every pooled
client**: when PostgreSQL is destroyed under an in-flight caller, `pg` emits
`error` on the *client*, not the pool, and Node treats an unhandled `error` event
as fatal. Without the listener the process does not receive a database failure —
it vanishes, and the difference between "the call rejected" and "the process
disappeared" is the difference between a retryable run and a run whose state is
unknown.

### The Store: measured unsuitable for the memory index

The complete public surface was exercised — 45 cases. The checkpointer's verdict
does not carry over.

**Search is wrong in ways that are silent.** Inner-product ranking is **exactly
reversed** (`d39`): pgvector's `<#>` returns the *negative* inner product and the
implementation orders `MIN(<#>)` descending, so the best match sorts last. One
`similarityThreshold` means three incompatible things (`d40`): a correct negated
distance bound for cosine, a raw distance ceiling for L2, and — for inner
product — a comparison against a quantity that is always negative, returning
`[]`. Hybrid search is cosine-only and does not accept `distanceMetric` (`d43`).
A batched search carries no mode, no metric and no threshold, so `batch()` can
only ever rank by cosine (`d45`). Cosine and L2 rank correctly against
hand-authored orderings (`d37`, `d38`), so this is the package's use of
pgvector's operators, not pgvector.

**Filters fail open.** An unrecognised operator, an empty `$in` and an empty
`$nin` each produce no SQL condition at all and return **every row** (`d34`). A
numeric range operator casts across the scanned set, so one row holding text at
that key raises `22P02` and the whole query returns **nothing** (`d36`). For a
retrieval path whose job includes "drop superseded and out-of-window", a
fail-open validity filter returns superseded memories as current.

**Namespaces cannot carry scope.** `:` is both a legal label character and the
join delimiter, so `["spike","a:b"]` and `["spike","a","b"]` are **one row** and
either namespace reads it (`d28`). Prefix matching is string-prefix, not
path-prefix: `["alpha"]` returns `alphabet` (`d29`). `listNamespaces` skips the
validator every other path runs, so a `%` prefix is accepted and returns **both
tenants** (`d31`) — and `validateNamespace`'s own source comment cites
cross-tenant exposure as its reason for existing. `maxDepth` is applied *after*
`LIMIT`, so a bounded page can be filtered to nothing (`d30`).

**Writes are not what they appear.** `batch()` acquires one client and loops with
sequential awaits — there is no `BEGIN` anywhere — so it **commits a prefix and
abandons the suffix** (`d15`). Through `AsyncBatchedStore`, one invalid operation
rejects **all four** callers in the tick while two of their writes are durably in
the table: two callers received a rejection for a write that succeeded (`d17`).
A rejected `put()` is not a no-op (`d06`): the row is upserted, the vectors
deleted, and only then is the embedding attempted — so a failure leaves the item
holding the **new** value with zero vectors, readable and invisible to vector
search.

**TTL is inverted at the boundary.** `ttl: 0` produces `expires_at NULL` — a
permanently readable item, the exact inverse of the request (`d22`), because
`calculateExpiresAt` treats zero as falsy. And `refreshOnRead` recomputes from
`defaultTtl` while ignoring the ttl the item was written with, so a read moved an
expiry roughly **ten hours earlier** (`d23`).

**The schema is not self-contained.** `CREATE EXTENSION vector` is unqualified
and lands wherever `search_path` points — `public`, never the Store's own schema
— so `store_vectors.embedding` resolves to `public.vector`, and a Store migrated
on a connection whose `search_path` holds only its own schema fails `42704`
(`d12`). Schema separation isolates the Store's **data** (`d11`) but not its type
dependency.

A fail-closed guard can contain the input-shaped defects, and one was built and
measured (`i04`–`i12`): it refuses delimiter-bearing labels, `LIKE`
metacharacters, `ttl: 0`, unrecognised operators, empty membership lists, and
`maxDepth` combined with paging; it confines prefix results to the path boundary
by comparing label arrays element-wise; and its allow-path is proven on all three
operation shapes rather than only on `put`.

**But containing them is not the same as being suitable.** The architecture needs
lexical full-text, explicit scope and validity columns, per-row model and version
for resumable partial reindexing, bitemporal supersession, and transactional
multi-chunk ingestion. The Store offers none of those, its index configuration is
immutable after first setup in a way that is silent, and the guard needed to make
the rest safe is larger than the schema it would be guarding. **The memory index
becomes app-owned.** The vector index is already classed *derived and
rebuildable*, so this costs no migration.

## Architecture impact

`PostgresSaver` remains the checkpointer. One load-bearing decision changes and
four safeguards become mandatory.

1. **One writer per thread.** At most one worker may invoke a given `thread_id`,
   enforced by a per-thread PostgreSQL advisory lease held on a dedicated
   checked-out client. A refused worker executes no node and is recorded
   `awaiting_resource`. Added to
   [02-control-plane.md](../02-control-plane.md).
2. **One migrator.** Vendor migrations run under an advisory lock held on its own
   session, never through the application pool, and runtime components are
   constructed with lazy setup disabled. Added to
   [06-storage-and-backup.md](../06-storage-and-backup.md) and P1.
3. **Compatibility refusal before invocation**, including normalised per-node
   body fingerprints — name and channel sets are insufficient. Added to
   [09-data-model-and-lifecycle.md](../09-data-model-and-lifecycle.md).
4. **An `error` listener on every pooled client**, without which a database
   failure kills the process instead of rejecting the call.
5. **Run status derives from the runtime's own event log**, never from the
   orchestrator's return value.
6. **Approval identity includes the raising namespace**, and raw `__interrupt__`
   rows are historical rather than a pending queue.
7. **Retention is a per-namespace reachability sweep** with the delete order
   writes → checkpoints → blobs.
8. **The memory index is app-owned**; `lg_store` leaves the production schema
   layout. Recorded in [04-memory-system.md](../04-memory-system.md) and
   [06-storage-and-backup.md](../06-storage-and-backup.md).

The P4 exit criterion required a run to survive a **full stack restart**. The
database half is now discharged — killed three ways and both containers replaced
on a preserved volume. **The host half is not**, and carries forward unchanged.

## Limitations

This spike does **not** establish:

- **Host, WSL, kernel or Docker-daemon reboot.** Containers were torn down while
  the daemon, the kernel and the host page cache stayed alive. The volume never
  left the running daemon. None of this may be cited as host-reboot evidence.
- **Replication, failover, promotion or split-brain.** One stateful service, one
  volume, no HA.
- **Backup and restore.** No snapshot was taken or restored; the restore matrix
  and the idempotency-ledger reconciliation step are untested.
- **Race freedom.** 17 bounded cases at **n = 3**. An outcome that did not appear
  is unsampled, not impossible. Outcomes that remain source-possible and
  unsampled are recorded as such.
- **Throughput, latency, pool sizing or prune cost.** The harness records
  duration *classifications*, never milliseconds, so contention is never inferred
  from elapsed time. `d18`'s hang is a classification, not a measurement.
- **Semantic quality of embeddings.** Frozen 8-dimensional fixtures with
  hand-authored orderings. Nothing here measures recall, HNSW build cost or index
  quality at scale.
- **Pruning below one level of nesting.** Per-namespace retention is measured for
  a depth-one subgraph; deeper topologies were not swept.
- **Production database posture.** `trust` auth on a gateway-less throwaway
  network with a stock, unhardened PostgreSQL container. The database container
  is deliberately not held to the worker posture, because the official image
  starts as root to fix `PGDATA` ownership before dropping privileges.
- **Vendor-supported Store instrumentation.** `PostgresStore` builds its own pool
  and accepts no injection point, so the harness reaches it through the compiled
  artefact's erased `private`. Fail-closed, but not a supported API.
- **apt reproducibility.** Only the two image digests and the npm lockfile
  constrain the environment.

Every statement labelled *source* above was read from the installed `dist` and
source maps at the pinned version. Source-derived behaviour is a prediction, and
each one here is paired with a measurement; none of it is vendor documentation.
The effect key, the compatibility manifest, the lease and the retention sweep are
**architecture** constructs — the package promises none of them.

The full source-derived contract, every superseded claim with its correction, and
all 24 harness defects found by executing the harness are in the
[working record](./06-postgres-checkpointer-concurrency-appendix.md). Where the
two disagree, this report is current.

## Reproducing

```bash
./spikes/postgres-checkpointer-concurrency/verify-concurrency.sh            # 3 repeats
./spikes/postgres-checkpointer-concurrency/verify-concurrency.sh --family F # one family
./spikes/postgres-checkpointer-concurrency/verify-concurrency.sh --cleanup  # and remove volumes
```

Requires `docker` and `jq`. The build phase has network access; every measurement
runs on a gateway-less internal network with no published ports, and the workers
prove their own isolation by attempting a real outbound TCP connection **and** a
DNS resolution and recording both errnos — a timeout is deliberately not treated
as isolation.

Any of `--lane`, `--family`, `--only`, or fewer than three repeats makes a run
non-final: it writes `evidence.subset.json`, never `evidence.json`, so nothing
can cite a subset by citing the canonical filename.

Evidence lands in `tmp/spikes/postgres-checkpointer-concurrency/<run-id>/`, which
is git-ignored. Only run id `frozen-v5` is cited by this report; earlier sets in
the same tree used superseded acceptance contracts, or stopped on a harness
fault, and are not this result.
