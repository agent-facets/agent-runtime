// The container entrypoint.
//
// One process, one command, one JSON object on stdout. The container writes no
// file and mounts nothing: the only thing it shares with any other container is
// Postgres, which is what makes "resumed in a fresh process from persisted state
// alone" structurally true rather than merely asserted.

import { hostname } from "node:os";
import {
  Annotation,
  Command,
  END,
  MemorySaver,
  START,
  StateGraph,
} from "@langchain/langgraph";
import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";

import {
  CHECKPOINT_SCHEMA,
  EXPECTED_RELATIONS,
  PROBE_SCHEMA,
  RESUME_DECISION,
  TIMEOUTS,
  checkPinnedPackages,
  imageManifest,
} from "./contract.ts";
import { connectionString, openDb, waitForDb } from "./db.ts";
import { PROBE_DDL, createProbe, type Probe } from "./probe.ts";
import { CASES, findCase, type CaseDef } from "./cases.ts";
import { buildGraph, initialInput } from "./graphs.ts";
import { GatedSaver } from "./gated.ts";
import {
  backendsNamed,
  deleteHeadWrites,
  measureEgress,
  project,
  rootHead,
  type Projection,
} from "./inspect.ts";
import { sanitizeText } from "./canonical.ts";
import { EXIT_HARNESS_FAULT, EXIT_USAGE, emit } from "./evidence.ts";
import { summarize } from "./summarize.ts";

type Stage = "control" | "primary" | "resume";

// The graceful-shutdown witness, registered at module scope so EVERY subcommand
// is signal-responsive. Registered only for `run` it would leave `await`,
// `mutate` and `setup` containers immune to the driver's own timeout, which
// signals the Docker client and relies on PID 1 honouring SIGTERM.
let shutdownProbe: Probe | null = null;
let shuttingDown = false;
process.on("SIGTERM", () => {
  if (shuttingDown) return;
  shuttingDown = true;
  const finish = () => process.exit(0);
  if (!shutdownProbe) return finish();
  void shutdownProbe.record("process", "graceful-sigterm").catch(() => undefined).then(finish);
});

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

function requireArg(name: string): string {
  const value = arg(name);
  if (!value) {
    process.stderr.write(`missing --${name}\n`);
    process.exit(EXIT_USAGE);
  }
  return value;
}

function describeError(error: unknown): { name: string; message: string } {
  const err = error as { name?: string; message?: string };
  return {
    name: sanitizeText(String(err?.name ?? "Error")),
    message: sanitizeText(String(err?.message ?? error)),
  };
}

function isInterruptedResult(result: unknown): boolean {
  const value = (result as Record<string, unknown> | null)?.["__interrupt__"];
  return Array.isArray(value) && value.length > 0;
}

// ---------------------------------------------------------------------------

async function cmdSetup(): Promise<number> {
  const db = openDb("setup");
  await waitForDb(db, 60_000);
  await db.pool.query(PROBE_DDL);
  await db.pool.query(`CREATE SCHEMA IF NOT EXISTS ${CHECKPOINT_SCHEMA}`);

  // Only this command calls setup(). Read from source, not measured here: the
  // checkpointer's migration loop is a read-then-DDL-then-insert sequence with
  // no advisory lock, so racing it would be a concurrency question — which is
  // the sibling spike's subject, not this one's.
  const saver = PostgresSaver.fromConnString(connectionString("setup:checkpointer"), {
    schema: CHECKPOINT_SCHEMA,
  });
  await saver.setup();
  await saver.end();

  const relations = await db.pool.query<{ nspname: string; relname: string }>(
    `SELECT n.nspname, c.relname
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname IN ($1, $2) AND c.relkind IN ('r', 'p')
      ORDER BY n.nspname, c.relname`,
    [CHECKPOINT_SCHEMA, PROBE_SCHEMA],
  );
  const observed = relations.rows.map((row) => `${row.nspname}.${row.relname}`);

  // `SHOW server_version` returns a column named `server_version`, not `v`. The
  // previous alias silently produced null and the database under test went
  // unrecorded, so this reads an explicitly aliased setting instead.
  const version = await db.pool.query<{ v: string }>(
    "SELECT current_setting('server_version') AS v",
  );
  const serverVersion = version.rows[0]?.v ?? null;

  const missing = EXPECTED_RELATIONS.filter((name) => !observed.includes(name));
  const outcome =
    missing.length > 0
      ? {
          status: "fault" as const,
          fault: { step: "setup-relations", message: `missing: ${missing.join(", ")}` },
        }
      : serverVersion === null
        ? {
            status: "fault" as const,
            fault: { step: "setup-version", message: "server version not recorded" },
          }
        : { status: "pass" as const };

  const code = emit({
    command: "setup",
    packages: checkPinnedPackages(),
    manifest: imageManifest(),
    serverVersion,
    relations: observed,
    expectedRelations: EXPECTED_RELATIONS,
    egress: await measureEgress(),
    outcome,
  });
  await db.close();
  return code;
}

