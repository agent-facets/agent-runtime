// The development deployment's commands (`bun run dev:stack <command>`): the base Compose file with
// compose.dev.yaml, always under the development project, so it has its own database, runtime state, Tailscale
// identity and network and never touches another deployment. Nothing here deletes volumes.
//
//   check     compare the checkout's dependency inputs with those the development image was built from
//   up        start the deployment (refused if the image is missing or its dependencies are stale)
//   rebuild   rebuild the development image, then recreate the runtime on it
//   recreate  recreate the runtime container (after a configuration or environment change)
//   reload    restart only the backend process, in place (e.g. after editing the operator configuration)
//   restart   restart the runtime container without recreating it
//   logs      follow a service's logs: the runtime unless services are named; flags go to `docker compose logs`
//   status    list the deployment's containers
//   config    print the merged Compose configuration (it contains secrets from the environment file)
//   stop      stop every service; containers, volumes and identity are kept
//   down      remove the containers and network; volumes are kept
//   auth      run the operator command in the runtime, e.g. `auth anthropic status`
//
// Options: --env-file <path> (default $AGENT_RUNTIME_DEV_ENV_FILE, else ~/.local/state/agent-runtime-dev/compose.env)
// and --project <name> (default $AGENT_RUNTIME_DEV_PROJECT, else agent-runtime-dev).
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { repoRoot } from './lib/workspace.ts';

export const DEFAULT_PROJECT = 'agent-runtime-dev';
export const DEFAULT_IMAGE = 'agent-runtime/runtime:dev';
/** Inside the development image (Dockerfile, stage `dev`). */
export const DEPENDENCY_RECORD = '/usr/local/share/agent-runtime/dependency-fingerprint';
/** Projects this command never operates on: the base file's default and the existing testing deployment. */
export const PROTECTED_PROJECTS = new Set(['agent-runtime', 'agent-runtime-live']);

const COMMANDS = [
  'check',
  'up',
  'rebuild',
  'recreate',
  'reload',
  'restart',
  'logs',
  'status',
  'config',
  'stop',
  'down',
  'auth',
] as const;
export type Command = (typeof COMMANDS)[number];

/** Installation inputs mounted read-only when the image's own Bun fingerprints the checkout. */
const INSTALL_INPUTS = [
  'package.json',
  'bun.lock',
  'bunfig.toml',
  'packages/anthropic-subscription/package.json',
  'packages/contracts/package.json',
  'packages/facet-adapter/package.json',
  'packages/mcp-programs/package.json',
  'packages/runtime/package.json',
  'packages/ui/package.json',
];

export interface Invocation {
  command: Command;
  project: string;
  envFile: string;
  rest: string[];
}

export class UsageError extends Error {
  override readonly name = 'UsageError';
}

export function parseArgs(argv: readonly string[], env: Record<string, string | undefined>): Invocation {
  let project = env.AGENT_RUNTIME_DEV_PROJECT || DEFAULT_PROJECT;
  let envFile =
    env.AGENT_RUNTIME_DEV_ENV_FILE || join(env.HOME || homedir(), '.local/state/agent-runtime-dev/compose.env');
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (positional.length === 0 && (arg === '--env-file' || arg === '--project')) {
      const value = argv[++i];
      if (value === undefined) throw new UsageError(`${arg} needs a value`);
      if (arg === '--env-file') envFile = value;
      else project = value;
    } else {
      positional.push(arg);
    }
  }
  const [command, ...rest] = positional;
  if (command === undefined || !(COMMANDS as readonly string[]).includes(command)) {
    throw new UsageError(`usage: bun run dev:stack <${COMMANDS.join('|')}> [arguments]`);
  }
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(project)) throw new UsageError('the project name is not a valid Compose name');
  if (PROTECTED_PROJECTS.has(project)) {
    throw new UsageError(`refusing to operate on project ${project}: it is not the development deployment`);
  }
  if (!envFile.startsWith('/')) throw new UsageError('--env-file must be an absolute path');
  if (command === 'down' && rest.some((arg) => /^(?:-v|--volumes|--rmi)(?:=|$)/.test(arg))) {
    throw new UsageError('dev:stack down never removes volumes or images');
  }
  return { command: command as Command, project, envFile, rest };
}

/** The Compose invocation prefix for the development deployment. */
export function composeArgs(invocation: Pick<Invocation, 'project' | 'envFile'>): string[] {
  return [
    'docker',
    'compose',
    '-p',
    invocation.project,
    '--env-file',
    invocation.envFile,
    '-f',
    join(repoRoot, 'compose.yaml'),
    '-f',
    join(repoRoot, 'compose.dev.yaml'),
  ];
}

