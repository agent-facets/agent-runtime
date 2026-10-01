import type { TransactionSQL } from 'bun';
import type { AppDatabase } from '../persistence/app-database.ts';
import { sqlStateOf } from '../persistence/errors.ts';
import { jsonText, parseJsonText } from '../persistence/json.ts';
import { LOCK_NAMESPACE, type OwnerFence, REQUEST_CEILING_LOCK, withOwnerFence } from '../persistence/ownership.ts';
import { canonicalJson, digestOf, parseSequence } from './canonical.ts';
import {
  type Answer,
  type AttemptState,
  attemptStateSchema,
  eventSchema,
  type Failure,
  type Provider,
  type ProviderBinding,
  providerBindingSchema,
  type QuestionBinding,
  type QuestionDisposition,
  type QuestionInput,
  questionBindingSchema,
  questionDispositionSchema,
  questionInputSchema,
  type RunEvent,
  type RunState,
  runStateSchema,
  TERMINAL_STATES,
  toolDispositionSchema,
  type WorkspaceSnapshot,
  workspaceSchema,
} from './schemas.ts';

export type RunStoreErrorCode =
  | 'request_conflict'
  | 'run_not_found'
  | 'stale_revision'
  | 'run_finished'
  | 'source_key_conflict'
  | 'tool_call_conflict'
  | 'not_dispatchable'
  | 'budget_exhausted'
  | 'ceiling_reached'
  | 'invariant_violation'
  | 'acceptance_unknown';

export class RunStoreError extends Error {
  override readonly name = 'RunStoreError';
  constructor(
    readonly code: RunStoreErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface NewEvent {
  event: RunEvent;
  /** Namespaced by logical source and phase; never derived only from tool arguments. */
  sourceKey: string;
}

export interface StoredEvent extends NewEvent {
  runId: string;
  /** Decimal string. */
  seq: string;
  recordedAt: string;
}

export interface RunSnapshot {
  runId: string;
  createRequestId: string;
  goal: string;
  workspace: WorkspaceSnapshot;
  binding: ProviderBinding;
  definitionDigest: string;
  budget: { maximum: number; consumed: number; unconfirmed: number };
  state: RunState;
  revision: string;
  createdAt: string;
  lastActivityAt: string;
  pendingQuestion: { questionId: string; prompt: string; input: unknown } | undefined;
  /** Every committed event up to and including this sequence belongs to this snapshot. */
  throughSeq: string;
}

export interface RunSummary {
  runId: string;
  goal: string;
  binding: ProviderBinding;
  status: RunState['kind'];
  createdAt: string;
  lastActivityAt: string;
}

const RUN_STATE_KINDS: ReadonlySet<RunState['kind']> = new Set([
  'working',
  'waiting',
  'cancelling',
  'succeeded',
  'failed',
  'cancelled',
  'interrupted',
]);

export interface CreateRunInput {
  requestId: string;
  goal: string;
  provider: Provider;
  workspace: WorkspaceSnapshot;
  binding: ProviderBinding;
  definition: { digest: string; manifest: Record<string, unknown> };
  budgetMax: number;
}

export type CreateRunResult = { created: true; snapshot: RunSnapshot } | { created: false; snapshot: RunSnapshot };

export interface TransitionInput {
  runId: string;
  expectedRevision: string;
  /** The next state; a function is evaluated after `apply`, so it can use values read inside the transaction. */
  next: RunState | (() => RunState);
  /** Additional events committed with the status change, in order after it; a function is evaluated after `apply`. */
  events?: NewEvent[] | (() => NewEvent[]);
  /** Further record changes that must commit atomically with the transition. */
  apply?: (tx: TransactionSQL) => Promise<void>;
}

/** A tool call's recorded identity (see execution/operations.ts). */
export interface ToolOperationIdentity {
  operationId: string;
  modelMessageId: string;
  providerToolCallId: string;
  toolName: string;
  arguments: Record<string, unknown>;
  argumentDigest: string;
}

export type ToolOperationStart =
  | { kind: 'execute' }
  | { kind: 'reuse'; outcome: Record<string, unknown> & { outcome: 'ok' | 'refused' | 'error' } }
  | { kind: 'not_dispatchable' };

export interface PublishQuestionInput {
  runId: string;
  /** The revision the run had when its invocation settled; publication fails if anything changed since. */
  expectedRevision: string;
  invocationId: string;
  questionId: string;
  prompt: string;
  input: QuestionInput;
  binding: QuestionBinding;
}

/** A question as recorded, with the run state and revision read in the same snapshot. */
export interface RecordedQuestion {
  runId: string;
  questionId: string;
  prompt: string;
  input: QuestionInput;
  binding: QuestionBinding;
  bindingDigest: string;
  disposition: QuestionDisposition;
  run: { state: RunState; revision: string; binding: ProviderBinding; workspace: WorkspaceSnapshot };
}

export interface AcceptedAnswer {
  answer: Answer;
  acceptedAt: string;
  invocationId: string;
  revision: string;
}

export type CancellationResult =
  /** Newly accepted: `cancelled` if nothing was running (a waiting run), otherwise `cancelling`. */
  | { kind: 'accepted'; cancellationId: string; acceptedAt: string; state: RunState }
  /** The same request was already accepted; its recorded disposition. */
  | { kind: 'repeated'; cancellationId: string; acceptedAt: string; state: RunState }
  /** A different cancellation request already owns this run's cancellation. */
  | { kind: 'conflict'; state: RunState }
  /** The run finished before cancellation could be accepted. */
  | { kind: 'finished'; state: RunState };

/** A recorded tool outcome: the complete object returned to the agent. */
export type RecordedToolOutcome = Record<string, unknown> & { outcome: 'ok' | 'refused' | 'error' };

/** Identity of a creation request: the submitted content only, never server defaults applied afterwards. */
export function creationInputDigest(input: Pick<CreateRunInput, 'goal' | 'provider'>): string {
  return digestOf({ goal: input.goal, provider: input.provider });
}

/**
 * Errors that do not establish whether a transaction committed: connection loss, admin shutdown, or no SQLSTATE
 * at all. A server-reported SQLSTATE otherwise means the transaction was rolled back.
 */
export function isAmbiguousCommitError(error: unknown): boolean {
  if (error instanceof RunStoreError) return false;
  const state = sqlStateOf(error);
  return state === undefined || state.startsWith('08') || state === '57P01' || state === '57P02' || state === '57P03';
}

export interface RunStoreOptions {
  /**
   * The most model requests this deployment may ever admit, across all runs (an operator safety limit, for example
   * for a bounded acceptance trial). Unset, only each run's own budget applies.
   */
  modelRequestCeiling?: number;
}

export class RunStore {
  constructor(
    private readonly db: AppDatabase,
    private readonly owner: OwnerFence,
    private readonly options: RunStoreOptions = {},
  ) {}

  /** Creates a run for a request ID, or returns the run that request already created. */
  async createRun(input: CreateRunInput): Promise<CreateRunResult> {
    const inputDigest = creationInputDigest(input);
    const workspace = workspaceSchema.parse(input.workspace);
    const binding = providerBindingSchema.parse(input.binding);
    if (binding.provider !== input.provider) throw new RangeError('binding provider differs from the request');

    const existing = await this.findCreation(input.requestId);
    if (existing !== undefined) return this.#resolveExisting(existing, inputDigest);

    const runId = crypto.randomUUID();
    const invocationId = crypto.randomUUID();
    try {
      await withOwnerFence(this.db, this.owner, async (tx) => {
        await tx`insert into runtime.execution_definitions (digest, manifest)
          values (${input.definition.digest}, ${jsonText(input.definition.manifest)}::text::jsonb)
          on conflict (digest) do nothing`;
        const state: RunState = { kind: 'working', invocationId, ownerEpoch: this.owner.epoch };
        await tx`insert into runtime.runs (run_id, create_request_id, input_digest, goal, workspace, binding,
            definition_digest, budget_max, state, revision)
          values (${runId}, ${input.requestId}, ${inputDigest}, ${input.goal}, ${jsonText(workspace)}::text::jsonb,
            ${jsonText(binding)}::text::jsonb, ${input.definition.digest}, ${input.budgetMax},
            ${jsonText(state)}::text::jsonb, 1)`;
        await tx`insert into runtime.invocations (run_id, invocation_id, owner_epoch, kind, disposition)
          values (${runId}, ${invocationId}, ${this.owner.epoch}, 'initial', 'active')`;
        await this.#append(tx, runId, [
          {
            event: {
              kind: 'run.created',
              payload: {
                requestId: input.requestId,
                provider: binding.provider,
                model: binding.model,
                budgetMax: input.budgetMax,
              },
            },
            sourceKey: `create:${input.requestId}`,
          },
          { event: { kind: 'run.status', payload: { revision: '1', state } }, sourceKey: 'status:1' },
        ]);
      });
    } catch (error) {
      // A concurrent creation with the same request ID won the unique constraint; report its run instead.
      if (sqlStateOf(error) === '23505') {
        const winner = await this.findCreation(input.requestId);
        if (winner !== undefined) return this.#resolveExisting(winner, inputDigest);
      }
      throw error;
    }
    return { created: true, snapshot: await this.snapshot(runId) };
  }

