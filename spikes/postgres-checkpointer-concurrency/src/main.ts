// Entry point. Every subcommand prints exactly one JSON object to stdout and
// writes no file; the driver owns all persistence.

import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { PostgresStore } from "@langchain/langgraph-checkpoint-postgres/store";

import {
  CHECKPOINT_SCHEMA,
  CONFLICT_FIXTURE,
  PROBE_SCHEMA,
  STORE_SCHEMA,
  TIMEOUTS,
  databaseForCase,
  imageManifest,
  threadForCase,
} from "./contract.ts";
import { appNameFor, connectionString, openDb, waitForDb, type Db } from "./db.ts";
import { EXIT_HARNESS_FAULT, EXIT_USAGE, emit } from "./evidence.ts";
import { sanitizeProse } from "./canonical.ts";
import { PROBE_DDL, createProbe, type Probe } from "./probe.ts";
import { arm, release, summariseBarrier, waitForArrivals } from "./barrier.ts";
import { CASES, caseById, expandSelection, validateRegistry } from "./cases.ts";
import { FAMILIES, familyById } from "./families.ts";
import { LANES } from "./lanes.ts";
import {
  activity,
  clusterIdentity,
  columns,
  extensions,
  indexes,
  lockGraph,
  relations,
  routines,
  triggers,
  waitForDrain,
  waitForLockEdge,
} from "./inspect/pgstat.ts";
import { measureEgress } from "./inspect/egress.ts";
import {
  conflictWitness,
  executionCounts,
  leavesOf,
  namespaces,
  project,
  reachability,
} from "./inspect/checkpoints.ts";
import { provisionSelftest, runSelftestParty } from "./family-s.ts";
import { prepareFamilyA, runFamilyAParty } from "./family-a.ts";
import { prepareFamilyB, runFamilyBParty } from "./family-b.ts";
import { prepareFamilyC, runFamilyCParty } from "./family-c.ts";
import { prepareFamilyE, runFamilyEParty } from "./family-e.ts";
import { prepareFamilyF, runFamilyFParty } from "./family-f.ts";
import { runFamilyGParty } from "./family-g.ts";
import { prepareFamilyI, runFamilyIParty } from "./family-i.ts";
import { prepareFamilyH, runFamilyHParty } from "./family-h.ts";
import { effectEvents, effectSites } from "./inspect/effects.ts";
import {
  STORE_CONFLICT,
  STORE_KEY,
  STORE_NAMESPACE,
  prepareFamilyD,
  runFamilyDParty,
} from "./family-d.ts";
import { createEmbeddings } from "./store/embeddings.ts";
import { projectStore, storeConflictWitness } from "./inspect/store.ts";
import { summarize } from "./summarize.ts";

type Args = Record<string, string | boolean>;

function parseArgs(argv: string[]): { command: string; args: Args } {
  const [command = "cases", ...rest] = argv;
  const args: Args = {};
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index]!;
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = rest[index + 1];
    if (next === undefined || next.startsWith("--")) {
      args[key] = true;
    } else {
      args[key] = next;
      index += 1;
    }
  }
  return { command, args };
}

function describeError(error: unknown): { name: string; message: string } {
  const err = error as { name?: string; message?: string } | null;
  return {
    name: err?.name ?? "Error",
    message: sanitizeProse(err?.message ?? String(error)),
  };
}

/**
 * A graceful stop and a SIGKILL must be distinguishable in the evidence. A
 * SIGKILLed process cannot record anything, so the ABSENCE of this row is what
 * proves the kill was uncatchable rather than a tidy shutdown.
 */
let shutdownWitness: Probe | null = null;
process.on("SIGTERM", () => {
  const witness = shutdownWitness;
  if (!witness) process.exit(143);
  void witness
    .record("process", "sigterm")
    .catch(() => {})
    .finally(() => process.exit(143));
});

async function withDb<T>(db: Db, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } finally {
    await db.close().catch(() => {});
  }
}

/**
 * One database per case.
 *
 * `CREATE EXTENSION` is database-scoped and several cases must begin from a
 * genuinely cold cluster, so a schema per case is not enough: a Store case that
 * created `vector` would decide the outcome of the case that has to race for it.
 */
