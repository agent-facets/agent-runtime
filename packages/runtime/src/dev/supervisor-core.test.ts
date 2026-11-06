import { describe, expect, test } from 'bun:test';
import { type BackendProcess, BackendSupervisor, type SupervisorDeps } from './supervisor-core.ts';

/** A backend double that exits only when told to, or when signalled if it honours signals. */
class FakeBackend implements BackendProcess {
  readonly signals: NodeJS.Signals[] = [];
  readonly exited: Promise<number | null>;
  #exit: (code: number | null) => void = () => {};
  alive = true;
  constructor(
    readonly pid: number,
    readonly honoursTerm = true,
  ) {
    this.exited = new Promise((resolve) => {
      this.#exit = resolve;
    });
  }
  kill(signal: NodeJS.Signals) {
    this.signals.push(signal);
    if (signal === 'SIGKILL' || (signal === 'SIGTERM' && this.honoursTerm)) this.exit(signal === 'SIGKILL' ? null : 0);
  }
  exit(code: number | null) {
    if (!this.alive) return;
    this.alive = false;
    this.#exit(code);
  }
}

function harness(options: { honoursTerm?: boolean } = {}) {
  let now = 0;
  let pid = 100;
  const timers = new Map<number, { at: number; fn: () => void }>();
  let nextTimer = 0;
  const backends: FakeBackend[] = [];
  const groupSignals: [number, NodeJS.Signals][] = [];
  const log: string[] = [];
  const deps: SupervisorDeps = {
    spawn: () => {
      // No two backends may ever be alive at once.
      expect(backends.filter((backend) => backend.alive)).toHaveLength(0);
      const backend = new FakeBackend(++pid, options.honoursTerm ?? true);
      backends.push(backend);
      return backend;
    },
    signalGroup: (target, signal) => groupSignals.push([target, signal]),
    log: (line) => log.push(line),
    schedule: (fn, ms) => {
      const id = ++nextTimer;
      timers.set(id, { at: now + ms, fn });
      return () => timers.delete(id);
    },
    now: () => now,
  };
  /** Advances the clock, running due timers in order, and lets promise callbacks settle. */
  const advance = async (ms: number) => {
    const until = now + ms;
    for (;;) {
      await settle();
      const due = [...timers.entries()].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (due === undefined) break;
      timers.delete(due[0]);
      now = due[1].at;
      due[1].fn();
    }
    now = until;
    await settle();
  };
  return { deps, backends, groupSignals, log, advance, pendingTimers: () => timers.size };
}

const settle = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

const options = { debounceMs: 100, graceMs: 1_000, retryDelaysMs: [500, 1_000], stableMs: 10_000 };

