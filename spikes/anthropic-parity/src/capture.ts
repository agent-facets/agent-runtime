// The terminal capture sink. It is the only permitted egress point: it records
// the fully transformed request and returns a synthetic response. It never
// forwards, so a bug that tries to reach a provider shows up as a counted
// forward attempt rather than a silent real API call.

import type { RawCapture } from "./canonical.ts";

type FetchInput = string | URL | Request;

export type CaptureSink = {
  captures: RawCapture[];
  forwardAttempts: number;
  fetch: (input: FetchInput, init?: RequestInit) => Promise<Response>;
};

export function createCaptureSink(
  respond: (capture: RawCapture) => Response,
): CaptureSink {
  const sink: CaptureSink = {
    captures: [],
    forwardAttempts: 0,
    fetch: async (input, init) => {
      const href =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;

      const headers: Record<string, string> = {};
      const initHeaders = init?.headers;
      if (initHeaders instanceof Headers) {
        initHeaders.forEach((value, key) => {
          headers[key] = value;
        });
      } else if (Array.isArray(initHeaders)) {
        for (const [key, value] of initHeaders) headers[key] = String(value);
      } else if (initHeaders) {
        for (const [key, value] of Object.entries(initHeaders)) {
          headers[key] = String(value);
        }
      } else if (input instanceof Request) {
        input.headers.forEach((value, key) => {
          headers[key] = value;
        });
      }

      let bodyRaw = "";
      const body = init?.body;
      if (typeof body === "string") {
        bodyRaw = body;
      } else if (body !== undefined && body !== null) {
        sink.forwardAttempts += 1;
        bodyRaw = "";
      }

      const capture: RawCapture = {
        method: (init?.method ?? "POST").toUpperCase(),
        url: href,
        headers,
        bodyRaw,
      };
      sink.captures.push(capture);

      return respond(capture);
    },
  };

  return sink;
}

/**
 * A fetch that must never be called. Installed over globalThis.fetch for the
 * duration of a lane so an un-intercepted call is loud rather than networked.
 */
export function createPoisonedFetch(onCall: () => void) {
  return async function poisonedFetch(): Promise<Response> {
    onCall();
    throw new Error("network access attempted from an offline parity run");
  };
}
