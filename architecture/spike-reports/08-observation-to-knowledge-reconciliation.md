# Spike 08: Observation to knowledge reconciliation

**Outcome: pass**, scoped. The path from a retained source to human-approved,
versioned, retrievable knowledge was implemented and demonstrated end to end on
synthetic data with two live extractions and two real owner decisions.

This establishes that the mechanics are implementable and small. It establishes
nothing about extraction accuracy, and nothing about whether the resulting
knowledge is true.

## Question

Can an evidence-backed observation become durable, inspectable knowledge through
a small, understandable reconciliation workflow — extraction, comparison with
existing knowledge, explicit human approval, versioned persistence, and
retrieval by a later task?

Implementation feasibility only. Whether extraction is *good* was explicitly not
asked, and no artifact here answers it.

## Environment

```text
host              Linux, Docker 29.0.0, Compose 2.40.3, Node v24.14.1 on the host
image             node:24.6.0-bookworm-slim@sha256:9b741b28148b0195d62fa456ed84dd6c953c1f17a3761f3e6e6797a754d9edff
database          neo4j:2026.07.1-community-ubi10@sha256:4c470275ab23a8a330d302ca98d3d440cd4b09d71b3fa3c05144999e5d9b241d
dependencies      neo4j-driver 6.2.0 · @langchain/anthropic 1.5.8 · @langchain/core 1.2.9 · @anthropic-ai/sdk 0.115.0
model             claude-opus-5, max_tokens 512, compatibility profile claude-cli/2.1.87 revision 1
prototype         spikes/knowledge-reconciliation/
evidence          tmp/spikes/knowledge-reconciliation/demo/
```

The Anthropic subscription transport from
[spike 03](./03-anthropic-parity.md) was reused unchanged — `candidate.ts`,
`profile.ts`, `canonical.ts`, copied into the image at their repository-relative
path. Its live parity harness was not used.

## Method

Three synthetic policy documents about one narrow question: how often production
service credentials must be rotated, in whole days. Harbor and Cedar are
invented; no real organisation, system, or credential appears anywhere.

```text
harbor-policy@1    45 days   Harbor has no prior recorded value
cedar-policy@1     90 days   loaded first as a labelled synthetic baseline
cedar-policy@2     30 days   states the 90 was a transcription error
```

Project, subject, predicate, source identity, and the policy interval are
**host-owned**, declared in `fixtures/manifest.json`. The model supplies only a
number and a quote.

What ran, in order:

1. `./run.sh check` — typecheck. Exit 0.
2. `./run.sh test` — 28 tests against a real Neo4j. Exit 0.
3. The Cedar baseline, accepted through the real write path with
   `origin: synthetic`, `operator: spike-fixture`, and a rationale saying so.
4. **Two live requests, the entire authorized budget.** One document each, one
   response each, no tools, no agent loop, no retries.
5. Both outputs validated and staged as pending proposals. Nothing accepted.
6. A 38-check verification of the actual outputs against the retained bytes.
7. The owner reviewed both and approved both.
8. The decisions applied through the same operation the tests exercise.
9. Database restarted; a fresh process read the results back. 23 checks.

## Acceptance

| Property | Result |
|---|---|
| New information stays pending until approved | Pass |
| Same-source replay adds no duplicate claim or evidence | Pass |
| Same source, different reading, cannot overwrite a cited candidate | Pass |
| Corroboration adds evidence and moves no authority | Pass |
| A conflicting value does not overwrite the accepted one | Pass |
| Rejection leaves accepted knowledge unchanged | Pass |
| An approved correction preserves the prior revision and its rationale | Pass |
| A stale approval is refused, with nothing partial persisted | Pass |
| Re-applying one decision is idempotent | Pass |
| Reusing a decision id for different content is refused | Pass |
| Concurrent approvals of one target: one wins, one refused | Pass |
| Approvals cannot be moved to another proposal, digest, or action | Pass |
| Unknown sources, fabricated quotes, wrong scopes refused | Pass |
| A source identity cannot be rebound to different bytes | Pass |
| An interval change is refused, not relabelled a correction | Pass |
| Accepted reads are scoped and carry no candidate payload | Pass |
| Malformed model output rejected rather than coerced | Pass |
| Retries disabled at both layers; ceiling enforced before dispatch | Pass |
| Live outputs attributable to retained bytes at recorded offsets | Pass (38/38) |
| Owner decisions durable and readable by a fresh process | Pass (23/23) |

