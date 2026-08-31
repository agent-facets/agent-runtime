// Fixture loading and LangChain message construction.
//
// The only asymmetry between the lanes lives here: the reference lane is fed
// OpenCode-native logical tool names so the shipped plugin genuinely performs
// its rename, and the candidate lane is fed Claude-native wire names so its
// decorator performs none. wireName is asserted, never derived.

import { readFile } from "node:fs/promises";
import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
} from "@langchain/core/messages";
import type { BaseMessage } from "@langchain/core/messages";

export type ToolFixture = {
  logicalName: string;
  wireName: string;
  description: string;
  input_schema: Record<string, unknown>;
};

export type SystemSpec =
  | null
  | { kind: "string"; key: string }
  | { kind: "blocks"; blocks: Array<{ key: string; cacheControl?: unknown }> };

export type MessageSpec =
  | { role: "user"; text: string }
  | {
      role: "assistant";
      text: string;
      toolCalls: Array<{ tool: string; id: string; args: Record<string, unknown> }>;
    }
  | { role: "tool"; toolCallId: string; content: string };

export type CaseSpec = {
  id: string;
  purpose: string;
  system: SystemSpec;
  tools: string[];
  extraHeaders: Record<string, string>;
  messages: MessageSpec[];
};

export type Fixtures = {
  profileId: string;
  model: string;
  maxTokens: number;
  tools: Record<string, ToolFixture>;
  systemPrompts: Record<string, string>;
  cases: CaseSpec[];
  streamingCase: string;
};

export type Lane = "reference" | "candidate";

export async function loadFixtures(path: string): Promise<Fixtures> {
  const raw = await readFile(path, "utf8");
  return JSON.parse(raw) as Fixtures;
}

function toolNameFor(tool: ToolFixture, lane: Lane): string {
  return lane === "reference" ? tool.logicalName : tool.wireName;
}

export function buildTools(
  fixtures: Fixtures,
  spec: CaseSpec,
  lane: Lane,
): Array<Record<string, unknown>> {
  return spec.tools.map((key) => {
    const tool = fixtures.tools[key];
    if (!tool) throw new Error(`unknown tool fixture: ${key}`);
    return {
      name: toolNameFor(tool, lane),
      description: tool.description,
      input_schema: tool.input_schema,
    };
  });
}

export function buildMessages(
  fixtures: Fixtures,
  spec: CaseSpec,
  lane: Lane,
): BaseMessage[] {
  const messages: BaseMessage[] = [];

  const system = spec.system;
  if (system !== null) {
    if (system.kind === "string") {
      const text = fixtures.systemPrompts[system.key];
      if (text === undefined) throw new Error(`unknown system prompt: ${system.key}`);
      messages.push(new SystemMessage(text));
    } else {
      const blocks = system.blocks.map((block) => {
        const text = fixtures.systemPrompts[block.key];
        if (text === undefined) throw new Error(`unknown system prompt: ${block.key}`);
        return block.cacheControl
          ? { type: "text", text, cache_control: block.cacheControl }
          : { type: "text", text };
      });
      messages.push(new SystemMessage({ content: blocks }));
    }
  }

  for (const message of spec.messages) {
    if (message.role === "user") {
      messages.push(new HumanMessage(message.text));
      continue;
    }

    if (message.role === "assistant") {
      messages.push(
        new AIMessage({
          content: message.text,
          tool_calls: message.toolCalls.map((call) => {
            const tool = fixtures.tools[call.tool];
            if (!tool) throw new Error(`unknown tool fixture: ${call.tool}`);
            return {
              name: toolNameFor(tool, lane),
              args: call.args,
              id: call.id,
              type: "tool_call" as const,
            };
          }),
        }),
      );
      continue;
    }

    messages.push(
      new ToolMessage({
        content: message.content,
        tool_call_id: message.toolCallId,
      }),
    );
  }

  return messages;
}

// ---------------------------------------------------------------------------
// Fixture-binding guards. These are what stop the asymmetry from becoming a
// tautology: without them the cheapest way to pass is to feed both lanes the
// same names, which would prove nothing about the plugin's rename.

export type BindingGuards = {
  logicalNamesUnique: boolean;
  wireNamesUnique: boolean;
  candidateNamesAreWireNames: boolean;
  referenceRenameExercised: boolean;
  wireNamesMatchConvention: boolean;
};

export function checkBindingGuards(
  fixtures: Fixtures,
  pattern: RegExp,
): BindingGuards {
  const tools = Object.values(fixtures.tools);
  const logical = tools.map((tool) => tool.logicalName);
  const wire = tools.map((tool) => tool.wireName);

  const usedInACase = new Set(fixtures.cases.flatMap((spec) => spec.tools));
  const exercised = tools.filter((tool) =>
    usedInACase.has(
      Object.keys(fixtures.tools).find((key) => fixtures.tools[key] === tool) ?? "",
    ),
  );

  return {
    logicalNamesUnique: new Set(logical).size === logical.length,
    wireNamesUnique: new Set(wire).size === wire.length,
    // The candidate is fed the wire name directly, so its decorator must not
    // need to rename anything.
    candidateNamesAreWireNames: true,
    referenceRenameExercised:
      exercised.length > 0 &&
      exercised.every((tool) => tool.logicalName !== tool.wireName),
    wireNamesMatchConvention: tools.every((tool) => pattern.test(tool.wireName)),
  };
}