  /** Readback for creation: the run a request ID created, if that commit happened. */
  async findCreation(requestId: string): Promise<{ runId: string; inputDigest: string } | undefined> {
    const [row] = await this.db.readOnly(
      (tx) => tx`
      select run_id::text as run_id, input_digest from runtime.runs where create_request_id = ${requestId}`,
    );
    return row === undefined ? undefined : { runId: row.run_id, inputDigest: row.input_digest };
  }

  async #resolveExisting(existing: { runId: string; inputDigest: string }, inputDigest: string) {
    if (existing.inputDigest !== inputDigest) {
      throw new RunStoreError('request_conflict', 'this request ID was already used with different content');
    }
    return { created: false as const, snapshot: await this.snapshot(existing.runId) };
  }

  /** Records activity events for a run that has not finished. */
  async recordActivity(runId: string, events: NewEvent[]): Promise<StoredEvent[]> {
    return withOwnerFence(this.db, this.owner, async (tx) => {
      const run = await this.#lockRun(tx, runId);
      if (TERMINAL_STATES.has(run.state.kind)) throw new RunStoreError('run_finished', 'the run has already finished');
      return this.#append(tx, runId, events);
    });
  }

  /**
   * Changes run state atomically with its status event, any additional events and record changes. The expected
   * revision makes concurrent or repeated transitions fail instead of overwriting each other; a finished run's
   * outcome never changes.
   */
  async transition(input: TransitionInput): Promise<{ revision: string; events: StoredEvent[] }> {
    if (typeof input.next !== 'function') runStateSchema.parse(input.next);
    return withOwnerFence(this.db, this.owner, async (tx) => {
      const run = await this.#lockRun(tx, input.runId);
      if (TERMINAL_STATES.has(run.state.kind)) throw new RunStoreError('run_finished', 'the run has already finished');
      if (run.revision !== input.expectedRevision) {
        throw new RunStoreError('stale_revision', 'the run changed since it was read');
      }
      await input.apply?.(tx);
      const next = runStateSchema.parse(typeof input.next === 'function' ? input.next() : input.next);
      const extra = typeof input.events === 'function' ? input.events() : (input.events ?? []);
      const [row] = await tx`
        update runtime.runs set state = ${jsonText(next)}::text::jsonb, revision = revision + 1
        where run_id = ${input.runId} returning revision::text as revision`;
      const revision = row.revision as string;
      const events = await this.#append(tx, input.runId, [
        { event: { kind: 'run.status', payload: { revision, state: next } }, sourceKey: `status:${revision}` },
        ...extra,
      ]);
      return { revision, events };
    });
  }

  /**
   * Records a tool call as started, or finds its record. Only a run still working under `invocationId` may start
   * work; after cancellation, or once another invocation owns the run, nothing new is dispatched. A provider call
   * ID already bound to a different operation, tool or arguments is a conflict, never a reuse.
   */
  async startToolOperation(
    runId: string,
    invocationId: string,
    identity: ToolOperationIdentity,
  ): Promise<ToolOperationStart> {
    return withOwnerFence(this.db, this.owner, async (tx) => {
      const run = await this.#lockRun(tx, runId);
      if (run.state.kind !== 'working' || run.state.invocationId !== invocationId) return { kind: 'not_dispatchable' };
      const [existing] = await tx`
        select operation_id, tool_name, argument_digest, disposition::text as disposition
        from runtime.tool_operations where run_id = ${runId} and provider_tool_call_id = ${identity.providerToolCallId}`;
      if (existing !== undefined) {
        if (
          existing.operation_id !== identity.operationId ||
          existing.tool_name !== identity.toolName ||
          existing.argument_digest !== identity.argumentDigest
        ) {
          throw new RunStoreError('tool_call_conflict', 'a provider tool-call ID was reused with a different binding');
        }
        const disposition = toolDispositionSchema.parse(parseJsonText(existing.disposition));
        if (disposition.kind === 'completed') {
          return { kind: 'reuse', outcome: disposition.result as RecordedToolOutcome };
        }
        return disposition.kind === 'abandoned' ? { kind: 'not_dispatchable' } : { kind: 'execute' };
      }
      await tx`insert into runtime.tool_operations (run_id, operation_id, model_message_id, provider_tool_call_id,
          tool_name, arguments, argument_digest, disposition)
        values (${runId}, ${identity.operationId}, ${identity.modelMessageId}, ${identity.providerToolCallId},
          ${identity.toolName}, ${jsonText(identity.arguments)}::text::jsonb, ${identity.argumentDigest},
          ${jsonText({ kind: 'started' })}::text::jsonb)`;
      await this.#append(tx, runId, [
        {
          event: {
            kind: 'tool.operation',
            payload: {
              operationId: identity.operationId,
              toolName: identity.toolName,
              disposition: { kind: 'started' },
            },
          },
          sourceKey: `tool:${identity.operationId}:started`,
        },
      ]);
      return { kind: 'execute' };
    });
  }

  /**
   * Records a started (or paused) tool call's outcome with its event. Recording the same outcome again is
   * idempotent; a different outcome for a completed call is an invariant failure. A finished run takes no
   * further records.
   */
  async completeToolOperation(runId: string, identity: ToolOperationIdentity, outcome: RecordedToolOutcome) {
    const disposition = toolDispositionSchema.parse({ kind: 'completed', outcome: outcome.outcome, result: outcome });
    return withOwnerFence(this.db, this.owner, async (tx) => {
      const run = await this.#lockRun(tx, runId);
      if (TERMINAL_STATES.has(run.state.kind)) throw new RunStoreError('run_finished', 'the run has already finished');
      const [row] = await tx`
        select disposition::text as disposition from runtime.tool_operations
        where run_id = ${runId} and operation_id = ${identity.operationId} for update`;
      if (row === undefined) throw new RunStoreError('invariant_violation', 'the tool operation was never started');
      const current = toolDispositionSchema.parse(parseJsonText(row.disposition));
      if (current.kind === 'completed') {
        if (canonicalJson(current) !== canonicalJson(disposition)) {
          throw new RunStoreError('invariant_violation', 'the tool operation already has a different outcome');
        }
      } else if (current.kind === 'abandoned') {
        throw new RunStoreError('invariant_violation', 'the tool operation was abandoned');
      } else {
        await tx`update runtime.tool_operations set disposition = ${jsonText(disposition)}::text::jsonb
          where run_id = ${runId} and operation_id = ${identity.operationId}`;
      }
      await this.#append(tx, runId, [
        {
          event: {
            kind: 'tool.operation',
            payload: { operationId: identity.operationId, toolName: identity.toolName, disposition },
          },
          sourceKey: `tool:${identity.operationId}:completed`,
        },
      ]);
    });
  }

  /**
   * Makes a settled, inspected question answerable (Decision 6), all in one transaction: the invocation settles,
   * the question's tool operation pauses on it, the exact question and its saved-state binding are recorded, and
   * the run moves from working to waiting with its question and status events. Only the run's current working
   * invocation can publish.
   */
  async publishQuestion(input: PublishQuestionInput): Promise<{ revision: string }> {
    const binding = questionBindingSchema.parse(input.binding);
    if (binding.threadId !== input.runId || binding.operationId !== input.questionId) {
      throw new RangeError('the binding does not belong to this question');
    }
    const bindingDigest = digestOf(binding);
    const { revision } = await this.transition({
      runId: input.runId,
      expectedRevision: input.expectedRevision,
      next: { kind: 'waiting', questionId: input.questionId, bindingDigest },
      apply: async (tx) => {
        const [run] = await tx`select state::text as state from runtime.runs where run_id = ${input.runId}`;
        const state = runStateSchema.parse(parseJsonText(run.state));
        if (state.kind !== 'working' || state.invocationId !== input.invocationId) {
          throw new RunStoreError('stale_revision', 'the run is not working under this invocation');
        }
        const paused = await tx`update runtime.tool_operations
          set disposition = ${jsonText({ kind: 'paused', questionId: input.questionId })}::text::jsonb
          where run_id = ${input.runId} and operation_id = ${input.questionId} and disposition ->> 'kind' = 'started'
          returning operation_id`;
        if (paused.length !== 1) throw new RunStoreError('invariant_violation', 'the question call was not started');
        await tx`insert into runtime.questions (run_id, question_id, operation_id, prompt, input, binding,
            payload_digest, binding_digest, disposition)
          values (${input.runId}, ${input.questionId}, ${input.questionId}, ${input.prompt},
            ${jsonText(input.input)}::text::jsonb, ${jsonText(binding)}::text::jsonb, ${binding.payloadDigest},
            ${bindingDigest}, ${jsonText({ kind: 'pending' })}::text::jsonb)`;
        const settled = await tx`update runtime.invocations set disposition = 'settled', ended_at = now()
          where run_id = ${input.runId} and invocation_id = ${input.invocationId} and disposition = 'active'
          returning invocation_id`;
        if (settled.length !== 1) throw new RunStoreError('invariant_violation', 'the invocation is not active');
      },
      events: [
        {
          event: {
            kind: 'tool.operation',
            payload: {
              operationId: input.questionId,
              toolName: 'mcp_AskUser',
              disposition: { kind: 'paused', questionId: input.questionId },
            },
          },
          sourceKey: `tool:${input.questionId}:paused`,
        },
        {
          event: {
            kind: 'question.asked',
            payload: { questionId: input.questionId, prompt: input.prompt, input: input.input },
          },
          sourceKey: `question:${input.questionId}`,
        },
      ],
    });
    return { revision };
  }

  /** The question and its run, from one consistent snapshot; undefined when either does not exist. */
  async readQuestion(runId: string, questionId: string): Promise<RecordedQuestion | undefined> {
    return this.db.readOnly(async (tx) => {
      const [row] = await tx`
        select q.prompt, q.input::text as input, q.binding::text as binding, q.binding_digest,
          q.disposition::text as disposition, r.state::text as state, r.revision::text as revision,
          r.binding::text as run_binding, r.workspace::text as workspace
        from runtime.questions q join runtime.runs r on r.run_id = q.run_id
        where q.run_id = ${runId} and q.question_id = ${questionId}`;
      if (row === undefined) return undefined;
      return {
        runId,
        questionId,
        prompt: row.prompt,
        input: questionInputSchema.parse(parseJsonText(row.input)),
        binding: questionBindingSchema.parse(parseJsonText(row.binding)),
        bindingDigest: row.binding_digest,
        disposition: questionDispositionSchema.parse(parseJsonText(row.disposition)),
        run: {
          state: runStateSchema.parse(parseJsonText(row.state)),
          revision: row.revision,
          binding: providerBindingSchema.parse(parseJsonText(row.run_binding)),
          workspace: workspaceSchema.parse(parseJsonText(row.workspace)),
        },
      };
    }, 'repeatable read');
  }

  /**
   * Accepts an answer to the run's pending question, all in one transaction: the question is answered, a new
   * answer invocation starts, and the run moves from waiting to working with its answer and status events. It
   * succeeds only if the run is still waiting on exactly this question and binding at the expected revision; a
   * concurrent acceptance, cancellation or failure makes it fail with `stale_revision`, never overwrite.
   */
  async acceptAnswer(input: {
    runId: string;
    questionId: string;
    bindingDigest: string;
    expectedRevision: string;
    answer: Answer;
  }): Promise<AcceptedAnswer> {
    const invocationId = crypto.randomUUID();
    const ownerEpoch = this.owner.epoch;
    let acceptedAt = '';
    const { revision } = await this.transition({
      runId: input.runId,
      expectedRevision: input.expectedRevision,
      next: { kind: 'working', invocationId, ownerEpoch },
      apply: async (tx) => {
        const [run] = await tx`select state::text as state from runtime.runs where run_id = ${input.runId}`;
        const state = runStateSchema.parse(parseJsonText(run.state));
        if (
          state.kind !== 'waiting' ||
          state.questionId !== input.questionId ||
          state.bindingDigest !== input.bindingDigest
        ) {
          throw new RunStoreError('stale_revision', 'the run is not waiting on this question');
        }
        const [now] =
          await tx`select to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as at`;
        acceptedAt = now.at as string;
        const disposition = { kind: 'answered', answer: input.answer, acceptedAt, invocationId };
        const updated = await tx`update runtime.questions set disposition = ${jsonText(disposition)}::text::jsonb
          where run_id = ${input.runId} and question_id = ${input.questionId} and disposition_kind = 'pending'
          returning question_id`;
        if (updated.length !== 1) throw new RunStoreError('stale_revision', 'the question is no longer pending');
        await tx`insert into runtime.invocations (run_id, invocation_id, owner_epoch, kind, question_id, disposition)
          values (${input.runId}, ${invocationId}, ${ownerEpoch}, 'answer', ${input.questionId}, 'active')`;
      },
      events: () => [
        {
          event: {
            kind: 'question.answered',
            payload: { questionId: input.questionId, answer: input.answer, invocationId, acceptedAt },
          },
          sourceKey: `answer:${input.questionId}`,
        },
      ],
    });
    return { answer: input.answer, acceptedAt, invocationId, revision };
  }

  /**
   * Refuses continuation of a waiting run whose saved state is confirmed missing, unusable or incompatible: the
   * unanswered question closes and the run fails, atomically. Only a run still waiting on this question at the
   * expected revision is changed.
   */
  async refuseContinuation(input: {
    runId: string;
    questionId: string;
    expectedRevision: string;
    failure: Failure;
  }): Promise<{ revision: string }> {
    let closedAt = '';
    const { revision } = await this.transition({
      runId: input.runId,
      expectedRevision: input.expectedRevision,
      next: () => ({ kind: 'failed', finishedAt: closedAt, failure: input.failure }),
      apply: async (tx) => {
        const [run] = await tx`select state::text as state from runtime.runs where run_id = ${input.runId}`;
        const state = runStateSchema.parse(parseJsonText(run.state));
        if (state.kind !== 'waiting' || state.questionId !== input.questionId) {
          throw new RunStoreError('stale_revision', 'the run is not waiting on this question');
        }
        const [now] =
          await tx`select to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as at`;
        closedAt = now.at as string;
        const disposition = { kind: 'closed', reason: input.failure.reason, closedAt };
        await tx`update runtime.questions set disposition = ${jsonText(disposition)}::text::jsonb
          where run_id = ${input.runId} and question_id = ${input.questionId} and disposition_kind = 'pending'`;
      },
      events: () => [
        {
          event: {
            kind: 'question.closed',
            payload: { questionId: input.questionId, reason: input.failure.reason, closedAt },
          },
          sourceKey: `question-closed:${input.questionId}`,
        },
      ],
    });
    return { revision };
  }

  /**
   * Durably reserves one model request (Decision 8): only for the run's current working invocation, and only
   * within budget, where an unconfirmed admission still occupies capacity. The reservation is charged as
   * unconfirmed until dispatch is confirmed.
   */
  async reserveAttempt(runId: string, invocationId: string): Promise<{ attemptId: string; ordinal: number }> {
    const attemptId = crypto.randomUUID();
    return withOwnerFence(this.db, this.owner, async (tx) => {
      const run = await this.#lockRun(tx, runId);
      if (run.state.kind !== 'working' || run.state.invocationId !== invocationId) {
        throw new RunStoreError('not_dispatchable', 'the run does not permit another model request');
      }
      const [budget] = await tx`
        select budget_max, consumed, unconfirmed, binding::text as binding from runtime.runs where run_id = ${runId}`;
      if (Number(budget.consumed) + Number(budget.unconfirmed) >= Number(budget.budget_max)) {
        throw new RunStoreError('budget_exhausted', 'another model request would exceed the step budget');
      }
      const ceiling = this.options.modelRequestCeiling;
      if (ceiling !== undefined) {
        // Every run's admissions take the same transaction lock, so two runs cannot both pass the last slot. An
        // attempt known never to have been sent does not count; an unconfirmed one does.
        await tx`select pg_advisory_xact_lock(${LOCK_NAMESPACE}, ${REQUEST_CEILING_LOCK})`;
        const [admitted] = await tx`
          select count(*)::int as count from runtime.model_attempts where state_kind <> 'abandoned'`;
        if (Number(admitted.count) >= ceiling) {
          throw new RunStoreError('ceiling_reached', 'the deployment-wide model-request ceiling has been reached');
        }
      }
      const binding = providerBindingSchema.parse(parseJsonText(budget.binding));
      const [next] = await tx`
        select coalesce(max(ordinal), 0)::int + 1 as ordinal from runtime.model_attempts where run_id = ${runId}`;
      const ordinal = Number(next.ordinal);
      const state: AttemptState = { kind: 'reserved' };
      await tx`insert into runtime.model_attempts (run_id, attempt_id, invocation_id, ordinal, provider, model,
          profile_id, state)
        values (${runId}, ${attemptId}, ${invocationId}, ${ordinal}, ${binding.provider}, ${binding.model},
          ${binding.profileId}, ${jsonText(state)}::text::jsonb)`;
      await this.#attemptEvent(tx, runId, attemptId, ordinal, state, { unconfirmed: 1 });
      return { attemptId, ordinal };
    });
  }

  /**
   * Moves an attempt to its next state, adjusting the public counts with it: dispatch confirmation moves the
   * charge from unconfirmed to consumed, abandonment before dispatch releases it, and an unconfirmed attempt stays
   * charged. Repeating a transition already made is idempotent.
   */
  async settleAttempt(
    runId: string,
    attemptId: string,
    next:
      | { kind: 'dispatched' }
      | { kind: 'completed'; outcome: 'ok' | 'failed'; providerRequestId?: string }
      | { kind: 'abandoned'; reason: string }
      | { kind: 'unconfirmed' },
  ): Promise<void> {
    await withOwnerFence(this.db, this.owner, async (tx) => {
      const run = await this.#lockRun(tx, runId);
      if (TERMINAL_STATES.has(run.state.kind)) throw new RunStoreError('run_finished', 'the run has already finished');
      const [row] = await tx`
        select ordinal, state::text as state from runtime.model_attempts
        where run_id = ${runId} and attempt_id = ${attemptId} for update`;
      if (row === undefined) throw new RunStoreError('invariant_violation', 'no such model attempt');
      const current = attemptStateSchema.parse(parseJsonText(row.state));
      if (current.kind === next.kind) return;
      const [clock] =
        await tx`select to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as at`;
      const at = clock.at as string;
      let state: AttemptState;
      let delta = { consumed: 0, unconfirmed: 0 };
      if (current.kind === 'reserved' && next.kind === 'dispatched') {
        state = { kind: 'dispatched', dispatchedAt: at };
        delta = { consumed: 1, unconfirmed: -1 };
      } else if (current.kind === 'dispatched' && next.kind === 'completed') {
        state = {
          kind: 'completed',
          dispatchedAt: current.dispatchedAt,
          completedAt: at,
          outcome: next.outcome,
          ...(next.providerRequestId === undefined ? {} : { providerRequestId: next.providerRequestId }),
        };
      } else if (current.kind === 'reserved' && next.kind === 'abandoned') {
        state = { kind: 'abandoned', reason: next.reason, at };
        delta = { consumed: 0, unconfirmed: -1 };
      } else if (current.kind === 'reserved' && next.kind === 'unconfirmed') {
        state = { kind: 'unconfirmed', detectedAt: at };
      } else if (current.kind === 'dispatched' && next.kind === 'unconfirmed') {
        state = { kind: 'unconfirmed', detectedAt: at };
        delta = { consumed: -1, unconfirmed: 1 };
      } else {
        throw new RunStoreError('invariant_violation', 'invalid model attempt transition');
      }
      await tx`update runtime.model_attempts set state = ${jsonText(state)}::text::jsonb
        where run_id = ${runId} and attempt_id = ${attemptId}`;
      await this.#attemptEvent(tx, runId, attemptId, Number(row.ordinal), state, delta);
    });
  }

  async #attemptEvent(
    tx: TransactionSQL,
    runId: string,
    attemptId: string,
    ordinal: number,
    state: AttemptState,
    delta: { consumed?: number; unconfirmed?: number },
  ) {
    const [budget] = await tx`
      update runtime.runs set consumed = consumed + ${delta.consumed ?? 0}, unconfirmed = unconfirmed + ${delta.unconfirmed ?? 0}
      where run_id = ${runId} returning budget_max, consumed, unconfirmed`;
    await this.#append(tx, runId, [
      {
        event: {
          kind: 'model.attempt',
          payload: {
            attemptId,
            ordinal,
            state,
            budget: {
              maximum: Number(budget.budget_max),
              consumed: Number(budget.consumed),
              unconfirmed: Number(budget.unconfirmed),
            },
          },
        },
        sourceKey: `attempt:${attemptId}:${state.kind}`,
      },
    ]);
  }

  /**
   * Accepts cancellation of an unfinished run (Decision 8), durably, before anything is acknowledged. A waiting run
   * has no local work, so its question closes and it is cancelled at once; a working run becomes `cancelling`
   * until its local work settles. A run accepts one cancellation: repeating its request returns the recorded
   * disposition, and a different request is a conflict. An answer accepted earlier stays accepted.
   */
  async acceptCancellation(runId: string, requestId: string): Promise<CancellationResult> {
    for (let attempt = 0; attempt < 4; attempt++) {
      const recorded = await this.findCancellation(runId);
      const snapshot = await this.snapshot(runId);
      if (recorded !== undefined) {
        return recorded.requestId === requestId
          ? {
              kind: 'repeated',
              cancellationId: recorded.cancellationId,
              acceptedAt: recorded.acceptedAt,
              state: snapshot.state,
            }
          : { kind: 'conflict', state: snapshot.state };
      }
      const state = snapshot.state;
      if (state.kind !== 'working' && state.kind !== 'waiting') return { kind: 'finished', state };
      const cancellationId = crypto.randomUUID();
      let acceptedAt = '';
      try {
        const { events } = await this.transition({
          runId,
          expectedRevision: snapshot.revision,
          apply: async (tx) => {
            const [now] =
              await tx`select to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as at`;
            acceptedAt = now.at as string;
            if (state.kind === 'waiting') {
              await tx`update runtime.questions
                set disposition = ${jsonText({ kind: 'closed', reason: 'cancelled', closedAt: acceptedAt })}::text::jsonb
                where run_id = ${runId} and question_id = ${state.questionId} and disposition_kind = 'pending'`;
            }
          },
          next: () =>
            state.kind === 'waiting'
              ? { kind: 'cancelled', finishedAt: acceptedAt, cancellationId, acceptedAt }
              : { kind: 'cancelling', cancellationId, acceptedAt, invocationId: state.invocationId },
          events: () => [
            {
              event: { kind: 'cancellation.accepted', payload: { cancellationId, requestId, acceptedAt } },
              sourceKey: 'cancellation',
            },
            ...(state.kind === 'waiting'
              ? [
                  {
                    event: {
                      kind: 'question.closed' as const,
                      payload: { questionId: state.questionId, reason: 'cancelled', closedAt: acceptedAt },
                    },
                    sourceKey: `question-closed:${state.questionId}`,
                  },
                ]
              : []),
          ],
        });
        const status = events[0]?.event;
        return {
          kind: 'accepted',
          cancellationId,
          acceptedAt,
          state: status?.kind === 'run.status' ? status.payload.state : snapshot.state,
        };
      } catch (error) {
        // Another change won first (a concurrent cancellation, publication, answer or finish): look again.
        if (
          error instanceof RunStoreError &&
          ['stale_revision', 'run_finished', 'source_key_conflict'].includes(error.code)
        ) {
          continue;
        }
        throw error;
      }
    }
    throw new RunStoreError('stale_revision', 'the run kept changing while cancellation was being accepted');
  }

  /** The run's accepted cancellation, if any. */
  async findCancellation(
    runId: string,
  ): Promise<{ cancellationId: string; requestId: string; acceptedAt: string } | undefined> {
    const event = await this.findEvent(runId, 'cancellation');
    return event?.event.kind === 'cancellation.accepted' ? event.event.payload : undefined;
  }

  /**
   * Completes an accepted cancellation once the run's local work has settled: the invocation settles, unfinished
   * tool calls are abandoned, an admission that never got as far as dispatch is recorded unconfirmed, and the run
   * becomes cancelled. Only a `cancelling` run changes; any other state is returned as recorded.
   */
  async finishCancellation(runId: string): Promise<RunState> {
    for (let attempt = 0; attempt < 4; attempt++) {
      const snapshot = await this.snapshot(runId);
      const state = snapshot.state;
      if (state.kind !== 'cancelling') return state;
      let finishedAt = '';
      try {
        await this.transition({
          runId,
          expectedRevision: snapshot.revision,
          apply: async (tx) => {
            const [now] =
              await tx`select to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as at`;
            finishedAt = now.at as string;
            await tx`update runtime.invocations set disposition = 'settled', ended_at = now()
              where run_id = ${runId} and disposition = 'active'`;
            await tx`update runtime.tool_operations
              set disposition = ${jsonText({ kind: 'abandoned', reason: 'cancelled' })}::text::jsonb
              where run_id = ${runId} and disposition ->> 'kind' in ('started', 'paused')`;
            const reserved = await tx`select attempt_id::text as attempt_id, ordinal from runtime.model_attempts
              where run_id = ${runId} and state_kind = 'reserved'`;
            for (const row of reserved) {
              const unconfirmed: AttemptState = { kind: 'unconfirmed', detectedAt: finishedAt };
              await tx`update runtime.model_attempts set state = ${jsonText(unconfirmed)}::text::jsonb
                where run_id = ${runId} and attempt_id = ${row.attempt_id}`;
              await this.#attemptEvent(tx, runId, row.attempt_id, Number(row.ordinal), unconfirmed, {});
            }
          },
          next: () => ({
            kind: 'cancelled',
            finishedAt,
            cancellationId: state.cancellationId,
            acceptedAt: state.acceptedAt,
          }),
        });
        return (await this.snapshot(runId)).state;
      } catch (error) {
        if (error instanceof RunStoreError && error.code === 'stale_revision') continue;
        throw error;
      }
    }
    throw new RunStoreError('stale_revision', 'the run kept changing while cancellation was being completed');
  }

  /**
   * Records an invocation's terminal outcome (Decisions 4 and 14): success, which must reference an
   * `assistant.message` event already recorded for this run, or a typed failure. The invocation settles, unfinished
   * tool calls are abandoned and an admission never confirmed as dispatched stays charged as unconfirmed. Only the
   * run's current working invocation can finish it; otherwise (cancellation accepted, another invocation, already
   * finished) nothing changes and `superseded` is returned.
   */
  async finishInvocation(input: {
    runId: string;
    invocationId: string;
    outcome: { kind: 'succeeded'; resultSeq: string } | { kind: 'failed'; failure: Failure };
  }): Promise<{ kind: 'finished'; state: RunState } | { kind: 'superseded'; state: RunState }> {
    for (let attempt = 0; attempt < 4; attempt++) {
      const snapshot = await this.snapshot(input.runId);
      const state = snapshot.state;
      if (state.kind !== 'working' || state.invocationId !== input.invocationId) return { kind: 'superseded', state };
      let finishedAt = '';
      try {
        const { events } = await this.transition({
          runId: input.runId,
          expectedRevision: snapshot.revision,
          apply: async (tx) => {
            finishedAt = await this.#settleLocalRecords(tx, input.runId, 'settled');
          },
          next: () =>
            input.outcome.kind === 'succeeded'
              ? { kind: 'succeeded', finishedAt, resultSeq: input.outcome.resultSeq }
              : { kind: 'failed', finishedAt, failure: input.outcome.failure },
        });
        const status = events[0]?.event;
        return { kind: 'finished', state: status?.kind === 'run.status' ? status.payload.state : state };
      } catch (error) {
        if (error instanceof RunStoreError && (error.code === 'stale_revision' || error.code === 'run_finished'))
          continue;
        throw error;
      }
    }
    return { kind: 'superseded', state: (await this.snapshot(input.runId)).state };
  }

  /**
   * Startup reconciliation after a restart (Decision 6), before anything is dispatched: a run that was working is
   * interrupted — its invocation too, its unfinished tool calls abandoned and any admission whose dispatch was
   * unconfirmed recorded as such — and a run whose cancellation was accepted is cancelled. Waiting and finished
   * runs are unchanged. Nothing is resumed, retried or dispatched.
   */
  async reconcileAfterRestart(): Promise<{ interrupted: number; cancelled: number }> {
    const rows = await this.db.readOnly(
      (tx) => tx`select run_id::text as run_id from runtime.runs where state ->> 'kind' in ('working', 'cancelling')`,
    );
    let interrupted = 0;
    let cancelled = 0;
    for (const { run_id: runId } of rows as { run_id: string }[]) {
      const snapshot = await this.snapshot(runId);
      const state = snapshot.state;
      let at = '';
      if (state.kind === 'cancelling') {
        await this.transition({
          runId,
          expectedRevision: snapshot.revision,
          apply: async (tx) => {
            at = await this.#settleLocalRecords(tx, runId, 'interrupted');
          },
          next: () => ({
            kind: 'cancelled',
            finishedAt: at,
            cancellationId: state.cancellationId,
            acceptedAt: state.acceptedAt,
          }),
        });
        cancelled++;
      } else if (state.kind === 'working') {
        await this.transition({
          runId,
          expectedRevision: snapshot.revision,
          apply: async (tx) => {
            at = await this.#settleLocalRecords(tx, runId, 'interrupted');
          },
          next: () => ({
            kind: 'interrupted',
            detectedAt: at,
            lastActivityAt: snapshot.lastActivityAt,
            invocationId: state.invocationId,
          }),
        });
        interrupted++;
      }
    }
    return { interrupted, cancelled };
  }

  /**
   * Closes a run's local records within a transaction: the active invocation takes `invocationDisposition`,
   * started or paused tool calls are abandoned, and an admission never confirmed as dispatched is recorded
   * unconfirmed (it may or may not have reached the provider, and stays charged). A dispatched attempt is known to
   * have been sent and keeps that record. Returns the transaction's clock.
   */
  async #settleLocalRecords(
    tx: TransactionSQL,
    runId: string,
    invocationDisposition: 'settled' | 'interrupted',
  ): Promise<string> {
    const [now] = await tx`select to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as at`;
    const at = now.at as string;
    await tx`update runtime.invocations set disposition = ${invocationDisposition}, ended_at = now()
      where run_id = ${runId} and disposition = 'active'`;
    await tx`update runtime.tool_operations
      set disposition = ${jsonText({ kind: 'abandoned', reason: invocationDisposition === 'interrupted' ? 'interrupted' : 'unfinished' })}::text::jsonb
      where run_id = ${runId} and disposition ->> 'kind' in ('started', 'paused')`;
    const reserved = await tx`select attempt_id::text as attempt_id, ordinal from runtime.model_attempts
      where run_id = ${runId} and state_kind = 'reserved'`;
    for (const row of reserved as { attempt_id: string; ordinal: number }[]) {
      const unconfirmed: AttemptState = { kind: 'unconfirmed', detectedAt: at };
      await tx`update runtime.model_attempts set state = ${jsonText(unconfirmed)}::text::jsonb
        where run_id = ${runId} and attempt_id = ${row.attempt_id}`;
      await this.#attemptEvent(tx, runId, row.attempt_id, Number(row.ordinal), unconfirmed, {});
    }
    return at;
  }

  /** Readback for publication: whether the run is waiting on this question. */
  async findPublishedQuestion(runId: string, questionId: string): Promise<{ revision: string } | undefined> {
    const snapshot = await this.snapshot(runId);
    return snapshot.state.kind === 'waiting' && snapshot.state.questionId === questionId
      ? { revision: snapshot.revision }
      : undefined;
  }

  async #lockRun(tx: TransactionSQL, runId: string): Promise<{ state: RunState; revision: string }> {
    const [row] = await tx`
      select state::text as state, revision::text as revision from runtime.runs where run_id = ${runId} for update`;
    if (row === undefined) throw new RunStoreError('run_not_found', 'no such run');
    return { state: runStateSchema.parse(parseJsonText(row.state)), revision: row.revision };
  }

  /**
   * Appends events under the run's row lock, so sequence order is commit order. A source key already recorded
   * with the same event is returned unchanged; with a different event it is an invariant failure.
   */
  async #append(tx: TransactionSQL, runId: string, events: NewEvent[]): Promise<StoredEvent[]> {
    const stored: StoredEvent[] = [];
    for (const { event, sourceKey } of events) {
      const parsed = eventSchema.parse(event);
      const [existing] = await tx`
        select seq::text as seq, kind, payload::text as payload, to_char(recorded_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as recorded_at
        from runtime.events where run_id = ${runId} and source_key = ${sourceKey}`;
      if (existing !== undefined) {
        const same =
          existing.kind === parsed.kind &&
          canonicalJson(parseJsonText(existing.payload)) === canonicalJson(parsed.payload);
        if (!same)
          throw new RunStoreError('source_key_conflict', 'an event source was recorded with different content');
        stored.push({ runId, seq: existing.seq, recordedAt: existing.recorded_at, event: parsed, sourceKey });
        continue;
      }
      const [allocated] = await tx`
        update runtime.runs set last_seq = last_seq + 1, last_activity_at = clock_timestamp()
        where run_id = ${runId} returning last_seq::text as seq`;
      const [row] = await tx`
        insert into runtime.events (run_id, seq, kind, payload, source_key)
        values (${runId}, ${allocated.seq}::bigint, ${parsed.kind}, ${jsonText(parsed.payload)}::text::jsonb, ${sourceKey})
        returning to_char(recorded_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as recorded_at`;
      stored.push({ runId, seq: allocated.seq, recordedAt: row.recorded_at, event: parsed, sourceKey });
    }
    return stored;
  }

  /** Readback for any recorded activity: the event a source key produced, if that commit happened. */
  async findEvent(runId: string, sourceKey: string): Promise<StoredEvent | undefined> {
    const [row] = await this.db.readOnly(
      (tx) => tx`
      select seq::text as seq, kind, payload::text as payload, to_char(recorded_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as recorded_at
      from runtime.events where run_id = ${runId} and source_key = ${sourceKey}`,
    );
    if (row === undefined) return undefined;
    const event = eventSchema.parse({ kind: row.kind, payload: parseJsonText(row.payload) });
    return { runId, seq: row.seq, recordedAt: row.recorded_at, event, sourceKey };
  }

  /** A consistent view of one run: state, budget, pending question and the history boundary, from one snapshot. */
  async snapshot(runId: string): Promise<RunSnapshot> {
    return this.db.readOnly(async (tx) => {
      const [run] = await tx`
        select run_id::text as run_id, create_request_id::text as create_request_id, goal, workspace::text as workspace,
          binding::text as binding, definition_digest, budget_max, consumed, unconfirmed, state::text as state,
          revision::text as revision, last_seq::text as last_seq,
          to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as created_at, to_char(last_activity_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as last_activity_at
        from runtime.runs where run_id = ${runId}`;
      if (run === undefined) throw new RunStoreError('run_not_found', 'no such run');
      const [question] = await tx`
        select question_id, prompt, input::text as input from runtime.questions
        where run_id = ${runId} and disposition_kind = 'pending'`;
      return {
        runId: run.run_id,
        createRequestId: run.create_request_id,
        goal: run.goal,
        workspace: workspaceSchema.parse(parseJsonText(run.workspace)),
        binding: providerBindingSchema.parse(parseJsonText(run.binding)),
        definitionDigest: run.definition_digest,
        budget: {
          maximum: Number(run.budget_max),
          consumed: Number(run.consumed),
          unconfirmed: Number(run.unconfirmed),
        },
        state: runStateSchema.parse(parseJsonText(run.state)),
        revision: run.revision,
        createdAt: run.created_at,
        lastActivityAt: run.last_activity_at,
        pendingQuestion:
          question === undefined
            ? undefined
            : {
                questionId: question.question_id,
                prompt: question.prompt,
                input: questionInputSchema.parse(parseJsonText(question.input)),
              },
        throughSeq: run.last_seq,
      };
    }, 'repeatable read');
  }

  /**
   * Run summaries, newest first, continuing strictly after `before` (the creation time and ID of the last run of the
   * previous page). Ties in creation time are ordered by run ID, so pages neither repeat nor skip runs.
   */
  async listRuns(options: { limit: number; before?: { createdAt: string; runId: string } }): Promise<RunSummary[]> {
    if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 1_000) {
      throw new RangeError('limit must be between 1 and 1000');
    }
    const at = options.before?.createdAt ?? null;
    const id = options.before?.runId ?? null;
    const rows = await this.db.readOnly(
      (tx) => tx`
      select run_id::text as run_id, goal, binding::text as binding, state ->> 'kind' as status,
        to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as created_at,
        to_char(last_activity_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as last_activity_at
      from runtime.runs
      where ${at}::timestamptz is null or (created_at, run_id) < (${at}::timestamptz, ${id}::uuid)
      order by created_at desc, run_id desc limit ${options.limit}`,
    );
    return rows.map(
      (row: {
        run_id: string;
        goal: string;
        binding: string;
        status: string;
        created_at: string;
        last_activity_at: string;
      }) => {
        if (!RUN_STATE_KINDS.has(row.status as RunState['kind'])) {
          throw new RunStoreError('invariant_violation', 'a stored run state is not recognized');
        }
        return {
          runId: row.run_id,
          goal: row.goal,
          binding: providerBindingSchema.parse(parseJsonText(row.binding)),
          status: row.status as RunState['kind'],
          createdAt: row.created_at,
          lastActivityAt: row.last_activity_at,
        };
      },
    );
  }

  /** Committed events strictly after a cursor, optionally up to a fixed bound, in sequence order. */
  async readEvents(runId: string, options: { after: string; through?: string; limit: number }): Promise<StoredEvent[]> {
    const after = parseSequence(options.after).toString();
    const through = options.through === undefined ? null : parseSequence(options.through).toString();
    if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 1_000) {
      throw new RangeError('limit must be between 1 and 1000');
    }
    const rows = await this.db.readOnly(
      (tx) => tx`
      select seq::text as seq, kind, payload::text as payload, source_key,
        to_char(recorded_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as recorded_at
      from runtime.events
      where run_id = ${runId} and seq > ${after}::bigint and (${through}::bigint is null or seq <= ${through}::bigint)
      order by events.seq limit ${options.limit}`,
    );
    return rows.map((row: { seq: string; kind: string; payload: string; source_key: string; recorded_at: string }) => ({
      runId,
      seq: row.seq,
      recordedAt: row.recorded_at,
      sourceKey: row.source_key,
      event: eventSchema.parse({ kind: row.kind, payload: parseJsonText(row.payload) }),
    }));
  }

  /**
   * Resolves an operation whose commit outcome may be unknown. After an ambiguous failure, the result is read back
   * under the same, re-verified ownership; if that is impossible the outcome stays unknown and nothing may be
   * dispatched on its behalf.
   */
  async withCommitCertainty<T>(
    operation: () => Promise<T>,
    readback: () => Promise<T | undefined>,
  ): Promise<{ committed: true; value: T } | { committed: false }> {
    try {
      return { committed: true, value: await operation() };
    } catch (error) {
      if (!isAmbiguousCommitError(error)) throw error;
      try {
        this.owner.assertHeld();
        await this.owner.verify();
        const found = await readback();
        return found === undefined ? { committed: false } : { committed: true, value: found };
      } catch {
        throw new RunStoreError('acceptance_unknown', 'whether the change was recorded cannot be established');
      }
    }
  }
}
