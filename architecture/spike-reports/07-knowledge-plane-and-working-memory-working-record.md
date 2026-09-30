# Spike 07 working record: knowledge plane and working memory

Append-only laboratory notebook. Sections are added, never rewritten. A later
correction appends a superseding section and leaves the original in place.

Where this record and the final report disagree, the **report** is current. Where
this record and a conversation summary disagree, **this record** is current: the
conversation is not an evidence store.

**Status:** Stage 1 in construction. No measurement has been produced. Nothing in
this record is a result.

---

## Section 0 — Why this spike exists

The repository's architecture states that Obsidian Markdown is canonical for
long-term knowledge and Postgres is canonical for execution. That rule joined two
requirements that are not the same requirement:

1. Knowledge must be human-inspectable and correctable.
2. Knowledge must be stored as Markdown.

If the system will eventually provide a control surface for human-in-the-loop
work, inspection and correction can happen there, and (2) stops being implied by
(1). A property graph then becomes a candidate first-class knowledge model rather
than only a disposable retrieval index.

The spike therefore compares two lanes under one contract and one corpus, and
then — holding the winner constant — measures what working memory earns its
complexity. The two stages are separate so storage effects and prompt-governance
effects cannot be confounded.

Planning context that predates this record lived at
`.opencode/plans/knowledge-plane-working-memory-spike/context.md`. That file is
plan-local, not durable, and not included in this repository; everything from it
that still matters is restated here.

---

## Section 1 — Authority map (Step 1, accepted, not yet evidence)

### 1.1 Vocabulary

Six information-authority planes. The existing runtime control plane is an
implementation and security boundary, **not** a seventh plane.

| Plane | Establishes | May propose or report | Must never |
|---|---|---|---|
| Source | Its own external content and revisions | Evidence for local claims | Establish local belief |
| Personal Knowledge | Accepted entities, claims, relationships, provenance, temporal belief history | Candidates for context or publication | Treat custody as truth |
| Active Context | Nothing; a bounded persisted view | Verified observations back to reconciliation | Promote itself or rewrite Canon |
| Coordination | Only "publisher P reported X at T" | Attributed evidence candidates | Establish the underlying claim |
| Execution | Work-item identity and status, attempts, runs, events, approvals, schedules, idempotency, checkpoints | Observations about execution | Establish semantic knowledge |
| Human Authority | Corrections, conflict decisions, retractions, merges, canonization | Binding decisions applied through commands | Lose the state the human reviewed |

"Working memory" was renamed **Active Context** because the original term
collided with LangGraph checkpoints, which are execution state that happens to
contain messages.

### 1.2 The two-axis rule

Authority is not one property. It is two:

- **Ownership / establishment** — where a fact may become durable truth. A plane
  property.
- **Read trust** — how much a reader should weight a datum. A *per-datum*,
  provenance-derived, read-time property with a caller-supplied floor.

Collapsing them would bake a trust cutoff into storage, which forces one global
standard on every consumer and requires re-ingesting everything when policy
moves. Policy changes more often than data does.

A seventh verb, **custodies**, separates byte custody from fact authority:
LangGraph custodies checkpoints without establishing run success; Postgres
custodies a human decision while the human remains its semantic authority.

### 1.3 Contradictions in the current architecture that Step 1 exposed

These are defects in the existing documents, recorded here and **not yet fixed**.
They must not be silently repaired before evidence exists.

1. **"Canonical" is defined on two incompatible axes.** `06-storage-and-backup.md`
   uses a per-store table with a scalar `Canonical?` column; `09-data-model-and-lifecycle.md`
   uses a per-class taxonomy and then states "backup scope follows the class, not
   the store", which undercuts the table it cross-references.
2. **Artifacts are canonical in one document and a separate class in the other.**
3. **The idempotency ledger is declared canonical and not rebuildable, yet is
   absent from the storage canonicality table**, while a restore step implies
   partial reconstruction of it.
4. **The Postgres `Memory` row duplicates vault frontmatter with no stated
   ownership of the overlap.** `supersedes_memory_id` and `superseded_at` have no
   frontmatter counterpart, so the supersession graph is either canonical only in
   Postgres — contradicting "Markdown is authoritative" — or reconstructible from
   wikilink parsing, which is nowhere stated. This is the sharpest unreconciled
   boundary in the corpus and is precisely what Lane M has to answer.
5. **Run summaries and agent prompts cross the knowledge/execution boundary** the
   same documents call "how both stores rot", with no stated source-versus-
   projection ordering.
6. **"Derived" carries two opposite polarities** — rebuildable-from-canonical
   (lower authority) and computed-from-the-right-source (the authoritative
   answer, as in "run status MUST derive from the event log").
7. **"Control plane", "brain", and "broker" each name more than one thing.**

### 1.4 What this changes about memory layering

Three concerns the current documents treat as one:

```
Execution checkpoint      resumes the machine
Bounded active context    resumes the reasoning and keeps constraints salient
Long-term knowledge       improves future work across runs and projects
```

---

## Section 2 — Prior art and pins (Step 2, retrieved 2026-09-03)

### 2.1 Design references — none is a production dependency

| Project | Revision | Licence | Verdict |
|---|---|---|---|
| `embabel/dice` | `57259b09ec6eebbdba871a497f0b5c3d04d19298` | Apache-2.0 | **Reference.** No tag, no release, `-SNAPSHOT` only on a vendor Artifactory, absent from Maven Central. Kotlin/JVM, `provided`-scope Embabel agent API so it cannot run standalone. Self-labelled incubating. |
| `jimador/arc-mem` | `1999ec67d43c291d0307416872013e173aefa401` | Apache-2.0 | **Reference.** Java 25 with `--enable-preview`, zero published artifacts, pins a DICE snapshot a generation behind current DICE. Repo description: "Anchor test harness and playground". Author's own `status-and-caveats.md` lists uncalibrated trust thresholds and four open credibility blockers. |
| `jimador/brigade` | `c85b1e0ffd784e4da0c060df4f053b0f2ec50e0a` | **None** | **Reference only, blocking legal defect.** No `LICENSE` file; all rights reserved. Concepts may be reimplemented; no text or code may be copied. |
| `multica-ai/multica` | `54e641aaa377905a3c2be3596106cdbf4a9e934a`, release `v0.4.39` | Multica License (Apache 2.0 + commercial restrictions), SPDX `NOASSERTION` | **Reference.** Forbids hosted or embedded commercial use without a commercial licence; branding lock on the UI; attribution plus repo link for backend-only use. Internal single-organization self-hosting is permitted. |

Two disagreements worth carrying forward:

