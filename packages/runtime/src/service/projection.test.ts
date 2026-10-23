import { describe, expect, test } from 'bun:test';
import type { RunSnapshot, StoredEvent } from '../records/run-store.ts';
import type { RunEvent } from '../records/schemas.ts';
import { eventView, snapshotView } from './projection.ts';

const RUN = '00000000-0000-4000-8000-000000000001';
const D = 'a'.repeat(64);
const AT = '2026-10-07T12:00:00.000000Z';
const stored = (event: RunEvent, seq = '3'): StoredEvent => ({
  runId: RUN,
  seq,
  recordedAt: AT,
  sourceKey: 'k',
  event,
});
const delegate = { kind: 'delegate' as const, delegationId: D, agentId: 'agent:helper' };

describe('history projection', () => {
  test('legacy agent events project unchanged, without a fabricated actor', () => {
    const view = eventView(
      stored({
        kind: 'tool.operation',
        payload: { operationId: D, toolName: 'mcp_Read', disposition: { kind: 'started' } },
      }),
    );
    expect(view.payload).toEqual({ operationId: D, toolName: 'mcp_Read', disposition: { kind: 'started' } });
  });

  test('actor attribution and public tool bindings survive projection', () => {
    const tool = eventView(
      stored({
        kind: 'tool.operation',
        payload: {
          operationId: D,
          toolName: 'mcp_github_list_issues',
          disposition: { kind: 'dispatching' },
          actor: delegate,
          binding: { kind: 'mcp', serverId: 'github', toolName: 'list_issues', definitionDigest: D },
        },
      }),
    );
    expect(tool.payload).toMatchObject({ actor: delegate, binding: { serverId: 'github' } });
    const attempt = eventView(
      stored({
        kind: 'model.attempt',
        payload: {
          attemptId: RUN,
          ordinal: 2,
          state: { kind: 'completed', dispatchedAt: AT, completedAt: AT, outcome: 'ok', providerRequestId: 'req_1' },
          budget: { maximum: 5, consumed: 2, unconfirmed: 0 },
          actor: delegate,
        },
      }),
    );
    expect(attempt.payload).toEqual({
      attemptId: RUN,
      ordinal: 2,
      state: { kind: 'completed', dispatchedAt: AT, completedAt: AT, outcome: 'ok' },
      budget: { maximum: 5, consumed: 2, unconfirmed: 0 },
      actor: delegate,
    });
  });

  test('command and delegation events project as recorded', () => {
    for (const event of [
      {
        kind: 'run.command' as const,
        payload: { commandId: 'command:triage', selectionRevision: D, arguments: '', snapshotDigest: D },
      },
      {
        kind: 'delegation.started' as const,
        payload: { delegationId: D, agentId: 'agent:helper', parentActor: { kind: 'root' as const }, task: 'Look.' },
      },
      {
        kind: 'delegation.finished' as const,
        payload: { delegationId: D, outcome: 'result' as const, operationId: D },
      },
    ]) {
      expect(eventView(stored(event)).payload).toEqual(event.payload);
    }
  });

  test('a pending question carries its asker but no saved-state binding', () => {
    const snapshot: RunSnapshot = {
      runId: RUN,
      createRequestId: RUN,
      goal: 'Triage owner/repo-a',
      workspace: { id: 'main', label: 'Main', root: '/workspace', policyDigest: D },
      binding: {
        provider: 'anthropic',
        authMode: 'subscription',
        model: 'claude',
        profileId: 'anthropic.subscription.v1',
        credentialSlot: 'anthropic-default',
      },
      definitionDigest: D,
      budget: { maximum: 5, consumed: 0, unconfirmed: 0 },
      state: { kind: 'waiting', questionId: D, bindingDigest: D },
      revision: '3',
      createdAt: AT,
      lastActivityAt: AT,
      pendingQuestion: {
        questionId: D,
        prompt: 'Proceed?',
        input: { kind: 'text', minLength: 0, maxLength: 5 },
        asker: delegate,
      },
      command: { commandId: 'command:triage', selectionRevision: D, arguments: '', snapshotDigest: D },
      throughSeq: '9',
    };
    const view = snapshotView(snapshot);
    expect(view.run.pendingQuestion?.asker).toEqual(delegate);
    expect(JSON.stringify(view)).not.toContain('bindingDigest');
    expect(JSON.stringify(view)).not.toContain('credentialSlot');
  });
});
