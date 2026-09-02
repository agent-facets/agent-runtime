// Canonicalisation and the managed digest.
//
// Two rules govern this file:
//
//   * Arrays are never sorted or deduplicated here. Sorting an array during
//     comparison can hide a real difference; where order genuinely is not part
//     of the contract, the graph's own reducer normalises it instead.
//   * A value is only replaced by a marker if it is GENUINELY volatile. UUIDv6
//     checkpoint ids and content-derived task ids are; channel versions are not
//     — they are deterministic integers, and ranking them away would let a
//     version regression produce an identical digest.
//
// Object key order is normalised before hashing, so a pure reordering with
// identical contents cannot raise a false non-reproducibility alarm.

import { createHash } from "node:crypto";
import { ROOT_NS } from "./contract.ts";
import type { BlobRow, CheckpointRow, EventRow, Projection, WriteRow } from "./inspect.ts";

/** Recursively sort object keys so the hash is over content, not insertion order. */
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

function ranker(prefix: string): (value: string | null) => string | null {
  const seen = new Map<string, number>();
  return (value: string | null) => {
    if (value === null || value === undefined) return null;
    if (!seen.has(value)) seen.set(value, seen.size);
    return `<${prefix}:${seen.get(value)}>`;
  };
}

export type ChainShape = {
  checkpoints: number;
  namespaces: string[];
  sources: Record<string, number>;
  roots: number;
  forks: number;
  danglingParents: number;
  maxStep: number | null;
  stepsMonotonic: boolean;
  leaves: number;
};

/** Computed over ONE namespace at a time; concatenating namespaces would make
 *  `roots`, `leaves` and `stepsMonotonic` meaningless. */
export function chainShape(all: CheckpointRow[], namespace: string = ROOT_NS): ChainShape {
  const rows = all.filter((row) => row.checkpoint_ns === namespace);
  const byId = new Map(rows.map((row) => [row.checkpoint_id, row]));
  const childCount = new Map<string, number>();
  const sources: Record<string, number> = {};

  let roots = 0;
  let dangling = 0;

  for (const row of rows) {
    const source = row.source ?? "unknown";
    sources[source] = (sources[source] ?? 0) + 1;
    if (row.parent_checkpoint_id === null) {
      roots += 1;
    } else if (!byId.has(row.parent_checkpoint_id)) {
      dangling += 1;
    } else {
      childCount.set(
        row.parent_checkpoint_id,
        (childCount.get(row.parent_checkpoint_id) ?? 0) + 1,
      );
    }
  }

  const forks = [...childCount.values()].filter((count) => count > 1).length;
  const leaves = rows.filter((row) => !childCount.has(row.checkpoint_id)).length;
  const steps = rows.map((row) => row.step).filter((step): step is number => step !== null);
  const maxStep = steps.length > 0 ? Math.max(...steps) : null;

  let monotonic = true;
  for (let index = 1; index < steps.length; index += 1) {
    if (steps[index]! < steps[index - 1]!) monotonic = false;
  }

  return {
    checkpoints: rows.length,
    namespaces: [...new Set(all.map((row) => row.checkpoint_ns))],
    sources,
    roots,
    forks,
    danglingParents: dangling,
    maxStep,
    stepsMonotonic: monotonic,
    leaves,
  };
}

export type WriteShape = {
  rows: number;
  tasks: number;
  channels: Record<string, number>;
};

export function writeShape(rows: WriteRow[]): WriteShape {
  const channels: Record<string, number> = {};
  const tasks = new Set<string>();
  for (const row of rows) {
    channels[row.channel] = (channels[row.channel] ?? 0) + 1;
    tasks.add(`${row.checkpoint_id}:${row.task_id}`);
  }
  return { rows: rows.length, tasks: tasks.size, channels };
}

export type BlobShape = {
  rows: number;
  channels: Record<string, number>;
  types: Record<string, number>;
  /** Channel versions must never go backwards within a channel. */
  versionsMonotonicPerChannel: boolean;
};

export function blobShape(rows: BlobRow[]): BlobShape {
  const channels: Record<string, number> = {};
  const types: Record<string, number> = {};
  const lastVersion = new Map<string, number>();
  let monotonic = true;

  for (const row of rows) {
    channels[row.channel] = (channels[row.channel] ?? 0) + 1;
    const type = row.type ?? "null";
    types[type] = (types[type] ?? 0) + 1;

    const numeric = Number(row.version);
    if (Number.isFinite(numeric)) {
      const key = `${row.checkpoint_ns}:${row.channel}`;
      const previous = lastVersion.get(key);
      if (previous !== undefined && numeric < previous) monotonic = false;
      lastVersion.set(key, numeric);
    }
  }

  return { rows: rows.length, channels, types, versionsMonotonicPerChannel: monotonic };
}

