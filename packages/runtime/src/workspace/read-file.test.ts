import { afterAll, describe, expect, test } from 'bun:test';
import { chmodSync, linkSync, lstatSync, mkdirSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { appendFile, open } from 'node:fs/promises';
import { join } from 'node:path';
import { createFixture } from '../../test-support/workspace.ts';
import { confirmUnchanged, parseToolPath, readWholeFile, resolvePath, ToolProblem } from './filesystem.ts';
import { createWorkspacePolicy } from './policy.ts';
import { readFile } from './read-file.ts';

const fixture = createFixture();
afterAll(() => fixture.cleanup());
const policy = fixture.policy({ excludeNames: ['SECRETS.yaml'], excludePaths: ['ops/keys'] });

async function ok(path: string, extra: Record<string, unknown> = {}) {
  const outcome = await readFile(policy, { path, ...extra });
  if (outcome.outcome !== 'ok') throw new Error(`${path}: ${outcome.outcome} ${outcome.code}`);
  expect(new TextEncoder().encode(JSON.stringify(outcome.result)).byteLength).toBeLessThanOrEqual(65_536);
  return outcome.result;
}
const codeOf = async (path: unknown, extra: Record<string, unknown> = {}, which = policy) => {
  const outcome = await readFile(which, { path, ...extra });
  return outcome.outcome === 'ok' ? 'ok' : `${outcome.outcome}:${outcome.code}`;
};

describe('reading text files', () => {
  test('returns numbered lines with CRLF, BOM and final-newline handling', async () => {
    fixture.write('src/a.txt', '\uFEFFfirst\r\nsecond\n\nfourth\n');
    const result = await ok('src/a.txt');
    expect(result).toEqual({
      mode: 'file',
      path: 'src/a.txt',
      totalLines: 4,
      startLine: 1,
      lines: [
        { line: 1, text: 'first' },
        { line: 2, text: 'second' },
        { line: 3, text: '' },
        { line: 4, text: 'fourth' },
      ],
      complete: true,
    });
    fixture.write('unterminated.txt', 'a\nb');
    expect((await ok('unterminated.txt')).lines.map((line) => line.text)).toEqual(['a', 'b']);
    fixture.write('lone-cr.txt', 'a\rb\n');
    expect((await ok('lone-cr.txt')).lines).toEqual([{ line: 1, text: 'a\rb' }]);
  });

  test('an empty file has no lines, and a start beyond the end is an empty, complete page', async () => {
    fixture.write('empty.txt', '');
    expect(await ok('empty.txt')).toMatchObject({ totalLines: 0, lines: [], complete: true });
    expect(await ok('src/a.txt', { startLine: 99 })).toMatchObject({ totalLines: 4, lines: [], complete: true });
  });

  test('pages by line with a default of 200 and a maximum of 2,000', async () => {
    fixture.write('many.txt', Array.from({ length: 2_500 }, (_, index) => `l${index + 1}`).join('\n'));
    const first = await ok('many.txt');
    expect(first.lines).toHaveLength(200);
    expect(first).toMatchObject({ totalLines: 2_500, complete: false, nextStartLine: 201, limitedBy: 'line_limit' });
    const big = await ok('many.txt', { startLine: 201, lineLimit: 2_000 });
    expect(big.lines).toHaveLength(2_000);
    expect(big.lines[0]).toEqual({ line: 201, text: 'l201' });
    expect(big.nextStartLine).toBe(2_201);
    const last = await ok('many.txt', { startLine: 2_201, lineLimit: 2_000 });
    expect(last.complete).toBe(true);
    expect(last.lines).toHaveLength(300);
    for (const lineLimit of [0, 2_001, 1.5, '10', -1]) {
      expect(await codeOf('many.txt', { lineLimit })).toBe('refused:invalid_argument');
    }
    expect(await codeOf('many.txt', { startLine: 0 })).toBe('refused:invalid_argument');
  });

  test('keeps the complete serialized result within 64 KiB, including escaping and multibyte text', async () => {
    const heavy = ['"\\'.repeat(400), '\u0001\u0002\u0003'.repeat(250), '😀é'.repeat(300), 'x'.repeat(900)];
    for (const [index, line] of heavy.entries()) {
      fixture.write(`heavy-${index}.txt`, Array.from({ length: 500 }, () => line).join('\n'));
      const result = await ok(`heavy-${index}.txt`, { lineLimit: 500 });
      expect(result.limitedBy).toBe('result_size');
      expect(result.lines.length).toBeGreaterThan(0);
      const next = await ok(`heavy-${index}.txt`, { startLine: result.nextStartLine, lineLimit: 500 });
      expect(next.startLine).toBe(result.lines.length + 1);
    }
  });

  test('a single line larger than the result bound is clipped visibly and reading continues after it', async () => {
    fixture.write('long-line.txt', `${'y'.repeat(200_000)}\nafter\n`);
    const first = await ok('long-line.txt');
    expect(first.lines).toHaveLength(1);
    expect(first.lines[0]?.clipped).toBe(true);
    expect(first.nextStartLine).toBe(2);
    expect((await ok('long-line.txt', { startLine: 2 })).lines).toEqual([{ line: 2, text: 'after' }]);
  });

  test('applies the file-size bound exactly', async () => {
    fixture.write('at-limit.txt', 'z'.repeat(1_048_576));
    expect(await codeOf('at-limit.txt')).toBe('ok');
    fixture.write('over-limit.txt', 'z'.repeat(1_048_577));
    expect(await codeOf('over-limit.txt')).toBe('refused:file_too_large');
  });

  test('refuses binary and invalid UTF-8 anywhere in the file, not only in the returned lines', async () => {
    fixture.write('nul.bin', 'text\u0000more');
    expect(await codeOf('nul.bin')).toBe('refused:not_text');
    fixture.write('late-invalid.txt', new Uint8Array([...new TextEncoder().encode('ok\n'.repeat(500)), 0xc3, 0x28]));
    expect(await codeOf('late-invalid.txt')).toBe('refused:not_text');
  });

  test('missing, directory and unreadable targets are identifiable errors', async () => {
    expect(await codeOf('does/not/exist.txt')).toBe('error:not_found');
    expect(await codeOf('src/a.txt/child')).toBe('error:not_found');
    expect(await codeOf('src')).toBe('error:not_a_file');
    if (process.getuid?.() !== 0) {
      const path = fixture.write('locked.txt', 'secret');
      chmodSync(path, 0o000);
      expect(await codeOf('locked.txt')).toBe('error:unreadable');
      chmodSync(path, 0o600);
    }
  });
});

describe('confinement', () => {
  test('refuses absolute, traversal, home, drive, URL, backslash and control-character paths', async () => {
    writeFileSync(join(fixture.outside, 'secret.txt'), 'outside');
    for (const path of [
      '/etc/passwd',
      '../outside/secret.txt',
      'src/../../outside/secret.txt',
      'src/../a.txt',
      '..',
      '~/secret.txt',
      'C:\\secret.txt',
      'C:secret.txt',
      'file:///etc/passwd',
      'src\\a.txt',
      'src/a.txt\u0000',
      'src/\u0007a.txt',
      'a'.repeat(4_097),
      42,
      undefined,
    ]) {
      expect(await codeOf(path)).toBe('refused:invalid_path');
    }
  });

  test('normalizes redundant separators and dot components', () => {
    expect(parseToolPath('./src//a.txt/', 4_096)).toEqual(['src', 'a.txt']);
    expect(parseToolPath('.', 4_096)).toEqual([]);
  });

  test('refuses symlinks as the target or anywhere along the path, even when they stay inside', async () => {
    symlinkSync(join(fixture.outside, 'secret.txt'), join(fixture.root, 'escape.txt'));
    symlinkSync(join(fixture.root, 'src', 'a.txt'), join(fixture.root, 'internal.txt'));
    symlinkSync(fixture.outside, join(fixture.root, 'outside-dir'));
    symlinkSync(join(fixture.root, 'src'), join(fixture.root, 'src-link'));
    symlinkSync(join(fixture.root, 'nowhere'), join(fixture.root, 'broken.txt'));
    for (const path of ['escape.txt', 'internal.txt', 'outside-dir/secret.txt', 'src-link/a.txt', 'broken.txt']) {
      expect(await codeOf(path)).toBe('refused:symlink');
    }
  });

  test('refuses FIFOs without blocking', async () => {
    expect(Bun.spawnSync(['mkfifo', join(fixture.root, 'pipe')]).exitCode).toBe(0);
    expect(await codeOf('pipe')).toBe('refused:special_file');
  });

  test('refuses excluded locations the same way whether or not they exist', async () => {
    fixture.write('.env', 'API_KEY=synthetic');
    fixture.write('.env.example', 'API_KEY=');
    fixture.write('.git/config', '[core]');
    fixture.write('node_modules/pkg/index.js', 'x');
    fixture.write('deploy/tls.pem', 'x');
    fixture.write('home/.ssh/id_ed25519', 'x');
    fixture.write('config/SECRETS.yaml', 'x');
    fixture.write('ops/keys/prod.txt', 'x');
    fixture.write('ops/keys-public/readme.txt', 'fine');
    for (const path of [
      '.env',
      '.env.example',
      '.ENV',
      '.git/config',
      'node_modules/pkg/index.js',
      'deploy/tls.pem',
      'home/.ssh/id_ed25519',
      'config/secrets.yaml',
      'ops/keys/prod.txt',
      '.env.production',
      '.git/missing',
      'ops/keys/missing.txt',
    ]) {
      expect(await codeOf(path)).toBe('refused:excluded');
    }
    expect(await codeOf('ops/keys-public/readme.txt')).toBe('ok');
    const refusal = await readFile(policy, { path: '.env' });
    expect(JSON.stringify(refusal)).not.toContain('synthetic');
    expect(JSON.stringify(refusal)).not.toContain('.env');
  });

  test('refuses hard-linked files and protected runtime identities', async () => {
    const secret = join(fixture.outside, 'credential.json');
    writeFileSync(secret, '{"accessToken":"synthetic"}');
    linkSync(secret, join(fixture.root, 'innocent.json'));
    expect(await codeOf('innocent.json')).toBe('refused:multiply_linked');

    const target = fixture.write('protected.txt', 'runtime-private');
    const stat = lstatSync(target, { bigint: true });
    const guarded = fixture.policy({ protect: [{ dev: stat.dev, ino: stat.ino }] });
    expect(await codeOf('protected.txt', {}, guarded)).toBe('refused:excluded');
    const dir = join(fixture.root, 'mounted-state');
    mkdirSync(dir);
    writeFileSync(join(dir, 'x.txt'), 'x');
    const dirStat = lstatSync(dir, { bigint: true });
    const guardedDir = fixture.policy({ protect: [{ dev: dirStat.dev, ino: dirStat.ino }] });
    expect(await codeOf('mounted-state/x.txt', {}, guardedDir)).toBe('refused:excluded');
  });

  test('detects a component replaced after it was checked', async () => {
    fixture.write('swap/file.txt', 'original');
    const resolved = await resolvePath(policy, ['swap', 'file.txt']);
    fixture.write('swap-new/file.txt', 'replacement');
    renameSync(join(fixture.root, 'swap'), join(fixture.root, 'swap-old'));
    renameSync(join(fixture.root, 'swap-new'), join(fixture.root, 'swap'));
    await expect(confirmUnchanged(policy, resolved)).rejects.toMatchObject({ code: 'target_changed' });
  });

  test('detects a file that grows while it is read', async () => {
    const path = fixture.write('growing.txt', 'start\n');
    const handle = await open(path, 'r');
    try {
      const stat = await handle.stat({ bigint: true });
      await appendFile(path, 'more\n');
      await expect(readWholeFile(handle, stat)).rejects.toBeInstanceOf(ToolProblem);
    } finally {
      await handle.close();
    }
  });

  test('cancellation propagates instead of becoming a tool outcome', async () => {
    const controller = new AbortController();
    controller.abort(new Error('run cancelled'));
    await expect(readFile(policy, { path: 'src/a.txt' }, { signal: controller.signal })).rejects.toThrow(
      'run cancelled',
    );
  });

  test('the policy digest reflects exclusions and limits, not live identities', () => {
    const workspace = { id: 'w', label: 'W', root: '/workspace', excludeNames: [], excludePaths: [] };
    const plain = createWorkspacePolicy(workspace);
    expect(createWorkspacePolicy(workspace, [{ dev: 1n, ino: 2n }]).digest).toBe(plain.digest);
    expect(createWorkspacePolicy({ ...workspace, excludeNames: ['x'] }).digest).not.toBe(plain.digest);
    expect(plain.digest).toMatch(/^[0-9a-f]{64}$/);
  });
});
