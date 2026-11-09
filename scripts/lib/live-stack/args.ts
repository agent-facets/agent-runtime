// Argument parsing for `bun run live:stack`. The project is fixed: this command manages exactly one deployment.
import { homedir } from 'node:os';
import { join } from 'node:path';

export const PROJECT = 'agent-runtime-live';
export const SERVICES = ['tailscale', 'postgres', 'runtime'] as const;
export type Service = (typeof SERVICES)[number];

export class UsageError extends Error {
  override readonly name = 'UsageError';
}

export type Invocation =
  | { command: 'help' }
  | { command: 'status' }
  | { command: 'logs'; services: Service[]; follow: boolean; options: string[] }
  | { command: 'start' }
  | { command: 'stop'; runtimeOnly: boolean }
  | { command: 'restart' }
  | { command: 'recreate' }
  | { command: 'down'; yes: boolean }
  | { command: 'build' }
  | { command: 'deploy'; image: string; yes: boolean }
  | { command: 'auth'; offline: boolean; args: string[] }
  | { command: 'tailscale-status' }
  | { command: 'tailscale-enroll' }
  | { command: 'tailscale-recover'; yes: boolean };

export interface Parsed {
  invocation: Invocation;
  stateDir: string;
}

export const USAGE = `usage: bun run live:stack [--state-dir <absolute path>] <command> [arguments]

  status                       containers, images, readiness and the Tailscale node
  logs [service...] [options]  follow logs (runtime by default); --tail <n>, --since <t>, --timestamps, --no-follow
  start | up                   start the existing containers; never builds, pulls or changes the image
  stop [runtime]               stop every service (or only the runtime); containers and volumes are kept
  restart                      restart the runtime container as it is
  recreate | reload            recreate the runtime on the selected image (applies configuration changes)
  down [--yes]                 remove containers and network; volumes and the selected image are kept
  build                        build a new production image under a unique tag; deploys nothing
  deploy --image <ref> [--yes] make <ref> the selected image and recreate the runtime on it
  auth [--offline] <args...>   the bundled operator command (bun dist/auth.js); --offline runs it with the runtime stopped
  tailscale status             the node's state and Serve configuration
  tailscale enroll             how to enroll the node, with its login link when it has one
  tailscale recover [--yes]    recreate the Tailscale container (identity kept), then the runtime`;

const LOG_VALUE_OPTIONS = new Set(['--tail', '--since', '--until']);
const LOG_FLAG_OPTIONS = new Set(['--timestamps', '-t', '--no-color']);

const isService = (value: string): value is Service => (SERVICES as readonly string[]).includes(value);

function takeYes(rest: string[], command: string): boolean {
  const unknown = rest.filter((arg) => arg !== '--yes');
  if (unknown.length > 0) throw new UsageError(`${command}: unexpected argument ${unknown[0]}`);
  return rest.includes('--yes');
}

function noArguments(rest: string[], command: string) {
  if (rest.length > 0) throw new UsageError(`${command}: unexpected argument ${rest[0]}`);
}

function parseLogs(rest: string[]): Invocation {
  const services: Service[] = [];
  const options: string[] = [];
  let follow = true;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i] as string;
    const [name, inline] = arg.startsWith('--') && arg.includes('=') ? arg.split('=', 2) : [arg, undefined];
    if (name === '--no-follow') follow = false;
    else if (name === '--follow' || name === '-f') follow = true;
    else if (LOG_FLAG_OPTIONS.has(name as string) && inline === undefined) options.push(name as string);
    else if (LOG_VALUE_OPTIONS.has(name as string)) {
      const value = inline ?? rest[++i];
      if (value === undefined || value === '' || value.startsWith('-'))
        throw new UsageError(`logs: ${name} needs a value`);
      if (!/^[A-Za-z0-9:.+-]+$/.test(value)) throw new UsageError(`logs: invalid value for ${name}`);
      options.push(name as string, value);
    } else if (isService(arg)) services.push(arg);
    else throw new UsageError(`logs: unknown service or option ${arg}`);
  }
  return { command: 'logs', services: services.length > 0 ? services : ['runtime'], follow, options };
}

export function defaultStateDir(env: Record<string, string | undefined>): string {
  return join(env.HOME || homedir(), '.local/state/agent-runtime-live');
}

export function parseArgs(argv: readonly string[], env: Record<string, string | undefined>): Parsed {
  let stateDir = defaultStateDir(env);
  let i = 0;
  while (argv[i] === '--state-dir') {
    const value = argv[i + 1];
    if (value === undefined) throw new UsageError('--state-dir needs a value');
    stateDir = value;
    i += 2;
  }
  if (!stateDir.startsWith('/')) throw new UsageError('--state-dir must be an absolute path');
  const [command, ...rest] = argv.slice(i);
  const parsed = (invocation: Invocation): Parsed => ({ invocation, stateDir });
  switch (command) {
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      return parsed({ command: 'help' });
    case 'status':
      noArguments(rest, command);
      return parsed({ command: 'status' });
    case 'logs':
      return parsed(parseLogs(rest));
    case 'start':
    case 'up':
      noArguments(rest, command);
      return parsed({ command: 'start' });
    case 'stop':
      if (rest.length > 1 || (rest.length === 1 && rest[0] !== 'runtime')) {
        throw new UsageError('stop: only `stop` or `stop runtime` is accepted');
      }
      return parsed({ command: 'stop', runtimeOnly: rest[0] === 'runtime' });
    case 'restart':
      noArguments(rest, command);
      return parsed({ command: 'restart' });
    case 'recreate':
    case 'reload':
      noArguments(rest, command);
      return parsed({ command: 'recreate' });
    case 'down':
      return parsed({ command: 'down', yes: takeYes(rest, command) });
    case 'build':
      noArguments(rest, command);
      return parsed({ command: 'build' });
    case 'deploy': {
      let image: string | undefined;
      let yes = false;
      for (let j = 0; j < rest.length; j++) {
        const arg = rest[j] as string;
        if (arg === '--yes') yes = true;
        else if (arg === '--image') image = rest[++j];
        else if (arg.startsWith('--image=')) image = arg.slice('--image='.length);
        else throw new UsageError(`deploy: unexpected argument ${arg}`);
      }
      if (image === undefined || image === '' || image.startsWith('-')) {
        throw new UsageError('deploy: --image <reference> is required');
      }
      if (!/^[A-Za-z0-9][A-Za-z0-9._/:@-]*$/.test(image)) throw new UsageError('deploy: invalid image reference');
      return parsed({ command: 'deploy', image, yes });
    }
    case 'auth': {
      const offline = rest[0] === '--offline';
      const args = offline ? rest.slice(1) : rest;
      if (args.length === 0) throw new UsageError('auth: name the operator command, e.g. `auth anthropic status`');
      return parsed({ command: 'auth', offline, args });
    }
    case 'tailscale': {
      const [sub, ...more] = rest;
      if (sub === 'status') {
        noArguments(more, 'tailscale status');
        return parsed({ command: 'tailscale-status' });
      }
      if (sub === 'enroll') {
        noArguments(more, 'tailscale enroll');
        return parsed({ command: 'tailscale-enroll' });
      }
      if (sub === 'recover') return parsed({ command: 'tailscale-recover', yes: takeYes(more, 'tailscale recover') });
      throw new UsageError('tailscale: use `tailscale status`, `tailscale enroll` or `tailscale recover`');
    }
    default:
      throw new UsageError(`unknown command ${command}\n\n${USAGE}`);
  }
}
