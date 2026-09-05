// Model profiles and the spend ledger.
//
// Both profiles are transports this repository has already measured live. No
// third model, no fallback transport, no API-key billing path: an unavailable
// model stops the run rather than silently changing the matrix, because a matrix
// that repaired itself mid-run would not be the one that was approved.
//
// The ledger is durable and incremented BEFORE dispatch. That closes the gap the
// OpenAI spike accepted and recorded — a re-run after a partial failure could
// otherwise spend twice — which stops being tolerable at Stage 2's volume.

export type ModelClass = "anthropic" | "openai";

export type ModelProfile = {
  modelId: string;
  provider: ModelClass;
  transport: "subscription";
  /** Anthropic caps output directly. OpenAI cannot: the reference profile requires the field absent. */
  maxOutputTokens: number | null;
  /** OpenAI's substitute bound, since it has no output cap. */
  streamByteCeiling: number | null;
  wallClockMs: number;
  /** Omitted deliberately: stochasticity is measured, not hidden behind a seed. */
  temperature: null;
};

export const MODEL_PROFILES: readonly ModelProfile[] = Object.freeze([
  Object.freeze({
    modelId: "claude-opus-5",
    provider: "anthropic" as const,
    transport: "subscription" as const,
    maxOutputTokens: 512,
    streamByteCeiling: null,
    wallClockMs: 120_000,
    temperature: null,
  }),
  Object.freeze({
    modelId: "gpt-5.6-sol",
    provider: "openai" as const,
    transport: "subscription" as const,
    maxOutputTokens: null,
    streamByteCeiling: 16 * 1024,
    wallClockMs: 120_000,
    temperature: null,
  }),
]);

// ---------------------------------------------------------------------------
// Ceilings
// ---------------------------------------------------------------------------

export const CEILINGS = Object.freeze({
  subjectRequests: 390,
  calibrationRequests: 48,
  judgeRequests: 78,
  transportRetries: 20,
  totalDispatches: 536,
  totalProviderTokens: 4_000_000,
  maxConcurrent: 4,
  maxConcurrentPerProvider: 2,
  maxPromptNeutralTokens: 6000,
});

export type DispatchKind = "subject" | "calibration" | "judge" | "retry";

export type LedgerEntry = {
  sequence: number;
  kind: DispatchKind;
  modelId: string;
  /** Recorded before the request leaves, so a crash cannot hide a spend. */
  committedAt: string;
  promptDigest: string;
  inputTokens: number | null;
  outputTokens: number | null;
};

export type LedgerState = {
  entries: LedgerEntry[];
  byKind: Record<DispatchKind, number>;
  providerTokens: number;
};

export function emptyLedger(): LedgerState {
  return {
    entries: [],
    byKind: { subject: 0, calibration: 0, judge: 0, retry: 0 },
    providerTokens: 0,
  };
}

export type LedgerVerdict = { allowed: boolean; reason: string | null };

/**
 * The pre-dispatch gate.
 *
 * Checked against the DURABLE ledger, not an in-process counter, so a re-run
 * after a partial failure cannot spend the same budget twice.
 */
export function mayDispatch(ledger: LedgerState, kind: DispatchKind): LedgerVerdict {
  const limits: Record<DispatchKind, number> = {
    subject: CEILINGS.subjectRequests,
    calibration: CEILINGS.calibrationRequests,
    judge: CEILINGS.judgeRequests,
    retry: CEILINGS.transportRetries,
  };

  if (ledger.byKind[kind] >= limits[kind]) {
    return { allowed: false, reason: `${kind} ceiling ${limits[kind]} reached` };
  }
  if (ledger.entries.length >= CEILINGS.totalDispatches) {
    return { allowed: false, reason: `total dispatch ceiling ${CEILINGS.totalDispatches} reached` };
  }
  if (ledger.providerTokens >= CEILINGS.totalProviderTokens) {
    return { allowed: false, reason: `token ceiling ${CEILINGS.totalProviderTokens} reached` };
  }
  return { allowed: true, reason: null };
}

export function record(ledger: LedgerState, entry: LedgerEntry): LedgerState {
  return {
    entries: [...ledger.entries, entry],
    byKind: { ...ledger.byKind, [entry.kind]: (ledger.byKind[entry.kind] ?? 0) + 1 },
    providerTokens:
      ledger.providerTokens + (entry.inputTokens ?? 0) + (entry.outputTokens ?? 0),
  };
}

// ---------------------------------------------------------------------------
// The planned matrix
// ---------------------------------------------------------------------------

export const MATRIX = Object.freeze({
  scenarios: 10,
  decisionTurns: 13,
  arms: 5,
  modelClasses: 2,
  repeats: 3,
});

export function plannedSubjectRequests(): number {
  return MATRIX.decisionTurns * MATRIX.arms * MATRIX.modelClasses * MATRIX.repeats;
}

/**
 * A frozen, balanced schedule.
 *
 * Arm order rotates and the A/A pair alternates, so provider-side drift over a
 * multi-hour run cannot land preferentially on one arm. Frozen before the run,
 * because choosing an order after seeing partial results is a way to pick a
 * winner without admitting to it.
 */
export function schedule(): Array<{ repeat: number; modelId: string; armOrder: string[] }> {
  const base = ["W0", "W1", "W1A", "W2", "W3"];
  const out: Array<{ repeat: number; modelId: string; armOrder: string[] }> = [];
  for (let repeat = 1; repeat <= MATRIX.repeats; repeat += 1) {
    for (const profile of MODEL_PROFILES) {
      const rotated = [...base.slice(repeat - 1), ...base.slice(0, repeat - 1)];
      const armOrder = repeat % 2 === 0 ? swapAaPair(rotated) : rotated;
      out.push({ repeat, modelId: profile.modelId, armOrder });
    }
  }
  return out;
}

function swapAaPair(order: readonly string[]): string[] {
  const out = [...order];
  const a = out.indexOf("W1");
  const b = out.indexOf("W1A");
  if (a !== -1 && b !== -1) {
    out[a] = "W1A";
    out[b] = "W1";
  }
  return out;
}
