# LangGraph durability spike harness

Throwaway P0 code. It exists to answer one architectural question, not to ship.
Findings live in
[`architecture/spike-reports/05-langgraph-durability.md`](../../architecture/spike-reports/05-langgraph-durability.md).

**Status: answered, pass (scoped).** Run `final`: 16 cases across 3 isolated
repeats, 48/48 acceptance criteria, one managed digest
`d5aa45b71b6b0cafc73ef9de30ea274add6d74e8ccfdf2645200a9b6dc38873a`, zero
sanitization violations. The scope is part of the result — crashes were frozen at
checkpoint boundaries, Postgres never died, and one worker ran at a time. Earlier
run ids in `tmp/` used superseded acceptance and canonicalisation contracts and
are not the result.

## The question

> Kill the process mid-run and mid-interrupt; does it resume correctly?

No model, no provider, no credential. The only external system is Postgres.

## The tautology this harness is built to avoid

The graphs are deterministic. A process that ignored every checkpoint and
replayed the whole run from the original input produces a **byte-identical final
state**. So final-state equality cannot be the measurement — it is satisfied
just as well by the failure mode.

Every claim is therefore anchored to something a replay cannot fake:

```text
execution counts     an independent probe, on its own connection, in autocommit
checkpoint lineage   raw SQL against lg_checkpoints, never getState()
write attribution    task ids and channels in checkpoint_writes
process identity     a nonce minted at import and never written to any channel
kill evidence        docker wait / inspect, plus an ABSENT shutdown-handler row
```

The `fake-resume` case exists to demonstrate the point empirically: it finishes
with `done: "finished"` exactly like a genuine resume, and only the execution
witness separates them.

A second rule follows from the first: **no criterion may pass on missing data.**
`[].every(...)` is `true` and `undefined !== false` is `true`, so a check written
the obvious way turns "never measured" into "measured clean". Every criterion
requires its evidence to exist — the expected package count, the exact case set,
a measured egress result, a derived container posture — and the two cross-repeat
claims are refused outright when there are fewer than two repeats to compare.

## Why the probe is not an idempotency ledger

`spike_probe.event` has no unique constraint and suppresses nothing. Every
execution of every node is recorded, including the replays the engine is
*supposed* to perform. Deduplicating there would erase the finding.

Two properties make it a valid witness:

1. It is written on a connection the graph does not own. A probe row therefore
   survives a checkpoint that never commits — if it shared the checkpointer's
   transaction, re-execution would be atomic with the checkpoint and
   structurally unobservable.
2. Nothing it records is a graph state channel, so it cannot be restored from a
   checkpoint and mistaken for a fresh execution. A "times this node ran"
   counter living in state reads back its pre-kill value after a resume and
   shows no re-execution even when re-execution happened.

## Three graphs, three claims

```text
sequential   START → seed → work → finish
             seed commits; work records an effect then parks; kill; resume

parallel     START → seed → {fast, blocked} → finish
             fast's write lands durably; blocked parks; kill; resume

interrupt    START → seed → approval[interrupt()] → finish
             pause on a real interrupt; kill the paused process; resume
```

They are deliberately not merged. In one combined graph a pending-write failure
and an interrupt failure would be indistinguishable, and the fan-out semantics
would be coupled to the interrupt semantics.

Each case gets its own thread; each repeat gets its own database.

## The kill is anchored to database state

Never to a sleep. The node records a `parked` row and blocks on a latch; the
driver polls for the condition, freezes the raw pre-kill projection, captures
the container's host PID **before** the kill, and only then sends the signal.

```text
docker kill --signal=KILL   →  docker wait must return 137
                            →  State.Status == exited, OOMKilled == false
                            →  no `graceful-sigterm` probe row
                            →  resume nonce and container differ from primary's
```

The absent shutdown row is the sharpest of these: a caught exception or a tidy
exit would leave it behind. The `sigterm` case proves the witness can fail by
producing exactly that row.

## Durability mode is the load-bearing setting

The pinned release defaults to `async`, and its own documentation admits the
crash window. `sync` is the only mode with a bounded, testable one:

| Mode | Behaviour under a mid-run SIGKILL |
|---|---|
| `exit` | nothing is written mid-run; the whole run is lost |
| `async` | the next node starts while persistence is still pending |
| `sync` | the next node does not start until the superstep is durable |

`gate-sync` and `gate-async` hold the first superstep's `put` and `putWrites`
open with a wrapper saver — modelled on the upstream `durability.sync.test.ts` —
and observe whether the scheduler dispatches the next node. `async-crash` then
kills the process while the write is still held, so the loss window is measured
rather than raced.

