// A synthetic MCP server for the explicitly launched MCP/Bun integration gate. It is test input only: never listed in
// the program inventory, never shipped in an image. Each tool exercises one boundary behavior. The server appends
// every start, listing, call and resource read to `$HOME/witness.log`, so tests count processes and requests
// independently of the client under test. `--variant=changed` advertises a changed `list_items` definition.
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  CreateMessageResultSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const home = process.env.HOME ?? '.';
const variant = process.argv.includes('--variant=changed') ? 'changed' : 'base';
const note = (line: string) => appendFileSync(join(home, 'witness.log'), `${line}\n`);
note(`spawn ${process.pid}`);

const empty = { type: 'object', properties: {} };
const tools = [
  {
    name: 'list_items',
    description: 'Lists synthetic items in one repository.',
    inputSchema: {
      type: 'object',
      properties: { repository: { type: 'string', ...(variant === 'changed' ? { maxLength: 100 } : {}) } },
      required: ['repository'],
      additionalProperties: false,
    },
  },
  { name: 'fail', description: 'Reports a tool error.', inputSchema: empty },
  {
    name: 'slow',
    description: 'Replies after a delay.',
    inputSchema: { type: 'object', properties: { ms: { type: 'integer', minimum: 0 } }, required: ['ms'] },
  },
  { name: 'crash', description: 'Exits without replying.', inputSchema: empty },
  {
    name: 'big',
    description: 'Replies with large text.',
    inputSchema: { type: 'object', properties: { bytes: { type: 'integer', minimum: 0 } }, required: ['bytes'] },
  },
  { name: 'echo_secret', description: 'Echoes its credential.', inputSchema: empty },
  { name: 'env', description: 'Describes its environment.', inputSchema: empty },
  { name: 'binary', description: 'Replies with an image.', inputSchema: empty },
  { name: 'resource', description: 'Replies with resources.', inputSchema: empty },
  { name: 'noisy', description: 'Writes to standard error.', inputSchema: empty },
  { name: 'ask', description: 'Asks the client to sample a model.', inputSchema: empty },
  {
    name: 'remember',
    description: 'Stores a value in its home directory.',
    inputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] },
  },
  { name: 'recall', description: 'Reads the stored value.', inputSchema: empty },
];

const server = new Server({ name: 'synthetic', version: '1.0.0' }, { capabilities: { tools: {}, resources: {} } });
const text = (value: string) => ({ content: [{ type: 'text', text: value }] });

server.setRequestHandler(ListToolsRequestSchema, async () => {
  note('list');
  return { tools };
});
server.setRequestHandler(ReadResourceRequestSchema, async () => {
  note('resources/read');
  return { contents: [] };
});
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name } = request.params;
  const args = (request.params.arguments ?? {}) as Record<string, unknown>;
  note(`call ${name}`);
  switch (name) {
    case 'list_items':
      return { ...text(`2 items in ${String(args.repository)}`), structuredContent: { count: 2 } };
    case 'fail':
      return { isError: true, ...text(`failure detail ${process.env.REPO_TOKEN ?? ''}`) };
    case 'slow':
      await new Promise((resolve) => setTimeout(resolve, Number(args.ms)));
      return text('slow done');
    case 'crash':
      process.exit(3);
      break;
    case 'big':
      return text('x'.repeat(Number(args.bytes)));
    case 'echo_secret':
      return { ...text(`token=${process.env.REPO_TOKEN ?? ''}`), structuredContent: { token: process.env.REPO_TOKEN } };
    case 'env':
      return {
        ...text('environment'),
        structuredContent: {
          names: Object.keys(process.env).sort(),
          home: process.env.HOME,
          tmpdir: process.env.TMPDIR,
          cwd: process.cwd(),
          path: process.env.PATH,
          user: process.env.USER,
        },
      };
    case 'binary':
      return { content: [{ type: 'image', data: Buffer.from('synthetic').toString('base64'), mimeType: 'image/png' }] };
    case 'resource':
      return {
        content: [
          { type: 'resource_link', uri: 'synthetic://item/1', name: 'item' },
          { type: 'resource', resource: { uri: 'synthetic://item/2', text: 'embedded' } },
        ],
      };
    case 'noisy':
      for (let line = 0; line < 50; line++) console.error(`noise ${line} ${process.env.REPO_TOKEN ?? ''}`);
      return text('quiet');
    case 'ask':
      try {
        await server.request(
          { method: 'sampling/createMessage', params: { messages: [], maxTokens: 1 } },
          CreateMessageResultSchema,
        );
        return text('sampling answered');
      } catch (error) {
        return text(`sampling refused ${(error as { code?: number }).code ?? 'unknown'}`);
      }
    case 'remember':
      writeFileSync(join(home, 'memory.txt'), String(args.value));
      return text('remembered');
    case 'recall':
      return text(readFileSync(join(home, 'memory.txt'), 'utf8'));
    default:
      return { isError: true, ...text('unknown tool') };
  }
});

await server.connect(new StdioServerTransport());
