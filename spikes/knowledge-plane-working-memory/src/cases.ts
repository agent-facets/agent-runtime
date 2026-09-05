// The case registry.
//
// A case declares what it needs BEFORE it runs: which oracles must be present in
// its bundle, which control must fail for its own named reason, how many parties
// it launches, and where a fault is anchored. Declaring oracles up front is what
// makes anti-tautology structural rather than a per-criterion habit — the
// summariser refuses to compute acceptance for a case whose declared oracles are
// missing from its bundle.

import type { FamilyId } from "./families.ts";
import type { LaneId } from "./lanes.ts";

/**
 * An oracle is an independently observable fact the case's claim rests on.
 *
 * `probe-witness`   a row written on a connection the subject does not own
 * `barrier-overlap` arrival records proving parties genuinely overlapped
 * `park-anchor`     the durable state a fault was released from
 * `typed-error`     a contract error code, present rather than merely truthy
 * `receipt`         a commit receipt with a non-empty effect set
 * `oracle-answer`   the independently authored expected answer for a query
 * `canonical-state` a direct read of canonical state, not of a projection
 * `freshness`       a freshness block accompanying every answer
 * `store-identity`  server-reported store identity, not a container id
 * `scan`            a canary and secret sweep over the produced artifacts
 */
export type OracleId =
  | "probe-witness"
  | "barrier-overlap"
  | "park-anchor"
  | "typed-error"
  | "receipt"
  | "oracle-answer"
  | "canonical-state"
  | "freshness"
  | "store-identity"
  | "scan";

/**
 * `deterministic` the outcome is a value and any variation is a defect.
 * `bounded-trials` the outcome is a SET. Nothing loops the participant body, so
 *                  a trial is one isolated repeat and n = 3. An unsampled
 *                  outcome is unsampled, never impossible, and these cases are
 *                  excluded from every digest by construction.
 */
export type Classification = "deterministic" | "bounded-trials";

export type StackAction =
  | "none"
  | "graceful-restart"
  | "unclean-kill"
  | "replace-stack"
  | "fresh-volume"
  | "offline-dump-restore"
  | "drop-derived"
  | "portable-export-import";

export type SpikeCase = {
  id: string;
  family: FamilyId;
  lanes: LaneId[];
  purpose: string;
  /** Concurrent participants, each its own container and its own process. */
  parties: number;
  classification: Classification;
  oracles: OracleId[];
  /** The durable state a fault is released from. Never an elapsed duration. */
  anchor: string | null;
  action: StackAction;
  /** The stock case this one is paired with, if it is a mitigation. */
  pairedWith: string | null;
  /** What must fail, and for what named reason, or the case proves nothing. */
  control: string | null;
  budgetMs: number;
  /**
   * Whether this case is actually EXECUTED by the driver.
   *
   * Six registered cases had no runner at all, and nothing detected it: the
   * cross-repeat reduction only combines criteria that were declared, so a case
   * that never ran lowered no score and left no trace. The registry ships in the
   * evidence, so a reader saw a declared case and reasonably inferred coverage
   * that did not exist. `unrun` makes the absence explicit and checkable, and
   * every one of them is listed as an accepted limitation in the report.
   */
  status: "measured" | "unrun";
  /** Why an unrun case is unrun. Required when `status` is `unrun`. */
  unrunReason: string | null;
};

const BOTH: LaneId[] = ["lane-m", "lane-n"];

