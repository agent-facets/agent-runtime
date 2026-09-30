import { afterAll, describe, expect, test } from 'bun:test';
import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type CredentialRecord, newerRecord } from './record.ts';
import { CredentialStore, CredentialStoreError, WRITE_POINTS, type WritePoint } from './store.ts';

const scratchRoot = mkdtempSync(join(tmpdir(), 'agent-runtime-credentials-'));
afterAll(() => rmSync(scratchRoot, { recursive: true, force: true }));
let counter = 0;

/** A private state directory, like the runtime volume, with the credential root beneath it. */
function freshStore(): CredentialStore {
  const state = join(scratchRoot, `state-${++counter}`);
  mkdirSync(state, { mode: 0o700 });
  return new CredentialStore(join(state, 'credentials'));
}

const NOW = 1_790_000_000_000;
function usable(generation: number, overrides: Partial<Record<string, unknown>> = {}): CredentialRecord {
  return {
    version: 1,
    provider: 'openai',
    authMode: 'subscription',
    slot: 'default',
    generation,
    updatedAtMs: NOW,
    lifecycle: 'usable',
    accessToken: `synthetic-access-${generation}`,
    refreshToken: `synthetic-refresh-${generation}`,
    expiresAtMs: NOW + 3_600_000,
    account: { accountId: 'acct_synthetic' },
    ...overrides,
  } as CredentialRecord;
}

const mode = (path: string) => statSync(path).mode & 0o777;

describe('credential records on disk', () => {
  test('a stored record reads back, including from a fresh store after restart', async () => {
    const store = freshStore();
    expect(await store.read('openai', 'default')).toEqual({ kind: 'missing' });
    await store.replace(usable(1));
    expect(await store.read('openai', 'default')).toEqual({ kind: 'record', record: usable(1) });
    const restarted = new CredentialStore(store.root);
    expect(await restarted.read('openai', 'default')).toEqual({ kind: 'record', record: usable(1) });
  });

  test('directories are 0700 and records 0600', async () => {
    const store = freshStore();
    await store.replace(usable(1));
    expect(mode(store.root)).toBe(0o700);
    expect(mode(store.directoryFor('openai'))).toBe(0o700);
    expect(mode(store.pathFor('openai', 'default'))).toBe(0o600);
  });

  test('a newer generation replaces the record; an equal or older one is refused', async () => {
    const store = freshStore();
    await store.replace(usable(2));
    for (const generation of [1, 2]) {
      await expect(store.replace(usable(generation))).rejects.toMatchObject({ code: 'stale_generation' });
    }
    await store.replace(usable(3));
    const read = await store.read('openai', 'default');
    expect(read.kind === 'record' && read.record.generation).toBe(3);
  });

  test('a rejected credential is stored without token material', async () => {
    const store = freshStore();
    await store.replace(usable(1));
    const rejected = {
      version: 1,
      provider: 'openai',
      authMode: 'subscription',
      slot: 'default',
      generation: 2,
      updatedAtMs: NOW,
      lifecycle: 'reauthorization_required',
      reason: 'refresh_rejected',
    } as CredentialRecord;
    await store.replace(rejected);
    expect(await store.read('openai', 'default')).toEqual({ kind: 'record', record: rejected });
    expect(await Bun.file(store.pathFor('openai', 'default')).text()).not.toContain('synthetic-');
    await expect(
      store.replace({ ...rejected, generation: 3, accessToken: 'x' } as CredentialRecord),
    ).rejects.toMatchObject({
      code: 'invalid_record',
    });
  });

  test('newer generations win over stale in-memory copies', () => {
    expect(newerRecord(usable(4), usable(5)).generation).toBe(5);
    expect(newerRecord(usable(6), usable(5)).generation).toBe(6);
    expect(newerRecord(undefined, usable(1))?.generation).toBe(1);
  });
});

