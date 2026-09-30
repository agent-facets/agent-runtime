import { afterAll, describe, expect, test } from 'bun:test';
import { linkSync, mkdirSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createFixture } from '../../test-support/workspace.ts';
import { readWorkspace } from './read.ts';
import { compareNames, type DirectoryReadResult, readDirectory } from './read-directory.ts';

const fixture = createFixture();
afterAll(() => fixture.cleanup());
const policy = fixture.policy({ excludeNames: ['private.md'] });

async function list(path: string, extra: Record<string, unknown> = {}, which = policy): Promise<DirectoryReadResult> {
  const outcome = await readDirectory(which, { path, ...extra });
  if (outcome.outcome !== 'ok') throw new Error(`${outcome.outcome} ${outcome.code}`);
  expect(new TextEncoder().encode(JSON.stringify(outcome.result)).byteLength).toBeLessThanOrEqual(65_536);
  return outcome.result;
}
const names = (result: DirectoryReadResult) => result.entries.map((entry) => entry.name);

describe('directory listings', () => {
  test('lists the root with ".", in code-point order, with kinds and file sizes', async () => {
    fixture.write('b.txt', '12345');
    fixture.write('A.txt', '');
    fixture.write('a/inner.txt', 'x');
    fixture.write('é.txt', 'x');
    fixture.write('😀.txt', 'x');
    fixture.write('\uFFEE.txt', 'x');
    const result = await list('.');
    expect(result.path).toBe('.');
    expect(names(result)).toEqual(['A.txt', 'a', 'b.txt', 'é.txt', '\uFFEE.txt', '😀.txt']);
    expect(result.entries.find((entry) => entry.name === 'b.txt')).toEqual({
      name: 'b.txt',
      kind: 'file',
      sizeBytes: 5,
    });
    expect(result.entries.find((entry) => entry.name === 'a')).toEqual({ name: 'a', kind: 'directory' });
    expect(result).toMatchObject({ complete: true });
  });

  test('the comparator orders by code point, not UTF-16 unit', () => {
    expect(compareNames('\uFFEE', '😀')).toBeLessThan(0);
    expect('\uFFEE' < '😀').toBe(false);
    expect(compareNames('a', 'ab')).toBeLessThan(0);
    expect(compareNames('x', 'x')).toBe(0);
  });

  test('omits excluded, linked, special and unrepresentable entries without trace', async () => {
    const dir = 'mixed';
    fixture.write(`${dir}/visible.txt`, 'ok');
    fixture.write(`${dir}/.env`, 'SECRET=1');
    fixture.write(`${dir}/.git/HEAD`, 'ref');
    fixture.write(`${dir}/key.pem`, 'x');
    fixture.write(`${dir}/private.md`, 'x');
    symlinkSync(join(fixture.outside), join(fixture.root, dir, 'link-out'));
    symlinkSync(join(fixture.root, dir, 'visible.txt'), join(fixture.root, dir, 'link-in'));
    writeFileSync(join(fixture.outside, 'secret.json'), '{"token":"synthetic"}');
    linkSync(join(fixture.outside, 'secret.json'), join(fixture.root, dir, 'innocent.json'));
    expect(Bun.spawnSync(['mkfifo', join(fixture.root, dir, 'pipe')]).exitCode).toBe(0);
    writeFileSync(
      Buffer.concat([Buffer.from(`${join(fixture.root, dir)}/`), Buffer.from([0x62, 0x61, 0x64, 0xff])]),
      'x',
    );
    const result = await list(dir);
    expect(names(result)).toEqual(['visible.txt']);
    const serialized = JSON.stringify(result);
    for (const hidden of ['.env', '.git', 'key.pem', 'private.md', 'link', 'innocent', 'pipe', 'bad']) {
      expect(serialized).not.toContain(hidden);
    }
  });

  test('pages with a default of 200 and a maximum of 2,000, continuing after the last returned name', async () => {
    const dir = 'paged';
    mkdirSync(join(fixture.root, dir));
    for (let index = 0; index < 2_345; index++) {
      writeFileSync(join(fixture.root, dir, `f${String(index).padStart(5, '0')}`), '');
    }
    const first = await list(dir);
    expect(first.entries).toHaveLength(200);
    expect(first).toMatchObject({ complete: false, limitedBy: 'entry_limit', nextAfterName: 'f00199' });

    const seen: string[] = [];
    let afterName: string | undefined;
    for (;;) {
      const page = await list(dir, { entryLimit: 2_000, ...(afterName === undefined ? {} : { afterName }) });
      seen.push(...names(page));
      if (page.complete) break;
      expect(page.nextAfterName).toBe(names(page).at(-1));
      afterName = page.nextAfterName;
    }
    expect(seen).toHaveLength(2_345);
    expect(new Set(seen).size).toBe(2_345);
    expect(seen).toEqual([...seen].sort(compareNames));

    for (const entryLimit of [0, 2_001, 'many']) {
      const outcome = await readDirectory(policy, { path: dir, entryLimit });
      expect(outcome.outcome === 'refused' && outcome.code).toBe('invalid_argument');
    }
  });

  test('a cursor naming a deleted entry still makes progress; edits between pages are visible', async () => {
    const dir = 'moving';
    for (const name of ['a', 'b', 'c', 'd']) fixture.write(`${dir}/${name}`, '');
    const first = await list(dir, { entryLimit: 2 });
    expect(names(first)).toEqual(['a', 'b']);
    unlinkSync(join(fixture.root, dir, 'b'));
    fixture.write(`${dir}/bb`, '');
    fixture.write(`${dir}/0`, '');
    const second = await list(dir, { afterName: first.nextAfterName });
    expect(names(second)).toEqual(['bb', 'c', 'd']);
  });

  test('the result-size bound ends a page at a whole entry', async () => {
    const dir = 'long-names';
    mkdirSync(join(fixture.root, dir));
    for (let index = 0; index < 500; index++) {
      writeFileSync(join(fixture.root, dir, `${'n'.repeat(240)}${String(index).padStart(4, '0')}`), '');
    }
    const page = await list(dir, { entryLimit: 2_000 });
    expect(page.limitedBy).toBe('result_size');
    expect(page.nextAfterName).toBe(names(page).at(-1));
    const next = await list(dir, { entryLimit: 2_000, afterName: page.nextAfterName });
    expect(names(next)[0] && compareNames(names(next)[0] as string, page.nextAfterName as string)).toBeGreaterThan(0);
  });

  test('a directory too large to order within one call returns no page and no cursor', async () => {
    const dir = 'huge';
    mkdirSync(join(fixture.root, dir));
    for (let index = 0; index < 20_001; index++) writeFileSync(join(fixture.root, dir, `e${index}`), '');
    const result = await list(dir);
    expect(result).toEqual({
      mode: 'directory',
      path: dir,
      entries: [],
      complete: false,
      limitedBy: 'directory_too_large',
    });
  }, 30_000);

  test('refuses excluded and linked directories, files, and a replaced directory', async () => {
    const codes = async (path: string) => {
      const outcome = await readDirectory(policy, { path });
      return outcome.outcome === 'ok' ? 'ok' : `${outcome.outcome}:${outcome.code}`;
    };
    fixture.write('.git/objects/x', 'x');
    expect(await codes('.git')).toBe('refused:excluded');
    expect(await codes('mixed/link-out')).toBe('refused:symlink');
    expect(await codes('b.txt')).toBe('error:not_a_directory');
    expect(await codes('absent')).toBe('error:not_found');
    expect(await codes('../outside')).toBe('refused:invalid_path');
  });

  test('omits names the secret filter would change, rather than returning them rewritten', async () => {
    fixture.write('filtered/plain.txt', '');
    fixture.write('filtered/sk-live-synthetic.txt', '');
    const filter = (text: string) => text.replaceAll('sk-live-synthetic', '[redacted]');
    const outcome = await readDirectory(policy, { path: 'filtered' }, { filter });
    expect(outcome.outcome === 'ok' && names(outcome.result)).toEqual(['plain.txt']);
  });

  test('mcp_Read dispatches by mode and refuses unknown arguments', async () => {
    expect((await readWorkspace(policy, { mode: 'directory', path: '.' })).outcome).toBe('ok');
    expect((await readWorkspace(policy, { mode: 'file', path: 'b.txt' })).outcome).toBe('ok');
    for (const args of [
      { mode: 'file', path: 'b.txt', afterName: 'x' },
      { mode: 'directory', path: '.', startLine: 1 },
      { mode: 'write', path: 'b.txt', content: 'x' },
      { path: 'b.txt' },
      null,
      'b.txt',
    ]) {
      const outcome = await readWorkspace(policy, args);
      expect(outcome.outcome === 'refused' && outcome.code).toBe('invalid_argument');
    }
  });

  test('refuses a directory replaced while it is listed', async () => {
    fixture.write('swap/one', '');
    const { resolvePath, confirmUnchanged } = await import('./filesystem.ts');
    const resolved = await resolvePath(policy, ['swap']);
    renameSync(join(fixture.root, 'swap'), join(fixture.root, 'swap-old'));
    fixture.write('swap/two', '');
    await expect(confirmUnchanged(policy, resolved)).rejects.toMatchObject({ code: 'target_changed' });
  });
});
