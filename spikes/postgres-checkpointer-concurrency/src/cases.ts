// The case registry.
//
// Three fields have no Spike 05 equivalent and are load-bearing:
//
//   oracles         declared here, then VERIFIED PRESENT by summarize. Spike 05
//                   enforced "no criterion may pass on missing data" check by
//                   check; at this scale that has to be structural or one case
//                   in a hundred will silently assert over an empty array.
//   classification  precommits which cases are deterministic and which need
//                   bounded repeated classification. A bounded case reports an
//                   observed outcome set and is never called race-free.
//   pairedWith      makes "a mitigation may not erase the stock result"
//                   mechanical: the driver expands any selection to include the
//                   stock pair of every selected mitigation case.

import type { FamilyId, Provision } from "./families.ts";
import type { LaneId } from "./lanes.ts";
import { isMitigation } from "./lanes.ts";

export type StageSpec = {
  name: string;
  parties: number;
  /** Poll until a blocked -> blocking edge exists, then record it, then release. */
  captureLockEdge?: boolean;
  /** Sample pg_stat_activity while the parties are parked. */
  captureActivity?: boolean;
};

export type OracleId =
  | "pins"
  | "relations"
  | "egress"
  | "posture"
  | "barrier"
  | "activity"
  | "statements"
  | "lockEdge"
  | "embeddings"
  | "clusterIdentity"
  | "drain"
  | "projection"
  | "ledger"
  | "sqlstate"
  | "advisoryLock"
  /** Raw thread lineage projected from the tables, not read back through the API. */
  | "lineage"
  /** Node executions counted from the independent probe. */
  | "executions"
  /** Which candidate payload owns each stored row. */
  | "conflict"
  | "reachability"
  /** Rows counted after a kill, on a connection that never touched the victim. */
  | "survivors"
  /** Store items and vectors read straight from the tables. */
  | "storeProjection"
  /** Which candidate payload owns the surviving Store row, and which owns its vectors. */
  | "storeConflict"
  /**
   * The proposed idempotency key, collected twice over: as each node saw itself
   * while running, and as `checkpoint_writes` records it afterwards. Declaring
   * it is also what makes the projector emit both sides.
   */
  | "effectKey"
  /** A typed compatibility verdict produced before the engine was invoked. */
  | "compatibility"
  /** A per-thread advisory lease, taken on a dedicated session. */
  | "threadLease"
  /** A typed Store refusal produced before the Store was touched. */
  | "storeGuard";

/**
 * A kill is anchored to an observed durable gate-park row, never to a sleep.
 * A sleep before a kill is the single most common way this class of experiment
 * produces a result that cannot be reproduced.
 */
export type KillSpec = {
  party: number;
  gate: string;
  signal: string;
};

/**
 * A database-stack action the driver performs BETWEEN two parties.
 *
 * Between, not inside: acting on the server while a worker still holds pooled
 * connections to it measures pg's reconnect behaviour, which is a different
 * question from the architecture's — whether persisted state survives the stack
 * that wrote it being taken away and rebuilt.
 */
export type RestartSpec = {
  /**
   * The action fires once this party has exited.
   *
   * Mutually exclusive with `atGate`. "After the party exits" is the right
   * trigger for asking whether persisted state survives the stack that wrote it;
   * it is the WRONG trigger for asking what a caller sees when the server dies
   * underneath it, because by then there is no caller.
   */
  afterParty?: number;
  /**
   * The action fires while a party is still running, once it has parked on a
   * durable `gate_park` row with this name.
   *
   * This is what makes "the database died under a live worker" measurable at
   * all: the party is blocked inside a real checkpointer call when the server
   * goes away, and it survives to report the error it saw.
   */
  atGate?: { party: number; gate: string };
  action:
    /** `docker restart`: a clean shutdown and a clean start. */
    | "graceful-restart"
    /** `SIGKILL` then start: the server must perform crash recovery. */
    | "unclean-kill"
    /** Container removed and recreated from the pinned image on the SAME volume. */
    | "replace-stack"
    /** Recreated on a NEW volume, then re-provisioned so the schema exists and the state does not. */
    | "fresh-volume";
};

export type CaseDef = {
  id: string;
  family: FamilyId;
  lane: LaneId;
  pairedWith: string | null;
  kind: "candidate" | "control" | "mutation";
  parties: number;
  launch: "parallel" | "sequential";
  stages: StageSpec[];
  kill: KillSpec | null;
  /** A database-stack action performed between two parties. Family G only. */
  restart?: RestartSpec;
  /**
   * Overrides the family's provisioning for THIS case's database.
   *
   * Family D defaults to a migrated Store, but several of its cases have to
   * begin with no store tables at all: whether `setup()` ran, what
   * `ensureTables: false` does against a cold schema, and where
   * `CREATE EXTENSION` puts the extension are all decided by the starting state.
   * Provisioning them like the rest would answer the question before the case
   * ran. Absent means "inherit the family".
   */
  provision?: Provision;
  /** A fixture the driver must build before any party starts. */
  prepare: boolean;
  oracles: OracleId[];
  classification: "deterministic" | "bounded-trials";
  /**
   * Trials PER REPEAT. A race whose participants are containers cannot be
   * cheaply repeated inside one case — each trial needs a cold database — so the
   * observed outcome set is aggregated across the run's isolated repeats
   * instead. Three repeats is three samples, and the report says so rather than
   * calling a single observed profile the behaviour.
   */
  trials: number | null;
  budgetMs: number;
  requires: string[];
  purpose: string;
};

export const CASES: CaseDef[] = [
  {
    id: "s01-pins",
    family: "S",
    lane: "selftest",
    pairedWith: null,
    kind: "candidate",
    parties: 1,
    launch: "parallel",
    stages: [],
    kill: null,
    prepare: false,
    oracles: ["pins", "relations", "egress", "posture"],
    classification: "deterministic",
    trials: null,
    budgetMs: 45_000,
    requires: [],
    purpose:
      "Installed packages, lockfile and fixture manifest agree; the harness schema exists; the container is genuinely isolated and unprivileged.",
  },
  {
    id: "s02-barrier-overlap",
    family: "S",
    lane: "selftest",
    pairedWith: null,
    kind: "candidate",
    parties: 4,
    launch: "parallel",
    stages: [{ name: "gather", parties: 4, captureActivity: true }],
    kill: null,
    prepare: false,
    oracles: ["barrier", "activity"],
    classification: "deterministic",
    trials: null,
    budgetMs: 90_000,
    requires: [],
    purpose:
      "Four containers are simultaneously parked before any is released, proven by four arrival rows on four distinct backends plus an independent backend sample taken while they wait.",
  },
  {
    id: "s03-barrier-serial-control",
    family: "S",
    lane: "selftest",
    pairedWith: null,
    kind: "control",
    parties: 4,
    launch: "sequential",
    stages: [
      { name: "gather-0", parties: 1, captureActivity: true },
      { name: "gather-1", parties: 1, captureActivity: true },
      { name: "gather-2", parties: 1, captureActivity: true },
      { name: "gather-3", parties: 1, captureActivity: true },
    ],
    kill: null,
    prepare: false,
    oracles: ["barrier", "activity"],
    classification: "deterministic",
    trials: null,
    budgetMs: 120_000,
    requires: ["s02-barrier-overlap"],
    purpose:
      "The load-bearing control for s02: the same four participants run one at a time and the overlap witness must fall to one. Without it, 's02 showed four parties' could be satisfied by a fast sequence.",
  },
  {
    id: "s04-gate-passthrough",
    family: "S",
    lane: "selftest",
    pairedWith: null,
    kind: "candidate",
    parties: 1,
    launch: "parallel",
    stages: [],
    kill: null,
    prepare: false,
    oracles: ["statements"],
    classification: "deterministic",
    trials: null,
    budgetMs: 90_000,
    requires: [],
    purpose:
      "An armed-and-immediately-released statement gate produces a byte-identical statement multiset to an ungated run of the same vendor operations, and every statement the vendor emitted is classified.",
  },
  {
    id: "s05-lock-edge",
    family: "S",
    lane: "selftest",
    pairedWith: null,
    kind: "candidate",
    parties: 2,
    launch: "parallel",
    stages: [
      { name: "ready", parties: 2 },
      { name: "hold", parties: 1, captureLockEdge: true },
    ],
    kill: null,
    prepare: false,
    oracles: ["barrier", "lockEdge"],
    classification: "deterministic",
    trials: null,
    budgetMs: 90_000,
    requires: [],
    purpose:
      "A deliberately constructed row-lock conflict whose cause is known, so the lock-graph inspector is validated against a blocked -> blocking edge it must find and attribute.",
  },
  {
    id: "s06-embedding-oracle",
    family: "S",
    lane: "selftest",
    pairedWith: null,
    kind: "candidate",
    parties: 1,
    launch: "parallel",
    stages: [],
    kill: null,
    prepare: false,
    oracles: ["embeddings"],
    classification: "deterministic",
    trials: null,
    budgetMs: 45_000,
    requires: [],
    purpose:
      "The authored rankings agree with independently computed arithmetic over the frozen vectors, the three metric orderings are pairwise distinct, and unknown text is refused rather than hashed.",
  },
  {
    id: "s07-shutdown-witness-positive-control",
    family: "S",
    lane: "selftest",
    pairedWith: null,
    kind: "control",
    parties: 1,
    launch: "sequential",
    stages: [],
    // The ONLY case in the matrix that delivers SIGTERM rather than SIGKILL.
    kill: { party: 0, gate: "await-sigterm", signal: "TERM" },
    prepare: false,
    oracles: ["projection", "drain"],
    classification: "deterministic",
    trials: null,
    budgetMs: 90_000,
    requires: [],
    purpose:
      "The positive control for the shutdown witness. Eleven kill cases prove their SIGKILL was uncatchable by asserting NO process/sigterm row exists - but every one of them sends SIGKILL, so the handler that writes that row had never fired anywhere in the matrix and the witness was empty in all 131 cases. This case delivers a SIGTERM and requires exactly one witness row, which is what makes those eleven absences load-bearing rather than vacuous.",
  },
];

