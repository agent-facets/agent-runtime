// Regenerates the golden request fixtures from the upstream reference implementation, so expected outputs do not
// come from the code under test. Run it only when reviewing a profile, against the published upstream `dist` of
// the recorded revision (unpacked outside the repository with its `@streamparser/json` dependency installed):
//
//   bun packages/anthropic-subscription/test-support/golden/generate.ts <upstream-dist-dir> <client-version>
//
// The only change applied to upstream output is D1: upstream aliases every tool name, and the alias is decoded back
// to the native name this package sends unchanged. Everything else is upstream's bytes.
import { join, resolve } from 'node:path';
import { ACCESS_TOKEN, GOLDEN_INPUTS } from './inputs.ts';

const [distArgument, version] = Bun.argv.slice(2);
if (distArgument === undefined || version === undefined) {
  throw new Error('usage: generate.ts <upstream-dist-dir> <client-version>');
}
const dist = resolve(distArgument);
const upstream = await import(join(dist, 'transform.js'));

const outputs = GOLDEN_INPUTS.map((input) => {
  const aliases = new upstream.ToolNameAliasTable({ maxEntries: 256, maxBytes: 16 * 1024 });
  const rewritten = JSON.parse(upstream.rewriteRequestBody(input.body, version, aliases));
  const decode = (name: string) => aliases.decode(name) ?? name;
  for (const tool of rewritten.tools ?? []) tool.name = decode(tool.name);
  for (const message of rewritten.messages ?? []) {
    for (const block of Array.isArray(message.content) ? message.content : []) {
      if (block.type === 'tool_use') block.name = decode(block.name);
    }
  }
  const headers = upstream.headersAfterBodyTransform(upstream.mergeHeaders(undefined, { headers: input.headers }));
  upstream.setOAuthHeaders(headers, ACCESS_TOKEN, version);
  return {
    name: input.name,
    url: upstream.rewriteUrl(input.url).url.href,
    headers: Object.fromEntries(headers),
    body: JSON.stringify(rewritten),
  };
});

const target = join(import.meta.dir, `claude-cli-${version}.json`);
await Bun.write(
  target,
  `${JSON.stringify(
    {
      generatedFrom: '@ex-machina/opencode-anthropic-auth@2.0.0-next.5 (156cb66c6889e1be3ad2b839345ea409942ab40f) dist',
      clientVersion: version,
      appliedDifferences: ['D1: upstream tool-name aliases decoded to the native names'],
      outputs,
    },
    null,
    2,
  )}\n`,
);
console.log(`wrote ${target}`);
