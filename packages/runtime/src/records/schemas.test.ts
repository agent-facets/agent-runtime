import { describe, expect, test } from 'bun:test';
import {
  eventSchema,
  failureSchema,
  operationIdFor,
  operationIdV2,
  QUESTION_TEXT_MAX_BYTES,
  questionActorKey,
  questionBindingSchema,
  questionDefinitionSchema,
  questionDispositionSchema,
  questionInputSchema,
  questionPromptSchema,
  questionTextBytes,
  runStateSchema,
  workspaceSchema,
} from './schemas.ts';

const uuid = '00000000-0000-4000-8000-000000000001';
const digest = 'a'.repeat(64);
const at = '2026-09-29T12:00:00.123456Z';
const failure = {
  category: 'provider_failure',
  reason: 'truncated_stream',
  message: 'The provider stream ended early.',
  operation: { kind: 'model_attempt', attemptId: uuid },
};

describe('run state union', () => {
  test('accepts every variant with exactly its payload', () => {
    const states = [
      { kind: 'working', invocationId: uuid, ownerEpoch: '3' },
      { kind: 'waiting', questionId: digest, bindingDigest: digest },
      { kind: 'cancelling', cancellationId: uuid, acceptedAt: at },
      { kind: 'cancelling', cancellationId: uuid, acceptedAt: at, invocationId: uuid },
      { kind: 'succeeded', finishedAt: at, resultSeq: '12' },
      { kind: 'failed', finishedAt: at, failure },
      { kind: 'cancelled', finishedAt: at, cancellationId: uuid, acceptedAt: at },
      { kind: 'interrupted', detectedAt: at, lastActivityAt: at, invocationId: uuid },
    ];
    for (const state of states) expect(runStateSchema.safeParse(state).success).toBe(true);
  });

  test('refuses mixed, incomplete, unknown and null variants', () => {
    const invalid = [
      { kind: 'waiting', questionId: digest, bindingDigest: digest, invocationId: uuid },
      { kind: 'working', invocationId: uuid },
      { kind: 'succeeded', finishedAt: at, resultSeq: '0' },
      { kind: 'succeeded', finishedAt: at, resultSeq: 12 },
      { kind: 'failed', finishedAt: at, failure: { ...failure, category: 'unknown' } },
      { kind: 'completed', finishedAt: at },
      { kind: 'working', invocationId: 'ABCDEF00-0000-4000-8000-000000000001', ownerEpoch: '1' },
      { kind: 'cancelled', finishedAt: '2026-09-29 12:00:00', cancellationId: uuid, acceptedAt: at },
      null,
    ];
    for (const state of invalid) expect(runStateSchema.safeParse(state).success).toBe(false);
  });

  test('failures refuse unknown authority-bearing fields', () => {
    expect(failureSchema.safeParse({ ...failure, stack: 'Error: …' }).success).toBe(false);
  });
});

