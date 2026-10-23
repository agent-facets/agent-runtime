import { afterAll, describe, expect, test } from 'bun:test';
import { appendFileSync, chmodSync, linkSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createFixture } from '../../test-support/workspace.ts';
import { exactSecretMatcher } from '../credentials/matcher.ts';
import { createContentPolicy, REDACTION } from '../security/content-policy.ts';
import { type SearchBarriers, type SearchResult, searchWorkspace } from './search.ts';

const fixture = createFixture();
afterAll(() => fixture.cleanup());
const policy = fixture.policy();

const LIVE = 'oauth-live-synthetic-0123456789abcdefABCDEF';
const screen = createContentPolicy(exactSecretMatcher([LIVE]));

async function search(
  args: Record<string, unknown>,
  which = policy,
  options: { screen?: typeof screen; barriers?: SearchBarriers } = {},
): Promise<SearchResult> {
  const outcome = await searchWorkspace(which, args, options);
  if (outcome.outcome !== 'ok') throw new Error(`${outcome.outcome} ${outcome.code}`);
  expect(new TextEncoder().encode(JSON.stringify(outcome)).byteLength).toBeLessThanOrEqual(65_536);
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

  test('cancellation propagates', async () => {
    const controller = new AbortController();
    controller.abort(new Error('run cancelled'));
    await expect(searchWorkspace(policy, { query: 'x' }, { signal: controller.signal })).rejects.toThrow(
      'run cancelled',
    );
  });
});

describe('screened search', () => {
  test('a credential crossing either excerpt edge is masked whole, never cut', async () => {
    const long = LIVE.repeat(1).padEnd(LIVE.length, 'x');
    fixture.write('screened/before.txt', `${'a'.repeat(300)}${long}${'b'.repeat(150)}EDGE-MARKER${'c'.repeat(600)}`);
    fixture.write('screened/after.txt', `${'a'.repeat(600)}EDGE-MARKER${'b'.repeat(180)}${long}${'c'.repeat(600)}`);
    const unscreened = await search({ query: 'EDGE-MARKER', path: 'screened' });
    // Unscreened, each excerpt edge falls inside the credential, exposing part of it.
    expect(
      unscreened.matches.every(
        (match) => match.text.includes(LIVE.slice(-10)) || match.text.includes(LIVE.slice(0, 10)),
      ),
    ).toBe(true);
    const result = await search({ query: 'EDGE-MARKER', path: 'screened' }, policy, { screen });
    expect(result.matches).toHaveLength(2);
    for (const match of result.matches) {
      expect(match.text).toContain('EDGE-MARKER');
      for (let start = 0; start + 8 <= LIVE.length; start++)
        expect(match.text).not.toContain(LIVE.slice(start, start + 8));
    }
  });

  test('replacement before the match does not shift the excerpt', async () => {
    fixture.write('screened/shift/code.ts', `token = "${LIVE}" // SHIFT-MARKER here`);
    const result = await search({ query: 'SHIFT-MARKER', path: 'screened/shift' }, policy, { screen });
    expect(result.matches).toEqual([
      { path: 'screened/shift/code.ts', line: 1, text: `token = "${REDACTION}" // SHIFT-MARKER here` },
    ]);
    expect(result.complete).toBe(true);
  });

  test('a query found only inside protected material is withheld and makes the search incomplete', async () => {
    fixture.write('screened/inside/a.txt', `prefix ${LIVE} suffix\n`);
    const inside = LIVE.slice(5, 25);
    const result = await search({ query: inside, path: 'screened/inside' }, policy, { screen });
    expect(result).toMatchObject({ matches: [], complete: false, skipped: { withheld: 1 } });
    expect(JSON.stringify(result.matches)).not.toContain(inside);
  });

  test('a line with a clean occurrence is still reported when another occurrence is protected', async () => {
    const inside = LIVE.slice(5, 25);
    fixture.write('screened/mixed/a.txt', `${LIVE} and plain ${inside}`);
    const result = await search({ query: inside, path: 'screened/mixed' }, policy, { screen });
    expect(result.matches).toEqual([
      { path: 'screened/mixed/a.txt', line: 1, text: `${REDACTION} and plain ${inside}` },
    ]);
    expect(result.complete).toBe(true);
  });

  test('redaction markers never manufacture matches', async () => {
    fixture.write('screened/markers/a.txt', `secret ${LIVE}\n`);
    const result = await search({ query: 'redacted credential', path: 'screened/markers' }, policy, { screen });
    expect(result).toMatchObject({ matches: [], complete: true });
  });

  test('a hit inside a private-key body is withheld, and later lines keep their numbers', async () => {
    fixture.write(
      'screened/pem/notes.md',
      [
        'KEYWORD before',
        '-----BEGIN PRIVATE KEY-----',
        'KEYWORDbody',
        '-----END PRIVATE KEY-----',
        'KEYWORD after',
      ].join('\n'),
    );
    const result = await search({ query: 'KEYWORD', path: 'screened/pem' }, policy, { screen });
    expect(result.matches.map((match) => [match.line, match.text])).toEqual([
      [1, 'KEYWORD before'],
      [5, 'KEYWORD after'],
    ]);
    expect(result).toMatchObject({ complete: false, skipped: { withheld: 1 } });
  });

  test('a query containing protected material is refused', async () => {
    const outcome = await searchWorkspace(policy, { query: `x${LIVE}` }, { screen });
    expect(outcome.outcome === 'refused' && outcome.code).toBe('invalid_argument');
  });
});