// ---------------------------------------------------------------------------

function buildSaver(
  def: CaseDef,
  appName: string,
  stage: Stage,
): { saver: BaseCheckpointSaver; close: () => Promise<void> } {
  if (def.saver === "memory") {
    return { saver: new MemorySaver(), close: async () => {} };
  }
  const inner = PostgresSaver.fromConnString(connectionString(appName), {
    schema: CHECKPOINT_SCHEMA,
  });
  // The gate exists only to hold the crash window open in the process that is
  // about to be killed. Leaving it armed on the resume would hold that run's
  // own persistence open forever, and because nothing else keeps a handle
  // alive the process would then exit silently with an empty event loop —
  // producing exit 0 and no evidence at all.
  if (!def.gate || stage !== "primary") {
    return { saver: inner, close: () => inner.end() };
  }
  return { saver: new GatedSaver(inner), close: () => inner.end() };
}

async function runGateProbe(def: CaseDef, appName: string): Promise<Record<string, unknown>> {
  const inner = PostgresSaver.fromConnString(connectionString(appName), {
    schema: CHECKPOINT_SCHEMA,
  });
  const saver = new GatedSaver(inner);

  let secondStarted = false;
  const State = Annotation.Root({ value: Annotation<string> });
  const graph = new StateGraph(State)
    .addNode("first", () => ({ value: "first" }))
    .addNode("second", () => {
      secondStarted = true;
      return { value: "second" };
    })
    .addEdge(START, "first")
    .addEdge("first", "second")
    .addEdge("second", END)
    .compile({ checkpointer: saver });

  const execution = graph.invoke(
    { value: "input" },
    { configurable: { thread_id: def.id }, durability: def.gateProbe ?? "sync" },
  );

  await saver.held;

  // Observed over a bounded interval rather than a single macrotask. One tick
  // can only distinguish "did not start yet" from "started"; a run that
  // dispatched late would read as blocked. Under `async` the same window must
  // show the dispatch, which is what proves the window is wide enough to see
  // one at all.
  const deadline = Date.now() + TIMEOUTS.gateObservationMs;
  let startedWithinWindow = false;
  while (Date.now() < deadline) {
    if (secondStarted) {
      startedWithinWindow = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, TIMEOUTS.gatePollMs));
  }

  saver.release();
  const finalState = await execution;
  await inner.end();

  return {
    gate: {
      durability: def.gateProbe,
      observationMs: TIMEOUTS.gateObservationMs,
      secondStartedWhileHeld: startedWithinWindow,
      secondStartedAfterRelease: secondStarted,
      firstGatedTaskId: saver.firstGatedTaskId,
      finalState,
    },
  };
}

