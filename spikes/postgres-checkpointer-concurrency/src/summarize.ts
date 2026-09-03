// Acceptance, managed state, and the per-lane digests.
//
// Computed by the pinned image from the collected case bundles, so the claims
// and the code that makes them stay on the same version. Two rules are enforced
// structurally rather than criterion by criterion:
//
//   * A declared oracle that is absent from a bundle is a FAULT, not a pass.
//     `[].every(...)` is `true` and `undefined !== false`, so "never measured"
//     would otherwise read as "measured clean".
//   * The overall digest is a digest OVER the per-lane digests, not over the
//     concatenated managed arrays. One unstable lane must not contaminate the
//     bytes a citable lane's claim rests on.

import {
  canonicaliseBarrier,
  canonicaliseLockGraph,
  canonicaliseProjection,
  createRanker,
  nsSkeleton,
  digest,
  stable,
} from "./canonical.ts";
import { CONFLICT_FIXTURE } from "./contract.ts";
import type { BarrierRecord } from "./barrier.ts";
import type { LockGraph } from "./inspect/pgstat.ts";
import { CASES, caseById, type CaseDef, type OracleId } from "./cases.ts";
import { isMitigation, type LaneId } from "./lanes.ts";
import { outcomeFor, type Outcome } from "./evidence.ts";

export type WorkerBundle = {
  party: number;
  container: string;
  exitCode: number;
  posture: Record<string, unknown> | null;
  output: { result?: Record<string, unknown>; outcome?: Outcome } | null;
};

export type CaseBundle = {
  case: string;
  family: string;
  lane: LaneId;
  coordination: {
    barriers?: BarrierRecord[];
    lockGraphs?: Array<{ stage: string; graph: LockGraph }>;
    activity?: Array<{ stage: string; rows: Array<Record<string, unknown>> }>;
    finalLockGraph?: LockGraph;
  } | null;
  workers: WorkerBundle[];
  provision?: Record<string, unknown> | null;
  projection?: Record<string, unknown> | null;
  prepare?: Record<string, unknown> | null;
  drain?: { drained?: boolean; remaining?: number; waitedMs?: number } | null;
  kill?: { party: number; signal: string; waitExit: number; oomKilled: boolean } | null;
  /** The database-stack action the driver performed between two parties. */
  restart?: {
    action?: string;
    sameContainer?: boolean;
    sameImage?: boolean;
    pinnedImage?: boolean;
    sameVolume?: boolean;
    log?: {
      newLines?: number;
      notCleanShutdown?: number;
      automaticRecovery?: number;
      redoStarts?: number;
      readyForConnections?: number;
      shutdownComplete?: number;
    };
  } | null;
};

type Findings = Record<string, unknown>;

const CONFLICT_TASK_ID = CONFLICT_FIXTURE.taskId;

/**
 * All four accessors tolerate an ABSENT bundle and return an empty set.
 *
 * Every criteria block is invoked whenever its lane is present, but a scoped run
 * (`--family D`) legitimately contains no case from another family. Reaching
 * into `bundle.workers` on a case that did not run crashed the whole summarize
 * step and reported it as a harness fault — a run-selection bug masquerading as
 * a measurement failure. Returning nothing is correct: the criteria below are
 * all guarded on their inputs, so an absent case contributes no criteria rather
 * than a false one.
 */
function resultsOf(bundle: CaseBundle | undefined): Findings[] {
  return (bundle?.workers ?? [])
    .map((worker) => worker.output?.result)
    .filter((result): result is Findings => Boolean(result));
}

/**
 * A killed party cannot report anything, by construction. Excluding it is what
 * keeps "every worker reported JSON" meaningful for the cases where silence
 * really is a fault.
 */
function liveResults(bundle: CaseBundle | undefined): Findings[] {
  const killed = bundle?.kill?.party;
  return (bundle?.workers ?? [])
    .filter((worker) => worker.party !== killed)
    .map((worker) => worker.output?.result)
    .filter((result): result is Findings => Boolean(result));
}

function firstResult(bundle: CaseBundle | undefined): Findings | null {
  return resultsOf(bundle)[0] ?? null;
}

function sqlstatesOf(bundle: CaseBundle | undefined): Array<string | null> {
  return liveResults(bundle).map(
    (result) => (result.error as { code?: string } | null)?.code ?? null,
  );
}

/**
 * Oracle presence. Declared in `cases.ts`, verified here. A case whose declared
 * oracle produced nothing did not measure what it claimed to measure.
 */
const ORACLE_PRESENT: Record<OracleId, (bundle: CaseBundle) => boolean> = {
  pins: (bundle) => Array.isArray(firstResult(bundle)?.pins),
  relations: (bundle) => Array.isArray(firstResult(bundle)?.relations),
  egress: (bundle) => typeof firstResult(bundle)?.egress === "object",
  posture: (bundle) => bundle.workers.every((worker) => worker.posture !== null),
  barrier: (bundle) => (bundle.coordination?.barriers?.length ?? 0) > 0,
  activity: (bundle) => (bundle.coordination?.activity?.length ?? 0) > 0,
  statements: (bundle) =>
    liveResults(bundle).length > 0 &&
    liveResults(bundle).every(
      (result) =>
        typeof result.statements === "object" || typeof result.ungatedMultiset === "object",
    ),
  lockEdge: (bundle) => (bundle.coordination?.lockGraphs?.length ?? 0) > 0,
  // Two shapes count as "the frozen fixture was the oracle here": s06 computes
  // the orderings independently from the vectors, and the ranking cases carry
  // the hand-authored expected order they were scored against. Both prove the
  // fixture was consulted; neither is satisfied by a case that merely used the
  // embedder to write something.
  embeddings: (bundle) =>
    typeof firstResult(bundle)?.computedOrder === "object" ||
    Array.isArray(firstResult(bundle)?.expectedOrder),
  clusterIdentity: (bundle) => typeof bundle.provision?.cluster === "object",
  drain: (bundle) => typeof bundle.drain?.drained === "boolean",
  projection: (bundle) => Array.isArray(bundle.projection?.relations),
  ledger: (bundle) =>
    Array.isArray(bundle.projection?.checkpointLedger) &&
    Array.isArray(bundle.projection?.storeLedger),
  // Present, not merely truthy: `error: null` is the interesting value here, so
  // an absent key and a successful call must not be the same thing.
  sqlstate: (bundle) =>
    liveResults(bundle).length > 0 && liveResults(bundle).every((result) => "error" in result),
  advisoryLock: (bundle) =>
    liveResults(bundle).length > 0 &&
    liveResults(bundle).every((result) => typeof result.unlockReturnedTrue === "boolean"),
  // Non-empty, not merely present: a thread with no checkpoint rows means the
  // fixture never committed, and every lineage criterion below it would then be
  // asserting over an empty array.
  lineage: (bundle) => (threadOf(bundle)?.checkpoints?.length ?? 0) > 0,
  executions: (bundle) => (executionsOf(bundle).length ?? 0) > 0,
  conflict: (bundle) => Array.isArray(conflictOf(bundle)?.blobs),
  // A killed victim reports nothing by construction, so the surviving party's
  // independent row count is the oracle for a kill case — not the victim's own
  // statement log, which dies with it.
  survivors: (bundle) =>
    liveResults(bundle).some((result) => typeof result.survivingRows === "object"),
  reachability: (bundle) =>
    Array.isArray(
      (bundle.projection?.reachability as { strandedReferences?: unknown[] } | undefined)
        ?.strandedReferences,
    ),
  storeProjection: (bundle) => Array.isArray(storeOf(bundle)?.items),
  storeConflict: (bundle) => typeof storeConflictOf(bundle)?.itemRows === "number",
  // BOTH sides, non-empty on the config side. One alone proves nothing: a case
  // with no recorded effects would make every equality criterion below it vacuous,
  // and a case with no write rows could not have its components reconstructed.
  effectKey: (bundle) =>
    effectsOf(bundle).length > 0 && Array.isArray(bundle.projection?.effectSites),
  // The verdict is the oracle, and it exists whether the guard was enabled or
  // not — the stock lane computes the same comparison and then ignores it, which
  // is what makes "the manifest said no and the engine proceeded" measurable.
  compatibility: (bundle) => typeof verdictOf(bundle)?.code === "string",
  // Present on every party, including the one that was refused: "no worker took
  // the lease" and "the lease was never attempted" must not look alike.
  threadLease: (bundle) =>
    liveResults(bundle).length > 0 &&
    liveResults(bundle).every((result) => typeof result.leaseAcquired === "boolean"),
  storeGuard: (bundle) =>
    typeof (firstResult(bundle)?.verdict as { allowed?: boolean } | undefined)?.allowed ===
    "boolean",
  // Present AND non-trivial: a fixture with no ids to tokenise would make every
  // injectivity claim below it vacuously true.
  canonical: (bundle) =>
    typeof firstResult(bundle)?.checkpointLabelsInjective === "boolean" &&
    Number(firstResult(bundle)?.distinctCheckpointIds ?? 0) > 1,
};

export type CompatibilityVerdict = {
  compatible: boolean;
  code: string;
  reasons: Array<{ kind: string; subject: string }>;
};

function verdictOf(bundle: CaseBundle | undefined): CompatibilityVerdict | undefined {
  return firstResult(bundle)?.verdict as CompatibilityVerdict | undefined;
}

function hasReason(
  verdict: CompatibilityVerdict | undefined,
  kind: string,
  subject: string,
): boolean {
  return (verdict?.reasons ?? []).some(
    (reason) => reason.kind === kind && reason.subject === subject,
  );
}

type StoreProjectionShape = {
  items?: Array<{
    namespace_path: string;
    key: string;
    value_text: string;
    value_digest: string;
    expires_at: string | null;
    expired: boolean;
    bytes: number;
  }>;
  vectors?: Array<{
    namespace_path: string;
    key: string;
    field_path: string;
    text_content: string;
    dims: number;
  }>;
  migrations?: number[];
  unindexedItems?: Array<{ namespace_path: string; key: string }>;
  staleVectors?: Array<{ namespace_path: string; key: string; field_path: string }>;
  stats?: { total: number; live: number; expired: number; namespaces: number };
};

type StoreConflictShape = {
  itemRows?: number;
  itemOwner?: string;
  vectorRows?: number;
  vectorOwners?: string[];
  itemOwnerEqualsVectorOwner?: boolean | null;
  orphanVectors?: number;
};

function storeOf(bundle: CaseBundle): StoreProjectionShape | undefined {
  return bundle.projection?.store as StoreProjectionShape | undefined;
}

function storeConflictOf(bundle: CaseBundle): StoreConflictShape | undefined {
  return bundle.projection?.storeConflict as StoreConflictShape | undefined;
}

/**
 * The digest-safe form of a Store projection.
 *
 * `created_at` and `updated_at` are wall-clock server timestamps written by the
 * vendor's own DEFAULT and trigger, so they change every run by construction and
 * must never reach the digest. `expires_at` goes the same way; what survives is
 * whether a TTL was set at all and whether it had elapsed at projection time,
 * which is the property the criteria actually turn on.
 *
 * The stored VALUE text stays literal on purpose. Every value in this family is
 * a harness constant, and the serialization case is settled by comparing it to a
 * hand-authored expectation — ranking it away would delete the result.
 */
function managedStoreProjection(store: StoreProjectionShape): Record<string, unknown> {
  return {
    items: (store.items ?? []).map((row) => ({
      ns: row.namespace_path,
      key: row.key,
      value: row.value_text,
      digest: row.value_digest,
      bytes: row.bytes,
      hasTtl: row.expires_at !== null,
      expired: row.expired,
    })),
    vectors: (store.vectors ?? []).map((row) => ({
      ns: row.namespace_path,
      key: row.key,
      field: row.field_path,
      text: row.text_content,
      dims: row.dims,
    })),
    migrations: store.migrations ?? [],
    unindexedItems: store.unindexedItems ?? [],
    staleVectors: store.staleVectors ?? [],
    stats: store.stats ?? null,
  };
}

type ThreadProjection = {
  checkpoints?: Array<Record<string, unknown>>;
  leaves?: Array<{ ns: string; leaves: string[] }>;
  writes?: Array<Record<string, unknown>>;
  taskIds?: string[];
  interruptRows?: number;
  /** A COUNT, never the ids — see `cmdProject`. */
  distinctTaskIds?: number;
  namespaces?: string[];
};

/**
 * The structural form of a conflict outcome.
 *
 * WHICH writer won a symmetric race is an interleaving outcome, so it is
 * retained verbatim in `findings` and never digested. What IS stable — and what
 * the architecture actually turns on — survives here: that exactly one writer
 * owns each row, that nothing decoded to a value neither writer wrote, and
 * whether the surviving checkpoint row and the surviving bytes came from the
 * SAME writer. That last flag is the b06 finding, and it is invariant: the row
 * is last-writer-wins while the bytes are first-writer-wins, so a genuine
 * collision always splits them regardless of who got there first.
 */
function managedConflictWitness(witness: ConflictProjection): Record<string, unknown> {
  const rowOwners = [...new Set((witness.checkpoints ?? []).map((row) => row.writer))];
  const byteOwners = [...new Set((witness.blobs ?? []).map((row) => row.owner))];
  const writeOwners = [...new Set((witness.writes ?? []).map((row) => row.owner))];
  return {
    checkpointRows: (witness.checkpoints ?? []).length,
    distinctRowOwners: rowOwners.length,
    blobRows: (witness.blobs ?? []).length,
    distinctBlobOwners: byteOwners.length,
    writeRows: (witness.writes ?? []).length,
    distinctWriteOwners: writeOwners.length,
    unattributableRows:
      byteOwners.filter((owner) => owner === "unknown").length +
      writeOwners.filter((owner) => owner === "unknown").length,
    rowOwnerEqualsByteOwner:
      rowOwners.length === 1 && byteOwners.length === 1 && rowOwners[0] !== null
        ? rowOwners[0] === byteOwners[0]
        : null,
  };
}

type ConflictProjection = {
  checkpoints?: Array<{ checkpoint_id: string; writer: string | null }>;
  blobs?: Array<{ key: string; owner: string; bytes: number }>;
  writes?: Array<{ key: string; owner: string; bytes: number }>;
};

export type EffectEvent = {
  party: number;
  node: string;
  processNonce: string;
  key: string | null;
  run: string | null;
  ns: string | null;
  taskNamespace: string | null;
  parentCheckpoint: string | null;
  task: string | null;
  ordinal: number | null;
  tool: string | null;
  canonicalArgs: string | null;
  configCheckpointId: string | null;
  configHasCheckpointIdKey: boolean | null;
  checkpointMapKeys: string[];
  taskIdFromPrivateKey: boolean | null;
  keyWithoutTask: string | null;
  keyWithoutOrdinal: string | null;
  keyWithoutNs: string | null;
  keyWithoutParent: string | null;
};

type EffectSite = {
  ns: string;
  parentCheckpoint: string;
  task: string;
  idx: number;
  channel: string;
};

function effectsOf(bundle: CaseBundle | undefined): EffectEvent[] {
  return (bundle?.projection?.effects as EffectEvent[] | undefined) ?? [];
}

function effectSitesOf(bundle: CaseBundle | undefined): EffectSite[] {
  return (bundle?.projection?.effectSites as EffectSite[] | undefined) ?? [];
}

function effectsAt(bundle: CaseBundle | undefined, node: string, party?: number): EffectEvent[] {
  return effectsOf(bundle).filter(
    (effect) => effect.node === node && (party === undefined || effect.party === party),
  );
}

function distinct<T>(values: Array<T | null | undefined>): T[] {
  return [...new Set(values.filter((value): value is T => value !== null && value !== undefined))];
}

/** A recorded effect is reconstructible when a write row carries the same triple. */
function reconstructible(sites: EffectSite[], effect: EffectEvent): boolean {
  return sites.some(
    (site) =>
      site.ns === effect.ns &&
      site.parentCheckpoint === effect.parentCheckpoint &&
      site.task === effect.task,
  );
}

/**
 * The digest-safe form of the recorded effects.
 *
 * An effect key is a SHA-256 over a checkpoint id and a task id, both of which
 * are fresh every run, so the hashes themselves are as volatile as a timestamp.
 * What every criterion actually asks is an EQUALITY question — did the crash
 * resume compute the same key, did the fork compute a different one, does
 * dropping `task` collapse three keys into one — and a ranker preserves exactly
 * that while dropping the volatile bytes.
 *
 * One ranker across all five key fields, not one per field: a `keyWithoutTask`
 * can never coincide with a full `key` (they hash different arities), so sharing
 * the ranker costs no precision and makes any accidental collision visible as a
 * repeated label rather than hidden behind separate numbering.
 *
 * Labels are assigned in a CONTENT order — node, then ordinal, then party — and
 * never in array order. Three siblings in one superstep write their probe rows in
 * whatever order they finish, so array order is a scheduling artifact and
 * ranking by it would make the digest unstable for a reason that is not a
 * result.
 */
function managedEffects(effects: EffectEvent[]): Array<Record<string, unknown>> {
  const ordered = [...effects].sort((left, right) => {
    if (left.node !== right.node) return left.node < right.node ? -1 : 1;
    if ((left.ordinal ?? 0) !== (right.ordinal ?? 0)) {
      return (left.ordinal ?? 0) - (right.ordinal ?? 0);
    }
    return left.party - right.party;
  });

  const rank = createRanker("effectkey");
  // Task labels are re-derived here rather than inherited from the projection.
  // `canonicaliseProjection` assigns them by write order, which for parallel
  // siblings is a scheduling artifact; this order is (node, ordinal, party),
  // which is a property of the graph.
  const rankTask = createRanker("etask");
  const relabel = (value: string | null): string | null =>
    value === null ? null : value.replace(/<task:\d+>/g, (id) => rankTask(id) ?? id);
  for (const effect of ordered) rankTask(effect.task);
  return ordered.map((effect) => ({
    node: effect.node,
    party: effect.party,
    ordinal: effect.ordinal,
    tool: effect.tool,
    canonicalArgs: effect.canonicalArgs,
    // Already canonicalised by `canonicaliseProjection`: the namespaces have had
    // their embedded task ids relabelled and `parentCheckpoint` / `task` carry
    // lineage labels rather than uuids.
    ns: relabel(effect.ns),
    taskNamespace: relabel(effect.taskNamespace),
    parentCheckpoint: effect.parentCheckpoint,
    task: relabel(effect.task),
    configCheckpointId: effect.configCheckpointId,
    configHasCheckpointIdKey: effect.configHasCheckpointIdKey,
    checkpointMapKeys: effect.checkpointMapKeys,
    taskIdFromPrivateKey: effect.taskIdFromPrivateKey,
    key: rank(effect.key),
    keyWithoutTask: rank(effect.keyWithoutTask),
    keyWithoutOrdinal: rank(effect.keyWithoutOrdinal),
    keyWithoutNs: rank(effect.keyWithoutNs),
    keyWithoutParent: rank(effect.keyWithoutParent),
  }));
}

function threadOf(bundle: CaseBundle): ThreadProjection | undefined {
  return bundle.projection?.thread as ThreadProjection | undefined;
}

function conflictOf(bundle: CaseBundle): ConflictProjection | undefined {
  return bundle.projection?.conflictWitness as ConflictProjection | undefined;
}

function executionsOf(
  bundle: CaseBundle,
): Array<{ node: string; phase: string; executions: number; parties: number; processes: number }> {
  return (bundle.projection?.executions as
    | Array<{ node: string; phase: string; executions: number; parties: number; processes: number }>
    | undefined) ?? [];
}

function executionOf(
  bundle: CaseBundle,
  node: string,
  phase: string,
): { executions: number; parties: number; processes: number } {
  const row = executionsOf(bundle).find((entry) => entry.node === node && entry.phase === phase);
  return row ?? { executions: 0, parties: 0, processes: 0 };
}

function managedActivity(bundle: CaseBundle): Array<Record<string, unknown>> {
  return (bundle.coordination?.activity ?? []).map((sample) => {
    const members = new Set(
      sample.rows.map((row) => String(row.application_name ?? "").split("#")[0] ?? ""),
    );
    // Only the distinct-member count is managed. Pids and xids are volatile, and
    // so is a backend's `state` at the instant of sampling — a party parked at a
    // barrier may be `idle` or `active` depending on where its poll loop was.
    return { stage: sample.stage, distinctMembers: members.size };
  });
}

function sqlstateMultiset(bundle: CaseBundle): Record<string, number> {
  return sqlstatesOf(bundle).reduce<Record<string, number>>((counts, code) => {
    const key = code ?? "none";
    counts[key] = (counts[key] ?? 0) + 1;
    return counts;
  }, {});
}

/**
 * What enters the digest.
 *
 * A `bounded-trials` case contributes only its structural facts: which parties
 * ran, whether they overlapped, and what the terminal schema became. Its
 * participant results and SQLSTATE profile are a genuine race outcome — the same
 * four racers can lose the CREATE TABLE race or the ledger race depending on
 * interleaving — so digesting them would report a real, expected variation as a
 * reproducibility failure. They are retained verbatim in `findings` instead,
 * which is where they can be read across repeats as an observed outcome set.
 */
function managedCase(bundle: CaseBundle, definition: CaseDef): Record<string, unknown> {
  const volatileOutcome = definition.classification === "bounded-trials";
  return {
    case: bundle.case,
    family: bundle.family,
    lane: bundle.lane,
    kind: definition.kind,
    classification: definition.classification,
    parties: definition.parties,
    workerExitCodes: bundle.workers.map((worker) => worker.exitCode),
    barriers: (bundle.coordination?.barriers ?? []).map(canonicaliseBarrier),
    lockGraphs: (bundle.coordination?.lockGraphs ?? []).map((entry) => ({
      stage: entry.stage,
      graph: canonicaliseLockGraph(entry.graph),
    })),
    activity: managedActivity(bundle),
    results: volatileOutcome
      ? "<race outcome: see findings>"
      : managedResults(resultsOf(bundle)),
    sqlstateMultiset: volatileOutcome ? "<race outcome: see findings>" : sqlstateMultiset(bundle),
    // Engine-generated checkpoint and task ids are replaced with labels derived
    // from the lineage shape. They are as volatile as a timestamp — UUIDv6 is
    // one — and digesting them would report the clock as irreproducibility.
    projection: managedProjection(bundle, definition),
    prepare: bundle.prepare ?? null,
    // `waitedMs` is how long the backend took to disappear, which is a property
    // of TCP teardown on the day. The claim is that it drained and that nothing
    // remained; the duration stays in findings.
    drain: bundle.drain
      ? { drained: bundle.drain.drained ?? null, remaining: bundle.drain.remaining ?? null }
      : null,
    kill: bundle.kill ?? null,
  };
}

/**
 * Keys that are volatile wherever they appear in a participant result.
 *
 * Server timestamps are absolute; `observedContention` and `party` record WHICH
 * symmetric racer went first, which is an interleaving outcome rather than a
 * behaviour. All of them stay in `findings`; none may reach the digest.
 */
const VOLATILE_RESULT_KEYS = new Set([
  "party",
  "acquiredAt",
  "releasedAt",
  "observedContention",
  "waitedMs",
  // How many times a poll loop got round before the writer finished, and which
  // intermediate states it happened to catch. Both are properties of scheduling
  // on the day. The criteria that depend on them read the raw results, not the
  // digested copy, so stripping them here costs nothing.
  "samples",
  "observedCounts",
  "distinctCheckpointCounts",
  // Absolute server timestamps from the TTL cases. What the criteria turn on is
  // the DIRECTION of the change — that a read moved the expiry earlier — and
  // that is computed in the participant and digested as a boolean. The instants
  // themselves are the wall clock and stay in `findings`.
  "expiryBefore",
  "expiryAfter",
  // The cluster's own identity. `system_identifier` is minted by initdb, and
  // every repeat initdbs a fresh volume, so it is as volatile as a uuid;
  // `postmaster_start_time` is the wall clock. What family G actually asserts is
  // the RELATION between two photographs — same identifier or different, later
  // start time or not — and every one of those is computed as a boolean in the
  // criteria from the raw results.
  "cluster",
  // How many POOLED sockets happened to be open when the server was destroyed.
  // A property of connection scheduling, not of the failure: g03 saw 4 in one
  // repeat and 2 in the next while every deterministic fact was identical.
  // What the case actually asserts — a subject backend blocked in the server,
  // the call settling rather than hanging, and the rejection being loud — is
  // captured in `blockedBackends`, `callSettled`, `callRejected` and
  // `observedClientErrors`, all of which stay digested.
  "idleClientErrors",
]);

/**
 * Participants in a race are symmetric, so their results are digested as an
 * order-invariant multiset sorted by content. "One session ran five ledger
 * inserts and three ran none" is preserved; "it happened to be party 2" is not.
 */
function managedResults(results: Findings[]): unknown[] {
  return results
    .map((result) =>
      Object.fromEntries(
        Object.entries(result).filter(([key]) => !VOLATILE_RESULT_KEYS.has(key)),
      ),
    )
    .map((result) => stable(result))
    .sort()
    .map((serialized) => JSON.parse(serialized) as unknown);
}

/**
 * Engine-generated checkpoint and task ids are replaced with labels derived from
 * the lineage shape — they are as volatile as a timestamp, UUIDv6 being one —
 * and the conflict witness is reduced to its structure, because which racer won
 * is an outcome rather than a behaviour.
 */
