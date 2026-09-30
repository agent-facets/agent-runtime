// Requests shaped like those the pinned stock ChatAnthropic sends (captured from @langchain/anthropic 1.5.11 with
// @anthropic-ai/sdk 0.122.0): a JSON string body with `stream`, `tools`, `messages` and `system`, and the SDK's
// headers including its sentinel x-api-key. The golden outputs for these inputs come from the upstream reference
// implementation (generate.ts), not from this package.

export const ACCESS_TOKEN = 'sk-ant-oat01-golden-synthetic-access-token';

const SDK_HEADERS = {
  accept: 'application/json',
  'anthropic-version': '2023-06-01',
  'content-type': 'application/json',
  'user-agent': 'Anthropic/JS 0.122.0',
  'x-api-key': 'sentinel-not-a-key',
  'x-stainless-arch': 'x64',
  'x-stainless-lang': 'js',
  'x-stainless-os': 'Linux',
  'x-stainless-package-version': '0.122.0',
  'x-stainless-retry-count': '0',
  'x-stainless-runtime': 'node',
  'x-stainless-runtime-version': 'v24.3.0',
  'x-stainless-timeout': '600',
};

const SYSTEM =
  'You are investigating a repository for its owner. You can read files, list directories and search text in the configured workspace, and ask the owner a question.';

const TOOLS = [
  {
    name: 'mcp_Read',
    description: 'Read a file or list a directory in the workspace.',
    input_schema: {
      type: 'object',
      properties: { mode: { type: 'string', enum: ['file', 'directory'] }, path: { type: 'string' } },
      required: ['mode', 'path'],
      additionalProperties: false,
    },
  },
  {
    name: 'mcp_Search',
    description: 'Search workspace text.',
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'mcp_AskUser',
    description: 'Ask the owner one question.',
    input_schema: {
      type: 'object',
      properties: { prompt: { type: 'string' } },
      required: ['prompt'],
      additionalProperties: false,
    },
  },
];

export interface GoldenInput {
  name: string;
  url: string;
  headers: Record<string, string>;
  body: string;
}

const request = (name: string, body: Record<string, unknown>, headers: Record<string, string> = {}): GoldenInput => ({
  name,
  url: 'https://api.anthropic.com/v1/messages',
  headers: { ...SDK_HEADERS, ...headers },
  body: JSON.stringify(body),
});

export const GOLDEN_INPUTS: GoldenInput[] = [
  request('first turn', {
    model: 'claude-opus-5',
    stream: true,
    max_tokens: 16384,
    tools: TOOLS,
    messages: [{ role: 'user', content: 'Summarize the plan in notes/plan.md.' }],
    system: SYSTEM,
  }),
  request('tool result round', {
    model: 'claude-opus-5',
    stream: true,
    max_tokens: 16384,
    tools: TOOLS,
    messages: [
      { role: 'user', content: 'Summarize the plan in notes/plan.md.' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Reading it.' },
          { type: 'tool_use', id: 'toolu_01', name: 'mcp_Read', input: { mode: 'file', path: 'notes/plan.md' } },
        ],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', content: '{"outcome":"ok","result":{"lines":[]}}', tool_use_id: 'toolu_01' }],
      },
    ],
    system: SYSTEM,
  }),
  request('question resume with a negative answer', {
    model: 'claude-opus-5',
    stream: true,
    max_tokens: 16384,
    tools: TOOLS,
    messages: [
      { role: 'user', content: 'Decide whether to proceed.' },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'toolu_02', name: 'mcp_AskUser', input: { prompt: 'Proceed?' } }],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', content: '{"outcome":"ok","result":{"answer":false}}', tool_use_id: 'toolu_02' },
        ],
      },
    ],
    system: SYSTEM,
  }),
  request(
    'block content, block system and extra betas',
    {
      model: 'claude-opus-5',
      stream: true,
      max_tokens: 1024,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Hi there, what is in the workspace?' }] }],
      system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
    },
    { 'anthropic-beta': 'custom-beta-1, oauth-2025-04-20' },
  ),
];
