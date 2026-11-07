// Build step, never imported by the application: `bun src/build/build.ts <outdir>` bundles the server, the auth
// command and the console beside them. It uses Bun.build rather than the `bun build` command because the console's
// stylesheet is compiled by the Tailwind plugin, which only the API accepts. The plugin runs here, at build time;
// the bundle never loads it.
import { resolve } from 'node:path';
import tailwind from 'bun-plugin-tailwind';

const outdir = process.argv[2];
if (outdir === undefined) throw new Error('usage: build.ts <outdir>');
const packageRoot = resolve(import.meta.dir, '..', '..');

const built = await Bun.build({
  entrypoints: [resolve(packageRoot, 'src/main.ts'), resolve(packageRoot, 'src/auth.ts')],
  target: 'bun',
  root: resolve(packageRoot, '..'),
  outdir: resolve(packageRoot, outdir),
  naming: { entry: '[name].[ext]' },
  minify: true,
  define: { 'process.env.NODE_ENV': '"production"' },
  plugins: [tailwind],
  // Only loaded when the console is bundled from source, which a built server never does.
  external: ['bun-plugin-tailwind'],
});
if (!built.success) {
  for (const log of built.logs) console.error(log);
  process.exit(1);
}
for (const output of built.outputs) console.log(`${output.path.slice(packageRoot.length + 1)}  ${output.size} bytes`);
