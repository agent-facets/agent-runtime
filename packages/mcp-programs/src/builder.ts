// Builds MCP server programs into self-contained Bun bundles at `<outDir>/<id>/<sha256>.js`, with a manifest of each
// bundle's digest and the exact package versions and lockfile integrity it was built from. The runtime later checks
// a bundle's bytes against the digest the owner configures and runs it with the pinned Bun, never installing
// anything. A program that cannot be one self-contained file is refused: a native addon or other asset, a split
// chunk, or an import left unresolved for the runtime to find. (A dynamic import of a computed name cannot be seen
// here; such a program fails when run, because programs run with installation disabled.)
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { dirname, join, resolve } from 'node:path';

export const PROGRAM_MANIFEST_FILE = 'manifest.json';
export const PROGRAM_MANIFEST_VERSION = 1;

export interface ProgramDependency {
  name: string;
  version: string;
  integrity: string;
}

export interface BuiltProgram {
  id: string;
  sha256: string;
  /** Relative to the output directory: `<id>/<sha256>.js`. */
  path: string;
  dependencies: ProgramDependency[];
}

export interface ProgramManifest {
  version: typeof PROGRAM_MANIFEST_VERSION;
  bun: string;
  programs: BuiltProgram[];
}

export type ProgramRefusal =
  | 'invalid_program_id'
  | 'build_failed'
  | 'not_self_contained'
  | 'native_dependency'
  | 'unresolved_import'
  | 'dependency_unpinned';

export class ProgramBuildError extends Error {
  override readonly name = 'ProgramBuildError';
  constructor(
    readonly program: string,
    readonly reason: ProgramRefusal,
  ) {
    super(`program ${program} cannot be built: ${reason}`);
  }
}

const PROGRAM_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const builtins = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));
const isBuiltin = (path: string) =>
  builtins.has(path) || path.startsWith('node:') || path.startsWith('bun:') || path === 'bun';
const sha256 = (bytes: Uint8Array) => new Bun.CryptoHasher('sha256').update(bytes).digest('hex');

type LockEntry = [spec: string, ...rest: unknown[]];

/** bun.lock entries by `name@version`, with their integrity. */
function lockIntegrity(lockfile: string): Map<string, string> {
  const text = readFileSync(lockfile, 'utf8').replace(/,(\s*[}\]])/g, '$1');
  const packages = (JSON.parse(text) as { packages: Record<string, LockEntry> }).packages;
  const found = new Map<string, string>();
  for (const entry of Object.values(packages)) {
    const [spec] = entry;
    const integrity = entry.at(-1);
    if (typeof spec === 'string' && typeof integrity === 'string' && integrity.startsWith('sha'))
      found.set(spec, integrity);
  }
  return found;
}

/** The installed package a bundled input file belongs to: its name and the version in its own package.json. */
function packageOf(file: string): { name: string; version: string } | undefined {
  const match = /^(.*\/node_modules\/((?:@[^/]+\/)?[^/]+))\//.exec(file);
  if (match === null) return undefined;
  const [, dir, name] = match as unknown as [string, string, string];
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { version?: unknown };
  if (typeof manifest.version !== 'string') throw new Error(`package ${name} has no version`);
  return { name, version: manifest.version };
}

export interface BuildProgramsInput {
  programs: readonly { id: string; entry: string }[];
  /** The package the entries are relative to. */
  packageRoot: string;
  outDir: string;
  lockfile: string;
  /** In-memory sources by absolute path (tests); they may import installed packages. */
  files?: Record<string, string>;
}

export async function buildPrograms(input: BuildProgramsInput): Promise<ProgramManifest> {
  const integrity = lockIntegrity(input.lockfile);
  const programs: BuiltProgram[] = [];
  const seen = new Set<string>();
  for (const program of input.programs) {
    if (!PROGRAM_ID.test(program.id) || seen.has(program.id))
      throw new ProgramBuildError(program.id, 'invalid_program_id');
    seen.add(program.id);
    let result: Awaited<ReturnType<typeof Bun.build>>;
    try {
      result = await Bun.build({
        entrypoints: [resolve(input.packageRoot, program.entry)],
        root: input.packageRoot,
        target: 'bun',
        format: 'esm',
        splitting: false,
        packages: 'bundle',
        sourcemap: 'none',
        minify: false,
        env: 'disable',
        metafile: true,
        throw: false,
        ...(input.files === undefined ? {} : { files: input.files }),
      });
    } catch {
      throw new ProgramBuildError(program.id, 'build_failed');
    }
    if (!result.success) throw new ProgramBuildError(program.id, 'build_failed');
    const inputs = Object.keys(result.metafile?.inputs ?? {});
    if (result.outputs.some((output) => output.kind === 'asset') || inputs.some((file) => file.endsWith('.node'))) {
      throw new ProgramBuildError(program.id, 'native_dependency');
    }
    const [bundle, ...others] = result.outputs;
    if (bundle === undefined || bundle.kind !== 'entry-point' || others.length > 0) {
      throw new ProgramBuildError(program.id, 'not_self_contained');
    }
    for (const output of Object.values(result.metafile?.outputs ?? {})) {
      if (output.imports.some((entry) => !isBuiltin(entry.path))) {
        throw new ProgramBuildError(program.id, 'unresolved_import');
      }
    }

    const dependencies = new Map<string, ProgramDependency>();
    for (const file of inputs) {
      // Metafile input paths are relative to the working directory.
      const pkg = packageOf(resolve(file));
      if (pkg === undefined) continue;
      const key = `${pkg.name}@${pkg.version}`;
      const pinned = integrity.get(key);
      if (pinned === undefined) throw new ProgramBuildError(program.id, 'dependency_unpinned');
      dependencies.set(key, { name: pkg.name, version: pkg.version, integrity: pinned });
    }

    const bytes = new Uint8Array(await bundle.arrayBuffer());
    const digest = sha256(bytes);
    const path = `${program.id}/${digest}.js`;
    mkdirSync(dirname(join(input.outDir, path)), { recursive: true });
    writeFileSync(join(input.outDir, path), bytes, { mode: 0o644 });
    programs.push({
      id: program.id,
      sha256: digest,
      path,
      dependencies: [...dependencies.values()].sort((a, b) =>
        a.name < b.name ? -1 : a.name > b.name ? 1 : a.version < b.version ? -1 : 1,
      ),
    });
  }
  const manifest: ProgramManifest = { version: PROGRAM_MANIFEST_VERSION, bun: Bun.version, programs };
  mkdirSync(input.outDir, { recursive: true });
  writeFileSync(join(input.outDir, PROGRAM_MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

export type ProgramCheck = { ok: true } | { ok: false; program: string; reason: 'missing' | 'tampered' };

/** Re-hashes every bundle a manifest lists: a missing or altered file is reported, never rebuilt. */
export function verifyPrograms(outDir: string, manifest: ProgramManifest): ProgramCheck {
  for (const program of manifest.programs) {
    let bytes: Uint8Array;
    try {
      bytes = readFileSync(join(outDir, program.path));
    } catch {
      return { ok: false, program: program.id, reason: 'missing' };
    }
    if (sha256(bytes) !== program.sha256 || program.path !== `${program.id}/${program.sha256}.js`) {
      return { ok: false, program: program.id, reason: 'tampered' };
    }
  }
  return { ok: true };
}
