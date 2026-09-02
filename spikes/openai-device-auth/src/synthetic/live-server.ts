// The rehearsal endpoint: a synthetic issuer and Responses endpoint on one
// loopback listener.
//
// The rehearsal drives the *real* live entrypoints and the *real* driver shell
// against this, under the same container user, read-only root filesystem,
// named volume, and timeouts as the live run. That is the point: the defects
// worth catching here -- a root-owned volume, an unwritable state directory, a
// stall that never times out, a failure path that skips revocation -- are all
// invisible to a unit test and all fatal after a real device code has been
// issued.
//
// Scenarios are selected by env so each failure path gets its own run.

import { createServer } from "node:http";

import { createSyntheticIssuer } from "./issuer.ts";
import { responsesStreamEvents } from "./provider.ts";
import { realClock } from "../clock.ts";

export type RehearsalScenario =
  | "happy"
  | "revoke-fail"
  | "idle-stall"
  | "model-mismatch"
  | "model-error"
  | "drip"
  | "short-token"
  | "no-stop"
  | "leaky";

const PORT = Number.parseInt(process.env.SPIKE_REHEARSAL_PORT ?? "8080", 10);
const SCENARIO = (process.env.SPIKE_REHEARSAL_SCENARIO ?? "happy") as RehearsalScenario;
const MODEL = process.env.SPIKE_LIVE_MODEL ?? "gpt-5.6-sol";
const IDLE_STALL_MS = 25_000;
/** Short enough to keep the 20s idle race from firing, forever. */
const DRIP_INTERVAL_MS = 5_000;

const issuer = createSyntheticIssuer({
  issuer: `http://127.0.0.1:${PORT}`,
  clock: realClock,
  interval: "1",
  // One 403 first, so the rehearsal exercises the poll loop rather than a
  // single lucky request.
  pollStatuses: [403],
  // Inside the five-minute proactive margin, the credential store refreshes on
  // its own during `reload`. That is a real behaviour, and the reload budget of
  // zero refreshes has to be able to see it.
  accessTokenLifetimeSeconds: SCENARIO === "short-token" ? 60 : 3_600,
});

const server = createServer((request, response) => {
  const chunks: Buffer[] = [];
  request.on("data", (chunk: Buffer) => chunks.push(chunk));
  request.on("end", () => {
    void (async () => {
      const path = (request.url ?? "/").split("?")[0] ?? "/";
      const body = Buffer.concat(chunks).toString("utf8");

      if (path.endsWith("/responses")) {
        await handleResponses(response);
        return;
      }

      if (path === "/oauth/revoke" && SCENARIO === "revoke-fail") {
        response.writeHead(500, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "synthetic_revocation_failure" }));
        return;
      }

      // Only the token the issuer most recently minted can be revoked. The
      // short-token scenario rotates during `reload`, so a caller that revokes
      // the token it read before dispatch is revoking a superseded one -- which
      // a permissive issuer would answer 200, leaving a live session behind
      // while the caller deletes its local copy.
      if (path === "/oauth/revoke" && SCENARIO === "short-token") {
        let presented: unknown = null;
        try {
          presented = (JSON.parse(body) as { token?: unknown }).token ?? null;
        } catch {
          presented = null;
        }
        const newest = issuer.issuedRefreshTokens[issuer.issuedRefreshTokens.length - 1] ?? null;
        if (presented !== newest) {
          response.writeHead(400, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: "stale_refresh_token" }));
          return;
        }
      }

      try {
        const result = await issuer.fetch(`http://127.0.0.1:${PORT}${path}`, {
          method: request.method ?? "POST",
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
        response.writeHead(404, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: (error as Error).message }));
      }
    })();
  });
});

async function handleResponses(response: import("node:http").ServerResponse): Promise<void> {
  if (SCENARIO === "model-error" || SCENARIO === "leaky") {
    // The `leaky` variant echoes a credential-shaped key name back in the error
    // message. sanitizeText does not strip key names and the in-container scan
    // does not look for them, so only the driver's own scan can catch it --
    // which is exactly the check being tested.
    const message =
      SCENARIO === "leaky"
        ? 'synthetic failure echoing {"refresh_token": "..."} back at the caller'
        : "synthetic auth failure";
    response.writeHead(401, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message } }));
    return;
  }

  const events = responsesStreamEvents({
    responseId: "resp_REHEARSAL",
    model: SCENARIO === "model-mismatch" ? "gpt-4o-mini" : MODEL,
    toolName: "spike_probe",
    toolArguments: JSON.stringify({ value: "alpha" }),
  });

  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-store",
    "x-request-id": "resp_REHEARSAL",
  });

  if (SCENARIO === "no-stop") {
    // Everything except the terminal event. The client still sees a complete
    // tool call, so only a reader of the provider's own bytes can notice that
    // no stop reason ever arrived.
    for (const event of events.slice(0, -1)) response.write(event);
    response.end();
    return;
  }

  if (SCENARIO === "drip") {
    // Never idle, never finishes. Only a wall-clock deadline can stop this;
    // a socket-inactivity timeout and an idle race both see a healthy stream.
    response.write(events[0]);
    response.write(events[1]);
    const handle = setInterval(() => response.write(events[2] ?? events[1]), DRIP_INTERVAL_MS);
    response.on("close", () => clearInterval(handle));
    return;
  }

  if (SCENARIO === "idle-stall") {
    // One event, then silence. The old post-chunk idle check could not fire
    // here at all; the abortable race must.
    response.write(events[0]);
    setTimeout(() => response.end(), IDLE_STALL_MS);
    return;
  }

  for (const event of events) response.write(event);
  response.end();
}

server.listen(PORT, "127.0.0.1", () => {
  process.stdout.write(
    `${JSON.stringify({ ready: true, port: PORT, scenario: SCENARIO })}\n`,
  );
});

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
