// Lanes, and the invariants that keep a mitigation from erasing a stock result.
//
// The pairing rule is mechanical rather than editorial: `cases` refuses to emit
// the matrix if any mitigation case names a stock pair that does not exist, and
// the driver expands any selection to include the pair of every selected
// mitigation. Running a mitigation without its stock counterpart is impossible.

export type LaneId =
  | "stock"
  | "mit-migration"
  | "mit-lease"
  | "mit-storeguard"
  | "mit-compat"
  | "selftest";

export type LaneDef = {
  id: LaneId;
  kind: "stock" | "mitigation" | "selftest";
  title: string;
  /** What unsafe behaviour the guard is allowed to eliminate, and nothing else. */
  target: string | null;
};

export const LANES: LaneDef[] = [
  {
    id: "selftest",
    kind: "selftest",
    title: "harness apparatus self-test",
    target: null,
  },
  {
    id: "stock",
    kind: "stock",
    title: "the published packages, unmodified",
    target: null,
  },
  {
    id: "mit-migration",
    kind: "mitigation",
    title: "advisory-lock single migrator",
    target: "concurrent setup() racing an unlocked read-then-DDL-then-ledger sequence",
  },
  {
    id: "mit-lease",
    kind: "mitigation",
    title: "per-thread advisory lease on a dedicated session",
    target: "two workers executing graph nodes on one thread_id",
  },
  {
    id: "mit-storeguard",
    kind: "mitigation",
    title: "fail-closed Store namespace and configuration validation",
    target: "measured-unsafe namespace and option shapes reaching the Store",
  },
  {
    id: "mit-compat",
    kind: "mitigation",
    title: "compatibility-manifest refusal before invocation",
    target: "resuming persisted state against an incompatible graph",
  },
];

export function laneById(id: string): LaneDef | undefined {
  return LANES.find((lane) => lane.id === id);
}

export function isMitigation(id: LaneId): boolean {
  return laneById(id)?.kind === "mitigation";
}
