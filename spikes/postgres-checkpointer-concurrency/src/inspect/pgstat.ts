// Server-side witnesses: activity, lock graphs, backend drain, cluster identity.
//
// Every lock claim in this spike needs a captured blocked -> blocking edge.
// Elapsed time is not evidence: a slow statement and a blocked one are
// indistinguishable from the client, and the plan forbids inferring contention
// from duration.

import type { Db } from "../db.ts";
import { TIMEOUTS } from "../contract.ts";

export type ActivityRow = {
  pid: number;
  application_name: string;
  state: string | null;
  wait_event_type: string | null;
  wait_event: string | null;
  backend_xid: string | null;
  backend_xmin: string | null;
};

export type LockEdge = {
  blockedPid: number;
  blockedApp: string;
  blockingPid: number;
  blockingApp: string;
  locktype: string;
  mode: string;
  relation: string | null;
};

export type LockGraph = {
  sampledAt: string;
  edges: LockEdge[];
  edgeCount: number;
  selfEdges: number;
  /** Ungranted locks whose holder could not be attributed to a participant. */
  unattributedBackends: number;
  /** pg_locks and pg_blocking_pids must agree; disagreement is a fault. */
  oraclesAgree: boolean;
};

export async function activity(db: Db, appPrefix: string): Promise<ActivityRow[]> {
  const { rows } = await db.pool.query<ActivityRow>(
    `SELECT pid, application_name, state, wait_event_type, wait_event,
            backend_xid::text  AS backend_xid,
            backend_xmin::text AS backend_xmin
       FROM pg_stat_activity
      WHERE application_name LIKE $1 || '%'
        AND pid <> pg_backend_pid()
      ORDER BY application_name, pid`,
    [appPrefix],
  );
  return rows;
}

export async function lockGraph(db: Db, appPrefix: string): Promise<LockGraph> {
  const edges = await db.pool.query<LockEdge & { blocked_pid: number }>(
    `SELECT blocked.pid                        AS "blockedPid",
            blocked.application_name           AS "blockedApp",
            bp.pid                             AS "blockingPid",
            COALESCE(blocking.application_name, '') AS "blockingApp",
            bl.locktype                        AS locktype,
            bl.mode                            AS mode,
            CASE WHEN bl.relation IS NULL THEN NULL
                 ELSE bl.relation::regclass::text END AS relation
       FROM pg_locks bl
       JOIN pg_stat_activity blocked ON blocked.pid = bl.pid
       JOIN LATERAL unnest(pg_blocking_pids(bl.pid)) AS bp(pid) ON true
       LEFT JOIN pg_stat_activity blocking ON blocking.pid = bp.pid
      WHERE NOT bl.granted
        AND blocked.application_name LIKE $1 || '%'
      ORDER BY 1, 3, 5, 6`,
    [appPrefix],
  );

  // Second, independent projection: the raw ungranted set. If pg_locks reports a
  // waiter that pg_blocking_pids does not explain, the graph is not trustworthy.
  const ungranted = await db.pool.query<{ pid: number; application_name: string }>(
    `SELECT DISTINCT bl.pid, a.application_name
       FROM pg_locks bl
       JOIN pg_stat_activity a ON a.pid = bl.pid
      WHERE NOT bl.granted
        AND a.application_name LIKE $1 || '%'`,
    [appPrefix],
  );

  const explained = new Set(edges.rows.map((edge) => edge.blockedPid));
  const oraclesAgree = ungranted.rows.every((row) => explained.has(row.pid));

  const { rows: now } = await db.pool.query<{ now: string }>(
    "SELECT clock_timestamp()::text AS now",
  );

  return {
    sampledAt: now[0]?.now ?? "",
    edges: edges.rows,
    edgeCount: edges.rows.length,
    selfEdges: edges.rows.filter((edge) => edge.blockedPid === edge.blockingPid).length,
    unattributedBackends: edges.rows.filter((edge) => edge.blockingApp === "").length,
    oraclesAgree,
  };
}

