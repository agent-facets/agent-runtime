// The guarded terminal: the only way a physical model request leaves this runtime. Provider SDKs receive it as
// their `fetch`, so every request they make — including any the SDK would have retried — passes the same checks:
//
//   1. the caller has not been cancelled and the request is within the full-lifetime deadline;
//   2. the URL and method are exactly an allowed inference route (HTTPS, origin, path, query);
//   3. credentials are resolved (a wait that cancellation can interrupt; it consumes no model step);
//   4. the application admits the request — durably reserving one step after rechecking owner, run, invocation,
//      cancellation and budget — and, while still holding its dispatch gate, lets the request start;
//   5. local dispatch is durably confirmed before the response is released to the SDK;
//   6. the response body is tracked to its end, and completion is recorded before the body reports that end.
//
// After a recoverable authorization rejection, the credential is renewed and the request is sent once more — as a
// new request through all of the above, so it is admitted and counted as another model step. There is never a
// second retry, and nothing else is retried.
//
// Redirects are never followed: a credential-bearing request must not be forwarded to another location. Errors are
// TerminalErrors with fixed messages; nothing from the request, response, credential or underlying exception is
// echoed, because the graph may record an exception's name and message.

/** The default and configurable full request/body lifetime (Decision 8). */
export const DEFAULT_REQUEST_DEADLINE_MS = 300_000;

export type TerminalErrorCode =
  | 'cancelled'
  | 'request_timeout'
  | 'endpoint_refused'
  | 'redirect_refused'
  | 'credential_unavailable'
  | 'admission_refused'
  | 'provider_unreachable'
  | 'persistence_failure'
  | 'invariant_violation';

const MESSAGES: Record<TerminalErrorCode, string> = {
  cancelled: 'The model request was cancelled.',
  request_timeout: 'The model request did not complete before its deadline.',
  endpoint_refused: 'The model request targeted a location that is not an approved endpoint.',
  redirect_refused: 'The provider redirected the model request, and the redirect was refused.',
  credential_unavailable: 'Provider credentials were not available for the model request.',
  admission_refused: 'The model request was not admitted.',
  provider_unreachable: 'The provider could not be reached.',
  persistence_failure: 'The runtime could not record the model request.',
  invariant_violation: 'The model request violated a runtime invariant.',
};

export class TerminalError extends Error {
  override readonly name = 'TerminalError';
  constructor(
    readonly code: TerminalErrorCode,
    /** A refusal's application-owned reason, when the admission gave one. */
    readonly reason?: string,
  ) {
    super(MESSAGES[code]);
  }
}

export interface Route {
  method: 'POST' | 'GET';
  /** Exact pathname. */
  path: string;
  /** Exact permitted query strings, including the leading `?`; default: no query. */
  queries?: readonly string[];
}

export interface EndpointPolicy {
  /** Exact `https://host[:port]` origin. */
  origin: string;
  routes: readonly Route[];
}

export interface AppliedCredential {
  /** Credential headers to set; they replace anything of the same name the SDK sent. */
  headers: Readonly<Record<string, string>>;
  /** The credential generation used, so a rejection can be attributed to it. */
  generation: number;
}

/** Recorded after admission. Every method is a durable application write. */
export interface AdmissionTicket {
  readonly attemptId: string;
  /** Response headers arrived: the request was sent. */
  dispatched(): Promise<void>;
  /** The response body ended, successfully or not. */
  completed(result: { outcome: 'ok' | 'failed'; providerRequestId?: string }): Promise<void>;
  /** Admitted but never started. */
  abandoned(reason: 'cancelled_before_dispatch'): Promise<void>;
  /** Started, but whether it reached the provider is unknown. */
  unconfirmed(): Promise<void>;
}

export class AdmissionRefused extends Error {
  override readonly name = 'AdmissionRefused';
  constructor(readonly reason: string) {
    super('the model request was not admitted');
  }
}

export interface RequestAdmission {
  /**
   * Durably reserves one model request, or throws AdmissionRefused. On success it must call `begin` exactly once,
   * before releasing its dispatch gate; `begin` returns false (and starts nothing) if the request was cancelled in
   * the meantime, in which case the terminal records the ticket as abandoned.
   */
  admit(request: { credentialGeneration: number; signal: AbortSignal }, begin: () => boolean): Promise<AdmissionTicket>;
}

export interface TerminalOptions {
  policy: EndpointPolicy;
  /** Resolves credentials for one request; must honor the signal. */
  credentials(signal: AbortSignal): Promise<AppliedCredential>;
  admission: RequestAdmission;
  /** Cancellation owned by the service (run cancellation), never by a browser connection. */
  signal: AbortSignal;
  deadlineMs?: number;
  /** The underlying transport; injected so tests can witness what actually leaves. */
  transport?: typeof fetch;
  /** Receives, per request, a promise that settles once all local I/O and records for it have settled. */
  track?: (settled: Promise<void>) => void;
  /** The one permitted credential renewal after a recoverable authorization rejection. */
  renewal?: CredentialRenewal;
}

