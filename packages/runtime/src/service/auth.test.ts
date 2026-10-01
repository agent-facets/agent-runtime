import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { authAttemptSchema } from '@agent-runtime/contracts';
import { CredentialCoordinator } from '../credentials/coordinator.ts';
import { acquireProviderLock } from '../credentials/lock.ts';
import type { CredentialRecord } from '../credentials/record.ts';
import { CredentialStore } from '../credentials/store.ts';
import { anthropicIssuer, createAnthropicAuthTransport } from '../providers/anthropic/credentials.ts';
import { AnthropicLogin, ATTEMPT_LIFETIME_MS, type LoginOutcome, MAX_RETAINED_ATTEMPTS } from './auth.ts';

const scratch = mkdtempSync(join(tmpdir(), 'agent-runtime-console-login-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
let counter = 0;

const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
const tok = (name: string) => `sk-ant-synthetic-${name}-token`;

type Step = { status: number; body?: unknown } | { stall: true };

/** The network below the auth transport: an independent witness of every request that left. */
function tokenEndpoint(script: Step[] = []) {
  const sent: { url: string; body: Record<string, string> }[] = [];
  const fetchImpl = (async (input: string, init: RequestInit) => {
    sent.push({ url: String(input), body: JSON.parse(new TextDecoder().decode(init.body as ArrayBuffer)) });
    const step = script.shift();
    if (step === undefined) throw new Error('unscripted request');
    if ('stall' in step) {
      const signal = init.signal as AbortSignal;
      return new Promise<Response>((_, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
      );
    }
    return new Response(step.body === undefined ? null : JSON.stringify(step.body), { status: step.status });
  }) as unknown as typeof fetch;
  return { fetchImpl, sent };
}

const granted = {
  status: 200,
  body: { access_token: tok('access-new'), refresh_token: tok('refresh-new'), expires_in: 3600 },
};

function usable(generation: number): CredentialRecord {
  return {
    version: 1,
    provider: 'anthropic',
    authMode: 'subscription',
    slot: 'default',
    generation,
    updatedAtMs: Date.now(),
    lifecycle: 'usable',
    accessToken: tok(`access-${generation}`),
    refreshToken: tok(`refresh-${generation}`),
    expiresAtMs: Date.now() + 3_600_000,
    account: {},
  };
}

function setup(options: { script?: Step[]; now?: () => number; replyWaitMs?: number; slot?: string | null } = {}) {
  const state = join(scratch, `state-${++counter}`);
  mkdirSync(state, { mode: 0o700 });
  const store = new CredentialStore(join(state, 'credentials'));
  const network = tokenEndpoint(options.script);
  const transport = createAnthropicAuthTransport(network.fetchImpl);
  const coordinator = new CredentialCoordinator({
    store,
    provider: 'anthropic',
    slot: 'default',
    issuer: anthropicIssuer({ transport }),
    lockWaitMs: 200,
  });
  const logs: string[] = [];
  const login = new AnthropicLogin({
    slot: options.slot === null ? undefined : (options.slot ?? 'default'),
    coordinator: () => coordinator,
    transport,
    log: (line) => logs.push(line),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.replyWaitMs === undefined ? {} : { replyWaitMs: options.replyWaitMs }),
  });
  return { store, login, sent: network.sent, logs };
}

function attempt(outcome: LoginOutcome) {
  if (outcome.kind !== 'attempt') throw new Error(`expected an attempt, got ${outcome.kind}`);
  expect(authAttemptSchema.safeParse(outcome.attempt).success).toBe(true);
  return outcome.attempt;
}

/** The pasted text the provider's page shows: `code#state`. */
const pasted = (url: string | undefined, code = 'synthetic-auth-code') =>
  `${code}#${new URL(url as string).searchParams.get('state')}`;

const generation = async (store: CredentialStore) => {
  const read = await store.read('anthropic', 'default');
  return read.kind === 'record' ? read.record.generation : undefined;
};

describe('console login', () => {
  test('begin only prepares the provider page; a repeated begin returns the same attempt', async () => {
    const { login, sent } = setup();
    const first = attempt(await login.start());
    expect(first.state).toBe('awaiting_code');
    const url = new URL(first.authorizationUrl as string);
    expect(url.origin).toBe('https://claude.ai');
    expect(url.searchParams.get('redirect_uri')).toBe('https://platform.claude.com/oauth/code/callback');
    // A reload or a lost reply does not strand the attempt or start a second one.
    expect(attempt(await login.start()).attemptId).toBe(first.attemptId);
    expect(attempt(login.status(first.attemptId)).state).toBe('awaiting_code');
    // The verifier never leaves the server: only the URL's challenge does.
    expect(JSON.stringify(first)).not.toContain('verifier');
    expect(sent).toEqual([]);
  });

  test('the pasted code is exchanged once and stored as the next generation', async () => {
    const { store, login, sent, logs } = setup({ script: [granted] });
    await store.replace(usable(4));
    const begun = attempt(await login.start());

    // Text from another sign-in is refused before anything is sent; the attempt keeps waiting.
    const mismatch = await login.complete(begun.attemptId, `synthetic-auth-code#${'f'.repeat(32)}`);
    expect(mismatch.kind).toBe('code_mismatch');
    expect(sent).toEqual([]);

    const code = pasted(begun.authorizationUrl);
    const [a, b] = await Promise.all([login.complete(begun.attemptId, code), login.complete(begun.attemptId, code)]);
    const states = [attempt(a).state, attempt(b).state];
    expect(states).toContain('connected');
    const finished = attempt(login.status(begun.attemptId));
    expect(finished.state).toBe('connected');
    expect(finished.authorizationUrl).toBeUndefined();
    expect(await generation(store)).toBe(5);

    // A repeated completion reports the outcome; it does not exchange again.
    expect(attempt(await login.complete(begun.attemptId, code)).state).toBe('connected');
    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toBe(TOKEN_URL);
    expect(sent[0]?.body).toMatchObject({ grant_type: 'authorization_code', code: 'synthetic-auth-code' });

    // A later login is a new attempt.
    expect(attempt(await login.start()).attemptId).not.toBe(begun.attemptId);
    for (const line of logs) {
      expect(line).not.toContain('synthetic-auth-code');
      expect(line).not.toContain(tok('access-new'));
    }
    expect(logs).toContain('{"event":"provider_login_connected","provider":"anthropic"}');
  });

  test('a refused or uncertain exchange is final, keeps the stored authorization and is never retried', async () => {
    for (const [step, reason] of [
      [{ status: 400 }, 'rejected'],
      [{ status: 503 }, 'outcome_unknown'],
      [{ status: 429 }, 'throttled'],
    ] as const) {
      const { store, login, sent } = setup({ script: [step] });
      await store.replace(usable(2));
      const begun = attempt(await login.start());
      const code = pasted(begun.authorizationUrl);
      const failed = attempt(await login.complete(begun.attemptId, code));
      expect(failed.state).toBe('failed');
      expect(failed.failure?.reason).toBe(reason);
      expect(JSON.stringify(failed)).not.toContain('synthetic-auth-code');
      expect(attempt(await login.complete(begun.attemptId, code)).state).toBe('failed');
      expect(sent).toHaveLength(1);
      expect(await generation(store)).toBe(2);
    }
  });

  test('waiting for the owner holds no credential lock', async () => {
    const { store, login } = setup();
    await login.start();
    const lock = await acquireProviderLock(store, 'anthropic', { waitMs: 200 });
    await lock.release();
  });

  test('a login cannot take the lock from a renewal in progress: it fails as busy, before any exchange', async () => {
    const { store, login, sent } = setup({ script: [granted] });
    const begun = attempt(await login.start());
    const lock = await acquireProviderLock(store, 'anthropic', { waitMs: 200 });
    try {
      const failed = attempt(await login.complete(begun.attemptId, pasted(begun.authorizationUrl)));
      expect(failed.failure?.reason).toBe('busy');
    } finally {
      await lock.release();
    }
    expect(sent).toEqual([]);
  });

  test('cancelling before the code arrives closes the attempt and leaves saved authorization alone', async () => {
    const { store, login, sent } = setup({ script: [granted] });
    await store.replace(usable(7));
    const begun = attempt(await login.start());
    expect(attempt(login.cancel(begun.attemptId)).state).toBe('cancelled');
    expect(attempt(await login.complete(begun.attemptId, pasted(begun.authorizationUrl))).state).toBe('cancelled');
    expect(sent).toEqual([]);
    expect(await generation(store)).toBe(7);
  });

  test('an unanswered attempt expires; finished attempts are forgotten and the retained set stays bounded', async () => {
    let now = 1_790_000_000_000;
    const { login, sent } = setup({ now: () => now });
    const begun = attempt(await login.start());
    now += ATTEMPT_LIFETIME_MS;
    expect(attempt(login.status(begun.attemptId)).state).toBe('expired');
    expect(attempt(await login.complete(begun.attemptId, pasted(begun.authorizationUrl))).state).toBe('expired');
    now += ATTEMPT_LIFETIME_MS;
    expect(login.status(begun.attemptId).kind).toBe('not_found');

    const ids: string[] = [];
    for (let index = 0; index < MAX_RETAINED_ATTEMPTS + 5; index++) {
      const next = attempt(await login.start());
      ids.push(next.attemptId);
      login.cancel(next.attemptId);
    }
    expect(ids.filter((id) => login.status(id).kind === 'attempt')).toHaveLength(MAX_RETAINED_ATTEMPTS);
    expect(login.status(ids.at(-1) as string).kind).toBe('attempt');
    expect(sent).toEqual([]);
  });

  test('an exchange outlives its request; stopping the runtime aborts it and releases the lock', async () => {
    const { store, login, sent } = setup({ script: [{ stall: true }], replyWaitMs: 50 });
    const begun = attempt(await login.start());
    const reply = attempt(await login.complete(begun.attemptId, pasted(begun.authorizationUrl)));
    expect(reply.state).toBe('completing');
    expect(attempt(login.cancel(begun.attemptId)).state).toBe('completing');
    await login.stop();
    const stopped = attempt(login.status(begun.attemptId));
    expect(stopped.state).toBe('failed');
    // The request had left, so whether the code was used is unknown: a new login is required, never a replay.
    expect(stopped.failure?.reason).toBe('outcome_unknown');
    expect(sent).toHaveLength(1);
    const lock = await acquireProviderLock(store, 'anthropic', { waitMs: 200 });
    await lock.release();
  });

  test('without Anthropic configured there is nothing to connect', async () => {
    const { login } = setup({ slot: null });
    expect((await login.start()).kind).toBe('unconfigured');
    expect(login.status(crypto.randomUUID()).kind).toBe('not_found');
  });
});
