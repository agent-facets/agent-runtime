import { afterAll, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CredentialCoordinator,
  type CredentialIssuer,
  type CredentialState,
  type IssuerOutcome,
  REFRESH_MARGIN_MS,
} from './coordinator.ts';
import { acquireProviderLock, CredentialLockError, LOCK_FILE } from './lock.ts';
import type { CredentialRecord } from './record.ts';
import { CredentialStore, type ReadResult } from './store.ts';

const scratchRoot = mkdtempSync(join(tmpdir(), 'agent-runtime-coordination-'));
afterAll(() => rmSync(scratchRoot, { recursive: true, force: true }));
let counter = 0;
const contender = join(import.meta.dir, '..', '..', 'test-support', 'credentials', 'contender.ts');

function freshStore(): CredentialStore {
  const state = join(scratchRoot, `state-${++counter}`);
  mkdirSync(state, { mode: 0o700 });
  return new CredentialStore(join(state, 'credentials'));
}

const NOW = 1_790_000_000_000;
function usable(generation: number, expiresAtMs: number, overrides: Record<string, unknown> = {}): CredentialRecord {
  return {
    version: 1,
    provider: 'openai',
    authMode: 'subscription',
    slot: 'default',
    generation,
    updatedAtMs: NOW,
    lifecycle: 'usable',
    accessToken: `synthetic-access-${generation}-token`,
    refreshToken: `synthetic-refresh-${generation}-token`,
    expiresAtMs,
    account: { accountId: 'acct_synthetic' },
    ...overrides,
  } as CredentialRecord;
}

/** A fake issuer with an independent call witness. */
function fakeIssuer(outcome: (generation: number) => IssuerOutcome | Promise<IssuerOutcome>) {
  const calls: number[] = [];
  const issuer: CredentialIssuer = {
    async refresh(current) {
      calls.push(current.generation);
      return outcome(current.generation);
    },
  };
  return { issuer, calls };
}

/** Synthetic tokens meet the 16-character admission floor. */
const tok = (name: string) => `synthetic-${name}-token`;

const refreshed = (name: string, extra: Record<string, unknown> = {}): IssuerOutcome => ({
  kind: 'refreshed',
  credential: { accessToken: tok(name), expiresAtMs: NOW + 3_600_000, ...extra },
});

function coordinatorFor(store: CredentialStore, issuer: CredentialIssuer, now = NOW) {
  return new CredentialCoordinator({ store, provider: 'openai', slot: 'default', issuer, now: () => now });
}

const generationOf = (state: CredentialState) => (state.kind === 'ready' ? state.credential.generation : state.kind);

function spawnContender(store: CredentialStore, witness: string, args: string[]) {
  const child = Bun.spawn(
    ['bun', '--no-env-file', contender, store.root, ...args.slice(0, 1), witness, ...args.slice(1)],
    {
      stdout: 'pipe',
      stderr: 'inherit',
      env: { PATH: process.env.PATH ?? '' },
    },
  );
  const lines: string[] = [];
  const decoder = new TextDecoder();
  let buffered = '';
  const reading = (async () => {
    for await (const chunk of child.stdout) {
      buffered += decoder.decode(chunk, { stream: true });
      let index = buffered.indexOf('\n');
      while (index >= 0) {
        lines.push(buffered.slice(0, index));
        buffered = buffered.slice(index + 1);
        index = buffered.indexOf('\n');
      }
    }
  })();
  const waitFor = async (predicate: (line: string) => boolean, timeoutMs = 10_000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const line = lines.find(predicate);
      if (line !== undefined) return line;
      await Bun.sleep(10);
    }
    throw new Error('timed out waiting for contender output');
  };
  const result = async () => {
    await child.exited;
    await reading;
    return JSON.parse(lines.at(-1) ?? 'null') as { kind: string; credential?: { generation: number } }[];
  };
  return { child, waitFor, result };
}

