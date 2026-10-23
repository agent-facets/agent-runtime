// mcp_Search: case-sensitive literal search of workspace text files. No regular expressions, globs or external
// commands: an owned walker applies the workspace policy to every directory and file it visits.
//
// Traversal is depth-first in code-point name order, so results are deterministic. Each file is read and
// checked whole before its matches are kept. The search stops at the first bound it reaches and says so; a
// search that skipped something it should have examined (too large, unreadable, changed) is reported as
// incomplete, so "no matches" is only ever claimed for a complete search.
import { opendir } from 'node:fs/promises';
import { isStorableText, utf8Bytes } from '../domain/text.ts';
import {
  confirmUnchanged,
  openResolvedFile,
  parseToolPath,
  readWholeFile,
  refuse,
  resolvePath,
  ToolProblem,
  throwIfAborted,
} from './filesystem.ts';
import { isExcluded, type WorkspacePolicy } from './policy.ts';
import { compareNames, isListableName } from './read-directory.ts';
import { positiveInteger, type TextFilter } from './read-file.ts';
import { ENVELOPE_RESERVE_BYTES, ResultBudget, type ToolOutcome, toolOutcome } from './results.ts';
import { clipToBytes, decodeText, lineSpans } from './text.ts';

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
  /** Files in scope that could not be searched; any of the first three makes the search incomplete. */
  skipped: { tooLarge: number; unreadable: number; changed: number; notText: number };
}

const EXCERPT_BYTES = 512;
const EXCERPT_CONTEXT_BYTES = 200;
const KEYS = new Set(['query', 'path', 'maxMatches']);

class Stop extends Error {
  constructor(readonly limit: SearchLimit) {
    super(limit);
  }
}

function excerpt(line: string, index: number, query: string): Pick<SearchMatch, 'text' | 'clipped'> {
  if (utf8Bytes(line) <= EXCERPT_BYTES) return { text: line };
  const before = clipToBytes([...line.slice(0, index)].reverse().join(''), EXCERPT_CONTEXT_BYTES);
  const after = clipToBytes(line.slice(index + query.length), EXCERPT_CONTEXT_BYTES);
  return { text: `${[...before].reverse().join('')}${query}${after}`, clipped: true };
}

export function searchWorkspace(
  policy: WorkspacePolicy,
  args: unknown,
  options: { signal?: AbortSignal; filter?: TextFilter } = {},
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
    const filter = options.filter ?? ((text: string) => text);

    const start = await resolvePath(policy, scope, options.signal);
    const budget = new ResultBudget(limits.resultBytes - ENVELOPE_RESERVE_BYTES);
    const matches: SearchMatch[] = [];
    const skipped = { tooLarge: 0, unreadable: 0, changed: 0, notText: 0 };
    let examinedFiles = 0;
    let scannedBytes = 0;
    let rawEntries = 0;
    let directories = 0;

    const searchFile = async (parts: string[]) => {
      throwIfAborted(options.signal);
      if (examinedFiles >= limits.searchFiles) throw new Stop('file_limit');
      examinedFiles++;
      let text: string | undefined;
      try {
        const resolved = await resolvePath(policy, parts, options.signal);
        if (!resolved.leaf.isFile() || resolved.leaf.nlink > 1n) return;
        const size = Number(resolved.leaf.size);
        if (size > limits.fileBytes) {
          skipped.tooLarge++;
          return;
        }
        if (scannedBytes + size > limits.searchBytes) {
          examinedFiles--;
          throw new Stop('scan_byte_limit');
        }
        const { handle, stat } = await openResolvedFile(policy, resolved);
        let bytes: Uint8Array;
        try {
          bytes = await readWholeFile(handle, stat, options.signal);
        } finally {
          await handle.close();
        }
        scannedBytes += bytes.byteLength;
        await confirmUnchanged(policy, resolved);
        text = decodeText(bytes);
      } catch (error) {
        if (!(error instanceof ToolProblem)) throw error;
        if (error.code === 'target_changed') skipped.changed++;
        else if (error.outcome === 'error') skipped.unreadable++;
        return;
      }
      if (text === undefined) {
        skipped.notText++;
        return;
      }
      const path = parts.join('/');
      let lineNumber = 0;
      for (const [begin, end] of lineSpans(text)) {
        lineNumber++;
        const line = text.slice(begin, end);
        const index = line.indexOf(query);
        if (index < 0) continue;
        if (matches.length === maxMatches) throw new Stop('match_limit');
        const match: SearchMatch = { path, line: lineNumber, ...excerpt(line, index, query) };
        match.text = filter(match.text);
        if (!budget.tryAdd(match)) throw new Stop('result_size');
        matches.push(match);
      }
    };

    const searchDirectory = async (parts: string[], depth: number): Promise<void> => {
      throwIfAborted(options.signal);
      if (depth > limits.depth || ++directories > limits.directories) throw new Stop('traversal_limit');
      const resolved = await resolvePath(policy, parts, options.signal).catch((error: unknown) => {
        if (error instanceof ToolProblem) return undefined;
        throw error;
      });
      if (resolved === undefined || !resolved.leaf.isDirectory()) {
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
          const entry = await directory.read();
          if (entry === null) break;
          if (++rawEntries > limits.rawEntries) throw new Stop('traversal_limit');
          const name = entry.name;
          if (!isListableName(name) || isExcluded(policy, [...parts, name])) continue;
          if (filter(name) !== name) continue;
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
        // The walker re-examines each entry through the common path checks before descending or reading.
        const stat = await resolvePath(policy, child, options.signal).catch((error: unknown) => {
          if (error instanceof ToolProblem) return undefined;
          throw error;
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
      complete: limitedBy === undefined && skipped.tooLarge + skipped.unreadable + skipped.changed === 0,
      ...(limitedBy === undefined ? {} : { limitedBy }),
      skipped,
    };
  });
}
