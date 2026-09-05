// The knowledge state a scorer needs to see.
//
// Scoring "was this agent entitled to assert that?" is impossible from a prose
// summary. The scorer needs the record: which revision is head, what it
// superseded and why, what evidence backs it, and whether a human canonized it.
// A summary that says "2.0.0 has shipped" hides the only thing that matters —
// whether 2.0.0 is a reconciled local claim or a peer's unverified report.
//
// Cards are DERIVED from the frozen mutation script rather than authored beside
// it, so they cannot drift from the corpus they claim to describe. The self-test
// checks each derived head value against the script directly.

import { readFileSync } from "node:fs";
import { join } from "node:path";

export type EvidenceCite =
  | { kind: "source"; sourceRefId: string; locator: string }
  | { kind: "peer"; peerRecordId: string };

export type CardRevision = {
  revision: number;
  value: string;
  belief: string;
  canon: boolean;
  validFrom: string | null;
  validTo: string | null;
  /** Why belief in THIS revision ended. `null` while it is head. */
  closureReason: string | null;
  evidence: EvidenceCite[];
};

export type KnowledgeCard = {
  claimId: string;
  subject: string;
  predicate: string;
  revisions: CardRevision[];
};

type Mutation = { t: number; cmd: string; args: Record<string, unknown> };

function citesOf(args: Record<string, unknown>): EvidenceCite[] {
  const raw = (args.evidence ?? []) as Array<Record<string, unknown>>;
  return raw.map((entry) =>
    entry.peerRecordId !== undefined
      ? { kind: "peer" as const, peerRecordId: String(entry.peerRecordId) }
      : {
          kind: "source" as const,
          sourceRefId: String(entry.sourceRefId),
          locator: String(entry.locator ?? ""),
        },
  );
}

/**
 * Replay the frozen script into per-claim revision chains.
 *
 * Deliberately narrow: it covers only the lifecycle verbs the calibration
 * scenarios exercise. It is a RENDERING aid, not a second implementation of the
 * command service — nothing here decides anything, and the self-test pins its
 * output against the script it was derived from.
 */
export function buildCards(corpusRoot: string): Map<string, KnowledgeCard> {
  const script = JSON.parse(
    readFileSync(join(corpusRoot, "mutations.json"), "utf8"),
  ) as { mutations: Mutation[] };

  const cards = new Map<string, KnowledgeCard>();

  for (const mutation of script.mutations) {
    const args = mutation.args;
    const claimId = String(args.claimId ?? "");
    if (claimId === "") continue;

    const existing = cards.get(claimId);

    switch (mutation.cmd) {
      case "CreateClaim": {
        cards.set(claimId, {
          claimId,
          subject: String(args.subject ?? ""),
          predicate: String(args.predicate ?? ""),
          revisions: [
            {
              revision: 1,
              value: String(args.value ?? ""),
              belief: "active",
              canon: false,
              validFrom: (args.validFrom as string | null) ?? null,
              validTo: (args.validTo as string | null) ?? null,
              closureReason: null,
              evidence: citesOf(args),
            },
          ],
        });
        break;
      }

      case "SupersedeClaim":
      case "CorrectClaim": {
        if (!existing) break;
        const head = existing.revisions[existing.revisions.length - 1];
        if (!head) break;
        // The distinction the whole temporal model rests on: world progression
        // narrows the prior interval and leaves it true of that interval; a
        // correction says we were wrong about the same interval.
        const worldChange = mutation.cmd === "SupersedeClaim";
        head.closureReason = worldChange ? "world_progressed" : "corrected";
        head.belief = "superseded";
        if (worldChange) head.validTo = (args.worldChangeAt as string | null) ?? head.validTo;
        existing.revisions.push({
          revision: head.revision + 1,
          value: String(args.value ?? ""),
          belief: "active",
          // Canon does not survive a content change; it must be re-established.
          canon: false,
          validFrom: worldChange ? ((args.worldChangeAt as string | null) ?? null) : head.validFrom,
          validTo: null,
          closureReason: null,
          evidence: citesOf(args),
        });
        break;
      }

      case "ReinforceClaim": {
        if (!existing) break;
        const head = existing.revisions[existing.revisions.length - 1];
        if (!head) break;
        head.evidence = [...head.evidence, ...citesOf(args)];
        break;
      }

      case "CanonizeClaim": {
        if (!existing) break;
        const head = existing.revisions[existing.revisions.length - 1];
        if (head) head.canon = true;
        break;
      }

      case "RetractClaim": {
        if (!existing) break;
        const head = existing.revisions[existing.revisions.length - 1];
        if (head) {
          head.belief = "retracted";
          head.closureReason = "retracted";
          head.canon = false;
        }
        break;
      }

      default:
        break;
    }
  }

  return cards;
}

export function headOf(card: KnowledgeCard): CardRevision | null {
  return card.revisions[card.revisions.length - 1] ?? null;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderEvidence(cites: readonly EvidenceCite[]): string {
  if (cites.length === 0) return "no evidence";
  return cites
    .map((cite) =>
      cite.kind === "peer"
        ? `PEER REPORT ${cite.peerRecordId}`
        : `source ${cite.sourceRefId}${cite.locator ? ` (${cite.locator})` : ""}`,
    )
    .join(", ");
}

/**
 * One claim, whole chain, provenance visible.
 *
 * The head revision is marked because that is what an agent is entitled to
 * assert; superseded revisions are shown because whether an older value was
 * "wrong" is a question several scenarios turn on.
 */
export function renderCard(card: KnowledgeCard): string {
  const lines: string[] = [`${card.claimId}  (${card.subject} ${card.predicate})`];
  for (const revision of card.revisions) {
    const isHead = revision === card.revisions[card.revisions.length - 1];
    const marks: string[] = [];
    if (isHead) marks.push("HEAD");
    if (revision.canon) marks.push("CANON — established by human decision");
    if (revision.closureReason) marks.push(`closed: ${revision.closureReason}`);
    lines.push(
      `  rev ${revision.revision}: "${revision.value}"  [${revision.belief}]${
        marks.length ? `  <${marks.join(" | ")}>` : ""
      }`,
    );
    lines.push(
      `    valid ${revision.validFrom ?? "-"} .. ${revision.validTo ?? "open"}   evidence: ${renderEvidence(revision.evidence)}`,
    );
  }
  return lines.join("\n");
}

export function renderCards(cards: readonly KnowledgeCard[]): string {
  if (cards.length === 0) return "KNOWLEDGE AVAILABLE TO THE AGENT\n  (none relevant)";
  return ["KNOWLEDGE AVAILABLE TO THE AGENT", ...cards.map((card) => renderCard(card))].join("\n");
}
