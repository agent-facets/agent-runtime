import { describe, expect, test } from 'bun:test';
import { externalOutcomeSchema } from '../capabilities/records.ts';
import { exactSecretMatcher } from '../credentials/matcher.ts';
import { createContentPolicy, REDACTION } from '../security/content-policy.ts';
import { TOOL_RESULT_MAX_BYTES } from '../security/pre-graph.ts';
import { type CallInput, callTool, checkArguments, projectResult } from './call.ts';
import { compileArgumentValidator } from './schema.ts';
import type { McpSession } from './session.ts';

const SECRET = 'synthetic-mcp-call-secret-0001';
const policy = createContentPolicy(exactSecretMatcher([SECRET]));
const OP = 'e'.repeat(64);
const validate = compileArgumentValidator({
  type: 'object',
  properties: { repository: { type: 'string' }, body: { type: 'string' } },
  required: ['repository'],
  additionalProperties: false,
});

/** A session double that records each request and answers with the given behavior. */
function session(answer: (options: { signal: AbortSignal }) => Promise<unknown>) {
  const requests: { request: unknown; options: Record<string, unknown> }[] = [];
  let closes = 0;
  const client = {
    transport: {},
    onerror: undefined as ((error: Error) => void) | undefined,
    request: (request: unknown, _schema: unknown, options: Record<string, unknown>) => {
      requests.push({ request, options });
      return answer(options as { signal: AbortSignal });
    },
    close: async () => {
      closes++;
    },
  };
  const value = { client, owned: { exited: Promise.resolve(), transport: {} } } as unknown as McpSession;
  return { value, client, requests, closes: () => closes };
}
const input = (fake: ReturnType<typeof session>, overrides: Partial<CallInput> = {}): CallInput => ({
  session: fake.value,
  toolName: 'list_prs',
  args: { repository: 'owner/repo-a' },
  validate,
  timeoutMs: 1_000,
  signal: new AbortController().signal,
  policy,
  operationId: OP,
  ...overrides,
});
const never = (options: { signal: AbortSignal }) =>
  new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(new Error('aborted'))));

describe('MCP call arguments', () => {
  test('are bounded, schema-checked and credential-free, and never rewritten', () => {
    const args = { repository: 'owner/repo-a' };
    expect(checkArguments({ args, validate, policy })).toBeUndefined();
    expect(args).toEqual({ repository: 'owner/repo-a' });
    expect(checkArguments({ args: { repository: 'x', body: 'y'.repeat(33 * 1024) }, validate, policy })).toMatchObject({
      reason: 'arguments_too_large',
    });
    expect(checkArguments({ args: { repository: `x ${SECRET}` }, validate, policy })).toMatchObject({
      reason: 'credential_in_arguments',
    });
    expect(checkArguments({ args: { repository: 1 }, validate, policy })).toMatchObject({
      reason: 'arguments_invalid',
    });
  });

  test('a refused call sends nothing', async () => {
    const fake = session(async () => ({ content: [] }));
    const result = await callTool(input(fake, { args: { repository: SECRET } }));
    expect(result).toMatchObject({
      dispatched: false,
      outcome: { kind: 'refused', reason: 'credential_in_arguments' },
    });
    expect(fake.requests).toEqual([]);
  });
});