const FAMILY_A: CaseDef[] = [
  {
    id: "a01-saver-setup-serial",
    family: "A",
    lane: "stock",
    pairedWith: null,
    kind: "control",
    parties: 1,
    launch: "parallel",
    stages: [],
    kill: null,
    prepare: false,
    oracles: ["projection", "ledger", "sqlstate", "statements"],
    classification: "deterministic",
    trials: null,
    budgetMs: 60_000,
    requires: [],
    purpose:
      "The baseline every race is scored against: one process, cold schema, no contention. Establishes the terminal relation set and the contiguous ledger, and must raise nothing.",
  },
  {
    id: "a02-saver-setup-race-passive",
    family: "A",
    lane: "stock",
    pairedWith: null,
    kind: "candidate",
    parties: 4,
    launch: "parallel",
    stages: [{ name: "gathered", parties: 4, captureActivity: true }],
    kill: null,
    prepare: false,
    oracles: ["barrier", "projection", "ledger", "sqlstate"],
    classification: "bounded-trials",
    trials: 1,
    budgetMs: 120_000,
    requires: ["a01-saver-setup-serial"],
    purpose:
      "The uninstrumented lane: four processes call setup() behind a barrier and whatever happens is recorded. It proves the processes started together and NOT that they all read an empty ledger, so its outcome is reported as an observed set across repeats rather than as a guarantee.",
  },
  {
    id: "a03-saver-setup-race-gated",
    family: "A",
    lane: "stock",
    pairedWith: null,
    kind: "candidate",
    parties: 4,
    launch: "parallel",
    stages: [{ name: "read-empty", parties: 4, captureActivity: true }],
    kill: null,
    prepare: false,
    oracles: ["barrier", "projection", "ledger", "sqlstate", "statements"],
    classification: "bounded-trials",
    trials: 1,
    budgetMs: 150_000,
    requires: ["a01-saver-setup-serial"],
    purpose:
      "The deterministic lane: every racer parks immediately after its migration-version read has SETTLED, so 'all four saw an empty ledger' is recorded rather than assumed. The read legitimately rejects with 42P01 on a cold schema, which is why the gate fires on rejection as well as fulfilment.",
  },
  {
    id: "a04-saver-setup-gated-sequential-control",
    family: "A",
    lane: "stock",
    pairedWith: null,
    kind: "control",
    parties: 4,
    launch: "parallel",
    stages: [
      { name: "gate-0", parties: 1 },
      { name: "done-0", parties: 1 },
      { name: "gate-1", parties: 1 },
      { name: "done-1", parties: 1 },
      { name: "gate-2", parties: 1 },
      { name: "done-2", parties: 1 },
      { name: "gate-3", parties: 1 },
      { name: "done-3", parties: 1 },
    ],
    kill: null,
    prepare: false,
    oracles: ["barrier", "projection", "ledger", "sqlstate"],
    classification: "deterministic",
    trials: null,
    budgetMs: 240_000,
    requires: ["a03-saver-setup-race-gated"],
    purpose:
      "The control that makes a03's claim load-bearing: the same four racers park BEFORE the version read and are released one at a time, each completing before the next starts. Later racers must then read a populated ledger and raise nothing. Without it, 'they all read -1' could not be distinguished from 'the gate did nothing'.",
  },
  {
    id: "a05-saver-setup-kill-before-ledger",
    family: "A",
    lane: "stock",
    pairedWith: null,
    kind: "candidate",
    parties: 2,
    launch: "sequential",
    stages: [],
    kill: { party: 0, gate: "ledger-pre", signal: "KILL" },
    prepare: false,
    oracles: ["projection", "ledger", "sqlstate", "drain"],
    classification: "deterministic",
    trials: null,
    budgetMs: 180_000,
    requires: ["a01-saver-setup-serial"],
    purpose:
      "A migrator killed between a migration's DDL and its ledger insert, leaving a schema ahead of the ledger. A second process then retries, and the terminal schema must converge to the a01 baseline.",
  },
  {
    id: "a06-store-setup-serial",
    family: "A",
    lane: "stock",
    pairedWith: null,
    kind: "control",
    parties: 1,
    launch: "parallel",
    stages: [],
    kill: null,
    prepare: false,
    oracles: ["projection", "ledger", "sqlstate"],
    classification: "deterministic",
    trials: null,
    budgetMs: 90_000,
    requires: [],
    purpose:
      "The Store baseline with an index configuration: the vector extension, the vectors table, one metric index, and a six-entry ledger, all from one uncontended process.",
  },
  {
    id: "a07-store-setup-race-gated",
    family: "A",
    lane: "stock",
    pairedWith: null,
    kind: "candidate",
    parties: 4,
    launch: "parallel",
    stages: [{ name: "read-empty", parties: 4, captureActivity: true }],
    kill: null,
    prepare: false,
    oracles: ["barrier", "projection", "ledger", "sqlstate"],
    classification: "bounded-trials",
    trials: 1,
    budgetMs: 180_000,
    requires: ["a06-store-setup-serial"],
    purpose:
      "The Store's own cold race, with the extra hazards the checkpointer does not have: CREATE EXTENSION, a plpgsql function, a trigger and index builds all inside the same unlocked migration loop.",
  },
  {
    id: "a08-store-trigger-race",
    family: "A",
    lane: "stock",
    pairedWith: null,
    kind: "candidate",
    parties: 2,
    launch: "parallel",
    stages: [{ name: "read-v2", parties: 2 }],
    kill: null,
    prepare: true,
    oracles: ["barrier", "projection", "ledger", "sqlstate"],
    classification: "bounded-trials",
    trials: 1,
    budgetMs: 120_000,
    requires: ["a06-store-setup-serial"],
    purpose:
      "Isolates migration 3, the only one whose DDL creates a trigger. The ledger is rewound to 2 and the trigger dropped, so both racers replay exactly that block. Its bare CREATE TRIGGER is preceded by a DROP TRIGGER IF EXISTS and the whole migration is one simple-query batch in an implicit transaction, so the prediction is that replay converges rather than raising 42710 — and the measurement is whether the trigger exists exactly once afterwards and which SQLSTATE, if any, the loser actually gets.",
  },
  {
    id: "a09-store-lazy-same-process",
    family: "A",
    lane: "stock",
    pairedWith: null,
    kind: "candidate",
    parties: 1,
    launch: "parallel",
    stages: [],
    kill: null,
    prepare: false,
    oracles: ["projection", "ledger", "sqlstate", "statements"],
    classification: "bounded-trials",
    trials: 1,
    budgetMs: 120_000,
    requires: [],
    purpose:
      "Eight concurrent first operations inside ONE process, with lazy setup enabled. The guard sets isSetup only after the awaited migrations finish, so this is a same-process race with no second container involved.",
  },
  {
    id: "a10-store-lazy-awaited-control",
    family: "A",
    lane: "stock",
    pairedWith: null,
    kind: "control",
    parties: 1,
    launch: "parallel",
    stages: [],
    kill: null,
    prepare: false,
    oracles: ["projection", "ledger", "sqlstate", "statements"],
    classification: "deterministic",
    trials: null,
    budgetMs: 120_000,
    requires: ["a09-store-lazy-same-process"],
    purpose:
      "The control for a09: the identical eight operations after an awaited setup() must issue no migration statements at all. Without it, 'the migration loop was entered N times' could not be attributed to laziness.",
  },
  {
    id: "a11-store-index-config-change",
    family: "A",
    lane: "stock",
    pairedWith: null,
    kind: "candidate",
    parties: 1,
    launch: "parallel",
    stages: [],
    kill: null,
    prepare: false,
    oracles: ["projection", "ledger", "sqlstate"],
    classification: "deterministic",
    trials: null,
    budgetMs: 120_000,
    requires: ["a06-store-setup-serial"],
    purpose:
      "The ledger records positions while the migration list's content depends on the index configuration. A restart with different dimensions must therefore run nothing, leave the column at its original width, and only surface the mismatch on the write path.",
  },
  {
    id: "a12-colocated-schemas",
    family: "A",
    lane: "stock",
    pairedWith: null,
    kind: "candidate",
    parties: 1,
    launch: "parallel",
    stages: [],
    kill: null,
    prepare: false,
    oracles: ["projection", "sqlstate"],
    classification: "deterministic",
    trials: null,
    budgetMs: 120_000,
    requires: [],
    purpose:
      "Whether the architecture's schema separation is a necessity or a choice: both components migrated into one schema, with the relation set projected from the catalog to show whether anything collides.",
  },
  {
    id: "a13-saver-setup-advisory-lock",
    family: "A",
    lane: "mit-migration",
    pairedWith: "a03-saver-setup-race-gated",
    kind: "candidate",
    parties: 4,
    launch: "parallel",
    stages: [{ name: "gathered", parties: 4, captureActivity: true }],
    kill: null,
    prepare: false,
    oracles: ["barrier", "projection", "ledger", "sqlstate", "advisoryLock"],
    classification: "deterministic",
    trials: null,
    budgetMs: 180_000,
    requires: ["a01-saver-setup-serial"],
    purpose:
      "The safeguard: a dedicated session holds a session-level advisory lock across the STOCK setup(), which runs unmodified. Its removal mutation is a03 itself, which must show the negative return.",
  },
];

const FAMILY_B: CaseDef[] = [
  {
    id: "b01-graph-serial-baseline",
    family: "B",
    lane: "stock",
    pairedWith: null,
    kind: "control",
    parties: 1,
    launch: "parallel",
    stages: [],
    kill: null,
    prepare: false,
    oracles: ["lineage", "executions", "sqlstate", "projection"],
    classification: "deterministic",
    trials: null,
    budgetMs: 120_000,
    requires: [],
    purpose:
      "One process runs the thread to the interrupt and then resumes it. Establishes how many times each node executes when nothing is contended, which is what makes a duplicate-execution claim in b02 mean anything: without it, 'finish ran twice' cannot be told apart from 'the engine always replays that superstep'.",
  },
  {
    id: "b02-same-thread-parallel-resume",
    family: "B",
    lane: "stock",
    pairedWith: null,
    kind: "candidate",
    parties: 2,
    launch: "parallel",
    stages: [{ name: "resume-ready", parties: 2, captureActivity: true }],
    kill: null,
    prepare: true,
    oracles: ["barrier", "lineage", "executions", "sqlstate", "projection", "reachability"],
    classification: "bounded-trials",
    trials: 1,
    budgetMs: 180_000,
    requires: ["b01-graph-serial-baseline"],
    purpose:
      "Two fresh containers resume the SAME committed interrupt simultaneously, same thread_id, no checkpoint_id, durability sync. The oracle is the independent probe — node executions attributed to distinct process nonces — plus the raw lineage, not the terminal graph output, which both workers can make look plausible.",
  },
  {
    id: "b03-same-thread-sequential-control",
    family: "B",
    lane: "stock",
    pairedWith: null,
    kind: "control",
    parties: 2,
    launch: "parallel",
    stages: [
      { name: "gate-0", parties: 1 },
      { name: "done-0", parties: 1 },
      { name: "gate-1", parties: 1 },
      { name: "done-1", parties: 1 },
    ],
    kill: null,
    prepare: true,
    oracles: ["barrier", "lineage", "executions", "sqlstate", "projection"],
    classification: "deterministic",
    trials: null,
    budgetMs: 180_000,
    requires: ["b02-same-thread-parallel-resume"],
    purpose:
      "The control that localises b02 to CONCURRENCY: the identical two workers resume the identical fixture one at a time, each completing before the next starts. If the second worker re-executes here too, the finding is about resuming a finished thread rather than about racing, and b02 must not be reported as a concurrency defect.",
  },
  {
    id: "b04-put-conflict-metadata",
    family: "B",
    lane: "stock",
    pairedWith: null,
    kind: "candidate",
    parties: 2,
    launch: "parallel",
    stages: [{ name: "ready", parties: 2, captureActivity: true }],
    kill: null,
    prepare: false,
    oracles: ["barrier", "conflict", "sqlstate", "projection"],
    classification: "bounded-trials",
    trials: 1,
    budgetMs: 120_000,
    requires: [],
    purpose:
      "Two raw put() calls with the SAME checkpoint id and different metadata. The checkpoints upsert is ON CONFLICT DO UPDATE, so the source predicts last-writer-wins; the measurement is whether exactly one writer owns the row and whether the surviving metadata is one writer's or a merge of both.",
  },
  {
    id: "b05-blob-conflict-bytes",
    family: "B",
    lane: "stock",
    pairedWith: null,
    kind: "candidate",
    parties: 2,
    launch: "parallel",
    stages: [{ name: "ready", parties: 2, captureActivity: true }],
    kill: null,
    prepare: false,
    oracles: ["barrier", "conflict", "sqlstate", "projection"],
    classification: "bounded-trials",
    trials: 1,
    budgetMs: 120_000,
    requires: [],
    purpose:
      "Two put() calls with DIFFERENT checkpoint ids but the same (channel, version) and different bytes. The blob upsert is ON CONFLICT DO NOTHING, so the source predicts first-writer-wins — meaning the loser's checkpoint row survives while pointing at bytes it did not write.",
  },
  {
    id: "b06-checkpoint-and-blob-split",
    family: "B",
    lane: "stock",
    pairedWith: null,
    kind: "candidate",
    parties: 2,
    launch: "parallel",
    stages: [{ name: "ready", parties: 2, captureActivity: true }],
    kill: null,
    prepare: false,
    oracles: ["barrier", "conflict", "sqlstate", "projection", "reachability"],
    classification: "bounded-trials",
    trials: 1,
    budgetMs: 120_000,
    requires: ["b04-put-conflict-metadata", "b05-blob-conflict-bytes"],
    purpose:
      "Both collisions in one call: same checkpoint id AND same (channel, version), with different bytes and different metadata. One put() therefore hits DO UPDATE on the row and DO NOTHING on the bytes, so the question is whether the surviving checkpoint and the surviving blob can be owned by DIFFERENT writers — a row describing state nobody stored.",
  },
  {
    id: "b07-putwrites-ordinary-channel",
    family: "B",
    lane: "stock",
    pairedWith: null,
    kind: "candidate",
    parties: 2,
    launch: "parallel",
    stages: [{ name: "ready", parties: 2, captureActivity: true }],
    kill: null,
    prepare: true,
    oracles: ["barrier", "conflict", "sqlstate", "projection"],
    classification: "bounded-trials",
    trials: 1,
    budgetMs: 120_000,
    requires: [],
    purpose:
      "Two putWrites() calls colliding on the checkpoint_writes primary key with an ORDINARY channel. Source predicts the INSERT ... DO NOTHING branch and therefore first-writer-wins.",
  },
  {
    id: "b08-putwrites-special-channel",
    family: "B",
    lane: "stock",
    pairedWith: null,
    kind: "candidate",
    parties: 2,
    launch: "parallel",
    stages: [{ name: "ready", parties: 2, captureActivity: true }],
    kill: null,
    prepare: true,
    oracles: ["barrier", "conflict", "sqlstate", "projection"],
    classification: "bounded-trials",
    trials: 1,
    budgetMs: 120_000,
    requires: ["b07-putwrites-ordinary-channel"],
    purpose:
      "The same collision on the same table with a channel that IS in WRITES_IDX_MAP, so putWrites takes its DO UPDATE branch instead. Paired with b07 this is the discriminator: one method, one table, opposite conflict semantics selected by the channel NAME.",
  },
  {
    id: "b09-read-under-concurrent-commits",
    family: "B",
    lane: "stock",
    pairedWith: null,
    kind: "candidate",
    parties: 2,
    launch: "parallel",
    stages: [
      { name: "ready", parties: 2, captureActivity: true },
      // The reader arrives here after its first sample; the writer only waits.
      // This is what makes the sampling window structural rather than lucky.
      { name: "reader-sampled", parties: 1 },
    ],
    kill: null,
    prepare: false,
    oracles: ["barrier", "lineage", "reachability", "sqlstate", "projection"],
    classification: "deterministic",
    trials: null,
    budgetMs: 150_000,
    requires: [],
    purpose:
      "A reader sampling raw rows while a writer commits a chain of checkpoints. put() wraps its blobs and its checkpoint row in one transaction, so no sample should ever show a checkpoint referencing an absent blob. The reader also reports how many DISTINCT checkpoint counts it saw: one would mean it sampled a settled database and the criterion would be vacuous.",
  },
];

/** The three kill boundaries share a shape; only the gate differs. */
function killCase(
  id: string,
  gate: string,
  requires: string[],
  purpose: string,
  oracles: OracleId[] = ["projection", "drain", "sqlstate", "survivors", "reachability"],
  prepare = false,
): CaseDef {
  return {
    id,
    family: "C",
    lane: "stock",
    pairedWith: null,
    kind: "candidate",
    parties: 2,
    launch: "sequential",
    stages: [],
    kill: { party: 0, gate, signal: "KILL" },
    prepare,
    oracles,
    classification: "deterministic",
    trials: null,
    budgetMs: 180_000,
    requires,
    purpose,
  };
}

