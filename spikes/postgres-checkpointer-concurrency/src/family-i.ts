// Family I: the two mitigation lanes that were not already carried by the
// families whose findings they answer.
//
// `mit-migration` lives in family A (a13, paired with a03) and `mit-compat` in
// family H (h13-h17, paired with h08-h12), because a safeguard is easiest to
// judge next to the case that motivated it. What remains is the per-thread lease
// and the Store guard, and both are here.
//
// Every case obeys the same three rules the plan sets for a mitigation:
//
//   * it must eliminate ONLY its stated target, which is checked by keeping the
//     paired stock case in the same evidence set and by an in-family control
//     that runs the identical code with the guard switched off;
//   * it must fail LOUDLY rather than degrade, so a refusal is a typed value
//     rather than a silently narrowed result;
//   * it must not erase the stock negative, which is mechanical — `pairedWith`
//     forces the stock case into any selection that includes the mitigation.

import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { PostgresStore } from "@langchain/langgraph-checkpoint-postgres/store";

import {
  CHECKPOINT_SCHEMA,
  STORE_SCHEMA,
  databaseForCase,
  threadForCase,
} from "./contract.ts";
import { appNameFor, connectionString, describeSqlError, openDb, type Db } from "./db.ts";
import { arrive, waitForRelease } from "./barrier.ts";
import { createProbe, type Probe } from "./probe.ts";
import { buildGraph, resume, runToInterrupt } from "./graph.ts";
import { project } from "./inspect/checkpoints.ts";
import { createEmbeddings } from "./store/embeddings.ts";
import {
  acquireThreadLease,
  checkStoreOperation,
  confineToPathBoundary,
  type GuardedOperation,
} from "./guards.ts";
import type { PartyContext } from "./family-a.ts";

function subjectPool(context: PartyContext): Db {
  return openDb(appNameFor(context.caseId, context.member, "subject"), "subject", {
    database: databaseForCase(context.caseId),
    max: 4,
  });
}

function probePool(context: PartyContext): Db {
  return openDb(appNameFor(context.caseId, context.member, "witness"), "probe", {
    database: databaseForCase(context.caseId),
  });
}

function inspectPool(context: PartyContext): Db {
  return openDb(appNameFor(context.caseId, context.member, "inspect"), "inspect", {
    database: databaseForCase(context.caseId),
  });
}

/** `max: 1` so the lease cannot drift onto a second backend. */
function leasePool(context: PartyContext): Db {
  return openDb(appNameFor(context.caseId, context.member, "lease"), "lease", {
    database: databaseForCase(context.caseId),
    max: 1,
  });
}

async function atBarrier(
  probe: Db,
  context: PartyContext,
  witness: Probe,
  name: string,
): Promise<void> {
  await arrive(probe, context.caseId, name, context.party, context.member, witness.nonce);
  await waitForRelease(probe, context.caseId, name);
}

// ---------------------------------------------------------------------------
// mit-lease
// ---------------------------------------------------------------------------

/**
 * Two workers resume the same committed interrupt, exactly as b02 does. The only
 * difference is that each first tries to take a per-thread lease on a dedicated
 * session, and a worker that fails to take it is classified `awaiting_resource`
 * and executes nothing.
 *
 * `guarded: false` runs the identical code with the lease step skipped, which is
 * the in-family control: without it, "the guarded lane executed once" could be
 * a property of this fixture rather than of the guard.
 */
