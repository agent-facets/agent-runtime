import { describe, expect, test } from 'bun:test';
import type { CatalogView, FailureCategory, RunCapabilitiesView, RunEvent, RunState } from '@agent-runtime/contracts';
import { renderToStaticMarkup } from 'react-dom/server';
import { ApiClient } from '../api/client.ts';
import { RequestIdentity } from '../api/requests.ts';
import type { Connection } from '../state/sync.ts';
import { RunTimeline } from '../state/timeline.ts';
import {
  AT,
  answered,
  asked,
  attempt,
  completed,
  message,
  ok,
  QUESTION,
  RUN,
  request,
  snapshot,
  status,
  tool,
} from '../test-support/fixtures.ts';
import { type Catalog, InstalledCapabilities } from './Capabilities.tsx';
import {
  FAILURE_LABELS,
  formatAge,
  formatClock,
  parseTaskBudget,
  STATE_DESCRIPTIONS,
  STATE_LABELS,
  TASK_BUDGET_GUIDANCE,
} from './format.ts';
import { activitySummary, type ConversationBlock, conversationBlocks } from './History.tsx';
import { ProviderConnection, SessionOptions, TaskBudgetField } from './Home.tsx';
import { Prose } from './Markdown.tsx';
import { RunPage } from './RunDetail.tsx';
import { parseRoute } from './route.ts';
import { SessionItem } from './Sidebar.tsx';

const client = new ApiClient({ fetch: async () => new Response('{}') });

function page(
  state: RunState,
  events: RunEvent[] = [],
  connection: Connection = 'live',
  extra = {},
  through = '0',
  capabilities?: RunCapabilitiesView,
) {
  const timeline = new RunTimeline(snapshot(through, state, extra));
  timeline.applyEvents(events);
  return renderToStaticMarkup(
    <RunPage
      client={client}
      view={timeline.view()}
      connection={connection}
      refresh={() => {}}
      {...(capabilities === undefined ? {} : { capabilities })}
    />,
  );
}

/** Rendered markup as the reader sees it: tags removed, entities decoded. */
const visible = (html: string) =>
  html
    .replace(/<[^>]+>/g, '')
    .replaceAll('&quot;', '"')
    .replaceAll('&#x27;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');

/** The opening tag of the first element carrying `marker` among its classes. */
const tagWith = (html: string, element: string, marker: string) =>
  new RegExp(`<${element} class="(?:[^"]* )?${marker}(?: [^"]*)?"[^>]*>`).exec(html)?.[0] ?? '';

const failure = (category: FailureCategory) => ({
  category,
  reason: `${category}_reason`,
  message: `Explanation for ${category}.`,
  operation: { kind: 'runtime' as const },
  remediation: `What to do about ${category}.`,
});

