// Required-tool preflight for a new command start (design Decisions 4, 5 and 9). Starting a command authorizes a
// bounded inspection of the approved servers its required MCP tools belong to: each such server must be connection-
// approved for its exact current declaration and program, the required tools must be granted for their exact
// current definitions, and one short-lived connection initializes, lists tools and closes — no tool or model is ever
// called. The definitions found are what the run retains. Servers needed only by optional tools are not launched;
// their tools are simply not bound. Reading the catalog launches nothing.
import type { CapabilityConfig, ServerAccess } from '../config/capabilities.ts';
import type { McpSlotRead } from '../credentials/mcp-store.ts';
import { adaptDefinitions } from '../mcp/adapt.ts';
import { type DiscoveredTool, inspectServer } from '../mcp/discovery.ts';
import { declarationLaunchInputs, type LaunchSpec, planLaunch } from '../mcp/transport.ts';
import { digestOf } from '../records/canonical.ts';
import type { ContentPolicy } from '../security/content-policy.ts';
import type { Catalog, InstalledServer } from './installation.ts';
import { CAPABILITY_LIMITS, type CapabilitySnapshot } from './records.ts';
import type { BoundTools } from './snapshot.ts';

type CommandDefinition = CapabilitySnapshot['command'];

export type PreflightResult =
  | { ok: true; bound: BoundTools }
  | { ok: false; code: 'capability_unavailable' | 'mcp_server_unavailable'; reason: string; subject?: string };

/**
 * The approval digest of a server connection: its portable declaration and everything the runtime adds to run it —
 * the program bundle, the argument vector, the logical working directory and the environment and credential-slot
 * bindings. Credential values are never part of it. Any change requires the owner to approve the new digest.
 */
export function serverDigest(
  server: Pick<InstalledServer, 'serverId' | 'declaration'>,
  access: ServerAccess,
  program: { sha256: string },
): string {
  return digestOf({
    version: 1,
    declaration: server.declaration,
    program: { id: access.programId, sha256: program.sha256 },
    workingDirectory: `mcp/${server.serverId}`,
    literalEnv: access.literalEnv,
    credentialEnv: access.credentialEnv,
  });
}

export interface PreflightDeps {
  stateDir: string;
  /** The runtime's own pinned Bun. */
  bunPath: string;
  readCredential(slot: string): Promise<McpSlotRead>;
  /** Test seam: the bounded inspection itself. */
  inspect?: typeof inspectServer;
}

const subjectOf = (serverId: string, toolName?: string) =>
  toolName === undefined ? `mcp:${serverId}` : `mcp:${serverId}/${toolName}`;

