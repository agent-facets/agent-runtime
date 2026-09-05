# Spike 07 harness: knowledge plane and working memory

Throwaway P0 spike. Two questions, in two stages:

1. **Stage 1.** Which canonical knowledge architecture serves this system —
   Markdown canonical with a Postgres projection (**Lane M**), or Neo4j canonical
   with Markdown sources (**Lane N**)?
2. **Stage 2.** What is the minimum working-memory mechanism that materially
   improves long-horizon and cross-agent task performance?

Stage 1 makes **zero live model calls**. Retrieval uses frozen literal vectors.
Every measurement network is `internal: true` and therefore gateway-less, and
nothing is published on a host port.

## Running it

```bash
./verify-stage1.sh                       # full, citable run: 3 repeats, all families
./verify-stage1.sh --repeats 1 --family K   # subset: apparatus self-test only
./verify-stage1.sh --keep                # leave containers, networks, volumes in place
```

A full run is **3 repeats with no lane, family, or case restriction**. Anything
narrower writes `evidence.subset.json` and never `evidence.json`, so a subset
cannot be cited by citing the canonical filename.

Evidence lands in `tmp/spikes/knowledge-plane-working-memory/<run-id>/`, which is
git-ignored. The run directory is refused if it already exists and is non-empty:
a stale bundle must not join a later result.

### Exit codes

| Code | Meaning |
|---:|---|
| 0 | Valid completed research. **Includes an inconclusive result.** |
| 1 | Measured negative |
| 2 | Usage |
| 3 | Harness fault |
| 4 | Sanitization violation |

Exit 0 does not mean a lane won. An inconclusive Stage 1 is a valid research
outcome and exits 0.

## Layout

```
src/knowledge/     the backend-neutral contract: entities, commands, queries, errors
src/contract.ts    pins, schema versions, the deterministic clock, timeouts
src/canonical.ts   canonicalisation, declared volatility, digests
src/evidence.ts    single-object emission and the in-container leak guard
src/cases.ts       the case registry: oracles, controls, anchors, pairings
fixtures/          the image-baked manifest of pins and edition limits
compose.yaml       stateful stores only, per lane, no published ports
verify-stage1.sh   the driver
```

```
corpus/input/      source-plane fixtures, mounted read-only into BOTH lanes
  corpus.json        entities, sources, work items, one peer record
  mutations.json     the 77-step frozen script
  queries.json       the 24 golden QUESTIONS, with no answers
  vectors.json       frozen retrieval inputs: vocabulary, vectors, fusion weights
oracle/            independently authored ANSWERS — NEVER mounted into a lane
  expected-mutations.json  expected refusals and terminal invariants
  expected-queries.json    the expected answer to each question
  judgments.json           graded relevance for the ranked question
src/lane-m/        Markdown-canonical adapter, Postgres projection, read surface
src/lane-n/        Neo4j-canonical adapter and its Cypher read surface
src/execution/     the execution plane, Postgres in BOTH lanes
src/coordination/  the shared publication sink
src/golden.ts      answer-versus-oracle comparison, runs only in the comparator
```

### Subcommands

```
selftest              apparatus self-test, no network, no stores
validate              the frozen corpus, questions, and oracle
lane-m-script         apply the mutation script, offline smoke path
lane-m-answers        answer the 24 questions; emits answers and NO verdict
lane-m-projection     migrate, project, rebuild, mark stale, repair
lane-n-answers        answer the 24 questions from the graph
coordination-controls feed integrity, republication, non-promotion, peer-absent
compare-golden        score emitted answers against the oracle
compare-lanes         export equivalence and published-feed byte identity
```

## Load-bearing decisions

**The driver collects; it does not assert.** Every acceptance map and every
digest is computed inside the pinned image from collected bundles, so the claims
and the code making them stay on the same version. The driver owns only
cross-repeat facts and names them as such.

**Containers write no files.** Each prints exactly one JSON object to stdout. The
driver owns all persistence, so a container that cannot write cannot corrupt a
bundle — and a container that exits 0 having printed nothing is a fault, not a
pass. Node exits cleanly when the event loop empties with a promise still
pending, which is exactly the shape of a rendezvous that never completed.

**Acceptance is the elementwise AND across all three repeats.** Taking repeat 1's
map would launder a repeat-2 failure. Criteria that need more than one repeat are
omitted rather than recorded as `false` when `repeats < 2`, so a subset cannot
look like a failure it never tested.

