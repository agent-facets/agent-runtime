import { describe, expect, test } from 'bun:test';
import { parseAnswerSubmission, parseStartRun } from './commands.ts';

const requestId = '00000000-0000-4000-8000-000000000001';

describe('start-run command', () => {
  test('accepts exactly a request ID, goal and provider, keeping the goal verbatim', () => {
    const goal = '  Inspect README.md\n';
    expect(parseStartRun({ requestId, goal, provider: 'openai' })).toEqual({
      ok: true,
      value: { requestId, goal, provider: 'openai' },
    });
  });

  test('refuses authority-bearing fields and unsupported providers', () => {
    for (const extra of [
      { workspace: '/etc' },
      { model: 'other' },
      { endpoint: 'https://x.invalid' },
      { apiKey: 'sk-x' },
      { tools: ['mcp_Write'] },
      { checkpointId: 'c' },
      { authMode: 'api_key' },
    ]) {
      expect(parseStartRun({ requestId, goal: 'g', provider: 'anthropic', ...extra })).toMatchObject({
        ok: false,
        code: 'invalid_request',
      });
    }
    for (const provider of ['anthropic-api', 'Anthropic', undefined]) {
      expect(parseStartRun({ requestId, goal: 'g', provider }).ok).toBe(false);
    }
    expect(parseStartRun({ requestId: 'not-a-uuid', goal: 'g', provider: 'anthropic' }).ok).toBe(false);
  });

  test('does not echo suspicious field names', () => {
    const result = parseStartRun({ requestId, goal: 'g', provider: 'anthropic', 'sk-ant-secret-0000': 1 });
    expect(result).toEqual({ ok: false, code: 'invalid_request', field: undefined });
  });

  test('refuses blank, oversized and unstorable goals', () => {
    for (const goal of ['', '   ', '\n\t']) {
      expect(parseStartRun({ requestId, goal, provider: 'anthropic' })).toMatchObject({ code: 'goal_required' });
    }
    expect(parseStartRun({ requestId, goal: 'a'.repeat(8192), provider: 'anthropic' }).ok).toBe(true);
    expect(parseStartRun({ requestId, goal: 'a'.repeat(8193), provider: 'anthropic' })).toMatchObject({
      code: 'goal_too_long',
    });
    expect(parseStartRun({ requestId, goal: 'é'.repeat(4097), provider: 'anthropic' })).toMatchObject({
      code: 'goal_too_long',
    });
    expect(parseStartRun({ requestId, goal: 'a\u0000', provider: 'anthropic' })).toMatchObject({
      code: 'goal_not_storable',
    });
  });
});

describe('answer submission envelope', () => {
  test('requires exactly the answer property, whose value may be false, null, zero or empty', () => {
    for (const answer of [false, null, 0, '', [], 'yes']) {
      expect(parseAnswerSubmission({ answer })).toEqual({ ok: true, value: { answer } });
    }
    for (const body of [{}, { answer: false, questionId: 'x' }, null, [], 'false', { value: false }]) {
      expect(parseAnswerSubmission(body).ok).toBe(false);
    }
  });
});
