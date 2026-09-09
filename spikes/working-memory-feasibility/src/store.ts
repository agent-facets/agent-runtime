// Neo4j persistence.
//
// Two node kinds, deliberately kept apart:
//
//   (:Knowledge)        stands in for the knowledge plane. Written only by the
//                       fixture/host path in this spike, never by a memory op.
//   (:ContextRevision)  the derived working context, append-only, one node per
//                       revision under a (workItemId, revision) uniqueness
//                       constraint.
//
// The context is a derived view. Losing it costs a re-derivation, not a fact,
// which is why it may live next to the knowledge records without becoming an
// authority over them.

import neo4j from "neo4j-driver";
import type { Driver, Session } from "neo4j-driver";

import type { KnowledgeRecord, WorkingContext } from "./context.ts";
import { CONTEXT_SCHEMA } from "./context.ts";

export class StaleContext extends Error {
  readonly expected: number;
  readonly found: number;

  constructor(expected: number, found: number) {
    super(`stale context: expected revision ${expected}, store holds ${found}`);
    this.name = "StaleContext";
    this.expected = expected;
    this.found = found;
  }
}

const SCHEMA = [
  "CREATE CONSTRAINT wm_knowledge_id IF NOT EXISTS FOR (n:Knowledge) REQUIRE n.id IS UNIQUE",
  "CREATE CONSTRAINT wm_work_item_id IF NOT EXISTS FOR (n:WorkItem) REQUIRE n.id IS UNIQUE",
  "CREATE CONSTRAINT wm_context_revision IF NOT EXISTS FOR (n:ContextRevision) REQUIRE (n.workItemId, n.revision) IS UNIQUE",
];

export type Declaration = { id: string; pinned: boolean };

export class Store {
  readonly #driver: Driver;

  private constructor(driver: Driver) {
    this.#driver = driver;
  }

  static async connect(uri = process.env.NEO4J_URI ?? "bolt://neo4j:7687"): Promise<Store> {
    const driver = neo4j.driver(uri);
    await driver.getServerInfo();
    return new Store(driver);
  }

  async close(): Promise<void> {
    await this.#driver.close();
  }

  private session(): Session {
    return this.#driver.session();
  }

  async setup(): Promise<void> {
    const session = this.session();
    try {
      for (const statement of SCHEMA) await session.run(statement);
    } finally {
      await session.close();
    }
  }

  /** Wipe everything this spike owns. Used between tests; never part of the flow. */
  async reset(): Promise<void> {
    const session = this.session();
    try {
      await session.run("MATCH (n) WHERE n:Knowledge OR n:WorkItem OR n:ContextRevision DETACH DELETE n");
    } finally {
      await session.close();
    }
  }

  // --- knowledge plane (host-owned) ----------------------------------------

  /** Create or advance a knowledge record. The host path, not a memory op. */
  async putKnowledge(id: string, text: string): Promise<KnowledgeRecord> {
    const session = this.session();
    try {
      const result = await session.executeWrite((tx) =>
        tx.run(
          `MERGE (k:Knowledge {id: $id})
             ON CREATE SET k.revision = 1, k.text = $text, k.withdrawn = false
             ON MATCH  SET k.revision = k.revision + 1, k.text = $text
           RETURN k.id AS id, k.revision AS revision, k.text AS text, k.withdrawn AS withdrawn`,
          { id, text },
        ),
      );
      return toKnowledge(result.records[0]);
    } finally {
      await session.close();
    }
  }

  async withdrawKnowledge(id: string): Promise<void> {
    const session = this.session();
    try {
      await session.executeWrite((tx) =>
        tx.run("MATCH (k:Knowledge {id: $id}) SET k.withdrawn = true, k.revision = k.revision + 1", {
          id,
        }),
      );
    } finally {
      await session.close();
    }
  }

  async readKnowledge(ids: readonly string[]): Promise<Map<string, KnowledgeRecord>> {
    if (ids.length === 0) return new Map();
    const session = this.session();
    try {
      const result = await session.executeRead((tx) =>
        tx.run(
          `MATCH (k:Knowledge) WHERE k.id IN $ids
           RETURN k.id AS id, k.revision AS revision, k.text AS text, k.withdrawn AS withdrawn`,
          { ids: [...ids] },
        ),
      );
      return new Map(result.records.map((record) => {
        const value = toKnowledge(record);
        return [value.id, value];
      }));
    } finally {
      await session.close();
    }
  }