function managedProjection(bundle: CaseBundle, definition: CaseDef): Record<string, unknown> | null {
  if (!bundle.projection) return null;
  const canonical = canonicaliseProjection(bundle.projection);
  const witness = bundle.projection.conflictWitness as ConflictProjection | undefined;
  const managed: Record<string, unknown> = witness
    ? { ...canonical, conflictWitness: managedConflictWitness(witness) }
    : { ...canonical };

  // Server-written timestamps are volatile by construction and must not reach
  // the digest; the stored values and vector texts are harness constants and do.
  const store = storeOf(bundle);
  if (store) managed.store = managedStoreProjection(store);

  // Effect key hashes are volatile by construction — they hash a checkpoint id
  // and a task id — so they are ranked into labels that preserve the equality
  // relations every criterion here actually asks about.
  if (Array.isArray(managed.effects)) {
    managed.effects = managedEffects(managed.effects as EffectEvent[]);
  }

  // Parallel siblings in one superstep write their rows in whatever order they
  // finish, and their task labels are assigned in that order — so `fan_a` was
  // `<task:3>` in one repeat and `<task:4>` in the next, with no behavioural
  // difference whatsoever. LangGraph guarantees no ordering between branches of
  // a superstep, which `canonical.ts` already says in its own comments.
  //
  // Sorting the write array by content turns it into an order-invariant
  // multiset: interchangeable sibling rows differ only by a label, so once
  // sorted the array is identical across repeats however the labels landed.
  // Nothing is hidden — the number of tasks, their writes, and which checkpoint
  // they attach to all survive; only "which one finished first" does not.
  // How many DISTINCT raw namespaces each skeleton stands for.
  //
  // `nsSkeleton` blanks embedded ids to a constant, so two instances of the SAME
  // call site — a `Send` fan-out to one node — would produce byte-identical
  // namespace strings and collapse into each other with nothing to show for it.
  // The current matrix never does that (e03 is `left:`/`right:`, e06 is
  // `mid:`/`leaf:`), so every cardinality here is 1; emitting it means a future
  // collision changes the digest instead of hiding inside it.
  const rawThread = bundle.projection?.thread as { checkpoints?: Array<{ ns?: string }> } | undefined;
  const rawNamespaces = [
    ...new Set((rawThread?.checkpoints ?? []).map((row) => String(row.ns ?? ""))),
  ];
  if (rawNamespaces.length > 0) {
    const cardinality: Record<string, number> = {};
    for (const ns of rawNamespaces) {
      const key = nsSkeleton(ns);
      cardinality[key] = (cardinality[key] ?? 0) + 1;
    }
    managed.namespaceSkeletons = Object.fromEntries(
      Object.entries(cardinality).sort(([left], [right]) => (left < right ? -1 : 1)),
    );
  }

  const thread = managed.thread as { writes?: unknown[] } | undefined;
  if (thread && Array.isArray(thread.writes)) {
    thread.writes = [...thread.writes].sort((left, right) =>
      stable(left) < stable(right) ? -1 : stable(left) > stable(right) ? 1 : 0,
    );
  }

  if (definition.classification !== "bounded-trials") return managed;

  // For a bounded-trials case the LINEAGE is itself a race outcome: when two
  // workers both consume an interrupt the thread forks, and when only one does
  // it does not. Digesting it would report a real, expected variation as a
  // reproducibility failure — the same mistake as digesting the SQLSTATE
  // profile. The invariants that must hold either way are asserted as criteria
  // over the raw data, and acceptance stability across repeats is checked
  // globally, so nothing is lost by keeping these out of the bytes.
  //
  // The terminal SCHEMA stays managed: it converges regardless of who won,
  // which is exactly the claim family A rests on.
  //
  // `store` and `storeConflict` join them for the Store races. Unlike the
  // checkpointer's split — where the row is DO UPDATE and the bytes are DO
  // NOTHING, so a collision ALWAYS separates them — the Store writes its row and
  // its vectors with the same last-writer-wins shape in separate autocommit
  // statements. Which side each writer ends up owning is therefore decided by
  // ordering alone, and digesting it would report an expected variation as a
  // reproducibility failure.
  //
  // `conflictWitness` joins them. It was left managed on the assumption that its
  // reduced form was invariant — true for b06, where the row is DO UPDATE and
  // the bytes are DO NOTHING so a collision ALWAYS splits them — but not for
  // b04, where both writers send the same payload and which of them owns the
  // surviving metadata is decided by arrival order alone. Three repeats of
  // `core-v4` never sampled the other outcome; the full matrix did.
  const raced = "<race outcome: see findings>";
  for (const key of [
    "thread",
    "executions",
    "reachability",
    "store",
    "storeConflict",
    "conflictWitness",
  ]) {
    if (key in managed) (managed as Record<string, unknown>)[key] = raced;
  }
  return managed;
}

/**
 * The elided fields, named once.
 *
 * `managedProjection` replaces each of these with `"<race outcome: see
 * findings>"` for a bounded case, and `observationFor` below is required to
 * represent every one of them. Deriving the observation from this list rather
 * than from a per-case declaration is deliberate: a hand-maintained list of
 * "what this case observes" drifts from what the case actually elides, and the
 * drift is invisible — which is precisely how the first version of the
 * `observed` block came to answer three of eight pointers while a
 * count-and-pointer global reported it complete.
 */
const RACED_FIELDS = [
  "results",
  "sqlstateMultiset",
  "thread",
  "executions",
  "reachability",
  "store",
  "storeConflict",
  "conflictWitness",
] as const;

/** Every SQLSTATE in a result tree, including the ones nested inside per-operation arrays. */
function canonicalFailures(bundle: CaseBundle): Array<Record<string, unknown>> {
  const counts = new Map<string, { code: string; constraint: string | null; count: number }>();
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const entry of value) walk(entry);
      return;
    }
    if (value === null || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    if (typeof record.code === "string") {
      const constraint = typeof record.constraint === "string" ? record.constraint : null;
      const key = `${record.code}\u0000${constraint ?? ""}`;
      const seen = counts.get(key);
      if (seen) seen.count += 1;
      else counts.set(key, { code: record.code, constraint, count: 1 });
    }
    for (const entry of Object.values(record)) walk(entry);
  };
  walk(resultsOf(bundle));
  return [...counts.values()].sort((left, right) =>
    stable(left) < stable(right) ? -1 : stable(left) > stable(right) ? 1 : 0,
  );
}

/**
 * Per-namespace leaf counts, not their sum.
 *
 * e08's whole question is WHERE the fork landed — root only, or root and child.
 * Summing the leaves to a scalar makes `(1,2)` and `(2,1)` the same number and
 * loses exactly the distinction the case exists to draw.
 */
function lineageShape(bundle: CaseBundle): Record<string, unknown> | null {
  const thread = threadOf(bundle);
  if (!thread) return null;
  return {
    checkpoints: (thread.checkpoints ?? []).length,
    interruptRows: thread.interruptRows ?? 0,
    distinctTaskIds: thread.distinctTaskIds ?? 0,
    namespaces: (thread.namespaces ?? []).length,
    leavesPerNamespace: (thread.leaves ?? [])
      .map((entry) => (entry.leaves ?? []).length)
      .sort((left, right) => left - right),
  };
}

/**
 * Who owns what, reported by ROLE and literally.
 *
 * Roles are assigned by the driver before the race, so `p0`/`p1` are managed
 * labels rather than volatile ids (§7.2) — "the same role did not always win" is
 * itself an observation, and relabelling it away would hide it. What matters for
 * the findings is the RELATION (`rowOwnerEqualsByteOwner`,
 * `itemOwnerEqualsVectorOwner`), and that is carried explicitly beside the
 * owners rather than left to be inferred.
 */
function observedOwnership(bundle: CaseBundle): Record<string, unknown> | null {
  const witness = bundle.projection?.conflictWitness as ConflictProjection | undefined;
  const store = storeConflictOf(bundle);
  if (!witness && !store) return null;

  const distinct = (values: Array<string | null | undefined>): string[] =>
    [...new Set(values.filter((value): value is string => typeof value === "string"))].sort();

  const checkpointOwners = distinct((witness?.checkpoints ?? []).map((row) => row.writer));
  const blobOwners = distinct((witness?.blobs ?? []).map((row) => row.owner));
  const writeOwners = distinct((witness?.writes ?? []).map((row) => row.owner));

  return {
    ...(witness
      ? {
          checkpointRows: (witness.checkpoints ?? []).length,
          checkpointOwners,
          blobOwners,
          writeOwners,
          rowOwnerEqualsByteOwner:
            checkpointOwners.length === 1 && blobOwners.length === 1
              ? checkpointOwners[0] === blobOwners[0]
              : null,
        }
      : {}),
    ...(store
      ? {
          storeItemRows: store.itemRows ?? null,
          storeItemOwner: store.itemOwner ?? null,
          storeVectorOwners: [...(store.vectorOwners ?? [])].sort(),
          storeOrphanVectors: store.orphanVectors ?? null,
          itemOwnerEqualsVectorOwner: store.itemOwnerEqualsVectorOwner ?? null,
        }
      : {}),
  };
}

/** Terminal Store state: what the database actually held when the race settled. */
function observedStoreTerminal(bundle: CaseBundle): Record<string, unknown> | null {
  const store = storeOf(bundle);
  if (!store) return null;
  return {
    items: (store.items ?? []).length,
    vectors: (store.vectors ?? []).length,
    ...(store.stats ? { stats: store.stats } : {}),
  };
}

/**
 * The per-party numeric work counters and terminal party outcomes.
 *
 * Kept per party rather than sorted, for the same reason owners are literal: a
 * sweeper split of `[0,6]` versus `[6,0]` is which role did the work, and the
 * invariant the criterion asserts is the SUM, which survives either way.
 */
function observedWork(bundle: CaseBundle): Array<Record<string, unknown>> {
  const numeric = ["swept", "operations", "fulfilled", "rejectedCount", "executions"];
  return resultsOf(bundle)
    .map((result) => {
      const entry: Record<string, unknown> = { party: result.party ?? null };
      for (const key of numeric) {
        if (typeof result[key] === "number") entry[key] = result[key];
      }
      if (typeof result.role === "string") entry.role = result.role;
      if (typeof result.completed === "boolean") entry.completed = result.completed;
      if (typeof result.executed === "boolean") entry.executed = result.executed;
      if (typeof result.classification === "string") entry.classification = result.classification;
      if (typeof result.leaseAcquired === "boolean") entry.leaseAcquired = result.leaseAcquired;
      entry.errored = (result.error ?? null) !== null;
      const runs = result.runs;
      if (Array.isArray(runs)) {
        entry.steps = runs.map((run) =>
          Array.isArray((run as { steps?: unknown[] })?.steps)
            ? ((run as { steps: unknown[] }).steps).length
            : 0,
        );
      }
      return entry;
    })
    .sort((left, right) => Number(left.party ?? 0) - Number(right.party ?? 0));
}

/** Effect-key equality relations, which are the whole of what h04 observes. */
function observedEffectKeys(bundle: CaseBundle): Record<string, unknown> | null {
  const effects = effectsOf(bundle);
  if (effects.length === 0) return null;
  const byNode = new Map<string, string[]>();
  for (const effect of effects) {
    const node = String(effect.node ?? "");
    byNode.set(node, [...(byNode.get(node) ?? []), String(effect.key ?? "")]);
  }
  return {
    recorded: effects.length,
    // Whether the SAME node computed the SAME key on every pass. That equality
    // is the measurement; the hash itself is volatile by construction.
    keysAgreePerNode: [...byNode.entries()]
      .sort(([left], [right]) => (left < right ? -1 : 1))
      .map(([node, keys]) => ({ node, passes: keys.length, distinctKeys: new Set(keys).size })),
  };
}

/**
 * The id-free observation of one bounded case, covering every raced field.
 *
 * This is computed INSIDE the pinned image, beside the criteria it has to stay
 * honest against. The first version lived in the driver's jq, which made it the
 * one analysis in the run whose code was not version-locked to the evidence it
 * described — and `verify-concurrency.sh` says in its own header that the driver
 * owns persistence and no analysis.
 */
function observationFor(bundle: CaseBundle): Record<string, unknown> {
  return {
    failures: canonicalFailures(bundle),
    cleanParties: liveResults(bundle).filter((result) => (result.error ?? null) === null).length,
    sqlstates: sqlstateMultiset(bundle),
    executions: [...executionsOf(bundle)].sort((left, right) =>
      left.node !== right.node
        ? left.node < right.node
          ? -1
          : 1
        : left.phase < right.phase
          ? -1
          : left.phase > right.phase
            ? 1
            : 0,
    ),
    lineage: lineageShape(bundle),
    reachability: reachabilityCountsOf(bundle),
    ownership: observedOwnership(bundle),
    storeTerminal: observedStoreTerminal(bundle),
    work: observedWork(bundle),
    effectKeys: observedEffectKeys(bundle),
  };
}

/** The four damage counts, which are what b02 and e08 turn on. */
function reachabilityCountsOf(bundle: CaseBundle): Record<string, number> | null {
  const witness = bundle.projection?.reachability as
    | {
        strandedReferences?: unknown[];
        orphanBlobs?: unknown[];
        brokenLineage?: unknown[];
        deadWrites?: unknown[];
      }
    | undefined;
  if (!witness) return null;
  return {
    strandedReferences: (witness.strandedReferences ?? []).length,
    orphanBlobs: (witness.orphanBlobs ?? []).length,
    brokenLineage: (witness.brokenLineage ?? []).length,
    deadWrites: (witness.deadWrites ?? []).length,
  };
}

/** Retained verbatim, never digested. Deleting it would hide the race. */
function findingsFor(bundle: CaseBundle): Record<string, unknown> {
  return {
    case: bundle.case,
    lane: bundle.lane,
    sqlstateMultiset: sqlstateMultiset(bundle),
    results: resultsOf(bundle),
    // The actual winner of every conflict, kept where it can be read across
    // repeats as an observed outcome set.
    conflictWitness: bundle.projection?.conflictWitness ?? null,
    executions: bundle.projection?.executions ?? null,
    thread: bundle.projection?.thread ?? null,
    reachability: bundle.projection?.reachability ?? null,
    // Which writer owns the surviving Store row and which owns its vectors is
    // the race outcome, kept where it can be read across repeats as a set.
    store: bundle.projection?.store ?? null,
    storeConflict: bundle.projection?.storeConflict ?? null,
    // The literal key hashes and the raw namespace strings, retained where the
    // report can quote them. Nothing here is digested.
    effects: bundle.projection?.effects ?? null,
    effectSites: bundle.projection?.effectSites ?? null,
    drain: bundle.drain ?? null,
    activityStates: (bundle.coordination?.activity ?? []).map((sample) => ({
      stage: sample.stage,
      states: sample.rows.reduce<Record<string, number>>((counts, row) => {
        const state = String(row.state ?? "unknown");
        counts[state] = (counts[state] ?? 0) + 1;
        return counts;
      }, {}),
    })),
  };
}

function postureOk(posture: Record<string, unknown> | null): boolean {
  if (!posture) return false;
  const inner = (posture.posture ?? posture) as Record<string, unknown>;
  const capDrop = (inner.capDrop as string[] | undefined) ?? [];
  return (
    inner.readOnly === true &&
    inner.user === "node" &&
    capDrop.includes("ALL") &&
    Number(inner.publishedPorts ?? 0) === 0 &&
    Number(inner.binds ?? 0) === 0
  );
}

function selftestCriteria(bundles: Map<string, CaseBundle>): Record<string, boolean> {
  const criteria: Record<string, boolean> = {};

  const s01 = firstResult(bundles.get("s01-pins"));
  if (s01) {
    criteria.pins_agree_across_installed_lockfile_and_manifest = s01.pinsAgree === true;
    criteria.harness_relations_present_from_pg_class = s01.harnessRelationsPresent === true;
    criteria.egress_blocked_with_explicit_errno =
      (s01.egress as { isolated?: boolean } | undefined)?.isolated === true;
  }

  const s02 = bundles.get("s02-barrier-overlap");
  const s02Barrier = s02?.coordination?.barriers?.[0];
  if (s02Barrier) {
    criteria.barrier_all_parties_arrived_before_release =
      s02Barrier.allArrivedBeforeRelease === true;
    criteria.barrier_parties_are_distinct_backends =
      s02Barrier.distinctBackends === s02Barrier.partiesExpected;
    criteria.barrier_parties_are_distinct_processes =
      s02Barrier.distinctNonces === s02Barrier.partiesExpected;
    criteria.barrier_overlap_observed_independently =
      s02Barrier.peakConcurrentParties >= s02Barrier.partiesExpected;
  }

  const s03 = bundles.get("s03-barrier-serial-control");
  const s03Stages = s03?.coordination?.barriers ?? [];
  if (s03Stages.length > 0) {
    const peak = Math.max(...s03Stages.map((stage) => stage.peakConcurrentParties));
    criteria.serial_control_never_overlapped = peak === 1;
    // The differential is what makes s02's claim load-bearing: without it,
    // "four parties were attached" could be satisfied by a fast sequence.
    criteria.overlap_witness_discriminates_overlap_from_sequence =
      (s02Barrier?.peakConcurrentParties ?? 0) > peak;
  }

  const s04 = firstResult(bundles.get("s04-gate-passthrough"));
  if (s04) {
    criteria.gate_leaves_vendor_statement_multiset_unchanged = s04.multisetsIdentical === true;
    criteria.gate_leaves_vendor_statement_order_unchanged = s04.shapesIdentical === true;
    criteria.every_vendor_statement_is_classified = s04.unclassifiedStatements === 0;
    // Stated positively AND non-vacuously: a gate set that fired nothing would
    // otherwise satisfy "nothing was left unreached".
    const declared = (s04.gatesDeclared as unknown[] | undefined) ?? [];
    const reached = (s04.gatesReached as unknown[] | undefined) ?? [];
    const unreached = (s04.gatesUnreached as unknown[] | undefined) ?? [];
    criteria.declared_gates_were_reached =
      declared.length > 0 && unreached.length === 0 && reached.length === declared.length;
    criteria.gate_arrivals_recorded_durably =
      Array.isArray(s04.durableParks) && (s04.durableParks as unknown[]).length === declared.length;
  }

  const s05Graphs = bundles.get("s05-lock-edge")?.coordination?.lockGraphs ?? [];
  if (s05Graphs.length > 0) {
    const graph = s05Graphs[0]!.graph;
    criteria.lock_edge_captured = graph.edgeCount >= 1;
    criteria.lock_edge_attributed_to_a_participant = graph.unattributedBackends === 0;
    criteria.lock_edge_has_no_self_edges = graph.selfEdges === 0;
    criteria.lock_oracles_agree = graph.oraclesAgree === true;
  }

  const s06 = firstResult(bundles.get("s06-embedding-oracle"));
  if (s06) {
    criteria.authored_rankings_match_independent_arithmetic = s06.ordersAgree === true;
    criteria.metric_orderings_are_pairwise_distinct = s06.ordersPairwiseDistinct === true;
    criteria.embedder_refuses_text_absent_from_the_fixture = s06.refusedUnknownText === true;
    criteria.embedding_dimensions_are_consistent = s06.dimsConsistent === true;
  }

  const s07 = bundles.get("s07-shutdown-witness-positive-control");
  if (s07) {
    const witnesses =
      (s07.projection?.shutdownWitnesses as Array<{ node: string; phase: string }> | undefined) ??
      [];
    criteria.s07_worker_parked_before_the_signal =
      ((s07.projection?.gateParks as Array<{ gate: string }> | undefined) ?? []).some(
        (park) => park.gate === "await-sigterm",
      );
    // EXACTLY one, and it is a sigterm row. This is the whole point of the case:
    // the eleven SIGKILL cases assert this collection is EMPTY, and that
    // assertion is only meaningful because a signal the handler can catch
    // demonstrably fills it.
    criteria.s07_a_catchable_signal_produces_exactly_one_shutdown_witness =
      witnesses.length === 1 && witnesses[0]?.phase === "sigterm";
    // 143 = 128 + SIGTERM. A handler that exited some other way would still have
    // written the row, so the exit code is checked separately.
    criteria.s07_worker_exited_through_the_signal_handler = s07.kill?.waitExit === 143;
    criteria.s07_backend_drained_before_projection = s07.drain?.drained === true;
  }

  const s08 = bundles.get("s08-canonical-token-uniqueness");
  if (s08) {
    const result = firstResult(s08);
    // The layer every managed digest is computed over, and the one mechanism
    // whose failure no other oracle could see.
    criteria.s08_every_distinct_source_id_received_a_distinct_token =
      result?.checkpointLabelsInjective === true && Number(result?.distinctCheckpointIds ?? 0) > 1;
    criteria.s08_a_referenced_but_absent_parent_is_labelled_separately =
      result?.absentParentLabelled === true;
    criteria.s08_the_ranker_is_injective_and_stable = result?.rankerInjective === true;
    criteria.s08_no_token_namespace_collides = result?.tokenNamespacesDisjoint === true;
    // The leak scanner checks credentials and host paths; it has never checked
    // for volatile ids, so an escaped uuid would have shown up only as an
    // irreproducible digest with no explanation.
    criteria.s08_no_raw_uuid_survives_canonicalisation =
      result?.rawUuidSurvivesCanonicalisation === false;
    // The ONE deliberate many-to-one mapping, declared so it can never be
    // mistaken for a collision: `nsSkeleton` collapses embedded uuids on purpose.
    criteria.s08_the_deliberate_namespace_collapse_is_declared =
      result?.skeletonCollapseIsDeclared === true;
  }

  return criteria;
}

function relationsIn(bundle: CaseBundle | undefined, prefix: string): string[] {
  const all = (bundle?.projection?.relations as string[] | undefined) ?? [];
  return all.filter((name) => name.startsWith(prefix)).sort();
}

function ledgerOf(bundle: CaseBundle | undefined, key: "checkpointLedger" | "storeLedger"): number[] {
  return (bundle?.projection?.[key] as number[] | undefined) ?? [];
}

function statementCount(result: Findings | undefined, label: string): number {
  return ((result?.statements as Record<string, number> | undefined) ?? {})[label] ?? 0;
}

function eq(left: unknown, right: unknown): boolean {
  return stable(left) === stable(right);
}

