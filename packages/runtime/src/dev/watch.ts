// Development only. Which file changes restart the backend. The scope is an explicit allowlist of backend source,
// so console edits (handled by live reload), tests, generated output, dependencies and runtime state never do.
// It is deliberately wider than the execution-code manifest: any backend change restarts the process, while only
// changes inside that manifest can make a waiting run's continuation unavailable.
import { sep } from 'node:path';

/** Repository-relative source directories whose changes restart the backend. */
export const BACKEND_SOURCE_DIRS = [
  'packages/runtime/src',
  'packages/contracts/src',
  'packages/anthropic-subscription/src',
] as const;

const SOURCE_EXTENSION = /\.(?:ts|tsx|js|mjs|cjs|json)$/;
const TEST_FILE = /\.test\.(?:ts|tsx)$/;
/** Editor and tool leftovers: hidden files, backups, swap and temporary files. */
const EDITOR_NOISE = /(?:^|\/)(?:\.[^/]*|[^/]*~|[^/]*\.sw[a-p]|[^/]*\.tmp|4913)$/;
const EXCLUDED_SEGMENT = /(?:^|\/)(?:node_modules|dist|\.turbo|test-support)(?:\/|$)/;

/** Whether a repository-relative path is backend source whose change restarts the backend. */
export function isBackendSource(path: string): boolean {
  const normalized = path.split(sep).join('/');
  if (!BACKEND_SOURCE_DIRS.some((dir) => normalized.startsWith(`${dir}/`))) return false;
  if (EXCLUDED_SEGMENT.test(normalized) || EDITOR_NOISE.test(normalized)) return false;
  return SOURCE_EXTENSION.test(normalized) && !TEST_FILE.test(normalized);
}
