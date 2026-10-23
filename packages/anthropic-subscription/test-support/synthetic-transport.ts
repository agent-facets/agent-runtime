// A scripted stand-in for the runtime's terminal transport. It plays the issuer or model endpoint side of an exchange
// and is an independent witness of what the package sent: every request it receives is recorded before any scripted
// behavior runs. Nothing here contacts a network.
import { NotSentError, type Transport } from '../src/contracts.ts';

export type Reply =
  | { kind: 'json'; status?: number; body: unknown; headers?: Record<string, string> }
  | { kind: 'text'; status?: number; body: string; headers?: Record<string, string> }
  /** Streams the given chunks; `stall` keeps the body open after them until the request signal aborts. */
  | {
      kind: 'chunks';
      status?: number;
      chunks: (string | Uint8Array)[];
      stall?: boolean;
      headers?: Record<string, string>;
    }
  /** The transport reports that the request never left. */
  | { kind: 'not_sent' }
  /** The connection failed after the request may have been delivered. */
  | { kind: 'lost' }
  /** Never answers until the request signal aborts. */
  | { kind: 'hang' };

export interface RecordedRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
}

export class SyntheticTransport {
  readonly requests: RecordedRequest[] = [];
  readonly #replies: Reply[];

  constructor(replies: Reply[] = []) {
    this.#replies = [...replies];
  }

  /** Requests the package actually handed to the transport. */
  get count(): number {
    return this.requests.length;
  }

  readonly transport: Transport = async (request) => {
    const body = request.body === null ? '' : await request.text();
    this.requests.push({
      method: request.method,
      url: request.url,
      headers: Object.fromEntries(request.headers),
      body,
    });
    const reply = this.#replies.shift();
    if (reply === undefined) throw new Error('synthetic transport: unscripted request');
    return respond(reply, request.signal);
  };
}

function aborted(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) reject(signal.reason);
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}

async function respond(reply: Reply, signal: AbortSignal): Promise<Response> {
  if (signal.aborted) throw signal.reason;
  switch (reply.kind) {
    case 'not_sent':
      throw new NotSentError('synthetic: not sent');
    case 'lost':
      throw new TypeError('synthetic: connection reset');
    case 'hang':
      return aborted(signal);
    case 'json':
      return new Response(JSON.stringify(reply.body), {
        status: reply.status ?? 200,
        headers: { 'content-type': 'application/json', ...reply.headers },
      });
    case 'text':
      return new Response(reply.body, { status: reply.status ?? 200, headers: reply.headers });
    case 'chunks': {
      const encoder = new TextEncoder();
      const chunks = reply.chunks.map((chunk) => (typeof chunk === 'string' ? encoder.encode(chunk) : chunk));
      const stream = new ReadableStream<Uint8Array>({
        async pull(controller) {
          const next = chunks.shift();
          if (next !== undefined) {
            controller.enqueue(next);
            return;
          }
          if (reply.stall) {
            try {
              await aborted(signal);
            } catch (error) {
              controller.error(error);
              return;
            }
          }
          controller.close();
        },
      });
      return new Response(stream, { status: reply.status ?? 200, headers: reply.headers });
    }
  }
}
