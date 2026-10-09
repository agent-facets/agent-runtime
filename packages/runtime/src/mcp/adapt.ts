// Model-facing tool definitions from approved raw definitions (design Decisions 5 and 6). The LangChain adapter's
// public `loadMcpTools` performs the schema adaptation, given an inventory-only client that answers its listing from
// definitions already discovered, bounded and screened: it makes no request, and its call and resource methods
// refuse. Only the definition fields are kept; the adapter's generated invocation functions are discarded, so the
// runtime's own tools make every call. The raw definition stays the approval and validation input.
import { loadMcpTools } from '@langchain/mcp-adapters';
import { sha256Hex } from '../records/canonical.ts';

export interface AdaptedTool {
  /** `mcp_ext_` and 48 hex digits of the server/tool identity: stable, credential-safe and collision-checked. */
  name: string;
  description: string;
  schema: Record<string, unknown>;
}

export type Adaptation =
  | { ok: true; tools: Map<string, AdaptedTool> }
  | { ok: false; reason: 'adaptation_failed' | 'name_collision' };

/** The wire name of a server's tool. */
export function externalToolName(serverId: string, toolName: string): string {
  return `mcp_ext_${sha256Hex(`${serverId}\n${toolName}`).slice(0, 48)}`;
}

const DESCRIPTION_MAX_BYTES = 32 * 1024;

function boundedDescription(text: string): string {
  const bytes = new TextEncoder().encode(text);
  if (bytes.byteLength <= DESCRIPTION_MAX_BYTES) return text;
  return new TextDecoder().decode(bytes.subarray(0, DESCRIPTION_MAX_BYTES)).replace(/\uFFFD+$/, '');
}

/** A client double for `loadMcpTools`: it lists the given definitions and can do nothing else. */
function inventoryClient(definitions: readonly Record<string, unknown>[]) {
  const refuse = async () => {
    throw new Error('inventory-only client');
  };
  return {
    listTools: async () => ({ tools: structuredClone(definitions) }),
    callTool: refuse,
    readResource: refuse,
    request: refuse,
  };
}

/** Adapts one server's approved definitions; any tool the adapter cannot represent refuses the set. */
export async function adaptDefinitions(
  serverId: string,
  definitions: readonly Record<string, unknown>[],
): Promise<Adaptation> {
  const client = inventoryClient(definitions) as unknown as Parameters<typeof loadMcpTools>[1];
  let loaded: Awaited<ReturnType<typeof loadMcpTools>>;
  try {
    loaded = await loadMcpTools(serverId, client, { throwOnLoadError: false });
  } catch {
    return { ok: false, reason: 'adaptation_failed' };
  }
  const tools = new Map<string, AdaptedTool>();
  const names = new Set<string>();
  for (const definition of definitions) {
    const toolName = definition.name as string;
    const adapted = loaded.find((tool) => tool.name === toolName);
    if (adapted === undefined) return { ok: false, reason: 'adaptation_failed' };
    const name = externalToolName(serverId, toolName);
    if (names.has(name)) return { ok: false, reason: 'name_collision' };
    names.add(name);
    const description = typeof definition.description === 'string' ? definition.description : '';
    tools.set(toolName, {
      name,
      description: boundedDescription(`${serverId} / ${toolName}: ${description}`),
      // A plain JSON copy: nothing callable from the adapter's tool object survives.
      schema: JSON.parse(JSON.stringify(adapted.schema)) as Record<string, unknown>,
    });
  }
  return { ok: true, tools };
}
