import { afterAll, describe, expect, test } from 'bun:test';
import {
  AdmissionRefused,
  type AdmissionTicket,
  type AppliedCredential,
  createTerminal,
  type EndpointPolicy,
  TerminalError,
  type TerminalOptions,
} from './terminal.ts';

const ORIGIN = 'https://api.provider.test';
const URL_OK = `${ORIGIN}/v1/messages`;
const policy: EndpointPolicy = {
  origin: ORIGIN,
  routes: [{ method: 'POST', path: '/v1/messages', queries: ['', '?beta=true'] }],
};
const SECRET = 'synthetic-live-credential-0001';
const CREDENTIAL: AppliedCredential = { headers: { authorization: `Bearer ${SECRET}` }, generation: 7 };

type Respond = (request: Request) => Response | Promise<Response>;

/**
 * Fakes that record everything the terminal did: credential resolution, admission and ticket writes, and each
 * request that actually reached the transport. The terminal's own state is never consulted.
 */
function harness(respond: Respond = () => new Response('{"ok":true}', { headers: { 'request-id': 'req_1' } })) {
  const log: string[] = [];
  const sent: Request[] = [];
  const settled: Promise<void>[] = [];
  const controller = new AbortController();
  const failures: { dispatched?: boolean } = {};
  const ticket = (): AdmissionTicket => ({
    attemptId: '00000000-0000-4000-8000-000000000001',
    dispatched: async () => {
      log.push('dispatched');
      if (failures.dispatched) throw new Error('database unavailable');
    },
    completed: async (result) => {
      log.push(`completed:${result.outcome}${result.providerRequestId ? `:${result.providerRequestId}` : ''}`);
    },
    abandoned: async (reason) => {
      log.push(`abandoned:${reason}`);
    },
    unconfirmed: async () => {
      log.push('unconfirmed');
    },
  });
  const options: TerminalOptions = {
    policy,
    signal: controller.signal,
    credentials: async () => {
      log.push('credentials');
      return CREDENTIAL;
    },
    admission: {
      async admit(request, begin) {
        log.push(`admit:${request.credentialGeneration}`);
        if (!begin()) log.push('begin:refused');
        return ticket();
      },
    },
    transport: (async (url: string, init: RequestInit) => {
      const request = new Request(url, init);
      sent.push(request);
      log.push('transport');
      return respond(request);
    }) as unknown as typeof fetch,
    track: (promise) => settled.push(promise),
  };
  const build = (changes: Partial<TerminalOptions> = {}) => createTerminal({ ...options, ...changes });
  return { terminal: build(), build, log, sent, settled, controller, ticket, failures };
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return 'ok';
  } catch (error) {
    return error instanceof TerminalError ? error.code : `unexpected: ${String(error)}`;
  }
}

const post = (body = '{}'): RequestInit => ({
  method: 'POST',
  body,
  headers: { 'content-type': 'application/json' },
});

/** A body that sends one chunk and then stalls; records when its reader is cancelled. */
function stalledBody(witness: string[]) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('event: partial\n\n'));
    },
    cancel() {
      witness.push('source-cancelled');
    },
  });
}