const FAMILY_C: CaseDef[] = [
  killCase(
    "c01-kill-inside-put-before-checkpoint-row",
    "before-row",
    [],
    "A put() carrying two channels, killed after both blob upserts have settled and before the checkpoint row. The transaction is open, so PostgreSQL must discard everything — but 'we found nothing' only means something once c05 proves the projection CAN see a partial write.",
  ),
  killCase(
    "c02-kill-inside-put-before-commit",
    "before-commit",
    ["c01-kill-inside-put-before-checkpoint-row"],
    "The same call killed one statement later: every row written, COMMIT not yet issued. The latest boundary at which nothing may survive.",
  ),
  killCase(
    "c03-kill-after-commit-acknowledged",
    "after-commit",
    ["c02-kill-inside-put-before-commit"],
    "The discriminator for c01 and c02: killed after COMMIT has RETURNED but before the promise resolves. Everything must now be durable. Without it, 'the kill destroyed the write' cannot be told apart from 'the kill landed before anything was written'.",
    ["projection", "lineage", "drain", "sqlstate", "survivors"],
  ),
  killCase(
    "c04-kill-inside-putwrites-before-commit",
    "before-commit",
    ["c02-kill-inside-put-before-commit"],
    "The multi-row path: three writes inside one putWrites() transaction, killed before COMMIT. A partial write here would leave a task with some of its channels, which the engine would read back as a completed task.",
    ["projection", "lineage", "drain", "sqlstate", "survivors", "reachability"],
    true,
  ),
  killCase(
    "c05-nonatomic-writer-control",
    "between-statements",
    ["c01-kill-inside-put-before-checkpoint-row"],
    "The load-bearing control, and the only harness-written SQL in the family: a checkpoint row and its blob written in SEPARATE autocommit statements, killed between them. It MUST leave a stranded reference. A clean result here would mean the atomicity findings in c01/c02 are unfalsifiable.",
    ["projection", "reachability", "drain", "survivors"],
  ),
  killCase(
    "c10-nonatomic-writer-blob-first-control",
    "between-statements",
    ["c05-nonatomic-writer-control"],
    "The same non-atomic writer with the statements in the VENDOR's order - blobs first, then the checkpoint row - killed between them. c05 leaves a stranded reference, but a torn put() cannot: _dumpBlobs runs before the checkpoint upsert, so partial vendor state is ORPHAN BLOBS that no checkpoint names. c05 therefore validated a detector for damage the vendor path does not produce; this exercises the shape c01 and c02 would actually have to catch.",
    ["projection", "reachability", "drain", "survivors"],
  ),
  {
    id: "c06-pool-max1-serialization",
    family: "C",
    lane: "stock",
    pairedWith: null,
    kind: "candidate",
    parties: 1,
    launch: "parallel",
    stages: [],
    kill: null,
    prepare: false,
    oracles: ["projection", "lineage", "sqlstate"],
    classification: "deterministic",
    trials: null,
    budgetMs: 150_000,
    requires: [],
    purpose:
      "Six concurrent put() calls through a pool of one. The architecture question is not throughput — that is out of scope — but whether a starved pool degrades into a hang. Everything must complete, on one backend, with no idle-client error.",
  },
  {
    id: "c07-role-connection-limit",
    family: "C",
    lane: "stock",
    pairedWith: null,
    kind: "candidate",
    parties: 1,
    launch: "parallel",
    stages: [],
    kill: null,
    prepare: true,
    oracles: ["sqlstate", "projection"],
    classification: "deterministic",
    trials: null,
    budgetMs: 120_000,
    requires: [],
    purpose:
      "Connections beyond what the server role permits. The requirement is that exhaustion is loud and bounded — a named SQLSTATE — rather than an indefinite wait. The limit is set on a dedicated role so the harness's own pools stay unconstrained and cannot be starved by the case they are measuring.",
  },
  {
    id: "c08-lock-wait-on-conflicting-put",
    family: "C",
    lane: "stock",
    pairedWith: null,
    kind: "candidate",
    parties: 2,
    launch: "parallel",
    stages: [
      { name: "locked", parties: 2 },
      { name: "hold", parties: 1, captureLockEdge: true },
    ],
    kill: null,
    prepare: false,
    oracles: ["barrier", "lockEdge", "projection", "lineage", "sqlstate"],
    classification: "deterministic",
    trials: null,
    budgetMs: 180_000,
    requires: [],
    purpose:
      "Two put() calls for the same checkpoint id, the first parked after its upsert and before COMMIT. Contention is proven by a captured blocked -> blocking backend edge while the victim is still parked, never by elapsed time.",
  },
  {
    id: "c09-delete-thread-versus-open-write",
    family: "C",
    lane: "stock",
    pairedWith: null,
    kind: "candidate",
    parties: 2,
    launch: "parallel",
    stages: [
      { name: "writer-parked", parties: 2 },
      { name: "deleted", parties: 1 },
      { name: "commit-now", parties: 0 },
    ],
    kill: null,
    prepare: true,
    oracles: ["barrier", "projection", "lineage", "reachability", "sqlstate"],
    classification: "deterministic",
    trials: null,
    budgetMs: 180_000,
    requires: [],
    purpose:
      "deleteThread() committing while a put() transaction is already open, ordered rather than raced so the answer is a fact and not a coin flip. Both calls are individually atomic, so the question is what their COMBINATION leaves behind — specifically whether a surviving checkpoint can point at a parent the delete removed.",
  },
];

/**
 * Family D, first slice: setup, lifecycle, CRUD and schema.
 *
 * The family default is a migrated Store, so a case only names `provision`
 * when its subject is the COLD state — whether `setup()` ran at all, what
 * `ensureTables: false` does against empty tables, and which schema
 * `CREATE EXTENSION` actually lands in.
 *
 * Two source predictions drive most of it. `executePut` runs its row upsert and
 * its vector delete/insert as separate AUTOCOMMIT statements on one client with
 * no BEGIN anywhere, so a failure between them is not a rollback; and no
 * operation checks `isClosed`, so a call after `stop()` reaches an ended pool
 * rather than a guard.
 */
const FAMILY_D: CaseDef[] = [
  {
    id: "d01-store-explicit-start-baseline",
    family: "D",
    lane: "stock",
    pairedWith: null,
    kind: "control",
    parties: 1,
    launch: "parallel",
    stages: [],
    kill: null,
    provision: "checkpointer",
    prepare: false,
    oracles: ["projection", "storeProjection", "ledger", "sqlstate", "statements"],
    classification: "deterministic",
    trials: null,
    budgetMs: 120_000,
    requires: [],
    purpose:
      "The baseline every other Store case is scored against: an explicit start() against a cold schema, then one put/get/delete round trip. Establishes the terminal relation set, the six-entry ledger, and how many statements an uncontended CRUD cycle costs.",
  },
  {
    id: "d02-store-lazy-first-operation",
    family: "D",
    lane: "stock",
    pairedWith: null,
    kind: "candidate",
    parties: 1,
    launch: "parallel",
    stages: [],
    kill: null,
    provision: "checkpointer",
    prepare: false,
    oracles: ["projection", "storeProjection", "ledger", "sqlstate", "statements"],
    classification: "deterministic",
    trials: null,
    budgetMs: 120_000,
    requires: ["d01-store-explicit-start-baseline"],
    purpose:
      "The same round trip with setup() never called, so the first operation carries the migrations. a09 measured the CONCURRENT form; this is the sequential one, and its discriminator against d01 is that migration statements appear inside the operation rather than before it.",
  },
  {
    id: "d03-store-use-after-stop",
    family: "D",
    lane: "stock",
    pairedWith: null,
    kind: "candidate",
    parties: 1,
    launch: "parallel",
    stages: [],
    kill: null,
    prepare: false,
    oracles: ["sqlstate", "storeProjection", "projection"],
    classification: "deterministic",
    trials: null,
    budgetMs: 120_000,
    requires: [],
    purpose:
      "stop() sets isClosed and ends the pool, but no operation checks that flag. The architecture needs a closed Store to refuse loudly and identifiably; the measurement is what a put/get/delete after stop() actually raises, whether it carries a SQLSTATE at all, and whether a second stop() is safe.",
  },
  {
    id: "d04-store-ensure-tables-false-cold",
    family: "D",
    lane: "stock",
    pairedWith: null,
    kind: "candidate",
    parties: 1,
    launch: "parallel",
    stages: [],
    kill: null,
    provision: "checkpointer",
    prepare: false,
    oracles: ["sqlstate", "projection", "storeProjection", "statements"],
    classification: "deterministic",
    trials: null,
    budgetMs: 120_000,
    requires: [],
    purpose:
      "ensureTables: false against a schema that was never migrated. start() must become a no-op and the first operation must fail loudly rather than create anything — the precondition for the migration safeguard, which runs every runtime Store this way.",
  },
  {
    id: "d05-store-ensure-tables-false-migrated",
    family: "D",
    lane: "stock",
    pairedWith: null,
    kind: "control",
    parties: 1,
    launch: "parallel",
    stages: [],
    kill: null,
    prepare: false,
    oracles: ["sqlstate", "statements", "storeProjection", "projection"],
    classification: "deterministic",
    trials: null,
    budgetMs: 120_000,
    requires: ["d04-store-ensure-tables-false-cold"],
    purpose:
      "The control for d04: the identical configuration against an already-migrated schema must complete every operation and issue no migration statement at all. Without it, 'ensureTables: false refused' could not be told apart from 'the store was broken'.",
  },
  {
    id: "d06-put-failure-leaves-committed-row",
    family: "D",
    lane: "stock",
    pairedWith: null,
    kind: "candidate",
    parties: 1,
    launch: "parallel",
    stages: [],
    kill: null,
    prepare: false,
    oracles: ["sqlstate", "storeProjection", "projection"],
    classification: "deterministic",
    trials: null,
    budgetMs: 120_000,
    requires: [],
    purpose:
      "executePut writes the row, then DELETEs the item's vectors, then embeds — all autocommit, no transaction. An item is indexed, then re-put with text the frozen embedder refuses. The question is whether a REJECTED put() is a no-op, or whether it commits the new value and leaves the item with no vectors at all.",
  },
  {
    id: "d07-put-success-indexes-control",
    family: "D",
    lane: "stock",
    pairedWith: null,
    kind: "control",
    parties: 1,
    launch: "parallel",
    stages: [],
    kill: null,
    prepare: false,
    oracles: ["sqlstate", "storeProjection", "projection"],
    classification: "deterministic",
    trials: null,
    budgetMs: 120_000,
    requires: ["d06-put-failure-leaves-committed-row"],
    purpose:
      "The control for d06: the same two puts with text the embedder knows must leave the item indexed on the second value. It proves the vector row is normally present, so d06's empty vector set is the failure's doing rather than the fixture's.",
  },
  {
    id: "d08-concurrent-put-same-key",
    family: "D",
    lane: "stock",
    pairedWith: null,
    kind: "candidate",
    parties: 2,
    launch: "parallel",
    stages: [{ name: "ready", parties: 2, captureActivity: true }],
    kill: null,
    prepare: true,
    oracles: ["barrier", "storeConflict", "storeProjection", "sqlstate", "projection"],
    classification: "bounded-trials",
    trials: 1,
    budgetMs: 150_000,
    requires: ["d07-put-success-indexes-control"],
    purpose:
      "Two writers put different values under the same (namespace, key), each indexing a different text. The row upsert is ON CONFLICT DO UPDATE, but the vectors are a separate DELETE-then-INSERT outside any transaction — so the question is the b06 question for the Store: can the surviving value and the surviving vectors belong to DIFFERENT writers.",
  },
  {
    id: "d09-concurrent-put-and-delete",
    family: "D",
    lane: "stock",
    pairedWith: null,
    kind: "candidate",
    parties: 2,
    launch: "parallel",
    stages: [{ name: "ready", parties: 2, captureActivity: true }],
    kill: null,
    prepare: true,
    oracles: ["barrier", "storeProjection", "sqlstate", "projection"],
    classification: "bounded-trials",
    trials: 1,
    budgetMs: 150_000,
    requires: ["d08-concurrent-put-same-key"],
    purpose:
      "A put racing a delete on the same key. store_vectors references store ON DELETE CASCADE, so the outcome set includes a vector insert landing after its parent row was removed — a foreign-key violation the caller sees. Whatever happens, the terminal state must not contain a vector row without its item.",
  },
  {
    id: "d10-value-serialization-boundaries",
    family: "D",
    lane: "stock",
    pairedWith: null,
    kind: "candidate",
    parties: 1,
    launch: "parallel",
    stages: [],
    kill: null,
    prepare: false,
    oracles: ["sqlstate", "storeProjection", "projection"],
    classification: "deterministic",
    trials: null,
    budgetMs: 120_000,
    requires: [],
    purpose:
      "Values go through JSON.stringify into JSONB, and both stages lose information: undefined keys vanish, Date becomes a string, NaN and Infinity become null, a NUL byte is rejected by PostgreSQL, BigInt throws before SQL, and JSONB re-sorts keys. Each is a literal expected value, because the architecture stores runtime state here and needs to know exactly what does not survive a round trip.",
  },
  {
    id: "d11-schema-isolation-two-stores",
    family: "D",
    lane: "stock",
    pairedWith: null,
    kind: "candidate",
    parties: 1,
    launch: "parallel",
    stages: [],
    kill: null,
    provision: "checkpointer",
    prepare: false,
    oracles: ["projection", "storeProjection", "sqlstate"],
    classification: "deterministic",
    trials: null,
    budgetMs: 150_000,
    requires: [],
    purpose:
      "Two Stores in two schemas of one database, writing the same namespace and key with different values. Whether the architecture's schema separation actually isolates data, projected from both schemas rather than read back through either API.",
  },
  {
    id: "d12-vector-extension-placement",
    family: "D",
    lane: "stock",
    pairedWith: null,
    kind: "candidate",
    parties: 1,
    launch: "parallel",
    stages: [],
    kill: null,
    provision: "checkpointer",
    prepare: false,
    oracles: ["projection", "sqlstate"],
    classification: "deterministic",
    trials: null,
    budgetMs: 150_000,
    requires: ["d11-schema-isolation-two-stores"],
    purpose:
      "CREATE EXTENSION is database-scoped and unqualified, so the extension lands wherever the search_path puts it while the store schema references `vector` by bare name. The measurement is which schema actually holds it, plus a second Store migrated on a connection whose search_path excludes that schema — which decides whether schema isolation is complete or depends on the search_path.",
  },
  {
    id: "d13-index-metric-config-change",
    family: "D",
    lane: "stock",
    pairedWith: null,
    kind: "candidate",
    parties: 1,
    launch: "parallel",
    stages: [],
    kill: null,
    provision: "checkpointer",
    prepare: false,
    oracles: ["projection", "storeProjection", "sqlstate", "ledger"],
    classification: "deterministic",
    trials: null,
    budgetMs: 150_000,
    requires: [],
    purpose:
      "a11 changed the vector DIMENSION and found a silent no-op. This changes the distance METRIC instead, where nothing raises on the write path either, so the only visible consequence is which indexes exist. The ledger stores positions while the migration list's content depends on the configuration, so a restart with a new metric must leave the configured metric with no index at all.",
  },
];