async function leasedResume(
  context: PartyContext,
  options: { guarded: boolean },
): Promise<Record<string, unknown>> {
  const probe = probePool(context);
  const subject = subjectPool(context);
  const lease = leasePool(context);
  const threadId = threadForCase(context.caseId);

  try {
    const witness = createProbe(probe, context.caseId, context.party, context.member);
    const saver = new PostgresSaver(subject.pool, undefined, { schema: CHECKPOINT_SCHEMA });
    const graph = buildGraph(saver, witness);

    await atBarrier(probe, context, witness, "resume-ready");

    const handle = options.guarded
      ? await acquireThreadLease(lease, threadId)
      : { acquired: true, key: "<lease disabled>", backendPid: null, release: async () => false };

    if (!handle.acquired) {
      // Refused, not queued. The architecture's run state machine has a name for
      // this and it is not "failed": the work is still runnable, just not here.
      await witness.record("lease", "refused");
      return {
        party: context.party,
        error: null,
        guarded: options.guarded,
        leaseAcquired: false,
        classification: "awaiting_resource",
        executed: false,
        runs: [],
        completed: false,
      };
    }

    await witness.record("lease", "acquired");
    const run = await resume(graph, threadId);
    const released = options.guarded ? await handle.release() : false;

    return {
      party: context.party,
      error: null,
      guarded: options.guarded,
      leaseAcquired: true,
      // Proof the lock lived on ONE session, which is what makes it a lease
      // rather than a hopeful query against whichever backend the pool offered.
      leaseOnDedicatedBackend: handle.backendPid !== null,
      leaseReleased: released,
      classification: "running",
      executed: true,
      runs: [run],
      completed: run.error === null && run.interrupted === false,
    };
  } catch (caught) {
    return { party: context.party, error: describeSqlError(caught) };
  } finally {
    await Promise.allSettled([subject.close(), lease.close(), probe.close()]);
  }
}

/**
 * The lease must be a lease, not a lock-out: once the holder exits, the next
 * worker takes it and finishes the run.
 *
 * Sequential rather than raced on purpose. A parallel version could pass because
 * the second worker happened to arrive after the first released, which is the
 * question this case exists to answer rather than to assume.
 */
async function leaseReleasedOnExit(context: PartyContext): Promise<Record<string, unknown>> {
  const probe = probePool(context);
  const subject = subjectPool(context);
  const lease = leasePool(context);
  const inspect = inspectPool(context);
  const threadId = threadForCase(context.caseId);

  try {
    const witness = createProbe(probe, context.caseId, context.party, context.member);
    const saver = new PostgresSaver(subject.pool, undefined, { schema: CHECKPOINT_SCHEMA });
    const graph = buildGraph(saver, witness);

    const handle = await acquireThreadLease(lease, threadId);
    if (!handle.acquired) {
      return {
        party: context.party,
        error: null,
        leaseAcquired: false,
        classification: "awaiting_resource",
        executed: false,
        runs: [],
        completed: false,
      };
    }

    // Party 0 only takes and releases the lease; party 1 does the resume. That
    // way "party 1 acquired it" is evidence the first holder's exit freed it,
    // and not evidence that nobody ever held it.
    const run = context.party === 1 ? await resume(graph, threadId) : null;
    const released = await handle.release();
    const projection = await project(inspect, threadId);

    return {
      party: context.party,
      error: null,
      leaseAcquired: true,
      leaseReleased: released,
      classification: "running",
      executed: run !== null,
      runs: run ? [run] : [],
      completed: run !== null && run.error === null && run.interrupted === false,
      leaves: projection.checkpoints.length,
    };
  } catch (caught) {
    return { party: context.party, error: describeSqlError(caught) };
  } finally {
    await Promise.allSettled([subject.close(), lease.close(), probe.close(), inspect.close()]);
  }
}

// ---------------------------------------------------------------------------
// mit-storeguard
// ---------------------------------------------------------------------------

/**
 * Each case hands the guard one shape this spike measured as unsafe, and then —
 * only if the guard allows it — performs the operation for real.
 *
 * Performing it matters. A guard that refused everything would satisfy every
 * refusal criterion while being useless, so the allow-path has to reach the
 * Store and come back with a result.
 */
type SeedItem = { namespace: string[]; key: string; value: Record<string, unknown> };

