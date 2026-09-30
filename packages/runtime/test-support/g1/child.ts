// G1 child process. Every observation is written synchronously to stdout as one JSON line, so the parent keeps
// an append-only witness log that survives SIGKILL and never depends on graph state.
import { writeSync } from 'node:fs';
import { Command } from '@langchain/langgraph';
import { PersistenceError } from '../../src/persistence/errors.ts';
import { openPersistence } from '../../src/persistence/persistence.ts';
import { createG1Agent, QUESTION_CALL_ID, QUESTION_MESSAGE_ID, questionIdFor } from './fixture-agent.ts';

type Phase = 'pause' | 'resume' | 'lost-ownership';

const emit = (event: string, data: Record<string, unknown> = {}) => {
  writeSync(1, `${JSON.stringify({ g1: event, pid: process.pid, ...data })}\n`);
};

const url = process.env.G1_DATABASE_URL;
const threadId = process.env.G1_THREAD_ID;
const phase = process.env.G1_PHASE as Phase | undefined;
if (!url || !threadId || !phase || !['pause', 'resume', 'lost-ownership'].includes(phase)) {
  emit('usage-error');
  process.exit(2);
}

const persistence = await openPersistence({
  url,
  onFault: (error) => emit('fault', { code: error.code }),
  ownership: { verifyIntervalMs: 60_000 },
});
persistence.ownership.onLost((error) => emit('ownership-lost', { code: error.code }));
emit('owned', { epoch: persistence.ownership.epoch, ownerPid: persistence.ownership.identity.pid });

const agent = createG1Agent({
  saver: persistence.checkpoints.saver,
  witness: emit,
  beforeDispatch: async () => {
    persistence.ownership.assertHeld();
    await persistence.ownership.verify();
  },
});

const controller = new AbortController();
// Ordinary invocation configuration: root thread, explicit synchronous durability, no checkpoint_id key at all.
const invocation = {
  configurable: { thread_id: threadId },
  durability: 'sync' as const,
  signal: controller.signal,
  streamMode: ['updates', 'custom'] as ('updates' | 'custom')[],
};
emit('invocation-config', {
  configurableKeys: Object.keys(invocation.configurable),
  durability: invocation.durability,
});

/** Read-only inspection of the saved head; it must not invoke the graph. */
async function savedBinding() {
  const snapshot = await agent.graph.getState({ configurable: { thread_id: threadId } });
  const tuple = await persistence.checkpoints.saver.getTuple(snapshot.config);
  const configurable = snapshot.config.configurable ?? {};
  const tasks = snapshot.tasks.map((task) => ({
    id: task.id,
    name: task.name,
    error: task.error === undefined ? null : 'present',
    interrupts: task.interrupts.map((entry) => ({ id: entry.id, value: entry.value })),
  }));
  const messages = (snapshot.values as { messages?: { id?: string; type?: string }[] }).messages ?? [];
  return {
    tuple: tuple !== undefined,
    checkpointNs: configurable.checkpoint_ns ?? null,
    checkpointId: configurable.checkpoint_id ?? null,
    next: [...snapshot.next],
    tasks,
    messageIds: messages.map((message) => message.id ?? null),
  };
}

async function drain(input: Parameters<typeof agent.stream>[0]) {
  let candidateInterrupts = 0;
  for await (const chunk of await agent.stream(input, invocation)) {
    if (JSON.stringify(chunk).includes('__interrupt__')) candidateInterrupts++;
  }
  return candidateInterrupts;
}

async function waitForLine(): Promise<string> {
  for await (const line of console) return line.trim();
  return '';
}

try {
  if (phase === 'pause') {
    const candidates = await drain({ messages: [{ role: 'user', content: 'Decide whether to proceed.' }] });
    emit('stream-drained', { candidateInterrupts: candidates });
    const binding = await savedBinding();
    emit('pause-settled', {
      binding,
      expectedQuestionId: questionIdFor(threadId, QUESTION_MESSAGE_ID, QUESTION_CALL_ID),
    });
    // Stay alive, owning the database, until the parent kills this process.
    await new Promise(() => {});
  }

  if (phase === 'resume') {
    const binding = await savedBinding();
    emit('pre-resume-binding', { binding });
    const pending = binding.tasks[0]?.interrupts[0];
    const interruptId = pending?.id;
    const questionId = (pending?.value as { questionId?: string } | undefined)?.questionId;
    if (binding.tasks.length !== 1 || typeof interruptId !== 'string' || questionId === undefined) {
      throw new Error('G1 invariant: no single pending question to resume');
    }
    // A negative answer travels inside a truthy, interrupt-ID-addressed envelope.
    await drain(new Command({ resume: { [interruptId]: { questionId, answer: false } } }));
    emit('final', { binding: await savedBinding() });
  }

  if (phase === 'lost-ownership') {
    emit('ready');
    await waitForLine();
    try {
      await drain({ messages: [{ role: 'user', content: 'Decide whether to proceed.' }] });
      emit('dispatched');
    } catch (error) {
      emit('refused', { code: error instanceof PersistenceError ? error.code : 'unexpected' });
    }
  }
} catch (error) {
  emit('child-error', { message: error instanceof Error ? error.message : 'unknown' });
  await persistence.close();
  process.exit(1);
}

await persistence.close();
emit('closed');
process.exit(0);