describe('invalid records fail closed', () => {
  const cases: [string, string][] = [
    ['truncated JSON', JSON.stringify(usable(1)).slice(0, 40)],
    ['an empty file', ''],
    ['an unknown field', JSON.stringify({ ...usable(1), apiKey: 'sk-synthetic' })],
    ['an API-key auth mode', JSON.stringify({ ...usable(1), authMode: 'api_key' })],
    ['a newer record version', JSON.stringify({ ...usable(1), version: 2 })],
    ['another slot', JSON.stringify({ ...usable(1), slot: 'other' })],
    ['another provider', JSON.stringify({ ...usable(1), provider: 'anthropic', account: {} })],
    ['expiry in epoch seconds', JSON.stringify({ ...usable(1), expiresAtMs: 1_790_000_000 })],
    ['a non-positive generation', JSON.stringify({ ...usable(1), generation: 0 })],
    ['missing account metadata', JSON.stringify({ ...usable(1), account: {} })],
    ['invalid UTF-8', '\xff\xfe'],
    ['an empty access token', JSON.stringify({ ...usable(1), accessToken: '' })],
    ['a one-character access token', JSON.stringify({ ...usable(1), accessToken: 'a' })],
    ['a 15-character access token', JSON.stringify({ ...usable(1), accessToken: 'a'.repeat(15) })],
    ['a 15-character refresh token', JSON.stringify({ ...usable(1), refreshToken: 'r'.repeat(15) })],
  ];
  for (const [label, contents] of cases) {
    test(label, async () => {
      const store = freshStore();
      await store.ensureDirectories('openai');
      const path = store.pathFor('openai', 'default');
      writeFileSync(path, label === 'invalid UTF-8' ? Buffer.from([0xff, 0xfe]) : contents, { mode: 0o600 });
      expect(await store.read('openai', 'default')).toEqual({ kind: 'invalid' });
      // Reauthorization can repair an invalid record.
      await store.replace(usable(1));
      expect((await store.read('openai', 'default')).kind).toBe('record');
    });
  }

  test('a short token is refused without the stored record being rewritten', async () => {
    const store = freshStore();
    await store.ensureDirectories('openai');
    const path = store.pathFor('openai', 'default');
    const contents = JSON.stringify({ ...usable(1), accessToken: 'a'.repeat(15) });
    writeFileSync(path, contents, { mode: 0o600 });
    expect(await store.read('openai', 'default')).toEqual({ kind: 'invalid' });
    expect(await Bun.file(path).text()).toBe(contents);
    await expect(store.replace(usable(2, { accessToken: 'a'.repeat(15) }))).rejects.toMatchObject({
      code: 'invalid_record',
    });
  });

  test('tokens of exactly 16 characters are admitted', async () => {
    const store = freshStore();
    await store.replace(usable(1, { accessToken: 'a'.repeat(16), refreshToken: 'r'.repeat(16) }));
    expect((await store.read('openai', 'default')).kind).toBe('record');
  });

  test('an oversized record', async () => {
    const store = freshStore();
    await store.ensureDirectories('openai');
    writeFileSync(store.pathFor('openai', 'default'), ' '.repeat(65_537), { mode: 0o600 });
    expect(await store.read('openai', 'default')).toEqual({ kind: 'invalid' });
  });
});

describe('storage that is not private is refused', () => {
  test('loose directory permissions', async () => {
    const store = freshStore();
    await store.replace(usable(1));
    chmodSync(store.directoryFor('openai'), 0o755);
    expect(await store.read('openai', 'default')).toEqual({ kind: 'unsafe' });
    await expect(store.replace(usable(2))).rejects.toMatchObject({ code: 'unsafe_storage' });
    await expect(store.ensureDirectories('openai')).rejects.toBeInstanceOf(CredentialStoreError);
    expect(mode(store.directoryFor('openai'))).toBe(0o755);
  });

  test('loose record permissions', async () => {
    const store = freshStore();
    await store.replace(usable(1));
    chmodSync(store.pathFor('openai', 'default'), 0o644);
    expect(await store.read('openai', 'default')).toEqual({ kind: 'unsafe' });
    await expect(store.replace(usable(2))).rejects.toMatchObject({ code: 'unsafe_storage' });
  });

  test('a symlinked record or directory', async () => {
    const store = freshStore();
    await store.ensureDirectories('openai');
    const elsewhere = join(scratchRoot, `elsewhere-${++counter}.json`);
    writeFileSync(elsewhere, JSON.stringify(usable(1)), { mode: 0o600 });
    symlinkSync(elsewhere, store.pathFor('openai', 'default'));
    expect(await store.read('openai', 'default')).toEqual({ kind: 'unsafe' });

    const linkedRoot = freshStore();
    mkdirSync(linkedRoot.root, { mode: 0o700 });
    const realDir = join(scratchRoot, `real-${++counter}`);
    mkdirSync(realDir, { mode: 0o700 });
    symlinkSync(realDir, linkedRoot.directoryFor('openai'));
    expect(await linkedRoot.read('openai', 'default')).toEqual({ kind: 'unsafe' });
    await expect(linkedRoot.replace(usable(1))).rejects.toMatchObject({ code: 'unsafe_storage' });
  });

  test('a hard-linked record, which rotation would silently leave behind', async () => {
    const store = freshStore();
    await store.replace(usable(1));
    linkSync(store.pathFor('openai', 'default'), join(store.directoryFor('openai'), 'alias'));
    expect(await store.read('openai', 'default')).toEqual({ kind: 'unsafe' });
    await expect(store.replace(usable(2))).rejects.toMatchObject({ code: 'unsafe_storage' });
  });

  test('a FIFO or directory at the record path, without blocking', async () => {
    const store = freshStore();
    await store.ensureDirectories('openai');
    expect(Bun.spawnSync(['mkfifo', '-m', '600', store.pathFor('openai', 'default')]).exitCode).toBe(0);
    expect(await store.read('openai', 'default')).toEqual({ kind: 'unsafe' });

    const other = freshStore();
    await other.ensureDirectories('openai');
    mkdirSync(other.pathFor('openai', 'default'), { mode: 0o700 });
    expect(await other.read('openai', 'default')).toEqual({ kind: 'unsafe' });
  });
});

