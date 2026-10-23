import { describe, expect, test } from 'bun:test';
import type { CatalogView, FailureCategory, RunCapabilitiesView, RunEvent, RunState } from '@agent-runtime/contracts';
import { renderToStaticMarkup } from 'react-dom/server';
import { ApiClient } from '../api/client.ts';
import type { Connection } from '../state/sync.ts';
import { RunTimeline } from '../state/timeline.ts';
import { AT, answered, asked, attempt, message, QUESTION, RUN, snapshot, status } from '../test-support/fixtures.ts';
import { type Catalog, InstalledCapabilities } from './Capabilities.tsx';
import { FAILURE_LABELS, STATE_LABELS } from './format.ts';
import { RunPage } from './RunDetail.tsx';

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

  test('a model turn with no text is not listed as an empty entry, but an empty result still is', () => {
    const working = page({ kind: 'working' }, [message(1, ''), message(2, 'Reading.')]);
    expect((working.match(/<li /g) ?? []).length).toBe(1);
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
    expect(html).toContain('Command <code>command:triage</code> selected with arguments:');
    expect(html).toContain('Read the issue.');
    expect(html).toContain('Delegate agent:helper · bbbbbbbb');
    expect(html).toContain('Delegate agent:helper · cccccccc');
    expect(html).toContain('Delegation bbbbbbbb returned a result.');
    expect(html).toContain('Delegation cccccccc was abandoned.');
    // Only the root's final message is the result; a delegate's message never is.
    expect((html.match(/<p class="label">Result<\/p>/g) ?? []).length).toBe(1);
    expect(html).toMatch(/class="message final"><p class="label">Result<\/p><p class="text">Final\.<\/p>/);
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
    expect(html).toContain('Skill <code>skill:review</code> <span class="hint">(workflows 1.0.0)</span> — loaded');
    expect(html).toContain('Skill <code>skill:unused</code> <span class="hint">(workflows 1.0.0)</span> — not used');
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
    expect(page({ kind: 'working' }, [tool], 'live', {}, '0', RETAINED)).toContain(
      '<code>github / list_issues</code><span class="hint"> (workflows 1.0.0)</span>',
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
