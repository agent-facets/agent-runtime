// Family S: the harness self-test.
//
// Every mechanism the experiment families depend on is validated here first,
// against a situation whose answer is known independently of any vendor
// behaviour. If the barrier cannot prove overlap, if the gate cannot prove it
// passed vendor SQL through unchanged, or if the lock inspector cannot find an
// edge that was deliberately created, then no later concurrency claim is worth
// anything and the run must stop before it produces one.

import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { emptyCheckpoint } from "@langchain/langgraph-checkpoint";
import type { Checkpoint, CheckpointMetadata } from "@langchain/langgraph-checkpoint";

import {
  CHECKPOINT_SCHEMA,
  HARNESS_RELATIONS,
  PROBE_SCHEMA,
  checkPinnedPackages,
  embeddingFixture,
  rankingFixture,
} from "./contract.ts";
import { appNameFor, describeSqlError, openDb, type Db } from "./db.ts";
import { arrive, waitForRelease } from "./barrier.ts";
import { createProbe } from "./probe.ts";
import {
  createSink,
  instrumentPool,
  recordNodePark,
  recordPark,
  statementMultiset,
  statementShape,
  type GateSpec,
} from "./gate.ts";
import { relations } from "./inspect/pgstat.ts";
import { measureEgress } from "./inspect/egress.ts";
import { createEmbeddings, UnknownEmbeddingTextError } from "./store/embeddings.ts";

export type PartyContext = {
  caseId: string;
  party: number;
  member: string;
};

function metadata(step: number): CheckpointMetadata {
  return { source: "input", step, parents: {} } as CheckpointMetadata;
}

/** A checkpoint with one channel, so `put` emits exactly one blob statement. */
function checkpointWithChannel(value: string): { checkpoint: Checkpoint; versions: Record<string, number> } {
  const checkpoint = emptyCheckpoint();
  checkpoint.channel_values = { alpha: value };
  checkpoint.channel_versions = { alpha: 1 };
  return { checkpoint, versions: { alpha: 1 } };
}

/** The vendor operation sequence whose statement multiset the gate must not change. */
async function exerciseSaver(saver: PostgresSaver, threadId: string): Promise<void> {
  const config = { configurable: { thread_id: threadId, checkpoint_ns: "" } };
  const { checkpoint, versions } = checkpointWithChannel("one");
  const next = await saver.put(config, checkpoint, metadata(-1), versions);
  await saver.putWrites(next, [["alpha", "written"]], "task-alpha");
  await saver.getTuple(config);
  await saver.deleteThread(threadId);
}

export async function runSelftestParty(context: PartyContext): Promise<Record<string, unknown>> {
  switch (context.caseId) {
    case "s01-pins":
      return await s01(context);
    case "s02-barrier-overlap":
      return await s02(context, "gather");
    case "s03-barrier-serial-control":
      return await s02(context, `gather-${context.party}`);
    case "s04-gate-passthrough":
      return await s04(context);
    case "s05-lock-edge":
      return await s05(context);
    case "s06-embedding-oracle":
      return await s06();
    case "s07-shutdown-witness-positive-control":
      return await s07(context);
    default:
      throw new Error(`family S has no participant for case ${context.caseId}`);
  }
}

/**
 * The positive control for the shutdown witness.
 *
 * Eleven kill cases across families A, C, E, F and H assert the ABSENCE of a
 * `process/sigterm` row to prove their SIGKILL was uncatchable. Every one of
 * them used `SIGKILL`, so the handler that writes that row had never fired
 * anywhere in the matrix — the witness was empty in all 131 cases, and an oracle
 * that was never attached reads exactly like an oracle that found nothing. This
 * case is the one place a `SIGTERM` is delivered, so those eleven absences mean
 * something.
 *
 * It parks on a durable `gate_park` row like any other kill case; the registry
 * gives it `signal: "TERM"` instead of `SIGKILL`.
 */
async function s07(context: PartyContext): Promise<Record<string, unknown>> {
  const probe = openDb(appNameFor(context.caseId, context.member, "witness"), "probe");
  try {
    await recordNodePark(probe, context.caseId, context.party, "await-sigterm", "selftest");
    // The driver kills this container here. `main.ts` installs the SIGTERM
    // handler, which records the row and exits 143.
    await new Promise<never>(() => {});
    return { party: context.party, error: null, parked: true };
  } finally {
    await probe.close().catch(() => {});
  }
}

