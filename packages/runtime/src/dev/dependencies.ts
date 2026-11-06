// Development only. A fingerprint of everything dependency installation depends on: the Bun release and platform,
// the lockfile, the Bun configuration and every workspace manifest. The development image records it when it
// installs dependencies; a checkout whose fingerprint differs needs the image rebuilt, not a backend restart.
import { join, relative, resolve, sep } from 'node:path';

/** Installation inputs at the repository root; workspace manifests are found under packages/. */
export const ROOT_DEPENDENCY_INPUTS = ['package.json', 'bun.lock', 'bunfig.toml'] as const;

/** The repository root, for the runtime package's own source. */
export const REPOSITORY_ROOT = resolve(import.meta.dir, '..', '..', '..', '..');

/** Repository-relative paths of the installation inputs, in a stable order. */
export function dependencyInputs(root: string): string[] {
  const manifests = [...new Bun.Glob('packages/*/package.json').scanSync({ cwd: root, onlyFiles: true })]
    .map((path) => path.split(sep).join('/'))
    .sort();
  return [...ROOT_DEPENDENCY_INPUTS, ...manifests];
}

/** Whether a repository-relative path is an installation input. */
export function isDependencyInput(path: string): boolean {
  const normalized = path.split(sep).join('/');
  return (
    (ROOT_DEPENDENCY_INPUTS as readonly string[]).includes(normalized) ||
    /^packages\/[^/]+\/package\.json$/.test(normalized)
  );
}

export async function dependencyFingerprint(root: string): Promise<string> {
  const hasher = new Bun.CryptoHasher('sha256');
  hasher.update(`bun ${Bun.version} ${process.platform} ${process.arch}\n`);
  for (const path of dependencyInputs(root)) {
    const file = Bun.file(join(root, path));
    hasher.update(`${path}\n`);
    hasher.update((await file.exists()) ? await file.bytes() : '(missing)');
    hasher.update('\n');
  }
  return hasher.digest('hex');
}

export type DependencyCheck = { ok: true } | { ok: false; message: string };

/** Compares the checkout with the fingerprint recorded in an image; no record means nothing to compare. */
export async function checkDependencies(root: string, recordedFile: string | undefined): Promise<DependencyCheck> {
  if (recordedFile === undefined || recordedFile === '') return { ok: true };
  const recorded = Bun.file(recordedFile);
  if (!(await recorded.exists())) {
    return { ok: false, message: `the dependency record ${relative(root, recordedFile)} is missing` };
  }
  const expected = (await recorded.text()).trim();
  const actual = await dependencyFingerprint(root);
  if (expected === actual) return { ok: true };
  return {
    ok: false,
    message:
      'dependencies changed since this development image was built (package manifests, bun.lock, bunfig.toml or ' +
      'the Bun release); rebuild the image and recreate the runtime: bun run dev:stack rebuild',
  };
}

if (import.meta.main) {
  const root = resolve(process.argv[2] ?? REPOSITORY_ROOT);
  console.log(await dependencyFingerprint(root));
}
