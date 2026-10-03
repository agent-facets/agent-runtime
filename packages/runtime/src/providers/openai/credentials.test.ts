import { afterAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CredentialCoordinator, REFRESH_MARGIN_MS } from '../../credentials/coordinator.ts';
import { acquireProviderLock } from '../../credentials/lock.ts';
import type { CredentialRecord } from '../../credentials/record.ts';
import { CredentialStore } from '../../credentials/store.ts';
import {
  accountIdOf,
  DEVICE_INTERVAL_DEFAULT_MS,
  DEVICE_INTERVAL_FLOOR_MS,
  DEVICE_INTERVAL_MAX_MS,
  DEVICE_LOGIN_DEADLINE_MS,
  type DeviceSession,
  NotSentError,
  parseInterval,
  startDeviceLogin,
  waitForDeviceApproval,
} from './auth.ts';
import {
  beginOpenAILogin,
  completeOpenAILogin,
  createOpenAIAuthTransport,
  OpenAILoginFailed,
  openaiIssuer,
} from './credentials.ts';

const scratch = mkdtempSync(join(tmpdir(), 'agent-runtime-openai-auth-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
let counter = 0;

const NOW = 1_790_000_000_000;
const ISSUER = 'https://auth.openai.com';
const USERCODE_URL = `${ISSUER}/api/accounts/deviceauth/usercode`;
const POLL_URL = `${ISSUER}/api/accounts/deviceauth/token`;
const TOKEN_URL = `${ISSUER}/oauth/token`;

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
const jwt = (claims: Record<string, unknown>) => `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64(claims)}.c3ludGhldGlj`;
const access = (name: string, expSeconds = NOW / 1000 + 3600) => jwt({ exp: expSeconds, sub: `synthetic-${name}` });
const idToken = (accountId = 'acct_synthetic_1') =>
  jwt({ 'https://api.openai.com/auth': { chatgpt_account_id: accountId }, sub: 'synthetic-user' });
const refresh = (name: string) => `synthetic-openai-refresh-${name}`;
const VERIFIER = 'synthetic-verifier-0123456789abcdefghijklmnopqrstuvwxyz';
const challenge = (verifier: string) => createHash('sha256').update(verifier).digest('base64url');

type Step =
  | { status: number; body?: unknown; headers?: Record<string, string> }
  | { throws: { code?: string; message: string } };

/** A fake network below the auth transport, scripted per endpoint: an independent witness of what actually left. */
function fakeNetwork(script: Partial<Record<'usercode' | 'poll' | 'token', Step[]>>) {
  const sent: { url: string; method: string; redirect: string | undefined; type: string; body: string }[] = [];
  const queues = {
    [USERCODE_URL]: [...(script.usercode ?? [])],
    [POLL_URL]: [...(script.poll ?? [])],
    [TOKEN_URL]: [...(script.token ?? [])],
  } as Record<string, Step[]>;
  const fetchImpl = (async (input: string, init: RequestInit) => {
    const url = String(input);
    sent.push({
      url,
      method: String(init.method),
      redirect: init.redirect,
      type: new Headers(init.headers).get('content-type') ?? '',
      body: new TextDecoder().decode(init.body as ArrayBuffer),
    });
    const step = queues[url]?.shift();
    if (step === undefined) throw new Error('unscripted request');
    if ('throws' in step) throw Object.assign(new Error(step.throws.message), { code: step.throws.code });
    return new Response(step.body === undefined ? null : JSON.stringify(step.body), {
      status: step.status,
      ...(step.headers === undefined ? {} : { headers: step.headers }),
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, sent, transport: createOpenAIAuthTransport(fetchImpl) };
}

const deviceCode = (extra: Record<string, unknown> = {}): Step => ({
  status: 200,
  body: { device_auth_id: 'deviceauth_synthetic_1', user_code: 'ABCD-12345', interval: '5', ...extra },
});
const approved = (extra: Record<string, unknown> = {}): Step => ({
  status: 200,
  body: {
    authorization_code: 'synthetic-auth-code',
    code_verifier: VERIFIER,
    code_challenge: challenge(VERIFIER),
    ...extra,
  },
});
const tokens = (extra: Record<string, unknown> = {}): Step => ({
  status: 200,
  body: { id_token: idToken(), access_token: access('2'), refresh_token: refresh('2'), ...extra },
});

function freshStore(): CredentialStore {
  const state = join(scratch, `state-${++counter}`);
  mkdirSync(state, { mode: 0o700 });
  return new CredentialStore(join(state, 'credentials'));
}

function usable(generation: number, expiresAtMs: number): CredentialRecord {
  return {
    version: 1,
    provider: 'openai',
    authMode: 'subscription',
    slot: 'default',
    generation,
    updatedAtMs: NOW,
    lifecycle: 'usable',
    accessToken: access(String(generation)),
    refreshToken: refresh(String(generation)),
    expiresAtMs,
    account: { accountId: 'acct_synthetic_1' },
  };
}

const coordinatorFor = (store: CredentialStore, fetchImpl: typeof fetch) =>
  new CredentialCoordinator({
    store,
    provider: 'openai',
    slot: 'default',
    issuer: openaiIssuer({ transport: createOpenAIAuthTransport(fetchImpl), now: () => NOW }),
    now: () => NOW,
  });

const fileText = (store: CredentialStore) => readFileSync(store.pathFor('openai', 'default'), 'utf8');
const session = (overrides: Partial<DeviceSession> = {}): DeviceSession => ({
  deviceAuthId: 'deviceauth_synthetic_1',
  userCode: 'ABCD-12345',
  verificationUrl: `${ISSUER}/codex/device`,
  intervalMs: 5_000,
  expiresAtMs: NOW + DEVICE_LOGIN_DEADLINE_MS,
  ...overrides,
});

/** A clock that only moves when the poll loop sleeps, recording each wait. */
function virtualClock() {
  let now = NOW;
  const waits: number[] = [];
  return {
    now: () => now,
    waits,
    sleep: async (ms: number) => {
      waits.push(ms);
      now += ms;
    },
  };
}

describe('OpenAI auth transport', () => {
  const request = (url: string, method = 'POST', signal?: AbortSignal) =>
    new Request(url, { method, body: '{}', ...(signal === undefined ? {} : { signal }) });

  test('reaches only the three issuer endpoints, and reports refusals as never sent', async () => {
    const { transport, sent } = fakeNetwork({});
    for (const url of [
      'http://auth.openai.com/oauth/token',
      'https://auth.openai.com/oauth/token?x=1',
      'https://auth.openai.com/oauth/revoke',
      'https://auth.openai.com/codex/device',
      'https://chatgpt.com/backend-api/codex/responses',
      'https://auth.openai.com:8443/oauth/token',
      'https://user:pw@auth.openai.com/oauth/token',
    ]) {
      await expect(transport(request(url))).rejects.toBeInstanceOf(NotSentError);
    }
    await expect(transport(new Request(TOKEN_URL))).rejects.toBeInstanceOf(NotSentError);
    const cancelled = new AbortController();
    cancelled.abort(new Error('cancelled'));
    await expect(transport(request(TOKEN_URL, 'POST', cancelled.signal))).rejects.toBeInstanceOf(NotSentError);
    expect(sent).toEqual([]);
  });

  test('never follows redirects, and hides the underlying failure text', async () => {
    const { transport, sent } = fakeNetwork({
      token: [
        { status: 302 },
        { throws: { code: 'ConnectionRefused', message: 'Unable to connect to 10.1.2.3' } },
        { throws: { code: 'ECONNRESET', message: `reset while sending ${refresh('secret')}` } },
      ],
    });
    expect((await transport(request(TOKEN_URL))).status).toBe(302);
    await expect(transport(request(TOKEN_URL))).rejects.toBeInstanceOf(NotSentError);
    const lost = await transport(request(TOKEN_URL)).catch((error: Error) => error);
    expect(lost).not.toBeInstanceOf(NotSentError);
    expect(String(lost)).not.toContain('secret');
    expect(sent.map((entry) => [entry.method, entry.url, entry.redirect])).toEqual([
      ['POST', TOKEN_URL, 'manual'],
      ['POST', TOKEN_URL, 'manual'],
      ['POST', TOKEN_URL, 'manual'],
    ]);
  });
});

describe('OpenAI device login protocol', () => {
  test('the poll interval: string or number seconds, default when absent, clamped, unparsable refused', () => {
    expect(parseInterval('5')).toBe(5_000);
    expect(parseInterval(7)).toBe(7_000);
    expect(parseInterval(undefined)).toBe(DEVICE_INTERVAL_DEFAULT_MS);
    expect(parseInterval(null)).toBe(DEVICE_INTERVAL_DEFAULT_MS);
    expect(parseInterval('0')).toBe(DEVICE_INTERVAL_FLOOR_MS);
    expect(parseInterval('86400')).toBe(DEVICE_INTERVAL_MAX_MS);
    for (const bad of ['five', '5s', '-1', '', Number.POSITIVE_INFINITY, Number.NaN, -2, {}, true])
      expect(parseInterval(bad)).toBeUndefined();
  });

  test('the account ID comes from the nested or flat ID-token claim, and must be routable', () => {
    expect(accountIdOf(idToken('acct_1'))).toBe('acct_1');
    expect(accountIdOf(jwt({ chatgpt_account_id: 'acct-flat' }))).toBe('acct-flat');
    expect(accountIdOf(jwt({ sub: 'x' }))).toBeUndefined();
    expect(accountIdOf(jwt({ chatgpt_account_id: 'has space' }))).toBeUndefined();
    expect(accountIdOf('not-a-jwt')).toBeUndefined();
  });

  test('starting sends the client ID as JSON and returns the code and page for the owner', async () => {
    const { transport, sent } = fakeNetwork({ usercode: [deviceCode()] });
    const result = await startDeviceLogin({ transport, signal: new AbortController().signal, now: () => NOW });
    expect(result).toEqual({
      ok: true,
      session: {
        deviceAuthId: 'deviceauth_synthetic_1',
        userCode: 'ABCD-12345',
        verificationUrl: 'https://auth.openai.com/codex/device',
        intervalMs: 5_000,
        expiresAtMs: NOW + DEVICE_LOGIN_DEADLINE_MS,
      },
    });
    expect(sent).toEqual([
      {
        url: USERCODE_URL,
        method: 'POST',
        redirect: 'manual',
        type: 'application/json',
        body: JSON.stringify({ client_id: 'app_EMoamEEZ73f0CkXaXp7hrann' }),
      },
    ]);
  });

  test('a malformed start, or an unparsable interval, is refused', async () => {
    for (const step of [
      deviceCode({ interval: 'soon' }),
      deviceCode({ user_code: 'bad code!' }),
      deviceCode({ device_auth_id: undefined }),
      { status: 200, body: ['not', 'an', 'object'] },
    ]) {
      const { transport } = fakeNetwork({ usercode: [step] });
      expect(await startDeviceLogin({ transport, signal: new AbortController().signal })).toMatchObject({
        ok: false,
        reason: 'invalid_response',
      });
    }
    const { transport } = fakeNetwork({ usercode: [{ status: 429 }, { status: 403 }] });
    const signal = new AbortController().signal;
    expect(await startDeviceLogin({ transport, signal })).toMatchObject({ reason: 'throttled' });
    expect(await startDeviceLogin({ transport, signal })).toMatchObject({ reason: 'rejected' });
  });

  test('403 and 404 mean "keep waiting"; approval checks the server-supplied PKCE pair', async () => {
    const clock = virtualClock();
    const { transport, sent } = fakeNetwork({
      poll: [
        { status: 403 },
        { status: 404 },
        { status: 429 },
        { status: 503 },
        { throws: { code: 'ECONNRESET', message: 'lost' } },
        approved(),
      ],
    });
    const result = await waitForDeviceApproval(session(), {
      transport,
      signal: new AbortController().signal,
      ...clock,
    });
    expect(result).toEqual({
      ok: true,
      approval: { authorizationCode: 'synthetic-auth-code', codeVerifier: VERIFIER },
    });
    expect(clock.waits).toEqual([5_000, 5_000, 5_000, 5_000, 5_000]);
    expect(sent.every((entry) => entry.url === POLL_URL && entry.type === 'application/json')).toBe(true);
    expect(JSON.parse(sent[0]?.body ?? '')).toEqual({
      device_auth_id: 'deviceauth_synthetic_1',
      user_code: 'ABCD-12345',
    });
  });

  test('a refusal, an inconsistent PKCE pair or an incomplete approval ends the login', async () => {
    const cases: [Step, string][] = [
      [{ status: 400 }, 'denied'],
      [{ status: 401 }, 'denied'],
      [approved({ code_challenge: challenge('another-verifier-0123456789') }), 'invalid_response'],
      [approved({ code_verifier: undefined }), 'invalid_response'],
    ];
    for (const [step, reason] of cases) {
      const { transport, sent } = fakeNetwork({ poll: [step] });
      const clock = virtualClock();
      expect(
        await waitForDeviceApproval(session(), { transport, signal: new AbortController().signal, ...clock }),
      ).toMatchObject({ ok: false, reason });
      expect(sent).toHaveLength(1);
    }
  });

  test('the deadline ends waiting, and no poll is sent after it', async () => {
    const clock = virtualClock();
    const { transport, sent } = fakeNetwork({ poll: Array.from({ length: 10 }, () => ({ status: 403 })) });
    const short = session({ intervalMs: 4_000, expiresAtMs: NOW + 10_000 });
    expect(await waitForDeviceApproval(short, { transport, signal: new AbortController().signal, ...clock })).toEqual({
      ok: false,
      reason: 'expired',
    });
    expect(clock.waits).toEqual([4_000, 4_000, 2_000]);
    expect(sent).toHaveLength(3);
  });

  test('cancelling stops polling and sends nothing further', async () => {
    const controller = new AbortController();
    const { transport, sent } = fakeNetwork({ poll: [{ status: 403 }, { status: 403 }] });
    const result = await waitForDeviceApproval(session(), {
      transport,
      signal: controller.signal,
      now: () => NOW,
      sleep: async () => controller.abort(new Error('cancelled')),
    });
    expect(result).toEqual({ ok: false, reason: 'aborted' });
    expect(sent).toHaveLength(1);
  });
});

describe('OpenAI login through the credential coordinator', () => {
  test('approval is exchanged once (form-encoded) for the next generation with its account', async () => {
    const store = freshStore();
    await store.replace(usable(3, NOW + 3_600_000));
    const { fetchImpl, transport, sent } = fakeNetwork({
      usercode: [deviceCode()],
      poll: [{ status: 403 }, approved()],
      token: [tokens()],
    });
    const clock = virtualClock();
    const started = await beginOpenAILogin({ transport, now: clock.now });
    const state = await completeOpenAILogin({
      coordinator: coordinatorFor(store, fetchImpl),
      transport,
      session: started,
      ...clock,
    });
    expect(state.kind === 'ready' && state.credential).toMatchObject({
      generation: 4,
      accessToken: access('2'),
      refreshToken: refresh('2'),
      expiresAtMs: NOW + 3_600_000,
      account: { accountId: 'acct_synthetic_1' },
    });
    const exchange = sent.filter((entry) => entry.url === TOKEN_URL);
    expect(exchange).toHaveLength(1);
    expect(exchange[0]?.type).toBe('application/x-www-form-urlencoded');
    expect(Object.fromEntries(new URLSearchParams(exchange[0]?.body))).toEqual({
      grant_type: 'authorization_code',
      code: 'synthetic-auth-code',
      redirect_uri: 'https://auth.openai.com/deviceauth/callback',
      client_id: 'app_EMoamEEZ73f0CkXaXp7hrann',
      code_verifier: VERIFIER,
    });
  });

  test("expiry is the access token's exp in seconds, converted to milliseconds; else expires_in", async () => {
    for (const [step, expected] of [
      [tokens({ access_token: access('2', NOW / 1000 + 864_000) }), NOW + 864_000_000],
      [tokens({ access_token: 'opaque-synthetic-access-token', expires_in: 600 }), NOW + 600_000],
    ] as const) {
      const store = freshStore();
      const { fetchImpl, transport } = fakeNetwork({ poll: [approved()], token: [step] });
      const state = await completeOpenAILogin({
        coordinator: coordinatorFor(store, fetchImpl),
        transport,
        session: session(),
        ...virtualClock(),
      });
      expect(state.kind === 'ready' && state.credential.expiresAtMs).toBe(expected);
    }
  });

  test('no lock is held while waiting for approval', async () => {
    const store = freshStore();
    await store.ensureDirectories('openai');
    const { fetchImpl, transport } = fakeNetwork({ poll: [{ status: 403 }, approved()], token: [tokens()] });
    let lockedDuringWait: boolean | undefined;
    const state = await completeOpenAILogin({
      coordinator: coordinatorFor(store, fetchImpl),
      transport,
      session: session(),
      now: () => NOW,
      sleep: async () => {
        const lock = await acquireProviderLock(store, 'openai', { waitMs: 200 }).catch(() => undefined);
        lockedDuringWait = lock === undefined;
        await lock?.release();
      },
    });
    expect(lockedDuringWait).toBe(false);
    expect(state.kind).toBe('ready');
  });

  test('a refused, unknown or unusable exchange changes nothing and is not repeated', async () => {
    const cases: [Step, string][] = [
      [{ status: 400, body: { error: 'invalid_grant' } }, 'rejected'],
      [{ status: 502 }, 'outcome_unknown'],
      [{ throws: { code: 'ECONNRESET', message: 'reset' } }, 'outcome_unknown'],
      [tokens({ id_token: jwt({ sub: 'no-account' }) }), 'outcome_unknown'],
      [tokens({ access_token: 'opaque-synthetic-access-token' }), 'outcome_unknown'],
      [tokens({ refresh_token: undefined }), 'outcome_unknown'],
    ];
    for (const [step, reason] of cases) {
      const store = freshStore();
      await store.replace(usable(1, NOW + 3_600_000));
      const before = fileText(store);
      const { fetchImpl, transport, sent } = fakeNetwork({ poll: [approved()], token: [step] });
      const error = await completeOpenAILogin({
        coordinator: coordinatorFor(store, fetchImpl),
        transport,
        session: session(),
        ...virtualClock(),
      }).catch((failure: Error) => failure);
      expect(error instanceof OpenAILoginFailed ? error.reason : error).toBe(reason as never);
      expect(fileText(store)).toBe(before);
      expect(sent.filter((entry) => entry.url === TOKEN_URL)).toHaveLength(1);
    }
  });

  test('a token this runtime cannot store is refused without replacing the current one', async () => {
    const store = freshStore();
    await store.replace(usable(1, NOW + 3_600_000));
    const before = fileText(store);
    const { fetchImpl, transport } = fakeNetwork({ poll: [approved()], token: [tokens({ refresh_token: 'short' })] });
    await expect(
      completeOpenAILogin({
        coordinator: coordinatorFor(store, fetchImpl),
        transport,
        session: session(),
        ...virtualClock(),
      }),
    ).rejects.toBeInstanceOf(Error);
    expect(fileText(store)).toBe(before);
  });
});

describe('OpenAI refresh through the credential coordinator', () => {
  test('rotates within the refresh margin, sending the stored refresh token once as JSON', async () => {
    const store = freshStore();
    await store.replace(usable(1, NOW + REFRESH_MARGIN_MS));
    const { fetchImpl, sent } = fakeNetwork({ token: [tokens({ access_token: access('2') })] });
    const coordinator = coordinatorFor(store, fetchImpl);
    const states = await Promise.all(Array.from({ length: 8 }, () => coordinator.current()));
    expect(sent).toHaveLength(1);
    expect(sent[0]?.type).toBe('application/json');
    expect(JSON.parse(sent[0]?.body ?? '')).toEqual({
      client_id: 'app_EMoamEEZ73f0CkXaXp7hrann',
      grant_type: 'refresh_token',
      refresh_token: refresh('1'),
    });
    for (const state of states) {
      expect(state.kind === 'ready' && state.credential).toMatchObject({
        generation: 2,
        accessToken: access('2'),
        refreshToken: refresh('2'),
        expiresAtMs: NOW + 3_600_000,
        account: { accountId: 'acct_synthetic_1' },
      });
    }
  });

  test('partial rotation keeps the stored refresh token and account; a new ID token updates the account', async () => {
    const store = freshStore();
    await store.replace(usable(1, NOW));
    const { fetchImpl } = fakeNetwork({
      token: [
        { status: 200, body: { access_token: access('2') } },
        { status: 200, body: { access_token: access('3'), id_token: idToken('acct_synthetic_2') } },
      ],
    });
    const coordinator = coordinatorFor(store, fetchImpl);
    const first = await coordinator.refresh();
    expect(first.kind === 'ready' && [first.credential.refreshToken, first.credential.account]).toEqual([
      refresh('1'),
      { accountId: 'acct_synthetic_1' },
    ]);
    const second = await coordinator.refresh();
    expect(second.kind === 'ready' && [second.credential.generation, second.credential.account]).toEqual([
      3,
      { accountId: 'acct_synthetic_2' },
    ]);
  });

  test('a definitive rejection requires reauthorization and drops token material', async () => {
    for (const step of [
      { status: 401 },
      { status: 400, body: { error: { code: 'refresh_token_reused' } } },
    ] satisfies Step[]) {
      const store = freshStore();
      await store.replace(usable(1, NOW));
      const { fetchImpl, sent } = fakeNetwork({ token: [step] });
      const coordinator = coordinatorFor(store, fetchImpl);
      expect(await coordinator.current()).toEqual({ kind: 'reauthorization_required' });
      expect(await coordinator.current()).toEqual({ kind: 'reauthorization_required' });
      expect(sent).toHaveLength(1);
      expect(JSON.parse(fileText(store))).toMatchObject({ reason: 'refresh_rejected', generation: 2 });
      expect(fileText(store)).not.toContain('synthetic');
    }
  });

  test('an unknown outcome is never replayed', async () => {
    for (const step of [
      { status: 502 },
      { throws: { code: 'ECONNRESET', message: 'reset' } },
      { status: 200, body: { access_token: 'opaque-synthetic-access-token' } },
    ] satisfies Step[]) {
      const store = freshStore();
      await store.replace(usable(1, NOW));
      const { fetchImpl, sent } = fakeNetwork({ token: [step] });
      expect(await coordinatorFor(store, fetchImpl).current()).toEqual({ kind: 'reauthorization_required' });
      expect(await coordinatorFor(store, fetchImpl).current()).toEqual({ kind: 'reauthorization_required' });
      expect(sent).toHaveLength(1);
      expect(JSON.parse(fileText(store))).toMatchObject({ reason: 'refresh_outcome_unknown' });
    }
  });

  test('a refresh that never left, or was throttled, keeps the credential for a later attempt', async () => {
    const store = freshStore();
    await store.replace(usable(1, NOW));
    const { fetchImpl, sent } = fakeNetwork({
      token: [{ throws: { code: 'ConnectionRefused', message: 'dns' } }, { status: 429 }, tokens()],
    });
    const coordinator = coordinatorFor(store, fetchImpl);
    expect(await coordinator.current()).toEqual({ kind: 'temporarily_unavailable' });
    expect(await coordinator.current()).toEqual({ kind: 'temporarily_unavailable' });
    expect(JSON.parse(fileText(store))).toMatchObject({ generation: 1, lifecycle: 'usable' });
    const state = await coordinator.current();
    expect(state.kind === 'ready' && state.credential.generation).toBe(2);
    expect(sent).toHaveLength(3);
  });
});
