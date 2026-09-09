// Ordinary tests for the mechanics. Not an acceptance framework.
//
// Every test runs against the real Neo4j store, because "it persists" is the
// claim under test and an in-memory substitute would not be evidence for it.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { after, before, beforeEach, test } from "node:test";

import { BudgetExceeded, assemble, emptyContext } from "./context.ts";
import { completeTurn, prepareTurn, runTurn } from "./memory.ts";
import { StaleContext, Store } from "./store.ts";

let store: Store;

before(async () => {
  store = await Store.connect();
  await store.setup();
});

after(async () => {
  await store.close();
});

beforeEach(async () => {
  await store.reset();
});

const at = (turnId: number) => ({ runId: "test", turnId });

test("an observation survives a save and reload", async () => {
  await store.putKnowledge("k:rotation", "Rotate credentials every 30 days.");
  await store.declareWorkItem("wi:one", [{ id: "k:rotation", pinned: true }]);

  const first = await prepareTurn(store, "wi:one", at(1));
  await completeTurn(store, first, [
    { op: "remember", id: "o:owner", text: "Platform team owns rotation.", basis: ["k:rotation"] },
  ]);

  const second = await prepareTurn(store, "wi:one", at(2));
  assert.equal(second.context.observations.length, 1);
  assert.equal(second.context.observations[0].text, "Platform team owns rotation.");
  assert.match(second.assembled.text, /Platform team owns rotation/);
});

test("remember replaces by id, forget removes", async () => {
  await store.declareWorkItem("wi:one", []);

  const t1 = await prepareTurn(store, "wi:one", at(1));
  await completeTurn(store, t1, [{ op: "remember", id: "o:a", text: "first" }]);

  const t2 = await prepareTurn(store, "wi:one", at(2));
  await completeTurn(store, t2, [{ op: "remember", id: "o:a", text: "second" }]);

  const t3 = await prepareTurn(store, "wi:one", at(3));
  assert.equal(t3.context.observations.length, 1);
  assert.equal(t3.context.observations[0].text, "second");

  await completeTurn(store, t3, [{ op: "forget", id: "o:a" }]);
  const t4 = await prepareTurn(store, "wi:one", at(4));
  assert.equal(t4.context.observations.length, 0);
});

test("a citation the context does not hold is refused", async () => {
  await store.declareWorkItem("wi:one", []);
  const turn = await prepareTurn(store, "wi:one", at(1));
  const result = await completeTurn(store, turn, [
    { op: "remember", id: "o:a", text: "grounded in nothing", basis: ["k:invented"] },
  ]);

  assert.equal(result.applied.length, 0);
  assert.equal(result.rejected[0].code, "BASIS_UNKNOWN");
  assert.equal(result.context.observations.length, 0);
});

test("the budget drops the oldest observations and never the pins", () => {
  const context = emptyContext("wi:one");
  context.knowledge = [
    { id: "k:pin", revision: 1, text: "Pinned constraint.", pinned: true },
  ];
  context.observations = Array.from({ length: 40 }, (_, index) => ({
    id: `o:${String(index).padStart(2, "0")}`,
    text: `observation ${index}`,
    source: { runId: "test", turnId: index },
    basis: [],
    updatedAtTurn: index,
  }));

  const assembled = assemble(context);
  assert.equal(assembled.includedObservations.length, 32);
  assert.equal(assembled.excludedObservations.length, 8);
  // Most recent kept, oldest dropped.
  assert.ok(assembled.includedObservations.includes("o:39"));
  assert.ok(assembled.excludedObservations.some((e) => e.id === "o:00"));
  assert.match(assembled.text, /Pinned constraint/);
  assert.ok(assembled.bytes <= 4096);
});

test("pins that cannot fit raise rather than silently vanish", () => {
  const context = emptyContext("wi:one");
  context.knowledge = [
    { id: "k:huge", revision: 1, text: "x".repeat(8000), pinned: true },
  ];
  assert.throws(() => assemble(context), BudgetExceeded);
});

test("a changed knowledge revision invalidates the note written against it", async () => {
  await store.putKnowledge("k:rotation", "Rotate every 30 days.");
  await store.declareWorkItem("wi:one", [{ id: "k:rotation", pinned: true }]);

  const t1 = await prepareTurn(store, "wi:one", at(1));
  await completeTurn(store, t1, [
    { op: "remember", id: "o:plan", text: "Plan assumes 30 days.", basis: ["k:rotation"] },
  ]);

  await store.putKnowledge("k:rotation", "Rotate every 7 days.");

  const t2 = await prepareTurn(store, "wi:one", at(2));
  assert.equal(t2.context.observations.length, 0);
  assert.ok(t2.dropped.some((d) => d.id === "o:plan" && d.reason.startsWith("BASIS_STALE")));
  assert.match(t2.assembled.text, /Rotate every 7 days/);
  assert.doesNotMatch(t2.assembled.text, /Plan assumes 30 days/);
});

