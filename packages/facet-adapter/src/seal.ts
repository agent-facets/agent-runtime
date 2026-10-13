// Seals a completed runtime installation into one canonical bundle (design Decision 2). The seal joins the adapter's
// exports to the CLI-managed manifest and lockfile and refuses the whole installation when they disagree. Source
// hashes recorded by the CLI and hashes of the transformed exports are kept as separate facts: the export of a
// primary file is not its original bytes, so no source hash is ever recomputed from it.
//
// Servers are joined the same way: the lockfile's inventory says which servers are selected, under which effective
// names and from which facets; every exported declaration is fingerprinted again and must match exactly, so a
// deleted, extra or edited server export refuses the seal. Declaration fingerprints identify portable declarations
// only; runtime approval digests, which also bind the program actually run, are a separate, later fact.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { computeMcpServerFingerprint } from '@agent-facets/protocol';
import { canonicalBytes, sha256Hex } from './canonical.ts';
import {
  EXPORT_DIR,
  type ExportRecord,
  exportRecordSchema,
  type ServerDeclarationExport,
  serversDocumentSchema,
} from './export-record.ts';
import {
  checkInputsAgree,
  type Disposition,
  type FileRecord,
  InputError,
  type LockSource,
  lockedServerInventory,
  parseLockfile,
  parseProjectManifest,
  type ServerInventory,
  SUPPORTED_LOCKFILE_VERSION,
  SUPPORTED_MANIFEST_VERSION,
} from './inputs.ts';
import type { AssetKind } from './metadata.ts';
import {
  itemKey,
  type Resolution,
  type ResolvableItem,
  resolveReferences,
  type ServerIndex,
  serverKey,
} from './resolve.ts';
import { ADAPTER_API, ADAPTER_NAME, ADAPTER_SDK_VERSION, type CliIdentity } from './toolchain.ts';

/** The runtime's installation bounds (design Decision 10), checked here so refusals are attributable. */
export const SEAL_LIMITS = Object.freeze({
  bundleBytes: 16 * 1024 * 1024,
  contributions: 128,
  perKind: { skill: 32, agent: 16, command: 32 } as Record<AssetKind, number>,
  descriptionBytes: 1024,
  commandBodyBytes: 8192,
  instructionBytes: 48 * 1024,
  resourceBytes: 1024 * 1024,
  resources: 256,
  servers: 8,
  serverOrigins: 16,
});

export class SealError extends Error {
  override readonly name = 'SealError';
  constructor(
    readonly reason: string,
    message: string,
  ) {
    super(message);
  }
}

export interface Origin {
  facet: string;
  version: string;
  source: string;
  integrity: string;
}

export interface Resource {
  path: string;
  byteLength: number;
  sha256: string;
  content: string;
}

export type Definition =
  | {
      id: string;
      name: string;
      description: string;
      origins: Origin[];
      exportDigest: string;
      requires: unknown[];
      body: string;
      arguments: { required: boolean };
      restrict?: unknown;
    }
  | {
      id: string;
      name: string;
      description: string;
      origins: Origin[];
      exportDigest: string;
      requires: unknown[];
      instructions: string;
      resources: Resource[];
    }
  | {
      id: string;
      name: string;
      description: string;
      origins: Origin[];
      exportDigest: string;
      requires: unknown[];
      instructions: string;
      restrict?: unknown;
    };

export type ItemState =
  | { kind: 'omitted' }
  | { kind: 'ready'; definition: Definition }
  | { kind: 'refused'; reason: string; subject?: string; fields: string[] };

export interface InstallationItem {
  kind: AssetKind;
  facet: string;
  authoredName: string;
  materialization: Disposition;
  /** The CLI-recorded authored files and their source integrity. */
  files: FileRecord[];
  state: ItemState;
}

/** A facet that declares a selected server, under the authored name it declares it with. */
export interface ServerOrigin extends Origin {
  authoredName: string;
}