function familyACriteria(bundles: Map<string, CaseBundle>): Record<string, boolean> {
  const criteria: Record<string, boolean> = {};
  const get = (id: string) => bundles.get(id);

  const a01 = get("a01-saver-setup-serial");
  const baselineRelations = relationsIn(a01, "lg_checkpoints.");
  const baselineLedger = ledgerOf(a01, "checkpointLedger");

  if (a01) {
    const result = liveResults(a01)[0];
    criteria.a01_serial_setup_raised_nothing = result?.error === null;
    criteria.a01_ledger_is_contiguous = baselineLedger.length > 0 &&
      baselineLedger.every((v, index) => v === index);
    criteria.a01_baseline_relation_set_is_non_empty = baselineRelations.length >= 4;
  }

  // Every race is scored against a01, so a01 must be present and non-empty
  // before any convergence criterion below can mean anything.
  const haveBaseline = baselineRelations.length >= 4 && baselineLedger.length > 0;

  for (const [id, prefix] of [
    ["a02-saver-setup-race-passive", "a02"],
    ["a03-saver-setup-race-gated", "a03"],
    ["a13-saver-setup-advisory-lock", "a13"],
  ] as const) {
    const bundle = get(id);
    if (!bundle || !haveBaseline) continue;
    criteria[`${prefix}_terminal_schema_matches_the_serial_baseline`] = eq(
      relationsIn(bundle, "lg_checkpoints."),
      baselineRelations,
    );
    criteria[`${prefix}_terminal_ledger_matches_the_serial_baseline`] = eq(
      ledgerOf(bundle, "checkpointLedger"),
      baselineLedger,
    );
    const codes = sqlstatesOf(bundle);
    criteria[`${prefix}_every_racer_outcome_is_classified`] =
      codes.length === bundle.workers.length &&
      codes.every((code) => code === null || /^[0-9A-Z]{5}$/.test(code));
  }

  const a02Barrier = get("a02-saver-setup-race-passive")?.coordination?.barriers?.[0];
  if (a02Barrier) {
    criteria.a02_four_processes_were_attached_together =
      a02Barrier.allArrivedBeforeRelease === true &&
      a02Barrier.peakConcurrentParties >= a02Barrier.partiesExpected;
  }

  const a03 = get("a03-saver-setup-race-gated");
  const a03Barrier = a03?.coordination?.barriers?.[0];
  if (a03 && a03Barrier) {
    const parks = (a03.projection?.gateParks as Array<Record<string, unknown>> | undefined) ?? [];
    criteria.a03_every_racer_parked_on_its_migration_version_read =
      parks.length === a03Barrier.partiesExpected &&
      parks.every((park) => park.statement === "ckpt.migration-read") &&
      new Set(parks.map((park) => park.party)).size === a03Barrier.partiesExpected;
    criteria.a03_racers_were_released_only_after_all_had_read =
      a03Barrier.allArrivedBeforeRelease === true &&
      a03Barrier.distinctBackends === a03Barrier.partiesExpected;
    // Migration DDL, not the ledger insert: a racer that loses the CREATE TABLE
    // race never reaches a ledger insert at all, so requiring one would encode a
    // prediction the measurement disproved rather than a witness of what it read.
    criteria.a03_every_racer_acted_on_an_empty_ledger_read =
      liveResults(a03).length === a03Barrier.partiesExpected &&
      liveResults(a03).every((result) => statementCount(result, "ckpt.migration-ddl") > 0);
  }

  const a04 = get("a04-saver-setup-gated-sequential-control");
  if (a04) {
    const results = liveResults(a04);
    // Counted by migration DDL, not by ledger inserts. A racer that loses the
    // CREATE TABLE race never reaches a ledger insert, so a ledger-based count
    // is itself decided by the interleaving — which made this control flap.
    // "Did this racer act on an empty ledger read" is the stable question, and
    // it is answered by whether it attempted any migration at all.
    const migrators = results.filter(
      (result) => statementCount(result, "ckpt.migration-ddl") > 0,
    ).length;
    criteria.a04_sequential_release_raised_nothing = results.every(
      (result) => result.error === null,
    );
    criteria.a04_only_the_first_racer_ran_migrations =
      results.length === a04.workers.length && migrators === 1;
    if (a03) {
      const gatedMigrators = liveResults(a03).filter(
        (result) => statementCount(result, "ckpt.migration-ddl") > 0,
      ).length;
      criteria.a04_control_discriminates_from_the_simultaneous_release =
        gatedMigrators > migrators;
    }
  }

  const a05 = get("a05-saver-setup-kill-before-ledger");
  if (a05) {
    const parks = (a05.projection?.gateParks as Array<Record<string, unknown>> | undefined) ?? [];
    const witnesses =
      (a05.projection?.shutdownWitnesses as Array<Record<string, unknown>> | undefined) ?? [];
    const afterKill = (a05 as { projectionAfterKill?: Record<string, unknown> })
      .projectionAfterKill;
    criteria.a05_migrator_parked_at_the_named_boundary = parks.some(
      (park) =>
        park.party === 0 && park.gate === "ledger-pre" && park.statement === "ckpt.migration-ledger",
    );
    criteria.a05_killed_backend_drained_before_projection = a05.drain?.drained === true;
    // A SIGKILL cannot be caught, so the ABSENCE of a shutdown row is what proves
    // the process died where it was parked rather than exiting tidily.
    criteria.a05_kill_left_no_shutdown_witness = !witnesses.some(
      (row) => row.party === 0 && row.phase === "sigterm",
    );
    if (afterKill) {
      const partialLedger = (afterKill.checkpointLedger as number[] | undefined) ?? [];
      const partialRelations = ((afterKill.relations as string[] | undefined) ?? []).filter(
        (name) => name.startsWith("lg_checkpoints."),
      );
      criteria.a05_kill_left_the_schema_ahead_of_the_ledger =
        partialRelations.length > partialLedger.length + 1;
    }
    if (haveBaseline) {
      criteria.a05_retry_converged_to_the_serial_baseline =
        eq(relationsIn(a05, "lg_checkpoints."), baselineRelations) &&
        eq(ledgerOf(a05, "checkpointLedger"), baselineLedger);
    }
  }

  const a06 = get("a06-store-setup-serial");
  const storeBaselineRelations = relationsIn(a06, "lg_store.");
  const storeBaselineLedger = ledgerOf(a06, "storeLedger");
  if (a06) {
    const extensionNames = ((a06.projection?.extensions as Array<{ name: string }> | undefined) ??
      []).map((row) => row.name);
    const indexNames = (a06.projection?.indexes as string[] | undefined) ?? [];
    criteria.a06_store_setup_raised_nothing = liveResults(a06)[0]?.error === null;
    criteria.a06_store_ledger_is_contiguous =
      storeBaselineLedger.length > 0 && storeBaselineLedger.every((v, index) => v === index);
    criteria.a06_vector_extension_present = extensionNames.includes("vector");
    criteria.a06_exactly_one_metric_index_created =
      indexNames.filter((name) => name.includes("store_vectors_embedding")).length === 1;
  }

  const a07 = get("a07-store-setup-race-gated");
  const a07Barrier = a07?.coordination?.barriers?.[0];
  if (a07 && a07Barrier && storeBaselineLedger.length > 0) {
    const parks = (a07.projection?.gateParks as Array<Record<string, unknown>> | undefined) ?? [];
    criteria.a07_every_racer_parked_on_its_store_version_read =
      parks.length === a07Barrier.partiesExpected &&
      parks.every((park) => park.statement === "store.migration-read");
    criteria.a07_terminal_store_schema_matches_the_serial_baseline = eq(
      relationsIn(a07, "lg_store."),
      storeBaselineRelations,
    );
    criteria.a07_terminal_store_ledger_matches_the_serial_baseline = eq(
      ledgerOf(a07, "storeLedger"),
      storeBaselineLedger,
    );
  }

  const a08 = get("a08-store-trigger-race");
  if (a08) {
    const prepared = (a08.prepare?.ledgerAfter as number[] | undefined) ?? [];
    const triggerRows =
      (a08.projection?.triggers as Array<Record<string, unknown>> | undefined) ?? [];
    criteria.a08_fixture_rewound_the_ledger_past_the_trigger_migration = eq(prepared, [0, 1, 2]);
    criteria.a08_both_racers_replayed_the_trigger_migration =
      liveResults(a08).length === a08.workers.length &&
      liveResults(a08).every((result) => statementCount(result, "store.migration-trigger") > 0);
    criteria.a08_trigger_exists_exactly_once_afterwards =
      triggerRows.filter((row) => row.name === "update_store_updated_at").length === 1;
  }

  const a09 = get("a09-store-lazy-same-process");
  const a10 = get("a10-store-lazy-awaited-control");
  if (a09) {
    const result = liveResults(a09)[0];
    criteria.a09_store_ledger_remained_contiguous = (() => {
      const ledger = ledgerOf(a09, "storeLedger");
      return ledger.length > 0 && ledger.every((v, index) => v === index);
    })();
    criteria.a09_every_operation_outcome_is_classified =
      typeof result?.operations === "number" &&
      Number(result.operations) === Number(result.fulfilled) + (result.rejections as unknown[]).length;
  }
  if (a10) {
    const result = liveResults(a10)[0];
    criteria.a10_awaited_setup_ran_no_migrations_during_operations =
      result?.migrationReadsDuringOperations === 0;
    criteria.a10_awaited_setup_completed_every_operation =
      Number(result?.fulfilled ?? -1) === Number(result?.operations ?? -2);
  }
  if (a09 && a10) {
    const lazy = Number(liveResults(a09)[0]?.migrationReadsDuringOperations ?? -1);
    const awaited = Number(liveResults(a10)[0]?.migrationReadsDuringOperations ?? -1);
    criteria.a10_control_discriminates_lazy_from_awaited_setup = lazy > awaited && awaited === 0;
  }

  const a11 = get("a11-store-index-config-change");
  if (a11) {
    const result = liveResults(a11)[0];
    criteria.a11_ledger_unchanged_after_a_dimension_change = result?.ledgerUnchanged === true;
    criteria.a11_vector_column_unchanged_after_a_dimension_change =
      result?.columnUnchanged === true;
    // Architecture-required: a mismatch must be loud. A silent skip would leave
    // the item unindexed and invisible to vector search with no signal at all.
    criteria.a11_dimension_mismatch_surfaced_loudly_on_write =
      (result?.putError as { code?: string } | null)?.code !== undefined;
  }

  const a12 = get("a12-colocated-schemas");
  if (a12) {
    const result = liveResults(a12)[0];
    criteria.a12_colocated_ledgers_are_distinct_relations =
      result?.ledgersAreDistinctRelations === true;
    criteria.a12_colocation_produced_no_duplicate_relation_names =
      result?.duplicateRelationNames === false;
  }

  const a13 = get("a13-saver-setup-advisory-lock");
  if (a13) {
    const results = liveResults(a13);
    criteria.a13_every_guarded_racer_completed_without_error =
      results.length === a13.workers.length && results.every((result) => result.error === null);
    criteria.a13_every_session_released_the_lock_it_held = results.every(
      (result) => result.unlockReturnedTrue === true,
    );
    criteria.a13_no_advisory_lock_remained_granted = results.every(
      (result) => Number(result.advisoryLocksStillGranted) === 0,
    );
    // Disjointness proven from the SERVER clock, not from wall time in four
    // separate containers.
    const intervals = results
      .map((result) => ({
        from: Date.parse(String(result.acquiredAt)),
        to: Date.parse(String(result.releasedAt)),
      }))
      .filter((interval) => Number.isFinite(interval.from) && Number.isFinite(interval.to))
      .sort((left, right) => left.from - right.from);
    criteria.a13_lock_holding_intervals_were_disjoint =
      intervals.length === a13.workers.length &&
      intervals.every((interval, index) => index === 0 || intervals[index - 1]!.to <= interval.from);
  }

  return criteria;
}

/**
 * Which candidate payloads own the stored rows.
 *
 * `owners` is a SET, so "exactly one writer owns the bytes" and "the surviving
 * value is one of the two candidates rather than a merge or a truncation" are
 * both answerable from it. `unknown` in the set means the stored bytes matched
 * no candidate, which is a fault rather than a race outcome.
 */
function ownersOf(rows: Array<{ owner: string }> | undefined): string[] {
  return [...new Set((rows ?? []).map((row) => row.owner))].sort();
}

function familyBCriteria(bundles: Map<string, CaseBundle>): Record<string, boolean> {
  const criteria: Record<string, boolean> = {};
  const get = (id: string) => bundles.get(id);

  const b01 = get("b01-graph-serial-baseline");
  const baselineFinish = b01 ? executionOf(b01, "finish", "executed").executions : -1;
  const baselineResumed = b01 ? executionOf(b01, "gate", "resumed").executions : -1;
  if (b01) {
    const result = liveResults(b01)[0];
    const thread = threadOf(b01);
    criteria.b01_serial_run_reached_the_interrupt = result?.reachedInterrupt === true;
    criteria.b01_serial_run_completed_after_resume = result?.completed === true;
    criteria.b01_serial_run_executed_the_final_node_once = baselineFinish === 1;
    criteria.b01_serial_run_consumed_the_interrupt_once = baselineResumed === 1;
    // A single chain: exactly one leaf in the root namespace.
    criteria.b01_serial_lineage_has_a_single_head =
      (thread?.leaves ?? []).filter((entry) => entry.ns === "").every((entry) => entry.leaves.length === 1) &&
      (thread?.leaves ?? []).length > 0;
  }

  const haveBaseline = baselineFinish >= 0;

  const b02 = get("b02-same-thread-parallel-resume");
  const b02Barrier = b02?.coordination?.barriers?.[0];
  if (b02 && b02Barrier) {
    const finish = executionOf(b02, "finish", "executed");
    const resumed = executionOf(b02, "gate", "resumed");
    criteria.b02_both_workers_were_released_together =
      b02Barrier.allArrivedBeforeRelease === true &&
      b02Barrier.peakConcurrentParties >= b02Barrier.partiesExpected &&
      b02Barrier.distinctNonces === b02Barrier.partiesExpected;
    criteria.b02_prepared_fixture_committed_an_interrupt =
      Number((b02.prepare as { interruptRows?: number } | null)?.interruptRows ?? 0) > 0;
    // Stated as "every outcome is accounted for", NOT as "no duplicate ran".
    // Whether the final node ran once or twice is the measurement; a criterion
    // asserting one of those answers would be asserting the conclusion.
    criteria.b02_every_resume_outcome_is_classified =
      liveResults(b02).length === b02.workers.length &&
      liveResults(b02).every((result) => "error" in result && "run" in result);
    criteria.b02_execution_witness_attributes_every_run_to_a_process =
      finish.executions === 0 || finish.processes >= 1;
    criteria.b02_lineage_projected_from_raw_rows =
      (threadOf(b02)?.checkpoints?.length ?? 0) > 0;
    // Architecture-required, and the load-bearing one: whatever the engine did
    // with the duplicate, it must not have left a checkpoint pointing at bytes
    // that are not there.
    const reach = b02.projection?.reachability as
      | { strandedReferences?: unknown[]; brokenLineage?: unknown[] }
      | undefined;
    criteria.b02_no_checkpoint_references_a_missing_blob =
      Array.isArray(reach?.strandedReferences) && reach.strandedReferences.length === 0;
    criteria.b02_no_checkpoint_lost_its_parent =
      Array.isArray(reach?.brokenLineage) && reach.brokenLineage.length === 0;
    if (haveBaseline) {
      // Bounded either side. How MANY workers executed the final node is the
      // race outcome and is reported, not asserted; that at least one did, and
      // that no more than the released workers did, is invariant.
      criteria.b02_final_node_executions_are_bounded_by_the_released_workers =
        finish.executions >= baselineFinish && finish.executions <= b02.workers.length;
      criteria.b02_resume_executions_are_bounded_by_the_released_workers =
        resumed.executions >= baselineResumed && resumed.executions <= b02.workers.length;
      criteria.b02_every_execution_belongs_to_a_distinct_released_process =
        finish.processes <= b02.workers.length && finish.processes >= 1;
    }
  }

  const b03 = get("b03-same-thread-sequential-control");
  if (b03) {
    const stages = b03.coordination?.barriers ?? [];
    const finish = executionOf(b03, "finish", "executed");
    criteria.b03_sequential_control_never_overlapped =
      stages.length > 0 && Math.max(...stages.map((stage) => stage.peakConcurrentParties)) === 1;
    criteria.b03_every_sequential_outcome_is_classified =
      liveResults(b03).length === b03.workers.length &&
      liveResults(b03).every((result) => "error" in result);
    // The control's claim is about ITSELF and is deterministic: resuming the
    // same thread twice in sequence executes the final node exactly once. A
    // criterion comparing this to b02 would inherit b02's race — b02 duplicates
    // in some repeats and not others — and would fail for the interleaving
    // rather than for the behaviour. The comparison is a finding, not a gate.
    criteria.b03_sequential_resume_executed_the_final_node_once = finish.executions === 1;
    criteria.b03_sequential_resume_used_a_single_process = finish.processes === 1;
    // The reason terminal graph output is not evidence: the second worker
    // reports the full step list restored from the checkpoint while having
    // executed nothing at all.
    criteria.b03_second_worker_returned_persisted_state_without_executing =
      liveResults(b03).length === 2 &&
      liveResults(b03).every((result) => result.completed === true) &&
      finish.executions === 1;
  }

  for (const [id, prefix] of [
    ["b04-put-conflict-metadata", "b04"],
    ["b05-blob-conflict-bytes", "b05"],
    ["b06-checkpoint-and-blob-split", "b06"],
  ] as const) {
    const bundle = get(id);
    const barrier = bundle?.coordination?.barriers?.[0];
    if (!bundle || !barrier) continue;
    const witness = conflictOf(bundle);
    criteria[`${prefix}_both_writers_were_released_together`] =
      barrier.allArrivedBeforeRelease === true &&
      barrier.peakConcurrentParties >= barrier.partiesExpected;
    criteria[`${prefix}_every_writer_outcome_is_classified`] =
      liveResults(bundle).length === bundle.workers.length &&
      liveResults(bundle).every((result) => "error" in result);
    // No stored row may decode to something neither writer wrote. That would be
    // a torn value, and it is a fault rather than a race outcome.
    criteria[`${prefix}_no_stored_blob_is_unattributable`] =
      (witness?.blobs?.length ?? 0) > 0 && !ownersOf(witness?.blobs).includes("unknown");
  }

  const b04 = get("b04-put-conflict-metadata");
  if (b04) {
    const witness = conflictOf(b04);
    const rows = witness?.checkpoints ?? [];
    const writers = [...new Set(rows.map((row) => row.writer))].sort();
    criteria.b04_one_checkpoint_row_survived = rows.length === 1;
    criteria.b04_surviving_metadata_belongs_to_exactly_one_writer =
      writers.length === 1 && (writers[0] === "p0" || writers[0] === "p1");
  }

  const b05 = get("b05-blob-conflict-bytes");
  if (b05) {
    const witness = conflictOf(b05);
    criteria.b05_both_checkpoint_rows_survived = (witness?.checkpoints?.length ?? 0) === 2;
    criteria.b05_one_blob_row_survived = (witness?.blobs?.length ?? 0) === 1;
    criteria.b05_surviving_bytes_belong_to_exactly_one_writer =
      ownersOf(witness?.blobs).length === 1;
  }

  const b06 = get("b06-checkpoint-and-blob-split");
  if (b06) {
    const witness = conflictOf(b06);
    const rowOwners = [...new Set((witness?.checkpoints ?? []).map((row) => row.writer))];
    const byteOwners = ownersOf(witness?.blobs);
    criteria.b06_one_checkpoint_row_survived = (witness?.checkpoints?.length ?? 0) === 1;
    criteria.b06_one_blob_row_survived = (witness?.blobs?.length ?? 0) === 1;
    criteria.b06_row_and_bytes_each_have_exactly_one_owner =
      rowOwners.length === 1 && byteOwners.length === 1;
    // Recorded, not asserted either way: whether the row and the bytes came from
    // the same writer IS the finding, and it is presented in the review.
    criteria.b06_row_and_byte_ownership_was_determined =
      rowOwners.length === 1 && byteOwners.length === 1 && rowOwners[0] !== null;
  }

  for (const [id, prefix] of [
    ["b07-putwrites-ordinary-channel", "b07"],
    ["b08-putwrites-special-channel", "b08"],
  ] as const) {
    const bundle = get(id);
    const barrier = bundle?.coordination?.barriers?.[0];
    if (!bundle || !barrier) continue;
    const witness = conflictOf(bundle);
    // The prepare fixture writes the base checkpoint with a payload that is not
    // a candidate, so the write rows are filtered to the contended task id.
    const contended = (witness?.writes ?? []).filter((row) =>
      row.key.includes(`/${CONFLICT_TASK_ID}/`),
    );
    criteria[`${prefix}_both_writers_were_released_together`] =
      barrier.allArrivedBeforeRelease === true &&
      barrier.peakConcurrentParties >= barrier.partiesExpected;
    criteria[`${prefix}_one_write_row_survived_the_collision`] = contended.length === 1;
    criteria[`${prefix}_surviving_write_belongs_to_exactly_one_writer`] =
      ownersOf(contended).length === 1 && !ownersOf(contended).includes("unknown");
    criteria[`${prefix}_every_writer_outcome_is_classified`] =
      liveResults(bundle).length === bundle.workers.length &&
      liveResults(bundle).every((result) => "error" in result);
  }

  const b07 = get("b07-putwrites-ordinary-channel");
  const b08 = get("b08-putwrites-special-channel");
  if (b07 && b08) {
    const idxOf = (bundle: CaseBundle): number[] =>
      ((threadOf(bundle)?.writes ?? []) as Array<{ idx?: number; task_id?: string }>)
        .filter((row) => row.task_id === CONFLICT_TASK_ID)
        .map((row) => Number(row.idx));
    // The pair's whole point: the same method on the same table chose a
    // different idx AND a different conflict clause purely from the channel
    // name. A shared idx would mean the two cases did not actually differ.
    criteria.b08_special_channel_took_a_different_row_index_than_the_ordinary_one =
      idxOf(b07).length > 0 && idxOf(b08).length > 0 && idxOf(b07)[0] !== idxOf(b08)[0];
  }

  const b09 = get("b09-read-under-concurrent-commits");
  if (b09) {
    const reader = liveResults(b09).find((result) => result.role === "reader");
    const writer = liveResults(b09).find((result) => result.role === "writer");
    const barrier = b09.coordination?.barriers?.[0];
    criteria.b09_writer_committed_every_checkpoint =
      Number(writer?.committed ?? -1) > 0 && writer?.error === null;
    criteria.b09_both_parties_were_released_together =
      barrier?.allArrivedBeforeRelease === true &&
      Number(barrier?.peakConcurrentParties ?? 0) >= Number(barrier?.partiesExpected ?? 99) &&
      Number(barrier?.distinctNonces ?? 0) === Number(barrier?.partiesExpected ?? 99);
    // The sampling window, asserted at BOTH ends and structural at both.
    // The reader takes a sample before releasing the writer, and stops on the
    // writer's durable `writer/done` row rather than on a checkpoint count — so
    // neither observation depends on the interleaving.
    criteria.b09_reader_sampled_before_the_writer_started = reader?.sawEmptyChain === true;
    criteria.b09_reader_sampled_the_completed_chain = reader?.sawCompleteChain === true;
    // Named for what it actually proves. The reader is polling continuously
    // from before the writer's first commit until after its last, and the
    // checkpoint count demonstrably CHANGED underneath it — so every sample it
    // took spans the commit sequence. It does not prove a mid-chain state was
    // caught: with the writer released and running at full speed the reader may
    // go straight from 0 to 5, and the earlier phrasing ("while the writer was
    // committing") claimed more than that.
    criteria.b09_reader_sampled_across_the_commit_sequence =
      Number(reader?.distinctCheckpointCounts ?? 0) > 1;
    // The negative claims are gated on the window being real, so they can never
    // pass on a reader that sampled a settled database.
    criteria.b09_no_sample_saw_a_checkpoint_missing_its_blobs =
      Number(reader?.distinctCheckpointCounts ?? 0) > 1 &&
      Number(reader?.samplesWithStrandedReferences ?? -1) === 0;
    criteria.b09_no_sample_saw_a_broken_parent_link =
      Number(reader?.distinctCheckpointCounts ?? 0) > 1 &&
      Number(reader?.samplesWithBrokenLineage ?? -1) === 0;
  }

  return criteria;
}

type SurvivingRows = { checkpoints: number; blobs: number; writes: number };

function survivingRows(bundle: CaseBundle | undefined): SurvivingRows | null {
  const observer = liveResults(bundle).find(
    (result) => result.role === "observer",
  );
  return (observer?.survivingRows as SurvivingRows | undefined) ?? null;
}

function strandedCount(bundle: CaseBundle | undefined): number {
  const reach = bundle?.projection?.reachability as { strandedReferences?: unknown[] } | undefined;
  return Array.isArray(reach?.strandedReferences) ? reach.strandedReferences.length : -1;
}

function familyCCriteria(bundles: Map<string, CaseBundle>): Record<string, boolean> {
  const criteria: Record<string, boolean> = {};
  const get = (id: string) => bundles.get(id);

  const killCases = [
    ["c01-kill-inside-put-before-checkpoint-row", "c01", "ckpt.checkpoint-upsert"],
    ["c02-kill-inside-put-before-commit", "c02", "txn.commit"],
    ["c03-kill-after-commit-acknowledged", "c03", "txn.commit"],
    ["c04-kill-inside-putwrites-before-commit", "c04", "txn.commit"],
    ["c05-nonatomic-writer-control", "c05", "ckpt.checkpoint-upsert"],
  ] as const;

  for (const [id, prefix, statement] of killCases) {
    const bundle = get(id);
    if (!bundle) continue;
    const parks = (bundle.projection?.gateParks as Array<Record<string, unknown>> | undefined) ?? [];
    const witnesses =
      (bundle.projection?.shutdownWitnesses as Array<Record<string, unknown>> | undefined) ?? [];
    criteria[`${prefix}_victim_parked_at_the_named_boundary`] = parks.some(
      (park) => park.party === 0 && park.statement === statement,
    );
    criteria[`${prefix}_killed_backend_drained_before_projection`] = bundle.drain?.drained === true;
    // A SIGKILL cannot be caught, so the ABSENCE of a shutdown row is the proof
    // the process died where it parked rather than exiting tidily.
    criteria[`${prefix}_kill_left_no_shutdown_witness`] = !witnesses.some(
      (row) => row.party === 0 && row.phase === "sigterm",
    );
    criteria[`${prefix}_surviving_rows_were_counted_independently`] =
      survivingRows(bundle) !== null;
  }

  for (const [id, prefix] of [
    ["c01-kill-inside-put-before-checkpoint-row", "c01"],
    ["c02-kill-inside-put-before-commit", "c02"],
  ] as const) {
    const rows = survivingRows(get(id));
    if (!rows) continue;
    criteria[`${prefix}_open_transaction_left_no_checkpoint_row`] = rows.checkpoints === 0;
    criteria[`${prefix}_open_transaction_left_no_blob_rows`] = rows.blobs === 0;
    criteria[`${prefix}_no_stranded_reference_survived`] = strandedCount(get(id)) === 0;
  }

  const c03 = get("c03-kill-after-commit-acknowledged");
  const c03Rows = survivingRows(c03);
  if (c03Rows) {
    // The discriminator. If an acknowledged commit did NOT survive, then c01 and
    // c02 finding nothing says only that the kill landed early.
    criteria.c03_acknowledged_commit_survived_the_kill =
      c03Rows.checkpoints === 1 && c03Rows.blobs === 2;
    const c02Rows = survivingRows(get("c02-kill-inside-put-before-commit"));
    if (c02Rows) {
      criteria.c03_control_discriminates_commit_from_kill_timing =
        c03Rows.checkpoints > c02Rows.checkpoints;
    }
  }

  const c04Rows = survivingRows(get("c04-kill-inside-putwrites-before-commit"));
  if (c04Rows) {
    criteria.c04_multirow_putwrites_left_no_partial_write_set = c04Rows.writes === 0;
  }

  const c05 = get("c05-nonatomic-writer-control");
  if (c05) {
    const rows = survivingRows(c05);
    const stranded = strandedCount(c05);
    // Stated in the POSITIVE direction on purpose: this control is expected to
    // FAIL to be atomic, and it is the case that would fail if the detector were
    // blind. "Zero stranded references" here would be the bug.
    criteria.c05_nonatomic_control_left_a_checkpoint_row = (rows?.checkpoints ?? 0) === 1;
    criteria.c05_nonatomic_control_left_its_blob_unwritten = (rows?.blobs ?? -1) === 0;
    criteria.c05_partial_state_was_detectable = stranded > 0;
  }

  const c10 = get("c10-nonatomic-writer-blob-first-control");
  if (c10) {
    const rows = survivingRows(c10);
    const reach = c10.projection?.reachability as { orphanBlobs?: unknown[] } | undefined;
    // The VENDOR's statement order: blobs land, the checkpoint row does not.
    // This is the partial state a torn `put()` would actually leave, and it is
    // the shape c01/c02 need a detector for — c05 proves the opposite shape.
    criteria.c10_blob_first_control_left_its_blob = (rows?.blobs ?? 0) === 1;
    criteria.c10_blob_first_control_left_no_checkpoint_row = (rows?.checkpoints ?? -1) === 0;
    criteria.c10_orphan_blobs_were_detectable =
      Array.isArray(reach?.orphanBlobs) && reach.orphanBlobs.length === 1;
    // And no stranded reference, because no checkpoint survives to strand one.
    criteria.c10_blob_first_partial_state_is_a_different_shape_from_c05 =
      strandedCount(c10) === 0;
  }
  if (c05 && c10) {
    // The pair is the point: the detector sees BOTH partial shapes, so c01/c02
    // finding nothing is a result about the vendor rather than about the
    // projection's blind spots.
    criteria.c10_the_detector_sees_both_partial_write_shapes =
      strandedCount(c05) > 0 && (survivingRows(c10)?.blobs ?? 0) === 1;
  }

  const c06 = get("c06-pool-max1-serialization");
  if (c06) {
    const result = liveResults(c06)[0];
    criteria.c06_starved_pool_completed_every_operation =
      Number(result?.fulfilled ?? -1) === Number(result?.operations ?? -2) &&
      Number(result?.operations ?? 0) > 0;
    criteria.c06_starved_pool_used_a_single_backend =
      Number(result?.backendsObserved ?? -1) === 1;
    criteria.c06_starved_pool_raised_no_idle_client_error =
      Array.isArray(result?.idleErrors) && (result.idleErrors as unknown[]).length === 0;
  }

  const c07 = get("c07-role-connection-limit");
  if (c07) {
    const result = liveResults(c07)[0];
    const codes = (result?.refusalCodes as string[] | undefined) ?? [];
    criteria.c07_connections_were_accepted_up_to_the_limit =
      Number(result?.accepted ?? -1) === Number(result?.limit ?? -2);
    criteria.c07_excess_connections_were_refused = Number(result?.refused ?? 0) > 0;
    // Loud and named. An anonymous timeout or a null code would mean the failure
    // mode is a hang, which is the thing the architecture cannot tolerate.
    criteria.c07_refusal_named_a_single_sqlstate =
      codes.length === 1 && /^[0-9A-Z]{5}$/.test(codes[0] ?? "");
  }

  const c08 = get("c08-lock-wait-on-conflicting-put");
  const c08Graphs = c08?.coordination?.lockGraphs ?? [];
  if (c08 && c08Graphs.length > 0) {
    const graph = c08Graphs[0]!.graph;
    criteria.c08_lock_edge_captured_while_the_holder_was_parked = graph.edgeCount >= 1;
    criteria.c08_lock_edge_attributed_to_participants = graph.unattributedBackends === 0;
    criteria.c08_lock_edge_has_no_self_edges = graph.selfEdges === 0;
    criteria.c08_lock_oracles_agree = graph.oraclesAgree === true;
    criteria.c08_both_writers_completed_after_the_lock_was_released =
      liveResults(c08).length === c08.workers.length &&
      liveResults(c08).every((result) => result.error === null);
  }

  const c09 = get("c09-delete-thread-versus-open-write");
  if (c09) {
    const results = liveResults(c09);
    const writer = results.find((result) => result.role === "writer");
    const deleter = results.find((result) => result.role === "deleter");
    const thread = threadOf(c09);
    const reach = c09.projection?.reachability as
      | { brokenLineage?: unknown[]; strandedReferences?: unknown[] }
      | undefined;
    criteria.c09_delete_and_write_both_returned =
      writer?.error === null && deleter?.error === null;
    criteria.c09_ordering_was_enforced_not_raced =
      (c09.coordination?.barriers ?? []).some((stage) => stage.name === "deleted");
    // The writer's transaction is atomic, so its own rows survive as a set.
    criteria.c09_writers_own_rows_survived_as_a_set =
      (thread?.checkpoints?.length ?? 0) === 1 && strandedCount(c09) === 0;
    // Reported, not asserted in a direction: whether the survivor points at a
    // parent the delete removed IS the finding.
    // Was `Array.isArray(...)` — true whether the projection found one broken
    // link or none, so §8.4's headline (`deleteThread` can strand a surviving
    // checkpoint's parent) rested on no criterion at all. The ordering is
    // barrier-enforced, so the count is deterministic and can be asserted.
    criteria.c09_delete_stranded_exactly_one_parent_link =
      Array.isArray(reach?.brokenLineage) && reach.brokenLineage.length === 1;
  }

  return criteria;
}