describe('MCP call dispatch', () => {
  test('makes exactly one request, with an absolute deadline that progress cannot extend', async () => {
    const fake = session(async () => ({ content: [{ type: 'text', text: 'two open pull requests' }] }));
    const result = await callTool(input(fake));
    expect(result).toEqual({
      outcome: { kind: 'ok', text: 'two open pull requests' },
      dispatched: true,
      closed: false,
    });
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]?.request).toEqual({
      method: 'tools/call',
      params: { name: 'list_prs', arguments: { repository: 'owner/repo-a' } },
    });
    const options = fake.requests[0]?.options ?? {};
    expect(options.resetTimeoutOnProgress).toBe(false);
    expect(options.onprogress).toBeUndefined();
    expect(options.maxTotalTimeout).toBe(options.timeout);
  });

  test('a JSON-RPC error reply is a failure without the server text', async () => {
    const fake = session(async () => {
      throw Object.assign(new Error(`invalid params: ${SECRET}`), { code: -32602 });
    });
    const result = await callTool(input(fake));
    expect(result).toEqual({
      outcome: { kind: 'failed', reason: 'mcp_call_error', message: 'The server rejected the tool call.' },
      dispatched: true,
      closed: false,
    });
    expect(fake.closes()).toBe(0);
  });

  test('a deadline, cancellation or lost connection after dispatch is uncertain, and the process is closed', async () => {
    const timeout = session(never);
    const timedOut = await callTool(input(timeout, { timeoutMs: 30 }));
    expect(timedOut).toMatchObject({
      dispatched: true,
      closed: true,
      outcome: { kind: 'uncertain', reason: 'mcp_call_timeout', operationId: OP },
    });
    expect(timeout.closes()).toBe(1);
    expect(timeout.requests).toHaveLength(1);

    const controller = new AbortController();
    const cancelled = session(never);
    const pending = callTool(input(cancelled, { signal: controller.signal }));
    controller.abort();
    expect(await pending).toMatchObject({ outcome: { kind: 'uncertain', reason: 'mcp_call_cancelled' }, closed: true });

    const lost = session(async () => {
      throw Object.assign(new Error('Connection closed'), { code: -32000 });
    });
    expect(await callTool(input(lost))).toMatchObject({
      outcome: { kind: 'uncertain', reason: 'mcp_outcome_unknown' },
    });

    const oversized = session(async () => {
      oversized.client.onerror?.(new Error('ReadBuffer exceeded maximum size of 1048576 bytes'));
      throw Object.assign(new Error('Connection closed'), { code: -32000 });
    });
    expect(await callTool(input(oversized))).toMatchObject({
      outcome: { kind: 'uncertain', reason: 'mcp_response_too_large' },
    });
  });

  test('cancellation before dispatch or a gone connection sends nothing', async () => {
    const controller = new AbortController();
    controller.abort();
    const before = session(async () => ({ content: [] }));
    expect(await callTool(input(before, { signal: controller.signal }))).toMatchObject({
      dispatched: false,
      outcome: { kind: 'refused', reason: 'cancelled' },
    });
    const gone = session(async () => ({ content: [] }));
    (gone.client as { transport: unknown }).transport = undefined;
    expect(await callTool(input(gone))).toMatchObject({ dispatched: false, outcome: { kind: 'unavailable' } });
    expect([...before.requests, ...gone.requests]).toEqual([]);
  });
});

describe('MCP result projection', () => {
  test('text is screened whole before it is clipped, and the outcome stays within the result bound', () => {
    const boundary = 'x'.repeat(TOOL_RESULT_MAX_BYTES - 600);
    const outcome = projectResult(
      { content: [{ type: 'text', text: `${boundary}${SECRET}${'y'.repeat(10_000)}` }] },
      policy,
    );
    if (outcome.kind !== 'ok' || outcome.text === undefined) throw new Error('expected text');
    expect(outcome.text).not.toContain(SECRET.slice(0, 12));
    expect(outcome.text.endsWith('[result clipped]')).toBe(true);
    expect(new TextEncoder().encode(JSON.stringify(outcome)).byteLength).toBeLessThanOrEqual(TOOL_RESULT_MAX_BYTES);
    expect(projectResult({ content: [{ type: 'text', text: `token ${SECRET}` }] }, policy)).toEqual({
      kind: 'ok',
      text: `token ${REDACTION}`,
    });
  });

  test('structured content carrying a credential is withheld; clean structured content is kept', () => {
    expect(
      projectResult({ content: [{ type: 'text', text: 'ok' }], structuredContent: { token: SECRET } }, policy),
    ).toEqual({
      kind: 'ok',
      text: 'ok',
    });
    expect(projectResult({ structuredContent: { nested: [{ token: SECRET }] } }, policy)).toMatchObject({
      kind: 'failed',
      reason: 'mcp_result_withheld',
    });
    expect(projectResult({ content: [], structuredContent: { count: 2 } }, policy)).toEqual({
      kind: 'ok',
      json: { count: 2 },
    });
  });

  test('error replies, binary, resource and task results become fixed failures with no follow-up', () => {
    expect(projectResult({ isError: true, content: [{ type: 'text', text: `trace ${SECRET}` }] }, policy)).toEqual({
      kind: 'failed',
      reason: 'mcp_tool_error',
      message: 'The tool reported an error.',
    });
    for (const raw of [
      { content: [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }] },
      { content: [{ type: 'resource', resource: { uri: 'file:///etc/passwd', text: 'x' } }] },
      { content: [{ type: 'resource_link', uri: 'https://example.test/x', name: 'x' }] },
      { task: { taskId: 't1', status: 'working' } },
      'not an object',
    ]) {
      expect(projectResult(raw, policy)).toMatchObject({ kind: 'failed', reason: 'mcp_result_unsupported' });
    }
    // Unsupported blocks beside text are dropped, not fetched.
    expect(
      projectResult(
        {
          content: [
            { type: 'text', text: 'summary' },
            { type: 'resource_link', uri: 'x', name: 'x' },
          ],
        },
        policy,
      ),
    ).toEqual({ kind: 'ok', text: 'summary' });
  });

  test('every projected outcome is a valid closed outcome record', () => {
    for (const raw of [
      { content: [{ type: 'text', text: 'a' }] },
      { structuredContent: { a: 1 } },
      { isError: true },
      { content: [{ type: 'image', data: 'AA', mimeType: 'image/png' }] },
    ]) {
      expect(externalOutcomeSchema.safeParse(projectResult(raw, policy)).success).toBe(true);
    }
  });
});
