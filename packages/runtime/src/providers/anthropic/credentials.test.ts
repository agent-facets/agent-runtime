import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beginLogin, NotSentError } from '@agent-runtime/anthropic-subscription';
import { CredentialCoordinator, REFRESH_MARGIN_MS } from '../../credentials/coordinator.ts';
import type { CredentialRecord } from '../../credentials/record.ts';
import { CredentialStore } from '../../credentials/store.ts';
import { anthropicIssuer, createAnthropicAuthTransport, LoginFailed, loginAnthropic } from './credentials.ts';

const scratch = mkdtempSync(join(tmpdir(), 'agent-runtime-anthropic-auth-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
let counter = 0;

const NOW = 1_790_000_000_000;
const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
const tok = (name: string) => `sk-ant-synthetic-${name}-token`;

type Script = { status: number; body?: unknown } | { throws: { code?: string; message: string } } | { stall: true };

/** A fake network below the auth transport: an independent witness of what actually left. */
function fakeNetwork(script: Script[]) {
  const sent: { url: string; method: string; redirect: string | undefined; body: Record<string, string> }[] = [];
  const fetchImpl = (async (input: string, init: RequestInit) => {
    sent.push({
      url: String(input),
      method: String(init.method),
      redirect: init.redirect,
      body: JSON.parse(new TextDecoder().decode(init.body as ArrayBuffer)),
    });
    const step = script.shift();
    if (step === undefined) throw new Error('unscripted request');
    if ('throws' in step) throw Object.assign(new Error(step.throws.message), { code: step.throws.code });
    if ('stall' in step) {
      const signal = init.signal as AbortSignal;
      const body = new ReadableStream<Uint8Array>({
        pull: () =>
          new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })),
      });
      return new Response(body, { status: 200 });
    }
    return new Response(step.body === undefined ? null : JSON.stringify(step.body), { status: step.status });
  }) as unknown as typeof fetch;
  return { fetchImpl, sent };
}

const granted = (extra: Record<string, unknown> = {}) => ({
  status: 200,
  body: { access_token: tok('access-2'), refresh_token: tok('refresh-2'), expires_in: 3600, ...extra },
});

function freshStore(): CredentialStore {
  const state = join(scratch, `state-${++counter}`);
  mkdirSync(state, { mode: 0o700 });
  return new CredentialStore(join(state, 'credentials'));
}

function usable(generation: number, expiresAtMs: number): CredentialRecord {
  return {
    version: 1,
    provider: 'anthropic',
    authMode: 'subscription',
    slot: 'default',
    generation,
    updatedAtMs: NOW,
    lifecycle: 'usable',
    accessToken: tok(`access-${generation}`),
    refreshToken: tok(`refresh-${generation}`),
    expiresAtMs,
    account: {},
  };
}

function coordinatorFor(store: CredentialStore, fetchImpl: typeof fetch, issuerDeadlineMs?: number) {
  return new CredentialCoordinator({
    store,
    provider: 'anthropic',
    slot: 'default',
    issuer: anthropicIssuer({ transport: createAnthropicAuthTransport(fetchImpl), now: () => NOW }),
    now: () => NOW,
    ...(issuerDeadlineMs === undefined ? {} : { issuerDeadlineMs }),
  });
}

const fileText = (store: CredentialStore) => readFileSync(store.pathFor('anthropic', 'default'), 'utf8');