/** A selected server: its effective name, recorded declaration fingerprint, exported declaration and every origin. */
export interface SealedServer {
  serverId: string;
  fingerprint: string;
  declaration: ServerDeclarationExport;
  origins: ServerOrigin[];
}

/** An authored server the project omits; recorded so an omission is distinguishable from no declaration. */
export interface OmittedServer {
  facet: string;
  authoredName: string;
  fingerprint: string;
}

export interface Installation {
  format: 2;
  profile: 1;
  toolchain: {
    cli: CliIdentity;
    adapter: { name: string; apiVersion: string; sdkVersion: string; sha256: string };
  };
  inputs: { manifestVersion: number; lockfileVersion: number; manifestSha256: string; lockSha256: string };
  facets: { facet: string; version: string; source: LockSource; integrity: string }[];
  items: InstallationItem[];
  servers: SealedServer[];
  omittedServers: OmittedServer[];
}

export interface SealInputs {
  projectDir: string;
  facetDir: string;
  cli: CliIdentity;
}

export interface Sealed {
  installation: Installation;
  bytes: Uint8Array;
  sha256: string;
}

const utf8 = new TextEncoder();
const bytesOf = (text: string) => utf8.encode(text).byteLength;
const storable = (text: string) => text.isWellFormed() && !text.includes('\u0000');
const resourcePath = /^[A-Za-z0-9_-][A-Za-z0-9._-]*(?:\/[A-Za-z0-9_-][A-Za-z0-9._-]*)*$/;
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** The adapter installation in the isolated home; any other adapter would materialize editor files too. */
export function readAdapterIdentity(facetDir: string): { sha256: string; apiVersion: string } {
  if (!isAbsolute(facetDir)) throw new SealError('facet_home_invalid', 'FACET_DIR must be an absolute path');
  const adaptersDir = join(facetDir, 'adapters');
  const installed = existsSync(adaptersDir) ? readdirSync(adaptersDir).sort() : [];
  if (installed.join(',') !== ADAPTER_NAME) {
    throw new SealError(
      'facet_home_contaminated',
      installed.length === 0
        ? `the runtime facet home has no ${ADAPTER_NAME} adapter`
        : `the runtime facet home must contain only the ${ADAPTER_NAME} adapter, found: ${installed.join(', ')}`,
    );
  }
  let receipt: { activeGeneration?: unknown; apiVersion?: unknown };
  try {
    receipt = JSON.parse(readFileSync(join(adaptersDir, ADAPTER_NAME, 'installation.json'), 'utf8'));
  } catch {
    throw new SealError('adapter_unreadable', 'the installed adapter record cannot be read');
  }
  const generation = receipt.activeGeneration;
  if (typeof generation !== 'string' || !/^[A-Za-z0-9._-]+$/.test(generation) || receipt.apiVersion !== ADAPTER_API) {
    throw new SealError('adapter_unreadable', 'the installed adapter record is not usable');
  }
  const bundle = join(adaptersDir, ADAPTER_NAME, 'generations', generation, 'adapter.js');
  if (!existsSync(bundle)) throw new SealError('adapter_unreadable', 'the installed adapter bundle is missing');
  return { sha256: sha256Hex(readFileSync(bundle)), apiVersion: ADAPTER_API };
}

const renderSource = (source: LockSource) =>
  source.kind === 'registry'
    ? `registry:${source.registry}`
    : source.kind === 'git'
      ? `git:${source.url}#${source.commit}`
      : `local:${source.path}`;

const effectiveName = (authored: string, disposition: Disposition) =>
  disposition.kind === 'omitted' ? undefined : disposition.kind === 'aliased' ? disposition.as : authored;
const serverName = (authored: string, disposition: Disposition) => effectiveName(authored, disposition) ?? null;

interface ExportFile {
  record: ExportRecord;
  digest: string;
}

