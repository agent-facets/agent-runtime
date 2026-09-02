// Family G: database and container-stack restart.
//
// The architecture claims durability across process death. Spike 05 proved that
// for a killed WORKER. This family asks the harder version: does persisted state
// survive the database, and then the whole container stack, being taken away and
// rebuilt?
//
// Every case is two parties around one driver-performed action:
//
//   party 0   writes a thread and pauses it on a committed interrupt, then
//             records the cluster's identity.
//   <action>  the driver restarts, SIGKILLs, replaces, or re-volumes the server.
//   party 1   a genuinely fresh runtime container: records the identity again
//             and resumes the paused thread using persisted state alone.
//
// The continuity witness is `pg_control_system().system_identifier`, not
// anything Docker says. A container id proves a container was replaced; only the
// system identifier proves the DATA is the same data — it is written once by
// initdb and survives every restart of that cluster. It is also the one witness
// that cannot be faked by a container that never actually went away, and it puts
// no host path anywhere near the evidence.
//
// `postmaster_start_time` is the companion: same identifier with a LATER start
// time is "the same data, a new server process", which is exactly what a restart
// has to mean.

import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";

import { CHECKPOINT_SCHEMA, databaseForCase, threadForCase } from "./contract.ts";
import { appNameFor, describeSqlError, openDb, type Db, type SqlError } from "./db.ts";
import { recordNodePark } from "./gate.ts";
import { createProbe } from "./probe.ts";
import { buildGraph, resume, runToInterrupt } from "./graph.ts";
import { project } from "./inspect/checkpoints.ts";
import { clusterIdentity } from "./inspect/pgstat.ts";
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

type StateShape = {
  checkpoints: number;
  interruptRows: number;
  blobs: number;
  writes: number;
};

async function shapeOf(inspect: Db, threadId: string): Promise<StateShape> {
  const projection = await project(inspect, threadId);
  return {
    checkpoints: projection.checkpoints.length,
    interruptRows: projection.interrupts.length,
    blobs: projection.blobs.length,
    writes: projection.writes.length,
  };
}

/**
 * Party 0: build the paused thread, then photograph the cluster.
 *
 * The pause is a committed interrupt rather than a completed run, because the
 * strongest thing a restart can be asked to preserve is a run that is still
 * waiting to be finished — and only resuming it afterwards proves that.
 */
async function beforeRestart(context: PartyContext): Promise<Record<string, unknown>> {
  const probe = probePool(context);
  const subject = subjectPool(context);
  const inspect = inspectPool(context);
  const threadId = threadForCase(context.caseId);

  try {
    const witness = createProbe(probe, context.caseId, context.party, context.member);
    const saver = new PostgresSaver(subject.pool, undefined, { schema: CHECKPOINT_SCHEMA });
    const graph = buildGraph(saver, witness);

    const first = await runToInterrupt(graph, threadId);
    const shape = await shapeOf(inspect, threadId);

    return {
      party: context.party,
      error: null,
      role: "before",
      threadId,
      reachedInterrupt: first.interrupted,
      shape,
      cluster: await clusterIdentity(inspect),
    };
  } catch (caught) {
    return { party: context.party, error: describeSqlError(caught), role: "before" };
  } finally {
    await Promise.allSettled([subject.close(), probe.close(), inspect.close()]);
  }
}

/**
 * Party 1: a fresh container against whatever the driver left behind.
 *
 * It reads the state shape BEFORE resuming, so "the rows survived" and "the run
 * resumed" are two separate findings rather than one conflated claim — a resume
 * that recreated everything from scratch would satisfy the second and not the
 * first.
 */