async function cmdProvision(args: Args): Promise<Record<string, unknown>> {
  const familyId = String(args.family ?? "");
  const family = familyById(familyId);
  if (!family) throw new Error(`unknown family: ${familyId}`);
  const caseIds = String(args.cases ?? "")
    .split(",")
    .filter((id) => id.length > 0);
  if (caseIds.length === 0) throw new Error("--cases is required");

  const admin = openDb(appNameFor("provision", familyId, "admin"), "inspect");
  return await withDb(admin, async () => {
    await waitForDb(admin, TIMEOUTS.conditionWaitMs);

    const databases: Record<string, string> = {};
    const migrated: Record<string, string[]> = {};

    for (const caseId of caseIds) {
      const name = databaseForCase(caseId);
      databases[caseId] = name;
      const { rowCount } = await admin.pool.query("SELECT 1 FROM pg_database WHERE datname = $1", [
        name,
      ]);
      if (rowCount === 0) await admin.pool.query(`CREATE DATABASE "${name}"`);

      const caseDb = openDb(appNameFor("provision", familyId, "inspect"), "inspect", {
        database: name,
      });
      try {
        await caseDb.pool.query(PROBE_DDL);
        migrated[caseId] = [];
        if (familyId === "S") await provisionSelftest(caseDb);

        // A case may override its family's provisioning. Several Store cases
        // must start with no store tables at all, because whether `setup()` ran
        // IS the subject — provisioning them like the rest would answer the
        // question before the case started.
        const provision = caseById(caseId)?.provision ?? family.provision;
        if (provision !== "bare") {
          const saver = new PostgresSaver(caseDb.pool, undefined, { schema: CHECKPOINT_SCHEMA });
          await saver.setup();
          migrated[caseId]!.push("checkpointer");
        }
        if (provision === "checkpointer+store") {
          // Migrated with the same index configuration as the a06 Store
          // baseline, so a family D terminal schema is comparable to it.
          const store = new PostgresStore({
            connectionOptions: { connectionString: connectionString(
              appNameFor("provision", familyId, "subject"),
              name,
            ) },
            schema: STORE_SCHEMA,
            index: { dims: 8, embed: createEmbeddings(), fields: ["title"] },
          } as ConstructorParameters<typeof PostgresStore>[0]);
          try {
            await store.setup();
            migrated[caseId]!.push("store");
          } finally {
            await store.stop().catch(() => {});
          }
        }
      } finally {
        await caseDb.close().catch(() => {});
      }
    }

    return {
      family: familyId,
      provision: family.provision,
      databases,
      migrated,
      cluster: await clusterIdentity(admin),
      extensions: await extensions(admin),
      egress: await measureEgress(),
    };
  });
}

async function cmdPrepare(args: Args): Promise<Record<string, unknown>> {
  const caseId = String(args.case ?? "");
  const definition = caseById(caseId);
  if (!definition) throw new Error(`unknown case: ${caseId}`);
  if (definition.family === "A") return await prepareFamilyA(caseId);
  if (definition.family === "B") return await prepareFamilyB(caseId);
  if (definition.family === "C") return await prepareFamilyC(caseId);
  if (definition.family === "D") return await prepareFamilyD(caseId);
  if (definition.family === "E") return await prepareFamilyE(caseId);
  if (definition.family === "F") return await prepareFamilyF(caseId);
  if (definition.family === "H") return await prepareFamilyH(caseId);
  if (definition.family === "I") return await prepareFamilyI(caseId);
  throw new Error(`no prepare step implemented for family ${definition.family}`);
}

/**
 * Poll for a durable gate-park row. The driver kills on THIS, never on a sleep:
 * a timed kill is the most common way this class of experiment produces a result
 * that cannot be reproduced.
 */