/**
 * Family D, first slice: Store setup, lifecycle, CRUD and schema.
 *
 * Three criteria state a defect POSITIVELY, which is deliberate. d06 asserts
 * that a rejected `put()` committed its value and dropped the item's index, and
 * d12 asserts that the pgvector extension does not live in the Store's schema.
 * Those are the findings; writing them as "must not happen" would make a passing
 * run mean the measurement failed, and a reproducible negative is a result.
 *
 * Where the outcome genuinely varies — which of two racing writers owns the
 * surviving row, whether a delete beat a put — the criterion asserts the
 * invariant and the outcome is reported instead of gated.
 */
function familyDCriteria(bundles: Map<string, CaseBundle>): Record<string, boolean> {
  const criteria: Record<string, boolean> = {};
  const get = (id: string) => bundles.get(id);
  const only = (id: string): Findings | undefined => liveResults(get(id))[0];

  const contiguous = (ledger: number[] | undefined): boolean =>
    Array.isArray(ledger) && ledger.length > 0 && ledger.every((v, index) => v === index);

  const d01 = only("d01-store-explicit-start-baseline");
  if (d01) {
    criteria.d01_explicit_start_raised_nothing =
      d01.error === null && d01.putError === null && d01.deleteError === null;
    criteria.d01_store_ledger_is_contiguous = contiguous(d01.ledger as number[] | undefined);
    criteria.d01_explicit_start_ran_no_migrations_during_operations =
      d01.migrationStatementsDuringOperations === 0;
    // Not the authored order, and not alphabetical either: JSONB compares key
    // LENGTH before bytes, so "title" (5) precedes "marker" (6). d10 pins that
    // rule down directly; this is the baseline fact it explains.
    criteria.d01_crud_round_trip_returned_the_written_value =
      d01.valueRoundTripped === '{"title":"alpha","marker":"baseline"}';
    criteria.d01_delete_removed_the_item = d01.getAfterDeleteWasNull === true;
  }

  const d02 = only("d02-store-lazy-first-operation");
  if (d02) {
    criteria.d02_lazy_first_operation_completed =
      d02.putError === null && d02.deleteError === null;
    criteria.d02_lazy_setup_ran_migrations_during_the_operation =
      Number(d02.migrationStatementsDuringOperations ?? 0) > 0;
    if (d01) {
      criteria.d02_lazy_terminal_ledger_matches_the_explicit_baseline = eq(d02.ledger, d01.ledger);
      // The discriminator: both complete, so only WHERE the migrations ran
      // separates lazy setup from an awaited one.
      criteria.d02_control_discriminates_lazy_from_explicit_start =
        Number(d02.migrationStatementsDuringOperations ?? -1) >
          Number(d01.migrationStatementsDuringOperations ?? -1) &&
        d01.migrationStatementsDuringOperations === 0;
    }
  }

  const d03 = only("d03-store-use-after-stop");
  if (d03) {
    const attempts = (d03.operationsAfterStop as Array<{ error: unknown }> | undefined) ?? [];
    // Anti-vacuity: the write from before stop() must be there, or "every
    // operation failed" would be satisfied by a Store that never worked.
    criteria.d03_write_before_stop_survived = Number(d03.itemsSurviving ?? -1) === 1;
    criteria.d03_every_operation_after_stop_failed =
      attempts.length === 4 && d03.everyOperationAfterStopFailed === true;
    criteria.d03_every_failure_after_stop_was_reported =
      attempts.length > 0 && attempts.every((attempt) => attempt.error !== null);
    // Recorded, not asserted in a direction: whether a closed Store names itself
    // with a SQLSTATE at all is the finding.
    criteria.d03_closed_store_error_class_was_determined =
      Array.isArray(d03.sqlstatesAfterStop) && (d03.sqlstatesAfterStop as unknown[]).length > 0;
    criteria.d03_second_stop_did_not_raise = d03.secondStopRaised === false;
  }

  const d04 = only("d04-store-ensure-tables-false-cold");
  const d04Bundle = get("d04-store-ensure-tables-false-cold");
  if (d04) {
    const storeRelations = relationsIn(d04Bundle, "lg_store.");
    criteria.d04_cold_ensure_tables_false_refused_its_operations =
      d04.operationsSucceeded === false &&
      (d04.putError as { code?: string } | null)?.code !== undefined;
    criteria.d04_cold_ensure_tables_false_created_no_tables =
      (d04.ledger as number[] | undefined)?.length === 0 && storeRelations.length === 0;
    criteria.d04_cold_ensure_tables_false_issued_no_migration_statement =
      d04.migrationStatements === 0;
  }

  const d05 = only("d05-store-ensure-tables-false-migrated");
  if (d05) {
    criteria.d05_migrated_ensure_tables_false_completed_every_operation =
      d05.operationsSucceeded === true;
    criteria.d05_migrated_ensure_tables_false_issued_no_migration_statement =
      d05.migrationStatements === 0;
    if (d04) {
      criteria.d05_control_discriminates_a_cold_schema_from_a_migrated_one =
        d04.operationsSucceeded === false && d05.operationsSucceeded === true;
    }
  }

  const d06 = only("d06-put-failure-leaves-committed-row");
  if (d06) {
    criteria.d06_first_put_indexed_the_item = Number(d06.firstPutIndexed ?? -1) === 1;
    criteria.d06_second_put_was_rejected =
      d06.secondPutRejected === true && d06.secondPutError !== null;
    // The finding, stated positively: the caller saw a failure and the value
    // changed anyway, because the row upsert had already autocommitted.
    criteria.d06_rejected_put_committed_its_value = d06.markerAfterSecondPut === "second";
    criteria.d06_rejected_put_left_the_item_unindexed =
      Number(d06.vectorsAfterSecondPut ?? -1) === 0 && Number(d06.unindexedItems ?? -1) === 1;
    criteria.d06_item_remained_readable = d06.itemStillReadable === true;
  }

  const d07 = only("d07-put-success-indexes-control");
  if (d07) {
    const texts = (d07.vectorTextsAfterSecondPut as string[] | undefined) ?? [];
    criteria.d07_control_second_put_succeeded = d07.secondPutRejected === false;
    criteria.d07_control_left_the_item_indexed_on_the_new_value =
      Number(d07.vectorsAfterSecondPut ?? -1) === 1 && texts.includes("beta");
    if (d06) {
      // Without this, d06's empty vector set could be the fixture rather than
      // the failure: it proves the second put normally re-indexes.
      criteria.d07_control_discriminates_the_failure_from_the_fixture =
        Number(d06.vectorsAfterSecondPut ?? -1) === 0 &&
        Number(d07.vectorsAfterSecondPut ?? -1) === 1;
    }
  }

  const d08 = get("d08-concurrent-put-same-key");
  const d08Barrier = d08?.coordination?.barriers?.[0];
  if (d08 && d08Barrier) {
    const witness = storeConflictOf(d08);
    criteria.d08_both_writers_were_released_together =
      d08Barrier.allArrivedBeforeRelease === true &&
      d08Barrier.peakConcurrentParties >= d08Barrier.partiesExpected &&
      d08Barrier.distinctNonces === d08Barrier.partiesExpected;
    criteria.d08_seed_item_existed_before_the_race =
      Number((d08.prepare as { seededVectors?: number } | null)?.seededVectors ?? 0) > 0;
    criteria.d08_every_writer_outcome_is_classified =
      liveResults(d08).length === d08.workers.length &&
      liveResults(d08).every((result) => "error" in result && "owner" in result);
    criteria.d08_one_item_row_survived = witness?.itemRows === 1;
    // The FK is ON DELETE CASCADE, so a vector without its item would mean the
    // constraint did not hold. That is a fault, not a race outcome.
    criteria.d08_no_vector_row_outlived_its_item = witness?.orphanVectors === 0;
    criteria.d08_surviving_value_belongs_to_a_writer_rather_than_the_seed =
      witness?.itemOwner === "p0" || witness?.itemOwner === "p1";
    // Reported, not asserted in a direction. Unlike the checkpointer's split,
    // which the conflict clauses force, this one is decided by ordering alone.
    criteria.d08_value_and_vector_ownership_was_determined =
      witness !== undefined && "itemOwnerEqualsVectorOwner" in witness;
  }

  const d09 = get("d09-concurrent-put-and-delete");
  const d09Barrier = d09?.coordination?.barriers?.[0];
  if (d09 && d09Barrier) {
    const witness = storeConflictOf(d09);
    const store = storeOf(d09);
    criteria.d09_both_parties_were_released_together =
      d09Barrier.allArrivedBeforeRelease === true &&
      d09Barrier.peakConcurrentParties >= d09Barrier.partiesExpected;
    criteria.d09_every_outcome_is_classified =
      liveResults(d09).length === d09.workers.length &&
      liveResults(d09).every((result) => "error" in result && "role" in result);
    criteria.d09_no_vector_row_outlived_its_item = witness?.orphanVectors === 0;
    // Both a surviving row and no row are legitimate outcomes of the ordering,
    // so the invariant is bounded rather than fixed.
    criteria.d09_terminal_item_count_is_bounded =
      Number(witness?.itemRows ?? -1) >= 0 && Number(witness?.itemRows ?? -1) <= 1;
    criteria.d09_store_projection_is_internally_consistent =
      (store?.unindexedItems?.length ?? 0) <= Number(witness?.itemRows ?? 0);
  }

  const d10 = only("d10-value-serialization-boundaries");
  if (d10) {
    const rows = (d10.cases as Array<Record<string, unknown>> | undefined) ?? [];
    const row = (name: string) => rows.find((entry) => entry.name === name);
    const errorOf = (name: string) => row(name)?.error as { code?: string; name?: string } | null;

    criteria.d10_every_case_matched_its_authored_expectation =
      rows.length > 0 && Number(d10.matched ?? -1) === Number(d10.total ?? -2);
    criteria.d10_the_full_boundary_table_was_exercised = rows.length === 9;
    // The four the architecture actually has to plan around.
    criteria.d10_undefined_keys_were_dropped =
      row("undefined-keys-are-dropped")?.storedText === '{"b": 1}';
    criteria.d10_non_finite_numbers_became_null =
      row("non-finite-numbers-become-null")?.storedText === '{"i": null, "m": null, "n": null}';
    criteria.d10_a_date_did_not_round_trip_as_a_date =
      (row("date-becomes-a-string")?.roundTrippedTypes as Record<string, string> | null)?.d ===
      "string";
    // Neither authored nor alphabetical order survives, which matters because
    // the runtime stores structured state here and cannot rely on either.
    criteria.d10_jsonb_key_order_is_length_then_bytewise =
      row("jsonb-key-order-is-length-then-bytewise")?.storedText === '{"z": 1, "aa": 2}';
    // A six-character literal comes back as 309 digits: the value is preserved,
    // its representation is not.
    criteria.d10_a_large_float_was_re_rendered_positionally =
      typeof row("large-finite-float-survives")?.storedText === "string" &&
      (row("large-finite-float-survives")?.storedText as string).length === 316;
    criteria.d10_a_nul_byte_was_rejected_by_postgres = errorOf("nul-byte-is-rejected")?.code === "22P05";
    // Rejected with no SQLSTATE: it never reached the database at all.
    criteria.d10_a_bigint_was_rejected_before_reaching_sql =
      row("bigint-is-rejected-before-sql")?.rejected === true &&
      (errorOf("bigint-is-rejected-before-sql")?.code ?? null) === null;
  }

  const d11 = only("d11-schema-isolation-two-stores");
  if (d11) {
    criteria.d11_both_schemas_migrated_independently =
      contiguous(d11.ledgerA as number[] | undefined) &&
      contiguous(d11.ledgerB as number[] | undefined);
    criteria.d11_each_schema_returned_its_own_value =
      d11.markerA === "schema-a" && d11.markerB === "schema-b";
    criteria.d11_each_schema_holds_exactly_one_item =
      Number(d11.itemsA ?? -1) === 1 && Number(d11.itemsB ?? -1) === 1;
    // Read from the tables rather than through either API, which would return
    // the value it had just written regardless of isolation.
    criteria.d11_stored_values_differ_across_schemas =
      d11.valuesAreDistinctAcrossSchemas === true;
  }

  const d12 = only("d12-vector-extension-placement");
  if (d12) {
    criteria.d12_vector_extension_placement_was_determined =
      typeof d12.vectorExtensionSchema === "string" && d12.vectorExtensionSchema.length > 0;
    // Stated positively: the extension is NOT in the Store's schema, so the
    // Store's schema is not self-contained. That is the finding.
    criteria.d12_vector_extension_is_not_in_the_store_schema =
      d12.extensionIsInStoreSchema === false;
    criteria.d12_vector_column_type_resolves_outside_the_store_schema =
      typeof d12.vectorTypeSchema === "string" && d12.vectorTypeSchema !== "lg_store";
    criteria.d12_restricted_search_path_outcome_was_determined =
      typeof d12.restrictedSetupSucceeded === "boolean";
  }

  const d13 = only("d13-index-metric-config-change");
  if (d13) {
    criteria.d13_ledger_unchanged_after_a_metric_change = d13.ledgerUnchanged === true;
    criteria.d13_index_set_unchanged_after_a_metric_change = d13.indexesUnchanged === true;
    criteria.d13_second_setup_created_no_index = d13.migrationsRunOnSecondSetup === 0;
    // The consequence: the metric the Store is now configured for has no index
    // at all, and nothing anywhere says so.
    criteria.d13_configured_metric_has_no_index = d13.configuredMetricHasNoIndex === true;
    criteria.d13_write_path_ignored_the_mismatch = d13.putSucceededDespiteMismatch === true;
  }

  return criteria;
}

/**
 * Family D, second slice: batch, pool and TTL.
 *
 * Several criteria again state a defect positively — a batch commits its prefix,
 * an unrelated caller is rejected, `ttl: 0` never expires, a read shortens the
 * item it read. Those are the findings, and writing them as prohibitions would
 * make a passing run mean the measurement failed.
 *
 * d18 is the exception that needs care: "did not settle" is the expected
 * outcome, so the criterion asserts the BOUND was reached and the controls carry
 * the discrimination. A hang asserted as a pass would otherwise be
 * indistinguishable from a worker that never started.
 */
function familyDBatchCriteria(bundles: Map<string, CaseBundle>): Record<string, boolean> {
  const criteria: Record<string, boolean> = {};
  const get = (id: string) => bundles.get(id);
  const only = (id: string): Findings | undefined => liveResults(get(id))[0];

  const d14 = only("d14-batch-read-your-writes");
  if (d14) {
    criteria.d14_batch_get_saw_the_preceding_put = d14.firstGetSawFirstPut === true;
    criteria.d14_batch_get_saw_the_second_put = d14.secondGetSawSecondPut === true;
    criteria.d14_batch_left_the_last_written_value = d14.terminalMarker === true;
  }

  const d15 = only("d15-batch-partial-commit-on-failure");
  if (d15) {
    criteria.d15_batch_reported_failure_to_its_caller = d15.batchRejected === true;
    // The finding: no BEGIN anywhere, so the prefix is already committed when
    // the middle operation throws.
    criteria.d15_operation_before_the_failure_was_committed =
      d15.operationBeforeTheFailureCommitted === true;
    criteria.d15_operation_after_the_failure_never_ran =
      d15.operationAfterTheFailureDidNotRun === true;
  }

  const d16 = only("d16-convenience-path-error-isolation-control");
  if (d16) {
    criteria.d16_convenience_failure_was_isolated_to_its_own_call =
      d16.failureWasIsolatedToItsOwnCall === true;
    criteria.d16_convenience_call_after_the_failure_still_ran =
      d16.operationAfterTheFailureRan === true;
    if (d15) {
      // The pair is the point: identical writes, identical invalid operation,
      // opposite consequences for everything downstream of it.
      criteria.d16_control_discriminates_batch_from_the_convenience_path =
        d15.operationAfterTheFailureDidNotRun === true && d16.operationAfterTheFailureRan === true;
    }
  }

  const d17 = only("d17-async-batched-store-rejection-fanout");
  if (d17) {
    const outcomes = (d17.outcomes as Array<{ name: string; rejected: boolean }> | undefined) ?? [];
    criteria.d17_all_four_callers_were_coalesced_into_one_batch = outcomes.length === 4;
    // Stated positively: one invalid operation rejects callers that had nothing
    // to do with it. That is the architecture-relevant behaviour.
    criteria.d17_unrelated_callers_were_rejected =
      Number(d17.validCallersRejected ?? 0) > 0;
    // Was a presence check. The finding — two callers received a rejection for a
    // write that is durable — is deterministic (`processBatchQueue` rejects the
    // whole coalesced batch) and must be asserted, not merely collected.
    criteria.d17_two_callers_were_told_a_committed_write_had_failed =
      Array.isArray(d17.callersToldItFailedButCommitted) &&
      d17.callersToldItFailedButCommitted.length === 2;
  }

  const d18 = only("d18-batch-search-nested-acquisition");
  const d19 = only("d19-batch-search-nested-acquisition-max2-control");
  const d20 = only("d20-batch-search-indexed-shares-client-control");
  if (d18) {
    // Recorded, not asserted in a direction. The bound having been reached at
    // all is what makes the answer trustworthy either way.
    criteria.d18_nested_acquisition_outcome_was_determined =
      typeof d18.settledWithinBound === "boolean" && Number(d18.boundMs ?? 0) > 0;
  }
  if (d19) {
    criteria.d19_the_same_batch_completed_through_a_larger_pool =
      d19.settledWithinBound === true && d19.batchError === null;
  }
  if (d20) {
    criteria.d20_the_indexed_path_completed_through_a_pool_of_one =
      d20.settledWithinBound === true && d20.batchError === null;
  }
  if (d18 && d19) {
    // The discriminator that turns "it hung" into "it hung BECAUSE the search
    // acquired a second connection while the batch held the only one".
    criteria.d19_control_attributes_the_hang_to_the_pool_ceiling =
      d18.settledWithinBound === false && d19.settledWithinBound === true;
  }
  if (d18 && d20) {
    criteria.d20_control_attributes_the_hang_to_the_unindexed_text_search_branch =
      d18.settledWithinBound === false && d20.settledWithinBound === true;
  }

  const d21 = only("d21-store-pool-max1-serialization");
  if (d21) {
    criteria.d21_starved_store_pool_completed_every_operation =
      Number(d21.fulfilled ?? -1) === Number(d21.operations ?? -2) &&
      Number(d21.operations ?? 0) > 0;
    criteria.d21_starved_store_pool_used_a_single_backend =
      Number(d21.backendsObserved ?? -1) === 1;
    criteria.d21_starved_store_pool_wrote_every_item =
      Number(d21.itemsWritten ?? -1) === Number(d21.operations ?? -2);
    if (d18) {
      // Without this, d18's hang could be blamed on `max: 1` by itself.
      criteria.d21_control_shows_a_pool_of_one_does_not_hang_on_its_own =
        d18.settledWithinBound === false && Number(d21.fulfilled ?? 0) === 6;
    }
  }

  const d22 = only("d22-ttl-zero-and-negative");
  if (d22) {
    // The inversion, stated positively: asking for a zero-minute lifetime
    // produces an item that never expires.
    criteria.d22_zero_ttl_produced_no_expiry_at_all = d22.zeroTtlProducedNoExpiry === true;
    criteria.d22_zero_ttl_item_is_readable = d22.zeroTtlItemIsReadable === true;
    criteria.d22_negative_ttl_produced_an_already_past_expiry =
      d22.negativeTtlProducedAPastExpiry === true;
    criteria.d22_negative_ttl_item_is_not_readable = d22.negativeTtlItemIsReadable === false;
    // Anti-vacuity: a positive ttl must land in the future, or "zero produced
    // no expiry" would be satisfied by a Store that ignores ttl entirely.
    criteria.d22_positive_ttl_produced_a_future_expiry =
      d22.positiveTtlProducedAFutureExpiry === true;
  }

  const d23 = only("d23-ttl-refresh-on-read-uses-the-default");
  const d24 = only("d24-ttl-refresh-without-a-default-control");
  if (d23) {
    criteria.d23_read_issued_an_update_statement =
      Number(d23.updateStatementsOnRead ?? 0) > 0;
    criteria.d23_read_changed_the_expiry = d23.expiryChangedOnRead === true;
    // The finding: refresh recomputes from defaultTtl and ignores the ttl the
    // item was written with, so reading a long-lived item shortens it.
    criteria.d23_read_moved_the_expiry_earlier = d23.expiryMovedEarlier === true;
    criteria.d23_item_remained_readable_after_the_refresh = d23.itemWasReadable === true;
  }
  if (d24) {
    criteria.d24_refresh_without_a_default_issued_no_update =
      Number(d24.updateStatementsOnRead ?? -1) === 0;
    criteria.d24_refresh_without_a_default_left_the_expiry_untouched =
      d24.expiryChangedOnRead === false;
  }
  if (d23 && d24) {
    criteria.d24_control_attributes_the_refresh_to_the_configured_default =
      d23.expiryChangedOnRead === true && d24.expiryChangedOnRead === false;
  }

  const d25 = only("d25-manual-sweep-and-statistics");
  if (d25) {
    const before = d25.statsBefore as { total?: number; expired?: number } | undefined;
    criteria.d25_stats_agreed_with_the_table = d25.statsAgreedWithTheTableBefore === true;
    // Expired rows are still rows: get() filters them, nothing removes them
    // until a sweep, and getStats counts them in its total.
    criteria.d25_expired_rows_were_counted_before_the_sweep =
      Number(before?.expired ?? 0) === 4 && Number(before?.total ?? 0) === 7;
    criteria.d25_sweep_removed_exactly_the_expired_rows =
      d25.sweptExactlyTheExpiredRows === true;
    criteria.d25_live_rows_survived_the_sweep = Number(d25.liveRowsSurvived ?? -1) === 3;
    criteria.d25_no_expired_row_remained = Number(d25.deadRowsRemaining ?? -1) === 0;
  }

  const d26 = get("d26-concurrent-sweepers");
  const d26Barrier = d26?.coordination?.barriers?.[0];
  if (d26 && d26Barrier) {
    const results = liveResults(d26);
    const counts = results.map((result) => Number(result.swept ?? -1));
    const seeded = Number((d26.prepare as { seededExpired?: number } | null)?.seededExpired ?? -1);
    const store = storeOf(d26);
    criteria.d26_both_sweepers_were_released_together =
      d26Barrier.allArrivedBeforeRelease === true &&
      d26Barrier.peakConcurrentParties >= d26Barrier.partiesExpected;
    criteria.d26_fixture_seeded_expired_rows = seeded === 6;
    criteria.d26_every_sweeper_outcome_is_classified =
      results.length === d26.workers.length && results.every((result) => "swept" in result);
    criteria.d26_no_sweeper_raised = results.every((result) => result.error === null);
    // The invariant, not the split: how the six rows divide between the two
    // sweepers is an interleaving outcome and is reported, but the total must
    // be exactly the number of expired rows — nothing swept twice, none left.
    criteria.d26_sweep_counts_sum_to_the_expired_rows =
      counts.length > 0 && counts.every((count) => count >= 0) &&
      counts.reduce((total, count) => total + count, 0) === seeded;
    criteria.d26_live_row_survived_both_sweepers =
      (store?.items ?? []).some((row) => row.key === "live-0");
    criteria.d26_no_expired_row_survived = (store?.stats?.expired ?? -1) === 0;
  }

  return criteria;
}

