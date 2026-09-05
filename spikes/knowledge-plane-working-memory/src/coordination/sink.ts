// The coordination sink.
//
// Shared by both lanes on purpose. Step 13 asserts that Lane M and Lane N
// publish BYTE-IDENTICAL records for the same fixture, and two independent
// writers would make that assertion a test of two serialisers rather than of the
// wire format. Sharing the writer means a difference in published bytes can only
// come from a difference in what the lane decided to publish.
//
// Publication deliberately lands outside the knowledge tree in both lanes. A
// published record is not a knowledge write: it can never be reached by a
// knowledge query by accident, and the knowledge generation digest and the
// coordination feed move independently — which is what makes "published after
// committing" an observable, recoverable state rather than a torn one.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { COORDINATION_SCHEMA_VERSION } from "../contract.ts";

export const COORDINATION_ROOT = "coordination";

/** Deterministic key order, so two lanes emitting the same record emit the same bytes. */
function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) out[key] = sortValue(source[key]);
    return out;
  }
  return value;
}

export function canonicalBytes(record: Record<string, unknown>): string {
  return `${JSON.stringify(sortValue(record), null, 2)}\n`;
}

export function contentHashOf(record: Record<string, unknown>): string {
  // Hashed over the record WITHOUT its own hash, or the field would have to
  // contain a hash of itself.
  const { contentHash: _ignored, ...rest } = record;
  return createHash("sha256").update(canonicalBytes(rest)).digest("hex");
}

export type PublishOutcome = "created" | "identical" | "conflict";

/**
 * Write one record into its publisher's own namespace.
 *
 * The publisher is taken from the record id rather than from the caller, so a
 * record can only ever land in the namespace it names — and the command service
 * has already refused any id whose publisher is not this node.
 *
 * Republication is idempotent by content, not by name. Publishing the same
 * record twice yields one file and reports `identical`; publishing a DIFFERENT
 * record under an id that already exists is a rewritten history and is refused,
 * because an append-only feed whose entries can be edited in place is not
 * append-only and every hash chain built on it is decorative.
 */
export function publish(
  root: string,
  recordId: string,
  record: Record<string, unknown>,
): { path: string; contentHash: string; namespaceSeq: number; outcome: PublishOutcome } {
  const publisher = recordId.split("/")[0] ?? "unknown";
  const sequence = recordId.split("/")[1] ?? "0";
  const namespaceSeq = Number(sequence);
  const directory = join(root, COORDINATION_ROOT, publisher);

  // The chain links to the previous record in THIS publisher's namespace only.
  // Chaining across publishers would make one node's feed depend on another's,
  // which is exactly the shared-truth coupling the plane exists to avoid.
  const previousPath = join(directory, `${String(namespaceSeq - 1).padStart(sequence.length, "0")}.json`);
  const prevContentHash =
    namespaceSeq > 1 && existsSync(previousPath)
      ? String(
          (JSON.parse(readFileSync(previousPath, "utf8")) as { contentHash?: string }).contentHash ??
            "",
        )
      : null;

  const complete = {
    ...record,
    schemaVersion: COORDINATION_SCHEMA_VERSION,
    recordId,
    publisherNodeId: publisher,
    namespaceSeq,
    prevContentHash,
  };
  const body = { ...complete, contentHash: contentHashOf(complete) };
  const bytes = canonicalBytes(body);
  const path = join(directory, `${sequence}.json`);

  if (existsSync(path)) {
    const existing = readFileSync(path, "utf8");
    return {
      path,
      contentHash: String(body.contentHash),
      namespaceSeq,
      outcome: existing === bytes ? "identical" : "conflict",
    };
  }

  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, bytes, "utf8");
  renameSync(temporary, path);
  return { path, contentHash: String(body.contentHash), namespaceSeq, outcome: "created" };
}

export type FeedAudit = {
  publisher: string;
  recordIds: string[];
  /** Sequence numbers start at 1 and have no gaps. */
  sequenceContiguous: boolean;
  /** Each record's `prevContentHash` equals its predecessor's `contentHash`. */
  chainIntact: boolean;
  /** Every record in this directory names this publisher in its own id. */
  namespaceOwned: boolean;
  /** Every record's stored hash matches a recomputation over its own content. */
  hashesVerify: boolean;
};

/**
 * Audit a feed without trusting anything it says about itself.
 *
 * Each property is checked against the bytes rather than against a claim made
 * inside them: a feed that asserted its own integrity would be worth nothing.
 */
export function auditFeed(root: string): FeedAudit[] {
  const base = join(root, COORDINATION_ROOT);
  if (!existsSync(base)) return [];
  const audits: FeedAudit[] = [];

  for (const publisher of readdirSync(base).sort()) {
    const directory = join(base, publisher);
    if (!statSync(directory).isDirectory()) continue;
    const files = readdirSync(directory)
      .filter((name) => name.endsWith(".json"))
      .sort();
    const records = files.map(
      (name) => JSON.parse(readFileSync(join(directory, name), "utf8")) as Record<string, unknown>,
    );

    let sequenceContiguous = true;
    let chainIntact = true;
    let namespaceOwned = true;
    let hashesVerify = true;

    for (let index = 0; index < records.length; index += 1) {
      const record = records[index];
      if (!record) continue;
      if (Number(record.namespaceSeq) !== index + 1) sequenceContiguous = false;
      if (!String(record.recordId).startsWith(`${publisher}/`)) namespaceOwned = false;
      const { contentHash, ...rest } = record;
      if (contentHashOf(rest) !== contentHash) hashesVerify = false;
      const expectedPrev = index === 0 ? null : String(records[index - 1]?.contentHash ?? "");
      if ((record.prevContentHash ?? null) !== expectedPrev) chainIntact = false;
    }

    audits.push({
      publisher,
      recordIds: records.map((record) => String(record.recordId)),
      sequenceContiguous,
      chainIntact,
      namespaceOwned,
      hashesVerify,
    });
  }

  return audits;
}

/** Raw bytes of every record, so two lanes' feeds can be compared exactly. */
export function feedBytes(root: string): Record<string, string> {
  const base = join(root, COORDINATION_ROOT);
  const out: Record<string, string> = {};
  if (!existsSync(base)) return out;
  for (const publisher of readdirSync(base).sort()) {
    const directory = join(base, publisher);
    if (!statSync(directory).isDirectory()) continue;
    for (const name of readdirSync(directory).sort()) {
      if (!name.endsWith(".json")) continue;
      out[`${publisher}/${name}`] = readFileSync(join(directory, name), "utf8");
    }
  }
  return out;
}

export function readAll(root: string): Map<string, Record<string, unknown>> {
  const out = new Map<string, Record<string, unknown>>();
  const base = join(root, COORDINATION_ROOT);
  if (!existsSync(base)) return out;
  for (const publisher of readdirSync(base).sort()) {
    const directory = join(base, publisher);
    if (!statSync(directory).isDirectory()) continue;
    for (const name of readdirSync(directory).sort()) {
      if (!name.endsWith(".json")) continue;
      const record = JSON.parse(readFileSync(join(directory, name), "utf8")) as Record<
        string,
        unknown
      >;
      out.set(`${publisher}/${name.replace(/\.json$/, "")}`, record);
    }
  }
  return out;
}
