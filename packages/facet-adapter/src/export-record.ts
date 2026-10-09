// The runtime export layout written through installer-performed file transitions (design Decision 2). Every export
// is canonical JSON, so identical inputs give identical bytes and an unchanged asset plans no write.
import { join } from 'node:path';
import { z } from 'zod';
import { canonicalBytes } from './canonical.ts';
import { assetNameSchema, requirementSchema, restrictionSchema } from './metadata.ts';

export const EXPORT_DIR = '.agent-runtime-export';
export const assetKinds = ['command', 'skill', 'agent'] as const;
export const assetKindSchema = z.enum(assetKinds);

export const exportAssetPath = (projectRoot: string, kind: string, name: string) =>
  join(projectRoot, EXPORT_DIR, 'assets', kind, `${name}.json`);
export const exportServersPath = (projectRoot: string) => join(projectRoot, EXPORT_DIR, 'servers.json');

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const companionPathSchema = z
  .string()
  .max(512)
  .refine((path) => path.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..'));

/** A skill companion, kept byte for byte; only its declared path is interpreted. */
export const companionSchema = z.strictObject({
  path: companionPathSchema,
  byteLength: z.number().int().min(0),
  sha256: sha256Schema,
  content: z.base64(),
});
export type Companion = z.infer<typeof companionSchema>;

const runtimeSchema = z.strictObject({
  runtimeVersion: z.literal(1),
  requires: z.array(requirementSchema),
  arguments: z.strictObject({ required: z.boolean() }).optional(),
  restrict: restrictionSchema.optional(),
});

export const exportRecordSchema = z.discriminatedUnion('state', [
  z.strictObject({
    format: z.literal(1),
    state: z.literal('ready'),
    kind: assetKindSchema,
    name: assetNameSchema,
    description: z.string(),
    body: z.string(),
    runtime: runtimeSchema,
    companions: z.array(companionSchema),
  }),
  z.strictObject({
    format: z.literal(1),
    state: z.literal('refused'),
    kind: assetKindSchema,
    name: assetNameSchema,
    reason: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
    fields: z.array(z.string().max(64)),
  }),
]);
export type ExportRecord = z.infer<typeof exportRecordSchema>;

export const encodeExport = (record: ExportRecord) => canonicalBytes(record);

/** Portable declarations exactly as the installer planned them; omitted optional collections are empty. */
export const serverDeclarationSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('stdio'),
    command: z.string().min(1),
    args: z.array(z.string()),
    env: z.record(z.string(), z.string()),
  }),
  z.strictObject({ type: z.literal('http'), url: z.string() }),
]);
export type ServerDeclarationExport = z.infer<typeof serverDeclarationSchema>;

export const serversDocumentSchema = z.strictObject({
  format: z.literal(1),
  servers: z.record(assetNameSchema, serverDeclarationSchema),
});
export type ServersDocument = z.infer<typeof serversDocumentSchema>;
