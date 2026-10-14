import { describe, expect, test } from 'bun:test';
import { errorEnvelopeSchema, questionViewSchema, runEventSchema } from './api.ts';

const RUN = '00000000-0000-4000-8000-000000000001';
const D = 'a'.repeat(64);
const AT = '2026-10-07T12:00:00.000000Z';
const envelope = (kind: string, payload: unknown) => ({ runId: RUN, seq: '3', recordedAt: AT, kind, payload });
const parses = (kind: string, payload: unknown) => runEventSchema.safeParse(envelope(kind, payload)).success;

const delegate = { kind: 'delegate', delegationId: D, agentId: 'agent:helper' };
const budget = { maximum: 5, consumed: 1, unconfirmed: 0 };
const agentEvents: [string, Record<string, unknown>][] = [
  ['model.attempt', { attemptId: RUN, ordinal: 1, state: { kind: 'reserved' }, budget }],
  ['assistant.message', { messageId: 'm', text: 'x' }],
  ['tool.operation', { operationId: D, toolName: 'mcp_Read', disposition: { kind: 'started' } }],
  ['question.asked', { questionId: D, prompt: 'Proceed?', input: { kind: 'text', minLength: 0, maxLength: 9 } }],
];

describe('history events', () => {
  test('legacy agent events without an actor remain valid; new ones may name root or a delegate', () => {
    for (const [kind, payload] of agentEvents) {
      expect(parses(kind, payload)).toBe(true);
      expect(parses(kind, { ...payload, actor: { kind: 'root' } })).toBe(true);
      expect(parses(kind, { ...payload, actor: delegate })).toBe(true);
      expect(parses(kind, { ...payload, actor: { ...delegate, checkpointNs: 'tools:x' } })).toBe(false);
      expect(parses(kind, { ...payload, actor: { kind: 'delegate', agentId: 'agent:helper' } })).toBe(false);
    }
  });

  test('owner and system events cannot be attributed to an agent', () => {
    for (const [kind, payload] of [
      ['run.status', { state: { kind: 'working' } }],
      ['question.answered', { questionId: D, answer: false, acceptedAt: AT }],
      ['cancellation.accepted', { acceptedAt: AT }],
      ['run.created', { provider: 'openai', model: 'gpt', budgetMax: 5 }],
    ] as const) {
      expect(parses(kind, payload)).toBe(true);
      expect(parses(kind, { ...payload, actor: { kind: 'root' } })).toBe(false);
    }
  });

  test('command and delegation events are strict and carry no private bindings', () => {
    const command = { commandId: 'command:triage', selectionRevision: D, arguments: 'owner/repo', snapshotDigest: D };
    expect(parses('run.command', command)).toBe(true);
    expect(parses('run.command', { ...command, prompt: 'x' })).toBe(false);
    const started = { delegationId: D, agentId: 'agent:helper', parentActor: { kind: 'root' }, task: 'Look.' };
    expect(parses('delegation.started', started)).toBe(true);
    expect(parses('delegation.started', { ...started, checkpointNs: 'tools:x' })).toBe(false);
    expect(parses('delegation.finished', { delegationId: D, outcome: 'failed', operationId: D })).toBe(true);
    expect(parses('delegation.finished', { delegationId: D, outcome: 'succeeded', operationId: D })).toBe(false);
  });

  test('tool events distinguish dispatch intent and uncertainty from completion', () => {
    const tool = (disposition: unknown, binding?: unknown) =>
      parses('tool.operation', {
        operationId: D,
        toolName: 'mcp_github_list_issues',
        disposition,
        ...(binding ? { binding } : {}),
      });
    const mcp = { kind: 'mcp', serverId: 'github', toolName: 'list_issues', definitionDigest: D };
    expect(tool({ kind: 'dispatching' }, mcp)).toBe(true);
    expect(tool({ kind: 'completed', outcome: 'uncertain', result: {} }, mcp)).toBe(true);
    expect(tool({ kind: 'completed', outcome: 'delivered', result: {} }, mcp)).toBe(false);
    expect(tool({ kind: 'started' }, { ...mcp, credentialSlot: 'x' })).toBe(false);
  });
});

describe('pending questions', () => {
  const question = { questionId: D, prompt: 'Proceed?', input: { kind: 'text', minLength: 0, maxLength: 9 } };
  test('may name their asker, never its checkpoint binding', () => {
    expect(questionViewSchema.safeParse(question).success).toBe(true);
    expect(questionViewSchema.safeParse({ ...question, asker: delegate }).success).toBe(true);
    expect(questionViewSchema.safeParse({ ...question, asker: delegate, binding: { taskId: 't' } }).success).toBe(
      false,
    );
  });
});

describe('error envelope', () => {
  const error = (extra: Record<string, unknown>) => ({
    error: { code: 'capability_unavailable', message: 'x', retryable: false, acceptance: 'not_accepted', ...extra },
  });

  test('capability refusals may name the affected contribution or tool by safe public reference only', () => {
    for (const subject of ['skill:review', 'command:triage', 'mcp:repo/list_prs', 'mcp:@team/tools/repo/list_prs']) {
      expect(errorEnvelopeSchema.safeParse(error({ subject })).success).toBe(true);
    }
    for (const subject of ['review', 'mcp:', 'file:/etc/passwd x', 'slot:repo-token', `skill:${'a'.repeat(256)}`]) {
      expect(errorEnvelopeSchema.safeParse(error({ subject })).success).toBe(false);
    }
    for (const code of [
      'command_arguments_invalid',
      'capability_selection_changed',
      'capabilities_unavailable',
      'mcp_server_unavailable',
    ]) {
      expect(errorEnvelopeSchema.safeParse(error({ code })).success).toBe(true);
    }
  });
});
