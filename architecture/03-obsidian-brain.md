# Obsidian Brain

Obsidian is the system's long-term, human-readable memory. It is a memory
appliance reached over MCP — not a UI the agents drive and not a database.

## Why Obsidian

Plain Markdown with wikilinks gives four things a database does not:

1. A human can read, edit, and correct what the agent believes.
2. Links between notes form a knowledge graph for free.
3. Git gives versioning, provenance, and cheap off-box backup.
4. Nothing is locked in. The files outlive the runtime.

What it does **not** give: transactions, ordering guarantees, concurrent write
safety, or query performance. Those stay in Postgres.

## Container

Obsidian is desktop-only software, so it runs headless under Xvfb in a slim
image we build ourselves rather than a remote-desktop image.

```text
Stage 1  fetch     pinned Obsidian tarball + pinned plugin release
                   sha256 verified, manifest id/version asserted
Stage 2  base      Debian slim + GTK/NSS/X11 libs + Xvfb + tini
Stage 3  final     non-root uid, entrypoint, healthcheck, templates
```

Pinned by digest: base image, Obsidian version, plugin version, plugin
`main.js` hash. Multi-arch via `TARGETARCH` selecting the matching tarball.

A remote-GUI image was considered and rejected. Its value proposition is a
browser desktop; we want a headless MCP endpoint. It would add gigabytes, a
compositor, a CPU video encoder, and a web UI that is effectively a root shell
next to the vault.

## Deterministic bootstrap

This is the fiddly part. Three separate pieces of state must agree before the
MCP server binds.

**1. Vault registry.** `obsidian.json` in the app config directory maps a fixed
vault id to `/vault` with `open: true`. The id is arbitrary hex, so we choose a
constant and everything downstream becomes deterministic. The entrypoint MUST
verify `/vault` exists before launch — a missing path causes Obsidian to prune
the entry and boot to a vault picker.

**2. Plugin files.** `community-plugins.json` lists the plugin id, and the
plugin binary lives in the vault under `.obsidian/plugins/`. The entrypoint
syncs these from an image-side staging directory only when absent or when the
version or hash differs. It MUST union the plugin list rather than overwrite it.

**3. Restricted mode.** This is the trap. Community plugins are gated by a
`localStorage` key in Chromium LevelDB, keyed by vault id — not by any file in
the vault. Listing the plugin is necessary but not sufficient. Without the
localStorage flag, `main.js` never loads and no port is ever bound.

The supported way out is Obsidian's own CLI over its Unix socket, which is
armed by setting `"cli": true` in `obsidian.json`. Hand-editing LevelDB is not
an option worth taking.

**Verified.** [Spike 01](./spike-reports/01-obsidian-headless.md) confirms that
writing `"cli": true` before first launch arms the CLI headlessly, and that
`plugins:restrict off` then works. Obsidian documents the CLI only as a GUI
toggle, so this was an assumption until measured.

```text
1  render obsidian.json from template (fixed vault id, cli enabled)
2  converge vault config files, union plugin list
3  sync plugin binary if version/hash differs
4  merge plugin settings from mounted secret     ← see below
5  start Xvfb, wait until it ANSWERS              ← not just a socket
6  start Obsidian
7  wait for the CLI socket, then assert it is ARMED
8  disable restricted mode via CLI if still on
9  assert the plugin is loaded
10 probe MCP until it answers
```

Every step is a converger, not an installer. Re-running MUST be a no-op.

Three traps the spike surfaced, each of which silently breaks the above:

- **A socket is not readiness.** A disabled CLI still creates its socket and
  refuses every command; a dead X server still leaves `/tmp/.X11-unix/X99`
  behind after a restart. Both readiness gates MUST issue a real query — a CLI
  command, and `xdpyinfo` — and check the result. Testing for the socket makes
  Obsidian start against a dead display and segfault.