describe('question records', () => {
  test('answered dispositions keep false, null, zero and empty text as real answers', () => {
    for (const answer of [false, null, 0, '', [false, null]]) {
      const parsed = questionDispositionSchema.parse({ kind: 'answered', answer, acceptedAt: at, invocationId: uuid });
      expect(parsed).toEqual({ kind: 'answered', answer, acceptedAt: at, invocationId: uuid });
    }
    expect(questionDispositionSchema.safeParse({ kind: 'answered', acceptedAt: at, invocationId: uuid }).success).toBe(
      false,
    );
    expect(questionDispositionSchema.safeParse({ kind: 'pending', answer: false }).success).toBe(false);
  });

  test('question inputs are one of the three bounded shapes', () => {
    const valid = [
      { kind: 'text', minLength: 0, maxLength: 8192 },
      {
        kind: 'choice',
        multiple: false,
        options: [
          { label: 'No', value: false },
          { label: 'Text false', value: 'false' },
        ],
      },
      {
        kind: 'choice',
        multiple: true,
        options: [
          { label: 'A', value: 'a' },
          { label: 'B', value: null },
        ],
        minSelections: 0,
        maxSelections: 2,
      },
    ];
    for (const input of valid) expect(questionInputSchema.safeParse(input).success).toBe(true);
    const invalid = [
      { kind: 'text', minLength: 5, maxLength: 4 },
      { kind: 'text', minLength: 0, maxLength: 9000 },
      { kind: 'choice', multiple: false, options: [] },
      {
        kind: 'choice',
        multiple: false,
        options: [
          { label: 'A', value: 1 },
          { label: 'B', value: 1 },
        ],
      },
      { kind: 'choice', multiple: false, options: [{ label: 'A', value: 1 }], maxSelections: 1 },
      { kind: 'choice', multiple: true, options: [{ label: 'A', value: 1 }], minSelections: 0, maxSelections: 2 },
      { kind: 'choice', multiple: false, options: [{ label: 'A', value: { nested: true } }] },
      { kind: 'schema', schema: {} },
    ];
    for (const input of invalid) expect(questionInputSchema.safeParse(input).success).toBe(false);
  });

  test('labels are bounded in code points, like PostgreSQL char_length', () => {
    const choice = (label: string) => ({ kind: 'choice', multiple: false, options: [{ label, value: 1 }] });
    expect(questionInputSchema.safeParse(choice('😀'.repeat(256))).success).toBe(true);
    expect(questionInputSchema.safeParse(choice('😀'.repeat(257))).success).toBe(false);
    expect(questionInputSchema.safeParse(choice('a\u0000')).success).toBe(false);
  });

  test('prompts are bounded to 16 KiB of UTF-8, and question text to 64 KiB overall', () => {
    const input = { kind: 'text', minLength: 0, maxLength: 10 };
    const asked = (prompt: string, questionInput: unknown = input) =>
      eventSchema.safeParse({ kind: 'question.asked', payload: { questionId: digest, prompt, input: questionInput } })
        .success;
    expect(questionPromptSchema.safeParse('a'.repeat(16_384)).success).toBe(true);
    expect(questionPromptSchema.safeParse('é'.repeat(8192)).success).toBe(true);
    expect(questionPromptSchema.safeParse('é'.repeat(8193)).success).toBe(false);
    expect(questionPromptSchema.safeParse('').success).toBe(false);
    expect(asked('é'.repeat(8193))).toBe(false);

    const options = Array.from({ length: 50 }, (_, index) => ({
      label: 'l'.repeat(256),
      value: `${index}`.repeat(1000),
    }));
    const large = { kind: 'choice', multiple: false, options: options.slice(0, 40) };
    expect(questionTextBytes('p', large as never)).toBeGreaterThan(QUESTION_TEXT_MAX_BYTES);
    expect(questionDefinitionSchema.safeParse({ prompt: 'p', input: large }).success).toBe(false);
    expect(asked('p', large)).toBe(false);
    const fitting = { kind: 'choice', multiple: false, options: options.slice(0, 10) };
    expect(questionDefinitionSchema.safeParse({ prompt: 'p', input: fitting }).success).toBe(true);
  });
});

describe('question bindings', () => {
  const leaf = {
    threadId: uuid,
    checkpointNs: '',
    checkpointId: 'checkpoint-1',
    taskId: 'task-1',
    interruptId: 'interrupt-1',
    operationId: digest,
    payloadDigest: digest,
    requiredStateDigest: digest,
    definitionDigest: digest,
  };
  const other = 'b'.repeat(64);
  const delegate = {
    version: 2,
    actor: 'delegate',
    delegationId: other,
    agentId: 'agent:helper',
    ...leaf,
    checkpointNs: 'tools:task-9',
    parent: { checkpointNs: '', checkpointId: 'root-checkpoint', taskId: 'root-task', operationId: other },
  };

  test('accepts the unchanged phase-1 binding and both version-2 askers', () => {
    expect(questionBindingSchema.safeParse({ ...leaf, ordinal: 0 }).success).toBe(true);
    expect(questionBindingSchema.safeParse({ version: 2, actor: 'root', ...leaf }).success).toBe(true);
    expect(questionBindingSchema.safeParse(delegate).success).toBe(true);
    expect(questionActorKey(questionBindingSchema.parse({ ...leaf, ordinal: 0 }))).toBe('root');
    expect(questionActorKey(questionBindingSchema.parse(delegate))).toBe(other);
  });

  test('refuses mixed and contradictory bindings', () => {
    for (const binding of [
      { ...leaf },
      { ...leaf, ordinal: 1 },
      { version: 2, actor: 'root', ...leaf, ordinal: 0 },
      { version: 2, actor: 'root', ...leaf, delegationId: other },
      { ...delegate, parent: { ...delegate.parent, operationId: digest } },
      { ...delegate, checkpointNs: '' },
      { ...delegate, version: 3 },
      { version: 2, actor: 'delegate', ...leaf },
    ]) {
      expect(questionBindingSchema.safeParse(binding).success).toBe(false);
    }
  });
});

