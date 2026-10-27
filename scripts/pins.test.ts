// The repository's pinned toolchain, in one snapshot. A pin change shows up as a reviewed diff here and nowhere else;
// accept it with `bun test scripts/pins.test.ts --update-snapshots`. Each value is read from where it is pinned.
import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { ADAPTER_API, ADAPTER_SDK_VERSION, PINNED_CLI } from '../packages/facet-adapter/src/toolchain.ts';
import { type PackageManifest, readJson, repoRoot } from './lib/workspace.ts';

test('pinned toolchain', async () => {
  const root = await readJson<PackageManifest & { packageManager: string }>(join(repoRoot, 'package.json'));
  const mise = Bun.TOML.parse(await Bun.file(join(repoRoot, 'mise.toml')).text()) as { tools: Record<string, unknown> };
  const compose = Bun.YAML.parse(await Bun.file(join(repoRoot, 'compose.yaml')).text()) as {
    services: Record<string, { image?: string }>;
  };
  const dockerfile = await Bun.file(join(repoRoot, 'Dockerfile')).text();

  const devTools: Record<string, { declared: string; installed: string }> = {};
  for (const [name, declared] of Object.entries(root.devDependencies ?? {}).sort()) {
    const installed = await readJson<{ version: string }>(join(repoRoot, 'node_modules', name, 'package.json'));
    devTools[name] = { declared, installed: installed.version };
  }

  expect({
    mise: mise.tools,
    bun: { packageManager: root.packageManager, running: Bun.version },
    facetCli: { ...PINNED_CLI, adapterSdk: ADAPTER_SDK_VERSION, adapterApi: ADAPTER_API },
    images: {
      dockerfile: [...dockerfile.matchAll(/^FROM\s+(\S+)/gm)].map((match) => match[1]),
      compose: Object.fromEntries(
        Object.entries(compose.services)
          .filter(([, service]) => service.image !== undefined && !service.image.startsWith('$'))
          .map(([name, service]) => [name, service.image]),
      ),
    },
    devTools,
  }).toMatchSnapshot();
});