**An empty acceptance map is a fault.** `Object.entries({}).every(...)` is `true`,
which is how a map that was never populated turns into a green run.

**The oracle is never mounted into a lane container**, and `.dockerignore`
excludes it from the image. It is mounted read-only into a network-less
comparator container at the compare stage. Lane output is digested before
comparison begins, and the driver has no path from compare back to execute.

**The knowledge contract imports no store driver, filesystem, or network client.**
Checked as source text by `k02`, because an import that is present but unused
would still be invisible to a runtime check — and it is exactly what precedes a
contract that has quietly grown one lane's shape.

**Faults are anchored on durable state, never on elapsed time.** Every kill,
restart, and stale-write release fires from a committed row, an observed lock or
wait edge, or an arrival record. A sleep before a kill is the most reliable way
to produce a result that cannot be reproduced. No value in `TIMEOUTS` is a fault
trigger; every one of them expiring is a harness fault.

**Duration is classified, not measured**, everywhere except the one declared
exception: Neo4j Community's offline dump requires stopping the database, and
"how long is the knowledge plane down to back it up" is a named deliverable. That
number is reported as a poll-bounded range and labelled as such.

**Only predeclared volatile values are canonicalised away.** Belief states, error
codes, freshness blocks, version tokens, and evidence counts are *not* volatile:
ranking them away would let a real regression produce an identical digest. A field
discovered to be volatile mid-run is a **harness defect**, not a silent addition
to the list — widening it after seeing results is how three repeats are made to
agree by fiat.

**Arrays are never sorted by the canonicaliser.** Order is the answer for ranked
retrieval, path sequences, and revision chains. A collection whose order is
genuinely irrelevant declares itself a set at the call site and is sorted there,
by a declared key, with a digest tie-break so the order is total.

**Every case declares its oracles, and the summariser refuses to compute
acceptance without them.** Anti-tautology is structural rather than a
per-criterion habit. Every case also declares a **control that must fail for its
own named reason**; a detector with no failing mutation is unvalidated and its
criterion is withheld.

**Mitigation lanes and cases are mechanically paired.** A selection is expanded to
include the stock case a safeguard is supposed to improve on, so running a
safeguard alone is impossible.

**Bounded races are classified as such.** Nothing loops a participant body, so a
trial is one isolated repeat and n = 3. A bounded case reports an outcome *set*,
is excluded from every digest by construction, and is never called race-free
because no failure appeared.

**Peer reports are a distinct type.** No call in the contract returns claims and
attributed reports in one collection, and none may be added. Non-promotion is
enforced by the type system rather than by a filter that could be forgotten.

**Non-promotion is proved in both directions.** A claim citing the peer report is
refused; the same subject established by a human on a real source commits.
Refusal alone would be indistinguishable from an inability to write the claim at
all, and the architecture would be taking credit for a limitation.

**The coordination sink is shared by both lanes.** Byte identity between two
independently written serialisers would test two serialisers; byte identity from
one writer tests what each lane *decided to publish*. The hash chain links within
one publisher's namespace only — chaining across publishers would make one node's
feed depend on another's, which is the coupling the plane exists to avoid.

**Both lanes run the same execution plane.** Work-item identity, run attempts,
and the idempotency ledger live in Postgres in *both* lanes, so the comparison is
about knowledge authority rather than about who happens to own the ledger.

**Atomicity is reported honestly, not levelled, and is derived per lane.** The
shared policy module deliberately does not name an atomicity class, because any
class it named would be one of the two lanes lying: a file tree has no
multi-object transaction and a graph does. The policy emits a plan shape — how
many canonical objects it touches, and whether it crosses a boundary no store
controls — and each adapter derives its own class. Lane M writes one file
atomically through temp-then-rename, so a single-object plan is genuinely `A1`,
anything wider is `A2` behind a durable intent record, and erasure or publication
is `A3`. Lane N's transactional advantage is a measured result.

**Each lane implements its own read surface.** The policy module is shared
because the *rules* must be identical; the traversal is not, because how well a
store answers a graph-shaped, temporal, provenance-carrying question is the thing
being measured. Lane N's structural questions run as real Cypher against real
relationships. The questions that are *not* graph-shaped — audits, work items,
coordination, hybrid ranking over frozen vectors — share one implementation over
the neutral snapshot, because a difference there would be a difference in
arithmetic rather than in storage, and inventing one would manufacture a result.

