# Provenance

This package is a project-owned derivative of a small part of
[`@ex-machina/opencode-anthropic-auth`](https://github.com/ex-machina-co/opencode-anthropic-auth). It is not an
installed copy of that plugin and does not claim to be an upstream-supported standalone API.
[`provenance.json`](provenance.json) is the machine-readable record; tests check it against this package.

## Baseline

| Field | Value |
|---|---|
| Package | `@ex-machina/opencode-anthropic-auth@2.0.0-next.5` (OpenCode v2 release line) |
| Source revision | [`156cb66c6889e1be3ad2b839345ea409942ab40f`](https://github.com/ex-machina-co/opencode-anthropic-auth/tree/156cb66c6889e1be3ad2b839345ea409942ab40f) |
| Published tarball integrity | `sha512-EBnFXXBCbd1rl496OydEBqMRqcuqAgpjFH1vhWio0Lw+hZHzzwFWoabrRDSKE3gC09Knd7Q6+lp4DvAOt0qjWw==` |
| License | MIT, Copyright (c) 2026 Ex Machina — verbatim copy in [`licenses/`](licenses/opencode-anthropic-auth.LICENSE.txt) |

Extraction starts from the TypeScript sources at that revision; each file's SHA-256 is recorded in
`provenance.json`. The published tarball was verified against its registry integrity on 2026-09-30. Neither check
says anything about live behavior.

## What is kept and what is not

Kept, adapted to injected I/O: the authorization URL and pasted-callback parsing, authorization-code exchange and
refresh with their bounded response validation, PKCE, bounded UTF-8 body reading, the request-profile constants, the
OAuth header and beta handling, the `?beta=true` query, the identity and billing system blocks, and recognition of the
structured minimum-client-version rejection.

Not carried over: the OpenCode plugin entry and hooks, connection tracking and labels, tool-name alias tables and
response rewriting, 429 response rewriting, refresh caches and blocked-token tables, automatic client-version
recovery, environment-variable overrides (`ANTHROPIC_BASE_URL`, `ANTHROPIC_INSECURE`, `ANTHROPIC_CLAUDE_CODE_VERSION`),
OpenCode system-prompt sanitation, and the console (API-key) login mode.

Per-file disposition is in `provenance.json`; a source marked `planned` has not been extracted yet.

## Intentional differences

These are deliberate, owner-approved departures from upstream behavior. They are not parity defects.

| ID | Difference | Why |
|---|---|---|
| D1 | Tool names are sent as the runtime's native `mcp_*` names. There is no aliasing, and response bytes are never rewritten. | A response rewriter is fragile at stream chunk boundaries; native names were accepted live under the earlier profile. |
| D2 | All I/O goes through an injected transport and caller signal. There is no global `fetch`, no fixed timeout and no retry. A failure is `not_sent` only when the transport says so; everything else after sending is `outcome_unknown`. | The runtime's terminal enforces endpoints, deadlines and accounting. Treating uncertain delivery as possibly delivered prevents replaying a consumed refresh token. |
| D3 | A refresh response without `refresh_token` is accepted; the caller keeps its current refresh token. | OAuth permits omission; the runtime's coordinator merges partial rotation. |
| D4 | Upstream token bounds (well-formed UTF-8, at most 8 KiB) are kept here; the runtime additionally requires 16 or more printable, non-space ASCII characters. | The runtime's exact-match screening needs its safety floor. |
| D5 | A minimum-client-version rejection is classified, never recovered from: no version adoption and no retry. | A run's profile is immutable; updating it is a reviewed package change with a new profile ID. |
| D6 | Profiles are explicit, immutable values selected by ID. Nothing is read from the environment. | Ambient configuration must not change a subscription request. |
| D7 | No OpenCode prompt sanitation. A request whose first message is not a user text turn is refused instead of deriving a degenerate billing header. | The runtime owns its prompt; the leading-text hazard was found in the Anthropic parity spike. |
| D8 | Only the subscription (`max`) login is offered. The upstream scope list is kept unchanged for consent parity, including `org:create_api_key`, which the runtime never exercises. | No API-key creation path exists. |
| D9 | No refresh caches or blocked-token tables. The runtime's coordinator durably marks a generation whose refresh outcome is unknown as needing reauthorization. | One durable, cross-process rule instead of per-process memory. |

## Updating from upstream

There is no automatic synchronization, and moving npm tags are never followed.

1. Choose an exact upstream version and revision. Run `bun run provenance:anthropic -- --revision <sha> --version
   <version>` to verify the tarball integrity and print the source hashes and changed files. This command uses the
   network and is not part of `check`.
2. Review the upstream diff for the kept sources only. Port wanted changes by hand; record them here.
3. A changed request profile gets a **new profile ID**. Existing profiles stay unchanged, so paused runs bound to them
   keep their meaning or are refused visibly.
4. Update `provenance.json`, this file and the golden fixtures, then rerun `check:verify` and the provider gates.
