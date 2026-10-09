// The `agent-runtime` facet adapter. It never writes: both capabilities return exact file transitions and the facet
// CLI performs, journals and rolls back every write. Outputs live only beneath the project's runtime export
// directory, so installing for the runtime leaves coding-tool materializations untouched.
import {
  type AdapterMetadata,
  type AssetCapability,
  assertSafeAssetName,
  defineAdapter,
  type McpServerCapability,
  type McpServerContribution,
  type PlanAssetInstallRequest,
  type PlanAssetInstallResult,
  type PlanAssetRemovalResult,
  prepareMcpTextPlan,
  type ReadonlyMcpServerDeclaration,
  readFileState,
  readTextOrAbsent,
  sameStringArray,
  sameStringRecord,
  splitAssetContent,
  stateHoldsBytes,
  type Validated,
  validateContainedRelativePath,
} from '@agent-facets/adapter';
import { canonicalJson, sha256Hex } from './canonical.ts';
import {
  type Companion,
  type ExportRecord,
  encodeExport,
  exportAssetPath,
  exportServersPath,
  type ServerDeclarationExport,
  type ServersDocument,
  serversDocumentSchema,
} from './export-record.ts';
import { validateRuntimeMetadata } from './metadata.ts';
import { ADAPTER_NAME } from './toolchain.ts';

/** The export record for one contribution: its runtime definition inputs, or a safe refusal. */
export function exportRecordFor(request: PlanAssetInstallRequest): ExportRecord {
  const kind = request.assetType;
  const checked = validateRuntimeMetadata(kind, request.metadata);
  if (!checked.ok) {
    return { format: 1, state: 'refused', kind, name: request.name, reason: checked.reason, fields: checked.fields };
  }
  const companions: Companion[] =
    request.assetType === 'skill'
      ? Object.entries(request.companions)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([path, bytes]) => ({
            path,
            byteLength: bytes.byteLength,
            sha256: sha256Hex(bytes),
            content: Buffer.from(bytes).toString('base64'),
          }))
      : [];
  // Primary front matter carries other tools' settings; only the body is retained.
  const body = splitAssetContent(request.content).content;
  return {
    format: 1,
    state: 'ready',
    kind,
    name: request.name,
    description: checked.description,
    body,
    runtime: checked.runtime,
    companions,
  };
}

function planWrite(path: string, boundary: string, contents: Uint8Array): PlanAssetInstallResult {
  const read = readFileState(path);
  if (!read.ok) return { ok: false, failure: read.failure };
  if (stateHoldsBytes(read.state, contents)) {
    return { ok: true, plan: { occupancy: 'equivalent', action: { kind: 'unchanged' }, primaryPath: path } };
  }
  return {
    ok: true,
    plan: {
      occupancy: read.state.kind === 'absent' ? 'absent' : 'divergent',
      action: { kind: 'mutate', mutations: [{ kind: 'write', path, boundary, expected: read.state, contents }] },
      primaryPath: path,
    },
  };
}

function planDelete(path: string, boundary: string): PlanAssetRemovalResult {
  const read = readFileState(path);
  if (!read.ok) return { ok: false, failure: read.failure };
  if (read.state.kind === 'absent') return { ok: true, plan: { kind: 'absent', primaryPath: path } };
  return {
    ok: true,
    plan: {
      kind: 'remove',
      action: { kind: 'mutate', mutations: [{ kind: 'delete', path, boundary, expected: read.state }] },
      primaryPath: path,
    },
  };
}

export const assets: AssetCapability = {
  async planInstall(request) {
    if (request.scope !== 'project') return { ok: false, failure: { code: 'unsupported-scope', scope: request.scope } };
    assertSafeAssetName(request.name);
    if (request.assetType === 'skill') {
      for (const path of [...Object.keys(request.companions), ...request.ownedCompanionPaths]) {
        const check = validateContainedRelativePath(path);
        if (!check.ok) return { ok: false, failure: { code: 'invalid-companion-path', path, reason: check.reason } };
      }
    }
    const path = exportAssetPath(request.projectRoot, request.assetType, request.name);
    return planWrite(path, request.projectRoot, encodeExport(exportRecordFor(request)));
  },

  async planRemoval(request) {
    if (request.scope !== 'project') return { ok: false, failure: { code: 'unsupported-scope', scope: request.scope } };
    assertSafeAssetName(request.name);
    return planDelete(exportAssetPath(request.projectRoot, request.assetType, request.name), request.projectRoot);
  },
};

