// A stock agent with the production model boundary, the provider's tool-name translation and two tools under
// canonical MCP-style names, for exercising a provider's wire names through its real model and terminal. The tools
// only record their calls. Test-only.
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { AIMessage, BaseMessage } from '@langchain/core/messages';
import { MemorySaver } from '@langchain/langgraph';
import { type AgentMiddleware, createAgent, tool } from 'langchain';
import { boundaryMiddleware } from '../src/execution/agent.ts';
import type { ModelCallReports } from '../src/execution/failures.ts';
import type { ContentPolicy } from '../src/security/content-policy.ts';
import { MemoryLedger } from './memory-ledger.ts';

/** Not acceptable to either provider's wire contract (`.`), and acceptable to OpenAI only (lowercase after `mcp_`). */
export const DOTTED = 'mcp_repo_list.items';
export const PLAIN = 'mcp_repo_count';

export function toolNameAgent(options: {
  runId: string;
  model: BaseChatModel;
  toolNames: AgentMiddleware;
  contentPolicy: () => ContentPolicy;
  reports?: ModelCallReports;
  modelCallSettled?: () => void;
  responseRefusal?: (message: AIMessage) => string | undefined;
}) {
  const calls: { name: string; args: unknown }[] = [];
  const names = [DOTTED, PLAIN];
  const tools = names.map((name) =>
    tool(
      async (args: unknown) => {
        calls.push({ name, args });
        return JSON.stringify({ outcome: 'ok', result: { tool: name } });
      },
      {
        name,
        description: `repo / ${name}`,
        schema: { type: 'object', properties: { repository: { type: 'string' } }, additionalProperties: false },
      },
    ),
  );
  const saver = new MemorySaver();
  const ledger = new MemoryLedger();
  let ids = 0;
  const agent = createAgent({
    model: options.model,
    tools,
    systemPrompt: 'Use the repository tools.',
    checkpointer: saver,
    middleware: [
      boundaryMiddleware({
        runId: options.runId,
        contentPolicy: options.contentPolicy,
        newMessageId: () => `msg_assigned_${++ids}`,
        operations: ledger,
        allowedTools: names,
        ...(options.reports === undefined ? {} : { reports: options.reports }),
        ...(options.modelCallSettled === undefined ? {} : { modelCallSettled: options.modelCallSettled }),
        ...(options.responseRefusal === undefined ? {} : { responseRefusal: options.responseRefusal }),
      }),
      options.toolNames,
    ],
  });
  const config = { configurable: { thread_id: options.runId }, recursionLimit: 20 };
  return {
    agent,
    calls,
    saver,
    ledger,
    invoke: (goal: string) => agent.invoke({ messages: [{ role: 'user', content: goal }] }, config),
    messages: async () => (await agent.graph.getState(config)).values.messages as BaseMessage[],
  };
}
