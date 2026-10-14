import { describe, expect, test } from 'bun:test';
import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import { tool } from 'langchain';
import { ExecutionFailure } from '../execution/failures.ts';
import { renameToolNames, toolNameMapping, toolNameTranslation } from './tool-names.ts';

const accepts = (name: string) => /^[A-Za-z0-9_-]{1,64}$/.test(name);
const DOTTED = 'mcp_repo_list.items';
const LONG = `mcp_${'s'.repeat(64)}_${'t'.repeat(128)}`;

const definition = (name: string) =>
  tool(async () => 'unused', { name, description: `repo / ${name}`, schema: { type: 'object', properties: {} } });

type Hook = (request: Record<string, unknown>, handler: (request: never) => Promise<unknown>) => Promise<unknown>;
const hookOf = (predicate: (name: string) => boolean) =>
  (toolNameTranslation(predicate) as unknown as { wrapModelCall: Hook }).wrapModelCall;

describe('the per-call name mapping', () => {
  test('keeps accepted names, aliases the rest one to one, and never reuses a name the call already has', () => {
    const mapping = toolNameMapping(['mcp_Read', DOTTED, LONG, 'mcp_Alias_1', 'mcp_repo_ok'], accepts);
    expect(mapping.toWire.get('mcp_Read')).toBe('mcp_Read');
    expect(mapping.toWire.get('mcp_repo_ok')).toBe('mcp_repo_ok');
    // `mcp_Alias_1` is a name this call already uses (an earlier unknown call), so aliases go around it.
    expect(mapping.toWire.get('mcp_Alias_1')).toBe('mcp_Alias_1');
    const aliases = [mapping.toWire.get(LONG), mapping.toWire.get(DOTTED)];
    expect(new Set(aliases).size).toBe(2);
    expect(aliases).not.toContain('mcp_Alias_1');
    for (const alias of aliases) expect(accepts(alias as string)).toBe(true);
    for (const [canonical, wire] of mapping.toWire) expect(mapping.toCanonical.get(wire)).toBe(canonical);
    expect(mapping.toCanonical.size).toBe(mapping.toWire.size);
    expect(mapping.aliased).toBe(true);
  });

  test('is a function of the call’s names alone: the same names give the same wire names, in any order', () => {
    const one = toolNameMapping([DOTTED, LONG, 'mcp_Read'], accepts);
    const two = toolNameMapping(['mcp_Read', LONG, DOTTED, DOTTED], accepts);
    expect([...two.toWire].sort()).toEqual([...one.toWire].sort());
    expect(toolNameMapping(['mcp_Read'], accepts).aliased).toBe(false);
  });

  test('renames every structured name field and nothing else', () => {
    const data = {
      content: [
        { type: 'text', text: `call ${DOTTED} now` },
        { type: 'tool_use', id: 'toolu_1', name: DOTTED, input: { name: DOTTED } },
      ],
      tool_calls: [{ id: 'toolu_1', name: DOTTED, args: { name: DOTTED }, type: 'tool_call' }],
      invalid_tool_calls: [{ id: 'toolu_2', name: DOTTED, args: '{', type: 'invalid_tool_call' }],
      tool_call_chunks: [{ id: 'toolu_1', name: DOTTED, args: '{}', index: 0 }],
      additional_kwargs: { tool_calls: [{ id: 'toolu_1', function: { name: DOTTED, arguments: '{}' } }] },
      response_metadata: {
        output: [{ type: 'function_call', call_id: 'toolu_1', name: DOTTED, arguments: '{}' }],
        tools: [{ type: 'function', name: DOTTED, description: DOTTED }],
      },
    };
    expect(renameToolNames(data, (name) => (name === DOTTED ? 'mcp_Alias_1' : name))).toBe(true);
    expect(JSON.stringify(data).split('mcp_Alias_1')).toHaveLength(8);
    // Text, arguments, IDs and descriptions keep the canonical spelling.
    expect(data.content[0]).toEqual({ type: 'text', text: `call ${DOTTED} now` });
    expect(data.tool_calls[0]?.args).toEqual({ name: DOTTED });
    expect(data.response_metadata.tools[0]?.description).toBe(DOTTED);
    expect(renameToolNames(data, (name) => name)).toBe(false);
  });
});

