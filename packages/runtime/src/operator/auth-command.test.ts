import { afterAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
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
      ['google', 'login'],
      ['anthropic'],
      ['anthropic', 'logout'],
      ['openai', 'refresh'],
      ['anthropic', 'status', 'x'],
    ]) {
      const attempt = session({ env });
      expect(await runAuthCommand(argv, attempt.io)).toBe(2);
      expect(attempt.err).toEqual(['usage: auth <anthropic|openai> <login|status|renew> [--slot <slot>]']);
    }
    const badSlot = session({ env });
    expect(await runAuthCommand(['anthropic', 'status', '--slot', '../escape'], badSlot.io)).toBe(2);
    expect(await runAuthCommand(['anthropic', 'status', '--unknown'], session({ env }).io)).toBe(2);
  });
});

describe('auth <provider> renew', () => {
  test('renews the stored Anthropic authorization once, now, with no other request', async () => {
    const env = { RUNTIME_STATE_DIR: stateDir() };
    await runAuthCommand(['anthropic', 'login'], session({ env, replies: [granted()] }).io);
    const renewal = session({
      env,
      replies: [
        new Response(
          JSON.stringify({
            access_token: 'sk-ant-synthetic-renewed-access',
            refresh_token: REFRESH,
            expires_in: 28_800,
          }),
          { status: 200 },
        ),
      ],
    });
    expect(await runAuthCommand(['anthropic', 'renew'], renewal.io)).toBe(0);
    expect(renewal.sent).toEqual(['https://platform.claude.com/v1/oauth/token']);
    expect(renewal.out[0]).toBe('anthropic/default: renewed (generation 1 → 2)');
    expect(renewal.out[1]).toStartWith('anthropic/default: ready (generation 2;');
    expect([...renewal.out, ...renewal.err].join('\n')).not.toContain('synthetic');
  });

  test('nothing is sent without a usable authorization; a refused renewal is reported', async () => {
    const env = { RUNTIME_STATE_DIR: stateDir() };
    const missing = session({ env });
    expect(await runAuthCommand(['openai', 'renew'], missing.io)).toBe(1);
    expect(missing.out).toEqual(['openai/default: not authorized: run `auth openai login`']);
    expect(missing.sent).toEqual([]);

    await runAuthCommand(['anthropic', 'login'], session({ env, replies: [granted()] }).io);
    const refused = session({ env, replies: [new Response('{"error":"invalid_grant"}', { status: 400 })] });
    expect(await runAuthCommand(['anthropic', 'renew'], refused.io)).toBe(1);
    expect(refused.err).toEqual(['Anthropic did not renew the authorization.']);
    expect(refused.out).toEqual(['anthropic/default: authorization is no longer usable: run `auth anthropic login`']);
  });
});

describe('auth openai login/status', () => {
  const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const jwt = (claims: Record<string, unknown>) => `${b64({ alg: 'RS256' })}.${b64(claims)}.c3ludGhldGlj`;
  const verifier = 'synthetic-verifier-0123456789abcdefghijklmnopqrstuvwxyz';

  /** The issuer's side of a device login, answering by endpoint; approval comes on the second poll. */
  function openaiSession(env: Record<string, string>, token: Response) {
    const out: string[] = [];
    const err: string[] = [];
    const sent: string[] = [];
    let polls = 0;
    const io: AuthCommandIo = {
      env,
      out: (line) => out.push(line),
      err: (line) => err.push(line),
      now: () => NOW,
      sleep: async () => {},
      readLine: async () => {
        throw new Error('a device login reads nothing from the terminal');
      },
      fetch: (async (url: string) => {
        sent.push(url);
        if (url.endsWith('/deviceauth/usercode')) {
          return Response.json({ device_auth_id: 'deviceauth_synthetic', user_code: 'WXYZ-98765', interval: '5' });
        }
        if (url.endsWith('/deviceauth/token')) {
          if (++polls < 2) return new Response(null, { status: 403 });
          return Response.json({
            authorization_code: 'synthetic-code',
            code_verifier: verifier,
            code_challenge: createHash('sha256').update(verifier).digest('base64url'),
          });
        }
        return token;
      }) as unknown as typeof fetch,
    };
    return { io, out, err, sent };
  }

  test('login shows the page and code, waits for approval, and stores the authorization with its account', async () => {
    const env = { RUNTIME_STATE_DIR: stateDir() };
    const login = openaiSession(
      env,
      Response.json({
        id_token: jwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct_synthetic' } }),
        access_token: jwt({ exp: NOW / 1000 + 864_000 }),
        refresh_token: 'synthetic-openai-refresh-token',
      }),
    );
    expect(await runAuthCommand(['openai', 'login'], login.io)).toBe(0);
    expect(login.out.slice(0, 5)).toEqual([
      'Open this page in a browser on any device and sign in with your ChatGPT account:',
      '',
      'https://auth.openai.com/codex/device',
      '',
      'Then enter this code: WXYZ-98765',
    ]);
    expect(login.out.at(-1)).toStartWith('openai/default: ready (generation 1;');
    expect(login.sent).toEqual([
      'https://auth.openai.com/api/accounts/deviceauth/usercode',
      'https://auth.openai.com/api/accounts/deviceauth/token',
      'https://auth.openai.com/api/accounts/deviceauth/token',
      'https://auth.openai.com/oauth/token',
    ]);
    const record = JSON.parse(
      readFileSync(join(env.RUNTIME_STATE_DIR, 'credentials', 'openai', 'default.json'), 'utf8'),
    );
    expect(record).toMatchObject({
      provider: 'openai',
      generation: 1,
      expiresAtMs: NOW + 864_000_000,
      account: { accountId: 'acct_synthetic' },
    });
    expect([...login.out, ...login.err].join('\n')).not.toContain('synthetic');

    const status = openaiSession(env, new Response(null, { status: 500 }));
    expect(await runAuthCommand(['openai', 'status'], status.io)).toBe(0);
    expect(status.out[0]).toStartWith('openai/default: ready (generation 1;');
    expect(status.sent).toEqual([]);
  });

  test('a refused exchange stores nothing and explains what to do', async () => {
    const env = { RUNTIME_STATE_DIR: stateDir() };
    const login = openaiSession(env, new Response('{"error":"invalid_grant"}', { status: 400 }));
    expect(await runAuthCommand(['openai', 'login'], login.io)).toBe(1);
    expect(login.err).toEqual(['OpenAI refused the authorization. Run the login again.']);
    expect(await Bun.file(join(env.RUNTIME_STATE_DIR, 'credentials', 'openai', 'default.json')).exists()).toBe(false);
  });
});
