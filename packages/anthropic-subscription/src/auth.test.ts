import { describe, expect, test } from 'bun:test';
import { type Reply, SyntheticTransport } from '../test-support/synthetic-transport.ts';
import { beginLogin, exchangeAuthorization, refreshAuthorization } from './auth.ts';
import type { AuthFailure, LoginFlow } from './contracts.ts';

const NOW = 1_790_000_000_000;
const ACCESS = 'sk-ant-oat01-synthetic-access-token';
const REFRESH = 'sk-ant-ort01-synthetic-refresh-token';
const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';

const io = (synthetic: SyntheticTransport, signal = new AbortController().signal) => ({
  transport: synthetic.transport,
  signal,
  now: () => NOW,
});

const flow: LoginFlow = {
  authorizationUrl: 'https://claude.ai/oauth/authorize',
  redirectUri: 'https://platform.claude.com/oauth/code/callback',
  state: 'a'.repeat(32),
  verifier: 'v'.repeat(86),
};

const tokens = (extra: Record<string, unknown> = {}): Reply => ({
  kind: 'json',
  body: { access_token: ACCESS, refresh_token: REFRESH, expires_in: 3600, token_type: 'Bearer', ...extra },
});

const failure = (operation: AuthFailure['operation'], reason: AuthFailure['reason'], status?: number): AuthFailure => ({
  ok: false,
  operation,
  reason,
  ...(status === undefined ? {} : { status }),
});

describe('beginLogin', () => {
  test('builds the subscription authorization URL with the upstream parameters and an S256 challenge', async () => {
    const login = await beginLogin();
    const url = new URL(login.authorizationUrl);
    expect(`${url.origin}${url.pathname}`).toBe('https://claude.ai/oauth/authorize');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      code: 'true',
      client_id: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
      response_type: 'code',
      redirect_uri: 'https://platform.claude.com/oauth/code/callback',
      scope:
        'org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload',
      code_challenge: expect.any(String),
      code_challenge_method: 'S256',
      state: login.state,
    });
    expect(login.state).toMatch(/^[0-9a-f]{32}$/);
    expect(login.verifier).toMatch(/^[A-Za-z0-9_-]{86}$/);
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(login.verifier)));
    const expected = Buffer.from(digest).toString('base64url');
    expect(url.searchParams.get('code_challenge')).toBe(expected);
    expect(login.redirectUri).toBe('https://platform.claude.com/oauth/code/callback');
  });

  test('each login has fresh state and verifier', async () => {
    const [a, b] = await Promise.all([beginLogin(), beginLogin()]);
    expect(a.state).not.toBe(b.state);
    expect(a.verifier).not.toBe(b.verifier);
  });
});

