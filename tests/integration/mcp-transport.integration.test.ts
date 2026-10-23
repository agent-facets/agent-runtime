// The MCP/Bun gate (design Decision 11, gate 3): the pinned SDK starts a self-contained synthetic server bundle with
// the pinned Bun, discovers and calls it, and closes it, through the runtime's own transport, discovery and call
// boundaries. The server records every start and request in its private home, so counts are observed independently.
// No provider, effectful remote service or owner state is involved; credentials are synthetic.
import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exactSecretMatcher } from '../../packages/runtime/src/credentials/matcher.ts';
import { callTool } from '../../packages/runtime/src/mcp/call.ts';
import { deadline } from '../../packages/runtime/src/mcp/deadline.ts';
import { inspectServer } from '../../packages/runtime/src/mcp/discovery.ts';
import { compileArgumentValidator } from '../../packages/runtime/src/mcp/schema.ts';
import { closeSession, type McpSession, openSession } from '../../packages/runtime/src/mcp/session.ts';
import { type LaunchSpec, planLaunch, type StdioServerParameters } from '../../packages/runtime/src/mcp/transport.ts';
import { createContentPolicy, REDACTION } from '../../packages/runtime/src/security/content-policy.ts';
import { requireMcpFixture } from '../support/mcp-fixture.ts';