describe('Anthropic auth transport', () => {
  const request = (url: string, method = 'POST', signal?: AbortSignal) =>
    new Request(url, { method, body: '{}', ...(signal === undefined ? {} : { signal }) });

  test('reaches only the token endpoint, and reports refusals as never sent', async () => {
    const { fetchImpl, sent } = fakeNetwork([]);
    const transport = createAnthropicAuthTransport(fetchImpl);
    for (const url of [
      'http://platform.claude.com/v1/oauth/token',
      'https://platform.claude.com/v1/oauth/token?x=1',
      'https://platform.claude.com/v1/oauth/other',
      'https://api.anthropic.com/v1/oauth/token',
      'https://platform.claude.com:8443/v1/oauth/token',
      'https://user:pw@platform.claude.com/v1/oauth/token',
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
    const { fetchImpl, sent } = fakeNetwork([
      { status: 302 },
      { throws: { code: 'ConnectionRefused', message: 'Unable to connect to 10.1.2.3' } },
      { throws: { code: 'ECONNRESET', message: `reset while sending ${tok('secret')}` } },
    ]);
    const transport = createAnthropicAuthTransport(fetchImpl);
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

describe('Anthropic refresh through the credential coordinator', () => {
  test('rotates within the refresh margin, sending the stored refresh token once', async () => {
    const store = freshStore();
    await store.replace(usable(1, NOW + REFRESH_MARGIN_MS));
    const { fetchImpl, sent } = fakeNetwork([granted()]);
    const coordinator = coordinatorFor(store, fetchImpl);
    const states = await Promise.all(Array.from({ length: 8 }, () => coordinator.current()));
    expect(sent).toHaveLength(1);
    expect(sent[0]?.body).toMatchObject({ grant_type: 'refresh_token', refresh_token: tok('refresh-1') });
    for (const state of states) {
      expect(state.kind === 'ready' && state.credential).toMatchObject({
        generation: 2,
        accessToken: tok('access-2'),
        refreshToken: tok('refresh-2'),
        expiresAtMs: NOW + 3_600_000,
        account: {},
      });
    }
  });

  test('outside the margin nothing is sent', async () => {
    const store = freshStore();
    await store.replace(usable(1, NOW + REFRESH_MARGIN_MS + 1));
    const { fetchImpl, sent } = fakeNetwork([]);
    expect((await coordinatorFor(store, fetchImpl).current()).kind).toBe('ready');
    expect(sent).toEqual([]);
  });

  test('an unrotated refresh token is kept (D3)', async () => {
    const store = freshStore();
    await store.replace(usable(1, NOW));
    const { fetchImpl } = fakeNetwork([granted({ refresh_token: undefined })]);
    const state = await coordinatorFor(store, fetchImpl).current();
    expect(state.kind === 'ready' && [state.credential.generation, state.credential.refreshToken]).toEqual([
      2,
      tok('refresh-1'),
    ]);
  });

  test('a definitive rejection requires reauthorization and drops token material', async () => {
    const store = freshStore();
    await store.replace(usable(1, NOW));
    const { fetchImpl, sent } = fakeNetwork([{ status: 400, body: { error: 'invalid_grant' } }]);
    const coordinator = coordinatorFor(store, fetchImpl);
    expect(await coordinator.current()).toEqual({ kind: 'reauthorization_required' });
    expect(await coordinator.current()).toEqual({ kind: 'reauthorization_required' });
    expect(sent).toHaveLength(1);
    expect(JSON.parse(fileText(store))).toMatchObject({ reason: 'refresh_rejected', generation: 2 });
    expect(fileText(store)).not.toContain('synthetic');
  });

  const uncertain: [string, Script[], number | undefined][] = [
    ['a server error', [{ status: 502 }], undefined],
    ['a connection lost after sending', [{ throws: { code: 'ECONNRESET', message: 'reset' } }], undefined],
    ['a malformed success', [{ status: 200, body: { access_token: 'short' } }], undefined],
    ['a body that stalls past the issuer deadline', [{ stall: true }], 50],
  ];
  for (const [name, script, deadline] of uncertain) {
    test(`${name} is never replayed, by this or another coordinator`, async () => {
      const store = freshStore();
      await store.replace(usable(1, NOW));
      const { fetchImpl, sent } = fakeNetwork(script);
      expect(await coordinatorFor(store, fetchImpl, deadline).current()).toEqual({ kind: 'reauthorization_required' });
      expect(await coordinatorFor(store, fetchImpl, deadline).current()).toEqual({ kind: 'reauthorization_required' });
      expect(sent).toHaveLength(1);
      expect(JSON.parse(fileText(store))).toMatchObject({ reason: 'refresh_outcome_unknown', generation: 2 });
      expect(fileText(store)).not.toContain('synthetic');
    });
  }

  test('a rotated refresh token this runtime cannot store is not written, and the old one is not reused', async () => {
    const store = freshStore();
    await store.replace(usable(1, NOW));
    const { fetchImpl, sent } = fakeNetwork([granted({ refresh_token: 'too-short' })]);
    expect(await coordinatorFor(store, fetchImpl).current()).toEqual({ kind: 'reauthorization_required' });
    expect(JSON.parse(fileText(store))).toMatchObject({ reason: 'refresh_result_invalid' });
    expect(sent).toHaveLength(1);
  });

  test('a refresh that never left, or was throttled, keeps the credential for a later attempt', async () => {
    const store = freshStore();
    await store.replace(usable(1, NOW));
    const { fetchImpl, sent } = fakeNetwork([
      { throws: { code: 'ConnectionRefused', message: 'dns' } },
      { status: 429 },
      granted(),
    ]);
    const coordinator = coordinatorFor(store, fetchImpl);
    expect(await coordinator.current()).toEqual({ kind: 'temporarily_unavailable' });
    expect(await coordinator.current()).toEqual({ kind: 'temporarily_unavailable' });
    expect(JSON.parse(fileText(store))).toMatchObject({ generation: 1, lifecycle: 'usable' });
    const state = await coordinator.current();
    expect(state.kind === 'ready' && state.credential.generation).toBe(2);
    expect(sent.map((entry) => entry.body.refresh_token)).toEqual([
      tok('refresh-1'),
      tok('refresh-1'),
      tok('refresh-1'),
    ]);
  });

  test('a pre-cancelled caller sends nothing', async () => {
    const store = freshStore();
    await store.replace(usable(1, NOW));
    const { fetchImpl, sent } = fakeNetwork([]);
    const cancelled = new AbortController();
    cancelled.abort(new Error('cancelled'));
    await expect(coordinatorFor(store, fetchImpl).current(cancelled.signal)).rejects.toThrow('cancelled');
    expect(sent).toEqual([]);
  });
});

describe('Anthropic operator login', () => {
  test('exchanges the pasted code for the next generation', async () => {
    const store = freshStore();
    await store.replace(usable(3, NOW));
    const flow = await beginLogin();
    const { fetchImpl, sent } = fakeNetwork([granted()]);
    const state = await loginAnthropic({
      coordinator: coordinatorFor(store, fetchImpl),
      transport: createAnthropicAuthTransport(fetchImpl),
      flow,
      now: () => NOW,
      readCode: async () => `pasted-code#${flow.state}`,
    });
    expect(state.kind === 'ready' && state.credential).toMatchObject({
      generation: 4,
      accessToken: tok('access-2'),
      refreshToken: tok('refresh-2'),
      account: {},
    });
    expect(sent[0]?.body).toMatchObject({
      grant_type: 'authorization_code',
      code: 'pasted-code',
      code_verifier: flow.verifier,
    });
  });

  test('a mismatched, refused or unstorable login changes nothing', async () => {
    const cases: [Script[], (flow: { state: string }) => string, string][] = [
      [[], () => `code#${'f'.repeat(32)}`, 'state_mismatch'],
      [[{ status: 400 }], (flow) => `code#${flow.state}`, 'rejected'],
      [[granted({ access_token: 'short' })], (flow) => `code#${flow.state}`, 'unstorable'],
    ];
    for (const [script, pasted, expected] of cases) {
      const store = freshStore();
      await store.replace(usable(1, NOW + 3_600_000));
      const before = fileText(store);
      const flow = await beginLogin();
      const requests = script.length;
      const { fetchImpl, sent } = fakeNetwork(script);
      const error = await loginAnthropic({
        coordinator: coordinatorFor(store, fetchImpl),
        transport: createAnthropicAuthTransport(fetchImpl),
        flow,
        now: () => NOW,
        readCode: async () => pasted(flow),
      }).catch((failure: Error) => failure);
      if (expected === 'unstorable') expect(error).toBeInstanceOf(Error);
      else expect(error instanceof LoginFailed ? String(error.reason) : undefined).toBe(expected);
      expect(fileText(store)).toBe(before);
      expect(sent).toHaveLength(requests);
    }
  });
});