describe('exchangeAuthorization', () => {
  test('sends exactly the upstream token request and returns absolute millisecond expiry', async () => {
    const synthetic = new SyntheticTransport([tokens()]);
    const result = await exchangeAuthorization(`the-code#${flow.state}`, flow, io(synthetic));
    expect(result).toEqual({ ok: true, accessToken: ACCESS, refreshToken: REFRESH, expiresAtMs: NOW + 3_600_000 });
    expect(synthetic.count).toBe(1);
    const [sent] = synthetic.requests;
    expect(sent?.method).toBe('POST');
    expect(sent?.url).toBe(TOKEN_URL);
    expect(sent?.headers).toMatchObject({
      'content-type': 'application/json',
      accept: 'application/json, text/plain, */*',
      'user-agent': 'axios/1.13.6',
    });
    expect(JSON.parse(sent?.body ?? '')).toEqual({
      code: 'the-code',
      state: flow.state,
      grant_type: 'authorization_code',
      client_id: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
      redirect_uri: flow.redirectUri,
      code_verifier: flow.verifier,
    });
  });

  test('accepts a pasted callback URL and the query form', async () => {
    for (const pasted of [
      `https://platform.claude.com/oauth/code/callback?code=c1&state=${flow.state}`,
      ` code=c1&state=${flow.state} `,
    ]) {
      const synthetic = new SyntheticTransport([tokens()]);
      expect((await exchangeAuthorization(pasted, flow, io(synthetic))).ok).toBe(true);
      expect(JSON.parse(synthetic.requests[0]?.body ?? '').code).toBe('c1');
    }
  });

  test('a callback from another login, or unusable input, sends nothing', async () => {
    const synthetic = new SyntheticTransport();
    expect(await exchangeAuthorization(`code#${'b'.repeat(32)}`, flow, io(synthetic))).toEqual(
      failure('exchange', 'state_mismatch'),
    );
    for (const pasted of ['', 'no-separator', 'x'.repeat(16 * 1024 + 1), `code\ud800#${flow.state}`]) {
      expect(await exchangeAuthorization(pasted, flow, io(synthetic))).toEqual(failure('exchange', 'invalid_input'));
    }
    expect(await exchangeAuthorization(`${'c'.repeat(8193)}#${flow.state}`, flow, io(synthetic))).toEqual(
      failure('exchange', 'invalid_input'),
    );
    expect(await exchangeAuthorization(`code#${flow.state}`, { ...flow, verifier: '' }, io(synthetic))).toEqual(
      failure('exchange', 'invalid_input'),
    );
    expect(synthetic.count).toBe(0);
  });

  test('an exchange answer without a refresh token is not a usable authorization', async () => {
    const synthetic = new SyntheticTransport([tokens({ refresh_token: undefined })]);
    expect(await exchangeAuthorization(`c#${flow.state}`, flow, io(synthetic))).toEqual(
      failure('exchange', 'outcome_unknown', 200),
    );
  });
});

