# agent-runtime

Design and research for a portable, single-node personal agent runtime.

## Status

This repository is pre-implementation. It contains:

- A Bun hello-world scaffold (`index.ts`), not a working agent runtime.
- Architecture documents that record design intent.
- OpenSpec proposals for the MVP.
- Throwaway research harnesses under `spikes/` that tested key assumptions.

Start here:

- [Architecture](./architecture/README.md): design intent and open questions.
- [MVP roadmap](./openspec/roadmaps/framework-mvp.md): proposed scope and sequencing. Where the roadmap and older architecture disagree, the roadmap is current.
- [Spike reports](./architecture/spike-reports/README.md): historical research results. Each report links to its harness.

## Setup

Tool versions are managed with [mise](https://mise.jdx.dev/) (`mise.toml`).

```bash
mise trust
mise install
bun install
```

Run the scaffold:

```bash
bun run index.ts
```

This only prints a greeting. Each spike harness has its own README with separate
requirements such as Docker, Node, or provider credentials. None are needed for
the steps above.

`facets.json` configures optional agent tooling. You don't need it to install or
run the project.

## Worktrees

`.config/wt.toml` configures [Worktrunk](https://worktrunk.dev) to run
`mise trust` when `wt switch --create` creates a worktree. mise records trust by
absolute path, so every new worktree needs it.

- The hook runs only when a worktree is created. Switching to an existing
  worktree does not run it; run `mise trust` there once if mise reports the
  config as untrusted.
- Worktrunk asks you to approve project hooks the first time they run, and again
  if they change.
- Approving this hook means every new worktree automatically trusts the
  `mise.toml` on its branch. When checking out a branch you have not reviewed,
  pass `--no-hooks` and inspect `mise.toml` before trusting it.

## License

[MIT](./LICENSE) © 2026 Agent Facets, Inc.

Third-party material and dependencies keep their own licenses; see
[THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md). Some spike harnesses
download software with separate terms. In particular, the Obsidian spike image
contains proprietary software that should not be redistributed.