export const CASES: SpikeCase[] = [
  // --- K: apparatus self-test ------------------------------------------------
  {
    id: "k01-pins",
    family: "K",
    lanes: ["selftest"],
    purpose: "Installed tree, lockfile version and integrity, and fixture manifest all agree.",
    parties: 1,
    classification: "deterministic",
    oracles: ["scan"],
    anchor: null,
    action: "none",
    pairedWith: null,
    control: "A deliberately mismatched expectation must report a non-matching pin.",
    budgetMs: 30_000,
    status: "measured",
    unrunReason: null,
  },
  {
    id: "k02-contract-neutrality",
    family: "K",
    lanes: ["selftest"],
    purpose:
      "The knowledge contract module imports no store driver, filesystem, or network client.",
    parties: 1,
    classification: "deterministic",
    oracles: ["canonical-state"],
    anchor: null,
    action: "none",
    pairedWith: null,
    control: "A synthetic module containing a driver import must be detected.",
    budgetMs: 30_000,
    status: "measured",
    unrunReason: null,
  },
  {
    id: "k03-canonicaliser",
    family: "K",
    lanes: ["selftest"],
    purpose:
      "Volatile values are tokenised or dropped; belief, error, freshness, and version fields are not.",
    parties: 1,
    classification: "deterministic",
    oracles: ["canonical-state"],
    anchor: null,
    action: "none",
    pairedWith: null,
    control:
      "Two payloads differing only in a belief state must digest differently; two differing only in a wall clock must not.",
    budgetMs: 30_000,
    status: "measured",
    unrunReason: null,
  },
  {
    id: "k04-sanitizer",
    family: "K",
    lanes: ["selftest"],
    purpose: "A planted secret and the sensitive canary are both caught before emission.",
    parties: 1,
    classification: "deterministic",
    oracles: ["scan"],
    anchor: null,
    action: "none",
    pairedWith: null,
    control: "A clean payload must produce zero hits.",
    budgetMs: 30_000,
    status: "measured",
    unrunReason: null,
  },
  {
    id: "k05-empty-acceptance",
    family: "K",
    lanes: ["selftest"],
    purpose: "An empty acceptance map is a fault, not a pass.",
    parties: 1,
    classification: "deterministic",
    oracles: ["canonical-state"],
    anchor: null,
    action: "none",
    pairedWith: null,
    control: "A populated all-true map must still pass.",
    budgetMs: 30_000,
    status: "measured",
    unrunReason: null,
  },

  // --- C: contract conformance ----------------------------------------------
  {
    id: "c01-mutation-sequence",
    family: "C",
    lanes: BOTH,
    purpose: "The full fixed mutation script applies with the expected successes and refusals.",
    parties: 1,
    classification: "deterministic",
    oracles: ["receipt", "typed-error", "canonical-state", "oracle-answer"],
    anchor: null,
    action: "none",
    pairedWith: null,
    control: "A malformed twin of each accepted command must be refused.",
    budgetMs: 300_000,
    status: "measured",
    unrunReason: null,
  },
  {
    id: "c02-idempotent-replay",
    family: "C",
    lanes: BOTH,
    purpose: "Replaying a committed idempotency key returns the stored receipt without re-executing.",
    parties: 1,
    classification: "deterministic",
    oracles: ["receipt", "probe-witness"],
    anchor: null,
    action: "none",
    pairedWith: null,
    control: "A different payload under the same key must be refused as key reuse.",
    budgetMs: 60_000,
    status: "measured",
    unrunReason: null,
  },
  {
    id: "c03-scope-exceeded",
    family: "C",
    lanes: BOTH,
    purpose: "A command whose computed effects exceed the declared blast radius is refused.",
    parties: 1,
    classification: "deterministic",
    oracles: ["typed-error"],
    anchor: null,
    action: "none",
    pairedWith: null,
    control: "The same command with an adequate declared scope must commit.",
    budgetMs: 60_000,
    status: "measured",
    unrunReason: null,
  },
  {
    id: "c04-authority-gate",
    family: "C",
    lanes: BOTH,
    purpose:
      "Canonization is refused for a non-human actor and for a delegated agent without a decision.",
    parties: 1,
    classification: "deterministic",
    oracles: ["typed-error", "canonical-state"],
    anchor: null,
    action: "none",
    pairedWith: null,
    control: "A human decision must canonize successfully.",
    budgetMs: 60_000,
    status: "measured",
    unrunReason: null,
  },
  {
    id: "c05-evidence-required",
    family: "C",
    lanes: BOTH,
    purpose: "A claim with no evidence reaching a source is refused at write time.",
    parties: 1,
    classification: "deterministic",
    oracles: ["typed-error", "canonical-state"],
    anchor: null,
    action: "none",
    pairedWith: null,
    control: "The same claim with one evidence link must commit.",
    budgetMs: 60_000,
    status: "measured",
    unrunReason: null,
  },
  {
    id: "c06-sensitive-admission",
    family: "C",
    lanes: BOTH,
    purpose:
      "The sensitive candidate is refused before persistence and leaves only a contentless rejection record.",
    parties: 1,
    classification: "deterministic",
    oracles: ["typed-error", "canonical-state", "scan"],
    anchor: null,
    action: "none",
    pairedWith: null,
    control: "The two admissible candidates from the same source must persist.",
    budgetMs: 60_000,
    status: "measured",
    unrunReason: null,
  },

  // --- T: temporal, provenance, lifecycle ------------------------------------
  {
    id: "t01-world-progression",
    family: "T",
    lanes: BOTH,
    purpose: "A fact that changes over valid time keeps every prior revision true of its interval.",
    parties: 1,
    classification: "deterministic",
    oracles: ["oracle-answer", "canonical-state"],
    anchor: null,
    action: "none",
    pairedWith: null,
    control: "The as-of answer before the change must differ from the answer after it.",
    budgetMs: 120_000,
    status: "measured",
    unrunReason: null,
  },
  {
    id: "t02-correction-vs-progression",
    family: "T",
    lanes: BOTH,
    purpose:
      "A corrected claim answers the world-time query for its original interval while the wrong belief stays retrievable at transaction time.",
    parties: 1,
    classification: "deterministic",
    oracles: ["oracle-answer", "canonical-state"],
    anchor: null,
    action: "none",
    pairedWith: null,
    control:
      "The believed-at answer and the valid-at answer must differ for the same instant, or the lane has one time axis.",
    budgetMs: 120_000,
    status: "measured",
    unrunReason: null,
  },
  {
    id: "t03-summary-rollup",
    family: "T",
    lanes: BOTH,
    purpose:
      "A summary supersedes three still-valid observations without invalidating or deleting them.",
    parties: 1,
    classification: "deterministic",
    oracles: ["oracle-answer", "canonical-state"],
    anchor: null,
    action: "none",
    pairedWith: null,
    control: "Including summarised claims must return all four; excluding them must return one.",
    budgetMs: 120_000,
    status: "measured",
    unrunReason: null,
  },
  {
    id: "t04-contradiction-no-winner",
    family: "T",
    lanes: BOTH,
    purpose: "A recorded contradiction leaves both members individually readable and unranked.",
    parties: 1,
    classification: "deterministic",
    oracles: ["oracle-answer", "canonical-state"],
    anchor: null,
    action: "none",
    pairedWith: null,
    control: "A resolved conflict must produce exactly one upheld member and a decision record.",
    budgetMs: 120_000,
    status: "measured",
    unrunReason: null,
  },
  {
    id: "t05-provenance-closure",
    family: "T",
    lanes: BOTH,
    purpose: "Every claim and relationship reaches evidence and a source reference.",
    parties: 1,
    classification: "deterministic",
    oracles: ["oracle-answer", "canonical-state"],
    anchor: null,
    action: "none",
    pairedWith: null,
    control: "A synthetic dangling evidence link must be reported as a broken chain.",
    budgetMs: 120_000,
    status: "measured",
    unrunReason: null,
  },
  {
    id: "t06-alias-merge",
    family: "T",
    lanes: BOTH,
    purpose: "Merging aliases preserves every inbound relationship and keeps the old id resolvable.",
    parties: 1,
    classification: "deterministic",
    oracles: ["oracle-answer", "canonical-state"],
    anchor: null,
    action: "none",
    pairedWith: null,
    control: "A merge that intentionally drops one inbound edge must be caught.",
    budgetMs: 120_000,
    status: "measured",
    unrunReason: null,
  },
  {
    id: "t07-retraction",
    family: "T",
    lanes: BOTH,
    purpose:
      "A sensitive retraction removes content from every readable surface while the tombstone survives.",
    parties: 1,
    classification: "deterministic",
    oracles: ["canonical-state", "scan"],
    anchor: null,
    action: "none",
    pairedWith: null,
    control:
      "An ordinary incorrect-claim retraction must keep its text visible in historical queries.",
    budgetMs: 120_000,
    status: "measured",
    unrunReason: null,
  },

  // --- Q: query and retrieval ------------------------------------------------
  {
    id: "q01-golden-queries",
    family: "Q",
    lanes: BOTH,
    purpose: "All golden queries answered from canonical state against the frozen oracle.",
    parties: 1,
    classification: "deterministic",
    oracles: ["oracle-answer", "freshness", "canonical-state"],
    anchor: null,
    action: "none",
    pairedWith: null,
    control: "The null-corpus variant must answer empty or unknown for every question.",
    budgetMs: 300_000,
    status: "measured",
    unrunReason: null,
  },
  {
    id: "q02-path-depth",
    family: "Q",
    lanes: BOTH,
    purpose: "Temporally constrained multi-hop paths at an identical, frozen depth cap.",
    parties: 1,
    classification: "deterministic",
    oracles: ["oracle-answer", "canonical-state"],
    anchor: null,
    action: "none",
    pairedWith: null,
    control:
      "The same query at an earlier world time must include the removed shortcut; a lane returning both identically has ignored edge validity.",
    budgetMs: 180_000,
    status: "measured",
    unrunReason: null,
  },
  {
    id: "q03-hybrid-retrieval",
    family: "Q",
    lanes: BOTH,
    purpose: "Hybrid retrieval over identical frozen vectors, scored against frozen judgments.",
    parties: 1,
    classification: "deterministic",
    oracles: ["oracle-answer"],
    anchor: null,
    action: "none",
    pairedWith: null,
    control:
      "Superseded, retracted, and unpromoted peer material appearing in the top ten must be counted as harmful, not neutral.",
    budgetMs: 180_000,
    status: "measured",
    unrunReason: null,
  },
  {
    id: "q04-shuffled-ids",
    family: "Q",
    lanes: BOTH,
    purpose: "A fixed permutation of fixture ids must not change any answer.",
    parties: 1,
    classification: "deterministic",
    oracles: ["oracle-answer"],
    anchor: null,
    action: "none",
    pairedWith: null,
    control: "The inverse permutation must reproduce the original answers exactly.",
    budgetMs: 180_000,
    status: "measured",
    unrunReason: null,
  },

  // --- P: coordination -------------------------------------------------------
  {
    id: "p01-publish-identical",
    family: "P",
    lanes: BOTH,
    purpose: "Both lanes emit byte-identical records for the same fixture.",
    parties: 1,
    classification: "deterministic",
    oracles: ["oracle-answer", "canonical-state"],
    anchor: null,
    action: "none",
    pairedWith: null,
    control: "A record differing in one field must produce a different content hash.",
    budgetMs: 120_000,
    status: "measured",
    unrunReason: null,
  },
  {
    id: "p02-non-promotion",
    family: "P",
    lanes: BOTH,
    purpose:
      "A false peer claim never becomes a local claim, while its valid output link stays citable.",
    parties: 1,
    classification: "deterministic",
    oracles: ["canonical-state", "typed-error"],
    anchor: null,
    action: "none",
    pairedWith: null,
    control:
      "The same record reconciled through a recorded human decision MUST become local truth, or non-promotion is an inability rather than a policy.",
    budgetMs: 120_000,
    status: "measured",
    unrunReason: null,
  },
  {
    id: "p03-namespace-ownership",
    family: "P",
    lanes: BOTH,
    purpose: "A publisher cannot write outside its own namespace, and republication is idempotent.",
    parties: 1,
    classification: "deterministic",
    oracles: ["typed-error", "canonical-state"],
    anchor: null,
    action: "none",
    pairedWith: null,
    control: "A rewritten peer history must be quarantined rather than ingested.",
    budgetMs: 120_000,
    status: "measured",
    unrunReason: null,
  },
  {
    id: "p04-peer-absent-variant",
    family: "P",
    lanes: BOTH,
    purpose:
      "Removing every peer record must leave all non-coordination answers byte-identical.",
    parties: 1,
    classification: "deterministic",
    oracles: ["oracle-answer"],
    anchor: null,
    action: "none",
    pairedWith: null,
    control: "Coordination answers must become empty in the same run.",
    budgetMs: 120_000,
    status: "measured",
    unrunReason: null,
  },

  // --- N: native correction --------------------------------------------------
  {
    id: "n01-operator-walkthrough",
    family: "N",
    lanes: BOTH,
    purpose:
      "Each of the seven correction operations is completed through the contract and verified in a native read surface.",
    parties: 1,
    classification: "deterministic",
    oracles: ["receipt", "canonical-state"],
    anchor: null,
    action: "none",
    pairedWith: null,
    control: "Every operation records an actor and a rationale, or the walkthrough is unattributed.",
    budgetMs: 600_000,
    status: "measured",
    unrunReason: null,
  },
  {
    id: "n02-stale-native-write",
    family: "N",
    lanes: BOTH,
    purpose:
      "A native write prepared against stale state, released after a newer guarded update, is rejected or detected.",
    parties: 2,
    classification: "deterministic",
    oracles: ["park-anchor", "probe-witness", "typed-error", "canonical-state"],
    anchor: "native writer parked on a durable row after reading the pre-update version",
    action: "none",
    pairedWith: null,
    control: "The same native write with no intervening update must succeed.",
    budgetMs: 180_000,
    status: "measured",
    unrunReason: null,
  },

  // --- X: concurrency, crash, stale writes ------------------------------------
  {
    id: "x01-first-setup-race",
    family: "X",
    lanes: BOTH,
    purpose: "Four workers attempt first setup simultaneously.",
    parties: 4,
    classification: "bounded-trials",
    oracles: ["barrier-overlap", "probe-witness", "typed-error"],
    anchor: "four durable arrivals recorded before any party is released",
    action: "fresh-volume",
    pairedWith: null,
    control: "A serial single-setup baseline must produce the identical terminal schema.",
    budgetMs: 300_000,
    status: "unrun",
    unrunReason:
      "Barrier supports four parties; the driver launches two. Never executed.",
  },
  {
    id: "x02-first-setup-guarded",
    family: "X",
    lanes: ["lane-m-guarded"],
    purpose: "The elected single migrator eliminates the setup race.",
    parties: 4,
    classification: "deterministic",
    oracles: ["barrier-overlap", "probe-witness"],
    anchor: "four durable arrivals recorded before any party is released",
    action: "fresh-volume",
    pairedWith: "x01-first-setup-race",
    control: "The stock case must show the failure this one removes.",
    budgetMs: 300_000,
    status: "unrun",
    unrunReason:
      "Paired with the unrun x01, so the safeguard has nothing to be shown fixing.",
  },
  {
    id: "x03-duplicate-entity",
    family: "X",
    lanes: BOTH,
    purpose: "Two writers create the same entity from the same absent-state read.",
    parties: 2,
    classification: "bounded-trials",
    oracles: ["barrier-overlap", "probe-witness", "canonical-state", "typed-error"],
    anchor: "both parties parked after reading the entity as absent",
    action: "none",
    pairedWith: null,
    control:
      "A sequential control must produce exactly one entity; with uniqueness disabled a duplicate must appear, proving the detector sees duplicates.",
    budgetMs: 180_000,
    status: "measured",
    unrunReason: null,
  },
  {
    id: "x04-stale-claim-update",
    family: "X",
    lanes: BOTH,
    purpose: "Two writers correct one claim from the same observed version.",
    parties: 2,
    classification: "deterministic",
    oracles: ["barrier-overlap", "probe-witness", "typed-error", "canonical-state"],
    anchor: "both parties parked holding the same version token",
    action: "none",
    pairedWith: null,
    control:
      "The surviving revision's content and its provenance must belong to the same writer, or the lane tore a mutation across objects.",
    budgetMs: 180_000,
    status: "measured",
    unrunReason: null,
  },
  {
    id: "x05-crash-during-supersession",
    family: "X",
    lanes: BOTH,
    purpose: "The process dies between creating the superseding claim and closing the superseded one.",
    parties: 1,
    classification: "deterministic",
    oracles: ["park-anchor", "probe-witness", "canonical-state"],
    anchor: "durable park written after the new revision and before the closure",
    action: "unclean-kill",
    pairedWith: null,
    control:
      "A kill placed after the commit returned must leave the effect intact, or absence cannot be attributed to rollback.",
    budgetMs: 300_000,
    status: "measured",
    unrunReason: null,
  },
  {
    id: "x06-crash-during-merge",
    family: "X",
    lanes: BOTH,
    purpose: "The process dies between repointing inbound references and tombstoning the alias.",
    parties: 1,
    classification: "deterministic",
    oracles: ["park-anchor", "probe-witness", "canonical-state"],
    anchor: "durable park written after the repoint and before the tombstone",
    action: "unclean-kill",
    pairedWith: null,
    control: "No inbound relationship may be lost after the declared repair runs.",
    budgetMs: 300_000,
    status: "unrun",
    unrunReason:
      "No merge-interruption runner exists. The x05 supersession crash is the only crash measured.",
  },
  {
    id: "x07-store-restart-mid-write",
    family: "X",
    lanes: BOTH,
    purpose: "The canonical store is destroyed while a write is genuinely in flight.",
    parties: 2,
    classification: "bounded-trials",
    oracles: ["probe-witness", "store-identity", "canonical-state"],
    anchor: "an observed in-flight write, not an elapsed interval",
    action: "replace-stack",
    pairedWith: null,
    control:
      "The same procedure onto a fresh volume must produce empty state, so recovery is attributed to the volume rather than to the image.",
    budgetMs: 600_000,
    status: "unrun",
    unrunReason:
      "Requires killing a live store mid-write. Deliberately deferred; see the report's accepted limitations.",
  },
  {
    id: "x08-publish-fails-after-commit",
    family: "X",
    lanes: BOTH,
    purpose: "Coordination publication fails after knowledge has committed.",
    parties: 1,
    classification: "deterministic",
    oracles: ["probe-witness", "canonical-state", "typed-error"],
    anchor: "the knowledge commit witnessed by the probe before publication is failed",
    action: "none",
    pairedWith: null,
    control: "A successful publication must produce exactly one record on replay.",
    budgetMs: 180_000,
    status: "measured",
    unrunReason: null,
  },
  {
    id: "x09-projection-fails-after-commit",
    family: "X",
    lanes: BOTH,
    purpose: "A derived structure fails to update after canonical state has committed.",
    parties: 1,
    classification: "deterministic",
    oracles: ["probe-witness", "canonical-state", "freshness"],
    anchor: "the canonical commit witnessed by the probe before the derived write is failed",
    action: "none",
    pairedWith: null,
    control:
      "A successful projection must return unmarked answers, so the stale marking is attributable to the fault.",
    budgetMs: 180_000,
    status: "measured",
    unrunReason: null,
  },
  {
    id: "x10-malformed-input",
    family: "X",
    lanes: BOTH,
    purpose: "A malformed source document and a malformed command are refused with no residue.",
    parties: 1,
    classification: "deterministic",
    oracles: ["typed-error", "canonical-state"],
    anchor: null,
    action: "none",
    pairedWith: null,
    control: "The well-formed twin of each malformed fixture must be accepted.",
    budgetMs: 120_000,
    status: "measured",
    unrunReason: null,
  },

  // --- R: recovery, rebuild, portability -------------------------------------
  {
    id: "r01-derived-rebuild",
    family: "R",
    lanes: BOTH,
    purpose: "Every derived structure is dropped and rebuilt from canonical state alone.",
    parties: 1,
    classification: "deterministic",
    oracles: ["canonical-state", "oracle-answer", "freshness"],
    anchor: null,
    action: "drop-derived",
    pairedWith: null,
    control:
      "A rebuild from a deliberately truncated canonical set must produce a different digest, or the equality check proves nothing.",
    budgetMs: 600_000,
    status: "unrun",
    unrunReason:
      "Lane M's projection rebuild is measured under family D; no lane-N counterpart exists because Lane N maintains no derived structure a query reads.",
  },
  {
    id: "r02-native-restore",
    family: "R",
    lanes: BOTH,
    purpose: "Canonical state is backed up and restored into a fresh stack on a fresh volume.",
    parties: 1,
    classification: "deterministic",
    oracles: ["store-identity", "canonical-state", "oracle-answer"],
    anchor: null,
    action: "offline-dump-restore",
    pairedWith: null,
    control: "The fresh stack without a restore must answer empty rather than falsely pass.",
    budgetMs: 900_000,
    status: "unrun",
    unrunReason:
      "Neo4j Community requires the database stopped to dump. Deliberately deferred; the recovery dimension therefore has no duration.",
  },
  {
    id: "r03-portable-export",
    family: "R",
    lanes: BOTH,
    purpose: "A versioned neutral export is imported into fresh state and compared structurally.",
    parties: 1,
    classification: "deterministic",
    oracles: ["canonical-state", "oracle-answer"],
    anchor: null,
    action: "portable-export-import",
    pairedWith: null,
    control: "An export with one evidence link removed must fail the comparison.",
    budgetMs: 900_000,
    status: "measured",
    unrunReason: null,
  },
];