describe('backend supervisor', () => {
  test('a burst of changes becomes one restart, and the old backend exits before the next starts', async () => {
    const h = harness();
    const supervisor = new BackendSupervisor(h.deps, options);
    supervisor.start();
    expect(h.backends).toHaveLength(1);
    for (const file of ['a.ts', 'b.ts', 'c.ts']) {
      supervisor.changed(file);
      await h.advance(50);
    }
    expect(h.backends).toHaveLength(1);
    await h.advance(100);
    expect(h.backends).toHaveLength(2);
    expect(h.backends[0]?.signals).toEqual(['SIGTERM']);
    expect(h.backends[1]?.alive).toBe(true);
    expect(supervisor.pid).toBe(h.backends[1]?.pid as number);
    expect(h.log).toContain('dev: restarting the backend (a.ts)');
    // The exited backend's group is cleared of anything it left behind.
    expect(h.groupSignals).toEqual([[h.backends[0]?.pid as number, 'SIGKILL']]);
  });

  test('changes while the backend is stopping are served by the one replacement', async () => {
    const h = harness({ honoursTerm: false });
    const supervisor = new BackendSupervisor(h.deps, options);
    supervisor.start();
    const restarting = supervisor.restart('first');
    await settle();
    expect(supervisor.restart('second')).toBe(restarting);
    supervisor.changed('third.ts');
    h.backends[0]?.exit(0);
    await restarting;
    expect(h.backends).toHaveLength(2);
    // A change debounced past the launch is a restart of its own.
    await h.advance(100);
    expect(h.backends[1]?.signals).toEqual(['SIGTERM']);
    h.backends[1]?.exit(0);
    await h.advance(0);
    expect(h.backends).toHaveLength(3);
    expect(h.backends[2]?.alive).toBe(true);
  });

  test('a restart requested as soon as the previous one launched is not lost', async () => {
    const h = harness();
    const supervisor = new BackendSupervisor(h.deps, options);
    supervisor.start();
    const first = supervisor.restart('first');
    await first;
    const second = supervisor.restart('second');
    expect(second).not.toBe(first);
    await second;
    expect(h.backends).toHaveLength(3);
  });

  test('a backend that ignores the stop request is killed after the grace period, then replaced', async () => {
    const h = harness({ honoursTerm: false });
    const supervisor = new BackendSupervisor(h.deps, options);
    supervisor.start();
    const restarting = supervisor.restart('edit');
    await h.advance(999);
    expect(h.backends).toHaveLength(1);
    await h.advance(1);
    await restarting;
    expect(h.backends[0]?.signals).toEqual(['SIGTERM', 'SIGKILL']);
    expect(h.groupSignals[0]).toEqual([h.backends[0]?.pid as number, 'SIGKILL']);
    expect(h.log.some((line) => line.includes('unclean stop'))).toBe(true);
    expect(h.backends).toHaveLength(2);
  });

  test('a backend that exits on its own is retried with backoff, then left for the next change', async () => {
    const h = harness();
    const supervisor = new BackendSupervisor(h.deps, options);
    supervisor.start();
    h.backends[0]?.exit(1);
    await h.advance(499);
    expect(h.backends).toHaveLength(1);
    await h.advance(1);
    expect(h.backends).toHaveLength(2);
    h.backends[1]?.exit(1);
    await h.advance(1_000);
    expect(h.backends).toHaveLength(3);
    h.backends[2]?.exit(1);
    await h.advance(60_000);
    expect(h.backends).toHaveLength(3);
    expect(h.log.at(-1)).toContain('waiting for a source change');
    // A change starts it again, with the retry budget restored.
    supervisor.changed('fix.ts');
    await h.advance(100);
    expect(h.backends).toHaveLength(4);
    h.backends[3]?.exit(1);
    await h.advance(500);
    expect(h.backends).toHaveLength(5);
  });

  test('a backend that ran stably has its retry budget restored', async () => {
    const h = harness();
    const supervisor = new BackendSupervisor(h.deps, { ...options, retryDelaysMs: [500] });
    supervisor.start();
    h.backends[0]?.exit(1);
    await h.advance(500);
    await h.advance(10_000);
    h.backends[1]?.exit(1);
    await h.advance(500);
    expect(h.backends).toHaveLength(3);
  });

  test('shutdown stops the backend, cancels pending restarts and retries, and never starts another', async () => {
    const h = harness();
    const supervisor = new BackendSupervisor(h.deps, options);
    supervisor.start();
    supervisor.changed('pending.ts');
    await supervisor.shutdown();
    await h.advance(10_000);
    expect(h.backends).toHaveLength(1);
    expect(h.backends[0]?.alive).toBe(false);
    supervisor.changed('late.ts');
    await supervisor.restart('late');
    supervisor.start();
    await h.advance(10_000);
    expect(h.backends).toHaveLength(1);
    expect(h.pendingTimers()).toBe(0);
  });

  test('shutdown during a restart waits for it and leaves nothing running', async () => {
    const h = harness({ honoursTerm: false });
    const supervisor = new BackendSupervisor(h.deps, options);
    supervisor.start();
    void supervisor.restart('edit');
    await settle();
    const stopped = supervisor.shutdown();
    h.backends[0]?.exit(0);
    await settle();
    // The restart must not launch a replacement once shutdown has begun.
    expect(h.backends).toHaveLength(1);
    await stopped;
    expect(h.backends.every((backend) => !backend.alive)).toBe(true);
  });
});
