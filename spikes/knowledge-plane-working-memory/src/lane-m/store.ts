// Lane M canonical store: Markdown files with claim-level identity.
//
// One claim, one relationship, one entity, or one decision per file. Revisions
// are append-only sections inside the file, so a claim's history is legible in
// the file that owns it rather than reconstructed from commit history — commit
// time is not transaction time, and a correction bundled into a multi-file
// commit would otherwise be unanswerable at claim granularity.
//
// The version token is the SHA-256 of the canonical file bytes. It is derived
// from canonical state alone, survives a restore, and is equality-only: nothing
// may parse it or order it.

import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import type {
  ClaimRevision,
  ContradictionRecord,
  EntityRecord,
  EvidenceRecord,
  Ref,
  RelationshipRevision,
  ReviewDecisionRecord,
  SourceRefRecord,
} from "../knowledge/contract.ts";
import type { KnowledgeState, PlanOp } from "../knowledge/policy.ts";
import { emptyState } from "../knowledge/policy.ts";
import { publish, readAll as readPublished } from "../coordination/sink.ts";

const DIRECTORIES = [
  "knowledge/entities",
  "knowledge/claims",
  "knowledge/relationships",
  "knowledge/evidence",
  "knowledge/sources",
  "knowledge/contradictions",
  "knowledge/reviews",
  "knowledge/context",
  "peer/records",
  "peer/candidates",
  "_system/intents",
  "_system/rejections",
];



export type MutationIntent = {
  intentId: string;
  command: string;
  /** Every file the mutation will touch, named BEFORE the first write. */
  files: string[];
  /**
   * The plan itself, durable before the first write.
   *
   * Recording only a hash would make an interruption *detectable* and still
   * leave it unrepairable: roll-forward needs the operations, and re-deriving
   * them from current state would plan against a world that has already moved.
   * Every op is idempotent by construction, so replaying a complete plan over a
   * partially applied one converges.
   */
  ops: PlanOp[];
  contentHash: string;
  state: "pending" | "complete";
};

export type StoreRejection = "duplicate_revision" | "duplicate_key" | "incomplete";

/**
 * A write the STORE rejected, mirroring Lane N's `GraphWriteRejected`.
 *
 * Both lanes now attempt the same rejections. Only one of them can make the
 * attempt atomic, and that difference is the measurement — it is not something
 * to hide by letting one lane fail silently where the other raises.
 */
export class StoreWriteRejected extends Error {
  readonly reason: StoreRejection;
  readonly detail: string;

  constructor(reason: StoreRejection, detail: string) {
    super(`store write rejected (${reason}): ${detail}`);
    this.name = "StoreWriteRejected";
    this.reason = reason;
    this.detail = detail;
  }
}

/**
 * Replay is a DIFFERENT mode from a fresh write, and has to be.
 *
 * Roll-forward repair replays a complete plan over a partially applied one, so
 * every op has to converge rather than raise. A fresh write must do the
 * opposite: appending a revision that already exists is precisely the
 * stale-write this lane is trying to reject. One flag, two honest behaviours.
 */
export type ApplyMode = { replay?: boolean };

export class MarkdownStore {
  readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  setup(): void {
    for (const directory of DIRECTORIES) {
      mkdirSync(join(this.root, directory), { recursive: true });
    }
    mkdirSync(join(this.root, "_system/locks"), { recursive: true });
  }

