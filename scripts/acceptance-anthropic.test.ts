import { describe, expect, test } from 'bun:test';
import { repoRoot } from './lib/workspace.ts';

async function run(args: string[]) {
  const proc = Bun.spawn([process.execPath, '--no-env-file', 'scripts/acceptance-anthropic.ts', ...args], {
    cwd: repoRoot,
    env: { PATH: process.env.PATH ?? '' },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, out: `${out}${err}` };
}

describe('acceptance trial tool', () => {
  test('refuses unknown actions, non-HTTPS remote origins and reports without both runs', async () => {
    for (const args of [
      [],
      ['go', '--origin', 'https://node.example.ts.net'],
      ['check', '--origin', 'http://node.example.ts.net'],
      ['check'],
      ['check', '--origin', 'https://node.example.ts.net', '--trial', '../x'],
      ['report', '--origin', 'https://node.example.ts.net', '--journey', 'x'],
    ]) {
      const result = await run(args);
      expect(result.code).toBe(2);
      expect(result.out).toContain('usage: acceptance:anthropic');
    }
  });

  test('refuses, and changes nothing, when the runtime does not answer as the API', async () => {
    const requests: string[] = [];
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: (request) => {
        requests.push(`${request.method} ${new URL(request.url).pathname}`);
        return new Response('<html>not the runtime</html>', { status: 503 });
      },
    });
    try {
      const result = await run(['start', '--origin', `http://127.0.0.1:${server.port}`]);
      expect(result.code).toBe(1);
      expect(result.out).toContain('refused: the runtime’s options could not be read');
      expect(requests).toEqual(['GET /api/v1/options']);
    } finally {
      server.stop(true);
    }
  });
});
