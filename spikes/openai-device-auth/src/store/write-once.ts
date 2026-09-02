// One locked, atomic credential commit. Nothing else.
//
// Kept deliberately small because it is the process the tracer follows: every
// syscall in the resulting trace should be attributable to the store, so an
// unexplained write is a finding rather than noise from an unrelated code path.

import { realClock } from "../clock.ts";
import { CredentialStore } from "./credential-store.ts";
import { acquireLock } from "./lock.ts";
import type { WriteMode } from "./atomic-write.ts";
import { sentinelCredential } from "../experiments/auth-store.ts";

const [directory, provider, modeRaw] = process.argv.slice(2);

if (!directory || !provider) {
  process.stderr.write("usage: write-once <dir> <provider> [mode]\n");
  process.exit(2);
}

const writeMode: WriteMode = modeRaw === "truncate-in-place" ? "truncate-in-place" : "atomic";

const store = new CredentialStore({
  directory,
  clock: realClock,
  writeMode,
  refresh: async () => ({
    idToken: null,
    accessToken: null,
    refreshToken: null,
    expiresAtSeconds: null,
  }),
});

await store.initialise();

// The lock is taken explicitly so flock(2) appears in the trace even though
// this path never refreshes.
const lock = await acquireLock(store.lockPathFor(provider), { timeoutMs: 10_000 });
try {
  await store.install(sentinelCredential(provider, Math.floor(Date.now() / 1000) + 3_600));
} finally {
  await lock.release();
}

process.stdout.write(JSON.stringify({ ok: true, target: store.pathFor(provider) }));