async function cmdRun(): Promise<number> {
  const caseId = requireArg("case");
  const stage = requireArg("stage") as Stage;
  const def = findCase(caseId);
  const threadId = caseId;
  const appName = `${caseId}:${stage}`;

  const probeDb = openDb(`probe:${appName}`);
  await waitForDb(probeDb, 60_000);
  const probe = createProbe(probeDb, threadId, caseId, stage);
  shutdownProbe = probe;

  if (def.gateProbe) {
    const gateResult = await runGateProbe(def, `ckpt:${appName}`);
    const projection = await project(probeDb, threadId);
    const code = emit({
      command: "run",
      case: caseId,
      stage,
      container: hostname(),
      pid: process.pid,
      nonce: probe.nonce,
      packages: checkPinnedPackages(),
      egress: await measureEgress(),
      ...gateResult,
      final: projection,
      outcome: { status: "pass" },
    });
    await probeDb.close();
    return code;
  }

  if (stage !== "primary") {
    // The killed process parked on a latch inside a node; the replay of that
    // node must be able to complete.
    await probe.releaseAllLatches();
  }

  const { saver, close } = buildSaver(def, `ckpt:${appName}`, stage);
  const graph = buildGraph(def.graph, probe).compile({ checkpointer: saver });

  // What a fresh process can see BEFORE it is told anything. This is the
  // rediscovery witness for the interrupt case.
  const beforeResume: Projection | null =
    stage === "resume" ? await project(probeDb, threadId) : null;

  const config: Record<string, unknown> = {
    configurable: { thread_id: threadId },
    durability: def.durability,
    recursionLimit: 25,
  };

  let input: unknown = initialInput(def.graph);
  if (stage === "resume") {
    if (def.resume === "null") input = null;
    else if (def.resume === "command") input = new Command({ resume: RESUME_DECISION });
    else if (def.resume === "command-false") input = new Command({ resume: false });
    else if (def.resume === "input") input = initialInput(def.graph);
    else if (def.resume === "checkpoint-id") {
      input = null;
      (config.configurable as Record<string, unknown>).checkpoint_id = requireArg("checkpoint-id");
    }
  }

  let finalState: unknown = null;
  let interrupted = false;
  let error: { name: string; message: string } | null = null;

  try {
    finalState = await graph.invoke(input as never, config);
    interrupted = isInterruptedResult(finalState);

    // The same-process control: raise and resume without ever leaving the
    // process, which is what the fresh-process witness must be able to reject.
    if (stage === "control" && def.resume === "command" && interrupted) {
      finalState = await graph.invoke(
        new Command({ resume: RESUME_DECISION }) as never,
        config,
      );
      interrupted = isInterruptedResult(finalState);
    }
  } catch (caught) {
    error = describeError(caught);
  }

  if (def.holdAfterInvoke && stage === "primary" && error === null) {
    await probe.record("process", "paused", { interrupted });
    // Park so a genuinely paused process can be killed. The latch is never
    // released before the kill, and the driver waits for the `parked` row
    // rather than for this one — an intent to park is not a park.
    await probe.waitLatch("hold", TIMEOUTS.latchWaitMs);
  }

  const projection = await project(probeDb, threadId);
  const code = emit({
    command: "run",
    case: caseId,
    stage,
    container: hostname(),
    pid: process.pid,
    nonce: probe.nonce,
    durability: def.durability,
    packages: checkPinnedPackages(),
    egress: await measureEgress(),
    invoke: { finalState, interrupted, error },
    beforeResume: beforeResume
      ? {
          interrupts: beforeResume.interrupts,
          checkpoints: beforeResume.checkpoints.length,
        }
      : null,
    final: projection,
    outcome: error === null ? { status: "pass" } : { status: "pass", ranWithError: true },
  });

  await close();
  await probeDb.close();
  return code;
}

// ---------------------------------------------------------------------------

function conditionMet(def: CaseDef, projection: Projection): boolean {
  const condition = def.awaitCondition;
  if (!condition) return true;

  if (condition.parkedNode) {
    const parked = projection.events.some(
      (event) => event.node === condition.parkedNode && event.phase === "parked",
    );
    if (!parked) return false;
  }
  if (condition.interruptWrite) {
    // Scoped to the root head: a resolved historical interrupt from an earlier
    // superstep would otherwise satisfy the condition and the kill would land
    // in a window the experiment is not describing.
    const head = rootHead(projection);
    if (!head) return false;
    const pending = projection.interrupts.filter(
      (row) => row.checkpoint_id === head.checkpoint_id && row.checkpoint_ns === head.checkpoint_ns,
    );
    if (pending.length === 0) return false;
  }
  if (condition.forbidNodeEnter) {
    const entered = projection.events.some(
      (event) => event.node === condition.forbidNodeEnter && event.phase === "enter",
    );
    if (entered) return false;
  }
  if (condition.minPendingWrites !== undefined) {
    const head = rootHead(projection);
    if (!head) return false;
    // Writes belonging to the CURRENT superstep, i.e. the completed sibling's
    // durable write. Counting all writes would be satisfied by an earlier node
    // and the kill would land in an uninteresting window. Removing this does
    // not change the measured outcome on a fast host — it is a determinism
    // guard, not the mechanism producing the result.
    const current = projection.writes.filter(
      (write) =>
        write.checkpoint_id === head.checkpoint_id && !write.channel.startsWith("__"),
    );
    if (current.length < condition.minPendingWrites) return false;
  }
  return true;
}