describe('scan accounting under ordinary changes', () => {
  test('a file that grows past the file bound between resolution and opening is not read', async () => {
    const path = fixture.write('changes/grow/a.txt', 'small GROW-MARKER');
    const result = await search({ query: 'GROW-MARKER', path: 'changes/grow' }, policy, {
      barriers: { beforeOpen: () => appendFileSync(path, 'z'.repeat(1_048_577)) },
    });
    expect(result).toMatchObject({ matches: [], complete: false, scannedBytes: 0, skipped: { tooLarge: 1 } });
  });

  test('bytes read before a change is noticed still count toward the scan bound', async () => {
    const path = fixture.write('changes/during/a.txt', 'x'.repeat(10_000));
    const result = await search({ query: 'nothing-here', path: 'changes/during' }, policy, {
      barriers: { afterOpen: () => appendFileSync(path, 'y'.repeat(100)) },
    });
    expect(result).toMatchObject({ complete: false, skipped: { changed: 1 } });
    expect(result.scannedBytes).toBeGreaterThan(0);
  });

  test('a candidate that disappears after listing makes the search incomplete', async () => {
    const path = fixture.write('changes/vanish/b.txt', 'VANISH-MARKER');
    fixture.write('changes/vanish/a.txt', 'nothing');
    const result = await search({ query: 'VANISH-MARKER', path: 'changes/vanish' }, policy, {
      barriers: { beforeEntry: (entry) => (entry.endsWith('b.txt') ? rmSync(path) : undefined) },
    });
    expect(result).toMatchObject({ matches: [], complete: false, skipped: { changed: 1 } });
  });

  test('a subdirectory that becomes unreadable is reported, not silently skipped', async () => {
    if (process.getuid?.() === 0) return;
    const dir = join(fixture.root, 'changes', 'locked-dir');
    fixture.write('changes/locked-dir/inner/a.txt', 'LOCKED-MARKER');
    chmodSync(join(dir, 'inner'), 0o000);
    try {
      const result = await search({ query: 'LOCKED-MARKER', path: 'changes/locked-dir' });
      expect(result).toMatchObject({ matches: [], complete: false, skipped: { unreadable: 1 } });
    } finally {
      chmodSync(join(dir, 'inner'), 0o700);
    }
  });
});
