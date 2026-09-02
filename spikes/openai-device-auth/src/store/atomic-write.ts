// Atomic replacement of a credential file.
//
// The required sequence, in order:
//
//   open(temp, O_WRONLY|O_CREAT|O_EXCL, 0600)   same directory as the target
//   write(...)
//   fsync(temp)                                 before the rename, not after
//   close(temp)
//   rename(temp, target)                        never truncate the live file
//   fsync(directory)                            or the rename can be lost
//
// Two details are easy to get wrong and are therefore explicit here. The mode
// comes from the open(2) argument rather than a follow-up chmod, so there is no
// window in which the file exists world-readable. And the directory fsync is
// not optional: without it the rename is durable only by luck.
//
// Every boundary is a named injection point so the crash matrix can kill the
// process at each one and prove the reader still sees exactly one of the two
// complete states.

import { constants } from "node:fs";
import { mkdir, open, readdir, rename, stat, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { randomBytes } from "node:crypto";

export type WritePoint =
  | "after-temp-create"
  | "mid-write"
  | "before-fsync"
  | "after-fsync"
  | "after-rename"
  | "after-dir-fsync";

export const WRITE_POINTS: readonly WritePoint[] = [
  "after-temp-create",
  "mid-write",
  "before-fsync",
  "after-fsync",
  "after-rename",
  "after-dir-fsync",
];

export type WriteHooks = {
  at?: (point: WritePoint) => void | Promise<void>;
};

export type WriteMode = "atomic" | "truncate-in-place";

const TEMP_SUFFIX = ".tmp";

export function tempPathFor(target: string): string {
  const unique = `${process.pid}.${randomBytes(6).toString("hex")}`;
  return join(dirname(target), `${basename(target)}.${unique}${TEMP_SUFFIX}`);
}

export async function atomicWrite(
  target: string,
  contents: string,
  hooks: WriteHooks = {},
  mode: WriteMode = "atomic",
): Promise<void> {
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });

  if (mode === "truncate-in-place") {
    // The negative control: destroy the live file and write over it. A kill
    // partway through leaves a half-document, which is exactly the failure the
    // atomic path exists to prevent -- so this must be shown to produce it.
    const unsafe = await open(
      target,
      constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC,
      0o600,
    );
    try {
      const bytes = Buffer.from(contents, "utf8");
      await hooks.at?.("after-temp-create");
      const midpoint = Math.floor(bytes.length / 2);
      await unsafe.write(bytes.subarray(0, midpoint));
      await hooks.at?.("mid-write");
      await unsafe.write(bytes.subarray(midpoint));
      await hooks.at?.("before-fsync");
      await unsafe.sync();
      await hooks.at?.("after-fsync");
    } finally {
      await unsafe.close();
    }
    await hooks.at?.("after-rename");
    await hooks.at?.("after-dir-fsync");
    return;
  }

  const temp = tempPathFor(target);
  const handle = await open(
    temp,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
    0o600,
  );

  try {
    await hooks.at?.("after-temp-create");

    const bytes = Buffer.from(contents, "utf8");
    if (hooks.at) {
      // Split the write so a kill can land with the file genuinely partial.
      const midpoint = Math.floor(bytes.length / 2);
      await handle.write(bytes.subarray(0, midpoint));
      await hooks.at("mid-write");
      await handle.write(bytes.subarray(midpoint));
    } else {
      await handle.write(bytes);
    }

    await hooks.at?.("before-fsync");
    await handle.sync();
    await hooks.at?.("after-fsync");
  } finally {
    await handle.close();
  }

  await rename(temp, target);
  await hooks.at?.("after-rename");

  await fsyncDirectory(dirname(target));
  await hooks.at?.("after-dir-fsync");
}

export async function fsyncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * Remove temp files this runtime owns and abandoned by a crash. Deliberately
 * narrow: an unrelated file in the directory, or one owned by another uid, is
 * left alone and reported rather than unlinked.
 */
export async function cleanupOrphanTemps(
  directory: string,
  ownerUid: number,
): Promise<{ removed: string[]; skipped: string[] }> {
  const removed: string[] = [];
  const skipped: string[] = [];

  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch {
    return { removed, skipped };
  }

  for (const entry of entries) {
    if (!entry.endsWith(TEMP_SUFFIX)) continue;
    const full = join(directory, entry);
    try {
      const info = await stat(full);
      if (info.uid !== ownerUid) {
        skipped.push(entry);
        continue;
      }
      await unlink(full);
      removed.push(entry);
    } catch {
      skipped.push(entry);
    }
  }

  return { removed, skipped };
}

export async function listTempFiles(directory: string): Promise<string[]> {
  try {
    return (await readdir(directory)).filter((entry) => entry.endsWith(TEMP_SUFFIX));
  } catch {
    return [];
  }
}
