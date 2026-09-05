// Corpus and oracle loading, plus the referential-integrity check that has to
// pass before either adapter exists.
//
// Neither tree is baked into the image. The corpus is mounted read-only into
// both lanes with identical bytes; the oracle is mounted ONLY into a
// network-less validator or comparator container, never into a lane. Paths are
// supplied by the caller so an adapter cannot reach either by hard-coded path.

import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export type CorpusEntity = {
  id: string;
  kind: string;
  canonicalName: string;
  aliases: string[];
  sensitivity: string;
  visibility: string;
};

export type CorpusSource = {
  id: string;
  system: string;
  externalId: string;
  uri: string;
  sourceAuthority: string;
  sensitivity: string;
  visibility: string;
  documents: Array<{ locator: string; text: string }>;
};

export type Corpus = {
  corpusId: string;
  clock: { origin: string; tickMs: number };
  entities: CorpusEntity[];
  sources: CorpusSource[];
  workItems: Array<{
    id: string;
    title: string;
    intent: string;
    attempts: Array<{ id: string; actor: string; outcome: string; note: string }>;
    handoff: { id: string; fromRun: string; toRun: string; carriedConstraints: string[] } | null;
  }>;
  peerRecords: Array<Record<string, unknown>>;
  negativeControls: Record<string, string>;
};

export type Mutation = {
  t: number;
  cmd: string;
  actor?: string;
  note?: string;
  expect?: string;
  guard?: { mode: string; target?: string; useStaleToken?: boolean };
  args: Record<string, unknown>;
};

export type MutationScript = { mutations: Mutation[] };

export type OracleQuery = {
  id: string;
  query: string;
  args: Record<string, unknown>;
  constraint?: Record<string, unknown>;
  order: "set" | "sequence" | "ranked";
  [key: string]: unknown;
};

/**
 * Retrieval INPUTS, mounted with the corpus into both lanes.
 *
 * Deliberately not in the oracle: a lane has to consume these vectors to answer
 * the hybrid query at all, and the oracle is never mounted into a lane. Keeping
 * them here is what lets the graded judgments stay unreachable.
 */
/** A golden QUESTION, with no answer attached. Mounted into both lanes. */
export type CorpusQuery = {
  id: string;
  query: string;
  args: Record<string, unknown>;
  constraint?: Record<string, unknown>;
};

export type CorpusQueries = {
  defaults: Record<string, unknown>;
  queries: CorpusQuery[];
};

export type CorpusVectors = {
  vocabulary: string[];
  fusionWeights: Record<string, number>;
  vectors: Record<string, number[]>;
  queryVectors: Record<string, number[]>;
};

export type Judgment = {
  grades: Record<string, number>;
  mustRankFirst: string;
  mustExclude: string[];
};

export type Oracle = {
  expectedMutations: {
    defaultExpectation: string;
    expectations: Array<{ t: number; outcome: string; code: string; category: string }>;
    effectExpectations: Array<Record<string, unknown>>;
    terminalInvariants: Record<string, number>;
  };
  expectedQueries: { queries: OracleQuery[]; depthProfile: Record<string, number> };
  judgments: {
    judgments: Record<string, Judgment>;
    metrics: string[];
    structuralRecallSubset: Record<string, unknown>;
  };
};

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

export function loadCorpus(root: string): {
  corpus: Corpus;
  script: MutationScript;
  vectors: CorpusVectors;
  questions: CorpusQueries;
} {
  return {
    corpus: readJson<Corpus>(join(root, "corpus.json")),
    script: readJson<MutationScript>(join(root, "mutations.json")),
    vectors: readJson<CorpusVectors>(join(root, "vectors.json")),
    questions: readJson<CorpusQueries>(join(root, "queries.json")),
  };
}

export function loadOracle(root: string): Oracle {
  return {
    expectedMutations: readJson(join(root, "expected-mutations.json")),
    expectedQueries: readJson(join(root, "expected-queries.json")),
    judgments: readJson(join(root, "judgments.json")),
  };
}

/** Per-file digests plus a tree digest, so a frozen tree can be proven unchanged. */
export function treeDigest(root: string): { files: Record<string, string>; root: string } {
  const files: Record<string, string> = {};
  const walk = (dir: string, prefix: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      const rel = prefix === "" ? name : `${prefix}/${name}`;
      if (statSync(full).isDirectory()) walk(full, rel);
      else files[rel] = createHash("sha256").update(readFileSync(full)).digest("hex");
    }
  };
  walk(root, "");
  const rootDigest = createHash("sha256")
    .update(
      Object.keys(files)
        .sort()
        .map((key) => `${key}:${files[key]}`)
        .join("\n"),
    )
    .digest("hex");
  return { files, root: rootDigest };
}

