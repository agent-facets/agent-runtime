// The CLI-managed project inputs a seal is joined against. Versions are dispatched by exact match: only project
// manifest 0.2 and lockfile 0.4 are understood, and anything else is refused rather than interpreted. Lockfile 0.4
// records each facet's complete MCP server inventory; the public protocol package derives the selected servers and
// every contributing origin from it, so alias, omission and deduplication follow the installer's own rules.
import {
  deriveLockedMcpInventory,
  type LockedMcpAuthoredServer,
  type LockedMcpServer,
  parseLockfileDocument,
} from '@agent-facets/protocol';
import { z } from 'zod';
import { assetNameSchema, facetNameSchema } from './metadata.ts';
import { PINNED_CLI } from './toolchain.ts';

export const SUPPORTED_MANIFEST_VERSION = 0.2;
export const SUPPORTED_LOCKFILE_VERSION = 0.4;
/** Readable by the installer but without a server inventory, so a seal cannot be joined against them. */
const PRE_INVENTORY_LOCKFILE_VERSIONS = new Set([0.2, 0.3]);

const dispositionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('authored') }),
  z.strictObject({ kind: z.literal('aliased'), as: assetNameSchema }),
  z.strictObject({ kind: z.literal('omitted') }),
]);
export type Disposition = z.infer<typeof dispositionSchema>;

const overrideGroupSchema = z.record(
  z.string(),
  z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('aliased'), as: assetNameSchema }),
    z.strictObject({ kind: z.literal('omitted') }),
  ]),
);

const manifestEntrySchema = z.union([
  z.string(),
  z.strictObject({
    source: z.string(),
    materialization: z.strictObject({
      skills: overrideGroupSchema.optional(),
      agents: overrideGroupSchema.optional(),
      commands: overrideGroupSchema.optional(),
      servers: overrideGroupSchema.optional(),
    }),
  }),
]);

export const projectManifestSchema = z.looseObject({
  manifestVersion: z.literal(SUPPORTED_MANIFEST_VERSION),
  facets: z.record(facetNameSchema, manifestEntrySchema),
});
export type ProjectManifest = z.infer<typeof projectManifestSchema>;

const fileRecordSchema = z.looseObject({
  path: z.string().min(1),
  integrity: z.string().regex(/^sha256:[0-9a-f]{64}$/),
});
export type FileRecord = z.infer<typeof fileRecordSchema>;

export const lockSourceSchema = z.discriminatedUnion('kind', [
  z.looseObject({ kind: z.literal('registry'), registry: z.string() }),
  z.looseObject({ kind: z.literal('git'), url: z.string(), commit: z.string().regex(/^[0-9a-f]{8,}$/) }),
  z.looseObject({ kind: z.literal('local'), path: z.string() }),
]);
export type LockSource = z.infer<typeof lockSourceSchema>;

const lockAssetSchema = z.looseObject({
  scope: z.enum(['system', 'user', 'project']),
  type: z.enum(['skill', 'agent', 'command']),
  name: assetNameSchema,
  materialization: dispositionSchema,
  files: z.array(fileRecordSchema).min(1),
});
export type LockAsset = z.infer<typeof lockAssetSchema>;

/** One authored server a facet declares: its name, declaration fingerprint and recorded disposition. */
const lockServerSchema = z.looseObject({
  name: assetNameSchema,
  fingerprint: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  materialization: dispositionSchema,
});

export const lockfileSchema = z.looseObject({
  lockfileVersion: z.literal(SUPPORTED_LOCKFILE_VERSION),
  facets: z.record(
    facetNameSchema,
    z.looseObject({
      source: lockSourceSchema,
      version: z.string().regex(/^[0-9]+\.[0-9]+\.[0-9]+$/),
      integrity: z.string().min(1).max(256),
      assets: z.array(lockAssetSchema),
      servers: z.array(lockServerSchema),
    }),
  ),
});
export type Lockfile = z.infer<typeof lockfileSchema>;

export class InputError extends Error {
  override readonly name = 'InputError';
  constructor(
    readonly reason: string,
    message: string,
  ) {
    super(message);
  }
}

function parseJson(text: string, label: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // Comments are legal in a CLI-maintained manifest but not in the strict inputs a seal is computed from.
    throw new InputError('input_unreadable', `${label} is not strict JSON`);
  }
}

const versionOf = (value: unknown, field: string) =>
  value !== null && typeof value === 'object' ? (value as Record<string, unknown>)[field] : undefined;

export function parseProjectManifest(text: string): ProjectManifest {
  const value = parseJson(text, 'facets.json');
  const version = versionOf(value, 'manifestVersion');
  if (version !== SUPPORTED_MANIFEST_VERSION) {
    throw new InputError(
      'input_version_unsupported',
      `facets.json manifestVersion ${String(version)} is not supported`,
    );
  }
  const parsed = projectManifestSchema.safeParse(value);
  if (!parsed.success) throw new InputError('input_invalid', 'facets.json does not match the supported format');
  return parsed.data;
}

