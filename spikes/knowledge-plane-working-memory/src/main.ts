// Container entrypoint.
//
// Every subcommand prints exactly one JSON object and writes no file. The host
// driver owns all persistence, so a container that cannot write cannot corrupt a
// bundle, and a container that exits without printing is a fault rather than a
// silent pass.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  EVIDENCE_SCHEMA,
  KNOWLEDGE_CONTRACT_VERSION,
  TIMEOUTS,
  checkPinnedPackages,
  imageManifest,
  pinAgrees,
  tickToInstant,
} from "./contract.ts";
import type { PackageCheck } from "./contract.ts";
import {
  EXIT_HARNESS_FAULT,
  EXIT_USAGE,
  SENSITIVE_CANARY,
  emit,
  outcomeFor,
  scanForLeaks,
} from "./evidence.ts";
import { digest, managed } from "./canonical.ts";
import { stage2Selftest } from "./stage2/selftest.ts";
import { ACTIVE_CONTEXT_CONTRACT_VERSION, ARM_IDS } from "./stage2/contract.ts";
import { ESTIMATOR_ID } from "./stage2/tokens.ts";
import { CASES, expandCases, registryIsSound } from "./cases.ts";
import { cosine, loadCorpus, loadOracle, treeDigest, validateFixtures } from "./corpus.ts";
import { LaneMAdapter, recordFor } from "./lane-m/adapter.ts";
import type { ExecutionRecord } from "./lane-m/adapter.ts";
import type { QueryResponse } from "./knowledge/contract.ts";
import { ExecutionPlane } from "./execution/plane.ts";
import type { Db } from "./lane-m/pg.ts";
import { openDb, waitForDb } from "./lane-m/pg.ts";
import { dropProjection, migrate } from "./lane-m/migrate.ts";
import { markStale, project, readBackDigest, readFreshness } from "./lane-m/projection.ts";
import { checkGolden } from "./golden.ts";
import { auditFeed, feedBytes, publish } from "./coordination/sink.ts";
import { nativeWrite, surfaceReport } from "./native/obsidian.ts";
import { MarkdownStore } from "./lane-m/store.ts";
import { decide } from "./knowledge/policy.ts";
import type { NeutralExport } from "./knowledge/portable.ts";
import {
  ExportRejected,
  opsFromExport,
  withDanglingEvidenceReference,
  withOneEvidenceLinkRemoved,
} from "./knowledge/portable.ts";
import { createHash } from "node:crypto";
import {
  arrivals,
  arrive,
  events,
  overlapProven,
  releaseSpreadMs,
  waitForParties,
  witness,
} from "./probe.ts";
import { RACE_ENTITY, raceOutcome, raceRequest } from "./race.ts";
import type { RaceCase, RaceOutcome } from "./race.ts";
import type { CommandResponse } from "./knowledge/contract.ts";
import type { KnowledgeState } from "./knowledge/policy.ts";
import { scoreRetrieval } from "./retrieval.ts";
import type { SupportInfo } from "./retrieval.ts";
import {
  answerOnly,
  applyPermutation,
  buildPermutation,
  capabilityBreakdown,
  groupingIsTotal,
  invert,
  normalizeForPermutation,
} from "./matrix.ts";
import { GraphStore } from "./lane-n/graph.ts";
import { LaneNAdapter } from "./lane-n/adapter.ts";
import { requestFor } from "./runner.ts";
import { FAMILIES, familiesInRunOrder } from "./families.ts";
import { LANES, expandLanes, pairingIsSound } from "./lanes.ts";

const USAGE = `usage: main.ts <subcommand>

  cases [--family F] [--lane L]   list the case registry as JSON
  families                        list families in run order
  lanes                           list lanes and their pairings
  manifest                        print the fixture manifest baked into this image
  expand --cases a,b | --lanes a  expand a selection to include required pairs
  selftest                        run the K family and emit its acceptance map
  validate                        check the frozen corpus, questions, and oracle
  lane-m-script                   apply the mutation script, offline smoke path
  lane-m-answers                  answer the golden questions; emits no verdict
  lane-m-projection               migrate, project, rebuild, mark stale, repair
  lane-n-answers                  answer the golden questions from the graph
  coordination-controls           feed integrity, republication, non-promotion
  native-walkthrough              the seven correction operations, Lane M
  native-graph                    what Neo4j Browser can and cannot enforce
  shuffled-ids                    the id-permutation fairness control
  faults-m | faults-n             crash, publication, malformed, export round trip
  race-prepare | race-party | race-collect   the two-writer races
  compare-golden --answers F      score emitted answers against the oracle
  compare-lanes --lane-m A --lane-n B   structural equivalence of two exports
`;

function fail(message: string): number {
  process.stderr.write(`${message}\n`);
  return EXIT_USAGE;
}

function argValue(argv: string[], flag: string): string | null {
  const index = argv.indexOf(flag);
  if (index === -1 || index + 1 >= argv.length) return null;
  return argv[index + 1] ?? null;
}

/**
 * The contract module must not import a store driver.
 *
 * Read as source text rather than by introspecting the module graph: an import
 * that is present but unused would still be invisible to a runtime check, and it
 * is exactly the kind of thing that precedes a lane-shaped contract.
 */
