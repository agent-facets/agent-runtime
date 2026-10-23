// Retained MCP definitions for a synthetic command snapshot, adapted by the real definition adapter, with the run's
// authority ceiling granting them. Test-only: nothing here is a real server or grant.
import { adaptDefinitions } from '../src/mcp/adapt.ts';
import { digestOf } from '../src/records/canonical.ts';

const ORIGIN = {
  facet: 'fixture-workflows',
  version: '0.0.1',
  source: 'local:fixture',
  integrity: `sha256-${'a'.repeat(64)}`,
};

export interface McpFixtureServer {
  serverId: string;
  declaration?: Record<string, unknown>;
  programId?: string;
  serverDigest: string;
  /** Raw advertised definitions, retained and granted. */
  tools: Record<string, unknown>[];
  /** The ceiling's argument restrictions by tool name. */
  argumentEquals?: Record<string, Record<string, unknown>>;
  /** Tools retained but outside the run's ceiling. */
  ungranted?: string[];
}

export async function withMcp<T extends { servers: unknown[]; tools: unknown[]; authority: { servers: unknown[] } }>(
  snapshot: T,
  servers: McpFixtureServer[],
): Promise<T> {
  const retainedServers: unknown[] = [];
  const tools: unknown[] = [];
  const ceiling: unknown[] = [];
  for (const server of servers) {
    const adapted = await adaptDefinitions(server.serverId, server.tools);
    if (!adapted.ok) throw new Error(adapted.reason);
    retainedServers.push({
      serverId: server.serverId,
      origins: [ORIGIN],
      declaration: server.declaration ?? { type: 'stdio', command: `./${server.serverId}`, args: [], env: {} },
      programId: server.programId ?? server.serverId,
      serverDigest: server.serverDigest,
    });
    for (const raw of server.tools) {
      const name = raw.name as string;
      tools.push({
        serverId: server.serverId,
        toolName: name,
        raw,
        definitionDigest: digestOf(raw),
        adapted: adapted.tools.get(name),
      });
    }
    ceiling.push({
      serverId: server.serverId,
      serverDigest: server.serverDigest,
      tools: server.tools
        .filter((raw) => !(server.ungranted ?? []).includes(raw.name as string))
        .map((raw) => ({
          name: raw.name,
          definitionDigest: digestOf(raw),
          argumentEquals: server.argumentEquals?.[raw.name as string] ?? {},
        })),
    });
  }
  return {
    ...snapshot,
    servers: [...snapshot.servers, ...retainedServers],
    tools: [...snapshot.tools, ...tools],
    authority: { ...snapshot.authority, servers: [...snapshot.authority.servers, ...ceiling] },
  };
}