describe('admission before any I/O', () => {
  test('a pre-aborted run starts nothing: no credentials, admission or transport', async () => {
    const { terminal, log, controller } = harness();
    controller.abort();
    expect(await codeOf(terminal(URL_OK, post()))).toBe('cancelled');
    expect(log).toEqual([]);
  });

  test('only the exact HTTPS origin, route, method and query are allowed', async () => {
    for (const [url, method] of [
      ['http://api.provider.test/v1/messages', 'POST'],
      ['https://api.provider.test:8443/v1/messages', 'POST'],
      ['https://other.provider.test/v1/messages', 'POST'],
      [`${ORIGIN}/v1/messages/`, 'POST'],
      [`${ORIGIN}/v1/complete`, 'POST'],
      [`${ORIGIN}/v1/messages?beta=false`, 'POST'],
      [`${ORIGIN}/v1/messages#x`, 'POST'],
      ['https://user:pass@api.provider.test/v1/messages', 'POST'],
      [URL_OK, 'GET'],
      ['not a url', 'POST'],
    ] as const) {
      const { terminal, log } = harness();
      expect(await codeOf(terminal(url, { ...post(), method }))).toBe('endpoint_refused');
      expect(log).toEqual([]);
    }
    const { terminal, sent } = harness();
    expect(await codeOf(terminal(`${URL_OK}?beta=true`, post()))).toBe('ok');
    expect(sent).toHaveLength(1);
  });

  test('a refused admission sends nothing and reports the application reason', async () => {
    const { build, log } = harness();
    const terminal = build({
      admission: {
        admit: async () => {
          throw new AdmissionRefused('step_budget_exhausted');
        },
      },
    });
    const error = await terminal(URL_OK, post()).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(TerminalError);
    expect(error).toMatchObject({ code: 'admission_refused', reason: 'step_budget_exhausted' });
    expect(log).toEqual(['credentials']);
  });

  test('an admission that fails for another reason sends nothing and is a persistence failure', async () => {
    const { build, log } = harness();
    const terminal = build({
      admission: {
        admit: async () => {
          throw new Error('connection closed');
        },
      },
    });
    expect(await codeOf(terminal(URL_OK, post()))).toBe('persistence_failure');
    expect(log).toEqual(['credentials']);
  });

  test('cancellation during a credential wait stops the call; nothing is admitted or sent', async () => {
    let release: (value: AppliedCredential) => void = () => {};
    const { build, log, controller } = harness();
    const terminal = build({ credentials: () => new Promise<AppliedCredential>((resolve) => (release = resolve)) });
    const pending = codeOf(terminal(URL_OK, post()));
    await Bun.sleep(20);
    controller.abort();
    expect(await pending).toBe('cancelled');
    release(CREDENTIAL);
    await Bun.sleep(20);
    expect(log).toEqual([]);
  });

  test('a request cancelled while it is being admitted is recorded as abandoned and never sent', async () => {
    const { build, log, controller, ticket } = harness();
    const terminal = build({
      admission: {
        async admit(request, begin) {
          log.push(`admit:${request.credentialGeneration}`);
          controller.abort();
          if (!begin()) log.push('begin:refused');
          return ticket();
        },
      },
    });
    expect(await codeOf(terminal(URL_OK, post()))).toBe('cancelled');
    expect(log).toEqual(['credentials', 'admit:7', 'begin:refused', 'abandoned:cancelled_before_dispatch']);
  });

  test('an admission that never lets the request start is still recorded, not sent', async () => {
    const { build, log, ticket } = harness();
    const terminal = build({ admission: { admit: async () => ticket() } });
    expect(await codeOf(terminal(URL_OK, post()))).toBe('cancelled');
    expect(log).toEqual(['credentials', 'abandoned:cancelled_before_dispatch']);
  });

  test('a credential failure is reported without detail, and nothing is sent', async () => {
    const { build, log } = harness();
    const terminal = build({
      credentials: async () => {
        throw new Error(`${SECRET} expired`);
      },
    });
    const error = await terminal(URL_OK, post()).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'credential_unavailable' });
    expect(JSON.stringify({ message: (error as Error).message, name: (error as Error).name })).not.toContain(SECRET);
    expect(log).toEqual([]);
  });
});