/** The Compose steps a command runs; `check` and the image checks are performed separately. */
export function composeSteps(invocation: Invocation, interactive: boolean): string[][] {
  const compose = composeArgs(invocation);
  switch (invocation.command) {
    case 'up':
      return [[...compose, 'up', '-d', ...invocation.rest]];
    case 'rebuild':
      return [
        [...compose, 'build', 'runtime'],
        [...compose, 'up', '-d', 'tailscale', 'postgres'],
        [...compose, 'up', '-d', '--no-deps', '--force-recreate', 'runtime'],
      ];
    case 'recreate':
      return [[...compose, 'up', '-d', '--no-deps', '--force-recreate', 'runtime']];
    case 'reload':
      return [[...compose, 'kill', '-s', 'SIGHUP', 'runtime']];
    case 'restart':
      return [[...compose, 'restart', 'runtime']];
    case 'logs': {
      const flags = invocation.rest.filter((arg) => arg.startsWith('-'));
      const services = invocation.rest.filter((arg) => !arg.startsWith('-'));
      return [
        [
          ...compose,
          'logs',
          ...(flags.length > 0 ? flags : ['-f', '--tail', '200']),
          ...(services.length > 0 ? services : ['runtime']),
        ],
      ];
    }
    case 'status':
      return [[...compose, 'ps']];
    case 'config':
      return [[...compose, 'config', ...invocation.rest]];
    case 'stop':
      return [[...compose, 'stop']];
    case 'down':
      return [[...compose, 'down', ...invocation.rest]];
    case 'auth':
      return [
        [
          ...compose,
          'exec',
          ...(interactive ? ['-it'] : ['-T']),
          'runtime',
          'bun',
          'packages/runtime/src/auth.ts',
          ...invocation.rest,
        ],
      ];
    case 'check':
      return [];
  }
}

/** The commands that must not run on an image whose dependencies are stale. */
const NEEDS_CURRENT_IMAGE = new Set<Command>(['up', 'recreate', 'restart']);

async function run(args: string[], quiet = false): Promise<{ code: number; stdout: string }> {
  const child = Bun.spawn(args, {
    cwd: repoRoot,
    stdin: quiet ? 'ignore' : 'inherit',
    stdout: quiet ? 'pipe' : 'inherit',
    stderr: quiet ? 'pipe' : 'inherit',
  });
  const stdout = quiet ? await new Response(child.stdout as ReadableStream).text() : '';
  return { code: await child.exited, stdout };
}

async function devImage(invocation: Invocation): Promise<string> {
  const { code, stdout } = await run([...composeArgs(invocation), 'config', '--images'], true);
  if (code !== 0) throw new UsageError('the Compose configuration is invalid; see `bun run dev:stack config`');
  const images = stdout.split('\n').filter((line) => line.trim() !== '');
  // The runtime's image is the only one not pinned by digest.
  return images.find((image) => !image.includes('@sha256:')) ?? DEFAULT_IMAGE;
}

export type ImageCheck = { kind: 'current' } | { kind: 'missing'; image: string } | { kind: 'stale'; image: string };

/** Fingerprints the checkout with the image's own Bun and compares it with the image's record. */
async function checkImage(invocation: Invocation): Promise<ImageCheck> {
  const image = await devImage(invocation);
  if ((await run(['docker', 'image', 'inspect', image], true)).code !== 0) return { kind: 'missing', image };
  const recorded = await run(
    ['docker', 'run', '--rm', '--network', 'none', '--entrypoint', 'cat', image, DEPENDENCY_RECORD],
    true,
  );
  const mounts = INSTALL_INPUTS.flatMap((path) => [
    '--mount',
    `type=bind,source=${join(repoRoot, path)},target=/repo/${path},readonly`,
  ]);
  const current = await run(
    [
      'docker',
      'run',
      '--rm',
      '--network',
      'none',
      '--read-only',
      ...mounts,
      '--entrypoint',
      'bun',
      image,
      'packages/runtime/src/dev/dependencies.ts',
      '/repo',
    ],
    true,
  );
  if (recorded.code !== 0 || current.code !== 0) return { kind: 'stale', image };
  return recorded.stdout.trim() === current.stdout.trim() ? { kind: 'current' } : { kind: 'stale', image };
}

async function main(): Promise<number> {
  const invocation = parseArgs(process.argv.slice(2), process.env);
  if (!existsSync(invocation.envFile)) {
    console.error(`dev:stack: the environment file ${invocation.envFile} does not exist`);
    return 1;
  }
  if (invocation.command === 'check' || NEEDS_CURRENT_IMAGE.has(invocation.command)) {
    const check = await checkImage(invocation);
    if (check.kind === 'missing') {
      console.error(`dev:stack: the development image ${check.image} has not been built: bun run dev:stack rebuild`);
      return 1;
    }
    if (check.kind === 'stale') {
      console.error(
        `dev:stack: dependencies changed since ${check.image} was built (package manifests, bun.lock or ` +
          'bunfig.toml): bun run dev:stack rebuild',
      );
      return 1;
    }
    if (invocation.command === 'check') {
      console.log('dev:stack: the development image matches the checkout’s dependencies');
      return 0;
    }
  }
  for (const step of composeSteps(invocation, process.stdin.isTTY === true)) {
    const { code } = await run(step);
    if (code !== 0) return code;
  }
  return 0;
}

if (import.meta.main) {
  try {
    process.exit(await main());
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(`dev:stack: ${error.message}`);
      process.exit(2);
    }
    throw error;
  }
}
