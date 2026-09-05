// Lanes and their pairing rules.
//
// A mitigation lane is never runnable without the stock lane it is supposed to
// improve on. Running a safeguard alone proves nothing: the safeguard has to be
// shown fixing something that was measurably broken without it.

export type LaneId = "selftest" | "lane-m" | "lane-n" | "lane-m-guarded";

export type Lane = {
  id: LaneId;
  label: string;
  /** The stock lane this one mitigates, if any. */
  mitigates: LaneId | null;
  /** Canonical store for structured knowledge. */
  canonical: "none" | "markdown" | "graph";
  /**
   * Derived structures this lane maintains behind canonical state.
   *
   * Only structures that EXIST and are read. `graph.vector` was declared here
   * and never created: Lane N has no vector index, and semantic retrieval is
   * answered by the shared in-memory fusion in both lanes. A declared structure
   * nothing maintains is the same class of defect as a control that cannot fail.
   */
  derived: string[];
};

export const LANES: Lane[] = [
  {
    id: "selftest",
    label: "Apparatus self-test",
    mitigates: null,
    canonical: "none",
    derived: [],
  },
  {
    id: "lane-m",
    label: "Lane M: Markdown canonical, Postgres projection",
    mitigates: null,
    canonical: "markdown",
    derived: ["projection.claim", "projection.edge", "projection.chunk"],
  },
  {
    id: "lane-m-guarded",
    label: "Lane M with single-migrator and mutation-intent safeguards",
    mitigates: "lane-m",
    canonical: "markdown",
    derived: ["projection.claim", "projection.edge", "projection.chunk"],
  },
  {
    id: "lane-n",
    label: "Lane N: Neo4j canonical, Markdown sources",
    mitigates: null,
    canonical: "graph",
    derived: ["graph.fulltext"],
  },
  // `lane-n-guarded` used to be declared here and was never implemented:
  // `LaneNOptions` has no guarded mode, and nothing in the adapter took a lock.
  // It is removed rather than left standing, because a mitigation lane that does
  // not exist reads in the evidence exactly like one that was measured. Lane N's
  // revision-uniqueness backstop now lives in the STOCK lane, enforced by the
  // constraint on insert, so there is no safeguard left for a variant to add.
];

export function laneById(id: string): Lane | null {
  return LANES.find((lane) => lane.id === id) ?? null;
}

/** Expand a selection so no mitigation lane runs without its stock pair. */
export function expandLanes(selected: string[]): LaneId[] {
  const out = new Set<LaneId>();
  for (const id of selected) {
    const lane = laneById(id);
    if (!lane) continue;
    out.add(lane.id);
    if (lane.mitigates) out.add(lane.mitigates);
  }
  return [...out];
}

/** A dangling pair is a registry defect, not a runtime surprise. */
export function pairingIsSound(): boolean {
  return LANES.every((lane) => lane.mitigates === null || laneById(lane.mitigates) !== null);
}
