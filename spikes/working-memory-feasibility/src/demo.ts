// A scripted four-turn run.
//
// The client is a fixed script, not a model: this shows the mechanism, and it
// makes no claim about model behaviour. Between turns 2 and 3 the knowledge
// record moves, so the note written against the old revision is dropped.
//
//   node src/demo.ts

import type { MemoryOp } from "./context.ts";
import type { TurnClient } from "./memory.ts";
import { runTurn } from "./memory.ts";
import { Store } from "./store.ts";

const WORK_ITEM = "wi:demo";

const script: Record<number, { reply: string; ops: MemoryOp[] }> = {
  1: {
    reply: "Read the rotation requirement.",
    ops: [
      {
        op: "remember",
        id: "o:scope",
        text: "Rotation covers the deploy keys only.",
        basis: ["k:rotation"],
      },
    ],
  },
  2: {
    reply: "Drafted the rollout.",
    ops: [
      {
        op: "remember",
        id: "o:plan",
        text: "Staged rollout: staging first, then production.",
        basis: ["k:rotation"],
      },
    ],
  },
  3: {
    reply: "Noticed the requirement moved; re-planning.",
    ops: [
      {
        op: "remember",
        id: "o:plan",
        text: "Rollout compressed to a single window.",
        basis: ["k:rotation"],
      },
      { op: "forget", id: "o:gone" },
    ],
  },
  4: { reply: "Done.", ops: [] },
};

const client: TurnClient = async ({ at }) => script[at.turnId] ?? { reply: "…", ops: [] };

const store = await Store.connect();
try {
  await store.setup();
  await store.reset();

  await store.putKnowledge("k:rotation", "Deploy credentials rotate every 30 days.");
  await store.putKnowledge("k:owner", "The platform team owns credential policy.");
  await store.declareWorkItem(WORK_ITEM, [
    { id: "k:rotation", pinned: true },
    { id: "k:owner", pinned: false },
  ]);

  for (const turn of [1, 2, 3, 4]) {
    if (turn === 3) {
      await store.putKnowledge("k:rotation", "Deploy credentials rotate every 7 days.");
    }

    const record = await runTurn(store, WORK_ITEM, { runId: "demo", turnId: turn }, "continue", client);

    process.stdout.write(`\n=== turn ${turn} → context revision ${record.revision} ===\n`);
    process.stdout.write(`${record.contextText}\n`);
    if (record.dropped.length > 0) {
      process.stdout.write(`dropped:  ${record.dropped.map((d) => `${d.id} (${d.reason})`).join(", ")}\n`);
    }
    if (record.rejected.length > 0) {
      process.stdout.write(`refused:  ${record.rejected.map((r) => `${r.code} ${r.detail}`).join(", ")}\n`);
    }
  }

  process.stdout.write(`\nrevisions stored: ${await store.revisionCount(WORK_ITEM)}\n`);
} finally {
  await store.close();
}