/**
 * Family D, second slice: batch, pool and TTL.
 *
 * `batch()` is a separate path from the convenience methods and is measured as
 * one — never generalised from the other. Its source shape drives the slice:
 * it acquires ONE client, runs the operations in a `for` loop of sequential
 * awaits, and contains no BEGIN. So a failure partway through commits a prefix,
 * abandons the suffix, and — through `AsyncBatchedStore`, which rejects the
 * whole batch with one error — reports failure to callers whose own operation
 * committed.
 *
 * The TTL cases turn on one expression: `if (!effectiveTtl) return null`. Zero
 * is falsy, so `ttl: 0` means "never expires" rather than "expire now"; and the
 * refresh path recomputes from `defaultTtl` rather than from the item's own ttl.
 */
const FAMILY_D_BATCH: CaseDef[] = [
  {
    id: "d14-batch-read-your-writes",
    family: "D",
    lane: "stock",
    pairedWith: null,
    kind: "candidate",
    parties: 1,
    launch: "parallel",
    stages: [],
    kill: null,
    prepare: false,
    oracles: ["sqlstate", "storeProjection", "projection"],
    classification: "deterministic",
    trials: null,
    budgetMs: 120_000,
    requires: [],
    purpose:
      "A batch whose later operations read what its earlier ones wrote. Every operation runs on one client with no transaction, so the prediction is that a get sees a preceding put — and that ordering within a batch is therefore load-bearing rather than incidental.",
  },
  {
    id: "d15-batch-partial-commit-on-failure",
    family: "D",
    lane: "stock",
    pairedWith: null,
    kind: "candidate",
    parties: 1,
    launch: "parallel",
    stages: [],
    kill: null,
    prepare: false,
    oracles: ["sqlstate", "storeProjection", "projection"],
    classification: "deterministic",
    trials: null,
    budgetMs: 120_000,
    requires: ["d14-batch-read-your-writes"],
    purpose:
      "A batch of three puts whose middle operation is invalid. With no BEGIN anywhere, the prediction is that the first is committed, the third never runs, and the caller is told the batch failed — leaving no way to learn from the rejection which half happened.",
  },
  {
    id: "d16-convenience-path-error-isolation-control",
    family: "D",
    lane: "stock",
    pairedWith: null,
    kind: "control",
    parties: 1,
    launch: "parallel",
    stages: [],
    kill: null,
    prepare: false,
    oracles: ["sqlstate", "storeProjection", "projection"],
    classification: "deterministic",
    trials: null,
    budgetMs: 120_000,
    requires: ["d15-batch-partial-commit-on-failure"],
    purpose:
      "The same three writes issued one at a time through the convenience methods. Each failure belongs to its own call, so the third still runs. This is what makes d15's abandoned suffix a property of batch() rather than of the invalid operation, and it is why a batch result may never be generalised from a convenience-method result.",
  },
  {
    id: "d17-async-batched-store-rejection-fanout",
    family: "D",
    lane: "stock",
    pairedWith: null,
    kind: "candidate",
    parties: 1,
    launch: "parallel",
    stages: [],
    kill: null,
    prepare: false,
    oracles: ["sqlstate", "storeProjection", "projection"],
    classification: "deterministic",
    trials: null,
    budgetMs: 120_000,
    requires: ["d15-batch-partial-commit-on-failure"],
    purpose:
      "AsyncBatchedStore coalesces whatever is enqueued in one tick and, on failure, runs `batch.forEach(({reject}) => reject(e))`. Four unrelated callers are enqueued together and one is invalid. The measurement is how many of the others are rejected, and whether any caller is told its write failed when the projection shows it committed.",
  },
  {
    id: "d18-batch-search-nested-acquisition",
    family: "D",
    lane: "stock",
    pairedWith: null,
    kind: "candidate",
    parties: 1,
    launch: "parallel",
    stages: [],
    kill: null,
    prepare: true,
    oracles: ["sqlstate", "projection"],
    classification: "deterministic",
    trials: null,
    budgetMs: 150_000,
    requires: [],
    purpose:
      "batch() holds a client and calls executeSearch with it — but on a Store with no index configuration, a search carrying a query is delegated to textSearch, which acquires a client of its OWN. Through a pool of one that is a nested acquisition against a connection the caller is still holding. The worker bounds itself with a timer rather than relying on the container timeout, so a hang is a measurement instead of a harness fault.",
  },
  {
    id: "d19-batch-search-nested-acquisition-max2-control",
    family: "D",
    lane: "stock",
    pairedWith: null,
    kind: "control",
    parties: 1,
    launch: "parallel",
    stages: [],
    kill: null,
    prepare: true,
    oracles: ["sqlstate", "projection"],
    classification: "deterministic",
    trials: null,
    budgetMs: 150_000,
    requires: ["d18-batch-search-nested-acquisition"],
    purpose:
      "The identical batch through a pool of two. If it completes, d18 is a pool-ceiling interaction rather than a broken query — which is the difference between 'raise the pool size' and 'this operation is unusable'.",
  },
  {
    id: "d20-batch-search-indexed-shares-client-control",
    family: "D",
    lane: "stock",
    pairedWith: null,
    kind: "control",
    parties: 1,
    launch: "parallel",
    stages: [],
    kill: null,
    prepare: true,
    oracles: ["sqlstate", "projection"],
    classification: "deterministic",
    trials: null,
    budgetMs: 150_000,
    requires: ["d18-batch-search-nested-acquisition"],
    purpose:
      "The same batch and the same pool of one, but on a Store WITH an index configuration — which routes the query to executeVectorSearch, reusing the held client instead of acquiring a second. Isolates the nesting to the unindexed text-search branch, so the finding names a code path rather than a method.",
  },
  {
    id: "d21-store-pool-max1-serialization",
    family: "D",
    lane: "stock",
    pairedWith: null,
    kind: "candidate",
    parties: 1,
    launch: "parallel",
    stages: [],
    kill: null,
    prepare: false,
    oracles: ["sqlstate", "storeProjection", "projection"],
    classification: "deterministic",
    trials: null,
    budgetMs: 150_000,
    requires: [],
    purpose:
      "Six concurrent convenience-method puts through a pool of one. The Store analogue of c06, and the second half of d18's discriminator: a starved pool must serialize rather than hang when nothing nests, so a hang in d18 cannot be blamed on the pool size alone.",
  },
  {
    id: "d22-ttl-zero-and-negative",
    family: "D",
    lane: "stock",
    pairedWith: null,
    kind: "candidate",
    parties: 1,
    launch: "parallel",
    stages: [],
    kill: null,
    prepare: false,
    oracles: ["sqlstate", "storeProjection", "projection"],
    classification: "deterministic",
    trials: null,
    budgetMs: 120_000,
    requires: [],
    purpose:
      "calculateExpiresAt guards with `if (!effectiveTtl) return null`, so zero is falsy and a caller asking for a zero-minute lifetime gets an item that never expires — the exact inverse of the request. A negative ttl is arithmetic instead, producing an expires_at in the past. Both are written and read back, with expires_at projected directly from the table.",
  },
  {
    id: "d23-ttl-refresh-on-read-uses-the-default",
    family: "D",
    lane: "stock",
    pairedWith: null,
    kind: "candidate",
    parties: 1,
    launch: "parallel",
    stages: [],
    kill: null,
    prepare: false,
    oracles: ["sqlstate", "storeProjection", "projection", "statements"],
    classification: "deterministic",
    trials: null,
    budgetMs: 120_000,
    requires: [],
    purpose:
      "refreshTtl recomputes from ttlConfig.defaultTtl and ignores the ttl the item was written with, so reading an item stored with a long lifetime can SHORTEN it to the default. It is also an UPDATE on the read path, which the architecture has to know about for reasons beyond TTL.",
  },
  {
    id: "d24-ttl-refresh-without-a-default-control",
    family: "D",
    lane: "stock",
    pairedWith: null,
    kind: "control",
    parties: 1,
    launch: "parallel",
    stages: [],
    kill: null,
    prepare: false,
    oracles: ["sqlstate", "storeProjection", "projection", "statements"],
    classification: "deterministic",
    trials: null,
    budgetMs: 120_000,
    requires: ["d23-ttl-refresh-on-read-uses-the-default"],
    purpose:
      "refreshOnRead enabled with no defaultTtl configured. calculateExpiresAt returns null and the update is skipped entirely, so the read leaves expires_at untouched. Paired with d23 this shows the refresh is driven by the default alone, and silently does nothing without one.",
  },
  {
    id: "d25-manual-sweep-and-statistics",
    family: "D",
    lane: "stock",
    pairedWith: null,
    kind: "candidate",
    parties: 1,
    launch: "parallel",
    stages: [],
    kill: null,
    prepare: false,
    oracles: ["sqlstate", "storeProjection", "projection"],
    classification: "deterministic",
    trials: null,
    budgetMs: 120_000,
    requires: [],
    purpose:
      "Live and already-expired items together. get() filters expired rows without removing them, so the question is what getStats counts before a sweep, what sweepExpiredItems returns, and whether the totals agree with the rows actually present — projected from the table rather than read back through getStats.",
  },
  {
    id: "d26-concurrent-sweepers",
    family: "D",
    lane: "stock",
    pairedWith: null,
    kind: "candidate",
    parties: 2,
    launch: "parallel",
    stages: [{ name: "ready", parties: 2, captureActivity: true }],
    kill: null,
    prepare: true,
    oracles: ["barrier", "sqlstate", "storeProjection", "projection"],
    classification: "bounded-trials",
    trials: 1,
    budgetMs: 150_000,
    requires: ["d25-manual-sweep-and-statistics"],
    purpose:
      "Two sweepers released together against one set of expired rows. Both issue the same unqualified DELETE, so they serialize on row locks and the split between them is an interleaving outcome — but their returned counts must SUM to the number of expired rows, with nothing swept twice and nothing left behind.",
  },
];

/**
 * Family D, third slice: namespaces, pagination, statistics and filters.
 *
 * The filter builder decides these cases. It emits a condition per recognised
 * operator and, for anything it does not recognise, `default: break` — returning
 * no condition at all. The caller only appends conditions it was given, so an
 * unrecognised filter does not fail: it silently becomes no filter. The same
 * shape covers an empty `$in`. Those are fail-OPEN paths, which is why they get
 * their own case with a restrictive control beside them.
 *
 * The namespace cases turn on two asymmetries: `validateNamespace` rejects `_`
 * but not `:` — the delimiter it joins labels with — and `listNamespaces` never
 * calls the validator that `put`, `get` and `search` all do.
 */
