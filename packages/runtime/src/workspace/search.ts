// mcp_Search: case-sensitive literal search of workspace text files. No regular expressions, globs or external
// commands: an owned walker applies the workspace policy to every directory and file it visits.
//
// Traversal is depth-first in code-point name order, so results are deterministic. Each file is read and
// checked whole before its matches are kept. The search stops at the first bound it reaches and says so; a
// search that skipped something it should have examined (too large, unreadable, changed) is reported as
// incomplete, so "no matches" is only ever claimed for a complete search.
//
// Protected material (credentials) is located over each complete file before any excerpt is made. Matching runs
// against the original text outside protected spans, never against redaction markers; an occurrence that touches
// protected material is withheld and makes the search incomplete rather than silently absent.
import type { Dirent } from 'node:fs';
import { opendir } from 'node:fs/promises';
import { isStorableText, utf8Bytes } from '../domain/text.ts';
import {
  confirmUnchanged,
  nextEntry,
  openResolvedFile,
  parseToolPath,
  readWholeFile,
  refuse,
  resolvePath,
  ToolProblem,
  throwIfAborted,
} from './filesystem.ts';
import { isExcluded, type WorkspacePolicy } from './policy.ts';
import { type ContentScreen, intersects, NO_SCREEN, projectLines, renderedOffset } from './projection.ts';
import { compareNames, isListableName } from './read-directory.ts';
import { positiveInteger } from './read-file.ts';
import { ENVELOPE_RESERVE_BYTES, ResultBudget, type ToolOutcome, toolOutcome } from './results.ts';
import { clipToBytes, decodeText } from './text.ts';

export interface SearchRequest {
  query: unknown;
  path?: unknown;
  maxMatches?: unknown;
}

export interface SearchMatch {
  path: string;
  line: number;
  text: string;
  /** The line was longer than an excerpt; `text` is the part around the first occurrence. */
  clipped?: true;
}

export type SearchLimit = 'match_limit' | 'file_limit' | 'scan_byte_limit' | 'result_size' | 'traversal_limit';

export interface SearchResult {
  query: string;
  path: string;
  matches: SearchMatch[];
  examinedFiles: number;
  scannedBytes: number;
  /** True only when every eligible text file in scope was searched. */
  complete: boolean;
  limitedBy?: SearchLimit;
  /**
   * What could not be searched. Everything except `notText` makes the search incomplete: `withheld` counts lines
   * whose only occurrences touch protected material.
   */
  skipped: { tooLarge: number; unreadable: number; changed: number; notText: number; withheld: number };
}

/** Test instrumentation: deterministic points at which a test may change the tree. */
export interface SearchBarriers {
  beforeOpen?: (path: string) => void | Promise<void>;
  afterOpen?: (path: string) => void | Promise<void>;
  beforeEntry?: (path: string) => void | Promise<void>;
}

const EXCERPT_BYTES = 512;
const EXCERPT_CONTEXT_BYTES = 200;
const KEYS = new Set(['query', 'path', 'maxMatches']);

class Stop extends Error {
  constructor(readonly limit: SearchLimit) {
    super(limit);
  }
}

/** An excerpt of a rendered (already screened) line around the match at `index` of length `length`. */
function excerpt(line: string, index: number, length: number): Pick<SearchMatch, 'text' | 'clipped'> {
  if (utf8Bytes(line) <= EXCERPT_BYTES) return { text: line };
  const before = clipToBytes([...line.slice(0, index)].reverse().join(''), EXCERPT_CONTEXT_BYTES);
  const after = clipToBytes(line.slice(index + length), EXCERPT_CONTEXT_BYTES);
  return { text: `${[...before].reverse().join('')}${line.slice(index, index + length)}${after}`, clipped: true };
}

type Skipped = SearchResult['skipped'];

/** Policy refusals are intentional exclusions; anything else means an eligible file went unsearched. */
function recordProblem(skipped: Skipped, problem: ToolProblem): void {
  if (['excluded', 'symlink', 'special_file', 'multiply_linked'].includes(problem.code)) return;
  if (problem.code === 'unreadable') skipped.unreadable++;
  else if (problem.code === 'file_too_large') skipped.tooLarge++;
  else skipped.changed++;
}

