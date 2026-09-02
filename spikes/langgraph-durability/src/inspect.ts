// Raw-table observation.
//
// Everything here reads `lg_checkpoints` directly with SQL rather than through
// `getState()` / `getStateHistory()`. Asking the library under test to attest to
// its own lineage is circular: a checkpointer that mis-parents or silently forks
// would report the same wrong answer through the API that shares the bug.

import type { Db } from "./db.ts";
import { CHECKPOINT_SCHEMA, PROBE_SCHEMA, ROOT_NS } from "./contract.ts";

export type CheckpointRow = {
  checkpoint_ns: string;
  checkpoint_id: string;
  parent_checkpoint_id: string | null;
  source: string | null;
  step: number | null;
};

export type WriteRow = {
  checkpoint_ns: string;
  checkpoint_id: string;
  task_id: string;
  idx: number;
  channel: string;
  type: string | null;
  blob_len: number;
  blob_md5: string | null;
};

export type BlobRow = {
  checkpoint_ns: string;
  channel: string;
  version: string;
  type: string | null;
  blob_len: number;
  blob_md5: string | null;
};

export type EventRow = {
  id: string;
  stage: string;
  process_nonce: string;
  node: string;
  phase: string;
  detail: Record<string, unknown>;
  backend_pid: number;
  app_name: string;
};

export type InterruptRow = {
  checkpoint_ns: string;
  checkpoint_id: string;
  task_id: string;
  payload: string;
};

export type Projection = {
  checkpoints: CheckpointRow[];
  writes: WriteRow[];
  blobs: BlobRow[];
  events: EventRow[];
  interrupts: InterruptRow[];
};

export async function project(db: Db, threadId: string): Promise<Projection> {
  const checkpoints = await db.pool.query<CheckpointRow>(
    `SELECT checkpoint_ns,
            checkpoint_id,
            parent_checkpoint_id,
            metadata ->> 'source'        AS source,
            (metadata ->> 'step')::int   AS step
       FROM ${CHECKPOINT_SCHEMA}.checkpoints
      WHERE thread_id = $1
      ORDER BY checkpoint_ns, checkpoint_id`,
    [threadId],
  );

  const writes = await db.pool.query<WriteRow>(
    `SELECT checkpoint_ns,
            checkpoint_id,
            task_id,
            idx,
            channel,
            type,
            COALESCE(octet_length(blob), 0) AS blob_len,
            md5(COALESCE(blob, ''::bytea))  AS blob_md5
       FROM ${CHECKPOINT_SCHEMA}.checkpoint_writes
      WHERE thread_id = $1
      ORDER BY checkpoint_ns, checkpoint_id, task_id, idx`,
    [threadId],
  );

  // `version` is a TEXT column holding an integer. Ordering it as text puts
  // "10" before "2", which silently reshuffles the projection once a thread
  // passes nine supersteps. The cast is what makes the ordering mean what it
  // looks like — the same defect the events query below documents.
  const blobs = await db.pool.query<BlobRow>(
    `SELECT checkpoint_ns,
            channel,
            version,
            type,
            COALESCE(octet_length(blob), 0) AS blob_len,
            md5(COALESCE(blob, ''::bytea))  AS blob_md5
       FROM ${CHECKPOINT_SCHEMA}.checkpoint_blobs
      WHERE thread_id = $1
      ORDER BY checkpoint_ns,
               channel,
               CASE WHEN version ~ '^[0-9]+$' THEN version::numeric END NULLS LAST,
               version`,
    [threadId],
  );

  // `ORDER BY e.id` is qualified deliberately. An unqualified `ORDER BY id`
  // binds to the `id::text` OUTPUT column and sorts lexicographically, which
  // puts event 10 before event 2 and scrambles the causal order of the trace.
  const events = await db.pool.query<EventRow>(
    `SELECT e.id::text AS id, e.stage, e.process_nonce::text AS process_nonce,
            e.node, e.phase, e.detail, e.backend_pid, e.app_name
       FROM ${PROBE_SCHEMA}.event e
      WHERE e.thread_id = $1
      ORDER BY e.id`,
    [threadId],
  );

  // Interrupts are read as raw bytes from the writes table and carry their
  // checkpoint, so "is this interrupt still pending" can be answered against
  // the head rather than against the thread's whole history.
  const interrupts = await db.pool.query<InterruptRow>(
    `SELECT checkpoint_ns,
            checkpoint_id,
            task_id,
            convert_from(blob, 'UTF8') AS payload
       FROM ${CHECKPOINT_SCHEMA}.checkpoint_writes
      WHERE thread_id = $1 AND channel = '__interrupt__'
      ORDER BY checkpoint_ns, checkpoint_id, task_id, idx`,
    [threadId],
  );

  return {
    checkpoints: checkpoints.rows,
    writes: writes.rows,
    blobs: blobs.rows,
    events: events.rows,
    interrupts: interrupts.rows,
  };
}

