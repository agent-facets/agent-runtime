// Statement-level observation and parking, without touching vendor SQL.
//
// Spike 05 gated at the public API boundary: it held the first `put`/`putWrites`
// before delegating. That cannot express "kill after the first blob upsert but
// before the checkpoint row", because both statements live inside one `put()`.
//
// So the gate sits at the pg client boundary instead. `pool.on('connect')` fires
// once per physical connection; the client's `query` is replaced on that
// instance, and the replacement passes `text` and `values` through
// byte-identically. The guarantee that nothing was rewritten is not a promise in
// this comment: `statementMultiset()` from a gated run must equal the multiset
// from an ungated run of the same operation, and summarize checks it.

import { createHash } from "node:crypto";
import type pg from "pg";
import type { Db } from "./db.ts";
import { PROBE_SCHEMA } from "./contract.ts";

export type StatementRecord = {
  label: string;
  ordinal: number;
  sqlHash: string;
  paramCount: number;
  startedAt: number;
  durationMs: number;
  failed: boolean;
  sqlstate: string | null;
};

export type StatementSink = {
  statements: StatementRecord[];
  counters: Map<string, number>;
};

export function createSink(): StatementSink {
  return { statements: [], counters: new Map() };
}

/**
 * A fixed classification table. A statement matching none of these is labelled
 * `unclassified`, and any unclassified statement is a fault at summarize time:
 * it means the vendor emitted SQL this harness does not recognise, and every
 * gate ordinal downstream of it is then unsound.
 */
