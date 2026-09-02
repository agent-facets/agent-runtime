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
import { appNameFor, describeSqlError, openDb, type Db } from "./db.ts";
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
 * The one case where the server dies UNDER a live caller.
 *
 * Party 0 opens a transaction and parks inside it holding a lock, so the
 * connection is genuinely in use when the driver kills the server. What is being
 * measured is the shape of the failure the client sees: a loud, classifiable
 * error rather than an indefinite hang.
 */
async function underLiveWorker(context: PartyContext): Promise<Record<string, unknown>> {
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
    const cluster = await clusterIdentity(inspect);

    // Held open across the kill. The driver's action fires once this party has
    // exited, so the observable is what the NEXT operation on a pool whose
    // server has been destroyed does — which is the client-visible half of the
    // question. The transaction here guarantees a live backend exists at the
    // moment of the kill.
    const client = await subject.pool.connect();
    let heldBackend: number | null = null;
    try {
      await client.query("BEGIN");
      const { rows } = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      heldBackend = rows[0]?.pid ?? null;
      await witness.record("worker", "holding-transaction", { backend: heldBackend });
    } finally {
      // Released rather than left open: the worker has to EXIT for the driver to
      // act, and a checked-out client would keep the process alive past its
      // budget. The backend id is what the evidence needs, not the socket.
      try {
        await client.query("ROLLBACK");
      } catch {
        /* the server may already be gone */
      }
      client.release();
    }

    return {
      party: context.party,
      error: null,
      role: "before",
      threadId,
      reachedInterrupt: first.interrupted,
      shape,
      cluster,
      heldBackend: heldBackend !== null,
    };
  } catch (caught) {
    return { party: context.party, error: describeSqlError(caught), role: "before" };
  } finally {
    await Promise.allSettled([subject.close(), probe.close(), inspect.close()]);
  }
}

export async function runFamilyGParty(context: PartyContext): Promise<Record<string, unknown>> {
  if (context.party === 1) return await afterRestart(context);
  if (context.caseId === "g03-database-death-under-a-live-worker") {
    return await underLiveWorker(context);
  }
  return await beforeRestart(context);
}
