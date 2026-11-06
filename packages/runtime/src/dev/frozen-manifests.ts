// Development only. Running from source, the execution-code manifest would otherwise be computed from the files on
// disk for every run, so an edit made before the supervisor restarts this process would be recorded as code it
// never loaded. It is computed once at startup instead, before any run is admitted, for every provider. An edit
// during startup restarts the process anyway.
import {
  type CodeManifest,
  currentCodeManifest,
  NoProviderAdapter,
  PROVIDER_ROOTS,
} from '../execution/code-manifest.ts';
import type { Provider } from '../records/schemas.ts';

export async function frozenCodeManifests(): Promise<(provider: Provider) => Promise<CodeManifest>> {
  const manifests = new Map<Provider, CodeManifest>();
  for (const provider of Object.keys(PROVIDER_ROOTS) as Provider[]) {
    manifests.set(provider, await currentCodeManifest(provider));
  }
  return async (provider) => {
    const manifest = manifests.get(provider);
    if (manifest === undefined) throw new NoProviderAdapter(provider);
    return manifest;
  };
}