describe('what leaves, and when', () => {
  test('SDK credential headers are replaced; the request is sent once, after admission', async () => {
    const { terminal, log, sent } = harness();
    const response = await terminal(URL_OK, {
      ...post('{"model":"m"}'),
      headers: { 'x-api-key': 'sentinel', Authorization: 'Bearer sentinel', 'anthropic-version': '2023-06-01' },
    });
    expect(sent).toHaveLength(1);
    const request = sent[0] as Request;
    expect(request.headers.get('authorization')).toBe(`Bearer ${SECRET}`);
    expect(request.headers.get('x-api-key')).toBeNull();
    expect(request.headers.get('anthropic-version')).toBe('2023-06-01');
    expect(request.redirect).toBe('manual');
    expect(await request.text()).toBe('{"model":"m"}');
    // Dispatch is recorded before the response is released; completion before the body reports its end.
    expect(log).toEqual(['credentials', 'admit:7', 'transport', 'dispatched']);
    expect(await response.text()).toBe('{"ok":true}');
    expect(log).toEqual(['credentials', 'admit:7', 'transport', 'dispatched', 'completed:ok:req_1']);
  });

  test('a Request object is handled like fetch(url, init)', async () => {
    const { terminal, sent } = harness();
    await (await terminal(new Request(URL_OK, post('{"a":1}')))).text();
    expect(sent).toHaveLength(1);
    expect(await (sent[0] as Request).text()).toBe('{"a":1}');
  });

  test('a response is not released when its dispatch cannot be recorded', async () => {
    const witness: string[] = [];
    const { terminal, log, failures } = harness(() => new Response(stalledBody(witness)));
    failures.dispatched = true;
    expect(await codeOf(terminal(URL_OK, post()))).toBe('persistence_failure');
    expect(log).toEqual(['credentials', 'admit:7', 'transport', 'dispatched']);
    expect(witness).toEqual(['source-cancelled']);
  });

  test('an unsafe provider request ID is not recorded', async () => {
    const { terminal, log } = harness(() => new Response('{}', { headers: { 'x-request-id': 'bad id with spaces' } }));
    await (await terminal(URL_OK, post())).text();
    expect(log.at(-1)).toBe('completed:ok');
  });

  test('an error status is released for classification and recorded as a failed completion', async () => {
    const { terminal, log } = harness(() => new Response('{"error":{}}', { status: 429 }));
    const response = await terminal(URL_OK, post());
    expect(response.status).toBe(429);
    await response.text();
    expect(log.at(-1)).toBe('completed:failed');
  });

  test('a transport failure after starting is recorded as unconfirmed, not as unsent', async () => {
    const { terminal, log } = harness(() => {
      throw new TypeError('connection reset');
    });
    expect(await codeOf(terminal(URL_OK, post()))).toBe('provider_unreachable');
    expect(log).toEqual(['credentials', 'admit:7', 'transport', 'unconfirmed']);
  });
});

describe('redirects', () => {
  test('a redirect is refused and never followed', async () => {
    const witness: string[] = [];
    const { terminal, log, sent } = harness(
      () => new Response(stalledBody(witness), { status: 307, headers: { location: 'https://elsewhere.test/' } }),
    );
    expect(await codeOf(terminal(URL_OK, post()))).toBe('redirect_refused');
    expect(sent).toHaveLength(1);
    expect(witness).toEqual(['source-cancelled']);
    expect(log).toEqual(['credentials', 'admit:7', 'transport', 'dispatched', 'completed:failed']);
  });
});

describe('body settlement', () => {
  test('cancellation after headers stops a stalled body and settles the attempt', async () => {
    const witness: string[] = [];
    const { terminal, log, settled, controller } = harness(() => new Response(stalledBody(witness)));
    const response = await terminal(URL_OK, post());
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    expect((await reader.read()).done).toBe(false);
    const next = reader.read().catch((error: unknown) => error);
    await Bun.sleep(20);
    expect(log.at(-1)).toBe('dispatched');
    controller.abort();
    expect(await next).toMatchObject({ code: 'cancelled' });
    await Promise.all(settled);
    expect(witness).toEqual(['source-cancelled']);
    expect(log.at(-1)).toBe('completed:failed');
  });

  test('the deadline covers the whole body, not just the headers', async () => {
    const witness: string[] = [];
    const { build, log, settled } = harness(() => new Response(stalledBody(witness)));
    const terminal = build({ deadlineMs: 150 });
    const response = await terminal(URL_OK, post());
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    await reader.read();
    expect(await reader.read().catch((error: unknown) => error)).toMatchObject({ code: 'request_timeout' });
    await Promise.all(settled);
    expect(witness).toEqual(['source-cancelled']);
    expect(log.at(-1)).toBe('completed:failed');
  });

  test('a consumer that stops reading early records a failed completion and cancels the source', async () => {
    const witness: string[] = [];
    const { terminal, log, settled } = harness(() => new Response(stalledBody(witness)));
    const response = await terminal(URL_OK, post());
    await response.body?.cancel();
    await Promise.all(settled);
    expect(witness).toEqual(['source-cancelled']);
    expect(log.at(-1)).toBe('completed:failed');
  });

  test('a body cut off by the network is a failed completion, and the error is fixed text', async () => {
    const { terminal, log } = harness(
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('partial'));
              controller.error(new Error(`socket closed ${SECRET}`));
            },
          }),
        ),
    );
    const response = await terminal(URL_OK, post());
    const error = await response.text().catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'provider_unreachable' });
    expect((error as Error).message).not.toContain(SECRET);
    expect(log.at(-1)).toBe('completed:failed');
  });
});

