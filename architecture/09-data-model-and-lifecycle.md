# Data Model and Lifecycle

## Entities

```text
AgentDefinition ──┐
                  │
Schedule ─────────┼──▶ Run ──┬──▶ Task ──┬──▶ Event
                  │          │           ├──▶ Approval
                  │          │           └──▶ Artifact
                  │          │
                  │          └──▶ CompatManifest
                  │
Credential ───────┘

Memory ──▶ MemorySource ──▶ Event
```

### Run

```text
run_id                ULID, sortable
thread_id             LangGraph thread
agent_definition_id
agent_definition_version
parent_run_id         set when spawned by another run
status
input
final_output
started_at, ended_at
compat_manifest_id
transport_profile     provider, model, transport, profile id
usage                 tokens, requests, cache metrics
failure_code          platform.* or agent_error.*
```

### Task

```text
task_id
run_id
checkpoint_ns         maps to the LangGraph subgraph
parent_task_id
kind                  research | memory | code | tool
status
started_at, ended_at
result_ref
failure_code
```

### Event

```text
run_id, seq           monotonic per run, the ordering key
ts
task_id
type
payload               JSONB; large values externalized
payload_ref           artifact hash when externalized
```

### Approval

```text
approval_id
run_id, task_id
interrupt_id
ordinal               index within the node
node_fingerprint      node name + definition version at raise time
prompt, payload_schema
status                pending | approved | rejected | expired
decided_by, decided_at
decision_payload
decision_hash         what exactly was authorized
```

### Artifact

```text
sha256                primary key and storage path
bytes, media_type
created_at
producing_run_id, producing_task_id
refcount
```

### Memory

```text
memory_id
kind                  fact | decision | procedure | summary | entity
note_path             the Markdown file
git_blob_sha          the version this record describes
scope
confidence
valid_from, valid_to          when the claim was true
created_at, superseded_at     when we learned or revised it
supersedes_memory_id
source_run_ids[]
embedding_model, embedding_version
```

### Idempotency ledger

```text
effect_key            hash(run, ns, parent_checkpoint, task, ordinal,
                           tool, canonical_args)
status                in_flight | succeeded | failed
result_ref
provider_request_id
first_seen, last_seen, attempt_count
```

This table is canonical and not rebuildable. It is also the record most often
omitted from designs of this shape.

## Run state machine

```text
        queued
           │
           ▼
    ┌── running ──┐
    │      │      │
    │      ├──────┴──▶ awaiting_input        human decision
    │      ├─────────▶ awaiting_resource     vault or workspace lock
    │      └─────────▶ awaiting_schedule     durable timer
    │      ▲                │
    │      └────────────────┘
    │
    ├──▶ succeeded
    ├──▶ failed
    └──▶ cancelled
```

Invariants:

- Terminal states are terminal.
- Every transition writes an event before it takes effect.
- `awaiting_*` states have no default timeout; they end on an external signal.
- A cancel request is durable and survives a restart mid-transition.

## Approval lifecycle

```text
node raises interrupt
        │
        ▼
approval created         ordinal + node fingerprint recorded
        │
        ▼
surfaced                 UI, MCP, A2A — all from the same row
        │
        ├── approved ──▶ resume with decision payload
        ├── rejected ──▶ resume with rejection, or fail the run
        └── expired  ──▶ policy: fail or re-ask
```

Before auto-resuming, the runtime MUST compare the stored node fingerprint
against current code. Interrupt matching is positional, so a code change that
adds, removes, or reorders an interrupt makes the stored position wrong. A
mismatch quarantines the run rather than resuming into the wrong branch.

**Verified.** [Spike 05](./spike-reports/05-langgraph-durability.md) killed a
process paused on a committed interrupt; the interrupt remained at the head of
the chain, and a fresh process resumed it with a decision and reached the
uninterrupted terminal state. `decision_payload` MUST be a truthy structured
object — a bare `false` produces no resume write on the pinned release and fails
the invocation.

The quarantine path is **not** verified: no spike has yet resumed a thread
against a changed graph.

## Idempotency

Re-execution is the default, not the exception. It happens on crash resume, on
interrupt resume, on replay, and on fork. A node re-runs from its top every
time.

