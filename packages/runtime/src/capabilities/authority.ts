// Effective authority (design Decision 4): for each new operation, the run's captured authority ceiling intersected
// with the owner's current grants, the command's restriction and — for a delegate — the agent's restriction. Retained
// definitions say what an operation would be; they never grant it. Current grants come from configuration loaded at
// startup, so a revocation takes effect on restart and new configuration can never widen an accepted run. Nothing
// here reads the current installation: a run is judged by the declarations and definitions it retained.
import { argumentsMatch, type CapabilityConfig } from '../config/capabilities.ts';
import type { CapabilitySnapshot } from './records.ts';

type AgentDefinition = CapabilitySnapshot['agents'][number];

type McpRef = { serverId: string; toolName: string };

function narrow<T>(items: readonly T[], allowed: readonly T[] | undefined, same: (a: T, b: T) => boolean): T[] {
  return allowed === undefined ? [...items] : items.filter((item) => allowed.some((entry) => same(entry, item)));
}
const eq = (a: string, b: string) => a === b;
const sameTool = (a: McpRef, b: McpRef) => a.serverId === b.serverId && a.toolName === b.toolName;

/** Skills an actor may load now. Loading a skill never adds to this. */
export function effectiveSkills(
  snapshot: CapabilitySnapshot,
  current: CapabilityConfig | undefined,
  agent?: AgentDefinition,
): string[] {
  const root = narrow(
    narrow(snapshot.authority.skills, current?.allowSkills ?? [], eq),
    snapshot.command.restrict?.skills,
    eq,
  );
  return agent === undefined ? root : narrow(root, agent.restrict?.skills, eq);
}

/** Agents the root may delegate to now; delegates cannot delegate. */
export function effectiveAgents(
  snapshot: CapabilitySnapshot,
  current: CapabilityConfig | undefined,
  agent?: AgentDefinition,
): string[] {
  if (agent !== undefined) return [];
  return narrow(
    narrow(snapshot.authority.agents, current?.allowAgents ?? [], eq),
    snapshot.command.restrict?.agents,
    eq,
  );
}

export type McpAuthorization =
  | { ok: true; timeoutSeconds: number }
  | {
      ok: false;
      reason:
        | 'tool_unavailable'
        | 'not_in_run_authority'
        | 'restricted'
        | 'server_not_approved'
        | 'server_denied'
        | 'server_reapproval_required'
        | 'tool_not_granted'
        | 'tool_reapproval_required'
        | 'argument_out_of_scope';
    };

/**
 * Whether a new call to a retained MCP tool is permitted now. The checks are ordered from what the run retained to
 * what the owner currently grants, so a refusal names the narrowest reason. A changed server declaration blocks every
 * tool of that server; a changed tool definition blocks only that tool.
 */
export function authorizeMcpCall(input: {
  snapshot: CapabilitySnapshot;
  current: CapabilityConfig | undefined;
  agent?: AgentDefinition;
  serverId: string;
  toolName: string;
  args: Record<string, unknown>;
}): McpAuthorization {
  const { snapshot, current, agent, serverId, toolName, args } = input;
  const ref = { serverId, toolName };
  const server = snapshot.servers.find((candidate) => candidate.serverId === serverId);
  const tool = snapshot.tools.find((candidate) => sameTool(candidate, ref));
  if (server === undefined || tool === undefined) return { ok: false, reason: 'tool_unavailable' };

  const ceilingServer = snapshot.authority.servers.find(
    (candidate) => candidate.serverId === serverId && candidate.serverDigest === server.serverDigest,
  );
  const ceilingTool = ceilingServer?.tools.find(
    (candidate) => candidate.name === toolName && candidate.definitionDigest === tool.definitionDigest,
  );
  if (ceilingTool === undefined) return { ok: false, reason: 'not_in_run_authority' };

  const allTools = snapshot.tools.map(({ serverId: id, toolName: name }) => ({ serverId: id, toolName: name }));
  let allowed = narrow(allTools, snapshot.command.restrict?.mcp, sameTool);
  if (agent !== undefined) allowed = narrow(allowed, agent.restrict?.mcp, sameTool);
  if (!allowed.some((entry) => sameTool(entry, ref))) return { ok: false, reason: 'restricted' };

  const access = current?.servers.find((candidate) => candidate.serverId === serverId);
  if (access === undefined) return { ok: false, reason: 'server_not_approved' };
  if (access.approval.kind === 'denied') return { ok: false, reason: 'server_denied' };
  if (access.approval.serverDigest !== server.serverDigest) return { ok: false, reason: 'server_reapproval_required' };
  const grant = access.approval.tools.find((candidate) => candidate.name === toolName);
  if (grant === undefined) return { ok: false, reason: 'tool_not_granted' };
  if (grant.definitionDigest !== tool.definitionDigest) return { ok: false, reason: 'tool_reapproval_required' };

  if (!argumentsMatch(ceilingTool, args) || !argumentsMatch(grant, args)) {
    return { ok: false, reason: 'argument_out_of_scope' };
  }
  return { ok: true, timeoutSeconds: access.toolTimeoutSeconds };
}
