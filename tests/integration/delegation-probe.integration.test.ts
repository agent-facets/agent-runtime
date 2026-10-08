// The PostgreSQL child-resume probe (design Decision 7, task 4.1): under the pinned framework, the official saver
// and stock agents only, a root tool invokes a child that reads once and interrupts. A freshly built child, inspected
// directly at the framework's namespace, shows the interrupt the root propagated; a fresh root/child pair resumes it
// by interrupt ID with an exact negative answer. Provider-free. This is not the production-controller witness.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { openPersistence, type Persistence } from '../../packages/runtime/src/persistence/persistence.ts';
import {
  childInterrupts,
  type ProbeCounters,
  probeAgents,
  rootMessages,
  runRoot,
} from '../../packages/runtime/test-support/delegation-probe.ts';
import { createScratchDatabase, type ScratchDatabase } from '../support/scratch-database.ts';

let db: ScratchDatabase;
let persistence: Persistence;
beforeAll(async () => {
  db = await createScratchDatabase();
  persistence = await openPersistence({ url: db.url, onFault: () => {} });
});
afterAll(async () => {
  await persistence.close();
  await db.drop();
});

test('a tool-invoked child resumes from PostgreSQL by interrupt ID without repeating its completed read', async () => {
  const saver = persistence.checkpoints.saver;
  const threadId = crypto.randomUUID();
  const counters: ProbeCounters = { reads: 0, delegateEntries: 0, namespaces: [] };

  const first = probeAgents(saver, counters, 'initial');
  const raised = await runRoot(first.root, threadId, 'initial');
  expect(raised).toHaveLength(1);
  const [interrupt] = raised as [{ id: string; value: unknown }];
  expect(interrupt.value).toEqual({ prompt: 'Proceed?' });
  expect(counters).toMatchObject({ reads: 1, delegateEntries: 1 });
  const [namespace] = counters.namespaces as [string];
  expect(namespace).not.toBe('');

  // Direct inspection of a freshly reconstructed child at the recorded namespace, without invoking either graph.
  const fresh = probeAgents(saver, counters, 'resume');
  const inspected = await childInterrupts(fresh.child, threadId, namespace);
  expect(inspected.checkpointNs).toBe(namespace);
  expect(inspected.interrupts).toEqual([{ id: interrupt.id, value: interrupt.value }]);
  expect(counters).toMatchObject({ reads: 1, delegateEntries: 1 });

  // A fresh pair resumes the root only, addressed by interrupt ID, with an exact negative answer.
  expect(await runRoot(fresh.root, threadId, { interruptId: interrupt.id, answer: false })).toEqual([]);
  expect(counters.reads).toBe(1);
  expect(counters.delegateEntries).toBe(2);
  expect(counters.namespaces).toEqual([namespace, namespace]);
  const final = (await rootMessages(fresh.root, threadId)).at(-1);
  expect(final?.id).toBe('root-2');
  expect(JSON.parse(String(final?.content))).toEqual({ answer: false });
});