export type ValidationProblem = { kind: string; detail: string };

/**
 * Referential integrity across corpus, script, and oracle.
 *
 * Authoring three literal artifacts by hand is how the oracle stays independent;
 * it is also how a typo silently becomes a lane failure. This check exists so a
 * fixture defect surfaces as a fixture defect.
 */
export function validateFixtures(
  corpus: Corpus,
  script: MutationScript,
  vectors: CorpusVectors,
  questions: CorpusQueries,
  oracle: Oracle,
): ValidationProblem[] {
  const problems: ValidationProblem[] = [];
  const entityIds = new Set(corpus.entities.map((entity) => entity.id));
  const sourceIds = new Set(corpus.sources.map((source) => source.id));
  const peerRecordIds = new Set(
    corpus.peerRecords.map((record) => String((record as { recordId?: string }).recordId ?? "")),
  );
  const workItemIds = new Set(corpus.workItems.map((item) => item.id));

  // Ticks are unique and strictly increasing. Anything else makes the temporal
  // answers depend on file order rather than on the declared clock.
  let previous = -Infinity;
  for (const mutation of script.mutations) {
    if (!Number.isInteger(mutation.t)) {
      problems.push({ kind: "tick-not-integer", detail: String(mutation.t) });
    }
    if (mutation.t <= previous) {
      problems.push({ kind: "tick-not-increasing", detail: `${previous} -> ${mutation.t}` });
    }
    previous = mutation.t;
  }

  const declaredClaims = new Set<string>();
  const declaredRelationships = new Set<string>();

  for (const mutation of script.mutations) {
    const args = mutation.args;
    const at = `t${mutation.t} ${mutation.cmd}`;

    const entityRef = args.entityId ?? args.subject ?? args.survivorId ?? args.mergedId;
    if (typeof entityRef === "string" && !entityIds.has(entityRef)) {
      problems.push({ kind: "unknown-entity", detail: `${at}: ${entityRef}` });
    }
    for (const key of ["from", "to"]) {
      const value = args[key];
      if (typeof value === "string" && !entityIds.has(value)) {
        problems.push({ kind: "unknown-entity", detail: `${at}: ${key}=${value}` });
      }
    }
    if (typeof args.sourceRefId === "string" && !sourceIds.has(args.sourceRefId)) {
      problems.push({ kind: "unknown-source", detail: `${at}: ${args.sourceRefId}` });
    }
    if (typeof args.workItemId === "string" && !workItemIds.has(args.workItemId)) {
      // Coordination records carry a publisher-local work item id that is
      // deliberately opaque, so only knowledge commands are checked here.
      if (mutation.cmd !== "PublishActivityRecord") {
        problems.push({ kind: "unknown-work-item", detail: `${at}: ${args.workItemId}` });
      }
    }
    if (typeof args.recordId === "string" && mutation.cmd !== "PublishActivityRecord") {
      if (!peerRecordIds.has(args.recordId)) {
        problems.push({ kind: "unknown-peer-record", detail: `${at}: ${args.recordId}` });
      }
    }

    const evidence = args.evidence;
    if (Array.isArray(evidence)) {
      for (const link of evidence as Array<Record<string, unknown>>) {
        const sourceId = link.sourceRefId;
        if (typeof sourceId === "string") {
          const source = corpus.sources.find((entry) => entry.id === sourceId);
          if (!source) {
            problems.push({ kind: "unknown-source", detail: `${at}: ${sourceId}` });
          } else if (
            typeof link.locator === "string" &&
            !source.documents.some((document) => document.locator === link.locator)
          ) {
            problems.push({ kind: "unknown-locator", detail: `${at}: ${sourceId}#${link.locator}` });
          }
        }
      }
    }

    if (typeof args.claimId === "string") declaredClaims.add(args.claimId);
    if (typeof args.relationshipId === "string") declaredRelationships.add(args.relationshipId);
  }

  // Every oracle expectation must name a tick the script actually contains.
  const ticks = new Set(script.mutations.map((mutation) => mutation.t));
  for (const expectation of oracle.expectedMutations.expectations) {
    if (!ticks.has(expectation.t)) {
      problems.push({ kind: "oracle-tick-missing", detail: `t${expectation.t}` });
    }
  }

  // Every id the oracle expects an answer to contain must be something the
  // script could actually have produced.
  const known = new Set<string>([
    ...entityIds,
    ...sourceIds,
    ...declaredClaims,
    ...declaredRelationships,
    ...peerRecordIds,
    ...workItemIds,
  ]);
  const idLike = /^(ent|src|clm|rel|cfl|dec|ac|cand|wi|run|ho|kref):/;
  for (const query of oracle.expectedQueries.queries) {
    const collect = (value: unknown): string[] => {
      if (typeof value === "string") return [value];
      if (Array.isArray(value)) return value.flatMap(collect);
      if (value && typeof value === "object") return Object.values(value).flatMap(collect);
      return [];
    };
    for (const candidate of collect(query)) {
      if (!idLike.test(candidate)) continue;
      // Decisions, contradictions, candidates, and active contexts are created
      // as arguments rather than as ids, so they are checked against the script
      // text instead of the declared-id sets.
      if (/^(dec|cfl|cand|ac|ho|run|kref):/.test(candidate)) continue;
      if (!known.has(candidate)) {
        problems.push({ kind: "oracle-unknown-id", detail: `${query.id}: ${candidate}` });
      }
    }
  }

  // Frozen vectors must cover every judged item and be the declared width.
  const width = vectors.vocabulary.length;
  for (const [id, vector] of Object.entries(vectors.vectors)) {
    if (vector.length !== width) {
      problems.push({ kind: "vector-width", detail: `${id}: ${vector.length} != ${width}` });
    }
    if (vector.every((component) => component === 0)) {
      problems.push({ kind: "vector-is-zero", detail: id });
    }
  }
  for (const [queryId, judgment] of Object.entries(oracle.judgments.judgments)) {
    if (!vectors.queryVectors[queryId]) {
      problems.push({ kind: "query-vector-missing", detail: queryId });
    }
    for (const id of Object.keys(judgment.grades)) {
      if (!vectors.vectors[id]) {
        problems.push({ kind: "judged-item-has-no-vector", detail: `${queryId}: ${id}` });
      }
    }
  }

  // The question a lane is ASKED and the question the oracle answers must be
  // the same question. They live in separate trees so a lane can be asked
  // without being told, and that separation is only safe if drift is mechanical
  // to detect rather than something a reader has to notice.
  const asked = new Map(questions.queries.map((entry) => [entry.id, entry]));
  if (asked.size !== oracle.expectedQueries.queries.length) {
    problems.push({
      kind: "question-count-mismatch",
      detail: `${asked.size} asked vs ${oracle.expectedQueries.queries.length} oracled`,
    });
  }
  for (const expected of oracle.expectedQueries.queries) {
    const question = asked.get(expected.id);
    if (!question) {
      problems.push({ kind: "question-missing", detail: expected.id });
      continue;
    }
    if (question.query !== expected.query) {
      problems.push({ kind: "question-kind-drift", detail: expected.id });
    }
    if (JSON.stringify(question.args) !== JSON.stringify(expected.args)) {
      problems.push({ kind: "question-args-drift", detail: expected.id });
    }
    const askedConstraint = JSON.stringify(question.constraint ?? {});
    const oracledConstraint = JSON.stringify(expected.constraint ?? {});
    if (askedConstraint !== oracledConstraint) {
      problems.push({ kind: "question-constraint-drift", detail: expected.id });
    }
  }

  // The fusion weights are an input and must be a declared, normalised set: an
  // unnormalised weighting silently reweights one lane's strengths.
  const weightSum = Object.values(vectors.fusionWeights).reduce((sum, w) => sum + w, 0);
  if (Math.abs(weightSum - 1) > 1e-9) {
    problems.push({ kind: "fusion-weights-not-normalised", detail: String(weightSum) });
  }

  return problems;
}

/** Cosine similarity over the frozen vectors. Both lanes use this same function. */
export function cosine(left: number[], right: number[]): number {
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index] ?? 0;
    const b = right[index] ?? 0;
    dot += a * b;
    leftNorm += a * a;
    rightNorm += b * b;
  }
  if (leftNorm === 0 || rightNorm === 0) return 0;
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}