/** Poll until at least one blocked -> blocking edge exists. No edge is a fault. */
export async function waitForLockEdge(
  db: Db,
  appPrefix: string,
  timeoutMs = TIMEOUTS.lockEdgeWaitMs,
): Promise<LockGraph> {
  const deadline = Date.now() + timeoutMs;
  let last: LockGraph | null = null;
  for (;;) {
    last = await lockGraph(db, appPrefix);
    if (last.edgeCount > 0) return last;
    if (Date.now() > deadline) {
      throw new Error(`no blocked->blocking edge appeared within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, TIMEOUTS.lockEdgePollMs));
  }
}

export async function backendsNamed(db: Db, appPrefix: string): Promise<number> {
  const { rows } = await db.pool.query<{ count: string }>(
    `SELECT count(*)::text AS count
       FROM pg_stat_activity
      WHERE application_name LIKE $1 || '%'
        AND pid <> pg_backend_pid()`,
    [appPrefix],
  );
  return Number(rows[0]?.count ?? "0");
}

/**
 * A SIGKILL leaves no FIN, so a killed process's backend can outlive its
 * container and still hold locks. Projecting before it drains reads a lie.
 */
export async function waitForDrain(
  db: Db,
  appPrefix: string,
  timeoutMs = TIMEOUTS.drainWaitMs,
): Promise<{ drained: boolean; remaining: number; waitedMs: number }> {
  const started = Date.now();
  const deadline = started + timeoutMs;
  for (;;) {
    const remaining = await backendsNamed(db, appPrefix);
    if (remaining === 0) {
      return { drained: true, remaining: 0, waitedMs: Date.now() - started };
    }
    if (Date.now() > deadline) {
      return { drained: false, remaining, waitedMs: Date.now() - started };
    }
    await new Promise((resolve) => setTimeout(resolve, TIMEOUTS.drainPollMs));
  }
}

export type ClusterIdentity = {
  systemIdentifier: string;
  postmasterStartTime: string;
  serverVersion: string;
  serverVersionNum: number;
  inRecovery: boolean;
  currentDatabase: string;
};

/**
 * `system_identifier` is constant for the life of a PGDATA;
 * `pg_postmaster_start_time()` changes on every incarnation. Together they
 * distinguish "the container never died" from "same cluster, restarted" from
 * "fresh volume". Neither alone can.
 */
export async function clusterIdentity(db: Db): Promise<ClusterIdentity> {
  const { rows } = await db.pool.query<ClusterIdentity>(
    `SELECT (SELECT system_identifier::text FROM pg_control_system()) AS "systemIdentifier",
            pg_postmaster_start_time()::text                          AS "postmasterStartTime",
            version()                                                 AS "serverVersion",
            current_setting('server_version_num')::int                AS "serverVersionNum",
            pg_is_in_recovery()                                       AS "inRecovery",
            current_database()                                        AS "currentDatabase"`,
  );
  const row = rows[0];
  if (!row) throw new Error("cluster identity projection returned no row");
  return row;
}

export type RelationRow = { relation: string; kind: string };

/** The terminal schema, read from the catalog rather than inferred from callers. */
export async function relations(db: Db, schemas: string[]): Promise<RelationRow[]> {
  const { rows } = await db.pool.query<RelationRow>(
    `SELECT n.nspname || '.' || c.relname AS relation, c.relkind::text AS kind
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = ANY($1::text[])
        AND c.relkind IN ('r', 'p', 'i', 'v')
      ORDER BY 1`,
    [schemas],
  );
  return rows;
}

/**
 * Index definitions, not just names: a migration that ran with a different
 * distance metric or index type produces the same relation name in some
 * configurations, and only the definition distinguishes them.
 */
export async function indexes(
  db: Db,
  schemas: string[],
): Promise<Array<{ schema: string; table: string; name: string; definition: string }>> {
  const { rows } = await db.pool.query<{
    schema: string;
    table: string;
    name: string;
    definition: string;
  }>(
    `SELECT schemaname AS schema, tablename AS table, indexname AS name, indexdef AS definition
       FROM pg_indexes
      WHERE schemaname = ANY($1::text[])
      ORDER BY 1, 2, 3`,
    [schemas],
  );
  return rows;
}

export async function triggers(
  db: Db,
  schemas: string[],
): Promise<Array<{ schema: string; table: string; name: string }>> {
  const { rows } = await db.pool.query<{ schema: string; table: string; name: string }>(
    `SELECT n.nspname AS schema, c.relname AS table, t.tgname AS name
       FROM pg_trigger t
       JOIN pg_class c     ON c.oid = t.tgrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE NOT t.tgisinternal AND n.nspname = ANY($1::text[])
      ORDER BY 1, 2, 3`,
    [schemas],
  );
  return rows;
}

export async function routines(
  db: Db,
  schemas: string[],
): Promise<Array<{ schema: string; name: string }>> {
  const { rows } = await db.pool.query<{ schema: string; name: string }>(
    `SELECT n.nspname AS schema, p.proname AS name
       FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = ANY($1::text[])
      ORDER BY 1, 2`,
    [schemas],
  );
  return rows;
}

/** Column types, so a `vector(8)` column that a later config change did not alter is visible. */
export async function columns(
  db: Db,
  schemas: string[],
): Promise<Array<{ schema: string; table: string; column: string; type: string; nullable: boolean }>> {
  const { rows } = await db.pool.query<{
    schema: string;
    table: string;
    column: string;
    type: string;
    nullable: boolean;
  }>(
    `SELECT n.nspname AS schema, c.relname AS table, a.attname AS column,
            format_type(a.atttypid, a.atttypmod) AS type,
            NOT a.attnotnull AS nullable
       FROM pg_attribute a
       JOIN pg_class c     ON c.oid = a.attrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = ANY($1::text[])
        AND c.relkind IN ('r', 'p')
        AND a.attnum > 0 AND NOT a.attisdropped
      ORDER BY 1, 2, a.attnum`,
    [schemas],
  );
  return rows;
}

export async function extensions(db: Db): Promise<Array<{ name: string; schema: string }>> {
  const { rows } = await db.pool.query<{ name: string; schema: string }>(
    `SELECT extname AS name, extnamespace::regnamespace::text AS schema
       FROM pg_extension ORDER BY 1`,
  );
  return rows;
}