/** node -> phase -> stage -> count. Stage labels are deterministic; nonces are not. */
export type ExecutionCounts = Record<string, Record<string, Record<string, number>>>;

export function executionCounts(events: EventRow[]): ExecutionCounts {
  const counts: ExecutionCounts = {};
  for (const event of events) {
    counts[event.node] ??= {};
    counts[event.node]![event.phase] ??= {};
    const byStage = counts[event.node]![event.phase]!;
    byStage[event.stage] = (byStage[event.stage] ?? 0) + 1;
  }
  return counts;
}

export function countEvents(
  events: EventRow[],
  node: string,
  phase: string,
  stage?: string,
): number {
  return events.filter(
    (event) =>
      event.node === node &&
      event.phase === phase &&
      (stage === undefined || event.stage === stage),
  ).length;
}

/** Distinct process nonces per stage — the fresh-process witness. */
export function noncesByStage(events: EventRow[]): Record<string, string[]> {
  const byStage: Record<string, Set<string>> = {};
  for (const event of events) {
    byStage[event.stage] ??= new Set();
    byStage[event.stage]!.add(event.process_nonce);
  }
  return Object.fromEntries(Object.entries(byStage).map(([stage, set]) => [stage, [...set]]));
}

export type CanonicalProjection = {
  chain: ChainShape;
  writes: WriteShape;
  blobs: BlobShape;
  executions: ExecutionCounts;
  checkpointGraph: Array<{
    ns: string;
    id: string | null;
    parent: string | null;
    source: string | null;
    step: number | null;
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
};

/**
 * A task's identity expressed as what it wrote.
 *
 * Task ids are derived from the checkpoint id, which is a fresh time-ordered
 * UUID on every run. Two parallel siblings therefore get different ids each
 * repeat, and sorting by id makes WHICH branch comes first non-deterministic.
 * That is invisible while only ranked ids are compared and becomes a false
 * reproducibility failure the moment write content is compared — which it now
 * is, because content is exactly what a regression would change.
 *
 * LangGraph makes no ordering guarantee between parallel branches in a
 * superstep, so imposing a content-derived total order here is normalising an
 * unordered set, not hiding an ordered difference.
 */
function taskSignature(rows: WriteRow[]): string {
  return stable(
    rows
      .map((row) => `${row.channel}|${row.idx}|${row.blob_len}|${writeMd5(row) ?? ""}`)
      .sort(),
  );
}

/**
 * An interrupt write's bytes contain LangGraph's own interrupt id, which is a
 * hash of the task's checkpoint namespace and therefore carries a per-run task
 * uuid. Digesting those bytes would make every repeat differ for a reason that
 * is volatile by construction.
 *
 * Nothing is hidden by suppressing it here: the interrupt payload is compared in
 * canonical form in `interruptSites` below, with the volatile id ranked and the
 * meaningful value left literal.
 */
function writeMd5(row: WriteRow): string | null {
  return row.channel === "__interrupt__" ? "<interrupt-payload>" : row.blob_md5;
}

export function canonicaliseProjection(projection: Projection): CanonicalProjection {
  const rankCheckpoint = ranker("ckpt");
  const rankTask = ranker("task");

  const checkpointGraph = projection.checkpoints.map((row) => ({
    ns: row.checkpoint_ns,
    id: rankCheckpoint(row.checkpoint_id),
    parent: rankCheckpoint(row.parent_checkpoint_id),
    source: row.source,
    step: row.step,
  }));

  // Group by (namespace, checkpoint, task), then order tasks within a
  // checkpoint by their write signature so the ranking is stable across repeats.
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

  // Versions stay literal: they are deterministic integers, and their ORDER is
  // the property a regression would break.
  const blobVersions = projection.blobs.map((row) => ({
    ns: row.checkpoint_ns,
    channel: row.channel,
    version: row.version,
    type: row.type,
    len: row.blob_len,
    md5: row.blob_md5,
  }));

  const rankInterrupt = ranker("interrupt");
  const interruptSites = projection.interrupts.map((row) => {
    let id: string | null = null;
    let value: unknown = null;
    try {
      const parsed = JSON.parse(row.payload) as { id?: string; value?: unknown };
      id = rankInterrupt(parsed.id ?? null);
      value = parsed.value ?? null;
    } catch {
      // An unparsable payload is itself a finding; keep it visible rather than
      // silently dropping the site.
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
    chain: chainShape(projection.checkpoints),
    writes: writeShape(projection.writes),
    blobs: blobShape(projection.blobs),
    executions: executionCounts(projection.events),
    checkpointGraph,
    writeAttribution,
    blobVersions,
    interruptSites,
  };
}

/**
 * Free-form text that came from outside the harness — an exception message, a
 * driver error. Prose survives; anything that could carry a path, a token, or a
 * volatile identifier does not.
 */
export function sanitizeText(text: string): string {
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