describe('with Bun fetch against a local server', () => {
  // The terminal's transport rewrites the approved HTTPS origin to a loopback test server, so Bun's own fetch —
  // its redirect handling and body cancellation — is what is exercised. The server is the independent witness.
  const seen: string[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(request) {
      const path = new URL(request.url).pathname;
      seen.push(`${request.method} ${path}`);
      if (request.headers.get('x-test') === 'redirect') {
        return new Response(null, { status: 302, headers: { location: '/v1/elsewhere' } });
      }
      if (request.headers.get('x-test') === 'stall') {
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('first'));
            },
            cancel() {
              seen.push('server-stream-cancelled');
            },
          }),
        );
      }
      return new Response('done');
    },
  });
  afterAll(() => server.stop(true));
  const local = (async (url: string, init: RequestInit) =>
    fetch(url.replace(ORIGIN, `http://127.0.0.1:${server.port}`), init)) as unknown as typeof fetch;

  test('Bun fetch does not follow the redirect', async () => {
    seen.length = 0;
    const { build, log } = harness();
    const terminal = build({ transport: local });
    expect(await codeOf(terminal(URL_OK, { ...post(), headers: { 'x-test': 'redirect' } }))).toBe('redirect_refused');
    expect(seen).toEqual(['POST /v1/messages']);
    expect(log.at(-1)).toBe('completed:failed');
  });

  test('cancelling a stalled Bun fetch body reaches the server', async () => {
    seen.length = 0;
    const { build, controller, settled } = harness();
    const terminal = build({ transport: local });
    const response = await terminal(URL_OK, { ...post(), headers: { 'x-test': 'stall' } });
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    await reader.read();
    controller.abort();
    await reader.read().catch(() => {});
    await Promise.all(settled);
    for (let index = 0; index < 50 && !seen.includes('server-stream-cancelled'); index++) await Bun.sleep(20);
    expect(seen).toEqual(['POST /v1/messages', 'server-stream-cancelled']);
  });
});

describe('the one permitted renewal retry', () => {
  const unauthorized = () => new Response('{"error":"expired"}', { status: 401 });

  test('a recoverable rejection renews the rejected generation and sends once more, admitted as a new step', async () => {
    let calls = 0;
    const renewed: number[] = [];
    const { build, log, sent } = harness(() => (++calls === 1 ? unauthorized() : new Response('{"ok":true}')));
    const terminal = build({
      renewal: {
        recoverable: async (response) => response.status === 401,
        renew: async (generation) => {
          renewed.push(generation);
        },
      },
    });
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"stream":true}'));
        controller.close();
      },
    });
    const response = await terminal(URL_OK, { method: 'POST', body, duplex: 'half' } as RequestInit);
    expect(await response.text()).toBe('{"ok":true}');
    expect(renewed).toEqual([7]);
    expect(sent).toHaveLength(2);
    expect(await Promise.all(sent.map((request) => request.text()))).toEqual(['{"stream":true}', '{"stream":true}']);
    expect(log.filter((entry) => entry.startsWith('admit:'))).toHaveLength(2);
    expect(log.filter((entry) => entry.startsWith('completed:'))).toEqual(['completed:failed', 'completed:ok']);
  });

  test('there is never a second retry', async () => {
    const { build, sent } = harness(unauthorized);
    const terminal = build({ renewal: { recoverable: async () => true, renew: async () => {} } });
    expect((await terminal(URL_OK, post())).status).toBe(401);
    expect(sent).toHaveLength(2);
  });

  test('an unrecoverable rejection or other failure status is not retried', async () => {
    for (const respond of [unauthorized, () => new Response('{}', { status: 429 })]) {
      const renewed: number[] = [];
      const { build, sent } = harness(respond);
      const terminal = build({
        renewal: {
          recoverable: async () => false,
          renew: async (generation) => {
            renewed.push(generation);
          },
        },
      });
      await (await terminal(URL_OK, post())).text();
      expect(sent).toHaveLength(1);
      expect(renewed).toEqual([]);
    }
  });

  test('a failed renewal is an authorization problem, and nothing more is sent', async () => {
    const { build, sent } = harness(unauthorized);
    const terminal = build({
      renewal: {
        recoverable: async () => true,
        renew: async () => {
          throw new Error(`refresh rejected ${SECRET}`);
        },
      },
    });
    const error = await terminal(URL_OK, post()).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'credential_unavailable', reason: 'renewal_failed' });
    expect((error as Error).message).not.toContain(SECRET);
    expect(sent).toHaveLength(1);
  });
});