const fixture = requireMcpFixture();
const scratch = mkdtempSync(join(tmpdir(), 'agent-runtime-mcp-gate-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
let counter = 0;

const SECRET = 'synthetic-mcp-gate-secret-000001';
const policy = createContentPolicy(exactSecretMatcher([SECRET]));
const OP = 'f'.repeat(64);

function stateDir(): string {
  const dir = join(scratch, `state-${++counter}`);
  mkdirSync(dir, { mode: 0o700 });
  return dir;
}
const spec = (overrides: Partial<LaunchSpec> = {}): LaunchSpec => ({
  serverId: 'synthetic',
  program: fixture.program('synthetic'),
  args: [],
  declarationEnv: { REPO_MODE: 'read' },
  literalEnv: {},
  credentialEnv: { REPO_TOKEN: SECRET },
  ...overrides,
});
async function plan(state: string, overrides: Partial<LaunchSpec> = {}): Promise<StdioServerParameters> {
  const planned = await planLaunch(spec(overrides), { stateDir: state, bunPath: process.execPath, policy });
  if (!planned.ok) throw new Error(`launch refused: ${planned.reason}`);
  return planned.params;
}
const witness = (state: string) => {
  const path = join(state, 'mcp', 'synthetic', 'home', 'witness.log');
  return existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n') : [];
};
const spawns = (state: string) => witness(state).filter((line) => line.startsWith('spawn '));
const calls = (state: string) => witness(state).filter((line) => line.startsWith('call '));
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const pids = (state: string) => spawns(state).map((line) => Number(line.split(' ')[1]));

async function connected(state: string, overrides: Partial<LaunchSpec> = {}): Promise<McpSession> {
  const limit = deadline(15_000);
  const opened = await openSession(await plan(state, overrides), limit);
  limit.dispose();
  if (!opened.ok) throw new Error(`session refused: ${opened.reason}`);
  return opened.session;
}
const anyArgs = compileArgumentValidator({ type: 'object' });
async function call(session: McpSession, toolName: string, args: Record<string, unknown> = {}, timeoutMs = 10_000) {
  return callTool({
    session,
    toolName,
    args,
    validate: anyArgs,
    timeoutMs,
    signal: new AbortController().signal,
    policy,
    operationId: OP,
  });
}

describe('MCP/Bun gate: lifecycle and counts', () => {
  test('discovery starts one process, lists once, calls nothing and leaves no process behind', async () => {
    const state = stateDir();
    const result = await inspectServer({ params: await plan(state), policy });
    if (!('tools' in result)) throw new Error(`discovery refused: ${result.reason}`);
    expect(result.tools.find((tool) => tool.name === 'list_items')).toMatchObject({ status: 'supported' });
    expect(spawns(state)).toHaveLength(1);
    expect(witness(state).filter((line) => line === 'list')).toHaveLength(1);
    expect(calls(state)).toEqual([]);
    expect(pids(state).some(alive)).toBe(false);
  });

  test('initialize, list and call share one process; a call is exactly one request; close ends it', async () => {
    const state = stateDir();
    const session = await connected(state);
    const result = await call(session, 'list_items', { repository: 'owner/repo-a' });
    expect(result).toEqual({
      outcome: { kind: 'ok', text: '2 items in owner/repo-a', json: { count: 2 } },
      dispatched: true,
      closed: false,
    });
    expect(await call(session, 'list_items', { repository: 'owner/repo-a' })).toMatchObject({
      outcome: { kind: 'ok' },
    });
    expect(calls(state)).toEqual(['call list_items', 'call list_items']);
    expect(spawns(state)).toHaveLength(1);
    expect(await closeSession(session)).toBe(true);
    expect(pids(state).some(alive)).toBe(false);
  });

  test('a changed tool definition is discovered with a different digest', async () => {
    const base = await inspectServer({ params: await plan(stateDir()), policy });
    const changed = await inspectServer({ params: await plan(stateDir(), { args: ['--variant=changed'] }), policy });
    if (!('tools' in base) || !('tools' in changed)) throw new Error('discovery refused');
    const digest = (tools: typeof base.tools, name: string) =>
      (tools.find((tool) => tool.name === name) as { definitionDigest: string }).definitionDigest;
    expect(digest(changed.tools, 'list_items')).not.toBe(digest(base.tools, 'list_items'));
    expect(digest(changed.tools, 'fail')).toBe(digest(base.tools, 'fail'));
  });

  test('a missing or altered program bundle is refused without starting anything', async () => {
    const state = stateDir();
    const program = fixture.program('synthetic');
    const copy = join(scratch, `copy-${++counter}.js`);
    writeFileSync(copy, readFileSync(program.bundlePath));
    for (const [bundlePath, reason] of [
      [join(scratch, 'absent.js'), 'program_missing'],
      [copy, 'ok'],
    ] as const) {
      const planned = await planLaunch(spec({ program: { bundlePath, sha256: program.sha256 } }), {
        stateDir: state,
        bunPath: process.execPath,
        policy,
      });
      expect(planned.ok ? 'ok' : planned.reason).toBe(reason);
    }
    writeFileSync(copy, `${readFileSync(copy, 'utf8')}\n// altered\n`);
    const altered = await planLaunch(spec({ program: { bundlePath: copy, sha256: program.sha256 } }), {
      stateDir: state,
      bunPath: process.execPath,
      policy,
    });
    expect(altered).toEqual({ ok: false, reason: 'program_digest_mismatch' });
    expect(spawns(state)).toEqual([]);
  });
});

describe('MCP/Bun gate: failures stay bounded and safe', () => {
  test('a deadline makes the call uncertain and the process is gone before the outcome returns', async () => {
    const state = stateDir();
    const session = await connected(state);
    const started = Date.now();
    const result = await call(session, 'slow', { ms: 30_000 }, 300);
    expect(result).toMatchObject({
      dispatched: true,
      closed: true,
      outcome: { kind: 'uncertain', reason: 'mcp_call_timeout' },
    });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(pids(state).some(alive)).toBe(false);
    expect(calls(state)).toEqual(['call slow']);
  });

  test('cancellation after dispatch is uncertain and closes the process', async () => {
    const state = stateDir();
    const session = await connected(state);
    const controller = new AbortController();
    const pending = callTool({
      session,
      toolName: 'slow',
      args: { ms: 30_000 },
      validate: anyArgs,
      timeoutMs: 30_000,
      signal: controller.signal,
      policy,
      operationId: OP,
    });
    setTimeout(() => controller.abort(), 200);
    expect(await pending).toMatchObject({ closed: true, outcome: { kind: 'uncertain', reason: 'mcp_call_cancelled' } });
    expect(pids(state).some(alive)).toBe(false);
  });

  test('a server that exits mid-call leaves the outcome uncertain, with no retry or restart', async () => {
    const state = stateDir();
    const session = await connected(state);
    expect(await call(session, 'crash')).toMatchObject({
      outcome: { kind: 'uncertain', reason: 'mcp_outcome_unknown' },
    });
    expect(spawns(state)).toHaveLength(1);
    expect(calls(state)).toEqual(['call crash']);
  });

  test('a reply over 1 MiB is discarded as uncertain; a large reply within it is clipped safely', async () => {
    const state = stateDir();
    const session = await connected(state);
    const clipped = await call(session, 'big', { bytes: 200_000 });
    if (clipped.outcome.kind !== 'ok') throw new Error('expected a clipped result');
    expect(clipped.outcome.text?.endsWith('[result clipped]')).toBe(true);
    expect(await call(session, 'big', { bytes: 1_100_000 })).toMatchObject({
      closed: true,
      outcome: { kind: 'uncertain', reason: 'mcp_response_too_large' },
    });
    expect(pids(state).some(alive)).toBe(false);
  });

  test('error replies, binary and resource content become fixed outcomes without follow-up requests', async () => {
    const state = stateDir();
    const session = await connected(state);
    expect(await call(session, 'fail')).toMatchObject({ outcome: { kind: 'failed', reason: 'mcp_tool_error' } });
    expect(await call(session, 'binary')).toMatchObject({
      outcome: { kind: 'failed', reason: 'mcp_result_unsupported' },
    });
    expect(await call(session, 'resource')).toMatchObject({
      outcome: { kind: 'failed', reason: 'mcp_result_unsupported' },
    });
    await closeSession(session);
    expect(witness(state).filter((line) => line === 'resources/read')).toEqual([]);
    expect(calls(state)).toEqual(['call fail', 'call binary', 'call resource']);
  });

  test('server-initiated sampling is refused by the protocol', async () => {
    const session = await connected(stateDir());
    expect(await call(session, 'ask')).toEqual({
      outcome: { kind: 'ok', text: 'sampling refused -32601' },
      dispatched: true,
      closed: false,
    });
    await closeSession(session);
  });
});

describe('MCP/Bun gate: environment, credentials and private directories', () => {
  test('the server sees only its fixed identity, private locations, literals and own credential', async () => {
    const state = stateDir();
    const saved = { ...process.env };
    Object.assign(process.env, {
      ANTHROPIC_API_KEY: 'sk-ant-api03-synthetic-ambient-provider-key',
      DATABASE_URL: 'postgres://owner@db/prod',
      HTTPS_PROXY: 'http://proxy.invalid',
    });
    let session: McpSession;
    try {
      session = await connected(state);
    } finally {
      for (const key of ['ANTHROPIC_API_KEY', 'DATABASE_URL', 'HTTPS_PROXY']) delete process.env[key];
      Object.assign(process.env, saved);
    }
    const result = await call(session, 'env');
    await closeSession(session);
    if (result.outcome.kind !== 'ok') throw new Error('expected the environment');
    const root = join(state, 'mcp', 'synthetic');
    expect(result.outcome.json).toEqual({
      names: ['HOME', 'LOGNAME', 'PATH', 'REPO_MODE', 'REPO_TOKEN', 'SHELL', 'TERM', 'TMPDIR', 'USER'],
      home: join(root, 'home'),
      tmpdir: join(root, 'tmp'),
      cwd: root,
      path: '/usr/local/bin:/usr/bin:/bin',
      user: 'agent-runtime-mcp',
    });
  });

  test('a credential echoed back is redacted from text and withheld from structured content', async () => {
    const session = await connected(stateDir());
    const result = await call(session, 'echo_secret');
    await closeSession(session);
    expect(result.outcome).toEqual({ kind: 'ok', text: `token=${REDACTION}` });
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  test('standard error noise, including a credential, never reaches this process', () => {
    // A separate process, so its own standard error can be captured whole.
    const script = `
      import { exactSecretMatcher } from '${join(import.meta.dir, '../../packages/runtime/src/credentials/matcher.ts')}';
      import { createContentPolicy } from '${join(import.meta.dir, '../../packages/runtime/src/security/content-policy.ts')}';
      import { callTool } from '${join(import.meta.dir, '../../packages/runtime/src/mcp/call.ts')}';
      import { deadline } from '${join(import.meta.dir, '../../packages/runtime/src/mcp/deadline.ts')}';
      import { compileArgumentValidator } from '${join(import.meta.dir, '../../packages/runtime/src/mcp/schema.ts')}';
      import { closeSession, openSession } from '${join(import.meta.dir, '../../packages/runtime/src/mcp/session.ts')}';
      import { planLaunch } from '${join(import.meta.dir, '../../packages/runtime/src/mcp/transport.ts')}';
      const policy = createContentPolicy(exactSecretMatcher([${JSON.stringify(SECRET)}]));
      const planned = await planLaunch(${JSON.stringify(spec())}, { stateDir: ${JSON.stringify(stateDir())}, bunPath: process.execPath, policy });
      const limit = deadline(15000);
      const opened = await openSession(planned.params, limit);
      limit.dispose();
      const result = await callTool({ session: opened.session, toolName: 'noisy', args: {}, validate: compileArgumentValidator({ type: 'object' }), timeoutMs: 10000, signal: new AbortController().signal, policy, operationId: ${JSON.stringify(OP)} });
      await closeSession(opened.session);
      process.stdout.write(JSON.stringify(result.outcome));
    `;
    const child = Bun.spawnSync([process.execPath, '--no-env-file', '-e', script], {
      env: { PATH: process.env.PATH ?? '' },
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 30_000,
    });
    expect(`${child.stderr}`).toBe('');
    expect(JSON.parse(`${child.stdout}`)).toEqual({ kind: 'ok', text: 'quiet' });
  }, 30_000);

  test('private directories persist across sessions and restarts', async () => {
    const state = stateDir();
    const first = await connected(state);
    expect(await call(first, 'remember', { value: 'kept across restarts' })).toMatchObject({ outcome: { kind: 'ok' } });
    await closeSession(first);
    const second = await connected(state);
    expect(await call(second, 'recall')).toMatchObject({ outcome: { kind: 'ok', text: 'kept across restarts' } });
    await closeSession(second);
    expect(spawns(state)).toHaveLength(2);
  });
});
