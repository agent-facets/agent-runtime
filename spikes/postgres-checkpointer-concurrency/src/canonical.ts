// Canonicalisation and the managed digest.
//
// Three rules govern this file:
//
//   * Arrays are never sorted or deduplicated. Sorting during comparison can
//     hide a real difference, and here order IS the result in several places:
//     search result order, namespace listing pages, arrival order.
//   * A value is replaced by a token only if it is GENUINELY volatile. UUIDv6
//     checkpoint ids and per-run backend pids are; channel versions, SQLSTATEs,
//     namespace strings, Store keys and search scores are not. Ranking any of
//     those away would let a real regression produce an identical digest.
//   * Every ranked identity is accompanied by an explicit relational boolean
//     (`sameCluster`, `allRowsShareXmin`). The redundancy is the point: a
//     ranking bug and a relation bug are unlikely to agree.
//
// Ranking is SCOPED. Spike 05 used one ranker per projection; here, comparison
// ACROSS a boundary is itself a result (restart identity, fork versus resume),
// so a ranker is created per declared scope and ordinals are assigned by a
// deterministic traversal rather than by whoever won a race.

import { createHash } from "node:crypto";
import type { BlobRow, CheckpointRow, Projection, WriteRow } from "./inspect/checkpoints.ts";
import type { BarrierRecord } from "./barrier.ts";
import type { LockGraph } from "./inspect/pgstat.ts";

