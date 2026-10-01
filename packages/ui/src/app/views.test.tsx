import { describe, expect, test } from 'bun:test';
import type { FailureCategory, RunEvent, RunState } from '@agent-runtime/contracts';
import { renderToStaticMarkup } from 'react-dom/server';
import { ApiClient } from '../api/client.ts';
import type { Connection } from '../state/sync.ts';
import { RunTimeline } from '../state/timeline.ts';
import { AT, answered, asked, attempt, message, QUESTION, snapshot, status } from '../test-support/fixtures.ts';
import { FAILURE_LABELS, STATE_LABELS } from './format.ts';
import { RunPage } from './RunDetail.tsx';

const client = new ApiClient({ fetch: async () => new Response('{}') });

function page(state: RunState, events: RunEvent[] = [], connection: Connection = 'live', extra = {}, through = '0') {
  const timeline = new RunTimeline(snapshot(through, state, extra));
  timeline.applyEvents(events);
  return renderToStaticMarkup(
    <RunPage client={client} view={timeline.view()} connection={connection} refresh={() => {}} />,
  );
}

const failure = (category: FailureCategory) => ({
  category,
  reason: `${category}_reason`,
  message: `Explanation for ${category}.`,
  operation: { kind: 'runtime' as const },
  remediation: `What to do about ${category}.`,
});

describe('run views', () => {
  test('every state has its own label and explanation, and only unfinished runs can be cancelled', () => {
    const states: RunState[] = [
      { kind: 'working' },
      { kind: 'waiting', questionId: QUESTION },
      { kind: 'cancelling', acceptedAt: AT },
      { kind: 'succeeded', finishedAt: AT, resultSeq: '1' },
      { kind: 'failed', finishedAt: AT, failure: failure('runtime_failure') },
      { kind: 'cancelled', finishedAt: AT, acceptedAt: AT },
      { kind: 'interrupted', detectedAt: AT, lastActivityAt: AT },
    ];
    for (const state of states) {
      const html = page(state);
      expect(html).toContain(`status-${state.kind}`);
      expect(html).toContain(STATE_LABELS[state.kind]);
      expect(html.includes('Cancel run')).toBe(state.kind === 'working' || state.kind === 'waiting');
    }
    expect(new Set(Object.values(STATE_LABELS)).size).toBe(7);
    expect(page({ kind: 'succeeded', finishedAt: AT, resultSeq: '1' })).not.toContain('Working');
    expect(page({ kind: 'interrupted', detectedAt: AT, lastActivityAt: AT })).toContain('will not be resumed');
  });

  test('a failure shows its category, reason, explanation and guidance', () => {
    for (const category of Object.keys(FAILURE_LABELS) as FailureCategory[]) {
      const html = page({ kind: 'failed', finishedAt: AT, failure: { ...failure(category), retryAfterSeconds: 120 } });
      expect(html).toContain(`Failed — ${FAILURE_LABELS[category]}`);
      expect(html).toContain(`Explanation for ${category}.`);
      expect(html).toContain(`What to do about ${category}.`);
      expect(html).toContain('about 2 minutes');
    }
  });

  test('identity, provider, workspace, times and the budget with unconfirmed requests are shown', () => {
    const html = page({ kind: 'working' }, [attempt(1, 3)], 'live', {
      budget: { maximum: 10, consumed: 2, unconfirmed: 1 },
    });
    expect(html).toContain('00000000-0000-4000-8000-000000000001');
    expect(html).toContain('Anthropic · claude-opus-5');
    expect(html).toContain('/workspace');
    expect(html).toContain(`title="${AT}"`);
    // The newest attempt event updated the budget: three used.
    expect(html).toContain('3 of 10 used');
  });

  test('history shows status changes with times, the question, the exact answer and the result', () => {
    const html = page(
      { kind: 'succeeded', finishedAt: AT, resultSeq: '5' },
      [
        status(1, { kind: 'waiting', questionId: QUESTION }),
        asked(2),
        answered(3, false),
        status(4, { kind: 'working' }),
        message(5, 'All done.'),
      ],
      'complete',
      {},
      '5',
    );
    expect(html.indexOf('Waiting for you')).toBeLessThan(html.indexOf('Proceed?'));
    expect(html).toContain('Answer accepted: <strong>false</strong>');
    expect(html).toMatch(/class="message final"><p class="label">Result<\/p><p class="text">All done\.<\/p>/);
    expect((html.match(/<time /g) ?? []).length).toBe(5);
  });

  test('model and workspace text is rendered as text, never as markup', () => {
    const hostile = '<script>alert(1)</script><img src=x onerror=alert(2)>[link](javascript:alert(3))';
    const html = page({ kind: 'working' }, [message(1, hostile)], 'live', { goal: hostile });
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('href="javascript');
  });

  test('a waiting run offers its question with typed choices; the connection is shown separately', () => {
    const html = page({ kind: 'waiting', questionId: QUESTION }, [], 'reconnecting', {
      pendingQuestion: {
        questionId: QUESTION,
        prompt: 'Proceed?',
        input: {
          kind: 'choice',
          multiple: false,
          options: [
            { label: 'Yes', value: true },
            { label: 'No', value: false },
          ],
        },
      },
    });
    expect(html).toContain('aria-label="Answer the question"');
    expect(html).toContain('type="radio"');
    expect(html).toContain('Reconnecting');
    expect(html).toContain(STATE_LABELS.waiting);
  });
});