function readExports(projectDir: string): Map<string, ExportFile> {
  const exports = new Map<string, ExportFile>();
  const root = join(projectDir, EXPORT_DIR, 'assets');
  if (!existsSync(root)) return exports;
  for (const kind of readdirSync(root).sort()) {
    const kindDir = join(root, kind);
    if (!['command', 'skill', 'agent'].includes(kind) || !statSync(kindDir).isDirectory()) {
      throw new SealError('export_unexpected', `unexpected export entry assets/${kind}`);
    }
    for (const file of readdirSync(kindDir).sort()) {
      const bytes = readFileSync(join(kindDir, file));
      let record: ExportRecord;
      try {
        record = exportRecordSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
      } catch {
        throw new SealError('export_invalid', `export assets/${kind}/${file} is not a valid export record`);
      }
      if (`${record.name}.json` !== file || record.kind !== kind) {
        throw new SealError('export_mismatch', `export assets/${kind}/${file} does not describe ${kind} ${file}`);
      }
      if (!Buffer.from(canonicalBytes(record)).equals(bytes)) {
        throw new SealError('export_invalid', `export assets/${kind}/${file} is not canonically encoded`);
      }
      exports.set(`${kind}:${record.name}`, { record, digest: sha256Hex(bytes) });
    }
  }
  return exports;
}

/** The adapter's server export; absent means no server was exported. */
function readServerExports(projectDir: string): Record<string, ServerDeclarationExport> {
  const path = join(projectDir, EXPORT_DIR, 'servers.json');
  if (!existsSync(path)) return {};
  const bytes = readFileSync(path);
  let document: ReturnType<typeof serversDocumentSchema.parse>;
  try {
    document = serversDocumentSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
  } catch {
    throw new SealError('export_invalid', 'the server export is not valid');
  }
  if (!Buffer.from(canonicalBytes(document)).equals(bytes)) {
    throw new SealError('export_invalid', 'the server export is not canonically encoded');
  }
  return document.servers;
}

/**
 * Joins the selected servers the lockfile records to the declarations the adapter exported. The complete sets must
 * agree by effective name and by fingerprint recomputed from the exported declaration.
 */
function joinServers(
  projectDir: string,
  inventory: ServerInventory,
  origins: ReadonlyMap<string, Origin>,
): { servers: SealedServer[]; omittedServers: OmittedServer[] } {
  const exported = readServerExports(projectDir);
  const expected = new Map(inventory.selected.map((server) => [server.effectiveName, server]));
  const missing = [...expected.keys()].filter((name) => !Object.hasOwn(exported, name)).sort(compare);
  if (missing.length > 0) {
    throw new SealError('server_export_missing', `selected servers have no export: ${missing.join(', ')}`);
  }
  const unexpected = Object.keys(exported)
    .filter((name) => !expected.has(name))
    .sort(compare);
  if (unexpected.length > 0) {
    throw new SealError(
      'server_export_unexpected',
      `server exports are not part of the recorded installation: ${unexpected.join(', ')}`,
    );
  }
  const changed = [...expected]
    .filter(
      ([name, server]) => computeMcpServerFingerprint(exported[name] as ServerDeclarationExport) !== server.fingerprint,
    )
    .map(([name]) => name)
    .sort(compare);
  if (changed.length > 0) {
    throw new SealError(
      'server_export_mismatch',
      `exported declarations do not match their recorded fingerprints: ${changed.join(', ')}`,
    );
  }
  if (
    expected.size > SEAL_LIMITS.servers ||
    inventory.selected.some((server) => server.origins.length > SEAL_LIMITS.serverOrigins)
  ) {
    throw new SealError('installation_too_large', 'the installation exceeds the supported server counts');
  }
  const originOf = (facet: string) => {
    const origin = origins.get(facet);
    if (origin === undefined) throw new SealError('input_invalid', `server origin ${facet} is not a locked facet`);
    return origin;
  };
  return {
    servers: inventory.selected
      .map((server) => ({
        serverId: server.effectiveName,
        fingerprint: server.fingerprint,
        declaration: exported[server.effectiveName] as ServerDeclarationExport,
        origins: server.origins.map((origin) => ({ ...originOf(origin.facet), authoredName: origin.authoredName })),
      }))
      .sort((a, b) => compare(a.serverId, b.serverId)),
    omittedServers: inventory.authored
      .filter((server) => server.materialization.kind === 'omitted')
      .map((server) => ({ facet: server.facet, authoredName: server.authoredName, fingerprint: server.fingerprint })),
  };
}

