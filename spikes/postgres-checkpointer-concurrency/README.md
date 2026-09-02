# Spike 06 — Postgres checkpointer and Store under concurrency

Throwaway research harness for the last open P0 question in
[`architecture/10-delivery-phases.md`](../../architecture/10-delivery-phases.md):

> Do the official checkpointer and Store behave as documented under concurrency?

It measures the pinned, unmodified `PostgresSaver` and `PostgresStore` from
`@langchain/langgraph-checkpoint-postgres@1.0.5`, and — where the stock behaviour
turns out to be insufficient — a set of deliberately throwaway safeguards run in
their own lanes beside the stock result they are not allowed to replace.

This is a **sibling** of [`spikes/langgraph-durability`](../langgraph-durability)
(spike 05). Audited mechanisms were copied and adapted; nothing is imported from
it, and its frozen evidence and digest are untouched.

## Running it

```bash
./verify-concurrency.sh                   # 3 isolated repeats — the only citable configuration
./verify-concurrency.sh --repeats 1       # a measurement, NOT a result
./verify-concurrency.sh --family S        # one experiment family
./verify-concurrency.sh --lane stock      # one lane
./verify-concurrency.sh --only 's0[24].*' # anchored regex over case ids
./verify-concurrency.sh --cleanup         # also remove the image, on a clean run only
```

Requires `docker` and `jq`. The build phase has network access; every
measurement runs on a gateway-less internal network with no published ports.

Evidence lands in `tmp/spikes/postgres-checkpointer-concurrency/<run-id>/`
(git-ignored).

### Exit codes

Inherited unchanged from spike 05.

| Code | Meaning |
| --- | --- |
| `0` | pass, or pass with required safeguards |
| `1` | a complete, trustworthy measurement disagreed — a valid outcome |
| `2` | usage |
| `3` | harness fault: the measurement could not be trusted |
| `4` | sanitization violation; the evidence directory is quarantined |

`0` covers both "stock behaviour was sufficient" and "stock behaviour has
reproducible negatives but the paired safeguards satisfy the requirement". The
exit code answers *may I trust and cite this run*; the `outcome` object in the
evidence answers *what did it say*. Conflating them would let a
safeguard-dependent pass look like a clean one.

### Non-final runs

Any of `--lane`, `--family`, `--only`, or fewer than three repeats makes a run
non-final. Such a run writes **`evidence.subset.json`** and does not create
`evidence.json` at all, carries `final: false` with the specific reasons, and
omits the cross-repeat criteria rather than reporting them as `false`. Nothing
can cite a subset by citing the canonical filename.

## What the harness is

```
verify-concurrency.sh   the driver: owns Docker and persistence, owns no analysis
src/contract.ts         pins, schema names, timeout ceilings
src/db.ts               four pools per process, each with a declared job
src/probe.ts            the independent execution witness and the harness schema
src/barrier.ts          the N-party rendezvous and its overlap witnesses
src/gate.ts             statement classification and parking, without touching vendor SQL
src/reflect.ts          the single point of vendor-internal access (PostgresStore's pool)
src/inspect/            raw SQL: checkpoints, store, pg_locks/pg_stat_activity, egress
src/store/embeddings.ts frozen deterministic vectors, never an algorithm
src/canonical.ts        scoped rankers, managed digests, prose sanitization
src/cases.ts            the case registry and its structural invariants
src/summarize.ts        acceptance, per-lane digests, oracle-presence enforcement
fixtures/               pinned manifest, embedding vectors, hand-authored rankings
```

Containers write no files. Each prints exactly one JSON object to stdout; the
driver owns persistence. The acceptance map and every digest are computed **by
the pinned image** from the collected case bundles, so the claims and the code
that makes them stay on the same version. The only facts the driver contributes
are the cross-repeat ones, and they are named as such.

## Design decisions that are load-bearing

**One database cluster per family, per repeat.** `CREATE EXTENSION` is
database-scoped, so a Store migration race in family A would pre-create the
extension family D has to race for. Separate clusters also let a failed family's
volume be preserved without holding the others hostage.

**Overlap is proven twice.** Arrival rows are persisted before the release row
exists and ordered by a bigserial, so "all parties arrived before release" is
answerable from the table alone. A second, independent witness samples distinct
attached *parties* while they are parked. Neither alone can distinguish genuine
overlap from a fast sequence, which is why `s03-barrier-serial-control` exists:
it runs the same four participants one at a time and the overlap witness must
fall to one.

**The gate never rewrites SQL.** It replaces `query` on each physical client and
passes `text` and `values` through byte-identically. That is not a promise in a
comment: `s04-gate-passthrough` compares the statement multiset *and* the
statement order of a gated run against an ungated run of the same vendor
operations, and both must match exactly. Any statement the classifier does not
recognise is a fault, because an unrecognised statement makes every gate ordinal
downstream of it unsound.

**A `post` gate fires after the query settles, for rejection as well as
fulfilment.** The cold-schema `SELECT v FROM …_migrations` legitimately raises
`42P01`, and a fulfilment-only gate could never park there — which is exactly the
boundary the setup-race lane needs.

**Lock claims need an edge, never a duration.** A slow statement and a blocked
one are indistinguishable from the client. Every lock claim carries a captured
blocked → blocking edge, cross-checked between `pg_locks` and
`pg_blocking_pids()`, and an edge whose holder cannot be attributed to a
participant is a fault.