export function createMcpPreflight(deps: PreflightDeps) {
  const inspect = deps.inspect ?? inspectServer;
  return async (input: {
    command: CommandDefinition;
    grants: CapabilityConfig;
    catalog: Catalog;
    policy: ContentPolicy;
  }): Promise<PreflightResult> => {
    const required = new Map<string, string[]>();
    for (const requirement of input.command.requires) {
      if (requirement.kind !== 'mcp') continue;
      required.set(requirement.serverId, [...(required.get(requirement.serverId) ?? []), requirement.toolName]);
    }
    const bound: BoundTools = { servers: [], tools: [], authority: [] };
    for (const [serverId, toolNames] of [...required].sort(([a], [b]) => (a < b ? -1 : 1))) {
      const result = await preflightServer(serverId, toolNames, input);
      if (!result.ok) return result;
      bound.servers.push(result.server);
      bound.tools.push(...result.tools);
      bound.authority.push(result.authority);
    }
    if (bound.tools.length > CAPABILITY_LIMITS.boundTools) {
      return { ok: false, code: 'capability_unavailable', reason: 'too_many_tools' };
    }
    return { ok: true, bound };
  };

  async function preflightServer(
    serverId: string,
    toolNames: readonly string[],
    input: { grants: CapabilityConfig; catalog: Catalog; policy: ContentPolicy },
  ): Promise<
    | Extract<PreflightResult, { ok: false }>
    | {
        ok: true;
        server: BoundTools['servers'][number];
        tools: BoundTools['tools'];
        authority: BoundTools['authority'][number];
      }
  > {
    const [firstTool] = toolNames;
    const refuse = (
      reason: string,
      code: 'capability_unavailable' | 'mcp_server_unavailable' = 'capability_unavailable',
      tool = firstTool,
    ) => ({
      ok: false as const,
      code,
      reason,
      subject: subjectOf(serverId, tool),
    });

    // Everything that can be decided without starting anything is decided first.
    const installed = input.catalog.installation.servers.find((server) => server.serverId === serverId);
    if (installed === undefined) return refuse('prerequisite_missing');
    const access = input.grants.servers.find((server) => server.serverId === serverId);
    if (access === undefined) return refuse('server_not_approved');
    if (access.approval.kind === 'denied') return refuse('server_denied');
    const program = input.grants.localPrograms[access.programId];
    if (program === undefined) return refuse('program_unavailable', 'mcp_server_unavailable');
    const digest = serverDigest(installed, access, program);
    if (access.approval.serverDigest !== digest) return refuse('server_reapproval_required');
    const grants = access.approval.tools;
    const ungranted = toolNames.find((name) => !grants.some((grant) => grant.name === name));
    if (ungranted !== undefined) return refuse('tool_not_granted', 'capability_unavailable', ungranted);
    const declaration = declarationLaunchInputs(installed.declaration);
    if (!declaration.ok) return refuse(declaration.reason);

    const credentialEnv: Record<string, string> = {};
    for (const [name, slot] of Object.entries(access.credentialEnv)) {
      const read = await deps.readCredential(slot);
      if (read.kind !== 'present') return refuse('credential_unavailable', 'mcp_server_unavailable');
      credentialEnv[name] = read.value;
    }
    const spec: LaunchSpec = {
      serverId,
      program,
      args: declaration.args,
      declarationEnv: declaration.env,
      literalEnv: access.literalEnv,
      credentialEnv,
    };
    const plan = await planLaunch(spec, { stateDir: deps.stateDir, bunPath: deps.bunPath, policy: input.policy });
    if (!plan.ok)
      return refuse(
        plan.reason,
        plan.reason === 'credential_in_declaration' ? 'capability_unavailable' : 'mcp_server_unavailable',
      );

    const discovery = await inspect({ params: plan.params, policy: input.policy });
    if (!('tools' in discovery)) return refuse(discovery.reason, 'mcp_server_unavailable');
    const found = new Map(discovery.tools.map((tool) => [tool.name, tool]));
    const supported = (name: string) => {
      const tool = found.get(name);
      return tool?.status === 'supported' ? (tool as Extract<DiscoveredTool, { status: 'supported' }>) : undefined;
    };
    for (const name of toolNames) {
      const tool = supported(name);
      const grant = grants.find((candidate) => candidate.name === name);
      if (tool === undefined) return refuse('tool_unavailable', 'capability_unavailable', name);
      if (tool.definitionDigest !== grant?.definitionDigest) {
        return refuse('tool_reapproval_required', 'capability_unavailable', name);
      }
    }

    // Every granted tool of this server whose advertised definition is the approved one is bound; the rest are not.
    const matching = grants.flatMap((grant) => {
      const tool = supported(grant.name);
      return tool !== undefined && tool.definitionDigest === grant.definitionDigest ? [{ grant, tool }] : [];
    });
    const adaptation = await adaptDefinitions(
      serverId,
      matching.map(({ tool }) => tool.raw),
    );
    if (!adaptation.ok) return refuse(adaptation.reason);
    return {
      ok: true,
      server: {
        serverId,
        origins: installed.origins.map(({ authoredName: _authored, ...origin }) => origin),
        declaration: installed.declaration,
        programId: access.programId,
        serverDigest: digest,
      },
      tools: matching.map(({ tool }) => ({
        serverId,
        toolName: tool.name,
        // Discovery admits only canonical JSON data.
        raw: tool.raw as BoundTools['tools'][number]['raw'],
        definitionDigest: tool.definitionDigest,
        adapted: adaptation.tools.get(tool.name) as BoundTools['tools'][number]['adapted'],
      })),
      authority: {
        serverId,
        serverDigest: digest,
        tools: matching.map(({ grant }) => ({
          name: grant.name,
          definitionDigest: grant.definitionDigest,
          argumentEquals: grant.argumentEquals,
        })),
      },
    };
  }
}
