// Case families.
//
// One family owns one question. Families that replace the stack they measure run
// LAST within a repeat, because a family that destroys a volume cannot be
// followed by one that assumes the volume survived.

export type FamilyId = "K" | "C" | "Q" | "T" | "X" | "R" | "P" | "N";

export type Family = {
  id: FamilyId;
  label: string;
  question: string;
  /** Ordinal within a repeat. Lower runs first. */
  order: number;
  /** True when the family provisions and destroys its own stores. */
  ownsStoreLifecycle: boolean;
  budgetMs: number;
};

export const FAMILIES: Family[] = [
  {
    id: "K",
    label: "Apparatus self-test",
    question:
      "Do the pins, the contract's neutrality, the canonicaliser, and the sanitizer behave as claimed before anything is measured?",
    order: 0,
    ownsStoreLifecycle: false,
    budgetMs: 120_000,
  },
  {
    id: "C",
    label: "Contract conformance",
    question:
      "Does each lane implement the same commands, guards, typed errors, and receipts, with no semantic shortcut?",
    order: 1,
    ownsStoreLifecycle: false,
    budgetMs: 600_000,
  },
  {
    id: "T",
    label: "Temporal, provenance, and lifecycle",
    question:
      "Are world progression, correction, summarisation, contradiction, and retraction distinguishable and traversable?",
    order: 2,
    ownsStoreLifecycle: false,
    budgetMs: 600_000,
  },
  {
    id: "Q",
    label: "Query and retrieval matrix",
    question:
      "Do the golden queries return the oracle's answers, and does structure add retrieval signal beyond lexical similarity?",
    order: 3,
    ownsStoreLifecycle: false,
    budgetMs: 900_000,
  },
  {
    id: "P",
    label: "Coordination plane",
    question:
      "Do both lanes publish identical attributed records, and is non-promotion structural rather than filtered?",
    order: 4,
    ownsStoreLifecycle: false,
    budgetMs: 600_000,
  },
  {
    id: "N",
    label: "Native correction walkthrough",
    question:
      "Can an operator inspect and correct through an evaluated native path without bypassing the command contract?",
    order: 5,
    ownsStoreLifecycle: false,
    budgetMs: 900_000,
  },
  {
    id: "X",
    label: "Concurrency, crash, and stale writes",
    question:
      "Does every concurrent, interrupted, or stale mutation commit coherently or fail visibly?",
    order: 6,
    ownsStoreLifecycle: true,
    budgetMs: 1_800_000,
  },
  {
    id: "R",
    label: "Recovery, rebuild, and portability",
    question:
      "Does canonical state restore, does every derived structure rebuild, and does a portable export survive a fresh import?",
    order: 7,
    ownsStoreLifecycle: true,
    budgetMs: 1_800_000,
  },
];

export function familyById(id: string): Family | null {
  return FAMILIES.find((family) => family.id === id) ?? null;
}

export function familiesInRunOrder(): Family[] {
  return [...FAMILIES].sort((left, right) => left.order - right.order);
}
