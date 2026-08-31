# Spike 01 — Obsidian Headless

**Outcome: pass.** A cold start from an empty Docker volume reaches an
authenticated MCP endpoint with no manual step, and five restarts produce zero
drift in managed state.

## Question

> Does Obsidian boot, open a vault, and leave restricted mode without a GUI?

The load-bearing sub-question was narrower. [03-obsidian-brain.md](../03-obsidian-brain.md)
asserts that restricted mode — which is stored in Chromium `localStorage`, not
in any vault file — can be turned off through Obsidian's own CLI, and that the
CLI is armed by setting `"cli": true` in `obsidian.json`.

Obsidian documents the CLI as a **GUI toggle** under Settings → General and
documents no file-driven equivalent. That made the file-driven path an untested
assumption on which the entire container design rests. If it were false, the
remaining options were hand-editing Chromium's LevelDB or driving a GUI — both
of which the architecture explicitly rejects.

**It is true.** Writing `"cli": true` into `obsidian.json` before first launch
arms the CLI socket, and `plugins:restrict off` then works headlessly.

## Environment

| | |
|---|---|
| Host | Linux, WSL2, x86_64 |
| Docker | Engine 29.0.0, Compose v2.40.3 |
| Run id | `20260830T213903Z` |
| Harness | [`spikes/obsidian/`](../../spikes/obsidian/) |

Immutable inputs, all verified by digest during the build:

| Input | Pin |
|---|---|
| Base image | `debian:bookworm-slim@sha256:88200866dfff7ea7f5cbcb6ec7c8a701889efe6fe859fe64d6990e4b07ea4171` |
| Obsidian | `1.13.7` (amd64 tarball `d3cbe375…db28`) |
| MCP Connector | `2.4.0` (`main.js` `9c1653b8…5484`, `manifest.json` `e58f8872…4fca`) |
| Built image | 756 MB, `sha256:97d9a626…3e23e` |

The pre-existing host Obsidian was used as **baseline only**. Nothing in this
spike reads, mounts, or modifies it or the live `Agents` vault.

## Method

```bash
./spikes/obsidian/verify-headless.sh --isolated
```

Cold-starts a fresh vault volume and a fresh Electron profile volume, restarts
five times, and writes sanitized evidence to `tmp/spikes/obsidian/<run-id>/`.

The bootstrap is a converger, not an installer:

```text
preflight            token >= 32 bytes; volumes writable
obsidian.json        fixed vault id -> /vault, open, cli enabled
community-plugins    union with whatever is already listed
plugin binaries      sync only when the hash differs
data.json            pinned port + token from the mounted secret, 0600
Xvfb                 start, then wait until it ANSWERS
Obsidian             start, unprivileged
CLI                  wait for the socket, then assert it is armed
plugins:restrict off
plugin:enable
MCP                  wait for an unauthenticated 401
MCP                  assert an authenticated initialize
```

## Acceptance

All fourteen criteria passed.

| Check | Result | Evidence |
|---|---|---|
| Cold vault opens | Pass | CLI reports vault path `/vault` |
| CLI armed headlessly | Pass | `1.13.7 (installer 1.13.7)` over the socket |
| Restricted mode off | Pass | `plugins:restrict` reports `off` |
| Plugin loaded | Pass | `mcp-tools-istefox 2.4.0` in enabled community plugins |
| Artifacts pinned | Pass | Installed hashes equal published release hashes |
| Port deterministic | Pass | Exactly one listener on `127.0.0.1:27200`; no fallback port |
| Secret persisted | Pass | Stored token digest equals secret digest after 5 restarts |
| `data.json` locked down | Pass | Mode `600` |
| Unauthenticated request | Pass | `401` |
| Wrong token | Pass | `401` |
| `initialize` | Pass | `Obsidian - vault` v`2.4.0`, protocol `2025-11-25` |
| Tool call | Pass | `tools/call get_server_info` succeeded |
| Restart stable | Pass | 0 managed-state drifts across 5 restarts |
| No published ports | Pass | `NetworkSettings.Ports` is `{}` |

Cold start took **9 seconds**, against a 180-second budget.

## Findings

### The CLI hypothesis holds

`"cli": true` at the top level of `obsidian.json` arms the CLI socket at
`$XDG_RUNTIME_DIR/.obsidian-cli.sock` on first launch. No GUI, no LevelDB
surgery. The architecture's bootstrap sequence is sound as written.