describe('events and identities', () => {
  test('events are a closed union with strict payloads', () => {
    expect(
      eventSchema.safeParse({
        kind: 'question.answered',
        payload: { questionId: digest, answer: false, invocationId: uuid, acceptedAt: at },
      }).success,
    ).toBe(true);
    expect(eventSchema.safeParse({ kind: 'debug.raw', payload: {} }).success).toBe(false);
    expect(
      eventSchema.safeParse({ kind: 'assistant.message', payload: { messageId: 'm', text: 'x', raw: {} } }).success,
    ).toBe(false);
  });

  test('agent activity may carry an actor; owner and system events never do', () => {
    const root = { kind: 'root' };
    const delegate = { kind: 'delegate', delegationId: digest, agentId: 'agent:helper' };
    const budget = { maximum: 5, consumed: 0, unconfirmed: 1 };
    const attributed = [
      { kind: 'model.attempt', payload: { attemptId: uuid, ordinal: 1, state: { kind: 'reserved' }, budget } },
      { kind: 'assistant.message', payload: { messageId: 'm', text: 'x' } },
      {
        kind: 'tool.operation',
        payload: { operationId: digest, toolName: 'mcp_Read', disposition: { kind: 'started' } },
      },
      {
        kind: 'question.asked',
        payload: { questionId: digest, prompt: 'Proceed?', input: { kind: 'text', minLength: 0, maxLength: 5 } },
      },
    ];
    for (const event of attributed) {
      expect(eventSchema.safeParse(event).success).toBe(true);
      for (const actor of [root, delegate]) {
        expect(eventSchema.safeParse({ ...event, payload: { ...event.payload, actor } }).success).toBe(true);
      }
      expect(
        eventSchema.safeParse({
          ...event,
          payload: { ...event.payload, actor: { kind: 'delegate', delegationId: digest } },
        }).success,
      ).toBe(false);
      expect(
        eventSchema.safeParse({ ...event, payload: { ...event.payload, actor: { ...delegate, agentId: 'helper' } } })
          .success,
      ).toBe(false);
    }
    const system = [
      {
        kind: 'run.status',
        payload: { revision: '2', state: { kind: 'working', invocationId: uuid, ownerEpoch: '1' } },
      },
      { kind: 'question.answered', payload: { questionId: digest, answer: false, invocationId: uuid, acceptedAt: at } },
      { kind: 'question.closed', payload: { questionId: digest, reason: 'cancelled', closedAt: at } },
      { kind: 'cancellation.accepted', payload: { cancellationId: uuid, requestId: uuid, acceptedAt: at } },
    ];
    for (const event of system) {
      expect(eventSchema.safeParse(event).success).toBe(true);
      expect(eventSchema.safeParse({ ...event, payload: { ...event.payload, actor: root } }).success).toBe(false);
    }
  });

  test('tool events bind native, skill, delegation and MCP calls by public reference', () => {
    const tool = (binding: unknown, disposition: unknown = { kind: 'started' }) =>
      eventSchema.safeParse({
        kind: 'tool.operation',
        payload: { operationId: digest, toolName: 'mcp_github_list_issues', disposition, binding },
      }).success;
    for (const binding of [
      { kind: 'native', name: 'mcp_Search' },
      { kind: 'skill_load', skillId: 'skill:review' },
      { kind: 'skill_reference', skillId: 'skill:review', path: 'references/guide.md' },
      { kind: 'delegation', agentId: 'agent:helper' },
      { kind: 'mcp', serverId: 'github', toolName: 'list_issues', definitionDigest: digest },
    ]) {
      expect(tool(binding)).toBe(true);
    }
    for (const binding of [
      { kind: 'native', name: 'shell' },
      { kind: 'skill_reference', skillId: 'skill:review', path: '../secret' },
      { kind: 'delegation', agentId: 'agent:helper', namespace: 'x' },
      { kind: 'mcp', serverId: 'github', toolName: 'list_issues' },
    ]) {
      expect(tool(binding)).toBe(false);
    }
    expect(tool({ kind: 'native', name: 'mcp_Read' }, { kind: 'dispatching' })).toBe(true);
    expect(
      tool(
        { kind: 'mcp', serverId: 'github', toolName: 'x', definitionDigest: digest },
        { kind: 'completed', outcome: 'uncertain', result: { outcome: 'uncertain' } },
      ),
    ).toBe(true);
    expect(tool({ kind: 'native', name: 'mcp_Read' }, { kind: 'dispatching', at })).toBe(false);
  });

  test('command and delegation events are strict', () => {
    const valid = [
      {
        kind: 'run.command',
        payload: { commandId: 'command:triage', selectionRevision: digest, arguments: '', snapshotDigest: digest },
      },
      {
        kind: 'delegation.started',
        payload: { delegationId: digest, agentId: 'agent:helper', parentActor: { kind: 'root' }, task: 'Look.' },
      },
      { kind: 'delegation.finished', payload: { delegationId: digest, outcome: 'abandoned', operationId: digest } },
    ];
    for (const event of valid) expect(eventSchema.safeParse(event).success).toBe(true);
    for (const event of [
      { ...valid[0], payload: { ...valid[0]?.payload, goal: 'x' } },
      { ...valid[1], payload: { ...valid[1]?.payload, task: '  ' } },
      { ...valid[2], payload: { ...valid[2]?.payload, outcome: 'succeeded' } },
    ]) {
      expect(eventSchema.safeParse(event).success).toBe(false);
    }
  });

  test('workspaces require a container root and policy digest', () => {
    expect(
      workspaceSchema.safeParse({ id: 'main', label: 'Main', root: '/workspace', policyDigest: digest }).success,
    ).toBe(true);
    expect(
      workspaceSchema.safeParse({ id: 'main', label: 'Main', root: 'relative', policyDigest: digest }).success,
    ).toBe(false);
  });

  test('version-1 operation identity is unchanged', () => {
    expect(operationIdFor(uuid, 'message-1', 'call-1')).toBe(
      'ad630130b745ddd3b95ca42d92d03fecee7364d0c1bd794936559b3d16f1062a',
    );
  });

  test('version-2 identities distinguish actors and new messages but repeat for an identical replay', () => {
    const other = 'b'.repeat(64);
    const root = operationIdV2(uuid, 'root', 'message-1', 'call-1');
    expect(root).toMatch(/^[0-9a-f]{64}$/);
    expect(operationIdV2(uuid, 'root', 'message-1', 'call-1')).toBe(root);
    expect(root).not.toBe(operationIdFor(uuid, 'message-1', 'call-1'));
    expect(operationIdV2(uuid, digest, 'message-1', 'call-1')).not.toBe(root);
    expect(operationIdV2(uuid, digest, 'message-1', 'call-1')).not.toBe(
      operationIdV2(uuid, other, 'message-1', 'call-1'),
    );
    expect(operationIdV2(uuid, 'root', 'message-2', 'call-1')).not.toBe(root);
    expect(operationIdV2(uuid, 'root', 'message-1', 'call-2')).not.toBe(root);
    expect(new Bun.CryptoHasher('sha256').update(`v2\n${uuid}\nroot\nmessage-1\ncall-1`).digest('hex')).toBe(root);
    for (const [actor, message, call] of [
      ['agent:helper', 'message-1', 'call-1'],
      ['ROOT', 'message-1', 'call-1'],
      ['root', 'message\n1', 'call-1'],
      ['root', 'message-1', 'call\u00001'],
      ['root', '', 'call-1'],
      ['root', 'message-1', 'c'.repeat(257)],
    ] as const) {
      expect(() => operationIdV2(uuid, actor, message, call)).toThrow();
    }
  });

  test('operation IDs are stable per call binding and refuse control characters', () => {
    const id = operationIdFor(uuid, 'message-1', 'call-1');
    expect(id).toMatch(/^[0-9a-f]{64}$/);
    expect(operationIdFor(uuid, 'message-1', 'call-1')).toBe(id);
    expect(operationIdFor(uuid, 'message-2', 'call-1')).not.toBe(id);
    expect(() => operationIdFor(uuid, 'message\n1', 'call-1')).toThrow();
    expect(() => operationIdFor(uuid, '', 'call-1')).toThrow();
  });
});
