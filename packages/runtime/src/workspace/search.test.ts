import { afterAll, describe, expect, test } from 'bun:test';
import { chmodSync, linkSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createFixture } from '../../test-support/workspace.ts';
import { type SearchResult, searchWorkspace } from './search.ts';

const fixture = createFixture();
afterAll(() => fixture.cleanup());
const policy = fixture.policy();

async function search(args: Record<string, unknown>, which = policy): Promise<SearchResult> {
  const outcome = await searchWorkspace(which, args);
  if (outcome.outcome !== 'ok') throw new Error(`${outcome.outcome} ${outcome.code}`);
  expect(new TextEncoder().encode(JSON.stringify(outcome.result)).byteLength).toBeLessThanOrEqual(65_536);
  return outcome.result;
}

describe('literal search', () => {
  test('finds case-sensitive literal matches, one per line, in deterministic order', async () => {
    fixture.write('src/b.ts', 'const needle = 1;\nNEEDLE\nneedle needle\n');
    fixture.write('src/a.ts', 'no match\nthe needle is here\n');
    fixture.write('README.md', 'needle.*[regex]? (x)\n');
    const result = await search({ query: 'needle' });
    expect(result.matches).toEqual([
      { path: 'README.md', line: 1, text: 'needle.*[regex]? (x)' },
      { path: 'src/a.ts', line: 2, text: 'the needle is here' },
      { path: 'src/b.ts', line: 1, text: 'const needle = 1;' },
      { path: 'src/b.ts', line: 3, text: 'needle needle' },
    ]);
    expect(result).toMatchObject({ complete: true, examinedFiles: 3 });
    expect((await search({ query: 'needle.*[regex]?' })).matches).toHaveLength(1);
  });

  test('a complete search with no matches says so; scope can be a subtree or a file', async () => {
    expect(await search({ query: 'absent-token' })).toMatchObject({ matches: [], complete: true });
    expect((await search({ query: 'needle', path: 'src' })).matches.map((match) => match.path)).toEqual([
      'src/a.ts',
      'src/b.ts',
      'src/b.ts',
    ]);
    expect((await search({ query: 'needle', path: 'src/a.ts' })).matches).toHaveLength(1);
  });

  test('stops at the match bound without exceeding it and reports it', async () => {
    fixture.write('many/matches.txt', Array.from({ length: 150 }, () => 'hit').join('\n'));
    const result = await search({ query: 'hit', path: 'many' });
    expect(result.matches).toHaveLength(100);
    expect(result).toMatchObject({ complete: false, limitedBy: 'match_limit' });
    expect((await search({ query: 'hit', path: 'many', maxMatches: 5 })).matches).toHaveLength(5);
    fixture.write('exact/matches.txt', Array.from({ length: 100 }, () => 'hit').join('\n'));
    expect(await search({ query: 'hit', path: 'exact' })).toMatchObject({ complete: true });
  });

  test('never enters excluded directories or files and never reports them', async () => {
    fixture.write('.git/config', 'secret-marker');
    fixture.write('node_modules/pkg/index.js', 'secret-marker');
    fixture.write('.env', 'secret-marker');
    fixture.write('certs/server.key', 'secret-marker');
    fixture.write('visible/notes.txt', 'secret-marker visible');
    const result = await search({ query: 'secret-marker' });
    expect(result.matches.map((match) => match.path)).toEqual(['visible/notes.txt']);
    expect(result.complete).toBe(true);
    expect(JSON.stringify(result)).not.toContain('.git');
    const refused = await searchWorkspace(policy, { query: 'x', path: '.git' });
    expect(refused.outcome === 'refused' && refused.code).toBe('excluded');
  });

  test('does not follow symlinked files or subtrees that escape the workspace', async () => {
    mkdirSync(join(fixture.outside, 'tree'));
    writeFileSync(join(fixture.outside, 'tree', 'secret.txt'), 'escape-marker');
    writeFileSync(join(fixture.outside, 'file.txt'), 'escape-marker');
    symlinkSync(join(fixture.outside, 'tree'), join(fixture.root, 'linked-tree'));
    symlinkSync(join(fixture.outside, 'file.txt'), join(fixture.root, 'linked-file.txt'));
    linkSync(join(fixture.outside, 'file.txt'), join(fixture.root, 'hard-linked.txt'));
    const result = await search({ query: 'escape-marker' });
    expect(result.matches).toEqual([]);
    expect(result.complete).toBe(true);
  });

  test('skips binary files, and reports oversized or unreadable files as an incomplete search', async () => {
    fixture.write('bin/data.bin', 'binary-marker\u0000');
    expect(await search({ query: 'binary-marker', path: 'bin' })).toMatchObject({
      matches: [],
      complete: true,
      skipped: { notText: 1 },
    });
    fixture.write('big/huge.txt', `large-marker${'x'.repeat(1_048_577)}`);
    expect(await search({ query: 'large-marker', path: 'big' })).toMatchObject({
      matches: [],
      complete: false,
      skipped: { tooLarge: 1 },
    });
    if (process.getuid?.() !== 0) {
      const path = fixture.write('locked/secret.txt', 'locked-marker');
      chmodSync(path, 0o000);
      expect(await search({ query: 'locked-marker', path: 'locked' })).toMatchObject({
        matches: [],
        complete: false,
        skipped: { unreadable: 1 },
      });
      chmodSync(path, 0o600);
    }
  });

  test('stops at the examined-file bound', async () => {
    const dir = join(fixture.root, 'files');
    mkdirSync(dir);
    for (let index = 0; index < 2_001; index++) writeFileSync(join(dir, `f${String(index).padStart(4, '0')}`), 'x');
    const result = await search({ query: 'nothing-here', path: 'files' });
    expect(result).toMatchObject({ examinedFiles: 2_000, complete: false, limitedBy: 'file_limit', matches: [] });
  }, 30_000);

  test('stops before a file that would exceed the scanned-byte bound', async () => {
    const dir = join(fixture.root, 'bytes');
    mkdirSync(dir);
    const chunk = 'y'.repeat(1_000_000);
    for (let index = 0; index < 17; index++) writeFileSync(join(dir, `part${String(index).padStart(2, '0')}`), chunk);
    const result = await search({ query: 'nothing-here', path: 'bytes' });
    expect(result).toMatchObject({
      examinedFiles: 16,
      scannedBytes: 16_000_000,
      complete: false,
      limitedBy: 'scan_byte_limit',
    });
  }, 30_000);

  test('stops at the traversal bound for deep trees', async () => {
    fixture.write(`${Array.from({ length: 70 }, (_, index) => `d${index}`).join('/')}/leaf.txt`, 'deep-marker');
    const result = await search({ query: 'deep-marker', path: 'd0' });
    expect(result).toMatchObject({ complete: false, limitedBy: 'traversal_limit', matches: [] });
  });

  test('clips long matching lines around the match and keeps the result within 64 KiB', async () => {
    fixture.write('long/line.txt', `${'a'.repeat(5_000)}LONG-MARKER${'b'.repeat(5_000)}`);
    const [match] = (await search({ query: 'LONG-MARKER', path: 'long' })).matches;
    expect(match?.clipped).toBe(true);
    expect(match?.text).toContain('LONG-MARKER');
    expect(new TextEncoder().encode(match?.text).byteLength).toBeLessThanOrEqual(1_024);

    fixture.write('wide/lines.txt', Array.from({ length: 100 }, () => `${'"\\'.repeat(250)}WIDE`).join('\n'));
    const wide = await search({ query: 'WIDE', path: 'wide' });
    expect(wide.limitedBy).toBe('result_size');
    expect(wide.complete).toBe(false);
  });

  test('refuses invalid queries and arguments', async () => {
    for (const args of [
      { query: '' },
      { query: 'a\nb' },
      { query: 'x'.repeat(1_025) },
      { query: 5 },
      { query: 'x', maxMatches: 101 },
      { query: 'x', glob: '*.ts' },
      { query: 'x', regex: true },
    ]) {
      const outcome = await searchWorkspace(policy, args);
      expect(outcome.outcome === 'refused' && outcome.code).toBe('invalid_argument');
    }
    const escaped = await searchWorkspace(policy, { query: 'x', path: '../outside' });
    expect(escaped.outcome === 'refused' && escaped.code).toBe('invalid_path');
  });

  test('applies the secret filter to excerpts', async () => {
    fixture.write('filtered/code.ts', 'token = "sk-live-synthetic" // FILTER-MARKER');
    const outcome = await searchWorkspace(
      policy,
      { query: 'FILTER-MARKER', path: 'filtered' },
      { filter: (text) => text.replaceAll('sk-live-synthetic', '[redacted]') },
    );
    expect(outcome.outcome === 'ok' && outcome.result.matches[0]?.text).toBe('token = "[redacted]" // FILTER-MARKER');
  });

  test('cancellation propagates', async () => {
    const controller = new AbortController();
    controller.abort(new Error('run cancelled'));
    await expect(searchWorkspace(policy, { query: 'x' }, { signal: controller.signal })).rejects.toThrow(
      'run cancelled',
    );
  });
});
