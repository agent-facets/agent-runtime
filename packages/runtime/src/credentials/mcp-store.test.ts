import { afterAll, describe, expect, test } from 'bun:test';
import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpCredentialStore } from './mcp-store.ts';
import type { WritePoint } from './store.ts';

const scratch = mkdtempSync(join(tmpdir(), 'agent-runtime-mcp-credentials-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
let counter = 0;

function freshStore(): McpCredentialStore {
  const state = join(scratch, `state-${++counter}`);
  mkdirSync(state, { mode: 0o700 });
  return McpCredentialStore.forStateDir(state);
}
const VALUE = 'synthetic-mcp-token-0001';
const NEXT = 'synthetic-mcp-token-0002';
const mode = (path: string) => statSync(path).mode & 0o777;

describe('MCP credential slots', () => {
  test('a stored value reads back as present, in 0700/0600 storage', async () => {
    const store = freshStore();
    expect(await store.read('repo-token')).toEqual({ kind: 'missing' });
    await store.replace('repo-token', VALUE);
    expect(await store.read('repo-token')).toEqual({ kind: 'present', value: VALUE });
    expect(mode(store.directory)).toBe(0o700);
    expect(mode(store.pathFor('repo-token'))).toBe(0o600);
    expect(JSON.parse(readFileSync(store.pathFor('repo-token'), 'utf8'))).toEqual({ version: 1, value: VALUE });
    await store.replace('repo-token', NEXT);
    expect(await new McpCredentialStore(store.directory).read('repo-token')).toEqual({ kind: 'present', value: NEXT });
  });

  test('accepts exactly 16 to 16384 printable non-space ASCII characters', async () => {
    const store = freshStore();
    for (const value of ['a'.repeat(16), '~'.repeat(16_384), '!#$%&()*+,-./0:;<=>?@[]^_`{|}~ABCz']) {
      await store.replace('slot', value);
      expect(await store.read('slot')).toEqual({ kind: 'present', value });
    }
    for (const value of [
      'a'.repeat(15),
      'a'.repeat(16_385),
      'has a space in it',
      'tab\there-0000000',
      'line\nbreak-000000',
      'non-ascii-é-000000',
    ]) {
      await expect(store.replace('slot', value)).rejects.toMatchObject({ code: 'invalid_record' });
    }
    expect(await store.read('slot')).toEqual({ kind: 'present', value: '!#$%&()*+,-./0:;<=>?@[]^_`{|}~ABCz' });
  });

  test('a malformed or wrong-version record is unusable, and replacing it is allowed', async () => {
    const store = freshStore();
    await store.replace('slot', VALUE);
    for (const contents of [
      '{',
      JSON.stringify({ version: 2, value: VALUE }),
      JSON.stringify({ version: 1, value: 'short' }),
    ]) {
      writeFileSync(store.pathFor('slot'), contents, { mode: 0o600 });
      expect(await store.read('slot')).toEqual({ kind: 'unusable' });
    }
    await store.replace('slot', NEXT);
    expect(await store.read('slot')).toEqual({ kind: 'present', value: NEXT });
  });

  test('storage that is not private is refused and never repaired or removed', async () => {
    const loose = freshStore();
    await loose.replace('slot', VALUE);
    chmodSync(loose.directory, 0o755);
    expect(await loose.read('slot')).toEqual({ kind: 'unusable' });
    await expect(loose.replace('slot', NEXT)).rejects.toMatchObject({ code: 'unsafe_storage' });
    expect(mode(loose.directory)).toBe(0o755);

    const looseFile = freshStore();
    await looseFile.replace('slot', VALUE);
    chmodSync(looseFile.pathFor('slot'), 0o644);
    expect(await looseFile.read('slot')).toEqual({ kind: 'unusable' });
    await expect(looseFile.replace('slot', NEXT)).rejects.toMatchObject({ code: 'unsafe_storage' });
    expect(mode(looseFile.pathFor('slot'))).toBe(0o644);

    const linked = freshStore();
    await linked.replace('slot', VALUE);
    linkSync(linked.pathFor('slot'), join(linked.directory, 'alias'));
    expect(await linked.read('slot')).toEqual({ kind: 'unusable' });
    await expect(linked.replace('slot', NEXT)).rejects.toMatchObject({ code: 'unsafe_storage' });

    const symlinked = freshStore();
    await symlinked.replace('other', VALUE);
    const elsewhere = join(scratch, `elsewhere-${++counter}.json`);
    writeFileSync(elsewhere, JSON.stringify({ version: 1, value: VALUE }), { mode: 0o600 });
    symlinkSync(elsewhere, symlinked.pathFor('slot'));
    expect(await symlinked.read('slot')).toEqual({ kind: 'unusable' });
    await expect(symlinked.replace('slot', NEXT)).rejects.toMatchObject({ code: 'unsafe_storage' });
    expect(readFileSync(elsewhere, 'utf8')).toContain(VALUE);

    const linkedDir = freshStore();
    const real = join(scratch, `real-${++counter}`);
    mkdirSync(real, { mode: 0o700 });
    symlinkSync(real, linkedDir.directory);
    expect(await linkedDir.read('slot')).toEqual({ kind: 'unusable' });
    await expect(linkedDir.replace('slot', VALUE)).rejects.toMatchObject({ code: 'unsafe_storage' });
    expect(readdirSync(real)).toEqual([]);

    const fifo = freshStore();
    await fifo.replace('other', VALUE);
    expect(Bun.spawnSync(['mkfifo', '-m', '600', fifo.pathFor('slot')]).exitCode).toBe(0);
    expect(await fifo.read('slot')).toEqual({ kind: 'unusable' });
    await expect(fifo.replace('slot', VALUE)).rejects.toMatchObject({ code: 'unsafe_storage' });
  });

  test('an invalid slot name is refused before any path is formed', async () => {
    const store = freshStore();
    for (const slot of ['../escape', 'UPPER', '', 'a/b']) {
      await expect(store.read(slot)).rejects.toMatchObject({ code: 'invalid_record' });
    }
  });

  test('replacement is atomic: a failure before the rename keeps the old value, after it is not acknowledged', async () => {
    for (const point of ['after-temp-create', 'mid-write', 'before-fsync', 'after-fsync'] as WritePoint[]) {
      const store = freshStore();
      await store.replace('slot', VALUE);
      const failing = store.replace('slot', NEXT, {
        maxWriteBytes: 8,
        at: (reached) => {
          if (reached === point) throw new Error('injected');
        },
      });
      await expect(failing).rejects.toMatchObject({ code: 'write_failed' });
      expect(await store.read('slot')).toEqual({ kind: 'present', value: VALUE });
      expect(readdirSync(store.directory)).toEqual(['slot.json']);
    }
    const store = freshStore();
    await store.replace('slot', VALUE);
    await expect(
      store.replace('slot', NEXT, {
        at: (reached) => {
          if (reached === 'after-rename') throw new Error('injected');
        },
      }),
    ).rejects.toMatchObject({ code: 'write_failed' });
  });
});
