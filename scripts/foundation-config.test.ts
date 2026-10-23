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
  env?: string[];
  passThroughEnv?: string[];
  cache?: boolean;
  persistent?: boolean;
}

interface TurboConfig {
  remoteCache?: { enabled?: boolean; teamSlug?: string };
  globalDependencies?: string[];
  globalEnv?: string[];
  tasks: Record<string, TurboTask>;
}

const FIXTURE_SUITES = ['//#test:facets', '//#test:integration', '//#test:browser', '//#test:container'];

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

  test('Turbo shares the team remote cache, keyed by platform, and every Turbo command goes through the runner', () => {
    expect(turbo.remoteCache).toEqual({ teamSlug: 'agent-facets' });
    expect(turbo.globalEnv).toEqual(['CHECK_PLATFORM']);
    const turboScripts = Object.entries(root.scripts ?? {}).filter(([, command]) => /\bturbo\b/.test(command));
    expect(turboScripts.map(([name]) => name).sort()).toEqual(['build', 'check', 'check:verify', 'test', 'typecheck']);
    for (const [, command] of turboScripts) {
      expect(command).toStartWith('bun --no-env-file scripts/run-turbo.ts ');
    }
  });

  test('check aggregates lint, typechecks, unit tests, the build and every fixture suite', () => {
    expect(new Set(turbo.tasks.check?.dependsOn)).toEqual(
      new Set(['//#lint', '//#typecheck:scripts', '//#test:scripts', 'typecheck', 'test', 'build', ...FIXTURE_SUITES]),
    );
    expect(root.scripts?.check).toBe('bun --no-env-file scripts/run-turbo.ts check');
    expect(root.scripts?.['check:verify']).toBe('bun --no-env-file scripts/run-turbo.ts check --force');
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

  test('fixture suites run one at a time, keyed by the fixture toolchain, and restore no files', () => {
    expect(turbo.tasks['//#test:facets']?.dependsOn).toEqual(['@agent-runtime/facet-adapter#build']);
    for (const [previous, suite] of FIXTURE_SUITES.slice(1).map((suite, i) => [FIXTURE_SUITES[i], suite])) {
      expect(turbo.tasks[suite as string]?.dependsOn).toEqual([previous as string]);
    }
    for (const suite of FIXTURE_SUITES) {
      const task = turbo.tasks[suite];
      expect(task?.env).toEqual(['CHECK_FIXTURE_TOOLCHAIN']);
      expect(task?.outputs).toBeUndefined();
      expect(task?.cache).toBeUndefined();
      expect(task?.inputs).toEqual(
        expect.arrayContaining([
          '$TURBO_DEFAULT$',
          'packages/**',
          '!packages/*/dist/**',
          '!packages/*/node_modules/**',
        ]),
      );
      expect(root.scripts?.[suite.slice(3)]).toStartWith('bun --no-env-file scripts/');
    }
  });
});
