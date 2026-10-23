// The invocation contract and the service-owned executor for one invocation of a run's graph.
//
// Every invocation — initial or resumed — uses the run ID as the thread, synchronous durability (each superstep is
// persisted before the next is dispatched), a signal owned by this service, and only the `updates` and `custom`
// streams. The configuration never contains a `checkpoint_id` key: its mere presence selects replay semantics,
// under which completed work is re-executed. Nothing here accepts a browser request's signal; a closed browser
// cannot stop a run, only cancellation through the service can.
import { HumanMessage } from '@langchain/core/messages';
import { Command } from '@langchain/langgraph';
import type { KeyedSerializer } from '../persistence/keyed-serializer.ts';
import type { ExecutionAgent } from './agent.ts';
import type { QuestionPayload, ResumeEnvelope } from './tools.ts';

export type InvocationInput =
  | { kind: 'initial'; goal: string }
  /** Resumes the saved interrupt `interruptId` (the framework's ID) with the application's answer envelope. */
  | { kind: 'resume'; interruptId: string; envelope: ResumeEnvelope };

/**
 * The graph's own step bound, derived generously from the model-request budget. It is a safety net against a
 * runaway graph, not the budget: reaching it is an invariant failure, never a step-limit failure.
 */
export function recursionLimitFor(budgetMax: number): number {
  return budgetMax * 4 + 16;
}

export function invocationConfig(runId: string, signal: AbortSignal, budgetMax: number) {
  return {
    configurable: { thread_id: runId },
    durability: 'sync' as const,
    signal,
    streamMode: ['updates', 'custom'] as ['updates', 'custom'],
    recursionLimit: recursionLimitFor(budgetMax),
  };
}

export function graphInput(input: InvocationInput) {
  if (input.kind === 'initial') return { messages: [new HumanMessage(input.goal)] };
  // Addressed by interrupt ID, so the answer can only reach the interrupt it was accepted for; the envelope is an
  // object, so a false or null answer is still a present resume value.
  return new Command({ resume: { [input.interruptId]: input.envelope } });
}

export interface ObservedInterrupt {
  id: string;
  value: QuestionPayload;
}

export type InvocationSettlement =
  | { kind: 'finished' }
  | { kind: 'interrupted'; interrupts: ObservedInterrupt[] }
  | { kind: 'failed'; error: unknown };

export interface StreamChunk {
  mode: 'updates' | 'custom';
  data: unknown;
}

export interface RunningInvocation {
  /** Aborts the service-owned signal. The invocation still settles; `settled` resolves once it has. */
  cancel(reason?: unknown): void;
  readonly signal: AbortSignal;
  /** Resolves (never rejects) once the graph stream has ended and every chunk has been handled. */
  readonly settled: Promise<InvocationSettlement>;
}

export interface StartInvocation {
  runId: string;
  agent: ExecutionAgent;
  input: InvocationInput;
  budgetMax: number;
  /** Receives each stream chunk in order; the stream waits for it. */
  onChunk?: (chunk: StreamChunk) => void | Promise<void>;
}

/**
 * Runs invocations, at most one at a time per run (the lifetime executor), each under its own service-owned abort
 * controller. The caller keeps the handle; dropping it does not stop the invocation.
 */
export class InvocationExecutor {
  constructor(private readonly executors: KeyedSerializer) {}

  start(request: StartInvocation): RunningInvocation {
    const controller = new AbortController();
    const settled = this.executors.run(request.runId, () => runToSettlement(request, controller.signal));
    return {
      cancel: (reason) => controller.abort(reason),
      signal: controller.signal,
      settled,
    };
  }
}

async function runToSettlement(request: StartInvocation, signal: AbortSignal): Promise<InvocationSettlement> {
  const interrupts: ObservedInterrupt[] = [];
  try {
    const config = invocationConfig(request.runId, signal, request.budgetMax);
    const stream = await request.agent.stream(graphInput(request.input) as never, config as never);
    for await (const item of stream as AsyncIterable<[string, unknown]>) {
      const [mode, data] = item;
      if (mode === 'updates' && data !== null && typeof data === 'object' && '__interrupt__' in data) {
        for (const raised of (data as { __interrupt__: { id: string; value: QuestionPayload }[] }).__interrupt__) {
          interrupts.push({ id: raised.id, value: raised.value });
        }
      }
      await request.onChunk?.({ mode: mode as StreamChunk['mode'], data });
    }
  } catch (error) {
    return { kind: 'failed', error };
  }
  return interrupts.length > 0 ? { kind: 'interrupted', interrupts } : { kind: 'finished' };
}
