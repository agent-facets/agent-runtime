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

/**
 * The sensitive-candidate canary.
 *
 * It is planted in exactly one source-plane fixture, which is legitimate: the
 * corpus needs material the admission policy must refuse. It is illegitimate
 * everywhere else. Zero occurrences are permitted in canonical state, derived
 * indexes, exports, backups, coordination namespaces, logs, or evidence.
 *
 * The literal lives in harness source rather than in the evidence tree so the
 * scanner cannot match itself.
 */
export const SENSITIVE_CANARY = "KPWM-CANARY-4F2A9C61D7B3E508";

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
  ["wsl-host-path", /\\\\wsl(?:\$|\.localhost)\\|\b[A-Za-z]:\\Users\\/],
  ["pg-connection-log-line", /connection authorized: user=\S+ database=\S+.*host=/],
  // New for this spike.
  ["bolt-dsn-with-password", /bolt(?:\+s|\+ssc)?:\/\/[^:@/\s]+:[^@\s]+@/i],
  ["neo4j-auth-env", /NEO4J_AUTH=\S+/],
  ["neo4j-plaintext-password", /"password"\s*:\s*"(?!<redacted>)[^"]+"/],
  ["obsidian-mcp-token", /"(?:authorization|apiKey|token)"\s*:\s*"[A-Za-z0-9_-]{16,}"/i],
  ["vault-absolute-path", /"\/vault\/[^"]*"/],
  ["sensitive-canary", new RegExp(SENSITIVE_CANARY)],
];

export function scanForLeaks(serialized: string): string[] {
  return LEAK_PATTERNS.filter(([, pattern]) => pattern.test(serialized)).map(([rule]) => rule);
}

/**
 * A criterion map is only an outcome if it actually contains criteria.
 *
 * `Object.entries({}).filter(...)` is empty and would report `pass`, which is
 * how an acceptance map that was never populated turns into a green run. An
 * empty map is a fault, not a success.
 */
export function outcomeFor(acceptance: Record<string, boolean>): Outcome {
  const entries = Object.entries(acceptance);
  if (entries.length === 0) {
    return {
      status: "fault",
      fault: { step: "acceptance", message: "acceptance map is empty" },
    };
  }
  const failed = entries.filter(([, value]) => value !== true).map(([key]) => key);
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