describe('replacement is atomic and durable', () => {
  test('short writes still produce the complete record', async () => {
    const store = freshStore();
    await store.replace(usable(1), { maxWriteBytes: 7 });
    expect(await store.read('openai', 'default')).toEqual({ kind: 'record', record: usable(1) });
  });

  const beforeRename: WritePoint[] = ['after-temp-create', 'mid-write', 'before-fsync', 'after-fsync'];
  for (const point of beforeRename) {
    test(`a failure at ${point} keeps the old record and leaves no temporary file`, async () => {
      const store = freshStore();
      await store.replace(usable(1));
      const failing = store.replace(usable(2), {
        maxWriteBytes: 16,
        at: (reached) => {
          if (reached === point) throw new Error('injected ENOSPC');
        },
      });
      await expect(failing).rejects.toMatchObject({ code: 'write_failed' });
      expect(await store.read('openai', 'default')).toEqual({ kind: 'record', record: usable(1) });
      expect(readdirSync(store.directoryFor('openai'))).toEqual(['default.json']);
    });
  }

  test('a directory-sync failure after the rename is not acknowledged', async () => {
    const store = freshStore();
    await store.replace(usable(1));
    const failing = store.replace(usable(2), {
      at: (reached) => {
        if (reached === 'after-rename') throw new Error('injected EIO');
      },
    });
    await expect(failing).rejects.toMatchObject({ code: 'write_failed' });
  });

  test('a process killed at any write boundary leaves exactly the old or the new record', async () => {
    const writer = join(import.meta.dir, '..', '..', 'test-support', 'credentials', 'writer.ts');
    for (const point of WRITE_POINTS) {
      const store = freshStore();
      await store.replace(usable(1));
      const child = Bun.spawn(['bun', '--no-env-file', writer, store.root, JSON.stringify(usable(2)), point], {
        stdout: 'pipe',
        stderr: 'inherit',
        env: { PATH: process.env.PATH ?? '' },
      });
      const reader = child.stdout.getReader();
      const { value } = await reader.read();
      expect(new TextDecoder().decode(value)).toBe(`at:${point}\n`);
      child.kill('SIGKILL');
      await child.exited;

      const expected = point === 'after-rename' || point === 'after-dir-fsync' ? usable(2) : usable(1);
      expect(await new CredentialStore(store.root).read('openai', 'default')).toEqual({
        kind: 'record',
        record: expected,
      });
      // An abandoned temporary file is never promoted, and cleanup removes only this slot's temporaries.
      writeFileSync(join(store.directoryFor('openai'), 'unrelated.tmp'), 'x', { mode: 0o600 });
      await store.removeAbandonedTemps('openai', 'default');
      expect(readdirSync(store.directoryFor('openai')).sort()).toEqual(['default.json', 'unrelated.tmp']);
    }
  }, 60_000);
});