export function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => [key, stableValue((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

export function stable(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

export function digest(value: unknown): string {
  return createHash("sha256").update(stable(value)).digest("hex");
}

export type Ranker = (value: string | null | undefined) => string | null;

export function createRanker(prefix: string): Ranker {
  const seen = new Map<string, number>();
  return (value) => {
    if (value === null || value === undefined) return null;
    if (!seen.has(value)) seen.set(value, seen.size);
    return `<${prefix}:${seen.get(value)}>`;
  };
}

type ProjectedCheckpoint = {
  ns?: string;
  checkpoint_id?: string;
  parent_checkpoint_id?: string | null;
  source?: string | null;
  step?: number | null;
};

/**
 * Stable labels for engine-generated checkpoint ids.
 *
 * Checkpoint ids are UUIDv6 — time-ordered, so a fresh one every run — and task
 * ids are UUIDv5 values derived from them, so they change too. Digesting either
 * would report the clock as a reproducibility failure.
 *
 * The labels are assigned from the LINEAGE, not from arrival order or from the
 * ids themselves: each node is keyed by a recursive signature of its own
 * id-free content plus the sorted signatures of its children, and siblings are
 * walked in signature order. Two structurally identical subtrees therefore
 * canonicalise identically no matter which racer produced which — that is
 * order-invariance, not concealment. Everything a race actually decides survives
 * it: the number of roots, the number of leaves, where the tree forks, and which
 * parents are missing are all properties of the shape, not of the labels.
 */
export function canonicalCheckpointLabels(rows: ProjectedCheckpoint[]): Map<string, string> {
  const known = new Set(
    rows.map((row) => row.checkpoint_id).filter((id): id is string => typeof id === "string"),
  );
  const children = new Map<string, ProjectedCheckpoint[]>();
  const roots: ProjectedCheckpoint[] = [];

  for (const row of rows) {
    const parent = row.parent_checkpoint_id;
    if (typeof parent === "string" && known.has(parent)) {
      const bucket = children.get(parent);
      if (bucket) bucket.push(row);
      else children.set(parent, [row]);
    } else {
      roots.push(row);
    }
  }

  const signature = (row: ProjectedCheckpoint): string =>
    stable({
      ns: row.ns ?? "",
      source: row.source ?? null,
      step: row.step ?? null,
      // A parent that is not in the row set is a real, load-bearing difference
      // (it is what c09 measures), so it is part of the signature.
      orphaned: typeof row.parent_checkpoint_id === "string" && !known.has(row.parent_checkpoint_id),
      children: (children.get(row.checkpoint_id ?? "") ?? []).map(signature).sort(),
    });

  const labels = new Map<string, string>();
  let next = 0;
  const walk = (list: ProjectedCheckpoint[]): void => {
    const ordered = [...list].sort((left, right) => {
      const a = signature(left);
      const b = signature(right);
      return a < b ? -1 : a > b ? 1 : 0;
    });
    for (const row of ordered) {
      const id = row.checkpoint_id;
      if (typeof id !== "string") continue;
      labels.set(id, `<cp:${next}>`);
      next += 1;
      walk(children.get(id) ?? []);
    }
  };
  walk(roots);

  // Referenced-but-absent parents get labels of their own so a dangling pointer
  // stays visible and countable instead of collapsing into null.
  const missing = [
    ...new Set(
      rows
        .map((row) => row.parent_checkpoint_id)
        .filter((id): id is string => typeof id === "string" && !known.has(id)),
    ),
  ].sort();
  missing.forEach((id, index) => labels.set(id, `<cp:absent-${index}>`));

  return labels;
}

/**
 * Rewrites every engine-generated id in a projection to its canonical label,
 * including the ones embedded in composite keys like
 * `<checkpoint>/<task>/<idx>/<channel>`.
 *
 * Applied to the whole projection subtree rather than field by field, so a
 * projection that grows a new id-bearing field later cannot silently start
 * leaking volatile ids into the digest.
 */
export function canonicaliseProjection(projection: Record<string, unknown>): Record<string, unknown> {
  const thread = projection.thread as { checkpoints?: ProjectedCheckpoint[] } | undefined;
  if (!Array.isArray(thread?.checkpoints)) return projection;

  const labels = canonicalCheckpointLabels(thread.checkpoints);
  const taskRank = createRanker("task");
  // Ranked in a deterministic order derived from already-canonical values, so
  // the task labels do not inherit the volatility of the ids they replace.
  //
  // The namespace SKELETON is part of the key — the raw string with its embedded
  // ids blanked, so `left:<uuid>` becomes `left:<id>`. Without it, two parallel
  // instances of one subgraph tie on every other field (same parent checkpoint,
  // same idx, same channel, same byte count) and are then labelled by whichever
  // finished first. That label is embedded in the namespace string itself, so a
  // tie leaks into `checkpoints[].ns`, `blobs[].ns` and every reachability row —
  // which is how e03 produced a different digest on one repeat in three while
  // measuring identical behaviour.
  const UUID_ANYWHERE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
  const skeleton = (value: unknown): string =>
    typeof value === "string" ? value.replace(UUID_ANYWHERE, "<id>") : "";

  // A task's ROLE, recovered from any namespace that embeds its id.
  //
  // Two parallel instances of one compiled subgraph are indistinguishable by
  // their own write rows — same parent checkpoint, same idx, same channel, same
  // byte count — because the root-level tasks that spawn them both write under
  // the ROOT namespace. What separates them is that some other row carries the
  // namespace `left:<that id>` or `right:<that id>`. The call-site prefix is
  // stable across runs while the id is not, so it is exactly the tiebreak the
  // ranking needs. Without it the two instances are labelled by whichever
  // finished first, and that label is embedded in every namespace string
  // downstream of them.
  const roleOfTask = new Map<string, string>();
  const collectRoles = (value: unknown): void => {
    if (typeof value === "string") {
      if (value.length > 36) {
        for (const match of value.matchAll(UUID_ANYWHERE)) {
          const id = match[0];
          const upto = value.slice(0, (match.index ?? 0) + id.length);
          const role = skeleton(upto);
          const previous = roleOfTask.get(id);
          if (previous === undefined || role < previous) roleOfTask.set(id, role);
        }
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const entry of value) collectRoles(entry);
      return;
    }
    if (value !== null && typeof value === "object") {
      for (const entry of Object.values(value as Record<string, unknown>)) collectRoles(entry);
    }
  };
  collectRoles(projection);

  const writes = ((projection.thread as { writes?: Array<Record<string, unknown>> }).writes ?? [])
    .map((row) => ({
      key: stable([
        skeleton(row.ns),
        roleOfTask.get(String(row.task_id ?? "")) ?? "",
        labels.get(String(row.checkpoint_id)) ?? "",
        row.idx ?? 0,
        row.channel ?? "",
        row.bytes ?? 0,
      ]),
      taskId: String(row.task_id ?? ""),
    }))
    .sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0));
  for (const write of writes) taskRank(write.taskId);

  const rewriteToken = (token: string): string =>
    labels.get(token) ?? (/^[0-9a-f-]{36}$/i.test(token) ? (taskRank(token) ?? token) : token);

  // A subgraph namespace EMBEDS the task id of the node that spawned it — the
  // pinned release builds it as `<node>:<task id>`, nested with a separator —
  // so it is exactly as volatile as the id inside it, and a projection carrying
  // one would change every run for no behavioural reason.
  //
  // Rewriting the embedded id rather than the whole string keeps the part that
  // is a result: which node the namespace belongs to, how deeply it nests, and
  // whether two namespaces share an ancestor all survive, while the uuid becomes
  // the same `<task:N>` label it carries everywhere else. Nothing here parses
  // the vendor's separators, so a release that changed them would still
  // canonicalise — and would still show up as a changed digest, which is
  // correct.
  const EMBEDS_UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
  const EVERY_UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

  const rewrite = (value: unknown): unknown => {
    if (typeof value === "string") {
      if (labels.has(value)) return labels.get(value);
      if (value.includes("/")) return value.split("/").map(rewriteToken).join("/");
      // Bare-token handling first, unchanged: a projection with no subgraphs
      // canonicalises byte-identically to how it did before namespaces existed.
      if (/^[0-9a-f-]{36}$/i.test(value)) return rewriteToken(value);
      // A string that CONTAINS an id — a subgraph namespace — has its ids blanked
      // to a constant rather than replaced with task labels.
      //
      // Labels would be the more informative choice and were the original one,
      // but they are assigned by write order, and two parallel instances of one
      // compiled subgraph tie on every field their own rows carry. The label
      // then differs between repeats and, because it is embedded in the
      // namespace, drags `checkpoints[].ns`, `blobs[].ns` and every reachability
      // row along with it — a different digest for identical behaviour.
      //
      // The skeleton keeps everything that is a result: which call site the
      // namespace belongs to (`left:` vs `right:`), how deeply it nests, and
      // whether two namespaces share an ancestor. The task each one belongs to is
      // not lost either — the effect records carry `task` as its own field.
      if (EMBEDS_UUID.test(value)) return value.replace(EVERY_UUID, "<id>");
      return rewriteToken(value);
    }
    if (Array.isArray(value)) return value.map(rewrite);
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([key, inner]) => [key, rewrite(inner)]),
      );
    }
    return value;
  };

  return rewrite(projection) as Record<string, unknown>;
}

