import { readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

export const repoRoot = resolve(import.meta.dir, '..', '..');

export interface PackageManifest {
  name: string;
  private?: boolean;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  exports?: Record<string, string>;
}

export interface WorkspacePackage {
  dir: string;
  manifest: PackageManifest;
}

export const dependencyFields = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
] as const;

export async function readJson<T>(path: string): Promise<T> {
  return (await Bun.file(path).json()) as T;
}

export async function listWorkspacePackages(root = repoRoot): Promise<WorkspacePackage[]> {
  const packagesDir = join(root, 'packages');
  const dirs = readdirSync(packagesDir)
    .map((name) => join(packagesDir, name))
    .filter((dir) => statSync(dir).isDirectory())
    .sort();
  return Promise.all(
    dirs.map(async (dir) => ({ dir, manifest: await readJson<PackageManifest>(join(dir, 'package.json')) })),
  );
}

const sourceExtensions = /\.(?:[cm]?[jt]sx?)$/;
const skippedDirectories = new Set(['node_modules', 'dist', '.turbo']);

export function listSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (skippedDirectories.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...listSourceFiles(path));
    else if (entry.isFile() && sourceExtensions.test(entry.name)) files.push(path);
  }
  return files.sort();
}

const transpiler = new Bun.Transpiler({ loader: 'tsx' });

export function importSpecifiers(source: string): string[] {
  return transpiler.scanImports(source).map((entry) => entry.path);
}

export function isWithin(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === '' || (!path.startsWith('..') && !path.startsWith(sep) && path !== '..');
}

export function resolveRelative(fromFile: string, specifier: string): string | undefined {
  return specifier.startsWith('.') ? resolve(dirname(fromFile), specifier) : undefined;
}
