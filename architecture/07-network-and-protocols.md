# Network and Protocols

## Ingress

Exactly one way in: Tailscale Serve terminating HTTPS in front of loopback.

```text
Laptop · Phone · Coding agent
            │
            ▼
   https://<node>.<tailnet>.ts.net
            │
      Tailscale Serve
            │
      127.0.0.1 only
            │
     ┌──────┴──────┐
     │   runtime   │
     └─────────────┘
```

Rules:

- Every listener reachable from outside the Compose network MUST bind loopback.
  Identity headers from Serve are trustworthy only when nothing else can reach
  the port to forge them. Services that speak only to each other — the Obsidian
  bridge and the MCP broker — bind a container address on the internal network
  instead; Serve never routes there and no host process can reach it. The
  startup assertion is therefore "no listener on a *host-routable* address",
  not "every listener is on `127.0.0.1`".
- Funnel MUST stay off. It is public internet, and it strips identity.
- On WSL2, loopback is reachable from Windows host processes. That is a wider
  trust boundary than on bare Linux, and it is why application authentication
  stays on even behind Serve.
- Docker publishes past host firewalls. Port bindings MUST name `127.0.0.1`
  explicitly rather than relying on a firewall rule.

Path-based routing on one hostname keeps a single certificate and one URL to
remember on a phone.

```text
/                  web UI, REST, SSE
/mcp               remote management MCP
/a2a               A2A adapter
/.well-known/…     agent card
```

## Identity

Serve injects user identity headers for tailnet traffic from user-owned
devices. Laptops and phones get authenticated requests with no auth code on our
side.

Tagged or headless clients do not receive identity headers. Those need either a
bearer token we mint or Tailscale app capabilities, which forward a structured
capability claim for tagged nodes too.

Preferring capabilities means browser and machine clients authorize through the
same mechanism, which is what survives adding a second node later.

## Internal MCP

The Obsidian MCP server is internal-only and MUST NOT be exposed on the Tailnet.

```text
Obsidian MCP          full unrestricted vault access
      │               loopback, shared netns
      ▼
Obsidian bridge       header hygiene, streaming passthrough
      │               internal Docker network
      ▼
Runtime MCP broker    policy: allowlist, scoping, limits
      │
      ▼
Agents
```

Agents never talk to Obsidian directly. The broker is where policy lives, and
it is described in [08-execution-security.md](08-execution-security.md).

The bridge is deliberately **not** a policy layer.
[Spike 02](./spike-reports/02-obsidian-loopback-bridge.md) implements it as
stock NGINX that forwards every path and method to the plugin and does header
hygiene only. Allowlisting, per-run scoping, schema pinning and request caps
belong to the broker above it — splitting policy across both layers would
leave neither able to state the whole rule.

## Remote management MCP

The runtime exposes its **own** MCP server for coding agents — this is how
OpenCode on a laptop delegates work to the node.

This is not a proxy to Obsidian. It is a small, deliberate tool surface over the
runtime's own domain:

```text
list_agents
start_run
get_run
send_run_input
cancel_run
list_approvals
decide_approval
search_memory
get_artifact
```

Five to nine tools, not one per capability. MCP tool surfaces consume context in
every client that connects, so breadth here is a direct tax on the caller.

Long-running work uses durable task semantics so a client can disconnect,
reconnect, and retrieve the result. The transport is Streamable HTTP with
resumable event ids backed by the same event log the UI uses.

## A2A

A2A is for delegation between independent agents, not for our own UI.

Right now there is no second agent to delegate to, so it is not the first thing
to build. It is still worth designing toward because it forces a clean
task/artifact vocabulary, and because it is the only protocol here that solves
"the phone is asleep and the run just finished" through push notifications.

Mapping is total against the internal model:

| Internal | A2A |
|---|---|
| Run | Task |
| Conversation | Context |
| Event | Stream event |
| Artifact | Artifact |
| `awaiting_input` | Input-required state |
| Cancel | Cancel task |

An agent card is published for discovery, with anything sensitive — code
execution in particular — kept out of the unauthenticated card.

## Protocol comparison

| | REST + SSE | Remote MCP | A2A |
|---|---|---|---|
| Consumer | Human | Coding agent as tool user | Peer agent |
| Granularity | Whatever we choose | Tool call | Task lifecycle |
| Reconnect | `Last-Event-ID` | Session + event id | Resubscribe with snapshot |
| Push when offline | No | No | Yes, webhooks |
| Build cost | Low | Medium | Medium-high |
| Value now | Very high | High | Low, rising |

Order: REST and SSE first, then the phone experience, then remote MCP, then A2A.

## Streaming

SSE is the default and the only streaming transport initially. It is
unidirectional server-to-client, which is exactly the shape of "agent emits,
human occasionally acts," and it gets replay for free.

Client actions — approve, cancel, send input — are ordinary POSTs.

WebSocket is deferred. If it arrives, it is a second adapter over the same event
log, never a replacement.

Practical requirements: emit `id: <seq>`, send periodic keepalive comments so
idle proxies do not drop the connection, and never replay across streams.

## Phone

The phone is a supervisory client. Glance, approve, cancel, read a result.

- A PWA over Serve. Installable, no app store, gets the certificate and
  identity headers for free.
- Approvals are the killer feature. A dedicated inbox with a clear diff and
  large tap targets.
- Assume the socket is dead. On foreground: fetch state over REST, then attach
  SSE with `Last-Event-ID`. Correctness MUST NOT require a live connection.
- Request summary-level events, not token deltas. Token streaming to a phone is
  a battery tax with no benefit.
- Consider capping what a phone may authorize. A device in a pocket is the
  weakest link, and destructive approvals can be laptop-only.

## Open questions

- Whether identity is enforced through Tailscale app capabilities from the
  start or a simple bearer token initially.
- Whether the remote MCP surface and the A2A surface share one authorization
  model.
- How push notifications reach a phone without a public endpoint on the node.
  Web Push needs one and Funnel is ruled out, so the shape is likely an off-node
  relay the node calls outbound — unresolved either way.
- Whether other people's nodes are ever peers, which would make A2A load-bearing
  rather than optional.