**A lane is asked the question and never told the answer.** The 24 golden
questions and the frozen retrieval vectors are *inputs* and live with the corpus,
because a lane cannot answer without them. Every expected answer and every graded
judgment lives in the oracle and is mounted only into the network-less
comparator. The validator checks that each question asked matches the oracle's
copy of the same question exactly, so the two trees cannot drift into asking
different things.

**Golden queries are answered from canonical state.** All 24 declare
`maxStalenessMs: null`, and the contract says `null` requires a canonical read,
so serving them from the projection would answer a question nobody asked. The
projection is exercised where it genuinely is the subject: freshness, rebuild,
stale marking, and the retrieval index.

**A rebuild that reproduces its digest is paired with one that must not.** The
projection digest is taken over the projected *rows*, not over the vault, and a
rebuild from a deliberately truncated canonical set has to produce a different
digest. Without that control the equality check is satisfied by a rebuild that
produced nothing.

**No projection is not a fresh projection.** A missing freshness row reports
`unknown`, never `fresh`. A lane with no derived structure at all would otherwise
pass the freshness gate by having nothing to be stale.

**Source text is never copied into canonical knowledge.** Evidence carries a
locator and an `excerptHash`, never the excerpt. The source plane owns its own
content; a store that inlined it would take authority it does not hold and
inherit retention and disclosure obligations for a document it does not own.

**A human decision that authorised a change survives as a record.** Otherwise the
correction path is unauditable and `StaleDecisions` has nothing to report. A
decision names the revision it *produced*, not the one it was read against —
naming the prior revision would make every applied decision stale the instant it
committed.

**The intent record carries the plan, not just its hash.** A hash makes an
interruption detectable and leaves it unrepairable; re-deriving the plan would
plan against a world that has already moved. Every op is idempotent, so replaying
a complete plan over a partially applied one converges.

## Inherited constraints

From spike 06, imported rather than re-litigated: one migrator under an advisory
lock on its own session; an `error` listener on every pooled client; pool
`max >= 2` for any component that acquires a second connection while holding one;
retention by reachability rather than by date; terminal success is never evidence.

From spikes 01 and 02: the Obsidian MCP listener is container-loopback only and is
reached through the stock NGINX sidecar sharing its network namespace; readiness
asserts the CLI is *armed* by running a command; secrets reach config by path and
never by argv or environment.

## Known limitations

- **Neo4j Community has one user database.** Per-case database isolation is
  unavailable, so cases that could depend on residual state get a fresh container
  and a fresh volume instead. That cost is charged to the cost dimension and is
  a genuine property of the lane, not a harness artifact.
- **Existence, type, and key constraints, graph types, RBAC, CDC, and online
  backup are Enterprise-only.** Every invariant that consequently moves into the
  command service is listed by name in the report.
- **`POSTGRES_HOST_AUTH_METHOD=trust` and `NEO4J_AUTH=none`** are defensible only
  because these networks are gateway-less and unpublished. The evidence keeps
  saying so rather than implying a hardened posture.
- **Obsidian's GUI-only surfaces** (Graph View, Canvas, Bases) are assessed by
  capability inspection and documented behaviour, not driven headlessly. Lane M
  is not credited with a correction path that was never exercised.
- **The corpus is small and synthetic.** It can show that a lane *cannot* express
  something. It cannot show that a lane scales.
- **Retrieval uses lexical-substitute vectors.** They measure whether structure
  adds signal beyond lexical similarity. They do not predict behaviour with a
  production embedding model.

## What must not be inferred

- Both lanes exist and both meet the contract. **Nothing has been scored**: no
  matrix has run, no fault has been injected, and there is no winner and no
  margin.
- Both lanes answering all 24 golden questions, and producing byte-identical
  neutral exports, is evidence that the comparison is *fair*. It is not evidence
  that either store is better.
- Lane N's transactional advantage is a measured capability difference. What it
  costs Lane M is measured in the fault matrix, not inferred from it.
- The offline `lane-m-script` path runs with an in-memory idempotency ledger and
  no projection. It is a smoke path for development and is never evidence.
- A third architecture — **Lane R**, relational-canonical claims in the Postgres
  this system already runs, with graph queries served by recursive SQL — is
  **deferred, not rejected**. It was never measured. Every Stage 1 conclusion is
  phrased as "the better of the two measured lanes", never "the best canonical
  model".
- DICE, ARC-Mem, Brigade, and Multica are design references. No code or text from
  any of them is vendored here. Brigade has no licence at all; Multica's terms add
  conditions beyond Apache 2.0.
