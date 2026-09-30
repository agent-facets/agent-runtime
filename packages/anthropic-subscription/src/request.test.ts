import { describe, expect, test } from 'bun:test';
import golden from '../test-support/golden/claude-cli-2.1.280.json';
import { ACCESS_TOKEN, GOLDEN_INPUTS } from '../test-support/golden/inputs.ts';
import { billingText, computeCch, computeVersionSuffix } from './billing.ts';
import { CLAUDE_CLI_2_1_280, profileFor } from './profile.ts';
import { adaptInferenceRequest, type InferenceRequest } from './request.ts';

const profile = CLAUDE_CLI_2_1_280;
const adapt = (request: InferenceRequest) => adaptInferenceRequest(request, { profile, accessToken: ACCESS_TOKEN });
const fromInput = (input: (typeof GOLDEN_INPUTS)[number]): InferenceRequest => ({
  url: input.url,
  method: 'POST',
  headers: new Headers(input.headers),
  body: input.body,
});

const base = GOLDEN_INPUTS[0] as (typeof GOLDEN_INPUTS)[number];
const withBody = (change: (body: Record<string, unknown>) => void): InferenceRequest => {
  const body = JSON.parse(base.body);
  change(body);
  return { ...fromInput(base), body: JSON.stringify(body) };
};

describe('profile claude-cli-2.1.280 against the upstream reference', () => {
  test('golden fixtures were generated from the recorded upstream revision for this version', () => {
    expect(golden.generatedFrom).toContain('156cb66c6889e1be3ad2b839345ea409942ab40f');
    expect(golden.clientVersion).toBe(profile.clientVersion);
    expect(golden.appliedDifferences).toEqual(['D1: upstream tool-name aliases decoded to the native names']);
    expect(golden.outputs.map((output) => output.name)).toEqual(GOLDEN_INPUTS.map((input) => input.name));
  });

  for (const [index, input] of GOLDEN_INPUTS.entries()) {
    test(`${input.name}: URL, headers and body bytes match upstream`, () => {
      const expected = golden.outputs[index] as (typeof golden.outputs)[number];
      const result = adapt(fromInput(input));
      if (!result.ok) throw new Error(`refused: ${result.reason}`);
      expect(result.url).toBe(expected.url);
      expect(Object.fromEntries(result.headers)).toEqual(expected.headers);
      expect(result.body).toBe(expected.body);
    });
  }

  test('upstream billing vectors hold (from its own test suite, version 2.1.87)', () => {
    expect(computeCch('hello world test message')).toBe('4ffc3');
    expect(computeVersionSuffix('hello world test message', '2.1.87')).toBe('6ff');
    expect(
      billingText([{ role: 'user', content: 'hello world test message' }], { ...profile, clientVersion: '2.1.87' }),
    ).toBe('x-anthropic-billing-header: cc_version=2.1.87.6ff; cc_entrypoint=sdk-cli; cch=4ffc3;');
  });

  test('profiles are selected by exact ID and are immutable', () => {
    expect(profileFor('claude-cli-2.1.280')).toBe(profile);
    expect(profileFor('claude-cli/2.1.280')).toBeUndefined();
    expect(profileFor('claude-cli-2.1.87')).toBeUndefined();
    expect(Object.isFrozen(profile)).toBe(true);
    expect(Object.isFrozen(profile.requiredBetas)).toBe(true);
  });
});

