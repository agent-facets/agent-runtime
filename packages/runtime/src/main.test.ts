import { describe, expect, test } from 'bun:test';
import { dirname, join, resolve } from 'node:path';

const srcDir = import.meta.dir;
const transpiler = new Bun.Transpiler({ loader: 'ts' });

/** Modules evaluated before main.ts's guard runs: its static, value (non-type) import closure. */
async function staticClosure(entry: string): Promise<Set<string>> {
  const seen = new Set<string>();
  const pending = [entry];
  while (pending.length > 0) {
    const file = pending.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    const { imports } = transpiler.scan(await Bun.file(file).text());
    for (const { path, kind } of imports) {
      if (kind !== 'import-statement') continue;
      if (path.startsWith('.')) pending.push(resolve(dirname(file), path));
      else seen.add(path);
    }
  }
  return seen;
}

function runMain(env: Record<string, string>) {
  return Bun.spawnSync(['bun', '--no-env-file', join(srcDir, 'main.ts')], {
    env: { PATH: process.env.PATH ?? '', ...env },
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 20_000,
  });
}

describe('startup guards', () => {
  test('no framework, provider or database module loads before the environment is checked', async () => {
    const closure = [...(await staticClosure(join(srcDir, 'main.ts')))];
    const external = closure.filter((specifier) => !specifier.startsWith('/'));
    // The contracts package is pure validation (zod only); the workspace-boundary tests enforce that.
    expect(external.sort()).toEqual(['@agent-runtime/contracts', 'zod']);
  });

  test('an enabled tracing setting stops the process before it listens', () => {
    const result = runMain({ LANGCHAIN_TRACING_V2: 'true', LANGSMITH_API_KEY: 'lsv2-synthetic-secret' });
    expect(result.exitCode).toBe(1);
    const output = `${result.stdout}${result.stderr}`;
    expect(output).toContain('refusing to start: LANGCHAIN_TRACING_V2 (tracing_enabled)');
    expect(output).not.toContain('listening');
    expect(output).not.toContain('lsv2-synthetic-secret');
  });

  test('the operator command loads nothing external before its environment check either', async () => {
    const closure = [...(await staticClosure(join(srcDir, 'auth.ts')))];
    expect(closure.filter((specifier) => !specifier.startsWith('/'))).toEqual([]);
  });

  test('enabled debug logging, including the MCP adapter namespaces, stops both entry points first', () => {
    for (const value of ['*', '@langchain/mcp-adapters:*', '@langchain/mcp-adapters:tools', 'true']) {
      const result = runMain({ DEBUG: value });
      expect(result.exitCode).toBe(1);
      expect(`${result.stderr}`).toContain('refusing to start: DEBUG (debug_logging)');
      expect(`${result.stdout}`).not.toContain('listening');
      const auth = Bun.spawnSync(['bun', '--no-env-file', join(srcDir, 'auth.ts'), 'mcp', 'status', 'slot'], {
        env: { PATH: process.env.PATH ?? '', DEBUG: value },
        stdout: 'pipe',
        stderr: 'pipe',
        timeout: 20_000,
      });
      expect(auth.exitCode).toBe(1);
      expect(`${auth.stderr}`).toContain('refusing to run: DEBUG (debug_logging)');
    }
  });

  test('with accepted debug settings the MCP adapter writes nothing, even for definitions it cannot adapt', () => {
    // A client double whose tools exercise the adapter's warning and load-error logging paths.
    const script = `
      const { loadMcpTools } = await import('@langchain/mcp-adapters');
      const client = { listTools: async () => ({ tools: [
        { name: 'refs', inputSchema: { type: 'object', properties: { a: { $ref: '#/$defs/missing' } } } },
        { name: 'broken', inputSchema: { type: 'object', properties: { a: { type: 'bogus-type' } } } },
      ] }) };
      await loadMcpTools('fixture', client, { throwOnLoadError: false });
    `;
    for (const env of [{}, { DEBUG: '' }, { DEBUG: '0' }, { DEBUG: 'false' }]) {
      const result = Bun.spawnSync(['bun', '--no-env-file', '-e', script], {
        cwd: join(srcDir, '..'),
        env: { PATH: process.env.PATH ?? '', ...env },
        stdout: 'pipe',
        stderr: 'pipe',
        timeout: 20_000,
      });
      expect(result.exitCode).toBe(0);
      expect(`${result.stdout}${result.stderr}`).toBe('');
    }
    // Control: the same inputs do reach the adapter's logger when its namespace is enabled (which startup refuses).
    const control = Bun.spawnSync(['bun', '--no-env-file', '-e', script], {
      cwd: join(srcDir, '..'),
      env: { PATH: process.env.PATH ?? '', DEBUG: '@langchain/mcp-adapters:*' },
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 20_000,
    });
    expect(`${control.stderr}`).toContain('@langchain/mcp-adapters:tools');
  });

  test('an unreadable operator configuration stops the process with a safe message', () => {
    const result = runMain({ RUNTIME_CONFIG_FILE: '/nonexistent/agent-runtime/config.json' });
    expect(result.exitCode).toBe(1);
    expect(`${result.stderr}`).toContain('refusing to start: RUNTIME_CONFIG_FILE could not be read');
    expect(`${result.stdout}`).not.toContain('listening');
  });
});
