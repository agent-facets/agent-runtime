// A stand-in coding-tool adapter for the explicitly launched facet suite. It materializes into `.editor-test/` with
// the SDK's own planners, so the suite can prove runtime and editor installations never write into each other
// without touching the owner's real editor tooling. It is test input only and never shipped.

import { join } from 'node:path';
import {
  type AssetCapability,
  defineAdapter,
  planSingleFileInstall,
  planSingleFileRemoval,
  planSkillBundleInstall,
  planSkillBundleRemoval,
} from '@agent-facets/adapter';

const skillTarget = (projectRoot: string, name: string) => ({
  root: join(projectRoot, '.editor-test', 'skills', name),
  primaryFile: join(projectRoot, '.editor-test', 'skills', name, 'SKILL.md'),
  boundary: projectRoot,
});
const fileTarget = (projectRoot: string, kind: string, name: string) => ({
  file: join(projectRoot, '.editor-test', `${kind}s`, `${name}.md`),
  boundary: projectRoot,
});

const assets: AssetCapability = {
  async planInstall(request) {
    if (request.scope !== 'project') return { ok: false, failure: { code: 'unsupported-scope', scope: request.scope } };
    const description = (request.metadata as { description?: unknown } | undefined)?.description;
    const metadata = { name: request.name, description: typeof description === 'string' ? description : '' };
    if (request.assetType === 'skill') {
      return planSkillBundleInstall(skillTarget(request.projectRoot, request.name), {
        content: request.content,
        metadata,
        companions: request.companions,
        ownedCompanionPaths: request.ownedCompanionPaths,
      });
    }
    return planSingleFileInstall(
      fileTarget(request.projectRoot, request.assetType, request.name),
      request.content,
      metadata,
    );
  },
  async planRemoval(request) {
    if (request.scope !== 'project') return { ok: false, failure: { code: 'unsupported-scope', scope: request.scope } };
    if (request.assetType === 'skill') {
      return planSkillBundleRemoval(skillTarget(request.projectRoot, request.name), request.ownedCompanionPaths);
    }
    return planSingleFileRemoval(fileTarget(request.projectRoot, request.assetType, request.name));
  },
};

export default defineAdapter({
  name: 'editor-test',
  assets,
  mcpServers: false,
  buildAssetMetadata: (data) => ({ ok: true, data: (data ?? {}) as Record<string, unknown> }),
});
