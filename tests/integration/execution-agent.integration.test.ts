// Controlled root execution on the official PostgreSQL saver: the stock agent's messages, including provider
// replay metadata, survive the saver's own serialization and a fresh saver instance; nothing unsafe reaches the
// checkpoint tables. Independent witnesses are the scripted model's call log and raw reads of those tables.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { exactSecretMatcher } from '../../packages/runtime/src/credentials/matcher.ts';
import { createExecutionAgent } from '../../packages/runtime/src/execution/agent.ts';
import { executionFailureOf } from '../../packages/runtime/src/execution/failures.ts';
import { InvocationExecutor } from '../../packages/runtime/src/execution/invocation.ts';
import { inspectSavedQuestion } from '../../packages/runtime/src/execution/saved-state.ts';
import { ASK_TOOL, READ_TOOL } from '../../packages/runtime/src/execution/tools.ts';
import { KeyedSerializer } from '../../packages/runtime/src/persistence/keyed-serializer.ts';
import { openPersistence, type Persistence } from '../../packages/runtime/src/persistence/persistence.ts';
import { createCheckpointStore } from '../../packages/runtime/src/persistence/saver/checkpoint-saver.ts';
import { createContentPolicy, REDACTION } from '../../packages/runtime/src/security/content-policy.ts';
import { MemoryLedger } from '../../packages/runtime/test-support/memory-ledger.ts';
import { AIMessage, ScriptedModel, type ToolMessage } from '../../packages/runtime/test-support/scripted-model.ts';
import { createFixture } from '../../packages/runtime/test-support/workspace.ts';
import { createScratchDatabase, type ScratchDatabase } from '../support/scratch-database.ts';

const LIVE = 'oauth-live-synthetic-0123456789abcdefABCDEF';
const policy = createContentPolicy(exactSecretMatcher([LIVE]));
const fixture = createFixture();
fixture.write('notes/plan.md', `alpha\nsecret ${LIVE}\n`);
const workspace = fixture.policy();

let db: ScratchDatabase;
let persistence: Persistence;
beforeAll(async () => {
  db = await createScratchDatabase();
  persistence = await openPersistence({ url: db.url, onFault: () => {} });
});
afterAll(async () => {
  await persistence.close();
  await db.drop();
  fixture.cleanup();
});

const call = (id: string, name: string, args: Record<string, unknown>) => ({
  id,
  name,
  args,
  type: 'tool_call' as const,
});

function run(model: ScriptedModel, saver = persistence.checkpoints.saver) {
  const runId = crypto.randomUUID();
  const agent = createExecutionAgent({
    runId,
    model,
    checkpointer: saver,
    workspace,
    contentPolicy: () => policy,
    operations: new MemoryLedger(),
  });
  const executor = new InvocationExecutor(new KeyedSerializer());
  return {
    runId,
    agent,
    start: (input: Parameters<InvocationExecutor['start']>[0]['input']) =>
      executor.start({ runId, agent, input, budgetMax: 10 }).settled,
  };
}

/** Every byte the saver stored for a thread, as text. */
async function storedText(threadId: string): Promise<string> {
  const rows = await db.admin`
    select coalesce(string_agg(convert_from(blob, 'UTF8'), ''), '') as text from checkpoints.checkpoint_blobs
      where thread_id = ${threadId} and blob is not null
    union all
    select coalesce(string_agg(checkpoint::text || metadata::text, ''), '') from checkpoints.checkpoints where thread_id = ${threadId}
    union all
    select coalesce(string_agg(convert_from(blob, 'UTF8'), ''), '') from checkpoints.checkpoint_writes where thread_id = ${threadId}`;
  return rows.map((row: { text: string }) => row.text).join('\n');
}

