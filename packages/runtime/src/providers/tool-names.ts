// Provider wire names for tools (design Decision 6). The runtime names tools canonically — built-in names and
// `mcp_<serverId>_<toolName>` — and every agent definition, checkpoint and history record keeps those names. A
// provider whose wire contract cannot carry a name translates it for one model call only, through the agent's public
// model-call hook:
//   - the call's names (offered tools, an explicit tool choice and the tool calls already in its history) form one
//     immutable one-to-one mapping: a name the provider accepts stays as it is, and only the others get a short alias
//     no other name in the call uses;
//   - copies of the tool definitions, tool choice and history messages are sent under wire names (graph state and the
//     executable tools are never touched), and the parsed response's names are restored before anything else sees
//     it. The terminal's one renewal retry happens beneath this hook, so it re-sends the same names;
//   - only structured name fields change: call IDs, arguments, results, schemas and text are left alone. A returned
//     name the call did not offer under an alias passes through unchanged and is refused as unavailable; a canonical
//     name that was offered only under its alias cannot be meant as itself, and fails the call.
// No stream is parsed or rewritten here: the stock model has already assembled its response.
import { AIMessage, type BaseMessage, mapStoredMessageToChatMessage } from '@langchain/core/messages';
import { createMiddleware, tool } from 'langchain';
import { ExecutionFailure } from '../execution/failures.ts';

/** Aliases are `mcp_Alias_<n>`: never a canonical name, since server IDs and built-in names cannot take this form. */
export const TOOL_ALIAS_PREFIX = 'mcp_Alias_';

export interface ToolNameMapping {
  /** Every name in the call, to the name it is sent under. */
  readonly toWire: ReadonlyMap<string, string>;
  /** Every name sent, to the name it stands for. */
  readonly toCanonical: ReadonlyMap<string, string>;
  /** Whether any name is sent under an alias. */
  readonly aliased: boolean;
}

/** The call's mapping: accepted names unchanged, the others aliased in sorted order around them. */
export function toolNameMapping(names: Iterable<string>, accepts: (name: string) => boolean): ToolNameMapping {
  const all = [...new Set(names)].sort();
  const kept = all.filter(accepts);
  const toWire = new Map(kept.map((name) => [name, name]));
  const toCanonical = new Map(kept.map((name) => [name, name]));
  let next = 1;
  for (const name of all) {
    if (toWire.has(name)) continue;
    let alias = `${TOOL_ALIAS_PREFIX}${next++}`;
    while (toCanonical.has(alias)) alias = `${TOOL_ALIAS_PREFIX}${next++}`;
    if (!accepts(alias)) throw new ExecutionFailure('invariant_violation');
    toWire.set(name, alias);
    toCanonical.set(alias, name);
  }
  return { toWire, toCanonical, aliased: kept.length < all.length };
}

type Data = Record<string, unknown>;
const isRecord = (value: unknown): value is Data =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const records = (value: unknown): Data[] => (Array.isArray(value) ? value.filter(isRecord) : []);
const TOOL_BLOCKS = new Set(['tool_use', 'tool_call', 'tool_call_chunk', 'function_call']);

/**
 * Renames every structured tool name in a stored message's data, in place: tool calls (valid, invalid and chunked),
 * tool-use content blocks, legacy function-call arguments, and the provider's recorded output items and tool list,
 * which a later request may replay. Returns whether anything changed.
 */
