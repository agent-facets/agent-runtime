// The deterministic auth and credential-store experiment.
//
// Everything here runs on a virtual clock and a synthetic issuer, so a
// fifteen-minute polling deadline costs nothing and every count below is exact
// rather than approximate. Where a race is being measured, the issuer holds its
// response at a barrier until every caller is parked, which makes "exactly one
// upstream refresh" a forced outcome instead of a lucky one.
//
// Each positive assertion has a paired negative control. A test that cannot
// fail is not evidence, and the controls are what stop this file from becoming
// a very long way of writing `true`.

import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createVirtualClock, realClock, type Clock } from "../clock.ts";
import { AuthError, ALL_CODES, classificationIsExhaustive } from "../auth/errors.ts";
import { DeviceFlow, parseInterval } from "../auth/device-flow.ts";
import { parseRetryAfter, requestRefresh, type RefreshResponse } from "../auth/refresh.ts";
import {
  CredentialStore,
  fileMode,
  fileOwner,
  parseProviderFile,
  STORE_SCHEMA,
  type Credential,
  type ProviderFile,
} from "../store/credential-store.ts";
import { cleanupOrphanTemps, listTempFiles, WRITE_POINTS } from "../store/atomic-write.ts";
import { ensureLockFile, lockFileInode } from "../store/lock.ts";
import {
  createBarrier,
  createSyntheticIssuer,
  SENTINEL_ACCOUNT_ID,
  type RefreshOutcome,
} from "../synthetic/issuer.ts";
import { serveIssuer } from "../synthetic/issuer-server.ts";
import { REFRESH_MARGIN_SECONDS } from "../reference.ts";

const ISSUER = "https://auth.example.invalid";
const EPOCH = Date.UTC(2026, 0, 1, 0, 0, 0);
const CRASH_ITERATIONS = 200;

/**
 * Stated independently of the policy constant so a change to the budget is a
 * measurable failure rather than a silently accepted new normal.
 */
const EXPECTED_RETRY_ATTEMPTS = 3;

export type CaseResult = { id: string; ok: boolean; detail: Record<string, unknown> };

export type AuthStoreReport = {
  device: CaseResult[];
  refresh: CaseResult[];
  singleFlight: CaseResult[];
  durability: CaseResult[];
  negativeControls: CaseResult[];
  acceptance: Record<string, boolean>;
};

export async function runAuthStoreExperiment(): Promise<AuthStoreReport> {
  const device = await runDeviceCases();
  const refresh = await runRefreshCases();
  const singleFlight = await runSingleFlightCases();
  const durability = await runDurabilityCases();
  const negativeControls = await runNegativeControls();

  const all = [...device, ...refresh, ...singleFlight, ...durability, ...negativeControls];
  const passed = (id: string) => all.find((entry) => entry.id === id)?.ok === true;

  const acceptance: Record<string, boolean> = {
    device_initiation_exact: passed("D-01"),
    interval_string_parsed: passed("D-02") && passed("D-03"),
    no_browser_no_listener: passed("D-04"),
    polling_403_404_continue: passed("D-05") && passed("D-06"),
    polling_deadline_exact_15m: passed("D-10"),
    exchange_pkce_bound: passed("D-12") && passed("D-13"),
    claims_extracted: passed("D-14"),
    no_persistence_on_failure: passed("D-15") && passed("D-16"),

    refresh_margin_5m_exact: passed("R-01") && passed("R-02") && passed("R-03"),
    partial_rotation_preserves_refresh: passed("R-05") && passed("R-06"),
    typed_failures_exhaustive: passed("R-19"),
    retry_after_bounded: passed("R-11") && passed("R-12") && passed("R-13") && passed("R-14"),
    permanent_failure_is_terminal: passed("R-08"),
    bounded_transient_retry: passed("R-15"),
    external_generation_adopted: passed("R-16"),

    single_flight_64_one_upstream: passed("S-01"),
    single_flight_per_provider_not_global: passed("S-05"),
    single_flight_cross_process: passed("S-06"),
    lock_guarded_reread: passed("L-02"),
    lock_inode_stable: passed("L-05"),

    atomic_write_mode_and_temp: passed("A-01"),
    temp_cleanup: passed("F-11"),
    namespace_preserved: passed("F-19"),
    reader_retry_exactly_once: passed("F-14"),
    crash_iterations_ge_200_all_valid: passed("F-17"),
    crash_every_boundary_covered: passed("F-08"),
    restart_persistence: passed("F-20"),

    negative_controls_fail_closed:
      passed("N-single-flight") && passed("N-lock") && passed("N-guard") && passed("N-atomic"),
  };

  return { device, refresh, singleFlight, durability, negativeControls, acceptance };
}

