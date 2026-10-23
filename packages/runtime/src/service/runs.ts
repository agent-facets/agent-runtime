// The run service: the commands and reads behind the browser API (design Decisions 6, 8 and 13), composed from the
// controller, saver, provider assembly and workspace admission. It is independent of any HTTP connection: a run
// is dispatched here and keeps running after the request that started it — or every browser — has gone.
//
// Mutations follow the design's precedence. A repeated start or an answer already accepted is acknowledged before
// any fresh prerequisite is checked, so a lost acknowledgement can always be retried. Only the request that
// actually created a run, or accepted an answer, dispatches work, and only after its commit is certain. Owner
// input is screened for credentials before it is stored or reaches a model; it is refused, never rewritten.
import {
  type Acceptance,
  type AnswerAccepted,
  type CancellationAccepted,
  type ErrorCode,
  type ErrorEnvelope,
  EVENT_PAGE_DEFAULT,
  EVENT_PAGE_MAX,
  type EventPage,
  type Options,
  RUN_PAGE_DEFAULT,
  RUN_PAGE_MAX,
  type RunList,
  type RunSnapshot as RunSnapshotView,
  type StartRunCommand,
} from '@agent-runtime/contracts';
import type { OperatorConfig } from '../config/operator.ts';
import { type FailureReason, failureFor } from '../domain/failures.ts';
import { runAdmission } from '../execution/admission.ts';
import { createExecutionAgent, type ExecutionAgentOptions, executionAgentParams } from '../execution/agent.ts';
import { type AnswerResult, submitAnswer } from '../execution/answers.ts';
import { ActiveInvocations, CancellationNotRecorded, cancelRun } from '../execution/cancellation.ts';
import { type CodeManifest, currentCodeManifest } from '../execution/code-manifest.ts';
import { verifyContinuation } from '../execution/continuation.ts';
import { FailStop, RunController } from '../execution/controller.ts';
import { executionDefinition } from '../execution/definition.ts';
import { InFlight, trackedSaver } from '../execution/in-flight.ts';
import { InvocationExecutor, type InvocationInput } from '../execution/invocation.ts';
import { runOperationLedger } from '../execution/operations.ts';
import { AdmissionRefused, type RequestAdmission } from '../execution/terminal.ts';
import type { ResumeEnvelope } from '../execution/tools.ts';
import { PersistenceError, sqlStateOf } from '../persistence/errors.ts';
import { KeyedSerializer } from '../persistence/keyed-serializer.ts';
import type { Persistence } from '../persistence/persistence.ts';
import type { ProviderAssembly } from '../providers/assembly.ts';
import type { ProviderReadiness } from '../providers/registry.ts';
import { canonicalJson, parseSequence } from '../records/canonical.ts';
import { creationInputDigest, type RecordedQuestion, RunStore, RunStoreError } from '../records/run-store.ts';
import type { Provider, ProviderBinding } from '../records/schemas.ts';
import { type ContentPolicy, screenOwnerInput } from '../security/content-policy.ts';
import { formatDiagnostic } from '../security/diagnostics.ts';
import { admitWorkspace, type PrivateLocations, type WorkspaceAdmission } from '../workspace/admission.ts';
import type { WorkspacePolicy } from '../workspace/policy.ts';
import { decodeRunCursor, encodeRunCursor, eventView, snapshotView, summaryView } from './projection.ts';

/** A complete API outcome: the HTTP status and the contract-shaped body. */
export type ApiResult<T = unknown> = { status: 200 | 202; body: T } | { status: number; body: ErrorEnvelope };

const STATUS: Record<ErrorCode, number> = {
  invalid_request: 400,
  json_required: 400,
  request_too_large: 400,
  goal_required: 400,
  goal_too_long: 400,
  goal_not_storable: 400,
  answer_invalid: 400,
  credential_in_input: 400,
  invalid_cursor: 400,
  forbidden: 403,
  not_found: 404,
  method_not_allowed: 405,
  request_conflict: 409,
  answer_conflict: 409,
  not_answerable: 409,
  continuation_unavailable: 409,
  provider_unavailable: 409,
  workspace_unavailable: 409,
  cancellation_conflict: 409,
  run_finished: 409,
  cursor_ahead: 409,
  cannot_verify: 503,
  screening_unavailable: 503,
  storage_unavailable: 503,
  acceptance_unknown: 503,
  service_unavailable: 503,
};

