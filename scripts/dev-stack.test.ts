import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { composeArgs, composeSteps, DEFAULT_PROJECT, parseArgs, UsageError } from './dev-stack.ts';
import { repoRoot } from './lib/workspace.ts';

const env = { HOME: '/home/owner' };

describe('dev:stack', () => {
  test('targets the development project and its own environment file by default', () => {
    const invocation = parseArgs(['status'], env);
    expect(invocation).toEqual({
      command: 'status',
      project: DEFAULT_PROJECT,
      envFile: '/home/owner/.local/state/agent-runtime-dev/compose.env',
      rest: [],
    });
    expect(composeArgs(invocation)).toEqual([
      'docker',
      'compose',
      '-p',
      'agent-runtime-dev',
      '--env-file',
      '/home/owner/.local/state/agent-runtime-dev/compose.env',
      '-f',
      join(repoRoot, 'compose.yaml'),
      '-f',
      join(repoRoot, 'compose.dev.yaml'),
    ]);
  });

  test('accepts another development project and environment file', () => {
    const invocation = parseArgs(['--project', 'agent-runtime-dev2', '--env-file', '/srv/dev.env', 'up'], env);
    expect(invocation.project).toBe('agent-runtime-dev2');
    expect(invocation.envFile).toBe('/srv/dev.env');
    expect(
      parseArgs(['logs'], { ...env, AGENT_RUNTIME_DEV_PROJECT: 'mine', AGENT_RUNTIME_DEV_ENV_FILE: '/e' }),
    ).toEqual({ command: 'logs', project: 'mine', envFile: '/e', rest: [] });
  });

  test('never operates on the existing deployments, and never removes volumes or images', () => {
    for (const project of ['agent-runtime', 'agent-runtime-live']) {
      expect(() => parseArgs(['--project', project, 'down'], env)).toThrow(UsageError);
    }
    for (const flag of ['-v', '--volumes', '--rmi', '--rmi=all']) {
      expect(() => parseArgs(['down', flag], env)).toThrow('never removes volumes or images');
    }
    expect(() => parseArgs(['--env-file', 'relative.env', 'up'], env)).toThrow('absolute');
    expect(() => parseArgs(['--project', 'Bad Name', 'up'], env)).toThrow(UsageError);
    expect(() => parseArgs(['compose', 'down', '-v'], env)).toThrow('usage');
    expect(() => parseArgs([], env)).toThrow('usage');
  });

  test('rebuild rebuilds the image and recreates only the runtime on it', () => {
    const invocation = parseArgs(['rebuild'], env);
    const compose = composeArgs(invocation);
    expect(composeSteps(invocation, false)).toEqual([
      [...compose, 'build', 'runtime'],
      [...compose, 'up', '-d', 'tailscale', 'postgres'],
      [...compose, 'up', '-d', '--no-deps', '--force-recreate', 'runtime'],
    ]);
  });

  test('reload restarts the backend in place; stop and down keep every volume', () => {
    const steps = (...argv: string[]) => composeSteps(parseArgs(argv, env), false).map((step) => step.slice(10));
    expect(steps('reload')).toEqual([['kill', '-s', 'SIGHUP', 'runtime']]);
    expect(steps('recreate')).toEqual([['up', '-d', '--no-deps', '--force-recreate', 'runtime']]);
    expect(steps('stop')).toEqual([['stop']]);
    expect(steps('down')).toEqual([['down']]);
    expect(steps('logs')).toEqual([['logs', '-f', '--tail', '200', 'runtime']]);
    expect(steps('logs', 'tailscale')).toEqual([['logs', '-f', '--tail', '200', 'tailscale']]);
    expect(steps('logs', '--no-color')).toEqual([['logs', '--no-color', 'runtime']]);
    expect(steps('check')).toEqual([]);
  });

  test('auth runs the operator command from source, interactively only on a terminal', () => {
    const invocation = parseArgs(['auth', 'anthropic', 'status'], env);
    expect(composeSteps(invocation, true)[0]?.slice(10)).toEqual([
      'exec',
      '-it',
      'runtime',
      'bun',
      'packages/runtime/src/auth.ts',
      'anthropic',
      'status',
    ]);
    expect(composeSteps(invocation, false)[0]?.slice(10, 12)).toEqual(['exec', '-T']);
  });
});