async function s01(context: PartyContext): Promise<Record<string, unknown>> {
  const inspect = openDb(appNameFor(context.caseId, context.member, "inspect"), "inspect");
  try {
    const present = await relations(inspect, [PROBE_SCHEMA]);
    const names = new Set(present.map((row) => row.relation));
    const pins = checkPinnedPackages();
    return {
      pins,
      pinsAgree: pins.every((pin) => pin.matches),
      relations: present.map((row) => row.relation),
      harnessRelationsPresent: HARNESS_RELATIONS.every((name) => names.has(name)),
      missingHarnessRelations: HARNESS_RELATIONS.filter((name) => !names.has(name)),
      egress: await measureEgress(),
    };
  } finally {
    await inspect.close();
  }
}

async function s02(context: PartyContext, barrierName: string): Promise<Record<string, unknown>> {
  const probe = openDb(appNameFor(context.caseId, context.member, "probe"), "probe");
  try {
    const witness = createProbe(probe, context.caseId, context.party, context.member);
    await witness.record("party", "started");
    await arrive(probe, context.caseId, barrierName, context.party, context.member, witness.nonce);
    await witness.record("party", "arrived", { barrier: barrierName });
    await waitForRelease(probe, context.caseId, barrierName);
    await witness.record("party", "released", { barrier: barrierName });
    return { party: context.party, barrier: barrierName, arrived: true, released: true };
  } finally {
    await probe.close();
  }
}

async function s04(context: PartyContext): Promise<Record<string, unknown>> {
  const probe = openDb(appNameFor(context.caseId, context.member, "probe"), "probe");
  const ungated = openDb(appNameFor(context.caseId, context.member, "subject"), "subject");
  const gated = openDb(appNameFor(context.caseId, context.member, "subject"), "subject");

  const ungatedSink = createSink();
  const gatedSink = createSink();

  const gates: GateSpec[] = [
    { name: "blob-upsert-post", label: "ckpt.blob-upsert", ordinal: 1, position: "post" },
    { name: "commit-post", label: "txn.commit", ordinal: 1, position: "post" },
  ];

  try {
    instrumentPool(ungated.pool, ungatedSink, [], async () => {});
    const gatedInstrumentation = instrumentPool(gated.pool, gatedSink, gates, async (gate, statement) => {
      // Armed and released immediately: the point is that a gate which parks
      // nothing must still leave the emitted SQL untouched.
      await recordPark(probe, context.caseId, context.party, gate, statement);
    });

    const setupSaver = new PostgresSaver(ungated.pool, undefined, { schema: CHECKPOINT_SCHEMA });
    await setupSaver.setup();

    // The multiset is compared only over the operation phase; `setup()` is not
    // idempotent in statement count and would make the two phases differ for a
    // reason that has nothing to do with the gate.
    ungatedSink.statements.length = 0;
    ungatedSink.counters.clear();

    await exerciseSaver(setupSaver, `${context.caseId}-ungated`);
    const ungatedMultiset = statementMultiset(ungatedSink);
    const ungatedShape = statementShape(ungatedSink);

    const gatedSaver = new PostgresSaver(gated.pool, undefined, { schema: CHECKPOINT_SCHEMA });
    await exerciseSaver(gatedSaver, `${context.caseId}-gated`);
    const gatedMultiset = statementMultiset(gatedSink);
    const gatedShape = statementShape(gatedSink);

    const unclassified = [...ungatedSink.statements, ...gatedSink.statements].filter(
      (statement) => statement.label === "unclassified",
    ).length;

    // Read back durably rather than trusting the in-process counter: a kill case
    // has nothing but these rows, so the mechanism they depend on is proven here.
    const { rows: parks } = await probe.pool.query<{ gate: string; statement: string }>(
      `SELECT gate, statement FROM ${PROBE_SCHEMA}.gate_park
        WHERE case_id = $1 ORDER BY id`,
      [context.caseId],
    );

    return {
      ungatedMultiset,
      gatedMultiset,
      multisetsIdentical: JSON.stringify(ungatedMultiset) === JSON.stringify(gatedMultiset),
      shapesIdentical: JSON.stringify(ungatedShape) === JSON.stringify(gatedShape),
      unclassifiedStatements: unclassified,
      gatesDeclared: gates.map((gate) => gate.name),
      gatesReached: gatedInstrumentation.reached(),
      gatesUnreached: gatedInstrumentation.unreached(),
      durableParks: parks,
    };
  } finally {
    await Promise.allSettled([ungated.close(), gated.close(), probe.close()]);
  }
}

