// mcp_Read file mode: numbered UTF-8 lines from one workspace file.
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
import type { WorkspacePolicy } from './policy.ts';
import { type ContentScreen, NO_SCREEN, projectLines } from './projection.ts';
import { ENVELOPE_RESERVE_BYTES, largestFitting, ResultBudget, type ToolOutcome, toolOutcome } from './results.ts';
import { decodeText } from './text.ts';

export interface FileReadRequest {
  path: unknown;
  startLine?: unknown;
  lineLimit?: unknown;
}

export interface FileLine {
  line: number;
  text: string;
  /** Present when this line alone exceeded the result bound; the rest of the line is not returned. */
  clipped?: true;
}

export interface FileReadResult {
  mode: 'file';
  path: string;
  totalLines: number;
  startLine: number;
  lines: FileLine[];
  /** True when the returned lines reach the end of the file. */
  complete: boolean;
  /** Where the next page starts, when lines remain. */
  nextStartLine?: number;
  limitedBy?: 'line_limit' | 'result_size';
}

export function positiveInteger(value: unknown, fallback: number, max: number, name: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > max) {
    throw refuse('invalid_argument', `${name} must be a whole number from 1 to ${max}.`);
  }
  return value;
}

export function readFile(
  policy: WorkspacePolicy,
  request: FileReadRequest,
  options: { signal?: AbortSignal; screen?: ContentScreen } = {},
): Promise<ToolOutcome<FileReadResult>> {
  const { limits } = policy;
  return toolOutcome(limits.resultBytes, async () => {
    const parts = parseToolPath(request.path, limits.pathBytes);
    const startLine = positiveInteger(request.startLine, 1, Number.MAX_SAFE_INTEGER, 'startLine');
    const lineLimit = positiveInteger(request.lineLimit, limits.readLinesDefault, limits.readLinesMax, 'lineLimit');
    const resolved = await resolvePath(policy, parts, options.signal);
    if (!resolved.leaf.isFile()) throw new ToolProblem('error', 'not_a_file', 'This path is a directory.');
    if (resolved.leaf.nlink > 1n) throw refuse('multiply_linked', 'Files with multiple hard links are not read.');
    if (resolved.leaf.size > BigInt(limits.fileBytes)) {
      throw refuse('file_too_large', `Files larger than ${limits.fileBytes} bytes are not read.`);
    }

    const { handle, stat } = await openResolvedFile(policy, resolved);
    let bytes: Uint8Array;
    try {
      if (stat.size > BigInt(limits.fileBytes)) {
        throw refuse('file_too_large', `Files larger than ${limits.fileBytes} bytes are not read.`);
      }
      bytes = await readWholeFile(handle, stat, { signal: options.signal });
    } finally {
      await handle.close();
    }
    await confirmUnchanged(policy, resolved);
    throwIfAborted(options.signal);

    const text = decodeText(bytes);
    if (text === undefined) throw refuse('not_text', 'This file is not UTF-8 text.');

    // Protected material is located in the whole file before any line is selected or clipped.
    const screen = options.screen ?? NO_SCREEN;
    const spans = screen.spans(text);
    const budget = new ResultBudget(limits.resultBytes - ENVELOPE_RESERVE_BYTES);
    const lines: FileLine[] = [];
    let totalLines = 0;
    let nextStartLine: number | undefined;
    let limitedBy: FileReadResult['limitedBy'];
    for (const projected of projectLines(text, spans, screen.marker)) {
      totalLines++;
      if (totalLines < startLine || nextStartLine !== undefined) continue;
      if (lines.length === lineLimit) {
        nextStartLine = totalLines;
        limitedBy = 'line_limit';
        continue;
      }
      const entry: FileLine = { line: totalLines, text: projected.text };
      if (budget.tryAdd(entry)) {
        lines.push(entry);
        continue;
      }
      if (lines.length === 0) {
        // A single line larger than the whole budget: return the longest prefix whose serialized entry fits
        // (escaping included), marked as clipped, and continue after it.
        const remaining = budget.remaining;
        const prefix = largestFitting(
          entry.text,
          (candidate) => ResultBudget.costOf({ line: totalLines, text: candidate, clipped: true }) <= remaining,
        );
        const clipped: FileLine = { line: totalLines, text: prefix, clipped: true };
        if (budget.tryAdd(clipped)) lines.push(clipped);
        nextStartLine = totalLines + 1;
      } else {
        nextStartLine = totalLines;
      }
      limitedBy = 'result_size';
    }
    if (nextStartLine !== undefined && nextStartLine > totalLines) nextStartLine = undefined;
    return {
      mode: 'file',
      path: parts.join('/'),
      totalLines,
      startLine,
      lines,
      complete: nextStartLine === undefined,
      ...(nextStartLine === undefined ? {} : { nextStartLine }),
      ...(limitedBy === undefined ? {} : { limitedBy }),
    };
  });
}
