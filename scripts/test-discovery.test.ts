import { afterAll, describe, expect, test } from 'bun:test';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { listSourceFiles, listWorkspacePackages, repoRoot } from './lib/workspace.ts';

const scratch = mkdtempSync(join(tmpdir(), 'agent-runtime-discovery-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe('bare root bun test discovery', () => {
  test('runs package and script unit suites but never spikes, fixtures, generated or live suites', async () => {
    copyFileSync(join(repoRoot, 'bunfig.toml'), join(scratch, 'bunfig.toml'));
    const markers = join(scratch, 'markers');
    mkdirSync(markers);
    const files = {
      included: ['packages/example/src/unit.test.ts', 'scripts/repository.test.ts'],
      excluded: [
        'spikes/historical/src/spike.test.ts',
        'tests/integration/database.integration.test.ts',
        'tests/container/smoke.test.ts',
        'tmp/scratch.test.ts',
        'packages/example/dist/bundled.test.ts',
        'packages/example/src/provider.live.test.ts',
        'packages/example/src/storage.integration.test.ts',
        'openspec/changes/example.test.ts',
      ],
    };
    for (const file of [...files.included, ...files.excluded]) {
      const path = join(scratch, file);
      mkdirSync(dirname(path), { recursive: true });
      const marker = join(markers, file.replaceAll('/', '__'));
      writeFileSync(
        path,
        `import { test } from 'bun:test';\nimport { writeFileSync } from 'node:fs';\ntest('ran', () => writeFileSync(${JSON.stringify(marker)}, ''));\n`,
      );
    }

    const proc = Bun.spawn([process.execPath, '--no-env-file', 'test'], {
      cwd: scratch,
      env: { PATH: process.env.PATH ?? '' },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const code = await proc.exited;
    expect(code).toBe(0);
    expect(readdirSync(markers).sort()).toEqual(files.included.map((file) => file.replaceAll('/', '__')).sort());
  });
});

interface DryRunTask {
  taskId: string;
  command: string;
}

describe('Turbo test graph', () => {
  test('includes every package unit suite and repository script tests, and nothing else', async () => {
    const proc = Bun.spawn([join(repoRoot, 'node_modules', '.bin', 'turbo'), 'run', 'test:all', '--dry=json'], {
      cwd: repoRoot,
      env: {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '',
        TURBO_TELEMETRY_DISABLED: '1',
        DO_NOT_TRACK: '1',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const output = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    const tasks = (JSON.parse(output) as { tasks: DryRunTask[] }).tasks.filter(
      (task) => task.command !== '<NONEXISTENT>',
    );

    const expected = ['//#test:scripts'];
    for (const pkg of await listWorkspacePackages()) {
      const hasTests =
        existsSync(join(pkg.dir, 'src')) && listSourceFiles(join(pkg.dir, 'src')).some((f) => /\.test\.tsx?$/.test(f));
      if (hasTests) {
        expect(`${relative(repoRoot, pkg.dir)} test script: ${pkg.manifest.scripts?.test}`).toBe(
          `${relative(repoRoot, pkg.dir)} test script: bun test`,
        );
        expected.push(`${pkg.manifest.name}#test`);
      }
    }
    expect(tasks.map((task) => task.taskId).sort()).toEqual(expected.sort());
    expect(tasks.some((task) => /integration|container|live/.test(task.command))).toBe(false);
  });
});
