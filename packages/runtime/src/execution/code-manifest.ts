// The execution-code manifest: which source, and which exact package bytes, make up the behavior a paused run
// depends on (Decision 7). It covers the owned import closure of explicit execution roots — agent assembly,
// middleware, tools, invocation, operation and run-transition logic, saved-state inspection — with each file's
// content digest (line endings normalized), plus version and integrity for every package that closure uses,
// transitively. Browser code, unrelated modules, tests and the whole-repository lockfile are deliberately not
// inputs, so a change there does not refuse a waiting run.
//
// The application image ships only bundled output, so the manifest is written at build time beside the bundle
// and read from there; running from source computes it directly.
import { readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

export const CODE_MANIFEST_FILE = 'execution-manifest.json';
export const CODE_MANIFEST_VERSION = 1;

/** Execution roots, relative to the runtime package. Provider adapters are added when they are bound. */
export const EXECUTION_ROOTS: readonly string[] = [
  'src/execution/admission.ts',
  'src/execution/agent.ts',
  'src/execution/answers.ts',
  'src/execution/cancellation.ts',
  'src/execution/in-flight.ts',
  'src/execution/continuation.ts',
  'src/execution/controller.ts',
  'src/execution/outcomes.ts',
  'src/execution/definition.ts',
  'src/execution/invocation.ts',
  'src/execution/operations.ts',
  'src/execution/publication.ts',
  'src/execution/saved-state.ts',
  'src/execution/terminal.ts',
  'src/records/run-store.ts',
];

/**
 * Packages execution depends on without importing them from the closure: the official saver (through its
 * adapter) serializes and restores the saved state a continuation resumes from.
 */
export const DECLARED_PACKAGES: readonly string[] = ['@langchain/langgraph-checkpoint-postgres'];

export interface CodeManifest {
  version: typeof CODE_MANIFEST_VERSION;
  /** Sorted module paths (relative to the runtime package) with SHA-256 of their LF-normalized content. */
  executionCode: { path: string; digest: string }[];
  /** Sorted lockfile entries for the packages the closure uses, and their dependencies. */
  packages: { name: string; version: string; integrity: string }[];
}

const sha256 = (text: string) => new Bun.CryptoHasher('sha256').update(text).digest('hex');
export const normalizeSource = (text: string) => text.replace(/\r\n?/g, '\n');

function packageNameOf(specifier: string): string | undefined {
  if (specifier === 'bun' || specifier.startsWith('bun:') || specifier.startsWith('node:')) return undefined;
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

type LockEntry = [spec: string, registry: string, meta: Record<string, Record<string, string>>, integrity: string];

/** Reads bun.lock (JSON with trailing commas). */
export function readLockPackages(lockfile: string): Record<string, unknown[]> {
  const text = readFileSync(lockfile, 'utf8').replace(/,(\s*[}\]])/g, '$1');
  return (JSON.parse(text) as { packages: Record<string, unknown[]> }).packages;
}

function resolvePackages(lock: Record<string, unknown[]>, direct: Iterable<string>) {
  const found = new Map<string, { name: string; version: string; integrity: string }>();
  const pending = [...direct].map((name) => ({ key: name }));
  while (pending.length > 0) {
    const { key } = pending.pop() as { key: string };
    if (found.has(key)) continue;
    const entry = lock[key] as LockEntry | undefined;
    if (entry === undefined || typeof entry[3] !== 'string') throw new Error(`package ${key} is not in the lockfile`);
    const spec = entry[0];
    const at = spec.lastIndexOf('@');
    found.set(key, { name: key, version: spec.slice(at + 1), integrity: entry[3] });
    const meta = entry[2] ?? {};
    for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
      for (const dependency of Object.keys(meta[field] ?? {})) {
        // A nested entry (`parent/dependency`) takes precedence over the hoisted one.
        const nested = `${key}/${dependency}`;
        if (lock[nested] !== undefined) pending.push({ key: nested });
        else if (lock[dependency] !== undefined) pending.push({ key: dependency });
        else if (field !== 'peerDependencies' && field !== 'optionalDependencies') {
          throw new Error(`dependency ${dependency} of ${key} is not in the lockfile`);
        }
      }
    }
  }
  return [...found.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

export interface CodeManifestInput {
  /** The runtime package directory. */
  packageRoot: string;
  lockfile: string;
  roots?: readonly string[];
  declaredPackages?: readonly string[];
}

export function computeCodeManifest(input: CodeManifestInput): CodeManifest {
  const scanner = new Bun.Transpiler({ loader: 'ts' });
  const sourceRoot = resolve(input.packageRoot, 'src');
  const files = new Map<string, string>();
  const packages = new Set(input.declaredPackages ?? DECLARED_PACKAGES);
  const pending = (input.roots ?? EXECUTION_ROOTS).map((root) => resolve(input.packageRoot, root));
  while (pending.length > 0) {
    const file = pending.pop() as string;
    if (files.has(file)) continue;
    if (!file.startsWith(`${sourceRoot}${sep}`)) throw new Error(`execution code outside the package source: ${file}`);
    const source = normalizeSource(readFileSync(file, 'utf8'));
    files.set(file, sha256(source));
    for (const entry of scanner.scanImports(source)) {
      if (entry.path.startsWith('.')) pending.push(resolve(dirname(file), entry.path));
      else {
        const name = packageNameOf(entry.path);
        if (name !== undefined) packages.add(name);
      }
    }
  }
  return {
    version: CODE_MANIFEST_VERSION,
    executionCode: [...files]
      .map(([file, digest]) => ({ path: relative(input.packageRoot, file).split(sep).join('/'), digest }))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
    packages: resolvePackages(readLockPackages(input.lockfile), packages),
  };
}

/** The runtime package, when running from source. */
export const PACKAGE_ROOT = resolve(import.meta.dir, '..', '..');

/** The manifest of the running code: the one shipped beside the bundle, or computed from source. */
export async function currentCodeManifest(): Promise<CodeManifest> {
  const shipped = Bun.file(join(import.meta.dir, CODE_MANIFEST_FILE));
  if (await shipped.exists()) return (await shipped.json()) as CodeManifest;
  return computeCodeManifest({ packageRoot: PACKAGE_ROOT, lockfile: resolve(PACKAGE_ROOT, '..', '..', 'bun.lock') });
}