export function parseLockfile(text: string): Lockfile {
  const value = parseJson(text, 'facets.lock');
  const version = versionOf(value, 'lockfileVersion');
  if (typeof version === 'number' && PRE_INVENTORY_LOCKFILE_VERSIONS.has(version)) {
    throw new InputError(
      'lockfile_migration_required',
      `facets.lock lockfileVersion ${version} records no MCP server inventory; run a plain \`facet install\` with ` +
        `facet CLI ${PINNED_CLI.version} to migrate it to ${SUPPORTED_LOCKFILE_VERSION}`,
    );
  }
  if (version !== SUPPORTED_LOCKFILE_VERSION) {
    throw new InputError(
      'input_version_unsupported',
      `facets.lock lockfileVersion ${String(version)} is not supported`,
    );
  }
  // The installer's own schema first (duplicate members included), then the narrower shape this sealer reads.
  if (!parseLockfileDocument(text).ok) throw new InputError('input_invalid', 'facets.lock is not a valid lockfile');
  const parsed = lockfileSchema.safeParse(value);
  if (!parsed.success) throw new InputError('input_invalid', 'facets.lock does not match the supported format');
  return parsed.data;
}

export interface ServerInventory {
  /** The selected servers by effective name, each with every facet that claims it. */
  selected: readonly LockedMcpServer[];
  /** Every recorded authored server, omitted ones included. */
  authored: readonly LockedMcpAuthoredServer[];
}

/** The server inventory the lockfile records, derived by the installer's public rules. */
export function lockedServerInventory(text: string): ServerInventory {
  const parsed = parseLockfileDocument(text);
  if (!parsed.ok) throw new InputError('input_invalid', 'facets.lock is not a valid lockfile');
  const inventory = deriveLockedMcpInventory(parsed.data.lockfile);
  if (inventory.ok) return { selected: inventory.servers, authored: inventory.authored };
  if (inventory.reason === 'collision') {
    const names = inventory.groups.map((group) => group.effectiveName).sort();
    throw new InputError('server_collision', `different server declarations claim ${names.join(', ')}`);
  }
  throw new InputError('lockfile_migration_required', 'facets.lock records no MCP server inventory');
}

const groupOf = { skill: 'skills', agent: 'agents', command: 'commands' } as const;

const sameDisposition = (expected: Disposition, recorded: Disposition) =>
  expected.kind === recorded.kind &&
  (expected.kind !== 'aliased' || (recorded.kind === 'aliased' && expected.as === recorded.as));

/**
 * The lockfile and manifest must describe the same facets and the same text-asset and server choices; a mismatch
 * means the recorded installation is not the one the manifest asks for (for example, an alias edited without
 * reinstalling, or an override naming something the facet does not declare).
 */
export function checkInputsAgree(manifest: ProjectManifest, lock: Lockfile): void {
  const declared = Object.keys(manifest.facets).sort();
  const locked = Object.keys(lock.facets).sort();
  if (declared.join('\n') !== locked.join('\n')) {
    throw new InputError('inputs_disagree', 'facets.json and facets.lock do not list the same facets');
  }
  for (const [facet, entry] of Object.entries(lock.facets)) {
    const requested = manifest.facets[facet];
    const overrides = typeof requested === 'string' ? undefined : requested?.materialization;
    const names = {
      skills: new Set<string>(),
      agents: new Set<string>(),
      commands: new Set<string>(),
      servers: new Set<string>(),
    };
    const recorded = [
      ...entry.assets.map((asset) => {
        if (asset.scope !== 'project')
          throw new InputError('input_scope_unsupported', `${facet} ${asset.type} ${asset.name} is not project-scoped`);
        return { group: groupOf[asset.type], label: asset.type, name: asset.name, disposition: asset.materialization };
      }),
      ...entry.servers.map((server) => ({
        group: 'servers' as const,
        label: 'server',
        name: server.name,
        disposition: server.materialization,
      })),
    ];
    for (const { group, label, name, disposition } of recorded) {
      names[group].add(name);
      if (!sameDisposition(overrides?.[group]?.[name] ?? { kind: 'authored' }, disposition)) {
        throw new InputError(
          'inputs_disagree',
          `${facet} ${label} ${name} is recorded differently than facets.json requests`,
        );
      }
    }
    for (const group of ['skills', 'agents', 'commands', 'servers'] as const) {
      for (const name of Object.keys(overrides?.[group] ?? {})) {
        if (!names[group].has(name))
          throw new InputError('inputs_disagree', `${facet} overrides unknown ${group} ${name}`);
      }
    }
  }
}
