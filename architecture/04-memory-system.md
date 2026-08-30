# Memory System

Memory is the reason this system exists. Everything else is plumbing around it.

## Four kinds of memory

Conflating these is the most common way agent memory rots.

| Kind | Question it answers | Home | Lifetime |
|---|---|---|---|
| **Working** | Where is this run right now? | LangGraph checkpoints | The run |
| **Episodic** | What happened, and when? | Event log, run archives | Retention window |
| **Semantic** | What is true? What was decided? | Obsidian brain | Indefinite |
| **Procedural** | How do we do this? | Obsidian brain, versioned | Indefinite |

A checkpoint is not memory. It is execution state that happens to contain
messages. Treating checkpoint history as the knowledge store produces something
that grows without bound, cannot be searched meaningfully, and cannot be edited
by a human.

## Write path

Memory is not written directly by the agent mid-thought. It is extracted,
reviewed, and consolidated.

```text
   run executes
        │
        ▼
   events appended            episodic, immediate, append-only
        │
        ▼
   run reaches a boundary     turn end or run end
        │
        ▼
   extraction                 candidate facts, decisions, procedures
        │
        ▼
   deduplication              content hash, then semantic match
        │
        ▼
   reconciliation             new · reinforced · superseded · conflicting
        │
        ├── conflicting ──▶ approval queue (human decides)
        │
        ▼
   write to vault             Markdown with provenance frontmatter
        │
        ▼
   index                      chunk, embed, upsert into pgvector
```

Extraction MUST be a distinct step from generation. An agent deciding
mid-response to write a note produces a vault full of restatements of the
conversation.

## Reconciliation

When a candidate memory arrives, it is one of four things:

| Outcome | Condition | Action |
|---|---|---|
| **New** | No semantic match above threshold | Create note |
| **Reinforced** | Matches, same claim | Bump confidence, add source reference |
| **Superseded** | Matches, different claim, newer | Mark old `valid_to`, write successor, link |
| **Conflicting** | Matches, incompatible, unclear which is right | Queue for human decision |

Superseding MUST NOT delete. The old note gets a `valid_to` and a link to its
successor. "What did we believe in March, and why did that change?" is a
question the system should be able to answer.

Bitemporal fields:

- `valid_from` / `valid_to` — when the claim was true in the world.
- `created_at` / `superseded_at` — when the system learned or revised it.

Conflating these makes it impossible to distinguish "the fact changed" from
"we were wrong."

## Retrieval

Vector similarity alone is not enough. Retrieval is multi-channel and fused.

```text
query
  │
  ├── always-loaded         agent profile, active procedures
  ├── lexical               Postgres full-text
  ├── semantic              pgvector, HNSW, cosine
  ├── graph                 wikilink neighbours of strong hits
  ├── recency               recent notes in the active scope
  └── episodic              recent runs on the same subject
  │
  ▼
fuse and deduplicate
  │
  ▼
filter by scope and validity     drop superseded and out-of-window
  │
  ▼
optional rerank
  │
  ▼
context budget                   hard cap, provenance attached
```

Every retrieved chunk carries its note path, git blob sha, and source run. If
the agent asserts something in a response, the chain back to evidence exists.

**The graph channel is the reason Obsidian earns its place.** Once a hit is
found, its links are a curated relevance signal a human maintained — something
no embedding reproduces.

## Index is derived

The pgvector index is rebuildable from the vault. Markdown is authoritative;
the index is a cache.

```text
vault (canonical, Git)
      │  watcher / post-commit diff
      ▼
chunker            heading-aware, ~800 tokens, ~15% overlap
      │
      ▼
embedder           model id + version recorded per row
      │
      ▼
pgvector           chunk, vector, note path, git sha, scope, validity
```

A reconciliation table maps note path to indexed git sha so the indexer knows
what changed. Data flows one way: vault to index, never back. Uncoordinated
two-way writes between a database and a file tree is a losing design.

The embedding model id and dimensions MUST be recorded per row. A model change
becomes a resumable partial reindex rather than a silent relevance collapse or
a dimension-mismatch failure at query time.

## What gets remembered

Not everything. The filter matters more than the mechanism.

**Write:**

- Decisions and their rationale
- Stable facts about projects, people, and systems
- Preferences the human expressed
- Procedures that worked
- Corrections — especially when the human overrode the agent
- Summaries with links back to source events

**Do not write:**

- Restatements of the conversation
- Transient tool output
- Anything containing a credential or token
- Speculation not marked as such
- Third-party personal data with no retention basis

The last two matter because Git history is effectively permanent. Deletion from
a Git-backed vault means history rewriting, which is expensive and incomplete.
Prevention is the only real control.

## Redaction

Extraction MUST redact before writing. A tool result containing an API key that
gets summarized into a note is a credential leak with a permanent home.

Minimum: pattern-based secret detection on every candidate memory, plus a
pre-commit guard as a second layer.

## Consolidation

Background work, not hot path:

| Job | Cadence | Purpose |
|---|---|---|
| Deduplicate | Daily | Merge near-identical notes |
| Link | Daily | Propose wikilinks between related notes |
| Summarize | Weekly | Roll episodic detail into semantic notes |
| Decay | Weekly | Lower confidence on unreinforced, unreferenced claims |
| Audit | Weekly | Broken links, orphans, missing provenance, stale index |

Consolidation proposals that would delete or merge human-authored content
SHOULD require approval.

## Failure modes

| Failure | Symptom | Mitigation |
|---|---|---|
| Over-writing | Vault fills with conversation restatements | Extraction gate, explicit criteria |
| Under-writing | Agent re-learns the same thing weekly | Boundary-triggered extraction, reinforcement tracking |
| Silent contradiction | Two notes disagree, retrieval picks arbitrarily | Reconciliation, conflict queue |
| Stale index | Edited note returns old content | Git sha reconciliation |
| Unjustifiable claim | Agent asserts something with no source | Mandatory provenance |
| Credential in history | Token committed to Git | Redaction plus pre-commit guard |
| Embedding drift | Relevance degrades after model change | Per-row model version, partial reindex |

## Open questions

- Whether extraction runs as a subagent of the originating run or as a separate
  scheduled consolidation pass.
- What the confidence threshold is for auto-writing versus queueing.
- Whether episodic run archives are indexed for retrieval or only searched
  on demand.
- Whether a temporal knowledge graph is worth adding later, or whether
  wikilinks plus bitemporal fields cover the real questions.
- How much context budget memory should get relative to the current task.