  /**
   * An exclusive per-object lock, held across read-decide-write.
   *
   * This is the safeguard Lane M has to BUILD in order to get what a
   * transactional store provides for free. Without it, two processes that read
   * the same head revision both plan revision N+1 and the second write silently
   * replaces the first — the guard passed for both because both evaluated it
   * against the same stale snapshot.
   *
   * `wx` is the whole mechanism: an atomic create-if-absent on the filesystem.
   * A lock implemented as "check then create" would have the same race it is
   * trying to prevent.
   */
  acquireLock(key: string, timeoutMs: number, pollMs = 10): boolean {
    const safe = key.replace(/[^A-Za-z0-9._-]+/g, "_");
    const path = join(this.root, "_system/locks", `${safe}.lock`);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        writeFileSync(path, `${process.pid}`, { flag: "wx" });
        return true;
      } catch {
        // Busy-wait rather than sleep-and-hope: the lock is released by another
        // process removing the file, which is observable immediately.
        const until = Date.now() + pollMs;
        while (Date.now() < until) {
          /* spin */
        }
      }
    }
    return false;
  }

  releaseLock(key: string): void {
    const safe = key.replace(/[^A-Za-z0-9._-]+/g, "_");
    rmSync(join(this.root, "_system/locks", `${safe}.lock`), { force: true });
  }

  private path(kind: string, id: string): string {
    const safe = id.replace(/[^A-Za-z0-9._-]+/g, "_");
    const folder: Record<string, string> = {
      entity: "knowledge/entities",
      claim: "knowledge/claims",
      relationship: "knowledge/relationships",
      evidence: "knowledge/evidence",
      source: "knowledge/sources",
      contradiction: "knowledge/contradictions",
      decision: "knowledge/reviews",
      context: "knowledge/context",
      peer: "peer/records",
      candidate: "peer/candidates",
    };
    return join(this.root, folder[kind] ?? "knowledge", `${safe}.md`);
  }

  /**
   * Atomic single-file write: temp, then rename.
   *
   * An orphan temp file is harmless garbage; a half-written claim is corruption
   * that a projection would faithfully reproduce.
   *
   * The temp name must be UNIQUE PER WRITER. A shared `${path}.tmp` is not an
   * atomic write at all when two processes target the same object: both write
   * the same temp file and the first rename moves it away, so the second gets
   * `ENOENT` from `rename` and dies with an unhandled error. That surfaced as a
   * race party crashing rather than losing — which would have been recorded as a
   * property of Markdown-canonical storage when it is only a property of this
   * filename.
   */
  private writeAtomic(path: string, body: string): void {
    mkdirSync(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, body, "utf8");
      renameSync(temporary, path);
    } catch (error) {
      try {
        rmSync(temporary, { force: true });
      } catch {
        // An orphan temp file is harmless; the original error is what matters.
      }
      throw error;
    }
  }

  /**
   * Frontmatter plus an append-only revision log, in one deterministic layout.
   *
   * Serialised as canonical JSON inside a fenced block rather than as free YAML:
   * the contract has nested structures (intervals, origins, evidence lists) and
   * Obsidian properties cannot represent nesting, so pretending otherwise would
   * quietly drop half of every claim.
   */
  private render(kind: string, id: string, payload: unknown): string {
    const canonical = JSON.stringify(sortValue(payload), null, 2);
    return [
      "---",
      `kind: ${kind}`,
      `id: ${id}`,
      "schema_version: 1",
      "---",
      "",
      `# ${id}`,
      "",
      "```json",
      canonical,
      "```",
      "",
    ].join("\n");
  }

  private parse(path: string): unknown | null {
    if (!existsSync(path)) return null;
    const text = readFileSync(path, "utf8");
    const start = text.indexOf("```json");
    const end = text.lastIndexOf("```");
    if (start === -1 || end <= start) return null;
    return JSON.parse(text.slice(start + 7, end));
  }

  versionOf(ref: Ref): string | null {
    const path = this.path(ref.kind, ref.id);
    if (!existsSync(path)) return null;
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  }

  /** Every canonical file and its digest: the lane's own freshness token. */
  generation(): { files: Record<string, string>; digest: string } {
    const files: Record<string, string> = {};
    const walk = (directory: string, prefix: string): void => {
      const full = join(this.root, directory);
      if (!existsSync(full)) return;
      for (const name of readdirSync(full).sort()) {
        const relative = `${prefix}/${name}`;
        const candidate = join(full, name);
        if (name.endsWith(".tmp")) continue;
        // A stray subdirectory would otherwise throw EISDIR mid-generation and
        // surface as an anonymous crash rather than as the tree defect it is.
        if (!statSync(candidate).isFile()) continue;
        files[relative] = createHash("sha256").update(readFileSync(candidate)).digest("hex");
      }
    };
    for (const directory of DIRECTORIES) walk(directory, directory);
    const digest = createHash("sha256")
      .update(
        Object.keys(files)
          .sort()
          .map((key) => `${key}:${files[key]}`)
          .join("\n"),
      )
      .digest("hex");
    return { files, digest };
  }

  // -------------------------------------------------------------------------
  // Mutation intents: the A2 mechanism
  // -------------------------------------------------------------------------

  /**
   * Record the intent before the first write.
   *
   * A file tree has no multi-file transaction, so the honest alternative to
   * pretending otherwise is to make an interrupted mutation DETECTABLE and
   * roll-forward repairable. A pending intent with a complete file list is what
   * turns "torn" into "unfinished".
   */
  beginIntent(
    intentId: string,
    command: string,
    files: string[],
    ops: PlanOp[],
    contentHash: string,
  ): void {
    const intent: MutationIntent = {
      intentId,
      command,
      files,
      ops,
      contentHash,
      state: "pending",
    };
    this.writeAtomic(join(this.root, "_system/intents", `${intentId}.json`), JSON.stringify(intent, null, 2));
  }

  /**
   * Roll a pending mutation forward and mark it complete.
   *
   * Roll-FORWARD rather than rollback: a file tree cannot undo a rename that has
   * already landed, but it can finish a plan it durably recorded. Returns the
   * intents it repaired so the repair is reportable rather than silent.
   */
  repairPending(): MutationIntent[] {
    const repaired: MutationIntent[] = [];
    for (const intent of this.pendingIntents()) {
      // Replay mode: the plan is being re-applied over its own partial effects,
      // so an op that already landed must converge instead of being rejected as
      // a duplicate.
      this.apply(intent.ops, { replay: true });
      this.completeIntent(intent.intentId);
      repaired.push(intent);
    }
    return repaired;
  }

  completeIntent(intentId: string): void {
    const path = join(this.root, "_system/intents", `${intentId}.json`);
    if (!existsSync(path)) return;
    const intent = JSON.parse(readFileSync(path, "utf8")) as MutationIntent;
    intent.state = "complete";
    this.writeAtomic(path, JSON.stringify(intent, null, 2));
  }

  pendingIntents(): MutationIntent[] {
    const directory = join(this.root, "_system/intents");
    if (!existsSync(directory)) return [];
    return readdirSync(directory)
      .filter((name) => name.endsWith(".json"))
      .map((name) => JSON.parse(readFileSync(join(directory, name), "utf8")) as MutationIntent)
      .filter((intent) => intent.state === "pending");
  }

  // -------------------------------------------------------------------------
  // Applying a plan
  // -------------------------------------------------------------------------

  /**
   * FAULT INJECTOR. Reproduces the durable state an unclean kill leaves behind.
   *
   * Not a simulation of a crash's *effects* — it performs the real sequence a
   * real crash would interrupt: the intent lands first, some ops are applied,
   * and the intent is never completed. What survives on disk afterwards is
   * exactly what would survive a `SIGKILL` at that point, which is the only way
   * the repair path can be shown to work on the state it actually has to face.
   */
  applyWithCrash(
    intentId: string,
    command: string,
    ops: PlanOp[],
    afterOps: number,
  ): { applied: number } {
    this.beginIntent(intentId, command, [], ops, "");
    const partial = ops.slice(0, afterOps);
    this.apply(partial, { replay: true });
    // Deliberately no `completeIntent`. The pending intent IS the crash.
    return { applied: partial.length };
  }

  apply(ops: PlanOp[], mode: ApplyMode = {}): void {
    const replay = mode.replay === true;
    for (const op of ops) {
      switch (op.op) {
        case "put-source":
          this.writeAtomic(
            this.path("source", op.record.sourceRefId),
            this.render("source", op.record.sourceRefId, op.record),
          );
          break;
        case "put-entity": {
          const path = this.path("entity", op.record.entityId);
          // `wx` is an atomic create-if-absent, which is the only storage-level
          // duplicate rejection a file tree offers. Without it the plan's
          // "this entity is new" assertion was checked only against an in-memory
          // snapshot two concurrent writers both read.
          if (op.mustBeNew && !replay && existsSync(path)) {
            throw new StoreWriteRejected("duplicate_key", `entity ${op.record.entityId} exists`);
          }
          if (op.mustBeNew && !replay) {
            try {
              writeFileSync(path, this.render("entity", op.record.entityId, op.record), {
                encoding: "utf8",
                flag: "wx",
              });
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code === "EEXIST") {
                throw new StoreWriteRejected(
                  "duplicate_key",
                  `entity ${op.record.entityId} exists`,
                );
              }
              throw error;
            }
            break;
          }
          this.writeAtomic(path, this.render("entity", op.record.entityId, op.record));
          break;
        }
        case "ensure-claim": {
          // Import only: create the shell so a derivation edge has something to
          // point at, and never disturb a claim that already has revisions.
          const path = this.path("claim", op.claimId);
          if (!existsSync(path)) {
            this.writeAtomic(path, this.render("claim", op.claimId, { revisions: [] }));
          }
          break;
        }
        case "put-evidence":
          this.writeAtomic(
            this.path("evidence", op.record.evidenceId),
            this.render("evidence", op.record.evidenceId, op.record),
          );
          break;
        case "append-claim-revision": {
          const path = this.path("claim", op.revision.claimId);
          const existing = (this.parse(path) as { revisions?: ClaimRevision[] } | null) ?? {
            revisions: [],
          };
          const revisions = [...(existing.revisions ?? [])];
          const index = revisions.findIndex((entry) => entry.revision === op.revision.revision);
          if (index >= 0 && !replay) {
            // The same rejection Lane N gets from its uniqueness constraint. The
            // difference is that this check is not atomic with the write, which
            // is exactly the property under measurement.
            throw new StoreWriteRejected(
              "duplicate_revision",
              `claim ${op.revision.claimId} revision ${op.revision.revision} exists`,
            );
          }
          if (index >= 0) revisions[index] = op.revision;
          else revisions.push(op.revision);
          this.writeAtomic(path, this.render("claim", op.revision.claimId, { revisions }));
          break;
        }
        case "close-claim-revision": {
          const path = this.path("claim", op.claimId);
          const existing = this.parse(path) as { revisions: ClaimRevision[] } | null;
          // Fail loud. A silent `break` here closed nothing and still reported a
          // commit, which is the file-tree twin of Cypher's zero-row MERGE.
          if (!existing) {
            throw new StoreWriteRejected("incomplete", `claim ${op.claimId} absent for closure`);
          }
          const revisions = existing.revisions.map((entry) =>
            entry.revision === op.revision
              ? {
                  ...entry,
                  assertedUntil: op.until,
                  closureReason: op.reason as ClaimRevision["closureReason"],
                  belief: (op.reason === "corrected"
                    ? "superseded"
                    : "superseded") as ClaimRevision["belief"],
                  valid:
                    op.narrowValidTo === null
                      ? entry.valid
                      : { from: entry.valid.from, to: op.narrowValidTo },
                }
              : entry,
          );
          this.writeAtomic(path, this.render("claim", op.claimId, { revisions }));
          break;
        }
        case "append-relationship-revision": {
          const path = this.path("relationship", op.revision.relationshipId);
          const existing = (this.parse(path) as { revisions?: RelationshipRevision[] } | null) ?? {
            revisions: [],
          };
          // Deduplicated by revision number, exactly as the claim path already
          // was. An unconditional append is NOT idempotent, so roll-forward
          // repair over a plan that had already written this revision duplicated
          // it — breaking the convergence the whole repair design rests on. The
          // corpus never exercised it only because every relationship happens to
          // have exactly one revision.
          const revisions = [...(existing.revisions ?? [])];
          const index = revisions.findIndex((entry) => entry.revision === op.revision.revision);
          if (index >= 0 && !replay) {
            throw new StoreWriteRejected(
              "duplicate_revision",
              `relationship ${op.revision.relationshipId} revision ${op.revision.revision} exists`,
            );
          }
          if (index >= 0) revisions[index] = op.revision;
          else revisions.push(op.revision);
          this.writeAtomic(
            path,
            this.render("relationship", op.revision.relationshipId, { revisions }),
          );
          break;
        }
        case "close-relationship-revision": {
          const path = this.path("relationship", op.relationshipId);
          const existing = this.parse(path) as { revisions: RelationshipRevision[] } | null;
          if (!existing) {
            throw new StoreWriteRejected(
              "incomplete",
              `relationship ${op.relationshipId} absent for closure`,
            );
          }
          const revisions = existing.revisions.map((entry) =>
            entry.revision === op.revision
              ? {
                  ...entry,
                  assertedUntil: op.until,
                  closureReason: op.reason as RelationshipRevision["closureReason"],
                  valid: { from: entry.valid.from, to: op.validTo },
                }
              : entry,
          );
          this.writeAtomic(path, this.render("relationship", op.relationshipId, { revisions }));
          break;
        }
        case "put-contradiction":
          this.writeAtomic(
            this.path("contradiction", op.record.contradictionId),
            this.render("contradiction", op.record.contradictionId, op.record),
          );
          break;
        case "put-decision":
          this.writeAtomic(
            this.path("decision", op.record.decisionId),
            this.render("decision", op.record.decisionId, op.record),
          );
          break;
        case "set-canon": {
          const path = this.path("claim", op.claimId);
          const existing = this.parse(path) as { revisions: ClaimRevision[] } | null;
          if (!existing) {
            throw new StoreWriteRejected("incomplete", `claim ${op.claimId} absent for canon`);
          }
          const revisions = existing.revisions.map((entry) =>
            entry.revision === op.revision ? { ...entry, canon: op.canon } : entry,
          );
          this.writeAtomic(path, this.render("claim", op.claimId, { revisions }));
          break;
        }
        case "purge-claim-content": {
          // Sensitive retraction. Ids, lineage, intervals, and hashes survive so
          // the record stays auditable; the statement text does not survive
          // anywhere, including in earlier revisions.
          const path = this.path("claim", op.claimId);
          const existing = this.parse(path) as { revisions: ClaimRevision[] } | null;
          // An erasure that erases nothing must never report success.
          if (!existing) {
            throw new StoreWriteRejected("incomplete", `claim ${op.claimId} absent for erasure`);
          }
          const revisions = existing.revisions.map((entry) => ({
            ...entry,
            value: "",
            redactionState: "purged" as const,
          }));
          this.writeAtomic(path, this.render("claim", op.claimId, { revisions }));
          for (const revision of existing.revisions) {
            for (const evidenceId of revision.evidenceIds) {
              const evidencePath = this.path("evidence", evidenceId);
              const record = this.parse(evidencePath) as EvidenceRecord | null;
              if (!record) continue;
              this.writeAtomic(
                evidencePath,
                this.render("evidence", evidenceId, {
                  ...record,
                  excerpt: null,
                  redactionState: "purged",
                }),
              );
            }
          }
          break;
        }
        case "put-peer-record":
          this.writeAtomic(
            this.path("peer", op.recordId),
            this.render("peer_record", op.recordId, op.record),
          );
          break;
        case "put-candidate":
          this.writeAtomic(
            this.path("candidate", op.candidateId),
            this.render("candidate", op.candidateId, {
              candidateId: op.candidateId,
              recordId: op.recordId,
              status: "unreviewed",
            }),
          );
          break;
        case "put-active-context":
          this.writeAtomic(
            this.path("context", op.activeContextId),
            this.render("active_context", op.activeContextId, op.record),
          );
          break;
        case "publish-record":
          // Publication is the coordination plane's business, not canonical
          // knowledge, so it leaves the knowledge tree entirely. The writer is
          // shared with Lane N so a difference in published bytes can only come
          // from a difference in what the lane decided to publish.
          publish(this.root, op.recordId, op.record);
          break;
        case "record-rejection": {
          // Contentless by construction: a reason, a source, and a hash. The
          // candidate's subject, predicate, and text are never written.
          const id = createHash("sha256").update(op.contentHash).digest("hex").slice(0, 16);
          this.writeAtomic(
            join(this.root, "_system/rejections", `${id}.json`),
            JSON.stringify(
              {
                reason: op.reason,
                sourceRefId: op.sourceRefId,
                decidedAt: op.decidedAt,
                contentHash: op.contentHash,
              },
              null,
              2,
            ),
          );
          break;
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // Materialising the neutral state snapshot
  // -------------------------------------------------------------------------

  load(): KnowledgeState {
    const state = emptyState();
    const readAll = <T>(directory: string): T[] => {
      const full = join(this.root, directory);
      if (!existsSync(full)) return [];
      return readdirSync(full)
        .filter((name) => name.endsWith(".md"))
        .sort()
        .map((name) => this.parse(join(full, name)) as T)
        .filter((value): value is T => value !== null);
    };

    for (const record of readAll<SourceRefRecord>("knowledge/sources")) {
      state.sources.set(record.sourceRefId, record);
    }
    for (const record of readAll<EntityRecord>("knowledge/entities")) {
      state.entities.set(record.entityId, {
        ...record,
        versionToken: this.versionOf({ kind: "entity", id: record.entityId }) ?? "",
      });
    }
    for (const record of readAll<EvidenceRecord>("knowledge/evidence")) {
      state.evidence.set(record.evidenceId, record);
    }
    for (const file of readAll<{ revisions: ClaimRevision[] }>("knowledge/claims")) {
      const revisions = [...file.revisions].sort((left, right) => left.revision - right.revision);
      const claimId = revisions[0]?.claimId;
      if (!claimId) continue;
      const token = this.versionOf({ kind: "claim", id: claimId }) ?? "";
      state.claims.set(
        claimId,
        revisions.map((revision) => ({ ...revision, versionToken: token })),
      );
    }
    for (const file of readAll<{ revisions: RelationshipRevision[] }>("knowledge/relationships")) {
      const revisions = [...file.revisions].sort((left, right) => left.revision - right.revision);
      const relationshipId = revisions[0]?.relationshipId;
      if (!relationshipId) continue;
      const token = this.versionOf({ kind: "relationship", id: relationshipId }) ?? "";
      state.relationships.set(
        relationshipId,
        revisions.map((revision) => ({ ...revision, versionToken: token })),
      );
    }
    for (const record of readAll<ContradictionRecord>("knowledge/contradictions")) {
      state.contradictions.set(record.contradictionId, record);
    }
    for (const record of readAll<ReviewDecisionRecord>("knowledge/reviews")) {
      state.decisions.set(record.decisionId, record);
    }
    for (const record of readAll<Record<string, unknown>>("peer/records")) {
      state.peerRecords.set(String(record.recordId), record);
    }
    for (const record of readAll<{ candidateId: string; recordId: string }>("peer/candidates")) {
      state.candidates.set(record.candidateId, {
        candidateId: record.candidateId,
        recordId: record.recordId,
        status: "unreviewed",
      });
    }
    for (const record of readAll<Record<string, unknown>>("knowledge/context")) {
      state.activeContexts.set(String(record.activeContextId), record);
    }

    // Published coordination records, read back from their own tree. They are
    // loaded into a separate map and no knowledge query reaches them: a work
    // item's outputs are matched by URI to registered sources, never promoted.
    for (const [key, record] of readPublished(this.root)) state.published.set(key, record);

    const rejections = join(this.root, "_system/rejections");
    if (existsSync(rejections)) {
      for (const name of readdirSync(rejections).sort()) {
        const record = JSON.parse(readFileSync(join(rejections, name), "utf8")) as {
          reason: string;
          sourceRefId: string;
          decidedAt?: string;
          contentHash: string;
        };
        state.rejections.push({ ...record, decidedAt: record.decidedAt ?? "" });
      }
    }

    return state;
  }

  /** Destroy the canonical tree. Used only by the fresh-volume negative control. */
  destroy(): void {
    rmSync(this.root, { recursive: true, force: true });
  }
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) out[key] = sortValue(source[key]);
    return out;
  }
  return value;
}
