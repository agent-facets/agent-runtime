# Spike 02 — Obsidian Loopback Bridge

**Outcome: pass.** Loopback mediation is genuinely required, and a stock NGINX
sidecar with roughly forty lines of configuration provides it with no
detectable protocol distortion. **No custom bridge code is needed.**

## Questions

The architecture treats "the bridge" as one decision. It is four, and they have
different answers.

| # | Question | Answer |
|---|---|---|
| 1 | Is loopback mediation required for a separately networked runtime? | **Yes** |
| 2 | Is a distinct sidecar container required? | **No, but keep it** |
| 3 | Is custom bridge code required? | **No** |
| 4 | Can the proxy collapse into the Obsidian image? | Yes, but there is no reason to |
| 5 | Should the runtime share Obsidian's namespace instead? | **No** |

## Environment

| | |
|---|---|
| Host | Linux, WSL2, x86_64 |
| Docker | Engine 29.0.0, Compose v2.40.3 |
| Run id | `bridge-20260831T003355Z` |
| Harness | [`spikes/obsidian/`](../../spikes/obsidian/) |

Pinned inputs, in addition to [spike 01](./01-obsidian-headless.md)'s:

| Input | Pin |
|---|---|
| Bridge | `nginxinc/nginx-unprivileged:1.29.1-alpine@sha256:27985295…467e` |
| Probes | `curlimages/curl:8.15.0@sha256:4026b299…2922` |

## Method

```bash
./spikes/obsidian/verify-bridge.sh
```

Three consumers, so the topology is compared rather than assumed:

```text
┌──────── network namespace net:[4026532377] ────────┐
│                                                     │
│  obsidian          mcp-bridge        probe-shared   │
│  127.0.0.1:27200   0.0.0.0:8080      control        │
│                                                     │
└──────────────────────────┬──────────────────────────┘
                           │  obsidian service address
                           ▼
                  probe-network  net:[4026532312]
                  ordinary Compose network
```

`probe-network` stands in for the runtime: its own namespace, its own
loopback, ordinary Compose DNS. `probe-shared` is the control for the
"put the runtime in Obsidian's namespace" option.

The run always uses a fresh project. The SSE test depends on a tool being
genuinely inactive, which is only true on a first activation — so the vault is
booted with the plugin's `core` tool profile and two *different* non-core tools
are activated, one per path.

## Results

All nineteen checks passed.

### Reachability

| Path | Result |
|---|---|
| `probe-network` → `obsidian:27200` | **curl exit 7**, no HTTP response |
| `probe-shared` → `127.0.0.1:27200` | `401` unauthenticated, `initialize` OK |
| `probe-network` → `obsidian:8080` | `401` unauthenticated, `initialize` OK |
| `probe-network` → `tools/call get_server_info` | Succeeded, server `Obsidian - vault` |

The first row is the whole justification for the bridge. Connection refused,
not filtered, not timed out: the plugin binds container-loopback and a
separately networked consumer cannot reach it no matter what the Compose
network permits.

### Header handling

| Check | Direct | Via bridge |
|---|---|---|
| `Origin: https://evil.example` | `403` | `200` |
| Wrong bearer token | — | `401` |

The bridge **removes** `Origin` rather than rewriting it to a fake loopback
value. The plugin's `isOriginAllowed()` returns true for an absent Origin,
which is the non-browser client case. Removal is therefore the honest
transformation, and it is one directive.

Authorization is untouched and still fails closed.

### Status and error-body fidelity

| Check | Result |
|---|---|
| Unsupported `MCP-Protocol-Version` | `400`, JSON-RPC `-32020` |
| `GET /mcp` | `405` |
| Unknown path | `404` |
| Body > 1 MiB via bridge | `413` |
| Body > 1 MiB direct | `413` |

Every status the plugin defines survives, including the JSON-RPC error code
inside the body. The oversize case matches direct byte for byte, which was the
one I expected the bridge to distort.

### Streaming

| Check | Via bridge | Direct |
|---|---|---|
| `activate_tool` answers `text/event-stream` | Yes | Yes |
| Notification frame precedes terminal result | Yes | Yes |
| `subscriptions/listen` ack arrives before client timeout | Yes | Yes |

The `subscriptions/listen` case is the real buffering test. That stream stays
open indefinitely; its acknowledgement frame is small and immediate. A
buffering proxy would hold it until the response completed, which is never —
so receiving it inside a six-second client timeout is direct evidence that
nothing is buffering.

### Isolation

```text
netns obsidian      net:[4026532377]
netns mcp-bridge    net:[4026532377]   same
netns probe-shared  net:[4026532377]   same
netns probe-network net:[4026532312]   different
```

```text
obsidian published ports  {}
bridge published ports    {}
bridge mounts             ["/etc/nginx/nginx.conf"]  read-only
bridge user               101
bridge readonly rootfs    true
bridge capabilities       ALL dropped, no-new-privileges
token in bridge inspect   0 occurrences
```

The bridge holds no credential. It does not need one: the token is the
caller's to present, and the bridge only relays the header.