export type ChainShape = {
  checkpoints: number;
  sources: Record<string, number>;
  roots: number;
  forks: number;
  danglingParents: number;
  leaves: number;
  maxStep: number | null;
  stepsMonotonic: boolean;
};

/** One namespace at a time: concatenating namespaces makes roots and leaves meaningless. */
export function chainShape(all: CheckpointRow[], namespace: string): ChainShape {
  const rows = all.filter((row) => row.checkpoint_ns === namespace);
  const byId = new Map(rows.map((row) => [row.checkpoint_id, row]));
  const childCount = new Map<string, number>();
  const sources: Record<string, number> = {};

  let roots = 0;
  let dangling = 0;

  for (const row of rows) {
    const source = row.source ?? "unknown";
    sources[source] = (sources[source] ?? 0) + 1;
    if (row.parent_checkpoint_id === null) roots += 1;
    else if (!byId.has(row.parent_checkpoint_id)) dangling += 1;
    else {
      childCount.set(row.parent_checkpoint_id, (childCount.get(row.parent_checkpoint_id) ?? 0) + 1);
    }
  }

  const steps = rows.map((row) => row.step).filter((step): step is number => step !== null);
  let monotonic = true;
  for (let index = 1; index < steps.length; index += 1) {
    if (steps[index]! < steps[index - 1]!) monotonic = false;
  }

  return {
    checkpoints: rows.length,
    sources,
    roots,
    forks: [...childCount.values()].filter((count) => count > 1).length,
    danglingParents: dangling,
    leaves: rows.filter((row) => !childCount.has(row.checkpoint_id)).length,
    maxStep: steps.length > 0 ? Math.max(...steps) : null,
    stepsMonotonic: monotonic,
  };
}

/**
 * A task's identity expressed as what it wrote.
 *
 * Task ids derive from the checkpoint id, which is a fresh time-ordered UUID
 * every run, so two parallel siblings get different ids each repeat and sorting
 * by id makes WHICH branch comes first non-deterministic. LangGraph makes no
 * ordering guarantee between parallel branches in a superstep, so a
 * content-derived total order normalises an unordered set rather than hiding an
 * ordered difference.
 */
function taskSignature(rows: WriteRow[]): string {
  return stable(
    rows.map((row) => `${row.channel}|${row.idx}|${row.blob_len}|${writeMd5(row) ?? ""}`).sort(),
  );
}

