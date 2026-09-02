// The two remaining throwaway safeguards.
//
// Both are in-harness only. Neither is a production module, and neither patches
// or wraps vendor code — they sit in front of it, which is the whole point: a
// mitigation that changed the package would prove the package could be changed,
// not that the architecture can be defended with what ships today.
//
// Each one targets behaviour this spike MEASURED, and nothing else. That
// restraint is enforced by the paired stock case: if a guard eliminated more
// than its stated target, the paired case would stop reproducing its own
// finding.

import { createHash } from "node:crypto";

import type { Db } from "./db.ts";

// ---------------------------------------------------------------------------
// Per-thread lease  (lane `mit-lease`, targets b02)
// ---------------------------------------------------------------------------

/**
 * The one-key `bigint` advisory space.
 *
 * PostgreSQL's `(int, int)` and `bigint` advisory keys are disjoint spaces, and
 * `contract.ts` already spends the two-key form on migrations. Fixing one form
 * per purpose means a thread lease and a migration lock can never collide by
 * arithmetic accident.
 *
 * Derived from a SHA-256 of the thread id rather than a cheap string hash: the
 * key space is 2^63 and collisions here would silently serialise two unrelated
 * threads, which is the one failure a lease must not have.
 */
export function threadLeaseKey(threadId: string): string {
  const digest = createHash("sha256").update(`lease\u0000${threadId}`).digest();
  // Top bit cleared so the value is always a positive bigint.
  return (digest.readBigUInt64BE(0) & 0x7fffffffffffffffn).toString();
}

export type LeaseHandle = {
  acquired: boolean;
  key: string;
  /** The backend actually holding the lock, so the evidence can prove it is one session. */
  backendPid: number | null;
  release(): Promise<boolean>;
};

/**
 * Takes the lease on a DEDICATED, explicitly checked-out connection.
 *
 * `pg_advisory_lock` is owned by the session, not by the pool (§3). Calling
 * `pool.query('pg_try_advisory_lock…')` would take the lock on whichever backend
 * the pool happened to hand over and then return that backend to the pool, where
 * a later caller could use it — or where an idle-timeout could close it and drop
 * the lock without anyone noticing. Checking the client out and holding it is
 * the difference between a lease and a coincidence.
 *
 * `pg_try_advisory_lock`, never the blocking form: a competing worker must be
 * classified `awaiting_resource` and sent away, not parked indefinitely on a
 * lock the architecture would then have to time out.
 */
export async function acquireThreadLease(lease: Db, threadId: string): Promise<LeaseHandle> {
  const key = threadLeaseKey(threadId);
  const client = await lease.pool.connect();
  let acquired = false;
  let backendPid: number | null = null;

  try {
    const { rows } = await client.query<{ ok: boolean; pid: number }>(
      "SELECT pg_try_advisory_lock($1::bigint) AS ok, pg_backend_pid() AS pid",
      [key],
    );
    acquired = rows[0]?.ok === true;
    backendPid = rows[0]?.pid ?? null;
  } catch (error) {
    client.release();
    throw error;
  }

  if (!acquired) {
    client.release();
    return { acquired: false, key, backendPid, release: async () => false };
  }

  return {
    acquired: true,
    key,
    backendPid,
    release: async () => {
      try {
        const { rows } = await client.query<{ ok: boolean }>(
          "SELECT pg_advisory_unlock($1::bigint) AS ok",
          [key],
        );
        return rows[0]?.ok === true;
      } finally {
        client.release();
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Store guard  (lane `mit-storeguard`)
// ---------------------------------------------------------------------------

/**
 * Every rule here names the case that measured the hazard. A guard rule with no
 * measurement behind it would be this spike inventing requirements for itself.
 */
export type StoreRefusalCode =
  /** d28: `:` is a legal label character AND the delimiter, so two namespaces become one row. */
  | "namespace_contains_delimiter"
  /** d29/d31: prefixes are matched with LIKE, so `%` and `_` cross tenant boundaries. */
  | "namespace_contains_like_metacharacter"
  /** d22: `calculateExpiresAt` treats 0 as falsy, so ttl 0 means "never expires". */
  | "ttl_zero_means_never_expires"
  /** d34: an unrecognised operator produces no SQL condition, so the filter returns everything. */
  | "filter_operator_not_recognised"
  /** d34: an empty `$in`/`$nin` is skipped by a length guard, with the same effect. */
  | "filter_membership_list_is_empty";

export type StoreVerdict = {
  allowed: boolean;
  /** Sorted, so an identical refusal is byte-identical across runs. */
  refusals: Array<{ code: StoreRefusalCode; subject: string }>;
};

/** Operators the pinned release actually implements. Anything else fails open. */
const RECOGNISED_OPERATORS = new Set([
  "$eq",
  "$ne",
  "$gt",
  "$gte",
  "$lt",
  "$lte",
  "$in",
  "$nin",
  "$exists",
]);

export type GuardedOperation = {
  namespace?: string[];
  /** A `listNamespaces`/`search` prefix, which the vendor does NOT validate at all. */
  prefix?: string[];
  ttl?: number | null;
  filter?: Record<string, unknown>;
};

/**
 * Fail closed, and report every reason rather than the first.
 *
 * An operator deciding whether to widen a rule needs the whole picture, and a
 * refusal that stopped at the first problem would make the guard's output depend
 * on key iteration order.
 */
export function checkStoreOperation(operation: GuardedOperation): StoreVerdict {
  const refusals: StoreVerdict["refusals"] = [];

  // The prefix path is checked with the SAME rules as the namespace path. The
  // vendor's asymmetry — `validateNamespace` guards `put`/`search` and is never
  // called by `listNamespaces` — is exactly the hazard d31 measured.
  for (const [source, labels] of [
    ["namespace", operation.namespace],
    ["prefix", operation.prefix],
  ] as const) {
    for (const label of labels ?? []) {
      if (label.includes(":")) {
        refusals.push({ code: "namespace_contains_delimiter", subject: `${source}:${label}` });
      }
      if (label.includes("%") || label.includes("_")) {
        refusals.push({
          code: "namespace_contains_like_metacharacter",
          subject: `${source}:${label}`,
        });
      }
    }
  }

  if (operation.ttl === 0) {
    refusals.push({ code: "ttl_zero_means_never_expires", subject: "ttl" });
  }

  for (const [field, condition] of Object.entries(operation.filter ?? {})) {
    if (condition === null || typeof condition !== "object" || Array.isArray(condition)) continue;
    for (const [operator, value] of Object.entries(condition as Record<string, unknown>)) {
      if (!operator.startsWith("$")) continue;
      if (!RECOGNISED_OPERATORS.has(operator)) {
        refusals.push({
          code: "filter_operator_not_recognised",
          subject: `${field}${operator}`,
        });
        continue;
      }
      if ((operator === "$in" || operator === "$nin") && Array.isArray(value) && value.length === 0) {
        refusals.push({
          code: "filter_membership_list_is_empty",
          subject: `${field}${operator}`,
        });
      }
    }
  }

  refusals.sort((left, right) =>
    left.code !== right.code
      ? left.code < right.code
        ? -1
        : 1
      : left.subject < right.subject
        ? -1
        : left.subject > right.subject
          ? 1
          : 0,
  );

  return { allowed: refusals.length === 0, refusals };
}
