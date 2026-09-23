# Knowledge reconciliation spike

Can an observation a model read in a document become durable, human-approved
knowledge that a later task retrieves?

This is a feasibility prototype, not a benchmark. It demonstrates the mechanics
of the path below and says nothing about extraction accuracy or model quality.

```text
retained source ──▶ one bounded extraction ──▶ validated candidate
                                                     │
                                      compared against accepted state
                                                     │
                                              pending proposal
                                                     │
                                          operator decision (human)
                                                     │
                                    atomic write: decision + evidence + revision
                                                     │
                                       later task reads accepted knowledge
```

## What it establishes, and what it does not

The code can prove **attribution**: this exact text really does appear at these
offsets in a retained source, and this accepted value was written by this
decision citing that text. It cannot prove **truth**. Whether the claim is
correct is a human judgment, which is why acceptance requires a decision record
and a model cannot produce one.

Two consequences worth stating plainly:

- A quote matching its source says nothing about whether the extracted reading
  of that source was sensible.
- Storing something durably is not accepting it. Pending and rejected candidates
  are persisted, and are not reachable from an accepted read.

## Layout

```text
src/reconcile.ts     the rules: identity, validation, dispositions, revisions
src/store.ts         Neo4j persistence and the only write path
src/cli.ts           the operator surface
src/extract.ts       one bounded provider request, no retries, no loop
src/spike.test.ts    reconciliation mechanics, against a real database
src/extract.test.ts  client checks, fully offline
fixtures/            three synthetic policy documents and their host identity
```

`src/reconcile.ts` imports no driver and no network client. The rules are
testable without either.

## Commands

```bash
./run.sh build     # build the image
./run.sh check     # typecheck, no database, no network
./run.sh test      # 28 tests against a real, disposable Neo4j
```

`test` and the demo use different Compose projects, so running the tests cannot
delete demo evidence an operator has already reviewed.

The demo, in the order it was actually run:

```bash
./run.sh cli setup
./run.sh cli stage-source --source harbor-policy@1        # and cedar-policy@1, @2

# a starting value for Cedar, labelled synthetic, through the same write path
./run.sh cli stage --source cedar-policy@1 \
  --extraction-text '{"rotationDays":90,"quote":"rotated every 90 days"}' \
  --extraction-ref synthetic:baseline-not-a-live-extraction
./run.sh cli apply --proposal <id> --proposal-digest <digest> --target-token none \
  --decision-id dec-synthetic-cedar-baseline --action accept_new \
  --operator spike-fixture --origin synthetic --rationale '...'

# the two live requests: the entire authorized budget
./run.sh extract --source harbor-policy@1 --label harbor-new
./run.sh extract --source cedar-policy@2  --label cedar-conflict

./run.sh cli stage --source harbor-policy@1 \
  --extraction-file /artifacts/extraction/harbor-new.json
./run.sh cli apply  --proposal <id> --proposal-digest <digest> --target-token <token> \
  --decision-id dec-owner-harbor-accept --action accept_new \
  --operator rathe --origin owner --rationale '...'

./run.sh cli read    --project synthetic:harbor
./run.sh cli history --project synthetic:cedar
```

`apply` takes the proposal digest and the reviewed target token as explicit
arguments. That is what makes an approval checkable rather than assumed: if
either has moved since the operator looked, the write is refused.

There is no command that sets a value directly, and no `--force`.

## The rules the store enforces

| Situation | Behaviour |
|---|---|
| No accepted claim | `new`; approval creates revision 1 |
| Same source read again | replay: the existing proposal and its outcome, no new evidence |
| Same source, different reading | refused; the cited candidate is not overwritten |
| Different source, same value | `corroboration`; approval adds evidence and moves no authority |
| Different value | `conflict`; the accepted value is untouched until decided |
| Rejected | recorded; accepted knowledge unchanged |
| Approved correction | new revision, same interval, prior revision and evidence retained |
| Target moved since review | refused as stale; nothing partial persists |
| Same decision applied twice | idempotent, returns the stored outcome |
| Decision id reused for other content | refused |
| Source claims a different interval | refused as unsupported, not relabelled a correction |

A correction replaces the value for an interval and does **not** carry the old
evidence forward: text that supported a wrong number is not support for the
right one. Genuine policy change over time is deliberately out of scope — the
store refuses it rather than mislabelling it.

## Boundaries

- Neo4j is on an internal, gateway-less network with no published ports. Bolt and
  the Browser are unreachable from the host; the command service is the only way
  in. Community Edition has no RBAC, so this is architectural, not enforced by
  the store.
- The extractor runs on a different network with no database address and no route
  to one. The component holding a subscription token cannot write knowledge.
- The credential is opened read-only and only its access token is used. Nothing
  refreshes, logs in, or writes back. Artifacts were scanned against the actual
  token values and contain none.
- Retries are disabled at both the LangChain and SDK layers.
- The live request ceiling is a durable exclusive-create reservation taken
  **before** dispatch, under `tmp/.../demo/extraction/ledger/`. A crashed or
  rejected request still spends its slot, and the ledger survives a restart.
- Postgres and execution events are not implemented. Work items, attempts, and
  scheduling are an explicitly simulated boundary here.

## Measured

| | |
|---|---|
| Implementation | 2,017 lines across four modules |
| Tests | 721 lines, 28 tests |
| Runtime dependencies | `neo4j-driver`, `@langchain/anthropic`, `@langchain/core`, `@anthropic-ai/sdk` |
| Live requests | 2, the entire authorized budget |
| Observed usage | 374 in / 58 out, then 387 in / 138 out |
| Reused unchanged | the Anthropic transport from `spikes/anthropic-parity` |

Full result, including the owner's decisions and their limits:
[`architecture/spike-reports/08-observation-to-knowledge-reconciliation.md`](../../architecture/spike-reports/08-observation-to-knowledge-reconciliation.md).

## Retained data

The demo volume `okr-demo_neo4j-data` and the artifacts under
`tmp/spikes/knowledge-reconciliation/demo/` are **kept on purpose**: they hold
reviewed sources, the actual extraction outputs, the proposals, and the owner's
decisions. `./run.sh demo-destroy` removes the volume; nothing else does.

Harbor and Cedar are invented. Every fixture is synthetic and describes no real
organisation, system, or credential.
