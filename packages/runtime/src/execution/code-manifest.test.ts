import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  CODE_MANIFEST_FILE,
  computeCodeManifest,
  currentCodeManifest,
  EXECUTION_ROOTS,
  PACKAGE_ROOT,
  PROVIDER_ROOTS,
} from './code-manifest.ts';

const scratch = mkdtempSync(join(tmpdir(), 'agent-runtime-manifest-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const LOCK = `{
  "lockfileVersion": 1,
  "packages": {
    "zod": ["zod@4.6.5", "", {}, "sha512-zod"],
    "lib": ["lib@1.0.0", "", { "dependencies": { "dep": "^2.0.0" } }, "sha512-lib"],
    "dep": ["dep@2.0.0", "", {}, "sha512-dep-hoisted"],
    "lib/dep": ["dep@2.1.0", "", {}, "sha512-dep-nested"],
    "unrelated": ["unrelated@9.9.9", "", {}, "sha512-unrelated"],
    "@ws/sub": ["@ws/sub@workspace:packages/sub"],
  },
}`;

let counter = 0;
/** A synthetic package: a root importing a helper and a library, plus an unrelated module and a UI file. */
function tree(files: Record<string, string> = {}) {
  const root = join(scratch, `pkg-${++counter}`);
  const all: Record<string, string> = {
    'src/root.ts':
      "import { helper } from './helper.ts';\nimport 'lib/sub/path';\nimport { z } from 'zod';\nimport 'node:fs';\nexport const x = helper;\n",
    'src/helper.ts': 'export const helper = 1;\n',
    'src/unrelated.ts': "import 'unrelated';\n",
    'README.md': 'docs\n',
    ...files,
  };
  for (const [path, contents] of Object.entries(all)) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), contents);
  }
  writeFileSync(join(root, 'bun.lock'), LOCK);
  return computeCodeManifest({
    packageRoot: root,
    lockfile: join(root, 'bun.lock'),
    roots: ['src/root.ts'],
    declaredPackages: [],
  });
}

describe('execution code manifest', () => {
  test('covers the owned import closure and the packages it uses, transitively, with nested resolution', () => {
    const manifest = tree();
    expect(manifest.executionCode.map((entry) => entry.path)).toEqual(['src/helper.ts', 'src/root.ts']);
    expect(manifest.packages).toEqual([
      { name: 'lib', version: '1.0.0', integrity: 'sha512-lib' },
      { name: 'lib/dep', version: '2.1.0', integrity: 'sha512-dep-nested' },
      { name: 'zod', version: '4.6.5', integrity: 'sha512-zod' },
    ]);
  });

  test('line endings, documentation and modules outside the closure do not change it', () => {
    const base = tree();
    expect(tree({ 'src/helper.ts': 'export const helper = 1;\r\n' })).toEqual(base);
    expect(tree({ 'README.md': 'different docs\n', 'src/unrelated.ts': 'export {};\n' })).toEqual(base);
    expect(tree({ 'packages-ui/app.tsx': 'export const App = 1;\n' })).toEqual(base);
  });

  test('a changed helper in the closure changes it', () => {
    const base = tree();
    const changed = tree({ 'src/helper.ts': 'export const helper = 2;\n' });
    expect(changed.executionCode).not.toEqual(base.executionCode);
    expect(changed.packages).toEqual(base.packages);
  });

  test('a package missing from the lockfile or code outside the package source is refused', () => {
    expect(() => tree({ 'src/helper.ts': "import 'missing-package';\n" })).toThrow('not in the lockfile');
    expect(() => tree({ 'src/helper.ts': "import '../../elsewhere.ts';\n" })).toThrow('outside the package source');
  });

  test('a workspace package joins the closure through its public entry, file by file', () => {
    const workspace = {
      'packages/sub/package.json': JSON.stringify({ name: '@ws/sub', exports: { '.': './src/index.ts' } }),
      'packages/sub/src/index.ts': "export { helper } from './helper.ts';\nimport 'node:crypto';\n",
      'packages/sub/src/helper.ts': 'export const helper = 1;\n',
      'packages/sub/src/unused.ts': 'export const unused = 1;\n',
      'packages/sub/README.md': 'docs\n',
    };
    const base = tree({ ...workspace, 'src/helper.ts': "import '@ws/sub';\nexport const helper = 1;\n" });
    expect(base.executionCode.map((entry) => entry.path)).toEqual([
      'packages/sub/src/helper.ts',
      'packages/sub/src/index.ts',
      'src/helper.ts',
      'src/root.ts',
    ]);
    expect(base.packages.map((entry) => entry.name)).not.toContain('@ws/sub');

    const changed = tree({
      ...workspace,
      'packages/sub/src/helper.ts': 'export const helper = 2;\n',
      'src/helper.ts': "import '@ws/sub';\nexport const helper = 1;\n",
    });
    expect(changed.executionCode).not.toEqual(base.executionCode);
    const unrelated = tree({
      ...workspace,
      'packages/sub/src/unused.ts': 'export const unused = 2;\n',
      'packages/sub/README.md': 'other docs\n',
      'src/helper.ts': "import '@ws/sub';\nexport const helper = 1;\n",
    });
    expect(unrelated).toEqual(base);
  });

  test('a workspace package imported past its entry, or without one, is refused', () => {
    const entry = { 'packages/sub/src/index.ts': 'export {};\n', 'packages/sub/src/inner.ts': 'export {};\n' };
    expect(() =>
      tree({
        ...entry,
        'packages/sub/package.json': JSON.stringify({ exports: { '.': './src/index.ts' } }),
        'src/helper.ts': "import '@ws/sub/src/inner.ts';\n",
      }),
    ).toThrow('past its public entry');
    expect(() =>
      tree({ ...entry, 'packages/sub/package.json': JSON.stringify({}), 'src/helper.ts': "import '@ws/sub';\n" }),
    ).toThrow('no public entry');
    expect(() =>
      tree({
        ...entry,
        'packages/sub/package.json': JSON.stringify({ exports: { '.': './index.ts' } }),
        'packages/sub/index.ts': 'export {};\n',
        'src/helper.ts': "import '@ws/sub';\n",
      }),
    ).toThrow('outside its source');
  });

  test('each provider manifest covers the common closure, its own adapter and nothing of the other', async () => {
    const anthropic = await currentCodeManifest('anthropic');
    const openai = await currentCodeManifest('openai');
    const paths = (manifest: typeof anthropic) => manifest.executionCode.map((entry) => entry.path);
    const names = (manifest: typeof anthropic) => manifest.packages.map((entry) => entry.name);
    for (const manifest of [anthropic, openai]) {
      for (const root of EXECUTION_ROOTS) expect(paths(manifest)).toContain(root);
      expect(paths(manifest)).toContain('src/execution/tools.ts');
      expect(paths(manifest)).toContain('src/security/pre-graph.ts');
      expect(paths(manifest).some((path) => path.startsWith('src/server') || path.includes('/ui/'))).toBe(false);
      for (const name of [
        'langchain',
        '@langchain/core',
        '@langchain/langgraph',
        '@langchain/langgraph-checkpoint-postgres',
        'zod',
      ]) {
        expect(names(manifest)).toContain(name);
      }
      expect(names(manifest)).not.toContain('turbo');
      expect(names(manifest)).not.toContain('@biomejs/biome');
    }
    for (const root of PROVIDER_ROOTS.anthropic) expect(paths(anthropic)).toContain(root);
    // The internal subscription package's execution-used sources are part of Anthropic runs' definition.
    for (const file of ['index.ts', 'request.ts', 'billing.ts', 'profile.ts', 'response.ts', 'auth.ts']) {
      expect(paths(anthropic)).toContain(`../anthropic-subscription/src/${file}`);
    }
    expect(paths(anthropic).some((path) => path.includes('.test.') || path.includes('test-support'))).toBe(false);
    expect(names(anthropic)).toEqual(expect.arrayContaining(['@langchain/anthropic', '@anthropic-ai/sdk']));
    expect(names(anthropic)).not.toContain('@langchain/openai');

    for (const root of PROVIDER_ROOTS.openai) expect(paths(openai)).toContain(root);
    expect(paths(openai).some((path) => path.startsWith('../anthropic-subscription/'))).toBe(false);
    expect(names(openai)).toEqual(expect.arrayContaining(['@langchain/openai', 'openai']));
    expect(names(openai)).not.toContain('@langchain/anthropic');
  });

  test('the build writes the same per-provider manifests beside the bundle', async () => {
    const outdir = join(scratch, 'dist');
    mkdirSync(outdir);
    const child = Bun.spawnSync([process.execPath, '--no-env-file', 'src/build/write-code-manifest.ts', outdir], {
      cwd: PACKAGE_ROOT,
    });
    expect(child.exitCode).toBe(0);
    const written = await Bun.file(join(outdir, CODE_MANIFEST_FILE)).json();
    expect(written).toEqual({
      version: 2,
      providers: { anthropic: await currentCodeManifest('anthropic'), openai: await currentCodeManifest('openai') },
    });
    const build = (await Bun.file(resolve(PACKAGE_ROOT, 'package.json')).json()).scripts.build as string;
    expect(build).toContain('src/build/write-code-manifest.ts dist');
  });
});