test("withdrawn knowledge stops being presented", async () => {
  await store.putKnowledge("k:old", "Superseded rule.");
  await store.declareWorkItem("wi:one", [{ id: "k:old", pinned: true }]);

  const t1 = await prepareTurn(store, "wi:one", at(1));
  assert.match(t1.assembled.text, /Superseded rule/);

  await store.withdrawKnowledge("k:old");

  const t2 = await prepareTurn(store, "wi:one", at(2));
  assert.equal(t2.context.knowledge.length, 0);
  assert.doesNotMatch(t2.assembled.text, /Superseded rule/);
  assert.ok(t2.dropped.some((d) => d.id === "k:old" && d.reason === "WITHDRAWN"));
});

test("one work item's context never appears in another", async () => {
  await store.declareWorkItem("wi:one", []);
  await store.declareWorkItem("wi:two", []);

  const t1 = await prepareTurn(store, "wi:one", at(1));
  await completeTurn(store, t1, [{ op: "remember", id: "o:secret", text: "only for one" }]);

  const other = await prepareTurn(store, "wi:two", at(1));
  assert.equal(other.context.observations.length, 0);
  assert.doesNotMatch(other.assembled.text, /only for one/);
});

test("a stale writer is refused instead of overwriting", async () => {
  await store.declareWorkItem("wi:one", []);

  const a = await prepareTurn(store, "wi:one", at(1));
  const b = await prepareTurn(store, "wi:one", at(1));

  await completeTurn(store, a, [{ op: "remember", id: "o:a", text: "from a" }]);
  await assert.rejects(
    () => completeTurn(store, b, [{ op: "remember", id: "o:b", text: "from b" }]),
    StaleContext,
  );

  const after = await prepareTurn(store, "wi:one", at(2));
  assert.deepEqual(after.context.observations.map((o) => o.id), ["o:a"]);
});

test("memory operations cannot reach the knowledge plane", async () => {
  await store.putKnowledge("k:rule", "Original rule.");
  await store.declareWorkItem("wi:one", [{ id: "k:rule", pinned: true }]);

  const turn = await prepareTurn(store, "wi:one", at(1));
  const result = await completeTurn(store, turn, [
    { op: "remember", id: "o:a", text: "Rewriting the rule.", basis: ["k:rule"] },
    // Not part of the operation type; a model emitting it must be refused.
    { op: "canonize", id: "k:rule", text: "Rule is now whatever I say." } as never,
  ]);

  assert.equal(result.rejected.length, 1);
  assert.equal(result.rejected[0].code, "OP_UNKNOWN");

  const knowledge = await store.readKnowledge(["k:rule"]);
  assert.equal(knowledge.get("k:rule")!.text, "Original rule.");
  assert.equal(knowledge.get("k:rule")!.revision, 1);
});

test("a fresh process resumes from the work item id alone", async () => {
  await store.putKnowledge("k:rotation", "Rotate every 30 days.");
  await store.declareWorkItem("wi:resume", [{ id: "k:rotation", pinned: true }]);

  await runTurn(store, "wi:resume", at(1), "first turn", async () => ({
    reply: "noted",
    ops: [
      { op: "remember", id: "o:decision", text: "Chose the staged rollout.", basis: ["k:rotation"] },
    ],
  }));

  // A separate process, given nothing but the id. No transcript is passed.
  const output = execFileSync(process.execPath, ["src/continue.ts", "wi:resume"], {
    encoding: "utf8",
    env: process.env,
  });
  const resumed = JSON.parse(output);

  assert.equal(resumed.revision, 1);
  assert.deepEqual(resumed.observations, ["o:decision"]);
  assert.match(resumed.context, /Chose the staged rollout/);
  assert.match(resumed.context, /Rotate every 30 days/);
});

test("revisions accumulate one per turn", async () => {
  await store.declareWorkItem("wi:one", []);
  for (let turn = 1; turn <= 3; turn += 1) {
    await runTurn(store, "wi:one", at(turn), "go", async () => ({
      reply: "ok",
      ops: [{ op: "remember", id: `o:${turn}`, text: `turn ${turn}` }],
    }));
  }
  assert.equal(await store.revisionCount("wi:one"), 3);
});