const FAMILY_D_QUERY: CaseDef[] = [
  {
    id: "d27-namespace-validation-matrix",
    family: "D",
    lane: "stock",
    pairedWith: null,
    kind: "candidate",
    parties: 1,
    launch: "parallel",
    stages: [],
    kill: null,
    prepare: false,
    oracles: ["sqlstate", "storeProjection", "projection"],
    classification: "deterministic",
    trials: null,
    budgetMs: 120_000,
    requires: [],
    purpose:
      "Ten namespace shapes against hand-authored accept/reject expectations taken from validateNamespace's stated rules. Two matter to the architecture: an ordinary underscore is refused, and the ':' the Store itself joins labels with is not.",
  },
  {
    id: "d28-namespace-delimiter-collision",
    family: "D",
    lane: "stock",
    pairedWith: null,
    kind: "candidate",
    parties: 1,
    launch: "parallel",
    stages: [],
    kill: null,
    prepare: false,
    oracles: ["sqlstate", "storeProjection", "projection"],
    classification: "deterministic",
    trials: null,
    budgetMs: 120_000,
    requires: ["d27-namespace-validation-matrix"],
    purpose:
      "The consequence of accepting ':'. Namespaces ['a:b'] and ['a','b'] join to the same namespace_path, which is half the primary key, so they are one row. The measurement is whether a write under one namespace is readable — and overwritable — under the other.",
  },
  {
    id: "d29-namespace-prefix-boundary",
    family: "D",
    lane: "stock",
    pairedWith: null,
    kind: "candidate",
    parties: 1,
    launch: "parallel",
    stages: [],
    kill: null,
    prepare: false,
    oracles: ["sqlstate", "storeProjection", "projection"],
    classification: "deterministic",
    trials: null,
    budgetMs: 120_000,
    requires: [],
    purpose:
      "Prefix matching is `namespace_path LIKE 'prefix%'` rather than a path-boundary comparison, so the sibling namespace 'alphabet' is a string prefix match for 'alpha' while being nowhere underneath it. Measured through both listNamespaces and search, because both build the same pattern.",
  },
  {
    id: "d30-list-namespaces-maxdepth-after-limit",
    family: "D",
    lane: "stock",
    pairedWith: null,
    kind: "candidate",
    parties: 1,
    launch: "parallel",
    stages: [],
    kill: null,
    prepare: false,
    oracles: ["sqlstate", "storeProjection", "projection"],
    classification: "deterministic",
    trials: null,
    budgetMs: 120_000,
    requires: ["d32-list-namespaces-pagination-control"],
    purpose:
      "maxDepth is applied in JavaScript after LIMIT and OFFSET have already been applied in SQL, so the limit is spent on rows the depth filter then discards. With the deeper namespaces sorting first, a page can come back empty while a matching namespace exists.",
  },
  {
    id: "d31-list-namespaces-skips-validation",
    family: "D",
    lane: "stock",
    pairedWith: null,
    kind: "candidate",
    parties: 1,
    launch: "parallel",
    stages: [],
    kill: null,
    prepare: false,
    oracles: ["sqlstate", "storeProjection", "projection"],
    classification: "deterministic",
    trials: null,
    budgetMs: 120_000,
    requires: ["d27-namespace-validation-matrix"],
    purpose:
      "validateNamespace exists because a '%' in a namespace turns a prefix match into a glob — its own source comment cites cross-tenant exposure. listNamespaces never calls it. The case sends the same wildcard down all three paths and records which refuse it and which return every tenant.",
  },
  {
    id: "d32-list-namespaces-pagination-control",
    family: "D",
    lane: "stock",
    pairedWith: null,
    kind: "control",
    parties: 1,
    launch: "parallel",
    stages: [],
    kill: null,
    prepare: false,
    oracles: ["sqlstate", "storeProjection", "projection"],
    classification: "deterministic",
    trials: null,
    budgetMs: 120_000,
    requires: [],
    purpose:
      "Ordinary limit/offset paging over a flat set: full pages, disjoint, covering the whole set. The control for d30 — without it, an empty page there could be read as pagination being broken outright rather than as its interaction with maxDepth.",
  },
  {
    id: "d33-filter-matrix",
    family: "D",
    lane: "stock",
    pairedWith: null,
    kind: "candidate",
    parties: 1,
    launch: "parallel",
    stages: [],
    kill: null,
    prepare: false,
    oracles: ["sqlstate", "storeProjection", "projection"],
    classification: "deterministic",
    trials: null,
    budgetMs: 150_000,
    requires: [],
    purpose:
      "Thirteen filters over one six-row corpus, each with a hand-authored expected key set derived from the generated SQL and PostgreSQL semantics. The corpus deliberately contains a JSON-null value and a row missing the key, because three-valued logic decides whether $ne and $nin include them.",
  },
  {
    id: "d34-filter-fail-open",
    family: "D",
    lane: "stock",
    pairedWith: null,
    kind: "candidate",
    parties: 1,
    launch: "parallel",
    stages: [],
    kill: null,
    prepare: false,
    oracles: ["sqlstate", "storeProjection", "projection"],
    classification: "deterministic",
    trials: null,
    budgetMs: 150_000,
    requires: ["d33-filter-matrix"],
    purpose:
      "An unrecognised operator and an empty $in or $nin all produce no condition, so the filter is dropped and every row is returned. A restrictive filter over the same corpus is measured alongside, so 'everything came back' cannot be confused with a corpus that was going to come back anyway.",
  },
  {
    id: "d35-filter-null-and-array-values",
    family: "D",
    lane: "stock",
    pairedWith: null,
    kind: "candidate",
    parties: 1,
    launch: "parallel",
    stages: [],
    kill: null,
    prepare: false,
    oracles: ["sqlstate", "storeProjection", "projection"],
    classification: "deterministic",
    trials: null,
    budgetMs: 120_000,
    requires: ["d33-filter-matrix"],
    purpose:
      "null is typeof 'object' but fails the non-null guard, and an array fails the not-an-array guard, so both fall to the string path and are compared against String(value) — 'null' and '1,2'. Neither is ever what ->> returns. $exists proves the rows are present, so matching nothing is the filter's doing.",
  },
  {
    id: "d36-filter-numeric-cast-on-mixed-types",
    family: "D",
    lane: "stock",
    pairedWith: null,
    kind: "candidate",
    parties: 1,
    launch: "parallel",
    stages: [],
    kill: null,
    prepare: false,
    oracles: ["sqlstate", "storeProjection", "projection"],
    classification: "deterministic",
    trials: null,
    budgetMs: 120_000,
    requires: ["d33-filter-matrix"],
    purpose:
      "The numeric operators cast (value ->> key)::numeric across the whole scanned set, so a single row holding text at that key fails the entire query rather than simply not matching. An equality filter on the same key is measured beside it, because it does not cast and must still work.",
  },
];

/**
 * Family D, fourth slice: text, vector and hybrid search.
 *
 * Every ordering claim is scored against `fixtures/rankings.json`, which was
 * authored by hand from the frozen vectors and pgvector's documented operators
 * — including the note that `<#>` returns the NEGATIVE inner product. Nothing
 * here compares the Store to itself, and no expectation was produced by running
 * it.
 *
 * The three metric cases are separate rather than table-driven so that one
 * metric ranking incorrectly cannot be averaged away into a single pass/fail.
 */
const FAMILY_D_SEARCH: CaseDef[] = [
  {
    id: "d37-vector-search-cosine",
    family: "D",
    lane: "stock",
    pairedWith: null,
    kind: "candidate",
    parties: 1,
    launch: "parallel",
    stages: [],
    kill: null,
    prepare: false,
    oracles: ["sqlstate", "embeddings", "storeProjection", "projection"],
    classification: "deterministic",
    trials: null,
    budgetMs: 150_000,
    requires: [],
    purpose:
      "Cosine ranking against the authored order. The score is 1 - MIN(distance) ordered descending, which should reproduce nearest-first; the fixture's four vectors give four distinct distances so there are no ties to hide a mis-ordering.",
  },
  {
    id: "d38-vector-search-l2",
    family: "D",
    lane: "stock",
    pairedWith: null,
    kind: "candidate",
    parties: 1,
    launch: "parallel",
    stages: [],
    kill: null,
    prepare: false,
    oracles: ["sqlstate", "embeddings", "storeProjection", "projection"],
    classification: "deterministic",
    trials: null,
    budgetMs: 150_000,
    requires: ["d37-vector-search-cosine"],
    purpose:
      "L2 ranking against the authored order. The fixture is built so L2 orders the same corpus differently from cosine — alpha and beta share a direction but differ in magnitude — so a Store that silently ignored distanceMetric would fail here while passing d37.",
  },
  {
    id: "d39-vector-search-inner-product",
    family: "D",
    lane: "stock",
    pairedWith: null,
    kind: "candidate",
    parties: 1,
    launch: "parallel",
    stages: [],
    kill: null,
    prepare: false,
    oracles: ["sqlstate", "embeddings", "storeProjection", "projection"],
    classification: "deterministic",
    trials: null,
    budgetMs: 150_000,
    requires: ["d37-vector-search-cosine"],
    purpose:
      "Inner-product ranking against the authored order, which is by TRUE inner product, highest first. pgvector's <#> returns the negative, and the implementation orders MIN(<#>) descending, so the case records both whether the order matches and whether it is exactly reversed — a sign convention and a broken query are different findings.",
  },
  {
    id: "d40-vector-search-thresholds",
    family: "D",
    lane: "stock",
    pairedWith: null,
    kind: "candidate",
    parties: 1,
    launch: "parallel",
    stages: [],
    kill: null,
    prepare: false,
    oracles: ["sqlstate", "storeProjection", "projection"],
    classification: "deterministic",
    trials: null,
    budgetMs: 150_000,
    requires: ["d37-vector-search-cosine"],
    purpose:
      "One similarityThreshold number through all three metrics. Cosine negates it into a distance bound, L2 applies it as a raw distance bound, and inner product compares it against a quantity that is always negative. The measurement is what each selects from one corpus and one query.",
  },
  {
    id: "d41-vector-search-unindexed-item",
    family: "D",
    lane: "stock",
    pairedWith: null,
    kind: "candidate",
    parties: 1,
    launch: "parallel",
    stages: [],
    kill: null,
    prepare: false,
    oracles: ["sqlstate", "storeProjection", "projection"],
    classification: "deterministic",
    trials: null,
    budgetMs: 150_000,
    requires: ["d37-vector-search-cosine"],
    purpose:
      "The store-to-store_vectors join is an INNER join, so an item written with indexing disabled cannot appear in vector results however well it would have matched. Text search reaches the same item, which is what shows the absence is the index rather than the write — the readable-but-invisible state d06 produces by accident.",
  },
  {
    id: "d42-vector-search-dimension-mismatch",
    family: "D",
    lane: "stock",
    pairedWith: null,
    kind: "candidate",
    parties: 1,
    launch: "parallel",
    stages: [],
    kill: null,
    prepare: false,
    oracles: ["sqlstate", "projection"],
    classification: "deterministic",
    trials: null,
    budgetMs: 150_000,
    requires: ["d37-vector-search-cosine"],
    purpose:
      "A query whose frozen vector is nine-dimensional against an eight-dimensional column. The guard is in JavaScript ahead of any SQL, so the question is whether the refusal is loud and whether it carries a SQLSTATE — the same question d03 asks of a closed Store.",
  },
  {
    id: "d43-hybrid-search-weights",
    family: "D",
    lane: "stock",
    pairedWith: null,
    kind: "candidate",
    parties: 1,
    launch: "parallel",
    stages: [],
    kill: null,
    prepare: false,
    oracles: ["sqlstate", "storeProjection", "projection"],
    classification: "deterministic",
    trials: null,
    budgetMs: 150_000,
    requires: ["d37-vector-search-cosine"],
    purpose:
      "vectorWeight moved between its extremes over a corpus containing one item whose indexed title and whose stored text disagree. Text search reads the whole serialized value while indexing reads one field, so that item ranks last by vector and near-first by text, and the weight has to move it.",
  },
  {
    id: "d44-text-search-semantics",
    family: "D",
    lane: "stock",
    pairedWith: null,
    kind: "candidate",
    parties: 1,
    launch: "parallel",
    stages: [],
    kill: null,
    prepare: false,
    oracles: ["sqlstate", "storeProjection", "projection"],
    classification: "deterministic",
    trials: null,
    budgetMs: 150_000,
    requires: [],
    purpose:
      "Text search runs over value::text, so the serialized JSON including its field NAMES is what is indexed, and a wildcard-shaped query reaches an OR'd ILIKE rather than being treated as a literal. A term appearing nowhere is measured alongside, so 'matched everything' cannot be an unfiltered query.",
  },
  {
    id: "d45-search-convenience-versus-batch",
    family: "D",
    lane: "stock",
    pairedWith: null,
    kind: "candidate",
    parties: 1,
    launch: "parallel",
    stages: [],
    kill: null,
    prepare: false,
    oracles: ["sqlstate", "storeProjection", "projection"],
    classification: "deterministic",
    trials: null,
    budgetMs: 150_000,
    requires: ["d38-vector-search-l2"],
    purpose:
      "A batched search operation carries no mode, no distanceMetric and no threshold, and executeSearch routes a query on an indexed Store straight to the cosine path. So the same query that can be ranked three ways through search() has exactly one available ranking through batch() — the separateness of the two paths, measured rather than assumed.",
  },
];

