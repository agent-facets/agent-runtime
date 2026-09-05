// Retrieval metrics.
//
// Runs in the COMPARATOR, which is the only container the graded judgments are
// mounted into. A lane emits a ranking and never sees what it was supposed to
// rank; the scoring happens afterwards.
//
// Two of these metrics are unusual on purpose:
//
//   `harmRate@10` treats a retracted claim or an unpromoted peer assertion as a
//   COST rather than as a miss. In an ordinary IR setting an irrelevant result
//   scores zero; here, surfacing material the system was told to stop believing
//   is the failure the whole architecture exists to prevent, so it has to be
//   able to push a score down.
//
//   `structuralRecall` is scored over gold items that share NO vocabulary term
//   with the query. Reaching them requires a typed edge, an alias resolution, or
//   a temporal interval — nothing lexical can find them. It is therefore the
//   only metric here that can distinguish "the graph helped" from "the words
//   happened to match", which is the question the retrieval dimension exists to
//   answer.

export type Judgment = {
  grades: Record<string, number>;
  mustRankFirst: string;
  mustExclude: string[];
};

export type RetrievalMetrics = {
  k: number;
  returned: number;
  "recall@5": number;
  "recall@10": number;
  "recall@20": number;
  "ndcg@10": number;
  answerSupportRecall: number;
  structuralRecall: number;
  "harmRate@10": number;
  rankedFirst: string | null;
  mustRankFirstHeld: boolean;
  mustExcludeHeld: boolean;
};

function round(value: number): number {
  // Six places: enough to distinguish two lanes, few enough that a digest is
  // not hostage to floating-point noise in the last bit.
  return Math.round(value * 1e6) / 1e6;
}

function recallAt(ranked: string[], gold: Set<string>, k: number): number {
  if (gold.size === 0) return 0;
  const top = ranked.slice(0, k);
  const hit = top.filter((id) => gold.has(id)).length;
  return round(hit / gold.size);
}

/**
 * Linear-gain DCG, deliberately not the `2^rel - 1` form.
 *
 * The exponential form is undefined in spirit for negative relevance: it maps
 * `-1` to `-0.5`, which understates a harmful result relative to a merely
 * useless one. Linear gain keeps the penalty proportional to the judgment the
 * oracle actually assigned, and the result may legitimately go negative when
 * harmful material ranks highly. That is a real signal, not an error.
 */
function dcg(ids: string[], grades: Record<string, number>, k: number): number {
  let total = 0;
  ids.slice(0, k).forEach((id, index) => {
    total += (grades[id] ?? 0) / Math.log2(index + 2);
  });
  return total;
}

export type SupportInfo = Record<string, { evidenceCount: number; sourceCount: number }>;

export function scoreRetrieval(
  ranked: string[],
  judgment: Judgment,
  structuralSubset: string[],
  support: SupportInfo,
): RetrievalMetrics {
  const grades = judgment.grades;
  const gold = new Set(
    Object.entries(grades)
      .filter(([, grade]) => grade > 0)
      .map(([id]) => id),
  );
  const harmful = new Set(
    Object.entries(grades)
      .filter(([, grade]) => grade < 0)
      .map(([id]) => id),
  );

  const ideal = Object.entries(grades)
    .sort(([leftId, left], [rightId, right]) => right - left || (leftId < rightId ? -1 : 1))
    .map(([id]) => id);
  const idealDcg = dcg(ideal, grades, 10);
  const actualDcg = dcg(ranked, grades, 10);

  const top10 = ranked.slice(0, 10);
  const structural = new Set(structuralSubset);
  const structuralHit = top10.filter((id) => structural.has(id)).length;

  // "Can the system justify what it retrieved?" — of the GOLD items it actually
  // surfaced, how many reach evidence that resolves to a source. A retrieved
  // claim nobody can justify is worse than one that was never retrieved.
  const retrievedGold = top10.filter((id) => gold.has(id));
  const supported = retrievedGold.filter((id) => (support[id]?.sourceCount ?? 0) > 0).length;

  return {
    k: 10,
    returned: ranked.length,
    "recall@5": recallAt(ranked, gold, 5),
    "recall@10": recallAt(ranked, gold, 10),
    "recall@20": recallAt(ranked, gold, 20),
    "ndcg@10": idealDcg === 0 ? 0 : round(actualDcg / idealDcg),
    answerSupportRecall: retrievedGold.length === 0 ? 0 : round(supported / retrievedGold.length),
    structuralRecall: structural.size === 0 ? 0 : round(structuralHit / structural.size),
    "harmRate@10": round(top10.filter((id) => harmful.has(id)).length / 10),
    rankedFirst: ranked[0] ?? null,
    mustRankFirstHeld: ranked[0] === judgment.mustRankFirst,
    mustExcludeHeld: judgment.mustExclude.every((id) => !top10.includes(id)),
  };
}