- **Brigade cites ARC-Mem's own ablations to justify deleting rank, trust, decay,
  and tiering** ("every ARC-enabled condition scored within ~1.6 resilience
  points regardless of which governance subsystem was removed, while the
  no-governance baseline dropped ~19"). ARC-Mem presents the same machinery as
  load-bearing. This is unresolved and must **not** be imported either way: it is
  exactly the confound Stage 2's W1/W1A/W2/W3 design exists to settle.
- **Neither DICE nor ARC-Mem has temporal validity.** ARC-Mem states DICE
  propositions have no `validFrom`/`validTo` and that adding it is "real state
  machine complexity". The bitemporal requirement here has no reference
  implementation to lean on.

### 2.2 Runtime pins (executable dependencies)

```
node:24.6.0-bookworm-slim
  @sha256:9b741b28148b0195d62fa456ed84dd6c953c1f17a3761f3e6e6797a754d9edff
pgvector/pgvector:pg17-bookworm
  @sha256:cf134a767f474095eeba57e0117be8e568e011a63f33fbf252f14c9b760f8e6f
neo4j:2026.07.1-community-ubi10
  @sha256:4c470275ab23a8a330d302ca98d3d440cd4b09d71b3fa3c05144999e5d9b241d
alpine/git:v2.49.1
  @sha256:c0280cf9572316299b08544065d3bf35db65043d5e3963982ec50647d2746e26
nginxinc/nginx-unprivileged:1.29.1-alpine
  @sha256:27985295bdb22a1ef8f712863210bd5877c0f3006494a593e86b3fe0fa55467e

Obsidian 1.13.7                      (existing spike 01 artifact hashes)
MCP Connector 2.4.0, MIT             (existing spike 01 artifact hashes)
neo4j-driver 6.2.0, Apache-2.0
  sha512-9W/Tk7EyjZHtv87NFpqoIbl0mlQx8bX8phUFzAM9xmeJrRpGDvqkpdQzc11DjwzywQCdhifaZPSvokSnAp7YTg==
pg 8.16.3 · zod 4.5.4 · typescript 6.0.3   (spike 06 pin set)
```

Neo4j Community is **GPL-3.0** and is reached only over Bolt as a separate
process; no Neo4j code is linked or redistributed. Usage reporting is disabled
explicitly, and the measurement network has no gateway in any case.

### 2.3 Community Edition limits that bite

Unavailable, and therefore each corresponding invariant moves into the command
service and is named in the report: existence constraints, property type
constraints, node and relationship key constraints, graph types (which is
Neo4j's own current recommendation for schema enforcement), RBAC and
property/sub-graph access control, online backup, change data capture, and
multiple user databases.

Consequences already established:

- **CE has one user database**, so per-case isolation needs a fresh container and
  volume rather than a fresh database. That cost belongs to the cost dimension.
- **`neo4j-admin database dump` requires the database stopped on CE.** Every
  canonical backup is a full stop of the knowledge plane. Measuring that downtime
  is a named deliverable and the one place a duration is reported as a number.
- **No CDC**, so projection freshness is a self-assigned watermark rather than a
  change feed — strictly weaker than Lane M's content-derived token.

---

## Section 3 — Native correction surfaces (Step 3)

No native surface in either lane can safely own correction.

**Lane M.** Bases is the strongest native surface and is the only one that is
*writable* across many notes at once, which makes it the triage console. But
Properties cannot nest, Bases has no `from` clause and no relationship editing,
Graph View is read-only and untyped, and Canvas edges are **not vault links** —
they do not appear in backlinks and are invisible to every query tool, so a
labelled canvas edge is a drawing, not a relationship.

Measured from the pinned MCP Connector source rather than its documentation:

- `requireWritePreconditions` **defaults to `false`**. Without it, whole-file
  writes silently overwrite. It must be enabled or hard gate 4 is unevaluable.
- The compare-and-swap is **real**, executed inside `vault.process`, and fails
  with `stale_precondition` — but its whitespace normalisation is narrow
  (CRLF, trailing horizontal whitespace, leading/trailing blank lines only), so a
  reformat-on-save produces spurious conflicts.
- `update_active_file` is an **unguarded** whole-file overwrite; frontmatter
  writes are per-key and unguarded.
- `rename_heading` is **documented as atomic and is not**: it returns
  `partial-failure` with the source heading already renamed and no rollback.
- The string `provenance` occurs **zero** times in the bundle.

**Lane N.** Browser is a credible inspection console and a poor correction
surface: it has **no `:begin`/`:commit`/`:rollback`**, so in Browser the
transaction boundary is the statement boundary. Its access-mode setting is
documented as *not* a security control. With RBAC being Enterprise-only, **CE has
no mechanism that can force an operator through the command contract** — that
requirement is an application invariant plus procedure, not an enforced boundary.

The naive Cypher guard is wrong: `MATCH ... WHERE c.rev = $expected SET ...`
takes no write lock before the read, so two writers can both pass the predicate.
The design therefore uses **append-only revision nodes with a `(claim_id, rev)`
uniqueness constraint**, which is CE-available and makes stale-write rejection
native.

Excluded: **Bloom** (Enterprise plus activation key plus GPU), **Workspace**
(no version, no licence artifact, apparently absorbed into a commercial product),
**NeoDash 2.4.11** (Apache-2.0 but the repo states "no longer maintained", and on
CE its dashboards are stored as nodes **inside the canonical database**).

**Future UI envelope.** Seven capabilities need building because nothing native
provides them: conflict review, correction and retraction, entity merge, temporal
relation editing, provenance inspection, canonization approval, and freshness or
lag. Coarse estimate: **15–30 engineer-days** for freshness, provenance,
correction, and basic review; **45–90** for all seven at usable-not-polished
quality. Cost is dominated by re-verifying backend invariants through a second
entry point, not by pixels.

---

## Section 4 — The shared contract (Step 4)

Version `knowledge/1.0.0`. Implemented at
`spikes/knowledge-plane-working-memory/src/knowledge/contract.ts`, which imports
no store driver, no filesystem, and no network client — checked mechanically as
source text, because an unused import would still be invisible to a runtime check
and is exactly what precedes a lane-shaped contract.

### 4.1 Load-bearing decisions

- **Four lifecycles are distinct and must never collapse:** world progression
  (old revision stays true of its interval), correction (new value answers for
  the *same* interval, prior belief survives only in history), summarisation
  (originals stay true and reachable), retraction (removed from belief, tombstone
  survives). In the implementation the whole distinction is one field on the
  close operation: `narrowValidTo`.
- **Version tokens are opaque, equality-only, and derived from canonical state
  alone**, so Lane M may not mint one from its projection and Lane N may not use
  an element id that would not survive a restore.
- **`applied: yes | no | unknown` is a required response value.** A lane that can
  never produce `unknown` is hiding an unsafe assumption about a boundary it does
  not control.
- **Atomicity is reported honestly, not levelled.** Each command declares the
  class the lane genuinely provides. Lane N's transactional advantage and Lane M's
  multi-file repair burden are measured differences.
- **Peer reports are a distinct type.** No call returns claims and attributed
  reports in one collection, and none may be added. Non-promotion is enforced by
  the type system, not by a filter that could be forgotten.
- **Reinforcement adds evidence and never touches authority, canon, or belief.**
  Laundering authority through repetition is the failure this command exists to
  make impossible.
- **Evidence must terminate in a real source document at write time**, not in a
  later audit: a claim admitted without a usable source is one the system can
  never justify, and auditing afterwards means it was believed in the meantime.
- **Both lanes run the same execution plane.** Work items, attempts, and the
  idempotency ledger are Postgres in both, so the comparison stays about
  knowledge rather than about who owns the ledger.
- **Validation, authority, guards, and lifecycle live in a shared policy module.**
  Only persistence differs. Letting each lane re-implement the rules is how two
  lanes end up compared on two different sets of rules.

### 4.2 Coordination

Wire format `coord/1.0`: JCS-canonicalised JSON, append-only, per-publisher
sequence and hash chain, disjoint publisher namespaces in one Git repository,
fail-closed allowlist sanitisation before hashing or writing. Markdown rendering
is optional, derived, and never read back — deliberately, so the wire format
gives neither lane a free adapter.

Peer text is untrusted data: never concatenated as instruction, never
auto-dereferenced. The only bridge into local knowledge is
`OpenCandidateFromPeerReport`, which stops at `unreviewed`.

---

## Section 5 — Corpus and oracle (Step 5, frozen)

Synthetic "Halyard" corpus. Every domain is `.invalid` or `synthetic://`. No real
person, project, credential, or address.

- 20 entities, 15 sources with documents, 3 work items, 1 peer record.
- **77 mutations** on a deterministic clock (origin `2026-01-05T09:00:00.000Z`,
  60 s per tick), ticks unique and strictly increasing.
- **24 golden queries**, of which 6 require depth three or more. The
  **25% graph-heavy share is declared in the oracle before the run**, so the
  depth mix cannot be tuned after seeing which lane it favours.
- Frozen retrieval vectors over a 12-term vocabulary with graded judgments.
  **`-1` is deliberate**: retrieving a retracted claim or an unpromoted peer
  assertion is not neutral, it is the failure the architecture exists to prevent,
  so it must cost rather than merely fail to score.

Scenario coverage: coding project with requirements/decisions/commits/PR;
research output that stays in Notion; outreach result that stays in an email
thread; two alias merges of different shapes; world progression; a corrected
wrong belief; a summary over three still-valid observations; a temporal
dependency chain with a removed shortcut and a decoy; a peer report whose claim
is false locally but whose output link is genuine; a sensitive candidate refused
before persistence; a human correction and a stale one; a three-attempt handoff
where the new process never sees the earlier transcript.

**Frozen digests**, baked into the image so a regenerated oracle is caught by the
image rather than by the tree that was regenerated:

```
corpus  f0e718233bf3c4ae5dc4fe043819cbfca69e0466ed6a4edcc87a8c0c1376019c
oracle  ef7d18b46f8bc88313a2d2586ba08a778ed600e7b968b08b58ab3c81fc733aa3
```

**Anti-leakage.** The oracle is excluded from the image by `.dockerignore` and is
never mounted into a lane container; it is mounted read-only into a network-less
validator or comparator. There is no snapshot-update path. Expected error codes
live in the oracle and **not** in the mutation script, so a lane cannot read its
expected refusal out of its own input.

**Amendment discipline.** Budget of **5** result-changing amendments across
Stage 1; exceeding it classifies the run a harness fault. An amendment forces a
full regeneration of *both* lanes' evidence. Changes made before any lane
evidence exists are recorded as **authoring changes**, not amendments.

---

## Section 6 — Apparatus and scorecard (Step 6, frozen before implementation)

**Topology.** One Compose project per family per repeat. Every network
`internal: true` and therefore gateway-less; no published ports anywhere. Compose
owns stateful services only; workers are started by the driver with explicit
`--name` so a fault can signal a known container. Worker posture is read back
from `docker inspect` and asserted, never assumed.

**Repeats and workers.** Exactly 3 isolated repeats; acceptance is the
elementwise AND across all three. Four workers for first setup, eight operations
for lazy setup, two independent processes for duplicate creation and stale
update.

**Fault anchors.** Every kill, restart, and stale release fires from a committed
row, an observed lock or wait edge, or an arrival record. **No value in
`TIMEOUTS` is a fault trigger**; every one of them expiring is a harness fault.
Poll interval ≤ 2 s; readiness 180 s, command 15 s, rebuild 300 s, restore 600 s,
all as observed-condition polling.

**Ceilings.** ≤ 12 concurrent containers, ≤ 20 GiB of new volume data, ≤ 4 h wall
clock, **zero live model calls** in Stage 1. A breach stops the run with partial,
non-citable evidence rather than dropping repeats or cases.

**Scorecard**, frozen before implementation:

| Dimension | Weight |
|---|---:|
| Query and retrieval usefulness | 20 |
| Correctness, temporal semantics, provenance | 20 |
| Recovery, portability, auditability | 15 |
| Human correction and future HITL/UI fit | 15 |
| Operational and implementation cost | 15 |
| Concurrency and transactional behaviour | 10 |
| Coordination-plane fit | 5 |

Submetrics score on a discrete `0 / 2 / 4 / 6 / 8 / 10` ladder against **absolute**
thresholds; no submetric may be defined relative to the other lane. Cost and
human-fit inputs are scored with lane labels blinded. Arithmetic is independently
recomputed, boundary-tested, and manually spot-checked.

**Decision rule.** Hard gates decide eligibility *first and in writing*. A winner
requires a point margin ≥ 10.00 of 100 **and** a non-overlapping conservative
bound (winner low minus loser high ≥ 0). Anything narrower is **inconclusive**,
which is a valid research outcome and exits 0. A score never rescues a failed
hard gate. A win by gate elimination is labelled as such.

**Host at time of writing:** Docker 29.0.0, Compose v2.40.3, 62 GiB RAM, 831 GiB
free disk.

---

## Section 7 — The deferred third lane

A relational-canonical design — claims canonical in the Postgres this system
already runs, graph queries served by recursive SQL, Markdown as source documents
and readable export — is **not measured by this spike**.

**It was not considered and rejected. It was never measured.**

This is DICE's actual architecture: propositions are the system of record and the
graph is a materialised view, with graph-shaped queries answered by walking
claims and a native graph used only as an optimisation. The strongest
graph-oriented prior art in the set does **not** make the graph canonical.

Every Stage 1 conclusion must therefore be phrased as *"the better of the two
measured lanes"*, never *"the best canonical model"*. Lane R becomes the
recommended next measurement if both lanes fail a hard gate, if Stage 1 is
inconclusive, or if a fragile cost-only difference decides the result. The neutral
contract is authored so a third adapter needs no contract change; if it ever
does, the contract has absorbed a lane's shape and that is a harness fault.

---

## Section 8 — Implementation status (Steps 9–11, in progress)

Harness at `spikes/knowledge-plane-working-memory/`. Evidence schema
`agent-runtime/spike-evidence/3`; fixture schema `agent-runtime/spike-fixtures/3`.
Both are deliberately uncomparable to spikes 05 (`/1`) and 06 (`/2`).

### 8.1 Built and self-verified

- **Driver** `verify-stage1.sh`: build, hardened network-less workers, image
  identity check, posture readback, cross-repeat elementwise AND, sanitisation
  sweep, `evidence.subset.json` for anything narrower than 3 repeats with no
  filters.
- **Self-test family K**, all criteria passing with their controls: pins agree
  across installed tree, lockfile version *and* integrity, and manifest; the
  contract module is store-neutral and a synthetic import is detected; the
  canonicaliser ignores declared volatility and does **not** ignore a belief-state
  change; the sanitizer catches a planted DSN and the canary and passes a clean
  payload; an empty acceptance map is a fault; the registry has no dangling pair
  and no case without a control; the clock is deterministic.
- **Fixture validation**, run network-less with both trees read-only, freeze
  asserted from inside the image, re-run every repeat so the freeze is shown to
  have held throughout rather than only at the start. Includes a check that the
  ranking judgment is self-consistent with the frozen vectors, so an oracle that
  contradicts itself surfaces as an oracle defect.
- **Shared policy module** and the **Lane M Markdown canonical store**: one claim
  per file with claim-level identity, append-only revisions, atomic
  temp-then-rename writes, mutation-intent records naming every file before the
  first write, content-hash version tokens, merge as redirection, and sensitive
  purge that removes statement text from every prior revision while ids, lineage,
  intervals, and hashes survive.

### 8.2 First measured behaviour of the apparatus

Running the full 77-mutation script through Lane M's canonical store:
**69 committed, 8 refused**, every refusal matching the oracle's expected code
*and* category, all terminal invariants holding, zero pending intents, canary
absent from canonical state.

### 8.3 Two defects the oracle caught before either lane was measured

Both would have produced a wrong measurement rather than an obvious failure.

1. **The sensitive candidate was committing**, with a rejection record, instead of
   being refused. The contract now returns a refusal that *still* writes a
   contentless audit record — the only legitimate reason a refusal writes
   anything.
2. **The stale-write case was refused as `DECISION_REF_REQUIRED`** before its
   guard was ever evaluated, so it measured authorization rather than staleness.
   Fixed in the fixture: t66 now differs from its successful twin t67 in exactly
   one variable, the version token it carries.

Defect 2 changed the corpus digest from `10c7304d…` to `f0e71823…`. Recorded in
`fixtures/manifest.json` as an **authoring change, not an amendment**: no lane
evidence existed. The amendment budget of 5 is untouched.

### 8.4 Not yet built

Lane M's Postgres projection and queries; Lane N entirely; the coordination
projection; native walkthroughs; the query, retrieval, and fault matrices; and
every evidence set. **No lane has been measured. There is no result.**

---

## Section 9 — What must not be inferred from this record

- Nothing here is a measurement. Section 8.2 is the apparatus applying its own
  fixture to its own store; it is not a comparison and not a Lane M result.
- No statement about Lane M or Lane N's relative merit exists yet.
- The architecture contradictions in Section 1.3 are recorded, not resolved. The
  pre-spike documents remain unmodified on purpose.
- Section 3's estimates are inferred, not measured. The engineer-day figures are
  a planning envelope.
- Brigade's reading of ARC-Mem's ablations is not adopted. Neither is ARC-Mem's.
- The prior-art licence findings are a point-in-time audit from 2026-09-03 and
  must be re-checked before any dependency decision.

---

## Section 10 — Lane M complete (Step 11)

Supersedes Section 8.4's "not yet built" list for Lane M only. Lane N, the
coordination transport, the native walkthroughs, and every matrix remain unbuilt.

### 10.1 What now exists

- **Derived Postgres projection** under `kp_projection`: `claim`, `edge`,
  `evidence`, `chunk`, `freshness` — the five relations declared in Step 6 and no
  others. Migrated by a single elected migrator holding a session-level advisory
  lock on a dedicated connection. Lazy setup disabled everywhere.
- **The execution plane** under `kp_execution`, Postgres in both lanes: work
  items, run attempts, a durable idempotency ledger, and mutation intents.
- **Lane M's read surface**, answering all twelve contract queries from canonical
  state, with a freshness block on every answer.
- **Roll-forward repair**, driven by intent records that carry the plan itself.
- **A coordination sink** outside the knowledge tree, so publication is a
  separate output rather than a knowledge write.

### 10.2 Measured behaviour of Lane M

All three suites pass with their controls:

| Suite | Criteria | Result |
|---|---:|---|
| Mutation script conformance | 14 | pass |
| Projection lifecycle | 13 | pass |
| Golden questions vs. the oracle | 24 / 24 | pass |

The projection suite includes the controls that make it mean anything: a second
migration performs no DDL, a rebuild from a truncated canonical set produces a
**different** digest, a healthy projection reports `fresh` before the stale case
marks it `stale`, and no advisory lock is left granted.

**This is Lane M meeting the contract. It is not a comparison and there is no
Lane N to compare it to.** It says nothing about whether Markdown is the right
canonical store.

### 10.3 Six defects found and fixed before any measurement

Each would have produced a plausible wrong number rather than an obvious failure.

1. **Atomicity was declared in the shared policy module** as `A1` for plans that
   write three files. Because the module is shared, per-lane honesty was
   structurally impossible there, and Lane M was being credited on the
   concurrency dimension for a guarantee a file tree cannot give. The policy now
   emits a plan *shape* and each adapter derives its own class.
2. **Human decisions were never persisted.** `CorrectClaim`, `SupersedeClaim`,
   and `MergeEntities` accepted an authorising `decisionRef` and dropped it, so
   the human-correction path was unauditable and the stale-decision question was
   unanswerable. Decisions are now recorded, and a decision names the revision it
   **produced** — naming the revision it was read against would make every
   applied decision stale the instant it committed.
3. **Evidence copied the full source document** into canonical knowledge. A
   locator and an `excerptHash` now survive; the excerpt does not. The research
   write-up stays in the system that owns it.
4. **`current` was being read as "transaction interval still open".** Retraction,
   summarisation, and reinforcement all append without closing their predecessor,
   so that test returns two live rows for one claim and doubles an answer that
   should have been empty. Reads are now head-of-chain.
5. **The peer member of the contradiction was discarded** after being counted,
   leaving a one-sided conflict. `ContradictionRecord` gained a separate
   `peerMembers` field — separate, because merging it into `members` is exactly
   the promotion the architecture forbids.
6. **A named volume mounted onto a path absent from the image** is created
   root-owned, so the first canonical write failed with `EACCES` — which reads as
   a lane defect rather than the mount error it is.

### 10.4 The isolation defect in the oracle, and its repair

The oracle held both the **inputs** a lane must consume and the **answers** it
must never see: the retrieval vectors and fusion weights alongside the graded
judgments, and the golden questions alongside their expected answers. A lane
cannot answer the hybrid retrieval question without the vectors, and cannot be
asked the golden questions without the question bank — so answering them at all
would have required mounting the oracle into a lane and destroying the isolation
the whole apparatus rests on.

Split along the input/answer line:

```
corpus/input/queries.json   the 24 questions, no answers        -> mounted into a lane
corpus/input/vectors.json   vocabulary, vectors, fusion weights -> mounted into a lane
oracle/expected-queries.json  the expected answer to each        -> comparator only
oracle/judgments.json         graded relevance, mustRankFirst    -> comparator only
```

No question, vector, weight, grade, or expected answer changed value. A validator
criterion now checks that each question asked matches the oracle's copy exactly,
so the two trees cannot drift into asking different things.

Recorded in `fixtures/manifest.json` as an **authoring change, not an
amendment** — no lane evidence existed. Frozen digests moved:

```
corpus  f0e71823… -> 4c013d24661b9677ecacf05863ae021e884b7b4a670641f2d0fef0142bd20b99
oracle  ef7d18b4… -> 1646f5798e2158e22f63fb9634f70b4be2b15ca79791de3f5f219798b98da76d
```

**Amendment budget remains 5, used 0.**

### 10.5 Two interpretations settled from the frozen contract

Neither changed the oracle.

- **`maxStalenessMs: null` means what the contract says.** All 24 golden queries
  declare it and the contract requires a canonical read, so they are answered
  from canonical state and report `servedFrom: "canonical"`. The projection is
  exercised where it genuinely is the subject: freshness, rebuild, stale marking,
  and the retrieval index.
- **Q22's `publishableTo: "peer"` is a conjunction**, and `canon` is the
  discriminating variable in this corpus. Publishability requires canon status,
  public sensitivity, a publishable visibility, and a readable belief. The
  narrower readings fail: filtering by evidence-source visibility drops the claim
  the oracle expects, and filtering by subject-entity visibility keeps one it
  expects absent.

### 10.6 Accepted limitation (Lane M)

A fresh canonical vault paired with a warm idempotency ledger replays every
command without effect and answers every question empty. That is the ledger
behaving correctly — it is canonical for execution and refuses to re-execute —
but it means volume lifecycle is load-bearing, and each case must take a fresh
vault **and** a fresh database together. Recorded here because the failure is
silent and looks exactly like a lane that lost its data.

---

---

## Section 11 — Lane N complete (Step 12)

Both lanes now exist. **There is still no comparison**: no matrix has been run,
no fault has been injected, and nothing has been scored.

### 11.1 The graph model

Entities, claims, relationships, evidence, decisions, and contradictions are
native graph objects rather than documents that describe a graph.

- **Typed relationships are real relationship types**, not a generic `:RELATES`
  carrying a `relType` property. Cypher cannot parameterise a relationship type
  or a depth bound, so both are interpolated after validation against a strict
  pattern. Refusing to interpolate would have handicapped this lane on exactly
  the question it exists to answer, and would have measured a limitation of the
  driver rather than of the store.
- **World intervals are two queryable properties**, `validFrom` and `validTo`,
  not one JSON blob. A temporal predicate is then a real graph predicate the
  planner can use.
- **Revisions are append-only nodes under a composite uniqueness constraint** on
  `(claimId, revision)` — Community-available, and a genuine storage-level
  rejection. The naive guard `MATCH … WHERE c.rev = $expected SET …` was rejected
  during Step 3 and is not used: it takes no write lock before the read, so two
  writers both pass the predicate.
- **Version tokens are content digests over canonical state**, never
  `elementId`. An element id does not survive a dump and restore, so a caller
  could guard a write against a value that a recovery silently invalidates.
- **Peer material is quarantined by label.** A `:PeerRecord` is not a `:Claim`
  and no statement anywhere converts one into the other.

Neo4j has no advisory-lock primitive, so Lane N borrows the same Postgres
migrator election Lane M uses rather than inventing a weaker one.

### 11.2 Measured behaviour

| | Lane M | Lane N |
|---|---:|---:|
| Script committed / refused | 69 / 8 | 69 / 8 |
| Golden questions vs. oracle | 24 / 24 | 24 / 24 |
| Neutral export digest | `9aa1c123…` | `9aa1c123…` |

**The two lanes produce byte-identical neutral exports.** That is the strongest
available evidence that they implement the same contract over the same corpus,
and it is what makes any later difference attributable to storage rather than to
two different sets of rules.

### 11.3 The first genuine measured difference

Atomicity, over the same 77-mutation script:

| Class | Lane M | Lane N |
|---|---:|---:|
| `A1` all-or-nothing | single-object plans only | **67** |
| `A2` durable intent, roll-forward | multi-object plans | **0** |
| `A3` crosses a boundary no store controls | 2 | 2 |

Lane N commits a multi-object plan in one transaction, so it needs no intent
record and no roll-forward repair. Lane M cannot, and says so. Both `A3` counts
are identical because erasure-reaching-exports and publication-into-coordination
are outside *either* store's reach.

This is a difference in capability, not yet a difference in score. What it costs
Lane M is measured in Step 16, not asserted here.

### 11.4 Three defects the cross-lane comparison caught

None was visible from either lane alone.

1. **The merge redirect was being loaded as a domain relationship.** Lane N's
   loader matched any Entity-to-Entity edge, so `:MERGED_INTO` came back as a
   seventh typed relationship the contract never asserted. Domain relationships
   are now identified by carrying a `relationshipId`.
2. **`observedStateHash` included the version token**, which is opaque and
   per-lane by construction. The same human decision therefore hashed
   differently in each lane, and a portable export compared unequal for a reason
   that had nothing to do with what the human saw.
3. **The same hash was order-sensitive.** Two lanes materialise the same record
   with different key insertion orders. It is now taken over a canonicalised
   form.

Defects 2 and 3 are in the **shared** policy module and therefore affected both
lanes identically — which is precisely why neither lane could have surfaced them
on its own.

### 11.5 A defect the graph surfaced on its own

`resolution` was stored as the string `"null"` rather than a graph `NULL`, so
`IS NULL` was false for every unresolved conflict and the open-conflicts question
answered empty while the conflict sat there unresolved. It passed Lane M
unnoticed because a file tree round-trips `null` without a storage layer having
an opinion about it.

### 11.6 Community Edition limits, as they actually bit

Confirmed by building against it rather than by reading the manual:

- **Node property uniqueness is the only constraint available.** Existence,
  property type, node key, and relationship constraints are Enterprise, so
  relationship-level uniqueness is an application invariant in the command
  service, named here rather than quietly assumed.
- **Nested structures are stored as opaque values**, because there is no property
  type constraint to make a nested shape safe. A decision's targets are therefore
  compared against the neutral snapshot rather than in Cypher.

### 11.7 What is still unbuilt

The coordination transport and its ownership cases, native walkthroughs, the
query and retrieval matrix, the fault matrix, Neo4j's offline dump and restore
downtime, portable import, and every evidence set.

**No lane has been scored. There is no winner and no margin.**

---

## Section 12 — Coordination plane complete (Step 13)

### 12.1 What the plane is

A filesystem-backed, append-only feed of attributed activity records, written by
a sink that is **shared by both lanes**. Sharing the writer is deliberate: byte
identity between two independently written serialisers would be a test of two
serialisers, whereas byte identity from one writer is a test of what each lane
*decided to publish*.

Publication lands outside the knowledge tree in both lanes, so a published record
can never be reached by a knowledge query, and the knowledge generation digest
and the coordination feed move independently. That is what makes "published after
committing" an observable, recoverable state rather than a torn one.

Each record carries `namespaceSeq` and `prevContentHash`, chained **within one
publisher's namespace only**. Chaining across publishers would make one node's
feed depend on another's — precisely the shared-truth coupling the plane exists
to avoid.

### 12.2 Controls, all eighteen passing

| Group | What is asserted | Its paired control |
|---|---|---|
| Feed integrity | Sequence contiguous from 1, chain intact, namespace owned, hashes verify | Every property is recomputed from the bytes, never read from a claim the feed makes about itself |
| Republication | Republishing identical content is idempotent and yields one record | Republishing *different* content under an existing id is refused, and the feed is unchanged after the refusal |
| Peer history | A rewritten peer record is quarantined as `PEER_HISTORY_REWRITTEN` | Re-ingesting the **same** bytes still commits, or the check is rejecting republication rather than rewriting |
| Privacy | No non-public claim value and no canary appears in the feed | The sweep must have had something to examine |
| Non-promotion | A claim citing the peer report is refused `PEER_PROMOTION_FORBIDDEN` | The same subject established by a human on a real source **commits** |
| Peer-absent variant | Only peer-dependent answers change | The peer-dependent answers **must** change, or nothing was removed |

The non-promotion pair is the important one. Refusal alone would be
indistinguishable from an inability to write the claim at all; the two halves
together show that non-promotion is a **policy about authority**, not a
limitation. The peer's output link stays citable throughout.

### 12.3 Git as the first transport — evaluated, and it holds

Two publishers, each writing only its own namespace, against one bare
repository:

```
x pushed first
y rejected non-fast-forward        (expected)
y rebased and pushed with NO conflict
final/node.ada/0000000001.json
final/node.ada/0000000002.json
final/node.bo/0000000001.json
final/node.bo/0000000002.json
```

Disjoint namespaces mean a concurrent divergent push is rejected as
non-fast-forward and then **rebases cleanly with no content conflict**. Ownership
is partitioned by construction rather than by convention, which is the property
that made Git the version-zero candidate. This is a positive result for the
transport hypothesis and does not depend on which lane is canonical.

### 12.4 A case-registry defect this step exposed

`p04-peer-absent-variant` was registered as *"Removing every peer record must
leave all non-coordination answers byte-identical."* **That statement is too
strong for this corpus and would have been a false criterion.**

The peer report is one of the two positions in the recorded contradiction — it
takes a position *without becoming a claim*, which is exactly the behaviour the
architecture wants. So removing it correctly removes the contradiction, and Q10
legitimately changes. Q12 changes because it is the coordination question itself.

The criterion is therefore narrowed to name its peer-dependent questions (Q10,
Q12) and is paired with the positive control that those questions must change.
Measured result: exactly `["Q10", "Q12"]` differ, and nothing else.

Two further honesty notes from the same comparison:

- The variant is compared against a **clean baseline vault**, not against the
  vault the other controls have been writing into. The first attempt compared
  against the contaminated vault and attributed the controls' own mutations to
  the absence of the peer record.
- The audit questions report an answer *and* a diagnostic of how much they
  examined. The diagnostic legitimately tracks how much state exists, so only
  the answer is compared. Q20's `occurrences` is 0 in both runs; only its
  `scanned` byte count moves.

### 12.5 A contract addition

`PEER_HISTORY_REWRITTEN` was added to the error taxonomy. The case registry has
required this behaviour since Step 6 (*"a rewritten peer history must be
quarantined rather than ingested"*) and no code named it. Both lanes receive it
identically through the shared policy module, no lane has been scored, and the
frozen corpus and oracle are untouched — `4c013d24…` and `1646f579…` both still
hold. Recorded here as completing the contract rather than bending it.

### 12.6 Cross-lane state after Step 13

| | Lane M | Lane N |
|---|---:|---:|
| Script committed / refused | 69 / 8 | 69 / 8 |
| Golden questions | 24 / 24 | 24 / 24 |
| Neutral export digest | identical | identical |
| Published feed bytes | identical | identical |
| Feed audit | chain intact | chain intact |

**Still nothing scored.** No fault has been injected, no native path has been
walked, and no dimension has a number.

---

## Section 13 — Native correction paths (Step 14)

Research only. **No UI was built and Obsidian was not driven.** Its GUI-only
surfaces are assessed by capability inspection, because crediting Lane M with a
correction path that was never exercised is the easiest available way to bias
this comparison.

### 13.1 The seven operations

All seven complete through the command contract in Lane M and are verified in a
native read surface — the canonical file an operator would actually open:
correction, supersession, conflict resolution, alias merge, temporal revision,
retraction, canonization. Twelve criteria, all passing.

The declared control holds: every operation records a human actor and a
non-empty rationale, and every one leaves a durable decision record. A
walkthrough whose operations carry no reason is one nobody can audit afterwards.

Conflict resolution upholds one member and **preserves both positions**,
including the peer's. A resolution that deleted the losing member could never be
revisited when the decision itself turns out to be wrong.

### 13.2 Three contract defects the walkthrough exposed

The frozen script never exercised these paths, so nothing had ever executed them.

1. **`ResolveConflict` and `ReviseRelationship` were unimplemented.** Both are in
   the contract's command list and in the plan's stated mutation set; both fell
   through to `CAPABILITY_NOT_NEGOTIATED`. Two of the seven correction
   operations were therefore impossible in *both* lanes.
2. **The authorising decision was read from two different places.**
   `CanonizeClaim` and `RetractClaim` read it from `args.decisionId`; every other
   command read it from `intent.decisionRef`. A caller that supplied it correctly
   in the envelope was refused for not having supplied it — which would have
   been scored as a missing human-correction path rather than as the contract
   defect it was.
3. **`ReviseRelationship` recorded no decision.** A corrected edge with no
   recorded reason is exactly as unauditable as a corrected claim would be.
   Relationships are not a lesser class of belief.

All three are in the **shared** policy module and so affected both lanes
identically. Frozen digests are untouched: `4c013d24…` and `1646f579…` still
hold, and the script still commits 69 and refuses 8.

### 13.3 What a native property surface can actually show — Lane M

Measured from the record rather than recalled from documentation. For a claim
head revision: **18 of 21 fields** are representable in Obsidian Properties or
Bases. The three that are not are `valid`, `origin`, and `supersedes`.

Obsidian Properties has no nested type, so these are not "hard to read" — they
are **absent from the surface entirely**. The temporal interval and the origin
are among them, and those are the two things a human most needs in order to
correct anything: *when was this true* and *who established it*.

Caveat, stated because the measurement is shape-based: a nullable nested field
classifies as representable while its value is null. `supersededBy` counted as a
scalar here only because it happened to be null.

### 13.4 What Neo4j Browser can actually show — Lane N

Also measured. Of 17 properties on a claim revision, **four are opaque JSON
strings**: `origin`, `supersedes`, `evidenceIds`, `derivedFrom`. Community
Edition has no property type constraint to make a nested shape safe, so an
operator sees a string where the contract has a structure.

But `validFrom` and `validTo` are **flat, queryable properties**, so the temporal
interval is natively visible in this lane and is not in Lane M. That is a genuine
asymmetry on the human-correction dimension and it favours Lane N.

One honest caveat: Neo4j drops a null property, so an **open** interval is
represented by the *absence* of `validTo` rather than by an explicit null. An
operator sees a missing field where Lane M's file says `"to": null`, and a
predicate has to test `IS NULL` rather than compare a value.

### 13.5 The stale native write, and the default that creates the hazard

Modelled on the pinned MCP Connector's measured write semantics, not its
documentation, and clearly a simulation rather than a driven plugin.

| Condition | Result |
|---|---|
| Native write held across an intervening contract commit, preconditions **on** | `stale_precondition` — rejected |
| The same write with no intervening update (control) | `written` — the guard is a guard, not a broken path |
| The same stale write with preconditions **off**, which is the shipped default | `written` — **silently clobbers** |

The third row is the finding. `requireWritePreconditions` defaults to `false` in
the pinned bundle, so Lane M's guarded correction path exists only if an operator
has explicitly enabled it. Left at its default, a native edit prepared against
stale state overwrites a newer committed revision with no error and no trace.

### 13.6 Community Edition cannot force an operator through the contract

Measured, not asserted. A raw Cypher statement in a Browser-equivalent session:

- **succeeds** in changing a claim's value,
- appends **no revision**,
- records **no decision**,
- leaves the origin and `assertedAt` of the revision it overwrote, so the edit is
  **unattributed** — the record now says a different thing while still claiming
  the same author and the same moment.

The identical change submitted through the contract by an agent with no human
decision is refused `DECISION_REF_REQUIRED`. The rule exists and is enforced at
the contract; Community Edition simply has no mechanism that can make the
operator use it, because role-based access control is Enterprise-only and
Browser's access-mode setting is documented as not a security control.

**Both lanes share this exposure**, in different shapes: Lane M's is a plugin
setting that defaults to unsafe, Lane N's is the absence of any enforcement
boundary at all. Neither can be scored as having a safe native correction path.

### 13.7 What this does not establish

- No score. This is a capability inventory with controls, not a dimension result.
- The Obsidian findings are capability inspection of the pinned bundle plus a
  faithful simulation of its documented compare-and-swap. **No Obsidian GUI was
  driven**, and Lane M is credited with nothing that was not exercised.
- The engineer-day envelope in Section 3 remains an inferred planning figure and
  is not revised by this step.

---

## Section 14 — Query and retrieval matrix (Step 15)

### 14.1 Capability breakdown

All 24 golden questions are classified into exactly one capability, checked
mechanically — a question belonging to none or to two would make a
per-capability rate uninterpretable. The grouping lives in the harness and **not
in the oracle**, because it changes no expected answer and putting it there
would have moved a frozen digest and spent an amendment on a presentation
choice.

| Capability | Questions | Lane M | Lane N |
|---|---:|---:|---:|
| Structured | 4 | 4/4 | 4/4 |
| Temporal | 5 | 5/5 | 5/5 |
| Provenance | 4 | 4/4 | 4/4 |
| Path | 3 | 3/3 | 3/3 |
| Conflict | 2 | 2/2 | 2/2 |
| Work / handoff | 3 | 3/3 | 3/3 |
| Attribution | 1 | 1/1 | 1/1 |
| Hybrid | 1 | 1/1 | 1/1 |
| Freshness | 1 | 1/1 | 1/1 |

### 14.2 Retrieval metrics — identical, and that is the finding

```
                    Lane M    Lane N
recall@5            0.833333  0.833333
recall@10           1.0       1.0
recall@20           1.0       1.0
ndcg@10             0.996669  0.996669
answerSupportRecall 1.0       1.0
structuralRecall    1.0       1.0
harmRate@10         0.0       0.0
mustRankFirst       held      held
mustExclude         held      held
```

**The two lanes are byte-identical on every retrieval metric, and the ranked
list itself is identical.** That is now a mechanical criterion rather than an
observation.

This is a direct consequence of a fairness decision made in Step 12: hybrid
retrieval runs on **one shared fusion over one shared frozen vector set**,
because a per-lane implementation would have manufactured a difference in
arithmetic and reported it as a difference in storage. The decision was right.
Its consequence has to be stated plainly:

> **On this corpus, retrieval ranking cannot discriminate between the two
> lanes.** The "Query and retrieval usefulness" dimension carries weight 20, and
> the retrieval half of it currently contributes **zero** discrimination.

The structural half of that dimension — path, temporal, provenance — is
implemented independently per lane and *could* discriminate. It does not, because
both lanes answer all of it correctly. A lane that returned Q08 and Q09
identically, or that lost the two time axes, would have separated here.

### 14.3 A caveat that must not be lost

`structuralRecall` scored 1.0 for both lanes. It is tempting to read that as
"structure adds retrieval signal", and it does not support that reading.

The metric's subset is the gold items sharing no vocabulary term with the query,
so reaching them does require something other than lexical matching. But what
reached them here was the **shared** fusion's graph and episodic components, not
either lane's own traversal. The metric measures the shared scorer, not the
store. It says structure helps; it says nothing about *which store's* structure.

### 14.4 The id-permutation fairness control

A deterministic bijection over **60 fixture ids**, rotating within each kind.

- Zero answers change once mapped back.
- **17 answers differ when not mapped back** — the control that stops the
  comparison from being satisfied by a harness that never applied the
  permutation, or a lane that ignored it.
- The inverse round-trips the corpus exactly.

Three defects in the control itself were fixed before it could pass, each of
which would have produced a false failure:

1. **Derived ids embed permuted ids.** An evidence id is `ev:<owner>#n`, so
   renaming a claim renames its evidence. Matching only whole quoted tokens
   renamed the claim and left the evidence pointing at the old name — which
   reads as an answer that changed under permutation when it is really a restore
   that did not finish.
2. **Ids legitimately prefix one another.** `ent:halyard` is a prefix of
   `ent:halyard-api`. Substring replacement had to run longest-first through
   placeholders.
3. **Declared sets are sorted by id at the call site.** Under a permutation that
   sort runs in permuted space, so mapping back leaves a set correctly ordered
   for ids it no longer has. The comparison re-normalises set order — and only
   set order: `revisions`, `attempts`, and `ranked` declare order as the answer
   and are never re-sorted. The unmapped-must-differ control is what keeps that
   normalisation from erasing the difference it is meant to tolerate.

### 14.5 What Step 15 did not do

The driver still hard-faults on every family except `K`. Orchestration for the
lane families is deliberately deferred to **Step 17**, when every family it must
schedule exists — including the fault families Step 16 adds. Building it twice
would mean building it wrong once.

`answerSupportRecall` is computed from support data the **lane emits**, not from
the fixture, so it reflects what the lane actually holds rather than what the
corpus says it should. Both lanes scored 1.0: every gold item they surfaced
reaches evidence that resolves to a source.

### 14.6 Consequence for the scorecard

This is the first evidence bearing on whether the frozen scorecard can produce a
verdict at all. Two of the seven dimensions now look non-discriminating on this
corpus:

- **Query and retrieval usefulness (20)** — identical on every measured value.
- **Coordination-plane fit (5)** — the plane is shared and filesystem-backed, so
  it was never going to discriminate.

That is 25 of 100 points that cannot separate the lanes. The remaining 75 —
correctness and temporal semantics, recovery and portability, human correction,
operational cost, and concurrency — must carry the entire margin, and the
precommitted threshold is 10.00 points with non-overlapping bounds.

**No conclusion follows from this yet.** It is recorded now, before the fault
matrix runs, so that an inconclusive Stage 1 cannot later be presented as a
surprise.

---

## Section 15 — Fault matrix, part one (Step 16)

### 15.1 The crash, and the first cost the atomicity difference actually carries

Both lanes were given the **same plan**, produced by the **same shared policy
module**, and interrupted at the **same point**: after 2 of its 3 operations —
past the evidence write and the closure of the predecessor revision, before the
successor was appended.

The fault is not a simulation of a crash's effects. It performs the real
sequence a real crash would interrupt: the intent record lands first, some ops
apply, and the intent is never completed. What survives is exactly what would
survive a `SIGKILL` at that instant.

| | Lane M | Lane N |
|---|---|---|
| Survives the interruption | a pending intent and a **torn claim** | **nothing** |
| Observable damage | the claim's head revision is closed, so it has **no believed value at all** | none; head revision still live |
| Export digest while interrupted | **differs** from healthy | **identical** to healthy |
| Recovery needed | roll-forward repair | none |
| After repair | coherent, correct successor value, zero pending intents | n/a |

Lane M's repair works and is idempotent: replaying a completed mutation changes
nothing. That matters, because a repair path that drifts on re-run is worse than
no repair path.

Both directions carry their declared control:

- **Lane M** — a kill placed *after* the commit returned leaves the effect
  intact, so the torn state above is attributable to the interruption and not to
  a plan that could never have committed.
- **Lane N** — the identical plan applied *without* the injected fault commits
  and yields the correct value, so "nothing survived" is a rollback and not an
  inability.

This is the concrete content of the `A2` / `A1` difference recorded in
Section 11.3. It was a capability claim; it is now a measured outcome.

### 15.2 Publication failure after a knowledge commit

Knowledge commits; the coordination feed does not advance. The receipt already
names the outstanding obligation, so the gap is detectable **from the receipt
alone** rather than only by noticing the feed is short.

Control: a successful publication produces exactly one record, and replaying the
same idempotency key returns the stored receipt with `replayed: true` and
produces **no second record**.

### 15.3 Malformed input

A command with an inverted world interval is refused `TEMPORAL_INVALID` and
leaves no residue — the claim id does not appear in canonical state. Its
well-formed twin, identical in every other respect, commits.

### 15.4 Portable export and import

The export is imported by generating the same `PlanOp` stream a lane applies for
any other write, so a restored store is built by the same code path as a live
one. An import through a private back door would have proved the export could be
read, not that it could be restored.

Both lanes reproduce their export exactly. Both fail the comparison when one
evidence link is removed first — without that control, "the import matched" is
satisfied by a comparison that cannot detect anything.

Scope note: the comparison covers entities, claims, relationships, evidence,
sources, contradictions, and decisions. Published records and peer material live
*outside* the knowledge plane and rejections are contentless audit rows, so
requiring a knowledge export to reproduce them would test the wrong boundary.

A Community Edition limitation surfaced here rather than being read from the
manual: **there is one user database**, so the import cannot be given a database
of its own and must run against a wiped instance. Charged to the cost dimension.

### 15.5 What Step 16 did NOT run, and why

Four scenarios in the frozen matrix need genuine process and container
lifecycle, and running them in-process would have produced a **fake result**:

| Scenario | Why it is deferred to Step 17 |
|---|---|
| `x01`/`x02` four-worker first-setup race | Needs four real containers. One process cannot race itself. |
| `x03`/`x04` two-writer duplicate and stale update | Two adapters in one single-threaded runtime is not concurrency; it would report a race that never happened. |
| `x07` store restart mid-write | Needs `docker kill` against a named container while a write is genuinely in flight. |
| `r02` offline dump and restore | `neo4j-admin database dump` requires the database **stopped**. This is the one duration reported as a number, and it needs the real stop. |

These are not omissions from the matrix; they are the part of it that requires
the driver, and the driver is built once in Step 17 when every family it must
schedule exists. Building it twice would mean building it wrong once.

**Until they run, no concurrency or recovery dimension has a number.**

### 15.6 Standing after Step 16

| | Lane M | Lane N |
|---|---:|---:|
| Script committed / refused | 69 / 8 | 69 / 8 |
| Golden questions | 24 / 24 | 24 / 24 |
| Retrieval metrics | identical | identical |
| Neutral export | identical | identical |
| Published feed bytes | identical | identical |
| Crash recovery | repair required, repair works | nothing to repair |
| Portable round trip | exact, control fails | exact, control fails |

Frozen digests still `4c013d24…` and `1646f579…`. **Amendments 0 of 5.**

The lanes remain indistinguishable on every dimension measured so far except
atomicity under interruption. That is one dimension, weight 10, and half the
concurrency scenarios have not run yet.

---

## Section 16 — The initial Stage 1 evidence set (Step 17)

> **SUPERSEDED IN PART — see Section 17.** The evidence set described in §16.1
> was **withdrawn** for a harness fault: the oracle was mounted into four lane
> containers. The artifact digested `271d7111…` and is **not citable**. Its
> replacement digests `57636480…`. Everything else in this section still stands;
> the original text is preserved unaltered, as the append-only protocol requires.

### 16.1 The run — WITHDRAWN, superseded by Section 17.3

```
run id     stage1-initial
schema     agent-runtime/spike-evidence/3
repeats    3, no lane / family / case filter
artifact   evidence.json          (final: true, subset: false)
digest     271d7111ae362a0292ee28559761d9cdeb023c0c0a0ee5df4f4a6401a652dac9
criteria   261, elementwise AND across all three repeats
outcome    pass
scan       0 hits
files      174, 1.3 MB
```

Cross-repeat: `structural-digest-is-stable`, `corpus-freeze-held`, and
`oracle-freeze-held` all true. Frozen digests still `4c013d24…` and `1646f579…`.
**Amendments 0 of 5.**

Per-bundle, per repeat: selftest 18, validate 14, lane-m-projection 13,
coordination 18, native-walkthrough 12, shuffled-ids 6, faults-m 17, native-graph
8, faults-n 6, compare-golden ×2 71 each, compare-lanes 7, race-collect 4.

### 16.2 The driver now orchestrates the lanes

Built once, as planned, rather than incrementally across Steps 15 and 16 — which
would have meant building it wrong at least once.

- Every family is wired. Store lifecycle is per repeat with per-repeat network
  and volume names, so no case can inherit another's state.
- **A fresh vault and a fresh database together.** The lane stack is torn down
  and recreated between the answers run, the projection run, and the race,
  because a fresh vault paired with a warm idempotency ledger replays every
  command and answers empty.
- Readiness is polled from the daemon's own health report. Never slept for.
- The comparators are the only containers the oracle is mounted into, and they
  run with **no network at all**. There is no path from compare back to execute.

### 16.3 Two driver defects fixed, both of which faked a result

1. **Compose networks and volumes were never registered for cleanup.**
   `note_preserved` was called only for containers, so every run leaked its
   stores. The clean run now leaves nothing behind — verified by inspecting the
   daemon afterwards, not by trusting the trap.
2. **The cross-repeat reduction recorded a false failure for a criterion
   declared by two bundles.** `combined[key] = len(values) == repeats and
   all(...)`, so a key emitted once per lane appears `2 × repeats` times and is
   recorded **false** for having been declared too often. It surfaced on
   `r03-*`, which both fault bundles emit. Bundles that both lanes produce are
   now namespaced by lane. **This was a counting artifact presenting as a
   measured failure**, and it is exactly the class of defect that would have made
   a real result untrustworthy.

A third, smaller: a `tmpfs` is created root-owned while the image runs
unprivileged, so every scratch mount now carries an explicit `uid`/`gid`. Without
it the first canonical write fails `EACCES` and reads as a lane defect rather
than a mount error.

### 16.4 The two-writer race — a real race, and an honest non-result

Two **separate containers**, each its own process, meeting at a barrier whose
release fires from committed rows rather than an interval. Overlap is proven by a
complete arrival set before any party proceeded, not by comparing wall clocks.

Outcome set across all three repeats, Lane M:

| Repeat | Committed | Refused | Lost update |
|---:|---:|---|---|
| 1 | 1 | `STALE_VERSION` | no |
| 2 | 1 | `STALE_VERSION` | no |
| 3 | 1 | `STALE_VERSION` | no |

Lane M detected the stale write in all three trials. **This does not mean Lane M
is race-free, and it must not be recorded as if it did.**

The lane's stale guard is re-evaluated by reading the file at decide time, so the
vulnerable window is only between that read and the subsequent write —
microseconds. Three trials did not land in it. An unsampled interleaving is
unsampled, not impossible. This case is classified `bounded-trials`, reports an
outcome **set**, and is excluded from every structural digest by construction.

What the corpus cannot show is how that window behaves under more parties,
slower storage, or a larger plan. The honest statement is: *no lost update was
observed in n = 3.*

The `lane-m-guarded` mitigation — an exclusive per-object lock held across
read-decide-write, which is what a file tree must build to get what a
transactional store provides for free — is implemented but did not need to
demonstrate its value here, because the stock lane did not fail. **A safeguard
whose paired stock case shows no failure has not been shown to fix anything**,
so it is reported as built and unproven rather than as a win.

### 16.5 What is still not measured

Three fault scenarios remain unrun, and each needs driver work that does not yet
exist rather than more analysis:

| Scenario | What it needs |
|---|---|
| `x01`/`x02` four-worker first-setup race | four parties on the barrier; the barrier now supports it, the driver launches two |
| `x07` store restart mid-write | `docker kill` on the store while a write is genuinely in flight |
| `r02` offline dump and restore | `neo4j-admin database dump` with the database **stopped** — the one duration reported as a number |

`r02` is the most consequential omission: it is a named deliverable and the only
place a duration is reported, and it bears directly on both the recovery and cost
dimensions.

**Therefore the recovery dimension has no number, and the concurrency dimension
has only the crash result and an unsampled race.**

### 16.6 Standing before the verification step

Everything measured so far separates the lanes on exactly one axis: what survives
an interruption. Retrieval, coordination, golden correctness, exports, published
bytes, and the capability breakdown are all identical.

That is not yet a basis for a verdict, and Step 18 must check it rather than
accept it.

---

## Section 17 — A harness fault, its repair, and Stage 1 verification (Step 18)

**Supersedes Section 16.1.** The evidence set described there was withdrawn
before it was ever cited, for the reason below. The replacement run carries the
same run id and a different digest.

### 17.1 The fault: oracle independence was structurally violated

Step 18's verification found that the driver shared one mount block across
several workers, so the oracle was mounted into **four lane containers**:

| Worker | Read the oracle? | Criteria |
|---|---|---:|
| `coordination-controls` | **yes** — loaded it, then discarded it unused | 18 |
| `native-walkthrough` | no | 12 |
| `shuffled-ids` | no | 6 |
| `faults-m` | no | 17 |
| | | **53 of 261** |

Under this plan's own outcome rules that is a **harness fault** — *"oracles are
not independent"* — and not a measured negative.

What was **not** compromised, established independently rather than assumed:
`lane-m-answers` and `lane-n-answers`, the containers that actually produce the
golden answers, never received the oracle, and no lane bundle contained any
oracle-only vocabulary. The 24/24 results and the comparators were clean.

What **was** compromised is the invariant itself. The rule exists so that a later
change cannot quietly begin reading what is reachable, and one of the four
already loaded it into memory. A structural guarantee that holds only because
nobody has used the access yet is not a guarantee.

### 17.2 The repair

1. The offline lane workers no longer receive the oracle mount at all.
2. `coordination-controls` **no longer accepts an `--oracle` argument**. It
   loaded the oracle and never used it, and a dead parameter is exactly what
   invited the mount in the first place.

No fixture, contract, or lane logic changed. Frozen digests are untouched:
`4c013d24…` and `1646f579…`, **amendments 0 of 5**.

### 17.3 The replacement evidence set

```
run id     stage1-initial              (replaces the withdrawn run of the same id)
digest     57636480b53e180f1ed6907f3009906c006f8b691790183edecd2f1acae21654
repeats    3, no filters               final: true, subset: false
criteria   261, elementwise AND        outcome: pass
scan       0 hits                      files: 174, 1.3 MB
leftover   no containers, networks, or volumes
```

The withdrawn artifact digested `271d7111…`. It is named here so the two can
never be confused.

### 17.4 Verification result

**119 checks, 119 passed.**

| Group | What was checked |
|---|---|
| Evidence integrity | final not subset, 3 repeats, all 261 criteria true, cross-repeat true |
| Pins | image manifest equals on-disk manifest; every pin agrees across tree, lockfile, and manifest in all 3 repeats |
| Freeze | corpus and oracle trees **re-digested now** and still match; run-time digests match in all 3 repeats |
| Lane equivalence | identical exports, identical published bytes, identical hybrid ranking, 24/24 golden both lanes, identical retrieval metrics |
| Oracle independence | excluded from the image and confirmed absent from it; reaches only the validator and the comparators; no oracle vocabulary in any lane bundle; all three run network-less |
| Observed faults | race arrivals prove overlap; crash anchored on durable state; both post-commit and uninterrupted controls hold; bounded case excluded from the reduction |
| Rebuild and import | deterministic rebuild **and** its truncated-set control; import fidelity **and** its damaged-export control, both lanes |
| No scoring | no scorecard, no dimension, no score key anywhere |
| Isolation | every worker read-only, `cap-drop ALL`, `no-new-privileges`, memory and pid capped, unprivileged user; both networks internal; no published ports |
| Sanitization | driver scan 0 hits; no canary and no host path in any file |

### 17.5 Three defects in the verification itself

Reported because a verification that emits false positives is worse than none,
and because the same trap will recur:

1. Searching for `winner` matched the **case name** `t04-contradiction-no-winner`
   and reported a scoring artifact that does not exist.
2. Counting `internal: true` matched `compose.yaml`'s own header comment — the
   comment that documents the property being checked.
3. Searching for `ports:` matched the same comment.

All three were checks reading a file's *description of itself* as evidence about
itself. Fixed by stripping comments and by matching structures rather than
prose.

### 17.6 What verification did NOT establish

- **No dimension has a score.** Confirmed positively: there is no scorecard in
  the evidence, and Step 18 asserts its absence rather than assuming it.
- **Three fault scenarios remain unrun** — `x01`/`x02` four-worker setup race,
  `x07` store restart mid-write, and `r02` offline dump and restore. Verification
  confirms the evidence is sound; it cannot confirm it is complete. **The
  recovery dimension still has no number.**
- **Lane M is still not race-free.** Three repeats, no lost update observed, and
  the case remains `bounded-trials`.
- `lane-m-guarded` remains built and unproven.

The evidence is now internally consistent, reproducible across three repeats,
fairly obtained, and independently scored. It is also **incomplete**, and the
Step 21 review has to decide whether that incompleteness is material before
anything is scored.

---

## Section 18 — The initial Stage 1 checkpoint (Step 19)

The consolidated factual report. Sections 10–17 remain the detail; this section
is what a reader needs to assess Stage 1 without reconstructing it from seven
sections, and it is deliberately organised so that **measured**, **source-derived**,
**inferred**, and **unresolved** claims cannot be mistaken for one another.

**No dimension is scored here.** Interpretation begins at Step 21 and the
scorecard is not applied until after the Step 25 audit.

### 18.1 Evidence inventory

```
plan            knowledge-plane-working-memory-spike
completed step  Step 19 (Stage 1 construction and measurement complete)
stage           Stage 1 — evidence gathered and verified, nothing scored

run id          stage1-initial
path            tmp/spikes/knowledge-plane-working-memory/stage1-initial/
artifact        evidence.json          final: true, subset: false
digest          57636480b53e180f1ed6907f3009906c006f8b691790183edecd2f1acae21654
repeats         3, no lane / family / case filter
criteria        261, elementwise AND across all three repeats
outcome         pass
sanitization    0 hits
inventory       174 files, 1.3 MB
withdrawn       271d7111…  — see Section 17, harness fault, not citable
```

Per-bundle criteria, each repeated three times and reduced by elementwise AND:

| Bundle | Criteria | What it establishes |
|---|---:|---|
| `compare-golden-m` / `-n` | 71 each | the 24 golden answers, scored against the oracle |
| `selftest` | 18 | pins, contract neutrality, canonicaliser, sanitizer, registry |
| `coordination` | 18 | feed integrity, republication, non-promotion, peer-absent |
| `faults-m` | 17 | crash, repair, publication failure, malformed input, export |
| `validate` | 14 | corpus, questions, and oracle freeze and referential soundness |
| `lane-m-projection` | 13 | migrator election, projection, rebuild, staleness, repair |
| `native-walkthrough` | 12 | the seven correction operations and the stale native write |
| `native-graph` | 8 | what Community Edition can and cannot enforce |
| `compare-lanes` | 7 | export equality, feed byte identity, ranking identity |
| `shuffled-ids` | 6 | the id-permutation fairness control |
| `faults-n` | 6 | crash rollback and the portable export round trip |
| `race-collect` | 4 | two-writer race, `bounded-trials`, excluded from digests |
| `lane-m-answers` / `lane-n-answers` | 2 / 4 | the lanes answered; they assert nothing |

### 18.2 MEASURED — what the evidence shows

Facts produced by the apparatus, reproduced across three isolated repeats.

**The lanes are indistinguishable on every axis except one.**

| | Lane M | Lane N |
|---|---|---|
| Mutation script | 69 committed, 8 refused | 69 committed, 8 refused |
| Refusal codes and categories | all match the oracle | all match the oracle |
| Golden questions | 24 / 24 | 24 / 24 |
| Capability breakdown | 4/4, 5/5, 4/4, 3/3, 2/2, 3/3, 1/1, 1/1, 1/1 | identical |
| Retrieval metrics | identical to Lane N on every value | identical to Lane M |
| Hybrid ranked list | byte-identical | byte-identical |
| Neutral export | byte-identical | byte-identical |
| Published feed bytes | byte-identical | byte-identical |
| Portable import | exact; damaged-export control fails | exact; damaged-export control fails |

**The one measured difference — atomicity under interruption.** Same plan, same
policy module, interrupted after 2 of 3 operations:

| | Lane M | Lane N |
|---|---|---|
| Survives | pending intent, **torn claim with no believed value** | nothing |
| Export digest while interrupted | differs from healthy | identical to healthy |
| Recovery | roll-forward repair, works, idempotent | none required |
| Atomicity over the 77-mutation script | multi-object plans are `A2` | 67 × `A1`, 0 × `A2` |
| Boundary-crossing plans | 2 × `A3` | 2 × `A3` |

Both directions carry their control: a post-commit kill leaves Lane M's effect
intact; the uninterrupted plan commits in Lane N.

**Other measured facts.**

- Lane M's projection rebuilds deterministically, and a rebuild from a truncated
  canonical set produces a **different** digest.
- A fresh projection reports `fresh`; a failed one reports `stale` with non-empty
  `degradedFields`.
- The migrator election is idempotent and leaks no advisory lock.
- The coordination feed's sequence, chain, ownership, and hashes verify from the
  bytes. Republication is idempotent; a rewritten record is refused; a rewritten
  peer history is quarantined while an identical re-ingest still commits.
- Non-promotion holds in **both** directions: citing the peer report is refused,
  and the same subject established by a human on a real source commits.
- Removing the peer record changes exactly `Q10` and `Q12` and nothing else.
- A 60-id permutation changes no answer once mapped back; 17 differ without the
  inverse.
- All seven correction operations complete through the contract, each attributed
  and each leaving a decision record.
- With write preconditions **off** — the shipped default — a stale native write
  silently clobbers a newer committed revision.
- A raw Cypher statement changes a claim's value, appends no revision, records no
  decision, and leaves the overwritten revision's original author and timestamp.
- Two-writer race, n = 3: Lane M refused with `STALE_VERSION` every time; no lost
  update observed.

### 18.3 SOURCE-DERIVED — read from pinned artifacts, not measured

- `requireWritePreconditions` defaults to `false` in the pinned MCP Connector.
- `rename_heading` is documented as atomic and returns `partial-failure` with the
  source heading already renamed.
- The string `provenance` occurs zero times in the connector bundle.
- Neo4j Browser has no `:begin`/`:commit`/`:rollback`; its access mode is
  documented as not a security control.
- Community Edition: node property uniqueness is the only available constraint;
  existence, type, key, relationship constraints, RBAC, CDC, online backup, and
  multiple databases are Enterprise.
- Prior-art licences and commits, audited 2026-09-03 (Section 2). Brigade has no
  licence at all.

### 18.4 INFERRED — reasoned, not measured

- The future-UI envelope: **15–30 engineer-days** for a narrow useful surface,
  **45–90** for all seven workflows. A planning figure.
- Lane M's stale-write window is microseconds wide, which is why three trials did
  not land in it. Consistent with the observations; not itself measured.
- Community Edition's single database will force per-case container isolation at
  larger scale. Observed once during the import; not measured as a cost.

### 18.5 UNRESOLVED — open, and material

1. **Three fault scenarios are unrun**: `x01`/`x02` four-worker setup race,
   `x07` store restart mid-write, `r02` offline dump and restore.
   **The recovery dimension has no number**, and `r02` is a named deliverable —
   the only place a duration was to be reported.
2. **Two dimensions cannot discriminate on this corpus.** Retrieval (weight 20)
   is identical by construction because the fusion is shared; coordination
   (weight 5) is shared infrastructure. 25 of 100 points cannot separate the
   lanes, and the precommitted margin is 10.00 with non-overlapping bounds.
3. **Lane M is not race-free.** No lost update in n = 3 is not a guarantee.
4. **`lane-m-guarded` is built but unproven.** Its paired stock case showed no
   failure, so the safeguard has not been shown to fix anything.
5. **The seven architecture contradictions of Section 1.3 remain open.** No
   architecture document has been modified.
6. **Lane R was never measured.** Not considered and rejected — never measured.

### 18.6 Harness defects, and whether they alter the result

| Defect | Altered a result? | Where |
|---|---|---|
| Oracle mounted into four lane containers | **Yes — run withdrawn and re-run** | §17 |
| Cross-repeat reduction marked a twice-declared criterion false | Yes, a false failure; fixed before any citable run | §16.3 |
| Compose networks and volumes never registered for cleanup | No result impact; leaked resources | §16.3 |
| Atomicity declared in the shared policy module | Yes — would have inflated Lane M on concurrency | §10.3 |
| Human decisions never persisted | Yes — stale-decision question unanswerable | §10.3 |
| Evidence copied full source documents | Yes — Q16 would have failed | §10.3 |
| `current` read as open transaction interval | Yes — doubled answers | §10.3 |
| Merge redirect loaded as a domain relationship | Yes — a seventh relationship | §11.4 |
| `observedStateHash` per-lane and order-sensitive | Yes — exports compared unequal | §11.4 |
| `resolution` stored as the string `"null"` | Yes — open conflicts answered empty | §11.5 |
| `ResolveConflict` / `ReviseRelationship` unimplemented | Yes — two of seven operations impossible | §13.2 |
| Decision read from two different places | Yes — would have scored as a missing path | §13.2 |
| tmpfs root-owned under an unprivileged image | No — surfaced as `EACCES` | §16.3 |

Every one was found and repaired **before** any citable evidence existed. The
frozen corpus and oracle were never amended: **0 of 5**.

### 18.7 Reproduction

```
Docker 29.0.0 · Compose 2.40.3 · Node 26.8.1 · 62 GiB RAM · 830 GB free
corpus  4c013d24661b9677ecacf05863ae021e884b7b4a670641f2d0fef0142bd20b99
oracle  1646f5798e2158e22f63fb9634f70b4be2b15ca79791de3f5f219798b98da76d
contract knowledge/1.0.0 · coordination coord/1.0
evidence schema agent-runtime/spike-evidence/3 · fixtures agent-runtime/spike-fixtures/3

cd spikes/knowledge-plane-working-memory && RUN_ID=<id> ./verify-stage1.sh
```

Images, packages, and edition limits are in `fixtures/manifest.json`, which is
baked into the image and verified equal to the on-disk copy.

### 18.8 Agenda for the Step 21 review

1. **Are the three unrun scenarios material enough to block scoring?** The
   recovery dimension has no number without `r02`.
2. **Can a 10.00-point margin be reached** when 25 points cannot discriminate and
   only atomicity has separated the lanes?
3. **Is an inconclusive Stage 1 the honest expected outcome**, and if so should
   Lane R become the recommended next measurement?
4. Should `lane-m-guarded` be exercised under conditions where the stock lane
   actually fails, or reported as unproven?
5. Does the shared hybrid fusion remain the right fairness call given that it
   removes the retrieval dimension's ability to discriminate?

### 18.9 What must not be inferred from this checkpoint

- **Nothing is scored.** There is no scorecard, no dimension value, no margin,
  and no winner. Step 18 verified their absence positively.
- Byte-identical exports, feeds, and rankings show the comparison is **fair**.
  They are not evidence that either store is better.
- 24/24 on both lanes is contract conformance, not a statement about Markdown or
  about graphs.
- `structuralRecall` of 1.0 was produced by the **shared** fusion, not by either
  lane's traversal.
- Lane N's transactional advantage is measured; **its cost to Lane M in
  operational terms is not**, because the recovery scenarios did not run.
- Neither lane has a safe native correction path.
- The evidence is verified **sound**. It is not verified **complete**.

---

## Section 19 — Locked Stage 1 review disposition (Steps 21–22)

**Status:** the factual checkpoint of Section 18 is **accepted for audit**, with
a **revised interpretation** supplied by the owner. This locks the owner's
disposition. It does **not** canonize the architecture decision, which remains
gated by Steps 33–38.

Section 18 is unchanged and is not rewritten. This section is additive.

### 19.1 The owner's disposition

The owner rejects the framing that the measured result is practically close, and
that rejection is a correction to how the evidence was *presented*, not to any
measured value.

Recorded in the owner's own terms: an interruption that leaves the canonical
store half-written is a categorically different problem from a backup that is
inconvenient — *"who gives a shit if you can do a backup if your data gets
corrupted"* — and building and maintaining a repair path to compensate is not an
acceptable trade.

The operative preference is therefore:

> **Prefer Lane N — Neo4j as the canonical knowledge store.** A transaction that
> leaves no partial state after an interrupted multi-record write is materially
> safer, and materially simpler, than a Markdown store that can be left
> incomplete and must therefore carry intent records, startup detection,
> roll-forward repair, and a correctness obligation on every mutation type ever
> added. Backup complexity is secondary to canonical-state integrity.

**Canonical transactionality is treated as non-compensatory.** It is not one
ten-point category that lower implementation cost, easier backup, or better
tooling can offset.

### 19.2 A correction the owner accepted, and one they overrode

**Accepted precision.** The evidence demonstrates rollback after an interruption
injected *inside a real Neo4j transaction*. It does **not** demonstrate a literal
host power loss or a killed database process. The Markdown store's torn state was
**detectably incomplete**, not silently corrupted — a repair path existed and
worked. Both points remain true and are not softened by this disposition.

**Deliberate override.** Told that the process-kill test was the most valuable
remaining measurement, the owner judged it unnecessary for *choosing between the
two measured lanes*: the transactional guarantee supersedes what Markdown's
repairability offers. That is a decision about which risks matter for this
system, and it is recorded as such rather than as a measured finding.

### 19.3 Instructions for the Step 25 audit

The audit must not force the result back into an artificial tie by treating every
weighted point as interchangeable. It must keep two questions separate:

1. **What does the frozen scorecard say?** Compute and report it unchanged,
   including an inconclusive classification if that is what its arithmetic
   yields. The scorecard was frozen before implementation and is not re-weighted
   to match a preference formed afterwards.
2. **What architecture matches the owner's stated risk position?** Canonical
   transactionality is foundational here. A point total must not overrule a
   non-compensatory integrity requirement, and the two answers may legitimately
   diverge.

The audit must **challenge Lane N**, not assume it is safe:

- Verify the transaction boundary genuinely covers every canonical knowledge
  mutation, and that no application path splits one logical mutation across two
  graph transactions. The measured `A1` result is only as good as that boundary.
- Confirm portable export and restore depend on no Neo4j-internal identifier.
- Preserve the finding that raw Cypher bypasses every application invariant,
  because role-based access control is unavailable in Community Edition. This is
  a real, unmitigated exposure in the preferred lane.
- Keep offline backup downtime and the unrun process-kill test as **explicit,
  accepted limitations**. Run either only if the audit finds a credible route by
  which it could reverse the selection — not to complete a checklist.
- Do not restate the evidence as proving literal power-loss safety.
- Keep Lane R identified as **unmeasured, not rejected**.

### 19.4 Locked identifiers

The checkpoint hash is defined **precisely**, because the obvious definition is
not stable: the first value recorded here was taken over Section 18 when it ran
to end-of-file, and appending this section changed the span without changing a
word of the content it was meant to pin. A hash that moves when something is
appended *after* it cannot certify that the thing itself is unchanged.

> **Definition.** SHA-256 over the UTF-8 bytes of Section 18, from the first
> character of its `## Section 18` heading through its last non-whitespace
> character. Trailing whitespace and any following separator or section are
> excluded, so the value is invariant under later appends.

```
checkpoint section       Section 18
checkpoint content hash  b25faa867530c0729f0c183263ef09a00fb6152e24a4c0a35afb0d1883dfc83d
checkpoint bytes         11311   (heading through last non-whitespace character)
superseded hash          1c6d8ae4… — span-dependent, not reproducible; see above
evidence run             stage1-initial
evidence digest          57636480b53e180f1ed6907f3009906c006f8b691790183edecd2f1acae21654
withdrawn evidence       271d7111… — harness fault, not citable
corpus digest            4c013d24661b9677ecacf05863ae021e884b7b4a670641f2d0fef0142bd20b99
oracle digest            1646f5798e2158e22f63fb9634f70b4be2b15ca79791de3f5f219798b98da76d
amendments               0 of 5
```

### 19.5 Caveats that survive this lock

- No literal power loss or database-process kill was measured.
- Neo4j Community backup requires the database stopped; the downtime is unmeasured.
- Neo4j Community cannot force an operator through the command contract.
- The frozen scorecard has not been computed and may classify the measured
  comparison as **inconclusive** even though the owner's architectural
  preference is unambiguous.
- Lane R — relational-canonical claims in the existing PostgreSQL — remains a
  credible third architecture that was **never measured**.

### 19.6 Next-stage contract

Step 25 audits the result with **Lane N as the preferred architecture under
review**, not as an accepted decision. Its job is to find any reason that
preference would be unsafe or rests on an overclaim. If it finds none, the Stage
1 decision gate at Steps 33–38 should select Lane N — and where the frozen
scorecard's classification diverges from the owner's risk decision, the report
must state both rather than reconcile them silently.

---

## Section 20 — Final Stage 1 factual checkpoint (Steps 25–30)

**Status:** the Stage 1 result has been independently audited, the audit's
blocking findings repaired, and the full evidence set regenerated from scratch.
This section is **factual**. It records what the repaired apparatus measured. It
does not select an architecture — that remains gated by Steps 33–38 — and the
owner's Lane N preference recorded in Section 19 is still a preference under
audit, not a decision.

Sections 18 and 19 are unchanged and are not rewritten. This section supersedes
Section 18's **evidence** with a new run; it does not supersede its reasoning.

### 20.1 The final evidence set

```
run id          stage1-final
evidence digest cd0ce571991150822564cfddd7c9110f18a8a37ab170853e2a739a1f0ad29544
repeats         3, no filters          final: true, subset: false
criteria        285, all true          outcome: pass          scan: 0 hits
files           246, 1.0 MB
superseded      stage1-initial 57636480… — sound but incomplete; see 20.7
withdrawn       271d7111… — harness fault, never citable
corpus digest   4c013d24661b9677ecacf05863ae021e884b7b4a670641f2d0fef0142bd20b99
oracle digest   1646f5798e2158e22f63fb9634f70b4be2b15ca79791de3f5f219798b98da76d
amendments      0 of 5
```

Criteria by namespace: **97 shared, 90 Lane M, 98 Lane N** — up from 261 total
and, more importantly, no longer lopsided: the audit found 137 Lane-M-specific
criteria against 85 for Lane N, so the preferred lane had been tested less
thoroughly than the one it was preferred over.

Cross-repeat gates, all true: `selftest-digest-is-stable`,
**`measured-structure-is-stable`**, `corpus-freeze-held`, `oracle-freeze-held`.

The second of those is new and is the one that matters. The previous
`structural-digest-is-stable` digested only `selftest.json` — pin versions,
canonicaliser digests over hard-coded literals, registry counts, every one
constant by construction. It could not have varied, so hard gate 12 ("three
isolated repeats produce one managed structural digest") had no evidence behind
it. The replacement digests the nine **measurement** bundles, with only
predeclared volatile fields removed.

### 20.2 MEASURED — the two discriminating results

**Atomicity under interruption** is unchanged from Section 18, and is now
reported with observed rather than echoed counts. Over a three-op supersession
plan interrupted after two ops:

| | Lane M | Lane N |
|---|---|---|
| Survives the interruption | pending intent, torn claim | nothing |
| Observed ops applied before the fault | 2 | 2 |
| Transaction committed | n/a — file writes landed | **false** |
| Recovery | roll-forward repair, works, idempotent | none required |
| Atomicity over the 77-mutation script | `A2` for multi-object plans | 67 × `A1`, 0 × `A2`, 2 × `A3` |

Lane N's `A1` claim is now checked against plans that genuinely touch more than
one object: **29 committed plans touched ≥ 2 objects**, the largest touching
**7**. The previous criterion asserted only that some committed plan was classed
`A1`, which every single-object plan and even the zero-op work-item commands
satisfied.

The crash injector now has a paired control that **commits** when no fault is
requested. It previously threw unconditionally, so it could never commit and the
criteria built on it passed without exercising it.

**Concurrent stale write is a second discriminating result, and it is new.**
Section 18 reported Lane M refusing `STALE_VERSION` in 3 of 3 trials with no lost
update. That result was an artifact of the apparatus: the barrier released the
last-arriving party immediately while every earlier party slept until its next
25 ms poll, against a vulnerability window microseconds wide. The parties never
overlapped. With a tight two-phase barrier, and with both lanes now attempting a
storage-level rejection:

| Case | Lane M | Lane N |
|---|---|---|
| `x04` two writers correct one claim, n = 3 | **lost update in 3 of 3** | **no lost update in 3 of 3** |
| Stopped by | nothing — both writers were told they had committed | `STALE_VERSION`, raised by the store |
| Committed parties | 2 | 1 |
| Surviving revisions | 1 | 1 |
| `x03` two writers create one entity, n = 3 | `DUPLICATE_NATURAL_KEY` 3/3 | `DUPLICATE_NATURAL_KEY` 3/3 |

Both races are still classified `bounded-trials` and are excluded from every
structural digest. **Three trials showing a lost update every time is not proof
that Lane M always loses one**, and three trials showing none in Lane N is not
proof that it never will. What changed is that the apparatus can now observe the
window at all: released-party counts are asserted and arrival spreads are
reported as findings in every race.

`x03` is the fair-comparison case: given an op that asserts "this object is
new", a file tree can reject a duplicate atomically with an exclusive create, and
it does. Lane M's disadvantage is specific to read-decide-write across an
existing object, not general.

### 20.3 MEASURED — everything that remained identical

Unchanged from Section 18 and re-measured on the repaired apparatus:

- Mutation script: **69 committed / 8 refused** (Lane N; see 20.6 for the Lane M
  asymmetry).
- Golden questions: **24 / 24 both lanes**; capability breakdown identical
  across all nine groups.
- Retrieval, both lanes identical: `recall@5` 0.833333, `recall@10` 1,
  `recall@20` 1, `ndcg@10` 0.996669, `answerSupportRecall` 1,
  `structuralRecall` 1, `harmRate@10` 0, same ranked list.
- Neutral export digest identical: `671f1953d1fd4c50f92d11f64c5c4ba17e0e2c18fd2e08a3a48443657db12976`.
- Published feed bytes identical; one record, `node.ada/0000000001.json`.

These show the comparison is **fair**. They are not evidence that either store
is better.

### 20.4 MEASURED — portability now means the graph, not its property bags

The previous round-trip check compared the neutral export before and after an
import. That export is a property bag: lineage travels as JSON strings on nodes,
so every structural edge is invisible to it. Deleting every `:EVIDENCED_BY` edge
leaves the export byte-identical while provenance answers break.

Now measured, all three repeats:

- Seven structural edge types counted before and after import, **identical**:
  `HAS_REVISION` 26, `ABOUT` 26, `EVIDENCED_BY` 29, `DERIVED_FROM` 3,
  `FROM_SOURCE` 30, `MERGED_INTO` 2, `FROM_REPORT` 1. None is zero.
- Nine structural questions replayed after import, **no answer differed**.
- Control: dropping one `:EVIDENCED_BY` edge is **invisible** to the export
  digest and **is** caught structurally. Both directions asserted, so the two
  checks are shown to measure different things.
- Control: a dangling evidence reference is refused before any write.
- Control: an export declaring another contract version is refused.

Portable identity still depends on **no Neo4j-internal identifier**. Version
tokens are content digests; `elementId` appears nowhere in the source.

Replaying the questions found a real defect that three repeats had never
surfaced: Lane N's provenance answer returned `derivedFrom` and `evidence` in
Cypher `collect(DISTINCT …)` order, which follows physical node creation order.
The same graph, restored from its own export, answered differently. Both are
ordered lists in the contract and Lane M returns them in declared order, so Lane
N now does too.

### 20.5 SOURCE-DERIVED — Community Edition, asked directly

- `SHOW ROLES` fails with **"Unsupported administration command"**. The previous
  criterion asserted that no constraint name contained "role" — true on any
  edition, including one with full role-based access control, because the
  harness creates every constraint itself and names none of them that way.
- Node property uniqueness remains the only available constraint. Relationship
  uniqueness is emulated by a guard node under a composite constraint, and is
  reported as `emulated` rather than native.
- The raw-Cypher bypass is **unchanged and unmitigated**: a raw statement changes
  a claim's value, appends no revision, records no decision, and leaves the
  overwritten revision's original author and timestamp. All `g0*` criteria pass.
  Nothing in this checkpoint reduces that exposure. It was measured against an
  instance with authentication disabled, so it under-measures even the weak
  controls the edition does have.
- `requireWritePreconditions` still defaults to `false` in the pinned MCP
  Connector; a stale native write silently clobbers a newer committed revision.

### 20.6 UNRESOLVED — open, and material

1. **The frozen scorecard cannot be computed.** What was frozen before
   implementation is the *weight vector* and the margin rule, not the rubric.
   There is no submetric enumeration, no absolute ladder thresholds, no
   aggregation rule, no construction for the conservative bound, and no blinded
   packet for the two subjective dimensions. Retrofitting anchors now would be
   inventing the rubric after seeing the result. **No score exists, and none was
   computed** — verified positively by scanning the whole evidence tree.
2. **Three scenarios remain unrun**, now declared as such in the case registry
   with reasons: `x01`/`x02` four-worker setup race, `x06` crash during entity
   merge, `x07` store restart mid-write, plus `r01` derived rebuild for Lane N
   and `r02` offline dump and restore. **The recovery dimension still has no
   duration.**
3. **Five `x06-*` criteria were measuring `x05`.** They are renamed to
   `x05-repair-*`. The registered `x06-crash-during-merge` — a process dying
   between repointing inbound references and tombstoning the alias — has never
   been run in either lane.
4. **Lane M's mutation-script conformance is still not a criterion.** The
   oracle comparison for committed/refused counts and refusal codes lives in
   `lane-m-script`, which the driver does not run and which the project itself
   documents as not evidence. Lane N emits the counts as findings. The two lanes
   are not yet symmetric here.
5. **`lane-m-guarded` remains built but unproven** in the sense that its stock
   pair now *does* fail — so the safeguard has something to fix, but the guarded
   lane was not run against `x04`.
6. **Lane R was never measured.** Not considered and rejected — never measured.
7. The seven architecture contradictions of Section 1.3 remain open. No
   architecture document has been modified.

### 20.7 Repairs applied since Section 18

Every one was found by the Step 25 audit. The evidence was regenerated in full
afterwards; none of these was patched into an existing run.

| # | Repair | Altered a result? |
|---|---|---|
| 1 | Claim revisions written with `CREATE`, not `MERGE`, so the uniqueness constraint can fire | **Yes — Lane N now rejects a stale second writer** |
| 2 | Relationship revisions guarded by a uniqueness node, emulating the constraint CE lacks | Yes — closes the same hole for edges |
| 3 | Store rejections mapped to typed `failed` outcomes in both lanes | **Yes — a rejection was an unhandled crash read as a harness fault** |
| 4 | Two-phase barrier with a tight release spin | **Yes — the races now overlap; Lane M's clean result was an artifact** |
| 5 | `x03`/`x04` run for **both** lanes, all repeats | **Yes — the preferred lane had no concurrency evidence at all** |
| 6 | Lane M temp files made unique per writer | **Yes — a concurrent writer crashed on `rename` instead of losing** |
| 7 | `mustBeNew` on entity creation, enforced by exclusive create / `CREATE` | Yes — duplicate creation is now a storage rejection |
| 8 | `load()` reads in one transaction instead of eleven | No observed change; removes torn-read risk |
| 9 | Statements that must touch something now assert they did | Yes — an erasure against an absent claim reported success |
| 10 | Durable obligation opened for A3 plans in Lane N | Yes — `A3` had no obligation carrier |
| 11 | `derivedObligations` filtered to structures the lane has | Yes — Lane N receipts named Lane M's projections |
| 12 | Export carries peer payloads, candidates, active contexts, rejections | **Yes — a restore silently dropped them** |
| 13 | Import validates references, contract version, revision contiguity | Yes — a corrupt export imported silently |
| 14 | Claim shells emitted before revisions on import | Yes — derivation edges survived only by id ordering |
| 15 | Structural edge counts and query replay added to the round trip | **Yes — the round trip could not see the graph** |
| 16 | Lane N provenance ordered by declared arrays, not traversal order | **Yes — a restored graph answered differently** |
| 17 | `n03` asserts `objectsTouched > 1` | Yes — the criterion was vacuous |
| 18 | `x05-no-repair-is-required` replaced; it could not fail | Yes |
| 19 | Injector given a committing control; returns observed counts | Yes — it echoed its own input |
| 20 | `x08`/`x10` ported to Lane N | Yes — Lane N's only A3 boundary was untested |
| 21 | Pin control exercises the real predicate; RBAC asked of the edition; canary sweep split | Yes — three controls could not fail |
| 22 | Lane M relationship append deduplicated by revision | Yes — repair was not idempotent |
| 23 | Canonization reset on every content-changing successor; `DecanonizeClaim` implemented | Yes — canon was a one-way inherited flag |
| 24 | Decisions record `decidedByClass`, are immutable by id, and are cited rather than reminted | Yes — a recorded human decision could be silently retargeted |
| 25 | Declared `originKind` validated against actor class | Yes — an agent could label its output `human_direct` |
| 26 | Evidence ids scoped by revision | Latent collision closed |
| 27 | `lane-m-answers` / `lane-n-answers` included in the cross-repeat reduction | **Yes — their criteria were emitted and discarded** |
| 28 | Cross-repeat digest computed over measurement bundles | **Yes — hard gate 12 had no evidence** |
| 29 | Unimplemented `lane-n-guarded` and nonexistent `graph.vector` removed | Yes — a declared mitigation lane did not exist |
| 30 | Unrun cases declared `unrun` with reasons; registry checks it | Yes — six cases implied coverage they did not have |

### 20.8 Reproduction

```
Docker 29.0.0 · Compose 2.40.3 · Node 26.8.1 · 62 GiB RAM · 830 GB free
corpus  4c013d24661b9677ecacf05863ae021e884b7b4a670641f2d0fef0142bd20b99
oracle  1646f5798e2158e22f63fb9634f70b4be2b15ca79791de3f5f219798b98da76d
contract knowledge/1.0.0 · coordination coord/1.0
evidence schema agent-runtime/spike-evidence/3 · fixtures agent-runtime/spike-fixtures/3

cd spikes/knowledge-plane-working-memory && RUN_ID=<id> ./verify-stage1.sh
```

Step 29 ran **100 independent verification checks, all passing**, re-deriving
every number above from the evidence tree rather than from the driver's summary,
and asserting each audit finding is repaired in the evidence and not merely in
the source.

### 20.9 What must not be inferred from this checkpoint

- **Nothing is scored.** No scorecard, dimension value, margin, or winner exists.
  The frozen rubric is under-specified and cannot be computed without inventing
  anchors after the fact.
- **Lane N is not selected.** Steps 33–38 remain the gate.
- **Lane M is not "unsafe under concurrency" in general.** It lost a committed
  update in a read-decide-write race in 3 of 3 trials, and it rejected a
  duplicate create atomically in 3 of 3. The guarded lane, which holds a lock
  across read-decide-write, was not run against that race.
- **Three trials are three trials.** Both race results are `bounded-trials` and
  are excluded from every digest.
- The interruption evidence demonstrates **transaction rollback on abort**. It
  does **not** demonstrate a killed database process and it does **not**
  demonstrate power loss. `x07` remains unrun.
- Identical exports, feeds, rankings, and 24/24 answers show the comparison is
  **fair**, not that either store is better. `structuralRecall` of 1.0 came from
  the **shared** fusion, and semantic retrieval is `emulated` in both lanes.
- **Neither lane has a safe native correction path**, and raw Cypher still
  bypasses every application invariant.
- **Lane R was never measured.** Every Stage 1 conclusion must say "the better of
  the two measured lanes".
- The evidence is verified **sound**. It is not verified **complete**: five
  registered scenarios are declared unrun, and the recovery dimension has no
  number.

### 20.10 Exact next step

**Step 31 — Verify the final Stage 1 factual checkpoint**, then the Step 32
pause, then Step 33 derives the Stage 1 conclusion for the Step 34 user gate.

No interpretation in this section has been accepted by the owner. Section 19's
disposition is the owner's, recorded at Step 22 and untouched here.

---

## Section 21 — Locked Stage 1 decision (Steps 33–37)

**Status:** the Stage 1 architecture decision is **accepted and locked**. The
owner selected at the Step 34 gate and approved this exact text at Step 35.

This section is the first in the record that *decides* anything. Sections 18, 19
and 20 are unchanged and are not rewritten; §21.6 corrects four statements in
them by appending, which is the only mechanism this record permits.

### 21.1 The decision

> **Select Lane N: Neo4j is canonical for personal structured knowledge, and is
> the Stage 2 substrate.**
>
> This is **the better of the two measured lanes**, not a claim that a property
> graph is the best possible canonical model. Lane R — relational-canonical
> claims in the Postgres already running — remains **unmeasured, not rejected**.
>
> The selection is by **hard-gate elimination plus the owner's non-compensatory
> integrity requirement**. It is **not** a score. Stock Lane M violated hard gate
> 4 — *"concurrent, stale, duplicate, and interrupted writes commit coherently or
> fail visibly"* — when two writers were each told their correction had committed
> while one committed update disappeared with no error raised anywhere. Lane N
> stopped the second writer at the canonical store with `STALE_VERSION`. Under
> interruption, Lane N's multi-object graph transaction rolled back leaving
> nothing, while Lane M left detectably incomplete canonical state requiring
> roll-forward repair.
>
> **No scorecard result exists and none was computed.** The weight vector and the
> 10.00-point margin were frozen before implementation; the ladder anchors,
> aggregation rule, uncertainty-bound construction, and blinded packet for the
> two subjective dimensions never were. Retrofitting them after seeing the
> outcome would be inventing the rubric to fit the result.

### 21.2 Authority assignment

| Plane | Store | Establishes |
|---|---|---|
| Personal knowledge | **Neo4j** | Accepted entities, claims, typed relationships, evidence links, provenance, temporal belief history, contradictions, review decisions, canon status |
| Source | **Markdown / Obsidian and external systems** | Their own content. Markdown holds source documents it genuinely owns, plus derived readable exports and views. **Not a second structured authority.** |
| Execution | **Postgres** | Work items, attempts, events, approvals, checkpoints, schedules, idempotency, cross-boundary obligations |
| Retrieval | **Postgres / pgvector** | Nothing. Derived and rebuildable. Stage 1 measured **no** native graph vector advantage; semantic retrieval was shared and is `emulated` in both lanes |
| Coordination | **Filesystem feed, shared sink** | Only *"publisher P reported X at T"*. Peer activity never becomes local knowledge without ordinary reconciliation |
| Human authority | Records custodied in Neo4j and Postgres | Corrections, conflict decisions, retractions, merges, canonization. **Custody is not authority** — the human remains the semantic authority for a decision whichever store holds the row |

This reverses the current documents' position that Markdown is authoritative for
knowledge. **No architecture document is modified by this section.** Those edits
are gated at Step 64 and are recorded here only as an obligation.

### 21.3 Required operating boundary

Selecting a store with no role-based access control obliges the boundary to be
architectural rather than editional:

- Every agent and human-facing tool writes through the **knowledge command
  service**. There is no approved direct-write path.
- Bolt is reachable **only from the command service**, on an internal
  gateway-less network. No human-facing Cypher console is exposed.
- **Neo4j Browser and raw Cypher are not approved correction paths.**
- Community Edition's absence of RBAC is an **accepted, unmitigated store-layer
  exposure**. It is not solved by this decision.
- A future HITL surface must reach the same command service for conflict review,
  correction, retraction, merge, temporal relationship editing, provenance
  inspection, decanonization, and canonization.

### 21.4 Rejected and deferred alternatives

| Alternative | Disposition |
|---|---|
| **Lane M as the Stage 2 substrate** | **Rejected.** The measured stock lane failed hard gate 4, and it still requires intent records, startup detection, roll-forward repair, and a correctness obligation on every future mutation type. This is **not** a finding that Markdown-canonical storage is generally unsafe or unfixable. |
| **Provisional Lane N, decision deferred** | **Rejected.** The owner selected without reserving the decision. |
| **Neutral fixture for Stage 2** | **Rejected.** Holding the selected substrate constant yields operational learning at no cost to fairness — the lanes were identical on retrieval, ranking, exports and published bytes. |
| **More evidence before deciding** | **Rejected for the decision**, retained as future work. The highest-value remaining test is `lane-m-guarded` against `x04`. |
| **Lane R** | **Deferred, not rejected. Never measured.** The neutral contract was authored so a third adapter needs no contract change. |
| **`lane-m-guarded` as a measured loser** | **Not claimed.** It was built and never run against the repaired race. Even if it closes that race, it does not remove Lane M's multi-file transaction and repair obligation, which is the owner's stated basis. |

### 21.5 Caveats accepted with this decision

1. **No numeric score, margin, or points winner exists.** The frozen rubric is
   under-specified and was not computed.
2. **Lane N is not proven race-free.** The measured result is no lost update in
   three bounded trials.
3. **Lane M is not proven to always lose an update.** Three bounded trials is
   three bounded trials.
4. The interruption evidence demonstrates **rollback after an abort raised inside
   a real Neo4j transaction**. It does **not** demonstrate a killed database
   process, and it does **not** demonstrate power loss.
5. Lane M's interrupted state was **detectably incomplete, not silently
   corrupted**; its roll-forward repair existed, worked, and was idempotent.
6. **Native dump and restore is unrun for both lanes.** Neo4j Community requires
   the database stopped to dump, and that downtime is **unmeasured**. The
   recovery dimension has no number.
7. **Raw Cypher bypasses every application invariant**, and Community Edition
   cannot enforce command-service-only writes. Measured against an instance with
   authentication disabled, so it under-measures even the controls the edition
   has.
8. **Neither lane has a safe native correction path.**
9. Identical exports, feeds, retrieval metrics and 24/24 golden answers establish
   that the comparison was **fair**, not that either store is better.
10. **Six registered case ids are unrun**: `x01`, `x02`, `x06`, `x07`, `r01`,
    `r02` — see §21.6.
11. Lane M's mutation-script oracle comparison remains **asymmetric**; it lives
    in a subcommand the driver does not run.
12. **No architecture document has been modified.** Step 64 remains the gate.
13. UI and implementation-cost figures remain **inferred planning envelopes**.

### 21.6 Append-only corrections to Sections 18–20

Four statements in the earlier sections are inaccurate. The sections are **not
edited**; these corrections supersede them.

1. **Unrun scenario count.** Section 20.6 says "three scenarios remain unrun" and
   `state.md` said "five". Neither is right. **Six case ids are unrun** — `x01`,
   `x02`, `x06`, `x07`, `r01`, `r02` — representing **five measurement gaps**,
   because `x01` and its paired mitigation `x02` are one setup-race gap.
2. **The section-hash boundary, settled once.** This record has now been bitten
   three times by the same trap: a section's digest changing because something
   was appended *after* it. The cause each time was an under-specified span.

   §19.4 defines the hash as ending at the last non-whitespace character with
   "any following separator" excluded. Section 18's recorded value `b25faa86…`
   over 11311 bytes does **not** match that prose — it **includes** the trailing
   `---`, because the separator falls inside the span between the two section
   headings. Section 20's recorded value `b2a8f5ff…` over 16852 bytes **does**
   match the prose, because Section 20 was the last section when it was computed
   and no separator followed it. Two locked values, two different conventions,
   purely by accident of when each was taken.

   **The canonical convention, from here on, is the one §19.4's prose always
   described:**

   > From the first character of the section's `## Section N` heading, through
   > the last non-whitespace character of its own content, **excluding** the
   > trailing `---` that delimits it from the next section.

   It is position-independent: a section's digest under this rule never changes
   when another section is appended. Under it, every section in this record has a
   stable digest, and the three that matter are:

   ```
   Section 18   67fea4e46801bacaca6c8aa1b5277e844e23ad177c896911671325d17b6377e9   11306 bytes
   Section 19   05d862eee4d29890193cedffdf85246485d4562f67bcbd738f14d2f9b7ae2e65    6601 bytes
   Section 20   b2a8f5ff8f25f2ff2c8b64e7955f54916e5a4cacc15e48b63d73394c1057eff5   16852 bytes
   ```

   **No section's bytes changed.** `b25faa86…` / 11311 remains a valid digest of
   a well-defined span — Section 18 including its trailing separator — and is
   retained as a historical cross-check. It is superseded as *the* Section 18
   identifier by `67fea4e4…`, exactly as the span-dependent `1c6d8ae4…` was
   superseded before it.
3. **`x04` classification.** The case registry marks `x04` `deterministic`, while
   Section 20 reports both races as `bounded-trials`. The **conservative reading
   governs**: `x04` is treated as `bounded-trials` and is excluded from every
   digest, which is what the driver does regardless of the registry label.
4. **Node version.** Section 18.7 and 20.8 record "Node 26.8.1" in the
   reproduction block. That is the **host orchestrator's** Node. Every
   measurement ran inside the pinned container image on **Node 24.6.0**
   (`node:24.6.0-bookworm-slim@sha256:9b741b28148b0195d62fa456ed84dd6c953c1f17a3761f3e6e6797a754d9edff`).

### 21.7 Locked identifiers

```
decision                 Lane N — Neo4j canonical for personal knowledge
decided by               owner, Step 34 gate; text approved at Step 35
basis                    hard-gate elimination (gate 4) + non-compensatory integrity
score                    none — the frozen rubric is not computable

evidence run             stage1-final
evidence digest          cd0ce571991150822564cfddd7c9110f18a8a37ab170853e2a739a1f0ad29544
criteria                 285, all true, 3 repeats, scan 0 hits

All section digests below use the canonical convention fixed in §21.6 item 2.

factual checkpoint       Section 20
  content hash           b2a8f5ff8f25f2ff2c8b64e7955f54916e5a4cacc15e48b63d73394c1057eff5
  bytes                  16852
owner disposition        Section 19
  content hash           05d862eee4d29890193cedffdf85246485d4562f67bcbd738f14d2f9b7ae2e65
  bytes                  6601
initial checkpoint       Section 18 (superseded evidence, reasoning intact)
  content hash           67fea4e46801bacaca6c8aa1b5277e844e23ad177c896911671325d17b6377e9
  bytes                  11306
  historical value       b25faa86… / 11311 — same bytes, separator included

superseded evidence      57636480… — stage1-initial, sound but incomplete
withdrawn evidence       271d7111… — harness fault, never citable
corpus digest            4c013d24661b9677ecacf05863ae021e884b7b4a670641f2d0fef0142bd20b99
oracle digest            1646f5798e2158e22f63fb9634f70b4be2b15ca79791de3f5f219798b98da76d
amendments               0 of 5
```

### 21.8 Stage 2 handoff contract

```
canonical knowledge   Lane N / Neo4j Community, as measured
execution             Postgres
retrieval             shared derived retrieval, HELD CONSTANT across all arms
source documents      Markdown and external systems
coordination          separate attributed feed, non-promoting
contract              knowledge/1.0.0
coordination contract coord/1.0
corpus digest         4c013d24661b9677ecacf05863ae021e884b7b4a670641f2d0fef0142bd20b99
oracle digest         1646f5798e2158e22f63fb9634f70b4be2b15ca79791de3f5f219798b98da76d
Stage 1 evidence      stage1-final / cd0ce571…
```

Stage 2 compares **W0, W1, W1A, W2, W3** against this fixed substrate.

Three constraints carry forward:

- **The storage selection is not a working-memory treatment.** The substrate is
  constant across every arm; a difference between arms can never be attributed to
  it.
- **Zero live model calls before the Step 41 approval gate.**
- **The corpus and oracle stay frozen.** Amendments remain 0 of 5.

### 21.9 What this decision does not settle

- The seven architecture contradictions of Section 1.3 remain open. Selecting
  Lane N changes the *answer* to contradiction 4 — where the supersession graph
  is canonical — but writing that answer down is Step 64's work.
- Backup and disaster recovery for knowledge now depend on a stopped-database
  dump plus the measured portable export, replacing Git as the knowledge recovery
  floor. **This obligation is new, is unmeasured, and must be discharged before
  any production use.**
- Lane R is still worth measuring, and is now the natural comparison for any
  future revisit.

### 21.10 Exact next step

**Step 38 — Verify the locked Stage 1 decision**, then the Step 39 pause, then
Step 40 begins Stage 2 by defining the final working-memory protocol.

---

## Section 22 — Stage 2 calibration apparatus repair

**Status:** offline repair complete and verified. **No live model calls have been
made. Stage 2 has not run.** This section is a factual checkpoint of apparatus
work, not a measurement. It supersedes nothing in Sections 18–21, which remain
byte-identical and are re-verified above.

### 22.1 Why the repair happened

Human calibration was paused after twelve of twenty-four items. The owner's
difficulty scoring was traced, by audit, to contradictory inputs rather than to
the rubric. Four defects were confirmed against the committed receipts:

1. **Refused writes were rendered as accepted facts.** The card builder replayed
   the frozen mutation *script* and treated every request as though it had
   committed. Two refusals made that fatal:
   - tick 65 `CanonizeClaim` on `clm:req-rot-window` was refused
     `CANONIZE_REQUIRES_HUMAN`. The packet rendered it as "CANON — established by
     human decision", which is the exact authority the false-correction and
     contradiction-pressure scenarios turn on.
   - tick 62 `CreateClaim clm:peer-kestrel-tr2` was refused
     `PEER_PROMOTION_FORBIDDEN`. The packet rendered a claim that does not exist,
     as an active head competing with the real local one, in the scenario built
     to test that peer material stays unpromoted.
2. **World state was prose that disagreed with the baseline.** Seven scenarios
   asserted rotation was unbuilt; the baseline has `run:r2` and `run:r3`
   completed and a published completion report citing PR 42.
3. **Citations did not support what they were attached to.** The s09 advisory was
   attributed to issue 9, whose text is the rotation requirement. `clm:tr-latest`
   revision 1 cites an architecture page about API rate limits.
4. **The evaluator misclassified the owner's own accepted answers.** Reproduced
   against the live predicates: `"I am not upgrading to tokenring 2.0.0"` failed
   the forbidden-choice check; adopting the peer value while citing `node.bo`
   passed the promotion check; a fabricated file list plus any unrelated
   uncertainty passed the fabrication check.

All 133 checks were green throughout. Some of them actively asserted the wrong
reconstruction — the old `s2-29` block required the refused peer claim to exist
and the rotation requirement to be canon — so a green run was evidence that the
apparatus was faithfully reproducing its own bug.

### 22.2 What was repaired

| Defect | Repair |
|---|---|
| Script replay | `baseline.ts` reads the committed export and receipts. Requests come from the script, **outcomes come from the receipts**, joined on tick. The script's own `expect` field is never consulted. |
| Refusals invisible | A refused claim renders as `DOES NOT EXIST` with its refusal code; refused attempts against a live claim are listed under it. |
| Canon by assertion | Canon is rendered only with an applied human decision behind it. A canon flag without one renders as a defect. |
| Prose world state | `scenarios/input/setup.json` declares evaluation time, execution state, baseline claims, synthetic additions, source access and execution evidence. `setup.ts` validates all of it against the baseline. |
| Unsupported citations | Four synthetic Stage 2 facts declared with explicit provenance and reasons, rendered as setup rather than as measured history. The baseline's own evidence miswire is **recorded, not corrected**. |
| Substring predicates | `result.ts` adds a typed `DecisionResult`. Scoring reads declared slots; prose contradictions are surfaced, never auto-resolved. |
| Answer-key leak | `judgeView()` is an explicit allowlist. It was subtractive and leaked `designedReasons` and `mustAppearInDecision` on all 24 items. |
| Unbound packet | `packet.ts` generates one artifact bound to rubric text, reason taxonomy, setup, baseline evidence and per-item digests, and validates it **as a file**. |
| Positional labels | `calibrateById` joins on item id, refuses duplicates, rubric mismatch, unknown items, partial coverage, and reports unmeasurable critical recall as unmeasurable. |

### 22.3 Verification

```
npm run typecheck                     clean
selftest                              18 criteria, 0 failed
validate --corpus --oracle            14 criteria, 0 failed
stage2-selftest                       196 criteria, 0 failed
stage2-calibration                    92 criteria, 0 failed
```

Six mutation tests confirmed the new controls have teeth. Each was caught by a
criterion naming its own defect: a renderer faking canon, a refused claim
rendered as existing, the forbidden-choice check reverting to substring
matching, the promotion check consulting attribution again, `judgeView` leaking
authored reasons, and a denied source becoming readable.

### 22.4 Frozen material

```
stage1-final/evidence.json     cd0ce571991150822564cfddd7c9110f18a8a37ab170853e2a739a1f0ad29544
repeat-{1,2,3}/lane-n-answers  3ea36cb38d9b45f8455d025c265e518736edf3bca5da0d999c8a75137d9dd65b
corpus tree                    4c013d24661b9677ecacf05863ae021e884b7b4a670641f2d0fef0142bd20b99
oracle tree                    1646f5798e2158e22f63fb9634f70b4be2b15ca79791de3f5f219798b98da76d
```

All unchanged. No architecture document modified. Amendments remain 0 of 5.

### 22.5 Artifacts

```
scenarios/input/setup.json              Stage 2 setup contract
scenarios/input/calibration-packet.json e3d2c3ffefb79bd75622e271f7949614726f2072897f175c11d7c3f72d12a585
scenarios/oracle/expected-outcomes.json typed, oracleId kpwm-stage2-oracle/2
scenarios/oracle/human-labels.json      12 recovered labels, id-keyed
tmp/spikes/.../stage2-repair/           offline apparatus evidence
```

The previous packet is archived at
`stage2-repair/archive/calibration-packet.support-safety-1.json`
(`a527181c2dc8a20c61e7b95836120c661e01a782dfa590c5d513ee0380f022da`). It was
`support-safety/1` against code at `/3`, and its top-band items carried neither
citations nor escalation — under the current rubric it contained no 3s at all.

### 22.6 Labels

Twelve owner labels were recovered from the transcript into
`scenarios/oracle/human-labels.json`, keyed by `itemId`. Every one is
`bindingStatus: historical_unbound`: the packet bytes each score was given
against were never captured, and stamping today's hashes onto them
retrospectively would manufacture a provenance that does not exist.

The label-impact report shows **three of twelve answers were re-authored** since
scoring (`cal-19`, `cal-10`, `cal-04` — the three the owner scored 3), and all
twelve now carry materially different context blocks. Every one is marked
**RECONFIRM**. None was silently transferred, and none was discarded.

Items 13–24 carry no accepted human label. The provisional read of item 13
offered during the audit was an assistant assessment and is not recorded as one.

### 22.7 What this does not establish

- **Only the calibration apparatus was repaired and tested.** The Stage 2
  experiment apparatus as a whole is not verified. Arms, prompt assembly,
  transport, blinding at run scale, and aggregation have not been exercised
  end to end.
- **No live transport work was done.** The typed result contract is wired and
  tested offline only. Integrating it with a live subject run is unstarted.
- **The typed slots are scenario-specific by design.** They cover what this
  benchmark already measures. Free-text factual claims outside those slots are
  not deterministically verified and must not be reported as though they were.
- **Synthetic setup is not measured history.** `syn:dec-rot-window`,
  `syn:src-advisory`, `syn:src-tokenring-release` and `syn:src-changelog` are
  declared Stage 2 additions. They make scenarios judgeable; they establish
  nothing about Stage 1.
- **The baseline's evidence miswire remains.** `clm:tr-latest` r1 still cites a
  page about rate limits. That is recorded, and the corrected provenance is
  synthetic and separate.
- **A judge has not been calibrated.** No model has scored anything. The gate
  thresholds are unchanged at kappa ≥ 0.70 and critical recall ≥ 0.90.
- **Assisted labelling is not blind labelling.** The owner authorised
  recommendation-then-confirm for the remaining items. Agreement with the
  resulting labels is agreement with human-reviewed, model-assisted labels, and
  must be reported that way.

### 22.8 Exact next step

**Independent audit of this repair.** The approved 572-dispatch ceiling is not
authorisation to run until that audit is accepted.

---

## Section 23 — Section 22 is corrected, and a second repair is approved

**Status:** apparatus work in progress under plan `stage2-calibration-repair`.
**No live model calls have been made. Stage 2 has not run. No calibration vote
has been collected since item 12.** This section is append-only. Section 22
(`ad2d7550b5e00ff0fe507eff890bcabc66ff307574f3564e44c991e9946886fd`, 8523 bytes)
is left byte-unchanged and remains the record of what was claimed. Sections
18-21 were re-verified byte-identical before this section was written.

### 23.1 Section 22 overstated readiness

Section 22 reported the calibration apparatus repaired and verified, on 196 green
Stage 2 checks and six mutation tests. An independent read-only audit reproduced
the following against the same code:

| Claim in Section 22 | What the audit reproduced |
|---|---|
| Scoring reads declared slots, so a self-report cannot launder a wrong answer | **One generic non-answer passed 12 of 14 decision turns.** It selected no window, no version, answered no current-value question, and escalated identically everywhere. |
| Fabrication is caught | Moving an invented file list out of `sourceContentClaims` and into another field passed `noFabrication`. The gate reads only the list whose sole function is self-incrimination. |
| Required values are checked | A required rotation window may be `null` and pass: absence exits the check rather than failing it. |
| Forbidden selections are caught | A forbidden version named in `selectedDependencyVersion` passes whenever `dependencyChanged` is false. |
| Actions need a recorded receipt | A claimed implementation was "evidenced" by `evt:s02-r1-blocked`, an event recording that the previous attempt terminated **blocked**. |
| The packet is validated as a file | Replacing a delivered sheet with different text, leaving the declared digests untouched, produced **no problems**. `packetDigest` is written and never read. Arbitrary nested metadata survives validation. |
| `judgeView` is an allowlist | True, and insufficient: `cal-NN` ids satisfy `designedLevel = 3 - ((NN-1) mod 3)` for **all 24 items**, so the delivered id is itself the answer key. |
| Rubric is bound | Bound by hash and **not delivered**. The packet contains no rubric text, so a judge cannot check the binding it carries. |
| Historical-unbound labels cannot gate | The twelve recovered labels plus agreeing model labels return `usable: true`, kappa 1. `bindingStatus` is never read by `calibrateById`. |
| Synthetic authority is materialized | `syn:dec-rot-window` is a JSON object. No command was executed, no decision record exists, no receipt exists. The sheet asserts a "recorded human decision" while the knowledge block two lines down shows the canonization **refused**. |
| Access restrictions hold | Enforced on the source-list renderer only. Full document text of undeclared sources is printed through the claim-evidence path in six of eight scenarios, including issue 9 in the scenario that explicitly excludes it. |
| Three of twelve answers changed since scoring | **Unsupported.** Every row compares against the `support-safety/1` archive, which is not the artifact any vote was given against. `cal-04` is affirmatively wrong: `human-labels.json` records that vote as given *after* the hold-and-route re-authoring. |

Two further findings: `cal-19`, an intended top-band exemplar, still cites issue 9
in its prose after its typed citation was corrected to the synthetic advisory —
the typed layer was fixed and the answer was not; and 196 green checks were
green while all of the above held.

### 23.2 What Section 22 got right

Recorded so the second repair does not discard working parts:

- `baseline.ts` genuinely joins the frozen script to committed receipts on tick
  and never reads the author's `expect` field.
- Canon rendering genuinely requires an applied human decision; the freeze
  requirement renders its real decision and the rotation requirement renders
  `NOT canon` plus its refusal code.
- The s04 sheet is well built: local claim, unresolved contradiction, attributed
  peer block, unreviewed candidate.
- The baseline's own evidence miswire is visible rather than corrected.
- `judgeView` closed the subtractive-projection leak.
- The three original evaluator counterexamples are caught **when the candidate
  declares its own failure honestly**.
- The twelve labels were recovered with the owner's selected reasons and marked
  `historical_unbound`.

### 23.3 The correction

Section 22.3's verification block stands as a record of commands run. It is
**not** evidence of correctness. Section 22.6's "three of twelve answers were
re-authored since scoring" is **withdrawn**: the comparison baseline for those
votes is unavailable, and no per-item claim of change since scoring may cite the
`/1` archive. Section 22's "offline repair complete and verified" is amended to
**offline repair attempted; independently audited; not accepted**.

The twelve votes and their owner-selected reasons remain valid as scores. Their
bindings remain unknown.

### 23.4 What was approved

Plan `stage2-calibration-repair`, 30 steps, pause-enabled. The owner selected
**structured-first**: the model's structured answer is the authoritative answer
under evaluation, human-readable text is derived from it, and completion is
established by an executor receipt rather than by the candidate describing
itself. This narrows the experiment to structured task performance and does not
measure unrestricted conversational truthfulness.

Contracts approved at Step 3 and persisted at
`spikes/knowledge-plane-working-memory/contracts/stage2-contracts.md`:

- `kpwm/structured-answer/1` — one authoritative answer, request slots addressed
  exactly once, bounded value codecs, a closed qualifier enum where every member
  has a declared scoring effect, `unknown` governed by a per-slot policy, and
  promotion and fabrication computed from the answer plus the grant projection
  rather than from a self-report list.
- Actions carry `propose | refuse | execute`, where `execute` means *request
  execution*. Completion is a join on
  `(workItem, attempt, turn, operation, canonical(args))` requiring
  `outcome === applied`, non-empty effects, and a changed state digest.
- `kpwm/scenarios/2` — scenario state materialized through the real command
  service against isolated stores, with setup-only synthetic human actors and
  read-back verification. A JSON declaration is not authority.
- One grant resolver, applied on every render path including claim evidence.
- `kpwm/scoring-packet/3` — rubric text delivered not merely hashed, opaque
  public ids sealed with a committed private mapping, structural key-path schema
  rejection, and verification that checks delivered bytes against an
  independently supplied manifest.

Batch A is bounded to Steps 5-12 and produces a `repair-preview` packet carrying
archived legacy payloads as **opaque bytes**, `calibrationEligible: false` as a
manifest field the gate reads. Its claim is therefore statable exactly: packet
mechanics, grounding and grant projection are verified; answer semantics are
not, because no answer in that packet is in the scored schema.

### 23.5 Frozen material, re-verified

```
stage1-final/evidence.json     cd0ce571991150822564cfddd7c9110f18a8a37ab170853e2a739a1f0ad29544
repeat-{1,2,3}/lane-n-answers  3ea36cb38d9b45f8455d025c265e518736edf3bca5da0d999c8a75137d9dd65b
corpus tree                    4c013d24661b9677ecacf05863ae021e884b7b4a670641f2d0fef0142bd20b99
oracle tree                    1646f5798e2158e22f63fb9634f70b4be2b15ca79791de3f5f219798b98da76d
Sections 18-21                 byte-identical
```

Amendments remain 0 of 5. No architecture document modified.

The failed repair's artifacts are archived under
`tmp/spikes/knowledge-plane-working-memory/stage2-repair-v2/archive/`, with a
manifest recording what each can and cannot support. The disputed reports are
retained verbatim rather than corrected in place.

### 23.6 Exact next step

Batch A implementation, Steps 6-9, then Verify at Step 10. The 572-dispatch
ceiling is unchanged and is not authorisation to run.

---

## Section 24 — Batch A built, run against real stores, and verified

Steps 6-10 of `stage2-calibration-repair`. Every claim below rests on a command
that ran; the evidence directory is named for each.

### 24.1 What was built

| Module | What it establishes |
|---|---|
| `src/stage2/scenarios2.ts` | `kpwm/scenarios/2` types and structural validation |
| `scenarios/input/scenarios-2.json` | 10 scenarios, 14 decision turns, 66 setup commands |
| `src/stage2/execution-fixture.ts` | `kp_stage2_execution` schema, executor-owned receipts, separate checkpoints |
| `src/stage2/completion.ts` | the completion join |
| `src/stage2/materialize.ts` | setup executed through the real command service, read back |
| `src/stage2/grants.ts` | one grant resolver on every render path |
| `src/stage2/projection.ts` | one projection feeding both subject and scorer |
| `src/stage2/rubric.ts` | rubric text, escalation policy, reason taxonomy, delivered |
| `src/stage2/packet3.ts` | `kpwm/scoring-packet/3` build, validate, manifest verify |
| `src/stage2/labels3.ts` | label eligibility, failing closed |
| `src/stage2/batch-a.ts`, `batch-a-store.ts` | the 18 acceptance controls |
| `verify-stage2a.sh` | fresh isolated stores, gateway-less, no provider reachable |

### 24.2 Materialization is no longer a declaration

Run `stage2a-batchA-04`, against a fresh Neo4j and Postgres on an `internal`
network:

```
scenarios 10 | setup commands 66 | verified canon decisions 12
action receipts 1 | checkpoints 18
registryDigest afeff0ff1dffdc81c6deac1cc2ca29961b7487f2481cd73bb5d1dbafb1e0a853
```

Twelve canonizations were read back out of the store and each agrees on three
facts at once: the claim carries `canon: true`, a decision record exists, and
that record names a human decider with `applicationResult: "applied"`. The
failed repair asserted this in JSON while its own sheet showed the canonization
refused.

`s04` step 129287 attempted a peer-authored claim and was **refused
`PEER_PROMOTION_FORBIDDEN`**, exactly as the baseline was at tick 62. The peer
position survives as a report, an `unreviewed` candidate, and an unresolved
contradiction. No `clm:s04-peer-tr2` exists in state.

`s05` supersession is a genuine `world_progressed`: revision 1 keeps
`1.4.0` over `2025-11-01 .. 2026-01-20`, revision 2 carries `2.0.0` from
`2026-01-20`. The baseline's evidence miswire is **not** reproduced; it remains
an audit finding.

Execution bounds are **derived** from the canonized claim values through a
closed code-owned vocabulary. A scenario cannot declare its own restriction.

Two independent store bring-ups produced a **byte-identical** knowledge export
and packet (`packetDigest 84c42bc8…`).

### 24.3 The grant leak is closed

The audit found access restrictions enforced on the source-list renderer only,
with full document text reaching six of eight scenarios through claim evidence.
There is now one resolver, and every render path goes through it.

Documents are separate resources (`sourceRefId#locator`). A source grant is the
default for its documents and a document grant may only narrow it; an undeclared
resource resolves `denied`.

Verified on the real projection: in `s08-t2` the pull request stays citable at
`metadata_only` while `#body` and `#diff-L44` resolve `denied` and render
`EXPANSION WITHHELD (grant: denied)`. In `s01-t2`, which declares no grants, the
requirement text does not appear anywhere in the projection — including through
claim evidence.

### 24.4 The packet delivers what it binds

`kpwm/scoring-packet/3`, purpose `repair-preview`, `calibrationEligible: false`,
24 items, each carrying an archived legacy payload as opaque bytes.

- The rubric is **delivered as text** (1403 bytes), not bound by hash alone.
- `packetDigest` is recomputed and read.
- Unknown fields are rejected by **key path**; archived bytes containing words
  like `canon` and `designNote` do not trip it.
- Public ids are `item-<hash>`; no `cal-NN` reaches the packet. The mapping is a
  separate file, committed by hash.

### 24.5 Acceptance: 18 cases, 49 checks, 0 failures

Every negative failed for its **own named code**. A04 and A07 are `mustBeReal`
and ran against live stores; neither is satisfied by metadata.

- **A04** — an agent attempting canonization through the command service is
  refused `CANONIZE_REQUIRES_HUMAN`; the read-back verifier rejects a decision
  recorded under a non-human actor with `SETUP_AUTHORITY_UNVERIFIED`.
- **A07** — real `applied`, `no_op`, `refused` and `failed` receipts with
  before/after digests. A refused receipt, a blocked checkpoint, mismatched
  arguments, and another attempt's receipt **all fail** the completion join.
  The `evt:s02-r1-blocked` substitution is reproduced and rejected.
- **A16** — twelve `historical_unbound` labels against a 24-item packet yield
  `usable: false` with `boundHumanLabels: 0`. The previous code returned
  `usable: true` with kappa 1.

The total is recorded because it was asked for, not as an acceptance criterion.

### 24.6 Verification

```
npm run typecheck                     clean
src/main.ts selftest                  18 / 18   unchanged
src/main.ts validate                  14 / 14   unchanged, 0 problems
src/main.ts stage2-selftest          196 / 196  unchanged
controls offline                      37 checks, 0 failures
controls store (A04, A07)             12 checks, 0 failures
packet verify (saved artifact)        0 problems, artifacts unchanged
```

Protected material re-verified byte-identical: `stage1-final/evidence.json`,
all three `lane-n-answers.json`, the corpus and oracle trees, and working-record
Sections 18-22. The twelve votes are unchanged, still `historical_unbound`.

Leak scan over all new artifacts: no canary, no credential pattern, no absolute
host path. No new module imports a provider endpoint, a credential, or `fetch`.
Zero provider calls were made.

### 24.7 What Batch A does NOT establish

- **Answer semantics are unverified.** Every candidate in this packet is an
  archived legacy payload carried as bytes. No answer in it is in the scored
  schema, and the packet is not what the owner scored.
- **The judge is not calibrated.** No vote is bound to this or any packet.
- **The comparison baseline remains UNAVAILABLE.** The label-impact report
  records `unknown` for all twelve votes rather than inventing a difference.
  Section 22's "three of twelve answers changed since scoring" stays withdrawn.
- **No live run is authorised.** The 572-dispatch ceiling is a budget.

### 24.8 Evidence

```
tmp/spikes/knowledge-plane-working-memory/stage2a-batchA-04/
  materialized/materialization.json   materialized/scenarios.json
  packet/{packet,manifest,private-mapping}.json
  controls-store.json                 controls-offline.json
  reports/{grounding-report,label-impact,batch-a-summary}.json
```

Commands:

```bash
./verify-stage2a.sh
node --no-warnings src/stage2/packet-cli.ts build \
  --materialized <dir> --archived <archived-packet> --output <dir>
node --no-warnings src/stage2/packet-cli.ts verify \
  --manifest <file> --packet <file>
node --no-warnings src/stage2/controls-cli.ts offline \
  --materialized <dir> --packet <dir>
```

### 24.9 Exact next step

Step 12 verifies this checkpoint, Step 13 is a model-switch pause, Step 14 is an
independent audit of Batch A, and Step 15 is the owner's accept-or-reject gate.
Batch B is unapproved until Step 17.

---

## Section 25 — Batch A rejected; the acceptance contract reissued

Section 24 recorded Batch A as built, run against real stores, and verified. An
independent audit at Step 14 of `stage2-calibration-repair` reproduced eleven
findings against that same saved artifact, and at Step 15 **the owner rejected
Batch A**. Section 24 is retained unchanged as the record of what was claimed;
this section is the correction.

### 25.1 What Section 24 got wrong

| Section 24 claim | Correction |
|---|---|
| "The grant leak is closed" | Closed for the source path it tested. Denied and `metadata_only` grants on a **claim** or a **peer report** still returned raw content to the subject; declaring a peer report denied even *caused* its inclusion. |
| "no `cal-NN` reaches the packet" | True of `publicId`. False of the artifact: `packet-cli.ts` serialised **whole legacy items** into `archivedCandidate.bytes`, so all 24 internal identities — and therefore the private mapping and the authored-score pattern — were recoverable from the delivered file. |
| "18 acceptance cases pass and every negative failed for its own named code" | Ten of eighteen cases never asserted their named code anywhere. A16's positive accepted `PACKET_INVALID` and never required success; A18's negative tested a regex against a hardcoded string and never invoked the dependency walker. |
| "`itemsGrounded: 24 / 24`" | The readiness filter matched problems by substring `publicId` while validation emits index paths (`$.items[3]...`). Corrupting a section digest produced real errors that the filter discarded, and global failures affected no item. |
| "the packet verify … 0 problems, artifact hashes unchanged" | Correct, and insufficient. The manifest bound the canonical object but not the exact serialized bytes: recompacting the file changes its SHA-256 and it still verifies. |
| "12 verified canon decisions … read back" | The graph decisions and claims were genuinely written and read back. The **receipt** was not: the adapter ran without `ExecutionPlane`, so command receipts lived in a process-local map and were discarded. The contract's three-way check was a two-way check, and it was never a packet-construction gate. |
| "`s08` … applied receipt" | The receipt is real. The **sheet** is not coherent: all three s08 items display `rotationHours: null` beside that applied change, and the displayed fields hash to the receipt's *before* digest while the declared digest is its *after* digest. Every scenario's events were also timestamped before the setup they depend on. |

Two further defects Section 24 did not mention: the s08 denied PR document
identities and the permitted s09 advisory / s01 changelog bodies never reached
the delivered context at all, and the retired `stage2-calibration` implicit-build
dispatch is still live at `src/main.ts:2802`.

### 25.2 What survived the audit

Not everything was wrong, and the repair keeps it:

- Real knowledge commands executed against real stores. Graph decisions and
  claims were genuinely written and read back. Materialization is not fabricated.
- The completion join correctly rejects a wrong attempt, wrong arguments, wrong
  turn, a non-applied outcome, and checkpoint substitution. Checkpoints remain a
  separate relation.
- The saved preview is calibration-ineligible and the twelve historical votes
  were not promoted. The real gate returns `usable: false`.
- Stage 1 preservation held throughout and was re-verified independently:
  selftest 18/18, fixture validation 14/14, prior Stage 2 selftest 196/196,
  and every protected file, tree and section hash unchanged.

### 25.3 The label position is unchanged

The twelve votes and their owner-selected reasons are untouched and remain
`historical_unbound`. The comparison baseline is still **UNAVAILABLE** and
"changed since scoring" is still **unknown** for all twelve. Nothing in the
audit or the rejection rebinds, rescores, or invalidates a vote. The withdrawal
of Section 22's "three of twelve answers changed since scoring" stands.

### 25.4 The reissued acceptance contract

`contracts/acceptance-batch-a-2.json`, schema `kpwm/acceptance-registry/2`,
supersedes `/1` and preserves every case id A01–A18 and all eleven reserved
Batch B cases.

The substantive change is that `failsFor` becomes an **assertion** rather than a
label. Each case now names the **enforcement boundary** that must emit the
failure and the **fault witnesses** that must be injected there. A wrapper that
catches an unrelated exception and relabels it does not satisfy a case. Added
alongside: a **checker-mutant** suite — an always-empty validator, an
always-false binding gate, an empty dependency walker, an unconditional
readiness flag — each of which must turn at least one named case red; and
explicit **report controls** for the attribution defect.

One approved correction to the Batch A preview design is recorded there as
`legacy-answer-extraction/1`: opaque candidate **bytes** are permitted, a whole
legacy **item** is not. Only the archived answer is delivered, taken as the
single occurrence after the legacy `AGENT OUTPUT` boundary and including its
trailing `DECLARED RESULT` block. Verified against the archive: 24 of 24 items
have exactly one boundary, 24 carry the declared-result block, and none of the
extracted suffixes contains an internal identity or an author-only key. The
bytes are preserved verbatim — no reparse toward the structured-first schema.
This changes what is delivered, not what is true: **candidate semantics remain
unverified and no historical vote is bound by it.**

### 25.5 Preserved identities

The rejected run is retained unchanged at
`tmp/spikes/knowledge-plane-working-memory/stage2a-batchA-04/`:

```
packet/packet.json                  590c34748f6b29170abe9093ad36857ab6260307d240295190e0fffef922961f
packet/manifest.json                9f307dc2b639c680ab1714498da0c57207b914fc285a7734b5f50b5ea0eba096
packet/private-mapping.json         cf4b339765b5ed0495dc532dd8796f34c55aef5c1c2ffd1e5cae608bc5920540
materialized/materialization.json   bc84ffa7dd3d6740c38d8c94d8f1b24a10577d62c4d667543911bea9f2f43ce4
materialized/scenarios.json         afeff0ff1dffdc81c6deac1cc2ca29961b7487f2481cd73bb5d1dbafb1e0a853
controls-offline.json               b92c70bab28816c0923c948f58ac094a904898056e4e846ae25ab78007d2c1b3
controls-store.json                 01ae5378d2d0ba83181d8f5ca9c12b189fae1b6a4d4b101673e24058b49a4149
reports/grounding-report.json       bfcb65a8de055b3917571910dc516987574d7dcce5e2e9d71be2c876331818dc
reports/label-impact.json           334475055ede073dd6bd80494452b8613374045636ca16cabc6212bb4056c624
reports/batch-a-summary.json        3dba0010a415225fb17a1fd71f77e2b090f47b41eee35f61e7a997417b6ad519
```

Packet canonical digest `84c42bc8…`, mapping commitment `b71de4e9…`. Earlier
runs and the Step 5 legacy archive are retained. No run directory is deleted or
reused; replacement work writes to a fresh versioned directory.

Human labels file `9dbcf6a9fe0fa071d5b5f9a2a61e0890ee722576eedd7a44dca626dd5f2df172`,
twelve votes, all `historical_unbound`.

Verified unchanged before this append: `stage1-final/evidence.json`, all three
`lane-n-answers.json`, the corpus and oracle trees, and Sections 18–22.
Amendments remain 0 of 5. No architecture document modified.

### 25.6 An audit protocol violation, recorded

One audit helper wrote five scratch probe scripts under `/tmp/opencode/` despite
a no-write instruction. They touched no workspace file and no saved evidence,
and they are **not** part of the accepted evidence chain. Future audits use
inline in-memory probes only. Recording this rather than quietly discarding it:
an audit that broke its own rules is exactly the kind of thing a later reader
needs to know about.

### 25.7 Position

The owner approved a 15-step pause-enabled companion amendment,
`stage2-batch-a-amendment-1`. Its `audit-baseline.md` preserves all eleven
findings verbatim. `stage2-calibration-repair` stays stopped at its Step 15 and
the 69-step parent stays paused; only acceptance of the repaired Batch A permits
handoff to the original repair's Step 16.

Batch B, human calibration, and every live call remain separately blocked.
Nothing here is evidence that the repair now works — it is the record of what
was rejected and what the replacement must prove.

---

## Section 26 — Batch A rebuilt under amendment 1

Steps 4-11 of `stage2-batch-a-amendment-1`. Every claim below rests on a command
the harness ran and logged. **This is not an acceptance record.** The repaired
Batch A is awaiting the independent audit at Step 14 and the owner's gate at
Step 15.

### 26.1 The eleven findings, and what closed each

| Finding | Repair | Proven by |
|---|---|---|
| F01 private identities delivered | `legacy-extract.ts` delivers only the archived ANSWER after the single `AGENT OUTPUT` boundary; whole legacy items stay evaluator-only | A13, A15 |
| F02 contradictory pre-turn state | Per-turn boundaries digest the fields they display; event ticks follow their scenario's setup | A07, A10 |
| F03 label bindings bypassable | The gate consumes an independently verified manifest and requires packet, rubric, context and candidate bindings | A16 |
| F04 restricted content still delivered | Denied claims and peer reports are OMITTED; `metadata_only` drops the value key | A08 |
| F05 document resources unreachable | `documentRefs()` enumerates every declared document; `contentIdentity` digests bytes | A05, A09 |
| F06 history and exposure wrong | `history` carries prior turns with per-arm availability; availability falls back document → source | A10 |
| F07 no durable receipt | The adapter runs WITH `ExecutionPlane`; the stores are reopened and three sources joined | A01, A04 |
| F08 schemas incomplete | Closed schemas validated before dereference; the manifest binds exact file bytes | A11, A12, A13 |
| F09 vacuous controls | `failsFor` is asserted from the real boundary; a checker-mutant suite proves the checkers can fail | A16, A18, MUTANT |
| F10 readiness mis-attributed | Problems attributed by index and public id; global failures block every item; `not_run` never reads as pass | REPORT |
| F11 implicit-build dispatch live | `stage2-calibration` removed from `main.ts` | A17 |

### 26.2 The six probes that previously succeeded

Re-run against the new artifact, all now **blocked**: the private mapping is not
recoverable from delivered bytes (0 of 24); labels declaring `bound` with no
content hashes are refused; a caller-truncated and resealed packet is refused;
an empty packet with empty labels is refused; four malformed-schema mutants are
rejected; and recompacted file bytes fail the exact-byte binding.

### 26.3 Verification, run `stage2b-04`

```
npm run typecheck                     clean
src/main.ts selftest                  18 / 18   unchanged
src/main.ts validate                  14 / 14   unchanged, 0 problems
src/main.ts stage2-selftest          196 / 196  unchanged
materialize                           10 scenarios, 12 grounded canonizations,
                                      66 durable receipts, 38 turn boundaries
controls offline                     131 checks, 0 failures
                                     100 negatives, all 100 asserting a named code
controls store (A04, A07)             12 checks, 0 failures
packet verify, writes denied          0 problems, no file created
```

Cases: A01-A18, plus 8 checker mutants and 7 report controls. The totals are
recorded because the registry asks for attributable evidence; **a total is not
an acceptance criterion**, and the previous Batch A was green on 49 checks while
every finding above was live.

Harness command ledger, `commands.ndjson`: `packet-build 0`,
`controls-offline 0`, `packet-verify 0`, `reports 0`.

### 26.4 Artifact identities

```
materialized/materialization.json   36b2e23cf1bc18027d5d312927db3e0e66b163cd33f0081edd417aa54a210f29
materialized/scenarios.json         7f568942f98eb52f4f9d790fe3717294eac8caf51e275b9e397d01d4b5814451
packet/packet.json                  660127ca77382c91b4846ca5a5a3a5359f3824f1e1d982599b5660f9da001142
packet/manifest.json                077b581c3f11ba1b7a60f3094627535d94d747e9d9e20612d406312416755d1c
packet/private-mapping.json         25a02aa30809dca2b483180ee9cee3bd300a85759c977d4e6ac7ef156cdf1a9d
packet/private-extraction.json      c53a93da982fd96be687b5ba24040fe7303264e3ebc4cacc628db5a2ef69a06c
controls-offline.json               bfa6390067b023361121f453615b332e0a66becb464d445ac42478f4a0943722
controls-store.json                 274cbf46916679566d31c17a670d1425f9b8a8769697d07081f0a0a49c1fea68
reports/grounding-report.json       be0bd5de1a90f1387f46243a7f2e6ca8cdac6afee33d6f4fb2e9b250b5a50542
reports/label-impact.json           877ad2b3b544cec04f9cdeb9d4513c26b4c31d6b666f8902f1d933ec68d71025
reports/batch-a-summary.json        4cd4b045888209a825064a930001558160c836fc46a1ed3658ad41cefdb957a9
```

Packet canonical digest `bc78aeb9…`, mapping commitment `24d046c8…`.
The private mapping and the extraction provenance are separate files and are
**not** delivered.

The rejected run `stage2a-batchA-04` is preserved byte-for-byte, as are all
earlier runs and the Step 5 legacy archive. Protected Stage 1 evidence, the
corpus and oracle trees, and Sections 18-25 are unchanged. Leak scan over 22
evidence files: no canary, no credential pattern, no absolute host path.

### 26.5 Labels

Unchanged. Twelve votes, all `historical_unbound`, owner-selected reasons
preserved verbatim; file hash `9dbcf6a9…`. The label-impact report records
comparison baseline **UNAVAILABLE** and `answerChangedSinceScoring: unknown` for
all twelve. The calibration gate reads `usable: false`, `boundHumanLabels: 0`
against a 24-item expected set.

### 26.6 What this still does not establish

- **Answer semantics remain unverified.** Every candidate is an archived legacy
  answer carried verbatim. No answer here is in the scored schema, and this
  packet is not what the owner scored.
- **The judge is not calibrated** and no vote binds to any packet.
- **Batch A is not accepted.** It awaits an independent audit and the owner's
  decision.
- **No live call is authorised.** Zero provider calls were made; no new module
  references a provider endpoint, a credential, or `fetch`.

---

## Section 27 — Step 12 correction: a control that mutated shared evidence

The Step 12 verification found a defect in the apparatus itself, and it is
recorded here rather than quietly fixed.

**What was wrong.** A17 proves that `verify` works with writes denied. It did so
by `chmod`-ing the packet directory to `0500` and back to `0700` — on the real
evidence tree. The acceptance rules require that negatives "mutate in memory or
against isolated copies, never by editing... shared source", and a control that
changes the permissions of the artifact it is checking is doing exactly that.
File contents were never altered, but the rule is about the mechanism, not the
damage.

**What changed.** A17 now copies the packet directory to a temporary location
and denies writes on the copy. Re-checked afterwards: the evidence tree's file
contents *and* permission bits are both unchanged by a full offline run.

**Why Section 26 still stands.** The corrected suite was re-run end to end as
`stage2b-05`. Every artifact is **byte-identical** to `stage2b-04`:

```
materialized/materialization.json   36b2e23c…      packet/packet.json          660127ca…
materialized/scenarios.json         7f568942…      packet/manifest.json        077b581c…
packet/private-mapping.json         25a02aa3…      packet/private-extraction   c53a93da…
controls-offline.json               bfa63900…      controls-store.json         274cbf46…
reports/grounding-report.json       be0bd5de…      reports/label-impact.json   877ad2b3…
reports/batch-a-summary.json        4cd4b045…
```

131 offline checks, 100 negatives all asserting a named code, 12 store checks,
0 failures; readiness 24/24 with 0 failed, 0 not-run and 0 global problems. The
identities cited in Section 26 are therefore accurate, and the pipeline is
reproducible across independent store bring-ups.

**Position unchanged.** Batch A is still **not accepted**. The independent audit
at Step 14 and the owner's gate at Step 15 remain. No vote is bound, no judge is
calibrated, and no live call is authorised.

---

## Section 28 — Scope correction: the Stage 2 benchmark is abandoned, the harness is archived and removed (2026-09-09)

This section supersedes the *direction of travel* of Sections 22–27. It does not
edit them, and it does not touch Section 21.

### 28.1 What the owner decided

The Stage 2 programme — treatment arms W0/W1/W1A/W2/W3, calibration, judging,
sealed scoring packets, the acceptance registry, and the two repair cycles that
followed — is **abandoned as out of scope**. It was never the question worth
answering here, and the repeated repair loop consumed effort disproportionate to
any result it could produce.

The replacement question is narrower and is about implementation, not efficacy:

> Can the working-memory mechanisms identified in Section 2 be implemented in a
> simple, sane manner for the planned runtime?

Whether working memory *improves model performance* is explicitly **not** being
asked, and no artifact produced under the new plan may claim to answer it.

### 28.2 Disposition of the Stage 2 claims

- **Batch A was never accepted**, and is now never going to be. Section 24's
  readiness claim, Section 26's fix claims, and Section 27's `stage2b-05`
  byte-identity claim all stand as *recorded history* and none of them is
  accepted evidence.
- The Step 14 audit's unresolved defects — a durable-receipt gate nothing
  consumed, checker mutants that stayed green, unrendered projection history,
  the reconstructible public ids, the manifest duplicate reducing label coverage
  to 23 — are **not being repaired**. They are the reason the apparatus is being
  discarded rather than salvaged.
- **Twelve votes remain `historical_unbound`** and the comparison baseline
  remains **UNAVAILABLE**. Nothing was relabelled, rescored, or rebound. The
  label file was archived byte-identical at
  `9dbcf6a9fe0fa071d5b5f9a2a61e0890ee722576eedd7a44dca626dd5f2df172`.

### 28.3 Stage 1 is untouched

**Section 21 stands in full**: Lane N selected, by hard-gate elimination on gate
4 plus the owner's non-compensatory integrity requirement — not by score. Its
caveats stand with it. The Stage 1 evidence under
`tmp/spikes/knowledge-plane-working-memory/stage1-final/` was not modified;
`evidence.json` still hashes to
`cd0ce571991150822564cfddd7c9110f18a8a37ab170853e2a739a1f0ad29544`.

The Step 64 obligation to amend the architecture documents is **still open and
still ungated**. No architecture document has been modified.

### 28.4 The harness was archived, then removed

`spikes/knowledge-plane-working-memory/` no longer exists in the working tree.
Before deletion the whole tree — 103 files, including uncommitted and untracked
work, contracts, fixtures, and the historical labels — was archived to:

```
tmp/spikes/knowledge-plane-working-memory/retired-2026-09-09/
  source.tar.gz            520ba1d564423e5b51ae02ee807c8c47373d16aae055a317f56ac343d77ebcd6
  source-manifest.sha256   per-file digests, repo-relative paths
  archive.sha256           digests of the tarball, manifest, and scratch scripts
  scratch/*.mjs            five ad-hoc audit probes recovered from /tmp/opencode
```

The archive was verified **before** anything was deleted: extracted to a
temporary directory and checked with `sha256sum -c`, 103/103 OK. It is local
(`tmp/` is gitignored) and is not included in this repository, and neither are
the scratch probes.

Also removed: sixteen local Docker image tags
(`agent-runtime/knowledge-plane-working-memory:{smoke-h1..h4, stage1-initial,
stage1-final, stage2a-batchA-01..04, stage2b-01..05}` and `kpwm-dev:local`).
**These were deleted, not exported** — the runnable historical images are gone.
Their digests survive in the run evidence and in this record. No prune was run;
no shared image, base layer, build cache, anonymous volume, or other spike was
touched. The old spike had no surviving named containers, networks, or volumes.

**All run evidence under `tmp/spikes/knowledge-plane-working-memory/` is
retained unchanged**, including `stage1-final/`, `stage1-initial/`, the
`smoke-h*` runs, `stage2-repair/`, `stage2-repair-v2/archive/`, the rejected
`stage2a-batchA-*`, and the unaccepted `stage2b-*`.

### 28.5 What replaces it

A small standalone prototype at `spikes/working-memory-feasibility/`, built
fresh with no dependency on the deleted harness. One vertical slice: bounded
task-local context, provisional observations kept distinct from authoritative
knowledge, stale-reference refresh, and durable continuation across a process
restart, persisted in Neo4j per the Section 21 decision.

Bounds fixed in advance: a three-hour execution budget, ordinary deterministic
tests rather than an acceptance framework, and at most three live model requests
for a single smoke test. No arms, no graders, no calibration, no statistical
gates. If the mechanics need substantially more machinery than designed, the
complexity itself is the finding and the spike stops.