const FAMILY_E: CaseDef[] = [
  {
    id: "e01-nested-subgraph-baseline",
    family: "E",
    lane: "stock",
    pairedWith: null,
    kind: "candidate",
    parties: 1,
    launch: "parallel",
    stages: [],
    kill: null,
    prepare: false,
    oracles: ["lineage", "executions", "projection", "reachability"],
    classification: "deterministic",
    trials: null,
    budgetMs: 120_000,
    requires: [],
    purpose:
      "A graph whose middle node is a compiled subgraph is run to completion, and its lineage is read per namespace from the raw tables. Establishes how many namespaces exist, that each one's chain is singly rooted with a single leaf, and that the subgraph's checkpoints name a parent in another namespace.",
  },
  {
    id: "e02-inlined-graph-control",
    family: "E",
    lane: "stock",
    pairedWith: null,
    kind: "control",
    parties: 1,
    launch: "parallel",
    stages: [],
    kill: null,
    prepare: false,
    oracles: ["lineage", "executions", "projection"],
    classification: "deterministic",
    trials: null,
    budgetMs: 120_000,
    requires: ["e01-nested-subgraph-baseline"],
    purpose:
      "The load-bearing control for the whole family: the same four node bodies in the same order, arranged WITHOUT a subgraph, must produce exactly one namespace. Without it, 'e01 produced extra namespaces' is a fact about that graph rather than evidence about subgraphs.",
  },
  {
    id: "e03-parallel-subgraph-instances",
    family: "E",
    lane: "stock",
    pairedWith: null,
    kind: "candidate",
    parties: 1,
    launch: "parallel",
    stages: [],
    kill: null,
    prepare: false,
    oracles: ["lineage", "executions", "projection", "reachability"],
    classification: "deterministic",
    trials: null,
    budgetMs: 120_000,
    requires: ["e01-nested-subgraph-baseline"],
    purpose:
      "Two nodes wrapping ONE compiled subgraph are triggered in the same superstep. If the namespace derived from the subgraph's identity rather than from the call site the two instances would share it and overwrite each other, so distinctness here is what makes fan-out over a sub-workflow safe.",
  },
  {
    id: "e04-subgraph-interrupt-and-resume",
    family: "E",
    lane: "stock",
    pairedWith: null,
    kind: "candidate",
    parties: 1,
    launch: "parallel",
    stages: [],
    kill: null,
    prepare: false,
    oracles: ["lineage", "executions", "projection", "reachability"],
    classification: "deterministic",
    trials: null,
    budgetMs: 150_000,
    requires: [],
    purpose:
      "An interrupt raised inside a subgraph, committed, then resumed by the same process. Establishes which namespace the interrupt write lands in and that the resume re-enters the subgraph's own namespace rather than starting a new one.",
  },
  {
    id: "e05-subgraph-crash-resume",
    family: "E",
    lane: "stock",
    pairedWith: null,
    kind: "candidate",
    parties: 2,
    launch: "sequential",
    stages: [],
    kill: { party: 0, gate: "inside-subgraph-node", signal: "SIGKILL" },
    prepare: false,
    oracles: ["lineage", "executions", "projection", "reachability", "drain"],
    classification: "deterministic",
    trials: null,
    budgetMs: 180_000,
    requires: ["e01-nested-subgraph-baseline"],
    purpose:
      "A worker is SIGKILLed while executing a node INSIDE a subgraph, anchored on a durable park row rather than a sleep, and a fresh container picks the run up with no input. Measures whether a crash one namespace down resumes into the same namespace and leaves its chain singly rooted.",
  },
  {
    id: "e06-nested-depth-two",
    family: "E",
    lane: "stock",
    pairedWith: null,
    kind: "candidate",
    parties: 1,
    launch: "parallel",
    stages: [],
    kill: null,
    prepare: false,
    oracles: ["lineage", "executions", "projection", "reachability"],
    classification: "deterministic",
    trials: null,
    budgetMs: 120_000,
    requires: ["e01-nested-subgraph-baseline"],
    purpose:
      "A subgraph inside a subgraph, so nesting is measured at depth two rather than inferred from depth one. Depth is derived from namespace containment, never by counting the vendor's separator characters.",
  },
  {
    id: "e07-subgraph-pending-write-reuse",
    family: "E",
    lane: "stock",
    pairedWith: null,
    kind: "candidate",
    parties: 2,
    launch: "sequential",
    stages: [],
    kill: null,
    prepare: false,
    oracles: ["lineage", "executions", "projection", "reachability"],
    classification: "deterministic",
    trials: null,
    budgetMs: 180_000,
    requires: ["e01-nested-subgraph-baseline", "e09-root-fanout-pending-write-reuse-control"],
    purpose:
      "A two-sibling fan-out inside a subgraph where one sibling fails after the other's write has landed, then a resume. The probe answers which sibling re-executed. Spike 05 measured the completed sibling being REUSED at the root; this asks whether that still holds one namespace down.",
  },
  {
    id: "e09-root-fanout-pending-write-reuse-control",
    family: "E",
    lane: "stock",
    pairedWith: null,
    kind: "control",
    parties: 2,
    launch: "sequential",
    stages: [],
    kill: null,
    prepare: false,
    oracles: ["lineage", "executions", "projection", "reachability"],
    classification: "deterministic",
    trials: null,
    budgetMs: 180_000,
    requires: [],
    purpose:
      "The control that isolates e07's variable: the identical two-sibling fan-out with the identical thrown failure, at the ROOT instead of inside a subgraph. Spike 05 measured reuse at the root after a SIGKILL, so keeping the failure mode fixed and changing only the nesting is what makes any difference in reuse attributable to the subgraph boundary.",
  },
  {
    id: "e08-subgraph-concurrent-resume",
    family: "E",
    lane: "stock",
    pairedWith: null,
    kind: "candidate",
    parties: 2,
    launch: "parallel",
    stages: [{ name: "resume-ready", parties: 2, captureActivity: true }],
    kill: null,
    prepare: true,
    oracles: ["barrier", "activity", "lineage", "executions", "projection", "reachability"],
    classification: "bounded-trials",
    trials: 1,
    budgetMs: 180_000,
    requires: ["e04-subgraph-interrupt-and-resume"],
    purpose:
      "Two containers resume the same committed SUBGRAPH interrupt simultaneously, proven to have overlapped before either was released. Family B showed a root-level interrupt can be consumed twice; this measures what that does to a CHILD namespace's lineage, which is the shape any pruning or resume algorithm would later have to cope with.",
  },
];

const FAMILY_H_EFFECT_KEY: CaseDef[] = [
  {
    id: "h01-effect-key-components-baseline",
    family: "H",
    lane: "stock",
    pairedWith: null,
    kind: "candidate",
    parties: 1,
    launch: "parallel",
    stages: [],
    kill: null,
    prepare: false,
    oracles: ["effectKey", "lineage", "executions", "projection"],
    classification: "deterministic",
    trials: null,
    budgetMs: 120_000,
    requires: [],
    purpose:
      "Every proposed effect_key component is recorded from the config the engine hands a node, and independently reconstructed from checkpoint_writes. Establishes which components are reachable at all, which need an undocumented or private config key, and whether the node's view of its own namespace matches the namespace its writes are stored under.",
  },
  {
    id: "h02-effect-key-across-crash-resume",
    family: "H",
    lane: "stock",
    pairedWith: null,
    kind: "candidate",
    parties: 2,
    launch: "sequential",
    stages: [],
    kill: { party: 0, gate: "after-effect", signal: "SIGKILL" },
    prepare: false,
    oracles: ["effectKey", "lineage", "executions", "projection", "drain"],
    classification: "deterministic",
    trials: null,
    budgetMs: 180_000,
    requires: ["h01-effect-key-components-baseline"],
    purpose:
      "The first of the two properties architecture/09 marks 'assumed, not measured': a worker is killed after recording its effect and before its writes land, and a fresh container resumes under durability sync. The key the replacement computes must equal the key the dead process computed, or the ledger cannot suppress a redelivered effect.",
  },
  {
    id: "h03-effect-key-across-explicit-fork",
    family: "H",
    lane: "stock",
    pairedWith: null,
    kind: "candidate",
    parties: 2,
    launch: "sequential",
    stages: [],
    kill: null,
    prepare: false,
    oracles: ["effectKey", "lineage", "executions", "projection", "reachability"],
    classification: "deterministic",
    trials: null,
    budgetMs: 180_000,
    requires: ["h01-effect-key-components-baseline"],
    purpose:
      "The second assumed property, in the opposite direction: a completed run is replayed from an explicit checkpoint_id, which architecture/09 says must CHANGE the key so a genuine fork re-runs the effect. The same run also performs a second, genuinely different effect, so 'the keys matched' can never be vacuous.",
  },
  {
    id: "h04-effect-key-async-durability",
    family: "H",
    lane: "stock",
    pairedWith: null,
    kind: "candidate",
    parties: 2,
    launch: "sequential",
    stages: [],
    kill: { party: 0, gate: "after-effect", signal: "SIGKILL" },
    prepare: false,
    oracles: ["effectKey", "lineage", "executions", "projection", "drain"],
    classification: "bounded-trials",
    trials: 1,
    budgetMs: 180_000,
    requires: ["h02-effect-key-across-crash-resume"],
    purpose:
      "The negative lane h02 controls for: the identical crash under durability async, where the checkpoint write is not awaited. A superstep lost to the kill means a different parent checkpoint on resume, a different task id, and a key that no longer matches the effect that already happened. Whether the superstep survives is a race, so the outcome is reported as a set.",
  },
  {
    id: "h05-effect-key-fanout-siblings",
    family: "H",
    lane: "stock",
    pairedWith: null,
    kind: "candidate",
    parties: 1,
    launch: "parallel",
    stages: [],
    kill: null,
    prepare: false,
    oracles: ["effectKey", "lineage", "executions", "projection"],
    classification: "deterministic",
    trials: null,
    budgetMs: 150_000,
    requires: ["h01-effect-key-components-baseline"],
    purpose:
      "Three siblings in one superstep call the same tool with the same arguments, so every proposed component except task is identical. The full key must give three distinct values and the task-less ablation exactly one — the measurement that task is load-bearing rather than decorative.",
  },
  {
    id: "h06-effect-key-multiple-ordinals",
    family: "H",
    lane: "stock",
    pairedWith: null,
    kind: "candidate",
    parties: 1,
    launch: "parallel",
    stages: [],
    kill: null,
    prepare: false,
    oracles: ["effectKey", "lineage", "executions", "projection"],
    classification: "deterministic",
    trials: null,
    budgetMs: 120_000,
    requires: ["h01-effect-key-components-baseline"],
    purpose:
      "One node execution performs three identical effects. The ordinal-less ablation must collapse them to one key while the full key keeps three, and the row side must show that the proposed ordinal is NOT recoverable from checkpoint_writes: idx counts writes per task, not effects per node.",
  },
  {
    id: "h07-effect-key-inside-subgraph",
    family: "H",
    lane: "stock",
    pairedWith: null,
    kind: "candidate",
    parties: 1,
    launch: "parallel",
    stages: [],
    kill: null,
    prepare: false,
    oracles: ["effectKey", "lineage", "executions", "projection", "reachability"],
    classification: "deterministic",
    trials: null,
    budgetMs: 150_000,
    requires: ["h01-effect-key-components-baseline", "e01-nested-subgraph-baseline"],
    purpose:
      "The same tool called with the same arguments at the root and inside a subgraph. Anything separating the two keys comes from the orchestration context, so this measures whether ns and parent_checkpoint remain recoverable — and remain reconstructible from rows — one namespace down.",
  },
];

/**
 * The changed-graph matrix, twice: once with the guard disabled to characterise
 * what the stock engine does, once with it enabled. Every guard case names its
 * stock pair, so the driver cannot report a green mitigation without the stock
 * result beside it in the same evidence set.
 */
