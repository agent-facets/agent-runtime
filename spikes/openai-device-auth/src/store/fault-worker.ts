// A process that dies mid-write, on purpose, at a named boundary.
//
// SIGKILL rather than an exception: an exception unwinds and closes
// descriptors, which is exactly the tidy shutdown the crash matrix is trying
// to avoid. The parent restarts and asserts the store is either the complete
// old generation or the complete new one, never something in between.
//
// The sibling provider's file is written once before the run and never touched
// here, so namespace preservation is checked by digest afterwards.

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { atomicWrite, type WriteMode, type WritePoint } from "./atomic-write.ts";
import { STORE_SCHEMA, type Credential, type ProviderFile } from "./credential-store.ts";

const [directory, provider, point, serialRaw, modeRaw] = process.argv.slice(2);

if (!directory || !provider || !point || !serialRaw) {
  process.stderr.write("usage: fault-worker <dir> <provider> <point> <serial> [mode]\n");
  process.exit(2);
}

const serial = Number.parseInt(serialRaw, 10);
const writeMode: WriteMode = modeRaw === "truncate-in-place" ? "truncate-in-place" : "atomic";
const target = join(directory, `${provider}.json`);

let generation = 0;
let credential: Credential;

try {
  const existing = JSON.parse(await readFile(target, "utf8")) as ProviderFile;
  generation = existing.generation;
  credential = existing.credential;
} catch {
  process.stderr.write("fault-worker: no readable starting state\n");
  process.exit(3);
}

const next: ProviderFile = {
  schema: STORE_SCHEMA,
  provider,
  generation: generation + 1,
  credential: {
    ...credential,
    access_token: `SPIKE-ROTATED-${String(serial).padStart(4, "0")}`,
    rotated_at: serial,
  },
};

// Padding makes the body large enough that a mid-write kill lands with the
// temp file genuinely incomplete rather than atomically small.
const payload = `${JSON.stringify({ ...next, padding: "x".repeat(8192) }, null, 2)}\n`;

await atomicWrite(
  target,
  payload,
  {
    at: (reached: WritePoint) => {
      if (reached === point) process.kill(process.pid, "SIGKILL");
    },
  },
  writeMode,
);

process.stdout.write(JSON.stringify({ ok: true, survived: point }));
