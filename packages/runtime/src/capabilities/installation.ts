// The sealed runtime facet installation (design Decision 2) and the catalog the runtime offers from it. The bundle is
// trusted only when its bytes match the owner-pinned SHA-256 and their canonical encoding; any corrupt or unverifiable
// input makes the whole catalog unavailable. Within a well-formed bundle, a contribution the runtime cannot use is
// refused on its own and unrelated contributions stay usable. Nothing here rewrites or reseals an installation.
import { digestSchema, effectiveNameSchema } from '@agent-runtime/contracts';
import { z } from 'zod';
import { canonicalJson } from '../records/canonical.ts';
import { agentDefinitionSchema, CAPABILITY_LIMITS, commandDefinitionSchema, skillDefinitionSchema } from './records.ts';

const safeText = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((text) => !/\p{Cc}/u.test(text), 'control characters');
const reasonSchema = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);
const facetSchema = z.string().regex(/^[A-Za-z0-9@][A-Za-z0-9@/._-]{0,255}$/);
const fileIntegritySchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);

const dispositionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('authored') }),
  z.strictObject({ kind: z.literal('aliased'), as: effectiveNameSchema }),
  z.strictObject({ kind: z.literal('omitted') }),
]);

const refusedStateSchema = z.strictObject({
  kind: z.literal('refused'),
  reason: reasonSchema,
  subject: safeText(256).optional(),
  fields: z.array(safeText(64)).max(16),
});
const omittedStateSchema = z.strictObject({ kind: z.literal('omitted') });
const readyState = <T extends z.ZodType>(definition: T) => z.strictObject({ kind: z.literal('ready'), definition });

const itemBase = {
  facet: facetSchema,
  authoredName: effectiveNameSchema,
  materialization: dispositionSchema,
  /** CLI-recorded source integrity of the authored files; distinct from the exported definitions' digests. */
  files: z
    .array(z.strictObject({ path: safeText(512), integrity: fileIntegritySchema }))
    .min(1)
    .max(257),
};
const itemSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('command'),
    ...itemBase,
    state: z.discriminatedUnion('kind', [readyState(commandDefinitionSchema), refusedStateSchema, omittedStateSchema]),
  }),
  z.strictObject({
    kind: z.literal('skill'),
    ...itemBase,
    state: z.discriminatedUnion('kind', [readyState(skillDefinitionSchema), refusedStateSchema, omittedStateSchema]),
  }),
  z.strictObject({
    kind: z.literal('agent'),
    ...itemBase,
    state: z.discriminatedUnion('kind', [readyState(agentDefinitionSchema), refusedStateSchema, omittedStateSchema]),
  }),
]);
export type InstallationItem = z.infer<typeof itemSchema>;

const lockSourceSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('registry'), registry: safeText(1024) }),
  z.strictObject({ kind: z.literal('git'), url: safeText(1024), commit: z.string().regex(/^[0-9a-f]{8,64}$/) }),
  z.strictObject({ kind: z.literal('local'), path: safeText(1024) }),
]);

export const installationSchema = z.strictObject({
  format: z.literal(1),
  profile: z.literal(1),
  toolchain: z.strictObject({
    cli: z.strictObject({ version: safeText(64), platform: safeText(64), sha256: digestSchema }),
    adapter: z.strictObject({
      name: z.literal('agent-runtime'),
      apiVersion: safeText(16),
      sdkVersion: safeText(64),
      sha256: digestSchema,
    }),
  }),
  inputs: z.strictObject({
    manifestVersion: z.number(),
    lockfileVersion: z.number(),
    manifestSha256: digestSchema,
    lockSha256: digestSchema,
  }),
  facets: z
    .array(
      z.strictObject({
        facet: facetSchema,
        version: z.string().regex(/^[0-9]+\.[0-9]+\.[0-9]+$/),
        source: lockSourceSchema,
        integrity: safeText(256),
      }),
    )
    .max(CAPABILITY_LIMITS.contributions),
  items: z.array(itemSchema).max(CAPABILITY_LIMITS.contributions),
  // TODO UPSTREAM-SERVER-PROVENANCE: revisit 9.1; complete 10.1; verify 10.2. Server declarations join the format
  // once their originating facets can be verified; until then a bundle carries none.
  servers: z.array(z.never()).max(0),
});
export type Installation = z.infer<typeof installationSchema>;

type Definition = Extract<InstallationItem['state'], { kind: 'ready' }>['definition'];

export type ContributionAvailability =
  | { kind: 'ready'; definition: Definition }
  | { kind: 'refused'; reason: string; subject?: string; fields: string[] };

/** An offered contribution: every selected, materialized item, usable or refused. Omitted items are not offered. */
export interface CatalogContribution {
  id: string;
  kind: InstallationItem['kind'];
  name: string;
  facet: string;
  version: string;
  availability: ContributionAvailability;
}

export interface Catalog {
  installationSha256: string;
  installation: Installation;
  contributions: CatalogContribution[];
}

export type CatalogLoad = { kind: 'ready'; catalog: Catalog } | { kind: 'unavailable'; reason: string };

/** Agent names the runtime reserves: `root` is the run's own agent, never a delegate. */
const RESERVED = new Set(['agent:root']);
const unavailable = (reason: string): CatalogLoad => ({ kind: 'unavailable', reason });

