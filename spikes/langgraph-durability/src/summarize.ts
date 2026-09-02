// Acceptance computation.
//
// Runs in its own container over the collected case bundles piped in on stdin,
// so the analysis is version-pinned TypeScript rather than shell arithmetic, and
// the driver stays a dumb executor that owns only Docker and persistence.
//
// Two governing rules:
//
//   1. No criterion may be satisfiable by output equality alone. The graphs are
//      deterministic, so a process that ignored every checkpoint and replayed
//      from scratch produces a byte-identical final state. Every claim is
//      anchored to execution counts, checkpoint lineage, or write attribution.
//   2. No criterion may pass on missing data. `[].every(...)` is `true` and
//      `undefined !== false` is `true`; both would turn "never measured" into
//      "measured clean". Every check below requires its evidence to exist.

import {
  canonicaliseProjection,
  chainShape,
  countEvents,
  digest,
  noncesByStage,
  stable,
} from "./canonical.ts";
import { PINNED_PACKAGES, ROOT_NS } from "./contract.ts";
import type { EventRow, InterruptRow, Projection } from "./inspect.ts";
import { outcomeFor } from "./evidence.ts";
import { CASES } from "./cases.ts";

export type KillRecord = {
  signal: string;
  waitExit: number;
  status: string;
  oomKilled: boolean;
  container: string;
};

export type Posture = {
  readOnly: boolean;
  user: string;
  capDrop: string[];
  publishedPorts: number;
  binds: number;
  mounts: number;
  networkMode: string;
  pidsLimit: number;
  memory: number;
};

export type Bundle = {
  case: string;
  await?: Record<string, unknown> | null;
  kill?: KillRecord | null;
  primary?: { container: string; posture: Posture } | null;
  backends?: { count: number } | null;
  mutate?: Record<string, unknown> | null;
  run: {
    stage: string;
    container: string;
    pid: number;
    nonce: string;
    packages?: Array<{ name: string; matches: boolean }>;
    egress?: { isolated: boolean };
    invoke?: {
      finalState: unknown;
      interrupted: boolean;
      error: { name: string; message: string } | null;
    };
    beforeResume?: { interrupts: InterruptRow[]; checkpoints: number } | null;
    gate?: {
      durability: string;
      observationMs: number;
      secondStartedWhileHeld: boolean;
      secondStartedAfterRelease: boolean;
    };
    final: Projection;
  };
};

function stateOf(bundle: Bundle | undefined): Record<string, unknown> {
  const raw = (bundle?.run.invoke?.finalState ?? null) as Record<string, unknown> | null;
  if (!raw) return {};
  const { __interrupt__: _ignored, ...rest } = raw;
  return rest;
}

function eventsOf(bundle: Bundle | undefined): EventRow[] {
  return bundle?.run.final.events ?? [];
}

function total(bundle: Bundle | undefined, node: string, phase: string): number {
  return countEvents(eventsOf(bundle), node, phase);
}

function errorName(bundle: Bundle | undefined): string | null {
  return bundle?.run.invoke?.error?.name ?? null;
}

function killIsCrash(bundle: Bundle | undefined): boolean {
  const kill = bundle?.kill;
  if (!kill) return false;
  const graceful = eventsOf(bundle).some(
    (event) => event.node === "process" && event.phase === "graceful-sigterm",
  );
  return (
    kill.signal === "KILL" &&
    kill.waitExit === 137 &&
    kill.status === "exited" &&
    kill.oomKilled === false &&
    !graceful
  );
}

function freshProcess(bundle: Bundle | undefined): boolean {
  const nonces = noncesByStage(eventsOf(bundle));
  const primary = nonces.primary ?? [];
  const resume = nonces.resume ?? [];
  if (primary.length === 0 || resume.length === 0) return false;
  if (resume.some((value) => primary.includes(value))) return false;
  const primaryContainer = bundle?.primary?.container;
  const resumeContainer = bundle?.run.container;
  return (
    typeof primaryContainer === "string" &&
    typeof resumeContainer === "string" &&
    primaryContainer !== resumeContainer
  );
}