/**
 * An interrupt write's bytes embed LangGraph's own interrupt id, which hashes
 * the task's checkpoint namespace and therefore carries a per-run uuid.
 * Digesting those bytes would make every repeat differ for a reason that is
 * volatile by construction. Nothing is hidden: the payload is compared in
 * canonical form in `interruptSites`, with the volatile id ranked and the
 * meaningful value left literal.
 */
function writeMd5(row: WriteRow): string | null {
  return row.channel === "__interrupt__" ? "<interrupt-payload>" : row.blob_md5;
}

export type CanonicalCheckpoints = {
  namespaces: string[];
  chains: Record<string, ChainShape>;
  graph: Array<{
    ns: string;
    id: string | null;
    parent: string | null;
    source: string | null;
    step: number | null;
    parentNamespaces: string[];
  }>;
  writeAttribution: Array<{
    ns: string;
    checkpoint: string | null;
    task: string | null;
    idx: number;
    channel: string;
    len: number;
    md5: string | null;
  }>;
  blobVersions: Array<{
    ns: string;
    channel: string;
    version: string;
    type: string | null;
    len: number;
    md5: string | null;
  }>;
  interruptSites: Array<{
    ns: string;
    checkpoint: string | null;
    task: string | null;
    id: string | null;
    value: unknown;
  }>;
  migrationLedger: number[];
  /** Every checkpoint row written by one transaction shares an xmin. */
  distinctXmin: number;
};