/** The root graph's checkpoints, newest last. Subgraph namespaces are excluded. */
export function rootCheckpoints(projection: Projection): CheckpointRow[] {
  return projection.checkpoints.filter((row) => row.checkpoint_ns === ROOT_NS);
}

/**
 * The head of the root chain.
 *
 * Derived structurally — the root-namespace row that no other root row claims as
 * a parent — rather than by taking the last id. Id ordering happens to work for
 * the pinned release because checkpoint ids are time-sortable UUIDv6, but that
 * is an assumption about id encoding, not about lineage.
 */
export function rootHead(projection: Projection): CheckpointRow | null {
  const rows = rootCheckpoints(projection);
  if (rows.length === 0) return null;
  const claimed = new Set(
    rows.map((row) => row.parent_checkpoint_id).filter((id): id is string => id !== null),
  );
  const leaves = rows.filter((row) => !claimed.has(row.checkpoint_id));
  // A well-formed chain has exactly one leaf. If it does not, fall back to the
  // last row so the caller still gets an answer, and let the lineage criteria
  // report the malformed shape rather than hiding it behind a null.
  return leaves.length === 1 ? leaves[0]! : (rows.at(-1) ?? null);
}

/** Count backends still attached under a given application_name. */
export async function backendsNamed(db: Db, appNamePrefix: string): Promise<number> {
  const { rows } = await db.pool.query<{ count: string }>(
    `SELECT count(*)::text AS count
       FROM pg_stat_activity
      WHERE application_name LIKE $1 || '%'
        AND pid <> pg_backend_pid()`,
    [appNamePrefix],
  );
  return Number(rows[0]?.count ?? "0");
}

/**
 * Remove only the completed sibling's writes at the head checkpoint.
 *
 * Deleting every write in the thread would also remove the input-step and seed
 * rows, so a rerun could be explained by several mechanisms at once. Scoping it
 * to non-control channels at the head is what makes the control name a cause.
 */
export async function deleteHeadWrites(db: Db, threadId: string): Promise<number> {
  const projection = await project(db, threadId);
  const head = rootHead(projection);
  if (!head) return 0;
  const result = await db.pool.query(
    `DELETE FROM ${CHECKPOINT_SCHEMA}.checkpoint_writes
      WHERE thread_id = $1
        AND checkpoint_ns = $2
        AND checkpoint_id = $3
        AND channel NOT LIKE '\\_\\_%'`,
    [threadId, head.checkpoint_ns, head.checkpoint_id],
  );
  return result.rowCount ?? 0;
}

export type Egress = {
  isolated: boolean;
  tcp: { reached: boolean; errno: string | null };
  dns: { resolved: boolean; errno: string | null };
};

/**
 * Measured, not asserted.
 *
 * A timeout is deliberately NOT treated as isolation: a slow-but-open network
 * would then read as a pass. Only an explicit unreachable/refused errno counts,
 * and DNS is probed separately because a network can block 443 while still
 * resolving names.
 */
export async function measureEgress(): Promise<Egress> {
  const { connect } = await import("node:net");
  const { Resolver } = await import("node:dns/promises");

  const tcp = await new Promise<{ reached: boolean; errno: string | null }>((resolve) => {
    const socket = connect({ host: "1.1.1.1", port: 443 });
    const done = (reached: boolean, errno: string | null) => {
      socket.destroy();
      resolve({ reached, errno });
    };
    socket.setTimeout(3_000, () => done(false, "ETIMEDOUT"));
    socket.once("connect", () => done(true, null));
    socket.once("error", (error) =>
      done(false, (error as NodeJS.ErrnoException).code ?? "EUNKNOWN"),
    );
  });

  const dns = await (async () => {
    const resolver = new Resolver({ timeout: 2_000, tries: 1 });
    try {
      const addresses = await resolver.resolve4("example.com");
      return { resolved: addresses.length > 0, errno: null };
    } catch (error) {
      return { resolved: false, errno: (error as NodeJS.ErrnoException).code ?? "EUNKNOWN" };
    }
  })();

  const blocked = new Set(["ENETUNREACH", "EHOSTUNREACH", "ECONNREFUSED", "EAI_AGAIN"]);
  return {
    isolated: !tcp.reached && !dns.resolved && blocked.has(tcp.errno ?? ""),
    tcp,
    dns,
  };
}
