// Why OpenAI inference uses Bun's own fetch. The spike measured Node's fetch (undici) adding `accept-language` and
// `sec-fetch-mode`, which no caller can remove, and chose node:http. Bun's fetch is a different implementation; this
// captures its raw request bytes on a loopback socket (no provider is contacted) so a Bun upgrade that starts adding
// browser-style headers fails here instead of silently changing the wire profile.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createServer, type Server } from 'node:net';

let server: Server;
let port = 0;
const captured: string[] = [];

beforeAll(async () => {
  server = createServer((socket) => {
    let text = '';
    socket.on('data', (chunk) => {
      text += chunk.toString('latin1');
      const end = text.indexOf('\r\n\r\n');
      if (end < 0) return;
      captured.push(text.slice(0, end));
      socket.end('HTTP/1.1 200 OK\r\ncontent-length: 2\r\nconnection: close\r\n\r\nok');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as { port: number }).port;
});
afterAll(() => server.close());

describe('Bun fetch as the OpenAI transport', () => {
  test('adds only connection-level headers to what the profile sets', async () => {
    const profileHeaders = {
      accept: 'text/event-stream',
      'content-type': 'application/json',
      authorization: 'Bearer synthetic-transport-token',
      'chatgpt-account-id': 'acct_synthetic',
      originator: 'codex_exec',
      version: '0.151.0',
      'user-agent': 'codex_exec/0.151.0 (Linux 6.0.0; x86_64) agent-runtime',
    };
    const response = await fetch(`http://127.0.0.1:${port}/backend-api/codex/responses`, {
      method: 'POST',
      headers: profileHeaders,
      body: '{"a":1}',
      redirect: 'manual',
    });
    await response.text();
    const [head] = captured;
    const lines = (head ?? '').split('\r\n');
    expect(lines[0]).toBe('POST /backend-api/codex/responses HTTP/1.1');
    const names = lines.slice(1).map((line) => line.slice(0, line.indexOf(':')).toLowerCase());
    const added = names.filter((name) => !(name in profileHeaders)).sort();
    expect(added).toEqual(['accept-encoding', 'connection', 'content-length', 'host']);
    expect(names).not.toContain('accept-language');
    expect(names).not.toContain('sec-fetch-mode');
  });
});
