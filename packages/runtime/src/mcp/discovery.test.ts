import { describe, expect, test } from 'bun:test';
import { exactSecretMatcher } from '../credentials/matcher.ts';
import { digestOf } from '../records/canonical.ts';
import { createContentPolicy } from '../security/content-policy.ts';
import { adaptDefinitions, externalToolName } from './adapt.ts';
import { deadline } from './deadline.ts';
import { DISCOVERY_LIMITS, discoverTools, type ListPage } from './discovery.ts';

const SECRET = 'synthetic-mcp-discovery-secret-01';
const policy = createContentPolicy(exactSecretMatcher([SECRET]));
const tool = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  description: `Does ${name}.`,
  inputSchema: { type: 'object', properties: { repository: { type: 'string' } }, required: ['repository'] },
  ...extra,
});
const pages =
  (...listing: { tools: unknown[]; nextCursor?: string }[]): ListPage =>
  async (cursor) => {
    const index = cursor === undefined ? 0 : Number(cursor.slice(1));
    const page = listing[index];
    if (page === undefined) throw new Error('unexpected page');
    return page;
  };
const discover = (listPage: ListPage, ms = 1_000, outer?: AbortSignal) => {
  const limit = deadline(ms, outer);
  return discoverTools({ listPage, limit, policy, ...(outer === undefined ? {} : { outer }) }).finally(() =>
    limit.dispose(),
  );
};

describe('bounded discovery', () => {
  test('follows cursors and keeps supported raw definitions with their digests', async () => {
    const first = tool('list_prs');
    const second = tool('comment', { annotations: { readOnlyHint: false } });
    const result = await discover(pages({ tools: [first], nextCursor: 'c1' }, { tools: [second] }));
    expect(result).toEqual({
      ok: true,
      tools: [
        { name: 'list_prs', status: 'supported', raw: first, definitionDigest: digestOf(first) },
        { name: 'comment', status: 'supported', raw: second, definitionDigest: digestOf(second) },
      ],
    });
  });

  test('a changed definition has a different digest, even when only its schema changes', async () => {
    const changed = tool('list_prs', {
      inputSchema: { type: 'object', properties: { repository: { type: 'string', maxLength: 100 } } },
    });
    const [a, b] = await Promise.all([
      discover(pages({ tools: [tool('list_prs')] })),
      discover(pages({ tools: [changed] })),
    ]);
    if (!a.ok || !b.ok) throw new Error('expected discovery');
    expect(a.tools[0]).toMatchObject({ status: 'supported' });
    expect((a.tools[0] as { definitionDigest: string }).definitionDigest).not.toBe(
      (b.tools[0] as { definitionDigest: string }).definitionDigest,
    );
  });

  test('page, tool, name and cursor bounds refuse the whole listing', async () => {
    const many = Array.from({ length: DISCOVERY_LIMITS.pages + 1 }, (_, index) => ({
      tools: [tool(`t${index}`)],
      nextCursor: `c${index + 1}`,
    }));
    expect(await discover(pages(...many))).toEqual({ ok: false, reason: 'too_many_pages' });
    const wide = { tools: Array.from({ length: 129 }, (_, index) => tool(`t${index}`)) };
    expect(await discover(pages(wide))).toEqual({ ok: false, reason: 'too_many_tools' });
    expect(await discover(pages({ tools: [tool('same'), tool('same')] }))).toEqual({
      ok: false,
      reason: 'listing_invalid',
    });
    expect(await discover(pages({ tools: [tool('a')], nextCursor: 'c0' }))).toEqual({
      ok: false,
      reason: 'listing_invalid',
    });
    expect(await discover(pages({ tools: 'nope' } as never))).toEqual({ ok: false, reason: 'listing_invalid' });
    expect(await discover(pages({ tools: [{ description: 'nameless' }] }))).toEqual({
      ok: false,
      reason: 'listing_invalid',
    });
  });

  test('a stalled server is cut off at the deadline; cancellation is reported as such', async () => {
    const stalled: ListPage = (_cursor, options) =>
      new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(new Error('aborted'))));
    const started = Date.now();
    expect(await discover(stalled, 50)).toEqual({ ok: false, reason: 'discovery_timeout' });
    expect(Date.now() - started).toBeLessThan(1_000);
    const outer = new AbortController();
    const pending = discover(stalled, 5_000, outer.signal);
    outer.abort();
    expect(await pending).toEqual({ ok: false, reason: 'cancelled' });
    const failing: ListPage = async () => {
      throw new Error(`server said ${SECRET}`);
    };
    expect(await discover(failing)).toEqual({ ok: false, reason: 'discovery_failed' });
  });

  test('each tool is judged on its own; a refused tool keeps no text', async () => {
    const big = tool('big', { description: 'x'.repeat(33 * 1024) });
    const result = await discover(
      pages({
        tools: [
          tool('fine'),
          tool('leaky', { description: `Use ${SECRET}` }),
          tool('tasky', { execution: { taskSupport: 'required' } }),
          tool('optional-task', { execution: { taskSupport: 'optional' } }),
          tool('nullable', {
            inputSchema: { type: 'object', properties: { a: { anyOf: [{ type: 'string' }, { type: 'null' }] } } },
          }),
          tool('bad name!'),
          big,
          tool('outputs', { outputSchema: { type: 'array' } }),
        ],
      }),
    );
    if (!result.ok) throw new Error('expected discovery');
    expect(
      result.tools.map((entry) => [entry.name, entry.status === 'supported' ? 'supported' : entry.reason]),
    ).toEqual([
      ['fine', 'supported'],
      ['leaky', 'credential_in_definition'],
      ['tasky', 'task_required'],
      ['optional-task', 'supported'],
      ['nullable', 'schema_type_unsupported'],
      ['bad name!', 'tool_name_unsupported'],
      ['big', 'definition_too_large'],
      ['outputs', 'output_schema_unsupported'],
    ]);
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });
});

describe('model-facing adaptation', () => {
  test('keeps only definition fields, with stable credential-safe names, and leaves raw definitions unchanged', async () => {
    const raw = [tool('list_prs'), { name: 'ping', description: 'Pings.', inputSchema: { type: 'object' } }];
    const before = structuredClone(raw);
    const adapted = await adaptDefinitions('repo-tools', raw);
    if (!adapted.ok) throw new Error(adapted.reason);
    expect(raw).toEqual(before);
    const listPrs = adapted.tools.get('list_prs');
    expect(listPrs?.name).toBe(externalToolName('repo-tools', 'list_prs'));
    expect(listPrs?.name).toMatch(/^mcp_ext_[0-9a-f]{48}$/);
    expect(listPrs?.description).toBe('repo-tools / list_prs: Does list_prs.');
    expect(listPrs?.schema).toMatchObject({ type: 'object', properties: { repository: { type: 'string' } } });
    expect(JSON.parse(JSON.stringify([...adapted.tools.values()]))).toEqual([...adapted.tools.values()]);
    expect(externalToolName('repo-tools', 'list_prs')).not.toBe(externalToolName('other', 'list_prs'));
  });
});
