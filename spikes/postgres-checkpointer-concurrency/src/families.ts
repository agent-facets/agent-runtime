// Experiment families and their database provisioning.
//
// Each family gets its own PostgreSQL container and named volume per repeat, on
// one shared internal network. Schema-per-family in a single database would not
// work: `CREATE EXTENSION IF NOT EXISTS vector` is database-scoped, so a Store
// migration race in family A would pre-create the extension family D has to race
// for. Separate clusters also make `datname`-scoped isolation witnesses honest
// and let a failed family's volume be preserved without holding the others.

export type FamilyId = "S" | "A" | "B" | "C" | "D" | "E" | "F" | "G" | "H" | "I";

export type Provision =
  /** Harness schema only. The vendor relations' existence is the subject. */
  | "bare"
  /** Harness schema plus one serialized checkpointer setup(). */
  | "checkpointer"
  /** As above, plus a Store migrated with an index configuration. */
  | "checkpointer+store";

export type FamilyDef = {
  id: FamilyId;
  title: string;
  /**
   * The family default. A case may override it — several Store cases have to
   * start from a database with NO store tables, because whether `setup()` was
   * ever called is the subject rather than the setting.
   */
  provision: Provision;
  /** Runs last in a repeat: it destroys and recreates its own database container. */
  ownsDatabaseLifecycle: boolean;
  /**
   * Whether the projector reads the Store tables row by row.
   *
   * Off for every family whose subject is the checkpointer: `projectStore`
   * returns a constant empty shape when the tables are absent, and adding that
   * to a lane's digest would be noise asserting nothing. Family A already
   * captures the terminal Store SCHEMA through `relations` and `storeLedger`;
   * only family D needs the items and vectors themselves.
   */
  projectsStore: boolean;
  budgetMs: number;
};

export const FAMILIES: FamilyDef[] = [
  {
    id: "S",
    title: "harness self-test",
    provision: "bare",
    ownsDatabaseLifecycle: false,
    projectsStore: false,
    budgetMs: 600_000,
  },
  {
    id: "A",
    title: "setup and migrations",
    provision: "bare",
    ownsDatabaseLifecycle: false,
    projectsStore: false,
    budgetMs: 1_080_000,
  },
  {
    id: "B",
    title: "checkpointer concurrency and conflicts",
    provision: "checkpointer",
    ownsDatabaseLifecycle: false,
    projectsStore: false,
    budgetMs: 900_000,
  },
  {
    id: "C",
    title: "transactions, pools and locks",
    provision: "checkpointer",
    ownsDatabaseLifecycle: false,
    projectsStore: false,
    budgetMs: 1_200_000,
  },
  {
    id: "D",
    title: "the PostgresStore surface",
    provision: "checkpointer+store",
    ownsDatabaseLifecycle: false,
    projectsStore: true,
    // The largest family by case count: the approved scope is the COMPLETE
    // public Store surface, and convenience methods and batch() are counted
    // separately because a result from one may not be generalised to the other.
    budgetMs: 2_700_000,
  },
  {
    id: "E",
    title: "subgraph namespaces",
    provision: "checkpointer",
    ownsDatabaseLifecycle: false,
    projectsStore: false,
    budgetMs: 600_000,
  },
  {
    id: "F",
    title: "retention and blob reachability",
    provision: "checkpointer",
    ownsDatabaseLifecycle: false,
    projectsStore: false,
    // Ten cases, each of which builds two threads in prepare and then resumes
    // one afterwards, so the per-case cost is roughly double a family B case.
    budgetMs: 1_500_000,
  },
  {
    id: "G",
    title: "database and container-stack restart",
    provision: "checkpointer",
    ownsDatabaseLifecycle: true,
    projectsStore: false,
    budgetMs: 1_500_000,
  },
  {
    id: "H",
    title: "effect keys and graph compatibility",
    provision: "checkpointer",
    ownsDatabaseLifecycle: false,
    projectsStore: false,
    budgetMs: 960_000,
  },
  {
    id: "I",
    title: "mitigation lanes",
    provision: "bare",
    ownsDatabaseLifecycle: false,
    projectsStore: false,
    budgetMs: 960_000,
  },
];

export function familyById(id: string): FamilyDef | undefined {
  return FAMILIES.find((family) => family.id === id);
}

/** Family G must run last in a repeat: it replaces the stack it measures. */
export function familyOrder(ids: FamilyId[]): FamilyId[] {
  const rank = (id: FamilyId): number => (familyById(id)?.ownsDatabaseLifecycle ? 1 : 0);
  return [...ids].sort((left, right) => {
    const delta = rank(left) - rank(right);
    if (delta !== 0) return delta;
    return FAMILIES.findIndex((f) => f.id === left) - FAMILIES.findIndex((f) => f.id === right);
  });
}
