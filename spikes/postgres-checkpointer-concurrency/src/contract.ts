// The pinned contract, asserted at run time rather than trusted.
//
// Three independent records of every pin have to agree: the installed package's
// own `package.json`, the committed lockfile entry (version AND integrity), and
// the fixture manifest that gets copied into the report. Checking only the first
// would let the manifest misdescribe the image without anything noticing.

import { readFileSync } from "node:fs";

// Deliberately schema /2. Spike 05's evidence is `/1` and its frozen digest must
// remain structurally uncomparable to anything produced here.
export const EVIDENCE_SCHEMA = "agent-runtime/spike-evidence/2";
export const SPIKE_ID = "postgres-checkpointer-concurrency";

export const CHECKPOINT_SCHEMA = "lg_checkpoints";
export const STORE_SCHEMA = "lg_store";
export const PROBE_SCHEMA = "spike_probe";

export const PINNED_PACKAGES: Record<string, string> = {
  "@langchain/langgraph": "1.4.13",
  "@langchain/langgraph-checkpoint": "1.1.5",
  "@langchain/langgraph-checkpoint-postgres": "1.0.5",
  "@langchain/core": "1.2.9",
  pg: "8.16.3",
  zod: "4.5.4",
};

/**
 * Relations the harness itself owns. The vendor's relations are NOT listed here:
 * whether they exist is the subject of family A, so asserting them at
 * provisioning time would decide the experiment before it ran.
 */
export const HARNESS_RELATIONS: string[] = [
  `${PROBE_SCHEMA}.event`,
  `${PROBE_SCHEMA}.barrier`,
  `${PROBE_SCHEMA}.barrier_arrival`,
  `${PROBE_SCHEMA}.gate_park`,
  `${PROBE_SCHEMA}.conflict`,
];

/** The vendor relation set, for families that require a migrated database. */
export const CHECKPOINTER_RELATIONS: string[] = [
  `${CHECKPOINT_SCHEMA}.checkpoint_blobs`,
  `${CHECKPOINT_SCHEMA}.checkpoint_migrations`,
  `${CHECKPOINT_SCHEMA}.checkpoint_writes`,
  `${CHECKPOINT_SCHEMA}.checkpoints`,
];

/**
 * One database per case, created by the family's provisioning step.
 *
 * `CREATE EXTENSION` is database-scoped and several cases must start from a
 * genuinely cold cluster, so schema-per-case is not enough: a Store case that
 * created `vector` would decide the outcome of the case that has to race for it.
 */
export function databaseForCase(caseId: string): string {
  return `spike_${caseId.replace(/[^A-Za-z0-9]+/g, "_").toLowerCase()}`.slice(0, 63);
}

/**
 * One thread per case, derived from the case id.
 *
 * Cases already have a database each, so a single thread per case is enough to
 * keep lineage unambiguous — and deriving it means the projector can read a
 * case's lineage without the participant having to report which thread it used,
 * which would let a buggy participant point the oracle at the wrong rows.
 */
export function threadForCase(caseId: string): string {
  return `thread-${caseId}`;
}

/**
 * Literal operands for the raw conflict cases.
 *
 * Fixed rather than generated: a first/last-writer-wins claim is settled by
 * comparing stored bytes against a known candidate, so both candidates have to
 * be constants the report can quote. The checkpoint ids are well-formed UUIDv6
 * strings only for realism — the columns are TEXT and nothing parses them.
 */
export const CONFLICT_FIXTURE = {
  channel: "spike_channel",
  version: "1",
  /** Written by both parties in the same-id cases. */
  sharedCheckpointId: "01960000-0000-6000-8000-0000000000c0",
  /** Distinct ids for the case where only the BLOB key collides. */
  checkpointIdByParty: [
    "01960000-0000-6000-8000-0000000000a0",
    "01960000-0000-6000-8000-0000000000b0",
  ],
  /** Pre-existing checkpoint the putWrites cases attach to. */
  baseCheckpointId: "01960000-0000-6000-8000-000000000000",
  /** Both parties write under ONE task id, so the primary key collides. */
  taskId: "spike-task-shared",
  ordinaryChannel: "spike_channel",
  /** In WRITES_IDX_MAP, so putWrites takes its DO UPDATE branch. */
  specialChannel: "__interrupt__",
  payloadByParty: ["party-0-payload", "party-1-payload"],
} as const;

