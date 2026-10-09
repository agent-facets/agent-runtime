# Runtime facet installation

This directory is the runtime's own facet project. Its `facets.json` and `facets.lock` are managed by the
[`facet` CLI](https://agentfacets.io) and are independent of the repository-root `facets.json`, which configures
coding-tool (editor) facets. The two installations never share a facet home, a manifest or a lockfile, and the
runtime never reads an editor's materialized copies (for example `.opencode/`).

No facets are selected here. Choosing production facets is a separate owner decision.

## What the installation produces

| Path | Contents | Committed |
|---|---|---|
| `facets.json`, `facets.lock` | The selected facets, materialization choices and resolved versions with their CLI-verified integrity | Yes |
| `.agent-runtime-export/` | The `agent-runtime` adapter's per-contribution exports and raw server declarations | No |
| `installation.json` | The sealed bundle the runtime loads, written by `seal` | No |

The facet home (`FACET_DIR`) holds the CLI's adapter installation, cache, locks and machine-local receipts. It lives
outside the repository and is never committed.

## Pinned toolchain

| Tool | Pin |
|---|---|
| `facet` CLI | 0.35.0, Linux x86-64 binary SHA-256 `d6590bb2c1af0119e2bdfcafbfc0dbafe98e6e9ef015ae524926e983fa9a2a46` |
| Adapter SDK | `@agent-facets/adapter` 0.30.0 (adapter API 0.3), bundled into the `agent-runtime` adapter |

The pins live in `packages/facet-adapter/src/toolchain.ts`. `check` and `seal` hash the CLI binary before running
it and refuse any other binary or version, and any other platform. Nothing installs, upgrades or repairs the CLI;
install the pinned release yourself. Changing a pin is a reviewed change.

## Install and seal

Run from the repository root. `FACET_DIR` must be an absolute path to a home used only for the runtime; it must not
be the editor home (`~/.facet`). Because it is absolute, the selected home does not depend on the working directory.

```bash
export FACET_DIR="$HOME/.local/share/agent-runtime/facet-home"

# 1. Build the adapter: a self-contained module in packages/facet-adapter/dist/adapter/.
mise exec -- bun run --cwd packages/facet-adapter build

# 2. Refuse an unpinned CLI or a facet home that holds any other adapter.
mise exec -- bun packages/facet-adapter/src/cli.ts check --project deploy/runtime/facets

# 3. Install (or replace) the runtime adapter in the isolated home. It is used as built: nothing is downloaded.
facet adapter add "$PWD/packages/facet-adapter/dist/adapter"

# 4. Add, update or remove facets with the CLI from this directory, or reproduce the recorded set exactly:
(cd deploy/runtime/facets && facet install --frozen-lockfile)

# 5. Seal. Prints the bundle's SHA-256 for operator configuration.
mise exec -- bun packages/facet-adapter/src/cli.ts seal --project deploy/runtime/facets
```

Installing never starts a run, sends a model request, or launches or contacts a declared MCP server. If any other
adapter is in the runtime home, the CLI would also write that tool's files into this directory. `check` refuses to
continue in that case, and `seal` refuses to seal.

`seal` refuses the whole installation if it cannot be verified: the manifest and lockfile disagree, an export is
missing or unexpected, an export does not match its recorded files, names collide, or the inputs use an unsupported
format. It accepts only strict JSON (no comments) with project manifest version 0.2 and lockfile version 0.3. Only
project-scoped assets are supported. Re-sealing identical recorded inputs with the same toolchain gives identical
bytes.

The bundle's SHA-256 covers the whole file: source provenance, materialization choices, definitions, resources, and
the installer and adapter identities. The digest is not stored inside the bundle. The runtime's installation loader
refuses a bundle whose bytes do not match the owner-pinned digest or are not in canonical form, and it never
rewrites or reseals the installation. The server does not read `installation.json`: operator configuration has no
setting for it, and command runs are not offered.

**Integrity.** Each facet's lockfile integrity and per-file hashes are the CLI's verified source provenance. Skill
companion files are exported byte for byte and checked against those hashes. A command, skill or agent primary file
is transformed during installation: its front matter is removed and its description comes from `facet.json`. Its
export therefore has its own digest, recorded separately. The runtime does not claim that this digest matches the
authored primary file. Trust rests on the pinned CLI and adapter and on the owner-pinned bundle digest. This does not
protect against a compromised installer, or against an owner who changes both the bundle and its pinned digest.

## Supported subset

Runtime behavior comes only from an explicit `agent-runtime` adapter block in `facet.json`:

```json
"commands": {
  "triage": {
    "description": "Triage a report",
    "adapters": {
      "agent-runtime": {
        "runtimeVersion": 1,
        "arguments": { "required": true },
        "requires": [
          { "kind": "skill", "name": "review" },
          { "kind": "agent", "facet": "other-facet", "name": "scout" },
          { "kind": "native", "name": "mcp_Read" }
        ],
        "restrict": { "native": ["mcp_Read", "mcp_Search"], "skills": [{ "name": "review" }], "agents": [] }
      }
    }
  }
}
```

| Kind | Supported fields besides `runtimeVersion: 1` |
|---|---|
| Command | `arguments: { required }` (default `false`), `requires`, `restrict` |
| Skill | `requires`. Companion files come from the skill's declared `files` |
| Agent | `requires`, `restrict`. The agent cannot require or allow another agent |

- `requires` lists skills, agents, native tools (`mcp_Read`, `mcp_Search`, `mcp_AskUser`) or MCP tools
  (`{ "kind": "mcp", "server", "tool" }`). A reference names an item by its authored name. It names the declaring
  facet's item unless it gives `facet`. References are resolved through the recorded aliases and omissions, never
  by installation order or by reading prose.
- `restrict` holds allowlists for `native`, `skills`, `agents` and `mcp`. A missing list inherits; an empty list
  denies that category. Restrictions only narrow what the owner grants and never grant access themselves.
- A contribution is refused, with a reason, when it has no runtime block or uses another version or an unknown or
  malformed field. Examples include a model or tool-selection setting, hooks, or `restrict` on a skill.
- A contribution is also refused when a prerequisite is missing, omitted or refused, or is part of a requirement
  cycle. Unrelated contributions stay usable.
- Primary front matter and other tools' adapter settings are ignored, never interpreted as runtime behavior.
  Commands written for a coding tool usually need explicit runtime adaptation; parity with coding tools is not
  promised.
- Bounds: at most 128 contributions (32 commands, 32 skills, 16 agents), command bodies of 8 KiB, skill and agent
  instructions of 48 KiB, skill files of 1 MiB each (at most 256), and a 16-MiB bundle.

## Server declarations

The adapter exports raw MCP server declarations, but **an installation that declares a server cannot be sealed**.
The public lockfile does not record which facets contributed each server, so the sealer cannot attribute a
declaration to its origin. Instead of guessing an origin or silently dropping the server, it refuses the
installation. To seal the remaining contributions, omit the server in `facets.json`:

```json
"facets": {
  "some-facet": { "source": "1.*", "materialization": { "servers": { "repo-tools": { "kind": "omitted" } } } }
}
```

Contributions that reference MCP tools are refused for the same reason. Exporting or installing a declaration never
approves runtime access to a server.

## Verification

`bun run test:facets` exercises this procedure with synthetic fixture facets (`tests/facets/fixtures/`). Each run
uses its own disposable runtime and editor homes and refuses an unpinned CLI before installing anything. It covers
export, aliasing, omission, removal, repeated and frozen installs, reproducible bytes, altered-bundle refusal,
server-bearing sealing refusal, and isolation between runtime and editor installations in both directions.
