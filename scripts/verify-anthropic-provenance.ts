// Checks packages/anthropic-subscription/provenance.json against upstream, or reports what differs at a candidate
// revision when reviewing an update. Uses the network (npm registry, GitHub); it is an explicit maintenance command,
// never part of `check`. It writes nothing.
//
//   bun run provenance:anthropic                                   # verify the recorded baseline
//   bun run provenance:anthropic -- --version <v> --revision <sha>  # review a candidate update
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { compareProvenance, type ObservedUpstream, type RecordedProvenance } from './lib/provenance.ts';
import { repoRoot } from './lib/workspace.ts';

const recorded = (await Bun.file(
  join(repoRoot, 'packages', 'anthropic-subscription', 'provenance.json'),
).json()) as RecordedProvenance & { upstream: { repository: string } };

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: { version: { type: 'string' }, revision: { type: 'string' } },
});
const version = values.version ?? recorded.upstream.version;
const revision = values.revision ?? recorded.upstream.revision;
if (!/^[0-9a-f]{40}$/.test(revision)) throw new Error('--revision must be a full commit SHA');

const repository = new URL(recorded.upstream.repository).pathname.replace(/^\/|\.git$/g, '');
const deadline = () => AbortSignal.timeout(30_000);

async function get(url: string): Promise<Response> {
  const response = await fetch(url, { signal: deadline(), redirect: 'follow' });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response;
}

const metadata = (await (
  await get(`https://registry.npmjs.org/${recorded.upstream.package.replace('/', '%2f')}/${version}`)
).json()) as { gitHead?: string; dist: { integrity: string; tarball: string } };
const tarball = new Uint8Array(await (await get(metadata.dist.tarball)).arrayBuffer());
const tarballIntegrity = `sha512-${new Bun.CryptoHasher('sha512').update(tarball).digest('base64')}`;

const tree = (await (
  await get(`https://api.github.com/repos/${repository}/git/trees/${revision}?recursive=1`)
).json()) as { tree: { path: string; type: string }[] };
const present = new Set(tree.tree.filter((entry) => entry.type === 'blob').map((entry) => entry.path));
const sourceFiles = [...present].filter((path) => /^src\/[^/]+\.ts$/.test(path) && !/\.test\.ts$/.test(path));

const files: Record<string, string | undefined> = {};
for (const path of new Set([recorded.upstream.licenseFile, ...recorded.sources.map((s) => s.path), ...sourceFiles])) {
  if (!present.has(path)) continue;
  const text = await (await get(`https://raw.githubusercontent.com/${repository}/${revision}/${path}`)).text();
  files[path] = new Bun.CryptoHasher('sha256').update(text).digest('hex');
}

const observed: ObservedUpstream = {
  version,
  gitHead: metadata.gitHead,
  registryIntegrity: metadata.dist.integrity,
  tarballIntegrity,
  revision,
  files,
  sourceFiles,
};
const report = compareProvenance(recorded, observed);

console.log(`upstream ${recorded.upstream.package}@${version} at ${revision}`);
console.log(`tarball ${tarballIntegrity}`);
for (const path of Object.keys(files).sort()) console.log(`  ${files[path]}  ${path}`);
if (report.changed.length > 0) console.log(`changed since the recorded baseline: ${report.changed.join(', ')}`);
if (report.unrecorded.length > 0) console.log(`not in the record: ${report.unrecorded.join(', ')}`);
if (report.problems.length > 0) {
  for (const problem of report.problems) console.error(`problem: ${problem}`);
  process.exit(1);
}
console.log('provenance consistent');
