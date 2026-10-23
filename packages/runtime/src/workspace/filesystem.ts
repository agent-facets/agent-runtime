// Path grammar and component-by-component resolution inside the configured workspace root.
//
// A tool path is relative to the root. `..` is refused wherever it appears (before any normalization, so
// `link/../x` cannot hide a symlink), as are absolute, drive, UNC, URL and backslash forms. Empty and `.`
// components are dropped, so `.`, `src/` and `src/./a.ts` are accepted. Every existing component is examined with
// lstat: a symlink anywhere is refused, and each identity is kept so the caller can confirm nothing changed.
import { type BigIntStats, constants, type Dir, type Dirent } from 'node:fs';
import { type FileHandle, lstat, open } from 'node:fs/promises';
import { join } from 'node:path';
import { isStorableText, utf8Bytes } from '../domain/text.ts';
import { type FileIdentity, identityKey, isExcluded, type WorkspacePolicy } from './policy.ts';

export type RefusalCode =
  | 'invalid_path'
  | 'excluded'
  | 'symlink'
  | 'special_file'
  | 'multiply_linked'
  | 'file_too_large'
  | 'not_text'
  | 'target_changed'
  | 'invalid_argument';

export type ErrorCode = 'not_found' | 'not_a_file' | 'not_a_directory' | 'unreadable';

