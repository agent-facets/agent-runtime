// mcp_Read: one tool, two modes. Arguments are checked strictly; an unknown argument is refused rather than
// ignored, so a model cannot believe it has used an option that does not exist.
import { refuse } from './filesystem.ts';
import type { WorkspacePolicy } from './policy.ts';
import type { ContentScreen } from './projection.ts';
import { type DirectoryReadResult, readDirectory } from './read-directory.ts';
import { type FileReadResult, readFile } from './read-file.ts';
import { type ToolOutcome, toolOutcome } from './results.ts';

const FILE_KEYS = new Set(['mode', 'path', 'startLine', 'lineLimit']);
const DIRECTORY_KEYS = new Set(['mode', 'path', 'afterName', 'entryLimit']);

export function readWorkspace(
  policy: WorkspacePolicy,
  args: unknown,
  options: { signal?: AbortSignal; screen?: ContentScreen } = {},
): Promise<ToolOutcome<FileReadResult | DirectoryReadResult>> {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    return toolOutcome(policy.limits.resultBytes, async () => {
      throw refuse('invalid_argument', 'Arguments must be an object.');
    });
  }
  const input = args as Record<string, unknown>;
  const allowed = input.mode === 'file' ? FILE_KEYS : input.mode === 'directory' ? DIRECTORY_KEYS : undefined;
  if (allowed === undefined || Object.keys(input).some((key) => !allowed.has(key))) {
    return toolOutcome(policy.limits.resultBytes, async () => {
      throw refuse('invalid_argument', 'mode must be "file" or "directory", with only that mode\u2019s arguments.');
    });
  }
  return input.mode === 'file'
    ? readFile(policy, input as never, options)
    : readDirectory(policy, input as never, options);
}
