// Guarded runtime access to PostgresStore's internal pool.
//
// PostgresSaver takes its pool as a constructor argument, so the checkpointer
// needs no reflection. PostgresStore does not: its constructor builds its own
// `pg.Pool` and `config` accepts only a connection string or pool OPTIONS. There
// is no injection point, so reflection is the only way to instrument it without
// patching the package.
//
// TypeScript's `private` is erased at emit, so `core` is an ordinary own
// property at run time. That is a fact about the compiled artefact, not a
// supported API, and it is recorded as a harness limitation in the report.
//
// The shape assertion is fail-closed on purpose: a release that renames `core`
// must break every Store instrumentation case loudly rather than silently
// producing unwitnessed results. This is the single point of vendor-internal
// access in the harness, isolated here so the audit can confirm that.

import type pg from "pg";

type StoreCore = {
  pool: pg.Pool;
  schema: string;
  withClient: (operation: unknown) => unknown;
};

export class ReflectionShapeError extends Error {
  constructor(detail: string) {
    super(`PostgresStore internal shape changed: ${detail}`);
    this.name = "ReflectionShapeError";
  }
}

export function storeCore(store: object): StoreCore {
  const core = (store as { core?: unknown }).core;
  if (core === null || typeof core !== "object") {
    throw new ReflectionShapeError("`core` is absent or not an object");
  }
  const candidate = core as Partial<StoreCore>;
  if (typeof candidate.schema !== "string") {
    throw new ReflectionShapeError("`core.schema` is not a string");
  }
  if (typeof candidate.withClient !== "function") {
    throw new ReflectionShapeError("`core.withClient` is not a function");
  }
  const pool = candidate.pool as { connect?: unknown; on?: unknown } | undefined;
  if (!pool || typeof pool.connect !== "function" || typeof pool.on !== "function") {
    throw new ReflectionShapeError("`core.pool` is not a pg.Pool");
  }
  return core as StoreCore;
}

export function storePool(store: object): pg.Pool {
  return storeCore(store).pool;
}

/**
 * The cross-check that makes reflection trustworthy rather than assumed: the
 * pool we instrumented must be the pool the server sees. If the counts disagree,
 * something else is opening connections under this application name.
 */
export function poolCounts(pool: pg.Pool): {
  total: number;
  idle: number;
  waiting: number;
} {
  return {
    total: pool.totalCount,
    idle: pool.idleCount,
    waiting: pool.waitingCount,
  };
}