const witnessLines = (path: string) =>
  readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line !== '');

describe('refresh within one process', () => {
  test('a usable credential outside the refresh margin is returned without refreshing', async () => {
    const store = freshStore();
    await store.replace(usable(1, NOW + REFRESH_MARGIN_MS + 1));
    const { issuer, calls } = fakeIssuer(() => refreshed('x'));
    expect(generationOf(await coordinatorFor(store, issuer).current())).toBe(1);
    expect(calls).toEqual([]);
  });

  test('refresh begins exactly at the five-minute margin', async () => {
    const store = freshStore();
    await store.replace(usable(1, NOW + REFRESH_MARGIN_MS));
    const { issuer, calls } = fakeIssuer(() => refreshed('new-access'));
    const state = await coordinatorFor(store, issuer).current();
    expect(calls).toEqual([1]);
    expect(state.kind === 'ready' && state.credential.accessToken).toBe(tok('new-access'));
  });

  test('64 concurrent callers share one refresh', async () => {
    const store = freshStore();
    await store.replace(usable(1, NOW));
    const { issuer, calls } = fakeIssuer(async () => {
      await Bun.sleep(50);
      return refreshed('shared');
    });
    const coordinator = coordinatorFor(store, issuer);
    const states = await Promise.all(Array.from({ length: 64 }, () => coordinator.current()));
    expect(calls).toEqual([1]);
    expect(new Set(states.map(generationOf))).toEqual(new Set([2]));
  });

  test('an omitted refresh token or account keeps the stored value; supplied ones replace it together', async () => {
    const store = freshStore();
    await store.replace(usable(1, NOW));
    let next: IssuerOutcome = refreshed('a2');
    const { issuer } = fakeIssuer(() => next);
    const coordinator = coordinatorFor(store, issuer);
    const first = await coordinator.current();
    expect(first.kind === 'ready' && [first.credential.refreshToken, first.credential.account]).toEqual([
      'synthetic-refresh-1-token',
      { accountId: 'acct_synthetic' },
    ]);

    next = refreshed('a3', { refreshToken: tok('r3'), account: { accountId: 'acct_rotated' } });
    const second = await coordinator.refresh({ observedGeneration: 2 });
    expect(second.kind === 'ready' && second.credential).toMatchObject({
      generation: 3,
      accessToken: tok('a3'),
      refreshToken: tok('r3'),
      account: { accountId: 'acct_rotated' },
    });
  });

  test('an invalid supplied refresh token is not written', async () => {
    const store = freshStore();
    await store.replace(usable(1, NOW));
    for (const refreshToken of ['', 'x'.repeat(15), 'has a space in the token', 'x'.repeat(20_000)]) {
      const { issuer } = fakeIssuer(() => refreshed('a2', { refreshToken }));
      expect(await coordinatorFor(store, issuer).current()).toEqual({ kind: 'temporarily_unavailable' });
    }
    const read = await store.read('openai', 'default');
    expect(read.kind === 'record' && read.record.generation).toBe(1);
  });

  test('temporary issuer failure keeps the credential and is not retried automatically', async () => {
    const store = freshStore();
    await store.replace(usable(1, NOW));
    for (const outcome of [
      () => ({ kind: 'unavailable' }) as const,
      () => Promise.reject(new Error('socket hang up')),
    ]) {
      const { issuer, calls } = fakeIssuer(outcome as () => IssuerOutcome);
      expect(await coordinatorFor(store, issuer).current()).toEqual({ kind: 'temporarily_unavailable' });
      expect(calls).toEqual([1]);
    }
    const read = await store.read('openai', 'default');
    expect(read.kind === 'record' && read.record).toEqual(usable(1, NOW));
  });

  test('definitive rejection is recorded once, drops token material and stops refreshing', async () => {
    const store = freshStore();
    await store.replace(usable(1, NOW));
    const { issuer, calls } = fakeIssuer(() => ({ kind: 'rejected', reason: 'invalid_grant' }));
    const coordinator = coordinatorFor(store, issuer);
    expect(await coordinator.current()).toEqual({ kind: 'reauthorization_required' });
    expect(await coordinator.current()).toEqual({ kind: 'reauthorization_required' });
    expect(calls).toEqual([1]);
    const read = await store.read('openai', 'default');
    expect(read.kind === 'record' && read.record).toMatchObject({
      generation: 2,
      lifecycle: 'reauthorization_required',
    });
    expect(readFileSync(store.pathFor('openai', 'default'), 'utf8')).not.toContain('synthetic-access-1');
  });

  test('a delayed rejection of an older generation cannot revoke a newer authorization', async () => {
    const store = freshStore();
    await store.replace(usable(1, NOW + 3_600_000));
    const coordinator = coordinatorFor(store, fakeIssuer(() => refreshed('x')).issuer);
    await coordinator.authorize(async () => ({
      accessToken: tok('login'),
      refreshToken: tok('login-refresh'),
      expiresAtMs: NOW + 3_600_000,
      account: { accountId: 'acct_synthetic' },
    }));
    expect(generationOf(await coordinator.markRejected(1, 'authorization_rejected'))).toBe(2);
    expect(await coordinator.markRejected(2, 'authorization_rejected')).toEqual({ kind: 'reauthorization_required' });
  });

  test('a cancelled waiter stops waiting while the shared refresh completes and is persisted', async () => {
    const store = freshStore();
    await store.replace(usable(1, NOW));
    let finish: () => void = () => {};
    const { issuer, calls } = fakeIssuer(
      () => new Promise<IssuerOutcome>((resolve) => (finish = () => resolve(refreshed('late')))),
    );
    const coordinator = coordinatorFor(store, issuer);
    const controller = new AbortController();
    const abandoned = coordinator.current(controller.signal);
    const patient = coordinator.current();
    await Bun.sleep(50);
    controller.abort(new Error('cancelled'));
    await expect(abandoned).rejects.toThrow('cancelled');
    // The abandoned waiter did not release the shared refresh's lock: it is held until the issuer settles.
    await expect(acquireProviderLock(store, 'openai', { waitMs: 150 })).rejects.toMatchObject({ code: 'lock_busy' });
    finish();
    expect(generationOf(await patient)).toBe(2);
    expect(calls).toEqual([1]);
    const read = await store.read('openai', 'default');
    expect(read.kind === 'record' && read.record.generation).toBe(2);
  });

  test('missing, invalid and unsafe records map to safe states', async () => {
    const { issuer } = fakeIssuer(() => refreshed('x'));
    const missing = freshStore();
    expect(await coordinatorFor(missing, issuer).current()).toEqual({ kind: 'unconfigured' });
    const invalid = freshStore();
    await invalid.ensureDirectories('openai');
    writeFileSync(invalid.pathFor('openai', 'default'), '{"truncated', { mode: 0o600 });
    expect(await coordinatorFor(invalid, issuer).current()).toEqual({ kind: 'reauthorization_required' });
  });
});