The gate is armed **only on the process about to be killed**. Left armed on a
resume it would hold that run's own persistence open forever, and because
nothing else keeps a handle alive the process would exit *silently with code 0* —
a green container that measured nothing. The driver treats "exit 0 with no
JSON" as a fault for the same reason.

## Running it

```bash
./verify-durability.sh                  # 3 isolated repeats
./verify-durability.sh --repeats 1      # single measurement
./verify-durability.sh --only seq-crash # iterate on one case (NOT a result)
./verify-durability.sh --cleanup        # remove volumes and image afterwards
```

The build phase has network access. Every measurement phase does not:

```text
--network <internal, no gateway>   --read-only   --tmpfs /tmp
--cap-drop ALL   --security-opt no-new-privileges
--memory 512m   --pids-limit 256
no published ports   no credential mount   no source mount   unprivileged user
```

Isolation is **measured, not asserted**, and so is the posture. Every container
attempts a real outbound TCP connection *and* a DNS resolution and records both
errnos, while Postgres remains reachable on the internal network. A timeout is
deliberately not treated as isolation — a slow-but-open network would then read
as a pass — so only an explicit unreachable/refused errno counts.

The `read_only`, capability, port, mount, user and limit claims in the evidence
are read back out of `docker inspect` for every killed worker and asserted as
acceptance criteria. They were prose in the first version of this harness, which
made them satisfiable by editing the driver's own output.

Node is PID 1 by exec form, with no shell wrapper and no init. A `sh -c` wrapper
or tini would make something else PID 1, and `docker kill` would then be
signalling a process other than the one under test.

## Database posture

`trust` authentication on a gateway-less internal network, stock entrypoint,
private per-repeat volume, no published port. That is a deliberate
throwaway-harness decision: it avoids manufacturing a fake credential and avoids
the Compose secret-ownership trap that cost spike 02 a full run. **It
establishes nothing about how the production stack should provision a database
password**, and the database container is not hardened to the runtime's
standard.

Only `main.ts setup` calls the checkpointer's `setup()`, once per repeat. Read
from source and **not measured here**: its migration loop is a
read-then-DDL-then-insert sequence with no advisory lock, so racing it is a
concurrency question — which belongs to the sibling Postgres checkpointer spike,
not to this one. Nothing in this matrix exercises it.

The database volume is kept by default and is a `trust`-auth database. Removing
it is a named step in the driver's own output, not something to leave to habit.

## Evidence

```text
tmp/spikes/langgraph-durability/<run-id>/
  build.log
  cases.json                     the matrix, read out of the image
  repeat-<n>/
    setup.json                   schema + server version + egress
    <case>/
      await.json                 the frozen pre-kill projection
      primary.log                docker logs of the killed container
      primary-inspect.json       exit code, OOMKilled, status, host PID
      mutate.json                only for the deliberate-corruption controls
      run.json                   the control or resume container's emission
      case.json                  the assembled bundle
    bundles.json
    run.json                     acceptance map + managed digest
  digest-<n>.txt
  acceptance-<n>.json
  repeat.diff                    only when repeats disagree
  scan.json
  evidence.json
```

Containers write no files. Each prints one JSON object; the driver owns all
persistence. The acceptance map is computed by the pinned image from the
collected bundles, so the claims and the code that makes them stay on one
version and the driver stays a dumb executor. The only criteria the driver
contributes are the two cross-repeat facts it alone can see, and they are named
as driver-side in the report.

Bundle lists are built from the selected case matrix, never from a directory
glob, and the run directory is refused if it already exists and is non-empty —
otherwise a stale case from an earlier `--only` run could silently join a later
result.

`evidence.json` is composed as a candidate, scanned as part of the run directory,
and promoted only after its own bytes come back clean. Scanning before composing
it — as the first version did — certified a file that had not been written yet.

Genuinely volatile identifiers — checkpoint ids, task ids, and LangGraph's own
interrupt id — become rank markers rather than being dropped, so their
*relationships* are still compared. Everything else is compared literally,
including channel versions and a database-computed hash of every write and blob:
a value that changes must change the digest.

Three things had to be got right for that to hold, and each was a real defect
found by auditing the first passing result:

- **Channel versions are not volatile.** They are deterministic integers in a
  `TEXT` column. Ranking them away would have let a version *regression* produce
  an identical digest, and ordering them as text puts version 10 before version 2.
- **Parallel sibling task ids are derived from the checkpoint id**, which is a
  fresh UUID per run, so sorting writes by task id makes *which branch comes first*
  non-deterministic. Tasks are therefore ordered by a content signature. That is
  normalising an unordered set — LangGraph guarantees no ordering between
  parallel branches — not hiding an ordered difference.
