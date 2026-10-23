import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { repoRoot } from './lib/workspace.ts';
import { planRun, RefusedRun, TURBO_TASKS } from './run-turbo.ts';

describe('Turbo runner', () => {
  test('accepts each repository task, alone or forced', () => {
    for (const task of TURBO_TASKS) {
      expect(planRun([task], {})).toEqual({ task, force: false });
      expect(planRun([task, '--force'], {})).toEqual({ task, force: true });
    }
  });

  test('refuses unknown tasks and extra arguments', () => {
    expect(() => planRun([], {})).toThrow(RefusedRun);
    expect(() => planRun(['dev'], {})).toThrow('unknown task dev');
    expect(() => planRun(['check', '--filter=runtime'], {})).toThrow('unexpected arguments: --filter=runtime');
    expect(() => planRun(['check', '--force', '--force'], {})).toThrow('unexpected arguments');
  });

  test('check refuses the overrides fixtures refuse; tasks without fixtures do not', () => {
    const env = { ANTHROPIC_API_KEY: 'x', DATABASE_URL: 'postgres://owner', PATH: '/bin' };
    expect(() => planRun(['check'], env)).toThrow('refused environment overrides: ANTHROPIC_API_KEY, DATABASE_URL');
    expect(() => planRun(['check', '--force'], env)).toThrow(RefusedRun);
    expect(planRun(['build'], env)).toEqual({ task: 'build', force: false });
  });

  test('a refused check stops before Turbo, so a cached result cannot stand in for the refusal', async () => {
    const proc = Bun.spawn([process.execPath, '--no-env-file', join(repoRoot, 'scripts', 'run-turbo.ts'), 'check'], {
      cwd: repoRoot,
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', COMPOSE_PROJECT_NAME: 'owner' },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expect(code).toBe(1);
    expect(stderr).toContain('check refuses to start: refused environment overrides: COMPOSE_PROJECT_NAME');
    expect(stdout).toBe('');
  });
});
