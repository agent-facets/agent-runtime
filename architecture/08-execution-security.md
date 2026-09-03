# Execution Security

## Threat model

The adversary is our own model, plus anything it reads. A web page, a repository
file, or a note in the vault can carry an instruction the agent follows.

This is not hypothetical, and it is not solved by prompting. The agent runs
inside the trusted process. Every control below assumes it will eventually try
something it should not.

The security posture is: **the agent decides what to attempt; the runtime
decides what is possible.**

## Trust tiers

Every agent definition declares a tier. The tier determines isolation, network
access, and approval requirements.

| Tier | Work | Isolation | Network | Approval |
|---|---|---|---|---|
| T0 | Read-only research | In-process | Allowlisted HTTP | None |
| T1 | Vault read | In-process, brokered MCP | None | None |
| T2 | Vault write | In-process, brokered MCP | None | Batched |
| T3 | Code execution | Rootless ephemeral container | None or proxy | Per workspace |
| T4 | Git push, credential use | Broker only, never in sandbox | Targeted | Always, per action |

Tiers are not advisory. The runtime enforces them; an agent cannot widen its
own tier, and a subagent cannot exceed its parent's.

## MCP broker

The Obsidian MCP server is unrestricted by design — it can read and write the
entire vault. Handing that directly to an agent means one prompt injection is
total vault compromise.

The broker sits between them.

```text
Obsidian MCP              full toolset, internal only
      │
      ▼
Runtime MCP broker        per-run endpoint
      │                   ├── unguessable path token
      │                   ├── method allowlist
      │                   ├── tool allowlist per agent definition
      │                   ├── tool schema digest pinning
      │                   ├── request size and call count caps
      │                   ├── concurrency limit
      │                   └── lifetime bound to the run
      ▼
Agent
```

Design points:

- **Ephemeral per run.** The endpoint exists for the run's lifetime, on an
  unguessable path. No long-lived MCP port, even internally.
- **The real token never reaches the agent.** The broker holds it; the agent
  gets a run-scoped credential.
- **Tool list is rewritten** to only the approved set, so the agent cannot see
  or attempt a tool it lacks.
- **Schema digests are pinned.** If an upstream tool's input schema changes, the
  call fails closed as "requires review" rather than silently exposing new
  semantics after a plugin upgrade.
- **Caps are enforced** on request size, calls per run, and concurrency.

Schema pinning is the subtle one. A plugin update that adds a parameter to an
approved tool is a permission change that no version number announces.

## Code execution

Two rules dominate everything else.

**1. The container runtime socket MUST NEVER be reachable from a
model-controlled process.** Not mounted, not proxied, not present in the
environment. Access to it is arbitrary code execution as the daemon user with no
audit and no limit. This includes not leaving a `DOCKER_HOST`-style variable in
the runtime's environment where a spawned process inherits it.

**2. A separate, non-LLM broker owns container lifecycle.**

```text
Control plane
      │  narrow RPC over a unix socket
      ▼
Executor broker              separate uid, no model in the loop
      │  chooses image, flags, limits, network policy
      ▼
Ephemeral rootless container
```

The broker's RPC is deliberately small and non-expressive:

```text
CreateWorkspace(repo_ref, resource_profile) -> workspace_id
Exec(workspace_id, argv[], timeout)         -> {exit_code, stdout, stderr}
ReadArtifact(workspace_id, rel_path)        -> bytes
Destroy(workspace_id)
```

`Exec` takes an argv array, never a shell string. Paths are traversal-checked.
The model influences validated parameters only — never flags. If the broker ever
grows a passthrough for raw runtime arguments, the design is dead.

## Sandbox properties

| Property | Requirement |
|---|---|
| Root | Rootless, dedicated uid range per workspace |
| Filesystem | Read-only root, tmpfs `/tmp`, explicit workspace mount |
| Capabilities | Drop all, no new privileges |
| Kernel surface | A second isolation layer where the toolchain tolerates it |
| Network | Deny by default; dependency installs go through an allowlisting proxy |
| Resources | Memory, CPU, pids, and disk quota via cgroups |
| Lifetime | Ephemeral, wall-clock timeout enforced by the broker |
| Credentials | None. No SSH agent, no cloud config, no tokens |

Egress control is the highest-value single control against exfiltration, and it
is far easier to get right at a proxy than inside the container.

Git operations happen **outside** the sandbox. The broker clones in and pushes
out after approval. The sandbox sees a working tree, never a remote and never a
credential.

Artifacts are pulled by the broker and hashed on the way out. The sandbox does
not write into shared storage.

## Secrets

| Secret | Home | Reachable by |
|---|---|---|
| Model OAuth tokens | Credential volume, `0600` | Control plane only |
| Obsidian MCP token | Docker secret | Obsidian, bridge, broker |
| Backup shared secret | Docker secret | Backup job only |
| Git push credential | Broker only | Broker only |

Rules:

- Secrets MUST NOT appear in environment variables where a child process
  inherits them or `inspect` reveals them.
- Secrets MUST NOT be written into prompts, event payloads, notes, archives, or
  error messages.
- Error paths need explicit scrubbing. An unhandled error carrying an
  `Authorization` header into a log is a leak with a permanent home.
- Memory extraction MUST redact before writing, because a Git-backed vault makes
  deletion expensive and incomplete.

## Approvals as a control

Approvals are a security mechanism, not just UX. They are the human check on the
actions the runtime cannot judge automatically.

Always require approval for:

- Creating a code-execution workspace
- Any Git push or branch mutation
- Credential use outside the model transports
- Deleting or merging human-authored vault content
- Network egress to a destination not on the allowlist
- Widening any agent's tool set or trust tier

Approvals MUST record who decided, when, and what exactly was approved —
including a content hash of the payload, so a later argument about what was
authorized has an answer.

## Prompt injection

Layered, because no single layer works:

1. **Capability limits.** The agent cannot do what the tier forbids, regardless
   of what it was told.
2. **Tool allowlists.** The dangerous tool is not in the list.
3. **Egress control.** Exfiltration has nowhere to go.
4. **Approval gates.** Consequential actions need a human.
5. **Provenance.** Injected content is traceable to its source.
6. **Content marking.** Fetched external content SHOULD be labelled as untrusted
   in context.

Note that a write-only filesystem sandbox does not stop credential
exfiltration. Scoping the network and the secrets matters more than scoping the
filesystem.

## Testing

| Test | Asserts |
|---|---|
| Socket unreachable | No container runtime access from any agent process |
| Loopback binding | Startup fails if any listener binds a host-routable address |
| Funnel off | Periodic check that no public exposure exists |
| Broker allowlist | A denied tool fails closed and is logged |
| Schema pinning | A changed upstream schema blocks the call |
| Egress | A sandbox cannot reach a non-allowlisted host |
| Red team | An injection corpus explicitly instructed to escape fails |
| Credential absence | The node functions with no cloud credentials mounted |

The red-team corpus is the one that finds real problems. It SHOULD be part of
the test suite, not an occasional exercise.

## Open questions

- Which second isolation layer to standardize on, and which toolchains break
  under it.
- Whether the egress proxy is per-workspace or shared with per-workspace policy.
- Whether T3 workspaces get any vault access at all, or only through artifacts
  the broker copies in.
- How approval fatigue is managed without quietly widening defaults.

The broker's phasing is **settled**, not open: it ships in P9 and code execution
stays disabled until it exists — see
[10-delivery-phases.md](10-delivery-phases.md).