  // --- work items -----------------------------------------------------------

  /** What knowledge this work item may see, and which of it is pinned. */
  async declareWorkItem(workItemId: string, declared: readonly Declaration[]): Promise<void> {
    const session = this.session();
    try {
      await session.executeWrite((tx) =>
        tx.run(
          `MERGE (w:WorkItem {id: $id})
           SET w.declared = $declared, w.pinned = $pinned`,
          {
            id: workItemId,
            declared: declared.map((d) => d.id),
            pinned: declared.filter((d) => d.pinned).map((d) => d.id),
          },
        ),
      );
    } finally {
      await session.close();
    }
  }

  async readDeclaration(workItemId: string): Promise<Declaration[]> {
    const session = this.session();
    try {
      const result = await session.executeRead((tx) =>
        tx.run("MATCH (w:WorkItem {id: $id}) RETURN w.declared AS declared, w.pinned AS pinned", {
          id: workItemId,
        }),
      );
      const record = result.records[0];
      if (!record) return [];
      const pinned = new Set((record.get("pinned") ?? []) as string[]);
      return ((record.get("declared") ?? []) as string[]).map((id) => ({
        id,
        pinned: pinned.has(id),
      }));
    } finally {
      await session.close();
    }
  }

  // --- working context ------------------------------------------------------

  async latestContext(workItemId: string): Promise<WorkingContext | null> {
    const session = this.session();
    try {
      const result = await session.executeRead((tx) =>
        tx.run(
          `MATCH (c:ContextRevision {workItemId: $id})
           RETURN c.payload AS payload ORDER BY c.revision DESC LIMIT 1`,
          { id: workItemId },
        ),
      );
      const record = result.records[0];
      if (!record) return null;
      return JSON.parse(String(record.get("payload"))) as WorkingContext;
    } finally {
      await session.close();
    }
  }

  /**
   * Append the next revision.
   *
   * `expected` is the revision the caller read. The check runs inside the write
   * transaction, and the uniqueness constraint is the backstop if two writers
   * both pass it, so a concurrent update is refused rather than overwritten.
   */
  async appendContext(context: WorkingContext, expected: number): Promise<WorkingContext> {
    const next: WorkingContext = { ...context, schema: CONTEXT_SCHEMA, revision: expected + 1 };
    const session = this.session();
    try {
      await session.executeWrite(async (tx) => {
        const head = await tx.run(
          `MATCH (c:ContextRevision {workItemId: $id})
           RETURN c.revision AS revision ORDER BY c.revision DESC LIMIT 1`,
          { id: context.workItemId },
        );
        const found = head.records[0] ? Number(head.records[0].get("revision")) : 0;
        if (found !== expected) throw new StaleContext(expected, found);

        await tx.run(
          `CREATE (c:ContextRevision {
             workItemId: $id, revision: $revision, payload: $payload, writtenAt: timestamp()
           })`,
          { id: context.workItemId, revision: next.revision, payload: JSON.stringify(next) },
        );
      });
      return next;
    } catch (error) {
      if (error instanceof StaleContext) throw error;
      const code = (error as { code?: string })?.code ?? "";
      if (String(code).includes("ConstraintValidationFailed")) {
        throw new StaleContext(expected, expected + 1);
      }
      throw error;
    } finally {
      await session.close();
    }
  }

  async revisionCount(workItemId: string): Promise<number> {
    const session = this.session();
    try {
      const result = await session.executeRead((tx) =>
        tx.run("MATCH (c:ContextRevision {workItemId: $id}) RETURN count(c) AS n", {
          id: workItemId,
        }),
      );
      return Number(result.records[0].get("n"));
    } finally {
      await session.close();
    }
  }
}

function toKnowledge(record: { get: (key: string) => unknown }): KnowledgeRecord {
  return {
    id: String(record.get("id")),
    revision: Number(record.get("revision")),
    text: String(record.get("text")),
    withdrawn: Boolean(record.get("withdrawn")),
  };
}
