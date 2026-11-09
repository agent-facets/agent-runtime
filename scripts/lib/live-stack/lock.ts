// One management operation at a time: a kernel flock(2) on a permanent lock file, held through this process's own
// descriptor (the pattern of packages/runtime/src/credentials/lock.ts). The kernel releases it when this process
// exits, so there is no PID file to go stale and nothing ever deletes the lock file.
import { constants, existsSync } from 'node:fs';
import { open } from 'node:fs/promises';

export interface Lock {
  release(): Promise<void>;
}

export type AcquireLock = (path: string) => Promise<Lock>;

export class LockBusyError extends Error {
  override readonly name = 'LockBusyError';
}

const BUSY_EXIT = 75;

export const acquireFileLock: AcquireLock = async (path) => {
  const flock = ['/usr/bin/flock', '/bin/flock'].find((candidate) => existsSync(candidate)) ?? Bun.which('flock');
  if (flock === null || flock === undefined) throw new Error('the flock command is not installed');
  const handle = await open(path, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  let held = false;
  try {
    const child = Bun.spawn([flock, '--exclusive', '--nonblock', '--conflict-exit-code', String(BUSY_EXIT), '3'], {
      stdio: ['ignore', 'ignore', 'ignore', handle.fd],
      env: {},
    });
    const code = await child.exited;
    if (code === BUSY_EXIT) throw new LockBusyError('another live:stack operation is running; try again when it ends');
    if (code !== 0) throw new Error('the management lock could not be taken');
    held = true;
    return { release: () => handle.close() };
  } finally {
    if (!held) await handle.close().catch(() => {});
  }
};