describe('controlled execution on the official saver', () => {
  test('a tool round trip persists sanitized messages with their replay metadata, readable by a fresh saver', async () => {
    const reasoning = { type: 'reasoning', reasoning: 'considering', signature: 'sig-synthetic', id: 'rs_1' };
    const model = new ScriptedModel([
      () =>
        new AIMessage({
          id: 'm1',
          content: [{ type: 'text', text: `Looking for ${LIVE}` }, reasoning],
          tool_calls: [call('c1', READ_TOOL, { mode: 'file', path: 'notes/plan.md' })],
          additional_kwargs: { replay: { encrypted: 'synthetic-encrypted-state' } },
          response_metadata: { model_provider: 'test' },
        }),
      () => new AIMessage({ id: 'm2', content: 'Finished.' }),
    ]);
    const { runId, start } = run(model);
    expect(await start({ kind: 'initial', goal: 'Read the plan.' })).toEqual({ kind: 'finished' });
    expect(model.calls).toHaveLength(2);

    const fresh = createCheckpointStore({ url: db.url, onFault: () => {} });
    try {
      const { agent } = run(new ScriptedModel([]), fresh.saver);
      const state = await agent.graph.getState({ configurable: { thread_id: runId } });
      const [human, first, tool, final] = state.values.messages as [unknown, AIMessage, ToolMessage, AIMessage];
      expect(human).toBeDefined();
      expect(first.id).toBe('m1');
      expect(first.content).toEqual([{ type: 'text', text: `Looking for ${REDACTION}` }, reasoning]);
      expect(first.additional_kwargs).toEqual({ replay: { encrypted: 'synthetic-encrypted-state' } });
      expect(first.tool_calls).toEqual([call('c1', READ_TOOL, { mode: 'file', path: 'notes/plan.md' })]);
      expect(JSON.parse(String(tool.content)).result.lines[1]).toEqual({ line: 2, text: `secret ${REDACTION}` });
      expect(final.content).toBe('Finished.');
      expect(state.next).toEqual([]);
    } finally {
      await fresh.close();
    }
    const stored = await storedText(runId);
    expect(stored).toContain('synthetic-encrypted-state');
    expect(stored).not.toContain(LIVE);
  });

  test('a failed model call leaves only fixed error text in the checkpoint writes', async () => {
    const model = new ScriptedModel([
      () => {
        throw Object.assign(new Error(`upstream said ${LIVE}`), { status: 500 });
      },
    ]);
    const { runId, start } = run(model);
    const settled = await start({ kind: 'initial', goal: 'Go.' });
    expect(settled.kind === 'failed' && executionFailureOf(settled.error)?.code).toBe('model_request_failed');
    const stored = await storedText(runId);
    expect(stored).toContain('ExecutionFailure');
    expect(stored).not.toContain(LIVE);
  });

  test('a question pauses at a saved interrupt and a false answer resumes the same thread', async () => {
    const model = new ScriptedModel([
      () =>
        new AIMessage({
          id: 'm-ask',
          content: '',
          tool_calls: [
            call('c-ask', ASK_TOOL, {
              prompt: 'Proceed?',
              input: {
                kind: 'choice',
                multiple: false,
                options: [
                  { label: 'Yes', value: true },
                  { label: 'No', value: false },
                ],
              },
            }),
          ],
        }),
      (messages) => new AIMessage({ id: 'm-final', content: String(messages.at(-1)?.content) }),
    ]);
    const { runId, agent, start } = run(model);
    const paused = await start({ kind: 'initial', goal: 'Ask.' });
    if (paused.kind !== 'interrupted') throw new Error(`expected an interrupt, got ${paused.kind}`);
    const [raised] = paused.interrupts;
    const saved = await agent.graph.getState({ configurable: { thread_id: runId } });
    expect(saved.tasks.flatMap((task) => task.interrupts.map((item) => item.id))).toEqual([raised?.id]);

    // The same saved question, with the same required-state digest, as seen through a fresh saver (a restart).
    const inspected = await inspectSavedQuestion(agent, persistence.checkpoints.saver, runId);
    const fresh = createCheckpointStore({ url: db.url, onFault: () => {} });
    try {
      const { agent: reader } = run(new ScriptedModel([]), fresh.saver);
      const reinspected = await inspectSavedQuestion(reader, fresh.saver, runId, raised?.value.questionId);
      expect(inspected.kind).toBe('question');
      expect(reinspected).toEqual(inspected);
      expect(inspected.kind === 'question' && inspected.question.interruptId).toBe(raised?.id as string);
    } finally {
      await fresh.close();
    }

    const resumed = await start({
      kind: 'resume',
      interruptId: raised?.id as string,
      envelope: { questionId: raised?.value.questionId as string, answer: false },
    });
    expect(resumed).toEqual({ kind: 'finished' });
    expect(model.calls).toHaveLength(2);
    expect(JSON.parse(String(model.calls[1]?.messages.at(-1)?.content))).toEqual({
      outcome: 'ok',
      result: { answer: false },
    });
  });
});