**Verified.** [Spike 05](./spike-reports/05-langgraph-durability.md) measured a
killed node re-running from its top with its external effect observed twice, and
the code before an `interrupt()` re-running on resume. A node that had already
completed its superstep was **not** re-run, and a fan-out sibling whose pending
write had landed was reused — deleting that write, or resuming with an explicit
`checkpoint_id`, made it re-run. The orchestrator's guarantee is therefore
**at-least-once**, bounded by superstep granularity, and this ledger is the only
thing that turns it into an at-most-once effect.

```text
before an effect
      │
      ▼
compute effect_key
      │
      ├── found, succeeded ──▶ reuse recorded result
      ├── found, in_flight ──▶ do not retry; raise for human reconciliation
      └── not found ────────▶ record in_flight, perform, record result
```

The `in_flight` case is "we do not know whether it happened." Silently retrying
is how a payment gets made twice or a branch gets force-pushed twice. It MUST
surface as a human-resolvable task.

The key deliberately includes the parent checkpoint so a genuine fork re-runs
the effect, while a crash resume does not.

That property is **assumed, not measured.** Spike 05 established that
re-execution happens; it asserted nothing about whether `parent_checkpoint` and
`task` stay stable across a crash resume — and a superstep lost under a
non-`sync` durability mode produces a *different* parent checkpoint, which would
change the key and defeat deduplication entirely. P4 MUST test that `effect_key`
is stable across a crash replay and changes across a genuine fork before this
ledger is relied on.

## Retention

| Data | Hot | Then | Finally |
|---|---|---|---|
| Checkpoints, active runs | Indefinite | — | — |
| Checkpoints, completed runs | 30 days | First/last/interrupt only, 180 days | Archive only |
| Events | 7–30 days in Postgres | Partition detach to archive | Object storage |
| Artifacts | Indefinite locally | Cold tier | Never expire without a tombstone |
| Archives | — | Object storage | Policy horizon |
| Memory | Indefinite | Superseded, not deleted | — |
| Vector index | Live | — | Rebuilt, never archived |
| Credentials | Live | Rotated | Never in backups in plaintext |

Two rules that are easy to get wrong:

- **Checkpoint pruning MUST be reachability-based**, because blobs are shared
  across checkpoints by version. A date predicate strands or orphans them.
- **Audit outlives execution.** If archives must survive longer than
  checkpoints, they need independent retention, and pruning must emit
  tombstones.

## Deletion

A deletion request has to cover everything derived from the thing being deleted:

```text
raw events · derived memories · summaries · vault notes · Git history
· embeddings · full-text index · checkpoints · archives · artifacts
· cached prompts · backups
```

A tombstone MUST be recorded so asynchronous indexers cannot recreate erased
content from a source they have not yet processed.

Git history is the hard case. Removal means history rewriting, which is
expensive and incomplete. This is why prevention — redaction at extraction, and
a policy on what may enter the vault at all — is the real control.

## Compatibility

Every run records what it ran under:

```text
CompatManifest
  run_id
  app_git_sha
  agent_definition_version
  node_name_set_hash        the graph's node names
  state_key_set_hash        the graph's state keys
  checkpoint_format_version
  package_versions          orchestrator, checkpointer, core
  transport_profile_id
```

On restore or after a refactor, comparing the hashes answers "can this paused
run still be resumed?" before failing mid-node. LangGraph does not persist
topology and applies current code to every thread, so this is the only thing
standing between a refactor and an unrecoverable interrupted run.

No spike has resumed a thread against a changed graph, so the refusal this
manifest exists to trigger is designed rather than proven.

## Classification

| Class | Meaning | Examples |
|---|---|---|
| Canonical | Irreplaceable | Checkpoints, vault, events, memories, idempotency ledger |
| Operational | Reconstructible with effort | Leases, retries, schedules, run index |
| Artifact | Large immutable | Tool outputs, files, prompt snapshots |
| Derived | Rebuildable | Vector index, full-text index, branch index |
| Cache | Free to lose | Node cache, model cache |
| Secret | Never backed up in plaintext | Tokens, keys |
| Disposable | No restore obligation | Stream deltas, untracked channels, workspace state |

Backup scope follows the class, not the store. Getting this table right is what
makes the restore matrix in
[06-storage-and-backup.md](06-storage-and-backup.md) tractable.

## Open questions

- Whether forks are branches within a thread or new runs seeded by copy, which
  changes what the idempotency key must include.
- Whether events are pruned by age or by run completion plus a grace window.
- How long `in_flight` idempotency entries wait before escalating.
- Whether memory supersession is ever hard-deleted, and under what policy.