const FAMILY_H_COMPAT: CaseDef[] = [
  {
    id: "h08-changed-graph-identical-control",
    family: "H",
    lane: "stock",
    pairedWith: null,
    kind: "control",
    parties: 1,
    launch: "parallel",
    stages: [],
    kill: null,
    prepare: true,
    oracles: ["compatibility", "lineage", "executions", "projection", "sqlstate"],
    classification: "deterministic",
    trials: null,
    budgetMs: 150_000,
    requires: [],
    purpose:
      "The control the whole changed-graph matrix rests on: a paused thread resumed against the IDENTICAL graph must complete. Without it, 'the incompatible variant failed' cannot be distinguished from 'resuming this fixture never works'.",
  },
  {
    id: "h09-changed-graph-cosmetic",
    family: "H",
    lane: "stock",
    pairedWith: null,
    kind: "candidate",
    parties: 1,
    launch: "parallel",
    stages: [],
    kill: null,
    prepare: true,
    oracles: ["compatibility", "lineage", "executions", "projection", "sqlstate"],
    classification: "deterministic",
    trials: null,
    budgetMs: 150_000,
    requires: ["h08-changed-graph-identical-control"],
    purpose:
      "A node body that differs only in comments and indentation. Establishes that 'cosmetic' is a real category with a stated rule — comments stripped, whitespace collapsed — rather than a source-hash equality check that would quarantine every reformatting.",
  },
  {
    id: "h10-changed-graph-renamed-node",
    family: "H",
    lane: "stock",
    pairedWith: null,
    kind: "candidate",
    parties: 1,
    launch: "parallel",
    stages: [],
    kill: null,
    prepare: true,
    oracles: ["compatibility", "lineage", "projection", "sqlstate"],
    classification: "deterministic",
    trials: null,
    budgetMs: 150_000,
    requires: ["h08-changed-graph-identical-control"],
    purpose:
      "The interrupting node is renamed. Characterises what the stock engine does when persisted state names a node the current graph no longer has — the quarantine path architecture/09 marks explicitly unverified.",
  },
  {
    id: "h11-changed-graph-added-channel",
    family: "H",
    lane: "stock",
    pairedWith: null,
    kind: "candidate",
    parties: 1,
    launch: "parallel",
    stages: [],
    kill: null,
    prepare: true,
    oracles: ["compatibility", "lineage", "executions", "projection", "sqlstate"],
    classification: "deterministic",
    trials: null,
    budgetMs: 150_000,
    requires: ["h08-changed-graph-identical-control"],
    purpose:
      "One extra state channel, every node name unchanged. Separates 'the state schema changed' from 'the topology changed', which the renamed-node case conflates.",
  },
  {
    id: "h12-changed-graph-moved-interrupt",
    family: "H",
    lane: "stock",
    pairedWith: null,
    kind: "candidate",
    parties: 1,
    launch: "parallel",
    stages: [],
    kill: null,
    prepare: true,
    oracles: ["compatibility", "lineage", "executions", "projection", "sqlstate"],
    classification: "deterministic",
    trials: null,
    budgetMs: 150_000,
    requires: ["h08-changed-graph-identical-control"],
    purpose:
      "interrupt() moves from one node to another. NO node name and NO channel changes, so this is the case that decides whether a structural manifest is sufficient — architecture/09 says interrupt matching is positional, and this is the change that moves the position invisibly.",
  },
  {
    id: "h13-compat-guard-identical",
    family: "H",
    lane: "mit-compat",
    pairedWith: "h08-changed-graph-identical-control",
    kind: "candidate",
    parties: 1,
    launch: "parallel",
    stages: [],
    kill: null,
    prepare: true,
    oracles: ["compatibility", "lineage", "executions", "projection", "sqlstate"],
    classification: "deterministic",
    trials: null,
    budgetMs: 150_000,
    requires: [],
    purpose:
      "The guard must ALLOW an unchanged graph through to a normal resume. A guard that refused everything would satisfy every refusal criterion below while being useless, so this is what stops the mitigation lane being vacuous.",
  },
  {
    id: "h14-compat-guard-cosmetic",
    family: "H",
    lane: "mit-compat",
    pairedWith: "h09-changed-graph-cosmetic",
    kind: "candidate",
    parties: 1,
    launch: "parallel",
    stages: [],
    kill: null,
    prepare: true,
    oracles: ["compatibility", "lineage", "executions", "projection", "sqlstate"],
    classification: "deterministic",
    trials: null,
    budgetMs: 150_000,
    requires: [],
    purpose:
      "The guard must allow a comment-and-whitespace-only change and resume normally, proving the normalisation rule is load-bearing rather than decorative.",
  },
  {
    id: "h15-compat-guard-renamed-node",
    family: "H",
    lane: "mit-compat",
    pairedWith: "h10-changed-graph-renamed-node",
    kind: "candidate",
    parties: 1,
    launch: "parallel",
    stages: [],
    kill: null,
    prepare: true,
    oracles: ["compatibility", "lineage", "projection", "sqlstate"],
    classification: "deterministic",
    trials: null,
    budgetMs: 150_000,
    requires: [],
    purpose:
      "The guard must refuse a renamed node BEFORE invoking, with a stable typed code, leaving the checkpoint head and the interrupt row exactly where they were.",
  },
  {
    id: "h16-compat-guard-added-channel",
    family: "H",
    lane: "mit-compat",
    pairedWith: "h11-changed-graph-added-channel",
    kind: "candidate",
    parties: 1,
    launch: "parallel",
    stages: [],
    kill: null,
    prepare: true,
    oracles: ["compatibility", "lineage", "projection", "sqlstate"],
    classification: "deterministic",
    trials: null,
    budgetMs: 150_000,
    requires: [],
    purpose:
      "The guard must refuse a changed state-channel set before invoking, and must name the added channel in its reasons rather than reporting an opaque mismatch.",
  },
  {
    id: "h17-compat-guard-moved-interrupt",
    family: "H",
    lane: "mit-compat",
    pairedWith: "h12-changed-graph-moved-interrupt",
    kind: "candidate",
    parties: 1,
    launch: "parallel",
    stages: [],
    kill: null,
    prepare: true,
    oracles: ["compatibility", "lineage", "projection", "sqlstate"],
    classification: "deterministic",
    trials: null,
    budgetMs: 150_000,
    requires: [],
    purpose:
      "The hardest refusal, and the one that justifies fingerprinting node bodies at all: the guard must refuse a moved interrupt whose node names and channels are byte-identical to the baseline, on the strength of the fingerprint half alone.",
  },
];

const FAMILY_I: CaseDef[] = [
  {
    id: "i01-thread-lease-parallel-resume",
    family: "I",
    lane: "mit-lease",
    pairedWith: "b02-same-thread-parallel-resume",
    kind: "candidate",
    parties: 2,
    launch: "parallel",
    stages: [{ name: "resume-ready", parties: 2, captureActivity: true }],
    kill: null,
    provision: "checkpointer",
    prepare: true,
    oracles: ["barrier", "activity", "threadLease", "lineage", "executions", "projection", "sqlstate"],
    classification: "deterministic",
    trials: null,
    budgetMs: 180000,
    requires: [],
    purpose:
      "b02's two workers, proven to have overlapped, but each first tries a per-thread advisory lease on a dedicated single connection. Exactly one may execute graph nodes; the other must be classified awaiting_resource and run nothing. The stock pair stays in the same evidence set, so the duplicate execution it measures is never erased by this lane being green.",
  },
  {
    id: "i02-thread-lease-disabled-control",
    family: "I",
    lane: "stock",
    pairedWith: null,
    kind: "control",
    parties: 2,
    launch: "parallel",
    stages: [{ name: "resume-ready", parties: 2, captureActivity: true }],
    kill: null,
    provision: "checkpointer",
    prepare: true,
    oracles: ["barrier", "activity", "lineage", "executions", "projection", "sqlstate"],
    classification: "bounded-trials",
    trials: 1,
    budgetMs: 180000,
    requires: ["i01-thread-lease-parallel-resume"],
    purpose:
      "The identical code with the lease step skipped, in the same family and the same fixture. Without it, 'the guarded lane executed the final node once' could be a property of this fixture rather than of the guard.",
  },
  {
    id: "i03-thread-lease-released-on-exit",
    family: "I",
    lane: "mit-lease",
    pairedWith: "b02-same-thread-parallel-resume",
    kind: "candidate",
    parties: 2,
    launch: "sequential",
    stages: [],
    kill: null,
    provision: "checkpointer",
    prepare: true,
    oracles: ["threadLease", "lineage", "executions", "projection", "sqlstate"],
    classification: "deterministic",
    trials: null,
    budgetMs: 180000,
    requires: ["i01-thread-lease-parallel-resume"],
    purpose:
      "A lease must be a lease and not a lock-out: party 0 takes and releases it without running, and party 1 must then acquire it and finish the run. Sequential rather than raced, so acquiring second is evidence the first holder's exit freed the lock rather than evidence of lucky timing.",
  },
  {
    id: "i04-store-guard-rejects-delimiter-in-a-label",
    family: "I",
    lane: "mit-storeguard",
    pairedWith: "d28-namespace-delimiter-collision",
    kind: "candidate",
    parties: 1,
    launch: "parallel",
    stages: [],
    kill: null,
    provision: "checkpointer+store",
    prepare: true,
    oracles: ["storeGuard", "projection", "sqlstate"],
    classification: "deterministic",
    trials: null,
    budgetMs: 180000,
    requires: [],
    purpose:
      "d28 measured that a label containing ':' collides with a differently-shaped namespace because ':' is both a legal label character and the delimiter. The guard must refuse the shape before the Store is touched, with a typed code naming the offending label.",
  },
  {
    id: "i05-store-guard-rejects-wildcard-prefix",
    family: "I",
    lane: "mit-storeguard",
    pairedWith: "d31-list-namespaces-skips-validation",
    kind: "candidate",
    parties: 1,
    launch: "parallel",
    stages: [],
    kill: null,
    provision: "checkpointer+store",
    prepare: true,
    oracles: ["storeGuard", "projection", "sqlstate"],
    classification: "deterministic",
    trials: null,
    budgetMs: 180000,
    requires: [],
    purpose:
      "d31 measured listNamespaces accepting a '%' prefix that put and search both refuse, returning namespaces from every tenant. The guard applies the SAME rules to a prefix as to a namespace, which is precisely the asymmetry the vendor leaves open.",
  },
  {
    id: "i06-store-guard-rejects-zero-ttl",
    family: "I",
    lane: "mit-storeguard",
    pairedWith: "d22-ttl-zero-and-negative",
    kind: "candidate",
    parties: 1,
    launch: "parallel",
    stages: [],
    kill: null,
    provision: "checkpointer+store",
    prepare: true,
    oracles: ["storeGuard", "projection", "sqlstate"],
    classification: "deterministic",
    trials: null,
    budgetMs: 180000,
    requires: [],
    purpose:
      "d22 measured ttl 0 producing expires_at NULL - a permanently readable item, the exact inverse of the request - because calculateExpiresAt treats zero as falsy. The guard refuses zero rather than letting a caller ask for immediate expiry and receive immortality.",
  },
  {
    id: "i07-store-guard-rejects-fail-open-filters",
    family: "I",
    lane: "mit-storeguard",
    pairedWith: "d34-filter-fail-open",
    kind: "candidate",
    parties: 1,
    launch: "parallel",
    stages: [],
    kill: null,
    provision: "checkpointer+store",
    prepare: true,
    oracles: ["storeGuard", "projection", "sqlstate"],
    classification: "deterministic",
    trials: null,
    budgetMs: 180000,
    requires: [],
    purpose:
      "d34 measured an unrecognised operator and an empty membership list each producing no SQL condition at all, so the query returns every row. The guard refuses both, because a filter that silently matches everything is worse than one that raises.",
  },
  {
    id: "i08-store-guard-allows-safe-operations-control",
    family: "I",
    lane: "mit-storeguard",
    pairedWith: "d01-store-explicit-start-baseline",
    kind: "control",
    parties: 1,
    launch: "parallel",
    stages: [],
    kill: null,
    provision: "checkpointer+store",
    prepare: true,
    oracles: ["storeGuard", "storeProjection", "projection", "sqlstate"],
    classification: "deterministic",
    trials: null,
    budgetMs: 180000,
    requires: [],
    purpose:
      "The anti-vacuity control for the whole storeguard lane: an ordinary namespace with an ordinary positive ttl must pass the guard AND reach the Store and come back. A guard that refused everything would satisfy every refusal criterion above while being useless.",
  },
];

const FAMILY_F_EXTRA: CaseDef[] = [
  {
    id: "f11-head-scoped-sweep-prunes-an-abandoned-branch",
    family: "F",
    lane: "stock",
    pairedWith: null,
    kind: "candidate",
    parties: 1,
    launch: "parallel",
    stages: [],
    kill: null,
    prepare: true,
    oracles: ["projection", "reachability", "lineage", "sqlstate"],
    classification: "deterministic",
    trials: null,
    budgetMs: 210000,
    requires: ["f04-reachability-sweep-retains-a-paused-thread"],
    purpose:
      "The live-set rule the architecture actually proposes, walked from an explicit head with a recursive ancestor query. The retained thread carries an abandoned fork branch, so a row of a KEPT thread is prunable - which whole-thread retention can never produce, making 'retained heads union parent lineage' vacuous in f04. The branch must go, the head's lineage must survive intact, and the paused run must still resume.",
  },
  {
    id: "f12-incomplete-sweep-omits-pending-writes",
    family: "F",
    lane: "stock",
    pairedWith: null,
    kind: "mutation",
    parties: 1,
    launch: "parallel",
    stages: [],
    kill: null,
    prepare: true,
    oracles: ["projection", "reachability", "lineage", "sqlstate"],
    classification: "deterministic",
    trials: null,
    budgetMs: 210000,
    requires: ["f04-reachability-sweep-retains-a-paused-thread"],
    purpose:
      "The live set names pending writes, and nothing had ever tested that term. A sweep that keeps every checkpoint but forgets its pending writes must leave detectable damage - the paused run loses the writes its resume depends on.",
  },
  {
    id: "f13-incomplete-sweep-omits-interrupts",
    family: "F",
    lane: "stock",
    pairedWith: null,
    kind: "mutation",
    parties: 1,
    launch: "parallel",
    stages: [],
    kill: null,
    prepare: true,
    oracles: ["projection", "reachability", "lineage", "sqlstate"],
    classification: "deterministic",
    trials: null,
    budgetMs: 210000,
    requires: ["f12-incomplete-sweep-omits-pending-writes"],
    purpose:
      "The narrower half of the same term: keep ordinary pending writes, drop only the __interrupt__ rows. An interrupt write IS the outstanding approval, so this is the mutation that turns a run awaiting a human decision into one with no decision point, and it must be detectable.",
  },
];

