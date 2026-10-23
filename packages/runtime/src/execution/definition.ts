// The execution definition (Decision 7): canonical JSON of everything that determines how a saved run continues,
// and its digest. It is built for a run's stored binding — provider, auth mode, model, profile and workspace
// policy — never for the defaults a new run would get, and compared by exact digest equality. Redeploying the same
// execution content, changing browser assets or changing only new-run defaults leaves it unchanged; changing a
// tool body, a resume-critical helper, a package, the graph, the prompt or a protocol version does not.
import { canonicalJson, digestOf, sha256Hex } from '../records/canonical.ts';
import type { ProviderBinding } from '../records/schemas.ts';
import type { ExecutionAgent, executionAgentParams } from './agent.ts';
import { SYSTEM_PROMPT } from './agent.ts';
import type { CodeManifest } from './code-manifest.ts';
import { QUESTION_PROTOCOL_VERSION } from './tools.ts';

export const PROTOCOL_VERSIONS = Object.freeze({
  question: QUESTION_PROTOCOL_VERSION,
  resumeEnvelope: 1,
  continuation: 1,
});

export interface ExecutionDefinition {
  digest: string;
  manifest: Record<string, unknown>;
}

/** The generated graph's nodes and edges, sorted. */
export async function graphShape(agent: ExecutionAgent) {
  const graph = await agent.graph.getGraphAsync();
  return {
    nodes: Object.keys(graph.nodes).sort(),
    edges: graph.edges
      .map((edge) => `${edge.source}->${edge.target}${edge.conditional ? ' (conditional)' : ''}`)
      .sort(),
  };
}

export async function executionDefinition(input: {
  code: CodeManifest;
  agent: ExecutionAgent;
  params: ReturnType<typeof executionAgentParams>;
  binding: ProviderBinding;
  workspacePolicyDigest: string;
  runtimeVersion?: string;
}): Promise<ExecutionDefinition> {
  const manifest = {
    protocolVersion: PROTOCOL_VERSIONS,
    runtimeVersion: input.runtimeVersion ?? Bun.version,
    packages: input.code.packages,
    executionCode: input.code.executionCode,
    graph: await graphShape(input.agent),
    middleware: input.params.middleware.map((middleware) => ({ name: middleware.name })),
    tools: input.params.tools
      .map((tool) => ({
        name: tool.name,
        descriptionDigest: sha256Hex(tool.description),
        schemaDigest: digestOf(tool.schema),
      }))
      .sort((a, b) => (a.name < b.name ? -1 : 1)),
    promptDigest: sha256Hex(SYSTEM_PROMPT),
    runBinding: {
      provider: input.binding.provider,
      authMode: input.binding.authMode,
      model: input.binding.model,
      profileId: input.binding.profileId,
      credentialSlot: input.binding.credentialSlot,
      workspacePolicyDigest: input.workspacePolicyDigest,
    },
  };
  // Round-trip through canonical JSON so the stored manifest is exactly what was digested.
  const canonical = JSON.parse(canonicalJson(manifest)) as Record<string, unknown>;
  return { digest: digestOf(canonical), manifest: canonical };
}
