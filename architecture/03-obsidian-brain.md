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

```text
1  render obsidian.json from template (fixed vault id, cli enabled)
2  converge vault config files, union plugin list
3  sync plugin binary if version/hash differs
4  merge plugin settings from mounted secret     ← see below
5  start Xvfb, start Obsidian
6  wait for the CLI socket
7  disable restricted mode via CLI if still on
8  assert the plugin is loaded
9  probe MCP until it answers
```

Every step is a converger, not an installer. Re-running MUST be a no-op.

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
and triggers no plugin-side rewrite.

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

The bridge MUST:

- Pass `Authorization`, `Accept`, `Content-Type`, and MCP protocol/session
  headers through unmodified.
- Strip or rewrite `Origin` — the plugin rejects any origin that is not
  loopback, which is the most common cause of a mysterious 403.
- Disable response buffering so streamed responses are not held.
- Refuse traffic until the upstream probe succeeds.

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
