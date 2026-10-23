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

  test('the runtime manifest covers the execution closure, the saver and no browser or server code', async () => {
    const manifest = await currentCodeManifest();
    const paths = manifest.executionCode.map((entry) => entry.path);
    for (const root of EXECUTION_ROOTS) expect(paths).toContain(root);
    expect(paths).toContain('src/execution/tools.ts');
    expect(paths).toContain('src/security/pre-graph.ts');
    expect(paths.some((path) => path.startsWith('src/server') || path.includes('/ui/'))).toBe(false);
    const names = manifest.packages.map((entry) => entry.name);
    for (const name of [
      'langchain',
      '@langchain/core',
      '@langchain/langgraph',
      '@langchain/langgraph-checkpoint-postgres',
      'zod',
    ]) {
      expect(names).toContain(name);
    }
    expect(names).not.toContain('turbo');
    expect(names).not.toContain('@biomejs/biome');
  });

  test('the build writes the same manifest beside the bundle', async () => {
    const outdir = join(scratch, 'dist');
    mkdirSync(outdir);
    const child = Bun.spawnSync([process.execPath, '--no-env-file', 'src/build/write-code-manifest.ts', outdir], {
      cwd: PACKAGE_ROOT,
    });
    expect(child.exitCode).toBe(0);
    const written = await Bun.file(join(outdir, CODE_MANIFEST_FILE)).json();
    expect(written).toEqual(await currentCodeManifest());
    const build = (await Bun.file(resolve(PACKAGE_ROOT, 'package.json')).json()).scripts.build as string;
    expect(build).toContain('src/build/write-code-manifest.ts dist');
  });
});
