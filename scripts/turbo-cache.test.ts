// Synthetic workspace using the repository's Turbo task graph: a source-only library consumed by a built app.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runCommand } from './lib/fixture-env.ts';
import { repoRoot } from './lib/workspace.ts';

const scratch = mkdtempSync(join(tmpdir(), 'agent-runtime-turbo-'));
const turbo = join(repoRoot, 'node_modules', '.bin', 'turbo');
const env = {
  PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ''}`,
  HOME: scratch,
  TURBO_TELEMETRY_DISABLED: '1',
  DO_NOT_TRACK: '1',
};

const write = (path: string, content: string) => {
  mkdirSync(dirname(join(scratch, path)), { recursive: true });
  writeFileSync(join(scratch, path), content);
};

beforeAll(async () => {
  // The repository ignore rules keep build outputs out of task inputs.
  for (const file of ['turbo.json', 'bunfig.toml', 'mise.toml', 'tsconfig.base.json', '.gitignore']) {
    copyFileSync(join(repoRoot, file), join(scratch, file));
  }
  write(
    'package.json',
    JSON.stringify({ name: 'fixture-root', private: true, packageManager: 'bun@1.3.14', workspaces: ['packages/*'] }),
  );
  write(
    'packages/lib/package.json',
    JSON.stringify({ name: 'lib', private: true, exports: { '.': './src/index.ts' }, scripts: { typecheck: 'true' } }),
  );
  write('packages/lib/src/index.ts', "export const value = 'one';\n");
  write(
    'packages/app/package.json',
    JSON.stringify({
      name: 'app',
      private: true,
      dependencies: { lib: 'workspace:*' },
      scripts: {
        typecheck: 'true',
        build: "bun -e \"await Bun.write('dist/out.txt', (await import('lib')).value)\"",
      },
    }),
  );
  write('packages/app/src/index.ts', "export { value } from 'lib';\n");
  await runCommand([process.execPath, 'install'], { env, cwd: scratch });
  await runCommand(['git', 'init', '--quiet'], { env, cwd: scratch });
});

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

interface DryRun {
  tasks: { taskId: string; hash: string }[];
}

const hashes = async (task: string) => {
  const { stdout } = await runCommand([turbo, 'run', task, '--dry=json'], { env, cwd: scratch });
  return Object.fromEntries((JSON.parse(stdout) as DryRun).tasks.map((entry) => [entry.taskId, entry.hash]));
};

describe('Turbo cache invalidation', () => {
  test('a source-only dependency change invalidates consumer typecheck and build', async () => {
    const [typecheckBefore, buildBefore] = [await hashes('typecheck'), await hashes('build')];
    write('packages/lib/src/index.ts', "export const value = 'two';\n");
    const [typecheckAfter, buildAfter] = [await hashes('typecheck'), await hashes('build')];
    expect(typecheckAfter['app#typecheck']).not.toBe(typecheckBefore['app#typecheck']);
    expect(buildAfter['app#build']).not.toBe(buildBefore['app#build']);
  });

  test('shared configuration changes invalidate every package task', async () => {
    const before = await hashes('typecheck');
    write('tsconfig.base.json', '{ "compilerOptions": { "strict": true } }\n');
    const after = await hashes('typecheck');
    for (const task of ['app#typecheck', 'lib#typecheck']) expect(after[task]).not.toBe(before[task]);
  });

  test('a warm build cache hit restores the actual deployable output', async () => {
    const first = await runCommand([turbo, 'run', 'build'], { env, cwd: scratch });
    expect(first.stdout).toContain('Remote caching disabled');
    const output = join(scratch, 'packages/app/dist/out.txt');
    const built = await Bun.file(output).text();
    rmSync(join(scratch, 'packages/app/dist'), { recursive: true });
    expect(existsSync(output)).toBe(false);

    const second = await runCommand([turbo, 'run', 'build'], { env, cwd: scratch });
    expect(second.stdout).toContain('app:build: cache hit');
    expect(await Bun.file(output).text()).toBe(built);

    const forced = await runCommand([turbo, 'run', 'build', '--force'], { env, cwd: scratch });
    expect(forced.stdout).not.toContain('cache hit');
  });
});
