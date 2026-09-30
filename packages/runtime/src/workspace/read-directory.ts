// mcp_Read directory mode: a filtered, name-ordered page of a workspace directory.
//
// Entries are ordered by Unicode code point (equivalently, UTF-8 byte order), independent of locale. The cursor
// is the last name returned, so pages of an unchanged directory neither repeat nor skip entries. Pagination is
// not a snapshot: ordinary edits between calls can change later pages.
//
// Listing reveals names, kinds and file sizes, so it applies the same policy as reading: excluded names,
// symlinks, special files, multiply linked files and protected identities are omitted without trace. Names that
// are not well-formed Unicode are omitted too, because a lossy decoding could name a different file.
import { lstat, opendir } from 'node:fs/promises';
import { join } from 'node:path';
import { isStorableText, utf8Bytes } from '../domain/text.ts';
import { confirmUnchanged, parseToolPath, refuse, resolvePath, ToolProblem, throwIfAborted } from './filesystem.ts';
import { identityKey, isExcluded, type WorkspacePolicy } from './policy.ts';
import { positiveInteger, type TextFilter } from './read-file.ts';
import { ENVELOPE_RESERVE_BYTES, ResultBudget, type ToolOutcome, toolOutcome } from './results.ts';

export interface DirectoryReadRequest {
  path: unknown;
  afterName?: unknown;
  entryLimit?: unknown;
}

export interface DirectoryEntry {
  name: string;
  kind: 'file' | 'directory';
  sizeBytes?: number;
}

export interface DirectoryReadResult {
  mode: 'directory';
  path: string;
  entries: DirectoryEntry[];
  complete: boolean;
  /** Pass as afterName to continue; present only when more entries remain. */
  nextAfterName?: string;
  /**
   * `directory_too_large`: the directory has more entries than one call may examine, so no ordered page could be
   * established; no entries and no cursor are returned rather than a page that could skip names.
   */
  limitedBy?: 'entry_limit' | 'result_size' | 'directory_too_large';
}

/** Code-point order: compares the strings as sequences of Unicode scalar values. */
export function compareNames(a: string, b: string): number {
  const left = a[Symbol.iterator]();
  const right = b[Symbol.iterator]();
  for (;;) {
    const x = left.next();
    const y = right.next();
    if (x.done || y.done) return x.done && y.done ? 0 : x.done ? -1 : 1;
    const difference = (x.value.codePointAt(0) as number) - (y.value.codePointAt(0) as number);
    if (difference !== 0) return difference;
  }
}

export const isListableName = (name: string) =>
  isStorableText(name) && !/[\p{Cc}\uFFFD]/u.test(name) && !name.includes('/') && utf8Bytes(name) <= 255;

function parseAfterName(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value === '' || value === '.' || value === '..' || !isListableName(value)) {
    throw refuse('invalid_argument', 'afterName must be a single entry name from a previous page.');
  }
  return value;
}

export function readDirectory(
  policy: WorkspacePolicy,
  request: DirectoryReadRequest,
  options: { signal?: AbortSignal; filter?: TextFilter } = {},
): Promise<ToolOutcome<DirectoryReadResult>> {
  const { limits } = policy;
  return toolOutcome(limits.resultBytes, async () => {
    const parts = parseToolPath(request.path, limits.pathBytes);
    const afterName = parseAfterName(request.afterName);
    const entryLimit = positiveInteger(request.entryLimit, limits.entriesDefault, limits.entriesMax, 'entryLimit');
    const resolved = await resolvePath(policy, parts, options.signal);
    if (!resolved.leaf.isDirectory()) throw new ToolProblem('error', 'not_a_directory', 'This path is a file.');
    const path = parts.join('/') || '.';

    const candidates: string[] = [];
    let examined = 0;
    const directory = await opendir(resolved.absolute).catch(() => {
      throw new ToolProblem('error', 'unreadable', 'This directory cannot be read.');
    });
    try {
      for (;;) {
        throwIfAborted(options.signal);
        const entry = await directory.read();
        if (entry === null) break;
        if (++examined > limits.rawEntries) {
          return { mode: 'directory', path, entries: [], complete: false, limitedBy: 'directory_too_large' };
        }
        const name = entry.name;
        if (!isListableName(name) || isExcluded(policy, [...parts, name])) continue;
        // A name the secret filter would alter is omitted, never returned rewritten.
        if (options.filter !== undefined && options.filter(name) !== name) continue;
        if (afterName !== undefined && compareNames(name, afterName) <= 0) continue;
        candidates.push(name);
      }
    } finally {
      // Bun's Dir.close() does not always return a promise, so it is not chained.
      try {
        await directory.close();
      } catch {
        // Already closed.
      }
    }
    candidates.sort(compareNames);

    const budget = new ResultBudget(limits.resultBytes - ENVELOPE_RESERVE_BYTES);
    const entries: DirectoryEntry[] = [];
    let limitedBy: DirectoryReadResult['limitedBy'];
    let index = 0;
    for (; index < candidates.length; index++) {
      throwIfAborted(options.signal);
      const name = candidates[index] as string;
      const stat = await lstat(join(resolved.absolute, name), { bigint: true }).catch(() => undefined);
      if (stat === undefined || policy.protectedIdentities.has(identityKey(stat))) continue;
      let entry: DirectoryEntry;
      if (stat.isDirectory()) entry = { name, kind: 'directory' };
      else if (stat.isFile() && stat.nlink === 1n) entry = { name, kind: 'file', sizeBytes: Number(stat.size) };
      else continue;
      if (entries.length === entryLimit) {
        limitedBy = 'entry_limit';
        break;
      }
      if (!budget.tryAdd(entry)) {
        limitedBy = 'result_size';
        break;
      }
      entries.push(entry);
    }
    await confirmUnchanged(policy, resolved);

    const complete = limitedBy === undefined;
    const last = entries.at(-1);
    return {
      mode: 'directory',
      path,
      entries,
      complete,
      ...(!complete && last !== undefined ? { nextAfterName: last.name } : {}),
      ...(limitedBy === undefined ? {} : { limitedBy }),
    };
  });
}