One refinement: **the socket existing is not the same as the CLI being armed.**
A disabled CLI still creates the socket and answers every command with
`Command line interface is not enabled` — which is exactly what the host
baseline does. The readiness gate must run a command and check the result, not
stat the socket. The harness does this and the production entrypoint must too.

### Convergence requires canonical comparison, not byte comparison

Obsidian rewrites `obsidian.json` in compact form at runtime, and the plugin
rewrites `data.json` to add its own slices. A converger that compares its
pretty-printed output byte-for-byte against the file therefore sees a diff on
**every** boot and rewrites forever.

The comparison must be canonical — sorted, compact, semantic. With that fix the
second and subsequent boots report `already converged` and touch nothing.

This is the mechanism behind the architecture's "five restarts produce zero
diffs" exit criterion, and it is not obvious from the outside.

### The merge does preserve unknown keys

After boot, `data.json` contains slices the entrypoint never wrote:

```json
{
  "mcpTransport": { "port": 27200, "livePort": 27200, "tokens": [ … ] },
  "semanticSearch": { "provider": "auto", "indexingMode": "live", … },
  "toolLoading": { "profile": "all", "profiles": { "default": { … } } }
}
```

All of it survives every restart untouched. `livePort` converging to the pinned
`port` confirms the fallback scan is genuinely suppressed rather than
coincidentally landing on 27200.

### A stale X socket is a real trap

This one cost the most time and is worth recording precisely, because the
production entrypoint will hit it.

A container restart reuses the container filesystem. Xvfb does not reliably
remove `/tmp/.X11-unix/X99` on `SIGTERM`, so a readiness check that tests for
the socket's **existence** passes instantly against a server that is not
listening. Obsidian then starts, tries to open a window, and **segfaults**.

It reproduced deterministically on the third process start, twice.

The fix is to remove stale X sockets and lock files before starting Xvfb, and
to gate readiness on `xdpyinfo` actually answering.

**A false lead, recorded so it is not repeated.** The crash log prominently
featured a D-Bus failure and Chromium's `os_crypt.portal.prev_init_success:
false` in `Local State`, which points convincingly at the keyring path. Adding
`--password-store=basic` and `--disable-gpu` did **not** fix it. Those flags
remain in the entrypoint as container hygiene, but they are not the fix, and
the D-Bus error is benign noise. The X socket was the cause.

### Secret discipline holds under inspection

The token reaches `data.json` via `jq --rawfile`, never through argv or the
environment. Verified after the run: the token string appears in **no**
snapshot, evidence file, or log, and does not appear in `docker inspect`. The
only file containing it is the mounted secret itself, mode `600`.

### An extra loopback listener exists, and it is not ours

Inside the container, `ss` reports two listeners:

```text
127.0.0.1:27200     the MCP plugin
127.0.0.11:40577    Docker's embedded DNS resolver
```

`127.0.0.11` is Docker's own resolver on a user-defined network. Any check that
asserts "only our listener is bound" must account for it or it will produce a
false failure.

## Architecture impact

[03-obsidian-brain.md](../03-obsidian-brain.md) is correct in structure. Three
additions, all of them operational detail the design could not have known:

1. CLI readiness must assert the CLI is **armed**, not that its socket exists.
2. Converger comparisons must be canonical JSON, not textual.
3. The X server must be probed for liveness, and stale sockets removed, or
   restarts crash intermittently.

Nothing in the document is contradicted. No load-bearing decision changes.

## Limitations

This spike does **not** establish:

- **Reachability from another container.** No port is published and the plugin
  binds container-loopback, so nothing outside the container's network
  namespace was proven able to reach it. That is spike 02's entire subject.
- **Sandbox posture.** Obsidian runs with `--no-sandbox`, mirroring the working
  host unit. The container user is unprivileged (uid 1000, never root), but
  Chromium's own sandbox is disabled. Revisit in P2.
- **Apt reproducibility.** Package versions are not pinned; only the base image
  and the application artifacts are. Acceptable for a spike, not for P2.
- **Long-run stability.** Five restarts over minutes. Nothing here speaks to
  memory growth, index behaviour, or a vault with real content.
- **Host port isolation, directly.** The host's own `127.0.0.1:27200` answers
  `401`, but that is the pre-existing systemd Obsidian (pid 13294), not the
  container. The conclusive evidence is `NetworkSettings.Ports == {}`.

## Reproducing

```bash
./spikes/obsidian/verify-headless.sh --isolated --cleanup
```

Evidence is written to `tmp/spikes/obsidian/<run-id>/`, with `evidence.json`
carrying the acceptance matrix. Volumes are preserved unless `--cleanup` is
passed.
