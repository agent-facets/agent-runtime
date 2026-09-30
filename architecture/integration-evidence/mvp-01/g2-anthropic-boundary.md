# G2 — Internal Anthropic subscription boundary

**Outcome: pass (2026-09-30), offline.** Recorded under task 10.10 from the task 10.9 verification and the
negative controls run while implementing tasks 10.2–10.8. G2 tests the actual internal package
`packages/anthropic-subscription` and its runtime wiring against synthetic issuers and transports. It says nothing
about what Anthropic's service accepts; that is the separately authorized live G4.

## Question

Does the runtime reach Anthropic subscription authorization through a small, project-owned boundary — injected
transport and signals, safe typed outcomes, native tool names, no response rewriting — with recorded provenance and
intentional differences, and without an OpenCode host, the upstream plugin, private upstream imports, global-fetch
interception or a plugin-loader fallback? Does the runtime's credential coordination on top of it refresh exactly
once, merge partial rotation, and never replay a refresh token whose outcome is unknown?

## Tested build

| Item | Value |
|---|---|
| Source | Commit `2121fc0` plus uncommitted provider-block changes; SHA-256 prefix `099b8d50e005b31f` over the 198 tracked and untracked files under `packages/`, `tests/`, `scripts/` and the root build files |
| Package under test | `packages/anthropic-subscription` (private, no dependencies), derived from `@ex-machina/opencode-anthropic-auth@2.0.0-next.5` at `156cb66c6889e1be3ad2b839345ea409942ab40f` (tarball `sha512-EBnFXXBC…jWw==`); provenance in [upstream-handoff.md](upstream-handoff.md) |
| Execution-code manifests | `dist/execution-manifest.json`, SHA-256 prefix `b9fa79fa91b55b08`: Anthropic 53 modules (10 from the subscription package) and 48 packages; OpenAI 42 modules and 41 packages |
| Runtime | Bun 1.3.14 |
| Lockfile | `bun.lock` SHA-256 prefix `4756b22df9ede4a7`, unchanged by a frozen install |
| Image | Built from the repository root: `sha256:fc6c9733c85507dba20ecef2cf544eec6bd263f57dd84c63d3055d01361e3fbf`, carrying the same manifest |
| Provider requests | **0.** Issuers and networks were in-process fakes that record every request |
| Owner authorization | None required (no live provider operation) |

## Method

Package suites run with `bun test` in `packages/anthropic-subscription`; runtime suites in `packages/runtime`;
repository boundary and provenance suites in `scripts/`. All ran inside forced `check:verify` and direct `bun test`.
The synthetic transport records each request before replying and can answer with JSON, streamed chunks, a stall
until abort, a transport-reported "not sent", or a connection lost after sending. Runtime tests put a fake `fetch`
below the real exact-endpoint auth transport and use the real coordinator, lock and store.

The networked `bun run provenance:anthropic` re-downloaded the upstream tarball and sources and compared them with
`provenance.json`.

## Results (task 10.9)

| Check | Result |
|---|---|
| Forced `check:verify` | Pass: 9/9 tasks, 0 cached (package 61, scripts 57, runtime 391 tests) |
| Direct `bun test` | Pass: 509 tests, 49 files |
| Provenance command | Pass: tarball integrity and all 11 source hashes and the license match; no unrecorded upstream sources |
| Package: auth (30), request (13), response (8), provenance (6), synthetic transport (4) | Pass |
| Runtime: Anthropic credentials (15), coordinator (21), screening (8), `auth` command (5) | Pass |
| Repository: workspace boundaries (20), provenance comparison (4) | Pass |
| Integration (production assembly, 7 of 124) | Pass |
| Skipped, todo or focused tests | None |

What the passing cases establish:

- **Login.** The authorization URL carries the upstream parameters and scope list with an S256 challenge whose
  value a test recomputes independently; each login has fresh state and verifier. A pasted callback URL,
  `code#state` or query form is exchanged with exactly the upstream request body; a callback from another login,
  or unusable input, sends nothing. The operator command stores the result as the slot's next generation and prints
  only safe status; `status` never contacts the issuer.
- **Refresh outcomes.** 400/401 are `rejected` and record reauthorization with no token material; 429 is
  `throttled` and a transport-reported non-send is `not_sent`, both keeping the credential. A 5xx, a redirect, a
  connection lost after sending, an oversized, malformed, non-UTF-8 or invalid success, and an abort after sending
  are `outcome_unknown`: the slot is durably marked `refresh_outcome_unknown` and a second coordinator (another
  process) sends nothing. A rotation to a token the runtime cannot store is marked `refresh_result_invalid`. Each
  outcome is sent exactly once; pre-aborted calls send nothing; failures echo no token or body text.
- **Partial rotation.** An omitted `refresh_token` keeps the stored one (D3); eight concurrent callers share one
  refresh.
- **Transport boundary.** The auth transport reaches only `POST https://platform.claude.com/v1/oauth/token`,
  never follows a redirect, reports only Bun's pre-connection failures as not sent, and hides underlying error text.
- **Screening.** A generation leased by a request stays screened through four times the screen's capacity of
  other rotations, until the model call has sanitized its response; cancelled and failed calls release their
  leases; a full screen refuses the request before it is sent.
- **Isolation.** The package imports only its own modules and `node:crypto`; it performs no `fetch`, environment
  read or console output; only the runtime imports it, through its public entry; no package imports the upstream
  plugin or an OpenCode host. Its derived files cite their upstream sources, and every upstream source is recorded
  as adapted or excluded.

### Negative controls

Each mutation was applied to a passing tree, the named suite rerun, and the file restored:

| Mutation | Detected by |
|---|---|
| An uncertain refresh treated as temporary (replayable) | coordinator tests |
| A refresh without `refresh_token` refused (upstream behavior) | package auth tests |
| A leased generation evictable | screening tests |
| The model boundary never releasing leases | agent screening tests |
| Workspace packages left out of the execution closure | manifest tests |
| No durable rejection after a failed renewal | production-assembly integration test |

A control test also shows the defect the leases fix: coverage that ended with the HTTP exchange let a delayed
response echo its credential into the checkpoint under the same rotation pressure.

## Findings

- The coordinator could previously replay a possibly spent refresh token after an ambiguous refresh; upstream
  blocks this per process. The runtime rule is now durable and cross-process (owner-approved at task 9.4).
- The earlier screen kept the 16 most recent generations by count, which a delayed response could outlive; it now
  pins generations for the life of the model call.
- Bun 1.3.14 reports DNS and TCP/TLS setup failures as `ConnectionRefused` before any request byte is written;
  only such failures, and policy refusals, are treated as never sent.

## Limitations and open items

- Offline only. Real login, refresh and rotation against Anthropic's issuer are part of the authorized live G4.
- Agreement with upstream is agreement with a reference; the scope list, client identity and profile may be
  refused by the service at any time, which runs report as authorization or unsupported-profile failures.
- The runtime/CLI cross-process lock tests from the authority-boundary block use a fake issuer; this block adds the
  real Anthropic adapter in-process and relies on the unchanged lock for cross-process exclusion.