28 automated tests, 61 verification checks over the live run. Every command's
exit status was preserved; no result below came from a filtered log.

### The live run

| | Harbor | Cedar |
|---|---|---|
| Extracted value | 45 days | 30 days |
| Quote | `production service credentials must be rotated every 45 days` | `production service credentials must be rotated every 30 days` |
| Resolved at | bytes 236–296, unique | bytes 454–514, unique |
| Prior accepted | none | 90 days, revision 1, synthetic |
| Disposition | `new` | `conflict` |
| Owner decision | `accept_new` | `correct` |
| Result | revision 1 = 45 | revision 2 = 30, revision 1 retained |
| Usage | 374 in / 58 out | 387 in / 138 out |
| Stop reason | `end_turn` | `end_turn` |

Both extractions were well-formed on the first attempt and needed no unwrapping.
That is two data points about one model on three short documents, and is not a
measurement of extraction reliability.

## Findings

**The mechanics are small.** 2,017 lines of implementation across four modules,
721 lines of tests, four runtime dependencies. The rules module imports no
driver and no network client, so reconciliation is testable without either.

**Binding an approval to a digest and a state token is the load-bearing part.**
`apply` takes both as explicit arguments and re-checks the accepted head inside
the write transaction. Without that, "approve the correction from 90 to 30"
would be applicable to whatever the claim had become by the time it was applied.

**Order the write so the rollback is provable.** The decision and evidence are
written *before* the accepted state is re-checked, so the stale-approval test
asserts a refused decision left no node behind. A pre-check alone would have
nothing to roll back and would demonstrate atomicity by assertion instead of by
test.