describe('token request outcomes', () => {
  const cases: [string, Reply, AuthFailure['reason'], number | undefined][] = [
    ['definitive 400', { kind: 'json', status: 400, body: { error: 'invalid_grant' } }, 'rejected', 400],
    ['definitive 401', { kind: 'text', status: 401, body: 'nope' }, 'rejected', 401],
    ['throttled 429', { kind: 'text', status: 429, body: 'slow down' }, 'throttled', 429],
    ['server error', { kind: 'text', status: 503, body: 'down' }, 'outcome_unknown', 503],
    [
      'redirect',
      { kind: 'text', status: 302, body: '', headers: { location: 'https://elsewhere.invalid/' } },
      'outcome_unknown',
      302,
    ],
    ['never sent', { kind: 'not_sent' }, 'not_sent', undefined],
    ['connection lost', { kind: 'lost' }, 'outcome_unknown', undefined],
    ['non-JSON success', { kind: 'text', body: '<html>' }, 'outcome_unknown', 200],
    ['non-object success', { kind: 'json', body: ['x'] }, 'outcome_unknown', 200],
    ['zero expiry', tokens({ expires_in: 0 }), 'outcome_unknown', 200],
    ['fractional expiry', tokens({ expires_in: 1.5 }), 'outcome_unknown', 200],
    ['unsafe expiry', tokens({ expires_in: Number.MAX_SAFE_INTEGER }), 'outcome_unknown', 200],
    ['oversized access token', tokens({ access_token: 'a'.repeat(8193) }), 'outcome_unknown', 200],
    ['empty access token', tokens({ access_token: '' }), 'outcome_unknown', 200],
    ['non-string refresh token', tokens({ refresh_token: 42 }), 'outcome_unknown', 200],
    [
      'declared oversized body',
      { kind: 'text', body: '{}', headers: { 'content-length': String(64 * 1024 + 1) } },
      'outcome_unknown',
      200,
    ],
    [
      'streamed oversized body',
      { kind: 'chunks', chunks: ['{"x":"', 'y'.repeat(64 * 1024), '"}'] },
      'outcome_unknown',
      200,
    ],
    ['invalid UTF-8', { kind: 'chunks', chunks: [new Uint8Array([0x7b, 0xff, 0x7d])] }, 'outcome_unknown', 200],
  ];

  for (const [name, reply, reason, status] of cases) {
    test(`${name} is ${reason} and is sent exactly once`, async () => {
      const synthetic = new SyntheticTransport([reply]);
      const result = await refreshAuthorization(REFRESH, io(synthetic));
      expect(result).toEqual(failure('refresh', reason, status));
      expect(synthetic.count).toBe(1);
      expect(JSON.stringify(result)).not.toContain('synthetic');
    });
  }

  test('a pre-aborted operation sends nothing', async () => {
    const controller = new AbortController();
    controller.abort(new Error('cancelled'));
    const synthetic = new SyntheticTransport();
    expect(await refreshAuthorization(REFRESH, io(synthetic, controller.signal))).toEqual(
      failure('refresh', 'aborted'),
    );
    expect(await exchangeAuthorization(`c#${flow.state}`, flow, io(synthetic, controller.signal))).toEqual(
      failure('exchange', 'aborted'),
    );
    expect(synthetic.count).toBe(0);
  });

  test('an abort after sending, whether awaiting headers or the body, leaves the outcome unknown', async () => {
    for (const reply of [{ kind: 'hang' }, { kind: 'chunks', chunks: ['{"access_'], stall: true }] as Reply[]) {
      const controller = new AbortController();
      const synthetic = new SyntheticTransport([reply]);
      const pending = refreshAuthorization(REFRESH, io(synthetic, controller.signal));
      await Bun.sleep(5);
      controller.abort(new Error('deadline'));
      expect(await pending).toEqual(failure('refresh', 'outcome_unknown', reply.kind === 'hang' ? undefined : 200));
      expect(synthetic.count).toBe(1);
    }
  });

  test('a body read that ignores the signal still ends when the caller aborts', async () => {
    const controller = new AbortController();
    const neverEnding = new ReadableStream<Uint8Array>({ pull: () => new Promise(() => {}) });
    const pending = refreshAuthorization(REFRESH, {
      transport: async () => new Response(neverEnding, { status: 200 }),
      signal: controller.signal,
      now: () => NOW,
    });
    await Bun.sleep(5);
    controller.abort(new Error('deadline'));
    expect(await pending).toEqual(failure('refresh', 'outcome_unknown', 200));
  });
});

describe('refreshAuthorization', () => {
  test('sends the refresh grant and returns a rotated refresh token', async () => {
    const synthetic = new SyntheticTransport([tokens({ refresh_token: 'sk-ant-ort01-rotated-refresh-token' })]);
    expect(await refreshAuthorization(REFRESH, io(synthetic))).toEqual({
      ok: true,
      accessToken: ACCESS,
      refreshToken: 'sk-ant-ort01-rotated-refresh-token',
      expiresAtMs: NOW + 3_600_000,
    });
    expect(JSON.parse(synthetic.requests[0]?.body ?? '')).toEqual({
      grant_type: 'refresh_token',
      refresh_token: REFRESH,
      client_id: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
    });
    expect(synthetic.requests[0]?.url).toBe(TOKEN_URL);
  });

  test('an omitted refresh token is reported as absent, not invented (D3)', async () => {
    const synthetic = new SyntheticTransport([tokens({ refresh_token: undefined })]);
    const result = await refreshAuthorization(REFRESH, io(synthetic));
    expect(result).toEqual({ ok: true, accessToken: ACCESS, expiresAtMs: NOW + 3_600_000 });
    expect(result.ok && 'refreshToken' in result).toBe(false);
  });

  test('an unusable refresh token is refused before sending', async () => {
    const synthetic = new SyntheticTransport();
    for (const token of ['', 'x'.repeat(8193), 'bad\udc00token']) {
      expect(await refreshAuthorization(token, io(synthetic))).toEqual(failure('refresh', 'invalid_input'));
    }
    expect(synthetic.count).toBe(0);
  });
});