async function s05(context: PartyContext): Promise<Record<string, unknown>> {
  const probe = openDb(appNameFor(context.caseId, context.member, "probe"), "probe");
  // A lock wait must be allowed to wait: the default bounded statement timeout
  // would turn the measurement into an anonymous 57014 before the coordinator
  // could capture the edge.
  const subject = openDb(appNameFor(context.caseId, context.member, "subject"), "subject", {
    max: 1,
    statementTimeoutMs: 60_000,
  });

  try {
    const witness = createProbe(probe, context.caseId, context.party, context.member);

    if (context.party === 0) {
      await subject.pool.query(
        `INSERT INTO ${PROBE_SCHEMA}.conflict (key, value) VALUES ('lock-edge', 'seed')
         ON CONFLICT (key) DO NOTHING`,
      );
      const client = await subject.pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          `UPDATE ${PROBE_SCHEMA}.conflict SET value = 'p0' WHERE key = 'lock-edge'`,
        );
        const { rows } = await client.query<{ txid: string }>(
          "SELECT txid_current()::text AS txid",
        );
        await witness.record("holder", "locked", { txid: rows[0]?.txid ?? null });
        await arrive(
          probe,
          context.caseId,
          "ready",
          context.party,
          context.member,
          witness.nonce,
          rows[0]?.txid ?? null,
        );
        await waitForRelease(probe, context.caseId, "ready");
        await arrive(probe, context.caseId, "hold", context.party, context.member, witness.nonce);
        await waitForRelease(probe, context.caseId, "hold");
        await client.query("COMMIT");
      } finally {
        client.release();
      }
      return { party: 0, role: "holder", committed: true };
    }

    await arrive(probe, context.caseId, "ready", context.party, context.member, witness.nonce);
    await waitForRelease(probe, context.caseId, "ready");
    const client = await subject.pool.connect();
    const started = Date.now();
    try {
      await client.query("BEGIN");
      await witness.record("waiter", "attempting");
      await client.query(
        `UPDATE ${PROBE_SCHEMA}.conflict SET value = 'p1' WHERE key = 'lock-edge'`,
      );
      await client.query("COMMIT");
      await witness.record("waiter", "acquired");
      return { party: context.party, role: "waiter", blocked: true, error: null };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      return {
        party: context.party,
        role: "waiter",
        blocked: true,
        error: describeSqlError(error),
        waitedMs: Date.now() - started,
      };
    } finally {
      client.release();
    }
  } finally {
    await Promise.allSettled([subject.close(), probe.close()]);
  }
}

/**
 * A fixture self-check, not a Store test.
 *
 * The authored orderings in fixtures/rankings.json are the independent oracle
 * every family D ordering claim rests on. Recomputing them here with plain
 * arithmetic — sharing no code with the Store's SQL — is what makes "the
 * fixture is correct" a measured statement rather than an assumption.
 */
async function s06(): Promise<Record<string, unknown>> {
  const { dims, vectors } = embeddingFixture();
  const rankings = rankingFixture() as {
    query: string;
    corpus: string[];
    expected_order: Record<string, string[]>;
  };

  const query = vectors[rankings.query];
  if (!query) throw new Error("ranking fixture names a query with no vector");

  const dot = (a: number[], b: number[]): number => a.reduce((sum, x, i) => sum + x * (b[i] ?? 0), 0);
  const norm = (a: number[]): number => Math.sqrt(dot(a, a));
  const l2 = (a: number[], b: number[]): number =>
    Math.sqrt(a.reduce((sum, x, i) => sum + (x - (b[i] ?? 0)) ** 2, 0));

  const order = (score: (v: number[]) => number, ascending: boolean): string[] =>
    [...rankings.corpus]
      .map((name) => ({ name, value: score(vectors[name]!) }))
      .sort((left, right) => (ascending ? left.value - right.value : right.value - left.value))
      .map((entry) => entry.name);

  const computed = {
    cosine: order((v) => dot(query, v) / (norm(query) * norm(v)), false),
    l2: order((v) => l2(query, v), true),
    inner_product: order((v) => dot(query, v), false),
  };

  const embeddings = createEmbeddings();
  let refusedUnknownText = false;
  try {
    await embeddings.embedQuery("text-that-is-not-in-the-fixture");
  } catch (error) {
    refusedUnknownText = error instanceof UnknownEmbeddingTextError;
  }

  const orders = Object.values(computed).map((value) => JSON.stringify(value));
  const pairwiseDistinct = new Set(orders).size === orders.length;

  return {
    dims,
    corpusPresent: rankings.corpus.every((name) => Array.isArray(vectors[name])),
    dimsConsistent: rankings.corpus.every((name) => vectors[name]?.length === dims),
    computedOrder: computed,
    authoredOrder: rankings.expected_order,
    ordersAgree: (["cosine", "l2", "inner_product"] as const).every(
      (metric) =>
        JSON.stringify(computed[metric]) === JSON.stringify(rankings.expected_order[metric]),
    ),
    ordersPairwiseDistinct: pairwiseDistinct,
    refusedUnknownText,
  };
}

export async function provisionSelftest(db: Db): Promise<void> {
  await db.pool.query(
    `INSERT INTO ${PROBE_SCHEMA}.conflict (key, value) VALUES ('lock-edge', 'seed')
     ON CONFLICT (key) DO NOTHING`,
  );
}
