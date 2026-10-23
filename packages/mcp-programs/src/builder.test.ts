import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  buildPrograms,
  PROGRAM_MANIFEST_FILE,
  ProgramBuildError,
  type ProgramManifest,
  verifyPrograms,
} from './builder.ts';
import { PROGRAMS } from './programs.ts';

const packageRoot = resolve(import.meta.dir, '..');
const lockfile = resolve(packageRoot, '..', '..', 'bun.lock');
const scratch = mkdtempSync(join(tmpdir(), 'agent-runtime-mcp-programs-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
let counter = 0;
const outDir = () => join(scratch, `out-${++counter}`);

// A minimal synthetic server, supplied in memory beside the package so it resolves the pinned SDK.
const SERVER = `
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
const server = new McpServer({ name: 'synthetic', version: '1.0.0' });
server.registerTool('ping', { description: 'Replies pong.' }, async () => ({ content: [{ type: 'text', text: 'pong' }] }));
await server.connect(new StdioServerTransport());
`;
const entry = (name: string) => resolve(packageRoot, `virtual-${name}.ts`);
const build = (sources: Record<string, string>, out = outDir()) =>
  buildPrograms({
    programs: Object.keys(sources).map((id) => ({ id, entry: `virtual-${id}.ts` })),
    packageRoot,
    outDir: out,
    lockfile,
    files: Object.fromEntries(Object.entries(sources).map(([id, source]) => [entry(id), source])),
  });
const refusal = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ProgramBuildError) return error.reason;
    throw error;
  }
  return 'built';
};

describe('MCP program bundles', () => {
  test('the shipped inventory selects no production server', () => {
    expect(PROGRAMS).toEqual([]);
  });

  test('builds one self-contained, content-addressed bundle with exact dependency provenance', async () => {
    const out = outDir();
    const manifest = await build({ synthetic: SERVER }, out);
    const [program] = manifest.programs;
    if (program === undefined) throw new Error('expected a program');
    expect(manifest.bun).toBe(Bun.version);
    expect(program.path).toBe(`synthetic/${program.sha256}.js`);
    const bytes = readFileSync(join(out, program.path));
    expect(new Bun.CryptoHasher('sha256').update(bytes).digest('hex')).toBe(program.sha256);
    expect(readdirSync(join(out, 'synthetic'))).toEqual([`${program.sha256}.js`]);
    expect(program.dependencies).toContainEqual({
      name: '@modelcontextprotocol/sdk',
      version: '1.32.1',
      integrity: 'sha512-2DdE+SJDtzLEEWzY1ZjY7Q+VcPhcV1KisD3zI4u0XZyktsjHum1mwbMI+JaulUBi2OZk+KJAi2uPXzxichPkdw==',
    });
    expect(program.dependencies.find((dependency) => dependency.name === 'zod')?.version).toBe('4.6.5');
    // No import is left for the runtime to resolve or install.
    expect(new TextDecoder().decode(bytes)).not.toMatch(/from\s*["']@modelcontextprotocol|from\s*["']zod["']/);
    expect(JSON.parse(readFileSync(join(out, PROGRAM_MANIFEST_FILE), 'utf8'))).toEqual(manifest);
  });

  test('the same inputs reproduce the same bytes and digest', async () => {
    const first = await build({ synthetic: SERVER });
    const second = await build({ synthetic: SERVER });
    expect(second.programs[0]?.sha256).toBe(first.programs[0]?.sha256 as string);
  });

  test('refuses native addons, unresolved packages and invalid or duplicate program IDs', async () => {
    writeFileSync(join(scratch, 'addon.node'), 'not really native');
    expect(
      await refusal(build({ native: `import addon from '${join(scratch, 'addon.node')}'; console.log(addon);` })),
    ).toBe('native_dependency');
    expect(await refusal(build({ missing: "import x from 'definitely-not-installed-package'; console.log(x);" }))).toBe(
      'build_failed',
    );
    expect(
      await refusal(
        buildPrograms({ programs: [{ id: 'Bad Id', entry: 'x.ts' }], packageRoot, outDir: outDir(), lockfile }),
      ),
    ).toBe('invalid_program_id');
    expect(
      await refusal(
        buildPrograms({
          programs: [
            { id: 'twice', entry: 'virtual-twice.ts' },
            { id: 'twice', entry: 'virtual-twice.ts' },
          ],
          packageRoot,
          outDir: outDir(),
          lockfile,
          files: { [entry('twice')]: 'console.log(1);' },
        }),
      ),
    ).toBe('invalid_program_id');
  });

  test('built-in modules are allowed; nothing else may stay external', async () => {
    const manifest = await build({ builtins: "import { join } from 'node:path'; console.log(join('a', 'b'));" });
    expect(manifest.programs[0]?.dependencies).toEqual([]);
  });

  test('verification reports missing or altered bundles without rebuilding them', async () => {
    const out = outDir();
    const manifest: ProgramManifest = await build({ synthetic: SERVER }, out);
    expect(verifyPrograms(out, manifest)).toEqual({ ok: true });
    const path = join(out, manifest.programs[0]?.path as string);
    writeFileSync(path, `${readFileSync(path, 'utf8')}\n// altered\n`);
    expect(verifyPrograms(out, manifest)).toEqual({ ok: false, program: 'synthetic', reason: 'tampered' });
    rmSync(path);
    expect(verifyPrograms(out, manifest)).toEqual({ ok: false, program: 'synthetic', reason: 'missing' });
  });
});
