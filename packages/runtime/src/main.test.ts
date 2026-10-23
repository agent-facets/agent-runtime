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
    expect(external.sort()).toEqual(['zod']);
  });

  test('an enabled tracing setting stops the process before it listens', () => {
    const result = runMain({ LANGCHAIN_TRACING_V2: 'true', LANGSMITH_API_KEY: 'lsv2-synthetic-secret' });
    expect(result.exitCode).toBe(1);
    const output = `${result.stdout}${result.stderr}`;
    expect(output).toContain('refusing to start: LANGCHAIN_TRACING_V2 (tracing_enabled)');
    expect(output).not.toContain('listening');
    expect(output).not.toContain('lsv2-synthetic-secret');
  });

  test('an unreadable operator configuration stops the process with a safe message', () => {
    const result = runMain({ RUNTIME_CONFIG_FILE: '/nonexistent/agent-runtime/config.json' });
    expect(result.exitCode).toBe(1);
    expect(`${result.stderr}`).toContain('refusing to start: RUNTIME_CONFIG_FILE could not be read');
    expect(`${result.stdout}`).not.toContain('listening');
  });
});