async function cmdAwaitPark(args: Args): Promise<Record<string, unknown>> {
  const caseId = String(args.case ?? "");
  const party = Number(args.party ?? 0);
  const gate = String(args.gate ?? "");
  const db = openDb(appNameFor(caseId, "await", "observe"), "observe", {
    database: databaseForCase(caseId),
  });

  return await withDb(db, async () => {
    const deadline = Date.now() + TIMEOUTS.conditionWaitMs;
    for (;;) {
      const { rows } = await db.pool.query<{ id: string; statement: string; ordinal: number }>(
        `SELECT id::text AS id, statement, ordinal FROM ${PROBE_SCHEMA}.gate_park
          WHERE case_id = $1 AND party = $2 AND gate = $3 ORDER BY id LIMIT 1`,
        [caseId, party, gate],
      );
      if (rows.length > 0) return { case: caseId, party, gate, parked: true, at: rows[0] };
      if (Date.now() > deadline) {
        throw new Error(`party ${party} never parked at gate ${gate}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  });
}

/**
 * The terminal schema, projected independently after every party has exited and
 * drained. An error-free caller set is not evidence that the schema converged,
 * and a loud SQLSTATE is not evidence that it did not.
 */
async function cmdProject(args: Args): Promise<Record<string, unknown>> {
  const caseId = String(args.case ?? "");
  const definition = caseById(caseId);
  const db = openDb(appNameFor(caseId, "project", "inspect"), "inspect", {
    database: databaseForCase(caseId),
  });
  const schemas = [
    PROBE_SCHEMA,
    CHECKPOINT_SCHEMA,
    STORE_SCHEMA,
    // The second and third Store schemas, so the isolation and search-path cases
    // are projected from the catalog rather than read back through an API.
    "lg_store_b",
    "lg_store_c",
    "lg_shared",
    "public",
  ];

  // Only for families whose subject is a migrated thread. Projecting an absent
  // thread for family A would add empty arrays to its digest that say nothing.
  const family = definition ? familyById(definition.family) : undefined;
  // Either the family or the CASE may call for a migrated database, and the
  // projector has to honour both. Family I is declared `bare` and overrides
  // per case, so keying on the family alone made its lease cases project no
  // thread at all — which surfaced as three declared oracles producing nothing.
  //
  // Deliberately a union rather than "the case wins": several family D cases
  // override DOWN to `bare` because starting with no store tables is their
  // subject, and letting the override win there would change what those already
  // sealed projections contain.
  const caseProvision = definition?.provision;
  const projectsThread =
    (family !== undefined && family.provision !== "bare") ||
    (caseProvision !== undefined && caseProvision !== "bare");
  const projectsStore =
    family?.projectsStore === true || caseProvision === "checkpointer+store";
  // Keyed off the case's DECLARED oracle rather than off its family. The two
  // sides of the effect key are only meaningful for a case that said it was
  // measuring one, and adding a constant pair of empty arrays to every other
  // family's digest would assert nothing while changing bytes that are already
  // sealed.
  const projectsEffectKey = definition?.oracles.includes("effectKey") === true;

  return await withDb(db, async () => {
    const ledger = async (schema: string, table: string): Promise<number[]> => {
      try {
        const { rows } = await db.pool.query<{ v: number }>(
          `SELECT v FROM "${schema}".${table} ORDER BY v`,
        );
        return rows.map((row) => row.v);
      } catch (error) {
        if ((error as { code?: string }).code === "42P01") return [];
        throw error;
      }
    };

    const threadId = threadForCase(caseId);
    const thread = projectsThread ? await project(db, threadId) : null;

    return {
      case: caseId,
      database: databaseForCase(caseId),
      ...(thread
        ? {
            thread: {
              threadId,
              // Lineage shape only. The blob column is reduced to a length and a
              // digest by the projector, and the interrupt payload to a length,
              // so no stored state reaches evidence verbatim.
              checkpoints: thread.checkpoints.map((row) => ({
                ns: row.checkpoint_ns,
                checkpoint_id: row.checkpoint_id,
                parent_checkpoint_id: row.parent_checkpoint_id,
                source: row.source,
                step: row.step,
              })),
              namespaces: namespaces(thread),
              leaves: namespaces(thread).map((ns) => ({
                ns,
                leaves: leavesOf(thread, ns).map((row) => row.checkpoint_id),
              })),
              blobs: thread.blobs.map((row) => ({
                ns: row.checkpoint_ns,
                channel: row.channel,
                version: row.version,
                bytes: row.blob_len,
              })),
              writes: thread.writes.map((row) => ({
                ns: row.checkpoint_ns,
                checkpoint_id: row.checkpoint_id,
                task_id: row.task_id,
                idx: row.idx,
                channel: row.channel,
                bytes: row.blob_len,
              })),
              // A COUNT, not the ids: the identities are engine-generated and
              // sorting them orders the array by a volatile value. Per-write
              // task labels are retained below, which is where the collision
              // structure actually lives.
              distinctTaskIds: new Set(thread.writes.map((row) => row.task_id)).size,
              interruptRows: thread.interrupts.length,
            },
            reachability: await reachability(db, threadId),
            conflictWitness: await conflictWitness(db, threadId, {
              p0: CONFLICT_FIXTURE.payloadByParty[0],
              p1: CONFLICT_FIXTURE.payloadByParty[1],
            }),
            executions: await executionCounts(db, caseId),
          }
        : {}),
      ...(projectsStore
        ? {
            store: await projectStore(db),
            // Attributed to the literal candidate payloads, so which writer owns
            // the surviving row and which owns its vectors are answered
            // independently of each other.
            storeConflict: await storeConflictWitness(
              db,
              STORE_NAMESPACE.join(":"),
              STORE_KEY,
              STORE_CONFLICT.markerByOwner,
              STORE_CONFLICT.vectorTextByOwner,
            ),
          }
        : {}),
      ...(projectsEffectKey
        ? {
            // Two independent sides: what each node saw of itself while running,
            // and what `checkpoint_writes` holds now. They are collected
            // separately and compared by summarize, never reconciled here.
            effects: await effectEvents(db, caseId),
            effectSites: await effectSites(db, threadForCase(caseId)),
          }
        : {}),
      relations: (await relations(db, schemas)).map((row) => row.relation),
      columns: await columns(db, schemas),
      indexes: (await indexes(db, schemas)).map((row) => `${row.schema}.${row.name}`),
      triggers: await triggers(db, schemas),
      routines: (await routines(db, schemas)).map((row) => `${row.schema}.${row.name}`),
      extensions: await extensions(db),
      checkpointLedger: await ledger(CHECKPOINT_SCHEMA, "checkpoint_migrations"),
      storeLedger: await ledger(STORE_SCHEMA, "store_migrations"),
      sharedCheckpointLedger: await ledger("lg_shared", "checkpoint_migrations"),
      sharedStoreLedger: await ledger("lg_shared", "store_migrations"),
      gateParks: (
        await db.pool.query(
          `SELECT party, gate, position, statement, ordinal FROM ${PROBE_SCHEMA}.gate_park
            WHERE case_id = $1 ORDER BY id`,
          [caseId],
        )
      ).rows,
      shutdownWitnesses: (
        await db.pool.query(
          `SELECT party, node, phase FROM ${PROBE_SCHEMA}.event
            WHERE case_id = $1 AND node = 'process' ORDER BY id`,
          [caseId],
        )
      ).rows,
    };
  });
}

async function cmdCoordinate(args: Args): Promise<Record<string, unknown>> {
  const caseId = String(args.case ?? "");
  const definition = caseById(caseId);
  if (!definition) throw new Error(`unknown case: ${caseId}`);

  const database = databaseForCase(caseId);
  const probe = openDb(appNameFor(caseId, "coord", "probe"), "probe", { database });
  const observe = openDb(appNameFor(caseId, "observe", "observe"), "observe", { database });

  return await withDb(probe, async () =>
    withDb(observe, async () => {
      // Every stage is armed BEFORE any participant starts, so a late arrival is
      // detectable rather than invisible.
      for (const stage of definition.stages) {
        await arm(probe, caseId, stage.name, stage.parties);
      }

      const barriers = [];
      const lockGraphs = [];
      const activitySamples = [];

      for (const stage of definition.stages) {
        const { arrivals, peakConcurrentParties } = await waitForArrivals(
          probe,
          caseId,
          stage.name,
          stage.parties,
        );

        if (stage.captureActivity) {
          activitySamples.push({
            stage: stage.name,
            rows: await activity(observe, `${caseId}:p`),
          });
        }
        if (stage.captureLockEdge) {
          lockGraphs.push({ stage: stage.name, graph: await waitForLockEdge(observe, `${caseId}:p`) });
        }

        const releasedAt = await release(probe, caseId, stage.name);
        barriers.push(
          summariseBarrier(stage.name, stage.parties, arrivals, peakConcurrentParties, releasedAt),
        );
      }

      return {
        case: caseId,
        barriers,
        lockGraphs,
        activity: activitySamples,
        finalLockGraph: await lockGraph(observe, `${caseId}:p`),
      };
    }),
  );
}

async function cmdRun(args: Args): Promise<Record<string, unknown>> {
  const caseId = String(args.case ?? "");
  const definition = caseById(caseId);
  if (!definition) throw new Error(`unknown case: ${caseId}`);
  const party = Number(args.party ?? 0);
  const member = `p${party}`;

  const probe = openDb(appNameFor(caseId, member, "witness"), "probe", {
    database: databaseForCase(caseId),
  });
  shutdownWitness = createProbe(probe, caseId, party, member);

  try {
    let result: Record<string, unknown>;
    if (definition.family === "S") result = await runSelftestParty({ caseId, party, member });
    else if (definition.family === "A") result = await runFamilyAParty({ caseId, party, member });
    else if (definition.family === "B") result = await runFamilyBParty({ caseId, party, member });
    else if (definition.family === "C") result = await runFamilyCParty({ caseId, party, member });
    else if (definition.family === "D") result = await runFamilyDParty({ caseId, party, member });
    else if (definition.family === "E") result = await runFamilyEParty({ caseId, party, member });
    else if (definition.family === "F") result = await runFamilyFParty({ caseId, party, member });
    else if (definition.family === "G") result = await runFamilyGParty({ caseId, party, member });
    else if (definition.family === "H") result = await runFamilyHParty({ caseId, party, member });
    else if (definition.family === "I") result = await runFamilyIParty({ caseId, party, member });
    else throw new Error(`no participant implemented for family ${definition.family}`);
    return { case: caseId, party, member, result };
  } finally {
    shutdownWitness = null;
    await probe.close().catch(() => {});
  }
}

async function cmdDrain(args: Args): Promise<Record<string, unknown>> {
  const prefix = String(args["app-prefix"] ?? "");
  const caseId = String(args.case ?? "");
  if (!prefix) throw new Error("--app-prefix is required");
  const db = openDb(appNameFor(caseId || "drain", "drain", "observe"), "observe", {
    database: caseId ? databaseForCase(caseId) : undefined,
  });
  return await withDb(db, async () => ({ prefix, ...(await waitForDrain(db, prefix)) }));
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function main(): Promise<number> {
  const { command, args } = parseArgs(process.argv.slice(2));

  const problems = validateRegistry();
  if (problems.length > 0 && command !== "manifest") {
    return emit({
      outcome: {
        status: "fault",
        fault: { step: "case-registry", message: problems.join("; ") },
      },
    });
  }

  switch (command) {
    case "cases":
      process.stdout.write(`${JSON.stringify(CASES, null, 2)}\n`);
      return 0;

    case "families":
      process.stdout.write(`${JSON.stringify({ families: FAMILIES, lanes: LANES }, null, 2)}\n`);
      return 0;

    case "manifest":
      process.stdout.write(`${JSON.stringify(imageManifest(), null, 2)}\n`);
      return 0;

    case "expand": {
      const requested = String(args.ids ?? "")
        .split(",")
        .filter((id) => id.length > 0);
      process.stdout.write(`${JSON.stringify(expandSelection(requested), null, 2)}\n`);
      return 0;
    }

    case "summarize": {
      const raw = await readStdin();
      return emit(summarize(JSON.parse(raw) as unknown[]));
    }

    case "provision":
    case "prepare":
    case "coordinate":
    case "run":
    case "awaitpark":
    case "drain":
    case "project": {
      const handlers: Record<string, (a: Args) => Promise<Record<string, unknown>>> = {
        provision: cmdProvision,
        prepare: cmdPrepare,
        coordinate: cmdCoordinate,
        run: cmdRun,
        awaitpark: cmdAwaitPark,
        drain: cmdDrain,
        project: cmdProject,
      };
      try {
        return emit(await handlers[command]!(args));
      } catch (error) {
        return emit({
          outcome: { status: "fault", fault: { step: command, ...describeError(error) } },
        });
      }
    }

    default:
      process.stderr.write(`unknown command: ${command}\n`);
      return EXIT_USAGE;
  }
}

/**
 * A worker's contract is one JSON object on stdout, then exit.
 *
 * Waiting for the event loop to drain is not good enough. A case may leave a
 * connection checked out ON PURPOSE — d18 deadlocks a pool of one to measure a
 * nested acquisition — and pg keeps that socket open forever, so the process
 * would linger until the driver's per-case timeout and report a MEASURED hang as
 * an anonymous harness fault. The measurement is already in the JSON by this
 * point; the exit just has to happen.
 *
 * stdout is flushed explicitly first: it is a pipe here, so writes are
 * asynchronous and `process.exit()` would otherwise truncate the evidence.
 */
async function flushAndExit(code: number): Promise<never> {
  await new Promise<void>((resolve) => {
    process.stdout.write("", () => resolve());
  });
  process.exit(code);
}

main()
  .then(flushAndExit)
  .catch(async (error) => {
    process.stdout.write(
      `${JSON.stringify({ outcome: { status: "fault", fault: { step: "main", ...describeError(error) } } })}\n`,
    );
    await flushAndExit(EXIT_HARNESS_FAULT);
  });