const FAMILY_G: CaseDef[] = [
  {
    id: "g01-graceful-database-restart",
    family: "G",
    lane: "stock",
    pairedWith: null,
    kind: "candidate",
    parties: 2,
    launch: "sequential",
    stages: [],
    kill: null,
    restart: { afterParty: 0, action: "graceful-restart" },
    prepare: false,
    oracles: ["clusterIdentity", "lineage", "projection", "sqlstate"],
    classification: "deterministic",
    trials: null,
    budgetMs: 300000,
    requires: [],
    purpose:
      "A paused thread, a clean docker restart of the database, then a fresh runtime container resuming it. The system identifier must be unchanged and the postmaster start time later - same data, new server process - and the log delta must show a clean shutdown rather than recovery, which is what makes g02's recovery evidence mean something.",
  },
  {
    id: "g02-unclean-database-kill-and-recovery",
    family: "G",
    lane: "stock",
    pairedWith: null,
    kind: "candidate",
    parties: 2,
    launch: "sequential",
    stages: [],
    kill: null,
    restart: { afterParty: 0, action: "unclean-kill" },
    prepare: false,
    oracles: ["clusterIdentity", "lineage", "projection", "sqlstate"],
    classification: "deterministic",
    trials: null,
    budgetMs: 300000,
    requires: ["g01-graceful-database-restart"],
    purpose:
      "The same thread, the same resume, but the server is SIGKILLed rather than stopped. PostgreSQL must perform crash recovery - proven from the log delta, not inferred from the fact that it came back - and the paused run must still resume.",
  },
  {
    id: "g03-database-death-under-a-live-worker",
    family: "G",
    lane: "stock",
    pairedWith: null,
    kind: "candidate",
    parties: 2,
    launch: "sequential",
    stages: [],
    kill: null,
    restart: {
      action: "unclean-kill",
      atGate: { party: 0, gate: "checkpointer-blocked" },
    },
    prepare: false,
    oracles: ["clusterIdentity", "lineage", "projection", "sqlstate"],
    classification: "deterministic",
    trials: null,
    budgetMs: 300000,
    requires: ["g02-unclean-database-kill-and-recovery"],
    purpose:
      "The server is SIGKILLed while a real PostgresSaver.put() is blocked inside it, proven from pg_stat_activity rather than assumed: a dedicated session holds the checkpoint table, the vendor call blocks on that lock, and only once the server reports a waiting subject backend is the park recorded and the database destroyed. Measures what the caller actually sees - a loud, bounded rejection rather than an indefinite hang - and that state committed before the kill survives and still resumes. The earlier version acted only after the party had exited, so no caller existed at the moment of the kill.",
  },
  {
    id: "g04-container-stack-replacement-on-the-preserved-volume",
    family: "G",
    lane: "stock",
    pairedWith: null,
    kind: "candidate",
    parties: 2,
    launch: "sequential",
    stages: [],
    kill: null,
    restart: { afterParty: 0, action: "replace-stack" },
    prepare: false,
    oracles: ["clusterIdentity", "lineage", "projection", "sqlstate"],
    classification: "deterministic",
    trials: null,
    budgetMs: 300000,
    requires: ["g01-graceful-database-restart"],
    purpose:
      "The database container is removed and recreated from the immutable pinned image id on the SAME named volume, and the resume runs in a fresh runtime container against persisted state alone. A different container id with an identical system identifier is what separates a replaced stack from one that never went away.",
  },
  {
    id: "g05-fresh-volume-negative-control",
    family: "G",
    lane: "stock",
    pairedWith: null,
    kind: "control",
    parties: 2,
    launch: "sequential",
    stages: [],
    kill: null,
    restart: { afterParty: 0, action: "fresh-volume" },
    prepare: false,
    oracles: ["clusterIdentity", "lineage", "projection", "sqlstate"],
    classification: "deterministic",
    trials: null,
    budgetMs: 300000,
    requires: ["g04-container-stack-replacement-on-the-preserved-volume"],
    purpose:
      "The load-bearing negative control: the same replacement onto a NEW volume, re-provisioned so the schema exists and the state does not. The system identifier must differ and the run must not come back. Without it, 'the stack was replaced and the run resumed' could be satisfied by a replacement that never actually lost anything.",
  },
];

const FAMILY_F: CaseDef[] = [
  {
    id: "f01-blob-sharing-baseline",
    family: "F",
    lane: "stock",
    pairedWith: null,
    kind: "candidate",
    parties: 1,
    launch: "parallel",
    stages: [],
    kill: null,
    prepare: true,
    oracles: ["projection", "reachability", "lineage", "sqlstate"],
    classification: "deterministic",
    trials: null,
    budgetMs: 210000,
    requires: [],
    purpose:
      "Establishes the fact the rest of the family turns on: a live checkpoint references a blob version written several supersteps earlier, because a channel that stops changing keeps its old version number. Also records that the checkpointer schema carries NO timestamp column on any of its three tables, so a date-based retention policy cannot reach the blob table at all.",
  },
  {
    id: "f02-naive-checkpoint-deletion-by-date",
    family: "F",
    lane: "stock",
    pairedWith: null,
    kind: "candidate",
    parties: 1,
    launch: "parallel",
    stages: [],
    kill: null,
    prepare: true,
    oracles: ["projection", "reachability", "lineage", "sqlstate"],
    classification: "deterministic",
    trials: null,
    budgetMs: 210000,
    requires: ["f01-blob-sharing-baseline"],
    purpose:
      "Delete all but the newest two checkpoints of a thread, keyed on the only timestamp the schema offers - checkpoint ->> 'ts' inside the JSONB document. Nothing else is touched, because there is no date to filter blobs or writes by. Measures what that costs.",
  },
  {
    id: "f03-naive-superseded-blob-deletion",
    family: "F",
    lane: "stock",
    pairedWith: null,
    kind: "candidate",
    parties: 1,
    launch: "parallel",
    stages: [],
    kill: null,
    prepare: true,
    oracles: ["projection", "reachability", "lineage", "sqlstate"],
    classification: "deterministic",
    trials: null,
    budgetMs: 210000,
    requires: ["f01-blob-sharing-baseline"],
    purpose:
      "Delete every blob version superseded by a newer one - the only ordering checkpoint_blobs has. The intuition is that an old version is dead once a newer exists; f01 measures why it is not, and this measures the consequence for a live head.",
  },
  {
    id: "f04-reachability-sweep-retains-a-paused-thread",
    family: "F",
    lane: "stock",
    pairedWith: null,
    kind: "candidate",
    parties: 1,
    launch: "parallel",
    stages: [],
    kill: null,
    prepare: true,
    oracles: ["projection", "reachability", "lineage", "sqlstate"],
    classification: "deterministic",
    trials: null,
    budgetMs: 210000,
    requires: ["f01-blob-sharing-baseline"],
    purpose:
      "The architecture's proposed rule, run for the first time against the real schema: live set = retained heads, parent lineage, referenced channel versions, pending writes and interrupts. The stale completed thread must go, the paused thread must survive, and - the claim row counts cannot make - it must still resume.",
  },
  {
    id: "f05-prune-nothing-control",
    family: "F",
    lane: "stock",
    pairedWith: null,
    kind: "control",
    parties: 1,
    launch: "parallel",
    stages: [],
    kill: null,
    prepare: true,
    oracles: ["projection", "reachability", "lineage", "sqlstate"],
    classification: "deterministic",
    trials: null,
    budgetMs: 210000,
    requires: ["f04-reachability-sweep-retains-a-paused-thread"],
    purpose:
      "The same sweep told to retain both threads must delete nothing at all. Brackets f04 from below: without it, 'the sweep removed the stale thread' could be a sweep that removes whatever it is pointed at.",
  },
  {
    id: "f06-prune-head-control",
    family: "F",
    lane: "stock",
    pairedWith: null,
    kind: "control",
    parties: 1,
    launch: "parallel",
    stages: [],
    kill: null,
    prepare: true,
    oracles: ["projection", "reachability", "sqlstate"],
    classification: "deterministic",
    trials: null,
    budgetMs: 210000,
    requires: ["f04-reachability-sweep-retains-a-paused-thread"],
    purpose:
      "The same sweep told to retain nothing must delete the paused thread too, and the resume must then fail. Brackets f04 from above: this is what makes 'the retained run still resumes' a load-bearing result rather than a graph that would have resumed regardless.",
  },
  {
    id: "f07-incomplete-sweep-omits-channel-versions",
    family: "F",
    lane: "stock",
    pairedWith: null,
    kind: "mutation",
    parties: 1,
    launch: "parallel",
    stages: [],
    kill: null,
    prepare: true,
    oracles: ["projection", "reachability", "lineage", "sqlstate"],
    classification: "deterministic",
    trials: null,
    budgetMs: 210000,
    requires: ["f04-reachability-sweep-retains-a-paused-thread"],
    purpose:
      "The mutation test for the live set. The sweep keeps only the newest version of each channel instead of every version a live checkpoint references - the plausible and wrong rule - and must leave detectable stranded references in the thread it was told to retain.",
  },
  {
    id: "f08-incomplete-sweep-omits-ancestors",
    family: "F",
    lane: "stock",
    pairedWith: null,
    kind: "mutation",
    parties: 1,
    launch: "parallel",
    stages: [],
    kill: null,
    prepare: true,
    oracles: ["projection", "reachability", "lineage", "sqlstate"],
    classification: "deterministic",
    trials: null,
    budgetMs: 210000,
    requires: ["f04-reachability-sweep-retains-a-paused-thread"],
    purpose:
      "The second mutation: the sweep keeps only the leaves of a retained thread, forgetting that delta replay walks parent lineage. Must leave a checkpoint whose parent is gone.",
  },
  {
    id: "f09-kill-pruner-safe-order",
    family: "F",
    lane: "stock",
    pairedWith: null,
    kind: "candidate",
    parties: 2,
    launch: "sequential",
    stages: [],
    kill: { party: 0, gate: "before-blob-delete", signal: "SIGKILL" },
    prepare: true,
    oracles: ["projection", "reachability", "lineage", "sqlstate", "drain"],
    classification: "deterministic",
    trials: null,
    budgetMs: 240000,
    requires: ["f04-reachability-sweep-retains-a-paused-thread"],
    purpose:
      "The sweep is not transactional, so the order of its deletes decides what a crash leaves behind. Killed between the checkpoint delete and the blob delete, it must leave harmless orphan blobs and NO stranded references, and the retained run must still resume.",
  },
  {
    id: "f10-kill-pruner-unsafe-order-control",
    family: "F",
    lane: "stock",
    pairedWith: null,
    kind: "control",
    parties: 2,
    launch: "sequential",
    stages: [],
    kill: { party: 0, gate: "before-checkpoint-delete", signal: "SIGKILL" },
    prepare: true,
    oracles: ["projection", "reachability", "lineage", "sqlstate", "drain"],
    classification: "deterministic",
    trials: null,
    budgetMs: 240000,
    requires: ["f09-kill-pruner-safe-order"],
    purpose:
      "The same kill with the deletes reversed - blobs first. Must leave stranded live references, which is what proves f09's safe ordering is doing the work rather than the crash being harmless in general.",
  },
];

CASES.push(
  ...FAMILY_A,
  ...FAMILY_B,
  ...FAMILY_C,
  ...FAMILY_D,
  ...FAMILY_D_BATCH,
  ...FAMILY_D_QUERY,
  ...FAMILY_D_SEARCH,
  ...FAMILY_E,
  ...FAMILY_H_EFFECT_KEY,
  ...FAMILY_F,
  ...FAMILY_F_EXTRA,
  ...FAMILY_G,
  ...FAMILY_H_COMPAT,
  ...FAMILY_I,
);

export function caseById(id: string): CaseDef | undefined {
  return CASES.find((entry) => entry.id === id);
}

/** Structural invariants. A violation here must fail before anything is measured. */
export function validateRegistry(): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();

  for (const entry of CASES) {
    if (ids.has(entry.id)) problems.push(`duplicate case id: ${entry.id}`);
    ids.add(entry.id);

    if (isMitigation(entry.lane) && entry.pairedWith === null) {
      problems.push(`${entry.id}: mitigation lane without a stock pair`);
    }
    if (entry.pairedWith !== null && !CASES.some((other) => other.id === entry.pairedWith)) {
      problems.push(`${entry.id}: pairedWith names an unknown case ${entry.pairedWith}`);
    }
    // A trial IS a repeat. Nothing loops the participant body, so a bounded case
    // is sampled once per isolated repeat and three times in the citable set.
    // Declaring any other number would promise sampling the harness does not do,
    // and "observed outcome set over N trials" in the report must mean N = 3.
    if (entry.classification === "bounded-trials" && entry.trials !== 1) {
      problems.push(
        `${entry.id}: bounded-trials must declare trials: 1 — a trial is one repeat`,
      );
    }
    if (entry.classification === "deterministic" && entry.trials !== null) {
      problems.push(`${entry.id}: deterministic case declares trials`);
    }
    if (entry.oracles.length === 0) {
      problems.push(`${entry.id}: declares no oracles`);
    }
    for (const required of entry.requires) {
      if (!CASES.some((other) => other.id === required)) {
        problems.push(`${entry.id}: requires unknown case ${required}`);
      }
    }
    const stageParties = entry.stages.reduce((max, stage) => Math.max(max, stage.parties), 0);
    if (stageParties > entry.parties) {
      problems.push(`${entry.id}: a stage expects more parties than the case launches`);
    }
    if (entry.kill) {
      if (entry.kill.party >= entry.parties) {
        problems.push(`${entry.id}: kill names a party the case does not launch`);
      }
      // The driver kills the target where it parked and only then starts the
      // next party. Parallel launch would let the retry begin before the partial
      // state exists, which is a different experiment.
      if (entry.launch !== "sequential") {
        problems.push(`${entry.id}: a kill case must launch sequentially`);
      }
    }
  }

  return problems;
}

/** Selection closure: pair expansion and `requires`, applied after filtering. */
export function expandSelection(selected: string[]): { ids: string[]; added: string[] } {
  const chosen = new Set(selected);
  const added: string[] = [];

  for (;;) {
    const before = chosen.size;
    for (const id of [...chosen]) {
      const entry = caseById(id);
      if (!entry) continue;
      if (entry.pairedWith && !chosen.has(entry.pairedWith)) {
        chosen.add(entry.pairedWith);
        added.push(entry.pairedWith);
      }
      for (const required of entry.requires) {
        if (!chosen.has(required)) {
          chosen.add(required);
          added.push(required);
        }
      }
    }
    if (chosen.size === before) break;
  }

  const ordered = CASES.filter((entry) => chosen.has(entry.id)).map((entry) => entry.id);
  return { ids: ordered, added };
}
