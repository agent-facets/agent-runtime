import { afterAll, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exactSecretMatcher } from '../credentials/matcher.ts';
import { createContentPolicy } from '../security/content-policy.ts';
import {
  BUN_FLAGS,
  declarationLaunchInputs,
  FIXED_IDENTITY,
  type LaunchSpec,
  MCP_MAX_MESSAGE_BYTES,
  planLaunch,
  serverEnvironment,
} from './transport.ts';

const scratch = mkdtempSync(join(tmpdir(), 'agent-runtime-mcp-transport-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
let counter = 0;

const SECRET = 'synthetic-mcp-launch-secret-0001';
const PROVIDER = 'sk-ant-oat01-synthetic-provider-credential-0000';
const policy = createContentPolicy(exactSecretMatcher([SECRET, PROVIDER]));

function fixture() {
  const stateDir = join(scratch, `state-${++counter}`);
  mkdirSync(stateDir, { mode: 0o700 });
  const bytes = 'console.log("server");\n';
  const sha256 = new Bun.CryptoHasher('sha256').update(bytes).digest('hex');
  const programDir = join(scratch, `programs-${counter}`, 'repo');
  mkdirSync(programDir, { recursive: true });
  const bundlePath = join(programDir, `${sha256}.js`);
  writeFileSync(bundlePath, bytes);
  const spec: LaunchSpec = {
    serverId: 'repo',
    program: { bundlePath, sha256 },
    args: ['--mode', 'read; rm -rf /'],
    declarationEnv: { REPO_MODE: 'read' },
    literalEnv: { REPO_ORG: 'owner' },
    credentialEnv: { REPO_TOKEN: SECRET },
  };
  return { stateDir, spec, context: { stateDir, bunPath: '/usr/local/bin/bun', policy } };
}
const mode = (path: string) => statSync(path).mode & 0o777;

describe('MCP server launch plan', () => {
  test('runs the verified bundle with the pinned Bun, fixed flags and argument vector, from its private directory', async () => {
    const { stateDir, spec, context } = fixture();
    const plan = await planLaunch(spec, context);
    if (!plan.ok) throw new Error(plan.reason);
    const root = join(stateDir, 'mcp', 'repo');
    expect(plan.params).toEqual({
      command: '/usr/local/bin/bun',
      args: [...BUN_FLAGS, spec.program.bundlePath, '--mode', 'read; rm -rf /'],
      env: {
        ...FIXED_IDENTITY,
        HOME: join(root, 'home'),
        TMPDIR: join(root, 'tmp'),
        REPO_MODE: 'read',
        REPO_ORG: 'owner',
        REPO_TOKEN: SECRET,
      },
      cwd: root,
      stderr: 'ignore',
      maxBufferSize: MCP_MAX_MESSAGE_BYTES,
    });
    expect(BUN_FLAGS).toEqual(['--config=/dev/null', '--no-install', '--no-env-file']);
    for (const dir of ['mcp', 'mcp/repo', 'mcp/repo/home', 'mcp/repo/tmp'])
      expect(mode(join(stateDir, dir))).toBe(0o700);
  });

  test('nothing of this process environment is forwarded, including provider credentials', async () => {
    const { spec, context } = fixture();
    const saved = { ...process.env };
    Object.assign(process.env, {
      ANTHROPIC_API_KEY: PROVIDER,
      DATABASE_URL: 'postgres://owner@db/prod',
      HTTPS_PROXY: 'http://p',
    });
    try {
      const plan = await planLaunch(spec, context);
      if (!plan.ok) throw new Error(plan.reason);
      expect(Object.keys(plan.params.env ?? {}).sort()).toEqual(
        ['HOME', 'LOGNAME', 'PATH', 'REPO_MODE', 'REPO_ORG', 'REPO_TOKEN', 'SHELL', 'TERM', 'TMPDIR', 'USER'].sort(),
      );
      expect(JSON.stringify(plan.params)).not.toContain(PROVIDER);
    } finally {
      for (const key of ['ANTHROPIC_API_KEY', 'DATABASE_URL', 'HTTPS_PROXY']) delete process.env[key];
      Object.assign(process.env, saved);
    }
  });

  test('a server without a credential binding receives no credential', async () => {
    const { spec, context } = fixture();
    const plan = await planLaunch({ ...spec, credentialEnv: {} }, context);
    if (!plan.ok) throw new Error(plan.reason);
    expect(Object.hasOwn(plan.params.env ?? {}, 'REPO_TOKEN')).toBe(false);
    expect(JSON.stringify(plan.params).includes(SECRET)).toBe(false);
  });

  test('directories persist and keep their contents across launches', async () => {
    const { stateDir, spec, context } = fixture();
    await planLaunch(spec, context);
    writeFileSync(join(stateDir, 'mcp', 'repo', 'home', 'data.json'), '{}');
    expect((await planLaunch(spec, context)).ok).toBe(true);
    expect(statSync(join(stateDir, 'mcp', 'repo', 'home', 'data.json')).isFile()).toBe(true);
  });

  test('refuses unsafe state directories without repairing them', async () => {
    const loose = fixture();
    mkdirSync(join(loose.stateDir, 'mcp', 'repo'), { recursive: true, mode: 0o700 });
    chmodSync(join(loose.stateDir, 'mcp', 'repo'), 0o755);
    expect(await planLaunch(loose.spec, loose.context)).toEqual({ ok: false, reason: 'state_directory_unsafe' });
    expect(mode(join(loose.stateDir, 'mcp', 'repo'))).toBe(0o755);

    const linked = fixture();
    const elsewhere = join(scratch, `elsewhere-${++counter}`);
    mkdirSync(elsewhere, { mode: 0o700 });
    mkdirSync(join(linked.stateDir, 'mcp'), { mode: 0o700 });
    symlinkSync(elsewhere, join(linked.stateDir, 'mcp', 'repo'));
    expect(await planLaunch(linked.spec, linked.context)).toEqual({ ok: false, reason: 'state_directory_unsafe' });
  });

  test('refuses a missing, altered or non-regular program bundle', async () => {
    const missing = fixture();
    rmSync(missing.spec.program.bundlePath);
    expect(await planLaunch(missing.spec, missing.context)).toEqual({ ok: false, reason: 'program_missing' });

    const altered = fixture();
    writeFileSync(altered.spec.program.bundlePath, 'console.log("other");\n');
    expect(await planLaunch(altered.spec, altered.context)).toEqual({ ok: false, reason: 'program_digest_mismatch' });

    const linked = fixture();
    const target = `${linked.spec.program.bundlePath}.real`;
    writeFileSync(target, 'x');
    rmSync(linked.spec.program.bundlePath);
    symlinkSync(target, linked.spec.program.bundlePath);
    expect(await planLaunch(linked.spec, linked.context)).toEqual({ ok: false, reason: 'program_unsafe' });
  });

  test('refuses credential-bearing declarations and invalid server IDs before preparing anything', async () => {
    const { stateDir, spec, context } = fixture();
    expect(await planLaunch({ ...spec, args: [`--token=${SECRET}`] }, context)).toEqual({
      ok: false,
      reason: 'credential_in_declaration',
    });
    expect(await planLaunch({ ...spec, declarationEnv: { AUTH: PROVIDER } }, context)).toEqual({
      ok: false,
      reason: 'credential_in_declaration',
    });
    expect(await planLaunch({ ...spec, serverId: '../escape' }, context)).toEqual({
      ok: false,
      reason: 'server_id_invalid',
    });
    expect(() => statSync(join(stateDir, 'mcp'))).toThrow();
  });
});

describe('server environment', () => {
  const directories = { home: '/state/mcp/repo/home', tmp: '/state/mcp/repo/tmp' };
  const env = (spec: Partial<LaunchSpec>) =>
    serverEnvironment({ declarationEnv: {}, literalEnv: {}, credentialEnv: {}, ...spec }, directories);

  test('declaration and owner literals must agree; credentials may not overlap either', () => {
    expect(env({ declarationEnv: { MODE: 'read' }, literalEnv: { MODE: 'read' } })).toMatchObject({ ok: true });
    expect(env({ declarationEnv: { MODE: 'read' }, literalEnv: { MODE: 'write' } })).toEqual({
      ok: false,
      reason: 'environment_conflict',
    });
    expect(env({ declarationEnv: { TOKEN: 'x' }, credentialEnv: { TOKEN: SECRET } })).toEqual({
      ok: false,
      reason: 'environment_conflict',
    });
    expect(env({ literalEnv: { TOKEN: 'x' }, credentialEnv: { TOKEN: SECRET } })).toEqual({
      ok: false,
      reason: 'environment_conflict',
    });
  });

  test('a declaration cannot set protected or malformed variables, and nothing overrides the fixed ones', () => {
    const protectedSettings: Record<string, string>[] = [
      { PATH: '/evil' },
      { HOME: '/root' },
      { NODE_OPTIONS: '-r x' },
      { LD_PRELOAD: 'x' },
      { DEBUG: '*' },
    ];
    for (const declarationEnv of protectedSettings) {
      expect(env({ declarationEnv })).toEqual({ ok: false, reason: 'environment_protected' });
    }
    expect(env({ declarationEnv: { 'bad name': 'x' } })).toEqual({ ok: false, reason: 'environment_invalid' });
    expect(env({ declarationEnv: { lower: 'x' } })).toEqual({ ok: false, reason: 'environment_invalid' });
  });
});

describe('declarations', () => {
  test('only stdio declarations launch; HTTP is visibly unsupported and malformed inputs are refused', () => {
    expect(declarationLaunchInputs({ type: 'stdio', command: 'npx', args: ['--x'], env: { MODE: 'read' } })).toEqual({
      ok: true,
      args: ['--x'],
      env: { MODE: 'read' },
    });
    expect(declarationLaunchInputs({ type: 'stdio', command: 'x' })).toEqual({ ok: true, args: [], env: {} });
    expect(declarationLaunchInputs({ type: 'http', url: 'https://mcp.example.test/' })).toEqual({
      ok: false,
      reason: 'transport_unsupported',
    });
    for (const declaration of [
      { type: 'stdio', args: 'x' },
      { type: 'stdio', args: [1] },
      { type: 'stdio', env: { A: 1 } },
      { type: 'stdio', env: ['x'] },
    ]) {
      expect(declarationLaunchInputs(declaration)).toEqual({ ok: false, reason: 'declaration_invalid' });
    }
  });
});