/** Interrupts attached to the ROOT HEAD. History is not a pending decision. */
function pendingInterruptsAtHead(bundle: Bundle | undefined): number {
  const projection = bundle?.run.final;
  if (!projection) return -1;
  const rows = projection.checkpoints.filter((row) => row.checkpoint_ns === ROOT_NS);
  if (rows.length === 0) return -1;
  const claimed = new Set(
    rows.map((row) => row.parent_checkpoint_id).filter((id): id is string => id !== null),
  );
  const leaves = rows.filter((row) => !claimed.has(row.checkpoint_id));
  const head = leaves.length === 1 ? leaves[0]! : rows.at(-1)!;
  return projection.interrupts.filter(
    (row) => row.checkpoint_id === head.checkpoint_id && row.checkpoint_ns === head.checkpoint_ns,
  ).length;
}

/** Writes attached to the head checkpoint in the frozen pre-kill projection. */
function writesAtFrozenHead(bundle: Bundle | undefined): number {
  const value = bundle?.await?.writesAtHead;
  return typeof value === "number" ? value : -1;
}

function chainIntact(bundle: Bundle | undefined): boolean {
  const projection = bundle?.run.final;
  if (!projection || projection.checkpoints.length === 0) return false;
  const shape = chainShape(projection.checkpoints);
  return (
    shape.roots === 1 &&
    shape.forks === 0 &&
    shape.danglingParents === 0 &&
    shape.leaves === 1 &&
    shape.stepsMonotonic &&
    shape.namespaces.length === 1 &&
    shape.namespaces[0] === ROOT_NS
  );
}

/** Exactly one terminal execution and the terminal marker committed once. */
function terminatedOnce(bundle: Bundle | undefined): boolean {
  return (
    total(bundle, "finish", "enter") === 1 &&
    (stateOf(bundle) as { done?: string }).done === "finished"
  );
}

function raiseNonces(bundle: Bundle | undefined): string[] {
  return eventsOf(bundle)
    .filter((event) => event.node === "approval" && event.phase === "pre-interrupt")
    .map((event) => String(event.detail?.raiseNonce ?? ""));
}