export function canonicaliseCheckpoints(projection: Projection): CanonicalCheckpoints {
  const rankCheckpoint = createRanker("ckpt");
  const rankTask = createRanker("task");
  const rankInterrupt = createRanker("interrupt");

  const namespaces = [...new Set(projection.checkpoints.map((row) => row.checkpoint_ns))].sort();

  const graph = projection.checkpoints.map((row) => ({
    ns: row.checkpoint_ns,
    id: rankCheckpoint(row.checkpoint_id),
    parent: rankCheckpoint(row.parent_checkpoint_id),
    source: row.source,
    step: row.step,
    // Namespace KEYS only. The plan forbids depending on the vendor's namespace
    // string format, so the cross-namespace edge is recorded as "which
    // namespaces this checkpoint has parents in", not as a parsed path.
    parentNamespaces: row.parents ? Object.keys(row.parents).sort() : [],
  }));

  const groups = new Map<string, WriteRow[]>();
  for (const row of projection.writes) {
    const key = `${row.checkpoint_ns}\u0000${row.checkpoint_id}\u0000${row.task_id}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(row);
  }

  const orderedTasks = [...groups.entries()]
    .map(([key, rows]) => {
      const [ns, checkpointId, taskId] = key.split("\u0000") as [string, string, string];
      return { ns, checkpointId, taskId, rows, signature: taskSignature(rows) };
    })
    .sort((left, right) => {
      if (left.ns !== right.ns) return left.ns < right.ns ? -1 : 1;
      if (left.checkpointId !== right.checkpointId) {
        return left.checkpointId < right.checkpointId ? -1 : 1;
      }
      return left.signature < right.signature ? -1 : left.signature > right.signature ? 1 : 0;
    });

  const writeAttribution = orderedTasks.flatMap((task) =>
    task.rows
      .slice()
      .sort((left, right) => left.idx - right.idx)
      .map((row) => ({
        ns: row.checkpoint_ns,
        checkpoint: rankCheckpoint(row.checkpoint_id),
        task: rankTask(row.task_id),
        idx: row.idx,
        channel: row.channel,
        len: row.blob_len,
        md5: writeMd5(row),
      })),
  );

  // Versions stay literal: they are deterministic integers and their ORDER is
  // exactly what a regression would break.
  const blobVersions: CanonicalCheckpoints["blobVersions"] = projection.blobs.map(
    (row: BlobRow) => ({
      ns: row.checkpoint_ns,
      channel: row.channel,
      version: row.version,
      type: row.type,
      len: row.blob_len,
      md5: row.blob_md5,
    }),
  );

  const interruptSites = projection.interrupts.map((row) => {
    let id: string | null = null;
    let value: unknown = null;
    try {
      const parsed = JSON.parse(row.payload) as { id?: string; value?: unknown };
      id = rankInterrupt(parsed.id ?? null);
      value = parsed.value ?? null;
    } catch {
      value = "<unparsable>";
    }
    return {
      ns: row.checkpoint_ns,
      checkpoint: rankCheckpoint(row.checkpoint_id),
      task: rankTask(row.task_id),
      id,
      value,
    };
  });

  return {
    namespaces,
    chains: Object.fromEntries(
      namespaces.map((ns) => [ns, chainShape(projection.checkpoints, ns)]),
    ),
    graph,
    writeAttribution,
    blobVersions,
    interruptSites,
    migrationLedger: projection.migrations.map((row) => row.v),
    distinctXmin: new Set(projection.checkpoints.map((row) => row.xmin)).size,
  };
}

export type CanonicalBarrier = Omit<BarrierRecord, "arrivals" | "releasedAt"> & {
  arrivals: Array<{ party: number; role: string; backend: string | null; nonce: string | null }>;
};

/**
 * Arrival ORDER is retained verbatim in `arrivalOrderParties` and excluded from
 * the digest: deleting it would hide serialisation, digesting it would destroy
 * reproducibility. Backends and nonces are ranked in party order, which is
 * assigned by the driver before the race and is therefore managed.
 */
export function canonicaliseBarrier(record: BarrierRecord): CanonicalBarrier {
  const rankBackend = createRanker("backend");
  const rankNonce = createRanker("nonce");
  const byParty = [...record.arrivals].sort((left, right) => left.party - right.party);
  return {
    name: record.name,
    partiesExpected: record.partiesExpected,
    partiesArrived: record.partiesArrived,
    allArrivedBeforeRelease: record.allArrivedBeforeRelease,
    distinctBackends: record.distinctBackends,
    distinctNonces: record.distinctNonces,
    peakConcurrentParties: record.peakConcurrentParties,
    arrivalOrderParties: record.arrivalOrderParties,
    arrivals: byParty.map((arrival) => ({
      party: arrival.party,
      role: arrival.role,
      backend: rankBackend(String(arrival.backend_pid)),
      nonce: rankNonce(arrival.process_nonce),
    })),
  };
}

export type CanonicalLockGraph = {
  edgeCount: number;
  selfEdges: number;
  unattributedBackends: number;
  oraclesAgree: boolean;
  edges: Array<{
    blockedRole: string;
    blockingRole: string;
    locktype: string;
    mode: string;
    relation: string | null;
  }>;
};

/**
 * Edges are keyed by application_name (role), never by pid: pids are volatile
 * and `pg_locks` returns rows in no defined order, so a pid-keyed sort would be
 * non-deterministic across repeats.
 */
export function canonicaliseLockGraph(graph: LockGraph): CanonicalLockGraph {
  const role = (app: string): string => app.split(":").slice(1).join(":") || app || "<unknown>";
  const edges = graph.edges
    .map((edge) => ({
      blockedRole: role(edge.blockedApp),
      blockingRole: role(edge.blockingApp),
      locktype: edge.locktype,
      mode: edge.mode,
      relation: edge.relation,
    }))
    .sort((left, right) =>
      stable(left) < stable(right) ? -1 : stable(left) > stable(right) ? 1 : 0,
    );
  return {
    edgeCount: graph.edgeCount,
    selfEdges: graph.selfEdges,
    unattributedBackends: graph.unattributedBackends,
    oraclesAgree: graph.oraclesAgree,
    edges,
  };
}

/**
 * Free-form text that came from outside the harness: an exception message, a
 * driver error, a database log line. Prose survives; anything that could carry a
 * path, a token, or a volatile identifier does not.
 *
 * The UUID rule makes this UNSAFE for structured fields — it would silently eat
 * checkpoint ids, task ids and system identifiers. It is called from exactly two
 * places: error messages and captured log excerpts.
 */
export function sanitizeProse(text: string): string {
  return text
    .replace(/postgres(?:ql)?:\/\/[^\s"']+/gi, "<dsn>")
    .replace(/eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g, "<jwt>")
    .replace(/Bearer\s+\S+/gi, "Bearer <redacted>")
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, "<key>")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<uuid>")
    .replace(/\/var\/lib\/docker\/[^\s"']*/g, "/var/lib/docker/<redacted>")
    .replace(/\/(?:home|Users)\/[^\s"']+/g, "/home/<redacted>")
    .replace(/\/tmp\/[^\s"']+/g, "/tmp/<redacted>");
}
