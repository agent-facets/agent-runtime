# Working-memory feasibility spike

**The question:** can the working-memory mechanics from the systems already
researched be implemented in a **simple, sane** way for this runtime?

**Not the question:** whether working memory improves model output. Nothing here
measures that, and nothing here may be cited as evidence about it.

**Answer: yes.** 747 lines of ordinary TypeScript excluding tests and demo — and
a large share of that is comment — with one dependency and one database already
chosen for other reasons. 12/12 tests pass against a real store. The live-model
portion was **not run** — see [Limits](#limits).

## What it does

A work item gets a small persisted context. Between turns it is refreshed
against current knowledge, rendered under a budget, and handed to the model. The
model may keep or drop **provisional observations** and nothing else.

```text
prepareTurn(workItemId)
   load latest revision            ← store, not the transcript
   resolve declared knowledge      ← host declares it; the model never does
   drop withdrawn / missing refs
   drop notes whose basis moved
   assemble under budget           → the text the model sees
        │
        ▼
   model call                      ← any TurnClient: scripted or live
        │
        ▼
completeTurn(ops)
   validate + apply remember/forget
   append one revision, guarded on the revision that was read
```

## State

```ts
type WorkingContext = {
  workItemId: string;
  revision: number;
  knowledge: Array<{ id; revision; text; pinned }>;      // refs, refreshed each turn
  observations: Array<{
    id; text;
    source: { runId; turnId };
    basis: Array<{ knowledgeId; revision }>;             // what it was written against
    updatedAtTurn: number;
  }>;
};
```

Stored in Neo4j as append-only `(:ContextRevision {workItemId, revision, payload})`
under a `(workItemId, revision)` uniqueness constraint, next to the `(:Knowledge)`
records it points at. **The context is a derived view** — losing it costs a
re-derivation, not a fact — which is why it can sit beside the knowledge records
without becoming an authority over them. Neo4j is used because Stage 1 already
selected it (working record §21), not because this spike re-compared stores.

Execution state (work items, attempts, events) belongs in Postgres. Here it is a
**simulated boundary**: `declareWorkItem` stands in for the execution plane, and
`runId`/`turnId` are supplied by the caller.

## The three boundaries that carry the design

**Provisional never becomes authoritative.** The operation type is
`remember | forget`. There is no verb that writes, edits, canonizes, or retracts
a knowledge record, so provisional memory cannot reach the knowledge plane
because no path exists — not because a filter remembers to say no. A model
emitting `{op:"canonize"}` gets `OP_UNKNOWN` and the record is untouched.

**A note carries the revision it was written against.** When
`k:rotation@1 → @2`, a note whose basis is `k:rotation@1` is **dropped**, not
silently re-pointed at the new text. Re-pointing would present stale reasoning as
current, which is the whole failure this mechanism exists to prevent. Withdrawn
or deleted knowledge drops both the ref and anything citing it.

**Pins are not droppable.** The budget (32 observations, 4 KiB rendered) evicts
oldest-first. If declared knowledge alone will not fit, `assemble` throws
`BudgetExceeded` rather than shipping a context missing its constraints. Byte
limits are mechanical, **not** model token counts and not calibrated.

## Run it

Requires Docker. No credentials, no provider traffic, no published ports.

```bash
./run.sh test     # 12 tests against a real Neo4j
./run.sh demo     # scripted 4-turn run, prints each context
./run.sh check    # typecheck only
```

Each invocation gets a fresh project name and tears its volumes down on exit.
The demo makes the interesting case visible: at turn 3 the requirement changes
and both notes written against the old revision are dropped with
`BASIS_STALE:k:rotation@1->2`.

## Files

| File | Lines | What |
|---|---:|---|
| `src/context.ts` | 325 | The value type and every pure rule: apply, refresh, assemble |
| `src/store.ts` | 259 | Neo4j: knowledge records, declarations, guarded revision append |
| `src/memory.ts` | 125 | `prepareTurn` / `completeTurn` / `runTurn`, and the client interface |
| `src/continue.ts` | 38 | Resume a work item in a fresh process from its id alone |
| `src/demo.ts` | 88 | Scripted four-turn run |
| `src/spike.test.ts` | 220 | The tests |

One runtime dependency: `neo4j-driver`. No LangGraph, no embeddings, no policy
engine, no reference-project code.

## Verified

Typecheck clean. `node --test`, real store, 12/12:

```
observation survives save and reload      budget keeps pins, drops oldest
remember replaces by id, forget removes   unfittable pins raise
invented citation refused                 changed revision invalidates its note
withdrawn knowledge stops appearing       cross-work-item isolation holds
stale writer refused, winner preserved    memory ops cannot touch knowledge
fresh process resumes from the id alone   one revision per turn
```

The restart test spawns a **separate process** running `src/continue.ts` with
nothing but the work item id — no transcript, no handoff file — and asserts the
context comes back.

## Limits

**The live smoke test was not run. 0 of the 3 permitted model requests were
used.** No eligible client existed under this spike's rules: the Anthropic parity
harness reads the OpenCode credential file and this spike was forbidden from
inspecting credentials, and the OpenAI harness carries device-auth stages. Both
would have meant building the credential path the spike was told not to build.
The deterministic tests drive the same `TurnClient` interface a live model would,
so the wiring is exercised — but **a real model has never been handed this
context**, and that is unverified, not assumed to work.

Also out of scope, deliberately: reconciliation of observations into durable
knowledge, bitemporal validity, authorization/RBAC, revision retention or
compaction, concurrent-attempt handoff, retrieval or ranking of any kind, and
any notion of importance, trust, decay, or tiering. Nothing here needed them.

Not production-ready: `NEO4J_AUTH: none` is defensible only because the compose
network is `internal: true` with no published ports.

## What it cost

747 lines excluding tests and demo (`context` 325, `store` 259, `memory` 125,
`continue` 38), one dependency, well under an hour of build-and-verify time. The
mechanics did **not** need the machinery the reference systems carry. Whether
they need it to be *useful* is a different question, and this spike did not ask
it.
