// The pinned contract, asserted at run time rather than trusted.
//
// The lockfile fixes what npm installs; this file fixes what the measurement is
// allowed to run against. A dependency bump that changes durability semantics
// must fail loudly here instead of silently producing a different result under
// the same spike name.
//
// Three independent records of every pin have to agree: the installed package's
// own `package.json`, the committed lockfile entry (version AND integrity), and
// the fixture manifest that gets copied into the report. Checking only the first
// would let the manifest misdescribe the image without anything noticing.

import { readFileSync } from "node:fs";

export const EVIDENCE_SCHEMA = "agent-runtime/spike-evidence/1";
export const SPIKE_ID = "langgraph-durability";

export const CHECKPOINT_SCHEMA = "lg_checkpoints";
export const PROBE_SCHEMA = "spike_probe";

/** Exact installed versions the acceptance claims are about. */
export const PINNED_PACKAGES: Record<string, string> = {
  "@langchain/langgraph": "1.4.13",
  "@langchain/langgraph-checkpoint": "1.1.5",
  "@langchain/langgraph-checkpoint-postgres": "1.0.5",
  "@langchain/core": "1.2.9",
  pg: "8.16.3",
  zod: "4.5.4",
};

/** Every relation the measurement depends on. A substring check is not enough. */
export const EXPECTED_RELATIONS: string[] = [
  `${CHECKPOINT_SCHEMA}.checkpoint_blobs`,
  `${CHECKPOINT_SCHEMA}.checkpoint_migrations`,
  `${CHECKPOINT_SCHEMA}.checkpoint_writes`,
  `${CHECKPOINT_SCHEMA}.checkpoints`,
  `${PROBE_SCHEMA}.event`,
  `${PROBE_SCHEMA}.latch`,
];

/** The root graph's checkpoint namespace. Subgraphs are out of scope. */
export const ROOT_NS = "";

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
 * The decision payload used on every real resume.
 *
 * Deliberately an object rather than `true`. `mapCommand` in the pinned release
 * branches on the truthiness of `cmd.resume`, so a falsy value never becomes a
 * resume write — see the `int-false` case, which measures what actually happens.
 */
export const RESUME_DECISION = { decision: "approved", source: "spike" };

/**
 * Wall-clock ceilings. Every one of these expiring is a harness fault.
 *
 * `latchWaitMs` sits BELOW the driver's own per-container ceiling on purpose: a
 * stuck latch must name itself in JSON rather than surface as an anonymous
 * container timeout with no evidence.
 */
export const TIMEOUTS = {
  latchPollMs: 50,
  latchWaitMs: 150_000,
  conditionWaitMs: 60_000,
  /** How long the scheduler is watched before concluding a node did not start. */
  gateObservationMs: 750,
  gatePollMs: 25,
};
