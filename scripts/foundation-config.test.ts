import { describe, expect, test } from 'bun:test';
import { join, relative } from 'node:path';
import { dependencyFields, listWorkspacePackages, type PackageManifest, readJson, repoRoot } from './lib/workspace.ts';

interface RootManifest extends PackageManifest {
  packageManager: string;
  workspaces: string[];
}

interface TurboTask {
  dependsOn?: string[];
  inputs?: string[];
  outputs?: string[];
  cache?: boolean;
  persistent?: boolean;
}

interface TurboConfig {
  remoteCache?: { enabled?: boolean };
  globalDependencies?: string[];
  tasks: Record<string, TurboTask>;
}

const root = await readJson<RootManifest>(join(repoRoot, 'package.json'));
const turbo = await readJson<TurboConfig>(join(repoRoot, 'turbo.json'));
const mise = Bun.TOML.parse(await Bun.file(join(repoRoot, 'mise.toml')).text()) as { tools: Record<string, string> };
const packages = await listWorkspacePackages();

const exactVersion = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

describe('pinned toolchain', () => {
  test('Bun is pinned consistently and is the running version', () => {
    expect(mise.tools).toEqual({ bun: '1.3.14' });
    expect(root.packageManager).toBe(`bun@${mise.tools.bun}`);
    expect(Bun.version).toBe(mise.tools.bun as string);
  });

  test('every declared dependency is exact or a workspace link', () => {
    const loose: string[] = [];
    for (const manifest of [root, ...packages.map((pkg) => pkg.manifest)]) {
      for (const field of dependencyFields) {
        for (const [name, version] of Object.entries(manifest[field] ?? {})) {
          if (!exactVersion.test(version) && version !== 'workspace:*')
            loose.push(`${manifest.name}: ${name}@${version}`);
        }
      }
    }
    expect(loose).toEqual([]);
  });

  test('installed development tools match their pins', async () => {
    for (const name of ['turbo', 'typescript', '@biomejs/biome', '@types/bun']) {
      const installed = await readJson<{ version: string }>(join(repoRoot, 'node_modules', name, 'package.json'));
      expect(`${name}@${installed.version}`).toBe(`${name}@${root.devDependencies?.[name]}`);
    }
  });

  test('workspace packages resolve to local sources', async () => {
    const lock = await Bun.file(join(repoRoot, 'bun.lock')).text();
    for (const pkg of packages) {
      const location = relative(repoRoot, pkg.dir);
      expect(lock).toContain(`"${pkg.manifest.name}": ["${pkg.manifest.name}@workspace:${location}"]`);
    }
  });
});

describe('task graph and cache policy', () => {
  test('the workspace covers the runtime and UI packages', () => {
    expect(root.workspaces).toEqual(['packages/*']);
  });

  test('Turbo caching is local-only and telemetry is disabled for every Turbo command', () => {
    expect(turbo.remoteCache?.enabled).toBe(false);
    const turboScripts = Object.entries(root.scripts ?? {}).filter(([, command]) => /\bturbo\b/.test(command));
    expect(turboScripts.length).toBeGreaterThan(0);
    for (const [, command] of turboScripts) {
      expect(command).toStartWith('TURBO_TELEMETRY_DISABLED=1 DO_NOT_TRACK=1 turbo run ');
    }
  });

  test('check aggregates lint, typechecks, tests and the application build', () => {
    expect(new Set(turbo.tasks.check?.dependsOn)).toEqual(
      new Set(['//#lint', '//#typecheck:scripts', '//#test:scripts', 'typecheck', 'test', 'build']),
    );
    expect(root.scripts?.check).toEndWith('turbo run check');
    expect(root.scripts?.['check:verify']).toEndWith('turbo run check --force');
  });

  test('consumer tasks are invalidated by dependency sources and shared configuration', () => {
    expect(turbo.tasks.transit?.dependsOn).toEqual(['^transit']);
    for (const task of ['build', 'typecheck', 'test']) {
      expect(turbo.tasks[task]?.dependsOn).toContain('transit');
    }
    expect(turbo.globalDependencies).toEqual(
      expect.arrayContaining(['bun.lock', 'bunfig.toml', 'mise.toml', 'package.json', 'tsconfig.base.json']),
    );
  });

  test('repository-level tasks that inspect packages hash package sources', () => {
    for (const task of ['//#lint', '//#typecheck:scripts', '//#test:scripts']) {
      expect(turbo.tasks[task]?.inputs).toEqual(expect.arrayContaining(['$TURBO_DEFAULT$', 'packages/**']));
    }
  });

  test('builds declare their actual outputs and long-running tasks are never cached', () => {
    expect(turbo.tasks.build?.outputs).toEqual(['dist/**']);
    for (const task of ['dev', 'start']) {
      expect(turbo.tasks[task]).toEqual({ cache: false, persistent: true });
    }
  });

  test('integration and container suites stay outside Turbo and ordinary checks', () => {
    const turboTasks = JSON.stringify(turbo.tasks);
    expect(turboTasks).not.toContain('integration');
    expect(turboTasks).not.toContain('container');
    expect(root.scripts?.['test:integration']).toStartWith('bun --no-env-file ');
    expect(root.scripts?.['test:container']).toStartWith('bun --no-env-file ');
  });
});