/**
 * Advisory-lock key space for the migration safeguard.
 *
 * The two-key `(int, int)` and one-key `bigint` forms are disjoint key spaces in
 * PostgreSQL, so fixing one form per purpose means the migration lock and the
 * per-thread lease can never collide. Migration uses the two-key form; the
 * object id is derived from the schema and ledger table so `lg_checkpoints` and
 * `lg_store` migrate independently rather than serialising against each other.
 */
export const ADVISORY_CLASS_MIGRATION = 0x4c47;

export function migrationLockKey(schema: string, ledgerTable: string): number {
  const input = `${schema}\u0000${ledgerTable}`;
  let hash = 0;
  for (let index = 0; index < input.length; index += 1) {
    hash = (Math.imul(hash, 31) + input.charCodeAt(index)) | 0;
  }
  return hash;
}

export type PackageCheck = {
  name: string;
  expected: string;
  installed: string | null;
  lockVersion: string | null;
  lockIntegrity: string | null;
  manifestVersion: string | null;
  manifestIntegrity: string | null;
  matches: boolean;
};

function readJson(relative: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(new URL(relative, import.meta.url), "utf8")) as Record<
      string,
      unknown
    >;
  } catch {
    return null;
  }
}

/** The fixture manifest as baked into the image, not as it sits on the host. */
export function imageManifest(): Record<string, unknown> | null {
  return readJson("../fixtures/manifest.json");
}

export function embeddingFixture(): { dims: number; vectors: Record<string, number[]> } {
  const fixture = readJson("../fixtures/embeddings.json") as {
    dims?: number;
    vectors?: Record<string, number[]>;
  } | null;
  if (!fixture?.dims || !fixture.vectors) {
    throw new Error("embedding fixture missing or malformed");
  }
  return { dims: fixture.dims, vectors: fixture.vectors };
}

export function rankingFixture(): Record<string, unknown> {
  const fixture = readJson("../fixtures/rankings.json");
  if (!fixture) throw new Error("ranking fixture missing");
  return fixture;
}

export function checkPinnedPackages(): PackageCheck[] {
  const lock = readJson("../package-lock.json") as
    | { packages?: Record<string, { version?: string; integrity?: string }> }
    | null;
  const manifest = imageManifest() as
    | { candidate?: Record<string, { version?: string; integrity?: string }> }
    | null;

  return Object.entries(PINNED_PACKAGES).map(([name, expected]) => {
    const installed =
      (readJson(`../node_modules/${name}/package.json`) as { version?: string } | null)?.version ??
      null;
    const lockEntry = lock?.packages?.[`node_modules/${name}`] ?? null;
    const manifestEntry = manifest?.candidate?.[name] ?? null;

    const check: PackageCheck = {
      name,
      expected,
      installed,
      lockVersion: lockEntry?.version ?? null,
      lockIntegrity: lockEntry?.integrity ?? null,
      manifestVersion: manifestEntry?.version ?? null,
      manifestIntegrity: manifestEntry?.integrity ?? null,
      matches: false,
    };

    check.matches =
      check.installed === expected &&
      check.lockVersion === expected &&
      check.manifestVersion === expected &&
      check.lockIntegrity !== null &&
      check.lockIntegrity === check.manifestIntegrity;

    return check;
  });
}

/**
 * The decision payload used on every real resume. Deliberately an object rather
 * than `true`: the pinned release branches on the truthiness of `cmd.resume`, so
 * a falsy value never becomes a resume write.
 */
export const RESUME_DECISION = { decision: "approved", source: "spike" };

/**
 * Wall-clock ceilings. Every one of these expiring is a harness fault.
 *
 * Each sits BELOW the driver's enclosing per-container ceiling on purpose: a
 * stuck rendezvous must name itself in JSON rather than surface as an anonymous
 * container timeout with no evidence.
 */
export const TIMEOUTS = {
  barrierPollMs: 25,
  /** A participant waiting to be released. */
  barrierWaitMs: 120_000,
  /** A coordinator waiting for every declared party to arrive. */
  barrierArrivalMs: 30_000,
  /** A coordinator waiting for a blocked -> blocking edge to appear. */
  lockEdgeWaitMs: 20_000,
  lockEdgePollMs: 50,
  /** How long a backend set is watched before concluding it has drained. */
  drainWaitMs: 30_000,
  drainPollMs: 100,
  conditionWaitMs: 60_000,
};