- **Stale X state MUST be cleared before launch.** A container restart reuses
  the container filesystem, and Xvfb does not reliably clean up on `SIGTERM`.
- **Convergence MUST compare canonical JSON, not bytes.** Obsidian and the
  plugin both rewrite their config compactly at runtime, so a byte comparison
  against pretty-printed output reports a diff on every boot and never
  converges.

## Plugin configuration

Plugin settings are file-driven. There is no environment variable that
configures the transport, the port, or the token, so the entrypoint renders
`data.json` by merge.

Two settings matter:

- **Pinning the port** removes the 27200–27205 fallback scan and makes the
  bridge target a constant. Discovery stays as a fallback, not the mechanism.
- **The bearer token** comes from a mounted Docker secret, never an environment
  variable, and is written with mode `0600`.

The token MUST be at least 32 bytes. A shorter value is silently discarded and
replaced with a random one, which presents as a confusing 401 rather than a
validation error.

The merge MUST preserve unknown keys and counters so a restart produces no diff
and triggers no plugin-side rewrite. In practice the plugin writes back
`livePort`, a `semanticSearch` slice, and a `toolLoading` slice; all of them
survived five restarts untouched in the spike. `livePort` converging to the
pinned `port` is the observable proof that the fallback scan is suppressed.

Reading the token into the settings file MUST NOT route it through argv or the
environment, where `docker inspect` and `/proc` expose it. The spike passes the
secret file directly into the JSON merge and verifies afterwards that the token
appears in no log, no snapshot, and no container metadata.

**A Compose secret carries the host file's ownership.** Outside swarm the file
is bind-mounted as-is, and the `uid`, `gid`, and `mode` options under
`secrets:` are silently ignored. A `0600` secret is therefore readable only by
the uid that owns it, so every container that must read one MUST run as that
uid. [Spike 02](./spike-reports/02-obsidian-loopback-bridge.md) hit this as a
whole failed run: authenticated calls returned empty bodies while
unauthenticated ones worked, which looks like a proxy defect and is a file
permission.

## Networking

The plugin binds `127.0.0.1` as a hardcoded constant. A sidecar in a different
network namespace has its own loopback and cannot reach it.

```text
┌─────────────── shared network namespace ────────────────┐
│                                                          │
│   obsidian                     mcp-bridge                │
│   binds 127.0.0.1:27200  ◀──   reads 127.0.0.1:27200     │
│                                listens 0.0.0.0:8080      │
└──────────────────────────┬───────────────────────────────┘
                           │  reachable on the internal network
                           ▼
                   runtime MCP broker
```

Patching the minified plugin to bind `0.0.0.0` was considered and rejected: the
constant is a mangled identifier that silently changes on every plugin release,
so the patch fails open with no error.

Compose caveat: a service using another service's netns has no DNS name of its
own. The bridge is addressed by the Obsidian service's name.

**Verified.** [Spike 02](./spike-reports/02-obsidian-loopback-bridge.md)
measured all three legs. A container on the ordinary Compose network gets
`ECONNREFUSED` reaching the Obsidian service address on the plugin's port, so
the mediation is structural rather than a policy choice. A stock unprivileged
NGINX with ~40 lines of configuration passed every protocol test, so **the
bridge MUST NOT be custom code.**

The bridge MUST:

- Pass `Authorization`, `Accept`, `Content-Type`, and MCP protocol/session
  headers through unmodified.
- **Remove** `Origin` rather than rewrite it. The plugin rejects any origin
  that is not loopback — the most common cause of a mysterious 403 — and
  explicitly allows an absent one, which is the non-browser client case.
- Disable buffering in **both** directions so a notification frame is not held
  until a stream that never ends completes.
- Force HTTP/1.1 upstream. NGINX defaulted to HTTP/1.0 before 1.29.7, and SSE
  over HTTP/1.0 does not work.
- Relay the plugin's own status codes and error bodies verbatim, including the
  JSON-RPC error inside a `400`.