- **The interrupt payload contains LangGraph's interrupt id**, a hash over a
  namespace carrying a per-run task uuid. Its bytes are excluded from the write
  hash and the payload is instead compared in canonical form, with the id ranked
  and the meaningful value literal.

For the same reason the graph's per-raise marker is the probe's stage label
rather than a random UUID: it is persisted inside a checkpoint, so a random value
would make every repeat differ in order to prove something the stage label
already proves — a re-raise on the resume would carry `:resume`.

Arrays whose order *is* semantic are never sorted or deduplicated during
comparison.

## Exit semantics

A reproducible negative is a valid spike result. A broken harness is not.

| Code | Meaning |
|---|---|
| `0` | every acceptance criterion held in every repeat |
| `1` | **measured negative** — a complete, trustworthy measurement disagreed |
| `2` | usage error |
| `3` | **harness fault** — the measurement cannot be trusted |
| `4` | sanitization violation; evidence quarantined |

Failed state is preserved and named. Successful state keeps its database volume
unless `--cleanup` is passed. Killed worker containers are never launched with
`--rm`: that would remove the container the instant the signal lands, taking
`docker logs` and `State.ExitCode` with it — the two artefacts that prove the
kill happened.

## Pinned inputs

See [`fixtures/manifest.json`](./fixtures/manifest.json) for integrity hashes.

| Input | Pin |
|---|---|
| Base image | `node:24.6.0-bookworm-slim@sha256:9b741b28…d9edff` |
| Database | `pgvector/pgvector:pg17-bookworm@sha256:cf134a76…f8e6f` |
| Orchestrator | `@langchain/langgraph@1.4.13` (source `3609b350…`, `libs/langgraph-core`) |
| Checkpointer | `@langchain/langgraph-checkpoint-postgres@1.0.5` (source `6530ba9b…`) |
| Base checkpoint | `@langchain/langgraph-checkpoint@1.1.5` |
| Core / driver | `@langchain/core@1.2.9`, `pg@8.16.3` |

`package-lock.json` is committed and installed with `npm ci --ignore-scripts`.
The published checkpointer tarball's embedded `sourcesContent` is byte-identical
to the tagged source, so the source tag explains the installed bytes rather than
merely accompanying them.

## Deviation from the approved plan

The plan named a `compose.yaml`. This harness uses raw Docker primitives
instead — `docker network create --internal`, one named volume and Postgres
container per repeat, and every worker launched directly by immutable image id.

That is a deliberate substitution, not an omission. Compose one-off containers
get generated names that `compose ps -q` does not list, which makes them awkward
to target with `docker kill`; a Compose project can be silently adopted; and
`POSTGRES_PASSWORD_FILE` is honoured only on first init, so a surviving volume
turns a stale-state bug into an auth bug. Naming and killing each container
directly removes all three.

## Known limitations

- **Every kill is latch-frozen at a named boundary.** The process is parked on a
  database latch when the signal lands, which is what makes the window
  deterministic — but it means no kill lands *inside* a checkpoint commit, inside
  the checkpointer's put chain, or between a write and its checkpoint. These are
  results about crashes at checkpoint boundaries, not about arbitrary crashes.
- **Write atomicity is inherited, not measured.** The killed node parks before
  returning, so it never reaches `putWrites`; and the checkpointer commits each
  write batch in one transaction. The spike shows the killed node contributed
  nothing — not that a partial write was rolled back.
- **Durability semantics are undocumented in the pinned release.** The contract
  was read from source and from the release's own
  `libs/langgraph-core/src/tests/durability.sync.test.ts`. Cite source, not docs.
- **The async crash window is held open by a wrapper**, not sampled from a real
  disk race. What is measured is the consequence — the next node ran, no loop
  checkpoint landed, and the resume replayed the lost superstep — not how often
  that window is hit in practice.
- **At-least-once, not exactly-once.** The probe establishes that node effects
  repeat across a crash. Suppressing that repeat is the application's
  idempotency ledger, which is out of scope here.
- **Single worker.** Nothing about two processes resuming one thread, `.setup()`
  races, the Store, subgraph namespaces, pool sizing, retention, or blob
  reachability under pruning. That is the sibling Postgres checkpointer spike.
- **Postgres never dies.** Only the runtime is killed. A database restart or a
  host reboot is untested.
- **No compatibility-manifest case.** Resuming a thread against a *changed*
  graph would need a second compiled graph and a refusal-shaped expected
  outcome, which is incompatible with a matrix whose assertion is "final state
  equals the golden".
- **apt packages are not pinned** — only the two image digests and the lockfile.
