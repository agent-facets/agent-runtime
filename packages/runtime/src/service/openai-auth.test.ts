import { afterAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { authAttemptSchema } from '@agent-runtime/contracts';
import { CredentialCoordinator } from '../credentials/coordinator.ts';
import { acquireProviderLock } from '../credentials/lock.ts';
import { CredentialStore } from '../credentials/store.ts';
import { createOpenAIAuthTransport, openaiIssuer } from '../providers/openai/credentials.ts';
import type { LoginOutcome } from './auth.ts';
import { OpenAILogin } from './openai-auth.ts';

const scratch = mkdtempSync(join(tmpdir(), 'agent-runtime-openai-console-login-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
let counter = 0;

const NOW = 1_790_000_000_000;
const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
const jwt = (claims: Record<string, unknown>) => `${b64({ alg: 'RS256' })}.${b64(claims)}.c3ludGhldGlj`;
const VERIFIER = 'synthetic-verifier-0123456789abcdefghijklmnopqrstuvwxyz';
const ACCESS = jwt({ exp: NOW / 1000 + 864_000, sub: 'synthetic-access' });
const REFRESH = 'synthetic-openai-refresh-token';

/**
 * The issuer, by endpoint. Polls answer from `approval`: undefined keeps the owner "not yet approved" (403); a
 * Response approves (or refuses). The token endpoint answers from `token`. Every request is witnessed.
 */
function issuer(options: { usercode?: () => Response; token?: () => Response | Promise<Response> } = {}) {
  const sent: string[] = [];
  let approval: (() => Response) | undefined;
  const fetchImpl = (async (url: string, init: RequestInit) => {
    sent.push(new URL(url).pathname);
    const signal = init.signal as AbortSignal;
    const aborted = new Promise<never>((_, reject) =>
      signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
    );
    aborted.catch(() => {});
    if (url.endsWith('/deviceauth/usercode')) {
      return (
        options.usercode?.() ??
        Response.json({ device_auth_id: 'deviceauth_synthetic', user_code: 'QRST-24680', interval: '5' })
      );
    }
    if (url.endsWith('/deviceauth/token')) return approval?.() ?? new Response(null, { status: 403 });
    return (
      (await Promise.race([options.token?.(), aborted])) ??
      Response.json({
        id_token: jwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct_synthetic' } }),
        access_token: ACCESS,
        refresh_token: REFRESH,
      })
    );
  }) as unknown as typeof fetch;
  return {
    fetchImpl,
    sent,
    approve: () => {
      approval = () =>
        Response.json({
          authorization_code: 'synthetic-auth-code',
          code_verifier: VERIFIER,
          code_challenge: createHash('sha256').update(VERIFIER).digest('base64url'),
        });
    },
    refuse: () => {
      approval = () => new Response(null, { status: 400 });
    },
  };
}

/** Polls wait on this gate, so a test decides exactly when each next poll happens. */
function pollGate() {
  let release: (() => void) | undefined;
  let waiting = Promise.withResolvers<void>();
  return {
    sleep: (_ms: number, signal: AbortSignal) =>
      new Promise<void>((resolve) => {
        release = resolve;
        waiting.resolve();
        signal.addEventListener('abort', () => resolve(), { once: true });
      }),
    /** Waits until the poller is between polls. */
    idle: async () => {
      await waiting.promise;
    },
    /** Lets one more poll happen, then waits until it has. */
    next: async () => {
      waiting = Promise.withResolvers<void>();
      release?.();
      await waiting.promise;
    },
    /** Lets the next poll happen without waiting for another pause. */
    release: () => release?.(),
  };
}

function setup(network = issuer(), options: { slot?: string | null } = {}) {
  const state = join(scratch, `state-${++counter}`);
  mkdirSync(state, { mode: 0o700 });
  const store = new CredentialStore(join(state, 'credentials'));
  const transport = createOpenAIAuthTransport(network.fetchImpl);
  const coordinator = new CredentialCoordinator({
    store,
    provider: 'openai',
    slot: 'default',
    issuer: openaiIssuer({ transport, now: () => NOW }),
    now: () => NOW,
    lockWaitMs: 200,
  });
  const gate = pollGate();
  const logs: string[] = [];
  const login = new OpenAILogin({
    slot: options.slot === null ? undefined : (options.slot ?? 'default'),
    coordinator: () => coordinator,
    transport,
    now: () => NOW,
    log: (line) => logs.push(line),
    sleep: gate.sleep,
  });
  return { store, login, network, gate, logs };
}

function attempt(outcome: LoginOutcome) {
  if (outcome.kind !== 'attempt') throw new Error(`expected an attempt, got ${outcome.kind}`);
  expect(authAttemptSchema.safeParse(outcome.attempt).success).toBe(true);
  return outcome.attempt;
}

async function until(check: () => boolean) {
  for (let index = 0; index < 200 && !check(); index++) await Bun.sleep(5);
  expect(check()).toBe(true);
}

describe('OpenAI console login', () => {
  test('begin shows the code and OpenAI page; a repeated begin returns the same attempt', async () => {
    const { login, network, gate } = setup();
    const [first, again] = await Promise.all([login.start(), login.start()]);
    const begun = attempt(first);
    expect(attempt(again).attemptId).toBe(begun.attemptId);
    expect(begun).toEqual({
      attemptId: begun.attemptId,
      provider: 'openai',
      state: 'awaiting_approval',
      expiresAt: new Date(NOW + 15 * 60_000).toISOString(),
      authorizationUrl: 'https://auth.openai.com/codex/device',
      userCode: 'QRST-24680',
    });
    await gate.idle();
    expect(attempt(await login.start()).attemptId).toBe(begun.attemptId);
    expect(network.sent.filter((path) => path.endsWith('/usercode'))).toHaveLength(1);
    await login.stop();
  });

  test('approval on OpenAI’s page is noticed, exchanged once and stored, without the code being pasted back', async () => {
    const { store, login, network, gate, logs } = setup();
    const begun = attempt(await login.start());
    await gate.idle();
    await gate.next();
    expect(attempt(login.status(begun.attemptId)).state).toBe('awaiting_approval');

    network.approve();
    gate.release();
    await until(() => attempt(login.status(begun.attemptId)).state === 'connected');
    const finished = attempt(login.status(begun.attemptId));
    expect(finished.userCode).toBeUndefined();
    expect(finished.authorizationUrl).toBeUndefined();
    const read = await store.read('openai', 'default');
    expect(read.kind === 'record' && read.record).toMatchObject({
      generation: 1,
      lifecycle: 'usable',
      account: { accountId: 'acct_synthetic' },
    });
    expect(network.sent.filter((path) => path === '/oauth/token')).toHaveLength(1);
    expect(logs).toEqual(['{"event":"provider_login_connected","provider":"openai"}']);
    expect(attempt(await login.start()).attemptId).not.toBe(begun.attemptId);
    await login.stop();
  });

  test('polling holds no credential lock', async () => {
    const { store, login, gate } = setup();
    await login.start();
    await gate.idle();
    const lock = await acquireProviderLock(store, 'openai', { waitMs: 200 });
    await lock.release();
    await login.stop();
  });

  test('cancelling while waiting stops polling and stores nothing', async () => {
    const { store, login, network, gate } = setup();
    const begun = attempt(await login.start());
    await gate.idle();
    expect(attempt(login.cancel(begun.attemptId)).state).toBe('cancelled');
    const polls = network.sent.length;
    await login.stop();
    expect(network.sent).toHaveLength(polls);
    expect(attempt(login.status(begun.attemptId)).state).toBe('cancelled');
    expect((await store.read('openai', 'default')).kind).toBe('missing');
  });

  test('a refusal on OpenAI’s page, or a refused exchange, fails the attempt with a safe reason', async () => {
    const refused = setup();
    const first = attempt(await refused.login.start());
    await refused.gate.idle();
    refused.network.refuse();
    refused.gate.release();
    await until(() => attempt(refused.login.status(first.attemptId)).state === 'failed');
    expect(attempt(refused.login.status(first.attemptId)).failure?.reason).toBe('denied');

    const exchange = setup(issuer({ token: () => new Response('{"error":"invalid_grant"}', { status: 400 }) }));
    const second = attempt(await exchange.login.start());
    await exchange.gate.idle();
    exchange.network.approve();
    exchange.gate.release();
    await until(() => attempt(exchange.login.status(second.attemptId)).state === 'failed');
    const failed = attempt(exchange.login.status(second.attemptId));
    expect(failed.failure).toEqual({
      reason: 'rejected',
      message: 'OpenAI refused the authorization. Start a new login.',
    });
    expect(JSON.stringify(failed)).not.toContain('synthetic');
    expect((await exchange.store.read('openai', 'default')).kind).toBe('missing');
  });

  test('when OpenAI gives no code, the attempt fails at once and nothing is polled', async () => {
    const { login, network } = setup(issuer({ usercode: () => new Response(null, { status: 429 }) }));
    const begun = attempt(await login.start());
    expect(begun.state).toBe('failed');
    expect(begun.failure?.reason).toBe('throttled');
    expect(network.sent).toEqual(['/api/accounts/deviceauth/usercode']);
  });

  test('stopping the runtime during the exchange settles it as unknown and releases the lock', async () => {
    const stalled = Promise.withResolvers<Response>();
    const { store, login, network, gate } = setup(issuer({ token: () => stalled.promise }));
    const begun = attempt(await login.start());
    await gate.idle();
    network.approve();
    gate.release();
    await until(() => attempt(login.status(begun.attemptId)).state === 'completing');
    expect(attempt(login.cancel(begun.attemptId)).state).toBe('completing');
    await login.stop();
    expect(attempt(login.status(begun.attemptId)).failure?.reason).toBe('outcome_unknown');
    const lock = await acquireProviderLock(store, 'openai', { waitMs: 200 });
    await lock.release();
  });

  test('without OpenAI configured there is nothing to connect', async () => {
    const { login, network } = setup(issuer(), { slot: null });
    expect((await login.start()).kind).toBe('unconfigured');
    expect(login.status(crypto.randomUUID()).kind).toBe('not_found');
    expect(network.sent).toEqual([]);
  });
});