const PATTERNS: Array<[string, RegExp]> = [
  ["txn.begin", /^\s*BEGIN\s*$/i],
  ["txn.commit", /^\s*COMMIT\s*$/i],
  ["txn.rollback", /^\s*ROLLBACK\s*$/i],

  ["ckpt.migration-read", /SELECT\s+v\s+FROM\s+[^\s]*checkpoint_migrations/i],
  ["ckpt.migration-ledger", /INSERT\s+INTO\s+[^\s]*checkpoint_migrations/i],
  ["ckpt.blob-upsert", /INSERT\s+INTO\s+[^\s]*checkpoint_blobs/i],
  ["ckpt.checkpoint-upsert", /INSERT\s+INTO\s+[^\s]*\.?"?checkpoints"?\s*\(/i],
  ["ckpt.write-upsert", /INSERT\s+INTO\s+[^\s]*checkpoint_writes[\s\S]*DO\s+UPDATE/i],
  ["ckpt.write-insert", /INSERT\s+INTO\s+[^\s]*checkpoint_writes/i],
  ["ckpt.delete-blobs", /DELETE\s+FROM\s+[^\s]*checkpoint_blobs/i],
  ["ckpt.delete-writes", /DELETE\s+FROM\s+[^\s]*checkpoint_writes/i],
  ["ckpt.delete-checkpoints", /DELETE\s+FROM\s+[^\s]*\.?"?checkpoints"?\s/i],
  ["ckpt.select-pending-sends", /pending_sends/i],
  ["ckpt.select", /FROM\s+[^\s]*\.?"?checkpoints"?\s/i],
  ["ckpt.migration-ddl", /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+[^\s]*checkpoint/i],
  ["ckpt.migration-alter", /ALTER\s+TABLE\s+[^\s]*checkpoint_blobs/i],

  ["store.migration-read", /SELECT\s+v\s+FROM\s+[^\s]*store_migrations/i],
  ["store.migration-ledger", /INSERT\s+INTO\s+[^\s]*store_migrations/i],
  ["store.create-extension", /CREATE\s+EXTENSION/i],
  ["store.migration-trigger", /CREATE\s+TRIGGER|DROP\s+TRIGGER/i],
  ["store.migration-function", /CREATE\s+OR\s+REPLACE\s+FUNCTION/i],
  ["store.migration-index", /CREATE\s+INDEX/i],
  ["store.migration-ddl", /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+[^\s]*store/i],
  ["store.vector-delete", /DELETE\s+FROM\s+[^\s]*store_vectors/i],
  ["store.vector-insert", /INSERT\s+INTO\s+[^\s]*store_vectors/i],
  ["store.upsert", /INSERT\s+INTO\s+[^\s]*\.?"?store"?\s*\(/i],
  ["store.delete", /DELETE\s+FROM\s+[^\s]*\.?"?store"?\s/i],
  ["store.update-ttl", /UPDATE\s+[^\s]*\.?"?store"?\s/i],
  ["store.select", /FROM\s+[^\s]*\.?"?store"?[\s"]/i],

  ["ddl.create-schema", /CREATE\s+SCHEMA/i],
  ["harness.probe", new RegExp(`${PROBE_SCHEMA}\\.`, "i")],
  ["harness.advisory", /pg_(try_)?advisory/i],
  ["harness.catalog", /pg_stat_activity|pg_locks|pg_class|information_schema|pg_control_system/i],
  ["harness.ping", /^\s*SELECT\s+1\s*$/i],
];

export function classifyStatement(sql: string): string {
  for (const [label, pattern] of PATTERNS) {
    if (pattern.test(sql)) return label;
  }
  return "unclassified";
}

export function hashStatement(sql: string): string {
  return createHash("sha256").update(sql.replace(/\s+/g, " ").trim()).digest("hex").slice(0, 16);
}

export type GatePosition = "pre" | "post";

export type GateSpec = {
  name: string;
  /** The classification label this gate binds to. */
  label: string;
  /** 1-based occurrence of that label on the instrumented pool. */
  ordinal: number;
  /**
   * `post` awaits its hook after the underlying query has SETTLED — for both
   * fulfilment and rejection — and before the value is returned or the error is
   * rethrown into vendor code. That is what makes a gate on a statement which
   * legitimately rejects (the cold `SELECT v` raising 42P01) implementable at
   * all, and it is what bounds the acknowledged-commit boundary.
   */
  position: GatePosition;
};

export type GateHook = (gate: GateSpec, statement: StatementRecord) => Promise<void>;

export type Instrumentation = {
  sink: StatementSink;
  /**
   * Both are functions on purpose. A snapshot taken at instrumentation time is
   * always empty, which makes "no gate was left unreached" pass vacuously —
   * exactly the failure mode the no-missing-data rule exists to catch.
   */
  reached(): string[];
  unreached(): string[];
};

type QueryArgs = [unknown, unknown?, unknown?];

export function instrumentPool(
  pool: pg.Pool,
  sink: StatementSink,
  gates: GateSpec[],
  hook: GateHook,
): Instrumentation {
  const reached = new Set<string>();

  const patch = (client: pg.PoolClient | pg.Client): void => {
    const anyClient = client as unknown as { query: (...args: unknown[]) => unknown; __gated?: true };
    if (anyClient.__gated) return;
    anyClient.__gated = true;
    const original = anyClient.query.bind(client);

    anyClient.query = function patched(...args: QueryArgs): unknown {
      const first = args[0] as string | { text?: string; values?: unknown[] } | undefined;
      const text = typeof first === "string" ? first : (first?.text ?? "");
      const values = Array.isArray(args[1])
        ? (args[1] as unknown[])
        : typeof first === "object" && first !== null && Array.isArray(first.values)
          ? first.values
          : [];

      // Callback form is recorded and delegated untouched rather than silently
      // changed in shape — so a gate can never bind to one.
      //
      // That is not a limitation in practice: every vendor write path acquires a
      // client and awaits `client.query(text, values)`. It DOES mean a gate can
      // never bind to a `pool.query()` call, because pg-pool always dispatches
      // that internally as `client.query(text, values, callback)`. Harness code
      // that wants to be gated must take a client explicitly, which is also what
      // makes it comparable to the vendor path it is a control for.
      const hasCallback = typeof args[args.length - 1] === "function";
      const label = classifyStatement(text);
      const ordinal = (sink.counters.get(label) ?? 0) + 1;
      sink.counters.set(label, ordinal);

      const record: StatementRecord = {
        label,
        ordinal,
        sqlHash: hashStatement(text),
        paramCount: values.length,
        startedAt: Date.now(),
        durationMs: -1,
        failed: false,
        sqlstate: null,
      };
      sink.statements.push(record);

      if (hasCallback) return original(...args);

      const matching = gates.filter((gate) => gate.label === label && gate.ordinal === ordinal);
      const pre = matching.filter((gate) => gate.position === "pre");
      const post = matching.filter((gate) => gate.position === "post");

      return (async () => {
        for (const gate of pre) {
          reached.add(gate.name);
          await hook(gate, record);
        }
        try {
          const result = await original(...args);
          record.durationMs = Date.now() - record.startedAt;
          for (const gate of post) {
            reached.add(gate.name);
            await hook(gate, record);
          }
          return result;
        } catch (error) {
          record.durationMs = Date.now() - record.startedAt;
          record.failed = true;
          record.sqlstate = (error as { code?: string } | null)?.code ?? null;
          for (const gate of post) {
            reached.add(gate.name);
            await hook(gate, record);
          }
          throw error;
        }
      })();
    } as typeof anyClient.query;
  };

  pool.on("connect", patch);

  return {
    sink,
    reached: () => [...reached],
    unreached: () => gates.filter((gate) => !reached.has(gate.name)).map((gate) => gate.name),
  };
}

/** Label -> count. The pass-through oracle: gated and ungated runs must agree. */
export function statementMultiset(sink: StatementSink): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const statement of sink.statements) {
    counts[statement.label] = (counts[statement.label] ?? 0) + 1;
  }
  return counts;
}

export function statementShape(sink: StatementSink): Array<{ label: string; hash: string }> {
  return sink.statements.map((statement) => ({
    label: statement.label,
    hash: statement.sqlHash,
  }));
}

/**
 * A durable park recorded from inside a NODE body rather than from a statement
 * gate.
 *
 * Families C and A anchor their kills on a vendor SQL boundary, because the
 * question there is what one `put()` leaves behind when it is cut in half.
 * Families E and H ask a different question — what a re-executed node computes —
 * and for that the kill has to land while user code is running, before the
 * task's writes exist at all. Counting statement ordinals to find that moment
 * would be guesswork about how many statements a superstep happens to emit;
 * parking in the node body is exact.
 *
 * It uses the same `gate_park` table, so the driver's `awaitpark` contract is
 * unchanged and the kill is still anchored on an observed durable row rather
 * than on a sleep. `position` is `node` so a park from user code is never
 * mistaken in evidence for a park at a vendor statement.
 */
export async function recordNodePark(
  db: Db,
  caseId: string,
  party: number,
  gate: string,
  node: string,
): Promise<void> {
  await db.pool.query(
    `INSERT INTO ${PROBE_SCHEMA}.gate_park
       (case_id, party, gate, position, statement, ordinal)
     VALUES ($1, $2, $3, 'node', $4, 0)`,
    [caseId, party, gate, node],
  );
}

export async function recordPark(
  db: Db,
  caseId: string,
  party: number,
  gate: GateSpec,
  statement: StatementRecord,
): Promise<void> {
  await db.pool.query(
    `INSERT INTO ${PROBE_SCHEMA}.gate_park
       (case_id, party, gate, position, statement, ordinal)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [caseId, party, gate.name, gate.position, statement.label, statement.ordinal],
  );
}
