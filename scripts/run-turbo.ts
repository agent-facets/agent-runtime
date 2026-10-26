// Entry point for the repository's Turbo commands. Telemetry stays off, and Turbo is given the cache-key identities it
// cannot see itself: the platform and Bun for every task, and for `check` the fixture toolchain (facet CLI, headless
// browser, Docker). `check` first applies the fixture launchers' own safety and prerequisite checks, because a cache
// hit replays a suite's result without starting its launcher. Cache credentials stay with Turbo; tasks never see them.
import { join } from 'node:path';
import { readCliIdentity, ToolchainError } from '../packages/facet-adapter/src/toolchain.ts';
import { fixtureEnv, refusedOverrides, runCommand } from './lib/fixture-env.ts';
import { repoRoot } from './lib/workspace.ts';

export const TURBO_TASKS = ['build', 'check', 'test:all', 'typecheck:all'] as const;
export type TurboTask = (typeof TURBO_TASKS)[number];

export interface TurboRun {
  task: TurboTask;
  force: boolean;
}

export class RefusedRun extends Error {
  override readonly name = 'RefusedRun';
}

/** Accepts one known task and an optional `--force`; `check` also refuses the environments fixtures refuse. */
export function planRun(argv: string[], env: Record<string, string | undefined>): TurboRun {
  const [task, ...rest] = argv;
  if (!TURBO_TASKS.includes(task as TurboTask)) {
    throw new RefusedRun(`unknown task ${task ?? '(none)'}; expected one of ${TURBO_TASKS.join(', ')}`);
  }
  const force = rest.length === 1 && rest[0] === '--force';
  if (rest.length > 0 && !force) throw new RefusedRun(`unexpected arguments: ${rest.join(' ')}`);
  const refused = task === 'check' ? refusedOverrides(env) : [];
  if (refused.length > 0) {
    throw new RefusedRun(
      `refused environment overrides: ${refused.join(', ')}. Fixtures provision their own isolated storage.`,
    );
  }
  return { task: task as TurboTask, force };
}

export const platformIdentity = () => `${process.platform}-${process.arch} bun-${Bun.version}`;

/**
 * Requires every fixture prerequisite and names the exact tools, so a result is reused only with the same ones. Any
 * facet CLI is accepted: the facet suite's behavior is the test, and its identity only keys the cache.
 */
async function fixtureToolchainIdentity(): Promise<string> {
  const binary = Bun.which('facet', { PATH: process.env.PATH ?? '' });
  if (binary === null) throw new RefusedRun('the facet CLI is not on PATH; it is never installed automatically');
  let cli: Awaited<ReturnType<typeof readCliIdentity>>;
  try {
    cli = await readCliIdentity(binary);
  } catch (error) {
    if (error instanceof ToolchainError) throw new RefusedRun(error.message);
    throw error;
  }

  let browserVersion: string;
  try {
    const { chromium } = await import('playwright');
    const browser = await chromium.launch();
    browserVersion = browser.version();
    await browser.close();
  } catch {
    throw new RefusedRun('the pinned headless browser is missing: run `bun run browser:install` first');
  }

  const env = fixtureEnv(process.env, {});
  const docker = await runCommand(['docker', 'version', '--format', '{{.Server.Version}}'], {
    env,
    cwd: repoRoot,
    allowFailure: true,
  });
  const compose = await runCommand(['docker', 'compose', 'version', '--short'], {
    env,
    cwd: repoRoot,
    allowFailure: true,
  });
  if (docker.code !== 0 || compose.code !== 0) throw new RefusedRun('Docker Engine with Compose v2 is not available');

  return `facet-${cli.version}-${cli.sha256} chromium-${browserVersion} docker-${docker.stdout.trim()} compose-${compose.stdout.trim()}`;
}

if (import.meta.main) {
  const name = process.argv[2] ?? 'turbo';
  try {
    const run = planRun(process.argv.slice(2), process.env);
    const identities: Record<string, string> = { CHECK_PLATFORM: platformIdentity() };
    if (run.task === 'check') identities.CHECK_FIXTURE_TOOLCHAIN = await fixtureToolchainIdentity();
    const turbo = Bun.spawn(
      [join(repoRoot, 'node_modules', '.bin', 'turbo'), 'run', run.task, ...(run.force ? ['--force'] : [])],
      {
        cwd: repoRoot,
        env: { ...process.env, TURBO_TELEMETRY_DISABLED: '1', DO_NOT_TRACK: '1', ...identities },
        stdin: 'ignore',
        stdout: 'inherit',
        stderr: 'inherit',
      },
    );
    process.exit(await turbo.exited);
  } catch (error) {
    if (!(error instanceof RefusedRun)) throw error;
    console.error(`${name} refuses to start: ${error.message}`);
    process.exit(1);
  }
}
