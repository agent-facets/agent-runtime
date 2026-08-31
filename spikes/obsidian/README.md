# Obsidian spike harness

Throwaway P0 code. It exists to answer architectural questions, not to ship.
Findings live in [`architecture/spike-reports/`](../../architecture/spike-reports/).

## What it does

Builds a pinned headless Obsidian image, boots it from an empty vault volume,
and drives it to a working authenticated MCP endpoint with no manual step.

```text
entrypoint
  preflight            token >= 32 bytes, volumes writable
  obsidian.json        fixed vault id -> /vault, cli enabled
  community-plugins    union, never overwrite
  plugin binaries      sync only when the hash differs
  data.json            fixed port + token from the mounted secret, 0600
  Xvfb -> Obsidian     unprivileged uid
  CLI socket           wait, then assert the CLI is actually armed
  plugins:restrict off
  plugin:enable
  MCP                  wait for an unauthenticated 401
  MCP                  assert an authenticated initialize
```

Every step is a converger. Re-running against a bootstrapped vault changes
nothing.

## The bridge

The plugin binds container-loopback, so a separately networked runtime cannot
reach it. `mcp-bridge` is stock unprivileged NGINX sharing the Obsidian
container's network namespace: `127.0.0.1:27200` upstream, `0.0.0.0:8080`
downstream, reachable at the Obsidian service's own address.

```text
┌──────── shared network namespace ────────┐
│  obsidian            mcp-bridge          │
│  127.0.0.1:27200  ◀  0.0.0.0:8080        │
└─────────────────────────┬────────────────┘
                          ▼
                 ordinary Compose network
```

It is a transport, not a policy layer: it forwards every path and method and
does header hygiene only. It holds no credential.

## Running it

```bash
./verify-headless.sh                      # default volumes, preserved
./verify-headless.sh --isolated           # unique project + volumes
./verify-headless.sh --isolated --cleanup # and remove them afterwards

./verify-bridge.sh                        # topology matrix, fresh project
./verify-bridge.sh --cleanup              # and remove it afterwards
```

`verify-bridge.sh` always uses a fresh project. The SSE test activates a tool
that must start inactive, which is only true on a first activation, so it boots
the vault with the plugin's `core` tool profile via `OBSIDIAN_TOOL_PROFILE`.

Compose profiles keep the two runs separate: no profile is the headless service
alone, `bridge` adds the sidecar, `bridge-test` adds the two probes.

Evidence lands in `tmp/spikes/obsidian/<run-id>/` (git-ignored):

| File | Contents |
|---|---|
| `evidence.json` | Acceptance matrix and summary |
| `snapshot-*.json` | Full sanitized state per boot |
| `managed-*.json` | The subset that must not drift |
| `managed-*.diff` | Present only when something drifted |
| `*.log` | Build, compose, and entrypoint output |

## Storage

Container paths are fixed. Volume names are configurable.

| Variable | Default | Holds |
|---|---|---|
| `OBSIDIAN_VAULT_VOLUME` | `agent-runtime-obsidian-vault` | `/vault` — canonical, durable |
| `OBSIDIAN_PROFILE_VOLUME` | `agent-runtime-obsidian-profile` | Electron profile — regenerable |

Volumes are never deleted unless `--cleanup` is passed.

The live `~/dev/vaults/agents/Agents` vault is never mounted, read, or
modified by anything here.

## Secrets

The verify scripts generate a 43-byte URL-safe token into the run directory
with mode `0600` and pass only its **path** to Compose.

The token reaches `data.json` through `jq --rawfile`, and reaches the probes
through `probe-curl` writing a `0600` curl config on their own tmpfs. It never
appears in argv, the environment, `docker inspect`, or any log. Evidence
compares it by SHA-256 digest and never reproduces it.

**Compose secrets carry the host file's ownership.** Outside swarm the file is
bind-mounted as-is and the `uid`/`gid`/`mode` options are silently ignored, so
every container that reads the token runs as the uid that owns it. Getting this
wrong presents as authenticated calls returning empty bodies while
unauthenticated ones work.

## Pinned inputs

| Input | Pin |
|---|---|
| Base image | `debian:bookworm-slim@sha256:88200866dfff…4171` |
| Obsidian | `1.13.7`, tarball SHA-256 verified per architecture |
| MCP Connector | `2.4.0`, `main.js` + `manifest.json` SHA-256 verified |
| Bridge | `nginxinc/nginx-unprivileged:1.29.1-alpine@sha256:27985295…467e` |
| Probes | `curlimages/curl:8.15.0@sha256:4026b299…2922` |

Apt package versions are **not** pinned. Acceptable for a spike; recorded as a
limitation in the report.

## Known limitations

- Obsidian runs with `--no-sandbox`, mirroring the working host unit.
  Chromium's own sandbox needs privileges this container does not grant. The
  container user is still unprivileged.
- No `ports:` mapping exists anywhere, deliberately. The MCP listener is
  reachable only from inside the container's network namespace, and the bridge
  makes it reachable on the internal Compose network without publishing
  anything to the host.
- `client_max_body_size` is **disabled** on the bridge so the oversize-body
  test observes the plugin's own `413` rather than NGINX's. A production bridge
  should re-add a cap as defence in depth.
- `proxy_http_version 1.1` is mandatory on NGINX before 1.29.7, which defaulted
  to HTTP/1.0 upstream. SSE does not work over HTTP/1.0.