export function caseById(id: string): SpikeCase | null {
  return CASES.find((entry) => entry.id === id) ?? null;
}

/** Expand a selection so no mitigation case runs without its stock pair. */
export function expandCases(selected: string[]): string[] {
  const out = new Set<string>();
  for (const id of selected) {
    const entry = caseById(id);
    if (!entry) continue;
    out.add(entry.id);
    if (entry.pairedWith) out.add(entry.pairedWith);
  }
  return [...out];
}

/** A dangling pair, a case with no oracles, or a case with no control is a registry defect. */
export function registryIsSound(): { sound: boolean; problems: string[] } {
  const problems: string[] = [];
  for (const entry of CASES) {
    if (entry.pairedWith && !caseById(entry.pairedWith)) {
      problems.push(`${entry.id}: paired with unknown case ${entry.pairedWith}`);
    }
    if (entry.oracles.length === 0) problems.push(`${entry.id}: declares no oracle`);
    if (entry.control === null) problems.push(`${entry.id}: declares no control`);
    if (entry.status === "unrun" && !entry.unrunReason) {
      problems.push(`${entry.id}: unrun with no stated reason`);
    }
    if (entry.status === "measured" && entry.unrunReason) {
      problems.push(`${entry.id}: measured but carries an unrun reason`);
    }
    if (entry.action !== "none" && entry.anchor === null && entry.parties === 1) {
      // A stack action with no anchor and no concurrency has nothing to hold it
      // in place, which is how a fault ends up timed rather than triggered.
      if (
        entry.action === "unclean-kill" ||
        entry.action === "graceful-restart" ||
        entry.action === "replace-stack"
      ) {
        problems.push(`${entry.id}: destructive action with no durable anchor`);
      }
    }
  }
  return { sound: problems.length === 0, problems };
}