/**
 * Family D, third slice: namespaces, pagination and filters.
 *
 * The fail-open criteria are the ones to read carefully. "Every row came back"
 * is asserted as the measured behaviour, with a restrictive filter over the same
 * corpus asserted beside it — otherwise a corpus small enough to be returned
 * whole would satisfy the claim without the filter having been dropped at all.
 */
function familyDQueryCriteria(bundles: Map<string, CaseBundle>): Record<string, boolean> {
  const criteria: Record<string, boolean> = {};
  const get = (id: string) => bundles.get(id);
  const only = (id: string): Findings | undefined => liveResults(get(id))[0];

  const d27 = only("d27-namespace-validation-matrix");
  if (d27) {
    const rows = (d27.cases as Array<Record<string, unknown>> | undefined) ?? [];
    criteria.d27_every_namespace_shape_matched_its_authored_expectation =
      rows.length === 10 && Number(d27.matched ?? -1) === Number(d27.total ?? -2);
    // Both stated positively, because both are the finding.
    criteria.d27_the_join_delimiter_is_an_accepted_label_character =
      d27.colonAccepted === true;
    criteria.d27_an_ordinary_underscore_is_rejected = d27.underscoreRejected === true;
  }

  const d28 = only("d28-namespace-delimiter-collision");
  if (d28) {
    criteria.d28_two_distinct_namespaces_collapsed_to_one_row =
      d28.bothNamespacesResolvedToOneRow === true && Number(d28.storedRows ?? -1) === 1;
    criteria.d28_a_write_under_one_namespace_was_readable_under_the_other =
      d28.readingTheOtherNamespaceReturnedTheOverwrite === true;
    criteria.d28_namespace_round_trip_identity_does_not_hold =
      d28.markerViaJoinedNamespace === d28.markerViaSplitNamespace;
  }

  const d29 = only("d29-namespace-prefix-boundary");
  if (d29) {
    criteria.d29_prefix_match_crossed_the_namespace_boundary =
      d29.unrelatedSiblingMatchedThePrefix === true;
    criteria.d29_search_used_the_same_string_prefix_rule =
      d29.searchAlsoCrossedTheBoundary === true;
    // Anti-vacuity: a deeper, exact prefix must still be exact, or "prefixes
    // over-match" would be satisfied by prefixes not working at all.
    criteria.d29_a_deeper_prefix_was_still_exact = d29.deeperPrefixWasExact === true;
  }

  const d30 = only("d30-list-namespaces-maxdepth-after-limit");
  if (d30) {
    criteria.d30_small_limit_with_maxdepth_returned_an_empty_page =
      d30.smallLimitReturnedNothing === true;
    criteria.d30_the_matching_namespace_exists_at_a_larger_limit =
      d30.largeLimitFoundTheDepthOneNamespace === true;
    criteria.d30_the_same_limit_without_maxdepth_returned_a_full_page =
      d30.sameLimitWithoutMaxDepthReturnedAFullPage === true;
  }

  const d31 = only("d31-list-namespaces-skips-validation");
  if (d31) {
    criteria.d31_list_namespaces_accepted_a_wildcard_prefix =
      d31.listNamespacesAcceptedTheWildcard === true;
    criteria.d31_the_wildcard_returned_every_tenant = d31.wildcardCrossedTenants === true;
    // The asymmetry is the finding: the same input, refused by every other path.
    criteria.d31_search_refused_the_same_wildcard = d31.searchRejectedTheWildcard === true;
    criteria.d31_put_refused_the_same_wildcard = d31.putRejectedTheWildcard === true;
  }

  const d32 = only("d32-list-namespaces-pagination-control");
  if (d32) {
    criteria.d32_pages_were_full = d32.pagesAreFull === true;
    criteria.d32_pages_were_disjoint = d32.pagesAreDisjoint === true;
    criteria.d32_pages_covered_the_whole_set = d32.pagesCoverTheSet === true;
  }

  const d33 = only("d33-filter-matrix");
  if (d33) {
    const rows = (d33.cases as Array<Record<string, unknown>> | undefined) ?? [];
    const row = (name: string) => rows.find((entry) => entry.name === name);
    criteria.d33_every_filter_matched_its_authored_expectation =
      rows.length > 0 && Number(d33.matched ?? -1) === Number(d33.total ?? -2);
    criteria.d33_the_full_filter_matrix_was_exercised = rows.length === 13;
    // Three named because the architecture has to plan around them.
    criteria.d33_ne_excluded_rows_that_do_not_have_the_key =
      (row("ne-excludes-rows-missing-the-key")?.actual as string[] | undefined)?.join(",") ===
      "f1,f3,f4";
    criteria.d33_a_nested_object_filter_is_containment_not_equality =
      (row("nested-object-is-containment-not-equality")?.actual as string[] | undefined)?.join(
        ",",
      ) === "f1,f2";
    criteria.d33_numeric_operators_compared_numerically =
      (row("gt")?.actual as string[] | undefined)?.join(",") === "f3,f4";
  }

  const d34 = only("d34-filter-fail-open");
  if (d34) {
    const rows = (d34.cases as Array<Record<string, unknown>> | undefined) ?? [];
    criteria.d34_all_three_unsupported_filters_were_exercised = rows.length === 3;
    // Stated positively: the filter was dropped and every row was returned.
    criteria.d34_unsupported_filters_returned_every_row =
      d34.allThreeReturnedEverything === true;
    criteria.d34_unsupported_filters_raised_nothing = d34.noneRaised === true;
    // The control that makes the above mean "the filter was dropped" rather
    // than "the corpus is what a filter returns".
    criteria.d34_a_restrictive_filter_over_the_same_corpus_still_restricts =
      d34.restrictiveFilterStillRestricts === true;
  }

  const d35 = only("d35-filter-null-and-array-values");
  if (d35) {
    criteria.d35_a_null_filter_value_matched_nothing = d35.nullFilterMatchedNothing === true;
    criteria.d35_an_array_filter_value_matched_nothing = d35.arrayFilterMatchedNothing === true;
    // Anti-vacuity on both: the rows are demonstrably there.
    criteria.d35_the_row_holding_a_json_null_exists =
      ((d35.rowsWithNullKeyExist as string[] | undefined) ?? []).includes("has-json-null");
    criteria.d35_the_row_holding_an_array_exists =
      ((d35.rowsWithArrayKeyExist as string[] | undefined) ?? []).includes("has-array");
  }

  const d36 = only("d36-filter-numeric-cast-on-mixed-types");
  if (d36) {
    criteria.d36_a_numeric_filter_over_mixed_types_failed_the_whole_query =
      d36.numericFilterRaised === true;
    criteria.d36_the_failure_named_a_sqlstate =
      typeof d36.numericFilterSqlstate === "string" &&
      /^[0-9A-Z]{5}$/.test(String(d36.numericFilterSqlstate));
    // The discriminator: the same key, filtered without a cast, still works.
    criteria.d36_an_equality_filter_on_the_same_key_still_worked =
      d36.wholeQueryFailedNotJustTheRow === true;
  }

  return criteria;
}

/**
 * Family D, fourth slice: text, vector and hybrid search.
 *
 * The inner-product case is the one that needs stating carefully. Its criterion
 * asserts that the ordering was DETERMINED against the authored oracle — not
 * that it matched — because whether the ranking is correct is the measurement.
 * A separate criterion records whether it came back exactly reversed, which is
 * what distinguishes a sign convention from a broken query, and the reversal
 * itself is reported rather than gated.
 */
function familyDSearchCriteria(bundles: Map<string, CaseBundle>): Record<string, boolean> {
  const criteria: Record<string, boolean> = {};
  const get = (id: string) => bundles.get(id);
  const only = (id: string): Findings | undefined => liveResults(get(id))[0];

  const d37 = only("d37-vector-search-cosine");
  if (d37) {
    criteria.d37_cosine_ranking_matched_the_authored_order = d37.matchedAuthoredOrder === true;
    criteria.d37_cosine_search_returned_the_whole_corpus = d37.returnedTheWholeCorpus === true;
  }

  const d38 = only("d38-vector-search-l2");
  if (d38) {
    criteria.d38_l2_ranking_matched_the_authored_order = d38.matchedAuthoredOrder === true;
    if (d37) {
      // If the two metrics produced the same order, the fixture would not be
      // able to detect a Store that ignored distanceMetric altogether.
      criteria.d38_l2_and_cosine_ordered_the_corpus_differently =
        (d38.actualOrder as string[] | undefined)?.join(",") !==
        (d37.actualOrder as string[] | undefined)?.join(",");
    }
  }

  const d39 = only("d39-vector-search-inner-product");
  if (d39) {
    // Determined, not asserted: whether the ranking agrees with the authored
    // order IS the result.
    criteria.d39_inner_product_ordering_was_determined =
      Array.isArray(d39.actualOrder) && (d39.actualOrder as unknown[]).length > 0;
    criteria.d39_inner_product_returned_the_whole_corpus = d39.returnedTheWholeCorpus === true;
    // Reported as a fact either way; the review carries the interpretation.
    // Was a `typeof === "boolean"` presence check, which would have passed had
    // the ordering silently started matching. The reversal is deterministic —
    // pgvector's `<#>` returns the NEGATIVE inner product and the implementation
    // orders `MIN(<#>)` descending — so it is asserted.
    criteria.d39_inner_product_order_is_exactly_reversed =
      d39.authoredOrderExists === true &&
      d39.matchedAuthoredOrder === false &&
      d39.isExactlyReversed === true;
  }

  const d40 = only("d40-vector-search-thresholds");
  if (d40) {
    criteria.d40_cosine_threshold_selected_the_nearest_items =
      d40.cosineKeptTheTwoNearestItems === true;
    criteria.d40_l2_threshold_selected_a_different_set = d40.l2SelectedADifferentSet === true;
    // Stated positively: this is the finding, not a prohibition.
    criteria.d40_inner_product_threshold_excluded_everything =
      d40.innerProductExcludedEverything === true;
    criteria.d40_without_a_threshold_the_whole_corpus_returned =
      d40.unthresholdedReturnedTheWholeCorpus === true;
  }

  const d41 = only("d41-vector-search-unindexed-item");
  if (d41) {
    criteria.d41_unindexed_item_was_absent_from_vector_search =
      d41.unindexedItemMissingFromVectorSearch === true;
    criteria.d41_the_same_item_was_reachable_by_text_search =
      d41.unindexedItemPresentInTextSearch === true;
    criteria.d41_indexed_items_were_still_returned = d41.indexedItemsStillFound === true;
    criteria.d41_projection_reported_the_item_as_unindexed = (
      (d41.projectedUnindexedItems as string[] | undefined) ?? []
    ).includes("unindexed");
  }

  const d42 = only("d42-vector-search-dimension-mismatch");
  if (d42) {
    criteria.d42_dimension_mismatch_was_rejected = d42.mismatchRejected === true;
    criteria.d42_matching_dimensions_still_worked = d42.controlSucceeded === true;
    // Recorded: a guard ahead of SQL cannot carry a SQLSTATE, which matters to
    // anything trying to classify Store failures by code.
    criteria.d42_dimension_mismatch_error_class_was_determined =
      d42.mismatchError !== null && d42.mismatchError !== undefined;
  }

  const d43 = only("d43-hybrid-search-weights");
  if (d43) {
    criteria.d43_vector_weight_changed_the_ranking = d43.weightChangedTheRanking === true;
    criteria.d43_the_mixed_item_ranked_last_by_vector = d43.mixedRanksLastByVector === true;
    criteria.d43_the_mixed_item_rose_by_text = d43.mixedRanksInTheTopTwoByText === true;
    // Hybrid at full vector weight must reproduce the cosine ordering of the
    // items it shares with d37, or the two paths disagree about the same
    // vectors.
    criteria.d43_full_vector_weight_reproduced_the_cosine_order =
      d43.vectorOnlyMatchedTheCosineOrder === true;
  }

  const d44 = only("d44-text-search-semantics");
  if (d44) {
    criteria.d44_text_search_matched_on_a_value = d44.matchedOnValue === true;
    // Both stated positively: the serialized JSON is what is indexed, so field
    // names are searchable content and a wildcard is not a literal.
    criteria.d44_a_json_field_name_matched_every_item = d44.matchedOnJsonKeyName === true;
    criteria.d44_a_wildcard_shaped_query_matched_every_item =
      d44.wildcardQueryMatchedEverything === true;
    criteria.d44_a_term_appearing_nowhere_matched_nothing = d44.absentTermMatchedNothing === true;
  }

  const d45 = only("d45-search-convenience-versus-batch");
  if (d45) {
    // Scored against the hand-authored fixture, not against the convenience
    // path: two outputs of the same implementation agreeing shows consistency,
    // not correctness.
    criteria.d45_batched_search_produced_the_authored_cosine_order =
      d45.authoredCosineExists === true && d45.batchMatchedTheAuthoredCosineOrder === true;
    criteria.d45_batched_search_cannot_express_the_l2_ordering =
      d45.batchCannotExpressTheL2Ordering === true;
    // Anti-vacuity: the claim above is empty unless the two metrics really do
    // order this corpus differently.
    criteria.d45_the_two_metrics_order_the_corpus_differently =
      d45.theTwoMetricsOrderDifferently === true;
  }

  return criteria;
}

type NamespaceLineage = {
  shape?: {
    count: number;
    rootPresent: boolean;
    depths: number[];
    maxDepth: number;
    distinct: boolean;
    siblingGroups: number[];
  };
  chains?: Array<{ rows: number; roots: number; leaves: number; danglingParents: number }>;
  crossNamespaceParents?: number;
  interruptsInRootNamespace?: number;
  interruptsInChildNamespace?: number;
};

/** The lineage summary a family E participant computed, by party. */
function lineageOf(bundle: CaseBundle | undefined, party = 0): NamespaceLineage | undefined {
  return resultsOf(bundle).find((result) => result.party === party) as NamespaceLineage | undefined;
}

/** Every chain in every namespace is one unbroken line: one root, one leaf, no gaps. */
function chainsAreWellFormed(lineage: NamespaceLineage | undefined): boolean {
  const chains = lineage?.chains ?? [];
  return (
    chains.length > 0 &&
    chains.every(
      (chain) => chain.rows > 0 && chain.roots === 1 && chain.leaves === 1 && chain.danglingParents === 0,
    )
  );
}

function noStrandedState(bundle: CaseBundle | undefined): boolean {
  const reach = bundle?.projection?.reachability as
    | { strandedReferences?: unknown[]; brokenLineage?: unknown[] }
    | undefined;
  return (
    Array.isArray(reach?.strandedReferences) &&
    reach.strandedReferences.length === 0 &&
    Array.isArray(reach?.brokenLineage) &&
    reach.brokenLineage.length === 0
  );
}

function familyECriteria(bundles: Map<string, CaseBundle>): Record<string, boolean> {
  const criteria: Record<string, boolean> = {};
  const get = (id: string) => bundles.get(id);

  const e01 = get("e01-nested-subgraph-baseline");
  const e01Lineage = lineageOf(e01);
  if (e01) {
    criteria.e01_a_subgraph_creates_its_own_namespace =
      (e01Lineage?.shape?.count ?? 0) >= 2 && e01Lineage?.shape?.rootPresent === true;
    criteria.e01_every_namespace_chain_is_singly_rooted = chainsAreWellFormed(e01Lineage);
    criteria.e01_namespaces_are_distinct = e01Lineage?.shape?.distinct === true;
    // A subgraph checkpoint that named no ancestor would be an island: resumable
    // in isolation but impossible to relate to the run that spawned it.
    criteria.e01_subgraph_checkpoints_name_an_ancestor_run =
      (e01Lineage?.crossNamespaceParents ?? 0) > 0;
    criteria.e01_every_node_executed_exactly_once = ["prepare", "sub_a", "sub_b", "finish"].every(
      (node) => executionOf(e01, node, "executed").executions === 1,
    );
    criteria.e01_run_completed = liveResults(e01)[0]?.runs !== undefined &&
      (liveResults(e01)[0]?.runs as Array<{ error: unknown }>)[0]?.error === null;
    criteria.e01_no_stranded_state = noStrandedState(e01);
  }

  // The control the whole family rests on. Same four node bodies, no subgraph.
  const e02 = get("e02-inlined-graph-control");
  const e02Lineage = lineageOf(e02);
  if (e02) {
    criteria.e02_inlined_graph_produces_exactly_one_namespace =
      e02Lineage?.shape?.count === 1 && e02Lineage?.shape?.rootPresent === true;
    criteria.e02_inlined_graph_has_no_cross_namespace_parents =
      e02Lineage?.crossNamespaceParents === 0;
    criteria.e02_inlined_graph_executed_the_same_node_set = ["prepare", "sub_a", "sub_b", "finish"]
      .every((node) => executionOf(e02, node, "executed").executions === 1);
  }
  if (e01 && e02) {
    // The differential. Without it, "e01 produced extra namespaces" is a fact
    // about that graph rather than evidence about subgraphs.
    criteria.e02_control_isolates_the_subgraph_as_the_cause =
      (e02Lineage?.shape?.count ?? 0) < (e01Lineage?.shape?.count ?? 0);
  }

  const e03 = get("e03-parallel-subgraph-instances");
  const e03Lineage = lineageOf(e03);
  if (e03) {
    // Two instances of ONE compiled subgraph. Three namespaces: root plus one
    // per call site.
    criteria.e03_each_instance_gets_its_own_namespace =
      e03Lineage?.shape?.count === 3 && e03Lineage?.shape?.distinct === true;
    criteria.e03_instances_are_siblings_of_one_parent =
      (e03Lineage?.shape?.siblingGroups ?? []).includes(2);
    criteria.e03_both_instances_executed_their_nodes =
      executionOf(e03, "sub_a", "executed").executions === 2 &&
      executionOf(e03, "sub_b", "executed").executions === 2;
    criteria.e03_every_namespace_chain_is_singly_rooted = chainsAreWellFormed(e03Lineage);
    criteria.e03_no_stranded_state = noStrandedState(e03);
  }

  const e04 = get("e04-subgraph-interrupt-and-resume");
  const e04Lineage = lineageOf(e04);
  if (e04) {
    const runs = (liveResults(e04)[0]?.runs ?? []) as Array<{ error: unknown; interrupted: boolean }>;
    criteria.e04_first_pass_reached_the_subgraph_interrupt = runs[0]?.interrupted === true;
    // CORRECTED after measurement. The authored expectation was that an
    // interrupt raised inside a subgraph is confined to that subgraph's
    // namespace. It is not: the interrupt is written once in the subgraph AND
    // once in the root, because the parent task hosting the subgraph re-raises
    // it as it bubbles up. Anything counting `__interrupt__` rows to decide how
    // many approvals are outstanding would therefore double-count a nested one.
    criteria.e04_interrupt_is_recorded_in_the_subgraph_namespace =
      e04Lineage?.interruptsInChildNamespace === 1;
    criteria.e04_interrupt_also_bubbles_up_to_the_root_namespace =
      e04Lineage?.interruptsInRootNamespace === 1;
    criteria.e04_resume_completed = runs[1]?.error === null && runs[1]?.interrupted === false;
    // The replay is expected; consuming the interrupt twice is not. Two entry
    // records against one resumed record is what separates them.
    criteria.e04_gate_was_replayed_and_consumed_once =
      executionOf(e04, "sub_gate", "entered").executions === 2 &&
      executionOf(e04, "sub_gate", "resumed").executions === 1;
    criteria.e04_no_stranded_state = noStrandedState(e04);
  }

  const e05 = get("e05-subgraph-crash-resume");
  const e05Lineage = lineageOf(e05, 1);
  if (e05) {
    const parks = (e05.projection?.gateParks as Array<{ gate: string }> | undefined) ?? [];
    criteria.e05_victim_parked_inside_a_subgraph_node = parks.some(
      (park) => park.gate === "inside-subgraph-node",
    );
    // A SIGKILL leaves no FIN, so the victim's backend can outlive its container
    // and still hold locks. Projecting before it drains would read a lie.
    criteria.e05_killed_backend_drained_before_projection = e05.drain?.drained === true;
    // The absence of a shutdown row is what proves the kill was uncatchable
    // rather than a tidy stop.
    criteria.e05_kill_was_uncatchable =
      ((e05.projection?.shutdownWitnesses as unknown[] | undefined) ?? []).length === 0;
    criteria.e05_subgraph_node_re_executed_on_a_second_process =
      executionOf(e05, "sub_b", "executed").executions === 2 &&
      executionOf(e05, "sub_b", "executed").processes === 2;
    criteria.e05_resume_completed = liveResults(e05).some((result) => result.completed === true);
    criteria.e05_every_namespace_chain_is_singly_rooted = chainsAreWellFormed(e05Lineage);
    criteria.e05_no_stranded_state = noStrandedState(e05);
  }
  if (e01 && e05) {
    // The crash must not have manufactured a namespace of its own.
    criteria.e05_crash_resume_reused_the_original_namespaces =
      (e05Lineage?.shape?.count ?? -1) === (e01Lineage?.shape?.count ?? -2);
  }

  const e06 = get("e06-nested-depth-two");
  const e06Lineage = lineageOf(e06);
  if (e06) {
    // Depth is containment depth, computed without parsing the vendor's
    // separators: root, one subgraph, one subgraph inside it.
    criteria.e06_nesting_reaches_depth_two = e06Lineage?.shape?.maxDepth === 2;
    criteria.e06_namespace_count_matches_the_topology = e06Lineage?.shape?.count === 3;
    criteria.e06_every_namespace_chain_is_singly_rooted = chainsAreWellFormed(e06Lineage);
    criteria.e06_leaf_node_executed_once =
      executionOf(e06, "leaf_a", "executed").executions === 1;
    criteria.e06_no_stranded_state = noStrandedState(e06);
  }

  const e07 = get("e07-subgraph-pending-write-reuse");
  const e09 = get("e09-root-fanout-pending-write-reuse-control");
  if (e07) {
    const failing = resultsOf(e07).find((result) => result.role === "failing");
    const resuming = resultsOf(e07).find((result) => result.role === "resuming");
    criteria.e07_first_pass_failed_inside_the_subgraph = failing?.failed === true;
    criteria.e07_resume_completed = resuming?.completed === true;
    // CORRECTED after measurement. The authored expectation was Spike 05's
    // root-level result — a sibling whose pending write had landed is reused —
    // and inside a subgraph it does not hold: the completed sibling runs again.
    //
    // The mechanism is `PregelLoop.initialize`, which sets
    // `skipDoneTasks = !("checkpoint_id" in config.configurable)`, a key-presence
    // test. Every task's config is built with `checkpoint_id: undefined`, and a
    // subgraph's loop is initialised FROM a task's config — so the key is there,
    // the loop believes it is an explicit replay, and the block that matches
    // pending writes onto prepared tasks never runs.
    criteria.e07_completed_sibling_was_not_reused_in_a_subgraph =
      executionOf(e07, "sub_fast", "executed").executions === 2 &&
      executionOf(e07, "sub_fast", "executed").processes === 2;
    criteria.e07_failed_sibling_re_executed =
      executionOf(e07, "sub_slow", "executed").executions === 2;
    criteria.e07_no_stranded_state = noStrandedState(e07);
  }

  if (e09) {
    const failing = resultsOf(e09).find((result) => result.role === "failing");
    const resuming = resultsOf(e09).find((result) => result.role === "resuming");
    criteria.e09_first_pass_failed_at_the_root = failing?.failed === true;
    criteria.e09_resume_completed = resuming?.completed === true;
    criteria.e09_completed_sibling_was_reused_at_the_root =
      executionOf(e09, "sub_fast", "executed").executions === 1;
    criteria.e09_failed_sibling_re_executed =
      executionOf(e09, "sub_slow", "executed").executions === 2;
    // The detector works: at the root, reuse and re-execution are visibly
    // different. Without this, e07's "both ran twice" could equally mean the
    // probe cannot tell them apart.
    criteria.e09_reuse_and_re_execution_are_distinguishable =
      executionOf(e09, "sub_fast", "executed").executions !==
      executionOf(e09, "sub_slow", "executed").executions;
    criteria.e09_control_produced_exactly_one_namespace =
      lineageOf(e09, 1)?.shape?.count === 1;
  }

  if (e07 && e09) {
    // The differential, and the whole point of the pair: identical topology,
    // identical failure, identical resume — only the nesting differs, and only
    // the nested one loses the reuse.
    criteria.e07_subgraph_boundary_is_the_cause_of_the_lost_reuse =
      executionOf(e09, "sub_fast", "executed").executions === 1 &&
      executionOf(e07, "sub_fast", "executed").executions === 2;
  }

  const e08 = get("e08-subgraph-concurrent-resume");
  const e08Barrier = e08?.coordination?.barriers?.[0];
  if (e08 && e08Barrier) {
    criteria.e08_both_workers_were_released_together =
      e08Barrier.allArrivedBeforeRelease === true &&
      e08Barrier.peakConcurrentParties >= e08Barrier.partiesExpected &&
      e08Barrier.distinctNonces === e08Barrier.partiesExpected;
    criteria.e08_prepared_fixture_committed_a_subgraph_interrupt =
      Number((e08.prepare as { interruptsInChildNamespace?: number } | null)
        ?.interruptsInChildNamespace ?? 0) > 0;
    // Stated as "every outcome is accounted for", not as "no duplicate ran".
    // Whether both workers consumed the interrupt is the measurement, and a
    // criterion asserting one answer would be asserting the conclusion.
    criteria.e08_every_resume_outcome_is_classified =
      liveResults(e08).length === e08.workers.length &&
      liveResults(e08).every((result) => "error" in result && "runs" in result);
    // The invariant that must hold whichever way the race went.
    criteria.e08_no_stranded_state = noStrandedState(e08);
  }

  return criteria;
}

