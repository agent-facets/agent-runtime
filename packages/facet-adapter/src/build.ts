// Builds the installable adapter: a self-contained ES module plus a minimal package manifest, which
// `facet adapter add` uses as-is (no dependency installation or network access is needed).
import { rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ADAPTER_API, ADAPTER_NAME } from './toolchain.ts';

const packageDir = resolve(import.meta.dir, '..');
const outDir = join(packageDir, 'dist', 'adapter');
rmSync(outDir, { recursive: true, force: true });

const result = await Bun.build({
  entrypoints: [join(packageDir, 'src', 'adapter.ts')],
  outdir: outDir,
  naming: 'index.mjs',
  target: 'bun',
  format: 'esm',
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

await Bun.write(
  join(outDir, 'package.json'),
  `${JSON.stringify(
    {
      name: `${ADAPTER_NAME}-facet-adapter`,
      private: true,
      type: 'module',
      main: './index.mjs',
      facetAdapterApiVersion: ADAPTER_API,
    },
    null,
    2,
  )}\n`,
);