async function guardedStoreOperation(
  context: PartyContext,
  operation: GuardedOperation & {
    key?: string;
    value?: Record<string, unknown>;
    /** Written before the guarded call, so an allow-path result is non-vacuous. */
    seed?: SeedItem[];
  },
): Promise<Record<string, unknown>> {
  const probe = probePool(context);
  const store = new PostgresStore({
    connectionOptions: {
      connectionString: connectionString(
        appNameFor(context.caseId, context.member, "subject"),
        databaseForCase(context.caseId),
      ),
    },
    schema: STORE_SCHEMA,
    ensureTables: false,
    index: { dims: 8, embed: createEmbeddings(), fields: ["title"] },
  } as ConstructorParameters<typeof PostgresStore>[0]);

  try {
    const witness = createProbe(probe, context.caseId, context.party, context.member);
    const verdict = checkStoreOperation(operation);
    await witness.record("guard", verdict.allowed ? "allowed" : "refused");

    if (!verdict.allowed) {
      // The Store is never touched. That is the requirement — a guard that
      // refused after calling would already have created the row it objected to.
      return {
        party: context.party,
        error: null,
        verdict,
        reached: false,
        outcome: null,
      };
    }

    await store.start();
    let outcome: Record<string, unknown>;
    if (operation.seed) {
      for (const item of operation.seed) {
        await store.put(item.namespace, item.key, item.value, false);
      }
    }

    if (operation.prefix) {
      const listed = await store.listNamespaces({
        prefix: operation.prefix,
        ...(operation.maxDepth === undefined ? {} : { maxDepth: operation.maxDepth }),
        ...(operation.limit === undefined ? { limit: 50 } : { limit: operation.limit }),
      });
      // The vendor's answer and the guard's answer, both recorded. Keeping the
      // unconfined result is what lets i09 reproduce d29's boundary crossing
      // inside the mitigation lane rather than asserting against a defect
      // measured somewhere else.
      const confined = confineToPathBoundary(operation.prefix, listed);
      outcome = {
        // Label COUNTS and joined labels are safe here: these are authored
        // fixture namespaces with no engine-generated id in them.
        vendorNamespaces: listed.map((parts) => parts.join("/")).sort(),
        confinedNamespaces: confined.kept.map((parts) => parts.join("/")).sort(),
        droppedNonDescendants: confined.droppedNonDescendants,
      };
    } else if (operation.filter) {
      const found = await store.search(operation.namespace ?? ["spike"], {
        // Cast at the boundary: the guard's job is to decide whether this shape
        // is safe, so it must be able to hold shapes the vendor's own type
        // rejects — an unrecognised operator is exactly such a shape.
        filter: operation.filter as Parameters<typeof store.search>[1] extends
          { filter?: infer F } ? F : never,
        limit: 50,
      });
      outcome = {
        keys: found.map((item) => item.key).sort(),
        // The corpus size the filter ran against, so "it restricted" can be a
        // proper-subset claim rather than "it returned something".
        corpus: operation.seed?.length ?? 0,
      };
    } else {
      // `put(namespace, key, value, index, options)` - the index is the FOURTH
      // positional argument and the options object is the fifth. Passing an
      // options object where the index belongs fails with "fields is not
      // iterable", which is how this was found.
      await store.put(
        operation.namespace ?? ["spike"],
        operation.key ?? "k",
        operation.value ?? { title: "alpha" },
        false,
        operation.ttl === undefined || operation.ttl === null ? undefined : { ttl: operation.ttl },
      );
      const read = await store.get(operation.namespace ?? ["spike"], operation.key ?? "k");
      outcome = { written: read !== null };
    }

    return { party: context.party, error: null, verdict, reached: true, outcome };
  } catch (caught) {
    return { party: context.party, error: describeSqlError(caught), reached: true };
  } finally {
    await store.stop().catch(() => {});
    await probe.close().catch(() => {});
  }
}

// ---------------------------------------------------------------------------

