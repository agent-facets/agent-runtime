// `bun src/build.ts [outDir]`: builds the selected programs (none yet) and their manifest, by default into
// dist/programs. Nothing is downloaded: dependencies come from the frozen workspace installation.
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildPrograms } from './builder.ts';
import { PROGRAMS } from './programs.ts';

const packageRoot = resolve(import.meta.dir, '..');
const outDir = resolve(process.argv[2] ?? resolve(packageRoot, 'dist', 'programs'));
rmSync(outDir, { recursive: true, force: true });
const manifest = await buildPrograms({
  programs: PROGRAMS,
  packageRoot,
  outDir,
  lockfile: resolve(packageRoot, '..', '..', 'bun.lock'),
});
console.log(`built ${manifest.programs.length} MCP program(s) into ${outDir}`);
