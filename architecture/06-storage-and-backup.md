# Storage and Backup

Five stores, each with one job. The failure mode to avoid is a single store
doing three jobs badly.

| Store | Holds | Canonical? | Backup |
|---|---|---|---|
| PostgreSQL + pgvector | Checkpoints, runs, events, approvals, memory index | Yes, for execution | Snapshot |
| Obsidian vault | Markdown knowledge | Yes, for knowledge | Git + archive |
| Artifact CAS | Large immutable blobs | Yes | Incremental sync |
| Run archives | Completed run logs | Yes, for audit | Immutable upload |
| Vector index | Embeddings, HNSW | No, derived | Rebuild |

## PostgreSQL

One stateful service. Chosen because it is the only option that satisfies
checkpoints, concurrency, full-text, vector search, and transactional
integrity at once.

The official LangGraph Postgres packages provide both a checkpointer and a
store with pgvector-backed search, so the persistence layer is not bespoke.

**Verified, for the checkpointer only.**
[Spike 05](./spike-reports/05-langgraph-durability.md) ran the official
checkpointer unmodified in a non-default schema. Its `setup()` creates exactly
four relations — `checkpoints`, `checkpoint_blobs`, `checkpoint_writes`,
`checkpoint_migrations` — which is the whole vendor-owned footprint to back up
and prune. Under `durability: "sync"`, checkpoint lineage and a completed
branch's pending writes both survived the runtime process being killed, and
channel versions were monotonic per channel across the crash.

The **Store** was never instantiated, and concurrent `setup()`, subgraph
namespaces, pool behaviour, retention, pruning, blob reachability, and database
restart were all out of that spike's scope. They belong to the Postgres
checkpointer spike, which is still open.

Schemas are separated so vendor migrations never collide with ours:

```text
lg_checkpoints    LangGraph-owned: checkpoints, blobs, writes
lg_store          LangGraph-owned: cross-thread store + vectors
app               ours: runs, tasks, events, approvals, schedules,
                        artifacts, memory metadata, idempotency,
                        credentials metadata, migrations
```

Two operational traps to design around now rather than discover later:

**Checkpoint blobs are shared by version, not by checkpoint.** Deleting
checkpoint rows by age orphans or strands blob rows. Retention MUST be a
reachability sweep, not a date predicate.

**Event volume is the growth driver.** `app.events` SHOULD be partitioned by
month so archival is a partition detach rather than a mass delete.

Large values do not go inline. Anything above a conservative threshold is
written to the artifact store and referenced by hash, because every byte in a
channel value is re-serialized into every subsequent checkpoint for that
channel.

## Artifact store

Content-addressed on local disk.

```text
artifacts/sha256/<aa>/<bb>/<full-hash>
artifacts/sha256/<aa>/<bb>/<full-hash>.meta.json
```

Properties that matter:

- Immutable, so sync is trivially incremental and re-upload is a no-op.
- Deduplicated, so repeated tool output costs nothing.
- Two-level fan-out, so no directory or prefix becomes hot.

Write protocol: temp file, fsync, rename, **then** insert the database
reference. An orphan blob is harmless garbage; a dangling reference is
corruption. Deletion runs the same way in reverse.

## Run archives

When a run reaches a terminal state, its events are exported and the hot rows
become eligible for pruning.

```text
archives/runs/dt=YYYY-MM-DD/run_id=<id>/
  events.jsonl.zst        append-order, greppable, crash-tolerant
  events.parquet          columnar, compacted nightly
  manifest.json           hashes, row counts, schema version
```

JSONL is written first because it survives a crash mid-run. Parquet is produced
by nightly compaction, targeting large files rather than thousands of small
ones. Archives are queried in place with an embedded analytical engine — no
restore step for analysis.

## Git

Git carries the vault and the repository. Nothing else.