describe('cancellation before work starts', () => {
  const lockFile = (store: CredentialStore) => join(store.directoryFor('openai'), LOCK_FILE);
  const aborted = () => {
    const controller = new AbortController();
    controller.abort(new Error('run cancelled'));
    return controller.signal;
  };

  test('a pre-aborted refresh or current() starts no issuer call and takes no lock', async () => {
    const store = freshStore();
    await store.replace(usable(1, NOW));
    const { issuer, calls } = fakeIssuer(() => refreshed('never'));
    const coordinator = coordinatorFor(store, issuer);
    await expect(coordinator.refresh({ signal: aborted() })).rejects.toThrow('run cancelled');
    await expect(coordinator.current(aborted())).rejects.toThrow('run cancelled');
    await Bun.sleep(50);
    expect(calls).toEqual([]);
    expect(existsSync(lockFile(store))).toBe(false);
    const read = await store.read('openai', 'default');
    expect(read.kind === 'record' && read.record.generation).toBe(1);
  });

  test('a caller cancelled while the record is being read starts nothing', async () => {
    const controller = new AbortController();
    class AbortingStore extends CredentialStore {
      override async read(provider: 'anthropic' | 'openai', slot: string): Promise<ReadResult> {
        const result = await super.read(provider, slot);
        controller.abort(new Error('run cancelled'));
        return result;
      }
    }
    const plain = freshStore();
    await plain.replace(usable(1, NOW));
    const store = new AbortingStore(plain.root);
    const { issuer, calls } = fakeIssuer(() => refreshed('never'));
    await expect(coordinatorFor(store, issuer).current(controller.signal)).rejects.toThrow('run cancelled');
    await Bun.sleep(50);
    expect(calls).toEqual([]);
    expect(existsSync(lockFile(store))).toBe(false);
  });

  test('lock acquisition cancelled before or during setup launches no helper and leaks no descriptor', async () => {
    const store = freshStore();
    await store.ensureDirectories('openai');
    let launched = 0;
    const spawned = () => launched++;
    const before = readdirSync('/proc/self/fd').length;
    await expect(acquireProviderLock(store, 'openai', { signal: aborted(), hooks: { spawned } })).rejects.toMatchObject(
      {
        code: 'lock_aborted',
      },
    );
    const controller = new AbortController();
    await expect(
      acquireProviderLock(store, 'openai', {
        signal: controller.signal,
        hooks: { spawned, afterSetup: () => controller.abort() },
      }),
    ).rejects.toMatchObject({ code: 'lock_aborted' });
    expect(launched).toBe(0);
    expect(readdirSync('/proc/self/fd').length).toBe(before);
    const lock = await acquireProviderLock(store, 'openai', { hooks: { spawned } });
    expect(launched).toBe(1);
    await lock.release();
  });
});