export function renameToolNames(data: Data, rename: (name: string) => string): boolean {
  let changed = false;
  const at = (holder: Data, key: string) => {
    const value = holder[key];
    if (typeof value !== 'string') return;
    const next = rename(value);
    if (next !== value) {
      holder[key] = next;
      changed = true;
    }
  };
  for (const field of ['tool_calls', 'invalid_tool_calls', 'tool_call_chunks']) {
    for (const call of records(data[field])) at(call, 'name');
  }
  for (const block of records(data.content)) if (TOOL_BLOCKS.has(block.type as string)) at(block, 'name');
  const kwargs = isRecord(data.additional_kwargs) ? data.additional_kwargs : undefined;
  for (const call of records(kwargs?.tool_calls)) if (isRecord(call.function)) at(call.function, 'name');
  const metadata = isRecord(data.response_metadata) ? data.response_metadata : undefined;
  for (const item of records(metadata?.output)) if (item.type === 'function_call') at(item, 'name');
  for (const item of records(metadata?.tools)) if (item.type === 'function') at(item, 'name');
  return changed;
}

/** A plain copy of a model message's stored data, or undefined if it is not plain JSON. */
function dataOf(message: AIMessage): Data | undefined {
  try {
    const data: unknown = JSON.parse(JSON.stringify(message.toDict().data));
    return isRecord(data) ? data : undefined;
  } catch {
    return undefined;
  }
}

const rebuild = (data: Data) => mapStoredMessageToChatMessage({ type: 'ai', data: data as never }) as AIMessage;

/** Thrown for a response naming a tool the call did not offer under that name. */
const unrecognized = () =>
  new ExecutionFailure('model_request_failed', {
    kind: 'terminal',
    code: 'incomplete_response',
    reason: 'tool_name_unrecognized',
  });

/**
 * The model-call middleware translating tool names for a provider whose wire contract `accepts` some names only.
 * It keeps no state between calls: each call's mapping lives in that call alone.
 */
export function toolNameTranslation(accepts: (name: string) => boolean) {
  return createMiddleware({
    name: 'ProviderToolNames',
    wrapModelCall: async (request, handler) => {
      const names = new Set<string>();
      const collect = (name: string) => {
        names.add(name);
        return name;
      };
      for (const offered of request.tools) {
        const name = (offered as { name?: unknown }).name;
        if (typeof name === 'string') names.add(name);
      }
      const choice = request.toolChoice;
      if (typeof choice === 'object') names.add(choice.function.name);
      const history = request.messages.map((message) => {
        if (!AIMessage.isInstance(message)) return undefined;
        const data = dataOf(message);
        if (data === undefined) throw new ExecutionFailure('invariant_violation');
        renameToolNames(data, collect);
        return data;
      });
      const mapping = toolNameMapping(names, accepts);
      if (!mapping.aliased) return handler(request);

      const wire = (name: string) => mapping.toWire.get(name) ?? name;
      const tools = request.tools.map((offered) => {
        const name = (offered as { name?: unknown }).name;
        if (typeof name !== 'string' || wire(name) === name) return offered;
        const definition = offered as { description?: unknown; schema?: unknown; invoke?: unknown };
        if (typeof definition.invoke !== 'function') throw new ExecutionFailure('invariant_violation');
        // A definition only: calls are restored to the canonical tool before anything runs.
        return tool(
          async () => {
            throw new ExecutionFailure('invariant_violation');
          },
          {
            name: wire(name),
            description: typeof definition.description === 'string' ? definition.description : '',
            schema: definition.schema as never,
          },
        );
      });
      const messages = request.messages.map((message, index): BaseMessage => {
        const data = history[index];
        return data !== undefined && renameToolNames(data, wire) ? rebuild(data) : message;
      });
      const response = await handler({
        ...request,
        tools: tools as typeof request.tools,
        messages,
        ...(typeof choice === 'object'
          ? { toolChoice: { ...choice, function: { ...choice.function, name: wire(choice.function.name) } } }
          : {}),
      });

      if (!AIMessage.isInstance(response)) return response;
      const data = dataOf(response);
      if (data === undefined) throw new ExecutionFailure('invariant_violation');
      const restored = renameToolNames(data, (name) => {
        const canonical = mapping.toCanonical.get(name);
        if (canonical !== undefined) return canonical;
        if (mapping.toWire.has(name)) throw unrecognized();
        return name;
      });
      return restored ? rebuild(data) : response;
    },
  });
}
