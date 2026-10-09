import { describe, expect, test } from 'bun:test';
import { parseArgs, runtimeFacetDir, UsageError } from './cli.ts';

describe('runtime facet tooling arguments', () => {
  test('requires an explicit absolute runtime home that is not the editor home', () => {
    expect(runtimeFacetDir({ FACET_DIR: '/srv/agent-runtime/facet-home/' }, '/home/owner')).toBe(
      '/srv/agent-runtime/facet-home',
    );
    for (const env of [{}, { FACET_DIR: ' ' }, { FACET_DIR: 'relative/home' }, { FACET_DIR: '/home/owner/.facet' }]) {
      expect(() => runtimeFacetDir(env, '/home/owner')).toThrow(UsageError);
    }
  });

  test('accepts only the supported commands and options', () => {
    expect(parseArgs(['seal', '--project', 'deploy/runtime/facets', '--out', '/tmp/x.json'])).toEqual({
      command: 'seal',
      project: 'deploy/runtime/facets',
      out: '/tmp/x.json',
    });
    for (const argv of [[], ['install'], ['check'], ['check', '--out', 'x', '--project', 'p'], ['seal', '--project']]) {
      expect(() => parseArgs(argv)).toThrow(UsageError);
    }
  });
});
