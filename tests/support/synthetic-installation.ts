// The synthetic sealed facet installation the MCP suites and the container fixture share: one command requiring the
// synthetic server's `list_items`, one agent, one skill with a bundled reference, and the synthetic server's
// declaration. Synthetic inputs only; nothing here is a real facet, grant or credential.
import { serverDigest } from '../../packages/runtime/src/capabilities/preflight.ts';
import { canonicalJson } from '../../packages/runtime/src/records/canonical.ts';

const D = 'd'.repeat(64);
const integrity = `sha256:${'f'.repeat(64)}`;
/** The synthetic server's credential: only the server may ever receive it. */
export const SLOT_VALUE = 'synthetic-dispatch-slot-value-0001';
export const CREDENTIAL_SLOT = 'repo-token';
export const SERVER = 'synthetic';
export const declaration = { type: 'stdio', command: './synthetic', args: [], env: { REPO_MODE: 'read' } };

/** What a replacement installation may change: the facet's version and its skill and agent texts. */
export interface InstallationContent {
  version: string;
  skillInstructions: string;
  agentInstructions: string;
  guide: string;
}
export const ORIGINAL: InstallationContent = {
  version: '1.0.0',
  skillInstructions: 'Review the item count.',
  agentInstructions: 'Do the delegated task with the tools you have.',
  guide: '# Guide\nCheck the item count.\n',
};

/** A sealed installation's exact bytes, as `installation.json`, and their SHA-256. */
export function sealedInstallation(content: InstallationContent = ORIGINAL) {
  const origin = { facet: 'workflows', version: content.version, source: 'local:./facets/workflows', integrity };
  const definition = (kind: string, name: string, extra: Record<string, unknown>) => ({
    kind,
    facet: 'workflows',
    authoredName: name,
    materialization: { kind: 'authored' },
    files: [{ path: kind === 'skill' ? `skills/${name}/SKILL.md` : `${kind}s/${name}.md`, integrity }],
    state: {
      kind: 'ready',
      definition: {
        id: `${kind}:${name}`,
        name,
        description: `About ${name}`,
        origins: [origin],
        exportDigest: D,
        requires: [],
        ...extra,
      },
    },
  });

  const guide = new TextEncoder().encode(content.guide);
  const bytes = new TextEncoder().encode(
    `${canonicalJson({
      format: 2,
      profile: 1,
      toolchain: {
        cli: { version: '0.36.5', platform: 'linux-x64', sha256: 'c'.repeat(64) },
        adapter: { name: 'agent-runtime', apiVersion: '0.3', sdkVersion: '0.30.0', sha256: 'a'.repeat(64) },
      },
      inputs: { manifestVersion: 0.2, lockfileVersion: 0.4, manifestSha256: D, lockSha256: D },
      facets: [
        {
          facet: 'workflows',
          version: content.version,
          source: { kind: 'local', path: './facets/workflows' },
          integrity,
        },
      ],
      items: [
        definition('command', 'sync', {
          body: 'Sync $ARGUMENTS.',
          arguments: { required: true },
          requires: [{ kind: 'mcp', serverId: SERVER, toolName: 'list_items' }],
        }),
        definition('agent', 'worker', { instructions: content.agentInstructions }),
        definition('skill', 'review', {
          instructions: content.skillInstructions,
          resources: [
            {
              path: 'references/guide.md',
              byteLength: guide.byteLength,
              sha256: new Bun.CryptoHasher('sha256').update(guide).digest('hex'),
              content: Buffer.from(guide).toString('base64'),
            },
          ],
        }),
      ],
      servers: [
        {
          serverId: SERVER,
          fingerprint: `sha256:${'9'.repeat(64)}`,
          declaration,
          origins: [{ ...origin, authoredName: SERVER }],
        },
      ],
      omittedServers: [],
    })}\n`,
  );
  return { bytes, sha256: new Bun.CryptoHasher('sha256').update(bytes).digest('hex') };
}

const sealed = sealedInstallation();
/** The sealed bundle's exact bytes, as `installation.json`. */
export const INSTALLATION_BYTES = sealed.bytes;
export const INSTALLATION_SHA256 = sealed.sha256;

/** The approval digest of the synthetic server's connection to `program`, as the owner would compute it. */
export const connectionDigest = (program: { sha256: string }) =>
  serverDigest(
    { serverId: SERVER, declaration },
    {
      serverId: SERVER,
      programId: SERVER,
      literalEnv: {},
      credentialEnv: { REPO_TOKEN: CREDENTIAL_SLOT },
      toolTimeoutSeconds: 60,
      approval: { kind: 'denied' },
    },
    program,
  );
