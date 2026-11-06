// Development only. Keeps one backend process running and replaces it when backend source changes. A replacement
// is a clean restart, never an in-process hot swap: the old process is asked to stop, and only once it has exited
// (releasing database ownership) does the next one start, loading the files as they are then, so changes
// arriving meanwhile need no further restart. A backend that exits on its own is retried with backoff a few times, then left stopped until the next
// change, so an invalid configuration cannot spin. Shutting the supervisor down stops the backend and never
// restarts it.

export interface BackendProcess {
  readonly pid: number;
  /** Resolves once the process has exited, with its exit code (null when ended by a signal). */
  readonly exited: Promise<number | null>;
  kill(signal: NodeJS.Signals): void;
}

export interface SupervisorDeps {
  spawn(): BackendProcess;
  /** Signals the backend's whole process group (its MCP servers included); a group already gone is ignored. */
  signalGroup(pid: number, signal: NodeJS.Signals): void;
  log(line: string): void;
  /** Schedules `fn` after `ms`; returns a cancel function. */
  schedule(fn: () => void, ms: number): () => void;
  now(): number;
}

export interface SupervisorOptions {
  /** Quiet period that coalesces an editor's burst of writes into one restart. */
  debounceMs?: number;
  /** How long a stopping backend may take before it is killed. */
  graceMs?: number;
  /** Retry delays after a backend exits on its own; after the last, wait for a change. */
  retryDelaysMs?: readonly number[];
  /** A backend that ran at least this long has its retry budget restored. */
  stableMs?: number;
}

export const DEFAULTS = {
  debounceMs: 150,
  graceMs: 15_000,
  retryDelaysMs: [1_000, 2_000, 4_000, 8_000, 16_000],
  stableMs: 30_000,
} as const;

interface Child {
  readonly process: BackendProcess;
  readonly startedAt: number;
  stopping: boolean;
}

export class BackendSupervisor {
  readonly #deps: SupervisorDeps;
  readonly #debounceMs: number;
  readonly #graceMs: number;
  readonly #retryDelays: readonly number[];
  readonly #stableMs: number;

  #child: Child | undefined;
  #restarting: Promise<void> | undefined;
  #cancelDebounce: (() => void) | undefined;
  #cancelRetry: (() => void) | undefined;
  #retries = 0;
  #shuttingDown: Promise<void> | undefined;
  #pendingReason: string | undefined;

  constructor(deps: SupervisorDeps, options: SupervisorOptions = {}) {
    this.#deps = deps;
    this.#debounceMs = options.debounceMs ?? DEFAULTS.debounceMs;
    this.#graceMs = options.graceMs ?? DEFAULTS.graceMs;
    this.#retryDelays = options.retryDelaysMs ?? DEFAULTS.retryDelaysMs;
    this.#stableMs = options.stableMs ?? DEFAULTS.stableMs;
  }

  /** The running backend's process ID, if any. */
  get pid(): number | undefined {
    return this.#child?.process.pid;
  }

  start(): void {
    if (this.#shuttingDown !== undefined || this.#child !== undefined) return;
    this.#launch();
  }

  /** A relevant source file changed: restart once the burst settles. */
  changed(path: string): void {
    if (this.#shuttingDown !== undefined) return;
    this.#pendingReason ??= path;
    this.#cancelDebounce?.();
    this.#cancelDebounce = this.#deps.schedule(() => {
      this.#cancelDebounce = undefined;
      const reason = this.#pendingReason ?? 'a change';
      this.#pendingReason = undefined;
      this.#retries = 0;
      void this.restart(reason);
    }, this.#debounceMs);
  }

  /** Stops the backend (awaiting its exit) and starts a fresh one; concurrent requests coalesce. */
  restart(reason: string): Promise<void> {
    if (this.#shuttingDown !== undefined) return this.#shuttingDown;
    if (this.#restarting !== undefined) return this.#restarting;
    this.#cancelRetry?.();
    this.#cancelRetry = undefined;
    this.#restarting = (async () => {
      try {
        this.#deps.log(`dev: restarting the backend (${reason})`);
        await this.#stopChild();
        if (this.#shuttingDown !== undefined) return;
        // The new backend loads the files as they are now, so requests made while stopping are served by it.
        this.#launch();
      } finally {
        // Cleared in the same turn as the launch, so a later change always starts a restart of its own.
        this.#restarting = undefined;
      }
    })();
    return this.#restarting;
  }

  /** Stops watching for restarts and stops the backend; resolves once it has exited. */
  shutdown(): Promise<void> {
    this.#shuttingDown ??= (async () => {
      this.#cancelDebounce?.();
      this.#cancelRetry?.();
      await this.#restarting?.catch(() => {});
      await this.#stopChild();
    })();
    return this.#shuttingDown;
  }

  #launch(): void {
    const backend = this.#deps.spawn();
    const child: Child = { process: backend, startedAt: this.#deps.now(), stopping: false };
    this.#child = child;
    this.#deps.log(`dev: backend started (pid ${backend.pid})`);
    void backend.exited.then((code) => this.#exited(child, code));
  }

  #exited(child: Child, code: number | null): void {
    // Whatever the backend left in its group (an MCP server it had not yet reaped) goes with it.
    this.#deps.signalGroup(child.process.pid, 'SIGKILL');
    if (this.#child === child) this.#child = undefined;
    if (child.stopping || this.#shuttingDown !== undefined) return;
    if (this.#deps.now() - child.startedAt >= this.#stableMs) this.#retries = 0;
    const delay = this.#retryDelays[this.#retries];
    if (delay === undefined) {
      this.#deps.log(`dev: backend exited (code ${code ?? 'signal'}); waiting for a source change to start it again`);
      return;
    }
    this.#retries += 1;
    this.#deps.log(`dev: backend exited (code ${code ?? 'signal'}); starting it again in ${delay} ms`);
    this.#cancelRetry = this.#deps.schedule(() => {
      this.#cancelRetry = undefined;
      if (this.#shuttingDown !== undefined || this.#child !== undefined || this.#restarting !== undefined) return;
      this.#launch();
    }, delay);
  }

  async #stopChild(): Promise<void> {
    const child = this.#child;
    if (child === undefined) return;
    child.stopping = true;
    child.process.kill('SIGTERM');
    let timedOut = false;
    let cancel: (() => void) | undefined;
    const grace = new Promise<void>((resolve) => {
      cancel = this.#deps.schedule(() => {
        timedOut = true;
        resolve();
      }, this.#graceMs);
    });
    await Promise.race([child.process.exited, grace]);
    cancel?.();
    if (timedOut) {
      this.#deps.log(`dev: backend did not stop within ${this.#graceMs} ms; killing it (an unclean stop)`);
      this.#deps.signalGroup(child.process.pid, 'SIGKILL');
      child.process.kill('SIGKILL');
    }
    // A replacement never starts while its predecessor is still running.
    await child.process.exited;
    if (this.#child === child) this.#child = undefined;
  }
}