async function cmdAwait(): Promise<number> {
  const caseId = requireArg("case");
  const def = findCase(caseId);
  const timeoutMs = Number(arg("timeout") ?? TIMEOUTS.conditionWaitMs);

  const db = openDb(`await:${caseId}`);
  await waitForDb(db, 60_000);

  const deadline = Date.now() + timeoutMs;
  let projection = await project(db, caseId);
  while (!conditionMet(def, projection)) {
    if (Date.now() > deadline) {
      const code = emit({
        command: "await",
        case: caseId,
        outcome: {
          status: "fault",
          fault: {
            step: "await-condition",
            message: `condition not met within ${timeoutMs}ms`,
          },
        },
        frozen: projection,
      });
      await db.close();
      return code;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
    projection = await project(db, caseId);
  }

  const head = rootHead(projection);
  const code = emit({
    command: "await",
    case: caseId,
    condition: def.awaitCondition,
    latestCheckpointId: head?.checkpoint_id ?? null,
    checkpointsAtKill: projection.checkpoints.length,
    loopCheckpointsAtKill: projection.checkpoints.filter((row) => row.source === "loop").length,
    writesAtHead: head
      ? projection.writes.filter((row) => row.checkpoint_id === head.checkpoint_id).length
      : -1,
    frozen: projection,
    outcome: { status: "pass" },
  });
  await db.close();
  return code;
}

// ---------------------------------------------------------------------------

async function cmdMutate(): Promise<number> {
  const caseId = requireArg("case");
  const def = findCase(caseId);
  const db = openDb(`mutate:${caseId}`);
  await waitForDb(db, 60_000);

  let removed = 0;
  if (def.mutate === "delete-writes") removed = await deleteHeadWrites(db, caseId);

  const code = emit({
    command: "mutate",
    case: caseId,
    action: def.mutate,
    removed,
    outcome:
      removed > 0
        ? { status: "pass" }
        : {
            status: "fault",
            fault: { step: "mutate", message: "the mutation removed no rows" },
          },
  });
  await db.close();
  return code;
}

async function cmdBackends(): Promise<number> {
  const prefix = requireArg("app-prefix");
  const db = openDb("backends");
  await waitForDb(db, 60_000);

  // A SIGKILL leaves no FIN, so the server-side backend can outlive the
  // container until its TCP session decays. Waiting for it to disappear is what
  // makes "the killed process is gone" true at the database, not just at Docker.
  const deadline = Date.now() + 30_000;
  let count = await backendsNamed(db, prefix);
  while (count > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    count = await backendsNamed(db, prefix);
  }

  const code = emit({
    command: "backends",
    appPrefix: prefix,
    count,
    outcome: { status: "pass" },
  });
  await db.close();
  return code;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function cmdSummarize(): Promise<number> {
  const raw = await readStdin();
  return emit(summarize(JSON.parse(raw)));
}

// ---------------------------------------------------------------------------

async function main(): Promise<number> {
  const command = process.argv[2];
  if (command === "cases") {
    process.stdout.write(`${JSON.stringify(CASES, null, 2)}\n`);
    return 0;
  }
  if (command === "manifest") {
    process.stdout.write(`${JSON.stringify(imageManifest(), null, 2)}\n`);
    return 0;
  }
  if (command === "setup") return cmdSetup();
  if (command === "run") return cmdRun();
  if (command === "await") return cmdAwait();
  if (command === "mutate") return cmdMutate();
  if (command === "backends") return cmdBackends();
  if (command === "summarize") return cmdSummarize();
  process.stderr.write(`unknown command: ${String(command)}\n`);
  return EXIT_USAGE;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    const described = describeError(error);
    emit({
      outcome: {
        status: "fault",
        fault: { step: "uncaught", message: `${described.name}: ${described.message}` },
      },
    });
    process.exitCode = EXIT_HARNESS_FAULT;
  });