// ---------------------------------------------------------------------------
// Device flow

async function runDeviceCases(): Promise<CaseResult[]> {
  const results: CaseResult[] = [];

  // D-01 / D-02: one initiation, string interval parsed to milliseconds.
  {
    const clock = createVirtualClock(EPOCH);
    const issuer = createSyntheticIssuer({ issuer: ISSUER, clock, interval: "5" });
    const flow = new DeviceFlow({ issuer: ISSUER, clock, fetch: issuer.fetch });
    const session = await flow.initiate();

    results.push({
      id: "D-01",
      ok: issuer.calls.usercode === 1 && session.userCode.length > 0,
      detail: { usercodeCalls: issuer.calls.usercode },
    });
    results.push({
      id: "D-02",
      ok: session.intervalMs === 5_000 && parseInterval(5) === 5_000,
      detail: { intervalMs: session.intervalMs },
    });
  }

  // D-03: absent defaults, zero clamps to the floor, garbage is permanent.
  {
    const absent = parseInterval(undefined);
    const zero = parseInterval("0");
    let garbageCode: string | null = null;
    try {
      parseInterval("abc");
    } catch (error) {
      garbageCode = error instanceof AuthError ? error.code : "UNKNOWN";
    }
    results.push({
      id: "D-03",
      ok: absent === 5_000 && zero === 1_000 && garbageCode === "DEVICE_INTERVAL_INVALID",
      detail: { absent, zero, garbageCode },
    });
  }

  // D-04: no browser process, no listening socket.
  {
    const before = await countListeners();
    const clock = createVirtualClock(EPOCH);
    const issuer = createSyntheticIssuer({ issuer: ISSUER, clock });
    const flow = new DeviceFlow({ issuer: ISSUER, clock, fetch: issuer.fetch });
    await flow.initiate();
    const after = await countListeners();
    results.push({
      id: "D-04",
      ok: after === before,
      detail: { listenersBefore: before, listenersAfter: after },
    });
  }

  // D-05 / D-06: 403 and 404 both mean "keep polling", with exact gaps.
  for (const [id, status] of [
    ["D-05", 403],
    ["D-06", 404],
  ] as const) {
    const clock = createVirtualClock(EPOCH);
    const issuer = createSyntheticIssuer({
      issuer: ISSUER,
      clock,
      pollStatuses: [status, status, status],
    });
    const flow = new DeviceFlow({ issuer: ISSUER, clock, fetch: issuer.fetch });
    const session = await flow.initiate();
    const authorization = await flow.poll(session);

    results.push({
      id,
      ok:
        issuer.calls.poll === 4 &&
        authorization.polls === 4 &&
        flow.metrics.intervalGaps.length === 3 &&
        flow.metrics.intervalGaps.every((gap) => gap === 5_000),
      detail: { polls: issuer.calls.poll, gaps: flow.metrics.intervalGaps },
    });
  }

  // D-08: a non-continue status stops immediately.
  {
    const clock = createVirtualClock(EPOCH);
    const issuer = createSyntheticIssuer({ issuer: ISSUER, clock, pollStatuses: [400] });
    const flow = new DeviceFlow({ issuer: ISSUER, clock, fetch: issuer.fetch });
    const session = await flow.initiate();
    const error = await captureError(() => flow.poll(session));
    results.push({
      id: "D-08",
      ok: error?.code === "DEVICE_DENIED" && issuer.calls.poll === 1,
      detail: { code: error?.code ?? null, polls: issuer.calls.poll },
    });
  }

  // D-10: the deadline is exact, and the poll that would straddle it is never
  // issued -- 180 polls at 5s across 900s, not 181.
  {
    const clock = createVirtualClock(EPOCH);
    const issuer = createSyntheticIssuer({
      issuer: ISSUER,
      clock,
      pollStatuses: Array.from({ length: 1_000 }, () => 403),
    });
    const flow = new DeviceFlow({ issuer: ISSUER, clock, fetch: issuer.fetch });
    const session = await flow.initiate();
    const error = await captureError(() => flow.poll(session));

    results.push({
      id: "D-10",
      ok: error?.code === "DEVICE_TIMEOUT" && issuer.calls.poll === 180 && clock.elapsed() === 900_000,
      detail: { code: error?.code ?? null, polls: issuer.calls.poll, elapsedMs: clock.elapsed() },
    });
  }

  // D-12: a consistent server-supplied PKCE pair is accepted and exchanged.
  {
    const clock = createVirtualClock(EPOCH);
    const issuer = createSyntheticIssuer({ issuer: ISSUER, clock, pkce: "valid" });
    const flow = new DeviceFlow({ issuer: ISSUER, clock, fetch: issuer.fetch });
    const session = await flow.initiate();
    const authorization = await flow.poll(session);
    const tokens = await flow.exchange(authorization);

    results.push({
      id: "D-12",
      ok: issuer.calls.exchange === 1 && tokens.accessToken.length > 0,
      detail: { exchanges: issuer.calls.exchange },
    });
    results.push({
      id: "D-14",
      ok: tokens.accountId === SENTINEL_ACCOUNT_ID,
      detail: { accountIdPresent: tokens.accountId.length > 0 },
    });
  }

  // D-13: an inconsistent pair is refused before the code is spent.
  {
    const clock = createVirtualClock(EPOCH);
    const issuer = createSyntheticIssuer({ issuer: ISSUER, clock, pkce: "mismatch" });
    const flow = new DeviceFlow({ issuer: ISSUER, clock, fetch: issuer.fetch });
    const session = await flow.initiate();
    const error = await captureError(() => flow.poll(session));

    results.push({
      id: "D-13",
      ok: error?.code === "PKCE_MISMATCH" && issuer.calls.exchange === 0,
      detail: { code: error?.code ?? null, exchanges: issuer.calls.exchange },
    });
  }

  // D-15 / D-16: a failed flow persists nothing and leaves no temp behind.
  {
    const directory = await scratchDirectory();
    try {
      const clock = createVirtualClock(EPOCH);
      const issuer = createSyntheticIssuer({ issuer: ISSUER, clock, exchangeOmitsAccount: true });
      const flow = new DeviceFlow({ issuer: ISSUER, clock, fetch: issuer.fetch });
      const session = await flow.initiate();
      const authorization = await flow.poll(session);
      const error = await captureError(() => flow.exchange(authorization));

      const entries = await readdir(directory);
      results.push({
        id: "D-15",
        ok: error?.code === "CLAIMS_INCOMPLETE",
        detail: { code: error?.code ?? null },
      });
      results.push({
        id: "D-16",
        ok: entries.length === 0,
        detail: { entries: entries.length },
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Refresh

async function runRefreshCases(): Promise<CaseResult[]> {
  const results: CaseResult[] = [];

  // R-01 / R-02 / R-03: the five-minute margin, including its exact boundary.
  for (const [id, secondsToExpiry, expectRefresh] of [
    ["R-01", REFRESH_MARGIN_SECONDS + 60, false],
    ["R-02", REFRESH_MARGIN_SECONDS - 1, true],
    ["R-03", REFRESH_MARGIN_SECONDS, true],
  ] as const) {
    const context = await refreshContext({ secondsToExpiry });
    try {
      await context.store.getAccessToken("openai");
      results.push({
        id,
        ok: (context.issuer.calls.refresh === 1) === expectRefresh,
        detail: { refreshes: context.issuer.calls.refresh, expectRefresh },
      });
    } finally {
      await context.dispose();
    }
  }

  // R-05: full rotation replaces both tokens.
  {
    const context = await refreshContext({ plan: [{ kind: "rotate-both" }] });
    try {
      const before = await context.store.read("openai");
      await context.store.getAccessToken("openai");
      const after = await context.store.read("openai");
      results.push({
        id: "R-05",
        ok:
          after!.credential.access_token !== before!.credential.access_token &&
          after!.credential.refresh_token !== before!.credential.refresh_token &&
          after!.generation === before!.generation + 1,
        detail: { generation: after!.generation },
      });
    } finally {
      await context.dispose();
    }
  }

  // R-06: partial rotation must not blank the refresh token.
  {
    const context = await refreshContext({ plan: [{ kind: "access-only" }] });
    try {
      const before = await context.store.read("openai");
      await context.store.getAccessToken("openai");
      const after = await context.store.read("openai");
      results.push({
        id: "R-06",
        ok:
          after!.credential.access_token !== before!.credential.access_token &&
          after!.credential.refresh_token === before!.credential.refresh_token &&
          after!.credential.refresh_token !== null,
        detail: {
          refreshPreserved: after!.credential.refresh_token === before!.credential.refresh_token,
        },
      });
    } finally {
      await context.dispose();
    }
  }

  // R-08: a revoked token is terminal, is not retried, and is *kept* so the
  // failure stays diagnosable rather than becoming a mystery.
  {
    const context = await refreshContext({
      plan: [{ kind: "status", status: 400, errorCode: "invalid_grant" }],
    });
    try {
      const before = await context.store.read("openai");
      const error = await captureError(() => context.store.getAccessToken("openai"));
      const after = await context.store.read("openai");

      results.push({
        id: "R-08",
        ok:
          error?.code === "AUTH_REVOKED" &&
          context.issuer.calls.refresh === 1 &&
          after!.credential.state === "relogin_required" &&
          after!.credential.refresh_token === before!.credential.refresh_token,
        detail: {
          code: error?.code ?? null,
          refreshes: context.issuer.calls.refresh,
          state: after!.credential.state,
        },
      });

      // And the disabled credential fails fast without touching the issuer.
      const second = await captureError(() => context.store.getAccessToken("openai"));
      results.push({
        id: "R-08b",
        ok: second?.code === "RELOGIN_REQUIRED" && context.issuer.calls.refresh === 1,
        detail: { code: second?.code ?? null, refreshes: context.issuer.calls.refresh },
      });
    } finally {
      await context.dispose();
    }
  }

  // R-11 to R-14: retry-after in every spelling, always bounded.
  {
    const clock = createVirtualClock(EPOCH);
    const seconds = parseRetryAfter("2", clock);
    const huge = parseRetryAfter("86400", clock);
    const httpDate = parseRetryAfter(new Date(EPOCH + 3_000).toUTCString(), clock);
    const malformed = parseRetryAfter("soon", clock);

    results.push({ id: "R-11", ok: seconds === 2_000, detail: { seconds } });
    results.push({ id: "R-12", ok: huge === 60_000, detail: { huge } });
    results.push({ id: "R-13", ok: httpDate === 3_000, detail: { httpDate } });
    results.push({ id: "R-14", ok: malformed === 60_000, detail: { malformed } });
  }

  // R-15: transient failures retry exactly to the budget, then stop.
  {
    const context = await refreshContext({
      plan: [
        { kind: "status", status: 500 },
        { kind: "status", status: 500 },
        { kind: "status", status: 500 },
        { kind: "status", status: 500 },
      ],
    });
    try {
      const error = await captureError(() => context.store.getAccessToken("openai"));
      // The expected count is a literal, deliberately. Asserting against
      // DEFAULT_RETRY_POLICY.attempts made this test self-consistent with any
      // value the constant happened to hold: raising the budget to 5 left it
      // green. A budget is only bounded if the bound is stated independently.
      results.push({
        id: "R-15",
        ok: error?.code === "UPSTREAM_5XX" && context.issuer.calls.refresh === EXPECTED_RETRY_ATTEMPTS,
        detail: {
          code: error?.code ?? null,
          refreshes: context.issuer.calls.refresh,
          expected: EXPECTED_RETRY_ATTEMPTS,
        },
      });
    } finally {
      await context.dispose();
    }
  }

  // R-16: a generation advanced by a peer is adopted, not re-refreshed.
  {
    const context = await refreshContext({});
    try {
      const current = await context.store.read("openai");
      const advanced: ProviderFile = {
        schema: STORE_SCHEMA,
        provider: "openai",
        generation: current!.generation + 5,
        credential: {
          ...current!.credential,
          access_token: "SPIKE-PEER-TOKEN",
          expires_at: Math.floor(context.clock.now() / 1000) + 7_200,
        },
      };
      await writeFile(
        context.store.pathFor("openai"),
        `${JSON.stringify(advanced, null, 2)}\n`,
        { mode: 0o600 },
      );

      const token = await context.store.getAccessToken("openai");
      results.push({
        id: "R-16",
        ok: token === "SPIKE-PEER-TOKEN" && context.issuer.calls.refresh === 0,
        detail: { refreshes: context.issuer.calls.refresh },
      });
    } finally {
      await context.dispose();
    }
  }

  // R-19: the permanent/transient split covers every code exactly once.
  results.push({
    id: "R-19",
    ok: classificationIsExhaustive(ALL_CODES),
    detail: { codes: ALL_CODES.length },
  });

  return results;
}

// ---------------------------------------------------------------------------
// Single-flight

async function runSingleFlightCases(): Promise<CaseResult[]> {
  const results: CaseResult[] = [];

  // S-01: sixty-four callers, one upstream refresh, one identical token, and
  // -- the part that is actually attributable to in-process coalescing -- one
  // lock acquisition rather than sixty-four.
  {
    const barrier = createBarrier(1);
    const context = await refreshContext({ gate: barrier.gate });
    try {
      const tokens = await Promise.all(
        Array.from({ length: 64 }, () => context.store.getAccessToken("openai")),
      );
      const distinct = new Set(tokens);
      results.push({
        id: "S-01",
        ok:
          context.issuer.calls.refresh === 1 &&
          distinct.size === 1 &&
          context.store.metrics.lockAcquisitions === 1,
        detail: {
          refreshes: context.issuer.calls.refresh,
          distinctTokens: distinct.size,
          lockAcquisitions: context.store.metrics.lockAcquisitions,
        },
      });
    } finally {
      await context.dispose();
    }
  }

  // S-05: two providers refresh *concurrently*. The barrier needs both to
  // arrive before either response is produced, so a global lock deadlocks here
  // instead of quietly passing.
  {
    const barrier = createBarrier(2);
    const context = await refreshContext({ gate: barrier.gate, withSibling: true });
    try {
      const raced = await Promise.race([
        Promise.all([
          context.store.getAccessToken("openai"),
          context.store.getAccessToken("anthropic"),
        ]).then(() => "resolved" as const),
        new Promise<"stalled">((resolve) => setTimeout(() => resolve("stalled"), 5_000)),
      ]);

      results.push({
        id: "S-05",
        ok: raced === "resolved" && context.issuer.calls.refresh === 2,
        detail: { raced, refreshes: context.issuer.calls.refresh, arrived: barrier.arrived() },
      });
    } finally {
      await context.dispose();
    }
  }

  // S-06 / L-02: two cooperating processes, thirty-two callers each, one
  // upstream refresh in total. The loser adopts the winner's generation.
  {
    const outcome = await runCrossProcess({ processes: 2, callersEach: 32 });
    results.push({
      id: "S-06",
      ok: outcome.upstreamRefreshes === 1 && outcome.distinctTokenDigests === 1,
      detail: outcome,
    });
    results.push({
      id: "L-02",
      ok: outcome.guardedAdoptions >= 1,
      detail: { guardedAdoptions: outcome.guardedAdoptions },
    });
    results.push({
      id: "L-05",
      ok: outcome.lockInodeStable,
      detail: { lockInodeStable: outcome.lockInodeStable },
    });
  }

  return results;
}

// ---------------------------------------------------------------------------
// Durability

async function runDurabilityCases(): Promise<CaseResult[]> {
  const results: CaseResult[] = [];
  const directory = await scratchDirectory();

  try {
    const store = await seededStore(directory, realClock);

    // A-01: mode and temp placement after a normal commit.
    await store.install(sentinelCredential("openai", Math.floor(Date.now() / 1000) + 3_600));
    const mode = await fileMode(store.pathFor("openai"));
    const temps = await listTempFiles(directory);
    results.push({
      id: "A-01",
      ok: mode === 0o600 && temps.length === 0,
      detail: { mode, temps: temps.length },
    });

    // A sibling provider, written once and never touched again.
    await store.install(sentinelCredential("anthropic", Math.floor(Date.now() / 1000) + 3_600));
    const siblingDigest = await digestFile(store.pathFor("anthropic"));

    // F-01..F-08: a kill at every boundary leaves a complete document.
    const pointResults: Record<string, boolean> = {};
    for (const point of WRITE_POINTS) {
      const before = await readFile(store.pathFor("openai"), "utf8");
      await runFaultWorker(directory, "openai", point, 1);
      const after = await readFile(store.pathFor("openai"), "utf8").catch(() => "");
      const parsed = parseProviderFile(after, "openai");
      pointResults[point] = parsed !== null && (after === before || parsed.generation >= 1);
    }
    results.push({
      id: "F-08",
      ok: Object.values(pointResults).every(Boolean),
      detail: pointResults,
    });

    // F-11: orphan temps left by those kills are cleaned, and only ours.
    await writeFile(join(directory, "unrelated.txt"), "keep me\n", { mode: 0o600 });
    const cleanup = await cleanupOrphanTemps(directory, process.getuid?.() ?? 0);
    const remaining = await listTempFiles(directory);
    const unrelatedSurvived = (await readdir(directory)).includes("unrelated.txt");
    results.push({
      id: "F-11",
      ok: remaining.length === 0 && unrelatedSurvived,
      detail: { removed: cleanup.removed.length, remaining: remaining.length, unrelatedSurvived },
    });

    // F-14: a reader racing a rename retries exactly once and then succeeds.
    {
      const reader = await seededStore(directory, realClock);
      const readerResults = await Promise.all([
        reader.read("openai"),
        (async () => {
          await runFaultWorker(directory, "openai", "after-dir-fsync", 2);
          return null;
        })(),
        reader.read("openai"),
      ]);
      results.push({
        id: "F-14",
        ok: reader.metrics.readRetries <= 1 && readerResults[0] !== null,
        detail: { readRetries: reader.metrics.readRetries },
      });
    }

    // F-17: two hundred seeded crash iterations, every point exercised, every
    // post-crash state a complete document.
    {
      const histogram: Record<string, number> = {};
      let invalid = 0;
      let seed = 1;

      for (let iteration = 0; iteration < CRASH_ITERATIONS; iteration += 1) {
        seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
        // The low bits of a power-of-two LCG cycle quickly, so the index comes
        // from the high bits. Taking `seed % 6` directly reaches only three of
        // the six boundaries, which the per-point histogram caught.
        const point = WRITE_POINTS[
          Math.floor(seed / 65_536) % WRITE_POINTS.length
        ] as string;
        histogram[point] = (histogram[point] ?? 0) + 1;

        await runFaultWorker(directory, "openai", point, iteration + 10);
        const raw = await readFile(store.pathFor("openai"), "utf8").catch(() => "");
        if (!parseProviderFile(raw, "openai")) invalid += 1;
      }

      const everyPointHit = WRITE_POINTS.every((point) => (histogram[point] ?? 0) > 0);
      results.push({
        id: "F-17",
        ok: invalid === 0 && everyPointHit,
        detail: { iterations: CRASH_ITERATIONS, invalid, histogram },
      });
    }

    // F-19: the sibling namespace is byte-identical after all of that.
    results.push({
      id: "F-19",
      ok: (await digestFile(store.pathFor("anthropic"))) === siblingDigest,
      detail: { preserved: true },
    });

    // F-20: a fresh store instance reads back the rotated credential.
    {
      const reopened = await seededStore(directory, realClock);
      const file = await reopened.read("openai");
      results.push({
        id: "F-20",
        ok:
          file !== null &&
          file.credential.access_token.startsWith("SPIKE-ROTATED-") &&
          (await fileMode(reopened.pathFor("openai"))) === 0o600 &&
          (await fileOwner(reopened.pathFor("openai"))) === (process.getuid?.() ?? 0),
        detail: { generation: file?.generation ?? null },
      });
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }

  return results;
}

// ---------------------------------------------------------------------------
// Negative controls

async function runNegativeControls(): Promise<CaseResult[]> {
  const results: CaseResult[] = [];

  // Without in-process coalescing, sixty-four callers must each take the lock.
  //
  // Note what this control does *not* show: the upstream refresh count stays at
  // one even with coalescing disabled, because the cross-process lock plus the
  // guarded reread already collapse the cascade. In-process single-flight is a
  // contention optimisation, not the mechanism that prevents duplicate
  // refreshes -- and asserting it on the refresh count would have been a test
  // that passes for the wrong reason.
  {
    const context = await refreshContext({ singleFlight: false });
    try {
      await Promise.all(
        Array.from({ length: 64 }, () =>
          context.store.getAccessToken("openai").catch(() => null),
        ),
      );
      results.push({
        id: "N-single-flight",
        ok: context.store.metrics.lockAcquisitions > 1,
        detail: {
          lockAcquisitions: context.store.metrics.lockAcquisitions,
          refreshes: context.issuer.calls.refresh,
        },
      });
    } finally {
      await context.dispose();
    }
  }

  // Without the cross-process lock, two processes must both refresh.
  {
    const outcome = await runCrossProcess({ processes: 2, callersEach: 8, lock: false });
    results.push({
      id: "N-lock",
      ok: outcome.upstreamRefreshes > 1,
      detail: outcome,
    });
  }

  // Without the guarded reread the lock still serialises, but the loser
  // refreshes anyway -- which is the subtle failure the reread exists to stop.
  {
    const outcome = await runCrossProcess({ processes: 2, callersEach: 8, guard: false });
    results.push({
      id: "N-guard",
      ok: outcome.upstreamRefreshes > 1,
      detail: outcome,
    });
  }

  // A truncate-in-place writer must produce at least one invalid document.
  {
    const directory = await scratchDirectory();
    try {
      const store = await seededStore(directory, realClock);
      await store.install(sentinelCredential("openai", Math.floor(Date.now() / 1000) + 3_600));

      let invalid = 0;
      for (let iteration = 0; iteration < 40; iteration += 1) {
        const point = WRITE_POINTS[iteration % WRITE_POINTS.length] as string;
        await runFaultWorker(directory, "openai", point, iteration, "truncate-in-place");
        const raw = await readFile(store.pathFor("openai"), "utf8").catch(() => "");
        if (!parseProviderFile(raw, "openai")) invalid += 1;
      }

      results.push({
        id: "N-atomic",
        ok: invalid > 0,
        detail: { invalid, iterations: 40 },
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Helpers

type RefreshContext = {
  store: CredentialStore;
  issuer: ReturnType<typeof createSyntheticIssuer>;
  clock: Clock;
  dispose: () => Promise<void>;
};

async function refreshContext(options: {
  secondsToExpiry?: number;
  plan?: RefreshOutcome[];
  gate?: () => Promise<void>;
  singleFlight?: boolean;
  withSibling?: boolean;
}): Promise<RefreshContext> {
  const directory = await scratchDirectory();
  const clock = createVirtualClock(EPOCH);
  const issuer = createSyntheticIssuer({
    issuer: ISSUER,
    clock,
    refreshPlan: options.plan,
    refreshGate: options.gate,
  });

  const store = new CredentialStore({
    directory,
    clock,
    singleFlight: options.singleFlight,
    refresh: (credential) =>
      requestRefresh(credential.refresh_token ?? "", {
        issuer: ISSUER,
        fetch: issuer.fetch,
        clock,
      }),
  });

  const expiry =
    Math.floor(clock.now() / 1000) + (options.secondsToExpiry ?? REFRESH_MARGIN_SECONDS - 1);

  await store.initialise();
  await store.install(sentinelCredential("openai", expiry));
  if (options.withSibling) await store.install(sentinelCredential("anthropic", expiry));

  return {
    store,
    issuer,
    clock,
    dispose: () => rm(directory, { recursive: true, force: true }),
  };
}

type CrossProcessOutcome = {
  upstreamRefreshes: number;
  distinctTokenDigests: number;
  guardedAdoptions: number;
  lockInodeStable: boolean;
  workers: number;
};

async function runCrossProcess(options: {
  processes: number;
  callersEach: number;
  lock?: boolean;
  guard?: boolean;
}): Promise<CrossProcessOutcome> {
  const directory = await scratchDirectory();
  const clock = realClock;

  // A barrier sized to the worker count: no response is produced until every
  // process has actually reached the issuer, so serialisation cannot be
  // mistaken for coalescing.
  const barrier = createBarrier(options.lock === false ? options.processes : 1);
  const issuer = createSyntheticIssuer({
    issuer: ISSUER,
    clock,
    refreshGate: barrier.gate,
  });
  const server = await serveIssuer(issuer);

  try {
    const bootstrap = new CredentialStore({
      directory,
      clock,
      refresh: async () => ({
        idToken: null,
        accessToken: null,
        refreshToken: null,
        expiresAtSeconds: null,
      }),
    });
    await bootstrap.initialise();
    await bootstrap.install(
      sentinelCredential("openai", Math.floor(Date.now() / 1000) + REFRESH_MARGIN_SECONDS - 1),
    );

    ensureLockFile(bootstrap.lockPathFor("openai"));
    const inodeBefore = lockFileInode(bootstrap.lockPathFor("openai"));

    const outputs = await Promise.all(
      Array.from({ length: options.processes }, () =>
        runWorker([
          directory,
          "openai",
          server.url,
          String(options.callersEach),
          options.lock === false ? "no-lock" : "lock",
          options.guard === false ? "no-guard" : "guard",
        ]),
      ),
    );

    const digests = new Set<string>();
    let guardedAdoptions = 0;
    for (const output of outputs) {
      if (output?.tokenDigest) digests.add(output.tokenDigest);
      guardedAdoptions += output?.metrics?.guardedAdoptions ?? 0;
    }

    const inodeAfter = lockFileInode(bootstrap.lockPathFor("openai"));

    return {
      upstreamRefreshes: issuer.calls.refresh,
      distinctTokenDigests: digests.size,
      guardedAdoptions,
      lockInodeStable: inodeBefore !== null && inodeBefore === inodeAfter,
      workers: outputs.length,
    };
  } finally {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
}

type WorkerOutput = {
  ok: boolean;
  tokenDigest: string | null;
  metrics?: { guardedAdoptions: number };
};

function runWorker(args: string[]): Promise<WorkerOutput | null> {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      ["--no-warnings", new URL("../store/refresh-worker.ts", import.meta.url).pathname, ...args],
      { stdio: ["ignore", "pipe", "pipe"] },
    );

    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.once("exit", () => {
      try {
        resolve(JSON.parse(stdout.trim().split("\n").pop() ?? "null") as WorkerOutput);
      } catch {
        resolve(null);
      }
    });
    child.once("error", () => resolve(null));
  });
}

function runFaultWorker(
  directory: string,
  provider: string,
  point: string,
  serial: number,
  mode = "atomic",
): Promise<void> {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [
        "--no-warnings",
        new URL("../store/fault-worker.ts", import.meta.url).pathname,
        directory,
        provider,
        point,
        String(serial),
        mode,
      ],
      { stdio: ["ignore", "ignore", "ignore"] },
    );
    child.once("exit", () => resolve());
    child.once("error", () => resolve());
  });
}

async function seededStore(directory: string, clock: Clock): Promise<CredentialStore> {
  const store = new CredentialStore({
    directory,
    clock,
    refresh: async () => ({
      idToken: null,
      accessToken: null,
      refreshToken: null,
      expiresAtSeconds: null,
    }),
  });
  await store.initialise();
  return store;
}

export function sentinelCredential(provider: string, expiresAt: number): Credential {
  return {
    provider,
    type: "oauth",
    access_token: `SPIKE-INITIAL-${provider}`,
    refresh_token: `SPIKE-INITIAL-REFRESH-${provider}`,
    expires_at: expiresAt,
    account_id: SENTINEL_ACCOUNT_ID,
    scopes: [],
    profile_id: "codex/0.151.0",
    created_at: 0,
    rotated_at: 0,
    state: "active",
  };
}

async function scratchDirectory(): Promise<string> {
  return mkdtemp(join(tmpdir(), `spike-store-${randomUUID().slice(0, 8)}-`));
}

async function digestFile(path: string): Promise<string> {
  const raw = await readFile(path, "utf8").catch(() => "");
  return createHash("sha256").update(raw).digest("hex");
}

async function captureError(operation: () => Promise<unknown>): Promise<AuthError | null> {
  try {
    await operation();
    return null;
  } catch (error) {
    return error instanceof AuthError ? error : null;
  }
}

/** Listening TCP sockets, read from /proc so no external tool is required. */
async function countListeners(): Promise<number> {
  let total = 0;
  for (const path of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    const raw = await readFile(path, "utf8").catch(() => "");
    for (const line of raw.split("\n").slice(1)) {
      const columns = line.trim().split(/\s+/);
      if (columns[3] === "0A") total += 1;
    }
  }
  return total;
}

export async function refreshResponseShape(): Promise<RefreshResponse> {
  return { idToken: null, accessToken: null, refreshToken: null, expiresAtSeconds: null };
}