/** Each facet's authored servers mapped to their effective names, or null where omitted. */
function serverIndex(inventory: ServerInventory): ServerIndex {
  return new Map(
    inventory.authored.map((server) => [
      serverKey(server.facet, server.authoredName),
      serverName(server.authoredName, server.materialization),
    ]),
  );
}

/** The skill's companion files as the lock records them: everything under its authored root except SKILL.md. */
function lockedCompanions(authoredName: string, files: FileRecord[]): Map<string, string> {
  const root = `skills/${authoredName}/`;
  const companions = new Map<string, string>();
  for (const file of files) {
    if (!file.path.startsWith(root))
      throw new SealError('input_invalid', `${file.path} is outside skill ${authoredName}`);
    const relative = file.path.slice(root.length);
    if (relative !== 'SKILL.md') companions.set(relative, file.integrity.slice('sha256:'.length));
  }
  return companions;
}

function checkCompanions(facet: string, authoredName: string, files: FileRecord[], record: ExportRecord): void {
  if (record.state !== 'ready') return;
  const expected = lockedCompanions(authoredName, files);
  const actual = record.companions;
  const label = `skill ${facet}/${authoredName}`;
  if (actual.length !== expected.size || actual.some((companion) => !expected.has(companion.path))) {
    throw new SealError('export_mismatch', `${label} exports companion files the lockfile does not record`);
  }
  for (const companion of actual) {
    const bytes = Buffer.from(companion.content, 'base64');
    const digest = sha256Hex(bytes);
    if (
      bytes.toString('base64') !== companion.content ||
      bytes.byteLength !== companion.byteLength ||
      digest !== companion.sha256 ||
      digest !== expected.get(companion.path)
    ) {
      throw new SealError(
        'export_mismatch',
        `${label} companion ${companion.path} does not match its recorded integrity`,
      );
    }
  }
}

type Built = { ok: true; definition: Definition } | { ok: false; reason: string; fields: string[] };

function buildDefinition(
  kind: AssetKind,
  name: string,
  record: Extract<ExportRecord, { state: 'ready' }>,
  resolution: Extract<Resolution, { ok: true }>,
  origin: Origin,
  digest: string,
): Built {
  const invalid = (reason: string, field: string): Built => ({ ok: false, reason, fields: [field] });
  if (bytesOf(record.description) > SEAL_LIMITS.descriptionBytes || /\p{Cc}/u.test(record.description)) {
    return invalid('description_unsupported', 'description');
  }
  if (!storable(record.body)) return invalid('body_unsupported', 'body');
  const common = {
    id: `${kind}:${name}`,
    name,
    description: record.description,
    origins: [origin],
    exportDigest: digest,
    requires: resolution.requires,
  };
  const restrict = resolution.restrict === undefined ? {} : { restrict: resolution.restrict };
  if (kind === 'command') {
    if (bytesOf(record.body) > SEAL_LIMITS.commandBodyBytes) return invalid('definition_too_large', 'body');
    return {
      ok: true,
      definition: {
        ...common,
        body: record.body,
        arguments: record.runtime.arguments ?? { required: false },
        ...restrict,
      },
    };
  }
  if (bytesOf(record.body) > SEAL_LIMITS.instructionBytes) return invalid('definition_too_large', 'body');
  if (!/\S/.test(record.body)) return invalid('body_unsupported', 'body');
  if (kind === 'agent') return { ok: true, definition: { ...common, instructions: record.body, ...restrict } };
  if (record.companions.length > SEAL_LIMITS.resources) return invalid('definition_too_large', 'files');
  for (const companion of record.companions) {
    if (!resourcePath.test(companion.path) || companion.path.split('/').some((s) => s === '.' || s === '..')) {
      return invalid('resource_path_unsupported', 'files');
    }
    if (companion.byteLength > SEAL_LIMITS.resourceBytes) return invalid('definition_too_large', 'files');
  }
  return {
    ok: true,
    definition: {
      ...common,
      instructions: record.body,
      resources: record.companions.map(({ path, byteLength, sha256, content }) => ({
        path,
        byteLength,
        sha256,
        content,
      })),
    },
  };
}