export interface CredentialRenewal {
  /** Whether an unsuccessful response is a recoverable authorization rejection; it receives a copy. */
  recoverable(response: Response): Promise<boolean>;
  /** Renews the credential that was rejected (by its generation). */
  renew(rejectedGeneration: number, signal: AbortSignal): Promise<void>;
}

/** Headers the SDK may set that must never reach the provider: its sentinel key, or anything credential-like. */
const STRIPPED_HEADERS = new Set(['authorization', 'x-api-key', 'proxy-authorization', 'cookie']);
const REQUEST_ID_HEADERS = ['request-id', 'x-request-id'];
const SAFE_REQUEST_ID = /^[A-Za-z0-9._:-]{1,256}$/;

/** A credential resolver may explain its refusal with a code (`unconfigured`, `reauthorization_required`, ...). */
function safeReason(error: unknown): string | undefined {
  const reason = (error as { reason?: unknown } | null)?.reason;
  return typeof reason === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(reason) ? reason : undefined;
}

export function matchesPolicy(policy: EndpointPolicy, url: URL, method: string): boolean {
  if (url.protocol !== 'https:' || url.origin !== policy.origin) return false;
  if (url.username !== '' || url.password !== '' || url.hash !== '') return false;
  return policy.routes.some(
    (route) => route.method === method && route.path === url.pathname && (route.queries ?? ['']).includes(url.search),
  );
}

function parseUrl(input: Request | string | URL): URL | undefined {
  try {
    return new URL(input instanceof Request ? input.url : String(input));
  } catch {
    return undefined;
  }
}

/** Resolves or rejects with the promise, or rejects once the signal aborts, whichever comes first. */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