/** The portable declaration with omitted optional collections made explicit. */
export function normalizeDeclaration(declaration: ReadonlyMcpServerDeclaration): ServerDeclarationExport {
  if (declaration.type === 'http') return { type: 'http', url: declaration.url };
  return {
    type: 'stdio',
    command: declaration.command,
    args: [...(declaration.args ?? [])],
    env: { ...(declaration.env ?? {}) },
  };
}

function sameDeclaration(existing: ServerDeclarationExport | undefined, desired: ServerDeclarationExport): boolean {
  if (existing === undefined || existing.type !== desired.type) return false;
  if (existing.type === 'http' && desired.type === 'http') return existing.url === desired.url;
  if (existing.type === 'stdio' && desired.type === 'stdio') {
    return (
      existing.command === desired.command &&
      sameStringArray(existing.args, desired.args) &&
      sameStringRecord(existing.env, desired.env)
    );
  }
  return false;
}

/**
 * Raw server declarations are exported for later sealing; exporting is not connection approval, and the runtime
 * grants nothing on the strength of it. The document belongs entirely to this adapter, so entries neither desired
 * nor previously owned are preserved untouched.
 */
export const mcpServers: McpServerCapability = {
  async plan(request) {
    const path = exportServersPath(request.projectRoot);
    const read = readTextOrAbsent(path);
    if (!read.ok) return { ok: false, failure: read.failure };
    let existing: ServersDocument = { format: 1, servers: {} };
    if (read.text !== null) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(read.text);
      } catch {
        return { ok: false, failure: { code: 'parse-failed', path, message: 'the server export is not JSON' } };
      }
      const checked = serversDocumentSchema.safeParse(parsed);
      if (!checked.success) {
        return { ok: false, failure: { code: 'validation-failed', path, message: 'unrecognized server export' } };
      }
      existing = checked.data;
    }
    const desired = new Map(
      request.desired.map((contribution: McpServerContribution) => [
        contribution.name,
        normalizeDeclaration(contribution.declaration),
      ]),
    );
    return prepareMcpTextPlan({
      request,
      documents: [read.document],
      presentNames: new Set(Object.keys(existing.servers)),
      compare: (contribution) =>
        sameDeclaration(existing.servers[contribution.name], normalizeDeclaration(contribution.declaration))
          ? 'equivalent'
          : 'divergent',
      buildEdits: (outcomes) => {
        const servers = { ...existing.servers };
        for (const outcome of outcomes) {
          if (outcome.kind === 'obsolete-owned') delete servers[outcome.name];
          else {
            const declaration = desired.get(outcome.name);
            if (declaration !== undefined) servers[outcome.name] = declaration;
          }
        }
        return { ok: true, edits: [{ path, contents: `${canonicalJson({ format: 1, servers })}\n` }] };
      },
    });
  },
};

/**
 * Build-time metadata validation is deliberately permissive: refusing here would fail a whole facet install over
 * one unsupported contribution. Each contribution is checked when it is exported and refused individually.
 */
function buildAssetMetadata(data: unknown): Validated<AdapterMetadata> {
  if (data === undefined || data === null) return { ok: true, data: {} };
  if (typeof data !== 'object' || Array.isArray(data)) {
    return {
      ok: false,
      errors: [
        { path: ADAPTER_NAME, message: 'adapter metadata must be an object', expected: 'object', actual: typeof data },
      ],
    };
  }
  return { ok: true, data: data as AdapterMetadata };
}

export default defineAdapter({ name: ADAPTER_NAME, assets, mcpServers, buildAssetMetadata });
