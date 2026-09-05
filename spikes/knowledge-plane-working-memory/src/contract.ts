// The pinned contract, asserted at run time rather than trusted.
//
// Three independent records of every pin have to agree: the installed package's
// own `package.json`, the committed lockfile entry (version AND integrity), and
// the fixture manifest that gets copied into the report. Checking only the first
// would let the manifest misdescribe the image without anything noticing.

import { readFileSync } from "node:fs";

// Deliberately schema /3. Spikes 05 and 06 froze `/1` and `/2`; their digests
// must remain structurally uncomparable to anything produced here.
export const EVIDENCE_SCHEMA = "agent-runtime/spike-evidence/3";
export const SPIKE_ID = "knowledge-plane-working-memory";

/** The backend-neutral knowledge contract version both lanes implement. */
export const KNOWLEDGE_CONTRACT_VERSION = "knowledge/1.0.0";
/** The coordination wire format version. */
export const COORDINATION_SCHEMA_VERSION = "coord/1.0";

/** Lane M's derived projection and the shared execution plane live here. */
export const PROJECTION_SCHEMA = "kp_projection";
export const EXECUTION_SCHEMA = "kp_execution";
export const PROBE_SCHEMA = "kp_probe";

export const PINNED_PACKAGES: Record<string, string> = {
  "neo4j-driver": "6.2.0",
  pg: "8.16.3",
  zod: "4.5.4",
};

/**
 * Relations the harness itself owns.
 *
 * The probe schema is deliberately separate from both the execution plane and
 * Lane M's projection: an observation the subject could have written is not an
 * independent witness.
 */
export const PROBE_RELATIONS: string[] = [
  `${PROBE_SCHEMA}.event`,
  `${PROBE_SCHEMA}.barrier`,
  `${PROBE_SCHEMA}.barrier_arrival`,
  `${PROBE_SCHEMA}.gate_park`,
];

/**
 * The execution plane, owned by Postgres in BOTH lanes.
 *
 * Work item identity, run attempts, and the idempotency ledger are execution
 * concerns. Putting them here rather than in either canonical knowledge store is
 * what keeps the lane comparison about knowledge rather than about who happens
 * to own the ledger.
 */
export const EXECUTION_RELATIONS: string[] = [
  `${EXECUTION_SCHEMA}.work_item`,
  `${EXECUTION_SCHEMA}.run_attempt`,
  `${EXECUTION_SCHEMA}.idempotency`,
  `${EXECUTION_SCHEMA}.mutation_intent`,
];

/** Lane M's derived projection. Rebuildable from canonical Markdown, never authoritative. */
export const PROJECTION_RELATIONS: string[] = [
  `${PROJECTION_SCHEMA}.claim`,
  `${PROJECTION_SCHEMA}.edge`,
  `${PROJECTION_SCHEMA}.evidence`,
  `${PROJECTION_SCHEMA}.chunk`,
  `${PROJECTION_SCHEMA}.freshness`,
];

export type LaneId = "m" | "n";

/**
 * Advisory-lock key space for the single-migrator safeguard.
 *
 * Spike 06 measured that unguarded concurrent setup races and fails across a
 * bounded set of SQLSTATEs. Both lanes elect their migrator through Postgres:
 * Neo4j Community has no advisory-lock primitive, so Lane N's guarded lane
 * borrows the same election rather than inventing a weaker one. The unguarded
 * Neo4j case is still measured, paired against the guarded lane.
 */
export const ADVISORY_CLASS_MIGRATION = 0x4b50;

export function migrationLockKey(scope: string): number {
  let hash = 0;
  for (let index = 0; index < scope.length; index += 1) {
    hash = (Math.imul(hash, 31) + scope.charCodeAt(index)) | 0;
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

/**
 * The pin predicate, exposed so a control can exercise IT rather than a
 * lookalike.
 *
 * The control used to assert `installed !== `${expected}-mutant`` — a comparison
 * against a string nothing ever produces, which passes on any tree and never
 * touches this function. A control that cannot fail is not a control.
 */
export function pinAgrees(check: PackageCheck, expected: string): boolean {
  return (
    check.installed === expected &&
    check.lockVersion === expected &&
    check.manifestVersion === expected &&
    check.lockIntegrity !== null &&
    check.lockIntegrity === check.manifestIntegrity
  );
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

    check.matches = pinAgrees(check, expected);

    return check;
  });
}

/**
 * Wall-clock ceilings. Every one of these expiring is a harness fault.
 *
 * Each sits BELOW the driver's enclosing per-container ceiling on purpose: a
 * stuck rendezvous must name itself in JSON rather than surface as an anonymous
 * container timeout with no evidence. No value here is a fault trigger — faults
 * fire on durable state, never on elapsed time.
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
  /** How long a backend or session set is watched before concluding it drained. */
  drainWaitMs: 30_000,
  drainPollMs: 100,
  /** A single knowledge command. */
  commandMs: 15_000,
  /** A projection rebuild or graph reindex. */
  rebuildMs: 300_000,
  /** Offline dump plus restore into a fresh stack. */
  restoreMs: 600_000,
  conditionWaitMs: 60_000,
};

/**
 * The deterministic clock.
 *
 * Every mutation carries an explicit tick rather than reading the wall clock, so
 * valid-time and transaction-time answers are reproducible across repeats and
 * across lanes. Wall-clock timestamps are recorded separately and are always
 * volatile.
 */
export const CLOCK_ORIGIN = "2026-01-05T09:00:00.000Z";
export const CLOCK_TICK_MS = 60_000;

export function tickToInstant(tick: number): string {
  return new Date(Date.parse(CLOCK_ORIGIN) + tick * CLOCK_TICK_MS).toISOString();
}