describe('adaptInferenceRequest', () => {
  test('keeps native tool names, drops the sentinel key and never repeats the beta query', () => {
    const result = adapt(fromInput(GOLDEN_INPUTS[1] as (typeof GOLDEN_INPUTS)[number]));
    if (!result.ok) throw new Error(result.reason);
    const body = JSON.parse(result.body);
    expect(body.tools.map((tool: { name: string }) => tool.name)).toEqual(['mcp_Read', 'mcp_Search', 'mcp_AskUser']);
    expect(body.messages[1].content[1].name).toBe('mcp_Read');
    expect(result.headers.has('x-api-key')).toBe(false);
    expect(result.headers.get('authorization')).toBe(`Bearer ${ACCESS_TOKEN}`);
    expect(body.system.map((block: { text: string }) => block.text.slice(0, 28))).toEqual([
      'x-anthropic-billing-header: ',
      profile.identity.slice(0, 28),
      'You are investigating a repo',
    ]);
  });

  test('adapting an adapted request changes nothing (a renewal retry is adapted again)', () => {
    const once = adapt(fromInput(base));
    if (!once.ok) throw new Error(once.reason);
    const twice = adapt({ url: once.url, method: 'POST', headers: once.headers, body: once.body });
    if (!twice.ok) throw new Error(twice.reason);
    expect(twice.url).toBe(once.url);
    expect(twice.body).toBe(once.body);
    expect(Object.fromEntries(twice.headers)).toEqual(Object.fromEntries(once.headers));
  });

  test('the billing block derives from the leading user text, which every request must open with', () => {
    const noLeadingText = [
      withBody((body) => {
        body.messages = [{ role: 'assistant', content: 'hi' }, ...(body.messages as unknown[])];
      }),
      withBody((body) => {
        body.messages = [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'r' }] }];
      }),
      withBody((body) => {
        body.messages = [{ role: 'user', content: '' }];
      }),
    ];
    for (const request of noLeadingText)
      expect(adapt(request)).toEqual({ ok: false, reason: 'leading_user_text_required' });
  });

  test('refuses tool names and schemas the profile cannot carry unchanged', () => {
    const tool = (name: string, schema: Record<string, unknown> = { type: 'object' }) =>
      withBody((body) => {
        body.tools = [{ name, input_schema: schema }];
      });
    for (const name of ['mcp_read', 'read', 'Read', 'mcp_Read!', 'mcp_Read.v2']) {
      expect(adapt(tool(name))).toEqual({ ok: false, reason: 'tool_name_not_native' });
    }
    expect(
      adapt(tool('mcp_Read', { type: 'object', $schema: 'https://json-schema.org/draft/2020-12/schema' })),
    ).toEqual({
      ok: false,
      reason: 'tool_schema_not_authored',
    });
    expect(
      adapt(tool('mcp_Read', { type: 'object', properties: { x: { $ref: '#/$defs/y' } }, $defs: { y: {} } })),
    ).toEqual({ ok: false, reason: 'tool_schema_not_authored' });
    const history = withBody((body) => {
      body.messages = [
        { role: 'user', content: 'go' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'read', input: {} }] },
      ];
    });
    expect(adapt(history)).toEqual({ ok: false, reason: 'tool_name_not_native' });
  });

  test('refuses any other endpoint, method or query', () => {
    for (const url of [
      'http://api.anthropic.com/v1/messages',
      'https://api.anthropic.com/v1/messages/count_tokens',
      'https://api.anthropic.com/v1/messages?beta=true&x=1',
      'https://api.anthropic.com/v1/messages?beta=false',
      'https://evil.example/v1/messages',
      'https://u:p@api.anthropic.com/v1/messages',
      'not a url',
    ]) {
      expect(adapt({ ...fromInput(base), url })).toEqual({ ok: false, reason: 'unsupported_endpoint' });
    }
    expect(adapt({ ...fromInput(base), method: 'GET' })).toEqual({ ok: false, reason: 'unsupported_endpoint' });
  });

  test('refuses malformed and oversized bodies', () => {
    for (const body of ['', 'not json', '[]', '{}', '{"messages":[]}', '{"messages":"x"}']) {
      expect(adapt({ ...fromInput(base), body })).toEqual({ ok: false, reason: 'invalid_body' });
    }
    expect(
      adapt(
        withBody((body) => {
          body.tools = 'nope';
        }),
      ),
    ).toEqual({ ok: false, reason: 'invalid_body' });
    const huge = withBody((body) => {
      body.messages = [{ role: 'user', content: 'x'.repeat(10 * 1024 * 1024) }];
    });
    expect(adapt(huge)).toEqual({ ok: false, reason: 'body_too_large' });
  });
});