**Serialize on the key; do not read-then-check.** A `MERGE`-plus-`SET` lock node
per knowledge key makes concurrent approvals of one target resolve as one winner
and one `STALE_TARGET`, with the `(keyId, revision)` uniqueness constraint as the
backstop. This is the same trap [spike 07's working record](./07-knowledge-plane-and-working-memory-working-record.md)
documents: `MATCH ... WHERE rev = $expected SET ...` takes no write lock before
the read, so two writers can both pass it.

**Replay needs an incorporation check, not just deterministic ids.** Candidate
and evidence ids derived from `(snapshot, key)` stop duplicate nodes, but after
acceptance a re-read of the same document still compared as fresh corroboration
against the new state — one document appearing to support itself twice. The fix
is to detect that the accepted claim already cites this evidence and return the
existing decided proposal. This was found by a failing test, not by review.

**A correction must not inherit the old evidence.** Text that supported a wrong
number is not support for the right one, so a correction attaches only its own
evidence and the prior revision keeps its own. Corroboration is the opposite: it
accumulates evidence and deliberately does not move
`establishingDecisionId`, so repetition cannot promote a claim.

**Refusing the interval case was cheaper than modelling it.** A source about a
different period is refused as `INTERVAL_CHANGE_UNSUPPORTED` rather than
labelled a correction. Real policy progression needs the bitemporal machinery
spike 07 flagged as having no reference implementation; this prototype declines
it visibly instead of quietly getting it wrong.

**The gate should be tiered, and this prototype's is not.** Every disposition
here requires the same operator ceremony. In review the owner observed that an
uncontested new claim with verified attribution is near-ceremonial, while
overwriting an accepted value is the moment that genuinely needs a person — and
that the agent should judge the mechanical part and escalate one crisp question.
The mechanical judgment is already fully automated: schema, scope, uniqueness,
offset resolution. What is missing is a policy layer that routes `new` with
verified evidence differently from `conflict`. **Recorded as the main design
conclusion, and not implemented here.**

**A model client with no route to the database is easy and worth it.** The
extractor sits on a separate network with no Bolt address. It cost one Compose
stanza and makes "the model cannot write knowledge" a property of the topology
rather than of the code's good behaviour.

**Reserve the request slot before dispatch.** An exclusive-create file per
attempt means a crashed or provider-rejected request still spends its budget,
and the ceiling survives process restarts and continuations. A counter
incremented after success would have under-counted exactly the requests that
went wrong.

## Architecture impact

None required. The spike operates inside the
[Section 21](./07-knowledge-plane-and-working-memory-working-record.md) decision
rather than revisiting it: Neo4j canonical for structured knowledge, writes only
through a command service, no human-facing Cypher surface, execution left to
Postgres and here explicitly simulated.

Three things it contributes for a future design:

1. A concrete shape for source, candidate, proposal, decision, evidence, and
   claim revision as separate records, with approvals bound to a digest and a
   state token.
2. Evidence that the `04-memory-system.md` outcome vocabulary — new, reinforced,
   superseded, conflicting — maps onto implementable dispositions, provided
   correction and world progression stay distinct.
3. The tiered-gate finding above, which is a HITL surface requirement rather
   than a storage one.

The [Step 64 obligation](./07-knowledge-plane-and-working-memory-working-record.md)
to reconcile the architecture documents with the Lane N decision remains open
and untouched.

## Limitations

- **Three synthetic documents, one predicate, one integer value.** No entity
  resolution, no fuzzy matching, no vector search, no ontology.
- **Two live requests.** Nothing here measures extraction reliability, and a
  first-attempt success rate of 2/2 is not a rate.
- **Attribution is not truth.** Every automated check verifies that a quote sits
  where the record says it does. The claim's correctness rested entirely on the
  owner's judgment.
- **The Cedar correction was accepted because the source asserts the 90 was a
  typo.** The system cannot verify that assertion; it only offered `correct` as
  an available action.
- **Pending-exclusion was demonstrated structurally**, by an accepted read whose
  query starts at accepted revisions, and by an automated test with a real
  pending proposal. At the end of the demo no proposal remained pending, so the
  live store shows `0 pending` rather than a pending item being excluded.
- **Genuine policy change over time is unimplemented**, by refusal.
- **No RBAC.** Neo4j Community cannot enforce command-service-only writes. The
  boundary is network topology plus discipline, and the store-layer exposure is
  accepted and unmitigated, exactly as in spike 07.
- **No execution plane.** Work items, attempts, events, and scheduling are
  simulated; nothing was integrated with Postgres or LangGraph.
- **Single-process concurrency only.** The race test runs two writers against one
  database from one process. No multi-container or killed-process durability
  test was performed beyond a clean database restart.
- **One `run.sh check`/`test` cycle each on one host.** No cross-platform claim.

## Reproducing

```bash
cd spikes/knowledge-reconciliation
./run.sh build
./run.sh check     # typecheck; no database, no network
./run.sh test      # 28 tests against a disposable Neo4j
```

Offline and repeatable. The live extraction is **not** repeatable without
spending new provider requests, and the ledger under
`tmp/spikes/knowledge-reconciliation/demo/extraction/ledger/` already records the
authorized budget as spent.

Retained evidence:

```text
tmp/spikes/knowledge-reconciliation/demo/
  sources/      staged source identity and digests
  extraction/   the actual model outputs, usage, and the request ledger
  proposals/    the pending proposals as reviewed
  decisions/    the owner's decisions and their outcomes
  readback/     accepted state and history after a database restart
```

The demo database volume `okr-demo_neo4j-data` is retained deliberately. Tests
run under a separate Compose project and cannot delete it. The disposable
`okr-test`, `okr-check`, and `okr-build` projects were torn down with their
volumes; no container, network, or volume belonging to another spike was
touched, and no prune was run.

One **unlabelled anonymous volume** (`b66c8f6d…`) was created during the run
window and is now dangling. The Neo4j image declares an anonymous volume, so it
is very likely this spike's, but it carries no Compose project label and
ownership cannot be established from the volume itself. It was **left in place**
deliberately: deleting an unattributable volume is the worse error, and the host
already held six similar anonymous volumes before this spike ran.

No credential appears in any artifact; the scan compared against the actual
token values, not against words that resemble them.

## Process note

One Verify step failed and stopped the run. The failure was in a credential scan
written during that step, whose pattern matched the provenance field name
`refresh_used` — the field that records refresh having *not* happened. A
narrowed scan comparing against the actual token values passed 38/38. The
failure and its cause are recorded here rather than quietly corrected, because
the alternative — adjusting a check until it passes and reporting only the final
run — is how a verification stops being one.
