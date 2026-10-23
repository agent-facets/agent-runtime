import { describe, expect, test } from 'bun:test';
import type { Provider, QuestionInput, RunEvent, RunSnapshot } from '../packages/contracts/src/index.ts';
import { ApiClient } from '../packages/ui/src/api/client.ts';
import { type ExpectedNegative, reportTrial, TrialRefused } from '../tests/acceptance/anthropic-trial.ts';
import { repoRoot } from './lib/workspace.ts';

async function run(args: string[]) {
  const proc = Bun.spawn([process.execPath, '--no-env-file', 'scripts/acceptance-anthropic.ts', ...args], {
    cwd: repoRoot,
    env: { PATH: process.env.PATH ?? '' },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, out: `${out}${err}` };
}

// Recorded trial runs as the runtime's API would serve them, for the report to read. No runtime or provider.
const JOURNEY = '11111111-1111-4111-8111-111111111111';
const CANCEL = '22222222-2222-4222-8222-222222222222';
const QUESTION = 'a'.repeat(64);
const AT = '2026-10-06T12:00:00Z';

const choice = (...values: (boolean | string)[]): QuestionInput => ({
  kind: 'choice',
  multiple: false,
  options: values.map((value) => ({ label: String(value), value })),
});
const BOOLEAN = choice(true, false);
const YES_NO = choice('yes', 'no');

interface Recorded {
  provider: Provider;
  maximum: number;
  consumed: number;
  unconfirmed: number;
  state: RunSnapshot['run']['state'];
  events: Pick<RunEvent, 'kind' | 'payload'>[];
}

function journey(options: { input?: QuestionInput; answer?: unknown; answeredId?: string } = {}): Recorded {
  const events: Pick<RunEvent, 'kind' | 'payload'>[] = [
    {
      kind: 'tool.operation',
      payload: {
        operationId: 'c'.repeat(64),
        toolName: 'mcp_Read',
        disposition: { kind: 'completed', outcome: 'ok', result: {} },
      },
    },
    {
      kind: 'question.asked',
      payload: { questionId: QUESTION, prompt: 'List the checklist steps?', input: options.input ?? BOOLEAN },
    },
  ];
  if (!Object.hasOwn(options, 'answer') || options.answer !== undefined) {
    events.push({
      kind: 'question.answered',
      payload: {
        questionId: options.answeredId ?? QUESTION,
        answer: (Object.hasOwn(options, 'answer') ? options.answer : false) as never,
        acceptedAt: AT,
      },
    });
  }
  events.push({ kind: 'assistant.message', payload: { messageId: 'final', text: 'Understood.' } });
  return {
    provider: 'anthropic',
    maximum: 6,
    consumed: 3,
    unconfirmed: 0,
    state: { kind: 'succeeded', finishedAt: AT, resultSeq: String(events.length) },
    events,
  };
}

function cancelled(): Recorded {
  return {
    provider: 'anthropic',
    maximum: 6,
    consumed: 1,
    unconfirmed: 0,
    state: { kind: 'cancelled', finishedAt: AT, acceptedAt: AT },
    events: [
      { kind: 'question.asked', payload: { questionId: 'b'.repeat(64), prompt: 'Are you ready?', input: BOOLEAN } },
      { kind: 'cancellation.accepted', payload: { acceptedAt: AT } },
      { kind: 'question.closed', payload: { questionId: 'b'.repeat(64), reason: 'cancelled', closedAt: AT } },
    ],
  };
}

/** A read-only stand-in for the runtime's API over the given runs; records every request it receives. */
function fakeRuntime(runs: Record<string, Recorded>, options?: object) {
  const requests: string[] = [];
  const json = (body: unknown) => Response.json(body);
  const handle = (request: Request): Response => {
    const url = new URL(request.url);
    requests.push(`${request.method} ${url.pathname}`);
    if (request.method !== 'GET') return new Response(null, { status: 405 });
    if (url.pathname === '/api/v1/options' && options !== undefined) return json(options);
    const match = /^\/api\/v1\/runs\/([^/]+)(\/events)?$/.exec(url.pathname);
    const recorded = match === null ? undefined : runs[match[1] as string];
    if (match === null || recorded === undefined) return new Response(null, { status: 404 });
    const runId = match[1] as string;
    const throughSeq = String(recorded.events.length);
    if (match[2] !== undefined) {
      const events = recorded.events.map((event, index) => ({
        runId,
        seq: String(index + 1),
        recordedAt: AT,
        ...event,
      }));
      return json({ events, nextAfter: throughSeq });
    }
    return json({
      run: {
        runId,
        goal: 'trial goal',
        provider: recorded.provider,
        authMode: 'subscription',
        model: 'model',
        workspace: { label: 'Acceptance trial', root: '/workspace' },
        state: recorded.state,
        budget: { maximum: recorded.maximum, consumed: recorded.consumed, unconfirmed: recorded.unconfirmed },
        createdAt: AT,
        lastActivityAt: AT,
      },
      throughSeq,
    });
  };
  const client = new ApiClient({
    base: 'http://runtime.test',
    fetch: async (input, init) => handle(new Request(input, init)),
  });
  return { client, requests, handle };
}

async function report(
  runs: { journey: Recorded; cancel: Recorded },
  provider?: Provider,
  expectedAnswer?: ExpectedNegative,
) {
  const runtime = fakeRuntime({ [JOURNEY]: runs.journey, [CANCEL]: runs.cancel });
  const result = await reportTrial(runtime.client, { journey: JOURNEY, cancel: CANCEL }, provider, expectedAnswer);
  expect(runtime.requests.every((request) => request.startsWith('GET '))).toBe(true);
  return result;
}

const PASSED = { passed: true, requests: { journey: 3, cancel: 1, total: 4 }, findings: [] };

describe('acceptance trial report', () => {
  test('passes a journey answered with the declared boolean false, by default', async () => {
    expect(await report({ journey: journey(), cancel: cancelled() })).toEqual(PASSED);
  });

  test('passes a journey answered with the declared string "no" only when told to expect it', async () => {
    const runs = () => ({
      journey: { ...journey({ input: YES_NO, answer: 'no' }), provider: 'openai' as const },
      cancel: { ...cancelled(), provider: 'openai' as const },
    });
    expect(await report(runs(), 'openai', 'no')).toEqual(PASSED);
    // Without the declaration the strict default stands: "no" is not false.
    expect((await report(runs(), 'openai')).findings).toEqual([
      'the journey’s question did not offer false as a single choice',
      'the journey’s question was not answered with false',
    ]);
  });

  test('refuses answers that are missing, positive, of another type, undeclared or for another question', async () => {
    const cases: [Recorded, ExpectedNegative, string[]][] = [
      [journey({ answer: undefined }), false, ['the journey’s question was not answered with false']],
      [journey({ answer: true }), false, ['the journey’s question was not answered with false']],
      [
        journey({ input: choice(true, 'false'), answer: 'false' }),
        false,
        [
          'the journey’s question did not offer false as a single choice',
          'the journey’s question was not answered with false',
        ],
      ],
      [
        journey({ answer: false }),
        'no',
        [
          'the journey’s question did not offer "no" as a single choice',
          'the journey’s question was not answered with "no"',
        ],
      ],
      [
        journey({ input: { kind: 'text', minLength: 0, maxLength: 10 }, answer: 'no' }),
        'no',
        ['the journey’s question did not offer "no" as a single choice'],
      ],
      [
        journey({
          input: {
            kind: 'choice',
            multiple: true,
            options: YES_NO.kind === 'choice' ? YES_NO.options : [],
            minSelections: 0,
            maxSelections: 2,
          },
          answer: 'no',
        }),
        'no',
        ['the journey’s question did not offer "no" as a single choice'],
      ],
      [journey({ answeredId: 'd'.repeat(64) }), false, ['the journey’s question was not answered with false']],
    ];
    for (const [recorded, expected, findings] of cases) {
      const result = await report({ journey: recorded, cancel: cancelled() }, undefined, expected);
      expect(result.passed).toBe(false);
      expect(result.findings).toEqual(findings);
    }
  });

  test('refuses runs on another provider, and the same run named twice before reading anything', async () => {
    const wrong = await report({ journey: journey(), cancel: { ...cancelled(), provider: 'openai' } });
    expect(wrong.findings).toEqual(['the second run ran on openai']);

    const runtime = fakeRuntime({ [JOURNEY]: journey() });
    await expect(reportTrial(runtime.client, { journey: JOURNEY, cancel: JOURNEY })).rejects.toBeInstanceOf(
      TrialRefused,
    );
    expect(runtime.requests).toEqual([]);
  });

  test('holds each run to its own budget and cap, and the two runs to theirs, counting unconfirmed requests', async () => {
    const budget = await report({ journey: { ...journey(), maximum: 7 }, cancel: cancelled() });
    expect(budget.findings).toEqual(['the journey’s budget is 7, not 6']);

    const over = await report({
      journey: { ...journey(), consumed: 4, unconfirmed: 2 },
      cancel: { ...cancelled(), consumed: 5, unconfirmed: 2 },
    });
    expect(over.requests).toEqual({ journey: 6, cancel: 7, total: 13 });
    expect(over.findings).toEqual([
      'the second run’s 7 model requests exceed its cap of 6',
      'the two runs’ 13 model requests exceed the cap of 12',
    ]);
  });
});

describe('acceptance trial tool', () => {
  test('refuses unknown actions, non-HTTPS remote origins and reports without both runs', async () => {
    const report = ['report', '--origin', 'https://node.example.ts.net', '--journey', JOURNEY, '--cancel', CANCEL];
    for (const args of [
      [],
      ['go', '--origin', 'https://node.example.ts.net'],
      ['check', '--origin', 'http://node.example.ts.net'],
      ['check'],
      ['check', '--origin', 'https://node.example.ts.net', '--trial', '../x'],
      ['report', '--origin', 'https://node.example.ts.net', '--journey', 'x'],
      [...report, '--expected-answer', 'maybe'],
      [...report, '--expected-answer', 'False'],
      ['check', '--origin', 'https://node.example.ts.net', '--expected-answer', 'no'],
      ['start', '--origin', 'https://node.example.ts.net', '--expected-answer', 'false'],
    ]) {
      const result = await run(args);
      expect(result.code).toBe(2);
      expect(result.out).toContain('usage: acceptance:anthropic');
    }
  });

  test('refuses, and changes nothing, when the runtime does not answer as the API', async () => {
    const requests: string[] = [];
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: (request) => {
        requests.push(`${request.method} ${new URL(request.url).pathname}`);
        return new Response('<html>not the runtime</html>', { status: 503 });
      },
    });
    try {
      const result = await run(['start', '--origin', `http://127.0.0.1:${server.port}`]);
      expect(result.code).toBe(1);
      expect(result.out).toContain('refused: the runtime’s options could not be read');
      expect(requests).toEqual(['GET /api/v1/options']);
    } finally {
      server.stop(true);
    }
  });

  test('reports by reading only, with the expected answer it is given and a labelled subtotal', async () => {
    const runtime = fakeRuntime(
      {
        [JOURNEY]: { ...journey({ input: YES_NO, answer: 'no' }), provider: 'openai' },
        [CANCEL]: { ...cancelled(), provider: 'openai' },
      },
      {
        workspace: { label: 'Acceptance trial', available: true },
        providers: [{ provider: 'openai', authMode: 'subscription', model: 'model', readiness: 'ready' }],
        defaultProvider: 'anthropic',
        defaultBudget: 6,
        modelRequestCeiling: 23,
      },
    );
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: runtime.handle });
    try {
      const args = ['report', '--origin', `http://127.0.0.1:${server.port}`, '--journey', JOURNEY, '--cancel', CANCEL];
      args.push('--provider', 'openai', '--ceiling', '23');
      const declared = await run([...args, '--expected-answer', 'no']);
      expect(declared.code).toBe(0);
      expect(declared.out).toContain(
        "model requests: journey 3, cancellation 1, named-run subtotal 4 of 12 (these two runs only; other runs count against the deployment's ceiling)",
      );
      expect(declared.out).toContain('trial conditions hold');

      const strict = await run(args);
      expect(strict.code).toBe(1);
      expect(strict.out).toContain('finding: the journey’s question was not answered with false');
      expect(strict.out).toContain('trial conditions do not hold');
      expect(runtime.requests.length).toBeGreaterThan(0);
      expect(runtime.requests.every((request) => request.startsWith('GET '))).toBe(true);
    } finally {
      server.stop(true);
    }
  });
});
