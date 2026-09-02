// The synthetic issuer, exposed on loopback.
//
// Cross-process single-flight can only be measured if every process refreshes
// against one counter, so the in-process issuer is wrapped in an HTTP server on
// 127.0.0.1. `--network none` leaves loopback up and nothing else, so this adds
// no reachable surface: the container still cannot resolve or route anywhere.

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import type { SyntheticIssuer } from "./issuer.ts";

export type IssuerServer = {
  url: string;
  close: () => Promise<void>;
  server: Server;
};

export async function serveIssuer(issuer: SyntheticIssuer): Promise<IssuerServer> {
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      void (async () => {
        const body = Buffer.concat(chunks).toString("utf8");
        const url = `http://127.0.0.1${request.url ?? "/"}`;

        try {
          const result = await issuer.fetch(url, {
            method: request.method ?? "POST",
            headers: request.headers as Record<string, string>,
            body: body.length > 0 ? body : undefined,
          });

          const payload = Buffer.from(await result.arrayBuffer());
          const headers: Record<string, string> = {};
          result.headers.forEach((value, key) => {
            headers[key] = value;
          });
          response.writeHead(result.status, headers);
          response.end(payload);
        } catch (error) {
          response.writeHead(500, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: (error as Error).message }));
        }
      })();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${address.port}`,
    server,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}
