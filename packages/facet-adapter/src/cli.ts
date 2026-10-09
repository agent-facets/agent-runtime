// Owner tooling for the runtime facet installation.
//
//   FACET_DIR=<absolute runtime home> bun packages/facet-adapter/src/cli.ts check --project <dir>
//   FACET_DIR=<absolute runtime home> bun packages/facet-adapter/src/cli.ts seal --project <dir> [--out <file>]
//
// `check` runs before `facet install` and refuses an unpinned CLI or a facet home shared with other adapters.
// `seal` writes the canonical bundle and prints the SHA-256 the owner pins in operator configuration. Neither
// command downloads, installs or repairs anything.
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { SealError, sealInstallation } from './seal.ts';
import { ADAPTER_NAME, ToolchainError, verifyPinnedCli } from './toolchain.ts';

export class UsageError extends Error {
  override readonly name = 'UsageError';
}

export interface CliOptions {
  command: 'check' | 'seal';
  project: string;
  out?: string;
  facetBin?: string;
}

export function parseArgs(argv: readonly string[]): CliOptions {
  const [command, ...rest] = argv;
  if (command !== 'check' && command !== 'seal') throw new UsageError('usage: cli.ts <check|seal> --project <dir>');
  const options: Partial<CliOptions> = { command };
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index];
    const value = rest[index + 1];
    if (value === undefined) throw new UsageError(`${flag} needs a value`);
    if (flag === '--project') options.project = value;
    else if (flag === '--out' && command === 'seal') options.out = value;
    else if (flag === '--facet-bin') options.facetBin = value;
    else throw new UsageError(`unknown option ${flag}`);
  }
  if (options.project === undefined) throw new UsageError('--project <dir> is required');
  return options as CliOptions;
}

/** The isolated runtime home: absolute, set explicitly and never the default editor home. */
export function runtimeFacetDir(env: Record<string, string | undefined>, home: string = homedir()): string {
  const value = env.FACET_DIR?.trim();
  if (value === undefined || value === '') throw new UsageError('set FACET_DIR to the absolute runtime facet home');
  if (!isAbsolute(value)) throw new UsageError('FACET_DIR must be an absolute path');
  if (resolve(value) === resolve(home, '.facet')) {
    throw new UsageError('FACET_DIR must not be the default editor facet home');
  }
  return resolve(value);
}

/** Adapters already installed in the runtime home; only the runtime adapter (or none yet) is acceptable. */
export function foreignAdapters(facetDir: string): string[] {
  const dir = join(facetDir, 'adapters');
  return existsSync(dir)
    ? readdirSync(dir)
        .filter((name) => name !== ADAPTER_NAME)
        .sort()
    : [];
}

export async function main(argv: readonly string[], env: Record<string, string | undefined>): Promise<number> {
  const options = parseArgs(argv);
  const facetDir = runtimeFacetDir(env);
  const project = resolve(options.project);
  const binary = options.facetBin ?? Bun.which('facet', { PATH: env.PATH ?? '' });
  if (binary === null) throw new ToolchainError('the facet CLI is not on PATH');
  const cli = await verifyPinnedCli(binary);

  if (options.command === 'check') {
    const foreign = foreignAdapters(facetDir);
    if (foreign.length > 0) {
      throw new SealError(
        'facet_home_contaminated',
        `remove other adapters from the runtime facet home: ${foreign.join(', ')}`,
      );
    }
    console.log(`facet CLI ${cli.version} (${cli.platform}) matches the pinned binary; ${facetDir} is isolated`);
    return 0;
  }

  const sealed = sealInstallation({ projectDir: project, facetDir, cli });
  const out = resolve(options.out ?? join(project, 'installation.json'));
  await Bun.write(out, sealed.bytes);
  const refused = sealed.installation.items.filter((item) => item.state.kind === 'refused').length;
  const ready = sealed.installation.items.filter((item) => item.state.kind === 'ready').length;
  console.log(`sealed ${out}: ${ready} ready, ${refused} refused`);
  console.log(`sha256 ${sealed.sha256}`);
  return 0;
}

if (import.meta.main) {
  try {
    process.exit(await main(process.argv.slice(2), process.env));
  } catch (error) {
    if (error instanceof UsageError || error instanceof ToolchainError || error instanceof SealError) {
      console.error(`refused: ${error.message}`);
      process.exit(1);
    }
    throw error;
  }
}