**Ranking is scoped, and relations are stated twice.** Comparison *across* a
boundary is itself a result here (restart identity, fork versus resume), so
rankers are created per declared scope and ordinals are assigned by a
deterministic traversal rather than by whoever won a race. Every ranked identity
is accompanied by an explicit boolean — the redundancy is the point, because a
ranking bug and a relation bug are unlikely to agree.

**Some things are never tokenised.** SQLSTATEs, channel versions, channel names,
namespace strings (kept as literal arrays), Store keys, fixture values and
vectors, search result order and scores, row counts, relation names, and
database-computed digests all stay literal. Ranking any of them away would let a
real regression produce an identical digest.

**Race winners are reported by role, not by pid.** Roles are assigned by the
driver before the race, so the winner's identity is managed while the arrival
*order* is volatile — retained verbatim for diagnosis, excluded from the digest.
Deleting it would hide serialisation; digesting it would destroy reproducibility.

**Reflection is fail-closed and isolated.** `PostgresStore` builds its own pool
and accepts no injection point, so `src/reflect.ts` reaches it through the
compiled artefact's erased `private`. A release that renames `core` breaks every
Store instrumentation case loudly rather than silently producing unwitnessed
results. This is a harness limitation, not a vendor-supported API.

**Embeddings are a lookup table, not a function.** Text absent from the fixture
is a hard error rather than a hashed fallback: a fallback would be an algorithm,
and an algorithm sharing logic with the search path under test would make the
ranking oracle circular. The vectors are chosen so cosine, L2 and inner product
rank the same corpus in three *different* orders — if any two agreed, a Store
that silently ignored `distanceMetric` would pass all three.

## Anti-tautology rules

* No criterion may pass on missing data. `[].every(…)` is `true` and
  `undefined !== false`, so every collection criterion asserts a non-zero,
  expected length first, and every declared oracle is verified present in the
  bundle before acceptance is computed.
* A criterion stated only as an absence is stated positively as well. "No gate
  was left unreached" is satisfied by a gate set that fired nothing; the run must
  also show that every declared gate *was* reached.
* Every mechanism has a control that must fail for its own named reason.
* Mitigation lanes are expanded to include their stock pair. Running a
  safeguard without the stock result it is compared against is impossible.

## Families

| Family | Subject | Provisioning |
| --- | --- | --- |
| `S` | harness self-test | bare |
| `A` | setup and migrations | bare |
| `B` | checkpointer concurrency and conflicts | migrated checkpointer |
| `C` | transactions, pools and locks | migrated checkpointer |
| `D` | the full `PostgresStore` surface | checkpointer + Store |
| `E` | subgraph namespaces | migrated checkpointer |
| `F` | retention and blob reachability | migrated checkpointer |
| `G` | database and container-stack restart | migrated checkpointer |
| `H` | effect keys and graph compatibility | migrated checkpointer |
| `I` | mitigation lanes | bare |

Family `A` provisions **bare** on purpose: whether the vendor relations exist
after a concurrent setup is the subject of the experiment, so asserting them at
provisioning time would decide it before it ran. Family `G` runs last in a
repeat, because it replaces the stack it measures.

Family `S` is the self-test. It validates the barrier, the statement gate, the
lock inspector and the embedding oracle against situations whose answers are
known independently of any vendor behaviour. If it fails, no later concurrency
claim is worth anything and the run stops before producing one.

## Preserved state and cleanup

Database volumes hold **trust-auth PostgreSQL clusters with no password**.

A repeat whose evidence held releases its own containers, network and volumes. A
repeat that did not pass keeps all three — including the network, because a
volume with no network left is not inspectable without recreating one.
`preserved.json` is written incrementally as objects are created, so a fault at
any step still leaves a complete inventory, and the terminal output prints the
exact removal commands in dependency order (containers → networks → volumes).

`--cleanup` refuses to run on a failed run: on a run that did not pass, that
state is evidence.

## Limitations

* **No host, kernel, WSL or Docker-daemon reboot.** Family G tears down
  containers while the daemon, the kernel and the host page cache stay alive.
  Nothing here establishes dirty host-page-cache survival, and none of it may be
  cited as host-reboot evidence.
* **No replication, failover, promotion or split-brain behaviour.**
* **No throughput, latency, pool-sizing or prune-cost claims.** The harness
  deliberately records duration *classifications* rather than milliseconds, so
  contention is never inferred from elapsed time.
* **`trust` auth on an isolated network.** A throwaway-harness decision that
  avoids manufacturing a fake credential; it establishes nothing about how the
  production stack should provision a database password.
* **The database container is not held to the worker posture.** The official
  image starts as root to fix `PGDATA` ownership before dropping privileges, so
  posture claims are scoped to the workers.
* **`PostgresStore` instrumentation depends on runtime reflection** into a field
  the type declarations mark `private`. It is fail-closed, but it is not a
  supported API.
* **apt packages inside both images are unpinned.** Only the two image digests
  and the npm lockfile constrain the environment.
* **A safeguard lane proves a mitigation is viable, not that it is the design.**
  Mitigations are throwaway wrappers in this harness; no production runtime
  module is built here.