export function refusal(
  code: ErrorCode,
  message: string,
  details: { acceptance?: Acceptance; retryable?: boolean; runId?: string; questionId?: string; status?: number } = {},
): { status: number; body: ErrorEnvelope } {
  const status = details.status ?? STATUS[code];
  return {
    status,
    body: {
      error: {
        code,
        message,
        ...(details.runId === undefined ? {} : { runId: details.runId }),
        ...(details.questionId === undefined ? {} : { questionId: details.questionId }),
        retryable: details.retryable ?? status === 503,
        acceptance: details.acceptance ?? 'not_accepted',
      },
    },
  };
}

const UNAVAILABLE_STORAGE = 'Run storage is unavailable right now. Nothing was changed; try again shortly.';
const ACKNOWLEDGEMENT_LOST =
  'The change may have been recorded, but its result could not be read back. Repeat the same request to see its outcome.';

const READINESS_MESSAGES: Record<Exclude<ProviderReadiness, 'ready'>, string> = {
  unconfigured: 'That provider is not configured for this runtime.',
  integration_unavailable:
    'That provider cannot be used by this runtime yet, or its configured profile is unsupported.',
  reauthorization_required:
    'The provider has no usable authorization. Authorize it with the documented `auth` login command, then try again.',
  temporarily_unavailable: 'The provider’s stored authorization cannot be read right now. Try again shortly.',
};

