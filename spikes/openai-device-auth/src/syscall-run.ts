// Independent syscall verification.
//
// Runs in its own container with SYS_PTRACE and nothing else from the main
// measurement: the point is that the durable-write claim is checked by the
// kernel's account of what happened, not by the store's own description of
// itself.
//
// The negative control matters as much as the positive one. A truncate-in-place
// writer is traced too, and the checker must reject it -- otherwise the parser
// is agreeing with everything and the trace is decoration.

import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { digest, emit, EVIDENCE_SCHEMA, EXIT_HARNESS_FAULT, outcomeFor, SPIKE_ID } from "./evidence.ts";
import { verifyTrace } from "./syscall-check.ts";

const TRACED_CALLS = [
  "openat",
  "open",
  "write",
  "pwrite64",
  "fsync",
  "fdatasync",
  "rename",
  "renameat",
  "renameat2",
  "unlink",
  "unlinkat",
  "chmod",
  "fchmod",
  "fchmodat",
  "flock",
  "close",
  "ftruncate",
].join(",");

try {
  const atomic = await traceWrite("atomic");
  const control = await traceWrite("truncate-in-place");

  const acceptance = {
    trace_non_empty: atomic.findings.events > 0,
    temp_same_directory: atomic.findings.tempSameDirectory,
    temp_exclusive_create: atomic.findings.tempExclusiveCreate,
    mode_0600_at_create: atomic.findings.modeAtCreate,
    no_chmod_on_credential: atomic.findings.noChmodOnCredential,
    fsync_before_rename: atomic.findings.fsyncBeforeRename,
    rename_used: atomic.findings.renameUsed,
    no_truncate_on_target: atomic.findings.noTruncateOnTarget,
    directory_fsync_after_rename: atomic.findings.directoryFsyncAfterRename,
    flock_observed: atomic.findings.flockObserved,
    writes_confined_to_store: atomic.findings.writesConfinedToStore,
    // The control must fail the same checker the candidate passes.
    checker_rejects_unsafe_writer: control.findings.problems.length > 0,
  };

  const evidence = {
    schema: EVIDENCE_SCHEMA,
    spike: SPIKE_ID,
    stage: "syscall",
    atomic: atomic.findings,
    control: { problems: control.findings.problems },
    acceptance,
    managed_digest: digest(acceptance),
    outcome: outcomeFor(acceptance),
  };

  process.exit(emit(evidence as unknown as Record<string, unknown>));
} catch (error) {
  process.stdout.write(
    `${JSON.stringify({
      schema: EVIDENCE_SCHEMA,
      spike: SPIKE_ID,
      stage: "syscall",
      outcome: {
        status: "fault",
        fault: { step: "syscall-driver", message: (error as Error).message },
      },
    })}\n`,
  );
  process.exit(EXIT_HARNESS_FAULT);
}

async function traceWrite(mode: string) {
  const root = await mkdtemp(join(tmpdir(), "spike-trace-"));
  const store = join(root, "credentials");
  const tracePath = join(root, "trace.log");

  try {
    await new Promise<void>((resolve) => {
      const child = spawn(
        "strace",
        [
          "-f",
          "-y",
          "-e",
          `trace=${TRACED_CALLS}`,
          "-o",
          tracePath,
          process.execPath,
          "--no-warnings",
          new URL("./store/write-once.ts", import.meta.url).pathname,
          store,
          "openai",
          mode,
        ],
        { stdio: ["ignore", "ignore", "inherit"] },
      );
      child.once("exit", () => resolve());
      child.once("error", () => resolve());
    });

    const trace = await readFile(tracePath, "utf8").catch(() => "");
    return {
      findings: verifyTrace(trace, join(store, "openai.json"), store),
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
