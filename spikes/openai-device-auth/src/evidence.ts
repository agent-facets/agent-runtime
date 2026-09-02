// Evidence shaping, the managed digest, and the in-container leak guard.
//
// The container prints one JSON object to stdout and writes nothing, so the
// driver owns all persistence. The leak scan runs here as well as in the
// driver: catching a credential before it is printed means it never reaches
// disk in the first place, and the driver's scan then becomes a second,
// independent check rather than the only one.

import { createHash } from "node:crypto";

export const EVIDENCE_SCHEMA = "agent-runtime/spike-evidence/1";
export const SPIKE_ID = "openai-device-auth";

export type Outcome =
  | { status: "pass" }
  | { status: "fail"; failed: string[] }
  | { status: "fault"; fault: { step: string; message: string } };

export const EXIT_PASS = 0;
export const EXIT_MEASURED_NEGATIVE = 1;
export const EXIT_USAGE = 2;
export const EXIT_HARNESS_FAULT = 3;
export const EXIT_SANITIZATION = 4;

export function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/**
 * Patterns that must never appear in evidence. The sentinel rules exist even
 * though a sentinel is fake by construction: a sentinel reaching evidence is a
 * redaction failure, and finding it here is much cheaper than finding a real
 * token the same way later.
 */
const LEAK_PATTERNS: Array<[string, RegExp]> = [
  ["sentinel-access", /SPIKESENTINELACCESS-[0-9]{4}/],
  ["sentinel-refresh", /SPIKESENTINELREFRESH-[0-9]{4}/],
  ["sentinel-id", /SPIKESENTINELID/],
  ["jwt", /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./],
  ["bearer-plaintext", /Bearer [A-Za-z0-9_-]{20,}/],
  ["openai-key", /sk-(proj-)?[A-Za-z0-9_-]{20,}/],
  ["host-path", /\/home\/[a-z0-9_-]+\//],
  ["device-user-code", /\b[A-Z0-9]{4}-[A-Z0-9]{4}\b/],
];

export type LeakHit = { rule: string };

/**
 * Aggressive redaction for free-form text that came from outside the harness --
 * the oracle's stderr, an exception message. Prose survives; anything that
 * could carry a token, a path, or a one-time code does not.
 *
 * Order matters: the longest and most specific shapes are replaced first, so a
 * JWT is not first mangled into an unrecognisable run of base64.
 */
export function sanitizeText(text: string): string {
  return text
    .replace(/eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g, "<jwt>")
    .replace(/Bearer\s+\S+/gi, "Bearer <redacted>")
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, "<key>")
    .replace(/SPIKESENTINEL[A-Za-z]*-?[0-9]*/g, "<sentinel>")
    .replace(/\b[A-Za-z0-9_-]{24,}\b/g, "<opaque>")
    .replace(/\b[A-Z0-9]{4}-[A-Z0-9]{4}\b/g, "<code>")
    .replace(/\/home\/[^\s"']+/g, "/home/<redacted>")
    .replace(/\/tmp\/[^\s"']+/g, "/tmp/<redacted>");
}

export function scanForLeaks(serialized: string): LeakHit[] {
  return LEAK_PATTERNS.filter(([, pattern]) => pattern.test(serialized)).map(([rule]) => ({ rule }));
}

/**
 * Print the evidence, refusing if it carries anything credential-shaped.
 * Returns the process exit code.
 */
export function emit(evidence: Record<string, unknown>): number {
  const serialized = JSON.stringify(evidence, null, 2);
  const hits = scanForLeaks(serialized);

  if (hits.length > 0) {
    process.stdout.write(
      `${JSON.stringify(
        {
          schema: EVIDENCE_SCHEMA,
          spike: SPIKE_ID,
          outcome: {
            status: "fault",
            fault: {
              step: "evidence-sanitization",
              message: `evidence matched ${hits.map((hit) => hit.rule).join(", ")}`,
            },
          },
        },
        null,
        2,
      )}\n`,
    );
    return EXIT_SANITIZATION;
  }

  process.stdout.write(`${serialized}\n`);

  const outcome = evidence.outcome as Outcome | undefined;
  if (!outcome) return EXIT_HARNESS_FAULT;
  if (outcome.status === "fault") return EXIT_HARNESS_FAULT;
  if (outcome.status === "fail") return EXIT_MEASURED_NEGATIVE;
  return EXIT_PASS;
}

export function outcomeFor(acceptance: Record<string, boolean>): Outcome {
  const failed = Object.entries(acceptance)
    .filter(([, value]) => !value)
    .map(([key]) => key);
  return failed.length === 0 ? { status: "pass" } : { status: "fail", failed };
}

/** Measured, not asserted: attempt a real connection and record the errno. */
export async function measureNetworkIsolation(): Promise<{
  isolated: boolean;
  errno: string | null;
}> {
  const { connect } = await import("node:net");
  return new Promise((resolve) => {
    const socket = connect({ host: "1.1.1.1", port: 443 });
    const done = (isolated: boolean, errno: string | null) => {
      socket.destroy();
      resolve({ isolated, errno });
    };
    socket.setTimeout(2_000, () => done(true, "ETIMEDOUT"));
    socket.once("connect", () => done(false, null));
    socket.once("error", (error) => done(true, (error as NodeJS.ErrnoException).code ?? "EUNKNOWN"));
  });
}