describe('the provider lock', () => {
  test('is exclusive across processes and released when its holder dies, without deleting the lock file', async () => {
    const store = freshStore();
    const witness = join(scratchRoot, `witness-${++counter}`);
    writeFileSync(witness, '');
    const holder = spawnContender(store, witness, ['hold']);
    await holder.waitFor((line) => line === 'locked');
    const lockPath = join(store.directoryFor('openai'), LOCK_FILE);
    const inode = statSync(lockPath).ino;

    await expect(acquireProviderLock(store, 'openai', { waitMs: 200 })).rejects.toMatchObject({ code: 'lock_busy' });
    // A paused holder keeps the lock; nothing steals it.
    holder.child.kill('SIGSTOP');
    await expect(acquireProviderLock(store, 'openai', { waitMs: 300 })).rejects.toMatchObject({ code: 'lock_busy' });
    holder.child.kill('SIGCONT');

    holder.child.kill('SIGKILL');
    await holder.child.exited;
    const lock = await acquireProviderLock(store, 'openai', { waitMs: 2_000 });
    expect(lock.inode).toBe(BigInt(inode));
    expect(statSync(lockPath).ino).toBe(inode);
    await lock.release();
  }, 20_000);

  test('stays held by this process after the helper exits, until released', async () => {
    const store = freshStore();
    const lock = await acquireProviderLock(store, 'openai');
    const witness = join(scratchRoot, `witness-${++counter}`);
    writeFileSync(witness, '');
    const contenderProcess = spawnContender(store, witness, ['authorize', '0', '1', '200']);
    expect(await contenderProcess.result()).toEqual([{ kind: 'error:lock_busy' }]);
    await lock.release();
    const again = spawnContender(store, witness, ['authorize', '0', '1', '2000']);
    const [result] = await again.result();
    expect(result?.kind).toBe('ready');
  }, 20_000);

  test('a cancelled acquisition stops waiting promptly and leaks no descriptor', async () => {
    const store = freshStore();
    const held = await acquireProviderLock(store, 'openai');
    const before = readdirSync('/proc/self/fd').length;
    const controller = new AbortController();
    const started = Date.now();
    const waiting = acquireProviderLock(store, 'openai', { waitMs: 10_000, signal: controller.signal });
    setTimeout(() => controller.abort(), 100);
    await expect(waiting).rejects.toBeInstanceOf(CredentialLockError);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(readdirSync('/proc/self/fd').length).toBe(before);
    await held.release();
  });

  test('refuses a lock file that is not private', async () => {
    const store = freshStore();
    await store.ensureDirectories('openai');
    writeFileSync(join(store.directoryFor('openai'), LOCK_FILE), '', { mode: 0o644 });
    await expect(acquireProviderLock(store, 'openai')).rejects.toMatchObject({ code: 'unsafe_storage' });
  });
});

