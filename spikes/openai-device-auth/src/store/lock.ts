// Cross-process advisory locking.
//
// The lock is a real kernel flock(2) on a stable file, obtained by holding a
// `flock(1)` child open for the duration. Two properties come free from that
// choice and both matter:
//
//   * The kernel releases the lock when the holder's descriptors close, so a
//     SIGKILL mid-refresh cannot strand it. There is no lease, no staleness
//     heuristic, and no pid file to go wrong.
//   * The lock file is never unlinked. The classic flock defect is
//     delete-then-recreate, which lets two processes hold locks on two
//     different inodes for the same path; the driver asserts inode stability
//     across the whole run to prove that is not happening here.
//
// Node has no flock binding, and adding a native module would put a compiler
// in the trusted computing base of a spike about credential durability. The
// child holds the descriptor instead.

import { spawn } from "node:child_process";
import { closeSync, openSync, statSync } from "node:fs";

export type FileLock = {
  path: string;
  inode: number;
  release: () => Promise<void>;
};

export type LockOptions = {
  timeoutMs: number;
  /** Disabled for the negative control that proves the lock is load-bearing. */
  enabled?: boolean;
};

export class LockTimeoutError extends Error {
  constructor(path: string, timeoutMs: number) {
    super(`timed out after ${timeoutMs}ms waiting for ${path}`);
    this.name = "LockTimeoutError";
  }
}

export function ensureLockFile(path: string): number {
  const fd = openSync(path, "a", 0o600);
  try {
    return statSync(path).ino;
  } finally {
    closeSync(fd);
  }
}

export async function acquireLock(path: string, options: LockOptions): Promise<FileLock> {
  const inode = ensureLockFile(path);

  if (options.enabled === false) {
    return { path, inode, release: async () => {} };
  }

  const timeoutSeconds = Math.max(1, Math.ceil(options.timeoutMs / 1000));

  const child = spawn(
    "flock",
    ["--exclusive", "--timeout", String(timeoutSeconds), path, "sh", "-c", HOLD_SCRIPT],
    { stdio: ["pipe", "pipe", "pipe"] },
  );

  const acquired = await new Promise<boolean>((resolve, reject) => {
    let settled = false;

    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    child.stdout.once("data", (chunk: Buffer) => {
      if (chunk.includes(READY_BYTE)) finish(true);
    });

    child.once("exit", () => finish(false));

    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
  });

  if (!acquired) {
    child.kill("SIGKILL");
    throw new LockTimeoutError(path, options.timeoutMs);
  }

  let released = false;
  return {
    path,
    inode,
    release: async () => {
      if (released) return;
      released = true;
      await new Promise<void>((resolve) => {
        child.once("exit", () => resolve());
        // Closing the pipe gives the holder EOF; the kernel drops the lock when
        // its descriptor closes. No signal, no race with a half-written file.
        child.stdin.end();
        setTimeout(() => {
          child.kill("SIGKILL");
          resolve();
        }, 5_000).unref();
      });
    },
  };
}

const READY_BYTE = Buffer.from("L");

/**
 * Announce acquisition, then block on stdin. `cat` exits on EOF, which is how
 * the parent releases, and also on parent death, which is how a crash releases.
 */
const HOLD_SCRIPT = "printf L; exec cat >/dev/null";

export function lockFileInode(path: string): number | null {
  try {
    return statSync(path).ino;
  } catch {
    return null;
  }
}
