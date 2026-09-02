# Spike 05 — LangGraph Durability

**Outcome: pass, scoped.** With the official Postgres checkpointer and an
explicit `durability: "sync"`, a single-worker run survived a real `SIGKILL` at a
checkpoint boundary and resumed **in a fresh container** from persisted state
alone — reproducing the uninterrupted final state, skipping the node that had
already completed, reusing a sibling branch's durable pending write, and
recovering a committed interrupt that outlived the process holding it.

**The scope is part of the result.** This spike does **not** establish crashes
inside a checkpoint commit, database or host failure, full-stack restart,
concurrency, the LangGraph Store, subgraph namespaces, effect-key stability, or
compatibility-manifest refusal. See [Limitations](#limitations).

One correction is load-bearing and belongs in the design documents rather than in
a footnote: **the pinned release defaults to a durability mode that loses the
in-flight superstep on a crash.** Every runtime invocation must set
`durability: "sync"` explicitly.

## Question

> Kill the process mid-run and mid-interrupt; does it resume correctly?

Operationalised precisely, because the phrasing is looser than what was measured:

- **Mid-run** means `SIGKILL` while a node is parked *after* an independently
  witnessed external effect and *before* it returns its state update.
- **Mid-interrupt** means killing a process that is already paused on a
  **committed** dynamic `interrupt()`. No kill landed inside the act of
  persisting an interrupt.
- Every kill is anchored to observed database state, never to a sleep.

## Environment

| | |
|---|---|
| Host | Linux, WSL2, x86_64 |
| Docker | Engine 29.0.0 |
| Run id | `final`, 3 isolated repeats, 16 cases |
| Runtime image | `sha256:c2758182550474d8a0fd124832ddfc3c111e26de1b9bf657152670d97b856e2c` |
| Database | PostgreSQL 17.11 (Debian 17.11-1.pgdg12+2) |
| Harness | [`spikes/langgraph-durability/`](../../spikes/langgraph-durability/) |

Immutable inputs, verified at run time against the installed package, the
committed lockfile, **and** the fixture manifest — all three must agree:

| Input | Pin |
|---|---|
| Base image | `node:24.6.0-bookworm-slim@sha256:9b741b28…d9edff` |
| Database image | `pgvector/pgvector:pg17-bookworm@sha256:cf134a76…f8e6f` |
| Orchestrator | `@langchain/langgraph@1.4.13` (source `3609b350…`, `libs/langgraph-core`) |
| Checkpointer | `@langchain/langgraph-checkpoint-postgres@1.0.5` (source `6530ba9b…`) |
| Checkpoint base | `@langchain/langgraph-checkpoint@1.1.5` |
| Core / driver | `@langchain/core@1.2.9`, `pg@8.16.3`, `zod@4.5.4` |

The published checkpointer tarball's embedded `sourcesContent` is byte-identical
to the tagged source, so the source tag explains the installed bytes rather than
merely accompanying them.

No model, no provider, no credential. The only external system is Postgres.

## Method

```bash
./spikes/langgraph-durability/verify-durability.sh      # 3 isolated repeats
```

### The tautology this experiment is built to avoid

The graphs are deterministic. A process that ignored every checkpoint and
replayed the whole run from the original input produces a **byte-identical final
state**. Final-state equality therefore cannot be the measurement — it is
satisfied just as well by the failure mode.

Every claim is anchored to something a replay cannot fake:

```text
execution counts     an independent probe, on its own connection, autocommit
checkpoint lineage   raw SQL against lg_checkpoints, never getState()
write attribution    task ids and channels in checkpoint_writes
process identity     a nonce minted at import, never written to any channel
kill evidence        docker wait 137 + an ABSENT shutdown-handler row
```

The probe deliberately has **no** unique constraint and suppresses nothing: it
records the replays the engine is supposed to perform. It runs on a connection
the graph does not own, so a probe row survives a checkpoint that never commits;
if it shared the checkpointer's transaction, re-execution would be atomic with
the checkpoint and structurally unobservable.

### Three graphs, three claims

```text
sequential   START → seed → work → finish
parallel     START → seed → {fast, blocked} → finish
interrupt    START → seed → approval[interrupt()] → finish
```

Kept separate on purpose: merged into one graph, a pending-write failure and an
interrupt failure would be indistinguishable. Each case gets its own thread; each
repeat gets its own database, network, and volume.

### Two containers, because the restart is the measurement

```text
  primary container            resume container
  runs until parked            fresh PID, fresh nonce
  SIGKILL (docker wait 137)    reads only Postgres
        └──── shares nothing but the database ────┘
```

Workers run as PID 1 by exec form with no shell wrapper or init — otherwise
`docker kill` would signal something other than the process under test. Posture
(`read_only`, `cap_drop ALL`, no ports, no mounts, unprivileged) is **read back
out of `docker inspect`** and asserted, not described.

## Acceptance

**48/48**, identical across all three repeats, on one managed digest
`d5aa45b71b6b0cafc73ef9de30ea274add6d74e8ccfdf2645200a9b6dc38873a`.

45 are computed by the pinned image from the collected case bundles; 3 are
driver-side, because they are cross-repeat facts the image cannot see
(`reproducible_across_runs`, `acceptance_stable_across_runs`,
`no_credential_in_evidence`).

| Group | Result |
|---|---|
| Package / lockfile / manifest integrity, egress, PID 1, worker posture | Pass |
| Real `SIGKILL`, killed backend drained, resume in a fresh process | Pass |
| Sequential crash: state, replay boundary, no write at head, single input | Pass |
| Pending writes: completed sibling reused, unfinished branch replayed | Pass |
| Interrupt: survived death, primary nonce carried, resumed once, none pending | Pass |
| Checkpoint lineage intact, channel versions monotonic | Pass |
| `sync` / `async` / `exit` behaviour and consequences | Pass |
| Nine anti-tautology controls | Pass |
| Repeat stability and sanitization | Pass |

Measured at the moment of each kill:

| Case | Checkpoints | Loop checkpoints | Writes at head |
|---|---|---|---|
| `seq-crash` | 3 | 2 | **0** |
| `par-crash` | 3 | 2 | **2** |
| `int-crash` | 3 | 2 | **1** (the interrupt) |
| `async-crash` | 1 | **0** | 0 |
| `exit-crash` | **0** | 0 | — |

Execution counts across both processes (`primary` / `resume`):

| Case | Result |
|---|---|
| `seq-crash` | `seed` 1/0 · `work` 1/1 · `finish` 0/1 |
| `par-crash` | `seed` 1/0 · **`fast` 1/0** · `blocked` 1/1 · `finish` 0/1 |
| `int-crash` | `seed` 1/0 · `approval` 1/1 · `finish` 0/1 |
| `fake-resume` | **`seed` 1/1** — the replay control |

## Findings

### `durability: "sync"` is mandatory, and the default is not it

This is the single most consequential correction. The pinned release defaults to
`async`, and the runtime must never rely on that default:

| Mode | Measured under a mid-run `SIGKILL` |
|---|---|
| `exit` | **Zero** checkpoints existed at the kill; the resume failed with `EmptyInputError`. The entire run was unrecoverable. |
| `async` | The next node was dispatched while persistence was still held; **zero** loop checkpoints landed, and the resume had to replay the lost superstep — `seed` ran again. |
| `sync` | The next node did not start until the superstep was durable. |

The `sync` and `async` scheduler behaviour was measured with a wrapper saver that
holds the first superstep's `put` and `putWrites` open, modelled on the pinned
release's own `durability.sync.test.ts`, and observed over a bounded window
rather than a single event-loop tick.

Two things this does **not** say. The async window was *held open* by the
wrapper, not sampled from a real disk race, so nothing here bounds how often it
is hit in practice. And no crash was performed under `sync` with a `put` in
flight — what was measured is dispatch ordering, not that `sync` has no loss
window at all.

### Resume is at-least-once, and the ledger is therefore load-bearing

The killed node re-ran from its top and its external effect was observed
**twice** on a connection the graph does not own. On interrupt resume, the code
before `interrupt()` ran again and re-raised with a *different* per-execution
marker before the stored decision was applied.

This confirms the architecture's existing rule
([02-control-plane.md](../02-control-plane.md)) as a measurement rather than a
caution: spawning a container before an `interrupt()` spawns two. The
orchestrator provides **at-least-once** node execution bounded by superstep
granularity. Exactly-once is the idempotency ledger's job, and nothing here
substitutes for it.

### Completed work is not replayed — and two controls prove why

`seed` ran once across both processes, and in the fan-out `fast` ran **once**:
its write had already landed as a pending write against the current checkpoint,
so the resumed process reused it and re-ran only `blocked`.

Two controls establish that pending-write reuse is the *cause* rather than a
coincidence of graph routing. Deleting the completed branch's writes at the head
made it re-run; so did resuming with an explicit `checkpoint_id`.

### Resuming with an explicit `checkpoint_id` is a fork, not a resume

Supplying `checkpoint_id` disables completed-task skipping: the finished sibling
re-executed. Ordinary crash resume must therefore pass the same `thread_id` with
**no** `checkpoint_id`. This is easy to get wrong precisely because it looks like
a more specific, safer way to resume.

### A committed interrupt outlives the process holding it

The paused process was killed with the interrupt already durable. A fresh
container rediscovered the same interrupt from Postgres *before being told
anything*, resumed it with a structured decision, and reached the golden terminal
state with no interrupt left at the head of the chain.

The witness is the payload's raise marker, not payload equality: the persisted
interrupt carried the **primary's** marker while the resumed execution generated
a distinct one. Equality alone would have proved nothing, since a fresh run
reaching the same node raises an identical-looking interrupt.

### `Command({ resume: false })` does not reject — it fails

On the pinned release a falsy resume value never becomes a resume write, and the
invocation fails with `EmptyInputError` while the thread stays paused. A
rejection MUST be encoded as a truthy structured payload such as
`{ approved: false }`. This is release-specific behaviour, asserted by error name
so that a release which moves the rejection point fails loudly rather than
drifting under the same prose.

### Final-state equality is not evidence, demonstrated rather than argued

The `fake-resume` control resubmits the original input instead of resuming. It
finishes with `done: "finished"` exactly like a genuine resume — a terminal-output
assertion cannot tell them apart. Only the execution witness (`seed` ran twice)
and the lineage (two `input` checkpoints) separate them.

This is the strongest single artefact in the run, and it is the reason the whole
apparatus is built around counting executions rather than comparing outputs.

### Three canonicalisation defects, found by auditing a passing result

The first version of this harness reported a green board on evidence that could
not have detected certain regressions. Recorded because the same traps apply to
any future comparison layer:

1. **Channel versions are deterministic integers, not volatile.** Ranking them
   away would have let a version *regression* produce an identical digest, and
   ordering them as `TEXT` puts version 10 before version 2.
2. **Parallel sibling task ids derive from the checkpoint id**, which is fresh
   each run — so ordering writes by task id makes *which branch comes first*
   non-deterministic. Tasks are now ordered by a content signature.
3. **The interrupt payload embeds LangGraph's own interrupt id**, a hash over a
   namespace carrying a per-run task uuid. Its bytes are excluded from the write
   hash and the payload is compared in canonical form instead.

### Read from source, not measured

Stated here so it cannot be mistaken for a result: the pinned release's own
documentation omits durability semantics entirely — the contract was traced from
source and from `libs/langgraph-core/src/tests/durability.sync.test.ts`. The
checkpointer's `setup()` is a read-then-DDL-then-insert sequence with no advisory
lock, and each write batch commits in one transaction. Neither was exercised
here; both belong to the Postgres checkpointer spike.

## Architecture impact

No load-bearing decision changes. LangGraph remains the orchestrator, and the
official Postgres checkpointer remains the persistence layer. What the spike adds
is a mandatory operational contract around that choice:

1. **`durability: "sync"` on every invocation**, asserted at startup rather than
   left to call-site convention. Added to
   [README.md](../README.md) as part of the orchestrator decision and to
   [02-control-plane.md](../02-control-plane.md) as a normative subsection.
2. **Ordinary crash resume uses the same thread with no `checkpoint_id`**;
   supplying one is fork/replay semantics.
3. **`MemorySaver` is forbidden outside unit tests** — with it, zero state
   survived process replacement.
4. **Approval decision payloads MUST be truthy structured objects.**
5. **Node re-execution on resume is measured, not assumed** — recorded against
   the existing idempotency rules in
   [09-data-model-and-lifecycle.md](../09-data-model-and-lifecycle.md), together
   with the explicit note that `effect_key` stability across a crash resume
   remains unverified.
6. **The checkpointer's schema footprint is now known** — four relations under
   `lg_checkpoints` — and recorded in
   [06-storage-and-backup.md](../06-storage-and-backup.md). The Store, pruning,
   and reachability remain unverified.

The P4 exit criterion in [10-delivery-phases.md](../10-delivery-phases.md) says a
run must survive a **full stack restart**. This spike killed only the runtime;
Postgres never died. That criterion is explicitly **not** satisfied here and
carries forward unchanged.

## Limitations

This spike does **not** establish:

- **Crashes at arbitrary points.** Every kill was frozen at a named latch
  boundary. No kill landed inside a checkpoint commit, inside the checkpointer's
  put chain, or between a write and its checkpoint. These are results about
  crashes at checkpoint boundaries.
- **Write atomicity.** The killed node parks before returning and never reaches
  `putWrites`; the checkpointer also commits each batch in one transaction. The
  spike shows the killed node contributed nothing — not that a partial write was
  rolled back.
- **Exactly-once effects.** At-least-once was measured. Suppression is the
  application's idempotency ledger, which is out of scope.
- **`effect_key` stability across a crash resume.** The proposed key includes the
  parent checkpoint and task; neither was asserted stable here. P4 must test that
  it holds for a crash replay and changes for a genuine fork.
- **Database or host failure.** Postgres stayed alive throughout. Database
  restart, failover, and host reboot are untested — and so is the P4 full-stack
  restart criterion.
- **Concurrency.** One worker throughout. Nothing about two processes resuming
  one thread, `.setup()` races, pool sizing, or lock contention.
- **The LangGraph Store.** Never instantiated; `lg_store` is entirely unverified.
- **Subgraph namespaces.** Every measured case ran in the root namespace.
- **Retention, pruning, and blob reachability.** No pruning was performed.
- **Compatibility-manifest refusal.** No case resumed against a changed graph;
  the refusal path is designed, not proven.
- **Production database posture.** The harness uses `trust` auth on a
  gateway-less throwaway network with a stock, unhardened Postgres container. It
  establishes nothing about how the production stack should provision a database
  password.
- **Performance.** No latency, throughput, or checkpoint-size figures.
- **Host variance.** Three repeats, one host, one kernel, one Docker daemon.
- **apt reproducibility.** Only the two image digests and the npm lockfile are
  pinned.

### Deviation from the approved plan

The plan named a `compose.yaml`. The harness uses raw Docker primitives instead —
`docker network create --internal`, one named volume and Postgres container per
repeat, and every worker launched by immutable image id. Compose one-off
containers get generated names that are awkward to target with `docker kill`, a
Compose project can be silently adopted, and `POSTGRES_PASSWORD_FILE` applies
only on first init. Naming and killing each container directly removes all three
hazards.

Four characterisation controls were added after the proposal was approved:
`int-false`, `ckpt-id-resume`, `control_same_process_resume_shares_a_nonce`, and
`control_terminal_output_cannot_detect_replay`.

## Reproducing

```bash
./spikes/langgraph-durability/verify-durability.sh            # 3 repeats
./spikes/langgraph-durability/verify-durability.sh --cleanup  # and remove volumes
```

The measurement phase runs on a gateway-less internal network and proves its own
isolation by attempting a real outbound TCP connection *and* a DNS resolution and
recording both errnos; a timeout is deliberately not treated as isolation.

Evidence lands in `tmp/spikes/langgraph-durability/<run-id>/`, git-ignored. The
database volume of each repeat is retained by default — it is a `trust`-auth
database, and the driver prints the command to remove it. `evidence.json` is
composed as a candidate, scanned, and promoted only after its own bytes come back
clean.

Only run id `final` is cited by this report. Earlier runs in the same tree used
superseded acceptance and canonicalisation contracts and are not this result.