Excluded by construction: databases and their WAL sidecars, artifacts, archives,
vector indexes, plugin binaries, workspace state, and every `data.json` holding
a credential.

Git is not a backup tool and it is not sync. It is versioned, off-box,
human-legible replication of prose, and it is the disaster-recovery floor: even
with no other backup, a clone plus a reindex reconstitutes the brain.

## Cloud backup

A thin service, not a platform. The node uploads; it does not run infrastructure.

```text
node backup job
      │  shared secret over HTTPS
      ▼
per-user Lambda API           begin · presign · commit · list · restore
      │  presigned PUT/GET     bytes never traverse Lambda
      ▼
private per-user S3 bucket
```

Deployed with the existing SST conventions: per-user stage resolution, a
generated per-stage secret, a private bucket with versioning and lifecycle
rules, and an execution role scoped to put and get on that prefix only — no
delete.

The node holds only the shared secret. It does not hold AWS credentials, which
is what makes unattended hourly backup possible without an interactive SSO
session. SSO remains the deploy and break-glass path.

## Backup cycle

Ordering is the correctness backbone.

```text
1  artifacts          new CAS blobs, conditional put, no-op if present
2  archives           completed runs only
3  database snapshot  consistent online snapshot
4  vault              commit and push, plus a periodic bundle
5  manifest           written LAST
```

A cycle without a manifest never happened. Partial uploads are invisible garbage
a janitor sweeps. Artifacts precede the database so a restored database never
references bytes that did not land.

The manifest records the snapshot identity, vault commit sha, artifact set,
archive hashes, and package versions. **Restore targets a manifest**, not "the
latest of each thing."

Idempotency comes from deterministic keys: content hashes for artifacts, a
per-cycle id reused across retries for everything else. A local upload journal
lets a crashed cycle resume rather than redo.

## Restore

```text
1  fetch manifest, verify checksums
2  restore compose config and pin image digests
3  provision credentials out of band          ← separate ritual, separate key
4  restore database snapshot, verify integrity
5  clone vault, checkout the manifest commit
6  lazy-restore artifacts                     ← biggest RTO win
7  rebuild vector index from the vault
8  reconcile idempotency ledger               in-flight entries become tasks
9  quarantine paused runs whose code fingerprint no longer matches
10 smoke test: one authenticated MCP call, one resumed run
```

Artifacts are restored on demand rather than up front. They are the largest and
least urgent tier, and CAS addressing makes lazy fetch safe.

Credentials are deliberately a separate ritual with a separate key that the
backup principal cannot read. That is what stops "node compromised" from
becoming "everything compromised."

## Testing

An untested backup is a hypothesis.

| Cadence | Test |
|---|---|
| Nightly | Verify manifest checksums and object existence |
| Weekly | Restore the database into a throwaway container, run canary queries |
| Quarterly | Full rebuild on a clean machine from the runbook alone, timed |

The quarterly rehearsal is the only one that finds the missing step, because
the runbook lives in the thing you are restoring.

A heartbeat SHOULD fire on **successful manifest write**, and alerting SHOULD
be on absence. Silent backup failure is worse than none, because it manufactures
confidence.

## Why not DynamoDB

It was the original plan and it is the wrong shape here.

Archived runs are immutable, append-only, and queried analytically — scans and
aggregations, not point lookups on a hot path. That is object storage's native
pattern and DynamoDB's worst. There is no serving workload to justify the
schema design, and item size limits collide with large payloads.

It would become the right answer if a hosted, low-latency, multi-region read
path appeared. That is not this system.

## Open questions

- Whether the vault also gets a snapshot-based backup or Git alone suffices.
- Retention horizon for events and archives, given no-delete is unbounded cost.
- Whether the backup service is per-user only or gains a shared team stage.
- Whether object-lock retention is enabled at bucket creation — a one-way door.
- Whether embeddings are cached as an artifact to make reindex cheap, given
  re-embedding is not guaranteed to reproduce identical vectors.