/** A fetch-compatible function that routes every request through the guarded terminal. */
export function createTerminal(options: TerminalOptions): typeof fetch {
  const transport = options.transport ?? fetch;
  const deadlineMs = options.deadlineMs ?? DEFAULT_REQUEST_DEADLINE_MS;

  const terminal = async (input: Request | string | URL, init?: RequestInit): Promise<Response> => {
    const deadline = AbortSignal.timeout(deadlineMs);
    const callerSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    const signal = AbortSignal.any([options.signal, deadline, ...(callerSignal ? [callerSignal] : [])]);
    const stopped = () => new TerminalError(deadline.aborted ? 'request_timeout' : 'cancelled');
    if (signal.aborted) throw stopped();

    const url = parseUrl(input);
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    if (url === undefined || !matchesPolicy(options.policy, url, method)) throw new TerminalError('endpoint_refused');
    // A streamed body can be sent only once, so a request that may be retried is buffered first.
    const rawBody = init?.body ?? (input instanceof Request ? input.body : undefined);
    const body =
      options.renewal !== undefined && rawBody instanceof ReadableStream
        ? await new Response(rawBody).arrayBuffer()
        : rawBody;

    const first = await send(init, input, url, method, body, signal, stopped);
    if (options.renewal === undefined || first.response.ok) return first.response;
    // An unsuccessful response is read once (which completes its attempt); the classifier and, if there is no
    // retry, the SDK each receive an equivalent copy.
    const status = first.response.status;
    const statusText = first.response.statusText;
    const headers = first.response.headers;
    const text = await first.response.text();
    const copy = () => new Response(text, { status, statusText, headers });
    let recoverable = false;
    try {
      recoverable = await options.renewal.recoverable(copy());
    } catch {
      recoverable = false;
    }
    if (!recoverable) return copy();
    try {
      await raceAbort(options.renewal.renew(first.generation, signal), signal);
    } catch {
      if (signal.aborted) throw stopped();
      throw new TerminalError('credential_unavailable', 'renewal_failed');
    }
    return (await send(init, input, url, method, body, signal, stopped)).response;
  };

  const send = async (
    init: RequestInit | undefined,
    input: Request | string | URL,
    url: URL,
    method: string,
    body: RequestInit['body'],
    signal: AbortSignal,
    stopped: () => TerminalError,
  ): Promise<{ response: Response; generation: number }> => {
    if (signal.aborted) throw stopped();

    let credential: AppliedCredential;
    try {
      credential = await raceAbort(options.credentials(signal), signal);
    } catch (error) {
      if (signal.aborted) throw stopped();
      throw new TerminalError('credential_unavailable', safeReason(error));
    }
    if (signal.aborted) throw stopped();

    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    for (const name of [...headers.keys()]) if (STRIPPED_HEADERS.has(name.toLowerCase())) headers.delete(name);
    for (const [name, value] of Object.entries(credential.headers)) headers.set(name, value);

    let started: Promise<Response> | undefined;
    const begin = () => {
      if (started !== undefined) throw new TerminalError('invariant_violation');
      if (signal.aborted) return false;
      started = transport(url.href, {
        method,
        headers,
        body,
        signal,
        redirect: 'manual',
        ...(body instanceof ReadableStream ? { duplex: 'half' } : {}),
      } as RequestInit);
      // Observed below; this only prevents an unhandled rejection if admission fails after starting.
      started.catch(() => {});
      return true;
    };

    let ticket: AdmissionTicket;
    try {
      ticket = await options.admission.admit({ credentialGeneration: credential.generation, signal }, begin);
    } catch (error) {
      // An admission that failed after starting the request leaves it unrecordable; it is not released.
      if (started !== undefined) throw new TerminalError('invariant_violation');
      if (error instanceof AdmissionRefused) throw new TerminalError('admission_refused', error.reason);
      if (signal.aborted) throw stopped();
      throw new TerminalError('persistence_failure');
    }

    if (started === undefined) {
      const abandoned = ticket.abandoned('cancelled_before_dispatch');
      options.track?.(abandoned.catch(() => {}));
      await abandoned.catch(() => {
        throw new TerminalError('persistence_failure');
      });
      throw stopped();
    }

    let settle: () => void = () => {};
    options.track?.(
      new Promise<void>((resolve) => {
        settle = resolve;
      }),
    );

    let response: Response;
    try {
      response = await started;
    } catch {
      // The request started; whether the provider received it cannot be known.
      await ticket.unconfirmed().catch(() => {});
      settle();
      if (signal.aborted) throw stopped();
      throw new TerminalError('provider_unreachable');
    }

    const providerRequestId = REQUEST_ID_HEADERS.map((name) => response.headers.get(name)).find(
      (value): value is string => value !== null && SAFE_REQUEST_ID.test(value),
    );
    const finish = async (outcome: 'ok' | 'failed') => {
      try {
        await ticket.completed({ outcome, ...(providerRequestId === undefined ? {} : { providerRequestId }) });
      } finally {
        settle();
      }
    };

    try {
      await ticket.dispatched();
    } catch {
      await response.body?.cancel().catch(() => {});
      settle();
      throw new TerminalError('persistence_failure');
    }

    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => {});
      await finish('failed').catch(() => {});
      throw new TerminalError('redirect_refused');
    }

    if (response.body === null) {
      await finish(response.ok ? 'ok' : 'failed').catch(() => {
        throw new TerminalError('persistence_failure');
      });
      return {
        response: new Response(null, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        }),
        generation: credential.generation,
      };
    }

    return {
      response: new Response(trackBody(response.body, response.ok, signal, finish, stopped), {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      }),
      generation: credential.generation,
    };
  };
  return terminal as typeof fetch;
}

/**
 * Passes the body through, ending it only after completion is recorded. Cancellation or the deadline cancels the
 * underlying read (the fetch signal alone is not trusted to stop a stalled body) and errors the stream.
 */
function trackBody(
  source: ReadableStream<Uint8Array>,
  ok: boolean,
  signal: AbortSignal,
  finish: (outcome: 'ok' | 'failed') => Promise<void>,
  stopped: () => TerminalError,
): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  let done = false;
  const end = async (outcome: 'ok' | 'failed') => {
    if (done) return;
    done = true;
    signal.removeEventListener('abort', onAbort);
    await finish(outcome);
  };
  let output: ReadableStreamDefaultController<Uint8Array>;
  const onAbort = () => {
    const error = stopped();
    void reader.cancel(error).catch(() => {});
    void end('failed').catch(() => {});
    try {
      output.error(error);
    } catch {
      // Already closed or errored.
    }
  };
  return new ReadableStream<Uint8Array>({
    start(controller) {
      output = controller;
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    },
    async pull(controller) {
      let chunk: Awaited<ReturnType<typeof reader.read>>;
      try {
        chunk = await reader.read();
      } catch {
        if (done) return;
        const error = signal.aborted ? stopped() : new TerminalError('provider_unreachable');
        await end('failed').catch(() => {});
        controller.error(error);
        return;
      }
      if (done) return;
      if (!chunk.done) {
        controller.enqueue(chunk.value);
        return;
      }
      try {
        await end(ok ? 'ok' : 'failed');
      } catch {
        controller.error(new TerminalError('persistence_failure'));
        return;
      }
      controller.close();
    },
    async cancel() {
      // The consumer stopped reading before the end: the attempt did not complete successfully.
      await reader.cancel().catch(() => {});
      await end('failed').catch(() => {});
    },
  });
}
