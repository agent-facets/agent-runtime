// A terminal transport built on node:http, not on fetch.
//
// This exists because of a measured defect in the obvious approach. Node's
// global `fetch` (undici) unconditionally adds browser headers the reference
// client never sends:
//
//   accept-language: *
//   sec-fetch-mode: cors
//
// `accept-encoding` and `connection` can be overridden by setting them
// explicitly, but these two cannot be removed through the Fetch API at all --
// they are added by the Fetch specification's own request algorithm, below the
// point any caller can reach. Measured, not assumed: the same request through
// `node:http` sends only `connection`, `content-length`, `content-type`, and
// `host`.
//
// So byte-level header parity with the reference client is unreachable through
// `fetch`, and reachable through `node:http`. The seam is unaffected: the
// OpenAI SDK only requires a function returning a `Response`, so the stock
// `ChatOpenAI` construction stays exactly as it was.
//
// Streaming is preserved by wrapping the response as a ReadableStream rather
// than buffering, so SSE still arrives incrementally.

import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { Readable } from "node:stream";

export type TerminalOptions = {
  /** Aborts the whole request, headers and body alike. */
  timeoutMs?: number;
};

export function createNodeHttpTerminal(options: TerminalOptions = {}) {
  return async function terminal(input: string, init: RequestInit): Promise<Response> {
    const url = new URL(input);
    const isHttps = url.protocol === "https:";
    const send = isHttps ? httpsRequest : httpRequest;

    const headers: Record<string, string> = {};
    const initHeaders = init.headers;
    if (initHeaders instanceof Headers) {
      initHeaders.forEach((value, key) => {
        headers[key] = value;
      });
    } else if (Array.isArray(initHeaders)) {
      for (const [key, value] of initHeaders) headers[key] = String(value);
    } else if (initHeaders) {
      for (const [key, value] of Object.entries(initHeaders)) headers[key] = String(value);
    }

    const body = typeof init.body === "string" ? init.body : undefined;

    return new Promise<Response>((resolve, reject) => {
      const outgoing = send(
        {
          protocol: url.protocol,
          hostname: url.hostname,
          port: url.port || (isHttps ? 443 : 80),
          path: `${url.pathname}${url.search}`,
          method: (init.method ?? "POST").toUpperCase(),
          headers,
        },
        (incoming) => {
          const responseHeaders = new Headers();
          for (const [name, value] of Object.entries(incoming.headers)) {
            if (value === undefined) continue;
            responseHeaders.set(name, Array.isArray(value) ? value.join(", ") : value);
          }

          resolve(
            new Response(Readable.toWeb(incoming) as ReadableStream<Uint8Array>, {
              status: incoming.statusCode ?? 0,
              statusText: incoming.statusMessage ?? "",
              headers: responseHeaders,
            }),
          );
        },
      );

      if (options.timeoutMs) {
        outgoing.setTimeout(options.timeoutMs, () => {
          outgoing.destroy(new Error(`request exceeded ${options.timeoutMs}ms`));
        });
      }

      init.signal?.addEventListener("abort", () => outgoing.destroy(new Error("aborted")), {
        once: true,
      });

      outgoing.once("error", reject);
      outgoing.end(body);
    });
  };
}

/** Headers Node adds at the transport layer, which no caller controls. */
export const NODE_HTTP_AUTOMATIC_HEADERS = ["host", "connection"];

/** Headers undici's fetch adds and no caller can remove. */
export const FETCH_UNREMOVABLE_HEADERS = ["accept-language", "sec-fetch-mode"];
