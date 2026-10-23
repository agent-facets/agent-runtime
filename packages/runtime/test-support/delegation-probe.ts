// The minimal stock delegation pattern, provider-free, for the PostgreSQL child-resume probe (design Decision 7): a
// root `createAgent` whose tool invokes a stock child `createAgent` on the same thread and saver. The child reads a
// synthetic value once and then interrupts. Not the production delegate implementation. Test-only.
import { AIMessage, type BaseMessage, HumanMessage } from '@langchain/core/messages';
import { Command, interrupt } from '@langchain/langgraph';
import type { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint';
import { createAgent, tool } from 'langchain';
import { ScriptedModel, type ScriptStep } from './scripted-model.ts';

export interface ProbeCounters {
  reads: number;
  delegateEntries: number;
  /** The framework checkpoint namespace each parent-tool entry ran under. */
  namespaces: string[];
}

const object = (properties: Record<string, unknown>, required: string[]) =>
  ({ type: 'object', additionalProperties: false, properties, required }) as const;

const call = (id: string, name: string, args: Record<string, unknown>) =>
  new AIMessage({ id, content: '', tool_calls: [{ id: `call-${id}`, name, args, type: 'tool_call' }] });
const echo =
  (id: string): ScriptStep =>
  (messages) =>
    new AIMessage({ id, content: String(messages.at(-1)?.content) });

interface ToolRuntimeView {
  toolCallId?: string;
  configurable?: { checkpoint_ns?: unknown };
}

/**
 * A fresh root/child pair. `phase` selects the scripts: `initial` delegates, reads and asks; `resume` only finishes
 * (any further model call fails the probe, because each scripted model has no step left).
 */
export function probeAgents(saver: BaseCheckpointSaver, counters: ProbeCounters, phase: 'initial' | 'resume') {
  const read = tool(
    async () => {
      counters.reads++;
      return 'synthetic-value-42';
    },
    { name: 'probe_read', description: 'Reads the synthetic value.', schema: object({}, []) },
  );
  const ask = tool(async () => JSON.stringify(interrupt({ prompt: 'Proceed?' })), {
    name: 'probe_ask',
    description: 'Asks the owner.',
    schema: object({}, []),
  });
  const child = createAgent({
    model: new ScriptedModel(
      phase === 'initial'
        ? [() => call('child-1', 'probe_read', {}), () => call('child-2', 'probe_ask', {})]
        : [echo('child-3')],
    ),
    tools: [read, ask],
    systemPrompt: 'Child.',
    checkpointer: saver,
    version: 'v2',
  });

  const delegate = tool(
    async (_args: unknown, runtime: ToolRuntimeView) => {
      counters.delegateEntries++;
      const namespace = runtime.configurable?.checkpoint_ns;
      if (typeof namespace !== 'string' || typeof runtime.toolCallId !== 'string') throw new Error('no task identity');
      counters.namespaces.push(namespace);
      // Inherits the tool task's configuration (thread, namespace, saver and resume map); the initial task message
      // has a stable identity derived from the parent call, so re-entry does not create a different task.
      const result = await child.invoke({
        messages: [new HumanMessage({ id: `task-${runtime.toolCallId}`, content: 'Read the value, then ask.' })],
      });
      return String((result.messages as BaseMessage[]).at(-1)?.content);
    },
    {
      name: 'probe_delegate',
      description: 'Delegates to the child.',
      schema: object({ task: { type: 'string' } }, ['task']),
    },
  );
  const root = createAgent({
    model: new ScriptedModel(
      phase === 'initial' ? [() => call('root-1', 'probe_delegate', { task: 'Look.' })] : [echo('root-2')],
    ),
    tools: [delegate],
    systemPrompt: 'Root.',
    checkpointer: saver,
    version: 'v2',
  });
  return { root, child };
}

type Agents = ReturnType<typeof probeAgents>;

/** Streams one root invocation to settlement and returns the interrupts it raised. */
export async function runRoot(
  root: Agents['root'],
  threadId: string,
  input: 'initial' | { interruptId: string; answer: unknown },
): Promise<{ id: string; value: unknown }[]> {
  const graphInput =
    input === 'initial'
      ? { messages: [new HumanMessage({ id: 'goal', content: 'Delegate.' })] }
      : new Command({ resume: { [input.interruptId]: { answer: input.answer } } });
  const stream = await root.stream(
    graphInput as never,
    {
      configurable: { thread_id: threadId },
      durability: 'sync',
      streamMode: ['updates'],
    } as never,
  );
  const interrupts: { id: string; value: unknown }[] = [];
  for await (const [mode, data] of stream as AsyncIterable<[string, unknown]>) {
    if (mode === 'updates' && data !== null && typeof data === 'object' && '__interrupt__' in data) {
      interrupts.push(...(data as { __interrupt__: { id: string; value: unknown }[] }).__interrupt__);
    }
  }
  return interrupts;
}

/** The pending interrupts of a child's saved state at a namespace, read without invoking it. */
export async function childInterrupts(child: Agents['child'], threadId: string, namespace: string) {
  const state = (await child.graph.getState({
    configurable: { thread_id: threadId, checkpoint_ns: namespace },
  })) as unknown as {
    config: { configurable?: Record<string, unknown> };
    tasks: { interrupts: { id?: string; value?: unknown }[] }[];
  };
  return {
    checkpointNs: state.config.configurable?.checkpoint_ns as string | undefined,
    interrupts: state.tasks.flatMap((task) => task.interrupts.map((item) => ({ id: item.id, value: item.value }))),
  };
}

export async function rootMessages(root: Agents['root'], threadId: string): Promise<BaseMessage[]> {
  const state = await root.graph.getState({ configurable: { thread_id: threadId } });
  return (state.values as { messages: BaseMessage[] }).messages;
}
