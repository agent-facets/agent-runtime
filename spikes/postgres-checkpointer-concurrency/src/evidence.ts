// Evidence emission and the in-container leak guard.
//
// Every container prints exactly one JSON object to stdout and writes no file,
// so the host driver owns all persistence. The leak scan runs here as well as in
// the driver: catching something before it is printed means it never reaches
// disk, and the driver's sweep then becomes a second independent check rather
// than the only one.

import { EVIDENCE_SCHEMA, SPIKE_ID } from "./contract.ts";

export const EXIT_PASS = 0;
export const EXIT_MEASURED_NEGATIVE = 1;
export const EXIT_USAGE = 2;
export const EXIT_HARNESS_FAULT = 3;
export const EXIT_SANITIZATION = 4;

export type Outcome =
  | { status: "pass" }
  | { status: "fail"; failed: string[] }
  | { status: "fault"; fault: { step: string; message: string } };

const LEAK_PATTERNS: Array<[string, RegExp]> = [
  ["pg-dsn-with-password", /postgres(?:ql)?:\/\/[^:@/\s]+:[^@\s]+@/i],
  ["pgpassword-env", /PGPASSWORD=\S+/],
  ["bearer-plaintext", /Bearer [A-Za-z0-9_-]{20,}/],
  ["jwt", /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./],
  ["openai-key", /sk-(?:proj-)?[A-Za-z0-9_-]{20,}/],
  ["anthropic-key", /sk-ant-(?:api|oat|ort)[0-9]{2}-[A-Za-z0-9_-]{16,}/],
  ["model-provider-host", /api\.(?:openai|anthropic)\.com/],
  ["host-path", /\/(?:home|Users)\/[A-Za-z0-9._-]+\//],
  ["docker-storage-path", /\/var\/lib\/docker\//],
  ["container-runtime-socket", /\/var\/run\/docker\.sock|DOCKER_HOST=/],
  // New for this spike. The restart family reads `docker inspect` on the
  // database container and the Store family handles caller-supplied values.
  ["pgdata-host-mount-source", /"Source"\s*:\s*"\/[^"]*postgresql[^"]*"/],
  ["wsl-host-path", /\\\\wsl(?:\$|\.localhost)\\|\b[A-Za-z]:\\Users\\/],
  ["pg-connection-log-line", /connection authorized: user=\S+ database=\S+.*host=/],
];

export function scanForLeaks(serialized: string): string[] {
  return LEAK_PATTERNS.filter(([, pattern]) => pattern.test(serialized)).map(([rule]) => rule);
}

export function outcomeFor(acceptance: Record<string, boolean>): Outcome {
  const failed = Object.entries(acceptance)
    .filter(([, value]) => !value)
    .map(([key]) => key);
  return failed.length === 0 ? { status: "pass" } : { status: "fail", failed };
}

export function emit(payload: Record<string, unknown>): number {
  const body = { schema: EVIDENCE_SCHEMA, spike: SPIKE_ID, ...payload };
  const serialized = JSON.stringify(body, null, 2);
  const hits = scanForLeaks(serialized);

  if (hits.length > 0) {
    process.stdout.write(
      `${JSON.stringify(
        {
          schema: EVIDENCE_SCHEMA,
          spike: SPIKE_ID,
          outcome: {
            status: "fault",
            fault: { step: "evidence-sanitization", message: `matched ${hits.join(", ")}` },
          },
        },
        null,
        2,
      )}\n`,
    );
    return EXIT_SANITIZATION;
  }

  process.stdout.write(`${serialized}\n`);

  const outcome = payload.outcome as Outcome | undefined;
  if (!outcome) return EXIT_PASS;
  if (outcome.status === "fault") return EXIT_HARNESS_FAULT;
  if (outcome.status === "fail") return EXIT_MEASURED_NEGATIVE;
  return EXIT_PASS;
}