### Lifecycle

| Event | Bridge afterwards |
|---|---|
| `compose restart obsidian` | Still routing (`401`) |
| `compose up -d --force-recreate obsidian` | Container stayed `running`; routing restored (`401`) after `compose up -d` |

`depends_on` with `condition: service_healthy` and `restart: true` was enough.
This is what removes the motivation for collapsing the proxy into the Obsidian
image — the failure mode the collapse would have prevented does not occur.

## Findings

### Mediation is required, and the reason is structural

A container's loopback is its own. `probe-network` got `ECONNREFUSED` reaching
the Obsidian service address on port 27200, because nothing is listening
there — the plugin's listener exists only inside the Obsidian namespace. No
Compose network configuration changes this, because it is not a network policy
question.

### Custom bridge code is not justified

Stock NGINX passed every protocol test. The configuration that mattered is
small enough to quote in full:

```nginx
proxy_http_version 1.1;
proxy_set_header Origin "";
proxy_set_header Connection "";
proxy_buffering off;
proxy_request_buffering off;
proxy_intercept_errors off;
proxy_next_upstream off;
proxy_read_timeout 1h;
```

`proxy_http_version 1.1` is **not optional on this version**. NGINX defaulted
to HTTP/1.0 upstream until 1.29.7; the pinned 1.29.1 is before that change, and
SSE over HTTP/1.0 does not work. A future version bump silently makes this line
redundant rather than wrong, which is the safe direction.

The architecture's four bridge requirements — pass MCP headers, strip or
rewrite `Origin`, disable buffering, refuse traffic until upstream is ready —
are all met, the last one at the orchestration layer via a healthcheck-gated
`depends_on` rather than inside NGINX. At runtime, an upstream that goes away
produces a `502`, which is an honest answer rather than a hang.

### A Compose secret is bind-mounted with the host file's ownership

This cost a full failed run and is worth stating plainly, because it will
recur for the runtime container.

Outside swarm, Compose bind-mounts a secret file as-is. The `uid`, `gid`, and
`mode` options under `secrets:` are **swarm-only and silently ignored**. The
token is written `0600` owned by the invoking user, so `curlimages/curl`'s own
uid 100 could not read it. Every authenticated probe returned an empty body
while every unauthenticated one worked — a failure that looks like a proxy bug
and is actually a file permission.

The consequence for the design: any container that must read a `0600` secret
has to run as the uid that owns it, or the secret has to be provisioned some
other way.

### Sharing the namespace works and is still the wrong shape

`probe-shared` reached `127.0.0.1:27200` directly, so a runtime placed in
Obsidian's namespace would function. It would also inherit Docker's
restrictions on that mode: `networks`, `ports`, `hostname`, `--publish`,
`--dns` and friends are all rejected for a container using another container's
network stack.

The runtime would therefore have no service identity of its own, could not
attach to a second network, and would have to publish its Tailscale-facing port
on the Obsidian service. That trades the entire ingress design for the removal
of one small sidecar.

### The deliberate deviation from the approved proposal

The proposal specified `client_max_body_size 1m` on the bridge. The
implementation sets `client_max_body_size 0`.

With NGINX enforcing its own 1 MiB cap, an oversize body would be rejected by
NGINX and the test would prove nothing about the plugin. Disabling it makes the
plugin's own `413` the observed answer, which is what "the size boundary is
preserved" should mean. Both paths returned `413`.

A production bridge **should** re-add a cap as defence in depth. It is left off
here so the measurement means what it claims.

## Architecture impact

Answers to the two standing open questions:

- [01-system-overview.md](../01-system-overview.md) asked whether `mcp-bridge`
  collapses into the Obsidian image once the netns behaviour is proven. It
  should not: the sidecar survived both lifecycle events, holds no secret, and
  keeps one concern per image.
- [03-obsidian-brain.md](../03-obsidian-brain.md)'s bridge requirements are
  confirmed and can now name a concrete implementation.

Nothing is contradicted. No load-bearing decision changes.

## Limitations

This spike does **not** establish:

- **Broker behaviour.** The bridge is deliberately a dumb transport; it
  forwards every path and method to the plugin. Tool allowlisting, per-run
  scoping, schema pinning and request caps are the runtime MCP broker's job and
  are untested here.
- **Real concurrency.** One probe at a time. Nothing measured about connection
  pooling, keepalive reuse, or many simultaneous long-lived streams.
- **Sustained streaming.** The `subscriptions/listen` test proves the first
  frame is not buffered. It does not run long enough to exercise keepalive
  frames or the one-hour read timeout.
- **NGINX as the final choice.** It passed; nothing here shows it is better
  than another proxy. It was chosen for a maintained unprivileged image, not
  after a comparison.
- **A production body cap.** Deliberately disabled, see above.

## Reproducing

```bash
./spikes/obsidian/verify-bridge.sh --cleanup
```

Evidence lands in `tmp/spikes/obsidian/<run-id>/`, with `evidence.json`
carrying the acceptance matrix and `topology.json` the raw probe results.