describe('refresh across processes', () => {
  test('two processes with 32 callers each perform exactly one refresh and agree on the result', async () => {
    const store = freshStore();
    await store.replace(usable(1, Date.now()));
    const witness = join(scratchRoot, `witness-${++counter}`);
    writeFileSync(witness, '');
    const processes = [0, 1].map(() => spawnContender(store, witness, ['current', '300', '32']));
    const results = (await Promise.all(processes.map((process) => process.result()))).flat();
    expect(witnessLines(witness)).toHaveLength(1);
    expect(results).toHaveLength(64);
    expect(new Set(results.map((state) => state.credential?.generation))).toEqual(new Set([2]));
    const read = await store.read('openai', 'default');
    expect(read.kind === 'record' && read.record.lifecycle === 'usable' && read.record.refreshToken).toBe(
      'synthetic-refresh-1-token',
    );
  }, 30_000);

  test('a refresh waiting behind a login adopts the login instead of refreshing', async () => {
    const store = freshStore();
    await store.replace(usable(1, Date.now()));
    const witness = join(scratchRoot, `witness-${++counter}`);
    writeFileSync(witness, '');
    const login = spawnContender(store, witness, ['authorize', '400']);
    // The login's issue step runs under the lock; wait until it has started.
    const deadline = Date.now() + 10_000;
    while (witnessLines(witness).length === 0 && Date.now() < deadline) await Bun.sleep(10);
    const refresher = spawnContender(store, witness, ['current', '0', '1', '5000']);
    await login.result();
    const [state] = await refresher.result();
    expect(state?.kind).toBe('ready');
    expect(witnessLines(witness).filter((line) => line.startsWith('refresh'))).toEqual([]);
    const read = await store.read('openai', 'default');
    expect(read.kind === 'record' && read.record.lifecycle === 'usable' && read.record.accessToken).toStartWith(
      'login-access-',
    );
  }, 30_000);

  test('a login waiting behind a refresh is written after it, so the refresh cannot overwrite it', async () => {
    const store = freshStore();
    await store.replace(usable(1, Date.now()));
    const witness = join(scratchRoot, `witness-${++counter}`);
    writeFileSync(witness, '');
    const refresher = spawnContender(store, witness, ['current', '400', '1']);
    const deadline = Date.now() + 10_000;
    while (witnessLines(witness).length === 0 && Date.now() < deadline) await Bun.sleep(10);
    const login = spawnContender(store, witness, ['authorize', '0', '1', '5000']);
    const [refreshState] = await refresher.result();
    const [loginState] = await login.result();
    expect(refreshState?.credential?.generation).toBe(2);
    expect(loginState?.credential?.generation).toBe(3);
    const read = await store.read('openai', 'default');
    expect(read.kind === 'record' && read.record.lifecycle === 'usable' && read.record.accessToken).toStartWith(
      'login-access-',
    );
  }, 30_000);
});
