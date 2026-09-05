// Comparing a lane's answers against the independently authored oracle.
//
// This module runs in the COMPARATOR, which is the only container the oracle is
// ever mounted into. A lane produces answers and never sees what it was supposed
// to produce; the comparison happens afterwards, on a network-less container,
// with no path back to execution.
//
// Every check is stated as a named criterion rather than as a single "matches"
// boolean, so a query that fails says which of its properties failed. A query
// that declares no checks at all is a fixture defect and is reported as one, not
// silently counted as a pass.

import type { QueryResponse } from "./knowledge/contract.ts";
import type { OracleQuery } from "./corpus.ts";

export type GoldenResult = {
  id: string;
  query: string;
  checks: Record<string, boolean>;
  observed: Record<string, unknown>;
  passed: boolean;
};

type Data = Record<string, unknown>;

function dataOf(response: QueryResponse): Data | null {
  return response.outcome === "ok" ? (response.data as Data) : null;
}

function ids(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => {
    if (typeof entry === "string") return entry;
    const record = entry as Record<string, unknown>;
    return String(
      record.claimId ??
        record.contradictionId ??
        record.decisionId ??
        record.recordId ??
        record.id ??
        "",
    );
  });
}

function sameSet(actual: string[], expected: string[]): boolean {
  const left = [...new Set(actual)].sort();
  const right = [...new Set(expected)].sort();
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/** The id list a query's primary answer is carried in. */
function primaryIds(query: OracleQuery, data: Data | null): string[] {
  if (data === null) return [];
  switch (query.query) {
    case "CurrentClaims":
    case "ClaimsAsOf":
    case "BelievedAt":
      return ids(data.claims);
    case "Conflicts":
      return ids(data.conflicts);
    case "StaleDecisions":
      return ids(data.decisions);
    case "Activity":
      return ids(data.recordIds);
    case "Work":
      return data.claims === undefined ? ids(data.attempts) : ids(data.claims);
    case "Provenance":
      return ids(data.offenders);
    default:
      return [];
  }
}

export type HistoryLookup = (claimId: string) => Array<Record<string, unknown>>;

export function checkGolden(
  query: OracleQuery,
  response: QueryResponse,
  historyOf: HistoryLookup,
): GoldenResult {
  const checks: Record<string, boolean> = {};
  const data = dataOf(response);
  const observed: Record<string, unknown> = { outcome: response.outcome };
  const serialized = JSON.stringify(response);

  checks["answered"] = response.outcome === "ok";

  if (Array.isArray(query.expect)) {
    const expected = query.expect as unknown[];
    if (expected.every((entry) => typeof entry === "string")) {
      const actual = primaryIds(query, data);
      observed.ids = actual;
      checks["expected-set"] = sameSet(actual, expected as string[]);
    } else {
      // A sequence of revision shapes, as in the history question, where the
      // ORDER is the answer and must not be sorted away.
      const revisions = (data?.revisions as Array<Record<string, unknown>>) ?? [];
      observed.revisions = revisions;
      checks["expected-sequence"] =
        revisions.length === expected.length &&
        expected.every((entry, index) => {
          const wanted = entry as Record<string, unknown>;
          const got = revisions[index];
          if (!got) return false;
          return Object.entries(wanted).every(([key, value]) => got[key] === value);
        });
    }
  }

  if (query.expectValues) {
    const wanted = query.expectValues as Record<string, string>;
    const claims = (data?.claims as Array<Record<string, unknown>>) ?? [];
    const byId = new Map(claims.map((claim) => [String(claim.claimId), String(claim.value)]));
    observed.values = Object.fromEntries(byId);
    checks["expected-values"] = Object.entries(wanted).every(
      ([claimId, value]) => byId.get(claimId) === value,
    );
  }

  if (query.expectSources) {
    const actual = ids(data?.sources);
    observed.sources = actual;
    checks["expected-sources"] = sameSet(actual, query.expectSources as string[]);
  }

  if (query.expectDerivedFrom) {
    const actual = ids(data?.derivedFrom);
    observed.derivedFrom = actual;
    checks["expected-derived-from"] = sameSet(actual, query.expectDerivedFrom as string[]);
  }

  if (query.expectReached) {
    const actual = ids(data?.reached);
    observed.reached = actual;
    checks["expected-reached"] = sameSet(actual, query.expectReached as string[]);
  }

  if (query.expectShortestLength) {
    const wanted = query.expectShortestLength as Record<string, number>;
    const shortest = (data?.shortest as Record<string, number>) ?? {};
    observed.shortest = shortest;
    checks["expected-shortest"] = Object.entries(wanted).every(
      ([id, length]) => shortest[id] === length,
    );
  }

  if (query.expectAbsent) {
    const absent = query.expectAbsent as string[];
    const pool = new Set([...primaryIds(query, data), ...ids(data?.reached)]);
    observed.absentChecked = absent;
    checks["expected-absent"] = absent.every((id) => !pool.has(id));
  }

  if (query.expectAliasResolution) {
    const wanted = query.expectAliasResolution as Record<string, string>;
    const resolution = (data?.aliasResolution as Record<string, string>) ?? {};
    observed.aliasResolution = resolution;
    checks["expected-alias-resolution"] = Object.entries(wanted).every(
      ([alias, target]) => resolution[alias] === target,
    );
  }

  if (query.expectAttribution === true) {
    const reports = (data?.reports as Array<Record<string, unknown>>) ?? [];
    observed.attributed = reports.map((report) => report.attributedTo);
    // Every report names its publisher, and none of them is a claim. The second
    // half is the one that matters: a promoted report would arrive here looking
    // exactly like an answer.
    checks["expected-attribution"] =
      reports.length > 0 &&
      reports.every((report) => typeof report.attributedTo === "string" && report.promoted === false);
  }

  if (query.expectNoPeerAuthoredClaims === true) {
    const claims = (data?.claims as Array<Record<string, unknown>>) ?? [];
    observed.originKinds = claims.map((claim) => claim.originKind);
    checks["no-peer-authored-claims"] = claims.every(
      (claim) => claim.originKind !== "peer_report",
    );
  }

  if (query.expectAttempts) {
    const actual = ids(data?.attempts);
    observed.attempts = actual;
    const expected = query.expectAttempts as string[];
    // Order is the answer: attempts are a sequence, not a set.
    checks["expected-attempts"] =
      actual.length === expected.length && actual.every((id, index) => id === expected[index]);
  }

  if (query.expectOutputs) {
    const actual = ids(data?.outputs);
    observed.outputs = actual;
    checks["expected-outputs"] = sameSet(actual, query.expectOutputs as string[]);
  }

  if (query.expectTopK) {
    const ranked = (data?.ranked as Array<Record<string, unknown>>) ?? [];
    const order = ranked.map((entry) => String(entry.id));
    observed.ranked = order;
    const wanted = query.expectTopK as string[];
    checks["expected-top-k"] = wanted.every((id, index) => order[index] === id);
  }

  if (query.expectPresent) {
    const order = ((data?.ranked as Array<Record<string, unknown>>) ?? []).map((entry) =>
      String(entry.id),
    );
    const k = Number((query.args as { k?: number }).k ?? 10);
    const top = new Set(order.slice(0, k));
    checks["expected-present"] = (query.expectPresent as string[]).every((id) => top.has(id));
  }

  if (query.expectHarmfulAbsent) {
    const order = ((data?.ranked as Array<Record<string, unknown>>) ?? []).map((entry) =>
      String(entry.id),
    );
    const k = Number((query.args as { k?: number }).k ?? 10);
    const top = new Set(order.slice(0, k));
    // Harmful, not neutral: a retracted claim or an unpromoted peer assertion in
    // the top k is the failure the architecture exists to prevent.
    checks["harmful-absent"] = (query.expectHarmfulAbsent as string[]).every((id) => !top.has(id));
  }

  if (query.expectScalar !== undefined) {
    const scalar = data?.occurrences ?? data?.scalar;
    observed.scalar = scalar;
    checks["expected-scalar"] = scalar === query.expectScalar;
    if (data?.scanned !== undefined) {
      // An audit that examined nothing must not read as a clean audit.
      checks["audit-examined-something"] = Number(data.scanned) > 0;
    }
    if (data?.nodesScanned !== undefined) {
      // A total byte length is not enough on its own: the coordination feed
      // alone kept it above zero while the canonical sweep examined nothing.
      // Where a lane reports per-surface counts, each surface must be non-empty.
      checks["audit-examined-canonical-state"] = Number(data.nodesScanned) > 0;
    }
  }

  if (query.id === "Q19") {
    checks["audit-examined-something"] = Number(data?.examined ?? 0) > 0;
  }

  if (query.expectStaleness) {
    const freshness = response.outcome === "ok" ? response.freshness : null;
    observed.freshness = freshness;
    checks["expected-staleness"] = freshness?.staleness === query.expectStaleness;
  }

  if (query.expectRebuildPending !== undefined) {
    const freshness = response.outcome === "ok" ? response.freshness : null;
    checks["expected-rebuild-pending"] =
      freshness?.rebuildPending === query.expectRebuildPending;
  }

  if (query.expectNoInlinedSourceText) {
    const forbidden = String(query.expectNoInlinedSourceText);
    checks["no-inlined-source-text"] = !serialized.includes(forbidden);
  }

  if (query.expectTombstoneInHistory) {
    checks["tombstone-in-history"] = (query.expectTombstoneInHistory as string[]).every(
      (claimId) => {
        const revisions = historyOf(claimId);
        return revisions.some((revision) => revision.belief === "retracted");
      },
    );
  }

  // A question that asserted nothing beyond having been answered is a fixture
  // defect: it would pass against any lane, including one that returned nothing.
  const substantive = Object.keys(checks).filter((key) => key !== "answered");
  if (substantive.length === 0) checks["declares-a-check"] = false;

  return {
    id: query.id,
    query: query.query,
    checks,
    observed,
    passed: Object.values(checks).every((value) => value === true),
  };
}