function familyHCriteria(bundles: Map<string, CaseBundle>): Record<string, boolean> {
  const criteria: Record<string, boolean> = {};
  const get = (id: string) => bundles.get(id);

  const h01 = get("h01-effect-key-components-baseline");
  if (h01) {
    const effects = effectsOf(h01);
    const sites = effectSitesOf(h01);
    criteria.h01_every_effect_recorded_a_key =
      effects.length === 2 && effects.every((effect) => typeof effect.key === "string");
    // Two of the seven proposed components come straight off the public config.
    criteria.h01_run_and_namespace_are_publicly_reachable = effects.every(
      (effect) => effect.run !== null && effect.ns !== null,
    );
    // The obvious field is deliberately cleared by the engine when it builds a
    // task's config, so a runtime reading `checkpoint_id` would key every effect
    // on null.
    criteria.h01_public_checkpoint_id_is_absent_inside_a_task = effects.every(
      (effect) => effect.configCheckpointId === null,
    );
    criteria.h01_parent_checkpoint_needs_the_checkpoint_map = effects.every(
      (effect) => effect.parentCheckpoint !== null && effect.checkpointMapKeys.length > 0,
    );
    // Present as a KEY, undefined as a VALUE. This is the mechanism behind e07:
    // `PregelLoop.initialize` decides whether to reuse completed tasks with
    // `!("checkpoint_id" in configurable)`, so a task config shaped like this
    // makes any loop initialised from it — that is, any subgraph — behave as
    // though it were an explicit replay.
    criteria.h01_task_config_carries_a_present_but_undefined_checkpoint_id =
      effects.every(
        (effect) => effect.configHasCheckpointIdKey === true && effect.configCheckpointId === null,
      );
    criteria.h01_task_id_needs_a_private_config_key = effects.every(
      (effect) => effect.task !== null && effect.taskIdFromPrivateKey === true,
    );
    // The node's own namespace is NOT the namespace its writes are stored under.
    // A key built from what the node sees could not be rediscovered from the
    // tables, which is what makes this a finding rather than a detail.
    criteria.h01_task_namespace_differs_from_the_stored_write_namespace = effects.every(
      (effect) => effect.taskNamespace !== null && effect.taskNamespace !== effect.ns,
    );
    criteria.h01_every_effect_is_reconstructible_from_rows =
      effects.length > 0 && effects.every((effect) => reconstructible(sites, effect));
    // Anti-vacuity: two genuinely different calls must not collide.
    criteria.h01_two_different_calls_produce_two_keys =
      distinct(effects.map((effect) => effect.key)).length === 2;
  }

  const h02 = get("h02-effect-key-across-crash-resume");
  if (h02) {
    const victim = effectsAt(h02, "act", 0)[0];
    const resumer = effectsAt(h02, "act", 1)[0];
    criteria.h02_victim_recorded_its_effect_before_the_kill = victim !== undefined;
    criteria.h02_killed_backend_drained_before_projection = h02.drain?.drained === true;
    criteria.h02_kill_was_uncatchable =
      ((h02.projection?.shutdownWitnesses as unknown[] | undefined) ?? []).length === 0;
    criteria.h02_effect_ran_on_two_distinct_processes =
      executionOf(h02, "act", "effect").executions === 2 &&
      executionOf(h02, "act", "effect").processes === 2;
    // THE criterion. architecture/09 marks this "assumed, not measured"; without
    // it the idempotency ledger cannot suppress a redelivered effect.
    criteria.h02_key_is_stable_across_a_sync_crash_resume =
      victim !== undefined && resumer !== undefined && victim.key === resumer.key;
    // Stated component by component too, so a stable key cannot be the accident
    // of two different component sets hashing alike.
    criteria.h02_every_component_is_stable_across_the_crash_resume =
      victim !== undefined &&
      resumer !== undefined &&
      victim.ns === resumer.ns &&
      victim.parentCheckpoint === resumer.parentCheckpoint &&
      victim.task === resumer.task &&
      victim.ordinal === resumer.ordinal;
    criteria.h02_resume_completed = liveResults(h02).some((result) => result.completed === true);
  }

  const h03 = get("h03-effect-key-across-explicit-fork");
  if (h03) {
    const original = effectsAt(h03, "act", 0)[0];
    const forked = effectsAt(h03, "act", 1)[0];
    const other = effectsAt(h03, "tail", 0)[0];
    criteria.h03_fork_resolved_the_config_derived_parent_checkpoint = resultsOf(h03).some(
      (result) => result.forkTargetResolved === true,
    );
    criteria.h03_fork_re_executed_the_node =
      executionOf(h03, "act", "effect").executions === 2 &&
      executionOf(h03, "act", "effect").processes === 2;
    // CORRECTED after measurement, in the architecture's favour.
    //
    // The authored expectation was that a fork reproduces the key: a task id is
    // `uuid5([namespace, step, node, PULL, trigger], checkpoint.id)`, so running
    // again against the SAME checkpoint would reproduce every hash input. That
    // reading missed a step. Resuming with an explicit `checkpoint_id` does not
    // re-run against the named checkpoint — the engine writes a NEW checkpoint
    // with `source: "fork"` whose parent is the named one, and the tasks run
    // against the fork. A different `checkpoint.id` in the uuid5 namespace gives
    // a different task id, hence a different key.
    criteria.h03_explicit_fork_changes_the_key =
      original !== undefined && forked !== undefined && original.key !== forked.key;
    criteria.h03_fork_ran_against_a_new_checkpoint =
      original !== undefined &&
      forked !== undefined &&
      original.parentCheckpoint !== forked.parentCheckpoint &&
      original.task !== forked.task;
    // A fork is a branch, not an extension: the thread ends with two heads.
    criteria.h03_fork_created_a_second_head =
      (threadOf(h03)?.leaves ?? []).some(
        (entry) => entry.ns === "" && entry.leaves.length === 2,
      );
    // Anti-vacuity: the harness can tell two keys apart when they genuinely
    // differ, so "the fork's key matched" is not just a broken comparison.
    criteria.h03_a_different_call_still_produces_a_different_key =
      original !== undefined && other !== undefined && original.key !== other.key;
  }

  const h02Pair = get("h02-effect-key-across-crash-resume");
  if (h02Pair && h03) {
    const crashed = effectsAt(h02Pair, "act", 0)[0];
    const resumed = effectsAt(h02Pair, "act", 1)[0];
    const original = effectsAt(h03, "act", 0)[0];
    const forked = effectsAt(h03, "act", 1)[0];
    // The pair is the result. One key mechanism, measured in both directions by
    // the same harness: unchanged where the ledger must suppress, changed where
    // it must not. Either alone would be consistent with a key that is simply
    // always stable, or always volatile.
    criteria.h03_the_key_discriminates_a_crash_resume_from_a_fork =
      crashed !== undefined && resumed !== undefined &&
      original !== undefined && forked !== undefined &&
      crashed.key === resumed.key &&
      original.key !== forked.key;
  }

  const h04 = get("h04-effect-key-async-durability");
  if (h04) {
    const victim = effectsAt(h04, "act", 0)[0];
    const resumer = effectsAt(h04, "act", 1)[0];
    criteria.h04_killed_backend_drained_before_projection = h04.drain?.drained === true;
    // Both sides recorded a key, so the outcome is observable. WHETHER they
    // match under async is a race — a lost superstep changes the parent
    // checkpoint — so it is reported as an observed set in findings rather than
    // asserted here.
    criteria.h04_both_executions_recorded_a_key =
      victim?.key !== undefined && victim.key !== null &&
      resumer?.key !== undefined && resumer.key !== null;
    // Classification, not assertion. The victim dying before its effect row
    // lands is a source-possible interleaving, and requiring `processes === 2`
    // would fail the case for the schedule rather than record a second
    // signature — the exact contradiction of calling h04 a bounded-trials case.
    criteria.h04_every_recorded_execution_is_attributed_to_a_process =
      executionOf(h04, "act", "effect").executions === 0 ||
      executionOf(h04, "act", "effect").processes >= 1;
  }

  const h05 = get("h05-effect-key-fanout-siblings");
  if (h05) {
    const siblings = effectsOf(h05).filter((effect) => effect.node.startsWith("fan_"));
    criteria.h05_three_siblings_each_recorded_one_effect =
      siblings.length === 3 && distinct(siblings.map((effect) => effect.node)).length === 3;
    // Every proposed component except `task` is identical by construction, which
    // is what makes the ablation below a measurement rather than a tautology.
    criteria.h05_siblings_differ_only_in_their_task =
      distinct(siblings.map((effect) => effect.ns)).length === 1 &&
      distinct(siblings.map((effect) => effect.parentCheckpoint)).length === 1 &&
      distinct(siblings.map((effect) => effect.tool)).length === 1 &&
      distinct(siblings.map((effect) => effect.canonicalArgs)).length === 1 &&
      distinct(siblings.map((effect) => effect.ordinal)).length === 1 &&
      distinct(siblings.map((effect) => effect.task)).length === 3;
    criteria.h05_full_key_distinguishes_the_siblings =
      distinct(siblings.map((effect) => effect.key)).length === 3;
    criteria.h05_dropping_task_collapses_the_siblings_to_one_key =
      distinct(siblings.map((effect) => effect.keyWithoutTask)).length === 1;
    criteria.h05_every_sibling_is_reconstructible_from_rows =
      siblings.length > 0 &&
      siblings.every((effect) => reconstructible(effectSitesOf(h05), effect));
  }

  const h06 = get("h06-effect-key-multiple-ordinals");
  if (h06) {
    const effects = effectsAt(h06, "act");
    const sites = effectSitesOf(h06).filter((site) => site.task === effects[0]?.task);
    criteria.h06_one_node_execution_recorded_three_effects =
      effects.length === 3 && distinct(effects.map((effect) => effect.task)).length === 1;
    criteria.h06_full_key_distinguishes_the_ordinals =
      distinct(effects.map((effect) => effect.key)).length === 3;
    criteria.h06_dropping_ordinal_collapses_them_to_one_key =
      distinct(effects.map((effect) => effect.keyWithoutOrdinal)).length === 1;
    // The row side cannot supply the ordinal: `idx` counts a task's WRITES, and
    // a node that performs three effects still writes one channel. So the
    // ordinal is runtime state the ledger must carry itself.
    criteria.h06_ordinal_is_not_recoverable_from_the_write_rows =
      sites.length > 0 && sites.length < effects.length;
  }

  const h07 = get("h07-effect-key-inside-subgraph");
  if (h07) {
    const root = effectsAt(h07, "root_act")[0];
    const sub = effectsAt(h07, "sub_act")[0];
    criteria.h07_both_effects_were_recorded = root !== undefined && sub !== undefined;
    criteria.h07_both_effects_made_the_same_call =
      root !== undefined && sub !== undefined &&
      root.tool === sub.tool && root.canonicalArgs === sub.canonicalArgs;
    criteria.h07_they_land_in_different_namespaces =
      root !== undefined && sub !== undefined && root.ns !== sub.ns;
    criteria.h07_they_have_different_parent_checkpoints =
      root !== undefined && sub !== undefined && root.parentCheckpoint !== sub.parentCheckpoint;
    criteria.h07_full_keys_differ =
      root !== undefined && sub !== undefined && root.key !== sub.key;
    // The reconstruction has to keep working one namespace down, or a ledger
    // entry written by a subgraph could never be audited against the tables.
    criteria.h07_both_are_reconstructible_from_rows =
      root !== undefined && sub !== undefined &&
      reconstructible(effectSitesOf(h07), root) &&
      reconstructible(effectSitesOf(h07), sub);
  }

  return criteria;
}

/**
 * The changed-graph matrix and the compatibility guard.
 *
 * Split into two lanes for the same reason family A is: the guard's own criteria
 * live in `mit-compat`, so a green mitigation can never raise the stock lane's
 * status, while the comparison against the stock pair stays visible.
 */
type ThreadDamage = {
  strandedReferences?: number;
  orphanBlobs?: number;
  brokenLineage?: number;
  deadWrites?: number;
};

type NamespaceTriple = {
  checkpoints: number;
  blobs: number;
  writes: number;
  interruptRows: number;
};

/**
 * A thread's per-namespace shape, with no namespace STRING in it.
 *
 * A subgraph namespace embeds a per-run task uuid, so carrying one into a
 * digested result would change the bytes every run for no behavioural reason.
 * What the criteria need is the count, the root's triple, and the content-sorted
 * multiset of the children's — all of which are stable.
 */
type NamespaceShape = {
  namespaces?: number;
  childNamespaces?: number;
  root?: NamespaceTriple;
  children?: NamespaceTriple[];
  childTotals?: NamespaceTriple;
};

type Survey = {
  counts?: Array<{ thread_id: string; checkpoints: number; blobs: number; writes: number }>;
  retainedDamage?: ThreadDamage;
  staleDamage?: ThreadDamage;
  retainedSharingMax?: number;
  retainedNamespaces?: NamespaceShape;
  staleNamespaces?: NamespaceShape;
  strandedReferences?: number;
  orphanBlobs?: number;
  brokenLineage?: number;
  deadWrites?: number;
  sharingMax?: number;
  sharedVersions?: number;
};

function namespaceShapeOf(
  survey: Survey | undefined,
  thread: "retained" | "stale",
): NamespaceShape | undefined {
  return thread === "retained" ? survey?.retainedNamespaces : survey?.staleNamespaces;
}

/** Total executions of one node across every phase and party. */
function nodeExecutions(bundle: CaseBundle | undefined, node: string): number {
  if (!bundle) return 0;
  return executionsOf(bundle)
    .filter((entry) => entry.node === node && entry.phase === "executed")
    .reduce((total, entry) => total + entry.executions, 0);
}

type PruneResult = {
  party?: number;
  before?: Survey;
  after?: Survey;
  action?: Record<string, unknown>;
  resumed?: {
    completed?: boolean;
    interrupted?: boolean;
    error?: unknown;
    steps?: string[];
  } | null;
  /** f14 only: a completed thread cannot be resumed, so it is read instead. */
  read?: {
    headPresent?: boolean;
    referencedChannels?: number;
    unresolvedChannels?: number;
    apiSteps?: string[];
    apiError?: string | null;
    executionsDuringRead?: number;
  } | null;
  introducedStrandedReferences?: boolean;
  introducedBrokenLineage?: boolean;
};

/** The acting party's result. For a kill case that is the survivor, not the victim. */
function pruneOf(bundle: CaseBundle | undefined, party = 0): PruneResult | undefined {
  return resultsOf(bundle).find((result) => result.party === party) as PruneResult | undefined;
}

function threadRows(survey: Survey | undefined, suffix: "" | "-stale"): {
  checkpoints: number;
  blobs: number;
  writes: number;
} {
  const row = (survey?.counts ?? []).find((entry) =>
    suffix === "-stale" ? entry.thread_id.endsWith("-stale") : !entry.thread_id.endsWith("-stale"),
  );
  return {
    checkpoints: row?.checkpoints ?? -1,
    blobs: row?.blobs ?? -1,
    writes: row?.writes ?? -1,
  };
}

/**
 * Family F: retention and blob reachability.
 *
 * Every case is bracketed. f05 prunes nothing and f06 prunes the head, so f04's
 * "the retained run still resumes" cannot be satisfied by a graph that would
 * have resumed regardless; f07 and f08 are mutations that MUST damage the
 * database, so "the correct sweep left no damage" is falsifiable; and f10
 * reverses f09's delete order, so "the safe order is safe" is a differential
 * rather than an assertion about crashes being harmless.
 */