const ANSWER_INVALID_MESSAGES: Record<string, string> = {
  answer_missing: 'An answer is required.',
  answer_wrong_type: 'The answer has the wrong type for this question.',
  answer_too_short: 'The answer is shorter than the question allows.',
  answer_too_long: 'The answer is longer than the question allows.',
  answer_not_storable: 'The answer contains text that cannot be stored.',
  answer_not_an_option: 'The answer is not one of the offered options.',
  answer_duplicate_selection: 'An option was selected more than once.',
  answer_selection_count: 'The number of selected options is outside what the question allows.',
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DIGEST = /^[0-9a-f]{64}$/;

export interface RunServiceOptions {
  operator: OperatorConfig;
  /** Private locations the workspace must be separate from. */
  locations: PrivateLocations;
  persistence: Pick<Persistence, 'app' | 'ownership' | 'checkpoints'>;
  assembly: ProviderAssembly;
  /** Called when an outcome cannot be established: nothing more may be done under this ownership. */
  failStop: () => void;
  log?: (line: string) => void;
  /** Test seams; production uses the real store, admission and shipped manifests. */
  store?: RunStore;
  admit?: (workspace: OperatorConfig['workspace'], locations: PrivateLocations) => Promise<WorkspaceAdmission>;
  code?: (provider: Provider) => Promise<CodeManifest>;
}

interface InvocationContext {
  policy: WorkspacePolicy;
  confirmAnswer?: (envelope: ResumeEnvelope) => boolean;
}

const refuseInspection: RequestAdmission = {
  admit: async () => {
    throw new AdmissionRefused('inspection_only');
  },
};

class WiringUnavailable extends Error {
  override readonly name = 'WiringUnavailable';
}

export class RunService {
  readonly store: RunStore;
  readonly gates = new KeyedSerializer();
  readonly active = new ActiveInvocations();
  readonly #creations = new KeyedSerializer();
  readonly #controller: RunController;
  readonly #invocations = new Map<string, InvocationContext>();
  readonly #background = new Set<Promise<unknown>>();
  readonly #admit: NonNullable<RunServiceOptions['admit']>;
  readonly #code: NonNullable<RunServiceOptions['code']>;
  readonly #log: (line: string) => void;

  readonly #deps: RunServiceOptions;

  constructor(options: RunServiceOptions) {
    this.#deps = options;
    this.store =
      options.store ??
      new RunStore(options.persistence.app, options.persistence.ownership, {
        ...(options.operator.modelRequestCeiling === undefined
          ? {}
          : { modelRequestCeiling: options.operator.modelRequestCeiling }),
      });
    this.#admit = options.admit ?? admitWorkspace;
    this.#code = options.code ?? currentCodeManifest;
    this.#log = options.log ?? (() => {});
    this.#controller = new RunController({
      store: this.store,
      gates: this.gates,
      executor: new InvocationExecutor(new KeyedSerializer()),
      active: this.active,
      saver: options.persistence.checkpoints.saver,
      wire: (wiring) => {
        const context = this.#invocations.get(wiring.invocationId);
        if (context === undefined) throw new WiringUnavailable('no admitted workspace for this invocation');
        return createExecutionAgent(
          this.#agentOptions(wiring.runId, wiring.invocationId, wiring.binding, context, {
            admission: runAdmission({
              store: this.store,
              gates: this.gates,
              owner: options.persistence.ownership,
              runId: wiring.runId,
              invocationId: wiring.invocationId,
            }),
            signal: wiring.signal,
            inflight: wiring.inflight,
          }),
        );
      },
      failStop: options.failStop,
    });
  }

  /** Work this service started that has not settled (runs, cancellations); for orderly tests and shutdown. */
  async settled(): Promise<void> {
    while (this.#background.size > 0) await Promise.allSettled([...this.#background]);
  }

  // --- Reads -------------------------------------------------------------------------------------------------

  async options(): Promise<ApiResult<Options>> {
    const { operator, assembly } = this.#deps;
    let available = false;
    try {
      available = (await this.#admit(operator.workspace, this.#deps.locations)).ok;
    } catch {
      available = false;
    }
    const providers: Options['providers'] = [];
    for (const provider of ['anthropic', 'openai'] as const) {
      const settings = operator.providers[provider];
      if (settings === undefined) continue;
      providers.push({
        provider,
        authMode: settings.authMode,
        model: settings.model,
        readiness: await assembly.registry.readiness(provider),
      });
    }
    return {
      status: 200,
      body: {
        workspace: { label: operator.workspace.label, available },
        providers,
        defaultProvider: operator.defaultProvider,
        defaultBudget: operator.stepBudget,
        ...(operator.modelRequestCeiling === undefined ? {} : { modelRequestCeiling: operator.modelRequestCeiling }),
      },
    };
  }

  async listRuns(query: { limit?: string | null; cursor?: string | null }): Promise<ApiResult<RunList>> {
    const limit = parseLimit(query.limit, RUN_PAGE_DEFAULT, RUN_PAGE_MAX);
    if (limit === undefined) return refusal('invalid_request', 'The page limit must be a whole number from 1 to 100.');
    let before: { createdAt: string; runId: string } | undefined;
    if (query.cursor !== undefined && query.cursor !== null) {
      before = decodeRunCursor(query.cursor);
      if (before === undefined) return refusal('invalid_cursor', 'The listing cursor is not valid.');
    }
    try {
      const rows = await this.store.listRuns({ limit: limit + 1, ...(before === undefined ? {} : { before }) });
      const page = rows.slice(0, limit);
      const last = page.at(-1);
      return {
        status: 200,
        body: {
          runs: page.map(summaryView),
          ...(rows.length > limit && last !== undefined ? { next: encodeRunCursor(last) } : {}),
        },
      };
    } catch {
      return refusal('storage_unavailable', UNAVAILABLE_STORAGE);
    }
  }

  async detail(runId: string): Promise<ApiResult<RunSnapshotView>> {
    if (!UUID.test(runId)) return refusal('not_found', 'No such run.');
    try {
      return { status: 200, body: snapshotView(await this.store.snapshot(runId)) };
    } catch (error) {
      if (error instanceof RunStoreError && error.code === 'run_not_found') {
        return refusal('not_found', 'No such run.', { runId });
      }
      return refusal('storage_unavailable', UNAVAILABLE_STORAGE, { runId });
    }
  }

  /**
   * Committed history strictly after `after`, optionally up to a fixed `through` (the bound of an initial
   * snapshot). A cursor beyond the run's committed history is refused rather than answered with an empty page.
   */
  async events(
    runId: string,
    query: { after?: string | null; through?: string | null; limit?: string | null },
  ): Promise<ApiResult<EventPage>> {
    if (!UUID.test(runId)) return refusal('not_found', 'No such run.');
    const limit = parseLimit(query.limit, EVENT_PAGE_DEFAULT, EVENT_PAGE_MAX);
    if (limit === undefined) return refusal('invalid_request', 'The page limit must be a whole number from 1 to 1000.');
    const after = parseCursor(query.after ?? '0');
    const bounded = query.through !== undefined && query.through !== null;
    const through = bounded ? parseCursor(query.through as string) : undefined;
    if (after === undefined || (bounded && through === undefined)) {
      return refusal('invalid_cursor', 'The history cursor is not valid.', { runId });
    }
    try {
      const { throughSeq } = await this.store.snapshot(runId);
      const committed = BigInt(throughSeq);
      if (after > committed || (through !== undefined && through > committed)) {
        return refusal('cursor_ahead', 'The cursor is beyond this run’s recorded history.', { runId });
      }
      const stored = await this.store.readEvents(runId, {
        after: after.toString(),
        ...(through === undefined ? {} : { through: through.toString() }),
        limit,
      });
      return {
        status: 200,
        body: { events: stored.map(eventView), nextAfter: stored.at(-1)?.seq ?? after.toString() },
      };
    } catch (error) {
      if (error instanceof RunStoreError && error.code === 'run_not_found') {
        return refusal('not_found', 'No such run.', { runId });
      }
      return refusal('storage_unavailable', UNAVAILABLE_STORAGE, { runId });
    }
  }

  // --- Start -------------------------------------------------------------------------------------------------

  /**
   * Starts a run for a request ID, at most once. The same request ID with the same goal and provider returns the
   * original run — before any prerequisite is rechecked — and starts nothing; different content is a conflict.
   */
  createRun(command: StartRunCommand): Promise<ApiResult<RunSnapshotView>> {
    // One creation per request ID at a time in this process (the only owner): a duplicate waits and then finds the
    // run, so the run is dispatched exactly once, by the request that created it.
    return this.#creations.run(command.requestId, () => this.#createRun(command));
  }

  async #createRun(command: StartRunCommand): Promise<ApiResult<RunSnapshotView>> {
    const { operator, assembly, locations } = this.#deps;
    const inputDigest = creationInputDigest(command);
    try {
      const existing = await this.store.findCreation(command.requestId);
      if (existing !== undefined) {
        if (existing.inputDigest !== inputDigest) {
          return refusal('request_conflict', 'This request ID was already used to start a different run.');
        }
        return { status: 200, body: snapshotView(await this.store.snapshot(existing.runId)) };
      }
    } catch {
      return refusal('storage_unavailable', UNAVAILABLE_STORAGE);
    }

    const screened = await this.#screen(command.goal, []);
    if (screened !== undefined) return screened;

    const resolved = assembly.registry.resolve(command.provider);
    if (!resolved.ok) {
      const readiness = resolved.code === 'provider_unconfigured' ? 'unconfigured' : 'integration_unavailable';
      return refusal('provider_unavailable', READINESS_MESSAGES[readiness]);
    }
    const readiness = await assembly.registry.readiness(command.provider);
    if (readiness !== 'ready') {
      return refusal('provider_unavailable', READINESS_MESSAGES[readiness], {
        ...(readiness === 'temporarily_unavailable' ? { status: 503, retryable: true } : {}),
      });
    }

    let admission: WorkspaceAdmission;
    try {
      admission = await this.#admit(operator.workspace, locations);
    } catch {
      admission = { ok: false, code: 'workspace_unavailable' };
    }
    if (!admission.ok) {
      return refusal(
        'workspace_unavailable',
        'The configured workspace is absent, unreadable or not separate from private runtime state.',
      );
    }
    const policy = admission.policy;
    const binding = resolved.binding;

    let definition: Awaited<ReturnType<typeof executionDefinition>>;
    try {
      const { agent, params } = this.#inspection(crypto.randomUUID(), binding, policy);
      definition = await executionDefinition({
        code: await this.#code(binding.provider),
        agent,
        params,
        binding,
        workspacePolicyDigest: policy.digest,
      });
    } catch {
      return refusal('service_unavailable', 'The execution definition for this run could not be built.');
    }

    let outcome: Awaited<ReturnType<RunStore['withCommitCertainty']>>;
    try {
      outcome = await this.store.withCommitCertainty(
        () =>
          this.store.createRun({
            requestId: command.requestId,
            goal: command.goal,
            provider: command.provider,
            workspace: {
              id: operator.workspace.id,
              label: policy.label,
              root: policy.root,
              policyDigest: policy.digest,
            },
            binding,
            definition,
            budgetMax: operator.stepBudget,
          }),
        async () => {
          const found = await this.store.findCreation(command.requestId);
          return found === undefined
            ? undefined
            : { created: true as const, snapshot: await this.store.snapshot(found.runId) };
        },
      );
    } catch (error) {
      if (error instanceof RunStoreError && error.code === 'acceptance_unknown') {
        return refusal('acceptance_unknown', ACKNOWLEDGEMENT_LOST, { acceptance: 'unknown' });
      }
      if (error instanceof RunStoreError && error.code === 'request_conflict') {
        return refusal('request_conflict', 'This request ID was already used to start a different run.');
      }
      return refusal('storage_unavailable', UNAVAILABLE_STORAGE);
    }
    if (!outcome.committed) return refusal('storage_unavailable', UNAVAILABLE_STORAGE);

    const { created, snapshot } = outcome.value as Awaited<ReturnType<RunStore['createRun']>>;
    if (created && snapshot.state.kind === 'working') {
      this.#dispatch(snapshot.runId, snapshot.state.invocationId, { policy }, { kind: 'initial', goal: command.goal });
    }
    return { status: created ? 202 : 200, body: snapshotView(snapshot) };
  }

  // --- Answer ------------------------------------------------------------------------------------------------

  async answer(runId: string, questionId: string, submission: object): Promise<ApiResult<AnswerAccepted>> {
    if (!UUID.test(runId) || !DIGEST.test(questionId)) return refusal('not_found', 'No such run or question.');
    const { operator, assembly, locations, persistence } = this.#deps;
    let admitted: WorkspacePolicy | undefined;

    let result: AnswerResult;
    try {
      result = await submitAnswer(
        {
          store: this.store,
          gates: this.gates,
          screen: async (question, answer) => {
            const policy = await assembly.ownerInputPolicy([question.run.binding]);
            if (policy === undefined) return 'unavailable';
            return screenOwnerInput(policy, answer).ok ? 'clean' : 'credential';
          },
          verify: async (question: RecordedQuestion) => {
            try {
              // The current configuration's workspace, admitted afresh: a different policy digest than the run's
              // is a changed binding (incompatible); a workspace that cannot be admitted now is only unavailable.
              const admission = await this.#admit(operator.workspace, locations);
              if (!admission.ok) return { kind: 'unavailable' };
              admitted = admission.policy;
              const policy = admission.policy;
              return await verifyContinuation(
                {
                  reconstruct: (binding) => assembly.registry.reconstruct(binding),
                  workspacePolicyDigest: () => policy.digest,
                  agentFor: (id, binding) => this.#inspection(id, binding, policy),
                  saver: persistence.checkpoints.saver,
                  code: this.#code,
                },
                question,
              );
            } catch {
              return { kind: 'unavailable' };
            }
          },
          prerequisites: async (question) => {
            const readiness = await assembly.registry.bindingReadiness(question.run.binding);
            return readiness === 'ready' ? { ok: true } : { ok: false, code: readiness };
          },
        },
        { runId, questionId, submission },
      );
    } catch {
      return refusal('storage_unavailable', UNAVAILABLE_STORAGE, { runId, questionId });
    }

    const ids = { runId, questionId };
    switch (result.kind) {
      case 'accepted': {
        const accepted = result.acceptance;
        if (admitted === undefined) {
          // Verification always admits the workspace before acceptance; without it nothing can be dispatched.
          this.#failInvocation(runId, accepted.invocationId, 'invariant_violation');
        } else {
          const expected = canonicalJson({ questionId, answer: accepted.answer });
          this.#dispatch(
            runId,
            accepted.invocationId,
            {
              policy: admitted,
              confirmAnswer: (envelope) => canonicalJson(envelope) === expected,
            },
            { kind: 'resume', interruptId: result.resume.interruptId, envelope: result.resume.envelope },
          );
        }
        return this.#withSnapshot(runId, 202, (run) => ({
          acceptance: { questionId, answer: accepted.answer, acceptedAt: accepted.acceptedAt },
          ...run,
        }));
      }
      case 'already_accepted':
        return this.#withSnapshot(runId, 200, (run) => ({
          acceptance: { questionId, answer: result.answer, acceptedAt: result.acceptedAt },
          ...run,
        }));
      case 'not_found':
        return refusal('not_found', 'No such run or question.', ids);
      case 'answer_conflict':
        return refusal('answer_conflict', 'A different answer to this question was already accepted.', ids);
      case 'not_answerable':
        return refusal('not_answerable', 'This question is closed, or the run is no longer waiting for it.', ids);
      case 'answer_invalid':
        return refusal('answer_invalid', ANSWER_INVALID_MESSAGES[result.code] ?? 'The answer is not valid.', ids);
      case 'credential_in_input':
        return refusal('credential_in_input', 'The answer contains credential material and was not accepted.', ids);
      case 'screening_unavailable':
        return refusal('screening_unavailable', 'Answers cannot be checked for credentials right now.', ids);
      case 'continuation_unavailable':
        return refusal(
          'continuation_unavailable',
          'This run cannot be continued safely; it has been closed as failed. Start a new run.',
          ids,
        );
      case 'cannot_verify':
        return refusal('cannot_verify', 'Whether this run can continue cannot be verified right now.', ids);
      case 'prerequisite_unavailable': {
        const readiness = result.code as Exclude<ProviderReadiness, 'ready'>;
        return refusal(
          'provider_unavailable',
          READINESS_MESSAGES[readiness] ?? READINESS_MESSAGES.integration_unavailable,
          {
            ...ids,
            ...(readiness === 'temporarily_unavailable' ? { status: 503, retryable: true } : {}),
          },
        );
      }
      case 'storage_failed':
        return refusal('storage_unavailable', UNAVAILABLE_STORAGE, ids);
      case 'acceptance_unknown':
        return refusal('acceptance_unknown', ACKNOWLEDGEMENT_LOST, { ...ids, acceptance: 'unknown' });
    }
  }

  // --- Cancel ------------------------------------------------------------------------------------------------

  async cancel(runId: string, requestId: string): Promise<ApiResult<CancellationAccepted>> {
    if (!UUID.test(runId)) return refusal('not_found', 'No such run.');
    let cancellation: Awaited<ReturnType<typeof cancelRun>>;
    try {
      cancellation = await cancelRun({ store: this.store, gates: this.gates, active: this.active }, runId, requestId);
    } catch (error) {
      if (error instanceof RunStoreError && error.code === 'run_not_found') {
        return refusal('not_found', 'No such run.', { runId });
      }
      if (error instanceof RunStoreError && error.code === 'acceptance_unknown') {
        return refusal('acceptance_unknown', ACKNOWLEDGEMENT_LOST, { runId, acceptance: 'unknown' });
      }
      if (error instanceof CancellationNotRecorded)
        return refusal('storage_unavailable', UNAVAILABLE_STORAGE, { runId });
      return refusal('storage_unavailable', UNAVAILABLE_STORAGE, { runId });
    }
    const { result, settled } = cancellation;
    this.#track(
      settled.catch(() => {
        // The run stays `cancelling`; startup reconciliation records it as cancelled.
        this.#log(formatDiagnostic({ event: 'cancellation_settlement_failed', operation: 'http', runId }));
      }),
    );
    switch (result.kind) {
      case 'accepted':
      case 'repeated':
        return this.#withSnapshot(runId, result.kind === 'accepted' ? 202 : 200, (run) => ({
          cancellation: { acceptedAt: result.acceptedAt },
          ...run,
        }));
      case 'conflict':
        return refusal('cancellation_conflict', 'A different cancellation request was already accepted for this run.', {
          runId,
        });
      case 'finished':
        return refusal('run_finished', 'The run has already finished; its outcome cannot change.', { runId });
    }
  }

  // --- Internals ---------------------------------------------------------------------------------------------

  /** Refuses owner input containing credential material, or when it cannot be screened. */
  async #screen(
    text: string,
    bindings: readonly ProviderBinding[],
  ): Promise<{ status: number; body: ErrorEnvelope } | undefined> {
    let policy: ContentPolicy | undefined;
    try {
      policy = await this.#deps.assembly.ownerInputPolicy(bindings);
    } catch {
      policy = undefined;
    }
    if (policy === undefined) {
      return refusal(
        'screening_unavailable',
        'Input cannot be checked for credentials right now. Check provider authorization status.',
      );
    }
    if (!screenOwnerInput(policy, text).ok) {
      return refusal('credential_in_input', 'The goal contains credential material and was not accepted.');
    }
    return undefined;
  }

  async #withSnapshot<T>(
    runId: string,
    status: 200 | 202,
    body: (snapshot: RunSnapshotView) => T,
  ): Promise<ApiResult<T>> {
    try {
      return { status, body: body(snapshotView(await this.store.snapshot(runId))) };
    } catch {
      // The change itself is recorded; repeating the same request reports it.
      return refusal('storage_unavailable', ACKNOWLEDGEMENT_LOST, { runId, acceptance: 'unknown' });
    }
  }

  #agentOptions(
    runId: string,
    invocationId: string,
    binding: ProviderBinding,
    context: InvocationContext,
    wiring: { admission: RequestAdmission; signal: () => AbortSignal; inflight: InFlight },
  ): ExecutionAgentOptions {
    const { assembly, persistence } = this.#deps;
    const wired = assembly.wire({
      binding,
      admission: wiring.admission,
      signal: wiring.signal,
      track: (work) => wiring.inflight.track(work),
    });
    if ('unavailable' in wired) throw new WiringUnavailable(wired.unavailable);
    return {
      runId,
      model: wired.model,
      checkpointer: trackedSaver(persistence.checkpoints.saver, wiring.inflight),
      workspace: context.policy,
      contentPolicy: assembly.contentPolicy,
      ...(context.confirmAnswer === undefined ? {} : { confirmAnswer: context.confirmAnswer }),
      operations: runOperationLedger({ store: this.store, gates: this.gates, runId, invocationId }),
      track: (work: Promise<unknown>) => wiring.inflight.track(work),
      modelCallSettled: wired.modelCallSettled,
      reports: wired.reports,
    };
  }

  /** The agent a run's binding and workspace produce, for definitions and inspection only; it never dispatches. */
  #inspection(runId: string, binding: ProviderBinding, policy: WorkspacePolicy) {
    const options = this.#agentOptions(
      runId,
      crypto.randomUUID(),
      binding,
      { policy },
      { admission: refuseInspection, signal: () => AbortSignal.abort(), inflight: new InFlight() },
    );
    return { agent: createExecutionAgent(options), params: executionAgentParams(options) };
  }

  /** Runs one invocation in the background, independent of the request that caused it. */
  #dispatch(runId: string, invocationId: string, context: InvocationContext, input: InvocationInput): void {
    this.#invocations.set(invocationId, context);
    const work = this.#controller
      .run(runId, invocationId, input)
      .then(
        () => {},
        (error: unknown) => {
          if (error instanceof FailStop) return;
          const reason: FailureReason =
            error instanceof PersistenceError || sqlStateOf(error) !== undefined
              ? 'persistence_failure'
              : 'invariant_violation';
          this.#log(formatDiagnostic({ event: 'invocation_failed', operation: 'http', runId, reason }));
          this.#failInvocation(runId, invocationId, reason);
        },
      )
      .finally(() => this.#invocations.delete(invocationId));
    this.#track(work);
  }

  /** Records an invocation's failure when it could not run to an outcome; if that fails too, the service stops. */
  #failInvocation(runId: string, invocationId: string, reason: FailureReason): void {
    this.#track(
      (async () => {
        try {
          const { binding } = await this.store.snapshot(runId);
          await this.gates.run(runId, () =>
            this.store.finishInvocation({
              runId,
              invocationId,
              outcome: { kind: 'failed', failure: failureFor(reason, { provider: binding.provider }) },
            }),
          );
        } catch {
          this.#deps.failStop();
        }
      })(),
    );
  }

  #track(work: Promise<unknown>): void {
    this.#background.add(work);
    void work.finally(() => this.#background.delete(work));
  }
}

function parseLimit(value: string | null | undefined, fallback: number, max: number): number | undefined {
  if (value === undefined || value === null) return fallback;
  if (!/^[1-9][0-9]{0,3}$/.test(value)) return undefined;
  const limit = Number(value);
  return limit <= max ? limit : undefined;
}

/** A decimal cursor; undefined when malformed or out of range. */
function parseCursor(value: string): bigint | undefined {
  try {
    return parseSequence(value);
  } catch {
    return undefined;
  }
}
