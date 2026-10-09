// Shared helpers for the explicitly launched facet suite. Every CLI run uses a disposable HOME and an explicit
// absolute FACET_DIR beneath the launcher's scratch directory, so neither the owner's editor facet home nor the
// repository's own facet installation can be reached.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';

export const FACET_FIXTURE_MARKER = 'agent-runtime-facet-fixture';
const repoRoot = resolve(import.meta.dir, '..', '..');
export const fixtureFacets = join(repoRoot, 'tests', 'facets', 'fixtures', 'facets');
export const runtimeAdapterDir = join(repoRoot, 'packages', 'facet-adapter', 'dist', 'adapter');

export interface FacetFixture {
  scratch: string;
  cli: string;
}

/** Refuses to run outside the launcher's disposable scratch directory. */
export function requireFacetFixture(env: Record<string, string | undefined>): FacetFixture {
  const scratch = env.FACET_FIXTURE_DIR;
  const cli = env.FACET_FIXTURE_CLI;
  const tmp = resolve(tmpdir());
  if (
    scratch === undefined ||
    cli === undefined ||
    !isAbsolute(scratch) ||
    relative(tmp, scratch).startsWith('..') ||
    !existsSync(join(scratch, FACET_FIXTURE_MARKER)) ||
    readFileSync(join(scratch, FACET_FIXTURE_MARKER), 'utf8').trim() !== scratch
  ) {
    throw new Error('the facet suite runs only through `bun run test:facets`, which provisions disposable homes');
  }
  return { scratch, cli };
}

export interface CommandOutput {
  code: number;
  stdout: string;
  stderr: string;
}

export class FacetSandbox {
  private counter = 0;
  constructor(readonly fixture: FacetFixture) {}

  /** A fresh, empty directory under the scratch area. */
  dir(label: string): string {
    this.counter += 1;
    const path = join(this.fixture.scratch, `${String(this.counter).padStart(3, '0')}-${label}`);
    mkdirSync(path, { recursive: true });
    return path;
  }

  /** Runs the pinned CLI with an isolated HOME and the given absolute FACET_DIR. */
  async facet(args: string[], options: { cwd: string; home: string }): Promise<CommandOutput> {
    const proc = Bun.spawn([this.fixture.cli, ...args], {
      cwd: options.cwd,
      env: {
        PATH: process.env.PATH ?? '',
        HOME: join(this.fixture.scratch, 'home'),
        TMPDIR: tmpdir(),
        FACET_DIR: options.home,
        NO_COLOR: '1',
      },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { code, stdout, stderr };
  }

  async expectFacet(args: string[], options: { cwd: string; home: string }): Promise<CommandOutput> {
    const result = await this.facet(args, options);
    if (result.code !== 0)
      throw new Error(`facet ${args.join(' ')} failed (${result.code}):\n${result.stderr}${result.stdout}`);
    return result;
  }

  /** A facet home holding exactly the given adapter directories. */
  async home(label: string, adapters: string[]): Promise<string> {
    const home = join(this.dir(label), 'facet-home');
    for (const adapter of adapters)
      await this.expectFacet(['adapter', 'add', adapter], { cwd: this.fixture.scratch, home });
    return home;
  }

  /**
   * A consuming project with copies of the named fixture facets as local sources, and a server command that records
   * any execution, so the suite can prove installation and sealing never launch a declared server.
   */
  project(label: string, facets: string[], materialization: Record<string, unknown> = {}): string {
    const project = this.dir(label);
    for (const facet of facets) cpSync(join(fixtureFacets, facet), join(project, 'facets', facet), { recursive: true });
    writeFileSync(join(project, 'never-run.sh'), `#!/bin/sh\ntouch '${join(project, 'server-was-run')}'\n`, {
      mode: 0o755,
    });
    writeManifest(project, facets, materialization);
    return project;
  }
}

export function writeManifest(project: string, facets: string[], materialization: Record<string, unknown> = {}): void {
  const entries = Object.fromEntries(
    facets.map((facet) => {
      const choices = materialization[facet];
      return [
        facet,
        choices === undefined ? `./facets/${facet}` : { source: `./facets/${facet}`, materialization: choices },
      ];
    }),
  );
  writeFileSync(
    join(project, 'facets.json'),
    `${JSON.stringify({ manifestVersion: 0.2, facets: entries }, null, 2)}\n`,
  );
}

/** Every regular file beneath a directory with its SHA-256, plus every directory, for mutation comparisons. */
export function tree(root: string): Record<string, string> {
  const entries: Record<string, string> = {};
  if (!existsSync(root)) return entries;
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      const key = relative(root, path);
      if (statSync(path).isDirectory()) {
        entries[`${key}/`] = 'dir';
        walk(path);
      } else entries[key] = new Bun.CryptoHasher('sha256').update(readFileSync(path)).digest('hex');
    }
  };
  walk(root);
  return entries;
}