- Hold no credential. The token is the caller's to present; the bridge only
  relays the header.
- Refuse traffic until the upstream is ready. This is an orchestration
  concern — a healthcheck-gated `depends_on` — not something the proxy does.

The sidecar stays a separate container. It survived both an ordinary restart
and a force-recreate of the Obsidian container, so collapsing the proxy into
the Obsidian image would buy nothing and cost the one-concern-per-image
property.

## Health

Layered, cheapest first:

| Check | Proves |
|---|---|
| CLI socket exists | Electron is up |
| Plugin listed as enabled | Restricted mode is off and the plugin loaded |
| Unauthenticated MCP POST returns `401` | The listener is bound and auth is wired |
| Authenticated `initialize` succeeds | End-to-end protocol works |

The unauthenticated probe is the right container healthcheck: it proves the most
per byte and needs no credential, so the health command never handles secrets.
Authenticated probes belong in the startup gate, not on a recurring timer.

[Spike 01](./spike-reports/01-obsidian-headless.md) exercised all four layers.
Note that a listener inventory inside the container also shows Docker's
embedded DNS resolver on `127.0.0.11`; a check asserting "only our listener is
bound" MUST account for it or it reports a false failure.

## Vault as knowledge store

```text
/vault
  brain/
    concepts/      durable ideas
    entities/      people, projects, systems
    decisions/     what was decided and why
    runbooks/      procedures the agent follows
  agents/          prompts, skills, tool policies
  runs/            short human-readable run summaries
  attachments/     small authored media only
  _system/         alerts, health notes written by the runtime
```

Every agent-written note carries frontmatter provenance:

```yaml
---
memory_id: mem_01J...
kind: fact | decision | procedure | summary | entity
scope: project/agent-runtime
source_run_id: run_01J...
source_event_seq: 412
confidence: 0.0-1.0
valid_from: 2026-08-30
valid_to:
agent_updated: 2026-08-30T19:12:00Z
schema_version: 1
---
```

Provenance is not optional. Without it, retrieval can surface a claim the system
cannot justify, and a human cannot tell an observation from an inference.

## Write discipline

Concurrent writers are the main hazard: the human in the desktop app, the agent
over MCP, and Git all touch the same tree.

- The agent freely creates and rewrites only under agent-owned paths.
- Elsewhere it appends, or patches under a stable heading — never whole-file
  rewrites.
- Renames and deletes go through Obsidian so inbound links are maintained. A
  raw `mv` silently orphans every wikilink pointing at the old name.
- Writes are anchored to headings or block ids, never line numbers.
- Exactly one sync mechanism per device. Obsidian Sync and a Git daemon writing
  the same tree is the classic corruption scenario.

## Git

Git is versioned off-box replication of the prose, not a backup tool and not
sync — there is only one replica, so there is nothing to reconcile.

Committed: Markdown, canvases, bases, small attachments, `.gitignore`, and the
three vault config files that make a rebuild possible.

Excluded by construction: plugin binaries, `workspace.json`, caches, the
semantic index, and — critically — `.obsidian/plugins/*/data.json`, which holds
live bearer tokens. The ignore rule is deny-by-default inside `.obsidian` with a
short allowlist, because the next plugin's `data.json` must be excluded without
anyone remembering to add it.

A commit daemon runs on a timer with a quiescence check, a single-flight lock,
and a pre-commit secret and size guard. On conflict it MUST stop rather than
resolve: there is no safe automatic merge of two versions of a prose note.

## Open questions

- Whether the vault is one Docker volume or a bind mount to a host path the
  human also opens in the desktop app.
- Whether the plugin's on-device semantic search is used at all, or whether
  retrieval goes entirely through our own pgvector index.
- Whether run summaries are committed to the vault or kept only in the archive.
- Whether an SSH/X11 path into the container is worth the attack surface for
  occasional manual vault work.