export async function runFamilyIParty(context: PartyContext): Promise<Record<string, unknown>> {
  switch (context.caseId) {
    case "i01-thread-lease-parallel-resume":
      return await leasedResume(context, { guarded: true });

    case "i02-thread-lease-disabled-control":
      return await leasedResume(context, { guarded: false });

    case "i03-thread-lease-released-on-exit":
      return await leaseReleasedOnExit(context);

    case "i04-store-guard-rejects-delimiter-in-a-label":
      return await guardedStoreOperation(context, { namespace: ["spike", "a:b"], key: "k" });

    case "i05-store-guard-rejects-wildcard-prefix":
      return await guardedStoreOperation(context, { prefix: ["%"] });

    case "i06-store-guard-rejects-zero-ttl":
      return await guardedStoreOperation(context, { namespace: ["spike"], key: "k", ttl: 0 });

    case "i07-store-guard-rejects-fail-open-filters":
      return await guardedStoreOperation(context, {
        namespace: ["spike"],
        filter: { title: { $regex: "^a" }, tags: { $in: [] } },
      });

    case "i08-store-guard-allows-safe-operations-control":
      return await guardedStoreOperation(context, {
        namespace: ["spike", "safe"],
        key: "k",
        ttl: 60,
      });

    // d29's corpus, rebuilt inside the mitigation lane. The prefix is legal, so
    // nothing is refused; the guard's work happens on the way back.
    case "i09-store-guard-confines-a-prefix-to-the-path-boundary":
      return await guardedStoreOperation(context, {
        prefix: ["alpha"],
        seed: [
          { namespace: ["alpha"], key: "k", value: { title: "alpha" } },
          { namespace: ["alpha", "one"], key: "k", value: { title: "beta" } },
          // The sibling `LIKE 'alpha%'` wrongly matches. Not a descendant of
          // `["alpha"]` by any path reading, which is the entire point.
          { namespace: ["alphabet"], key: "k", value: { title: "gamma" } },
        ],
      });

    case "i10-store-guard-rejects-maxdepth-with-a-limit":
      return await guardedStoreOperation(context, { prefix: ["alpha"], maxDepth: 1, limit: 2 });

    // The narrowness control: the same maxDepth, without paging, must be allowed
    // AND must come back with a result.
    case "i11-store-guard-allows-maxdepth-without-a-limit-control":
      return await guardedStoreOperation(context, {
        prefix: ["alpha"],
        maxDepth: 1,
        seed: [
          { namespace: ["alpha"], key: "k", value: { title: "alpha" } },
          { namespace: ["alpha", "one"], key: "k", value: { title: "beta" } },
        ],
      });

    // The allow-path for filters, which nothing exercised: every storeguard case
    // before this either refused or performed a `put`, so the recognised-operator
    // list and the non-empty `$in` branch were never reached.
    case "i12-store-guard-allows-a-restrictive-recognized-filter-control":
      return await guardedStoreOperation(context, {
        namespace: ["spike", "filter"],
        filter: { tier: { $in: ["gold"] } },
        seed: [
          { namespace: ["spike", "filter"], key: "keep", value: { title: "alpha", tier: "gold" } },
          { namespace: ["spike", "filter"], key: "drop-1", value: { title: "beta", tier: "silver" } },
          { namespace: ["spike", "filter"], key: "drop-2", value: { title: "gamma", tier: "bronze" } },
        ],
      });

    default:
      throw new Error(`family I has no participant for case ${context.caseId}`);
  }
}

/** The lease cases need a committed interrupt to race for, exactly as b02 does. */
export async function prepareFamilyI(caseId: string): Promise<Record<string, unknown>> {
  if (!caseId.startsWith("i01") && !caseId.startsWith("i02") && !caseId.startsWith("i03")) {
    return { caseId, prepared: false };
  }

  const context: PartyContext = { caseId, party: -1, member: "prepare" };
  const probe = probePool(context);
  const subject = subjectPool(context);
  const inspect = inspectPool(context);
  const threadId = threadForCase(caseId);

  try {
    const witness = createProbe(probe, caseId, -1, "prepare");
    const saver = new PostgresSaver(subject.pool, undefined, { schema: CHECKPOINT_SCHEMA });
    const graph = buildGraph(saver, witness);
    const first = await runToInterrupt(graph, threadId);
    const projection = await project(inspect, threadId);

    return {
      caseId,
      prepared: true,
      threadId,
      reachedInterrupt: first.interrupted,
      interruptRows: projection.interrupts.length,
      checkpointRows: projection.checkpoints.length,
      error: first.error,
    };
  } finally {
    await Promise.allSettled([subject.close(), probe.close(), inspect.close()]);
  }
}
