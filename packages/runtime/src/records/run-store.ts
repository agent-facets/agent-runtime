import type { TransactionSQL } from 'bun';
import type { AppDatabase } from '../persistence/app-database.ts';
import { sqlStateOf } from '../persistence/errors.ts';
import { jsonText, parseJsonText } from '../persistence/json.ts';
import { type OwnerFence, withOwnerFence } from '../persistence/ownership.ts';
import { canonicalJson, digestOf, parseSequence } from './canonical.ts';
import {
  eventSchema,
  type Provider,
  type ProviderBinding,
  providerBindingSchema,
  questionInputSchema,
  type RunEvent,
  type RunState,
  runStateSchema,
  TERMINAL_STATES,
  type WorkspaceSnapshot,
  workspaceSchema,
} from './schemas.ts';

export type RunStoreErrorCode =
  | 'request_conflict'
  | 'run_not_found'
  | 'stale_revision'
  | 'run_finished'
  | 'source_key_conflict'
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
  next: RunState;
  /** Additional events committed with the status change, in order after it. */
  events?: NewEvent[];
  /** Further record changes that must commit atomically with the transition. */
  apply?: (tx: TransactionSQL) => Promise<void>;
}

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

export class RunStore {
  constructor(
    private readonly db: AppDatabase,
    private readonly owner: OwnerFence,
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
    const next = runStateSchema.parse(input.next);
    return withOwnerFence(this.db, this.owner, async (tx) => {
      const run = await this.#lockRun(tx, input.runId);
      if (TERMINAL_STATES.has(run.state.kind)) throw new RunStoreError('run_finished', 'the run has already finished');
      if (run.revision !== input.expectedRevision) {
        throw new RunStoreError('stale_revision', 'the run changed since it was read');
      }
      await input.apply?.(tx);
      const [row] = await tx`
        update runtime.runs set state = ${jsonText(next)}::text::jsonb, revision = revision + 1
        where run_id = ${input.runId} returning revision::text as revision`;
      const revision = row.revision as string;
      const events = await this.#append(tx, input.runId, [
        { event: { kind: 'run.status', payload: { revision, state: next } }, sourceKey: `status:${revision}` },
        ...(input.events ?? []),
      ]);
      return { revision, events };
    });
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