export function summarize(bundles: Bundle[]): Record<string, unknown> {
  const byId = new Map(bundles.map((bundle) => [bundle.case, bundle]));
  const get = (id: string) => byId.get(id);

  const seqGolden = get("seq-golden");
  const parGolden = get("par-golden");
  const intGolden = get("int-golden");
  const seqCrash = get("seq-crash");
  const parCrash = get("par-crash");
  const intCrash = get("int-crash");
  const intFalse = get("int-false");
  const gateSync = get("gate-sync");
  const gateAsync = get("gate-async");
  const asyncCrash = get("async-crash");
  const exitCrash = get("exit-crash");
  const memCrash = get("mem-crash");
  const fakeResume = get("fake-resume");
  const ckptIdResume = get("ckpt-id-resume");
  const deletedWrites = get("delete-writes");
  const sigterm = get("sigterm");

  const killCases = bundles.filter((bundle) => bundle.kill?.signal === "KILL");
  const expectedPins = Object.keys(PINNED_PACKAGES).length;

  // --- interrupt identity ---------------------------------------------------
  // The persisted payload must carry the PRIMARY's nonce, and the resumed
  // execution must have generated a DIFFERENT one. Comparing payloads alone
  // proves only that an interrupt-shaped row survived; a fresh run reaching the
  // same node produces an identical-looking interrupt.
  const intNonces = raiseNonces(intCrash);
  const rediscovered = intCrash?.run.beforeResume?.interrupts ?? [];
  const rediscoveredText = rediscovered.map((row) => row.payload).join("\n");
  const frozenInterrupts =
    ((intCrash?.await?.frozen as Projection | undefined)?.interrupts ?? []).map(
      (row) => row.payload,
    );

  const acceptance: Record<string, boolean> = {
    // --- contract, all fail-closed on missing evidence ----------------------
    all_expected_cases_present:
      CASES.every((entry) => byId.has(entry.id)) && bundles.length === CASES.length,
    pins_match_lockfile_and_manifest:
      bundles.length > 0 &&
      bundles.every(
        (bundle) =>
          (bundle.run.packages?.length ?? 0) === expectedPins &&
          bundle.run.packages!.every((entry) => entry.matches),
      ),
    egress_blocked_in_every_container:
      bundles.length > 0 && bundles.every((bundle) => bundle.run.egress?.isolated === true),
    workers_ran_as_pid_1: bundles.length > 0 && bundles.every((bundle) => bundle.run.pid === 1),
    worker_posture_measured:
      killCases.length > 0 &&
      killCases.every((bundle) => {
        const posture = bundle.primary?.posture;
        if (!posture) return false;
        return (
          posture.readOnly === true &&
          posture.user === "node" &&
          posture.capDrop.length === 1 &&
          posture.capDrop[0] === "ALL" &&
          posture.publishedPorts === 0 &&
          posture.binds === 0 &&
          posture.mounts === 0 &&
          posture.networkMode !== "host" &&
          posture.pidsLimit > 0 &&
          posture.memory > 0
        );
      }),

    // --- kill witnesses -----------------------------------------------------
    kill_was_a_real_sigkill: killCases.length > 0 && killCases.every(killIsCrash),
    killed_backend_gone_before_resume:
      killCases.length > 0 && killCases.every((bundle) => bundle.backends?.count === 0),
    resume_ran_in_a_fresh_process:
      freshProcess(seqCrash) && freshProcess(parCrash) && freshProcess(intCrash),

    // --- sequential crash ---------------------------------------------------
    seq_final_state_matches_golden:
      stable(stateOf(seqCrash)) === stable(stateOf(seqGolden)) &&
      Object.keys(stateOf(seqGolden)).length > 0,
    seq_completed_node_not_replayed: total(seqCrash, "seed", "enter") === 1,
    seq_killed_node_replayed_exactly_once: total(seqCrash, "work", "enter") === 2,
    seq_killed_node_effect_observed_twice: total(seqCrash, "work", "effect") === 2,
    // The killed node parked BEFORE returning, so it never reached putWrites.
    // This asserts that it contributed nothing at all — not that a partial
    // write was rolled back, which the checkpointer's single transaction would
    // handle anyway and which this harness does not measure.
    seq_killed_node_left_no_write_at_head: writesAtFrozenHead(seqCrash) === 0,
    seq_no_partial_reducer_update:
      Array.isArray((stateOf(seqCrash) as { pairL?: string[] }).pairL) &&
      (stateOf(seqCrash) as { pairL: string[] }).pairL.length === 1 &&
      (stateOf(seqCrash) as { pairR?: number }).pairR === 1,
    seq_single_input_checkpoint:
      (chainShape(seqCrash?.run.final.checkpoints ?? []).sources.input ?? 0) === 1,
    seq_terminated_once: terminatedOnce(seqCrash),

    // --- pending writes -----------------------------------------------------
    pending_write_reused_for_completed_branch: total(parCrash, "fast", "enter") === 1,
    pending_write_unfinished_branch_replayed: total(parCrash, "blocked", "enter") === 2,
    pending_final_state_matches_golden:
      stable(stateOf(parCrash)) === stable(stateOf(parGolden)) &&
      Object.keys(stateOf(parGolden)).length > 0,
    pending_terminated_once: terminatedOnce(parCrash),

    // --- interrupt ----------------------------------------------------------
    interrupt_survived_process_death:
      frozenInterrupts.length === 1 &&
      rediscovered.length === 1 &&
      digest(frozenInterrupts) === digest(rediscovered.map((row) => row.payload)),
    interrupt_payload_carries_primary_raise_nonce:
      intNonces.length === 2 &&
      intNonces[0]!.length > 0 &&
      rediscoveredText.includes(intNonces[0]!),
    interrupt_resume_raised_a_distinct_nonce:
      intNonces.length === 2 && intNonces[0] !== intNonces[1],
    interrupt_resumed_with_decision:
      (stateOf(intCrash) as { decision?: string }).decision === "approved" &&
      intCrash?.run.invoke?.interrupted === false,
    interrupt_final_state_matches_golden:
      stable(stateOf(intCrash)) === stable(stateOf(intGolden)) &&
      Object.keys(stateOf(intGolden)).length > 0,
    interrupt_not_pending_at_head: pendingInterruptsAtHead(intCrash) === 0,
    pre_interrupt_code_replayed_once: total(intCrash, "approval", "pre-interrupt") === 2,
    interrupt_node_committed_once:
      ((stateOf(intCrash) as { trace?: string[] }).trace ?? []).filter(
        (entry) => entry === "approval",
      ).length === 1,
    interrupt_terminated_once: terminatedOnce(intCrash),

    // --- lineage ------------------------------------------------------------
    checkpoint_chain_intact:
      chainIntact(seqCrash) && chainIntact(parCrash) && chainIntact(intCrash),
    channel_versions_monotonic: [seqCrash, parCrash, intCrash, seqGolden].every((bundle) => {
      const projection = bundle?.run.final;
      if (!projection || projection.blobs.length === 0) return false;
      return canonicaliseProjection(projection).blobs.versionsMonotonicPerChannel;
    }),

    // --- durability modes ---------------------------------------------------
    sync_blocks_next_node_until_persisted:
      gateSync?.run.gate?.secondStartedWhileHeld === false &&
      gateSync?.run.gate?.secondStartedAfterRelease === true &&
      (gateSync?.run.gate?.observationMs ?? 0) > 0,
    async_starts_next_node_while_pending:
      gateAsync?.run.gate?.secondStartedWhileHeld === true,
    // The wrapper HOLDS the window open; it does not sample a real disk race.
    // What is measured is the consequence: the next node ran, no loop
    // checkpoint landed, and the resume had to replay the lost superstep.
    gated_async_dispatched_before_persisting:
      (asyncCrash?.await?.loopCheckpointsAtKill as number | undefined) === 0 &&
      countEvents(eventsOf(asyncCrash), "work", "enter", "primary") === 1,
    gated_async_lost_superstep_was_replayed: total(asyncCrash, "seed", "enter") === 2,
    exit_mode_wrote_nothing_mid_run:
      (exitCrash?.await?.checkpointsAtKill as number | undefined) === 0,
    exit_mode_run_was_unrecoverable: errorName(exitCrash) === "EmptyInputError",

    // --- anti-tautology controls -------------------------------------------
    control_memory_saver_cannot_resume: errorName(memCrash) === "EmptyInputError",
    control_fake_resume_replays_from_input:
      total(fakeResume, "seed", "enter") === 2 &&
      (chainShape(fakeResume?.run.final.checkpoints ?? []).sources.input ?? 0) === 2,
    // The tautology, demonstrated rather than argued. A terminal-output
    // assertion — "the run finished" — is satisfied identically by a genuine
    // resume and by a full replay from the original input.
    control_terminal_output_cannot_detect_replay:
      (stateOf(fakeResume) as { done?: string }).done === "finished" &&
      (stateOf(seqGolden) as { done?: string }).done === "finished" &&
      total(fakeResume, "seed", "enter") === 2 &&
      total(seqGolden, "seed", "enter") === 1,
    control_checkpoint_id_disables_reuse: total(ckptIdResume, "fast", "enter") === 2,
    control_deleted_writes_force_rerun:
      total(deletedWrites, "fast", "enter") === 2 &&
      ((deletedWrites?.mutate?.removed as number | undefined) ?? 0) > 0,
    control_sigterm_is_a_graceful_exit:
      eventsOf(sigterm).some(
        (event) => event.node === "process" && event.phase === "graceful-sigterm",
      ) && sigterm?.kill?.waitExit !== 137,
    control_same_process_resume_shares_a_nonce:
      (noncesByStage(eventsOf(intGolden)).control ?? []).length === 1,
    // `Command({ resume: false })` is not a rejection on the pinned release. It
    // is refused at the invoke boundary with EmptyInputError and the thread
    // stays paused; asserting the error NAME means a release that moves the
    // rejection point fails loudly instead of drifting under the same prose.
    control_resume_false_does_not_resume:
      errorName(intFalse) === "EmptyInputError" && pendingInterruptsAtHead(intFalse) > 0,
  };

  const managed = bundles
    .slice()
    .sort((left, right) => left.case.localeCompare(right.case))
    .map((bundle) => ({
      case: bundle.case,
      stage: bundle.run.stage,
      finalState: JSON.parse(stable(stateOf(bundle))),
      interrupted: bundle.run.invoke?.interrupted ?? null,
      errorName: errorName(bundle),
      gate: bundle.run.gate
        ? {
            durability: bundle.run.gate.durability,
            secondStartedWhileHeld: bundle.run.gate.secondStartedWhileHeld,
          }
        : null,
      kill: bundle.kill
        ? {
            signal: bundle.kill.signal,
            waitExit: bundle.kill.waitExit,
            status: bundle.kill.status,
            oomKilled: bundle.kill.oomKilled,
          }
        : null,
      backends: bundle.backends?.count ?? null,
      canonical: canonicaliseProjection(bundle.run.final),
    }));

  return {
    command: "summarize",
    cases: bundles.map((bundle) => bundle.case),
    managed_digest: digest(managed),
    managed,
    acceptance,
    outcome: outcomeFor(acceptance),
  };
}