describe('the model-call middleware', () => {
  test('a call whose names are all accepted reaches the model unchanged', async () => {
    const request = { tools: [definition('mcp_Read')], messages: [new HumanMessage('Hi.')] };
    let seen: unknown;
    const reply = new AIMessage({ id: 'm1', content: 'Done.' });
    expect(
      await hookOf(accepts)(request, async (sent) => {
        seen = sent;
        return reply;
      }),
    ).toBe(reply);
    expect(seen).toBe(request);
  });

  test('sends wire names for definitions, tool choice and history, and restores the response before returning it', async () => {
    const tools = [definition('mcp_Read'), definition(DOTTED)];
    const history = new AIMessage({
      id: 'm0',
      content: [{ type: 'tool_use', id: 'toolu_0', name: DOTTED, input: { repository: 'a' } }],
      tool_calls: [{ id: 'toolu_0', name: DOTTED, args: { repository: 'a' }, type: 'tool_call' }],
    });
    const result = new ToolMessage({ tool_call_id: 'toolu_0', name: DOTTED, content: '{"outcome":"ok"}' });
    const request = {
      tools,
      messages: [new HumanMessage('Go.'), history, result],
      toolChoice: { type: 'function', function: { name: DOTTED } },
    };
    type Sent = { tools: { name: string }[]; messages: unknown[]; toolChoice: { function: { name: string } } };
    const seen: { request?: Sent } = {};
    const response = await hookOf(accepts)(request, async (outgoing: Sent) => {
      seen.request = outgoing;
      const alias = outgoing.tools[1]?.name as string;
      return new AIMessage({
        id: 'm1',
        content: [{ type: 'tool_use', id: 'toolu_1', name: alias, input: { repository: 'b' } }],
        tool_calls: [{ id: 'toolu_1', name: alias, args: { repository: 'b' }, type: 'tool_call' }],
      });
    });
    const sent = seen.request;
    const alias = sent?.tools[1]?.name as string;
    expect(alias).toMatch(/^mcp_Alias_\d+$/);
    expect(sent?.tools[0]).toBe(tools[0]);
    expect(sent?.toolChoice.function.name).toBe(alias);
    const replayed = sent?.messages[1] as AIMessage;
    expect(replayed.tool_calls?.[0]).toMatchObject({ id: 'toolu_0', name: alias, args: { repository: 'a' } });
    expect(JSON.stringify(replayed.content)).toContain(alias);
    // Copies were sent: the graph's messages, tools and choice are untouched.
    expect(history.tool_calls?.[0]?.name).toBe(DOTTED);
    expect(tools[1]?.name).toBe(DOTTED);
    expect(request.toolChoice.function.name).toBe(DOTTED);
    expect(sent?.messages[2]).toBe(result);

    const restored = response as AIMessage;
    expect(restored.tool_calls?.[0]).toMatchObject({ id: 'toolu_1', name: DOTTED, args: { repository: 'b' } });
    expect(JSON.stringify(restored.toDict())).not.toContain('mcp_Alias_');
  });

  test('an unknown alias is left to be refused; a canonical name offered only under its alias fails the call', async () => {
    const request = { tools: [definition(DOTTED)], messages: [new HumanMessage('Go.')] };
    const call = (name: string) => async () =>
      new AIMessage({ id: 'm1', content: '', tool_calls: [{ id: 'c1', name, args: {}, type: 'tool_call' }] });
    const unknown = (await hookOf(accepts)(request, call('mcp_Alias_9'))) as AIMessage;
    expect(unknown.tool_calls?.[0]?.name).toBe('mcp_Alias_9');
    const failure = await hookOf(accepts)(request, call(DOTTED)).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ExecutionFailure);
    expect((failure as ExecutionFailure).evidence).toEqual({
      kind: 'terminal',
      code: 'incomplete_response',
      reason: 'tool_name_unrecognized',
    });
  });

  test('concurrent calls keep separate mappings: one wire name stands for different tools in each', async () => {
    const hook = hookOf(accepts);
    const answer = (delay: number) => async (outgoing: { tools: { name: string }[] }) => {
      await Bun.sleep(delay);
      const name = outgoing.tools[0]?.name as string;
      return new AIMessage({ id: 'm', content: '', tool_calls: [{ id: 'c', name, args: {}, type: 'tool_call' }] });
    };
    const [a, b] = (await Promise.all([
      hook({ tools: [definition(DOTTED)], messages: [] }, answer(10) as never),
      hook({ tools: [definition('mcp_aaa_x.y'), definition(DOTTED)], messages: [] }, answer(0) as never),
    ])) as [AIMessage, AIMessage];
    expect(a.tool_calls?.[0]?.name).toBe(DOTTED);
    expect(b.tool_calls?.[0]?.name).toBe('mcp_aaa_x.y');
  });
});
