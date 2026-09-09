// Resume a work item in a fresh process.
//
// Takes a work item id and nothing else — no transcript, no handoff file — and
// prints the context a new attempt would be given. This is the whole restart
// story, and it is a real entry point rather than a test helper so the restart
// test exercises something a runtime would actually call.
//
//   node src/continue.ts <work-item-id>

import { prepareTurn } from "./memory.ts";
import { Store } from "./store.ts";

const workItemId = process.argv[2];
if (!workItemId) {
  process.stderr.write("usage: node src/continue.ts <work-item-id>\n");
  process.exit(2);
}

const store = await Store.connect();
try {
  const prepared = await prepareTurn(store, workItemId, { runId: "resumed", turnId: 0 });
  process.stdout.write(
    `${JSON.stringify(
      {
        workItemId,
        revision: prepared.context.revision,
        knowledge: prepared.context.knowledge.map((k) => `${k.id}@${k.revision}`),
        observations: prepared.context.observations.map((o) => o.id),
        droppedOnResume: prepared.dropped,
        context: prepared.assembled.text,
      },
      null,
      2,
    )}\n`,
  );
} finally {
  await store.close();
}