/** Builds the canonical installation bundle, or throws a SealError explaining why the installation is refused. */
export function sealInstallation(inputs: SealInputs): Sealed {
  const manifestBytes = readRequired(join(inputs.projectDir, 'facets.json'));
  const lockBytes = readRequired(join(inputs.projectDir, 'facets.lock'));
  const adapter = readAdapterIdentity(inputs.facetDir);
  let lock: ReturnType<typeof parseLockfile>;
  let inventory: ServerInventory;
  try {
    const manifest = parseProjectManifest(manifestBytes.toString('utf8'));
    lock = parseLockfile(lockBytes.toString('utf8'));
    checkInputsAgree(manifest, lock);
    inventory = lockedServerInventory(lockBytes.toString('utf8'));
  } catch (error) {
    if (error instanceof InputError) throw new SealError(error.reason, error.message);
    throw error;
  }
  const exports = readExports(inputs.projectDir);
  const origins = new Map<string, Origin>();

  // Join every locked text asset to its export by effective name, enforcing the installer's namespaces.
  const claimed = new Map<string, string>();
  const joined: { item: Omit<InstallationItem, 'state'>; exported?: ExportFile; origin: Origin }[] = [];
  const counts: Record<AssetKind, number> = { skill: 0, agent: 0, command: 0 };
  for (const facet of Object.keys(lock.facets).sort(compare)) {
    const entry = lock.facets[facet];
    if (entry === undefined) continue;
    const origin = { facet, version: entry.version, source: renderSource(entry.source), integrity: entry.integrity };
    origins.set(facet, origin);
    for (const asset of entry.assets) {
      counts[asset.type] += 1;
      const item = {
        kind: asset.type,
        facet,
        authoredName: asset.name,
        materialization: asset.materialization,
        files: asset.files,
      };
      const name = effectiveName(asset.name, asset.materialization);
      if (name === undefined) {
        joined.push({ item, origin });
        continue;
      }
      const namespace = asset.type === 'agent' ? `agent:${name}` : `skill-command:${name}`;
      const other = claimed.get(namespace);
      if (other !== undefined)
        throw new SealError('namespace_collision', `${name} is claimed by both ${other} and ${facet}`);
      claimed.set(namespace, facet);
      const exported = exports.get(`${asset.type}:${name}`);
      if (exported === undefined)
        throw new SealError('export_missing', `${asset.type} ${name} from ${facet} has no export`);
      exports.delete(`${asset.type}:${name}`);
      if (asset.type === 'skill') checkCompanions(facet, asset.name, asset.files, exported.record);
      joined.push({ item, exported, origin });
    }
  }
  const [extra] = exports.keys();
  if (extra !== undefined)
    throw new SealError('export_unexpected', `export ${extra} is not part of the recorded installation`);
  const total = counts.skill + counts.agent + counts.command;
  if (
    total > SEAL_LIMITS.contributions ||
    (Object.keys(counts) as AssetKind[]).some((k) => counts[k] > SEAL_LIMITS.perKind[k])
  ) {
    throw new SealError('installation_too_large', 'the installation exceeds the supported contribution counts');
  }

  const resolvable: ResolvableItem[] = joined.map(({ item, exported }) => ({
    facet: item.facet,
    kind: item.kind,
    authoredName: item.authoredName,
    effectiveName: effectiveName(item.authoredName, item.materialization),
    runtime: exported?.record.state === 'ready' ? exported.record.runtime : undefined,
  }));
  const { servers, omittedServers } = joinServers(inputs.projectDir, inventory, origins);
  const resolutions = resolveReferences(resolvable, serverIndex(inventory));

  const items: InstallationItem[] = joined.map(({ item, exported, origin }) => {
    const name = effectiveName(item.authoredName, item.materialization);
    if (name === undefined || exported === undefined) return { ...item, state: { kind: 'omitted' } };
    const record = exported.record;
    if (record.state === 'refused')
      return { ...item, state: { kind: 'refused', reason: record.reason, fields: record.fields } };
    const resolution = resolutions.get(
      itemKey({ facet: item.facet, kind: item.kind, authoredName: item.authoredName }),
    );
    if (resolution === undefined || !resolution.ok) {
      const refused = resolution as Extract<Resolution, { ok: false }> | undefined;
      return {
        ...item,
        state: {
          kind: 'refused',
          reason: refused?.reason ?? 'unresolved',
          ...(refused?.subject === undefined ? {} : { subject: refused.subject }),
          fields: refused?.fields ?? [],
        },
      };
    }
    const built = buildDefinition(item.kind, name, record, resolution, origin, exported.digest);
    return {
      ...item,
      state: built.ok
        ? { kind: 'ready', definition: built.definition }
        : { kind: 'refused', reason: built.reason, fields: built.fields },
    };
  });

  // A definition whose prerequisite failed its own bounds is not usable either.
  propagateLateRefusals(items);

  const installation: Installation = {
    format: 2,
    profile: 1,
    toolchain: {
      cli: inputs.cli,
      adapter: {
        name: ADAPTER_NAME,
        apiVersion: adapter.apiVersion,
        sdkVersion: ADAPTER_SDK_VERSION,
        sha256: adapter.sha256,
      },
    },
    inputs: {
      manifestVersion: SUPPORTED_MANIFEST_VERSION,
      lockfileVersion: SUPPORTED_LOCKFILE_VERSION,
      manifestSha256: sha256Hex(manifestBytes),
      lockSha256: sha256Hex(lockBytes),
    },
    facets: Object.keys(lock.facets)
      .sort(compare)
      .map((facet) => {
        const entry = lock.facets[facet];
        if (entry === undefined) throw new SealError('input_invalid', `missing lock entry ${facet}`);
        return { facet, version: entry.version, source: entry.source, integrity: entry.integrity };
      }),
    items,
    servers,
    omittedServers,
  };
  const bytes = canonicalBytes(installation);
  if (bytes.byteLength > SEAL_LIMITS.bundleBytes)
    throw new SealError('installation_too_large', 'the sealed installation exceeds 16 MiB');
  return { installation, bytes, sha256: sha256Hex(bytes) };
}

function propagateLateRefusals(items: InstallationItem[]): void {
  const ready = () => new Set(items.flatMap((item) => (item.state.kind === 'ready' ? [item.state.definition.id] : [])));
  let changed = true;
  while (changed) {
    changed = false;
    const available = ready();
    for (const item of items) {
      if (item.state.kind !== 'ready') continue;
      const blocked = (item.state.definition.requires as { kind: string; id?: string }[]).find(
        (requirement) => requirement.id !== undefined && !available.has(requirement.id),
      );
      if (blocked?.id !== undefined) {
        item.state = { kind: 'refused', reason: 'prerequisite_refused', subject: blocked.id, fields: ['requires'] };
        changed = true;
      }
    }
  }
}

function readRequired(path: string): Buffer {
  if (!existsSync(path))
    throw new SealError('input_missing', `${path} does not exist; install the runtime facets first`);
  return readFileSync(path);
}
