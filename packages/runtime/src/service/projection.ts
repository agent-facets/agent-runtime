// Projections of runtime records onto the browser contracts. Each field is chosen explicitly: credential slots,
// profile and definition digests, owner epochs, invocation and cancellation identities, saved-graph bindings,
// revisions and provider request IDs stay on the server. The results are validated against the contract schemas,
// so a projection that would carry anything else fails here instead of reaching a browser.
import {
  type RunEvent as RunEventView,
  type RunSnapshot as RunSnapshotView,
  type RunState as RunStateView,
  type RunSummary as RunSummaryView,
  runEventSchema,
  runSnapshotSchema,
  runSummarySchema,
} from '@agent-runtime/contracts';
import type { RunSnapshot, RunSummary, StoredEvent } from '../records/run-store.ts';
import type { RunState } from '../records/schemas.ts';

export function stateView(state: RunState): RunStateView {
  switch (state.kind) {
    case 'working':
      return { kind: 'working' };
    case 'waiting':
      return { kind: 'waiting', questionId: state.questionId };
    case 'cancelling':
      return { kind: 'cancelling', acceptedAt: state.acceptedAt };
    case 'succeeded':
      return { kind: 'succeeded', finishedAt: state.finishedAt, resultSeq: state.resultSeq };
    case 'failed':
      return { kind: 'failed', finishedAt: state.finishedAt, failure: state.failure };
    case 'cancelled':
      return { kind: 'cancelled', finishedAt: state.finishedAt, acceptedAt: state.acceptedAt };
    case 'interrupted':
      return { kind: 'interrupted', detectedAt: state.detectedAt, lastActivityAt: state.lastActivityAt };
  }
}

export function snapshotView(snapshot: RunSnapshot): RunSnapshotView {
  return runSnapshotSchema.parse({
    run: {
      runId: snapshot.runId,
      goal: snapshot.goal,
      provider: snapshot.binding.provider,
      authMode: snapshot.binding.authMode,
      model: snapshot.binding.model,
      workspace: { label: snapshot.workspace.label, root: snapshot.workspace.root },
      state: stateView(snapshot.state),
      budget: snapshot.budget,
      createdAt: snapshot.createdAt,
      lastActivityAt: snapshot.lastActivityAt,
      ...(snapshot.pendingQuestion === undefined ? {} : { pendingQuestion: snapshot.pendingQuestion }),
    },
    throughSeq: snapshot.throughSeq,
  });
}

export function summaryView(summary: RunSummary): RunSummaryView {
  return runSummarySchema.parse({
    runId: summary.runId,
    goal: summary.goal,
    provider: summary.binding.provider,
    model: summary.binding.model,
    status: summary.status,
    createdAt: summary.createdAt,
    lastActivityAt: summary.lastActivityAt,
  });
}

function payloadView(event: StoredEvent['event']): Pick<RunEventView, 'kind' | 'payload'> {
  switch (event.kind) {
    case 'run.created': {
      const { provider, model, budgetMax } = event.payload;
      return { kind: event.kind, payload: { provider, model, budgetMax } };
    }
    case 'run.status':
      return { kind: event.kind, payload: { state: stateView(event.payload.state) } };
    case 'model.attempt': {
      const { attemptId, ordinal, state, budget } = event.payload;
      const publicState =
        state.kind === 'completed'
          ? {
              kind: state.kind,
              dispatchedAt: state.dispatchedAt,
              completedAt: state.completedAt,
              outcome: state.outcome,
            }
          : state;
      return { kind: event.kind, payload: { attemptId, ordinal, state: publicState, budget } };
    }
    case 'assistant.message':
    case 'tool.operation':
    case 'question.asked':
    case 'question.closed':
      return { kind: event.kind, payload: event.payload } as Pick<RunEventView, 'kind' | 'payload'>;
    case 'question.answered': {
      const { questionId, answer, acceptedAt } = event.payload;
      return { kind: event.kind, payload: { questionId, answer, acceptedAt } };
    }
    case 'cancellation.accepted':
      return { kind: event.kind, payload: { acceptedAt: event.payload.acceptedAt } };
  }
}

export function eventView(stored: StoredEvent): RunEventView {
  return runEventSchema.parse({
    runId: stored.runId,
    seq: stored.seq,
    recordedAt: stored.recordedAt,
    ...payloadView(stored.event),
  });
}

/** Run-list cursors: the creation time and ID of the last run on a page, opaque to clients. */
export function encodeRunCursor(last: { createdAt: string; runId: string }): string {
  return Buffer.from(`${last.createdAt}|${last.runId}`, 'utf8').toString('base64url');
}

export function decodeRunCursor(cursor: string): { createdAt: string; runId: string } | undefined {
  if (!/^[A-Za-z0-9_-]{1,256}$/.test(cursor)) return undefined;
  const [createdAt, runId, ...rest] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  if (
    rest.length > 0 ||
    createdAt === undefined ||
    runId === undefined ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(createdAt) ||
    Number.isNaN(Date.parse(createdAt)) ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(runId)
  ) {
    return undefined;
  }
  return { createdAt, runId };
}
