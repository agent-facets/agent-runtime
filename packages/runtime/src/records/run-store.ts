import type { ActorRef, ToolBinding } from '@agent-runtime/contracts';
import type { TransactionSQL } from 'bun';
import {
  actorKeyOf,
  type CapabilitySnapshot,
  type CommandRunInput,
  commandRunInputSchema,
  type DelegateOutcome,
  type DelegateState,
  delegateOutcomeSchema,
  delegateStateSchema,
  type GoalRunInput,
  type LoadedSkill,
  loadedSkillSchema,
  openSnapshot,
  sealSnapshot,
} from '../capabilities/records.ts';
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
  operationIdV2,
  type Provider,
  type ProviderBinding,
  providerBindingSchema,
  type QuestionBinding,
  type QuestionDisposition,
  type QuestionInput,
  questionActorKey,
  questionBindingSchema,
  questionDispositionSchema,
  questionInputSchema,
  type RunEvent,
  type RunState,
  runStateSchema,
  TERMINAL_STATES,
  type ToolDisposition,
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
  /** `asker` is recorded for version-2 questions only; a phase-1 question is the root's. */
  pendingQuestion: { questionId: string; prompt: string; input: unknown; asker?: ActorRef } | undefined;
  /** The command a command run was started from; absent for native goal runs. */
  command: RunCommand | undefined;
  /** Every committed event up to and including this sequence belongs to this snapshot. */
  throughSeq: string;
}

export interface RunCommand {
  commandId: string;
  selectionRevision: string;
  arguments: string;
  snapshotDigest: string;
}

/** A command run's retained capability binding, revalidated against its content address when read. */
export interface RunCapabilities {
  input: CommandRunInput;
  snapshotDigest: string;
  maxDelegations: number;
  snapshot: CapabilitySnapshot;
}

/**
 * What a run retained and recorded about its capabilities, read in one consistent view with the history boundary it
 * includes. The retained snapshot is returned as stored, still to be verified; nothing private to execution (saved
 * checkpoint bindings, task digests, arguments, results) is included.
 */
export interface CapabilityRecord {
  throughSeq: string;
  binding?: { input: unknown; snapshotDigest: string; maxDelegations: number; payload: unknown };
  delegates: { delegationId: string; agentId: string; state: DelegateState }[];
  operations: { actorKey: string; binding: ToolBinding | undefined; disposition: ToolDisposition }[];
  loadedSkills: { actorKey: string; skillId: string; agentId: string | null }[];
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
  /**
   * A command run's normalized submission and the definitions it retains. Its rendered goal is `goal`; the creation
   * identity is the submission, not the rendering.
   */
  capability?: { input: CommandRunInput; snapshot: CapabilitySnapshot };
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

/**
 * A tool call's recorded identity (see execution/operations.ts). Without an actor it is a version-1 (root,
 * phase-1) identity; with one it is version 2, scoped to that actor, and may record what the call was bound to.
 */
export interface ToolOperationIdentity {
  operationId: string;
  modelMessageId: string;
  providerToolCallId: string;
  toolName: string;
  arguments: Record<string, unknown>;
  argumentDigest: string;
  actor?: ActorRef;
  binding?: ToolBinding;
}

export type ToolOperationStart =
  | { kind: 'execute' }
  | { kind: 'reuse'; outcome: RecordedToolOutcome }
  | { kind: 'not_dispatchable' }
  /** An external call's dispatch intent was recorded but its outcome never was: its effect is unknown. */
  | { kind: 'unresolved' };

/** The result of admitting an external call's dispatch under the run's dispatch gate. */
export type ExternalAdmission = 'admitted' | 'not_dispatchable' | 'unresolved';

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
export type RecordedToolOutcome = Record<string, unknown> & { outcome: 'ok' | 'refused' | 'error' | 'uncertain' };

/**
 * Identity of a creation request: the submitted content only, never server defaults applied afterwards. A goal's
 * identity is unchanged from phase 1; a command's covers the normalized submission (command, selection revision,
 * raw arguments and provider), never a rendering against whatever is installed now.
 */
export function creationInputDigest(
  input: Pick<CreateRunInput, 'goal' | 'provider'> | GoalRunInput | CommandRunInput,
): string {
  if ('kind' in input && input.kind === 'command') return digestOf(commandRunInputSchema.parse(input));
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
    const capability = input.capability === undefined ? undefined : this.#commandBinding(input);
    const inputDigest = creationInputDigest(capability?.input ?? input);
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
        // The run's root actor is created with the run by the database.
        if (capability !== undefined) {
          await tx`insert into runtime.capability_snapshots (digest, payload)
            values (${capability.digest}, ${capability.canonical}::text::jsonb) on conflict (digest) do nothing`;
          await tx`insert into runtime.run_capabilities (run_id, input, snapshot_digest, max_delegations)
            values (${runId}, ${jsonText(capability.input)}::text::jsonb, ${capability.digest},
              ${capability.maxDelegations})`;
        }
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
          ...(capability === undefined
            ? []
            : [
                {
                  event: {
                    kind: 'run.command' as const,
                    payload: {
                      commandId: capability.input.commandId,
                      selectionRevision: capability.input.selectionRevision,
                      arguments: capability.input.arguments,
                      snapshotDigest: capability.digest,
                    },
                  },
                  sourceKey: 'command',
                },
              ]),
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

  /**
   * A command run's binding, checked before anything is written: the submission is normalized, the snapshot is
   * sealed to its content address, and both must describe the same command, arguments, provider and goal.
   */
  #commandBinding(input: CreateRunInput) {
    const submitted = commandRunInputSchema.parse(input.capability?.input);
    const sealed = sealSnapshot(input.capability?.snapshot);
    if (
      submitted.provider !== input.provider ||
      sealed.payload.command.id !== submitted.commandId ||
      sealed.payload.input.arguments !== submitted.arguments ||
      sealed.payload.input.renderedGoal !== input.goal
    ) {
      throw new RangeError('the capability snapshot does not describe this command submission');
    }
    return {
      input: submitted,
      digest: sealed.digest,
      canonical: sealed.canonical,
      maxDelegations: sealed.payload.limits.maxDelegations,
    };
  }

