// The run controller: one invocation of a run, from dispatch to a recorded outcome (Decisions 2, 4, 6 and 14).
//
// Completed assistant messages are projected into history as they are produced. When the graph stream ends, the
// controller waits for all tracked local work, then records exactly one of:
//   - a published question (after settlement, inspection and one commit);
//   - success, only if this invocation produced a new, recorded final assistant result — a continuation that
//     returns without new work, a result or a question is a runtime failure, never success;
//   - a typed failure, classified from the boundary's evidence.
// Only the run's current working invocation can record anything: after cancellation (or any other change) the
// outcome belongs to that path. If a commit's outcome cannot be established, the service fails stop.
import { AIMessage, type BaseMessage } from '@langchain/core/messages';
import type { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint';
import { failureFor } from '../domain/failures.ts';
import type { KeyedSerializer } from '../persistence/keyed-serializer.ts';
import { isAmbiguousCommitError, type RunStore } from '../records/run-store.ts';
import type { Failure, ProviderBinding, RunState } from '../records/schemas.ts';
import type { ExecutionAgent } from './agent.ts';
import type { ActiveInvocations } from './cancellation.ts';
import { InFlight } from './in-flight.ts';
import type { InvocationExecutor, InvocationInput, InvocationSettlement, StreamChunk } from './invocation.ts';
import { classifyInvocationFailure } from './outcomes.ts';
import { publishSettledQuestion } from './publication.ts';

/** Raised after the service was told to fail stop; the outcome is left for startup reconciliation. */
export class FailStop extends Error {
  override readonly name = 'FailStop';
  constructor() {
    super('the runtime stopped because it could not establish a recorded outcome');
  }
}

export interface InvocationWiring {
  runId: string;
  invocationId: string;
  binding: ProviderBinding;
  /** Receives the tracked work of this invocation: request bodies, tool calls, checkpoint writes. */
  inflight: InFlight;
  /** The invocation's service-owned signal, available once it has started. */
  signal: () => AbortSignal;
}

export interface ControllerDeps {
  store: RunStore;
  gates: KeyedSerializer;
  executor: InvocationExecutor;
  active: ActiveInvocations;
  saver: BaseCheckpointSaver;
  /** Builds the agent for one invocation (terminal admission, ledger and tracking bound to it). */
  wire: (wiring: InvocationWiring) => ExecutionAgent;
  /** Called when a commit's outcome cannot be established: nothing more may be done under this ownership. */
  failStop: () => void;
  /** Test instrumentation: deterministic points after settlement and before the outcome is recorded. */
  barriers?: { afterSettlement?: (runId: string, settlement: InvocationSettlement) => Promise<void> };
}

export class RunController {
  constructor(private readonly deps: ControllerDeps) {}

  /** Runs one invocation of a run to a recorded outcome, and returns the run's state afterwards. */
  async run(runId: string, invocationId: string, input: InvocationInput): Promise<RunState> {
    const { store, executor, active } = this.deps;
    const snapshot = await store.snapshot(runId);
    const inflight = new InFlight();
    let running: ReturnType<InvocationExecutor['start']> | undefined;
    const agent = this.deps.wire({
      runId,
      invocationId,
      binding: snapshot.binding,
      inflight,
      signal: () => running?.signal ?? AbortSignal.abort(),
    });
    const before = new Set(await this.#messageIds(agent, runId));

    running = executor.start({
      runId,
      agent,
      input,
      budgetMax: snapshot.budget.maximum,
      onChunk: (chunk) => this.#project(runId, chunk),
    });
    active.register(runId, running, inflight);
    const settlement = await running.settled;
    await inflight.settled();
    await this.deps.barriers?.afterSettlement?.(runId, settlement);

    const provider = snapshot.binding.provider;
    if (settlement.kind === 'interrupted') {
      const published = await publishSettledQuestion(
        { store, gates: this.deps.gates, agent, saver: this.deps.saver, definitionDigest: snapshot.definitionDigest },
        { runId, invocationId, expectedRevision: (await store.snapshot(runId)).revision },
        settlement,
      );
      if (published.kind === 'published') return (await store.snapshot(runId)).state;
      if (published.kind === 'unknown') return this.#stop();
      if (published.reason === 'run_changed') return (await store.snapshot(runId)).state;
      const reason = published.reason === 'saved_state_unusable' ? 'invariant_violation' : 'persistence_failure';
      return this.#finish(runId, invocationId, { kind: 'failed', failure: failureFor(reason, { provider }) });
    }

    if (settlement.kind === 'failed') {
      const classified = classifyInvocationFailure(settlement.error, provider);
      if (classified.kind === 'fail_stop') return this.#stop();
      if (classified.kind === 'superseded') return (await store.snapshot(runId)).state;
      return this.#finish(runId, invocationId, { kind: 'failed', failure: classified.failure });
    }

    // Finished: success requires a new final assistant message from this invocation, recorded in history.
    const messages = await this.#messages(agent, runId);
    const final = [...messages]
      .reverse()
      .find(
        (message): message is AIMessage =>
          AIMessage.isInstance(message) &&
          typeof message.id === 'string' &&
          !before.has(message.id) &&
          (message.tool_calls ?? []).length === 0,
      );
    const producedWork = messages.some((message) => typeof message.id === 'string' && !before.has(message.id));
    if (final === undefined) {
      const reason = input.kind === 'resume' && !producedWork ? 'no_op_continuation' : 'missing_final_result';
      return this.#finish(runId, invocationId, { kind: 'failed', failure: failureFor(reason, { provider }) });
    }
    const recorded = await this.#recordMessage(runId, final);
    return this.#finish(runId, invocationId, { kind: 'succeeded', resultSeq: recorded });
  }

  async #finish(
    runId: string,
    invocationId: string,
    outcome: { kind: 'succeeded'; resultSeq: string } | { kind: 'failed'; failure: Failure },
  ): Promise<RunState> {
    try {
      const result = await this.deps.gates.run(runId, () =>
        this.deps.store.finishInvocation({ runId, invocationId, outcome }),
      );
      return result.state;
    } catch (error) {
      if (!isAmbiguousCommitError(error)) throw error;
      try {
        const state = (await this.deps.store.snapshot(runId)).state;
        if (state.kind !== 'working' || state.invocationId !== invocationId) return state;
      } catch {
        // Readback failed as well.
      }
      return this.#stop();
    }
  }

  /** Commit certainty or ownership was lost: the service stops, and this invocation records nothing more. */
  #stop(): never {
    this.deps.failStop();
    throw new FailStop();
  }

  /** Projects completed assistant messages from the stream into history, in order, once each. */
  async #project(runId: string, chunk: StreamChunk): Promise<void> {
    if (chunk.mode !== 'updates' || chunk.data === null || typeof chunk.data !== 'object') return;
    for (const update of Object.values(chunk.data as Record<string, unknown>)) {
      const messages = (update as { messages?: unknown } | null)?.messages;
      if (!Array.isArray(messages)) continue;
      for (const message of messages) {
        if (AIMessage.isInstance(message) && typeof message.id === 'string') await this.#recordMessage(runId, message);
      }
    }
  }

  async #recordMessage(runId: string, message: AIMessage): Promise<string> {
    const [event] = await this.deps.store.recordActivity(runId, [
      {
        event: { kind: 'assistant.message', payload: { messageId: message.id as string, text: message.text } },
        sourceKey: `message:${message.id}`,
      },
    ]);
    if (event === undefined) throw new Error('assistant message was not recorded');
    return event.seq;
  }

  async #messages(agent: ExecutionAgent, runId: string): Promise<BaseMessage[]> {
    const state = await agent.graph.getState({ configurable: { thread_id: runId } });
    return ((state.values as { messages?: BaseMessage[] }).messages ?? []) as BaseMessage[];
  }

  async #messageIds(agent: ExecutionAgent, runId: string): Promise<string[]> {
    return (await this.#messages(agent, runId)).flatMap((message) =>
      typeof message.id === 'string' ? [message.id] : [],
    );
  }
}
