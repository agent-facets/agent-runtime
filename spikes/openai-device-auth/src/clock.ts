// Injectable clock.
//
// Every deterministic case runs on the virtual clock: `sleep` advances time and
// resolves immediately, so a 15-minute polling deadline costs nothing and the
// resulting poll count is an exact, reproducible number rather than a timing
// artefact. The real clock exists only for the live stage.

export type Clock = {
  now(): number;
  sleep(ms: number): Promise<void>;
};

export type VirtualClock = Clock & {
  sleeps: number[];
  elapsed(): number;
  advance(ms: number): void;
};

export function createVirtualClock(startEpochMs: number): VirtualClock {
  let current = startEpochMs;
  const start = startEpochMs;
  const sleeps: number[] = [];

  return {
    sleeps,
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
    elapsed: () => current - start,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      current += ms;
      // Yield so genuinely concurrent callers interleave, without wall time.
      await Promise.resolve();
    },
  };
}

export const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
};
