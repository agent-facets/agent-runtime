// Explicit fixture launchers run with an allowlisted environment and refuse ambient settings
// that could redirect them to owner storage, credentials, Compose projects or providers.

export const forwardedEnvNames = ['PATH', 'HOME', 'TMPDIR', 'TERM', 'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG'];

const refusedEnvPatterns = [
  /^COMPOSE_/,
  /^(?:TEST_)?DATABASE_URL$/,
  /^PG[A-Z]+$/,
  /^POSTGRES_/,
  /^TS_/,
  /^TAILSCALE_/,
  /^AGENT_RUNTIME_/,
  /^RUNTIME_/,
  /^ANTHROPIC_/,
  /^OPENAI_/,
  /^CLAUDE_/,
  /^CODEX_/,
  /^LANGSMITH_/,
  /^LANGCHAIN_/,
];

export function refusedOverrides(env: Record<string, string | undefined>): string[] {
  return Object.entries(env)
    .filter(([name, value]) => value !== undefined && value !== '' && refusedEnvPatterns.some((p) => p.test(name)))
    .map(([name]) => name)
    .sort();
}

export function fixtureEnv(
  env: Record<string, string | undefined>,
  extra: Record<string, string>,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const name of forwardedEnvNames) {
    const value = env[name];
    if (value !== undefined) result[name] = value;
  }
  return { ...result, ...extra };
}

export function assertSafeLaunch(name: string, argv: string[], env: Record<string, string | undefined>): void {
  const problems: string[] = [];
  if (argv.length > 0) problems.push(`unexpected arguments: ${argv.join(' ')}`);
  const refused = refusedOverrides(env);
  if (refused.length > 0) problems.push(`refused environment overrides: ${refused.join(', ')}`);
  if (problems.length > 0) {
    throw new Error(`${name} refuses to start: ${problems.join('; ')}. Fixtures provision their own isolated storage.`);
  }
}

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export async function runCommand(
  cmd: string[],
  options: { env: Record<string, string>; cwd: string; allowFailure?: boolean },
): Promise<CommandResult> {
  const proc = Bun.spawn(cmd, { cwd: options.cwd, env: options.env, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0 && !options.allowFailure) {
    throw new Error(`command failed (${code}): ${cmd.join(' ')}\n${stderr.trim() || stdout.trim()}`);
  }
  return { code, stdout, stderr };
}
