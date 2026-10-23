import { afterAll, describe, expect, test } from 'bun:test';
import { createFixture } from '../../test-support/workspace.ts';
import { readWorkspace } from '../workspace/read.ts';
import { searchWorkspace } from '../workspace/search.ts';
import { createContentPolicy, REDACTION } from './content-policy.ts';
import { CompleteMessageAssembler, type StreamFragment, sanitizeToolOutcome } from './pre-graph.ts';

const LIVE = 'oauth-live-synthetic-0123456789abcdefABCDEF';
const policy = createContentPolicy({ values: () => [LIVE] });

/** Splits a value into three parts such that no part, and no two adjacent parts, contain it whole. */
function threeFragments(value: string): [string, string, string] {
  const third = Math.floor(value.length / 3);
  return [value.slice(0, third), value.slice(third, 2 * third), value.slice(2 * third)];
}

function assemble(fragments: StreamFragment[]) {
  const assembler = new CompleteMessageAssembler(policy);
  for (const fragment of fragments) assembler.push(fragment);
  return assembler.finish();
}

describe('complete-message assembly', () => {
  test('a credential split across three fragments is recognized once joined, and redacted', () => {
    const [a, b, c] = threeFragments(LIVE);
    for (const pair of [a, b, c, a + b, b + c]) expect(policy.detect(pair)).toBeUndefined();
    const result = assemble([
      { kind: 'text', text: `The token is ${a}` },
      { kind: 'text', text: b },
      { kind: 'text', text: `${c}.` },
      { kind: 'terminal' },
    ]);
    expect(result).toEqual({ kind: 'message', text: `The token is ${REDACTION}.`, toolCalls: [], redacted: true });
  });

  test('nothing is released before the successful terminal event', () => {
    const assembler = new CompleteMessageAssembler(policy);
    assembler.push({ kind: 'text', text: 'partial answer' });
    assembler.push({
      kind: 'tool_call',
      index: 0,
      id: 'call_1',
      name: 'mcp_Read',
      argumentsDelta: '{"mode":"file","path":"a"}',
    });
    // Complete-looking arguments without the terminal event are not a response.
    expect(assembler.finish()).toEqual({ kind: 'rejected', reason: 'incomplete_response' });
  });

  test('assembles interleaved tool-call fragments by index', () => {
    const result = assemble([
      { kind: 'tool_call', index: 1, id: 'call_b', name: 'mcp_Search', argumentsDelta: '{"query":' },
      { kind: 'tool_call', index: 0, id: 'call_a', name: 'mcp_Read', argumentsDelta: '{"mode":"direc' },
      { kind: 'tool_call', index: 1, argumentsDelta: '"needle"}' },
      { kind: 'tool_call', index: 0, argumentsDelta: 'tory","path":"."}' },
      { kind: 'terminal' },
    ]);
    expect(result).toEqual({
      kind: 'message',
      text: '',
      redacted: false,
      toolCalls: [
        { id: 'call_a', name: 'mcp_Read', arguments: { mode: 'directory', path: '.' } },
        { id: 'call_b', name: 'mcp_Search', arguments: { query: 'needle' } },
      ],
    });
  });

  test('a credential in tool-call arguments refuses the call rather than changing it', () => {
    const [a, b, c] = threeFragments(LIVE);
    const result = assemble([
      { kind: 'tool_call', index: 0, id: 'call_1', name: 'mcp_Search', argumentsDelta: `{"query":"${a}` },
      { kind: 'tool_call', index: 0, argumentsDelta: b },
      { kind: 'tool_call', index: 0, argumentsDelta: `${c}"}` },
      { kind: 'terminal' },
    ]);
    expect(result).toEqual({ kind: 'rejected', reason: 'credential_in_tool_call' });
  });

  test('malformed and oversized responses are rejected', () => {
    expect(
      assemble([
        { kind: 'tool_call', index: 0, id: 'c', name: 'mcp_Read', argumentsDelta: '{"mode":' },
        { kind: 'terminal' },
      ]),
    ).toEqual({ kind: 'rejected', reason: 'malformed_tool_call' });
    expect(
      assemble([{ kind: 'tool_call', index: 0, name: 'mcp_Read', argumentsDelta: '{}' }, { kind: 'terminal' }]),
    ).toEqual({
      kind: 'rejected',
      reason: 'malformed_tool_call',
    });
    const small = new CompleteMessageAssembler(policy, 10);
    small.push({ kind: 'text', text: 'x'.repeat(11) });
    small.push({ kind: 'terminal' });
    expect(small.finish()).toEqual({ kind: 'rejected', reason: 'response_too_large' });
  });
});

describe('tool results', () => {
  const fixture = createFixture();
  afterAll(() => fixture.cleanup());
  const workspace = fixture.policy();

  test('seeded credentials in file text and search excerpts are redacted before the result leaves the tool', async () => {
    fixture.write('config/app.ts', `const token = "${LIVE}"; // MARKER\nconst ok = 1;\n`);
    const read = sanitizeToolOutcome(
      policy,
      await readWorkspace(workspace, { mode: 'file', path: 'config/app.ts' }, { filter: policy.redact }),
    );
    const found = sanitizeToolOutcome(
      policy,
      await searchWorkspace(workspace, { query: 'MARKER' }, { filter: policy.redact }),
    );
    for (const outcome of [read, found]) {
      expect(outcome.outcome).toBe('ok');
      expect(JSON.stringify(outcome)).not.toContain(LIVE);
      expect(JSON.stringify(outcome)).toContain(REDACTION);
    }
  });

  test('a credential outside displayable text withholds the whole result', () => {
    const outcome = sanitizeToolOutcome(policy, {
      outcome: 'ok',
      result: { mode: 'file', path: `leak/${LIVE}.txt`, lines: [] },
    });
    expect(outcome).toMatchObject({ outcome: 'refused', code: 'credential_in_result' });
    expect(JSON.stringify(outcome)).not.toContain(LIVE);
  });

  test('refusals and errors pass through untouched', () => {
    const refused = { outcome: 'refused', code: 'excluded', message: 'excluded' } as const;
    expect(sanitizeToolOutcome(policy, refused)).toBe(refused);
  });
});