function familyFCriteria(bundles: Map<string, CaseBundle>): Record<string, boolean> {
  const criteria: Record<string, boolean> = {};
  const get = (id: string) => bundles.get(id);
  const preparedBoth = (bundle: CaseBundle | undefined): boolean => {
    const prepare = bundle?.prepare as
      | { retainedReachedInterrupt?: boolean; staleCompleted?: boolean }
      | null;
    return prepare?.retainedReachedInterrupt === true && prepare?.staleCompleted === true;
  };

  const f01 = get("f01-blob-sharing-baseline");
  if (f01) {
    const result = pruneOf(f01);
    criteria.f01_prepare_built_a_paused_thread_and_a_completed_one = preparedBoth(f01);
    // The fact the rest of the family turns on: one blob row is referenced by
    // more than one live checkpoint, because a channel that stopped changing
    // keeps its old version number.
    // Per THREAD. The previous grouping summed two independent runs of the same
    // graph and reported a maximum of 6 where the real per-thread figure is 2.
    criteria.f01_a_blob_version_is_shared_by_several_checkpoints_in_one_thread =
      Number(result?.before?.retainedSharingMax ?? 0) >= 2;
    criteria.f01_the_starting_database_is_undamaged =
      result?.before?.strandedReferences === 0 &&
      result?.before?.brokenLineage === 0 &&
      result?.before?.deadWrites === 0;
  }

  const f02 = get("f02-naive-checkpoint-deletion-by-date");
  if (f02) {
    const result = pruneOf(f02);
    criteria.f02_naive_date_policy_deleted_checkpoints =
      Number((result?.action as { deleted?: number } | undefined)?.deleted ?? 0) > 0;
    // Deleting by date cannot know what the survivors point at.
    criteria.f02_naive_date_policy_broke_parent_lineage =
      result?.introducedBrokenLineage === true;
    criteria.f02_naive_date_policy_left_blobs_behind =
      Number(result?.after?.orphanBlobs ?? 0) > Number(result?.before?.orphanBlobs ?? 0);
  }

  const f03 = get("f03-naive-superseded-blob-deletion");
  if (f03) {
    const result = pruneOf(f03);
    criteria.f03_naive_version_policy_deleted_blobs =
      Number((result?.action as { deleted?: number } | undefined)?.deleted ?? 0) > 0;
    // The consequence of f01: the head still references the old version.
    criteria.f03_naive_version_policy_stranded_the_live_head =
      result?.introducedStrandedReferences === true &&
      Number(result?.after?.strandedReferences ?? 0) > 0;
    // And nothing said so. The loader joins checkpoints to blobs with an INNER
    // join, so a missing blob does not raise — the channel silently vanishes and
    // the thread resumes on truncated state. A corrupted run reports success.
    criteria.f03_the_stranded_run_still_reported_success =
      result?.resumed?.completed === true &&
      Number(result?.after?.strandedReferences ?? 0) > 0;
  }

  const f04 = get("f04-reachability-sweep-retains-a-paused-thread");
  if (f04) {
    const result = pruneOf(f04);
    criteria.f04_sweep_removed_the_stale_completed_thread =
      threadRows(result?.before, "-stale").checkpoints > 0 &&
      threadRows(result?.after, "-stale").checkpoints === 0 &&
      threadRows(result?.after, "-stale").blobs === 0 &&
      threadRows(result?.after, "-stale").writes === 0;
    criteria.f04_sweep_kept_every_row_of_the_retained_thread =
      threadRows(result?.before, "").checkpoints === threadRows(result?.after, "").checkpoints &&
      threadRows(result?.before, "").blobs === threadRows(result?.after, "").blobs &&
      threadRows(result?.before, "").writes === threadRows(result?.after, "").writes;
    criteria.f04_sweep_left_no_damage =
      result?.after?.strandedReferences === 0 &&
      result?.after?.brokenLineage === 0 &&
      result?.after?.deadWrites === 0;
    // The claim row counts cannot make.
    criteria.f04_the_retained_run_still_resumes = result?.resumed?.completed === true;
  }

  const f05 = get("f05-prune-nothing-control");
  if (f05) {
    const result = pruneOf(f05);
    const deleted = (result?.action as { deleted?: Record<string, number> } | undefined)?.deleted;
    criteria.f05_prune_nothing_deleted_nothing =
      deleted !== undefined &&
      deleted.checkpoints === 0 &&
      deleted.blobs === 0 &&
      deleted.writes === 0;
    criteria.f05_prune_nothing_left_the_stale_thread_intact =
      threadRows(result?.before, "-stale").checkpoints ===
      threadRows(result?.after, "-stale").checkpoints;
    criteria.f05_retained_run_still_resumes = result?.resumed?.completed === true;
  }

  const f06 = get("f06-prune-head-control");
  if (f06) {
    const result = pruneOf(f06);
    criteria.f06_prune_head_deleted_the_retained_thread =
      threadRows(result?.after, "").checkpoints === 0 &&
      threadRows(result?.after, "").blobs === 0 &&
      threadRows(result?.after, "").writes === 0;
    // CORRECTED after measurement. The authored expectation was that resuming a
    // thread whose state has been deleted fails. It does not: the resume returns
    // NO error, `completed: true`, and an EMPTY step list, having executed
    // nothing. Over-pruning is therefore silent — the same signature h10 found
    // for a renamed node, arrived at from the opposite direction.
    criteria.f06_over_pruning_raised_no_error = result?.resumed?.error === null;
    criteria.f06_the_pruned_run_resumed_into_nothing =
      Array.isArray(result?.resumed?.steps) && result.resumed.steps.length === 0;
    criteria.f06_no_node_executed_after_the_head_was_pruned =
      executionsOf(f06).length === 0;
  }
  if (f04 && f06) {
    // The discriminator that makes f04's resume load-bearing. It cannot be
    // `completed`, because both runs report completion — it has to be whether
    // the resume actually replayed the graph.
    const kept = pruneOf(f04)?.resumed?.steps ?? [];
    const pruned = pruneOf(f06)?.resumed?.steps ?? [];
    criteria.f06_replayed_steps_separate_a_kept_run_from_a_pruned_one =
      kept.length > 0 && pruned.length === 0;
  }

  const f07 = get("f07-incomplete-sweep-omits-channel-versions");
  if (f07) {
    const result = pruneOf(f07);
    // The mutation MUST be detectable, or "the correct sweep left no damage" is
    // a claim about a detector that cannot see damage.
    criteria.f07_incomplete_sweep_stranded_live_references =
      result?.introducedStrandedReferences === true &&
      Number(result?.after?.strandedReferences ?? 0) > 0;
  }

  const f08 = get("f08-incomplete-sweep-omits-ancestors");
  if (f08) {
    const result = pruneOf(f08);
    criteria.f08_incomplete_sweep_broke_parent_lineage =
      result?.introducedBrokenLineage === true &&
      Number(result?.after?.brokenLineage ?? 0) > 0;
  }


  const f11 = get("f11-head-scoped-sweep-prunes-an-abandoned-branch");
  if (f11) {
    const result = pruneOf(f11);
    const action = result?.action as
      | { headScoped?: boolean; head?: boolean; deleted?: Record<string, number> }
      | undefined;
    const prepare = f11.prepare as { retainedHasAbandonedBranch?: boolean } | null;
    // The fixture must actually contain a branch to prune, or the case is a
    // no-op dressed as a result.
    criteria.f11_the_retained_thread_had_an_abandoned_branch =
      prepare?.retainedHasAbandonedBranch === true;
    criteria.f11_the_live_set_was_walked_from_a_head =
      action?.headScoped === true && action?.head === true;
    // CORRECTED. This previously asserted `deleted.checkpoints > 0`, which the
    // five stale-thread deletions satisfy on their own — the case would have
    // passed unchanged if head-scoped retention had pruned NOTHING inside the
    // retained thread, which is the only thing it exists to show. The signal is
    // one checkpoint, and it has to be isolated per thread to be a signal at all.
    const retainedBefore = threadRows(result?.before, "");
    const retainedAfter = threadRows(result?.after, "");
    criteria.f11_head_scoped_retention_pruned_inside_a_retained_thread =
      retainedBefore.checkpoints > retainedAfter.checkpoints && retainedAfter.checkpoints > 0;
    // The stale deletions are accounted for separately rather than borrowed to
    // satisfy the intra-thread claim.
    criteria.f11_the_sweep_also_removed_the_stale_thread =
      threadRows(result?.before, "-stale").checkpoints > 0 &&
      threadRows(result?.after, "-stale").checkpoints === 0;
    criteria.f11_the_retained_lineage_is_undamaged =
      result?.after?.retainedDamage?.strandedReferences === 0 &&
      result?.after?.retainedDamage?.brokenLineage === 0;
    // `completed` alone is the f06 trap: a resume against deleted state also
    // reports success, with an empty step list.
    criteria.f11_the_paused_run_still_resumes =
      result?.resumed?.completed === true &&
      Array.isArray(result?.resumed?.steps) &&
      (result?.resumed?.steps?.length ?? 0) > 0;
    // In head-scoped mode no SQL references `retainThreads`; the sweep is
    // database-global. Recorded so nobody infers a thread scope from an argument
    // the sweep ignored.
    criteria.f11_head_scoped_mode_ignores_retain_threads =
      (action as { retainThreadsApplied?: boolean } | undefined)?.retainThreadsApplied === false;
  }

  const f14 = get("f14-head-scoped-retention-of-a-completed-thread");
  if (f14) {
    const result = pruneOf(f14);
    const action = result?.action as
      | { headScoped?: boolean; retainedHeads?: number }
      | undefined;
    const prepare = f14.prepare as
      | { retainedCompleted?: boolean; retainedInterruptRows?: number; retainedHasAbandonedBranch?: boolean }
      | null;
    const read = result?.read as
      | {
          headPresent?: boolean;
          referencedChannels?: number;
          unresolvedChannels?: number;
          apiSteps?: string[];
          executionsDuringRead?: number;
        }
      | undefined;

    // What separates this from every other F case: the run FINISHED, so the
    // survival claim cannot be "it resumed".
    criteria.f14_the_retained_thread_ran_to_completion = prepare?.retainedCompleted === true;
    criteria.f14_the_completed_thread_had_an_abandoned_branch =
      prepare?.retainedHasAbandonedBranch === true;
    // The abandoned branch carries an interrupt nobody will ever answer — an
    // approval orphaned by the fork. Head-scoped retention takes it away with
    // the branch it belongs to.
    criteria.f14_the_orphaned_approval_went_with_the_abandoned_branch =
      Number(namespaceShapeOf(result?.before, "retained")?.root?.interruptRows ?? 0) >
      Number(namespaceShapeOf(result?.after, "retained")?.root?.interruptRows ?? Infinity);
    // CORRECTED after measurement, and a finding in its own right. The first
    // version asserted zero interrupt rows survive. One does, and must: the
    // completed run's own `__interrupt__` write is attached to a checkpoint the
    // live head descends from, so a correct sweep keeps it. Consuming an
    // interrupt does not delete its row.
    //
    // That makes `__interrupt__` a HISTORICAL record, not a pending-approval
    // queue. A runtime counting those rows to find outstanding approvals
    // over-counts twice over: once for every nested interrupt (e04 records it at
    // both levels) and once for every interrupt already answered.
    criteria.f14_a_consumed_interrupt_row_is_retained_as_history =
      Number(namespaceShapeOf(result?.after, "retained")?.root?.interruptRows ?? 0) >= 1;
    criteria.f14_the_live_set_was_walked_from_a_head = action?.headScoped === true;
    criteria.f14_head_scoped_retention_pruned_inside_the_completed_thread =
      threadRows(result?.before, "").checkpoints > threadRows(result?.after, "").checkpoints &&
      threadRows(result?.after, "").checkpoints > 0;
    criteria.f14_the_head_lineage_survived_intact =
      result?.after?.retainedDamage?.strandedReferences === 0 &&
      result?.after?.retainedDamage?.brokenLineage === 0;
    // The authoritative oracle: the negated INNER join the loader performs,
    // scoped to the surviving head.
    criteria.f14_the_completed_thread_is_still_readable =
      read?.headPresent === true &&
      Number(read?.referencedChannels ?? 0) > 0 &&
      read?.unresolvedChannels === 0;
    // Corroboration only, and deliberately named as such.
    criteria.f14_the_re_read_returned_the_terminal_state =
      Array.isArray(read?.apiSteps) && (read?.apiSteps?.length ?? 0) > 0;
    criteria.f14_no_node_executed_during_the_read = read?.executionsDuringRead === 0;
  }

  const f15 = get("f15-head-scoped-retention-across-every-live-namespace");
  if (f15) {
    const result = pruneOf(f15);
    const action = result?.action as
      | { headScoped?: boolean; retainedHeads?: number; headsOffered?: number }
      | undefined;
    const prepare = f15.prepare as
      | { retainedNamespaceCount?: number; retainedChildInterruptRows?: number }
      | null;
    const before = namespaceShapeOf(result?.before, "retained");
    const after = namespaceShapeOf(result?.after, "retained");

    criteria.f15_the_fixture_paused_inside_a_subgraph =
      Number(prepare?.retainedNamespaceCount ?? 0) >= 2 &&
      Number(prepare?.retainedChildInterruptRows ?? 0) >= 1;
    // One head per namespace, and more than one namespace — otherwise the case
    // is f11 with extra steps.
    criteria.f15_a_head_was_named_in_every_live_namespace =
      Number(action?.retainedHeads ?? 0) === Number(before?.namespaces ?? -1) &&
      Number(before?.namespaces ?? 0) >= 2;
    criteria.f15_no_namespace_of_the_retained_thread_lost_rows =
      before !== undefined &&
      after !== undefined &&
      stable(before.children) === stable(after.children) &&
      stable(before.root) === stable(after.root);
    criteria.f15_the_child_namespace_approval_survived =
      Number(before?.childTotals?.interruptRows ?? 0) > 0 &&
      Number(after?.childTotals?.interruptRows ?? 0) ===
        Number(before?.childTotals?.interruptRows ?? -1);
    criteria.f15_the_retained_thread_is_undamaged =
      result?.after?.retainedDamage?.strandedReferences === 0 &&
      result?.after?.retainedDamage?.brokenLineage === 0 &&
      result?.after?.retainedDamage?.deadWrites === 0;
    criteria.f15_the_stale_thread_was_removed =
      threadRows(result?.before, "-stale").checkpoints > 0 &&
      threadRows(result?.after, "-stale").checkpoints === 0;
    criteria.f15_the_paused_subgraph_run_resumed_and_replayed =
      result?.resumed?.completed === true && (result?.resumed?.steps?.length ?? 0) > 0;
  }

  const f16 = get("f16-root-only-head-seed-deletes-child-namespace-state");
  if (f16) {
    const result = pruneOf(f16);
    const action = result?.action as
      | { retainedHeads?: number; headsOffered?: number; omit?: string | null }
      | undefined;
    const before = namespaceShapeOf(result?.before, "retained");
    const after = namespaceShapeOf(result?.after, "retained");

    criteria.f16_only_the_root_namespace_was_seeded =
      action?.omit === "child-namespaces" &&
      Number(action?.retainedHeads ?? 0) === 1 &&
      Number(action?.headsOffered ?? 0) >= 2;
    criteria.f16_the_child_namespace_was_deleted_entirely =
      Number(before?.childTotals?.checkpoints ?? 0) > 0 &&
      Number(after?.childTotals?.checkpoints ?? -1) === 0 &&
      Number(after?.childTotals?.blobs ?? -1) === 0 &&
      Number(after?.childTotals?.writes ?? -1) === 0;
    criteria.f16_the_pending_approval_was_destroyed =
      Number(before?.childTotals?.interruptRows ?? 0) > 0 &&
      Number(after?.childTotals?.interruptRows ?? -1) === 0;
    // Targeted loss, not "the sweep deleted everything".
    criteria.f16_the_root_namespace_survived =
      before !== undefined && after !== undefined && stable(before.root) === stable(after.root);
    // The consequence, and it is the h12 shape: the resume re-entered the
    // subgraph from scratch and raised a FRESH interrupt. The approval that was
    // outstanding is consumed by nothing, and a new one now blocks the run.
    criteria.f16_the_resume_raised_a_new_approval_instead_of_answering_the_old_one =
      pruneOf(f16)?.resumed?.interrupted === true &&
      pruneOf(f16)?.resumed?.completed === false;
  }

  if (f15 && f16) {
    const kept = namespaceShapeOf(pruneOf(f15)?.after, "retained");
    const lost = namespaceShapeOf(pruneOf(f16)?.after, "retained");
    // Identical fixture, identical sweep; only the seeded namespace set differs.
    criteria.f16_the_loss_is_the_seed_and_not_the_sweep =
      Number(kept?.childTotals?.checkpoints ?? 0) > 0 &&
      Number(lost?.childTotals?.checkpoints ?? -1) === 0;
  }

  const f17 = get("f17-omitting-pending-writes-forces-re-execution");
  const f18 = get("f18-pending-writes-retained-control");
  if (f17) {
    const result = pruneOf(f17);
    const prepare = f17.prepare as
      | { retainedAborted?: boolean; retainedPendingWritesAtHead?: number }
      | null;
    criteria.f17_the_fanout_aborted_with_a_sibling_write_durable =
      prepare?.retainedAborted === true &&
      Number(prepare?.retainedPendingWritesAtHead ?? 0) > 0;
    criteria.f17_the_pending_writes_were_deleted =
      threadRows(result?.before, "").writes > threadRows(result?.after, "").writes;
    // The consequence f12 could not show. `executionCounts` scopes to
    // `party >= 0`, so the fixture's own execution during prepare is excluded
    // and this counts only what the RESUME ran: a reused sibling contributes
    // nothing, a re-executed one contributes a row.
    criteria.f17_the_surviving_sibling_re_executed = nodeExecutions(f17, "sub_fast") >= 1;
  }
  if (f18) {
    const result = pruneOf(f18);
    criteria.f18_the_live_set_was_complete =
      (result?.action as { omit?: string | null } | undefined)?.omit === null;
    criteria.f18_the_retained_thread_kept_its_pending_writes =
      threadRows(result?.after, "").writes >= threadRows(result?.before, "").writes;
    // Reused, so it does not appear among the resume's executions at all.
    criteria.f18_the_surviving_sibling_was_reused = nodeExecutions(f18, "sub_fast") === 0;
    // Anti-vacuity: the resume must have DONE something, or "sub_fast did not
    // run" is satisfied by a resume that ran nothing.
    criteria.f18_the_resume_completed_the_remaining_work =
      nodeExecutions(f18, "sub_join") >= 1 && result?.resumed?.completed === true;
  }
  if (f17 && f18) {
    // Same fixture, same sweep, one term dropped. Without this the second
    // execution could be a property of resuming an aborted fan-out at all.
    criteria.f17_re_execution_is_the_deleted_write_and_not_the_resume =
      nodeExecutions(f17, "sub_fast") > nodeExecutions(f18, "sub_fast");
  }

  const f12 = get("f12-incomplete-sweep-omits-pending-writes");
  if (f12) {
    const result = pruneOf(f12);
    // CORRECTED, and narrowed to what was measured. The two original criteria
    // stated one fact twice, and the case's purpose claimed a resume
    // consequence the same result set contradicts.
    criteria.f12_omitting_pending_writes_deleted_every_retained_write =
      threadRows(result?.before, "").writes > 0 && threadRows(result?.after, "").writes === 0;
    // The finding is the SILENCE. The writes' checkpoints survive, so the
    // reachability witness is structurally blind to this mutation.
    criteria.f12_no_reachability_detector_fired =
      result?.after?.retainedDamage?.strandedReferences === 0 &&
      result?.after?.retainedDamage?.brokenLineage === 0 &&
      result?.after?.retainedDamage?.deadWrites === 0;
    // Recorded as a measured negative rather than hidden: this fixture's resume
    // does not depend on a pending write, so it completes exactly as the correct
    // sweep does. f17 is where the term's necessity is measured.
    criteria.f12_the_resume_still_reported_success =
      result?.resumed?.completed === true && (result?.resumed?.steps?.length ?? 0) > 0;
  }

  const f13 = get("f13-incomplete-sweep-omits-interrupts");
  if (f13) {
    const result = pruneOf(f13);
    const prepare = f13.prepare as { retainedInterruptRows?: number } | null;
    criteria.f13_omitting_interrupts_deleted_write_rows =
      Number(
        (result?.action as { deleted?: Record<string, number> } | undefined)?.deleted?.writes ?? 0,
      ) > 0;
    // CORRECTED. Exactly the interrupt rows went, and nothing else — which is
    // what makes this the narrow half of f12 rather than a second copy of it.
    criteria.f13_only_the_interrupt_rows_were_deleted =
      Number(prepare?.retainedInterruptRows ?? 0) > 0 &&
      threadRows(result?.before, "").writes - threadRows(result?.after, "").writes ===
        Number(prepare?.retainedInterruptRows ?? -1);
    // The honest consequence: the approval is gone from the tables. The old
    // criterion — `f13_the_paused_run_lost_its_decision_point` — was named for a
    // behaviour the evidence contradicts and has been deleted.
    criteria.f13_the_pending_approval_is_no_longer_discoverable =
      namespaceShapeOf(result?.before, "retained") !== undefined &&
      Number(namespaceShapeOf(result?.before, "retained")?.root?.interruptRows ?? 0) > 0 &&
      Number(namespaceShapeOf(result?.after, "retained")?.root?.interruptRows ?? -1) === 0;
    criteria.f13_the_run_still_resumed_when_handed_a_command =
      result?.resumed?.completed === true && (result?.resumed?.steps?.length ?? 0) > 0;
  }

  const f09 = get("f09-kill-pruner-safe-order");
  if (f09) {
    // Party 1 is the survivor; party 0 was killed and reports nothing.
    const observer = pruneOf(f09, 1);
    const parks = (f09.projection?.gateParks as Array<{ gate: string }> | undefined) ?? [];
    criteria.f09_pruner_parked_before_the_blob_delete = parks.some(
      (park) => park.gate === "before-blob-delete",
    );
    criteria.f09_killed_backend_drained_before_projection = f09.drain?.drained === true;
    criteria.f09_kill_was_uncatchable =
      ((f09.projection?.shutdownWitnesses as unknown[] | undefined) ?? []).length === 0;
    // Harmless garbage, not corruption: blobs nobody references.
    criteria.f09_safe_order_left_orphan_blobs =
      Number(observer?.before?.orphanBlobs ?? 0) > 0;
    criteria.f09_safe_order_left_no_stranded_references =
      observer?.before?.strandedReferences === 0;
    // The half that actually matters: the thread the policy promised to keep.
    criteria.f09_safe_order_left_the_retained_thread_undamaged =
      observer?.before?.retainedDamage?.strandedReferences === 0 &&
      observer?.before?.retainedDamage?.brokenLineage === 0;
    criteria.f09_retained_run_still_resumes_after_the_crash =
      observer?.resumed?.completed === true;
  }

  const f10 = get("f10-kill-pruner-unsafe-order-control");
  if (f10) {
    const observer = pruneOf(f10, 1);
    const parks = (f10.projection?.gateParks as Array<{ gate: string }> | undefined) ?? [];
    criteria.f10_pruner_parked_before_the_checkpoint_delete = parks.some(
      (park) => park.gate === "before-checkpoint-delete",
    );
    // CORRECTED. The original claim — "an unsafe delete order corrupts the
    // database" — was true of rows the sweep was already deleting, which is
    // inconsistent garbage, not corruption of anything retained. Pairing the
    // unsafe order with an incomplete live-set rule is what puts the damage in
    // the thread the policy promised to keep.
    criteria.f10_unsafe_order_stranded_the_retained_thread =
      Number(observer?.before?.retainedDamage?.strandedReferences ?? 0) > 0;
    // And nothing said so: the loader's INNER join drops the missing channel
    // rather than raising, so a corrupted run still reports success.
    criteria.f10_the_corrupted_retained_run_still_reported_success =
      observer?.resumed?.completed === true &&
      Number(observer?.before?.retainedDamage?.strandedReferences ?? 0) > 0;
  }

  if (f09 && f10) {
    // The differential. Both crashed at the same point in the same sweep; only
    // the delete ORDER differed, and only one of them corrupted the database.
    criteria.f09_a_crashed_sweep_damages_retained_state_only_when_the_rule_is_wrong =
      pruneOf(f09, 1)?.before?.retainedDamage?.strandedReferences === 0 &&
      Number(pruneOf(f10, 1)?.before?.retainedDamage?.strandedReferences ?? 0) > 0;
  }

  return criteria;
}


type ClusterIdentity = { systemIdentifier?: string; postmasterStartTime?: string };
type RestartShape = { checkpoints?: number; interruptRows?: number; blobs?: number; writes?: number };
type RestartResult = {
  party?: number;
  role?: string;
  reachedInterrupt?: boolean;
  heldBackend?: boolean;
  blockedBackends?: number;
  callWasInFlight?: boolean;
  callSettled?: boolean;
  callRejected?: boolean;
  callError?: { message?: string } | null;
  settledWithinBudget?: boolean;
  shape?: RestartShape;
  survived?: RestartShape;
  cluster?: ClusterIdentity;
  resumed?: { completed?: boolean; error?: unknown; steps?: string[] } | null;
};

function restartSide(bundle: CaseBundle | undefined, party: number): RestartResult | undefined {
  return resultsOf(bundle).find((result) => result.party === party) as RestartResult | undefined;
}

function sameShape(left: RestartShape | undefined, right: RestartShape | undefined): boolean {
  return (
    left !== undefined &&
    right !== undefined &&
    Number(left.checkpoints ?? -1) > 0 &&
    left.checkpoints === right.checkpoints &&
    left.interruptRows === right.interruptRows &&
    left.blobs === right.blobs &&
    left.writes === right.writes
  );
}

/** Same cluster data, later server process. Both halves, or it is not a restart. */
function sameClusterRestarted(
  before: ClusterIdentity | undefined,
  after: ClusterIdentity | undefined,
): boolean {
  return (
    typeof before?.systemIdentifier === "string" &&
    before.systemIdentifier === after?.systemIdentifier &&
    typeof before.postmasterStartTime === "string" &&
    typeof after.postmasterStartTime === "string" &&
    after.postmasterStartTime > before.postmasterStartTime
  );
}

function resumedTheRun(result: RestartResult | undefined): boolean {
  // Completion alone is not enough: f06 measured that a resume against absent
  // state also reports success, with an empty step list. The replayed steps are
  // what separate a preserved run from a vanished one.
  return (
    result?.resumed?.completed === true &&
    Array.isArray(result.resumed.steps) &&
    result.resumed.steps.length > 0
  );
}

/**
 * Family G: database and container-stack restart.
 *
 * The continuity witness throughout is `system_identifier`, written once by
 * initdb: a container id proves a CONTAINER was replaced, but only the system
 * identifier proves the DATA is the same data. g05 is what makes every other
 * case in the family falsifiable — it performs the identical replacement onto a
 * new volume and must lose everything.
 */
function familyGCriteria(bundles: Map<string, CaseBundle>): Record<string, boolean> {
  const criteria: Record<string, boolean> = {};
  const get = (id: string) => bundles.get(id);

  const g01 = get("g01-graceful-database-restart");
  if (g01) {
    const before = restartSide(g01, 0);
    const after = restartSide(g01, 1);
    criteria.g01_a_paused_thread_was_committed_before_the_restart =
      before?.reachedInterrupt === true && Number(before?.shape?.interruptRows ?? 0) > 0;
    criteria.g01_same_cluster_data_and_a_newer_server_process =
      sameClusterRestarted(before?.cluster, after?.cluster);
    criteria.g01_graceful_restart_logged_a_clean_shutdown =
      Number(g01.restart?.log?.shutdownComplete ?? 0) >= 1 &&
      Number(g01.restart?.log?.notCleanShutdown ?? 0) === 0 &&
      Number(g01.restart?.log?.readyForConnections ?? 0) >= 1;
    criteria.g01_every_row_survived_the_restart = sameShape(before?.shape, after?.survived);
    criteria.g01_the_paused_run_resumed_afterwards = resumedTheRun(after);
  }

  const g02 = get("g02-unclean-database-kill-and-recovery");
  if (g02) {
    const before = restartSide(g02, 0);
    const after = restartSide(g02, 1);
    criteria.g02_the_server_did_not_shut_down_cleanly =
      Number(g02.restart?.log?.notCleanShutdown ?? 0) >= 1;
    // Proven from the log, not inferred from the server coming back.
    criteria.g02_crash_recovery_actually_ran =
      Number(g02.restart?.log?.automaticRecovery ?? 0) >= 1 ||
      Number(g02.restart?.log?.redoStarts ?? 0) >= 1;
    criteria.g02_same_cluster_data_after_recovery =
      sameClusterRestarted(before?.cluster, after?.cluster);
    criteria.g02_every_row_survived_the_crash = sameShape(before?.shape, after?.survived);
    criteria.g02_the_paused_run_resumed_after_recovery = resumedTheRun(after);
  }
  if (g01 && g02) {
    // The control that makes the recovery log evidence rather than decoration.
    criteria.g02_the_log_separates_a_crash_from_a_clean_stop =
      Number(g01.restart?.log?.notCleanShutdown ?? 0) === 0 &&
      Number(g02.restart?.log?.notCleanShutdown ?? 0) >= 1;
  }

  const g03 = get("g03-database-death-under-a-live-worker");
  if (g03) {
    const before = restartSide(g03, 0);
    const after = restartSide(g03, 1);
    // Proven from the SERVER, not from a pid the party once read: a backend
    // belonging to the subject pool was waiting on a lock, inside PostgreSQL, at
    // the moment it was SIGKILLed.
    criteria.g03_a_checkpointer_call_was_in_flight_when_the_server_died =
      before?.callWasInFlight === true && Number(before?.blockedBackends ?? 0) > 0;
    // The architecture question: loud and bounded, or an indefinite hang.
    criteria.g03_the_in_flight_call_settled_rather_than_hanging =
      before?.callSettled === true && before?.settledWithinBudget === true;
    criteria.g03_the_in_flight_call_failed_loudly =
      before?.callRejected === true &&
      (before?.callError as { message?: string } | null)?.message !== undefined;
    criteria.g03_crash_recovery_ran =
      Number(g03.restart?.log?.automaticRecovery ?? 0) >= 1 ||
      Number(g03.restart?.log?.redoStarts ?? 0) >= 1;
    criteria.g03_state_committed_before_the_death_survived =
      sameShape(before?.shape, after?.survived);
    criteria.g03_the_run_resumed_after_the_server_died = resumedTheRun(after);
  }

  const g04 = get("g04-container-stack-replacement-on-the-preserved-volume");
  if (g04) {
    const before = restartSide(g04, 0);
    const after = restartSide(g04, 1);
    // A new container id is what separates a replaced stack from one that never
    // went away — the failure mode the plan names explicitly.
    criteria.g04_the_database_container_was_actually_replaced =
      g04.restart?.sameContainer === false;
    criteria.g04_replacement_used_the_pinned_image =
      g04.restart?.pinnedImage === true && g04.restart?.sameImage === true;
    criteria.g04_the_named_volume_was_preserved = g04.restart?.sameVolume === true;
    criteria.g04_same_cluster_data_after_replacement =
      sameClusterRestarted(before?.cluster, after?.cluster);
    criteria.g04_every_row_survived_the_replacement = sameShape(before?.shape, after?.survived);
    criteria.g04_a_fresh_runtime_container_resumed_from_persisted_state = resumedTheRun(after);
  }

  const g05 = get("g05-fresh-volume-negative-control");
  if (g05) {
    const before = restartSide(g05, 0);
    const after = restartSide(g05, 1);
    criteria.g05_the_volume_was_replaced = g05.restart?.sameVolume === false;
    // Measured all along and asserted nowhere. "The identical replacement
    // procedure onto a new volume" was prose; these make it a criterion.
    criteria.g05_the_database_container_was_actually_replaced =
      g05.restart?.sameContainer === false;
    criteria.g05_replacement_used_the_pinned_image =
      g05.restart?.pinnedImage === true && g05.restart?.sameImage === true;
    // The strongest half of the control: a different system identifier is a
    // different cluster, whatever the container looks like.
    criteria.g05_the_cluster_identity_changed =
      typeof before?.cluster?.systemIdentifier === "string" &&
      typeof after?.cluster?.systemIdentifier === "string" &&
      before.cluster.systemIdentifier !== after.cluster.systemIdentifier;
    criteria.g05_no_state_survived_the_fresh_volume =
      after?.survived?.checkpoints === 0 && after?.survived?.interruptRows === 0;
    // RENAMED. The old name — `g05_the_run_did_not_come_back` — implied a
    // failure. The measurement is that the resume SUCCEEDED against nothing:
    // no error, `completed: true`, an empty step list, and a fresh checkpoint
    // written. That is the f06 shape, and naming it as a failure hid it.
    criteria.g05_the_resume_started_a_new_empty_run_rather_than_returning_the_old_one =
      Array.isArray(after?.resumed?.steps) && after.resumed.steps.length === 0;
    criteria.g05_the_loss_was_silent = after?.resumed?.error === null;
    criteria.g05_no_node_executed_after_the_fresh_volume = executionsOf(g05).length === 0;
  }

  if (g04 && g05) {
    // The differential the whole family rests on: identical replacement
    // procedure, and only volume continuity decides whether the run survives.
    const kept = restartSide(g04, 1);
    const lost = restartSide(g05, 1);
    criteria.g05_volume_continuity_is_what_preserves_the_run =
      resumedTheRun(kept) &&
      Array.isArray(lost?.resumed?.steps) &&
      lost.resumed.steps.length === 0;
    // "Identical procedure" stated as an assertion rather than as prose: the two
    // agree on container replacement and image, and disagree ONLY on the volume.
    criteria.g05_only_the_volume_differed_from_g04 =
      g04.restart?.sameContainer === g05.restart?.sameContainer &&
      g04.restart?.sameImage === g05.restart?.sameImage &&
      g04.restart?.pinnedImage === g05.restart?.pinnedImage &&
      g04.restart?.sameVolume === true &&
      g05.restart?.sameVolume === false;
  }

  return criteria;
}

type StoreGuardVerdict = { allowed?: boolean; refusals?: Array<{ code: string; subject: string }> };

function storeGuardOf(bundle: CaseBundle | undefined): StoreGuardVerdict | undefined {
  return firstResult(bundle)?.verdict as StoreGuardVerdict | undefined;
}

function refusedWith(bundle: CaseBundle | undefined, code: string): boolean {
  return (storeGuardOf(bundle)?.refusals ?? []).some((refusal) => refusal.code === code);
}

/**
 * Family I: the per-thread lease and the Store guard.
 *
 * Both lanes are held to the plan's three rules for a mitigation — eliminate
 * only the stated target, fail loudly rather than degrade, and never erase the
 * stock negative. The third is mechanical (`pairedWith`), the second is checked
 * by requiring a typed refusal rather than a narrowed result, and the first is
 * checked by an in-family control that runs the identical code with the guard
 * switched off.
 */