/** A refusal or error that ends one tool call. Messages are application-owned. */
export class ToolProblem extends Error {
  constructor(
    readonly outcome: 'refused' | 'error',
    readonly code: RefusalCode | ErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export const refuse = (code: RefusalCode, message: string) => new ToolProblem('refused', code, message);
const fail = (code: ErrorCode, message: string) => new ToolProblem('error', code, message);

/** Parses a tool path into relative components; `[]` is the workspace root. */
export function parseToolPath(input: unknown, limit: number): string[] {
  if (typeof input !== 'string') throw refuse('invalid_path', 'The path must be a string.');
  if (!isStorableText(input) || /\p{Cc}/u.test(input) || utf8Bytes(input) > limit) {
    throw refuse('invalid_path', 'The path is not a valid workspace path.');
  }
  if (
    input.startsWith('/') ||
    input.startsWith('~') ||
    input.includes('\\') ||
    /^[A-Za-z]:/.test(input) ||
    /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(input)
  ) {
    throw refuse('invalid_path', 'Paths must be relative to the workspace root.');
  }
  const parts = input.split('/');
  if (parts.includes('..')) throw refuse('invalid_path', 'Paths may not contain "..".');
  return parts.filter((part) => part !== '' && part !== '.');
}

export interface ResolvedPath {
  parts: readonly string[];
  absolute: string;
  /** lstat of the root and of each component, in order. */
  chain: readonly BigIntStats[];
  leaf: BigIntStats;
}

const errnoOf = (error: unknown) => (error as { code?: string } | null)?.code;

/**
 * The next entry of an open directory. Bun opens directories lazily, so permission and I/O errors surface on the
 * first read rather than at opendir(); they become an `unreadable` error here instead of escaping raw.
 */
export async function nextEntry(directory: Dir): Promise<Dirent | null> {
  try {
    return await directory.read();
  } catch (error) {
    if (typeof errnoOf(error) === 'string') throw fail('unreadable', 'This directory cannot be read.');
    throw error;
  }
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw signal.reason ?? new DOMException('The operation was aborted.', 'AbortError');
}

function checkIdentity(policy: WorkspacePolicy, stat: BigIntStats): void {
  if (policy.protectedIdentities.has(identityKey(stat))) {
    throw refuse('excluded', 'This location is excluded from workspace access.');
  }
}

/**
 * Resolves a path inside the root, refusing excluded locations before touching them, symlinks anywhere, and
 * anything that is not a directory where one is needed. The leaf must be a regular file or directory.
 */
export async function resolvePath(
  policy: WorkspacePolicy,
  parts: readonly string[],
  signal?: AbortSignal,
): Promise<ResolvedPath> {
  if (isExcluded(policy, parts)) throw refuse('excluded', 'This location is excluded from workspace access.');
  const chain: BigIntStats[] = [];
  let absolute = policy.root;
  for (let index = -1; index < parts.length; index++) {
    throwIfAborted(signal);
    if (index >= 0) absolute = join(absolute, parts[index] as string);
    let stat: BigIntStats;
    try {
      stat = await lstat(absolute, { bigint: true });
    } catch (error) {
      const code = errnoOf(error);
      if (code === 'ENOENT') throw fail('not_found', 'No such file or directory in the workspace.');
      if (code === 'ENOTDIR') throw fail('not_found', 'No such file or directory in the workspace.');
      if (code === 'EACCES' || code === 'EPERM') throw fail('unreadable', 'This location cannot be read.');
      throw fail('unreadable', 'This location cannot be read.');
    }
    if (stat.isSymbolicLink()) throw refuse('symlink', 'Symbolic links are not followed.');
    checkIdentity(policy, stat);
    const isLeaf = index === parts.length - 1;
    if (!isLeaf && !stat.isDirectory()) {
      if (stat.isFile()) throw fail('not_found', 'No such file or directory in the workspace.');
      throw refuse('special_file', 'Only regular files and directories can be read.');
    }
    if (isLeaf && !stat.isFile() && !stat.isDirectory()) {
      throw refuse('special_file', 'Only regular files and directories can be read.');
    }
    chain.push(stat);
  }
  return { parts, absolute, chain, leaf: chain.at(-1) as BigIntStats };
}

const sameIdentity = (a: FileIdentity, b: FileIdentity) => a.dev === b.dev && a.ino === b.ino;

/** Re-examines every component; a replaced component means the earlier checks no longer describe the target. */
export async function confirmUnchanged(policy: WorkspacePolicy, resolved: ResolvedPath): Promise<void> {
  let absolute = policy.root;
  for (let index = -1; index < resolved.parts.length; index++) {
    if (index >= 0) absolute = join(absolute, resolved.parts[index] as string);
    const stat = await lstat(absolute, { bigint: true }).catch(() => undefined);
    const expected = resolved.chain[index + 1] as BigIntStats;
    if (stat === undefined || stat.isSymbolicLink() || !sameIdentity(stat, expected)) {
      throw refuse('target_changed', 'The target changed while it was being read.');
    }
  }
}

/** Opens a resolved regular file without following links, and checks the descriptor is that same file. */
export async function openResolvedFile(
  policy: WorkspacePolicy,
  resolved: ResolvedPath,
): Promise<{ handle: FileHandle; stat: BigIntStats }> {
  let handle: FileHandle;
  try {
    handle = await open(resolved.absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    const code = errnoOf(error);
    if (code === 'ELOOP') throw refuse('symlink', 'Symbolic links are not followed.');
    if (code === 'ENOENT') throw refuse('target_changed', 'The target changed while it was being read.');
    throw fail('unreadable', 'This file cannot be read.');
  }
  try {
    const stat = await handle.stat({ bigint: true });
    if (!stat.isFile()) throw refuse('target_changed', 'The target changed while it was being read.');
    if (!sameIdentity(stat, resolved.leaf))
      throw refuse('target_changed', 'The target changed while it was being read.');
    checkIdentity(policy, stat);
    if (stat.nlink > 1n) throw refuse('multiply_linked', 'Files with multiple hard links are not read.');
    return { handle, stat };
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}

/**
 * Reads exactly the file's recorded size; a size or content-metadata change is reported as a changed target.
 * At most `maxBytes` (at least the recorded size; default one byte more, to notice growth) are read, and every
 * byte read is reported to `onRead`, including bytes later discarded because the file changed.
 */
export async function readWholeFile(
  handle: FileHandle,
  stat: BigIntStats,
  options: { signal?: AbortSignal; maxBytes?: number; onRead?: (bytes: number) => void } = {},
): Promise<Uint8Array> {
  const size = Number(stat.size);
  const capacity = Math.max(size, Math.min(options.maxBytes ?? size + 1, size + 1));
  const buffer = new Uint8Array(capacity);
  let length = 0;
  while (length < capacity) {
    throwIfAborted(options.signal);
    const { bytesRead } = await handle.read(buffer, length, Math.min(65_536, capacity - length), length);
    if (bytesRead === 0) break;
    length += bytesRead;
    options.onRead?.(bytesRead);
  }
  const after = await handle.stat({ bigint: true });
  if (
    length !== size ||
    after.size !== stat.size ||
    after.mtimeNs !== stat.mtimeNs ||
    after.ctimeNs !== stat.ctimeNs ||
    !sameIdentity(after, stat)
  ) {
    throw refuse('target_changed', 'The target changed while it was being read.');
  }
  return buffer.subarray(0, length);
}
