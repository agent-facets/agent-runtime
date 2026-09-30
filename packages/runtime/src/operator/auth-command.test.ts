import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type AuthCommandIo, runAuthCommand } from './auth-command.ts';

const scratch = mkdtempSync(join(tmpdir(), 'agent-runtime-auth-command-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
let counter = 0;

const NOW = 1_790_000_000_000;
const ACCESS = 'sk-ant-synthetic-login-access-token';
const REFRESH = 'sk-ant-synthetic-login-refresh-token';

function stateDir(): string {
  const dir = join(scratch, `state-${++counter}`);
  mkdirSync(dir, { mode: 0o700 });
  return dir;
}

/** An owner who opens the printed URL and pastes back a code bound to that login's state. */
function session(options: { env: Record<string, string>; replies?: Response[]; paste?: (state: string) => string }) {
  const out: string[] = [];
  const err: string[] = [];
  const sent: string[] = [];
  const replies = [...(options.replies ?? [])];
  const io: AuthCommandIo = {
    env: options.env,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    now: () => NOW,
    fetch: (async (url: string) => {
      sent.push(url);
      const reply = replies.shift();
      if (reply === undefined) throw new Error('unexpected request');
      return reply;
    }) as unknown as typeof fetch,
    readLine: async () => {
      const url = out.find((line) => line.startsWith('https://claude.ai/oauth/authorize?'));
      const state = new URL(url ?? 'https://invalid/').searchParams.get('state') ?? '';
      return (options.paste ?? ((value) => `the-code#${value}`))(state);
    },
  };
  return { io, out, err, sent };
}

const granted = () =>
  new Response(JSON.stringify({ access_token: ACCESS, refresh_token: REFRESH, expires_in: 28_800 }), { status: 200 });

describe('auth anthropic login/status', () => {
  test('login prints the URL, stores the exchanged authorization and reports only safe status', async () => {
    const env = { RUNTIME_STATE_DIR: stateDir() };
    const login = session({ env, replies: [granted()] });
    expect(await runAuthCommand(['anthropic', 'login'], login.io)).toBe(0);
    expect(login.sent).toEqual(['https://platform.claude.com/v1/oauth/token']);
    expect(login.out.at(-1)).toStartWith('anthropic/default: ready (generation 1;');
    const record = JSON.parse(
      readFileSync(join(env.RUNTIME_STATE_DIR, 'credentials', 'anthropic', 'default.json'), 'utf8'),
    );
    expect(record).toMatchObject({
      provider: 'anthropic',
      generation: 1,
      accessToken: ACCESS,
      expiresAtMs: NOW + 28_800_000,
    });
    expect([...login.out, ...login.err].join('\n')).not.toContain('synthetic');

    const status = session({ env });
    expect(await runAuthCommand(['anthropic', 'status'], status.io)).toBe(0);
    expect(status.out).toEqual([
      'anthropic/default: ready (generation 1; access expires 2026-09-21T22:13:20.000Z, in 480 min; it renews automatically)',
    ]);
    expect(status.sent).toEqual([]);
  });

  test('status never refreshes, even when the access token has expired', async () => {
    const env = { RUNTIME_STATE_DIR: stateDir() };
    await runAuthCommand(['anthropic', 'login'], session({ env, replies: [granted()] }).io);
    const later = session({ env });
    later.io.now = () => NOW + 30_000_000;
    expect(await runAuthCommand(['anthropic', 'status'], later.io)).toBe(0);
    expect(later.out[0]).toContain('access expired');
    expect(later.sent).toEqual([]);
  });

  test('an unauthorized slot and a failed login explain what to do, and store nothing', async () => {
    const env = { RUNTIME_STATE_DIR: stateDir() };
    const status = session({ env });
    expect(await runAuthCommand(['anthropic', 'status', '--slot', 'work'], status.io)).toBe(1);
    expect(status.out).toEqual(['anthropic/work: not authorized: run `auth anthropic login`']);

    const mismatch = session({ env, paste: () => `code#${'0'.repeat(32)}` });
    expect(await runAuthCommand(['anthropic', 'login'], mismatch.io)).toBe(1);
    expect(mismatch.err).toEqual([
      'The pasted code belongs to a different login attempt. Run the login again and use its URL.',
    ]);
    expect(mismatch.sent).toEqual([]);

    const refused = session({ env, replies: [new Response('{"error":"invalid_grant"}', { status: 400 })] });
    expect(await runAuthCommand(['anthropic', 'login'], refused.io)).toBe(1);
    expect(refused.err[0]).toStartWith('Anthropic refused the code.');
    expect(await Bun.file(join(env.RUNTIME_STATE_DIR, 'credentials', 'anthropic', 'default.json')).exists()).toBe(
      false,
    );
  });

  test('the configured slot is the default; --slot overrides it', async () => {
    const root = stateDir();
    const workspace = join(scratch, `workspace-${counter}`);
    mkdirSync(workspace);
    const configFile = join(scratch, `config-${counter}.json`);
    writeFileSync(
      configFile,
      JSON.stringify({
        version: 1,
        workspace: { id: 'ws', label: 'Workspace', root: workspace },
        providers: { anthropic: { authMode: 'subscription', model: 'm', profileId: 'p', credentialSlot: 'work' } },
        defaultProvider: 'anthropic',
      }),
    );
    const env = { RUNTIME_STATE_DIR: root, RUNTIME_CONFIG_FILE: configFile };
    const configured = session({ env });
    await runAuthCommand(['anthropic', 'status'], configured.io);
    expect(configured.out[0]).toStartWith('anthropic/work:');
    const overridden = session({ env });
    await runAuthCommand(['anthropic', 'status', '--slot', 'other'], overridden.io);
    expect(overridden.out[0]).toStartWith('anthropic/other:');
  });

  test('refuses unknown commands, providers and slots', async () => {
    const env = { RUNTIME_STATE_DIR: stateDir() };
    for (const argv of [
      [],
      ['openai', 'login'],
      ['anthropic'],
      ['anthropic', 'logout'],
      ['anthropic', 'status', 'x'],
    ]) {
      const attempt = session({ env });
      expect(await runAuthCommand(argv, attempt.io)).toBe(2);
      expect(attempt.err).toEqual(['usage: auth anthropic <login|status> [--slot <slot>]']);
    }
    const badSlot = session({ env });
    expect(await runAuthCommand(['anthropic', 'status', '--slot', '../escape'], badSlot.io)).toBe(2);
    expect(await runAuthCommand(['anthropic', 'status', '--unknown'], session({ env }).io)).toBe(2);
  });
});