export function searchWorkspace(
  policy: WorkspacePolicy,
  args: unknown,
  options: { signal?: AbortSignal; screen?: ContentScreen; barriers?: SearchBarriers } = {},
): Promise<ToolOutcome<SearchResult>> {
  const { limits } = policy;
  return toolOutcome(limits.resultBytes, async () => {
    if (typeof args !== 'object' || args === null || Array.isArray(args)) {
      throw refuse('invalid_argument', 'Arguments must be an object.');
    }
    const request = args as SearchRequest & Record<string, unknown>;
    if (Object.keys(request).some((key) => !KEYS.has(key))) {
      throw refuse('invalid_argument', 'Only query, path and maxMatches are accepted.');
    }
    const query = request.query;
    if (
      typeof query !== 'string' ||
      query === '' ||
      /[\r\n]/.test(query) ||
      !isStorableText(query) ||
      utf8Bytes(query) > limits.searchQueryBytes
    ) {
      throw refuse(
        'invalid_argument',
        `query must be non-empty single-line text of at most ${limits.searchQueryBytes} bytes.`,
      );
    }
    const scope = parseToolPath(request.path ?? '.', limits.pathBytes);
    const maxMatches = positiveInteger(request.maxMatches, limits.searchMatches, limits.searchMatches, 'maxMatches');
    const screen = options.screen ?? NO_SCREEN;
    if (screen.spans(query).length > 0) throw refuse('invalid_argument', 'The query contains protected material.');
    const barriers = options.barriers ?? {};

    const start = await resolvePath(policy, scope, options.signal);
    const budget = new ResultBudget(limits.resultBytes - ENVELOPE_RESERVE_BYTES);
    const matches: SearchMatch[] = [];
    const skipped: Skipped = { tooLarge: 0, unreadable: 0, changed: 0, notText: 0, withheld: 0 };
    let examinedFiles = 0;
    let scannedBytes = 0;
    let rawEntries = 0;
    let directories = 0;

    const searchFile = async (parts: string[]) => {
      throwIfAborted(options.signal);
      if (examinedFiles >= limits.searchFiles) throw new Stop('file_limit');
      examinedFiles++;
      const path = parts.join('/');
      let text: string | undefined;
      try {
        const resolved = await resolvePath(policy, parts, options.signal);
        if (!resolved.leaf.isFile()) {
          skipped.changed++;
          return;
        }
        if (resolved.leaf.nlink > 1n) return;
        if (Number(resolved.leaf.size) > limits.fileBytes) {
          skipped.tooLarge++;
          return;
        }
        await barriers.beforeOpen?.(path);
        const { handle, stat } = await openResolvedFile(policy, resolved);
        let bytes: Uint8Array;
        try {
          await barriers.afterOpen?.(path);
          // The descriptor's size is what will be read; the earlier path check may be stale.
          const size = Number(stat.size);
          if (size > limits.fileBytes) {
            skipped.tooLarge++;
            return;
          }
          const remaining = limits.searchBytes - scannedBytes;
          if (size > remaining) {
            examinedFiles--;
            throw new Stop('scan_byte_limit');
          }
          bytes = await readWholeFile(handle, stat, {
            signal: options.signal,
            maxBytes: Math.min(size + 1, remaining),
            onRead: (count) => {
              scannedBytes += count;
            },
          });
        } finally {
          await handle.close();
        }
        await confirmUnchanged(policy, resolved);
        text = decodeText(bytes);
      } catch (error) {
        if (!(error instanceof ToolProblem)) throw error;
        recordProblem(skipped, error);
        return;
      }
      if (text === undefined) {
        skipped.notText++;
        return;
      }
      for (const line of projectLines(text, screen.spans(text), screen.marker)) {
        let clean = -1;
        let touched = false;
        for (let index = line.original.indexOf(query); index >= 0; index = line.original.indexOf(query, index + 1)) {
          if (intersects(index, index + query.length, line.protectedRanges)) touched = true;
          else {
            clean = index;
            break;
          }
        }
        if (clean < 0) {
          if (touched) skipped.withheld++;
          continue;
        }
        if (matches.length === maxMatches) throw new Stop('match_limit');
        const at = renderedOffset(clean, line.protectedRanges, screen.marker);
        const match: SearchMatch = { path, line: line.number, ...excerpt(line.text, at, query.length) };
        if (!budget.tryAdd(match)) throw new Stop('result_size');
        matches.push(match);
      }
    };

    const searchDirectory = async (parts: string[], depth: number): Promise<void> => {
      throwIfAborted(options.signal);
      if (depth > limits.depth || ++directories > limits.directories) throw new Stop('traversal_limit');
      const resolved = await resolvePath(policy, parts, options.signal).catch((error: unknown) => {
        if (!(error instanceof ToolProblem)) throw error;
        recordProblem(skipped, error);
        return null;
      });
      if (resolved === null) return;
      if (!resolved.leaf.isDirectory()) {
        skipped.changed++;
        return;
      }
      const names: string[] = [];
      let directory: Awaited<ReturnType<typeof opendir>>;
      try {
        directory = await opendir(resolved.absolute);
      } catch {
        skipped.unreadable++;
        return;
      }
      try {
        for (;;) {
          throwIfAborted(options.signal);
          let entry: Dirent | null;
          try {
            entry = await nextEntry(directory);
          } catch (error) {
            if (!(error instanceof ToolProblem)) throw error;
            skipped.unreadable++;
            return;
          }
          if (entry === null) break;
          if (++rawEntries > limits.rawEntries) throw new Stop('traversal_limit');
          const name = entry.name;
          if (!isListableName(name) || isExcluded(policy, [...parts, name])) continue;
          if (screen.spans(name).length > 0) continue;
          if (entry.isSymbolicLink() || !(entry.isFile() || entry.isDirectory())) continue;
          names.push(name);
        }
      } finally {
        try {
          await directory.close();
        } catch {
          // Already closed.
        }
      }
      names.sort(compareNames);
      for (const name of names) {
        const child = [...parts, name];
        await barriers.beforeEntry?.(child.join('/'));
        // The walker re-examines each entry through the common path checks before descending or reading. An entry
        // that disappeared or became unreadable was eligible, so it makes the search incomplete.
        const stat = await resolvePath(policy, child, options.signal).catch((error: unknown) => {
          if (!(error instanceof ToolProblem)) throw error;
          recordProblem(skipped, error);
          return undefined;
        });
        if (stat === undefined) continue;
        if (stat.leaf.isDirectory()) await searchDirectory(child, depth + 1);
        else await searchFile(child);
      }
    };

    let limitedBy: SearchLimit | undefined;
    try {
      if (start.leaf.isDirectory()) await searchDirectory([...scope], 0);
      else await searchFile([...scope]);
    } catch (error) {
      if (!(error instanceof Stop)) throw error;
      limitedBy = error.limit;
    }
    return {
      query,
      path: scope.join('/') || '.',
      matches,
      examinedFiles,
      scannedBytes,
      complete:
        limitedBy === undefined && skipped.tooLarge + skipped.unreadable + skipped.changed + skipped.withheld === 0,
      ...(limitedBy === undefined ? {} : { limitedBy }),
      skipped,
    };
  });
}
