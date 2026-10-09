import { describe, expect, test } from 'bun:test';
import type { RuntimeMetadata } from './metadata.ts';
import { type ResolvableItem, resolveReferences } from './resolve.ts';

const runtime = (
  requires: RuntimeMetadata['requires'] = [],
  restrict?: RuntimeMetadata['restrict'],
): RuntimeMetadata => ({
  runtimeVersion: 1,
  requires,
  ...(restrict === undefined ? {} : { restrict }),
});
const item = (
  facet: string,
  kind: ResolvableItem['kind'],
  name: string,
  extra: Partial<ResolvableItem> = {},
): ResolvableItem => ({
  facet,
  kind,
  authoredName: name,
  effectiveName: name,
  runtime: runtime(),
  ...extra,
});
const resolve = (items: ResolvableItem[]) => {
  const results = resolveReferences(items);
  return Object.fromEntries(
    items.map((entry) => [
      `${entry.facet}/${entry.kind}/${entry.authoredName}`,
      results.get(`${entry.facet}\u0000${entry.kind}\u0000${entry.authoredName}`),
    ]),
  );
};

describe('explicit reference resolution', () => {
  test('resolves local and cross-facet references through recorded aliases', () => {
    const results = resolve([
      item('demo', 'command', 'run', {
        runtime: runtime([
          { kind: 'skill', name: 'guide' },
          { kind: 'agent', facet: '@team/tools', name: 'helper' },
          { kind: 'native', name: 'mcp_Search' },
        ]),
      }),
      item('demo', 'skill', 'guide', { effectiveName: 'demo-guide' }),
      item('@team/tools', 'agent', 'helper'),
    ]);
    expect(results['demo/command/run']).toEqual({
      ok: true,
      requires: [
        { kind: 'skill', id: 'skill:demo-guide' },
        { kind: 'agent', id: 'agent:helper' },
        { kind: 'native', name: 'mcp_Search' },
      ],
    });
  });

  test('skills and agents are separate namespaces; a same-named item of the other kind does not satisfy a reference', () => {
    const results = resolve([
      item('demo', 'command', 'run', { runtime: runtime([{ kind: 'agent', name: 'guide' }]) }),
      item('demo', 'skill', 'guide'),
    ]);
    expect(results['demo/command/run']).toEqual({
      ok: false,
      reason: 'prerequisite_missing',
      subject: 'agent:demo/guide',
      fields: ['requires'],
    });
  });

  test('omitted, missing and refused prerequisites refuse only their dependants', () => {
    const results = resolve([
      item('demo', 'command', 'needs-omitted', { runtime: runtime([{ kind: 'skill', name: 'dropped' }]) }),
      item('demo', 'skill', 'dropped', { effectiveName: undefined, runtime: undefined }),
      item('demo', 'command', 'needs-other-facet', {
        runtime: runtime([{ kind: 'skill', facet: 'absent', name: 'x' }]),
      }),
      item('demo', 'command', 'needs-refused', { runtime: runtime([{ kind: 'agent', name: 'broken' }]) }),
      item('demo', 'agent', 'broken', { runtime: undefined }),
      item('demo', 'command', 'chained', { runtime: runtime([{ kind: 'skill', name: 'uses-refused' }]) }),
      item('demo', 'skill', 'uses-refused', { runtime: runtime([{ kind: 'agent', name: 'broken' }]) }),
      item('demo', 'command', 'unrelated'),
    ]);
    expect(results['demo/command/needs-omitted']).toMatchObject({
      ok: false,
      reason: 'prerequisite_omitted',
      subject: 'skill:demo/dropped',
    });
    expect(results['demo/command/needs-other-facet']).toMatchObject({
      ok: false,
      reason: 'prerequisite_missing',
      subject: 'skill:absent/x',
    });
    expect(results['demo/command/needs-refused']).toMatchObject({
      ok: false,
      reason: 'prerequisite_refused',
      subject: 'agent:demo/broken',
    });
    expect(results['demo/skill/uses-refused']).toMatchObject({ ok: false, reason: 'prerequisite_refused' });
    expect(results['demo/command/chained']).toMatchObject({
      ok: false,
      reason: 'prerequisite_refused',
      subject: 'skill:demo/uses-refused',
    });
    expect(results['demo/command/unrelated']).toEqual({ ok: true, requires: [] });
  });

  test('requirement cycles refuse every member and their dependants', () => {
    const results = resolve([
      item('demo', 'skill', 'a', { runtime: runtime([{ kind: 'skill', name: 'b' }]) }),
      item('demo', 'skill', 'b', { runtime: runtime([{ kind: 'skill', name: 'a' }]) }),
      item('demo', 'skill', 'self', { runtime: runtime([{ kind: 'skill', name: 'self' }]) }),
      item('demo', 'command', 'run', { runtime: runtime([{ kind: 'skill', name: 'a' }]) }),
      item('demo', 'skill', 'fine'),
    ]);
    expect(results['demo/skill/a']).toMatchObject({ ok: false, reason: 'requirement_cycle' });
    expect(results['demo/skill/b']).toMatchObject({ ok: false, reason: 'requirement_cycle' });
    expect(results['demo/skill/self']).toMatchObject({ ok: false, reason: 'requirement_cycle' });
    expect(results['demo/command/run']).toMatchObject({ ok: false, reason: 'prerequisite_refused' });
    expect(results['demo/skill/fine']).toMatchObject({ ok: true });
  });

  test('restrictions resolve to effective IDs, can only narrow, and refuse unknown references', () => {
    const results = resolve([
      item('demo', 'command', 'run', {
        runtime: runtime([], {
          native: ['mcp_Read'],
          skills: [{ name: 'guide' }, { name: 'dropped' }],
          agents: [],
          mcp: [],
        }),
      }),
      item('demo', 'command', 'typo', { runtime: runtime([], { skills: [{ name: 'gide' }] }) }),
      item('demo', 'skill', 'guide', { effectiveName: 'team-guide' }),
      item('demo', 'skill', 'dropped', { effectiveName: undefined, runtime: undefined }),
    ]);
    expect(results['demo/command/run']).toEqual({
      ok: true,
      requires: [],
      restrict: { native: ['mcp_Read'], skills: ['skill:team-guide'], agents: [], mcp: [] },
    });
    expect(results['demo/command/typo']).toMatchObject({
      ok: false,
      reason: 'reference_unresolved',
      subject: 'skill:demo/gide',
    });
  });

  test('MCP references are syntax-checked but refused until server provenance can be verified', () => {
    // TODO UPSTREAM-SERVER-PROVENANCE: revisit 9.1; complete 10.1; verify 10.2 (verified server binding).
    const results = resolve([
      item('demo', 'command', 'calls-tool', { runtime: runtime([{ kind: 'mcp', server: 'repo', tool: 'list_prs' }]) }),
      item('demo', 'agent', 'scoped', { runtime: runtime([], { mcp: [{ server: 'repo', tool: 'list_prs' }] }) }),
    ]);
    expect(results['demo/command/calls-tool']).toEqual({
      ok: false,
      reason: 'server_provenance_unavailable',
      subject: 'mcp:repo/list_prs',
      fields: ['requires'],
    });
    expect(results['demo/agent/scoped']).toMatchObject({
      ok: false,
      reason: 'server_provenance_unavailable',
      fields: ['restrict'],
    });
  });
});