describe('run views', () => {
  test('every state has its own label and explanation, and only unfinished sessions can be stopped', () => {
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
      expect(visible(html).includes('Stop session')).toBe(state.kind === 'working' || state.kind === 'waiting');
      // A finished session needs no explanation beyond its status; every other state explains itself.
      expect(html.includes(STATE_DESCRIPTIONS[state.kind])).toBe(state.kind !== 'succeeded');
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

  test('status, model and usage are at a glance; identity, workspace, times and the full budget are in details', () => {
    const html = page({ kind: 'working' }, [attempt(1, 3)], 'live', {
      budget: { maximum: 10, consumed: 2, unconfirmed: 1 },
    });
    // The newest attempt event updated the budget: three used.
    const header = visible(html.slice(html.indexOf('<header'), html.indexOf('</header>')));
    expect(header).toContain('Working');
    expect(header).toContain('Anthropic · claude-opus-5 · 3/10 requests');
    const detailsTag = tagWith(html, 'details', 'details');
    const details = html.slice(html.indexOf(detailsTag));
    expect(visible(details)).toContain('00000000-0000-4000-8000-000000000001');
    expect(details).toContain('/workspace');
    expect(details).toContain(`title="${AT}"`);
    expect(details).toContain('Model requests');
    expect(details).toContain('3 of 10 used · 7 remaining');
    expect(details).toContain('shared with any delegated agents');
    // Details start closed.
    expect(detailsTag).not.toBe('');
    expect(detailsTag).not.toContain('open=""');
  });

  test('unconfirmed requests are not shown as used, but count against what remains', () => {
    const snapshotOnly = page({ kind: 'working' }, [], 'live', {
      budget: { maximum: 10, consumed: 2, unconfirmed: 1 },
    });
    expect(snapshotOnly).toContain('2 of 10 used · 1 unconfirmed (counts against the limit) · 7 remaining');
    expect(snapshotOnly).toContain('2/10 requests (+1 unconfirmed)');
    const unconfirmed = attempt(2, 3);
    if (unconfirmed.kind === 'model.attempt') {
      unconfirmed.payload.budget = { maximum: 4, consumed: 1, unconfirmed: 3 };
    }
    expect(page({ kind: 'working' }, [unconfirmed])).toContain(
      '1 of 4 used · 3 unconfirmed (count against the limit) · 0 remaining',
    );
  });

  test('a run that hit the removed deployment-wide ceiling still shows its recorded failure', () => {
    const html = page({
      kind: 'failed',
      finishedAt: AT,
      failure: {
        category: 'step_limit',
        reason: 'request_ceiling_reached',
        message: 'This deployment’s overall limit on model requests has been reached.',
        operation: { kind: 'runtime' },
        remediation: 'Raise or remove the configured model-request ceiling, then start a new run.',
      },
    });
    expect(html).toContain('Failed — step limit');
    expect(html).toContain('This deployment’s overall limit on model requests has been reached.');
  });

  test('the conversation shows the message, status changes with times, the question, the exact answer and the result', () => {
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
    const conversation = html.slice(html.indexOf('<ol class="conversation'));
    expect(conversation.indexOf('Summarize the plan.')).toBeLessThan(conversation.indexOf('Waiting for you'));
    expect(conversation.indexOf('Waiting for you')).toBeLessThan(conversation.indexOf('Proceed?'));
    expect(html).toContain('Answer accepted: <strong>false</strong>');
    expect(html).toMatch(/<span class="badge [^"]*">Result<\/span>/);
    expect(html).toMatch(/class="message final"><div class="prose"><p>All done\.<\/p><\/div>/);
    // The owner's message and every event carry their times.
    expect((conversation.match(/<time /g) ?? []).length).toBe(6);
  });

  test('a model turn with no text is not listed as an empty entry, but an empty result still is', () => {
    const working = page({ kind: 'working' }, [message(1, ''), message(2, 'Reading.')]);
    expect((working.match(/data-seq=/g) ?? []).length).toBe(1);
    expect(working).not.toContain('data-seq="1"');
    const finished = page({ kind: 'succeeded', finishedAt: AT, resultSeq: '1' }, [message(1, '')], 'complete', {}, '1');
    expect(finished).toContain('data-seq="1"');
    expect(finished).toContain('class="message final"');
  });

  test('model and workspace text is rendered as text, never as markup', () => {
    const hostile = '<script>alert(1)</script><img src=x onerror=alert(2)>[link](javascript:alert(3))';
    const html = page({ kind: 'working' }, [message(1, hostile)], 'live', { goal: hostile });
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('href="javascript');
  });

  test('command-run history distinguishes the command, delegations, repeated delegates and the root result', () => {
    const first = 'b'.repeat(64);
    const second = 'c'.repeat(64);
    const helper = (delegationId: string) => ({ kind: 'delegate' as const, delegationId, agentId: 'agent:helper' });
    const at = (seq: number) => ({ runId: RUN, seq: String(seq), recordedAt: AT });
    const events: RunEvent[] = [
      {
        ...at(1),
        kind: 'run.command',
        payload: {
          commandId: 'command:triage',
          selectionRevision: QUESTION,
          arguments: 'owner/repo-a',
          snapshotDigest: QUESTION,
        },
      },
      {
        ...at(2),
        kind: 'delegation.started',
        payload: {
          delegationId: first,
          agentId: 'agent:helper',
          parentActor: { kind: 'root' },
          task: 'Read the issue.',
        },
      },
      {
        ...at(3),
        kind: 'assistant.message',
        payload: { messageId: 'd1', text: 'First finding.', actor: helper(first) },
      },
      {
        ...at(4),
        kind: 'delegation.finished',
        payload: { delegationId: first, outcome: 'result', operationId: first },
      },
      {
        ...at(5),
        kind: 'assistant.message',
        payload: { messageId: 'd2', text: 'Second finding.', actor: helper(second) },
      },
      {
        ...at(6),
        kind: 'delegation.finished',
        payload: { delegationId: second, outcome: 'abandoned', operationId: second },
      },
      { ...at(7), kind: 'assistant.message', payload: { messageId: 'r', text: 'Final.', actor: { kind: 'root' } } },
    ];
    const html = page({ kind: 'succeeded', finishedAt: AT, resultSeq: '7' }, events, 'complete', {}, '7');
    expect(visible(html)).toContain('Command command:triage selected with arguments: owner/repo-a');
    expect(html).toContain('Read the issue.');
    expect(html).toContain('Delegate agent:helper · bbbbbbbb');
    expect(html).toContain('Delegate agent:helper · cccccccc');
    expect(html).toContain('Delegation bbbbbbbb returned a result.');
    expect(html).toContain('Delegation cccccccc was abandoned.');
    // Only the root's final message is the result; a delegate's message never is.
    expect((html.match(/<span class="badge [^"]*">Result<\/span>/g) ?? []).length).toBe(1);
    expect(html).toMatch(/class="message final"><div class="prose"><p>Final\.<\/p><\/div>/);
  });

  test('external tool dispositions never read as delivered or successful when they are not known', () => {
    const tool = (seq: number, disposition: unknown): RunEvent =>
      ({
        runId: RUN,
        seq: String(seq),
        recordedAt: AT,
        kind: 'tool.operation',
        payload: {
          operationId: QUESTION,
          toolName: 'mcp_github_list_issues',
          disposition,
          binding: { kind: 'mcp', serverId: 'github', toolName: 'list_issues', definitionDigest: QUESTION },
        },
      }) as RunEvent;
    const html = page({ kind: 'working' }, [
      tool(1, { kind: 'dispatching' }),
      tool(2, { kind: 'completed', outcome: 'uncertain', result: { outcome: 'uncertain' } }),
    ]);
    expect(html).toContain('github / list_issues');
    expect(html).toContain('request may have been sent');
    expect(html).toContain('outcome unknown: it may or may not have taken effect');
    expect(html).not.toContain('completed');
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

  test('a delegate’s pending question names the delegate that asked', () => {
    const question = {
      questionId: QUESTION,
      prompt: 'Which repository?',
      input: { kind: 'text' as const, minLength: 1, maxLength: 100 },
    };
    const waiting = { kind: 'waiting' as const, questionId: QUESTION };
    const asked = (asker?: unknown) =>
      page(waiting, [], 'live', { pendingQuestion: { ...question, ...(asker ? { asker } : {}) } });
    expect(asked({ kind: 'delegate', delegationId: 'b'.repeat(64), agentId: 'agent:helper' })).toContain(
      'Delegate agent:helper · bbbbbbbb asks',
    );
    expect(asked({ kind: 'root' })).toContain('The root agent asks');
    expect(asked()).toContain('The agent asks');
  });
});

describe('task model-request limit', () => {
  test('accepts only whole numbers from 1 to 10,000', () => {
    expect(['1', '50', ' 10000 '].map(parseTaskBudget)).toEqual([1, 50, 10_000]);
    for (const text of ['', ' ', '0', '-1', '10001', '1.5', '1e3', '0x10', '50 requests', '９']) {
      expect(parseTaskBudget(text)).toBeUndefined();
    }
  });

  test('the start field explains its scope, and explains a rejected value', () => {
    const field = (text: string | undefined) =>
      renderToStaticMarkup(<TaskBudgetField budgetText={text} setBudgetText={() => {}} />);
    const valid = field('50');
    expect(valid).toContain('Model-request limit');
    expect(valid).toContain('name="stepBudget"');
    expect(valid).toContain('value="50"');
    expect(valid).toContain('min="1"');
    expect(valid).toContain('max="10000"');
    expect(valid).toContain('Maximum model requests for this session’s work, including delegated agents.');
    expect(valid).toContain('aria-invalid="false"');
    const invalid = field('0');
    expect(invalid).toContain('aria-invalid="true"');
    expect(invalid).toContain(TASK_BUDGET_GUIDANCE);
    expect(TASK_BUDGET_GUIDANCE).toBe('Enter a whole number from 1 to 10,000.');
    // Before the configured default has loaded there is nothing to submit.
    expect(field(undefined)).toContain('disabled=""');
  });

  test('changing only the limit is a new start request; repeating it keeps the pending identity', () => {
    let next = 0;
    const identity = new RequestIdentity<{ goal: string; stepBudget: number }>(() => `id-${++next}`);
    const first = identity.idFor({ goal: 'g', stepBudget: 50 });
    expect(identity.idFor({ goal: 'g', stepBudget: 50 })).toBe(first);
    expect(identity.idFor({ goal: 'g', stepBudget: 60 })).not.toBe(first);
  });
});

describe('the sidebar', () => {
  const summary = {
    runId: RUN,
    goal: '<b>Summarize</b> the plan.',
    provider: 'openai' as const,
    model: 'gpt-x',
    status: 'waiting' as const,
    createdAt: AT,
    lastActivityAt: AT,
  };

  test('a session shows its message, status in words, provider, start time and short identity', () => {
    const html = renderToStaticMarkup(<SessionItem run={summary} active={false} />);
    const text = visible(html);
    expect(text).toContain('<b>Summarize</b> the plan.');
    expect(html).not.toContain('<b>');
    expect(text).toContain('Waiting for you');
    expect(text).toContain('OpenAI');
    expect(text).toContain('· started ');
    expect(text).toContain('00000000');
    expect(html).toContain(`href="#/runs/${RUN}"`);
    expect(html).not.toContain('aria-current');
    expect(renderToStaticMarkup(<SessionItem run={summary} active />)).toContain('aria-current="page"');
  });

  test('ages are brief and never negative', () => {
    const now = Date.parse('2026-09-30T12:00:00Z');
    expect(formatAge('2026-09-30T12:00:30Z', now)).toBe('now');
    expect(formatAge('2026-09-30T11:55:00Z', now)).toBe('5m');
    expect(formatAge('2026-09-30T09:00:00Z', now)).toBe('3h');
    expect(formatAge('2026-09-28T12:00:00Z', now)).toBe('2d');
    expect(formatAge('not a time', now)).toBe('not a time');
  });

  test('clock times carry a date only when not today, and a year only when not this year', () => {
    const now = new Date(2026, 8, 30, 12).getTime();
    const today = formatClock(new Date(2026, 8, 30, 9, 5).toISOString(), now);
    const earlier = formatClock(new Date(2026, 8, 28, 9, 5).toISOString(), now);
    const lastYear = formatClock(new Date(2025, 8, 28, 9, 5).toISOString(), now);
    expect(today).not.toContain('28');
    expect(today).toMatch(/9:05/);
    expect(earlier).toContain('28');
    expect(earlier).not.toContain('2026');
    expect(lastYear).toContain('2025');
    expect(formatClock('not a time', now)).toBe('not a time');
  });

  test('routes: home, a session, and the installed capabilities', () => {
    expect(parseRoute('')).toEqual({ view: 'home' });
    expect(parseRoute(`#/runs/${RUN}`)).toEqual({ view: 'run', runId: RUN });
    expect(parseRoute('#/capabilities')).toEqual({ view: 'capabilities' });
    expect(parseRoute('#/runs/not-an-id')).toEqual({ view: 'home' });
  });
});

describe('the start form', () => {
  test('options stay folded with the limit in their summary, and open while the limit is invalid', () => {
    const options = (text: string | undefined) =>
      renderToStaticMarkup(<SessionOptions budgetText={text} setBudgetText={() => {}} />);
    const valid = options('50');
    expect(tagWith(valid, 'details', 'options')).not.toContain('open=""');
    expect(valid).toContain('50-request limit');
    const invalid = options('0');
    expect(tagWith(invalid, 'details', 'options')).toContain('open=""');
    expect(invalid).toContain('request limit needs a value');
    expect(invalid).toContain('aria-invalid="true"');
  });

  test('a healthy connection is folded away; one that needs a sign-in is open', () => {
    const connection = (ready: boolean) =>
      renderToStaticMarkup(
        <ProviderConnection ready={ready}>
          <button type="button">Reconnect</button>
        </ProviderConnection>,
      );
    expect(tagWith(connection(true), 'details', 'connection-settings')).not.toContain('open=""');
    expect(connection(true)).toContain('Connected');
    expect(tagWith(connection(false), 'details', 'connection-settings')).toContain('open=""');
    expect(connection(false)).toContain('Sign-in needed');
  });
});

const seqs = (blocks: ConversationBlock[]) =>
  blocks.map((block) => (block.kind === 'event' ? block.event.seq : block.events.map((event) => event.seq)));

describe('the conversation', () => {
  const delegate = { kind: 'delegate' as const, delegationId: 'b'.repeat(64), agentId: 'agent:helper' };

  test('routine work is folded in place between messages; every shown event keeps its order', () => {
    const events: RunEvent[] = [
      {
        runId: RUN,
        seq: '1',
        recordedAt: AT,
        kind: 'run.created',
        payload: { provider: 'anthropic', model: 'm', budgetMax: 10 },
      },
      status(2, { kind: 'working' }),
      request(3, { kind: 'reserved' }, 1),
      request(4, completed, 1),
      message(5, 'Let me look.'),
      tool(6, { kind: 'started' }, 'a'),
      tool(7, { kind: 'started' }, 'c'),
      tool(8, ok, 'a'),
      tool(9, ok, 'c'),
      request(10, completed, 2),
      message(11, 'Done.'),
    ];
    const blocks = conversationBlocks(events, '11');
    expect(seqs(blocks)).toEqual([['1', '2', '3', '4'], '5', ['6', '7', '8', '9', '10'], '11']);
    expect(activitySummary(events.slice(5, 10))).toBe('2 tool calls · 1 model request');
    expect(activitySummary(events.slice(0, 2))).toBe('2 events');
  });

  test('failures, unknown outcomes and questions are never folded, and split the activity around them', () => {
    const events: RunEvent[] = [
      tool(1, { kind: 'started' }, 'a'),
      tool(2, { kind: 'completed', outcome: 'refused', result: {} }, 'a'),
      tool(3, { kind: 'started' }, 'c'),
      tool(4, { kind: 'dispatching' }, 'c'),
      tool(5, { kind: 'completed', outcome: 'uncertain', result: {} }, 'c'),
      request(6, { kind: 'unconfirmed', detectedAt: AT }, 1),
      request(7, { kind: 'abandoned', reason: 'cancelled', at: AT }, 2),
      tool(8, { kind: 'started' }, 'd'),
      tool(9, { kind: 'paused', questionId: QUESTION }, 'd'),
      asked(10),
      status(11, { kind: 'waiting', questionId: QUESTION }),
      status(12, { kind: 'failed', finishedAt: AT, failure: failure('tool_failure') }),
    ];
    expect(seqs(conversationBlocks(events, undefined))).toEqual([
      ['1'],
      '2',
      ['3'],
      // A request that may have been sent stays visible until its operation completes normally.
      '4',
      '5',
      '6',
      '7',
      // The call paused for an answer is how the question was asked: it folds, and the question itself shows.
      ['8', '9'],
      '10',
      // Waiting is said by the question itself.
      ['11'],
      '12',
    ]);
  });

  test('steps of an operation that later completed normally are routine', () => {
    const events: RunEvent[] = [
      tool(1, { kind: 'dispatching' }, 'a'),
      tool(2, { kind: 'paused', questionId: QUESTION }, 'c'),
      tool(3, ok, 'a'),
      tool(4, ok, 'c'),
    ];
    expect(seqs(conversationBlocks(events, undefined))).toEqual([['1', '2', '3', '4']]);
  });

  test('work by different agents, or different delegations, is never folded together', () => {
    const other = { ...delegate, delegationId: 'c'.repeat(64) };
    const events: RunEvent[] = [
      tool(1, ok, 'a'),
      tool(2, ok, 'c', delegate),
      tool(3, ok, 'd', delegate),
      tool(4, ok, 'e', other),
      tool(5, ok, 'f', { kind: 'root' }),
    ];
    const blocks = conversationBlocks(events, undefined);
    expect(seqs(blocks)).toEqual([['1'], ['2', '3'], ['4'], ['5']]);
    const html = page({ kind: 'working' }, events);
    expect(html).toContain('Delegate agent:helper · bbbbbbbb · </span>Activity');
    expect(html).toContain('Delegate agent:helper · cccccccc · </span>Activity');
  });

  test('folded activity keeps every event, its time and its result, in a closed disclosure', () => {
    const html = page({ kind: 'working' }, [tool(1, { kind: 'started' }), tool(2, ok)]);
    expect(html).toMatch(/<li class="activity"><details class="group">/);
    expect(visible(html)).toContain('Activity · 1 tool call');
    expect(html).toContain('data-seq="1"');
    expect(html).toContain('data-seq="2"');
    expect(html).toContain('&quot;contents&quot;');
    expect((html.match(/<time /g) ?? []).length).toBe(3);
  });

  test('a growing activity block keeps its identity, so an opened disclosure stays open', () => {
    const before = conversationBlocks([tool(1, { kind: 'started' })], undefined);
    const after = conversationBlocks([tool(1, { kind: 'started' }), tool(2, ok)], undefined);
    const first = (blocks: ConversationBlock[]) => (blocks[0]?.kind === 'activity' ? blocks[0].events[0]?.seq : '');
    expect(first(before)).toBe('1');
    expect(first(after)).toBe('1');
  });

  test('a pending question stays in its place and is answered in a form docked below the conversation', () => {
    const pendingQuestion = {
      questionId: QUESTION,
      prompt: 'Proceed?',
      input: {
        kind: 'choice' as const,
        multiple: false,
        options: [
          { label: 'Yes', value: true },
          { label: 'No', value: false },
        ],
      },
    };
    const waiting = { kind: 'waiting' as const, questionId: QUESTION };
    const html = page(waiting, [message(1, 'Before.'), asked(2), status(3, waiting)], 'live', { pendingQuestion }, '3');
    // The record keeps its place in the conversation, marked as waiting.
    const record = html.indexOf('data-seq="2"');
    expect(record).toBeGreaterThan(html.indexOf('Before.'));
    expect(record).toBeLessThan(html.indexOf('data-seq="3"'));
    expect(visible(html)).toContain('Waiting for your answer below.');
    // The form follows the whole conversation.
    const form = html.indexOf('aria-label="Answer the question"');
    expect(form).toBeGreaterThan(html.lastIndexOf('</ol>'));
    expect(html).toContain('id="pending-question"');
    expect(html).toContain('type="radio"');
    // The prompt is shown once, in the record, and the form is described by it; the choices are offered only by the
    // form, not listed again in the record.
    expect((visible(html).match(/Proceed\?/g) ?? []).length).toBe(1);
    const promptId = /<p id="(question-prompt-[^"]+)"[^>]*>Proceed\?<\/p>/.exec(html)?.[1];
    expect(promptId).toBeDefined();
    expect(html).toContain(`aria-describedby="${promptId}"`);
    expect(html.slice(record, html.indexOf('data-seq="3"'))).not.toContain('Yes');
    expect(visible(html.slice(form))).toContain('Yes');

    // Before the question's own event has arrived, it can already be answered: its prompt is shown once, as a
    // provisional entry after the conversation, with no place or time of its own.
    const early = page(waiting, [message(1, 'Before.')], 'loading', { pendingQuestion }, '3');
    expect(early).toContain('aria-label="Answer the question"');
    expect((visible(early).match(/Proceed\?/g) ?? []).length).toBe(1);
    expect(visible(early)).not.toContain('Waiting for your answer below.');
    const provisional = early.indexOf('provisional-question');
    expect(provisional).toBeGreaterThan(early.lastIndexOf('</ol>'));
    expect(provisional).toBeLessThan(early.indexOf('aria-label="Answer the question"'));
    expect(early).toContain(`aria-describedby="${promptId}"`);
    expect(early.slice(provisional, early.indexOf('aria-label="Answer the question"'))).not.toContain('<time');
  });

  test('once answered, a question shows its choices with their values again', () => {
    const html = page({ kind: 'working' }, [asked(1), answered(2, false)]);
    expect(visible(html)).toContain('Yes (true)');
    expect(visible(html)).toContain('No (false)');
    expect(visible(html)).toContain('Answer accepted: false');
  });

  test('an answered question stays in the conversation and no form is offered', () => {
    const html = page({ kind: 'working' }, [asked(1), answered(2, true)]);
    expect(html).toContain('Proceed?');
    expect(html).toContain('Answer accepted: <strong>true</strong>');
    expect(html).not.toContain('aria-label="Answer the question"');
    expect(visible(html)).not.toContain('Waiting for your answer below.');
  });

  test('the page offers an explicit jump to the latest entry and no continuation', () => {
    const html = page(
      { kind: 'succeeded', finishedAt: AT, resultSeq: '1' },
      [message(1, 'Done.')],
      'complete',
      {},
      '1',
    );
    // Offered only once newer activity is out of view; at first the end is in view.
    expect(html).toMatch(/invisible[^"]*"><svg[^>]*>.*?<\/svg>Jump to latest<\/button>/);
    expect(html).not.toMatch(/Resume|Continue session|Send message/);
  });

  test('assistant prose is Markdown; HTML stays text, images do not load and unsafe links go nowhere', () => {
    const html = renderToStaticMarkup(
      <Prose
        text={
          '**Bold**\n\n- one\n- two\n\n![pixel](https://example.com/p.png) [bad](javascript:alert(1)) [good](https://example.com)\n\n<script>alert(2)</script>'
        }
      />,
    );
    expect(html).toContain('<strong>Bold</strong>');
    expect(html).toContain('<li>one</li>');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('javascript:');
    expect(html).toContain('<a href="https://example.com" target="_blank" rel="noopener noreferrer">good</a>');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;alert(2)&lt;/script&gt;');
  });
});

const ORIGIN = { facet: 'workflows', version: '1.0.0', integrity: 'sha256:abc' };

describe('capability views', () => {
  const RETAINED: RunCapabilitiesView = {
    kind: 'command',
    throughSeq: '9',
    snapshotDigest: QUESTION,
    command: {
      id: 'command:triage',
      name: 'triage',
      origins: [ORIGIN],
      selectionRevision: QUESTION,
      arguments: '<b>owner/repo-a</b>',
      renderedGoal: 'Triage owner/repo-a',
    },
    bound: {
      skills: [
        { id: 'skill:review', name: 'review', origins: [ORIGIN] },
        { id: 'skill:unused', name: 'unused', origins: [ORIGIN] },
      ],
      agents: [{ id: 'agent:helper', name: 'helper', origins: [ORIGIN] }],
      tools: [{ serverId: 'github', toolName: 'list_issues', definitionDigest: QUESTION, origins: [ORIGIN] }],
    },
    used: {
      operations: [
        {
          kind: 'mcp',
          subject: 'github/list_issues',
          ok: 1,
          refused: 1,
          error: 0,
          uncertain: 1,
          pending: 0,
          codes: ['argument_out_of_scope'],
        },
      ],
      loadedSkills: [{ skillId: 'skill:review', actor: { kind: 'root' } }],
      delegations: [{ delegationId: 'b'.repeat(64), agentId: 'agent:helper', state: 'failed' }],
    },
    limits: { maxDelegations: 8, delegationDepth: 1 },
    permissions: {
      captured: {
        native: ['mcp_Read'],
        skills: ['skill:review'],
        agents: ['agent:helper'],
        servers: [
          {
            serverId: 'github',
            serverDigest: QUESTION,
            grants: [
              {
                tool: 'list_issues',
                definitionDigest: QUESTION,
                argumentEquals: { repository: { kind: 'value', value: 'owner/repo-a' }, token: { kind: 'withheld' } },
              },
            ],
          },
        ],
      },
      current: {
        kind: 'configured',
        skills: [],
        agents: [],
        servers: [{ serverId: 'github', connection: 'approved_otherwise', grants: [] }],
      },
    },
  };

  test('a command run shows bound versus used, outcomes, limits and both permission sets, as text', () => {
    const html = page({ kind: 'working' }, [], 'live', {}, '0', RETAINED);
    expect(visible(html)).toContain('Skill skill:review (workflows 1.0.0) — loaded');
    expect(visible(html)).toContain('Skill skill:unused (workflows 1.0.0) — not used');
    expect(html).toContain('github / list_issues');
    expect(html).toContain('1 refused');
    expect(html).toContain('1 with an unknown outcome');
    expect(html).toContain('argument out of scope');
    expect(html).toContain('Delegate agent:helper · bbbbbbbb — failed');
    expect(html).toContain('Up to 8 delegations, depth 1');
    expect(html).toContain('(withheld)');
    expect(html).toContain('approved otherwise');
    expect(html).toContain('&lt;b&gt;owner/repo-a&lt;/b&gt;');
    expect(html).not.toContain('<b>owner');
  });

  test('history names the facet a tool came from; goal runs and unreadable retained data are told apart', () => {
    const tool: RunEvent = {
      runId: RUN,
      seq: '1',
      recordedAt: AT,
      kind: 'tool.operation',
      payload: {
        operationId: QUESTION,
        toolName: 'mcp_github_list_issues',
        disposition: { kind: 'started' },
        binding: { kind: 'mcp', serverId: 'github', toolName: 'list_issues', definitionDigest: QUESTION },
      },
    };
    expect(visible(page({ kind: 'working' }, [tool], 'live', {}, '0', RETAINED))).toContain(
      'Tool github / list_issues (workflows 1.0.0): started',
    );
    expect(page({ kind: 'working' }, [], 'live', {}, '0', { kind: 'native', throughSeq: '0' })).not.toContain(
      'Capabilities',
    );
    expect(
      page({ kind: 'working' }, [], 'live', {}, '0', {
        kind: 'unavailable',
        reason: 'snapshot_unreadable',
        throughSeq: '0',
      }),
    ).toContain('cannot be read (snapshot unreadable)');
  });

  test('the installed catalog shows refusals, approval state and inspection only for approved servers', () => {
    const catalog: CatalogView = {
      kind: 'ready',
      catalogRevision: QUESTION,
      contributions: [
        {
          id: 'command:triage',
          kind: 'command',
          name: 'triage',
          description: '<img src=x onerror=alert(1)>',
          origins: [ORIGIN],
          availability: { kind: 'ready', selectionRevision: QUESTION },
          arguments: { required: true },
        },
        {
          id: 'skill:broken',
          kind: 'skill',
          name: 'broken',
          origins: [ORIGIN],
          availability: { kind: 'refused', reason: 'prerequisite_refused', subject: 'skill:absent' },
          allowed: true,
        },
      ],
      servers: [
        {
          serverId: 'github',
          origins: [ORIGIN],
          transport: 'stdio',
          connection: { kind: 'approved', currentDigest: QUESTION },
          grants: [],
        },
        {
          serverId: 'other',
          origins: [ORIGIN],
          transport: 'stdio',
          connection: { kind: 'reapproval_required', currentDigest: 'e'.repeat(64) },
          grants: [],
        },
      ],
    };
    const state: Catalog = {
      state: { kind: 'loaded', catalog },
      load: async () => {},
      replaceServer: () => {},
    };
    const html = renderToStaticMarkup(<InstalledCapabilities client={client} catalog={state} />);
    expect(html).toContain('refused: prerequisite refused (skill:absent)');
    expect(html).toContain('needs approval again');
    expect(html).toContain('e'.repeat(64));
    expect((html.match(/Inspect server/g) ?? []).length).toBe(1);
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).not.toContain('<img');
  });
});