async function afterRestart(context: PartyContext): Promise<Record<string, unknown>> {
  const probe = probePool(context);
  const subject = subjectPool(context);
  const inspect = inspectPool(context);
  const threadId = threadForCase(context.caseId);

  try {
    const witness = createProbe(probe, context.caseId, context.party, context.member);
    const cluster = await clusterIdentity(inspect);
    const survived = await shapeOf(inspect, threadId);

    const saver = new PostgresSaver(subject.pool, undefined, { schema: CHECKPOINT_SCHEMA });
    const graph = buildGraph(saver, witness);
    const run = await resume(graph, threadId);

    return {
      party: context.party,
      error: null,
      role: "after",
      threadId,
      cluster,
      survived,
      resumed: {
        error: run.error,
        interrupted: run.interrupted,
        completed: run.error === null && run.interrupted === false,
        // The discriminator f06 forced on this harness: a resume against absent
        // state returns success with an EMPTY step list, so completion alone
        // cannot distinguish a preserved run from a vanished one.
        steps: run.steps,
      },
      after: await shapeOf(inspect, threadId),
    };
  } catch (caught) {
    return { party: context.party, error: describeSqlError(caught), role: "after" };
  } finally {
    await Promise.allSettled([subject.close(), probe.close(), inspect.close()]);
  }
}

/**
 * OLD g03. Retained only so the diff is legible; no case dispatches to it.
 *
 * It could not measure what it claimed: the driver acts between parties, so this
 * party had already rolled back, released its client and exited before the
 * server was killed. `heldBackend` meant "a pid was once read", not "a backend
 * was live at the kill". Replaced by `databaseDeathUnderLiveWorker`.
 */
async function _retiredUnderLiveWorker(context: PartyContext): Promise<Record<string, unknown>> {
  return await beforeRestart(context);
}

/**
 * The one case where the server dies UNDER a live caller.
 *
 * Party 0 opens a transaction and parks inside it holding a lock, so the
 * connection is genuinely in use when the driver kills the server. What is being
 * measured is the shape of the failure the client sees: a loud, classifiable
 * error rather than an indefinite hang.
 */