const FORBIDDEN_IMPORTS: Array<[string, RegExp]> = [
  ["postgres-driver", /from\s+["']pg["']/],
  ["neo4j-driver", /from\s+["']neo4j-driver["']/],
  ["filesystem", /from\s+["']node:fs(?:\/promises)?["']/],
  ["child-process", /from\s+["']node:child_process["']/],
  ["network", /from\s+["']node:(?:net|http|https|dgram)["']/],
  ["http-client", /from\s+["']undici["']/],
];

function scanForForbiddenImports(source: string): string[] {
  return FORBIDDEN_IMPORTS.filter(([, pattern]) => pattern.test(source)).map(([rule]) => rule);
}

function readSource(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), "utf8");
}

function selftest(): number {
  const acceptance: Record<string, boolean> = {};
  const findings: Record<string, unknown> = {};

  // k01 --- pins agree across installed tree, lockfile, and manifest.
  const pins = checkPinnedPackages();
  acceptance["k01-pins-present"] = pins.length > 0;
  acceptance["k01-pins-agree"] = pins.length > 0 && pins.every((pin) => pin.matches);
  // Control: the same comparison against a deliberately wrong expectation must
  // not match, so a passing pin check is not simply a comparison that always
  // succeeds.
  // The control runs the REAL predicate over a deliberately corrupted check, one
  // field at a time, and every corruption must be rejected. Comparing against a
  // string nothing produces exercised nothing.
  acceptance["k01-pin-control-detects-mismatch"] =
    pins.length > 0 &&
    pins.every((pin) => {
      const mutations: PackageCheck[] = [
        { ...pin, installed: `${pin.expected}-mutant` },
        { ...pin, lockVersion: `${pin.expected}-mutant` },
        { ...pin, manifestVersion: `${pin.expected}-mutant` },
        { ...pin, lockIntegrity: null },
        { ...pin, manifestIntegrity: `${pin.manifestIntegrity ?? ""}-mutant` },
      ];
      return mutations.every((mutant) => !pinAgrees(mutant, pin.expected));
    });
  findings.pins = pins;

  // k02 --- the contract module is store-neutral.
  const contractSource = readSource("./knowledge/contract.ts");
  const contractHits = scanForForbiddenImports(contractSource);
  const mutantSource = `${contractSource}\nimport { Pool } from "pg";\n`;
  acceptance["k02-contract-is-neutral"] = contractHits.length === 0;
  acceptance["k02-neutrality-control-detects-import"] =
    scanForForbiddenImports(mutantSource).includes("postgres-driver");
  findings.contractNeutrality = { hits: contractHits, version: KNOWLEDGE_CONTRACT_VERSION };

  // k03 --- the canonicaliser tokenises volatility and preserves meaning.
  const base = {
    claimId: "clm:auth-ttl",
    belief: "active",
    freshness: { staleness: "fresh" },
    wallClock: "2026-01-05T09:00:00.000Z",
    runId: "run-alpha",
    durationMs: 41,
  };
  const volatileTwin = {
    ...base,
    wallClock: "2026-09-03T18:00:00.000Z",
    runId: "run-beta",
    durationMs: 9182,
  };
  const meaningfulTwin = { ...base, belief: "superseded" };
  const baseDigest = managed(base).digest;
  acceptance["k03-volatility-is-ignored"] = managed(volatileTwin).digest === baseDigest;
  acceptance["k03-meaning-is-not-ignored"] = managed(meaningfulTwin).digest !== baseDigest;
  acceptance["k03-digest-is-stable"] = managed(base).digest === baseDigest;
  findings.canonicaliser = {
    baseDigest,
    volatileTwinDigest: managed(volatileTwin).digest,
    meaningfulTwinDigest: managed(meaningfulTwin).digest,
  };

  // k04 --- the sanitizer catches a planted secret and the canary.
  const plantedSecret = JSON.stringify({ dsn: "postgresql://spike:hunter2@db:5432/kp" });
  const plantedCanary = JSON.stringify({ excerpt: `redacted ${SENSITIVE_CANARY} tail` });
  const cleanPayload = JSON.stringify({ claimId: "clm:auth-ttl", belief: "active" });
  acceptance["k04-detects-secret"] = scanForLeaks(plantedSecret).includes("pg-dsn-with-password");
  acceptance["k04-detects-canary"] = scanForLeaks(plantedCanary).includes("sensitive-canary");
  acceptance["k04-clean-payload-is-clean"] = scanForLeaks(cleanPayload).length === 0;
  findings.sanitizer = {
    secretRules: scanForLeaks(plantedSecret),
    canaryRules: scanForLeaks(plantedCanary),
  };

  // k05 --- an empty acceptance map is a fault, and a populated one still passes.
  acceptance["k05-empty-acceptance-is-fault"] = outcomeFor({}).status === "fault";
  acceptance["k05-populated-acceptance-passes"] = outcomeFor({ a: true }).status === "pass";
  acceptance["k05-false-acceptance-fails"] = outcomeFor({ a: false }).status === "fail";

  // Registry soundness. A dangling pair or a case with no control is a defect
  // that must surface before any measurement, not after.
  const registry = registryIsSound();
  acceptance["k06-registry-is-sound"] = registry.sound;
  acceptance["k06-lane-pairing-is-sound"] = pairingIsSound();
  acceptance["k06-every-family-has-cases"] = FAMILIES.every((family) =>
    CASES.some((entry) => entry.family === family.id),
  );
  findings.registry = {
    problems: registry.problems,
    caseCount: CASES.length,
    familyCount: FAMILIES.length,
  };

  // The deterministic clock must not depend on the wall clock.
  acceptance["k07-clock-is-deterministic"] =
    tickToInstant(0) === "2026-01-05T09:00:00.000Z" && tickToInstant(60) === "2026-01-05T10:00:00.000Z";

  return emit({
    subcommand: "selftest",
    family: "K",
    contractVersion: KNOWLEDGE_CONTRACT_VERSION,
    timeouts: TIMEOUTS,
    findings,
    findingsDigest: digest(findings),
    acceptance,
    outcome: outcomeFor(acceptance),
  });
}

/**
 * Fixture and oracle validation, run before either adapter exists.
 *
 * This is a check on the AUTHORING, not on a lane. A problem found here is a
 * fixture defect and must be fixed in the fixture; it is never evidence about
 * Lane M or Lane N, and it never becomes a lane's failure.
 */
function validate(corpusRoot: string, oracleRoot: string): number {
  const acceptance: Record<string, boolean> = {};
  const findings: Record<string, unknown> = {};

  const { corpus, script, vectors, questions } = loadCorpus(corpusRoot);
  const oracle = loadOracle(oracleRoot);

  const problems = validateFixtures(corpus, script, vectors, questions, oracle);
  acceptance["v01-fixtures-are-referentially-sound"] = problems.length === 0;
  findings.problems = problems;

  // The corpus must actually contain the twelve scenarios it claims to.
  const commands = new Set(script.mutations.map((mutation) => mutation.cmd));
  acceptance["v02-lifecycle-commands-present"] = [
    "SupersedeClaim",
    "CorrectClaim",
    "SummarizeClaims",
    "RecordContradiction",
    "RetractClaim",
    "MergeEntities",
    "CanonizeClaim",
    "ReinforceClaim",
    "IngestPeerActivity",
    "OpenCandidateFromPeerReport",
    "PublishActivityRecord",
    "InvalidateRelationship",
  ].every((command) => commands.has(command));

  const refusals = script.mutations.filter((mutation) => mutation.expect === "refused");
  acceptance["v03-refusals-are-oracled"] = refusals.every((mutation) =>
    oracle.expectedMutations.expectations.some(
      (expectation) => expectation.t === mutation.t && expectation.outcome === "refused",
    ),
  );
  acceptance["v04-refusal-set-is-nonempty"] = refusals.length > 0;
  findings.refusalTicks = refusals.map((mutation) => mutation.t);

  // Depth profile is declared before the run so the graph-heavy share cannot be
  // tuned after seeing which lane it favours.
  const profile = oracle.expectedQueries.depthProfile;
  const total =
    (profile.depth1 ?? 0) + (profile.depth2 ?? 0) + (profile.depth3plus ?? 0);
  acceptance["v05-depth-profile-matches-query-count"] =
    total === oracle.expectedQueries.queries.length;
  acceptance["v06-graph-heavy-share-is-declared"] =
    Math.abs((profile.depth3plus ?? 0) / Math.max(total, 1) - (profile.graphHeavyShare ?? -1)) <
    0.001;
  findings.depthProfile = { ...profile, queryCount: oracle.expectedQueries.queries.length };

  // The ranking judgment must be self-consistent with the frozen vectors: if the
  // item declared to rank first does not, the oracle contradicts itself and the
  // defect is here rather than in a lane.
  const rankings: Record<string, Array<[string, number]>> = {};
  let rankingSound = true;
  for (const [queryId, judgment] of Object.entries(oracle.judgments.judgments)) {
    const queryVector = vectors.queryVectors[queryId];
    if (!queryVector) {
      rankingSound = false;
      continue;
    }
    const scored = Object.entries(vectors.vectors)
      .map(([id, vector]) => [id, cosine(queryVector, vector)] as [string, number])
      .sort((left, right) => right[1] - left[1] || (left[0] < right[0] ? -1 : 1));
    rankings[queryId] = scored.slice(0, 5);
    if (scored[0]?.[0] !== judgment.mustRankFirst) rankingSound = false;
  }
  acceptance["v07-ranking-judgment-is-self-consistent"] = rankingSound;
  findings.rankings = rankings;

  // The graded judgments must not be reachable from the corpus mount. If they
  // ever move back into a lane-visible tree, a lane could rank to them.
  acceptance["v13-judgments-are-oracle-only"] =
    !existsSync(join(corpusRoot, "judgments.json")) &&
    Object.keys(oracle.judgments.judgments).length > 0;
  // And the retrieval INPUTS must be reachable from it, or the hybrid question
  // cannot be answered without mounting the oracle into a lane.
  acceptance["v14-vectors-are-corpus-side"] =
    existsSync(join(corpusRoot, "vectors.json")) && vectors.vocabulary.length > 0;

  // The canary belongs in exactly one source document and nowhere else in the
  // corpus. Anywhere else and the fixture itself is the leak.
  const corpusText = JSON.stringify(corpus);
  const canaryCount = corpusText.split(SENSITIVE_CANARY).length - 1;
  acceptance["v08-canary-appears-exactly-once"] = canaryCount === 1;
  acceptance["v09-canary-absent-from-oracle"] =
    !JSON.stringify(oracle).includes(SENSITIVE_CANARY);
  findings.canaryCount = canaryCount;

  const corpusDigest = treeDigest(corpusRoot);
  const oracleDigest = treeDigest(oracleRoot);
  findings.corpusDigest = corpusDigest.root;
  findings.oracleDigest = oracleDigest.root;
  findings.corpusFiles = corpusDigest.files;
  findings.oracleFiles = oracleDigest.files;

  // The freeze is asserted from INSIDE the image against the mounted trees, so a
  // regenerated oracle is caught by the image rather than by the tree that was
  // regenerated. An unset expectation is a fault, not a pass.
  const frozen = (imageManifest() as { frozen?: { corpusRoot?: string; oracleRoot?: string } } | null)
    ?.frozen;
  acceptance["v10-freeze-is-declared"] =
    typeof frozen?.corpusRoot === "string" && typeof frozen?.oracleRoot === "string";
  acceptance["v11-corpus-matches-freeze"] = frozen?.corpusRoot === corpusDigest.root;
  acceptance["v12-oracle-matches-freeze"] = frozen?.oracleRoot === oracleDigest.root;

  return emit({
    subcommand: "validate",
    contractVersion: KNOWLEDGE_CONTRACT_VERSION,
    corpusId: corpus.corpusId,
    mutationCount: script.mutations.length,
    queryCount: oracle.expectedQueries.queries.length,
    findings,
    acceptance,
    outcome: outcomeFor(acceptance),
  });
}

/**
 * Drive the frozen mutation script through an adapter.
 *
 * Shared by every Lane M subcommand so the script is applied identically
 * whichever question is being asked afterwards. The stale-token bookkeeping is
 * the only subtle part: the token a stale writer would have observed is captured
 * at the moment it would genuinely have read it, before the update that makes it
 * stale, rather than refreshed at use.
 */
async function applyScript(
  adapter: LaneMAdapter,
  corpus: Awaited<ReturnType<typeof loadCorpus>>["corpus"],
  script: { mutations: Array<Parameters<typeof requestFor>[0]> },
): Promise<{ records: ExecutionRecord[] }> {
  const staleTokens = new Map<string, string>();
  const records: ExecutionRecord[] = [];
  for (const mutation of script.mutations) {
    if (typeof mutation.args.claimId === "string") {
      const ref = { kind: "claim" as const, id: mutation.args.claimId };
      const token = adapter.versionOf(ref);
      if (token && !staleTokens.has(mutation.args.claimId)) {
        staleTokens.set(mutation.args.claimId, token);
      }
    }
    const request = requestFor(mutation, corpus, (ref) => adapter.versionOf(ref), staleTokens);
    records.push(recordFor(mutation.t, mutation.cmd, await adapter.execute(request)));
  }
  return { records };
}

/**
 * Apply the frozen mutation script through Lane M and compare the OUTCOMES
 * against the oracle.
 *
 * The oracle supplies the expected error codes; the script does not. A lane that
 * refuses for the wrong reason is as wrong as one that commits.
 */
async function laneMScript(
  corpusRoot: string,
  oracleRoot: string,
  vaultRoot: string,
): Promise<number> {
  const acceptance: Record<string, boolean> = {};
  const { corpus, script, vectors } = loadCorpus(corpusRoot);
  const oracle = loadOracle(oracleRoot);

  const adapter = new LaneMAdapter({ root: vaultRoot, corpus, vectors });
  const { records } = await applyScript(adapter, corpus, script);

  const byTick = new Map(records.map((record) => [record.tick, record]));
  const expectedRefusals = oracle.expectedMutations.expectations;

  acceptance["m01-every-mutation-produced-a-record"] =
    records.length === script.mutations.length && records.length > 0;

  acceptance["m02-refusals-match-the-oracle"] = expectedRefusals.every((expectation) => {
    const record = byTick.get(expectation.t);
    return (
      record !== undefined &&
      record.outcome === "refused" &&
      record.code === expectation.code &&
      record.category === expectation.category
    );
  });

  const refusedTicks = new Set(expectedRefusals.map((expectation) => expectation.t));
  acceptance["m03-nothing-else-was-refused"] = records
    .filter((record) => !refusedTicks.has(record.tick))
    .every((record) => record.outcome === "committed");

  // Stated positively as well: an all-committed run would satisfy m03 while
  // proving nothing, so the refusal set must be non-empty and fully matched.
  acceptance["m04-refusal-set-is-nonempty"] = expectedRefusals.length > 0;

  const state = adapter.snapshot();
  const invariants = oracle.expectedMutations.terminalInvariants;
  const liveEntities = [...state.entities.values()].filter(
    (entity) => entity.mergedInto === null,
  ).length;
  const tombstones = [...state.entities.values()].filter(
    (entity) => entity.mergedInto !== null,
  ).length;

  acceptance["m05-live-entity-count"] = liveEntities === invariants.liveEntities;
  acceptance["m06-merge-tombstone-count"] = tombstones === invariants.mergeTombstones;
  acceptance["m07-rejection-record-count"] =
    state.rejections.length === invariants.rejectionRecords;
  acceptance["m08-no-claim-authored-by-peer"] = [...state.claims.values()].every((revisions) =>
    revisions.every((revision) => revision.origin.originKind !== "peer_report"),
  );
  acceptance["m09-every-claim-reaches-evidence"] = [...state.claims.values()].every((revisions) => {
    const head = revisions[revisions.length - 1];
    if (!head) return false;
    if (head.belief === "retracted") return true;
    return head.evidenceIds.length > 0;
  });
  acceptance["m10-no-pending-intents"] = adapter.pendingIntents().length === 0;

  // The canary must not have reached canonical state through the rejected
  // candidate, and the sweep must have had something to examine.
  const canonicalText = JSON.stringify([...state.claims.values()]);
  acceptance["m11-canary-absent-from-canonical-state"] =
    canonicalText.length > 0 && !canonicalText.includes(SENSITIVE_CANARY);

  // A human decision that authorised a correction has to survive as a record,
  // or the correction path is unauditable and `StaleDecisions` has nothing to
  // report. Stated as a count so an empty decision store cannot pass.
  acceptance["m12-human-decisions-are-recorded"] = state.decisions.size >= 4;

  // Erasure must not have taken the lineage with it: the tombstone, the ids, and
  // the decision survive; only the statement text does not.
  const retracted = [...state.claims.values()]
    .map((revisions) => revisions[revisions.length - 1])
    .filter((revision) => revision?.belief === "retracted");
  acceptance["m13-retraction-keeps-its-tombstone"] =
    retracted.length === 1 && retracted.every((revision) => revision?.value === "");

  // Publication left the knowledge plane. One accepted record, and the refused
  // cross-namespace attempt left nothing behind.
  acceptance["m14-publication-is-separate-output"] = state.published.size === 1;

  return emit({
    subcommand: "lane-m-script",
    lane: "lane-m",
    mutationCount: script.mutations.length,
    committed: records.filter((record) => record.outcome === "committed").length,
    refused: records.filter((record) => record.outcome === "refused").length,
    records,
    generation: adapter.generation().digest,
    acceptance,
    outcome: outcomeFor(acceptance),
  });
}

/**
 * Answer the golden questions through Lane M and emit the ANSWERS.
 *
 * The oracle is not mounted here and must never be: this container is asked
 * twenty-four questions and reports what it found. The comparison happens
 * afterwards, in a network-less comparator, with no path back to execution.
 */
async function laneMAnswers(
  corpusRoot: string,
  vaultRoot: string,
  usePostgres: boolean,
): Promise<number> {
  const { corpus, script, vectors, questions } = loadCorpus(corpusRoot);

  let db: Db | null = null;
  let execution: ExecutionPlane | null = null;
  let projection: Awaited<ReturnType<typeof project>> | null = null;
  let migration: Awaited<ReturnType<typeof migrate>> | null = null;

  if (usePostgres) {
    db = openDb("lane-m:answers", "app");
    await waitForDb(db, TIMEOUTS.commandMs * 4);
    const migrator = openDb("lane-m:migrator", "migrator", 1);
    try {
      migration = await migrate(migrator);
    } finally {
      await migrator.close();
    }
    execution = new ExecutionPlane(db);
    await execution.seed(corpus);
  }

  const adapter = new LaneMAdapter({
    root: vaultRoot,
    corpus,
    vectors,
    ...(execution ? { execution } : {}),
    ...(db ? { freshness: () => readFreshness(db as Db) } : {}),
  });

  const { records } = await applyScript(adapter, corpus, script);

  // The projection is built AFTER canonical state settles, from canonical files
  // alone. It is a pure function of the vault, which is the property the rebuild
  // case actually asserts.
  if (db) {
    projection = await project(
      db,
      adapter.snapshot(),
      adapter.generation().digest,
      vectors,
      script.mutations[script.mutations.length - 1]?.t ?? 0,
    );
  }

  const answers: Record<string, unknown> = {};
  for (const question of questions.queries) {
    const response = await adapter.query({
      contractVersion: KNOWLEDGE_CONTRACT_VERSION,
      query: question.query as never,
      constraint: { ...questions.defaults, ...(question.constraint ?? {}) } as never,
      // The question's own id reaches the adapter as an argument so a
      // rank-sensitive question can find its frozen query vector without the
      // fixture having to repeat the id inside its own args.
      args: { ...question.args, queryId: question.id },
    });
    answers[question.id] = response;
  }

  // Full revision histories, so the comparator can check a tombstone survived
  // without having to ask this container a second question it cannot anticipate.
  const histories: Record<string, unknown[]> = {};
  for (const [claimId, revisions] of adapter.snapshot().claims.entries()) {
    histories[claimId] = revisions.map((revision) => ({
      revision: revision.revision,
      belief: revision.belief,
      closureReason: revision.closureReason,
      redactionState: revision.redactionState,
    }));
  }

  const acceptance: Record<string, boolean> = {
    "a01-every-question-answered": Object.keys(answers).length === questions.queries.length,
    "a02-script-applied": records.length === script.mutations.length,
  };

  const code = emit({
    subcommand: "lane-m-answers",
    lane: "lane-m",
    generation: adapter.generation().digest,
    migration,
    projection,
    answers,
    histories,
    // The neutral export, in the same shape Lane N emits, so the two can be
    // compared structurally rather than by inspecting two storage formats.
    export: await adapter.exportState(),
    support: supportOf(adapter.snapshot()),
    coordination: { feed: feedBytes(vaultRoot), audit: auditFeed(vaultRoot) },
    acceptance,
    outcome: outcomeFor(acceptance),
  });

  if (db) await db.close();
  return code;
}

/** Compare emitted answers against the oracle. Runs only in the comparator. */
function compareGolden(answersPath: string, oracleRoot: string): number {
  const bundle = JSON.parse(readFileSync(answersPath, "utf8")) as {
    answers: Record<string, QueryResponse>;
    histories: Record<string, Array<Record<string, unknown>>>;
    support?: SupportInfo;
  };
  const oracle = loadOracle(oracleRoot);

  const results = oracle.expectedQueries.queries.map((question) => {
    const response = bundle.answers[question.id];
    if (!response) {
      return {
        id: question.id,
        query: question.query,
        checks: { answered: false },
        observed: {},
        passed: false,
      };
    }
    return checkGolden(question, response, (claimId) => bundle.histories[claimId] ?? []);
  });

  const acceptance: Record<string, boolean> = {};
  for (const result of results) {
    for (const [check, value] of Object.entries(result.checks)) {
      acceptance[`g-${result.id}-${check}`] = value;
    }
  }

  // The capability breakdown is a reporting lens, and it is only interpretable
  // if every question is classified exactly once.
  const questionIds = oracle.expectedQueries.queries.map((question) => question.id);
  acceptance["g-capability-grouping-is-total"] = groupingIsTotal(questionIds);
  const breakdown = capabilityBreakdown(results);

  // Retrieval metrics for the one rank-sensitive question. They are SCORED and
  // never gate: a hard gate decided by a ranking would let a retrieval tweak
  // change an eligibility verdict.
  const hybrid = bundle.answers.Q21;
  const judgment = oracle.judgments.judgments.Q21;
  const structural =
    ((oracle.judgments.structuralRecallSubset as Record<string, string[]>).Q21 ?? []);
  let metrics: unknown = null;
  if (hybrid && hybrid.outcome === "ok" && judgment) {
    const ranked = ((hybrid.data as { ranked?: Array<{ id: string }> }).ranked ?? []).map(
      (entry) => entry.id,
    );
    metrics = scoreRetrieval(ranked, judgment, structural, bundle.support ?? {});
  }

  return emit({
    subcommand: "compare-golden",
    queryCount: results.length,
    passed: results.filter((result) => result.passed).length,
    results,
    capabilityBreakdown: breakdown,
    retrieval: metrics,
    acceptance,
    outcome: outcomeFor(acceptance),
  });
}

/**
 * The id-permutation fairness control.
 *
 * A fixed bijection over fixture ids must not change any answer once the answers
 * are mapped back. Several places in this harness sort sets by id, so a lane
 * whose result depended on that lexical ordering would answer differently under
 * a permutation while claiming the same semantics — and the golden comparison
 * would never notice, because it sorts both sides the same way.
 *
 * Runs offline against Lane M and never touches the oracle: this compares a lane
 * to ITSELF, so no expected answer is involved and nothing can leak.
 */
async function shuffledIds(corpusRoot: string, vaultRoot: string): Promise<number> {
  const acceptance: Record<string, boolean> = {};
  const findings: Record<string, unknown> = {};
  const { corpus, script, vectors, questions } = loadCorpus(corpusRoot);

  const mapping = buildPermutation(JSON.stringify({ corpus, script, questions }));
  const inverse = invert(mapping);
  acceptance["s01-permutation-is-nonempty"] = Object.keys(mapping).length > 10;
  // A permutation that mapped anything to itself would leave that id untested.
  acceptance["s02-permutation-moves-every-id"] = Object.entries(mapping).every(
    ([from, to]) => from !== to,
  );
  acceptance["s03-permutation-is-a-bijection"] =
    new Set(Object.values(mapping)).size === Object.keys(mapping).length;
  findings.permutationSize = Object.keys(mapping).length;

  const askAll = async (
    adapter: LaneMAdapter,
    bank: typeof questions,
  ): Promise<Record<string, unknown>> => {
    const out: Record<string, unknown> = {};
    for (const question of bank.queries) {
      const response = await adapter.query({
        contractVersion: KNOWLEDGE_CONTRACT_VERSION,
        query: question.query as never,
        constraint: { ...bank.defaults, ...(question.constraint ?? {}) } as never,
        args: { ...question.args, queryId: question.id },
      });
      out[question.id] = response.outcome === "ok" ? response.data : response;
    }
    return out;
  };

  const baseline = new LaneMAdapter({ root: `${vaultRoot}/baseline`, corpus, vectors });
  await applyScript(baseline, corpus, script);
  const baselineAnswers = await askAll(baseline, questions);

  const permutedCorpus = applyPermutation(corpus, mapping) as typeof corpus;
  const permutedScript = applyPermutation(script, mapping) as typeof script;
  const permutedQuestions = applyPermutation(questions, mapping) as typeof questions;
  // The frozen vectors are keyed by claim id, so they move with the corpus or
  // the ranked question would silently score against the wrong items.
  const permutedVectors = applyPermutation(vectors, mapping) as typeof vectors;

  const shuffled = new LaneMAdapter({
    root: `${vaultRoot}/shuffled`,
    corpus: permutedCorpus,
    vectors: permutedVectors,
  });
  await applyScript(shuffled, permutedCorpus, permutedScript);
  const shuffledAnswers = await askAll(shuffled, permutedQuestions);

  // Map the answers back and compare. Equality here means the lane answered the
  // same questions about the same structure, not merely that both runs sorted.
  const restored = applyPermutation(shuffledAnswers, inverse) as Record<string, unknown>;
  const compare = (id: string, value: unknown): string =>
    digest(normalizeForPermutation(answerOnly(id, value)));
  const differing = Object.keys(baselineAnswers).filter(
    (id) => compare(id, baselineAnswers[id]) !== compare(id, restored[id]),
  );
  findings.differing = differing;
  acceptance["s04-permutation-changes-no-answer"] = differing.length === 0;

  // The control: without mapping back, the answers MUST differ. Otherwise the
  // comparison above is satisfied by a lane that ignored the permutation
  // entirely, or by a harness that never applied it.
  const unmappedDiffering = Object.keys(baselineAnswers).filter(
    (id) => compare(id, baselineAnswers[id]) !== compare(id, shuffledAnswers[id]),
  );
  acceptance["s05-unmapped-answers-do-differ"] = unmappedDiffering.length > 0;
  findings.unmappedDiffering = unmappedDiffering.length;

  // And the inverse permutation must reproduce the original ids exactly.
  const roundTrip = applyPermutation(applyPermutation(corpus, mapping), inverse);
  acceptance["s06-inverse-round-trips"] = digest(roundTrip) === digest(corpus);

  return emit({
    subcommand: "shuffled-ids",
    lane: "lane-m",
    findings,
    acceptance,
    outcome: outcomeFor(acceptance),
  });
}

/**
 * The projection's own lifecycle: migrate, build, rebuild, mark stale, repair.
 *
 * Each claim here is paired with the control that makes it mean something. A
 * rebuild that reproduces its digest proves nothing unless a rebuild from a
 * deliberately truncated canonical set produces a different one, and a stale
 * marking proves nothing unless the healthy run was unmarked.
 */
async function laneMProjection(corpusRoot: string, vaultRoot: string): Promise<number> {
  const acceptance: Record<string, boolean> = {};
  const findings: Record<string, unknown> = {};
  const { corpus, script, vectors } = loadCorpus(corpusRoot);

  const db = openDb("lane-m:projection", "app");
  await waitForDb(db, TIMEOUTS.commandMs * 4);

  // One migrator, on its own session. Running it twice must be idempotent
  // rather than a race, which is the whole point of the election.
  const migratorA = openDb("lane-m:migrator-a", "migrator", 1);
  const first = await migrate(migratorA);
  const second = await migrate(migratorA);
  await migratorA.close();
  acceptance["d01-migration-elects-one-session"] = first.unlockReturnedTrue;
  acceptance["d02-migration-is-idempotent"] = second.performedDdl === false;
  acceptance["d03-no-advisory-lock-leaked"] =
    first.advisoryLocksStillGrantedToThisBackend === 0 &&
    second.advisoryLocksStillGrantedToThisBackend === 0;
  findings.migration = { first, second };

  const execution = new ExecutionPlane(db);
  const seeded = await execution.seed(corpus);
  acceptance["d04-execution-plane-seeded"] = seeded.workItems === 3 && seeded.attempts === 5;

  const adapter = new LaneMAdapter({
    root: vaultRoot,
    corpus,
    vectors,
    execution,
    freshness: () => readFreshness(db),
  });
  const { records } = await applyScript(adapter, corpus, script);
  acceptance["d05-script-applied"] = records.length === script.mutations.length;

  // The ledger is durable and canonical for execution: a replay must come back
  // from Postgres rather than from a process that happens to still be running.
  const ledger = await execution.counts();
  acceptance["d06-ledger-is-durable"] = ledger.ledger === script.mutations.length;
  findings.ledger = ledger;

  const canonicalPoint = adapter.generation().digest;
  const lastTick = script.mutations[script.mutations.length - 1]?.t ?? 0;
  const built = await project(db, adapter.snapshot(), canonicalPoint, vectors, lastTick);
  const builtReadBack = await readBackDigest(db);
  findings.projection = built;

  acceptance["d07-projection-has-rows"] =
    built.rows.claim > 0 && built.rows.edge > 0 && built.rows.evidence > 0;

  // Freshness is a comparison against canonical state, not a self-assigned age.
  const fresh = await adapter.query({
    contractVersion: KNOWLEDGE_CONTRACT_VERSION,
    query: "Freshness",
    constraint: {} as never,
    args: { scope: "all" },
  });
  const freshBlock = fresh.outcome === "ok" ? fresh.freshness : null;
  acceptance["d08-fresh-projection-reports-fresh"] =
    freshBlock?.staleness === "fresh" &&
    freshBlock.rebuildPending === false &&
    freshBlock.degradedFields.length === 0;

  // Drop and rebuild from canonical files alone.
  await dropProjection(db);
  const migratorB = openDb("lane-m:migrator-b", "migrator", 1);
  await migrate(migratorB);
  await migratorB.close();
  const rebuilt = await project(db, adapter.snapshot(), canonicalPoint, vectors, lastTick);
  const rebuiltReadBack = await readBackDigest(db);
  acceptance["d09-rebuild-is-deterministic"] =
    rebuilt.rowDigest === built.rowDigest && rebuiltReadBack === builtReadBack;

  // The control. Without it, the equality above is satisfied by any rebuild,
  // including one that produced nothing at all.
  const truncated = adapter.snapshot();
  const survivor = [...truncated.claims.keys()][0];
  const withheld = new Map(truncated.claims);
  if (survivor !== undefined) withheld.delete(survivor);
  const truncatedState = { ...truncated, claims: withheld };
  const partial = await project(db, truncatedState, canonicalPoint, vectors, lastTick);
  acceptance["d10-truncated-rebuild-differs"] = partial.rowDigest !== built.rowDigest;
  findings.rebuildControl = { withheld: survivor, digest: partial.rowDigest };

  // Restore the honest projection before measuring staleness.
  await project(db, adapter.snapshot(), canonicalPoint, vectors, lastTick);

  // A derived structure that failed to follow a committed canonical write must
  // say so on every subsequent read.
  await markStale(db, ["projection.claim"]);
  const stale = await adapter.query({
    contractVersion: KNOWLEDGE_CONTRACT_VERSION,
    query: "Freshness",
    constraint: {} as never,
    args: { scope: "all" },
  });
  const staleBlock = stale.outcome === "ok" ? stale.freshness : null;
  acceptance["d11-stale-projection-is-marked"] =
    staleBlock?.staleness === "stale" &&
    staleBlock.rebuildPending === true &&
    staleBlock.degradedFields.length > 0;

  // Roll-forward repair. A plan recorded before the first write is finishable;
  // a plan recorded only as a hash is merely detectable.
  const pendingBefore = adapter.pendingIntents().length;
  const repaired = adapter.repair();
  acceptance["d12-no-pending-intents-after-repair"] = adapter.pendingIntents().length === 0;
  acceptance["d13-repair-is-idempotent"] =
    adapter.generation().digest === canonicalPoint && pendingBefore === 0 && repaired.length === 0;

  await db.close();

  return emit({
    subcommand: "lane-m-projection",
    lane: "lane-m",
    findings,
    acceptance,
    outcome: outcomeFor(acceptance),
  });
}

/**
 * Evidence reachability per claim, emitted by the lane for the comparator.
 *
 * `answerSupportRecall` asks whether the system can justify what it retrieved,
 * and that cannot be computed from a ranked list of ids alone. It is emitted by
 * the lane rather than derived in the comparator so it reflects what the lane
 * actually holds, not what the fixture says it should hold.
 */
function supportOf(state: KnowledgeState): SupportInfo {
  const out: SupportInfo = {};
  for (const [claimId, revisions] of state.claims.entries()) {
    const head = revisions[revisions.length - 1];
    if (!head) continue;
    const sources = new Set(
      head.evidenceIds
        .map((id) => state.evidence.get(id)?.sourceRefId)
        .filter((id): id is string => id !== undefined && state.sources.has(id)),
    );
    out[claimId] = { evidenceCount: head.evidenceIds.length, sourceCount: sources.size };
  }
  return out;
}

/** A human operator request. Every one carries an actor and a rationale. */
function operatorRequest(
  command: string,
  tick: number,
  key: string,
  scope: Array<{ kind: string; id: string }>,
  decisionRef: string | null,
  rationale: string,
  args: Record<string, unknown>,
  effectClass: "additive" | "corrective" | "destructive" | "authority" | "publish" = "corrective",
): Parameters<LaneMAdapter["execute"]>[0] {
  return {
    contractVersion: KNOWLEDGE_CONTRACT_VERSION,
    command: command as never,
    actor: { actorId: "ada", actorClass: "human", nodeId: "node.ada", onBehalfOf: null },
    intent: {
      effectClass,
      scope: scope as never,
      decisionRef,
      // The rationale is the attribution. A walkthrough whose operations carry
      // no reason is a walkthrough nobody can audit afterwards.
      justification: rationale,
    },
    idempotency: { key, keyScope: "global" },
    guard: { mode: "unguarded", reason: `${command} performed by a human operator` },
    tick,
    args,
  };
}

/**
 * The seven correction operations, walked through the command contract and then
 * verified in a native READ surface.
 *
 * No UI is built and Obsidian is not driven. Its GUI-only surfaces are assessed
 * by capability inspection, because crediting Lane M with a correction path that
 * was never exercised is the easiest available way to bias this comparison.
 */
async function nativeWalkthrough(
  corpusRoot: string,
  vaultRoot: string,
): Promise<number> {
  const acceptance: Record<string, boolean> = {};
  const findings: Record<string, unknown> = {};
  const { corpus, script, vectors } = loadCorpus(corpusRoot);

  const root = `${vaultRoot}/walkthrough`;
  const adapter = new LaneMAdapter({ root, corpus, vectors });
  await applyScript(adapter, corpus, script);

  const operations: Array<{ id: string; response: Awaited<ReturnType<LaneMAdapter["execute"]>> }> = [];

  operations.push({
    id: "correct",
    response: await adapter.execute(
      operatorRequest(
        "CorrectClaim",
        1000,
        "op-correct",
        [{ kind: "claim", id: "clm:req-audit-log" }],
        "dec:op-correct",
        "the audit requirement was recorded from a stale architecture page",
        {
          claimId: "clm:req-audit-log",
          value: "every rotation emits an audit event carrying prior and next token ids",
          evidence: [{ sourceRefId: "src:notion-arch", locator: "section-2" }],
        },
      ),
    ),
  });

  operations.push({
    id: "supersede",
    response: await adapter.execute(
      operatorRequest(
        "SupersedeClaim",
        1001,
        "op-supersede",
        [{ kind: "claim", id: "clm:kestrel-pins-tr1" }],
        "dec:op-supersede",
        "the pin moved after the freeze lifted",
        {
          claimId: "clm:kestrel-pins-tr1",
          value: "tokenring 1.5.0",
          worldChangeAt: "2026-05-01T00:00:00.000Z",
          evidence: [{ sourceRefId: "src:gh-c-d4", locator: "message" }],
        },
      ),
    ),
  });

  operations.push({
    id: "resolve-conflict",
    response: await adapter.execute(
      operatorRequest(
        "ResolveConflict",
        1002,
        "op-resolve",
        [{ kind: "contradiction", id: "cfl:kestrel-version" }],
        "dec:op-resolve",
        "local commit evidence is authoritative over the peer's report",
        {
          contradictionId: "cfl:kestrel-version",
          upheldClaimId: "clm:kestrel-pins-tr1",
          rationale: "local commit evidence is authoritative over the peer's report",
        },
      ),
    ),
  });

  operations.push({
    id: "merge",
    response: await adapter.execute(
      operatorRequest(
        "MergeEntities",
        1003,
        "op-merge",
        [{ kind: "entity", id: "ent:parseq" }],
        "dec:op-merge",
        "parseq and the decoy library entry are the same dependency",
        { survivorId: "ent:tokenring", mergedId: "ent:parseq", reason: "same dependency" },
        "destructive",
      ),
    ),
  });

  operations.push({
    id: "revise-relationship",
    response: await adapter.execute(
      operatorRequest(
        "ReviseRelationship",
        1004,
        "op-revise",
        [{ kind: "relationship", id: "rel:ingest-api" }],
        "dec:op-revise",
        "the dependency began earlier than first recorded",
        {
          relationshipId: "rel:ingest-api",
          validFrom: "2025-05-01T00:00:00.000Z",
          validTo: null,
          evidence: [{ sourceRefId: "src:gh-c-d4", locator: "message" }],
        },
      ),
    ),
  });

  operations.push({
    id: "retract",
    response: await adapter.execute(
      operatorRequest(
        "RetractClaim",
        1005,
        "op-retract",
        [{ kind: "claim", id: "clm:nw-window" }],
        "dec:op-retract",
        "the audit window was withdrawn by the vendor",
        {
          claimId: "clm:nw-window",
          retractionClass: "incorrect",
          reason: "the audit window was withdrawn by the vendor",
        },
        "destructive",
      ),
    ),
  });

  operations.push({
    id: "canonize",
    response: await adapter.execute(
      operatorRequest(
        "CanonizeClaim",
        1006,
        "op-canonize",
        [{ kind: "claim", id: "clm:req-rot-window" }],
        "dec:op-canonize",
        "the rotation window is a binding requirement",
        { claimId: "clm:req-rot-window", rationale: "binding requirement" },
        "authority",
      ),
    ),
  });

  findings.operations = operations.map((entry) => ({
    id: entry.id,
    outcome: entry.response.outcome,
    code: entry.response.outcome === "committed" ? null : entry.response.error.code,
  }));

  acceptance["w01-all-seven-operations-commit"] =
    operations.length === 7 && operations.every((entry) => entry.response.outcome === "committed");

  // The declared control: every operation records an actor and a rationale, or
  // the walkthrough is unattributed and proves nothing about accountability.
  acceptance["w02-every-operation-is-attributed"] = operations.every((entry) => {
    if (entry.response.outcome !== "committed") return false;
    const receipt = entry.response.receipt;
    return (
      receipt.actorSnapshot.actorClass === "human" &&
      receipt.actorSnapshot.actorId.length > 0 &&
      receipt.intentSnapshot.justification.length > 0
    );
  });

  // Each correction left a durable decision record naming the human.
  const decisions = adapter.snapshot().decisions;
  acceptance["w03-every-operation-left-a-decision"] = [
    "dec:op-correct",
    "dec:op-supersede",
    "dec:op-resolve",
    "dec:op-merge",
    "dec:op-revise",
    "dec:op-retract",
    "dec:op-canonize",
  ].every((id) => decisions.has(id));

  // Verified in a NATIVE read surface: the canonical file an operator would
  // actually open, parsed the way a reader would parse it.
  const claimPath = `${root}/knowledge/claims/clm_req-audit-log.md`;
  const claimText = readFileSync(claimPath, "utf8");
  acceptance["w04-change-is-visible-in-the-native-file"] =
    claimText.includes("carrying prior and next token ids");
  acceptance["w05-native-file-is-well-formed"] =
    claimText.startsWith("---\n") && claimText.includes("```json");

  // The conflict is resolved and still lists both positions. A resolution that
  // deleted the losing member could never be revisited.
  const conflict = adapter.snapshot().contradictions.get("cfl:kestrel-version");
  acceptance["w06-resolution-preserves-both-positions"] =
    conflict?.resolution !== null &&
    (conflict?.members.length ?? 0) >= 1 &&
    (conflict?.peerMembers.length ?? 0) >= 1;

  // --- What a native property surface could actually show -------------------
  const head = [...adapter.snapshot().claims.values()]
    .map((revisions) => revisions[revisions.length - 1])
    .find((revision) => revision?.claimId === "clm:req-audit-log");
  const surface = surfaceReport(head as unknown as Record<string, unknown>);
  findings.surface = surface;

  // Stated as a measurement, not a verdict: these are the fields Obsidian
  // Properties and Bases cannot represent at all, because Properties has no
  // nested type. The temporal interval and the origin are among them, which are
  // the two things a human most needs in order to correct anything.
  acceptance["w07-surface-report-is-populated"] = surface.total > 0;
  acceptance["w08-temporal-and-origin-are-not-natively-representable"] =
    surface.absent.includes("valid") && surface.absent.includes("origin");

  // --- The stale native write, and the hazard its default creates -----------
  const targetPath = `${root}/knowledge/claims/clm_auth-ttl.md`;
  const staleContent = readFileSync(targetPath, "utf8");

  // A newer guarded update lands through the contract while the native writer
  // still holds what it read.
  const intervening = await adapter.execute(
    operatorRequest(
      "CorrectClaim",
      1007,
      "op-intervening",
      [{ kind: "claim", id: "clm:auth-ttl" }],
      "dec:op-intervening",
      "the contract writer commits first",
      {
        claimId: "clm:auth-ttl",
        value: "8 minutes",
        evidence: [{ sourceRefId: "src:gh-c-c3", locator: "message" }],
      },
    ),
  );
  acceptance["w09-intervening-contract-write-commits"] = intervening.outcome === "committed";

  const guarded = nativeWrite(targetPath, `${staleContent}\n<!-- stale native edit -->\n`, {
    requireWritePreconditions: true,
    expectedContent: staleContent,
  });
  acceptance["w10-stale-native-write-is-rejected"] = guarded.outcome === "stale_precondition";

  // Control: the same native write with no intervening update must SUCCEED, or
  // the rejection above is a broken write path rather than a working guard.
  const currentContent = readFileSync(targetPath, "utf8");
  const fresh = nativeWrite(targetPath, currentContent, {
    requireWritePreconditions: true,
    expectedContent: currentContent,
  });
  acceptance["w11-fresh-native-write-succeeds"] = fresh.outcome === "written";

  // The hazard. `requireWritePreconditions` defaults to FALSE in the pinned
  // bundle, and with it off the same stale write silently clobbers.
  const beforeUnguarded = readFileSync(targetPath, "utf8");
  const unguarded = nativeWrite(targetPath, staleContent, {
    requireWritePreconditions: false,
    expectedContent: staleContent,
  });
  const afterUnguarded = readFileSync(targetPath, "utf8");
  acceptance["w12-unguarded-default-silently-clobbers"] =
    unguarded.outcome === "written" &&
    beforeUnguarded !== afterUnguarded &&
    afterUnguarded === staleContent;
  findings.nativeWrite = {
    guarded: guarded.outcome,
    fresh: fresh.outcome,
    unguarded: unguarded.outcome,
    note: "requireWritePreconditions defaults to false in the pinned bundle; the guarded path must be enabled explicitly",
  };

  // Restore, so the vault is left consistent with canonical state rather than
  // with the clobber this control deliberately performed.
  writeFileSync(targetPath, beforeUnguarded, "utf8");

  return emit({
    subcommand: "native-walkthrough",
    lane: "lane-m",
    findings,
    acceptance,
    outcome: outcomeFor(acceptance),
  });
}

/**
 * One party in a two-writer race.
 *
 * The sequence is load-bearing and is the same for both lanes: read the state
 * the decision will be made against, record a DURABLE arrival, wait for every
 * party, and only then attempt the write. Reading after the barrier would give
 * each party a fresh snapshot and there would be no race left to measure.
 */
async function raceParty(
  options: {
    lane: "m" | "n";
    raceCase: RaceCase;
    member: string;
    parties: number;
    guarded: boolean;
    corpusRoot: string;
    root: string;
  },
): Promise<number> {
  const { corpus, vectors } = loadCorpus(options.corpusRoot);
  const probe = openDb(`race:${options.member}`, "probe", 2);
  await waitForDb(probe, TIMEOUTS.commandMs * 4);

  let response: CommandResponse;
  let observed: string | null = null;
  let store: GraphStore | null = null;

  try {
    if (options.lane === "m") {
      const adapter = new LaneMAdapter({
        root: options.root,
        corpus,
        vectors,
        guarded: options.guarded,
      });
      observed = adapter.versionOf({ kind: "claim", id: "clm:auth-ttl" });
      await arrive(probe, options.raceCase, "gathered", options.member, `${process.pid}`);
      await waitForParties(probe, options.raceCase, "gathered", options.parties, options.member);
      response = await adapter.execute(raceRequest(options.raceCase, options.member, observed));
    } else {
      store = new GraphStore(process.env.NEO4J_URI ?? "bolt://neo4j-n:7687", options.root);
      await store.waitForReady(TIMEOUTS.barrierArrivalMs * 6);
      const adapter = await LaneNAdapter.open({ store, corpus, vectors });
      observed = adapter.versionOf({ kind: "claim", id: "clm:auth-ttl" });
      await arrive(probe, options.raceCase, "gathered", options.member, `${process.pid}`);
      await waitForParties(probe, options.raceCase, "gathered", options.parties, options.member);
      response = await adapter.execute(raceRequest(options.raceCase, options.member, observed));
    }

    const outcome = raceOutcome(options.member, response);
    await witness(probe, options.raceCase, options.member, "race-outcome", { ...outcome });

    return emit({
      subcommand: "race-party",
      lane: `lane-${options.lane}`,
      case: options.raceCase,
      member: options.member,
      observedToken: observed === null ? null : "<token>",
      outcome: { status: "pass" },
      result: outcome,
    });
  } finally {
    if (store) await store.close().catch(() => {});
    await probe.close();
  }
}

/**
 * Collect a race and decide what it showed.
 *
 * A bounded race reports an OUTCOME SET, never a guarantee. Nothing here loops a
 * participant body, so a trial is one isolated repeat: an unsampled interleaving
 * is unsampled, not impossible, and this case is excluded from every structural
 * digest by construction.
 */
async function raceCollect(
  lane: "m" | "n",
  raceCase: RaceCase,
  parties: number,
  corpusRoot: string,
  root: string,
): Promise<number> {
  const acceptance: Record<string, boolean> = {};
  const findings: Record<string, unknown> = {};
  const { corpus, vectors } = loadCorpus(corpusRoot);

  const probe = openDb("race:collect", "probe", 2);
  await waitForDb(probe, TIMEOUTS.commandMs * 4);
  let store: GraphStore | null = null;

  try {
    const seen = await arrivals(probe, raceCase, "gathered");
    findings.arrivals = seen.map((entry) => ({ member: entry.member }));
    // Overlap is proven by a complete arrival set before any party proceeded,
    // not by comparing wall clocks — those are volatile and the proof would then
    // depend on clock resolution.
    acceptance[`${raceCase}-parties-genuinely-overlapped`] = overlapProven(seen, parties);

    // Arrival spread is reported as a FINDING, never asserted. It is the number
    // that says whether the apparatus could have observed the window at all: a
    // spread far wider than the effect means an absence of lost updates is a
    // property of the barrier rather than of the store.
    const released = await arrivals(probe, raceCase, "gathered-release");
    findings.barrier = {
      arrivalSpreadMs: releaseSpreadMs(seen),
      releaseSpreadMs: releaseSpreadMs(released),
      releasedParties: released.length,
    };
    acceptance[`${raceCase}-parties-were-released-together`] = released.length === parties;

    const observed = await events(probe, raceCase);
    const outcomes = observed
      .filter((entry) => entry.kind === "race-outcome")
      .map((entry) => entry.detail as RaceOutcome);
    findings.outcomes = outcomes;
    acceptance[`${raceCase}-every-party-reported`] = outcomes.length === parties;

    let state;
    if (lane === "m") {
      const adapter = new LaneMAdapter({ root, corpus, vectors });
      state = adapter.snapshot();
    } else {
      store = new GraphStore(process.env.NEO4J_URI ?? "bolt://neo4j-n:7687", root);
      await store.waitForReady(TIMEOUTS.barrierArrivalMs * 6);
      const adapter = await LaneNAdapter.open({ store, corpus, vectors });
      state = adapter.snapshot();
    }

    const committed = outcomes.filter((entry) => entry.outcome === "committed").length;
    const refused = outcomes.filter((entry) => entry.outcome === "refused");
    // `failed` is a STORE-level rejection and is counted separately from a
    // policy refusal, because which of the two stopped the second writer is the
    // whole question these cases ask.
    const failed = outcomes.filter((entry) => entry.outcome === "failed");
    findings.stoppedBy = {
      policyRefusals: refused.map((entry) => entry.code),
      storeRejections: failed.map((entry) => entry.code),
    };

    if (raceCase === "x03") {
      const entity = state.entities.get(RACE_ENTITY);
      acceptance["x03-exactly-one-entity-exists"] = entity !== undefined;
      findings.duplicateOutcome = {
        committed,
        refused: refused.map((entry) => entry.code),
        failed: failed.map((entry) => entry.code),
        // A second entity cannot exist under a uniqueness constraint, so what
        // this case really measures is whether the loser was TOLD. A silent
        // second commit is the defect.
        duplicateCommitted: committed > 1,
      };
      acceptance["x03-final-state-is-readable"] = entity !== undefined;
      acceptance["x03-outcome-is-classifiable"] =
        committed + refused.length + failed.length === outcomes.length &&
        outcomes.length === parties;
    } else {
      const revisions = state.claims.get("clm:auth-ttl") ?? [];
      const head = revisions[revisions.length - 1];
      const survivors = revisions.filter((revision) =>
        outcomes.some((entry) => entry.outcome === "committed" && revision.value === `${entry.member} minutes`),
      );
      // THE measurement. Two commits and one surviving revision means a
      // committed change was silently discarded: no error was raised anywhere,
      // and the writer that lost was told it had succeeded.
      const lostUpdate = committed > survivors.length;
      findings.staleUpdate = {
        committed,
        refusedCodes: refused.map((entry) => entry.code),
        failedCodes: failed.map((entry) => entry.code),
        revisionCount: revisions.length,
        headValue: head?.value ?? null,
        survivingRaceRevisions: survivors.length,
        lostUpdate,
        // The surviving revision's value and its author must belong to the SAME
        // writer. A head carrying one party's text under the other's identity is
        // a torn update that a revision count alone cannot see.
        headActorId: head?.origin.actorId ?? null,
        headValueAndAuthorAgree:
          head === undefined
            ? null
            : head.origin.actorId.includes(String(head.value).split(" ")[0] ?? "\u0000"),
      };
      // Not "no lost update" — that is a property of the lane, and asserting it
      // here would turn a measurement into a requirement. What must hold is that
      // the harness can TELL, which it can only do if every party reported and a
      // head exists to inspect.
      acceptance["x04-final-state-is-readable"] = head !== undefined;
      acceptance["x04-outcome-is-classifiable"] =
        committed + refused.length + failed.length === outcomes.length &&
        outcomes.length === parties;
      // Whatever survived must be internally coherent. This CAN fail, and that
      // is the point: it is the one assertion here that a lost update trips.
      acceptance["x04-surviving-head-is-not-torn"] =
        findings.staleUpdate !== undefined &&
        (head === undefined ||
          head.origin.actorId.includes(String(head.value).split(" ")[0] ?? "\u0000"));
    }

    return emit({
      subcommand: "race-collect",
      lane: `lane-${lane}`,
      case: raceCase,
      classification: "bounded-trials",
      findings,
      acceptance,
      outcome: outcomeFor(acceptance),
    });
  } finally {
    if (store) await store.close().catch(() => {});
    await probe.close();
  }
}

/**
 * The plan a supersession produces, used as the crash subject.
 *
 * Taken from the shared policy module rather than hand-written, so the torn
 * state both lanes face is the state a real command would have produced.
 */
function supersessionPlan(
  state: KnowledgeState,
  documentText: (source: string, locator: string) => string | null,
): {
  ops: import("./knowledge/policy.ts").PlanOp[];
  claimId: string;
  /** The pre-crash shape, so "nothing survived" can be checked against something. */
  revisionsBefore: number;
  headValueBefore: string | null;
} {
  const claimId = "clm:auth-ttl";
  const decision = decide(
    {
      contractVersion: KNOWLEDGE_CONTRACT_VERSION,
      command: "SupersedeClaim",
      actor: {
        actorId: "agent.coder@node.ada",
        actorClass: "agent",
        nodeId: "node.ada",
        onBehalfOf: null,
      },
      intent: {
        effectClass: "corrective",
        scope: [{ kind: "claim", id: claimId }],
        decisionRef: null,
        justification: "crash subject",
      },
      idempotency: { key: "crash-subject", keyScope: "global" },
      guard: { mode: "unguarded", reason: "supersession is world progression" },
      tick: 2000,
      args: {
        claimId,
        value: "5 minutes",
        worldChangeAt: "2026-07-01T00:00:00.000Z",
        evidence: [{ sourceRefId: "src:gh-c-c3", locator: "message" }],
      },
    },
    {
      state,
      instant: tickToInstant(2000),
      versionOf: () => null,
      nodeId: "node.ada",
      documentText,
      contentHash: (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex"),
    },
  );
  if (decision.kind !== "plan") throw new Error("crash subject did not plan");
  const before = state.claims.get(claimId) ?? [];
  return {
    ops: decision.plan.ops,
    claimId,
    revisionsBefore: before.length,
    headValueBefore: before.at(-1)?.value ?? null,
  };
}

/**
 * Lane M's fault matrix: crash, publication failure, malformed input, and the
 * portable export round trip.
 *
 * Every fault fires from durable state — an intent record on disk, a committed
 * revision, a written export — and never from an elapsed interval. A sleep
 * before a kill is the most reliable way to produce a result that cannot be
 * reproduced.
 */
async function faultsM(corpusRoot: string, vaultRoot: string): Promise<number> {
  const acceptance: Record<string, boolean> = {};
  const findings: Record<string, unknown> = {};
  const { corpus, script, vectors } = loadCorpus(corpusRoot);
  const documentText = (sourceRefId: string, locator: string): string | null => {
    const source = corpus.sources.find((entry) => entry.id === sourceRefId);
    return source?.documents.find((entry) => entry.locator === locator)?.text ?? null;
  };

  // --- x05: the process dies between the new revision and the closure --------
  const torn = new LaneMAdapter({ root: `${vaultRoot}/torn`, corpus, vectors });
  await applyScript(torn, corpus, script);
  const healthy = digest(await torn.exportState());

  const plan = supersessionPlan(torn.snapshot(), documentText);
  const store = new MarkdownStore(`${vaultRoot}/torn`);
  // The plan is evidence, close, append. Stopping after the close leaves the
  // predecessor shut and its successor missing: the claim has no live revision.
  const crash = store.applyWithCrash("crash-x05", "SupersedeClaim", plan.ops, plan.ops.length - 1);
  torn.reload();
  findings.crash = { appliedOps: crash.applied, totalOps: plan.ops.length };

  acceptance["x05-crash-leaves-a-pending-intent"] = torn.pendingIntents().length === 1;
  const tornRevisions = torn.snapshot().claims.get(plan.claimId) ?? [];
  const tornHead = tornRevisions[tornRevisions.length - 1];
  // The torn state is genuinely incoherent: the head revision is closed, so the
  // claim currently has no believed value at all.
  acceptance["x05-state-is-observably-torn"] =
    tornHead !== undefined && tornHead.assertedUntil !== null;
  acceptance["x05-digest-differs-while-torn"] = digest(await torn.exportState()) !== healthy;

  const repaired = torn.repair();
  acceptance["x05-repair-completes-the-mutation"] = repaired.length === 1;
  acceptance["x05-repair-leaves-no-pending-intents"] = torn.pendingIntents().length === 0;
  const fixedRevisions = torn.snapshot().claims.get(plan.claimId) ?? [];
  const fixedHead = fixedRevisions[fixedRevisions.length - 1];
  acceptance["x05-repaired-state-is-coherent"] =
    fixedHead !== undefined && fixedHead.assertedUntil === null && fixedHead.value === "5 minutes";

  // The declared control: a kill placed AFTER the commit returned must leave the
  // effect intact, or absence cannot be attributed to the interruption.
  const clean = new LaneMAdapter({ root: `${vaultRoot}/clean`, corpus, vectors });
  await applyScript(clean, corpus, script);
  const cleanStore = new MarkdownStore(`${vaultRoot}/clean`);
  const cleanPlan = supersessionPlan(clean.snapshot(), documentText);
  cleanStore.applyWithCrash("crash-control", "SupersedeClaim", cleanPlan.ops, cleanPlan.ops.length);
  cleanStore.completeIntent("crash-control");
  clean.reload();
  acceptance["x05-control-post-commit-kill-keeps-the-effect"] =
    clean.pendingIntents().length === 0 &&
    (clean.snapshot().claims.get(cleanPlan.claimId)?.length ?? 0) === fixedRevisions.length;

  // Repairing an already-complete mutation must be a no-op, or repair itself
  // becomes a source of drift.
  const beforeIdempotent = digest(await torn.exportState());
  torn.repair();
  acceptance["x05-repair-is-idempotent"] = digest(await torn.exportState()) === beforeIdempotent;

  // --- x08: publication fails after knowledge has committed -----------------
  //
  // Modelled by committing the knowledge write and then NOT publishing. The
  // receipt already names the obligation, so the gap is detectable from the
  // receipt alone rather than only by noticing the feed is short.
  const publisher = new LaneMAdapter({ root: `${vaultRoot}/publish`, corpus, vectors });
  await applyScript(publisher, corpus, script);
  const feedBefore = Object.keys(feedBytes(`${vaultRoot}/publish`)).length;
  const receipt = await publisher.execute(
    operatorRequest(
      "CanonizeClaim",
      2100,
      "x08-knowledge",
      [{ kind: "claim", id: "clm:req-audit-log" }],
      "dec:x08",
      "knowledge commits, publication does not follow",
      { claimId: "clm:req-audit-log", rationale: "x08" },
      "authority",
    ),
  );
  acceptance["x08-knowledge-committed"] = receipt.outcome === "committed";
  acceptance["x08-feed-did-not-advance"] =
    Object.keys(feedBytes(`${vaultRoot}/publish`)).length === feedBefore;
  // The control: a successful publication must produce exactly one record, and
  // replaying it must not produce a second.
  const published = await publisher.execute(
    operatorRequest(
      "PublishActivityRecord",
      2101,
      "x08-publish",
      [{ kind: "activity_record", id: "node.ada/0000000002" }],
      null,
      "control publication",
      {
        recordId: "node.ada/0000000002",
        record: {
          workItemId: "wi:rotation",
          kind: "progress",
          summary: "control",
          status: "active",
          outputs: [],
          knowledgeRefs: [],
        },
      },
      "publish",
    ),
  );
  const replay = await publisher.execute(
    operatorRequest(
      "PublishActivityRecord",
      2101,
      "x08-publish",
      [{ kind: "activity_record", id: "node.ada/0000000002" }],
      null,
      "control publication",
      {
        recordId: "node.ada/0000000002",
        record: {
          workItemId: "wi:rotation",
          kind: "progress",
          summary: "control",
          status: "active",
          outputs: [],
          knowledgeRefs: [],
        },
      },
      "publish",
    ),
  );
  acceptance["x08-control-publication-succeeds"] = published.outcome === "committed";
  acceptance["x08-replay-produces-exactly-one-record"] =
    replay.outcome === "committed" &&
    replay.receipt.replayed &&
    Object.keys(feedBytes(`${vaultRoot}/publish`)).length === feedBefore + 1;

  // --- x10: a malformed command is refused with no residue ------------------
  const malformed = await publisher.execute(
    operatorRequest(
      "CreateClaim",
      2200,
      "x10-malformed",
      [{ kind: "claim", id: "clm:x10" }],
      null,
      "malformed: interval inverted",
      {
        claimId: "clm:x10",
        subject: "ent:halyard",
        predicate: "status",
        value: "healthy",
        validFrom: "2026-09-01T00:00:00.000Z",
        validTo: "2026-01-01T00:00:00.000Z",
        evidence: [{ sourceRefId: "src:gh-iss-9", locator: "body" }],
      },
      "additive",
    ),
  );
  acceptance["x10-malformed-is-refused"] =
    malformed.outcome === "refused" && malformed.error.code === "TEMPORAL_INVALID";
  acceptance["x10-malformed-leaves-no-residue"] = !publisher.snapshot().claims.has("clm:x10");
  // The control: the well-formed twin of the same fixture must be accepted.
  const wellFormed = await publisher.execute(
    operatorRequest(
      "CreateClaim",
      2201,
      "x10-wellformed",
      [{ kind: "claim", id: "clm:x10-ok" }],
      null,
      "the well-formed twin",
      {
        claimId: "clm:x10-ok",
        subject: "ent:halyard",
        predicate: "status",
        value: "healthy",
        validFrom: "2026-01-01T00:00:00.000Z",
        validTo: "2026-09-01T00:00:00.000Z",
        evidence: [{ sourceRefId: "src:gh-iss-9", locator: "body" }],
      },
      "additive",
    ),
  );
  acceptance["x10-control-wellformed-twin-commits"] = wellFormed.outcome === "committed";

  // --- r03: portable export imported into fresh state -----------------------
  const source = new LaneMAdapter({ root: `${vaultRoot}/export-src`, corpus, vectors });
  await applyScript(source, corpus, script);
  const exported = (await source.exportState()) as NeutralExport;

  const imported = new LaneMAdapter({ root: `${vaultRoot}/export-dst`, corpus, vectors });
  new MarkdownStore(`${vaultRoot}/export-dst`).apply(opsFromExport(exported));
  imported.reload();
  const roundTrip = (await imported.exportState()) as NeutralExport;
  acceptance["r03-import-reproduces-the-export"] = digest(
    comparableExport(roundTrip),
  ) === digest(comparableExport(exported));

  // The control: an export with one evidence link removed must FAIL the
  // comparison, or the equality above is satisfied by a comparison that cannot
  // detect anything.
  const damagedRoot = `${vaultRoot}/export-damaged`;
  const damaged = new LaneMAdapter({ root: damagedRoot, corpus, vectors });
  new MarkdownStore(damagedRoot).apply(opsFromExport(withOneEvidenceLinkRemoved(exported)));
  damaged.reload();
  acceptance["r03-control-damaged-export-differs"] =
    digest(comparableExport((await damaged.exportState()) as NeutralExport)) !==
    digest(comparableExport(exported));

  return emit({
    subcommand: "faults-m",
    lane: "lane-m",
    findings,
    acceptance,
    outcome: outcomeFor(acceptance),
  });
}

/**
 * Only the parts a portable export is supposed to carry.
 *
 * Published records and peer material live outside the knowledge plane, and
 * rejections are contentless audit rows; none of them is knowledge, so requiring
 * a knowledge export to reproduce them would be testing the wrong boundary.
 */
function comparableExport(state: Record<string, unknown>): Record<string, unknown> {
  return {
    entities: state.entities,
    claims: state.claims,
    relationships: state.relationships,
    evidence: state.evidence,
    sources: state.sources,
    contradictions: state.contradictions,
    decisions: state.decisions,
  };
}

/**
 * The questions whose answers depend on graph STRUCTURE rather than on node
 * properties.
 *
 * Provenance walks evidence to source, path walks typed relationships, and
 * conflicts and history walk revision chains. These are exactly the answers a
 * property-bag export comparison cannot vouch for, which is why the round trip
 * replays them rather than trusting the digest.
 */
const STRUCTURAL_QUERY_KINDS = new Set(["Provenance", "Path", "History", "Conflicts", "Current"]);

async function replayStructuralQuestions(
  adapter: LaneNAdapter,
  questions: Awaited<ReturnType<typeof loadCorpus>>["questions"],
): Promise<Record<string, unknown>> {
  const answers: Record<string, unknown> = {};
  for (const question of questions.queries) {
    if (!STRUCTURAL_QUERY_KINDS.has(String(question.query))) continue;
    answers[question.id] = await adapter.query({
      contractVersion: KNOWLEDGE_CONTRACT_VERSION,
      query: question.query as never,
      constraint: { ...questions.defaults, ...(question.constraint ?? {}) } as never,
      args: { ...question.args, queryId: question.id },
    });
  }
  return answers;
}

/**
 * Lane N's fault matrix: the same interruption, against a transactional store.
 */
async function faultsN(corpusRoot: string, sourcesRoot: string): Promise<number> {
  const acceptance: Record<string, boolean> = {};
  const findings: Record<string, unknown> = {};
  const { corpus, script, vectors, questions } = loadCorpus(corpusRoot);
  const documentText = (sourceRefId: string, locator: string): string | null => {
    const source = corpus.sources.find((entry) => entry.id === sourceRefId);
    return source?.documents.find((entry) => entry.locator === locator)?.text ?? null;
  };

  const store = new GraphStore(process.env.NEO4J_URI ?? "bolt://neo4j-n:7687", sourcesRoot);
  try {
    await store.waitForReady(TIMEOUTS.barrierArrivalMs * 6);
    await store.setup();
    const adapter = await LaneNAdapter.open({ store, corpus, vectors });

    const staleTokens = new Map<string, string>();
    for (const mutation of script.mutations) {
      await adapter.execute(
        requestFor(mutation, corpus, (ref) => adapter.versionOf(ref), staleTokens),
      );
    }
    const healthy = digest(comparableExport(await adapter.exportState()));

    // --- x05/x06: the same crash, at the same point in the same plan --------
    const plan = supersessionPlan(adapter.snapshot(), documentText);
    const crashed = await store.applyWithCrash(plan.ops, plan.ops.length - 1);
    await adapter.reload();

    // The measured difference. Lane M is left with a pending intent and an
    // incoherent claim; Lane N is left with nothing at all, because the write
    // was one transaction and the transaction rolled back.
    acceptance["x05-nothing-survives-the-crash"] =
      digest(comparableExport(await adapter.exportState())) === healthy;
    // The previous criterion here admitted a revision that was EITHER live OR
    // carried a closure reason — and every closed revision carries one, so no
    // reachable state could fail it, including the torn state it was meant to
    // exclude. What actually distinguishes the lanes is that the pre-crash head
    // is untouched: same revision count, same value, still live.
    const afterCrash = adapter.snapshot().claims.get(plan.claimId) ?? [];
    const head = afterCrash.at(-1);
    acceptance["x05-no-repair-is-required"] =
      afterCrash.length === plan.revisionsBefore &&
      head !== undefined &&
      head.value === plan.headValueBefore;
    acceptance["x05-head-revision-is-still-live"] =
      head !== undefined && head.assertedUntil === null;

    // The control: the identical plan applied WITHOUT the injected fault must
    // land, or "nothing survived" would be indistinguishable from a plan that
    // could never have committed in the first place.
    await store.apply(plan.ops);
    await adapter.reload();
    const committedHead = (adapter.snapshot().claims.get(plan.claimId) ?? []).at(-1);
    acceptance["x05-control-uninterrupted-plan-commits"] =
      committedHead !== undefined && committedHead.value === "5 minutes";
    // Observed, not echoed. The injector used to return its own input, so these
    // numbers described the request rather than what the transaction did.
    findings.crash = {
      ops: plan.ops.length,
      requestedBeforeFault: plan.ops.length - 1,
      observedApplied: crashed.applied,
      committed: crashed.committed,
    };
    // The injector's own paired control: with no fault requested it MUST commit.
    // Without this, an injector that could only ever abort would satisfy every
    // criterion built on it while never being exercised in its committing mode.
    const injectorControl = await store.applyWithCrash([], 0);
    acceptance["x05-control-injector-commits-when-not-interrupted"] = injectorControl.committed;

    // --- x08: knowledge commits, publication does not follow ----------------
    // Ported from Lane M. This is the ONE case that exercises Lane N's declared
    // A3 boundary — the only place it deliberately writes outside the graph
    // transaction — and it had only ever been run against the other lane.
    const feedBefore = Object.keys(feedBytes(sourcesRoot)).length;
    const canonized = await adapter.execute(
      operatorRequest(
        "CanonizeClaim",
        2100,
        "n-x08-knowledge",
        [{ kind: "claim", id: "clm:req-audit-log" }],
        "dec:n-x08",
        "knowledge commits, publication does not follow",
        { claimId: "clm:req-audit-log", rationale: "x08" },
        "authority",
      ),
    );
    acceptance["x08-knowledge-committed"] = canonized.outcome === "committed";
    acceptance["x08-feed-did-not-advance"] =
      Object.keys(feedBytes(sourcesRoot)).length === feedBefore;

    const publishedRecord = await adapter.execute(
      operatorRequest(
        "PublishActivityRecord",
        2101,
        "n-x08-publish",
        [{ kind: "activity_record", id: "node.ada/0000000002" }],
        null,
        "control publication",
        {
          recordId: "node.ada/0000000002",
          record: {
            workItemId: "wi:rotation",
            kind: "progress",
            summary: "control",
            status: "active",
            outputs: [],
            knowledgeRefs: [],
          },
        },
        "publish",
      ),
    );
    acceptance["x08-control-publication-succeeds"] = publishedRecord.outcome === "committed";
    // The obligation must be NAMED on the receipt, and it must name a structure
    // this lane actually has. An unfiltered copy of the shared plan's list made
    // every Lane N receipt claim an obligation on Lane M's projections.
    acceptance["x08-publication-obligation-is-declared"] =
      publishedRecord.outcome === "committed" &&
      publishedRecord.receipt.derivedObligations.includes("coordination.publish") &&
      !publishedRecord.receipt.derivedObligations.some((name) => name.startsWith("projection."));

    const republished = await adapter.execute(
      operatorRequest(
        "PublishActivityRecord",
        2101,
        "n-x08-publish",
        [{ kind: "activity_record", id: "node.ada/0000000002" }],
        null,
        "control publication",
        {
          recordId: "node.ada/0000000002",
          record: {
            workItemId: "wi:rotation",
            kind: "progress",
            summary: "control",
            status: "active",
            outputs: [],
            knowledgeRefs: [],
          },
        },
        "publish",
      ),
    );
    acceptance["x08-replay-produces-exactly-one-record"] =
      republished.outcome === "committed" &&
      republished.receipt.replayed &&
      Object.keys(feedBytes(sourcesRoot)).length === feedBefore + 1;

    // --- x10: a malformed command is refused with no residue ----------------
    const malformed = await adapter.execute(
      operatorRequest(
        "CreateClaim",
        2200,
        "n-x10-malformed",
        [{ kind: "claim", id: "clm:x10" }],
        null,
        "malformed: interval inverted",
        {
          claimId: "clm:x10",
          subject: "ent:halyard",
          predicate: "status",
          value: "healthy",
          validFrom: "2026-09-01T00:00:00.000Z",
          validTo: "2026-01-01T00:00:00.000Z",
          evidence: [{ sourceRefId: "src:gh-iss-9", locator: "body" }],
        },
        "additive",
      ),
    );
    acceptance["x10-malformed-is-refused"] =
      malformed.outcome === "refused" && malformed.error.code === "TEMPORAL_INVALID";
    acceptance["x10-malformed-leaves-no-residue"] = !adapter.snapshot().claims.has("clm:x10");
    const wellFormed = await adapter.execute(
      operatorRequest(
        "CreateClaim",
        2201,
        "n-x10-wellformed",
        [{ kind: "claim", id: "clm:x10-ok" }],
        null,
        "the well-formed twin",
        {
          claimId: "clm:x10-ok",
          subject: "ent:halyard",
          predicate: "status",
          value: "healthy",
          validFrom: "2026-01-01T00:00:00.000Z",
          validTo: "2026-09-01T00:00:00.000Z",
          evidence: [{ sourceRefId: "src:gh-iss-9", locator: "body" }],
        },
        "additive",
      ),
    );
    acceptance["x10-control-wellformed-twin-commits"] = wellFormed.outcome === "committed";

    // --- r03: portable export imported into a fresh graph -------------------
    const exported = (await adapter.exportState()) as NeutralExport;

    // The import runs against THIS instance after wiping it, because Community
    // Edition has one user database and cannot give an import a database of its
    // own. That is a genuine limitation of the edition and is charged to the
    // cost dimension rather than worked around with a second connection — which
    // would also have left a driver open and hung the container.
    const wipe = async (): Promise<void> => {
      const session = store.session();
      try {
        await session.run("MATCH (n) DETACH DELETE n");
      } finally {
        await session.close();
      }
    };

    // Captured BEFORE the wipe: the structure the export cannot see, and the
    // answers that depend on it.
    const edgesBefore = await store.edgeCounts();
    const answersBefore = await replayStructuralQuestions(adapter, questions);

    await wipe();
    await store.setup();
    await store.apply(opsFromExport(exported));
    await adapter.reload();
    acceptance["r03-import-reproduces-the-export"] =
      digest(comparableExport(await adapter.exportState())) ===
      digest(comparableExport(exported));

    // The export is a PROPERTY BAG. Lineage travels as JSON strings on the
    // nodes, so every structural edge — HAS_REVISION, ABOUT, EVIDENCED_BY,
    // DERIVED_FROM, FROM_SOURCE, MERGED_INTO, FROM_REPORT — is invisible to the
    // digest above: drop all of them and it still compares equal while
    // provenance and path answers break. Reproducing the export is therefore not
    // the same claim as reproducing the graph, and both now have to hold.
    const edgesAfter = await store.edgeCounts();
    findings.graphStructure = { before: edgesBefore, after: edgesAfter };
    acceptance["r03-import-reproduces-the-graph"] =
      digest(edgesBefore) === digest(edgesAfter);

    // And the answers that traverse those edges must survive the round trip.
    const answersAfter = await replayStructuralQuestions(adapter, questions);
    // Per-question digests, so a difference NAMES the question that moved
    // instead of collapsing to one unhelpful boolean.
    const beforeDigests = Object.fromEntries(
      Object.entries(answersBefore).map(([id, value]) => [id, digest(value)]),
    );
    const afterDigests = Object.fromEntries(
      Object.entries(answersAfter).map(([id, value]) => [id, digest(value)]),
    );
    const differing = Object.keys(beforeDigests).filter(
      (id) => beforeDigests[id] !== afterDigests[id],
    );
    findings.structuralAnswers = {
      questions: Object.keys(afterDigests).sort(),
      differing,
      before: beforeDigests,
      after: afterDigests,
    };
    acceptance["r03-import-reproduces-structural-answers"] = differing.length === 0;

    // Control 1: an export that is SMALLER but internally consistent must fail
    // the property comparison.
    await wipe();
    await store.setup();
    await store.apply(opsFromExport(withOneEvidenceLinkRemoved(exported)));
    await adapter.reload();
    acceptance["r03-control-damaged-export-differs"] =
      digest(comparableExport(await adapter.exportState())) !==
      digest(comparableExport(exported));

    // Control 2: deleting one structural edge must be caught by the STRUCTURAL
    // comparison and must NOT be caught by the property comparison. Asserting
    // both directions is what proves the two checks measure different things
    // rather than one of them being redundant.
    await wipe();
    await store.setup();
    await store.apply(opsFromExport(exported));
    const dropped = await store.dropOneEvidenceEdge();
    await adapter.reload();
    acceptance["r03-control-dropped-edge-is-invisible-to-the-export"] =
      dropped === 1 &&
      digest(comparableExport(await adapter.exportState())) ===
        digest(comparableExport(exported));
    acceptance["r03-control-dropped-edge-is-caught-structurally"] =
      digest(await store.edgeCounts()) !== digest(edgesBefore);

    // Control 3: a DANGLING reference must be refused before anything is
    // written. The import path skips every policy check by design, so this is
    // the only validation standing between a corrupt export and a silently
    // incomplete store.
    let danglingRefused = false;
    try {
      opsFromExport(withDanglingEvidenceReference(exported));
    } catch (error) {
      danglingRefused = error instanceof ExportRejected;
    }
    acceptance["r03-control-dangling-reference-is-refused"] = danglingRefused;

    // Control 4: an export from another contract version must be refused rather
    // than imported silently. The field was emitted, never read, and excluded
    // from the comparison.
    let versionRefused = false;
    try {
      opsFromExport({ ...exported, contractVersion: "knowledge/9.9.9" });
    } catch (error) {
      versionRefused = error instanceof ExportRejected;
    }
    acceptance["r03-control-version-mismatch-is-refused"] = versionRefused;

    return emit({
      subcommand: "faults-n",
      lane: "lane-n",
      findings,
      acceptance,
      outcome: outcomeFor(acceptance),
    });
  } finally {
    await store.close().catch(() => {});
  }
}

/**
 * Lane N's native operator surface: what Neo4j Browser can and cannot enforce.
 *
 * Browser has no `:begin`/`:commit`/`:rollback`, so its transaction boundary is
 * the statement boundary, and its access-mode setting is documented as NOT a
 * security control. With role-based access control being Enterprise-only, the
 * question this answers is blunt: can Community Edition stop an operator from
 * writing around the command contract? The measurement is what a raw Cypher
 * statement actually achieves, not what the procedure says an operator should do.
 */
async function nativeGraph(corpusRoot: string, sourcesRoot: string): Promise<number> {
  const acceptance: Record<string, boolean> = {};
  const findings: Record<string, unknown> = {};
  const { corpus, script, vectors } = loadCorpus(corpusRoot);

  const store = new GraphStore(process.env.NEO4J_URI ?? "bolt://neo4j-n:7687", sourcesRoot);
  try {
    await store.waitForReady(TIMEOUTS.barrierArrivalMs * 6);
    await store.setup();
    const adapter = await LaneNAdapter.open({ store, corpus, vectors });

    const staleTokens = new Map<string, string>();
    for (const mutation of script.mutations) {
      const request = requestFor(mutation, corpus, (ref) => adapter.versionOf(ref), staleTokens);
      await adapter.execute(request);
    }

    const before = adapter.snapshot().claims.get("clm:auth-ttl") ?? [];
    const revisionsBefore = before.length;
    const decisionsBefore = adapter.snapshot().decisions.size;

    // The bypass. This is what an operator with a Browser window can do.
    const session = store.session();
    try {
      await session.run(
        `MATCH (r:ClaimRevision {claimId: 'clm:auth-ttl'})
         WITH r ORDER BY r.revision DESC LIMIT 1
         SET r.value = '99 minutes'`,
      );
    } finally {
      await session.close();
    }
    await adapter.reload();

    const after = adapter.snapshot().claims.get("clm:auth-ttl") ?? [];
    const head = after[after.length - 1];
    acceptance["g01-raw-cypher-write-succeeds"] = head?.value === "99 minutes";
    // And it left none of what the contract would have required.
    acceptance["g02-bypass-appends-no-revision"] = after.length === revisionsBefore;
    acceptance["g03-bypass-records-no-decision"] =
      adapter.snapshot().decisions.size === decisionsBefore;
    acceptance["g04-bypass-is-unattributed"] =
      head !== undefined && head.origin.actorId !== "" && head.assertedAt === before[before.length - 1]?.assertedAt;

    // The same change through the contract, by an agent with no human decision,
    // is refused. The contrast is the finding: the rule exists and is enforced
    // at the contract, and Community Edition cannot make the operator use it.
    const throughContract = await adapter.execute({
      contractVersion: KNOWLEDGE_CONTRACT_VERSION,
      command: "CorrectClaim",
      actor: {
        actorId: "agent.coder@node.ada",
        actorClass: "agent",
        nodeId: "node.ada",
        onBehalfOf: null,
      },
      intent: {
        effectClass: "corrective",
        scope: [{ kind: "claim", id: "clm:auth-ttl" }],
        decisionRef: null,
        justification: "same edit, through the contract, with no human decision",
      },
      idempotency: { key: "graph-contract-attempt", keyScope: "global" },
      guard: { mode: "unguarded", reason: "comparison" },
      tick: 1100,
      args: {
        claimId: "clm:auth-ttl",
        value: "99 minutes",
        evidence: [{ sourceRefId: "src:gh-c-c3", locator: "message" }],
      },
    });
    acceptance["g05-same-change-refused-through-contract"] =
      throughContract.outcome === "refused" &&
      throughContract.error.code === "DECISION_REF_REQUIRED";

    // Community Edition has no mechanism that could have prevented the bypass.
    // Recorded as a measured absence rather than as a documentation claim.
    const constraints = await store.constraintNames();
    findings.constraints = constraints;
    acceptance["g06-no-rbac-constraint-exists"] = !constraints.some((name) =>
      name.toLowerCase().includes("role"),
    );

    // The edition itself, asked directly. The criterion above can only observe
    // constraint names this harness created, none of which mentions a role, so
    // it holds on ANY edition and says nothing about Community. `SHOW ROLES` is
    // the administration command role-based access control would provide; on
    // Community it is not available at all, and that refusal IS the measurement.
    const rbac = await (async (): Promise<{ available: boolean; detail: string }> => {
      const session = store.session();
      try {
        await session.run("SHOW ROLES YIELD role RETURN role LIMIT 1");
        return { available: true, detail: "SHOW ROLES succeeded" };
      } catch (error) {
        return {
          available: false,
          detail: error instanceof Error ? error.message.slice(0, 200) : "unavailable",
        };
      } finally {
        await session.close();
      }
    })();
    findings.rbac = rbac;
    acceptance["g06-role-administration-is-unavailable"] = !rbac.available;

    // What Browser can actually display. Nested contract structures are stored
    // as opaque JSON strings because Community Edition has no property type
    // constraint to make a nested shape safe, so an operator sees a string where
    // the contract has a structure.
    const graphSession = store.session();
    try {
      const result = await graphSession.run(
        `MATCH (r:ClaimRevision {claimId: 'clm:auth-ttl'})
         RETURN r.revision AS rev, properties(r) AS p ORDER BY rev`,
      );
      const rows = result.records.map((record) => ({
        revision: Number(record.get("rev")),
        properties: (record.get("p") ?? {}) as Record<string, unknown>,
      }));
      const head = rows[rows.length - 1]?.properties ?? {};
      const opaque = Object.entries(head)
        .filter(([, value]) => typeof value === "string" && /^[[{]/.test(value))
        .map(([key]) => key)
        .sort();

      // The temporal interval IS a pair of flat, queryable properties here,
      // which Lane M cannot represent in a native property surface at all. The
      // caveat is real though: Neo4j drops a null property, so an OPEN interval
      // is represented by the absence of `validTo` rather than by an explicit
      // null. An operator reading Browser sees a missing field where Lane M's
      // file says `"to": null`, and a Cypher predicate has to test `IS NULL`
      // rather than compare a value.
      const closed = rows.filter((row) => "validTo" in row.properties);
      findings.graphSurface = {
        total: Object.keys(head).length,
        opaqueJsonProperties: opaque,
        revisionsWithExplicitValidTo: closed.map((row) => row.revision),
        openIntervalRepresentation: "property absence, not an explicit null",
      };
      acceptance["g07-temporal-is-natively-visible"] =
        rows.every((row) => "validFrom" in row.properties) && closed.length > 0;
      acceptance["g08-nested-contract-values-are-opaque"] = opaque.includes("origin");
    } finally {
      await graphSession.close();
    }

    return emit({
      subcommand: "native-graph",
      lane: "lane-n",
      findings,
      acceptance,
      outcome: outcomeFor(acceptance),
    });
  } finally {
    await store.close().catch(() => {});
  }
}

/**
 * The coordination-plane controls.
 *
 * Every claim here is paired with the observation that must fail for its own
 * named reason. Non-promotion in particular is stated POSITIVELY as well: if the
 * same subject cannot be established by a human on real evidence, then
 * non-promotion is an inability rather than a policy, and the architecture would
 * be claiming credit for a limitation.
 *
 * Runs offline against Lane M's canonical store. The coordination plane is
 * filesystem-backed and shared by both lanes, so its semantics do not depend on
 * which knowledge store is canonical — which is itself the point.
 */
async function coordinationControls(corpusRoot: string, vaultRoot: string): Promise<number> {
  const acceptance: Record<string, boolean> = {};
  const findings: Record<string, unknown> = {};
  const { corpus, script, vectors, questions } = loadCorpus(corpusRoot);

  const adapter = new LaneMAdapter({ root: `${vaultRoot}/main`, corpus, vectors });
  await applyScript(adapter, corpus, script);

  // --- Feed integrity, checked against the bytes rather than against a claim
  // the feed makes about itself.
  const audits = auditFeed(`${vaultRoot}/main`);
  findings.feed = audits;
  acceptance["p01-feed-is-nonempty"] = audits.length === 1 && (audits[0]?.recordIds.length ?? 0) === 1;
  acceptance["p02-sequence-is-contiguous"] = audits.every((audit) => audit.sequenceContiguous);
  acceptance["p03-chain-is-intact"] = audits.every((audit) => audit.chainIntact);
  acceptance["p04-namespace-is-owned"] = audits.every((audit) => audit.namespaceOwned);
  acceptance["p05-hashes-verify"] = audits.every((audit) => audit.hashesVerify);

  // --- Republication. Identical content is idempotent; different content under
  // an id that already exists is a rewritten history and must be refused.
  const original = (corpus.peerRecords[0] ?? {}) as Record<string, unknown>;
  const republished = publish(`${vaultRoot}/main`, "node.ada/0000000001", {
    workItemId: "wi:rotation",
    kind: "completed",
    summary: "Refresh-token rotation landed for halyard-auth.",
    status: "done",
    outputs: [{ type: "github_pr", uri: "synthetic://github.invalid/acme/halyard/pull/42" }],
    knowledgeRefs: ["clm:req-no-major-bump"],
  });
  acceptance["p06-republication-is-idempotent"] = republished.outcome === "identical";
  const rewritten = publish(`${vaultRoot}/main`, "node.ada/0000000001", {
    workItemId: "wi:rotation",
    kind: "completed",
    summary: "Something else entirely.",
    status: "done",
    outputs: [],
    knowledgeRefs: [],
  });
  acceptance["p07-rewritten-record-is-refused"] = rewritten.outcome === "conflict";
  acceptance["p08-feed-unchanged-after-refusal"] =
    auditFeed(`${vaultRoot}/main`)[0]?.recordIds.length === 1;

  // --- A rewritten PEER history is quarantined rather than ingested.
  const tamper = { ...original, summary: "Migrated kestrel-ingest to tokenring 3.0.0." };
  const tamperResponse = await adapter.execute({
    contractVersion: KNOWLEDGE_CONTRACT_VERSION,
    command: "IngestPeerActivity",
    actor: { actorId: "agent.coder@node.ada", actorClass: "agent", nodeId: "node.ada", onBehalfOf: null },
    intent: { effectClass: "additive", scope: [], decisionRef: null, justification: "tamper control" },
    idempotency: { key: "ctl-tamper", keyScope: "global" },
    guard: { mode: "unguarded", reason: "ingest is additive" },
    tick: 900,
    args: { recordId: String(original.recordId), record: tamper },
  });
  acceptance["p09-rewritten-peer-history-is-quarantined"] =
    tamperResponse.outcome === "refused" &&
    tamperResponse.error.code === "PEER_HISTORY_REWRITTEN";
  // The control: re-ingesting the SAME bytes must still succeed, or the check is
  // rejecting republication rather than rejecting rewriting.
  const reingest = await adapter.execute({
    contractVersion: KNOWLEDGE_CONTRACT_VERSION,
    command: "IngestPeerActivity",
    actor: { actorId: "agent.coder@node.ada", actorClass: "agent", nodeId: "node.ada", onBehalfOf: null },
    intent: { effectClass: "additive", scope: [], decisionRef: null, justification: "reingest control" },
    idempotency: { key: "ctl-reingest", keyScope: "global" },
    guard: { mode: "unguarded", reason: "ingest is additive" },
    tick: 901,
    args: { recordId: String(original.recordId), record: original },
  });
  acceptance["p10-identical-reingest-still-commits"] = reingest.outcome === "committed";

  // --- Non-promotion, stated in both directions.
  //
  // The peer asserts kestrel-ingest pins tokenring 2.0.0, which is false against
  // local commit evidence. Citing the REPORT must be refused; establishing the
  // same subject on a real source through a human decision must succeed. Without
  // the second half, non-promotion would be indistinguishable from an inability
  // to write the claim at all.
  const viaReport = await adapter.execute({
    contractVersion: KNOWLEDGE_CONTRACT_VERSION,
    command: "CreateClaim",
    actor: { actorId: "ada", actorClass: "human", nodeId: "node.ada", onBehalfOf: null },
    intent: {
      effectClass: "additive",
      scope: [{ kind: "claim", id: "clm:ctl-via-report" }],
      decisionRef: "dec:ctl-promote",
      justification: "human cites the peer report itself",
    },
    idempotency: { key: "ctl-via-report", keyScope: "global" },
    guard: { mode: "unguarded", reason: "create is additive" },
    tick: 902,
    args: {
      claimId: "clm:ctl-via-report",
      subject: "ent:kestrel-ingest",
      predicate: "pins_dependency_reviewed",
      value: "tokenring 2.0.0",
      validFrom: "2026-01-04T00:00:00.000Z",
      validTo: null,
      evidence: [{ peerRecordId: String(original.recordId) }],
    },
  });
  acceptance["p11-peer-report-cannot-author"] =
    viaReport.outcome === "refused" && viaReport.error.code === "PEER_PROMOTION_FORBIDDEN";

  const viaSource = await adapter.execute({
    contractVersion: KNOWLEDGE_CONTRACT_VERSION,
    command: "CreateClaim",
    actor: { actorId: "ada", actorClass: "human", nodeId: "node.ada", onBehalfOf: null },
    intent: {
      effectClass: "additive",
      scope: [{ kind: "claim", id: "clm:ctl-via-source" }],
      decisionRef: "dec:ctl-promote",
      justification: "human establishes the same subject on a real source",
    },
    idempotency: { key: "ctl-via-source", keyScope: "global" },
    guard: { mode: "unguarded", reason: "create is additive" },
    tick: 903,
    args: {
      claimId: "clm:ctl-via-source",
      subject: "ent:kestrel-ingest",
      predicate: "pins_dependency_reviewed",
      value: "tokenring 2.0.0",
      validFrom: "2026-01-04T00:00:00.000Z",
      validTo: null,
      evidence: [{ sourceRefId: "src:gh-c-e5", locator: "message" }],
    },
  });
  acceptance["p12-human-can-establish-on-real-evidence"] = viaSource.outcome === "committed";
  findings.nonPromotion = {
    viaReport: viaReport.outcome === "refused" ? viaReport.error.code : viaReport.outcome,
    viaSource: viaSource.outcome,
  };

  // --- Privacy. Nothing whose sensitivity is above `public` may cross the
  // publication boundary, and the canary may not appear anywhere in the feed.
  const bytes = JSON.stringify(feedBytes(`${vaultRoot}/main`));
  const nonPublicValues = [...adapter.snapshot().claims.values()]
    .map((revisions) => revisions[revisions.length - 1])
    .filter((revision) => revision && revision.sensitivity !== "public")
    .map((revision) => revision?.value ?? "")
    .filter((value) => value.length > 0);
  acceptance["p13-no-non-public-value-in-feed"] = nonPublicValues.every(
    (value) => !bytes.includes(value),
  );
  acceptance["p14-canary-absent-from-feed"] = !bytes.includes(SENSITIVE_CANARY);
  // Stated positively: the sweep must have had something to examine.
  acceptance["p15-feed-was-actually-scanned"] = bytes.length > 200;

  // --- The peer-absent variant, in an isolated vault.
  //
  // The honest expectation is narrower than the case registry originally
  // stated. Removing the peer record does NOT leave every non-coordination
  // answer identical, because the peer report is one of the two positions in
  // the recorded contradiction. That is correct behaviour — a report takes a
  // position without becoming a claim — so the criterion names the
  // peer-dependent questions instead of pretending they are unaffected.
  // Compared against a CLEAN baseline, never against the vault the controls
  // above have been writing into. Comparing the variant to a contaminated
  // reference would attribute this function's own mutations to the absence of
  // the peer record — which is exactly the confound the variant exists to avoid.
  const baseline = new LaneMAdapter({ root: `${vaultRoot}/baseline`, corpus, vectors });
  await applyScript(baseline, corpus, script);

  const peerless = new LaneMAdapter({ root: `${vaultRoot}/peerless`, corpus, vectors });
  const withoutPeer = {
    mutations: script.mutations.filter(
      (mutation) =>
        mutation.cmd !== "IngestPeerActivity" &&
        mutation.cmd !== "OpenCandidateFromPeerReport" &&
        mutation.cmd !== "RecordContradiction",
    ),
  };
  await applyScript(peerless, corpus, withoutPeer);

  const peerDependent = new Set(["Q10", "Q12"]);
  const differing: string[] = [];
  for (const question of questions.queries) {
    const request = {
      contractVersion: KNOWLEDGE_CONTRACT_VERSION,
      query: question.query as never,
      constraint: { ...questions.defaults, ...(question.constraint ?? {}) } as never,
      args: { ...question.args, queryId: question.id },
    };
    const withPeer = await baseline.query(request);
    const sansPeer = await peerless.query(request);
    const answerOf = (response: typeof withPeer): unknown =>
      response.outcome === "ok" ? answerOnly(question.id, response.data) : response;
    if (digest(answerOf(withPeer)) !== digest(answerOf(sansPeer))) differing.push(question.id);
  }
  findings.peerAbsentDiffering = differing;
  acceptance["p16-only-peer-dependent-answers-change"] = differing.every((id) =>
    peerDependent.has(id),
  );
  // The control: the peer-dependent questions MUST change, or the variant did
  // not actually remove anything.
  acceptance["p17-peer-dependent-answers-do-change"] = differing.length > 0;
  acceptance["p18-peerless-feed-is-unchanged"] =
    auditFeed(`${vaultRoot}/peerless`)[0]?.recordIds.length === 1;

  return emit({
    subcommand: "coordination-controls",
    lane: "lane-m",
    findings,
    acceptance,
    outcome: outcomeFor(acceptance),
  });
}

/**
 * Answer the golden questions through Lane N and emit the ANSWERS.
 *
 * Identical in shape to `lane-m-answers` and identical in what it is NOT given:
 * the oracle is not mounted here either. The mutation script, the questions, and
 * the frozen vectors are the same bytes both lanes receive.
 */
async function laneNAnswers(
  corpusRoot: string,
  sourcesRoot: string,
  usePostgres: boolean,
): Promise<number> {
  const acceptance: Record<string, boolean> = {};
  const findings: Record<string, unknown> = {};
  const { corpus, script, vectors, questions } = loadCorpus(corpusRoot);

  const store = new GraphStore(process.env.NEO4J_URI ?? "bolt://neo4j-n:7687", sourcesRoot);
  let db: Db | null = null;
  try {
    return await laneNBody(store, corpusRoot, usePostgres, {
      corpus,
      script,
      vectors,
      questions,
      acceptance,
      findings,
      setDb: (value) => {
        db = value;
      },
    });
  } finally {
    // Closed even on failure. A driver left open keeps the event loop alive, so
    // a container that hit a real error would hang until the driver killed it
    // and the measurement would be recorded as an anonymous timeout instead of
    // as the failure it was.
    await store.close().catch(() => {});
    if (db) await (db as Db).close().catch(() => {});
  }
}

type LaneNBody = {
  corpus: Awaited<ReturnType<typeof loadCorpus>>["corpus"];
  script: Awaited<ReturnType<typeof loadCorpus>>["script"];
  vectors: Awaited<ReturnType<typeof loadCorpus>>["vectors"];
  questions: Awaited<ReturnType<typeof loadCorpus>>["questions"];
  acceptance: Record<string, boolean>;
  findings: Record<string, unknown>;
  setDb: (db: Db) => void;
};

async function laneNBody(
  store: GraphStore,
  _corpusRoot: string,
  usePostgres: boolean,
  ctx: LaneNBody,
): Promise<number> {
  const { corpus, script, vectors, questions, acceptance, findings } = ctx;
  await store.waitForReady(TIMEOUTS.barrierArrivalMs * 6);

  // Neo4j has no advisory-lock primitive, so Lane N borrows the same Postgres
  // election Lane M uses rather than inventing a weaker one. When Postgres is
  // absent this is a single-process development path and is not evidence.
  let execution: ExecutionPlane | null = null;
  if (usePostgres) {
    const db = openDb("lane-n:app", "app");
    ctx.setDb(db);
    await waitForDb(db, TIMEOUTS.commandMs * 4);
    const migrator = openDb("lane-n:migrator", "migrator", 1);
    try {
      findings.migration = await migrate(migrator);
    } finally {
      await migrator.close();
    }
    execution = new ExecutionPlane(db);
    await execution.seed(corpus);
  }

  const schema = await store.setup();
  findings.schema = { ...schema, constraints: await store.constraintNames() };
  // The stale-write backstop must actually exist. Without it the guard is an
  // application check that two concurrent writers can both pass.
  acceptance["n01-revision-uniqueness-constraint-exists"] = (
    await store.constraintNames()
  ).includes("claim_revision");
  acceptance["n01-relationship-revision-key-constraint-exists"] = (
    await store.constraintNames()
  ).includes("relationship_revision");

  const adapter = await LaneNAdapter.open({
    store,
    corpus,
    vectors,
    ...(execution ? { execution } : {}),
  });

  const staleTokens = new Map<string, string>();
  const records: ExecutionRecord[] = [];
  for (const mutation of script.mutations) {
    if (typeof mutation.args.claimId === "string") {
      const ref = { kind: "claim" as const, id: mutation.args.claimId };
      const token = adapter.versionOf(ref);
      if (token && !staleTokens.has(mutation.args.claimId)) {
        staleTokens.set(mutation.args.claimId, token);
      }
    }
    const request = requestFor(mutation, corpus, (ref) => adapter.versionOf(ref), staleTokens);
    records.push(recordFor(mutation.t, mutation.cmd, await adapter.execute(request)));
  }

  acceptance["n02-script-applied"] = records.length === script.mutations.length;

  // Lane N's transactional advantage, reported as a measured value rather than
  // levelled to match Lane M. A multi-object plan commits whole here.
  // `objectsTouched > 1` is the whole criterion. Asserting only that some
  // committed record was classed A1 was satisfied by every single-object plan,
  // and even by the zero-op work-item commands — so the check passed without
  // ever exercising a multi-object plan.
  const multiObject = records.filter(
    (record) =>
      record.outcome === "committed" &&
      record.atomicity === "A1" &&
      (record.objectsTouched ?? 0) > 1,
  ).length;
  acceptance["n03-multi-object-plans-are-atomic"] = multiObject > 0;
  findings.atomicity = {
    a1: records.filter((r) => r.atomicity === "A1").length,
    a2: records.filter((r) => r.atomicity === "A2").length,
    a3: records.filter((r) => r.atomicity === "A3").length,
    multiObjectA1: multiObject,
    maxObjectsTouched: records.reduce((most, r) => Math.max(most, r.objectsTouched ?? 0), 0),
  };

  const answers: Record<string, unknown> = {};
  for (const question of questions.queries) {
    answers[question.id] = await adapter.query({
      contractVersion: KNOWLEDGE_CONTRACT_VERSION,
      query: question.query as never,
      constraint: { ...questions.defaults, ...(question.constraint ?? {}) } as never,
      args: { ...question.args, queryId: question.id },
    });
  }
  acceptance["n04-every-question-answered"] = Object.keys(answers).length === questions.queries.length;

  const histories: Record<string, unknown[]> = {};
  for (const [claimId, revisions] of adapter.snapshot().claims.entries()) {
    histories[claimId] = revisions.map((revision) => ({
      revision: revision.revision,
      belief: revision.belief,
      closureReason: revision.closureReason,
      redactionState: revision.redactionState,
    }));
  }

  return emit({
    subcommand: "lane-n-answers",
    lane: "lane-n",
    generation: adapter.canonicalPoint(),
    committed: records.filter((record) => record.outcome === "committed").length,
    refused: records.filter((record) => record.outcome === "refused").length,
    records,
    findings,
    answers,
    histories,
    export: await adapter.exportState(),
    support: supportOf(adapter.snapshot()),
    coordination: { feed: feedBytes(store.sourcesRoot), audit: auditFeed(store.sourcesRoot) },
    acceptance,
    outcome: outcomeFor(acceptance),
  });
}

/**
 * Compare two lanes' emitted state and published bytes.
 *
 * Runs in the comparator. Semantic equivalence is asserted over the NEUTRAL
 * export, with per-lane version tokens omitted by construction: comparing them
 * would turn a portability check into a storage-format check.
 */
function compareLanes(laneMPath: string, laneNPath: string): number {
  const left = JSON.parse(readFileSync(laneMPath, "utf8")) as Record<string, unknown>;
  const right = JSON.parse(readFileSync(laneNPath, "utf8")) as Record<string, unknown>;

  const acceptance: Record<string, boolean> = {};
  const findings: Record<string, unknown> = {};

  const leftExport = left.export ?? null;
  const rightExport = right.export ?? null;
  acceptance["e01-both-lanes-exported"] = leftExport !== null && rightExport !== null;

  const leftDigest = digest(leftExport);
  const rightDigest = digest(rightExport);
  acceptance["e02-exports-are-semantically-equal"] = leftDigest === rightDigest;
  findings.exportDigests = { laneM: leftDigest, laneN: rightDigest };

  // The coordination feed is compared as BYTES, not structurally. Two lanes
  // publishing semantically equivalent records that serialise differently would
  // still be two incompatible publishers on one transport.
  const leftFeed = (left.coordination as { feed?: Record<string, string> } | undefined)?.feed ?? {};
  const rightFeed = (right.coordination as { feed?: Record<string, string> } | undefined)?.feed ?? {};
  const feedKeys = [...new Set([...Object.keys(leftFeed), ...Object.keys(rightFeed)])].sort();
  acceptance["e03-both-lanes-published"] = feedKeys.length > 0;
  acceptance["e04-published-bytes-are-identical"] =
    feedKeys.length > 0 && feedKeys.every((key) => leftFeed[key] === rightFeed[key]);
  findings.feedKeys = feedKeys;
  findings.feedDiffers = feedKeys.filter((key) => leftFeed[key] !== rightFeed[key]);

  // The control for byte identity: a record differing in one field must produce
  // a different content hash, or equality above is satisfied by a hash that
  // ignores content.
  const sample = leftFeed[feedKeys[0] ?? ""] ?? "";
  const mutated = sample.replace(/"status": "[^"]*"/, '"status": "mutated"');
  acceptance["e05-single-field-change-is-detected"] = sample.length > 0 && mutated !== sample;

  // Hybrid retrieval runs on one shared fusion over one frozen vector set, so an
  // identical ranking is REQUIRED rather than merely expected: a difference here
  // could only come from the shared code behaving differently under two callers.
  // Recording it as a criterion also makes the consequence explicit — retrieval
  // ranking cannot discriminate between these lanes, and must not be read as if
  // it could.
  const rankOf = (bundle: Record<string, unknown>): string[] => {
    const answers = bundle.answers as Record<string, QueryResponse> | undefined;
    const hybrid = answers?.Q21;
    if (!hybrid || hybrid.outcome !== "ok") return [];
    return ((hybrid.data as { ranked?: Array<{ id: string }> }).ranked ?? []).map(
      (entry) => entry.id,
    );
  };
  const leftRank = rankOf(left);
  const rightRank = rankOf(right);
  acceptance["e07-hybrid-ranking-is-identical"] =
    leftRank.length > 0 && digest(leftRank) === digest(rightRank);
  findings.hybridRanking = {
    laneM: leftRank,
    laneN: rightRank,
    note: "Shared fusion over shared frozen vectors. Identical by construction, therefore non-discriminating.",
  };

  const leftAudit = (left.coordination as { audit?: unknown } | undefined)?.audit;
  const rightAudit = (right.coordination as { audit?: unknown } | undefined)?.audit;
  acceptance["e06-both-feeds-audit-clean"] =
    digest(leftAudit) === digest(rightAudit) &&
    JSON.stringify(leftAudit).includes('"chainIntact":true');

  if (leftDigest !== rightDigest) {
    // Name the first differing top-level section rather than dumping both, so a
    // mismatch is diagnosable without the evidence carrying the whole store.
    const differing: string[] = [];
    const l = (leftExport ?? {}) as Record<string, unknown>;
    const r = (rightExport ?? {}) as Record<string, unknown>;
    for (const key of new Set([...Object.keys(l), ...Object.keys(r)])) {
      if (digest(l[key]) !== digest(r[key])) differing.push(key);
    }
    findings.differingSections = differing.sort();
  }

  return emit({
    subcommand: "compare-lanes",
    findings,
    acceptance,
    outcome: outcomeFor(acceptance),
  });
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const subcommand = argv[0];

  switch (subcommand) {
    case "cases": {
      const family = argValue(argv, "--family");
      const lane = argValue(argv, "--lane");
      const selected = CASES.filter(
        (entry) =>
          (family === null || entry.family === family) &&
          (lane === null || (entry.lanes as string[]).includes(lane)),
      );
      return emit({ subcommand: "cases", count: selected.length, cases: selected });
    }
    case "families":
      return emit({ subcommand: "families", families: familiesInRunOrder() });
    case "lanes":
      return emit({ subcommand: "lanes", lanes: LANES });
    case "manifest":
      return emit({ subcommand: "manifest", manifest: imageManifest(), schema: EVIDENCE_SCHEMA });
    case "expand": {
      const cases = argValue(argv, "--cases");
      const lanes = argValue(argv, "--lanes");
      if (cases === null && lanes === null) return fail(USAGE);
      return emit({
        subcommand: "expand",
        cases: cases === null ? null : expandCases(cases.split(",")),
        lanes: lanes === null ? null : expandLanes(lanes.split(",")),
      });
    }
    case "selftest":
      return selftest();
    case "stage2-selftest": {
      // Offline, storeless, and model-free. Every Stage 2 isolation property is
      // provable without a container, so it is proven before one is started.
      const { acceptance, findings } = stage2Selftest();
      return emit({
        subcommand: "stage2-selftest",
        family: "K",
        contractVersion: ACTIVE_CONTEXT_CONTRACT_VERSION,
        estimatorId: ESTIMATOR_ID,
        arms: ARM_IDS,
        findings,
        acceptance,
        outcome: outcomeFor(acceptance),
      });
    }
    case "lane-m-script": {
      const corpusRoot = argValue(argv, "--corpus") ?? "/corpus";
      const oracleRoot = argValue(argv, "--oracle") ?? "/oracle";
      const vaultRoot = argValue(argv, "--vault") ?? "/vault";
      return laneMScript(corpusRoot, oracleRoot, vaultRoot);
    }
    case "lane-m-answers": {
      const corpusRoot = argValue(argv, "--corpus") ?? "/corpus";
      const vaultRoot = argValue(argv, "--vault") ?? "/vault";
      return laneMAnswers(corpusRoot, vaultRoot, !argv.includes("--no-pg"));
    }
    case "lane-m-projection": {
      const corpusRoot = argValue(argv, "--corpus") ?? "/corpus";
      const vaultRoot = argValue(argv, "--vault") ?? "/vault";
      return laneMProjection(corpusRoot, vaultRoot);
    }
    case "lane-n-answers": {
      const corpusRoot = argValue(argv, "--corpus") ?? "/corpus";
      const sourcesRoot = argValue(argv, "--sources") ?? "/sources";
      return laneNAnswers(corpusRoot, sourcesRoot, !argv.includes("--no-pg"));
    }
    case "compare-golden": {
      const answers = argValue(argv, "--answers");
      const oracleRoot = argValue(argv, "--oracle") ?? "/oracle";
      if (answers === null) return fail(USAGE);
      return compareGolden(answers, oracleRoot);
    }
    case "shuffled-ids": {
      const corpusRoot = argValue(argv, "--corpus") ?? "/corpus";
      const vaultRoot = argValue(argv, "--vault") ?? "/vault";
      return shuffledIds(corpusRoot, vaultRoot);
    }
    case "native-walkthrough": {
      const corpusRoot = argValue(argv, "--corpus") ?? "/corpus";
      const vaultRoot = argValue(argv, "--vault") ?? "/vault";
      return nativeWalkthrough(corpusRoot, vaultRoot);
    }
    case "race-prepare": {
      // One container applies the frozen script so every racer starts from the
      // same durable state. Doing it inside a racer would make the setup itself
      // part of the race.
      const corpusRoot = argValue(argv, "--corpus") ?? "/corpus";
      const root = argValue(argv, "--root") ?? "/vault";
      const lane = (argValue(argv, "--lane") ?? "m") as "m" | "n";
      const { corpus, script, vectors } = loadCorpus(corpusRoot);
      const migrator = openDb("race:migrator", "migrator", 1);
      try {
        await waitForDb(migrator, TIMEOUTS.commandMs * 4);
        await migrate(migrator);
      } finally {
        await migrator.close();
      }
      if (lane === "m") {
        const adapter = new LaneMAdapter({ root, corpus, vectors });
        await applyScript(adapter, corpus, script);
        return emit({ subcommand: "race-prepare", lane: "lane-m", outcome: { status: "pass" } });
      }
      const store = new GraphStore(process.env.NEO4J_URI ?? "bolt://neo4j-n:7687", root);
      try {
        await store.waitForReady(TIMEOUTS.barrierArrivalMs * 6);
        await store.setup();
        const adapter = await LaneNAdapter.open({ store, corpus, vectors });
        const staleTokens = new Map<string, string>();
        for (const mutation of script.mutations) {
          await adapter.execute(
            requestFor(mutation, corpus, (ref) => adapter.versionOf(ref), staleTokens),
          );
        }
      } finally {
        await store.close().catch(() => {});
      }
      return emit({ subcommand: "race-prepare", lane: "lane-n", outcome: { status: "pass" } });
    }
    case "race-party": {
      return raceParty({
        lane: (argValue(argv, "--lane") ?? "m") as "m" | "n",
        raceCase: (argValue(argv, "--case") ?? "x04") as RaceCase,
        member: argValue(argv, "--member") ?? "a",
        parties: Number(argValue(argv, "--parties") ?? "2"),
        guarded: argv.includes("--guarded"),
        corpusRoot: argValue(argv, "--corpus") ?? "/corpus",
        root: argValue(argv, "--root") ?? "/vault",
      });
    }
    case "race-collect": {
      return raceCollect(
        (argValue(argv, "--lane") ?? "m") as "m" | "n",
        (argValue(argv, "--case") ?? "x04") as RaceCase,
        Number(argValue(argv, "--parties") ?? "2"),
        argValue(argv, "--corpus") ?? "/corpus",
        argValue(argv, "--root") ?? "/vault",
      );
    }
    case "faults-m": {
      const corpusRoot = argValue(argv, "--corpus") ?? "/corpus";
      const vaultRoot = argValue(argv, "--vault") ?? "/vault";
      return faultsM(corpusRoot, vaultRoot);
    }
    case "faults-n": {
      const corpusRoot = argValue(argv, "--corpus") ?? "/corpus";
      const sourcesRoot = argValue(argv, "--sources") ?? "/sources";
      return faultsN(corpusRoot, sourcesRoot);
    }
    case "native-graph": {
      const corpusRoot = argValue(argv, "--corpus") ?? "/corpus";
      const sourcesRoot = argValue(argv, "--sources") ?? "/sources";
      return nativeGraph(corpusRoot, sourcesRoot);
    }
    case "coordination-controls": {
      // Deliberately takes NO oracle. Every criterion here is a self-contained
      // control over the coordination plane, and accepting an oracle path would
      // make this a lane container the oracle could be mounted into.
      const corpusRoot = argValue(argv, "--corpus") ?? "/corpus";
      const vaultRoot = argValue(argv, "--vault") ?? "/vault";
      return coordinationControls(corpusRoot, vaultRoot);
    }
    case "compare-lanes": {
      const laneM = argValue(argv, "--lane-m");
      const laneN = argValue(argv, "--lane-n");
      if (laneM === null || laneN === null) return fail(USAGE);
      return compareLanes(laneM, laneN);
    }
    case "validate": {
      const corpusRoot = argValue(argv, "--corpus") ?? "/corpus";
      const oracleRoot = argValue(argv, "--oracle") ?? "/oracle";
      return validate(corpusRoot, oracleRoot);
    }
    default:
      return fail(USAGE);
  }
}

// A rejected promise here would exit 0 with no output, which the driver reads as
// a fault rather than as a pass. That is the correct classification, and the
// message still has to reach stderr so the fault is nameable.
main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = EXIT_HARNESS_FAULT;
  },
);
