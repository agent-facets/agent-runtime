// Stage 2 context persistence.
//
// Active context lives OUTSIDE the transcript, in the canonical store, under
// labels Stage 1 never reads. Three properties matter and each exists because
// the obvious alternative breaks something measured:
//
//   1. The labels are `:S2Context` and `:S2ContextRevision`, never
//      `:ActiveContext`. Stage 1's `load()` matches `(n:ActiveContext)` and feeds
//      whatever it finds into the shared retrieval fusion's episodic term. Had
//      Stage 2 reused that label, five arms writing five different contexts would
//      have produced five different retrieval rankings, and the locked handoff
//      requires retrieval to be held constant across every arm.
//
//   2. Revisions are append-only nodes written with CREATE under a composite
//      uniqueness constraint on `(contextId, revision)`. This is the Lane N
//      mechanism that actually stopped a lost update in Stage 1. `MERGE … SET
//      payload` — which is what Stage 1's own `PutActiveContext` still does —
//      is last-write-wins, and the one object type Stage 2 mutates most is the
//      last place that belongs.
//
//   3. The guard is checked inside the same write transaction as the insert, so
//      a stale writer is refused at the store rather than by an application
//      check reading a snapshot taken before the write.

import type { Session } from "neo4j-driver";

import type { ActiveContextRevision } from "./contract.ts";
import { ContextRejected } from "./contract.ts";

export const CONTEXT_CONSTRAINTS: readonly string[] = [
  "CREATE CONSTRAINT s2_context_id IF NOT EXISTS FOR (n:S2Context) REQUIRE n.contextId IS UNIQUE",
  "CREATE CONSTRAINT s2_context_revision IF NOT EXISTS FOR (n:S2ContextRevision) REQUIRE (n.contextId, n.revision) IS UNIQUE",
] as const;

export const CONTEXT_INDEXES: readonly string[] = [
  "CREATE INDEX s2_context_work_item IF NOT EXISTS FOR (n:S2Context) ON (n.workItemId)",
] as const;

export class ContextStore {
  private readonly session: () => Session;

  constructor(session: () => Session) {
    this.session = session;
  }

  async setup(): Promise<void> {
    const session = this.session();
    try {
      for (const statement of [...CONTEXT_CONSTRAINTS, ...CONTEXT_INDEXES]) {
        await session.run(statement);
      }
    } finally {
      await session.close();
    }
  }

  /**
   * Append a revision, guarded on the caller's expected version token.
   *
   * `expected` is `null` only for the first revision of a context. A second
   * writer racing the first is refused `CONTEXT_STALE_VERSION` either by the
   * guard or, if both passed it, by the uniqueness constraint on insert.
   */
  async append(revision: ActiveContextRevision, expected: string | null): Promise<void> {
    const session = this.session();
    try {
      await session.executeWrite(async (tx) => {
        const current = await tx.run(
          `MATCH (r:S2ContextRevision {contextId: $contextId})
           RETURN r.revision AS revision, r.versionToken AS versionToken
           ORDER BY r.revision DESC LIMIT 1`,
          { contextId: revision.contextId },
        );

        const head = current.records[0] ?? null;
        const headToken = head ? String(head.get("versionToken")) : null;
        const headRevision = head ? Number(head.get("revision")) : 0;

        if (headToken !== expected) {
          throw new ContextRejected("CONTEXT_STALE_VERSION", {
            contextId: revision.contextId,
            expected,
            observed: headToken,
          });
        }

        if (revision.revision !== headRevision + 1) {
          throw new ContextRejected("CONTEXT_STALE_VERSION", {
            contextId: revision.contextId,
            expectedRevision: headRevision + 1,
            observed: revision.revision,
          });
        }

        await tx.run(
          `MERGE (c:S2Context {contextId: $contextId})
             ON CREATE SET c.workItemId = $workItemId
           RETURN c`,
          { contextId: revision.contextId, workItemId: revision.workItemId },
        );

        // CREATE, never MERGE: the constraint is the backstop, and MERGE would
        // match the row a concurrent writer just committed and SET over it.
        await tx.run(
          `MATCH (c:S2Context {contextId: $contextId})
           CREATE (r:S2ContextRevision {
             contextId: $contextId,
             revision: $revision,
             versionToken: $versionToken,
             workItemId: $workItemId,
             attemptId: $attemptId,
             tick: $tick,
             payload: $payload
           })
           CREATE (c)-[:HAS_CONTEXT_REVISION]->(r)
           RETURN r`,
          {
            contextId: revision.contextId,
            revision: revision.revision,
            versionToken: revision.versionToken,
            workItemId: revision.workItemId,
            attemptId: revision.attemptId,
            tick: revision.tick,
            payload: JSON.stringify(revision),
          },
        );
      });
    } catch (error) {
      throw translate(error, revision.contextId);
    } finally {
      await session.close();
    }
  }

  /** The latest revision, or `null` when the context has never been written. */
  async latest(contextId: string): Promise<ActiveContextRevision | null> {
    const session = this.session();
    try {
      const result = await session.executeRead(async (tx) =>
        tx.run(
          `MATCH (r:S2ContextRevision {contextId: $contextId})
           RETURN r.payload AS payload ORDER BY r.revision DESC LIMIT 1`,
          { contextId },
        ),
      );
      const record = result.records[0];
      if (!record) return null;
      return JSON.parse(String(record.get("payload"))) as ActiveContextRevision;
    } finally {
      await session.close();
    }
  }

  /**
   * The full chain, oldest first.
   *
   * Retained for the experiment so a handoff, a supersession, and a compaction
   * can all be audited after the fact. The latest view alone is derived and
   * rebuildable; the chain is what makes the derivation checkable.
   */
  async chain(contextId: string): Promise<ActiveContextRevision[]> {
    const session = this.session();
    try {
      const result = await session.executeRead(async (tx) =>
        tx.run(
          `MATCH (r:S2ContextRevision {contextId: $contextId})
           RETURN r.payload AS payload ORDER BY r.revision ASC`,
          { contextId },
        ),
      );
      return result.records.map(
        (record) => JSON.parse(String(record.get("payload"))) as ActiveContextRevision,
      );
    } finally {
      await session.close();
    }
  }

  /** Every context for a work item, so a fresh attempt can find its predecessor. */
  async contextsFor(workItemId: string): Promise<string[]> {
    const session = this.session();
    try {
      const result = await session.executeRead(async (tx) =>
        tx.run(
          `MATCH (c:S2Context {workItemId: $workItemId})
           RETURN c.contextId AS contextId ORDER BY c.contextId`,
          { workItemId },
        ),
      );
      return result.records.map((record) => String(record.get("contextId")));
    } finally {
      await session.close();
    }
  }
}

function translate(error: unknown, contextId: string): unknown {
  if (error instanceof ContextRejected) return error;
  const code = (error as { code?: string })?.code ?? "";
  if (typeof code === "string" && code.includes("ConstraintValidationFailed")) {
    return new ContextRejected("CONTEXT_STALE_VERSION", {
      contextId,
      detail: "another writer committed this revision first",
    });
  }
  return error;
}
