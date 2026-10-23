import { afterAll, describe, expect, test } from 'bun:test';
import { createFixture } from '../../test-support/workspace.ts';
import { exactSecretMatcher } from '../credentials/matcher.ts';
import { readWorkspace } from '../workspace/read.ts';
import { searchWorkspace } from '../workspace/search.ts';
import { createContentPolicy, REDACTION } from './content-policy.ts';
import { CompleteMessageAssembler, type StreamFragment, sanitizeToolOutcome } from './pre-graph.ts';

const LIVE = 'oauth-live-synthetic-0123456789abcdefABCDEF';
const policy = createContentPolicy(exactSecretMatcher([LIVE]));

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

describe('bounded assembly', () => {
  test('a message within the input bound is rejected when redaction expands it past the bound', () => {
    // Separated occurrences: each 16-byte token becomes a 21-byte marker. (Touching occurrences merge into one.)
    const short = '0123456789abcdef';
    const expanding = createContentPolicy(exactSecretMatcher([short]));
    const text = `${short} `.repeat(61_680);
    expect(new TextEncoder().encode(text).byteLength + 16).toBe(1_048_576);
    const bounded = new CompleteMessageAssembler(expanding);
    bounded.push({ kind: 'text', text });
    bounded.push({ kind: 'terminal' });
    expect(bounded.finish()).toEqual({ kind: 'rejected', reason: 'response_too_large' });
    const roomy = new CompleteMessageAssembler(expanding, 2 * 1_048_576);
    roomy.push({ kind: 'text', text });
    roomy.push({ kind: 'terminal' });
    expect(roomy.finish().kind).toBe('message');
  });

  test('retained structure counts toward the bound, so empty fragments cannot accumulate without limit', () => {
    const assembler = new CompleteMessageAssembler(policy);
    for (let index = 0; index < 70_000; index++) assembler.push({ kind: 'text', text: '' });
    assembler.push({ kind: 'terminal' });
    expect(assembler.finish()).toEqual({ kind: 'rejected', reason: 'response_too_large' });
    const calls = new CompleteMessageAssembler(policy);
    for (let index = 0; index < 20_000; index++) calls.push({ kind: 'tool_call', index });
    calls.push({ kind: 'terminal' });
    expect(calls.finish()).toEqual({ kind: 'rejected', reason: 'response_too_large' });
  });

  test('the exact input bound is inclusive, and escaping counts toward the output bound', () => {
    const atLimit = new CompleteMessageAssembler(policy, 100);
    atLimit.push({ kind: 'text', text: 'x'.repeat(100 - 16 - 30) });
    atLimit.push({ kind: 'terminal' });
    expect(atLimit.finish().kind).toBe('message');
    const over = new CompleteMessageAssembler(policy, 100);
    over.push({ kind: 'text', text: 'x'.repeat(100 - 15) });
    over.push({ kind: 'terminal' });
    expect(over.finish()).toEqual({ kind: 'rejected', reason: 'response_too_large' });
    // 40 quotes are 40 input bytes but 80 serialized bytes.
    const escaped = new CompleteMessageAssembler(policy, 100);
    escaped.push({ kind: 'text', text: '"'.repeat(40) });
    escaped.push({ kind: 'terminal' });
    expect(escaped.finish()).toEqual({ kind: 'rejected', reason: 'response_too_large' });
  });

  test('unstorable text is rejected rather than stored', () => {
    for (const text of ['a\u0000b', '\uD83D']) {
      const assembler = new CompleteMessageAssembler(policy);
      assembler.push({ kind: 'text', text });
      assembler.push({ kind: 'terminal' });
      expect(assembler.finish()).toEqual({ kind: 'rejected', reason: 'unstorable_response' });
    }
    const call = new CompleteMessageAssembler(policy);
    call.push({ kind: 'tool_call', index: 0, id: 'c', name: 'mcp_Read', argumentsDelta: '{"path":"a\\u0000"}' });
    call.push({ kind: 'terminal' });
    expect(call.finish()).toEqual({ kind: 'rejected', reason: 'unstorable_response' });
  });

  test('a message whose redacted form is still recognizable is withheld', () => {
    const assembler = new CompleteMessageAssembler(policy);
    assembler.push({ kind: 'text', text: `${LIVE}ghp_SyntheticSyntheticSyntheticSynthetic01` });
    assembler.push({ kind: 'terminal' });
    expect(assembler.finish()).toEqual({ kind: 'rejected', reason: 'unsafe_response' });
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
      await readWorkspace(workspace, { mode: 'file', path: 'config/app.ts' }, { screen: policy }),
    );
    const found = sanitizeToolOutcome(
      policy,
      await searchWorkspace(workspace, { query: 'MARKER' }, { screen: policy }),
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

  test('safe refusals and errors pass through; unsafe ones are replaced, whatever produced them', () => {
    const refused = { outcome: 'refused', code: 'excluded', message: 'This location is excluded.' } as const;
    expect(sanitizeToolOutcome(policy, refused)).toEqual(refused);
    for (const unsafe of [
      { outcome: 'error', code: 'upstream', message: `failed with ${LIVE}` },
      { outcome: 'error', code: 'Upstream Error', message: 'x' },
      { outcome: 'error', code: 'upstream', message: 'x'.repeat(1_025) },
      { outcome: 'refused', code: 'x', message: 'a\u0000' },
    ] as const) {
      const outcome = sanitizeToolOutcome(policy, unsafe);
      expect(outcome).toMatchObject({ outcome: 'refused', code: 'credential_in_result' });
      expect(JSON.stringify(outcome)).not.toContain('synthetic');
    }
  });

  test('a text field that is still recognizable after redaction withholds the result', () => {
    const outcome = sanitizeToolOutcome(policy, {
      outcome: 'ok',
      result: { lines: [{ line: 1, text: `${LIVE}ghp_SyntheticSyntheticSyntheticSynthetic01` }] },
    });
    expect(outcome).toMatchObject({ outcome: 'refused', code: 'credential_in_result' });
  });

  test('the complete sanitized outcome is bounded, including expansion by redaction', () => {
    const short = '0123456789abcdef';
    const expanding = createContentPolicy(exactSecretMatcher([short]));
    const text = `${short} `.repeat(3_500);
    const before = { outcome: 'ok', result: { lines: [{ line: 1, text }] } } as const;
    expect(new TextEncoder().encode(JSON.stringify(before)).byteLength).toBeLessThan(65_536);
    expect(sanitizeToolOutcome(expanding, before)).toMatchObject({ outcome: 'refused', code: 'result_too_large' });
    const envelopeOnly = { outcome: 'ok', result: { path: 'p'.repeat(65_520) } } as const;
    expect(sanitizeToolOutcome(policy, envelopeOnly)).toMatchObject({ code: 'result_too_large' });
  });
});
