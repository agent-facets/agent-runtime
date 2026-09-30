// Build step, never imported by the application: `bun src/build/write-code-manifest.ts <outdir>` writes the
// execution-code manifest beside the bundle, so the image can compare runs without shipping source.
import { resolve } from 'node:path';
import { CODE_MANIFEST_FILE, computeCodeManifest, PACKAGE_ROOT } from '../execution/code-manifest.ts';

const outdir = process.argv[2];
if (outdir === undefined) throw new Error('usage: write-code-manifest.ts <outdir>');
const manifest = computeCodeManifest({
  packageRoot: PACKAGE_ROOT,
  lockfile: resolve(PACKAGE_ROOT, '..', '..', 'bun.lock'),
});
await Bun.write(resolve(outdir, CODE_MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`);