async function databaseDeathUnderLiveWorker(
  context: PartyContext,
): Promise<Record<string, unknown>> {
  if (context.party === 1) return await afterRestart(context);

  const probe = probePool(context);
  // No statement timeout on the subject. The default 15s cap would abort the
  // blocked call on its own, and the case would then be measuring the harness's
  // timeout rather than what the server's death does to an in-flight caller.
  const subject = openDb(appNameFor(context.caseId, context.member, "subject"), "subject", {
    database: databaseForCase(context.caseId),
    max: 4,
    statementTimeoutMs: null,
  });
  const lease = openDb(appNameFor(context.caseId, context.member, "lease"), "lease", {
    database: databaseForCase(context.caseId),
    max: 1,
    statementTimeoutMs: null,
  });
  const observe = openDb(appNameFor(context.caseId, context.member, "observe"), "observe", {
    database: databaseForCase(context.caseId),
  });
  const inspect = inspectPool(context);
  const threadId = threadForCase(context.caseId);

  try {
    const witness = createProbe(probe, context.caseId, context.party, context.member);
    const saver = new PostgresSaver(subject.pool, undefined, { schema: CHECKPOINT_SCHEMA });

    // Committed state FIRST, so party 1 has something whose survival is worth
    // checking. Everything after this point is about the in-flight call.
    const graph = buildGraph(saver, witness);
    const first = await runToInterrupt(graph, threadId);
    const shape = await shapeOf(inspect, threadId);
    const cluster = await clusterIdentity(inspect);

    // A dedicated session holds the checkpoint table so the next write cannot
    // proceed. This is the only way to hold a real vendor call open long enough
    // for the server to be destroyed underneath it — a sleep would prove nothing
    // about where the call was.
    const blocker = await lease.pool.connect();
    // A CHECKED-OUT client emits `error` on itself, not on the pool, so
    // `openDb`'s pool-level handler does not see it. When the server is
    // destroyed this fires — and with no listener Node treats an unhandled
    // `error` event as fatal, killing the worker before the awaited call can
    // reject. The first run of this case died exactly that way and reported no
    // JSON at all.
    //
    // The messages are kept: a socket torn down mid-transaction is part of what
    // "the caller was told" means.
    const clientErrors: Array<{ message: string; code: string | null }> = [];
    blocker.on("error", (caught: unknown) => {
      clientErrors.push({
        message: caught instanceof Error ? caught.message : String(caught),
        code: (caught as { code?: string } | null)?.code ?? null,
      });
    });
    await blocker.query("BEGIN");
    await blocker.query(
      `LOCK TABLE ${CHECKPOINT_SCHEMA}.checkpoints IN ACCESS EXCLUSIVE MODE`,
    );

    // Deliberately NOT awaited. The promise is the thing under test.
    const pending = saver
      .put(
        { configurable: { thread_id: threadId, checkpoint_ns: "" } },
        {
          v: 4,
          id: "01970000-0000-6000-8000-0000000000d3",
          ts: "2026-01-01T00:00:00.000Z",
          channel_values: { spike_channel: "in-flight" },
          channel_versions: { spike_channel: "9" },
          versions_seen: {},
        },
        { source: "update", step: 9, parents: {} } as never,
        { spike_channel: "9" },
      )
      .then(
        () => ({ settled: "fulfilled" as const, error: null as SqlError | null }),
        (caught: unknown) => ({ settled: "rejected" as const, error: describeSqlError(caught) }),
      );

    // Confirm from the SERVER that the call is genuinely blocked, rather than
    // assuming it got that far. Without this the kill could land before the
    // vendor had issued any statement at all.
    const blockedDeadline = Date.now() + 30_000;
    let blockedBackends = 0;
    while (Date.now() < blockedDeadline) {
      const { rows } = await observe.pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE application_name LIKE $1 AND wait_event_type = 'Lock' AND state = 'active'`,
        [`${context.caseId}:${context.member}#subject%`],
      );
      blockedBackends = rows[0]?.n ?? 0;
      if (blockedBackends > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    await witness.record("worker", "checkpointer-blocked", { blockedBackends });
    // The driver SIGKILLs PostgreSQL here and restarts it.
    await recordNodePark(probe, context.caseId, context.party, "checkpointer-blocked", "put");

    // What the caller sees. Bounded on purpose: an indefinite hang is the
    // negative outcome this case exists to rule out, and it has to be
    // distinguishable from a slow rejection rather than becoming a timeout.
    const started = Date.now();
    const outcome = await Promise.race([
      pending,
      new Promise<{ settled: "unsettled"; error: null }>((resolve) =>
        setTimeout(() => resolve({ settled: "unsettled", error: null }), 30_000),
      ),
    ]);
    const settleMs = Date.now() - started;

    try {
      await blocker.query("ROLLBACK");
    } catch {
      /* the server is gone; the transaction died with it */
    }
    blocker.release();

    return {
      party: context.party,
      error: null,
      role: "before",
      threadId,
      reachedInterrupt: first.interrupted,
      shape,
      cluster,
      // The witness that matters: a backend belonging to the SUBJECT pool was
      // waiting on a lock, in the server, at the moment it was killed.
      blockedBackends,
      callWasInFlight: blockedBackends > 0,
      // Loud and bounded, or not.
      callSettled: outcome.settled !== "unsettled",
      callRejected: outcome.settled === "rejected",
      callError: outcome.error,
      settledWithinBudget: settleMs < 30_000,
      // Both halves of what the client observed: the awaited promise, and the
      // socket-level errors the driver surfaced on the held connection.
      observedClientErrors: clientErrors.length,
      idleClientErrors: subject.idleErrors.length + lease.idleErrors.length,
    };
  } catch (caught) {
    return { party: context.party, error: describeSqlError(caught), role: "before" };
  } finally {
    await Promise.allSettled([
      subject.close(),
      lease.close(),
      observe.close(),
      probe.close(),
      inspect.close(),
    ]);
  }
}

export async function runFamilyGParty(context: PartyContext): Promise<Record<string, unknown>> {
  if (context.caseId === "g03-database-death-under-a-live-worker") {
    return await databaseDeathUnderLiveWorker(context);
  }
  if (context.party === 1) return await afterRestart(context);
  return await beforeRestart(context);
}