function familyICriteria(bundles: Map<string, CaseBundle>): Record<string, boolean> {
  const criteria: Record<string, boolean> = {};
  const get = (id: string) => bundles.get(id);

  const i01 = get("i01-thread-lease-parallel-resume");
  const i01Barrier = i01?.coordination?.barriers?.[0];
  if (i01 && i01Barrier) {
    const results = liveResults(i01);
    const holders = results.filter((result) => result.leaseAcquired === true);
    const refused = results.filter((result) => result.leaseAcquired === false);
    criteria.i01_both_workers_were_released_together =
      i01Barrier.allArrivedBeforeRelease === true &&
      i01Barrier.peakConcurrentParties >= i01Barrier.partiesExpected &&
      i01Barrier.distinctNonces === i01Barrier.partiesExpected;
    // The whole point: two provably concurrent workers, exactly one executor.
    criteria.i01_exactly_one_worker_took_the_lease =
      holders.length === 1 && refused.length === 1;
    criteria.i01_the_refused_worker_executed_nothing =
      refused.every((result) => result.executed === false);
    // Refused, not failed. `awaiting_resource` is a real state in the
    // architecture's run machine, and the difference matters to a scheduler.
    criteria.i01_the_refused_worker_is_classified_awaiting_resource =
      refused.every((result) => result.classification === "awaiting_resource");
    criteria.i01_the_lease_lived_on_a_dedicated_session =
      holders.every((result) => result.leaseOnDedicatedBackend === true);
    criteria.i01_the_lease_was_released = holders.every((result) => result.leaseReleased === true);
    // The b02 duplicate, eliminated: one execution, one process, one head.
    criteria.i01_the_final_node_executed_exactly_once =
      executionOf(i01, "finish", "executed").executions === 1 &&
      executionOf(i01, "finish", "executed").processes === 1;
    criteria.i01_the_interrupt_was_consumed_once =
      executionOf(i01, "gate", "resumed").executions === 1;
    criteria.i01_lineage_did_not_fork =
      (threadOf(i01)?.leaves ?? []).filter((entry) => entry.ns === "").every(
        (entry) => entry.leaves.length === 1,
      ) && (threadOf(i01)?.leaves ?? []).length > 0;
  }

  const i02 = get("i02-thread-lease-disabled-control");
  if (i02) {
    criteria.i02_control_ran_both_workers_without_a_lease =
      liveResults(i02).length === 2 &&
      liveResults(i02).every((result) => result.leaseAcquired === true && result.guarded === false);
    // Stated as "every outcome is classified", not "it duplicated": whether the
    // unguarded lane forks is the b02 race, and asserting one answer here would
    // make the control fail for the interleaving rather than for the behaviour.
    criteria.i02_every_unguarded_outcome_is_classified =
      liveResults(i02).every((result) => "error" in result && "completed" in result);
  }
  if (i01 && i02) {
    // The differential that makes i01 attributable to the lease: the control
    // lets both workers through, the guarded lane lets exactly one.
    criteria.i01_the_lease_is_what_limits_execution_to_one_worker =
      liveResults(i02).filter((result) => result.executed === true).length === 2 &&
      liveResults(i01).filter((result) => result.executed === true).length === 1;
  }

  const i03 = get("i03-thread-lease-released-on-exit");
  if (i03) {
    const first = liveResults(i03).find((result) => result.party === 0);
    const second = liveResults(i03).find((result) => result.party === 1);
    criteria.i03_the_first_holder_took_and_released_the_lease =
      first?.leaseAcquired === true && first?.leaseReleased === true && first?.executed === false;
    // A lock-out would fail here, and nothing else in the family would notice.
    criteria.i03_the_next_worker_acquired_the_released_lease = second?.leaseAcquired === true;
    criteria.i03_the_run_completed_under_the_second_lease = second?.completed === true;
  }

  const refusals: Array<[string, string, string]> = [
    ["i04", "i04-store-guard-rejects-delimiter-in-a-label", "namespace_contains_delimiter"],
    ["i05", "i05-store-guard-rejects-wildcard-prefix", "namespace_contains_like_metacharacter"],
    ["i06", "i06-store-guard-rejects-zero-ttl", "ttl_zero_means_never_expires"],
    ["i07", "i07-store-guard-rejects-fail-open-filters", "filter_operator_not_recognised"],
  ];
  for (const [prefix, id, code] of refusals) {
    const bundle = get(id);
    if (!bundle) continue;
    const result = firstResult(bundle);
    criteria[`${prefix}_guard_refused_the_measured_unsafe_shape`] =
      storeGuardOf(bundle)?.allowed === false;
    criteria[`${prefix}_refusal_names_the_specific_hazard`] = refusedWith(bundle, code);
    // The Store is never touched. A guard that refused after calling would have
    // already written the row it objected to.
    criteria[`${prefix}_the_store_was_never_reached`] = result?.reached === false;
  }

  const i07 = get("i07-store-guard-rejects-fail-open-filters");
  if (i07) {
    // Both fail-open shapes d34 measured, in one operation, each named.
    criteria.i07_both_fail_open_shapes_were_named =
      refusedWith(i07, "filter_operator_not_recognised") &&
      refusedWith(i07, "filter_membership_list_is_empty");
  }

  const i08 = get("i08-store-guard-allows-safe-operations-control");
  if (i08) {
    const result = firstResult(i08);
    criteria.i08_guard_allowed_an_ordinary_operation = storeGuardOf(i08)?.allowed === true;
    criteria.i08_no_refusal_was_raised = (storeGuardOf(i08)?.refusals ?? []).length === 0;
    // Reached the Store AND came back with a written row: the anti-vacuity
    // check for the entire storeguard lane.
    criteria.i08_the_operation_reached_the_store_and_succeeded =
      result?.reached === true &&
      (result?.outcome as { written?: boolean } | undefined)?.written === true;
  }

  // d29's hazard is not refusable: the prefix is legal and the vendor's own
  // pattern crosses the boundary. The guard's work happens on the way back.
  const i09 = get("i09-store-guard-confines-a-prefix-to-the-path-boundary");
  if (i09) {
    const result = firstResult(i09);
    const outcome = result?.outcome as
      | { vendorNamespaces?: string[]; confinedNamespaces?: string[]; droppedNonDescendants?: number }
      | undefined;
    criteria.i09_guard_allowed_the_operation =
      storeGuardOf(i09)?.allowed === true && result?.reached === true;
    // d29 reproduced INSIDE the mitigation lane, so the guard is measured
    // against a live hazard rather than against one recorded elsewhere.
    criteria.i09_the_vendor_result_crossed_the_boundary =
      (outcome?.vendorNamespaces ?? []).includes("alphabet");
    criteria.i09_the_guard_dropped_only_the_non_descendant =
      outcome?.droppedNonDescendants === 1 &&
      !(outcome?.confinedNamespaces ?? []).includes("alphabet");
    // Anti-vacuity: a rule that emptied the result would satisfy the line above.
    criteria.i09_the_guard_did_not_empty_the_result =
      (outcome?.confinedNamespaces ?? []).length >= 2;
  }

  const i10 = get("i10-store-guard-rejects-maxdepth-with-a-limit");
  if (i10) {
    const result = firstResult(i10);
    criteria.i10_guard_refused_the_measured_unsafe_shape = storeGuardOf(i10)?.allowed === false;
    criteria.i10_refusal_names_the_specific_hazard = refusedWith(
      i10,
      "list_maxdepth_applied_after_paging",
    );
    criteria.i10_the_store_was_never_reached = result?.reached === false;
  }

  const i11 = get("i11-store-guard-allows-maxdepth-without-a-limit-control");
  if (i11) {
    const result = firstResult(i11);
    const outcome = result?.outcome as { confinedNamespaces?: string[] } | undefined;
    // The narrowness control: without it the rule is indistinguishable from
    // banning `maxDepth` outright, which would change more than its target.
    criteria.i11_guard_allowed_maxdepth_without_paging =
      storeGuardOf(i11)?.allowed === true && result?.reached === true;
    criteria.i11_the_depth_limited_listing_returned_a_result =
      (outcome?.confinedNamespaces ?? []).length > 0;
  }

  const i12 = get("i12-store-guard-allows-a-restrictive-recognized-filter-control");
  if (i12) {
    const result = firstResult(i12);
    const outcome = result?.outcome as { keys?: string[]; corpus?: number } | undefined;
    criteria.i12_guard_allowed_the_filter =
      storeGuardOf(i12)?.allowed === true && (storeGuardOf(i12)?.refusals ?? []).length === 0;
    criteria.i12_the_operation_reached_the_store_and_came_back = result?.reached === true;
    // A PROPER NON-EMPTY SUBSET. "It returned something" is satisfied by the
    // fail-open bug d34 found; only a proper subset shows the filter restricted.
    criteria.i12_the_filter_actually_restricted =
      (outcome?.keys ?? []).length > 0 &&
      (outcome?.keys ?? []).length < Number(outcome?.corpus ?? 0);
  }

  const guardCases: Array<[CaseBundle | undefined, boolean]> = [
    [get("i04-store-guard-rejects-delimiter-in-a-label"), false],
    [get("i05-store-guard-rejects-wildcard-prefix"), false],
    [get("i06-store-guard-rejects-zero-ttl"), false],
    [get("i07-store-guard-rejects-fail-open-filters"), false],
    [get("i10-store-guard-rejects-maxdepth-with-a-limit"), false],
    [get("i08-store-guard-allows-safe-operations-control"), true],
    [get("i09-store-guard-confines-a-prefix-to-the-path-boundary"), true],
    [get("i11-store-guard-allows-maxdepth-without-a-limit-control"), true],
    [get("i12-store-guard-allows-a-restrictive-recognized-filter-control"), true],
  ];
  if (guardCases.every(([bundle]) => bundle !== undefined)) {
    // The partition stated exhaustively, across all three operation shapes the
    // guard screens — put, listNamespaces and search. Before i09/i11/i12 the
    // allow side was proven for `put` alone, so "refuses only its stated target"
    // was unmeasured for two thirds of the surface.
    criteria.storeguard_refuses_exactly_the_measured_unsafe_shapes = guardCases.every(
      ([bundle, shouldReach]) => (firstResult(bundle)?.reached === true) === shouldReach,
    );
  }

  return criteria;
}

function familyHCompatCriteria(bundles: Map<string, CaseBundle>): Record<string, boolean> {
  const criteria: Record<string, boolean> = {};
  const get = (id: string) => bundles.get(id);
  const preparedPause = (bundle: CaseBundle | undefined): boolean => {
    const prepare = bundle?.prepare as
      | { reachedInterrupt?: boolean; interruptRows?: number }
      | null;
    return prepare?.reachedInterrupt === true && Number(prepare?.interruptRows ?? 0) > 0;
  };

  // --- stock lane: what the engine does when nothing stops it ---------------

  const h08 = get("h08-changed-graph-identical-control");
  if (h08) {
    const result = firstResult(h08);
    criteria.h08_prepare_paused_on_the_baseline_graph = preparedPause(h08);
    criteria.h08_identical_graph_is_manifest_compatible = verdictOf(h08)?.compatible === true;
    // The control that makes every refusal below meaningful: resuming this
    // fixture works when the graph has not changed.
    criteria.h08_identical_graph_resumes_and_completes = result?.completed === true;
    criteria.h08_resume_consumed_the_interrupt_once =
      executionOf(h08, "gate", "resumed").executions === 1 &&
      executionOf(h08, "finish", "executed").executions === 1;
    criteria.h08_persisted_state_advanced =
      result?.checkpointsUnchanged === false && result?.headUnchanged === false;
  }

  const h09 = get("h09-changed-graph-cosmetic");
  if (h09) {
    const result = firstResult(h09);
    criteria.h09_cosmetic_change_is_manifest_compatible = verdictOf(h09)?.compatible === true;
    // Neither half of the manifest sees it. If the fingerprint half did, the
    // normalisation rule would be a source-hash equality check that quarantines
    // every reformatting.
    criteria.h09_cosmetic_change_is_invisible_to_both_manifest_halves =
      result?.structureDiffers === false && result?.fingerprintsDiffer === false;
    criteria.h09_cosmetic_variant_resumes_and_completes = result?.completed === true;
  }

  const h10 = get("h10-changed-graph-renamed-node");
  if (h10) {
    const result = firstResult(h10);
    criteria.h10_renamed_node_changes_the_structural_manifest =
      result?.structureDiffers === true && verdictOf(h10)?.compatible === false;
    criteria.h10_reasons_name_both_sides_of_the_rename =
      hasReason(verdictOf(h10), "node-added", "approval") &&
      hasReason(verdictOf(h10), "node-removed", "gate");
    // CORRECTED after measurement, and worse than authored.
    //
    // The expectation was that the stock engine would resume into the wrong
    // branch. It does something quieter and harder to detect: it accepts the
    // resume, returns NO error and a result object, executes nothing at all, and
    // leaves the interrupt exactly where it was. The caller is told the run
    // succeeded while the approval it was waiting on is silently abandoned.
    criteria.h10_renamed_node_resume_reported_success =
      result?.invoked === true &&
      (result?.runs as Array<{ error: unknown }> | undefined)?.[0]?.error === null;
    criteria.h10_renamed_node_executed_no_node = executionsOf(h10).length === 0;
    criteria.h10_renamed_node_silently_abandoned_the_interrupt =
      result?.checkpointsUnchanged === true &&
      result?.interruptRowsUnchanged === true &&
      result?.headUnchanged === true;
  }

  const h11 = get("h11-changed-graph-added-channel");
  if (h11) {
    const result = firstResult(h11);
    criteria.h11_added_channel_changes_the_structural_manifest =
      result?.structureDiffers === true && verdictOf(h11)?.compatible === false;
    // Exactly one reason, and it is the channel. No node name and no node body
    // moved, which is what separates this from the rename case.
    criteria.h11_the_only_difference_is_the_added_channel =
      (verdictOf(h11)?.reasons ?? []).length === 1 &&
      hasReason(verdictOf(h11), "channel-added", "notes");
    // CORRECTED after measurement: a WIDENED state schema turns out to be
    // harmless. The persisted state simply lacks the new channel and its default
    // applies, so the resume consumes the interrupt and completes normally. The
    // guard refuses it anyway — see `h16_guard_refuses_a_variant_the_engine_tolerates`,
    // which records that over-refusal rather than hiding it.
    criteria.h11_added_channel_resumes_and_completes = result?.completed === true;
    criteria.h11_added_channel_consumed_the_interrupt =
      executionOf(h11, "gate", "resumed").executions === 1 &&
      executionOf(h11, "finish", "executed").executions === 1;
  }

  const h12 = get("h12-changed-graph-moved-interrupt");
  if (h12) {
    const result = firstResult(h12);
    // THE case. Moving `interrupt()` between nodes changes no node name and no
    // channel, so a manifest built from structure alone would pass it —
    // and architecture/09 says interrupt matching is positional, which is
    // exactly the position this moves.
    criteria.h12_moved_interrupt_is_structurally_invisible = result?.structureDiffers === false;
    criteria.h12_moved_interrupt_changes_node_fingerprints =
      result?.fingerprintsDiffer === true && verdictOf(h12)?.compatible === false;
    criteria.h12_reasons_name_both_changed_bodies =
      hasReason(verdictOf(h12), "node-body-changed", "gate") &&
      hasReason(verdictOf(h12), "node-body-changed", "finish");
    // CORRECTED after measurement. The authored expectation was that the stock
    // engine resumes and completes. It does not: the decision payload is
    // delivered to a position that no longer interrupts, the run advances past
    // the old pause point and raises a NEW interrupt at the node the call moved
    // to. The original approval is consumed by nothing and a fresh one is now
    // outstanding — "resuming into the wrong branch", measured.
    criteria.h12_moved_interrupt_did_not_complete =
      result?.completed === false &&
      (result?.runs as Array<{ interrupted: boolean }> | undefined)?.[0]?.interrupted === true;
    criteria.h12_moved_interrupt_advanced_the_persisted_head =
      result?.headUnchanged === false && result?.checkpointsUnchanged === false;
  }

  // --- mitigation lane: the guard --------------------------------------------

  const allowed: Array<[string, string]> = [
    ["h13", "h13-compat-guard-identical"],
    ["h14", "h14-compat-guard-cosmetic"],
  ];
  for (const [prefix, id] of allowed) {
    const bundle = get(id);
    if (!bundle) continue;
    const result = firstResult(bundle);
    // Anti-vacuity for the whole lane: a guard that refused everything would
    // satisfy every refusal criterion below while being useless.
    criteria[`${prefix}_guard_allowed_the_resume`] =
      verdictOf(bundle)?.code === "compatible" && result?.invoked === true;
    criteria[`${prefix}_guarded_resume_completed`] = result?.completed === true;
    criteria[`${prefix}_guard_left_unrelated_semantics_alone`] =
      executionOf(bundle, "gate", "resumed").executions === 1 &&
      executionOf(bundle, "finish", "executed").executions === 1;
  }

  const refused: Array<[string, string, string, string]> = [
    ["h15", "h15-compat-guard-renamed-node", "node-removed", "gate"],
    ["h16", "h16-compat-guard-added-channel", "channel-added", "notes"],
    ["h17", "h17-compat-guard-moved-interrupt", "node-body-changed", "gate"],
  ];
  for (const [prefix, id, kind, subject] of refused) {
    const bundle = get(id);
    if (!bundle) continue;
    const result = firstResult(bundle);
    criteria[`${prefix}_guard_refused_with_a_stable_typed_code`] =
      verdictOf(bundle)?.code === "graph_incompatible" && verdictOf(bundle)?.compatible === false;
    criteria[`${prefix}_refusal_names_the_specific_change`] =
      hasReason(verdictOf(bundle), kind, subject);
    // Before invocation, not after. A guard that refused after invoking would
    // already have consumed the interrupt it exists to protect.
    criteria[`${prefix}_guard_refused_before_invoking`] = result?.invoked === false;
    criteria[`${prefix}_persisted_state_is_untouched`] =
      result?.checkpointsUnchanged === true &&
      result?.interruptRowsUnchanged === true &&
      result?.headUnchanged === true;
    // Nothing ran at all. `executions` is deliberately NOT a declared oracle on
    // these cases — its presence check requires a non-empty set, and an empty
    // set is the result here.
    criteria[`${prefix}_no_graph_node_executed`] = executionsOf(bundle).length === 0;
  }

  // --- the pairings ----------------------------------------------------------

  const h17 = get("h17-compat-guard-moved-interrupt");
  if (h17) {
    const result = firstResult(h17);
    // The justification for fingerprinting node bodies at all: this refusal
    // rests on the fingerprint half alone.
    criteria.h17_refusal_rests_on_the_fingerprint_half_alone =
      result?.structureDiffers === false && result?.fingerprintsDiffer === true;
  }

  const h16 = get("h16-compat-guard-added-channel");
  if (h11 && h16) {
    // Recorded, not hidden. The guard is fail-closed on a changed channel set,
    // and h11 measured that the engine tolerates a WIDENED one. So this refusal
    // is stricter than the engine requires — a deliberate cost of a rule that
    // cannot tell a widened schema from a narrowed one without deciding semantic
    // equivalence. A mitigation that quietly over-refused would be a mitigation
    // that changed more than its stated target.
    criteria.h16_guard_refuses_a_variant_the_engine_tolerates =
      firstResult(h11)?.completed === true && firstResult(h16)?.invoked === false;
  }

  const h13 = get("h13-compat-guard-identical");
  if (h08 && h13) {
    criteria.h13_guard_reproduces_its_stock_pair =
      firstResult(h08)?.completed === firstResult(h13)?.completed &&
      firstResult(h13)?.completed === true;
  }

  // The mitigation eliminates its target and nothing else: every unsafe variant
  // is refused, every safe one still resumes.
  const guarded = [
    get("h13-compat-guard-identical"),
    get("h14-compat-guard-cosmetic"),
    get("h15-compat-guard-renamed-node"),
    get("h16-compat-guard-added-channel"),
    get("h17-compat-guard-moved-interrupt"),
  ];
  if (guarded.every((bundle) => bundle !== undefined)) {
    const invokedFlags = guarded.map((bundle) => firstResult(bundle)?.invoked === true);
    criteria.compat_guard_refuses_exactly_the_unsafe_variants =
      invokedFlags[0] === true &&
      invokedFlags[1] === true &&
      invokedFlags[2] === false &&
      invokedFlags[3] === false &&
      invokedFlags[4] === false;
  }

  return criteria;
}

export function summarize(rawBundles: unknown[]): Record<string, unknown> {
  const bundles = rawBundles as CaseBundle[];
  const byId = new Map(bundles.map((bundle) => [bundle.case, bundle]));

  const faults: string[] = [];

  for (const bundle of bundles) {
    const definition = caseById(bundle.case);
    if (!definition) {
      faults.push(`bundle for unknown case ${bundle.case}`);
      continue;
    }
    if (bundle.workers.length !== definition.parties) {
      faults.push(
        `${bundle.case}: ${bundle.workers.length} worker bundles for ${definition.parties} declared parties`,
      );
    }
    for (const oracle of definition.oracles) {
      if (!ORACLE_PRESENT[oracle](bundle)) {
        faults.push(`${bundle.case}: declared oracle "${oracle}" produced nothing`);
      }
    }
    if (isMitigation(bundle.lane) && definition.pairedWith && !byId.has(definition.pairedWith)) {
      faults.push(`${bundle.case}: mitigation ran without its stock pair in the same evidence set`);
    }
  }

  const lanes = [...new Set(bundles.map((bundle) => bundle.lane))].sort();
  const managedByLane: Record<string, unknown[]> = {};
  for (const lane of lanes) managedByLane[lane] = [];
  for (const bundle of bundles) {
    const definition = caseById(bundle.case);
    if (!definition) continue;
    managedByLane[bundle.lane]!.push(managedCase(bundle, definition));
  }
  for (const lane of lanes) {
    managedByLane[lane]!.sort((left, right) =>
      stable(left) < stable(right) ? -1 : stable(left) > stable(right) ? 1 : 0,
    );
  }

  const perLaneDigests: Record<string, string> = {};
  for (const lane of lanes) perLaneDigests[lane] = digest(managedByLane[lane]);
  const overallDigest = digest(
    lanes.map((lane) => ({ lane, digest: perLaneDigests[lane] })),
  );

  const global: Record<string, boolean> = {
    // Renamed to what it actually checks. The old name promised registry
    // coverage and delivered the converse — every PRESENT bundle maps to a known
    // case — so a run missing cases entirely would still have reported it true.
    // Coverage of the selected set is enforced by the driver, which faults on any
    // missing bundle, and is asserted separately below for a full run.
    every_present_case_is_registered: bundles.every(
      (bundle) => caseById(bundle.case) !== undefined,
    ),
    every_worker_reported_json: bundles.every((bundle) =>
      bundle.workers
        .filter((worker) => worker.party !== bundle.kill?.party)
        .every((worker) => worker.output !== null),
    ),
    every_worker_posture_measured: bundles.every((bundle) =>
      bundle.workers.every((worker) => postureOk(worker.posture)),
    ),
    every_mitigation_has_stock_pair: bundles.every((bundle) => {
      const definition = caseById(bundle.case);
      if (!definition || !isMitigation(bundle.lane)) return true;
      return definition.pairedWith !== null && byId.has(definition.pairedWith);
    }),
    no_declared_oracle_missing: faults.length === 0,
  };

  const laneCriteria: Record<string, Record<string, boolean>> = {};
  if (lanes.includes("selftest")) laneCriteria.selftest = selftestCriteria(byId);

  // Family A spans two lanes on purpose: the safeguard's own criteria live in
  // `mit-migration` so a green mitigation can never raise the stock lane's
  // status, while the comparison against the stock pair stays visible.
  const familyA = familyACriteria(byId);
  for (const [key, value] of Object.entries(familyA)) {
    const lane = key.startsWith("a13_") ? "mit-migration" : "stock";
    if (!lanes.includes(lane)) continue;
    laneCriteria[lane] ??= {};
    laneCriteria[lane]![key] = value;
  }

  // Family H's changed-graph matrix spans two lanes for the same reason family A
  // does: the guard's own criteria live in `mit-compat`, so a green mitigation
  // can never raise the stock lane's status, while the stock characterisation of
  // each variant stays visible beside it.
  // Family I spans three lanes: the guarded cases belong to their mitigation
  // lane, the in-family control to `stock`.
  // Routed from the REGISTRY, not by parsing the criterion key. The previous
  // form read a positional digit, so a future `i10_` criterion would have parsed
  // as `0` and landed in the wrong lane — and a mitigation criterion in the stock
  // lane is precisely the separation the plan forbids breaking.
  const familyI = familyICriteria(byId);
  const laneOfPrefix = (key: string): LaneId => {
    const id = key.slice(0, 3);
    const entry = CASES.find((candidate) => candidate.id.startsWith(`${id}-`));
    return entry?.lane ?? "mit-storeguard";
  };
  for (const [key, value] of Object.entries(familyI)) {
    const lane = key.startsWith("storeguard_") ? "mit-storeguard" : laneOfPrefix(key);
    if (!lanes.includes(lane)) continue;
    laneCriteria[lane] ??= {};
    laneCriteria[lane]![key] = value;
  }

  const familyHCompat = familyHCompatCriteria(byId);
  for (const [key, value] of Object.entries(familyHCompat)) {
    const lane = /^h(?:08|09|10|11|12)_/.test(key) ? "stock" : "mit-compat";
    if (!lanes.includes(lane)) continue;
    laneCriteria[lane] ??= {};
    laneCriteria[lane]![key] = value;
  }

  if (lanes.includes("stock")) {
    laneCriteria.stock ??= {};
    Object.assign(
      laneCriteria.stock,
      familyBCriteria(byId),
      familyCCriteria(byId),
      familyDCriteria(byId),
      familyDBatchCriteria(byId),
      familyDQueryCriteria(byId),
      familyDSearchCriteria(byId),
      familyECriteria(byId),
      familyFCriteria(byId),
      familyGCriteria(byId),
      familyHCriteria(byId),
    );
  }

  for (const lane of lanes) laneCriteria[lane] ??= {};

  const flattened: Record<string, boolean> = { ...global };
  for (const [lane, criteria] of Object.entries(laneCriteria)) {
    for (const [key, value] of Object.entries(criteria)) flattened[`${lane}.${key}`] = value;
  }

  const outcome: Outcome =
    faults.length > 0
      ? { status: "fault", fault: { step: "oracle-presence", message: faults.join("; ") } }
      : outcomeFor(flattened);

  // One entry per bounded-trials case, computed here rather than in the driver
  // so the reduction is version-locked to the criteria it must stay honest
  // against. The driver's only remaining job is to group these across repeats
  // and count occurrences.
  const observations = bundles
    .filter((bundle) => caseById(bundle.case)?.classification === "bounded-trials")
    .map((bundle) => ({
      case: bundle.case,
      lane: bundle.lane,
      // Named so the driver's completeness check can assert that every field
      // `managedProjection` elided is answered here, rather than only that the
      // case appears at all.
      covers: [...RACED_FIELDS],
      observation: observationFor(bundle),
    }))
    .sort((left, right) => (left.case < right.case ? -1 : 1));

  return {
    cases: bundles.map((bundle) => bundle.case),
    lanes,
    registry: CASES.map((entry) => entry.id),
    managed: managedByLane,
    findings: bundles.map(findingsFor),
    observations,
    managed_digests: { per_lane: perLaneDigests, overall: overallDigest },
    acceptance: { global, lanes: laneCriteria, flat: flattened },
    outcome,
  };
}