  /** A command run's retained binding, or undefined for a native goal run. The snapshot is revalidated on read. */
  async readCapabilities(runId: string): Promise<RunCapabilities | undefined> {
    const [row] = await this.db.readOnly(
      (tx) => tx`
      select c.input::text as input, c.snapshot_digest, c.max_delegations, s.payload::text as payload
      from runtime.run_capabilities c join runtime.capability_snapshots s on s.digest = c.snapshot_digest
      where c.run_id = ${runId}`,
    );
    if (row === undefined) return undefined;
    return {
      input: commandRunInputSchema.parse(parseJsonText(row.input)),
      snapshotDigest: row.snapshot_digest,
      maxDelegations: Number(row.max_delegations),
      snapshot: openSnapshot(row.snapshot_digest, parseJsonText(row.payload)),
    };
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
    const actorKey = identity.actor === undefined ? 'root' : actorKeyOf(identity.actor);
    const version = identity.actor === undefined ? 1 : 2;
    if (
      version === 2 &&
      identity.operationId !== operationIdV2(runId, actorKey, identity.modelMessageId, identity.providerToolCallId)
    ) {
      throw new RangeError('the operation identity does not match its actor-scoped binding');
    }
    return withOwnerFence(this.db, this.owner, async (tx) => {
      const run = await this.#lockRun(tx, runId);
      if (run.state.kind !== 'working' || run.state.invocationId !== invocationId) return { kind: 'not_dispatchable' };
      const [existing] = await tx`
        select operation_id, tool_name, argument_digest, tool_binding::text as tool_binding,
          disposition::text as disposition
        from runtime.tool_operations
        where run_id = ${runId} and actor_key = ${actorKey} and provider_tool_call_id = ${identity.providerToolCallId}`;
      if (existing !== undefined) {
        // Replay is decided by the exact recorded binding, before anything about current permission: a matching
        // completed call is answered from its record, and any difference is an invalid call, never a cache hit.
        const recordedBinding = existing.tool_binding === null ? undefined : parseJsonText(existing.tool_binding);
        if (
          existing.operation_id !== identity.operationId ||
          existing.tool_name !== identity.toolName ||
          existing.argument_digest !== identity.argumentDigest ||
          canonicalJson(recordedBinding ?? null) !== canonicalJson(identity.binding ?? null)
        ) {
          throw new RunStoreError('tool_call_conflict', 'a provider tool-call ID was reused with a different binding');
        }
        const disposition = toolDispositionSchema.parse(parseJsonText(existing.disposition));
        if (disposition.kind === 'completed') {
          return { kind: 'reuse', outcome: disposition.result as RecordedToolOutcome };
        }
        if (disposition.kind === 'dispatching') return { kind: 'unresolved' };
        return disposition.kind === 'abandoned' ? { kind: 'not_dispatchable' } : { kind: 'execute' };
      }
      if (actorKey !== 'root') {
        const [actor] = await tx`select state ->> 'kind' as kind from runtime.run_actors
          where run_id = ${runId} and actor_key = ${actorKey}`;
        if (actor?.kind !== 'active') return { kind: 'not_dispatchable' };
      }
      await tx`insert into runtime.tool_operations (run_id, operation_id, model_message_id, provider_tool_call_id,
          tool_name, arguments, argument_digest, disposition, identity_version, actor_key, tool_binding)
        values (${runId}, ${identity.operationId}, ${identity.modelMessageId}, ${identity.providerToolCallId},
          ${identity.toolName}, ${jsonText(identity.arguments)}::text::jsonb, ${identity.argumentDigest},
          ${jsonText({ kind: 'started' })}::text::jsonb, ${version}, ${actorKey},
          ${identity.binding === undefined ? null : jsonText(identity.binding)}::text::jsonb)`;
      await this.#append(tx, runId, [
        {
          event: {
            kind: 'tool.operation',
            payload: {
              operationId: identity.operationId,
              toolName: identity.toolName,
              disposition: { kind: 'started' },
              ...(await this.#attribution(tx, runId, actorKey)),
              ...(identity.binding === undefined ? {} : { binding: identity.binding }),
            },
          },
          sourceKey: `tool:${identity.operationId}:started`,
        },
      ]);
      return { kind: 'execute' };
    });
  }

  /**
   * Records an external call's dispatch intent (design Decision 8): the started MCP operation becomes `dispatching`,
   * only while the run is still working under `invocationId` and its actor is active. The caller sends the request
   * after this commits and before it releases the run's dispatch gate, so accepted cancellation can never fall
   * between them. An intent already recorded is `unresolved`: it is never a licence to send again.
   */
  async admitExternalCall(runId: string, invocationId: string, operationId: string): Promise<ExternalAdmission> {
    return withOwnerFence(this.db, this.owner, async (tx) => {
      const run = await this.#lockRun(tx, runId);
      if (run.state.kind !== 'working' || run.state.invocationId !== invocationId) return 'not_dispatchable';
      const [row] = await tx`
        select tool_name, actor_key, tool_binding::text as tool_binding, disposition::text as disposition
        from runtime.tool_operations where run_id = ${runId} and operation_id = ${operationId} for update`;
      if (row === undefined) throw new RunStoreError('invariant_violation', 'the tool operation was never started');
      const binding = row.tool_binding === null ? undefined : (parseJsonText(row.tool_binding) as ToolBinding);
      if (binding?.kind !== 'mcp')
        throw new RunStoreError('invariant_violation', 'only an external call is dispatched');
      const current = toolDispositionSchema.parse(parseJsonText(row.disposition));
      if (current.kind === 'dispatching') return 'unresolved';
      if (current.kind !== 'started') {
        throw new RunStoreError('invariant_violation', 'the external operation is not awaiting dispatch');
      }
      if (row.actor_key !== 'root') {
        const [actor] = await tx`select state ->> 'kind' as kind from runtime.run_actors
          where run_id = ${runId} and actor_key = ${row.actor_key}`;
        if (actor?.kind !== 'active') return 'not_dispatchable';
      }
      const disposition = toolDispositionSchema.parse({ kind: 'dispatching' });
      await tx`update runtime.tool_operations set disposition = ${jsonText(disposition)}::text::jsonb
        where run_id = ${runId} and operation_id = ${operationId}`;
      await this.#append(tx, runId, [
        {
          event: {
            kind: 'tool.operation',
            payload: {
              operationId,
              toolName: row.tool_name,
              disposition,
              ...(await this.#attribution(tx, runId, row.actor_key)),
              binding,
            },
          },
          sourceKey: `tool:${operationId}:dispatching`,
        },
      ]);
      return 'admitted';
    });
  }

  /** A tool operation's recorded disposition, for readback after an uncertain commit; undefined if never started. */
  async readToolDisposition(runId: string, operationId: string): Promise<ToolDisposition | undefined> {
    const [row] = await this.db.readOnly(
      (tx) => tx`select disposition::text as disposition from runtime.tool_operations
        where run_id = ${runId} and operation_id = ${operationId}`,
    );
    return row === undefined ? undefined : toolDispositionSchema.parse(parseJsonText(row.disposition));
  }

  /**
   * The actor to name on an agent event: always in a command run, so its root and delegate activity are
   * distinguishable; never in a native run, whose history keeps its phase-1 shape and is the root's throughout.
   */
  async #attribution(tx: TransactionSQL, runId: string, actorKey: string): Promise<{ actor?: ActorRef }> {
    const [row] = await tx`
      select a.kind, a.agent_id, exists (select 1 from runtime.run_capabilities c where c.run_id = a.run_id) as command
      from runtime.run_actors a where a.run_id = ${runId} and a.actor_key = ${actorKey}`;
    if (row === undefined) throw new RunStoreError('invariant_violation', 'no such actor');
    if (row.kind === 'delegate') return { actor: { kind: 'delegate', delegationId: actorKey, agentId: row.agent_id } };
    return row.command === true ? { actor: { kind: 'root' } } : {};
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
        select disposition::text as disposition, actor_key, tool_binding::text as tool_binding
        from runtime.tool_operations
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
        // A successful skill load and the actor's membership become visible together. The bound definition comes
        // from the run's retained snapshot, never from the tool's output; a repeated load keeps the first record.
        const loaded = row.tool_binding === null ? undefined : (parseJsonText(row.tool_binding) as ToolBinding);
        if (loaded?.kind === 'skill_load' && outcome.outcome === 'ok') {
          const [retained] = await tx`
            select c.snapshot_digest, s.payload::text as payload from runtime.run_capabilities c
            join runtime.capability_snapshots s on s.digest = c.snapshot_digest where c.run_id = ${runId}`;
          if (retained === undefined) throw new RunStoreError('invariant_violation', 'only a command run loads skills');
          const skill = openSnapshot(retained.snapshot_digest, parseJsonText(retained.payload)).skills.find(
            (candidate) => candidate.id === loaded.skillId,
          );
          if (skill === undefined) throw new RunStoreError('invariant_violation', 'the loaded skill is not retained');
          await tx`insert into runtime.loaded_skills (run_id, actor_key, skill_id, operation_id, definition_digest)
            values (${runId}, ${row.actor_key}, ${loaded.skillId}, ${identity.operationId}, ${digestOf(skill)})
            on conflict (run_id, actor_key, skill_id) do nothing`;
        }
      }
      await this.#append(tx, runId, [
        {
          event: {
            kind: 'tool.operation',
            payload: {
              operationId: identity.operationId,
              toolName: identity.toolName,
              disposition,
              ...(await this.#attribution(tx, runId, row.actor_key)),
              ...(row.tool_binding === null ? {} : { binding: parseJsonText(row.tool_binding) as ToolBinding }),
            },
          },
          sourceKey: `tool:${identity.operationId}:completed`,
        },
      ]);
    });
  }

  /**
   * Begins (or, on parent-tool re-entry, finds) a delegation (design Decision 8), atomically: the root's started
   * delegation operation, the active delegate it identifies, consumption of one delegation within the run's captured
   * limit and the start event. Re-entry finds the same delegate and consumes nothing; a delegate whose recorded
   * identity differs is an invariant failure. Only the run's current working invocation may begin one.
   */
  async beginDelegation(input: {
    runId: string;
    invocationId: string;
    delegationId: string;
    agentId: string;
    task: string;
    checkpointNs: string;
  }): Promise<{ kind: 'active' } | { kind: 'limit_reached' } | { kind: 'not_dispatchable' }> {
    const taskDigest = digestOf(input.task);
    return withOwnerFence(this.db, this.owner, async (tx) => {
      const run = await this.#lockRun(tx, input.runId);
      if (run.state.kind !== 'working' || run.state.invocationId !== input.invocationId) {
        return { kind: 'not_dispatchable' };
      }
      const [operation] = await tx`
        select actor_key, tool_binding::text as tool_binding, disposition ->> 'kind' as disposition
        from runtime.tool_operations where run_id = ${input.runId} and operation_id = ${input.delegationId}`;
      if (
        operation === undefined ||
        operation.actor_key !== 'root' ||
        operation.disposition !== 'started' ||
        canonicalJson(parseJsonText(operation.tool_binding ?? 'null')) !==
          canonicalJson({ kind: 'delegation', agentId: input.agentId })
      ) {
        throw new RunStoreError('invariant_violation', 'the delegation operation is not a started root delegation');
      }
      const [existing] = await tx`
        select agent_id, task_digest, checkpoint_ns, state ->> 'kind' as state from runtime.run_actors
        where run_id = ${input.runId} and actor_key = ${input.delegationId}`;
      if (existing !== undefined) {
        if (
          existing.agent_id !== input.agentId ||
          existing.task_digest !== taskDigest ||
          existing.checkpoint_ns !== input.checkpointNs
        ) {
          throw new RunStoreError('invariant_violation', 'the delegation was re-entered with a different identity');
        }
        return existing.state === 'active' ? { kind: 'active' } : { kind: 'not_dispatchable' };
      }
      const [limits] = await tx`
        select c.max_delegations,
          (select count(*)::int from runtime.run_actors a where a.run_id = c.run_id and a.kind = 'delegate') as used
        from runtime.run_capabilities c where c.run_id = ${input.runId}`;
      if (limits === undefined) throw new RunStoreError('invariant_violation', 'only a command run can delegate');
      if (Number(limits.used) >= Number(limits.max_delegations)) return { kind: 'limit_reached' };
      await tx`insert into runtime.run_actors (run_id, actor_key, kind, parent_actor, agent_id, task_digest,
          checkpoint_ns, state)
        values (${input.runId}, ${input.delegationId}, 'delegate', 'root', ${input.agentId}, ${taskDigest},
          ${input.checkpointNs}, ${jsonText({ kind: 'active' })}::text::jsonb)`;
      await this.#append(tx, input.runId, [
        {
          event: {
            kind: 'delegation.started',
            payload: {
              delegationId: input.delegationId,
              agentId: input.agentId,
              parentActor: { kind: 'root' },
              task: input.task,
            },
          },
          sourceKey: `delegation:${input.delegationId}:started`,
        },
      ]);
      return { kind: 'active' };
    });
  }

  /**
   * Completes a delegation atomically, before its caller can see the result: the delegate's outcome, its end event
   * and the parent delegation operation's recorded outcome. Only the current working invocation may complete it, so
   * a result arriving after cancellation was accepted changes nothing. Recording the same completion again is
   * idempotent.
   */
  async completeDelegation(input: {
    runId: string;
    invocationId: string;
    delegationId: string;
    toolName: string;
    outcome: DelegateOutcome;
    toolOutcome: RecordedToolOutcome;
  }): Promise<void> {
    const outcome = delegateOutcomeSchema.parse(input.outcome);
    const state = { kind: 'completed' as const, outcome };
    const disposition = toolDispositionSchema.parse({
      kind: 'completed',
      outcome: input.toolOutcome.outcome,
      result: input.toolOutcome,
    });
    await withOwnerFence(this.db, this.owner, async (tx) => {
      const run = await this.#lockRun(tx, input.runId);
      if (run.state.kind !== 'working' || run.state.invocationId !== input.invocationId) {
        throw new RunStoreError('not_dispatchable', 'the run no longer permits this delegation to complete');
      }
      const [actor] = await tx`select state::text as state from runtime.run_actors
        where run_id = ${input.runId} and actor_key = ${input.delegationId} and kind = 'delegate'`;
      if (actor === undefined) throw new RunStoreError('invariant_violation', 'no such delegation');
      const current = parseJsonText(actor.state) as { kind: string };
      if (current.kind === 'completed') {
        if (canonicalJson(current) !== canonicalJson(state)) {
          throw new RunStoreError('invariant_violation', 'the delegation already has a different outcome');
        }
        return;
      }
      if (current.kind !== 'active') throw new RunStoreError('not_dispatchable', 'the delegate is not running');
      await tx`update runtime.run_actors set state = ${jsonText(state)}::text::jsonb
        where run_id = ${input.runId} and actor_key = ${input.delegationId}`;
      const updated = await tx`update runtime.tool_operations set disposition = ${jsonText(disposition)}::text::jsonb
        where run_id = ${input.runId} and operation_id = ${input.delegationId} and disposition ->> 'kind' = 'started'
        returning tool_binding::text as tool_binding`;
      if (updated.length !== 1)
        throw new RunStoreError('invariant_violation', 'the delegation operation is not started');
      await this.#append(tx, input.runId, [
        {
          event: {
            kind: 'delegation.finished',
            payload: { delegationId: input.delegationId, outcome: outcome.kind, operationId: input.delegationId },
          },
          sourceKey: `delegation:${input.delegationId}:finished`,
        },
        {
          event: {
            kind: 'tool.operation',
            payload: {
              operationId: input.delegationId,
              toolName: input.toolName,
              disposition,
              ...(await this.#attribution(tx, input.runId, 'root')),
              binding: parseJsonText(updated[0].tool_binding) as ToolBinding,
            },
          },
          sourceKey: `tool:${input.delegationId}:completed`,
        },
      ]);
    });
  }

  /** A run's delegate, as recorded; undefined when there is none with that delegation ID. */
  async readDelegate(
    runId: string,
    delegationId: string,
  ): Promise<{ agentId: string; checkpointNs: string; taskDigest: string; state: DelegateState } | undefined> {
    const [row] = await this.db.readOnly(
      (tx) => tx`
      select agent_id, checkpoint_ns, task_digest, state::text as state from runtime.run_actors
      where run_id = ${runId} and actor_key = ${delegationId} and kind = 'delegate'`,
    );
    if (row === undefined) return undefined;
    return {
      agentId: row.agent_id,
      checkpointNs: row.checkpoint_ns,
      taskDigest: row.task_digest,
      state: delegateStateSchema.parse(parseJsonText(row.state)),
    };
  }

  /** An actor's loaded-skill membership, in skill order. */
  async readLoadedSkills(runId: string, actorKey: string): Promise<LoadedSkill[]> {
    const rows = await this.db.readOnly(
      (tx) => tx`
      select actor_key, skill_id, operation_id, definition_digest from runtime.loaded_skills
      where run_id = ${runId} and actor_key = ${actorKey} order by skill_id`,
    );
    return (rows as { actor_key: string; skill_id: string; operation_id: string; definition_digest: string }[]).map(
      (row) =>
        loadedSkillSchema.parse({
          actorKey: row.actor_key,
          skillId: row.skill_id,
          operationId: row.operation_id,
          definitionDigest: row.definition_digest,
        }),
    );
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
    const actorKey = questionActorKey(binding);
    let attribution: { actor?: ActorRef } = {};
    const { revision } = await this.transition({
      runId: input.runId,
      expectedRevision: input.expectedRevision,
      next: { kind: 'waiting', questionId: input.questionId, bindingDigest },
      apply: async (tx) => {
        attribution = await this.#attribution(tx, input.runId, actorKey);
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
        if (actorKey !== 'root') {
          // The delegate waits on its own question; its parent delegation stays started, never paused.
          const waiting = await tx`update runtime.run_actors
            set state = ${jsonText({ kind: 'waiting', questionId: input.questionId })}::text::jsonb
            where run_id = ${input.runId} and actor_key = ${actorKey} and state_kind = 'active'
            returning actor_key`;
          const [parent] = await tx`select disposition ->> 'kind' as kind from runtime.tool_operations
            where run_id = ${input.runId} and operation_id = ${actorKey}`;
          if (waiting.length !== 1 || parent?.kind !== 'started') {
            throw new RunStoreError('invariant_violation', 'the asking delegate is not running under its delegation');
          }
        }
        await tx`insert into runtime.questions (run_id, question_id, operation_id, prompt, input, binding,
            payload_digest, binding_digest, disposition, actor_key)
          values (${input.runId}, ${input.questionId}, ${input.questionId}, ${input.prompt},
            ${jsonText(input.input)}::text::jsonb, ${jsonText(binding)}::text::jsonb, ${binding.payloadDigest},
            ${bindingDigest}, ${jsonText({ kind: 'pending' })}::text::jsonb, ${actorKey})`;
        const settled = await tx`update runtime.invocations set disposition = 'settled', ended_at = now()
          where run_id = ${input.runId} and invocation_id = ${input.invocationId} and disposition = 'active'
          returning invocation_id`;
        if (settled.length !== 1) throw new RunStoreError('invariant_violation', 'the invocation is not active');
      },
      events: () => [
        {
          event: {
            kind: 'tool.operation',
            payload: {
              operationId: input.questionId,
              toolName: 'mcp_AskUser',
              disposition: { kind: 'paused', questionId: input.questionId },
              ...attribution,
            },
          },
          sourceKey: `tool:${input.questionId}:paused`,
        },
        {
          event: {
            kind: 'question.asked',
            payload: { questionId: input.questionId, prompt: input.prompt, input: input.input, ...attribution },
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
        // A delegate that asked runs again; only the answer invocation can continue it.
        await tx`update runtime.run_actors set state = ${jsonText({ kind: 'active' })}::text::jsonb
          where run_id = ${input.runId} and state_kind = 'waiting' and state ->> 'questionId' = ${input.questionId}`;
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
        // A delegate waiting on the closed question cannot continue either.
        await this.#settleActors(tx, input.runId, input.failure.reason);
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
  async reserveAttempt(
    runId: string,
    invocationId: string,
    actor: ActorRef = { kind: 'root' },
  ): Promise<{ attemptId: string; ordinal: number }> {
    const attemptId = crypto.randomUUID();
    const actorKey = actorKeyOf(actor);
    return withOwnerFence(this.db, this.owner, async (tx) => {
      const run = await this.#lockRun(tx, runId);
      if (run.state.kind !== 'working' || run.state.invocationId !== invocationId) {
        throw new RunStoreError('not_dispatchable', 'the run does not permit another model request');
      }
      if (actorKey !== 'root') {
        // A delegate draws on the same run-wide budget, and only while it is running.
        const [row] = await tx`select state ->> 'kind' as kind from runtime.run_actors
          where run_id = ${runId} and actor_key = ${actorKey}`;
        if (row?.kind !== 'active') {
          throw new RunStoreError('not_dispatchable', 'the delegate does not permit another model request');
        }
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
          profile_id, state, actor_key)
        values (${runId}, ${attemptId}, ${invocationId}, ${ordinal}, ${binding.provider}, ${binding.model},
          ${binding.profileId}, ${jsonText(state)}::text::jsonb, ${actorKey})`;
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
    const [attempt] = await tx`select actor_key from runtime.model_attempts
      where run_id = ${runId} and attempt_id = ${attemptId}`;
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
            ...(await this.#attribution(tx, runId, attempt.actor_key)),
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
              // Nothing is running, so a delegate waiting on that question is abandoned with it.
              await this.#settleActors(tx, runId, 'cancelled');
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
            await this.#settleActors(tx, runId, 'cancelled');
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
    const reason = invocationDisposition === 'interrupted' ? 'interrupted' : 'unfinished';
    await this.#settleActors(tx, runId, reason);
    await tx`update runtime.tool_operations
      set disposition = ${jsonText({ kind: 'abandoned', reason })}::text::jsonb
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

  /**
   * Settles a run's capability records when its local work ends without a result for them, before unfinished
   * operations are abandoned: an external call whose dispatch intent was recorded becomes uncertain (it may or may
   * not have taken effect, and is never retried), and a delegate still running or waiting is abandoned. Completed
   * outcomes are untouched. Each change is recorded in history.
   */
  async #settleActors(tx: TransactionSQL, runId: string, reason: string) {
    const intents = await tx`
      select operation_id, tool_name, actor_key, tool_binding::text as tool_binding from runtime.tool_operations
      where run_id = ${runId} and disposition ->> 'kind' = 'dispatching' order by created_at, operation_id`;
    for (const row of intents as {
      operation_id: string;
      tool_name: string;
      actor_key: string;
      tool_binding: string;
    }[]) {
      const disposition = {
        kind: 'completed' as const,
        outcome: 'uncertain' as const,
        result: {
          outcome: 'uncertain',
          code: 'mcp_outcome_unknown',
          message: 'Whether this external operation took effect cannot be established. It was not retried.',
        },
      };
      await tx`update runtime.tool_operations set disposition = ${jsonText(disposition)}::text::jsonb
        where run_id = ${runId} and operation_id = ${row.operation_id}`;
      await this.#append(tx, runId, [
        {
          event: {
            kind: 'tool.operation',
            payload: {
              operationId: row.operation_id,
              toolName: row.tool_name,
              disposition,
              ...(await this.#attribution(tx, runId, row.actor_key)),
              binding: parseJsonText(row.tool_binding) as ToolBinding,
            },
          },
          sourceKey: `tool:${row.operation_id}:completed`,
        },
      ]);
    }
    const delegates = await tx`
      update runtime.run_actors set state = ${jsonText({ kind: 'abandoned', reason })}::text::jsonb
      where run_id = ${runId} and state_kind in ('active', 'waiting')
      returning actor_key`;
    const abandoned = (delegates as { actor_key: string }[]).map((row) => row.actor_key).sort();
    for (const delegationId of abandoned) {
      await this.#append(tx, runId, [
        {
          event: {
            kind: 'delegation.finished',
            payload: { delegationId, outcome: 'abandoned', operationId: delegationId },
          },
          sourceKey: `delegation:${delegationId}:finished`,
        },
      ]);
    }
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

  /** A run's retained capabilities and recorded use, in one consistent view (see CapabilityRecord). */
  async readCapabilityRecord(runId: string): Promise<CapabilityRecord> {
    return this.db.readOnly(async (tx) => {
      const [run] = await tx`select last_seq::text as last_seq from runtime.runs where run_id = ${runId}`;
      if (run === undefined) throw new RunStoreError('run_not_found', 'no such run');
      const [binding] = await tx`
        select c.input::text as input, c.snapshot_digest, c.max_delegations, s.payload::text as payload
        from runtime.run_capabilities c join runtime.capability_snapshots s on s.digest = c.snapshot_digest
        where c.run_id = ${runId}`;
      const delegates = await tx`
        select actor_key, agent_id, state::text as state from runtime.run_actors
        where run_id = ${runId} and kind = 'delegate' order by created_at, actor_key`;
      const operations = await tx`
        select actor_key, tool_binding::text as tool_binding, disposition::text as disposition
        from runtime.tool_operations where run_id = ${runId} order by created_at, operation_id`;
      const loaded = await tx`
        select l.actor_key, l.skill_id, a.agent_id from runtime.loaded_skills l
        join runtime.run_actors a on a.run_id = l.run_id and a.actor_key = l.actor_key
        where l.run_id = ${runId} order by l.actor_key, l.skill_id`;
      return {
        throughSeq: run.last_seq,
        ...(binding === undefined
          ? {}
          : {
              binding: {
                input: parseJsonText(binding.input),
                snapshotDigest: binding.snapshot_digest,
                maxDelegations: Number(binding.max_delegations),
                payload: parseJsonText(binding.payload),
              },
            }),
        delegates: (delegates as { actor_key: string; agent_id: string; state: string }[]).map((row) => ({
          delegationId: row.actor_key,
          agentId: row.agent_id,
          state: delegateStateSchema.parse(parseJsonText(row.state)),
        })),
        operations: (operations as { actor_key: string; tool_binding: string | null; disposition: string }[]).map(
          (row) => ({
            actorKey: row.actor_key,
            binding: row.tool_binding === null ? undefined : (parseJsonText(row.tool_binding) as ToolBinding),
            disposition: toolDispositionSchema.parse(parseJsonText(row.disposition)),
          }),
        ),
        loadedSkills: (loaded as { actor_key: string; skill_id: string; agent_id: string | null }[]).map((row) => ({
          actorKey: row.actor_key,
          skillId: row.skill_id,
          agentId: row.agent_id,
        })),
      };
    }, 'repeatable read');
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
        select q.question_id, q.prompt, q.input::text as input, q.binding ? 'version' as versioned, q.actor_key,
          a.agent_id
        from runtime.questions q join runtime.run_actors a on a.run_id = q.run_id and a.actor_key = q.actor_key
        where q.run_id = ${runId} and q.disposition_kind = 'pending'`;
      const [command] = await tx`
        select input::text as input, snapshot_digest from runtime.run_capabilities where run_id = ${runId}`;
      const commandInput =
        command === undefined ? undefined : commandRunInputSchema.parse(parseJsonText(command.input));
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
                ...(question.versioned !== true
                  ? {}
                  : {
                      asker:
                        question.actor_key === 'root'
                          ? { kind: 'root' as const }
                          : { kind: 'delegate' as const, delegationId: question.actor_key, agentId: question.agent_id },
                    }),
              },
        command:
          commandInput === undefined
            ? undefined
            : {
                commandId: commandInput.commandId,
                selectionRevision: commandInput.selectionRevision,
                arguments: commandInput.arguments,
                snapshotDigest: command.snapshot_digest,
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