/** Verifies and opens sealed installation bytes against the owner-pinned digest. Never throws for bad input. */
export function loadInstallation(bytes: Uint8Array, pinnedSha256: string): CatalogLoad {
  if (bytes.byteLength > CAPABILITY_LIMITS.snapshotBytes + 1) return unavailable('installation_too_large');
  if (new Bun.CryptoHasher('sha256').update(bytes).digest('hex') !== pinnedSha256) {
    return unavailable('installation_digest_mismatch');
  }
  let text: string;
  let value: unknown;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    value = JSON.parse(text);
  } catch {
    return unavailable('installation_unreadable');
  }
  const parsed = installationSchema.safeParse(value);
  if (!parsed.success) return unavailable('installation_invalid');
  if (`${canonicalJson(parsed.data)}\n` !== text) return unavailable('installation_not_canonical');
  const installation = parsed.data;
  const consistent = checkConsistency(installation);
  if (consistent !== undefined) return unavailable(consistent);
  return {
    kind: 'ready',
    catalog: { installationSha256: pinnedSha256, installation, contributions: contributionsOf(installation) },
  };
}

/** Reads the bundle at an absolute path; a missing or unreadable file makes the catalog unavailable. */
export async function readInstallation(path: string, pinnedSha256: string): Promise<CatalogLoad> {
  const file = Bun.file(path);
  try {
    if (!(await file.exists())) return unavailable('installation_missing');
    if (file.size > CAPABILITY_LIMITS.snapshotBytes + 1) return unavailable('installation_too_large');
    return loadInstallation(new Uint8Array(await file.arrayBuffer()), pinnedSha256);
  } catch {
    return unavailable('installation_unreadable');
  }
}

const effectiveName = (item: InstallationItem) =>
  item.materialization.kind === 'omitted'
    ? undefined
    : item.materialization.kind === 'aliased'
      ? item.materialization.as
      : item.authoredName;

/** Structural facts a correct seal always satisfies; violating one means the bundle cannot be trusted at all. */
function checkConsistency(installation: Installation): string | undefined {
  const facets = new Map(installation.facets.map((entry) => [entry.facet, entry]));
  if (facets.size !== installation.facets.length) return 'installation_invalid';
  const perKind = { skill: 0, agent: 0, command: 0 };
  const authored = new Set<string>();
  for (const item of installation.items) {
    perKind[item.kind] += 1;
    const key = `${item.facet}\u0000${item.kind}\u0000${item.authoredName}`;
    if (authored.has(key)) return 'installation_invalid';
    authored.add(key);
    const facet = facets.get(item.facet);
    if (facet === undefined) return 'installation_invalid';
    const name = effectiveName(item);
    if ((name === undefined) !== (item.state.kind === 'omitted')) return 'installation_invalid';
    if (item.state.kind === 'ready') {
      const { definition } = item.state;
      const [origin, ...others] = definition.origins;
      if (definition.id !== `${item.kind}:${name}` || others.length > 0) return 'installation_invalid';
      if (origin?.facet !== item.facet || origin.version !== facet.version || origin.integrity !== facet.integrity) {
        return 'installation_invalid';
      }
    }
  }
  if (
    perKind.skill > CAPABILITY_LIMITS.skills ||
    perKind.agent > CAPABILITY_LIMITS.agents ||
    perKind.command > CAPABILITY_LIMITS.commands
  ) {
    return 'installation_too_large';
  }
  return undefined;
}

function contributionsOf(installation: Installation): CatalogContribution[] {
  const versions = new Map(installation.facets.map((entry) => [entry.facet, entry.version]));
  const contributions: CatalogContribution[] = [];
  for (const item of installation.items) {
    const name = effectiveName(item);
    if (name === undefined || item.state.kind === 'omitted') continue;
    contributions.push({
      id: `${item.kind}:${name}`,
      kind: item.kind,
      name,
      facet: item.facet,
      version: versions.get(item.facet) ?? '',
      availability:
        item.state.kind === 'ready'
          ? { kind: 'ready', definition: item.state.definition }
          : {
              kind: 'refused',
              reason: item.state.reason,
              ...(item.state.subject === undefined ? {} : { subject: item.state.subject }),
              fields: item.state.fields,
            },
    });
  }

  // Names that cannot be told apart are a conflict: neither claimant is selected by order.
  const namespace = (c: CatalogContribution) => (c.kind === 'agent' ? `agent:${c.name}` : `skill-command:${c.name}`);
  const claims = new Map<string, number>();
  for (const contribution of contributions)
    claims.set(namespace(contribution), (claims.get(namespace(contribution)) ?? 0) + 1);
  for (const contribution of contributions) {
    if ((claims.get(namespace(contribution)) ?? 0) > 1) {
      contribution.availability = {
        kind: 'refused',
        reason: 'name_conflict',
        subject: contribution.id,
        fields: ['name'],
      };
    } else if (RESERVED.has(contribution.id)) {
      contribution.availability = {
        kind: 'refused',
        reason: 'reserved_name',
        subject: contribution.id,
        fields: ['name'],
      };
    }
  }

  // A declared prerequisite that is absent or refused makes its dependant unusable, transitively.
  let changed = true;
  while (changed) {
    changed = false;
    const ready = new Set(contributions.filter((c) => c.availability.kind === 'ready').map((c) => c.id));
    for (const contribution of contributions) {
      if (contribution.availability.kind !== 'ready') continue;
      const blocked = contribution.availability.definition.requires.find(
        (requirement) => (requirement.kind === 'skill' || requirement.kind === 'agent') && !ready.has(requirement.id),
      );
      if (blocked !== undefined && 'id' in blocked) {
        contribution.availability = {
          kind: 'refused',
          reason: 'prerequisite_refused',
          subject: blocked.id,
          fields: ['requires'],
        };
        changed = true;
      } else if (contribution.availability.definition.requires.some((requirement) => requirement.kind === 'mcp')) {
        // TODO UPSTREAM-SERVER-PROVENANCE: revisit 9.1; complete 10.1; verify 10.2.
        contribution.availability = { kind: 'refused', reason: 'server_provenance_unavailable', fields: ['requires'] };
        changed = true;
      }
    }
  }
  return contributions;
}
