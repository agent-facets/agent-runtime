// Cross-process exclusion for one provider's credentials, shared by the runtime and operator auth commands.
//
// This is a kernel flock(2) on a permanent lock file, held by *this* process: Bun opens the lock file, passes
// that descriptor to a short-lived `flock` helper (fixed argv, no shell) as its fd 3, and the helper locks the
// shared open file description and exits. The lock then belongs to the descriptor Bun still holds, so:
//   - it lasts exactly as long as this process keeps the descriptor open (release closes it);
//   - if this process dies, the kernel releases it: no lease, no PID file, no staleness heuristic, no stealing;
//   - a paused holder keeps it.
// The lock file is never unlinked or replaced, so every process locks the same inode.
import { constants, existsSync } from 'node:fs';
import { type FileHandle, lstat, open } from 'node:fs/promises';
import { join } from 'node:path';
import type { Provider } from '../records/schemas.ts';
import type { CredentialStore } from './store.ts';

export const LOCK_FILE = '.lock';
export const DEFAULT_LOCK_WAIT_MS = 5_000;
/** Exit status the helper uses when the lock stayed busy for the whole wait. */
const BUSY_EXIT = 75;

export type LockErrorCode = 'lock_busy' | 'lock_aborted' | 'lock_unavailable' | 'unsafe_storage';

export class CredentialLockError extends Error {
  override readonly name = 'CredentialLockError';
  constructor(
    readonly code: LockErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface ProviderLock {
  readonly inode: bigint;
  /** Closes the descriptor, which releases the kernel lock. Idempotent. */
  release(): Promise<void>;
}

let flockPath: string | undefined;
function helper(): string {
  flockPath ??= ['/usr/bin/flock', '/bin/flock'].find((path) => existsSync(path)) ?? Bun.which('flock') ?? '';
  if (flockPath === '') throw new CredentialLockError('lock_unavailable', 'the flock helper is not installed');
  return flockPath;
}

const uid = () => process.getuid?.() ?? -1;

/** Test instrumentation: a point after local setup, and a witness of each helper launch. */
export interface LockHooks {
  afterSetup?: () => void | Promise<void>;
  spawned?: () => void;
}

export async function acquireProviderLock(
  store: CredentialStore,
  provider: Provider,
  options: { waitMs?: number; signal?: AbortSignal; hooks?: LockHooks } = {},
): Promise<ProviderLock> {
  const cancelled = () => new CredentialLockError('lock_aborted', 'lock acquisition was cancelled');
  if (options.signal?.aborted) throw cancelled();
  await store.ensureDirectories(provider);
  if (options.signal?.aborted) throw cancelled();
  const path = join(store.directoryFor(provider), LOCK_FILE);
  let handle: FileHandle;
  try {
    handle = await open(path, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  } catch {
    throw new CredentialLockError('unsafe_storage', 'the credential lock file could not be opened safely');
  }
  let held = false;
  try {
    const stat = await handle.stat({ bigint: true });
    if (!stat.isFile() || Number(stat.uid) !== uid() || (Number(stat.mode) & 0o077) !== 0 || stat.nlink !== 1n) {
      throw new CredentialLockError('unsafe_storage', 'the credential lock file is not private');
    }
    await options.hooks?.afterSetup?.();
    // Rechecked immediately before the helper starts: a caller cancelled during setup launches nothing.
    if (options.signal?.aborted) throw cancelled();
    const waitSeconds = ((options.waitMs ?? DEFAULT_LOCK_WAIT_MS) / 1000).toFixed(3);
    const child = Bun.spawn(
      [helper(), '--exclusive', '--wait', waitSeconds, '--conflict-exit-code', String(BUSY_EXIT), '3'],
      { stdio: ['ignore', 'ignore', 'ignore', handle.fd], env: {} },
    );
    options.hooks?.spawned?.();
    const abort = () => child.kill('SIGKILL');
    options.signal?.addEventListener('abort', abort, { once: true });
    let exitCode: number;
    try {
      exitCode = await child.exited;
    } finally {
      options.signal?.removeEventListener('abort', abort);
    }
    if (options.signal?.aborted) throw cancelled();
    if (exitCode === BUSY_EXIT) throw new CredentialLockError('lock_busy', 'the credential lock is held elsewhere');
    if (exitCode !== 0) throw new CredentialLockError('lock_unavailable', 'the credential lock could not be taken');

    // The path must still name the locked inode; a replaced lock file would split exclusion.
    const current = await lstat(path, { bigint: true }).catch(() => undefined);
    if (current?.ino !== stat.ino || current.dev !== stat.dev) {
      throw new CredentialLockError('unsafe_storage', 'the credential lock file was replaced');
    }
    held = true;
    let released = false;
    return {
      inode: stat.ino,
      async release() {
        if (released) return;
        released = true;
        await handle.close();
      },
    };
  } finally {
    // On any failure the descriptor is closed, which also drops a lock the helper may have taken just before
    // it was killed.
    if (!held) await handle.close().catch(() => {});
  }
}
