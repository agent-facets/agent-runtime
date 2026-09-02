// A loopback HTTP endpoint that records what the oracle actually sent.
//
// It answers with a well-formed Responses SSE stream so Codex completes its
// turn and exits cleanly instead of retrying or hanging, and it never forwards
// anything anywhere.

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import type { RawCapture } from "../transport/canonical.ts";

export type OracleCaptureServer = {
  url: string;
  basePath: string;
  captures: RawCapture[];
  /** Non-/responses requests, e.g. a WebSocket upgrade attempt. */
  otherRequests: Array<{ method: string; path: string; headers: Record<string, string> }>;
  close: () => Promise<void>;
  server: Server;
};

export async function serveOracleCapture(options: {
  basePath: string;
  sse: string;
  /** Refuse upgrades so the fidelity lane's fallback is observable. */
  refuseUpgrade?: boolean;
}): Promise<OracleCaptureServer> {
  const captures: RawCapture[] = [];
  const otherRequests: OracleCaptureServer["otherRequests"] = [];

  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const path = request.url ?? "/";
      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(request.headers)) {
        headers[key] = Array.isArray(value) ? value.join(", ") : String(value ?? "");
      }

      if (!path.endsWith("/responses")) {
        otherRequests.push({ method: request.method ?? "GET", path, headers });
        response.writeHead(404, { "content-type": "application/json" });
        response.end("{}");
        return;
      }

      const bodyBytes = Buffer.concat(chunks);
      captures.push({
        method: request.method ?? "POST",
        url: `http://127.0.0.1${path}`,
        headers,
        bodyRaw: bodyBytes.toString("utf8"),
        bodyBytes,
      });

      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-store",
        connection: "close",
      });
      response.end(options.sse);
    });
  });

  server.on("upgrade", (request, socket) => {
    otherRequests.push({
      method: "GET",
      path: request.url ?? "/",
      headers: Object.fromEntries(
        Object.entries(request.headers).map(([key, value]) => [
          key,
          Array.isArray(value) ? value.join(", ") : String(value ?? ""),
        ]),
      ),
    });
    socket.end("HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\n\r\n");
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${address.port}${options.basePath}`,
    basePath: options.basePath,
    captures,
    otherRequests,
    server,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}
