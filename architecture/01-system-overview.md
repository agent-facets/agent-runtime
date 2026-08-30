# System Overview

## What this is

A personal agent runtime that runs entirely on one machine you control, exposes
a small control surface over a Tailnet, and backs itself up off-box.

Agents run on the node. Memory lives on the node. Credentials live on the node.
Laptops and phones are thin clients that connect in — they hold no state, so
there is nothing to reconcile between them.

## Goals

1. **Portable.** The whole system MUST run from Docker Compose on any host with
   an OCI runtime — Linux, macOS, or Windows via WSL2.
2. **Single authoritative node.** One copy of state. No multi-device merge.
3. **Durable.** Runs survive process crashes, container restarts, and host
   reboots. Paused work resumes.
4. **Subscription-first.** Model access SHOULD use existing Claude and ChatGPT
   subscriptions rather than metered API billing.
5. **Human-readable memory.** Long-term knowledge lives as Markdown a human can
   read, edit, and link — not as opaque rows.
6. **Recoverable.** A new machine can be rebuilt from Git plus object storage.
7. **Shareable.** A teammate can clone the repository and stand up their own
   node with their own stage, credentials, and bucket.

## Non-goals

- Multi-tenancy, org roles, seat management.
- Public internet exposure. No Tailscale Funnel.
- Horizontal scaling or high availability.
- Being a hosted product.
- Replacing an IDE or a terminal.
- Shipping models. The runtime drives providers; it does not host inference.

## Constraints

| Constraint | Consequence |
|---|---|
| Obsidian's MCP plugin binds `127.0.0.1` and is desktop-only | Obsidian runs headless under Xvfb; a bridge shares its network namespace |
| Claude subscriptions are not API credentials | A dedicated OAuth transport is required per provider |
| LangGraph checkpoints are state, not history | Runs, events, approvals, and idempotency are ours to build |
| AWS SSO sessions expire | Unattended backup MUST NOT depend on an interactive login |
| Agents can be prompt-injected | Tool access is brokered and code execution is sandboxed |

## Whole system

```text
        Laptop            Phone            Coding agent
           │                │                    │
           └────────────────┼────────────────────┘
                            │
                  Tailscale Serve (HTTPS)
                   rathebox.<tailnet>.ts.net
                            │
                     127.0.0.1 only
                            │
┌───────────────────────────▼────────────────────────────────┐
│                     CONTROL PLANE                          │
│  REST + SSE  ·  Remote MCP  ·  A2A  ·  Web UI              │
│                            │                               │
│              protocol-free runtime core                    │
│     Run · Task · Event · Approval · Artifact · Memory      │
│                            │                               │
│                 LangGraph manager graph                    │
│              checkpoints · interrupts · resume             │
└───────┬───────────────┬───────────────────┬────────────────┘
        │               │                   │
        ▼               ▼                   ▼
┌───────────────┐  ┌──────────────┐  ┌──────────────────────┐
│  PostgreSQL   │  │ Model        │  │  Runtime MCP broker  │
│  + pgvector   │  │ transports   │  │  allowlist · limits  │
│               │  │              │  │  per-run scoping     │
│ checkpoints   │  │ Claude sub   │  └──────────┬───────────┘
│ runs, events  │  │ ChatGPT sub  │             │
│ approvals     │  │ API fallback │             ▼
│ memory index  │  └──────────────┘  ┌──────────────────────┐
└───────────────┘                    │  Obsidian bridge     │
                                     │  shared netns        │
        ┌──────────────┐             └──────────┬───────────┘
        │  Sandboxed   │                        │
        │  workspaces  │                        ▼
        │  rootless    │             ┌──────────────────────┐
        │  no socket   │             │  Obsidian (Xvfb)     │
        └──────────────┘             │  MCP plugin :27200   │
                                     │  /vault              │
                                     └──────────┬───────────┘
                                                │
                                                ▼
                                     ┌──────────────────────┐
                                     │  Git-backed brain    │
                                     │  Markdown only       │
                                     └──────────────────────┘

        Local CAS artifacts + JSONL/Parquet run archives
                            │
                            ▼
              Thin SST API (Lambda) → private S3
                    per-user stage, shared secret
```

## Boundaries

The three hard boundaries in this system:

**Knowledge vs. execution.** Obsidian holds what the system knows. Postgres
holds what the system did. A note is not a checkpoint; a checkpoint is not a
note. Crossing this boundary is how both stores rot.

**Runtime vs. protocol.** The core knows about runs and tasks. It does not know
about HTTP, MCP, or A2A. Every adapter is a projection of the same event log,
which is what makes reconnection and replay work identically everywhere.

**Trusted vs. model-controlled.** The control plane holds credentials and can
spawn containers. Agents and sandboxes hold neither. The broker sits on the
seam.

## Deployment shape

Compose services:

| Service | Role | Network |
|---|---|---|
| `postgres` | Checkpoints, runs, events, memory index | internal |
| `runtime` | LangGraph control plane, adapters, web UI | internal + loopback publish |
| `obsidian` | Headless Obsidian with MCP plugin | internal, owns a shared netns |
| `mcp-bridge` | Reaches Obsidian's loopback MCP | joins `obsidian` netns |
| `backup` | Snapshots, archives, S3 upload | internal |

Nothing publishes to `0.0.0.0`. Tailscale Serve is the only ingress, and it
proxies to loopback.

Volumes:

| Volume | Contents | Backed up |
|---|---|---|
| `pgdata` | Postgres | Yes, via snapshot |
| `vault` | Obsidian Markdown, Git repo | Yes, via Git and archive |
| `artifacts` | Content-addressed blobs | Yes, incrementally |
| `archives` | Completed run logs | Yes |
| `credentials` | OAuth tokens, mode `0600` | Encrypted, separate path |
| `obsidian-config` | Electron profile, vault registry | No, regenerated |

## Open questions

- Whether the runtime and web UI ship as one container or two.
- Whether the node's own agents should be reachable by other people's nodes, or
  only by the owner's clients.
- Whether `mcp-bridge` stays a separate container or collapses into the
  Obsidian image once the netns behaviour is proven.
