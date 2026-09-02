// A cooperating process for the cross-process single-flight measurement.
//
// Spawned N times against the same store directory and the same loopback
// issuer. The issuer counts refreshes centrally, so "exactly one upstream
// refresh across four processes and sixty-four callers" is measured at the
// only place that cannot be fooled by a local counter.
//
// It prints a digest of the resolved token, never the token.

import { createHash } from "node:crypto";

import { realClock } from "../clock.ts";
import { requestRefresh } from "../auth/refresh.ts";
import { CredentialStore } from "./credential-store.ts";

const [directory, provider, issuerUrl, callersRaw, lockFlag, guardFlag] = process.argv.slice(2);

if (!directory || !provider || !issuerUrl || !callersRaw) {
  process.stderr.write("usage: refresh-worker <dir> <provider> <issuer> <callers>\n");
  process.exit(2);
}

const callers = Number.parseInt(callersRaw, 10);

const store = new CredentialStore({
  directory,
  clock: realClock,
  crossProcessLock: lockFlag !== "no-lock",
  guardedReread: guardFlag !== "no-guard",
  refresh: (credential) =>
    requestRefresh(credential.refresh_token ?? "", {
      issuer: issuerUrl,
      fetch: (input, init) => fetch(input, init),
      clock: realClock,
    }),
});

try {
  const results = await Promise.all(
    Array.from({ length: callers }, () => store.getAccessToken(provider)),
  );

  const digests = [...new Set(results.map((token) => sha(token)))];

  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      pid: process.pid,
      distinctTokens: digests.length,
      tokenDigest: digests[0] ?? null,
      metrics: store.metrics,
    })}\n`,
  );
} catch (error) {
  process.stdout.write(
    `${JSON.stringify({
      ok: false,
      pid: process.pid,
      code: (error as { code?: string }).code ?? null,
      message: (error as Error).message,
    })}\n`,
  );
  process.exit(1);
}

function sha(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}
